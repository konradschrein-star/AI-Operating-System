/**
 * A tiny, strict frontmatter parser/serialiser for the FLAT thoughts schema
 * (PLAN.md §3.2): string, integer and date-string values only, one key per
 * line, no nesting, no arrays. Not a YAML parser — it accepts exactly the
 * subset this project's writer emits, and refuses everything else loudly
 * rather than guessing.
 *
 * `db/memory.ts` has a private `extractFrontmatter()` that is deliberately
 * forgiving (skips lines it can't parse, returns `{}` on a missing block) —
 * right for indexing arbitrary human notes, wrong for a store round-tripping
 * its OWN documents. A malformed thoughts file is a bug in this module or in
 * something that touched the file by hand; it must surface as a named error,
 * not silently vanish from a list.
 */

export interface FrontmatterDoc {
  data: Record<string, string | number>;
  body: string;
}

const OPEN = "---";
const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const KV_LINE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):[ \t]?(.*)$/;
const INT_RE = /^-?\d+$/;

/** Parse a frontmatter document. `sourcePath` is never used to read
 *  anything — it exists purely so a thrown error names the file it came
 *  from, because the caller (lib/thoughts.ts `list()`) fans out over many
 *  files and needs to attribute a failure to one of them. */
export function parseFrontmatter(raw: string, sourcePath: string): FrontmatterDoc {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== OPEN) {
    throw new Error(
      `frontmatter must open with "---" as line 1: ${sourcePath} (line 1 was ${JSON.stringify(lines[0] ?? "")})`,
    );
  }
  let closeLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === OPEN) {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) {
    throw new Error(`frontmatter block never closes with a "---" line: ${sourcePath}`);
  }

  const data: Record<string, string | number> = {};
  for (let i = 1; i < closeLine; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const m = line.match(KV_LINE_RE);
    if (!m) {
      throw new Error(
        `malformed frontmatter line ${i + 1} (expected "key: value"): ${sourcePath}: ${JSON.stringify(line)}`,
      );
    }
    const key = m[1];
    if (key in data) {
      throw new Error(`duplicate frontmatter key "${key}" at line ${i + 1}: ${sourcePath}`);
    }
    data[key] = parseValue(m[2], key, i + 1, sourcePath);
  }

  const body = lines.slice(closeLine + 1).join("\n");
  return { data, body };
}

function parseValue(rawValue: string, key: string, lineNo: number, sourcePath: string): string | number {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw new Error(`unterminated quoted value for "${key}" at line ${lineNo}: ${sourcePath}`);
    }
    return unquote(trimmed.slice(1, -1), key, lineNo, sourcePath);
  }
  if (INT_RE.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Inverts serializeValue()'s escaping char-by-char (not with two sequential
 *  regex replaces — `\\"` decoded in the wrong order turns into `"` twice). */
function unquote(inner: string, key: string, lineNo: number, sourcePath: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\") {
      const next = inner[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i++;
      } else {
        throw new Error(
          `invalid escape sequence "\\${next ?? ""}" in "${key}" at line ${lineNo}: ${sourcePath}`,
        );
      }
    } else if (ch === '"') {
      throw new Error(`unescaped quote inside value for "${key}" at line ${lineNo}: ${sourcePath}`);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Serialise `data` (in insertion order — callers pass fields in the order
 *  they want them written) back into a frontmatter block followed by `body`
 *  unchanged. Round-trips with parseFrontmatter(): every value this function
 *  accepts, parseFrontmatter() reads back to the identical JS value. */
export function serializeFrontmatter(data: Record<string, string | number>, body: string): string {
  const lines = [OPEN];
  for (const [key, value] of Object.entries(data)) {
    if (!KEY_RE.test(key)) {
      throw new Error(`invalid frontmatter key ${JSON.stringify(key)}`);
    }
    lines.push(`${key}: ${serializeValue(key, value)}`);
  }
  lines.push(OPEN);
  return lines.join("\n") + "\n" + body;
}

function serializeValue(key: string, value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`frontmatter field "${key}" is not an integer: ${value}`);
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new Error(
      `frontmatter field "${key}" must be a string or integer, got ${typeof value}: ${JSON.stringify(value)}`,
    );
  }
  if (value.includes("\n")) {
    throw new Error(
      `frontmatter field "${key}" may not contain a newline — this is a flat schema, put multi-line text in the body: ${JSON.stringify(value)}`,
    );
  }
  // Quote whenever leaving it bare would change what parseFrontmatter() reads
  // back: empty, padded, containing ":" (the key/value separator), containing
  // a literal quote, or all-digits (would round-trip as a number instead of
  // this string).
  const needsQuoting =
    value === "" ||
    value !== value.trim() ||
    value.includes(":") ||
    value.includes('"') ||
    INT_RE.test(value);
  if (!needsQuoting) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
