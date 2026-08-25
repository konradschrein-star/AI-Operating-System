/**
 * Stuck-trapdoor dry-run: the watchdog's flip/hold decision
 * (`lib/run-liveness.ts`'s `watchdogVerdict` + `liveSessionIdsAmong` +
 * `readEngineCmdlines`, walking the REAL /proc) and `completeRun`'s
 * `COMPLETABLE_STATUS_SQL` reclaim guard, against a throwaway Postgres.
 * `content_forge` is NEVER touched — see the isolation assertion in the
 * companion proof doc.
 *
 * Modelled on the existing `docs/plan/evidence/r860-dryrun.mts`: same
 * bootstrap, same `check()` accumulator, same "resolve forge-control/src from
 * this file's own URL" trick, same `createRequire` resolution of `pg` from
 * forge-control/node_modules.
 *
 * `stuckWatchdogTick()` and `completeRun()` themselves are NOT exported from
 * executor.ts (this task's write-set does not include executor.ts, so they
 * cannot be exported here either) — every DECISION function they call IS
 * imported live from lib/run-liveness.ts, and the one SQL PRECONDITION this
 * project exists to fix (`COMPLETABLE_STATUS_SQL`) is imported rather than
 * retyped. The surrounding UPDATE statements below reproduce
 * executor.ts:1505-1529 (the watchdog's refresh/flip) and the shape of
 * `completeRun`'s guarded branch (executor.ts:533-546) verbatim, with line
 * references, precisely so a future drift between this harness and the
 * product is a diff a reviewer can see, not a guess.
 */
const URL_ = process.env.DRYRUN_DATABASE_URL ?? "";
if (!URL_) {
  throw new Error(
    "DRYRUN_DATABASE_URL is not set — point it at a THROWAWAY database, never content_forge",
  );
}
if (/content_forge/i.test(URL_)) {
  throw new Error(
    "DRYRUN_DATABASE_URL names content_forge — refusing to run a dry-run harness against the live database",
  );
}
process.env.DATABASE_URL = URL_;
process.env.AI_OS_DATABASE_URL = URL_;

// Resolved from this file's own location (docs/plan/evidence -> repo root), so
// the script runs from any checkout or worktree without editing.
const ROOT = new URL("../../../forge-control/src", import.meta.url).pathname;
const { COMPLETABLE_STATUS_SQL, watchdogVerdict, liveSessionIdsAmong, readEngineCmdlines } =
  await import(`${ROOT}/lib/run-liveness.ts`);
// `pg` is resolved from forge-control's node_modules rather than from this
// file's directory — the script lives under docs/, which has no package of
// its own, so a bare `import "pg"` would not resolve.
const { createRequire } = await import("node:module");
const pg = createRequire(`${ROOT}/`)("pg");
const { spawn } = await import("node:child_process");
const { randomUUID } = await import("node:crypto");

const pool = new pg.Pool({ connectionString: URL_ });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// The watchdog's own staleness threshold, read the SAME way executor.ts:109-110
// reads it. Not extracted as a named constant there (only COMPLETABLE_STATUS_SQL
// is), so the read expression is reproduced verbatim rather than the value
// being invented.
const HEARTBEAT_STUCK_THRESHOLD_MS = Number(
  process.env.HEARTBEAT_STUCK_THRESHOLD_MS ?? "90000",
);

// Every seeded row's id starts with this — the isolation assertion in the
// companion proof doc greps content_forge for it and expects zero rows.
const PROBE_PREFIX = "dead0000";
// gates-808.sh may run this gate from several worktrees concurrently against
// the SAME scratch database (see check-usage-fold.ts's header on why a shared
// scratch db is a real hazard). A bare per-process counter starting at 1
// would collide across processes on the uuid primary key; folding in the pid
// keeps ids unique across concurrent invocations without needing this script
// to own database lifecycle (unlike check-usage-fold.ts, this harness is
// pointed at a fixed, already-provisioned throwaway db — see the proof doc).
let seq = 0;
function probeId(): string {
  seq += 1;
  const pidPart = (process.pid % 0xffff).toString(16).padStart(4, "0");
  const seqPart = seq.toString(16).padStart(8, "0");
  return `${PROBE_PREFIX}-0000-4000-8000-${pidPart}${seqPart}`;
}

function staleTimestamp(marginMs = 60_000): string {
  return new Date(Date.now() - HEARTBEAT_STUCK_THRESHOLD_MS - marginMs).toISOString();
}

async function seedRun(opts: {
  status: string;
  stuckSignal?: string | null;
  lastHeartbeatAt?: string | null;
  sessionId?: string | null;
}): Promise<string> {
  const id = probeId();
  const thread = [{ role: "user", content: "do the thing", ts: "2026-08-25T08:00:00Z", kind: "text" }];
  await q(
    `INSERT INTO runs (id, title, prompt, worker, status, stuck_signal, thread, metadata, last_heartbeat_at)
     VALUES ($1,'stuck-trapdoor-dryrun task','p','project:builder',$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [
      id,
      opts.status,
      opts.stuckSignal ?? null,
      JSON.stringify(thread),
      JSON.stringify(opts.sessionId ? { cc_session_id: opts.sessionId } : {}),
      opts.lastHeartbeatAt ?? null,
    ],
  );
  return id;
}

/**
 * Mirrors `stuckWatchdogTick()` (executor.ts:1455-1543) for ONE candidate
 * row: the same staleness SELECT, ONE real /proc walk via the imported
 * `readEngineCmdlines()`, the imported pure `watchdogVerdict()` decision, then
 * either the refresh UPDATE (executor.ts:1505-1509) or the flip UPDATE
 * (executor.ts:1518-1529) — both reproduced verbatim since the function
 * itself is not exported.
 */
async function watchdogTickForRow(
  runId: string,
  ownedInProcess: boolean,
): Promise<"flipped" | "held" | "not-a-candidate"> {
  const candidates = await q(
    `SELECT id::text, metadata->>'cc_session_id' AS session_id
       FROM runs
      WHERE id = $1
        AND status = 'running'
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < now() - (interval '1 millisecond' * $2)`,
    [runId, HEARTBEAT_STUCK_THRESHOLD_MS],
  );
  if (candidates.length === 0) return "not-a-candidate";

  const cmdlines = await readEngineCmdlines();
  const liveSessionIds = liveSessionIdsAmong(
    candidates.map((r: { session_id: string | null }) => r.session_id),
    cmdlines,
  );
  const verdict = watchdogVerdict({
    ownedInProcess,
    sessionId: candidates[0].session_id,
    liveSessionIds,
  });

  if (verdict === "hold") {
    await q(
      `UPDATE runs SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'`,
      [runId],
    );
    return "held";
  }

  const flipped = await q(
    `UPDATE runs
        SET status = 'stuck',
            stuck_signal = COALESCE(stuck_signal, 'heartbeat_stale'),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND last_heartbeat_at IS NOT NULL
        AND last_heartbeat_at < now() - (interval '1 millisecond' * $2)
      RETURNING id`,
    [runId, HEARTBEAT_STUCK_THRESHOLD_MS],
  );
  return flipped.length > 0 ? "flipped" : "not-a-candidate";
}

/**
 * Mirrors `completeRun()`'s guarded branch (executor.ts:533-546) for a normal
 * (non-'stuck') completion. `COMPLETABLE_STATUS_SQL` is IMPORTED — the one SQL
 * precondition this whole project exists to widen — never retyped.
 */
async function attemptCompletion(runId: string): Promise<number> {
  const entry = { role: "assistant", content: "done", ts: new Date().toISOString(), kind: "text" };
  const res = await pool.query(
    `UPDATE runs
        SET thread = thread || $2::jsonb,
            status = 'completed',
            stuck_signal = NULL,
            completed_at = now(),
            updated_at = now(),
            last_heartbeat_at = now()
      WHERE id = $1
        AND ${COMPLETABLE_STATUS_SQL}
      RETURNING id`,
    [runId, JSON.stringify([entry])],
  );
  return res.rowCount ?? 0;
}

console.log("\n=== A. stale + NO in-process owner + NO live session -> flips to 'stuck' ===");
{
  const sid = `dryrun-sess-A-dead-${randomUUID()}`;
  const runId = await seedRun({ status: "running", lastHeartbeatAt: staleTimestamp(), sessionId: sid });
  const outcome = await watchdogTickForRow(runId, false);
  check("A: watchdog flips", outcome === "flipped", outcome);
  const [row] = await q(`SELECT status, stuck_signal FROM runs WHERE id = $1`, [runId]);
  check("A: status = 'stuck'", row.status === "stuck", row.status);
  check("A: stuck_signal = 'heartbeat_stale'", row.stuck_signal === "heartbeat_stale", String(row.stuck_signal));
}

console.log("\n=== B. same row, held by the in-process owner predicate -> does NOT flip ===");
{
  const sid = `dryrun-sess-B-owned-${randomUUID()}`;
  const runId = await seedRun({ status: "running", lastHeartbeatAt: staleTimestamp(), sessionId: sid });
  const [before] = await q(`SELECT last_heartbeat_at FROM runs WHERE id = $1`, [runId]);
  const outcome = await watchdogTickForRow(runId, true);
  check("B: watchdog holds", outcome === "held", outcome);
  const [row] = await q(`SELECT status, last_heartbeat_at FROM runs WHERE id = $1`, [runId]);
  check("B: status still 'running'", row.status === "running", row.status);
  check(
    "B: last_heartbeat_at refreshed (newer than the seeded stale value)",
    new Date(row.last_heartbeat_at).getTime() > new Date(before.last_heartbeat_at).getTime(),
  );
}

console.log("\n=== C. same row, live session id in the /proc cmdline snapshot -> does NOT flip ===");
{
  const sid = `dryrun-sess-C-live-${randomUUID()}`;
  // Real process, real /proc entry, no mock. `argv0` puts the session id in
  // the cmdline the way `claude --resume <id>` does — `bash -c` would exec
  // the single command away and lose it.
  const child = spawn("/bin/sleep", ["30"], { argv0: `claude --resume ${sid}`, stdio: "ignore" });
  try {
    // Give the kernel a moment to publish /proc/<pid>/cmdline before we walk it.
    await new Promise((r) => setTimeout(r, 200));
    const runId = await seedRun({ status: "running", lastHeartbeatAt: staleTimestamp(), sessionId: sid });
    const outcome = await watchdogTickForRow(runId, false);
    check("C: watchdog holds", outcome === "held", outcome);
    const [row] = await q(`SELECT status FROM runs WHERE id = $1`, [runId]);
    check("C: status still 'running'", row.status === "running", row.status);
  } finally {
    child.kill();
  }
}

console.log("\n=== D. stuck/heartbeat_stale + completion -> LANDS ===");
{
  const runId = await seedRun({ status: "stuck", stuckSignal: "heartbeat_stale" });
  const rowCount = await attemptCompletion(runId);
  check("D: rowCount 1", rowCount === 1, String(rowCount));
  const [row] = await q(`SELECT status, thread FROM runs WHERE id = $1`, [runId]);
  check("D: final status 'completed'", row.status === "completed", row.status);
  const thread = row.thread as Array<{ role: string; content: string }>;
  check(
    "D: assistant turn present in the thread",
    Array.isArray(thread) && thread.some((t) => t.role === "assistant" && t.content === "done"),
  );
}

console.log("\n=== E. stuck/timeout + completion -> REFUSED ===");
{
  const runId = await seedRun({ status: "stuck", stuckSignal: "timeout" });
  const rowCount = await attemptCompletion(runId);
  check("E: rowCount 0", rowCount === 0, String(rowCount));
  const [row] = await q(`SELECT status, stuck_signal, thread FROM runs WHERE id = $1`, [runId]);
  check("E: row untouched — status still 'stuck'", row.status === "stuck", row.status);
  check("E: row untouched — stuck_signal still 'timeout'", row.stuck_signal === "timeout", String(row.stuck_signal));
  const thread = row.thread as Array<{ role: string }>;
  check("E: row untouched — no assistant turn appended", !thread.some((t) => t.role === "assistant"));
}

console.log("\n=== F. cancelled + completion -> REFUSED ===");
{
  const runId = await seedRun({ status: "cancelled" });
  const rowCount = await attemptCompletion(runId);
  check("F: rowCount 0", rowCount === 0, String(rowCount));
  const [row] = await q(`SELECT status, thread FROM runs WHERE id = $1`, [runId]);
  check("F: row untouched — status still 'cancelled'", row.status === "cancelled", row.status);
  const thread = row.thread as Array<{ role: string }>;
  check("F: row untouched — no assistant turn appended", !thread.some((t) => t.role === "assistant"));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
