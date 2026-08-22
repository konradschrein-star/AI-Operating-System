/**
 * Excalidraw → typed graph → high-signal semantic text.
 *
 * WHY THIS EXISTS. The vault holds 16 `.excalidraw.md` drawings, several of
 * them real system maps ("Stealth Uploader - System Map", "AI OS - Life &
 * Company OS - Planning Canvas"), and NONE of them is searchable:
 * km-indexer.js:29 lists `.excalidraw.md` in EXCLUDED_EXTENSIONS because the
 * file is a 480 KB LZString blob and embedding that blob is pure noise. The
 * exclusion was right about the blob and wrong about the drawing. A drawing
 * carries labels, containment and arrows — the highest-signal-per-byte content
 * in the whole vault, buried under geometry.
 *
 * So this module does the thing the exclusion made impossible: it reads the
 * MEANING out of the geometry and hands back (a) a typed graph and (b) a
 * compact text rendering of that graph, which is what actually gets embedded.
 * The 33 KB Stealth map renders to ~2.5 KB of text.
 *
 * WHAT IT REFUSES TO DO. It never invents a reading. Measured against Konrad's
 * real drawings, three things are genuinely ambiguous and each is REPORTED
 * rather than guessed:
 *
 *   - colour. His own legend says "green = solid path · orange = highest-risk",
 *     so colour carries meaning — but a DIFFERENT drawing's green means
 *     something else. We emit the colour NAME and the drawing's own legend
 *     line verbatim; we never translate green into "done".
 *   - unbound arrows. An arrow drawn near two boxes but bound to neither is not
 *     an edge, it is a question. `edges` carries it with `fromId: null` and
 *     `unresolvedEndpoints` counts it, so the plan step can ask.
 *   - containment. Excalidraw has no "is inside" relation; a box inside a box
 *     is a geometric fact. We compute it, and we say in the output that it was
 *     computed from geometry rather than declared.
 *
 * Everything here is PURE: no `fs`, no `pg`, no clock. It takes the bytes of a
 * `.excalidraw.md` file and returns values, so it can be exercised against the
 * real vault drawings and against fixtures with equal ease.
 */

import {
  parseExcalidrawMarkdown,
  type ExcalidrawDoc,
  type ExcalidrawDrawing,
} from "./excalidraw-md.ts";

/* ==========================================================================
 * Errors
 * ========================================================================== */

/** Thrown when the file is not a drawing we can read at all. Carries the path
 *  so a per-file catch in a vault walk can log something actionable. */
export class ExcalidrawExtractError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`excalidraw-extract: ${path}: ${message}`);
    this.name = "ExcalidrawExtractError";
    this.path = path;
  }
}

/* ==========================================================================
 * Safe readers over the untyped element bag
 *
 * Excalidraw elements are `Record<string, unknown>`. Every access goes through
 * one of these, so a hand-edited or future-version file yields a degraded
 * reading rather than a TypeError halfway through a vault sync.
 * ========================================================================== */

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Collapse whitespace and cap length, so one 4 KB sticky note cannot become
 *  the whole rendering. The cap is generous: labels ARE the payload. */
function tidy(s: string, max = 400): string {
  const t = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/* ==========================================================================
 * Colour naming
 *
 * Konrad colour-codes his maps and states the code in a legend on the canvas.
 * We resolve the hex to a HUMAN NAME and stop there — the meaning of that name
 * belongs to the drawing, not to this module.
 * ========================================================================== */

/** Excalidraw's default background + stroke palettes, exactly as the app emits
 *  them. Every hex here was observed in Konrad's vault or is a sibling shade in
 *  the same Open Color ramp. */
const PALETTE: ReadonlyArray<readonly [hex: string, name: string]> = [
  ["#1e1e1e", "black"],
  ["#ffffff", "white"],
  ["#e03131", "red"],
  ["#ffc9c9", "red"],
  ["#ffe3e3", "red"],
  ["#2f9e44", "green"],
  ["#b2f2bb", "green"],
  ["#d3f9d8", "green"],
  ["#1971c2", "blue"],
  ["#a5d8ff", "blue"],
  ["#e7f5ff", "blue"],
  ["#f08c00", "amber"],
  ["#ffec99", "yellow"],
  ["#fff3bf", "yellow"],
  ["#ffd8a8", "orange"],
  ["#6741d9", "violet"],
  ["#d0bfff", "violet"],
  ["#e5dbff", "violet"],
  ["#0c8599", "cyan"],
  ["#c5f6fa", "cyan"],
  ["#868e96", "grey"],
  ["#e9ecef", "grey"],
  ["#f1f3f5", "grey"],
];

const PALETTE_BY_HEX = new Map(PALETTE.map(([hex, name]) => [hex, name]));

/** Max squared RGB distance still called "the same colour". 60 per channel —
 *  wide enough to absorb a hand-picked shade, narrow enough that a colour from
 *  outside the ramp keeps its hex instead of being flattened into a name. */
const NEAREST_MAX_DISTANCE_SQ = 60 * 60 * 3;

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Hex → a name a human would use, or the hex itself when it is nowhere near
 * the palette.
 *
 * Returning the hex is deliberate and is NOT a silent fallback: an unnameable
 * colour reaches the reader as `#7b2d8e`, which is checkable against the file,
 * whereas calling it "violet" would be a claim we cannot support.
 */
export function colourName(hex: string): string | null {
  const raw = hex.trim().toLowerCase();
  if (!raw || raw === "transparent") return null;
  const exact = PALETTE_BY_HEX.get(raw);
  if (exact) return exact;

  const rgb = parseHex(raw);
  if (!rgb) return raw;

  let best: { name: string; d: number } | null = null;
  for (const [phex, name] of PALETTE) {
    const prgb = parseHex(phex);
    if (!prgb) continue;
    const d =
      (rgb[0] - prgb[0]) ** 2 + (rgb[1] - prgb[1]) ** 2 + (rgb[2] - prgb[2]) ** 2;
    if (!best || d < best.d) best = { name, d };
  }
  if (best && best.d <= NEAREST_MAX_DISTANCE_SQ) return best.name;
  return raw;
}

/* ==========================================================================
 * The typed graph
 * ========================================================================== */

/**
 * What the node is, structurally — NOT what Excalidraw called it.
 *
 * `container` is the load-bearing one: Konrad's maps have no frames at all
 * (measured: 0 frame elements across all 16 vault drawings). Sections are
 * plain dashed rectangles with other shapes drawn on top of them, so the
 * grouping he sees is geometric containment and nothing else.
 */
export type NodeRole = "frame" | "container" | "shape" | "text" | "media";

export interface DrawingNode {
  id: string;
  /** Raw Excalidraw type: rectangle, ellipse, diamond, text, image, frame… */
  kind: string;
  role: NodeRole;
  /** Bound label, own text, or "" for an unlabelled shape. */
  label: string;
  /** Background colour name (see `colourName`), or null when transparent. */
  fill: string | null;
  /** Stroke colour name, or null when it is the default near-black. */
  stroke: string | null;
  strokeStyle: string;
  /** `link` on the element — a [[wikilink]], obsidian:// or http URL. */
  link: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Frame or geometric container holding this node; null at the top level. */
  parentId: string | null;
  /** True when this node's text is the title of its parent container rather
   *  than an item inside it (see `SECTION_TITLE_BAND`). */
  isParentTitle: boolean;
  groupIds: string[];
}

export interface DrawingEdge {
  id: string;
  /** arrow | line */
  kind: string;
  /** Bound source, or null when the arrow was never attached to anything. */
  fromId: string | null;
  toId: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  /** Text bound to the arrow itself, e.g. "drives", "reads". */
  label: string;
  strokeStyle: string;
  stroke: string | null;
  /** An arrowhead at the far end — "A then B" rather than "A relates to B". */
  directed: boolean;
  /** Arrowheads at both ends. */
  bidirectional: boolean;
}

export interface DrawingGraph {
  /** Vault-relative path, as handed in. */
  path: string;
  /** Drawing name — the filename without `.excalidraw.md`. */
  title: string;
  /** Frontmatter tags, minus the plugin's own `excalidraw` marker. */
  tags: string[];
  /** The "back of the note" prose, banner stripped. Often empty. */
  prose: string;
  /** Free text that states what the drawing's own colours/strokes mean. */
  legend: string[];
  /** Every `[[target]]` found on element links or inside label text. */
  wikilinks: string[];
  nodes: DrawingNode[];
  edges: DrawingEdge[];
  stats: {
    liveElements: number;
    deletedElements: number;
    /** Arrows/lines with at least one endpoint bound to nothing. */
    unresolvedEndpoints: number;
  };
  /**
   * Non-null when the drawing payload could not be read and the rendering came
   * from the plugin's plain-text `## Text Elements` index instead. Carried into
   * the output text, never swallowed.
   */
  degraded: string | null;
}

/* ==========================================================================
 * Classification constants — each one is a decision, so each one is named
 * ========================================================================== */

/** Shapes that can hold other shapes. `line`/`arrow`/`freedraw` cannot: a
 *  bounding box around a squiggle contains nothing in any useful sense. */
const CONTAINER_KINDS = new Set(["rectangle", "ellipse", "diamond", "frame"]);
const EDGE_KINDS = new Set(["arrow", "line"]);
const MEDIA_KINDS = new Set(["image", "embeddable", "iframe"]);
/** Strokes at or near Excalidraw's default ink. Naming them "black" on every
 *  shape would add a word per line and no information. */
const DEFAULT_STROKES = new Set(["#1e1e1e", "#000000", "black"]);

/** Geometric containment tolerance, px. A shape drawn flush to a section's
 *  edge still belongs to it; Excalidraw snapping leaves sub-pixel overhangs. */
const CONTAINMENT_SLACK = 2;

/** A free text whose top sits within this many px of its container's top is
 *  read as the container's TITLE, not as an item inside it. Measured against
 *  "Stealth Uploader - System Map": section boxes start at y=100, their titles
 *  at y=112, their first real item at y=150. */
const SECTION_TITLE_BAND = 60;

/** Rows within this many px count as the same row for reading order, so a
 *  hand-drawn map reads left-to-right per band instead of zig-zagging. */
const ROW_BAND = 40;

/** A legend is a free text that both assigns a meaning (`x = y`) and names a
 *  visual channel. Anything looser matches ordinary prose on the canvas. */
const LEGEND_CHANNEL =
  /\b(green|red|orange|yellow|blue|violet|purple|cyan|grey|gray|amber|dashed|dotted|solid|arrow)\b/i;

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/* ==========================================================================
 * Graph construction
 * ========================================================================== */

interface RawElement {
  id: string;
  kind: string;
  text: string;
  containerId: string;
  frameId: string;
  link: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bg: string;
  stroke: string;
  strokeStyle: string;
  startId: string;
  endId: string;
  startArrowhead: unknown;
  endArrowhead: unknown;
  groupIds: string[];
}

function readElement(e: Record<string, unknown>): RawElement {
  const binding = (v: unknown): string => {
    if (!v || typeof v !== "object") return "";
    return str((v as Record<string, unknown>).elementId);
  };
  return {
    id: str(e.id),
    kind: str(e.type),
    // rawText holds the un-wrapped source — an Obsidian [[wikilink]] survives
    // there while `text` may already show only its alias.
    text: str(e.rawText) || str(e.originalText) || str(e.text),
    containerId: str(e.containerId),
    frameId: str(e.frameId),
    link: str(e.link),
    x: num(e.x),
    y: num(e.y),
    width: num(e.width),
    height: num(e.height),
    bg: str(e.backgroundColor),
    stroke: str(e.strokeColor),
    strokeStyle: str(e.strokeStyle) || "solid",
    startId: binding(e.startBinding),
    endId: binding(e.endBinding),
    startArrowhead: e.startArrowhead,
    endArrowhead: e.endArrowhead,
    groupIds: strArray(e.groupIds),
  };
}

function area(e: { width: number; height: number }): number {
  return Math.abs(e.width) * Math.abs(e.height);
}

function contains(outer: RawElement, inner: RawElement): boolean {
  return (
    outer.x - CONTAINMENT_SLACK <= inner.x &&
    outer.y - CONTAINMENT_SLACK <= inner.y &&
    outer.x + outer.width + CONTAINMENT_SLACK >= inner.x + inner.width &&
    outer.y + outer.height + CONTAINMENT_SLACK >= inner.y + inner.height
  );
}

function roleOf(kind: string, isContainerOfSomething: boolean): NodeRole {
  if (kind === "frame") return "frame";
  if (MEDIA_KINDS.has(kind)) return "media";
  if (kind === "text") return "text";
  if (CONTAINER_KINDS.has(kind) && isContainerOfSomething) return "container";
  return "shape";
}

function arrowheadPresent(v: unknown, kindIsArrow: boolean): boolean {
  // Excalidraw omits the key on older files, where an arrow's end arrowhead is
  // the default. `null` is an explicit "no head" and must not be read as one.
  if (v === undefined) return kindIsArrow;
  return v !== null && v !== "none";
}

function collectWikilinks(sources: string[]): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    for (const m of s.matchAll(WIKILINK_RE)) out.add(m[1].trim());
  }
  return [...out];
}

/**
 * Build the typed graph from a parsed drawing.
 *
 * Exported separately from the file-level entry point so the canvas surface —
 * which already holds a live `ExcalidrawDrawing` in memory — can reach the same
 * structure without a round trip through markdown.
 */
export function buildGraph(
  drawing: ExcalidrawDrawing,
): Pick<DrawingGraph, "nodes" | "edges" | "legend" | "wikilinks" | "stats"> {
  const all = Array.isArray(drawing?.elements) ? drawing.elements : [];
  const live: RawElement[] = [];
  let deleted = 0;
  for (const raw of all) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw as Record<string, unknown>).isDeleted === true) {
      deleted++;
      continue;
    }
    const el = readElement(raw as Record<string, unknown>);
    if (el.id && el.kind) live.push(el);
  }

  // --- pass 1: bound labels. Text with a containerId belongs to that shape.
  const boundLabel = new Map<string, string>();
  const boundTextIds = new Set<string>();
  for (const e of live) {
    if (e.kind === "text" && e.containerId) {
      boundLabel.set(e.containerId, tidy(e.text));
      boundTextIds.add(e.id);
    }
  }

  const byId = new Map(live.map((e) => [e.id, e]));

  // --- pass 2: containment. An explicit frameId always wins over geometry;
  // otherwise the SMALLEST strictly-larger container wins, so a box inside a
  // section inside the canvas attaches to the section.
  const candidates = live.filter(
    (e) => CONTAINER_KINDS.has(e.kind) && area(e) > 0 && !boundTextIds.has(e.id),
  );
  const parentOf = new Map<string, string>();
  for (const e of live) {
    if (boundTextIds.has(e.id)) continue;
    if (e.frameId && byId.has(e.frameId)) {
      parentOf.set(e.id, e.frameId);
      continue;
    }
    if (EDGE_KINDS.has(e.kind)) continue; // an arrow belongs to no section
    let best: RawElement | null = null;
    for (const c of candidates) {
      if (c.id === e.id) continue;
      if (area(c) <= area(e)) continue;
      if (!contains(c, e)) continue;
      if (!best || area(c) < area(best)) best = c;
    }
    if (best) parentOf.set(e.id, best.id);
  }

  const hasChildren = new Set(parentOf.values());

  // --- pass 3: section titles. An unlabelled container takes the topmost free
  // text sitting in its title band. That text stops being a loose item.
  //
  // A title is matched on its ORIGIN point, not on full containment: a heading
  // written across the top of a section box routinely overruns the box's right
  // edge. Measured on "Stealth Uploader - System Map" — two of its five section
  // titles ("· CONTROL PLANE (VPS · out-of-band)", "· UPLOAD NODE …") are wider
  // than the box they title, so a bbox test loses exactly the labels that name
  // the sections. The looser test is confined to this pass; every other
  // relationship still requires real containment.
  const titleOfContainer = new Map<string, string>();
  const titleTextIds = new Set<string>();
  for (const c of [...candidates].sort((a, b) => area(a) - area(b))) {
    if (boundLabel.has(c.id)) continue;
    if (!hasChildren.has(c.id)) continue; // an empty box has nothing to title
    let pick: RawElement | null = null;
    for (const e of live) {
      if (e.kind !== "text") continue;
      if (boundTextIds.has(e.id) || titleTextIds.has(e.id)) continue;
      // A title sits INSIDE the top of its box. Text floating just above one
      // is something else — on the Stealth map it is the drawing's legend,
      // which sits 34px above the first section and would otherwise be read as
      // that section's name.
      if (e.y < c.y - CONTAINMENT_SLACK || e.y > c.y + SECTION_TITLE_BAND) continue;
      const owner = parentOf.get(e.id);
      const originInside =
        e.x >= c.x - CONTAINMENT_SLACK && e.x <= c.x + Math.abs(c.width);
      // Either the title is genuinely inside this box, or it is unclaimed and
      // starts inside this box's horizontal span. Never steal another
      // container's child.
      if (owner !== c.id && !(owner === undefined && originInside)) continue;
      if (!pick || e.y < pick.y || (e.y === pick.y && e.x < pick.x)) pick = e;
    }
    if (pick && tidy(pick.text)) {
      titleOfContainer.set(c.id, tidy(pick.text));
      titleTextIds.add(pick.id);
      parentOf.set(pick.id, c.id);
    }
  }

  const labelOf = (id: string): string =>
    boundLabel.get(id) ??
    titleOfContainer.get(id) ??
    (byId.get(id)?.kind === "text" ? tidy(byId.get(id)?.text ?? "") : "");

  // --- nodes
  const nodes: DrawingNode[] = [];
  for (const e of live) {
    if (boundTextIds.has(e.id)) continue; // already its container's label
    if (EDGE_KINDS.has(e.kind)) continue; // edges are not nodes
    const strokeName = DEFAULT_STROKES.has(e.stroke.toLowerCase())
      ? null
      : colourName(e.stroke);
    nodes.push({
      id: e.id,
      kind: e.kind,
      role: roleOf(e.kind, hasChildren.has(e.id)),
      label: labelOf(e.id),
      fill: colourName(e.bg),
      stroke: strokeName,
      strokeStyle: e.strokeStyle,
      link: e.link || null,
      x: Math.round(e.x),
      y: Math.round(e.y),
      width: Math.round(e.width),
      height: Math.round(e.height),
      parentId: parentOf.get(e.id) ?? null,
      isParentTitle: titleTextIds.has(e.id),
      groupIds: e.groupIds,
    });
  }

  // --- edges
  const edges: DrawingEdge[] = [];
  let unresolved = 0;
  for (const e of live) {
    if (!EDGE_KINDS.has(e.kind)) continue;
    if (!e.startId && !e.endId && e.kind === "line") continue; // decoration
    const isArrow = e.kind === "arrow";
    if (!e.startId || !e.endId) unresolved++;
    edges.push({
      id: e.id,
      kind: e.kind,
      fromId: e.startId || null,
      toId: e.endId || null,
      fromLabel: e.startId ? labelOf(e.startId) || null : null,
      toLabel: e.endId ? labelOf(e.endId) || null : null,
      label: boundLabel.get(e.id) ?? "",
      strokeStyle: e.strokeStyle,
      stroke: DEFAULT_STROKES.has(e.stroke.toLowerCase())
        ? null
        : colourName(e.stroke),
      directed: arrowheadPresent(e.endArrowhead, isArrow),
      bidirectional:
        arrowheadPresent(e.endArrowhead, isArrow) &&
        arrowheadPresent(e.startArrowhead, false),
    });
  }

  // --- legend + wikilinks
  const legend: string[] = [];
  for (const n of nodes) {
    if (n.kind !== "text" || !n.label) continue;
    if (!n.label.includes("=")) continue;
    if (!LEGEND_CHANNEL.test(n.label)) continue;
    legend.push(n.label);
  }

  const linkSources: string[] = [];
  for (const n of nodes) {
    if (n.link) linkSources.push(n.link);
    if (n.label) linkSources.push(n.label);
  }
  const wikilinks = collectWikilinks(linkSources);

  return {
    nodes,
    edges,
    legend,
    wikilinks,
    stats: {
      liveElements: live.length,
      deletedElements: deleted,
      unresolvedEndpoints: unresolved,
    },
  };
}

/* ==========================================================================
 * Markdown-level extraction
 * ========================================================================== */

/** The plugin writes this banner into every drawing. It is identical in all 16
 *  of Konrad's files, so embedding it would make every drawing look like every
 *  other drawing to a vector search. */
const BANNER_RE = /^.*Switch to EXCALIDRAW VIEW.*$/gm;

/** Strip the banner and the plugin's own scaffolding out of the back-of-note
 *  region, leaving only prose Konrad actually wrote. */
export function cleanPreamble(preamble: string): string {
  return preamble
    .replace(BANNER_RE, "")
    .replace(/^%%\s*$/gm, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Frontmatter tags, minus the plugin's own `excalidraw` marker (present on
 *  every drawing, therefore carrying no information). */
export function drawingTags(frontmatter: string): string[] {
  const m = /^tags:\s*(.+)$/m.exec(frontmatter);
  if (!m) return [];
  const body = m[1].trim().replace(/^\[|\]$/g, "");
  return body
    .split(",")
    .map((s) => s.trim().replace(/^["'#]|["']$/g, ""))
    .filter((s) => s && s.toLowerCase() !== "excalidraw");
}

/**
 * The plugin's plain-text mirror of every text element, used when the binary
 * payload cannot be read. Lines look like `Some label ^elementId`.
 */
export function textElementsIndex(raw: string): string[] {
  const start = raw.indexOf("## Text Elements");
  if (start === -1) return [];
  const rest = raw.slice(start + "## Text Elements".length);
  const end = rest.search(/\n(## |%%)/);
  const block = end === -1 ? rest : rest.slice(0, end);
  return block
    .split("\n")
    .map((l) => l.replace(/\s*\^[A-Za-z0-9_-]+\s*$/, "").trim())
    .filter(Boolean);
}

/** Drawing name from a vault-relative path. */
export function drawingTitle(vaultPath: string): string {
  const base = vaultPath.split("/").pop() ?? vaultPath;
  return base.replace(/\.excalidraw\.md$/i, "").replace(/\.md$/i, "");
}

/** True for the paths this module claims. */
export function isDrawingPath(vaultPath: string): boolean {
  return vaultPath.toLowerCase().endsWith(".excalidraw.md");
}

/**
 * Parse one `.excalidraw.md` file into a typed graph.
 *
 * Throws `ExcalidrawExtractError` only when the file is not an Excalidraw
 * document at all. A file whose PAYLOAD is unreadable is not an error — the
 * plugin also writes every label in plain text under `## Text Elements`, so we
 * fall back to that and set `degraded` to the reason. A degraded reading is
 * still worth indexing; a silent one would not be.
 */
export function extractDrawing(vaultPath: string, raw: string): DrawingGraph {
  if (!isDrawingPath(vaultPath)) {
    throw new ExcalidrawExtractError(
      vaultPath,
      `not a .excalidraw.md path — extractDrawing() must not be used to read ` +
        `ordinary notes, whose body is markdown and needs no decoding`,
    );
  }

  let doc: ExcalidrawDoc | null = null;
  let degraded: string | null = null;
  try {
    doc = parseExcalidrawMarkdown(raw);
  } catch (err) {
    degraded = `drawing payload unreadable (${
      err instanceof Error ? err.message : String(err)
    }); text recovered from the plugin's ## Text Elements index`;
  }

  const title = drawingTitle(vaultPath);
  const tags = drawingTags(doc?.frontmatter ?? "");
  const prose = cleanPreamble(doc?.preamble ?? "");

  if (!doc) {
    const lines = textElementsIndex(raw);
    return {
      path: vaultPath,
      title,
      tags,
      prose,
      legend: [],
      wikilinks: collectWikilinks(lines),
      nodes: lines.map((text, i) => ({
        id: `text-index-${i}`,
        kind: "text",
        role: "text" as const,
        label: tidy(text),
        fill: null,
        stroke: null,
        strokeStyle: "solid",
        link: null,
        x: 0,
        y: i,
        width: 0,
        height: 0,
        parentId: null,
        isParentTitle: false,
        groupIds: [],
      })),
      edges: [],
      stats: {
        liveElements: lines.length,
        deletedElements: 0,
        unresolvedEndpoints: 0,
      },
      degraded,
    };
  }

  const built = buildGraph(doc.drawing);
  return { path: vaultPath, title, tags, prose, ...built, degraded };
}

/* ==========================================================================
 * Rendering — the graph as text an embedder and an agent can both read
 * ========================================================================== */

function readingOrder(a: DrawingNode, b: DrawingNode): number {
  const band = Math.round(a.y / ROW_BAND) - Math.round(b.y / ROW_BAND);
  if (band !== 0) return band;
  if (a.x !== b.x) return a.x - b.x;
  return a.id.localeCompare(b.id);
}

/** `[green, dashed]` — the visual channels, named, never interpreted. */
function traits(n: DrawingNode): string {
  const parts: string[] = [];
  if (n.fill) parts.push(n.fill);
  if (n.strokeStyle && n.strokeStyle !== "solid") parts.push(n.strokeStyle);
  if (n.stroke && !n.fill) parts.push(`${n.stroke} outline`);
  if (n.link) parts.push(`link: ${n.link}`);
  return parts.length ? `  [${parts.join(", ")}]` : "";
}

function nodeLine(n: DrawingNode, indent: string): string {
  const name = n.label || `(unlabelled ${n.kind})`;
  return `${indent}- ${name}${traits(n)}`;
}

/**
 * Render a list of sibling nodes, collapsing the mute ones into a tally.
 *
 * "Drawing 2026-08-09" is 382 freedraw strokes and five images — a page of
 * handwriting with no text elements at all. Printed one per line it is 9 KB of
 * "(unlabelled freedraw)", which would out-weigh every real drawing in the
 * vault in any embedding. A node that says nothing, links nowhere and holds
 * nothing is counted, not listed; the count keeps the rendering honest about
 * what is on the canvas.
 */
function renderSiblings(
  siblings: DrawingNode[],
  children: Map<string, DrawingNode[]>,
  indent: string,
): string[] {
  const out: string[] = [];
  const mute = new Map<string, number>();
  for (const n of [...siblings].sort(readingOrder)) {
    const speaks = n.label || n.link || children.has(n.id);
    if (!speaks) {
      mute.set(n.kind, (mute.get(n.kind) ?? 0) + 1);
      continue;
    }
    out.push(nodeLine(n, indent));
    for (const gk of (children.get(n.id) ?? []).sort(readingOrder)) {
      out.push(nodeLine(gk, `${indent}  `));
    }
  }
  for (const [kind, count] of [...mute].sort((a, b) => b[1] - a[1])) {
    out.push(`${indent}- ${count} unlabelled ${kind} element(s), no text on them`);
  }
  return out;
}

function edgeLine(e: DrawingEdge): string {
  const from = e.fromLabel ?? (e.fromId ? "(unlabelled)" : "?");
  const to = e.toLabel ?? (e.toId ? "(unlabelled)" : "?");
  const sym = e.bidirectional ? "<->" : e.directed ? "->" : "--";
  const via = e.label ? ` (${e.label})` : "";
  const style = e.strokeStyle !== "solid" ? ` [${e.strokeStyle}]` : "";
  return `- ${from} ${sym} ${to}${via}${style}`;
}

/**
 * Render the graph as the text that gets embedded.
 *
 * Shape of the output is deliberate: a heading with the drawing's name, the
 * prose Konrad wrote, the legend HE stated, then sections → items, then the
 * connections. It reads like notes because a vector search over notes is what
 * it has to compete with.
 */
export function renderGraphText(g: DrawingGraph): string {
  const out: string[] = [`# ${g.title}`, ``, `Excalidraw drawing: ${g.path}`];
  if (g.tags.length) out.push(`Tags: ${g.tags.join(", ")}`);
  if (g.degraded) out.push(`NOTE: ${g.degraded}`);

  if (!g.nodes.length && !g.prose) {
    out.push(
      ``,
      g.stats.deletedElements > 0
        ? `This drawing is empty: every one of its ${g.stats.deletedElements} ` +
            `elements is marked deleted. Nothing has been drawn on it that survives.`
        : `This drawing is empty — no elements have been drawn on it yet.`,
    );
    return out.join("\n");
  }

  if (g.prose) out.push(``, `## Notes on this drawing`, ``, g.prose);

  if (g.legend.length) {
    out.push(
      ``,
      `## Legend, as written on the canvas`,
      ``,
      ...g.legend.map((l) => `- ${l}`),
      ``,
      `Colour and stroke below are reported by name only; their meaning is ` +
        `whatever this legend says it is.`,
    );
  }

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const children = new Map<string, DrawingNode[]>();
  const roots: DrawingNode[] = [];
  for (const n of g.nodes) {
    if (n.isParentTitle) continue; // already printed as its section's heading
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    if (!p) roots.push(n);
    else children.set(p, [...(children.get(p) ?? []), n]);
  }

  const sections = roots.filter((n) => children.has(n.id)).sort(readingOrder);
  const loose = roots.filter((n) => !children.has(n.id)).sort(readingOrder);

  if (sections.length) {
    out.push(
      ``,
      `## Groups (from geometric containment — one shape drawn inside another)`,
    );
    for (const s of sections) {
      const heading = s.label || `(unlabelled ${s.kind})`;
      out.push(``, `### ${heading}${traits(s)}`);
      out.push(...renderSiblings(children.get(s.id) ?? [], children, ""));
    }
  }

  if (loose.length) {
    out.push(
      ``,
      sections.length ? `## Not inside any group` : `## Elements`,
      ``,
      ...renderSiblings(loose, children, ""),
    );
  }

  if (g.edges.length) {
    const resolved = g.edges.filter((e) => e.fromId && e.toId);
    const dangling = g.edges.filter((e) => !e.fromId || !e.toId);
    if (resolved.length) {
      out.push(
        ``,
        `## Connections (-> is a directed arrow, -- an undirected line)`,
        ``,
        ...resolved.map(edgeLine),
      );
    }
    if (dangling.length) {
      out.push(
        ``,
        `## Ambiguous connections`,
        ``,
        `${dangling.length} arrow(s)/line(s) are not bound to a shape at one or ` +
          `both ends, so what they connect cannot be read from the file. They ` +
          `are listed, not guessed:`,
        ``,
        ...dangling.map(edgeLine),
      );
    }
  }

  if (g.wikilinks.length) {
    out.push(``, `## Links to other notes`, ``, ...g.wikilinks.map((w) => `- [[${w}]]`));
  }

  return out.join("\n");
}

/* ==========================================================================
 * The one call the indexers make
 * ========================================================================== */

export interface DrawingExtract {
  graph: DrawingGraph;
  /** The semantic rendering — what gets chunked and embedded. */
  text: string;
  /**
   * True when the drawing holds nothing worth indexing: no surviving element
   * and no prose. Distinct from "we failed to read it", which is `degraded`.
   */
  isEmpty: boolean;
}

/** Parse + render in one step. Every indexer entry point goes through this. */
export function extractDrawingText(
  vaultPath: string,
  raw: string,
): DrawingExtract {
  const graph = extractDrawing(vaultPath, raw);
  const hasContent = graph.nodes.some((n) => n.label) || graph.prose.length > 0;
  return {
    graph,
    text: renderGraphText(graph),
    isEmpty: !hasContent,
  };
}
