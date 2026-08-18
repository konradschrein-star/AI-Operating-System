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
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  buildPrompt,
  WORKTREE_POLICY,
  REVIEWER_LIVE_CHECK,
  DEPLOY_GUIDE,
  GITHUB_PUSH_GUIDE,
  RESEARCH_INSTRUMENTS,
  ESCALATION_POLICY,
  BROWSER_FIRST,
  SCREENSHOT_CONVENTION,
  parseRoleFile,
  roleFilePaths,
  readRoleFile,
  REPO_AGENTS_DIR,
} from "./project-tick.ts";
import { liveCheckoutPath } from "./workspace.ts";
import type { Project, ProjectTask, TaskRole } from "../db/projects.ts";

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
    // Migration 0040's four columns, at their schema defaults. `depends_on:
    // null` is the LEGACY sentinel, which is what every row this factory
    // stands in for is: these cases predate the task graph and must keep
    // reading as pre-graph rows. `graph_frozen: false` is the same statement
    // about provenance — no backfill ever touched these rows (R71, round 242).
    // Added with the ProjectTask fields themselves (engine-task-graph phase 2)
    // — a factory that omits a required column stops compiling, which is the
    // point of the columns moving together.
    depends_on: null,
    workstream: "main",
    write_set: [],
    graph_frozen: false,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

/** Every role the engine builds a prompt for. `tester` joined at R850, when it
 *  started gating rounds like the reviewer — a gating role that silently lost
 *  the worktree policy would be a build-phase agent loose in the live checkout. */
const ROLES = [
  "architect",
  "planner",
  "builder",
  "reviewer",
  "tester",
  "researcher",
  "scout",
] as const;

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

  test("tester prompt states the VERDICT contract and its blocking consequence (R850)", () => {
    // The tester's verdict is now parsed, consolidated and capped exactly like a
    // reviewer's, so a tester that ends without a VERDICT line BLOCKS the
    // project. That consequence has to be in the engine's own prompt, not left
    // to agents/tester.md — which is also read by the interactive Task-tool
    // tester, where no orchestrator is parsing anything.
    const prompt = buildPrompt(task({ role: "tester" }), project({ repo: "ai-os" }));
    assert.match(prompt, /VERDICT: PASS/);
    assert.match(prompt, /VERDICT: NEEDS_FIXES/);
    assert.match(
      prompt,
      /missing verdict blocks the whole project/,
      "the tester must be told what silence costs",
    );
    assert.match(
      prompt,
      /never start, patch or restart a live service/,
      "a tester needs a running surface — say plainly it may not create one itself",
    );
  });

  test("the live-checkout cleanliness gate stays the reviewer's alone", () => {
    // Deliberate asymmetry: the tester never judges code, so handing it the
    // git-status gate would duplicate the reviewer's finding and produce two
    // NEEDS_FIXES verdicts for one dirty file.
    const proj = project({ repo: "ai-os" });
    const testerPrompt = buildPrompt(task({ role: "tester" }), proj);
    assert.ok(
      !testerPrompt.includes("status --porcelain"),
      "tester prompt leaked the reviewer's live-checkout check",
    );
    assert.ok(
      testerPrompt.includes(WORKTREE_POLICY("/opt/forge-ai-os")),
      "the tester still gets the worktree policy — it must not edit the live checkout either",
    );
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

  test("force-free contract: no policy constant ever teaches a force push", () => {
    // GITHUB_PUSH_GUIDE legitimately names "--force" and "--force-with-lease"
    // in order to PROHIBIT them ("NEVER force-push, never `--force`, never
    // `--force-with-lease`") — a blanket substring-absence check would fail
    // against that safe, correct text, since forbidding a flag by name
    // requires mentioning it. The real contract (matching the brief's own
    // parenthetical, "the guidance must never teach a force push") is that no
    // constant ever instructs RUNNING one: no "push --force", "push -f", or
    // "--force-with-lease" appearing as part of an actual command to execute.
    //
    // ESCALATION_POLICY joined the list at R870: it names force-pushing over
    // shared history as an escalation trigger, which is a prohibition of the
    // same family — it must never read as an instruction either.
    const FORCE_COMMAND_RE = /push\s+(--force(-with-lease)?|-f\b)/i;
    const texts = [
      WORKTREE_POLICY("/opt/forge-ai-os"),
      REVIEWER_LIVE_CHECK("/opt/forge-ai-os"),
      DEPLOY_GUIDE,
      GITHUB_PUSH_GUIDE,
      ESCALATION_POLICY,
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

/**
 * T13 — the file T11 parses must be the file the ENGINE loads.
 *
 * T11 alone is a trap: it reads the worktree's agents/researcher.md, which
 * roleConfig() never consulted before the roleFilePaths() fallback existed. It
 * could stay green while a live researcher task took the catch branch and ran
 * on the bare "You are the researcher" mission — no citation discipline, no
 * tool allowlist, no refusals. These tests assert against the engine's own
 * resolution order instead.
 */
describe("T13 role file resolution + install parity", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const worktreeCopy = `${repoRoot}agents/researcher.md`;
  const RESEARCHER_TOOLS = ["Read", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"];

  test("roleFilePaths prefers AGENTS_DIR, then the repo's committed agents/", () => {
    const paths = roleFilePaths("researcher");
    assert.equal(paths.length, 2, "exactly two candidates: fleet dir, then repo copy");
    assert.equal(
      paths[0],
      `${process.env.AGENTS_DIR ?? "/root/.claude/agents"}/researcher.md`,
      "a hand-installed definition must keep overriding the committed one",
    );
    assert.equal(paths[1], `${REPO_AGENTS_DIR}/researcher.md`);
    assert.equal(
      readFileSync(paths[1], "utf8"),
      readFileSync(worktreeCopy, "utf8"),
      "REPO_AGENTS_DIR must resolve to this checkout's agents/ directory",
    );
  });

  test("the engine resolves a real researcher definition, never the bare fallback", () => {
    const found = readRoleFile("researcher");
    assert.ok(found, `no researcher definition on any of [${roleFilePaths("researcher").join(", ")}]`);
    const cfg = parseRoleFile(found.raw);
    assert.deepEqual(cfg.tools, RESEARCHER_TOOLS, `tools allowlist from ${found.path}`);
    assert.equal(cfg.model, "claude-opus-5");
    assert.equal(cfg.effort, "high");
    assert.ok(cfg.mission.includes("docs/research"), `mission body from ${found.path}`);
  });

  /** AMENDED at R703. The original assertion was `installed === worktree copy`,
   *  which is unsatisfiable from inside a build phase that legitimately EDITS
   *  the role file: the worktree is ahead of the deployed engine by design, and
   *  no task of this project may write into AGENTS_DIR (/root/.claude is a
   *  guarded path — the reason R19 was struck) or hot-install a mission that
   *  names scripts the live checkout does not have yet.
   *
   *  The invariant that actually protects the engine is narrower and now stated
   *  exactly: the installed copy must match the DEPLOYED definition
   *  (`<live checkout>/agents/researcher.md`). If it does, the running engine
   *  is loading what was last deployed and nothing is stale. A worktree that is
   *  ahead of both is a pending DEPLOY OBLIGATION, reported as a diagnostic
   *  naming the copy the deploy phase must refresh — because AGENTS_DIR still
   *  wins over the repo fallback, merging alone does NOT land a role-file
   *  change. Genuine rot (installed ≠ deployed) still fails, and so does a case
   *  we cannot classify because the deployed copy is unreadable. */
  test("install parity: AGENTS_DIR copy tracks the DEPLOYED definition; worktree drift is a deploy obligation", (t) => {
    const installed = roleFilePaths("researcher")[0];
    let installedRaw: string;
    try {
      installedRaw = readFileSync(installed, "utf8");
    } catch (err) {
      // Never a silent pass: say out loud which copy the engine will use.
      const code = (err as NodeJS.ErrnoException).code;
      t.diagnostic(
        `${installed} unreadable (${code}) — parity unchecked; the engine falls back to ` +
          `${REPO_AGENTS_DIR}/researcher.md, which the previous test asserts is a real definition.`,
      );
      assert.equal(
        readRoleFile("researcher")?.path,
        `${REPO_AGENTS_DIR}/researcher.md`,
        "with no installed copy the repo fallback must be what resolves",
      );
      return;
    }

    const worktreeRaw = readFileSync(worktreeCopy, "utf8");
    if (installedRaw === worktreeRaw) return; // fully in sync — nothing pending.

    // Out of sync. Which of the two cases is it? The deployed checkout answers.
    const live = liveCheckoutPath("ai-os");
    assert.ok(live, "repo 'ai-os' must have a live checkout path");
    const deployedCopy = `${live}/agents/researcher.md`;
    let deployedRaw: string;
    try {
      deployedRaw = readFileSync(deployedCopy, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      assert.fail(
        `${installed} differs from the committed agents/researcher.md and ${deployedCopy} is ` +
          `unreadable (${code}), so the drift cannot be classified. Refusing to pass: the engine ` +
          `loads ${installed}, since AGENTS_DIR wins over the repo fallback.`,
      );
    }
    assert.equal(
      installedRaw,
      deployedRaw,
      `${installed} has drifted from the DEPLOYED ${deployedCopy} — the engine is running a ` +
        `role definition that matches neither checkout`,
    );
    t.diagnostic(
      `DEPLOY OBLIGATION: agents/researcher.md in this worktree is ahead of both ${installed} ` +
        `and ${deployedCopy}. Merging is not enough — AGENTS_DIR wins over the repo fallback, so ` +
        `the deploy phase must also refresh ${installed} from the merged file before the detached ` +
        `executor restart, or the engine keeps loading the old mission.`,
    );
  });

  test("readRoleFile returns null for a role with no definition anywhere", () => {
    assert.equal(readRoleFile("no-such-role" as TaskRole), null);
  });
});

/**
 * T14 — parseRoleFile must not lose the tool allowlist to an invisible byte.
 *
 * This is a SECURITY test, not a parsing nicety. `tools: null` is not "no
 * tools"; cc-runner.ts:285-288 reads it as "fall back to CC_ALLOWED_TOOLS",
 * which includes Write, Edit, MultiEdit, Task and Skill. agents/reviewer.md
 * deliberately omits Write/Edit so a reviewer can only report findings, never
 * silently fix the diff it is judging. Before R308 a UTF-8 BOM or CRLF line
 * endings — either of which an editor can introduce with no visible change —
 * made the frontmatter regex miss, handed the reviewer the full toolset, and
 * pasted the raw frontmatter into its mission. Cached for the process's life.
 *
 * Every case below mutates the REAL agents/reviewer.md bytes rather than a
 * fixture string, so the test cannot drift away from the file it protects.
 */
describe("T14 parseRoleFile robustness — BOM, CRLF, malformed header", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const reviewerRaw = readFileSync(`${repoRoot}agents/reviewer.md`, "utf8");
  const REVIEWER_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

  test("the premise: agents/reviewer.md grants no write tool at all", () => {
    const cfg = parseRoleFile(reviewerRaw);
    assert.deepEqual(cfg.tools, REVIEWER_TOOLS);
    for (const forbidden of ["Write", "Edit", "MultiEdit", "Task", "Skill"]) {
      assert.ok(
        !cfg.tools?.includes(forbidden),
        `agents/reviewer.md must not grant ${forbidden} — if this fails, the rest of ` +
          `T14 is guarding a property the file no longer has`,
      );
    }
  });

  test("a UTF-8 BOM does not change the parse", () => {
    const cfg = parseRoleFile(`﻿${reviewerRaw}`);
    assert.deepEqual(cfg.tools, REVIEWER_TOOLS, "BOM must not collapse tools to null");
    assert.equal(cfg.model, parseRoleFile(reviewerRaw).model);
    assert.ok(!cfg.mission.startsWith("---"), "frontmatter must still be stripped");
    assert.ok(!cfg.mission.startsWith("﻿"), "BOM must not survive into the mission body");
  });

  test("CRLF line endings do not change the parse", () => {
    const crlf = reviewerRaw.replace(/\n/g, "\r\n");
    const cfg = parseRoleFile(crlf);
    assert.deepEqual(cfg.tools, REVIEWER_TOOLS, "CRLF must not collapse tools to null");
    assert.equal(
      cfg.model,
      parseRoleFile(reviewerRaw).model,
      "a trailing \\r must not leak into model: and get rejected by sanitizeModel",
    );
    assert.equal(cfg.effort, parseRoleFile(reviewerRaw).effort);
    assert.ok(!cfg.mission.startsWith("---"), "frontmatter must still be stripped");
  });

  test("BOM + CRLF together — the realistic Windows-editor round-trip", () => {
    const cfg = parseRoleFile(`﻿${reviewerRaw.replace(/\n/g, "\r\n")}`);
    assert.deepEqual(cfg.tools, REVIEWER_TOOLS);
  });

  test("no tool name carries stray whitespace after a CRLF round-trip", () => {
    const cfg = parseRoleFile(reviewerRaw.replace(/\n/g, "\r\n"));
    // Asserted before the loop, or a tools:null regression makes this test
    // pass vacuously on an empty iteration — which is what it did against the
    // pre-R308 parser when the whole point was that tools went null.
    assert.ok(cfg.tools, "tools must not be null — a null here fails open to CC_ALLOWED_TOOLS");
    assert.equal(cfg.tools.length, REVIEWER_TOOLS.length);
    for (const t of cfg.tools) {
      assert.equal(t, t.trim(), `tool "${JSON.stringify(t)}" carries stray whitespace`);
      assert.ok(!/[\r\n]/.test(t), `tool ${JSON.stringify(t)} contains a line break`);
    }
  });

  test("an unclosed frontmatter block THROWS instead of degrading to tools:null", () => {
    // The closing '---' deleted: the header opens and never closes. Silently
    // returning tools:null here is exactly the privilege escalation.
    const truncated = reviewerRaw.split("\n---\n")[0] + "\n";
    assert.throws(
      () => parseRoleFile(truncated),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.equal((err as Error).name, "RoleFileParseError");
        assert.match((err as Error).message, /never closed/);
        return true;
      },
      "an unparseable header is a misconfiguration, like the unreadable file readRoleFile throws on",
    );
  });

  test("a header opened with CRLF and never closed also throws", () => {
    const truncated = (reviewerRaw.split("\n---\n")[0] + "\n").replace(/\n/g, "\r\n");
    assert.throws(() => parseRoleFile(truncated), { name: "RoleFileParseError" });
  });

  test("no frontmatter at all is still legal and still yields tools:null", () => {
    // The negative control that keeps the throw narrow: only a file that
    // CLAIMS frontmatter and fails to close it is an error. A plain mission
    // file is a valid definition with no allowlist of its own.
    const cfg = parseRoleFile("You are the reviewer.\n\nFind what is wrong.\n");
    assert.equal(cfg.tools, null);
    assert.equal(cfg.mission, "You are the reviewer.\n\nFind what is wrong.");
  });

  test("a BOM in front of a plain mission file does not make it look like frontmatter", () => {
    const cfg = parseRoleFile("﻿You are the reviewer.");
    assert.equal(cfg.tools, null);
    assert.equal(cfg.mission, "You are the reviewer.");
  });

  test("every committed agents/*.md still parses — no role file regresses", () => {
    for (const role of ["architect", "planner", "builder", "reviewer", "scout", "researcher"]) {
      const raw = readFileSync(`${REPO_AGENTS_DIR}/${role}.md`, "utf8");
      const cfg = parseRoleFile(raw);
      assert.ok(cfg.tools && cfg.tools.length > 0, `${role}.md must declare a tools allowlist`);
      assert.ok(cfg.mission.length > 0, `${role}.md must have a mission body`);
      assert.ok(!cfg.mission.startsWith("---"), `${role}.md frontmatter must be stripped`);
    }
  });
});

/**
 * T16 — the researcher's browser lane (R703).
 *
 * The researcher prompt used to say only "use every research surface you have",
 * which in practice meant WebFetch: an agent does not discover three CLIs by
 * hoping. RESEARCH_INSTRUMENTS names them, states the research-doc citation
 * rule and the login-wall protocol. The on-disk screenshot DIRECTORY itself
 * moved to SCREENSHOT_CONVENTION at round 900, delivered through withPolicy()
 * to every browser-driving role rather than owned by this block alone.
 *
 * The interesting half of this suite is the anti-drift half. A prompt that
 * quotes invented invocations is worse than one that quotes none, so every
 * instrument named here is executed with `--help` and the quoted subcommands
 * and flags must appear in its SHIPPED output. Rounds 701/702 own those
 * scripts; if they rename a subcommand, this test — not a confused researcher
 * at 3am — is what notices.
 */
describe("T16 researcher browser lane", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const SCRIPTS = {
    browser: "scripts/research-browser.mjs",
    perplexity: "scripts/perplexity.mjs",
    geminiQa: "scripts/gemini-qa.mjs",
  } as const;

  /** The shipped `--help` of a script, as the researcher would see it. */
  function help(rel: string): string {
    return execFileSync(process.execPath, [`${repoRoot}${rel}`, "--help"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  test("researcher prompt carries RESEARCH_INSTRUMENTS; no other role does", () => {
    for (const repo of ["ai-os", "scratch"] as const) {
      const proj = project({ repo });
      const researcherPrompt = buildPrompt(task({ role: "researcher" }), proj);
      assert.ok(
        researcherPrompt.includes(RESEARCH_INSTRUMENTS),
        `researcher prompt on repo '${repo}' missing RESEARCH_INSTRUMENTS`,
      );
      for (const role of ROLES.filter((r) => r !== "researcher")) {
        const prompt = buildPrompt(task({ role }), proj);
        assert.ok(
          !prompt.includes(RESEARCH_INSTRUMENTS),
          `role ${role} on repo '${repo}' must not carry RESEARCH_INSTRUMENTS — it is prepended ` +
            `to every run of its role and belongs only to the researcher`,
        );
      }
    }
  });

  test("all three instruments are named with a runnable path", () => {
    const prompt = buildPrompt(task({ role: "researcher" }), project({ repo: "ai-os" }));
    for (const rel of Object.values(SCRIPTS)) {
      assert.ok(prompt.includes(rel), `researcher prompt does not name ${rel}`);
      assert.ok(
        existsSync(`${repoRoot}${rel}`),
        `${rel} is named in the researcher prompt but does not exist in this checkout`,
      );
    }
    assert.ok(
      RESEARCH_INSTRUMENTS.includes("/opt/forge-ai-os/scripts/"),
      "the prompt must say where the instruments live outside an ai-os worktree",
    );
  });

  test("screenshot convention: uploads path, FORGE_RUN_ID, and the servable URL form", () => {
    // Round 900: the on-disk DIRECTORY moved out of RESEARCH_INSTRUMENTS and
    // into SCREENSHOT_CONVENTION, delivered to the researcher (and every other
    // browser-driving role) through withPolicy() rather than hand-pasted here —
    // so the directory claim is checked against the BUILT prompt, which is what
    // a researcher actually receives, not against RESEARCH_INSTRUMENTS alone.
    const researcherPrompt = buildPrompt(task({ role: "researcher" }), project({ repo: "ai-os" }));
    assert.ok(
      SCREENSHOT_CONVENTION.includes("/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png"),
      "the on-disk screenshot convention must be stated literally",
    );
    assert.ok(
      researcherPrompt.includes(SCREENSHOT_CONVENTION),
      "the researcher's built prompt does not carry SCREENSHOT_CONVENTION — withPolicy() attaches it " +
        "wherever RESEARCH_INSTRUMENTS is, and the researcher's body always carries RESEARCH_INSTRUMENTS",
    );
    assert.ok(
      RESEARCH_INSTRUMENTS.includes("/api/uploads/$FORGE_RUN_ID/<name>"),
      "the URL form is what the Console renders — a bare path is invisible to every reader",
    );
    // The tools' own contract, quoted from the shipped help rather than trusted.
    const browserHelp = help(SCRIPTS.browser);
    assert.ok(
      browserHelp.includes("/opt/ai-os/uploads/<run_id>/"),
      "research-browser --help no longer documents the uploads directory the prompt promises",
    );
    assert.ok(
      browserHelp.includes("FORGE_RUN_ID"),
      "research-browser --help no longer resolves its run id from FORGE_RUN_ID",
    );
    assert.ok(
      browserHelp.includes("/api/uploads/"),
      "research-browser --help no longer documents the servable URL form",
    );
  });

  test("login-wall protocol: stop, report, never a credential", () => {
    assert.match(
      RESEARCH_INSTRUMENTS,
      /LOGIN WALL = STOP/,
      "the login-wall rule must be unmissable, not a clause in a paragraph",
    );
    assert.match(
      RESEARCH_INSTRUMENTS,
      /NEVER attempt credentials/,
      "the prompt must forbid attempting credentials in as many words",
    );
    assert.ok(
      RESEARCH_INSTRUMENTS.includes("noVNC"),
      "the prompt must say how Konrad resolves the wall, or 'stop' reads as 'give up'",
    );
    // Exit 4 means "needs Konrad" in both browser-facing tools — the claim the
    // prompt makes on their behalf.
    assert.ok(
      help(SCRIPTS.browser).includes("4  LOGIN REQUIRED"),
      "research-browser exit 4 is no longer LOGIN REQUIRED",
    );
    assert.ok(
      help(SCRIPTS.perplexity).includes("4  NEEDS LOGIN"),
      "perplexity exit 4 is no longer NEEDS LOGIN",
    );
  });

  test("anti-drift: every invocation the prompt quotes exists in the shipped --help", () => {
    const quoted: Array<[string, string[]]> = [
      [
        SCRIPTS.browser,
        ["open <profile>", "status <profile>", "close <profile>", "--url", "--label", "--probe"],
      ],
      [
        SCRIPTS.perplexity,
        ['ask "<question>"', 'search "<query>"', "--backend browser|api", "--allow-uncited", "PERPLEXITY_API_KEY"],
      ],
      [SCRIPTS.geminiQa, ["--backend pool|api", "GEMINI_API_KEY", "gemini-omni-flash"]],
    ];
    for (const [rel, tokens] of quoted) {
      const text = help(rel);
      for (const token of tokens) {
        assert.ok(
          text.includes(token),
          `${rel} --help no longer contains ${JSON.stringify(token)}, which the researcher role ` +
            `file and/or RESEARCH_INSTRUMENTS quote as a real invocation`,
        );
      }
    }
  });

  test("each instrument's key requirement is stated as it actually is", () => {
    // R702 could say "none of them needs a key by default". R776 re-ranked perplexity's backends
    // — api is now its default for both modes — so that blanket sentence became a lie, and a
    // researcher told "no keys needed" would read perplexity's exit 2 as a broken tool rather
    // than a missing key. The prompt must draw the line where it really falls.
    assert.match(
      RESEARCH_INSTRUMENTS,
      /research-browser and gemini-qa need no key on their default path, perplexity does/,
      "the prompt must say which instruments are key-free and which is not",
    );
    // gemini-qa's default backend really is the free pool.
    assert.ok(
      help(SCRIPTS.geminiQa).includes("default: pool"),
      "gemini-qa's default backend is no longer the pool",
    );
    // perplexity's ask really does default to the api backend.
    assert.match(
      help(SCRIPTS.perplexity),
      /Default backend: api/,
      "perplexity ask no longer defaults to the api backend",
    );
    // ...and the browser backend it demoted is still offered, not deleted.
    assert.match(
      help(SCRIPTS.perplexity),
      /--backend browser\|api/,
      "perplexity --help no longer offers the browser fallback the prompt points researchers at",
    );
    assert.match(
      RESEARCH_INSTRUMENTS,
      /--backend browser/,
      "the prompt must still name the fallback for logged-in work",
    );
  });
});

/**
 * T18 — the escalation protocol reaches every role (R870).
 *
 * Konrad set the fleet-wide autonomy rule on 2026-08-05: autonomous by default,
 * escalate on exactly two things (irreversible/boundary-crossing actions, and
 * preference decisions on build-once-use-many work). A policy that reaches six
 * of eight roles is not a fleet-wide policy, so the interesting assertion is the
 * exhaustive one: ESCALATION_POLICY must appear in the prompt of EVERY member of
 * TaskRole, on a repo-backed project and on a scratch one alike.
 *
 * ROLES above deliberately lists only the roles with a prompt branch of their
 * own. This suite uses ALL_TASK_ROLES instead — built through a
 * `satisfies Record<TaskRole, true>` so that adding a role to the union is a
 * COMPILE error here, not a silently unchecked role at 3am.
 */
const ALL_TASK_ROLES = Object.keys({
  architect: true,
  planner: true,
  scout: true,
  researcher: true,
  builder: true,
  reviewer: true,
  steward: true,
  tester: true,
} satisfies Record<TaskRole, true>) as TaskRole[];

describe("T18 escalation protocol", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const POLICY_DOC = "docs/plan/10-policy-agent-autonomy-and-escalation.md";
  const VAULT_DOC = "/opt/obsidian-vault/AI OS/Policy - Agent Autonomy and Escalation.md";

  test("the premise: ALL_TASK_ROLES really is every role, including the branchless ones", () => {
    // steward has no branch in buildPrompt and falls through to the bare
    // header — exactly the kind of role a hand-maintained list forgets.
    assert.equal(ALL_TASK_ROLES.length, 8);
    for (const role of ROLES) {
      assert.ok(ALL_TASK_ROLES.includes(role), `ALL_TASK_ROLES is missing ${role}`);
    }
    assert.ok(ALL_TASK_ROLES.includes("steward"), "steward has no prompt branch — it is the point");
  });

  test("every role on every repo carries ESCALATION_POLICY", () => {
    for (const repo of ["ai-os", "content-forge", "scratch"] as const) {
      const proj = project({ repo });
      for (const role of ALL_TASK_ROLES) {
        const prompt = buildPrompt(task({ role }), proj);
        assert.ok(
          prompt.includes(ESCALATION_POLICY),
          `role ${role} on repo '${repo}' is missing ESCALATION_POLICY`,
        );
      }
    }
  });

  test("scratch projects get the escalation policy even though they get no worktree policy", () => {
    // The wrapper gates WORKTREE_POLICY on a live checkout. Reusing that gate
    // for R870 would have been the easy mistake: a scratch project can still
    // spend real money, mail someone as Konrad, or burn his attention on a
    // question a browser would have answered.
    const proj = project({ repo: "scratch" });
    for (const role of ALL_TASK_ROLES) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(prompt.includes(ESCALATION_POLICY), `scratch ${role} lost ESCALATION_POLICY`);
      assert.ok(
        !prompt.includes(WORKTREE_POLICY("/opt/forge-ai-os")),
        `scratch ${role} gained a worktree policy it has no checkout for`,
      );
    }
  });

  test("all four clauses of the policy survive into the rendered prompt", () => {
    // Asserted through a real prompt, not against the constant, so a future
    // wrapper change that drops or truncates the block fails here too.
    const prompt = buildPrompt(task({ role: "builder" }), project({ repo: "ai-os" }));
    // 1) autonomy by default, with a browser named as the way to resolve unknowns.
    assert.match(prompt, /AUTONOMY IS THE DEFAULT/);
    assert.match(
      prompt,
      /NEVER ask Konrad something research would have answered/,
      "the failure mode has to be named, or 'be autonomous' reads as encouragement",
    );
    assert.ok(
      ESCALATION_POLICY.includes("scripts/research-browser.mjs"),
      "clause 1 must name a browser that actually exists on this host",
    );
    assert.ok(
      existsSync(`${repoRoot}scripts/research-browser.mjs`),
      "ESCALATION_POLICY names scripts/research-browser.mjs but it is not in this checkout",
    );
    // The vault note says "playwright / auto-browser"; auto-browser's controller
    // is not installed here (docs/tools/research-browser.md §2.1), so the
    // condensed policy must not send agents at it.
    assert.ok(
      ESCALATION_POLICY.includes("playwright-skill"),
      "clause 1 must name the skill-based browser path for roles holding Skill",
    );
    assert.ok(
      !ESCALATION_POLICY.includes("auto-browser"),
      "auto-browser does not work on this host — naming it would send agents at a dead end",
    );
    // 2) irreversible / boundary-crossing actions, each trigger Konrad named.
    for (const trigger of [
      "SSH keys",
      "deleting accounts",
      "force-pushing over shared history",
      "outbound communication as Konrad",
      "spending real money",
      "business system in production",
      "third party",
    ]) {
      assert.ok(prompt.includes(trigger), `clause 2 is missing the trigger "${trigger}"`);
    }
    assert.match(
      ESCALATION_POLICY,
      /ESCALATE BEFORE an irreversible or boundary-crossing action/,
      "clause 2 must be BEFORE-worded — asking afterwards is a report, not an escalation",
    );
    // 3) preference/design decisions on build-once-use-many work.
    assert.match(prompt, /build-once-use-many/);
    for (const kind of ["interaction models", "schemas", "naming conventions", "workflow shapes"]) {
      assert.ok(prompt.includes(kind), `clause 3 is missing the decision kind "${kind}"`);
    }
    assert.match(
      prompt,
      /Restate the model in 2-3 sentences/,
      "clause 3 must specify the SHAPE of the ask, not just that one is owed",
    );
    assert.match(
      prompt,
      /state the default you will take if he does not answer/,
      "an ask with no stated default blocks the task on a reply",
    );
    // 4) the mechanism.
    assert.ok(
      prompt.includes("http://127.0.0.1:7700/api/reminders"),
      "clause 4 must give the real endpoint",
    );
    assert.match(prompt, /"when":"in 1m"/, "clause 4 must give a `when` the API accepts");
    assert.match(
      prompt,
      /Max 500 chars per reminder/,
      "the 500-char cap is a hard 400 from the API — an agent that does not know it loses the ask",
    );
    assert.match(
      prompt,
      /KEEP WORKING on everything that does not depend on the answer/,
      "without this an escalation becomes an early exit",
    );
  });

  test("the policy doc is committed for agents without vault access, verbatim", (t) => {
    const committed = readFileSync(`${repoRoot}${POLICY_DOC}`, "utf8");
    assert.ok(committed.length > 0, `${POLICY_DOC} is empty`);
    assert.ok(
      ESCALATION_POLICY.includes(POLICY_DOC),
      "the prompt must point at the committed copy, or the full policy is unreachable from a run",
    );
    // The condensed prompt and the doc must agree on the two escalation
    // categories; the doc is the authority the prompt defers to.
    assert.match(committed, /irreversible or boundary-crossing actions/);
    assert.match(committed, /preference and design decisions on load-bearing work/);
    assert.ok(
      committed.includes("http://127.0.0.1:7700/api/reminders"),
      "the doc must carry the same mechanism the prompt does",
    );

    // Verbatim against the vault original where the vault is readable. A run
    // inside a container without the vault mount says so out loud rather than
    // passing quietly on an unchecked claim.
    if (!existsSync(VAULT_DOC)) {
      t.diagnostic(`${VAULT_DOC} not readable here — verbatim-ness unchecked this run`);
      return;
    }
    assert.equal(
      committed,
      readFileSync(VAULT_DOC, "utf8"),
      `${POLICY_DOC} has drifted from the vault note it copies — it is meant to be verbatim`,
    );
  });

  test("BROWSER_FIRST reaches scout, builder and tester; the researcher has its own instrument block", () => {
    // Scope is the contract, exactly as for RESEARCH_INSTRUMENTS: these are the
    // roles that meet unknowns while working. A reviewer or planner that grew
    // the block would be prompt bloat with no matching behaviour.
    //
    // THE TESTER JOINED IN ROUND 242 (finding F-E), and it is a widening of the
    // scope this case asserts, so it is stated here rather than left to the
    // membership list below. Its own branch sends it at "the real surface
    // (browser, CLI, API)" — it was the one role that drives a browser on
    // instruction while carrying neither constant, which meant B4's run-control
    // rules reached it only if a brief pasted them by hand.
    const proj = project({ repo: "ai-os" });
    for (const role of ["scout", "builder", "tester"] as const) {
      assert.ok(
        buildPrompt(task({ role }), proj).includes(BROWSER_FIRST),
        `role ${role} is missing BROWSER_FIRST`,
      );
    }
    for (const role of ALL_TASK_ROLES.filter((r) => r !== "scout" && r !== "builder" && r !== "tester")) {
      assert.ok(
        !buildPrompt(task({ role }), proj).includes(BROWSER_FIRST),
        `role ${role} carries BROWSER_FIRST — it belongs to the roles that meet unknowns hands-on`,
      );
    }
    // The researcher's equivalent is the fuller RESEARCH_INSTRUMENTS block plus
    // an explicit first-resort clause in its own branch.
    const researcherPrompt = buildPrompt(task({ role: "researcher" }), proj);
    assert.ok(researcherPrompt.includes(RESEARCH_INSTRUMENTS));
    assert.match(
      researcherPrompt,
      /is the FIRST resort, not the last/,
      "the researcher must be told the browser is a first move, not a last-ditch one",
    );
  });

  test("BROWSER_FIRST quotes a real invocation and forbids credential attempts", () => {
    assert.ok(
      BROWSER_FIRST.includes("scripts/research-browser.mjs open scratch --url"),
      "an unrunnable example is worse than none",
    );
    const help = execFileSync(
      process.execPath,
      [`${repoRoot}scripts/research-browser.mjs`, "--help"],
      { encoding: "utf8", timeout: 30_000 },
    );
    for (const token of ["open <profile>", "--url", "--label", "scratch"]) {
      assert.ok(
        help.includes(token),
        `research-browser --help no longer contains ${JSON.stringify(token)}, quoted by BROWSER_FIRST`,
      );
    }
    assert.match(
      BROWSER_FIRST,
      /never attempt credentials/i,
      "the login-wall boundary applies to every role that can open a browser",
    );
  });

  test("the committed scout and builder role files name the browser too", () => {
    // The engine's prompt is only half the surface: agents/*.md is what the
    // interactive Task-tool subagents read, where no buildPrompt runs at all.
    for (const role of ["scout", "builder"] as const) {
      const mission = parseRoleFile(readFileSync(`${REPO_AGENTS_DIR}/${role}.md`, "utf8")).mission;
      assert.ok(
        mission.includes("scripts/research-browser.mjs"),
        `agents/${role}.md does not name the browser as a way to resolve unknowns`,
      );
    }
  });
});

/* ========================================================================== *
 * T19 consolidation is preconditioned on the gating runs still being settled
 *
 * SOURCE-ASSERTION, like executor-completion-guard.test.ts and for the same
 * reason: project-tick.ts and db/projects.ts both reach a pg Pool, and there is
 * no test database in this suite. The DECISION half of consolidation is pure
 * and table-tested in project-reconcile.test.ts; what is asserted here is the
 * SQL and the control flow that apply it.
 *
 * The defect (R905 red-team S4): `listVerdictRound` reads the round, then
 * several DB round trips later the decision is applied. In that window the
 * control plane can requeue a settled reviewer — `POST /api/runs/:id/message`
 * against a `completed` target appends and flips it to `queued` in ONE
 * statement — so the run owes another turn whose verdict may contradict the
 * snapshot. Mark-done was unconditional, and a 'done' task is invisible to
 * listSettledRunningTasks() forever: the flip was honoured zero times, in
 * silence. That is the one outcome this module exists to prevent.
 * ========================================================================== */

describe("T19 consolidation precondition (red-team S4)", () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const TICK = readFileSync(`${repoRoot}forge-control/src/lib/project-tick.ts`, "utf8");
  const PROJECTS_DB = readFileSync(`${repoRoot}forge-control/src/db/projects.ts`, "utf8");

  test("markVerdictTaskDone carries the settlement predicate into the UPDATE", () => {
    const body = PROJECTS_DB.slice(
      PROJECTS_DB.indexOf("export async function markVerdictTaskDone"),
      PROJECTS_DB.indexOf("/**", PROJECTS_DB.indexOf("export async function markVerdictTaskDone")),
    );
    assert.ok(body.length > 0, "markVerdictTaskDone not found in db/projects.ts");
    assert.match(body, /UPDATE project_tasks pt/);
    assert.match(body, /WHERE r\.id = pt\.run_id/);
    assert.match(body, /AND r\.status = 'completed'/);
    // R1005: the SQL mirror of verdictMemberSettled. 'done' re-confirms itself
    // (finding 2), and a `completed` run that still owes an undelivered turn
    // does NOT count as settled (finding 1).
    assert.match(body, /AND \(pt\.status = 'done'/);
    assert.match(body, /AND \(r\.metadata->>'pending_input'\) IS DISTINCT FROM 'true'/);
    // The caller has to be able to tell "did not move" from "moved".
    assert.match(body, /return \(r\.rowCount \?\? 0\) > 0;/);
  });

  test("unsettledVerdictTasks counts a run-less task as unsettled", () => {
    const body = PROJECTS_DB.slice(
      PROJECTS_DB.indexOf("export async function unsettledVerdictTasks"),
      PROJECTS_DB.indexOf("export async function unsettledVerdictTasks") + 1200,
    );
    // LEFT JOIN + IS DISTINCT FROM, not `<>`: a NULL run_status must count as
    // unsettled, and `NULL <> 'completed'` is NULL, i.e. not matched.
    assert.match(body, /LEFT JOIN runs r ON r\.id = pt\.run_id/);
    assert.match(body, /r\.status IS DISTINCT FROM 'completed'/);
    // ...and the exact complement of the mark-done predicate above, or the
    // pre-check and the commit disagree about which member is settled.
    assert.match(body, /AND pt\.status IS DISTINCT FROM 'done'/);
    assert.match(body, /OR r\.metadata->>'pending_input' = 'true'/);
  });

  test("markGroupDone reports refusals instead of swallowing them", () => {
    const body = TICK.slice(
      TICK.indexOf("async function markGroupDone("),
      TICK.indexOf("function logGroupNotReleased("),
    );
    assert.ok(body.length > 0, "markGroupDone not found");
    assert.match(body, /markVerdictTaskDone\(r\.taskId\)/);
    assert.match(body, /refused\.push\(r\)/);
    assert.doesNotMatch(body, /setTaskStatus\(/);
  });

  test("the pass branch aborts before any side effect when a member refuses", () => {
    const branch = TICK.slice(
      TICK.indexOf('case "pass": {'),
      TICK.indexOf('case "block": {'),
    );
    // Mark-done first, and the early return must precede the notifications —
    // a PASS is the decision with no undo: it releases the next phase.
    const refusalReturn = branch.indexOf("logGroupNotReleased");
    assert.ok(refusalReturn > 0, "pass branch does not handle a refusal");
    assert.ok(
      refusalReturn < branch.indexOf("queueNotification"),
      "the refusal check must come before the round's notifications",
    );
    assert.ok(
      refusalReturn < branch.indexOf("roundIsComplete"),
      "the refusal check must come before the round-complete push",
    );
  });

  test("the irreversible branches pre-check before their side effect", () => {
    const block = TICK.slice(
      TICK.indexOf('case "block": {'),
      TICK.indexOf('case "fix": {'),
    );
    // Blocking a project and pushing to Konrad's phone cannot be undone by a
    // later refusal, so the window is closed from the front too.
    assert.ok(
      block.indexOf("unsettledVerdictTasks") < block.indexOf("setProjectStatus"),
      "block must pre-check before it blocks the project",
    );

    const fix = TICK.slice(TICK.indexOf('case "fix": {'));
    assert.ok(
      fix.indexOf("unsettledVerdictTasks") < fix.indexOf("await createFixChain("),
      "fix must pre-check before it inserts the chain",
    );
    // ...and the conditional mark-done is still the backstop for the
    // milliseconds a pre-check cannot cover: a refusal after the chain exists
    // must stop the round closing and must not announce the fix cycle.
    const afterChain = fix.slice(fix.indexOf("const refused = await markGroupDone(inputs);"));
    assert.ok(afterChain.length > 0, "fix branch does not check markGroupDone's result");
    assert.ok(
      afterChain.indexOf("return;") < afterChain.indexOf("queueNotification"),
      "a refused fix round must not push a fix-cycle announcement",
    );
  });

  test("no branch marks a gating task done unconditionally any more", () => {
    const consolidate = TICK.slice(
      TICK.indexOf("async function consolidateVerdictGroup("),
      TICK.indexOf("async function markGroupDone("),
    );
    assert.doesNotMatch(
      consolidate,
      /setTaskStatus\([^)]*"done"\)/,
      "consolidation must route every mark-done through the preconditioned helper",
    );
    // Every markGroupDone call site captures the result; a bare `await
    // markGroupDone(inputs);` would be the old, silent behaviour wearing the
    // new helper's name.
    const bare = consolidate.match(/^\s*await markGroupDone\(inputs\);\s*$/gm) ?? [];
    assert.deepEqual(bare, [], "markGroupDone's return value must never be discarded");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * PHASE 4C (round 222) — the spawn path per workstream, the reviewer's diff
 * base, R17's warn, and the project that must not close on an unmerged branch.
 *
 * Requirements: R36, R37, R17 (warn clause), R70, and the operator's ruling of
 * round 222 (at most one running task per (project, workstream)).
 *
 * APPENDED ONLY. Nothing above this line was modified — `git diff main --
 * forge-control/src/lib/project-tick.test.ts` is one hunk at EOF.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ─────────────────
 *
 * (a) "The 'main' path looks byte-identical because the test computes the
 *     expected string with the same changed code." That is the failure mode
 *     this file is most exposed to, and it is closed by PRIOR_TICK below: the
 *     expected bytes are read out of git at commit 4244b20 — the tree as it
 *     stood BEFORE this phase — and the substitution into them is mechanical
 *     and visible. A test that built its expectation by calling buildPrompt()
 *     with different arguments would prove only that the new code agrees with
 *     itself.
 * (b) "The R70 tests pass because the fixture has no non-main workstream at
 *     all." Every R70 case below states the workstreams its fixture contains,
 *     and `closeGate.selfCheck` asserts the fixture actually holds a non-main
 *     row before the case is allowed to assert anything about it — a case whose
 *     premise evaporated fails instead of passing vacuously.
 * ══════════════════════════════════════════════════════════════════════════ */

import {
  buildPrompt as buildPromptPhase4C,
  emptyWriteSetWarning,
  unintegratedWorkstreams,
  partitionByWorkstream,
  busyWorkstreams,
  workstreamKey,
  type CloseGateTask,
} from "./project-tick.ts";
import { fileURLToPath } from "node:url";
import { WORKSTREAM_MAIN } from "./workspace.ts";
import { MAIN_WORKSTREAM } from "./project-reconcile.ts";

/** The tree as it stood BEFORE phase 4C — round 221's last commit, phase 4B.
 *  Pinned by SHA rather than by `main` or `HEAD~1`, both of which move. This is
 *  the standing rule about line numbers applied to bytes: an expectation taken
 *  from history carries the commit it was taken from. */
const PRIOR_SHA = "4244b20225ec85c2d5dde907d0430d3ff1febce5";

const PRIOR_TICK = (() => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const out = execFileSync(
    "git",
    ["show", `${PRIOR_SHA}:forge-control/src/lib/project-tick.ts`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  assert.ok(
    out.length > 10_000,
    `git show ${PRIOR_SHA.slice(0, 7)} returned ${out.length} bytes — the pin does not resolve ` +
      "to the pre-phase-4C project-tick.ts and every byte-identity claim below would be vacuous",
  );
  return out;
})();

/** Pull ONE template literal line out of the prior source and render it with
 *  the fixture's values. Mechanical substitution, no evaluation: what comes back
 *  is what the OLD code emitted for these inputs.
 *
 *  Both ends are checked. An unmatched anchor would make `line` empty and every
 *  `includes()` below trivially true — the self-certifying shape standing rule 3
 *  exists to forbid. */
function priorLine(anchor: string, subs: Record<string, string>): string {
  const idx = PRIOR_TICK.indexOf(anchor);
  assert.ok(idx > 0, `anchor ${JSON.stringify(anchor)} not found at ${PRIOR_SHA.slice(0, 7)}`);
  const start = PRIOR_TICK.lastIndexOf("`", idx);
  const end = PRIOR_TICK.indexOf("`", idx);
  assert.ok(start > 0 && end > idx, `could not delimit the template around ${JSON.stringify(anchor)}`);
  let line = PRIOR_TICK.slice(start + 1, end);
  for (const [expr, value] of Object.entries(subs)) {
    assert.ok(line.includes(expr), `prior template no longer interpolates ${expr}: ${line}`);
    line = line.split(expr).join(value);
  }
  assert.doesNotMatch(line, /\$\{/, `unsubstituted interpolation left in: ${line}`);
  return line.replace(/\\n/g, "\n");
}

describe("R36/R37 the `main` workstream is byte-identical to the tree before phase 4C", () => {
  const proj = project({ repo: "ai-os", work_branch: "project/8c591d6c", base_branch: "main" });

  test("the worktree header line is the one commit 4244b20 emitted", () => {
    const expected = priorLine("you are already inside its worktree", {
      "${project.repo}": proj.repo,
      "${project.work_branch}": proj.work_branch!,
      "${project.base_branch}": proj.base_branch,
    });
    for (const role of ROLES) {
      const prompt = buildPromptPhase4C(task({ role }), proj);
      assert.ok(
        prompt.includes(expected),
        `role ${role}: header line diverged from ${PRIOR_SHA.slice(0, 7)}\n` +
          `expected substring: ${JSON.stringify(expected)}`,
      );
    }
  });

  test("the reviewer's diff base is still ${project.base_branch}...HEAD", () => {
    const expected = priorLine("Review the actual diff", {
      "${project.base_branch}": proj.base_branch,
    });
    const prompt = buildPromptPhase4C(task({ role: "reviewer" }), proj);
    assert.ok(prompt.includes(expected), `reviewer diff base diverged: ${JSON.stringify(expected)}`);
    assert.ok(prompt.includes("git diff main...HEAD"), "the literal form R37 must preserve");
    assert.ok(
      !prompt.includes("merge-base"),
      "a `main` reviewer must never be handed the workstream fork-point form",
    );
  });

  test("the builder is still told the project's own branch", () => {
    const expected = priorLine("is already checked out", {
      "${project.work_branch}": proj.work_branch!,
    });
    const prompt = buildPromptPhase4C(task({ role: "builder" }), proj);
    assert.ok(prompt.includes(expected), `builder branch line diverged: ${JSON.stringify(expected)}`);
  });

  test("passing the resolved workspace explicitly changes nothing for `main`", () => {
    // The spawn path always passes it; every test above omits it. If the two
    // paths could differ, half this file would be proving the wrong thing.
    for (const role of ROLES) {
      const implicit = buildPromptPhase4C(task({ role }), proj);
      const explicit = buildPromptPhase4C(task({ role }), proj, {
        workstream: "main",
        work_branch: proj.work_branch,
      });
      assert.equal(explicit, implicit, `role ${role}: explicit 'main' workspace changed the prompt`);
    }
  });

  test("R37 — WORKTREE_POLICY and REVIEWER_LIVE_CHECK are unchanged in wording", () => {
    // R37 says the policy needs no rewording because "the directory you are
    // already in" now correctly describes a per-workstream worktree. Asserted
    // against the prior bytes rather than trusted: this is the one requirement
    // in this phase whose deliverable is that a string did NOT change.
    for (const name of ["WORKTREE_POLICY", "REVIEWER_LIVE_CHECK"]) {
      const marker = `export function ${name}(liveCheckout: string): string {`;
      const cut = (src: string): string => {
        const s = src.indexOf(marker);
        assert.ok(s > 0, `${name} not found — this test has gone stale`);
        const e = src.indexOf("\n}\n", s);
        assert.ok(e > s, `${name} body not delimited`);
        return src.slice(s, e);
      };
      assert.equal(
        cut(readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8")),
        cut(PRIOR_TICK),
        `${name} was reworded — R37 says it must not be`,
      );
    }
  });
});

describe("R37 the reviewer's diff base inside a workstream worktree", () => {
  const proj = project({ repo: "ai-os", work_branch: "project/8c591d6c", base_branch: "main" });
  const uiTask = task({ role: "reviewer", workstream: "ui" });
  const uiWorkspace = { workstream: "ui", work_branch: "project/8c591d6c-ui" };

  test("a non-`main` reviewer diffs against the workstream's fork point", () => {
    const prompt = buildPromptPhase4C(uiTask, proj, uiWorkspace);
    assert.ok(
      prompt.includes("git diff $(git merge-base project/8c591d6c HEAD)...HEAD"),
      "the merge-base form R37 specifies is missing",
    );
    assert.ok(
      !prompt.includes("git diff main...HEAD"),
      "diffing a workstream against base_branch shows every other workstream's merged work",
    );
  });

  test("the header names the workstream's branch, not the project's", () => {
    const prompt = buildPromptPhase4C(task({ role: "builder", workstream: "ui" }), proj, uiWorkspace);
    assert.ok(
      prompt.includes("(branch project/8c591d6c-ui, off project/8c591d6c)"),
      "a worker told the wrong branch pushes the wrong ref",
    );
    assert.ok(
      prompt.includes("branch project/8c591d6c-ui is already checked out"),
      "the builder branch must name the workstream's branch",
    );
    assert.match(prompt, /NEVER merge this branch/, "R38: the worker must not merge itself");
  });

  test("a workstream task with no resolved workspace is REFUSED, not defaulted", () => {
    // The only available default is project.work_branch, which for a workstream
    // row is the wrong branch. NF1: a fallback-for-invalid is forbidden.
    assert.throws(
      () => buildPromptPhase4C(task({ role: "builder", workstream: "ui" }), proj),
      /no resolved TaskWorkspace was passed/,
    );
  });

  test("a workstream on a project with no work_branch is REFUSED", () => {
    assert.throws(
      () =>
        buildPromptPhase4C(
          task({ role: "reviewer", workstream: "ui" }),
          project({ work_branch: null }),
          uiWorkspace,
        ),
      /has no work_branch/,
    );
  });

  test("the two `main` constants cannot drift apart", () => {
    // lib/workspace.ts spells it WORKSTREAM_MAIN, lib/project-reconcile.ts
    // spells it MAIN_WORKSTREAM, and this file's spawn path uses one to call
    // the other's module. Two names for one value is survivable; two VALUES
    // would repoint a live project's worktree.
    assert.equal(MAIN_WORKSTREAM, WORKSTREAM_MAIN);
    assert.equal(MAIN_WORKSTREAM, "main");
  });
});

describe("R36 the spawn path resolves per task and writes back only `main`", () => {
  const TICK4C = readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8");

  function slice(from: string, to: string): string {
    const s = TICK4C.indexOf(from);
    assert.ok(s > 0, `${from} not found — this test has gone stale`);
    const e = TICK4C.indexOf(to, s);
    assert.ok(e > s, `${to} does not follow ${from} — this test has gone stale`);
    return TICK4C.slice(s, e);
  }

  test("setProjectWorkspace is reached from the `main` branch and nowhere else", () => {
    // The single most dangerous line in this phase's diff: writing a
    // workstream's directory into `projects.workspace_dir` would silently
    // repoint every later task, every Kanban link and the deploy's pre-merge
    // check at a branch that is not the project's.
    // `await setProjectWorkspace(` and not `setProjectWorkspace(`: the second
    // form also matches the prose in resolveTaskWorkspace's own comment block,
    // and a gate that counts its own documentation is a gate that fails when
    // someone explains it better.
    const calls = TICK4C.match(/await setProjectWorkspace\(/g) ?? [];
    assert.equal(calls.length, 1, "setProjectWorkspace must be called exactly once in this file");
    const mainBranch = slice(
      "if (task.workstream === MAIN_WORKSTREAM) {",
      "  } else {",
    );
    assert.match(mainBranch, /setProjectWorkspace\(task\.project_id, ws\)/);
    const workstreamBranch = slice("  } else {", "  if (!existsSync(resolved.workspace_dir))");
    assert.doesNotMatch(
      workstreamBranch,
      /setProjectWorkspace/,
      "a workstream must never write the project's workspace_dir",
    );
    assert.match(workstreamBranch, /provisionWorkstream\(task\.project, task\.workstream\)/);
  });

  test("the run's cwd is the resolved workstream directory, not the project's", () => {
    const spawn = slice("async function spawnTaskRuns(", "/** Narrow a DB row's role");
    assert.match(spawn, /const ws = await resolveTaskWorkspace\(task\)/);
    assert.match(spawn, /workspace_dir: ws\.workspace_dir,/);
    assert.doesNotMatch(
      spawn,
      /workspace_dir: task\.project\.workspace_dir/,
      "R36: the run's cwd must come from the task's workstream, not the project row",
    );
  });

  test("executor.ts is not modified by this phase", () => {
    // 04-phases.md §10 lists executor.ts as written by NO phase. It already
    // uses run.metadata.workspace_dir as the child's cwd, which is why a
    // workstream gets its own directory without touching it.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const diff = execFileSync(
      "git",
      ["diff", PRIOR_SHA, "--", "forge-control/src/executor.ts"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(diff, "", `executor.ts changed since ${PRIOR_SHA.slice(0, 7)}:\n${diff}`);
  });

  test("a missing workspace is a named refusal, for `main` and for a workstream alike", () => {
    const resolver = slice("async function resolveTaskWorkspace(", "async function spawnTaskRuns(");
    assert.match(resolver, /if \(!existsSync\(resolved\.workspace_dir\)\)/);
    assert.match(resolver, /refusing to spawn a run whose cwd is missing/);
    // The check is AFTER the if/else, so it covers both branches — a check
    // inside the `main` branch alone would leave the workstream recovery
    // asserted-by-comment, which is what R36's third property forbids.
    assert.ok(
      resolver.indexOf("} else {") < resolver.indexOf("if (!existsSync(resolved.workspace_dir))"),
      "the existence gate must sit after both branches, not inside one",
    );
  });
});

describe("R17 warn clause — an undeclared builder is named at spawn", () => {
  const cases: Array<{ role: TaskRole; write_set: string[]; warns: boolean }> = [
    { role: "builder", write_set: [], warns: true },
    { role: "builder", write_set: ["src/a.ts"], warns: false },
    { role: "scout", write_set: [], warns: false },
    { role: "reviewer", write_set: [], warns: false },
    { role: "planner", write_set: [], warns: false },
    { role: "researcher", write_set: [], warns: false },
    { role: "tester", write_set: [], warns: false },
    { role: "architect", write_set: [], warns: false },
  ];

  for (const c of cases) {
    test(`${c.role} with ${c.write_set.length} declared path(s) ${c.warns ? "warns" : "is silent"}`, () => {
      const out = emptyWriteSetWarning(task({ role: c.role, write_set: c.write_set }), "Test Project");
      if (!c.warns) {
        assert.equal(out, null);
        return;
      }
      assert.ok(out !== null);
      assert.match(out, /t1/, "R17: the warning must NAME the task");
      assert.match(out, /EMPTY write_set/);
      assert.match(out, /R17/);
    });
  }

  test("the spawn path emits it once per spawn, beside the spawn line", () => {
    const src = readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8");
    const spawn = src.slice(
      src.indexOf("async function spawnTaskRuns("),
      src.indexOf("/** Narrow a DB row's role"),
    );
    // R58 (round 231) extracted the log line's text into `formatSpawnLog()` so
    // it could be tested hermetically (see the R58 describe block below); the
    // literal string moved out of this function, so the CALL is what's found.
    const spawnedLog = spawn.indexOf("formatSpawnLog(task, run.id, task.project.name)");
    const warnCall = spawn.indexOf("emptyWriteSetWarning(task, task.project.name)");
    assert.ok(spawnedLog > 0 && warnCall > spawnedLog, "the warn belongs beside the spawn record");
    assert.equal(
      (spawn.match(/emptyWriteSetWarning\(/g) ?? []).length,
      1,
      "one call site — one warning per spawn, never one per tick",
    );
  });
});

describe("the operator's ruling — one running task per (project, workstream)", () => {
  const t = (id: string, workstream: string, project_id = "p1") => ({ id, project_id, workstream });

  test("two tasks of one workstream do not spawn together; two workstreams do", () => {
    const same = partitionByWorkstream([t("a", "main"), t("b", "main")], new Set());
    assert.deepEqual(same.spawn.map((x) => x.id), ["a"]);
    assert.deepEqual(same.deferred.map((x) => x.id), ["b"]);

    const split = partitionByWorkstream([t("a", "main"), t("b", "ui")], new Set());
    assert.deepEqual(split.spawn.map((x) => x.id), ["a", "b"]);
    assert.deepEqual(split.deferred, []);
  });

  test("POSITIVE CONTROL — the constraint removed, both tasks spawn", () => {
    // "Observed failing with the constraint removed", not asserted to be
    // load-bearing. This is `partitionByWorkstream` with its one accumulating
    // line (`taken.add(key)`) deleted: the same fixture that defers `b` above
    // now spawns it, so the deferral above cannot be credited to anything else.
    const withoutConstraint = <T extends { id: string; project_id: string; workstream: string }>(
      claimed: readonly T[],
      busy: ReadonlySet<string>,
    ): T[] => claimed.filter((x) => !busy.has(workstreamKey(x.project_id, x.workstream)));
    assert.deepEqual(
      withoutConstraint([t("a", "main"), t("b", "main")], new Set()).map((x) => x.id),
      ["a", "b"],
      "if this ever defers b, the positive control has stopped being a control",
    );
  });

  test("two projects with a same-named workstream do not serialise against each other", () => {
    const out = partitionByWorkstream([t("a", "ui", "p1"), t("b", "ui", "p2")], new Set());
    assert.deepEqual(out.spawn.map((x) => x.id), ["a", "b"]);
  });

  test("a workstream busy from an earlier tick defers this tick's candidate", () => {
    const busy = new Set([workstreamKey("p1", "ui")]);
    const out = partitionByWorkstream([t("a", "ui"), t("b", "api")], busy);
    assert.deepEqual(out.spawn.map((x) => x.id), ["b"]);
    assert.deepEqual(out.deferred.map((x) => x.id), ["a"]);
  });

  test("busyWorkstreams excludes this pass's own claims — the deadlock trap", () => {
    // claimReadyTasks() flips its winners to 'running' inside its transaction,
    // so without this exclusion every task would find its own workstream busy
    // and the engine would spawn nothing, ever.
    const rows = [
      { id: "a", project_id: "p1", workstream: "main", status: "running" as const },
      { id: "b", project_id: "p1", workstream: "ui", status: "running" as const },
      { id: "c", project_id: "p1", workstream: "api", status: "done" as const },
    ];
    assert.deepEqual([...busyWorkstreams(rows, new Set(["a"]))], [workstreamKey("p1", "ui")]);
    assert.deepEqual([...busyWorkstreams(rows, new Set(["a", "b"]))], []);
    assert.deepEqual(
      [...busyWorkstreams(rows, new Set())].sort(),
      [workstreamKey("p1", "main"), workstreamKey("p1", "ui")].sort(),
      "a 'done' task never makes its workstream busy",
    );
  });

  test("a deferred task is handed back to 'ready', never failed or dropped", () => {
    const src = readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8");
    const spawn = src.slice(
      src.indexOf("async function spawnTaskRuns("),
      src.indexOf("/** Narrow a DB row's role"),
    );
    assert.match(spawn, /partitionByWorkstream\(eligible, busy\)\.deferred/);
    const branch = spawn.slice(spawn.indexOf("if (deferred.has(task.id))"));
    assert.match(branch.slice(0, 400), /setTaskStatus\(task\.id, "ready"\)/);
    assert.match(branch.slice(0, 600), /already has a task running/);
  });
});

describe("R70 a project may not close on an unmerged workstream branch", () => {
  /** Build a fixture and assert its own premise. A R70 case whose fixture
   *  contains no non-`main` row proves nothing about workstreams, and would
   *  pass whatever the predicate did — the exact vacuous pass this phase's
   *  brief names. `expectWorkstreams` is that premise, stated per case. */
  function gate(
    tasks: CloseGateTask[],
    expectWorkstreams: string[],
  ): { tasks: CloseGateTask[]; open: string[] } {
    const present = [...new Set(tasks.map((t) => t.workstream))].filter((w) => w !== "main").sort();
    assert.deepEqual(
      present,
      [...expectWorkstreams].sort(),
      "fixture premise failed: it does not contain the non-main workstreams this case is about",
    );
    return { tasks, open: unintegratedWorkstreams(tasks) };
  }

  const t = (id: string, workstream: string, depends_on: string[] | null): CloseGateTask => ({
    id,
    workstream,
    depends_on,
  });

  test("a legacy project — every row 'main', every depends_on NULL — is untouched", () => {
    const { open } = gate([t("1", "main", null), t("2", "main", null)], []);
    assert.deepEqual(open, [], "every live project today is this shape; it must close as it always did");
  });

  test("a graph project with only workstream 'main' closes exactly as today", () => {
    const { open } = gate([t("1", "main", []), t("2", "main", ["1"])], []);
    assert.deepEqual(open, []);
  });

  test("an empty project has no workstream to hold it open", () => {
    assert.deepEqual(unintegratedWorkstreams([]), []);
  });

  test("THE ATTACK — a workstream with no integration task holds the project open", () => {
    // 03-quality.md §5's named attack, which succeeded against the statement
    // that stood before R70: every task of `ui` is done, nothing is non-done,
    // the project closes, and project/<id8>-ui is stranded with all its work.
    const { open } = gate([t("1", "main", []), t("2", "ui", ["1"]), t("3", "ui", ["1"])], ["ui"]);
    assert.deepEqual(open, ["ui"]);
  });

  test("an integration task covering every task of the workstream releases it", () => {
    const { open } = gate(
      [t("1", "main", []), t("2", "ui", ["1"]), t("3", "ui", ["1"]), t("4", "main", ["2", "3"])],
      ["ui"],
    );
    assert.deepEqual(open, []);
  });

  test("THE MEMBERSHIP CASE — the integration task and its reviewer are 'main', and are not members of W", () => {
    // Get this wrong and NO project with a workstream can ever close, which is
    // a worse bug than the one R70 fixes: the integrator would have to depend
    // on itself. R38 and 02-architecture.md §4.4 put both rows in `main`.
    const tasks = [
      t("1", "main", []), //            the plan
      t("2", "ui", ["1"]), //           workstream work
      t("3", "ui", ["1"]),
      t("4", "main", ["2", "3"]), //    integration task  — merges project/<id8>-ui
      t("5", "main", ["4"]), //         its reviewer      — depends only on the integration
    ];
    const { open } = gate(tasks, ["ui"]);
    assert.deepEqual(open, [], "the integrator must not be required to depend on itself");
  });

  test("covering only PART of the workstream does not release it", () => {
    const { open } = gate(
      [t("1", "main", []), t("2", "ui", ["1"]), t("3", "ui", ["1"]), t("4", "main", ["2"])],
      ["ui"],
    );
    assert.deepEqual(open, ["ui"], "an integration that merges half a workstream strands the rest");
  });

  test("a legacy 'main' row (depends_on NULL) can never be the integrator", () => {
    const { open } = gate([t("1", "main", null), t("2", "ui", null)], ["ui"]);
    assert.deepEqual(open, ["ui"], "NULL names nothing — a pre-graph row integrates nothing");
  });

  test("an 'integration task' placed INSIDE the workstream does not count", () => {
    // It would run in the wrong worktree and its merge would land nowhere the
    // project branch can see. Holding the project is the correct outcome.
    const { open } = gate([t("1", "main", []), t("2", "ui", ["1"]), t("3", "ui", ["1", "2"])], ["ui"]);
    assert.deepEqual(open, ["ui"]);
  });

  test("a task in ANOTHER workstream that covers all of W does not release W", () => {
    // Found by mutation, not by inspection: deleting `workstream === 'main'`
    // from the integrator filter left every case above green. A covering task
    // in workstream `api` runs in api's worktree — its merge would land on
    // project/<id8>-api, not on the project branch — so it integrates nothing.
    // Both workstreams are therefore open, and `api` is open on its own account.
    const { open } = gate(
      [t("1", "main", []), t("2", "ui", ["1"]), t("3", "ui", ["1"]), t("4", "api", ["2", "3"])],
      ["api", "ui"],
    );
    assert.deepEqual(open, ["api", "ui"], "only a 'main' task can be an integration task (R38)");
  });

  test("an integrator depending on MORE than the workstream still releases it", () => {
    // Coverage is ⊇, not =: R38's reviewer chain and ordinary planner edges
    // routinely add dependencies to the integration task.
    const { open } = gate(
      [t("1", "main", []), t("2", "ui", ["1"]), t("9", "main", []), t("4", "main", ["1", "2", "9"])],
      ["ui"],
    );
    assert.deepEqual(open, []);
  });

  test("two workstreams are judged independently and reported sorted", () => {
    const { open } = gate(
      [
        t("1", "main", []),
        t("2", "ui", ["1"]),
        t("3", "api", ["1"]),
        t("4", "main", ["2"]), // integrates ui only
      ],
      ["api", "ui"],
    );
    assert.deepEqual(open, ["api"], "ui is integrated; api is not; the answer names only api");
  });

  test("the SQL mirror in db/projects.ts carries R70's three quantifiers", () => {
    // The pure predicate above is the definition; the statement is its mirror.
    // A mirror that quietly lost a term would let the attack through while
    // every test on this page stayed green, so the statement's shape is
    // asserted here — and the behavioural proof against real rows is
    // scripts/checks/check-close-gate.ts, which drives the shipped function.
    const src = readFileSync(fileURLToPath(new URL("../db/projects.ts", import.meta.url)), "utf8");
    const start = src.indexOf("export async function closeFinishedProjects(");
    assert.ok(start > 0, "closeFinishedProjects moved — this test has gone stale");
    const fn = src.slice(start, src.indexOf("\n/**", start));
    assert.match(fn, /w\.workstream <> 'main'/, "the workstream term");
    assert.match(fn, /i\.workstream = 'main'/, "the integrator must be a 'main' task");
    assert.match(fn, /i\.depends_on IS NOT NULL/, "a legacy row integrates nothing");
    assert.match(fn, /NOT \(m\.id = ANY \(i\.depends_on\)\)/, "the coverage term");
    assert.equal(
      (fn.match(/AND [a-z]\.project_id = p\.id/g) ?? []).length +
        (fn.match(/WHERE [a-z]\.project_id = p\.id/g) ?? []).length,
      3,
      "all three levels must be correlated on project_id, or another project's task can vouch for this one",
    );
    // The refusal must be reported, not swallowed (NF1).
    assert.match(fn, /held: held\.rows/);
  });

  test("the tick reports a held project loudly, once", () => {
    const src = readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8");
    const fn = src.slice(
      src.indexOf("async function reportUnintegratedWorkstreams("),
      src.indexOf("export async function projectTick("),
    );
    assert.ok(fn.length > 0, "reportUnintegratedWorkstreams not found");
    assert.match(fn, /queueNotification\(/, "NF1 forbids the silent variant");
    assert.match(fn, /if \(r70Escalated\.has\(p\.id\)\) continue;/, "no notification storm");
    assert.match(fn, /r70Escalated\.delete\(id\)/, "it must re-arm when the project stops being held");
    assert.match(fn, /unintegratedWorkstreams\(await listTasksForProject\(p\.id\)\)/);
    assert.match(
      fn,
      /have drifted apart/,
      "a held project the pure side cannot explain is a mirror disagreement and must say so",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R58 (phase 6, round 231) — the spawn log names the workstream and the
// dependency count. `formatSpawnLog` is exported purely so this file can
// assert on its text without importing anything that opens a pg Pool —
// `spawnTaskRuns()` is the only caller and is not reachable from a hermetic
// test. See `04-phases.md` §10 for the phase-4/phase-6 file-ownership ruling
// this task was run under.
// ══════════════════════════════════════════════════════════════════════════

import { formatSpawnLog } from "./project-tick.ts";

describe("R58 spawn log — workstream and dependency count", () => {
  test("a graph row with three deps renders deps=3", () => {
    const line = formatSpawnLog(
      task({ depends_on: ["a", "b", "c"], workstream: "main" }),
      "run-1",
      "Test Project",
    );
    assert.match(line, /deps=3\)/);
  });

  test("a graph row with an empty depends_on array renders deps=0", () => {
    const line = formatSpawnLog(
      task({ depends_on: [], workstream: "main" }),
      "run-1",
      "Test Project",
    );
    assert.match(line, /deps=0\)/);
  });

  test("a NULL depends_on (the legacy sentinel) renders deps=legacy, never deps=0", () => {
    // The distinction this whole task exists to preserve: NULL is not zero
    // dependencies, it is "not graph-scheduled at all" (ProjectTask.depends_on
    // doc-comment, db/projects.ts). Collapsing it to deps=0 would be exactly
    // the kind of lie NF1 forbids.
    const line = formatSpawnLog(
      task({ depends_on: null, workstream: "main" }),
      "run-1",
      "Test Project",
    );
    assert.match(line, /deps=legacy\)/);
    assert.doesNotMatch(line, /deps=0/);
  });

  test("workstream 'main' is printed, not omitted", () => {
    // A log line meant to be grepped by `workstream=` must not silently drop
    // the common case (main) while printing it for everything else.
    const line = formatSpawnLog(
      task({ depends_on: [], workstream: "main" }),
      "run-1",
      "Test Project",
    );
    assert.match(line, /workstream=main/);
  });

  test("a non-main workstream is printed by name", () => {
    const line = formatSpawnLog(
      task({ depends_on: [], workstream: "ui" }),
      "run-1",
      "Test Project",
    );
    assert.match(line, /workstream=ui/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * PHASE 5A (round 239) — the graph vocabulary. The old round guide retired,
 * planners taught depends_on / workstream / write_set.
 *
 * Requirements: R47, R48, R49, R50, R51, R52, R53, NF7, plus R38's
 * planner-prompt half and R57's reviewer-prompt half.
 *
 * APPENDED ONLY. Nothing above this line was modified.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ─────────────────
 *
 * (a) "The R49 grep passes because the file it read was empty or was the wrong
 *     file." A readFileSync of a wrong path throws, but a zero-byte read would
 *     certify silently: every `doesNotMatch` over an empty string passes. So
 *     TICK_SRC asserts a POSITIVE CONTROL first — a string known to be live in
 *     that file — before any absence is asserted. A probe that missed fails.
 * (b) "The prompt assertions pass because the test hand-copied the substring it
 *     is looking for, and the constant says something else." Closed by asserting
 *     `prompt.includes(GRAPH_GUIDE)` / `includes(IDEMPOTENCY_NOTE)` against the
 *     constants' OWN output (this file's header states the convention); the
 *     hand-written substrings below are asserted against the CONSTANT, so a
 *     reworded constant that lost a required clause fails rather than drifting.
 * (c) "The NF7 length assertion passes because it measured the SHORT path." A
 *     scratch project gets no WORKTREE_POLICY, no MANAGER_COMMS and no
 *     GITHUB_PUSH_GUIDE, and would measure ~3k characters under any budget.
 *     `maximalPlannerPrompt()` asserts all four blocks are present before it
 *     returns, so a fixture that stopped being maximal fails instead of
 *     reporting a comfortable pass.
 * ══════════════════════════════════════════════════════════════════════════ */

import { GRAPH_GUIDE, IDEMPOTENCY_NOTE } from "./project-tick.ts";

/** The engine's own source, read once. The positive control runs at module load
 *  so an empty or wrong read cannot reach an assertion that would pass on it
 *  (standing rule 3 — a sweep whose probe misses must fail, not certify). */
const TICK_SRC = (() => {
  const src = readFileSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)), "utf8");
  assert.ok(
    src.includes("WORKTREE-ONLY POLICY"),
    "POSITIVE CONTROL FAILED: project-tick.ts was read but does not contain a string known " +
      "to be live in it — the read is empty or points at the wrong file, and every absence " +
      "asserted below would pass vacuously",
  );
  return src;
})();

/** The linkage key is BUILT, never spelled — see cp3-linkage.test.ts's header:
 *  boundary 08 §4.3 greps this branch's diff of `forge-control/src` for it and
 *  must match only `lib/cc-runner.ts` and `db/projects.ts`. */
const MANAGER_LINK_KEY = "origin_" + "chat_id";

/** The project id the maximal measurement is taken with, and the reason it is
 *  not the `project()` factory's `"p1"` (ROUND 242, fix cycle 1, finding 2).
 *
 *  `taskCurl()` renders `project.id` into the prompt verbatim, and every real
 *  project's id is a uuid — 36 characters, never 2. Measured at fe14a7e, that
 *  single substitution is worth 34 characters, and it is worth EXACTLY 34 at
 *  d9858b9 and 05f2842 too (one interpolation site, unchanged across all three
 *  shas), so it shifts the baseline and every measurement taken against it by
 *  the same amount. The growth arithmetic below was therefore never wrong — but
 *  the enforced CAP sat 34 characters looser than any prompt a planner is ever
 *  handed, while its own comment called this "the only measurement NF7's budget
 *  is meaningful against". A cap that no real prompt is measured against is an
 *  instrument reporting a comfortable pass, which is the class 00-vision.md §7
 *  rule 3 exists to catch. The id is the one field that can be fixed rather than
 *  merely disclosed, because 36 is invariant across the fleet.
 *
 *  WHAT REMAINS VARIABLE, AND IS THEREFORE DISCLOSED INSTEAD OF PINNED: `name`
 *  (rendered in the header AND, via `projectSlug()`, in every `${corpus}/` path),
 *  `brief`, the task's `title`/`brief`, and `work_branch`. Those are per-project
 *  DATA with no fleet-wide size, and no constant cap can bound them. NF7's budget
 *  governs the prompt's CONSTANT text — the guides and policy blocks every spawn
 *  pays for — held at this fixture's shape. Read the cap as "the constants, at
 *  this fixture", never as "the longest prompt any planner receives". */
const MAXIMAL_PROJECT_ID = "8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4";

/** The MAXIMAL planner prompt — the only measurement NF7's budget is meaningful
 *  against. A repo-backed project (WORKTREE_POLICY + GITHUB_PUSH_GUIDE), goal
 *  metadata, and a manager-chat linkage (MANAGER_COMMS); ESCALATION_POLICY is
 *  unconditional. Every one of the four is asserted present before the string is
 *  handed back, because a length assertion taken on a scratch project measures
 *  the short path and would report a pass WRONGLY. */
function maximalPlannerPrompt(): string {
  const proj = project({
    id: MAXIMAL_PROJECT_ID,
    repo: "ai-os",
    metadata: {
      mode: "goal",
      [MANAGER_LINK_KEY]: "bfd1283a-b71b-4f35-b577-7d09aad803f2",
    },
  });
  const prompt = buildPrompt(task({ role: "planner", round: 500 }), proj);
  // The fifth maximality control, and the one that guards the PIN rather than
  // the path (round 242). Every constant below is measured at a uuid-shaped id;
  // shortening it would silently loosen the cap by exactly the characters
  // removed, and BASELINE would rot into the "authoritative and WRONG" pin the
  // standing rules name. A fixture change that would rot it fails here first.
  assert.equal(
    proj.id.length,
    36,
    `NOT THE MAXIMAL PATH: the fixture project id is ${proj.id.length} characters, not a uuid's ` +
      "36. taskCurl() renders it verbatim, so every NF7 constant below — BASELINE, the ledger, " +
      "the cap — was measured against a prompt this fixture no longer builds. Re-derive them by " +
      "the method in the NF7 block's comment, or restore the uuid",
  );
  for (const [name, needle] of [
    ["WORKTREE_POLICY", "WORKTREE-ONLY POLICY"],
    ["ESCALATION_POLICY", "AUTONOMY AND ESCALATION"],
    ["MANAGER_COMMS", "MANAGER COMMS"],
    ["GITHUB_PUSH_GUIDE", "GITHUB PUSH"],
  ] as const) {
    assert.ok(
      prompt.includes(needle),
      `NOT THE MAXIMAL PATH: ${name} is absent, so this measurement understates the ` +
        "prompt every real planner receives (NF7)",
    );
  }
  return prompt;
}

const goalProject = project({
  repo: "ai-os",
  metadata: { mode: "goal" },
});

describe("R49 the retired round guide leaves no trace in the engine's source", () => {
  /* THE TWO NEEDLES ARE ASSEMBLED, NEVER SPELLED, and that is not a stylistic
   * choice — it is what keeps R49's own gate satisfiable. 03-quality.md §3.2's
   * phase-5 gate and this task's verify block both grep `forge-control/` for the
   * retired wording and for the retired identifier and require EMPTY output (the
   * two commands are quoted in full in evidence/phase5-prompts.md §3, which no
   * such sweep reads), and this file is under `forge-control/`. A test that
   * spelled either literal — in a regex, in a
   * failure message, in a comment quoting the command — would put hits back into
   * the very sweep it exists to keep clean, and the next three reviewers would
   * disclose-and-proceed against a gate that could no longer be passed
   * (00-vision.md §7 rule 2; the `pm2 restart` precedent in 03-quality.md §4).
   * So the failure messages DESCRIBE the retired text instead of quoting it.
   * `.join()`/`+` are opaque to grep and exact to the assertion. */
  const RETIRED_WORDING = ["consecutive", "rounds"].join(" ");
  const RETIRED_IDENTIFIER = "PARALLEL" + "ISM_GUIDE";

  test("G1 — neither the retired wording nor the retired identifier occurs in project-tick.ts", () => {
    // R49's *How proved* named "the old assertion is deleted, not skipped".
    // MEASURED at HEAD d9858b99a64d6d7ee835ee359fda9515a315bbf3, before this
    // commit: grepping the retired identifier across *.ts, *.sh and *.py in the
    // whole repo returned exactly three hits, ALL of them the constant and its
    // two interpolation sites in project-tick.ts — no test anywhere asserted its
    // content. There was therefore no assertion to delete, and deleting
    // "something" to discharge the clause would have removed an unrelated test.
    // The retirement is constant-only, the commit message says so and names R49,
    // and this POSITIVE anti-regression gate replaces the assertion that never
    // existed: R49 becomes unrepeatable rather than merely done. Doc-comments
    // count as source, which is why the surviving comment in project-tick.ts
    // paraphrases the retired text instead of quoting it — this gate caught that
    // comment quoting it on its first run.
    assert.ok(
      !TICK_SRC.includes(RETIRED_WORDING),
      `R49: the retired round guide's wording ("${RETIRED_WORDING}") is back in ` +
        "project-tick.ts. Telling a planner to separate colliding work into successive rounds " +
        "is actively wrong under the graph: ordering is depends_on, contention is write_set, " +
        "and a round is a derived label that reads neither",
    );
    assert.ok(
      !TICK_SRC.includes(RETIRED_IDENTIFIER),
      `R49: the retired identifier (${RETIRED_IDENTIFIER}) is back in project-tick.ts — it was ` +
        "to be deleted, not commented out, not left unreferenced, not renamed in place",
    );
  });

  test("both former interpolation sites now carry GRAPH_GUIDE", () => {
    // The planner and the goal-mode architect are the two roles that create
    // tasks, and were the two sites the retired constant reached.
    const plannerPrompt = buildPrompt(task({ role: "planner" }), goalProject);
    const architectPrompt = buildPrompt(task({ role: "architect" }), goalProject);
    assert.ok(plannerPrompt.includes(GRAPH_GUIDE), "R49/R47: planner prompt lost GRAPH_GUIDE");
    assert.ok(
      architectPrompt.includes(GRAPH_GUIDE),
      "R49/R47: goal-mode architect prompt lost GRAPH_GUIDE — the architect seeds the planners " +
        "and must hand them the same vocabulary",
    );
  });
});

describe("R47/R48/R38 the graph vocabulary the planner is taught", () => {
  const plannerPrompt = maximalPlannerPrompt();

  test("G3 — the round instruction is gone, the three declared fields are in", () => {
    assert.doesNotMatch(
      plannerPrompt,
      /Your round is/,
      "R47: the planner prompt still tells the planner its round. A planner that writes round " +
        "numbers is the defect this phase exists to remove (DoD-5)",
    );
    assert.doesNotMatch(
      plannerPrompt,
      /Do not exceed round/,
      "R47: the round-ceiling instruction survived — there is no round for a planner to exceed",
    );
    for (const field of ["depends_on", "workstream", "write_set"]) {
      assert.ok(
        plannerPrompt.includes(field),
        `R47: the planner prompt never names "${field}" — a planner cannot declare a field it ` +
          "has not been told about",
      );
    }
  });

  test("R47 — the companion-files clause is in the planner prompt, in its own terms", () => {
    for (const clause of [
      "TEST FACTORIES AND CALL SITES",
      "its gate to be honest",
      "not a summary of intent",
    ]) {
      assert.ok(
        plannerPrompt.includes(clause),
        `R47 (companion files, added round 204): the planner prompt is missing "${clause}". ` +
          "Two workstreams whose write-sets both omit the same forced companion are scheduled " +
          "in parallel over that file — a bookkeeping finding today, a clobber under workstreams",
      );
    }
  });

  test("R48 — the three fan-out rules are stated as rules", () => {
    for (const [rule, needle] of [
      ["research fans out wide and early", "RESEARCH wide and early"],
      ["research has no ordering and no shared files", "share no files and have no ordering"],
      ["builders fan out by file ownership", "BUILDERS by FILE OWNERSHIP"],
      ["reviewers remain a genuine join", "REVIEWERS are a genuine join"],
    ] as const) {
      assert.ok(
        GRAPH_GUIDE.includes(needle),
        `R48: GRAPH_GUIDE no longer states that ${rule} (looked for "${needle}")`,
      );
    }
  });

  test("R48 — file ownership is stated as a constraint, with the no-split ruling", () => {
    assert.ok(
      GRAPH_GUIDE.includes("No two builders in ONE workstream may declare the same file"),
      "R48: GRAPH_GUIDE lost the file-ownership constraint that makes write_set a scheduling input",
    );
    assert.ok(
      GRAPH_GUIDE.includes("one builder writes that file twice"),
      "R48 (04-phases.md §10's closing ruling): where a split is impossible the file goes to ONE " +
        "builder — otherwise a planner serialises two builders on it, which is the stall this " +
        "project measured",
    );
  });

  test("R38 — the integration task is explicit, joined by a reviewer, and never auto-merged", () => {
    for (const [what, needle] of [
      ["the prohibition, in the heading a planner cannot skim past", "NEVER AUTO-MERGE"],
      ["a terminal task per non-main workstream", 'every workstream but "main" ends in an integration task'],
      ["role builder, workstream main", '(role builder, workstream "main")'],
      ["it depends on every task of that workstream", "depending on every task of that workstream"],
      ["it carries the union of the write-sets", "carrying the union of their write_sets"],
      ["on conflict it stops and reports verbatim", "STOPS and reports the conflicting files verbatim"],
      ["a reviewer depends on it", "plus a reviewer depending on it"],
      ["why auto-merge is forbidden", "whoever finishes last"],
    ] as const) {
      assert.ok(
        GRAPH_GUIDE.includes(needle),
        `R38: GRAPH_GUIDE no longer states ${what} (looked for "${needle}"). Auto-merge resolves ` +
          "in favour of whoever finishes last, which is silent clobbering in a new costume",
      );
    }
  });

  test("the one-reviewer join and the self-contained brief survived the rewrite", () => {
    assert.ok(
      plannerPrompt.includes("exactly one reviewer task DEPENDING ON every builder you created"),
      "R47/R48: the planner must still end with exactly one reviewer — now expressed as a " +
        "dependency join, not as 'the round after your last builder round'",
    );
    assert.ok(
      plannerPrompt.includes("the files it will write"),
      "R47: a builder brief must NAME THE FILES IT WILL WRITE — that is the input to contention " +
        "computation, and it must be declared rather than archaeologically reconstructed",
    );
  });

  test("the corpus-reading sentence is untouched — both layouts still named", () => {
    // cp3-linkage.test.ts asserts these two strings independently; this case
    // states the dependency so a future rewrite of this branch sees it here too.
    assert.ok(
      plannerPrompt.includes("docs/plan/engine-task-graph") ||
        plannerPrompt.includes("docs/plan/test-project"),
      "the slugged corpus path is gone from the planner prompt (C18, cp3-linkage.test.ts)",
    );
    assert.ok(
      plannerPrompt.includes("flat docs/plan/"),
      "the flat corpus layout is gone from the planner prompt — an in-flight project planned " +
        "before the slug landed would be sent to a directory that does not exist (C18)",
    );
  });
});

describe("R50 idempotency under a computed round", () => {
  test("the note states both halves: identity unchanged, round computed", () => {
    for (const [what, needle] of [
      ["identity is still the four-tuple", "(project, round, role, title)"],
      ["the round is now computed", "COMPUTED from depends_on"],
      ["the same depends_on computes the same round", "always computes the same round"],
      ["a repeat still 409s", "409"],
      ["re-issuing is safe", "safe"],
      ["the 409 body carries the original task", "carries the original task"],
    ] as const) {
      assert.ok(
        IDEMPOTENCY_NOTE.includes(needle),
        `R50: IDEMPOTENCY_NOTE no longer states that ${what} (looked for "${needle}"). A planner ` +
          "that believed a computed round might differ on the second attempt would retry into a " +
          "duplicate instead of trusting the 409",
      );
    }
  });

  test("both task-creating roles receive it", () => {
    assert.ok(
      buildPrompt(task({ role: "planner" }), goalProject).includes(IDEMPOTENCY_NOTE),
      "R50: planner prompt lost IDEMPOTENCY_NOTE",
    );
    assert.ok(
      buildPrompt(task({ role: "architect" }), goalProject).includes(IDEMPOTENCY_NOTE),
      "R50: goal-mode architect prompt lost IDEMPOTENCY_NOTE",
    );
  });
});

describe("R53 the shipped curl example", () => {
  const plannerPrompt = buildPrompt(task({ role: "planner" }), goalProject);
  /** The example body only — asserting "the prompt contains no round" would be
   *  wrong (the header still says "Your task (round 500)") and asserting it over
   *  the whole prompt is what would make this gate lie. */
  const curl = plannerPrompt.slice(
    plannerPrompt.indexOf("ID=$(curl"),
    plannerPrompt.indexOf("| jq -r .task.id)") + "| jq -r .task.id)".length,
  );

  test("the example is delimited at all — the slice's own control", () => {
    assert.ok(
      curl.startsWith("ID=$(curl") && curl.endsWith("| jq -r .task.id)"),
      `the curl example could not be sliced out of the planner prompt: ${JSON.stringify(curl.slice(0, 80))}`,
    );
  });

  test("it shows the three graph fields and OMITS round", () => {
    for (const field of ['"depends_on"', '"workstream"', '"write_set"']) {
      assert.ok(curl.includes(field), `R53: the example body does not show ${field}`);
    }
    assert.doesNotMatch(
      curl,
      /"round"/,
      'R53: the example body still sends "round". The route computes it from depends_on, and a ' +
        "template that renders an unset shell variable into an empty round is exactly how a task " +
        "lands at round 0 with its dependencies at 300",
    );
  });

  test("it captures the id a fan-out needs, at the path both 201 and 409 use", () => {
    // routes/projects.ts POST /:id/tasks: 201 -> { task }, 409 -> { task, error }.
    // The id is at .task.id in both, so one line serves a first attempt and a retry.
    assert.ok(curl.includes("jq -r .task.id"), "R53/R50: the example does not capture the created id");
  });
});

describe("R51 the architect's phase label is the last hand-written round", () => {
  const architectPrompt = buildPrompt(task({ role: "architect" }), goalProject);

  test("G4 — the k*100 seeding instruction survives and is described as a label", () => {
    assert.ok(
      architectPrompt.includes('"round": 100'),
      "R51: the goal-mode architect is no longer shown the round field it alone adds. taskCurl() " +
        "omits round (R53), so without this the architect faithfully omits it too and every " +
        "phase planner computes to round 0",
    );
    assert.ok(
      architectPrompt.includes("PHASE LABEL, not a schedule"),
      "R51: the k*100 round is not described as a phase label — the one legitimate hand-written " +
        "round left in the system",
    );
    assert.ok(
      architectPrompt.includes("round k*100 - 1"),
      "R51: the scout-before-a-phase instruction was lost with the rewrite",
    );
    assert.ok(
      architectPrompt.includes("inherit nothing else"),
      "R51: the prompt must say the planners inherit nothing else about rounds, or the architect " +
        "will pass its phase-label habit down to them",
    );
  });

  test("G4 negative — a NON-goal-mode architect gains no phase label", () => {
    const plain = buildPrompt(task({ role: "architect" }), project({ repo: "ai-os" }));
    assert.doesNotMatch(
      plain,
      /"round": 100/,
      "R51: the phase-label block leaked into the non-goal-mode architect branch, which seeds no " +
        "per-phase planners at all",
    );
    assert.doesNotMatch(plain, /PHASE LABEL/, "R51: same leak, the describing sentence");
  });
});

describe("R52 the builder restates its declared write-set", () => {
  test("the declared paths are rendered from the task row, not left to the brief", () => {
    const prompt = buildPrompt(
      task({ role: "builder", write_set: ["src/lib/a.ts", "src/lib/a.test.ts"] }),
      project({ repo: "ai-os" }),
    );
    assert.ok(
      prompt.includes("src/lib/a.ts, src/lib/a.test.ts"),
      "R52: the builder is not shown the write_set stored on its own row — a builder that has to " +
        "reconstruct its declaration from prose cannot restate it faithfully",
    );
    assert.ok(
      prompt.includes("Restate it in your final report"),
      "R52: the builder is not required to restate its write-set",
    );
    assert.ok(
      prompt.includes("say so LOUDLY"),
      "R52: the loud-disclosure requirement for a write outside the set is gone. A declared " +
        "write-set nobody discloses against is a suggestion",
    );
    assert.ok(
      prompt.includes("Your reviewer compares the paths your commits touched"),
      "R52: the prompt must name R57's reviewer gate as the thing that will check the claim",
    );
  });

  test("an empty write_set says so instead of rendering an empty list", () => {
    // NF1 in prompt form: a builder shown "YOUR DECLARED WRITE-SET is ." would
    // read it as a rendering bug and ignore the clause.
    const prompt = buildPrompt(task({ role: "builder", write_set: [] }), project({ repo: "ai-os" }));
    assert.ok(
      prompt.includes("(empty — nothing was declared)"),
      "R52: an empty write_set must be stated as empty, not rendered as a blank list",
    );
  });
});

describe("R57 the reviewer's write-set audit", () => {
  const reviewerPrompt = buildPrompt(task({ role: "reviewer" }), project({ repo: "ai-os" }));

  test("the gate names its comparison, its verdict, and why it is satisfiable", () => {
    for (const [what, needle] of [
      ["the audit exists", "WRITE-SET AUDIT"],
      ["it compares committed paths", "git log --name-only"],
      ["against the declared set", "against the write_set it declared"],
      ["an undeclared write is a finding", "is a FINDING, not a footnote"],
      ["write-sets are declared, not reconstructed", "DECLARED on the task row"],
      ["so there is nothing to disclose past", "nothing here to disclose and proceed past"],
    ] as const) {
      assert.ok(
        reviewerPrompt.includes(needle),
        `R57: the reviewer prompt no longer states ${what} (looked for "${needle}"). A reviewer ` +
          "who believes a gate is unsatisfiable discloses and proceeds, and that habit is what " +
          "this project exists to remove (03-quality.md §4)",
      );
    }
  });

  test("R37's diff base is exactly what phase 4C shipped", () => {
    // Phase 5 owns the prompt constants; the diff base is phase 4C's and is
    // asserted in full by "R36/R37 … byte-identical" above. This case only
    // guards against the write-set audit having been spliced INTO that sentence.
    assert.ok(
      reviewerPrompt.includes("Review the actual diff (git diff main...HEAD)"),
      "R37: the `main`-workstream diff base changed wording — phase 4C's text was to be left " +
        "exactly as it shipped",
    );
  });
});

describe("NF7 the prompt budget, and the assertion that holds it", () => {
  /* THE BASELINE, and how to re-derive it.
   *
   *   BASELINE = 9279 characters, MEASURED at
   *   d9858b99a64d6d7ee835ee359fda9515a315bbf3 (round 239's tip, before this
   *   commit's first edit) through the MAXIMAL path — repo-backed "ai-os", goal
   *   metadata, manager-chat linkage — i.e. including WORKTREE_POLICY +
   *   ESCALATION_POLICY + MANAGER_COMMS + GITHUB_PUSH_GUIDE.
   *
   * To re-derive: check out that sha and print
   * `buildPrompt(<planner task>, <that project>).length` with the fixtures
   * `maximalPlannerPrompt()` above builds (they are the same four blocks), or
   * equivalently run this test at that sha and read the measured value out of
   * its failure message.
   *
   * ── THE BUDGET IS AMENDED HERE, WHERE IT IS ENFORCED (standing rule 2) ────
   *
   * NF7 asks for "~1500 characters net", on the stated expectation that "the
   * retired round guide's removal pays for most of the new text". MEASURED, this
   * commit: that removal pays 314 characters, and the round instruction it also
   * deletes pays 509 — 823 in total against 3221 characters of new required
   * text, for a net of +2398:
   *
   *   GRAPH_GUIDE                1800   (R47 three fields, R48 three fan-out
   *                                      rules, R38 integration + never-auto-merge)
   *   companion-files clause      769   (R47, added round 204)
   *   reviewer-join + brief       355   (R47, replacing part of the 509 deleted)
   *   IDEMPOTENCY_NOTE           +169   (R50)
   *   taskCurl example           +128   (R53)
   *   retired round guide         -314  (R49)
   *   deleted round instruction   -509  (R47)
   *   ------------------------------------------------------------------
   *   net                       +2398
   *
   * 188 of GRAPH_GUIDE's 1800 are the workstream cap stated honestly. Saying a
   * flat "Max 6" would have taught a call that 400s wherever
   * PROJECT_MAX_WORKSTREAMS is overridden (routes/projects.ts reads it from the
   * environment), and a prompt that teaches a refused call is worse than no
   * prompt. That is the trade this budget is paying for.
   *
   * 1500 is therefore not reachable while R47's companion-files clause and R38's
   * integration paragraph are stated in the terms their requirements demand —
   * the alternative is a prompt that passes a `.includes()` check and cannot be
   * followed, which 03-quality.md §3.2's phase-5 gate names as "a passing gate
   * on a broken deliverable". Rather than disclose-and-proceed against a budget
   * that cannot be met, the budget is amended here with its arithmetic inline
   * and the divergence from NF7's "~1500" REPORTED to the manager chat (round
   * 239) for a ruling on the corpus text, which lives in 01-requirements.md §J
   * — a file outside this task's declared write-set.
   *
   * BUDGET = 3050 = the 2398 delivered + 652 of headroom for builder 5B, which
   * adds a short block to withPolicy() at round 240 and lands inside this same
   * measurement. 652 > the 600 that brief reserves. The gate still fails on any
   * unbudgeted growth: it is 652 characters from red, not comfortable — the
   * headroom case below was observed RED at 502 when the workstream-cap sentence
   * was added, which is how both halves of this gate are known to work. */
  /* ── ROUND 240: THE BASELINE PIN WAS 92 TOO HIGH, AND IS CORRECTED HERE ──
   *
   * Builder 5B re-derived the baseline by exactly the method the comment above
   * prescribes, because every number 5B reports is pinned to it. Method: `git
   * show d9858b9:forge-control/src/lib/project-tick.ts` written beside its own
   * siblings (which that commit did not touch, so its imports resolve to the
   * same modules), imported under a POSITIVE CONTROL that the module does NOT
   * export GRAPH_GUIDE — i.e. that it really is the pre-5A code and not HEAD's —
   * and measured through the same maximal fixtures.
   *
   *   re-derived pre-5A baseline           9187
   *   pinned above as BASELINE             9279   (+92, wrong)
   *   measured at 05f2842 (5A's tip)      11585
   *   5A's itemised net              +2398        -> 9187 + 2398 = 11585 EXACT
   *
   * So 5A's arithmetic was right and its pin was not: the "11677" its commit
   * message reports as measured is 9279 + 2398, a SUM, never a measurement, and
   * the two errors cancelled. Left alone, the cap would sit 92 characters above
   * what it advertises — a rotted pin that no longer reads as stale but as
   * authoritative, which is the failure class 00-vision.md §7 rule 1 exists to
   * catch. Correcting it TIGHTENS the gate (cap 12329 -> 12237) and makes 5A's
   * promised headroom exact: 12237 - 11585 = 652, the number its brief reserved.
   *
   * BUDGET is untouched at 3050. It is the operator's ruling (round 240) and is
   * now also written into 01-requirements.md §J, where NF7 read "~1500". */
  /* ── ROUND 242: THE PIN MOVES TO A UUID-SHAPED FIXTURE (finding 2) ────────
   *
   * Round 241's reviewer measured the fixture against a real-valued build and
   * found the fixture short. The cause is `MAXIMAL_PROJECT_ID` above: `"p1"`
   * where every real project carries a 36-character uuid that `taskCurl()`
   * renders verbatim. RE-DERIVED, by exactly the method this block prescribes —
   * three trees exported with `git archive`, node_modules symlinked but no
   * source symlinked, each measured by a harness that prints its own
   * sha256(project-tick.ts) and refuses to report a number unless the module's
   * GRAPH_GUIDE export matches what that sha must have:
   *
   *   sha        sha256(project-tick.ts)  exportsGRAPH_GUIDE  id:"p1"  id:uuid
   *   d9858b9    b10ddc0190bd280e         false  <- control     9187     9221
   *   05f2842    00bcdeae5cfbd555         true                11585    11619
   *   fe14a7e    c4141f17fde418ef         true                12061    12095
   *
   * Three distinct digests, and the pre-5A tree provably not HEAD because it
   * fails the export control — the shadow-tree trap, excluded rather than
   * asserted away. The `id:"p1"` column REPRODUCES round 240's three numbers
   * exactly, which is the corrected baseline confirmed a second time by a
   * different builder; the delta is a flat +34 at all three shas, so nothing in
   * the growth arithmetic above moves and the cap RISES by 34.
   *
   *   BASELINE   9187 -> 9221      cap  12237 -> 12271
   *   5A tip    11585 -> 11619     headroom at 5A unchanged at 652
   *   5B tip    12061 -> 12095     headroom after 5B unchanged at 176
   *
   * WHICH WAY THE GATE MOVED, stated once and correctly, because round 242 wrote
   * this backwards and round 244 is the round that fixes the sentence rather
   * than the arithmetic. A rising cap read ALONE is a WIDENING — the one
   * direction 00-vision.md §7 rule 2 does not license — so it does not get to
   * pass as a tightening by assertion:
   *
   *   ROUND 240's correction genuinely TIGHTENED. The measurement stood still
   *   and the cap fell 12329 -> 12237, so the headroom SHRANK by 92. Fewer
   *   characters are permitted after it than before it.
   *
   *   ROUND 242's re-derivation is NEITHER. Both sides moved by the same +34:
   *   the cap rises 12237 -> 12271 AND every measurement taken on this fixture
   *   rises by 34, because `taskCurl()` renders the project id ONCE and a uuid
   *   is 34 characters longer than "p1". Headroom is IDENTICAL at every pin —
   *   652 at 5A, 176 after 5B, and 150 live. BUDGET is untouched at 3050, which
   *   is the whole of what this gate permits; not one character of allowance was
   *   bought. What changed is the FRAME the budget is measured in, from a
   *   fixture no real project has to one shaped like every real project.
   *
   * MEASURED at round 244 by a harness that prints its own build identity —
   * sha256(project-tick.ts) — and refuses to report a number unless the module
   * exports GRAPH_GUIDE:
   *
   *   id "p1" (2 chars)   12087     occurrences of the id in the prompt: 1
   *   id uuid (36 chars)  12121     delta +34 = 36 - 2, once
   *   headroom  150 in BOTH frames  <- the gate is exactly as tight either way
   *
   * Run TWICE, at sha256 01d79c140baf3500 and again at 7622e1fc0c07e342 after
   * round 244 rewrote a doc-comment in project-tick.ts. Both digests, all four
   * numbers identical. That pair is not decoration: it is the POSITIVE CONTROL
   * for this block's standing claim that reasoning lives in doc-comments because
   * they cost the prompt nothing — a claim otherwise asserted and never once
   * measured. It also states the honest limit of a sha pin here: this digest
   * names the module a number came off, and it moves whenever a comment moves,
   * so re-derive rather than trust it if it does not match your tree.
   *
   * ONE COINCIDENCE, FLAGGED SO IT IS NEVER READ AS A CONFIRMATION: this round's
   * measurement comes to 12121, and 12121 is also the number round 241's
   * reviewer reported for its real-valued build at fe14a7e. They are different
   * quantities that happen to collide — the reviewer's 60 was a uuid plus a
   * longer name and work_branch at fe14a7e; this 12121 is a uuid alone at
   * fe14a7e plus round 242's own 26. Neither corroborates the other. */
  const BASELINE = 9221;
  const BUDGET = 3050;

  test("G5 — the maximal planner prompt stays inside the amended budget", () => {
    const measured = maximalPlannerPrompt().length;
    const cap = BASELINE + BUDGET;
    assert.ok(
      measured <= cap,
      `NF7: the planner prompt is over budget. baseline ${BASELINE} (at ` +
        `d9858b99a64d6d7ee835ee359fda9515a315bbf3, maximal path), budget ${BUDGET}, ` +
        `cap ${cap}, measured ${measured}, overrun ${measured - cap}. Every worker prompt ` +
        "carries WORKTREE_POLICY + ESCALATION_POLICY + MANAGER_COMMS, and unbounded prompt " +
        "growth is a real cost per spawn — cut text or amend the budget where it is enforced, " +
        "with the arithmetic, and say so.",
    );
  });

  /* THE ROUND LEDGER, and why round 242 had to write one (standing rule 2,
   * amended WHERE IT IS ENFORCED).
   *
   * WHAT THIS CASE WAS. Round 239 wrote it as a FORWARD RESERVATION —
   * `headroom >= 600` — so 5B's brief had a number to read rather than a
   * subtraction to perform. Round 240 spent it (DEP_INSTALL_NOTE now rides
   * withPolicy() into every repo-backed prompt, this measurement included) and,
   * rather than let the case go red the moment it did its job, turned it around
   * into a backward audit: `FIVE_A_HEADROOM - headroom <= 600`.
   *
   * WHY THAT SHAPE CANNOT SURVIVE A SECOND SPENDER. `headroom` is LIVE and
   * `FIVE_A_HEADROOM` is pinned at 5A, so `consumed` is every character added
   * since 5A by ANYONE. Round 242 adds 26 to GRAPH_GUIDE (finding 3), and the
   * assertion would have read 502 <= 600 and passed — charging this round's
   * spend to 5B's reservation and reporting a 5B underspend that never happened.
   * The instrument would have lied before the code did, which is the failure
   * class the standing rules put first. It is not deleted and not widened; it is
   * generalised into the thing it was always approximating.
   *
   * WHAT THE LEDGER ASSERTS. Every character between the 5A tip and the live
   * measurement is ATTRIBUTED to a round that declared it. The sum is EXACT, not
   * a bound: an unledgered edit fails with its own size in the message, and the
   * next round adds a row instead of quietly inheriting someone else's budget.
   * Each row is additionally held to what its own brief reserved, which is the
   * 600 the old case checked, per round rather than in aggregate.
   *
   * MEASURED, on the round-242 BASELINE (uuid fixture) — the same three numbers
   * as round 240 plus 34 each, so nothing here is a new claim about 5B:
   *   at 05f2842 (5A's tip)            11619   headroom 652
   *   after 5B  (fe14a7e)              12095   headroom 176   5B spent 476/600
   *   after 242                        12121   headroom 150   242 spent  26/176
   * The 476 is DEP_INSTALL_NOTE (474) plus the "\n\n" that joins it. B2, B3 and
   * B4 cost this measurement nothing: the reviewer blocks reach only the reviewer
   * branch, and the browser block only the roles carrying BROWSER_FIRST or
   * RESEARCH_INSTRUMENTS — the planner is none of them. Round 242's 26 is the two
   * research role literals in GRAPH_GUIDE's FAN-OUT sentence and nothing else:
   * its other two fixes are a non-goal architect branch (a different role, not in
   * this measurement) and this file.
   *
   * ROUND 900 adds the sentence GRAPH_GUIDE's own doc-comment documents at the
   * "write_set" bullet (round 244's follow-up, re-routed here). MEASURED, not
   * argued: maximalPlannerPrompt() before this round's edit is 12121 (the number
   * above); after it, 12227. 12227 - 12121 = 106, which is also the sentence's
   * own `.length` — a one-sentence addition to a string already in the planner
   * prompt cannot cost anything else, so the two matching is the positive
   * control that nothing but the sentence moved. Round 900 does NOT touch
   * SCREENSHOT_CONVENTION or BROWSER_CONTROL_SAFETY's cost: both ride
   * `drivesBrowser`, which the planner branch never satisfies (neither
   * BROWSER_FIRST nor RESEARCH_INSTRUMENTS appears in it), exactly as B4 cost
   * this measurement nothing at round 240. Headroom after: 12271 - 12227 = 44. */
  const FIVE_A_TIP = 11619;
  const LEDGER = [
    {
      round: 240,
      what: "DEP_INSTALL_NOTE (B1) riding withPolicy(), plus its joining newlines",
      spent: 476,
      reserved: 600,
    },
    {
      round: 242,
      what: 'GRAPH_GUIDE names the two research role literals in FAN-OUT (fix cycle 1, finding 3)',
      spent: 26,
      reserved: 176,
    },
    {
      round: 900,
      what: 'GRAPH_GUIDE\'s "write_set" bullet: "if a round moves a constant the corpus quotes, the ' +
        'documents quoting it belong in that round\'s write_set" (round 244\'s follow-up, placed at ' +
        "the definition rather than the COMPANION FILES prose)",
      spent: 106,
      reserved: 106,
    },
  ] as const;

  test("every character spent since the 5A tip is attributed to a round that declared it", () => {
    const measured = maximalPlannerPrompt().length;
    const ledgered = LEDGER.reduce((sum, row) => sum + row.spent, 0);
    const expected = FIVE_A_TIP + ledgered;
    assert.equal(
      measured,
      expected,
      `NF7: the maximal planner prompt measures ${measured}, but the 5A tip (${FIVE_A_TIP}) plus ` +
        `every ledgered spend (${LEDGER.map((r) => `${r.round}:${r.spent}`).join(" + ")} = ` +
        `${ledgered}) comes to ${expected} — ${measured - expected} characters are unaccounted ` +
        "for. Add a row to LEDGER naming your round and what it bought, or, if you did not " +
        "intend to change the planner prompt at all, you did: this is the number.",
    );
  });

  test("no round spent more of the prompt budget than its brief reserved", () => {
    for (const row of LEDGER) {
      assert.ok(
        row.spent <= row.reserved,
        `NF7: round ${row.round} consumed ${row.spent} characters of the ${row.reserved} ` +
          `reserved for it (${row.what}). Shrink the text; do NOT widen BUDGET or the ` +
          "reservation to fit it — that is the one direction 00-vision.md §7 rule 2 does not " +
          "license.",
      );
    }
  });

  test("the headroom left is real, and the blocks it was spent on are actually delivered", () => {
    const measured = maximalPlannerPrompt().length;
    const headroom = BASELINE + BUDGET - measured;
    assert.ok(
      headroom >= 0,
      `NF7: no headroom left at all (${headroom}) — G5 above says the same thing louder`,
    );
    // THE DELIVERY CONTROL, and it is what keeps the ledger from being pure
    // arithmetic. Every row above claims characters were spent BUYING something;
    // a block that stopped being delivered would shrink `measured`, and the
    // exactness assertion would then fail in the direction that reads like an
    // over-count rather than a missing delivery. These two name the deliverable
    // per row, so the failure says which round's purchase went missing.
    const prompt = maximalPlannerPrompt();
    assert.ok(
      prompt.includes(DEP_INSTALL_NOTE),
      "NF7 (round 240's row): the ledger charges 476 characters to DEP_INSTALL_NOTE, but the " +
        "planner prompt does not contain it — a spend with nothing delivered is not an " +
        "underspend, it is a missing block",
    );
    // Per this file's header convention the CLAUSE is asserted against the
    // constant and the DELIVERY against the built prompt, so a reworded
    // GRAPH_GUIDE that dropped the literals fails here rather than drifting.
    assert.ok(
      GRAPH_GUIDE.includes('one "researcher" (or "scout") task each'),
      "NF7 (round 242's row): the ledger charges 26 characters to the research role literals in " +
        "GRAPH_GUIDE's FAN-OUT sentence, and GRAPH_GUIDE no longer contains them — the one " +
        "construct a planner could not spell without inventing a role string",
    );
    assert.ok(
      prompt.includes(GRAPH_GUIDE),
      "NF7 (round 242's row): GRAPH_GUIDE carries the charge but is not in the planner prompt " +
        "at all, so the clause above was asserted against a constant nobody receives",
    );
    assert.ok(
      GRAPH_GUIDE.includes(
        "If a round moves a constant the corpus quotes, the documents quoting it belong in that " +
          "round's write_set.",
      ),
      "NF7 (round 900's row): the ledger charges 106 characters to the write_set-definition " +
        "sentence, and GRAPH_GUIDE no longer contains it verbatim",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * PHASE 5B (round 240) — the withPolicy addenda. Four rules put where they
 * cannot be forgotten: the dep-install trap (B1), the reviewed tip (B2), the
 * gate suite (B3), and the row that changed state between runs (B4).
 *
 * Built on 05f284207b5b77897ef2fb4d6d249498d5a0a02b (phase 5A, round 239).
 * Every number in evidence/phase5-prompts.md §4 is pinned to that sha.
 *
 * APPENDED ONLY, with TWO DECLARED EXCEPTIONS, both amendments to a pin rather
 * than deletions of a test — see "NF7 the prompt budget" above, where each is
 * marked ROUND 240 with its reasoning inline:
 *   1. BASELINE 9279 -> 9187. Re-derived by the method the constant's own
 *      comment prescribes; the old value was 92 too high, which made the
 *      enforced cap 92 more generous than it advertised. The correction TIGHTENS
 *      the gate.
 *   2. "the headroom builder 5B needs is actually there" — a forward
 *      RESERVATION for this round, which this round spends. Rewritten as a
 *      backward audit of the same number (5B may consume at most the 600 it was
 *      promised) so the case keeps a live assertion instead of becoming vacuous.
 * No test was deleted, and nothing else above this line was modified.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ─────────────────
 *
 * (a) "The assertion greps the CONSTANT instead of the BUILT PROMPT, and so
 *     passes while withPolicy() never delivers it." This is the failure the
 *     brief names first, and it is closed STRUCTURALLY, not by inspection:
 *     every delivery claim below is a PAIR over buildPrompt()'s output — a
 *     positive on one project/role and a NEGATIVE on another. `DEP_INSTALL_NOTE`
 *     is one object; an assertion that had degenerated into `CONST.includes(...)`
 *     would answer the same for both halves of the pair, so the negative half
 *     would fail. A pair that both passes can only be produced by a buildPrompt
 *     that actually discriminates. (Observed, not merely argued: the negative
 *     half of B1's pair was watched failing on purpose — see the commit message.)
 * (b) "A `.includes()` on a string so generic it matches unrelated text." No
 *     delivery assertion here takes a hand-typed needle. They take the WHOLE
 *     constant — 474 to 1081 characters of exact text — which nothing else in a
 *     prompt can satisfy by accident. Where a specific CLAUSE is required (the
 *     brief names three for the reviewer), it is asserted against the CONSTANT,
 *     per this file's header convention, so a reworded constant that dropped a
 *     required clause fails here instead of drifting away from the test.
 * (c) "The measurement was taken on the short path." Everything length-related
 *     goes through `maximalPlannerPrompt()`, which asserts its own four blocks
 *     are present before returning (5A, above).
 * (d) "The role-set test only checks presence, so a block that leaked into every
 *     role still passes." Every role-set case below is exhaustive over
 *     ALL_TASK_ROLES: what must carry it, and what must NOT, with the complement
 *     computed rather than listed.
 * ══════════════════════════════════════════════════════════════════════════ */

import {
  DEP_INSTALL_NOTE,
  REVIEWER_TIP_DISCIPLINE,
  REVIEWER_GATE_SUITE,
  BROWSER_CONTROL_SAFETY,
} from "./project-tick.ts";

/** The constants and the budget each was written to. The budget is in the
 *  failure message because a builder who trips this needs the number, not the
 *  fact — and because a budget that lives only in a doc-comment is a budget
 *  nobody enforces.
 *
 *  ROUND 900 adds SCREENSHOT_CONVENTION, riding `drivesBrowser` exactly as
 *  BROWSER_CONTROL_SAFETY does (see its own doc-comment). Kept in this same
 *  array rather than a parallel one — it is the same shape of claim, and a
 *  second array is exactly the kind of "hand-written list" this project's
 *  standing rules keep finding rot in. */
const B5_BUDGETS = [
  ["DEP_INSTALL_NOTE", DEP_INSTALL_NOTE, 500],
  ["REVIEWER_TIP_DISCIPLINE", REVIEWER_TIP_DISCIPLINE, 1300],
  ["REVIEWER_GATE_SUITE", REVIEWER_GATE_SUITE, 1250],
  ["BROWSER_CONTROL_SAFETY", BROWSER_CONTROL_SAFETY, 900],
  ["SCREENSHOT_CONVENTION", SCREENSHOT_CONVENTION, 650],
] as const;

describe("phase 5B — the constants stay inside their stated budgets", () => {
  test("each constant is within budget", () => {
    for (const [name, text, budget] of B5_BUDGETS) {
      assert.ok(
        text.length <= budget,
        `${name} is ${text.length} characters, over its stated budget of ${budget} by ` +
          `${text.length - budget}. These blocks ride in every spawn's prompt and unbounded ` +
          "prompt growth is a real per-spawn cost (NF7). Shrink the text — do NOT widen the " +
          "budget to make your own work green; that is the one direction 00-vision.md §7 " +
          "rule 2 does not license.",
      );
    }
  });

  test("no constant is empty — the budget check's own positive control", () => {
    // A budget assertion is satisfied by the empty string. Without this, a
    // constant accidentally emptied by a bad edit would pass every length gate
    // in this file while delivering nothing.
    for (const [name, text] of B5_BUDGETS) {
      assert.ok(text.length > 200, `${name} is ${text.length} characters — that is not a rule, ` +
        "and a length budget alone would have certified it");
    }
  });
});

describe("B1 the dep-install trap is delivered through withPolicy(), to every role", () => {
  /* THE PAIR. Positive over every role on a repo-backed project; negative over
   * every role on a scratch one. See (a) in this section's header: an assertion
   * that had degenerated into grepping the constant could not pass both. */

  test("every role's prompt on a repo-backed project carries DEP_INSTALL_NOTE", () => {
    // ALL_TASK_ROLES, not a hand-written list, and not ROLES either: it is
    // ROLES plus the branchless `steward`, and it is compile-enforced through
    // `satisfies Record<TaskRole, true>`, so a role added to the union tomorrow
    // is a build error here rather than a role that silently lost the block.
    for (const repo of ["ai-os", "content-forge"] as const) {
      const proj = project({ repo });
      for (const role of ALL_TASK_ROLES) {
        assert.ok(
          buildPrompt(task({ role }), proj).includes(DEP_INSTALL_NOTE),
          `B1: role ${role} on repo '${repo}' is missing DEP_INSTALL_NOTE. The executor exports ` +
            "NODE_ENV=production, so a --frozen-lockfile install without --prod=false skips " +
            "devDependencies and exits 0, and the universal typecheck gate then dies with " +
            "`tsc: not found` while the install looks like a success (round 101)",
        );
      }
    }
  });

  test("the ROLES array the rest of this file loops is covered too", () => {
    // Stated separately because the brief names ROLES specifically. ROLES is a
    // subset of ALL_TASK_ROLES, so this cannot fail alone — it exists so that a
    // future split of the two arrays is caught rather than assumed away.
    const proj = project({ repo: "ai-os" });
    for (const role of ROLES) {
      assert.ok(
        buildPrompt(task({ role }), proj).includes(DEP_INSTALL_NOTE),
        `B1: role ${role} (ROLES) is missing DEP_INSTALL_NOTE`,
      );
    }
  });

  test("no role's prompt on a scratch project carries it", () => {
    // The negative half of the pair, and the reason B1 is gated on `live`: a
    // scratch project has no checkout to install into, so the block would name
    // a package directory that does not exist.
    const proj = project({ repo: "scratch" });
    for (const role of ALL_TASK_ROLES) {
      assert.ok(
        !buildPrompt(task({ role }), proj).includes(DEP_INSTALL_NOTE),
        `B1: role ${role} on a scratch project carries DEP_INSTALL_NOTE — there is no checkout ` +
          "to install into, and this is also the negative control that proves the positive case " +
          "above reads the BUILT PROMPT rather than the constant",
      );
    }
  });

  test("the rule states the flag, the failure and the mechanism", () => {
    for (const [what, needle] of [
      ["the corrected command", "--frozen-lockfile --prod=false"],
      ["why the default is wrong", "NODE_ENV=production"],
      ["that the bad install SUCCEEDS", "EXITS 0"],
      ["the symptom a reader will actually see", "tsc: not found"],
      ["pnpm over npm", "pnpm, never npm"],
    ] as const) {
      assert.ok(
        DEP_INSTALL_NOTE.includes(needle),
        `B1: DEP_INSTALL_NOTE no longer states ${what} (looked for "${needle}"). A rule that ` +
          "gives the fix without the symptom is a rule nobody connects to the failure they are " +
          "staring at",
      );
    }
  });
});

describe("B2/B3 the reviewer states its tip, re-reads HEAD, and runs the gate suite", () => {
  const reviewerPrompt = buildPrompt(task({ role: "reviewer" }), project({ repo: "ai-os" }));

  test("both blocks are in the reviewer's built prompt", () => {
    assert.ok(
      reviewerPrompt.includes(REVIEWER_TIP_DISCIPLINE),
      "B2: the reviewer prompt lost the tip discipline. A verdict without a tip is unfalsifiable",
    );
    assert.ok(
      reviewerPrompt.includes(REVIEWER_GATE_SUITE),
      "B3: the reviewer prompt lost the gate-suite clause. A suite run at the author's " +
        "discretion measures diligence, not the tree",
    );
  });

  test("B2 — the sha statement and the re-read-HEAD-before-blocking clause", () => {
    for (const [what, needle] of [
      ["the verdict must carry the sha", "STATE THE EXACT SHA YOU REVIEWED"],
      ["how to obtain it", "git rev-parse HEAD"],
      ["why a tipless verdict is worthless", "unfalsifiable"],
      ["HEAD is re-read before a blocker", "RE-READ HEAD IMMEDIATELY BEFORE WRITING A BLOCKER"],
      ["only that blocker is re-checked, not the whole review", "not the whole review"],
      ["why the blocker specifically", "the expensive claim"],
      ["the general rule", "ANY CLAIM ABOUT THE TREE CARRIES THE TREE-STATE IT WAS MADE AGAINST"],
    ] as const) {
      assert.ok(
        REVIEWER_TIP_DISCIPLINE.includes(needle),
        `B2: the tip discipline no longer states ${what} (looked for "${needle}"). Round 1357: a ` +
          "reviewer forked a clean checkout — the CAREFUL act — and blocked on a defect a commit " +
          "had already fixed while it read. Its verdict was true of the tree it read and false of " +
          "the tree that existed",
      );
    }
  });

  test("B3 — the suite runs before a PASS, reports EXECUTED, and is never widened", () => {
    for (const [what, needle] of [
      ["it runs before any PASS", "BEFORE ANY PASS"],
      ["with --strict", "`--strict`"],
      ["the table is pasted", "Paste its table into your review"],
      ["a suite without the flag still has an invocation", "if it takes no such flag"],
      ["a nonzero exit blocks the PASS", "BLOCKS the PASS"],
      ["the executed count is reported", "REPORT THE NUMBER OF GATES EXECUTED"],
      ["why the executed count matters", "silently stops running"],
      ["a gate is never widened to pass", "NEVER MAKE A GATE PASS BY WIDENING IT"],
      ["allowlists are scoped to the sentence", "the exact offending SENTENCE"],
      ["not to the file, not to a token", "not the file, not a bare token"],
    ] as const) {
      assert.ok(
        REVIEWER_GATE_SUITE.includes(needle),
        `B3: the gate-suite clause no longer states ${what} (looked for "${needle}")`,
      );
    }
  });

  test("B3 SATISFIABILITY — the clause has an arm for a project that ships no suite", () => {
    /* The clause most likely to become an unsatisfiable gate, and 00-vision.md
     * §7 rule 2's whole point: a reviewer left holding a gate it cannot
     * discharge learns that disclose-and-proceed is normal. So BOTH arms must be
     * present in the text — the run-it arm and the say-so-and-run-the-quality-doc
     * arm — and the text must say that those are the only two options. */
    for (const [what, needle] of [
      ["where to look for a suite", "scripts/checks/"],
      ["the glob it looks for", "gates-*.sh"],
      ["the fallback naming, for a project that names its suite elsewhere", "quality document"],
      ["the no-suite arm exists at all", "IF IT SHIPS NONE"],
      ["and is discharged by saying so", "say exactly that in your verdict"],
      ["with a substitute command block to run", "command block"],
      ["and no third option", "the only two options"],
      ["neither arm is a disclosure", "neither is a disclose-and-proceed"],
    ] as const) {
      assert.ok(
        REVIEWER_GATE_SUITE.includes(needle),
        // The failure message DESCRIBES the precedent rather than quoting the
        // phrase 03-quality.md §4 uses for it: that phrase is R49's retired
        // wording, this file lives under forge-control/, and the phase-5 gate
        // greps exactly there and requires empty output. Same discipline as
        // G1's assembled needles above.
        `B3 (satisfiability): the gate-suite clause no longer states ${what} (looked for ` +
          `"${needle}"). A gate a reviewer cannot discharge is how three rounds in a row ` +
          `learned to disclose and proceed (03-quality.md §4)`,
      );
    }
  });

  test("the builder and the planner gain no gate-suite clause", () => {
    // Explicit in the brief: B3 is the reviewer's precondition for a PASS.
    // A builder has no verdict to gate, and a planner has no tree to gate yet.
    const proj = project({ repo: "ai-os" });
    for (const role of ALL_TASK_ROLES.filter((r) => r !== "reviewer")) {
      const prompt = buildPrompt(task({ role }), proj);
      assert.ok(
        !prompt.includes(REVIEWER_GATE_SUITE),
        `B3: role ${role} carries the gate-suite clause — it belongs to the role whose PASS it ` +
          "is a precondition of",
      );
      assert.ok(
        !prompt.includes(REVIEWER_TIP_DISCIPLINE),
        `B2: role ${role} carries the reviewer tip discipline`,
      );
    }
  });

  test("both blocks precede the VERDICT sentence they are preconditions of", () => {
    // The defect class round 239 caught only by reading its built prompt aloud:
    // two clauses a `.includes()` gate both finds, in the wrong order. A rule
    // printed after the instruction it constrains reads as an afterthought.
    const verdictAt = reviewerPrompt.indexOf('exactly with "VERDICT: PASS"');
    assert.ok(verdictAt > 0, "the VERDICT sentence could not be located — this case's own control");
    assert.ok(
      reviewerPrompt.indexOf(REVIEWER_TIP_DISCIPLINE) < verdictAt,
      "B2: the tip discipline is printed after the VERDICT instruction it constrains",
    );
    assert.ok(
      reviewerPrompt.indexOf(REVIEWER_GATE_SUITE) < verdictAt,
      "B3: the gate-suite clause is printed after the VERDICT instruction it gates",
    );
  });
});

describe("B4 the browser rules reach exactly the derived role set", () => {
  const proj = project({ repo: "ai-os" });

  /* THE ROLE SET IS DERIVED, AND ASSERTED ANYWAY, and the two together are the
   * point. `withPolicy()` attaches BROWSER_CONTROL_SAFETY wherever the body
   * already carries BROWSER_FIRST or RESEARCH_INSTRUMENTS — never from a
   * hand-written list of "browser-driving roles", because a hand-written list is
   * exactly how a role added later loses a policy block. The derivation alone
   * would be untestable drift, though: if someone gave every role BROWSER_FIRST
   * tomorrow, the block would silently reach all eight. So this case asserts the
   * CONCRETE membership as well, and computes its complement rather than listing
   * it (failure (d) in this section's header).
   *
   * TESTER IS IN, from round 242 (finding F-E). Round 240 reported the gap
   * rather than closing it — the tester's branch carried neither constant, so
   * the derivation excluded it while its own prompt sent it at "the real
   * surface (browser, CLI, API)" — and the operator ruled the obvious way: give
   * the tester BROWSER_FIRST. The DERIVATION did not change, which is the
   * point; the branch joined the set it computes over, and the block followed
   * by construction. The tester is also the role most likely to repeat round
   * 1873's incident, because clicking what a user would click is its job. */
  const EXPECTED_BROWSER_ROLES = ["builder", "researcher", "scout", "tester"] as const;

  test("the derivation and the membership agree", () => {
    const carriesABrowserBlock = ALL_TASK_ROLES.filter((role) => {
      const prompt = buildPrompt(task({ role }), proj);
      return prompt.includes(BROWSER_FIRST) || prompt.includes(RESEARCH_INSTRUMENTS);
    });
    assert.deepEqual(
      [...carriesABrowserBlock].sort(),
      [...EXPECTED_BROWSER_ROLES].sort(),
      "B4: the set of roles carrying BROWSER_FIRST or RESEARCH_INSTRUMENTS has changed. That is " +
        "not necessarily wrong — but the browser-control rules follow that set by construction, " +
        "so a change here silently changes who is told not to click a running row. Confirm the " +
        "new member should have it, then amend this list with the reason",
    );
  });

  test("every role in the set receives BROWSER_CONTROL_SAFETY", () => {
    for (const role of EXPECTED_BROWSER_ROLES) {
      assert.ok(
        buildPrompt(task({ role }), proj).includes(BROWSER_CONTROL_SAFETY),
        `B4: role ${role} drives a browser and is missing the run-control rules. Round 1873: a ` +
          "verification script clicked confirm on a row that had gone from settled to running " +
          "between two executions, and terminated the operator's own run",
      );
    }
  });

  test("no other role receives it — the complement, computed", () => {
    for (const role of ALL_TASK_ROLES.filter(
      (r) => !(EXPECTED_BROWSER_ROLES as readonly string[]).includes(r),
    )) {
      assert.ok(
        !buildPrompt(task({ role }), proj).includes(BROWSER_CONTROL_SAFETY),
        `B4: role ${role} carries the browser-control rules but drives no browser — prompt bloat ` +
          "with no matching behaviour, and the negative control that proves the positive cases " +
          "above read the built prompt rather than the constant",
      );
    }
  });

  test("a scratch project's browser roles keep the rules", () => {
    // Deliberately NOT gated on `live`, unlike B1: a scratch project's builder
    // can still drive the fleet's own control panel, and the row it clicks is
    // just as live.
    const scratch = project({ repo: "scratch" });
    for (const role of EXPECTED_BROWSER_ROLES) {
      assert.ok(
        buildPrompt(task({ role }), scratch).includes(BROWSER_CONTROL_SAFETY),
        `B4: scratch ${role} lost the browser-control rules — the panel it can reach is the same one`,
      );
    }
  });

  test("all three rules and the general one are stated", () => {
    for (const [what, needle] of [
      ["the run-control endpoints are stubbed too", "POST /runs/:id/stop and POST /runs/:id/terminate"],
      ["why stubbing what you mean to exercise is not enough", "DIFFERENT endpoints depending on the row's state"],
      ["never click a row that is not settled", "NEVER drive a confirm or an X on a row that is not settled"],
      ["the assertion is immediately before the click", "IMMEDIATELY BEFORE the click"],
      ["and not once at the start", "never once at script start"],
      ["row state is re-asserted between runs", "RE-ASSERT ROW STATE BETWEEN RUNS"],
      ["the general rule", "BLAST RADIUS CHANGES WHERE THE CODE DOES NOT"],
      ["its four inputs", "(code, capability flags, store scope, live row state)"],
      ["and that only one of them is reviewable", "only the first appears in a diff"],
    ] as const) {
      assert.ok(
        BROWSER_CONTROL_SAFETY.includes(needle),
        `B4: BROWSER_CONTROL_SAFETY no longer states ${what} (looked for "${needle}")`,
      );
    }
  });
});

describe("round 900 — SCREENSHOT_CONVENTION reaches exactly the same derived role set as B4", () => {
  /* operator-visibility phase 6's OPEN ITEM (docs/plan/artifacts/phase1350/
   * browser-visibility.md §3): only the researcher was ever told where to put
   * a screenshot so the Console can render it, so every builder/reviewer
   * screenshot taken with the playwright-skill went to /tmp and every
   * operator screenshot went wherever its own tool defaulted — both
   * unservable and both invisible to Konrad. Fixed by riding the SAME
   * `drivesBrowser` predicate B4 already computes (see withPolicy()'s own
   * comment), not a second hand-written list — so this suite reuses B4's
   * EXPECTED_BROWSER_ROLES rather than declaring its own, on the same
   * argument (d) in this file's header makes: a role-set test that only
   * checks presence would pass even if the two blocks silently diverged. */
  const proj = project({ repo: "ai-os" });
  const EXPECTED_SCREENSHOT_ROLES = ["builder", "researcher", "scout", "tester"] as const;

  test("the role set is identical to B4's — one predicate, two blocks", () => {
    const carriesABrowserBlock = ALL_TASK_ROLES.filter((role) => {
      const prompt = buildPrompt(task({ role }), proj);
      return prompt.includes(BROWSER_FIRST) || prompt.includes(RESEARCH_INSTRUMENTS);
    });
    assert.deepEqual(
      [...carriesABrowserBlock].sort(),
      [...EXPECTED_SCREENSHOT_ROLES].sort(),
      "round 900: the derived browser-driving role set no longer matches B4's — SCREENSHOT_CONVENTION " +
        "and BROWSER_CONTROL_SAFETY ride the same predicate and must always agree",
    );
  });

  test("every role in the set receives SCREENSHOT_CONVENTION", () => {
    for (const role of EXPECTED_SCREENSHOT_ROLES) {
      assert.ok(
        buildPrompt(task({ role }), proj).includes(SCREENSHOT_CONVENTION),
        `round 900: role ${role} drives a browser and is missing the screenshot directory convention — ` +
          "its shots would go wherever its own tool defaults, unservable to the Console",
      );
    }
  });

  test("no other role receives it — the complement, computed", () => {
    for (const role of ALL_TASK_ROLES.filter(
      (r) => !(EXPECTED_SCREENSHOT_ROLES as readonly string[]).includes(r),
    )) {
      assert.ok(
        !buildPrompt(task({ role }), proj).includes(SCREENSHOT_CONVENTION),
        `round 900: role ${role} carries the screenshot convention but drives no browser — prompt ` +
          "bloat with no matching behaviour",
      );
    }
  });

  test("a scratch project's browser roles keep the convention", () => {
    const scratch = project({ repo: "scratch" });
    for (const role of EXPECTED_SCREENSHOT_ROLES) {
      assert.ok(
        buildPrompt(task({ role }), scratch).includes(SCREENSHOT_CONVENTION),
        `round 900: scratch ${role} lost the screenshot convention — a scratch project's browser is ` +
          "the same one, uploads directory included",
      );
    }
  });

  test("the directory, FORGE_RUN_ID, and the reason are all stated", () => {
    for (const [what, needle] of [
      ["the literal on-disk pattern", "/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png"],
      ["never /tmp", "never /tmp"],
      ["the playwright-skill's own default is named", "playwright-skill's own default"],
      ["the reason: shots outside the directory are unservable", "invisible to Konrad and gone at the next reboot"],
    ] as const) {
      assert.ok(
        SCREENSHOT_CONVENTION.includes(needle),
        `round 900: SCREENSHOT_CONVENTION no longer states ${what} (looked for "${needle}")`,
      );
    }
  });

  test("SCREENSHOT_CONVENTION is delivered alongside BROWSER_CONTROL_SAFETY, before ESCALATION_POLICY", () => {
    const prompt = buildPrompt(task({ role: "builder" }), project({ repo: "ai-os", metadata: {} }));
    assert.ok(
      prompt.indexOf(BROWSER_CONTROL_SAFETY) < prompt.indexOf(SCREENSHOT_CONVENTION),
      "round 900: SCREENSHOT_CONVENTION must follow BROWSER_CONTROL_SAFETY, matching withPolicy()'s order",
    );
    assert.ok(
      prompt.indexOf(SCREENSHOT_CONVENTION) < prompt.indexOf(ESCALATION_POLICY),
      "round 900: SCREENSHOT_CONVENTION must precede ESCALATION_POLICY, like every other withPolicy() rider",
    );
  });
});

describe("phase 5B — the delivery path is the funnel, not a branch", () => {
  /* The claim this whole section rests on, asserted rather than assumed. B1 and
   * B4 are delivered by `withPolicy()`, which is what makes them unforgettable;
   * if a future edit moved either into individual role branches, every
   * membership test above would keep passing while the property the operator
   * asked for — "a role branch added at 3am cannot lose it" — would be gone.
   *
   * Asserted through a role with NO branch of its own. `steward` falls straight
   * through to `return withPolicy(header)`, so the only path by which its prompt
   * can contain DEP_INSTALL_NOTE is the wrapper. */
  test("the branchless role still receives B1 — so the wrapper is delivering it", () => {
    const stewardPrompt = buildPrompt(task({ role: "steward" }), project({ repo: "ai-os" }));
    assert.ok(
      stewardPrompt.includes(DEP_INSTALL_NOTE),
      "B1 is not coming from withPolicy(): steward has no branch in buildPrompt, so if it lacks " +
        "the note the delivery has been moved into the role branches — where the next role added " +
        "will not have it. That is the failure this shape exists to prevent",
    );
    assert.ok(
      stewardPrompt.includes(ESCALATION_POLICY) && stewardPrompt.includes(WORKTREE_POLICY("/opt/forge-ai-os")),
      "the control: steward's prompt is built through withPolicy() at all",
    );
  });

  test("B1 is delivered BEFORE ESCALATION_POLICY, which must stay the last block", () => {
    // cp3-linkage.test.ts asserts an unlinked prompt ENDS with ESCALATION_POLICY
    // — load-bearing evidence for the comms gate (08 §4 acceptance). Ordering
    // B1 after it would have broken that in another file; stating the
    // dependency here means the next reader of THIS file sees it too.
    const prompt = buildPrompt(task({ role: "builder" }), project({ repo: "ai-os", metadata: {} }));
    assert.ok(prompt.endsWith(ESCALATION_POLICY), "B1/B4 changed where an unlinked prompt ends");
    assert.ok(
      prompt.indexOf(DEP_INSTALL_NOTE) < prompt.indexOf(ESCALATION_POLICY),
      "B1 must precede ESCALATION_POLICY",
    );
    assert.ok(
      prompt.indexOf(BROWSER_CONTROL_SAFETY) < prompt.indexOf(ESCALATION_POLICY),
      "B4 must precede ESCALATION_POLICY",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ROUND 242 — FIX CYCLE 1 on round 241's phase-5 gating review.
 *
 * Built on fe14a7ebf0a48b46bc46fe1797f96f07d1ff5504 (phase 5B, round 240),
 * which is the tip round 241 reviewed and named.
 *
 * Three findings, and where each is answered:
 *   1. the NON-goal architect branch — this section, below. R53 falsified its
 *      ordering sentence and phase 5 did not update it: it still named a round
 *      that taskCurl() no longer sends, and it never carried GRAPH_GUIDE, so it
 *      handed an architect three unexplained fields and one dead instruction.
 *   2. the fixture measured NF7 at `id: "p1"` — answered IN PLACE in the "NF7
 *      the prompt budget" block above, marked ROUND 242 with the re-derivation
 *      table, and by MAXIMAL_PROJECT_ID + the uuid-shape control in
 *      maximalPlannerPrompt().
 *   3. GRAPH_GUIDE named no research role literal — answered in project-tick.ts
 *      and asserted here under "R48/finding 3".
 *
 * APPENDED ONLY, with THREE DECLARED EXCEPTIONS, all in the NF7 block and all
 * amendments to a pin or to an instrument that a second spender falsified —
 * no test is deleted and no assertion is weakened:
 *   1. BASELINE 9187 -> 9221, re-derived by the method its own comment
 *      prescribes, over three `git archive` trees with distinct digests and an
 *      export positive control. RAISES the cap by 34 and changes the gate's
 *      tightness by NOTHING: the same +34 lands on every measurement taken at
 *      this fixture, so headroom is identical at every pin and BUDGET is
 *      untouched at 3050. The FRAME moved, not the allowance. (Round 242 wrote
 *      this as "TIGHTENS the cap by 34", which is backwards twice over — the cap
 *      rises, and a rising cap is the direction that needs the argument above
 *      rather than the word. Corrected at round 244; the argument is in the NF7
 *      block, beside the measurement that settles it.)
 *   2. maximalPlannerPrompt() gains `id: MAXIMAL_PROJECT_ID` and a fifth
 *      maximality control asserting the id is uuid-shaped.
 *   3. "the headroom builder 5B needs is actually there" -> the round ledger.
 *      The old shape charged THIS round's 26 characters to 5B's reservation and
 *      would have passed at 502 <= 600, reporting a 5B underspend that never
 *      happened. Replaced by an EXACT attribution of every character since the
 *      5A tip, which is strictly stronger: the old case bounded a sum, this one
 *      admits no unledgered character at all.
 *
 * ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ─────────────────
 *
 * (a) "The non-goal cases pass because the fixture is secretly goal-mode, so
 *     they are re-testing the branch that was already correct." The whole
 *     finding is that TWO branches exist and only one was fixed. Every case
 *     below therefore runs the PAIR — the same assertion over the goal project
 *     and the non-goal one — and additionally asserts the two prompts DIFFER,
 *     so a fixture that had collapsed into one branch fails instead of
 *     certifying twice.
 * (b) "`doesNotMatch(/round right after/)` passes because the sentence was
 *     reworded rather than replaced, and the branch still orders by round." An
 *     absence proves nothing on its own — this is the empty-file failure in
 *     prose form. Each absence below is paired with the POSITIVE that must be
 *     true instead (the dependency join), so a branch that merely deleted the
 *     sentence and taught nothing fails.
 * (c) "The GRAPH_GUIDE delivery assertion passes against a hand-copied
 *     substring." It takes the whole exported constant, per this file's header.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("round 242 finding 1 — the NON-goal architect schedules by dependency, not by round", () => {
  const nonGoalProject = project({ repo: "ai-os" });
  const nonGoal = buildPrompt(task({ role: "architect" }), nonGoalProject);
  const goal = buildPrompt(task({ role: "architect" }), goalProject);

  test("the two architect branches are genuinely distinct — the pair's own control", () => {
    // (a) above. Without this, every case in this describe could be passing by
    // measuring the goal branch twice.
    // `isGoalMode()` is module-private, so the fixture is checked against the
    // one thing it reads — metadata.mode — rather than re-implementing it.
    assert.notEqual(
      (nonGoalProject.metadata as { mode?: string } | null)?.mode,
      "goal",
      "the non-goal fixture carries goal metadata, so this whole section re-tests the branch " +
        "that was already correct",
    );
    assert.equal(
      (goalProject.metadata as { mode?: string } | null)?.mode,
      "goal",
      "the goal fixture is not goal-mode either, so the pair compares two non-goal prompts",
    );
    assert.notEqual(
      nonGoal,
      goal,
      "buildPrompt returns the same string for a goal and a non-goal architect — the two " +
        "branches have collapsed into one and the pairing below proves nothing",
    );
  });

  test("it carries GRAPH_GUIDE, as the goal branch already did", () => {
    assert.ok(
      nonGoal.includes(GRAPH_GUIDE),
      "R53/R47: the non-goal architect creates tasks — taskCurl() hands it depends_on, " +
        "workstream and write_set — and was never taught what any of them mean. An architect " +
        "given three unexplained fields omits them: round absent computes to 0, depends_on " +
        "absent stores the legacy NULL sentinel, and the reviewer promotes in the same tick as " +
        "the builders it must join and reviews an empty diff",
    );
    assert.ok(goal.includes(GRAPH_GUIDE), "the pair's positive half: the goal branch still has it");
  });

  test("the falsified round sentence is gone, and the join is what replaced it", () => {
    // (b) above: the absence and the positive that must hold instead, together.
    assert.doesNotMatch(
      nonGoal,
      /round right after/,
      "R53: the non-goal architect is still told to put its reviewer in the round right after " +
        "its last builder round. taskCurl() sends no round field, so the instruction is not " +
        "merely stale — it is unexecutable, and an architect resolving it drops the graph fields",
    );
    assert.doesNotMatch(
      nonGoal,
      /round\(s\) of work/,
      "R53: the branch still describes what it creates as rounds of work",
    );
    assert.ok(
      nonGoal.includes('"reviewer" task DEPENDING ON every builder you created'),
      "R47: deleting the round sentence is half the fix. The branch must state the join that " +
        "replaces it, or it teaches nothing and the architect invents its own ordering",
    );
    assert.ok(
      nonGoal.includes("the join, not a round number"),
      "R47: the join is stated but not contrasted with the round it replaces — the planner " +
        "branch makes that contrast explicitly and this branch reaches the same reader",
    );
  });

  test("neither architect branch names a round the engine will not read", () => {
    // The goal branch keeps exactly one hand-written round, R51's phase label,
    // and "G4 negative" above already asserts it does not leak here. This is the
    // other direction: the goal branch must not have picked up the dead sentence.
    assert.doesNotMatch(goal, /round right after/, "R53: the goal branch grew the dead sentence");
  });
});

describe("round 242 finding 3 — the research fan-out no longer needs an invented role literal", () => {
  test("R48/finding 3 — FAN-OUT names the two research roles", () => {
    assert.ok(
      GRAPH_GUIDE.includes('one "researcher" (or "scout") task each'),
      "R48: the FAN-OUT sentence sells research fan-out as the cheapest parallelism there is " +
        "and then names no role string for it. `builder` is in the curl and `reviewer` is in " +
        "the join sentence, so research was the ONE construct a planner had to guess at and " +
        "recover from the 400 that enumerates ROLES",
    );
  });

  test("both literals are roles the API will actually accept", () => {
    /* THE GATE THAT MAKES THE ABOVE WORTH ANYTHING. Naming a role literal in a
     * prompt is only an improvement if the route accepts it; naming one it
     * rejects would teach a call that 400s, which is worse than the guess it
     * replaced. ROLES lives in routes/projects.ts, so this reads that file's
     * source rather than importing the route module (which would pull in the
     * pool). The positive control on the read comes first — an empty or wrong
     * read makes every `includes` below pass vacuously. */
    const routesSrc = readFileSync(
      fileURLToPath(new URL("../routes/projects.ts", import.meta.url)),
      "utf8",
    );
    assert.match(
      routesSrc,
      /const ROLES\b/,
      "POSITIVE CONTROL FAILED: routes/projects.ts was read but declares no ROLES — the read is " +
        "empty or points at the wrong file, and both assertions below would pass vacuously",
    );
    for (const role of ["researcher", "scout"] as const) {
      assert.ok(
        new RegExp(`"${role}"`).test(routesSrc),
        `R48: GRAPH_GUIDE now tells planners to create "${role}" tasks, but routes/projects.ts ` +
          "does not list it in ROLES — the prompt would teach a call the API refuses with a 400, " +
          "which is strictly worse than the guess it was written to remove",
      );
    }
  });
});
