/**
 * check-classify.ts — executable unit check for the server-side agent-kind
 * classifier (R7 of docs/plan/01-requirements.md, 02-architecture.md §4.1).
 *
 * Same discipline as check-duration.ts: vitest is not set up in either repo
 * and NF4 forbids adding one, so a pure function gets a plain tsx script —
 * table-driven, zero dependencies, one PASS/FAIL line per case,
 * `process.exit(1)` if anything fails.
 *
 * Unlike check-duration.ts this imports a SERVER module, and importing
 * `routes/agents.ts` constructs its pg Pool at module load. An idle pool
 * holds the event loop open, so the script must exit explicitly at the end
 * or it hangs forever after printing a green result. Relocating the
 * classifier into a pool-free module to dodge that would put the wire's
 * classification somewhere other than where the wire is built — the import
 * cost is the cheaper price.
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-classify.ts
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/check-classify.ts
 */

import {
  classifyAgentKind,
  type AgentKind,
} from "../../forge-control/src/routes/agents.ts";

/** The six real project roles — routes/projects.ts:24-30. `scout` and
 *  `researcher` have no rows in the database yet; they must classify
 *  regardless, or the first one ever spawned renders as "unknown". */
const ROLES = ["architect", "planner", "scout", "researcher", "builder", "reviewer"];

let failures = 0;

function check(
  name: string,
  worker: string | null,
  meta: Record<string, unknown>,
  expected: AgentKind,
): void {
  const actual = classifyAgentKind(worker, meta);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected "${expected}", got "${actual}"`),
  );
}

console.log("── rule 1: cron_id wins over everything ──────────────────────");
// Both verbatim from live rows: a cron tick carries whatever worker identity
// ran it, so worker must never be consulted before cron_id.
check(
  "cron + worker=forge-executor (row e0f6f39e…, would be 'operator' at rule 3)",
  "forge-executor",
  { cron_id: "3fd1…", cron_name: "weekly-review" },
  "cron",
);
check(
  "cron + worker=skylab-producer (row faa0fd8a…, would be 'unknown' at rule 4)",
  "skylab-producer",
  { cron_id: "8ab2…", cron_name: "skylab-daily" },
  "cron",
);
check(
  "cron + full worker metadata still classifies cron (rule 1 outranks rule 2)",
  "project:builder",
  { cron_id: "c1", project_id: "p1", role: "builder" },
  "cron",
);
check("cron + null worker", null, { cron_id: "c1" }, "cron");
check(
  "cron_id present without cron_name is still cron (cron_name is display only)",
  "forge-executor",
  { cron_id: "c1" },
  "cron",
);

console.log("\n── rule 2: project_id + role → worker ────────────────────────");
for (const role of ROLES) {
  check(
    `worker role "${role}"`,
    `project:${role}`,
    { project_id: "8ea0cc08-28d9-4301-9f28-c98e1c5d6838", role, task_id: "t1" },
    "worker",
  );
}
check(
  "child run (parent_run_id lives on the row, not in metadata) still a worker",
  "project:reviewer",
  { project_id: "8ea0cc08", role: "reviewer" },
  "worker",
);
check(
  "worker signature with worker=forge-executor is a worker, not an operator",
  "forge-executor",
  { project_id: "8ea0cc08", role: "architect" },
  "worker",
);
check(
  "unrecognised role string still classifies as worker (server does not gatekeep roles)",
  "project:manager",
  { project_id: "8ea0cc08", role: "manager" },
  "worker",
);

console.log("\n── partial worker signatures fall through ────────────────────");
check(
  "project_id WITHOUT role, worker=forge-executor → operator (rule 3)",
  "forge-executor",
  { project_id: "8ea0cc08" },
  "operator",
);
check(
  "project_id WITHOUT role, other worker → unknown (rule 4)",
  "skylab-producer",
  { project_id: "8ea0cc08" },
  "unknown",
);
check(
  "role WITHOUT project_id, worker=forge-executor → operator (rule 3)",
  "forge-executor",
  { role: "builder" },
  "operator",
);
check(
  "role WITHOUT project_id, other worker → unknown (rule 4)",
  "project:builder",
  { role: "builder" },
  "unknown",
);

console.log("\n── rule 3: operator ──────────────────────────────────────────");
check("forge-executor with empty metadata", "forge-executor", {}, "operator");
check(
  "forge-executor with unrelated metadata",
  "forge-executor",
  { model: "claude-opus-5", effort: "high", source: "telegram" },
  "operator",
);

console.log("\n── rule 4: unknown is a real value, never a guess ────────────");
check("worker=skylab-producer, empty metadata", "skylab-producer", {}, "unknown");
check("null worker, empty metadata", null, {}, "unknown");
check("legacy engine-less row (worker=null, only a model)", null, { model: "opus" }, "unknown");
check(
  "near-miss worker name is NOT the operator (exact match only)",
  "forge-executor-2",
  {},
  "unknown",
);
check("case-differing worker name is NOT the operator", "Forge-Executor", {}, "unknown");

console.log("\n── ABSENT: empty strings ─────────────────────────────────────");
check(
  "cron_id: '' is absent → falls to the worker rule",
  "project:builder",
  { cron_id: "", project_id: "p1", role: "builder" },
  "worker",
);
check(
  "cron_id: '' with no worker signature → operator by worker identity",
  "forge-executor",
  { cron_id: "" },
  "operator",
);
check(
  "project_id: '' is absent → not a worker",
  "forge-executor",
  { project_id: "", role: "builder" },
  "operator",
);
check(
  "role: '' is absent → not a worker",
  "skylab-producer",
  { project_id: "p1", role: "" },
  "unknown",
);

console.log("\n── ABSENT: non-string metadata values ────────────────────────");
check(
  "cron_id: 42 (number) is absent",
  "project:builder",
  { cron_id: 42, project_id: "p1", role: "builder" },
  "worker",
);
check(
  "cron_id: {} (object) is absent",
  "forge-executor",
  { cron_id: { id: "c1" } },
  "operator",
);
check(
  "cron_id: true (boolean) is absent",
  "skylab-producer",
  { cron_id: true },
  "unknown",
);
check(
  "cron_id: null is absent",
  "forge-executor",
  { cron_id: null },
  "operator",
);
check(
  "project_id: 0 (number) is absent → not a worker",
  "forge-executor",
  { project_id: 0, role: "builder" },
  "operator",
);
check(
  "role: ['builder'] (array) is absent → not a worker",
  "skylab-producer",
  { project_id: "p1", role: ["builder"] },
  "unknown",
);
check(
  "role: {name:'builder'} (object) is absent → not a worker",
  "project:builder",
  { project_id: "p1", role: { name: "builder" } },
  "unknown",
);
check(
  "every signal non-string → unknown, never a guessed kind",
  null,
  { cron_id: 1, project_id: 2, role: 3, cron_name: 4 },
  "unknown",
);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — agent-kind classifier`,
);
// Importing routes/agents.ts opened a pg Pool at module load; an idle pool
// keeps the event loop alive, so exit explicitly rather than hang on green.
process.exit(failures === 0 ? 0 : 1);
