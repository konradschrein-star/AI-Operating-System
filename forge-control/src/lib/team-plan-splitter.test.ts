/**
 * The draggable divider between the team tree and the PLAN board.
 *
 * ## Why this test exists
 *
 * Konrad asked for a resizable divider twice and got a `borderBottom` twice.
 * The board hard-capped itself at `maxHeight: 40%` and the tree took the rest,
 * so the split was a CONSTANT — there was no state to change, no handler to
 * fire, and nothing a mouse could do about it. A screenshot of the rail looks
 * identical whether the divider is draggable or not, which is exactly how it
 * shipped inert twice.
 *
 * So this pins both halves:
 *
 *   1. the arithmetic, as real unit tests against ./plan-split — the clamp is
 *      where a resize goes wrong (drag past the edge, a panel too short for two
 *      zones, a corrupt stored value), and none of it needs a DOM;
 *   2. the affordances, as SOURCE assertions — that the handle actually carries
 *      pointer handlers, `cursor: row-resize`, pointer capture and a
 *      `role="separator"`. A component that computes a perfect fraction and
 *      renders a plain div is the bug we are preventing, and no arithmetic test
 *      would catch it.
 *
 * Source assertions follow the precedent in ./chat-popover-hover.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KEY_STEP,
  MIN_ZONE_PX,
  PLAN_FRACTION_DEFAULT,
  PLAN_FRACTION_KEY,
  clampPlanFraction,
  parseStoredFraction,
} from "../../../forge-control-web/app/desktop/team/plan-split";

const PANEL_SRC = readFileSync(
  fileURLToPath(
    new URL("../../../forge-control-web/app/desktop/team/ChatTeamPanel.tsx", import.meta.url),
  ),
  "utf8",
);

const KANBAN_SRC = readFileSync(
  fileURLToPath(
    new URL("../../../forge-control-web/app/desktop/team/PlanKanban.tsx", import.meta.url),
  ),
  "utf8",
);

describe("plan splitter — the clamp", () => {
  test("an ordinary drag is returned untouched", () => {
    assert.equal(clampPlanFraction(0.5, 800), 0.5);
    assert.equal(clampPlanFraction(0.25, 800), 0.25);
  });

  test("neither zone can be dragged below the floor", () => {
    const shell = 800;
    const floor = MIN_ZONE_PX / shell; // 0.12
    // Dragged to the very bottom: the PLAN zone keeps its floor.
    assert.equal(clampPlanFraction(0, shell), floor);
    // Dragged to the very top: the TEAM zone keeps its floor.
    assert.equal(clampPlanFraction(1, shell), 1 - floor);
    // And well past either edge.
    assert.equal(clampPlanFraction(-5, shell), floor);
    assert.equal(clampPlanFraction(99, shell), 1 - floor);
  });

  test("a panel too short for two floors splits evenly instead of inverting", () => {
    // 150px cannot hold two 96px zones. min (0.64) > max (0.36): feeding that
    // inverted range to Math.min/Math.max returns the WRONG bound silently,
    // which is the whole reason for the explicit branch.
    assert.equal(clampPlanFraction(0.4, 150), 0.5);
    assert.equal(clampPlanFraction(0.01, 150), 0.5);
    assert.equal(clampPlanFraction(0.99, 150), 0.5);
  });

  test("exactly two floors is still degenerate, and says so", () => {
    // shell == 2 * MIN_ZONE_PX -> min === max === 0.5. `min >= max` catches the
    // equality case too; a range of one point is not a range.
    assert.equal(clampPlanFraction(0.3, MIN_ZONE_PX * 2), 0.5);
  });

  test("asked before layout, it does not invent a measurement", () => {
    // shellPx 0 == first paint or a collapsed panel. No pixel floor exists yet.
    assert.equal(clampPlanFraction(0.4, 0), 0.4);
    assert.equal(clampPlanFraction(0.95, 0), 0.85);
    assert.equal(clampPlanFraction(0.02, 0), 0.15);
    assert.equal(clampPlanFraction(0.4, Number.NaN), 0.4);
  });

  test("a non-finite fraction falls back to the default rather than propagating", () => {
    assert.equal(clampPlanFraction(Number.NaN, 800), PLAN_FRACTION_DEFAULT);
    assert.equal(clampPlanFraction(Number.POSITIVE_INFINITY, 800), PLAN_FRACTION_DEFAULT);
  });
});

describe("plan splitter — persistence", () => {
  test("a good stored value round-trips", () => {
    assert.equal(parseStoredFraction("0.62"), 0.62);
  });

  test("every bad stored value yields the default", () => {
    for (const bad of [null, "", "   ", "null", "undefined", "NaN", "abc", "0", "1", "1.5", "-0.3"]) {
      assert.equal(
        parseStoredFraction(bad),
        PLAN_FRACTION_DEFAULT,
        `${JSON.stringify(bad)} should fall back to the default`,
      );
    }
  });

  test("the default is still PlanKanban's old 40%, so an untouched rail is unchanged", () => {
    assert.equal(PLAN_FRACTION_DEFAULT, 0.4);
  });
});

describe("plan splitter — the handle is real", () => {
  test("the divider is a separator with the drag handlers actually bound", () => {
    assert.match(PANEL_SRC, /data-team-plan-splitter/, "the handle must be findable in the DOM");
    assert.match(PANEL_SRC, /role="separator"/);
    assert.match(PANEL_SRC, /aria-orientation="horizontal"/);
    for (const handler of ["onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel"]) {
      assert.match(PANEL_SRC, new RegExp(`${handler}=\\{`), `${handler} must be bound`);
    }
  });

  test("it looks draggable and behaves like a drag", () => {
    assert.match(PANEL_SRC, /cursor: "row-resize"/, "a divider that does not say grab me is not a control");
    assert.match(PANEL_SRC, /setPointerCapture/, "a 7px strip loses the pointer without capture");
    assert.match(PANEL_SRC, /touchAction: "none"/, "otherwise a touch drag scrolls the rail instead");
  });

  test("it is reachable and resettable without a mouse", () => {
    assert.match(PANEL_SRC, /tabIndex=\{0\}/);
    assert.match(PANEL_SRC, /onKeyDown=\{onSplitterKeyDown\}/);
    assert.match(PANEL_SRC, /onDoubleClick=/, "double-click is the way back from a bad drag");
    assert.ok(KEY_STEP > 0 && KEY_STEP < 0.2, "an arrow nudge should be a nudge");
  });

  test("the fraction is persisted under the shared key", () => {
    assert.match(PANEL_SRC, /PLAN_FRACTION_KEY/);
    assert.equal(PLAN_FRACTION_KEY, "forge.teamPanel.planFraction");
  });

  test("exactly one component decides the height", () => {
    // The bug this prevents: the splitter sets a flex-basis while PlanKanban
    // still caps itself at 40%, so dragging past 40% moves the handle and
    // nothing else. `fill` is how the parent takes ownership.
    assert.match(PANEL_SRC, /fill\s*$/m, "ChatTeamPanel must pass `fill` to PlanKanban");
    assert.match(
      KANBAN_SRC,
      /maxHeight: fill \? "none" : "40%"/,
      "PlanKanban must drop its own cap when the parent owns the height",
    );
    assert.match(KANBAN_SRC, /flex: fill \? "1 1 0" : "0 1 auto"/);
  });

  test("the team zone can shrink, or the handle gets pushed off the bottom", () => {
    // `flex: 1` alone keeps min-height:auto on a long org chart and the tree
    // refuses to shrink below its content.
    assert.match(PANEL_SRC, /flex: "1 1 0"/);
  });
});
