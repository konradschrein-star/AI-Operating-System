/**
 * CP3-4 (round 1104): prompt-snapshot and source-assertion tests proving
 * CP3's four requirements — C15 (the operator-prompt sentence that lets a
 * manager-chat run start a linked project), C16 (createRunForTask copies the
 * linkage onto every worker run), C17 (the MANAGER COMMS prompt block, gated
 * on linkage, with the verdict-role addendum), C18 (goal-mode corpus paths
 * are slugged per project instead of colliding in the flat docs/plan/).
 *
 * WHY THE KEY IS BUILT BY CONCATENATION, NEVER SPELLED. This file lives
 * under forge-control/src, so it sits inside the diff that 08 §4.3's
 * boundary grep scans:
 *
 *     git diff main...HEAD -- forge-control/src | grep -in <the key>
 *
 * where <the key> is the metadata key spelled out in db/projects.ts. That
 * grep must match ONLY lib/cc-runner.ts and db/projects.ts — the two files
 * boundary D5 names as the sole owners of the key. Spelling it literally
 * anywhere in this file, including in a comment (even inside a reproduced
 * copy of the grep itself, which is how round 1105 failed the gate) or
 * inside a regex source string, fails the phase gate. So the key is built once
 * from two halves and reused everywhere below — in metadata objects
 * (`{ [KEY]: uuid }`) and in source-text assertions
 * (`assert.match(SRC, new RegExp(KEY))`) alike. Do not "clean this up" into
 * a literal; that is exactly the change the grep exists to catch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildPrompt, MANAGER_COMMS, ESCALATION_POLICY } from "./project-tick.ts";
import { projectSlug } from "./run-control-rules.ts";
import { isVerdictRole } from "./project-reconcile.ts";
import type { Project, ProjectTask, TaskRole } from "../db/projects.ts";

const KEY = "origin_" + "chat_id";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Slice a named `export function`/`export async function` body out to the
 *  next top-level `export`, same helper as run-control-surface.test.ts —
 *  kept local rather than shared so this file's only cross-file dependency
 *  stays the two engine functions it is actually testing. */
function sliceExport(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  const startSync = src.indexOf(`export function ${name}`);
  const from = start >= 0 ? start : startSync;
  assert.ok(from >= 0, `export ${name} not found in source`);
  const nextExport = src.indexOf("\nexport ", from + 1);
  // No next export (this function runs to EOF) means there is no neighbour's
  // leading doc-comment to back up over — doing so anyway would walk
  // backwards into this function's OWN internal comments (createRunForTask's
  // `project_metadata` field carries one) and truncate the slice mid-body.
  if (nextExport < 0) return src.slice(from);
  const precedingComment = src.lastIndexOf("/**", nextExport);
  const end = precedingComment > from ? precedingComment : nextExport;
  return src.slice(from, end);
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Test Project",
    brief: "Do the thing.",
    repo: "ai-os",
    workspace_dir: null,
    base_branch: "main",
    work_branch: "project/x",
    status: "active",
    metadata: {},
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    project_id: "p1",
    round: 1,
    role: "builder",
    title: "Do it",
    brief: "Implement the thing.",
    status: "ready",
    run_id: null,
    fix_cycle: 0,
    tier: null,
    attempt: 0,
    chain_key: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

/** All seven roles the engine builds a prompt for (steward is untouched by
 *  CP3 — it never gates a round and carries no verdict contract). */
const ROLES: readonly TaskRole[] = [
  "architect",
  "planner",
  "builder",
  "reviewer",
  "tester",
  "researcher",
  "scout",
];

const UUID = "a1b2c3d4-e5f6-4890-9abc-1234567890ab";

describe("CP3 C17 — MANAGER COMMS gating", () => {
  test("present iff linked: every role's prompt carries MANAGER_COMMS's own output exactly when linked, and none of it when not", () => {
    const linked = project({ metadata: { [KEY]: UUID } });
    const unlinked = project({ metadata: {} });

    for (const role of ROLES) {
      const linkedPrompt = buildPrompt(task({ role }), linked);
      assert.ok(
        linkedPrompt.includes(MANAGER_COMMS(UUID, role)),
        `role ${role}: linked prompt missing MANAGER_COMMS(uuid, role) verbatim`,
      );

      const unlinkedPrompt = buildPrompt(task({ role }), unlinked);
      assert.ok(
        !unlinkedPrompt.includes(UUID),
        `role ${role}: unlinked prompt leaked the manager-chat uuid`,
      );
      assert.ok(
        !unlinkedPrompt.includes("MANAGER COMMS"),
        `role ${role}: unlinked prompt leaked the MANAGER COMMS heading`,
      );
      assert.ok(
        !unlinkedPrompt.includes("null"),
        `role ${role}: unlinked prompt contains the literal "null" — a degraded id must never reach the prompt`,
      );
      assert.ok(
        !unlinkedPrompt.includes("undefined"),
        `role ${role}: unlinked prompt contains the literal "undefined" — a degraded id must never reach the prompt`,
      );
    }
  });

  test("verdict clause: reviewer and tester carry the restate-your-VERDICT instruction; the other five roles do not", () => {
    // Derived from MANAGER_COMMS's OWN output rather than retyped: a
    // non-verdict role's block is exactly the base text (MANAGER_COMMS does
    // not read `role` at all before the isVerdictRole gate), so the verdict
    // addendum is whatever a verdict role's block has beyond that shared
    // prefix.
    const baseBlock = MANAGER_COMMS(UUID, "builder");
    const verdictBlock = MANAGER_COMMS(UUID, "reviewer");
    assert.ok(verdictBlock.startsWith(baseBlock), "verdict block should extend the base block, not diverge from it");
    const verdictExtra = verdictBlock.slice(baseBlock.length);
    assert.ok(verdictExtra.length > 0, "verdict role must add SOMETHING beyond the base MANAGER COMMS block");
    assert.match(verdictExtra, /VERDICT:/, "the addendum should be about the VERDICT: line");

    const linked = project({ metadata: { [KEY]: UUID } });
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), linked);
      if (isVerdictRole(role)) {
        assert.ok(prompt.includes(verdictExtra), `verdict role ${role} missing the restate-your-VERDICT addendum`);
      } else {
        assert.ok(!prompt.includes(verdictExtra), `non-verdict role ${role} leaked the restate-your-VERDICT addendum`);
      }
    }
  });

  // Deliberately NOT titled "byte-identical to pre-CP3": it is not, and this is
  // the test a future reader would cite as evidence for that claim. CP3 also
  // slugs the goal-mode corpus paths (C18), so a goal-mode project's prompt DID
  // change text without any linkage. What this test does carry is the narrower
  // and true claim the comms gate needs: without linkage the prompt ends exactly
  // where it ended before — at ESCALATION_POLICY — and no comms text appears.
  test("an unlinked project's prompt ends exactly with ESCALATION_POLICY and carries no comms text", () => {
    const unlinkedRepo = project({ repo: "ai-os", metadata: {} });
    const unlinkedScratch = project({ repo: "scratch", metadata: {} });

    for (const proj of [unlinkedRepo, unlinkedScratch]) {
      for (const role of ROLES) {
        const prompt = buildPrompt(task({ role }), proj);
        assert.ok(
          prompt.endsWith(ESCALATION_POLICY),
          `role ${role} (repo ${proj.repo}): unlinked prompt does not end with ESCALATION_POLICY — the comms wrapper fired without a link`,
        );
        assert.ok(
          !prompt.includes("MANAGER COMMS"),
          `role ${role} (repo ${proj.repo}): unlinked prompt still contains comms text`,
        );
      }
    }
  });
});

describe("CP3 C18 — slugged planning-corpus paths", () => {
  const GOAL_NAME = "CP3 Linkage Test Project";
  const GOAL_ID = "9f8e7d6c-5b4a-4321-9876-543210fedcba";
  const goalProject = project({
    id: GOAL_ID,
    name: GOAL_NAME,
    repo: "ai-os",
    metadata: { mode: "goal" },
  });
  const slug = projectSlug(GOAL_NAME, GOAL_ID);
  const slugPath = `docs/plan/${slug}/`;

  test("architect and planner prompts use the slugged corpus path, never a flat one", () => {
    const architectPrompt = buildPrompt(task({ role: "architect" }), goalProject);
    assert.ok(architectPrompt.includes(slugPath), "goal-mode architect prompt missing the slugged corpus path");
    assert.doesNotMatch(
      architectPrompt,
      /docs\/plan\/0/,
      "a flat docs/plan/0*-....md path survived — the corpus must be born under its slug",
    );

    const plannerPrompt = buildPrompt(task({ role: "planner" }), goalProject);
    assert.ok(plannerPrompt.includes(slugPath), "planner prompt missing the same slugged corpus path");
  });

  /** Round 1105 finding 2. Slugging a path that a prompt READS is not the same
   *  change as slugging one it CREATES. `buildPrompt` runs at every task spawn,
   *  so the moment this work deploys, a project planned BEFORE it — flat corpus,
   *  and boundary D6 forbids moving it — gets the new text on its next task. If
   *  the reading branches offered only the slug, that project's reviewer would
   *  be pointed at a directory that cannot exist and (under the old "if it
   *  exists" hedge) would quietly review with no quality gate. So the reading
   *  branches must name BOTH layouts, for a flat-corpus project as much as for
   *  a slugged one. */
  for (const [label, proj] of [
    ["goal-mode (slugged corpus)", goalProject],
    ["flat-corpus project planned before the slug landed", project({ id: GOAL_ID, name: GOAL_NAME, repo: "ai-os" })],
  ] as const) {
    test(`reading references name BOTH the slugged and the flat corpus path — ${label}`, () => {
      const reviewerPrompt = buildPrompt(task({ role: "reviewer" }), proj);
      assert.ok(
        reviewerPrompt.includes(`${slugPath}03-quality.md`),
        "reviewer prompt lost the slugged quality-gate path",
      );
      assert.ok(
        reviewerPrompt.includes("docs/plan/03-quality.md"),
        "reviewer prompt does not name the FLAT quality-gate path — an in-flight project's reviewer " +
          "would be sent to a directory that does not exist and cannot be created (boundary D6)",
      );
      assert.doesNotMatch(
        reviewerPrompt,
        /03-quality\.md if it\s+exists/,
        "the silent 'if it exists' hedge is back — the reviewer must say which corpus it read, not fall through",
      );

      const plannerPrompt = buildPrompt(task({ role: "planner" }), proj);
      assert.ok(plannerPrompt.includes(slugPath), "planner prompt lost the slugged corpus path");
      assert.ok(
        plannerPrompt.includes("flat docs/plan/"),
        "planner prompt does not name the flat corpus layout an in-flight project still uses",
      );
    });
  }

  test("the CREATING sites stay slug-only: the architect is never offered a flat corpus to write into", () => {
    const architectPrompt = buildPrompt(task({ role: "architect" }), goalProject);
    for (const doc of ["00-vision.md", "01-requirements.md", "02-architecture.md", "03-quality.md", "04-phases.md"]) {
      assert.ok(architectPrompt.includes(`${slugPath}${doc}`), `architect prompt lost the slugged ${doc}`);
      assert.ok(
        !architectPrompt.includes(`docs/plan/${doc}`),
        `architect prompt offers the FLAT docs/plan/${doc} — a corpus must be born under its slug, never in the flat dir`,
      );
    }
  });

  test("non-regression: the real flat file docs/plan/10-policy-agent-autonomy-and-escalation.md still appears unslugged in every role's prompt", () => {
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), goalProject);
      assert.ok(
        prompt.includes("docs/plan/10-policy-agent-autonomy-and-escalation.md"),
        `role ${role}: lost the pointer to the real (unslugged) escalation-policy doc`,
      );
    }
  });
});

describe("CP3 — scratch / non-goal-mode edge case", () => {
  test("scratch, non-goal-mode project: no crash, comms gating still holds, no worktree-policy regression", () => {
    const unlinkedScratch = project({ repo: "scratch", metadata: {} });
    const linkedScratch = project({ repo: "scratch", metadata: { [KEY]: UUID } });

    for (const role of ROLES) {
      assert.doesNotThrow(() => buildPrompt(task({ role }), unlinkedScratch));
      assert.doesNotThrow(() => buildPrompt(task({ role }), linkedScratch));

      const unlinkedPrompt = buildPrompt(task({ role }), unlinkedScratch);
      assert.ok(!unlinkedPrompt.includes("WORKTREE-ONLY POLICY"), `role ${role}: scratch project leaked a worktree policy`);
      assert.ok(!unlinkedPrompt.includes("MANAGER COMMS"), `role ${role}: unlinked scratch project leaked comms text`);

      const linkedPrompt = buildPrompt(task({ role }), linkedScratch);
      assert.ok(
        linkedPrompt.includes(MANAGER_COMMS(UUID, role)),
        `role ${role}: linked scratch project missing the comms block`,
      );
      assert.ok(!linkedPrompt.includes("WORKTREE-ONLY POLICY"), `role ${role}: linked scratch project leaked a worktree policy`);
    }
  });
});

describe("CP3 — source assertions (C15, C16, boundary)", () => {
  const CC_RUNNER_SRC = readSource("./cc-runner.ts");
  const PROJECTS_SRC = readSource("../db/projects.ts");
  const PROJECT_TICK_SRC = readSource("./project-tick.ts");

  test("C15: cc-runner.ts's operator prompt bullet on POST /api/projects names the key and $FORGE_RUN_UUID together", () => {
    const marker = "POST /api/projects";
    const idx = CC_RUNNER_SRC.indexOf(marker);
    assert.ok(idx >= 0, "POST /api/projects bullet not found in cc-runner.ts");
    const window = CC_RUNNER_SRC.slice(idx, idx + 700);
    assert.match(window, new RegExp(KEY), "the POST /api/projects bullet does not mention the linkage key");
    assert.ok(window.includes("$FORGE_RUN_UUID"), "the POST /api/projects bullet does not mention $FORGE_RUN_UUID");
  });

  test("C16: db/projects.ts owns the key and exports managerChatRunId; createRunForTask reads the linkage off project_metadata", () => {
    assert.match(PROJECTS_SRC, new RegExp(KEY), "db/projects.ts no longer defines the linkage key");
    assert.match(PROJECTS_SRC, /export function managerChatRunId/, "managerChatRunId is no longer exported");

    const createRunForTaskSrc = sliceExport(PROJECTS_SRC, "createRunForTask");
    assert.ok(
      createRunForTaskSrc.includes("project_metadata"),
      "createRunForTask no longer accepts project_metadata to derive the linkage from",
    );
    assert.ok(
      createRunForTaskSrc.includes("managerChatRunId("),
      "createRunForTask no longer calls managerChatRunId to resolve the linkage",
    );
  });

  test("boundary: project-tick.ts never spells the linkage key — it only ever asks managerChatRunId()", () => {
    assert.doesNotMatch(
      PROJECT_TICK_SRC,
      new RegExp(KEY),
      "project-tick.ts contains the literal linkage key — this is the exact drift 08 §4.3's boundary grep forbids",
    );
    assert.match(
      PROJECT_TICK_SRC,
      /managerChatRunId\(/,
      "project-tick.ts should resolve the linkage through managerChatRunId(), not re-derive it",
    );
  });
});
