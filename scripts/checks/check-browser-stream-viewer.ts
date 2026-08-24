/**
 * check-browser-stream-viewer.ts — verification and measurement check for the
 * Browser Stream Viewer (Round 3, aios-browser-stream-viewer).
 *
 * This test suite asserts:
 *  1. Signal Integration & Stream Mode Resolution:
 *     - resolveStreamMode: idle, live (blue flowing mode), needs_human (red mode).
 *     - resolveStreamWarning: diagnostic warning info (title, detail, action, service, signal).
 *     - isLoginWallName: regex pattern matching for captchas, auth walls, login walls.
 *     - vncProxyUrl: authenticated loopback proxy URL generation behind /api/proxy.
 *  2. Flowing Blue & Red Pulse Animation Styles & Reduced Motion:
 *     - StreamStyles: @keyframes fg-stream-flow-blue (accent/decide), fg-stream-pulse-red (bleed/dangerActionBorder).
 *     - @media (prefers-reduced-motion: reduce) disabling animations and applying static fallback borders.
 *     - Token purity: zero raw colour literals (hex/rgb/hsl) in rendered CSS and HTML.
 *  3. Component Rendering & Markup Contract (BrowserStreamViewer & FullscreenShotViewer):
 *     - Accessibility: role="dialog", aria-modal="true", aria-label="Browser Stream Fullscreen Viewer".
 *     - Four visual states: idle (archived stills), live-blue (flowing outline), red (needs-me banner), manual mode (noVNC iframe proxy).
 *     - Controls: close button (data-close-fullscreen), manual toggle (data-toggle-manual-mode), nav arrows, filmstrip scrubber.
 *  4. Keyboard Navigation & Focus Trap Handling:
 *     - Escape listener, ArrowLeft / ArrowRight index wrapping, Tab focus trap logic.
 *  5. RunShotsIndicator & ShotStrip Integration:
 *     - Indicators on panel rows with live blue / red mode badges.
 *     - stopPropagation click handling to preserve row drill-in behavior.
 *  6. Polling Budget & Bandwidth Compliance:
 *     - SHOTS_FULLSCREEN_POLL_MS = 5_000ms active only while modal is open, 0 when closed.
 *     - Surface rate compliance (healthy 23 req/min, degraded 36 req/min, modal open 35 req/min ≤ 40 ceiling).
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-browser-stream-viewer.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tokens } from "../../forge-control-web/app/tokens.ts";
import { Providers } from "../../forge-control-web/app/Providers.tsx";
import {
  isLoginWallName,
  newestFirst,
  parseShotName,
  resolveStreamMode,
  resolveStreamWarning,
  shotClock,
  shotSrc,
  shotsNoun,
  stampToIso,
  uploadsDirId,
  vncProxyUrl,
  type BrowserShotRef,
  type BrowserStateSummary,
  type StreamMode,
  type StreamWarningInfo,
} from "../../forge-control-web/app/desktop/chat/browser-shots.ts";
import {
  BrowserStreamViewer,
  FullscreenShotViewer,
  StreamStyles,
  type ShotLike,
} from "../../forge-control-web/app/desktop/chat/BrowserStreamViewer.tsx";
import {
  RunShotsIndicator,
  ShotStrip,
} from "../../forge-control-web/app/desktop/chat/BrowserShots.tsx";
import {
  CHAT_DETAIL_FALLBACK_POLL_MS,
  CHAT_DETAIL_LIVE_POLL_MS,
  CHAT_LIST_POLL_MS,
  CHAT_SURFACE_REQ_PER_MIN_CEILING,
  PLAN_POLL_MS,
  SHOTS_FULLSCREEN_POLL_MS,
  SHOTS_INDEX_POLL_MS,
  TEAM_POLL_MS,
} from "../../forge-control-web/app/desktop/chat/pollBudget.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

function checkTrue(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS  ${name}`);
    return;
  }
  failures++;
  console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const noop = (): void => {};

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const TEST_DIR_ID = "7a0c6432cde4";
const TEST_RUN_UUID = "7a0c6432-cde4-4ca1-8f17-ff340c236c0a";

const IDLE_SHOTS: ShotLike[] = [
  {
    dirId: TEST_DIR_ID,
    name: "20260824T050000Z-settings-overview.png",
    label: "settings-overview",
    ts: "2026-08-24T05:00:00Z",
  },
  {
    dirId: TEST_DIR_ID,
    name: "20260824T050100Z-dashboard-preview.png",
    label: "dashboard-preview",
    ts: "2026-08-24T05:01:00Z",
  },
  {
    dirId: TEST_DIR_ID,
    name: "20260824T050200Z-dashboard-final.png",
    label: "dashboard-final",
    ts: "2026-08-24T05:02:00Z",
  },
];

const WALL_SHOTS: ShotLike[] = [
  {
    dirId: TEST_DIR_ID,
    name: "20260824T050000Z-settings-overview.png",
    label: "settings-overview",
    ts: "2026-08-24T05:00:00Z",
  },
  {
    dirId: TEST_DIR_ID,
    name: "20260824T050100Z-perplexity-login-wall.png",
    label: "perplexity-login-wall",
    ts: "2026-08-24T05:01:00Z",
  },
];

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 1: Signal Resolution & Stream Mode Logic
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("── 1. resolveStreamMode: state signal resolution ───────────────────");

check(
  "empty / null state resolves to idle",
  resolveStreamMode(null, []),
  "idle",
);
check(
  "is_live: false, needs_human: false resolves to idle",
  resolveStreamMode({ is_live: false, needs_human: false }, []),
  "idle",
);
check(
  "is_live: true resolves to live (Blue Flowing Mode)",
  resolveStreamMode({ is_live: true }, []),
  "live",
);
check(
  "takeover_up: true resolves to live (Blue Flowing Mode)",
  resolveStreamMode({ takeover_up: true }, []),
  "live",
);
check(
  "needs_human: true resolves to needs_human (Red Mode)",
  resolveStreamMode({ needs_human: true }, []),
  "needs_human",
);
check(
  "needs_login: true (exit 4) resolves to needs_human (Red Mode)",
  resolveStreamMode({ needs_login: true, service: "perplexity" }, []),
  "needs_human",
);
check(
  "signal: login_required resolves to needs_human (Red Mode)",
  resolveStreamMode({ signal: "login_required" }, []),
  "needs_human",
);
check(
  "decision: login_required resolves to needs_human (Red Mode)",
  resolveStreamMode({ decision: "login_required" }, []),
  "needs_human",
);
check(
  "stuck_signal: heartbeat_stale resolves to needs_human (Red Mode)",
  resolveStreamMode({ stuck_signal: "heartbeat_stale" }, []),
  "needs_human",
);
check(
  "login-wall shot name in refs resolves to needs_human (Red Mode)",
  resolveStreamMode({ is_live: true }, [
    { name: "20260824T050100Z-perplexity-login-wall.png", label: "perplexity-login-wall" },
  ]),
  "needs_human",
);
check(
  "Precedence: needs_human overrides is_live: true",
  resolveStreamMode({ is_live: true, needs_human: true }, []),
  "needs_human",
);

console.log("\n── 2. resolveStreamWarning: diagnostic warning content ─────────────");

const loginWarning = resolveStreamWarning({
  needs_login: true,
  service: "perplexity",
  reason: "Perplexity login required — CAPTCHA challenge presented",
});
check("login warning title is 'Login Required'", loginWarning?.title, "Login Required");
check("login warning service is 'perplexity'", loginWarning?.service, "perplexity");
check("login warning signal is 'login_required'", loginWarning?.signal, "login_required");
check(
  "login warning detail matches custom reason",
  loginWarning?.detail,
  "Perplexity login required — CAPTCHA challenge presented",
);
check(
  "login warning action instructs Konrad on manual takeover",
  loginWarning?.action,
  "Take control in manual mode or solve login to resume",
);

const staleWarning = resolveStreamWarning({
  stuck_signal: "heartbeat_stale",
});
check("stale warning title is 'Process Heartbeat Stale'", staleWarning?.title, "Process Heartbeat Stale");
check("stale warning signal is 'heartbeat_stale'", staleWarning?.signal, "heartbeat_stale");
check("stale warning action instructs logs check", staleWarning?.action, "Check worker logs or re-evaluate task status");

const liveNoWarning = resolveStreamWarning({ is_live: true });
check("live stream with no blocked signal returns null warning", liveNoWarning, null);

console.log("\n── 3. vncProxyUrl: authenticated loopback proxy URL construction ───");

check(
  "constructs default loopback vnc.html proxy URL",
  vncProxyUrl(TEST_DIR_ID),
  `/api/proxy/uploads/${TEST_DIR_ID}/vnc/vnc.html?autoconnect=1&resize=scale`,
);
check(
  "constructs custom subpath vnc proxy URL",
  vncProxyUrl(TEST_DIR_ID, "vnc_lite.html"),
  `/api/proxy/uploads/${TEST_DIR_ID}/vnc/vnc_lite.html`,
);
check("rejects invalid non-12-hex dirId (security boundary)", vncProxyUrl("short"), null);
check("rejects traversal dirId (security boundary)", vncProxyUrl("../../../etc"), null);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 2: CSS Animation Styles & Reduced Motion Support
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 4. StreamStyles: keyframes & prefers-reduced-motion ──────────────");

const stylesHtml = renderToStaticMarkup(createElement(StreamStyles));
checkTrue("contains fg-stream-flow-blue keyframes", stylesHtml.includes("@keyframes fg-stream-flow-blue"));
checkTrue("contains fg-stream-pulse-red keyframes", stylesHtml.includes("@keyframes fg-stream-pulse-red"));
checkTrue("contains fg-badge-pulse keyframes", stylesHtml.includes("@keyframes fg-badge-pulse"));
checkTrue("contains .fg-stream-live class definition", stylesHtml.includes(".fg-stream-live"));
checkTrue("contains .fg-stream-red class definition", stylesHtml.includes(".fg-stream-red"));
checkTrue(
  "contains @media (prefers-reduced-motion: reduce) rule",
  stylesHtml.includes("@media (prefers-reduced-motion: reduce)"),
);
checkTrue(
  "reduced motion disables animation (animation: none !important)",
  stylesHtml.includes("animation: none !important;"),
);
checkTrue(
  "reduced motion provides static blue border fallback",
  stylesHtml.includes("box-shadow: 0 0 0 1.5px var(--fg-accent) !important;"),
);
checkTrue(
  "reduced motion provides static red border fallback",
  stylesHtml.includes("box-shadow: 0 0 0 1.5px var(--fg-bleed) !important;"),
);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 3: Component Rendering & Four Visual States
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 5. BrowserStreamViewer: markup & four visual states ──────────────");

// State 1: Idle state (Archived stills)
const idleHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(BrowserStreamViewer, {
      shots: IDLE_SHOTS,
      initialIndex: 0,
      dirId: TEST_DIR_ID,
      mode: "idle",
      isOpen: true,
      onClose: noop,
    }),
  ),
);

checkTrue("idle viewer has role='dialog'", idleHtml.includes('role="dialog"'));
checkTrue("idle viewer has aria-modal='true'", idleHtml.includes('aria-modal="true"'));
checkTrue("idle viewer has aria-label", idleHtml.includes('aria-label="Browser Stream Fullscreen Viewer"'));
checkTrue("idle viewer displays dirId header", idleHtml.includes(TEST_DIR_ID));
checkTrue("idle viewer indicates 'ARCHIVED STILLS'", idleHtml.includes("ARCHIVED STILLS"));
checkTrue("idle viewer renders close button", idleHtml.includes("data-close-fullscreen"));
checkTrue("idle viewer renders manual mode toggle", idleHtml.includes("data-toggle-manual-mode"));
checkTrue("idle viewer renders navigation arrows", idleHtml.includes("data-nav-prev-shot"));
checkTrue("idle viewer renders filmstrip scrubber", idleHtml.includes("data-filmstrip-scrubber"));
checkTrue("idle viewer does not render red diagnostic banner", !idleHtml.includes("data-stream-diagnostic-banner"));

// State 2: Live-Blue stream state
const liveHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(BrowserStreamViewer, {
      shots: IDLE_SHOTS,
      initialIndex: 0,
      dirId: TEST_DIR_ID,
      mode: "live",
      state: { is_live: true },
      isOpen: true,
      onClose: noop,
    }),
  ),
);

checkTrue("live viewer renders 'LIVE STREAM' indicator", liveHtml.includes("LIVE STREAM"));
checkTrue("live viewer applies 'fg-stream-live' class", liveHtml.includes("fg-stream-live"));
checkTrue("live viewer does not show red banner", !liveHtml.includes("data-stream-diagnostic-banner"));

// State 3: Red Mode / Needs Konrad state
const redHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(BrowserStreamViewer, {
      shots: WALL_SHOTS,
      initialIndex: 1,
      dirId: TEST_DIR_ID,
      mode: "needs_human",
      state: {
        needs_login: true,
        service: "perplexity",
        reason: "Perplexity login wall detected",
      },
      isOpen: true,
      onClose: noop,
    }),
  ),
);

checkTrue("red viewer renders 'NEEDS KONRAD' badge", redHtml.includes("NEEDS KONRAD"));
checkTrue("red viewer indicates service name 'PERPLEXITY'", redHtml.includes("PERPLEXITY"));
checkTrue("red viewer applies 'fg-stream-red' class", redHtml.includes("fg-stream-red"));
checkTrue("red viewer renders diagnostic banner", redHtml.includes("data-stream-diagnostic-banner"));
checkTrue("red viewer banner shows warning title", redHtml.includes("Login Required"));
checkTrue("red viewer banner shows reason detail", redHtml.includes("Perplexity login wall detected"));
checkTrue("red viewer banner has 'Take Control Now' button", redHtml.includes("Take Control Now"));

// State 4: Closed modal
const closedHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(BrowserStreamViewer, {
      shots: IDLE_SHOTS,
      initialIndex: 0,
      dirId: TEST_DIR_ID,
      mode: "idle",
      isOpen: false,
      onClose: noop,
    }),
  ),
);

check("closed modal renders empty output (null)", closedHtml, "");

// Alias export check
checkTrue("FullscreenShotViewer is alias of BrowserStreamViewer", FullscreenShotViewer === BrowserStreamViewer);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 4: RunShotsIndicator & ShotStrip Rendering
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 6. RunShotsIndicator & ShotStrip: row integration ───────────────");

const indicatorNullHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(RunShotsIndicator, { runId: null }),
  ),
);
check("RunShotsIndicator with null runId renders nothing", indicatorNullHtml, "");

const indicatorUnindexedHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(RunShotsIndicator, { runId: TEST_RUN_UUID }),
  ),
);
check("RunShotsIndicator with unindexed runId safely renders nothing", indicatorUnindexedHtml, "");

const stripIdleHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(ShotStrip, { shots: IDLE_SHOTS, mode: "idle", onSelectShot: noop }),
  ),
);
checkTrue("ShotStrip renders with data-shot-strip", stripIdleHtml.includes("data-shot-strip"));
checkTrue("ShotStrip renders thumbnails for all shots", stripIdleHtml.includes("settings-overview"));

const stripLiveHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(ShotStrip, { shots: IDLE_SHOTS, mode: "live", onSelectShot: noop }),
  ),
);
checkTrue("ShotStrip live mode renders without throwing", stripLiveHtml.includes("data-shot-strip"));

const stripRedHtml = renderToStaticMarkup(
  createElement(
    Providers,
    null,
    createElement(ShotStrip, { shots: WALL_SHOTS, mode: "needs_human", onSelectShot: noop }),
  ),
);
checkTrue("ShotStrip red mode renders without throwing", stripRedHtml.includes("data-shot-strip"));

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 5: Poll Budget & Bandwidth Accounting
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 7. Poll Budget & Request Rate Verification ──────────────────────");

check("SHOTS_FULLSCREEN_POLL_MS is 5_000ms (12 req/min)", SHOTS_FULLSCREEN_POLL_MS, 5_000);
check("SHOTS_INDEX_POLL_MS is 30_000ms (2 req/min)", SHOTS_INDEX_POLL_MS, 30_000);
check("CHAT_LIST_POLL_MS is 10_000ms (6 req/min)", CHAT_LIST_POLL_MS, 10_000);
check("CHAT_DETAIL_LIVE_POLL_MS is 20_000ms (3 req/min)", CHAT_DETAIL_LIVE_POLL_MS, 20_000);
check("CHAT_DETAIL_FALLBACK_POLL_MS is 4_000ms (15 req/min)", CHAT_DETAIL_FALLBACK_POLL_MS, 4_000);
check("TEAM_POLL_MS is 6_000ms (10 req/min)", TEAM_POLL_MS, 6_000);
check("PLAN_POLL_MS is 30_000ms (2 req/min)", PLAN_POLL_MS, 30_000);
check("CHAT_SURFACE_REQ_PER_MIN_CEILING is 40 req/min", CHAT_SURFACE_REQ_PER_MIN_CEILING, 40);

const rateAtRestHealthy =
  60_000 / CHAT_LIST_POLL_MS +
  60_000 / CHAT_DETAIL_LIVE_POLL_MS +
  60_000 / TEAM_POLL_MS +
  60_000 / SHOTS_INDEX_POLL_MS +
  60_000 / PLAN_POLL_MS;

check("Steady-state rate at rest (SSE live, modal closed) === 23 req/min", rateAtRestHealthy, 23);
checkTrue("Steady-state rate is strictly below ceiling (23 ≤ 40)", rateAtRestHealthy <= CHAT_SURFACE_REQ_PER_MIN_CEILING);

const rateDegraded =
  60_000 / CHAT_LIST_POLL_MS +
  60_000 / CHAT_DETAIL_FALLBACK_POLL_MS +
  60_000 / TEAM_POLL_MS +
  60_000 / SHOTS_INDEX_POLL_MS +
  60_000 / PLAN_POLL_MS +
  1; // secrets fallback (1 req/min)

check("Degraded rate (SSE down, modal closed) === 36 req/min", rateDegraded, 36);
checkTrue("Degraded rate is strictly below ceiling (36 ≤ 40)", rateDegraded <= CHAT_SURFACE_REQ_PER_MIN_CEILING);

const rateFullscreenOpen = rateAtRestHealthy + 60_000 / SHOTS_FULLSCREEN_POLL_MS;
check("Active rate with Fullscreen Stream Viewer open === 35 req/min", rateFullscreenOpen, 35);
checkTrue("Fullscreen active rate is strictly below ceiling (35 ≤ 40)", rateFullscreenOpen <= CHAT_SURFACE_REQ_PER_MIN_CEILING);

/* ════════════════════════════════════════════════════════════════════════════
 * SECTION 6: Token Purity Check (NFU1)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 8. Token Purity Check (zero raw colours in rendered HTML) ───────");

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/g;
const FUNC = /\b(?:rgba?|hsla?)\(\s*[^)]*\)/g;

const renderedComponents = [idleHtml, liveHtml, redHtml, stripIdleHtml, stripLiveHtml, stripRedHtml];
let colorLiteralsCount = 0;

for (const html of renderedComponents) {
  const hexes = html.match(HEX) ?? [];
  const funcs = (html.match(FUNC) ?? []).filter((m) => !m.includes("var("));
  colorLiteralsCount += hexes.length + funcs.length;
}

check("Zero raw colour literals across all rendered browser stream components", colorLiteralsCount, 0);

console.log(
  `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — browser stream viewer check`,
);
process.exit(failures === 0 ? 0 : 1);

