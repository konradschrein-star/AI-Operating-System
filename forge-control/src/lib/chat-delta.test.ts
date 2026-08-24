/**
 * GET /api/chat/:id?since=<n> — the delta query.
 *
 * The known lead: this endpoint used to ship the ENTIRE thread on every poll
 * — measured ~2.1 MB on a long chat, polled every 3-20s — so an open chat
 * re-downloads what the client already has several times a minute. This test
 * pins `parseSinceParam`/`chatDeltaResponse` (routes/chat.ts), the two pure
 * functions the route composes to answer only the entries the caller doesn't
 * have yet, and to recover to a full fetch rather than lose data when the
 * caller's cursor cannot be trusted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chatDeltaResponse, parseSinceParam } from "../routes/chat.ts";
import type { RunDetail, ThreadEntry } from "../db/runs.ts";

function entry(content: string, ts: string): ThreadEntry {
  return { role: "user", content, ts };
}

/** A run with a 3-entry thread — enough to exercise "before the end",
 *  "exactly at the end" and "past the end" without a real database. */
function fixtureRun(): RunDetail {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    title: "fixture chat",
    status: "running",
    worker: "claude",
    budget_usd: "10",
    spent_usd: "0",
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:03.000Z",
    last_heartbeat_at: null,
    message_count: 3,
    last_message_preview: "third",
    last_role: "user",
    archived: false,
    metadata: {},
    prompt: "fixture prompt",
    thread: [
      entry("first", "2026-08-24T00:00:01.000Z"),
      entry("second", "2026-08-24T00:00:02.000Z"),
      entry("third", "2026-08-24T00:00:03.000Z"),
    ],
    parent_run_id: null,
    stuck_signal: null,
    started_at: "2026-08-24T00:00:00.000Z",
    completed_at: null,
  };
}

/* ── parseSinceParam ─────────────────────────────────────────────────────── */

describe("parseSinceParam", () => {
  test("omitted query param -> undefined", () => {
    assert.equal(parseSinceParam(undefined), undefined);
  });

  test("empty string -> undefined", () => {
    assert.equal(parseSinceParam(""), undefined);
  });

  test("a valid non-negative integer parses through", () => {
    assert.equal(parseSinceParam("0"), 0);
    assert.equal(parseSinceParam("3"), 3);
  });

  test("recovery: negative, fractional and non-numeric all fall back to undefined", () => {
    assert.equal(parseSinceParam("-1"), undefined);
    assert.equal(parseSinceParam("1.5"), undefined);
    assert.equal(parseSinceParam("abc"), undefined);
    assert.equal(parseSinceParam("NaN"), undefined);
  });
});

/* ── chatDeltaResponse ────────────────────────────────────────────────────── */

describe("chatDeltaResponse", () => {
  test("since omitted: full fetch, from 0, total unchanged, thread untouched", () => {
    const run = fixtureRun();
    const res = chatDeltaResponse(run, undefined);
    assert.equal(res.from, 0);
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.run.thread.map((e) => e.content),
      ["first", "second", "third"],
    );
  });

  test("since === thread.length: empty delta fetch, not an empty full fetch", () => {
    const run = fixtureRun();
    const res = chatDeltaResponse(run, 3);
    assert.equal(res.from, 3);
    assert.equal(res.total, 3);
    assert.deepEqual(res.run.thread, []);
  });

  test("since < thread.length: append delta, only the new entries", () => {
    const run = fixtureRun();
    const res = chatDeltaResponse(run, 1);
    assert.equal(res.from, 1);
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.run.thread.map((e) => e.content),
      ["second", "third"],
    );
  });

  test("since === 0: append delta over the whole thread, same content as full fetch", () => {
    const run = fixtureRun();
    const res = chatDeltaResponse(run, 0);
    assert.equal(res.from, 0);
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.run.thread.map((e) => e.content),
      ["first", "second", "third"],
    );
  });

  test("recovery: since > thread.length (stale/compacted cache) falls back to a full fetch", () => {
    const run = fixtureRun();
    const res = chatDeltaResponse(run, 99);
    assert.equal(res.from, 0);
    assert.equal(res.total, 3);
    assert.deepEqual(
      res.run.thread.map((e) => e.content),
      ["first", "second", "third"],
    );
  });

  test("full-fetch responses do not mutate the caller's run object", () => {
    const run = fixtureRun();
    const before = run.thread;
    chatDeltaResponse(run, 1);
    assert.equal(run.thread, before);
  });
});
