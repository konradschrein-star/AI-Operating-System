/**
 * features-904.cjs — U34 step 3: are the four things Konrad asked about LIVE?
 *
 * PHASE 900, round 904. Against PRODUCTION (https://os.schreinercontentsystems.com
 * -> nginx -> :7701, pm2 forge-control-web, /opt/forge-ai-os at main 26ea125).
 * Nothing is stubbed. Nothing is restarted. No application file is edited.
 *
 * The four claims under test:
 *   a. the four phase-800 light-mode fixes
 *        a1 CanvasPane error/conflict/watch-failure banners visible in light
 *           (1.13:1 -> 4.71:1, 1.12:1 -> 5.09:1)          [commit 5054374]
 *        a2 --fg-warn retuned #8a7513 -> #7f6c11, light only  [commit 5054374]
 *        a3 the Excalidraw editor follows the theme instead of being pinned
 *           theme="dark"                                   [commit 5054374]
 *        a4 LeftRail selected-nav #141417 -> tokens.selectedBg
 *           (light 1.03:1 -> 14.55:1)                      [commit 35ade34]
 *   b. colour-coded worker cards / role tints, both themes  [commit a55d01a]
 *   c. the two-way secret sharer: request badge + answer    [0b5eefd, a55d01a]
 *   d. open-in-new-tab in the file explorer                 [commit fc842d3]
 *
 * Method note: a1 and a2 are COLOUR facts, so they are read as colours —
 * `getComputedStyle` on the live document, which is the value the fix shipped
 * or did not ship. A screenshot of a banner nobody triggered would prove less,
 * not more; the banners are error states and this task does not get to break
 * production to photograph one. a3 and a4 are photographed because they are
 * whole-surface facts a picture actually settles.
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
  if (!candidates.length) throw new Error(`no chromium under ${cache}`);
  return candidates[0];
}

const BASE = process.env.PROD_BASE ?? "https://os.schreinercontentsystems.com";
const COOKIE = (process.env.FORGE_SECURE_COOKIE ?? "").trim();
const CHAT_TEXT = process.env.CHAT_TEXT ?? "Okay when I click the file section";
const SECRET_NAME = process.env.SECRET_NAME ?? "";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty");

const report = { base: BASE, features: {}, shots: [], errors: [] };

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "__Secure-authjs.session-token",
      value: COOKIE,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
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
  const got = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
  if (got !== want) throw new Error(`theme flip failed: wanted ${want}, got ${got}`);
  await page.waitForTimeout(600);
}

async function shoot(target, name) {
  const file = path.join(OUT, name);
  await target.screenshot({ path: file });
  const bytes = fs.statSync(file).size;
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

/** The live palette, straight off the production document. */
async function palette(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = [
      "roleBgArchitect", "roleBgPlanner", "roleBgBuilder", "roleBgReviewer",
      "roleBgResearcher", "roleBgScout", "roleBgSteward", "roleBgTester", "roleBgUnknown",
      "roleInkArchitect", "roleInkPlanner", "roleInkBuilder", "roleInkReviewer",
      "warn", "selectedBg", "bgBody",
    ];
    const out = {};
    for (const n of names) out[n] = cs.getPropertyValue(`--fg-${n}`).trim();
    return out;
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  for (const theme of ["dark", "light"]) {
    console.log(`\n=== ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);

    // ---- a2 / a4 / b : the live palette --------------------------------
    const pal = await palette(page);
    report.features[`palette_${theme}`] = pal;
    const roleBgs = Object.entries(pal).filter(([k]) => k.startsWith("roleBg"));
    const distinct = new Set(roleBgs.map(([, v]) => v.toLowerCase()));
    report.features[`roleTints_${theme}`] = {
      count: roleBgs.length,
      distinct: distinct.size,
      allDistinct: distinct.size === roleBgs.length,
      values: Object.fromEntries(roleBgs),
    };
    console.log(`  role tints: ${roleBgs.length} defined, ${distinct.size} distinct`);
    console.log(`  --fg-warn=${pal.warn}  --fg-selectedBg=${pal.selectedBg}`);

    // ---- a4 : the selected nav row, photographed ------------------------
    const rail = page.locator("nav, [class*=rail]").first();
    const navBox = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find(
        (e) => (e.textContent || "").trim() === "CHAT" && e.children.length === 0,
      );
      if (!el) return null;
      const row = el.closest("div");
      const r = row ? row.getBoundingClientRect() : el.getBoundingClientRect();
      return { bg: getComputedStyle(row || el).backgroundColor, top: r.top, height: r.height };
    });
    report.features[`navSelected_${theme}`] = navBox;
    await shoot(page.locator("body"), `prod-feature-navrail-${theme}.png`);

    // ---- b : worker relay cards, coloured by role -----------------------
    // Find transcript cards whose background matches a role tint, scroll one
    // into view, and photograph the run of them.
    const relay = await page.evaluate((tints) => {
      const want = new Set(Object.values(tints).map((v) => v.toLowerCase()));
      const hex = (rgb) => {
        const m = rgb.match(/\d+/g);
        if (!m) return rgb;
        return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      };
      const hits = [];
      document.querySelectorAll("div").forEach((el) => {
        const bg = hex(getComputedStyle(el).backgroundColor).toLowerCase();
        if (want.has(bg) && el.getBoundingClientRect().height > 20) {
          hits.push({ bg, text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 90) });
        }
      });
      return hits.slice(0, 12);
    }, Object.fromEntries(roleBgs));
    report.features[`relayCards_${theme}`] = relay;
    console.log(`  relay cards visible in transcript: ${relay.length}`);

    // ---- a3 : the canvas editor follows the theme -----------------------
    const canvasBtn = page.getByText("CANVAS", { exact: true }).first();
    if (await canvasBtn.count()) {
      await canvasBtn.click();
      await page.waitForTimeout(6_000);
      const exc = await page.evaluate(() => {
        const root = document.querySelector(".excalidraw");
        if (!root) return { present: false };
        return {
          present: true,
          classes: root.className,
          themeClass: root.classList.contains("theme--dark") ? "dark" : "light",
          bg: getComputedStyle(root).backgroundColor,
        };
      });
      report.features[`canvas_${theme}`] = exc;
      console.log(`  excalidraw: ${JSON.stringify(exc)}`);
      await shoot(page, `prod-feature-canvas-${theme}.png`);
      await canvasBtn.click();
      await page.waitForTimeout(1_500);
    } else {
      report.features[`canvas_${theme}`] = { present: false, note: "CANVAS button not found" };
    }

    // ---- c : the secret panel ------------------------------------------
    const secretBtn = page.getByText("secret", { exact: true }).first();
    if (await secretBtn.count()) {
      await secretBtn.click();
      await page.waitForTimeout(2_500);
      const sec = await page.evaluate((name) => {
        const t = document.body.innerText;
        return {
          panelOpen: /store a secret|secret name|an agent asked|value/i.test(t),
          mentionsRequested: name ? t.includes(name) : false,
          snippet: (t.match(/[^\n]*secret[^\n]*/gi) || []).slice(0, 6),
        };
      }, SECRET_NAME);
      report.features[`secretPanel_${theme}`] = sec;
      console.log(`  secret panel: ${JSON.stringify(sec).slice(0, 220)}`);
      await shoot(page, `prod-feature-secret-${theme}.png`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1_000);
    } else {
      report.features[`secretPanel_${theme}`] = { note: "secret button not found" };
    }

    await page.context().close();
  }

  // ---- d : open-in-new-tab, once (dark) --------------------------------
  {
    console.log(`\n=== d: open in new tab ===`);
    const page = await newPage(browser);
    await openChat(page);
    const filesTab = page.getByText("Files", { exact: true }).first();
    if (await filesTab.count()) {
      await filesTab.click();
      await page.waitForTimeout(4_000);
      await shoot(page, "prod-feature-files-panel.png");

      // pick the first file leaf that looks like a document
      const picked = await page.evaluate(() => {
        const cands = [...document.querySelectorAll("div,button,span")].filter((el) =>
          /\.(md|txt|json|ts|tsx)$/.test((el.textContent || "").trim()) && el.children.length === 0,
        );
        if (!cands.length) return null;
        cands[0].scrollIntoView();
        return (cands[0].textContent || "").trim();
      });
      report.features.filePicked = picked;
      console.log(`  picked file: ${picked}`);
      if (picked) {
        await page.getByText(picked, { exact: true }).first().click();
        await page.waitForTimeout(3_500);
      }
      await shoot(page, "prod-feature-filepreview.png");

      const openLink = page.getByText("open ↗", { exact: false }).first();
      const hasOpen = (await openLink.count()) > 0;
      report.features.openInNewTabButton = hasOpen;
      console.log(`  "open ↗" present: ${hasOpen}`);
      if (hasOpen) {
        const href = await openLink.getAttribute("href");
        report.features.openInNewTabHref = href;
        const [newTab] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 20_000 }).catch(() => null),
          openLink.click(),
        ]);
        if (newTab) {
          await newTab.waitForLoadState("networkidle", { timeout: 40_000 }).catch(() => {});
          await newTab.waitForTimeout(3_000);
          const doc = await newTab.evaluate(() => ({
            url: location.href,
            chars: (document.body.innerText || "").length,
            head: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
          }));
          report.features.newTabDocument = doc;
          console.log(`  new tab: ${JSON.stringify(doc).slice(0, 260)}`);
          await shoot(newTab, "prod-feature-newtab-document.png");
        } else {
          report.features.newTabDocument = { note: "no new page event — link may be same-tab" };
        }
      }
    } else {
      report.features.filesTab = "not found";
    }
    await page.context().close();
  }

  fs.writeFileSync(path.join(OUT, "features-904.json"), JSON.stringify(report, null, 2));
  console.log(`\nerrors: ${report.errors.length}`);
  await browser.close();
})();
