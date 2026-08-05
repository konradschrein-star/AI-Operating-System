/**
 * capture-nav.cjs — both-theme screenshots of the drill-in surfaces (U20).
 *
 * Four cases × dark and light (`phase600-<case>-<theme>.png`):
 *   depth1     — a worker's transcript, back button + header + crumb
 *   depth2     — that worker's sub-agent, crumb three deep
 *   backhover  — the back button hovered, so the CSS-only animation's hover
 *                state (`.nav-back:hover`) is on the record
 *   manager    — the manager chat after backing all the way out
 *
 * Theme switch is `document.documentElement.dataset.theme`, exactly as
 * phase500/capture-team.cjs:201-204 does it. Playwright by absolute path,
 * chromium from the shared cache (NFU8 — not a dependency of either repo).
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const c = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!c.length) throw new Error(`no chromium binary under ${cache}`);
  return c[0];
}

const BASE = process.env.NAV_BASE_URL ?? "http://127.0.0.1:7784";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const CHAT = process.env.NAV_CHAT ?? "Okay this session is very important";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");

const shots = [];
async function shoot(page, name) {
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(500);
    const file = path.join(OUT, `phase600-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    shots.push(path.basename(file));
    console.log(`  shot ${path.basename(file)}`);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "authjs.session-token", value: COOKIE, domain: new URL(BASE).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await page.waitForTimeout(3_000);

  await page.locator('[data-team-row][data-kind="worker"]').first().click();
  await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await shoot(page, "depth1");

  await page.locator("[data-nav-back]").hover();
  await page.waitForTimeout(600);
  await shoot(page, "backhover");
  await page.mouse.move(800, 500);

  await page.locator('[data-team-row][data-kind="subagent"][data-depth="2"]').first().click();
  await page.waitForTimeout(3_000);
  await shoot(page, "depth2");

  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(1_500);
  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(2_500);
  const backOut = await page.evaluate(() => document.querySelector("[data-agent-chat-view]") === null);
  await shoot(page, "manager");

  fs.writeFileSync(
    path.join(OUT, "capture-nav.json"),
    `${JSON.stringify({ base: BASE, chat: CHAT, backOutToManager: backOut, shots }, null, 2)}\n`,
  );
  console.log(`\n${shots.length} screenshots, backOutToManager=${backOut}`);
  await browser.close();
  process.exit(backOut ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
