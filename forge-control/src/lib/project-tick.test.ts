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
 * hoping. RESEARCH_INSTRUMENTS names them, states the screenshot convention and
 * the login-wall protocol.
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
    assert.ok(
      RESEARCH_INSTRUMENTS.includes("/opt/ai-os/uploads/$FORGE_RUN_ID/<timestamp>-<label>.png"),
      "the on-disk screenshot convention must be stated literally",
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

  test("the pool/browser default is stated as key-free — the whole point of R702", () => {
    assert.match(
      RESEARCH_INSTRUMENTS,
      /none of them needs a key by default/,
      "a researcher that believes it needs keys will not try the instruments at all",
    );
    // gemini-qa's default backend really is the free pool.
    assert.ok(
      help(SCRIPTS.geminiQa).includes("default: pool"),
      "gemini-qa's default backend is no longer the pool",
    );
    // perplexity's ask really does default to the browser.
    assert.match(
      help(SCRIPTS.perplexity),
      /Default backend: browser/,
      "perplexity ask no longer defaults to the browser backend",
    );
  });
});
