# Round 1305, fix cycle 1 — the three red-team findings, fixed and gated

Reviewer verdict under repair: *"Red team: stale UI after memoization, lost rows
after windowing, lying instruments"* (`../redteam/README.md`, commit `3b2b3d8`),
**NEEDS_FIXES**, findings F1 / F2 / F3.

**No application code was touched.** All three findings are about instruments and
the prose around them, and so is this fix. `git status` at the end of the round
shows `docs/plan/artifacts/` only; §6 pastes it.

---

## 0. The one-line answer per finding

| | finding | what changed | how you can tell it is fixed |
|---|---|---|---|
| **F1** | the hover probe's `pass` omitted row membership, so a coordinate on a plan-Kanban card passed | `pass` now requires the hovered element to resolve to a row **of the surface being swept**; the picker clips candidate rows to their scroll container; a missing probe makes the run exit **1** | `probe-1305.cjs` — 14/14, and it **fails on the old assertion by construction** |
| **F2** | the reproduce block told every round `:7798` was "ALREADY UP", and it was 12 h stale | step A starts your own harness and asserts **freshness** against a field this worktree deleted; `/api/health` is called out as a production pass-through that proves nothing | run step A against a stale server: it prints `STALE API` and stops |
| **F3** | `buildShaUnderTest` names a commit, and a dirty tree makes that a commit nobody built | the run now records its own `git status --porcelain`, plus a **sha256 over the source bytes** of the built copy and its `.next/BUILD_ID` | this round's own artifact: HEAD identical across three runs, tree **dirty**, source hash **identical** — the hash is what carries the claim |

---

## 1. F1 — the sweep could not prove it hovered rows. Now it must.

### 1.1 The defect, in one line

`hover-1291.cjs:234` (at `3b2b3d8`):

```js
pass: Boolean(sameNode && deepest && deepest.tagName !== "BODY" && deepest.tagName !== "HTML"),
```

`teamRowHovered` was computed nine lines above and never read. Any non-body
element under the pointer passed — a Kanban card, a header, a gap left by a
reflow. `hoverProbesAllPassed: true` therefore meant *"something was under the
pointer"*, and the README read it aloud as *"the sweep really hovered rows"*.

### 1.2 It was not a near miss: 9 of 21 targets were off the list

`geometry-1305.cjs` measures both targeting rules on the real build, at one
instant, and asks `elementFromPoint` what each coordinate actually paints
(`geometry-1305.json`, `geometry-1305.png` — green dots are round 1305's targets,
red dots are round 1291's targets that are on no row at all):

| | |
|---|---|
| `[data-team-row]` in the DOM | **115** |
| the panel's scroll box `[data-team-scroll]` | top **85**, bottom **616** — **531 px** visible of a **4 945 px** list |
| round 1291's rule (rect inside the **viewport**), capped at 26 | **21 targets** |
| …of those, coordinates that resolve to **no row at all** | **9** — 43 % of the sweep |
| round 1305's rule (rect ∩ every scrolling ancestor, centre verified) | **13 targets**, all on rows |

The nine strays land on the plan Kanban below the panel — including
`"Phase 2 review — kind truth (R7-R11): gate, stranger test, t…"`, the exact card
the red team quoted from the committed JSON. The cause was never the assertion
alone: **rows were clipped to the viewport, not to the box they scroll in**, so a
row 4 000 px down the list still had a viewport-visible rect and was swept.

### 1.3 The fix

`../../phase1290/hover/hover-1291.cjs`:

- `HOVER_PROBE(arg)` takes `{ target, rowSelector }`. `pass` requires
  `sameNode && not BODY/HTML && rowHovered && atPointInRow` — both directions,
  because they fail differently: `rowHovered` says the browser agrees the pointer
  is on a row, `atPointInRow` says the coordinate itself is still on the list.
  `teamRowHovered` is kept, computed exactly as before, so the old artifacts stay
  readable; on the rail it is expected to be `false`, which is precisely why
  `pass` must not read it.
- `missedOnto` records what the pointer hit when it missed — the diagnostic whose
  absence let this survive five rounds.
- `CLIPPED_BOXES` picks targets by intersecting each row with every scrolling or
  clipping ancestor and the viewport, taking the centre of that intersection, and
  keeping the box only if `elementFromPoint` there resolves to a row. That last
  check is the same question the in-window probe asks, asked once outside the
  measured window, so a box can no longer be born wrong.
- surfaces now declare their selector: `[data-team-row]` (team),
  **`.chat-row`** (rail — the app's own class, the one `globals.css` hangs the
  CSS-only ✕/age swap on, not a name invented by the instrument).
- probes fire at crossings **0, 5, 40, 90, 140** (was 5, 40, 90): the two known
  failure modes live at the ends — a mis-picked box shows at 0, a mid-window
  reflow shows late.
- **the run refuses to certify itself.** Any failed probe sets
  `sweepValid: false`, prints `SWEEP INVALID` with the misses, and exits **1**.
  `HOVER_ALLOW_PROBE_FAILURE=1` downgrades that to a recorded warning for
  diagnosis, and the JSON records that the override was used.

### 1.4 The gate — it fails on the old code, which is the only thing that matters

`probe-1305.cjs` requires `HOVER_PROBE` and `CLIPPED_BOXES` **from
`hover-1291.cjs` itself** (not a copy, so it cannot certify a stale duplicate),
and runs them against a synthetic page that reproduces the geometry: 40 rows of
40 px in a 300 px scroll box, a Kanban card painted directly below. No server, no
cookie, no build; ~5 seconds.

```
$ node docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs
fixture: 25 boxes by the viewport rule, 8 by the clipped rule

PASS  [F1-a] the viewport rule targets coordinates outside the panel
PASS  [F1-b] pointer is on the Kanban card, not on a row
PASS  [F1-c] OLD probe passes there — the finding, reproduced
PASS  [F1-d] NEW probe fails there
PASS  [F1-e] NEW probe says why: no row under the pointer
PASS  [F1-f] NEW probe records what it hit instead
PASS  [F1-g] NEW probe passes on a genuine row
PASS  [F1-h] …and reports the row it hovered
PASS  [F1-i] …with the row's own text
PASS  [F1-j] every clipped box lies inside the panel's scroll box
PASS  [F1-k] all 8 clipped boxes hover a row
PASS  [F1-l] rail picker returns only rows inside the rail's scroll box
PASS  [F1-m] NEW probe passes on a rail row with the rail selector
PASS  [F1-n] …and teamRowHovered is false there, which is why `pass` must not read it

ALL PASS — .../fix-1305/probe-1305.json
```

`F1-c` is the load-bearing line: the pre-1305 assertion, pasted verbatim, passes
on a Kanban card in the same browser at the same coordinate where the new one
fails. A gate that only proved the new code green would prove nothing.

### 1.5 And the exit code is real, not a claim

`HOVER_SABOTAGE_BOXES=<px>` deliberately aims the sweep off the rows so a
reviewer can watch the assertion fail. `sabotage-1305.out`, verbatim:

```
    MISS team pair 1 crossing 5 box 5 @(1470,722): rowHovered=false atPointInRow=false sameNode=true
         deepest=<SPAN class=""> onto="Plan phase 1: time truth (frozen settled durations)"
…
SWEEP INVALID — rail: 1/3 probes on a row; team: 2/3 probes on a row.
These numbers are NOT a hover measurement: the pointer was provably off the rows for part of at least one window.
```

Exit code **1**. The sabotaged run landed on a Kanban card and said so, which is
F1's failure mode reproduced end to end on the live build and then caught.

### 1.6 The prose is corrected, and the old claim is retracted in place

`../../phase1290/hover/README.md` §6.2 now opens with a retraction: the 60/60
table means *"60 probes found a non-body element under the pointer"*, and the
field that mattered — `teamRowHovered` — is `false` in **10 of the 20**
team-surface probes. §2.3's idle floor and §2.4's poll lattice are **not**
withdrawn: neither depends on where the pointer was, and §2.4(iii) holds the
pointer still. Only "the sweep hovered N rows" is withdrawn. No other document in
`docs/` cites `hoverProbesAllPassed` (`grep`, §6).

---

## 2. The re-run, on the fixed instrument

A fixed instrument that is never run proves nothing, so the full protocol was
re-run against a **fresh** rig: worktree API on `:7789` (`SERVE_V3_PORT`, started
this round, `task.id` verified absent), an isolated `next build` of the worktree
in `/tmp/phase1305-web` served on `:7792`, `BUILD_ID` `WYKAndr6p95ItKdmnNXST`.
Two 5-pair runs plus the control leg; `hover-1291.json` here, console in
`sweep-1305.out`.

### 2.1 The assertion that failed round 1291 now passes on its own terms

| | probes | on a row (`rowHovered`) | `pass` | misses |
|---|---|---|---|---|
| run1 rail (`.chat-row`) | 25 | **25** | **25** | 0 |
| run1 team (`[data-team-row]`) | 25 | **25** | **25** | 0 |
| run2 rail | 25 | **25** | **25** | 0 |
| run2 team | 25 | **25** | **25** | 0 |
| **total** | **100** | **100** | **100** | **0** |

`sweepValid: true` in both runs, exit code 0 in both. Crossings per window
**147–150**, unchanged from rounds 904 and 1291 — the stricter targeting did not
buy its pass by sweeping less. Rows targeted: rail **7**, team **13** (of 115 in
the DOM; §1.2 explains why 13 and not 21, and why the old 21 was wrong).

### 2.2 The numbers, with the poll fix underneath them

`attributable = hover window count − idle window count`, per pair, exactly as
round 904 defined it. Each cell is one 10 s window.

| | rail idle | rail hover | rail attr | team idle | team hover | team attr |
|---|---|---|---|---|---|---|
| run1 | `[1,0,0,0,0]` | `[0,0,0,0,0]` | median **0** | `[0,0,0,0,0]` | `[0,0,0,0,0]` | median **0** |
| run2 | `[1,0,0,0,0]` | `[0,1,0,0,0]` | median **0** | `[0,0,0,0,0]` | `[0,0,0,0,0]` | median **0** |

**The team surface produced zero long tasks over 100 s of sweeping and 100 s of
parked-pointer idling, in both runs.** That is not this round's doing — it is
round 1302's payload trim and memoization, now visible on an instrument that can
be trusted about where the pointer was:

| long tasks > 50 ms, pooled per surface per run | round 1291 (pre-1302) | this round |
|---|---|---|
| rail idle / hover (50 s each) | 4–6 / 3 | **1 / 0** and **1 / 1** |
| team idle / hover (50 s each) | 2–4 / 2–3 | **0 / 0** and **0 / 0** |
| whole session | 13–14 long tasks, fitting a 6 294 ms lattice | **1–2 long tasks — too few to fit a cadence at all** |

The control leg (pointer never moved, 30 s on the manager chat) says the same
from the other side: `about:blank` **0** long tasks; the app **1** long task of
53 ms across **5** `/team` polls, where round 1291's control saw **3** (51, 55,
66 ms) across its 5 polls. Poll
intervals **6 313.6–6 341.6 ms**, response 311–339 ms, payload **65 165 bytes**
(115 rows now, up from 102 — the tree grew, so bytes are not comparable across
rounds). The one long task still starts **2.8 ms** after its poll's `responseEnd`:
what remains of the poll cost is the same shape, just rarer.

### 2.3 The honesty rules, applied

- **`ScriptDuration` remains a renderer-wide aggregate**, not an attribution, and
  is quoted as context only — never as a gate pass. Medians per 10 s window:
  run1 rail 246.1 idle / 282.3 hover, run1 team 133.8 / 191.5; run2 rail 131.1 /
  160.8, run2 team 129.5 / 124.8. Note run2 team hover is *below* its idle.
- **The > 2× spread rule fired again**, on the idle aggregate: run1 rail
  **5.47×** (81.5 → 446.2 ms), run1 team 1.64×, run2 rail 2.28×, run2 team 2.15×.
  **Both runs are committed in full and neither is dropped.** Round 1291 §4
  already diagnosed the mechanism — a 10 s window over a ~6.3 s poll period
  contains either one poll landing or two — and run1's rail cell is worse than
  that because the machine was also busier at its start (1-minute load 1.75 →
  2.44 across the run). The long-task counts, which is what the gate reads, are
  identical in shape across both runs.
- **No cadence was slowed and no affordance removed.** `TEAM_POLL_MS` is still
  `6_000`; the observed intervals prove it. No application file was written this
  round at all (§5, §6).

---

## 3. F2 — the reproduce block no longer trusts a server it did not start

`../../phase1290/hover/README.md` §7 step A said *"worktree API on :7798 —
ALREADY UP"* and proved it with `curl :7798/api/health`. Two independent faults:

1. **`/api/health` is a pass-through.** `serve-v3-7798.ts` mounts `agents`,
   `chat`, `projects`, `capabilities` and `secrets`, and proxies everything else
   to production `:7700` — the harness's own header says so, and says the
   pass-through proof was deliberately moved to `/api/health`. So `ok` there is
   production answering, whatever the mounted routers are.
2. **The process was 12 h old**, from before round 1302's payload trim, and still
   served `task.id`.

Step A now starts a private instance on a port you choose and asserts
**freshness against a field this worktree deleted**:

```bash
curl -s "127.0.0.1:7789/api/chat/$CHAT/team" | jq -e '.workers[0].task|has("id")|not' \
  && echo "API is this worktree (task.id trimmed)" \
  || { echo "STALE API — it still ships task.id. Do not measure against it."; exit 1; }
```

Run against this round's own harness (`SERVE_V3_PORT=7789`):

```
$ curl -s 127.0.0.1:7789/api/chat/bfd1283a-…/team | jq -c '.workers[0].task'
{"round":0,"role":"architect","title":"Plan: operator-visibility","status":"completed"}   ← no id
```

**The stale `:7798` process was left running.** Another round is serving from it
and killing it is not this task's call; the recipe now refuses to trust it, which
is the fix that was asked for. Steps B–E were re-pointed to this round's ports
(API `:7789`, web `:7792`) so the block is internally consistent, and step F now
runs the probe gate.

---

## 4. F3 — provenance that can answer "did you measure what you shipped"

`buildShaUnderTest` is `git rev-parse HEAD` **as passed in**, and its own
`shaNote` conceded it is not a hash of the build. With uncommitted work in the
tree — the normal case mid-round — it names a commit nobody built. That is how
`lattice-1302.json` came to record `b3bd80f` for a build of a fix that landed as
`92aeb0f`.

The run now records, itself, without trusting its caller:

| field | what it is |
|---|---|
| `env.gitProvenance` | `head`, `headSubject`, `branch`, `dirty`, `dirtyFileCount`, and **`statusPorcelain` verbatim** — measured by the run, not passed in |
| `env.sourceTree.sha256` | sha256 over the **source bytes** of `HOVER_BUILD_DIR` (sorted `relpath\0sha256` lines; `node_modules`, `.next`, `.git`, symlinks excluded), with `fileCount` and `byteCount` |
| `env.sourceTree.buildId` | `.next/BUILD_ID` of that copy — names the compiled bundle being served, which a source hash cannot |
| `env.shaNote` | now says plainly that `buildShaUnderTest` must not be read alone |

A missing `HOVER_BUILD_DIR` is recorded as `{ ok: false, hashed: false, reason }`,
never as a null that reads like "nothing to report".

**This round's own artifact is the demonstration**, and it is exactly the case
F3 describes: all three runs have `head: 3b2b3d8`, all three ran with a **dirty**
tree (2 files at run1, 4 by run2 — this README's siblings being written), and all
three carry **the same `sourceTree.sha256`**. The commit id says nothing; the
source hash says the three runs measured one identical build. `../payload/README.md`
§1 carries the same caveat for `lattice-1302.json`, whose measurements stand —
only its provenance field is downgraded.

---

## 5. What this round did NOT do

- **No application code.** Not one file under `forge-control/` or
  `forge-control-web/` was opened for writing. The rail's `.chat-row` selector
  already existed; nothing was added to the DOM for the instrument's benefit.
- **`hover-1291.json` (round 1291's committed evidence) was not overwritten.**
  This round's runs wrote to `HOVER_OUT=docs/plan/artifacts/phase1300/fix-1305`.
- **No process was killed**, including the stale `:7798` (F3 §3).
- **Attacks 3 and 4 of the red team's list stay unrun.** They were deferred
  because they would have inherited F1; F1 is now fixed, so they are runnable —
  but they are the reviewer's to run, not the fixer's to grade.
- **Production and `/opt/forge-ai-os` were not touched.** Everything ran against
  a worktree build served on `:7792` talking to a worktree API on `:7789`.

---

## 6. Gates

```bash
$ (cd forge-control && npx tsc --noEmit); echo "forge-control tsc exit=$?"
$ (cd forge-control-web && npx tsc --noEmit); echo "forge-control-web tsc exit=$?"
$ node docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs; echo "probe gate exit=$?"
$ grep -rn "hoverProbe" docs/ --include=*.md | grep -v "phase1290/hover/README.md\|phase1300/redteam\|fix-1305"
$ git status --short
```

```
forge-control tsc exit=0
forge-control-web tsc exit=0
ALL PASS — .../fix-1305/probe-1305.json
probe gate exit=0
(grep: no match outside the three documents that discuss the finding)
valid JSON
 M docs/plan/artifacts/phase1290/hover/README.md
 M docs/plan/artifacts/phase1290/hover/hover-1291.cjs
 M docs/plan/artifacts/phase1300/payload/README.md
?? docs/plan/artifacts/phase1300/fix-1305/
```

`npm run build` for `forge-control-web` was run as an **isolated** `next build`
in `/tmp/phase1305-web` (exit 0, `BUILD_ID` `WYKAndr6p95ItKdmnNXST`, manifest
pinned to `127.0.0.1:7789`) — the brief forbids rebuilding
`forge-control-web/.next` in place while other rounds serve from it.

`git diff --name-only main...HEAD` adds no match for `project-tick|cc-runner|
executor\.ts|db/projects|VaultFileList|routes/files` from this round: it touches
`docs/` only.

---

## 7. Files

| file | what |
|---|---|
| `probe-1305.cjs` / `.json` | the F1 gate — synthetic page, both assertions, 14 checks, requires the probe from `hover-1291.cjs` rather than copying it |
| `geometry-1305.cjs` / `.json` / `.png` | the two targeting rules measured on the real build; the PNG marks off-list targets red and clipped targets green |
| `hover-1291.json` | this round's re-run: `runs.run1`, `runs.run2`, `runs.control`, raw and unfiltered |
| `sweep-1305.out` | console of the three runs, verbatim |
| `sabotage-1305.out` | `HOVER_SABOTAGE_BOXES=400`, showing `SWEEP INVALID` and exit 1 |
| `../../phase1290/hover/hover-1291.cjs` | the instrument (modified) |
| `../../phase1290/hover/README.md` | §6.2 retraction (F1), §7 step A freshness (F2) |
| `../payload/README.md` | §1 provenance caveat on `lattice-1302.json` (F3) |

## 8. Reproducing

`../../phase1290/hover/README.md` §7 steps A–G, verbatim: they are this round's
actual commands. The short version, for the two gates that need no server:

```bash
node docs/plan/artifacts/phase1300/fix-1305/probe-1305.cjs          # F1, ~5 s
python3 -m json.tool docs/plan/artifacts/phase1300/fix-1305/hover-1291.json > /dev/null
```

**The rig is still up as of 2026-08-17 04:50 UTC** — API `:7789` (started 04:19),
web `:7792` serving `/tmp/phase1305-web`, `BUILD_ID` `WYKAndr6p95ItKdmnNXST`,
cookie in `/tmp/session-cookie-phase1305.txt` (valid 4 h from 04:21). It was left
running for the re-check, and it will go stale exactly like `:7798` did. **Do not
inherit it on trust**: run step A's freshness assert against it first, and if the
worktree has moved since this commit, rebuild rather than reuse. Nothing of mine
should be killed by a later round either — start your own port.

For the sweep and the geometry census you need the rig from §7 A–D (API `:7789`,
web `:7792`), then:

```bash
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1305.txt)"
export HOVER_BASE_URL=http://127.0.0.1:7792 HOVER_BUILD_DIR=/tmp/phase1305-web
export HOVER_OUT=/tmp/hover-1305-out                    # ← not the committed artifact
HOVER_RUN_LABEL=run1 node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
RT_BASE_URL=http://127.0.0.1:7792 GEOMETRY_OUT=/tmp/hover-1305-out \
  node docs/plan/artifacts/phase1300/fix-1305/geometry-1305.cjs
```
