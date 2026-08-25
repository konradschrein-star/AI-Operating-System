# aios-sidebar-live-sessions — round 0: before-evidence

**Date:** 2026-08-25, ~00:20–00:33 UTC. **Method:** real browser (Chromium 140-ish, headless, via
`/opt/hermes-workspace/node_modules/playwright` driving
`/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` — the bundled
`chromium_headless_shell-1223` revision the package asks for is not installed; this is the known
fix, see `playwright-driver-two-launch-traps.md`), against the LIVE console at
`https://os.schreinercontentsystems.com`, signed in as Konrad. **Read-only.** No file in
`/opt/forge-ai-os` was edited, built, or restarted; no task was created; no control (stop/dismiss/
project-switch) was clicked.

## How I signed in

Minted a next-auth v5 session JWE with `@auth/core`'s `encode()`
(`/opt/forge-ai-os/forge-control-web/node_modules/.pnpm/@auth+core@0.37.2/node_modules/@auth/core/jwt.js`),
`secret` = `AUTH_SECRET` read from `/opt/forge-ai-os/forge-control-web/.env.local` (read-only),
`salt` = `__Secure-authjs.session-token` (the live `AUTH_URL` is `https://…`, so `useSecureCookies`
is true and the salt must equal the prefixed cookie name — per
`nextauth-salt-must-equal-cookie-name.md`). Set via `context.addCookies([...])` with
`secure: true`, `domain: "os.schreinercontentsystems.com"`. Verified with a plain curl first
(`GET /desktop` → 200, body contains `<title>Desktop</title>`-shaped markup, no `signin` string)
before ever opening a browser — this is the "positive control" the memory notes ask for.

Chat selection: `localStorage.setItem('forge.desktop.surface', JSON.stringify('chat'))` and
`localStorage.setItem('forge.chat.selected', JSON.stringify('<chat-uuid>'))`, via
`context.addInitScript()` before `page.goto()`. Every screenshot asserts
`page.url().endsWith('/desktop')` before being trusted (the stale-cookie trap in
`stale-session-cookie-fakes-a-perfect-score.md`) — all four landed correctly, no `/signin` redirect
anywhere in this round.

Two chats were selected by querying the API first (`GET /api/proxy/chat/:id/team`), not by
clicking around, per the brief:

- **`2ef126b7-d6d9-4a55-a8e7-d9acf0508645`** — this project's own manager chat. `project.id =
  fb3b5fb2-…` (status `active`), `link_source: "metadata"`, `link_ambiguous: true`, **28
  candidates** in the picker. At measurement time it had 3 workers, one **`running`**
  (`931b891b-2941-…`, `claude-sonnet-5` — this very task). This one chat satisfies both "linked
  project with live workers" and "picker with >1 candidate" simultaneously, so it is the source
  for shots 1 and 2.
- **`3f03be16-436f-4adc-ba7f-90e661a7cda7`** — `project: null`, `link_source: null`,
  `candidates: []`, manager `running` (a live, unrelated operator chat: "Today I want to upgrade
  the goals/task and the journals page…"). Source for shot 3.

## Screenshots

All saved to `/opt/ai-os/uploads/931b891b2941/` and read back before being cited here, per
`chat-renders-shots-two-shapes.md`. Viewport `1600×2400` throughout (the desktop shell scrolls
internally; `fullPage:true` would only capture the viewport anyway — `fullpage-screenshot-equals-viewport.md`).

1. **Linked chat, live worker, light theme** —
   `/api/uploads/931b891b2941/20260825T002544Z-team-panel-linked-light.png`
2. **Linked chat, live worker, dark theme** —
   `/api/uploads/931b891b2941/20260825T002628Z-team-panel-linked-dark.png`
3. **Unlinked chat** —
   `/api/uploads/931b891b2941/20260825T002631Z-team-panel-unlinked.png`
4. **Linked chat, re-shot immediately before the DOM overlap scan** (same content as #1) —
   `/api/uploads/931b891b2941/20260825T002904Z-team-panel-linked-light-fullrail.png`

Shot 1/4 show the full panel: `Team`/`Files` tabs, the `PROJECT` picker as a wrapped row of 28
chips (`aios-sidebar-live-sess…` through `aios-journal-and-mento…`), then four session rows
(one `architect`, two `researcher`, the running one carrying a `7 LIVE ▸` badge), then the `PLAN`
kanban zone with a 6-task board. Nothing is cut off, nothing collides.

## Finding 1 — the picker-overlap state: **did not reproduce**

**Important framing correction first:** `[data-project-switcher]` (`ChatTeamPanel.tsx:892`) is
**not** an expand/collapse control. It has no open/closed state at all — it unconditionally renders
as an inline wrapped row of buttons the instant `data.candidates.length > 1`. So "the picker
expanded" is not a distinct interaction to trigger; it is simply what chat `2ef126b7…` (28
candidates) renders on every load, no click required. Shots 1/2/4 above **are** that state.

**Measurement, not eyeballing.** A naive DOM box-intersection check is a trap in two specific ways
I hit and had to correct for (documented as a new memory note,
`dom-text-overlap-check-two-false-positive-traps.md`, since this is a reusable pitfall):

1. `getBoundingClientRect()` on a multi-line `<p>`/block element returns the union of all its line
   boxes — a 3-line paragraph's box is "tall", and that tall box trivially "intersects" anything
   vertically adjacent to any of its lines, even though nothing is visually touching. This produced
   56 raw hits on the first pass, all in the chat transcript, none in the Team panel.
2. `Range.getClientRects()` on a text node inside a `text-overflow: ellipsis; overflow: hidden;
   white-space: nowrap` element reports the **full, pre-clip** text extent, not what is actually
   painted. Task-title spans in the session rows are exactly this pattern (`"okay this is a
   gigantic t…"` truncated with CSS, not by string slicing) — an un-clipped Range measurement
   reported them as 227–480px wide and "overlapping" the token-count and elapsed-time columns to
   their right. Visually (cropped screenshot, `/tmp/crop-panel-top.png` region) there is no
   collision at all — the ellipsis is real and the columns are clear.

**Corrected method:** for every element with the Team/Files rail
(`[data-project-switcher]`'s 4th ancestor, a `260×2326`px container matching the rail exactly) that
carries its own direct text node, collect `Range.getClientRects()` per text node, then **clip each
rect against every ancestor (including the element itself) that has `overflow: hidden` or
`overflow: clip`** — this reduces a truncated span's box to its real, painted, ellipsis-respecting
width. Then check pairwise intersection, excluding true DOM ancestor/descendant pairs
(`el.contains(other)`), and excluding boxes outside the viewport or with `opacity ≤ 0.05` /
`visibility: hidden` / `display: none`.

**Result: 179 visible text line-boxes inside the Team/Files rail, zero pairwise intersections.**
Verified twice (once via the corrected script, once by eye on a 2× crop of the top of the panel).

**Verdict: reproduced — no. In the exact state Konrad's screenshot implies (project-linked chat,
picker rendered with many candidates, live worker present), no text overlaps any other text**, in
either theme. This is a real "did not reproduce" result, not a "could not test" one — the state was
reached, measured rigorously, and found clean.

**What I did not test, and why it might still matter:** viewport widths other than 1600px, browser
zoom other than 100%, and non-Chromium fonts/font-substitution were not exercised — if Konrad's
own window is narrower or zoomed, the picker's wrap could differ. I also did not click a picker
chip to reach the `switchingTo` "switching to X… — rows below are still the previous project's"
transient note (`ChatTeamPanel.tsx:1011-1018`) — that is a genuine control-mutation on a chat with
a running task, and this round is explicitly read-only; if that specific transient state is worth
checking, it needs a dedicated round, not a photo taken in passing.

## Finding 2 — "no project linked to this chat": **confirmed, renders exactly twice, no visual bug**

On the unlinked chat (`3f03be16…`, shot 3), `body.innerText` contains the string
`"no project linked to this chat"` **exactly twice** (counted programmatically, not by eye):

- Once in the Team tree itself: `ChatTeamPanel.tsx:1060`,
  `{dataState === "unlinked" && <Note>no project linked to this chat</Note>}`.
- Once in the `PLAN` zone below it: `PlanKanban.tsx:693`,
  `{state === "unlinked" && <Note>no project linked to this chat</Note>}`.

Both are visible in the screenshot, in two clearly separated regions (the agent-tree area and the
PLAN area beneath the divider) — this matches the brief's suspicion about the duplicate text
exactly, but it is **not** a layout bug: nothing overlaps, nothing repeats within the same zone, and
each `<Note>` is its own component correctly reporting its own zone's state. Whether Konrad wants
one combined message instead of two is a product decision for the next round, not a rendering
defect this round found.

## Measurement — GET /api/proxy/chat/:id/team steady-state bytes/min

Per the brief: measured **in a real browser, through the app's own fetch/React-Query code path**,
not `page.evaluate(fetch(...))` and not curl — a raw-browser or curl probe measures the wrong thing
(`etag-304-needs-an-explicit-client.md`). Captured every response via `page.on('response')`,
filtered to the exact pathname `/api/proxy/2ef126b7-d6d9-4a55-a8e7-d9acf0508645/team` (not a
prefix match, so `/team`'s siblings like `/plan` or `/linkage` cannot pollute the sample), on the
same linked chat used for shots 1/2/4 (live worker present throughout).

| | |
|---|---|
| Window | 195.1 s (3 m 15.1 s) wall clock |
| Requests observed | 20 |
| Requests/min | 6.15 |
| Bytes/response | 5,254–5,256 (flat — the tree's shape didn't change during the window) |
| Total bytes | 105,090 |
| **Bytes/min** | **32,323** |
| `ETag` / `Cache-Control` header on any of the 20 responses | **none** |

**The poll never backed off**, and that is expected, not a bug: `ChatTeamPanel.tsx:395` sets
`refetchInterval: (query) => (isTreeSettled(query.state.data) ? false : TEAM_POLL_MS)`, and
`TEAM_POLL_MS = 10_000` (`pollBudget.ts:51`). `isTreeSettled` (`ChatTeamPanel.tsx:215-227`) requires
every node in the tree — manager, every worker, every subagent, recursively — to have `.settled ===
true`. This chat had a `running` worker (this very task) for the whole 195 s window, so the poll
stayed at the full 10 s cadence the entire time; 20 requests / 195 s ≈ 6.15/min matches that
exactly. **I did not independently reproduce the "poll stops when settled" claim in this round** —
doing so would mean watching this task's own run finish mid-measurement, which didn't happen in the
window — so that half of the claim is source-cited, not measured, and should be labelled as such if
repeated.

**No ETag reaches the browser on this endpoint**, same shape as the `/uploads/index` and `/chat`
findings from `aios-uploads-index-payload` and `aios-chat-list-payload` (both `done`,
2026-08-24): the Next.js `/api/proxy/:path*` hop does not appear to carry conditional-request
headers through on this route either. I did not verify the `:7700`-direct side (curl straight to
forge-control) to confirm whether the origin even emits one on `/team` — that's out of scope for a
read-only round and would need a throwaway-router probe, not a live-site drive-by.

**Do not confuse this number with the fleet's earlier one.** `aios-chat-list-payload`'s brief
(2026-08-24 06:05Z measurement) reported `/chat/<chat>/team` fleet-wide at **48,670 B/min · 6
req/min** — a different chat, a different day, and (per that project's own scope) already reported
as "already fixed, leave alone" for the transcript hop specifically. This round's **32,323 B/min ·
6.15 req/min** is a fresh, single-chat baseline taken today, 2026-08-25, on `2ef126b7…` specifically
— it is the number the *next* round should diff against for *this* chat, not a re-confirmation of
the older fleet-wide figure.

## What is safe to build on top of

- The picker never needs an "expand" affordance to be added or preserved — it has none today, and
  Konrad's overlap complaint does not reproduce in the state that most resembles it. Redesigning
  the picker's row-of-chips layout is fair game; there is no known overlap bug to route around.
- The two "no project linked to this chat" notes are working as designed, in two different zones.
  If round 2 folds Team and Plan into fewer zones, both notes naturally collapse to one — that's a
  simplification, not a bug fix.
- `/chat/:id/team`'s 10 s poll, ~5.25 KB/response, is the number to beat. Any redesign that adds
  fields to this response should re-measure against 32,323 B/min · 6.15 req/min on a chat with a
  live worker, the same way this round did — not against curl, not against `:7700` directly.

## Sources

- Live console, signed in: `https://os.schreinercontentsystems.com/desktop` — browser session,
  2026-08-25 00:20–00:33 UTC.
- `GET /api/proxy/chat/2ef126b7-d6d9-4a55-a8e7-d9acf0508645/team` — live API, browser session and
  direct curl (for chat discovery), 2026-08-25 00:24 UTC.
- `GET /api/proxy/chat/3f03be16-436f-4adc-ba7f-90e661a7cda7/team` — live API, curl, 2026-08-25
  00:24 UTC.
- `GET /api/proxy/projects` — live API, curl, 2026-08-25 00:22 UTC (to find `origin_chat_id` links).
- `forge-control-web/app/desktop/team/ChatTeamPanel.tsx` (worktree copy of
  `/opt/forge-ai-os/forge-control-web/app/desktop/team/ChatTeamPanel.tsx`, read-only), lines
  215-227, 392-395, 892-995, 1057-1060 — read 2026-08-25.
- `forge-control-web/app/desktop/team/PlanKanban.tsx` (same source), lines 113, 596, 693, 703 —
  read 2026-08-25.
- `forge-control-web/app/desktop/chat/pollBudget.ts`, line 51 (`TEAM_POLL_MS = 10_000`) — read
  2026-08-25.
- Fleet memory (`/root/.claude/projects/-opt-forge-ai-os/memory/`):
  `nextauth-salt-must-equal-cookie-name.md`, `stale-session-cookie-fakes-a-perfect-score.md`,
  `etag-304-needs-an-explicit-client.md`, `fullpage-screenshot-equals-viewport.md`,
  `playwright-driver-two-launch-traps.md`, `chat-renders-shots-two-shapes.md` — all read before
  driving the browser.
