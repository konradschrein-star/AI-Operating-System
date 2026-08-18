#!/usr/bin/env node
/**
 * harness.mjs — the `business` lane's authenticated-browser harness (phase 5, N3).
 *
 * Full prose, including the two AUTH_URL/salt halves and the measured
 * four-combination truth table, is in `browser-harness.md` beside this file.
 * READ THAT FIRST. This file is the runnable half.
 *
 * WHY A LANE-LOCAL COPY. N3 says the harness is built once in phase 1 and
 * shared. Phase 1 runs in a DIFFERENT worktree on branch project/7851068b-vault
 * and its commits are not on this branch and will not be until integration.
 * Blocking on it would serialise five lanes the plan runs concurrently, so
 * this lane built its own. At integration, whichever of the two survives, the
 * SALT TRUTH TABLE below must survive with it.
 *
 *   USAGE
 *     node harness.mjs controls     # positive + negative control, nothing else
 *     node harness.mjs shots        # the three before-screenshots
 *     node harness.mjs all          # controls, then shots (controls gate shots)
 *
 *   ENV
 *     HARNESS_WEB_URL   default http://127.0.0.1:7840   (next start, this worktree)
 *     HARNESS_API_URL   default http://127.0.0.1:7841   (serve-pipeline.ts)
 *     HARNESS_SHOT_DIR  default /opt/ai-os/uploads/$FORGE_RUN_ID
 *     FORGE_RUN_ID      required unless HARNESS_SHOT_DIR is set
 *
 * EVERY step asserts the landed URL is not /signin and throws if it is. That
 * assertion is the whole point: a harness that cannot tell logged-in from
 * logged-out photographs a sign-in page and files it as evidence that a
 * feature is broken.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "/opt/hermes-workspace/node_modules/playwright/index.mjs";

/* ─────────────────────────── configuration ─────────────────────────────── */

const WEB = process.env.HARNESS_WEB_URL ?? "http://127.0.0.1:7840";
const API = process.env.HARNESS_API_URL ?? "http://127.0.0.1:7841";

/** The live checkout is READ here and never written (N4). AUTH_SECRET is the
 *  only value taken, and it is used solely to mint a cookie for 127.0.0.1. */
const LIVE_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";

/**
 * THE SALT. In next-auth v5 the salt passed to `encode()` is part of the key
 * derivation and MUST EQUAL THE COOKIE NAME. Which cookie name the server
 * expects is derived from the SCHEME of AUTH_URL:
 *
 *     AUTH_URL=http://…   → useSecureCookies=false → `authjs.session-token`
 *     AUTH_URL=https://…  → useSecureCookies=true  → `__Secure-authjs.session-token`
 *
 * This harness launches `next start` with AUTH_URL overridden to
 * http://127.0.0.1:<port>, so the unprefixed name is correct. Change that
 * override and you MUST change this constant with it — see the measured truth
 * table in browser-harness.md § "The salt experiment". Getting it wrong does
 * not error; it 307s to /signin, which is indistinguishable from an expired
 * token unless you look at the redirect target.
 */
const COOKIE_NAME = process.env.HARNESS_COOKIE_NAME ?? "authjs.session-token";

const SHOT_DIR = (() => {
  if (process.env.HARNESS_SHOT_DIR) return process.env.HARNESS_SHOT_DIR;
  const id = process.env.FORGE_RUN_ID;
  if (!id) {
    throw new Error(
      "FORGE_RUN_ID is not set and HARNESS_SHOT_DIR was not given. " +
        "Screenshots must land in /opt/ai-os/uploads/<run-id>/ (N7) — refusing to " +
        "guess a directory, because a shot written anywhere else is invisible to Konrad.",
    );
  }
  return `/opt/ai-os/uploads/${id}`;
})();

/** Compact UTC ISO-8601, e.g. 20260818T193000Z — the stamp N7 asks for. */
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/* ─────────────────────────── result ledger ─────────────────────────────── */

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ─────────────────────────── the cookie ────────────────────────────────── */

function authSecret() {
  if (!existsSync(LIVE_ENV)) {
    throw new Error(
      `${LIVE_ENV} does not exist. AUTH_SECRET has no other source on this box; ` +
        "the harness cannot mint a session and must not pretend it did.",
    );
  }
  const line = readFileSync(LIVE_ENV, "utf8")
    .split("\n")
    .find((l) => l.startsWith("AUTH_SECRET="));
  if (!line) throw new Error(`${LIVE_ENV} has no AUTH_SECRET= line.`);
  const value = line.slice("AUTH_SECRET=".length).trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`${LIVE_ENV} has an empty AUTH_SECRET.`);
  return value;
}

/**
 * Mint a session JWE. next-auth lives in forge-control-web's node_modules, so
 * it is imported by absolute path from THIS worktree — never from the live
 * checkout, so the harness measures the code under test.
 */
async function mintCookie(salt) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repo = path.resolve(here, "../../../../..");
  const jwt = await import(
    path.join(repo, "forge-control-web/node_modules/next-auth/jwt.js")
  );
  return jwt.encode({
    token: { name: "phase5-harness", email: "check@localhost", sub: "check" },
    secret: authSecret(),
    salt,
    maxAge: 14400,
  });
}

/* ─────────────────────────── the browser ───────────────────────────────── */

function chromePath() {
  const cache = "/root/.cache/ms-playwright";
  const found = readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => existsSync(p));
  if (found.length === 0) {
    throw new Error(`No chromium binary under ${cache}. Playwright browsers are not installed.`);
  }
  return found[0];
}

/**
 * 60s, not playwright's 30s default. Five workstream lanes share this box and
 * each runs its own chromium; a 1-minute load average of 4 was measured while
 * this harness was being built, and the 30s default failed a `goto` that
 * succeeded on a retry seconds later. A navigation timeout under contention is
 * a measurement artefact, and it looks exactly like a broken page.
 */
const NAV_TIMEOUT_MS = Number(process.env.HARNESS_NAV_TIMEOUT_MS ?? 60_000);

/**
 * WHY EVERY `goto`/`reload` HERE USES `waitUntil: "commit"` AND NOT
 * "domcontentloaded" OR "networkidle" — measured, not preference:
 *
 *   - "networkidle" never arrives. DesktopApp polls (`refetchInterval`), so
 *     the network is never idle for 500ms. Measured: 30s timeout.
 *   - "domcontentloaded" ALSO never arrives, and this is the surprising one.
 *     Next 15 streams the App-Router HTML; with a suspended boundary still
 *     open the document stays in `loading` readyState, so the event does not
 *     fire even though the server answered 200 in 9ms (measured by curl in
 *     the same second). A `requestfailed`/`response` trace confirms
 *     `RESP 200 http://127.0.0.1:7840/signin` while `goto` times out at 45s.
 *   - "commit" fires when the final response (after any redirect chain) is
 *     committed, which is exactly what the /signin assertions need, and
 *     `waitForSelector` polls the DOM happily while the stream is still open.
 *
 * Do not "fix" this back to domcontentloaded. It fails as a 60-second hang
 * that reads like a broken page.
 */

async function newContext(browser, cookieValue) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  ctx.setDefaultTimeout(NAV_TIMEOUT_MS);
  if (cookieValue !== null) {
    await ctx.addCookies([
      {
        name: COOKIE_NAME,
        value: cookieValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
  return ctx;
}

/**
 * THE ASSERTION EVERY BROWSER STEP MAKES. Hard error, never a warning: a
 * screenshot of /signin filed as "the Businesses tab is empty" is exactly the
 * failure this project exists to kill.
 */
function assertNotSignin(page, where) {
  const url = page.url();
  if (/\/signin(\?|$)/.test(url) || !url.startsWith(WEB)) {
    throw new Error(
      `AUTHENTICATION LOST at ${where}: landed on ${url}.\n` +
        `  If the URL is an https:// origin, next start was launched WITHOUT the\n` +
        `  AUTH_URL=http://127.0.0.1:<port> override and the server is redirecting to\n` +
        `  the public site. If it is ${WEB}/signin, the cookie name/salt pair is wrong\n` +
        `  (this run used salt=name=${COOKIE_NAME}). See browser-harness.md § salt.`,
    );
  }
  return url;
}

/**
 * Open a surface deterministically by seeding the key DesktopApp restores from
 * (`forge.desktop.surface`, DesktopApp.tsx:239).
 *
 * THE VALUE MUST BE JSON-ENCODED. `usePersistentState`
 * (_ui/ResizableSplit.tsx:313-333) does `JSON.parse(raw)` inside a try/catch
 * whose catch body is empty but for the comment "unreadable or malformed —
 * keep the default". Seed the bare string `businesses`, the parse throws, the
 * surface stays `today` — and you photograph the TODAY page and file it as
 * "the Businesses tab". This harness did exactly that on its first run; the
 * assertion below is why it cannot do it twice.
 */
const TODAY_MARKER = "Good evening"; // TODAY's greeting; present on no other surface

async function openSurface(ctx, surface) {
  const page = await ctx.newPage();
  await page.goto(`${WEB}/desktop`, { waitUntil: "commit" });
  assertNotSignin(page, `initial load before opening ${surface}`);
  await page.evaluate(
    (s) => localStorage.setItem("forge.desktop.surface", JSON.stringify(s)),
    surface,
  );
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("nav", { timeout: NAV_TIMEOUT_MS });
  assertNotSignin(page, `after opening ${surface}`);

  // Round-trip: the app must still hold the surface we asked for.
  const stored = await page.evaluate(() => localStorage.getItem("forge.desktop.surface"));
  if (stored !== JSON.stringify(surface)) {
    throw new Error(
      `NAVIGATION FAILED: asked for ${surface}, localStorage holds ${stored}. ` +
        `The app rejected the seed and is showing some other surface.`,
    );
  }
  // And the TODAY page must be gone. The round-trip alone is not enough —
  // localStorage can hold the right value while the render silently fell back.
  const body = await page.locator("body").innerText();
  if (body.includes(TODAY_MARKER)) {
    throw new Error(
      `NAVIGATION FAILED: asked for ${surface} but the page still shows the TODAY ` +
        `greeting (${JSON.stringify(TODAY_MARKER)}). Refusing to screenshot the wrong surface.`,
    );
  }
  return page;
}

/* ─────────────────────────── the controls ──────────────────────────────── */

/**
 * POSITIVE and NEGATIVE control. Both are required and neither is optional:
 * a harness that only proves the good case cannot detect that it has silently
 * stopped authenticating, and every subsequent measurement it takes is a
 * photograph of a sign-in page.
 */
async function controls(browser) {
  const good = await mintCookie(COOKIE_NAME);

  // POSITIVE — a valid cookie reaches an authenticated route WITH CONTENT.
  // "Not /signin" alone is too weak: a 200 blank page would pass it.
  const ctx = await newContext(browser, good);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/desktop`, { waitUntil: "commit" });
  await page.waitForSelector("nav", { timeout: NAV_TIMEOUT_MS });
  const url = assertNotSignin(page, "positive control");
  // The nav items are not <button>s (measured: the whole page has exactly one
  // <button>, the theme toggle), so assert on the <nav> element's text. This
  // is deliberately a CONTENT assertion, not a status assertion: a 200 that
  // renders a blank shell would pass "not /signin" and prove nothing.
  const navCount = await page.locator("nav").count();
  if (navCount !== 1) {
    throw new Error(
      `POSITIVE CONTROL FAILED: ${url} returned 200 but has ${navCount} <nav> ` +
        `elements, not 1. The desktop shell did not render.`,
    );
  }
  const flat = await page.locator("nav").innerText();
  const wanted = ["TODAY", "PIPELINE", "MONEY", "BUSINESSES"];
  const missing = wanted.filter((w) => !flat.includes(w));
  if (missing.length > 0) {
    throw new Error(
      `POSITIVE CONTROL FAILED: ${url} returned 200 and is not /signin, but the ` +
        `navigation is missing ${missing.join(", ")}. A 200 that is not the app is ` +
        `not authentication — refusing to call this logged in.`,
    );
  }
  record("positive control — valid cookie reaches /desktop with the real nav", true,
    `${url}, nav has ${wanted.join("/")}`);
  await ctx.close();

  // NEGATIVE — an INVALID cookie must redirect to /signin. Same shape as the
  // real thing (same length, same JWE-ish look), wrong key material.
  const badCtx = await newContext(browser, `${good.slice(0, -6)}ZZZZZZ`);
  const badPage = await badCtx.newPage();
  await badPage.goto(`${WEB}/desktop`, { waitUntil: "commit" });
  const badUrl = badPage.url();
  if (!/\/signin(\?|$)/.test(badUrl)) {
    throw new Error(
      `NEGATIVE CONTROL FAILED: a TAMPERED cookie still reached ${badUrl}. ` +
        `The harness cannot distinguish logged-in from logged-out, so nothing it ` +
        `measures can be trusted. Do not proceed.`,
    );
  }
  record("negative control — tampered cookie redirects to /signin", true, badUrl);
  await badCtx.close();

  // NEGATIVE (b) — no cookie at all.
  const noneCtx = await newContext(browser, null);
  const nonePage = await noneCtx.newPage();
  await nonePage.goto(`${WEB}/desktop`, { waitUntil: "commit" });
  const noneUrl = nonePage.url();
  if (!/\/signin(\?|$)/.test(noneUrl)) {
    throw new Error(`NEGATIVE CONTROL (no cookie) FAILED: reached ${noneUrl}.`);
  }
  record("negative control — no cookie at all redirects to /signin", true, noneUrl);
  await noneCtx.close();

  return good;
}

/* ─────────────────────────── the shots ─────────────────────────────────── */

const SURFACES = [
  { key: "businesses", label: "before-businesses" },
  { key: "pipeline", label: "before-pipeline" },
  { key: "money", label: "before-money" },
];

async function shots(browser, cookie) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = await newContext(browser, cookie);
  const out = [];
  for (const s of SURFACES) {
    const page = await openSurface(ctx, s.key);
    // The surfaces fetch through /api/proxy → the harness API. Give the
    // fetch a beat, then re-assert: a 401 mid-flight can bounce us.
    await page.waitForTimeout(2500);
    assertNotSignin(page, `before screenshotting ${s.key}`);
    const file = path.join(SHOT_DIR, `${stamp()}-${s.label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220);
    record(`screenshot ${s.key}`, true, file);
    console.log(`      first 220 chars on screen: ${text}`);
    out.push({ surface: s.key, file });
    await page.close();
  }
  await ctx.close();
  return out;
}

/* ─────────────────────────── main ──────────────────────────────────────── */

async function main() {
  const cmd = process.argv[2] ?? "all";
  if (!["controls", "shots", "all"].includes(cmd)) {
    throw new Error(`Unknown command ${JSON.stringify(cmd)}; expected controls | shots | all.`);
  }

  // Fail loudly if either server is down, rather than reporting a browser
  // error that reads like a product defect.
  for (const [name, url] of [["web", `${WEB}/signin`], ["api", `${API}/api/pipeline`]]) {
    const r = await fetch(url, { redirect: "manual" }).catch((e) => {
      throw new Error(`${name} server at ${url} is unreachable: ${e.message}`);
    });
    record(`${name} server reachable`, true, `${url} → HTTP ${r.status}`);
  }

  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    let cookie = null;
    if (cmd === "controls" || cmd === "all") cookie = await controls(browser);
    if (cmd === "shots" || cmd === "all") {
      // `shots` alone still mints; controls gate `all` on purpose.
      if (cookie === null) cookie = await mintCookie(COOKIE_NAME);
      const files = await shots(browser, cookie);
      console.log(`\nSHOTS: ${JSON.stringify(files, null, 2)}`);
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\nHARNESS ERROR: ${e.message}`);
  process.exit(1);
});
