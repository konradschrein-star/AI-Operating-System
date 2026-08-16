/**
 * rehype-forge-allowlist.ts — the strict allowlist the chat transcript renders
 * model output through. Round 808.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THREAT THIS IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * Every message in this transcript is written by an agent, and an agent that
 * has read a hostile web page, cloned a hostile repo or opened a hostile file
 * is writing what somebody else chose. Round 804 proved the secrets panel
 * renders eight such payloads inert. This round makes the CHAT rich, and rich
 * is where a sanitiser stops being optional.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT ACTUALLY CHANGES — AND THE HOLE IT CLOSED
 * ═══════════════════════════════════════════════════════════════════════════
 * react-markdown already refuses raw HTML (no `rehype-raw` here, and there
 * must never be one) and already blanks `javascript:` hrefs. Measured on this
 * repo's own version before this file existed:
 *
 *     <script>alert(1)</script>              → escaped literal text      SAFE
 *     <img src=x onerror="fetch()">          → escaped literal text      SAFE
 *     [x](javascript:alert(document.cookie)) → <a href="">               SAFE
 *     ![s](http://127.0.0.1:9/beacon.png)    → <img src="http://…">      LIVE
 *                                              plus a React <link rel=preload>
 *
 * The last one is a real hole and it was open: a markdown image in ANY agent
 * message made the operator console fetch an attacker-chosen URL — a beacon
 * that reports when Konrad read the message, from his IP, with his console
 * open. This plugin turns every image into inert text, which is why the tree
 * it emits contains no `img` at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULES
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. DANGEROUS tags are removed with their entire subtree — their children
 *      are code, not content, so unwrapping them would paste the code in.
 *   2. Any other tag not on ALLOWED is UNWRAPPED: the element goes, its
 *      children stay. Nothing an author wrote disappears silently.
 *   3. Attributes are per-tag. Anything not listed is dropped — which covers
 *      every `on*` handler, `style`, `srcset`, `formaction`, `xlink:href` and
 *      whatever the next spec adds, because the list is a WHITELIST and does
 *      not need to be taught about them.
 *   4. `href` must be http(s), mailto, a fragment or a same-origin relative
 *      path. `javascript:`, `data:`, `vbscript:` and everything else become no
 *      href at all — the link renders as text and goes nowhere.
 *   5. `img` becomes a text marker. No remote resource loads from message
 *      content, ever.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TYPES
 * ═══════════════════════════════════════════════════════════════════════════
 * The hast shapes are declared here rather than imported from `hast`: that
 * package is a transitive type-only dependency of react-markdown, and this
 * repo does not add dependencies for a struct with four fields (NFU8). They
 * are structural, so tsc still checks every access.
 */

export interface HastText {
  type: "text";
  value: string;
}

export interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown> | null;
  children: HastNode[];
}

export interface HastParent {
  type: string;
  children?: HastNode[];
}

export type HastNode = HastText | HastElement | HastParent;

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

/** Dropped with everything inside them. */
const DANGEROUS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "template",
  "noscript",
  "svg",
  "math",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "portal",
]);

/**
 * Tag → the attributes it may keep. An empty set means "the tag is fine, none
 * of its attributes are".
 *
 * This is exactly what remark + remark-gfm can emit for the components
 * MessageMarkdown styles, plus the footnote scaffolding GFM adds (`section`,
 * `sup`, `a`) and the task-list checkbox (`input`).
 */
const ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["p", new Set<string>()],
  ["h1", new Set<string>()],
  ["h2", new Set<string>()],
  ["h3", new Set<string>()],
  ["h4", new Set<string>()],
  ["h5", new Set<string>()],
  ["h6", new Set<string>()],
  ["ul", new Set<string>()],
  ["ol", new Set(["start"])],
  ["li", new Set(["className"])],
  ["a", new Set(["href"])],
  ["blockquote", new Set<string>()],
  ["code", new Set(["className"])],
  ["pre", new Set<string>()],
  ["table", new Set<string>()],
  ["thead", new Set<string>()],
  ["tbody", new Set<string>()],
  ["tr", new Set<string>()],
  ["th", new Set(["align"])],
  ["td", new Set(["align"])],
  ["hr", new Set<string>()],
  ["em", new Set<string>()],
  ["strong", new Set<string>()],
  ["del", new Set<string>()],
  ["br", new Set<string>()],
  ["span", new Set<string>()],
  ["sup", new Set<string>()],
  ["section", new Set(["className"])],
  ["input", new Set(["type", "checked", "disabled"])],
]);

/** `language-…` and GFM's own class names. Anything else is dropped — a class
 *  is a styling hook, and a hostile one can only be an attempt to borrow
 *  chrome this app draws for itself. */
const CLASS_OK = /^(language-[A-Za-z0-9_+#-]{1,32}|task-list-item|contains-task-list|footnotes|sr-only|data-footnote-backref)$/;

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/(?!\/))/i;

/**
 * A URL this app is willing to put in an href.
 *
 * Leading whitespace and C0 controls are stripped BEFORE the test, because
 * `java\tscript:` and `javascript:` are both parsed as javascript: by
 * browsers and would otherwise walk past a naive prefix check. `//evil.example`
 * is refused too: protocol-relative is remote loading with the scheme hidden.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u0020\u007f-\u009f]/gu, "");
  if (cleaned === "") return null;
  return SAFE_URL.test(cleaned) ? cleaned : null;
}

/** hast keeps `className` as an array; anything else arrives as given. */
function keepClassName(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  const kept = list.filter((c): c is string => typeof c === "string" && CLASS_OK.test(c));
  return kept.length > 0 ? kept : null;
}

function keepAlign(value: unknown): string | null {
  return value === "left" || value === "right" || value === "center" ? value : null;
}

function keepStart(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000 ? n : null;
}

/** The text an image is replaced by. Alt and URL are shown so nothing is
 *  hidden from the reader — as TEXT, which cannot fetch anything. */
function imageMarker(node: HastElement): HastText {
  const props = node.properties ?? {};
  const alt = typeof props.alt === "string" && props.alt ? props.alt : "image";
  const src = typeof props.src === "string" ? props.src : "";
  return {
    type: "text",
    value: src ? `[image not loaded: ${alt} — ${src}]` : `[image not loaded: ${alt}]`,
  };
}

function sanitizeProperties(node: HastElement, allowed: ReadonlySet<string>): void {
  const props = node.properties;
  if (!props) return;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) continue;
    const value = props[key];
    if (key === "href") {
      const href = safeHref(value);
      if (href !== null) next.href = href;
      continue;
    }
    if (key === "className") {
      const cls = keepClassName(value);
      if (cls !== null) next.className = cls;
      continue;
    }
    if (key === "align") {
      const align = keepAlign(value);
      if (align !== null) next.align = align;
      continue;
    }
    if (key === "start") {
      const start = keepStart(value);
      if (start !== null) next.start = start;
      continue;
    }
    if (node.tagName === "input") {
      /* Task-list checkboxes only, and never interactive: a checkbox the
       * reader can toggle implies a state this app does not store. */
      if (key === "type") {
        if (value === "checkbox") next.type = "checkbox";
        continue;
      }
      if (key === "checked") {
        next.checked = value === true;
        continue;
      }
      if (key === "disabled") continue; // forced on below
      continue;
    }
  }
  if (node.tagName === "input") next.disabled = true;
  node.properties = next;
}

/** Depth guard. A 10 000-deep nest of blockquotes is a denial of service on
 *  the renderer, not a message; past this depth the subtree is flattened to
 *  its text. Chosen far above anything a human writes and far below what
 *  breaks React's reconciler. */
const MAX_DEPTH = 40;

function textOf(node: HastNode): string {
  if (node.type === "text") return (node as HastText).value;
  const kids = (node as HastParent).children ?? [];
  return kids.map(textOf).join("");
}

function walk(nodes: HastNode[], depth: number): HastNode[] {
  const out: HastNode[] = [];
  for (const node of nodes) {
    if (!isElement(node)) {
      const parent = node as HastParent;
      if (Array.isArray(parent.children)) parent.children = walk(parent.children, depth + 1);
      out.push(node);
      continue;
    }
    const tag = node.tagName.toLowerCase();
    if (DANGEROUS.has(tag)) continue; // rule 1 — subtree and all
    if (tag === "img") {
      out.push(imageMarker(node)); // rule 5
      continue;
    }
    if (depth >= MAX_DEPTH) {
      out.push({ type: "text", value: textOf(node) });
      continue;
    }
    const allowed = ALLOWED.get(tag);
    const children = walk(node.children ?? [], depth + 1);
    if (allowed === undefined) {
      out.push(...children); // rule 2 — unwrap, keep the words
      continue;
    }
    node.tagName = tag;
    node.children = children;
    sanitizeProperties(node, allowed); // rules 3 and 4
    out.push(node);
  }
  return out;
}

/**
 * The unified plugin. Written as a plain function returning a transformer so
 * it needs no `unified` types at the call site; react-markdown accepts it in
 * `rehypePlugins`.
 *
 * MUST run last, i.e. after every other rehype plugin, so that whatever they
 * produced is also filtered. Today it is the only one.
 */
export function rehypeForgeAllowlist() {
  return function transform(tree: HastParent): void {
    if (!Array.isArray(tree.children)) return;
    tree.children = walk(tree.children, 0);
  };
}

/** Exported for `check-chat-rich.ts`, which runs the injection battery
 *  directly against the tree rather than only against rendered HTML. */
export const ALLOWLIST_FOR_TESTS = { ALLOWED, DANGEROUS, CLASS_OK, SAFE_URL };
