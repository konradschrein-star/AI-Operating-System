/**
 * Decide whether an inline `code` span in a message names a file Konrad can
 * open, and where that file lives.
 *
 * WHY: agents reference files constantly — `Mentor/Profile/OPEN-QUESTIONS.md`,
 * `AI OS/Operator Log.md`, `/opt/ai-os/scripts/guard-autonomy.py`, and above
 * all `MessageMarkdown.tsx:160`, which is how code is actually discussed.
 * Reading one meant leaving the chat, opening the file explorer, and hunting
 * for it by hand. A click on the blue pill now opens it in the Files panel;
 * Ctrl/Cmd-click opens the /document viewer.
 *
 * DESIGN RULE — NO FALSE AFFORDANCES. Inline code is used for far more than
 * paths: rule ids (`spend.per_run_cap`), commands (`pnpm install`), env vars,
 * numbers, and bare extension lists (`.md .txt .json .csv`, seen live and
 * marked openable by the first version of this file — six dead clicks in one
 * paragraph). If this says "openable" for those, every one is a dead click,
 * and an affordance that usually fails is worse than none. So the matcher is
 * deliberately narrow: WHEN UNSURE, RETURN NULL.
 *
 * Pure logic on purpose — no React, no fetch, no DOM. Every rule below is
 * covered by a case in scripts/checks/check-code-path-link.ts; add the case
 * with the rule.
 *
 * MEASURED, 2026-08-25: swept over 16 665 distinct inline-code spans taken
 * from real agent-written markdown (this repo's docs/plan + WORKLOG + the
 * fleet memory notes). 2 495 detect as openable. That sweep — not the unit
 * table — is what found the markdown-image, brace-glob, npm-scope, flag,
 * shell-assignment, git-status and "GET /api/…" false positives; each is a
 * rule above and a case in the check.
 *
 * KNOWN AND DELIBERATE: 68 of the 2 495 contain whitespace, and about forty of
 * those are prose or a command with a real file in it — "bash
 * scripts/checks/gates-808.sh", "MISSING scripts/checks/check-classify.ts".
 * They are left detecting because their `label` is the correct basename, so
 * the click opens the right file; and because NO structural rule separates
 * them from "AI OS/Operator Log.md", which is the vault reference this whole
 * feature exists for. The remaining cost is cosmetic — the underline covers
 * the whole span — and that belongs to whoever renders the pill.
 */

/** The file roots the API exposes (GET /api/files/roots). */
export type RootKey =
  | "vault"
  | "workspace"
  | "uploads"
  | "media"
  | "aios"
  | "forge-src"
  | "memory";

/**
 * Absolute-path prefixes that map onto a root. ORDER MATTERS — longest first.
 * `/opt/ai-os/workspace/` and `/opt/ai-os/uploads/` are inside `/opt/ai-os/`
 * and have roots of their own, so the broad `aios` entry has to come last or
 * it would swallow both.
 *
 * `memory` (D6) is the fleet knowledge base every agent cites and nothing
 * could reach: it sits outside every other root. It is a dedicated READ-ONLY
 * root on the server — the decision was to make the pill real rather than
 * leave a dead affordance on the most-cited directory in the fleet. The
 * dot-segment guard in routes/files.ts inspects only the root-RELATIVE path,
 * so a root whose own directory contains `.claude` is fine (PLAN.md finding 7).
 */
const ROOT_PREFIXES: ReadonlyArray<readonly [string, RootKey]> = [
  ["/root/.claude/projects/-opt-forge-ai-os/memory/", "memory"],
  ["/opt/obsidian-vault/", "vault"],
  ["/opt/ai-os/workspace/", "workspace"],
  ["/opt/ai-os/uploads/", "uploads"],
  ["/opt/content-forge/media/", "media"],
  ["/opt/forge-ai-os/", "forge-src"],
  ["/opt/ai-os/", "aios"],
];

/**
 * Extensions we are willing to treat as "this is a file, not prose".
 * Kept to what the /document viewer can actually render or download, so a hit
 * always leads somewhere useful.
 */
const OPENABLE_EXT =
  /\.(md|txt|json|csv|ya?ml|log|ts|tsx|js|jsx|py|sh|sql|css|html|png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|m4a|pdf)$/i;

/** `foo.ts:715:3` — path, line, column. Lazy on the path so the FIRST numeric
 *  pair after the name wins; a greedy `.+` reads `a.ts:715:3` as line 3. */
const LINE_COL_SUFFIX = /^(.+?):(\d{1,9}):(\d{1,9})$/;
/** `foo.ts:715` — path, line. */
const LINE_SUFFIX = /^(.+?):(\d{1,9})$/;

/** `https://…`, `file://…`, and the same thing inside markdown image syntax
 *  (`![x](http://host/beacon.png)`, seen in the corpus sweep below). A URL is
 *  the browser's business, and `https://x/y.md:1` would otherwise survive the
 *  line-suffix strip and read as a searchable name. Matched ANYWHERE, not
 *  anchored: the live false positive had the scheme in the middle. */
const URL_SCHEME = /:\/\//;

/** Short-format `git status` output, which agents paste constantly:
 *  " M README.md", "?? docs/plan/". The path is real but the status column is
 *  not part of it, so the reference would search for the wrong name. */
const GIT_STATUS_CODE = /^[MADRCU!?]{1,2}$/;

export type PathTarget =
  /** Fully resolved: open /document straight away. */
  | {
      kind: "exact";
      root: RootKey;
      path: string;
      label: string;
      /** 1-based line from a `path:LINE` reference. Column is parsed and
       *  discarded — the viewer scrolls to a line, not to a character. */
      line?: number;
      /** The reference named a directory (trailing `/`): list it, don't
       *  preview it. For a root's own top directory `path` is "". */
      isDir?: boolean;
    }
  /** A bare or unrooted name — ask /files/search to place it on click. */
  | { kind: "search"; query: string; label: string; line?: number; isDir?: boolean };

/** What `[[…]]` between the brackets resolved to. `path` is non-null only when
 *  the link was written path-qualified (`[[Dir/Sub/Note]]`); `name` is always
 *  the basename, which is what a filename search can match. */
export interface WikilinkTarget {
  name: string;
  anchor: string | null;
  alias: string | null;
  path: string | null;
}

/**
 * Pull the text out of a react-markdown `code` child, which is a string, an
 * array of strings, or (for anything richer) something we decline to inspect.
 */
export function codeText(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) {
    return children.join("");
  }
  return "";
}

/**
 * Split a trailing `:LINE` / `:LINE:COL` off a reference.
 *
 * Returns `line: null` when there is no suffix, and `malformed: true` when
 * there is one that cannot be a line number (`:0` — lines are 1-based). A
 * malformed reference is rejected outright rather than opened at the top of
 * the file: silently dropping the part of the reference the author cared
 * about is the kind of quiet wrong answer this file exists to avoid.
 */
function splitLineSuffix(text: string): {
  base: string;
  line: number | null;
  malformed: boolean;
} {
  const m = LINE_COL_SUFFIX.exec(text) ?? LINE_SUFFIX.exec(text);
  if (!m) return { base: text, line: null, malformed: false };
  const line = Number(m[2]);
  if (!Number.isInteger(line) || line < 1) {
    return { base: m[1], line: null, malformed: true };
  }
  return { base: m[1], line, malformed: false };
}

export function detectPath(raw: string): PathTarget | null {
  const text = raw.trim();
  // Bounds: a path is not a paragraph, and not a single character.
  if (text.length < 3 || text.length > 300) return null;
  // A span with whitespace *can* still be a path ("AI OS/Operator Log.md"),
  // but one with newlines, shell metacharacters, a brace glob
  // (`frozen-live-t{0,1}-dark.png`), markdown link brackets or a shell
  // assignment (`F=src/lib/fixtures/x.json`) is not a name. Every character
  // added here killed a false positive found in the corpus sweep.
  if (/[\n\r|;&$<>*?"'`{}[\]=]/.test(text)) return null;
  // Commands frequently end in a flag or contain " -" — never a file.
  if (/\s-{1,2}\w/.test(text)) return null;
  if (URL_SCHEME.test(text)) return null;

  const cleaned = stripProsePunctuation(text);
  if (cleaned.length < 3) return null;

  const tokens = cleaned.split(/\s+/);
  // A token starting with "." is an extension, not a name: the live page marked
  // `.txt` and `.md .txt .json .csv` openable (PLAN.md finding 6). This also
  // costs us "./src/foo.ts" — deliberate, the dotless form detects the same
  // file and a dead pill is the more expensive mistake. "-" is a flag
  // (`--help.ts`, `-v docs/`) and "@" is an npm scope (`@excalidraw/…/index.css`)
  // or a Next.js parallel-route segment — neither is a file on disk.
  if (tokens.some((t) => t.startsWith(".") || t.startsWith("-") || t.startsWith("@"))) {
    return null;
  }
  if (tokens.length > 1) {
    // " M README.md" — the status column is not part of the path.
    if (GIT_STATUS_CODE.test(tokens[0])) return null;
    // A spaced path carries its root on the FIRST token
    // ("/opt/obsidian-vault/AI OS/Operator Log.md"). A later token starting
    // with "/" means the words before it are prose: "GET /api/files/vault/".
    if (tokens.slice(1).some((t) => t.startsWith("/"))) return null;
  }
  // Two filenames separated by a space are a LIST ("a.md b.md",
  // "HANDOFF.md, WORKLOG.md"), not a path. Strip each token's own trailing
  // prose punctuation first or the comma hides the second filename.
  if (tokens.filter((t) => OPENABLE_EXT.test(stripProsePunctuation(t))).length > 1) {
    return null;
  }

  // The line suffix comes off BEFORE the extension test: "MessageMarkdown.tsx"
  // is openable, "MessageMarkdown.tsx:160" ends in ":160" and is not.
  const { base, line, malformed } = splitLineSuffix(cleaned);
  if (malformed) return null;

  const isDir = base.endsWith("/");
  // "src/:12" — a directory has no line. Malformed, so no affordance.
  if (isDir && line !== null) return null;

  const bare = isDir ? base.slice(0, -1) : base;
  if (!bare) return null; // bare "/"

  const label = bare.split("/").pop() ?? "";
  // Non-empty stem: ".env" / "notes/.hidden.md" are dotfiles, and a reference
  // whose basename is only an extension is prose about a file type.
  if (!label || label.startsWith(".")) return null;
  // A directory reference carries no extension requirement — that is the whole
  // point of the trailing slash. A file reference still needs one.
  if (!isDir && !OPENABLE_EXT.test(bare)) return null;

  for (const [prefix, root] of ROOT_PREFIXES) {
    // Match the trailing-slash form for directories so that a reference to a
    // root's OWN directory ("/root/.claude/projects/-opt-forge-ai-os/memory/")
    // still lands, with path "".
    if (base.startsWith(prefix)) {
      const rel = stripTrailingSlash(base.slice(prefix.length));
      // Mirror the server contract exactly: resolveInRoot (files.ts:118)
      // rejects EVERY root-relative segment beginning with a dot, not just
      // ".." — so "/opt/ai-os/.secrets/store/" and
      // "/opt/obsidian-vault/.obsidian/plugins/" are a guaranteed 400 and must
      // not be offered as a click. Note the guard reads the root-RELATIVE path
      // only, which is why `memory` can live under /root/.claude/ at all.
      if (rel.split("/").some((seg) => seg.startsWith("."))) return null;
      if (!isDir && !rel) return null;
      return {
        kind: "exact",
        root,
        path: rel,
        label,
        ...(line !== null ? { line } : null),
        ...(isDir ? { isDir: true } : null),
      };
    }
  }

  // Any other absolute path is outside every configured root. The API would
  // refuse it, so do not offer a click that is guaranteed to fail.
  if (bare.startsWith("/")) return null;

  // A relative DIRECTORY has no extension to vouch for it, so it must be a
  // single word: "Mentor/Profile/" yes, "GET www.perplexity.ai/" no. Every
  // multi-token trailing-slash reference in the corpus sweep was prose. The
  // cost is a spaced relative folder ("AI OS/Specs/") — cite it absolutely,
  // or as a file inside it.
  if (isDir && tokens.length > 1) return null;

  // Same dot-segment contract as the rooted branch, one level up: an interior
  // "..", "." or "..." segment ("Daily/../../x.md",
  // "docs/plan/artifacts/.../phase3/gate-verdict.md") is a traversal probe or
  // an elision, never a path a search can place.
  if (bare.split("/").some((seg) => seg.startsWith("."))) return null;

  // Relative: could be vault-relative ("AI OS/Operator Log.md"), a bare name
  // ("OPEN-QUESTIONS.md"), a repo path, or a folder ("Mentor/Profile/").
  // Resolve it on click via search.
  return {
    kind: "search",
    query: bare,
    label,
    ...(line !== null ? { line } : null),
    ...(isDir ? { isDir: true } : null),
  };
}

function stripTrailingSlash(rel: string): string {
  return rel.endsWith("/") ? rel.slice(0, -1) : rel;
}

/**
 * Trailing punctuation the author meant as prose, not as part of the name:
 * "README.md," / "executor.ts:715)" / "docs/plan/03-quality.md.". A trailing
 * "/" is NOT punctuation here — it is the directory marker (D5).
 */
function stripProsePunctuation(text: string): string {
  return text.replace(/[),.;:]+$/, "");
}

/**
 * Parse the text BETWEEN `[[` and `]]` (D2). Konrad's vault runs on wikilinks
 * and agents write them; they are not clickable at all today.
 *
 * Mirrors the normalisation precedent of `normaliseWikilinkTarget()` in
 * forge-control/src/db/memory.ts — split at the first `#`, drop trailing
 * backslashes, trim — WITHOUT importing server code into the browser bundle,
 * and without lowercasing: the caller needs the author's casing for the label
 * and for a filename search. Measured on the live vault, 41 of 636 stored
 * links carry one of these artefacts; a naive parser calls all 41 broken.
 *
 * The trailing backslash is the table-cell escape: inside a markdown table an
 * aliased link must be written `[[Target\|Alias]]` or the pipe is read as a
 * cell separator (memory: wikilink-table-escape-reads-as-dangling).
 *
 * Returns null for anything that cannot be a note reference — empty,
 * whitespace-only, or carrying a bracket / angle bracket / newline, which
 * would mean the `[[…]]` scan mis-framed the link.
 */
export function parseWikilink(inner: string): WikilinkTarget | null {
  if (inner.length === 0 || inner.length > 300) return null;
  if (/[[\]\n\r<>]/.test(inner)) return null;

  const pipe = inner.indexOf("|");
  const targetRaw = (pipe === -1 ? inner : inner.slice(0, pipe)).replace(/\\+$/, "");
  const aliasRaw = pipe === -1 ? "" : inner.slice(pipe + 1);

  const hash = targetRaw.indexOf("#");
  const ref = (hash === -1 ? targetRaw : targetRaw.slice(0, hash)).trim();
  const anchorRaw = hash === -1 ? "" : targetRaw.slice(hash + 1);
  // "" ⇐ empty, whitespace-only, or a bare "[[#Heading]]", which is a link
  // into the note's own body and names no file.
  if (!ref) return null;

  const slash = ref.lastIndexOf("/");
  const name = slash === -1 ? ref : ref.slice(slash + 1).trim();
  // "Dir/" — path-qualified with no note at the end of it.
  if (!name) return null;

  return {
    name,
    anchor: anchorRaw.trim() || null,
    alias: aliasRaw.trim() || null,
    path: slash === -1 ? null : ref,
  };
}

/**
 * Link into the full-window viewer. `line` is appended only when given; an
 * out-of-range line is a caller bug and throws rather than quietly producing
 * a link that scrolls nowhere.
 */
export function documentHref(root: string, path: string, line?: number): string {
  const href = `/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  if (line === undefined) return href;
  if (!Number.isInteger(line) || line < 1) {
    throw new RangeError(
      `documentHref: line must be a 1-based integer, got ${JSON.stringify(line)} (root=${root} path=${path})`,
    );
  }
  return `${href}&line=${line}`;
}
