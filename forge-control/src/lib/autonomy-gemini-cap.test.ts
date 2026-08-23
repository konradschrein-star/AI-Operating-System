/**
 * The Gemini side of the autonomy budget lever.
 *
 * Run: pnpm test   (node --test via tsx — the script globs src/lib/*.test.ts,
 * which is why a test for src/db/autonomy.ts lives in this directory.)
 *
 * ── WHAT THIS FILE GUARDS ───────────────────────────────────────────────────
 * Round 1 of aios-skills-live-control shipped `spend.daily_cap` with this body
 * for any Gemini run:
 *
 *     if (isGemini) { return { blocked: false }; }
 *
 * — unconditional, with no replacement counter anywhere. The UI meanwhile
 * presented Claude-vs-Gemini caps as a real lever. So a fleet of Gemini
 * workers, each individually under the 1M-token PER-RUN cap, could run an
 * unbounded number of times in a day against nothing at all. The round-1
 * reviewer rated it high: a financial control, silently defeated, surfaced
 * nowhere as a known gap.
 *
 * Every assertion below is written so that it FAILS against that code.
 *
 * `evaluateGeminiDailyCap` takes its usage reading as an argument precisely so
 * this file needs no database. Whether the SQL behind that reading counts the
 * right rows is a database question a fake cannot answer; it is proved against
 * the live table in the round-2 report (3,487,994 tokens / 25 runs on
 * 2026-08-23, 6,834,892 on 2026-08-22) and asserted structurally at the bottom
 * of this file.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  payloadIsGemini,
  evaluateGeminiDailyCap,
  DEFAULT_GEMINI_DAILY_TOKEN_CAP,
  type GeminiDailyUsage,
} from "../db/autonomy.ts";

const usage = (tokens: number, runs = 3): GeminiDailyUsage => ({
  tokens,
  runs,
  runs_without_usage: 0,
});

describe("payloadIsGemini — the detection matrix", () => {
  test("the model prefix is the load-bearing signal", () => {
    // Measured against the live runs table 2026-08-23: 88 Gemini rows carry
    // engine NULL and 46 carry engine 'claude-code' (the chat path re-tiers
    // the model without rewriting the engine). Keying on engine alone would
    // miss 134 of 137 real Gemini runs, so the model must be enough on its own.
    assert.equal(payloadIsGemini({ model: "gemini-3.7-flash-high" }), true);
    assert.equal(
      payloadIsGemini({ model: "gemini-3.7-flash-high", engine: "claude-code" }),
      true,
      "a gemini model under engine 'claude-code' is still a Gemini run",
    );
  });

  test("each Gemini-ish engine id the fleet actually writes is recognised", () => {
    for (const engine of ["gemini", "gemini-cli", "agy"]) {
      assert.equal(payloadIsGemini({ engine }), true, `engine ${engine}`);
    }
  });

  test("the legacy explicit flags still work", () => {
    assert.equal(payloadIsGemini({ is_gemini: true }), true);
    assert.equal(payloadIsGemini({ provider: "gemini" }), true);
  });

  test("a Claude run is not Gemini, and neither is an empty payload", () => {
    assert.equal(payloadIsGemini({ model: "claude-opus-5" }), false);
    assert.equal(
      payloadIsGemini({ model: "claude-opus-5", engine: "claude-code" }),
      false,
    );
    assert.equal(payloadIsGemini({}), false);
    assert.equal(payloadIsGemini({ model: 7, engine: null }), false);
  });
});

describe("evaluateGeminiDailyCap — the cap that used to be a no-op", () => {
  test("BLOCKS when today's cumulative draw is already over the cap", () => {
    // The regression case in one assertion: round 1 returned blocked:false here.
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1_000_000 },
      { model: "gemini-3.7-flash-high", tokens: 10_000 },
      usage(1_500_000),
    );
    assert.equal(r.blocked, true);
    assert.match(String(r.reason), /exceeds daily cap/);
  });

  test("BLOCKS on the cumulative total even when THIS run is tiny", () => {
    // The exact failure the reviewer described: every individual run sits far
    // under the per-run cap, and it is only the sum that is out of control.
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1_000_000 },
      { model: "gemini-3.7-flash-high", tokens: 1 },
      usage(1_000_000, 400),
    );
    assert.equal(r.blocked, true);
    assert.match(
      String(r.reason),
      /400 runs/,
      "the reason must name how many runs got there, or it reads as one bad run",
    );
  });

  test("allows a run comfortably under the cap", () => {
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 25_000_000 },
      { model: "gemini-3.7-flash-high", tokens: 20_000 },
      usage(3_487_994, 25),
    );
    assert.equal(r.blocked, false);
  });

  test("the boundary is strict >, so landing exactly ON the cap is allowed", () => {
    const at = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1_000 },
      { tokens: 400 },
      usage(600),
    );
    assert.equal(at.blocked, false, "600 + 400 === 1000 is not over 1000");
    const over = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1_000 },
      { tokens: 401 },
      usage(600),
    );
    assert.equal(over.blocked, true, "one token past the cap must block");
  });

  test("an unconfigured rule still enforces the built-in default", () => {
    // The other half of "not a no-op": with `config` empty the cap must be the
    // documented constant, not infinity.
    const over = evaluateGeminiDailyCap(
      {},
      { tokens: 1 },
      usage(DEFAULT_GEMINI_DAILY_TOKEN_CAP),
    );
    assert.equal(over.blocked, true);
    const under = evaluateGeminiDailyCap(
      {},
      { tokens: 1 },
      usage(DEFAULT_GEMINI_DAILY_TOKEN_CAP - 100),
    );
    assert.equal(under.blocked, false);
  });

  test("the default cap is finite and sits above the busiest real day", () => {
    assert.ok(Number.isFinite(DEFAULT_GEMINI_DAILY_TOKEN_CAP));
    assert.ok(
      DEFAULT_GEMINI_DAILY_TOKEN_CAP > 6_834_892,
      "must clear the busiest measured day (22 Aug 2026) or it fires on normal work",
    );
    assert.ok(
      DEFAULT_GEMINI_DAILY_TOKEN_CAP < 1_000_000_000,
      "a cap this large is indistinguishable from no cap",
    );
  });

  test("thread_chars is the fallback estimate when tokens is absent", () => {
    // The merge-base executor sends thread_chars and no token count, because
    // executor.ts is a forbidden file this project may not edit.
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1_000 },
      { model: "gemini-3.7-flash-high", thread_chars: 4_000 },
      usage(500),
    );
    assert.equal(r.blocked, true, "4000 chars ≈ 1000 tokens, 500 + 1000 > 1000");
  });

  test("an explicit zero cap is an opt-out, not a crash", () => {
    for (const cap of [0, -1]) {
      const r = evaluateGeminiDailyCap(
        { gemini_daily_token_cap: cap },
        { tokens: 999_999_999 },
        usage(999_999_999),
      );
      assert.equal(r.blocked, false, `cap ${cap} disables the brake`);
    }
  });

  test("a garbage cap is treated as unset, never as zero", () => {
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: "lots" },
      { tokens: 1 },
      usage(100),
    );
    assert.equal(
      r.blocked,
      false,
      "NaN must not become a cap of 0 that blocks every Gemini run",
    );
  });

  test("an unreadable counter FAILS OPEN rather than wedging the fleet", () => {
    const r = evaluateGeminiDailyCap(
      { gemini_daily_token_cap: 1 },
      { tokens: 999_999 },
      null,
    );
    assert.equal(r.blocked, false);
  });
});

describe("the daily-cap branch is wired, not merely present", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../db/autonomy.ts", import.meta.url)),
    "utf8",
  );

  test("spend.daily_cap's Gemini branch calls the counter-backed evaluator", () => {
    const start = SRC.indexOf('case "spend.daily_cap": {');
    assert.ok(start > 0, "the spend.daily_cap case must exist");
    const branch = SRC.slice(start, SRC.indexOf('case "git.force_push"', start));
    assert.match(branch, /evaluateGeminiDailyCap\(cfg, payload, ctx\.geminiDaily\)/);
    assert.doesNotMatch(
      branch,
      /isGemini\)\s*\{\s*\/\/[^\n]*\n\s*return \{ blocked: false \};/,
      "the round-1 unconditional Gemini exemption must not come back",
    );
  });

  test("the counter reads runs, excludes cached input, and is scoped to today", () => {
    const start = SRC.indexOf("export async function geminiDailyTokens(");
    assert.ok(start > 0, "geminiDailyTokens must exist");
    const fn = SRC.slice(start, SRC.indexOf("\n}", start));
    assert.match(fn, /FROM runs/, "must count real runs, not a constant");
    assert.match(
      fn,
      /updated_at >= date_trunc\('day', now\(\)\)/,
      "the window must be today, not all time",
    );
    assert.match(fn, /input_tokens/);
    assert.match(fn, /output_tokens/);
    assert.doesNotMatch(
      fn,
      /cache_read_input_tokens/,
      "cached context is replayed, not fresh quota — including it inflates the counter ~10x",
    );
    assert.doesNotMatch(
      fn,
      /usage_hourly/,
      "usage_hourly has no provider column; a Gemini cap fed by Claude tokens trips on the wrong fleet",
    );
  });
});
