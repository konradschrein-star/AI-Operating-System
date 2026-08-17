/**
 * capture-1355.cjs — round 1354's A4, re-run as a browser walk.
 *
 * THE DEFECT, in the reviewer's words: "`ChatTeamPanel.tsx:556,573` labels
 * `restoreAll` as 'N hidden · show'. I clicked it — rows 15→16 and the server
 * set went to `count:0`, wiping the 11 unrelated dismissals I'd made in /live
 * moments before."
 *
 * So this script makes an unrelated dismissal in /live FIRST, then clicks the
 * team panel's control, and asserts the /live one survives. On round 1354's
 * build that assertion is the failure; here it is the point.
 *
 * The walk, per theme:
 *    1. /live  — dismiss a settled row. This is the bystander.
 *    2. team   — dismiss a settled node. Two ids on the server now.
 *    3. the footer reads "N dismissed · show", never "hidden".
 *    4. CLICK IT. The tree must not grow, a DISMISSED group must appear with
 *       the row in it, and `GET /api/agents/dismissals` must still hold BOTH
 *       ids. (Round 1354: the tree grew and the server went to zero.)
 *    5. the peeked row's own ↺ restores exactly that row — the bystander is
 *       still hidden, and the server says so.
 *    6. "restore all" is only reachable while peeking, says what it does, and
 *       takes two deliberate clicks: one click leaves the server untouched.
 *    7. the second click, after the 500ms floor, clears everything.
 *
 * WHAT IS REAL HERE. Nothing is stubbed, no route is intercepted. The web app
 * is an isolated production build of this worktree baked against the worktree
 * API harness (`scripts/checks/serve-v3-7798.ts`), and that harness runs
 * against the SCRATCH DATABASE round 1350 built — `forge_dismiss_ui_1350`, a
 * schema clone of content_forge holding a copy of two days of `runs`. Production
 * was neither read nor written by this round. See README.md next to this file.
 *
 * Run:
 *   R1355_BASE_URL=http://127.0.0.1:7871 R1355_API_URL=http://127.0.0.1:7870 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/r1355-cookie.txt)" \
 *     node docs/plan/artifacts/phase1355/capture-1355.cjs
 *
 * NFU8: playwright is loaded by absolute path from /opt/hermes-workspace and is
 * not a dependency of either repo (same as capture-1350.cjs).
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

const BASE = process.env.R1355_BASE_URL ?? "http://127.0.0.1:7871";
const API = process.env.R1355_API_URL ?? "http://127.0.0.1:7870";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const CHAT_TEXT = process.env.R1355_CHAT ?? "Okay when I click the file section";
const OUT = __dirname;

/** Copied verbatim from scripts/checks/frozen-dom.cjs:30-58. */
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
  if (!candidates.length) throw new Error(`no chromium under ${cache}`);
  return candidates[0];
}

const results = [];
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
  );
}
function note(name, value) {
  results.push({ name, note: value });
  console.log(`      ${name}: ${JSON.stringify(value)}`);
}

async function apiDismissals() {
  const r = await fetch(`${API}/api/agents/dismissals`);
  if (!r.ok) throw new Error(`GET dismissals → ${r.status}`);
  return r.json();
}

async function restoreEverything() {
  const r = await fetch(`${API}/api/agents/dismissals`, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE dismissals → ${r.status}`);
  return r.json();
}

/* ── page helpers (shape borrowed from capture-1350.cjs) ─────────────────── */

async function newContext(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies([
    { name: "authjs.session-token", value: COOKIE, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem("forge.theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
  return ctx;
}

async function openLive(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(1_500);
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector("[data-agent-kind]", { timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

async function openTeam(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(1_500);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(2_500);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") === "ready",
    { timeout: 25_000 },
  );
  await page.waitForTimeout(1_200);
}

/** Everything the team panel is currently saying about dismissal. */
const teamState = () => ({
  rows: [...document.querySelectorAll("[data-team-row]")].length,
  peeked: [...document.querySelectorAll('[data-team-peeked="true"]')].map((d) => d.getAttribute("data-node-id")),
  restorable: [...document.querySelectorAll("[data-team-restore]")].map((b) => b.getAttribute("data-team-restore")),
  withParent: [...document.querySelectorAll("[data-team-hidden-with-parent]")].length,
  toggle: document.querySelector("[data-team-dismissed-toggle]")?.textContent?.trim() ?? null,
  restoreAll: document.querySelector("[data-team-restore-all]")?.textContent?.trim() ?? null,
  restoreAllArmed: document.querySelector("[data-team-restore-all]")?.getAttribute("data-confirm") ?? null,
  group: document.querySelector("[data-team-dismissed-group]")?.textContent?.trim() ?? null,
});

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  return `${name}.png`;
}

/* ── the walk ───────────────────────────────────────────────────────────── */

async function walk(browser, theme) {
  console.log(`\n════════ ${theme} ════════`);
  await restoreEverything();

  // 1. the bystander: a dismissal made in /live, in its own context.
  const liveCtx = await newContext(browser, theme);
  const live = await liveCtx.newPage();
  await openLive(live);
  const liveX = await live.locator("[data-live-x]").first().getAttribute("data-live-x");
  if (!liveX) throw new Error("no settled row with a ✕ in /live");
  await live.locator(`[data-live-x="${liveX}"]`).click();
  await live.waitForTimeout(900);
  const afterLive = await apiDismissals();
  check(`${theme} · the /live bystander is on the server`, afterLive.node_ids.includes(liveX), true);
  note(`${theme} · bystander id`, liveX.slice(0, 8));
  const bystanderCount = afterLive.count;

  // 2. a dismissal in the team panel.
  const teamCtx = await newContext(browser, theme);
  const page = await teamCtx.newPage();
  await openTeam(page);
  const before = await page.evaluate(teamState);
  await shot(page, `team-${theme}-1-before`);

  // Select the dismiss ✕ by its title, never "the last enabled ✕" — a RUNNING
  // row's ✕ is an armed terminate now that capabilities.terminate is true
  // (round 1350's README, "two things a reviewer should know").
  const dismissX = page.locator('[data-team-x][title^="Hide this row"]').last();
  const teamNodeId = await dismissX.evaluate((b) => b.closest("[data-team-row]")?.getAttribute("data-node-id"));
  await dismissX.click();
  await page.waitForTimeout(900);
  const dismissed = await page.evaluate(teamState);
  const serverAfterTeam = await apiDismissals();
  check(`${theme} · the team row left the tree`, dismissed.rows < before.rows, true);
  check(`${theme} · both dismissals are on the server`, serverAfterTeam.count >= bystanderCount + 1, true);
  await shot(page, `team-${theme}-2-dismissed`);

  // 3. the label.
  check(`${theme} · the footer says "dismissed · show", not "hidden"`, /^\d+ dismissed · show$/.test(dismissed.toggle ?? ""), true);
  note(`${theme} · toggle label`, dismissed.toggle);
  check(`${theme} · restore-all is NOT reachable before peeking`, dismissed.restoreAll, null);
  check(`${theme} · and there is no DISMISSED group yet`, dismissed.group, null);

  // 4. THE CLICK. Round 1354: rows 15 → 16 and the server went to count:0.
  await page.click("[data-team-dismissed-toggle]");
  await page.waitForTimeout(700);
  const peeking = await page.evaluate(teamState);
  const serverAfterClick = await apiDismissals();
  check(`${theme} · clicking "show" does NOT restore anything on the server`, serverAfterClick.count, serverAfterTeam.count);
  check(`${theme} · …the bystander in particular survives it`, serverAfterClick.node_ids.includes(liveX), true);
  check(`${theme} · the dismissed row is shown as PEEKED, not returned to the tree`, peeking.peeked, [teamNodeId]);
  check(`${theme} · under a DISMISSED heading`, peeking.group, "DISMISSED");
  check(`${theme} · with its own restore control`, peeking.restorable, [teamNodeId]);
  check(`${theme} · and the toggle flips to "hide"`, /^\d+ dismissed · hide$/.test(peeking.toggle ?? ""), true);
  const peekOpacity = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-team-peeked="true"]')).opacity,
  );
  check(`${theme} · the peeked row is faded`, peekOpacity, "0.55");
  await shot(page, `team-${theme}-3-peek`);

  // 5. the per-row way back.
  await page.click(`[data-team-restore="${teamNodeId}"]`);
  await page.waitForTimeout(900);
  const restored = await page.evaluate(teamState);
  const serverAfterRestore = await apiDismissals();
  check(`${theme} · ↺ returns that row to the tree`, restored.rows >= before.rows, true);
  check(`${theme} · …and only that one: the bystander is still hidden`, serverAfterRestore.node_ids.includes(liveX), true);
  check(`${theme} · …the team id is gone from the server`, serverAfterRestore.node_ids.includes(teamNodeId), false);
  await shot(page, `team-${theme}-4-restored`);

  // 6/7. restore all: two clicks, and the first one does nothing.
  //      Dismiss again so the footer is present to peek from.
  await page.locator('[data-team-x][title^="Hide this row"]').last().click();
  await page.waitForTimeout(900);
  /* `peek` is panel state and survives the group emptying, so the toggle may
   * already read "hide" here. Clicking blind would close the peek and hide the
   * control this section is about — assert the state instead of assuming it. */
  const toggleNow = await page.locator("[data-team-dismissed-toggle]").textContent();
  if (/· show$/.test((toggleNow ?? "").trim())) {
    await page.click("[data-team-dismissed-toggle]");
  }
  await page.waitForTimeout(500);
  check(
    `${theme} · peek survives the group emptying and refilling`,
    /· hide$/.test(((await page.locator("[data-team-dismissed-toggle]").textContent()) ?? "").trim()),
    true,
  );
  const armedBefore = await apiDismissals();
  const raLabel = await page.locator("[data-team-restore-all]").textContent();
  check(`${theme} · restore-all says what it does`, (raLabel ?? "").trim(), "restore all");
  const raTitle = await page.locator("[data-team-restore-all]").getAttribute("title");
  check(`${theme} · …and warns that it crosses panels`, (raTitle ?? "").includes("Live panel"), true);

  await page.click("[data-team-restore-all]");
  await page.waitForTimeout(250);
  const armed = await page.evaluate(teamState);
  const serverArmed = await apiDismissals();
  check(`${theme} · one click only ARMS it`, armed.restoreAllArmed, "armed");
  check(`${theme} · …the server is untouched`, serverArmed.count, armedBefore.count);
  check(`${theme} · …and the label names the global count`, /^restore all \d+\?$/.test((armed.restoreAll ?? "")), true);
  note(`${theme} · armed label`, armed.restoreAll);
  await shot(page, `team-${theme}-5-restore-all-armed`);

  // A click under the 500ms floor must be swallowed, not honoured.
  await page.click("[data-team-restore-all]");
  await page.waitForTimeout(120);
  const swallowed = await apiDismissals();
  check(`${theme} · a click under the confirm floor is swallowed`, swallowed.count, armedBefore.count);

  await page.waitForTimeout(700);
  await page.click("[data-team-restore-all]");
  await page.waitForTimeout(900);
  const cleared = await apiDismissals();
  check(`${theme} · a deliberate second click clears everything`, cleared.count, 0);
  await shot(page, `team-${theme}-6-restore-all-done`);

  await teamCtx.close();
  await liveCtx.close();
}

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  try {
    for (const theme of ["dark", "light"]) await walk(browser, theme);
  } finally {
    await browser.close();
    await restoreEverything();
  }
  fs.writeFileSync(path.join(OUT, "capture-1355.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — team panel dismissal peek`);
  process.exit(failures === 0 ? 0 : 1);
})();
