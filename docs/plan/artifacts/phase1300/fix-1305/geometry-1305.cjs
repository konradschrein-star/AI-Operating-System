/**
 * geometry-1305.cjs — how many of round 1291's sweep targets were never on the
 * list, measured on the real build rather than argued from the fixture.
 *
 * `probe-1305.cjs` proves the assertion is fixed. This answers the other
 * question a reviewer will ask: on the actual team panel, how far apart are the
 * two targeting rules? It counts, at one instant on a live-served worktree build:
 *
 *   rowsInDom            — every `[data-team-row]`
 *   viewportRule         — round 1291's filter (rect inside the viewport), capped at 26
 *   clippedRule          — round 1305's filter (rect ∩ every scrolling ancestor)
 *   offListTargets       — viewport-rule targets whose centre does NOT resolve to a row
 *                          … i.e. coordinates the old sweep spent crossings on
 *
 * It also screenshots the panel with both target sets drawn, so the geometry is
 * visible and not merely tabulated.
 *
 *   RT_BASE_URL=http://127.0.0.1:7792 FORGE_SESSION_COOKIE=... \
 *     node docs/plan/artifacts/phase1300/fix-1305/geometry-1305.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

const { CLIPPED_BOXES } = require("../../phase1290/hover/hover-1291.cjs");

const BASE = (process.env.RT_BASE_URL ?? "http://127.0.0.1:7792").trim();
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const CHAT_TEXT = process.env.RT_CHAT_TEXT ?? "Okay when I click the file section";
const OUT = path.resolve(process.env.GEOMETRY_OUT ?? __dirname);

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
  if (!found) throw new Error(`no chromium under ${cache}`);
  return found;
}

const CENSUS = (rowSelector) => {
  const rows = [...document.querySelectorAll(rowSelector)];
  const scroller = document.querySelector("[data-team-scroll]");
  const sc = scroller ? scroller.getBoundingClientRect() : null;
  const viewportRule = rows
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 8;
    })
    .slice(0, 26)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
  const offList = viewportRule
    .map((b) => {
      const at = document.elementFromPoint(b.x, b.y);
      return { ...b, onRow: Boolean(at && at.closest(rowSelector)), landsOn: (at?.textContent ?? "").slice(0, 60) };
    })
    .filter((b) => !b.onRow);
  return {
    rowsInDom: rows.length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollBox: sc ? { top: Math.round(sc.top), bottom: Math.round(sc.bottom), height: Math.round(sc.height) } : null,
    scrollState: scroller
      ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
      : null,
    viewportRule,
    offList,
  };
};

/** Draw both target sets over the page so the difference is visible. */
const PAINT = (arg) => {
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:99999";
  const mark = (b, color) => {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;left:${b.x - 5}px;top:${b.y - 5}px;width:10px;height:10px;border-radius:50%;background:${color};outline:1px solid #000`;
    layer.appendChild(d);
  };
  for (const b of arg.offList) mark(b, "#ff2d2d");
  for (const b of arg.clipped) mark(b, "#19d219");
  document.body.appendChild(layer);
};

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  if (BASE.includes("os.schreinercontentsystems.com")) throw new Error("production URLs are out of bounds");
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const url = new URL(BASE);
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(8_000);

  const census = await page.evaluate(CENSUS, "[data-team-row]");
  const clipped = await page.evaluate(CLIPPED_BOXES, { rowSelector: "[data-team-row]", limit: 26 });
  await page.evaluate(PAINT, { offList: census.offList, clipped });
  await page.screenshot({ path: path.join(OUT, "geometry-1305.png") });

  const report = {
    script: "docs/plan/artifacts/phase1300/fix-1305/geometry-1305.cjs",
    round: 1305,
    base: BASE,
    finishedAt: new Date().toISOString(),
    note:
      "One instant on a live-served worktree build. Red dots in the PNG are coordinates round 1291's " +
      "viewport rule would have swept that do not resolve to a row; green dots are round 1305's targets.",
    ...census,
    clippedRule: clipped,
    counts: {
      rowsInDom: census.rowsInDom,
      viewportRuleTargets: census.viewportRule.length,
      clippedRuleTargets: clipped.length,
      viewportRuleTargetsNotOnAnyRow: census.offList.length,
    },
  };
  fs.writeFileSync(path.join(OUT, "geometry-1305.json"), JSON.stringify(report, null, 2));
  console.log(
    `rows in DOM ${census.rowsInDom} | viewport rule ${census.viewportRule.length} targets, ` +
      `${census.offList.length} of them NOT on a row | clipped rule ${clipped.length} targets`,
  );
  console.log(`scroll box ${JSON.stringify(census.scrollBox)} state ${JSON.stringify(census.scrollState)}`);
  for (const b of census.offList) console.log(`  off-list target (${b.x},${b.y}) lands on ${JSON.stringify(b.landsOn)}`);
  console.log(`wrote ${path.join(OUT, "geometry-1305.json")} + geometry-1305.png`);
  await browser.close();
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
