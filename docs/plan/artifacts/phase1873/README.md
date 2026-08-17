# Round 1873 — fix cycle 2, against round 1872's re-test

Six findings came back. All six are addressed below with what was actually
wrong, what changed, and the run that proves it. One of them (finding 6) is
answered with a **disclosure rather than a feature**, because the payload the
brief asks for does not exist in the data — that is stated in the UI, in the
code, and here, with the query that establishes it.

Everything was produced from **the worktree**, never from `/opt/forge-ai-os`:

| Component | Where it ran |
|---|---|
| forge-control-web | worktree build (`npm run build`), `next start -p 7823` |
| forge-control | worktree routers via `scripts/checks/serve-v3-7798.ts` on `:7822` |
| database | the real `content_forge` — reads, plus one deliberate two-row round trip (§"Footprint") |

No pm2 service was started, stopped or restarted.

**Evidence in this directory**

| File | What it is |
|---|---|
| `verify-1873.cjs` | the browser run: 50 assertions across all six findings, both themes |
| `results.json` | its output, plus every network write the harness intercepted |
| `01`…`12-*.png` | one screenshot per journey, dark and light |
| `team-hover-r1873-after{,-2,-3}.json` | three hover sweeps (NFU2 non-regression) |

Pure-logic assertions live in `scripts/checks/check-r1873-fixes.ts` (66 checks,
ALL PASS) — the blast-radius arithmetic, the confirm machine, the restore
decision table, the crumb labels, the comms census and the phone menu's
coverage of the nav model.

```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
  --tsconfig ../tsconfig.checks.json ../scripts/checks/check-r1873-fixes.ts
node docs/plan/artifacts/phase1873/verify-1873.cjs
```

---

## 1. The project switcher looked dead for ~7 seconds — **bad** → fixed, 6828ms → 13ms

**What it was: two bugs, one symptom.**

The click handler called `team.refetch()` after `setProjectOverride(p.id)` — but
`projectOverrideRef.current` was assigned **during render**, and the handler runs
*before* that render. So `queryFn` read the *previous* override, refetched the
project already on screen, and the switch only landed on the next 6-second poll.
That is the 6,828ms.

The silence was separate: `aria-pressed` was derived from `data.project?.id`,
i.e. from the response — which by definition had not arrived — so nothing on
screen acknowledged the click at all.

**What changed** (`ChatTeamPanel.tsx`):

* the handler writes `projectOverrideRef.current` itself, before `refetch()`;
* `switchingTo` is the request the operator made, available in the same tick:
  the chip goes `aria-pressed` + `data-project-pending` immediately, the panel
  reports `data-team-state="switching"`, the tree dims to 0.45 with
  `aria-busy="true"`, and a line says *"switching to operator-visibility… — the
  rows below are still the previous project's"*;
* it is cleared by the RESPONSE (or by an error), never by a timer.

**Measured** (`results.json`, `01-f1-switching.png`, `02-f1-switched.png`):

| | round 1872 | now |
|---|---|---|
| acknowledgement (`aria-pressed` flips) | never (0 of 6828ms) | **13ms**, next animation frame |
| rows arrive | 6828ms / 6743ms | **767ms**, on the click's own fetch |
| `data-team-state` during the switch | `ready` (a lie) | `switching` |
| dimming / spinner | none | tree at 0.45 opacity + `aria-busy` + a named note |

21 rows → 167 rows, and the pending marker is gone once it lands.

## 2. Finding 12 untouched, blast radius larger than reported — **bad** → fixed

**What it was.** ✕ on a settled row fired on one click, on the reasoning that a
dismissal is reversible. That held for a leaf and was wrong at the top of a
tree: a dismissal **cascades** (`resolveCascade`), so one click on the manager
row hid 174 nodes / 165 of 166 rows — with no confirm, no undo, and only the
fleet-wide "restore all" as a way back. Meanwhile that harmless direction took
two clicks. The guard was on the wrong control.

**What changed — the guard is now proportional to the blast radius, not attached to the verb.**

1. `TeamRow.hidesRows` (`cascadeRowCount` in `teamRows.ts`) is what the row's ✕
   would take off the panel: itself plus its visible sub-agents. It rides on the
   row, so it changes only when that row's own subtree does — the identity
   invariant round 1302 established is untouched (`check-team-rows.ts`, ALL PASS).
2. `needsConfirm` (`confirm.ts`) arms any click that hides **more than the row it
   was aimed at**; a settled leaf still goes in one click, because taxing the
   cheap gesture is how people learn to click through confirms.
3. The armed row grows a strip naming the cost — *"hide 3 rows — this one and the
   2 settled under it? ✕ again to confirm"*. The button label stays five
   characters (`hide?` / `sure?`) because `X_COL` reserves exactly that width:
   round 1355's finding #4 was an armed ✕ that moved out from under the pointer.
   **Verified**: `1560x187x32x18 → 1560x187x32x18` across arming.
4. The toast carries a **real undo of exactly that gesture** — `restoreMany` over
   the id list the server cascaded, not `restore` on the clicked row, which would
   have left its companions hidden. New route:
   `POST /api/agents/dismissals/restore {ids}` (`routes/agents.ts`).
5. The **manager row** is the one case the tree cannot count — its cascade reaches
   finished runs of its project that the response never listed — so it declares
   `widerReach`: always confirmed, described in words (*"and any project this chat
   started"*) instead of a number that would be wrong.

**The /live panel got the same treatment**, from the same module: it calls the
same cascading endpoint, and 11 leaves there stay one-click while the row with
sub-agents is guarded. Its armed label is `✕?` — `CONTROLS_COL` is 20px.

**Driven end to end** (`03`…`05-*.png`): first click arms and sends nothing
(0 writes), the confirmed click hides 3 rows, the toast offers `undo`, and undo
restores exactly the 3 ids the gesture hid — 167 → 164 → 167 rows.

**Why "restore all" keeps its two clicks.** It is not the reverse of one
dismissal. It deletes *every* dismissal on the machine, across both panels and
every project — forty individual decisions the operator cannot reconstruct
(round 1354's reviewer lost eleven that way). The reverse of one dismissal is
the undo in its own toast, and that now costs one click. The guarded directions
are the ones that lose something.

## 3. 11 of 14 destinations unreachable on a phone — **bad** → fixed, 18 of 18 reachable

**What it was.** Below 900px the left rail is hidden (round 1871, finding 8) and
the top strip rendered anyway: 1,138px of destinations inside a 390px viewport,
`overflow-x: visible`, `scrollWidth === clientWidth`, no hamburger. LIVE sat at
x=914 and could not be reached by swipe, wheel or `window.scrollX`.

**What changed.** Below 900px the strip is replaced by one `menu` button
(`aria-label="Open navigation menu"`) and the bar names the surface you are on.
The button opens a sheet listing **all four nav groups plus SETTINGS** — not the
three groups the strip had, because the rail is hidden at this width too and a
menu written against the strip would have stranded GOALS, JOURNAL, MAP and
SETTINGS all over again. Rows are 44px thumb targets; Escape, the backdrop and
any choice close it.

`NAV` and the sheet's group list moved to `app/desktop/nav-items.ts` so that
coverage is assertable rather than eyeballed: `check-r1873-fixes.ts` compares
`mobileNavDestinations()` against `NAV` + settings, and fails if a group is ever
added to the model and not to the sheet.

**Measured at 390×844** (`09`…`11-f3-*.png`): 18 destinations, 18 inside the
viewport, 18 at ≥44px, page overflow 0px. The journey that was impossible — tap
LIVE — closes the sheet, opens the panel, renders 14 rows, 0px overflow.

## 4. Reload restored the chat but not the drill-in — **paper-cut** → fixed

**What it was.** An ordering bug invisible in the effect's own code.
`usePersistentState` hydrates in a **layout effect**, so `selId` is `null` on the
first render and arrives one commit later. Round 1871's restore was a passive
effect keyed on `selId` with a one-shot ref: it ran on that first render, saw
`null`, **burned the ref**, and never restored anything.

**What changed.** The keys, the validators and the decision moved to
`app/desktop/chat/stored-nav.ts`; `restoredNavStack(navRaw, chatRaw)` is a pure
function over the two raw strings, and ChatSurface reads `localStorage` once in
a layout effect that depends on no state at all. Rejection rules unchanged and
now asserted: a stack belonging to another chat, an empty stack, half-written
JSON, a frame with no `runId`, a non-uuid chat id (11 cases in the check).

**Verified** (`08-f4-after-reload.png`): F5 while reading a sub-agent returns to
that sub-agent — `data-subagent-id` identical, `data-depth="1"`,
`← manager chat` present — at +6s and still at +15s.

## 5. The sub-agent breadcrumb still read `sub-agent toolu_01` — **paper-cut** → fixed

**What it was.** Round 1871 put the clicked row's name on the nav frame and then
never read it: `AgentChatView.tsx:463` built the crumb as
`` `sub-agent ${subagentId.slice(0, 8)}` ``, and every Anthropic `tool_use_id`
starts `toolu_01`. The view title had the same fallback.

**What changed.** `currentFrameLabel(frame, learned)` in `nav-stack.ts`: the
label the click carried, then what the fetch learned, then the **discriminating**
part of the id (`AeuQskZP`, not `toolu_01`). The synthesized sub-agent run takes
the same fallback for its title. Ids stay reachable in the crumb trail's
`title`.

**Verified** (`07-f5-subagent-crumb.png`): row *"Recon chat Bash block
rendering"* → crumb `manager chat › Recon chat Bash block rendering`, tooltip
`… (toolu_014raMUrJcAiXV61BerokrjN)`.

## 6. Only one direction of agent comms exists — **paper-cut** → disclosed in the UI

**The tester was right, and it is not a rendering bug.** The mechanism, exactly:
`commsEntries` (`forge-control/src/lib/run-control-rules.ts:509`) writes the
`in` entry to the RECEIVER's thread always, and the `out` echo to the sender's
thread **only if the sender is a run** (`if (!senderRunId) return { receiver,
echo: null }`). A worker reporting up passes `sender_run_id`, so it keeps an
`out` echo and the manager holds the matching `in`. This operator chat never
sends through that route — it starts projects and the engine seeds the tasks —
so there is no outbound record to render.

Measured against the live `runs` table on 2026-08-17:

```sql
select coalesce(e->'meta'->'comms'->>'direction','-') dir,
       coalesce(e->'meta'->'comms'->>'from','-') frm,
       count(*) n, count(distinct r.id) runs
  from runs r, jsonb_array_elements(r.thread) e
 where e->>'kind'='comms' group by 1,2 order by n desc;

 in  | worker  | 123 |   4     ← managers holding reports
 out | worker  | 123 | 103     ← the same reports, on the workers' own threads
 in  | konrad  |  14 |   8
 in  | manager |   4 |   2
 out | konrad  |   1 |   1
```

So the outbound cards DO render — on a worker's transcript, which is one click
away in the same UI.

**What changed.** The brief's instruction for this case is "document exactly what
is missing instead of building new plumbing", so the transcript says it. One line
above the thread, pinned (not inside the scrolling viewport, where a 460-entry
transcript would bury it):

> `AGENT COMMS · 124 received · 0 sent · this run holds no outbound records — see the tooltip`

with the tooltip naming the mechanism, the file, and where those records live.
`commsCensus` reads the same `readComms` validator the cards do, so the count and
the cards cannot disagree — asserted at 124/0 against 124 rendered cards. A
two-way thread gets no caveat, just `N received · M sent`.

---

## Hover non-regression (NFU2 / DoD 3)

Finding 2 touched every row's render path, so the sweep was re-run three times
on the 167-row tree — `docs/plan/artifacts/phase500/team-hover.cjs`, 75
crossings per 10s window, React commit counting + a rect-by-rect layout check:

| run | idle commits | hover commits | attributable to hover | layout shift |
|---|---|---|---|---|
| 1 | 12 | 14 | 2 | none |
| 2 | 14 | 14 | **0** | none |
| 3 | 14 | 14 | **0** | none |

Run 1's outlier is the instrument, not the panel: its *idle* window recorded 12
where both other windows in every run recorded 14 — a 6s team poll landing
outside the idle window. Zero layout shift in all three, which is the claim the
markup makes (controls always mounted, revealed by CSS).

Arming, separately, moves nothing either: the ✕'s rect is byte-identical before
and while armed (§2).

## Both themes (NFU1)

`12-theme-dark.png` / `12-theme-light.png`, each with a row ARMED so one frame
carries the switcher, the comms ledger and the confirm strip. Sampled pixels:
dark `rgb(0,0,0)`, light `rgb(247,247,245)`; computed `body` colours
`rgb(237,237,238)` / `rgb(23,23,26)`. Zero literal colours added — the
repo-wide gate (`scripts/checks/no-raw-colours.cjs`) passes with 0 unlisted.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (forge-control-web) | clean |
| `npx tsc --noEmit` (forge-control) | clean |
| `npm run build` (forge-control-web) | ✓ Compiled successfully |
| `check-r1873-fixes.ts` | ALL PASS (66) |
| `check-team-confirm.ts` | ALL PASS |
| `check-team-rows.ts` | ALL PASS |
| `check-nav-stack.ts` | ALL PASS |
| `no-raw-colours.cjs` | PASS, 0 unlisted |
| `verify-1873.cjs` (browser) | ALL PASS (50) |

`POST /api/agents/dismissals/restore` was exercised directly against the
worktree router: `{"ids":[]}` → 400, non-array → 400, non-string entry → 400,
2001 entries → 400, malformed JSON → 400, unknown id → `200 {"restored":[]}`,
and a two-id round trip that inserted and then removed two synthetic ids.

## Footprint, stated rather than buried

1. **Two synthetic dismissals were written to the live `ui_dismissals` and
   deleted in the same second** (`r1873-probe-alpha`, `-beta`) to prove the new
   bulk-restore route actually deletes. Neither id matches any node in the
   fleet, so no row was hidden from anyone. The table is back to 0 rows.
2. **The verification script cancelled Konrad's operator chat run, and it was
   repaired.** On its second execution the manager row had gone from settled to
   RUNNING (this chat is alive while the project works), so the ✕ the confirm
   test drives was no longer a dismissal but a **terminate** — and
   `capabilities.terminate` has been true since round 1353. The script stubbed
   the dismissal endpoints but not the run-control ones. `bfd1283a` went
   `cancelled` at 14:08:58; `POST /api/runs/:id/resume-chat` reopened the same
   run in place at 14:10:45 with a message explaining it. Transcript intact
   (1,454 entries), no other state touched.

   The script is now hardened twice over: `stubRunControlWrites` intercepts
   **every** non-GET to `/api/proxy/runs/**`, and the confirm is only ever driven
   on a row whose `data-settled="true"`. The general lesson, recorded because it
   generalises past this round: a test that drives a destructive control must
   intercept every verb that control can reach, not the one it expects — a
   capability flag or a status change turns the same markup into a different
   weapon.
