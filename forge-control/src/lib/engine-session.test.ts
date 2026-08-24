/**
 * The engine-switch bug Konrad hit on 2026-08-23.
 *
 * Switching a live chat from Claude to Gemini killed the run with
 *   agy returned status ERROR ... conversation "6b1c2951-…" not found
 * because `cc_session_id` was one slot shared by both engines and the resume
 * path read it back without asking which engine minted it.
 *
 * These assertions are written so they FAIL against the old behaviour (which
 * returned the id unconditionally) — a test that passes either way would prove
 * nothing.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { engineForModel, resumableSession } from "./engine-session.ts";

const CLAUDE_SID = "6b1c2951-2a30-4864-bd7d-5473a5a16dd0";
const AGY_SID = "0bb0edd9-f168-437f-adaf-1911fe540ed3";

test("engineForModel routes by model id, agreeing with cc-runner's dispatcher", () => {
  assert.equal(engineForModel("gemini-3.7-flash-high"), "agy");
  assert.equal(engineForModel("claude-opus-5"), "claude-code");
  assert.equal(engineForModel("claude-haiku-4-5-20251001"), "claude-code");
  // Unknown/absent model must NOT silently become Gemini.
  assert.equal(engineForModel(null), "claude-code");
  assert.equal(engineForModel(undefined), "claude-code");
});

test("a Claude session id is NOT handed to agy — the exact failure Konrad saw", () => {
  const md = { cc_session_id: CLAUDE_SID, engine: "claude-code" };
  assert.equal(
    resumableSession(md, "agy"),
    null,
    "handing a claude session id to agy is what produced 'conversation not found'",
  );
});

test("an agy conversation id is NOT handed to claude --resume (the silent mirror)", () => {
  const md = { cc_session_id: AGY_SID, engine: "agy" };
  assert.equal(resumableSession(md, "claude-code"), null);
});

test("each engine still resumes its OWN session — the fix must not break continuity", () => {
  assert.equal(
    resumableSession({ cc_session_id: CLAUDE_SID, engine: "claude-code" }, "claude-code"),
    CLAUDE_SID,
  );
  assert.equal(
    resumableSession({ cc_session_id: AGY_SID, engine: "agy" }, "agy"),
    AGY_SID,
  );
});

test("legacy rows with no engine field are treated as claude-code, which they were", () => {
  // Every writer of this slot before the fix hardcoded 'claude-code', so this
  // default is a fact about the data, not an optimistic guess.
  const legacy = { cc_session_id: CLAUDE_SID };
  assert.equal(resumableSession(legacy, "claude-code"), CLAUDE_SID);
  assert.equal(resumableSession(legacy, "agy"), null);
});

/* ── The key split, 2026-08-24 ────────────────────────────────────────────────
 * Provenance shipped in `metadata.engine`, which the executor already used to
 * choose its dispatch branch. A Gemini run's first turn wrote "agy" there and
 * every later turn of that chat went to the legacy HTTP pool instead of agy —
 * surfacing as `pool 400: Invalid request`. Provenance moved to
 * `session_engine`; both generations of rows must still read back correctly. */

test("session_engine is authoritative when both keys are present", () => {
  // A live chat pinned to the pool that nonetheless minted a Claude session id:
  // dispatch says claude-pool, provenance says claude-code. Provenance wins.
  const md = {
    cc_session_id: CLAUDE_SID,
    engine: "claude-pool",
    session_engine: "claude-code",
  };
  assert.equal(resumableSession(md, "claude-code"), CLAUDE_SID);
  assert.equal(resumableSession(md, "agy"), null);
});

test("collided rows still read correctly — engine IS the producer for those", () => {
  // The 33 rows written between the two fixes carry the producing engine in
  // `engine` because saveCcSession is what put it there. Reading it back as
  // provenance is a fact about that data, not a guess.
  const collided = { cc_session_id: AGY_SID, engine: "agy" };
  assert.equal(resumableSession(collided, "agy"), AGY_SID);
  assert.equal(resumableSession(collided, "claude-code"), null);
});

test("a dispatch-only 'claude-pool' in the legacy slot is not read as a producer", () => {
  // The pool never mints a session id, so a row carrying that value in the old
  // shared key is a pre-split row whose id came from the Claude CLI. Reading
  // "claude-pool" literally would strand a resumable Claude conversation.
  const md = { cc_session_id: CLAUDE_SID, engine: "claude-pool" };
  assert.equal(resumableSession(md, "claude-code"), CLAUDE_SID);
  assert.equal(resumableSession(md, "agy"), null);
});

test("absent or malformed session ids yield null rather than throwing", () => {
  assert.equal(resumableSession(null, "claude-code"), null);
  assert.equal(resumableSession(undefined, "agy"), null);
  assert.equal(resumableSession({}, "claude-code"), null);
  assert.equal(resumableSession({ cc_session_id: "" }, "claude-code"), null);
  assert.equal(resumableSession({ cc_session_id: 42 }, "claude-code"), null);
});
