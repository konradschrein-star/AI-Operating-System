/**
 * remark-wikilink.ts — `[[Operating Manual]]` becomes a link into the vault.
 *
 * WHY REMARK AND NOT REHYPE. Konrad's vault runs on wikilinks and agents write
 * them constantly; today they render as four literal brackets and are not
 * clickable at all (D2). The transform belongs BEFORE the sanitiser, not after:
 * a rehype plugin would run inside the already-sanitised tree and every node it
 * added would be unaudited by `rehypeForgeAllowlist`. Running here, the link it
 * creates is an ordinary mdast `link` — it goes through `urlTransform`, through
 * `safeHref`, and through the allowlist exactly like a link the author typed.
 *
 * WHAT IT MAY NOT DO, and does not:
 *   • It never produces HTML. It produces mdast `link` nodes; `rehype-raw` is
 *     still absent and must stay absent.
 *   • The url is always a SAME-ORIGIN RELATIVE path (`/document?…`), which is
 *     what `safeHref` permits. Nothing from the author's text reaches the url
 *     un-encoded — `encodeURIComponent` is applied to every interpolated part,
 *     so `[[javascript:alert(1)]]` becomes a link to
 *     `/document?wikilink=javascript%3Aalert(1)`, i.e. a search for a note by
 *     that silly name, not a scheme the browser will run.
 *   • It never touches text inside code, inline code or an existing link.
 *     A fenced block that documents wikilink syntax has to stay literal, and a
 *     link inside a link is not a thing.
 *
 * NO DEPENDENCY. `unist-util-visit` would do the walk; this file does it in
 * twenty lines instead, in the dependency-free style of
 * `rehype-forge-allowlist.ts` (NFU8 — no new packages for a struct with four
 * fields). The mdast shapes are declared structurally here for the same reason.
 *
 * Rejected inners (`[[]]`, `[[<img …>]]`, anything `parseWikilink` refuses)
 * are LEFT AS TEXT. A dead affordance is worse than no affordance — the same
 * rule that governs `detectPath`.
 */

import { parseWikilink } from "./code-path-link";

export interface MdastText {
  type: "text";
  value: string;
}

export interface MdastLink {
  type: "link";
  url: string;
  title: string | null;
  children: MdastNode[];
}

export interface MdastParent {
  type: string;
  children?: MdastNode[];
}

export type MdastNode = MdastText | MdastLink | MdastParent;

function isText(node: MdastNode): node is MdastText {
  return node.type === "text" && typeof (node as MdastText).value === "string";
}

/**
 * Subtrees whose text is not prose.
 *
 * `code` and `inlineCode` hold a `value` and no children, so they are already
 * unreachable by the walk — they are named anyway because that is a property of
 * today's mdast, not a rule, and the day a plugin gives them children this list
 * is what keeps a fenced example inert. `link`/`linkReference` are skipped so a
 * wikilink written inside a real link cannot nest one anchor in another.
 */
const OPAQUE: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "image",
  "imageReference",
  "html",
  "yaml",
]);

/** `[[…]]` with an inner that contains no bracket of its own. A nested bracket
 *  means the scan mis-framed the link, and `parseWikilink` refuses those too. */
const WIKILINK = /\[\[([^[\]]*)\]\]/g;

/**
 * The href a wikilink points at. `/document` resolves it with the SAME
 * resolver the pill uses (`resolve-path.ts`), so a Ctrl-click and a plain
 * click cannot disagree about which note `[[Operating Manual]]` is.
 */
export function wikilinkHref(name: string, path: string | null): string {
  const href = `/document?wikilink=${encodeURIComponent(name)}`;
  return path ? `${href}&wikipath=${encodeURIComponent(path)}` : href;
}

/**
 * Split one text node into the alternating literal / link sequence.
 * Returns null when the node contains no wikilink at all, so the common case
 * costs one regex test and allocates nothing.
 */
function splitText(value: string): MdastNode[] | null {
  WIKILINK.lastIndex = 0;
  if (!WIKILINK.test(value)) return null;
  WIKILINK.lastIndex = 0;

  const out: MdastNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK.exec(value)) !== null) {
    const link = parseWikilink(m[1]);
    if (!link) continue; // refused: the whole `[[…]]` stays literal text
    if (m.index > cursor) {
      out.push({ type: "text", value: value.slice(cursor, m.index) });
    }
    out.push({
      type: "link",
      url: wikilinkHref(link.name, link.path),
      title: null,
      children: [{ type: "text", value: link.alias ?? link.name }],
    });
    cursor = m.index + m[0].length;
  }
  if (out.length === 0) return null; // every candidate was refused
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) });
  }
  return out;
}

/** Rewrite a parent's children in place. Exported for the unit check, which
 *  drives it over hand-built trees as well as through the real parser. */
export function transformWikilinks(node: MdastNode): void {
  const parent = node as MdastParent;
  const children = parent.children;
  if (!Array.isArray(children)) return;
  const out: MdastNode[] = [];
  for (const child of children) {
    if (isText(child)) {
      const split = splitText(child.value);
      if (split) out.push(...split);
      else out.push(child);
      continue;
    }
    if (!OPAQUE.has(child.type)) transformWikilinks(child);
    out.push(child);
  }
  parent.children = out;
}

/**
 * The unified plugin. Written as a plain function returning a transformer so it
 * needs no `unified` types at the call site; react-markdown accepts it in
 * `remarkPlugins`.
 *
 * MUST run AFTER `remark-gfm`: gfm is what turns a table row into cells, and a
 * wikilink written inside a cell is escaped (`[[Target\|Alias]]`) precisely so
 * the pipe is not read as a cell separator. Running first would mean splitting
 * text that gfm has not finished parsing.
 */
export function remarkWikilink() {
  return function transform(tree: MdastNode): void {
    transformWikilinks(tree);
  };
}
