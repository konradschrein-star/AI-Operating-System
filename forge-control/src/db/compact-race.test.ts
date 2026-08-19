/**
 * compact-race.test.ts — ROUND 971 FINDING 1, PROVED: can a live append be lost
 * across a /compact?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NOT PART OF `pnpm test`, AND MUST NEVER BE ADDED TO IT.
 *
 * `pnpm test` is `tsx --test src/lib/*.test.ts`: hermetic, no database. The
 * subject here is a ROW LOCK, and a row lock has no behaviour outside a real
 * Postgres with two real sessions contending for a real row. A single-threaded
 * assertion that claimed to prove a race would be the self-certifying
 * instrument the standing rules put first. So this sits beside
 * `src/db/projects.test.ts`, outside the unit glob, deliberately — and it
 * follows that file's conventions exactly: scratch-database guard, per-process
 * schema, counted assertions, its own exit arithmetic.
 *
 * It is not a `node:test` file for the same reason projects.test.ts is not: it
 * opens pg Pools it must close on its own terms, and an instrument that can
 * report the wrong exit code is worse than no instrument.
 *
 * HOW TO RUN:
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_r972_compact'
 *   SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_r972_compact" \
 *     ./node_modules/.bin/tsx src/db/compact-race.test.ts
 *
 * Exit 0 = every assertion passed AND every assertion ran.
 *
 * ---------------------------------------------------------------------------
 * THE SCENARIO, and why it is the one that matters.
 *
 * A run's thread is appended to by `executor.ts` while a turn streams, always
 * as `UPDATE runs SET thread = thread || $2::jsonb` — atomic by construction.
 * `/compact` as shipped in `91f6b28` did the opposite: read the thread, wrote
 * an archive from that snapshot, then `UPDATE runs SET thread = $2::jsonb` from
 * the same snapshot. An append landing in between was lost from the ROW and
 * from the ARCHIVE, because both were computed from a value that was already
 * stale. Konrad types /compact when a long turn has filled the window, which is
 * exactly when a turn is streaming, so this is the normal case rather than an
 * exotic one.
 *
 * THE MEASUREMENT: seed a thread, begin a compaction, and fire a real append
 * from a SECOND SESSION while the compaction is inside its archive write. Then
 * ask the only question that matters —
 *
 *     IS THE APPENDED ENTRY IN THE UNION OF (live thread ∪ archive file)?
 *
 * Not "is it in the thread", which a merely-lucky ordering could satisfy, and
 * not "did the route return 200", which it always does. An entry present in
 * NEITHER is unrecoverable data loss; that is the guarantee, stated as a set.
 *
 * TWO SIDES, RUN BACK TO BACK IN ONE PROCESS:
 *
 *   CASE 1  THE RETIRED CODE PATH (negative control). `compactUnlocked()` below
 *           is a deliberate replica of `91f6b28`'s handler body — read, archive
 *           the snapshot, full overwrite, no transaction. It must LOSE the
 *           entry. This is what makes the rest of the file readable: an
 *           instrument that has only ever said "green" is indistinguishable
 *           from one that cannot go red, and this is the case that shows it
 *           can. It is a re-paste, and a re-paste only ever proves it agrees
 *           with itself — so it proves nothing ABOUT the fix, only about the
 *           HARNESS. Case 4 is what proves the fix.
 *   CASE 2  THE SHIPPED FUNCTION. `compactRunThread()` imported from
 *           `lib/thread-compaction.ts` — the real subject, not a copy. The
 *           entry must survive.
 *   CASE 3  IT BLOCKED, IT DID NOT MERELY WIN A COIN TOSS. The append's
 *           completion is timed against the compaction's commit. Under the lock
 *           the append must finish AFTER the commit; under the retired path it
 *           finishes BEFORE. Ordering measured, not assumed — an entry that
 *           survived because the scheduler happened to run the append late
 *           would satisfy case 2 and fail this one.
 *   CASE 4  THE LOCK IS LOad-BEARING, checked by deleting it. The `FOR UPDATE`
 *           clause is removed from a COPY of the shipped SQL and the same
 *           scenario re-run through the same code shape; it must go red. This
 *           is the control for "case 2 passes for some reason other than the
 *           lock".
 *   CASE 5  ARCHIVE FIDELITY. The archive holds every pre-compaction entry, and
 *           its tail is byte-identical to what remains live after the marker —
 *           restorable, not merely present. The claim `91f6b28` made by hand.
 *   CASE 6  IDEMPOTENCY. A second compaction is a no-op (`keep + 1`, not
 *           `keep`), so the transcript does not erode one entry per call.
 *   CASE 7  THE UNCHANGED PATHS: unknown id -> not_found, short thread ->
 *           already_short, and neither writes anything.
 *
 * WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY:
 *   (a) AN APPEND THAT NEVER RAN. Every case asserts the appender's own rowcount
 *       and that its entry is findable by a unique marker string, so a silent
 *       no-op appender fails before the interesting assertion is reached.
 *   (b) A WINDOW TOO NARROW TO RACE. The archive write is held open for
 *       RACE_WINDOW_MS through the module's `onArchiveWrite` seam, and case 1
 *       asserts the loss ACTUALLY HAPPENS — if the window were too small to
 *       lose anything, case 1 goes red and says so.
 *   (c) PROBES THAT MISS. Executed assertions are counted and compared with
 *       EXPECTED_ASSERTIONS at exit. A short run FAILS.
 *   (d) THE WRONG DATABASE. The scratch guard refuses anything but a local,
 *       non-fleet, non-`content_forge` database, and runs BEFORE any pool opens.
 *   (e) A STALE SCHEMA FROM A PREVIOUS RUN. The schema is named per PROCESS and
 *       dropped before and after — two concurrent runs cannot share a table.
 *   (f) ARCHIVES WRITTEN INTO THE REAL BACKUP DIRECTORY. Every case passes an
 *       explicit `dir` under a per-process temp path. The production constant is
 *       never touched, so this harness can never delete or add to the archives
 *       round 971 reviewed.
 *   (g) BUILD IDENTITY UNKNOWN. The banner prints `git rev-parse --short HEAD`
 *       and whether the subject module is dirty against it. A sha naming the
 *       worktree rather than the build is the failure that line answers.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";

import {
  buildMarker,
  compactRunThread,
  type CompactOutcome,
} from "../lib/thread-compaction.ts";
import type { ThreadEntry } from "./runs.ts";

const { Pool } = pg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SUBJECT = path.join(REPO_ROOT, "forge-control/src/lib/thread-compaction.ts");
const RUNS_MIGRATION = path.join(REPO_ROOT, "db/migrations/0021_ai_os_tables.sql");
const SCHEMA = `r972_compact_${process.pid}`;

/** How long the compaction is held inside its archive write. Long enough that a
 *  competing append issued at the start of the window completes well within it
 *  when nothing blocks it — case 1 is the assertion that this is true. */
const RACE_WINDOW_MS = 500;
const SEED_ENTRIES = 200;
const KEEP = 60;

const EXPECTED_ASSERTIONS = 31;

let assertionsRun = 0;
let failed = 0;

function pass(name: string, detail = ""): void {
  assertionsRun += 1;
  console.log(`  ok   ${name.padEnd(56)} ${detail}`);
}
function fail(name: string, detail = ""): void {
  assertionsRun += 1;
  failed += 1;
  console.error(`  FAIL ${name.padEnd(56)} ${detail}`);
}
/** Detail lines are truncated for the transcript, but only on the PASS side and
 *  only in what is printed — the comparison is always over the full strings. A
 *  60 KB "ok" line is not evidence, it is noise that hides the next assertion. */
const brief = (s: string, n = 90): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (${s.length} chars)`;

function assertEq(name: string, expected: unknown, actual: unknown): void {
  if (String(expected) === String(actual)) pass(name, `= ${brief(String(actual))}`);
  else fail(name, `expected [${brief(String(expected), 300)}] got [${brief(String(actual), 300)}]`);
}
function assertTrue(name: string, cond: boolean, detail = ""): void {
  if (cond) pass(name, detail);
  else fail(name, detail);
}

/** Refuse to run anywhere but a throwaway, local, non-fleet database. Same
 *  guard as src/db/projects.test.ts's, and it runs before any pool is opened.
 *  Resolves the database NAME and never returns or prints the DSN's contents
 *  beyond what the caller already holds. */
function guardScratchDsn(): { dsn: string; name: string } {
  const dsn = (process.env.SCRATCH_DATABASE_URL ?? "").trim();
  if (dsn === "") {
    throw new Error(
      "REFUSING TO RUN: $SCRATCH_DATABASE_URL is unset. This check never guesses a " +
        "connection string — see the preamble in this file's header.",
    );
  }
  let u: URL;
  try {
    u = new URL(dsn);
  } catch (e) {
    throw new Error(
      `REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a parsable URL (${
        e instanceof Error ? e.message : String(e)
      }).`,
    );
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a postgres:// URL.");
  }
  const name = u.pathname.replace(/^\//, "").split("?")[0] ?? "";
  if (name === "") throw new Error("REFUSING TO RUN: $SCRATCH_DATABASE_URL names no database.");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(
      `REFUSING TO RUN: scratch database must be local, host resolved to ${u.hostname}.`,
    );
  }
  const banned = new Set(["content_forge", "postgres", "template0", "template1"]);
  if (banned.has(name)) {
    throw new Error(
      `REFUSING TO RUN: ${name} is a protected database. Point $SCRATCH_DATABASE_URL ` +
        "at a throwaway scratch database.",
    );
  }
  const live = new Set<string>();
  for (const p of [
    "/opt/ai-os/.secrets/forge-control.env",
    "/opt/forge-ai-os/.env",
    "/opt/content-forge/.env",
  ]) {
    let blob: string;
    try {
      blob = readFileSync(p, "utf8");
    } catch {
      continue; // a config this host does not have is not a finding
    }
    for (const m of blob.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)) {
      try {
        live.add(new URL(m[0]).pathname.replace(/^\//, "").split("?")[0] ?? "");
      } catch {
        continue;
      }
    }
  }
  live.delete("");
  if (live.has(name)) {
    throw new Error(
      `REFUSING TO RUN: ${name} is a database this fleet runs on (found in the fleet ` +
        "config). Use a throwaway scratch database.",
    );
  }
  return { dsn, name };
}

/**
 * The `runs` table, taken from the SHIPPED migration rather than retyped here.
 * A hand-written table would let the harness pass against a schema the fleet
 * does not have. The extraction is anchored and its result is checked for the
 * three columns this subject actually touches — a regex that silently matched
 * the wrong block would otherwise produce a plausible table and a green run.
 */
function runsTableDdl(): string {
  const sql = readFileSync(RUNS_MIGRATION, "utf8");
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS runs (");
  if (start < 0) {
    throw new Error(`REFUSING TO RUN: no runs table in ${RUNS_MIGRATION}`);
  }
  const end = sql.indexOf("\n);", start);
  if (end < 0) {
    throw new Error(`REFUSING TO RUN: unterminated runs table in ${RUNS_MIGRATION}`);
  }
  const ddl = sql.slice(start, end + 3);
  for (const col of ["thread", "metadata", "updated_at", "id"]) {
    if (!new RegExp(`\\n\\s+${col}\\s`).test(ddl)) {
      throw new Error(
        `REFUSING TO RUN: the extracted runs DDL has no ${col} column — the ` +
          "extraction matched the wrong block.",
      );
    }
  }
  /* The migration's self-reference (parent_run_id REFERENCES runs) is fine
   * inside one statement. Nothing else in the block leaves the table. */
  return ddl;
}

function seedThread(n: number): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `seeded entry ${i}`,
      ts: new Date(Date.parse("2026-08-19T00:00:00.000Z") + i * 1000).toISOString(),
      kind: "text",
    });
  }
  return out;
}

/**
 * THE RETIRED CODE PATH — a deliberate replica of `91f6b28`'s handler body, kept
 * only as case 1's negative control. It is NOT imported from anywhere and NOT
 * reachable in production; it exists so this harness can demonstrate it detects
 * the defect it claims to detect. Do not "fix" it.
 */
async function compactUnlocked(
  pool: pg.Pool,
  opts: { id: string; keep: number; now: Date; dir: string; hold: () => Promise<void> },
): Promise<CompactOutcome> {
  const { id, keep, now, dir, hold } = opts;
  // read (no lock, no transaction)
  const sel = await pool.query<{ thread: unknown }>(`SELECT thread FROM runs WHERE id = $1`, [id]);
  if (sel.rows.length === 0) return { kind: "not_found" };
  const raw = sel.rows[0]?.thread;
  const thread: ThreadEntry[] = Array.isArray(raw) ? (raw as ThreadEntry[]) : [];
  if (thread.length <= keep + 1) return { kind: "already_short", entries: thread.length };

  const dropped = thread.length - keep;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archive = `${dir}/${id}-${stamp}.json`;
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(archive, JSON.stringify(thread), "utf8");
  await hold(); // the window an append lands in

  const marker = buildMarker({ stamp, dropped, keep, archive, ts: now.toISOString() });
  const next = [marker, ...thread.slice(-keep)];
  const upd = await pool.query<{ id: string }>(
    `UPDATE runs SET thread = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING id::text`,
    [id, JSON.stringify(next)],
  );
  if (upd.rows.length === 0) return { kind: "not_found" };
  return { kind: "compacted", dropped, kept: next.length, was: thread.length, archive };
}

/**
 * CASE 4's subject — the shipped transaction with `FOR UPDATE` DELETED, and
 * nothing else changed. The clause is removed from a copy of the shipped SQL
 * string, not from a hand-written statement, so this cannot drift into testing
 * some other query. Proves the lock is what case 2 is measuring.
 */
async function compactWithoutRowLock(
  pool: pg.Pool,
  opts: { id: string; keep: number; now: Date; dir: string; hold: () => Promise<void> },
): Promise<CompactOutcome> {
  const { id, keep, now, dir, hold } = opts;
  const SHIPPED_SELECT = `SELECT thread FROM runs WHERE id = $1 FOR UPDATE`;
  const WITHOUT = SHIPPED_SELECT.replace(" FOR UPDATE", "");
  if (WITHOUT === SHIPPED_SELECT) {
    throw new Error("case 4 is inert: the FOR UPDATE clause was not removed");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query<{ thread: unknown }>(WITHOUT, [id]);
    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }
    const raw = sel.rows[0]?.thread;
    const thread: ThreadEntry[] = Array.isArray(raw) ? (raw as ThreadEntry[]) : [];
    if (thread.length <= keep + 1) {
      await client.query("ROLLBACK");
      return { kind: "already_short", entries: thread.length };
    }
    const dropped = thread.length - keep;
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const archive = `${dir}/${id}-${stamp}.json`;
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(archive, JSON.stringify(thread), "utf8");
    await hold();
    const marker = buildMarker({ stamp, dropped, keep, archive, ts: now.toISOString() });
    const next = [marker, ...thread.slice(-keep)];
    await client.query(
      `UPDATE runs SET thread = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(next)],
    );
    await client.query("COMMIT");
    return { kind: "compacted", dropped, kept: next.length, was: thread.length, archive };
  } finally {
    client.release();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RaceResult {
  outcome: CompactOutcome;
  liveThread: ThreadEntry[];
  archived: ThreadEntry[];
  appendRowCount: number;
  appendFinishedAt: number;
  compactFinishedAt: number;
  needle: string;
}

/**
 * Run one race: seed a run, start a compaction, and fire a real append from a
 * SECOND SESSION while the compaction sits in its archive-write window.
 *
 * The append is issued but NOT awaited inside the window — under the shipped
 * lock it BLOCKS there, and awaiting it would deadlock the harness rather than
 * measure the fix. It is awaited after the compaction returns, and the two
 * completion timestamps are what case 3 compares.
 */
async function runRace(
  pool: pg.Pool,
  appendPool: pg.Pool,
  dir: string,
  label: string,
  compactor: (o: {
    id: string;
    keep: number;
    now: Date;
    dir: string;
    hold: () => Promise<void>;
  }) => Promise<CompactOutcome>,
): Promise<RaceResult> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO runs (title, prompt, status, thread) VALUES ($1,$2,'running',$3::jsonb)
       RETURNING id::text`,
      [`race ${label}`, "seed", JSON.stringify(seedThread(SEED_ENTRIES))],
    )
  ).rows[0]?.id as string;

  const needle = `LIVE-APPEND-${label}-${process.pid}`;
  const entry: ThreadEntry = {
    role: "assistant",
    content: needle,
    ts: new Date().toISOString(),
    kind: "text",
  };

  let appendRowCount = -1;
  let appendFinishedAt = 0;
  let appendStarted = false;
  let appendPromise: Promise<void> = Promise.resolve();

  const hold = async (): Promise<void> => {
    /* Fire the append from a different session, do not await it. This is the
     * exact statement executor.ts uses to stream a live turn. */
    appendStarted = true;
    appendPromise = appendPool
      .query(`UPDATE runs SET thread = thread || $2::jsonb, updated_at = now() WHERE id = $1`, [
        id,
        JSON.stringify([entry]),
      ])
      .then((r) => {
        appendRowCount = r.rowCount ?? 0;
        appendFinishedAt = Date.now();
      });
    await sleep(RACE_WINDOW_MS);
  };

  const outcome = await compactor({ id, keep: KEEP, now: new Date(), dir, hold });
  const compactFinishedAt = Date.now();
  await appendPromise;
  if (!appendStarted) throw new Error(`race ${label}: the hold seam never ran`);

  const live = await pool.query<{ thread: ThreadEntry[] }>(
    `SELECT thread FROM runs WHERE id = $1`,
    [id],
  );
  const archived =
    outcome.kind === "compacted"
      ? (JSON.parse(await readFile(outcome.archive, "utf8")) as ThreadEntry[])
      : [];

  return {
    outcome,
    liveThread: live.rows[0]?.thread ?? [],
    archived,
    appendRowCount,
    appendFinishedAt,
    compactFinishedAt,
    needle,
  };
}

const has = (entries: ThreadEntry[], needle: string): boolean =>
  entries.some((e) => typeof e.content === "string" && e.content.includes(needle));

async function main(): Promise<void> {
  const { dsn, name } = guardScratchDsn();

  let head = "unknown";
  let dirty = "unknown";
  try {
    head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const st = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", SUBJECT], {
      encoding: "utf8",
    }).trim();
    dirty = st === "" ? "clean" : `DIRTY (${st.split("\n").length} line(s))`;
  } catch {
    /* build identity unavailable is itself worth printing, not hiding */
  }

  console.log("─".repeat(78));
  console.log("compact-race.test.ts — round 972 fix cycle 1, finding 1 (the archive guarantee)");
  console.log(`  scratch db      : ${name}`);
  console.log(`  schema          : ${SCHEMA}`);
  console.log(`  repo HEAD       : ${head}`);
  console.log(`  subject vs HEAD : ${dirty}  (${path.relative(REPO_ROOT, SUBJECT)})`);
  console.log(`  seed / keep     : ${SEED_ENTRIES} entries, keep ${KEEP}`);
  console.log(`  race window     : ${RACE_WINDOW_MS} ms`);
  console.log("─".repeat(78));

  const dir = await mkdtemp(path.join(tmpdir(), `r972-compact-${process.pid}-`));

  /* search_path via the CONNECTION OPTION, not a `connect` hook. The hook form
   * fires `client.query()` without awaiting it, so a pooled client can issue
   * the first real statement before the search_path lands — a flake that would
   * surface as "relation runs does not exist" in whichever case got unlucky.
   * As a connection parameter it is applied by the server at startup, before
   * any statement this process can send. */
  const options = `-c search_path=${SCHEMA}`;
  const pool = new Pool({ connectionString: dsn, max: 4, options });
  const appendPool = new Pool({ connectionString: dsn, max: 2, options });

  try {
    const bootstrap = new Pool({ connectionString: dsn, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await bootstrap.end();

    const setup = new Pool({ connectionString: dsn, max: 1, options });
    await setup.query(runsTableDdl());
    /* The table must exist IN THE PER-PROCESS SCHEMA, never in `public` — a
     * search_path that silently failed would create it there and two concurrent
     * runs would share a table, which is the shared-scratch failure this fleet
     * has already paid for twice. */
    const where = await setup.query<{ schemaname: string }>(
      `SELECT schemaname FROM pg_tables WHERE tablename = 'runs'`,
    );
    const schemas = where.rows.map((r) => r.schemaname).sort();
    if (schemas.length !== 1 || schemas[0] !== SCHEMA) {
      throw new Error(
        `REFUSING TO RUN: runs table landed in [${schemas.join(", ")}], expected only ${SCHEMA}`,
      );
    }
    await setup.end();

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 1 — THE RETIRED PATH MUST LOSE THE ENTRY (negative control). */
    console.log("\nCASE 1  the retired unlocked path — must LOSE the live append");
    const r1 = await runRace(pool, appendPool, dir, "unlocked", (o) => compactUnlocked(pool, o));
    assertEq("case1 compaction ran", "compacted", r1.outcome.kind);
    assertEq("case1 the append really executed (rowcount)", 1, r1.appendRowCount);
    assertTrue(
      "case1 the append completed INSIDE the window",
      r1.appendFinishedAt > 0 && r1.appendFinishedAt < r1.compactFinishedAt,
      `append@${r1.appendFinishedAt} compact@${r1.compactFinishedAt}`,
    );
    assertTrue("case1 entry is GONE from the live thread", !has(r1.liveThread, r1.needle));
    assertTrue("case1 entry is GONE from the archive too", !has(r1.archived, r1.needle));
    assertTrue(
      "case1 THE DEFECT REPRODUCES: present in neither",
      !has(r1.liveThread, r1.needle) && !has(r1.archived, r1.needle),
      "unrecoverable loss — this is what the fix must eliminate",
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 2 — THE SHIPPED FUNCTION MUST KEEP IT. */
    console.log("\nCASE 2  the shipped compactRunThread() — must KEEP the live append");
    const r2 = await runRace(pool, appendPool, dir, "locked", (o) =>
      compactRunThread(pool, {
        id: o.id,
        keep: o.keep,
        now: o.now,
        dir: o.dir,
        onArchiveWrite: async (archive, body) => {
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(o.dir, { recursive: true });
          await writeFile(archive, body, "utf8");
          await o.hold();
        },
      }),
    );
    assertEq("case2 compaction ran", "compacted", r2.outcome.kind);
    assertEq("case2 the append really executed (rowcount)", 1, r2.appendRowCount);
    assertTrue("case2 entry SURVIVES in the live thread", has(r2.liveThread, r2.needle));
    assertTrue(
      "case2 THE GUARANTEE HOLDS: present in the union",
      has(r2.liveThread, r2.needle) || has(r2.archived, r2.needle),
    );
    assertEq(
      "case2 thread is marker + keep + the appended entry",
      KEEP + 2,
      r2.liveThread.length,
    );
    assertTrue(
      "case2 the appended entry is LAST — it landed after the compaction",
      r2.liveThread[r2.liveThread.length - 1]?.content === r2.needle,
      String(r2.liveThread[r2.liveThread.length - 1]?.content).slice(0, 40),
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 3 — IT BLOCKED. */
    console.log("\nCASE 3  the append BLOCKED on the row lock — ordering, not luck");
    assertTrue(
      "case3 under the lock the append finishes AFTER the commit",
      r2.appendFinishedAt >= r2.compactFinishedAt,
      `append@${r2.appendFinishedAt} >= compact@${r2.compactFinishedAt}`,
    );
    assertTrue(
      "case3 control: unlocked, it finished BEFORE the commit",
      r1.appendFinishedAt < r1.compactFinishedAt,
      "the two paths are distinguishable by ordering",
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 4 — DELETE THE LOCK, GO RED. */
    console.log("\nCASE 4  same transaction with FOR UPDATE deleted — must go RED again");
    const r4 = await runRace(pool, appendPool, dir, "nolock", (o) =>
      compactWithoutRowLock(pool, o),
    );
    assertEq("case4 compaction ran", "compacted", r4.outcome.kind);
    assertEq("case4 the append really executed (rowcount)", 1, r4.appendRowCount);
    assertTrue(
      "case4 WITHOUT the lock the entry is lost again",
      !has(r4.liveThread, r4.needle) && !has(r4.archived, r4.needle),
      "so case 2 passes BECAUSE of FOR UPDATE, not despite it",
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 5 — ARCHIVE FIDELITY. */
    console.log("\nCASE 5  the archive is restorable, not merely present");
    assertEq("case5 archive holds every pre-compaction entry", SEED_ENTRIES, r2.archived.length);
    assertEq("case5 outcome.was matches", SEED_ENTRIES, (r2.outcome as { was: number }).was);
    assertEq("case5 outcome.dropped matches", SEED_ENTRIES - KEEP, (r2.outcome as { dropped: number }).dropped);
    const liveTail = r2.liveThread.slice(1, 1 + KEEP);
    const archiveTail = r2.archived.slice(-KEEP);
    assertEq(
      "case5 the live tail is BYTE-IDENTICAL to the archive's tail",
      JSON.stringify(archiveTail),
      JSON.stringify(liveTail),
    );
    assertTrue(
      "case5 the marker names the archive that exists",
      String(r2.liveThread[0]?.content ?? "").includes((r2.outcome as { archive: string }).archive),
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 6 — IDEMPOTENCY. */
    console.log("\nCASE 6  a second compaction is a no-op");
    const idRow = await pool.query<{ id: string }>(
      `INSERT INTO runs (title, prompt, status, thread) VALUES ('idem','seed','running',$1::jsonb)
       RETURNING id::text`,
      [JSON.stringify(seedThread(SEED_ENTRIES))],
    );
    const idemId = idRow.rows[0]?.id as string;
    const first = await compactRunThread(pool, { id: idemId, keep: KEEP, now: new Date(), dir });
    assertEq("case6 first compaction compacts", "compacted", first.kind);
    const second = await compactRunThread(pool, { id: idemId, keep: KEEP, now: new Date(), dir });
    assertEq("case6 second is a no-op", "already_short", second.kind);
    assertEq("case6 and reports keep+1 entries", KEEP + 1, (second as { entries: number }).entries);
    const afterTwo = await pool.query<{ thread: ThreadEntry[] }>(
      `SELECT thread FROM runs WHERE id = $1`,
      [idemId],
    );
    assertEq("case6 the transcript did not erode", KEEP + 1, afterTwo.rows[0]?.thread.length);
    assertEq(
      "case6 exactly ONE marker, not a stack",
      1,
      (afterTwo.rows[0]?.thread ?? []).filter((e) => String(e.content).startsWith("[compacted "))
        .length,
    );

    /* ─────────────────────────────────────────────────────────────────────
     * CASE 7 — THE UNCHANGED PATHS. */
    console.log("\nCASE 7  not_found and already_short still behave, and write nothing");
    const missing = await compactRunThread(pool, {
      id: "00000000-0000-4000-8000-000000000000",
      keep: KEEP,
      now: new Date(),
      dir,
    });
    assertEq("case7 unknown id -> not_found", "not_found", missing.kind);
    const shortRow = await pool.query<{ id: string }>(
      `INSERT INTO runs (title, prompt, status, thread) VALUES ('short','seed','running',$1::jsonb)
       RETURNING id::text`,
      [JSON.stringify(seedThread(5))],
    );
    const shortOutcome = await compactRunThread(pool, {
      id: shortRow.rows[0]?.id as string,
      keep: KEEP,
      now: new Date(),
      dir,
    });
    assertEq("case7 short thread -> already_short", "already_short", shortOutcome.kind);
    assertEq("case7 and reports its real length", 5, (shortOutcome as { entries: number }).entries);
    const shortAfter = await pool.query<{ thread: ThreadEntry[] }>(
      `SELECT thread FROM runs WHERE id = $1`,
      [shortRow.rows[0]?.id as string],
    );
    assertEq("case7 the short thread is untouched", 5, shortAfter.rows[0]?.thread.length);
  } finally {
    const teardown = new Pool({ connectionString: dsn, max: 1 });
    await teardown.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await teardown.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await appendPool.end().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("─".repeat(78));
  console.log(`assertions run ${assertionsRun} / expected ${EXPECTED_ASSERTIONS}, failed ${failed}`);
  if (assertionsRun !== EXPECTED_ASSERTIONS) {
    console.error(
      `SHORT RUN: ${assertionsRun} assertions executed but ${EXPECTED_ASSERTIONS} were ` +
        "expected. A probe that never fired cannot certify anything.",
    );
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`${failed} assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
