# Phase 2 — the gate rewrite: evidence

**Project:** `scripts-checks-typecheck-gate` · **Round label 200** · **Deliverable D2.2**
**Subject:** `scripts/checks/check-instrument-typecheck.sh`, rewritten per
`02-architecture.md` §4.1 steps 0–14.

Every transcript below was produced by running the command shown, on this
machine, on the tree named in its provenance block. Nothing here is a
description of a run that was not made. Where a transcript is presented as a
`diff` against the §I1 baseline rather than in full, the diff is the *complete*
difference — the elided lines are byte-identical to I1's and the diff is what
proves it.

---

## 0. Tree state, and the honest handling of phase 3

Phase 3 fixes the same six instruments and runs **in parallel with this phase,
in this same worktree**. It had **not** landed when these runs were taken, so
the census below is the full six red. The tree state:

```
$ git log --oneline -5
d2b4563 feat(scripts-checks-typecheck-gate/round-200, phase 2): the gate enumerates by glob and compiles through the profile
fbf4a0e review(scripts-checks-typecheck-gate/round-1, phase 1 gate): PASS — census reproduced byte-for-byte, typeRoots and TS5025 re-measured independently
268ecde feat(scripts-checks-typecheck-gate/round-100, phase 1): the compile profile, reproducing round 0's census byte-for-byte
b74ecb2 plan(scripts-checks-typecheck-gate/round-0): the waterfall corpus, built on a measured census of all 42 instruments
9b960ef fix(engine-task-graph/round-902, fix cycle 1): the screenshot convention states what the renderer actually does

$ ls scripts/checks/*.ts scripts/checks/*.tsx | wc -l
42
```

The gate's own red set, and the set phase 1's `reproduce-census.sh` reports, are
the same six files — that is the invariant that must hold whatever phase 3 has
or has not landed:

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh > /tmp/census-fresh.txt
$ diff /tmp/census-fresh.txt docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
(no output — census-G reproduced byte-for-byte)

$ grep -v "rc=0" /tmp/census-fresh.txt          # the census says red:
check-orientation.ts                           rc=2   errors=3   
check-team-confirm.ts                          rc=2   errors=1   
check-team-rows.ts                             rc=2   errors=1   
serve-sse-808.ts                               rc=2   errors=2   
check-dismiss-peek.tsx                         rc=2   errors=2   
check-stop-affordance.tsx                      rc=2   errors=2   

$ grep "^  FAIL" <the gate transcript>          # the gate says red:
  FAIL scripts/checks/check-orientation.ts              exit 2
  FAIL scripts/checks/check-team-confirm.ts             exit 2
  FAIL scripts/checks/check-team-rows.ts                exit 2
  FAIL scripts/checks/serve-sse-808.ts                  exit 2
  FAIL scripts/checks/check-dismiss-peek.tsx            exit 2
  FAIL scripts/checks/check-stop-affordance.tsx         exit 2

$ wc -l < /tmp/census-fresh.txt                 # the census enumerated:
42
```

42 found = 42 compiled = `ls … | wc -l` = 42 census rows, and the six red files
are red for the eleven diagnostics of `evidence/residual-errors-profile-G.txt`.
**A phase-2 gate that exits 0 would be compiling fewer than 42 files.** This one
exits 1.

---

## 1. What was re-measured rather than taken on trust

The brief asserted two compiler behaviours and instructed that they be
re-measured. Both were, at round 200, tsc 5.7.2, on the same generated per-file
config and the same subject (`check-orientation.ts`).

### (a) `tsc` prints diagnostic paths relative to ITS OWN cwd — confirmed

```
$ (cd "$REPO_ROOT" && .../tsc -p "$T/0000.json" --pretty false)
scripts/checks/check-orientation.ts(129,38): error TS2322: Type '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.

$ (cd /tmp && .../tsc -p "$T/0000.json" --pretty false)
../opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-orientation.ts(129,38): error TS2322: Type '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
```

The profile-fidelity guard is defined by the `scripts/checks/` path **prefix**,
so an inherited cwd would make every diagnostic on this tree look like a
violation for the first reviewer who ran the gate from somewhere else — and I6
(A2.6) demands an identical verdict from any cwd. The gate therefore pins tsc's
cwd to `REPO_ROOT` inside the compile subshell. §I6 below is the proof it
worked.

### (b) Under a TTY, `tsc` pretty-prints — confirmed, and it is worse than colour

Run through a pty with `script -qec`, no `--pretty false`, piped through
`cat -v`:

```
^[[96mscripts/checks/check-orientation.ts^[[0m:^[[93m129^[[0m:^[[93m38^[[0m - ^[[91merror^[[0m^[[90m TS2322: ^[[0mType '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.^M
^M
^[[7m129^[[0m   manager: node({ id: "manager-run", kind: "operator_chat" }),^M
^[[7m   ^[[0m ^[[91m                                     ~~~~^[[0m^M
^M
  ^[[96mforge-control-web/app/desktop/team/teamApi.ts^[[0m:^[[93m68^[[0m:^[[93m3^[[0m^M
    ^[[7m68^[[0m   kind: TeamNodeKind;^M
    ^[[7m  ^[[0m ^[[96m  ~~~~^[[0m^M
    The expected type comes from property 'kind' which is declared here on type 'Partial<TeamNode> & Pick<TeamNode, "kind" | "id">'^M
```

Three things change under a TTY, and the third is the dangerous one:

1. ANSI colour, and `\r\n` line endings.
2. The path is split as `file:line:col` — **the `path(line,col): error TS` shape
   the fidelity parser matches does not exist**.
3. A **related-information block citing an app file**,
   `forge-control-web/app/desktop/team/teamApi.ts:68:3`. Under pretty output a
   naive fidelity parser would either miss every diagnostic (shape 2) or blame
   the app for a diagnostic the app did not cause (shape 3).

The same invocation with `--pretty false`, still under the pty:

```
scripts/checks/check-orientation.ts(129,38): error TS2322: Type '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.^M
```

`--pretty false` composes with `-p` — measured; it is only source *files* that
may not be mixed with `-p`. Reviewers run this gate in a terminal, so without
that flag two runs would stop being identical (NF2) and the fidelity parser
would see a shape it never saw when the transcript was piped.

**Third measurement, taken because the parser depends on it.** Across the full
non-pretty output of all six red subjects, every line containing `error TS`
matched the located shape `^.+\([0-9]+,[0-9]+\): error TS[0-9]+`; zero did not.
The elaboration lines (`  Property 'hidesRows' is missing …`) carry no
`error TS` at all, which is why the "unlocated diagnostic" branch cannot fire on
them.

```
$ grep "error TS" all-six-outputs.txt | grep -vE "^.+\([0-9]+,[0-9]+\): error TS[0-9]+"
(none)
```

---

## I1 — the full gate run on this tree, complete output

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/*.ts scripts/checks/*.tsx, enumerated at run time

UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : d2b456399209154e66f2c5a159fabc1d9dd851e0
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: dbf1f946d747500355c3a593ac55d4178fcce03b0978cb18b45c3b1d75b416f4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.TltqIbujen

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  FAIL scripts/checks/check-orientation.ts              exit 2
         scripts/checks/check-orientation.ts(129,38): error TS2322: Type '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
         scripts/checks/check-orientation.ts(133,7): error TS2322: Type '"project_worker"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
         scripts/checks/check-orientation.ts(138,23): error TS2322: Type '"project_worker"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
  PASS scripts/checks/check-plan-api.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-plan-store.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-project-metadata.ts         exit 0, 0 diagnostics
  PASS scripts/checks/check-quota-row.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-r1871-chat.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-r1873-fixes.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-r1875-fixes.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-run-control-client.ts       exit 0, 0 diagnostics
  PASS scripts/checks/check-screenshot-render-shapes.ts exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-events.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-requests.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-secret-scan.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-story-digest.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-subagent-slice.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-task-api.ts                 exit 0, 0 diagnostics
  FAIL scripts/checks/check-team-confirm.ts             exit 2
         scripts/checks/check-team-confirm.ts(207,30): error TS2345: Argument of type '{ nodeId: string; settled: false; armed: ArmedState | null; nowMs: number; canTerminate: boolean; }' is not assignable to parameter of type 'XClickInput'.
           Property 'hidesRows' is missing in type '{ nodeId: string; settled: false; armed: ArmedState | null; nowMs: number; canTerminate: boolean; }' but required in type 'XClickInput'.
  FAIL scripts/checks/check-team-rows.ts                exit 2
         scripts/checks/check-team-rows.ts(84,3): error TS2322: Type '{ node: TeamNode; depth: number; parentDescription: string | null; hidesRows?: number | undefined; displayWorkingMs: number | null; }' is not assignable to type 'TeamRow'.
           Types of property 'hidesRows' are incompatible.
             Type 'number | undefined' is not assignable to type 'number'.
               Type 'undefined' is not assignable to type 'number'.
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  FAIL scripts/checks/serve-sse-808.ts                  exit 2
         scripts/checks/serve-sse-808.ts(51,22): error TS7016: Could not find a declaration file for module '../../forge-control/node_modules/hono/dist/index.js'. '/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control/node_modules/hono/dist/index.js' implicitly has an 'any' type.
         scripts/checks/serve-sse-808.ts(90,21): error TS7006: Parameter 'c' implicitly has an 'any' type.
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  FAIL scripts/checks/check-dismiss-peek.tsx            exit 2
         scripts/checks/check-dismiss-peek.tsx(102,5): error TS2322: Type '"run"' is not assignable to type 'WorkingMsSource | null'.
         scripts/checks/check-dismiss-peek.tsx(115,3): error TS2741: Property 'hidesRows' is missing in type '{ node: TeamNode; depth: number; parentDescription: string; displayWorkingMs: number | null; }' but required in type 'TeamRow'.
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  FAIL scripts/checks/check-stop-affordance.tsx         exit 2
         scripts/checks/check-stop-affordance.tsx(98,5): error TS2322: Type '"run"' is not assignable to type 'WorkingMsSource | null'.
         scripts/checks/check-stop-affordance.tsx(111,3): error TS2741: Property 'hidesRows' is missing in type '{ node: TeamNode; depth: number; parentDescription: string; displayWorkingMs: number | null; }' but required in type 'TeamRow'.

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
  wall clock       : 53s

check-instrument-typecheck.sh FAILED — 6 type failure(s), 0 fidelity violation(s), 0 missing subject(s), census mismatch 0.
exit=1
```

All ten provenance fields of R20 are present, above the first PASS/FAIL line
(A2.3): worktree path, git HEAD, git branch, the gate's own path and sha256, the
profile's path and sha256, `tsc --version` (with the binary's path),
`node --version`, subject count, the invocation shape — plus the temp dir, on
its own line.

---

## I2 — the same run, immediately repeated (NF2)

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/a 2>&1 ; echo "exit=$?"
exit=1
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/b 2>&1 ; echo "exit=$?"
exit=1
$ diff /tmp/a /tmp/b
19c19
<   temp dir         : /tmp/tmp.TltqIbujen
---
>   temp dir         : /tmp/tmp.a1SR72gdK6
85c85
<   wall clock       : 53s
---
>   wall clock       : 54s
```

Two lines differ, and they are the two lines designed to: the temp directory
(line 19) and the wall clock (line 85). Both are printed on their own line for
exactly this reason. Every one of the 42 per-subject results, all eleven
diagnostics, the fidelity block, the census and the verdict are byte-identical.

---

## I3 — `git status --porcelain` after a normal run, a failed run, and a SIGINT (NF3, A2.4)

On this tree every run is a *failed* run (six red), so "normal" and "failed" are
the same transcript; the third case is a genuine interrupt.

```
$ bash scripts/checks/check-instrument-typecheck.sh   # exit=1, the run in I1
$ git status --porcelain
(empty)

$ bash scripts/checks/check-instrument-typecheck.sh   # exit=1, the run in I2
$ git status --porcelain
(empty)
```

### The SIGINT path, measured rather than assumed

The brief instructed that the SIGINT path be measured rather than trusted to
bash running an EXIT trap. It was, and the measurement is why the script carries
**three** traps rather than the one `02-architecture.md` §4.1 step 4 names:
bash resumes execution after a trapped signal handler returns, so an `INT`
handler that only removed the directory would let the loop run on with its
generated configs deleted. `INT` and `TERM` therefore exit (130 / 143), and the
`EXIT` trap then runs `cleanup` a second time, harmlessly — `cleanup` is
idempotent and `return 0`s so it can never rewrite the script's own exit status.

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/sigint.txt 2>&1 &
$ TD=$(sed -n "s/^  temp dir *: //p" /tmp/sigint.txt)      # captured in flight
temp dir in flight: /tmp/tmp.VRAfm9CNEs
temp dir EXISTS while running: yes
$ ls "$TD"
0001.json
subjects.nul
uncovered.nul

$ sleep 6 ; kill -INT $GPID ; wait $GPID
exit after SIGINT=130

$ [ -d "$TD" ] && echo "STILL PRESENT <-- LEAK" || echo "removed: $TD"
removed: /tmp/tmp.VRAfm9CNEs

$ git status --porcelain
(empty)

$ tail -4 /tmp/sigint.txt        # no verdict line was printed
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
```

Exit 130, the temp directory gone, the tree clean, and — the part that matters
for failure mode (a) — **no verdict line**. An interrupted run cannot be
mistaken for a pass, because the only pass signal is the final `PASSED` line
together with exit 0, and neither was printed.

### No leaked temp directory, counted

```
$ ls -d /tmp/tmp.* | wc -l      # before the I1/I2 pair
10
$ ls -d /tmp/tmp.* | wc -l      # after
10
```

Unchanged across two full runs. (The ten are other processes' and pre-date these
runs.)

---

## I4 — two runs concurrently (NF4)

```
$ bash …/check-instrument-typecheck.sh > /tmp/a 2>&1 & A=$!
$ bash …/check-instrument-typecheck.sh > /tmp/b 2>&1 & B=$!
$ wait $A ; echo "run A exit=$?" ; wait $B ; echo "run B exit=$?"
run A exit=1
run B exit=1

$ sed -n "s/^  temp dir *: /  /p" /tmp/a /tmp/b
  A: /tmp/tmp.M2ajYgHkMy
  B: /tmp/tmp.0GMTZnHzpd

$ grep "subjects found 42" /tmp/a /tmp/b
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0

$ diff /tmp/a /tmp/b
19c19
<   temp dir         : /tmp/tmp.M2ajYgHkMy
---
>   temp dir         : /tmp/tmp.0GMTZnHzpd
85c85
<   wall clock       : 58s
---
>   wall clock       : 57s

$ git status --porcelain
(empty)
```

Two distinct `mktemp -d` directories, two correct and identical censuses, a
clean tree. The generated configs are per-run by construction, which is the
property NF4 asks for; nothing is shared between the two runs but the read-only
profile and the read-only subjects.

---

## I5 — wall clock, recorded and not gated (NF6, S10)

```
$ time bash scripts/checks/check-instrument-typecheck.sh

real	0m54.166s
user	2m12.492s
sys	0m7.916s

# the gate reports it itself, on its own line:
  wall clock       : 54s
```

≈54 s of wall clock for 42 `tsc` invocations, ≈1.3 s each; 2 m 12 s of user time
across cores. **Recorded, not gated.** Coverage is never traded for speed: the
alternative — one program over all 42 entry points — is what round 800 measured
and rejected (R11), and it would be faster and wrong.

---

## I6 — invoked by absolute path from another cwd (A2.6)

```
$ cd /tmp && bash /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0
  wall clock       : 54s

check-instrument-typecheck.sh FAILED — 6 type failure(s), 0 fidelity violation(s), 0 missing subject(s), census mismatch 0.
exit=1

$ grep -c "^         scripts/checks/" /tmp/i6.txt    # diagnostics still repo-relative
11

$ diff /tmp/i1.txt /tmp/i6.txt
19c19
<   temp dir         : /tmp/tmp.TltqIbujen
---
>   temp dir         : /tmp/tmp.DOdATDvFAo
85c85
<   wall clock       : 53s
---
>   wall clock       : 54s
```

Identical verdict, identical census, and all eleven diagnostic paths still
begin `scripts/checks/` — because the compile subshell `cd`s to `REPO_ROOT`
rather than inheriting `/tmp`. Without that pin, §1(a)'s measurement says every
one of those eleven would have read
`../opt/ai-os/workspace/…/scripts/checks/…` and tripped the fidelity guard,
turning a correct 6-failure verdict into a 6-failure-plus-11-fidelity-violation
one from a different chair.

---

## The verdict's other half — PASSED and exit 0 are reachable

R22 requires that the word and the exit code agree in **both** directions, and
this tree cannot show the green one: six instruments are red until phase 3
lands. Proven in a scratch copy instead, built as §U-scratch describes, with
phase 3's six subjects removed:

```
$ S=$(mkscratch) ; rm -f "$S"/scripts/checks/{check-orientation.ts,check-team-confirm.ts,check-team-rows.ts,serve-sse-808.ts,check-dismiss-peek.tsx,check-stop-affordance.tsx}
$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
  subjects found   : 36
  subjects found 36   subjects compiled 36   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 36/36 subjects compiled clean.
exit=0
```

36 found, 36 compiled, zero of every counter, `PASSED`, exit 0. This is also the
check that the `EXIT` trap's `cleanup` does not leak a non-zero status into a
passing run.

---

## U-scratch — how every scratch copy in this document was built

No experiment below mutated `scripts/checks/` in place. Each was run against a
throwaway copy of the tree, built exactly this way:

```bash
#!/usr/bin/env bash
# mkscratch.sh <repo-root> [--no-web-modules]
# Builds a scratch copy of the worktree under mktemp -d:
#   1. `git archive HEAD | tar -x`  — the tracked tree at HEAD, nothing else.
#      node_modules is gitignored, so the copy starts with NO compiler.
#   2. symlink forge-control-web/node_modules and forge-control/node_modules
#      back at the real ones (unless --no-web-modules, which omits the web one).
# The real worktree is never touched.
set -euo pipefail
REPO="$1"; MODE="${2:-}"
S="$(mktemp -d)"
git -C "$REPO" archive HEAD | tar -x -C "$S"
ln -s "$REPO/forge-control/node_modules" "$S/forge-control/node_modules"
if [ "$MODE" != "--no-web-modules" ]; then
  ln -s "$REPO/forge-control-web/node_modules" "$S/forge-control-web/node_modules"
fi
printf '%s\n' "$S"
```

`git archive HEAD | tar -x` gives the **tracked** tree and nothing else, so the
copy starts with no `node_modules` (it is gitignored) and, deliberately, **no
`.git`** — which is why every scratch transcript's provenance reads
`git HEAD: no-git`. That fallback is a display field; §Audit entry 3 below
covers why it cannot affect a verdict.

The `forge-control/node_modules` symlink is present in every scratch copy
including U8's, because `serve-sse-808.ts` imports a deep path into it and the
gate's compiler refusal is about `forge-control-web` only. The helper's own
fidelity was checked before it was used for anything: a scratch copy with both
symlinks in place reproduces this tree's census exactly, differing only in the
git fields and the clock —

```
$ diff <(normalise I1) <(normalise scratch-baseline)
9,10c9,10
<   git HEAD         : d2b456399209154e66f2c5a159fabc1d9dd851e0
<   git branch       : project/b7ab4c57
---
>   git HEAD         : no-git
>   git branch       : no-git
85c85
<   wall clock       : 53s
---
>   wall clock       : 54s
```

(`normalise` replaces the tree root — this worktree's path or the scratch
`mktemp -d` — with `<ROOT>`, which also collapses the temp-dir line. It is a
diffing aid, not something the gate does.)

---

## U7 — the glob matches nothing → refusal, non-zero (R13)

Built as a scratch copy, then `rm -f "$S"/scripts/checks/*.ts
"$S"/scripts/checks/*.tsx`. **Never by emptying `scripts/checks/` in place.**
What remained in the scratch directory:

```
$ ls "$S/scripts/checks/"
api-diff.sh
check-await-seed.sh
check-instrument-typecheck.sh
check-migration-0040.sh
check-r20-census.py
check-r69-straddle.sh
check-scheduler-sql.sh
check-workstream-e2e.sh
contrast-canvas-banners.cjs
contrast-nav-rail.cjs
contrast-role-tints.cjs
dollar-allowlist.txt
dollar-sweep.sh
frozen-dom.cjs
gates-808.sh
instrument-manifest.txt
no-raw-colours.cjs
raw-colour-allowlist.txt
verify-control-plane.sh

$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
REFUSING TO RUN: zero subjects matched scripts/checks/*.ts scripts/checks/*.tsx under /tmp/tmp.MxSJsUJ6Fo.
  A gate over nothing certifies nothing. This is not a clean run; it is a
  run that never looked at anything.
exit=1
```

A gate over nothing certifies nothing. Note what did **not** happen: the
compiler and the profile were both present, so the run had every opportunity to
print a clean 0/0 census and exit 0. It refused instead.

---

## U8 — `forge-control-web/node_modules` absent → refusal printing the install line (R17)

Scratch copy built with `--no-web-modules`: the web package's `node_modules`
symlink is simply not created, so the copy is a fresh worktree with no compiler.

```
$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
REFUSING TO RUN: no executable tsc at /tmp/tmp.4gTMl6BW6e/forge-control-web/node_modules/.bin/tsc

This worktree ships WITHOUT forge-control-web/node_modules — it is gitignored —
so a fresh worktree has no compiler and this gate would otherwise answer
"tsc: not found", which is how a gate gets disclosed and ignored. Fix it with
exactly this line, then re-run:

  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false

--prod=false IS LOAD-BEARING and so is pnpm. This environment exports
NODE_ENV=production; under it a plain `pnpm install --frozen-lockfile` prints
one quiet "skipping devDependencies" line, EXITS 0, and REMOVES tsc and tsx —
they are devDependencies. The install looks clean and the compiler is gone.
Never npm: `npm` here has resolved differently from the lockfile and bricked
the executor. Keep --frozen-lockfile: it is what holds NF8's
`git diff main -- forge-control-web/package.json` empty.
exit=1
```

Not `tsc: not found`. A refusal, non-zero, naming the exact path it looked in
and printing the line that fixes it — with `--prod=false`, with `pnpm`, and with
the reason both are load-bearing.

---

## U9 — that install line, run VERBATIM under `NODE_ENV=production` (R18, C3)

`NODE_ENV` as exported into this run: `production`. Same scratch tree as U8,
continued.

### U9a — first, the trap the line exists to avoid

The *plain* line — the one a reasonable person would write — run verbatim:

```
$ export NODE_ENV=production
$ cd "$S/forge-control-web" && pnpm install --frozen-lockfile --prefer-offline
+ remark-gfm 4.0.1
+ three 0.185.1

devDependencies: skipped because NODE_ENV is set to production

Done in 1.3s using pnpm v9.15.9
install exit=0

$ ls -l "$S/forge-control-web/node_modules/.bin/tsc"
ls: cannot access '…/forge-control-web/node_modules/.bin/tsc': No such file or directory

$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
REFUSING TO RUN: no executable tsc at /tmp/tmp.4gTMl6BW6e/forge-control-web/node_modules/.bin/tsc
exit=1
```

**One quiet line, `devDependencies: skipped because NODE_ENV is set to
production`, and exit 0 — with no compiler installed.** This is the trap C3
names, reproduced here rather than quoted. A refusal that printed this line
would teach it.

### U9b — the line the gate actually prints

```
$ export NODE_ENV=production
$ cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
+ @types/react 19.0.2
+ @types/react-dom 19.0.2
+ typescript 5.7.2

Done in 904ms using pnpm v9.15.9
install exit=0

$ "$S/forge-control-web/node_modules/.bin/tsc" --version
Version 5.7.2

$ NODE_ENV=production bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
# the full transcript, as a diff against I1 — every other line is byte-identical:
9,10c9,10
<   git HEAD         : d2b456399209154e66f2c5a159fabc1d9dd851e0
<   git branch       : project/b7ab4c57
---
>   git HEAD         : no-git
>   git branch       : no-git
85c85
<   wall clock       : 53s
---
>   wall clock       : 54s
87a88
> exit=1
```

**Say it plainly: the census in that scratch tree is still red for phase 3's
six, and that is correct.** U9 proves the printed line puts the compiler back —
that the gate proceeds *past the refusal* and produces a real 42/42 census. It
does not prove, and is not capable of proving, that the gate passes. On this
tree it must not.

---

## U12 — `scripts/checks/throwaway.mts` present → named as uncovered (R10)

Scratch copy, with a type-broken `throwaway.mts` and a `throwaway.cts` added.
The full transcript as a diff against I1:

```
$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"   # exit=1
$ diff <(normalise I1) <(normalise U12)
5c5,9
<   none: no file matches scripts/checks/*.mts scripts/checks/*.cts
---
>   UNCOVERED scripts/checks/throwaway.mts — matched by scripts/checks/*.mts scripts/checks/*.cts, not by scripts/checks/*.ts scripts/checks/*.tsx
>   UNCOVERED scripts/checks/throwaway.cts — matched by scripts/checks/*.mts scripts/checks/*.cts, not by scripts/checks/*.ts scripts/checks/*.tsx
>   These are NOT compiled and NOT counted below. Naming them is R10; if one
>   is a real instrument, add its extension to SUBJECT_GLOBS at the top of
>   this script — that is the only edit required.
9,10c13,14
<   git HEAD         : d2b456399209154e66f2c5a159fabc1d9dd851e0
<   git branch       : project/b7ab4c57
---
>   git HEAD         : no-git
>   git branch       : no-git
85c89
<   wall clock       : 53s
---
>   wall clock       : 54s
87a92
> exit=1
```

Both files are named, by name, at **lines 5–6 of the transcript** — above the
provenance block and far above the verdict, so a `PASSED` could never be printed
with an uncovered file off-screen. The subject count is unchanged at 42: they
are not compiled and not counted, and the transcript says so.

**Why presence alone does not fail the run,** stated in the script's own header
and repeated here because it is a judgement a reviewer may want to overturn: R10
requires that a new TypeScript extension be *covered or named, never omitted
silently*, and the defect it exists against is silence, not the file. A `.mts`
instrument is a legitimate thing for someone to write. Failing on its mere
presence would make the gate unsatisfiable for whoever wrote it, which is the
habit standing rule 2 exists to break; naming it puts the fact in front of every
reviewer of every phase until someone acts on it. The remedy is one line —
`SUBJECT_GLOBS` at the top of the script — and the transcript says that too.

---

## U13 — a subject deleted between enumeration and compile (R12, R19)

A **real race**, not a code-reading argument: a background job removes the last
subject in glob order 45 seconds into a run that takes ~54, long after
enumeration (which completes in well under a second) and shortly before that
subject's turn to compile.

```
$ S=$(mkscratch)
$ ( sleep 45 ; rm -f "$S/scripts/checks/check-stop-affordance.tsx" ) &
$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"

[racer] removed check-stop-affordance.tsx at t=45s

  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  MISSING scripts/checks/check-stop-affordance.tsx      enumerated but ABSENT at compile time — NOT compiled

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 41   type failures 5   fidelity violations 0   missing 1
  MISMATCH: compiled 41 of 42 subjects found — a subject was SKIPPED and this run certifies nothing.
  wall clock       : 58s

check-instrument-typecheck.sh FAILED — 5 type failure(s), 0 fidelity violation(s), 1 missing subject(s), census mismatch 1.
exit=1
```

Three independent signals fire, and all three are printed:

1. `MISSING scripts/checks/check-stop-affordance.tsx` — **named**, in the
   per-subject transcript, where the reader is already looking.
2. `missing 1` in the census counters, and `missing subject(s) 1` in the
   verdict.
3. `MISMATCH: compiled 41 of 42 subjects found — a subject was SKIPPED and this
   run certifies nothing.` — the census direction that says the run is void, not
   merely red.

Note the type-failure count fell to 5, because the sixth red file is the one
that vanished. That is exactly why the census exists: **5 failures out of 41 is
a number that would look better than 6 out of 42 to anyone reading only the
failure count.** The gate refuses to let that read as progress.

---

## Red team, unbriefed — hostile filenames (03-quality.md §6, brief A2)

The A2 reviewer is briefed to "use filenames with spaces or leading dashes,
create symlinks, break the profile". Six of those were tried here first, in a
scratch copy, each file containing a real type error. **The success condition
for the attack is `PASSED` with exit 0 while something is broken.**

```
$ ls -b "$S/scripts/checks/"      # the six added
back\\slash.ts
-dash-leading.ts
dollar$var.ts
quote".ts
semi;colon.tsx
with\ space.ts

$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
  subjects found 48   subjects compiled 48   type failures 12   fidelity violations 1   missing 0
check-instrument-typecheck.sh FAILED — 12 type failure(s), 1 fidelity violation(s), 0 missing subject(s), census mismatch 0.
exit=1

# every one of the six, from the transcript:
  FAIL scripts/checks/-dash-leading.ts                  exit 2
         scripts/checks/-dash-leading.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/back\slash.ts                     exit 2
         error TS6053: File '/tmp/tmp.McCLRQsqkc/scripts/checks/back/slash.ts' not found.
  FAIL scripts/checks/dollar$var.ts                     exit 2
         scripts/checks/dollar$var.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/quote".ts                         exit 2
         scripts/checks/quote".ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/with space.ts                     exit 2
         scripts/checks/with space.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/semi;colon.tsx                    exit 2
         scripts/checks/semi;colon.tsx(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
  while compiling scripts/checks/back\slash.ts: diagnostic with NO parseable path — a config-level error
    error TS6053: File '/tmp/tmp.McCLRQsqkc/scripts/checks/back/slash.ts' not found.
```

48 found, 48 compiled, 12 type failures (the six known reds plus these six).
**Not one was skipped.** The mechanisms that make this hold are the two the
brief named: the generated config is named by **index**
(`printf '%s/%04d.json'`), never by a basename, so a leading dash or a space
never reaches a command line; and the subject path reaches `tsc` only inside
JSON, through an escaper that handles `\`, `"`, tab, CR and LF.

**`back\slash.ts` is the interesting one, and it is not an escaping bug.** The
generated JSON is valid — `jq` reads it and returns the real filename:

```
$ cat "$TMP/probe.json"
{ "extends": "<ROOT>/tsconfig.checks-instruments.json",
  "files":   ["<ROOT>/scripts/checks/back\\slash.ts"] }
$ jq -r ".files[0]" "$TMP/probe.json"
<ROOT>/scripts/checks/back\slash.ts
```

`tsc` then normalises `\` to a path separator itself — a Windows-ism — and looks
for `back/slash.ts`, which does not exist. Its answer is
`error TS6053: File '…/back/slash.ts' not found.`, an **unlocated** diagnostic,
and the gate counts it twice over: once as a type failure, once as a fidelity
violation reading *"diagnostic with NO parseable path — a config-level error"*.
That is the required direction. A filename `tsc` itself cannot address produces
a loud failure naming the file, never a skip and never a pass.

**A seventh probe, a filename containing a newline**, tests the enumeration
rather than the escaper — it is why subjects are carried NUL-separated through a
file instead of by command substitution, which drops NUL bytes:

```
$ printf … > "$S/scripts/checks/new"$'\n'"line.ts"
$ bash "$S/scripts/checks/check-instrument-typecheck.sh" ; echo "exit=$?"
  subjects found 49   subjects compiled 49   type failures 13   fidelity violations 2   missing 0
check-instrument-typecheck.sh FAILED — 13 type failure(s), 2 fidelity violation(s), 0 missing subject(s), census mismatch 0.
exit=1
```

49 found, 49 compiled — the newline did **not** split one subject into two. Its
type error is caught as a `FAIL`. Disclosed honestly: because tsc's own
diagnostic then spans two output lines, the fragment `line.ts(1,7): error
TS2322: …` also trips the fidelity guard as a path outside `scripts/checks/`.
That is a false *attribution* inside an already-failing run, never a false pass,
and it is the direction this gate is built to err in.

---

## `shellcheck` (A2.7, universal gate item 10)

```
$ shellcheck -S error scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
exit=0

$ shellcheck scripts/checks/check-instrument-typecheck.sh   # default level

In scripts/checks/check-instrument-typecheck.sh line 147:
  if [ -n "${TMP:-}" ] && [ -d "${TMP:-}" ]; then rm -rf "$TMP"; fi
  ^-- SC2317 (info): Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
     ^----------------^ SC2317 (info): Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
                          ^---------------^ SC2317 (info): Command appears to be unreachable. Check usage (or ignore if invoked indirectly).
                                                  ^-----------^ SC2317 (info): Command appears to be unreachable. Check usage (or ignore if invoked indirectly).


In scripts/checks/check-instrument-typecheck.sh line 148:
  return 0
  ^------^ SC2317 (info): Command appears to be unreachable. Check usage (or ignore if invoked indirectly).

For more information:
  https://www.shellcheck.net/wiki/SC2317 -- Command appears to be unreachable...
```

`-S error`: clean, exit 0.

**Disclosed and deliberately not fixed:** the two `SC2317` *info* findings on
`cleanup()`. They are false positives — shellcheck does not resolve
`trap cleanup EXIT`, so it reads the function body as unreachable. The fix would
be a `# shellcheck disable=SC2317` directive; it was not added, because a
disable directive in a gate whose reviewers are instructed to read every
suppression is a line they then have to adjudicate, and this one buys nothing.
The function demonstrably runs: §I3's SIGINT transcript shows the temp directory
removed by it.

---

## THE SUPPRESSION AUDIT (A2.9, R16, NF1)

Every `|| true`, `|| :`, `2>/dev/null`, `continue`, `set +e` and default
expansion in the script, exhaustively, by line number. `|| true`, `|| :` and
`set +e`: **zero occurrences** — `set +e` appears only inside a comment
explaining why it is not used. Line numbers are against the committed file.

| # | Line | Construct | Why it cannot convert a failure into a pass |
|---|---|---|---|
| 1 | 216 | `cd "$1" \|\| exit 1` inside the enumeration subshell | The opposite of a suppression: it turns a failed `cd` into a non-zero exit of the subshell, which the caller's `if ! …` turns into a **refusal**. Without it an unreachable repo root would yield an empty subject list — which R13's zero-subject refusal would then also catch. Two guards, same hole. |
| 2 | 261 | `cd "$1" \|\| exit 1` inside the uncovered-extension subshell | Identical shape, identical reason, and its caller refuses too. A failed uncovered-extension scan is a refusal, not an empty "none" line — otherwise the gate would print `none: no file matches …` while never having looked. |
| 3 | 325–326 | `git rev-parse … 2>/dev/null \|\| echo no-git` | **Provenance display fields only.** No counter, no branch and no exit path reads `git` — the round-800 gate's `merge-base` manifest guard was the only thing that did, and it is deleted. On a tree with no `.git` the two fields read `no-git` and the verdict is unchanged; §U-scratch's diff is the proof, since every scratch transcript in this document differs from I1 in exactly these two lines and the clock. |
| 4 | 387 | `if [ -z "$line" ]; then continue; fi` in `scan_fidelity` | Skips **blank lines** while scanning compiler output. A blank line carries no diagnostic: §1's third measurement establishes that every line containing `error TS` matched the located shape and none was blank. It cannot hide a diagnostic because it only fires when there is no content to hide. |
| 5 | 392 | `:` in the `scripts/checks/*)` case branch | A no-op on the **expected** path — a diagnostic correctly located inside the subject directory. The `*)` branch beside it is the one that counts a violation. Deleting the `:` would change nothing but bash's tolerance for an empty branch. |
| 6 | 439 | `continue` for a MISSING subject in the compile loop | The one `continue` on a failure path, and the audit's load-bearing entry. It skips the *compilation* of a file that is no longer on disk — after `MISSING` is incremented and **without** incrementing `COMPILED`. Three signals therefore fire, all printed, all proven by a real race in §U13: the named `MISSING` line, `missing 1` in the verdict, and the census `MISMATCH`. `exit 0` requires all four counters at zero, so a `continue` here cannot reach a pass. |
| 7 | 147 | `${TMP:-}` in `cleanup()` | A `set -u` guard for the window before `mktemp -d` has run. Without it a signal arriving in that window would make the trap itself fail on an unbound variable. It guards a variable that names a directory to delete; it touches no counter and no verdict. `cleanup` ends `return 0` for the same class of reason — so the trap cannot rewrite the script's exit status. |

Two further constructs a reviewer will reach for and should know are absent:

- **`2>&1` in the compile invocation (line 450)** is capture, not suppression:
  it merges tsc's stderr into `$OUT`, which is then printed in full on failure
  (R21) and scanned in full for fidelity. Nothing is discarded.
- **`|| true` after `grep`** — the idiom phase 1's `reproduce-census.sh` needs
  because `grep -c` exits 1 on zero matches — does not appear, because this gate
  does not shell out to `grep` at all. Diagnostic classification is done with
  bash's own `[[ =~ ]]`, whose failure to match is a *branch*, not an *exit
  code*.

---

## P-A and P-B (03-quality.md §3)

```
$ git diff main...HEAD -- scripts/checks/ | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
ok: no suppressions

$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'
(empty — the dependency footprint is untouched, NF8)
```

---

## Acceptance criteria, against the transcripts above

| # | Criterion | Where | Result |
|---|---|---|---|
| A2.1 | found = compiled = `ls … \| wc -l` = 42 | §0, §I1 | 42 = 42 = 42 |
| A2.2 | exit 1, exactly 6 failures, the phase-3 six | §0, §I1 | exit 1, 6, the same six the census names |
| A2.3 | provenance, all ten R20 fields, above the first PASS/FAIL line | §I1 | present |
| A2.4 | `git status --porcelain` empty after a run, a failed run, a SIGINT | §I3 | empty in all three; no leaked temp dir |
| A2.5 | two runs identical modulo timing/temp path; two concurrent runs correct | §I2, §I4 | 2 lines differ; both concurrent runs correct |
| A2.6 | correct verdict from another cwd by absolute path | §I6 | identical, diagnostics still repo-relative |
| A2.7 | `shellcheck -S error` clean | §shellcheck | clean, exit 0 |
| A2.8 | U7, U8, U9, U12, U13 transcripts present | §U7–§U13 | all five, with exit codes |
| A2.9 | every suppression read and justified | §audit | 7 entries, exhaustive |

---

## Handoff to phase 5

**`04-phases.md` §10 lists phase 5's write_set as
`scripts/checks/instrument-manifest.txt`,
`docs/plan/engine-task-graph/03-quality.md`,
`docs/plan/engine-task-graph/evidence/phase8-tooling.md` and
`docs/plan/scripts-checks-typecheck-gate/02-architecture.md`. That write_set
must GAIN `scripts/checks/check-instrument-typecheck.sh`.**

Without that line phase 5 cannot land the waiver machinery R14 and R22 require,
because the machinery lives in this script, not in the manifest. Two clearly
marked `PHASE 5 HOOK` comments sit in the gate exactly where
`02-architecture.md` §4.1 steps 8 and 11 belong:

- **Step 8 — read the ledger.** Parse `instrument-manifest.txt`'s four required
  fields per entry (path, diagnostic, reason, owner), fail on an entry missing a
  field (U11), and print **every** waiver above the verdict, because a waiver
  that is not printed is an exclusion nobody sees.
- **Step 11 — waiver reconciliation.** A waived subject that compiled clean is a
  **failure**, "waived but clean" (U10). Stale waivers are the mechanism by
  which an exclusion list outlives its reason.

R22 also changes with them: the failure verdict must then carry a waiver-
violation count beside the four counters it prints today.

**Why phase 2 did not implement them,** so phase 5 does not have to re-derive
it: `instrument-manifest.txt` today still holds seven bare paths in round-800
inclusion-list form. A ledger reader pointed at that file now would read all
seven as waivers, find all seven compile clean, and report seven "waived but
clean" violations — destroying acceptance criterion A2.2's "exactly 6 failures"
with noise from a file this phase does not own. The file and the reader must
change in one commit, and phase 5 owns the file.

Phase 5 also carries standing rule 2 for this rewrite. The gate no longer reads
the manifest and no longer runs the `git diff --diff-filter=ACMR main..HEAD`
manifest guard; three documents still describe both —
`instrument-manifest.txt`'s own header, `03-quality.md` §3.1 item 9, and
`phase8-tooling.md` §5.1 control (b). All three are phase 5's, amended in one
commit, and the gate's header states so in a sentence so that no reader of this
phase concludes they were forgotten.

---

## What this phase did NOT touch

`scripts/checks/instrument-manifest.txt`, the six red instruments,
`tsconfig.checks-instruments.json`, `package.json`, and every lockfile —
untouched. Phases 3 and 5 own them and phase 3 runs concurrently in this same
worktree. This phase's commits touch exactly two paths:
`scripts/checks/check-instrument-typecheck.sh` and this file.
