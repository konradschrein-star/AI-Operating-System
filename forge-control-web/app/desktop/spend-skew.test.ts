/**
 * Tests for the /api/spend/summary deploy-skew guards.
 *
 * Run: cd forge-control-web && npx tsx --test app/desktop/spend-skew.test.ts
 * (node --test via tsx, same runner as forge-control/src/lib/*.test.ts and
 * app/desktop/goals/quick-add.test.ts — the module under test imports nothing
 * but a type, so no DOM and no fetch have to exist.)
 *
 * OLD_SUMMARY is not invented: it is the response the deployed forge-control
 * actually returned on 2026-08-23, keys and all, captured with
 *   curl -s "http://127.0.0.1:7700/api/spend/summary?days=7"
 * The first test proves that payload still reproduces the TypeError the guards
 * exist to prevent — without it every other assertion here would pass equally
 * well against a payload that was never dangerous.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { SpendSummaryResponse } from "../api-business";
import {
  spendPickLists,
  firstIncompleteDay,
  incompleteDayMessage,
  type WireSpendSummary,
  type WireSpendDailyItem,
} from "./spend-skew";

/** Verbatim shape of the older deployed API: no `filters`, and daily rows
 *  carrying no compute split. Amounts trimmed, keys untouched. */
const OLD_SUMMARY: WireSpendSummary = {
  today: { total_eur: 0, calls: 34, claude_eur: 353.2966, claude_calls: 104 },
  d7: { total_eur: 0, calls: 84, claude_eur: 2974.1302, claude_calls: 836 },
  d30: { total_eur: 0, calls: 84, claude_eur: 4089.2986, claude_calls: 1208 },
  by_area: [
    {
      provider: "claude-code",
      kind: "llm_output",
      total_eur: 4089.2986,
      calls: 1208,
      units: 44333,
    },
  ],
  daily: [{ day: "2026-08-22", total_eur: 0, calls: 50 }],
};

/** The shape this repo's forge-control ships today. */
const NEW_SUMMARY: WireSpendSummary = {
  ...OLD_SUMMARY,
  daily: [
    {
      day: "2026-08-22",
      total_eur: 1.5,
      shadow_eur: 353.29,
      total_compute_eur: 354.79,
      calls: 50,
    },
  ],
  filters: {
    providers: ["claude-code", "openai", "elevenlabs"],
    kinds: ["llm_output", "tts"],
    applied: { provider: null, kind: null },
  },
};

describe("the failure these guards exist for", () => {
  test("reading .filters.providers off the old payload throws TypeError", () => {
    // The exact expression MoneySurface carried before this fix. `getJson<T>`
    // is an unchecked cast, so this is what shipped code did at runtime.
    const asDeclared = OLD_SUMMARY as SpendSummaryResponse;
    assert.throws(() => asDeclared.filters.providers, TypeError);
  });

  test("formatting an absent shadow_eur throws TypeError", () => {
    const day = OLD_SUMMARY.daily[0];
    assert.throws(
      () => (day.shadow_eur as number).toLocaleString("en-US"),
      TypeError,
    );
  });
});

describe("spendPickLists", () => {
  test("old API without a filters block yields empty pick lists, no throw", () => {
    assert.deepEqual(spendPickLists(OLD_SUMMARY), { providers: [], kinds: [] });
  });

  test("null summary (first render, or a failed fetch) yields empty lists", () => {
    assert.deepEqual(spendPickLists(null), { providers: [], kinds: [] });
  });

  test("current API's lists are passed through verbatim, not re-derived", () => {
    assert.deepEqual(spendPickLists(NEW_SUMMARY), {
      providers: ["claude-code", "openai", "elevenlabs"],
      kinds: ["llm_output", "tts"],
    });
  });

  test("a server sending filters with empty lists is not confused for absence", () => {
    const empty: WireSpendSummary = {
      ...NEW_SUMMARY,
      filters: { providers: [], kinds: [], applied: { provider: null, kind: null } },
    };
    assert.deepEqual(spendPickLists(empty), { providers: [], kinds: [] });
  });
});

describe("firstIncompleteDay", () => {
  test("old API's daily row is reported incomplete", () => {
    const found = firstIncompleteDay(OLD_SUMMARY.daily);
    assert.equal(found?.day, "2026-08-22");
  });

  test("current API's daily row is complete", () => {
    assert.equal(firstIncompleteDay(NEW_SUMMARY.daily), null);
  });

  test("an empty series is not incomplete — that is the no-data case", () => {
    assert.equal(firstIncompleteDay([]), null);
  });

  test("a real zero is complete — absent and 0.00 are different answers", () => {
    const zeroed: WireSpendDailyItem[] = [
      {
        day: "2026-08-21",
        total_eur: 0,
        shadow_eur: 0,
        total_compute_eur: 0,
        calls: 0,
      },
    ];
    assert.equal(firstIncompleteDay(zeroed), null);
  });

  test("a NaN from a bad numeric cast counts as incomplete", () => {
    const nan: WireSpendDailyItem[] = [
      {
        day: "2026-08-20",
        total_eur: 0,
        shadow_eur: Number("not-a-number"),
        total_compute_eur: 0,
        calls: 3,
      },
    ];
    assert.equal(firstIncompleteDay(nan)?.day, "2026-08-20");
  });

  test("the FIRST incomplete row is returned, not the last", () => {
    const mixed: WireSpendDailyItem[] = [
      { day: "2026-08-19", total_eur: 0, shadow_eur: 1, total_compute_eur: 1, calls: 1 },
      { day: "2026-08-20", total_eur: 0, calls: 2 },
      { day: "2026-08-21", total_eur: 0, calls: 3 },
    ];
    assert.equal(firstIncompleteDay(mixed)?.day, "2026-08-20");
  });
});

describe("incompleteDayMessage", () => {
  test("names both missing fields and the day", () => {
    const msg = incompleteDayMessage(OLD_SUMMARY.daily[0]);
    assert.match(msg, /2026-08-22/);
    assert.match(msg, /shadow_eur and total_compute_eur/);
    assert.match(msg, /restart forge-control/);
  });

  test("names only the field that is actually missing", () => {
    const msg = incompleteDayMessage({
      day: "2026-08-20",
      total_eur: 0,
      total_compute_eur: 4,
      calls: 2,
    });
    assert.match(msg, /without shadow_eur\./);
    assert.equal(/total_compute_eur/.test(msg), false);
  });
});
