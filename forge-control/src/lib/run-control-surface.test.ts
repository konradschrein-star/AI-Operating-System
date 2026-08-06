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

/**
 * CP2-4a: slice ONE `r.post`/`r.get` handler out of routes/run-control.ts, from
 * its own literal call site (e.g. `r.post("/:id/resume-chat"`) up to the next
 * `r.post(`/`r.get(` call site — backing up over a leading block comment that
 * belongs to the NEXT handler, the same guard `sliceExport` uses above, so a
 * neighbour's own doc-comment prose can never be mistaken for this handler's
 * body.
 */
function sliceHandler(src: string, startMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `handler not found: ${startMarker}`);
  const searchFrom = start + startMarker.length;
  const nextPost = src.indexOf('r.post("', searchFrom);
  const nextGet = src.indexOf('r.get("', searchFrom);
  const candidates = [nextPost, nextGet].filter((i) => i >= 0);
  let end = candidates.length > 0 ? Math.min(...candidates) : src.length;
  const precedingComment = src.lastIndexOf("/* ---", end);
  if (precedingComment > start) end = precedingComment;
  return src.slice(start, end);
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

  test("it can clear completed_at and wake_after, in the SAME statement", () => {
    // R905 finding 3 / red-team finding 4. `append_and_queue` puts a settled
    // run back to work; leaving `completed_at` stamped renders a live run as
    // settled-at-10:00 and makes every duration in the UI lie — and if the
    // watchdog catches it first, produces a `stuck` row with a completion
    // timestamp, which completeRun's own invariant forbids. The two sibling
    // requeue paths (executor.ts's E2 and requeueRunAfterUsageWall) clear the
    // same stamps; this was the odd one out.
    assert.match(body, /if \(opts\.clearCompletedAt\) sets\.push\("completed_at = NULL"\)/);
    assert.match(body, /if \(opts\.clearWakeAfter\) sets\.push\("wake_after = NULL"\)/);
    // Pushed into `sets`, i.e. into the ONE UPDATE — not a follow-up statement
    // a completion write could interleave with.
    const setsBlock = body.slice(body.indexOf("const sets ="), body.indexOf("UPDATE runs SET"));
    assert.match(setsBlock, /completed_at = NULL/);
    assert.match(setsBlock, /wake_after = NULL/);
    assert.equal(
      (body.match(/pool\.query/g) ?? []).length,
      1,
      "appendCommsEntry must still issue exactly one pool.query call",
    );
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

describe("route surface — all six endpoints exist", () => {
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
  // CP2-4a (round 1003): the two handlers round 1002 added.
  test('post "/:id/resume-chat"', () => {
    assert.match(ROUTE, /r\.post\(\s*"\/:id\/resume-chat"/);
  });
  test('post "/:parentId/subagent-message"', () => {
    assert.match(ROUTE, /r\.post\(\s*"\/:parentId\/subagent-message"/);
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
 * 9b. routes/run-control.ts — the message precondition comes from the ACTION
 * ========================================================================== */

describe("the /message precondition is the action's own (C5, R905 finding 4)", () => {
  test("MESSAGE_WRITE describes the effect only — it declares no eligibility", () => {
    // The old shape kept a second, hand-written copy of the partition here.
    // Nothing type-checked it against messageAction, so adding a status to the
    // rules module and forgetting this table produced a route that accepts a
    // message the UPDATE then matches zero rows for — a 409 telling the
    // operator the run "moved" to the status it was already in.
    const table = ROUTE.slice(
      ROUTE.indexOf("const MESSAGE_WRITE"),
      ROUTE.indexOf("function raceReason"),
    );
    assert.ok(table.length > 0, "MESSAGE_WRITE table not found");
    assert.doesNotMatch(table, /eligible/);
    assert.match(table, /setStatus: "queued"/);
    assert.match(table, /clearCompletedAt: true/);
    assert.match(table, /clearWakeAfter: true/);
  });

  test("every append call for a message passes eligible: <action>.eligible", () => {
    const spreads = ROUTE.match(/eligible: (action|current)\.eligible,/g) ?? [];
    assert.equal(
      spreads.length,
      2,
      "both the first attempt and the re-dispatch must carry the action's own precondition",
    );
  });
});

/* ========================================================================== *
 * 9c. routes/run-control.ts — the bounded re-dispatch (07 §5, red-team #5)
 * ========================================================================== */

describe("lost-race re-dispatch is bounded to exactly one extra attempt", () => {
  const handler = ROUTE.slice(
    ROUTE.indexOf('r.post("/:id/message"'),
    ROUTE.indexOf('r.post("/:id/stop"'),
  );

  test("the message handler appends at most twice, and never in a loop", () => {
    assert.equal(
      (handler.match(/await appendCommsEntry\(id,/g) ?? []).length,
      2,
      "exactly two append call sites against the target: the attempt and the one re-dispatch",
    );
    // A `while`/`for` here would be a retry loop against a live row — the thing
    // 07 §4's "no read-then-write" discipline exists to keep out.
    assert.doesNotMatch(handler, /\bwhile\s*\(|\bfor\s*\(/);
  });

  test("the re-dispatch is gated on a NON-reject recompute of the current status", () => {
    assert.match(handler, /const current = messageAction\(delivered\.status\);/);
    assert.match(handler, /if \(current\.kind !== "reject"\)/);
  });

  test("a second loss is still an honest 409, never a 202", () => {
    // C20: the re-dispatch must not be able to report success for a write that
    // did not apply. The final answer is still driven by `delivered.applied`.
    assert.match(handler, /if \(!delivered\.applied\) \{/);
    assert.ok(
      handler.lastIndexOf("if (!delivered.applied) {") >
        handler.indexOf("if (current.kind !== \"reject\")"),
      "the applied check must come after the re-dispatch",
    );
  });

  test("stop and terminate do NOT re-dispatch — a verb is not a message", () => {
    const verb = ROUTE.slice(
      ROUTE.indexOf("async function statusVerb("),
      ROUTE.indexOf('r.post("/:id/stop"'),
    );
    assert.equal(
      (verb.match(/await write\(id\)/g) ?? []).length,
      1,
      "statusVerb must attempt its write exactly once",
    );
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

/* ========================================================================== *
 * CP2-4a (round 1003) — source-assertion tests for the two handlers CP2-3
 * (round 1002) added: POST /:id/resume-chat and POST /:parentId/subagent-
 * message. Same idiom as sections 1-12 above: readFileSync the source text,
 * assert on the code, never on live behaviour. `sliceHandler` (declared next
 * to `sliceExport` above) scopes each assertion to one handler's own body, so
 * a match can never land in a neighbouring handler or a JSDoc paragraph.
 * ========================================================================== */

/* ========================================================================== *
 * 13. resume-chat — the requeue is ONE statement (07 §7 detector invariant)
 * ========================================================================== */

describe("resume-chat — the requeue is ONE statement (07 §7 detector invariant)", () => {
  const handler = sliceHandler(ROUTE, 'r.post("/:id/resume-chat"');

  test("RESUME_WRITE carries setStatus queued, clearCompletedAt, clearWakeAfter, clearPendingInput and eligible: RESUME_ELIGIBLE together, in ONE object", () => {
    // Property: markVerdictTaskDone's `AND r.status='completed'` detector (07
    // §7) stays exact only if the append and the status move are the SAME
    // write. Split across two statements, a round consolidation landing in the
    // gap marks the reviewer task done while the resumed run is about to
    // produce a flipped verdict — which is then honoured zero times, in
    // silence.
    const rwStart = handler.indexOf("const RESUME_WRITE");
    assert.ok(rwStart >= 0, "RESUME_WRITE not found in resume-chat handler");
    const rwEnd = handler.indexOf("} as const;", rwStart);
    assert.ok(rwEnd >= 0, "RESUME_WRITE block has no closing `} as const;`");
    const block = handler.slice(rwStart, rwEnd + "} as const;".length);
    assert.match(block, /eligible:\s*RESUME_ELIGIBLE/);
    assert.match(block, /setStatus:\s*"queued"/);
    assert.match(block, /clearCompletedAt:\s*true/);
    assert.match(block, /clearWakeAfter:\s*true/);
    assert.match(block, /clearPendingInput:\s*true/);
  });

  test("the handler has no setRunStatus( call and no second status-writing call site — the append and the status move are the same write", () => {
    assert.doesNotMatch(handler, /setRunStatus\(/);
  });

  test("db/runs.ts appendCommsEntry clears pending_input with `- 'pending_input'`", () => {
    const body = sliceExport(DB, "appendCommsEntry");
    assert.match(body, /-\s*'pending_input'/);
  });

  test("appendCommsEntry throws when setPendingInput and clearPendingInput are both passed", () => {
    const body = sliceExport(DB, "appendCommsEntry");
    assert.match(body, /opts\.setPendingInput\s*&&\s*opts\.clearPendingInput/);
    assert.match(body, /mutually exclusive/);
  });
});

/* ========================================================================== *
 * 14. resume-chat — workspace pre-flight precedes every write (C7)
 * ========================================================================== */

describe("resume-chat — workspace pre-flight precedes every write (C7)", () => {
  const handler = sliceHandler(ROUTE, 'r.post("/:id/resume-chat"');

  test("imports existsSync from node:fs and calls workspaceDirOf( in the handler", () => {
    assert.match(ROUTE, /import\s*\{\s*existsSync\s*\}\s*from\s*"node:fs"/);
    assert.match(handler, /workspaceDirOf\(/);
  });

  test("the existsSync check and its return precede the FIRST appendCommsEntry( call — never spawn a CC child into a deleted worktree, never leave a thread entry on a 409", () => {
    const existsIdx = handler.indexOf("existsSync(");
    const firstAppendIdx = handler.indexOf("appendCommsEntry(");
    assert.ok(existsIdx >= 0, "existsSync( not found in resume-chat handler");
    assert.ok(firstAppendIdx >= 0, "appendCommsEntry( not found in resume-chat handler");
    assert.ok(
      existsIdx < firstAppendIdx,
      "the existsSync check must precede the first appendCommsEntry( call",
    );
    const returnIdx = handler.indexOf("return", existsIdx);
    assert.ok(
      returnIdx >= 0 && returnIdx < firstAppendIdx,
      "the existsSync branch's return must precede the first appendCommsEntry( call",
    );
  });

  test('the 409 reason comes from workspaceGoneReason( — "workspace gone:" is not retyped in the route', () => {
    assert.match(handler, /workspaceGoneReason\(/);
    assert.doesNotMatch(handler, /"workspace gone:/);
  });
});

/* ========================================================================== *
 * 15. resume-chat — response shape and in-place identity (C6)
 * ========================================================================== */

describe("resume-chat — response shape and in-place identity (C6)", () => {
  const handler = sliceHandler(ROUTE, 'r.post("/:id/resume-chat"');

  test("responds resumed_run_id: id with 202 — resume is IN PLACE, no new run is ever created", () => {
    assert.match(handler, /resumed_run_id:\s*id\b/);
    assert.match(handler, /\b202\b/);
  });

  test("the handler contains no createRun( call", () => {
    assert.doesNotMatch(handler, /createRun\(/);
  });

  test("resumeAction( gates it — eligibility is imported, not re-implemented (C5)", () => {
    assert.match(handler, /resumeAction\(/);
  });
});

/* ========================================================================== *
 * 16. subagent-message — addressability is checked before parent eligibility
 *     (C10)
 * ========================================================================== */

describe("subagent-message — addressability is checked before parent eligibility (C10)", () => {
  const handler = sliceHandler(ROUTE, 'r.post("/:parentId/subagent-message"');

  test("subagentAddressable( is checked before messageAction( — addressability is a property of the ADDRESS, not of timing", () => {
    const addrIdx = handler.indexOf("subagentAddressable(");
    const actionIdx = handler.indexOf("messageAction(");
    assert.ok(addrIdx >= 0, "subagentAddressable( not found in subagent-message handler");
    assert.ok(actionIdx >= 0, "messageAction( not found in subagent-message handler");
    assert.ok(
      addrIdx < actionIdx,
      "subagentAddressable( must be checked before messageAction( is ever called",
    );
  });

  test('the 409 uses the imported SUBAGENT_UNADDRESSABLE constant — "subagent context not addressable" is not retyped in the route', () => {
    assert.match(handler, /SUBAGENT_UNADDRESSABLE/);
    assert.doesNotMatch(handler, /"subagent context not addressable"/);
  });

  test("the relay entry is built by commsEntries( with relaySubagentId — the [relay from prefix is not hand-built in the route", () => {
    assert.match(handler, /commsEntries\(/);
    assert.match(handler, /relaySubagentId:\s*subagentId/);
    assert.doesNotMatch(handler, /\[relay from/);
  });

  test('returns 202 with delivery: "next-turn" and queued: true (wire contract field names, 08 §4.5)', () => {
    assert.match(handler, /queued:\s*true/);
    assert.match(handler, /delivery:\s*"next-turn"/);
    assert.match(handler, /\b202\b/);
  });
});

/* ========================================================================== *
 * 17. both new handlers obey the file's error discipline (C20)
 * ========================================================================== */

describe("both new handlers obey the file's error discipline (C20)", () => {
  const NEW_HANDLERS: Array<[string, string]> = [
    ["resume-chat", sliceHandler(ROUTE, 'r.post("/:id/resume-chat"')],
    ["subagent-message", sliceHandler(ROUTE, 'r.post("/:parentId/subagent-message"')],
  ];

  test("neither new handler has a try/catch — the only sanctioned swallow in the file is the c.req.json() body-parse idiom", () => {
    for (const [name, handler] of NEW_HANDLERS) {
      assert.doesNotMatch(handler, /\btry\s*\{/, `${name}: unexpected try/catch`);
    }
  });

  test("every non-2xx c.json( response in both handlers carries an error field", () => {
    for (const [name, handler] of NEW_HANDLERS) {
      const calls: string[] = [];
      let idx = handler.indexOf("c.json(");
      while (idx >= 0) {
        const close = handler.indexOf(");", idx);
        assert.ok(close >= 0, `${name}: unterminated c.json( call at index ${idx}`);
        calls.push(handler.slice(idx, close + 2));
        idx = handler.indexOf("c.json(", close);
      }
      assert.ok(calls.length > 0, `${name}: no c.json( calls found`);
      for (const call of calls) {
        const is2xx = /\b202\b/.test(call);
        if (!is2xx) {
          assert.match(call, /error:/, `${name}: non-2xx c.json( call missing an error field: ${call}`);
        }
      }
    }
  });

  test("both handlers validate the uuid with UUID_RE before touching the DB", () => {
    for (const [name, handler] of NEW_HANDLERS) {
      const uuidIdx = handler.indexOf("UUID_RE.test(");
      const getRunIdx = handler.indexOf("getRun(");
      assert.ok(uuidIdx >= 0, `${name}: UUID_RE.test( not found`);
      assert.ok(getRunIdx >= 0, `${name}: getRun( not found`);
      assert.ok(uuidIdx < getRunIdx, `${name}: UUID_RE.test( must precede getRun(`);
    }
  });
});

/* ========================================================================== *
 * 18. echo discipline holds for the new verbs (C3)
 * ========================================================================== */

describe("echo discipline holds for the new verbs (C3)", () => {
  const NEW_HANDLERS: Array<[string, string]> = [
    ["resume-chat", sliceHandler(ROUTE, 'r.post("/:id/resume-chat"')],
    ["subagent-message", sliceHandler(ROUTE, 'r.post("/:parentId/subagent-message"')],
  ];

  test("neither new handler's echo appendCommsEntry( call passes a setStatus or an eligible option — a sender must never be requeued or refused by its own outbound message", () => {
    for (const [name, handler] of NEW_HANDLERS) {
      const echoCallIdx = handler.indexOf("appendCommsEntry(senderId");
      assert.ok(echoCallIdx >= 0, `${name}: echo call site (appendCommsEntry(senderId, ...)) not found`);
      const echoCall = handler.slice(
        echoCallIdx,
        handler.indexOf(")", handler.indexOf(")", echoCallIdx) + 1) + 1,
      );
      assert.doesNotMatch(echoCall, /setStatus/, `${name}: echo call must not set status`);
      assert.doesNotMatch(echoCall, /eligible/, `${name}: echo call must not carry an eligibility list`);
    }
  });
});
