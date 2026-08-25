/**
 * splitFrontmatter — peel a leading YAML frontmatter block off a markdown file.
 *
 * Every profile note in Konrad's vault opens with a `---` block, and FilePreview
 * used to hand the whole thing to the markdown renderer, which showed it as a
 * wall of prose ("type: profile section: operating-manual created: …") above
 * the first real sentence. The block is metadata; it renders as a compact meta
 * strip, never as body text.
 *
 * Deliberately NOT a YAML parser. No dependency, no schema, no coercion:
 *   - only a block that STARTS the file (`---` on line 1) counts; a `---`
 *     thematic break further down is body and stays body;
 *   - an unterminated block is not frontmatter at all — meta is null and the
 *     body comes back byte-for-byte, because guessing where it ended would eat
 *     the file;
 *   - a top-level `key: value` line becomes one entry; anything indented under
 *     it (a list, a nested map) is kept RAW as a multi-line value. Nobody reads
 *     a meta strip for structure, they read it for "what is this note".
 *
 * Pure and side-effect free so `scripts/checks/check-frontmatter.ts` can drive
 * it as a table without a DOM.
 */

/** One frontmatter line: the key, and its value exactly as written. */
export type MetaEntry = readonly [key: string, value: string];

export interface FrontmatterSplit {
  /** null when the text has no leading, terminated `---` block at all. */
  meta: MetaEntry[] | null;
  /** The text with the block removed — untouched when `meta` is null. */
  body: string;
}

/** The opening fence: `---` alone on the very first line (CRLF tolerated). */
const OPEN_RE = /^---[ \t]*\r?\n/;
/** The closing fence: `---` alone on a line, carriage return already stripped. */
const CLOSE_RE = /^---[ \t]*$/;
/**
 * A top-level `key: value`. The key must start hard against the left margin —
 * an indented `key:` is a nested block and belongs to the entry above it.
 */
const KEY_RE = /^([^\s:][^:]*):[ \t]*(.*)$/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const open = OPEN_RE.exec(text);
  if (!open) return { meta: null, body: text };

  const lines: string[] = [];
  let cursor = open[0].length;
  while (cursor <= text.length) {
    const nl = text.indexOf("\n", cursor);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(cursor, end);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const next = nl === -1 ? text.length : nl + 1;
    if (CLOSE_RE.test(line)) {
      return { meta: parseMeta(lines), body: text.slice(next) };
    }
    if (nl === -1) break;
    lines.push(line);
    cursor = next;
  }

  // Ran off the end without a closing fence: this was never frontmatter.
  return { meta: null, body: text };
}

function parseMeta(lines: string[]): MetaEntry[] {
  const entries: Array<[string, string]> = [];
  for (const line of lines) {
    const continuation = /^[ \t]/.test(line) || /^-[ \t]/.test(line);
    const m = continuation ? null : KEY_RE.exec(line);
    if (m) {
      entries.push([m[1].trim(), m[2].trim()]);
      continue;
    }
    const last = entries[entries.length - 1];
    // Text before the first key is malformed YAML; there is no entry to hang
    // it on, so it is dropped rather than invented into one.
    if (!last) continue;
    last[1] = last[1] === "" ? line : `${last[1]}\n${line}`;
  }
  return entries;
}
