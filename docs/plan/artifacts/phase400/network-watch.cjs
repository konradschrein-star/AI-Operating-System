/**
 * network-watch.cjs — the poll-budget proof (U9 / NFU3).
 *
 * Opens a project chat with the Live panel visible and records EVERY
 * `/api/proxy/*` request the page makes for WATCH_SECONDS (default 75s, so a
 * full 60s window is measured after the page has settled). Writes the raw
 * capture — one entry per request, with a millisecond offset — plus per-path
 * counts and a requests/minute rate.
 *
 * Two claims must be readable straight off the output:
 *   (a) ZERO requests to /api/projects/managers (U9 — ManagersSection is gone);
 *   (b) the total requests/minute is <= the pre-phase baseline (NFU3).
 *
 * (b) is not arithmetic here: run this script a second time against a build of
 * the PRE-phase code with WATCH_LABEL=baseline, and compare the two files. The
 * pre-phase build used for the round-403 evidence is /tmp/hover-before — a
 * read-only copy of the live checkout's `.next` (the live checkout itself is
 * never started, edited or rebuilt), whose proxy target is baked to production
 * :7700. Only request PATHS and RATES are compared, never payloads, so the
 * different backend does not affect the claim.
 *
 * Playwright by absolute path from the global install; chromium from the shared
 * cache. Never a dependency of either repo (NFU8).
 *
 * Run:
 *   set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     WATCH_URL=http://127.0.0.1:7789 WATCH_LABEL=after \
 *     node docs/plan/artifacts/phase400/network-watch.cjs
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

const BASE = process.env.WATCH_URL ?? "http://127.0.0.1:7789";
const LABEL = process.env.WATCH_LABEL ?? "after";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
const SECONDS = Number(process.env.WATCH_SECONDS ?? "75");
const CHAT_TEXT = process.env.WATCH_CHAT_TEXT ?? "phase300 round-304 linkage fixture";
const OUT = __dirname;
/**
 * ABORT_SSE=1 kills the EventSource, which forces `["chat","run",id]` onto its
 * 3s fallback instead of the 20s live interval.
 *
 * This flag exists because the two intervals differ by 17.6 requests/minute —
 * far more than anything phase 400 changed — so a run with a live stream and a
 * run without it are not comparable, in either direction. Every NFU3 comparison
 * must hold this flag constant across both builds.
 */
const ABORT_SSE = process.env.ABORT_SSE === "1";

/** Collapse a proxied URL to a stable endpoint shape: uuids → :id, query
 *  dropped, so `/agents?project_id=…&limit=60` and `/chat/<uuid>` group. */
function endpointOf(pathWithQuery) {
  return pathWithQuery
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromium() });
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
  // ONE time origin for every `ms` in the raw capture — the page load. The
  // measurement window is marked by an index and a timestamp instead of by
  // restarting the clock, so a reviewer reading `raw` sees a single monotonic
  // timeline rather than two overlapping ones.
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
  // Let the chat settle (its one-off requests fire here) before the clock starts.
  await page.waitForTimeout(5_000);

  const openMark = requests.length;
  const windowStart = Date.now();
  console.log(`watching ${BASE} for ${SECONDS}s with "${CHAT_TEXT}" open …`);
  await page.waitForTimeout(SECONDS * 1_000);
  const elapsedMs = Date.now() - windowStart;

  const window = requests.slice(openMark);
  const counts = {};
  for (const r of window) counts[r.endpoint] = (counts[r.endpoint] ?? 0) + 1;
  const perMinute = {};
  for (const [k, v] of Object.entries(counts)) perMinute[k] = +(v / (elapsedMs / 60_000)).toFixed(2);

  const result = {
    label: LABEL,
    base: BASE,
    chat: CHAT_TEXT,
    sse: ABORT_SSE ? "aborted (detail query on its 3s fallback)" : "live (detail query at 20s)",
    window_ms: elapsedMs,
    window_starts_at_ms: windowStart - t0,
    window_starts_at_raw_index: openMark,
    total_requests_in_window: window.length,
    total_per_minute: +(window.length / (elapsedMs / 60_000)).toFixed(2),
    counts,
    per_minute: perMinute,
    managers_requests: window.filter((r) => r.endpoint.includes("managers")).length,
    managers_requests_including_startup: requests.filter((r) =>
      r.endpoint.includes("managers"),
    ).length,
    // Everything before the clock started: page load + opening the chat. This
    // is where a once-per-chat call such as /chat/:id/linkage must appear.
    before_window: requests.slice(0, openMark).reduce((acc, r) => {
      acc[r.endpoint] = (acc[r.endpoint] ?? 0) + 1;
      return acc;
    }, {}),
    raw: requests,
  };

  const file = path.join(OUT, `managers-network-${LABEL}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({ ...result, raw: `${requests.length} entries → ${file}` }, null, 2),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
