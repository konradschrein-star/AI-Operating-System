/**
 * check-working-sql-agreement.ts — the JS/SQL agreement proof for `working_ms`,
 * as a repeatable check instead of a one-off transcript (U5).
 *
 * Round 303 proved `workingTimeFromTimestamps()` and `WORKING_MS_SQL` agree by
 * hand, into `docs/plan/artifacts/phase300/working-time-agreement.md`; the
 * round-307 reviewer had to write their own script to re-verify it. Round 308
 * changes the SQL fragment (review finding 6: sub-millisecond truncation), so
 * the proof has to be re-runnable by whoever reads the diff. This is that
 * script. It imports `WORKING_MS_SQL` — it never retypes it — so what it tests
 * is byte-identical to what the team endpoint ships.
 *
 * Two parts:
 *
 *   A. SYNTHETIC — threads built here, including the µs-precision stamps that
 *      used to make the two paths disagree. Deterministic; no live data can
 *      make it pass or fail by accident.
 *   B. LIVE — every run of this project plus three real chats: entry-gap sum
 *      from Postgres vs the same sum from the JS core over the same `ts` array.
 *
 * Both parts fail the process (exit 1) on any Δ.
 *
 * ── Why psql and not `pg` ────────────────────────────────────────────────
 * This file lives in the repo-root `scripts/` tree, which has no
 * `node_modules`: bare `import { Pool } from "pg"` does not resolve from here
 * (verified: MODULE_NOT_FOUND — the same limitation serve-v3-7798.ts documents
 * for `hono`), and NF4 forbids adding a dependency to make it. Reaching into
 * `../../forge-control/node_modules/` would also break the standalone `tsc`
 * gate, which has no @types/pg on its path. `psql` is already the interface
 * every other DB step of this phase uses, and DATABASE_URL is already the way
 * in, so the query goes through a child process and comes back as JSON.
 *
 * READ-ONLY: SELECTs only, and part A's threads are literals — nothing here
 * writes a row.
 *
 * Run:
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-working-sql-agreement.ts
 *
 * Typecheck (outside forge-control's tsconfig `include`, so it needs its own
 * invocation with the same compiler options):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/check-working-sql-agreement.ts
 */

import { execFileSync } from "node:child_process";
import {
  WORKING_MS_SQL,
  workingTimeFromTimestamps,
} from "../../forge-control/src/routes/working-time.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "check-working-sql-agreement: DATABASE_URL is not set.\n" +
      "  set -a; . /opt/ai-os/.secrets/forge-control.env; set +a",
  );
  process.exit(2);
}

/**
 * THE CONNECTION STRING NEVER GOES INTO ARGV (round 807 finding 3).
 *
 * This script used to pass DATABASE_URL — `postgres://postgres:<PASSWORD>@…` —
 * as psql's first argument. Node's failed-exec `Error.message` is
 * `Command failed: <argv verbatim>`, and the catch below prints it, so any psql
 * failure wrote the postgres superuser password to stderr and from there into
 * the transcript of whatever agent ran the check — i.e. into `runs.thread`,
 * permanently. The identical defect in `phase800/secret-sentinel.cjs` is what
 * round 807 caught; this is the same bug in the same repo, fixed the same way.
 *
 * argv is world-readable via /proc/<pid>/cmdline; a child's environment is not
 * (/proc/<pid>/environ is uid-restricted). So the password travels in
 * PGPASSWORD, the address travels in -h/-p/-U/-d, and `scrub()` strips the
 * password from every diagnostic unconditionally as a second line of defence.
 */
const PG = ((): { args: readonly string[]; env: NodeJS.ProcessEnv; scrub: (s: string) => string } => {
  let dsn: URL;
  try {
    dsn = new URL(DATABASE_URL);
  } catch {
    // Interpolate NOTHING: the URL TypeError carries the raw value on `.input`.
    console.error(
      "check-working-sql-agreement: DATABASE_URL is not a parseable URL (value withheld — it contains the password).",
    );
    process.exit(2);
  }
  const password = decodeURIComponent(dsn.password || "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  if (password) env.PGPASSWORD = password;
  return {
    args: [
      "-h", dsn.hostname || "127.0.0.1",
      "-p", dsn.port || "5432",
      "-U", decodeURIComponent(dsn.username || "") || "postgres",
      "-d", decodeURIComponent(dsn.pathname.replace(/^\//, "")) || "content_forge",
    ],
    env,
    scrub: (s: string) => (password ? s.split(password).join("<pgpassword-redacted>") : s),
  };
})();

/** This project — the fleet the round-303 artifact tabulated. */
const PROJECT_ID = "8ea0cc08-28d9-4301-9f28-c98e1c5d6838";
/** Real chats worth including: long, human-paced threads full of over-cap gaps,
 *  which is the population the cap exists for and the project fleet is not.
 *  `11dd264b…` is review finding 1's chat. */
const EXTRA_RUN_IDS = [
  "bfd1283a-b71b-4f35-b577-7d09aad803f2",
  "11dd264b-f173-44d7-ada4-f1eb39fb4abd",
  "da286217-340c-4c11-bee3-5304fa346df4",
];

/** Dollar-quote tag for the one string this script hands to psql. */
const TAG = "$wsql$";

/**
 * One `psql -tA -c` returning a single JSON scalar, parsed.
 *
 * Throws with the query and stderr on failure — a check that swallowed a
 * database error would report agreement it never measured.
 */
function psqlJson<T>(sql: string): T {
  let raw: string;
  try {
    raw = execFileSync("psql", [...PG.args, "-tA", "-c", sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: PG.env,
    });
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      PG.scrub(`psql failed: ${err.stderr?.trim() || err.message}\n--- query ---\n${sql}`),
    );
  }
  const text = raw.trim();
  if (text === "") throw new Error(`psql returned nothing for:\n${sql}`);
  return JSON.parse(text) as T;
}

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

/**
 * Run the shipped fragment over an arbitrary thread literal. The fragment's
 * default alias is `r.thread`, so a one-row sub-select named `r` is all it
 * needs — the same text the team endpoint embeds, no rewrite.
 */
function sqlWorkingMs(thread: { ts: string }[]): number {
  const json = JSON.stringify(thread);
  // The payload is built in this file from the literals below, but assert
  // rather than assume: an unescapable delimiter collision must be a loud
  // failure, never a silently mangled query.
  if (json.includes(TAG)) throw new Error(`thread literal contains the quote tag ${TAG}`);
  return psqlJson<number>(
    `SELECT to_json(${WORKING_MS_SQL})
       FROM (SELECT ${TAG}${json}${TAG}::jsonb AS thread) r`,
  );
}

const entry = (ts: string): { ts: string } => ({ ts });

interface SyntheticCase {
  name: string;
  thread: { ts: string }[];
  /** Hand-computed, in the comment on each case. */
  expected: number;
}

// ── Part A: synthetic threads ─────────────────────────────────────────────
const SYNTHETIC: SyntheticCase[] = [
  {
    // 30s + 15s, both under the cap.
    name: "plain ISO stamps, both gaps under the cap",
    thread: [
      entry("2026-08-05T12:00:00.000Z"),
      entry("2026-08-05T12:00:30.000Z"),
      entry("2026-08-05T12:00:45.000Z"),
    ],
    expected: 45_000,
  },
  {
    // 30s counts, 300s is over the cap → 0. The `CASE`, not `least()`.
    name: "an over-cap gap contributes 0, not the cap",
    thread: [
      entry("2026-08-05T12:00:00.000Z"),
      entry("2026-08-05T12:00:30.000Z"),
      entry("2026-08-05T12:05:30.000Z"),
    ],
    expected: 30_000,
  },
  {
    // REVIEW FINDING 6, the exact divergence. Postgres microsecond rendering:
    //   raw:        …19.674825 → …20.675325 = 1000.5 ms
    //   truncated:  …674 → …675             = 1001 ms — which is what the JS
    //   core gets, because Date.parse keeps three fractional digits and drops
    //   the rest (measured: .674825, .674999 and .6745 all parse to …674).
    // Before the fix the SQL answered 1000.5 — a fractional working_ms — and
    // the core answered 1001.
    name: "µs-precision stamps agree with the JS core (finding 6)",
    thread: [
      entry("2026-07-30 16:21:19.674825+00"),
      entry("2026-07-30 16:21:20.675325+00"),
    ],
    expected: 1_001,
  },
  {
    // Chained µs stamps: trunc per stamp gives 674, 675, 676 → 1 + 1 = 2.
    // Truncating the GAP instead would give 0 + 0 = 0 (each raw gap is 0.5 and
    // 0.675) — which is why the fix truncates the stamps, not the difference.
    name: "chained µs stamps truncate per stamp, not per gap",
    thread: [
      entry("2026-07-30 16:21:19.674825+00"),
      entry("2026-07-30 16:21:19.675325+00"),
      entry("2026-07-30 16:21:19.676000+00"),
    ],
    expected: 2,
  },
  {
    // The malformed entry is filtered before the cast; its neighbours join
    // into one 40s gap, then 30s. Same as the core's skip-don't-zero rule.
    name: "malformed stamp filtered, neighbours join",
    thread: [
      entry("2026-08-05T12:00:00.000Z"),
      entry("sometime tuesday"),
      entry("2026-08-05T12:00:40.000Z"),
      entry("2026-08-05T12:01:10.000Z"),
    ],
    expected: 70_000,
  },
  {
    // Out of order: +60s, −30s (negative → 0), +60s.
    name: "out-of-order stamps give no negative credit",
    thread: [
      entry("2026-08-05T12:00:00.000Z"),
      entry("2026-08-05T12:01:00.000Z"),
      entry("2026-08-05T12:00:30.000Z"),
      entry("2026-08-05T12:01:30.000Z"),
    ],
    expected: 120_000,
  },
  { name: "single entry → 0", thread: [entry("2026-08-05T12:00:00.000Z")], expected: 0 },
  { name: "empty thread → 0", thread: [], expected: 0 },
];

interface LiveRow {
  id: string;
  role: string | null;
  status: string;
  sql_ms: number;
  ts_list: unknown[];
}

console.log("── A. synthetic threads: SQL fragment vs JS core ─────────────");
for (const c of SYNTHETIC) {
  const sql = sqlWorkingMs(c.thread);
  const js = workingTimeFromTimestamps(c.thread.map((e) => e.ts)).working_ms;
  check(`${c.name} — JS`, js, c.expected);
  check(`${c.name} — SQL`, sql, c.expected);
  check(`${c.name} — Δ`, sql - js, 0);
}

console.log("\n── B. live data: every run of this project + three chats ─────");
const idList = EXTRA_RUN_IDS.map((id) => `'${id}'`).join(",");
const rows = psqlJson<LiveRow[]>(
  `SELECT coalesce(json_agg(x ORDER BY x.started_at), '[]'::json) FROM (
     SELECT r.id::text AS id,
            r.metadata->>'role' AS role,
            r.status,
            r.started_at,
            (${WORKING_MS_SQL})::bigint AS sql_ms,
            coalesce(
              (SELECT jsonb_agg(e.val->'ts' ORDER BY e.ord)
                 FROM jsonb_array_elements(r.thread) WITH ORDINALITY AS e(val, ord)),
              '[]'::jsonb
            ) AS ts_list
       FROM runs r
      WHERE r.metadata->>'project_id' = '${PROJECT_ID}'
         OR r.id IN (${idList})
   ) x`,
);

let mismatches = 0;
let skippedTotal = 0;
let entriesTotal = 0;
for (const row of rows) {
  const js = workingTimeFromTimestamps(row.ts_list);
  const sql = Number(row.sql_ms);
  skippedTotal += js.skipped_ts;
  entriesTotal += row.ts_list.length;
  const ok = sql === js.working_ms;
  if (!ok) {
    mismatches += 1;
    failures += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${row.id.slice(0, 8)}  ${(row.role ?? "chat").padEnd(9)} ` +
      `${row.status.padEnd(9)} entries=${String(row.ts_list.length).padStart(4)} ` +
      `js=${String(js.working_ms).padStart(9)} sql=${String(sql).padStart(9)} ` +
      `Δ=${sql - js.working_ms} skipped=${js.skipped_ts}`,
  );
}

console.log(
  `\nrows: ${rows.length}   thread entries: ${entriesTotal}   ` +
    `mismatches: ${mismatches}   skipped timestamps: ${skippedTotal}`,
);
// A green run over zero rows would prove nothing at all.
check("live comparison ran over a non-trivial population (≥ 10 rows)", rows.length >= 10, true);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — JS/SQL working-time agreement (U5)`,
);
process.exit(failures === 0 ? 0 : 1);
