#!/usr/bin/env node
/**
 * contrast-role-tints.cjs — WCAG contrast gate for round 808's per-role chat
 * tints, in BOTH themes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY
 * ═══════════════════════════════════════════════════════════════════════════
 * Konrad asked for colour-coded worker messages. Colour-coding a transcript
 * means putting text on nine new backgrounds — eighteen surfaces once both
 * palettes are counted — and phase 800 §5.4 is the standing reminder of what
 * happens when nobody measures: CanvasPane's error banners shipped at 1.13:1
 * in light mode and a save conflict announced itself to nobody.
 *
 * Three colours sit on every tint and all three are asserted:
 *   text      `--fg-text`      the message body
 *   body      `--fg-textBody`  secondary prose inside it
 *   ink       `--fg-roleInk*`  the ROLE NAME in the header, which is the whole
 *                              point of the feature and the one that is hard —
 *                              a role hue is chosen to be distinguishable, not
 *                              to be legible, and those are different goals.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * METHOD — the same one as contrast-canvas-banners.cjs
 * ═══════════════════════════════════════════════════════════════════════════
 * Parse `forge-control-web/app/theme.css` for both palettes, composite, and
 * compute WCAG 2.1 relative luminance. No server, no browser, two seconds.
 *
 * ONE ADDITION: this file resolves `var(--fg-x)` INDIRECTION, one level and
 * then transitively, because the role inks are deliberately written as
 * references — `--fg-roleInkBuilder: var(--fg-accent)` — so that a role's
 * colour cannot drift from the token the Live rail and team panel already use
 * for it. A resolver is the price of not duplicating six hexes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/checks/contrast-role-tints.cjs
 *
 * Exit 0 = every role/theme/colour combination clears 4.5:1.
 * Exit 1 = one does not. Exit 2 = the check could not run.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const THEME_CSS = path.join(REPO_ROOT, "forge-control-web", "app", "theme.css");
const TARGET = 4.5;

/* ── colour maths (identical to contrast-canvas-banners.cjs) ──────────────── */

function parseHex(hex) {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) throw new Error(`not a hex colour: ${hex}`);
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

/* ── palettes, with var() indirection resolved ────────────────────────────── */

function readPalettes() {
  if (!fs.existsSync(THEME_CSS)) {
    console.error(`contrast: ${THEME_CSS} not found`);
    process.exit(2);
  }
  const css = fs.readFileSync(THEME_CSS, "utf8");
  const rootAt = css.indexOf(":root");
  const lightAt = css.indexOf('html[data-theme="light"]');
  if (rootAt < 0 || lightAt < 0 || lightAt < rootAt) {
    console.error(
      'contrast: theme.css no longer has a :root block followed by an html[data-theme="light"] block — this parser is out of date, fix it rather than trusting it',
    );
    process.exit(2);
  }
  const collect = (chunk) => {
    const out = {};
    for (const m of chunk.matchAll(/--fg-([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  const dark = collect(css.slice(rootAt, lightAt));
  /* Light INHERITS dark and overrides — which is exactly how the cascade
   * behaves, and why `--fg-roleInkBuilder: var(--fg-accent)` needs no light
   * declaration to end up as the light accent. */
  const light = { ...dark, ...collect(css.slice(lightAt)) };
  return { dark, light };
}

/**
 * Follow `var(--fg-x)` to a literal. Bounded at 8 hops: a cycle in the palette
 * is a bug worth a loud error, not a hang.
 */
function resolve(palette, name, hops = 0) {
  const raw = palette[name];
  if (raw === undefined) {
    console.error(`contrast: --fg-${name} is not declared in this palette`);
    process.exit(2);
  }
  const m = /^var\(\s*--fg-([\w-]+)\s*\)$/.exec(raw);
  if (!m) return raw;
  if (hops >= 8) {
    console.error(`contrast: --fg-${name} chases var() references in a cycle`);
    process.exit(2);
  }
  return resolve(palette, m[1], hops + 1);
}

/* ── the nine roles ───────────────────────────────────────────────────────── */

const ROLES = [
  "Architect",
  "Planner",
  "Builder",
  "Reviewer",
  "Researcher",
  "Scout",
  "Steward",
  "Tester",
  "Unknown",
];

function main() {
  const palettes = readPalettes();
  const rows = [];
  let failed = 0;

  for (const role of ROLES) {
    for (const mode of ["dark", "light"]) {
      const p = palettes[mode];
      const tintRaw = resolve(p, `roleBg${role}`);
      const inkRaw = resolve(p, `roleInk${role}`);
      /* The card sits on bgBody (the thread viewport), so a translucent tint
       * would composite over that. Every tint here is opaque on purpose —
       * composite() is applied anyway so the method does not silently depend
       * on that staying true. */
      const tint = composite(parseColour(tintRaw), parseColour(resolve(p, "bgBody")));
      const ratios = {
        text: contrast(composite(parseColour(resolve(p, "text")), tint), tint),
        body: contrast(composite(parseColour(resolve(p, "textBody")), tint), tint),
        ink: contrast(composite(parseColour(inkRaw), tint), tint),
      };
      const pass = ratios.text >= TARGET && ratios.body >= TARGET && ratios.ink >= TARGET;
      if (!pass) failed++;
      rows.push({ role, mode, tint: tintRaw, ink: inkRaw, ratios, pass });
    }
  }

  const f = (n) => `${n.toFixed(2)}:1`;
  console.log("Chat transcript role tints — WCAG contrast on the tint, both themes\n");
  console.log(
    "role         theme   tint      ink        text       body       ink        ",
  );
  console.log("-".repeat(88));
  for (const r of rows) {
    console.log(
      `${r.role.toLowerCase().padEnd(12)} ${r.mode.padEnd(7)} ${r.tint.padEnd(9)} ${r.ink.padEnd(10)} ` +
        `${f(r.ratios.text).padStart(9)}  ${f(r.ratios.body).padStart(9)}  ${f(r.ratios.ink).padStart(9)}  ` +
        `${r.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log(
    `\nink is --fg-roleInk<Role> with var() references resolved (five of them point at\n` +
      `the panel's own role tokens). Target ${TARGET}:1 for all three colours in BOTH themes.`,
  );

  if (failed) {
    console.error(`\nFAIL — ${failed} role/theme combination(s) below ${TARGET}:1.`);
    process.exit(1);
  }
  console.log(`\nPASS — all ${rows.length * 3} colour/tint/theme combinations clear ${TARGET}:1.`);
}

main();
