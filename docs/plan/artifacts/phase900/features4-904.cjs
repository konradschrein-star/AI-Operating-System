/**
 * features4-904.cjs — U34 step 3, final pass: a3 (canvas) and c (light panel).
 *
 * PHASE 900, round 904. PRODUCTION.
 *
 *   a3 The picker lists drawings by TITLE, not filename — "Excalidraw / AI OS -
 *      Canvas Smoke Test", no ".excalidraw" suffix. Passes 2 and 3 matched on
 *      the suffix and therefore matched nothing, which is why the editor never
 *      mounted and the pane honestly reported "no drawing open". Click by title.
 *   c  The dark pass ANSWERED the request, which cleared it — so the light pass
 *      correctly found no pending request and no auto-opened panel. The request
 *      has been re-armed via POST /api/secrets/:name/mark-pending so the light
 *      shot has the same true state the dark one had.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = "/root/.cache/ms-playwright";
  return fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
}

const BASE = "https://os.schreinercontentsystems.com";
const COOKIE = (process.env.FORGE_SECURE_COOKIE ?? "").trim();
const CHAT_TEXT = "Okay when I click the file section";
const CANARY = "verify904-synthetic-canary";
const DRAWING = process.env.DRAWING ?? "AI OS - Canvas Smoke Test";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty");

const report = { base: BASE, drawing: DRAWING, features: {}, shots: [], errors: [] };

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    { name: "__Secure-authjs.session-token", value: COOKIE, domain: new URL(BASE).hostname,
      path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));
  return page;
}
async function setTheme(page, want) {
  for (let i = 0; i < 3; i++) {
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
    if (now === want) break;
    await page.getByText(now === "dark" ? "light_mode" : "dark_mode", { exact: true }).first().click();
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(600);
}
async function shoot(t, name) {
  const f = path.join(OUT, name);
  await t.screenshot({ path: f });
  const bytes = fs.statSync(f).size;
  report.shots.push({ name, bytes });
  console.log(`  shot ${name} (${bytes})`);
}
async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin");
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_500);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(4_000);
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  // ---- c: the light-mode panel, with the request re-armed ---------------
  {
    console.log(`\n=== c secret light ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, "light");
    await page.waitForTimeout(2_500);
    const panel = await page.evaluate((name) => {
      const nameInput = document.querySelector('input[placeholder^="name —"]');
      const t = document.body.innerText;
      return {
        autoOpened: !!nameInput,
        prefilledWith: nameInput ? nameInput.value : null,
        answerMode: nameInput ? nameInput.value === name : false,
        waitingLine: (t.match(/an agent is waiting for[^\n]*/) || [""])[0],
        noteRenderedAsText: t.includes("ROUND 904 VERIFICATION ONLY"),
        neverInThread: t.includes("never written into this conversation"),
      };
    }, CANARY);
    report.features.secretPanel_light = panel;
    console.log(`  panel: ${JSON.stringify(panel).slice(0, 300)}`);
    await shoot(page, "prod-feature-secret-panel-light.png");
    await page.context().close();
  }

  // ---- a3: mount the editor and read the theme it actually took ---------
  for (const theme of ["dark", "light"]) {
    console.log(`\n=== a3 canvas ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);
    await page.getByText("CANVAS", { exact: true }).first().click();
    await page.waitForTimeout(3_500);
    await page.getByText("pick a drawing", { exact: false }).first().click();
    await page.waitForTimeout(2_500);
    await page.getByText(DRAWING, { exact: false }).first().click();
    await page.waitForTimeout(12_000);

    const exc = await page.evaluate(() => {
      const root = document.querySelector(".excalidraw");
      if (!root) return { present: false, paneText: (document.body.innerText.match(/no drawing open[^\n]*/) || [""])[0] };
      const canvas = root.querySelector("canvas");
      return {
        present: true,
        isDarkClass: root.classList.contains("theme--dark"),
        classes: String(root.className).slice(0, 200),
        rootBg: getComputedStyle(root).backgroundColor,
        canvasFilter: canvas ? getComputedStyle(canvas).filter : null,
        docTheme: document.documentElement.dataset.theme ?? "dark",
      };
    });
    report.features[`canvas_${theme}`] = exc;
    console.log(`  excalidraw: ${JSON.stringify(exc).slice(0, 300)}`);
    await shoot(page, `prod-feature-canvas-${theme}.png`);
    await page.context().close();
  }

  fs.writeFileSync(path.join(OUT, "features4-904.json"), JSON.stringify(report, null, 2));
  console.log(`\nerrors: ${report.errors.length}`);
  await browser.close();
})();
