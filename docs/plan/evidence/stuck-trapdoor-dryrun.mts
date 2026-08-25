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
  /** Set so scenario G can prove the pre-image self-join does not shadow
   *  `runs.metadata` in the RETURNING list. */
  pendingInput?: string | null;
}): Promise<string> {
  const id = probeId();
  const thread = [{ role: "user", content: "do the thing", ts: "2026-08-25T08:00:00Z", kind: "text" }];
  const metadata: Record<string, string> = {};
  if (opts.sessionId) metadata.cc_session_id = opts.sessionId;
  if (opts.pendingInput) metadata.pending_input = opts.pendingInput;
  await q(
    `INSERT INTO runs (id, title, prompt, worker, status, stuck_signal, thread, metadata, last_heartbeat_at)
     VALUES ($1,'stuck-trapdoor-dryrun task','p','project:builder',$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [
      id,
      opts.status,
      opts.stuckSignal ?? null,
      JSON.stringify(thread),
      JSON.stringify(metadata),
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
 * `completeRun()`'s guarded branch (executor.ts:533-546), COMPOSED THE SAME WAY
 * THE PRODUCT COMPOSES IT — not a simplification of it.
 *
 * ROUND 4, why this changed. Round 3's reviewer found that the earlier version
 * of this function ran a plainer statement: `WHERE id = $1 AND <guard>
 * RETURNING id`. The product's real statement is
 * `UPDATE … FROM (SELECT status AS prev … FOR UPDATE) old WHERE runs.id = $1
 * AND <guard> RETURNING old.prev, …` — the riskiest new SQL in the diff — and
 * nothing in the shipped harness executed it. The reviewer reconstructed it by
 * hand and it was correct, but a fact re-derived by hand at review time is not
 * a gate; the next change to it would land unexecuted again. So the harness now
 * runs the real thing.
 *
 * TWO THINGS KEEP IT HONEST, because a copy of a statement is a copy that can
 * drift:
 *  1. `COMPLETABLE_STATUS_SQL` is IMPORTED from lib/run-liveness.ts — one
 *     definition, never retyped.
 *  2. The three fragments the guarded branch composes are asserted, verbatim,
 *     against executor.ts's SOURCE below (`assertProductFragment`). Change the
 *     product's self-join, its `runs.id = $1` predicate or its RETURNING list
 *     and this gate goes red at startup instead of quietly testing a statement
 *     the product no longer runs.
 *
 * The fragments are matched WITHOUT their leading newline on purpose: in
 * executor.ts they live inside template literals as the two characters `\` `n`,
 * not as a real line break, so a real-newline needle would never match the
 * source and the drift guard would be inert.
 */
const { readFile: readFile_ } = await import("node:fs/promises");
const EXECUTOR_SRC = await readFile_(`${ROOT}/executor.ts`, "utf8");

function assertProductFragment(label: string, fragment: string): string {
  if (!EXECUTOR_SRC.includes(fragment)) {
    throw new Error(
      `DRIFT: executor.ts no longer contains the ${label} fragment this harness executes:\n` +
        `  ${JSON.stringify(fragment)}\n` +
        `Either the product's completion SQL changed (update this harness AND say so in the ` +
        `proof doc) or ROOT resolved to the wrong checkout (${ROOT}).`,
    );
  }
  return fragment;
}

/* executor.ts:511-518 — `preImage`, `idPredicate`, `returning`, for
 * guardRunning = true. */
const PRE_IMAGE = assertProductFragment(
  "pre-image self-join",
  "FROM (SELECT status AS prev FROM runs WHERE id = $1 FOR UPDATE) old",
);
const ID_PREDICATE = assertProductFragment("qualified id predicate", "runs.id = $1");
const RETURNING = assertProductFragment(
  "RETURNING list",
  "RETURNING old.prev, metadata->>'pending_input' AS pending_input",
);
/* …and the non-'stuck' SET list it is spliced into (executor.ts:536-543). */
assertProductFragment("completion SET list", "completed_at = now(),");

interface CompletionOutcome {
  rowCount: number;
  /** The pre-image the UPDATE actually matched — `null` when no row matched.
   *  rowCount alone can no longer identify it: COMPLETABLE_STATUS_SQL admits
   *  TWO prior statuses, which is exactly why the self-join exists. */
  prev: string | null;
  pendingInput: string | null;
}

async function attemptCompletionFull(runId: string): Promise<CompletionOutcome> {
  const entry = { role: "assistant", content: "done", ts: new Date().toISOString(), kind: "text" };
  const params: unknown[] = [runId, JSON.stringify([entry]), "completed"];
  const res = await pool.query<{ prev: string; pending_input: string | null }>(
    `UPDATE runs
        SET thread = thread || $2::jsonb,
            status = $${params.length},
            stuck_signal = NULL,
            completed_at = now(),
            updated_at = now(),
            last_heartbeat_at = now()
         ${PRE_IMAGE}
      WHERE ${ID_PREDICATE}
           AND ${COMPLETABLE_STATUS_SQL}
      ${RETURNING}`,
    params,
  );
  return {
    rowCount: res.rowCount ?? 0,
    prev: res.rows[0]?.prev ?? null,
    pendingInput: res.rows[0]?.pending_input ?? null,
  };
}

/** Kept for the scenarios that only care whether the write landed. */
async function attemptCompletion(runId: string): Promise<number> {
  return (await attemptCompletionFull(runId)).rowCount;
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

console.log("\n=== G. the PRODUCT statement over every prior status — rowCount AND pre-image ===");
{
  /* Round 4. D/E/F above already cover three of these, but they read only
   * rowCount and the row afterwards. The self-join's job is to report WHICH
   * pre-image the UPDATE matched, and that value drives completionTransition
   * and the reclaim warning in executor.ts:562-575 — so assert it directly,
   * across the whole status space rather than the three statuses that happened
   * to be interesting. `prev` must be null whenever nothing matched: a
   * non-null prev on a rowCount 0 would mean the FOR UPDATE sub-select
   * produced a row the outer WHERE then discarded, which would make the
   * reported pre-image a lie. */
  const cases: Array<{
    label: string;
    status: string;
    signal?: string | null;
    rowCount: number;
    prev: string | null;
  }> = [
    { label: "running", status: "running", rowCount: 1, prev: "running" },
    { label: "stuck/heartbeat_stale", status: "stuck", signal: "heartbeat_stale", rowCount: 1, prev: "stuck" },
    { label: "stuck/timeout", status: "stuck", signal: "timeout", rowCount: 0, prev: null },
    { label: "stuck/NULL signal", status: "stuck", signal: null, rowCount: 0, prev: null },
    { label: "cancelled", status: "cancelled", rowCount: 0, prev: null },
    { label: "paused", status: "paused", rowCount: 0, prev: null },
    { label: "failed", status: "failed", rowCount: 0, prev: null },
    { label: "completed", status: "completed", rowCount: 0, prev: null },
    { label: "queued", status: "queued", rowCount: 0, prev: null },
  ];

  for (const c of cases) {
    const runId = await seedRun({ status: c.status, stuckSignal: c.signal ?? null });
    const [before] = await q(`SELECT status, stuck_signal, thread FROM runs WHERE id = $1`, [runId]);
    const out = await attemptCompletionFull(runId);
    check(`G: ${c.label} -> rowCount ${c.rowCount}`, out.rowCount === c.rowCount, String(out.rowCount));
    check(`G: ${c.label} -> prev ${String(c.prev)}`, out.prev === c.prev, String(out.prev));
    const [after] = await q(`SELECT status, stuck_signal, thread FROM runs WHERE id = $1`, [runId]);
    if (c.rowCount === 0) {
      // The refusal must be total, not partial: no status change, no signal
      // cleared, no assistant turn appended by the `thread || $2` in the SET.
      check(
        `G: ${c.label} -> row untouched`,
        after.status === before.status &&
          String(after.stuck_signal) === String(before.stuck_signal) &&
          JSON.stringify(after.thread) === JSON.stringify(before.thread),
        `${after.status}/${after.stuck_signal}`,
      );
    } else {
      check(`G: ${c.label} -> now 'completed'`, after.status === "completed", after.status);
    }
  }

  // pending_input rides in the RETURNING list beside `old.prev`. `old` exposes
  // only `prev`, so `metadata` there resolves to runs.metadata — but that is
  // the kind of thing that is true until someone adds a column to the
  // sub-select, so measure it rather than reason about it.
  const withInput = await seedRun({
    status: "stuck",
    stuckSignal: "heartbeat_stale",
    pendingInput: "the operator asked a question",
  });
  const gotInput = await attemptCompletionFull(withInput);
  check("G: pending_input survives the self-join", gotInput.pendingInput === "the operator asked a question", String(gotInput.pendingInput));

  // An id no row carries: 0, `prev` null, and no crash. The FOR UPDATE
  // sub-select returning nothing must not make the whole statement throw.
  const absent = await attemptCompletionFull("dead0000-0000-4000-8000-ffffffffffff");
  check("G: absent id -> rowCount 0", absent.rowCount === 0, String(absent.rowCount));
  check("G: absent id -> prev null, no crash", absent.prev === null, String(absent.prev));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
