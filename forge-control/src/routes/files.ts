/**
 * VPS file explorer — browse/preview/attach files that already live on the
 * box (Obsidian vault, the shared coding-agent workspace) instead of only
 * ever uploading fresh copies through the browser. See docs/superpowers/
 * specs/2026-07-11-file-explorer-design.md.
 *
 * Every path is scoped to a named root (never an arbitrary filesystem path)
 * and resolved+contained the same way lib/vault.ts already does for the
 * vault-append API — reused here, not reinvented.
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { promises as fs, createReadStream, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { UploadedFile } from "./uploads.ts";

const r = new Hono();

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const CC_WORKSPACE = process.env.CC_WORKSPACE ?? "/opt/ai-os/workspace";

const ROOTS: Record<string, { dir: string; label: string }> = {
  vault: { dir: VAULT_DIR, label: "Obsidian Vault" },
  workspace: { dir: CC_WORKSPACE, label: "Agent Workspace" },
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeFor(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

class PathError extends Error {}

/** Resolve a root-relative path, throwing PathError on traversal/dotfiles/
 *  symlink escape — same containment technique as lib/vault.ts's
 *  resolveInVault(), generalized to any of the named ROOTS. */
async function resolveInRoot(rootKey: string, rel: string): Promise<{ abs: string; rootDir: string }> {
  const root = ROOTS[rootKey];
  if (!root) throw new PathError(`unknown root: ${rootKey}`);
  const cleaned = (rel || "").replace(/\\/g, "/");
  if (cleaned.split("/").some((seg) => seg.startsWith(".") && seg !== "")) {
    throw new PathError(`path may not contain dot segments: ${rel}`);
  }
  const rootDir = path.resolve(root.dir);
  const abs = path.resolve(rootDir, cleaned);
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    throw new PathError(`path escapes root ${rootKey}: ${rel}`);
  }
  // Guard against a symlink inside the root pointing outside it.
  const real = await fs.realpath(abs).catch(() => abs);
  const realRoot = await fs.realpath(rootDir).catch(() => rootDir);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new PathError(`symlink escapes root ${rootKey}: ${rel}`);
  }
  return { abs, rootDir };
}

r.get("/roots", (c) =>
  c.json({
    roots: Object.entries(ROOTS).map(([key, v]) => ({ key, label: v.label })),
  }),
);

r.get("/list", async (c) => {
  const rootKey = c.req.query("root") ?? "";
  const rel = c.req.query("path") ?? "";
  let abs: string;
  try {
    ({ abs } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) return c.json({ error: "not a directory" }, 404);
  const names = await fs.readdir(abs).catch(() => []);
  const entries = await Promise.all(
    names
      .filter((n) => !n.startsWith("."))
      .map(async (name) => {
        const entryStat = await fs.stat(path.join(abs, name)).catch(() => null);
        return entryStat
          ? {
              name,
              isDir: entryStat.isDirectory(),
              size: entryStat.size,
              mtime: entryStat.mtime.toISOString(),
            }
          : null;
      }),
  );
  const filtered = entries.filter((e): e is NonNullable<typeof e> => e !== null);
  filtered.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  return c.json({ root: rootKey, path: rel, entries: filtered });
});

/** Stream a file with HTTP Range support — same technique as routes/media.ts's
 *  serveFileWithRange, generalized to any resolved absolute path. */
function serveFileWithRange(c: Parameters<typeof stream>[0], file: string) {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  const contentType = mimeFor(file);
  const rangeHeader = c.req.header("range");
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "private, max-age=60");

  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!m) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= size) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    c.status(206);
    return stream(c, async (s) => {
      const node = createReadStream(file, { start, end });
      await s.pipe(Readable.toWeb(node) as ReadableStream<Uint8Array>);
    });
  }

  c.header("Content-Length", String(size));
  c.status(200);
  return stream(c, async (s) => {
    const node = createReadStream(file);
    await s.pipe(Readable.toWeb(node) as ReadableStream<Uint8Array>);
  });
}

r.get("/read", async (c) => {
  const rootKey = c.req.query("root") ?? "";
  const rel = c.req.query("path") ?? "";
  let abs: string;
  try {
    ({ abs } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  return serveFileWithRange(c, abs);
});

r.on("HEAD", "/read", async (c) => {
  const rootKey = c.req.query("root") ?? "";
  const rel = c.req.query("path") ?? "";
  let abs: string;
  try {
    ({ abs } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return c.json({ error: "not found" }, 404);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", mimeFor(abs));
  c.header("Content-Length", String(st.size));
  return c.body(null, 200);
});

/* Attach an existing VPS file to a chat without re-uploading it through the
 * browser — dropped from the file explorer onto the Chat composer. Returns
 * the same UploadedFile shape /api/uploads produces, so the composer's
 * existing attachment state/UI needs no special-casing. */
r.post("/attach", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { root?: string; path?: string };
  const rootKey = body.root ?? "";
  const rel = body.path ?? "";
  let abs: string;
  try {
    ({ abs } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return c.json({ error: "not found" }, 404);
  const name = path.basename(abs);
  const file: UploadedFile = {
    id: crypto.randomBytes(6).toString("hex"),
    name,
    path: abs,
    url: `/api/files/read?root=${encodeURIComponent(rootKey)}&path=${encodeURIComponent(rel)}`,
    mime: mimeFor(name),
    size: st.size,
  };
  return c.json({ file }, 200);
});

export default r;
