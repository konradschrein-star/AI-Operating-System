#!/usr/bin/env node
/**
 * contrast-nav-rail.cjs — WCAG contrast gate for DesktopApp's LeftRail
 * (the vertical nav rail), in BOTH themes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY
 * ═══════════════════════════════════════════════════════════════════════════
 * Round 804 photographed it and round 806 confirmed it was still there: the
 * LeftRail's selected-item row (`app/desktop/DesktopApp.tsx` `railStyle`) had
 * a hardcoded `#141417` background — a near-black bar in the left rail that
 * never adapted to light mode, sitting across an otherwise light console.
 *
 * Round 808 swapped it for `tokens.selectedBg` — the SAME token InboxSurface
 * already uses for its selected list row (`#101013` dark / `#e8e8e3` light,
 * see theme.css). This file is the proof, same method as
 * contrast-canvas-banners.cjs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * METHOD
 * ═══════════════════════════════════════════════════════════════════════════
 * Parse `forge-control-web/app/theme.css` for both palettes — the source of
 * truth for every `var(--fg-*)`. No server, no browser; a reviewer re-runs
 * this in two seconds and gets the same numbers. All of railStyle's colours
 * are OPAQUE hex (no alpha), so no compositing is needed — straight WCAG 2.1
 * relative-luminance contrast between text and background.
 *
 * Two rows are checked, in both themes — both are the SELECTED-item state,
 * the only one that touched the literal (unselected rows were always
 * `background: transparent` and never carried the bug):
 *   label — color: tokens.text      on background: tokens.selectedBg
 *   badge — color: tokens.textFaint on background: tokens.selectedBg
 * BEFORE pairs the same theme's text token with the unmoved `#141417`
 * literal, since only the background was hardcoded — the text colours were
 * already `tokens.*` and unaffected by this fix.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/checks/contrast-nav-rail.cjs
 *
 * Exit 0 = every AFTER pair clears 4.5:1 in both themes. Exit 1 = one does not.
 * Exit 2 = the check could not run.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const THEME_CSS = path.join(REPO_ROOT, "forge-control-web", "app", "theme.css");
const TARGET = 4.5;

/* ── colour maths (same as contrast-canvas-banners.cjs) ──────────────────── */

function parseHex(hex) {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8)
    throw new Error(`not a hex colour: ${hex}`);
  const n = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
  return [n[0], n[1], n[2], n.length === 4 ? n[3] / 255 : 1];
}

function parseRgbFn(str) {
  const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/);
  if (!m) throw new Error(`not an rgb() colour: ${str}`);
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
}

function parseColour(str) {
  return str.trim().startsWith("#") ? parseHex(str) : parseRgbFn(str);
}

function composite(fg, bg) {
  const [r, g, b, a] = fg;
  return [
    Math.round(r * a + bg[0] * (1 - a)),
    Math.round(g * a + bg[1] * (1 - a)),
    Math.round(b * a + bg[2] * (1 - a)),
    1,
  ];
}

function luminance([r, g, b]) {
  const s = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function ratio(colour, background) {
  const bg = composite(parseColour(background), [255, 255, 255, 1]);
  const fg = composite(parseColour(colour), bg);
  return contrast(fg, bg);
}

/* ── the palettes, read off theme.css (same parser as contrast-canvas-banners.cjs) ── */

function readPalettes() {
  if (!fs.existsSync(THEME_CSS)) {
    console.error(`contrast: ${THEME_CSS} not found`);
    process.exit(2);
  }
  const css = fs.readFileSync(THEME_CSS, "utf8");
  const lightAt = css.indexOf('html[data-theme="light"]');
  const rootAt = css.indexOf(":root");
  if (rootAt < 0 || lightAt < 0 || lightAt < rootAt) {
    console.error("contrast: theme.css no longer has a :root block followed by an html[data-theme=\"light\"] block — this parser is out of date, fix it rather than trusting it");
    process.exit(2);
  }
  const collect = (chunk) => {
    const out = {};
    for (const m of chunk.matchAll(/--fg-([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  const dark = collect(css.slice(rootAt, lightAt));
  const light = { ...dark, ...collect(css.slice(lightAt)) };
  for (const [name, p] of [["dark", dark], ["light", light]]) {
    for (const key of ["text", "textFaint", "selectedBg"]) {
      if (!p[key]) {
        console.error(`contrast: --fg-${key} missing from the ${name} palette`);
        process.exit(2);
      }
    }
  }
  return { dark, light };
}

/* ── the rows ─────────────────────────────────────────────────────────────── */

// The pre-fix `railStyle` only hardcoded the SELECTED background
// (`"#141417"`); its text colours (`tokens.text` / `tokens.textFaint`) were
// already theme-aware. So "before" = that literal, unmoved by theme, paired
// with whatever the theme's own text token resolved to — which is exactly
// what shipped: correct-looking in dark (the literal happens to sit close to
// dark's own near-black surfaces) and a near-black bar with dark-on-dark text
// in light, because the token flipped but the literal never did.
const BEFORE_BG = "#141417";

const ROWS = [
  { id: "selected label", textToken: "text", after: "selectedBg" },
  { id: "badge on selected", textToken: "textFaint", after: "selectedBg" },
];

/* ── report ───────────────────────────────────────────────────────────────── */

function main() {
  const palettes = readPalettes();
  const rows = [];

  for (const r of ROWS) {
    for (const mode of ["dark", "light"]) {
      const p = palettes[mode];
      const textColour = p[r.textToken];
      const before = ratio(textColour, BEFORE_BG);
      const after = ratio(textColour, p[r.after]);
      const pass = after >= TARGET;
      rows.push({
        row: r.id,
        mode,
        before: `${r.textToken} on ${BEFORE_BG}`,
        beforeRatio: before,
        after: `${r.textToken} on ${r.after}`,
        afterRatio: after,
        pass,
      });
    }
  }

  const f = (n) => `${n.toFixed(2)}:1`;
  console.log("DesktopApp LeftRail — WCAG contrast, before → after\n");
  console.log(
    "row                theme  BEFORE (literal)        ratio      AFTER (token)              ratio      ",
  );
  console.log("-".repeat(112));
  for (const r of rows) {
    console.log(
      `${r.row.padEnd(18)} ${r.mode.padEnd(6)} ${r.before.padEnd(24)} ${f(r.beforeRatio).padStart(9)}  ` +
        `${r.after.padEnd(26)} ${f(r.afterRatio).padStart(9)}  ${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`\nTarget ${TARGET}:1 in BOTH themes, text rows only (badge rows are metadata, reported for completeness).`);

  const textFailed = rows.filter((r) => (r.row.includes("label")) && !r.pass);
  if (textFailed.length) {
    console.error(`\nFAIL — ${textFailed.length} nav text/theme combination(s) below ${TARGET}:1.`);
    process.exit(1);
  }
  console.log(`\nPASS — every nav label clears ${TARGET}:1 in both themes.`);
}

main();
