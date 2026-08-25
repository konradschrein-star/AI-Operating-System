/**
 * P1-1, engine half: an ENABLED guardrail rule with no specific evaluator
 * BLOCKS, whatever its config says.
 *
 * Run: pnpm test   (node --test via tsx — the script globs src/lib/*.test.ts,
 * which is why a test for src/db/autonomy.ts lives in this directory, exactly
 * as autonomy-gemini-cap.test.ts already does. A file placed in src/db/ or
 * src/routes/ would never be executed by gate 8 of scripts/checks/gates-808.sh.)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * The default branch of `evaluateRule` used to read:
 *
 *     if (Object.keys(cfg).length === 0 && rule.enabled) {
 *       if (payload.bypass_blanket === true) return { blocked: false };
 *       return { blocked: true, reason: `${rule.label} is enabled` };
 *     }
 *     return { blocked: false };
 *
 * — a blanket block ONLY while the config stayed empty. `fs.destructive`,
 * `comm.outbound`, `deploy.prod` and `secrets.read` all ride that branch, so
 * one unauthenticated call measured in round 0:
 *
 *     POST /api/autonomy/rules/fs.destructive  {"config":{"note":"x"}}
 *
 * ended enforcement for all four while the Autonomy console still rendered the
 * rules as ENABLED. The `{note:'x'}` case below is that regression, and it is
 * the assertion that FAILS against the old code — proved by re-running this
 * matrix against a scratch copy carrying the old condition; the transcript is
 * quoted in docs/plan/aios-guardrail-hardening/01-engine.md.
 *
 * `evaluateRule` takes its Gemini usage reading as an argument and touches no
 * pg client, so this file needs no database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRule,
  hookAgentLabel,
  normalizeChangeSource,
  RULE_CHANGE_SOURCES,
  type GuardrailRule,
  type GuardrailContext,
} from "../db/autonomy.ts";

const NO_CTX: GuardrailContext = { geminiDaily: null };

/** A rule row as `guardrail_rules` actually stores one. */
function rule(over: Partial<GuardrailRule> & Pick<GuardrailRule, "id">): GuardrailRule {
  return {
    label: over.id,
    description: "",
    category: "destructive",
    enabled: true,
    builtin: true,
    config: {},
    updated_at: "2026-06-18T20:05:02.000Z",
    ...over,
  };
}

/* ========================================================================== *
 * 1. The blanket branch: enabled means blocked, whatever the config
 * ========================================================================== */

describe("evaluateRule — the catch-all branch", () => {
  test("enabled + empty config blocks (unchanged behaviour)", () => {
    const r = evaluateRule(
      rule({ id: "fs.destructive", label: "Destructive file ops", config: {} }),
      {},
      NO_CTX,
    );
    assert.equal(r.blocked, true);
    assert.match(String(r.reason), /Destructive file ops is enabled/);
  });

  test("THE REGRESSION: enabled + {note:'x'} still blocks", () => {
    // This is the exact body of the round-0 P1-1 demonstration. Against the
    // old `Object.keys(cfg).length === 0` condition this returns
    // { blocked: false } and this assertion fails.
    const r = evaluateRule(
      rule({ id: "fs.destructive", label: "Destructive file ops", config: { note: "x" } }),
      {},
      NO_CTX,
    );
    assert.equal(
      r.blocked,
      true,
      "a config patch must not be able to disable enforcement",
    );
  });

  test("every rule that rides this branch behaves the same way", () => {
    // Named individually rather than looped over a shared fixture: these four
    // ids are what the branch actually protects on this box, and a rename of
    // any of them should show up here as a failure, not as a silent pass.
    for (const id of [
      "fs.destructive",
      "comm.outbound",
      "deploy.prod",
      "secrets.read",
    ]) {
      assert.equal(
        evaluateRule(rule({ id, config: { note: "x", cap: 5 } }), {}, NO_CTX).blocked,
        true,
        `${id} must block with a non-empty config`,
      );
    }
  });

  test("a config with a plausible-looking key does not open it either", () => {
    // The failure mode this defends: someone patches in a key that LOOKS like
    // it should be understood, and the engine quietly stops enforcing because
    // no case matches it.
    for (const config of [
      { enabled: false },
      { allow: true },
      { bypass_blanket: true },
      { protected_branches: [] },
      { max: 0 },
    ]) {
      assert.equal(
        evaluateRule(rule({ id: "fs.destructive", config }), {}, NO_CTX).blocked,
        true,
        `config ${JSON.stringify(config)} must not disable the rule`,
      );
    }
  });

  test("disabled allows, whatever the config", () => {
    for (const config of [{}, { note: "x" }]) {
      assert.equal(
        evaluateRule(
          rule({ id: "fs.destructive", enabled: false, config }),
          {},
          NO_CTX,
        ).blocked,
        false,
      );
    }
  });
});

/* ========================================================================== *
 * 2. bypass_blanket: the ONE escape, and it is strict
 * ========================================================================== */

describe("evaluateRule — bypass_blanket", () => {
  test("payload.bypass_blanket === true allows", () => {
    assert.equal(
      evaluateRule(
        rule({ id: "fs.destructive", config: {} }),
        { bypass_blanket: true },
        NO_CTX,
      ).blocked,
      false,
    );
  });

  test("it still allows when the config is non-empty", () => {
    assert.equal(
      evaluateRule(
        rule({ id: "fs.destructive", config: { note: "x" } }),
        { bypass_blanket: true },
        NO_CTX,
      ).blocked,
      false,
    );
  });

  test("only the boolean opens it — a hook payload is strings and JSON", () => {
    // The hook builds its own payload from agent-controlled strings. Anything
    // that survives `JSON.parse` and is not the boolean must stay blocked.
    for (const value of ["true", "True", 1, {}, [true], "1", null]) {
      assert.equal(
        evaluateRule(
          rule({ id: "fs.destructive", config: {} }),
          { bypass_blanket: value },
          NO_CTX,
        ).blocked,
        true,
        `bypass_blanket=${JSON.stringify(value)} must not open the branch`,
      );
    }
  });
});

/* ========================================================================== *
 * 3. The rules WITH a specific evaluator are untouched
 * ========================================================================== */

describe("evaluateRule — specific evaluators are unchanged", () => {
  const forcePush = (branch: string, protectedBranches: string[]) =>
    evaluateRule(
      rule({
        id: "git.force_push",
        label: "Force push",
        category: "destructive",
        config: { protected_branches: protectedBranches },
      }),
      { branch },
      NO_CTX,
    );

  test("a protected branch blocks", () => {
    assert.equal(forcePush("main", ["main", "master"]).blocked, true);
    assert.match(String(forcePush("main", ["main"]).reason), /force-push to 'main'/);
  });

  test("an unprotected branch is ALLOWED — the branch decides, not the catch-all", () => {
    // The load-bearing half of the change: git.force_push has its own case, so
    // it must NOT fall into the new blanket block. If the case were ever
    // deleted, this assertion flips to blocked and every project lane push
    // would be refused.
    assert.equal(forcePush("project/b167b94e-engine", ["main", "master"]).blocked, false);
    assert.equal(forcePush("", ["main"]).blocked, false);
  });

  test("a git.force_push rule with an EMPTY config allows every branch", () => {
    // Same point from the other side: an empty config no longer means "blanket
    // block" for a rule that has its own evaluator.
    assert.equal(forcePush("main", []).blocked, false);
  });

  test("runtime.pause_all blocks everything when enabled", () => {
    assert.equal(
      evaluateRule(rule({ id: "runtime.pause_all", config: {} }), {}, NO_CTX).blocked,
      true,
    );
  });

  test("agent.spawn_cap compares against config.max", () => {
    const cap = (active: number) =>
      evaluateRule(
        rule({ id: "agent.spawn_cap", config: { max: 4 } }),
        { active_workers: active },
        NO_CTX,
      ).blocked;
    assert.equal(cap(3), false);
    assert.equal(cap(4), true);
  });

  test("spend.daily_cap (EUR side) compares against config.cap_eur", () => {
    const spend = (eur: number) =>
      evaluateRule(
        rule({ id: "spend.daily_cap", category: "financial", config: { cap_eur: 10 } }),
        { daily_spend_eur: eur },
        NO_CTX,
      ).blocked;
    assert.equal(spend(9.99), false);
    assert.equal(spend(10.01), true);
  });

  test("spend.per_run_cap is DEAD CODE and must not be re-seeded", () => {
    // The rule row was deleted from guardrail_rules on 2026-08-25 at Konrad's
    // instruction. The case survives only so a re-seeded row would evaluate
    // instead of blanket-blocking; this asserts that fallback, it does not
    // endorse the rule.
    assert.equal(
      evaluateRule(
        rule({ id: "spend.per_run_cap", category: "financial", config: {} }),
        { tokens: 1_000 },
        NO_CTX,
      ).blocked,
      false,
      "a re-seeded per-run cap must evaluate tokens, not blanket-block",
    );
  });
});

/* ========================================================================== *
 * 4. Attribution: a trip must name the agent that tried it
 * ========================================================================== */

describe("hookAgentLabel", () => {
  test("a resolved role is appended", () => {
    assert.equal(hookAgentLabel("bash-hook", "builder"), "bash-hook:builder");
    assert.equal(hookAgentLabel("bash-hook", "reviewer"), "bash-hook:reviewer");
  });

  test("no role leaves the bare label rather than inventing one", () => {
    // Chat and telegram runs carry no metadata.role, and the lookup is allowed
    // to fail. "bash-hook:" or "bash-hook:unknown" would both read as data.
    assert.equal(hookAgentLabel("bash-hook", undefined), "bash-hook");
    assert.equal(hookAgentLabel("bash-hook", ""), "bash-hook");
    assert.equal(hookAgentLabel("bash-hook", "   "), "bash-hook");
  });

  test("a non-hook agent is never rewritten", () => {
    assert.equal(hookAgentLabel("forge-executor", "builder"), "forge-executor");
    assert.equal(hookAgentLabel("ai-os:probe", "builder"), "ai-os:probe");
  });

  test("the result fits guardrail_trips.agent — varchar(64)", () => {
    // An over-long label would abort the INSERT, and an aborted INSERT turns an
    // attributed block into no block at all.
    const long = hookAgentLabel("bash-hook", "x".repeat(200));
    assert.equal(long.length, 64);
    assert.equal(hookAgentLabel("y".repeat(200), undefined).length, 64);
  });
});

/* ========================================================================== *
 * 5. Audit source normalisation
 * ========================================================================== */

describe("normalizeChangeSource", () => {
  test("the three known surfaces pass through", () => {
    for (const s of RULE_CHANGE_SOURCES) {
      assert.equal(normalizeChangeSource(s), s);
    }
    assert.equal(normalizeChangeSource("CONSOLE"), "console");
    assert.equal(normalizeChangeSource("  deploy  "), "deploy");
  });

  test("anything else is recorded as 'api', not as itself", () => {
    // The header is caller-supplied. A run that claims `x-forge-source:
    // konrads-phone` must not get to write that string into the audit log — it
    // hit the HTTP endpoint, so it is 'api'.
    for (const raw of ["konrads-phone", "", "console;api", undefined, null, 7, {}]) {
      assert.equal(normalizeChangeSource(raw), "api");
    }
  });
});
