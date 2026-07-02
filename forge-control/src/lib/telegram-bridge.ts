/**
 * Telegram bridge — the AI OS's phone line (v2.2).
 *
 * Owns @vps_cat_bot via long polling (nothing else consumes it: Hermes'
 * container is down and forge-api uses a different bot). Two loops:
 *
 *   inbound:  getUpdates(25s long poll) → capture commands write straight
 *             into the vault/reminders; plain text becomes (or continues)
 *             a chat run the executor picks up. Cursor persisted in
 *             tg_state so restarts neither drop nor replay messages.
 *   outbound: drains the notifications table every 3s → sendMessage.
 *             Producers: executor (run completions, reminders), cron
 *             error paths, coach heartbeats.
 *
 * Only TELEGRAM_CHAT_ID (Konrad) is served. Other chats get one polite
 * refusal and are logged — this is a single-user OS, not a public bot.
 */

import path from "node:path";
import {
  telegramConfigured,
  getUpdates,
  sendMessage,
  sendTyping,
  downloadTgFile,
  type TgMessage,
} from "./telegram.ts";
import {
  claimPendingNotifications,
  markNotificationSent,
  getTgOffset,
  saveTgOffset,
} from "../db/notifications.ts";
import { appendToDailyNote, createNote, type DailySection } from "./vault.ts";
import { parseWhen } from "./when-parser.ts";
import { createReminder, listReminders } from "../db/reminders.ts";
import {
  createRun,
  appendMessage,
  findActiveRunBySource,
} from "../db/runs.ts";

const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID ?? "6267562276");
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";
/** A telegram chat run stays the active thread for this long. */
const THREAD_WINDOW_H = 12;

const HELP = `VPS Cat — your AI OS on Telegram.

Plain text → talk to the OS (Claude Code with skills, MCP, your vault).
Photos/files → attached to the conversation.

/todo <text> — task into today's daily note
/note <text> — note into today's daily note
/journal <text> — journal entry
/capture <text> — new note in vault Inbox
/remind <when> <text> — "in 2h call X", "daily 08:30 gym", "tomorrow 9:00"
/coach — on-demand coach check-in
/new [text] — start a fresh conversation thread
/status — what the OS is doing right now
/help — this`;

/* ---------------------------------------------------------------- inbound */

function isCommand(text: string): boolean {
  return text.startsWith("/");
}

async function handleCommand(text: string): Promise<string> {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return HELP;
  const cmd = m[1].toLowerCase();
  const args = m[2].trim();

  const daily = async (section: DailySection, prefix?: string) => {
    if (!args) return `usage: /${cmd} <text>`;
    const r = await appendToDailyNote({ section, text: args, prefix });
    return `✅ ${section.toLowerCase()} → ${r.path}`;
  };

  switch (cmd) {
    case "start":
    case "help":
      return HELP;
    case "todo":
      return daily("Tasks", "- [ ] ");
    case "note":
      return daily("Notes");
    case "journal":
      return daily("Journal");
    case "capture": {
      if (!args) return "usage: /capture <text>";
      const title = args.split(/\s+/).slice(0, 8).join(" ");
      const r = await createNote({ title, content: args });
      return `✅ captured → ${r.path}`;
    }
    case "remind": {
      if (!args) return 'usage: /remind <when> <text> — e.g. "in 2h call mom"';
      const parsed = parseWhen(args);
      if (!parsed || !parsed.rest) {
        return 'could not parse — try "/remind in 2h <text>", "/remind tomorrow 9:00 <text>", "/remind daily 08:30 <text>"';
      }
      const rem = await createReminder({
        text: parsed.rest,
        dueAt: parsed.dueAt,
        recur: parsed.recur,
        source: "telegram",
      });
      const due = new Date(rem.due_at).toLocaleString("de-DE", {
        timeZone: process.env.REMINDER_TZ ?? "Europe/Berlin",
        dateStyle: "medium",
        timeStyle: "short",
      });
      return `⏰ "${rem.text}" · ${due}${rem.recur ? ` · repeats ${rem.recur}` : ""}`;
    }
    case "status": {
      const active = await findActiveRunBySource("telegram", THREAD_WINDOW_H);
      const pending = (await listReminders(5)).filter(
        (r) => r.status === "pending",
      );
      const lines = [
        active
          ? `thread: "${active.title}" · ${active.status}`
          : "no active thread — next message starts one",
        pending.length
          ? `next reminders:\n${pending
              .map(
                (r) =>
                  `  · ${r.text} — ${new Date(r.due_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" })}`,
              )
              .join("\n")}`
          : "no pending reminders",
        "dashboard: https://os.schreinercontentsystems.com",
      ];
      return lines.join("\n");
    }
    case "coach": {
      const run = await createRun({
        title: "coach: on-demand check-in",
        prompt:
          "You are Konrad's coach. Read /opt/obsidian-vault/Coach/PERSONA.md and embody it fully. " +
          "Read today's daily note (/opt/obsidian-vault/Daily/) and Coach/log.md for context. " +
          "Give a short, hard-hitting check-in: where he stands today, what the next needle-mover is. " +
          "Under 150 words — this lands on his phone.",
        metadata: { source: "telegram", kind: "coach" },
      });
      return `🥊 coach incoming… (run ${run.id.slice(0, 8)})`;
    }
    case "new": {
      if (!args) return "fresh thread — send your message.";
      const run = await createRun({
        title: args.split("\n")[0].slice(0, 100),
        prompt: args,
        metadata: { source: "telegram", telegram_chat_id: CHAT_ID },
      });
      return `🧵 new thread "${run.title}" — working on it…`;
    }
    default:
      return `unknown command /${cmd}\n\n${HELP}`;
  }
}

/** Build the message text for a run turn, downloading any attachment. */
async function extractContent(msg: TgMessage): Promise<string> {
  const caption = msg.text ?? msg.caption ?? "";
  const files: Array<{ path: string; name: string; size: number }> = [];

  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const dir = path.join(UPLOAD_DIR, `tg-${msg.message_id}`);
    files.push(await downloadTgFile(largest.file_id, dir));
  }
  if (msg.document) {
    const dir = path.join(UPLOAD_DIR, `tg-${msg.message_id}`);
    files.push(
      await downloadTgFile(msg.document.file_id, dir, msg.document.file_name),
    );
  }

  if (files.length === 0) return caption;
  const block = [
    "[attached-files]",
    ...files.map(
      (f) => `- ${f.path} (${Math.max(1, Math.round(f.size / 1024))} KB)`,
    ),
    "[/attached-files]",
  ].join("\n");
  return caption ? `${caption}\n\n${block}` : block;
}

/** Plain text (or media) → continue the active telegram thread or start one. */
async function handleChatMessage(msg: TgMessage): Promise<string | null> {
  const content = await extractContent(msg);
  if (!content) return "send text, a photo, or a file.";
  if (msg.voice) {
    return "voice notes aren't wired up — use Whisper Flow and send text.";
  }

  await sendTyping(msg.chat.id);
  const active = await findActiveRunBySource("telegram", THREAD_WINDOW_H);
  if (active) {
    await appendMessage(
      active.id,
      { role: "user", content, ts: new Date().toISOString(), kind: "text" },
      { setStatus: "queued" },
    );
    return null; // reply comes via the notification queue when the run finishes
  }
  await createRun({
    title: content.split("\n")[0].slice(0, 100),
    prompt: content,
    metadata: { source: "telegram", telegram_chat_id: CHAT_ID },
  });
  return null;
}

async function handleUpdateMessage(msg: TgMessage): Promise<void> {
  if (msg.chat.id !== CHAT_ID) {
    console.warn(
      `[telegram] refused chat ${msg.chat.id} (${msg.chat.username ?? msg.chat.first_name ?? "?"})`,
    );
    await sendMessage(msg.chat.id, "private assistant — not for public use.").catch(
      () => {},
    );
    return;
  }
  try {
    const text = msg.text ?? "";
    const reply =
      text && isCommand(text)
        ? await handleCommand(text)
        : await handleChatMessage(msg);
    if (reply) await sendMessage(msg.chat.id, reply);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("[telegram] handle failed:", m);
    await sendMessage(msg.chat.id, `⚠️ ${m}`).catch(() => {});
  }
}

/* --------------------------------------------------------------- outbound */

async function drainOutbound(): Promise<void> {
  let batch;
  try {
    batch = await claimPendingNotifications(10);
  } catch (e) {
    console.error(
      "[telegram] claim failed:",
      e instanceof Error ? e.message : e,
    );
    return;
  }
  for (const n of batch) {
    try {
      await sendMessage(CHAT_ID, n.text);
      await markNotificationSent(n.id);
    } catch (e) {
      // attempts was already bumped by the claim; row retries or expires.
      console.error(
        `[telegram] send ${n.id} failed (attempt ${n.attempts}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/* ------------------------------------------------------------------ loops */

let running = false;

export function startTelegramBridge(): void {
  if (running) return;
  if (!telegramConfigured()) {
    console.warn(
      "[telegram] TELEGRAM_BOT_TOKEN not set — bridge disabled (pushes will queue in notifications table)",
    );
    return;
  }
  running = true;
  console.log(`[telegram] bridge starting · chat=${CHAT_ID}`);

  // Inbound long-poll loop.
  void (async () => {
    let offset = (await getTgOffset().catch(() => 0)) + 1;
    while (running) {
      try {
        const updates = await getUpdates(offset, 25);
        for (const u of updates) {
          if (u.message) await handleUpdateMessage(u.message);
          offset = u.update_id + 1;
          await saveTgOffset(u.update_id).catch(() => {});
        }
      } catch (e) {
        console.error(
          "[telegram] poll failed:",
          e instanceof Error ? e.message : e,
        );
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  })();

  // Outbound drain loop.
  setInterval(() => void drainOutbound(), 3_000);
}
