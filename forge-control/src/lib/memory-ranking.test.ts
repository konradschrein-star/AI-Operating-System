/**
 * Tests for retrieval ranking (audit `rework-2026-08-04/03-rag-audit.md` §4.C).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The load-bearing tests here are:
 *  - "no source note takes more than MAX_CHUNKS_PER_NOTE slots" — the exact
 *    failure the audit measured (Operator Log ×5, one note filling every slot).
 *  - "a result set with nothing above the floor comes back empty" — returning
 *    nothing must stay possible; padding with 0.42 noise is the regression.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyNote,
  recencyWeight,
  weightFor,
  rankCandidates,
  MAX_CHUNKS_PER_NOTE,
  SCORE_FLOOR,
  type RankableCandidate,
} from "./memory-ranking.ts";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const DAY = 86_400_000;

/** mtime_ms is supplied explicitly everywhere so no test touches the disk. */
function cand(over: Partial<RankableCandidate> & { source_path: string }): RankableCandidate {
  return {
    chunk_index: 0,
    score: 0.7,
    mtime_ms: NOW,
    ...over,
  };
}

describe("classifyNote", () => {
  test("profile and spec notes are their own kinds", () => {
    assert.equal(classifyNote("Mentor/Profile/About Me.md", NOW), "profile");
    assert.equal(classifyNote("Mentor/log.md", NOW), "rolling-log"); // log wins
    assert.equal(
      classifyNote("AI OS/Specs/CRM Integration Plan (Twenty).md", NOW),
      "spec",
    );
    assert.equal(
      classifyNote("90_AI_OS/Spec - Personal AI OS Interface.md", NOW),
      "spec",
    );
  });

  test("rolling logs match on the trailing filename word, not just an exact name", () => {
    assert.equal(classifyNote("AI OS/Operator Log.md", NOW), "rolling-log");
    assert.equal(
      classifyNote("30_YouTube/TheSkyLab/TheSkyLab Production Log.md", NOW),
      "rolling-log",
    );
    assert.equal(classifyNote("Coach/log.md", NOW), "rolling-log");
    // …but a note that merely mentions logging is not a log.
    assert.equal(classifyNote("20_Coding/Logging Setup.md", NOW), "note");
  });

  test("daily notes split on their filename date, not their mtime", () => {
    assert.equal(classifyNote("Daily/2026-08-01.md", NOW), "daily-recent");
    assert.equal(classifyNote("Daily/2026-06-01.md", NOW), "daily-stale");
  });

  test("anything else is a plain note", () => {
    assert.equal(classifyNote("30_YouTube/Tested YTA Niches.md", NOW), "note");
  });
});

describe("recencyWeight", () => {
  test("a note edited today is not decayed", () => {
    assert.equal(recencyWeight(0), 1);
    assert.equal(recencyWeight(-3), 1); // clock skew, never a boost
  });

  test("decay is gentle enough not to bury evergreen notes", () => {
    // 180 days → ×0.9 exactly; the February bulk-written vault sits here.
    assert.ok(Math.abs(recencyWeight(180) - 0.9) < 1e-9);
    // …and it can never exceed the floor's worth of damage.
    assert.equal(recencyWeight(10_000), 0.85);
  });
});

describe("weightFor", () => {
  test("a profile note is boosted, a rolling log is cut", () => {
    const profile = weightFor(cand({ source_path: "Mentor/Profile/About Me.md" }), NOW);
    const log = weightFor(cand({ source_path: "AI OS/Operator Log.md" }), NOW);
    assert.equal(profile.kind, "profile");
    assert.ok(profile.weight > 1, `expected boost, got ${profile.weight}`);
    assert.ok(log.weight < 1, `expected penalty, got ${log.weight}`);
    assert.ok(profile.weight > log.weight);
  });

  test("a giant note takes an extra penalty for matching everything weakly", () => {
    const small = weightFor(
      cand({ source_path: "AI OS/SkyLab Production.md", chunk_count: 3 }),
      NOW,
    );
    const giant = weightFor(
      cand({ source_path: "AI OS/SkyLab Production.md", chunk_count: 249 }),
      NOW,
    );
    assert.ok(giant.weight < small.weight);
  });

  test("weights stay clamped — no prior can rescue or destroy a hit outright", () => {
    const worst = weightFor(
      cand({
        source_path: "AI OS/Operator Log.md",
        chunk_count: 999,
        mtime_ms: NOW - 3000 * DAY,
      }),
      NOW,
    );
    assert.ok(worst.weight >= 0.75, `clamp breached: ${worst.weight}`);
  });

  test("a path with no file on disk is neutral, never an exception", () => {
    const w = weightFor(
      cand({ source_path: "hermes://msg-abcdef", mtime_ms: null }),
      NOW,
    );
    assert.equal(w.ageDays, null);
    assert.equal(w.weight, 1);
  });
});

describe("rankCandidates", () => {
  /** The audit's Q9: five slots, all one note. */
  function operatorLogMonopoly(): RankableCandidate[] {
    return Array.from({ length: 12 }, (_, i) =>
      cand({
        source_path: "AI OS/Operator Log.md",
        chunk_index: i,
        score: 0.95 - i * 0.01,
        chunk_count: 54,
      }),
    );
  }

  test("no source note takes more than MAX_CHUNKS_PER_NOTE slots", () => {
    const out = rankCandidates(operatorLogMonopoly(), { limit: 5, now: NOW });
    assert.equal(out.length, MAX_CHUNKS_PER_NOTE);
    assert.deepEqual(
      out.map((h) => h.chunk_index),
      [0, 1],
      "the surviving chunks must be the note's strongest, not an arbitrary two",
    );
  });

  test("the cap leaves room for other notes instead of shrinking the page", () => {
    const mixed = [
      ...operatorLogMonopoly(),
      cand({ source_path: "Mentor/Profile/About Me.md", score: 0.62 }),
      cand({ source_path: "AI OS/Specs/CRM Integration Plan (Twenty).md", score: 0.61 }),
      cand({ source_path: "Daily/2026-08-04.md", score: 0.6 }),
    ];
    const out = rankCandidates(mixed, { limit: 5, now: NOW });
    const paths = new Set(out.map((h) => h.source_path));
    assert.equal(out.length, 5);
    assert.equal(paths.size, 4);
  });

  test("a result set with nothing above the floor comes back empty", () => {
    const noise = Array.from({ length: 20 }, (_, i) =>
      cand({ source_path: `30_YouTube/note-${i}.md`, score: 0.44 }),
    );
    assert.deepEqual(rankCandidates(noise, { limit: 5, now: NOW }), []);
  });

  test("the floor is applied to the weighted score, not the raw cosine", () => {
    // 0.52 raw is under the floor; a profile boost lifts it over.
    const below = SCORE_FLOOR - 0.03;
    const out = rankCandidates(
      [cand({ source_path: "Mentor/Profile/About Me.md", score: below })],
      { limit: 5, now: NOW },
    );
    assert.equal(out.length, 1);
    assert.ok(out[0].score >= SCORE_FLOOR);
    assert.equal(out[0].explain.raw_score, below);
  });

  test("weighting can reorder — a boosted profile overtakes a penalised log", () => {
    const out = rankCandidates(
      [
        cand({ source_path: "AI OS/Operator Log.md", score: 0.75, chunk_count: 54 }),
        cand({ source_path: "Mentor/Profile/About Me.md", score: 0.7 }),
      ],
      { limit: 5, now: NOW },
    );
    assert.equal(out[0].source_path, "Mentor/Profile/About Me.md");
  });

  test("floor: 0 is an escape hatch for diagnostics, not the default", () => {
    const noise = [cand({ source_path: "30_YouTube/x.md", score: 0.2 })];
    assert.equal(rankCandidates(noise, { limit: 5, now: NOW }).length, 0);
    assert.equal(
      rankCandidates(noise, { limit: 5, floor: 0, now: NOW }).length,
      1,
    );
  });
});
