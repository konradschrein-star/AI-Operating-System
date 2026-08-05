/**
 * Tests for the prompt-policy blocks in project-tick.ts.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * T-number below is quoted from docs/plan/03-quality.md §1; the phase gate
 * cites it by number.
 *
 * These tests assert against the constants' OWN output (WORKTREE_POLICY(...),
 * REVIEWER_LIVE_CHECK(...)) rather than hand-copied substrings, so a future
 * wording change to the policy text cannot silently desync the test from the
 * engine — only a change to which roles/repos receive which block would.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPrompt,
  WORKTREE_POLICY,
  REVIEWER_LIVE_CHECK,
  DEPLOY_GUIDE,
  GITHUB_PUSH_GUIDE,
  parseRoleFile,
} from "./project-tick.ts";
import type { Project, ProjectTask } from "../db/projects.ts";

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
    chain_key: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const ROLES = ["architect", "planner", "builder", "reviewer", "researcher", "scout"] as const;

describe("T10 prompt policy", () => {
  test("worktree policy present for every role on repo 'ai-os'", () => {
    const proj = project({ repo: "ai-os" });
    const expected = WORKTREE_POLICY("/opt/forge-ai-os");
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(
        prompt.includes(expected),
        `role ${role} missing WORKTREE_POLICY("/opt/forge-ai-os")`,
      );
    }
  });

  test("worktree policy present for every role on repo 'content-forge'", () => {
    const proj = project({ repo: "content-forge" });
    const expected = WORKTREE_POLICY("/opt/content-forge");
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(
        prompt.includes(expected),
        `role ${role} missing WORKTREE_POLICY("/opt/content-forge")`,
      );
    }
  });

  test("scratch projects receive none of the live-checkout policy blocks", () => {
    // Checked against the POLICY BLOCKS themselves (WORKTREE_POLICY(...)'s own
    // rendered text, DEPLOY_GUIDE, GITHUB_PUSH_GUIDE, the porcelain command),
    // not a bare "/opt/content-forge" substring: the architect role's static
    // mission (agents/architect.md) unconditionally describes the Content
    // Forge stack background and always contains "/opt/content-forge" —
    // unrelated to the worktree-policy feature under test here.
    const proj = project({ repo: "scratch" });
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(
        !prompt.includes(WORKTREE_POLICY("/opt/forge-ai-os")),
        `role ${role} leaked the ai-os worktree policy`,
      );
      assert.ok(
        !prompt.includes(WORKTREE_POLICY("/opt/content-forge")),
        `role ${role} leaked the content-forge worktree policy`,
      );
      assert.ok(!prompt.includes("status --porcelain"), `role ${role} leaked live-check command`);
      assert.ok(!prompt.includes(DEPLOY_GUIDE), `role ${role} leaked DEPLOY_GUIDE`);
      assert.ok(!prompt.includes(GITHUB_PUSH_GUIDE), `role ${role} leaked GITHUB_PUSH_GUIDE`);
    }
  });

  test("reviewer prompt carries the live-checkout cleanliness check; builder and planner do not", () => {
    const proj = project({ repo: "ai-os" });
    const reviewerPrompt = buildPrompt(task({ role: "reviewer" }), proj);
    assert.ok(
      reviewerPrompt.includes("git -C /opt/forge-ai-os status --porcelain"),
      "reviewer prompt missing the literal cleanliness-check command",
    );
    assert.ok(
      reviewerPrompt.includes("NEEDS_FIXES"),
      "reviewer prompt missing the NEEDS_FIXES consequence wording",
    );

    const builderPrompt = buildPrompt(task({ role: "builder" }), proj);
    const plannerPrompt = buildPrompt(task({ role: "planner" }), proj);
    assert.ok(!builderPrompt.includes("status --porcelain"), "builder prompt leaked the live check");
    assert.ok(!plannerPrompt.includes("status --porcelain"), "planner prompt leaked the live check");
  });

  test("goal-mode architect prompt carries DEPLOY_GUIDE with the detached-restart contract", () => {
    const proj = project({ repo: "ai-os", metadata: { mode: "goal" } });
    const prompt = buildPrompt(task({ role: "architect" }), proj);
    assert.ok(prompt.includes(DEPLOY_GUIDE), "goal-mode architect prompt missing DEPLOY_GUIDE");

    assert.ok(DEPLOY_GUIDE.includes("setsid nohup"), "DEPLOY_GUIDE missing setsid nohup");
    assert.ok(
      DEPLOY_GUIDE.includes("safe-restart.sh forge-executor"),
      "DEPLOY_GUIDE missing safe-restart.sh forge-executor",
    );
    assert.ok(DEPLOY_GUIDE.includes("43200 45"), "DEPLOY_GUIDE missing the 43200 45 arguments");
    assert.match(
      DEPLOY_GUIDE,
      /NEVER[^.]*pm2 restart forge-executor/,
      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
    );
    assert.ok(
      DEPLOY_GUIDE.includes("pm2 restart forge-control"),
      "DEPLOY_GUIDE must still allow pm2 restart forge-control",
    );
  });

  test("regression guard: old contradictory PR paragraph is gone from the goal-mode architect prompt", () => {
    const proj = project({ repo: "ai-os", metadata: { mode: "goal" } });
    const prompt = buildPrompt(task({ role: "architect" }), proj);
    assert.ok(
      !prompt.includes("never open PRs unless the brief asks"),
      "old pre-R14/R16/R17 wording resurfaced in the goal-mode architect prompt",
    );
  });

  test("GITHUB_PUSH_GUIDE appears in planner and reviewer prompts for repo 'ai-os', absent for 'scratch'", () => {
    const repoProj = project({ repo: "ai-os" });
    const plannerPrompt = buildPrompt(task({ role: "planner" }), repoProj);
    const reviewerPrompt = buildPrompt(task({ role: "reviewer" }), repoProj);
    assert.ok(plannerPrompt.includes(GITHUB_PUSH_GUIDE), "planner prompt missing GITHUB_PUSH_GUIDE");
    assert.ok(reviewerPrompt.includes(GITHUB_PUSH_GUIDE), "reviewer prompt missing GITHUB_PUSH_GUIDE");
    assert.ok(
      GITHUB_PUSH_GUIDE.includes("scripts/git-sync-branch.sh"),
      "GITHUB_PUSH_GUIDE missing scripts/git-sync-branch.sh",
    );

    const scratchProj = project({ repo: "scratch" });
    const scratchPlannerPrompt = buildPrompt(task({ role: "planner" }), scratchProj);
    const scratchReviewerPrompt = buildPrompt(task({ role: "reviewer" }), scratchProj);
    assert.ok(
      !scratchPlannerPrompt.includes(GITHUB_PUSH_GUIDE),
      "scratch planner prompt should not carry GITHUB_PUSH_GUIDE",
    );
    assert.ok(
      !scratchReviewerPrompt.includes(GITHUB_PUSH_GUIDE),
      "scratch reviewer prompt should not carry GITHUB_PUSH_GUIDE",
    );
  });

  test("force-free contract: none of the four policy constants ever teach a force push", () => {
    // GITHUB_PUSH_GUIDE legitimately names "--force" and "--force-with-lease"
    // in order to PROHIBIT them ("NEVER force-push, never `--force`, never
    // `--force-with-lease`") — a blanket substring-absence check would fail
    // against that safe, correct text, since forbidding a flag by name
    // requires mentioning it. The real contract (matching the brief's own
    // parenthetical, "the guidance must never teach a force push") is that no
    // constant ever instructs RUNNING one: no "push --force", "push -f", or
    // "--force-with-lease" appearing as part of an actual command to execute.
    const FORCE_COMMAND_RE = /push\s+(--force(-with-lease)?|-f\b)/i;
    const texts = [
      WORKTREE_POLICY("/opt/forge-ai-os"),
      REVIEWER_LIVE_CHECK("/opt/forge-ai-os"),
      DEPLOY_GUIDE,
      GITHUB_PUSH_GUIDE,
    ];
    for (const text of texts) {
      assert.ok(!FORCE_COMMAND_RE.test(text), `policy text must never instruct running a force push: ${text}`);
    }

    // WORKTREE_POLICY, REVIEWER_LIVE_CHECK, and DEPLOY_GUIDE have no reason to
    // discuss force-pushing at all — the literal, blanket check DOES hold for
    // those three.
    for (const text of [WORKTREE_POLICY("/opt/forge-ai-os"), REVIEWER_LIVE_CHECK("/opt/forge-ai-os"), DEPLOY_GUIDE]) {
      assert.ok(!text.includes("--force"), "this constant must never mention --force at all");
      assert.ok(!text.includes("force-with-lease"), "this constant must never mention force-with-lease at all");
    }

    // GITHUB_PUSH_GUIDE's mentions of the flag must live strictly inside a
    // "never ..." prohibition, never as a bare/affirmative reference.
    assert.match(
      GITHUB_PUSH_GUIDE,
      /NEVER force-push, never `--force`, never `--force-with-lease`/,
      "GITHUB_PUSH_GUIDE's force mentions must stay inside the never-worded prohibition",
    );

    // Same command-level contract as seen through the fully assembled prompt.
    const proj = project({ repo: "ai-os" });
    for (const role of ROLES) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(!FORCE_COMMAND_RE.test(prompt), `${role} prompt must never instruct running a force push`);
    }
  });
});

describe("T11 researcher frontmatter parse", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;

  test("parseRoleFile parses agents/researcher.md via the engine's own logic", () => {
    const raw = readFileSync(`${repoRoot}agents/researcher.md`, "utf8");
    const cfg = parseRoleFile(raw);

    assert.deepEqual(
      cfg.tools,
      ["Read", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"],
      "researcher.md tools frontmatter should parse to exactly this allowlist, in order",
    );
    assert.equal(cfg.model, "claude-opus-5", "researcher.md model should survive sanitizeModel");
    assert.equal(cfg.effort, "high", "researcher.md effort should survive sanitizeEffort");
    assert.ok(cfg.mission.length > 0, "researcher.md mission should be non-empty");
    assert.ok(!cfg.mission.startsWith("---"), "researcher.md mission should have frontmatter stripped");
    assert.ok(cfg.mission.includes("docs/research"), "researcher.md mission should mention docs/research");
    assert.match(
      cfg.mission,
      /citation/i,
      "researcher.md mission should mention a citation obligation",
    );
  });

  test("parseRoleFile negative control: raw text with no frontmatter", () => {
    const cfg = parseRoleFile("no frontmatter here");
    assert.equal(cfg.mission, "no frontmatter here");
    assert.equal(cfg.tools, null);
    assert.equal(cfg.model, null);
    assert.equal(cfg.effort, null);
  });
});
