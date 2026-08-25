# Round 0 (e4e503ab) — aios-sidebar-live-sessions: before-evidence

**Task:** evidence-only, read-only against the live console at
`https://os.schreinercontentsystems.com`, signed in as Konrad. Full findings, screenshots,
methodology and citations are in **`evidence/aios-sidebar-live-sessions/before.md`** — this file is
the short pointer the research harness expects; do not duplicate the long version here.

## Headline results

1. **The PROJECT-picker text-overlap Konrad reported does not reproduce.** Reached the exact state
   implied by his screenshot — a project-linked chat, the picker rendered with many candidates (28,
   on chat `2ef126b7-d6d9-…`), a live worker running — and measured every visible text element's
   painted bounding box (not eyeballed). Zero pairwise intersections, in both themes. Two distinct
   false-positive traps had to be corrected for first (multi-line block boxes, and
   `text-overflow: ellipsis` clipping not respected by `Range.getClientRects()`) — see the new
   fleet memory note `dom-text-overlap-check-two-false-positive-traps.md` for the reusable fix.
2. **The `[data-project-switcher]` picker has no expand/collapse state.** It unconditionally
   renders inline the moment `candidates.length > 1` (`ChatTeamPanel.tsx:892`). "Picker expanded"
   in the brief means exactly this always-on render, not a separate interaction — worth knowing
   before designing a toggle that doesn't need to exist.
3. **"no project linked to this chat" renders exactly twice, by design, with no visual defect** —
   once in the Team tree (`ChatTeamPanel.tsx:1060`), once in the PLAN zone (`PlanKanban.tsx:693`).
   Confirmed by string count on `body.innerText` and visually.
4. **`GET /api/proxy/chat/:id/team` steady state, measured through the app's real fetch path (not
   curl, not `page.evaluate`):** 32,323 bytes/min, 6.15 req/min, 5,254–5,256 B/response, on a chat
   with a live worker (poll never backs off — `isTreeSettled()` requires the whole tree settled,
   `ChatTeamPanel.tsx:215-227`, `TEAM_POLL_MS = 10_000`, `pollBudget.ts:51`). No `ETag`/
   `Cache-Control` reached the browser on any of the 20 sampled responses. This is a **fresh,
   single-chat baseline for 2026-08-25** — do not conflate it with `aios-chat-list-payload`'s
   2026-08-24 fleet-wide figure of 48,670 B/min for the same endpoint on a different chat.

## Evidence

Four screenshots, all under `/opt/ai-os/uploads/931b891b2941/`, cited by URL and read back in the
transcript per the shot-rendering rule:

- `/api/uploads/931b891b2941/20260825T002544Z-team-panel-linked-light.png`
- `/api/uploads/931b891b2941/20260825T002628Z-team-panel-linked-dark.png`
- `/api/uploads/931b891b2941/20260825T002631Z-team-panel-unlinked.png`
- `/api/uploads/931b891b2941/20260825T002904Z-team-panel-linked-light-fullrail.png`

## Sources

See `evidence/aios-sidebar-live-sessions/before.md` §Sources for the full citation list (live API
endpoints with access timestamps, exact source file lines, and fleet memory notes consulted).
