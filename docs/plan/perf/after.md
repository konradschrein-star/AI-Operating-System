# Hover performance — AFTER (R14): the whole series, and the gate verdict

**Round 1292. Retrospective write-up. No application code was changed, no server
was started, no browser was run.** Every cell is read out of a committed artifact.
Where an instrument did not measure a column, the cell reads **`not measured`** —
never blank, never inferred, never silently zero.

Companions: `docs/plan/perf/baseline.md` (R12 — the before numbers, the instrument,
and the protocol gap), `docs/plan/perf/findings.md` (R13 — the named mechanism).

---

## 1. The series, one row per measurement

Reading notes, because three of these columns mean different things than they look
like:

- **"attributable"** is always `hover window − idle window`, measured over two
  windows of the same length in the same page session. The app polls on its own;
  the subtraction is what removes the poll. Negative values are real and are
  printed as measured — they mean the swept window contained *fewer* events than
  the parked-pointer window.
- **Commits** were only counted by the phase 400/500/700 instrument family.
  **Long tasks** were only counted from phase 900 onward. Nothing measured both.
  See `docs/plan/perf/baseline.md` §3.
- **`max long task ms`** is the largest long task in the **hover** window. It is
  not attributable on its own — read it against the idle floor in §2.

| phase / round | surface | build | rows | crossings | window ms | commits attr. to hover | mutations attr. | long tasks >50 ms attr. | max long task ms (hover) | source file |
|---|---|---|---|---|---|---|---|---|---|---|
| **400 — BEFORE** | chat rail | `main`, `next start` of `/opt/forge-ai-os` build | 7 | 76 | 10 000 | **77** | **1 057** | not measured | not measured | `docs/plan/artifacts/phase400/hover-cost-before.json` |
| 400 — after | chat rail | phase-400 worktree | 7 | 76 | 10 000 | **1** | **0** | not measured | not measured | `docs/plan/artifacts/phase400/hover-cost-after.json` |
| 400 — after, run 2 | chat rail | phase-400 worktree | 7 | 76 | 10 000 | **1** | **0** | not measured | not measured | `docs/plan/artifacts/phase400/hover-cost-after-run2.json` |
| 500 — round 504 | chat rail | round-504 worktree | 7 | 74 | 10 000 | **0** | **0** | not measured | not measured | `docs/plan/artifacts/phase500/rail-hover-round504.json` |
| 500 — round 504 | team panel | round-504 worktree | 20 | 75 | 10 000 | **0** | **0** | not measured | not measured | `docs/plan/artifacts/phase500/team-hover-after.json` |
| 600 — round 604 | chat rail | round-604 worktree | 7 | 76 | 10 000 | **0** | **0** | not measured | not measured | `docs/plan/artifacts/phase600/rail-hover-round604.json` |
| 600 — round 604 | team panel | round-604 worktree | 20 | 75 | 10 000 | **0** | **0** | not measured | not measured | `docs/plan/artifacts/phase600/team-hover-round604.json` |
| 700 — gated sweep | chat surface (team rows + phase cards + task chips), 34 targets on screen | round-700 worktree | 34 targets | 100 | 10 009 | **0** (`commits_unattributed: 0` of 11 total) | **0** (`dom_mutations_other`) | not measured | not measured | `docs/plan/artifacts/phase700/hover-700.json` |
| 700 — coverage sweep | same, every hoverable target incl. off-screen (census 165) | round-700 worktree | 165 targets | 131 | 7 884 | **0** (`commits_unattributed: 0` of 10 total) | **0** | not measured | not measured | `docs/plan/artifacts/phase700/hover-700.json` |
| **900 — run 1, PRODUCTION** | chat rail | production `https://os.schreinercontentsystems.com` | 6 | 150 | 10 039 | not measured | **0** | **−1** | 0 | `docs/plan/artifacts/phase900/hover-904.json` |
| **900 — run 1, PRODUCTION** | team panel | production | 26 | 150 | 10 047 | not measured | **−1** | **+1** | 61 | `docs/plan/artifacts/phase900/hover-904.json` |
| **900 — run 2, PRODUCTION** | chat rail | production | 6 | 150 | 10 060 | not measured | **0** | **−1** | 0 | `docs/plan/artifacts/phase900/hover-904.json` |
| **900 — run 2, PRODUCTION** | team panel | production | 26 | 150 | 10 051 | not measured | **+1** | **0** | 56 | `docs/plan/artifacts/phase900/hover-904.json` |
| 1290 / r1291 — run 1, pair 1 | chat rail | worktree `8d6a597`, `:7790` → API `:7798` | 7 | 149 | 10 000 | not measured | **−2** | **−1** | 0 | `docs/plan/artifacts/phase1290/hover/hover-1291.json` |
| 1290 / r1291 — run 1, pair 2 | chat rail | same | 7 | 149 | 10 000 | not measured | **−2** | **0** | 61 | same |
| 1290 / r1291 — run 1, pair 3 | chat rail | same | 7 | 149 | 10 000 | not measured | **+10** | **0** | 51 | same |
| 1290 / r1291 — run 1, pair 4 | chat rail | same | 7 | 150 | 10 000 | not measured | **−2** | **+1** | 52 | same |
| 1290 / r1291 — run 1, pair 5 | chat rail | same | 7 | 150 | 10 000 | not measured | **−2** | **−1** | 0 | same |
| 1290 / r1291 — run 2, pair 1 | chat rail | same | 7 | 150 | 10 000 | not measured | **−6** | **−2** | 0 | same |
| 1290 / r1291 — run 2, pair 2 | chat rail | same | 7 | 149 | 10 000 | not measured | **+2** | **−1** | 0 | same |
| 1290 / r1291 — run 2, pair 3 | chat rail | same | 7 | 149 | 10 000 | not measured | **+3** | **+1** | 50 | same |
| 1290 / r1291 — run 2, pair 4 | chat rail | same | 7 | 150 | 10 000 | not measured | **−7** | **0** | 55 | same |
| 1290 / r1291 — run 2, pair 5 | chat rail | same | 7 | 150 | 10 000 | not measured | **+1** | **−1** | 52 | same |
| 1290 / r1291 — run 1, pair 1 | team panel | same | 21 | 149 | 10 000 | not measured | **−16** | **−1** | 0 | same |
| 1290 / r1291 — run 1, pair 2 | team panel | same | 21 | 149 | 10 000 | not measured | **+2** | **0** | 0 | same |
| 1290 / r1291 — run 1, pair 3 | team panel | same | 21 | 150 | 10 000 | not measured | **−3** | **−2** | 0 | same |
| 1290 / r1291 — run 1, pair 4 | team panel | same | 21 | 150 | 10 000 | not measured | **−12** | **0** | 51 | same |
| 1290 / r1291 — run 1, pair 5 | team panel | same | 21 | 149 | 10 000 | not measured | **−1** | **+1** | 51 | same |
| 1290 / r1291 — run 2, pair 1 | team panel | same | 21 | 149 | 10 000 | not measured | **−6** | **0** | 54 | same |
| 1290 / r1291 — run 2, pair 2 | team panel | same | 21 | 149 | 10 000 | not measured | **0** | **−1** | 0 | same |
| 1290 / r1291 — run 2, pair 3 | team panel | same | 21 | 150 | 10 000 | not measured | **−1** | **0** | 0 | same |
| 1290 / r1291 — run 2, pair 4 | team panel | same | 21 | 150 | 10 000 | not measured | **−3** | **+1** | 55 | same |
| 1290 / r1291 — run 2, pair 5 | team panel | same | 21 | 149 | 10 000 | not measured | **+1** | **+1** | 55 | same |

### 1.1 Medians and pooled totals for the round-1291 block

| | run 1 rail | run 2 rail | run 1 team | run 2 team |
|---|---|---|---|---|
| median attributable long tasks > 50 ms over 5 pairs | **0** | **−1** | **0** | **0** |
| idle long tasks, 5 pairs = 50 s parked pointer | 4 | 6 | 4 | 2 |
| hover long tasks, 5 pairs = 50 s sweeping | 3 | 3 | 2 | 3 |
| crossings, 5 pairs | 747 | 748 | 747 | 747 |

**Pooled over both runs: rail 10 idle vs 6 hover long tasks; team 6 idle vs 5.**
Sweeping the pointer across every row roughly fifteen times a second for a hundred
seconds produced **fewer** long tasks than sitting still did.

### 1.2 Two rows in the table that look like discrepancies and are not

- **Phase 900 measured 26 team rows; round 1291 measured 21.** That is a fidelity
  fix, not a shortfall. The panel mounts 102 `[data-team-row]` elements for this
  chat (1 manager + 95 workers + 6 sub-agents), of which only 21 fit fully inside a
  1000 px viewport at 43 px per row. `hover-904.cjs:158` took `.slice(0, 26)` of the
  *unfiltered* list, so roughly five of its twenty-six targets were below the fold
  and those pointer moves could not land on a row. Round 1291 filters to
  `top >= 0 && bottom <= innerHeight` before sweeping and re-reads the boxes before
  every pair, because the panel is live.
- **Round 1291's mutation deltas swing negative and positive.** They are noise
  around a true zero. The mutations that occur are the poll's, and whether one or
  two polls land inside a given 10 s window is a coin flip — see §4.

---

## 2. The idle floor — make it visible before reading any hover number

This machine emits 50–60 ms long tasks **with the pointer parked and nothing
hovering at all.** Any `>50 ms` figure in a hover window has to be read against
this, or it will be misread as a hover defect.

**Phase 900, production, parked-pointer idle windows:**

```
$ python3 -c "import json; d=json.load(open('docs/plan/artifacts/phase900/hover-904.json'))
for r in ('run1','run2'):
  for s in ('rail','team'):
    x=d[r]['surfaces'][s]
    print(r,s,'idle',x['idle']['longTasks'],x['idle']['maxLongTaskMs'],'| hover',x['hover']['longTasks'],x['hover']['maxLongTaskMs'],'| attr',x['attributable']['longTasks'])"
run1 rail idle 1 52 | hover 0 0 | attr -1
run1 team idle 0 0  | hover 1 61 | attr 1
run2 rail idle 1 50 | hover 0 0 | attr -1
run2 team idle 1 59 | hover 1 56 | attr 0
```

**Three of the four idle windows carried a long task, at 52 ms, 50 ms and 59 ms.**
The single 61 ms task in run1's team hover window — the "residual" that phase 900
could not clear — is the same size as the tasks the floor produces unprovoked. Two
windows cannot separate a signal from a floor that busy.

**Round 1291's idle floor, ten windows per surface:**

| | run 1 idle max long task ms, per pair | run 2 idle max long task ms, per pair |
|---|---|---|
| rail | 58, 63, 55, — , 55 | 59, 52, — , 59, 56 |
| team | 51, — , 59, 53, — | 51, 51, — , — , — |

(`—` = no long task in that idle window.)

### 2.1 The floor has a name, and the gate requires it be named

`03-quality.md` §4 clause (a) says *"GC and unrelated poll work must be called out
explicitly if present."* It is present, and round 1291 identified it rather than
leaving it as noise:

**The floor is the team panel's own 6 s poll landing.** Three independent lines of
evidence, from `docs/plan/artifacts/phase1290/hover/hover-1291.json`:

1. **The long tasks form a lattice.** Every inter-task gap across a whole run is an
   integer multiple of one base period — run 1: **6 294.6 ms**, worst residual
   0.7 % of the period; run 2: **6 283.4 ms**, worst residual 2.0 %. `fits: true`
   in both. Hover handling does not produce a lattice.
2. **It is the page, not the machine.** The control run observed `about:blank` for
   10 s in the same browser on the same VPS: **0 long tasks, `ScriptDuration` delta
   0 ms.**
3. **It is the team poll specifically.** With the pointer never moved, over 30 s:
   3 long tasks (51, 55, 66 ms), 5 `/team` polls at intervals of 6 291.6 / 6 301.3 /
   6 285.2 / 6 288.8 ms, and the gap from each poll's `responseEnd` to the long
   task's `startTime` was **2.1 / 2.3 / 2.2 ms**.

```
$ python3 -c "import json; d=json.load(open('docs/plan/artifacts/phase1290/hover/hover-1291.json')); print(d['runs']['control']['control']['app']['gapFromPollResponseEndMs']['values'])"
[2.1, 2.3, 2.2]
```

`6000 + ~290 ms fetch ≈ 6 290` is the period the cadence fit found blind.
`TEAM_POLL_MS = 6_000` at `forge-control-web/app/desktop/team/ChatTeamPanel.tsx:91`;
React Query reschedules after the fetch resolves, which is why the period is 6 290
and not 6 000. The work is the payload: 102 rows, 61 377 bytes, re-parsed and
reconciled into the tree every six seconds.

**GC:** no long task in any run is attributed to a container other than the window,
and none appears outside the 6.29 s lattice. There is no separate GC population to
call out.

**One field that must not be over-read:** `crossingsInsideTask` is 0 for every long
task. That is **not** evidence. A crossing's timestamp is stamped when
`page.mouse.move` resolves; if the main thread is blocked, the CDP round-trip
resolves only after the block clears, so the counter is biased toward zero by
construction. The load-bearing evidence is the idle floor and the poll alignment.

---

## 3. Gate verdict — `docs/plan/operator-visibility/03-quality.md` §4, clause by clause

| Clause | Verdict | Evidence |
|---|---|---|
| **(a)** zero tasks > 50 ms during the sweep window that the trace attributes to script/hover handling; GC and unrelated poll work called out explicitly if present | **PASS** | Round 1291, 5 interleaved idle/hover pairs per surface, run twice: median attributable long tasks **0 (team run1), 0 (team run2), 0 (rail run1), −1 (rail run2)**. Pooled, sweeping produced fewer long tasks than parking (rail 6 vs 10, team 5 vs 6). Phase 900's two production runs alongside: −1, +1, −1, 0 — a single +1 at 61 ms against an idle floor emitting 50–59 ms tasks unprovoked. The unrelated poll work is called out and named in §2.1: `TEAM_POLL_MS`. No GC population exists to call out. |
| **(b)** total scripting ms reduced ≥ 50 % vs baseline, if baseline ≥ 120 ms | **NOT VERIFIABLE AS WRITTEN** | **The baseline number does not exist.** No instrument measured scripting ms until round 1291, which ran after the fix — see `docs/plan/perf/baseline.md` §3 for the per-instrument table and the counting command that proves it. A reduction cannot be computed against a baseline that was never captured. See §3.1 for what *is* measured, offered in its place and explicitly not as a pass. |
| **R15** — no behaviour regression: chat rail still selects on click, shows the ✕ on hover, marks the selected row, updates status dots live; side-panel task list still opens runs | **PASS — CLOSED, round 1303, all four assertions driven on the post-fix build** | See §3.2. Artifacts: `docs/plan/artifacts/phase1300/r15/` (`README.md` indexes them). |
| **Honesty rule** — no cadence slowing to pass the gate | **PASS** | §3.3. |
| **Honesty rule** — no hover affordance removed to pass (the ✕ must survive, R15) | **PASS** | §3.3. |
| **Honesty rule** — traces committed raw | **PASS, with a caveat about what "trace" means here** | §3.3. |
| **Honesty rule** — if runs disagree > 2× spread, note VPS load and re-run rather than cherry-picking | **PASS — rule triggered, disclosed, obeyed** | §4. |

### 3.1 Clause (b): what is measured, in place of the number the gate asks for

**This section does not claim a pass.** It offers the strongest evidence that
actually exists, correctly labelled.

**(i) The commit and mutation collapse — this IS a measured pass, and it is phase
400's.** On the surface Konrad complained about, same protocol, same script, same
browser, two builds:

| chat rail, 10 s, 76 crossings, 7 rows | react commits attr. to hover | DOM mutations attr. |
|---|---|---|
| phase 400 `before` (`main`'s build) | **77** | **1 057** |
| phase 400 `after` (worktree build) | **1** | **0** |
| phase 400 `after`, run 2 | **1** | **0** |
| re-run on the round-504 build | **0** | **0** |
| re-run on the round-604 build | **0** | **0** |

That is a 77 → ~0 collapse in React commits and a 1 057 → 0 collapse in DOM
mutations, reproduced across three subsequent rounds. It is not a scripting-ms
figure and it is not clause (b), but it is the load-bearing before/after result of
this project and it is measured on both sides.

**(ii) Round 1291's `ScriptDuration` deltas — a Chrome renderer-wide aggregate, NOT
a trace attribution.** `Performance.getMetrics` deltas around each window, in ms,
median of 5 pairs:

| | run 1 idle | run 1 hover | run 2 idle | run 2 hover |
|---|---|---|---|---|
| rail | 151.1 | 185.0 | 163.5 | 166.5 |
| team | 146.2 | 201.1 | 134.4 | 222.2 |

Median per-pair `hover − idle`: rail **+73.4 / +3.0 ms**, team **+59.9 / +65.7 ms**
per 10 s window.

**Read the label before the number.** These are Chrome's renderer-wide cumulative
counters. They include the 6 s team poll, React, browser internals and GC, and they
**cannot separate hover handling from any of it.** The instrument repeats this
label on every record it writes. Read against what produced it — ~150 crossings in
ten seconds is fifteen rows per second of continuous sweeping, far past any human
hovering rate — the added scripting is under 1 % of the main thread over the window
and forms no task longer than 50 ms. It is real, it is small, and it is bounded.
**It is offered as context, never as a gate pass**, and it has no pre-fix
counterpart to be compared against.

### 3.2 R15 — no behaviour regression

**CLOSED, round 1303.** All four assertions this section previously marked OPEN
were driven in a real browser against the **post-fix build**
(`92aeb0ff953efca5f67bc9d6146c5d2db3b95a9b` — worktree HEAD after round 1302),
one committed artifact per assertion, every screenshot in both themes, viewport
1440×900. Round 1303 changed no application code. The harness and its index live
in `docs/plan/artifacts/phase1300/r15/` (`README.md`, `r15-clickthrough.cjs`).

| Assertion (`01-requirements.md`, requirement **R15**) | Verdict | Evidence |
|---|---|---|
| row click **SELECTS** | **PASS** | `phase1300/r15/a1-select.json` — the open chat moved `bfd1283a…` → `e178d084…`, observed on the two requests keyed on `selId` (`GET /api/proxy/chat/:id/team`, which `SidePanel` fires for `chatId={selId}`, and the `["chat","run",selId]` detail fetch). Screenshots `a1-select-{light,dark}.png`. |
| the selected row is **MARKED** | **PASS** | `phase1300/r15/a2-marked.json` — computed styles before/after on every row. Clicked row: `border-left-color` `rgba(0,0,0,0)` → `rgb(87,160,107)`, background → `rgb(16,16,19)` (`tokens.selectedBg`), title `rgb(202,202,208)` (`textLabel`) → `rgb(237,237,238)` (`text`). Marked rows `[0]` → `[1]`: **exactly one**, and it is the clicked row. A transparent border is still 2 px wide, so the check requires the border to be *painted*. Screenshots `a2-marked-{light,dark}.png`. |
| status dots are **LIVE** | **PASS** | `phase1300/r15/a3-live-transition.json` — a **real** transition, sampled at 2 s: row 0 `completed → running` at +28.1 s (dot `rgb(87,160,107)` → `rgb(91,141,239)`, `animation: none` → **`pulse`**) and back at +39.5 s. Colour tracked the status text in every sample; no settled row ever pulsed. The transition was produced by posting round 1303's required manager report through the app's own `POST /api/runs/:id/message` — **nothing was written to the `runs` table by hand**. `a3-dots.json` holds the static pass (7 rail rows, all settled, 3 rail polls in a 23 s window) and the 112-row side-panel corroboration of the running/settled split. Screenshots `a3-live-running-{light,dark}.png`, `a3-dots-{light,dark}.png`. |
| the side panel **OPENS the run** — worker path | **PASS** | `phase1300/r15/a4-open-worker.json` — clicking `[data-team-row][data-kind="worker"]` navigated the middle surface to `data-agent-chat-view` with `data-run-id=3853c154…`, `data-subagent-id=""`. Screenshots `a4-open-worker-{light,dark}.png`. |
| …and the **sub-agent** path | **PASS** | `phase1300/r15/a4-open-subagent.json` — the other branch of `onOpenNode`: a sub-agent's id is a `tool_use_id`, so it resolves to its parent's run *sliced*. Opened `data-run-id=3853c154…`, `data-subagent-id=toolu_014raMUrJcAiXV61BerokrjN`. Screenshots `a4-open-subagent-{light,dark}.png`. |

**The windowing regression the brief flagged does not exist:** round 1302 did not
ship windowing (commit `92aeb0f`, L3 — it would have removed the keyboard-reachable
✕ from every row outside the visible slice, which R15 protects). All 112 team rows
are in the DOM; the A4 artifacts record `team_rows_in_dom`.

**Already evidenced before round 1303 (the affordance survived the perf fix):**

| Claim | Evidence |
|---|---|
| the ✕ is still revealed on hover | `docs/plan/artifacts/phase400/rail-hover-dark.png` — the ✕ revealed on row 2 |
| revealing it moves nothing | `docs/plan/artifacts/phase400/rail-shot.cjs` lines 88–121: reads every row's `getBoundingClientRect()` before and during hover, compares `JSON.stringify`, prints `no reflow on hover: row geometry identical` and exits non-zero otherwise |
| the ✕ is still reachable without a pointer | `forge-control-web/app/globals.css:102,106` — `:focus-within` alongside every `:hover` |
| team-panel controls are inert until deliberately used | `docs/plan/artifacts/phase500/control-inert.json` — `verdict: "PASS"` |
| dismissal persists | `docs/plan/artifacts/phase500/dismiss-persist.json` — `verdict: "PASS"` |

**What was OPEN until round 1303, kept for history:** the *full* R15 click-through
as `01-requirements.md`, requirement **R15**, words it — "selects on click, marks
selected row, updates status dots live; side-panel task list still opens runs" —
had **no committed artifact in this corpus that exercised it**. The five rows above
cover the ✕ affordance and the panel controls; they never covered selection
marking, live status dots, or the side-panel task list opening runs.
`docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md` §5 listed
"Re-verify R15 click-through" as something phase 1300 MAY do; round 1303 did it,
and the table at the top of this section is the result.

> **Citation convention, adopted round 1303 — cite by identity, not by position.**
> The paragraph above used to read `01-requirements.md:75`. Round 1301 inserted the
> clause-(b)-retirement cross-reference under R14 and R15's heading moved to :76,
> so a citation written that same day was already wrong. Requirements are cited by
> their id ("`01-requirements.md`, requirement **R15**") and sections by heading
> from here on. Line numbers are for *code*, where a commit SHA pins them. Convert
> what you touch; do not sweep the corpus.

**Two statements elsewhere in this file are now stale and round 1303 was not
permitted to fix them** — same situation §6.3 already records for a different line,
and the same remedy: name them here rather than reach outside the allowed edit.
(i) §5 item 3, "R15's full click-through is unverified in one pass", is false as of
this round — §3.2 above is that pass. (ii) §6.1's path list predates
`docs/plan/artifacts/phase1300/r15/`; the six paths this section newly cites all
resolve, verified with §6.1's own extraction loop, but they are not yet in its
table. Whoever next holds §5 and §6 should close both.

### 3.3 The honesty rules, with the greps that prove them

**No cadence was slowed.** `TEAM_POLL_MS` is still `6_000`:

```
$ grep -rn "TEAM_POLL_MS" forge-control-web/app/desktop/team/ChatTeamPanel.tsx
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:91:const TEAM_POLL_MS = 6_000;
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:164:    refetchInterval: TEAM_POLL_MS,
```

Round 1291 *identified* this poll as the source of every > 50 ms task on the
surface and deliberately left it alone, because `ChatTeamPanel.tsx:86-90` records
that 6 s was already chosen against a committed 40 req/min ceiling, and §4's
honesty rule forbids buying a number with cadence. The full `refetchInterval`
census across `forge-control-web/app` is pasted in `docs/plan/perf/findings.md` §5.1.

**No hover affordance was removed.** The ✕ and the age stamp both still exist and
both are still revealed — the fix mounts *more* DOM, not less, and adds
`:focus-within` reachability that the `useState` version did not have. See
`forge-control-web/app/globals.css:94-108`, quoted in full in
`docs/plan/perf/findings.md` §2.

**Traces committed raw — with the caveat this deserves.** Every measurement JSON in
the series is committed unfiltered, including round 1291's 252 KB output with all
three runs (`runs.run1`, `runs.run2`, `runs.control`) and no cherry-picking.
**But** `03-quality.md` §4 asked for Chrome trace files (`trace-<label>-<n>.json`,
loadable in `chrome://tracing`), and those do not exist for any hover round — the
instrument family never produced them. R12's verification criterion "trace loadable
in Chrome DevTools" is therefore **not satisfiable** for this corpus. That is the
same protocol gap `docs/plan/perf/baseline.md` §3 records, showing up in a second
place.

---

## 4. The > 2× spread rule: triggered, disclosed, re-run, and explained

The rule fired — on the idle `ScriptDuration` aggregate, in all four
surface × run cells:

| | run 1 idle spread | run 2 idle spread |
|---|---|---|
| rail | **2.01×** | **2.47×** |
| team | **2.69×** | **2.89×** |

Long-task counts did not exceed 2× anywhere (ratio 1.0 in all four cells), and
hover `ScriptDuration` did not either (1.44–1.66×).

**Load was recorded**, as §4 requires: 16 CPUs, 1-minute load average 1.89 → 3.26
across run 1 and 1.97 → 3.04 across run 2, captured per pair in
`runs.<label>.surfaces.<s>.pairs[].osBefore/osAfter`.

**The re-run happened and nothing was dropped.** Both 5-pair runs are committed in
full; run 2 is the mandated re-run. They agree on every conclusion.

**And the spread has a mechanism, not merely a load excuse.** Sorted idle
`ScriptDuration` is bimodal — a low cluster near 60–110 ms and a high cluster near
135–195 ms, in a ratio of about two. A 10 s window divided by a 6.29 s poll period
is 1.59, so a window contains **either one poll landing or two**, never a stable
number. The 2× spread *is* that quantization. It would not shrink by re-running a
third time; it would shrink by making the window an integer multiple of the poll
period.

---

## 5. What remains open

1. **Mechanism B is a recommendation, not a fix.** `forge-control-web/app/v2.css:291`
   (`.v2-nav-item:hover:not(.v2-nav-active) span`) puts a bare `span` in the
   document-wide hover invalidation set, roughly doubling per-crossing style
   invalidation on `.chat-row` and `.team-row` (1 340 → 720 records over 30
   crossings from deleting that one rule). **Not applied** — round 1291 was
   forbidden from touching application code. Phase 1300 owns the decision. It is
   **not** established that this is what Konrad feels as hover lag; record counts
   are not milliseconds.
2. **Gate clause (b) is unmeasurable as written.** Either re-baseline with
   `Performance.getMetrics` on a pinned pre-fix commit, or amend
   `docs/plan/operator-visibility/03-quality.md` §4 to retire clause (b) and record
   the commit/mutation collapse as the standing evidence. Leaving it as an open gate
   no round can pass is the worst of the three.
3. **R15's full click-through is unverified in one pass** — see §3.2.
4. **The measurement window should be an integer multiple of the poll period.** A
   12.6 s or 25.2 s window would make `ScriptDuration` comparisons stable enough to
   be worth quoting. Note for whoever writes the next instrument.
5. **The team poll's own cost is identified and untouched**: 102 rows / 61 KB
   re-parsed every 6 s is the only source of > 50 ms tasks on this surface. Round
   1291's suggested levers, in order of least user cost: stop re-materialising
   settled rows; trim the payload server-side; window the list (only 21 of 102 rows
   fit on screen). **Do not slow the poll.**
6. **Nobody has checked whether anything else in the app writes `<html lang>`.**
   Only Excalidraw's write was traced. If a theme or locale toggle also writes it,
   it pays the same ~6 000 invalidation records.
7. **U31 — canvas first-open cost — is CLOSED AS ACCEPTED at ~190 ms**, by Konrad's
   binding operator decision of 2026-08-17 (commit `e8df4e6`,
   `docs/plan/operator-visibility/15-ui-v3-phases.md`, mirrored in
   `docs/plan/artifacts/phase800/README.md` §4). **It is not "met" and not
   "achieved."** No measurement exists after the decision and none is owed. Option
   (d) accept was chosen; options (a) keep-mounted and (c) shrink-the-document are
   CLOSED and may not be proposed, planned or undertaken. Canvas first-open is a
   **note**, not a finding, and reviewers must not raise it. It appears in this list
   only so a reader in three months knows it was decided rather than forgotten.

---

## 6. Provenance

### 6.1 Every cited `docs/plan` path resolves

```
$ grep -ohE 'docs/plan/[A-Za-z0-9._/-]+' docs/plan/perf/*.md | sort -u | while read p; do [ -e "$p" ] || echo "MISSING: $p"; done
```
→ *(no output — every path cited across all three perf documents resolves)*

### 6.2 Three numbers spot-proved from the raw JSON

**(1) The BEFORE, from `docs/plan/artifacts/phase400/hover-cost-before.json`:**

```
$ python3 -c "import json; d=json.load(open('docs/plan/artifacts/phase400/hover-cost-before.json')); print(d['attributable_to_hover'], d['crossings'], d['rows_on_screen'], d['window_ms'])"
{'commits': 77, 'mutations': 1057} 76 7 10000
```

**(2) The production idle floor, from `docs/plan/artifacts/phase900/hover-904.json`** —
the full four-cell output is pasted in §2 above; the headline is that three of four
idle windows carried a 50–59 ms long task with the pointer parked.

**(3) Round 1291's medians and poll alignment, from `docs/plan/artifacts/phase1290/hover/hover-1291.json`:**

```
$ python3 -c "import json; d=json.load(open('docs/plan/artifacts/phase1290/hover/hover-1291.json'))
print([d['runs'][r]['surfaces']['team']['summary']['medianAttributableLongTasks'] for r in ('run1','run2')])
print([d['runs'][r]['surfaces']['rail']['summary']['medianAttributableLongTasks'] for r in ('run1','run2')])
print(d['runs']['control']['control']['app']['gapFromPollResponseEndMs']['values'])"
[0, 0]
[0, -1]
[2.1, 2.3, 2.2]
```

### 6.3 One stale statement this round was not permitted to fix

`docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md` §7 lists
`docs/plan/perf`, `docs/plan/perf/baseline.md`, `docs/plan/perf/findings.md` and
`docs/plan/perf/after.md` as `MISSING:` lines, correctly labelled there as
*"forward references, expected to be missing."* **As of this round they exist**, so
that provenance block's output is now stale. Round 1292's brief permits editing
exactly one placeholder line in that file (§6), so §7 was left untouched rather
than quietly rewritten. Flagged here for the reviewer.

### 6.4 Sources read for these three documents

- `docs/plan/artifacts/phase400/hover-cost-before.json`, `hover-cost-after.json`, `hover-cost-after-run2.json`, `hover-cost.cjs`, `rail-shot.cjs`, `rail-hover-dark.png`, `README.md`
- `docs/plan/artifacts/phase500/team-hover-after.json`, `rail-hover-round504.json`, `team-hover.cjs`, `control-inert.json`, `dismiss-persist.json`, `README.md`
- `docs/plan/artifacts/phase600/rail-hover-round604.json`, `team-hover-round604.json`
- `docs/plan/artifacts/phase700/hover-700.json`, `hover-700.cjs`
- `docs/plan/artifacts/phase900/hover-904.json`, `hover-904.cjs`, `corpus-relocation.md`
- `docs/plan/artifacts/phase800/canvas-perf.md` (§9.6, §9.7, §9.8)
- `docs/plan/artifacts/phase1290/hover/hover-1291.json`, `hover-1291.cjs`, `README.md`
- `docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.json`, `README.md`
- `docs/plan/operator-visibility/01-requirements.md`, `02-architecture.md`, `03-quality.md`, `04-phases.md`
- `docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md`
- `forge-control-web/app/globals.css`, `app/v2.css`, `app/desktop/team/ChatTeamPanel.tsx`, `app/desktop/team/`

This document changed no application code, started no server, and ran no browser.
