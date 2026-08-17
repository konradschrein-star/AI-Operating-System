# 05 — operator-visibility: the closing record

**Round 1864, step 4 of 4. The last builder task of the project.**
Written 2026-08-17 in the worktree `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`,
branch `project/8ea0cc08`.

This document is the thing to read in three months. It states what was measured, what was
delivered against the brief's five definition-of-done items, what is still open, and the one
lesson the project produced that transfers to any other project.

Nothing here is re-measured. Every number is copied from a committed artifact and carries the
path it came from. Where a figure does not exist, this document says so rather than
substituting an adjacent one.

Read first, in this order, if you want the evidence rather than the verdict:
`01-pre-deploy.md` (gates), `02-deploy.md` (the deploy), `03-acceptance.md` (production
acceptance by hand), `04-r19-and-pins.md` (R19 and the verifier), and `docs/plan/perf/`
(`baseline.md`, `findings.md`, `after.md`) for the hover work.

---

## 1. The hover numbers, and the floor they must be read against

### 1.1 Before and after

Konrad's words at the start were *"hovering the sidebar still lags"*. The surface he meant is
the chat rail. Same instrument, same protocol, same browser, two builds:

| chat rail — 10 000 ms window, 76 crossings, 7 rows | React commits attributable to hover | DOM mutations attributable |
|---|---|---|
| **BEFORE** — `main`'s build, pre-fix | **77** | **1 057** |
| **AFTER** — phase-400 worktree build | **1** | **0** |
| AFTER, run 2 | **1** | **0** |
| re-run on the round-504 build | **0** | **0** |
| re-run on the round-604 build | **0** | **0** |

Sources, in order: `docs/plan/artifacts/phase400/hover-cost-before.json`,
`docs/plan/artifacts/phase400/hover-cost-after.json`,
`docs/plan/artifacts/phase400/hover-cost-after-run2.json`,
`docs/plan/artifacts/phase500/rail-hover-round504.json`,
`docs/plan/artifacts/phase600/rail-hover-round604.json`.
Quoted from `docs/plan/perf/after.md` §1 and §3.1(i).

**It held under a wider sweep.** The round-700 coverage sweep swept every hoverable target on
the chat surface including the off-screen ones — a census of 165 targets, 131 crossings — and
recorded **0** commits attributable to hover (`commits_unattributed: 0` of 10 total) and **0**
DOM mutations: `docs/plan/artifacts/phase700/hover-700.json`.

**It held on production.** Phase 900 ran the sweep against
`https://os.schreinercontentsystems.com` twice. On the chat rail: **0 DOM mutations attributable
and −1 long tasks > 50 ms attributable**, in both runs — a negative delta, meaning the swept
window contained *fewer* long tasks than the parked-pointer window.
Source `docs/plan/artifacts/phase900/hover-904.json`, quoted from `after.md` §1.

**The mechanism was named from the measurement, not guessed.** `ChatListItem` held a
`useState(hover)` and swapped the age stamp for the close ✕ on every pointer enter and leave:
77 commits over 76 crossings is ≈ **1.01 commits per crossing**, with ≈ 13.9 DOM mutations
each — the signature of a React state change per row, not of a poll or a style flip
(`docs/plan/perf/findings.md` §1). The fix mounts both children at all times and swaps them by
CSS `:hover` opacity, so no React state is involved
(`forge-control-web/app/globals.css:94-108`, quoted in `findings.md` §2).

### 1.2 The idle floor — state it before reading any timing number above

**This VPS emits ambient 50–60 ms long tasks at rest.** With the pointer provably parked and
nothing hovering, measured idle windows carried long tasks of **59 ms, 52 ms and 50 ms**
(`docs/plan/perf/after.md` §2; production floor from
`docs/plan/artifacts/phase900/hover-904.json`, round-1291 floor from
`docs/plan/artifacts/phase1290/hover/hover-1291.json`).

**Therefore: no single-run timing delta below that floor is reportable as an effect.** A lone
55 ms task observed under hover means nothing until the reader can see what parking the pointer
produced over the same window. Round 1291 went further and gave the floor a name — it is the
team panel's own 6 s poll landing (`TEAM_POLL_MS = 6_000`,
`forge-control-web/app/desktop/team/ChatTeamPanel.tsx:91`), established by three independent
lines of evidence: the long tasks form a 6 294.6 ms lattice, an `about:blank` control in the
same browser on the same VPS produced 0 long tasks, and the gap from each `/team` poll's
`responseEnd` to the long task's start was **2.1 / 2.3 / 2.2 ms** (`after.md` §2.1).

> **Pin correction, made this round.** `after.md` §2.1 and §3.3 cite `TEAM_POLL_MS` at
> `ChatTeamPanel.tsx:91` and `:164`. At `main` = `88a6368` the constant is at **`:141`** and
> its `refetchInterval` at **`:254`**; line 91 is now an import. The value is unchanged
> (`const TEAM_POLL_MS = 6_000;`), so the finding stands and only the pin had rotted —
> which is the corpus's own round-1303 rule: cite code by SHA-pinned line, prose by heading.

Pooled over round 1291's two five-pair runs: **rail 10 idle vs 6 hover long tasks; team 6 idle
vs 5.** Sweeping the pointer across every row fifteen times a second for a hundred seconds
produced *fewer* long tasks than sitting still did.

**The load-bearing before/after result of this project is the commit and mutation collapse:
77 → ~0 and 1 057 → 0.** It is not a scripting-ms figure, and §3.1 below says exactly why no
scripting-ms figure exists.

---

## 2. The brief's definition of done, item by item

One line per item. Each reads MET, NOT MET, or DELIBERATELY DEFERRED, with the artifact that
proves it. An item whose evidence could not be found is NOT MET here, never "presumably met".

### DoD 1 — TIME TRUTH: settled runs show a frozen duration; only live runs tick — **MET**

Proved on **production**, on the wire and in the DOM, as two separate claims:

- **Wire, team panel:** `/api/chat/bfd1283a-…/team`, two curls 45.11 s apart — all **17** nodes
  settled, **17/17 `working_ms` byte-identical, 0 ticked**.
- **Wire, `/api/agents`:** two curls 48.032 s apart — **58 settled rows byte-identical, 0
  ticked; 2 running rows advanced by exactly +48 032 ms**, the wall gap to the millisecond.
- **DOM, Live panel:** two screenshots 50.1 s apart — `frozenOK=13 TICKED=0 advanced=2`.
- **DOM, team panel:** `frozenOK=16 TICKED=0 advanced=1`.

Evidence: `docs/plan/operator-visibility/artifacts/phase1860/03-acceptance.md` §2a/§2b/§2c;
screenshots `/opt/ai-os/uploads/dbb65f80ce12/frozen-live-t{0,1}-dark.png`,
`frozen-team-t{0,1}-dark.png`; log `frozen-dom-log.txt`.
Unit coverage: `scripts/checks/check-duration.ts` (`03-quality.md` §2).

### DoD 2 — KIND TRUTH: session vs sub-agent, role, model, lineage on hover — **MET**

Read straight off the deployed DOM: full session rows print as `worker`, in-process sub-agents
as `↳ sub`; the role is printed and tinted; the model is on every row (`opus-5`, `haiku-4-5`,
`sonnet-5`); the hover title carries the lineage verbatim, e.g.
`in-process sub-agent of "operator-visibility · R19 closed on live evidence…" (opus-5) · role
scout · model claude-haiku-4-5-20251001 · started 2026-08-17T07:41:23.173Z` versus
`project worker · builder · project 8ea0cc08 · model claude-opus-5 · run 07e59e8e`. Roles
observed across both panels: architect, planner, builder, reviewer, scout, steward, researcher.

Evidence: `03-acceptance.md` §4a; screenshots `live-panel-{dark,light}.png`,
`live-surface-{dark,light}.png`, `team-panel-{dark,light}.png` under
`/opt/ai-os/uploads/dbb65f80ce12/`. Unit coverage: `scripts/checks/check-classify.ts`.

### DoD 3 — HOVER PERFORMANCE: profiled, cause named, before/after recorded — **MET**

Profiled with a `__REACT_DEVTOOLS_GLOBAL_HOOK__` commit shim plus a `MutationObserver` (React
DevTools' profiler is not available headless — `docs/plan/perf/baseline.md` §2). Cause named
from the shape of the number: per-row `useState(hover)` in `ChatListItem`. Before/after
recorded and reproduced across four subsequent rounds and once on production: **77 → 1 → 0
commits, 1 057 → 0 mutations**, with the idle floor stated beside it.

Evidence: `docs/plan/perf/baseline.md` (before + instrument), `findings.md` (mechanism),
`after.md` (the full series, the gate table, the floor). Raw artifacts listed in §1.1 above.
**Caveat travelling with this verdict:** what was measured is React commits and DOM mutations,
not milliseconds of scripting — see open item §3.1.

### DoD 4 — AGENT COMMS as first-class **collapsible** blocks in the operator chat — **NOT MET AS WRITTEN**

**Delivered:** comms are first-class cards in the transcript with a direction marker, actor,
role, short run id and age on the header line, and the sanitised rich payload beneath a 3 px
rule in the role's colour. Konrad's manager chat renders **111** of them; both directions
exist and render (`◂ from worker …` and, in the `control-plane verify - sender` chat,
`▸ to worker …`). Data source is the run's own thread JSON — no new pipeline was built.

**Not delivered:** the blocks are **always fully expanded**. There is no one-line preview and
no expand control. Measured on production: `commsCardsWithCollapseGlyph: 0` of 111, against
`toolRowsWithCollapseGlyph: 441` of 441 for the Bash rows the brief asked them to match;
clicking a card's header changes its text length **912 → 912**; the longest card renders
**3 125 characters** inline, and 111 such cards sit in one transcript. `CommsMessage`
(`forge-control-web/app/desktop/chat/AssistantThread.tsx:149`) has no `useState`, no `▸`/`▾`
control and no `maxHeight`.

Evidence: `03-acceptance.md` §4c and finding **F3**; screenshots `comms-in-card-{dark,light}.png`,
`comms-out-card-{dark,light}.png`, `chat-tool-row-{dark,light}.png`; log `probe2-log.txt`.
Unit coverage of the mapping: `scripts/checks/check-thread-mapping.ts`.
**Likely cause, from the code's own comment:** round 808 was steered mid-flight by a later
request from Konrad ("pls colorcode the messages from the builders … so I can faster
distinguish"); colour-coding replaced folding, and the earlier collapsibility criterion was
never retired, so it silently went unmet.

### DoD 5 — `npx tsc --noEmit` clean in both repos, `npm run build` passes in forge-control-web — **MET**

| where | result | evidence |
|---|---|---|
| worktree at `1eae6f2` | `TSC_FORGE_CONTROL_EXIT=0`, `TSC_WEB_EXIT=0`, `BUILD_EXIT=0` (12 routes) | `01-pre-deploy.md` §2 |
| production `/opt/forge-ai-os` | `BUILD_EXIT=0`, BUILD_ID `_BZ1j6SB83vj36B_yxlTW` **proven to be the bytes served** | `02-deploy.md` §4c, §5c |
| worktree at `091e05c` | both `tsc` exit 0 | `03-acceptance.md` §8 |
| worktree at `88a6368`, this round | both `tsc` exit 0 (this round changed only markdown) | §5.3 below |

The gate suite carries all three as gates 1–3 and they were green in the full run
(`01-pre-deploy.md` §3b).

**Score: 4 MET, 1 NOT MET AS WRITTEN (DoD 4's collapsibility clause), 0 deliberately deferred
among the five.** Deferrals below are of items outside the five.

---

## 3. Open items — stated as open

### 3.1 `03-quality.md` §4 clause (b), "total scripting ms reduced ≥ 50 % vs baseline" — **NOT VERIFIABLE AS WRITTEN**

**The baseline number does not exist.** `docs/plan/artifacts/phase400/hover-cost-before.json`
captured React commits and DOM mutations and **no scripting ms at all**; no instrument on this
project measured scripting ms until round 1291, which ran *after* the fix. A reduction cannot
be computed against a baseline that was never captured, and the sweep script the clause
presupposed (`scripts/checks/hover-sweep.ts`) was never committed.

**What exists instead, offered as evidence and explicitly not as a pass on this clause:**
77 React commits + 1 057 DOM mutations attributable to hover, before → **1** and **0** after,
holding at **0/0** across rounds 504, 604 and the 700 coverage sweep, and **0 mutations /
−1 long tasks attributable on production** in phase 900. Do not mark clause (b) PASS on that
adjacent evidence.

**Status of the clause itself:** formally **RETIRED by Konrad on 2026-08-17** in the round-1300
brief — *"RETIRE IT. I am not re-baselining."* — recorded verbatim and struck through in
`docs/plan/operator-visibility/03-quality.md` §4, with clauses (b1) and (b2) standing in its
place. It is retired deliberately, not deleted and not silently, so a reader can still see what
it demanded. Evidence: `03-quality.md` §4; `docs/plan/perf/after.md` §3 (gate table) and §3.1;
`docs/plan/artifacts/phase1290/hover/README.md` §3.1.

### 3.2 U31, the ~190 ms canvas first-open cost — **CLOSED AS ACCEPTED, ~190 ms, Konrad's decision**

Konrad's binding operator decision, commit `e8df4e6`
(`docs/plan/operator-visibility/15-ui-v3-phases.md`, mirrored in
`docs/plan/artifacts/phase800/README.md:343`): option **(d) accept**. Options **(a)
keep-mounted and (c) shrink-the-document are CLOSED** and may not be proposed, planned or
undertaken. **No measurement exists after the decision and none is owed.** This is not "met",
not "achieved" and not "target reached", and it is not pending anybody. 190 ms first open is
the accepted ceiling — not a licence to grow it.

### 3.3 R19 — round 1863b's conclusion, in its own words

> **"Deliverable discharged. Gap OPEN and confirmed."** These are two things; the corpus had
> run them together since round 1350.

Specifically (`04-r19-and-pins.md` §0, §2, §3, §6): the wire shape was **observed** on the live
DB — a real sub-agent was spawned by a real builder run (`07e59e8e`) and its completion
`<task-notification>` payload was captured; the notification **never becomes a thread entry**
(census: 596 runs, 57 745 entries, nine `(role, kind)` pairs, **no notification kind anywhere**;
17 runs carry 63 genuine launch acks and not one left a completion entry). **Engine emits: NO.
Client renders: YES**, re-proved on the live payload in both candidate emission shapes. Two
false statements in the recipe were found and corrected: *"only the second is collapsible"* —
**neither shape is collapsible**, because the launch ack already fills the binding slot — and
the recipe had been addressed for five rounds to `engine-v2-research-lane`, a project that is
**done**. Corrected to `engine-task-graph` (`8c591d6c`), **which is `paused`, not active**.
Declared NOT VERIFIABLE AS WRITTEN there: the raw stream-json **block type**, which needs
`cc-runner`'s stdin — engine territory this project may not enter.

**Still open and unowned:** four one-line edits in `cc-runner.ts` ×2, `db/runs.ts`,
`executor.ts`. Someone must resume `engine-task-graph` or reassign the files.
The verifier itself is green: `node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`
→ `ALL PASS — 72/72`, re-run at `main` = `88a6368` this round, exit 0.

### 3.4 `subagent_message = false` — **not a bug**, and the reason usually given for it is **wrong**

The flag is correct and stays false: no sub-agent in the corpus is a live relay target. The
one populated this project (`07e59e8e`, role scout, haiku) ended 15 ms after it started and its
parent has since completed (`03-acceptance.md` §3).

**But the standing rationale — "the builder role's tool list contains no Task, so only
architect can spawn sub-agents" — is false, and it is repeated in this round's own brief.**
Round 1863b found it out the hard way: *"Had I followed the brief's hunting instruction I would
have skipped the only instrument that could answer the question — a builder run, namely this
one"* (`04-r19-and-pins.md` §0). Builders hold the `Agent` tool and have used it. Measured
against the live DB this round:

```
$ psql "$DATABASE_URL" -tAc "select count(*) filter (where metadata ? 'subagents_v2'),
    count(*), sum(jsonb_array_length(metadata->'subagents_v2')) filter (where metadata ? 'subagents_v2')
  from runs where metadata->>'project_id'='8ea0cc08-…';"
153|154|7        -- key present on 153 of 154 runs; 7 sub-agent entries in total

$ psql … "select left(id::text,8), status, jsonb_array_length(metadata->'subagents_v2') n, metadata->>'role'
          from runs where metadata ? 'subagents_v2' and jsonb_array_length(metadata->'subagents_v2') > 0
          order by n desc limit 5;"
ab331865|completed|4|architect
2751c30d|completed|3|architect
3853c154|completed|2|architect
5fee372a|completed|2|architect
07e59e8e|completed|1|builder      <-- a BUILDER spawned a sub-agent
```

Builder run `97143435` carries `subagents_v2` with one entry and **100 thread entries stamped
with a `parent_tool_use_id`** — one sub-agent that ran a hundred tool calls. So `subagents_v2`
is *sparse*, not empty, and it is sparse because few runs delegate — not because builders
cannot.

**OPEN QUESTION FOR KONRAD, not a defect and not this project's call:** *should* builders be
able to delegate to sub-agents, or should the tool be reserved to architects to bound runaway
nesting? Today they can. That is a fleet-policy decision, his to make.

### 3.5 `resume_finished = true` with no UI composer in `AgentChatView` — **DELIBERATELY DEFERRED**

The engine capability is real (`POST /api/runs/:id/resume-chat` → 202, proof row
`project/4120f785` r1203). The UI has exactly one path to it — the `/resume-run` slash command
in the operator chat composer — and that command refuses anything whose status is not `stuck`
(`forge-control-web/app/desktop/chat/slash-registry.ts:163`, verified at `88a6368`:
`if (ctx.runStatus !== "stuck")` → *"resume only valid on stuck"*). There is no affordance
anywhere for resuming a **completed** run,
and a worker's `AgentChatView` has no composer at all, so the command cannot even be typed
there. Deferred affordance, recorded so Konrad learns it here rather than by clicking for
something that is not there. Evidence: `03-acceptance.md` §3.

### 3.6 The gate suite — **0 verdict changes, 0 red, 2 skipped by design**

Round 1861 ran the full suite (25 slots, 23 executed, 2 skipped) and then re-ran a byte-identical
copy with **only** the `set -o pipefail` line reverted to the masking form. The 23 exit codes were
compared position by position: **IDENTICAL — zero gates changed verdict.** `RED: 0`.
Gate 20 detail: `# tests 862 / # pass 862 / # fail 0`.

**No gate is red, so there is nothing to classify as pre-existing.** The two skipped slots are
gates 23 (`phase700/network-700.cjs`) and 24 (`phase600/nav-walk.cjs`) — the browser harness,
skipped by design without `--browser` and printed as `SKIPPED`, never silently omitted; round
1861's brief forbade starting a browser. Evidence: `01-pre-deploy.md` §3a–§3e.

Zero changed verdicts is **not** evidence the pipefail fix was pointless: `pipefail` is strictly
the stricter mode, so green-with-masking-gone implies green-with-masking. It is evidence that
the reds the masking had hidden were already found and fixed, in rounds 1354–1357, before the
pre-deploy ran.

### 3.7 Four production findings from the acceptance round — open, none a regression of this project

- **F1** — Konrad's manager chat resolves to **another project's** org chart. Two projects claim
  chat `bfd1283a`; `resolveChatProject` documents "newest wins", so `engine-task-graph`
  (`8c591d6c`, paused) wins and the two builders actually running for operator-visibility are
  absent from the team panel of the chat that started them. The UI is honest about it
  (`ambiguous link` chip, `linkage ambiguous` banner) — honest is not the same as useful.
- **F2** — **28 of 111** comms cards print "unknown role": 83 resolve from the server-side
  `peer_role` stamp round 808 added, the other 28 predate it and their only fallback is the
  team-panel cache, which resolves against the wrong project for the F1 reason.
- **F3** — comms cards are not collapsible. This is DoD 4; see §2.
- **F4** — the `textFaint` token at 9.5–10.5 px is below WCAG AA in **both** themes: comms age
  stamp **2.41** dark / **2.82** light, pre-existing Bash `done ▸` **2.71** / **2.82**. These are
  legitimate design tokens, so no grep would ever flag them. A decision for Konrad about the
  token, not a bug to file blind.

Evidence for all four: `03-acceptance.md` §5, with `contrast-log.txt` and `probe2-log.txt`.

### 3.8 Smaller items carried forward from `docs/plan/perf/after.md` §5

- **Mechanism B — CLOSED, and `after.md` §5 item 1 is stale.** That item says the
  `.v2-nav-item:hover:not(.v2-nav-active) span` rule is "a recommendation, not a fix… **Not
  applied**", pinned at `v2.css:291`. **It was applied**, by round 1302, commit `642293a`
  — *"perf(phase1300/1302): delete the dead .v2-nav-item rules — 1460 → 780 invalidation
  records"*. At `88a6368` the rules are gone and `forge-control-web/app/v2.css:284-288`
  carries a tombstone comment recording the deletion and the reason: **no markup in either
  repo ever carried the class**, yet the bare `span` compound put every `span` in the
  document into Blink's hover invalidation set. Discovered this round while checking the pin;
  `after.md` §5 was written at round 1292 and never updated after 1302 landed. The honesty
  caveat still travels with the number: **style-invalidation records are not milliseconds**,
  and it was never established that this rule is what Konrad felt as lag.
- **The team poll's own cost is identified and untouched:** 102 rows / 61 KB re-parsed every
  6 s is the only source of > 50 ms tasks on that surface. Levers, in order of least user cost:
  stop re-materialising settled rows, trim the payload server-side, window the list. **Do not
  slow the poll** — the honesty rules forbid buying a number with cadence.
- **Nobody has checked whether anything else in the app writes `<html lang>`.** Only
  Excalidraw's write was traced.
- **Three sibling planning files still name the closed `engine-v2-research-lane`:**
  `00-vision.md:48`, `01-requirements.md:107`, `02-architecture.md:187`.
- **Chrome trace files (`trace-<label>-<n>.json`, loadable in `chrome://tracing`) do not exist
  for any hover round.** The instrument family never produced them; R12's "trace loadable in
  DevTools" criterion is not satisfiable for this corpus. Every measurement JSON is committed
  raw and unfiltered, including round 1291's 252 KB three-run output.
- **`origin/main` is ~129 commits behind local `main`.** The deploy target is the local `main`
  in `/opt/forge-ai-os`, never the GitHub remote. Do not let a later round resolve "main" to
  `origin/main`.

---

## 4. The instrument ledger

This project found the same defect four times, in four different instruments: a gate runner
whose piped bodies could not fail (`bash -c "$script"` without `set -o pipefail`, so a red gate
whose output was piped exited 0); a pin verifier that could only see fenced quotes and printed
`ALL PASS — 11/11` while the document it audited held 64 pins; a hover probe that certified
itself, sweeping coordinates that never landed on a row and reporting the resulting quiet as a
pass; and an idle floor of ambient 50–60 ms long tasks mistaken for a hover signal. **The shape
they share is a partial instrument reporting a full pass** — each was not wrong about what it
measured, only silent about what it could not see. **Any count without a denominator cannot
distinguish "I checked everything" from "I checked everything I can see"**, which is why the
verifier now derives its denominator from the document (72/72, with two negative controls), the
sweep exits non-zero as `SWEEP INVALID` when a probe misses a row, and every long-task figure
in this corpus is printed beside the parked-pointer floor.

---

## 5. What this round did

### 5.1 Part 1 — the residual commits are on `main`

Round 1863 committed to `project/8ea0cc08` after round 1862 had merged, leaving work on the
branch — exactly the defect the steward flagged. There were **three** residual commits, not two:
round 1862's own deploy document was among them.

```
$ git log --oneline main..HEAD            # in the worktree, before the merge
88a6368 docs(round1863): production acceptance — the settings click by hand, and two clocks proven separately
ed25c4f docs(round1863): R19 closed on live evidence, and the pin count learns its denominator
091e05c docs(round1862): deploy — the rebuild that proved which bytes are being served

$ cd /opt/forge-ai-os && git status --porcelain
(empty — clean)

$ git rev-parse --abbrev-ref HEAD    main
$ git rev-parse main                 3706160e57a8df0fceadeb52e34e74a4ebdd2076   <-- PRE_MAIN

$ git merge --ff-only project/8ea0cc08
Updating 3706160..88a6368
Fast-forward
 .../phase4/verify-notification-gap-pins.mjs        | 586 +++++++++++++++++--
 docs/plan/notification-gap.md                      | 311 ++++++++--
 .../artifacts/phase1860/02-deploy.md               | 390 +++++++++++++
 .../artifacts/phase1860/03-acceptance.md           | 650 +++++++++++++++++++++
 .../artifacts/phase1860/04-r19-and-pins.md         | 364 ++++++++++++
 5 files changed, 2214 insertions(+), 87 deletions(-)
MERGE_EXIT=0

$ git rev-parse main                 88a63687cd708403a4f3040cc779a2d3960aa888   <-- POST_MAIN
```

**Fast-forward, no conflict.**

### 5.2 No rebuild and no restart were owed — confirmed, not assumed

```
$ git diff --stat 3706160..HEAD -- forge-control/src forge-control-web/app \
                                    forge-control-web/pnpm-lock.yaml pnpm-lock.yaml
(empty)
```

Zero lines under `forge-control/src`, zero under `forge-control-web/app`, and the lockfiles did
not move. Five files changed: four markdown documents and one `.mjs` check script that nothing
imports at runtime. Per the round-1862 runbook, **no `pnpm build` and no `pm2 restart` were
performed.** Services confirmed untouched and healthy after the merge:

```
forge-control-web  online  restarts 5   pid 2108274
forge-control      online  restarts 29  pid 2061337
forge-executor     online  restarts 0   pid 2276472     <-- never touched, up since 2026-08-11
$ curl -s http://127.0.0.1:7700/api/health
{"ok":true,"service":"forge-control","version":"0.1.0","uptime_seconds":3223,…}
```

Restart counts are identical to those `02-deploy.md` §5a recorded, so no process restarted
between the deploy and this round.

### 5.3 Gates re-run this round

```
$ cd forge-control     && npx tsc --noEmit     TSC_FORGE_CONTROL_EXIT=0
$ cd forge-control-web && npx tsc --noEmit     TSC_WEB_EXIT=0
$ node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
ALL PASS — 72/72 pins in docs/plan/notification-gap.md classified
PINS_EXIT=0
```

`pnpm build` was not re-run: no source file has moved since round 1862 built and deployed it,
and that build's route table and BUILD_ID are recorded in `02-deploy.md` §4c, with §5c proving
those bytes are the ones being served.

### 5.4 Ordering note, confirmed — the customer test at round 1870 needs no reschedule

Checked against the live task table rather than assumed:

```
$ psql … "select round, role, status, left(title,75) from project_tasks
          where project_id='8ea0cc08-…' and round >= 1860 order by round, created_at;"
1860|planner |done    |STEWARD CORRECTION — the FINAL deploy, after every deferred phase
1861|builder |done    |Pre-deploy: merge main, re-run tsc/build, and re-run the whole gate suite
1862|builder |done    |Deploy: rebuild forge-control-web against HEAD and restart it
1863|builder |done    |Production acceptance: Konrad's settings click by hand, frozen elapsed
1863|builder |done    |R19 closed on live evidence or precisely open, and the pin verifier's blind spot
1864|builder |running |Ship the residual doc commits to main and write the project's closing record
1865|reviewer|pending |Gate the final deploy: production-only verification, executor untouched
1870|tester  |pending |Customer test: the deployed Manager Chat UI, as Konrad
```

**"Customer test: the deployed Manager Chat UI, as Konrad" is still `pending` at round 1870**,
after every round of this deploy (1861–1865). It will therefore walk a production build that
contains rounds 1600–1701. **No reschedule and no second tester is needed.**

---

## 6. Provenance

Every `docs/plan` path cited in this document resolves in the tree:

```
$ grep -ohE 'docs/plan/[A-Za-z0-9._/-]+' \
    docs/plan/operator-visibility/artifacts/phase1860/05-project-summary.md \
  | sed 's/[.,;:)]*$//' | sort -u | while read p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

Screenshot and log paths cited under `/opt/ai-os/uploads/dbb65f80ce12/` are outside the repo by
design — Konrad reads them without logging in — and are indexed in `03-acceptance.md` §6.

**This document changed no application code, started no server, ran no browser, restarted no
process and deleted nothing.**
