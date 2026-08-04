/**
 * Canvas context — how the agent actually sees what Konrad is drawing.
 *
 * The problem this solves: the chat/canvas split view LOOKED like shared
 * attention but wasn't. The open drawing lived only in browser localStorage and
 * was never sent anywhere, so "look what I added" had no referent — the agent
 * didn't know a canvas was open, which of the ~10 drawings it was, or what had
 * changed on it.
 *
 * Why not just send the file: these canvases are meant to get enormous. The
 * planning canvas is already 18KB of JSON and it is nearly all geometry —
 * seeds, versionNonces, stroke widths, bounding boxes. Sending that every turn
 * would cost a fortune, drown the actual conversation, and still not say what
 * changed. Konrad's own framing is the right one: the whole canvas belongs in
 * context ONCE, and after that only the changes matter.
 *
 * So this module produces two things:
 *   1. a semantic rendering of the board — shapes with their labels, arrows as
 *      "A → B", frames as sections. Readable, and a fraction of the JSON.
 *   2. a delta against the last snapshot — added / removed / edited / moved.
 *
 * "Moved" is deliberately separated from "edited". Dragging a box two pixels is
 * not a thought; renaming it is. Collapsing both into "changed" would make
 * every idle nudge look like a decision.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import {
  parseExcalidrawMarkdown,
  type ExcalidrawDrawing,
} from "./excalidraw-md.ts";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const EXT = ".excalidraw.md";

/**
 * Load a drawing by vault-relative path.
 *
 * Same containment rules as the canvas route: traversal is rejected and only
 * .excalidraw.md files are readable, so a canvas_path coming from the browser
 * can never become a general "read any file in the vault" primitive.
 * Returns null rather than throwing — a missing or moved drawing should
 * degrade the conversation, not fail the user's message.
 */
export async function loadCanvas(
  relPath: string,
): Promise<ExcalidrawDrawing | null> {
  if (!relPath || !relPath.endsWith(EXT)) return null;
  const abs = resolve(VAULT_DIR, relPath);
  const within = relative(VAULT_DIR, abs);
  if (!within || within.startsWith("..") || isAbsolute(within)) return null;
  try {
    const raw = await readFile(abs, "utf8");
    return parseExcalidrawMarkdown(raw).drawing;
  } catch {
    return null;
  }
}

/** id → fingerprint. Stored in runs.metadata so the next turn can diff. */
export interface CanvasSnapshot {
  path: string;
  /** Fingerprint of each element's MEANING (label, links, kind). */
  sem: Record<string, string>;
  /** Fingerprint of each element's POSITION, tracked separately so a move
   *  never masquerades as an edit. */
  pos: Record<string, string>;
  takenAt: string;
}

interface SemElement {
  id: string;
  kind: string;
  label: string;
  /** For arrows: the labels of what they connect. */
  from?: string;
  to?: string;
  x: number;
  y: number;
}

const TEXT_KINDS = new Set(["text"]);
const ARROW_KINDS = new Set(["arrow", "line"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function short(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Reduce a raw Excalidraw element list to the parts a human would describe.
 *
 * Text bound to a container (containerId set) is that container's label, not a
 * separate object — otherwise every labelled box would show up twice, once as
 * a rectangle and once as floating text.
 */
export function semanticElements(drawing: ExcalidrawDrawing): SemElement[] {
  const raw = Array.isArray(drawing?.elements) ? drawing.elements : [];
  const live = raw.filter((e) => !e?.isDeleted);

  // Pass 1: container id → its bound label text.
  const boundLabel = new Map<string, string>();
  for (const e of live) {
    const cid = str(e.containerId);
    if (TEXT_KINDS.has(str(e.type)) && cid) {
      boundLabel.set(cid, str(e.text));
    }
  }

  // Pass 2: id → best label, for resolving arrow endpoints by name.
  const labelOf = new Map<string, string>();
  for (const e of live) {
    const id = str(e.id);
    if (!id) continue;
    const own = TEXT_KINDS.has(str(e.type)) ? str(e.text) : "";
    labelOf.set(id, short(boundLabel.get(id) ?? own, 40));
  }

  const out: SemElement[] = [];
  for (const e of live) {
    const id = str(e.id);
    const kind = str(e.type);
    if (!id || !kind) continue;

    // Skip text that is merely a container's label — already represented.
    if (TEXT_KINDS.has(kind) && str(e.containerId)) continue;

    const el: SemElement = {
      id,
      kind,
      label: short(boundLabel.get(id) ?? (TEXT_KINDS.has(kind) ? str(e.text) : "")),
      x: Math.round(num(e.x)),
      y: Math.round(num(e.y)),
    };

    if (ARROW_KINDS.has(kind)) {
      const sb = e.startBinding as { elementId?: string } | null;
      const eb = e.endBinding as { elementId?: string } | null;
      const fromId = str(sb?.elementId);
      const toId = str(eb?.elementId);
      if (fromId) el.from = labelOf.get(fromId) || fromId.slice(0, 6);
      if (toId) el.to = labelOf.get(toId) || toId.slice(0, 6);
    }

    out.push(el);
  }
  return out;
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** Meaning fingerprint: what the element IS and says, not where it sits. */
function semFingerprint(e: SemElement): string {
  return hash(`${e.kind}|${e.label}|${e.from ?? ""}|${e.to ?? ""}`);
}

/** Position fingerprint, rounded to 20px so a jitter isn't a "move". */
function posFingerprint(e: SemElement): string {
  return hash(`${Math.round(e.x / 20)}|${Math.round(e.y / 20)}`);
}

export function snapshot(path: string, drawing: ExcalidrawDrawing): CanvasSnapshot {
  const sem: Record<string, string> = {};
  const pos: Record<string, string> = {};
  for (const e of semanticElements(drawing)) {
    sem[e.id] = semFingerprint(e);
    pos[e.id] = posFingerprint(e);
  }
  return { path, sem, pos, takenAt: new Date().toISOString() };
}

function describe(e: SemElement): string {
  if (ARROW_KINDS.has(e.kind) && (e.from || e.to)) {
    return `${e.kind}: ${e.from ?? "?"} → ${e.to ?? "?"}`;
  }
  if (e.label) return `${e.kind}: "${e.label}"`;
  return `${e.kind} (unlabelled) at (${e.x}, ${e.y})`;
}

/** The whole board, once. Used the first time a canvas enters a conversation. */
export function renderFull(path: string, drawing: ExcalidrawDrawing): string {
  const els = semanticElements(drawing);
  if (!els.length) {
    return `[CANVAS: ${path}]\nThe canvas is currently empty.`;
  }
  const frames = els.filter((e) => e.kind === "frame");
  const arrows = els.filter((e) => ARROW_KINDS.has(e.kind));
  const shapes = els.filter(
    (e) => e.kind !== "frame" && !ARROW_KINDS.has(e.kind),
  );

  const lines: string[] = [
    `[CANVAS: ${path}]`,
    `${els.length} elements. Full contents below; subsequent turns will only carry changes.`,
    "",
  ];
  if (frames.length) {
    lines.push("Frames:");
    for (const f of frames) lines.push(`  - ${describe(f)}`);
    lines.push("");
  }
  lines.push("Elements:");
  for (const s of shapes) lines.push(`  - ${describe(s)}`);
  if (arrows.length) {
    lines.push("", "Connections:");
    for (const a of arrows) lines.push(`  - ${describe(a)}`);
  }
  return lines.join("\n");
}

export interface CanvasDelta {
  changed: boolean;
  text: string;
  snapshot: CanvasSnapshot;
}

/**
 * Diff the board against the last snapshot.
 *
 * Returns changed=false when nothing meaningful moved, so an unchanged canvas
 * costs zero tokens — Konrad's explicit requirement. A pure re-render of the
 * same board every turn is exactly the waste this whole module exists to avoid.
 */
export function renderDelta(
  path: string,
  drawing: ExcalidrawDrawing,
  prev: CanvasSnapshot | null,
): CanvasDelta {
  const next = snapshot(path, drawing);

  // No prior snapshot, or the user switched to a different drawing: the agent
  // has never seen this board, so send all of it.
  if (!prev || prev.path !== path) {
    return { changed: true, text: renderFull(path, drawing), snapshot: next };
  }

  const els = semanticElements(drawing);
  const byId = new Map(els.map((e) => [e.id, e]));

  const added: SemElement[] = [];
  const edited: SemElement[] = [];
  const moved: SemElement[] = [];
  for (const e of els) {
    const before = prev.sem[e.id];
    if (before === undefined) {
      added.push(e);
    } else if (before !== next.sem[e.id]) {
      edited.push(e);
    } else if (prev.pos[e.id] !== next.pos[e.id]) {
      moved.push(e);
    }
  }
  const removedIds = Object.keys(prev.sem).filter((id) => !byId.has(id));

  if (!added.length && !edited.length && !moved.length && !removedIds.length) {
    return { changed: false, text: "", snapshot: next };
  }

  const lines: string[] = [`[CANVAS CHANGED: ${path}]`];
  if (added.length) {
    lines.push(`Added (${added.length}):`);
    for (const e of added) lines.push(`  + ${describe(e)}`);
  }
  if (edited.length) {
    lines.push(`Edited (${edited.length}):`);
    for (const e of edited) lines.push(`  ~ ${describe(e)}`);
  }
  if (removedIds.length) {
    // Only ids survive for deletions — the element is gone from the file, so
    // there is no label left to print. Count is the honest thing to report.
    lines.push(`Removed: ${removedIds.length} element(s).`);
  }
  if (moved.length) {
    // Last, and terse: repositioning is rarely the point of the message.
    lines.push(
      `Moved (${moved.length}): ${moved
        .slice(0, 6)
        .map((e) => e.label || e.kind)
        .join(", ")}${moved.length > 6 ? ", …" : ""}`,
    );
  }
  return { changed: true, text: lines.join("\n"), snapshot: next };
}
