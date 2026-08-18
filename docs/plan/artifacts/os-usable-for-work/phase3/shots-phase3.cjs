#!/usr/bin/env node
/**
 * shots-phase3.cjs — the phase-3 (workstream `surfaces`) reproduction harness.
 *
 * WHAT IT DOES
 *   Drives headless Chromium against a throwaway `next start` served FROM THIS
 *   WORKTREE, past the GitHub-OAuth wall, and photographs the four unbuilt
 *   surfaces (GOALS, JOURNAL, MAP, LIBRARY) plus the nav rail. It also probes
 *   the fifth placeholder key, `search`, which has no nav entry at all.
 *
 * WHY IT EXISTS AS A COMMITTED FILE
 *   B3b changes `PlaceholderSurface` and must photograph the SAME five frames
 *   afterwards, and the gating reviewer must be able to re-derive both sets.
 *   Run it with SHOT_PHASE=after EXPECT_NOT_BUILT=1 to get the after set and a
 *   real assertion instead of a hopeful eyeball.
 *
 * N1 — NO SILENT FALLBACK. Every failure path throws. There is no `catch {}`
 *   returning a default anywhere below, no `?? 0`, no shot written from a page
 *   whose identity was not asserted first. A non-zero exit is the contract.
 *
 * THE ASSERTION THAT MATTERS (02-architecture.md §1, step 5)
 *   `forge-control-web/middleware.ts` 307s every unauthenticated request to
 *   /signin. An agent that skips the check screenshots the login page and
 *   reports a working surface as dead — that has happened in this fleet. So
 *   assertPastTheWall() runs after every navigation, not once at startup.
 *
 * THERE ARE TWO SALTS (corpus commit 3f98e67).
 *   This script targets the throwaway server, whose AUTH_URL is http://, so the
 *   cookie is named and salted `authjs.session-token`. The LIVE UI runs
 *   AUTH_URL=https://os.schreinercontentsystems.com, where auth.js v5 uses
 *   `__Secure-authjs.session-token` as BOTH the cookie name and the JWE salt —
 *   the port does not decide it, the server's AUTH_URL does. Minting with the
 *   wrong salt fails as a 307 to /signin that is indistinguishable from an
 *   expired token, so SALT is read from env and named in the failure message.
 *
 * USAGE
 *   see docs/plan/artifacts/os-usable-for-work/phase3/browser-harness-local.md
 *
 *   FORGE_RUN_ID=<12-hex> \
 *   BASE_URL=http://127.0.0.1:7783 \
 *   COOKIE_FILE=/tmp/session-cookie-phase3.txt \
 *   SHOT_PHASE=before \
 *     node docs/plan/artifacts/os-usable-for-work/phase3/shots-phase3.cjs
 *
 * ENV
 *   FORGE_RUN_ID      required. Upload dir under /opt/ai-os/uploads.
 *   BASE_URL          required. The throwaway server. NEVER point at the live host.
 *   COOKIE_FILE       required. File holding the minted session JWT.
 *   SHOT_PHASE        "before" (default) | "after" — the screenshot label prefix.
 *   COOKIE_NAME       default "authjs.session-token". See "TWO SALTS" above.
 *   COOKIE_SECURE     default "0". Must be "1" when COOKIE_NAME starts __Secure-.
 *   EXPECT_NOT_BUILT  "1" asserts the words "not built" render on all five.
 *                     Unset (the phase-3 BEFORE state) records the absence instead.
 *   ARTIFACT_DIR      optional. If set, each shot is also copied here.
 */

const fs = require("node:fs");
const path = require("node:path");

/* ── Playwright lives in the Hermes workspace on this host; the browser binary
 *    lives in the shared ms-playwright cache. Neither is a devDependency of
 *    forge-control-web and neither is installed by `pnpm install`. ─────────── */
const PW_ROOT = "/opt/hermes-workspace/node_modules/playwright";
const PW_CACHE = "/root/.cache/ms-playwright";

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is not set. This harness has no default for it — see the ENV block at the top of ${path.basename(__filename)}.`,
    );
  }
  return v.trim();
}

function chromiumExecutable() {
  if (!fs.existsSync(PW_CACHE)) {
    throw new Error(`playwright browser cache missing at ${PW_CACHE}`);
  }
  const candidates = fs
    .readdirSync(PW_CACHE)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(PW_CACHE, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(PW_CACHE, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    throw new Error(
      `no chromium binary under ${PW_CACHE} — expected chromium-*/chrome-linux64/chrome or chromium_headless_shell-*/…`,
    );
  }
  return candidates[0];
}

/** Compact UTC ISO-8601, e.g. 20260818T193000Z (N7). */
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const RUN_ID = required("FORGE_RUN_ID");
const BASE_URL = required("BASE_URL").replace(/\/$/, "");
const COOKIE_FILE = required("COOKIE_FILE");
const PHASE = (process.env.SHOT_PHASE ?? "before").trim();
const COOKIE_NAME = (process.env.COOKIE_NAME ?? "authjs.session-token").trim();
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? "0").trim() === "1";
const EXPECT_NOT_BUILT = (process.env.EXPECT_NOT_BUILT ?? "").trim() === "1";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ? process.env.ARTIFACT_DIR.trim() : null;

if (PHASE !== "before" && PHASE !== "after") {
  throw new Error(`SHOT_PHASE must be "before" or "after", got "${PHASE}"`);
}
if (COOKIE_NAME.startsWith("__Secure-") && !COOKIE_SECURE) {
  /* CDP rejects a __Secure- prefixed cookie with secure:false —
   * "Protocol error (Storage.setCookies): Invalid cookie fields". */
  throw new Error(
    `COOKIE_NAME=${COOKIE_NAME} requires COOKIE_SECURE=1; CDP rejects a __Secure- name with secure:false.`,
  );
}
if (/os\.schreinercontentsystems\.com|:7701\b/.test(BASE_URL)) {
  throw new Error(
    `BASE_URL=${BASE_URL} points at the LIVE UI. This is a build-phase harness (N4/N5): run it against a throwaway next start from this worktree.`,
  );
}

const UPLOAD_DIR = path.join("/opt/ai-os/uploads", RUN_ID);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (ARTIFACT_DIR) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const cookieValue = fs.readFileSync(COOKIE_FILE, "utf8").trim();
if (!cookieValue) throw new Error(`${COOKIE_FILE} is empty — mint the session token first.`);

/* ── The four unbuilt NAV surfaces, reached the way Konrad reaches them: by
 *    clicking the label in the left nav rail. `search` is not here because it
 *    has no nav entry — it is probed separately below, which is the finding. */
const NAV_SURFACES = [
  { key: "goals", navLabel: "GOALS", tag: "GOALS" },
  { key: "journal", navLabel: "JOURNAL", tag: "JOURNAL" },
  { key: "map", navLabel: "MAP", tag: "MAP" },
  { key: "library", navLabel: "LIBRARY", tag: "LIBRARY" },
];

/**
 * Assert we are past the OAuth wall. Runs after EVERY navigation.
 * The salt is named first in the message because it is the first suspect and
 * naming AUTH_SECRET/maxAge instead has already cost this fleet two rounds.
 */
async function assertPastTheWall(page, where) {
  const url = page.url();
  if (/\/signin/.test(url)) {
    throw new Error(
      `[${where}] landed on ${url} — NOT past the auth wall. First suspect: the JWE salt. ` +
        `This run used COOKIE_NAME=${COOKIE_NAME} (salt must equal the cookie name). ` +
        `The throwaway http server takes "authjs.session-token"; a server with an https AUTH_URL ` +
        `takes "__Secure-authjs.session-token". Then check AUTH_SECRET and maxAge.`,
    );
  }
  const hasRail = await page.locator("nav").count();
  if (hasRail === 0) {
    throw new Error(`[${where}] no <nav> in the DOM at ${url} — the desktop shell did not mount.`);
  }
}

/** Read the placeholder card's own words back out of the DOM. */
async function probeSurface(page, expectedTag) {
  return page.evaluate((tag) => {
    const text = document.body.innerText;
    return {
      tagVisible: text.includes(tag),
      hasNotBuilt: /not built/i.test(text),
      bulletCount: document.querySelectorAll(".slidein [style*='border-bottom'], .slidein > div > div")
        .length,
      storedSurface: window.localStorage.getItem("forge.desktop.surface"),
      firstChars: text.slice(0, 240).replace(/\s+/g, " "),
    };
  }, expectedTag);
}

async function shoot(target, label) {
  const file = `${stamp()}-${label}.png`;
  const dest = path.join(UPLOAD_DIR, file);
  await target.screenshot({ path: dest });
  const size = fs.statSync(dest).size;
  if (size < 2000) {
    throw new Error(`${dest} is ${size} bytes — that is not a rendered page.`);
  }
  if (ARTIFACT_DIR) fs.copyFileSync(dest, path.join(ARTIFACT_DIR, `${label}.png`));
  console.log(`  shot ${dest} (${size} bytes)`);
  return { label, path: dest, bytes: size, url: `/api/uploads/${RUN_ID}/${file}` };
}

/**
 * Preflight. The throwaway `next start` is a background process with no
 * supervisor: it dies when its shell is reaped and leaves nothing in its log.
 * That happened during this task, and the symptom Playwright reports is
 * `page.goto: Timeout 30000ms exceeded` — which reads like a slow app, not a
 * dead server, and sends the next agent to look at the wrong thing.
 * So: name it here, before the browser is even launched.
 */
async function assertServerUp() {
  const res = await fetch(`${BASE_URL}/desktop`, { redirect: "manual" }).catch((e) => {
    throw new Error(
      `${BASE_URL} is not answering (${e.cause?.code ?? e.message}). The throwaway ` +
        `next start is a background process with no supervisor and dies with its shell. ` +
        `Restart it with setsid — see browser-harness-local.md §1 step 4 — then re-run.`,
    );
  });
  /* 307 → the wall is up and we are anonymous, which is correct here.
   * 200 → also fine (some builds serve /desktop without the redirect).
   * Anything else means the server is up but not serving this app. */
  if (res.status !== 307 && res.status !== 200) {
    throw new Error(`${BASE_URL}/desktop answered ${res.status}; expected 307 (auth wall) or 200.`);
  }
  console.log(`preflight: ${BASE_URL}/desktop → ${res.status}`);
}

(async () => {
  await assertServerUp();
  const { chromium } = require(PW_ROOT);
  const executablePath = chromiumExecutable();
  console.log(`browser: ${executablePath}`);
  console.log(`target : ${BASE_URL}  cookie: ${COOKIE_NAME} (secure=${COOKIE_SECURE})`);
  console.log(`phase  : ${PHASE}  expectNotBuilt=${EXPECT_NOT_BUILT}`);

  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results = [];
  const probes = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies([
      {
        name: COOKIE_NAME,
        value: cookieValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "Lax",
      },
    ]);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/desktop`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav", { timeout: 30_000 });
    await assertPastTheWall(page, "initial load");
    await page.waitForTimeout(4000); // let the polling queries settle

    /* ── 1. the nav rail: it gives no hint which entries are unbuilt ────────── */
    const navs = await page.locator("nav").count();
    if (navs !== 1) {
      throw new Error(
        `expected exactly one <nav> at 1600px (the left rail); found ${navs}. ` +
          `The mobile nav-menu panel should not be mounted at this width — check useNarrowViewport.`,
      );
    }
    results.push(await shoot(page.locator("nav").first(), `${PHASE}-nav-rail`));

    /* ── 2. the four unbuilt NAV surfaces, reached by clicking the rail ─────── */
    for (const s of NAV_SURFACES) {
      const entry = page.locator("nav").getByText(s.navLabel, { exact: true }).first();
      if ((await entry.count()) === 0) {
        throw new Error(`nav rail has no entry labelled "${s.navLabel}" — nav-items.ts changed?`);
      }
      await entry.click();
      await page.waitForTimeout(1500);
      await assertPastTheWall(page, s.key);

      const probe = await probeSurface(page, s.tag);
      if (!probe.tagVisible) {
        throw new Error(
          `clicked ${s.navLabel} but the "${s.tag}" placeholder tag is not in the DOM. ` +
            `Body began: ${probe.firstChars}`,
        );
      }
      if (EXPECT_NOT_BUILT && !probe.hasNotBuilt) {
        throw new Error(
          `EXPECT_NOT_BUILT=1 but "${s.key}" does not render the words "not built" (R38). ` +
            `Body began: ${probe.firstChars}`,
        );
      }
      probes[s.key] = probe;
      console.log(`  ${s.key}: tagVisible=${probe.tagVisible} hasNotBuilt=${probe.hasNotBuilt}`);
      results.push(await shoot(page, `${PHASE}-${s.key}`));
    }

    /* ── 3. the fifth key: `search`.
     *    It is in SURFACES (nav-items.ts:65) and in PLACEHOLDER_SURFACES
     *    (DesktopApp.tsx:176) but NOT in NAV (nav-items.ts:78-96), so no rail
     *    entry, no command-palette row (the palette filters NAV, DesktopApp.tsx:1238)
     *    and no setSurface("search") caller exists. The ONE way in is a stored
     *    localStorage value that passes isSurface() — which is what this proves.
     *    No screenshot: it is a determination, not a nav marker. ──────────── */
    await page.evaluate(() =>
      window.localStorage.setItem("forge.desktop.surface", JSON.stringify("search")),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav", { timeout: 30_000 });
    await assertPastTheWall(page, "search-via-localstorage");
    await page.waitForTimeout(2500);
    const searchProbe = await probeSurface(page, "SEARCH");
    if (!searchProbe.tagVisible) {
      throw new Error(
        `seeded localStorage forge.desktop.surface="search" and reloaded, but the SEARCH ` +
          `placeholder did not render. isSurface() or the render switch changed. ` +
          `Body began: ${searchProbe.firstChars}`,
      );
    }
    probes.search = searchProbe;
    console.log(
      `  search (localStorage only): tagVisible=${searchProbe.tagVisible} hasNotBuilt=${searchProbe.hasNotBuilt} stored=${searchProbe.storedSurface}`,
    );

    /* restore, so a re-run starts from TODAY rather than from `search` */
    await page.evaluate(() =>
      window.localStorage.setItem("forge.desktop.surface", JSON.stringify("today")),
    );

    if (results.length !== 5) {
      throw new Error(`expected 5 screenshots, produced ${results.length}`);
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({ run_id: RUN_ID, phase: PHASE, shots: results, probes }, null, 1));
  console.log(`OK — ${results.length} shots in ${UPLOAD_DIR}`);
})().catch((err) => {
  console.error(`FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
