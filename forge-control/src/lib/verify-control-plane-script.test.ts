/**
 * CP4-3 (round 1203): regression guard for `scripts/checks/verify-control-plane.sh`.
 *
 * WHY THIS TEST EXISTS. Round 1202 ran that script against the live server for
 * the first time and all 10 steps failed with `HTTP_CODE=000` — not because a
 * control-plane verb was broken, but because the script's own helpers returned
 * their value on STDOUT while `http()` writes the whole pasteable transcript to
 * stdout too. `RUN_A="$(create_scratch_run "target")"` therefore captured ~1.9 KB
 * of transcript instead of a UUID, every later URL was malformed, and the deploy
 * phase spent a round proving nothing (evidence: docs/plan/evidence/cp4-deploy.md
 * §2.4). The fix is the out-parameter convention asserted below.
 *
 * WHY SOURCE-ASSERTION. Same precedent as run-control-surface.test.ts: the
 * subject is a shell script that only does anything against a LIVE server, which
 * a test process must never contact (worktree-only policy). So the assertions
 * read the script's SOURCE TEXT and check the convention that made it correct,
 * which is exactly the property that regressed. Nothing here executes the script
 * or opens a socket.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../scripts/checks/verify-control-plane.sh", import.meta.url),
);
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

/** Lines with comments stripped, so prose that *describes* the old bug (this
 *  script's own explanatory comments do) can never satisfy or trip an
 *  assertion about the code. */
const CODE_LINES = SCRIPT.split("\n").filter((l) => !l.trim().startsWith("#"));
const CODE = CODE_LINES.join("\n");

/** The three helpers that call `http()` and therefore MUST NOT print a value. */
const VALUE_HELPERS = ["create_scratch_run", "run_status", "run_completed_at"] as const;

/** Slice one shell function body: `name() {` up to the first line that is a
 *  bare `}` at column 0 — the script defines every function at top level. */
function sliceFunction(name: string): string {
  const start = SCRIPT.indexOf(`${name}() {`);
  assert.ok(start >= 0, `shell function ${name}() not found in the script`);
  const end = SCRIPT.indexOf("\n}\n", start);
  assert.ok(end > start, `shell function ${name}() has no closing brace`);
  return SCRIPT.slice(start, end);
}

describe("verify-control-plane.sh — value helpers use out-parameters, not stdout", () => {
  /**
   * THE regression assertion. A command substitution around any of the three
   * helpers re-creates the round-1202 failure exactly: the caller's variable
   * gets the transcript plus the value, every URL built from it is malformed,
   * and the script reports ten red steps that were never attempted.
   */
  for (const helper of VALUE_HELPERS) {
    test(`no call site captures ${helper} with a command substitution`, () => {
      const offenders = CODE_LINES.filter((l) => l.includes(`$(${helper} `));
      assert.deepEqual(
        offenders,
        [],
        `${helper} must be called as a bare statement and read back from its ` +
          `out-parameter; $(${helper} …) also captures http()'s transcript ` +
          `(see docs/plan/evidence/cp4-deploy.md §2.4)`,
      );
    });
  }

  test("create_scratch_run publishes the id via SCRATCH_RUN_ID and prints nothing", () => {
    const body = sliceFunction("create_scratch_run");
    assert.match(
      body,
      /SCRATCH_RUN_ID="\$id"/,
      "create_scratch_run must assign the new id to SCRATCH_RUN_ID",
    );
    const printsValue = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .some((l) => /^\s*printf\s+'%s'\s+"\$id"/.test(l));
    assert.equal(
      printsValue,
      false,
      "create_scratch_run must not printf the id — stdout carries the transcript",
    );
  });

  test("run_status and run_completed_at capture jq_field into their out-parameters", () => {
    const status = sliceFunction("run_status");
    assert.match(
      status,
      /RUN_STATUS="\$\(jq_field '\.run\.status' "\$HTTP_BODY"\)"/,
      "run_status must assign into RUN_STATUS, not print .run.status",
    );
    const completed = sliceFunction("run_completed_at");
    assert.match(
      completed,
      /RUN_COMPLETED_AT="\$\(jq_field '\.run\.completed_at' "\$HTTP_BODY"\)"/,
      "run_completed_at must assign into RUN_COMPLETED_AT, not print .run.completed_at",
    );
  });

  /**
   * Each helper clears its out-parameter on entry. Without this a failed call
   * leaves the PREVIOUS run's value in place, and an assertion like
   * `step_assert_eq "$RUN_STATUS" "paused"` would pass on a stale reading —
   * a false green, which is worse than round 1202's honest red.
   */
  test("each helper resets its out-parameter before the HTTP call", () => {
    assert.match(sliceFunction("create_scratch_run"), /SCRATCH_RUN_ID=""/);
    assert.match(sliceFunction("run_status"), /RUN_STATUS=""/);
    assert.match(sliceFunction("run_completed_at"), /RUN_COMPLETED_AT=""/);
  });

  test("the out-parameters are declared at top level before first use", () => {
    for (const decl of ['SCRATCH_RUN_ID=""', 'RUN_STATUS=""', 'RUN_COMPLETED_AT=""']) {
      const declIndex = CODE.indexOf(`\n${decl}`);
      assert.ok(declIndex >= 0, `${decl} must be declared at top level (column 0)`);
      const firstHelper = Math.min(
        ...VALUE_HELPERS.map((h) => {
          const i = CODE.indexOf(`${h}() {`);
          return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
        }),
      );
      assert.ok(
        declIndex < firstHelper,
        `${decl} must be declared before the helpers that set it`,
      );
    }
  });
});

describe("verify-control-plane.sh — properties the deploy phase depends on", () => {
  /** 07 §8 / the project's hard rules: this script must never restart, stop or
   *  delete a pm2 process. It runs against a live server on a deploy. */
  test("never touches pm2", () => {
    const offenders = CODE_LINES.filter((l) => /\bpm2\b/.test(l));
    assert.deepEqual(offenders, [], "the verification script must never invoke pm2");
  });

  /** The script's contract with the deploy transcript: `http()` echoes the exact
   *  curl and the verbatim response to stdout, which is what D3's `proof` column
   *  is copied from. If that moved to stderr the transcript would be split. */
  test("http() still echoes the curl invocation and response on stdout", () => {
    const body = sliceFunction("http");
    assert.match(body, /echo "\\\$ curl -sS -X \$method/, "http() must echo the curl it ran");
    assert.ok(
      !/echo "\\\$ curl[^\n]*>&2/.test(body),
      "http()'s transcript must stay on stdout — the evidence paste depends on it",
    );
  });

  /** No silent skips (the script's own header rule): every step that cannot be
   *  attempted still counts in the tally. */
  test("the summary exits non-zero when any step failed", () => {
    assert.match(CODE, /if \[ "\$\{#FAILED_STEPS\[@\]\}" -eq 0 \]/);
    assert.match(CODE, /exit 1/);
  });
});
