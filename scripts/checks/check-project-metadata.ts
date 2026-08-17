/**
 * check-project-metadata.ts — executable unit check for the metadata builder
 * behind `POST /api/projects` (U1 of
 * docs/plan/operator-visibility/12-ui-v3-requirements.md, write path of
 * docs/plan/operator-visibility/13-ui-v3-architecture.md §5).
 *
 * vitest is not set up in either repo and NF4 forbids adding one, so pure
 * helpers get a plain tsx script instead: table-driven, zero dependencies,
 * one PASS/FAIL line per case, `process.exit(1)` if anything fails — the same
 * shape as check-duration.ts and check-classify.ts.
 *
 * It imports `buildProjectMetadata` from routes/projects.ts DIRECTLY: no DB,
 * no HTTP, no server. That is the whole point of extracting it — the route's
 * one piece of real logic becomes testable without creating a real project
 * (every create spawns an architect run via forge-executor's project tick).
 * Importing the module pulls in `hono` and `../db/projects.ts`, which is why
 * this runs from forge-control's node_modules; neither has a top-level side
 * effect (db/projects.ts only constructs a lazy pg Pool).
 *
 * Run:
 *   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-project-metadata.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 *
 * Typecheck (this file sits outside forge-control's tsconfig `include`, so it
 * needs its own invocation with the same compiler options — per the header of
 * scripts/checks/serve-agents-7798.ts):
 *   cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
 *     --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
 *     --allowImportingTsExtensions --isolatedModules --types node \
 *     ../scripts/checks/check-project-metadata.ts
 */

import {
  buildProjectMetadata,
  ProjectMetadataError,
} from "../../forge-control/src/routes/projects.ts";

/** A real chat run id from this project's own history — the operator chat that
 *  created 8ea0cc08… (see plan-300.md, "Linkage ground truth"). Using the real
 *  fixture rather than a made-up uuid keeps the case honest about casing and
 *  length. */
const CHAT_ID = "bfd1283a-b71b-4f35-b577-7d09aad803f2";

type Body = Parameters<typeof buildProjectMetadata>[0];

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        expected ${e}, got ${a}`),
  );
}

/** Key PRESENCE, asserted separately from value equality: `{}` and
 *  `{origin_chat_id: undefined}` both stringify to "{}", and round 304's
 *  resolver keys off presence. */
function checkHas(name: string, obj: Record<string, unknown>, key: string, expected: boolean): void {
  const ok = Object.prototype.hasOwnProperty.call(obj, key) === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected key "${key}" ${expected ? "present" : "absent"}, got keys ${JSON.stringify(Object.keys(obj))}`),
  );
}

function checkThrows(name: string, body: Body, message: string): void {
  let thrown: unknown;
  try {
    buildProjectMetadata(body);
  } catch (e) {
    thrown = e;
  }
  const ok = thrown instanceof ProjectMetadataError && thrown.message === message;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok
        ? ""
        : `\n        expected ProjectMetadataError("${message}"), got ${
            thrown === undefined ? "no throw" : String(thrown)
          }`),
  );
}

/* ── mode / checkin_hours: behaviour that must NOT have changed ────────────
 * These cases pin the pre-extraction expression verbatim
 * (`body.mode === "goal" ? { mode, ...(Number(checkin_hours) > 0 ? … : {}) } : {}`).
 * Round 303d is a refactor plus one key; if any of these flips, goal-mode
 * check-ins broke.
 *
 * AMENDED ROUND 212 (engine-task-graph phase 3, R31). `mode: "goal"` now also
 * sets `strict_write_sets: true`, so nine of these cases had to gain the key or
 * fail. Amending the expectations is the whole reason they are written as exact
 * objects rather than as key subsets: the diff below IS the record of what R31
 * changed, and every non-goal case is untouched, which is the property R31
 * actually promises ("existing projects do not [set it], so R18's replica is
 * untouched"). `check()` compares JSON.stringify output, so the literals also
 * pin INSERTION ORDER — mode, checkin_hours, strict_write_sets, origin_chat_id. */
console.log("── mode / checkin_hours (unchanged behaviour) ────────────────");
check("no mode → empty metadata", buildProjectMetadata({}), {});
check(
  "non-goal input carries nothing but the new key's absence",
  buildProjectMetadata({ name: "x", brief: "y", repo: "scratch" }),
  {},
);
check("mode goal → { mode: 'goal', strict_write_sets: true }", buildProjectMetadata({ mode: "goal" }), {
  mode: "goal",
  strict_write_sets: true,
});
check(
  "mode goal + checkin_hours 6 → both keys",
  buildProjectMetadata({ mode: "goal", checkin_hours: 6 }),
  { mode: "goal", checkin_hours: 6, strict_write_sets: true },
);
check(
  "mode goal + checkin_hours 0 → checkin_hours dropped",
  buildProjectMetadata({ mode: "goal", checkin_hours: 0 }),
  { mode: "goal", strict_write_sets: true },
);
check(
  "mode goal + negative checkin_hours → dropped",
  buildProjectMetadata({ mode: "goal", checkin_hours: -3 }),
  { mode: "goal", strict_write_sets: true },
);
check(
  "mode goal + NaN checkin_hours → dropped",
  buildProjectMetadata({ mode: "goal", checkin_hours: Number.NaN }),
  { mode: "goal", strict_write_sets: true },
);
check(
  "mode goal + unparsable checkin_hours string → dropped",
  buildProjectMetadata({ mode: "goal", checkin_hours: "soon" as unknown as number }),
  { mode: "goal", strict_write_sets: true },
);
check(
  "mode goal + numeric string checkin_hours coerces (Number('6') > 0)",
  buildProjectMetadata({ mode: "goal", checkin_hours: "6" as unknown as number }),
  { mode: "goal", checkin_hours: 6, strict_write_sets: true },
);
check(
  "checkin_hours WITHOUT goal mode is ignored entirely",
  buildProjectMetadata({ checkin_hours: 6 }),
  {},
);
checkHas(
  "…and does not leave a checkin_hours key behind",
  buildProjectMetadata({ checkin_hours: 6 }),
  "checkin_hours",
  false,
);

/* ── origin_chat_id (U1, the new key) ─────────────────────────────────────── */
console.log("\n── origin_chat_id (U1) ───────────────────────────────────────");
check(
  "valid uuid → merged into metadata",
  buildProjectMetadata({ origin_chat_id: CHAT_ID }),
  { origin_chat_id: CHAT_ID },
);
check(
  "uppercase uuid is accepted verbatim (UUID_RE is case-insensitive)",
  buildProjectMetadata({ origin_chat_id: CHAT_ID.toUpperCase() }),
  { origin_chat_id: CHAT_ID.toUpperCase() },
);
check(
  "surrounding whitespace is trimmed, not rejected",
  buildProjectMetadata({ origin_chat_id: `  ${CHAT_ID}\n` }),
  { origin_chat_id: CHAT_ID },
);
checkHas("absent → key absent entirely", buildProjectMetadata({}), "origin_chat_id", false);
checkHas(
  "empty string → key absent (never '' — presence is truth downstream)",
  buildProjectMetadata({ origin_chat_id: "" }),
  "origin_chat_id",
  false,
);
checkHas(
  "whitespace-only string → key absent",
  buildProjectMetadata({ origin_chat_id: "   " }),
  "origin_chat_id",
  false,
);
checkHas(
  "undefined → key absent (never null)",
  buildProjectMetadata({ origin_chat_id: undefined }),
  "origin_chat_id",
  false,
);
check(
  "non-goal mode + origin_chat_id still carries the id",
  buildProjectMetadata({ repo: "scratch", origin_chat_id: CHAT_ID }),
  { origin_chat_id: CHAT_ID },
);
check(
  "goal mode + checkin_hours + origin_chat_id → all three coexist",
  buildProjectMetadata({ mode: "goal", checkin_hours: 4, origin_chat_id: CHAT_ID }),
  { mode: "goal", checkin_hours: 4, strict_write_sets: true, origin_chat_id: CHAT_ID },
);

/* ── strict_write_sets (R31, engine-task-graph phase 3) ────────────────────
 * The route reads `project.metadata.strict_write_sets === true` and refuses a
 * builder/tester task with an empty write_set. What is asserted here is the
 * WRITE half: which projects are born carrying the key. The asymmetry is the
 * requirement — "new goal-mode projects created by this engine set it; existing
 * projects do not, so R18's replica is untouched" — so the absence cases below
 * matter at least as much as the presence one. */
console.log("\n── strict_write_sets (R31) ───────────────────────────────────");
check(
  "goal mode sets strict_write_sets: true (the literal, never a truthy string)",
  buildProjectMetadata({ mode: "goal" }).strict_write_sets,
  true,
);
checkHas(
  "no mode → key ABSENT, not false (an existing project's metadata is untouched)",
  buildProjectMetadata({}),
  "strict_write_sets",
  false,
);
checkHas(
  "a full non-goal create body → key absent",
  buildProjectMetadata({ name: "x", brief: "y", repo: "ai-os", architect_tier: "standard" }),
  "strict_write_sets",
  false,
);
checkHas(
  "goal mode → key present",
  buildProjectMetadata({ mode: "goal" }),
  "strict_write_sets",
  true,
);

console.log("\n── origin_chat_id rejection (route maps these to 400) ────────");
const REJECT = "origin_chat_id must be a uuid";
checkThrows("plain word rejected", { origin_chat_id: "not-a-uuid" }, REJECT);
checkThrows("uuid with a missing group rejected", { origin_chat_id: "bfd1283a-b71b-4f35-b577" }, REJECT);
checkThrows(
  "uuid with a trailing character rejected",
  { origin_chat_id: `${CHAT_ID}x` },
  REJECT,
);
checkThrows(
  "non-hex character rejected",
  { origin_chat_id: "zfd1283a-b71b-4f35-b577-7d09aad803f2" },
  REJECT,
);
checkThrows(
  "a path instead of an id rejected (the shell-interpolation failure mode)",
  { origin_chat_id: "/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2" },
  REJECT,
);
checkThrows(
  "the literal string 'null' rejected",
  { origin_chat_id: "null" },
  REJECT,
);
{
  // The blast-radius assertion: an invalid id must abort metadata construction
  // outright, not degrade to a project created without the link.
  let built: Record<string, unknown> | null = null;
  try {
    built = buildProjectMetadata({ mode: "goal", checkin_hours: 6, origin_chat_id: "nope" });
  } catch {
    /* expected */
  }
  check("an invalid id yields NO metadata at all (no partial object)", built, null);
}

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — project metadata builder`,
);
process.exit(failures === 0 ? 0 : 1);
