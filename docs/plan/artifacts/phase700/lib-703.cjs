/**
 * lib-703.cjs — the pieces every round-703 protocol shares.
 *
 * Same reasoning as phase600's `lib-604.cjs`, which this file is modelled on
 * and partly copied from: five protocols is where per-script copies of the
 * cookie handling and the chat-opening stop paying, because a reviewer cannot
 * compare five JSONs whose setups drifted apart. One module, `require`d by
 * siblings in the same directory, so every script is still a plain `node`
 * invocation with no build step.
 *
 * WHAT IS REAL HERE, stated up front.
 *
 * Nothing in this file intercepts, injects or rewrites a response. Round 604's
 * `injectTeamRow` existed because no chat in this database was linked to a
 * project with live runs; round 701 fixed exactly that by writing
 * `origin_chat_id` on project `8ea0cc08…` (linkage-701.md §3), so this round's
 * fixture chat reaches its own real team tree and its own real plan by being
 * clicked, the way a person reaches it. The ONE place this round routes a
 * response is `nav-walk-700.cjs`'s error path, which has to manufacture a doc
 * name the server will refuse; that interception is declared in that file and
 * nowhere else.
 *
 * THREE SERVERS, three different rules — do not mix them up:
 *
 *   BASE   :7809  the isolated Next build of THIS worktree (`/tmp/phase700-web`,
 *                 built with FORGE_CONTROL_URL=:7798). Never pm2, never :7701.
 *   API    :7798  the worktree API harness, `scripts/checks/serve-v3-7798.ts`.
 *                 NEVER `forge-control/src/index.ts` on any port — it boots the
 *                 cron tick, the Telegram bridge and the vault sync against the
 *                 live database and the live bot token (linkage-701.md §7).
 *   GROUND :7700  the LIVE forge-control. Read-only `GET` only, and only for
 *                 `/api/projects/:id` — the third leg of the count-agreement
 *                 triangle, which is worthless if it is read off the same
 *                 process as the other two. No POST, no PATCH, no DELETE ever
 *                 goes to this constant.
 *
 * NFU8: playwright is loaded by ABSOLUTE PATH from /opt/hermes-workspace and is
 * not a dependency of either repo. `resolveChromium` is copied verbatim from
 * scripts/checks/frozen-dom.cjs:30-58, as lib-604.cjs did.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

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
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const BASE = process.env.PHASE700_BASE_URL ?? "http://127.0.0.1:7809";
const API = process.env.PHASE700_API_URL ?? "http://127.0.0.1:7798";
/** LIVE forge-control. GET only — see the header. */
const GROUND = process.env.PHASE700_GROUND_URL ?? "http://127.0.0.1:7700";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";

/** bfd1283a — the chat round 701 linked to project 8ea0cc08 (linkage-701.md §2
 *  names it; round 702 captured against it). Resolved from its title at run
 *  time so no uuid is hard-coded into a protocol. */
const CHAT_TEXT = process.env.PHASE700_CHAT ?? "Okay when I click the file section";
/** The project the fixture chat is linked to — the ground-truth leg's subject.
 *  It is asserted against `/plan`'s own `project.id`, never trusted blind. */
const PROJECT_ID =
  process.env.PHASE700_PROJECT ?? "8ea0cc08-28d9-4301-9f28-c98e1c5d6838";

/** 1440x900, the viewport 14-ui-v3-quality.md fixes for phase-700 evidence.
 *  Phases 500/600 shot at 1600x1000; this round's brief names 1440x900 and the
 *  narrower panel is the harder case, so it is the one measured. */
const VIEWPORT = { width: 1440, height: 900 };

/** Where the COMMITTED evidence lives. Baselines are READ from here, always —
 *  `SRC_DIR` never moves, whatever `OUT_DIR` is doing. */
const SRC_DIR = __dirname;

/**
 * Where a rerun WRITES. Round 704 finding #4: this used to be `__dirname` too,
 * so following README §2 step E — the documented reproduce procedure, aimed at
 * a reviewer — overwrote the very JSONs the reviewer was in the middle of
 * reading. The record and the rerun were the same file, and
 * `git checkout -- docs/plan/artifacts/` was the only way back; round 704 had
 * to do that three times.
 *
 * So a rerun is now NON-DESTRUCTIVE by default: it writes to
 * `/tmp/phase700-out`, prints the path, and prints the `diff` line that
 * compares it against the committed copy. The round that PRODUCES the evidence
 * passes `--write` (or `PHASE700_WRITE=1`) and re-records in place, which is an
 * explicit act rather than a side effect of reading the docs.
 *
 * `PHASE700_OUT_DIR` overrides both, for a reviewer who wants two reruns side
 * by side.
 */
const WRITE_IN_PLACE = process.argv.includes("--write") || process.env.PHASE700_WRITE === "1";
const OUT_DIR =
  process.env.PHASE700_OUT_DIR ?? (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase700-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

/* ── A tiny assertion harness, shared so every JSON has the same shape ────── */

function makeChecker() {
  const results = [];
  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    results.push({ name, ok, actual, expected });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}` +
        (ok
          ? ""
          : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
    );
  };
  const note = (name, value) => {
    results.push({ name, note: value });
    console.log(`      ${name}: ${JSON.stringify(value)}`);
  };
  return { results, check, note, failed: () => failures };
}

/* ── HTTP, straight from node (no browser, no proxy) ──────────────────────── */

/**
 * One GET, with the wall clock stamped on both sides of it.
 *
 * The stamps are not decoration. This project's own task statuses move WHILE
 * this round runs — 51/66 at round 701, 54/66 at 702, 55/66 at the top of this
 * round — so a three-way disagreement means nothing unless a reviewer can see
 * how far apart the three reads were. Every leg of `count-agreement.cjs`
 * carries its `started_at`/`finished_at` for exactly that reason.
 */
async function timedGet(origin, pathname) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const r = await fetch(`${origin}${pathname}`);
  const elapsed_ms = Date.now() - t0;
  const finished = new Date().toISOString();
  if (!r.ok) throw new Error(`GET ${origin}${pathname} → ${r.status} ${r.statusText}`);
  return { body: await r.json(), started_at: started, finished_at: finished, elapsed_ms };
}

async function api(pathname) {
  return (await timedGet(API, pathname)).body;
}

/** Resolve the fixture chat's row from `GET /api/chat` by title fragment. */
async function resolveChat(titleFragment = CHAT_TEXT) {
  const list = await api("/api/chat?limit=50");
  const hit = (list.runs ?? []).find((r) => (r.title ?? "").includes(titleFragment));
  if (!hit) throw new Error(`no chat whose title contains ${JSON.stringify(titleFragment)}`);
  return hit;
}

/* ── Browser ──────────────────────────────────────────────────────────────── */

/**
 * `contextOptions` is spread over the defaults so `network-700.cjs` can add
 * `recordHar` without a second copy of the cookie wiring.
 */
async function withBrowser(fn, contextOptions = {}) {
  if (!COOKIE)
    throw new Error("FORGE_SESSION_COOKIE is empty — mint one first (README.md §2 step C)");
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let context = null;
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, ...contextOptions });
    context = ctx;
    await ctx.addCookies([
      {
        name: "authjs.session-token",
        value: COOKIE,
        domain: new URL(BASE).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    return await fn(ctx, browser);
  } finally {
    /* lib-604.cjs's comment applies verbatim: `unrouteAll` first, because a
     * `ctx.route` handler mid-`route.fetch()` when the browser goes away
     * rejects from outside any await this file owns and kills the process
     * before the verdict is written — a green run reported as a crash.
     * `context.close()` is what flushes a recorded HAR to disk, so it is not
     * optional either. */
    if (context !== null) {
      await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      await context.close().catch(() => {});
    }
    await browser.close();
  }
}

/** Collect console errors and 4xx/5xx responses, with the one pre-existing
 *  line this app emits on every page separated out rather than filtered away.
 *  `GET /favicon.ico` 404s on main as well as on this branch (the repo ships
 *  no favicon) — kanban-702.cjs recorded the same, and an ignore list that
 *  hides its own contents is how a real error gets ignored later. */
function watchErrors(page) {
  const consoleErrors = [];
  const ignored = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url ?? "";
    if (url.endsWith("/favicon.ico")) return ignored.push(`${m.text()} — ${url}`);
    consoleErrors.push(`${m.text()} — ${url}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });
  return { consoleErrors, ignored, failedRequests };
}

/**
 * Open /desktop, switch to CHAT, click the fixture chat, wait for BOTH zones.
 *
 * Phase 600's `openChat` waited on the team zone only. This round's surface has
 * two zones and every protocol here reads both, so waiting on one and sleeping
 * for the other is how a flake gets written. Both waits name the attribute they
 * failed on.
 */
async function openChat(page, chatText = CHAT_TEXT) {
  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(chatText, { exact: false }).first().click();
  await page.waitForSelector("[data-team-row]", { timeout: 30_000 });
  await waitForAttr(page, "[data-team-panel]", "data-team-state", "ready");
  await waitForAttr(page, "[data-plan-kanban]", "data-plan-state", "ready");
  await page.waitForTimeout(1_500);
}

/** Wait for `selector`'s `attr` to equal `want`, and on timeout report what it
 *  actually said — a bare "timeout waiting for selector" tells a reviewer
 *  nothing about which state the zone got stuck in. */
async function waitForAttr(page, selector, attr, want, timeout = 30_000) {
  await page
    .waitForFunction(
      ([sel, a, w]) => document.querySelector(sel)?.getAttribute(a) === w,
      [selector, attr, want],
      { timeout },
    )
    .catch(async () => {
      const got = await page.evaluate(
        ([sel, a]) => document.querySelector(sel)?.getAttribute(a) ?? "<element absent>",
        [selector, attr],
      );
      throw new Error(`${selector} never reached ${attr}="${want}" (got "${got}")`);
    });
}

/** Write the verdict into OUT_DIR and exit with the right code. */
function finish(fileName, payload, failures) {
  const out = path.join(OUT_DIR, fileName);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} → ${out}`);
  if (OUT_DIR !== SRC_DIR) {
    /* Say it out loud rather than letting a reviewer wonder why git is clean:
     * a rerun did NOT touch the committed artifact, and here is how to compare. */
    console.log(`      committed evidence left untouched (${path.join(SRC_DIR, fileName)})`);
    console.log(`      diff -u "${path.join(SRC_DIR, fileName)}" "${out}"`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

module.exports = {
  API,
  BASE,
  CHAT_TEXT,
  COOKIE,
  GROUND,
  OUT_DIR,
  PROJECT_ID,
  SRC_DIR,
  VIEWPORT,
  api,
  finish,
  makeChecker,
  openChat,
  resolveChat,
  resolveChromium,
  timedGet,
  waitForAttr,
  watchErrors,
  withBrowser,
};
