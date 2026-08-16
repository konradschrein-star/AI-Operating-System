/**
 * capture-904.cjs — U34 production screenshots, four surfaces x two themes.
 *
 * PHASE 900, round 904. READ-ONLY against PRODUCTION.
 *
 * Target is the real production origin — https://os.schreinercontentsystems.com,
 * nginx -> 127.0.0.1:7701, the pm2 `forge-control-web` process serving
 * /opt/forge-ai-os at main = 26ea125. NOT :7798 (the worktree API harness, which
 * cannot serve SSE), NOT :7832, NOT a local build. Every pixel below comes from
 * the build Konrad's browser gets.
 *
 * What this script does NOT do: intercept a route, inject a row, seed
 * localStorage, patch a module, or restart anything. It opens a browser, clicks
 * the same buttons a human clicks, and photographs the result. The only thing it
 * writes to the page is the theme flip — through the app's OWN ThemeToggle
 * button, not by setting the attribute behind the app's back.
 *
 * Auth: /desktop is behind GitHub OAuth, which cannot be driven headlessly.
 * AUTH_URL is https, so next-auth uses the `__Secure-authjs.session-token`
 * cookie prefix and that same string is the JWE salt. Cookie minted from the
 * production AUTH_SECRET — phases 1/500/800's documented recipe, corrected for
 * the secure prefix (the plain `authjs.session-token` those phases used is
 * rejected by production and returns 307 -> /signin; recorded in
 * verification-904.md).
 *
 * Chat under test: bfd1283a — THIS project's own manager chat, 87 workers and
 * 6 sub-agents deep, so no panel is photographed empty.
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
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty — mint it first");

const report = { base: BASE, chat: CHAT_TEXT, shots: [], notes: [], errors: [] };

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

/** Flip the theme through the app's own toggle, then wait for the attribute the
 *  app itself keys the palette off. Asserting the attribute rather than trusting
 *  the click is what stops "both themes" from being two identical PNGs. */
async function setTheme(page, want) {
  for (let i = 0; i < 3; i++) {
    const now = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
    if (now === want) break;
    await page.getByText(now === "dark" ? "light_mode" : "dark_mode", { exact: true }).first().click();
    await page.waitForTimeout(900);
  }
  const got = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
  if (got !== want) throw new Error(`theme flip failed: wanted ${want}, DOM says ${got}`);
  await page.waitForTimeout(600);
  return got;
}

async function shoot(target, name) {
  const file = path.join(OUT, name);
  await target.screenshot({ path: file });
  const bytes = fs.statSync(file).size;
  report.shots.push({ name, bytes });
  console.log(`  shot ${name} (${bytes} bytes)`);
  if (bytes < 5_000) report.notes.push(`${name} is only ${bytes} bytes — inspect, may be blank`);
  return bytes;
}

async function openChat(page) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  for (const theme of ["dark", "light"]) {
    console.log(`\n=== THEME ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);

    // 1. RAIL — the chat list column: x/y task badges per project-linked row.
    await shoot(page, `prod-rail-${theme}.png`);

    // open THIS project's chat so nothing downstream is an empty state
    await page.getByText(CHAT_TEXT, { exact: false }).first().click();
    await page.waitForTimeout(4_000);

    // 2. COMPOSER — bottom of the chat surface.
    await shoot(page, `prod-composer-${theme}.png`);

    // 3. TEAM — open the right panel (collapsed strip carries "● TEAM").
    const teamBtn = page.getByText("● TEAM", { exact: false }).first();
    if (await teamBtn.count()) {
      await teamBtn.click();
      await page.waitForTimeout(4_500);
    } else {
      report.notes.push(`${theme}: no "● TEAM" strip button found — panel may already be open`);
    }
    const panel = page.locator("[data-team-state]").first();
    const state = (await panel.count()) ? await panel.getAttribute("data-team-state") : "(absent)";
    report.notes.push(`${theme}: data-team-state=${state}`);
    await shoot(page, `prod-team-${theme}.png`);

    // 4. KANBAN — the plan zone inside the same panel.
    const kanban = page.locator("[data-plan-kanban]").first();
    if (await kanban.count()) {
      const st = await kanban.getAttribute("data-plan-state");
      const pr = await kanban.getAttribute("data-plan-progress");
      report.notes.push(`${theme}: data-plan-state=${st} data-plan-progress=${pr}`);
      await kanban.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await shoot(kanban, `prod-kanban-${theme}.png`);
    } else {
      report.notes.push(`${theme}: [data-plan-kanban] NOT FOUND`);
    }

    // structural facts worth recording next to the pixels
    const facts = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      teamRows: document.querySelectorAll("[data-team-row]").length,
      planTasks: document.querySelectorAll("[data-plan-task]").length,
      planPhases: document.querySelectorAll("[data-plan-phase]").length,
      linkMarker: document.querySelectorAll("[data-link-marker]").length,
      heuristicText: document.body.innerText.includes("linked heuristically"),
      taskBadges: (document.body.innerText.match(/\d+\/\d+ tasks/g) || []).slice(0, 6),
    }));
    report.notes.push(`${theme}: ${JSON.stringify(facts)}`);
    console.log(`  facts ${JSON.stringify(facts)}`);

    await page.context().close();
  }

  fs.writeFileSync(path.join(OUT, "capture-904.json"), JSON.stringify(report, null, 2));
  console.log(`\n${JSON.stringify(report.notes, null, 2)}`);
  console.log(`errors: ${report.errors.length}`);
  await browser.close();
})();
