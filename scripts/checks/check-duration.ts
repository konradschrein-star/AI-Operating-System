/**
 * check-duration.ts — executable unit check for the Live panel's duration
 * helpers (R4, R5, R6 of docs/plan/01-requirements.md).
 *
 * vitest is not set up in either repo and NF4 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies,
 * one PASS/FAIL line per case, `process.exit(1)` if anything fails.
 *
 * It imports `agentsApi.ts` directly — that module has no React and no
 * imports of its own, which is precisely why the helpers live there and not
 * in AgentActivity.tsx (a React module tsx cannot resolve without a bundler).
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-duration.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  parseTs,
  runElapsedMs,
  subagentElapsedMs,
  type AgentRow,
  type AgentUsage,
  type SubagentRow,
} from "../../forge-control-web/app/desktop/live/agentsApi.ts";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const LATER = NOW + 6 * 60 * 60 * 1000; // six hours further on — the drift that made a 130s run read "5h 05m"

const EMPTY_USAGE: AgentUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A row with every required field, so each case only states what it varies. */
function run(over: Partial<AgentRow>): AgentRow {
  return {
    kind: "run",
    id: "00000000-0000-0000-0000-000000000000",
    title: "fixture",
    status: "running",
    worker: "forge-executor",
    model: "claude-opus-5",
    effort: null,
    engine: "cc",
    started_at: "2026-08-05T11:58:00.000Z",
    last_heartbeat_at: null,
    elapsed_ms: null,
    settled: false,
    settled_at: null,
    spent_usd: 0,
    usage_total: EMPTY_USAGE,
    current_activity: null,
    parent_run_id: null,
    ...over,
  };
}

function sub(over: Partial<SubagentRow>): SubagentRow {
  return {
    kind: "subagent",
    tool_use_id: "toolu_fixture",
    role: "Explore",
    model: "claude-opus-5",
    started_at: "2026-08-05T11:58:00.000Z",
    updated_at: "2026-08-05T11:59:00.000Z",
    ended_at: null,
    description: null,
    usage: EMPTY_USAGE,
    event_count: 0,
    latest_activity: null,
    status: "done",
    ...over,
  };
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

console.log("── parseTs ───────────────────────────────────────────────────");
check(
  "parses Postgres 'YYYY-MM-DD HH:MM:SS.ffffff+00'",
  parseTs("2026-07-30 16:21:19.674825+00"),
  Date.parse("2026-07-30T16:21:19.674Z"),
);
check(
  "parses ISO 8601",
  parseTs("2026-08-05T06:47:23.678Z"),
  Date.parse("2026-08-05T06:47:23.678Z"),
);
check("null → NaN", Number.isNaN(parseTs(null)), true);
check("garbage → NaN", Number.isNaN(parseTs("not a timestamp")), true);

console.log("\n── runElapsedMs ──────────────────────────────────────────────");
check(
  "settled completed returns server elapsed_ms verbatim",
  runElapsedMs(run({ status: "completed", settled: true, elapsed_ms: 130_000 }), NOW),
  130_000,
);
check(
  "…and is unmoved when `now` jumps six hours forward",
  runElapsedMs(run({ status: "completed", settled: true, elapsed_ms: 130_000 }), LATER),
  130_000,
);
check(
  "settled cancelled returns server elapsed_ms verbatim",
  runElapsedMs(run({ status: "cancelled", settled: true, elapsed_ms: 4_512 }), LATER),
  4_512,
);
check(
  "settled failed returns server elapsed_ms verbatim",
  runElapsedMs(run({ status: "failed", settled: true, elapsed_ms: 77 }), LATER),
  77,
);
check(
  "settled with elapsed_ms null → null (renders '—')",
  runElapsedMs(run({ status: "completed", settled: true, elapsed_ms: null }), NOW),
  null,
);
{
  // The anti-tick assertion: a settled row with no server duration must be
  // null at both clocks, never a now-derived number that grows between polls.
  const r = run({ status: "completed", settled: true, elapsed_ms: null });
  const a = runElapsedMs(r, NOW);
  const b = runElapsedMs(r, LATER);
  check("settled+null never derives from now (identical across two clocks)", a === b && a === null, true);
}
check(
  "running ticks with now",
  runElapsedMs(run({ status: "running", started_at: "2026-08-05T11:58:00.000Z" }), NOW),
  120_000,
);
check(
  "running ticks forward as now advances",
  runElapsedMs(run({ status: "running", started_at: "2026-08-05T11:58:00.000Z" }), NOW + 1_000),
  121_000,
);
check(
  "running with a clock behind started_at clamps to 0, never negative",
  runElapsedMs(run({ status: "running", started_at: "2026-08-05T12:30:00.000Z" }), NOW),
  0,
);
check(
  "running with unparsable started_at → null",
  runElapsedMs(run({ status: "running", started_at: "yesterday-ish" }), NOW),
  null,
);
check(
  "running with null started_at → null",
  runElapsedMs(run({ status: "running", started_at: null }), NOW),
  null,
);
check(
  "queued → null even with a valid started_at and non-null elapsed_ms",
  runElapsedMs(
    run({ status: "queued", started_at: "2026-08-05T11:58:00.000Z", elapsed_ms: 999_999 }),
    NOW,
  ),
  null,
);
check(
  "stuck (live, not settled) still ticks",
  runElapsedMs(run({ status: "stuck", started_at: "2026-08-05T11:58:00.000Z" }), NOW),
  120_000,
);
check(
  "settled wins over a live-looking status field (server is the authority)",
  runElapsedMs(run({ status: "running", settled: true, elapsed_ms: 42 }), LATER),
  42,
);
check(
  "Postgres-format started_at parses on a live row",
  runElapsedMs(run({ status: "running", started_at: "2026-08-05 11:58:00.000000+00" }), NOW),
  120_000,
);

console.log("\n── subagentElapsedMs ─────────────────────────────────────────");
check(
  "running ticks with now",
  subagentElapsedMs(sub({ status: "running", started_at: "2026-08-05T11:58:00.000Z" }), NOW),
  120_000,
);
check(
  "running ticks forward as now advances",
  subagentElapsedMs(
    sub({ status: "running", started_at: "2026-08-05T11:58:00.000Z" }),
    NOW + 5_000,
  ),
  125_000,
);
check(
  "done with ended_at uses ended − started",
  subagentElapsedMs(
    sub({
      status: "done",
      started_at: "2026-08-05T11:58:00.000Z",
      ended_at: "2026-08-05T11:58:47.000Z",
      updated_at: "2026-08-05T11:59:30.000Z",
    }),
    LATER,
  ),
  47_000,
);
check(
  "done with ended_at null falls back to updated_at (rows predating rollup v2)",
  subagentElapsedMs(
    sub({
      status: "done",
      started_at: "2026-08-05T11:58:00.000Z",
      ended_at: null,
      updated_at: "2026-08-05T11:59:30.000Z",
    }),
    LATER,
  ),
  90_000,
);
check(
  "done with both ended_at and updated_at unusable → null",
  subagentElapsedMs(
    sub({ status: "done", ended_at: null, updated_at: "" }),
    NOW,
  ),
  null,
);
check(
  "done with unparsable started_at → null",
  subagentElapsedMs(
    sub({ status: "done", started_at: "¯\\_(ツ)_/¯", ended_at: "2026-08-05T11:58:47.000Z" }),
    NOW,
  ),
  null,
);
check(
  "running with unparsable started_at → null",
  subagentElapsedMs(sub({ status: "running", started_at: "" }), NOW),
  null,
);
{
  // The kill shot for the grow-forever fallback at the old
  // AgentActivity.tsx:257-258: a done sub-agent must be identical at any clock.
  const withEnd = sub({
    status: "done",
    started_at: "2026-08-05T11:58:00.000Z",
    ended_at: "2026-08-05T11:58:47.000Z",
  });
  check(
    "done+ended_at is identical across two different `now` values",
    subagentElapsedMs(withEnd, NOW) === subagentElapsedMs(withEnd, LATER) &&
      subagentElapsedMs(withEnd, NOW) === 47_000,
    true,
  );
  const fallback = sub({
    status: "done",
    started_at: "2026-08-05T11:58:00.000Z",
    ended_at: null,
    updated_at: "2026-08-05T11:59:30.000Z",
  });
  check(
    "done+updated_at fallback is identical across two different `now` values",
    subagentElapsedMs(fallback, NOW) === subagentElapsedMs(fallback, LATER) &&
      subagentElapsedMs(fallback, NOW) === 90_000,
    true,
  );
  const dead = sub({ status: "done", ended_at: null, updated_at: "" });
  check(
    "done with nothing usable is null at both clocks — never now-derived",
    subagentElapsedMs(dead, NOW) === null && subagentElapsedMs(dead, LATER) === null,
    true,
  );
}
check(
  "Postgres timestamp format parses (started + ended)",
  subagentElapsedMs(
    sub({
      status: "done",
      started_at: "2026-07-30 16:21:19.674825+00",
      ended_at: "2026-07-30 16:23:19.674825+00",
    }),
    NOW,
  ),
  120_000,
);
check(
  "ISO timestamp format parses (started + ended)",
  subagentElapsedMs(
    sub({
      status: "done",
      started_at: "2026-08-05T06:47:23.678Z",
      ended_at: "2026-08-05T06:49:23.678Z",
    }),
    NOW,
  ),
  120_000,
);
check(
  "ended_at before started_at clamps to 0, never negative",
  subagentElapsedMs(
    sub({
      status: "done",
      started_at: "2026-08-05T11:58:00.000Z",
      ended_at: "2026-08-05T11:57:00.000Z",
    }),
    NOW,
  ),
  0,
);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — duration helpers`,
);
process.exit(failures === 0 ? 0 : 1);
