/**
 * The 128 KiB argv cliff in the gemini runner.
 *
 * ## What this protects
 *
 * `runAgy` passes the entire prompt as ONE argv entry (`-p prompt`). Linux caps
 * a single argument at `MAX_ARG_STRLEN` — 32 pages, 131072 bytes including the
 * NUL. Measured against agy on this host: 131071 bytes spawns, 131072 throws
 * `E2BIG`.
 *
 * The nasty part is HOW it fails. Node throws E2BIG synchronously out of
 * `spawn()`, so it never reaches the `'error'` listener the runner installs.
 * Before the guard it escaped as an unhandled throw from inside a promise
 * executor: the caller got a stack trace mentioning `spawn E2BIG` and nothing
 * about prompts.
 *
 * Headroom is wide today — ~9.5 KB of system prompt plus the largest brief in
 * the database at ~40 KB, against a 128 KB ceiling — so this is a cliff rather
 * than a present outage. It is tested because briefs grow, because the failure
 * is silent-looking, and because the number is not guessable from the code.
 *
 * The bound is asserted against the REAL kernel here rather than trusted from a
 * constant: a constant that drifts from the kernel is exactly the kind of
 * instrument that lies.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { MAX_ARG_STRLEN } from "./gemini-runner";

describe("MAX_ARG_STRLEN matches the kernel, not just our belief about it", () => {
  test("one byte under the limit spawns", () => {
    // `true` rather than agy: this is a property of execve, and it should not
    // cost an LLM call to assert.
    const r = spawnSync("/bin/true", ["x".repeat(MAX_ARG_STRLEN - 1)]);
    assert.equal(r.error, undefined, "an argument one byte under the cap must be accepted");
    assert.equal(r.status, 0);
  });

  test("exactly at the limit is rejected with E2BIG", () => {
    const r = spawnSync("/bin/true", ["x".repeat(MAX_ARG_STRLEN)]);
    assert.ok(r.error, "the kernel must reject an argument at the cap");
    assert.equal((r.error as NodeJS.ErrnoException).code, "E2BIG");
  });

  test("the constant is the documented 32 pages", () => {
    assert.equal(MAX_ARG_STRLEN, 32 * 4096);
  });
});

describe("the runner refuses an oversized prompt before spawning", () => {
  test("it throws with the byte count and the cap, not 'spawn E2BIG'", async () => {
    const { runGemini } = await import("./gemini-runner");
    await assert.rejects(
      () =>
        runGemini({
          prompt: "x".repeat(MAX_ARG_STRLEN + 10),
          cwd: "/tmp",
        }),
      (err: Error) => {
        // The message has to carry the numbers: meeting this at 3am, "too big"
        // is not a diagnosis.
        assert.match(err.message, /over the 131072-byte single-argument limit/);
        assert.match(err.message, /\b131082 bytes\b/);
        assert.doesNotMatch(err.message, /spawn E2BIG/);
        return true;
      },
    );
  });

  test("a prompt just under the cap is not rejected by the guard", async () => {
    const { runGemini } = await import("./gemini-runner");
    // It will fail LATER for other reasons (no real task, agy may error) — the
    // only thing asserted is that it is not stopped by the size guard.
    await assert.rejects(
      () =>
        runGemini({
          prompt: "x".repeat(MAX_ARG_STRLEN - 5_000),
          cwd: "/tmp",
          timeoutMs: 1_000,
        }),
      (err: Error) => {
        assert.doesNotMatch(
          err.message,
          /single-argument limit/,
          "a legal prompt must not be refused by the size guard",
        );
        return true;
      },
    );
  });
});
