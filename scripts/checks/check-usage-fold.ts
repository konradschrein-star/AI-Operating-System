/**
 * check-usage-fold.ts — the hourly sampler's token fold, against a REAL
 * Postgres. Round 1353's review, finding 1.
 *
 * `usage-sampler.test.ts` proves the module's contract against a fake
 * `Querier`: one statement, the right params, a zero row rather than a hole.
 * It cannot prove what the SQL COMPUTES, and the defect was entirely inside
 * the SQL — so this is the check that had to exist and did not.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * The module header asserted "spend_log gets exactly one row per finished run".
 * It does not. `executor.ts:1147` calls `recordSpend` once per EXECUTOR
 * INVOCATION, and a chat run is re-entered for every turn — so a long run
 * accumulates one spend row per turn, spread over as many hours as it lives.
 *
 * `linked` was `SELECT DISTINCT run_id FROM billed`: every run billed in the
 * hour, folded at its CUMULATIVE `metadata.usage_total_running`. A run touching
 * N hours therefore contributed its whole running total to all N buckets. The
 * reviewer measured 4.9 % phantom tokens over 24 h of live data, unbounded as a
 * chat grows — one live run held 123 spend rows across 15 of 24 buckets.
 *
 * Worse, closed buckets were not stable. `RESAMPLE_LOOKBACK = 1` re-closes the
 * previous hour on every tick, and re-closing it re-read the run's total AS IT
 * IS NOW, so a settled hour's number climbed as an unrelated later run kept
 * talking.
 *
 * ── The fix, and what this script asserts ──────────────────────────────────
 * A run lands in exactly ONE bucket: the hour of its LATEST claude-code spend
 * row. Everything below is asserted against a scratch database with synthetic
 * rows, so each number is arithmetic anyone can recompute by hand:
 *
 *   §1  a two-turn run spanning two hours is counted ONCE, in the later hour
 *       (this is the regression: it used to be counted in both)
 *   §2  a closed bucket does not move when the run keeps talking afterwards
 *   §2b THE ROUND-1355 BLOCKER: the same thing driven by the REAL
 *       `runSamplerTick` on production's cadence across a 3-hour silence.
 *       §2 re-samples by hand, which production only does inside a 2-tick
 *       window; past that the bucket freezes and the run is folded twice
 *       (10:00 = 1000 and 14:00 = 5000 for a true total of 5000). Nothing in
 *       §2b calls sampleHour, and it asserts the SUM across every bucket —
 *       the only number a double fold cannot hide from. It also asserts the
 *       repair TERMINATES: a second pass finds nothing.
 *   §2c a bucket written before `meta.folded_runs` existed cannot be audited,
 *       so it is re-sampled once on the `unaudited` reason — this is what
 *       repairs the 16 (run, bucket) pairs measured on live data
 *   §2d an UPPERCASE run id in spend_log still matches the lowercase-canonical
 *       ids in `folded_runs` (round 1355's non-blocking note; latent, so it
 *       gets a check rather than a comment)
 *   §3  a single-hour run is unaffected — the ordinary case still works
 *   §4  COST is per-row and must NOT be deduped: both turns' USD count, in
 *       their own hours (the bug never touched cost, and the fix must not)
 *   §5  sub-agent usage still adds on top of the parent total, once
 *   §6  a run whose turns are ALL in the future of the bucket is excluded
 *   §7  idempotence survives the change: sampling twice is byte-identical
 *
 * ── Why psql and not `pg` ──────────────────────────────────────────────────
 * This file lives in the repo-root `scripts/` tree, which has no
 * `node_modules`: a bare `import pg from "pg"` does not resolve from here
 * (verified — MODULE_NOT_FOUND), and NF4 forbids adding a dependency to make
 * it. `check-working-sql-agreement.ts` documents the same limitation and takes
 * the same way out. `sampleHour` accepts a `Querier`, which is a two-method
 * interface precisely so a caller can supply one — so the psql child process
 * below IS the injected querier, and the SQL under test is the module's own,
 * imported and never retyped.
 *
 * Run (needs a Postgres; makes its own scratch database and never touches
 * content_forge):
 *   cd forge-control && DATABASE_URL=<live dsn> ./node_modules/.bin/tsx \
 *     ../scripts/checks/check-usage-fold.ts
 *
 * The DSN is used ONLY to reach the SERVER and to create the database named by
 * USAGE_FOLD_DB (default `r1354_sampler`); every other statement is issued
 * against that database. It refuses to run if the two resolve to one name.
 *
 * Typecheck (outside forge-control's tsconfig `include`, so it needs its own
 * invocation with the same compiler options):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/check-usage-fold.ts
 */

import { execFileSync } from "node:child_process";

import {
  HOUR_MS,
  repairDisplacedBuckets,
  runSamplerTick,
  sampleHour,
  type Querier,
} from "../../forge-control/src/lib/usage-sampler.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

/* ── Scratch database ─────────────────────────────────────────────────────── */

const SCRATCH_DB = process.env.USAGE_FOLD_DB ?? "r1354_sampler";

function dsn(): { admin: string; scratch: string } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This check needs a Postgres SERVER to create " +
        `its own '${SCRATCH_DB}' database on; it issues no statement against the ` +
        "database named in the DSN.",
    );
  }
  const u = new URL(url);
  const liveName = u.pathname.replace(/^\//, "");
  if (liveName === SCRATCH_DB) {
    throw new Error(
      `DATABASE_URL points at '${liveName}', which is also USAGE_FOLD_DB. This ` +
        "check DROPs and recreates its scratch tables; it refuses to do that to " +
        "the database it was handed.",
    );
  }
  const scratch = new URL(url);
  scratch.pathname = `/${SCRATCH_DB}`;
  return { admin: url, scratch: scratch.toString() };
}

/** Minimal `runs`: the sampler reads `id` and `metadata` and nothing else. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id uuid PRIMARY KEY,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE TABLE IF NOT EXISTS spend_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    provider text NOT NULL,
    kind text NOT NULL,
    amount_eur numeric(10,4) NOT NULL,
    job_id uuid,
    units integer,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    CHECK (amount_eur >= 0)
  );
  CREATE INDEX IF NOT EXISTS spend_log_provider_created_idx
    ON spend_log (provider, created_at DESC);
  CREATE TABLE IF NOT EXISTS usage_hourly (
    bucket_start timestamptz PRIMARY KEY,
    tokens_in bigint NOT NULL DEFAULT 0,
    tokens_out bigint NOT NULL DEFAULT 0,
    cache_read bigint NOT NULL DEFAULT 0,
    cache_write bigint NOT NULL DEFAULT 0,
    shadow_usd numeric(12,4) NOT NULL DEFAULT 0,
    run_count integer NOT NULL DEFAULT 0,
    sampled_at timestamptz NOT NULL DEFAULT now(),
    meta jsonb NOT NULL DEFAULT '{}'::jsonb
  );
`;

/* ── Fixture helpers ──────────────────────────────────────────────────────── */

/** 2026-08-17T10:00:00Z — a fixed clock, so every expected number below is a
 *  constant a reader can verify by arithmetic rather than by running this. */
const H10 = new Date("2026-08-17T10:00:00.000Z");
const H11 = new Date(H10.getTime() + HOUR_MS);
const H12 = new Date(H10.getTime() + 2 * HOUR_MS);
const H13 = new Date(H10.getTime() + 3 * HOUR_MS);
const H14 = new Date(H10.getTime() + 4 * HOUR_MS);
const H15 = new Date(H10.getTime() + 5 * HOUR_MS);

/** The production tick fires TICK_SKEW_MS after the hour boundary and closes
 *  the hour that just ended. `tickAt(H12)` is therefore "the 12:00:30 tick",
 *  which closes 11:00 and re-closes 10:00. */
const tickAt = (h: Date): Date => new Date(h.getTime() + 30_000);

const RUN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_B = "bbbbbbbb-0000-4000-8000-000000000002";

/* ── The Querier, spoken through psql ─────────────────────────────────────── */

/** A SQL literal. Every value this script binds is one it wrote itself, but
 *  quoting properly is cheaper than reasoning about which. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot bind non-finite number ${String(v)}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * `pg`'s `$n` placeholders, substituted before the statement leaves the
 * process. `sampleHour` builds its SQL with `$1/$2/$3` and hands the values
 * separately; psql has no bind protocol on `-c`, so this is where the two meet.
 * The SQL is the MODULE'S OWN string, imported — this function never rewrites
 * anything but the placeholders.
 */
function bind(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) {
      throw new Error(`SQL references $${n} but only ${params.length} param(s) were given`);
    }
    return lit(params[i]);
  });
}

interface PsqlRow {
  [k: string]: unknown;
}

/**
 * The injected `Querier`. Wraps whatever it is handed in a CTE and asks for
 * `row_to_json`, so an `INSERT … RETURNING` (which is what `sampleHour` runs)
 * comes back as rows rather than a command tag. Data-modifying CTEs are
 * ordinary Postgres; the wrapper adds no semantics, only a shape.
 */
type PsqlDb = Querier & {
  /** Statements the CTE wrapper cannot carry — CREATE DATABASE, TRUNCATE,
   *  EXPLAIN — plus fixture writes. Returns psql's stdout so EXPLAIN is
   *  readable. */
  exec: (sql: string) => string;
};

function psqlQuerier(url: string): PsqlDb {
  const run = (sql: string): string => {
    try {
      return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tAX", "-c", sql], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      // Surfaced, never swallowed: a check that reports PASS because its
      // statement failed is worse than no check.
      throw new Error(
        `psql failed\n  sql: ${sql.slice(0, 400)}${sql.length > 400 ? " …" : ""}\n  ${(err.stderr ?? err.message ?? "").trim()}`,
      );
    }
  };
  /* ONE cast, at one boundary, and this comment is the reason for it.
   * `Querier.query` returns `pg.QueryResult<R>` — a type this file cannot NAME,
   * because `scripts/` has no node_modules and `import("pg")` does not resolve
   * from here (it fails the standalone tsc gate; verified). `sampleHour` reads
   * `rows` and nothing else, and `rowCount`/`command`/`oid`/`fields` are
   * supplied anyway so the object is an honest QueryResult rather than a
   * minimal one that happens to work. */
  return {
    exec(sql: string): string {
      return run(sql);
    },
    query<R extends PsqlRow = PsqlRow>(sql: string, params: unknown[] = []) {
      const bound = bind(sql, params);
      const out = run(`WITH _r AS (\n${bound}\n) SELECT row_to_json(_r) FROM _r`);
      const rows = out
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as R);
      return Promise.resolve({
        rows,
        rowCount: rows.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
    },
  } as unknown as PsqlDb;
}

type Db = PsqlDb;

/* ── Fixture writers ──────────────────────────────────────────────────────── */

function reset(db: Db): void {
  db.exec("TRUNCATE runs, spend_log, usage_hourly");
}

function putRun(
  db: Db,
  id: string,
  totals: Record<string, number>,
  subs?: Record<string, number>[],
): void {
  const metadata: Record<string, unknown> = { usage_total_running: totals };
  if (subs) metadata["subagents_v2"] = subs.map((usage) => ({ usage }));
  db.exec(
    `INSERT INTO runs (id, metadata) VALUES (${lit(id)}, ${lit(JSON.stringify(metadata))}::jsonb)
     ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata`,
  );
}

/** One turn's spend row — what `executor.ts` writes at the end of each
 *  invocation, which is once per TURN, not once per run. */
function turn(db: Db, runId: string, at: Date, usd: number): void {
  db.exec(
    `INSERT INTO spend_log (created_at, provider, kind, amount_eur, units, meta)
     VALUES (${lit(at.toISOString())}::timestamptz, 'claude-code', 'llm_output',
             ${lit((usd * 0.86).toFixed(4))}, 1, ${lit(JSON.stringify({ run_id: runId, usd }))}::jsonb)`,
  );
}

const at = (h: Date, min: number): Date => new Date(h.getTime() + min * 60_000);

/** Every bucket in the table, oldest first. §2b's assertions are about the
 *  SUM across buckets, which is the only number that can catch a double fold
 *  — each individual bucket looked perfectly reasonable while the total was
 *  20% too high. */
function buckets(db: Db): Array<{ hour: string; tokens: number }> {
  return db
    .exec(
      `SELECT to_char(bucket_start AT TIME ZONE 'UTC', 'HH24:MI') || '|' || tokens_in
         FROM usage_hourly ORDER BY bucket_start`,
    )
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [hour, tokens] = l.trim().split("|");
      return { hour: hour ?? "", tokens: Number(tokens ?? "0") };
    });
}

const sumTokens = (rows: Array<{ tokens: number }>): number =>
  rows.reduce((a, b) => a + b.tokens, 0);

const usage = (input: number): Record<string, number> => ({
  input_tokens: input,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/* ── The run ──────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { admin, scratch } = dsn();

  const admin_db = psqlQuerier(admin);
  const present = await admin_db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM pg_database WHERE datname = ${lit(SCRATCH_DB)}`,
  );
  if (present.rows.length === 0) {
    // The identifier is a literal or an env var the operator chose; quoted so
    // it stays ONE identifier whatever it contains. `CREATE DATABASE` cannot
    // run inside the wrapping CTE, so it goes through `exec`.
    admin_db.exec(`CREATE DATABASE "${SCRATCH_DB.replace(/"/g, '""')}"`);
    console.log(`(created scratch database ${SCRATCH_DB})`);
  }

  const db = psqlQuerier(scratch);
  db.exec(SCHEMA);
  const q: Querier = db;

  console.log(`── §1 a run spanning two hours is counted ONCE ─────────────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10); //  turn 1 — hour 10
    turn(db, RUN_A, at(H11, 5), 0.20); //  turn 2 — hour 11

    const h10 = await sampleHour(H10, q);
    const h11 = await sampleHour(H11, q);

    // BEFORE the fix these were 1000 and 1000. The run's latest turn is in
    // hour 11, so hour 11 is where its total belongs and hour 10 gets none.
    check("hour 10 (an EARLIER turn of a still-talking run)", h10.tokens_in, 0);
    check("hour 11 (the run's LATEST turn)", h11.tokens_in, 1000);
    check("…so the two hours sum to the run's real total, not double it", h10.tokens_in + h11.tokens_in, 1000);
    check("hour 10 still reports the run as billed", h10.run_count, 1);
    check("…and meta.runs_found reports that none of them FOLDED here", h10.meta["runs_found"], 0);
  }

  console.log(`\n── §2 a closed bucket does not move afterwards ─────────────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10);
    turn(db, RUN_A, at(H11, 5), 0.20);
    const first = await sampleHour(H11, q);
    check("hour 11 closes at 1000", first.tokens_in, 1000);

    // The run keeps talking in hour 12 and its cumulative total grows.
    putRun(db, RUN_A, usage(5000));
    turn(db, RUN_A, at(H12, 5), 0.30);

    // RESAMPLE_LOOKBACK re-closes hour 11 on the next tick. Before the fix it
    // came back 5000 — a settled hour rewriting itself from a later run's
    // cumulative counter.
    const again = await sampleHour(H11, q);
    check("re-closing hour 11 after the run grew leaves it alone", again.tokens_in, 0);
    const h12 = await sampleHour(H12, q);
    check("…because the total moved to hour 12, where the latest turn is", h12.tokens_in, 5000);
  }

  console.log(`\n── §2b the same, but driven by the REAL tick over a 3h gap ─`);
  {
    /* Round 1355's blocker, reproduced the way production actually behaves.
     *
     * §2 above re-samples hour 11 BY HAND after the later turn arrives. That
     * is a repair production only performs inside a 2-tick window: each tick
     * writes the closing hour and re-closes the one before it, `backfill`
     * only fills EMPTY buckets, and after that the bucket is frozen. So a run
     * that goes quiet across >= 2 buckets and then resumes used to be folded
     * into its old frozen bucket AND its new one — the reviewer measured
     * 10:00 = 1000, 14:00 = 5000, true total 5000, buckets summing to 6000.
     *
     * Nothing below calls sampleHour. Every write goes through
     * `runSamplerTick` on the schedule the timer arms — one tick per hour,
     * 30s past the boundary — so this fails on any code where the repair pass
     * is missing, disabled, or reaches back less far than the silence.
     */
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10); // one turn, hour 10 …

    // 11:00:30 … 14:00:30, the run silent throughout. The 11:00 tick closes
    // hour 10 and the 12:00 tick re-closes it as its RESAMPLE_LOOKBACK hour;
    // from the 13:00 tick on, hour 10 is frozen under the pre-1356 code.
    for (const h of [H11, H12, H13, H14]) {
      await runSamplerTick(tickAt(h), q);
    }

    const frozen = buckets(db).find((b) => b.hour === "10:00");
    check("hour 10 holds the run while it is the run's latest turn", frozen?.tokens, 1000);

    // … and three hours later it resumes. Cumulative counter is now 5000.
    putRun(db, RUN_A, usage(5000));
    turn(db, RUN_A, at(H14, 5), 0.30);
    await runSamplerTick(tickAt(H15), q); // the tick that sees the resumed turn

    const after = buckets(db);
    const h10 = after.find((b) => b.hour === "10:00");
    const h14 = after.find((b) => b.hour === "14:00");
    check("hour 14 takes the resumed run's whole total", h14?.tokens, 5000);
    check("hour 10 gives it up — this was 1000 before round 1356", h10?.tokens, 0);
    check(
      "…so every bucket, summed, is the run's real total and not 6000",
      sumTokens(after),
      5000,
    );

    // Convergence: the repair must not re-select the same bucket forever.
    const second = await repairDisplacedBuckets(tickAt(H15), q);
    check("a second repair pass finds nothing displaced", second.displaced.length, 0);
    check("…and nothing unaudited either", second.unaudited.length, 0);
    check("…and the numbers did not move", sumTokens(buckets(db)), 5000);
  }

  console.log(`\n── §2c a bucket written before folded_runs existed is repaired ─`);
  {
    /* The 16 (run, bucket) pairs round 1355 measured were written by the
     * frozen-bucket code, so they carry no `meta.folded_runs` and cannot be
     * audited. They are re-sampled once, on the reason `unaudited`. Simulated
     * here by stripping the key from a bucket that legitimately holds a fold
     * the run has since left behind.
     */
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10);
    await sampleHour(H10, q); // hour 10 folds the run, 1000 tokens
    putRun(db, RUN_A, usage(5000));
    turn(db, RUN_A, at(H14, 5), 0.30);
    await sampleHour(H14, q); // hour 14 folds it too — 6000 across the table

    db.exec("UPDATE usage_hourly SET meta = meta - 'folded_runs'");
    check("the pre-1356 shape double-counts, as measured", sumTokens(buckets(db)), 6000);

    const repaired = await repairDisplacedBuckets(tickAt(H15), q);
    check("both legacy buckets are re-sampled on the unaudited reason", repaired.unaudited.length, 2);
    check("nothing is reported as displaced — they carried no audit", repaired.displaced.length, 0);
    check("…and the total is the run's real total", sumTokens(buckets(db)), 5000);

    const again = await repairDisplacedBuckets(tickAt(H15), q);
    check("a second pass finds them audited and leaves them alone", again.unaudited.length, 0);
  }

  console.log(`\n── §2d an UPPERCASE run id in spend_log still matches ──────`);
  {
    /* Round 1355's non-blocking note. `folded_runs` and the anti-join's
     * `b.run_id::text` are lowercase-canonical because Postgres renders every
     * uuid that way; `spend_log.meta->>'run_id'` is free text. Without
     * `lower()` on the spend side, an uppercase id would make the later turn
     * invisible to both the anti-join and the repair audit, and the double
     * fold would come back silently. Zero such rows exist live — which is
     * exactly why it needs a check rather than a comment.
     */
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10);
    await sampleHour(H10, q);
    putRun(db, RUN_A, usage(5000));
    turn(db, RUN_A.toUpperCase(), at(H14, 5), 0.30); // same run, shouted
    await sampleHour(H14, q);

    const repaired = await repairDisplacedBuckets(tickAt(H15), q);
    check("hour 10 is found displaced by the uppercase-id turn", repaired.displaced.length, 1);
    check("…and the table sums to the run's real total", sumTokens(buckets(db)), 5000);
  }

  console.log(`\n── §3 the ordinary case: a run that lives in one hour ──────`);
  {
    reset(db);
    putRun(db, RUN_B, usage(777));
    turn(db, RUN_B, at(H10, 5), 0.05);
    turn(db, RUN_B, at(H10, 40), 0.05); // two turns, same hour
    const h10 = await sampleHour(H10, q);
    check("counted once despite two spend rows in the bucket", h10.tokens_in, 777);
    check("run_count counts SPEND ROWS, which is what it always meant", h10.run_count, 2);
  }

  console.log(`\n── §4 cost is per-row and must not be deduped ──────────────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000));
    turn(db, RUN_A, at(H10, 5), 0.10);
    turn(db, RUN_A, at(H11, 5), 0.20);
    const h10 = await sampleHour(H10, q);
    const h11 = await sampleHour(H11, q);
    check("hour 10 keeps its own turn's USD", h10.shadow_usd, 0.1);
    check("hour 11 keeps its own turn's USD", h11.shadow_usd, 0.2);
    check("…so total cost is still every turn, summed", h10.shadow_usd + h11.shadow_usd, 0.30000000000000004);
  }

  console.log(`\n── §5 sub-agent usage adds on top, once ────────────────────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000), [usage(30), usage(70)]);
    turn(db, RUN_A, at(H10, 5), 0.10);
    turn(db, RUN_A, at(H11, 5), 0.20);
    const h10 = await sampleHour(H10, q);
    const h11 = await sampleHour(H11, q);
    check("no sub-agent tokens in the hour the run does not belong to", h10.tokens_in, 0);
    check("subagent_count is 0 there too", h10.meta["subagent_count"], 0);
    check("parent + both sub-agents, in the run's own hour", h11.tokens_in, 1100);
    check("…counted as two sub-agents, not four", h11.meta["subagent_count"], 2);
  }

  console.log(`\n── §6 a bucket whose runs all continue later is empty ──────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000));
    putRun(db, RUN_B, usage(2000));
    turn(db, RUN_A, at(H10, 5), 0.10);
    turn(db, RUN_B, at(H10, 6), 0.10);
    turn(db, RUN_A, at(H12, 5), 0.10);
    turn(db, RUN_B, at(H12, 6), 0.10);
    const h10 = await sampleHour(H10, q);
    check("two runs billed, neither settled here → zero tokens", h10.tokens_in, 0);
    check("…but the cost of their turns is still recorded", h10.shadow_usd, 0.2);
    check("…and the bucket is a real zero row, not a hole", h10.bucket_start, H10.toISOString());
  }

  console.log(`\n── §7 idempotence survives the change ──────────────────────`);
  {
    reset(db);
    putRun(db, RUN_A, usage(1000), [usage(30)]);
    turn(db, RUN_A, at(H10, 5), 0.10);
    turn(db, RUN_A, at(H11, 5), 0.20);
    const one = await sampleHour(H11, q);
    const two = await sampleHour(H11, q);
    const strip = (s: typeof one): string =>
      JSON.stringify({ ...s, sampled_at: "<advances>" });
    check("sampling the same hour twice is byte-identical but for sampled_at", strip(two), strip(one));
    check("…and sampled_at DID advance", two.sampled_at >= one.sampled_at, true);
  }

  console.log(`\n── plan shape: the anti-join is one pass, not one per run ──`);
  {
    // EXPLAIN cannot live inside the wrapping CTE `query` uses, so this goes
    // through `exec` and is read as text.
    const text = db.exec(
      `EXPLAIN (FORMAT TEXT)
       SELECT 1 FROM (SELECT DISTINCT (s.meta->>'run_id')::uuid AS run_id
                        FROM spend_log s
                       WHERE s.provider = 'claude-code'
                         AND s.created_at >= ${lit(H10.toISOString())}::timestamptz
                         AND s.created_at <  ${lit(H11.toISOString())}::timestamptz) b
        WHERE NOT EXISTS (SELECT 1 FROM spend_log s2
                           WHERE s2.provider = 'claude-code'
                             AND s2.created_at >= ${lit(H11.toISOString())}::timestamptz
                             AND lower(s2.meta->>'run_id') = b.run_id::text)`,
    );
    // Informational, not an assertion: on a table of a dozen rows Postgres
    // picks a seq scan whatever the shape, so asserting "Anti Join" here would
    // be asserting the planner's mood. Printed so a reviewer looking at real
    // volume can see what it chose — the shape is written to be ONE anti-join
    // pass rather than one subquery per candidate run.
    console.log(text.trimEnd().split("\n").map((l) => `        ${l}`).join("\n"));
  }

  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — usage fold (scratch db: ${SCRATCH_DB})`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
