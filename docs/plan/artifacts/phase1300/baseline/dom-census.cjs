/**
 * dom-census.cjs — round 1301, deliverable B3 (and the render census, B4).
 *
 * WHAT IT COUNTS, on `/desktop` with the manager chat open and the Team tab
 * visible:
 *
 *   * `document.getElementsByTagName("*").length` — the whole document. This is
 *     the number `phase800/canvas-perf.md` §9.7 cited as 4,716 elements; it is
 *     re-read here rather than quoted, because `/desktop` is a live chat and
 *     its element count drifts between page loads (the invalidation probe
 *     recorded 5,859 → 5,943 across its own runs).
 *   * `[data-team-row]` count, and the elements inside those rows — so "mean
 *     elements per row" is a measured quotient, not a guess.
 *   * how many rows are inside the `[data-team-scroll]` viewport: a row counts
 *     as visible when its box intersects the scroller's box at all, and
 *     "fully visible" when it is contained by it. Both are reported, because
 *     the difference is exactly the two partially-clipped rows at the edges
 *     and a reader should not have to guess which convention produced 21.
 *
 * RENDER CENSUS (B4). With `CENSUS_RENDER=1` the script additionally waits
 * `CENSUS_RENDER_MS` (default 25 s ≈ four 6.29 s poll periods) and reads back
 * the counters that an INSTRUMENTED build exposes on `window.__teamRenderCensus`.
 * That instrumentation lives ONLY in the /tmp build copy — never in the
 * worktree's application files — and the diff that produced it is pasted in
 * this round's README. If the build is not instrumented the script says so and
 * exits non-zero rather than reporting a silent zero.
 *
 * Output goes to `$CENSUS_OUT` (default `/tmp/phase1301-out`), never into
 * `docs/plan/` unless `--commit-artifact` is passed — same rule round 1301 put
 * on `hover-1291.cjs`, for the same reason.
 *
 *   export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1301.txt)"
 *   CENSUS_BASE_URL=http://127.0.0.1:7831 \
 *     node docs/plan/artifacts/phase1300/baseline/dom-census.cjs
 *
 * NFU8: playwright by absolute path from /opt/hermes-workspace, chromium out of
 * /root/.cache/ms-playwright. Neither repo gains a dependency.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p))[0];
  if (!found) throw new Error(`no chromium under ${cache} — playwright browsers not installed`);
  return found;
}

const BASE = (process.env.CENSUS_BASE_URL ?? "http://127.0.0.1:7831").trim();
const COOKIE = (process.env.FORGE_SESSION_COOKIE ?? "").trim();
const CHAT_TEXT = "Okay when I click the file section";
const LABEL = (process.env.CENSUS_LABEL ?? "dom").trim();
const RENDER = process.env.CENSUS_RENDER === "1";
const RENDER_MS = Number(process.env.CENSUS_RENDER_MS ?? 25_000);

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const COMMIT_ARTIFACT = process.argv.includes("--commit-artifact");
const CENSUS_OUT = (process.env.CENSUS_OUT ?? "").trim();
const OUT = path.resolve(CENSUS_OUT || (COMMIT_ARTIFACT ? __dirname : "/tmp/phase1301-out"));
if (!COMMIT_ARTIFACT && CENSUS_OUT === "" && (OUT === REPO_ROOT || OUT.startsWith(REPO_ROOT + path.sep))) {
  throw new Error(
    `dom-census.cjs refuses to write inside the repo without an explicit opt-in.\n` +
      `  resolved output dir: ${OUT}\n  pass --commit-artifact, or set CENSUS_OUT=<dir>.`,
  );
}
fs.mkdirSync(OUT, { recursive: true });

if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty — mint it per the round-1301 README");
if (BASE.includes("os.schreinercontentsystems.com")) {
  throw new Error("round 1301 is a build task: production URLs are out of bounds");
}

const osSample = () => ({
  loadavg: os.loadavg(),
  nproc: os.cpus().length,
  procUptime: Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]),
  wallClock: new Date().toISOString(),
});

/** Counted in the page. Kept in one function so the census is one evaluate and
 *  cannot drift between the numbers it reports. */
const CENSUS = () => {
  const doc = document.getElementsByTagName("*").length;
  const rows = [...document.querySelectorAll("[data-team-row]")];
  const scroll = document.querySelector("[data-team-scroll]");
  const sb = scroll ? scroll.getBoundingClientRect() : null;

  let rowElements = 0;
  const perRow = [];
  let intersecting = 0;
  let contained = 0;
  // Round 1291's sweep-target filter, reproduced verbatim so this round's
  // "rows on screen" can be compared to the 21 that README §5 reports. It
  // clips against the WINDOW, not against the scroller — a row can satisfy it
  // and still be hidden behind `overflow: auto`. The difference is the point.
  let byRound1291Filter = 0;
  for (const r of rows) {
    const n = r.getElementsByTagName("*").length + 1; // the row element itself
    rowElements += n;
    perRow.push(n);
    const b = r.getBoundingClientRect();
    if (sb && b.bottom > sb.top && b.top < sb.bottom) intersecting += 1;
    if (sb && b.top >= sb.top && b.bottom <= sb.bottom) contained += 1;
    if (b.top >= 0 && b.bottom <= window.innerHeight && b.height > 8) byRound1291Filter += 1;
  }
  perRow.sort((a, b) => a - b);

  return {
    documentElements: doc,
    teamRows: rows.length,
    elementsInsideTeamRows: rowElements,
    meanElementsPerRow: rows.length ? Math.round((rowElements / rows.length) * 100) / 100 : null,
    minElementsPerRow: perRow[0] ?? null,
    medianElementsPerRow: perRow.length ? perRow[Math.floor(perRow.length / 2)] : null,
    maxElementsPerRow: perRow[perRow.length - 1] ?? null,
    teamRowsShareOfDocumentPct: doc ? Math.round((rowElements / doc) * 10000) / 100 : null,
    scroller: sb
      ? {
          found: true,
          heightPx: Math.round(sb.height),
          rowsIntersectingViewport: intersecting,
          rowsFullyInsideViewport: contained,
          scrollHeightPx: scroll.scrollHeight,
        }
      : { found: false },
    rowsPassingRound1291WindowFilter: byRound1291Filter,
    rowHeightPx: rows.length ? Math.round(rows[0].getBoundingClientRect().height * 10) / 10 : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // Cross-checks against the payload, so a reader can see the DOM and the
    // endpoint agreeing (or not) without a second tool.
    teamRowKinds: rows.reduce((acc, r) => {
      const k = r.getAttribute("data-team-kind") ?? r.getAttribute("data-kind") ?? "?";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  };
};

(async () => {
  const report = {
    label: LABEL,
    base: BASE,
    startedAt: new Date().toISOString(),
    buildSha: (process.env.CENSUS_BUILD_SHA ?? "").trim() || null,
    uptime: (process.env.CENSUS_UPTIME ?? "").trim() || null,
    osBefore: osSample(),
    errors: [],
  };

  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const url = new URL(BASE);
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => report.errors.push(String(e).slice(0, 300)));

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(4_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(8_000); // let at least one team poll land

  report.census = await page.evaluate(CENSUS);

  if (RENDER) {
    const armed = await page.evaluate(() => Boolean(window.__teamRenderCensus));
    if (!armed) {
      report.errors.push(
        "window.__teamRenderCensus is absent — this build is NOT instrumented; " +
          "apply the /tmp patch in the round-1301 README before running with CENSUS_RENDER=1",
      );
      report.render = { instrumented: false };
    } else {
      await page.evaluate(() => window.__teamRenderCensus.reset());
      const t0 = Date.now();
      await page.waitForTimeout(RENDER_MS);
      report.render = await page.evaluate(() => window.__teamRenderCensus.read());
      report.render.instrumented = true;
      report.render.observedMs = Date.now() - t0;
      report.render.pointerMoved = false;
    }
  }

  report.osAfter = osSample();
  report.finishedAt = new Date().toISOString();

  const outPath = path.join(OUT, "dom-census.json");
  let doc = { schema: "dom-census/1301", runs: {} };
  if (fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (prev && typeof prev === "object" && prev.runs) doc = prev;
  }
  doc.runs[LABEL] = report;
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));

  console.log(JSON.stringify(report.census, null, 2));
  if (report.render) console.log("render:", JSON.stringify(report.render, null, 2));
  console.log(`errors: ${report.errors.length}`);
  for (const e of report.errors) console.log("  ! " + e);
  console.log(`wrote ${LABEL} → ${outPath}`);
  await browser.close();
  if (report.errors.length) process.exitCode = 1;
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
