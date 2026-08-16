#!/usr/bin/env node
/**
 * no-raw-colours.cjs — the standing gate against hardcoded colour literals in
 * forge-control-web/app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * Three separate light-mode bugs have now shipped because a component wrote a
 * colour instead of a token. The tokens resolve through CSS custom properties,
 * so a literal simply does not follow the theme — it is not a style nit, it is
 * a functional defect that only appears in one of the two palettes:
 *
 *   phase 700 §5(c)  DesktopApp's `#141417` active-nav row — a black bar in
 *                    the left rail of a light console. Still open.
 *   phase 800 §5.3   `#101013` / `#0a0a0c` selected-row + tool-block at 8+
 *                    call sites — every selected chat stayed pitch black.
 *                    Fixed by adding `selectedBg` / `toolBg`.
 *   phase 800 §5.4   CanvasPane's three error banners: `#ffd8a8` on `#5c3a0033`
 *                    measured **1.13:1** in light mode. Invisible. A canvas
 *                    save conflict reported itself to nobody.
 *
 * Each was found by a human noticing. A grep that runs every phase is cheaper
 * than a reviewer noticing, which is what this file is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS A VIOLATION
 * ═══════════════════════════════════════════════════════════════════════════
 *   #rgb  #rgba  #rrggbb  #rrggbbaa          — any hex colour
 *   rgb(…)  rgba(…)  hsl(…)  hsla(…)         — ONLY when the arguments are
 *                                              literal numbers.
 *
 * `rgba(var(--fg-accent-rgb), 0.12)` is NOT a violation: it composes alpha over
 * a token and follows the theme correctly. That form is the sanctioned way to
 * get a translucent brand colour, and flagging it would push authors back to
 * literals — the exact opposite of the point. A `var(` anywhere inside the
 * parentheses excuses the call.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING. A gate that fires on a hex quoted in
 * a comment explaining a hex is noise, and noise is how gates get ignored.
 * `//` is honoured as a line comment except when preceded by `:` (so a URL's
 * `https://` does not blank the rest of the line), and block comments are
 * removed across lines. Line numbers survive the strip — blanked regions keep
 * their newlines — so every report still points at the real line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALLOWLIST — scripts/checks/raw-colour-allowlist.txt
 * ═══════════════════════════════════════════════════════════════════════════
 * FILE<TAB>ERE<TAB>REASON, the same shape and the same rule as
 * dollar-allowlist.txt: a hit is excused only if BOTH the file matches AND the
 * hit's own content matches the ERE. Listing a file does not blanket-excuse it
 * — a NEW, different literal landing in an already-listed file still fails.
 *
 * A reason beginning `TODO` marks acknowledged debt rather than a legitimate
 * carrier. Those hits do not fail the gate (they predate it and fixing them all
 * at once is exactly the sprawl this phase was told to avoid) but they are
 * printed in their own section on every run, with a count, so the debt stays
 * loud instead of disappearing into a green tick. Fix one, delete its line.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/checks/no-raw-colours.cjs           # gate: exit 1 on unlisted
 *   node scripts/checks/no-raw-colours.cjs --all     # print every hit, incl.
 *                                                    # allowlisted, then gate
 *
 * Exit 0 = no unlisted literal. Exit 1 = at least one, listed file:line:content.
 * Exit 2 = the gate itself could not run (missing tree, unreadable allowlist).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCAN_ROOT = path.join(REPO_ROOT, "forge-control-web", "app");
const ALLOWLIST = path.join(__dirname, "raw-colour-allowlist.txt");
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SHOW_ALL = process.argv.includes("--all");

/* ── patterns ─────────────────────────────────────────────────────────────── */

/** #rgb / #rgba / #rrggbb / #rrggbbaa, and nothing longer — the trailing
 *  lookahead stops `#deadbeef00` being read as a colour plus junk. */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/g;
/** rgb()/rgba()/hsl()/hsla() with no `var(` among the arguments. Non-greedy to
 *  the first `)`, which is correct precisely because a `var(` — the one nested
 *  paren that occurs here — is what the negated class excludes. */
const FUNC = /\b(?:rgba?|hsla?)\(\s*[^)]*\)/g;

/* ── comment stripping ────────────────────────────────────────────────────── */

/**
 * Blank out comments while preserving byte-for-byte line structure, so a hit's
 * line number is still the line number in the file the author opens.
 */
function stripComments(src) {
  const keepNewlines = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines) // /* … */, CSS and JS alike
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

/* ── allowlist ────────────────────────────────────────────────────────────── */

function readAllowlist() {
  if (!fs.existsSync(ALLOWLIST)) {
    console.error(`no-raw-colours: allowlist not found at ${ALLOWLIST}`);
    process.exit(2);
  }
  const rules = [];
  const lines = fs.readFileSync(ALLOWLIST, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const cols = line.split("\t");
    if (cols.length < 3) {
      console.error(
        `no-raw-colours: allowlist line ${i + 1} has ${cols.length} tab-separated ` +
          `columns, expected 3 (FILE<TAB>ERE<TAB>REASON): ${line}`,
      );
      process.exit(2);
    }
    const [file, pattern, ...reason] = cols;
    let re;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      console.error(
        `no-raw-colours: allowlist line ${i + 1} pattern is not a valid regex ` +
          `(${err.message}): ${pattern}`,
      );
      process.exit(2);
    }
    rules.push({ file: file.trim(), re, reason: reason.join("\t").trim() });
  });
  return rules;
}

/* ── scan ─────────────────────────────────────────────────────────────────── */

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full, out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function hitsIn(file) {
  const rel = path.relative(REPO_ROOT, file);
  const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    const found = [
      ...(line.match(HEX) ?? []),
      ...(line.match(FUNC) ?? []).filter((m) => !m.includes("var(")),
    ];
    for (const literal of found) {
      hits.push({ file: rel, line: i + 1, literal, content: line.trim() });
    }
  });
  return hits;
}

function main() {
  if (!fs.existsSync(SCAN_ROOT)) {
    console.error(`no-raw-colours: nothing to scan — ${SCAN_ROOT} does not exist`);
    process.exit(2);
  }

  const rules = readAllowlist();
  const hits = walk(SCAN_ROOT, []).sort().flatMap(hitsIn);

  const failures = [];
  const debt = [];
  const excused = [];

  for (const hit of hits) {
    const rule = rules.find((r) => r.file === hit.file && r.re.test(hit.content));
    if (!rule) failures.push(hit);
    else if (/^TODO/.test(rule.reason)) debt.push({ ...hit, reason: rule.reason });
    else excused.push({ ...hit, reason: rule.reason });
  }

  const show = (h) => `  ${h.file}:${h.line}  ${h.literal}\n      ${h.content}`;

  if (SHOW_ALL && excused.length) {
    console.log(`── ${excused.length} legitimate carrier(s), allowlisted ──`);
    for (const h of excused) console.log(`${show(h)}\n      → ${h.reason}`);
    console.log("");
  }

  if (debt.length) {
    console.log(
      `── ${debt.length} KNOWN DEBT hit(s): pre-existing literals, not this gate's ` +
        `fault and not silently forgiven ──`,
    );
    const byFile = new Map();
    for (const h of debt) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
    for (const [file, list] of byFile) {
      console.log(`  ${file}  (${list.length})  → ${list[0].reason}`);
      for (const h of list) console.log(`      :${h.line}  ${h.literal}`);
    }
    console.log("");
  }

  if (failures.length) {
    console.error(
      `── FAIL: ${failures.length} raw colour literal(s) with no allowlist entry ──`,
    );
    for (const h of failures) console.error(show(h));
    console.error(
      `\nUse a token from forge-control-web/app/tokens.ts. If the value genuinely ` +
        `cannot go\nthrough the cascade (WebGL, <canvas> 2D, image export, a ` +
        `palette definition),\nadd a FILE<TAB>ERE<TAB>REASON line to ` +
        `scripts/checks/raw-colour-allowlist.txt.`,
    );
    process.exit(1);
  }

  console.log(
    `no-raw-colours: PASS — ${hits.length} literal(s) across ` +
      `${new Set(hits.map((h) => h.file)).size} file(s), all accounted for ` +
      `(${excused.length} legitimate, ${debt.length} known debt, 0 unlisted).`,
  );
}

main();
