# D2 — can it fail? Every executed gate, mutation-tested

Project `aios-verification-that-bites`, round 1, workstream `audit`. Branch
`project/169903ec-audit`, worktree HEAD `2209245` at the start of the run
(a sibling task committed `b308ddb` on the same branch mid-run — see §0.3).
All measurements 2026-08-25, 07:46–08:20 CEST, on this host.

**Nothing was fixed and nothing was softened.** Every mutation below was
backed up, applied, measured, restored, and the restore proven by `md5sum`
on both sides. `git status --porcelain` is empty at the end of this document
except for the sibling task's own D1 edits, which were never touched.

---

## 0. Method, and what it is worth

### 0.1 The harness

Each row was produced by a throwaway script (`/tmp/d2-c2bcea3f/bite.sh`, **not
committed** — D3 owns the shipped version) that does, per mutation:

```
md5sum <subject>            →  BEFORE_MD5
<mutation>                  →  MUTATE_EXIT
bash -c "set -o pipefail; <the gate command, verbatim from gates-808.sh>"
                            →  GATE_EXIT
restore from backup (or rm, for a created file)
md5sum <subject>            →  AFTER_MD5
git status --porcelain | wc -l
```

`set -o pipefail` is set inside the `bash -c`, exactly as `gate_sh`
(`gates-808.sh:85`) does it, so a `| tail -3` cannot report `tail`'s status
instead of the check's. A measurement taken without it would be worthless
here: that is round 1353's finding 2, recorded in the script's own header.

### 0.2 The verdicts

Per the brief, exactly one of:

| verdict | meaning |
|---|---|
| **BITES** | a named mutation reddens it; the RED transcript is given |
| **INERT** | no input can redden it — proven structurally *and* by a mutation that should have reddened it and did not |
| **FROZEN-SCOPE** | it bites, but only over a hard-coded subject set, so nothing written after the round that authored it is ever its subject |
| **VACUOUS-HERE** | it bites in principle, but its input set is empty in a worker's worktree |

One gate (6) does not fit a single label honestly and is reported as
**INERT-IN-ITS-OWN-USE-CASE**, with the states where it *does* bite named
explicitly. Forcing it into one word would have lost the finding.

### 0.3 Two facts about the tree that a re-runner needs

1. **The suite has 27 gates, not 24.** `D1-execution-audit.md`'s runner table
   says "24 numbered gates". The summary block of a real run prints `SUMMARY —
   27 gates`. 25 execute, 2 are `SKIPPED` without `--browser`. Counted by hand
   from the script: gate calls at `gates-808.sh:117, 118, 119, 122, 133, 163,
   167, 174, 175, 176, 177, 178, 180, 190, 199, 203, 206, 215, 219, 242|246,
   250, 255, 258, 260, 263|267, 265|268, 271`.

2. **A sibling task writes in this worktree while you measure.** At
   `07:49:26` — three seconds before one of my `git status` reads — another
   task modified `docs/plan/artifacts/verification-that-bites/D1-execution-audit.md`
   and `execution-audit.tsv`, and at `~07:52` committed them as `b308ddb`.
   That is not a hazard note; it is the input that reddens gate 27 (§4.5).

### 0.4 Baseline, before any mutation

`bash scripts/checks/gates-808.sh --strict` at `2209245`, full log at
`/tmp/d2-c2bcea3f/baseline-gates.log`:

```
 SUMMARY — 27 gates
 ...
 5  1      no-raw-colours.cjs (whole app)
 ...
 25 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 26 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 RED: 1
SUITE_EXIT=1
```

**The one RED is inherited, not ours.** Proven by running `main`'s own copy of
the checker in a detached worktree — identical violation count, identical exit:

```
$ node scripts/checks/no-raw-colours.cjs | grep '^── FAIL'
── FAIL: 25 raw colour literal(s) with no allowlist entry ──     # this branch, EXIT=1

$ git worktree add --detach /tmp/d2-c2bcea3f/mainwt main
$ (cd /tmp/d2-c2bcea3f/mainwt && node scripts/checks/no-raw-colours.cjs | grep '^── FAIL')
── FAIL: 25 raw colour literal(s) with no allowlist entry ──     # main, MAIN_EXIT=1
$ git worktree remove /tmp/d2-c2bcea3f/mainwt --force
```

All 25 are `goals/ui.tsx` and `goals/WeekGrid.tsx` from `b41e824`. Do not fix
them from this project, and do not widen the allowlist: fleet memory
`gate5-raw-colours-red-at-main-from-week-board`.

---

## 1. The table — one row per executed gate

`gates-808.sh`, in the order the script runs them. "Mutation" is the exact
input; the full transcript for every non-BITES verdict is in §4.

| # | line | gate | verdict | mutation that decided it | gate exit |
|---:|---:|---|---|---|---:|
| 1 | :117 | `tsc --noEmit` forge-control | **BITES** | new `forge-control/src/lib/d2probe-type.ts` with `export const x: number = "nope"` | 2 |
| 2 | :118 | `tsc --noEmit` forge-control-web | **BITES** | same file under `forge-control-web/app/desktop/` | 2 |
| 3 | :119 | `pnpm build` forge-control-web | **BITES** | `printf '\nexport const D2_BROKEN = (' >> team/TeamRow.tsx` → `Failed to compile. Error: x Unexpected eof` | 1 |
| 4 | :122 | token purity — round 808's own files | **FROZEN-SCOPE** | new `.tsx` with `#ff00ff` — ignored (§4.1) | 0 |
| 5 | :133 | `no-raw-colours.cjs` (whole app) | **BITES** | same new `.tsx` — named in the FAIL list, 25→26 violations | 1 |
| 6 | :163 | forbidden-file diff, three-dot `main...HEAD` | **INERT in its own use case** | three separate blind states, §4.2 | 0 |
| 7 | :167 | `forge-control/` untouched by round 808's commits | **INERT** | none possible — body ends in a literal `exit 0` (§4.3) | 0 |
| 8 | :174 | `check-migration-numbers.ts` | **BITES** | `db/migrations/0049_d2probe_collision.sql`; and separately an unnumbered `.sql` | 1 |
| 9 | :175 | `dollar-sweep.sh` | **BITES** | new `.tsx` containing `"$5.00 spent"` | 1 |
| 10 | :176 | `check-composer-v3.ts` | **BITES** | drop `"max"` from `EFFORT_RAMP_ORDER` (`chat/effort-ramp.ts:41`) → 2 FAILURE(S) | 1 |
| 11 | :177 | `check-secret-requests.ts` | **BITES** (one clause unpinned) | `capNote` returns `truncated: false` on a cut → 1 FAILURE(S). **`RENDERED_NOTE_CAP` 2000→20000 is NOT detected** (§4.6) | 1 |
| 12 | :178 | `contrast-canvas-banners.cjs` | **BITES** | light `--fg-warn: #7f6c11` → `#ffd8a8` (`theme.css:249`) → 2 combinations below 4.5:1 | 1 |
| 13 | :180 | `check-working-sql-agreement.ts` standalone typecheck | **BITES** | append a `number = "string"` const → `error TS2322` | 2 |
| 14 | :190 | `check-stop-affordance.tsx` | **BITES** | `TeamRow.tsx:683` `disabled={stopBlock !== null}` → `disabled={false}` → 4 FAILURE(S) | 1 |
| 15 | :199 | `check-dismiss-peek.tsx` | **BITES** (one clause inert, disclosed) | `TeamRow.tsx:636` `data-team-restore={n.id}` → `""` → 1 FAILURE(S). Inert to the confirm boundary (§4.6) | 1 |
| 16 | :203 | `check-team-rows.ts` | **BITES** | `CLIENT_INTERPOLATION_CAP_MS` 15_000 → 900_000 (`teamRows.ts:354`) → 2 FAILURE(S) | 1 |
| 17 | :206 | `check-team-confirm.ts` | **BITES** | `confirm.ts:173` `hidesRows > 1` → `>= 1` → 3 FAILURE(S) | 1 |
| 18 | :215 | `check-deep-link.ts` | **BITES** | `deep-link.ts:60` stops clearing `navStack` → 1 FAILURE(S) | 1 |
| 19 | :219 | `verify-notification-gap-pins.mjs` | **BITES** (line drift non-fatal by design) | reword a pinned prose line → 2 FAILURE(S); rename the live-pinned symbol → 1 FAILURE(S). §4.7 | 1 |
| 20 | :242 | `check-usage-fold.ts` vs real Postgres | **BITES** | `usage-sampler.ts:515` `'folded_runs'` → `'folded_runs_DISABLED'` → 3 FAILURE(S) | 1 |
| 21 | :250 | `check-usage-fold.ts` standalone typecheck | **BITES** | append a `number = "string"` const → `error TS2322` | 2 |
| 22 | :255 | `pnpm test` — forge-control unit suite | **BITES inside `src/lib/` only** | identical failing test: `src/lib/` → `# fail 1`, RED; `src/routes/` → `# fail 0`, GREEN (§4.4) | 1 / 0 |
| 23 | :258 | `psql-argv-leak.cjs` | **BITES on 2 files; FROZEN-SCOPE otherwise** | reintroduce the DSN in argv in `check-working-sql-agreement.ts` → 1 FAILURE(S). A **new** file with the identical defect → EXIT=0 (§4.8) | 1 / 0 |
| 24 | :260 | `nav-walk-sampling.cjs` | **INERT** | move the real `CHAT_LIST_POLL_MS` 10s→11s, which makes its own assertion A4 false → `ALL PASS` (§4.9) | 0 |
| 25 | :263 | `phase700/network-700.cjs` | **VACUOUS-HERE** | never reached — `--browser` unset (§4.10) | – |
| 26 | :265 | `phase600/nav-walk.cjs` | **VACUOUS-HERE** | never reached — `--browser` unset (§4.10) | – |
| 27 | :271 | reproduce-cleanliness | **INERT for its subject set; false-positive on any sibling** | its two scripts write to `/tmp` and cannot dirty the tree; one untracked file created 0.3 s into its 0.51 s window reddens it (§4.5) | 0 / 1 |

### guard.sh's own phases

| phase | check | verdict | mutation | result |
|---:|---|---|---|---|
| 0 | `node-version` | **BITES** | a `node` shim on `PATH` reporting `v20.11.0` | `FAIL — found v20.11.0, need v22+` |
| 0 | `devdeps-forge-control` | **BITES** | remove `forge-control/node_modules` in an isolated clone | `FAIL — forge-control/node_modules/.bin/tsc is missing` |
| 0 | `devdeps-forge-control-web` | **BITES** | same shape | (same mechanism, one `-x` test at `guard.sh:132`) |
| 1 | `no-raw-colours` | **BITES** | = gate 5 | RED |
| 1 | `dollar-sweep` | **BITES** | = gate 9 | RED |
| 1 | `forbidden-file-diff` | **INERT in its own use case** | = gate 6, plus one extra arm gates-808 lacks (§4.2) | PASS over a live edit |
| 2 | `tsc-forge-control` / `-web` | **BITES** | = gates 1, 2 | RED |
| 2 | `instrument-typecheck` | **VACUOUS in `--fast`** | never runs; `guard.sh:199` | SKIP |
| 3 | `web-build` | **VACUOUS in `--fast`** | never runs; `guard.sh:211` | SKIP |
| 4 | `gates-808-suite` | **VACUOUS in `--fast`** | never runs; `guard.sh:232` | SKIP |

---

## 2. THE COUNT

**Of the 25 gates that execute in a default `gates-808.sh --strict` run, 20
bite and 5 do not.**

- **20 BITE**: 1, 2, 3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23 — with the scope caveats recorded above for 22 and 23 and the
  unpinned/inert clauses recorded for 11 and 15.
- **5 DO NOT**: 4 (FROZEN-SCOPE), 6 (INERT in its own use case), 7 (INERT),
  24 (INERT), 27 (INERT for its subject set, false-positive otherwise).
- **2 more never run at all**: 25 and 26, VACUOUS-HERE, and they are counted
  in the "27 gates" headline.

Round 0 named four. All four are confirmed independently below, and **one
more was found** — gate 24, `nav-walk-sampling.cjs` — plus **a third,
previously unreported cause** for gate 6.

---

## 3. F5 — RESOLVED, and it is worse than a documentation contradiction

**Question.** `package.json:7` is `guard.sh --fast --strict`. `--fast`
`skip_check`s phases 2, 3 and 4 (`guard.sh:199, 211, 232`) while `guard.sh:27-29`
documents `--strict` as "also fail on any SKIP — nothing may be silently
skipped (CI's flag)". Which is true?

**Answer: both, and together they make `pnpm guard` unable to return 0 in any
tree state.**

```
$ pnpm guard; echo EXIT=$?
...
2  instrument-typecheck     SKIP       0s   deferred to --full …
3  web-build                SKIP       0s   deferred to --full …
4  gates-808-suite          SKIP       0s   deferred to --full …

PASS: 7   FAIL: 1   SKIP: 3
GUARD: RED — do not merge. Fix the failure(s) above and re-run.
EXIT=1
```

That run also carries the inherited gate-5 FAIL, so it does not on its own
separate the two causes. **This does** — the same command on a tree with
*zero* failures, in an isolated clone checked out at `b41e824^` (the commit
before the week-board palette landed):

```
$ cd /tmp/d2-c2bcea3f/clone && git checkout -B preweekboard b41e824^
$ node scripts/checks/no-raw-colours.cjs | tail -1
no-raw-colours: PASS — 263 literal(s) across 16 file(s), … 0 unlisted.

$ bash scripts/checks/guard.sh --fast --strict; echo GUARD_EXIT=$?
...
PASS: 7   FAIL: 0   SKIP: 4
GUARD: RED — do not merge. Fix the failure(s) above and re-run.
GUARD_EXIT=1
```

`FAIL: 0`, exit 1, and the "FAILURES — what broke and how to fix it" section
is **absent**, because there are none. The verdict text tells the reader to
"fix the failure(s) above" and there is nothing above.

**Structurally**, at `guard.sh:248-250`:

```bash
EXIT_CODE=0
[ "$FAIL_COUNT" -gt 0 ] && EXIT_CODE=1
[ "$STRICT" -eq 1 ] && [ "$SKIP_COUNT" -gt 0 ] && EXIT_CODE=1
```

and the three `skip_check` calls are in the `else` arm of
`if [ "$MODE" = "full" ]` — unconditional in fast mode. So in `--fast`,
`SKIP_COUNT ≥ 3` always, and `--strict` always sets `EXIT_CODE=1`.

**Does `--strict` mean anything in fast mode?** No. Its only two effects are
(a) fail on SKIP, which fires unconditionally, and (b) nothing else — the
FAIL arm is `--strict`-independent. In `--fast`, `--strict` is a constant.
Its documented purpose ("nothing may be silently skipped") is defeated
precisely because the skips are not silent: they are deliberate, announced,
and three of them.

**Proposed fix, not applied** (this changes what every lane's merge command
returns, and it is Konrad's call): mark a `skip_check` as *deliberate* vs
*environmental* and have `--strict` fail only on the latter. `guard.sh` already
distinguishes them in prose — "deferred to `--full` on purpose, not dropped"
(`guard.sh:193`) versus "no local 'main' branch to diff against in this
checkout" (`:173`) — the second is the class `--strict` exists to catch. A
fourth SKIP appeared in the clone run above and it is exactly that class.

---

## 4. Full transcripts, per finding

### 4.1 Gate 4 — FROZEN-SCOPE (round 0's finding, confirmed independently)

Its subject list is seven literal paths (`gates-808.sh:124-130`), two of which
are the gate script itself and `dollar-allowlist.txt`. Nothing written after
round 808 is ever its subject. Proven by giving gates 4 and 5 **the same new
file** and taking both verdicts:

```
===== GATE 5 no-raw-colours.cjs — new file, raw hex =====
--- mutation: printf 'export const probe = { color: "#ff00ff" };\n' > forge-control-web/app/desktop/d2probe-colour.tsx
── FAIL: 26 raw colour literal(s) with no allowlist entry ──
  forge-control-web/app/desktop/d2probe-colour.tsx:1  #ff00ff
      export const probe = { color: "#ff00ff" };
  …
GATE_EXIT=1
AFTER_MD5=(absent)   RESTORED=yes

===== GATE 4 token purity — SAME new file with raw hex =====
--- gate: grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' \
     docs/plan/artifacts/phase800/psql-argv-leak.cjs \
     docs/plan/artifacts/phase800/nav-walk-sampling.cjs \
     docs/plan/artifacts/phase600/nav-walk.cjs \
     scripts/checks/check-working-sql-agreement.ts \
     scripts/checks/gates-808.sh \
     scripts/checks/dollar-allowlist.txt \
     README.md && { … exit 1; } || { echo 'CLEAN — zero colour literals'; exit 0; }
CLEAN — zero colour literals
GATE_EXIT=0
AFTER_MD5=(absent)   RESTORED=yes
```

Baseline count 25 → 26 with the probe present, and the probe file is named in
gate 5's FAIL list. Gate 4 does not look at it.

**Trap (b), fixture-not-invariant, applies here too.** Two of gate 4's seven
subjects are `scripts/checks/gates-808.sh` and
`scripts/checks/dollar-allowlist.txt` — the gate greps its own source. A
future author writing a colour literal into a *comment* in `gates-808.sh`
reddens gate 4 with nothing wrong in any product file. Same shape as fleet
memory `checker-names-its-own-forbidden-strings`.

### 4.2 Gate 6 / guard.sh phase 1 — three separate blind states

All three measured in a **throwaway clone** (`git clone --no-hardlinks` into
`/tmp/d2-c2bcea3f/clone`), so no shared ref in the real repo was moved.

**Cause A — `main...HEAD` compares COMMITS, so an uncommitted edit is invisible.**
This is the state `guard.sh:38` explicitly targets: *"Run this from an agent's
worktree"* — which is exactly when an agent's edit is uncommitted.

```
main=259778b HEAD=e36f351  behind: 1
$ echo "// D2 MUTATION PROBE — UNCOMMITTED" >> forge-control/src/lib/cc-runner.ts
  working tree:  M forge-control/src/lib/cc-runner.ts
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects' \
    && { echo '>>> FORBIDDEN FILE DIFFERS'; exit 1; } || { echo 'clean …'; exit 0; }
clean — no engine/Files file differs
  GATE6_EXIT=0
  control — a working-tree arm WOULD see it: forge-control/src/lib/cc-runner.ts
```

**Cause B — local `main` fast-forwarded onto the lane.** Round 0's wording
("in this worktree local main == HEAD, so the diff is empty at every input")
needs one correction, and the correction changes the fix: `main == HEAD` does
**not** blind the gate to a *new* commit. It blinds it to every commit already
in `main`'s history — i.e. the instant `main` is moved onto the lane's tip.
Both halves, same clone, same file:

```
before: main=259778b HEAD=51cd3e8       # the forbidden edit is committed on HEAD
  gate BEFORE ff: EXIT=1  (RED — correct, so the gate is not simply broken)
$ git branch -f main HEAD
after:  main=51cd3e8 HEAD=51cd3e8
  cc-runner.ts STILL carries the probe: 1 line(s)
clean — no engine/Files file differs
  gate AFTER ff: GATE6_EXIT=0  (GREEN over the identical edit)
```

At the time of measurement this worktree had `main=259778b`, `HEAD=2209245`,
`merge-base=259778b` — so cause B is **not** currently live here, and cause A
is. Fleet memory `worktree-local-main-can-equal-head` records the state where
it was.

**Cause C — no local `main` ref at all. NOT previously reported.** `git diff`
writes its error to **stderr**, stdout is empty, `grep` finds nothing, and the
`||` arm reports the tree clean:

```
main exists? NO
committed forbidden file: forge-control/src/lib/cc-runner.ts
--- gates-808.sh gate 6 body, verbatim:
fatal: ambiguous argument 'main...HEAD': unknown revision or path not in the working tree.
…
clean — no engine/Files file differs
GATE6_EXIT=0
--- guard.sh's equivalent (it guards the ref first, guard.sh:162):
would SKIP  ('no local main branch to diff against') -> --strict turns SKIP into FAIL
```

**So `gates-808.sh:163` is strictly weaker than `guard.sh:161-174`, not
identical to it** — fleet memory `forbidden-file-guard-does-not-bite` says the
two "carry the identical body and the identical hole". They carry the identical
*diff*; guard.sh has a ref guard that gates-808 does not. Correct the note.

**Proposed fix, not applied.** Three arms, because there are three causes:
(i) add a working-tree arm, `git status --porcelain | awk '{print $2}'`,
unioned with the diff; (ii) resolve the baseline as
`git merge-base --fork-point origin/main HEAD` (or `origin/main` directly)
rather than the local `main` ref, and refuse to run if it does not resolve;
(iii) copy guard.sh's `git rev-parse --verify` guard so a missing ref is a
loud SKIP, never a silent "clean". **This is deliberately left unfixed: it
changes what every lane may commit, and Konrad sees the measurement first.**

### 4.3 Gate 7 — INERT (round 0's finding, confirmed independently)

Structural: the gate body has no conditional and no non-zero exit path. Its
last statement is a literal `exit 0` (`gates-808.sh:172`).

```
$ sed -n '167,172p' scripts/checks/gates-808.sh | grep -cE 'exit [1-9]|\[ |test |if |&&|\|\|'
0
```

Empirical: its own name is a false assertion at this HEAD, and it reports
success anyway.

```
========== GATE 7 — forge-control/ untouched by round 808's own commits ==========
forge-control/ files in 7b961b5..HEAD: 179
forge-control/bin/aios.mjs
forge-control/ecosystem.config.cjs
forge-control/package.json
  …
(round 808 authored none of these; any listed file is a sibling task on the same branch)
GATE7_EXIT=0
```

This is **trap (b) in its purest form**: the clause "forge-control/ untouched"
would fail on a correct, healthy repo — 179 files have legitimately changed
since round 808 — so the only way for it to stay green was to remove its
ability to fail. It is a census wearing a gate's number. It should be
renamed to what it is (a printout) and dropped from the RED tally, or given a
real assertion (e.g. against a per-project write-set), but it should not
occupy a gate slot while asserting nothing.

### 4.4 Gate 22 — bites inside `src/lib/`, vacuous one directory over

`forge-control/package.json:test` is `tsx --test src/lib/*.test.ts`:
non-recursive, one literal directory. The two runs below use a **byte-identical
test file** and differ only in its directory.

```
===== GATE 22 pnpm test — a failing test INSIDE src/lib =====
--- mutation: … > forge-control/src/lib/d2probe.test.ts
# tests 2201
# pass 2200
# fail 1
GATE_EXIT=1

===== GATE 22 pnpm test — the SAME failing test one directory over, in src/routes =====
--- mutation: … > forge-control/src/routes/d2probe.test.ts
# tests 2200
# pass 2200
# fail 0
GATE_EXIT=0
```

The file content, both times:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
test("d2 probe — deliberately failing", () => { assert.equal(1, 2); });
```

Note the denominator: 2200 → 2201, i.e. the `src/routes/` file did not even
enter the count. This is D4's empirical basis. It is not a proposal that the
glob is narrow; it is a measurement that a deliberately-failing test outside
`src/lib/` is executed by nothing.

### 4.5 Gate 27 — both halves (round 0's finding, confirmed independently)

**Half 1, false negative: its subject set cannot dirty the tree by
construction.** Both scripts default `OUT_DIR` to `os.tmpdir()`
(`psql-argv-leak.cjs:61-62`, and the same block in `nav-walk-sampling.cjs:84-85`),
so the "protocol" whose cleanliness the gate certifies never writes into the
repo at all:

```
before: 5159ddbe4985314abe5800a3de4809f3  -
after:  5159ddbe4985314abe5800a3de4809f3  -
PASS — tree untouched
GATE27_EXIT=0
   where the two scripts actually wrote:
-rw-r--r-- 1 root root 11888 Aug 25 07:50 /tmp/phase800-out/nav-walk-sampling.json
-rw-r--r-- 1 root root  5614 Aug 25 07:50 /tmp/phase800-out/psql-argv-leak.json
```

**Half 2, false positive: any concurrent writer reddens it.** The gate's window
is 0.51 s wide (measured). One untracked file created 0.3 s in — which is what
a sibling lane in this shared worktree does routinely, and did at 07:49:26:

```
gate 27 wall time:  0.51 s
=== a sibling writes ONE untracked file 0.3s into the gate ===
before: 5159ddbe4985314abe5800a3de4809f3  -
after:  2263b4e9a5e595a5164772a3aa2d8b58  -
FAIL — tree changed
GATE27_EXIT=1
```

So the gate is **blind to the thing it names and sensitive to the thing it
does not**: `md5sum` over `git status --porcelain` **repo-wide** is a
concurrency detector, not a cleanliness proof of two `/tmp`-writing scripts.
Trap (b) applies: on a correct system with five lanes sharing this worktree,
this clause fails. Proposed fix, not applied: scope the before/after to the
paths the protocol could plausibly write (`docs/plan/artifacts/phase800/`),
or drop the gate and assert `OUT_DIR !== SRC_DIR` directly.

### 4.6 Trap (a) — INERT ASSERTION, measured in both directions

`check-dismiss-peek.tsx:205` asserts
`title.includes("dismissed · show")` on the ✕ button. `dismissTitle`
(`team/confirm.ts:244-263`) builds that phrase once as `const undo` and appends
it to **all three** return branches, so the substring is true at every value of
the selector.

**Fixture flipped across the `needsConfirm` boundary, four values, both
directions** (`check-dismiss-peek.tsx:147`, `hidesRows`):

| `hidesRows` | crosses `> 1`? | gate exit | verdict line |
|---:|---|---:|---|
| 0 | below | 0 | `ALL PASS — dismissal peek affordance` |
| 1 | at (baseline) | 0 | `ALL PASS` |
| 2 | above | 0 | `ALL PASS` |
| 5 | above | 0 | `ALL PASS` |
| 165 | far above | 0 | `ALL PASS` |

**And the boundary broken for real**, `confirm.ts:173` `> 1` → `>= 1` (which
puts a two-click confirm in front of every single-row reversible dismissal):

```
===== GATE 15 check-dismiss-peek.tsx vs needsConfirm '> 1' -> '>= 1' =====
ALL PASS — dismissal peek affordance
GATE_EXIT=0

===== GATE 17 check-team-confirm.ts vs THE SAME mutation (discriminating control) =====
3 FAILURE(S) — team confirm machine
GATE_EXIT=1
```

**This is not an open defect — it is an accurately documented one.** The check
now carries a 20-line comment at `check-dismiss-peek.tsx:123-142` naming the
inertness, the mechanism, the values measured, and the two instruments that
*do* catch the boundary. Every claim in that comment reproduces. The right
follow-up is not to "fix" `check-dismiss-peek` but to make this disclosure
pattern cheap and standard (D3), because the failure mode is a *silent* inert
assertion, and this one is no longer silent.

**Same class, one gate over, and this one is NOT documented — gate 11.**
`check-secret-requests.ts:297-306` expresses every cap assertion in terms of
`RENDERED_NOTE_CAP`, which it **imports from the subject** (`:33`). So the
constant is unpinned:

```
===== GATE 11 — RENDERED_NOTE_CAP raised 2000 -> 20000 =====
export const RENDERED_NOTE_CAP = 20000;
ALL PASS
GATE_EXIT=0

===== GATE 11 — capNote stops flagging the cut (truncated: true -> false) =====
1 FAILURE(S)
GATE_EXIT=1
```

The check proves `capNote` cuts at *whatever the cap is*; it can never notice
the cap becoming 20 000 characters in a panel. Fleet memory
`test-imports-threshold-from-subject`. If 2000 is load-bearing, one assertion
against the literal is the whole fix; if it is not, say so in the header the
way `check-dismiss-peek.tsx` now does.

### 4.7 Gate 19 — what it actually guards

Three mutations, three different answers, so the record is precise:

| mutation | result |
|---|---|
| reword a pinned prose line in `docs/plan/notification-gap.md:126` (`stable symbol anchor` → `marker`) | **RED** — `2 FAILURE(S) — 91/92 pins … classified` |
| rename the live-pinned symbol: `thread-mapping.ts:334` `tool_result` → `tool_outcome` | **RED** — `1 FAILURE(S) — 92/92 pins` |
| shift a live-pinned file by 2 lines (`sed -i '1i …'` atop `thread-mapping.ts`) | **GREEN** — `ALL PASS — 92/92 pins` |

The third is **by design and disclosed**: the resolver searches the file for
the `expect` regex and annotates the difference rather than failing —
`const drift = (declared, found) => (found === declared ? "" : "  (now :" + found + ")")`
(`verify-notification-gap-pins.mjs:757`), and the header says so at `:36`
(*"`now :M` — drift stays visible without being fatal"*). Recorded here so the
next reader does not mistake a design choice for a hole.

Worth knowing about its shape: of 92 pins, **4 are `live`** (re-verified
against real source: `executor.ts:484`, `thread-mapping.ts:334`,
`thread-mapping.ts:351`, `cc-runner.ts:266`), 7 cross-doc, and 58 are
`repeat`/`historical` — pins the rules deliberately classify as restatements
or as records of where a symbol *used to* sit. The gate is mostly a guard on
one document's internal consistency, and only marginally on the code it cites.
That is a legitimate design; it is not what the gate's name suggests.

### 4.8 Gate 23 — bites on two files, ignores every other

Its drift guard reads a two-element literal (`psql-argv-leak.cjs:215-218`):

```js
const SENTINEL = "docs/plan/artifacts/phase800/secret-sentinel.cjs";
const WSQL = "scripts/checks/check-working-sql-agreement.ts";
for (const rel of [SENTINEL, WSQL]) src[rel] = fs.readFileSync(path.join(REPO, rel), "utf8");
```

**It bites on those two:**

```
--- mutation: check-working-sql-agreement.ts:129
    raw = execFileSync("psql", [DATABASE_URL as string, "-tA", "-c", sql], {
1 FAILURE(S) — 23 checks
GATE_EXIT=1
```

**And ignores an identical defect in a new file:**

```
--- mutation: scripts/checks/d2probe-leak.ts
import { execFileSync } from "node:child_process";
const url = process.env.DATABASE_URL as string;
export const out = execFileSync("psql", [url, "-tA", "-c", "select 1"]);
--- gate: node docs/plan/artifacts/phase800/psql-argv-leak.cjs | tail -2
GATE_EXIT=0
```

The invariant "no connection URL in a psql argv" is repo-wide; the gate's
subject set is two files chosen in round 808. A repo-wide `git grep` for the
same regex would cost one line.

Second, smaller note, **trap (b) again**: half A of this gate (assertions
A1–A10b, roughly half its 23 checks) runs `psqlBefore`/`psqlAfter`, which are
**copies of both code paths defined inside the check itself**
(`psql-argv-leak.cjs:112-156`). No repo state can change their outcome. A2
(*"the round-806 form LEAKS the password"*) is an assertion that a defective
code path still behaves defectively — a deliberate negative control, and a
correct one, but it means half this gate's assertion count is immune to the
repo by construction. That matters when someone reads "23 checks" as coverage.

### 4.9 Gate 24 — INERT. The one round 0 did not have.

**Structurally**: it reads no repo file. Its only `require`s are `node:fs`,
`node:os`, `node:path`; its only `fs` call is a `writeFileSync` of its own
JSON into `/tmp`; its two `process.env` reads (`:83`, `:85`) choose that output
directory and nothing else.

```
$ grep -cE 'readFileSync|require\("\.|require\(.\.' docs/plan/artifacts/phase800/nav-walk-sampling.cjs
0
```

Its inputs are a hard-coded `POLLS` table (`:148-153`), a hard-coded
`WINDOW_MS = 30_000` (`:88`), and a fixed PRNG seed `SEED = 808` (`:92`). Every
one of its 11 assertions is a statement about that closed system, checked by a
closed-form formula against a Monte-Carlo of the same formula. It is a correct
mathematical proof, re-derived on every run, of something that cannot change.

**Empirically**: the mutation that makes its own headline assertion A4 false —
*"the review's direction is backwards: 11 s varies where the current 10 s does
not"* — is to move the real chat-list poll to 11 s. The gate does not notice:

```
===== GATE 24 — the REAL chat-list poll moves 10s -> 11s =====
--- mutation: forge-control-web/app/desktop/chat/pollBudget.ts:33
export const CHAT_LIST_POLL_MS = 11_000;
--- gate: node docs/plan/artifacts/phase800/nav-walk-sampling.cjs | tail -3
ALL PASS — 11 checks → /tmp/phase800-out/nav-walk-sampling.json
GATE_EXIT=0
```

Verdict **INERT**. It is a good analysis document that has been given a gate
slot. The invariant a gate could hold here — *the periods this analysis assumes
are the periods the app actually polls at* — is one `readFileSync` plus a
regex away, and would have caught the mutation above. Until then it should be
counted as evidence, not as one of 27 gates.

### 4.10 Gates 25 and 26 — VACUOUS-HERE

Both are inside `if [ "$BROWSER" = "1" ]` (`gates-808.sh:263`). No worker brief
in this project, and no runner in the repo, passes `--browser`; `guard.sh:230`
invokes `gates-808.sh --strict` with no browser flag. So in every automated
run they take the `skip` arm, are labelled `(SKIPPED)`, get `CODES+=("-")`, and
are excluded from the RED tally at `:286`. Proven by the baseline and final
runs above: both printed `SKIPPED`.

They are correctly *labelled* — this is not the silent-omission failure the
suite header warns about. But they are two of the "27 gates" and they have
never run in any measurement in this project.

---

## 5. What the next task should do — proposals only, nothing applied

Ordered by the cost of leaving it alone. **None of these were implemented;
repairing the forbidden-file guard changes what every lane may commit.**

1. **Gate 6, three arms** (§4.2). Highest severity: the engine-core protection
   for `project-tick`, `cc-runner`, `executor.ts`, `db/projects` currently
   passes over a live edit in the exact state its own header says to run it in.
2. **`pnpm guard` cannot return 0** (§3). Every lane's default merge command is
   an unactionable red; one `deliberate`/`environmental` flag on `skip_check`
   fixes it.
3. **Gate 22's glob** — D4's job, now with the paired transcript (§4.4). Do not
   widen first and triage after.
4. **Gates 7, 24, 27 should stop being counted as gates** (§4.3, §4.9, §4.5),
   or be given real assertions. Three of 25 executed gates cannot fail on
   anything a lane does; a `RED: 0` line implies 25 verdicts and delivers 22.
5. **Gate 11's cap** (§4.6) — one assertion against the literal `2000`, or a
   header note in the `check-dismiss-peek.tsx` style saying why not.
6. **Gate 23's subject list** (§4.8) — replace two hard-coded paths with a
   repo-wide `git grep` of the same regex.
7. **`test-guard-discrimination.sh` covers 3 of guard.sh's 8 fast checks** —
   `tsc-forge-control-web`, `no-raw-colours`, `dollar-sweep`. It does **not**
   cover `node-version`, `devdeps-*` or `forbidden-file-diff`. The one guard.sh
   check that does not bite is the one its own mutation harness does not test.
   D3 should extend the harness rather than invent a second one: it already
   asserts on the individual check's row in `guard.sh --json` rather than the
   overall verdict, which is the design that survives a shared worktree.

---

## 6. Tree state at the end

Every mutation restored, proven by `md5sum` on both sides (`RESTORED=yes` on
every transcript above; created files removed, `AFTER_MD5=(absent)`).

```
$ git status --porcelain
(empty — except the sibling task's own D1 edits, which were never touched
 and were committed by that task as b308ddb during this run)
```

A second full `gates-808.sh --strict` run at the end of the round reproduces
the baseline exactly:

```
$ diff <(sed -n '/SUMMARY/,/RED:/p' /tmp/d2-c2bcea3f/baseline-gates.log) \
       <(sed -n '/SUMMARY/,/RED:/p' /tmp/d2-c2bcea3f/final-gates.log) \
  && echo "IDENTICAL baseline vs final summary"
IDENTICAL baseline vs final summary
```

Same 27 rows, same `RED: 1`, same gate, same `SUITE_EXIT=1`. Nothing this
round did survived into the tree.

---

## 7. `pnpm guard:test` is RED right now — and the reason is the D3 lesson

The repo already owns the mutation harness this project is asking for:
`scripts/checks/test-guard-discrimination.sh`, wired at
`package.json:guard:test`. Its design is right and D3 should extend it rather
than start over. But it fails today, and the failure is not noise:

```
$ pnpm guard:test        # full log: /tmp/d2-c2bcea3f/guardtest.log
═══ Defect 1/3: type error → tsc-forge-control-web ═══
PASS — type error turns tsc-forge-control-web RED (FAIL)
PASS — restoring the tree turns tsc-forge-control-web GREEN (PASS)

═══ Defect 2/3: raw colour literal → no-raw-colours ═══
  [no-raw-colours] status=FAIL detail=forge-control-web/app/_guard-scratch-colour.tsx:1
PASS — raw colour literal turns no-raw-colours RED (FAIL)
GREEN probe (file removed):
  [no-raw-colours] status=FAIL detail=forge-control-web/app/desktop/goals/WeekGrid.tsx:48
FAIL — restoring the tree turns no-raw-colours GREEN: got 'FAIL', want 'PASS'

═══ Defect 3/3: dollar-shaped hit → dollar-sweep ═══
PASS — dollar-shaped literal turns dollar-sweep RED (FAIL)
PASS — restoring the tree turns dollar-sweep GREEN (PASS)

clean — no residue in forge-control-web/app
test-guard-discrimination.sh FAILED — 1 assertion(s) did not hold.
GUARDTEST_EXIT=1
```

**What happened.** Its own header (`test-guard-discrimination.sh:12-22`) says
it asserts on the individual check's row in `guard.sh --json`, not the overall
verdict, *"so this script is not flaky against unrelated work"*. That is the
right instinct and it protects the RED probe. It does **not** protect the GREEN
probe, which asserts `status == "PASS"` for the whole check — so an inherited
red **in the same check** (here: `b41e824`'s week-board palette, §0.4) makes
the restore-probe unsatisfiable.

**The generalisable lesson for D3, stated as a rule:** a mutation control has
two halves, and each needs a different assertion.

- The RED half asserts the check **now names your mutation** — `detail`
  contains your scratch path. Robust to any pre-existing red.
- The GREEN half must assert the check **no longer names your mutation**, not
  that the check is green. `status == "PASS"` is an assertion about the whole
  repo, and in a repo where five lanes commit concurrently, that is an
  assertion about other people's work.

One-line fix for the existing harness, proposed, not applied: replace
`assert_eq "…GREEN" "$green" "PASS"` with an assertion that the check's
`detail` no longer contains the scratch filename. That is the same discipline
as `verifier-asserted-on-fixture-not-invariant` — assert on the behaviour under
test, never on state the system exists to tolerate.

---

## 8. Handoff to D4 — the glob job, measured

Not done here (D4 owns it), but these are the numbers so D4 does not re-derive
them.

**What the wider pattern would newly capture inside `forge-control`: nothing.**

```
$ ls forge-control/src/lib/*.test.ts | wc -l
72
$ find forge-control/src -name '*.test.ts' -not -path '*/lib/*' | wc -l
0
```

So widening `forge-control/package.json:test` to a recursive glob is
prophylactic, with **zero files to triage today**. The failure it prevents is
the one measured in §4.4.

**What is genuinely orphaned is in the other package**, which has no `test`
script at all:

```
$ git ls-files | grep -E '\.(test|spec)\.(ts|tsx)$' | grep -v '^forge-control/src/lib/'
forge-control-web/app/desktop/goals/quick-add.test.ts
forge-control-web/app/desktop/map/mapTree.test.ts
forge-control-web/app/desktop/spend-skew.test.ts
$ grep -n '"test"' forge-control-web/package.json || echo "NO test script"
NO test script
```

**All three pass today** — run with forge-control's `tsx` from
`forge-control-web/`:

```
$ ../forge-control/node_modules/.bin/tsx --test "app/**/*.test.ts"
ok 1 - parseQuickAdd — \#area
… ok 16 - incompleteDayMessage
# tests 62
# pass 62
# fail 0
```

So D4's triage burden is currently **zero failures on both sides**. That is a
reason to do it now, not later.

**The mechanism, and the shape of the fix, measured on this toolchain**
(node v22.22.2, tsx from `forge-control/node_modules`). Node 22's test runner
expands a *quoted* glob itself — the current script relies on the shell, which
is why it is one directory wide:

```
$ cd forge-control
# A — current shape, shell-expanded, two explicit directories
$ ./node_modules/.bin/tsx --test src/lib/d2glob-*.test.ts src/routes/d2glob-*.test.ts
ok 1 - d2glob A (src/lib) — passes
ok 2 - d2glob B (src/routes) — passes
# tests 2

# B — a quoted recursive glob, expanded by node per the v22 docs
$ ./node_modules/.bin/tsx --test "src/**/d2glob-*.test.ts"
ok 1 - d2glob A (src/lib) — passes
ok 2 - d2glob B (src/routes) — passes
# tests 2

# C — what the current package.json glob alone sees
$ ./node_modules/.bin/tsx --test src/lib/d2glob-*.test.ts
# tests 1
```

Both probe files were removed afterwards; `git status --porcelain` clean.
Node's own documentation for v22 confirms the semantics — *"one or more glob
patterns can be provided as the final argument(s)… The glob patterns should be
enclosed in double quotes on the command line to prevent shell expansion"*
(nodejs.org, Test runner, accessed 2026-08-25). Its default discovery, used
when **no** paths are given, already includes `**/*.test.{cts,mts,ts}`
recursively — so dropping the path argument entirely is the other viable shape.

Order still matters and is unchanged from the brief: enumerate → run → fix or
quarantine with a named reason → *then* widen `package.json` and gate 22.
