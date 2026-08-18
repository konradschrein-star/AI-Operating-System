# Hover performance — BASELINE (R12)

**Round 1292. Retrospective write-up. No application code was changed, no server
was started, no browser was run.** Every number below was read out of a committed
artifact and carries the path it came from. Where a source does not record
something, this document says *not recorded* rather than estimating it.

Companions: `docs/plan/perf/findings.md` (R13 — the named mechanism),
`docs/plan/perf/after.md` (R14 — the whole series and the gate verdict).

---

## 0. Why this file is at `docs/plan/perf/` and not under the project namespace

Every reference to these three documents in the corpus names the **flat** path:

| Reference | Path it names |
|---|---|
| `docs/plan/operator-visibility/01-requirements.md` lines 64, 68, 72 | `docs/plan/perf/baseline.md`, `findings.md`, `after.md` |
| `docs/plan/operator-visibility/02-architecture.md` line 202 | `docs/plan/perf/` |
| `docs/plan/operator-visibility/04-phases.md` lines 50, 54, 55, 57 | `docs/plan/perf/` and the three files |

Phase 1300's brief names the same path, and
`docs/plan/operator-visibility/artifacts/phase1300/scope-ruling.md` §2 records
these exact three paths as the ones that do not yet exist.

The precedent is the r901 relocation ruling,
`docs/plan/artifacts/phase900/corpus-relocation.md` §3, which kept
`docs/plan/artifacts/` flat on the reasoning that **there is nothing to erase**:
the path exists only on this branch, so no other lane's corpus can be overwritten
by adding to it. The same reasoning applies here, and it was verified rather than
assumed.

### The verification, and an honest correction to the command

The check specified for this round was:

```
$ git ls-tree -r --name-only main docs/plan/ | grep perf
docs/plan/artifacts/phase800/canvas-perf.md
```

**That command returns one line, and the line is a false positive.** `grep perf`
matches the substring *perf* inside `canvas-perf.md`, which is a phase-800
artifact and not a `docs/plan/perf/` path. The question the check meant to ask is
whether `main` carries anything under `docs/plan/perf/`, and anchored, it does
not:

```
$ git ls-tree -r --name-only main docs/plan/ | grep '^docs/plan/perf/'
$ echo $?
1
```

Zero lines, exit 1. `main` has no `docs/plan/perf` path. `git ls-tree --name-only
main docs/plan/` lists eleven flat `NN-*.md` files plus `archive`, `artifacts`,
`evidence` and `operator-visibility` — no `perf`.

**Residual risk, stated once:** if another lane independently adds
`docs/plan/perf/`, it surfaces at deploy as an ordinary merge conflict on named
files, not as a silent overwrite — which is the same trade the r901 ruling
accepted.

---

## 1. The BEFORE numbers

The baseline is the chat rail — the surface Konrad named ("hovering the sidebar
still lags").

**Source:** `docs/plan/artifacts/phase400/hover-cost-before.json`

| | value |
|---|---|
| rows on screen | **7** |
| crossings | **76** |
| window | **10 000 ms** (idle window, then hover window, same length) |
| idle window | 12 react commits, 0 DOM mutations |
| hover window | 89 react commits, 1 057 DOM mutations |
| **attributable to hover** (`hover − idle`) | **77 react commits, 1 057 DOM mutations** |
| build under test | `next start` of `/opt/forge-ai-os`'s build — i.e. `main`, pre-fix |
| harness base | `http://127.0.0.1:7797` |

77 commits over 76 crossings is approximately **one full React commit per row the
pointer crossed**, and each commit rebuilt DOM: 1 057 mutations inside the rail's
scroll container. That is the storm. `docs/plan/perf/findings.md` names the
mechanism.

Proof, read out of the file rather than copied from a brief:

```
$ python3 -c "import json; d=json.load(open('docs/plan/artifacts/phase400/hover-cost-before.json')); print(d['attributable_to_hover'], d['crossings'], d['rows_on_screen'], d['window_ms'])"
{'commits': 77, 'mutations': 1057} 76 7 10000
```

---

## 2. The instrument and the method, honestly

**Instrument:** `docs/plan/artifacts/phase400/hover-cost.cjs`.

- **React commits** are counted by a `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim
  installed *before any bundle loads*, which increments a counter on every
  react-dom commit. React DevTools' profiler is not available headless; this shim
  is what stands in for it, and it counts commits — not components, not
  milliseconds.
- **DOM mutations** are counted by a `MutationObserver` attached to the rail's
  scroll container.
- **The idle subtraction is not cosmetic.** The app polls on its own, so a 10 s
  window contains commits nobody asked for. The instrument therefore measures two
  windows — pointer parked far away, then swept — and reports `hover − idle`. The
  reported cost is a *difference*, and every consumer of these numbers should read
  it as one.
- Sweep cadence in the phase-400 script is `SWEEP_STEP_MS = 120`, one pointer
  move per step; viewport 1600 × 1000.

**The comparison is two builds, not two code states in one tree.** Both servers
were built from the same `next.config.mjs` with the same proxy target
(`FORGE_CONTROL_URL=http://127.0.0.1:7700`), started with `AUTH_URL` matching
their own port so the minted session cookie is accepted, and measured by the same
script in the same browser. **No code was edited between the two runs — the two
builds ARE the comparison** (`docs/plan/artifacts/phase400/README.md`, round-401a
section). The `before` server served `main`'s build on `:7797`; the `after` server
served the worktree's build on `:7796`.

---

## 3. The protocol gap — stated plainly, once

`docs/plan/operator-visibility/03-quality.md` §4 is binding for R12–R14, and it
specifies an instrument that **was never committed**:

> **Scripted sweep (one script, `scripts/checks/hover-sweep.ts`, committed in
> phase 3 and reused by reviewer and phase 5)** […] report per-run and median of:
> total main-thread scripting ms during the 10s window; count of tasks > 50ms;
> longest task ms; and (from user timing if present) React commit count. Record
> `uptime`/`nproc`/load average alongside.

`scripts/checks/hover-sweep.ts` does not exist and never did. What exists instead
is a family of purpose-built probes that evolved across phases:

| Instrument | React commits | DOM mutations | long tasks > 50 ms | scripting ms |
|---|---|---|---|---|
| `docs/plan/artifacts/phase400/hover-cost.cjs` | yes | yes | **no** | **no** |
| `docs/plan/artifacts/phase500/team-hover.cjs` | yes | yes | **no** | **no** |
| `docs/plan/artifacts/phase700/hover-700.cjs` | yes (with poll attribution) | yes | **no** | **no** |
| `docs/plan/artifacts/phase900/hover-904.cjs` | **no** | yes | yes | **no** |
| `docs/plan/artifacts/phase1290/hover/hover-1291.cjs` | **no** | yes | yes | yes (CDP aggregate) |

Verified by counting the relevant symbols in each script:

```
$ for f in phase400/hover-cost.cjs phase500/team-hover.cjs phase700/hover-700.cjs \
           phase900/hover-904.cjs phase1290/hover/hover-1291.cjs; do
    echo "$f longtask=$(grep -c longtask $f) ScriptDuration=$(grep -c ScriptDuration $f) commits=$(grep -c DEVTOOLS_GLOBAL_HOOK $f)"
  done
phase400/hover-cost.cjs      longtask=0 ScriptDuration=0 commits=2
phase500/team-hover.cjs      longtask=0 ScriptDuration=0 commits=2
phase700/hover-700.cjs       longtask=0 ScriptDuration=0 commits=1
phase900/hover-904.cjs       longtask=3 ScriptDuration=0 commits=0
phase1290/hover/hover-1291.cjs longtask=7 ScriptDuration=9 commits=0
```

**Consequence, and it is the load-bearing sentence of this document:**

> **Gate clause (b) — "total scripting ms reduced ≥ 50 % vs baseline if baseline
> ≥ 120 ms" — has no baseline number and is not computable from committed
> evidence.** No instrument measured scripting ms until round 1291, which ran
> after the fix. There is no pre-fix scripting-ms figure anywhere in the corpus,
> so no reduction can be computed against one.

This is a gap in phase 400's instrument, not a regression. `docs/plan/perf/after.md`
records clause (b) as **NOT VERIFIABLE AS WRITTEN** and points here; it does not
substitute a different number and call it a pass.

Two further consequences of the same gap, so they are not mistaken for findings
later:

- Phases 400–700 cannot answer "were there tasks > 50 ms?" at all. Their rows in
  `docs/plan/perf/after.md` read *not measured* for that column, not zero.
- Phases 900 and 1290 cannot answer "how many React commits?" — that counter was
  dropped when the instrument moved to production and to long-task attribution.
  The commit collapse is phase 400's evidence and stays phase 400's.

---

## 4. Environment per source measurement

`03-quality.md` §4 requires `uptime`/`nproc`/load average recorded alongside.
Checked in every artifact:

| Source | Environment recorded in the artifact |
|---|---|
| `docs/plan/artifacts/phase400/hover-cost-before.json` | **not recorded.** Keys are `label, base, rows_on_screen, window_ms, crossings, idle, hover, attributable_to_hover` only. Viewport 1600 × 1000 is hard-coded in `hover-cost.cjs`, not written to the JSON |
| `docs/plan/artifacts/phase400/hover-cost-after.json`, `hover-cost-after-run2.json` | **not recorded** (same key set) |
| `docs/plan/artifacts/phase500/team-hover-after.json` | **not recorded.** Adds `chat`, `rows_total`, `layout_shift`, `geom_before`, `geom_during`, `gate`, `verdict` — no host environment |
| `docs/plan/artifacts/phase500/rail-hover-round504.json` | **not recorded** |
| `docs/plan/artifacts/phase600/rail-hover-round604.json`, `team-hover-round604.json` | **not recorded** |
| `docs/plan/artifacts/phase700/hover-700.json` | **not recorded.** It does record a measurement `protocol` block (window 10 000 ms, sweep step 90 ms, poll lead 60 ms, poll tail 400 ms) and a `census` block — richer protocol provenance than its predecessors, but still no host figures |
| `docs/plan/artifacts/phase900/hover-904.json` | **not recorded.** Base is production, `https://os.schreinercontentsystems.com`, hard-coded at `hover-904.cjs:40` |
| `docs/plan/artifacts/phase1290/hover/hover-1291.json` | **recorded, in full.** `nproc` 16; run1 `uptime` `01:16:32 up 25 days, 5:50, 9 users, load average: 1.89, 2.41, 2.94`; run2 `01:20:18 … 2.33, 2.64, 2.94`; per-pair `osBefore`/`osAfter` load averages ranging 1.89–3.26 over 16 CPUs; `/proc/uptime` at start and end of each run; viewport 1600 × 1000; build SHA under test `8d6a59782138f68ef2d5316919e4d46422f4fa9b` with an explicit note that this is the worktree commit, not a hash of the build output |

Only the round-1291 instrument satisfies the §4 environment requirement. The eight
earlier artifacts do not, and nothing can retro-fit it — those runs are gone.
Where a phase-400-through-900 number is quoted anywhere in these three documents,
it is quoted without an environment claim.

---

## 5. What the baseline does and does not license

**It licenses:** a before/after statement about **React commits and DOM mutations
attributable to hover on the chat rail**, on a 7-row rail over 76 crossings in a
10 s window, `main`'s build versus the worktree's. That comparison is clean: same
script, same browser, same proxy target, no code edited between runs.

**It does not license:** any claim about milliseconds, frames, scripting time, or
long tasks before the fix. Nothing measured those on the pre-fix build. A reader
in three months should take "the rail hover storm was 77 commits and 1 057
mutations, and it went to ~0" as the established result, and should not infer a
millisecond figure from it.
