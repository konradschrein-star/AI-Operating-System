/**
 * Guards the test runner's own reach.
 *
 * `package.json`'s test script was `tsx --test src/lib/*.test.ts`. A `*` does not
 * cross a `/`, so a test file placed anywhere else — `src/db/x.test.ts`,
 * `src/routes/x.test.ts`, or even `src/lib/nested/x.test.ts` — was executed by
 * NOTHING. It would sit in the repo looking like coverage, pass review, and
 * assert nothing at all.
 *
 * That is not hypothetical: two separate lanes of the aios-journal-thoughts-stats
 * project had to file undeclared-write disclosures on 2026-08-25 because their
 * brief named a correct-by-module test path that the glob could not reach, and
 * they relocated the file to `src/lib/` to make it run. The third lane would have
 * hit it too.
 *
 * ── Why this test lives in src/lib and checks package.json ────────────────
 * The obvious guard — a probe file at `src/db/` asserting "I am running" — is
 * WORTHLESS. If the glob narrows again, that probe simply stops being executed;
 * it cannot fail, it can only silently vanish, which is the failure it was
 * supposed to catch. A check that can only disappear is not a check.
 *
 * So the assertion lives where it is guaranteed to run (`src/lib/`, matched by
 * both the old and new patterns) and inspects the SCRIPT rather than its own
 * execution. Narrow the glob back and this goes red immediately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** forge-control/package.json, from this file at src/lib/. */
const PKG = join(import.meta.dirname, "..", "..", "package.json");

test("the test script reaches test files outside src/lib", () => {
  const pkg = JSON.parse(readFileSync(PKG, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.test ?? "";

  assert.ok(script.includes("--test"), `test script should invoke the node test runner: ${script}`);

  // `**` is the only part that crosses a directory separator. Without it a test
  // correctly placed beside the module it covers is dead weight.
  assert.ok(
    script.includes("**"),
    "test script must use a recursive glob (src/**/*.test.ts) — a bare " +
      "src/lib/*.test.ts silently skips every test outside that one directory. " +
      `Got: ${script}`,
  );

  // Quoted, so the SHELL passes the pattern through and node expands it. Bash
  // without `globstar` degrades `**` to a single-level `*`, which would
  // reintroduce exactly the gap this test exists to close — and would do it
  // invisibly, since the suite would still pass with fewer files.
  assert.ok(
    /"src\/\*\*\/\*\.test\.ts"|'src\/\*\*\/\*\.test\.ts'/.test(script),
    `the recursive glob must stay QUOTED so node expands it, not the shell: ${script}`,
  );
});
