/**
 * Obsidian vault reader/writer — the OS's WRITE path into the second brain.
 *
 * THE UNDO CONTRACT (02-architecture.md §1.2).
 *
 * This module used to promise append-or-create only: "can never delete or
 * truncate a note". Editing a note necessarily gives that up. What replaces
 * it is an operational guarantee of the same strength:
 *
 *      NO CONTENT THIS MODULE EVER REMOVES IS UNRECOVERABLE.
 *
 * Three mechanisms enforce it. All three are mandatory; none is optional,
 * best-effort, or skippable for large notes:
 *
 *  1. SNAPSHOT-BEFORE-WRITE, AND THE SNAPSHOT IS LOAD-BEARING. writeVaultFile()
 *     copies the current bytes to VAULT_SNAPSHOT_DIR (default
 *     /opt/ai-os/vault-snapshots) before the new bytes land, reads them back,
 *     and throws if anything about that failed — with the note untouched (R5).
 *     A best-effort backup is a hope with a directory.
 *  2. EMPTY AND WHITESPACE-ONLY BODIES ARE REFUSED (R7). The realistic
 *     catastrophe is not a malicious delete; it is a UI bug or an agent
 *     serialising `undefined`, sending "", and erasing a year of thinking.
 *  3. THERE IS NO DELETE VERB. Not disabled — absent (R8). Nothing here
 *     removes, renames or moves a note. The one fs.rename() is the atomic
 *     temp-file swap inside writeVaultFile(), and it only ever moves a
 *     freshly written temp file ONTO a destination.
 *
 * Snapshots live OUTSIDE the vault deliberately: resolveInVault() rejects dot
 * segments, so an in-vault ".forge-backups/" would be unreachable by this
 * module's own guard, and a non-dot folder would show up in Obsidian's file
 * tree, search, graph and in syncVaultNotes()'s scan. Backups that pollute
 * the thing they protect are not backups.
 *
 * Editing is compare-and-swap on the sha256 of the CONTENT, never on mtime:
 * LiveSync touches mtimes without changing content, and false conflicts train
 * the operator to click through real ones. Creation keeps its own verb —
 * writeVaultFile() refuses a path that does not exist, because a
 * compare-and-swap against a missing file has no base to swap against.
 *
 * Other design constraints, unchanged:
 *  - Every path is resolved inside OBSIDIAN_VAULT_DIR and rejected on
 *    traversal. Dotfiles (.obsidian etc.) are off-limits.
 *  - Only *.md is readable or writable through the new verbs (R10).
 *  - Daily notes live in VAULT_DAILY_DIR (default "Daily/") named
 *    YYYY-MM-DD.md in VAULT_TZ (Berlin) — matching Obsidian's daily-notes
 *    convention. Quick captures land in VAULT_INBOX_DIR (default "Inbox/").
 *
 * LiveSync (or whatever sync layer is active) propagates writes to
 * Konrad's devices — this module only touches the filesystem.
 */

import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const DAILY_DIR = process.env.VAULT_DAILY_DIR ?? "Daily";
const INBOX_DIR = process.env.VAULT_INBOX_DIR ?? "Inbox";
const TZ = process.env.REMINDER_TZ ?? "Europe/Berlin";

export type DailySection = "Tasks" | "Notes" | "Journal";

const DAILY_TEMPLATE = (date: string) =>
  `# ${date}\n\n## Tasks\n\n## Notes\n\n## Journal\n`;

/** Resolve a vault-relative path, throwing on traversal or dotfiles. */
function resolveInVault(rel: string): string {
  const cleaned = rel.replace(/\\/g, "/");
  if (cleaned.split("/").some((seg) => seg.startsWith(".") && seg !== "")) {
    throw new Error(`vault path may not contain dot segments: ${rel}`);
  }
  const abs = path.resolve(VAULT_DIR, cleaned);
  const root = path.resolve(VAULT_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`vault path escapes the vault: ${rel}`);
  }
  return abs;
}

function nowParts(): { date: string; time: string } {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("de-DE", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return { date, time };
}

/** Sanitize a note title into a filename Obsidian accepts. */
function slugTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "Untitled";
}

/** Insert `line` at the end of `## section` in `content`; if the section
 *  is missing, append it. Never removes existing content. */
function appendUnderSection(
  content: string,
  section: DailySection,
  line: string,
): string {
  const lines = content.split("\n");
  const headerIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase(),
  );
  if (headerIdx === -1) {
    const base = content.endsWith("\n") ? content : content + "\n";
    return `${base}\n## ${section}\n${line}\n`;
  }
  // Find end of this section = next '## ' heading or EOF.
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Insert before trailing blank lines of the section so entries stay tight.
  let insertAt = end;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

export interface VaultWriteResult {
  /** Vault-relative path of the touched note. */
  path: string;
  created: boolean;
}

/** Append a timestamped line to today's daily note under a section.
 *  `prefix` defaults to "- " (bullet); pass "- [ ] " for tasks. */
export async function appendToDailyNote(input: {
  section: DailySection;
  text: string;
  prefix?: string;
}): Promise<VaultWriteResult> {
  const text = input.text.trim();
  if (!text) throw new Error("text required");
  const { date, time } = nowParts();
  const rel = `${DAILY_DIR}/${date}.md`;
  const abs = resolveInVault(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  let content: string;
  let created = false;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    content = DAILY_TEMPLATE(date);
    created = true;
  }
  const prefix = input.prefix ?? "- ";
  const line = `${prefix}${time} — ${text.replace(/\n+/g, " ")}`;
  const next = appendUnderSection(content, input.section, line);
  await fs.writeFile(abs, next, "utf8");
  return { path: rel, created };
}

/** Create a new note (never overwrites — collision appends " 2", " 3"…). */
export async function createNote(input: {
  title: string;
  content?: string;
  folder?: string;
}): Promise<VaultWriteResult> {
  const folder = input.folder?.trim() || INBOX_DIR;
  const base = slugTitle(input.title);
  const { date, time } = nowParts();

  await fs.mkdir(resolveInVault(folder), { recursive: true });

  for (let n = 0; n < 50; n++) {
    const name = n === 0 ? base : `${base} ${n + 1}`;
    const rel = `${folder}/${name}.md`;
    const abs = resolveInVault(rel);
    const body =
      (input.content?.trim() ? input.content.trim() + "\n" : "") +
      `\n---\ncaptured: ${date} ${time}\nsource: ai-os\n`;
    try {
      await fs.writeFile(abs, `# ${name}\n\n${body}`, { flag: "wx" });
      return { path: rel, created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not find a free filename for "${base}"`);
}

/** Read today's daily note (for the mobile Capture preview). */
export async function readDailyNote(): Promise<{
  path: string;
  date: string;
  content: string | null;
}> {
  const { date } = nowParts();
  const rel = `${DAILY_DIR}/${date}.md`;
  try {
    const content = await fs.readFile(resolveInVault(rel), "utf8");
    return { path: rel, date, content };
  } catch {
    return { path: rel, date, content: null };
  }
}

// ---------------------------------------------------------------------------
// The edit path (02-architecture.md §1.2). Everything below is additive; the
// three verbs above are untouched.
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR_DEFAULT = "/opt/ai-os/vault-snapshots";

/** A lowercase-hex sha256, and nothing else, is a valid compare-and-swap base. */
const BASE_SHA256 = /^[0-9a-f]{64}$/;

/** Refused before anything was touched — the route layer maps this to 400. */
export class VaultRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "VaultRefusedError";
    this.reason = reason;
  }
}

/** The note changed on disk since the caller read it — route layer maps to 409.
 *  The current content travels with the error so the UI can show a diff (R3). */
export class VaultConflictError extends Error {
  readonly currentSha256: string;
  readonly currentContent: string;
  constructor(input: { currentSha256: string; currentContent: string }) {
    super(
      `vault note changed on disk since it was read (current sha256 ${input.currentSha256})`,
    );
    this.name = "VaultConflictError";
    this.currentSha256 = input.currentSha256;
    this.currentContent = input.currentContent;
  }
}

/** sha256 of the exact utf8 bytes — must equal `sha256sum` of the file (R1). */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** resolveInVault() with the refusal typed, plus the .md restriction (R10).
 *  The guard itself is REUSED, never reimplemented — two guards drift (R9). */
function resolveOrRefuse(rel: string): string {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw new VaultRefusedError("path required");
  }
  let abs: string;
  try {
    abs = resolveInVault(rel);
  } catch (e) {
    throw new VaultRefusedError(e instanceof Error ? e.message : String(e));
  }
  if (!abs.toLowerCase().endsWith(".md")) {
    throw new VaultRefusedError(
      `only .md notes are readable and writable through this API: ${rel}`,
    );
  }
  return abs;
}

/** Canonical vault-relative path (forward slashes) for an absolute one. */
function vaultRelative(abs: string): string {
  return path
    .relative(path.resolve(VAULT_DIR), abs)
    .split(path.sep)
    .join("/");
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Read a note exactly as it sits on disk. No trim, no newline normalisation,
 *  no re-encoding — the sha256 must match `sha256sum` of the file (R1).
 *  ENOENT propagates: a missing note is a 404 at the route layer, not a refusal. */
export async function readVaultFile(rel: string): Promise<{
  path: string;
  content: string;
  sha256: string;
  mtimeMs: number;
  bytes: number;
}> {
  const abs = resolveOrRefuse(rel);
  const content = await fs.readFile(abs, "utf8");
  const stat = await fs.stat(abs);
  return {
    path: vaultRelative(abs),
    content,
    sha256: sha256(content),
    mtimeMs: stat.mtimeMs,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

/** Copy the PRE-write bytes out of the vault before anything is overwritten.
 *  Load-bearing: any failure throws and the note is never touched (R5).
 *  The store is read from the environment HERE, at call time, so a test can
 *  redirect it without reloading the module. */
async function snapshotBeforeWrite(rel: string, current: string): Promise<string> {
  const root = process.env.VAULT_SNAPSHOT_DIR ?? SNAPSHOT_DIR_DEFAULT;
  const { date } = nowParts();
  const dir = path.join(root, date);
  const abs = path.join(dir, `${rel.split("/").join("__")}.${Date.now()}.md`);
  try {
    await fs.mkdir(dir, { recursive: true });
    // "wx": a snapshot never overwrites another snapshot, not even one taken
    // in the same millisecond. Losing a snapshot is losing the undo.
    await fs.writeFile(abs, current, { encoding: "utf8", flag: "wx" });
    const landed = await fs.readFile(abs, "utf8");
    if (landed !== current) {
      throw new Error(
        `snapshot holds ${Buffer.byteLength(landed, "utf8")} bytes, the note held ` +
          `${Buffer.byteLength(current, "utf8")}`,
      );
    }
  } catch (e) {
    throw new Error(
      `vault snapshot failed for ${rel} at ${abs} — THE NOTE WAS NOT WRITTEN: ${describe(e)}`,
      { cause: e },
    );
  }
  return abs;
}

/** Edit an existing note under compare-and-swap. The order is not negotiable:
 *  refuse the path, refuse an empty body, refuse a missing/malformed base,
 *  compare, snapshot, then write atomically. Nothing before the rename can
 *  leave the note in a different state than it started. */
export async function writeVaultFile(input: {
  path: string;
  content: string;
  baseSha256: string;
}): Promise<{ path: string; sha256: string; bytes: number; snapshot: string }> {
  // 1. Path: traversal, dot segments, non-.md.
  const abs = resolveOrRefuse(input.path);
  const rel = vaultRelative(abs);

  // 2. Body: the accident the append-only contract existed to prevent (R7).
  //    Typed as unknown first so a non-string from an untyped caller is refused
  //    explicitly rather than stringified into the note.
  const content: unknown = input.content;
  if (typeof content !== "string") {
    throw new VaultRefusedError(
      `empty content refused: content must be a string, received ${content === null ? "null" : typeof content}`,
    );
  }
  if (content === "" || /^\s*$/.test(content)) {
    throw new VaultRefusedError(
      `empty content refused: a ${content.length === 0 ? "zero-length" : "whitespace-only"} body would erase ${rel}`,
    );
  }

  // 3. Base: a PUT with no base is never a compare-and-swap (R2).
  const base: unknown = input.baseSha256;
  if (typeof base !== "string" || !BASE_SHA256.test(base)) {
    throw new VaultRefusedError(
      `base_sha256 required as 64 lowercase hex characters, received ` +
        `${JSON.stringify(input.baseSha256)} — a write with no base can never be a compare-and-swap`,
    );
  }

  // 4. Current bytes. Creation already has its own verb.
  let current: string;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VaultRefusedError(
        `note does not exist — create it with POST /api/vault/note: ${rel}`,
      );
    }
    throw e;
  }

  // 5. Compare-and-swap on content, NEVER on mtime.
  const currentSha256 = sha256(current);
  if (currentSha256 !== base) {
    throw new VaultConflictError({ currentSha256, currentContent: current });
  }

  // 6. Snapshot the pre-write bytes. Throws => nothing is written.
  const snapshot = await snapshotBeforeWrite(rel, current);

  // 7. Temp file IN THE SAME DIRECTORY (a cross-device rename fails), fsync,
  //    close, rename over the destination (R6). No path writes `abs` directly.
  const tmpAbs = `${abs}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await fs.open(tmpAbs, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpAbs, abs);
  } catch (e) {
    try {
      await fs.rm(tmpAbs, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `vault write of ${rel} failed (${describe(e)}) AND its temp file ${tmpAbs} ` +
          `could not be cleaned up (${describe(cleanupError)}). The note itself is ` +
          `unchanged; the snapshot of its current bytes is at ${snapshot}.`,
        { cause: e },
      );
    }
    throw e;
  }

  return {
    path: rel,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
    snapshot,
  };
}

/** The vault name Obsidian matches on: configuration, never a guess (R19).
 *  Read at call time so it can be changed without a restart of anything. */
export function vaultName(): string {
  return (
    process.env.OBSIDIAN_VAULT_NAME ??
    path.basename(process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault")
  );
}

/** obsidian://open?vault=<enc>&file=<enc> — encodeURIComponent on EACH
 *  component (R18, scout S-B §3). Never encodeURI on the assembled string: it
 *  leaves "&" intact, and a literal "&" does not merely open the wrong note,
 *  it terminates the file parameter at the query separator so Obsidian gets no
 *  file at all. The ".md" extension is KEPT (S-B §1): both forms work, and
 *  keeping it sidesteps the compound ".excalidraw.md" extension entirely. */
export function obsidianUri(input: {
  vaultName: string;
  vaultRelativePath: string;
}): string {
  if (typeof input.vaultName !== "string" || input.vaultName === "") {
    throw new VaultRefusedError(
      "obsidianUri needs a vault name — an empty vault= silently opens nothing",
    );
  }
  if (typeof input.vaultRelativePath !== "string" || input.vaultRelativePath === "") {
    throw new VaultRefusedError(
      "obsidianUri needs a vault-relative path — an empty file= silently opens nothing",
    );
  }
  return (
    `obsidian://open?vault=${encodeURIComponent(input.vaultName)}` +
    `&file=${encodeURIComponent(input.vaultRelativePath)}`
  );
}
