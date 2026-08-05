/**
 * Chat attachments — v2.1 drag & drop support.
 *
 *   POST /api/uploads          multipart form (field "files", repeatable)
 *                              → [{ id, name, path, url, mime, size }]
 *   GET  /api/uploads/:id/:name  serve a stored file back (image previews)
 *
 * Files land in UPLOAD_DIR/<id>/<sanitized-name> where the CC executor can
 * Read them (images natively). The chat composer embeds the absolute paths
 * in an [attached-files] block inside the message.
 */

import { Hono } from "hono";
import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";

const r = new Hono();

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 30 * 1024 * 1024);
const ID_RE = /^[a-f0-9]{12}$/;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
};

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  return base || "file";
}

export interface UploadedFile {
  id: string;
  name: string;
  /** Absolute path on the VPS — what the CC engine Reads. */
  path: string;
  /** API path for the browser preview. */
  url: string;
  mime: string;
  size: number;
}

r.post("/", async (c) => {
  const body = await c.req.parseBody({ all: true }).catch(() => null);
  if (!body) return c.json({ error: "multipart form expected" }, 400);
  const raw = body["files"] ?? body["file"];
  const files = (Array.isArray(raw) ? raw : [raw]).filter(
    (f): f is File => f instanceof File,
  );
  if (files.length === 0) {
    return c.json({ error: "no files in form field 'files'" }, 400);
  }

  const out: UploadedFile[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return c.json(
        {
          error: `${f.name} is ${Math.round(f.size / 1024 / 1024)}MB — max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`,
        },
        413,
      );
    }
    const id = crypto.randomBytes(6).toString("hex");
    const name = safeName(f.name);
    const dir = path.join(UPLOAD_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    const abs = path.join(dir, name);
    await fs.writeFile(abs, Buffer.from(await f.arrayBuffer()));
    out.push({
      id,
      name,
      path: abs,
      url: `/api/uploads/${id}/${encodeURIComponent(name)}`,
      mime: f.type || MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream",
      size: f.size,
    });
  }
  console.log(
    `[uploads] stored ${out.length} file(s): ${out.map((f) => f.name).join(", ")}`,
  );
  return c.json({ ok: true, files: out }, 201);
});

r.get("/:id/:name", async (c) => {
  const id = c.req.param("id");
  const name = safeName(decodeURIComponent(c.req.param("name")));
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const abs = path.join(UPLOAD_DIR, id, name);
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return c.json({ error: "not found" }, 404);
  const mime =
    MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
  // R704: a Node Readable is NOT a web ReadableStream, and the `as unknown as`
  // cast that used to sit here killed the whole process. undici's Response body
  // machinery eventually calls close() on the stream controller; with a Node
  // stream underneath it finds an already-closed controller and throws
  // `ERR_INVALID_STATE: Invalid state: ReadableStream is already closed` from a
  // microtask — outside any request scope, so it is an UNCAUGHT exception and pm2
  // restarts forge-control. Reproduced on a throwaway port: the third GET of a
  // screenshot took the server down (docs/plan/evidence/p7-browser-lane.md §6).
  // Readable.toWeb() hands over a real web stream, so the bookkeeping is correct.
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": mime,
      "content-length": String(st.size),
      "cache-control": "private, max-age=86400",
    },
  });
});

export default r;
