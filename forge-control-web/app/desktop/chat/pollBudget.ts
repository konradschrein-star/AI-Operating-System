/**
 * pollBudget.ts — every poll period the desktop chat surface costs, in one
 * place, plus the ceiling they are measured against.
 *
 * WHY THIS FILE EXISTS. The surface's request rate is a property of five
 * numbers that lived in five different components, and the only thing that
 * added them up was prose in a comment and a hand-copied arithmetic block in
 * `scripts/checks/check-chat-delta.ts`. Round 3's reviewer caught the
 * consequence: the check "asserts" a 36 req/min degraded rate against local
 * copies of the intervals, so moving `TEAM_POLL_MS` to 1s would have left the
 * check green while the surface went to 84 req/min. A budget whose instrument
 * cannot see the outlay is not a budget.
 *
 * So the numbers live here, the components import them, and the check imports
 * THEM — not copies. Same idiom as `secretLive.ts`'s `secretsPollInterval`,
 * which is exported for exactly this reason.
 *
 * NOTHING REACT IS ALLOWED IN HERE. The check runs under plain `tsx` with no
 * DOM and no bundler; a single `import { useQuery }` would make the whole
 * measurement harness unrunnable. Constants only.
 *
 * HOW TO ADD A POLL. `CHAT_SURFACE_REQ_PER_MIN_CEILING` is a committed ceiling
 * (phase 600 `nav-walk.cjs:310`, P3), not a target. A new poll on this surface
 * is paid for by slowing an existing one — see ChatSurface's `listQ` comment,
 * where round 802 bought U30's secrets poll with 8s → 10s. The check asserts
 * every constant below against its own literal, so changing one here goes RED
 * there and the round that changed it has to re-argue the total.
 */

/** The chat rail's list of threads (`ChatSurface` `listQ`). 6 req/min.
 *  Round 802 moved it out from 8s; round 808 kept 10s after the poll it was
 *  bought for went away — see ChatSurface.tsx for that argument in full. */
export const CHAT_LIST_POLL_MS = 10_000;

/** The open thread's own detail poll while the SSE stream is UP: a safety net
 *  behind server push, not the sync path. 3 req/min. */
export const CHAT_DETAIL_LIVE_POLL_MS = 20_000;

/** The same poll with the stream DOWN — the degraded path, and the expensive
 *  one at 15 req/min. Round 3 of aios-console-responsiveness moved it out from
 *  3s (20 req/min), which put the degraded surface at 41 req/min, over the
 *  ceiling. Every chat transcript on every surface uses this one number:
 *  ChatSurface, AgentChatView, ProjectsSurface's two decks and the journal's
 *  MentorAgentDeck. A drilled view swaps its detail query for ChatSurface's
 *  (ChatSurface.tsx `enabled: … navStack.length === 0`), so the two must agree
 *  or the budget changes as you drill. */
export const CHAT_DETAIL_FALLBACK_POLL_MS = 4_000;

/** The team tree (`ChatTeamPanel`), paused whenever the panel is not visible.
 *  6 req/min. Round 0 of aios-chat-list-payload moved it out from 6s (10 req/min). */
export const TEAM_POLL_MS = 10_000;

/** The plan zone (`PlanKanban`), paused whenever the zone is not visible.
 *  2 req/min. Round 705 moved it out from 15s. */
export const PLAN_POLL_MS = 30_000;

/** The shared browser-shot index (`BrowserShots.useShotIndex`) — one key, so
 *  one poll for the whole page however many indicators subscribe. 2 req/min. */
export const SHOTS_INDEX_POLL_MS = 30_000;

/** The active fullscreen stream viewer poll (`BrowserStreamViewer`), active ONLY
 *  while the modal is open. 12 req/min (5s) while open, 0 req/min when closed. */
export const SHOTS_FULLSCREEN_POLL_MS = 5_000;

/** The fleet activity feed (`live/AgentActivity`) on the /live surface, where
 *  it is the surface's reason to exist and the freshest thing on the page.
 *  15 req/min.
 *
 *  It was a bare `refetchInterval: 4_000` literal inside the component until
 *  the sidebar's scope toggle gave the CHAT surface a way to mount it. A poll
 *  this file cannot see is a poll this file does not govern — the exact failure
 *  the header above describes — so it moved here rather than being counted by
 *  hand in a comment. /live has no ceiling of its own; this constant exists so
 *  that the chat surface's ceiling can be computed from real numbers. */
export const AGENTS_POLL_MS = 4_000;

/** The same feed mounted in the CHAT surface's right sidebar, in Konrad's
 *  "everything running" scope. 7.5 req/min — deliberately half of /live's rate.
 *
 *  WHY IT IS SLOWER, and why /live is not. In "everything running" the team
 *  tree (`TEAM_POLL_MS`, 6 req/min) and the plan zone (`PLAN_POLL_MS`,
 *  2 req/min) are unmounted, so the feed is buying 8 req/min of budget. At
 *  /live's 4s it would cost 15 and put the degraded surface at ~39 — inside the
 *  ceiling by one request, with nothing left for the next round. At 8s it costs
 *  7.5, so the swap is net -0.5 req/min and the committed 32 req/min degraded
 *  total does not move up. The operator ruled on this directly
 *  (cost, not the s-word `dollar-sweep.sh` greps for: this is a REQUEST budget,
 *  and that gate's primary pattern would flag the money verb in this prose)
 *  (2026-08-25): take the interval as a prop, mount the sidebar at 8s, leave
 *  /live at 4s, do not re-argue the ceiling to buy headroom.
 *
 *  A sidebar rail 260px wide showing a whole box's worth of runs is a glance
 *  surface, not the thing you watch a tool call land on; /live is that. */
export const SIDEBAR_AGENTS_POLL_MS = 8_000;

/** The committed whole-surface ceiling, in requests per minute, with every
 *  panel open. Measured by `docs/plan/artifacts/phase600/nav-walk.cjs:310`
 *  (P3) at rest, at depth 1 and at depth 2 — not by arithmetic. */
export const CHAT_SURFACE_REQ_PER_MIN_CEILING = 40;

