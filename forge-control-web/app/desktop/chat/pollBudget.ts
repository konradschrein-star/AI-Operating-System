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

/** The committed whole-surface ceiling, in requests per minute, with every
 *  panel open. Measured by `docs/plan/artifacts/phase600/nav-walk.cjs:310`
 *  (P3) at rest, at depth 1 and at depth 2 — not by arithmetic. */
export const CHAT_SURFACE_REQ_PER_MIN_CEILING = 40;

