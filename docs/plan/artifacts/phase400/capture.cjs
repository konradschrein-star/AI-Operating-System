/**
 * capture.cjs — phase-400 (UI v3) visual evidence: every surface this phase
 * touched, in BOTH themes, plus a machine-readable currency scan of the exact
 * pixels that were captured.
 *
 * Writes into this directory:
 *   rail-{dark,light}.png          the chat rail — one row WITH an `x/y tasks`
 *                                  badge and rows without one (U10, U13)
 *   header-live-{dark,light}.png   the slim header with the SSE stream open
 *   header-polling-{dark,light}.png  … and with it aborted (U12)
 *   panel-live-{dark,light}.png    the chat SidePanel's Live tab, scoped to the
 *                                  open chat's project (U9)
 *   livedest-{dark,light}.png      the standalone LIVE destination (U11 sweep)
 *   statusbar-{dark,light}.png     the bottom status bar (U11 sweep)
 *   pipeline-{dark,light}.png      the PIPELINE surface cards (U11 sweep)
 *   rail-rows-403.json             the rail's rows as text — the screenshots'
 *                                  machine-readable twin
 *   dollar-dom.json                every capture's rendered innerText, tested
 *                                  against a currency regex (U11). A reviewer
 *                                  should not have to squint at a PNG to
 *                                  believe "zero dollar figures".
 *
 * ── TWO SERVERS, AND WHY ────────────────────────────────────────────────────
 * CAPTURE_URL (default :7789) is the brief's harness build: `next build` ran
 * with FORGE_CONTROL_URL=http://127.0.0.1:7798, so `/api/proxy/*` is baked to
 * the WORKTREE api (REPRODUCE.md trap 1). Everything except the two header
 * states is captured there.
 *
 * SSE_URL (default :7788) is the SAME .next build started with
 * FORGE_CONTROL_URL=http://127.0.0.1:7700 at RUNTIME. Only one file reads that
 * variable at runtime — app/api/events/[id]/route.ts — so the proxy rewrites
 * still point at :7798 and only the EventSource changes target. This is
 * necessary because serve-v3-7798.ts BUFFERS its pass-through (its own header
 * says so): `GET /api/chat/:id/events` never flushes a header through it, so
 * EventSource can never fire `open` and the header can never say "live" on
 * :7789. Pointing the stream — and only the stream — at the real API is the
 * smallest change that makes the live state reachable at all.
 *
 * Playwright is loaded by ABSOLUTE PATH from an existing global install and
 * chromium is resolved from the shared cache, exactly as
 * scripts/checks/frozen-dom.cjs does: it must never become a dependency of
 * either repo (NFU8).
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     node docs/plan/artifacts/phase400/capture.cjs
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
  if (!candidates.length)
    throw new Error(
      `no chromium binary under ${cache} — found: ${fs.readdirSync(cache).join(", ") || "(empty)"}`,
    );
  return candidates[0];
}

const CAPTURE_URL = process.env.CAPTURE_URL ?? "http://127.0.0.1:7789";
const SSE_URL = process.env.SSE_URL ?? "http://127.0.0.1:7788";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT = __dirname;
/** The one chat in today's rail that resolves to a project, and therefore the
 *  one that renders an `x/y tasks` badge. Synthetic row inserted by phase 300
 *  — see README.md; no real chat is backfillable today and this script does
 *  not write to the database to invent one. */
const LINKED_CHAT_TEXT = process.env.LINKED_CHAT_TEXT ?? "phase300 round-304 linkage fixture";
/** A real operator conversation, used for the two header states. */
const HEADER_CHAT_TEXT =
  process.env.HEADER_CHAT_TEXT ?? "Okay when I click the file section";

/* ── in-page element finders ───────────────────────────────────────────────
 * The app styles inline from app/tokens.ts and carries almost no class names,
 * so surfaces are found by the geometry their own source sets. Each finder
 * throws rather than returning null: a screenshot of the wrong element is a
 * worse artifact than no screenshot. */
const FINDERS = {
  rail: () => {
    const el = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    if (!el) throw new Error("rail (width:300px) not found");
    return el;
  },
  panel: () => {
    const el = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "260px" && d.style.borderLeft,
    );
    if (!el) throw new Error("side panel (width:260px + borderLeft) not found");
    return el;
  },
  statusbar: () => {
    const el = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.height === "28px" && d.style.borderTop,
    );
    if (!el) throw new Error("status bar (height:28px + borderTop) not found");
    return el;
  },
  header: () => {
    const flag = Array.from(document.querySelectorAll("span.mono")).find((s) => {
      const t = s.textContent.trim();
      return t === "live" || t === "polling";
    });
    if (!flag) throw new Error("header live/polling flag not found");
    // span → the dot+flag column → the header row itself.
    const el = flag.parentElement && flag.parentElement.parentElement;
    if (!el) throw new Error("header row not reachable from the live/polling flag");
    return el;
  },
  body: () => document.body,
};

/** Currency regex. `\$\d` and `€` catch a rendered figure; the bare word forms
 *  catch a labelled one ("USD 12"). Deliberately NOT a bare `$`: a chat title
 *  or a shell snippet may legitimately contain one. */
const MONEY_RE = /\$\s*\d|\d\s*\$|€|\bUSD\b|\bEUR\b|\beur\b/;

/**
 * Content that legitimately contains a currency mark.
 *
 * U11 is about figures the UI RENDERS — a cost the app computed and chose to
 * put on screen. A row of DATA whose own title contains a currency symbol is
 * not that, and blanking it would mean the console lying about its content.
 * Same rule as scripts/checks/dollar-allowlist.txt: an entry excuses one exact
 * pattern, so a new, different hit in an already-listed file still fails.
 */
const CONTENT_ALLOW = [
  {
    file: /^pipeline-/,
    pattern: /Best Speakers 2026 below 100\$/,
    reason:
      "pipeline item TITLE, straight from the pipeline table (verified: GET /api/pipeline → phases[].items[].title). User-authored content, not a cost the UI rendered.",
  },
];

async function shoot(page, finderName, file) {
  const handle = await page.evaluateHandle(
    // eslint-disable-next-line no-new-func
    new Function(`return (${FINDERS[finderName].toString()})()`),
  );
  const el = handle.asElement();
  if (!el) throw new Error(`${finderName}: finder returned a non-element`);
  await el.screenshot({ path: path.join(OUT, file) });
  const text = await el.evaluate((n) => n.innerText || "");
  console.log(`  wrote ${file}`);
  return text;
}

const scans = [];
function scan(file, text) {
  const hits = (text.match(new RegExp(MONEY_RE.source, "g")) ?? []).map((m) => {
    const at = text.indexOf(m);
    const context = text.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, " ⏎ ");
    const allow = CONTENT_ALLOW.find((a) => a.file.test(file) && a.pattern.test(context));
    return { match: m, context, allowed: Boolean(allow), reason: allow ? allow.reason : null };
  });
  const unlisted = hits.filter((h) => !h.allowed);
  scans.push({
    file,
    chars: text.length,
    currency_hits: hits.length,
    unlisted_hits: unlisted.length,
    hits,
  });
  for (const h of hits) {
    console.error(
      `  ${h.allowed ? "ALLOW" : "!! FAIL"}  ${file}: ${JSON.stringify(h.context)}`,
    );
  }
  if (unlisted.length) process.exitCode = 1;
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(500);
}

/** Capture one surface in both themes. `prep` runs once, before either shot. */
async function bothThemes(page, prefix, finderName) {
  for (const theme of ["dark", "light"]) {
    await setTheme(page, theme);
    const file = `${prefix}-${theme}.png`;
    scan(file, await shoot(page, finderName, file));
  }
  await setTheme(page, "dark");
}

async function newPage(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: new URL(base).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  [page error]", e.message));
  return page;
}

async function openDesktop(page, base) {
  await page.goto(`${base}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin"))
    throw new Error("redirected to /signin — FORGE_SESSION_COOKIE missing or stale");
  await page.waitForTimeout(2_000);
}

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const executablePath = resolveChromium();
  console.log(`chromium: ${executablePath}`);
  console.log(`capture server: ${CAPTURE_URL}   sse server: ${SSE_URL}\n`);
  const browser = await chromium.launch({ headless: true, executablePath });

  /* ── 1. CHAT: rail, side panel ──────────────────────────────────────────── */
  const page = await newPage(browser, CAPTURE_URL);
  await openDesktop(page, CAPTURE_URL);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);

  const rows = await page.evaluate(() => {
    const rail = Array.from(document.querySelectorAll("div")).find(
      (d) => d.style && d.style.width === "300px",
    );
    const scroller = Array.from(rail.querySelectorAll("div")).find(
      (d) => d.style && d.style.overflowY === "auto",
    );
    return Array.from(scroller.children).map((el) =>
      el.innerText.split("\n").slice(0, 3).join(" | "),
    );
  });
  const withBadge = rows.filter((r) => /\d+\/\d+ tasks/.test(r));
  console.log("rail rows:");
  for (const r of rows) console.log(`  ${r}`);
  console.log(
    `  → ${withBadge.length} row(s) with an x/y badge, ${rows.length - withBadge.length} without`,
  );
  if (withBadge.length === 0 || withBadge.length === rows.length) {
    console.error("FAIL: the rail must show BOTH a badged row and an unbadged one");
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(OUT, "rail-rows-403.json"),
    `${JSON.stringify({ rows, with_badge: withBadge.length, without_badge: rows.length - withBadge.length }, null, 2)}\n`,
  );

  console.log("\nrail (both themes)");
  await bothThemes(page, "rail", "rail");

  console.log("\nstatus bar (both themes)");
  await bothThemes(page, "statusbar", "statusbar");

  // Open the linked chat: the Live tab of its SidePanel is then scoped to that
  // chat's project — no manager selector exists any more (U9).
  await page.getByText(LINKED_CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(6_000);
  const panelRows = await page.evaluate(
    () => document.querySelectorAll("div[data-agent-kind]").length,
  );
  console.log(`\nside panel Live tab — ${panelRows} agent row(s) on screen`);
  if (panelRows === 0) {
    console.error("FAIL: the scoped panel rendered no agent rows — nothing to show");
    process.exitCode = 1;
  }
  await bothThemes(page, "panel-live", "panel");

  /* ── 2. LIVE destination ────────────────────────────────────────────────── */
  await page.getByText("LIVE", { exact: true }).first().click();
  await page.waitForSelector("div[data-agent-kind]", { timeout: 30_000 });
  await page.waitForTimeout(2_500);
  console.log("\nLIVE destination (both themes)");
  await bothThemes(page, "livedest", "body");

  /* ── 3. PIPELINE surface ────────────────────────────────────────────────── */
  await page.getByText("PIPELINE", { exact: true }).first().click();
  await page.waitForTimeout(4_000);
  console.log("\nPIPELINE surface (both themes)");
  await bothThemes(page, "pipeline", "body");
  await page.context().close();

  /* ── 4. header: live, then polling ──────────────────────────────────────── */
  for (const mode of ["live", "polling"]) {
    const hp = await newPage(browser, SSE_URL);
    if (mode === "polling") {
      // Forced by aborting the EventSource request. useRunEvents never sees
      // `open`, so `live` stays false and the query falls back to its 3s poll.
      await hp.route("**/api/events/**", (route) => route.abort());
    }
    await openDesktop(hp, SSE_URL);
    await hp.getByText("CHAT", { exact: true }).first().click();
    await hp.waitForTimeout(3_000);
    await hp.getByText(HEADER_CHAT_TEXT, { exact: false }).first().click();
    await hp.waitForTimeout(1_500);
    try {
      await hp.waitForFunction(
        (want) =>
          Array.from(document.querySelectorAll("span.mono")).some(
            (s) => s.textContent.trim() === want,
          ),
        mode,
        { timeout: 30_000 },
      );
    } catch {
      console.error(`FAIL: header never reached the "${mode}" state on ${SSE_URL}`);
      process.exitCode = 1;
    }
    console.log(`\nheader — ${mode} (both themes)`);
    await bothThemes(hp, `header-${mode}`, "header");
    await hp.context().close();
  }

  fs.writeFileSync(
    path.join(OUT, "dollar-dom.json"),
    `${JSON.stringify(
      {
        regex: MONEY_RE.source,
        note: "innerText of exactly the elements screenshotted, same page state",
        total_hits: scans.reduce((n, s) => n + s.currency_hits, 0),
        unlisted_hits: scans.reduce((n, s) => n + s.unlisted_hits, 0),
        content_allowlist: CONTENT_ALLOW.map((a) => ({
          file: a.file.source,
          pattern: a.pattern.source,
          reason: a.reason,
        })),
        captures: scans,
      },
      null,
      2,
    )}\n`,
  );

  await browser.close();
  const money = scans.reduce((n, s) => n + s.currency_hits, 0);
  const unlisted = scans.reduce((n, s) => n + s.unlisted_hits, 0);
  console.log(
    `\ncurrency-shaped hits across ${scans.length} captures: ${money} (${unlisted} unlisted)`,
  );
  console.log(process.exitCode ? "capture: FAIL" : "capture: PASS");
})().catch((err) => {
  console.error("capture threw:", err);
  process.exit(1);
});
