/**
 * The draggable divider between the team tree and the PLAN board.
 *
 * ## Why this test exists
 *
 * Konrad asked for a resizable divider twice and got a `borderBottom` twice.
 * PlanKanban hard-capped itself at `maxHeight: 40%` and the tree took the rest,
 * so the split was a CONSTANT — no state, no handler, nothing a pointer could
 * change. A screenshot of the rail looks identical whether the divider is
 * draggable or not, which is precisely how it shipped inert twice. Only a
 * source-level assertion catches that class of regression.
 *
 * ## What is pinned, and why these things
 *
 *   1. The panel uses the app's ONE resize primitive (`_ui/ResizableSplit`)
 *      rather than a second implementation of dragging. The first version of
 *      this fix hand-rolled pointer capture, persistence and a clamp — all of
 *      which already existed, reviewed, ten lines away. A parallel splitter
 *      drifts from the shell's.
 *   2. `invert: true` — the sized zone is BELOW the handle, so dragging up must
 *      GROW it. Get this wrong and the divider works perfectly backwards.
 *   3. PlanKanban actually drops its own 40% cap when the parent owns the
 *      height. Leave it in and dragging past 40% moves the handle and nothing
 *      else: the exact "it still isn't adjustable" bug, with a working
 *      splitter attached.
 *   4. The handle has a real hit target. A 1px grab strip is a pixel-hunt, and
 *      a divider you cannot catch is indistinguishable from one that does not
 *      move.
 *
 * Source assertions follow the precedent in ./chat-popover-hover.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PLAN_FRACTION_DEFAULT,
  PLAN_FRACTION_KEY,
  PLAN_FRACTION_MAX,
  PLAN_FRACTION_MIN,
} from "../../../forge-control-web/app/desktop/team/plan-split";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../forge-control-web/${rel}`, import.meta.url)), "utf8");

const PANEL_SRC = read("app/desktop/team/ChatTeamPanel.tsx");
const KANBAN_SRC = read("app/desktop/team/PlanKanban.tsx");
const SPLIT_SRC = read("app/desktop/_ui/ResizableSplit.tsx");

describe("plan splitter — bounds", () => {
  test("the default is PlanKanban's old 40%, so an untouched rail is unchanged", () => {
    assert.equal(PLAN_FRACTION_DEFAULT, 0.4);
  });

  test("the bounds are a real range that keeps both zones on screen", () => {
    assert.ok(PLAN_FRACTION_MIN > 0, "a zero floor lets a zone vanish with no way back");
    assert.ok(PLAN_FRACTION_MAX < 1, "a ceiling of 1 does the same to the team tree");
    assert.ok(
      PLAN_FRACTION_MIN < PLAN_FRACTION_DEFAULT && PLAN_FRACTION_DEFAULT < PLAN_FRACTION_MAX,
      "the default must sit strictly inside the range, or the first drag jumps",
    );
  });

  test("the key is namespaced with the shell's other layout keys", () => {
    assert.equal(PLAN_FRACTION_KEY, "forge.layout.teamPlanFraction");
  });
});

describe("plan splitter — it is wired to the shared primitive", () => {
  test("the panel uses useResizablePanel rather than a second splitter", () => {
    assert.match(PANEL_SRC, /import \{ ResizeHandle, useResizablePanel \} from "\.\.\/_ui\/ResizableSplit"/);
    assert.match(PANEL_SRC, /useResizablePanel\(\{/);
    assert.match(PANEL_SRC, /<ResizeHandle \{\.\.\.planHandleProps\}/);
  });

  test("no hand-rolled drag survives in the panel", () => {
    // The first cut of this fix duplicated all of these. If any comes back,
    // the panel has grown a private splitter again.
    for (const dup of ["setPointerCapture", "onPointerMove=", "clampPlanFraction"]) {
      assert.doesNotMatch(
        PANEL_SRC,
        new RegExp(dup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${dup} belongs to _ui/ResizableSplit, not to ChatTeamPanel`,
      );
    }
  });

  test("it is a vertical drag, inverted, measured as a fraction", () => {
    assert.match(PANEL_SRC, /axis: "y"/);
    assert.match(PANEL_SRC, /unit: "fraction"/);
    // The sized zone is BELOW the handle: without invert, dragging up shrinks
    // the thing you are dragging toward.
    assert.match(PANEL_SRC, /invert: true/);
  });

  test("the PLAN zone's height comes from the dragged fraction", () => {
    assert.match(PANEL_SRC, /flex: `0 0 \$\{\(planFraction \* 100\)/);
  });
});

describe("plan splitter — exactly one component owns the height", () => {
  test("ChatTeamPanel passes fill, PlanKanban drops its cap", () => {
    assert.match(PANEL_SRC, /^\s*fill$/m, "ChatTeamPanel must pass `fill` to PlanKanban");
    assert.match(
      KANBAN_SRC,
      /maxHeight: fill \? "none" : "40%"/,
      "with the 40% cap left in, dragging past 40% moves the handle and nothing else",
    );
    assert.match(KANBAN_SRC, /flex: fill \? "1 1 0" : "0 1 auto"/);
  });

  test("the team zone can shrink below its content", () => {
    // `flex: 1` alone leaves min-height:auto, so a long org chart refuses to
    // shrink and pushes the handle off the bottom of the rail.
    assert.match(PANEL_SRC, /flex: "1 1 0"/);
  });
});

describe("resize handle — the grab target is bigger than the line", () => {
  test("the handle pads its hit area without changing its footprint", () => {
    assert.match(SPLIT_SRC, /const HIT_PAD = \d+/);
    // Padding widens the target; backgroundClip keeps the paint on the 1px
    // rule; the negative margin gives the padding back to the layout so
    // nothing shifts.
    assert.match(SPLIT_SRC, /backgroundClip: "content-box"/);
    assert.match(SPLIT_SRC, /padding: `\$\{HIT_PAD\}px 0`/);
    assert.match(SPLIT_SRC, /margin: `-\$\{HIT_PAD\}px 0`/);
    assert.match(SPLIT_SRC, /padding: `0 \$\{HIT_PAD\}px`/);
    assert.match(SPLIT_SRC, /margin: `0 -\$\{HIT_PAD\}px`/);
  });

  test("the pad is big enough to catch and small enough not to swallow clicks", () => {
    const m = SPLIT_SRC.match(/const HIT_PAD = (\d+)/);
    assert.ok(m, "HIT_PAD must be a literal so this bound is checkable");
    const pad = Number(m[1]);
    assert.ok(pad >= 4, `a ${pad}px pad is still a pixel-hunt`);
    assert.ok(pad <= 8, `a ${pad}px pad starts eating the rows either side`);
  });

  test("the hit pad is actually on top — z-index needs a position to mean anything", () => {
    // z-index does not apply to a statically positioned box. The declaration
    // was inert from the day it was written; HIT_PAD is what made that matter,
    // because the pad reaches 5px into each neighbour and a sibling carrying
    // its own position+z-index (CanvasPane's plan drawer is relative/10) then
    // paints over half the grab target.
    assert.match(SPLIT_SRC, /position: "relative"/, "without this the zIndex below is decorative");
    const posAt = SPLIT_SRC.indexOf('position: "relative"');
    const zAt = SPLIT_SRC.indexOf("zIndex: 2");
    assert.ok(posAt !== -1 && zAt !== -1);
    assert.ok(
      Math.abs(zAt - posAt) < 400,
      "the position and the z-index must live in the same style object",
    );
  });

  test("both axes still declare their cursor and separator role", () => {
    assert.match(SPLIT_SRC, /cursor: "row-resize"/);
    assert.match(SPLIT_SRC, /cursor: "col-resize"/);
    assert.match(SPLIT_SRC, /role="separator"/);
    assert.match(SPLIT_SRC, /aria-orientation=\{axis === "x" \? "vertical" : "horizontal"\}/);
  });
});
