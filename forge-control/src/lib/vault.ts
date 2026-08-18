/**
 * Obsidian vault reader/writer — the OS's WRITE path into the second brain.
 *
 * THE UNDO CONTRACT (02-architecture.md §1.2).
 *
 * This module used to promise append-or-create only: "can never delete or
 * truncate a note". Editing a note necessarily gives that up. What replaces
 * it is an operational guarantee of the same strength — stated with its exact
 * scope, because an over-broad safety claim is what the next agent trusts:
 *
 *      writeVaultFile() — the edit verb — REPLACES CONTENT, AND EVERY BYTE IT
 *      REPLACES IS RECOVERABLE FROM THE SNAPSHOT STORE.
 *
 *      appendToDailyNote(), createNote() and readDailyNote() REMOVE NOTHING AT
 *      ALL: createNote() only ever opens "wx", appendToDailyNote() only ever
 *      inserts a line into content it has already read in full, and a read that
 *      fails for any reason other than ENOENT now throws instead of pretending
 *      the note is absent. They take no snapshot because they replace nothing.
 *
 * What is NOT claimed, measured rather than assumed (R1-red, 2026-08-19):
 *  - A writer in ANOTHER process that lands between this module's compare and
 *    its rename is overwritten and appears in no snapshot. Accepted; see
 *    02-architecture.md §1.2. In-process concurrency is NOT in that window —
 *    it is serialised per path (see serialiseOnPath below).
 *  - The realpath containment check guards the two NEW verbs (readVaultFile,
 *    writeVaultFile). The three older verbs address fixed, configured
 *    directories and keep the lexical guard only.
 *  - The snapshot store has no retention policy. When it fills the filesystem
 *    every edit fails closed, which is the correct direction but is still an
 *    outage; retention is a later decision (02-architecture.md §1.2).
 *
 * Four mechanisms enforce the guarantee. All four are mandatory; none is
 * optional, best-effort, or skippable for large notes:
 *
 *  1. SNAPSHOT-BEFORE-WRITE, AND THE SNAPSHOT IS LOAD-BEARING. writeVaultFile()
 *     copies the current bytes to VAULT_SNAPSHOT_DIR (default
 *     /opt/ai-os/vault-snapshots) before the new bytes land, reads them back,
 *     and throws if anything about that failed — with the note untouched (R5).
 *     A best-effort backup is a hope with a directory.
 *  2. EMPTY, WHITESPACE-ONLY AND INVISIBLE BODIES ARE REFUSED (R7). The
 *     realistic catastrophe is not a malicious delete; it is a UI bug or an
 *     agent serialising `undefined`, sending "", and erasing a year of
 *     thinking. Zero-width characters count as invisible: a body of one U+200B
 *     is three bytes on disk and a blank note in Obsidian.
 *  3. NO DESTINATION IS EVER OPENED FOR TRUNCATION. Every write in this module
 *     goes through atomicWrite() — temp file in the same directory, fsync,
 *     rename — or through an "wx" create that cannot touch an existing file.
 *     A crash therefore leaves the old bytes or the new bytes, never a prefix
 *     of either (R6).
 *  4. THERE IS NO DELETE VERB. Not disabled — absent (R8). Nothing here
 *     removes, renames or moves a note. The one fs.rename() is the atomic
 *     temp-file swap inside atomicWrite(), and it only ever moves a freshly
 *     written temp file ONTO a destination. The only fs.rm() targets this
 *     module's own `<note>.tmp-<pid>-<hex>` scratch files, which are not notes.
 *
 * Snapshots live OUTSIDE the vault deliberately: resolveInVault() rejects dot
 * segments, so an in-vault ".forge-backups/" would be unreachable by this
 * module's own guard, and a non-dot folder would show up in Obsidian's file
 * tree, search, graph and in syncVaultNotes()'s scan. Backups that pollute
 * the thing they protect are not backups.
 *
 * The two NEW verbs additionally re-assert containment on the REAL path.
 * path.resolve() is lexical, so `ln -s /etc/hostname <vault>/leak.md` reads
 * outside the vault and `ln -s /tmp <vault>/escape` writes outside it — both
 * measured, both 200s, before this check existed (R9).
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

// ---------------------------------------------------------------------------
// Shared write primitives. EVERY verb in this module goes through atomicWrite()
// — the older three as well as the edit verb — because "the destination is
// never opened with O_TRUNC" is not a property of one function, it is a
// property of the module (R6).
// ---------------------------------------------------------------------------

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A crash between the temp-file open and the rename leaves an orphan
 *  `<note>.tmp-<pid>-<hex>` in the vault forever. It is not a note — the name
 *  does not end in .md, so syncVaultNotes() skips it and Obsidian never indexes
 *  it — but it costs disk and confuses whoever finds it. */
const TEMP_FILE_NAME = /\.tmp-\d+-[0-9a-f]{12}$/;

/** An hour. A write in flight in another process must never be swept, and the
 *  slowest write measured on a real note (200 MB) took 1.4 s. */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/** Remove this module's own orphaned scratch files from one directory. Returns
 *  how many went. Only files whose names match the exact shape atomicWrite()
 *  creates AND whose mtime is older than an hour are candidates: no note has
 *  ever matched, and neither can a temp file that another process is still
 *  writing. */
async function sweepOrphanTempFiles(dir: string): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !TEMP_FILE_NAME.test(entry.name)) continue;
    const candidate = path.join(dir, entry.name);
    const stat = await fs.stat(candidate);
    if (now - stat.mtimeMs < TEMP_FILE_MAX_AGE_MS) continue;
    await fs.rm(candidate, { force: true });
    removed++;
  }
  return removed;
}

/** Write `content` to `input.abs` WITHOUT EVER OPENING `input.abs`: a temp file
 *  in the same directory (a cross-device rename fails), fsync, close, rename
 *  over the destination (R6). fs.writeFile() on the destination would open it
 *  O_TRUNC, and a crash inside that window leaves a strict prefix of the note
 *  with nothing to restore from — measured at 40 000 048 bytes → 0 during a
 *  single appendToDailyNote() call before this existed.
 *
 *  `recovery` is the sentence appended when the temp file itself cannot be
 *  cleaned up, and it says where the caller's prior bytes can be found. */
async function atomicWrite(input: {
  abs: string;
  content: string;
  label: string;
  recovery: string;
}): Promise<void> {
  const tmpAbs = `${input.abs}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await fs.open(tmpAbs, "wx");
    try {
      await handle.writeFile(input.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpAbs, input.abs);
  } catch (e) {
    try {
      await fs.rm(tmpAbs, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `vault write of ${input.label} failed (${describe(e)}) AND its temp file ${tmpAbs} ` +
          `could not be cleaned up (${describe(cleanupError)}). ${input.recovery}`,
        { cause: e },
      );
    }
    throw e;
  }

  // Janitorial, and deliberately NOT part of the undo contract: the note is
  // already safely on disk by now, so a failure to tidy up must not be reported
  // to the caller as a failed write. It is not swallowed either — it is named
  // on the log with the directory it happened in (R20 is about returning
  // defaults for real failures, and this is neither).
  try {
    await sweepOrphanTempFiles(path.dirname(input.abs));
  } catch (e) {
    console.error(
      `[vault] wrote ${input.label} but could not sweep orphaned temp files in ` +
        `${path.dirname(input.abs)}: ${describe(e)}`,
    );
  }
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
  } catch (e) {
    // ENOENT ONLY. A bare catch here read every failure as "no note today" and
    // then wrote the empty template over the note that was sitting right there,
    // returning {ok:true, created:true} — measured at 4 245 bytes → 76, with no
    // snapshot and nothing to restore from. EIO, EACCES, ENOMEM and
    // ERR_FS_FILE_TOO_LARGE all reach this line on a note that exists (R20).
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    content = DAILY_TEMPLATE(date);
    created = true;
  }
  const prefix = input.prefix ?? "- ";
  const line = `${prefix}${time} — ${text.replace(/\n+/g, " ")}`;
  const next = appendUnderSection(content, input.section, line);
  await atomicWrite({
    abs,
    content: next,
    label: rel,
    recovery: `The note itself is unchanged — this verb never opens it for writing.`,
  });
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
  } catch (e) {
    // `content: null` means ONE thing: today's note does not exist yet. A
    // transient EIO rendered as "no daily note today" is the read-side twin of
    // the defect fixed in appendToDailyNote above, and the Capture preview it
    // feeds is what Konrad checks before typing (R20).
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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

/** Walk up to the deepest ancestor of `abs` that exists, resolve THAT through
 *  every symlink, and re-append the segments below it lexically. A note that
 *  does not exist yet therefore still resolves — and the segments re-appended
 *  are already known to contain no dot segments, so re-appending them cannot
 *  itself escape anything. */
async function realpathDeepest(abs: string): Promise<string> {
  const below: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return below.length === 0 ? real : path.join(real, ...below);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`no existing ancestor of ${abs} could be resolved`);
      }
      below.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** resolveInVault() with the refusal typed, plus the .md restriction (R10),
 *  plus containment re-asserted on the REAL path (R9).
 *  The lexical guard itself is REUSED, never reimplemented — two guards
 *  drift — and the realpath check is layered on top of it, not instead of it:
 *  path.resolve() does not follow symlinks, so `ln -s /etc/hostname
 *  <vault>/leak.md` returned that file's contents at 200 and `ln -s /tmp
 *  <vault>/escape` let a PUT overwrite a file outside the vault. Both are
 *  reachable because /opt/obsidian-vault is written by LiveSync from Konrad's
 *  devices and by every agent on this box, and forge-control runs as root. */
async function resolveOrRefuse(rel: string): Promise<string> {
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

  // The vault root is resolved too: if OBSIDIAN_VAULT_DIR is itself a symlink,
  // comparing a real path against a lexical root refuses every legitimate note.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(VAULT_DIR);
  } catch (e) {
    throw new Error(
      `vault directory ${VAULT_DIR} could not be resolved: ${describe(e)}`,
      { cause: e },
    );
  }
  const real = await realpathDeepest(abs);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new VaultRefusedError(
      `vault path escapes the vault through a symlink: ${rel} resolves to ${real}, ` +
        `which is outside ${realRoot}`,
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
  const abs = await resolveOrRefuse(rel);
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
  // The random suffix is not decoration. The name used to be `<flat>.<ms>.md`
  // and the write below is "wx", so two edits to one note inside a single
  // millisecond collided and the SECOND — a perfectly valid edit — was refused
  // with a 500 the surface has no retry story for. Same device as the temp file
  // name in atomicWrite(), same reason.
  const abs = path.join(
    dir,
    `${rel.split("/").join("__")}.${Date.now()}-${randomBytes(4).toString("hex")}.md`,
  );
  try {
    await fs.mkdir(dir, { recursive: true });
    // "wx": a snapshot never overwrites another snapshot. Losing a snapshot is
    // losing the undo.
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

/** In-flight write chains, keyed on the RESOLVED absolute path.
 *
 *  02-architecture.md §1.2 used to reason from "single-process Node, so the
 *  read-compare-snapshot-write sequence is not interleaved with another request
 *  in this process". That premise was false: every step of the sequence is
 *  `await`ed, so two concurrent PUTs interleaved freely, both passed
 *  compare-and-swap against the same base, both snapshotted the same pre-state,
 *  and the second rename destroyed the first — which had already returned
 *  200 with a sha256 and appeared in no snapshot. Measured: 2 of 5 runs lost an
 *  acknowledged edit, the other 3 collided on the snapshot name and 500'd.
 *
 *  This is NOT the lock file §1.2 rejected: no on-disk state, therefore no
 *  stale-lock policy. It closes the in-process case completely and leaves the
 *  cross-process window exactly where §1.2 accepts it. */
const writeChains = new Map<string, Promise<unknown>>();

/** Run `work` after every write already queued for `abs`, and before every
 *  write queued after it. */
function serialiseOnPath<T>(abs: string, work: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(abs) ?? Promise.resolve();
  // .then(work, work) — the next writer runs whether its predecessor resolved
  // or rejected. A chain that only continues on success wedges the path for the
  // life of the process the first time a conflict is refused.
  const result = previous.then(work, work);
  // The tail the NEXT caller waits on must never reject: an unhandled rejection
  // on a promise nobody awaits takes the process down.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(abs, tail);
  void tail.then(() => {
    // Only the CURRENT tail may clear the entry. A later writer has already
    // replaced it and is still in flight.
    if (writeChains.get(abs) === tail) writeChains.delete(abs);
  });
  return result;
}

/** How many paths currently have a write chain. Zero when nothing is in
 *  flight — exported so a test can prove the Map is drained rather than
 *  growing by one entry per note edited for the life of the process. */
export function pendingVaultWrites(): number {
  return writeChains.size;
}

/** Characters that occupy no space on screen. A body of one U+200B passes
 *  `^\s*$` (JS `\s` does not cover it), lands as three bytes, and renders as a
 *  blank note in Obsidian — the exact accident R7 exists to refuse, wearing a
 *  costume. U+FEFF is included for completeness even though `\s` does cover it. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Edit an existing note under compare-and-swap. The order is not negotiable:
 *  refuse the path, refuse an empty body, refuse a missing/malformed base,
 *  compare, snapshot, then write atomically. Nothing before the rename can
 *  leave the note in a different state than it started.
 *
 *  Steps 4–7 run inside serialiseOnPath(), so two concurrent calls for one note
 *  are ordered rather than interleaved: the second re-reads what the first
 *  wrote and refuses with a VaultConflictError instead of destroying it. */
export async function writeVaultFile(input: {
  path: string;
  content: string;
  baseSha256: string;
}): Promise<{ path: string; sha256: string; bytes: number; snapshot: string }> {
  // 1. Path: traversal, dot segments, non-.md, symlink escape.
  const abs = await resolveOrRefuse(input.path);
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
  //    The blank test runs over a copy with the zero-width characters removed,
  //    so a body that is invisible on screen is refused like the blank body it
  //    renders as. The ORIGINAL string is what gets written when it passes —
  //    a zero-width joiner inside real prose is content, not whitespace.
  if (content === "" || /^\s*$/.test(content.replace(ZERO_WIDTH, ""))) {
    const kind =
      content.length === 0
        ? "zero-length"
        : /^\s*$/.test(content)
          ? "whitespace-only"
          : "zero-width-only (invisible)";
    throw new VaultRefusedError(
      `empty content refused: a ${kind} body would erase ${rel}`,
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

  // Steps 4–7 are ONE critical section per path. Everything above refuses
  // without touching the filesystem, so it stays outside the queue: a malformed
  // request must not wait behind a 200 MB write to the same note.
  return serialiseOnPath(abs, async () => {
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

    // 5. Compare-and-swap on content, NEVER on mtime. Because step 4 runs
    //    inside the queue, a concurrent writer's bytes are read HERE and this
    //    call conflicts on them, instead of both writers passing on the
    //    pre-state and the loser's acknowledged edit vanishing.
    const currentSha256 = sha256(current);
    if (currentSha256 !== base) {
      throw new VaultConflictError({ currentSha256, currentContent: current });
    }

    // 6. Snapshot the pre-write bytes. Throws => nothing is written.
    const snapshot = await snapshotBeforeWrite(rel, current);

    // 7. Temp file, fsync, rename over the destination (R6) — shared with the
    //    append verb, because the destination must never be opened O_TRUNC by
    //    any verb in this module.
    await atomicWrite({
      abs,
      content,
      label: rel,
      recovery:
        `The note itself is unchanged; the snapshot of its current bytes is at ${snapshot}.`,
    });

    return {
      path: rel,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
      snapshot,
    };
  });
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
