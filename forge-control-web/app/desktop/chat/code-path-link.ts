/**
 * Decide whether an inline `code` span in a message names a file Konrad can
 * open, and where that file lives.
 *
 * WHY: agents reference files constantly — `Mentor/Profile/OPEN-QUESTIONS.md`,
 * `AI OS/Operator Log.md`, `/opt/ai-os/scripts/guard-autonomy.py`. Reading one
 * meant leaving the chat, opening the file explorer, and hunting for it by
 * hand. Ctrl/Cmd-click on the blue pill now opens it in the /document viewer.
 *
 * DESIGN RULE — NO FALSE AFFORDANCES. Inline code is used for far more than
 * paths: rule ids (`spend.per_run_cap`), commands (`pnpm install`), env vars,
 * numbers. If this said "openable" for those, every one would be a dead click,
 * and an affordance that usually fails is worse than none. So the matcher is
 * deliberately narrow, and anything it cannot place inside a known file root
 * is left as a plain pill.
 */

/** The file roots the API exposes (GET /api/files/roots). */
export type RootKey =
  | "vault"
  | "workspace"
  | "uploads"
  | "media"
  | "aios"
  | "forge-src";

/**
 * Absolute-path prefixes that map onto a root. ORDER MATTERS — longest first.
 * `/opt/ai-os/workspace/` and `/opt/ai-os/uploads/` are inside `/opt/ai-os/`
 * and have roots of their own, so the broad `aios` entry has to come last or
 * it would swallow both.
 */
const ROOT_PREFIXES: ReadonlyArray<readonly [string, RootKey]> = [
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

export type PathTarget =
  /** Fully resolved: open /document straight away. */
  | { kind: "exact"; root: RootKey; path: string; label: string }
  /** A bare or unrooted name — ask /files/search to place it on click. */
  | { kind: "search"; query: string; label: string };

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

export function detectPath(raw: string): PathTarget | null {
  const text = raw.trim();
  // Bounds: a path is not a paragraph, and not a single character.
  if (text.length < 3 || text.length > 300) return null;
  // A span with whitespace *can* still be a path ("AI OS/Operator Log.md"),
  // but one with newlines or shell metacharacters is a command, not a name.
  if (/[\n\r|;&$<>*?"'`]/.test(text)) return null;
  // Commands frequently end in a flag or contain " -" — never a file.
  if (/\s-{1,2}\w/.test(text)) return null;
  if (!OPENABLE_EXT.test(text)) return null;

  // Trailing punctuation the author meant as prose, not as part of the name.
  const cleaned = text.replace(/[),.;:]+$/, "");
  if (!OPENABLE_EXT.test(cleaned)) return null;

  const label = cleaned.split("/").pop() || cleaned;

  for (const [prefix, root] of ROOT_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      const rel = cleaned.slice(prefix.length);
      if (!rel || rel.includes("..")) return null;
      return { kind: "exact", root, path: rel, label };
    }
  }

  // Any other absolute path is outside every configured root. The API would
  // refuse it, so do not offer a click that is guaranteed to fail.
  if (cleaned.startsWith("/")) return null;

  // Relative: could be vault-relative ("AI OS/Operator Log.md"), a bare name
  // ("OPEN-QUESTIONS.md"), or a repo path. Resolve it on click via search.
  return { kind: "search", query: cleaned, label };
}

export function documentHref(root: string, path: string): string {
  return `/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}
