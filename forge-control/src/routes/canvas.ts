/**
 * Excalidraw canvas routes — a real drawing surface inside the AI OS, backed
 * by the same .excalidraw.md files Obsidian uses.
 *
 *   GET  /api/canvas/list                    → every drawing in the vault
 *   GET  /api/canvas/file?path=<rel>         → decoded elements + appState + files
 *   PUT  /api/canvas/file                    → save (optimistic-concurrency guarded)
 *   POST /api/canvas/new  { name, folder }   → create a blank drawing
 *   GET  /api/canvas/stat?path=<rel>         → O(1) mtime for the polling fallback
 *   GET  /api/canvas/events?path=<rel>       → SSE: `changed` (file mtime moved)
 *                                              + `intent` (agent asked to open X)
 *   POST /api/canvas/patch                   → element-level {add,update,remove,connect}
 *                                              with mtime-guarded read-modify-write
 *   POST /api/canvas/open  { path? | query? }→ park an "open this drawing" intent
 *
 * Why a conflict guard: the vault syncs to Konrad's devices over Syncthing,
 * which is last-writer-wins with .sync-conflict-* copies — it does not merge.
 * The same file can be edited in the browser, in the Obsidian app, and by the
 * agent. A blind write would silently eat someone's work, so saves carry the
 * mtime they were loaded from and are rejected (409) if the file moved on.
 *
 * Why SSE, not polling: the previous pane walked the WHOLE vault every 4s just
 * to read one file's mtime, and unconditionally polled `/intent` every 3s even
 * with no drawing open. Both are gone. `fs.watch` + a slow stat fallback +
 * server-push of intents is O(1) and effectively idle when nothing changes.
 */

import { Hono } from "hono";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  isAbsolute,
} from "node:path";
import { streamSSE } from "hono/streaming";
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
    const items = await Promise.all(
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
    return c.json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[canvas/list]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** One-file stat — the O(1) fallback the pane uses when SSE is down. */
r.get("/stat", async (c) => {
  const rel = c.req.query("path") ?? "";
  if (!rel) return c.json({ error: "path required" }, 400);
  try {
    const abs = safePath(rel);
    const s = await stat(abs);
    return c.json({ path: rel, mtime: s.mtimeMs, size: s.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg)
      ? 400
      : /ENOENT/.test(msg)
        ? 404
        : 500;
    if (code === 500) console.error("[canvas/stat]", msg);
    return c.json({ error: msg }, code);
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
    // Tell every subscriber the file moved — belt-and-braces: fs.watch will
    // fire too, but emitting here means the notify latency is bounded by the
    // subscriber's next event-loop tick rather than by the watch debounce.
    emitFileChange(rel, after.mtimeMs);
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
 * The agent has no socket to the browser, so it parks an intent here and any
 * live SSE subscriber gets it pushed. Deliberately a single slot, not a queue:
 * the only meaningful state is "the newest thing the agent wants shown".
 * Intents expire so a stale one can't hijack the pane days later.
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

/* ---------------------------------------------------------------------------
 * SSE event bus. Every open-pane subscribes; the intent slot and file writes
 * fan out through here so no client has to poll for either one.
 * ------------------------------------------------------------------------- */

type CanvasEvent =
  | { kind: "intent"; intent: CanvasIntent }
  | { kind: "changed"; path: string; mtime: number };

type Subscriber = (ev: CanvasEvent) => void;
const subscribers = new Set<Subscriber>();

function broadcastIntent(intent: CanvasIntent) {
  for (const fn of subscribers) {
    try {
      fn({ kind: "intent", intent });
    } catch {
      /* subscriber dropped — its own unsubscribe will clean up */
    }
  }
}

function emitFileChange(path: string, mtime: number) {
  for (const fn of subscribers) {
    try {
      fn({ kind: "changed", path, mtime });
    } catch {
      /* ignore */
    }
  }
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
    broadcastIntent(openIntent);
    return c.json({ ok: true, ...openIntent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg) ? 400 : 500;
    if (code === 500) console.error("[canvas/open]", msg);
    return c.json({ error: msg }, code);
  }
});

/** SSE: `hello` on connect (baseline mtime + current intent seq), `changed`
 *  when the watched file moves on disk, `intent` when the agent parks a new
 *  open request. The client keeps a slow stat-fallback timer for the case
 *  where fs.watch drops events (some filesystems, some containers). */
r.get("/events", (c) => {
  const rel = (c.req.query("path") ?? "").trim();

  // Only resolve a path if one was provided — a chat with no canvas open still
  // wants to hear about intents so the agent can pop a drawing without the
  // user having to click first.
  let abs: string | null = null;
  if (rel) {
    try {
      abs = safePath(rel);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  }

  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    const send = async (event: string, data: string): Promise<boolean> => {
      if (!alive) return false;
      try {
        await stream.writeSSE({ event, data });
        return true;
      } catch {
        alive = false;
        return false;
      }
    };

    // Initial baseline: current mtime for the watched file (if any) and the
    // current intent seq. The client uses hello.intentSeq to suppress the
    // still-live intent from before its connection.
    let baselineMtime = 0;
    if (abs) {
      const s = await stat(abs).catch(() => null);
      if (s) baselineMtime = s.mtimeMs;
    }
    if (
      !(await send(
        "hello",
        JSON.stringify({
          path: rel || null,
          mtime: baselineMtime,
          intentSeq: openIntent?.seq ?? 0,
        }),
      ))
    ) {
      return;
    }

    // Live fan-out: any change on our path, any intent, goes straight into the
    // stream. Deliberately not throttled — writes and intents are both very
    // low-frequency.
    const queue: CanvasEvent[] = [];
    let notify: (() => void) | null = null;
    const sub: Subscriber = (ev) => {
      // Path-filter file changes but keep every intent (the intent may be
      // asking us to switch to a different file).
      if (ev.kind === "changed" && ev.path !== rel) return;
      queue.push(ev);
      notify?.();
    };
    subscribers.add(sub);

    // fs.watch on the specific file, debounced. Some FSs coalesce, others fire
    // twice per write; 300ms is enough to smooth both.
    let watcher: FSWatcher | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedMtime = baselineMtime;
    const checkFileMtime = async () => {
      if (!abs || !alive) return;
      const s = await stat(abs).catch(() => null);
      if (!s) return;
      if (Math.abs(s.mtimeMs - lastEmittedMtime) > 1) {
        lastEmittedMtime = s.mtimeMs;
        emitFileChange(rel, s.mtimeMs);
      }
    };
    if (abs) {
      try {
        watcher = fsWatch(abs, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => void checkFileMtime(), 300);
        });
        watcher.on("error", () => {
          /* watcher is a hint — the stat-fallback loop is the safety net */
        });
      } catch {
        /* file may have been renamed between resolve and watch — fine, the
         * stat-fallback loop still catches it. */
      }
    }

    // Two loops: a drain of the fan-out queue (waits on `notify`), and a
    // periodic tick that (a) emits pings so proxies don't close the pipe and
    // (b) does a stat-fallback check every ~30s in case fs.watch missed one.
    const drain = async () => {
      while (alive) {
        while (queue.length && alive) {
          const ev = queue.shift()!;
          if (ev.kind === "intent") {
            if (!(await send("intent", JSON.stringify(ev.intent)))) return;
          } else {
            if (
              !(await send(
                "changed",
                JSON.stringify({ path: ev.path, mtime: ev.mtime }),
              ))
            )
              return;
          }
        }
        if (!alive) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    };

    const heartbeat = async () => {
      let ticks = 0;
      while (alive) {
        await stream.sleep(2_000);
        if (!alive) break;
        ticks++;
        // ~30s stat fallback
        if (ticks % 15 === 0) await checkFileMtime();
        // Ping every ~14s to keep the connection warm
        if (ticks % 7 === 0) {
          if (!(await send("ping", String(Date.now())))) break;
        }
        // Also drop a stale intent so a subscriber connected after a garbage-
        // collected intent doesn't see stale state on its next event.
        if (openIntent && Date.now() - openIntent.ts > INTENT_TTL_MS) {
          openIntent = null;
        }
      }
    };

    try {
      await Promise.race([drain(), heartbeat()]);
    } finally {
      alive = false;
      subscribers.delete(sub);
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher?.close();
    }
  });
});

/* ---------------------------------------------------------------------------
 * Element-level patch — the agent's real write path.
 *
 * The blunt `PUT /file` requires shipping the whole `elements[]` (27k tokens
 * for the Directory Engine map, per the design doc). This endpoint takes small
 * ops and does the read-modify-write inside the server, honoring the same
 * ±1ms mtime conflict rule as the full PUT.
 *
 *   POST /api/canvas/patch
 *   {
 *     path:      "Excalidraw/Foo.excalidraw.md",
 *     baseMtime: 1738670000000?,      // optional; omit to skip guard
 *     ops: [
 *       { op: "add",     elements: [...] },      // full Excalidraw shape objects
 *       { op: "update",  id: "abc", patch: {...} },
 *       { op: "remove",  id: "abc" | ids: [...] },
 *       { op: "connect", fromId: "a", toId: "b", label?: "flows" }
 *     ]
 *   }
 * ------------------------------------------------------------------------- */

type PatchOp =
  | { op: "add"; elements: Record<string, unknown>[] }
  | { op: "update"; id: string; patch: Record<string, unknown> }
  | { op: "remove"; id?: string; ids?: string[] }
  | { op: "connect"; fromId: string; toId: string; label?: string };

const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_ARROW_STROKE = "#868e96";

function genId(): string {
  // Excalidraw ids are opaque 20-ish char strings. Anything unique and URL-safe
  // is fine — the app never parses them. crypto.randomUUID trimmed to 22 chars.
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function nowScaffolding(): Record<string, unknown> {
  return {
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function normaliseAddedElement(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const base = nowScaffolding();
  const merged: Record<string, unknown> = { ...base, ...raw };
  if (!merged.id || typeof merged.id !== "string") merged.id = genId();
  // A rectangle with no explicit roundness should read as the friendly rounded
  // corners Konrad's existing map uses, not the sharp default. Only apply when
  // the caller didn't specify anything.
  if (
    merged.type === "rectangle" &&
    (merged.roundness === null || merged.roundness === undefined)
  ) {
    merged.roundness = { type: 3 };
  }
  return merged;
}

/** Push {id, type} into a container's boundElements, creating the array if
 *  needed. Immutable — returns a new object. */
function pushBoundElement(
  el: Record<string, unknown>,
  ref: { id: string; type: string },
): Record<string, unknown> {
  const cur = Array.isArray(el.boundElements)
    ? (el.boundElements as Array<Record<string, unknown>>)
    : [];
  // Don't duplicate an existing reference.
  if (cur.some((b) => b?.id === ref.id && b?.type === ref.type)) return el;
  return { ...el, boundElements: [...cur, ref] };
}

function applyOps(
  elements: Record<string, unknown>[],
  ops: PatchOp[],
): {
  next: Record<string, unknown>[];
  addedIds: string[];
} {
  let next = elements.slice();
  const addedIds: string[] = [];

  const indexOf = (id: string): number =>
    next.findIndex((e) => (e as { id?: string }).id === id);

  for (const op of ops) {
    if (op.op === "add") {
      if (!Array.isArray(op.elements)) {
        throw new Error("`add` requires elements[]");
      }
      for (const raw of op.elements) {
        const el = normaliseAddedElement(raw);
        next.push(el);
        addedIds.push(String(el.id));
      }
    } else if (op.op === "update") {
      if (!op.id) throw new Error("`update` requires id");
      const idx = indexOf(op.id);
      if (idx === -1) throw new Error(`update: no element with id ${op.id}`);
      const before = next[idx] as Record<string, unknown>;
      next[idx] = {
        ...before,
        ...(op.patch ?? {}),
        // Bump versionNonce so Excalidraw's own change detection notices.
        version: ((before.version as number) ?? 1) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      };
    } else if (op.op === "remove") {
      const ids = op.ids ?? (op.id ? [op.id] : []);
      if (!ids.length) throw new Error("`remove` requires id or ids[]");
      const dead = new Set(ids);
      next = next.filter((e) => !dead.has((e as { id?: string }).id ?? ""));
    } else if (op.op === "connect") {
      if (!op.fromId || !op.toId) {
        throw new Error("`connect` requires fromId and toId");
      }
      const fromIdx = indexOf(op.fromId);
      const toIdx = indexOf(op.toId);
      if (fromIdx === -1 || toIdx === -1) {
        throw new Error(
          `connect: element(s) not found (from=${op.fromId} to=${op.toId})`,
        );
      }
      const from = next[fromIdx] as Record<string, number>;
      const to = next[toIdx] as Record<string, number>;
      const fromCX = (from.x ?? 0) + (from.width ?? 0) / 2;
      const fromCY = (from.y ?? 0) + (from.height ?? 0) / 2;
      const toCX = (to.x ?? 0) + (to.width ?? 0) / 2;
      const toCY = (to.y ?? 0) + (to.height ?? 0) / 2;
      const arrowId = genId();
      const arrow: Record<string, unknown> = {
        ...nowScaffolding(),
        id: arrowId,
        type: "arrow",
        x: fromCX,
        y: fromCY,
        width: Math.abs(toCX - fromCX),
        height: Math.abs(toCY - fromCY),
        strokeColor: DEFAULT_ARROW_STROKE,
        points: [
          [0, 0],
          [toCX - fromCX, toCY - fromCY],
        ],
        lastCommittedPoint: null,
        startBinding: { elementId: op.fromId, focus: 0, gap: 8 },
        endBinding: { elementId: op.toId, focus: 0, gap: 8 },
        startArrowhead: null,
        endArrowhead: "arrow",
        roundness: { type: 2 },
      };
      next.push(arrow);
      addedIds.push(arrowId);
      // Two-sided binding — without updating both shapes' boundElements the
      // arrow silently detaches the first time either box is dragged.
      next[fromIdx] = pushBoundElement(next[fromIdx], {
        id: arrowId,
        type: "arrow",
      });
      // fromIdx might equal toIdx (self-loop); re-read fresh either way.
      const toIdxAfter = indexOf(op.toId);
      next[toIdxAfter] = pushBoundElement(next[toIdxAfter], {
        id: arrowId,
        type: "arrow",
      });

      if (op.label) {
        const midX = (fromCX + toCX) / 2;
        const midY = (fromCY + toCY) / 2;
        const labelId = genId();
        const label: Record<string, unknown> = {
          ...nowScaffolding(),
          id: labelId,
          type: "text",
          x: midX - 30,
          y: midY - 10,
          width: 60,
          height: 20,
          text: op.label,
          fontSize: 16,
          fontFamily: 3,
          textAlign: "center",
          verticalAlign: "middle",
          containerId: arrowId,
          originalText: op.label,
          lineHeight: 1.25,
          autoResize: true,
        };
        next.push(label);
        addedIds.push(labelId);
        // Attach the label to the arrow's boundElements too.
        const arrowIdx = indexOf(arrowId);
        if (arrowIdx !== -1) {
          next[arrowIdx] = pushBoundElement(next[arrowIdx], {
            id: labelId,
            type: "text",
          });
        }
      }
    } else {
      throw new Error(`unknown op: ${(op as { op: string }).op}`);
    }
  }
  return { next, addedIds };
}

r.post("/patch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    path?: string;
    baseMtime?: number;
    ops?: PatchOp[];
  };
  const rel = (body.path ?? "").trim();
  if (!rel) return c.json({ error: "path required" }, 400);
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return c.json({ error: "ops[] required" }, 400);
  }
  try {
    const abs = safePath(rel);
    const raw = await readFile(abs, "utf8").catch(() => null);
    if (raw === null) return c.json({ error: "no such drawing" }, 404);
    const s = await stat(abs);

    if (
      typeof body.baseMtime === "number" &&
      body.baseMtime > 0 &&
      Math.abs(s.mtimeMs - body.baseMtime) > 1
    ) {
      return c.json(
        {
          error: "conflict",
          detail:
            "This drawing changed on disk since you read it. Re-read and re-apply.",
          mtime: s.mtimeMs,
        },
        409,
      );
    }

    const doc = parseExcalidrawMarkdown(raw);
    const { next, addedIds } = applyOps(doc.drawing.elements, body.ops);
    const nextDoc = withDrawing(doc, { elements: next });
    await writeFile(abs, serializeExcalidrawMarkdown(nextDoc), "utf8");
    const after = await stat(abs);
    emitFileChange(rel, after.mtimeMs);
    return c.json({
      ok: true,
      path: rel,
      mtime: after.mtimeMs,
      added: addedIds,
      elementCount: next.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /escapes|not a drawing/.test(msg)
      ? 400
      : /^(update:|`|unknown op|connect:)/.test(msg)
        ? 400
        : 500;
    if (code === 500) console.error("[canvas/patch]", msg);
    return c.json({ error: msg }, code);
  }
});

export default r;
