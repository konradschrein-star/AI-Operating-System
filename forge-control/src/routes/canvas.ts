/**
 * Excalidraw canvas routes — a real drawing surface inside the AI OS, backed
 * by the same .excalidraw.md files Obsidian uses.
 *
 *   GET  /api/canvas/list                  → every drawing in the vault
 *   GET  /api/canvas/file?path=<rel>       → decoded elements + appState + files
 *   PUT  /api/canvas/file                  → save (optimistic-concurrency guarded)
 *   POST /api/canvas/new  { name, folder } → create a blank drawing
 *
 * Why a conflict guard: the vault syncs to Konrad's devices over Syncthing,
 * which is last-writer-wins with .sync-conflict-* copies — it does not merge.
 * The same file can be edited in the browser, in the Obsidian app, and by the
 * agent. A blind write would silently eat someone's work, so saves carry the
 * mtime they were loaded from and are rejected (409) if the file moved on.
 */

import { Hono } from "hono";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  isAbsolute,
} from "node:path";
import {
  parseExcalidrawMarkdown,
  serializeExcalidrawMarkdown,
  withDrawing,
  EMPTY_DRAWING,
  type ExcalidrawDoc,
} from "../lib/excalidraw-md.ts";

const r = new Hono();

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const EXT = ".excalidraw.md";

/** Resolve a caller-supplied path INSIDE the vault. Rejects traversal and any
 *  file that isn't a drawing — this endpoint must never become a general
 *  read/write primitive over the whole vault. */
function safePath(rel: string): string {
  const abs = resolve(VAULT_DIR, rel);
  const within = relative(VAULT_DIR, abs);
  if (!within || within.startsWith("..") || isAbsolute(within)) {
    throw new Error("path escapes the vault");
  }
  if (!abs.endsWith(EXT)) throw new Error(`not a drawing (${EXT} required)`);
  return abs;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .obsidian, .trash, .git
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith(EXT)) out.push(p);
  }
  return out;
}

r.get("/list", async (c) => {
  try {
    const files = await walk(VAULT_DIR);
    let items = await Promise.all(
      files.map(async (abs) => {
        const s = await stat(abs).catch(() => null);
        return {
          path: relative(VAULT_DIR, abs),
          name: basename(abs, EXT),
          folder: relative(VAULT_DIR, dirname(abs)),
          mtime: s ? s.mtimeMs : 0,
          size: s ? s.size : 0,
        };
      }),
    );
    items.sort((a, b) => b.mtime - a.mtime);
    const q = c.req.query("q")?.toLowerCase().trim();
    if (q) {
      items = items.filter(
        (i) => i.name.toLowerCase().includes(q) || i.folder.toLowerCase().includes(q),
      );
    }
    return c.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[canvas/list]", msg);
    return c.json({ error: msg }, 500);
  }
});

r.get("/file", async (c) => {
  const rel = c.req.query("path") ?? "";
  if (!rel) return c.json({ error: "path required" }, 400);
  try {
    const abs = safePath(rel);
    const [raw, s] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
    const doc = parseExcalidrawMarkdown(raw);
    return c.json({
      path: rel,
      name: basename(abs, EXT),
      mtime: s.mtimeMs,
      format: doc.format,
      elements: doc.drawing.elements,
      appState: doc.drawing.appState ?? {},
      files: doc.drawing.files ?? {},
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg) ? 400 : /ENOENT/.test(msg) ? 404 : 500;
    if (code === 500) console.error("[canvas/file]", msg);
    return c.json({ error: msg }, code);
  }
});

r.put("/file", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: string;
    elements?: Record<string, unknown>[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
    baseMtime?: number;
  };
  const rel = (body.path ?? "").trim();
  if (!rel) return c.json({ error: "path required" }, 400);
  if (!Array.isArray(body.elements)) {
    return c.json({ error: "elements[] required" }, 400);
  }
  try {
    const abs = safePath(rel);
    const raw = await readFile(abs, "utf8").catch(() => null);
    if (raw === null) return c.json({ error: "no such drawing" }, 404);
    const s = await stat(abs);

    // Optimistic concurrency: someone (Obsidian, Syncthing, the agent) wrote
    // this file after the client loaded it. Refuse rather than clobber.
    if (
      typeof body.baseMtime === "number" &&
      body.baseMtime > 0 &&
      Math.abs(s.mtimeMs - body.baseMtime) > 1
    ) {
      return c.json(
        {
          error: "conflict",
          detail:
            "This drawing changed on disk since you opened it (Obsidian, another tab, or the agent). Reload to pick up their version before saving.",
          mtime: s.mtimeMs,
        },
        409,
      );
    }

    const doc: ExcalidrawDoc = parseExcalidrawMarkdown(raw);
    const next = withDrawing(doc, {
      elements: body.elements,
      appState: body.appState,
      files: body.files,
    });
    await writeFile(abs, serializeExcalidrawMarkdown(next), "utf8");
    const after = await stat(abs);
    return c.json({ ok: true, path: rel, mtime: after.mtimeMs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg) ? 400 : 500;
    if (code === 500) console.error("[canvas/file:put]", msg);
    return c.json({ error: msg }, code);
  }
});

r.post("/new", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    folder?: string;
  };
  // Strip path separators — a name is a name, not a route.
  const name = (body.name ?? "").trim().replace(/[/\\]/g, "-");
  if (!name) return c.json({ error: "name required" }, 400);
  const folder = (body.folder ?? "Excalidraw").replace(/^\/+|\/+$/g, "");
  const rel = `${folder}/${name}${EXT}`;
  try {
    const abs = safePath(rel);
    await mkdir(dirname(abs), { recursive: true });
    const exists = await stat(abs).catch(() => null);
    if (exists) return c.json({ error: "a drawing with that name exists", path: rel }, 409);
    const doc: ExcalidrawDoc = {
      frontmatter: "",
      preamble: "",
      otherSections: "",
      drawing: EMPTY_DRAWING(),
      format: "compressed",
    };
    await writeFile(abs, serializeExcalidrawMarkdown(doc), "utf8");
    const s = await stat(abs);
    return c.json({ ok: true, path: rel, name, mtime: s.mtimeMs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg) ? 400 : 500;
    if (code === 500) console.error("[canvas/new]", msg);
    return c.json({ error: msg }, code);
  }
});

/* ---------------------------------------------------------------------------
 * "Open this drawing" intents — the agent's hand on Konrad's screen.
 *
 * Konrad: "if I tell the agent to open up a drawing of whatever, it should
 * find it and actually open it in the web UI, like I open a drawing."
 *
 * The agent has no socket to the browser, so it parks an intent here and the
 * open canvas pane polls for it. Deliberately a single slot, not a queue: the
 * only meaningful state is "the newest thing the agent wants shown". Intents
 * expire so a stale one can't hijack the pane days later, and each carries a
 * monotonic id so the client can tell "new intent" from "same one again"
 * without yanking the view on every poll.
 * ------------------------------------------------------------------------- */

interface CanvasIntent {
  seq: number;
  path: string;
  reason: string | null;
  ts: number;
}
let intentSeq = 0;
let openIntent: CanvasIntent | null = null;
const INTENT_TTL_MS = 5 * 60_000;

/** Resolve a fuzzy name ("the scraper map") to a real drawing path. The agent
 *  shouldn't need the exact filename any more than Konrad does. */
async function findDrawing(query: string): Promise<string | null> {
  const files = await walk(VAULT_DIR);
  if (!files.length) return null;
  const q = query.toLowerCase().replace(/\.excalidraw\.md$/, "").trim();
  const scored = files
    .map((abs) => {
      const rel = relative(VAULT_DIR, abs);
      const name = basename(abs, EXT).toLowerCase();
      let score = 0;
      if (name === q) score = 1000;
      else if (name.includes(q)) score = 500 - (name.length - q.length);
      else if (rel.toLowerCase().includes(q)) score = 250;
      else {
        // Every word present, order-insensitive — "scraper map" finds
        // "Directory Engine - Scraper System Map".
        const words = q.split(/\s+/).filter(Boolean);
        if (words.length && words.every((w) => name.includes(w))) score = 200;
      }
      return { rel, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.rel ?? null;
}

/** POST /api/canvas/open { path? , query? , reason? } — agent-facing. */
r.post("/open", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: string;
    query?: string;
    reason?: string;
  };
  try {
    let rel = (body.path ?? "").trim();
    if (!rel && body.query) {
      const found = await findDrawing(body.query);
      if (!found) {
        return c.json({ error: `no drawing matches "${body.query}"` }, 404);
      }
      rel = found;
    }
    if (!rel) return c.json({ error: "path or query required" }, 400);
    const abs = safePath(rel);
    if (!(await stat(abs).catch(() => null))) {
      return c.json({ error: "no such drawing", path: rel }, 404);
    }
    openIntent = {
      seq: ++intentSeq,
      path: rel,
      reason: body.reason?.slice(0, 200) ?? null,
      ts: Date.now(),
    };
    return c.json({ ok: true, ...openIntent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg) ? 400 : 500;
    if (code === 500) console.error("[canvas/open]", msg);
    return c.json({ error: msg }, code);
  }
});

/** GET /api/canvas/intent — polled by the canvas pane. */
r.get("/intent", (c) => {
  if (openIntent && Date.now() - openIntent.ts > INTENT_TTL_MS) {
    openIntent = null;
  }
  return c.json({ intent: openIntent });
});

/** Search drawings by name — powers a real picker instead of a flat dropdown. */
r.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  try {
    const files = await walk(VAULT_DIR);
    const ql = q.toLowerCase();
    const items = await Promise.all(
      files.map(async (abs) => {
        const s = await stat(abs).catch(() => null);
        return {
          path: relative(VAULT_DIR, abs),
          name: basename(abs, EXT),
          folder: relative(VAULT_DIR, dirname(abs)),
          mtime: s ? s.mtimeMs : 0,
        };
      }),
    );
    const filtered = ql
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(ql) ||
            i.folder.toLowerCase().includes(ql),
        )
      : items;
    filtered.sort((a, b) => b.mtime - a.mtime);
    return c.json({ items: filtered.slice(0, 50) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[canvas/search]", msg);
    return c.json({ error: msg }, 500);
  }
});

export default r;
