# Phase 1300 — round 1302: the payload and the render

Round 1301 measured the BEFORE. This round changed application code and
measured the AFTER with **round 1301's own instruments**, unmodified.

---

## 0. The verdict, on one screen

| lever | claim | result |
|---|---|---|
| **L1 — row identity** | wrapper cache + `responseNow` off the props | **PAID, decisively.** Body renders per 4 polls **432 → 8** (−98.1 %). Memo bailouts **0 → 436**. Distinct rows re-rendered **108 → 2**. Reproduced to the integer, twice |
| **L2 — trim `/team`** | remove fields nothing renders | **PAID A LITTLE, honestly.** Only `task.id` was provably unread. **−4 224 B, −6.29 %** on an identical tree. Every other candidate has a live reader; the greps are in §3 |
| **L3 — window the rows** | render the visible slice | **NOT SHIPPED.** It removes the keyboard-reachable ✕ from windowed-out rows, which R15 protects. §4 states the case; the brief's own escape hatch is taken |

**The honest limit, stated first.** The brief's success criterion was *"the
periodic long tasks stop landing 2.1–2.3 ms after each `/team` responseEnd."*
**They have not stopped landing there.** When a long task occurs it is still
poll-aligned at **1.8–2.7 ms**. What changed is **how often the poll's work
crosses the 50 ms line**: 6 of 12 polls BEFORE, **1–3 of 12 polls AFTER**. That
is consistent with round 1301's own finding that *the 50 ms threshold is a
reporting artifact, not a property of the work* — the poll still does work every
6.3 s; there is now much less of it, so it clears the bar less often.

---

## 1. The rig

| | |
|---|---|
| worktree | `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`, branch `project/8ea0cc08` |
| `git rev-parse HEAD` at build time | **`85b07cf`** — sibling tasks commit into this worktree concurrently, so this SHA moved during the round; every number below was taken against this one |
| API under test | **`http://127.0.0.1:7840`** — this round's OWN instance of `scripts/checks/serve-v3-7798.ts` (`SERVE_V3_PORT=7840`), routers only. It mounts **this worktree's** `chat.ts`, which is what makes the L2 byte delta measurable |
| clean web build | `/tmp/phase1302-web`, served on **`:7841`** |
| instrumented web build | `/tmp/phase1302-web-inst`, served on **`:7842`** |
| **can this rig stream SSE?** | **NO.** `serve-v3-7798.ts` is a buffered writer and says so in its own header. Every timing here is therefore a **floor**: a surface that is also streaming has strictly more main-thread work |
| ports checked first | `ss -ltn` before binding. 7700/7701/7791/7793/7798/7811/7814/7815/7817 were bound and **nothing was killed**. 7840/7841/7842 were free |
| browser | chromium from `/root/.cache/ms-playwright`, playwright by absolute path from `/opt/hermes-workspace` (NFU8 — neither repo gains a dependency) |
| viewport | 1600 × 1000 |
| target chat | manager run **`bfd1283a-b71b-4f35-b577-7d09aad803f2`** |
| `nproc` | **16** |
| VPS load | recorded beside every number; 1-minute load ranged **1.54 → 4.14** across the round — noisier than round 1301's 2.43–3.36 |
| production | **not contacted.** `/opt/forge-ai-os` was never touched; `forge-control-web/.next` was never rebuilt in place |

Both builds are `rsync` copies of the worktree with `node_modules` symlinked, per
`phase1290/hover/README.md` §7 steps A–E. `next build` in `/tmp/phase1302-web`
**passed** — that is this round's `npm run build` gate, run against worktree
source rather than in place, because §4 of this task's brief forbids rebuilding
`forge-control-web/.next`.

**The tree grew between rounds.** 108 nodes (round 1301) → **111** (this round):
the project spawned three more workers overnight. Raw byte counts across rounds
are therefore NOT comparable, and §3 does not compare them — it measures the L2
delta on one identical tree.

---

## 2. L1 — row identity. The payer

### 2.1 What changed

Two edits, both required. Round 1301 measured
`bailoutsIfRowWereTheOnlyProp = 0`: with either one still in place, **nothing**
would have bailed out.

1. **`teamRows.ts`** — `flattenTeam` takes an optional `TeamRowCache` and
   returns the PREVIOUS wrapper object when every field it carries is unchanged.
   The cache is a parameter, not module state, so the function stays pure enough
   for `check-team-rows.ts` to assert identity directly. `byId` is replaced (not
   mutated) each walk, so a node that leaves the tree takes its wrapper with it.
2. **`TeamRow.tsx` / `ChatTeamPanel.tsx`** — `responseNow` left the row props for
   a `ResponseNowContext` that only `LiveTime` reads. It is a new number every
   poll and was being handed to all 111 rows to move the 2 that are running.
   React delivers a context change to consumers even through a `memo` bail-out,
   so the routing is exact.

### 2.2 The numbers — same instrument as round 1301

Instrumentation identical to `../baseline/instrumentation.diff`, re-applied to
`/tmp/phase1302-web-inst` and committed here as `instrumentation-1302.diff`. The
comparator reproduces React's default shallow compare exactly, so the
instrumented build renders identically to the clean one.

```bash
CENSUS_BASE_URL=http://127.0.0.1:7842 CENSUS_RENDER=1 CENSUS_RENDER_MS=25200 \
  CENSUS_LABEL=render-inst-after node ../baseline/dom-census.cjs
```

25.2 s, 4 polls, **pointer never moved**, run twice.

| | BEFORE (r1301) | AFTER run 1 | AFTER run 2 |
|---|---|---|---|
| `flattenTeam` calls (= polls) | 4 | 4 | 4 |
| memo compares | 432 | 444 | 444 |
| **memo bailouts** | **0** | **436** | **436** |
| **`TeamRowViewImpl` body renders** | **432** | **8** | **8** |
| **distinct rows re-rendered** | **108** | **2** | **2** |
| compares where `row` differed | 432 (100 %) | **8 (1.8 %)** | **8 (1.8 %)** |
| compares where `responseNow` differed | 432 (100 %) | **0 — the prop no longer exists** | **0** |
| `prev.row === next.row` | 0 | **436** | **436** |
| `prev.row.node === next.row.node` | 428 | 436 | 436 |
| `bailoutsIfNodeIdentityDecided` (the r1301 prediction) | 428 | 436 | 436 |
| VPS load at run | 2.94 / 2.59 | 2.61 | 3.25 |

**The prediction landed on the nose.** Round 1301 forecast
`bailoutsIfNodeIdentityDecided` bailouts if both changes were made; the actual
bailout count is **exactly that number, 436 = 436**, in both runs. Spread across
the two AFTER runs: **1.000×** — the 03-quality §4 2× rule is not close.

**"A settled row must re-render zero times on a poll that did not change it" —
measured, not asserted.** `distinctRowsRendered = 2` over 25.2 s and four polls,
against 108 settled nodes of 111. The 8 body renders are 2 rows × 4 polls: the
manager chat and the one running worker. **No settled row rendered at all.**

### 2.3 What this does NOT establish

Render counts are not milliseconds, and §5 shows the wall-clock effect is real
but much smaller than 98 %. The poll still parses ~63 KB of JSON, react-query
still structurally-shares 444 nodes, and React still reconciles 111 memoized
elements before bailing out on 436 of them. Removing 424 component bodies from
that path is a large slice of the work, not all of it.

---

## 3. L2 — trimming `/team`. One field, and the greps that saved the rest

### 3.1 What was removed

**`task.id`** — and only `task.id`. The grep that licensed it:

```bash
$ grep -rn "task\.id\|task?\.id" forge-control-web/app scripts/checks/
$ echo $?
1        # no hits, anywhere, in any form
$ grep -rn "TeamTask" forge-control-web/app scripts/checks/*.ts
forge-control-web/app/desktop/team/teamApi.ts:40:export interface TeamTask {
forge-control-web/app/desktop/team/teamApi.ts:85:  task: TeamTask | null;
```

Removed in one commit from all four places the rule names: the SQL
(`TEAM_TASKS_SQL` no longer selects `id`), the server interfaces (`TaskRow`,
`TeamTask`), the shaping (`taskByRun.set`), and the client type
(`teamApi.ts`'s `TeamTask`).

### 3.2 The delta, on one identical tree

Cross-round byte counts are worthless here (108 → 111 nodes). So the
counterfactual is computed on the AFTER tree, with `task.id` put back as the
uuid the column actually holds, and re-serialised with Hono's separators. The
re-serialisation is asserted **byte-identical** to the wire bytes (62 902 =
62 902) before any delta is quoted.

| | bytes | nodes | task blocks |
|---|---|---|---|
| same tree, `task.id` present | **67 126** | 111 | 96 |
| same tree, `task.id` removed | **62 902** | 111 | 96 |
| **delta** | **−4 224 B** | | |
| **as a share** | **−6.29 %** | | |

Confirmed independently in the browser: `decodedBodySize` on the `/team`
responses is **65 245–65 261** in `../baseline/lattice-1301.json` and
**62 900–62 912** in `lattice-1302.json`.

Node count unchanged by the trim (111 before and after the edit); the honesty
machinery is intact on the wire:

```
top-level keys identical: ['chat_id','complete','errors','link_ambiguous',
                           'link_source','manager','now','project','workers']
complete: True   errors: []   link_source: 'metadata'   link_ambiguous: False
node keys removed: []   node keys added: []
task keys after: ['role','round','status','title']   removed: ['id']
```

### 3.3 Every other candidate: evaluated, and KEPT, with the reader named

The brief asked for at minimum these six. Five have live readers. The rule was
"a field the UI reads must survive, no matter how many bytes it costs", so they
survive.

| candidate | r1301 cost | verdict | the reader that saved it |
|---|---|---|---|
| `tokens` (5 fields) | 9 939 B / 15.2 % | **KEEP** | `TeamRow.tsx:594-597` renders **all four** counters in the tokens tooltip (`in/out/cache read/cache write`), and `total` in the cell. Nothing here is decorative |
| `task.title` | part of 16 797 B | **KEEP** | `chat/OrientationStrip.tsx:317,561,571` reads `node.task.title` directly. Not a file this task may edit |
| `description` | 9 453 B / 14.5 % | **KEEP** | `TeamRow.tsx:411` (the row's second line) and `OrientationStrip.tsx:573-588`. **This is the 10.17 % duplication round 1301 found, and it is NOT free after all** — the two copies have two different readers in two different files, and removing either one means editing `OrientationStrip.tsx`, which this task's file list excludes |
| `parent_id` | 2 040 B / 3.1 % | **KEEP** | `ChatSurface.tsx:445` builds the drill-in nav frame from `node.parent_id ?? node.id`; `OrientationStrip.tsx:244` matches sub-agents on it. Nesting implies it, but the two consumers read the field, and both files are out of scope |
| `working_ms_source` | 3 132 B / 4.8 % | **KEEP** | `TeamRow.tsx:201,403`. The brief is right that only `"rollup"` changes the UI — but narrowing the wire to `"rollup" \| null` would make `null` mean *"thread, or not measured"*, disambiguated only by `working_ms`. That trades an explicitly-typed provenance label for 4.8 %, against a codebase whose whole NFU6 discipline is not conflating "measured" with "unknown". **Declined on honesty, not on cost** |
| `task.id` | ~4 224 B / 6.3 % | **REMOVED** | none — §3.1 |

**Result: L2 is a −6.29 % lever, not the −25 % the field census suggested.** The
census counted what fields cost; it could not know what reads them. Reported
straight rather than padded.

`complete` / `errors` / `link_source` / `link_ambiguous` were never candidates
(NFU6) and are untouched.

---

## 4. L3 — windowing. Not shipped, and why

Only 12 of 111 rows are inside the scroller's 531 px box (§6). The case for
windowing is real and this round declines it anyway.

**The blocker is R15 and the ✕.** `globals.css:102,106` reveal the row controls
on `:focus-within` as well as `:hover` — that is deliberate, and R15 forbids
removing the affordance to make a number look better. A windowed list cannot
satisfy it: a row that is not in the DOM has no button, so **Tab cannot reach
the ✕ of any row outside the visible slice.** Focus cannot be moved to an
element that does not exist, and no overscan value fixes it — it only moves the
boundary. The keyboard user would have to scroll the container first, which is
precisely the "reachable only by pointer" state the rule exists to prevent.

The brief's own instruction: *"If windowing puts R15 or the ✕ at risk, say so
plainly and ship L1+L2 instead. A smaller honest fix beats a large one that
breaks the affordance."* Taken as written.

Consequence, stated so nobody reads §6 as a failure: **the DOM census does not
move this round.** 111 rows are still mounted, at 13 elements each. Only L3
would have changed that, and L3 is not here.

---

## 5. The lattice, AFTER

`hover-1291.cjs` unmodified, via the `HOVER_OUT` flag round 1301 added. Raw:
`lattice-1302.json`, committed unfiltered, five runs.

### 5.1 The long control — 75.6 s, 12 polls, pointer parked

| | BEFORE (r1301) | AFTER #1 | AFTER #2 | AFTER #3 |
|---|---|---|---|---|
| app window, ms | 75 605 | 75 605 | 75 605 | 75 605 |
| `/team` polls | 12 | 12 | 12 | 12 |
| **long tasks > 50 ms** | **6** | **2** | **3** | **1** |
| their max, ms | 67 | 58 | 55 | 52 |
| **gap from poll `responseEnd`, ms** | 2.7 / 2.3 / 2.1 / 2.2 / 2.1 / 2.0 — **median 2.2** | 3.3 / 743.3 | 2.2 / 2.7 / 2.4 — **median 2.4** | 1.8 |
| all gaps within 250 ms | **true** | **false** (one task at 743 ms is NOT poll work) | true | true |
| mean poll interval, ms | 6 310.4 | 6 319.5 | 6 327.1 | 6 323.4 |
| decoded payload, bytes | 65 259 | **62 902** | **62 912** | **62 912** |
| `about:blank`, same browser | **0 long tasks in 25 207 ms** | 0 in 25 216 | 0 in 25 206 | 0 in 25 206 |
| CDP `ScriptDuration` over the window, ms (renderer-wide, NOT attribution) | 1 011.7 | 1 246.5 | 970.5 | 897.7 |
| VPS load, 1-min, 16 CPUs | 2.58 → 2.43 | 4.14 → 1.72 | 3.90 → ~3.2 | 3.21 → 3.26 |

**Read this with the floor beside it.** The ambient 50–60 ms floor on this VPS
is real: round 1291 recorded 50–60 ms long tasks in three of four
**parked-pointer** windows, and round 1301 recorded a 52–67 ms range. AFTER, the
maxima are 52–58 ms — i.e. **the surviving long tasks sit on the ambient floor,
not above it.** Load also swung 1.54–4.14 during this round versus 2.43–3.36
during round 1301, which is why three replicates were run rather than one.

**The 3× spread rule.** AFTER runs give 2, 3 and 1 long tasks — a 3× spread
between the extremes, above 03-quality §4's 2× threshold. **Declared, not
smoothed.** With 1–3 events per 75 s window that spread is what counting rare
events at a noisy floor looks like; the median is 2, against 6 BEFORE.

### 5.2 The short control — the run that went the wrong way

| | BEFORE | AFTER |
|---|---|---|
| window / polls | 30 004 ms, 5 | 30 004 ms, 5 |
| long tasks > 50 ms | **3** | **4** |
| max, ms | 59 | 56 |
| gaps, ms | 2.3 / 2.7 / 3.2 | 2.3 / **66.4** / 2.2 / 2.3 |
| VPS load at run | 3.33 → 3.10 | **4.14** (highest of the round) |

**Reported because it is a number this round produced, not because it is
convenient.** The 30 s window at load 4.14 got *worse* by one task. It is the
smallest window, at the heaviest load, with the fewest events; the three 75 s
windows are the better evidence and they agree with each other and with §2's
render census. But a round that only quotes its three favourable replicates is
doing the thing 03-quality §4 forbids.

### 5.3 The interleaved pairs — hover stays closed

`run1` / `run2`, 5 pairs per surface, ~150 crossings per hover window.

| | run1 | run2 |
|---|---|---|
| **team**, attributable long tasks per pair | [0, 0, 0, 0, 0] | [0, 0, 0, 0, 0] |
| team idle floor / hover | [0,0,0,0,0] / [0,0,0,0,0] | [0,0,0,0,0] / [0,0,0,0,0] |
| **rail**, attributable per pair | [0, 0, 0, 0, 0] | [0, 1, 0, −1, 0] |
| median attributable > 50 ms, team | **0** | **0** |

**All twenty team windows in `run1` and `run2` recorded zero long tasks — idle
and hovering alike.** Round 1291's equivalent had 6 idle / 5 hover across its
twenty team windows. Hover was already closed; it is now sitting on a quieter
surface.

---

## 6. DOM census, AFTER

```bash
CENSUS_BASE_URL=http://127.0.0.1:7841 CENSUS_LABEL=dom-clean-after node ../baseline/dom-census.cjs
```

Load 3.32 → 2.95, 16 CPUs.

| | BEFORE (r1301) | AFTER |
|---|---|---|
| whole-document elements | 6 237 | **6 402** |
| `[data-team-row]` | 108 | **111** |
| — operator / worker / sub-agent | 1 / 101 / 6 | 1 / 104 / 6 |
| elements inside team rows | 1 404 | **1 443** |
| mean elements per row | 13.0 (min = median = max) | **13.0** (min = median = max) |
| team rows' share of document | 22.51 % | 22.54 % |
| row height | 43 px | 43 px |
| scroller box height | 531 px | 531 px |
| **rows fully inside the scroller** | **12** | **12** |
| rows intersecting it | 13 | 13 |

**Unchanged per row, and that is the expected result.** L1 changes how often a
row's component body runs, not how many elements it emits; L2 removes a field no
row rendered. The +3 rows and +165 document elements are the tree growing and the
chat transcript growing between rounds, not this round's diff. **Only L3 would
have moved this table, and §4 declined L3.**

---

## 7. Both themes

`theme-dark.png` / `theme-light.png` — full page, `/desktop` with the manager
chat open and the Team tab visible, theme set with
`document.documentElement.dataset.theme = 'light'|'dark'`. Verified in the DOM at
capture time:

| theme | `data-theme` | body background | row divider | row kind-badge colour |
|---|---|---|---|---|
| dark | `dark` | `rgb(0, 0, 0)` | — | — |
| light | `light` | `rgb(247, 247, 245)` | `rgb(231, 231, 227)` | `rgb(31, 127, 147)` |

Panel state at capture, both themes: `data-team-state="ready"`, **111
`[data-team-row]`, 111 `[data-team-x]`, 1 `[data-team-scroll]`** — every
instrument selector the corpus and the reviewer use is still queryable, and every
row still carries its ✕.

> **A note on the two `*-crop.png` files.** They are committed for completeness
> and **they are wrong**: Playwright's element-clip screenshot rendered the light
> panel with the dark palette, while the DOM at that instant reported the light
> values in the table above and the full-page capture of the same instant is
> correctly light. It is a capture artifact of the clip path, not a theme bug.
> **Judge the themes on `theme-light.png` / `theme-dark.png`.**

Design tokens only:

```bash
$ grep -nE '#[0-9a-fA-F]{3,8}|rgb\(|hsl\(' \
    forge-control-web/app/desktop/team/{TeamRow.tsx,ChatTeamPanel.tsx,teamRows.ts,teamApi.ts} \
    forge-control/src/routes/chat.ts scripts/checks/check-team-rows.ts
$ echo $?
1        # zero hits
```

---

## 8. Cadence unchanged — the grep, not the promise

```bash
$ grep -n refetchInterval forge-control-web/app/desktop/team/*.tsx
forge-control-web/app/desktop/team/ChatTeamPanel.tsx:169:    refetchInterval: TEAM_POLL_MS,
forge-control-web/app/desktop/team/PlanKanban.tsx:352:    refetchInterval: PLAN_POLL_MS,

$ grep -n TEAM_POLL_MS forge-control-web/app/desktop/team/ChatTeamPanel.tsx
96:const TEAM_POLL_MS = 6_000;
169:    refetchInterval: TEAM_POLL_MS,
```

`TEAM_POLL_MS` is still `6_000` (the line moved from 91 to 96 because this round
added an import). `PlanKanban`'s cadence is untouched. **No number here was
bought with cadence.**

Also untouched: the chat transcript (no virtualising, capping, windowing or
paginating), the canvas mount model, `project-tick.ts`, `cc-runner.ts`,
`executor.ts`, `db/projects.ts`, `VaultFileList*`, `routes/files.ts`,
`globals.css`, `v2.css`.

---

## 9. Gates

```
$ (cd forge-control && npx tsc --noEmit)          → exit 0
$ (cd forge-control-web && npx tsc --noEmit)      → exit 0
$ (cd /tmp/phase1302-web && next build)           → ✓ compiled, /desktop 324 kB First Load JS
$ ./node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts
                                                  → ALL PASS — team row model
```

`check-team-rows.ts` gained a **`flattenTeam`: wrapper identity** section, 21
new assertions, which is the L1 contract stated as tests rather than as prose:

- same response twice with one cache → **every** wrapper is the identical object;
- one node's status changes (structural sharing reproduced: same objects except
  one) → **exactly one** fresh wrapper, and it is that node's;
- a renamed parent → its own wrapper **and its sub-agents'** refresh, because
  `parentDescription` is rendered in the lineage tooltip;
- no cache passed → old behaviour, no wrapper shared;
- dismissal → survivors keep identity, the dismissed subtree leaves the cache,
  restore builds fresh wrappers;
- the empty (manager-only) and all-dismissed cases → cache empty not stale,
  `hiddenCount` still counts **rows**, not ids.

`hiddenCount` semantics are unchanged and still count dismissals only — nothing
in this round hides a row for any other reason.

---

## 10. Files

| File | What |
|---|---|
| `README.md` | this file |
| `lattice-1302.json` | §5 raw — `runs.control`, `.control-long`, `.control-long-2`, `.control-long-3`, `.run1`, `.run2`, written by the unmodified `hover-1291.cjs` via `HOVER_OUT` |
| `dom-census-1302.json` | §2 + §6 raw — `runs.render-inst-after`, `.render-inst-after-2`, `.dom-clean-after` |
| `team-payload-after.json` | the 62 902-byte `/team` response §3 was computed from, verbatim |
| `instrumentation-1302.diff` | the exact diff applied to `/tmp/phase1302-web-inst`. **Never applied to the worktree** — §9's `git status` is the proof |
| `theme-dark.png`, `theme-light.png` | §7, full page, both themes |
| `team-panel-dark-crop.png`, `team-panel-light-crop.png` | §7's element crops, committed with their artifact declared |
