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

/** The role branch that decides where a researcher writes its findings. */
const researcherBranch = (() => {
  const start = tickSrc.indexOf('if (task.role === "researcher") {');
  assert.ok(start > 0, "the researcher branch moved — this test has gone stale");
  return tickSrc.slice(start, tickSrc.indexOf('if (task.role === "scout") {', start));
})();

/** The reviewer branch — checked for the *absence* of the project id. */
const reviewerBranch = (() => {
  const start = tickSrc.indexOf('if (task.role === "reviewer") {');
  assert.ok(start > 0, "the reviewer branch moved — this test has gone stale");
  return tickSrc.slice(start, tickSrc.indexOf('if (task.role === "builder") {', start));
})();

describe("R20 smoke payload", () => {
  test("is a valid POST /api/projects body", () => {
    assert.equal(smoke.name, "p6-r20-researcher-smoke");
    assert.equal(smoke.repo, "scratch", "a live repo would put the smoke next to real work");
    assert.equal(smoke.architect_tier, "fast");
    assert.ok(brief.trim().length > 0, "brief required — the route 400s on an empty one");
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
    // The close is blocked by ANY task that is not 'done'. That is precisely
    // why the reviewer must exist before round 1 settles.
    assert.match(fn, /NOT EXISTS/);
    assert.match(fn, /status <> 'done'/);
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
    const architectBranch = tickSrc.slice(
      tickSrc.indexOf('if (task.role === "architect") {'),
      tickSrc.indexOf('if (task.role === "planner") {'),
    );
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
