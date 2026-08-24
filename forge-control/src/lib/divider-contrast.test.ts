/**
 * The divider has to be VISIBLE, not merely painted.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * WHY THIS FILE EXISTS. Round 1 of aios-divider-visibility fixed the real bug
 * — `box-sizing: border-box` was collapsing the handle's content box to 0px, so
 * `backgroundClip: content-box` painted nothing — and every check went green:
 * painted width 1px, hit pad 11px, grabbable 11, stolen 0, on every surface.
 * The dividers were still invisible. The colour it shipped, `borderSoft`
 * (#161617), is 1.16:1 against this theme's #000 body.
 *
 * "Painted" and "visible" are different properties and the first does not imply
 * the second. Every gate measured geometry; none measured luminance, so nothing
 * could fail. That is the gap this closes.
 *
 * The thresholds are deliberately not WCAG text ratios — a 1px structural
 * hairline is not text and 4.5:1 would be a bright line down the middle of the
 * console, which is how the old saturated-blue version got called "ugly". They
 * are the floor at which a hairline is discernible at all (rest) and
 * unmistakable under the pointer (hover).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const THEME = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../forge-control-web/app/theme.css",
);

/** Relative luminance, WCAG 2.x definition. */
function luminance([r, g, b]: readonly [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hex(raw: string): [number, number, number] {
  let s = raw.trim().replace(/^#/, "");
  if (s.length === 3) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  assert.match(s, /^[0-9a-fA-F]{6}$/, `not a hex colour: ${raw}`);
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

/**
 * Pull the token values for one theme block out of theme.css.
 *
 * Reads the FILE rather than a JS constant on purpose: the values only exist as
 * CSS custom properties, and a test that re-declared them in TypeScript would
 * pass forever while the stylesheet drifted underneath it.
 */
function themeVars(which: "dark" | "light"): Record<string, string> {
  const css = readFileSync(THEME, "utf8");
  // The dark theme is the :root default; the light theme overrides it further
  // down the file. Splitting on the light override's first token gives two
  // halves, each of which contains only its own declarations.
  const lightStart = css.indexOf("--fg-bgBody: #f7f7f5");
  assert.ok(lightStart > 0, "could not find the light-theme block in theme.css");
  const block = which === "dark" ? css.slice(0, lightStart) : css.slice(lightStart);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--fg-([A-Za-z]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    // First occurrence wins in the dark half; last wins in the light half.
    // Either way the value we want is the one this block actually sets.
    out[m[1]] = m[2];
  }
  return out;
}

/** A hairline this faint is painted but not perceivable. */
const REST_FLOOR = 1.5;
/** Hover must be an obvious state change, not a nuance. */
const HOVER_FLOOR = 2.2;

for (const theme of ["dark", "light"] as const) {
  describe(`D1 divider contrast — ${theme} theme`, () => {
    const v = themeVars(theme);

    test("the handle tokens exist", () => {
      assert.ok(v.borderHandle, "--fg-borderHandle missing");
      assert.ok(v.borderHandleHover, "--fg-borderHandleHover missing");
      assert.ok(v.bgBody, "--fg-bgBody missing");
      assert.ok(v.bgCard, "--fg-bgCard missing");
    });

    test("at rest the divider is discernible against BOTH surfaces it can sit on", () => {
      for (const surface of ["bgBody", "bgCard"] as const) {
        const r = contrast(hex(v.borderHandle), hex(v[surface]));
        assert.ok(
          r >= REST_FLOOR,
          `borderHandle ${v.borderHandle} on ${surface} ${v[surface]} is ${r.toFixed(2)}:1, below ${REST_FLOOR}:1 — painted but invisible`,
        );
      }
    });

    test("hover is an unmistakable step up, not a nuance", () => {
      const rest = contrast(hex(v.borderHandle), hex(v.bgBody));
      const hover = contrast(hex(v.borderHandleHover), hex(v.bgBody));
      assert.ok(
        hover >= HOVER_FLOOR,
        `hover is ${hover.toFixed(2)}:1, below ${HOVER_FLOOR}:1`,
      );
      assert.ok(
        hover > rest * 1.25,
        `hover ${hover.toFixed(2)}:1 is not a clear step up from rest ${rest.toFixed(2)}:1`,
      );
    });

    /* The regression this whole file is about, stated as an assertion: the
     * border scale is too quiet for this job, so if someone reaches for it
     * again the suite says why instead of going green. */
    test("the border scale is NOT good enough here — the reason the handle has its own token", () => {
      for (const name of ["borderSoft", "borderDivider", "borderEmphasis"] as const) {
        const r = contrast(hex(v[name]), hex(v.bgBody));
        if (theme === "dark") {
          assert.ok(
            r < REST_FLOOR,
            `${name} is now ${r.toFixed(2)}:1 on #000 — if the border scale was re-toned, re-decide whether the handle still needs its own token instead of leaving both`,
          );
        }
      }
      const handle = contrast(hex(v.borderHandle), hex(v.bgBody));
      const best = Math.max(
        ...(["borderSoft", "borderDivider", "borderEmphasis"] as const).map((n) =>
          contrast(hex(v[n]), hex(v.bgBody)),
        ),
      );
      assert.ok(
        handle > best,
        `borderHandle ${handle.toFixed(2)}:1 is not brighter than the best border token ${best.toFixed(2)}:1`,
      );
    });
  });
}

describe("D2 the handle actually uses those tokens", () => {
  const SRC = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../forge-control-web/app/desktop/_ui/ResizableSplit.tsx",
  );

  test("ResizeHandle paints borderHandle / borderHandleHover and nothing quieter", () => {
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /backgroundColor:\s*lit\s*\?\s*tokens\.borderHandleHover\s*:\s*tokens\.borderHandle/);
    // The bug that started this: `background` is a shorthand and React's style
    // diffing re-applies only the key that changed, resetting backgroundClip.
    assert.doesNotMatch(
      src,
      /^\s*background:\s*lit/m,
      "the `background` SHORTHAND resets backgroundClip on the first hover — use backgroundColor",
    );
  });
});
