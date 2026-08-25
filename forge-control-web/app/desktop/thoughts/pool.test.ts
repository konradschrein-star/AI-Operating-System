/**
 * Tests for the THOUGHTS pool's derived readings.
 *
 * Run: npx tsx --test app/desktop/thoughts/pool.test.ts
 * (node --test via tsx, same runner as goals/quick-add.test.ts — pool.ts
 * imports nothing but types and the two API vocabularies, so no DOM and no
 * server has to exist.)
 *
 * What these pin is the surface's ONE claim: the leading number on a row is
 * the real age of a real idea, and the tone escalates with it. Every way that
 * can lie is a way the default view stops rebuking him — a "0d" that should
 * read "today", a stale idea drawn as fresh because it happens to be `done`,
 * or a summary line that quietly rounds the oldest age down.
 *
 * The vocabularies are asserted against the STORE's own sets, because the
 * round-1 client shipped capitalised areas and Postgres-flavoured statuses
 * that forge-control/src/lib/thoughts.ts rejects with a 400.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Idea } from "../../api";
import { AREAS, STATUSES, ageText, ageTone, countByArea, isSeed, isUnexecuted, viewSummary } from "./pool";

function idea(over: Partial<Idea> = {}): Idea {
  return {
    path: "Thoughts/Ideas/2026-01-01-a-thing.md",
    idea: "A thing",
    area: "business",
    importance: 5,
    status: "not-started",
    created: "2026-01-01",
    age_days: 10,
    author: "konrad",
    source: "konrad",
    description: "",
    why_genius: "",
    sha256: "deadbeef",
    ...over,
  };
}

describe("the vocabularies match the store", () => {
  test("five areas, lowercase, in Konrad's order", () => {
    assert.deepEqual([...AREAS], ["business", "youtube", "life", "health", "relationships"]);
  });

  test("five statuses, hyphenated — not the Postgres spellings", () => {
    assert.deepEqual([...STATUSES], ["not-started", "started", "executing", "done", "dropped"]);
    assert.equal(STATUSES.includes("not_started" as never), false);
    assert.equal(STATUSES.includes("in_progress" as never), false);
  });
});

describe("ageText", () => {
  test("a fresh capture reads 'today', never '0d'", () => {
    assert.equal(ageText(0), "today");
  });

  test("days are printed whole, with the unit", () => {
    assert.equal(ageText(1), "1d");
    assert.equal(ageText(417), "417d");
  });

  test("a negative age (clock skew) is not printed as a negative rebuke", () => {
    assert.equal(ageText(-3), "today");
  });

  test("a non-finite age throws rather than rendering 'NaNd'", () => {
    assert.throws(() => ageText(Number.NaN), /finite/);
  });
});

describe("ageTone — the escalation is what the default view is FOR", () => {
  test("under 30 days un-executed is fresh", () => {
    assert.equal(ageTone(idea({ age_days: 29 })), "fresh");
  });

  test("30 days is ageing, 90 is stale — the boundaries, not either side", () => {
    assert.equal(ageTone(idea({ age_days: 30 })), "ageing");
    assert.equal(ageTone(idea({ age_days: 89 })), "ageing");
    assert.equal(ageTone(idea({ age_days: 90 })), "stale");
  });

  test("an idea he actually started is never shamed, however old", () => {
    assert.equal(ageTone(idea({ age_days: 900, status: "executing" })), "settled");
    assert.equal(ageTone(idea({ age_days: 900, status: "done" })), "settled");
    assert.equal(ageTone(idea({ age_days: 900, status: "dropped" })), "settled");
  });

  test("…and 'started' counts as executed, per the store's own view split", () => {
    assert.equal(isUnexecuted(idea({ status: "started" })), false);
    assert.equal(isUnexecuted(idea({ status: "not-started" })), true);
  });
});

describe("isSeed", () => {
  test("author, not path — the path moves when the vault split lands", () => {
    assert.equal(isSeed(idea({ author: "forge", path: "Forge/Thoughts/Seeds/x.md" })), true);
    assert.equal(isSeed(idea({ author: "konrad", path: "Forge/Thoughts/Seeds/x.md" })), false);
    assert.equal(isSeed(idea({ author: "forge", path: "Thoughts/Ideas/x.md" })), true);
  });
});

describe("viewSummary", () => {
  test("names the oldest age in the pool it was handed", () => {
    const s = viewSummary("unexecuted", [idea({ age_days: 4 }), idea({ age_days: 212 }), idea({ age_days: 88 })]);
    assert.equal(s, "3 un-executed ideas · oldest 212d");
  });

  test("singular reads as one idea", () => {
    assert.equal(viewSummary("unexecuted", [idea({ age_days: 1 })]), "1 un-executed idea · oldest 1d");
  });

  test("an empty pool says so instead of claiming zero of something", () => {
    assert.equal(viewSummary("unexecuted", []), "nothing un-executed");
    assert.equal(viewSummary("executed", []), "nothing executed yet");
  });
});

describe("countByArea", () => {
  test("counts every area, including the ones at zero", () => {
    const c = countByArea([idea({ area: "health" }), idea({ area: "health" }), idea({ area: "youtube" })]);
    assert.deepEqual(c, { business: 0, youtube: 1, life: 0, health: 2, relationships: 0 });
  });
});
