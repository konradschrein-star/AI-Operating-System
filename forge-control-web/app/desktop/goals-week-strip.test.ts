/**
 * Tests for `weekStripText` — the header honesty line on the week board
 * (PLAN.md §3.3): "this week moved: <goal> (n) · … · k done tasks unlinked",
 * or, when nothing linked to a goal moved, exactly
 * "nothing linked to a goal moved this week" — Konrad's own doctrine as the
 * sentence, not a chart nobody reads.
 *
 * Run: npx tsx --test app/desktop/goals-week-strip.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { weekStripText } from "./GoalsSurface";

describe("weekStripText", () => {
  test("nothing moved — the sentence is the point, not a formatted zero", () => {
    assert.equal(
      weekStripText({ moved: [], unlinked_done: 0 }),
      "nothing linked to a goal moved this week",
    );
  });

  test("nothing moved, but unlinked tasks still closed — moved stays empty, no unlinked count leaks in", () => {
    assert.equal(
      weekStripText({ moved: [], unlinked_done: 5 }),
      "nothing linked to a goal moved this week",
    );
  });

  test("one goal moved, everything else linked", () => {
    assert.equal(
      weekStripText({ moved: [{ title: "Ship the console", tasks_done: 3 }], unlinked_done: 0 }),
      "this week moved: Ship the console (3) · 0 done tasks unlinked",
    );
  });

  test("several goals, joined with the middle dot, honesty counter trailing", () => {
    assert.equal(
      weekStripText({
        moved: [
          { title: "Ship the console", tasks_done: 3 },
          { title: "Grow TheSkyLab", tasks_done: 1 },
        ],
        unlinked_done: 2,
      }),
      "this week moved: Ship the console (3) · Grow TheSkyLab (1) · 2 done tasks unlinked",
    );
  });

  test("singular vs plural on the trailing unlinked count", () => {
    assert.equal(
      weekStripText({ moved: [{ title: "X", tasks_done: 1 }], unlinked_done: 1 }),
      "this week moved: X (1) · 1 done task unlinked",
    );
  });
});
