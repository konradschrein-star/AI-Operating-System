# Phase 2 GATING REVIEW — `check-instrument-typecheck.sh`

**VERDICT: FAIL.**

**Tip reviewed:** `git rev-parse HEAD` = `aa2ab5bd61b2e6ca9cc8fef8c7351aea42f4379c`,
branch `project/b7ab4c57`, worktree
`/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`.
HEAD was re-read immediately before the blockers below were written and had not
moved. Gate sha256 `dbf1f946d747500355c3a593ac55d4178fcce03b0978cb18b45c3b1d75b416f4`,
profile sha256 `eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e`,
tsc 5.7.2, node v22.22.2.

**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
(the per-project one). `docs/plan/03-quality.md` also exists — it is the fleet's
older corpus — and was read; §3's phase-2 block in the per-project file is the
one this review executed.

**Why FAIL, in one sentence:** the gate is excellent at everything it was
measured on and the acceptance criteria A2.1–A2.9 all pass, but the red team's
brief A2 succeeded — I independently reproduced **six distinct ways** to make
this gate print `PASSED` and exit 0 while a genuinely type-broken file sits on
disk under `scripts/checks/`, and 03-quality.md §6 states that "a gate that can
be made to lie is worse than the absence it replaces."

---

## 0. Live-checkout cleanliness (mandatory)

```
$ git -C /opt/forge-ai-os status --porcelain
(empty)
```

Empty, checked at the start of the review and re-confirmed at the end. Nobody
hot-applied work into the live checkout. No finding.

Worktree cleanliness after every experiment in this review:

```
$ git status --porcelain
(empty)
```

Every destructive experiment ran in a scratch copy under `mktemp -d`
(`/tmp/rev2-QKg2Si/repo`, `rsync -a --exclude node_modules --exclude .git` with
`node_modules` symlinked back), which was removed at the end. `/opt/forge-ai-os`
was never touched. `pm2` was never invoked.

---

## 1. The gate suite (mandatory before any PASS)

This project ships no gate suite of its own; the fleet's is
`scripts/checks/gates-808.sh`, and it accepts `--strict` (line 45), so that is
the documented invocation I used.

```
$ bash scripts/checks/gates-808.sh --strict
...
 SUMMARY — 25 gates
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck
 13 0      check-stop-affordance.tsx
 14 0      check-dismiss-peek.tsx
 15 0      check-team-rows.ts
 16 0      check-team-confirm.ts
 17 1      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs
 22 0      nav-walk-sampling.cjs
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 1
gates-808 --strict exit=1
```

**25 gates in the suite. EXECUTED 23. RED 1. SKIPPED-by-design 2** (gates 23 and
24 are the browser gates, skipped unless `PHASE600_BASE_URL`/`PHASE700_BASE_URL`
are set).

**Gate 17 is pre-existing red, not this branch's regression.** Both its input and
its checker are untouched by this branch:

```
$ git diff --name-only main...HEAD -- docs/plan/notification-gap.md \
      docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
(empty)
```

The inputs are byte-identical to `main`, so the gate is red on `main` by
construction. It is reported here rather than waived: it does not change this
phase's verdict, which fails on its own merits, but it is not this phase's to
fix either.

---

## 2. The phase-2 command block, run verbatim (03-quality.md §3)

### Dependencies first

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 869ms using pnpm v9.15.9        # exit 0
$ cd forge-control && pnpm install --frozen-lockfile --prefer-offline --prod=false
Already up to date
Done in 684ms using pnpm v9.15.9        # exit 0
```

### The gate itself

```
$ ls scripts/checks/*.ts scripts/checks/*.tsx | wc -l
42

$ ls /tmp | wc -l                       # BEFORE
3777

$ time bash scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
real	0m55.462s
exit=1

$ ls /tmp | wc -l                       # AFTER
3778                                    # +1 = my own /tmp/gate-run1.txt redirect target

$ ls -d /tmp/tmp.1d10pIz7Pj             # the run's own temp dir
ls: cannot access '/tmp/tmp.1d10pIz7Pj': No such file or directory

$ ls -d /tmp/tmp.* | wc -l              # before = after = 10 (all pre-date this review)
10

$ git status --porcelain
(empty)
```

Transcript head and tail, verbatim:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/*.ts scripts/checks/*.tsx, enumerated at run time

UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : aa2ab5bd61b2e6ca9cc8fef8c7351aea42f4379c
  git branch       : project/b7ab4c57
  this check       : /opt/…/scripts/checks/check-instrument-typecheck.sh
  this check sha256: dbf1f946d747500355c3a593ac55d4178fcce03b0978cb18b45c3b1d75b416f4
  profile          : /opt/…/tsconfig.checks-instruments.json
  profile sha256   : eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e
  tsc              : Version 5.7.2  (/opt/…/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.1d10pIz7Pj
…
PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
  wall clock       : 55s

check-instrument-typecheck.sh FAILED — 6 type failure(s), 0 fidelity violation(s), 0 missing subject(s), census mismatch 0.
```

Exit 1 with exactly the phase-3 six, as the brief's EXPECTED clause demands.
`git log --oneline main..HEAD` carries **no phase-3 commits** — the parallel
exception does not apply and was not needed.

### Determinism (NF2)

```
$ bash …/check-instrument-typecheck.sh > /tmp/a 2>&1   # exit 1
$ bash …/check-instrument-typecheck.sh > /tmp/b 2>&1   # exit 1
$ diff /tmp/a /tmp/b
19c19
<   temp dir         : /tmp/tmp.ShNJVnOfXy
---
>   temp dir         : /tmp/tmp.jf26AhECoD
85c85
<   wall clock       : 55s
---
>   wall clock       : 57s
```

Exactly the two lines NF2 permits.

### Another cwd, absolute path (I6 / A2.6)

```
$ cd /tmp && bash /opt/…/scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  FAIL scripts/checks/check-orientation.ts              exit 2
  FAIL scripts/checks/check-team-confirm.ts             exit 2
  FAIL scripts/checks/check-team-rows.ts                exit 2
  FAIL scripts/checks/serve-sse-808.ts                  exit 2
  FAIL scripts/checks/check-dismiss-peek.tsx            exit 2
  FAIL scripts/checks/check-stop-affordance.tsx         exit 2
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
exit=1

# diagnostics still repo-relative, not ../../..-prefixed:
         scripts/checks/check-orientation.ts(129,38): error TS2322: …
```

### shellcheck (A2.7)

```
$ shellcheck -S error scripts/checks/check-instrument-typecheck.sh
$ echo "exit=$?"
exit=0
```

Clean. (At default severity it emits only SC2317 "command appears unreachable"
on `cleanup()` lines 147–148 — a false positive on a trap handler, informational,
not in scope for `-S error`.)

### Independent census

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
════════ summary
green 36 / red 6 / total 42            # exit 0
```

The same six files, with the same eleven diagnostics, as the gate's own run.
The gate's census and phase 1's independent instrument agree exactly.

### P-A and P-B (03-quality.md §3)

```
$ git diff main...HEAD -- scripts/checks/ | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
ok: no suppressions

$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'
(empty)
```

---

## 3. Write-set audit

The phase-2 builder declared two write-set paths and restated them in
`phase2-gate.md` §"What this phase did NOT touch". What its commits actually
touched:

```
$ git log --name-only --oneline d2b4563 -1
d2b4563 feat(…round-200, phase 2): the gate enumerates by glob and compiles through the profile
scripts/checks/check-instrument-typecheck.sh

$ git log --name-only --oneline 1696346 -1
1696346 docs(…round-200, phase 2): evidence — U7-U9, U12, U13, I1-I6, …
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-gate.md

$ git diff --name-only main...HEAD -- scripts/checks/instrument-manifest.txt
(empty)
```

Exactly the two declared files, no undeclared writes, the manifest and every
corpus document untouched. **Write-set audit: clean.** The red team's commit
`aa2ab5b` likewise touched only `evidence/phase2-redteam.md`.

---

## 4. Acceptance criteria A2.1–A2.9

| # | Criterion | Evidence line I checked it against | Result |
|---|---|---|---|
| A2.1 | found = compiled = `ls … \| wc -l` = 42 | `ls … \| wc -l` → `42`; census `subjects found 42   subjects compiled 42` | **PASS** |
| A2.2 | exit 1, exactly the phase-3 six | `exit=1`; the six FAIL lines above; `git log main..HEAD` has no phase-3 commit | **PASS** |
| A2.3 | provenance, all ten R20 fields, above the first PASS/FAIL | provenance block above — worktree, HEAD, branch, self path, self sha256, profile, profile sha256, tsc, node, subjects found, invocation shape (11 fields; all ten of R20 present), printed before the first `PASS` line | **PASS** |
| A2.4 | tree clean after normal, failed and SIGINT runs | run above (`(empty)`); SIGINT run below, **run by me** | **PASS** |
| A2.5 | two consecutive identical; two concurrent both correct | the `diff /tmp/a /tmp/b` above; the concurrency run below, **run by me** | **PASS** |
| A2.6 | correct verdict from another cwd by absolute path | the `cd /tmp` transcript above | **PASS** |
| A2.7 | `shellcheck -S error` clean | `exit=0` above | **PASS** |
| A2.8 | U7, U8, U9, U12, U13 transcripts present | `phase2-gate.md` lines 515, 556, 588, 660, 707 — each with real output and a real exit code; U7 and U13 re-run by me below, U12's shape re-run as F7 | **PASS** |
| A2.9 | reviewer's own reading of every suppression | §5 below, my own, with line numbers | **PASS** |

### A2.4, the SIGINT case — run by me, not taken from the transcript

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/rev2-sigint2.txt 2>&1 &
$ sleep 8 ; TD=$(sed -n 's/^  temp dir *: //p' /tmp/rev2-sigint2.txt)
temp dir in flight: /tmp/tmp.6gP9500g8F
EXISTS while running: yes
configs present: 9
$ kill -INT "$GPID" ; wait "$GPID"
exit after SIGINT=130
$ [ -d "$TD" ] && echo LEAK || echo removed
>>> removed: /tmp/tmp.6gP9500g8F
$ git status --porcelain
(end)
$ grep -cE 'PASSED|FAILED —' /tmp/rev2-sigint2.txt
0
```

Exit 130, temp directory gone, tree clean, and **no verdict line at all** — an
interrupted run cannot be misread as a pass.

### A2.5, two concurrent runs — run by me

```
c1 exit=1
c2 exit=1
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
$ diff /tmp/c1 /tmp/c2
19c19
<   temp dir         : /tmp/tmp.LA3g9dw940
---
>   temp dir         : /tmp/tmp.nllLfSMJAl
85c85
<   wall clock       : 63s
---
>   wall clock       : 62s
```

Two distinct temp directories, two correct and identical censuses.

### A2.8, U7 and U13 re-run by me

```
# U7 — subject set emptied in a scratch copy
REFUSING TO RUN: zero subjects matched scripts/checks/*.ts scripts/checks/*.tsx under /tmp/rev2-QKg2Si/repo.
  A gate over nothing certifies nothing. …
exit=1

# U13 — a subject deleted 2 s into a run
  MISSING scripts/checks/check-nav-stack.ts             enumerated but ABSENT at compile time — NOT compiled
  subjects found 3   subjects compiled 2   type failures 0   fidelity violations 0   missing 1
  MISMATCH: compiled 2 of 3 subjects found — a subject was SKIPPED and this run certifies nothing.
check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 1 missing subject(s), census mismatch 1.
exit=1
```

Both reproduce the builder's transcripts. The R19 `MISSING` path is real and
load-bearing.

---

## 5. A2.9 — MY OWN reading of every suppression, one line each

This clause is not satisfiable by citing the builder, so I enumerated
independently before comparing. My enumeration:

```
$ grep -n -F -- '|| true'     …   # 0 occurrences
$ grep -n -F -- '|| :'        …   # 0 occurrences
$ grep -n -F -- 'set +e'      …   # 447 only, inside a comment
$ grep -n -F -- '2>/dev/null' …   # 66, 212 (comments); 325, 326 (code)
$ grep -nE '^\s*:(\s|$)'      …   # 392
$ grep -n -F -- 'continue'    …   # 387, 439
$ grep -n -F -- '|| exit'     …   # 216, 261
```

Seven code constructs plus one default expansion. My reading of each:

1. **Line 216 — `cd "$1" || exit 1` (enumeration subshell).** Cannot convert a
   failure into a pass: it makes a failed `cd` a *non-zero subshell exit*, which
   the caller's `if ! …` at 215–228 turns into `REFUSING TO RUN` and `exit 1`.
   It is the inverse of a suppression.
2. **Line 261 — `cd "$1" || exit 1` (uncovered-extension subshell).** Identical
   shape; its caller at 260–271 also refuses. Without it the gate could print
   `none: no file matches …` while never having looked. Cannot reach a pass.
3. **Line 325 — `git rev-parse HEAD 2>/dev/null || echo no-git`.** Provenance
   display only. I verified by grep that `git` is invoked nowhere else in the
   script (lines 325 and 326 are the only two invocations; line 179 is a string
   inside the refusal heredoc). No counter, no branch and no exit path reads it.
   Cannot reach a pass.
4. **Line 326 — `git rev-parse --abbrev-ref HEAD 2>/dev/null || echo no-git`.**
   Same, for the branch field. Cannot reach a pass.
5. **Line 387 — `if [ -z "$line" ]; then continue; fi` in `scan_fidelity`.**
   Skips *blank* lines only. A blank line cannot contain `error TS`, so it can
   hide no diagnostic; the very next branch (388) tests the located shape and
   the one after (400) catches any remaining line containing `error TS`. Cannot
   reach a pass.
6. **Line 392 — bare `:` in the `scripts/checks/*)` case branch.** A no-op on
   the *expected* path (a diagnostic correctly located inside the subject
   directory); the `*)` branch beside it at 394–398 is the one that increments
   `FIDELITY`. Deleting the `:` would change only bash's tolerance for an empty
   branch. Cannot reach a pass.
7. **Line 439 — `continue` for a MISSING subject.** The only `continue` on a
   failure path and the load-bearing entry. It skips *compilation* of a file no
   longer on disk **after** `MISSING=$((MISSING + 1))` at 438 and **without**
   touching `COMPILED`. Three signals therefore fire — the named `MISSING` line,
   `missing N` in the census, and the `COMPILED < FOUND` mismatch at 516–519 —
   and the verdict at 532 requires `FAILED`, `FIDELITY`, `MISSING` *and*
   `CENSUS_MISMATCH` all zero for exit 0. I did not take this on reading alone:
   my own U13 run above produced `missing 1`, `census mismatch 1`, exit 1.
   Cannot reach a pass.
8. **Line 147 — `${TMP:-}` in `cleanup()`.** A `set -u` guard for the window
   before `mktemp -d` has run, so a signal arriving in that window cannot make
   the trap itself die on an unbound variable. It names a directory to delete;
   it touches no counter. `cleanup` ends `return 0` (line 148) precisely so the
   trap can never rewrite the script's exit status. Cannot reach a pass.

**A2.9 conclusion: none of the eight can convert a failure into a pass.** The
builder's audit table is correct and my enumeration found nothing it missed.

**But note what the A2.9 clause does not cover, and finding 7 does:** the
breaches below do not come from any of these constructs. They come from the
*subject set* (what the glob enumerates) and from *what tsc is configured to
check*. A gate can be free of silent fallbacks and still be blind.

---

## 6. NF7 — operator legibility

Stated explicitly, as NF7's verify clause requires: a reader who has never seen
this gate can tell from one transcript what was compiled (42 named PASS/FAIL
lines), what failed and why (full unfiltered `tsc` output per failure, R21),
what the gate refused to do (the refusal blocks), and what it could not see (the
`UNCOVERED EXTENSIONS` block). No output requires reading the source. **NF7:
met** — with the single caveat that the `UNCOVERED` block's `none:` line is
*actively misleading* under findings 2 and 3 below, because it asserts coverage
the gate does not have.

---

## 7. The red team's report — adjudicated attack by attack

I read `evidence/phase2-redteam.md` in full and **re-ran six of its attacks
myself** (B1, B2, B3, B4, B5, B6) plus F1 and F7. Baseline for every
reproduction: a scratch copy trimmed to two known-green subjects,
`PASSED — 2/2 subjects compiled clean.`, exit 0.

| # | Red team's claim | My independent result | Adjudication |
|---|---|---|---|
| B1 | `.d.ts` counted compiled, never typechecked | **REPRODUCED** | **BREACH — accepted** |
| B2 | subdirectory invisible AND unnamed | **REPRODUCED** | **BREACH — accepted** |
| B3 | dotfile subjects skipped silently | **REPRODUCED** | **BREACH — accepted** |
| B4 | `@ts-nocheck` green, P-A blind | **REPRODUCED** | **BREACH — accepted** |
| B5 | fake `node` on PATH | **REPRODUCED**, and worse than reported | **BREACH — accepted** |
| B6 | degraded profile weakens checks | **REPRODUCED in its narrow form only**; two aggravating claims do **not** hold | **BREACH — accepted; the two sub-claims corrected below** |
| F1 | enumeration guard structurally dead | **REPRODUCED** | Finding accepted — fix required |
| F2 | `@ts-ignore` invisible; P-A diff-scoped | Accepted by reading; same root as B4 | Finding accepted — fold into the B4 fix |
| F3/F4 | hostile filenames → wrong diagnosis | Not re-run; both fail closed by the red team's own transcripts | Accepted as LOW; fix desirable, not blocking |
| F5 | `SIGKILL` leaks the temp dir | Not re-run; inherent to `SIGKILL` | **Accept the builder's position** — no fix possible or required |
| F6 | TOCTOU window | Not re-run; inherent to enumerate-then-act | **Accept the builder's position** — no fix required |
| F7 | broken `.mts`/`.cts` named but exit 0 | **REPRODUCED** | Requirement defect in R10 — fix required |
| S1–S11 | 11 attack families survived | Spot-confirmed via U7/U13 and the fidelity behaviour I measured in B6 | Accepted |

### B1 — reproduced

```
$ cat > scripts/checks/broken.d.ts <<'EOF'
export interface Foo { a: string; }
export interface Foo { a: number; }
EOF
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  PASS scripts/checks/broken.d.ts                       exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  subjects found 3   subjects compiled 3   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0

$ forge-control-web/node_modules/.bin/tsc --noEmit --skipLibCheck false --strict \
      scripts/checks/broken.d.ts --pretty false
scripts/checks/broken.d.ts(2,24): error TS2717: Subsequent property declarations must have the same type.  Property 'a' must be of type 'string', but here has type 'number'.
tsc-direct rc=2
```

Mechanism confirmed by reading: `forge-control-web/tsconfig.json` sets
`"skipLibCheck": true`, and `tsconfig.checks-instruments.json` never overrides
it. `skipLibCheck` *is* "do not typecheck declaration files". The subject is
opened, skipped, and counted as compiled. This is the worst outcome available
to this gate — `found == compiled` while a subject was never checked at all.

### B2 — reproduced

```
$ mkdir -p scripts/checks/sub
$ echo 'export const n: number = "not a number";' > scripts/checks/sub/broken.ts
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts
  subjects found 2   subjects compiled 2   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
EXIT=0

$ forge-control-web/node_modules/.bin/tsc --noEmit --strict scripts/checks/sub/broken.ts --pretty false
scripts/checks/sub/broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
tsc-direct rc=2
```

A flat glob is a legitimate design choice (R8 defines it flat). Printing
`none` while an uncompiled TypeScript file sits one directory down is not.

### B3 — reproduced

```
$ echo 'export const n: number = "not a number";' > scripts/checks/.broken.ts
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts
  subjects found 2   subjects compiled 2   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
EXIT=0
```

`nullglob` is set (line 218); `dotglob` is not.

### B4 — reproduced, and this is the one that will happen by accident

```
$ cat > scripts/checks/nocheck-broken.ts <<'EOF'
// @ts-nocheck
export const n: number = "not a number";
export const t: { a: string } = { a: 1, b: 2 };
EOF
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  PASS scripts/checks/nocheck-broken.ts                 exit 0, 0 diagnostics
  subjects found 3   subjects compiled 3   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0

$ printf '+// @ts-nocheck\n' | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
P-A DID NOT CATCH IT
```

R28 forbids five suppressions and P-A greps for exactly those five.
`@ts-nocheck` is in neither list and is strictly more powerful than all of them.
**Phase 3 is about to turn six red files green in this same worktree.** This is
the cheapest way to do it and every gate in the corpus would wave it through.

### B5 — reproduced, and worse than the red team reported

```
$ printf '#!/bin/sh\nexit 0\n' > /tmp/rev2-fakenode/node ; chmod +x …
# control, real node, broken file present:
  FAIL scripts/checks/zz-broken.ts                      exit 2
check-instrument-typecheck.sh FAILED — 1 type failure(s), …          EXIT=1

# attack:
$ PATH=/tmp/rev2-fakenode:$PATH bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  tsc              :   (/tmp/rev2-QKg2Si/repo/forge-control-web/node_modules/.bin/tsc)
  node             : 
  PASS scripts/checks/zz-broken.ts                      exit 0, 0 diagnostics
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0
```

The red team reported the `node` provenance field coming back empty. In my run
**both** `tsc :` and `node :` came back empty — the gate printed two blank
identity fields, meaning it had no working compiler at all, and went on to a
green tick. The gate collects the evidence of its own failure and does not read
it. Precondition is PATH control, so MEDIUM; the non-adversarial version is a
half-broken `nvm`/`volta`/`asdf` shim.

### B6 — breach confirmed, but the report's two aggravating claims are wrong

The narrow claim holds. With `extends` redirected to `{}`:

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/strictly-broken.ts                exit 0, 0 diagnostics
  subjects found 2   subjects compiled 2   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
EXIT=0
```

with `const s: string = null;` on disk (it `FAIL`s exit 2 under the real
profile). So: **BREACH accepted.**

**Two corrections to the red team's report, measured:**

1. **The fidelity guard *does* catch a degraded profile whenever any subject
   imports app modules — which 27 of the 42 do.** With `check-classify.ts` in
   the subject set, the same degraded profile produced `4 fidelity violations`,
   the "THE PROFILE IS WRONG, NOT THE APP" block, and **exit 1**:
   ```
   subjects found 3   subjects compiled 3   type failures 1   fidelity violations 4   missing 0
   check-instrument-typecheck.sh FAILED — 1 type failure(s), 4 fidelity violation(s), …
   ```
   The breach is only reachable on a subject set with no app imports. That
   materially narrows B6's practical severity and the red team did not measure it.
2. **The NF3 `.js`-emission claim does not reproduce.** The red team asserts
   "losing the base config also loses `"noEmit": true`" and lists eight emitted
   `.js` files. `tsconfig.checks-instruments.json` sets `"noEmit": true` in its
   **own** `compilerOptions` (line 78), which survives any `extends`
   redirection. I ran `find . -name '*.js' -newer …` after both degraded runs
   and found **nothing**. That claim is not true of the committed profile.

I record these corrections because the fix cycle should not be sent to fix a
`noEmit` that is already correct.

### F1 — reproduced; the guard is provably dead

Lines 210–213 assert: *"No `ls`. No `2>/dev/null`. A failure to enumerate is a
refusal, not an empty subject list."* It is not.

```
# stdout -> /dev/full, SUBJECT_GLOBS order as committed (last glob matches nothing):
_: line 2: printf: write error: No space left on device
_: line 2: printf: write error: No space left on device
>>> guard does NOT fire: subshell rc=0 despite every write failing

# control — reverse the order so the LAST glob is non-empty:
>>> guard WOULD fire
```

A `for` loop over an empty glob returns 0, so the subshell's status is that of
the last iteration of the last glob — and `scripts/checks/*.tsx` matching
nothing makes the subshell exit 0 regardless of every `printf` having failed.
This is the exact silent-fallback shape NF1/R16 forbid, and it is asserted
absent in a comment. The red team is honest that it could not convert this into
a `PASSED`; the guarantee is nonetheless not provided.

### F7 — reproduced

```
$ echo 'export const n: number = "not a number";' > scripts/checks/zz-broken.cts
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  UNCOVERED scripts/checks/zz-broken.cts — matched by scripts/checks/*.mts scripts/checks/*.cts, not by …
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
EXIT=0
```

The gate's behaviour matches R10 exactly, so this is a **requirement** defect,
not an implementation defect — and I agree with the red team's framing. R10 as
written permits the final line to say `PASSED` at exit 0 while a type-broken
instrument sits in the directory, which is verbatim the sentence 03-quality.md
§6 brief A2 defines as a breach. Naming a file and then certifying the run green
are not compatible.

### Where I accept the builder's position

- **F5 (`SIGKILL` leaks the temp dir)** — inherent; no process can run a
  handler for `SIGKILL`. `SIGINT`, `SIGTERM` and `SIGHUP` all clean up (I
  verified `SIGINT` myself). No fix required.
- **F6 (TOCTOU)** — inherent to any enumerate-then-act gate; closing it would
  require a filesystem lock over `scripts/checks/`. No fix required.
- **F3/F4 (hostile filenames)** — both fail closed. Worth fixing because they
  send a maintainer to edit the profile over a filename, but not blocking.

---

## 8. The reject list (03-quality.md §3, verbatim), item by item

| Reject clause | Finding |
|---|---|
| any `\|\| true` / `2>/dev/null` / `continue` can convert a failure into a pass | **No** — §5, all eight read by me |
| subject glob or profile path inlined rather than a named variable at the top | **No** — `SUBJECT_GLOBS` line 124, `PROFILE` line 125, at the top under a banner. See finding 8 for a related §7 defect that is *not* this clause |
| temp directory not removed on the failure path | **No** — `trap cleanup EXIT` line 196; verified gone after a failing run and after SIGINT |
| a generated config written inside the repo | **No** — `mktemp -d` line 195; `git status --porcelain` empty after every run |
| refusal's install line lacks `--prod=false` / says npm | **No** — line 171 reads `cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false`; `npm` appears only as the thing forbidden |
| profile-fidelity guard missing, or blames the app | **No** — present at 383–407/487–504, and it says "THE PROFILE IS WRONG, NOT THE APP". I saw it fire correctly in my B6 run |
| an uncovered `.mts`/`.cts` would go unnamed | **No** — F7's transcript names it. (Subdirectories and dotfiles *do* go unnamed — findings 2 and 3, a different clause) |
| manifest still read / guard survives / builder edited the manifest or a corpus document | **No** — `grep 'instrument-manifest'` hits comment line 298 only; no `diff-filter`/`ACMR` in code; write-set audit §3 clean |
| `phase2-gate.md` "Handoff to phase 5" missing the write_set statement | **No** — lines 934–941 state it in bold: *"That write_set must GAIN `scripts/checks/check-instrument-typecheck.sh`."* |

**Every structural reject clause passes.** The phase fails on the red team's
breaches, which 03-quality.md §6 makes decisive: *"A2 is the one that matters
most, because a gate that can be made to lie is worse than the absence it
replaces."*

---

## 9. Findings — numbered, for the fix cycle

**1. BLOCKER — `scripts/checks/check-instrument-typecheck.sh:124` (with
`forge-control-web/tsconfig.json` `skipLibCheck: true`). A `.d.ts` is enumerated,
counted compiled, and never typechecked.**
Failure scenario: `scripts/checks/instrument-types.d.ts` declares `interface Foo
{ a: string }` twice with conflicting types (`TS2717`); the gate prints `PASS
scripts/checks/instrument-types.d.ts exit 0, 0 diagnostics` and
`PASSED — n/n subjects compiled clean.`, exit 0. Severity CRITICAL — this is
`found == compiled` while a subject was never checked, the one thing the census
cannot see.
Fix: set `"skipLibCheck": false` in `tsconfig.checks-instruments.json`, **or**
exclude `*.d.ts` from the subject set and add it to `UNCOVERED_GLOBS` so it is
named. Do not do neither.

**2. BLOCKER — `check-instrument-typecheck.sh:132`. A TypeScript file in a
subdirectory of `scripts/checks/` is uncompiled *and* unnamed.**
Failure scenario: `scripts/checks/sse/broken.ts` contains `TS2322`; the
`UNCOVERED EXTENSIONS` block prints `none: no file matches …` and the run exits
0 `PASSED`. Severity CRITICAL. The block whose stated purpose (lines 252–257)
is that "the defect R10 exists against is SILENCE, not the file" is itself
silent here.
Fix: keep the flat glob if that is the design, but widen the coverage scan from
an extension list to a genuine set difference — every TypeScript-family file
under `scripts/checks/` at any depth, dotfiles included, that `SUBJECT_GLOBS`
did not match must be named. `UNCOVERED_GLOBS` is the right shape; its input set
is too narrow.

**3. BLOCKER — `check-instrument-typecheck.sh:218` (and `:264`). Dotfile
subjects are skipped silently.**
Failure scenario: `scripts/checks/.broken.ts`, or a file named exactly `.ts`,
containing `TS2322`; `shopt -s nullglob` is set but `dotglob` is not, so the
glob never matches it, it is neither compiled nor named, and the run exits 0
`PASSED`. Severity HIGH.
Fix: `shopt -s dotglob` in both enumeration subshells, or cover it via the
widened coverage scan of finding 2.

**4. BLOCKER — `@ts-nocheck` defeats the gate entirely, and P-A cannot see it
(`docs/plan/scripts-checks-typecheck-gate/03-quality.md:` §3 P-A grep;
`01-requirements.md` R28).**
Failure scenario: a phase-3 builder prefixes `check-orientation.ts` with `//
@ts-nocheck`; the gate prints `PASS`, the run exits 0 `PASSED`, and P-A's grep
— which matches `@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as`
— does not fire. Severity CRITICAL, and highest-probability: phase 3 is running
concurrently in this worktree with a brief to turn six red files green.
Fix: add `@ts-nocheck` to R28 and to P-A's alternation, **and** have the gate
itself refuse any subject containing it — the gate is the only thing that reads
every file on every run, so it is the only defence that is not diff-scoped.
Fold F2 in with it: P-A's `git diff main...HEAD` scoping cannot see a
suppression that is already on `main`, which is R9's own argument applied to
suppressions.

**5. BLOCKER — `check-instrument-typecheck.sh:331-332`. The gate collects
`tsc --version` and `node --version` into provenance and never checks them.**
Failure scenario: any broken `node` resolution (a fake `node` earlier on PATH, a
half-installed `nvm`/`volta`/`asdf` shim) makes the pnpm `tsc` shim's final
`exec node …` a no-op that exits 0; every subject reports `exit 0, 0
diagnostics`; the provenance prints `tsc :` and `node :` **both empty**; the run
exits 0 `PASSED` with a type-broken file on disk. Severity MEDIUM (precondition
is PATH control) but the fix is nearly free.
Fix: assert both version strings are non-empty and well-formed before trusting a
single `PASS`, and refuse otherwise. Resolving `node` absolutely as well would
close the adversarial case.

**6. BLOCKER — `check-instrument-typecheck.sh:155-160`. The gate verifies the
profile's *existence*, never its *identity*.**
Failure scenario: `tsconfig.checks-instruments.json`'s `extends` is redirected to
`{}` (or `forge-control-web/tsconfig.json` has `strict` relaxed for an unrelated
reason); `const s: string = null;` in a subject then compiles clean and the run
exits 0 `PASSED`. Severity MEDIUM, narrowed by my measurement: the fidelity
guard catches this whenever a subject imports app modules, so the breach needs a
subject set with no app imports. The upward coupling — the profile inherits the
app's `strict`, so anyone relaxing it there silently relaxes this gate — has no
guard at all.
Fix: assert the profile's effective identity, not just its presence. Verifying
that `extends` resolves to `forge-control-web/tsconfig.json` **and** that the
effective `strict` and `skipLibCheck` are what the profile intends is more
durable than pinning a sha256, and finding 1 wants `skipLibCheck` asserted
anyway.
*Do not* action the red team's two sub-claims here: the fidelity guard is not
absent, and `"noEmit": true` at `tsconfig.checks-instruments.json:78` survives
the redirection — I measured zero `.js` emitted.

**7. REQUIRED — `check-instrument-typecheck.sh:215-228`. The enumeration-failure
guard is structurally dead, and lines 210-213 assert a guarantee the code does
not provide.**
Failure scenario: any write failure inside the enumeration subshell (a full
`TMPDIR` being the realistic one) truncates `subjects.nul`; because the last
entry of `SUBJECT_GLOBS` (`scripts/checks/*.tsx`) may match nothing, the `for`
loop returns 0 and the subshell exits 0, so `if ! …` never fires. The gate then
proceeds on a silently short subject list with a self-consistent census. Proven
deterministically against `/dev/full`, with the glob-order control confirming
the mechanism. Severity HIGH — this is the exact silent-fallback shape NF1/R16
forbid.
Fix: make the subshell's failure detectable — an explicit failure flag set on a
failed `printf`, or verify after the fact by comparing the NUL count against an
independent count. Then either the comment at 210–213 becomes true, or it must
be rewritten to describe what the code actually does.

**8. REQUIRED — `check-instrument-typecheck.sh:391`. The "successor edits two
lines" contract is not true; there is a third inlined literal.**
`02-architecture.md` §7 and the script's own header (lines 50–58) both promise
that a successor extends coverage by editing `SUBJECT_GLOBS` and `PROFILE` "and
nothing else". But `scan_fidelity`'s prefix test at line 391 inlines
`scripts/checks/*`. A successor that adds `scripts/*.ts` to `SUBJECT_GLOBS`
would get every diagnostic in `scripts/` counted as a fidelity violation and be
told "THE PROFILE IS WRONG, NOT THE APP" about a correct profile. Severity
MEDIUM.
Fix: derive the fidelity prefix from `SUBJECT_GLOBS` (the directory portion of
each glob), or promote it to a third named variable at the top and amend §7 and
the header to say three.

**9. REQUIRED (requirement defect, not code) —
`docs/plan/scripts-checks-typecheck-gate/01-requirements.md` R10. "Cover it or
name it" permits a green verdict over a broken instrument.**
Failure scenario: `scripts/checks/zz-broken.cts` contains `TS2322`; the gate
correctly names it `UNCOVERED` and correctly prints `PASSED — 2/2 subjects
compiled clean.`, exit 0. Reproduced. Severity MEDIUM.
Fix: amend R10 so an uncovered TypeScript-family file **fails** the run. Naming
is the right message; exit 0 is the wrong verdict. Note this interacts with
findings 2 and 3 — once the coverage scan is widened, "named" will include
subdirectory and dotfile subjects, and all of them should be non-zero.

**10. NON-BLOCKING — `check-instrument-typecheck.sh:386-405` (F3/F4). Hostile
filenames produce a wrong diagnosis.**
A subject whose name contains a newline splits its diagnostic across lines and
the parser reads the tail as a path outside `scripts/checks/`, printing the
"THE PROFILE IS WRONG" essay about a filename; a backslash yields a spurious
"no parseable path — a config-level error". Both fail closed (exit 1), so
neither is a breach. Severity LOW. Fix when convenient: both send a maintainer
to edit the wrong file.

**11. INFORMATIONAL — gate 17 of `gates-808.sh` is RED at this tip.**
`verify-notification-gap-pins.mjs` exits 1 with `8 FAILURE(S)`. Neither its
input (`docs/plan/notification-gap.md`) nor the checker itself appears in
`git diff --name-only main...HEAD`, so it is red on `main` identically and is
not this branch's regression. Recorded so it is not discovered later and
attributed here; it belongs to whoever owns `notification-gap.md`.

---

## 10. What is genuinely good, stated so the fix cycle does not undo it

This is a strong instrument and the findings above are about its *blind spots*,
not its *mechanics*. Preserve, specifically: the one-file-per-invocation design
and `--pretty false`; the index-named generated config plus `json_escape`, which
defeated eleven hostile-filename shapes with no command injection; the `[ ! -f ]`
→ `MISSING` → census-mismatch path, which converts every un-compilable symlink
shape into a named failure rather than a skip; the two-direction census; the
refusal-with-the-working-install-line (`--prod=false`, `pnpm`) which is the
correct answer to this environment's `NODE_ENV=production` trap; the three traps
that make `SIGINT` exit 130 with no verdict line; and the profile-fidelity guard,
which I watched correctly diagnose a degraded profile in my own B6 run.

The determinism, concurrency, cleanliness and cwd-independence properties are
all real and all measured — twice, once by the builder and once by me.

---

## 11. Verdict

**FAIL.** A2.1–A2.9 all pass and every structural reject clause passes, but
brief A2 succeeded six ways and I reproduced all six myself. Findings 1–6 are
blockers (each is a `PASSED` + exit 0 with a broken file on disk), findings 7–9
are required, 10 is optional, 11 is informational and belongs elsewhere.

Findings 1, 2, 3 and 4 are the ones to fix first: the first three are one
coherent change (make the coverage scan a real set difference over
`scripts/checks/`, by depth, by dotfile and by declaration file), and finding 4
is urgent because phase 3 is running concurrently in this worktree and
`@ts-nocheck` is the cheapest way to satisfy its brief.
