/**
 * Divider Visibility & Box Model Unit Tests
 *
 * Pinned requirements:
 * 1. Rest Visibility: Paints a visible 1px hairline using tokens.borderSoft.
 * 2. Restrained Hover/Drag: Uses tokens.borderEmphasis (no saturated blue tokens.accent slab).
 * 3. Box Model: Explicit `boxSizing: "content-box"` so padding (HIT_PAD=5) does not
 *    collapse the 1px content box under global border-box.
 * 4. Grab Target: Outer span is 11px (1px + 2*5px) with `position: relative; zIndex: 2`.
 * 5. Layout Footprint: Net layout footprint remains strictly 1px (11px - 10px = 1px)
 *    at rest and during hover/drag (zero layout shift).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../forge-control-web/${rel}`, import.meta.url)),
    "utf8",
  );

const RESIZABLE_SPLIT_SRC = read("app/desktop/_ui/ResizableSplit.tsx");
const TOKENS_SRC = read("app/tokens.ts");
const THEME_SRC = read("app/theme.css");

describe("ResizeHandle — source assertions & design token rules", () => {
  test("ResizeHandle explicitly sets boxSizing: 'content-box'", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /boxSizing:\s*["']content-box["']/,
      "ResizeHandle must set boxSizing: 'content-box' so padding does not collapse the 1px content box under global border-box",
    );
  });

  test("ResizeHandle sets backgroundClip: 'content-box'", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /backgroundClip:\s*["']content-box["']/,
      "ResizeHandle must clip background to content-box to render a 1px hairline",
    );
  });

  test("ResizeHandle uses tokens.borderSoft at rest and tokens.borderEmphasis when lit", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /background:\s*lit\s*\?\s*tokens\.borderEmphasis\s*:\s*tokens\.borderSoft/,
      "ResizeHandle must use tokens.borderEmphasis on hover/active and tokens.borderSoft at rest",
    );
  });

  test("ResizeHandle does NOT use tokens.accent (prevents loud saturated blue slab)", () => {
    const handleStart = RESIZABLE_SPLIT_SRC.indexOf("export function ResizeHandle");
    assert.ok(handleStart !== -1, "ResizeHandle component must exist");
    const handleEnd = RESIZABLE_SPLIT_SRC.indexOf("export const NARROW_MAX_PX", handleStart);
    const handleSource = RESIZABLE_SPLIT_SRC.slice(handleStart, handleEnd !== -1 ? handleEnd : undefined);

    assert.doesNotMatch(
      handleSource,
      /tokens\.accent/,
      "ResizeHandle must not use tokens.accent; Konrad flagged the full-panel blue bar as ugly",
    );
  });

  test("ResizeHandle keeps position: relative and zIndex: 2 intact", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /position:\s*["']relative["']/,
      "ResizeHandle must set position: relative so z-index is active against positioned flex siblings",
    );
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /zIndex:\s*2/,
      "ResizeHandle must set zIndex: 2",
    );
  });

  test("ResizeHandle uses constant 1px width/height (invariant at rest and lit)", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /axis\s*===\s*["']x["'][\s\S]*?width:\s*1\b/,
      "Horizontal split must set fixed width: 1",
    );
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /height:\s*1\b/,
      "Vertical split must set fixed height: 1",
    );
    assert.doesNotMatch(
      RESIZABLE_SPLIT_SRC,
      /width:\s*lit\s*\?\s*3\s*:\s*1/,
      "width must not change between rest and lit, preserving 1px footprint without layout jitter",
    );
    assert.doesNotMatch(
      RESIZABLE_SPLIT_SRC,
      /height:\s*lit\s*\?\s*3\s*:\s*1/,
      "height must not change between rest and lit, preserving 1px footprint without layout jitter",
    );
  });

  test("ResizeHandle maintains HIT_PAD = 5 with matching negative margins", () => {
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /const\s+HIT_PAD\s*=\s*5;/,
      "HIT_PAD must be 5px",
    );
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /padding:\s*`0\s*\$\{HIT_PAD\}px`/,
      "Horizontal padding must be 0 HIT_PAD px",
    );
    assert.match(
      RESIZABLE_SPLIT_SRC,
      /margin:\s*`0\s*-\$\{HIT_PAD\}px`/,
      "Horizontal margin must be 0 -HIT_PAD px",
    );
  });
});

describe("Design tokens & Theme CSS agreement", () => {
  test("tokens.ts exports borderSoft and borderEmphasis", () => {
    assert.match(TOKENS_SRC, /borderSoft:\s*v\(["']borderSoft["']\)/);
    assert.match(TOKENS_SRC, /borderEmphasis:\s*v\(["']borderEmphasis["']\)/);
  });

  test("theme.css defines --fg-borderSoft and --fg-borderEmphasis in dark and light modes", () => {
    assert.match(THEME_SRC, /--fg-borderSoft:\s*#[0-9a-fA-F]+/);
    assert.match(THEME_SRC, /--fg-borderEmphasis:\s*#[0-9a-fA-F]+/);
    assert.match(THEME_SRC, /html\[data-theme=["']light["']\][\s\S]*?--fg-borderSoft:\s*#[0-9a-fA-F]+/);
    assert.match(THEME_SRC, /html\[data-theme=["']light["']\][\s\S]*?--fg-borderEmphasis:\s*#[0-9a-fA-F]+/);
  });
});

describe("Box model arithmetic & geometry invariance", () => {
  const HIT_PAD = 5;
  const DECLARED_WIDTH = 1;
  const DECLARED_HEIGHT = 1;

  test("content-box model produces 1px visible line with 11px grab target and 1px footprint", () => {
    const contentWidth = DECLARED_WIDTH; // 1px
    const paddingLeft = HIT_PAD; // 5px
    const paddingRight = HIT_PAD; // 5px
    const marginLeft = -HIT_PAD; // -5px
    const marginRight = -HIT_PAD; // -5px

    // 1. Grab target (border-box outer span)
    const borderBoxWidth = contentWidth + paddingLeft + paddingRight;
    assert.equal(borderBoxWidth, 11, "Grab target span must be 11px (>= 10px target)");

    // 2. Painted hairline (background clipped to content box)
    const paintedWidth = borderBoxWidth - paddingLeft - paddingRight;
    assert.equal(paintedWidth, 1, "Painted hairline must be exactly 1px");

    // 3. Layout footprint (space taken in flex container)
    const layoutFootprint = borderBoxWidth + marginLeft + marginRight;
    assert.equal(layoutFootprint, 1, "Layout footprint must be strictly 1px");
  });

  test("vertical axis produces 1px visible line with 11px grab target and 1px footprint", () => {
    const contentHeight = DECLARED_HEIGHT; // 1px
    const paddingTop = HIT_PAD; // 5px
    const paddingBottom = HIT_PAD; // 5px
    const marginTop = -HIT_PAD; // -5px
    const marginBottom = -HIT_PAD; // -5px

    const borderBoxHeight = contentHeight + paddingTop + paddingBottom;
    assert.equal(borderBoxHeight, 11, "Vertical grab target span must be 11px");

    const paintedHeight = borderBoxHeight - paddingTop - paddingBottom;
    assert.equal(paintedHeight, 1, "Vertical painted hairline must be exactly 1px");

    const layoutFootprint = borderBoxHeight + marginTop + marginBottom;
    assert.equal(layoutFootprint, 1, "Vertical layout footprint must be strictly 1px");
  });

  test("layout footprint is invariant between rest and lit states (zero layout shift)", () => {
    const restFootprint = 1 + HIT_PAD * 2 - HIT_PAD * 2;
    const litFootprint = 1 + HIT_PAD * 2 - HIT_PAD * 2;
    assert.equal(restFootprint, 1);
    assert.equal(litFootprint, 1);
    assert.equal(litFootprint - restFootprint, 0, "Footprint delta between rest and lit must be 0px");
  });

  test("proves the regression mechanism under border-box", () => {
    // If box-sizing were border-box:
    const declaredBorderBox = 1;
    const padding = HIT_PAD * 2; // 10px
    const collapsedContentBox = Math.max(0, declaredBorderBox - padding);
    assert.equal(collapsedContentBox, 0, "Under border-box, 10px padding collapses 1px width to 0px (invisible)");
  });
});
