/**
 * T3 microbenchmark: does pool saturation (max=5) on `thread = thread || …`
 * appends explain a heartbeat UPDATE stalling past HEARTBEAT_STUCK_THRESHOLD_MS
 * (90000ms)? Run against a THROWAWAY database only — never content_forge.
 *
 * Model: docs/plan/evidence/r860-dryrun.mts (same createRequire('pg') trick,
 * same env-var gate, same "refuse without an explicit throwaway URL" shape).
 *
 * The two UPDATE strings below are copied VERBATIM from the production code so
 * a reviewer can diff them against the source instead of trusting a paraphrase:
 *   - appendThreadEntry: forge-control/src/executor.ts:656-665
 *   - heartbeat:          forge-control/src/executor.ts:729-736
 * executor.ts itself is NOT imported: it starts polling loops as a side effect
 * of module load (main() runs at the bottom of the file), which is unsafe to
 * trigger from a probe. Only project-tick.ts / projects.ts style pure modules
 * are safe to import directly, per r860-dryrun.mts; this probe needs neither.
 */

import { randomBytes } from "node:crypto";

const URL_ = process.env.DRYRUN_DATABASE_URL ?? "";
if (!URL_) {
  throw new Error(
    "DRYRUN_DATABASE_URL is not set — point it at a THROWAWAY database, never content_forge",
  );
}
if (/\/content_forge(\?|$)/.test(URL_)) {
  throw new Error(
    `DRYRUN_DATABASE_URL ends in /content_forge — refusing to run against the live database: ${URL_}`,
  );
}

// Resolve `pg` from forge-control's own node_modules, the same way
// r860-dryrun.mts does it — this file lives under docs/, which has no
// package.json of its own, so a bare `import "pg"` would not resolve.
const ROOT = new URL("../../../forge-control/src", import.meta.url).pathname;
const { createRequire } = await import("node:module");
const pg = createRequire(`${ROOT}/`)("pg");

const POOL_MAX = 5; // forge-control/src/db/ai_os.ts:22 — the value under test
const pool = new pg.Pool({ connectionString: URL_, max: POOL_MAX });

// Verbatim from forge-control/src/executor.ts:658-664 (appendThreadEntry).
const APPEND_SQL = `UPDATE runs
        SET thread = thread || $2::jsonb,
            updated_at = now(),
            last_heartbeat_at = now()
      WHERE id = $1`;

// Verbatim from forge-control/src/executor.ts:732 (heartbeat).
const HEARTBEAT_SQL = `UPDATE runs SET last_heartbeat_at = now() WHERE id = $1 AND status = 'running'`;

// Seed sizes taken directly from measurement 1 in stuck-heartbeat-latency.md:
//   p50 pg_column_size(thread) over status='stuck' rows = 51953 bytes
//   p95 pg_column_size(thread) over status='stuck' rows = 446972 bytes
// Real threads are built from many small streamed entries (measured average
// ~433 bytes/turn: 644728 bytes / 1491 turns for the single worst stuck row,
// 2ef126b7). So each seed row is filled with that many ~433-byte entries
// rather than one giant blob, matching how appendThreadEntry actually grows a
// thread in production.
//
// Entry content is `randomBytes(...).toString("hex")`, NOT repeated
// characters: a first attempt padded with "x".repeat(N) and TOAST's pglz
// compression crushed a 447000-byte target down to an 11278-byte on-disk
// column (pg_column_size measures the stored, possibly-compressed size).
// Random hex is close to incompressible, so pg_column_size after seeding
// tracks the target within a few percent — see seedReport.actualBytes below.
// This is a conservative (pessimistic) proxy for real conversational JSON,
// which has some but not this little redundancy, so it upper-bounds rather
// than exactly reproduces the real TOAST/decompress cost.
const SEED_P50_BYTES = 51953;
const SEED_P95_BYTES = 446972;
const AVG_ENTRY_BYTES = 433;

function fillerEntry(i: number) {
  const pad = randomBytes(Math.round(AVG_ENTRY_BYTES / 2)).toString("hex");
  return {
    role: i % 2 === 0 ? "assistant" : "user",
    content: `turn ${i} streamed chunk ${pad}`,
    ts: new Date(0).toISOString(),
    kind: "text",
  };
}

async function seedThread(id: string, targetBytes: number) {
  const entries: unknown[] = [];
  let approxBytes = 2; // "[]"
  let i = 0;
  while (approxBytes < targetBytes) {
    const e = fillerEntry(i++);
    entries.push(e);
    approxBytes += JSON.stringify(e).length + 1;
  }
  await pool.query(
    `UPDATE runs SET thread = $2::jsonb, updated_at = now(), last_heartbeat_at = now() WHERE id = $1`,
    [id, JSON.stringify(entries)],
  );
  const [{ bytes }] = (
    await pool.query(`SELECT pg_column_size(thread) AS bytes FROM runs WHERE id = $1`, [id])
  ).rows as { bytes: number }[];
  return Number(bytes);
}

async function makeRun(status: string): Promise<string> {
  const [{ id }] = (
    await pool.query(
      `INSERT INTO runs (title, prompt, worker, status, thread, metadata)
       VALUES ('heartbeat-probe', 'p', 'project:builder', $1, '[]'::jsonb, '{}'::jsonb)
       RETURNING id::text`,
      [status],
    )
  ).rows as { id: string }[];
  return id;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runLevel(n: number, durationMs: number) {
  // n append-worker rows, split between p50 and p95 seed sizes (n=1 uses the
  // worst realistic case, p95, since a single stuck run is the common report).
  const appendRunIds: string[] = [];
  const seedReport: { id: string; targetBytes: number; actualBytes: number }[] = [];
  for (let i = 0; i < n; i++) {
    const target = n === 1 ? SEED_P95_BYTES : i % 2 === 0 ? SEED_P50_BYTES : SEED_P95_BYTES;
    const id = await makeRun("running");
    const actualBytes = await seedThread(id, target);
    appendRunIds.push(id);
    seedReport.push({ id, targetBytes: target, actualBytes });
  }
  const hbRunId = await makeRun("running");

  let stop = false;
  const appendErrors: string[] = [];
  const appendWorkers = appendRunIds.map(async (id) => {
    let i = 0;
    while (!stop) {
      try {
        await pool.query(APPEND_SQL, [id, JSON.stringify([fillerEntry(i++)])]);
      } catch (e) {
        appendErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  });

  const hbLatenciesMs: number[] = [];
  const hbErrors: string[] = [];
  const hbTimer = (async () => {
    const ticks = Math.max(1, Math.floor(durationMs / 5000));
    for (let t = 0; t < ticks; t++) {
      await new Promise((r) => setTimeout(r, 5000));
      const fired = performance.now();
      try {
        await pool.query(HEARTBEAT_SQL, [hbRunId]);
        hbLatenciesMs.push(performance.now() - fired);
      } catch (e) {
        hbErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  })();

  await hbTimer;
  stop = true;
  await Promise.all(appendWorkers);

  const sorted = [...hbLatenciesMs].sort((a, b) => a - b);
  return {
    n,
    poolMax: POOL_MAX,
    seedReport,
    hbSamples: hbLatenciesMs.length,
    hbP50Ms: Number(percentile(sorted, 50).toFixed(1)),
    hbP95Ms: Number(percentile(sorted, 95).toFixed(1)),
    hbMaxMs: sorted.length ? Number(sorted[sorted.length - 1].toFixed(1)) : NaN,
    appendErrors: appendErrors.slice(0, 3),
    hbErrors: hbErrors.slice(0, 3),
  };
}

async function main() {
  const levels = [1, 5, 10, 20];
  const durationMs = 30_000; // ~6 heartbeat ticks per level
  const results = [];
  for (const n of levels) {
    console.log(`\n=== N=${n} concurrent appenders, pool max=${POOL_MAX}, ${durationMs}ms window ===`);
    const r = await runLevel(n, durationMs);
    console.log(JSON.stringify(r, null, 2));
    results.push(r);
  }
  console.log("\n=== SUMMARY (heartbeat UPDATE latency, ms: interval-fired -> UPDATE resolved) ===");
  console.log(
    results
      .map((r) => `N=${r.n}: p50=${r.hbP50Ms}ms p95=${r.hbP95Ms}ms max=${r.hbMaxMs}ms samples=${r.hbSamples}`)
      .join("\n"),
  );
  await pool.end();
}

await main();
