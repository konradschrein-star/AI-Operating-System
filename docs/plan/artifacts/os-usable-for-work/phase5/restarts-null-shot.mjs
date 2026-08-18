#!/usr/bin/env node
/**
 * restarts-null-shot.mjs — phase 5, fix cycle 1 (round 4). The browser proof
 * for the gate's finding F1.
 *
 * WHAT F1 SAID. `pipeline-health.ts:317` fell back to `restarts: 0` when pm2
 * omits `restart_time`, two lines below a `uptime_ms` that correctly goes
 * `null` for the same missing data under a comment reading "NEVER 0". The
 * surface then rendered `0 restarts` — a CLAIM ("this worker has never
 * restarted") — for a number pm2 never gave it.
 *
 * WHY A BROWSER AND NOT JUST THE UNIT TEST. The unit tests in
 * `pipeline-health.test.ts` prove the PARSER now emits `null`. They cannot
 * prove the RENDERER stopped claiming. A `number | null` that reaches a
 * template literal renders the four characters `null`, which is worse than the
 * `0` it replaced — so the rendering is the half that has to be photographed.
 *
 * THE FIXTURE IS THE POINT. `restarts-null-stub.json` carries all three answers
 * in one column, so one screenshot separates them:
 *
 *   worker-orchestrator  restarts 0     → "0 restarts"            (an honest zero SURVIVES)
 *   worker-render        restarts null  → "restarts not reported" (the fix)
 *   worker-video-stitch  restarts 3     → "3 restarts", warn tone (the warn path still fires)
 *   claude-pool          restarts null, status stopped
 *
 * A fixture with only the null case would pass against a component that
 * rendered "restarts not reported" unconditionally. That is the inert-assertion
 * failure this fleet keeps re-learning, so the zero and the three are load-
 * bearing, not decoration.
 *
 *   USAGE — see browser-harness.md for the two servers this needs.
 *     1. serve-pipeline.ts on :7842 with
 *        PIPELINE_STUB_FILE=<this dir>/restarts-null-stub.json
 *     2. forge-control-web built with FORGE_CONTROL_URL=http://127.0.0.1:7842,
 *        then `next start -p 7840` with AUTH_URL=http://127.0.0.1:7840
 *     3. node restarts-null-shot.mjs
 *
 * Auth, salt, `waitUntil: "commit"` and the localStorage seeding trap are all
 * harness.mjs's, unchanged and for its reasons — read browser-harness.md §3
 * and §5a before touching any of them.
 */

import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "/opt/hermes-workspace/node_modules/playwright/index.mjs";

const WEB = process.env.HARNESS_WEB_URL ?? "http://127.0.0.1:7840";
const API = process.env.HARNESS_API_URL ?? "http://127.0.0.1:7842";
const LIVE_ENV = "/opt/forge-ai-os/forge-control-web/.env.local";
const COOKIE_NAME = process.env.HARNESS_COOKIE_NAME ?? "authjs.session-token";
const NAV_TIMEOUT_MS = Number(process.env.HARNESS_NAV_TIMEOUT_MS ?? 60_000);

const SHOT_DIR = (() => {
  if (process.env.HARNESS_SHOT_DIR) return process.env.HARNESS_SHOT_DIR;
  const id = process.env.FORGE_RUN_ID;
  if (!id) {
    throw new Error(
      "FORGE_RUN_ID is unset and HARNESS_SHOT_DIR was not given. Screenshots must " +
        "land in /opt/ai-os/uploads/<run-id>/ (N7); a shot written anywhere else is " +
        "invisible to Konrad and gone at the next reboot.",
    );
  }
  return `/opt/ai-os/uploads/${id}`;
})();

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function authSecret() {
  if (!existsSync(LIVE_ENV)) {
    throw new Error(`${LIVE_ENV} does not exist; AUTH_SECRET has no other source on this box.`);
  }
  const line = readFileSync(LIVE_ENV, "utf8")
    .split("\n")
    .find((l) => l.startsWith("AUTH_SECRET="));
  if (!line) throw new Error(`${LIVE_ENV} has no AUTH_SECRET= line.`);
  const value = line.slice("AUTH_SECRET=".length).trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`${LIVE_ENV} has an empty AUTH_SECRET.`);
  return value;
}

async function mintCookie(salt) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repo = path.resolve(here, "../../../../..");
  const jwt = await import(path.join(repo, "forge-control-web/node_modules/next-auth/jwt.js"));
  return jwt.encode({
    token: { name: "phase5-fix1", email: "check@localhost", sub: "check" },
    secret: authSecret(),
    salt,
    maxAge: 14400,
  });
}

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
  if (found.length === 0) throw new Error(`No chromium binary under ${cache}.`);
  return found[0];
}

function assertNotSignin(page, where) {
  const url = page.url();
  if (/\/signin(\?|$)/.test(url) || !url.startsWith(WEB)) {
    throw new Error(
      `AUTHENTICATION LOST at ${where}: landed on ${url}. See browser-harness.md § salt.`,
    );
  }
  return url;
}

async function main() {
  // The stub must be serving what this script claims to be testing. Asserting
  // it here rather than trusting the port means a stale server on :7842 fails
  // loudly instead of producing a screenshot of the wrong fixture.
  const res = await fetch(`${API}/api/pipeline`).catch((e) => {
    throw new Error(`api server at ${API} is unreachable: ${e.message}`);
  });
  if (res.headers.get("x-phase5-harness") !== "stub") {
    throw new Error(
      `${API} is NOT in stub mode (no x-phase5-harness: stub header). Refusing to ` +
        `photograph live worker health and file it as the null-restarts fixture.`,
    );
  }
  const payload = await res.json();
  const served = payload.workers?.workers?.map((w) => [w.name, w.restarts]) ?? [];
  const wanted = JSON.stringify([
    ["worker-orchestrator", 0],
    ["worker-render", null],
    ["worker-video-stitch", 3],
    ["claude-pool", null],
  ]);
  if (JSON.stringify(served) !== wanted) {
    throw new Error(
      `the stub on ${API} serves ${JSON.stringify(served)}, not the fixture this ` +
        `script asserts against (${wanted}).`,
    );
  }
  record("stub serves the three-answer fixture", true, JSON.stringify(served));

  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const cookie = await mintCookie(COOKIE_NAME);
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    ctx.setDefaultTimeout(NAV_TIMEOUT_MS);
    await ctx.addCookies([
      {
        name: COOKIE_NAME,
        value: cookie,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    const page = await ctx.newPage();
    await page.goto(`${WEB}/desktop`, { waitUntil: "commit" });
    assertNotSignin(page, "initial load");
    // JSON-encoded: usePersistentState JSON.parses this and swallows the throw,
    // so a bare string silently leaves you on TODAY (browser-harness.md § 5a).
    await page.evaluate(() =>
      localStorage.setItem("forge.desktop.surface", JSON.stringify("pipeline")),
    );
    await page.reload({ waitUntil: "commit" });
    await page.waitForSelector("nav", { timeout: NAV_TIMEOUT_MS });
    assertNotSignin(page, "after opening pipeline");
    await page.waitForSelector("text=WORKERS", { timeout: NAV_TIMEOUT_MS });

    const body = await page.locator("body").innerText();
    if (body.includes("Good evening") || body.includes("Good morning")) {
      throw new Error("still on TODAY — refusing to screenshot the wrong surface.");
    }

    // The assertions. Each is a separate `record` so a partial failure names
    // which of the three answers regressed.
    const checks = [
      ["the null worker says so in words", body.includes("restarts not reported")],
      ["the honest zero survives", body.includes("0 restarts")],
      ["the warn path still fires", body.includes("3 restarts")],
      // The bug this fix could have introduced instead of the one it fixed.
      ["no raw `null restarts` reached the DOM", !body.includes("null restarts")],
    ];
    let bad = 0;
    for (const [label, ok] of checks) {
      record(label, ok);
      if (!ok) bad += 1;
    }

    // Exactly two workers carry null in the fixture, so the sentence must
    // appear exactly twice — a count, not a boolean, because "contains it
    // somewhere" would pass on a component that rendered it for every row.
    const n = (body.match(/restarts not reported/g) ?? []).length;
    const okCount = n === 2;
    record("it appears exactly twice — once per null worker, not once per row", okCount, `n=${n}`);
    if (!okCount) bad += 1;

    mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${stamp()}-pipeline-restarts-not-reported.png`);
    assertNotSignin(page, "immediately before the screenshot");
    // fullPage is a lie on this shell — it scrolls internally, so fullPage
    // equals the viewport. The 1400px viewport above is what gets the WORKERS
    // panel into frame.
    await page.screenshot({ path: file });
    console.log(`\nSHOT: ${file}`);
    await ctx.close();
    if (bad > 0) process.exit(1);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\nSHOT HARNESS ERROR: ${e.message}`);
  process.exit(1);
});
