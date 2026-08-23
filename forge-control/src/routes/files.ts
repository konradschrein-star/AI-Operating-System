/**
 * VPS file explorer — browse/preview/attach/edit files that already live on
 * the box (Obsidian vault, the shared coding-agent workspace, the run-artefact
 * store, Content Forge's media output) instead of only ever uploading fresh
 * copies through the browser. See docs/superpowers/specs/
 * 2026-07-11-file-explorer-design.md.
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
import type { Dirent } from "node:fs";
import type { UploadedFile } from "./uploads.ts";

const r = new Hono();

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const CC_WORKSPACE = process.env.CC_WORKSPACE ?? "/opt/ai-os/workspace";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";
const MEDIA_DIR = process.env.FORGE_MEDIA_DIR ?? "/opt/content-forge/media";

/* The four trees the LIBRARY surface browses. `uploads` and `media` are the
 * artefact stores every run and every render already writes to — they were
 * reachable only through /api/uploads/:id/:name and /api/media before, i.e.
 * only if you already knew the id. */
const ROOTS: Record<string, { dir: string; label: string }> = {
  vault: { dir: VAULT_DIR, label: "Obsidian Vault" },
  workspace: { dir: CC_WORKSPACE, label: "Agent Workspace" },
  uploads: { dir: UPLOAD_DIR, label: "Run Artefacts & Uploads" },
  media: { dir: MEDIA_DIR, label: "Content Forge Media" },
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

const LIST_CAP = 1000;

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
  // Bubble readdir failures (EPERM, ENOENT-during-race, EIO) as a real
  // 500 instead of swallowing them into an empty entry list — a silent
  // empty result was indistinguishable from a genuinely empty
  // directory, made worse by the new `total` field which would also
  // report 0. See BASELINE-FINDINGS.md.
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "could not read directory";
    return c.json({ error: `could not read directory: ${msg}` }, 500);
  }
  // Filter dotfiles, then sort dirents deterministically (dirs first, then name)
  // BEFORE truncating. Sorting after slicing would leave the truncated set at
  // the mercy of the OS's readdir order — `zebra.md` might vanish while
  // `aardvark.md` in the discarded half stays visible. Symlinks are ordered
  // as non-dirs here for stability; we don't stat before the cap because the
  // whole point of capping first is to keep I/O at O(LIST_CAP), not O(total).
  const visible = dirents.filter((d) => !d.name.startsWith("."));
  visible.sort((a, b) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    return aDir === bDir ? a.name.localeCompare(b.name) : aDir ? -1 : 1;
  });
  const total = visible.length;
  const truncated = total > LIST_CAP;
  const capped = truncated ? visible.slice(0, LIST_CAP) : visible;
  const entries = await Promise.all(
    capped.map(async (dirent) => {
      const entryAbs = path.join(abs, dirent.name);

      if (dirent.isSymbolicLink()) {
        // stat (not lstat) follows the symlink so a symlinked directory
        // still reports isDir:true. Note: resolveInRoot's realpath check
        // guards the REQUESTED parent path only — individual children
        // are not re-checked here, so a symlink planted inside a root
        // and pointing outside it will still show its target's size and
        // mtime in this listing. Content access is safely blocked at
        // /read (which routes back through resolveInRoot), so this only
        // exposes stat metadata, not bytes.
        const st = await fs.stat(entryAbs).catch(() => null);
        if (!st) return null;
        return { name: dirent.name, isDir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() };
      }

      if (dirent.isDirectory()) {
        // Dirent confirms type — no stat needed for isDir.
        // mtime/size omitted for directories (not meaningful in the list UI).
        return { name: dirent.name, isDir: true as const, size: 0, mtime: "" };
      }

      if (dirent.isFile()) {
        const st = await fs.stat(entryAbs).catch(() => null);
        if (!st) return null;
        return { name: dirent.name, isDir: false as const, size: st.size, mtime: st.mtime.toISOString() };
      }

      // Skip sockets, block devices, etc.
      return null;
    }),
  );
  // Symlink resolution can flip isDir after the pre-sort — re-sort the final
  // slice so directories-first ordering holds even for symlinked dirs.
  const filtered = entries.filter((e): e is NonNullable<typeof e> => e !== null);
  filtered.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  c.header("Cache-Control", "private, max-age=10");
  return c.json({ root: rootKey, path: rel, entries: filtered, truncated, total });
});

const SEARCH_RESULT_CAP = 200;

/** Recursive filename search under root+path — the panel's old "filter"
 *  only matched direct children of whatever directory was already loaded,
 *  which isn't a real search across a 296-file vault. Capped and depth-
 *  first; stops walking as soon as the cap is hit.
 *
 *  Symlink containment: /list follows symlinks for size/mtime but leaves
 *  content access to /read (which re-runs resolveInRoot). Here, however,
 *  we recurse into directories — so a symlink pointing outside the root
 *  would leak filenames from /etc, etc. Every entry is realpath-checked
 *  against realRoot before its metadata is emitted or recursed into. */
async function searchDir(
  rootDir: string,
  realRoot: string,
  relDir: string,
  query: string,
  out: { name: string; path: string; isDir: boolean; size?: number; mtime: string }[],
): Promise<void> {
  if (out.length >= SEARCH_RESULT_CAP) return;
  const abs = path.join(rootDir, relDir);
  let names: string[];
  try {
    names = await fs.readdir(abs);
  } catch (err) {
    throw new Error(
      `could not read directory ${relDir || "(root)"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const name of names) {
    if (out.length >= SEARCH_RESULT_CAP) return;
    if (name.startsWith(".")) continue;
    const entryRel = relDir ? `${relDir}/${name}` : name;
    const entryAbs = path.join(rootDir, entryRel);
    const st = await fs.stat(entryAbs).catch(() => null);
    if (!st) continue;
    // Refuse to expose entries whose real path escapes the root. Blocks
    // a symlink planted inside the root from leaking filenames or stat
    // metadata for files outside it (e.g. a link to /etc).
    const entryReal = await fs.realpath(entryAbs).catch(() => entryAbs);
    if (entryReal !== realRoot && !entryReal.startsWith(realRoot + path.sep)) {
      continue;
    }
    if (name.toLowerCase().includes(query)) {
      out.push({
        name,
        path: entryRel,
        isDir: st.isDirectory(),
        size: st.isDirectory() ? undefined : st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    if (st.isDirectory()) await searchDir(rootDir, realRoot, entryRel, query, out);
  }
}

r.get("/search", async (c) => {
  const rootKey = c.req.query("root") ?? "";
  const rel = c.req.query("path") ?? "";
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (!q) return c.json({ entries: [], truncated: false });
  let abs: string;
  let rootDir: string;
  try {
    ({ abs, rootDir } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) return c.json({ error: "not a directory" }, 404);
  const realRoot = await fs.realpath(rootDir).catch(() => rootDir);
  const entries: { name: string; path: string; isDir: boolean; size?: number; mtime: string }[] = [];
  try {
    await searchDir(rootDir, realRoot, rel, q, entries);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "search failed" },
      500,
    );
  }
  return c.json({
    root: rootKey,
    path: rel,
    q,
    entries,
    truncated: entries.length >= SEARCH_RESULT_CAP,
  });
});

/** Stream a file with HTTP Range support — same technique as routes/media.ts's
 *  serveFileWithRange, generalized to any resolved absolute path. */
function serveFileWithRange(c: Parameters<typeof stream>[0], file: string) {
  let size: number;
  try {
    const st = statSync(file);
    // A directory used to reach createReadStream, which fails with EISDIR
    // *after* the 200 headers were sent — the client saw 200,
    // application/octet-stream, 0 bytes. Measured on the probe against
    // root=uploads (every entry there is a directory). The library's viewer
    // cannot tell that empty from a genuinely empty file, so it is a 400 now.
    if (!st.isFile()) {
      return c.json({ error: "not a file (directories are listed via /list)" }, 400);
    }
    size = st.size;
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

/** Largest body /write accepts. Markdown notes are kilobytes; this is a
 *  guard against a runaway client, not a real editing limit. */
const WRITE_MAX_BYTES = Number(process.env.FILES_WRITE_MAX_BYTES ?? 5 * 1024 * 1024);

/**
 * PUT /write { root, path, content, baseMtime? } — save an edited text file.
 *
 * The LIBRARY viewer edits markdown in place, and most of what it edits lives
 * in the Obsidian vault, which syncs over Syncthing: last-writer-wins, with
 * .sync-conflict-* copies and no merge. So this endpoint offers the same
 * optimistic-concurrency guard routes/canvas.ts uses — pass the `mtime` you
 * loaded and the write is refused with 409 if the file moved on.
 *
 * `baseMtime` is OPTIONAL and its absence is NOT an error: an editor that
 * created the file has no base mtime to send. Omitting it on an existing file
 * is a deliberate last-writer-wins overwrite, and callers editing vault notes
 * should always send it.
 *
 * The write is atomic (temp file in the same directory + rename), so a reader
 * — Obsidian, Syncthing, another agent — never observes a half-written note.
 */
r.put("/write", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    root?: string;
    path?: string;
    content?: string;
    baseMtime?: number;
  } | null;
  if (!body) return c.json({ error: "body must be JSON" }, 400);
  const rootKey = body.root ?? "";
  const rel = body.path ?? "";
  if (typeof body.content !== "string") {
    return c.json({ error: "content must be a string" }, 400);
  }
  const content = body.content;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WRITE_MAX_BYTES) {
    return c.json(
      { error: `content is ${bytes} bytes — max ${WRITE_MAX_BYTES}` },
      413,
    );
  }
  if (body.baseMtime !== undefined && typeof body.baseMtime !== "number") {
    return c.json({ error: "baseMtime must be a number (ms since epoch)" }, 400);
  }

  let abs: string;
  try {
    ({ abs } = await resolveInRoot(rootKey, rel));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "bad path" }, 400);
  }
  if (!rel.trim()) return c.json({ error: "path is required" }, 400);

  const existing = await fs.stat(abs).catch(() => null);
  if (existing?.isDirectory()) {
    return c.json({ error: `${rel} is a directory` }, 400);
  }
  if (existing && body.baseMtime !== undefined) {
    // Millisecond granularity, exactly as /api/canvas/file compares it.
    if (Math.floor(existing.mtimeMs) !== Math.floor(body.baseMtime)) {
      return c.json(
        {
          error: "file changed on disk since it was loaded",
          detail: `${rel} was modified at ${existing.mtime.toISOString()} — reload before saving, or the other writer's changes are lost`,
          mtime: existing.mtimeMs,
        },
        409,
      );
    }
  }

  const dir = path.dirname(abs);
  const dirStat = await fs.stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return c.json(
      { error: `parent directory does not exist: ${path.dirname(rel) || "."}` },
      404,
    );
  }

  // Same-directory temp + rename: rename(2) is atomic within a filesystem, so
  // no reader ever sees a truncated note. The temp name is dotted, which the
  // listing above already filters out if anything crashes between the two.
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `could not write ${rel}: ${msg}` }, 500);
  }

  const st = await fs.stat(abs);
  return c.json({
    ok: true,
    root: rootKey,
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    created: existing === null,
  });
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
