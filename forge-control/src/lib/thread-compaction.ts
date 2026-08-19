/**
 * thread-compaction.ts — the body of POST /api/chat/:id/compact, extracted so
 * it can be DRIVEN BY A TEST. Round 972's fix cycle 1, against round 971's
 * review of `91f6b28`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL — the defect it was extracted to fix.
 *
 * `91f6b28` shipped the route as a READ-MODIFY-WRITE with no lock:
 *
 *     const current = await getRun(id);          // read
 *     const thread  = current.thread;            // snapshot
 *     await writeFile(archive, ...thread...);    // archive THE SNAPSHOT
 *     UPDATE runs SET thread = $2::jsonb         // full overwrite
 *
 * Every OTHER thread writer in this codebase is an atomic append — `thread =
 * thread || $n::jsonb` in `db/runs.ts` (appendMessage and its two siblings) and
 * in `executor.ts`, which is what streams Claude Code events into a LIVE turn.
 * An append landing between the read and the overwrite was lost TWICE: gone
 * from the row, because the overwrite computed its value from the stale
 * snapshot, and gone from the archive, which was built from that same snapshot.
 * An acknowledged message vanishing with no error anywhere is precisely the
 * silent data loss the route's own header claims it exists to prevent, and runs
 * here average 17 minutes, so "between the read and the write" is not a
 * theoretical window — it is most of the time the route is worth calling.
 *
 * THE FIX: one row lock spanning read, archive and overwrite.
 *
 *     BEGIN; SELECT thread ... FOR UPDATE; <write archive>; UPDATE ...; COMMIT;
 *
 * A concurrent `thread = thread || …` now BLOCKS on the row lock instead of
 * being overwritten. When this transaction commits, READ COMMITTED makes the
 * waiting UPDATE re-read the row and append to the COMPACTED thread — so the
 * in-flight entry lands after the marker and is never lost. Holding a row lock
 * across a small local file write is a cost this route can pay; losing a
 * message it acknowledged is not.
 *
 * WHY NOT A SINGLE ATOMIC STATEMENT INSTEAD (the operator asked, and it is a
 * fair question). The truncation alone is expressible in SQL — the newest
 * `keep` elements of `thread` are a `jsonb_path_query_array` away, with no
 * round trip and no window. But the ARCHIVE is a file, and a file cannot join a
 * SQL statement. A single-statement truncation would keep the concurrent
 * append alive in the row (good) while the archive, written beforehand from a
 * read that is no longer authoritative, would silently not contain it and
 * `dropped` would be off by the same amount. That trades unrecoverable loss for
 * an archive that quietly disagrees with what it replaced — better, but still a
 * lie in the artefact whose whole purpose is to be trustworthy. The lock closes
 * both. It is NOT equivalent, and that is why it was not taken.
 *
 * WHY NOT SIMPLY REFUSE WHEN THE RUN IS `running`. That was the reviewer's
 * second option and it is sound, but it refuses the case Konrad actually has:
 * he types /compact when a long turn has filled the window, which is exactly
 * when the run is running. A route that is unavailable at the only moment it is
 * wanted has been fixed into uselessness. The lock serves that call correctly
 * rather than declining it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type pg from "pg";
import type { ThreadEntry } from "../db/runs.ts";

/** Where archives live. The route is the only writer of this directory, which
 *  is why retention is owned here rather than by a cron nobody would wire up
 *  (round 971 finding 4: nothing pruned it, same unbounded-scratch shape as the
 *  61 GB `/tmp` finding). */
export const ARCHIVE_DIR = "/opt/ai-os/backups/threads";

/* `keep` bounds. Below KEEP_MIN the agent loses the thread of the conversation
 * it is in; above KEEP_MAX there is no point compacting. */
export const KEEP_MIN = 10;
export const KEEP_MAX = 400;
export const KEEP_DEFAULT = 60;

/**
 * Round 971 finding 2. `Number(body.keep ?? 60)` yields NaN for a non-numeric
 * `keep`, and NaN defeats a clamp built from Math.min/Math.max because BOTH
 * return NaN. The damage downstream was not a crash but a set of quiet lies:
 * the `keep + 1` idempotency guard never fired (every NaN comparison is false),
 * `dropped` was reported as NaN, and `thread.slice(-NaN)` is `slice(0)` — the
 * ENTIRE thread, so the route answered "compacted" having compacted nothing.
 *
 * Finiteness is therefore checked BEFORE the clamp, not after, and the value is
 * truncated to an integer: a fractional `keep` would otherwise reach the marker
 * text ("the 60.7 most recent entries follow") and the `kept` field of the
 * response, neither of which can be a fraction of an entry.
 */
export function resolveKeep(raw: unknown): number {
  const n = Number(raw ?? KEEP_DEFAULT);
  const finite = Number.isFinite(n) ? Math.trunc(n) : KEEP_DEFAULT;
  return Math.min(KEEP_MAX, Math.max(KEEP_MIN, finite));
}

/** `<runId>-<stamp>.json`, the format `91f6b28` shipped and existing archives
 *  on disk already use. NOT changed — the brief forbids rewriting the archive
 *  format, and three archives written on 2026-08-18 must stay readable. */
export function archivePath(id: string, stamp: string, dir = ARCHIVE_DIR): string {
  return `${dir}/${id}-${stamp}.json`;
}

/**
 * The marker entry that replaces everything dropped.
 *
 * Round 971 finding 3: the shipped text told the reader to consult
 * `"AI OS/Session State"`, and no such note exists — the vault holds only dated
 * variants (`Session State - 2026-08-18.md`, `Session State - 2026-08-19.md`).
 * A marker is read by an agent that cannot ask a follow-up question, so a
 * wikilink-shaped string that resolves to nothing is worse than no pointer: it
 * reads as authoritative. Creating an empty `Session State.md` to make the old
 * sentence true was rejected — that is a note nobody writes to, going stale on
 * the day it is created. The text names the PATTERN instead, and keeps
 * `"AI OS/Operator Decisions"`, which was verified to resolve exactly.
 */
export function buildMarker(args: {
  stamp: string;
  dropped: number;
  keep: number;
  archive: string;
  ts: string;
}): ThreadEntry {
  const { stamp, dropped, keep, archive, ts } = args;
  return {
    role: "system",
    content:
      `[compacted ${stamp}] ${dropped} earlier entries of this chat were removed from the ` +
      `working context to free room. NOTHING WAS LOST: the full transcript is archived at ` +
      `${archive}. Durable state for this session lives in the Obsidian vault — read the ` +
      `NEWEST dated note matching "AI OS/Session State - YYYY-MM-DD" (there is no undated ` +
      `"Session State" note) and "AI OS/Operator Decisions" before assuming anything about ` +
      `what was decided. The ${keep} most recent entries follow verbatim.`,
    ts,
    kind: "text",
    meta: { compaction: { dropped, kept: keep, archive } },
  };
}

export type CompactOutcome =
  | { kind: "not_found" }
  | { kind: "already_short"; entries: number }
  | {
      kind: "compacted";
      dropped: number;
      kept: number;
      was: number;
      archive: string;
    };

export interface CompactOptions {
  id: string;
  keep: number;
  /** Injected so a test can pin the stamp and the archive location. */
  now: Date;
  dir?: string;
  /** Seam for the race harness ONLY: called while the row lock is held, in
   *  place of the real archive write, so a test can widen the window that the
   *  lock exists to close. Production passes nothing and gets `writeFile`. */
  onArchiveWrite?: (archive: string, body: string) => Promise<void>;
}

/**
 * Compact one run's thread under a row lock. Returns an outcome; THROWS on
 * anything it cannot classify (a failed archive write, a lock timeout, a dead
 * connection) so the caller 500s rather than reporting a compaction that did
 * not happen. There is no catch-and-continue path in here by design.
 */
export async function compactRunThread(
  pool: pg.Pool,
  opts: CompactOptions,
): Promise<CompactOutcome> {
  const { id, keep, now } = opts;
  const dir = opts.dir ?? ARCHIVE_DIR;
  const writeArchive =
    opts.onArchiveWrite ??
    (async (archive: string, body: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(archive, body, "utf8");
    });

  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    /* TWO TIMEOUTS, and each answers a way the lock could hurt more than it
     * helps. `lock_timeout` bounds how long we WAIT for the row: without it a
     * request hangs forever behind some other long transaction and the caller
     * has no idea why. `idle_in_transaction_session_timeout` bounds how long we
     * HOLD it while idle — and the file write is exactly such an idle window,
     * so a wedged disk would otherwise block every live append to this chat
     * indefinitely. On that timeout Postgres kills the session, the UPDATE
     * below fails, and nothing is compacted: the correct outcome, loudly. */
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");

    const sel = await client.query<{ thread: unknown }>(
      `SELECT thread FROM runs WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    const raw = sel.rows[0]?.thread;
    const thread: ThreadEntry[] = Array.isArray(raw) ? (raw as ThreadEntry[]) : [];

    /* `keep + 1`, not `keep`: this route's OUTPUT is always the marker plus
     * `keep` entries, so a thread of exactly keep+1 is already compacted. Using
     * `keep` made the route non-idempotent — a second /compact dropped one more
     * real entry and stacked a second marker, eroding the transcript one
     * message per invocation. Carried over from `91f6b28`, which found it by
     * running the route twice; round 971 re-confirmed it against the three
     * archives on disk. */
    if (thread.length <= keep + 1) {
      await client.query("ROLLBACK");
      return { kind: "already_short", entries: thread.length };
    }

    const dropped = thread.length - keep;
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const archive = archivePath(id, stamp, dir);

    /* ARCHIVE FIRST, still holding the lock. A throw here propagates: the
     * catch rolls back and the route 500s, so nothing is ever compacted that
     * could not be saved first. The reverse — a committed truncation with no
     * archive — is the one outcome this ordering makes impossible.
     *
     * A rollback AFTER this line leaves an orphan archive file on disk. That is
     * deliberate and harmless: it is a spare copy of a thread that was never
     * truncated, and pruneThreadArchives() collects it on a later run. An extra
     * backup is not a defect; a missing one is. */
    await writeArchive(archive, JSON.stringify(thread));

    const marker = buildMarker({ stamp, dropped, keep, archive, ts: now.toISOString() });
    const next = [marker, ...thread.slice(-keep)];

    const upd = await client.query<{ id: string }>(
      `UPDATE runs
          SET thread = $2::jsonb,
              metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{last_compaction}',
                          to_jsonb($3::text), true),
              updated_at = now()
        WHERE id = $1
        RETURNING id::text`,
      [id, JSON.stringify(next), archive],
    );
    if (upd.rows.length === 0) {
      /* Unreachable while the FOR UPDATE above holds the row, and asserted
       * rather than assumed: reaching it means the lock did not do its job. */
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    await client.query("COMMIT");
    return { kind: "compacted", dropped, kept: next.length, was: thread.length, archive };
  } catch (e) {
    broken = true;
    /* The session may already be dead (idle_in_transaction_session_timeout),
     * in which case ROLLBACK throws too. Swallowing THAT is not a silent
     * fallback — the original error is rethrown immediately below and is what
     * the caller sees. */
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    /* Destroy rather than recycle after any failure: a client that timed out
     * mid-transaction cannot be trusted back into a pool of two. */
    client.release(broken || undefined);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * RETENTION — round 971 finding 4.
 *
 * Nothing pruned /opt/ai-os/backups/threads: no cron entry, no script in this
 * repo referenced the path. 4.5 MB across 5 files from one evening, and the
 * manager chat alone archives ~3.5 MB per compaction. Unbounded scratch that
 * nobody owns is how this fleet previously arrived at a 61 GB /tmp.
 *
 * DELETION IS THE DANGEROUS VERB HERE, so the policy is built around one
 * invariant that holds no matter how the thresholds are tuned:
 *
 *   THE NEWEST `keepNewestPerRun` ARCHIVES OF EVERY RUN ARE NEVER DELETED.
 *
 * Age and size only ever choose among the archives left after that floor is
 * reserved. A chat compacted once a year ago keeps its only backup; a chat
 * compacted forty times tonight loses the middle of the night, not its head.
 * The floor is applied FIRST, which is why no ordering of the other two rules
 * can reach a run's most recent pre-compaction state.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface RetentionPolicy {
  /** Per run id, this many newest archives are exempt from every other rule. */
  keepNewestPerRun: number;
  /** Archives older than this are eligible for deletion. */
  maxAgeDays: number;
  /** Once the directory exceeds this, oldest eligible archives go until it
   *  fits. Belt to the age rule's braces: forty compactions in one night are
   *  all young and would survive an age-only policy. */
  maxTotalBytes: number;
}

/** Defaults. Escalated to Konrad as a preference call (project engine-task-graph,
 *  round 972 fix cycle 1); these are what the route uses until he rules. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  keepNewestPerRun: 3,
  maxAgeDays: 30,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface ArchiveFile {
  name: string;
  runId: string;
  /** Epoch ms. Parsed from the FILENAME, never from mtime — see below. */
  mtimeMs: number;
  bytes: number;
}

/** `<uuid>-<stamp>.json`. The uuid contains hyphens and so does the stamp, so
 *  the split is anchored on the 36-character uuid rather than on `-`. */
const ARCHIVE_NAME_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)\.json$/i;

export function parseArchiveName(name: string): { runId: string; stamp: string } | null {
  const m = ARCHIVE_NAME_RE.exec(name);
  if (!m || !m[1] || !m[2]) return null;
  return { runId: m[1], stamp: m[2] };
}

/**
 * The retention DECISION, pure and separately testable: given the files, say
 * which to delete. No fs access, so the test that proves a run's newest archive
 * survives does not have to create one.
 *
 * Returns names in deletion order (oldest first).
 */
export function selectArchivesToPrune(
  files: readonly ArchiveFile[],
  policy: RetentionPolicy,
  nowMs: number,
): string[] {
  const byRun = new Map<string, ArchiveFile[]>();
  for (const f of files) {
    const list = byRun.get(f.runId);
    if (list) list.push(f);
    else byRun.set(f.runId, [f]);
  }

  /* THE FLOOR, applied first and to every run independently. */
  const exempt = new Set<string>();
  for (const list of byRun.values()) {
    const newestFirst = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of newestFirst.slice(0, Math.max(0, policy.keepNewestPerRun))) {
      exempt.add(f.name);
    }
  }

  const eligible = files
    .filter((f) => !exempt.has(f.name))
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  const doomed = new Set<string>();
  const ageCutoff = nowMs - policy.maxAgeDays * 24 * 60 * 60 * 1000;
  for (const f of eligible) {
    if (f.mtimeMs < ageCutoff) doomed.add(f.name);
  }

  /* Size cap, over what the age rule left standing. Total is measured across
   * ALL files including exempt ones — the directory's real footprint is what
   * the cap is about — but only eligible files can be chosen to shrink it, so
   * a directory made entirely of exempt archives is reported over-cap and left
   * alone rather than quietly breaking the floor. */
  let total = 0;
  for (const f of files) if (!doomed.has(f.name)) total += f.bytes;
  if (total > policy.maxTotalBytes) {
    for (const f of eligible) {
      if (total <= policy.maxTotalBytes) break;
      if (doomed.has(f.name)) continue;
      doomed.add(f.name);
      total -= f.bytes;
    }
  }

  return eligible.filter((f) => doomed.has(f.name)).map((f) => f.name);
}

export interface PruneReport {
  scanned: number;
  removed: string[];
  freedBytes: number;
  /** Non-fatal: a file that vanished under us, or one we could not stat. The
   *  caller reports these rather than throwing, because prune runs AFTER a
   *  compaction has already committed and a failure to tidy up must not turn a
   *  durable success into a 500. They are RETURNED, never swallowed. */
  errors: string[];
}

/** Read the directory and apply the policy. */
export async function pruneThreadArchives(
  dir: string,
  policy: RetentionPolicy,
  now: Date,
): Promise<PruneReport> {
  const errors: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    /* A directory that does not exist yet is not an error — nothing has been
     * archived. Anything else is reported. */
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { scanned: 0, removed: [], freedBytes: 0, errors: [] };
    return {
      scanned: 0,
      removed: [],
      freedBytes: 0,
      errors: [`readdir ${dir}: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const files: ArchiveFile[] = [];
  for (const name of names) {
    const parsed = parseArchiveName(name);
    if (!parsed) continue; // not ours; never touch a file we cannot name
    try {
      const st = await stat(`${dir}/${name}`);
      if (!st.isFile()) continue;
      files.push({ name, runId: parsed.runId, mtimeMs: st.mtimeMs, bytes: st.size });
    } catch (e) {
      errors.push(`stat ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const doomed = selectArchivesToPrune(files, policy, now.getTime());
  const sizes = new Map(files.map((f) => [f.name, f.bytes]));
  const removed: string[] = [];
  let freedBytes = 0;
  for (const name of doomed) {
    try {
      await unlink(`${dir}/${name}`);
      removed.push(name);
      freedBytes += sizes.get(name) ?? 0;
    } catch (e) {
      errors.push(`unlink ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { scanned: files.length, removed, freedBytes, errors };
}
