/**
 * Tests for GET /api/spend/summary's query parsing.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The two that matter:
 *  - "a misspelled provider is REJECTED, not ignored" — the silent-fallback
 *    failure this module exists to prevent. An ignored filter returns the
 *    unfiltered series under a filtered label, which reads as a finding.
 *  - "days=banana is an error, not 30" — the route's previous
 *    `Number(q) || 30` swallowed it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseSpendFilters,
  SPEND_DEFAULT_DAYS,
  SPEND_MIN_DAYS,
  SPEND_MAX_DAYS,
} from "./spend-filters.ts";

function ok(query: Parameters<typeof parseSpendFilters>[0]) {
  const r = parseSpendFilters(query);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  if (!r.ok) throw new Error("unreachable");
  return r.value;
}

function err(query: Parameters<typeof parseSpendFilters>[0]) {
  const r = parseSpendFilters(query);
  assert.equal(r.ok, false, `expected error, got ${JSON.stringify(r)}`);
  if (r.ok) throw new Error("unreachable");
  return r.error;
}

describe("parseSpendFilters — days", () => {
  test("absent days is the default window", () => {
    assert.equal(ok({}).days, SPEND_DEFAULT_DAYS);
  });

  test("empty days is the default window", () => {
    assert.equal(ok({ days: "" }).days, SPEND_DEFAULT_DAYS);
    assert.equal(ok({ days: "   " }).days, SPEND_DEFAULT_DAYS);
  });

  test("a plain number passes through", () => {
    assert.equal(ok({ days: "7" }).days, 7);
    assert.equal(ok({ days: "90" }).days, 90);
  });

  test("days clamps at both ends rather than erroring", () => {
    assert.equal(ok({ days: "0" }).days, SPEND_MIN_DAYS);
    assert.equal(ok({ days: "-5" }).days, SPEND_MIN_DAYS);
    assert.equal(ok({ days: "100000" }).days, SPEND_MAX_DAYS);
  });

  test("a fractional day truncates", () => {
    assert.equal(ok({ days: "7.9" }).days, 7);
  });

  test("days=banana is an error, not 30", () => {
    // `Number("banana") || 30` — the shape this module replaced — returned 30
    // and told nobody. A window silently different from the one requested is
    // how a chart ends up disagreeing with its own axis label.
    const message = err({ days: "banana" });
    assert.match(message, /days must be a number/);
    assert.match(message, /banana/);
  });

  test("days=Infinity is an error", () => {
    assert.match(err({ days: "Infinity" }), /days must be a number/);
  });
});

describe("parseSpendFilters — provider and kind", () => {
  test("absent means no filter", () => {
    const v = ok({});
    assert.equal(v.provider, null);
    assert.equal(v.kind, null);
  });

  test("the literal 'all' and the empty string mean no filter", () => {
    assert.equal(ok({ provider: "all" }).provider, null);
    assert.equal(ok({ provider: "ALL" }).provider, null);
    assert.equal(ok({ provider: "" }).provider, null);
    assert.equal(ok({ kind: "all" }).kind, null);
  });

  test("real provider and kind names survive verbatim", () => {
    const v = ok({ provider: "claude-code", kind: "llm_output" });
    assert.equal(v.provider, "claude-code");
    assert.equal(v.kind, "llm_output");
  });

  test("surrounding whitespace is trimmed, not rejected", () => {
    assert.equal(ok({ provider: "  gemini  " }).provider, "gemini");
  });

  test("a misspelled provider is REJECTED, not ignored", () => {
    // The point of the filter is that the series it returns is the series the
    // caller asked for. A typo that quietly widens the query back to "every
    // provider" produces a chart labelled `gemni` showing claude-code's total.
    // Shape-valid typos still pass here (the DB simply returns no rows, which
    // is the honest answer); this asserts the SHAPE gate, which is what stops
    // an injected or malformed value reaching SQL as a filter value.
    assert.match(err({ provider: "gemini; drop" }), /provider must match/);
    assert.match(err({ provider: "clau de" }), /provider must match/);
    assert.match(err({ kind: "llm output" }), /kind must match/);
  });

  test("an over-long name is rejected with its length", () => {
    const message = err({ provider: "a".repeat(65) });
    assert.match(message, /at most 64 characters/);
    assert.match(message, /got 65/);
  });

  test("a name may not start with punctuation", () => {
    assert.match(err({ provider: "-gemini" }), /provider must match/);
    assert.match(err({ kind: "_llm_output" }), /kind must match/);
  });

  test("provider and kind are independent", () => {
    const v = ok({ provider: "gemini", kind: "all" });
    assert.equal(v.provider, "gemini");
    assert.equal(v.kind, null);
  });
});
