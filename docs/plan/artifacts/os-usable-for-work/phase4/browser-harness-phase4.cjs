/**
 * browser-harness-phase4.cjs — phase 4 / B4a's authenticated browser harness.
 *
 * Owned by B4a. Phase 1 owns the shared harness DOC in another worktree; this
 * file is the runnable recipe rebuilt from `docs/plan/artifacts/phase1871/README.md:306`,
 * which is committed HERE, so the two cannot collide at integration.
 *
 * ── WHAT IT PROVES ───────────────────────────────────────────────────────
 *   before      Settings → CONNECTIONS as it renders today: a health word with
 *               no probe age (R45's defect, D1/D2 of the determination).
 *   after       the same surface after the fix, plus the two live assertions:
 *               Probe now advances last_probed_at (R45), and a priority change
 *               survives a reload (R47).
 *   add-flow    the honest add-an-account flow: the exact copyable
 *               `claude auth login --claudeai` command, then register, then a
 *               REAL probed health on the new row (R46).
 *
 * ── THE ISOLATION RULE ───────────────────────────────────────────────────
 * This harness CLICKS PROBE and REGISTERS ACCOUNTS. It must never do either to
 * the live registry (`ai_os` on 127.0.0.1:5434). The API process it drives is
 * started with AI_OS_DATABASE_URL pointed at a throwaway `b4a_scratch`
 * database, and /tmp/b4a-serve.ts refuses to boot against anything else.
 *
 * ── STANDING THE STACK UP (run from the worktree root) ────────────────────
 *
 *   # 0. fixture credential dirs — presence-only, no real token material
 *   rm -rf /tmp/b4a-cfg && mkdir -p /tmp/b4a-cfg/fresh /tmp/b4a-cfg/blanked
 *   #   fresh/.credentials.json   → {"claudeAiOauth":{accessToken,refreshToken,expiresAt}}
 *   #   blanked/.credentials.json → the 2026-08-02 shape: both tokens ""
 *
 *   # 1. the scratch registry (schema copied verbatim from `\d claude_accounts`
 *   #    on ai_os:5434 — see executor-auth-determination.md §3)
 *   psql -U postgres -h 127.0.0.1 -p 5432 -c "CREATE DATABASE b4a_scratch"
 *   #    seed: arved (probed 4 min ago), stale-green (healthy, NEVER probed —
 *   #    the R57 fixture), claude-worker-legacy (broken, never probed)
 *
 *   # 2. THIS WORKTREE's accounts router on a spare port. Routers only —
 *   #    never boot forge-control/src/index.ts, which starts cron, the Telegram
 *   #    long-poll, the vault tick and a SECOND probe loop.
 *   cd forge-control
 *   AI_OS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/b4a_scratch \
 *     ./node_modules/.bin/tsx /tmp/b4a-serve.ts &          # :7742
 *
 *   # 3. THE TRAP. `next start` bakes its /api/proxy rewrite target at BUILD
 *   #    time (next.config.mjs reads FORGE_CONTROL_URL at config evaluation).
 *   #    Skip the rebuild and you silently drive the LIVE :7700 backend and
 *   #    your screenshots prove nothing. Verify afterwards:
 *   #      grep -o 'http://127.0.0.1:[0-9]*' .next/routes-manifest.json | sort -u
 *   #    must print 7742 and nothing else.
 *   cd ../forge-control-web
 *   FORGE_CONTROL_URL=http://127.0.0.1:7742 ./node_modules/.bin/next build
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a   # a READ of live
 *   AUTH_URL=http://127.0.0.1:7743 FORGE_CONTROL_URL=http://127.0.0.1:7742 \
 *     ./node_modules/.bin/next start -p 7743 &
 *
 *   # 4. the cookie. TWO SALTS EXIST (02-architecture.md). This harness runs an
 *   #    http AUTH_URL, so it is "authjs.session-token" with secure:false. The
 *   #    live https host needs "__Secure-authjs.session-token" with secure:true,
 *   #    and the wrong one is a 307 to /signin that reads exactly like an
 *   #    expired token.
 *   node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
 *     token:{name:"p4",email:"check@localhost",sub:"check"},
 *     secret:process.env.AUTH_SECRET,salt:"authjs.session-token",maxAge:14400})))' \
 *     > /tmp/b4a-cookie.txt
 *
 *   # 5. run
 *   node docs/plan/artifacts/os-usable-for-work/phase4/browser-harness-phase4.cjs before
 *   node docs/plan/artifacts/os-usable-for-work/phase4/browser-harness-phase4.cjs after
 *   node docs/plan/artifacts/os-usable-for-work/phase4/browser-harness-phase4.cjs add-flow
 *
 * Screenshots land in /opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png and
 * are then copied into this directory and committed (N7) — /opt/ai-os/uploads
 * is not permanent.
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

/* ---------------------------------------------------------------- config -- */

const MODE = process.argv[2];
if (!["before", "after", "add-flow"].includes(MODE || "")) {
  throw new Error(`usage: browser-harness-phase4.cjs <before|after|add-flow>; got ${JSON.stringify(MODE)}`);
}

const BASE = process.env.B4A_BASE_URL || "http://127.0.0.1:7743";
const COOKIE_FILE = process.env.B4A_COOKIE_FILE || "/tmp/b4a-cookie.txt";
const RUN_ID = process.env.FORGE_RUN_ID;
if (!RUN_ID) throw new Error("FORGE_RUN_ID is not set — screenshots would land where Konrad cannot see them");
const SHOT_DIR = `/opt/ai-os/uploads/${RUN_ID}`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

/** The API the browser is really talking to, for the assertions that read JSON
 *  directly. Same origin as the page, through the same baked-in proxy — if this
 *  disagrees with what the page shows, the page is the thing that is wrong. */
const API = `${BASE}/api/proxy/accounts`;

const COOKIE = fs.readFileSync(COOKIE_FILE, "utf8").trim();
if (!COOKIE) throw new Error(`${COOKIE_FILE} is empty — mint the cookie first (step 4)`);

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

const results = [];
function ok(label, cond, detail) {
  results.push({ label, ok: !!cond, detail });
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function chromePath() {
  const cache = "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (found.length === 0) throw new Error(`no chromium under ${cache}`);
  return found[0];
}

/**
 * STEP 5 OF THE RECIPE, AND IT IS NOT OPTIONAL.
 * Every browser step asserts it is past the auth wall BEFORE it believes
 * anything it sees. An agent that skips this screenshots the login page and
 * reports a dead surface.
 */
function assertPastTheWall(page, where) {
  const url = page.url();
  if (/\/signin\b/.test(url)) {
    throw new Error(
      `auth wall at ${where}: landed on ${url}. FIRST SUSPECT IS THE SALT, not the secret: ` +
        `an http AUTH_URL harness needs salt AND cookie name "authjs.session-token" with ` +
        `secure:false; an https AUTH_URL needs "__Secure-authjs.session-token" with secure:true. ` +
        `A wrong salt is a 307 that looks exactly like an expired token.`,
    );
  }
}

async function shot(page, label) {
  const file = path.join(SHOT_DIR, `${stamp()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  shot ${file}`);
  return file;
}

/**
 * Read the API the browser is really talking to.
 *
 * THE COOKIE IS NOT OPTIONAL HERE EITHER. `middleware.ts` guards `/api/proxy/*`
 * exactly as it guards a page, and an unauthenticated request is REWRITTEN to
 * the sign-in page — which comes back as **200 with HTML**, not a 401. So a
 * bare `fetch()` from node looks like a successful call and then fails a JSON
 * parse somewhere far from the cause. That happened on the first run of this
 * harness; hence the explicit assertion below rather than a comment.
 */
async function api(pathSuffix, init) {
  const headers = { ...(init && init.headers), cookie: `authjs.session-token=${COOKIE}` };
  const res = await fetch(`${API}${pathSuffix}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  if (/<!DOCTYPE html|__next|\/signin/i.test(text.slice(0, 400))) {
    throw new Error(
      `${API}${pathSuffix} answered with the SIGN-IN PAGE (HTTP ${res.status}), not JSON. ` +
        `The middleware rewrites unauthenticated /api/proxy calls to /signin and returns 200, ` +
        `so this reads as success. Send the session cookie, and check the salt: an http ` +
        `AUTH_URL needs "authjs.session-token", an https one "__Secure-authjs.session-token".`,
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${API}${pathSuffix} returned non-JSON (${res.status}): ${text.slice(0, 400)}`);
  }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ main -- */

(async () => {
  const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1150 },
    deviceScaleFactor: 2,
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  /**
   * Open Settings → Connections.
   *
   * `/settings` is a thin wrapper whose body IS `ConnectionsPanel` — the exact
   * component the in-shell settings surface mounts in its CONNECTIONS section
   * (`app/settings/page.tsx`, round 1876). One implementation, two entry
   * points, so driving the URL drives the same surface Konrad clicks to.
   */
  async function openConnections() {
    await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    assertPastTheWall(page, "/settings");
    await page.waitForSelector("[data-connections-panel]", { timeout: 15000 });
    // The registry fetch resolves on mount; wait for a row rather than a timer.
    await page.waitForSelector("[data-connection-row]", { timeout: 15000 });
    assertPastTheWall(page, "connections panel");
  }

  const rowState = (slug) =>
    page.locator(`[data-connection-row="claude:${slug}"]`).getAttribute("data-connection-state");
  const rowText = (slug) => page.locator(`[data-connection-row="claude:${slug}"]`).innerText();

  try {
    if (MODE === "before") {
      await openConnections();
      const shotFile = await shot(page, "b4a-before-connections");
      const arved = await rowText("arved");
      const stale = await rowText("stale-green");
      console.log("\n--- what the collapsed rows say today ---");
      console.log(`arved:\n${arved}\n`);
      console.log(`stale-green:\n${stale}\n`);
      ok(
        "DEFECT REPRODUCED: the collapsed arved row shows a health word with NO probe age",
        !/probed/i.test(arved),
        `row text: ${JSON.stringify(arved.replace(/\n/g, " | "))}`,
      );
      ok(
        "DEFECT REPRODUCED: stale-green (health=healthy, last_probed_at=NULL) does NOT render unknown",
        (await rowState("stale-green")) !== "unknown",
        `data-connection-state=${await rowState("stale-green")}`,
      );
      console.log(`\nscreenshot: ${shotFile}`);
    }

    if (MODE === "after") {
      await openConnections();

      /* R45 — Probe now advances last_probed_at. */
      const before = await api("");
      const beforeProbed = before.body.accounts.find((a) => a.slug === "stale-green").last_probed_at;
      ok("fixture precondition: stale-green has never been probed", beforeProbed === null, String(beforeProbed));

      // The controls live in the account card under the row. It is MOUNTED but
      // hidden with CSS while collapsed (so a collapse throws no reading away),
      // which means Playwright cannot click it until the row is expanded —
      // and expanding is the flow the panel's own copy describes ("Expand a
      // row for its controls").
      await page.locator('[data-row-toggle="claude:stale-green"]').click();
      await page.locator('[data-connection-row="claude:stale-green"] [data-probe-now]').first().waitFor({
        state: "visible",
        timeout: 10000,
      });
      await page.locator('[data-connection-row="claude:stale-green"] [data-probe-now]').first().click();
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-connection-row="claude:stale-green"] [data-probe-now][data-busy="true"]'),
        { timeout: 20000 },
      );
      const after = await api("");
      const afterRow = after.body.accounts.find((a) => a.slug === "stale-green");
      ok(
        "R45: Probe now advanced last_probed_at",
        afterRow.last_probed_at !== null,
        `${beforeProbed} -> ${afterRow.last_probed_at}`,
      );
      ok(
        "R45/R57: the probe re-derived health from the credential file, and it is not green",
        afterRow.health === "broken",
        `health=${afterRow.health} detail=${afterRow.health_detail}`,
      );

      /* R58 — the verbatim upstream error is on the collapsed row. */
      const legacy = await rowText("claude-worker-legacy");
      ok(
        "R58: the collapsed broken row carries the VERBATIM upstream error",
        legacy.includes("HTTP 401") && legacy.includes("OAuth token has expired or been revoked"),
        JSON.stringify(legacy.replace(/\n/g, " | ").slice(0, 260)),
      );

      /* R45 — the probe age is on the collapsed row, in words. */
      const arved = await rowText("arved");
      ok(
        // `/probed .*ago/` alone is NOT enough: it happily matched
        // "probed NaN d ago" on the first run of this harness, when the API
        // was still serving a build without `probe_age_ms`. The age has to be
        // a NUMBER, and no row anywhere may render NaN.
        "R45: the collapsed arved row states its probe AGE, as a number",
        /probed \d+ (min|h|d) ago|probed just now/i.test(arved),
        JSON.stringify(arved.replace(/\n/g, " | ").slice(0, 260)),
      );
      const wholePanel = await page.locator("[data-connections-panel]").innerText();
      ok(
        "no row anywhere renders NaN",
        !/NaN/.test(wholePanel),
        /.{0,40}NaN.{0,40}/.exec(wholePanel)?.[0],
      );

      /* R47 — priority change persists across a reload. */
      await page.locator('[data-row-toggle="claude:arved"]').click();
      const prioUp = page.locator('[data-priority-up="arved"]').first();
      await prioUp.waitFor({ state: "visible", timeout: 10000 });
      const priorityBefore = before.body.accounts.find((a) => a.slug === "arved").priority;
      await prioUp.click();
      await page.waitForFunction(
        (want) =>
          document.querySelector('[data-priority-value="arved"]')?.textContent?.trim() === String(want),
        priorityBefore + 10,
        { timeout: 20000 },
      );
      const shotFile = await shot(page, "b4a-after-claude-accounts");

      await page.reload({ waitUntil: "networkidle" });
      assertPastTheWall(page, "after reload");
      await page.waitForSelector("[data-connection-row]", { timeout: 15000 });
      const persisted = (await api("")).body.accounts.find((a) => a.slug === "arved").priority;
      ok(
        "R47: the priority change PERSISTED across a full page reload",
        persisted === priorityBefore + 10,
        `${priorityBefore} -> ${persisted}`,
      );
      console.log(`\nscreenshot: ${shotFile}`);
    }

    if (MODE === "add-flow") {
      await openConnections();
      await page.locator("[data-add-account-open]").first().click();
      await page.waitForSelector("[data-add-account-form]", { timeout: 10000 });

      const form = await page.locator("[data-add-account-form]").innerText();
      ok(
        "R46: the add flow shows the EXACT interactive login command",
        form.includes("claude auth login --claudeai"),
        JSON.stringify(form.replace(/\n/g, " | ").slice(0, 300)),
      );
      ok(
        "R46: the add flow does NOT imply a browser OAuth flow that does not exist",
        !/sign in with|connect with claude|authorize in your browser|oauth consent/i.test(form),
        "no browser-consent language",
      );
      ok(
        "R46: it says the directory must ALREADY hold a .credentials.json",
        /\.credentials\.json/.test(form),
      );

      const slug = `b4a-added-${Date.now().toString(36)}`;
      await page.locator("[data-add-account-slug]").fill(slug);
      await page.locator("[data-add-account-dir]").fill("/tmp/b4a-cfg/blanked-2");
      // The command block must react to the directory typed in, not print a
      // constant — that is what makes it copyable rather than decorative.
      const cmd = await page.locator("[data-add-account-command]").innerText();
      ok(
        "R46: the command names the directory being registered",
        cmd.includes("CLAUDE_CONFIG_DIR=/tmp/b4a-cfg/blanked-2"),
        JSON.stringify(cmd),
      );
      const shotFile = await shot(page, "b4a-add-account-flow");

      await page.locator("[data-add-account-submit]").click();
      await page.waitForSelector(`[data-connection-row="claude:${slug}"]`, { timeout: 20000 });
      const created = (await api("")).body.accounts.find((a) => a.slug === slug);
      ok(
        "R46: registration PROBED the directory — last_probed_at is set",
        created && created.last_probed_at !== null,
        `last_probed_at=${created && created.last_probed_at}`,
      );
      ok(
        "R46: the probed health is REAL, not a bare 'awaiting first probe'",
        created && created.health === "broken" && /no credential file/i.test(created.health_detail || ""),
        `health=${created && created.health} detail=${created && created.health_detail}`,
      );
      ok(
        "R57: the newly-added row does not render a positive state",
        (await rowState(slug)) !== "connected",
        `data-connection-state=${await rowState(slug)}`,
      );
      console.log(`\nscreenshot: ${shotFile}`);
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${MODE}: ${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length) {
    console.log(`\n${failed.length} FAILURE(S)`);
    process.exit(1);
  }
  console.log("PASS");
})().catch((e) => {
  console.error(`\nHARNESS ERROR: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
