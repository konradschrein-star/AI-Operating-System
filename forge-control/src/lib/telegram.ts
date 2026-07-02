/**
 * Minimal Telegram Bot API client for the VPS Cat bridge.
 *
 * No SDK dependency — the bot API is four fetch calls. Token comes from
 * TELEGRAM_BOT_TOKEN (injected via pm2 host env, never committed). All
 * senders chunk at 4000 chars because Telegram hard-caps messages at 4096.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

export function telegramConfigured(): boolean {
  return TOKEN.length > 20;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; first_name?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration: number };
}

async function tgCall<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
  return j.result as T;
}

/** Long-poll for updates. timeoutSec is server-side; our fetch waits it out. */
export async function getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
  return tgCall<TgUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message"],
  });
}

const CHUNK = 4000;

/** Send plain text, chunked. Returns true if every chunk was accepted. */
export async function sendMessage(chatId: number, text: string): Promise<boolean> {
  const body = text.trim();
  if (!body) return true;
  const chunks: string[] = [];
  for (let i = 0; i < body.length && chunks.length < 8; i += CHUNK) {
    chunks.push(body.slice(i, i + CHUNK));
  }
  for (const chunk of chunks) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
  return true;
}

/** Show "typing…" in the chat while a run is being queued/executed. */
export async function sendTyping(chatId: number): Promise<void> {
  await tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
    () => {},
  );
}

/** Download a Telegram file into destDir. Returns the absolute local path. */
export async function downloadTgFile(
  fileId: string,
  destDir: string,
  suggestedName?: string,
): Promise<{ path: string; name: string; size: number }> {
  const info = await tgCall<{ file_path: string; file_size?: number }>(
    "getFile",
    { file_id: fileId },
  );
  const remoteName = path.basename(info.file_path);
  const name = (suggestedName ?? remoteName).replace(/[^\w.\-()\s]/g, "_");
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  const res = await fetch(`${FILE_API}/${info.file_path}`);
  if (!res.ok || !res.body) {
    throw new Error(`telegram file download failed: ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  return { path: dest, name, size: info.file_size ?? 0 };
}
