# Phase 1290 — round 1291: the 61 ms residual, closed

**Round 1291 changed no application code.** It produced a measurement. `git status`
at the end of the round touches `docs/plan/artifacts/phase1290/hover/` and nothing
else; §7 pastes the gate output that proves it.

---

## 0. The one-line answer

The 61 ms long task that round 904 could not clear was **the team panel's own 6 s
poll landing**, not hover. It fires every `6000 + fetch` ms whether the pointer is
sweeping, parked, or absent from the surface entirely, and with the pointer
provably parked it starts **2.1–2.3 ms after the `/team` response finishes**.

Over five interleaved idle/hover pairs per surface, run twice:

| surface | median attributable long tasks > 50 ms, 5 pairs | |
|---|---|---|
| | **run1** | **run2** |
| rail | **0** | **−1** |
| team | **0** | **0** |

Pooled over all ten pairs: rail **−0.5**, team **0**. Across the twenty measured
windows per surface the parked-pointer floor is *larger* than the swept total —
rail **10 idle vs 6 hover**, team **6 idle vs 5 hover**. **The residual is closed.**

---

## 1. What round 904 left open, and why five pairs settle it

`docs/plan/artifacts/phase900/hover-904.json` held two 10 s sweeps, 150 crossings
each, each with a parked-pointer idle baseline over the same window:

| | idle long tasks | hover long tasks | `attributable.longTasks` |
|---|---|---|---|
| run1 team | 0 | 1 (61 ms) | **+1** ← the residual |
| run2 team | 1 (59 ms) | 1 (56 ms) | 0 |
| run1 rail | 1 (52 ms) | 0 | −1 |
| run2 rail | 1 (50 ms) | 0 | −1 |

Read across the row rather than down it and the shape is obvious: this machine
emits 50–60 ms long tasks *with the pointer parked*, in three of the four idle
windows. The "residual" was one task, in one window, out of two. Two windows
cannot separate a signal from a floor that busy. Ten can — and, as it turns out,
you do not have to settle for a distribution, because the floor has a name.

---

## 2. Verdict on gate clause (a) — zero attributable tasks > 50 ms

`03-quality.md` §4, *Numeric gate* (a): *zero tasks > 50 ms during the sweep
window that the trace attributes to script/hover handling — GC and unrelated poll
work must be called out explicitly if present.*

### 2.1 The number the gate asks for

> **median attributable long tasks > 50 ms over 5 pairs = 0** (team, run1)
> **median attributable long tasks > 50 ms over 5 pairs = 0** (team, run2)
> **median attributable long tasks > 50 ms over 5 pairs = 0** (rail, run1)
> **median attributable long tasks > 50 ms over 5 pairs = −1** (rail, run2)

`attributable = hover window count − idle window count`, per pair, exactly as
round 904 defined it. A negative median means the sweep produced *fewer* long
tasks than doing nothing did.

### 2.2 Raw per-pair table

Each cell is one 10 s window. `idle` = pointer parked at (900, 500), over the
transcript and on no row. `hover` = ~150 crossings at 40 ms dwell.

**run1** — started 2026-08-16T23:16:32Z, load 1.89 → 2.36

| pair | rail idle | rail hover | rail attr | team idle | team hover | team attr |
|---|---|---|---|---|---|---|
| 1 | 1 (58 ms) | 0 | **−1** | 1 (51 ms) | 0 | **−1** |
| 2 | 1 (63 ms) | 1 (61 ms) | **0** | 0 | 0 | **0** |
| 3 | 1 (55 ms) | 1 (51 ms) | **0** | 2 (59 ms) | 0 | **−2** |
| 4 | 0 | 1 (52 ms) | **+1** | 1 (53 ms) | 1 (51 ms) | **0** |
| 5 | 1 (55 ms) | 0 | **−1** | 0 | 1 (51 ms) | **+1** |
| **total** | **4** | **3** | median **0** | **4** | **2** | median **0** |

**run2** — started 2026-08-16T23:20:19Z, load 2.33 → 2.79

| pair | rail idle | rail hover | rail attr | team idle | team hover | team attr |
|---|---|---|---|---|---|---|
| 1 | 2 (59 ms) | 0 | **−2** | 1 (51 ms) | 1 (54 ms) | **0** |
| 2 | 1 (52 ms) | 0 | **−1** | 1 (51 ms) | 0 | **−1** |
| 3 | 0 | 1 (50 ms) | **+1** | 0 | 0 | **0** |
| 4 | 1 (59 ms) | 1 (55 ms) | **0** | 0 | 1 (55 ms) | **+1** |
| 5 | 2 (56 ms) | 1 (52 ms) | **−1** | 0 | 1 (55 ms) | **+1** |
| **total** | **6** | **3** | median **−1** | **2** | **3** | median **0** |

(ms in brackets is `maxLongTaskMs` for that window.)

### 2.3 The idle floor, next to it

The gate wants the floor shown beside the verdict. Over 5 pairs × 10 s = 50 s of
**parked-pointer** observation per surface per run:

| | rail | team |
|---|---|---|
| run1 idle long tasks in 50 s | 4 | 4 |
| run2 idle long tasks in 50 s | 6 | 2 |
| **pooled idle (100 s)** | **10** | **6** |
| **pooled hover (100 s, ~1 490 crossings)** | **6** | **5** |

Sweeping the pointer across every row fifteen times a second, for a hundred
seconds, produced **fewer** long tasks than sitting still did on the rail, and one
fewer on the team panel.

### 2.4 The floor has a name: `TEAM_POLL_MS`, called out as the gate demands

The gate says unrelated poll work *must be called out explicitly if present*. It
is present, and it is the entire floor.

**(i) The long tasks are periodic.** The page is loaded once and never reloaded,
so every `startTime` in a run is on one monotonic `performance.now()` clock —
across both surfaces and across idle and hover windows alike. `longTaskCadence`
in the JSON fits a base period to the whole session:

| | run1 | run2 |
|---|---|---|
| long tasks in the session | 13 | 14 |
| base period | **6 294.6 ms** | **6 283.4 ms** |
| worst residual from an integer multiple | 46.5 ms | 125.6 ms |
| worst residual as % of period | **0.7 %** | **2.0 %** |
| `fits` (every gap an integer multiple, ≤ 5 %) | **true** | **true** |

Every inter-task gap in run1 is an integer multiple of 6 294.6 ms:
`[18894.2, 12593.6, 6316, 6296.8, 25188.1, 12612.4, 18930.3, 44087.4, 6294.6,
12598.8, 12591.8, 18888.2]` — that is 3P, 2P, P, P, 4P, 2P, 3P, 7P, P, 2P, 2P, 3P.
Hover handling does not produce a lattice.

**(ii) It is the page, not the machine.** The control run (`runs.control`, pointer
never moved) observed `about:blank` for 10 s in the same browser on the same VPS:

> **0 long tasks, `ScriptDuration` delta 0 ms.**

**(iii) It is the team poll specifically.** The control then opened the manager
chat, parked the pointer, and observed for 30 s while recording resource timing
for every request whose path ends in `/team`:

| | value |
|---|---|
| long tasks in 30 s, pointer parked | **3** (51, 55, 66 ms) |
| `/team` polls in the window | 5 |
| observed poll intervals | 6 291.6 / 6 301.3 / 6 285.2 / 6 288.8 ms |
| poll response time | 283–302 ms |
| decoded payload | **61 377 bytes** |
| **gap from poll `responseEnd` to long-task `startTime`** | **2.1 / 2.3 / 2.2 ms — median 2.2 ms** |

Three long tasks, three polls, every one of them starting ~2 ms after its payload
finished arriving, with nothing touching the mouse. The period is
`TEAM_POLL_MS + fetch` — `6000 + ~290 = ~6290`, which is the number §2.4(i) fit
blind. The cadence is declared at
[`forge-control-web/app/desktop/team/ChatTeamPanel.tsx:91`](../../../../forge-control-web/app/desktop/team/ChatTeamPanel.tsx)
(`const TEAM_POLL_MS = 6_000;`), and React Query's `refetchInterval` reschedules
after the fetch resolves, which is why the period is 6 290 and not 6 000.

The work itself is the panel's payload: `/api/chat/bfd1283a…/team` returns 1
manager + 95 workers + 6 sub-agents = **102 rows**, 61 KB, parsed and reconciled
into the tree every six seconds.

**Chrome's own attribution says the same thing, negatively.** Every `longtask`
entry in all three runs carries `name: "self"` with
`attribution: [{containerType: "window", containerName: "", containerId: "",
containerSrc: ""}]` and `name: "unknown"` — same-window work that Chrome cannot
pin to a frame container. That is what a `PerformanceObserver` can tell you; it
cannot name a call stack. The poll alignment in (iii) is the evidence that names
it, and it is causal-looking rather than merely correlated because the pointer
was stationary for the entire 30 s.

**GC:** no long task in any run is attributed to a container other than the window,
and none appears outside the 6.29 s lattice. There is no separate GC population to
call out.

### 2.5 One field that must not be over-read

`crossingsInsideTask` is 0 for every long task, and `insideACrossing` is
correspondingly false. **Do not read that as evidence.** A crossing's timestamp is
stamped when `page.mouse.move` *resolves*; if the main thread is blocked, the CDP
round-trip resolves only after the block clears, so that counter is biased toward
zero by construction. The script says so at the field. The load-bearing evidence
is the idle floor (§2.3) and the cadence plus poll alignment (§2.4).

---

## 3. Verdict on gate clause (b) — scripting ms, and what is *not* computable

`03-quality.md` §4 (b): *total scripting ms reduced ≥ 50 % vs baseline if baseline
≥ 120 ms.*

### 3.1 Not computable from committed evidence — stated plainly

**The phase-400 baseline never measured scripting ms.** `phase400/hover-cost-before.json`
contains exactly these keys:

```
label, base, rows_on_screen, window_ms, crossings,
idle{commits, mutations}, hover{commits, mutations},
attributable_to_hover{commits, mutations}
```

There is no `ScriptDuration`, no trace, no total main-thread scripting figure —
for the baseline or for `hover-cost-after.json`. A "≥ 50 % reduction vs baseline"
therefore **cannot be computed against that baseline at all**, and no number in
this round should be presented as clearing clause (b). It is not cleared; it is
**not evaluable**, and the reason is a gap in phase 400's instrument, not a
regression here.

### 3.2 What IS computable — and its honest label

`Performance.getMetrics` deltas around each window, in ms. ***These are Chrome's
renderer-wide cumulative counters. They are an aggregate, NOT a trace attribution.***
They include the 6 s team poll, React, browser internals and GC; they cannot
separate hover handling from any of it. The script repeats this label on every
record it writes.

`ScriptDuration` per 10 s window, median of 5 pairs:

| | run1 idle | run1 hover | run2 idle | run2 hover |
|---|---|---|---|---|
| rail | 151.1 ms | 185.0 ms | 163.5 ms | 166.5 ms |
| team | 146.2 ms | 201.1 ms | 134.4 ms | 222.2 ms |

Median per-pair `hover − idle`: rail **+73.4 / +3.0 ms**, team **+59.9 / +65.7 ms**
per 10 s window. Read that against what produced it: ~150 crossings in ten
seconds is fifteen rows per second of continuous sweeping, far past any human
hovering rate, and the added scripting is **under 1 % of the main thread over the
window** and forms **no task longer than 50 ms** (§2). It is real, it is small,
and it is bounded — but it is an aggregate, so it is offered as context, never as
a gate pass.

### 3.3 What IS a pass, from phase 400

The commit/mutation collapse the phase-400 protocol actually measured, on the
surface Konrad complained about:

| chat rail, 10 s, ~76 crossings | react commits attributable to hover | DOM mutations |
|---|---|---|
| phase 400 `before` | **77** | **1 057** |
| phase 400 `after` | **1** | **0** |
| re-run on the round-504 build | 0 | 0 |
| **this round, per pair (attributable mutations)** | — | rail `[-2,-2,10,-2,-2]` / `[-6,2,3,-7,1]`, team `[-16,2,-3,-12,-1]` / `[-6,0,-1,-3,0]` |

**That is a gate pass, and it is phase 400's, not this round's.** This round's
mutation deltas hover around zero and go negative — noise around a true zero,
because the mutations that occur are the poll's, and whether one or two polls land
inside a given 10 s window is a coin flip (see §4).

**Summary of clause (b): NOT EVALUABLE against the committed baseline.** The
scripting-ms comparison the gate specifies requires a baseline number that phase
400 never captured. Phase 400's own commit/mutation gate passed (77 → 1, 1 057 →
0) and is unaffected by this round.

---

## 4. The >2× spread rule — triggered, disclosed, re-run, explained

`03-quality.md` §4 *Honesty rules*: *if the runs disagree wildly (> 2× spread),
note VPS load and re-run rather than cherry-picking.*

**It triggered**, on the idle `ScriptDuration` aggregate, in all four
surface × run cells:

| | run1 idle spread | run2 idle spread |
|---|---|---|
| rail | **2.01×** | **2.47×** |
| team | **2.69×** | **2.89×** |

Long-task counts did not exceed 2× anywhere (ratio 1.0 in all four cells), and
hover `ScriptDuration` did not either (1.44–1.66×).

**Load at the time**, recorded before and after every pair (`osBefore`/`osAfter`
per pair in the JSON): 1-minute load average ranged **1.89 → 3.26** across run1
and **1.97 → 3.04** across run2, on 16 CPUs. That is a busy but not saturated VPS.

**I re-ran rather than picking.** Both 5-pair runs are committed in full; run2 is
the mandated re-run and neither is dropped. They agree on every conclusion: team
median 0 in both, rail median 0 and −1, cadence `fits: true` in both with base
periods 11 ms apart.

**And the spread has a mechanism, not just a load excuse.** Sorted idle
`ScriptDuration` per surface is bimodal:

```
run1 rail idle  [ 90.6, 111.6, 151.1, 176.4, 181.8]
run1 team idle  [ 68.6,  75.8, 146.2, 155.5, 184.9]
run2 rail idle  [ 78.0, 143.4, 163.5, 166.9, 192.9]
run2 team idle  [ 58.7,  81.9, 134.4, 154.1, 169.5]
```

A low cluster near 60–110 ms and a high cluster near 135–195 ms, in a ratio of
about two. A 10 s window divided by a 6.29 s poll period is 1.59 — so a window
contains **either one poll landing or two**, never a stable number. The 2× spread
*is* that quantization. It is a property of measuring a 6.29 s periodic cost in a
10 s window, not of VPS noise, and it would not shrink by re-running a third time;
it would shrink by making the window an integer multiple of the poll period. That
is a note for whoever writes the next instrument, not a fix this round is allowed
to make.

---

## 5. Environment and build under test

| | |
|---|---|
| `git rev-parse HEAD` of the tree that was rsynced and built | **`8d6a59782138f68ef2d5316919e4d46422f4fa9b`** |
| what that SHA is | **the worktree's commit**, `project/8ea0cc08`. It is *not* a hash of the build output; the `/tmp/phase1291b-web` copy was built from this tree with `FORGE_CONTROL_URL=http://127.0.0.1:7798`. |
| `nproc` | **16** |
| `uptime` at run1 start | `01:16:32 up 25 days, 5:50, 9 users, load average: 1.89, 2.41, 2.94` |
| `uptime` at run2 start | `01:20:18 up 25 days, 5:54, 9 users, load average: 2.33, 2.64, 2.94` |
| `/proc/uptime` run1 start → end | `2181023.51` → `2181244.48` |
| `/proc/uptime` run2 start → end | `2181250.06` → `2181471.07` |
| load average, per pair | in `runs.<label>.surfaces.<s>.pairs[].osBefore/osAfter` — 1-min range **1.89–3.26** |
| viewport | 1600 × 1000 |
| browser | chromium from `/root/.cache/ms-playwright/chromium-1234`, playwright by absolute path from `/opt/hermes-workspace/node_modules` (NFU8 — neither repo gains a dependency) |
| target | worktree build on **`http://127.0.0.1:7790`** → API harness **`:7798`**. **No production URL was contacted**; the script throws if `HOVER_BASE_URL` names the production host. |

### Surfaces measured

| surface | what | rows measured |
|---|---|---|
| rail | chat rail rows, same selector family phase 900 used | **7** per pair, every pair of both runs |
| team | team panel of run `bfd1283a-b71b-4f35-b577-7d09aad803f2` | **21** per pair, every pair of both runs |

The team surface is the manager chat run **`bfd1283a-b71b-4f35-b577-7d09aad803f2`**,
title beginning *"Okay when I click the file section"* — the same run
`phase700/hover-700.cjs` and `phase900/hover-904.cjs` used.

**Rows: 21, not 26 — and that is a fidelity fix, not a shortfall.** The panel
mounts **102** `[data-team-row]` elements for this chat (1 manager + 95 workers +
6 sub-agents, matching the endpoint exactly). Only **21** fit fully inside a
1000 px viewport at 43 px per row. `hover-904.cjs` took `.slice(0, 26)` of the
*unfiltered* list, so roughly five of its twenty-six targets were below the fold
and those pointer moves could not land on a row. This round filters to
`top >= 0 && bottom <= innerHeight` before sweeping, and re-reads the boxes before
every pair because the panel is live. §6.2 shows the assertion that this actually
worked.

---

## 6. How this round verified itself

### 6.1 The JSON is valid, and every number above is in it

```bash
python3 -m json.tool docs/plan/artifacts/phase1290/hover/hover-1291.json > /dev/null && echo "valid JSON"
```
→ `valid JSON` (252 KB, committed raw and unfiltered).

Proving one quoted number — the headline team median, and the poll-alignment gaps:

```bash
python3 -c "import json;d=json.load(open('docs/plan/artifacts/phase1290/hover/hover-1291.json'));\
print([d['runs'][r]['surfaces']['team']['summary']['medianAttributableLongTasks'] for r in ('run1','run2')]);\
print(d['runs']['control']['control']['app']['gapFromPollResponseEndMs']['values'])"
```
→ `[0, 0]`
→ `[2.1, 2.3, 2.2]`

### 6.2 The sweep really hovered rows

`03-quality.md` §5 briefs the red-team reviewer to attack exactly this ("sweep
script not actually hitting rows"). Three times inside every hover window — at
crossings 5, 40 and 90 — the script asks the page which elements match `:hover`
and asserts that **the element the browser reports at the target coordinates is
the same element the browser reports as `:hover`**, and that it is not BODY/HTML.
The assertion does not trust a class name, so it works on both surfaces.

| | probes | passed |
|---|---|---|
| run1 rail | 15 | **15** |
| run1 team | 15 | **15** |
| run2 rail | 15 | **15** |
| run2 team | 15 | **15** |
| **total** | **60** | **60** |

On the team surface the probes additionally report `teamRowHovered` — the hovered
element resolves to a `[data-team-row]` ancestor. `hoverProbeAllPassed: true` for
all four surface/run cells. Crossings per window: **149–150**, matching round
904's 150.

No screenshot is written: the round is allowed exactly three files, and the DOM
assertion is the stronger of the two options §5 offers — it proves the pointer was
on a row at the instant it claims, which a PNG only suggests.

### 6.3 No-regression gates (this round changed no TypeScript)

```bash
(cd forge-control && npx tsc --noEmit)        # exit 0
(cd forge-control-web && npx tsc --noEmit)    # exit 0
```
→ `forge-control tsc exit=0`, `forge-control-web tsc exit=0`

```bash
git status --short
```
→ `?? docs/plan/artifacts/phase1290/`  — the three files of this round and nothing else.

```bash
git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
```
→ *(no new match from this round)*

**No cadence was slowed and no hover affordance was removed to make a number look
better.** No application file was opened for writing; `git status` is the proof.
`TEAM_POLL_MS` remains `6_000` at `ChatTeamPanel.tsx:91` — this round *identified*
it as the source of the long tasks and deliberately left it alone, because
phase 1300 owns fixes.

---

## 7. Reproducing — runs verbatim

Occupied ports at the time of writing: 7700, 7701, 7798, 7811, 7814, 7815, 7817
(and 7790 while this round's server is up). **Check `ss -ltn` before binding and
never kill another round's process.** The recipe is `phase500/README.md` §2,
steps A–E, with the copy and port moved.

> **Changed 2026-08-17 (round 1301): step E now writes to `/tmp`, not to this
> directory.** `hover-1291.cjs` used to resolve its output to `__dirname`
> unconditionally, so running this very block **overwrote `hover-1291.json` —
> the committed evidence the reproduce is meant to check against**. Round 1293
> had to copy the script to /tmp to work around it. The default is now
> `/tmp/hover-1291-out`; writing into `docs/plan/` requires `--commit-artifact`
> (into this directory) or `HOVER_OUT=<dir>`. Only output-path resolution
> changed — no measurement logic was touched, so numbers stay comparable.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# A) worktree API on :7798 — ALREADY UP. Never boot forge-control/src/index.ts.
curl -s 127.0.0.1:7798/api/health

# B) build the web app AGAINST the harness, into an ISOLATED copy.
#    Do NOT rebuild forge-control-web/.next in place — other rounds serve from it.
rm -rf /tmp/phase1291b-web && mkdir -p /tmp/phase1291b-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase1291b-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase1291b-web/node_modules
cd /tmp/phase1291b-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the session cookie (read-only source of the live env file)
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase1291 hover sweep", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 240 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-phase1291.txt && rm mint-cookie.mjs

# D) serve the copy on :7790. AUTH_URL must match the port and AUTH_SECRET must be
#    in the SERVER env, not just the minting subshell (MissingSecret otherwise).
ss -ltn | grep -E ':779[0-9]' || true
AUTH_URL=http://127.0.0.1:7790 FORGE_CONTROL_URL=http://127.0.0.1:7798 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7790 &

# E) run the script from the WORKTREE against that server
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1291.txt)"
export HOVER_BASE_URL=http://127.0.0.1:7790
export HOVER_BUILD_SHA="$(git rev-parse HEAD)" HOVER_UPTIME="$(uptime)"

# these write to /tmp/hover-1291-out/hover-1291.json — the committed artifact
# is NOT touched. Add --commit-artifact only when you mean to replace it.
HOVER_RUN_LABEL=run1 node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
HOVER_RUN_LABEL=run2 node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
HOVER_RUN_LABEL=control HOVER_CONTROL=1 node docs/plan/artifacts/phase1290/hover/hover-1291.cjs

# F) no-regression gates
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit)
git status --short
```

Each invocation merges its result into `<OUT>/hover-1291.json` under
`runs.<label>`; delete that file first for a clean set. Knobs: `HOVER_PAIRS`
(default 5), `HOVER_WINDOW_MS` (default 10000), `HOVER_CONTROL=1` (mechanism
check instead of sweep), `HOVER_OUT` / `--commit-artifact` (output directory —
see the note above; default `/tmp/hover-1291-out`). Wall-clock: ~4 min per
5-pair run, ~2 min for the control.

---

## 8. Recommendations for phase 1300 — NOT implemented here

Round 1291 is forbidden from touching application code, and did not. These are
findings handed forward; phase 1300 decides.

1. **The only >50 ms tasks on this surface are the team poll's, at 61 KB and 102
   rows every 6 s.** If Konrad ever feels a hitch on this chat, this is what he is
   feeling, and it is unrelated to the pointer. The cheapest honest levers, in
   order of how little they cost the user: *(a)* stop re-parsing what did not
   change — the payload is fully re-materialised every 6 s though almost all 95
   worker rows are settled and frozen; *(b)* trim the payload server-side for
   settled rows; *(c)* window the list, since only 21 of 102 rows can be on screen.
   **Do not reach for slowing the poll** — `ChatTeamPanel.tsx:86-90` records that
   6 s was already chosen against a committed 40 req/min ceiling, and §4's honesty
   rule forbids buying a number with cadence.

2. **The measurement window should be an integer multiple of the poll period.**
   A 10 s window over a 6.29 s poll makes every aggregate bimodal (§4) and is the
   sole reason the >2× spread rule fired. A 12.6 s or 25.2 s window would make
   `ScriptDuration` comparisons stable enough to be worth quoting.

3. **Clause (b) of the numeric gate is unmeasurable as written** (§3.1) — phase
   400 never captured scripting ms, so nothing downstream can compute a reduction
   against it. Either re-baseline with `Performance.getMetrics` on a pinned
   pre-fix commit, or amend `03-quality.md` §4 to state that clause (b) is
   retired and the commit/mutation collapse is the standing evidence. Leaving it
   as an open gate no round can pass is the worst of the three.

---

## 9. Files

| File | What |
|---|---|
| `hover-1291.cjs` | the instrument — five interleaved idle/hover pairs per surface, long-task attribution, crossing alignment, CDP metric deltas, and the `HOVER_CONTROL=1` mechanism check. **Writes to `/tmp/hover-1291-out` by default since round 1301**; `--commit-artifact` or `HOVER_OUT=<dir>` to write elsewhere, and it throws rather than writing inside the repo without one of them |
| `hover-1291.json` | raw output of ROUND 1291, committed unfiltered: `runs.run1`, `runs.run2`, `runs.control`. Round 1301's re-run of the control leg lives in `docs/plan/artifacts/phase1300/baseline/` and did not touch this file |
| `README.md` | this file |

`docs/plan/artifacts/phase1290/invalidation/` and
`docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md` belong to
sibling tasks in this round and were not touched.
