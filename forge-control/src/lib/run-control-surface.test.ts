/**
 * CP1-4a (round 904): source-assertion tests for the control-plane's db
 * helpers (round 902, db/runs.ts) and route surface (round 903,
 * routes/run-control.ts).
 *
 * WHY SOURCE-ASSERTION, NOT IMPORT-AND-CALL. 08 §2 asks for route/DB-level
 * tests "where the suite already does that" — it does not: there is no test
 * database, and both db/runs.ts and routes/run-control.ts open a pg Pool at
 * module load (`new Pool({...})` at the top level), so importing either from
 * a test process opens a real connection before a single assertion runs.
 * Following the precedent in reminder-dedup.test.ts (itself following
 * reminder-text.test.ts): read the two files' SOURCE TEXT with readFileSync
 * and assert on the code, never on live behaviour. Nothing here connects to
 * a database or imports db/ or routes/.
 *
 * Each assertion below is load-bearing for a specific correctness property of
 * the control plane, named at the point of assertion:
 *
 *  - atomicity (07 §5): the comms append, the status move and the
 *    pending_input flag must land in ONE UPDATE, or a completion write
 *    racing between two statements can strand a queued message.
 *  - consistency (contract §4): terminate must set completed_at in the SAME
 *    statement as the status flip, or a cancelled run can be left with a
 *    NULL completed_at that breaks duration reporting.
 *  - no read-then-write (07 §4 last paragraph): every guarded write carries
 *    its eligibility precondition into the UPDATE's WHERE via
 *    `status = ANY($n::text[])`, so two racing operators resolve to one
 *    applied write and one honest 409, never a mixed state.
 *  - single source of truth (C5): the route imports its eligibility and
 *    entry-construction logic from lib/run-control-rules.ts rather than
 *    re-implementing it, so the route and the db layer (which also imports
 *    from run-control-rules.ts) cannot drift apart.
 *  - C20 hard errors: no catch in routes/run-control.ts swallows a failure
 *    into a 200 that did nothing, except the one sanctioned idiom for a
 *    malformed request body.
 *  - C3: a manager's own outbound-message echo must never carry a status
 *    change or an eligibility list — otherwise a manager could requeue
 *    itself by sending a message.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const DB = readSource("../db/runs.ts");
const ROUTE = readSource("../routes/run-control.ts");
const INDEX = readSource("../index.ts");

/** Slice a named `export function`/`export async function` body out to the
 *  next top-level `export`, so assertions can be scoped to one helper instead
 *  of matching anywhere in the file. Backs up over a leading JSDoc comment
 *  that belongs to the NEXT export, so that export's prose (which may
 *  mention the same keywords, e.g. "completed_at") is never mistaken for
 *  this function's own body. */
function sliceExport(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  const startSync = src.indexOf(`export function ${name}`);
  const from = start >= 0 ? start : startSync;
  assert.ok(from >= 0, `export ${name} not found in source`);
  const nextExport = src.indexOf("\nexport ", from + 1);
  let end = nextExport >= 0 ? nextExport : src.length;
  const precedingComment = src.lastIndexOf("/**", end);
  if (precedingComment > from) end = precedingComment;
  return src.slice(from, end);
}

/* ========================================================================== *
 * 1. db/runs.ts — ThreadEntry.kind carries "comms"
 * ========================================================================== */

describe("ThreadEntry.kind includes \"comms\"", () => {
  test("the union type has a comms member", () => {
    const kindLine = DB.slice(
      DB.indexOf("kind?:"),
      DB.indexOf(";", DB.indexOf("kind?:")),
    );
    assert.match(kindLine, /"comms"/);
  });
});

/* ========================================================================== *
 * 2. db/runs.ts — appendCommsEntry: one statement, atomic flag + status
 * ========================================================================== */

describe("appendCommsEntry — single-statement atomicity (07 §5)", () => {
  const body = sliceExport(DB, "appendCommsEntry");

  test("the thread append happens via thread = thread || ...", () => {
    assert.match(body, /thread = thread \|\|/);
  });

  test("pending_input is set inside the SAME statement as the thread append", () => {
    // The SQL here is assembled dynamically into a `sets` array and issued as
    // ONE `UPDATE runs SET ${sets.join(", ")} WHERE ...` — there is no literal
    // multi-line SQL string to pattern-match the way stopRun/terminateRun
    // allow. So atomicity is proven the way it actually holds: the function
    // calls pool.query exactly once (no second statement exists to race
    // against), the template literal driving that call is built from `sets`
    // (not a second hand-written query), and both the thread-append fragment
    // and the pending_input fragment are pushed into that SAME `sets` array
    // before it is ever joined and sent.
    const queryCount = (body.match(/pool\.query/g) ?? []).length;
    assert.equal(queryCount, 1, "appendCommsEntry must issue exactly one pool.query call");
    assert.match(body, /UPDATE runs SET \$\{sets\.join\(", "\)\}/);
    const setsBlock = body.slice(body.indexOf("const sets ="), body.indexOf("UPDATE runs SET"));
    assert.match(setsBlock, /thread = thread \|\|/);
    assert.match(setsBlock, /pending_input/);
  });

  test("the WHERE carries the eligibility precondition via status = ANY(", () => {
    assert.match(body, /AND status = ANY\(/);
  });
});

/* ========================================================================== *
 * 3. db/runs.ts — stopRun: paused, no completed_at
 * ========================================================================== */

describe("stopRun (C11)", () => {
  const body = sliceExport(DB, "stopRun");

  test("writes status = 'paused'", () => {
    assert.match(body, /status = 'paused'/);
  });

  test("does NOT write completed_at", () => {
    assert.doesNotMatch(body, /completed_at/);
  });

  test("carries the eligibility precondition via status = ANY(", () => {
    assert.match(body, /AND status = ANY\(/);
  });
});

/* ========================================================================== *
 * 4. db/runs.ts — terminateRun: cancelled + completed_at in one statement
 * ========================================================================== */

describe("terminateRun (C12, contract §4 consistency fix)", () => {
  const body = sliceExport(DB, "terminateRun");

  test("writes status='cancelled' and completed_at = now() in the SAME statement", () => {
    const updateMatch = /UPDATE runs\s+SET/.exec(body);
    assert.ok(updateMatch, "no UPDATE runs SET found");
    const updateStart = updateMatch.index;
    const whereIdx = body.indexOf("WHERE", updateStart);
    assert.ok(whereIdx > updateStart, "no WHERE clause after the UPDATE");
    const setClause = body.slice(updateStart, whereIdx);
    assert.match(setClause, /status = 'cancelled'/);
    assert.match(setClause, /completed_at = now\(\)/);
    const updateCount = (body.match(/UPDATE runs\s+SET/g) ?? []).length;
    assert.equal(updateCount, 1, "terminateRun must issue exactly one UPDATE");
  });

  test("carries the eligibility precondition via status = ANY(", () => {
    assert.match(body, /AND status = ANY\(/);
  });
});

/* ========================================================================== *
 * 5. db/runs.ts — listComms: SQL-side filter, ordinality order, empty-array
 *    default (C14)
 * ========================================================================== */

describe("listComms (C14)", () => {
  const body = sliceExport(DB, "listComms");

  test("filters e->>'kind' = 'comms' in SQL, not in Node", () => {
    assert.match(body, /e->>'kind' = 'comms'/);
  });

  test("orders with WITH ORDINALITY ... ORDER BY ord — thread order is part of the contract", () => {
    assert.match(body, /WITH ORDINALITY/);
    assert.match(body, /ORDER BY ord/);
  });

  test("COALESCEs to an empty jsonb array — no comms is [] not null", () => {
    assert.match(body, /COALESCE\(/);
    assert.match(body, /'\[\]'::jsonb/);
  });
});

/* ========================================================================== *
 * 6. db/runs.ts — eligibility matrices come from run-control-rules.ts
 * ========================================================================== */

describe("STOP_ELIGIBLE / TERMINATE_ELIGIBLE are imported, not re-typed (C5)", () => {
  test("db/runs.ts imports both from ../lib/run-control-rules.ts", () => {
    assert.match(DB, /import\s*\{\s*STOP_ELIGIBLE,\s*TERMINATE_ELIGIBLE\s*\}\s*from\s*"\.\.\/lib\/run-control-rules\.ts"/);
  });

  test("db/runs.ts does not declare its own STOP_ELIGIBLE/TERMINATE_ELIGIBLE literal arrays", () => {
    assert.doesNotMatch(DB, /const STOP_ELIGIBLE/);
    assert.doesNotMatch(DB, /const TERMINATE_ELIGIBLE/);
  });
});

/* ========================================================================== *
 * 7. routes/run-control.ts — all four routes exist
 * ========================================================================== */

describe("route surface — all four endpoints exist", () => {
  test('post "/:id/message"', () => {
    assert.match(ROUTE, /r\.post\(\s*"\/:id\/message"/);
  });
  test('post "/:id/stop"', () => {
    assert.match(ROUTE, /r\.post\(\s*"\/:id\/stop"/);
  });
  test('post "/:id/terminate"', () => {
    assert.match(ROUTE, /r\.post\(\s*"\/:id\/terminate"/);
  });
  test('get "/:id/comms"', () => {
    assert.match(ROUTE, /r\.get\(\s*"\/:id\/comms"/);
  });
});

/* ========================================================================== *
 * 8. routes/run-control.ts — contract field names + status codes
 * ========================================================================== */

describe("wire contract field names and status codes (08 §4.5)", () => {
  test("`queued` and `delivery` and \"next-turn\" appear in the message response", () => {
    assert.match(ROUTE, /queued:\s*true/);
    assert.match(ROUTE, /delivery:\s*"next-turn"/);
  });
  test("`stopping` appears in the stop response", () => {
    assert.match(ROUTE, /stopping:\s*true/);
  });
  test("`terminating` appears in the terminate response", () => {
    assert.match(ROUTE, /terminating:\s*true/);
  });
  test("status codes 202, 400, 404, 409 all appear", () => {
    // c.json's status arg is sometimes on its own line ("202,\n  );") and
    // sometimes inline ("...}, 400);"), so match the bare status-code token
    // rather than a fixed ", CODE)" shape.
    for (const code of [202, 400, 404, 409]) {
      assert.match(ROUTE, new RegExp(`\\b${code}\\b`), `status ${code} not found`);
    }
  });
});

/* ========================================================================== *
 * 9. routes/run-control.ts — eligibility imported, not re-implemented (C5)
 * ========================================================================== */

describe("eligibility logic is imported from lib/run-control-rules.ts, not re-implemented", () => {
  test("messageAction, stopAction, terminateAction and commsEntries are imported", () => {
    assert.match(ROUTE, /messageAction/);
    assert.match(ROUTE, /stopAction/);
    assert.match(ROUTE, /terminateAction/);
    assert.match(ROUTE, /commsEntries/);
    assert.match(ROUTE, /from\s*"\.\.\/lib\/run-control-rules\.ts"/);
  });
});

/* ========================================================================== *
 * 10. routes/run-control.ts — hard-error audit (C20, 08 §4.6)
 * ========================================================================== */

describe("hard-error audit: no swallowed errors except the sanctioned body-parse idiom", () => {
  test("every `.catch(() =>` occurrence is the c.req.json() body-parse idiom", () => {
    const lines = ROUTE.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!line.includes(".catch(() =>")) return;
      const isSanctioned = /c\.req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(line);
      if (!isSanctioned) {
        offenders.push(`routes/run-control.ts:${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(
      offenders,
      [],
      offenders.length > 0
        ? `unsanctioned swallowed error(s):\n${offenders.join("\n")}`
        : undefined,
    );
  });

  test("exactly one `.catch(() =>` occurrence total (the body-parse idiom)", () => {
    const count = (ROUTE.match(/\.catch\(\(\) =>/g) ?? []).length;
    assert.equal(count, 1, `expected exactly 1 .catch(() => occurrence, found ${count}`);
  });
});

/* ========================================================================== *
 * 11. routes/run-control.ts — sender echo has no setStatus, no eligibility (C3)
 * ========================================================================== */

describe("sender echo — no setStatus, no eligibility list (C3)", () => {
  test("the echo append call site passes no options object (or an empty one) — never MESSAGE_WRITE", () => {
    const echoCallIdx = ROUTE.indexOf("appendCommsEntry(senderId");
    assert.ok(echoCallIdx >= 0, "echo call site (appendCommsEntry(senderId, ...)) not found");
    const echoCall = ROUTE.slice(echoCallIdx, ROUTE.indexOf(")", ROUTE.indexOf(")", echoCallIdx) + 1) + 1);
    assert.doesNotMatch(echoCall, /setStatus/);
    assert.doesNotMatch(echoCall, /eligible/);
    assert.doesNotMatch(echoCall, /MESSAGE_WRITE/);
  });
});

/* ========================================================================== *
 * 12. index.ts — mount shape (boundary D2)
 * ========================================================================== */

describe("index.ts mount (boundary D2)", () => {
  test('imports runControl from "./routes/run-control.ts"', () => {
    assert.match(INDEX, /import runControl from "\.\/routes\/run-control\.ts";/);
  });

  test('mounts app.route("/api/runs", runControl);', () => {
    assert.match(INDEX, /app\.route\("\/api\/runs", runControl\);/);
  });

  test("the mount line comes AFTER app.route(\"/webhooks\", webhookIn)", () => {
    const webhookInIdx = INDEX.indexOf('app.route("/webhooks", webhookIn);');
    const runControlIdx = INDEX.indexOf('app.route("/api/runs", runControl);');
    assert.ok(webhookInIdx >= 0, "webhookIn mount not found");
    assert.ok(runControlIdx >= 0, "runControl mount not found");
    assert.ok(
      runControlIdx > webhookInIdx,
      `runControl mount (index ${runControlIdx}) must come after webhookIn mount (index ${webhookInIdx})`,
    );
  });
});
