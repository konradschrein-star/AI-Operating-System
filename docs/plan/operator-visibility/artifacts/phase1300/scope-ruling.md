# Phase 1300 — scope ruling (round 1291)

**Read this before planning phase 1300.** It says what the phase may and may not do.

*On this file's path:* the r901 relocation ruling (`docs/plan/artifacts/phase900/corpus-relocation.md` §3) keeps `docs/plan/artifacts/**` **flat**, and that stands — nothing is moved by this document. This one file is deliberately namespaced under `docs/plan/operator-visibility/artifacts/phase1300/` because the steward named that exact path and because phase 1300's planner reads the per-project corpus.

---

## 1. The ruling

Phase 1300 **MUST NOT** undertake "shrink the `/desktop` document" — virtualising, capping, windowing or paginating the chat transcript — on its own authority. The rewritten brief that calls 1300 "the ROOT-CAUSE phase: shrink the /desktop document" over-scopes the work on the evidence in hand: the panel's hover numbers are already effectively clean across seven committed measurement rounds, the one unexplained lead is a *selector* question (§9.7), and the transcript restructure is an architecture decision that has since been answered by Konrad — against it (§4).

---

## 2. DoD #3 is close to met, and nobody has written it up

The project DoD demands recorded before/after hover numbers. The corpus demands them in three specific files — `docs/plan/perf/baseline.md` (`docs/plan/operator-visibility/01-requirements.md:64`, `04-phases.md:54`), `docs/plan/perf/findings.md` (`01-requirements.md:68`, `04-phases.md:55`), `docs/plan/perf/after.md` (`01-requirements.md:72`, `04-phases.md:57`). **None of the three exists.** Verified:

```
$ ls docs/plan/perf
ls: cannot access 'docs/plan/perf': No such file or directory
```

The measurements themselves **do exist and are committed**. Read out of the files, not copied from a brief:

| Artifact | Surface | Headline |
|---|---|---|
| `docs/plan/artifacts/phase400/hover-cost-before.json` | rail, 7 rows, 76 crossings / 10 s | **BEFORE** — `attributable_to_hover`: **77 commits, 1057 DOM mutations** |
| `docs/plan/artifacts/phase400/hover-cost-after.json` | same protocol | `attributable_to_hover`: **1 commit, 0 mutations** |
| `docs/plan/artifacts/phase400/hover-cost-after-run2.json` | same protocol | `attributable_to_hover`: **1 commit, 0 mutations** |
| `docs/plan/artifacts/phase500/team-hover-after.json` | team, 20 rows, 75 crossings / 10 s | **0 commits, 0 mutations**, `layout_shift: false`, `verdict: PASS` |
| `docs/plan/artifacts/phase600/rail-hover-round604.json` | rail, 7 rows, 76 crossings / 10 s | **0 commits, 0 mutations** |
| `docs/plan/artifacts/phase600/team-hover-round604.json` | team, 20 rows, 75 crossings / 10 s | **0 commits, 0 mutations**, `layout_shift: false`, `verdict: PASS` |
| `docs/plan/artifacts/phase700/hover-700.json` | census `team-row: 69`, `phase-card: 16`, `task-chip: 68`, `doc-link: 12` | hover window 10 009 ms: `commits_total: 11`, **`commits_unattributed: 0`**, `dom_mutations_other: 0`, `layout_shift: false` |
| `docs/plan/artifacts/phase900/hover-904.json` | **production**, two independent 10 s sweeps, 150 crossings each, parked-pointer idle baseline over the same window | see below |

`hover-904.json` in full, because the residual lives here:

- **run1 rail** (6 rows): idle `longTasks: 1` @ `maxLongTaskMs: 52`; hover `longTasks: 0`. `attributable.longTasks: -1`.
- **run1 team** (26 rows): idle `longTasks: 0`; hover `longTasks: 1` @ `maxLongTaskMs: 61`. **`attributable.longTasks: 1`.**
- **run2 rail** (6 rows): idle `longTasks: 1` @ `50`; hover `longTasks: 0`. `attributable.longTasks: -1`.
- **run2 team** (26 rows): idle `longTasks: 1` @ **59**; hover `longTasks: 1` @ `56`. **`attributable.longTasks: 0`.**

**State the residual honestly.** It is **one long task, in one run out of two, on one surface**, at 61 ms — measured against an idle floor that produced tasks of the *same size* with the pointer parked (59 ms on team run2, 52 ms and 50 ms on rail). Ambient ~50–60 ms long tasks exist on this VPS with nothing hovering at all. That is not a demonstrated hover defect; it is a signal at the noise floor.

Round 1291's sibling task is **re-running the instrument** to settle it. **Round 1292** writes `docs/plan/perf/{baseline,findings,after}.md` from these artifacts plus that re-run. Phase 1300 does **not** write them and does not re-derive the numbers — it reads the three docs.

---

## 3. The one real open lead is §9.7, not the document size

`docs/plan/artifacts/phase800/canvas-perf.md` §9.7 (lines 902–924), *"One thing this round found and did **not** explain"*:

> `StyleRecalcInvalidationTracking · PseudoClass` — **4,636 records on the cold open and 4,637 on the warm one**, against 4,716 DOM elements on the page. That is ~one per element, on **every** canvas toggle, and it is **not** font-related: it is identical when `document.fonts` is already warm and no woff2 is fetched. On `/canvas`, with 248 elements, the same toggle-equivalent produces **27**. […] it is a live lead for the panel's hover lag.
>
> **The mechanism is NOT established and is deliberately not guessed at here.**

§9.7 then names our own descendant `:hover` rules as the suspects it could not clear — `.chat-row:hover .chat-row-age`, `.team-row:hover .team-row-controls`, `.v2-nav-item:hover:not(.v2-nav-active) span` — noting that Excalidraw's 20 descendant-invalidating pseudo-class rules are all `.excalidraw`-scoped and so *should* be class-scoped rather than document-wide.

§9.8 item 3 (line 934): *"**§9.7 is the next real question** on this surface, and it is the one that touches the panel's hover requirement rather than the canvas."*

The sibling round-1291 probe task runs it. **The consequence for planning:** if one of our own rules produces a whole-document invalidation set, the fix is **a selector change**, not an architecture change.

---

## 4. The document shrink was Konrad's decision — and he has made it

`canvas-perf.md` §9.8 item 2 (line 931): *"**The decision in §9.6 is Konrad's**, not a builder's — (a) and (c) are interaction-model and architecture calls with consequences well beyond this pane."*

What option (c) actually is, per §9.6: *"Shrink `/desktop`'s document. […] Virtualising or capping the transcript would cut this proportionally."* It would be the largest single change this project has attempted; it lands in the surface Konrad reads every day; and §9.6 itself records that the transcript *"is not this phase's subject."* Its **measured** prize is bounded: §9.6 (a) shows the second open on the same page costs **24–33 ms of layout instead of 217–243 ms**, so the ~190 ms storm is **once per page load, not once per open**.

**The steward escalated §9.6 to Konrad, and Konrad answered.** Commit `e8df4e6` (2026-08-17) records it in `docs/plan/operator-visibility/15-ui-v3-phases.md` under *"OPERATOR DECISION — 2026-08-17, canvas first-open cost (binding, Konrad)"*:

> **Konrad's answer: (d) — 190 ms once per page load is acceptable.**
> - **Option (c) is CLOSED.** No transcript virtualisation, capping, or windowing may be undertaken to buy canvas-open time. […] If virtualisation is ever proposed again it needs a NEW justification and a fresh operator decision — not this one.
> - **Option (a) is CLOSED for this reason.** […]
> - **Round 1300 keeps only the hover work** […] Canvas first-open is **not a defect** and must not be re-opened as one.

`docs/plan/artifacts/phase800/README.md` §4 carries the same closure for U31: *"CLOSED 2026-08-17 by operator decision […] No AFTER is owed. […] Do not re-open it as a finding."*

So §1's ruling is no longer only steward judgement — it is a binding operator decision. Note the distinction that matters for the log: U31 is **closed as accepted**, not **met**. Nothing measured it after; nothing owes a measurement.

---

## 5. What phase 1300 MAY and MAY NOT plan

| MAY | MAY NOT |
|---|---|
| Read `docs/plan/perf/{baseline,findings,after}.md` (round 1292) and the two round-1291 probe artifacts, and **close DoD #3 on the panel's own numbers** from §2. | **Virtualise, cap, window or paginate the chat transcript** — §9.6 (c), CLOSED by operator decision. |
| Act on a **selector-level** finding from the §9.7 probe if it names one of our rules: a CSS selector change in `forge-control-web/app/globals.css` / `app/v2.css` is in scope. | **Change the canvas mount/unmount model** — §9.6 (a), CLOSED by operator decision. |
| **Re-verify R15 click-through** (`01-requirements.md:75`; protocol in `03-quality.md` §4 and the regression list at `03-quality.md:33`). | **Pre-warm Excalidraw fonts** — §9.6 (b), which §9.6 shows collapses into (a). |
| **Document §9.6 as an answered decision**, citing `15-ui-v3-phases.md` and `phase800/README.md`. | **Record U31 as "met."** It is closed-as-accepted; no AFTER exists and none is owed. |

**Default if the round-1291 probes have not landed when 1300 plans:** close DoD #3 on the items in §2 and §3, record §9.6 as answered per §4, and hand any unresolved §9.7 mechanism to a later phase with the probe output attached. Do **not** substitute an architecture change for a missing measurement. *(The brief for this ruling anticipated a Konrad-has-not-answered default; that branch is moot — `e8df4e6` answers it.)*

---

## 6. What the two round-1291 probes returned

_Pending — filled in by round 1292 once the hover re-run and the 9.7 probe have landed._

---

## 7. Provenance

Every `docs/plan/...` path cited above, proven to resolve:

```
$ grep -oE 'docs/plan/[A-Za-z0-9._/-]+' docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md \
    | sort -u | while read p; do [ -e "$p" ] || echo "MISSING: $p"; done
MISSING: docs/plan/...
MISSING: docs/plan/perf
MISSING: docs/plan/perf/
MISSING: docs/plan/perf/after.md
MISSING: docs/plan/perf/baseline.md
MISSING: docs/plan/perf/findings.md
```

Six lines, all accounted for, none of them a broken citation:

- `docs/plan/perf`, `docs/plan/perf/`, `.../after.md`, `.../baseline.md`, `.../findings.md` — **forward references, expected to be missing.** They are exactly the files §2 reports do not exist and round 1292 will create.
- `docs/plan/...` — not a path at all. It is the literal ellipsis in the sentence "Every `docs/plan/...` path cited above", caught by the extractor's character class. A grep artifact of this document's own prose.

Every real cited path resolves.

Files read and cited:

- `docs/plan/artifacts/phase400/hover-cost-before.json`, `hover-cost-after.json`, `hover-cost-after-run2.json`
- `docs/plan/artifacts/phase500/team-hover-after.json`
- `docs/plan/artifacts/phase600/rail-hover-round604.json`, `team-hover-round604.json`
- `docs/plan/artifacts/phase700/hover-700.json`
- `docs/plan/artifacts/phase900/hover-904.json`
- `docs/plan/artifacts/phase800/canvas-perf.md` (§9.6 lines 853–901, §9.7 lines 902–924, §9.8 lines 925–954) — `grep -n '^## 9\.' docs/plan/artifacts/phase800/canvas-perf.md`
- `docs/plan/artifacts/phase800/README.md` §4 — `sed -n '335,352p'`
- `docs/plan/artifacts/phase900/corpus-relocation.md` §3 (flat-artifacts ruling)
- `docs/plan/operator-visibility/15-ui-v3-phases.md` (operator decision, commit `e8df4e6` — `git show --stat e8df4e6`)
- `docs/plan/operator-visibility/01-requirements.md` (R13/R14/R15, perf-doc paths at :64/:68/:72/:75)
- `docs/plan/operator-visibility/03-quality.md` (:33, :47 — R15 protocol)
- `docs/plan/operator-visibility/04-phases.md` (:50, :54–57 — phase-3 deliverables)

This document changed no application code, started no server, and ran no browser.
