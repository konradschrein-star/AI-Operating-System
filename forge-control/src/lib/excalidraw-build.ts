/**
 * Excalidraw scene builder — how the agent draws without writing coordinates.
 *
 * Pure functions, no I/O, so the interesting parts are unit-testable
 * (`src/lib/excalidraw-build.test.ts`). `routes/canvas.ts` owns the file
 * read-modify-write; this module owns what the elements look like.
 *
 * The contract with the agent is a small op list, not an element array. Shipping
 * `elements[]` through PUT /api/canvas/file costs ~27k tokens for one of
 * Konrad's maps; `{op:"addNode",label:"Fetch layer"}` costs about twenty.
 *
 * Four things break naive Excalidraw generation. All four are handled here:
 *
 *  1. Bound text is two-sided — the container needs
 *     `boundElements:[{id,type:"text"}]` AND the text needs `containerId`.
 *     Omit either and you get an empty box or a floating orphan label.
 *  2. Bound arrows are three-sided — `startBinding`/`endBinding` on the arrow
 *     AND an entry in each shape's `boundElements`. A one-sided binding looks
 *     right until the first drag, then silently detaches.
 *  3. Excalidraw does not recompute geometry on load. Bindings govern future
 *     drags; the initial `x/y/points` still have to be placed correctly, so
 *     arrows are clipped to the shapes' edges here rather than drawn centre to
 *     centre through the middle of both boxes.
 *  4. Every element needs the full scaffolding (`seed`, `version`,
 *     `versionNonce`, `groupIds`, `frameId`, …) or Excalidraw discards it.
 *
 * Visual constants and palette are lifted verbatim from
 * "AI OS/Planning System Design.md" §2, which took them from Konrad's own
 * Directory Engine map — so agent-drawn cards sit beside his without a seam.
 * That includes `roughness: 0`: his maps are clean-line, not sketchy.
 */

export type ExcalidrawElement = Record<string, unknown>;

/* --- visual constants (design doc §2.2) --------------------------------- */

export const CARD_W = 330;
export const CARD_H = 118;
export const CARD_GAP = 40;
/** Vertical pitch for addColumn — leaves room for a readable arrow + label. */
export const COLUMN_GAP = 78;
const FONT_SIZE = 16;
/** 3 = Cascadia in Excalidraw's font table. Konrad's maps use it throughout. */
const FONT_FAMILY = 3;
const LINE_HEIGHT = 1.25;
/** Arrow standoff from the shape edge. Matches the binding `gap`. */
const ARROW_GAP = 8;

/* --- status palette (design doc §2.4) ----------------------------------- */

interface Style {
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: "solid" | "dashed" | "dotted";
  strokeWidth: number;
}

const STATUS_STYLES: Record<string, Style> = {
  built: { strokeColor: "#1e1e1e", backgroundColor: "#ffffff", strokeStyle: "solid", strokeWidth: 1 },
  partial: { strokeColor: "#1971c2", backgroundColor: "#e7f5ff", strokeStyle: "solid", strokeWidth: 1 },
  planned: { strokeColor: "#6741d9", backgroundColor: "#f3f0ff", strokeStyle: "dashed", strokeWidth: 1 },
  gap: { strokeColor: "#e03131", backgroundColor: "#ffe3e3", strokeStyle: "solid", strokeWidth: 2 },
  blocked: { strokeColor: "#e03131", backgroundColor: "#ffe3e3", strokeStyle: "solid", strokeWidth: 2 },
  proposal: { strokeColor: "#f08c00", backgroundColor: "#fff9db", strokeStyle: "dotted", strokeWidth: 2 },
  // Plain colour names, for when the agent means "make it blue" and not a status.
  blue: { strokeColor: "#1971c2", backgroundColor: "#e7f5ff", strokeStyle: "solid", strokeWidth: 1 },
  violet: { strokeColor: "#6741d9", backgroundColor: "#f3f0ff", strokeStyle: "solid", strokeWidth: 1 },
  red: { strokeColor: "#e03131", backgroundColor: "#ffe3e3", strokeStyle: "solid", strokeWidth: 1 },
  green: { strokeColor: "#2f9e44", backgroundColor: "#ebfbee", strokeStyle: "solid", strokeWidth: 1 },
  yellow: { strokeColor: "#f08c00", backgroundColor: "#fff9db", strokeStyle: "solid", strokeWidth: 1 },
  grey: { strokeColor: "#868e96", backgroundColor: "#f8f9fa", strokeStyle: "solid", strokeWidth: 1 },
};

const DEFAULT_STATUS = "built";
const EDGE_STROKE = "#868e96";

/** Resolve `color` to a full style. Accepts a status key, a colour name, or a
 *  raw `#rrggbb` stroke (background stays transparent for raw hex — the caller
 *  asked for a stroke colour, not a theme). */
export function resolveStyle(color?: string): Style {
  if (!color) return STATUS_STYLES[DEFAULT_STATUS];
  const key = color.trim().toLowerCase();
  const hit = STATUS_STYLES[key];
  if (hit) return hit;
  if (/^#[0-9a-f]{3,8}$/i.test(key)) {
    return { strokeColor: key, backgroundColor: "transparent", strokeStyle: "solid", strokeWidth: 1 };
  }
  throw new Error(
    `unknown color "${color}" — use a status (${Object.keys(STATUS_STYLES).join(", ")}) or a #hex`,
  );
}

/* --- identity + scaffolding --------------------------------------------- */

/**
 * Per-element seed from a counter, not Math.random(). Excalidraw uses `seed` to
 * make its roughjs strokes reproducible; two elements sharing a seed render as
 * visual twins, and a fresh Math.random() per element occasionally collides.
 * An LCG stepped once per element cannot.
 */
let seedCounter = (Date.now() ^ (Math.random() * 0x7fffffff)) & 0x7fffffff;
export function nextSeed(): number {
  seedCounter = (Math.imul(seedCounter, 1103515245) + 12345) & 0x7fffffff;
  return seedCounter;
}

export function genId(): string {
  // Excalidraw ids are opaque — anything unique and URL-safe works. The app
  // never parses them.
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** The fields Excalidraw requires on every element. Anything missing here and
 *  the element is dropped on load, silently. */
export function scaffolding(): ExcalidrawElement {
  return {
    angle: 0,
    strokeColor: STATUS_STYLES[DEFAULT_STATUS].strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    // Konrad's maps are clean-line. Callers can override per element.
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

/** Normalise a caller-supplied element: fill in scaffolding, mint an id, and
 *  give bare rectangles the rounded corners the rest of the map uses. */
export function normaliseElement(raw: ExcalidrawElement): ExcalidrawElement {
  const merged: ExcalidrawElement = { ...scaffolding(), ...raw };
  if (typeof merged.id !== "string" || !merged.id) merged.id = genId();
  if (merged.type === "rectangle" && (merged.roundness === null || merged.roundness === undefined)) {
    merged.roundness = { type: 3 };
  }
  return merged;
}

/* --- text metrics -------------------------------------------------------- */

/** Excalidraw re-wraps bound text to the container on load, so this estimate
 *  only has to be close. Unbound text gets exactly what we compute. */
export function measureText(
  text: string,
  fontSize = FONT_SIZE,
  maxWidth?: number,
): { width: number; height: number; lines: string[] } {
  const charW = fontSize * 0.55;
  const maxChars = maxWidth ? Math.max(4, Math.floor(maxWidth / charW)) : Infinity;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= maxChars) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return {
    width: Math.ceil(widest * charW),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
    lines,
  };
}

/* --- nodes --------------------------------------------------------------- */

export interface NodeSpec {
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
  /** Free-form provenance kept in customData.aios — colour is a render, not a
   *  fact, so truth about who drew what lives here (design doc §2.4). */
  meta?: Record<string, unknown>;
}

/** A card: rounded rectangle + centred bound label. Returns [container, text];
 *  both must be pushed, in this order. */
export function buildNode(spec: NodeSpec): [ExcalidrawElement, ExcalidrawElement] {
  const style = resolveStyle(spec.color);
  const width = spec.width ?? CARD_W;
  const height = spec.height ?? CARD_H;
  const id = genId();
  const textId = genId();
  const metrics = measureText(spec.label, FONT_SIZE, width - 10);

  const container: ExcalidrawElement = {
    ...scaffolding(),
    ...style,
    id,
    type: "rectangle",
    x: spec.x,
    y: spec.y,
    width,
    height,
    roundness: { type: 3 },
    boundElements: [{ id: textId, type: "text" }],
    customData: {
      aios: { kind: "card", author: "agent", ...(spec.meta ?? {}) },
    },
  };

  const text: ExcalidrawElement = {
    ...scaffolding(),
    id: textId,
    type: "text",
    x: spec.x + 5,
    y: spec.y + Math.max(0, (height - metrics.height) / 2),
    width: width - 10,
    height: metrics.height,
    strokeColor: style.strokeColor,
    text: spec.label,
    originalText: spec.label,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: id,
    lineHeight: LINE_HEIGHT,
    autoResize: false,
    roundness: null,
  };

  return [container, text];
}

/* --- arrows -------------------------------------------------------------- */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(el: ExcalidrawElement): Box {
  return {
    x: typeof el.x === "number" ? el.x : 0,
    y: typeof el.y === "number" ? el.y : 0,
    width: typeof el.width === "number" ? el.width : 0,
    height: typeof el.height === "number" ? el.height : 0,
  };
}

/**
 * Where a centre-to-centre line leaves `box`, pushed out by `gap`. Excalidraw
 * will re-route on drag, but only if the initial geometry is sane — an arrow
 * drawn centre to centre renders as a line straight through both cards.
 */
function edgePoint(box: Box, towardX: number, towardY: number, gap: number): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = box.width / 2;
  const hh = box.height / 2;
  // Scale the direction vector until it hits the nearer of the two edge planes.
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  const len = Math.hypot(dx, dy);
  const push = len === 0 ? 0 : gap / len;
  return { x: cx + dx * (t + push), y: cy + dy * (t + push) };
}

export interface ArrowResult {
  arrow: ExcalidrawElement;
  label: ExcalidrawElement | null;
}

/** A bound arrow between two shapes, clipped to their edges. The caller must
 *  also push `{id, type:"arrow"}` into both shapes' boundElements — see
 *  `pushBoundElement`; a one-sided binding detaches on the first drag. */
export function buildArrow(
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  opts: { label?: string; style?: "solid" | "dashed"; color?: string } = {},
): ArrowResult {
  const a = boxOf(from);
  const b = boxOf(to);
  const aC = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bC = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const start = edgePoint(a, bC.x, bC.y, ARROW_GAP);
  const end = edgePoint(b, aC.x, aC.y, ARROW_GAP);
  const arrowId = genId();

  const arrow: ExcalidrawElement = {
    ...scaffolding(),
    id: arrowId,
    type: "arrow",
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    strokeColor: opts.color ?? EDGE_STROKE,
    strokeStyle: opts.style ?? "solid",
    strokeWidth: 1.5,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: String(from.id), focus: 0, gap: ARROW_GAP },
    endBinding: { elementId: String(to.id), focus: 0, gap: ARROW_GAP },
    startArrowhead: null,
    endArrowhead: "arrow",
    roundness: { type: 2 },
    elbowed: false,
    customData: { aios: { kind: "edge", author: "agent" } },
  };

  if (!opts.label) return { arrow, label: null };

  const metrics = measureText(opts.label, FONT_SIZE);
  const labelId = genId();
  const label: ExcalidrawElement = {
    ...scaffolding(),
    id: labelId,
    type: "text",
    x: (start.x + end.x) / 2 - metrics.width / 2,
    y: (start.y + end.y) / 2 - metrics.height / 2,
    width: metrics.width,
    height: metrics.height,
    strokeColor: opts.color ?? EDGE_STROKE,
    text: opts.label,
    originalText: opts.label,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: arrowId,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
    roundness: null,
  };
  arrow.boundElements = [{ id: labelId, type: "text" }];
  return { arrow, label };
}

/** Add `{id,type}` to an element's boundElements without duplicating. Immutable. */
export function pushBoundElement(
  el: ExcalidrawElement,
  ref: { id: string; type: string },
): ExcalidrawElement {
  const cur = Array.isArray(el.boundElements)
    ? (el.boundElements as Array<Record<string, unknown>>)
    : [];
  if (cur.some((b) => b?.id === ref.id && b?.type === ref.type)) return el;
  return { ...el, boundElements: [...cur, ref] };
}

/* --- placement ----------------------------------------------------------- */

/** Bounding box of everything currently on the canvas, ignoring deleted
 *  elements and anything without geometry. */
export function contentBounds(
  elements: ExcalidrawElement[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const el of elements) {
    if (el.isDeleted === true) continue;
    if (typeof el.x !== "number" || typeof el.y !== "number") continue;
    const w = typeof el.width === "number" ? el.width : 0;
    const h = typeof el.height === "number" ? el.height : 0;
    seen = true;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + w);
    maxY = Math.max(maxY, el.y + h);
  }
  return seen ? { minX, minY, maxX, maxY } : null;
}

/** Where a new card goes when the agent didn't say: below everything that
 *  exists, left-aligned with it. Predictable beats clever — a node that lands
 *  on top of Konrad's work is worse than one in a boring place. */
export function nextFreeSlot(elements: ExcalidrawElement[]): { x: number; y: number } {
  const b = contentBounds(elements);
  if (!b) return { x: 0, y: 0 };
  return { x: b.minX, y: b.maxY + CARD_GAP };
}

/* --- label resolution ---------------------------------------------------- */

/**
 * Find a shape by its visible label, so the agent can say "connect Fetch to
 * Parse" without carrying element ids around. Bound text resolves to its
 * container; a standalone text element resolves to itself. Exact
 * (case-insensitive) match wins; a unique substring match is accepted; an
 * ambiguous one throws rather than guessing.
 */
export function resolveLabel(elements: ExcalidrawElement[], label: string): string {
  const want = label.trim().toLowerCase();
  const exact: string[] = [];
  const partial: string[] = [];
  for (const el of elements) {
    if (el.isDeleted === true) continue;
    if (el.type !== "text" || typeof el.text !== "string") continue;
    const target =
      typeof el.containerId === "string" && el.containerId ? el.containerId : String(el.id ?? "");
    if (!target) continue;
    const text = el.text.trim().toLowerCase();
    if (text === want) exact.push(target);
    else if (text.includes(want)) partial.push(target);
  }
  const pool = exact.length ? exact : partial;
  const unique = [...new Set(pool)];
  if (unique.length === 0) throw new Error(`no element labelled "${label}"`);
  if (unique.length > 1) {
    throw new Error(
      `"${label}" matches ${unique.length} elements (${unique.join(", ")}) — use an id or a longer label`,
    );
  }
  return unique[0];
}

/* --- ops ----------------------------------------------------------------- */

export type PatchOp =
  /** Full Excalidraw shapes, scaffolded and id-minted for you. */
  | { op: "add" | "addElements"; elements: ExcalidrawElement[] }
  /** Partial update of one element by id. */
  | { op: "update"; id: string; patch: Record<string, unknown> }
  /** Partial update of many, each carrying its own id. */
  | { op: "updateElements"; elements: Array<Record<string, unknown>> }
  | { op: "remove" | "removeElements"; id?: string; ids?: string[] }
  /** High level: a labelled card. Coordinates optional. */
  | {
      op: "addNode";
      label: string;
      x?: number;
      y?: number;
      color?: string;
      width?: number;
      height?: number;
    }
  /** High level: a bound arrow between two shapes, by id or by label. */
  | {
      op: "connect";
      fromId?: string;
      toId?: string;
      fromLabel?: string;
      toLabel?: string;
      label?: string;
      style?: "solid" | "dashed";
    }
  /** High level: a vertical flow of connected cards. */
  | {
      op: "addColumn";
      labels: string[];
      x?: number;
      y?: number;
      color?: string;
      gap?: number;
      arrowLabels?: string[];
    };

export interface ApplyResult {
  next: ExcalidrawElement[];
  /** Ids of every element this patch created, in creation order. */
  added: string[];
  /** label → container id, for everything addNode/addColumn created. Lets a
   *  caller connect what it just drew without a second read. */
  nodes: Record<string, string>;
}

/**
 * Apply an op list to an element array. Pure: `elements` is never mutated.
 * Throws with a diagnostic on any op that cannot be satisfied — a patch that
 * half-applies is worse than one that fails loudly.
 */
export function applyOps(elements: ExcalidrawElement[], ops: PatchOp[]): ApplyResult {
  let next = elements.slice();
  const added: string[] = [];
  const nodes: Record<string, string> = {};

  const indexOf = (id: string): number => next.findIndex((e) => e.id === id);

  const requireIndex = (id: string, what: string): number => {
    const idx = indexOf(id);
    if (idx === -1) throw new Error(`${what}: no element with id ${id}`);
    return idx;
  };

  const pushNode = (spec: NodeSpec): string => {
    const [container, text] = buildNode(spec);
    next.push(container, text);
    added.push(String(container.id), String(text.id));
    nodes[spec.label] = String(container.id);
    return String(container.id);
  };

  const connect = (
    fromId: string,
    toId: string,
    opts: { label?: string; style?: "solid" | "dashed" },
  ): string => {
    const fromIdx = requireIndex(fromId, "connect");
    const toIdx = requireIndex(toId, "connect");
    const { arrow, label } = buildArrow(next[fromIdx], next[toIdx], opts);
    next.push(arrow);
    added.push(String(arrow.id));
    if (label) {
      next.push(label);
      added.push(String(label.id));
    }
    // Two-sided binding. Re-resolve indices: a self-connect makes from and to
    // the same element, and pushing has not moved anything but might later.
    const ref = { id: String(arrow.id), type: "arrow" };
    next[indexOf(fromId)] = pushBoundElement(next[indexOf(fromId)], ref);
    next[indexOf(toId)] = pushBoundElement(next[indexOf(toId)], ref);
    return String(arrow.id);
  };

  for (const op of ops) {
    switch (op.op) {
      case "add":
      case "addElements": {
        if (!Array.isArray(op.elements)) throw new Error(`${op.op} requires elements[]`);
        for (const raw of op.elements) {
          const el = normaliseElement(raw);
          next.push(el);
          added.push(String(el.id));
        }
        break;
      }

      case "update": {
        if (!op.id) throw new Error("update requires id");
        const idx = requireIndex(op.id, "update");
        const before = next[idx];
        next[idx] = {
          ...before,
          ...(op.patch ?? {}),
          version: (typeof before.version === "number" ? before.version : 1) + 1,
          versionNonce: nextSeed(),
          updated: Date.now(),
        };
        break;
      }

      case "updateElements": {
        if (!Array.isArray(op.elements)) throw new Error("updateElements requires elements[]");
        for (const patch of op.elements) {
          const id = typeof patch.id === "string" ? patch.id : "";
          if (!id) throw new Error("updateElements: every entry needs an id");
          const idx = requireIndex(id, "updateElements");
          const before = next[idx];
          const { id: _drop, ...fields } = patch;
          next[idx] = {
            ...before,
            ...fields,
            version: (typeof before.version === "number" ? before.version : 1) + 1,
            versionNonce: nextSeed(),
            updated: Date.now(),
          };
        }
        break;
      }

      case "remove":
      case "removeElements": {
        const ids = op.ids ?? (op.id ? [op.id] : []);
        if (!ids.length) throw new Error(`${op.op} requires id or ids[]`);
        const dead = new Set(ids);
        // Take bound children with the parent — an orphaned label floating
        // where a card used to be is its own kind of mess.
        for (const el of next) {
          if (typeof el.containerId === "string" && dead.has(el.containerId)) {
            dead.add(String(el.id));
          }
        }
        next = next.filter((e) => !dead.has(String(e.id ?? "")));
        break;
      }

      case "addNode": {
        if (!op.label || typeof op.label !== "string") throw new Error("addNode requires a label");
        const auto = op.x === undefined || op.y === undefined ? nextFreeSlot(next) : null;
        pushNode({
          label: op.label,
          x: op.x ?? auto!.x,
          y: op.y ?? auto!.y,
          width: op.width,
          height: op.height,
          color: op.color,
        });
        break;
      }

      case "connect": {
        const fromId = op.fromId ?? (op.fromLabel ? resolveLabel(next, op.fromLabel) : "");
        const toId = op.toId ?? (op.toLabel ? resolveLabel(next, op.toLabel) : "");
        if (!fromId || !toId) {
          throw new Error("connect requires fromId/toId or fromLabel/toLabel");
        }
        connect(fromId, toId, { label: op.label, style: op.style });
        break;
      }

      case "addColumn": {
        if (!Array.isArray(op.labels) || op.labels.length === 0) {
          throw new Error("addColumn requires labels[]");
        }
        const auto = op.x === undefined || op.y === undefined ? nextFreeSlot(next) : null;
        const x = op.x ?? auto!.x;
        let y = op.y ?? auto!.y;
        const gap = op.gap ?? COLUMN_GAP;
        let prev: string | null = null;
        op.labels.forEach((label, i) => {
          const id = pushNode({ label, x, y, color: op.color });
          if (prev) connect(prev, id, { label: op.arrowLabels?.[i - 1] });
          prev = id;
          y += CARD_H + gap;
        });
        break;
      }

      default: {
        throw new Error(`unknown op: ${(op as { op: string }).op}`);
      }
    }
  }

  return { next, added, nodes };
}

/* --- soft merge ---------------------------------------------------------- */

export interface MergeResult {
  merged: ExcalidrawElement[];
  /** Ids present in both versions with differing content — the overlap that
   *  makes a merge unsafe. Empty means the two edits were disjoint. */
  overlapping: string[];
  /** Ids taken from the on-disk version because the incoming save never saw them. */
  adopted: string[];
}

/**
 * Union two element arrays by id: `base` is what both writers started from,
 * `mine` is the save being attempted, `theirs` is what is on disk now.
 *
 * The only safe case is disjoint edits — the agent added three cards in a
 * corner while Konrad dragged a box on the other side of the canvas. Any id
 * that BOTH sides changed relative to `base` is reported as overlapping and the
 * caller must fall back to a 409; guessing a winner there is how a planning
 * canvas eats someone's thinking.
 */
export function softMerge(
  base: ExcalidrawElement[],
  mine: ExcalidrawElement[],
  theirs: ExcalidrawElement[],
): MergeResult {
  const key = (e: ExcalidrawElement): string => String(e.id ?? "");
  const byId = (arr: ExcalidrawElement[]): Map<string, ExcalidrawElement> =>
    new Map(arr.filter((e) => key(e)).map((e) => [key(e), e]));

  const baseM = byId(base);
  const mineM = byId(mine);
  const theirsM = byId(theirs);

  const changed = (
    a: Map<string, ExcalidrawElement>,
    id: string,
  ): boolean => {
    const before = baseM.get(id);
    const after = a.get(id);
    if (!before && !after) return false;
    if (!before || !after) return true; // added or deleted
    // `updated`/`versionNonce` churn on every touch, including no-op saves, so
    // compare the element without them.
    return stableJson(before) !== stableJson(after);
  };

  const overlapping: string[] = [];
  const adopted: string[] = [];
  const ids = new Set<string>([...baseM.keys(), ...mineM.keys(), ...theirsM.keys()]);
  for (const id of ids) {
    const inMine = changed(mineM, id);
    const inTheirs = changed(theirsM, id);
    if (inMine && inTheirs) overlapping.push(id);
  }

  // Start from the incoming save (it carries the user's live scene and its
  // ordering), then fold in every element the save never saw.
  const merged = mine.slice();
  const mineIds = new Set(mine.map(key));
  for (const el of theirs) {
    const id = key(el);
    if (!id || mineIds.has(id)) continue;
    if (baseM.has(id)) continue; // they deleted nothing; mine deleted it deliberately
    merged.push(el);
    adopted.push(id);
  }

  return { merged, overlapping, adopted };
}

/** JSON with keys sorted and per-write churn fields dropped, so "did this
 *  element actually change" is a string comparison. */
function stableJson(el: ExcalidrawElement): string {
  const skip = new Set(["updated", "versionNonce", "version"]);
  const keys = Object.keys(el).filter((k) => !skip.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, el[k]]));
}
