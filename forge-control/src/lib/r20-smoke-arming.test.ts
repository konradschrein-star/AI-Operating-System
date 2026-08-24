/**
 * R20 arming contract: the researcher smoke must be capable of failing.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The P6 gate rejected the first arming of this smoke not because the deploy
 * was wrong but because the *payload* was: it asked the architect for one task
 * and expected a reviewer nobody was authorised to create, so the project
 * would have auto-closed `done` with zero verification — a green light
 * indistinguishable from a real pass. Two further defects rode along: a
 * research filename that fights the one the engine appends, and a
 * `<this-project-id>` placeholder no reviewer can resolve.
 *
 * The payload is a JSON document, not code, so these are assertions over its
 * text — cross-checked against buildPrompt() in project-tick.ts, which is the
 * thing that makes each defect a defect. When the engine's researcher branch
 * or its prompt header changes, the cross-checks here go stale loudly instead
 * of leaving the smoke quietly mis-armed.
 *
 * /tmp is not the source of truth: the canonical payload is committed at
 * docs/plan/evidence/p6-r20-smoke.json and copied to /tmp for the detached
 * curl, which reads the file at POST time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** src/lib → src → forge-control → repo root. */
const SMOKE_PATH = fileURLToPath(
  new URL("../../../docs/plan/evidence/p6-r20-smoke.json", import.meta.url),
);
const TICK_PATH = fileURLToPath(new URL("./project-tick.ts", import.meta.url));

const smoke = JSON.parse(readFileSync(SMOKE_PATH, "utf8")) as {
  name: string;
  repo: string;
  architect_tier: string;
  brief: string;
};
const brief = smoke.brief;
const tickSrc = readFileSync(TICK_PATH, "utf8");

/**
 * Slice one role branch out of buildPrompt(), between two role guards.
 *
 * Both ends are asserted. An unchecked end marker is the quiet failure this
 * file is supposed to be immune to: `indexOf` returns -1 for a renamed guard,
 * `slice(start, -1)` then runs to EOF, and a branch-scoped assertion silently
 * becomes a whole-file one — the researcher check would pass against the
 * scout branch, which carries the identical `docs/research/round-…` string.
 */
function roleBranch(role: string, endRole: string): string {
  const startMarker = `if (task.role === "${role}") {`;
  const endMarker = `if (task.role === "${endRole}") {`;
  const start = tickSrc.indexOf(startMarker);
  assert.ok(start > 0, `the ${role} branch moved — this test has gone stale`);
  const end = tickSrc.indexOf(endMarker, start);
  assert.ok(
    end > start,
    `the ${endRole} branch no longer follows the ${role} branch — this test has gone stale`,
  );
  return tickSrc.slice(start, end);
}

/** The role branch that decides where a researcher writes its findings. */
const researcherBranch = roleBranch("researcher", "scout");

/** The reviewer branch — checked for the *absence* of the project id. */
const reviewerBranch = roleBranch("reviewer", "builder");

describe("R20 smoke payload", () => {
  test("is a valid POST /api/projects body", () => {
    assert.equal(smoke.name, "p6-r20-researcher-smoke");
    assert.equal(smoke.repo, "scratch", "a live repo would put the smoke next to real work");
    assert.ok(brief.trim().length > 0, "brief required — the route 400s on an empty one");
  });

  test("the architect tier can carry the job F1's fix gave it", () => {
    // R604: `fast` maps to Haiku (project-tick.ts TIER_MODELS). F1's fix turned
    // round 0 from "create one task" into "create two, paste two multi-paragraph
    // briefs verbatim, and substitute a UUID throughout the second". If the
    // architect drops Task B the project auto-closes `done` with no
    // verification — byte-for-byte the R603 outcome, and nothing in the engine
    // asserts Task B exists. The tier is the only lever that reduces that odds.
    assert.notEqual(smoke.architect_tier, "fast", "R604 finding 3: Haiku owns a two-task verbatim paste");
    assert.ok(
      ["junior", "standard", "flagship"].includes(smoke.architect_tier),
      `architect_tier ${smoke.architect_tier} is not a tier that route validation accepts`,
    );
    const tierModels = tickSrc.slice(
      tickSrc.indexOf("const TIER_MODELS"),
      tickSrc.indexOf("};", tickSrc.indexOf("const TIER_MODELS")),
    );
    assert.match(
      tierModels,
      new RegExp(`\\b${smoke.architect_tier}: \\{ model:`),
      "the tier must exist in TIER_MODELS or the run falls back to the role file's model",
    );
    assert.match(tierModels, /fast: \{ model: "claude-haiku/, "the premise of this test");
  });
});

describe("F1 the round-2 reviewer has an author", () => {
  test("the architect is told to create exactly two tasks, not one", () => {
    assert.match(brief, /EXACTLY TWO tasks/);
    assert.doesNotMatch(
      brief,
      /EXACTLY ONE task/,
      "the one-task instruction is the P6 defect: no role then creates the reviewer",
    );
  });

  test("both tasks are specified by role and round", () => {
    assert.match(brief, /round 1, role "researcher"/);
    assert.match(brief, /round 2, role "reviewer"/);
  });

  test("the researcher is not expected to create it — the engine forbids that", () => {
    assert.match(
      researcherBranch,
      /no task creation/,
      "if the engine ever lets a researcher create tasks this test's premise changes",
    );
    assert.match(
      brief,
      /a researcher is explicitly forbidden from creating tasks/,
      "the architect must be told why it cannot defer the reviewer to round 1",
    );
  });

  test("a pending reviewer is what stops the auto-close", () => {
    const projectsSrc = readFileSync(
      fileURLToPath(new URL("../db/projects.ts", import.meta.url)),
      "utf8",
    );
    const start = projectsSrc.indexOf("export async function closeFinishedProjects(");
    assert.ok(start > 0, "closeFinishedProjects moved — this test has gone stale");
    const fn = projectsSrc.slice(start, projectsSrc.indexOf("\n/**", start));
    // The close is blocked by ANY task that has not reached a terminal state.
    // That is precisely why the reviewer must exist before round 1 settles.
    //
    // 2026-08-25: "not 'done'" became "not terminal". A CANCELLED row is
    // retired on purpose and must stop holding its project open — which is
    // exactly what a hand-retired `blocked` row used to do, forever. A PENDING
    // reviewer is untouched by that change and still stops the close, which is
    // this test's whole claim. The companion term is asserted with it, because
    // terminal is not the same as carried: a project of only-cancelled rows is
    // abandoned, not done.
    assert.match(fn, /NOT EXISTS/);
    assert.match(
      fn,
      /AND \$\{stillOpen\(\)\}/,
      "the close gate must read the one terminality rule, not a literal of its own",
    );
    assert.match(
      fn,
      /WHERE project_id = p\.id AND status = 'done'/,
      "a project whose every task was cancelled must not close as done",
    );
  });
});

describe("F2 the research filename does not fight the engine", () => {
  test("the engine names the file, and the brief defers to it", () => {
    assert.match(
      researcherBranch,
      /docs\/research\/round-\$\{task\.round\}-\$\{task\.id\.slice\(0, 8\)\}\.md/,
      "the engine's filename is the premise of this finding",
    );
    assert.match(brief, /the docs\/research\/\*\.md file the engine names for you/);
  });

  test("no literal research filename is hardcoded anywhere in the brief", () => {
    const literals = brief.match(/docs\/research\/[A-Za-z0-9._-]+\.md/g) ?? [];
    assert.deepEqual(
      literals,
      [],
      `the brief pins a filename the engine will override: ${literals.join(", ")}`,
    );
    assert.doesNotMatch(brief, /perplexity-api-smoke\.md/, "the P6 defect, by name");
  });

  test("the reviewer is told to glob rather than guess", () => {
    assert.match(brief, /ls -la docs\/research\//);
    assert.match(brief, /do NOT assume any particular filename/);
  });
});

describe("F4 the project id reaches whoever needs it", () => {
  test("the reviewer prompt does not carry the project UUID", () => {
    assert.doesNotMatch(
      reviewerBranch,
      /taskCurl\(project\.id\)/,
      "if the reviewer ever gets the id directly, the substitution dance is obsolete",
    );
  });

  test("the placeholder is a substitution token, not an unresolvable one", () => {
    assert.doesNotMatch(brief, /<this-project-id>/, "the P6 defect: nothing resolves this");
    assert.match(brief, /substitute it for every occurrence of the token PROJECT_ID/);
    assert.match(
      brief,
      /with PROJECT_ID replaced by this project's actual UUID/,
      "the architect must be told to substitute at paste time, not merely that a token exists",
    );
  });

  test("the architect can actually read the id out of its own prompt", () => {
    const architectBranch = roleBranch("architect", "planner");
    assert.match(architectBranch, /taskCurl\(project\.id\)/);
    assert.match(brief, /curl printed in your prompt: it already carries THIS project's real UUID/);
  });
});

describe("scope containment", () => {
  test("the smoke stays off the live checkout and off pm2", () => {
    assert.match(brief, /Do not touch \/opt\/forge-ai-os/);
    assert.match(brief, /Do not restart any pm2 process/);
  });

  test("the engine's trailing PLAN.md instruction cannot be read as a third task", () => {
    assert.match(brief, /it does not license any third task/);
  });
});
