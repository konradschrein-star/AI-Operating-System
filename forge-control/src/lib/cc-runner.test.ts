/**
 * T17 — the run id must reach the child process (R703).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The whole research-lane screenshot convention hangs off ONE environment
 * variable. `scripts/research-browser.mjs`, `scripts/perplexity.mjs` and
 * `scripts/gemini-qa.mjs` resolve their upload directory as `--run-id`, else
 * `$FORGE_RUN_ID`, else an ad-hoc sentinel — and until R703 the executor never
 * exported it, so every screenshot a run took landed in the shared
 * `deadbeefcafe` bucket with nothing tying it back to the run. A prompt that
 * tells a researcher to write to `/opt/ai-os/uploads/$FORGE_RUN_ID/` while the
 * variable is unset is worse than no instruction at all.
 *
 * These tests do not mock spawn(). CC_BIN is read from the environment at
 * module load, so the module is imported dynamically AFTER pointing CC_BIN at a
 * stub that reports its own environment back — the assertion is therefore about
 * the real child process, which is the only thing that was ever in doubt.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cc-runner-test-"));
const stub = join(tmp, "fake-claude.sh");
const captured = join(tmp, "child-env.txt");

/** A stand-in for the `claude` CLI: records the run-identity variables it was
 *  given, drains stdin (the prompt) so the parent never sees EPIPE, and emits
 *  one stream-json result line so runClaudeCode resolves normally. */
writeFileSync(
  stub,
  `#!/bin/sh
cat > /dev/null
{
  echo "FORGE_RUN_ID=\${FORGE_RUN_ID-<unset>}"
  echo "FORGE_RUN_UUID=\${FORGE_RUN_UUID-<unset>}"
} > "$CC_RUNNER_TEST_CAPTURE"
echo '{"type":"result","subtype":"success","result":"ok","session_id":"sess-1","total_cost_usd":0,"num_turns":1}'
`,
  { mode: 0o755 },
);
chmodSync(stub, 0o755);

process.env.CC_BIN = stub;
process.env.CC_RUNNER_TEST_CAPTURE = captured;
// The stub ignores its arguments, but keep the child cheap and side-effect-free.
process.env.CC_ADD_DIRS = "";

const { runClaudeCode, uploadsRunId, UPLOADS_RUN_ID_RE } = await import("./cc-runner.ts");

/** One stub run; returns what the child saw in its own environment. */
async function childEnv(runId?: string | null): Promise<Record<string, string>> {
  writeFileSync(captured, "");
  const res = await runClaudeCode({
    prompt: "hello",
    timeoutMs: 30_000,
    runId,
    vaultAccess: false,
    onEvent: () => {},
  });
  assert.equal(res.text, "ok", "stub run should resolve through the normal result path");
  const out: Record<string, string> = {};
  for (const line of readFileSync(captured, "utf8").trim().split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("T17 uploadsRunId — the servable form of a run id", () => {
  test("a runs.id UUID becomes its first 12 hex characters", () => {
    assert.equal(uploadsRunId("ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f"), "ece63bdb1f2a");
    assert.match(uploadsRunId("ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f"), UPLOADS_RUN_ID_RE);
  });

  test("the result is always servable by GET /api/uploads/:id/:name", () => {
    // The route's own gate: /^[a-f0-9]{12}$/, 400 for anything else. Uppercase
    // and dashes are the two shapes a caller realistically passes.
    for (const id of [
      "ECE63BDB-1F2A-4C3D-9E8F-0A1B2C3D4E5F",
      "00000000-0000-4000-8000-000000000000",
      "abcdefabcdef",
    ]) {
      assert.match(uploadsRunId(id), UPLOADS_RUN_ID_RE, `${id} produced an unservable id`);
    }
  });

  test("an id that cannot yield 12 hex characters throws with diagnostics", () => {
    // No silent sentinel: screenshots filed under a directory belonging to no
    // run are indistinguishable from ad-hoc ones taken by a human at a shell.
    assert.throws(
      () => uploadsRunId("zzz-not-a-uuid"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // "zzz-not-a-uuid" contributes two hex characters (the two 'a's) —
        // the message must report what it actually found, not a round zero.
        assert.match((err as Error).message, /only 2 hex characters/);
        assert.match((err as Error).message, /api\/uploads/);
        return true;
      },
    );
    assert.throws(() => uploadsRunId(""), /cannot derive an uploads-servable run id/);
  });
});

describe("T17 the child process carries the run id", () => {
  test("FORGE_RUN_ID is the servable form; FORGE_RUN_UUID is the run id verbatim", async () => {
    const runId = "ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f";
    const env = await childEnv(runId);
    assert.equal(
      env.FORGE_RUN_ID,
      "ece63bdb1f2a",
      "the research instruments read FORGE_RUN_ID and nothing else",
    );
    assert.equal(env.FORGE_RUN_UUID, runId);
  });

  test("no runId means no inherited run identity — never another run's id", async () => {
    // The executor always passes one; a one-off script may not. Inheriting the
    // parent's value would file this run's screenshots under a foreign run.
    process.env.FORGE_RUN_ID = "ffffffffffff";
    process.env.FORGE_RUN_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    try {
      const env = await childEnv(null);
      assert.equal(env.FORGE_RUN_ID, "<unset>");
      assert.equal(env.FORGE_RUN_UUID, "<unset>");
    } finally {
      delete process.env.FORGE_RUN_ID;
      delete process.env.FORGE_RUN_UUID;
    }
  });

  test("the child never sees ANTHROPIC_API_KEY (regression guard on the same env block)", async () => {
    // Same construction site as the run id — asserted here so a future edit to
    // the env block cannot quietly reintroduce API-key billing.
    const raw = readFileSync(new URL("./cc-runner.ts", import.meta.url), "utf8");
    assert.match(raw, /delete env\.ANTHROPIC_API_KEY/);
  });
});

describe("T17 the executor passes the run id it claimed", () => {
  test("executor.ts hands runClaudeCode the run's id", () => {
    // A unit test cannot reach into the executor's claim loop without a live
    // DB, and the wiring is one line: assert the line exists rather than
    // pretend the coverage is deeper than it is.
    const raw = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");
    assert.match(
      raw,
      /runClaudeCode\(\{[\s\S]{0,600}?runId: run\.id,/,
      "executor.ts must pass runId: run.id to runClaudeCode — without it FORGE_RUN_ID is never set " +
        "and the screenshot convention silently degrades to the ad-hoc sentinel",
    );
  });
});

describe("round 900 — the operator's own runs get the screenshot convention too", () => {
  /* project-tick.ts's SCREENSHOT_CONVENTION (round 900) reaches every
   * browser-driving PROJECT TASK role, but a manager/chat run — including the
   * operator's own turns — never goes through buildPrompt() at all; its
   * whole prompt is buildSystemPrompt() plus whatever Konrad typed. That is
   * the "operator itself" population docs/plan/artifacts/phase1350/
   * browser-visibility.md §3 names as uncovered. Asserted here as a plain
   * substring against buildSystemPrompt()'s OWN return value — there is no
   * buildPrompt()-style role branching in this function to build a delivery
   * pair against, so the positive claim is the whole test. */
  test("the system prompt states the on-disk directory, FORGE_RUN_ID, and never /tmp", async () => {
    const { buildSystemPrompt } = await import("./cc-runner.ts");
    for (const vaultAccess of [true, false]) {
      const prompt = buildSystemPrompt(vaultAccess);
      assert.ok(
        prompt.includes("/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png"),
        `buildSystemPrompt(${vaultAccess}) is missing the literal on-disk screenshot pattern`,
      );
      assert.ok(
        prompt.includes("never /tmp"),
        `buildSystemPrompt(${vaultAccess}) no longer tells the operator not to use /tmp`,
      );
    }
  });

  test("the directory matches project-tick.ts's SCREENSHOT_CONVENTION verbatim — one convention, two prompts", async () => {
    // The two files independently name the same directory; this is the
    // control that keeps them from drifting apart the way the researcher's
    // own bullet and research-browser.mjs's --help were cross-checked (T16).
    const { buildSystemPrompt } = await import("./cc-runner.ts");
    const { SCREENSHOT_CONVENTION } = await import("./project-tick.ts");
    assert.match(
      SCREENSHOT_CONVENTION,
      /\/opt\/ai-os\/uploads\/\$FORGE_RUN_ID\/<stamp>-<label>\.png/,
      "positive control: SCREENSHOT_CONVENTION itself no longer states the pattern this test compares against",
    );
    assert.ok(
      buildSystemPrompt(true).includes("/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png"),
      "the operator's system prompt states a different on-disk pattern than project-tick.ts's " +
        "SCREENSHOT_CONVENTION — a project task and a manager chat would file screenshots differently",
    );
  });

  /* ROUND 902 (fix cycle 1, review finding 1). Both prompts claimed this chat
   * "renders every shot under that directory inline"; `extractBrowserShots`
   * matches a `Read` of the path or a printed JSON `"url"` member and nothing
   * else, so an operator's hand-saved shot rendered nowhere inline. The two
   * prompts are corrected together and pinned together — the same cross-check
   * shape as the case above, extended to the clauses the correction added,
   * because the failure this suite exists to prevent is one prompt being fixed
   * and the other quietly keeping the old promise.
   *
   * Each half is asserted with a POSITIVE CONTROL on SCREENSHOT_CONVENTION
   * first: without it, a constant that had dropped the clause would make the
   * cc-runner half look like the only survivor of a drift that had in fact gone
   * the other way. */
  test("round 902 — both prompts name the read-back action and define <stamp>", async () => {
    const { buildSystemPrompt } = await import("./cc-runner.ts");
    const { SCREENSHOT_CONVENTION } = await import("./project-tick.ts");
    for (const [what, taskNeedle, chatNeedle] of [
      [
        "the read-back action",
        "THEN READ THE FILE BACK with the Read tool",
        "Then READ THE FILE BACK with the Read tool",
      ],
      [
        "the stamp format, by example",
        "20260818T093000Z",
        "20260818T093000Z",
      ],
      [
        "the honest fallback surface",
        "camera indicator in the Team and Live panels",
        "camera indicator in the Team and Live panels",
      ],
    ] as const) {
      assert.ok(
        SCREENSHOT_CONVENTION.includes(taskNeedle),
        `positive control: SCREENSHOT_CONVENTION no longer states ${what} — fix project-tick.ts first, ` +
          "this test compares the two prompts and cannot tell which one drifted on its own",
      );
      for (const vaultAccess of [true, false]) {
        assert.ok(
          buildSystemPrompt(vaultAccess).includes(chatNeedle),
          `round 902: buildSystemPrompt(${vaultAccess}) does not state ${what}, but ` +
            "SCREENSHOT_CONVENTION does — the operator's own screenshots would follow the older, " +
            "false instruction while project tasks follow the corrected one",
        );
      }
    }
  });

  test("round 902 — neither prompt still promises that writing the file is enough", async () => {
    const { buildSystemPrompt } = await import("./cc-runner.ts");
    const { SCREENSHOT_CONVENTION } = await import("./project-tick.ts");
    for (const [name, text] of [
      ["SCREENSHOT_CONVENTION", SCREENSHOT_CONVENTION],
      ["buildSystemPrompt(true)", buildSystemPrompt(true)],
      ["buildSystemPrompt(false)", buildSystemPrompt(false)],
    ] as const) {
      assert.ok(
        !text.includes("renders every shot under that directory inline"),
        `round 902: ${name} still promises that every shot under the directory renders inline. It does ` +
          "not — extractBrowserShots matches a Read of the path or a printed \"url\" member, and a shot " +
          "that was only written matches neither",
      );
    }
  });
});
