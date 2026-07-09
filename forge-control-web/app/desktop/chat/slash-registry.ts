/*
 * Slash command registry for the v1.6 phase 4 chat composer.
 *
 * Inspired by NousResearch/hermes-agent's slashExec.ts contract but
 * runs entirely client-side against the existing forge-control HTTP
 * routes (no remote slash.exec or command.dispatch endpoints). Each
 * command's handler receives a SlashContext with the API helpers it
 * needs.
 *
 * Add a new command by appending an entry to SLASH_COMMANDS. The
 * SlashPopover renders {name, help} and dispatches handler() on
 * Tab / Enter / click.
 */

import type {
  RunStatus,
  VaultSection,
  VaultWriteResult,
  Reminder,
  GuardrailRule,
} from "../../api";

export type SlashDirective =
  | { kind: "noop" }
  | { kind: "send-message"; message: string }
  | { kind: "navigate"; surface: SurfaceKey };

export type SurfaceKey =
  | "today"
  | "inbox"
  | "chat"
  | "live"
  | "control"
  | "pipeline"
  | "skills"
  | "memory"
  | "autonomy";

export interface SlashContext {
  runId: string | null;
  runStatus: RunStatus | null;
  /** Push a synthetic system bubble into the local rendered thread.
   *  Pure UI — doesn't write to the runs table. */
  sys(text: string): void;
  /** Change the active desktop surface. */
  nav(s: SurfaceKey): void;
  freezeFleet(): Promise<unknown>;
  resumeFleet(): Promise<unknown>;
  /** POST /api/chat/:id/resume. Only valid when runStatus === 'stuck'. */
  resumeRun(id: string): Promise<unknown>;
  /** POST /api/chat/:id/status with the new status. */
  setRunStatus(id: string, status: RunStatus): Promise<unknown>;
  /** v2.0 quick-capture actions — write into Obsidian / reminders. */
  vaultAppend(input: {
    section: VaultSection;
    text: string;
    prefix?: string;
  }): Promise<VaultWriteResult>;
  vaultCreateNote(input: {
    title: string;
    content?: string;
  }): Promise<VaultWriteResult>;
  createReminder(input: {
    when: string;
  }): Promise<{ ok: boolean; reminder: Reminder }>;
  /** POST /api/chat/:id/model — engine model for subsequent turns. */
  setModel(id: string, model: string): Promise<unknown>;
  /** GET /api/autonomy — guardrail rules (spend caps, kill switches). */
  fetchRules(): Promise<GuardrailRule[]>;
  /** POST /api/autonomy/rules/:id — merge-patch a rule's config. */
  updateRuleConfig(id: string, config: Record<string, unknown>): Promise<GuardrailRule>;
}

export interface SlashCommand {
  name: string;
  help: string;
  /** Returns a directive telling the composer what to do next. Most
   *  handlers return `{ kind: 'noop' }`; navigation returns `navigate`. */
  handler(
    ctx: SlashContext,
    args: string,
  ): Promise<SlashDirective> | SlashDirective;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    help: "list every slash command",
    handler: (ctx) => {
      const lines = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.help}`).join(
        "\n",
      );
      ctx.sys(`available slash commands:\n${lines}`);
      return { kind: "noop" };
    },
  },
  {
    name: "freeze",
    help: "freeze the fleet (FREEZE button equivalent)",
    handler: async (ctx) => {
      await ctx.freezeFleet();
      ctx.sys("fleet frozen — dispatcher + executor will hold work.");
      return { kind: "noop" };
    },
  },
  {
    name: "resume",
    help: "resume the fleet from freeze",
    handler: async (ctx) => {
      await ctx.resumeFleet();
      ctx.sys("fleet resumed.");
      return { kind: "noop" };
    },
  },
  {
    name: "skills",
    help: "open the Skills surface",
    handler: () => ({ kind: "navigate", surface: "skills" }),
  },
  {
    name: "memory",
    help: "open the Memory surface",
    handler: () => ({ kind: "navigate", surface: "memory" }),
  },
  {
    name: "pipeline",
    help: "open the Pipeline surface",
    handler: () => ({ kind: "navigate", surface: "pipeline" }),
  },
  {
    name: "live",
    help: "open the Live surface (fleet stats)",
    handler: () => ({ kind: "navigate", surface: "live" }),
  },
  {
    name: "control",
    help: "open the Control surface (loops + decision log)",
    handler: () => ({ kind: "navigate", surface: "control" }),
  },
  {
    name: "autonomy",
    help: "open the Autonomy surface (guardrail rules + trips)",
    handler: () => ({ kind: "navigate", surface: "autonomy" }),
  },
  {
    name: "inbox",
    help: "open the Inbox surface",
    handler: () => ({ kind: "navigate", surface: "inbox" }),
  },
  {
    name: "today",
    help: "open the Today dashboard",
    handler: () => ({ kind: "navigate", surface: "today" }),
  },
  {
    name: "resume-run",
    help: "resume the currently selected stuck run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      if (ctx.runStatus !== "stuck") {
        ctx.sys(
          `current run is '${ctx.runStatus}', not 'stuck' — resume only valid on stuck.`,
        );
        return { kind: "noop" };
      }
      await ctx.resumeRun(ctx.runId);
      ctx.sys("run re-queued. executor will reclaim with continue marker.");
      return { kind: "noop" };
    },
  },
  {
    name: "cancel",
    help: "cancel the currently selected run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      await ctx.setRunStatus(ctx.runId, "cancelled");
      ctx.sys("run cancelled.");
      return { kind: "noop" };
    },
  },
  {
    name: "pause",
    help: "pause the currently selected running run",
    handler: async (ctx) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      if (ctx.runStatus !== "running") {
        ctx.sys(
          `current run is '${ctx.runStatus}', not 'running' — nothing to pause.`,
        );
        return { kind: "noop" };
      }
      await ctx.setRunStatus(ctx.runId, "paused");
      ctx.sys("run paused.");
      return { kind: "noop" };
    },
  },
  {
    name: "clear",
    help: "clear the local UI bubbles (does NOT touch runs.thread)",
    handler: (ctx) => {
      ctx.sys("[local clear marker — refresh the page to see the real thread]");
      return { kind: "noop" };
    },
  },
  {
    name: "model",
    help: "engine model for this chat · /model opus · sonnet is standard",
    handler: async (ctx, args) => {
      if (!ctx.runId) {
        ctx.sys("no chat selected.");
        return { kind: "noop" };
      }
      const m = args.trim().toLowerCase();
      if (!m) {
        ctx.sys(
          "usage: /model <sonnet|opus|haiku|default> — sonnet (Sonnet 5) is the standard; opus for hard problems; haiku for quick lookups. Takes effect on the next turn.",
        );
        return { kind: "noop" };
      }
      if (!["sonnet", "opus", "haiku", "default"].includes(m)) {
        ctx.sys(`unknown model '${m}' — use sonnet, opus, haiku, or default.`);
        return { kind: "noop" };
      }
      await ctx.setModel(ctx.runId, m);
      ctx.sys(
        `model set to ${m === "default" ? "sonnet (standard)" : m} — applies from the next message.`,
      );
      return { kind: "noop" };
    },
  },
  {
    name: "rules",
    help: "list guardrails (spend caps, kill switches) and their current values",
    handler: async (ctx) => {
      const rules = await ctx.fetchRules();
      const lines = rules
        .map(
          (r) =>
            `${r.enabled ? "🟢" : "⚪"} ${r.id} — ${r.label}${
              Object.keys(r.config ?? {}).length ? ` (${JSON.stringify(r.config)})` : ""
            }`,
        )
        .join("\n");
      ctx.sys(`guardrails:\n${lines}`);
      return { kind: "noop" };
    },
  },
  {
    name: "cap",
    help: "change a spend-cap guardrail · /cap spend.per_run_cap 75",
    handler: async (ctx, args) => {
      const m = args.match(/^(\S+)\s+(\d+(?:\.\d+)?)$/);
      if (!m) {
        ctx.sys('usage: /cap <rule_id> <euros> — e.g. "/cap spend.per_run_cap 75". Run /rules to see rule ids.');
        return { kind: "noop" };
      }
      const [, ruleId, valueStr] = m;
      const rules = await ctx.fetchRules();
      const existing = rules.find((r) => r.id === ruleId);
      if (!existing) {
        ctx.sys(`no rule "${ruleId}" — run /rules to see valid ids.`);
        return { kind: "noop" };
      }
      if (!("cap_eur" in (existing.config ?? {}))) {
        ctx.sys(`"${ruleId}" has no cap_eur to set (config: ${JSON.stringify(existing.config)}).`);
        return { kind: "noop" };
      }
      const updated = await ctx.updateRuleConfig(ruleId, {
        ...existing.config,
        cap_eur: Number(valueStr),
      });
      ctx.sys(`✅ ${ruleId} → cap_eur ${updated.config.cap_eur}`);
      return { kind: "noop" };
    },
  },
  /* v2.0 — capture commands that WRITE (vault + reminders), no LLM run. */
  {
    name: "note",
    help: "append to today's daily note · /note buy new SSD",
    handler: async (ctx, args) => {
      if (!args) {
        ctx.sys("usage: /note <text> — lands under ## Notes in today's daily note");
        return { kind: "noop" };
      }
      const r = await ctx.vaultAppend({ section: "Notes", text: args });
      ctx.sys(`noted → ${r.path}`);
      return { kind: "noop" };
    },
  },
  {
    name: "todo",
    help: "add a task to today's daily note · /todo pay invoice",
    handler: async (ctx, args) => {
      if (!args) {
        ctx.sys("usage: /todo <text> — lands as - [ ] under ## Tasks");
        return { kind: "noop" };
      }
      const r = await ctx.vaultAppend({
        section: "Tasks",
        text: args,
        prefix: "- [ ] ",
      });
      ctx.sys(`todo added → ${r.path}`);
      return { kind: "noop" };
    },
  },
  {
    name: "journal",
    help: "append to today's journal · /journal shipped the CC engine",
    handler: async (ctx, args) => {
      if (!args) {
        ctx.sys("usage: /journal <text> — lands under ## Journal");
        return { kind: "noop" };
      }
      const r = await ctx.vaultAppend({ section: "Journal", text: args });
      ctx.sys(`journaled → ${r.path}`);
      return { kind: "noop" };
    },
  },
  {
    name: "capture",
    help: "new note in vault Inbox · /capture idea: reactor v2 hooks",
    handler: async (ctx, args) => {
      if (!args) {
        ctx.sys("usage: /capture <text> — creates a note in the vault Inbox folder");
        return { kind: "noop" };
      }
      const title = args.split(/\s+/).slice(0, 8).join(" ");
      const r = await ctx.vaultCreateNote({ title, content: args });
      ctx.sys(`captured → ${r.path}`);
      return { kind: "noop" };
    },
  },
  {
    name: "remind",
    help: "set a reminder · /remind in 2h call mom · /remind daily 08:30 review inbox",
    handler: async (ctx, args) => {
      if (!args) {
        ctx.sys(
          'usage: /remind <when> <text> — when: "in 2h", "tomorrow 9:00", "18:30", "daily 08:30", "2026-07-04 14:00"',
        );
        return { kind: "noop" };
      }
      try {
        const r = await ctx.createReminder({ when: args });
        const due = new Date(r.reminder.due_at).toLocaleString("de-DE", {
          dateStyle: "medium",
          timeStyle: "short",
        });
        ctx.sys(
          `reminder set: "${r.reminder.text}" · due ${due}${r.reminder.recur ? ` · repeats ${r.reminder.recur}` : ""}`,
        );
      } catch (e) {
        ctx.sys(
          `could not set reminder: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return { kind: "noop" };
    },
  },
];

export function parseSlash(input: string): { name: string; args: string } {
  const m = input.replace(/^\/+/, "").match(/^(\S+)\s*(.*)$/);
  return m ? { name: m[1], args: m[2].trim() } : { name: "", args: "" };
}

export function findSlash(name: string): SlashCommand | null {
  return SLASH_COMMANDS.find((c) => c.name === name) ?? null;
}
