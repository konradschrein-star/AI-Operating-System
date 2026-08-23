/**
 * JOURNAL surface — paper-first capture.
 *
 *   GET    /api/journal/day?day=YYYY-MM-DD   → { day, count, entries }
 *                                               (day defaults to today, Europe/Berlin)
 *   POST   /api/journal/upload                multipart form:
 *                                               field "file" (or "files"), the photo
 *                                               field "day"     optional, YYYY-MM-DD, defaults to today
 *                                               field "caption" optional
 *                                             → { ok, entry, vault }
 *   DELETE /api/journal/entries/:id           → { ok, entry } | 404
 *
 * Storage is NOT reinvented here. A photo lands under the exact same
 * UPLOAD_DIR/<id>/<name> tree, with the same 12-hex id scheme, that
 * routes/uploads.ts already serves back through GET /api/uploads/:id/:name —
 * this route only indexes into that tree, dated, so the journal timeline can
 * list it. (routes/uploads.ts itself is untouched — it is not in this
 * project's write-set — so the storage helpers below intentionally mirror its
 * conventions rather than importing from it.)
 *
 * OCR: checked before writing this — no tesseract binary and no OCR library
 * in package.json on this box. Every entry is inserted with
 * ocr_status: 'unavailable' and ocr_text: null. Nothing here fakes a
 * transcript; a future pass (a vision model call) can fill both columns in
 * without a migration.
 */

import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { berlinDay } from "../lib/day-score.ts";
import { appendToDailyNote } from "../lib/vault.ts";
import {
  listJournalEntries,
  createJournalEntry,
  deleteJournalEntry,
} from "../db/journal.ts";

const r = new Hono();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors routes/uploads.ts exactly: same directory, same id shape, so a file
// stored here is indistinguishable from a chat attachment to the serving
// route. Kept as a local literal (not imported — uploads.ts is out of this
// project's write-set) rather than env-configured independently, so the two
// can never point at different trees.
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 30 * 1024 * 1024);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  return base || "file";
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET /day — the timeline for one calendar day. */
r.get("/day", async (c) => {
  const day = c.req.query("day") ?? berlinDay();
  if (!DAY_RE.test(day)) {
    return c.json({ error: `day must be YYYY-MM-DD, got: ${day}` }, 400);
  }
  try {
    const entries = await listJournalEntries(day);
    return c.json({ day, count: entries.length, entries });
  } catch (e) {
    const msg = describe(e);
    console.error("[journal/day]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** POST /upload — photograph a paper page, store it, date it, index it. */
r.post("/upload", async (c) => {
  const body = await c.req.parseBody({ all: true }).catch(() => null);
  if (!body) return c.json({ error: "multipart form expected" }, 400);

  const raw = body["file"] ?? body["files"];
  const file = Array.isArray(raw) ? raw[0] : raw;
  if (!(file instanceof File)) {
    return c.json({ error: "no file in form field 'file'" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      {
        error: `${file.name} is ${Math.round(file.size / 1024 / 1024)}MB — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`,
      },
      413,
    );
  }

  const dayField = body["day"];
  const day = typeof dayField === "string" && dayField.trim() ? dayField.trim() : berlinDay();
  if (!DAY_RE.test(day)) {
    return c.json({ error: `day must be YYYY-MM-DD, got: ${day}` }, 400);
  }

  const captionField = body["caption"];
  const caption = typeof captionField === "string" && captionField.trim() ? captionField.trim() : null;

  const id = crypto.randomBytes(6).toString("hex");
  const name = safeName(file.name);
  const dir = path.join(UPLOAD_DIR, id);

  try {
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, name);
    await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));

    const url = `/api/uploads/${id}/${encodeURIComponent(name)}`;
    const mime = file.type || MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";

    // appendToDailyNote() only ever writes TODAY's note (lib/vault.ts has no
    // day parameter — it resolves "now" itself). An entry dated to any other
    // day is stored and indexed, but honestly NOT woven into that day's
    // Daily/<day>.md — faking a write into a file this route did not touch
    // would be worse than skipping it.
    let vault: { appended: boolean; path?: string; reason?: string };
    if (day === berlinDay()) {
      try {
        const result = await appendToDailyNote({
          section: "Journal",
          text: caption ? `![${caption}](${url})` : `![journal photo](${url})`,
        });
        vault = { appended: true, path: result.path };
      } catch (e) {
        // The file and the DB row are already safe; a vault-note failure is
        // reported, not fatal to the upload.
        console.error("[journal/upload] vault append failed", describe(e));
        vault = { appended: false, reason: describe(e) };
      }
    } else {
      vault = {
        appended: false,
        reason: `entry dated ${day}, not today (${berlinDay()}) — appendToDailyNote only writes today's daily note`,
      };
    }

    const entry = await createJournalEntry({
      day,
      type: "paper_photo",
      upload_id: id,
      file_path: abs,
      file_url: url,
      file_name: name,
      mime_type: mime,
      size_bytes: file.size,
      ocr_text: null,
      ocr_status: "unavailable",
      caption,
    });

    console.log(`[journal/upload] stored ${name} (${id}) for ${day}`);
    return c.json({ ok: true, entry, vault }, 201);
  } catch (e) {
    const msg = describe(e);
    console.error("[journal/upload]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** DELETE /entries/:id — removes the index row. Does not touch the file on
 *  disk (see db/journal.ts's deleteJournalEntry doc comment). */
r.delete("/entries/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const deleted = await deleteJournalEntry(id);
    if (!deleted) {
      return c.json({ error: `no journal entry: ${id}` }, 404);
    }
    return c.json({ ok: true, entry: deleted });
  } catch (e) {
    const msg = describe(e);
    console.error("[journal/entries:delete]", msg);
    return c.json({ error: msg }, 500);
  }
});

export default r;
