/**
 * gemini-runner — the stream envelope parser.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * On 2026-08-26 the Gemini engine was switched from `--output-format json` to
 * `--output-format stream-json`, so that a long-but-healthy run keeps proving
 * it is alive instead of being killed by a wall-clock guess. That moved the
 * answer from "the whole document" to "the `result` member of the last
 * `{"event":"result"}` line", and a parser that gets that wrong does not throw
 * — it reports an empty response, which the caller correctly reads as a failed
 * run. A silent downgrade of every Gemini task to "dropped" is exactly the bug
 * this change set exists to remove, so the parser is pinned here.
 *
 * The fixtures are REAL agy output, captured from the installed binary that
 * day, not hand-written approximations of it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildAgyArgs, parseAgyStdout } from "./gemini-runner.ts";

/* ══════════════════════════════════════════════════════════════════════════
 * THE FLAGS ARE THE FIX.
 *
 * MEASURED 2026-08-25 over a full fleet day: 16 of 18 Gemini runs died, in two
 * clusters, and neither was the model failing at the work.
 *
 *   ~307s  agy's OWN `--print-timeout`, which defaults to 5m0s and which this
 *          runner never set.
 *   ~600s  this runner's wall-clock kill.
 *
 * Real work the same day: builders averaged 15.7 min. Both ceilings sat below
 * the median task, so a Gemini builder could not finish a normal task however
 * capable the model was. These cases exist because that fix lives entirely in
 * an argument list, and an argument list is one careless edit from reverting.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("buildAgyArgs — the two ceilings stay lifted", () => {
  const base = { prompt: "hi", model: "gemini-3.7-flash-high", cwd: "/w" };

  test("agy is told the same budget the runner enforces, with headroom", () => {
    // 15 min budget -> 16m, so OUR idle timer fires first and reports the
    // honest reason instead of agy dying anonymously one second earlier.
    const args = buildAgyArgs({ ...base, budgetMs: 900_000 });
    const i = args.indexOf("--print-timeout");
    assert.notEqual(i, -1, "without --print-timeout agy silently caps itself at 5 minutes");
    assert.equal(args[i + 1], "16m");
  });

  test("a sub-minute budget still asks for at least a minute", () => {
    const args = buildAgyArgs({ ...base, budgetMs: 5_000 });
    assert.equal(args[args.indexOf("--print-timeout") + 1], "2m");
  });

  test("the default 5m cap can never be what agy uses", () => {
    for (const budgetMs of [60_000, 300_000, 900_000, 1_800_000]) {
      const v = buildAgyArgs({ ...base, budgetMs })[
        buildAgyArgs({ ...base, budgetMs }).indexOf("--print-timeout") + 1
      ];
      assert.notEqual(v, "5m", `budget ${budgetMs}ms must not land back on agy's own default`);
    }
  });

  test("streaming is on, because the idle budget depends on it", () => {
    const args = buildAgyArgs({ ...base, budgetMs: 900_000 });
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    // `json` emits nothing until the end, which turns a long healthy run into
    // an indistinguishable-from-hung run and forces a wall-clock guess.
    assert.ok(!args.includes("json") || args.includes("stream-json"));
  });

  test("cwd, extra dirs and a resumed conversation all still reach agy", () => {
    const args = buildAgyArgs({
      ...base,
      budgetMs: 900_000,
      addDirs: ["/vault"],
      sessionId: "abc123",
    });
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.equal(args.filter((a) => a === "--add-dir").length, 2);
    assert.equal(args[args.indexOf("--conversation") + 1], "abc123");
  });
});

/* Captured live: agy 2026-08-26, `--output-format stream-json`, trimmed to the
 * three line kinds that matter. The tool list in the real `init` line is ~50
 * entries long and carries no meaning for the parser. */
const STREAM = [
  `{"event":"init","conversation_id":"d43c157d","init":{"model":"gemini-3.7-flash-high","cwd":"/tmp/agy-tool","permission_mode":"always-proceed"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"d43c157d","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"d43c157d","step_index":2,"state":"DONE","step_type":"agent_response","duration_seconds":5.25}}`,
  `{"event":"result","result":{"conversation_id":"d43c157d","status":"SUCCESS","response":"PONG\\n","duration_seconds":13.3,"num_turns":1,"usage":{"input_tokens":13824,"output_tokens":25,"thinking_tokens":23,"cache_read_tokens":0,"total_tokens":13849}}}`,
].join("\n");

/* The pre-2026-08-26 shape, still accepted: one bare document, no `event`. */
const LEGACY = `{"conversation_id":"68db6efb","status":"SUCCESS","response":"PONG\\n","duration_seconds":3.8,"num_turns":1,"usage":{"input_tokens":13824,"output_tokens":23,"total_tokens":13847}}`;

describe("parseAgyStdout — stream-json", () => {
  test("takes the answer from the final result event, not the first line", () => {
    const env = parseAgyStdout(STREAM);
    assert.ok(env, "the stream must yield an envelope");
    assert.equal(env.status, "SUCCESS");
    assert.equal(env.response, "PONG\n");
    assert.equal(env.usage?.total_tokens, 13849);
  });

  test("ignores init and step_update lines entirely", () => {
    // The init line also carries a conversation_id; a parser that took the
    // FIRST object it could read would return it and lose the response.
    const env = parseAgyStdout(STREAM);
    assert.notEqual(env?.response, undefined, "init must not be mistaken for the result");
  });

  test("a trailing newline and chunk-split whitespace do not matter", () => {
    assert.equal(parseAgyStdout(`${STREAM}\n\n`)?.response, "PONG\n");
    assert.equal(parseAgyStdout(`\n${STREAM}`)?.response, "PONG\n");
  });
});

describe("parseAgyStdout — the shapes that must not regress", () => {
  test("still reads the legacy single-document envelope", () => {
    const env = parseAgyStdout(LEGACY);
    assert.equal(env?.status, "SUCCESS");
    assert.equal(env?.response, "PONG\n");
  });

  test("surfaces agy's own error field on a failed run", () => {
    /* This is the line that hid an EXPIRED OAUTH TOKEN behind "status ERROR
     * with no response text" — a message that reads like a model failure and
     * sent the fleet hunting prompts for a week. */
    const authFail = `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0}}`;
    const env = parseAgyStdout(authFail);
    assert.equal(env?.status, "ERROR");
    assert.equal(env?.error, "authentication failed or timed out");
  });

  test("empty output is null rather than a fabricated success", () => {
    assert.equal(parseAgyStdout(""), null);
    assert.equal(parseAgyStdout("   \n  "), null);
  });

  test("non-JSON progress noise before a valid result is skipped, not fatal", () => {
    const noisy = `Waiting for authentication...\nsome progress line\n${STREAM}`;
    assert.equal(parseAgyStdout(noisy)?.response, "PONG\n");
  });

  test("output with no envelope at all yields null", () => {
    // Not "" and not JSON — the caller must be able to tell this apart from a
    // run that answered, because it attaches stderr in that branch.
    assert.equal(parseAgyStdout("Error: authentication timed out.\n"), null);
  });

  test("the LAST result wins when a stream somehow carries two", () => {
    const twice = `${STREAM}\n{"event":"result","result":{"status":"SUCCESS","response":"SECOND"}}`;
    assert.equal(parseAgyStdout(twice)?.response, "SECOND");
  });
});
