/**
 * Tier inheritance for fix chains.
 *
 * ## Why this test is worth having
 *
 * This is the defect that put 38% of an overnight fleet run on the wrong
 * engine. `createFixChain` accepts an optional `tier`; the call site did not
 * pass one, so every fix-cycle builder and re-check row was born `tier: null`,
 * fell past TIER_MODELS and ran on the default engine — Claude — while every
 * project had been seeded `gemini` because that is what Konrad asked for.
 *
 * It produced no error, no log line and no failed task. The only symptom was a
 * bill and a model name in run metadata that nobody was reading. A watchdog hid
 * it for a while, and the ratio inverted the moment the watchdog stopped.
 *
 * A defect that is invisible in the output, expensive, and already
 * reintroduced once is exactly what a unit test is for. The fix shipped without
 * one; this is that test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inheritTier } from "./tier-inherit";
import type { TaskTier } from "../db/projects";

const row = (tier: TaskTier | null) => ({ tier });

const TICK_SRC = readFileSync(
  fileURLToPath(new URL("./project-tick.ts", import.meta.url)),
  "utf8",
);

describe("inheritTier — the normal case", () => {
  test("a gemini group yields gemini, which is the whole point", () => {
    assert.equal(inheritTier([row("gemini"), row("gemini"), row("gemini")]), "gemini");
  });

  test("a flagship group stays flagship — this does not hardcode one fleet", () => {
    assert.equal(inheritTier([row("flagship"), row("flagship")]), "flagship");
  });

  test("every tier round-trips", () => {
    for (const t of ["fast", "junior", "standard", "flagship", "gemini"] as const) {
      assert.equal(inheritTier([row(t)]), t);
    }
  });
});

describe("inheritTier — nothing to inherit", () => {
  test("no rows yields undefined, not null", () => {
    // `undefined` is "leave it unset" for createFixChain's optional param.
    // `null` would write an explicit null and defeat any default beneath it.
    const got = inheritTier([]);
    assert.equal(got, undefined);
    assert.notEqual(got, null);
  });

  test("all-null rows yield undefined", () => {
    assert.equal(inheritTier([row(null), row(null)]), undefined);
  });
});

describe("inheritTier — mixed tiers do not depend on row order", () => {
  test("nulls are skipped, not counted as a tier", () => {
    assert.equal(inheritTier([row(null), row(null), row("gemini")]), "gemini");
  });

  test("the majority tier wins regardless of which one the query returned first", () => {
    // The old `rows.find(r => r.tier != null)` returned "standard" here purely
    // because it came first — making the engine a function of an ORDER BY.
    assert.equal(
      inheritTier([row("standard"), row("gemini"), row("gemini")]),
      "gemini",
    );
    // Same multiset, different order, same answer. That is the property.
    assert.equal(
      inheritTier([row("gemini"), row("gemini"), row("standard")]),
      "gemini",
    );
    assert.equal(
      inheritTier([row("gemini"), row("standard"), row("gemini")]),
      "gemini",
    );
  });

  test("a tie is broken deterministically, toward first appearance", () => {
    assert.equal(inheritTier([row("gemini"), row("standard")]), "gemini");
    assert.equal(inheritTier([row("standard"), row("gemini")]), "standard");
    // Stateable and stable is the bar here; there is no "correct" majority in
    // a tie, but there must be a repeatable answer.
  });
});

describe("the call site actually uses it", () => {
  test("project-tick passes an inherited tier into createFixChain", () => {
    // The original bug was a MISSING argument, which no unit test of the helper
    // can see. Pin the wiring itself.
    assert.match(TICK_SRC, /import \{ inheritTier \} from "\.\/tier-inherit"/);
    assert.match(TICK_SRC, /const inheritedTier = inheritTier\(rows\)/);
    /* The chain's tier is no longer `inheritedTier` verbatim: since 2026-08-26
     * the PROJECT'S PIN outranks inheritance, and an unpinned chain is capped
     * off Opus. Both still have to reach createFixChain, so the derivation is
     * pinned as well as the hand-off — a `chainTier` that stopped reading
     * `inheritedTier` would silently revert this file's whole point. */
    assert.match(TICK_SRC, /const chainTier = pinnedTier \?\? cappedTier/);
    assert.match(TICK_SRC, /inheritedTier === "standard"/);
    assert.match(TICK_SRC, /tier: chainTier/);
  });

  test("the project pin outranks inheritance, and is read from the db layer", () => {
    /* MEASURED 2026-08-25: five projects pinned to `gemini`, twelve fix-chain
     * and re-check rows created afterwards, ZERO of them gemini — because the
     * pin was only ever read in routes/projects.ts, and fix chains are created
     * in project-tick. A pin that governs only the HTTP path governs almost
     * nothing on a busy project, where most rows are the fleet talking to
     * itself. */
    assert.match(TICK_SRC, /const pinnedTier = await getProjectTierPin\(projectId\)/);
    assert.match(
      TICK_SRC,
      /getProjectTierPin,/,
      "must import the shared resolver from the db layer rather than re-reading metadata here",
    );
  });

  test("the find-first version has not crept back", () => {
    assert.doesNotMatch(
      TICK_SRC,
      /rows\.find\(\(r\) => r\.tier != null\)/,
      "order-dependent inheritance was replaced on purpose",
    );
  });
});
