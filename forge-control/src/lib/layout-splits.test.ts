/**
 * Source assertions and bounds tests for the three new desktop layout splits:
 *   1. CanvasPane plan drawer (canvas-plan-split.ts)
 *   2. AutonomySurface category rail (autonomy-rail-split.ts)
 *   3. JournalSurface retro/mentor split (journal-split.ts)
 *
 * ## Why this test exists
 *
 * Konrad asked for adjustable panes across the desktop interface. Hardcoded
 * CSS widths, heights, or flexBasis values prevent users from resizing zones.
 * A screenshot looks identical whether a divider is draggable or inert.
 *
 * To avoid the regression where private, hand-rolled drag implementations
 * drift from the shared primitive (commits 46b6143 / b12b481), this suite pins:
 *   1. The bounds and initial defaults for each converted split in their
 *      respective sibling constants modules. Defaults match the original
 *      hardcoded constants so untouched layouts remain pixel-identical.
 *   2. Source-level wiring to the shared resize primitive
 *      (forge-control-web/app/desktop/_ui/ResizableSplit.tsx).
 *   3. The complete removal of old hardcoded constants (520, 220, "1 1 55%" /
 *      "1 1 45%") from live code paths.
 *   4. A repo-wide walk across desktop TSX files asserting that no component
 *      implements a private pointer-capture splitter drag handler outside
 *      the shared primitive.
 *
 * Precedent: ./team-plan-splitter.test.ts, ./chat-popover-hover.test.ts,
 *            ./source-hygiene.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANVAS_PLAN_INITIAL,
  CANVAS_PLAN_KEY,
  CANVAS_PLAN_MAX,
  CANVAS_PLAN_MIN,
} from "../../../forge-control-web/app/desktop/canvas-plan-split";

import {
  AUTONOMY_RAIL_INITIAL,
  AUTONOMY_RAIL_KEY,
  AUTONOMY_RAIL_MAX,
  AUTONOMY_RAIL_MIN,
} from "../../../forge-control-web/app/desktop/autonomy-rail-split";

import {
  JOURNAL_SPLIT_INITIAL,
  JOURNAL_SPLIT_KEY,
  JOURNAL_SPLIT_MAX,
  JOURNAL_SPLIT_MIN,
} from "../../../forge-control-web/app/desktop/journal-split";

const read = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../forge-control-web/${rel}`, import.meta.url)),
    "utf8",
  );

const CANVAS_SRC = read("app/desktop/CanvasPane.tsx");
const AUTONOMY_SRC = read("app/desktop/AutonomySurface.tsx");
const JOURNAL_SRC = read("app/desktop/JournalSurface.tsx");
const DESKTOP_DIR = fileURLToPath(
  new URL("../../../forge-control-web/app/desktop", import.meta.url),
);

describe("canvas plan split — bounds & defaults", () => {
  test("the default is CanvasPane's old 520px, so an untouched pane is unchanged", () => {
    assert.equal(CANVAS_PLAN_INITIAL, 520);
  });

  test("the bounds are sane pixel dimensions keeping both canvas and drawer usable", () => {
    assert.ok(CANVAS_PLAN_MIN > 0, "min drawer width must be positive");
    assert.equal(CANVAS_PLAN_MIN, 380, "min width preserves the old 380px floor");
    assert.ok(CANVAS_PLAN_MAX < 2000, "max drawer width must be a sane upper limit");
    assert.ok(
      CANVAS_PLAN_MIN < CANVAS_PLAN_INITIAL && CANVAS_PLAN_INITIAL < CANVAS_PLAN_MAX,
      "the default must sit strictly inside the min/max range",
    );
  });

  test("the key is namespaced under forge.layout.*", () => {
    assert.equal(CANVAS_PLAN_KEY, "forge.layout.canvas.planDrawer");
  });
});

describe("autonomy category rail split — bounds & defaults", () => {
  test("the default is AutonomySurface's old 220px, so an untouched rail is unchanged", () => {
    assert.equal(AUTONOMY_RAIL_INITIAL, 220);
  });

  test("the bounds are sane pixel dimensions keeping category labels and main content visible", () => {
    assert.ok(AUTONOMY_RAIL_MIN > 0, "min rail width must be positive");
    assert.equal(AUTONOMY_RAIL_MIN, 160, "min width keeps category badges visible");
    assert.ok(AUTONOMY_RAIL_MAX < 1000, "max rail width must be a sane upper limit");
    assert.ok(
      AUTONOMY_RAIL_MIN < AUTONOMY_RAIL_INITIAL && AUTONOMY_RAIL_INITIAL < AUTONOMY_RAIL_MAX,
      "the default must sit strictly inside the min/max range",
    );
  });

  test("the key is namespaced under forge.layout.*", () => {
    assert.equal(AUTONOMY_RAIL_KEY, "forge.layout.autonomy.categoryRail");
  });
});

describe("journal retro/mentor split — bounds & defaults", () => {
  test("the default is JournalSurface's old 55% retro allocation", () => {
    assert.equal(JOURNAL_SPLIT_INITIAL, 0.55);
  });

  test("the bounds are fractions strictly between 0 and 1 keeping both panes reachable", () => {
    assert.ok(JOURNAL_SPLIT_MIN > 0, "a zero floor lets the retro pane vanish");
    assert.ok(JOURNAL_SPLIT_MAX < 1, "a ceiling of 1 lets the mentor deck vanish");
    assert.ok(
      JOURNAL_SPLIT_MIN < JOURNAL_SPLIT_INITIAL && JOURNAL_SPLIT_INITIAL < JOURNAL_SPLIT_MAX,
      "the default must sit strictly inside the min/max fraction range",
    );
  });

  test("the key is namespaced under forge.layout.*", () => {
    assert.equal(JOURNAL_SPLIT_KEY, "forge.layout.journal.split");
  });
});

describe("canvas pane — wired to shared resize primitive", () => {
  test("imports useResizablePanel and ResizeHandle from _ui/ResizableSplit", () => {
    assert.match(
      CANVAS_SRC,
      /import \{ ResizeHandle, useResizablePanel \} from "\.\/_ui\/ResizableSplit"/,
    );
    assert.match(
      CANVAS_SRC,
      /import \{[\s\S]*?CANVAS_PLAN_INITIAL[\s\S]*?\} from "\.\/canvas-plan-split"/,
    );
  });

  test("configures horizontal inverted pixel resize for right-side drawer", () => {
    assert.match(CANVAS_SRC, /const planPanel = useResizablePanel\(\{/);
    assert.match(CANVAS_SRC, /storageKey: CANVAS_PLAN_KEY/);
    assert.match(CANVAS_SRC, /initial: CANVAS_PLAN_INITIAL/);
    assert.match(CANVAS_SRC, /min: CANVAS_PLAN_MIN/);
    assert.match(CANVAS_SRC, /max: CANVAS_PLAN_MAX/);
    assert.match(CANVAS_SRC, /axis: "x"/);
    assert.match(CANVAS_SRC, /unit: "px"/);
    assert.match(
      CANVAS_SRC,
      /invert: true/,
      "plan drawer is on the right, so dragging left expands it",
    );
  });

  test("renders ResizeHandle and binds drawer width to planPanel.size", () => {
    assert.match(CANVAS_SRC, /<ResizeHandle \{\.\.\.planPanel\.handleProps\} \/>/);
    assert.match(CANVAS_SRC, /width: planPanel\.size/);
  });

  test("hardcoded width 520 is gone from the live drawer style", () => {
    assert.doesNotMatch(
      CANVAS_SRC,
      /width:\s*520[,\s]/,
      "hardcoded width: 520 must not be present in the style object",
    );
  });

  test("no hand-rolled drag survives in CanvasPane", () => {
    for (const dup of ["setPointerCapture", "onPointerMove=", "clampPlanDrawer"]) {
      assert.doesNotMatch(
        CANVAS_SRC,
        new RegExp(dup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${dup} belongs to _ui/ResizableSplit, not to CanvasPane`,
      );
    }
  });
});

describe("autonomy surface — wired to shared resize primitive", () => {
  test("imports useResizablePanel and ResizeHandle from _ui/ResizableSplit", () => {
    assert.match(
      AUTONOMY_SRC,
      /import \{ ResizeHandle, useResizablePanel \} from "\.\/_ui\/ResizableSplit"/,
    );
    assert.match(
      AUTONOMY_SRC,
      /import \{[\s\S]*?AUTONOMY_RAIL_INITIAL[\s\S]*?\} from "\.\/autonomy-rail-split"/,
    );
  });

  test("configures horizontal non-inverted pixel resize for category rail", () => {
    assert.match(AUTONOMY_SRC, /const railPanel = useResizablePanel\(\{/);
    assert.match(AUTONOMY_SRC, /storageKey: AUTONOMY_RAIL_KEY/);
    assert.match(AUTONOMY_SRC, /initial: AUTONOMY_RAIL_INITIAL/);
    assert.match(AUTONOMY_SRC, /min: AUTONOMY_RAIL_MIN/);
    assert.match(AUTONOMY_SRC, /max: AUTONOMY_RAIL_MAX/);
    assert.match(AUTONOMY_SRC, /axis: "x"/);
    assert.match(AUTONOMY_SRC, /unit: "px"/);
    assert.match(
      AUTONOMY_SRC,
      /invert: false/,
      "category rail is on the left, handle on trailing edge",
    );
  });

  test("renders ResizeHandle and binds rail width to railPanel.size", () => {
    assert.match(AUTONOMY_SRC, /<ResizeHandle \{\.\.\.railPanel\.handleProps\} \/>/);
    assert.match(AUTONOMY_SRC, /width: railPanel\.size/);
  });

  test("hardcoded width 220 is gone from live category rail style", () => {
    const railStart = AUTONOMY_SRC.indexOf("{/* Category Rail */}");
    const railEnd = AUTONOMY_SRC.indexOf("<ResizeHandle {...railPanel.handleProps} />");
    assert.ok(railStart !== -1 && railEnd > railStart, "could not locate category rail section");
    const railSection = AUTONOMY_SRC.slice(railStart, railEnd);
    assert.doesNotMatch(
      railSection,
      /width:\s*220[,\s]/,
      "category rail container must use railPanel.size instead of hardcoded 220",
    );
  });

  test("no hand-rolled drag survives in AutonomySurface", () => {
    for (const dup of ["setPointerCapture", "onPointerMove=", "clampAutonomyRail"]) {
      assert.doesNotMatch(
        AUTONOMY_SRC,
        new RegExp(dup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${dup} belongs to _ui/ResizableSplit, not to AutonomySurface`,
      );
    }
  });
});

describe("journal surface — wired to shared resize primitive", () => {
  test("imports useResizablePanel and ResizeHandle from _ui/ResizableSplit", () => {
    assert.match(
      JOURNAL_SRC,
      /import \{ ResizeHandle, useNarrowViewport, useResizablePanel \} from "\.\/_ui\/ResizableSplit"/,
    );
    assert.match(
      JOURNAL_SRC,
      /import \{[\s\S]*?JOURNAL_SPLIT_INITIAL[\s\S]*?\} from "\.\/journal-split"/,
    );
  });

  test("configures horizontal fractional split for retro and mentor panes", () => {
    assert.match(JOURNAL_SRC, /const journalSplit = useResizablePanel\(\{/);
    assert.match(JOURNAL_SRC, /storageKey: JOURNAL_SPLIT_KEY/);
    assert.match(JOURNAL_SRC, /initial: JOURNAL_SPLIT_INITIAL/);
    assert.match(JOURNAL_SRC, /min: JOURNAL_SPLIT_MIN/);
    assert.match(JOURNAL_SRC, /max: JOURNAL_SPLIT_MAX/);
    assert.match(JOURNAL_SRC, /axis: "x"/);
    assert.match(JOURNAL_SRC, /unit: "fraction"/);
    assert.match(JOURNAL_SRC, /invert: false/);
  });

  test("renders ResizeHandle in !isNarrow and applies proportional flex styles", () => {
    assert.match(JOURNAL_SRC, /\{!isNarrow && <ResizeHandle \{\.\.\.journalSplit\.handleProps\} \/>\}/);
    assert.match(JOURNAL_SRC, /flex: isNarrow \? "1 1 auto" : `\$\{journalSplit\.size\} 1 0`/);
    assert.match(JOURNAL_SRC, /flex: isNarrow \? "1 1 auto" : `\$\{1 - journalSplit\.size\} 1 0`/);
  });

  test("old hardcoded flex percentages (1 1 55% / 1 1 45%) are gone from live layout", () => {
    assert.doesNotMatch(
      JOURNAL_SRC,
      /"1 1 55%"/,
      "hardcoded '1 1 55%' must not exist in JournalSurface code",
    );
    assert.doesNotMatch(
      JOURNAL_SRC,
      /"1 1 45%"/,
      "hardcoded '1 1 45%' must not exist in JournalSurface code",
    );
  });

  test("no hand-rolled drag survives in JournalSurface", () => {
    for (const dup of ["setPointerCapture", "onPointerMove=", "clampJournalSplit"]) {
      assert.doesNotMatch(
        JOURNAL_SRC,
        new RegExp(dup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${dup} belongs to _ui/ResizableSplit, not to JournalSurface`,
      );
    }
  });
});

describe("repo-wide check — no hand-rolled pointer-capture splitter drag handlers in desktop", () => {
  function walk(dir: string, relative = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(rel);
    }
    return out;
  }

  test("no desktop TSX component implements its own pointer-capture splitter outside ResizableSplit", () => {
    const files = walk(DESKTOP_DIR);

    // Instrument integrity: ensure the walk reaches real files
    assert.ok(files.length >= 50, `expected >=50 desktop TSX files, found ${files.length}`);
    assert.ok(files.includes("CanvasPane.tsx"), "walk must reach CanvasPane.tsx");
    assert.ok(files.includes("AutonomySurface.tsx"), "walk must reach AutonomySurface.tsx");
    assert.ok(files.includes("JournalSurface.tsx"), "walk must reach JournalSurface.tsx");
    assert.ok(files.includes("_ui/ResizableSplit.tsx"), "walk must reach _ui/ResizableSplit.tsx");

    // Permitted uses of pointer capture:
    // 1. _ui/ResizableSplit.tsx: the app's single designated resize primitive.
    // 2. _ui/MediaDocumentViewer.tsx: image document zoom/pan canvas (not a splitter).
    const EXEMPT = new Set<string>([
      "_ui/ResizableSplit.tsx",
      "_ui/MediaDocumentViewer.tsx",
    ]);

    const offenders: string[] = [];
    for (const rel of files) {
      if (EXEMPT.has(rel)) continue;
      const content = read(`app/desktop/${rel}`);
      if (content.includes("setPointerCapture")) {
        offenders.push(`${rel}: contains setPointerCapture`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "Hand-rolled pointer-capture drag handlers found outside _ui/ResizableSplit.tsx. " +
        "Use the shared useResizablePanel/ResizeHandle primitive instead:\n  " +
        offenders.join("\n  "),
    );
  });
});
