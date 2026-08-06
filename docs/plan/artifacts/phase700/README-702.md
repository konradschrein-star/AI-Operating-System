# 702 — PlanKanban bottom zone + mount + plandoc nav wiring

U25 (Kanban zone) and the navigation half of U26 (phase → plan doc). Built strictly on round 701's `planApi.ts` / `planStore.ts`: no second fetch of `/plan`, and no number re-derived that the store already computes.

## What shipped

| File | Change |
|---|---|
| `forge-control-web/app/desktop/team/PlanKanban.tsx` | NEW — the zone. One `useQuery(["chat-plan", chatId])`, 15s, `enabled: visible && !!chatId`, `retry: 0`. Header (label + x/y + bar) → scrollable phase cards → `docs[]` list. |
| `forge-control-web/app/desktop/team/ChatTeamPanel.tsx` | Team zone becomes the top zone; `PlanKanban` the bottom one. A wrapper `<div>` + one prop. Verify with `git diff -w` — the row list, the armed-state machine and the dismissal wiring are byte-identical. |
| `forge-control-web/app/desktop/ChatSurface.tsx` | `openPlanDoc` (stable identity, mirroring `openNode`), threaded through `SidePanel`; the phase-700 placeholder comment removed. |
| `forge-control-web/app/desktop/chat/nav-stack.ts` | The two stale comments on `plandoc` corrected — the U6 endpoint shipped in phase 300, and this round is what pushes the frame. |
| `forge-control-web/app/globals.css` | `.plan-doc-link` hover/focus underline. CSS-only, no colour, beside the existing `.team-row` rules. |

## The design fact that shaped it

`matchPhaseDoc` links a block to a file only when a digit run in the filename equals the block's round number. This corpus is numbered by document position (`00-`…`16-`), so **no phase block carries `doc_path`** — measured across all 16 blocks in `linkage-701.md` §6, and re-confirmed by this round's capture (`doc links == endpoint docs[]`, 12 entries, zero card affordances).

Two consequences are designed in:

- a phase card renders a doc affordance **only** when `doc_path` is present — a dead click that opens nothing is a FAIL;
- the `docs[]` corpus is **also** exposed as a flat clickable list at the bottom of the zone, so U26's click-through is reachable on the real data — hiding the corpus because the phases could not be matched to it is equally a FAIL.

The capture asserts the second path end to end: click the last entry → `[data-plan-doc-view][data-doc-name]` carries that exact file → back returns to the manager chat.

## NFU3 — poll budget

The panel goes from 1 poll to 2. The pre-v3 baseline for this same slot was also 2 (`/api/agents` every 4s + `/api/projects/board` every 6s). At 5s + 15s the branch is under the baseline in requests/minute, not merely equal in count. Round 703 measures it against the HAR baseline; the header comment in `PlanKanban.tsx` states the claim it checks.

## NFU2 — hover

Zero pointer handlers and zero hover state in `PlanKanban.tsx` (`grep 'onMouseEnter\|onMouseOver\|onPointerEnter\|useState.*hover'` → no hits). Affordances are `:hover`/`:focus-within` in `globals.css`; every explanation is a native `title`. `PhaseCard` is `memo`ized and `onOpenDoc` is an empty-deps `useCallback` over a ref, so a ChatSurface re-render cannot change the identity the cards hold. Round 703 owns the profiler sweep.

## Evidence — `kanban-702.cjs`, 16/16 PASS

Run against the worktree stack (API `:7798` = `scripts/checks/serve-v3-7798.ts`, web `:7809` = this worktree's own `next start`; `:7799` was held by another round's `/tmp/phase300-secrets-probe.ts`, so the port moved rather than killing it — phase600 README §2 D's rule).

```
PHASE700_BASE_URL=http://127.0.0.1:7809 PHASE700_API_URL=http://127.0.0.1:7798 \
  FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-702.txt)" \
  node docs/plan/artifacts/phase700/kanban-702.cjs
```

Captured 2026-08-06 against chat `bfd1283a-b71b-4f35-b577-7d09aad803f2` / project `8ea0cc08…`:

| fact | value |
|---|---|
| plan endpoint | 16 phases, 66 tasks, 54 done |
| rail endpoint (server-computed) | 54 / 66 |
| rendered `data-plan-progress` (client-computed) | **54/66** |
| rendered rail badge text | **54/66** |
| phase cards / task chips / doc links | 16 / 66 / 12 |
| zone geometry | panel 887px, zone 355px = **40%**, card body scrolls, header outside the scroller |

Three-way agreement holds: server SQL, `planStore.planProgress`, and the string a human reads off the rail are the same number in one page read.

> Note on the brief's "~8 blocks and ~60 tasks": the real corpus is **16 blocks / 66 tasks** — round 701 §4a already recorded that the block estimate was stale (rounds 1200/1600/1700 are ad-hoc single-task blocks Konrad injected mid-flight). The capture asserts against the endpoint, not against the estimate.

Screenshots (this round proves it renders; round 703 owns the formal both-theme capture):

- `phase700-702-kanban-dark.png` — sampled background `rgb(0,0,0)`
- `phase700-702-kanban-light.png` — sampled background `rgb(247,247,245)`
- `phase700-702-plandoc-dark.png` — the pushed `plandoc` frame

One console line is ignored and named in the JSON: `GET /favicon.ico` 404s on every page of this app, on main as well as on this branch (the repo ships no favicon). It is browser-internal and never reaches the response listener.

## Known integration seam for the round's other half

`PlanDocView.tsx` is owned by the parallel task this round and is still the phase-600 shell here: it takes `{name, stack, onBack, backLabel}` and fetches nothing. The nav wiring above is complete and proven independent of that — clicking a doc pushes the frame and renders the shell. If that task gives `PlanDocView` a required `chatId` prop, `ChatSurface.tsx`'s call site needs `chatId={selId}` added; whichever of the two commits second owns that one line.
