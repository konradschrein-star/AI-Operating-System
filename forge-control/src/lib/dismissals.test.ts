/**
 * Tests for the dismissal cascade.
 *
 * Run: cd forge-control && npm test   (tsx --test, no test framework dep)
 *
 * Everything here is pure: `resolveCascade` takes the rows and returns ids, so
 * the whole rule is provable without a database. What a real Postgres does
 * with the rule — the candidate query, the ON CONFLICT insert, the four
 * endpoints — is proved behaviourally against a scratch database in
 * docs/plan/artifacts/phase1350/dismissal-api.md.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  dismissalKind,
  isRunId,
  resolveCascade,
  type DismissalCandidate,
} from "./dismissals.ts";

/** Terse row builder — every field is named at the call site that cares. */
function row(
  id: string,
  status: string,
  extra: Partial<DismissalCandidate> = {},
): DismissalCandidate {
  return {
    id,
    parent_run_id: null,
    status,
    project_id: null,
    origin_chat_id: null,
    ...extra,
  };
}

describe("resolveCascade", () => {
  test("leaf run: the target and nothing else", () => {
    const rows = [row("m", "completed")];
    assert.deepEqual(resolveCascade("m", rows), ["m"]);
  });

  test("two settled children cascade", () => {
    const rows = [
      row("m", "completed"),
      row("c1", "completed", { parent_run_id: "m" }),
      row("c2", "failed", { parent_run_id: "m" }),
    ];
    assert.deepEqual(resolveCascade("m", rows), ["m", "c1", "c2"]);
  });

  test("a running child is excluded; its settled sibling is not", () => {
    const rows = [
      row("m", "completed"),
      row("c1", "completed", { parent_run_id: "m" }),
      row("c2", "running", { parent_run_id: "m" }),
    ];
    assert.deepEqual(resolveCascade("m", rows), ["m", "c1"]);
  });

  test("running is excluded at every depth, and the walk continues past it", () => {
    // m → live → done. The live node stays visible; the finished work beneath
    // it is still history and is still hidden.
    const rows = [
      row("m", "completed"),
      row("live", "running", { parent_run_id: "m" }),
      row("done", "completed", { parent_run_id: "live" }),
      row("queued", "queued", { parent_run_id: "m" }),
      row("paused", "paused", { parent_run_id: "m" }),
      row("stuck", "stuck", { parent_run_id: "m" }),
    ];
    // queued/paused/stuck are not terminal either — none of them cascade.
    assert.deepEqual(resolveCascade("m", rows), ["m", "done"]);
  });

  test("the target is always returned, even while it is running", () => {
    const rows = [row("m", "running")];
    assert.deepEqual(resolveCascade("m", rows), ["m"]);
  });

  test("manager of a project takes the project's settled workers", () => {
    const P = "proj-1";
    const rows = [
      row("chat", "completed"),
      row("w1", "completed", { project_id: P, origin_chat_id: "chat" }),
      row("w2", "running", { project_id: P, origin_chat_id: "chat" }),
      row("w3", "cancelled", { project_id: P, origin_chat_id: "chat" }),
      // A sub-run of a settled worker, reached through parent_run_id.
      row("w1a", "completed", {
        parent_run_id: "w1",
        project_id: P,
        origin_chat_id: "chat",
      }),
      // Another project entirely — never touched by this chat's dismissal.
      row("other", "completed", { project_id: "proj-2", origin_chat_id: "chat-2" }),
    ];
    assert.deepEqual(resolveCascade("chat", rows), ["chat", "w1", "w1a", "w3"]);
  });

  test("a chat that is nobody's origin chat cascades only its own children", () => {
    const rows = [
      row("chat", "completed"),
      row("w1", "completed", { project_id: "proj-1", origin_chat_id: "someone-else" }),
    ];
    assert.deepEqual(resolveCascade("chat", rows), ["chat"]);
  });

  test("unknown id: no rows match, the target alone comes back", () => {
    const rows = [
      row("m", "completed"),
      row("c1", "completed", { parent_run_id: "m" }),
    ];
    // This is the sub-agent case: tool_use_ids live in runs.thread and are
    // never rows, so the caller's query returns nothing for them.
    assert.deepEqual(resolveCascade("toolu_01XYZ", rows), ["toolu_01XYZ"]);
    assert.deepEqual(resolveCascade("m", []), ["m"]);
  });

  test("a parent_run_id cycle terminates and counts each node once", () => {
    const rows = [
      row("a", "completed", { parent_run_id: "c" }),
      row("b", "completed", { parent_run_id: "a" }),
      row("c", "completed", { parent_run_id: "b" }),
    ];
    assert.deepEqual(resolveCascade("a", rows), ["a", "b", "c"]);
    // Self-reference is the degenerate cycle.
    assert.deepEqual(resolveCascade("s", [row("s", "completed", { parent_run_id: "s" })]), [
      "s",
    ]);
  });

  test("order is deterministic and independent of row order", () => {
    const rows = [
      row("m", "completed"),
      row("b", "completed", { parent_run_id: "m" }),
      row("a", "completed", { parent_run_id: "m" }),
      row("c", "completed", { parent_run_id: "a" }),
    ];
    const expected = ["m", "a", "b", "c"];
    assert.deepEqual(resolveCascade("m", rows), expected);
    assert.deepEqual(resolveCascade("m", [...rows].reverse()), expected);
  });

  test("idempotent: same input, same output", () => {
    const rows = [
      row("m", "completed"),
      row("c", "completed", { parent_run_id: "m" }),
    ];
    assert.deepEqual(resolveCascade("m", rows), resolveCascade("m", rows));
  });
});

describe("id shape helpers", () => {
  const UUID = "3853c154-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

  test("a uuid is a run id", () => {
    assert.equal(isRunId(UUID), true);
    assert.equal(dismissalKind(UUID), "run");
  });

  test("a tool_use_id is not", () => {
    assert.equal(isRunId("toolu_01ABCdefGHIjklMNO"), false);
    assert.equal(dismissalKind("toolu_01ABCdefGHIjklMNO"), "subagent");
    assert.equal(isRunId(""), false);
    assert.equal(isRunId(`${UUID}x`), false);
  });
});
