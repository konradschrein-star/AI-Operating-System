/**
 * The live-row projection the sidebar reads.
 *
 * Every number below is written as a LITERAL. Importing `ACTIVITY_TEXT_CAP`
 * and comparing a result against it would pass at every value of the cap —
 * including 0 — and would prove only that the module is self-consistent. The
 * assertions here are meant to fail if someone changes the bound without
 * meaning to.
 *
 * They are also written to fail against the obvious wrong implementations:
 * a bare `engineForModel(model)` badge (which returns "claude-code" for an
 * unmeasured model), and a projection that ships the last activity of a
 * settled node.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ACTIVITY_TEXT_CAP,
  badgeEngineForModel,
  capActivityText,
  projectActivity,
} from "./team-live.ts";

test("the badge follows the MODEL, which is the only trustworthy engine key", () => {
  assert.equal(badgeEngineForModel("gemini-3.7-flash-high"), "agy");
  assert.equal(badgeEngineForModel("claude-opus-5"), "claude-code");
  assert.equal(badgeEngineForModel("claude-sonnet-5"), "claude-code");
  assert.equal(badgeEngineForModel("claude-haiku-4-5-20251001"), "claude-code");
});

test("an unmeasured model badges NOTHING — never a plausible 'claude-code'", () => {
  // engineForModel(null) is "claude-code" by design, for dispatch. A badge
  // must not inherit that default: it would assert a fact nobody measured,
  // and it is exactly what the 46 collided rows already taught us not to do.
  assert.equal(badgeEngineForModel(null), null);
  assert.equal(badgeEngineForModel(undefined), null);
  assert.equal(badgeEngineForModel(""), null);
  assert.equal(badgeEngineForModel("   "), null);
});

test("a settled node ships no activity at all", () => {
  const live = { kind: "tool_call", tool: "Bash", text: null, ts: "2026-08-25T00:47:44.986Z" };
  assert.equal(projectActivity(live, { settled: true }), null);
  assert.notEqual(projectActivity(live, { settled: false }), null);
});

test("a tool_result with a null tool still projects something renderable", () => {
  // The measured hazard: the rollup writes {kind:"tool_result", tool:null,
  // text:null} on every parent tool result, and the /live surface's
  // activityLabel returns "" for that shape. The projection must still carry
  // the kind and its stamp — an empty object would render as a blank cell,
  // and a blank cell reads as "idle".
  const got = projectActivity(
    { kind: "tool_result", tool: null, text: null, ts: "2026-08-25T00:47:45.397Z" },
    { settled: false },
  );
  assert.deepEqual(got, {
    kind: "tool_result",
    tool: null,
    text: null,
    ts: "2026-08-25T00:47:45.397Z",
  });
  assert.equal(typeof got?.kind, "string");
  assert.ok((got?.kind.length ?? 0) > 0, "kind must always be renderable");
});

test("over-long text is clipped to 120 characters, ellipsis included", () => {
  const long = "x".repeat(400);
  const got = projectActivity({ kind: "assistant_text", tool: null, text: long, ts: null }, {
    settled: false,
  });
  assert.equal(got?.text?.length, 120);
  assert.equal(got?.text?.endsWith("…"), true, "a clip must be visible as a clip");
  assert.equal(got?.text?.slice(0, 119), "x".repeat(119));
  // The constant and the literal must agree; if this line fails, one of the
  // two was changed without the other.
  assert.equal(ACTIVITY_TEXT_CAP, 120);
});

test("text at or under the cap is passed through untouched", () => {
  assert.equal(capActivityText("reading run-rollup.ts"), "reading run-rollup.ts");
  assert.equal(capActivityText("y".repeat(120))?.length, 120);
  assert.equal(capActivityText("y".repeat(120))?.includes("…"), false);
  assert.equal(capActivityText("y".repeat(121))?.length, 120);
  assert.equal(capActivityText(null), null);
});

test("junk in the metadata slot projects null, not a half-built object", () => {
  assert.equal(projectActivity(null, { settled: false }), null);
  assert.equal(projectActivity(undefined, { settled: false }), null);
  assert.equal(projectActivity("tool_call", { settled: false }), null);
  assert.equal(projectActivity({}, { settled: false }), null);
  assert.equal(projectActivity({ kind: "" }, { settled: false }), null);
  assert.equal(projectActivity({ kind: 7 }, { settled: false }), null);
  assert.equal(projectActivity({ tool: "Bash" }, { settled: false }), null);
});

test("non-string tool/text/ts degrade to null rather than reaching the client", () => {
  const got = projectActivity(
    { kind: "tool_call", tool: 42, text: { a: 1 }, ts: 1756082864986 },
    { settled: false },
  );
  assert.deepEqual(got, { kind: "tool_call", tool: null, text: null, ts: null });
});

test("empty strings are null, so the client can tell absent from empty", () => {
  const got = projectActivity(
    { kind: "tool_call", tool: "", text: "", ts: "" },
    { settled: false },
  );
  assert.deepEqual(got, { kind: "tool_call", tool: null, text: null, ts: null });
});
