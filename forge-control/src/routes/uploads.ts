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
import {
  ID_RE,
  invalidateRunsCache,
  listAllRuns,
  listRunShots,
  resolveBrowserState,
} from "../lib/uploads-index.ts";
import {
  inspectTakeover,
  proxyTakeoverHttp,
  resolveProfileForRun,
  PROFILE_RE,
} from "../lib/browser-takeover.ts";

const r = new Hono();

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";
const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 30 * 1024 * 1024);
/* ID_RE is imported, not redeclared: the directory-name gate guarding path
 * joins here and the one the indexer filters with must be the same regex, or
 * a directory shape becomes servable-but-unlisted (or the reverse). It admits
 * a 12-hex run id and a full run UUID. */

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
  // Run artefacts the library now lists: served as text so the viewer shows
  // them instead of offering a download of an octet-stream.
  ".patch": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".webm": "video/webm",
  ".wav": "audio/wav",
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
  // New directories exist as of this instant; the index caches its readdir
  // sweep for 10s and would otherwise report the store as it was before this
  // upload — an attachment that "did not arrive" in the library.
  invalidateRunsCache();
  console.log(
    `[uploads] stored ${out.length} file(s): ${out.map((f) => f.name).join(", ")}`,
  );
  return c.json({ ok: true, files: out }, 201);
});

// Registered ABOVE `/:id/:name` — Hono matches routes in registration order,
// and a route registered after `/:id/:name` would have "index" and "shots"
// read as the `:id`/`:name` params instead of matching here.
r.get("/index", async (c) => {
  const runs = await listAllRuns();
  return c.json({ runs });
});

/**
 * GET /api/uploads/browser/:profile/state
 * Returns inspection of noVNC takeover stack and browser state for a profile.
 */
r.get("/browser/:profile/state", async (c) => {
  const profile = c.req.param("profile");
  if (!PROFILE_RE.test(profile)) {
    return c.json({ error: `bad profile: "${profile}"` }, 400);
  }
  try {
    const inspection = await inspectTakeover(profile);
    return c.json(inspection);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/**
 * ALL /api/uploads/browser/:profile/vnc
 * ALL /api/uploads/browser/:profile/vnc/*
 * Authenticated proxy to loopback websockify / noVNC instance on 127.0.0.1:novncPort
 */
r.all("/browser/:profile/vnc", async (c) => {
  const profile = c.req.param("profile");
  return proxyTakeoverHttp(c.req.raw, profile, "vnc.html");
});

r.all("/browser/:profile/vnc/*", async (c) => {
  const profile = c.req.param("profile");
  const url = new URL(c.req.url);
  const match = url.pathname.match(/\/browser\/[^/]+\/vnc\/?(.*)$/);
  const subpath = match ? match[1] : "";
  return proxyTakeoverHttp(c.req.raw, profile, subpath || "vnc.html");
});

/**
 * GET /api/uploads/:id/shots            images only (the camera strip)
 * GET /api/uploads/:id/shots?include=all  + run artefacts (the library)
 *
 * The default stays images-only on purpose: BrowserShots.tsx renders every
 * entry it receives inside an `<img>`.
 * Enriched with browser_state for live outline and red mode diagnostics.
 */
r.get("/:id/shots", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const includeParam = c.req.query("include") ?? "images";
  if (includeParam !== "images" && includeParam !== "all") {
    return c.json({ error: `include must be "images" or "all"` }, 400);
  }
  const dir = path.join(UPLOAD_DIR, id);
  const st = await fs.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return c.json({ error: "not found" }, 404);
  const [shots, browser_state] = await Promise.all([
    listRunShots(dir, { include: includeParam }),
    resolveBrowserState(id),
  ]);
  return c.json({
    id,
    include: includeParam,
    count: shots.length,
    image_count: shots.filter((s) => s.kind === "image").length,
    shots,
    browser_state,
  });
});

/**
 * GET /api/uploads/:id/browser-state
 * Fast signal probe for live streaming and red mode state.
 */
r.get("/:id/browser-state", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const browser_state = await resolveBrowserState(id);
  return c.json({ id, browser_state });
});

/**
 * ALL /api/uploads/:id/vnc
 * ALL /api/uploads/:id/vnc/*
 * Authenticated proxy for run's active browser takeover session.
 */
r.all("/:id/vnc", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const profile = await resolveProfileForRun(id);
  if (!profile) {
    return c.json({ error: `No browser profile found for run ${id}` }, 404);
  }
  return proxyTakeoverHttp(c.req.raw, profile, "vnc.html");
});

r.all("/:id/vnc/*", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  const profile = await resolveProfileForRun(id);
  if (!profile) {
    return c.json({ error: `No browser profile found for run ${id}` }, 404);
  }
  const url = new URL(c.req.url);
  const match = url.pathname.match(/\/[^/]+\/vnc\/?(.*)$/);
  const subpath = match ? match[1] : "";
  return proxyTakeoverHttp(c.req.raw, profile, subpath || "vnc.html");
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
