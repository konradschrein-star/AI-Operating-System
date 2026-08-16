#!/usr/bin/env node
/**
 * contrast-canvas-banners.cjs — WCAG contrast gate for CanvasPane's three
 * error banners, in BOTH themes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 800 round 804 measured what CanvasPane's banners actually rendered at:
 *
 *     #ffd8a8 on #5c3a0033   dark 14.50:1 ✓   light 1.13:1 ✗   conflict, watch
 *     #ffa8a8 on #5c000033   dark 11.13:1 ✓   light 1.12:1 ✗   error
 *
 * 1.13:1 is invisible. These are the pane's *error* banners, so in light mode a
 * save conflict or a dead freshness watcher announced itself to nobody and
 * Konrad's drawing silently failed to save. Round 806 swapped all three to the
 * `warn` / `bleed` token families. This file is the proof, and the guard against
 * the next person undoing it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * METHOD — deterministic by default, browser-confirmable on demand
 * ═══════════════════════════════════════════════════════════════════════════
 * DEFAULT: parse `forge-control-web/app/theme.css` for both palettes. It is the
 * source of truth for every `var(--fg-*)`, it needs no server and no browser, so
 * a reviewer can re-run this in two seconds and get the same numbers.
 *
 * `--url <base>`: additionally open a real page, flip
 * `document.documentElement.dataset.theme`, read the SAME variables back through
 * `getComputedStyle`, and assert they equal the parsed values. That closes the
 * one hole in the parse — that the stylesheet on disk is not what the browser
 * resolves — without making the everyday case depend on a build.
 *
 * Contrast is WCAG 2.1 relative luminance. Where a colour carries alpha (every
 * BEFORE value did) it is composited over the surface first, which is why the
 * report names the surface it composited over. Two surfaces are reported:
 *   bgCard — the pane's real parent, what the banner actually sits on.
 *   bgBody — what round 804 composited over, so its published numbers reproduce.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/checks/contrast-canvas-banners.cjs
 *   node scripts/checks/contrast-canvas-banners.cjs --url http://127.0.0.1:7811
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

const urlFlag = process.argv.indexOf("--url");
const BASE_URL = urlFlag > -1 ? process.argv[urlFlag + 1] : null;

/* ── colour maths ─────────────────────────────────────────────────────────── */

/** #rgb / #rgba / #rrggbb / #rrggbbaa → [r,g,b,a] with a in 0..1. */
function parseHex(hex) {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8)
    throw new Error(`not a hex colour: ${hex}`);
  const n = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
  return [n[0], n[1], n[2], n.length === 4 ? n[3] / 255 : 1];
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` as a browser serialises it. */
function parseRgbFn(str) {
  const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/);
  if (!m) throw new Error(`not an rgb() colour: ${str}`);
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
}

function parseColour(str) {
  return str.trim().startsWith("#") ? parseHex(str) : parseRgbFn(str);
}

/** Source-over composite of `fg` (may be translucent) onto opaque `bg`. */
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

/** Text over a (possibly translucent) banner background over an opaque surface. */
function ratio(colour, background, surface) {
  const bg = composite(parseColour(background), parseColour(surface));
  const fg = composite(parseColour(colour), bg);
  return contrast(fg, bg);
}

/* ── the palettes, read off theme.css ─────────────────────────────────────── */

/**
 * theme.css is two flat blocks: `:root { … }` for dark and
 * `html[data-theme="light"] { … }` for light. Slice on those two headers and
 * collect every `--fg-*: value;` in each — no CSS parser, and the shape is
 * asserted below rather than assumed.
 */
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
    for (const key of ["warn", "bleed", "freezeBgWarn", "dangerActionBg", "bgCard", "bgBody"]) {
      if (!p[key]) {
        console.error(`contrast: --fg-${key} missing from the ${name} palette`);
        process.exit(2);
      }
    }
  }
  return { dark, light };
}

/* ── the three banners ────────────────────────────────────────────────────── */

const BANNERS = [
  { id: "conflict", element: "save-conflict banner", before: ["#ffd8a8", "#5c3a0033"], after: ["warn", "freezeBgWarn"] },
  { id: "error", element: "load/save error banner", before: ["#ffa8a8", "#5c000033"], after: ["bleed", "dangerActionBg"] },
  { id: "watchErr", element: "freshness-watcher banner", before: ["#ffd8a8", "#5c3a0033"], after: ["warn", "freezeBgWarn"] },
];

/* ── browser confirmation ─────────────────────────────────────────────────── */

async function confirmInBrowser(palettes) {
  /* lib-703 owns the chromium path, the viewport and the session cookie; it
   * also refuses to launch without FORGE_SESSION_COOKIE, which is correct —
   * /desktop is behind OAuth and an unauthenticated sample would resolve the
   * signin page's variables, not the console's. PHASE700_BASE_URL must equal
   * --url so the cookie is minted for the right host. */
  process.env.PHASE700_BASE_URL = BASE_URL;
  const L = require(path.join(REPO_ROOT, "docs/plan/artifacts/phase700/lib-703.cjs"));
  const keys = ["warn", "bleed", "freezeBgWarn", "dangerActionBg", "bgCard", "bgBody"];
  const mismatches = [];
  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/desktop`, { waitUntil: "domcontentloaded" });
    for (const mode of ["dark", "light"]) {
      const seen = await page.evaluate(
        ([m, ks]) => {
          document.documentElement.dataset.theme = m;
          const cs = getComputedStyle(document.documentElement);
          return Object.fromEntries(ks.map((k) => [k, cs.getPropertyValue(`--fg-${k}`).trim()]));
        },
        [mode, keys],
      );
      for (const k of keys) {
        const declared = palettes[mode][k];
        const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
        if (norm(seen[k]) !== norm(declared))
          mismatches.push(`${mode} --fg-${k}: theme.css says ${declared}, browser resolved ${seen[k]}`);
      }
    }
    await page.close();
  });
  return mismatches;
}

/* ── report ───────────────────────────────────────────────────────────────── */

async function main() {
  const palettes = readPalettes();
  const rows = [];
  let failed = 0;

  for (const b of BANNERS) {
    for (const mode of ["dark", "light"]) {
      const p = palettes[mode];
      const after = ratio(p[b.after[0]], p[b.after[1]], p.bgCard);
      const afterOnBody = ratio(p[b.after[0]], p[b.after[1]], p.bgBody);
      const before = ratio(b.before[0], b.before[1], p.bgBody);
      const pass = after >= TARGET && afterOnBody >= TARGET;
      if (!pass) failed++;
      rows.push({
        banner: b.id,
        mode,
        before: `${b.before[0]} on ${b.before[1]}`,
        beforeRatio: before,
        after: `${b.after[0]} on ${b.after[1]}`,
        afterRatio: after,
        afterOnBodyRatio: afterOnBody,
        pass,
      });
    }
  }

  const f = (n) => `${n.toFixed(2)}:1`;
  console.log("CanvasPane error banners — WCAG contrast, before → after\n");
  console.log(
    "banner     theme  BEFORE (literal)          ratio      AFTER (token)                ratio      ",
  );
  console.log("-".repeat(112));
  for (const r of rows) {
    console.log(
      `${r.banner.padEnd(10)} ${r.mode.padEnd(6)} ${r.before.padEnd(25)} ${f(r.beforeRatio).padStart(9)}  ` +
        `${r.after.padEnd(28)} ${f(r.afterRatio).padStart(9)}  ${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(
    `\nBEFORE composited over bgBody (round 804's surface, so its published ` +
      `numbers reproduce).\nAFTER over bgCard, the pane's real parent; also checked over bgBody ` +
      `(${rows.map((r) => f(r.afterOnBodyRatio)).join(", ")}).\nTarget ${TARGET}:1 in BOTH themes.`,
  );

  if (BASE_URL) {
    const mismatches = await confirmInBrowser(palettes);
    if (mismatches.length) {
      console.error(`\nBROWSER CONFIRMATION FAILED — the page does not resolve what theme.css declares:`);
      for (const m of mismatches) console.error(`  ${m}`);
      process.exit(1);
    }
    console.log(`\nBrowser confirmation at ${BASE_URL}: every sampled --fg-* matches theme.css in both themes.`);
  }

  if (failed) {
    console.error(`\nFAIL — ${failed} banner/theme combination(s) below ${TARGET}:1.`);
    process.exit(1);
  }
  console.log(`\nPASS — all ${rows.length} banner/theme combinations clear ${TARGET}:1.`);
}

main().catch((err) => {
  console.error(`contrast: ${err.stack ?? err}`);
  process.exit(2);
});
