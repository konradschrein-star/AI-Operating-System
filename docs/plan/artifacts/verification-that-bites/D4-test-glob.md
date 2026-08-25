# D4 — test-glob: enumerate, run, quarantine, then widen

Project `aios-verification-that-bites`, workstream `glob`, round 0 task D4.
Branch `project/169903ec-glob`.

## 0. A note on provenance

The task brief said "Read PLAN.md in the repo root FIRST — round 0 measured
the terrain". That file is **stale**: `git log -1 -- PLAN.md` shows it was
last touched by commit `88fddb8` ("docs(takeover): plan the one hop"), an
unrelated browser-takeover project. No `docs/plan/artifacts/verification-that-bites/`
directory existed anywhere in this worktree's history before this task ran.
This report proceeds entirely from the round-0 facts given **inline in the
task text** — every one of them was re-verified independently below, not
cited from the brief.

## 1. STEP 1 — re-verify the baseline, three times each

Commands run from the worktree root
(`/opt/ai-os/workspace/projects/169903ec-4dd0-4041-a737-eeba3d178d36--glob`)
unless noted.

### 1a. Enumerate every tracked test file

```
$ git ls-files | grep -E '\.test\.(ts|tsx)$' | wc -l
75
```

### 1b. Which match the CURRENT glob (`forge-control/src/lib/*.test.ts`)

```
$ git ls-files | grep -E '^forge-control/src/lib/[^/]+\.test\.ts$' | wc -l
72
```

Escapees (75 − 72 = 3), all in `forge-control-web`, which has **no test
script at all**:

```
forge-control-web/app/desktop/goals/quick-add.test.ts
forge-control-web/app/desktop/map/mapTree.test.ts
forge-control-web/app/desktop/spend-skew.test.ts
```

Matches the brief's claim exactly.

### 1c. The 3 escapees pass standalone — run 3×

```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --test 'app/desktop/**/*.test.ts'
run 1: # tests 62 / # pass 62 / # fail 0 / duration_ms 2822.87
run 2: # tests 62 / # pass 62 / # fail 0 / duration_ms 1635.99
run 3: # tests 62 / # pass 62 / # fail 0 / duration_ms 1687.70
```

No flake across three independent runs.

### 1d. Baseline `forge-control` suite — run 3×

```
$ cd forge-control && pnpm test
run 1: # tests 2200 / # pass 2200 / # fail 0
run 2: # tests 2200 / # pass 2200 / # fail 0
run 3: # tests 2200 / # pass 2200 / # fail 0
```

### 1e. Nesting check

```
$ find forge-control/src -name '*.test.ts' | grep -v '^forge-control/src/lib/'
(none — all 72 are flat in src/lib/)
```

**Quarantine: none required.** Nothing failed in STEP 1. All four claims from
the brief's round-0 measurement reproduced exactly, with no flake across three
runs each.

### 1f. Live finding during this task (not a STEP-1 failure, disclosed for the record)

Mid-session, after STEP 1 completed clean but before STEP 2's final
verification, `pnpm test` in `forge-control` returned `# tests 1967 / # pass
1950 / # fail 17`, including an uncaught `ENOENT` on
`src/routes/reminders.ts`. Investigation: `git status --short` showed 48 files
under `forge-control/src/routes/` as `D` (deleted, uncommitted) on disk, and
`ls src/routes/` failed with "No such file or directory" — a live sibling
task in this **shared** worktree (another `claude` process, PID 1372880, with
`cwd` inside this same worktree directory) was mid-write to that directory.
It resolved on its own within ~30–45s; `src/routes/` returned intact,
untouched by me, and three subsequent clean runs all reported `2200/2200`.

This is **not a finding against the D4 widening** — it reproduced with the
*unwidened* glob just as it would have with the widened one, since the
affected files are all under `src/routes/`, outside both globs' scope at the
time. It is disclosed because it is exactly the failure class named in fleet
memory `gates-808-unit-suite-flakes-under-sibling-contention`, observed here
at whole-directory-deletion severity rather than single-test flake severity.
Reported to the manager chat live; no action taken on the sibling's files.

## 2. STEP 2 — widen

### 2a. `forge-control-web/package.json` — add a `test` script

`forge-control-web` has no `tsx` in its own `node_modules`
(`ls forge-control-web/node_modules/.bin/tsx` → No such file or directory), so
the script must reach across to `forge-control`'s copy:

```json
"test": "../forge-control/node_modules/.bin/tsx --test 'app/**/*.test.ts'"
```

Verified via `pnpm test` (not the raw binary) from `forge-control-web/`:

```
$ pnpm test
# tests 62
# pass 62
# fail 0
```

### 2b. `forge-control/package.json` — widen `src/lib/*.test.ts` → `src/**/*.test.ts`

```json
"test": "tsx --test 'src/**/*.test.ts'"
```

**The pattern is single-quoted so `tsx`/node's test runner expands it, not
bash.** This is not cosmetic — proved with a throwaway two-level-deep probe
file (`src/routes/nested/__glob-probe2.test.ts`, one trivial passing test,
removed after the comparison):

```
$ bash -c "tsx --test src/**/*.test.ts   | grep -E '^# (tests|pass|fail)'"   # UNQUOTED
# tests 2200   <- misses the file two levels deep, exits 0, no error
# pass 2200
# fail 0

$ bash -c "tsx --test 'src/**/*.test.ts' | grep -E '^# (tests|pass|fail)'"   # QUOTED
# tests 2201   <- catches it
# pass 2201
# fail 0
```

Bash's own `**` degrades to a single-segment `*` without `shopt -s globstar`
(which `pnpm`'s script shell does not set), so it silently matches exactly
one level of nesting and no more — a widened glob that still misses anything
two directories deep, with no error, no warning, exit 0. Quoting so the
runner's own glob engine (which supports true recursive `**`) does the
expansion is the only form that is honest about what it claims to cover.

Verified the widened, quoted glob still finds all 72 and reports 2200/2200,
via `pnpm test` (three runs, clean, after the sibling-contention episode in
§1f settled):

```
$ cd forge-control && pnpm test   (×3, post-widening, post-contention)
run 1: # tests 2200 / # pass 2200 / # fail 0
run 2: # tests 2200 / # pass 2200 / # fail 0
run 3: # tests 2200 / # pass 2200 / # fail 0
```

### 2c. `scripts/checks/gates-808.sh` gate 22 — add a sibling gate

Kept the existing forge-control gate unchanged and added a sibling
immediately after it, using the same `gate_sh` helper and the same
`| grep -E '^# (tests|pass|fail)'` shape:

```bash
gate_sh "pnpm test — forge-control unit suite" \
  "cd forge-control && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"

gate_sh "pnpm test — forge-control-web unit suite" \
  "cd forge-control-web && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"
```

`gate_sh` sets `set -o pipefail` inside `bash -c` (gates-808.sh:83-88), so a
red suite piped into `grep` is not swallowed by `tail`/`grep`'s own exit
status. Confirmed by control in STEP 3 below: the RED run reports `EXIT=1`,
not `EXIT=0`.

### 2d. Root `package.json` — aggregator script

Added, because a bundled `pnpm test` at the repo root is otherwise absent and
the two suites now live in two different packages. Made honest with explicit
status capture rather than `&&` (short-circuits, would hide a red web suite
after a green forge-control one) or bare `;` (loses the first status if the
second is green):

```json
"test": "bash -c 'pnpm --dir forge-control test; s1=$?; pnpm --dir forge-control-web test; s2=$?; exit $(( s1 > s2 ? s1 : s2 ))'"
```

Verified green end-to-end:

```
$ pnpm test   (root)
# tests 62 / # pass 62 / # fail 0   (forge-control-web, last script to print)
EXIT=0
```

(gates-808.sh does not call this aggregator — it keeps the two suites as
separate, individually-attributable gates per 2c, which is the more useful
signal for a reviewer. The aggregator exists for a developer running `pnpm
test` from the root by hand.)

## 3. STEP 3 — prove the new gate bites (mandatory, not a decoration)

Mutated `forge-control-web/app/desktop/goals/quick-add.test.ts` line 31:

```diff
- assert.equal(r.area, "uni");
+ assert.equal(r.area, "uni-DELIBERATELY-WRONG-D4-BITE-PROOF");
```

### RED transcript — the exact gate-22-sibling command, verbatim

```
$ bash -c "set -o pipefail; cd forge-control-web && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"
# tests 62
# pass 61
# fail 1
EXIT=1
```

Failing subtest, from the un-grepped run:

```
not ok 1 - extracts the area and strips it from the title
  location: '.../forge-control-web/app/desktop/goals/quick-add.test.ts:1:223'
  failureType: 'testCodeFailure'
not ok 1 - parseQuickAdd — \#area
  failureType: 'subtestsFailed'
```

### Revert, proved by hash

```
$ md5sum app/desktop/goals/quick-add.test.ts   # before mutation
aea2fc9bb717e378df6428bd7c5c49e5

# ... mutate, run RED above, then revert the same line back to assert.equal(r.area, "uni") ...

$ md5sum app/desktop/goals/quick-add.test.ts   # after revert
aea2fc9bb717e378df6428bd7c5c49e5
```

Identical hash — the revert is byte-for-byte the original file, not a
close-enough rewrite.

### GREEN transcript — same command, reverted file

```
$ bash -c "set -o pipefail; cd forge-control-web && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"
# tests 62
# pass 62
# fail 0
EXIT=1 -> EXIT=0
```

The gate is not a decoration: it goes RED on a real regression with the
correct nonzero exit code under `set -o pipefail`, and returns cleanly to
GREEN once the regression is gone, on a file proved identical to its
original state.

## 4. STEP 4 — the durable invariant (spec only, not built here)

Widening the glob fixed three known escapees. It does not stop a fourth: a
future `*.test.ts` dropped under, say, `forge-control/src/routes/` two
directories past whatever the glob happens to cover today, or in a third
package with no runner at all, would again pass standalone and never run in
CI. **This is a structural gap, not a one-off.**

### The invariant a check should enforce

> Every file tracked by git matching `*.test.ts` or `*.test.tsx` must be
> matched by the glob of at least one `test` script in a package.json in the
> repo. If not, FAIL and name the file.

### Today's answer, computed mechanically (the later task lifts this directly)

Set A — every tracked test file:

```bash
git ls-files | grep -E '\.test\.(ts|tsx)$' | sort > setA.txt
# 75 files
```

Set B — what each package's `test` script glob actually expands to on disk
(computed via `find`, which matches the same recursive semantics as the
quoted globs in §2, since both packages' patterns are `<root>/**/*.test.ts`):

```bash
(cd forge-control     && find src -name '*.test.ts'                          | sed 's#^#forge-control/#')
(cd forge-control-web && find app -name '*.test.ts' -o -name '*.test.tsx'    | sed 's#^#forge-control-web/#')
# union, sorted -> setB.txt
# 72 + 3 = 75 files
```

Diff:

```bash
comm -23 setA.txt setB.txt
# (empty)
```

**Post-widening, the diff is empty: 75/75 covered.** A structural check would
run exactly this diff and `FAIL`, printing each line of `comm -23 setA.txt
setB.txt`, if it is ever non-empty again. It needs no knowledge of glob
syntax beyond "read each package.json's `test` script, resolve its working
directory, and `find` under whatever root directory that glob's literal
prefix names" — a generic enough shape to survive a fourth package being
added later without a rewrite.

Enumerating each package's glob root generically (rather than hardcoding
`src`/`app`) is the one piece of real logic such a checker needs: parse the
literal directory prefix before the first glob metacharacter (`*`) in each
`test` script's pattern argument, per package.json found via `git ls-files
'**/package.json'`. Out of scope for this task per the brief (D4 reports the
invariant, a later task builds it).

## 5. STEP 5 — guard

```
$ bash scripts/checks/guard.sh --full --strict
```

<!-- GUARD_RESULT_PLACEHOLDER -->

## 6. Files changed (declared write-set)

- `package.json` (root) — added aggregator `test` script (§2d)
- `forge-control/package.json` — widened `test` script glob (§2b) **— not
  separately named in the declared write-set, which lists a single bare
  "package.json"; disclosed here since this repo has three package.json
  files and the brief's step 2b explicitly requires editing this one**
- `forge-control-web/package.json` — added `test` script (§2a)
- `scripts/checks/gates-808.sh` — added sibling gate for the web suite (§2c)
- `docs/plan/artifacts/verification-that-bites/D4-test-glob.md` — this file
- `forge-control-web/app/desktop/goals/quick-add.test.ts` — mutated then
  reverted for the bite proof in §3; final state is byte-identical to
  pre-task (md5 `aea2fc9bb717e378df6428bd7c5c49e5`, verified above), so it
  carries no net diff, but the commit history will show the mutate+revert
  pair — disclosed so the reviewer doesn't need to dig for why that file
  moved in the log.

No other files were written. `forge-control/src/routes/*.ts` transiently
showed as deleted in `git status` during this session (§1f) — that was a
sibling task's uncommitted in-flight edit, not mine; nothing in that
directory was touched, viewed as a diff, or committed by this task.
