/**
 * frozen-dom.cjs — end-to-end proof that settled durations do not tick (R4, R5).
 *
 * The unit check (check-duration.ts) proves the helpers are frozen. This
 * proves the rendered panel is: it samples the real duration cells in a real
 * browser three times across >=12 seconds — spanning at least three of the
 * Live panel's 4s poll cycles and a dozen of its 1s clock ticks — and fails
 * if any settled cell's text changed by so much as a character.
 *
 * Playwright is NOT a dependency of either repo and must not become one
 * (NF4), so it is loaded by absolute path from an existing global install.
 *
 * Selectors: the duration cell carries a `title` attribute set by
 * AgentActivity.tsx — "running for this long" for live rows, "total run
 * time" / "total subagent run time" for finished ones. That is the render's
 * own statement about which clock a cell is on, which makes it exactly the
 * right thing to assert against.
 *
 * Auth: /desktop sits behind GitHub OAuth (middleware.ts). Rather than
 * weaken the middleware for a screenshot, the caller mints a valid next-auth
 * session cookie with AUTH_SECRET and passes it in FORGE_SESSION_COOKIE.
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     node scripts/checks/frozen-dom.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

/**
 * That global playwright (1.60.0) wants browser build 1223; the shared
 * /root/.cache/ms-playwright only has 1234, downloaded by a newer install.
 * Rather than run `playwright install` (writes to a shared cache other
 * agents use) we point at the build that IS there. One minor build apart on
 * a stable CDP surface — verified working below by the check itself, which
 * screenshots and reads the DOM. Throws with the actual directory listing if
 * nothing usable is present, rather than failing later inside launch().
 */
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

const BASE = process.env.FROZEN_DOM_URL ?? "http://127.0.0.1:7799";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const OUT_DIR = path.resolve(__dirname, "../../docs/plan/artifacts/phase1");
const SAMPLES = 3;
const GAP_MS = 6_000; // 3 samples x 6s = 12s of wall clock, >= 3 poll cycles

/** Runs in the page. Returns one entry per duration cell, tagged with the
 *  section it lives in (ACTIVE vs RECENT) and the row it belongs to. */
const COLLECT = () => {
  const cells = Array.from(
    document.querySelectorAll(
      'span[title="total run time"], span[title="total subagent run time"], span[title="running for this long"]',
    ),
  );
  const recentHeader = Array.from(document.querySelectorAll("div")).find(
    (d) => d.childElementCount === 0 && d.textContent.trim() === "RECENT",
  );
  return cells.map((cell, i) => {
    const row = cell.parentElement;
    const titled = row
      ? Array.from(row.querySelectorAll("span[title]")).filter(
          (s) => !s.getAttribute("title").includes("time") && !s.getAttribute("title").includes("tokens"),
        )
      : [];
    const inRecent =
      !!recentHeader &&
      !!(recentHeader.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING);
    const t = cell.getAttribute("title");
    return {
      index: i,
      section: inRecent ? "RECENT" : "ACTIVE",
      kind:
        t === "total subagent run time"
          ? "subagent-done"
          : t === "total run time"
            ? "run-settled"
            : "run-live",
      label: (titled[titled.length - 1]?.textContent ?? "").trim().slice(0, 46),
      text: cell.textContent.trim(),
    };
  });
};

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exitCode = 1;
}

(async () => {
  const executablePath = resolveChromium();
  console.log(`chromium: ${executablePath}\n`);
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (COOKIE) {
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
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("  [page error]", e.message));

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle" });
  if (page.url().includes("/signin")) {
    fail(`redirected to /signin — FORGE_SESSION_COOKIE missing or stale`);
    await browser.close();
    return;
  }

  // /desktop opens on TODAY; AgentActivity is mounted on the LIVE
  // destination (DesktopApp.tsx:1994). Click through to it.
  await page.getByText("LIVE", { exact: true }).first().click();

  // Wait for the Live panel to actually populate, then let it settle so the
  // first sample is not caught mid-fetch.
  await page.waitForSelector('span[title="total run time"]', { timeout: 30_000 });
  console.log("Live panel populated. Settling 5s before first sample…\n");
  await page.waitForTimeout(5_000);

  const rounds = [];
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await page.waitForTimeout(GAP_MS);
    const snap = await page.evaluate(COLLECT);
    rounds.push(snap);
    console.log(`sample ${i + 1} @ t+${i * (GAP_MS / 1000)}s — ${snap.length} duration cells`);
  }

  // ── Assertions ─────────────────────────────────────────────────────────
  const first = rounds[0];
  const settledActive = first.filter((c) => c.kind === "run-settled" && c.section === "ACTIVE");
  const settledRecent = first.filter((c) => c.kind === "run-settled" && c.section === "RECENT");
  const doneSubs = first.filter((c) => c.kind === "subagent-done");
  const liveRuns = first.filter((c) => c.kind === "run-live");

  console.log(
    `\nfound: ${settledActive.length} settled-in-ACTIVE, ${settledRecent.length} settled-in-RECENT, ` +
      `${doneSubs.length} done sub-agents, ${liveRuns.length} live runs`,
  );

  if (!settledRecent.length && !settledActive.length)
    fail("no settled top-level row on screen — cannot prove R4");
  if (!doneSubs.length) fail("no done sub-agent line on screen — cannot prove R5");

  // Frozen cells: same index must hold the same text in every sample.
  const frozenKinds = new Set(["run-settled", "subagent-done"]);
  let drift = 0;
  for (const cell of first) {
    if (!frozenKinds.has(cell.kind)) continue;
    const series = rounds.map((r) => r[cell.index]?.text ?? "<gone>");
    const constant = series.every((t) => t === series[0]);
    if (!constant) drift++;
    console.log(
      `  ${constant ? "PASS" : "FAIL"}  [${cell.section}] ${cell.kind.padEnd(14)} ` +
        `${cell.label.padEnd(46)} ${series.join("  |  ")}`,
    );
  }
  if (drift) fail(`${drift} settled duration cell(s) changed across ${SAMPLES} samples`);

  // Sanity counter-check: if nothing on the page moves at all, the samples
  // could be constant because the page is dead rather than because the fix
  // works. A live run's duration must advance.
  if (liveRuns.length) {
    const moved = liveRuns.some((c) => {
      const series = rounds.map((r) => r[c.index]?.text ?? "<gone>");
      return series.some((t) => t !== series[0]);
    });
    console.log(
      `\n  ${moved ? "PASS" : "FAIL"}  counter-check: at least one LIVE run duration advanced ` +
        `(proves the panel is ticking, so the frozen cells are frozen by the fix)`,
    );
    liveRuns.forEach((c) =>
      console.log(
        `        live  ${c.label.padEnd(46)} ${rounds.map((r) => r[c.index]?.text ?? "<gone>").join("  |  ")}`,
      ),
    );
    if (!moved) fail("no live duration advanced — the panel may be frozen for the wrong reason");
  } else {
    console.log("\n  NOTE: no live run on screen — counter-check skipped.");
  }

  // ── Screenshots, both themes ───────────────────────────────────────────
  // The panel is a 380px scroller; a done sub-agent line is often below the
  // fold. Scroll one into view so the artifact shows what it claims to.
  const scrolled = await page.evaluate(() => {
    const cell = document.querySelector('span[title="total subagent run time"]');
    if (!cell) return false;
    cell.scrollIntoView({ block: "center" });
    return true;
  });
  console.log(
    scrolled
      ? "scrolled a done sub-agent line into frame for the screenshots"
      : "WARNING: no done sub-agent line to scroll into frame",
  );
  await page.waitForTimeout(400);

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(600);
    const file = path.join(OUT_DIR, `live-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(`screenshot: ${file}`);
  }

  await browser.close();
  console.log(
    process.exitCode ? "\nfrozen-dom: FAIL" : "\nfrozen-dom: PASS — no settled duration moved",
  );
})().catch((err) => {
  console.error("frozen-dom threw:", err);
  process.exit(1);
});
