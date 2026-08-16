/**
 * recon-904.cjs — what does PRODUCTION actually expose?
 *
 * PHASE 900, round 904. Read-only. Drives a real Chromium against the real
 * production origin (https://os.schreinercontentsystems.com, nginx -> :7701,
 * the pm2 `forge-control-web` process running /opt/forge-ai-os). It changes
 * nothing: no route interception, no DOM injection, no localStorage seeding.
 *
 * Purpose: discover the selectors the capture pass needs, rather than guessing
 * them from source and shooting eight blank screenshots. Prints a structural
 * dump — nav rail items, chat rows, panel toggles, data-* attributes actually
 * present in the shipped DOM.
 *
 * Auth: /desktop is behind GitHub OAuth. AUTH_URL is https, so next-auth uses
 * the `__Secure-` cookie prefix AND that prefix is the JWE salt. The cookie is
 * minted from the production AUTH_SECRET (see verification-904.md) — the same
 * recipe phases 1, 500 and 800 used, adjusted for the secure prefix.
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
if (!COOKIE) throw new Error("FORGE_SECURE_COOKIE is empty — mint it first");

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(4_000);

  const dump = await page.evaluate(() => {
    const attrs = new Set();
    document.querySelectorAll("*").forEach((el) => {
      for (const a of el.attributes) if (a.name.startsWith("data-")) attrs.add(`${a.name}="${a.value}"`);
    });
    const clickableText = [...document.querySelectorAll("button, [role=button], a")]
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70))
      .filter(Boolean);
    return {
      url: location.href,
      theme: document.documentElement.dataset.theme ?? null,
      dataAttrs: [...attrs].sort().slice(0, 120),
      clickable: [...new Set(clickableText)].slice(0, 80),
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1500),
    };
  });

  fs.writeFileSync(path.join(__dirname, "recon-904.json"), JSON.stringify({ ...dump, errors }, null, 2));
  await page.screenshot({ path: path.join(__dirname, "recon-904-initial.png"), fullPage: false });
  console.log(JSON.stringify({ ...dump, errors }, null, 2));
  await browser.close();
})();
