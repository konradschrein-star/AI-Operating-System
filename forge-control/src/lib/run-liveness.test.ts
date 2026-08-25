import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  COMPLETABLE_STATUS_SQL,
  liveSessionIdsAmong,
  watchdogVerdict,
  type WatchdogVerdict,
} from "./run-liveness.ts";

/* The session ids below are shaped like the real ones in
 * `runs.metadata.cc_session_id`, and the fake command line is separated the way
 * /proc/<pid>/cmdline actually is: by NUL bytes, so a `claude --resume <id>`
 * child's argv arrives as separate entries. That is exactly why the match under
 * test is a substring search rather than an equality test.
 *
 * The separator is built with String.fromCharCode(0) rather than written as a
 * literal: a RAW NUL byte in a source file makes grep report it as "binary file
 * matches" and silently blinds every grep-based gate in the repo.
 * src/lib/source-hygiene.test.ts caught precisely that mistake in this file. */
const SESSION = "6b1c2951-1f0b-4a26-9c1b-2f4a0a6d33aa";
const OTHER = "f874ba1b-0c5e-4f77-9a10-77c0d1d9be21";
const NUL = String.fromCharCode(0);
const CLAUDE_CMDLINE = [
  "claude",
  "-p",
  "--resume",
  SESSION,
  "--output-format",
  "stream-json",
].join(NUL);

function verdict(
  ownedInProcess: boolean,
  sessionId: string | null,
  live: readonly string[],
): WatchdogVerdict {
  return watchdogVerdict({
    ownedInProcess,
    sessionId,
    liveSessionIds: new Set(live),
  });
}

/* ── watchdogVerdict: all five input combinations ────────────────────────── */

test("W1: owned in process, no session id yet → hold", () => {
  // A turn claimed and started but not yet past saveCcSession(). The executor
  // is awaiting it right now; nothing about that is dead.
  assert.equal(verdict(true, null, []), "hold");
});

test("W2: owned in process AND a live /proc session → hold", () => {
  assert.equal(verdict(true, SESSION, [SESSION]), "hold");
});

test("W3: not owned in process, but a live /proc session → hold", () => {
  // The executor restarted and lost its inFlight map while the child survived.
  // This is the case the in-memory record cannot answer.
  assert.equal(verdict(false, SESSION, [SESSION]), "hold");
});

test("W4: not owned, session id present but NOT live → flip", () => {
  assert.equal(verdict(false, SESSION, [OTHER]), "flip");
});

test("W5: NO session id and NO in-process owner → FLIP", () => {
  // THE NEGATIVE CASE, and the whole reason the watchdog exists. A run nobody
  // can prove alive must still be caught: `hold` demands positive evidence, so
  // the absence of every instrument is never a reprieve.
  assert.equal(verdict(false, null, []), "flip");
  // …and an empty live set is exactly what an unreadable /proc produces, so a
  // broken instrument fails toward catching the run, not toward holding it.
  assert.equal(verdict(false, OTHER, []), "flip");
});

test("W6: a hold is never granted by a same-shaped id belonging to someone else", () => {
  assert.equal(verdict(false, SESSION, [OTHER]), "flip");
  assert.equal(verdict(false, OTHER, [SESSION]), "flip");
});

/* ── liveSessionIdsAmong: the /proc snapshot → session id bridge ──────────── */

test("L1: a claude cmdline carrying the session id proves that session live", () => {
  const live = liveSessionIdsAmong([SESSION, OTHER], [CLAUDE_CMDLINE]);
  assert.equal(live.has(SESSION), true);
  assert.equal(live.has(OTHER), false);
});

test("L2: no cmdlines (unreadable /proc) proves nothing live", () => {
  const live = liveSessionIdsAmong([SESSION, OTHER], []);
  assert.equal(live.size, 0);
});

test("L3: null session ids are dropped, not counted as live", () => {
  const live = liveSessionIdsAmong([null, null], [CLAUDE_CMDLINE]);
  assert.equal(live.size, 0);
});

test("L4: duplicate candidates collapse to one entry", () => {
  const live = liveSessionIdsAmong([SESSION, SESSION], [CLAUDE_CMDLINE]);
  assert.deepEqual([...live], [SESSION]);
});

/* ── COMPLETABLE_STATUS_SQL: what must NOT be completable ────────────────── */

test("C1: the completion precondition admits running and heartbeat_stale only", () => {
  assert.equal(
    COMPLETABLE_STATUS_SQL,
    "(status = 'running' OR (status = 'stuck' AND stuck_signal = 'heartbeat_stale'))",
  );
});

test("C2: no operator status and no timeout can be completed over", () => {
  // Substring assertions, because these are the operator verbs and the one
  // signal that MUST keep winning the race with a clean exit (07 §6, C13). If a
  // later edit widens the predicate to include any of them, this fails.
  for (const forbidden of ["cancelled", "paused", "timeout"]) {
    assert.equal(
      COMPLETABLE_STATUS_SQL.includes(forbidden),
      false,
      `COMPLETABLE_STATUS_SQL must not admit '${forbidden}'`,
    );
  }
});

test("C3: 'stuck' is admitted ONLY together with the watchdog's own signal", () => {
  // Not a spelling check: the fix is safe precisely because 'heartbeat_stale'
  // is written by one code path (the watchdog) and is a guess. A bare
  // `status = 'stuck'` would also reclaim rows parked by the timeout path.
  assert.equal(COMPLETABLE_STATUS_SQL.includes("status = 'stuck'"), true);
  assert.equal(
    COMPLETABLE_STATUS_SQL.includes(
      "status = 'stuck' AND stuck_signal = 'heartbeat_stale'",
    ),
    true,
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * The wiring in executor.ts, asserted on its SOURCE.
 *
 * Same reason as executor-completion-guard.test.ts: executor.ts opens a pg Pool
 * and starts two loops at import time, so importing it here would open a socket
 * rather than run a test. The properties below are the ones a reviewer would
 * otherwise have to take on trust, and every one of them is a way the fix could
 * be silently undone.
 * ──────────────────────────────────────────────────────────────────────────── */

const EXECUTOR = readFileSync(
  fileURLToPath(new URL("../executor.ts", import.meta.url)),
  "utf8",
);

/** Drop comments, so prose ABOUT the code is never mistaken for the code. */
const CODE = EXECUTOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function slice(startNeedle: string, endNeedle: string): string {
  const a = CODE.indexOf(startNeedle);
  assert.notEqual(a, -1, `anchor not found in executor.ts: ${startNeedle}`);
  const b = CODE.indexOf(endNeedle, a);
  assert.notEqual(b, -1, `end anchor not found after ${startNeedle}: ${endNeedle}`);
  return CODE.slice(a, b);
}

describe("executor.ts wiring", () => {
  test("X1: the /proc reader MOVED — there is no second copy left behind", () => {
    // Two copies of a liveness instrument is how one of them quietly rots.
    assert.doesNotMatch(CODE, /async function sessionProcessAlive\(/);
    assert.doesNotMatch(CODE, /await readdir\("\/proc"\)/);
    assert.match(
      CODE,
      /import \{[\s\S]{0,300}?sessionProcessAlive[\s\S]{0,300}?\} from "\.\/lib\/run-liveness\.ts";/,
    );
    // …and its one pre-existing caller still calls it unchanged.
    assert.match(CODE, /if \(priorSession && \(await sessionProcessAlive\(priorSession\)\)\)/);
  });

  test("X2: the watchdog walks /proc ONCE per tick, not once per candidate", () => {
    const wd = slice("async function stuckWatchdogTick(", "async function loop(");
    assert.equal(
      (wd.match(/readEngineCmdlines\(\)/g) ?? []).length,
      1,
      "one snapshot per tick — the walk must not be inside the candidate loop",
    );
    assert.match(wd, /liveSessionIdsAmong\(/);
    assert.match(wd, /watchdogVerdict\(\{/);
  });

  test("X3: the flip still carries its full precondition — no TOCTOU", () => {
    // /proc is walked between the SELECT and the UPDATE. A heartbeat that lands
    // in that window must win, or the fix reintroduces the bug it removes.
    const wd = slice("async function stuckWatchdogTick(", "async function loop(");
    const flip = wd.slice(wd.indexOf("SET status = 'stuck'"));
    assert.match(flip, /AND status = 'running'/);
    assert.match(flip, /AND last_heartbeat_at IS NOT NULL/);
    assert.match(flip, /AND last_heartbeat_at < now\(\) - \(interval '1 millisecond' \* \$1\)/);
    assert.match(flip, /stuck_signal = COALESCE\(stuck_signal, 'heartbeat_stale'\)/);
  });

  test("X4: a hold logs which instrument held it, and refreshes under a guard", () => {
    const wd = slice("async function stuckWatchdogTick(", "async function loop(");
    assert.match(wd, /an in-process turn owns it/);
    assert.match(wd, /a live \/proc session/);
    assert.match(wd, /holding 'running' and refreshing the heartbeat/);
    // The refresh must not resurrect a row an operator paused or cancelled
    // while we were walking /proc.
    assert.match(
      wd,
      /SET last_heartbeat_at = now\(\), updated_at = now\(\)\s*\n\s*WHERE id = \$1 AND status = 'running'/,
    );
  });

  test("X5: inFlight is passed in, never a module global", () => {
    // One ownership record, created in main() and handed to both loops. A
    // module-level `const inFlight` would let anything reach it.
    assert.match(CODE, /async function loop\(inFlight: Map<string, Promise<void>>\)/);
    assert.match(CODE, /async function managerLoop\(\s*\n?\s*ownedInProcess: \(runId: string\) => boolean,?\s*\n?\)/);
    assert.match(CODE, /await stuckWatchdogTick\(ownedInProcess\);/);
    assert.match(CODE, /managerLoop\(\(runId\) => inFlight\.has\(runId\)\)/);
    assert.equal(
      (CODE.match(/^const inFlight = /gm) ?? []).length,
      0,
      "inFlight must not be declared at module scope",
    );
  });

  test("X6: the two things this task must NOT have touched", () => {
    // Raising the threshold lowers the frequency and leaves the trapdoor; and
    // heartbeat()'s own guard is load-bearing for operator verbs (a paused run
    // must not keep its heartbeat fresh).
    assert.match(CODE, /process\.env\.HEARTBEAT_STUCK_THRESHOLD_MS \?\? "90000"/);
    const hb = slice("async function heartbeat(", "async function processRun(");
    assert.match(
      hb,
      /UPDATE runs SET last_heartbeat_at = now\(\) WHERE id = \$1 AND status = 'running'/,
    );
  });
});
