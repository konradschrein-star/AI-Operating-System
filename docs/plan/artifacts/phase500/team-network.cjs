/**
 * team-network.cjs — NFU3, protocol 14 §"Poll budget".
 *
 * Clone of phase400/network-watch.cjs. Records every `/api/proxy/*` request
 * for TEAM_WATCH_SECONDS (default 75s) with a project chat open and the Team
 * panel visible, then repeats the same window with the panel COLLAPSED.
 *
 * "Collapsed" uses the SidePanel chrome that already exists in ChatSurface.tsx
 * (`button[title="Collapse"]` to collapse, `button[title="Show live projects
 * panel"]` to re-expand — verified against the current build 2026-08-05,
 * ChatSurface.tsx:266-358). The Team panel replaces that panel's "Live" tab
 * body; nothing in the DOM contract handed to this round names a Team-specific
 * collapse control, so this script relies on the pre-existing chrome around
 * it. If round 502 changes those title attributes, override with
 * TEAM_COLLAPSE_TITLE / TEAM_EXPAND_TITLE.
 *
 * The comparison baseline is already recorded:
 * docs/plan/artifacts/phase400/managers-network-after.json — total 52 req/min
 * (SSE aborted, matching this script's default ABORT_SSE=1 posture). This
 * script loads that file, diffs per_minute automatically, and prints a table.
 *
 * FAIL if:
 *   - total per_minute (panel visible) > 52
 *   - /chat/:id/team per_minute (panel visible) > 12
 *   - any /chat/:id/team request observed while the panel is COLLAPSED
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     TEAM_WATCH_LABEL=after node docs/plan/artifacts/phase500/team-network.cjs
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

const BASE = process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7789";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const SECONDS = Number(process.env.TEAM_WATCH_SECONDS ?? "75");
// Default: c0de0304, the phase300 fixture — real project link, small tree.
const CHAT_TEXT = process.env.TEAM_CHAT_TEXT ?? "phase300 round-304 linkage fixture";
const LABEL = process.env.TEAM_WATCH_LABEL ?? "after";
const ABORT_SSE = process.env.ABORT_SSE !== "0"; // default ON — matches the 52 req/min baseline file
const COLLAPSE_TITLE = process.env.TEAM_COLLAPSE_TITLE ?? "Collapse";
const EXPAND_TITLE = process.env.TEAM_EXPAND_TITLE ?? "Show live projects panel";
const OUT = __dirname;
const BASELINE_FILE = path.resolve(OUT, "../phase400/managers-network-after.json");
const TOTAL_PER_MIN_CAP = 52;
const TEAM_PER_MIN_CAP = 12;

function endpointOf(pathWithQuery) {
  return pathWithQuery
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

function summarize(requests, elapsedMs) {
  const counts = {};
  for (const r of requests) counts[r.endpoint] = (counts[r.endpoint] ?? 0) + 1;
  const perMinute = {};
  for (const [k, v] of Object.entries(counts)) perMinute[k] = +(v / (elapsedMs / 60_000)).toFixed(2);
  return {
    total_requests: requests.length,
    total_per_minute: +(requests.length / (elapsedMs / 60_000)).toFixed(2),
    counts,
    per_minute: perMinute,
  };
}

async function watchWindow(page, requests, seconds, label) {
  console.log(`watching ${BASE} for ${seconds}s (${label}) …`);
  const startIdx = requests.length;
  const t0 = Date.now();
  await page.waitForTimeout(seconds * 1_000);
  const elapsedMs = Date.now() - t0;
  const window = requests.slice(startIdx);
  return { window, elapsedMs, summary: summarize(window, elapsedMs) };
}

async function main() {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
  let visible, collapsed;
  try {
    ({ visible, collapsed } = await run(browser));
  } finally {
    await browser.close();
  }
  report(visible, collapsed);
}

async function run(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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
  const page = await ctx.newPage();
  if (ABORT_SSE) await page.route("**/api/events/**", (route) => route.abort());

  const requests = [];
  const t0 = Date.now();
  page.on("request", (r) => {
    const url = r.url();
    if (!url.includes("/api/proxy/")) return;
    const rest = url.split("/api/proxy")[1];
    requests.push({ ms: Date.now() - t0, method: r.method(), url: rest, endpoint: endpointOf(rest) });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.getByText(CHAT_TEXT, { exact: false }).first().click();
  await page.waitForTimeout(5_000);

  const panelPresent = await page
    .waitForSelector("[data-team-panel]", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!panelPresent)
    throw new Error(
      `no [data-team-panel] found in the DOM within 15000ms at ${BASE} (chat "${CHAT_TEXT}") — ` +
        `the Team panel does not exist yet, or the chat text did not match a rail row`,
    );

  // ── window 1: panel visible ──────────────────────────────────────────────
  const visible = await watchWindow(page, requests, SECONDS, "panel visible");

  // ── collapse the panel ───────────────────────────────────────────────────
  const collapseBtn = page.getByTitle(COLLAPSE_TITLE).first();
  const collapseVisible = await collapseBtn.isVisible().catch(() => false);
  if (!collapseVisible)
    throw new Error(
      `no button[title="${COLLAPSE_TITLE}"] found — cannot collapse the panel for the second window. ` +
        `Override TEAM_COLLAPSE_TITLE if the panel's collapse control changed.`,
    );
  await collapseBtn.click();
  await page.waitForTimeout(1_000);
  const stillExpanded = await page.locator("[data-team-panel]").isVisible().catch(() => false);
  if (stillExpanded)
    throw new Error(`clicked button[title="${COLLAPSE_TITLE}"] but [data-team-panel] is still visible`);

  // ── window 2: panel collapsed ────────────────────────────────────────────
  const collapsed = await watchWindow(page, requests, SECONDS, "panel collapsed");

  return { visible, collapsed };
}

function report(visible, collapsed) {
  // ── baseline diff ────────────────────────────────────────────────────────
  let baseline = null;
  let baselineError = null;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch (e) {
    baselineError = e.message;
  }

  const failures = [];
  if (visible.summary.total_per_minute > TOTAL_PER_MIN_CAP)
    failures.push(
      `total_per_minute (panel visible) = ${visible.summary.total_per_minute} > cap ${TOTAL_PER_MIN_CAP}`,
    );
  const teamPerMin = visible.summary.per_minute["/chat/:id/team"] ?? 0;
  if (teamPerMin > TEAM_PER_MIN_CAP)
    failures.push(`/chat/:id/team per_minute (panel visible) = ${teamPerMin} > cap ${TEAM_PER_MIN_CAP}`);
  const teamWhileCollapsed = collapsed.window.filter((r) => r.endpoint === "/chat/:id/team");
  if (teamWhileCollapsed.length)
    failures.push(
      `${teamWhileCollapsed.length} /chat/:id/team request(s) observed while the panel was COLLAPSED`,
    );

  console.log("\n── per-path delta vs docs/plan/artifacts/phase400/managers-network-after.json ──");
  if (baselineError) {
    console.log(`  (no diff: could not load baseline — ${baselineError})`);
  } else {
    const allPaths = new Set([
      ...Object.keys(baseline.per_minute ?? {}),
      ...Object.keys(visible.summary.per_minute),
    ]);
    console.log(
      `  ${"path".padEnd(28)} ${"baseline/min".padStart(13)} ${"visible/min".padStart(13)} ${"delta".padStart(8)}`,
    );
    for (const p of [...allPaths].sort()) {
      const b = baseline.per_minute?.[p] ?? 0;
      const v = visible.summary.per_minute[p] ?? 0;
      console.log(`  ${p.padEnd(28)} ${b.toFixed(2).padStart(13)} ${v.toFixed(2).padStart(13)} ${(v - b).toFixed(2).padStart(8)}`);
    }
    console.log(
      `  ${"TOTAL".padEnd(28)} ${(baseline.total_per_minute ?? 0).toFixed(2).padStart(13)} ${visible.summary.total_per_minute.toFixed(2).padStart(13)} ${(visible.summary.total_per_minute - (baseline.total_per_minute ?? 0)).toFixed(2).padStart(8)}`,
    );
  }

  const result = {
    label: LABEL,
    base: BASE,
    chat: CHAT_TEXT,
    sse: ABORT_SSE ? "aborted" : "live",
    caps: { total_per_minute: TOTAL_PER_MIN_CAP, team_per_minute: TEAM_PER_MIN_CAP },
    baseline_file: BASELINE_FILE,
    baseline_error: baselineError,
    panel_visible: { window_ms: visible.elapsedMs, ...visible.summary },
    panel_collapsed: { window_ms: collapsed.elapsedMs, ...collapsed.summary },
    team_requests_while_collapsed: teamWhileCollapsed.length,
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
    raw_visible: visible.window,
    raw_collapsed: collapsed.window,
  };
  const out = path.join(OUT, `team-network-${LABEL}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n→ ${out}`);
  failures.forEach((f) => console.log(`  FAIL: ${f}`));
  console.log(`TEAM-NETWORK: ${result.verdict}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exitCode = 1;
});
