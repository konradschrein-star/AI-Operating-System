# 03 — Quality: test strategy, QA gates, reviewer instructions

**Project:** `scripts-checks-typecheck-gate`

This project's deliverable **is** a test instrument. That inverts the usual
relationship between the work and its verification, and it creates the one
failure mode that matters here:

> **A gate cannot certify itself.** Every claim this project makes about the
> gate must be established by making the gate *fail on purpose*, not by watching
> it pass.

Everything below follows from that sentence.

---

## 1. The three questions every phase's reviewer asks

Before the phase-specific criteria, before the universal gate, a reviewer of
this project asks three things. If any answer is unsatisfactory, the verdict is
FAIL regardless of what passed.

1. **Did it pass, or did it never run?** A gate that aborts mid-loop under
   `set -e` prints a truncated transcript that can read like success. The only
   pass signal is the final verdict line together with exit code 0. Check both.
2. **Did the instrument get fixed, or did the assertion get deleted?** The
   cheapest way to satisfy a typecheck is to stop checking. R28's grep and R29's
   breakage transcripts exist for this and are not optional.
3. **Is the coverage number the real one?** `subjects found N / compiled N`
   against `ls scripts/checks/*.ts scripts/checks/*.tsx | wc -l`. If those three
   numbers are not all equal, coverage is a claim, not a fact.

---

## 2. Test strategy

The subject is a bash script, one JSON config, and six TypeScript fixes. There
is no service, no database, no user. The strategy is therefore built out of
**executable observations**, not test frameworks, and every level below is a
command whose transcript is the artifact.

### 2.1 Unit level — the compile profile

The profile has no code, so its "unit tests" are compile outcomes on known
inputs. Phase 1's deliverable includes a reproduction of the census:

| Test | Command | Expected |
|---|---|---|
| U1 | profile over all 42 subjects | 36 green / 6 red, matching `evidence/census-G-generated-perfile-config.txt` exactly |
| U2 | profile over the 6 known-red | exactly the 11 diagnostics of `00-vision.md` §3.2, same codes, same lines |
| U3 | zero diagnostics outside `scripts/checks/` | grep the full output for paths not starting `scripts/checks/` → empty (S5) |
| U4 | app unaffected | `cd forge-control-web && pnpm typecheck` → exit 0, output byte-identical to the pre-project run |
| U5 | `typeRoots` is load-bearing | remove it, re-run: green count collapses to 12. Restore. Transcript kept. |
| U6 | determinism | run U1 twice; verdicts identical (NF2) |

U5 is a test of the *profile's own comment*. A comment that claims a line is
load-bearing, and is never checked, decays into folklore.

### 2.2 Unit level — the gate's decision logic

Each guard gets an input that should trip it. These are the gate's real unit
tests and they are run by mutating the environment, never by mocking:

| Test | Setup | Expected |
|---|---|---|
| U7 | glob matches nothing | refuse, non-zero, "a gate over nothing certifies nothing" (R13) |
| U8 | `forge-control-web/node_modules` absent | refuse, non-zero, printing the install line (R17) |
| U9 | the printed install line, run verbatim under `NODE_ENV=production` | leaves a tree where the gate passes (R18, C3) |
| U10 | a waived file that compiles clean | fail, "waived but clean" (R14) |
| U11 | a waiver missing one of its four fields | fail, naming the field (R14) |
| U12 | `scripts/checks/throwaway.mts` present | covered, or named as an uncovered extension. Silence fails. (R10) |
| U13 | subject deleted between enumeration and compile | census mismatch → fail (R12, R19) |

### 2.3 Integration level — the gate against the real directory

| Test | Command | Expected |
|---|---|---|
| I1 | `bash scripts/checks/check-instrument-typecheck.sh` on the finished tree | exit 0, 42/42, ledger empty |
| I2 | the same, immediately repeated | identical (NF2) |
| I3 | `git status --porcelain` right after a run | empty (NF3) |
| I4 | two runs concurrently | both correct (NF4) |
| I5 | `time` the run | recorded, not gated (NF6, S10) |
| I6 | run from a different cwd (`cd /tmp && bash <abs path>`) | identical verdict |

I6 is included because a gate that only works from one directory is a gate that
silently mis-reports for the first reviewer who runs it from somewhere else.

### 2.4 End-to-end level — the negative controls

These are the project's centre of gravity. Full protocol in §5.

### 2.5 Regression level — the instruments still work

For each of the six fixed instruments (R29): break its subject, watch it fail,
revert, watch it pass. Six transcripts. Without these, "the instruments compile"
and "the instruments work" are different claims and only the first is
established.

---

## 3. QA gates per phase

Every phase's gating reviewer runs **the universal gate** (`03-quality.md` §3.1
items 1–11, via its §4 command block) **plus** the phase-specific block below.
The universal gate is not restated here; where this project changes it, phase 5
amends it at source (standing rule 2).

Two commands are added to **every** phase's gate in this project, because both
failure modes are project-wide:

```bash
# P-A. No suppressions were introduced, in any phase. (R28)
# `@ts-nocheck` FIRST, added round 2 fix cycle 1: it was missing from this
# alternation and from R28, it disables a whole file in one line, and a planted
# subject carrying it compiled clean past every gate in this corpus (red-team
# breach B4). P-A is diff-scoped by construction, so it cannot see a
# suppression already on `main` — the gate itself now scans the DIRECTORY for
# the three comment directives and reports `suppressions N` in its census.
# Run both; neither subsumes the other.
#
# THE PATHSPEC IS NARROWED to the TypeScript subjects, from `scripts/checks/`
# to `scripts/checks/*.ts` + `*.tsx` (git matches those across subdirectories
# too — verified). Reason, found by running the amended grep against the
# amended gate: the gate is a .sh file that must NAME the directives it
# refuses, in its comments and in its own output, and the unscoped grep
# reported the gate's prose as five suppressions. A check that fires on the
# text of the check is a check every later phase learns to wave through — and
# a suppression directive inside a shell script suppresses nothing.
#
# THE ALTERNATION IS DELIBERATELY UNANCHORED — it matches `@ts-ignore`
# ANYWHERE on an added line, so `/** @ts-ignore */` (the JSDoc form) is caught.
# Measured round 3: that form suppresses a diagnostic and the GATE's own
# comment-shape grep missed it, which is how a broken subject reached `PASSED`
# (01-requirements.md R28, the eleven-shape table). Do not "tighten" this
# pattern to `^\+\s*//` — P-A is a diff-scoped tripwire whose false positives
# cost a reviewer one look, while its false negatives cost a green gate over a
# broken instrument. The gate's own scan is the precise one: it asks tsc's
# parser what tsc honours.
git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
  | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)' \
  && echo "FAIL: suppression introduced" || echo "ok: no suppressions"

# P-B. The dependency footprint is untouched. (NF8, S7)
git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'   # MUST be empty
```

### Phase 1 gate — the compile profile

```bash
cd forge-control-web && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline --prod=false
cd forge-control && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline --prod=false
# U1: reproduce the census
bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh   # phase 1 deliverable
diff <(...) docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
# U3: profile fidelity
# U4: app untouched
cd forge-control-web && pnpm typecheck        # exit 0
# R6: profile unreachable from any build
grep -rn 'checks-instruments' --include='*.json' --include='*.mjs' --include='*.ts' . | grep -v docs/ | grep -v scripts/checks
```

**PASS requires:** census reproduced exactly (36/42, the same 6 red with the
same 11 diagnostics); zero diagnostics outside `scripts/checks/`; app typecheck
unchanged; the profile referenced by nothing but the gate; U5's transcript
present.

**Reviewer must reject if:** the profile copies flags instead of `extends`-ing;
any `paths` entry points at a runtime package rather than `@types`; `typeRoots`
is absent; the census differs from round 0's by even one file. **A census that
differs is not a smaller problem than a broken gate — it means the profile is
not the one that was measured, and every downstream number is void.**

### Phase 2 gate — the gate rewrite

```bash
bash scripts/checks/check-instrument-typecheck.sh ; echo "exit=$?"
# expect: exit 1, 42 subjects found, 42 compiled, 6 failures — phase 3 has not run yet
#         and, since round 2 fix cycle 1: uncovered 0, suppressions 0, and a
#         SELF-TEST block whose canaries all say ok before any subject runs
#         (FIVE canaries since round 3 — the fifth is the suppression scanner,
#          which must print `ok: the suppression scanner works — 5 comment
#          shapes seen, 1 string decoy ignored`; a canary that is silent on
#          success is a canary nobody notices has stopped singing)
# the six red-team breaches, each re-planted and each now caught (round 2):
#   .d.ts / subdirectory / dotfile / .cts / @ts-nocheck — see
#   evidence/phase2-fixcycle1.md for the transcripts and the exact commands
# round 3 adds four re-plants, all on the real directory —
#   evidence/phase2-fixcycle1-round3.md:
#   /** @ts-ignore */ and its three siblings (must be named SUPPRESSED, and the
#   string-literal decoy beside them must NOT be); a symlinked subdirectory
#   (must be COMPILED, not refused); the same symlink one level deeper (must
#   refuse, naming the file AND the symlink); and the §7 extension edit
#   `SUBJECT_GLOBS += scripts/*.ts` (must enumerate 44 and compile them, not
#   wedge on a doubled `find` count)
# round 4 re-measured all four INDEPENDENTLY of the process that wrote them,
#   including a 15-probe cross-tabulation of the scanner against the compiler
#   (0 disagreements, both directions) — evidence/phase2-fixcycle2.md
git status --porcelain                      # empty (NF3)
ls /tmp | wc -l                             # before/after: no leaked temp dirs
bash scripts/checks/check-instrument-typecheck.sh > /tmp/a 2>&1; bash scripts/checks/check-instrument-typecheck.sh > /tmp/b 2>&1
diff /tmp/a /tmp/b                          # only timing/temp-path lines may differ (NF2)
cd /tmp && bash <abs>/scripts/checks/check-instrument-typecheck.sh   # I6
shellcheck -S error scripts/checks/check-instrument-typecheck.sh     # universal item 10
```

**PASS requires:** the gate finds 42 and compiles 42; it **fails**, correctly,
because phase 3 has not yet run — a phase-2 gate that passes is a phase-2 gate
that is not compiling the six red files, and is an immediate FAIL; U7, U8, U9,
U12, U13 transcripts present; provenance block carries all ten fields (R20);
`shellcheck -S error` clean; `git status` clean.

**Reviewer must reject if:** any `|| true`, `2>/dev/null` or `continue` can
convert a failure into a pass — the reviewer reads every one of them and says
so explicitly in the verdict; the subject glob or profile path is inlined rather
than a named variable at the top (02-architecture.md §7); **anything else is
derived from `scripts/checks/` by hand** — the coverage roots, the fidelity
prefixes and the `find` second opinion must all move when SUBJECT_GLOBS moves,
and the reviewer makes that edit and runs the gate rather than reading for it
(§7's table); the temp directory is not removed on the failure path.

### Phase 3 gate — the six fixes

```bash
bash scripts/checks/check-instrument-typecheck.sh    # exit 0, 42/42
# every fixed instrument still runs
cd forge-control-web
for f in check-orientation.ts check-team-confirm.ts check-team-rows.ts check-dismiss-peek.tsx check-stop-affordance.tsx; do
  ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/$f ; echo "$f exit=$?"
done
# serve-sse-808.ts binds and serves — it is a server, treat a timeout as success only with the bind line observed
# P-A suppression grep — MANDATORY here
```

**PASS requires:** 42/42 green; all five checks exit 0 under `tsx` with their
`ALL PASS` line; `serve-sse-808.ts` binds its port and proxies; six R29
breakage transcripts in `evidence/instruments-still-detect.md`; zero
suppressions; nothing modified outside `scripts/checks/` (R30).

**Reviewer must reject if:** any fix widens a type, casts, or deletes an
assertion; any file under `forge-control-web/app/**` or `forge-control/src/**`
appears in the diff; `serve-sse-808.ts` typechecks but does not bind.

### Phase 4 gate — the negative controls

**PASS requires:** all four controls of §5 transcribed with full output, exit
codes, and before/after green proof (R24); `git status --porcelain` empty after
every revert.

**Reviewer must reject if:** any control was described rather than run; any
transcript lacks the gate's own output; any mutation was left in the tree.

### Phase 5 gate — ledger and corpus

```bash
grep -n 'manifest' docs/plan/engine-task-graph/03-quality.md          # no surviving inclusion-list claim
sed -n '903,911p' docs/plan/engine-task-graph/03-quality.md           # §4 item 9's comment + its command
head -60 scripts/checks/instrument-manifest.txt                       # ledger header, semantics inverted
grep -n 'superseded' docs/plan/engine-task-graph/evidence/phase8-tooling.md
grep -n 'WAIVERS\|waived but clean' scripts/checks/check-instrument-typecheck.sh   # R14's two hooks, implemented
git log -1 --name-only                                                 # code + docs in ONE commit (standing rule 2)
```

**The `sed` window was re-derived at round 500 and moved from `855,865` to
`903,911`.** Phase 5's own amendment to §3.1 item 9 lengthened the file above
§4, so the old window read ten lines of item 10's shell-lint block — a gate that
passes on prose it never looked at. The window is nine lines, not ten, because
that is exactly item 9's comment plus the command it introduces; if a later
round moves it again, re-derive with
`grep -n '§3.1 item 9 — the instruments' docs/plan/engine-task-graph/03-quality.md`
and correct this block in the same commit. **A line number is pinned to the
round-500 commit** (`git log -1 --format=%H -- scripts/checks/instrument-manifest.txt`).

**PASS requires:** every corpus location that described the manifest-scoped gate
now describes the glob-scoped one, or is explicitly marked superseded with a
pointer; the ledger is empty and its header says why it exists; the amendment
and the code it describes are in the same commit.

**Reviewer must reject if:** any document still tells a reader to add a line to
the manifest to get a file compiled. That instruction, left standing, recreates
the hole in the mind of the next builder even though the script no longer has
it.

### Phase 6 gate — deploy and verify

See `04-phases.md` phase 6. **PASS requires** the cold-tree run (DoD-7, NF5) and
a final full-directory green on the merged tree.

---

## 4. What the reviewer must run, and what they must read

**Run** — non-negotiable, pasted verbatim into the verdict:

1. The universal gate, §3.1 items 1–11.
2. The phase block above.
3. P-A and P-B.

**Read** — with a specific question, because reading without one finds nothing:

| Read | The question |
|---|---|
| every `\|\| true`, `2>/dev/null`, `continue`, `set +e` in the gate | can this turn a failure into a pass? |
| the diff of each fixed instrument | did the assertion survive, or did it get deleted to make the compiler happy? |
| the profile's `paths` | does any entry point at a runtime package instead of `@types`? |
| the census numbers | do "found", "compiled" and `ls | wc -l` all agree? |
| every claim in the amended corpus | is it true of the gate that now exists, or of the one that used to? |

---

## 5. The negative-control protocol

Four controls. Each follows the identical five-step shape, and a control missing
any step does not count.

```
1. run the gate → GREEN. capture.
2. apply the mutation. show it (`git diff` or `ls`).
3. run the gate → capture the FULL output and the exit code.
4. revert. show `git status --porcelain` empty.
5. run the gate → GREEN again. capture.
```

**Control (a) — a broken type in a covered instrument.**
Append a type error to a green instrument. Expect: non-zero, that file named,
the diagnostic shown, and the other 41 still reported.

**Control (b) — a NEW file, type-broken, added to the directory.**
Create `scripts/checks/zz-control-b.ts` containing a type error. Add it to no
list. Expect: non-zero, `zz-control-b.ts` named, subject count 43.

This is the control that distinguishes this gate from the one it replaces. The
round-800 gate needed a manifest guard to catch this; the glob catches it
structurally. **If (b) passes, the project has not been done** — coverage would
still depend on a human remembering.

**Control (c) — no compiler.**
Move `forge-control-web/node_modules` aside. Expect: refusal, non-zero, the
install line printed, and *not* `tsc: not found` as the gate's answer. Then run
the printed line verbatim with `NODE_ENV=production` exported and confirm the
gate passes afterwards (R18/C3 — this environment prunes devDependencies and
this is the trap that has bricked it before).

**Control (d) — `typeRoots` removed from the profile.**
Expect: a mass failure (~30 red, `Cannot find name 'process'`). This control
does not prove the gate fails correctly; it proves the profile's comment is
true, so the next person who "cleans up" that line meets the evidence instead of
the folklore. Round 0 measured 12 green / 30 red.

All four go in
`docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`.

---

## 6. Adversarial review — where, and briefed to attack

Three points carry a red-team reviewer whose brief says *attack, do not check*.
A reviewer told to "verify" confirms; a reviewer told to "break" finds.

**A1 — Family B, `check-orientation.ts` (R33, mandatory).**
Brief: *"This instrument printed `ALL PASS` while building a `TeamNodeKind` that
never existed. It prints `ALL PASS` after the fix too — identically. Your job is
to establish whether it ever tested anything. Find an assertion whose outcome
depends on `kind`. If you cannot, say so plainly: the correct finding may be
that this instrument's coverage is smaller than its name claims, and that is a
finding worth more than a green tick."*

**A2 — The gate itself (phase 2).**
Brief: *"Make this gate report PASS while a `scripts/checks/*.ts` file on disk
has a type error. You may add files, rename files, use unusual extensions,
create symlinks, use filenames with spaces or leading dashes, empty the
directory, break the profile, exhaust the temp directory, or interrupt it
mid-run. You have succeeded if the final line says PASSED and the exit code is
0 while something is broken."*

**A3 — The fixes (phase 3).**
Brief: *"For each of the six, determine whether the fix preserved the assertion
or merely satisfied the compiler. For each, name the specific behaviour the
instrument would no longer catch if you are right."*

A2 is the one that matters most, because a gate that can be made to lie is worse
than the absence it replaces.

---

## 7. Test data and fixtures

No new fixtures. The instruments' own fixtures are the data, and repairing three
of them is the work (`evidence/round0-probes.md` §5). One rule governs every
fixture touched:

> **A fixture must be a value the system can actually produce.** `"run"` is not
> a `WorkingMsSource`. `"project_worker"` is not a `TeamNodeKind`. A fixture the
> wire contract forbids tests a system that does not exist, and it will pass
> forever.

Phase 3's reviewer checks each repaired fixture against the type definition it
claims to instantiate, by reading both.

---

## 8. Coverage accounting

| Requirement group | How covered |
|---|---|
| R1–R7 (profile) | U1–U6, phase 1 gate |
| R8–R15 (enumeration, ledger) | U7, U10–U13, controls (a)(b), phase 2 + 5 gates |
| R16–R22 (failure behaviour) | U7–U9, U13, control (c), reviewer read-through |
| R23–R24 (controls) | §5 in full |
| R25–R30 (fixes) | phase 3 gate, R29 transcripts, P-A |
| R31–R34 (corpus) | phase 5 gate |
| NF1–NF9 | distributed: NF1 read-through, NF2 I2, NF3 I3, NF4 I4, NF5 phase 6, NF6 I5, NF7 reviewer statement, NF8 P-B, NF9 task record |
| C1–C6 | enforced every phase; C2/C3 verified in phase 6 |

No requirement is covered only by inspection. Every one has a command.

---

## 9. The failure this document is written against

The instruments in `scripts/checks/` printed `ALL PASS` for months while
constructing fixtures the server cannot emit. Nobody was careless: every one of
those checks was reviewed by someone who ran it and saw it pass.

Running it was the wrong verification. That is the whole lesson, and it applies
to this project's own deliverable more sharply than to anything it checks — so
if a reviewer of this project finds themselves satisfied because the gate
printed `PASSED`, they have reproduced the exact error the project exists to
correct, one level up.

Make it fail first. Then believe it.
