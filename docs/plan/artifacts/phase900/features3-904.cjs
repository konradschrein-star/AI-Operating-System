/**
 * features3-904.cjs — U34 step 3, third pass: finish a3, c and d.
 *
 * PHASE 900, round 904. PRODUCTION. What passes 1 and 2 taught, corrected here:
 *
 *   a3 the drawing picker is a "pick a drawing ▾" BUTTON that reveals the
 *      "search drawings…" field — pass 2 looked for the field directly and
 *      found the empty state instead. Click the button first.
 *   c  the panel AUTO-OPENS when a request is pending (that is the feature),
 *      so pass 2's click on the composer's "secret" button timed out: the
 *      button now reads "secret" plus a count badge and the panel was already
 *      up. Drive the open panel directly.
 *   d  the file tree needs a folder expanded before any leaf exists.
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
  if (!c.length) throw new Error(`no chromium under ${cache}`);
  return c[0];
}

const BASE = process.env.PROD_BASE ?? "https://os.schreinercontentsystems.com";
const COOKIE = (process.env.FORGE_SECURE_COOKIE ?? "").trim();
const CHAT_TEXT = process.env.CHAT_TEXT ?? "Okay when I click the file section";
const CANARY = process.env.SECRET_NAME ?? "verify904-synthetic-canary";
const SYNTHETIC_VALUE = "SYNTHETIC-VALUE-NOT-A-REAL-CREDENTIAL-904";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty");

const report = { base: BASE, canary: CANARY, features: {}, shots: [], errors: [] };

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

  // ==== a3 : Excalidraw follows the theme ================================
  for (const theme of ["dark", "light"]) {
    console.log(`\n=== a3 canvas ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);
    await page.getByText("CANVAS", { exact: true }).first().click();
    await page.waitForTimeout(4_000);

    const picker = page.getByText("pick a drawing", { exact: false }).first();
    if (await picker.count()) {
      await picker.click();
      await page.waitForTimeout(2_500);
      const pick = await page.evaluate(() => {
        const els = [...document.querySelectorAll("div,button,li,span")].filter(
          (e) => e.children.length === 0 && /\.excalidraw$/.test((e.textContent || "").trim()),
        );
        return els.length ? (els[0].textContent || "").trim() : null;
      });
      report.features[`canvasPick_${theme}`] = pick;
      console.log(`  drawing: ${pick}`);
      if (pick) {
        await page.getByText(pick, { exact: true }).first().click();
        await page.waitForTimeout(10_000);
      }
    } else {
      report.features[`canvasPick_${theme}`] = "picker button not found";
    }

    const exc = await page.evaluate(() => {
      const root = document.querySelector(".excalidraw");
      if (!root) return { present: false, paneText: (document.body.innerText.match(/no drawing open[^\n]*/) || [""])[0] };
      return {
        present: true,
        isDarkClass: root.classList.contains("theme--dark"),
        classes: String(root.className).slice(0, 200),
        rootBg: getComputedStyle(root).backgroundColor,
      };
    });
    report.features[`canvas_${theme}`] = exc;
    console.log(`  excalidraw: ${JSON.stringify(exc).slice(0, 260)}`);
    await shoot(page, `prod-feature-canvas-${theme}.png`);
    await page.context().close();
  }

  // ==== c : answer the request (dark), and shoot the light panel =========
  for (const theme of ["dark", "light"]) {
    console.log(`\n=== c secret ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);
    await page.waitForTimeout(2_000);

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
    report.features[`secretPanel_${theme}`] = panel;
    console.log(`  panel: ${JSON.stringify(panel).slice(0, 300)}`);
    await shoot(page, `prod-feature-secret-panel-${theme}.png`);

    if (theme === "dark" && panel.autoOpened) {
      const val = page.locator('textarea[placeholder^="paste the secret"], input[placeholder^="paste the secret"]').first();
      await val.fill(SYNTHETIC_VALUE);
      await page.waitForTimeout(800);
      await shoot(page, "prod-feature-secret-answer-filled.png");
      const btn = page.getByText("answer request", { exact: false }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(5_000);
        const after = await page.evaluate((name) => ({
          stillWaiting: document.body.innerText.includes("an agent is waiting for"),
          mentionsCanary: document.body.innerText.includes(name),
        }), CANARY);
        report.features.secretAnswered = after;
        console.log(`  after answer: ${JSON.stringify(after)}`);
        await shoot(page, "prod-feature-secret-answered.png");
      }
    }
    await page.context().close();
  }

  // ==== d : open ↗ ======================================================
  {
    console.log(`\n=== d open in new tab ===`);
    const page = await newPage(browser);
    await openChat(page);
    await page.getByText("Files", { exact: true }).first().click();
    await page.waitForTimeout(4_000);

    for (const folder of ["Agent Workspace", "Obsidian Vault"]) {
      const f = page.getByText(folder, { exact: true }).first();
      if (await f.count()) {
        await f.click();
        await page.waitForTimeout(3_500);
        console.log(`  expanded ${folder}`);
        break;
      }
    }
    await shoot(page, "prod-feature-files-expanded.png");

    let picked = null;
    for (let depth = 0; depth < 5 && !picked; depth++) {
      const cand = await page.evaluate(() => {
        const seen = [...document.querySelectorAll("div,button,span")]
          .filter((e) => e.children.length === 0)
          .map((e) => ({ el: e, t: (e.textContent || "").trim() }))
          .filter((x) => x.t.length > 1 && x.t.length < 70);
        const file = seen.find((x) => /\.(md|txt|json)$/i.test(x.t));
        if (file) return { kind: "file", text: file.t };
        const dir = seen.find((x) => /^[A-Za-z0-9][\w .&\-]{2,40}$/.test(x.t) && !x.t.includes("."));
        return dir ? { kind: "folder", text: dir.t } : null;
      });
      if (!cand) break;
      console.log(`  clicking ${cand.kind}: ${cand.text}`);
      await page.getByText(cand.text, { exact: true }).first().click();
      await page.waitForTimeout(3_000);
      if (cand.kind === "file") picked = cand.text;
    }
    report.features.filePicked = picked;
    await shoot(page, "prod-feature-filepreview.png");

    const link = page.locator('a[href^="/document?"]').first();
    const has = (await link.count()) > 0;
    report.features.openInNewTabButton = has;
    console.log(`  open ↗ anchor: ${has}`);
    if (has) {
      report.features.openInNewTabHref = await link.getAttribute("href");
      const [tab] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 25_000 }).catch(() => null),
        link.click(),
      ]);
      const target = tab ?? page;
      await target.waitForLoadState("networkidle", { timeout: 40_000 }).catch(() => {});
      await target.waitForTimeout(3_500);
      const doc = await target.evaluate(() => ({
        url: location.href,
        chars: (document.body.innerText || "").length,
        head: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260),
      }));
      report.features.newTabDocument = { openedInNewTab: !!tab, ...doc };
      console.log(`  doc tab: ${JSON.stringify(doc).slice(0, 320)}`);
      await shoot(target, "prod-feature-newtab-document.png");
    }
    await page.context().close();
  }

  fs.writeFileSync(path.join(OUT, "features3-904.json"), JSON.stringify(report, null, 2));
  console.log(`\nerrors: ${report.errors.length}`);
  await browser.close();
})();
