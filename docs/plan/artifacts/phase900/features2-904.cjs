/**
 * features2-904.cjs — U34 step 3, second pass: the three features that need
 * real navigation rather than a palette read.
 *
 * PHASE 900, round 904. PRODUCTION, read-only with respect to code and
 * services. Round 1 (`features-904.cjs`) settled the colour facts (a2, a4, b)
 * off the live computed palette and found three things its selectors were too
 * blunt for:
 *
 *   a3 CANVAS — CanvasPane only mounts <Excalidraw> once a drawing PATH exists
 *      (CanvasPane.tsx:813 "no drawing open — pick one above"), so round 1's
 *      click landed on the empty state and the editor was legitimately absent.
 *      This pass picks a drawing through the app's own search field first.
 *   c  SECRET — round 1 matched the word "secret" in Bash transcript text
 *      instead of the panel. This pass drives the real SecretField inputs
 *      (placeholder "name — e.g. vps2_root_ssh_key" / "paste the secret here").
 *      A synthetic pending request (`verify904-synthetic-canary`) was created
 *      via the API before this run so the REQUEST BADGE has something true to
 *      render; it is deleted afterwards. No real credential is typed or shown.
 *   d  OPEN ↗ — the file tree opens on folders ("Obsidian Vault", "Agent
 *      Workspace"); round 1 clicked a transcript line that happened to end in
 *      ".ts". This pass expands a folder, selects a real document, and follows
 *      the anchor into the new tab.
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
const CANARY = process.env.SECRET_NAME ?? "verify904-synthetic-canary";
/** Deliberately unmistakable. Never a real credential, and it must read as
 *  synthetic in a screenshot at a glance. */
const SYNTHETIC_VALUE = "SYNTHETIC-VALUE-NOT-A-REAL-CREDENTIAL-904";
const OUT = __dirname;
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty");

const report = { base: BASE, canary: CANARY, features: {}, shots: [], errors: [] };

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

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });

  // ==== a3: the canvas editor follows the theme, both themes ==============
  for (const theme of ["dark", "light"]) {
    console.log(`\n=== a3 canvas ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);
    await page.getByText("CANVAS", { exact: true }).first().click();
    await page.waitForTimeout(4_000);

    const search = page.getByPlaceholder("search drawings…").first();
    if (await search.count()) {
      await search.click();
      await page.waitForTimeout(2_500);
      // the picker lists drawings; take the first .excalidraw entry offered
      const pick = await page.evaluate(() => {
        const els = [...document.querySelectorAll("div,button,li,span")].filter(
          (e) => /\.excalidraw$/.test((e.textContent || "").trim()) && e.children.length === 0,
        );
        if (!els.length) return null;
        const t = (els[0].textContent || "").trim();
        els[0].scrollIntoView();
        return t;
      });
      report.features[`canvasPick_${theme}`] = pick;
      console.log(`  drawing offered: ${pick}`);
      if (pick) {
        await page.getByText(pick, { exact: true }).first().click();
        await page.waitForTimeout(8_000);
      }
    } else {
      report.features[`canvasPick_${theme}`] = "no search field";
    }

    const exc = await page.evaluate(() => {
      const root = document.querySelector(".excalidraw");
      if (!root) {
        return { present: false, paneText: (document.body.innerText.match(/no drawing open[^\n]*/) || [""])[0] };
      }
      return {
        present: true,
        themeClass: root.classList.contains("theme--dark") ? "theme--dark" : "theme--light(or default)",
        classes: String(root.className).slice(0, 160),
        bg: getComputedStyle(root).backgroundColor,
        canvasBg: (() => {
          const c = root.querySelector("canvas");
          return c ? getComputedStyle(c).backgroundColor : null;
        })(),
      };
    });
    report.features[`canvas_${theme}`] = exc;
    console.log(`  excalidraw: ${JSON.stringify(exc).slice(0, 240)}`);
    await shoot(page, `prod-feature-canvas-${theme}.png`);
    await page.context().close();
  }

  // ==== c: the secret request badge + the answer flow ====================
  for (const theme of ["dark", "light"]) {
    console.log(`\n=== c secret ${theme} ===`);
    const page = await newPage(browser);
    await openChat(page);
    await setTheme(page, theme);

    // The badge: does the composer advertise the pending request unprompted?
    const badge = await page.evaluate((name) => {
      const t = document.body.innerText;
      return { mentionsCanary: t.includes(name), hasSecretButton: /(^|\s)secret(\s|$)/m.test(t) };
    }, CANARY);
    report.features[`secretBadge_${theme}`] = badge;
    console.log(`  badge before open: ${JSON.stringify(badge)}`);
    await shoot(page, `prod-feature-secret-badge-${theme}.png`);

    await page.getByText("secret", { exact: true }).first().click();
    await page.waitForTimeout(3_000);

    const panel = await page.evaluate((name) => {
      const nameInput = document.querySelector('input[placeholder^="name —"]');
      const valInput = document.querySelector('input[placeholder^="paste the secret"], textarea[placeholder^="paste the secret"]');
      return {
        panelPresent: !!(nameInput || valInput),
        nameValue: nameInput ? nameInput.value : null,
        answerMode: nameInput ? nameInput.value === name : false,
        bodyMentionsCanary: document.body.innerText.includes(name),
        noteShown: (document.body.innerText.match(/ROUND 904[^\n]*/) || [""])[0],
      };
    }, CANARY);
    report.features[`secretPanel_${theme}`] = panel;
    console.log(`  panel: ${JSON.stringify(panel).slice(0, 300)}`);
    await shoot(page, `prod-feature-secret-panel-${theme}.png`);

    // Answer it ONCE (dark pass only) with an unmistakably synthetic value.
    if (theme === "dark" && panel.panelPresent) {
      const val = page.locator('input[placeholder^="paste the secret"], textarea[placeholder^="paste the secret"]').first();
      if (await val.count()) {
        await val.fill(SYNTHETIC_VALUE);
        await page.waitForTimeout(800);
        await shoot(page, "prod-feature-secret-answer-filled.png");
        const store = page.getByText("store secret", { exact: false }).first();
        if (await store.count()) {
          await store.click();
          await page.waitForTimeout(4_000);
          report.features.secretStored = true;
          await shoot(page, "prod-feature-secret-answer-stored.png");
        }
      }
    }
    await page.context().close();
  }

  // ==== d: open ↗ into a real document ===================================
  {
    console.log(`\n=== d open in new tab ===`);
    const page = await newPage(browser);
    await openChat(page);
    await page.getByText("Files", { exact: true }).first().click();
    await page.waitForTimeout(4_000);

    // expand a root folder, then walk to the first document leaf
    for (const folder of ["Agent Workspace", "Obsidian Vault"]) {
      const f = page.getByText(folder, { exact: true }).first();
      if (await f.count()) {
        await f.click();
        await page.waitForTimeout(3_000);
        break;
      }
    }
    await shoot(page, "prod-feature-files-expanded.png");

    // click down until a file with an extension is selected
    let picked = null;
    for (let depth = 0; depth < 4 && !picked; depth++) {
      const cand = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("div,button,span")].filter((e) => {
          const t = (e.textContent || "").trim();
          return e.children.length === 0 && /^[\w .()\-]+\.(md|txt|json|png|excalidraw)$/.test(t) && t.length < 80;
        });
        if (rows.length) return { kind: "file", text: (rows[0].textContent || "").trim() };
        const folders = [...document.querySelectorAll("div,button,span")].filter((e) => {
          const t = (e.textContent || "").trim();
          return e.children.length === 0 && /^[A-Za-z0-9][\w .\-]{2,40}$/.test(t) && !t.includes(".");
        });
        return folders.length ? { kind: "folder", text: (folders[0].textContent || "").trim() } : null;
      });
      if (!cand) break;
      await page.getByText(cand.text, { exact: true }).first().click();
      await page.waitForTimeout(3_000);
      if (cand.kind === "file") picked = cand.text;
    }
    report.features.filePicked = picked;
    console.log(`  file selected: ${picked}`);
    await shoot(page, "prod-feature-filepreview.png");

    const openLink = page.locator('a[href^="/document?"]').first();
    const hasOpen = (await openLink.count()) > 0;
    report.features.openInNewTabButton = hasOpen;
    console.log(`  open ↗ anchor present: ${hasOpen}`);
    if (hasOpen) {
      report.features.openInNewTabHref = await openLink.getAttribute("href");
      const [newTab] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 25_000 }).catch(() => null),
        openLink.click(),
      ]);
      const target = newTab ?? page;
      await target.waitForLoadState("networkidle", { timeout: 40_000 }).catch(() => {});
      await target.waitForTimeout(3_500);
      const doc = await target.evaluate(() => ({
        url: location.href,
        chars: (document.body.innerText || "").length,
        head: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
      }));
      report.features.newTabDocument = { openedInNewTab: !!newTab, ...doc };
      console.log(`  document tab: ${JSON.stringify(doc).slice(0, 300)}`);
      await shoot(target, "prod-feature-newtab-document.png");
    }
    await page.context().close();
  }

  fs.writeFileSync(path.join(OUT, "features2-904.json"), JSON.stringify(report, null, 2));
  console.log(`\nerrors: ${report.errors.length}`);
  await browser.close();
})();
