/**
 * team-hover.cjs — NFU2, protocol 14 §"Hover non-regression".
 *
 * Clone of phase400/hover-cost.cjs (its __REACT_DEVTOOLS_GLOBAL_HOOK__
 * commit-counting shim and MutationObserver are exactly right and are copied
 * verbatim). Two differences from that script:
 *
 *   1. It sweeps >=20 [data-team-row] rows inside [data-team-scroll] — the
 *      Team panel's own contract — instead of the old rail's structural
 *      `style.width === "300px"` search. A fixture with fewer than 20 rows
 *      is refused rather than silently sweeping fewer: NFU2's protocol names
 *      20 rows because a 5-row sweep is too small to distinguish "no storm"
 *      from "storm too small to see in this fixture".
 *   2. It additionally asserts NO LAYOUT SHIFT: every row's
 *      getBoundingClientRect() is recorded before and during a hover, and
 *      must be identical — the controls in `.team-row-controls` are always
 *      mounted and only fade in, so geometry cannot move. This assertion is
 *      copied from phase400/rail-shot.cjs's reflow check.
 *
 * Gate: zero react commits attributable to hover, AND zero layout shift.
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     TEAM_HOVER_LABEL=after \
 *     node docs/plan/artifacts/phase500/team-hover.cjs
 *
 * For a before/after comparison, point TEAM_BASE_URL at two builds (main vs
 * worktree) with different TEAM_HOVER_LABEL values, same as hover-cost.cjs.
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const candidates = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7789";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
// Default: chat 11dd264b — linked, 11 workers (12 rows w/ manager). Today's
// live data tops out below the 20-row minimum this protocol requires; pick a
// chat with more workers/sub-agents via TEAM_CHAT_TEXT when one exists.
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "Okay this session is very important";
const LABEL = process.env.TEAM_HOVER_LABEL ?? "run";
const OUT_DIR = __dirname;
const WINDOW_MS = 10_000; // NFU2: a 10s hover sweep after a 10s idle window
const SWEEP_STEP_MS = 120;
const MIN_ROWS = 20;

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (see README.md)");

const INSTALL_HOOK = () => {
  window.__forgeCommits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    _renderers: new Map(),
    _nextId: 0,
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      const id = ++this._nextId;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {
      window.__forgeCommits += 1;
    },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
    emit() {},
    on() {},
    off() {},
    sub() {
      return () => {};
    },
    getFiberRoots() {
      return new Set();
    },
    setStrictMode() {},
  };
};

async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale (re-mint, 60min)");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(3_000);
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
}

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.addInitScript(INSTALL_HOOK);
  await openChat(page);

  const panelPresent = await page
    .waitForSelector("[data-team-panel]", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!panelPresent)
    throw new Error(
      `no [data-team-panel] found in the DOM within 15000ms at ${BASE} (chat "${CHAT_TEXT}") — ` +
        `the Team panel does not exist yet, or the chat text did not match a rail row`,
    );
  await page
    .waitForFunction(
      () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
      { timeout: 20_000 },
    )
    .catch(async () => {
      const state = await page.evaluate(() => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? "<gone>");
      throw new Error(`[data-team-panel] never reached data-team-state="ready" (got: "${state}")`);
    });

  const rowBoxes = await page.evaluate(() => {
    const scroller = document.querySelector("[data-team-scroll]");
    if (!scroller) return { error: "no [data-team-scroll] found" };
    const rows = Array.from(scroller.querySelectorAll("[data-team-row]"));
    return {
      count: rows.length,
      boxes: rows.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          nodeId: el.getAttribute("data-node-id"),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          top: Math.round(r.y),
          height: Math.round(r.height),
        };
      }),
    };
  });
  if (rowBoxes.error) throw new Error(rowBoxes.error);
  if (rowBoxes.count < MIN_ROWS)
    throw new Error(
      `only ${rowBoxes.count} [data-team-row] rows inside [data-team-scroll] — need >=${MIN_ROWS} per NFU2's sweep protocol. Pick a fixture chat with more workers/sub-agents via TEAM_CHAT_TEXT.`,
    );
  const rowBoxesVisible = rowBoxes.boxes.filter((b) => b.height > 0 && b.top < 980 && b.top > -200);
  if (rowBoxesVisible.length < 2)
    throw new Error(`only ${rowBoxesVisible.length} rows on screen — cannot sweep`);

  // ── Layout-shift assertion: geometry before vs during a hover ───────────
  const geomOf = () =>
    page.evaluate(() => {
      const scroller = document.querySelector("[data-team-scroll]");
      return Array.from(scroller.querySelectorAll("[data-team-row]")).map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.getAttribute("data-node-id")}:${Math.round(r.y)}x${Math.round(r.height)}x${Math.round(r.width)}`;
      });
    });
  const geomBefore = await geomOf();
  const target = rowBoxesVisible[0];
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(600);
  const geomDuring = await geomOf();
  await page.mouse.move(1400, 500);
  await page.waitForTimeout(300);
  const layoutShift = JSON.stringify(geomBefore) !== JSON.stringify(geomDuring);

  // ── Commit/mutation counting ─────────────────────────────────────────────
  const arm = () =>
    page.evaluate(() => {
      window.__forgeCommits = 0;
      window.__forgeMutations = 0;
      if (window.__forgeObs) window.__forgeObs.disconnect();
      const scroller = document.querySelector("[data-team-scroll]");
      window.__forgeObs = new MutationObserver((recs) => {
        window.__forgeMutations += recs.length;
      });
      window.__forgeObs.observe(scroller, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });
  const read = () =>
    page.evaluate(() => ({ commits: window.__forgeCommits, mutations: window.__forgeMutations }));

  await page.mouse.move(1400, 500);
  await page.waitForTimeout(500);
  await arm();
  await page.waitForTimeout(WINDOW_MS);
  const idle = await read();

  await arm();
  const t0 = Date.now();
  let crossings = 0;
  while (Date.now() - t0 < WINDOW_MS) {
    const b = rowBoxesVisible[crossings % rowBoxesVisible.length];
    await page.mouse.move(b.x, b.y);
    crossings += 1;
    await page.waitForTimeout(SWEEP_STEP_MS);
  }
  const hover = await read();
  await page.mouse.move(1400, 500);

  const attributable = {
    commits: hover.commits - idle.commits,
    mutations: hover.mutations - idle.mutations,
  };
  const gatePass = attributable.commits === 0 && !layoutShift;

  const result = {
    label: LABEL,
    base: BASE,
    chat: CHAT_TEXT,
    rows_on_screen: rowBoxesVisible.length,
    rows_total: rowBoxes.count,
    window_ms: WINDOW_MS,
    crossings,
    idle,
    hover,
    attributable_to_hover: attributable,
    layout_shift: layoutShift,
    geom_before: geomBefore,
    geom_during: geomDuring,
    gate: "zero commits attributable to hover, and zero layout shift",
    verdict: gatePass ? "PASS" : "FAIL",
  };
  const out = path.join(OUT_DIR, `team-hover-${LABEL}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`→ ${out}`);
  console.log(`TEAM-HOVER: ${result.verdict}`);

  if (!gatePass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
