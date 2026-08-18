# Phase 1300 — round 1301: the BEFORE numbers, and the instrument-hygiene fix

**Round 1301 changed no application code.** Its diff touches
`docs/plan/artifacts/phase1290/hover/hover-1291.cjs` (output-path resolution
only), `docs/plan/artifacts/phase1290/hover/README.md` (§7 and §9, to match), and
this directory. §7 pastes the gate output that proves it.

Everything below was measured on **a worktree build**, on ports this round bound
itself, against a worktree API harness. **No production URL was contacted and
`forge-control-web/.next` was never rebuilt in place.**

---

## 0. The four answers, on one screen

| | number |
|---|---|
| **B1 lattice** | base period **6 306.1 ms** (long run) / **6 309.8 ms** (short run), worst residual **0.5 % / 0.1 %**, `fits: true` in both. `about:blank` in the same browser: **0** long tasks in 25.2 s. Gap from `/team` `responseEnd` to long-task start: **2.0–3.2 ms, median 2.2 ms** over nine tasks |
| **B2 payload** | **65 257 bytes**, **108 nodes** (1 manager + 101 workers + 6 sub-agents). Biggest groups: `task` **16 797 B (25.7 %)**, `tokens` **9 939 B (15.2 %)**, `description` **9 453 B (14.5 %)**. **10.2 % of the payload is `description` repeating `task.title` verbatim**, on 93 of 108 nodes. **96.8 % of the payload belongs to rows that are already settled** and can never change again |
| **B3 DOM** | document **6 234–6 237** elements, **108** `[data-team-row]`, **13.0** elements per row (flat: min = median = max = 13), rows inside the scroller's own box **12 fully / 13 intersecting** — **not the 21** §5 of the 1291 README reports, and §4.3 explains why both numbers are honest |
| **B4 render** | hypothesis **CONFIRMED, twice, to the integer**. 25.2 s / 4 polls: **432 compares, 0 memo bailouts, 432 body renders** over 108 distinct rows. `row` differs on **432/432** compares and `responseNow` differs on **432/432** — memo is defeated twice over. But **428/432 inner nodes are identical to the previous poll's** — 99.1 % of the render work is provably avoidable |

**The one number a planner should carry out of here:** the panel re-renders
**108 rows per poll and bails out on none**, while the data says only **4 of
those 108 rows changed**.

---

## 1. Deliverable A — the instrument-hygiene fix

### 1.1 The bug

`hover-1291.cjs` resolved its output path with

```js
const OUT = __dirname;
```

so following that file's own README §7 reproduce block wrote
`docs/plan/artifacts/phase1290/hover/hover-1291.json` — **the committed evidence
the reproduce exists to check against**. Round 1293 worked around it by copying
the script to /tmp. This project has already been bitten once by a round
clobbering a predecessor's committed evidence; a reproduce recipe that destroys
its own reference is not a reproduce recipe.

### 1.2 The fix

`hover-1291.cjs` now resolves the output directory as:

- default → **`/tmp/hover-1291-out`** (created if absent);
- `HOVER_OUT=<dir>` → that directory, explicitly;
- `--commit-artifact` → `__dirname`, i.e. "yes, replace the committed artifact";
- and if the resolved target lands inside the repo with **neither** opt-in
  present, it **throws**, naming `--commit-artifact` and `HOVER_OUT` and printing
  both the resolved directory and the repo root.

The guard is a backstop rather than a routine path — with no opt-in the target is
`/tmp` and cannot resolve into the repo unless someone edits the default. It is
there so that editing the default is loud instead of silent. That is stated in
the code comment too; nobody should read the guard as doing more than it does.

**Only output-path resolution changed.** No line of measurement logic was
touched, so the numbers stay comparable to `hover-1291.json`. The other two
edits are the two `console.log`s that announce where the file went, which now
print the resolved path instead of a bare filename.

```bash
$ git diff --stat docs/plan/artifacts/phase1290/hover/
 docs/plan/artifacts/phase1290/hover/README.md      | 25 ++++++++++---
 docs/plan/artifacts/phase1290/hover/hover-1291.cjs | 43 ++++++++++++++++++++--
 2 files changed, 59 insertions(+), 9 deletions(-)
```

### 1.3 The proof — run it on defaults, artifact untouched

```bash
$ export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase1301.txt)"
$ export HOVER_BASE_URL=http://127.0.0.1:7831
$ HOVER_RUN_LABEL=control HOVER_CONTROL=1 node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
control: blank 0 long tasks in 10007ms | app 3 long tasks in 30004ms across 5 team polls (intervals [6309.8,6309.4,6301.7,6311.2])
control: gaps from poll responseEnd = [2.3,2.7,3.2] (median 2.7ms)

errors: 0
wrote control → /tmp/hover-1291-out/hover-1291.json (runs now: control)

$ git status --short          # taken immediately after the run, before §1.5's README edits
 M docs/plan/artifacts/phase1290/hover/hover-1291.cjs
?? docs/plan/artifacts/phase1300/

$ git diff --stat docs/plan/artifacts/phase1290/hover/hover-1291.json
(no output — the committed JSON is unmodified)
```

`hover-1291.json` does not appear in `git status` at all. The `M` is the `.cjs`
carrying this fix. §7.2 shows the same check at the end of the round, with the
README edit added.

### 1.4 `pseudo-invalidation.cjs` — checked, the bug is NOT present

The brief asks for the same fix in
`docs/plan/artifacts/phase1290/invalidation/pseudo-invalidation.cjs` *if present*.
It is not. That script already resolves (lines 74–81):

```js
const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE1290_WRITE === "1";
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE1290_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase1290-out"));
```

— a temp default plus two explicit opt-ins, which is exactly the shape round
1301 has just given `hover-1291.cjs`. It even prints
`committed evidence left untouched (<path>)` when it writes elsewhere (line
1348). **It was left alone.** Adding a repo-guard on top would be dead code:
the only route to `SRC_DIR` there is an opt-in, so the guard could never fire,
and changing `PHASE1290_OUT_DIR`'s meaning would break the sibling round's
documented invocation for nothing.

### 1.5 Documentation updated

`docs/plan/artifacts/phase1290/hover/README.md`:

- **§7** gains a note above the reproduce block saying what changed, why (this
  block used to overwrite `hover-1291.json`), and what the new default is; the
  step-E commands gain a comment stating where the output lands; the knobs
  paragraph documents `HOVER_OUT` / `--commit-artifact` and now says
  `<OUT>/hover-1291.json` rather than implying the committed file.
- **§9** file table records the new default on the `.cjs` row and marks
  `hover-1291.json` as round 1291's output, pointing at this directory for
  round 1301's re-run.

---

## 2. The rig — stated plainly, per the r808 rule

An unlabelled request-rate or perf number is worthless, so:

| | |
|---|---|
| worktree | `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`, branch `project/8ea0cc08` |
| `git rev-parse HEAD` at build time | **`8bbc4ee4a9752382983b49d6506daa5c90077b99`** — the worktree's commit, not a hash of the build output. Sibling tasks commit into this worktree concurrently, so this SHA moved during the round; every measurement below was taken against this one |
| API under test | **`http://127.0.0.1:7830`** — this round's OWN instance of `scripts/checks/serve-v3-7798.ts` (`SERVE_V3_PORT=7830`), routers only, never `forge-control/src/index.ts` |
| clean web build | `/tmp/phase1301-web`, served on **`:7831`** |
| instrumented web build (B4 only) | `/tmp/phase1301-web-inst`, served on **`:7832`** |
| **can this rig stream SSE?** | **NO.** `serve-v3-7798.ts` is a buffered writer: it awaits the whole upstream body before replying, and its own header says `GET /api/chat/:id/events is proxied on purpose (buffered writer cannot stream SSE)`. So the transcript on this rig is **not** receiving live SSE snapshots. Every number here is therefore a **floor**: a surface that is also streaming has strictly more main-thread work than this measured |
| ports checked first | `ss -ltn` before binding; 7700 / 7701 / 7791 / 7798 / 7811 / 7814 / 7815 / 7817 were already bound and **nothing was killed**. 7830 / 7831 / 7832 were free |
| browser | chromium from `/root/.cache/ms-playwright`, playwright by absolute path from `/opt/hermes-workspace/node_modules` (NFU8 — neither repo gains a dependency) |
| viewport | 1600 × 1000 |
| target chat | manager run **`bfd1283a-b71b-4f35-b577-7d09aad803f2`** |
| `nproc` | **16** |
| VPS load | recorded beside every number below; 1-minute load average ranged **2.43 → 3.36** across the whole round |
| production | **not contacted.** `hover-1291.cjs` throws on the production hostname; `dom-census.cjs` carries the same guard |

Boot commands, verbatim:

```bash
# API harness — own port, routers only
cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
SERVE_V3_PORT=7830 ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &
curl -s 127.0.0.1:7830/api/health
# → {"ok":true,"service":"forge-control","version":"0.1.0",...}

# clean build into an ISOLATED copy — forge-control-web/.next untouched
rm -rf /tmp/phase1301-web && mkdir -p /tmp/phase1301-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/phase1301-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/phase1301-web/node_modules
cd /tmp/phase1301-web
FORGE_CONTROL_URL=http://127.0.0.1:7830 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:7[0-9][0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7830

# cookie, then serve
AUTH_URL=http://127.0.0.1:7831 FORGE_CONTROL_URL=http://127.0.0.1:7830 \
  AUTH_SECRET="$AUTH_SECRET" ./node_modules/.bin/next start -p 7831 &
```

---

## 3. B1 — the lattice

Two `HOVER_CONTROL=1` runs, pointer never moved in either. The short one is the
brief's default window; the long one uses a 25.2 s window because
`phase1290/hover/README.md` §8 recommendation 2 asks for a window that is an
integer multiple of the poll period (4 × 6.3 s), and because two inter-task gaps
is a thin lattice to quote.

Command (identical but for the label and window):

```bash
HOVER_RUN_LABEL=control      HOVER_CONTROL=1                        node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
HOVER_RUN_LABEL=control-long HOVER_CONTROL=1 HOVER_WINDOW_MS=25200  node docs/plan/artifacts/phase1290/hover/hover-1291.cjs
```

| | `control` | `control-long` |
|---|---|---|
| app window | 30 004 ms | **75 605 ms** |
| `/team` polls in the window | 5 | **12** |
| long tasks > 50 ms | **3** | **6** |
| their durations, ms | 52, 59, 52 | 67, 59, 62, 60, 54, 55 |
| inter-task gaps, ms | 6 309.8, 12 613.4 | 6 306.1, 6 311.0, 25 256.2, 6 308.1, 6 312.5 |
| integer multiples of the base | 1P, 2P | 1P, 1P, **4P**, 1P, 1P |
| **base period** | **6 309.8 ms** | **6 306.1 ms** |
| worst residual | 6.2 ms | 31.8 ms |
| **worst residual as % of period** | **0.1 %** | **0.5 %** |
| `fits` (every gap an integer multiple, ≤ 5 %) | **true** | **true** |
| observed poll intervals, ms | 6 309.8 / 6 309.4 / 6 301.7 / 6 311.2 | mean **6 310.4** over 11 intervals, range 6 296.8–6 327.8 |
| poll response time, ms | 298.5–327.2 | 294.9–325.6 |
| decoded payload, bytes | 65 245–65 261 | 65 259 |
| **gap from poll `responseEnd` to long-task `startTime`, ms** | **2.3 / 2.7 / 3.2 — median 2.7** | **2.7 / 2.3 / 2.1 / 2.2 / 2.1 / 2.0 — median 2.2** |
| `about:blank`, same browser, pointer parked | **0 long tasks in 10 007 ms** | **0 long tasks in 25 207 ms** |
| CDP aggregate over the app window (renderer-wide, NOT attribution) | Script 906.0 ms, RecalcStyle 61.0 ms, Layout 14.5 ms, Task 2 035.7 ms | Script 1 011.7 ms, RecalcStyle 75.6 ms, Layout 23.5 ms, Task 3 229.8 ms |
| VPS load, start → end (16 CPUs) | 3.33 → 3.10 | 2.58 → 2.43 |
| wall clock | 2026-08-17T00:49:08Z → 00:50:05Z | 00:50:37Z → 00:52:34Z |

**This reproduces round 1291 to well inside its own noise.** Round 1291 measured
a base period of 6 294.6 / 6 283.4 ms and poll-alignment gaps of 2.1 / 2.3 /
2.2 ms; this round measures 6 306.1 / 6 309.8 ms and 2.0–3.2 ms. The period is
~13 ms longer because the payload grew (61 377 → 65 257 bytes; §4) and the
period is `TEAM_POLL_MS + fetch`.

**One thing round 1291 did not say, and this round can.** Twelve polls produced
**six** long tasks over 50 ms, not twelve. The poll's work is not *sometimes*
present and sometimes absent — it happens on every poll, at 2.2 ms after
`responseEnd`, every time. What varies is whether that work crosses the 50 ms
line. **The 50 ms threshold is a reporting artifact, not a property of the
work**; anyone reading "6 long tasks in 75 s" as "half the polls are free" is
reading it wrong.

Raw: `lattice-1301.json` (`runs.control`, `runs.control-long`), committed
unfiltered, written by the fixed instrument into `/tmp` and copied here.

---

## 4. B2 — the payload census

```bash
curl -s http://127.0.0.1:7830/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team > team-payload-raw.json
#   http=200 bytes=65257 time=0.341303
python3 docs/plan/artifacts/phase1300/baseline/payload-census.py team-payload-raw.json > payload-census.json
```

Nothing here is estimated. Each group is deleted from **every node in the tree**,
the tree is re-serialised with Hono's separators, and the delta recorded. The
script asserts the re-serialised form is **byte-identical** to the wire bytes
(`reserialisation_is_byte_identical: true`, 65 257 = 65 257), which is the licence
to quote these deltas as wire bytes rather than as Python's idea of them.

Deleting a key removes the key **name** as well as its value — that is the honest
answer to "what would this payload cost if the field did not exist", which is the
question round 1302 has to answer.

### 4.1 Shape

| | |
|---|---|
| wire bytes | **65 257** |
| nodes | **108** = 1 manager + 101 workers + 6 sub-agents |
| DOM rows for the same tree | **108** (§5 — the endpoint and the panel agree exactly) |
| settled nodes | **106 of 108** |
| **bytes belonging to settled rows** | **63 195 — 96.84 %** |

Drop every settled row and the payload is **2 062 bytes**. The panel re-fetches,
re-parses and re-renders 63 KB of frozen history every 6.3 seconds.

### 4.2 Bytes per field group

Ordered by cost. `pct` is of the 65 257-byte payload.

| group | bytes | % | present on | non-null on |
|---|---|---|---|---|
| `task` (`id`, `round`, `role`, `title`, `status`) | **16 797** | **25.74 %** | 108 | 93 |
| `tokens` (`input`, `output`, `cache_read`, `cache_creation`, `total`) | **9 939** | **15.23 %** | 108 | 108 |
| `description` | **9 453** | **14.49 %** | 108 | 108 |
| `started_at` | 4 823 | 7.39 % | 108 | 108 |
| `id` | 4 716 | 7.23 % | 108 | 108 |
| `subagents` (the key + brackets, not the children) | 4 164 | 6.38 % | 108 | 108 |
| `working_ms_source` | 3 132 | 4.80 % | 108 | 108 |
| `model` | 2 672 | 4.09 % | 108 | 108 |
| `status` | 2 210 | 3.39 % | 108 | 108 |
| `working_ms` | 2 181 | 3.34 % | 108 | 108 |
| `parent_id` | 2 040 | 3.13 % | 108 | **6** |
| `role` | 1 841 | 2.82 % | 108 | 107 |
| `kind` | 1 742 | 2.67 % | 108 | 108 |
| `settled` | 1 622 | 2.49 % | 108 | 108 |

Two rows deserve a sentence each:

- **`parent_id` costs 2 040 bytes to say `null` 102 times.** Six nodes out of 108
  have a parent. The other 102 ship `"parent_id":null` — 18 bytes each — for a
  field that is *structurally* implied by where the node sits in the tree.
- **`working_ms_source` costs 3 132 bytes** and is `"thread"` on essentially
  every row; it is a provenance label, not data the row displays.

### 4.3 Duplication — `description` is `task.title`, twice on the wire

`teamNodeFromRun` (`forge-control/src/routes/chat.ts:496`) sets

```ts
description: task ? task.title : (run.title ?? null),
```

so a worker with a task ships that string **twice** — once as `description`, once
as `task.title`. Measured:

| | |
|---|---|
| nodes shipping the same string twice | **93 of 108** |
| bytes of the duplicate copies | **6 636** |
| **share of payload** | **10.17 %** |

That is a tenth of the payload, and it is free to remove: the client can read
`task.title` when `task` is present. It is also not the whole `description`
story — the field's full cost is 14.49 % (§4.2), of which this 10.17 % is
redundant by construction.

Raw: `payload-census.json`, `team-payload-raw.json`, and the instrument itself,
`payload-census.py`, all committed.

---

## 5. B3 — the DOM census

```bash
CENSUS_BASE_URL=http://127.0.0.1:7831 CENSUS_LABEL=dom-clean \
  node docs/plan/artifacts/phase1300/baseline/dom-census.cjs
```

`/desktop`, manager chat open, Team tab visible, one team poll landed, pointer
never moved. Load 2.63 → 3.36 on 16 CPUs, 2026-08-17T00:53:51Z.

| | |
|---|---|
| **whole-document element count** | **6 237** (`document.getElementsByTagName("*").length`) |
| `[data-team-row]` count | **108** |
| — of which operator / worker / sub-agent | 1 / 101 / 6 |
| elements inside team rows | **1 404** |
| **mean elements per row** | **13.0** — min 13, median 13, max 13 |
| team rows' share of the document | **22.51 %** |
| row height | 43 px |
| `[data-team-scroll]` box height | 531 px |
| its `scrollHeight` | 4 644 px |
| **rows fully inside the scroller** | **12** |
| rows intersecting the scroller at all | **13** |
| rows passing round 1291's window filter | **21** |
| viewport | 1600 × 1000 |

### 5.1 The document is 6 237 elements, not 4 716

`phase800/canvas-perf.md` §9.7 cited **4 716** elements; the §9.7 probe itself
later recorded 5 859 → 5 943 across its own runs. This round reads **6 234–6 237**
across three loads. `/desktop` is a live chat and its transcript grows, so 4 716
is a **historical** figure, not a constant. Anyone comparing an element count
against §9.7's number must re-read it at the time of measuring, which is why this
census reports it rather than quoting it.

The row-shaped part of that document is exactly **1 404 elements** — 22.5 %. The
other 77.5 % is not the team panel.

### 5.2 Twelve rows are visible, not twenty-one — and both numbers are honest

The brief expects "~21 of 102". Round 1291's sweep filtered targets with

```js
r.top >= 0 && r.bottom <= window.innerHeight && r.height > 8
```

which clips against the **window** (1000 px), not against the scroller. This
round reproduces that filter verbatim and gets **21**, so the two rounds agree
about what they measured. But `[data-team-scroll]` is only **531 px** tall and
has `overflow-y: auto`, so a row can satisfy the window filter and still be
clipped out of sight. Counting against the scroller's own box gives **12 fully
visible, 13 intersecting**.

**Consequence for round 1302.** A windowing argument must be built on 12, not on
21: the panel mounts 108 rows to show 12. That is **9× over-mounting**, not the
5× the older figure implies — the case for windowing is stronger than the brief
assumed, not weaker. (It is not a case *this* round is allowed to act on.)

Raw: `dom-census.json` (`runs.dom-clean`), instrument `dom-census.cjs`.

---

## 6. B4 — the render census. Hypothesis CONFIRMED

### 6.1 What was instrumented, and where it lives

The instrumentation exists **only** in `/tmp/phase1301-web-inst` and dies there.
The full diff against the worktree files is committed as `instrumentation.diff`
so a reviewer can reproduce it; it is 174 lines and touches two files:

- **`app/desktop/team/TeamRow.tsx`** — a `TeamRowViewCounted` wrapper that
  increments a body-render counter, and an explicit `memo` comparator. The
  comparator **reproduces React's default shallow compare exactly** (`Object.is`
  over the union of own keys, bail out iff nothing differs), so the instrumented
  build renders identically to the clean one — it only reports what the default
  comparator was deciding silently. It additionally records which props differed,
  whether `prev.row === next.row`, whether `prev.row.node === next.row.node`, and
  two counterfactuals.
- **`app/desktop/team/teamRows.ts`** — a block at the top of `flattenTeam`
  counting how often it runs and how many inner `node` objects react-query's
  structural sharing kept identical to the previous call.

Neither file is modified in the worktree; §7's `git status` is the proof.

### 6.2 The numbers

```bash
CENSUS_BASE_URL=http://127.0.0.1:7832 CENSUS_RENDER=1 CENSUS_RENDER_MS=25200 \
  CENSUS_LABEL=render-inst node docs/plan/artifacts/phase1300/baseline/dom-census.cjs
```

Counters reset, then 25.2 s of observation with the **pointer never moved**. Run
twice.

| | `render-inst` | `render-inst-2` |
|---|---|---|
| observed window | 25 203 ms | 25 204 ms |
| `flattenTeam` calls (= polls) | **4** | **4** |
| memo compares | **432** | **432** |
| **memo bailouts** | **0** | **0** |
| **`TeamRowViewImpl` body renders** | **432** | **432** |
| distinct rows rendered | **108** | **108** |
| compares where `row` differed | **432 (100 %)** | **432 (100 %)** |
| compares where `responseNow` differed | **432 (100 %)** | **432 (100 %)** |
| compares where `prev.row === next.row` | **0** | **0** |
| **compares where `prev.row.node === next.row.node`** | **428 (99.07 %)** | **428 (99.07 %)** |
| nodes structurally shared across polls (`flattenTeam`) | **428 / 432** | **428 / 432** |
| counterfactual: bailouts if node identity decided | **428** | **428** |
| VPS load, start → end | 2.94 → 3.13 | 2.59 → 3.13 |

Identical to the integer across two runs. The >2× spread rule (03-quality §4) is
not close to triggering: the spread is 1.000×.

### 6.3 The verdict, stated against the hypothesis as written

The brief's hypothesis was that `flattenTeam` allocates a fresh `TeamRow` wrapper
per node per response, so `memo(TeamRowViewImpl)` shallow-compares a new object
and bails out for none of the rows — and that `responseNow` would defeat memo
independently.

**Both halves are confirmed, and the second half matters more than "independently"
suggests.**

1. **Wrapper allocation.** `prev.row === next.row` on **0 of 432** compares.
   Every wrapper is fresh, every poll, for every row.
2. **Structural sharing does work.** `prev.row.node === next.row.node` on **428
   of 432** compares. React-query keeps 99.07 % of the inner nodes byte-stable and
   identity-stable across polls; **`flattenTeam` throws that away** by wrapping
   each one in a new object. Only **4 nodes per poll** actually changed — the
   live rows, exactly as the payload's `settled: 106/108` predicts.
3. **`responseNow` is a second, sufficient defeat.** It differs on **432 of 432**
   compares. `bailoutsIfRowWereTheOnlyProp` is **0**: there is not a single compare
   in which `row` was the only differing prop. So **fixing wrapper identity alone
   changes nothing** — every row would still re-render on `responseNow`. Two
   changes, both required together.
4. **The prize.** `bailoutsIfNodeIdentityDecided` = **428**. Reuse the wrapper
   when the node identity is unchanged **and** stop passing `responseNow` to every
   row, and 432 renders per 25 s collapse to **4**. That is **99.07 % of the
   panel's render work**, removed without touching cadence, without removing a
   hover affordance, and without windowing anything.

### 6.4 What this does NOT establish

Render counts are not milliseconds. This round measured **how many** rows
re-render, not how many milliseconds those renders cost, and it does not claim
that eliminating 428 renders removes the 52–67 ms long task — the poll also
parses 65 KB of JSON and reconciles the tree before React is reached (§3's
`RecalcStyleDuration` of 61–76 ms per window is a hint, not an attribution).
**Round 1302 must measure the after, not assume it.** The honest claim here is
narrow and load-bearing: 99.07 % of the render work is provably redundant, and
the redundancy has two named causes in two named files.

---

## 7. How this round verified itself

### 7.1 Typecheck, both repos

```bash
$ (cd forge-control && npx tsc --noEmit); echo "forge-control tsc exit=$?"
forge-control tsc exit=0
$ (cd forge-control-web && npx tsc --noEmit); echo "forge-control-web tsc exit=$?"
forge-control-web tsc exit=0
```

### 7.2 No application file touched

```bash
$ git status --short
 M docs/plan/artifacts/phase1290/hover/README.md
 M docs/plan/artifacts/phase1290/hover/hover-1291.cjs
?? docs/plan/artifacts/phase1300/
```

Every path is under `docs/plan/`. **Zero changes to any `.ts`/`.tsx`/`.css` file
under `forge-control/src` or `forge-control-web/app`**, as round 1301's scope
requires.

Other tasks commit into this worktree concurrently, so every `git add` in this
round named its own paths explicitly; `git add -A` was never run.

### 7.3 Cadence unchanged

```bash
$ grep -n TEAM_POLL_MS forge-control-web/app/desktop/team/ChatTeamPanel.tsx
91:const TEAM_POLL_MS = 6_000;
164:    refetchInterval: TEAM_POLL_MS,
```

**No cadence was slowed and no hover affordance was removed.** This round changed
no application code at all — the `grep` is the proof, not the promise.

### 7.4 The JSON is valid and committed unfiltered

```bash
$ for f in docs/plan/artifacts/phase1300/baseline/*.json; do python3 -m json.tool "$f" >/dev/null && echo "$f valid"; done
… lattice-1301.json valid
… dom-census.json valid
… payload-census.json valid
… team-payload-raw.json valid
```

### 7.5 Honesty rules (03-quality §4)

- **Runs disagreeing by more than 2×:** did not occur. B4 reproduced to the
  integer (1.000× spread); B1's two runs agree on base period to 0.06 % and on
  poll-alignment gap medians to 0.5 ms; B3's document count varied by 3 elements
  across three loads on a live chat.
- **Raw output committed unfiltered:** all four JSONs, plus the instrumentation
  diff and both instruments.
- **A number that refused to reproduce:** the brief's "~21 of 102 rows on
  screen" did not reproduce as a *visibility* figure. §5.2 states exactly why,
  gives both numbers, and says which one round 1302 must build on.
- **Load beside every timing number:** §3, §5 and §6.2 each carry `os.loadavg()`
  at run start and end; `nproc` is 16 throughout; `uptime` lines are in the raw
  JSON under `env.uptimeLine` / `uptime`.

---

## 8. Files

| File | What |
|---|---|
| `README.md` | this file |
| `lattice-1301.json` | B1 raw — `runs.control`, `runs.control-long`, written by the fixed `hover-1291.cjs` |
| `payload-census.py` | B2 instrument — deletes each field group from every node and re-serialises |
| `payload-census.json` | B2 raw |
| `team-payload-raw.json` | the 65 257-byte `/team` response B2 was computed from, verbatim |
| `dom-census.cjs` | B3 + B4 instrument — DOM census, and the reader for the /tmp build's render counters |
| `dom-census.json` | B3 + B4 raw — `runs.dom-clean`, `runs.render-inst`, `runs.render-inst-2` |
| `instrumentation.diff` | the exact diff applied to `/tmp/phase1301-web-inst` for B4. **Never applied to the worktree** |

Round 1301 also modified `docs/plan/artifacts/phase1290/hover/hover-1291.cjs`
(output-path resolution) and `.../hover/README.md` (§7, §9) — deliverable A.
Nothing else.
