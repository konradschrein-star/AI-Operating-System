# Phase 4 — the four negative controls, assembled

**Deliverable:** `04-phases.md` phase 4 (round label 400) names exactly one
document — this one. It carries controls (a)–(d) of
`docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5, each with all five
protocol steps, plus the wall-clock of a full gate run (A4.5) and the closing
state of the tree (A4.4).

**What this document is, and what it is not.** It is not a summary. Everything
below the header you are reading is a **byte-for-byte reproduction** of four
sealed originals, produced by a single `cat`, quoted below as the provenance of
its own contents and then verified against the originals' sha256 sums. Nothing
was re-typed, re-ordered, condensed, or improved. An assembly that improves the
prose destroys the evidence: the value of a transcript is that it is the thing
that happened, and a copy a reader cannot distinguish from an edit is worth
nothing. So the reader is given the means to distinguish — §4 below.

---

## 1. The protocol these four controls follow

Quoted verbatim from `docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5,
*The negative-control protocol*:

> Four controls. Each follows the identical five-step shape, and a control
> missing any step does not count.
>
> ```
> 1. run the gate → GREEN. capture.
> 2. apply the mutation. show it (`git diff` or `ls`).
> 3. run the gate → capture the FULL output and the exit code.
> 4. revert. show `git status --porcelain` empty.
> 5. run the gate → GREEN again. capture.
> ```

Step 4's *"`git status --porcelain` empty"* is met in every part below with one
standing exception, disclosed in each original and again here: two untracked
files,

```
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
```

belong to sibling tasks of this project, which share one worktree. They were
present before phase 4 began, no control created them, and no control removed
them. What step 4 requires and what every control shows is that **the mutation**
is absent from `git status` after the revert.

## 2. Tip

```
$ git rev-parse HEAD
1ef8ef4aa0c22d4690a189cd856710dc5721d550
```

Branch `project/b7ab4c57`. This is the tip at assembly time and the tip the
timed run of §5 was taken against — the run's own PROVENANCE block prints the
same sha, so the measurement certifies its own subject. The four originals were
each taken against the tip that existed when their control ran (`3b90700`,
`bedda20`, `dda76d8`, `1ef8ef4` — each part states its own); they are sequential
commits of this same phase and none of them touched a script, a profile, or the
gate, which §6 shows from `git diff`.

## 3. The four controls

| Control | Mutation | Expected (03-quality.md §5) | Measured | Verdict |
|---|---|---|---|---|
| **(a)** broken type in a covered instrument | one line appended to `scripts/checks/check-duration.ts` (line 356), shown by `git diff` | non-zero; that file named; the diagnostic shown; the other 41 still reported | exit **1**; `check-duration.ts` FAIL with `TS2322` at (356,14); 42 found, 42 compiled, 41 PASS + 1 FAIL; green before and after | **PASS** |
| **(b)** a NEW file, type-broken, listed nowhere | `scripts/checks/zz-control-b.ts` created (379 B), added to no manifest, no tsconfig, no list | non-zero; `zz-control-b.ts` named; subject count **43** | exit **1**; **43** found, **43** compiled; `zz-control-b.ts` FAIL with `TS2322` at (5,14); 42 PASS + 1 FAIL; green before and after | **PASS** |
| **(c)** no compiler | `forge-control-web/node_modules` (919 M) moved aside | refusal, non-zero, the install line printed, and *not* `tsc: not found` as the gate's answer; then that line run verbatim under `NODE_ENV=production` leaves a tree the gate passes | exit **1**, first line `REFUSING TO RUN: no executable tsc at …`; the printed line = gate source line 448, one sha256 `6d2c3eb…` across all three occurrences; run verbatim → `+ typescript 5.7.2`, `.bin/tsc` restored, gate green 42/42; counterfactual measured: the same line without `--prod=false` exits **0**, says `Already up to date`, and *removes* typescript | **PASS** |
| **(d)** `typeRoots` removed from the profile | `"typeRoots"` deleted from `compilerOptions` of `tsconfig.checks-instruments.json` | a mass failure (~30 red, `Cannot find name 'process'`); round 0 measured 12 green / 30 red | exit **1** — the gate **refuses at self-test canary 3** having compiled 0 of 42, which is why the control carries a step 3b: with the canary bypassed and the profile still mutated, `reproduce-census.sh` measures **13 green / 29 red**, 101 diagnostics, **51 × `TS2580: Cannot find name 'process'`**, against 42/42 green and 0 diagnostics with the line in place | **PASS** |

Read (b) with the stakes the protocol attaches to it: *"If (b) passes, the
project has not been done."* In the protocol's phrasing, a control that
"passes" is a gate that stayed green over a broken file. It did not — the gate
found 43 subjects where nobody had listed a 43rd. The verdict column above uses
the ordinary sense of the word: **the control did its job**, the gate failed
exactly as the claim requires, and phase 2 does not reopen.

Control (d) is the one control that is not a test of the gate. It tests whether
a *comment* is true — `tsconfig.checks-instruments.json` lines 34–39 tell the
next maintainer that `typeRoots` is load-bearing and cite this document for the
numbers. Until phase 4 that citation pointed at a file which did not exist. It
now points here, and the numbers are 13/29, measured, not recalled.

## 4. The four sealed originals, and the proof this file reproduces them

Four builders produced one control each. Their documents are the raw record;
they stay in place, untouched, and this file **does not replace them**:

```
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-a.md   30025 B   531 lines   sha256 a213722e86a3c247178605c5c23778e039a0be61cb4be16578b5a52317e1c47a
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-b.md   38734 B   722 lines   sha256 942b2bfa2db95eb8d4538ff6223315df4f1baf3edd5f6e49a37c509018568eb8
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md   36977 B   778 lines   sha256 fedf7ea5cd3f531ff43a38a8c04244e6b9acd34c7eed3eeebfc6827f60d936db
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-d.md   56249 B   887 lines   sha256 9db3a6bb941e4a9e83511050183dee07aad6b82469ff24400999a00eb1671822
```

**How this file was produced — one command, quoted as the provenance of its own
contents:**

```
$ cat /tmp/p4-header.md \
      docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-a.md \
      docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-b.md \
      docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md \
      docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-d.md \
    > docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md
```

`/tmp/p4-header.md` is the header — everything above part (a)'s H1 title. It is
the only prose in this file that was written by the assembling task. Every byte
after it came out of that `cat`. (No line of the header itself begins with a
control title, which is what lets the check below split the file back apart on
exactly four boundaries.)

**The proof.** A reader should not have to take the previous sentence on faith,
so here is the check, run against **this file** after it was written. Each part
begins with a unique H1 of the form `# Phase 4, control (x) — …` and each ends
with a newline, so the concatenation can be split back apart on those titles
without knowing anything about the header's length; segment 0 is the header,
segments 1–4 must be the four originals, in order, byte-identical:

```
$ awk 'BEGIN{n=0} /^# Phase 4, control \(/{n++} {print > ("/tmp/p4-split-" n ".part")}' \
    docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md
$ wc -c /tmp/p4-split-1.part /tmp/p4-split-2.part /tmp/p4-split-3.part /tmp/p4-split-4.part
 30025 /tmp/p4-split-1.part
 38734 /tmp/p4-split-2.part
 36977 /tmp/p4-split-3.part
 56249 /tmp/p4-split-4.part
161985 total
$ sha256sum /tmp/p4-split-1.part /tmp/p4-split-2.part /tmp/p4-split-3.part /tmp/p4-split-4.part
a213722e86a3c247178605c5c23778e039a0be61cb4be16578b5a52317e1c47a  /tmp/p4-split-1.part
942b2bfa2db95eb8d4538ff6223315df4f1baf3edd5f6e49a37c509018568eb8  /tmp/p4-split-2.part
fedf7ea5cd3f531ff43a38a8c04244e6b9acd34c7eed3eeebfc6827f60d936db  /tmp/p4-split-3.part
9db3a6bb941e4a9e83511050183dee07aad6b82469ff24400999a00eb1671822  /tmp/p4-split-4.part
```

Segment 1 = part (a), segment 2 = (b), segment 3 = (c), segment 4 = (d): four
byte counts identical to the originals', four sha256 sums identical to the
originals', in that order. A single changed character anywhere in the reproduced
span — a fixed typo, a re-wrapped line, a tightened sentence — would change the
sum of the segment containing it and this check would say so. It does not. The
four transcripts below are the originals, unedited.

The split is also what makes the header auditable: the assembled file is exactly
`header ‖ a ‖ b ‖ c ‖ d`, so anything a reader distrusts in the summary above can
be checked against the transcript that produced it, three screens down.

## 5. A4.5 — the wall-clock of a full run

This section is the assembling task's own measurement, not a quotation. One full
gate run, from a tree in the state §6 records, on 2026-08-18 (started
`20260818T141354Z`, finished `20260818T141626Z`):

```
$ time bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4-final.txt 2>&1 ; echo "EXIT=$?"

real	2m32.097s
user	6m30.126s
sys	0m14.971s
EXIT=0
```

The gate's own accounting, from the tail of `/tmp/p4-final.txt`:

```
CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 152s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

| Quantity | Value |
|---|---|
| real | **2m32.097s = 152.1 s** |
| user | 6m30.126s = 390.1 s |
| sys | 0m14.971s |
| the gate's own printed elapsed line | `wall clock       : 152s` |
| subjects found / compiled | **42 / 42** |
| exit code | **0** |

The gate's own line and `time`'s `real` agree to the second, which is the useful
cross-check: the number is the whole run, not a stopwatch around one stage.

`user` exceeding `real` by 2.6× is not concurrency in the gate. Its loop is
serial — the script contains no `xargs -P`, no background `&`, no `wait` — and
one subject compiled alone reproduces the same shape (`real 3.124s / user
6.872s`, measured on this tree): the excess is the compiler process's own
runtime threads, and 42 × ~3.1 s of serial subject time is where the 152 s
comes from. Per subject: **~3.6 s**.

**The number is RECORDED, NOT GATED.** No threshold anywhere in this project
compares against it; nothing fails because a run took longer than some budget.
It is recorded so that a later reader can tell whether the gate got slower, and
by how much, from a number that was actually measured rather than remembered.

If 152 s is intolerable, that is a finding for a follow-up project — **batching
subjects by population**, one `tsc` invocation over a group of files that share a
profile instead of one per file — and NEVER a reason to narrow coverage.
Narrowing coverage to buy speed rebuilds the exact hole this project exists to
close.

That hole, stated once more so the trade is unmistakable: `scripts/checks/` sat
outside both `tsconfig` include lists, `tsx` stripped its types without checking
them, and the fleet's verification instruments became the least-verified code in
the repository — not because anyone decided that, but because the cheap option
was always to check a little less. Coverage here is structural, enumerated by
glob at run time (control (b) is the proof), and the moment it becomes a list
again — a subset, a "fast lane", a skip flag — control (b) starts passing and the
gate is back to certifying whatever somebody remembered to add.

## 6. A4.4 — the closing state

Every command below was run in this worktree, after the timed run of §5.

**The gate, green:** the run of §5 is the closing run — `EXIT=0`, `42/42
subjects compiled clean`, 0 type failures, 0 fidelity violations, 0 uncovered,
0 suppressions, and its five self-test canaries green (`strict null checking`,
`declaration files`, `typeRoots/@types/jsx`, `noEmit`, `the suppression
scanner`). Its COVERAGE block reports `scanned … 42 file(s); enumerated as
subjects: 42`, `ok: 0 uncovered`, against 42 files on disk (`ls
scripts/checks/*.ts scripts/checks/*.tsx | wc -l` → 42).

**No mutation survives, and no scaffolding:**

```
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md

$ ls scripts/checks/zz-control-b.ts
ls: cannot access 'scripts/checks/zz-control-b.ts': No such file or directory
EXIT=2

$ ls -d /opt/ai-os/workspace/.phase4-nm-aside
ls: cannot access '/opt/ai-os/workspace/.phase4-nm-aside': No such file or directory
EXIT=2

$ ls -d forge-control-web/node_modules
forge-control-web/node_modules
EXIT=0
```

Read in order: no tracked file is modified — control (a)'s appended line and
control (d)'s deleted `typeRoots` are both gone, and the two `??` lines are the
sibling tasks' phase-3 documents named in §1, which no control touched. Control
(b)'s new file is absent from the directory. Control (c)'s aside path, where 919
MB of `node_modules` sat while the compiler was missing, does not exist. And the
compiler is back where the gate expects it, which the run of §5 confirms from the
inside: `tsc : Version 5.7.2 (…/forge-control-web/node_modules/.bin/tsc)`.

`git status --porcelain` is empty bar the two disclosed sibling files and, at
commit time, this document itself.

**This phase touched only evidence documents:**

```
$ git diff --name-only HEAD~4..HEAD
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-a.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-b.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-d.md
```

Four commits, four documents, and not one line of the gate, the profile, or an
instrument. That is the check that distinguishes evidence from a patch: phase 4
produces no code by design, and any control that had been "made to pass" would
have to show up in this list. Nothing does. The gate that failed four times on
purpose and passed in 152 s at the end is bit-for-bit the artifact phase 2
shipped — `sha256 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67`,
printed by the run itself — and the profile is phase 1's, `sha256
837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8`.

*(The range above is read from the tip named in §2, before this document's own
commit. From the commit that adds this file the same five-document window is
`HEAD~5..HEAD`; it adds this path and nothing else.)*

**Write-set.** The assembling task wrote exactly one file:
`docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`. The
four originals were read, hashed, and copied; none was edited.

---

*Everything from here to the end of the file is reproduced verbatim. The four
parts follow in order — (a), (b), (c), (d) — each beginning with its own H1.*

---

# Phase 4, control (a) — a broken type in a covered instrument

**Protocol:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5, control
(a), five steps. **Phase spec:** `04-phases.md` phase 4 (round label 400),
acceptance criteria A4.1, A4.4, A4.5.

**Tip measured:** `git rev-parse HEAD` →
`3b907002380d6b107138a9dddfbe6059cdf688c0`, branch `project/b7ab4c57`.
Re-read after the last measurement — unchanged. The gate prints the same sha in
its own provenance block on all three runs below, so every transcript here
certifies the tip it was taken against.

**Compiler, from the gate's own provenance block (not from a separate `tsc
--version` that could be a different binary):**

```
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
```

The two sha256 lines matter as much as the version: they pin the gate script and
the compile profile that produced these three transcripts, so a later reader can
tell whether the instrument that failed here is the instrument they are holding.

**This phase produced no code.** The only file written by this task is this one.
The gate was not edited — it is phase 2's artifact and is frozen for phase 4; had
any of the four required observations been absent, this document would record a
FAILED control rather than a patched gate.

**Dependencies, before any gate.** `NODE_ENV=production` is exported into this
run, so the bare `--frozen-lockfile` form prunes `devDependencies` — where `tsx`
and `typescript` live — and exits 0 while leaving a tree the gate cannot compile
in. Run first, verbatim:

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 900ms using pnpm v9.15.9
```

**Wall clock (A4.5, S10, NF6).** The gate reports its own: **167s / 151s / 166s**
for steps 1, 3 and 5 — one `tsc` process per subject over 42 subjects. Recorded,
not gated (NF6). Every invocation below was given a 600 000 ms tool timeout,
because the Bash default of 120 s kills this run mid-loop and leaves a truncated
transcript that is not evidence.

---

## Step 1 — the gate on the clean tree → GREEN

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4a-step1.txt 2>&1 ; echo "EXIT=$?"
EXIT=0
```

Full contents of `/tmp/p4a-step1.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 3b907002380d6b107138a9dddfbe6059cdf688c0
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.41m9S7IFe2

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 167s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**What this establishes.** The baseline, and it is the half of a negative control
people forget: without it, a failure in step 3 could be the tree's fault rather
than the mutation's. Exit 0, 42 found, 42 compiled, 42 `PASS` lines (counted
mechanically below), zero of every failure category. `check-duration.ts` — the
file about to be mutated — is green here, so the diagnostic that appears in step
3 is attributable to the appended line and to nothing else.

---

## Step 2 — the mutation, and the diff that shows it

The mutation is exactly one appended line. `export` is deliberate: an unexported
`const` would also raise an unused-local diagnostic and muddy the reading of what
the gate caught.

```
$ printf 'export const zzControlA: number = "definitely not a number";\n' >> scripts/checks/check-duration.ts
$ git diff -- scripts/checks/check-duration.ts
diff --git a/scripts/checks/check-duration.ts b/scripts/checks/check-duration.ts
index e1f4d56..356124a 100644
--- a/scripts/checks/check-duration.ts
+++ b/scripts/checks/check-duration.ts
@@ -353,3 +353,4 @@ console.log(
   `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — duration helpers`,
 );
 process.exit(failures === 0 ? 0 : 1);
+export const zzControlA: number = "definitely not a number";
```

**What this establishes.** The subject is now type-broken and nothing else in the
tree is. The hunk header `@@ -353,3 +353,4 @@` fixes the arithmetic for step 3:
the file was 355 lines, so the added line is line **356**, and that is the line
number the diagnostic must carry if the gate is reading the file on disk rather
than a cached or stale copy. One file changed, one line added, no other path
touched.

Note also *where* the line sits — after `process.exit(...)`, which at runtime is
unreachable. That is the point of the control rather than a flaw in it: `tsx`
strips types without checking them and would never look at this line, so a
mutation the runtime cannot reach is precisely the kind of breakage only a
typecheck gate can see. This project exists because that gap was real.

---

## Step 3 — the gate against the mutated tree

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4a-step3.txt 2>&1 ; echo "EXIT=$?"
EXIT=1
```

Full contents of `/tmp/p4a-step3.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 3b907002380d6b107138a9dddfbe6059cdf688c0
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.NRM9yiPT9s

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  FAIL scripts/checks/check-duration.ts                 exit 2
         scripts/checks/check-duration.ts(356,14): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 151s

check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
```

### The four required observations, each asserted against the text above

**(i) Exit code non-zero.** The shell reported `EXIT=1`, and the transcript's own
last line agrees rather than merely coexisting with it:

```
check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
```

Both signals are required by §1 question 1 — a truncated run can print a
plausible tail, and a non-zero exit with no verdict line is an abort, not a
verdict. Here the verdict line and the exit code say the same thing, and the
verdict attributes the failure to the right category: `1 type failure(s)`, every
other counter zero.

**(ii) `check-duration.ts` named as a FAILURE.** Quoting the line:

```
  FAIL scripts/checks/check-duration.ts                 exit 2
```

The gate names the file, and names it in the `FAIL` column of the per-subject
table — not in a summary count that would leave a reader grepping for which of 42
subjects broke. `exit 2` is `tsc`'s own exit status for a compile with
diagnostics, carried through rather than flattened to a boolean.

**(iii) The diagnostic is shown.** Quoting the line:

```
         scripts/checks/check-duration.ts(356,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

This is the expected diagnostic on all four axes: code **TS2322**; message
**`Type 'string' is not assignable to type 'number'`**; path
`scripts/checks/check-duration.ts`; and position **(356,14)** — line 356 being
exactly the line step 2's diff added, column 14 being the first character of
`zzControlA` (`export ` is 7 characters, `const ` a further 6). A gate that
printed only `FAIL` would leave the next person to re-run the compiler by hand to
learn what was wrong; this one hands over `tsc`'s own text, unedited.

**(iv) 42 subjects, and the other 41 still reported.** This is the observation the
control exists for. A gate that aborts on the first failure — under `set -e`, or
by `exit`-ing inside the loop — would truncate the table at
`check-duration.ts` and hide the state of the 37 subjects that follow it
alphabetically, including all five `.tsx` files. The reader would then be told
about one broken instrument while thirty-seven others went unmeasured, and would
have no way to see that from the transcript. Quoting the count line and the
census:

```
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
```

```
  subjects found 42   subjects compiled 42   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
```

`subjects found 42   subjects compiled 42` — the gate did not stop at the
failure; it compiled every subject it enumerated. And the tally, counted
mechanically off the file rather than by eye:

```
$ echo "PASS lines: $(grep -c '^  PASS ' /tmp/p4a-step3.txt)"; echo "FAIL lines: $(grep -c '^  FAIL ' /tmp/p4a-step3.txt)"; echo "step1 PASS lines: $(grep -c '^  PASS ' /tmp/p4a-step1.txt)"
PASS lines: 41
FAIL lines: 1
step1 PASS lines: 42
```

41 + 1 = 42 = `subjects found`. Step 1's 42 `PASS` lines and step 3's 41 differ by
exactly the mutated subject, so no subject was silently dropped from the run to
make the arithmetic work. The four post-typecheck sections — SUPPRESSIONS,
PROFILE FIDELITY, CENSUS and the verdict — all executed after the failure too,
which is the same property observed at the level of the gate's phases rather than
its subjects.

**Verdict on control (a): PASS.** All four required observations present.

---

## Step 4 — revert, and the tree afterwards

```
$ git checkout -- scripts/checks/check-duration.ts
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
$ git diff --stat
(no output)
```

**Which line is which.** Both lines are `??` — untracked — and **neither is a
residue of this control**:

- `evidence/phase3-gate.md` — phase 3's gating reviewer's evidence, written by a
  sibling task in this shared worktree and not yet committed by it. Not mine.
- `evidence/phase3-redteam.md` — phase 3's red-team evidence, same origin. Not
  mine.

This worktree is shared by every task of the project, so another task's
uncommitted file appears in my `git status`. I did not write, edit, commit or
remove either one. My own file,
`evidence/negative-controls-a.md`, was written after this step and appears as a
third `??` line in the status taken immediately before the commit below.

Crucially, **`scripts/checks/check-duration.ts` does not appear at all** — no
` M` line, and `git diff --stat` is empty. The mutation is gone from the tree, not
merely from the index. `wc -l` confirms the file is back to its 355 lines and
`git diff --quiet -- scripts/checks/check-duration.ts` exits 0 against HEAD.

**What this establishes.** A4.4 for this control: the mutation was applied,
measured and removed, and no part of it survives into the tree the next phase
inherits. The one thing this step cannot show is that the *file* is unbroken —
only step 5 shows that, which is why the protocol has a fifth step at all.

---

## Step 5 — the gate on the reverted tree → GREEN again

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4a-step5.txt 2>&1 ; echo "EXIT=$?"
EXIT=0
```

Full contents of `/tmp/p4a-step5.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 3b907002380d6b107138a9dddfbe6059cdf688c0
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.GVgB8THtS0

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 166s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**What this establishes.** The gate returned to green — exit 0, 42/42, zero
failures — which closes the control in both directions. Read together with step 1
and step 3 it says something none of the three says alone: the gate's verdict
tracks the state of the tree, and only the state of the tree. It went red when
one line was added and green when that line was removed, with the same script
sha256, the same profile sha256, the same compiler and the same 42 subjects
across all three runs. That is the difference between an instrument and a
formality.

The `temp dir` differs on every run (`tmp.41m9S7IFe2`, `tmp.NRM9yiPT9s`,
`tmp.GVgB8THtS0`) and the wall clock varies by ~10%; nothing else in the three
transcripts differs except the mutated subject's line and the counters that
follow from it — the determinism NF2 asks for, observed incidentally here and
tested directly by I2.

---

## Ledger

| Step | Command | Exit | Result |
|---|---|---|---|
| 1 | `bash scripts/checks/check-instrument-typecheck.sh` | 0 | PASSED — 42 found, 42 compiled, 42 PASS |
| 2 | `printf '…' >> scripts/checks/check-duration.ts` ; `git diff` | 0 | one line added at 356, shown |
| 3 | `bash scripts/checks/check-instrument-typecheck.sh` | **1** | FAILED — `check-duration.ts` TS2322 at (356,14); 42 found, 42 compiled, 41 PASS + 1 FAIL |
| 4 | `git checkout -- scripts/checks/check-duration.ts` ; `git status --porcelain` | 0 | subject absent from status; two `??` lines belong to phase 3's tasks |
| 5 | `bash scripts/checks/check-instrument-typecheck.sh` | 0 | PASSED — 42 found, 42 compiled, 42 PASS |

**Control (a): PASS.** Non-zero exit; the file named as a FAILURE; the diagnostic
shown with its code, message, line and column; the subject count still 42 with
the other 41 individually reported.

**Write-set.** This document is the only file this task wrote. No code was
changed, and the gate was not touched.
# Phase 4, control (b) — a new type-broken file, listed nowhere

**Protocol:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5, control
(b), five steps. **Phase spec:** `04-phases.md` phase 4 (round label 400),
acceptance criteria A4.1, A4.4, A4.5.

**This is the control the project exists for.** Control (a) shows the gate reads
the files it knows about. This one asks the harder question: does it know about a
file nobody told it about? The round-800 gate answered that with a *manifest
guard* — a diff-scoped check that failed the run when a `scripts/checks/*.ts`
file the branch had touched was missing from `instrument-manifest.txt`. That is a
guard against a human forgetting, and it only fires on files the branch touched.
This gate enumerates by glob, so the claim under test is stronger and different
in kind: **coverage is structural, and a new file is compiled because it exists,
not because anyone remembered it.**

The protocol states the stakes plainly: *"If (b) passes, the project has not been
done."* A control that "passes" here means the gate stayed green over a broken
file — the central claim would be false and phase 2 would reopen. It did not
happen; the verdict is at the foot of this document, with the five transcripts
that carry it.

**Tip measured:**

```
$ git rev-parse HEAD
bedda20983f5029629058f2d7bfe51e77b4d7562
```

Branch `project/b7ab4c57`. Re-read after the last measurement — unchanged. The
gate prints the same sha in its own provenance block on all three runs below, so
each transcript certifies the tip it was taken against rather than relying on
this heading.

**Compiler, from the gate's own provenance block** (not from a separate `tsc
--version`, which could resolve a different binary):

```
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
```

Both sha256 lines are identical to those in `negative-controls-a.md`, so control
(a) and control (b) were taken against the same instrument and the same profile.
Two controls measured against two different gates would be two anecdotes.

**This phase produced no code.** The only file this task wrote is this one. The
gate was not edited — it is phase 2's artifact and is frozen for phase 4. Had the
control passed, this document would record that failure and the escalation, not a
patched gate.

**Dependencies, before any gate.** `NODE_ENV=production` is exported into this
run, so a bare `--frozen-lockfile` prunes `devDependencies` — where `tsx` and
`typescript` live — and exits 0 while leaving a tree the gate cannot compile in:

```
$ cd forge-control-web && echo "NODE_ENV=$NODE_ENV" && pnpm install --frozen-lockfile --prod=false
NODE_ENV=production
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 958ms using pnpm v9.15.9
```

**Wall clock (A4.5, S10, NF6).** The gate reports its own: **155s / 177s / 153s**
for steps 1, 3 and 5 — one `tsc` process per subject, over 42 subjects and then
43. Recorded, not gated. Every invocation below was given a 600 000 ms tool
timeout: the Bash default of 120 s kills this run mid-loop, and a truncated
transcript is not evidence, it is a transcript that can be mistaken for one.

---

## Step 1 — the gate on the clean tree → GREEN

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4b-step1.txt 2>&1 ; echo "EXIT=$?"
EXIT=0
```

Full contents of `/tmp/p4b-step1.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : bedda20983f5029629058f2d7bfe51e77b4d7562
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.uR18wbj4Sd

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 155s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**What this establishes.** The baseline this control is measured against: exit 0,
**42** found, **42** compiled, 42 `PASS` lines, every failure counter zero. For
control (b) the number that matters here is the *42* itself, because the whole
control turns on it changing — a baseline of 43 or a baseline that varies between
runs would make step 3's count unreadable. It is also the half of a negative
control people skip: without it, a red step 3 could be the tree's fault rather
than the new file's.

Note what is *not* in this list: nothing named `zz-control-b.ts`. The file does
not exist yet, and the gate's list is the directory.

---

## Step 2 — the mutation: a file created, and added to nothing

The mutation is a whole new file. Its comment header exists so that a copy
surviving into a committed tree announces itself as a mistake; the type error is
the single `export const` line, exactly as §5 specifies.

```
$ cat > scripts/checks/zz-control-b.ts <<'EOF'
// Phase 4, negative control (b) — a NEW instrument, type-broken, added to the
// directory and to NO list. It exists for the duration of one gate run and is
// removed in step 4 of docs/plan/scripts-checks-typecheck-gate/03-quality.md §5.
// If you are reading this in a committed tree, that revert did not happen.
export const zzControlB: number = "a string, not a number";
EOF
```

**Shown three ways, as the brief requires.**

(1) It exists on disk, with a size and a timestamp:

```
$ ls -l scripts/checks/zz-control-b.ts
-rw-r--r-- 1 root root 379 Aug 18 15:35 scripts/checks/zz-control-b.ts
```

(2) Git sees it as **untracked** — the strongest possible statement that no
committed list can be carrying it, since git itself has never heard of it:

```
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
?? scripts/checks/zz-control-b.ts
```

The third line, `?? scripts/checks/zz-control-b.ts`, is the mutation. The first
two are phase 3's evidence files, written by sibling tasks in this shared
worktree and not committed by them; they are not mine and I did not touch them.

(3) It is in no manifest — `grep` exits 1, its "no lines selected" status:

```
$ grep -n zz-control-b scripts/checks/instrument-manifest.txt ; echo "grep exit=$?"
grep exit=1
```

**And, beyond the three the brief asks for, in nothing else either.** "Added to
no list" is a claim about the whole repository, so it is worth measuring as one
rather than inferring it from a single file:

```
$ grep -rn 'zz-control-b\|zzControlB' . --exclude-dir=node_modules --exclude-dir=.git --exclude=zz-control-b.ts ; echo "grep exit=$?"
./docs/plan/scripts-checks-typecheck-gate/03-quality.md:317:Create `scripts/checks/zz-control-b.ts` containing a type error. Add it to no
./docs/plan/scripts-checks-typecheck-gate/03-quality.md:318:list. Expect: non-zero, `zz-control-b.ts` named, subject count 43.
grep exit=0
```

The only two references in the entire tree are the two prose lines of the
protocol that *specify this control*. No tsconfig, no manifest, no script, no
JSON — and the repo has exactly four tsconfigs, all checked:

```
$ ls tsconfig*.json forge-control-web/tsconfig*.json forge-control/tsconfig*.json
forge-control/tsconfig.json
forge-control-web/tsconfig.json
tsconfig.checks-instruments.json
tsconfig.checks.json
```

The manifest's own contents make the point sharper still. It remains in
round-800 inclusion-list form, naming seven paths:

```
scripts/checks/check-close-gate.ts
scripts/checks/check-fix-chain-graph.ts
scripts/checks/check-plan-api.ts
scripts/checks/check-plan-store.ts
scripts/checks/check-project-metadata.ts
scripts/checks/check-task-api.ts
…
scripts/checks/check-screenshot-render-shapes.ts
```

**Under the gate this project replaces, this control would have been invisible.**
Seven paths were compiled; a new file was caught only if the *manifest guard*
noticed the branch had touched a `scripts/checks/*.ts` absent from the list — and
that guard is deleted. So if the enumeration were still list-driven in any form,
step 3 would report 42 subjects and exit 0 over a file with a type error sitting
in the directory. That sentence is the pass condition of this control and the
failure condition of the project.

**What this establishes.** There is now exactly one type-broken TypeScript file
in `scripts/checks/`, it is new, and no artifact in the repository names it. The
error is `TS2322` by construction — a `string` initialiser on a `number`
annotation — and it sits on **line 5**, column **14** (`export ` is 7 characters,
`const ` a further 6), which is the position step 3's diagnostic must carry if
the gate is reading this file off disk rather than a stale or cached list.

---

## Step 3 — the gate against the mutated tree

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4b-step3.txt 2>&1 ; echo "EXIT=$?"
EXIT=1
```

Full contents of `/tmp/p4b-step3.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 43 file(s); enumerated as subjects: 43
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : bedda20983f5029629058f2d7bfe51e77b4d7562
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 43
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.L9ilOiheU4

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  FAIL scripts/checks/zz-control-b.ts                   exit 2
         scripts/checks/zz-control-b.ts(5,14): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 43   subjects compiled 43   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 177s

check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
```

### The four required observations, each asserted against the text above

**(i) Exit code non-zero.** The shell reported `EXIT=1`, and the transcript's own
final line agrees rather than merely coexisting with it:

```
check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
```

§1 question 1 requires both signals, because a run that aborts mid-loop under
`set -e` prints a truncated transcript that can read like success, and a non-zero
exit with no verdict line is an abort rather than a verdict. Here they say the
same thing, and the verdict attributes the failure to the correct counter:
`1 type failure(s)`, every other counter zero. In particular `0 uncovered
file(s)` — the new file was not merely *noticed* by the R10 safety net and
declined; it was **compiled as a subject**, which is a stronger outcome and the
one the claim is about.

**(ii) Subject count 43, not 42.** The enumeration line, quoted:

```
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 43 file(s); enumerated as subjects: 43
```

and the two places the same number is restated independently — the provenance
block and the closing census:

```
  subjects found   : 43
```

```
  subjects found 43   subjects compiled 43   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
```

**This is the observation the control exists for.** 42 → 43 without a single
list being edited. The count is not read from a manifest, not carried over from a
previous run, and not a constant in the script: it is the size of a set the gate
computes by globbing the directory, *twice*, with two different tools —
bash's `**` and `find -L` — which must agree file for file or the run refuses.
Both saw 43. A gate whose coverage came from a list would have printed 42 here,
and 42 with a green verdict is precisely the sentence brief A2 defines as a
breach.

**(iii) `zz-control-b.ts` named as a failure, with its diagnostic.** Quoting both
lines:

```
  FAIL scripts/checks/zz-control-b.ts                   exit 2
         scripts/checks/zz-control-b.ts(5,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

The file is named — in the `FAIL` column of the per-subject table, not buried in
a summary count that would leave a reader grepping 43 subjects for the culprit.
`exit 2` is `tsc`'s own status for a compile with diagnostics, carried through
rather than flattened to a boolean. The diagnostic matches expectation on all
four axes: code **TS2322** as the brief predicted; message **`Type 'string' is
not assignable to type 'number'`**; path `scripts/checks/zz-control-b.ts`; and
position **(5,14)** — line 5 and column 14 being exactly where step 2 put the
`zzControlB` identifier. That position is what distinguishes *the gate compiled
this file* from *the gate reported this file*: a stale or synthesised entry
cannot know the column.

Its placement in the table is worth one sentence, because it is evidence of
the enumeration order and not of anything the file was told to do. The subject
list is sorted per glob in C order, `*.ts` before `*.tsx`, so `zz-control-b.ts`
appears **after** `serve-v3-7798.ts` — the last of the previous `.ts` files — and
**before** `check-chat-rich.tsx`. It slotted into the middle of the sorted run
because it is a member of the set, not because it was appended to the end of a
list.

**(iv) The other 42 still reported.** Counted mechanically off the files rather
than by eye:

```
$ echo "PASS lines: $(grep -c '^  PASS ' /tmp/p4b-step3.txt)"; echo "FAIL lines: $(grep -c '^  FAIL ' /tmp/p4b-step3.txt)"; echo "step1 PASS lines: $(grep -c '^  PASS ' /tmp/p4b-step1.txt)"
PASS lines: 42
FAIL lines: 1
step1 PASS lines: 42
```

42 + 1 = 43 = `subjects found` = `subjects compiled`. Step 1's 42 `PASS` lines
and step 3's 42 are the *same 42 files*, individually named in both transcripts:
the new subject was added to the run without displacing or silencing any existing
one. This matters because the plausible way for a gate to "notice" a new file
badly is to abort on it — under `set -e`, or by `exit`-ing inside the loop —
which would truncate the table at `zz-control-b.ts` and hide the state of the
five `.tsx` files that follow it, reporting one broken instrument while five went
unmeasured. Every post-typecheck section ran too: SUPPRESSIONS, PROFILE FIDELITY,
CENSUS and the verdict all appear below the failure.

The clearest single artifact is the diff of the two transcripts, which shows that
*nothing else moved*:

```
$ diff /tmp/p4b-step1.txt /tmp/p4b-step3.txt
5c5
<   scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
---
>   scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 43 file(s); enumerated as subjects: 43
18c18
<   subjects found   : 42
---
>   subjects found   : 43
20c20
<   temp dir         : /tmp/tmp.uR18wbj4Sd
---
>   temp dir         : /tmp/tmp.L9ilOiheU4
66a67,68
>   FAIL scripts/checks/zz-control-b.ts                   exit 2
>          scripts/checks/zz-control-b.ts(5,14): error TS2322: Type 'string' is not assignable to type 'number'.
80,81c82,83
<   subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
<   wall clock       : 155s
---
>   subjects found 43   subjects compiled 43   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
>   wall clock       : 177s
83c85
< check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
---
> check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
```

Five hunks, and every one of them is either the new subject, a counter that
follows from it, or a line the protocol permits to vary (the temp dir and the
wall clock, NF2). No existing subject changed verdict.

**Verdict on control (b): the gate caught it.** All four required observations
present. The control did **not** pass; the central claim holds. No escalation was
posted, because the condition for posting one — a green gate, a count of 42, or
the file unnamed — did not occur.

---

## Step 4 — revert, and the tree afterwards

The deletion below is authorised explicitly by this task's brief, and its scope
is one path: the file created in step 2 and nothing else.

```
$ rm scripts/checks/zz-control-b.ts
$ ls -l scripts/checks/zz-control-b.ts ; echo "ls exit=$?"
ls: cannot access 'scripts/checks/zz-control-b.ts': No such file or directory
ls exit=2
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
$ git diff --stat
(no output)
$ ls scripts/checks/*.ts scripts/checks/*.tsx | wc -l
42
```

**Which line is which.** Both remaining lines are `??` — untracked — and neither
is a residue of this control:

- `evidence/phase3-gate.md` — phase 3's gating reviewer's evidence, written by a
  sibling task in this shared worktree and not yet committed by it. Not mine.
- `evidence/phase3-redteam.md` — phase 3's red-team evidence, same origin. Not
  mine.

Both were present before this task began and are recorded identically in
`negative-controls-a.md` step 4. This worktree is shared by every task of the
project, so another task's uncommitted file appears in my status. I did not
write, edit, commit or remove either one. My own file — this document — was
written after this step and appears as a third `??` line in the status taken
immediately before the commit.

**`scripts/checks/zz-control-b.ts` does not appear at all.** Not as `??`, not as
`D`, not anywhere: an untracked file that is deleted leaves no trace in git,
which is why the `ls` and the `wc -l` are here beside the status. The directory
is back to **42** TypeScript-family files, the number step 1 measured.

**What this establishes.** A4.4 for this control: the mutation was created,
measured, and removed, and no part of it survives into the tree the next phase
inherits. What this step cannot show is that the directory *compiles* again —
only step 5 shows that, which is why the protocol has a fifth step.

---

## Step 5 — the gate on the reverted tree → GREEN again

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/p4b-step5.txt 2>&1 ; echo "EXIT=$?"
EXIT=0
```

Full contents of `/tmp/p4b-step5.txt`, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : bedda20983f5029629058f2d7bfe51e77b4d7562
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.8LYzUfZaKt

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 153s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

Step 1 against step 5, in full:

```
$ diff /tmp/p4b-step1.txt /tmp/p4b-step5.txt ; echo "diff exit=$?"
20c20
<   temp dir         : /tmp/tmp.uR18wbj4Sd
---
>   temp dir         : /tmp/tmp.8LYzUfZaKt
81c81
<   wall clock       : 155s
---
>   wall clock       : 153s
diff exit=1
$ grep -c '^  PASS ' /tmp/p4b-step5.txt
42
```

**What this establishes.** The gate is back to green — exit 0, 42/42, every
counter zero — and the *only* two lines that differ from the baseline are the two
the protocol names as permitted to vary: the temp directory and the wall clock
(NF2). Not one subject, not one count, not one section header moved. Read
together with steps 1 and 3, this says what no single run can: **the gate's
verdict is a function of the directory's contents and of nothing else.** It went
from 42-green to 43-red when a file appeared, and back to 42-green when it left,
with the same script sha256, the same profile sha256, the same compiler and the
same node across all three runs.

---

## Ledger

| Step | Command | Exit | Result |
|---|---|---|---|
| 1 | `bash scripts/checks/check-instrument-typecheck.sh` | 0 | PASSED — 42 found, 42 compiled, 42 PASS |
| 2 | `cat > scripts/checks/zz-control-b.ts` ; `ls -l` ; `git status --porcelain` ; `grep … instrument-manifest.txt` | grep 1 | file on disk (379 B), untracked `??`, in no manifest, in no tsconfig, referenced only by the protocol's own prose |
| 3 | `bash scripts/checks/check-instrument-typecheck.sh` | **1** | FAILED — **43** found, **43** compiled; `zz-control-b.ts` FAIL, TS2322 at (5,14); 42 PASS + 1 FAIL |
| 4 | `rm scripts/checks/zz-control-b.ts` ; `git status --porcelain` | 0 | file absent; 42 files on disk; status carries only phase 3's two `??` files |
| 5 | `bash scripts/checks/check-instrument-typecheck.sh` | 0 | PASSED — 42 found, 42 compiled, 42 PASS; differs from step 1 only in temp dir and wall clock |

---

## Did the structural claim hold?

Yes — and it held structurally, which is the whole of the claim. A file that no
human and no artifact in this repository had listed was created in
`scripts/checks/`, and the very next run of the gate enumerated **43** subjects
instead of 42, compiled all 43, named `scripts/checks/zz-control-b.ts` in the
`FAIL` column with `tsc`'s own diagnostic at the exact line and column the error
was written to, still reported the other 42 individually, and exited **1**. No
manifest was edited, no tsconfig was touched, no guard had to notice that a
branch had modified a file, and nothing depended on the author of that file
having read a plan — the file was compiled because it was *there*. That is the
difference between this gate and the round-800 gate it replaces, stated as a
measurement rather than as an intention: the old gate compiled a list of seven
paths and needed a diff-scoped manifest guard to catch a newcomer, and that guard
is deleted because there is no longer a list to be absent from. Coverage is now a
property of the directory. The failure mode this project was chartered against —
an instrument sitting in `scripts/checks/` for months, type-broken, running green
because nothing ever asked the compiler — cannot recur through the "nobody added
it to the list" door, because that door no longer exists. Phase 2 does not
reopen.

---

**Write-set.** This document is the only file this task wrote and the only file
in its commit. `scripts/checks/zz-control-b.ts` existed for the duration of one
gate run and was removed in step 4; no code was changed, and the gate was not
touched.
# Phase 4, control (c) — no compiler, and the install line that must restore one

**Protocol:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5, control
(c), five steps. **Phase spec:** `04-phases.md` phase 4 (round label 400).
**Risks closed:** R17, R18, C3 — and, structurally, hazard (d) of the gate's own
header comment, *"`tsc: not found`, disclosed and ignored."*

Controls (a) and (b) ask whether the gate reads its subjects. This one asks a
different question, and it is the one that decides whether anybody will still be
running the gate in six months: **what does the instrument do when its own
toolchain is missing?** The failure mode is not a wrong answer. It is a gate that
greets a fresh worktree with `tsc: not found`, gets classified as "the flaky one",
and is skipped from then on — a gate whose first response is an error is a gate
reviewers learn to skip.

So the claim under test has two halves, and the second is the one that has bitten
this environment before:

1. **The refusal is the gate's own.** No compiler → non-zero, and the message is
   `REFUSING TO RUN: no executable tsc at …` with the fix printed, not a shell's
   `tsc: not found` leaking through.
2. **The printed fix actually works.** The line the refusal prescribes, run
   VERBATIM in this environment — which exports `NODE_ENV=production` — must
   leave a tree the gate passes in. This is the half that is easy to get wrong
   and impossible to notice: `tsx` and `typescript` are `devDependencies`, this
   environment prunes them, and an install line missing `--prod=false` **exits 0
   while leaving no compiler**. A refusal that printed the plain line would teach
   the trap instead of the fix.

Both halves held. §7 below measures the counterfactual on this very tree, so the
`--prod=false` claim in this document is a measurement and not a repetition of
doctrine.

**Tip measured:**

```
$ git rev-parse HEAD
89c3849e334252e27b35f95320138249799da5fc
```

Branch `project/b7ab4c57`. The gate prints the same sha in its own provenance
block on both green runs below, so each transcript certifies the tip it was taken
against rather than trusting this heading.

**Compiler and instrument, from the gate's own provenance block** (not from a
separate `tsc --version`, which could resolve a different binary):

```
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
```

Both sha256 lines are identical to those in `negative-controls-a.md` and
`negative-controls-b.md`. All three controls were therefore measured against the
same instrument and the same profile; three controls against three different
gates would be three anecdotes.

**This control produced no code.** The only file this task wrote is this one. The
gate was not edited — it is phase 2's artifact, frozen for phase 4. Had the
control failed, this document would record the failure and the escalation (a
wrong install line is a phase-2 finding), not a patched gate.

**What was moved, and where.** `forge-control-web/node_modules` (919 MB,
gitignored) was moved to `/opt/ai-os/workspace/.phase4-nm-aside/node_modules` —
**outside the worktree, deliberately.** Inside the worktree it would be a
directory the gate's own glob enumeration and `git status` would have to reason
about; outside it, it can neither dirty the tree nor be enumerated. Same
filesystem (`/dev/md2` for both paths, confirmed with `df -P`), so the `mv` is a
rename and completes instantly rather than copying 919 MB.

```
$ df -P forge-control-web/node_modules /opt/ai-os/workspace
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/md2         949187668 623528580 277369332      70% /
/dev/md2         949187668 623528580 277369332      70% /

$ du -sh forge-control-web/node_modules
919M	forge-control-web/node_modules
```

---

## 0. Pre-flight — dependencies before any gate

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 902ms using pnpm v9.15.9
EXIT=0

$ ls -l forge-control-web/node_modules/.bin/tsc
-rwxr-xr-x 1 root root 1520 Aug 18 15:46 /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc
```

A compiler is present before the control begins. Everything measured below is
therefore a consequence of the mutation, not of a tree that arrived broken.

---

## 1. The gate, before the mutation → GREEN

```
$ bash scripts/checks/check-instrument-typecheck.sh
```

**Exit code: 0.** Full output, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 89c3849e334252e27b35f95320138249799da5fc
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.JdYVWBDicY

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 165s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**What it establishes.** The baseline. 42 subjects found, 42 compiled, 0 type
failures, exit 0, 165 s. Every red observed later in this document is caused by
the mutation of step 2 and by nothing else — without this line, a refusal in step
3 could be a tree that was already broken.

---

## 2. The mutation — move the compiler aside

```
$ mkdir -p /opt/ai-os/workspace/.phase4-nm-aside
$ mv forge-control-web/node_modules /opt/ai-os/workspace/.phase4-nm-aside/node_modules
```

Shown, exactly as the protocol's step 2 requires (`git diff` for a code mutation,
`ls` for a filesystem one — this is the latter):

```
$ ls forge-control-web/
app
auth.ts
ecosystem.config.cjs
middleware.ts
next.config.mjs
next-env.d.ts
package.json
PLAN.md
pnpm-lock.yaml
tsconfig.json
tsconfig.tsbuildinfo

$ ls -d /opt/ai-os/workspace/.phase4-nm-aside/node_modules
/opt/ai-os/workspace/.phase4-nm-aside/node_modules

$ du -sh /opt/ai-os/workspace/.phase4-nm-aside/node_modules
919M	/opt/ai-os/workspace/.phase4-nm-aside/node_modules

$ ls -l forge-control-web/node_modules/.bin/tsc
ls: cannot access 'forge-control-web/node_modules/.bin/tsc': No such file or directory
ls exit=2

$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
```

`node_modules` no longer appears in `forge-control-web/`, all 919 MB of it are at
the aside path, and `.bin/tsc` is gone. The mutation is exactly "this worktree has
no compiler" and nothing else — no source file was touched, which is why
`git status` is unchanged by it. (The two `??` entries are a sibling task's phase-3
evidence files, untracked at the moment this task started; they are not mine and
are not committed by me. See §8.)

**Why the aside path is outside the worktree.** A backup inside the worktree would
be a 919 MB directory that `git status` must ignore and that the gate's own
`**/*.ts` enumeration would have to be trusted to skip — a control that changes
two things at once measures neither. Outside, it changes exactly one.

---

## 3. The gate, with no compiler → REFUSAL

```
$ bash scripts/checks/check-instrument-typecheck.sh
```

**Exit code: 1.** Full output, verbatim and unfiltered:

```
REFUSING TO RUN: no executable tsc at /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc

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
```

### 3.1 Assertion one — the exit code is non-zero

`EXIT=1`. Not 0. A gate that cannot run must not be mistakable for a gate that
ran and found nothing, and CI reads the number, not the prose.

### 3.2 Assertion two — the refusal is the gate's own message

The **first line of the entire transcript** is the gate speaking:

```
$ sed -n 1p /tmp/p4c/step3.txt
REFUSING TO RUN: no executable tsc at /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc
```

`tsc: not found` never appears as an answer. It appears exactly once in the whole
transcript, on line 5, inside double quotes, in the gate's own sentence explaining
what it is refusing to become:

```
$ grep -n 'not found' /tmp/p4c/step3.txt
5:"tsc: not found", which is how a gate gets disclosed and ignored. Fix it with
```

One occurrence, and it is the gate naming the failure mode it is guarding
against, not suffering it. This distinction is the whole of hazard (d): a shell's
`tsc: not found` is a fact about a missing binary and tells the reader nothing
about what to do; `REFUSING TO RUN: no executable tsc at <absolute path>` names
the exact path that was probed and is followed by a fix. The refusal also states
*why* the path is empty on a clean checkout ("it is gitignored"), which is the
piece a newcomer cannot deduce.

Note also that the refusal quotes the **absolute** path it probed. That matters
for a second reason unrelated to this control: `$TSC` being absolute is what makes
a fake `tsc` earlier on `PATH` irrelevant (red-team breach B5, §3b of the gate).

### 3.3 Assertion three — the install line, byte for byte

The line as **printed** (transcript line 8, dumped with `cat -A`; `$` marks
end-of-line, so there is no trailing whitespace):

```
$ sed -n '8p' /tmp/p4c/step3.txt | cat -A
  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false$
```

The line in the **source**:

```
$ grep -n 'pnpm install' scripts/checks/check-instrument-typecheck.sh
210:#       `pnpm install --frozen-lockfile` says "skipping devDependencies"
448:  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
451:NODE_ENV=production; under it a plain \`pnpm install --frozen-lockfile\` prints
1073:  echo "  Install as step 3 says: cd forge-control-web && pnpm install --frozen-lockfile --prod=false" >&2

$ sed -n '448p' scripts/checks/check-instrument-typecheck.sh | cat -A
  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false$
```

Compared as bytes, after stripping only the two-space presentation indent from
each — printed vs. source, and printed vs. the literal the brief prescribes:

```
$ diff printed-line.txt source-line.txt && echo 'IDENTICAL (diff exit 0)'
IDENTICAL (diff exit 0)

$ diff printed-line.txt brief-line.txt && echo 'IDENTICAL (diff exit 0)'
IDENTICAL (diff exit 0)

$ sha256sum printed-line.txt source-line.txt brief-line.txt
6d2c3eba8cc0f64a68e720fe395a9ad0d91ed6125a99d061878d3b6ec139a52d  printed-line.txt
6d2c3eba8cc0f64a68e720fe395a9ad0d91ed6125a99d061878d3b6ec139a52d  source-line.txt
6d2c3eba8cc0f64a68e720fe395a9ad0d91ed6125a99d061878d3b6ec139a52d  brief-line.txt
```

One sha256 across all three. **The printed line matches the source byte for byte,
and both match the prescribed literal byte for byte.** `--prod=false` is present
and `--prefer-offline` is present; nothing was mangled by the heredoc on the way
out (worth checking rather than assuming — the block is an unquoted `<<EOF`, so
`$TSC` interpolates by design and a stray unescaped metacharacter in that line
would have been substituted too; it was not, because there is none).

`grep` finds `pnpm install` on three further lines. Lines 210 and 451 are prose
*about* the plain line, describing the trap, and neither is a prescription. Line
1073 is a different refusal — reached when `$TS_LIB` is absent, i.e. the
suppression scanner has no TypeScript parser — and it prescribes
`cd forge-control-web && pnpm install --frozen-lockfile --prod=false`: the same
fix minus `--prefer-offline`. It carries `--prod=false`, so it is safe and does
not teach the trap; it is simply not byte-identical to its sibling. That is a
cosmetic divergence in a refusal this control does not exercise, recorded here as
an observation for phase 5 rather than as a finding. **Nothing in control (c)
turns on it.**

### 3.4 What step 3 establishes

With no compiler the gate refuses in its own voice, exits 1, and prints a fix
that is byte-identical to the one the plan specifies. Hazard (d) is closed on the
first half. Whether the fix *works* is step 4, and only step 4.

---

## 4. THE REAL TEST — the printed line, run verbatim under `NODE_ENV=production`

A refusal that prints a fix has made a promise. The rest of this control is
collecting on it. This is the step where an install line missing `--prod=false`
would exit 0, look clean, and leave the tree exactly as broken as before —
R18/C3, the trap that has bricked this environment.

**The environment, before the line runs:**

```
$ pwd
/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
$ echo "NODE_ENV=$NODE_ENV"
NODE_ENV=production
$ ls -l forge-control-web/node_modules/.bin/tsc
ls: cannot access 'forge-control-web/node_modules/.bin/tsc': No such file or directory
```

`NODE_ENV` reads `production` — it is exported into this run by the executor, and
was re-exported explicitly in the same shell as the install so the value under
which the install ran is the value shown. No compiler is present. The test is
therefore being run under the pruning condition, which is the only condition
under which it is worth running.

**The line, exactly as the gate printed it:**

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
```

**Exit code: 0.** Full output, verbatim and unfiltered:

```
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +492
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 492, reused 492, downloaded 0, added 492, done

dependencies:
+ @assistant-ui/react 0.14.24
+ @cubone/react-file-manager 1.35.0
+ @excalidraw/excalidraw 0.18.1
+ @tanstack/react-query 5.62.7
+ @tanstack/react-virtual 3.14.9
+ 3d-force-graph 1.80.0
+ next 15.1.3
+ next-auth 5.0.0-beta.25
+ react 19.0.0
+ react-dom 19.0.0
+ react-markdown 10.1.0
+ remark-gfm 4.0.1
+ three 0.185.1

devDependencies:
+ @types/node 22.10.2
+ @types/react 19.0.2
+ @types/react-dom 19.0.2
+ typescript 5.7.2

Done in 1.5s using pnpm v9.15.9
```

492 packages, all 492 `reused` from the pnpm store and 0 downloaded — which is
what `--prefer-offline` buys and why restoring 919 MB took 1.5 s. Note the block
headed **`devDependencies:`**, and `+ typescript 5.7.2` inside it. That block is
the entire point of this step: under `NODE_ENV=production`, this line installed
the `devDependencies` anyway.

**A compiler is actually back — not inferred from the install's exit code, but
executed:**

```
$ ls -l forge-control-web/node_modules/.bin/tsc
-rwxr-xr-x 1 root root 1520 Aug 18 15:50 forge-control-web/node_modules/.bin/tsc

$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
```

The binary exists, is executable, and identifies itself as the same 5.7.2 the
step-1 provenance block recorded. Running it matters more than listing it: the
gate's own §3b refuses a `tsc` that cannot answer `--version` in the form
`Version X.Y.Z`, because a half-broken shim that exits 0 silently once made every
subject report a clean compile.

**The tree is not dirty:**

```
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md

$ git check-ignore -v forge-control-web/node_modules
forge-control-web/.gitignore:1:node_modules	forge-control-web/node_modules
```

Empty but for a sibling task's untracked evidence (§8). Moving 919 MB out and
installing 492 packages back in produced **zero** tracked changes, because
`node_modules` is ignored by `forge-control-web/.gitignore:1` — verified with
`git check-ignore` rather than assumed. `--frozen-lockfile` is what holds the
other half of that: it forbids pnpm from editing `package.json` or the lockfile to
satisfy a resolution, which is what would have shown up here as a real diff.

**What step 4 establishes.** The promise the refusal makes is kept. The printed
line, copied verbatim by someone who reads nothing else, run in the environment
this fleet actually has, restores a working compiler and leaves the repository
byte-identical. The refusal is a fix, not a complaint.

---

## 5. The gate, after the prescribed install → GREEN again

```
$ bash scripts/checks/check-instrument-typecheck.sh
```

**Exit code: 0.** Full output, verbatim and unfiltered:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 89c3849e334252e27b35f95320138249799da5fc
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.LgL9jMGqMt

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 151s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

**What it establishes — and why this step is not a formality.** Step 4 could have
restored *something*. Step 5 is what makes it a proof: the gate does not merely
stop refusing, it runs its five self-tests, compiles all 42 subjects, and returns
the same verdict it gave before the compiler was ever moved.

The two green transcripts differ in exactly two lines, and neither is a finding:

```
$ diff step1.txt step5.txt
20c20
<   temp dir         : /tmp/tmp.JdYVWBDicY
---
>   temp dir         : /tmp/tmp.LgL9jMGqMt
81c81
<   wall clock       : 165s
---
>   wall clock       : 151s
```

A fresh `mktemp -d` per run, and 14 s of wall-clock noise on a ~2½-minute gate.
Identical subject list, identical census, identical self-tests, identical
`tsc`/`node`/profile/instrument provenance — **including both sha256 lines**, so
the instrument that went green afterwards is the same instrument, byte for byte,
that refused in step 3. The tree the prescribed install produced is not merely
*a* working tree; it is indistinguishable from the one that was moved aside.

---

## 6. Cleanup

The backup this task created, and nothing else:

```
$ du -sh /opt/ai-os/workspace/.phase4-nm-aside
919M	/opt/ai-os/workspace/.phase4-nm-aside

$ rm -rf /opt/ai-os/workspace/.phase4-nm-aside
rm exit=0

$ ls -d /opt/ai-os/workspace/.phase4-nm-aside
ls: cannot access '/opt/ai-os/workspace/.phase4-nm-aside': No such file or directory

$ ls -l forge-control-web/node_modules/.bin/tsc
-rwxr-xr-x 1 root root 1520 Aug 18 15:50 forge-control-web/node_modules/.bin/tsc

$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
```

Deleted only after step 5 came out green, and only that exact path — explicitly
authorised by the task brief as the backup this task itself created. The rollback
branch (restore from the aside, re-run the gate, write the control up as FAILED)
was not taken, because steps 4 and 5 both came out right.

---

## 7. Why `--prod=false` is load-bearing — measured here, not quoted

The gate's refusal asserts that a plain `pnpm install --frozen-lockfile` under
`NODE_ENV=production` exits 0 and removes the compiler. That assertion is the
reason the printed line carries `--prod=false`, and a control that only ran the
good branch would leave it as folklore. So both branches were run, on this tree,
minutes apart, under the same exported `NODE_ENV`.

**The good branch — what step 4 above actually measured.** The prescribed line,
run verbatim with `NODE_ENV=production`, exited 0 and printed a block headed
`devDependencies:` containing `+ typescript 5.7.2`. `forge-control-web/node_modules/.bin/tsc`
then existed and answered `Version 5.7.2`, and the gate went green over 42/42.

**The bad branch — the same line with `--prod=false` removed, nothing else
changed:**

```
$ echo "NODE_ENV=$NODE_ENV"
NODE_ENV=production
$ cd forge-control-web && pnpm install --frozen-lockfile
```

**Exit code: 0.** Full output:

```
Lockfile is up to date, resolution step is skipped
Already up to date

devDependencies:
- @types/node 22.10.2
- @types/react 19.0.2
- @types/react-dom 19.0.2
- typescript 5.7.2

Done in 945ms using pnpm v9.15.9
```

```
$ ls -l forge-control-web/node_modules/.bin/tsc
ls: cannot access 'forge-control-web/node_modules/.bin/tsc': No such file or directory
ls exit=2
$ ls -d forge-control-web/node_modules/typescript
ls: cannot access 'forge-control-web/node_modules/typescript': No such file or directory
ls exit=2
```

Read that transcript as an operator would. It says `Already up to date`. It says
`Done in 945ms`. It exits **0**. Nothing in it is coloured, nothing says *error*,
nothing says *warning* — and the compiler is gone. The only tell is the direction
of four hyphens: `- typescript 5.7.2` rather than `+`. **`--prod=false` is
load-bearing because its absence is silent.** The difference between the two
branches is not success versus failure; it is success versus success, with one of
them leaving no compiler behind.

Two things follow, and only the first is about this control:

1. **The gate catches the trap's outcome.** Run against the tree that clean-looking
   install left, the gate refused again — exit 1, same message, same prescription:

   ```
   $ bash scripts/checks/check-instrument-typecheck.sh
   EXIT=1
   REFUSING TO RUN: no executable tsc at /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc
   ...
     cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
   ```

   So an operator who mistypes the fix does not get a subtly wrong green. They get
   the same refusal, and the same correct line, until they run it as printed. The
   loop is closed.

2. **A refusal printing the plain line would have been worse than no refusal at
   all.** It would hand the operator a command that exits 0, prints `Already up to
   date`, and changes nothing about their problem — and the natural next inference
   from "the fix ran clean and the gate still refuses" is that the gate is broken.
   That is precisely how an instrument gets disclosed and ignored. This is why
   control (c) exists as a *five-step* control and not as an inspection of the
   message text: the message is only correct if the command inside it works, and
   that is a claim about the environment, not about the string.

The tree was restored immediately afterwards by re-running the prescribed line —
exit 0, `+ typescript 5.7.2`, `Version 5.7.2` — and it is that tree that step 5
above measured green.

---

## 8. Scope, and one disclosure

**Files written by this task: one.** `docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md`
— this document. No script, no profile, no config was edited; the gate is phase
2's artifact and is frozen for phase 4.

**Disclosure — two untracked files this task did not create and does not commit.**
`git status --porcelain` is not empty in the transcripts above. It carries:

```
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
```

Both were already present, untracked, when this task started — they belong to a
sibling task of the same project, which shares this worktree. They are recorded
here so the `git status` output above is not read as an unexplained smudge left by
control (c), and they were deliberately left alone: this task's commit stages its
own single path by name.

**No live surface was touched.** `/opt/forge-ai-os` was not read, edited, or
served from; no `pm2` process was restarted; nothing was verified against the live
database or a live port. Every measurement in this document was taken inside this
worktree.

---

## 9. Verdict

**Control (c) PASSES.** All five protocol steps taken, in order, none skipped.

| Step | Expectation | Measured |
|---|---|---|
| 1 | gate green before the mutation | exit 0, 42/42 compiled, 0 failures, 165 s |
| 2 | compiler removed, shown | `node_modules` absent from `forge-control-web/`, 919 M at the aside path, `.bin/tsc` gone |
| 3 | refusal, non-zero, the gate's own message | exit 1, first line `REFUSING TO RUN: no executable tsc at …` |
| 3 | *not* `tsc: not found` as the answer | that string occurs once, quoted, inside the gate's own explanation |
| 3 | install line printed, exactly | printed = source line 448 = prescribed literal, one sha256 `6d2c3eb…` across all three |
| 4 | printed line, verbatim, `NODE_ENV=production` | exit 0, `devDependencies: + typescript 5.7.2`, `.bin/tsc` present, `Version 5.7.2`, no tracked diff |
| 5 | gate green again | exit 0, 42/42, transcript differs from step 1 in `mktemp` name and wall clock only |
| — | `--prod=false` load-bearing | measured: without it, exit 0, `Already up to date`, `- typescript 5.7.2`, no compiler (§7) |

Hazard (d) of the gate's header — *"`tsc: not found`, disclosed and ignored"* —
is closed on both halves: the gate refuses in its own voice with a non-zero
status, and the fix it prints is one that works in this environment rather than
one that quietly does not. R17, R18 and C3 are discharged by measurement.
# Phase 4, control (d) — `typeRoots` removed, and what the profile's comment actually costs

**Protocol:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md` §5, control
(d), five steps, plus the profile-level census of step 3b. **Phase spec:**
`04-phases.md` phase 4 (round label 400). **Also discharges** U5 of §2.1 against
the finished tree — phase 1 ran U5 against the tree as it stood on 2026-08-18,
this control re-runs it after phase 3 changed six of the subjects.

Controls (a), (b) and (c) all ask the same kind of question: *does the gate fail
when it should?* This one does not. It asks whether **a comment is true.**

`tsconfig.checks-instruments.json` lines 34–39 carry an instruction to the next
maintainer:

```
  "//typeRoots": [
    "MUST be pinned. TypeScript's automatic @types discovery walks up from the",
    "directory of the CONFIG FILE, and the gate generates its per-file config",
    "in `mktemp -d`, which has no node_modules ancestry. Without this line the",
    "whole directory collapses with `Cannot find name 'process'`: measured at",
    "12/42 green, 30 red. See evidence/negative-controls.md control (d)."
  ],
```

That comment cites a document. Until this task, the document did not exist and
the citation was an assertion pointing at itself. A comment that claims a line is
load-bearing and is never re-measured decays into folklore, and folklore is
exactly what a maintainer overrules when a line looks redundant — `typeRoots`
looks redundant, because every other consumer of this repo resolves `@types`
without it. **This file is the citation.**

## The two-part answer, and why the first part is not a failure of the control

The gate acquired a five-canary self-test in round 2, and canary 3
(`canary-clean.tsx`) uses `process.env`:

```
export const home: string = process.env.HOME ?? '';
```

Its whole purpose is to fail if `typeRoots`, the four `@types` paths or the
`react-jsx` transform stop resolving — so that canaries 1 and 2 can be trusted to
have failed *for the reason claimed* and not because everything fails. Removing
`typeRoots` is precisely the condition canary 3 exists to detect. So the gate
**never reaches its 42 subjects**: it refuses at the self-test, exit 1, having
compiled nothing.

That is the correct behaviour and it is itself the control's first result — the
canary works. It is not, however, the census the comment claims, because the gate
stops before it could take one. The 12/30 shape is a *profile-level* measurement,
so step 3b reproduces it at profile level with phase 1's own instrument,
`evidence/reproduce-census.sh`, which decides nothing and therefore has no
self-test to refuse at.

**Nothing was adjusted to force the census shape out of the gate.** Suppressing
canary 3 to reach the subjects would have meant editing the gate — phase 2's
frozen artifact — to make a phase 4 document tidier, which is the exact trade
this project exists to refuse.

## Tip measured

```
$ git rev-parse HEAD
dda76d863b5ee73b44b73aa313286dc98f861010
```

Branch `project/b7ab4c57`. The gate prints the same sha in its own provenance
block on both green runs below, and `reproduce-census.sh` prints it too, so each
transcript certifies the tip it was taken against rather than trusting this
heading.

**Compiler and instrument, from the gate's own provenance block:**

```
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (…/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
```

Both sha256 lines are identical to those in `negative-controls-a.md`,
`negative-controls-b.md` and `negative-controls-c.md`. All four controls were
measured against the same gate and the same profile.

**This control produced no code.** The only file this task wrote is this one.
`tsconfig.checks-instruments.json` was mutated and reverted; nothing else in the
tree was touched. The profile is phase 1's artifact and was not improved, only
broken and restored.

**Dependencies, first, because this environment prunes them:**

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 970ms using pnpm v9.15.9

$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
$ echo "NODE_ENV=$NODE_ENV"
NODE_ENV=production
```

`--prod=false` is not optional here and `Already up to date` is not evidence on
its own: `NODE_ENV=production` is exported in this runtime, a bare
`--frozen-lockfile` would have *removed* `typescript` and still exited 0, and the
control would then have measured a missing compiler instead of a missing
`typeRoots`. The `tsc --version` line above is what settles it.

---

## Step 1 — the gate on the intact profile → GREEN

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
```

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : dda76d863b5ee73b44b73aa313286dc98f861010
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.8dovsDqvYD

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 166s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT=0
```

**Establishes:** the baseline. 42 subjects found, 42 compiled, 0 type failures,
exit 0, and the self-test's five canaries all singing — including
`ok: typeRoots, @types paths and jsx work — the canary compiled clean`. Every
number the mutation is about to move is on the record before it moves. Wall clock
166s.

---

## Step 2 — the mutation

The `"typeRoots"` line deleted from `compilerOptions`, together with the blank
line that separated it from `allowImportingTsExtensions` — two removed lines in
the diff, one removed compiler option. The `//typeRoots` comment array at the top
level is **left in place**: the comment is the thing under test, and a control
that deletes the claim along with the line proves nothing about the claim.

```
$ git diff -- tsconfig.checks-instruments.json
diff --git a/tsconfig.checks-instruments.json b/tsconfig.checks-instruments.json
index faa14f6..a7b4e26 100644
--- a/tsconfig.checks-instruments.json
+++ b/tsconfig.checks-instruments.json
@@ -100,8 +100,6 @@
       "react-dom/server": ["./node_modules/@types/react-dom/server"]
     },
 
-    "typeRoots": ["./forge-control-web/node_modules/@types"],
-
     "allowImportingTsExtensions": true,
     "noEmit": true,
     "incremental": false
```

The file must still be valid JSON — a control that measured a parse error would
be measuring a dangling comma, not `typeRoots`:

```
$ jq -r '.compilerOptions.typeRoots' tsconfig.checks-instruments.json
null
$ echo "jq EXIT=$?"
jq EXIT=0

$ grep -n 'typeRoots' tsconfig.checks-instruments.json
34:  "//typeRoots": [
54:    "COMMENT-KEY PLACEMENT: the three //jsx, //paths and //typeRoots arrays sit",
```

`jq` prints `null`, not a parse error: the key is genuinely absent and the
document is well-formed. Line 34 confirms the comment survived the mutation.

**Establishes:** the mutation is exactly the one specified — the compiler option
gone, the claim about it intact, the file still parseable by every consumer that
reads it (`jq -r .extends` is R1's verify clause and would have broken on JSONC
line comments).

---

## Step 3 — the gate on the mutated profile → REFUSAL AT THE SELF-TEST

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
```

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : dda76d863b5ee73b44b73aa313286dc98f861010
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 6067d1e27a90c9bf6aa34cbdb3b14d5b98d4fcd07cb2b7cc403a1fbea1118182
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.LkuWDmU6iD

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
REFUSING TO RUN: the compiler self-test failed — a file that must compile clean did not (typeRoots, @types paths or jsx) (canary-clean.tsx).
  This gate will not certify anything with a compiler or a profile it
  has just watched behave wrongly. What the canary produced:
    ../../../../../tmp/tmp.LkuWDmU6iD/canary/canary-clean.tsx(5,29): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
    exit 2
  Read /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json first: its `extends`, its `strict`, its
  `skipLibCheck`, its `typeRoots`. Then check that `node` on PATH is
  a real node (/usr/bin/node). Both have produced this exact symptom
  (evidence/phase2-redteam.md, breaches B5 and B6).
EXIT=1
```

**WHICH SHAPE: the canary refusal.** Not a mass subject failure — the gate
refused at the self-test and compiled **none** of the 42 subjects. The deciding
lines, quoted from the transcript above:

```
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
REFUSING TO RUN: the compiler self-test failed — a file that must compile clean did not (typeRoots, @types paths or jsx) (canary-clean.tsx).
```

and the canary's own diagnostic, which names the exact symptom the profile's
comment predicts:

```
    ../../../../../tmp/tmp.LkuWDmU6iD/canary/canary-clean.tsx(5,29): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
    exit 2
```

Exit 1. The transcript is 34 lines against step 1's 84: there is no `TYPECHECK`
section, no `CENSUS`, no verdict line. The gate stopped at canary 3.

Three further things this transcript establishes, none of them the census:

1. **The refusal is diagnostic, not just negative.** It names the canary, prints
   the compiler's own output, and its first instruction is `Read
   …/tsconfig.checks-instruments.json first: its extends, its strict, its
   skipLibCheck, its typeRoots`. A maintainer who breaks this line and runs the
   gate is told where to look in the first screen of output.
2. **Canaries 1 and 2 still passed.** `strict` and `skipLibCheck` are unaffected
   by `typeRoots`, and the self-test discriminates between them rather than
   collapsing wholesale — which is what makes canary 3's failure informative.
3. **The profile sha256 in the provenance block moved**, `837f087c…` → `6067d1e2…`,
   so the refusing run is provably the mutated one and the green runs either side
   are provably not.

**Establishes:** the gate cannot be made to certify anything under a broken
profile — it detects the breakage in its own self-test, before the subjects, and
it says which of the profile's properties failed. The comment's *consequence for
the gate* is therefore stronger than the comment claims: not 30 red subjects, but
a gate that refuses to run at all.

---

## Step 3b — the census the comment claims, at profile level, `typeRoots` still removed

The gate refuses, so the 12/30 claim has to be re-measured with the instrument
that has no self-test to refuse at: phase 1's `reproduce-census.sh`, one `tsc`
invocation per subject through the same mutated profile. It decides nothing; it
prints a table.

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh > /tmp/p4d-census.txt 2>/tmp/p4d-census.err ; echo "EXIT=$?"
EXIT=0
```

**stdout — the census table, whole and unfiltered:**

```
check-browser-shots.ts                         rc=2   errors=2   
check-classify.ts                              rc=0   errors=0   
check-close-gate.ts                            rc=2   errors=16  
check-composer-v3.ts                           rc=2   errors=1   
check-duration.ts                              rc=2   errors=1   
check-fix-chain-graph.ts                       rc=2   errors=16  
check-gemini-tally.ts                          rc=0   errors=0   
check-nav-stack.ts                             rc=2   errors=1   
check-orientation.ts                           rc=2   errors=2   
check-plan-api.ts                              rc=0   errors=0   
check-plan-store.ts                            rc=2   errors=6   
check-project-metadata.ts                      rc=0   errors=0   
check-quota-row.ts                             rc=2   errors=4   
check-r1871-chat.ts                            rc=2   errors=1   
check-r1873-fixes.ts                           rc=2   errors=1   
check-r1875-fixes.ts                           rc=2   errors=2   
check-run-control-client.ts                    rc=2   errors=2   
check-screenshot-render-shapes.ts              rc=0   errors=0   
check-secret-events.ts                         rc=2   errors=1   
check-secret-requests.ts                       rc=2   errors=1   
check-secret-scan.ts                           rc=2   errors=6   
check-story-digest.ts                          rc=0   errors=0   
check-subagent-slice.ts                        rc=2   errors=2   
check-task-api.ts                              rc=0   errors=0   
check-team-confirm.ts                          rc=2   errors=1   
check-team-rows.ts                             rc=2   errors=1   
check-thread-mapping.ts                        rc=2   errors=2   
check-tool-summary.ts                          rc=2   errors=2   
check-typing-memo.ts                           rc=2   errors=4   
check-ui-prompt.ts                             rc=0   errors=0   
check-usage-fold.ts                            rc=0   errors=0   
check-working-sql-agreement.ts                 rc=2   errors=13  
check-working-time.ts                          rc=2   errors=1   
serve-agents-7798.ts                           rc=0   errors=0   
serve-quota-7799.ts                            rc=2   errors=4   
serve-sse-808.ts                               rc=0   errors=0   
serve-v3-7798.ts                               rc=0   errors=0   
check-chat-rich.tsx                            rc=2   errors=1   
check-dismiss-peek.tsx                         rc=2   errors=4   
check-integrations.tsx                         rc=0   errors=0   
check-settings-surface.tsx                     rc=2   errors=2   
check-stop-affordance.tsx                      rc=2   errors=1   
```

**The count, from the `rc=` column:**

```
$ awk '$2=="rc=0" {print $1}' /tmp/p4d-census.txt | wc -l
13
$ awk '$2!="rc=0" {print $1}' /tmp/p4d-census.txt | wc -l
29
```

**stderr — whole and unfiltered, 173 lines:**

```
════════ provenance
repo root : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
profile   : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
sha256    : 6067d1e27a90c9bf6aa34cbdb3b14d5b98d4fcd07cb2b7cc403a1fbea1118182
tsc       : Version 5.7.2
node      : v22.22.2
HEAD      : dda76d863b5ee73b44b73aa313286dc98f861010
branch    : project/b7ab4c57
subjects  : 42 (expected 42)
invocation: one tsc -p <generated config> per subject
════════ census
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
ABORTED at line 137 — this census is NOT a reproduction.
════════ full diagnostics — every failing subject, unfiltered (U2)
════════ check-browser-shots.ts
scripts/checks/check-browser-shots.ts(30,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-browser-shots.ts(338,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-close-gate.ts
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(75,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(76,27): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(77,28): error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(78,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(92,10): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(107,31): error TS2534: A function returning 'never' cannot have a reachable end point.
scripts/checks/check-close-gate.ts(109,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(113,16): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(190,15): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(349,14): error TS7006: Parameter 'f' implicitly has an 'any' type.
scripts/checks/check-close-gate.ts(473,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(553,7): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(557,7): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(560,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(567,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-composer-v3.ts
scripts/checks/check-composer-v3.ts(281,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-duration.ts
scripts/checks/check-duration.ts(355,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-fix-chain-graph.ts
scripts/checks/check-fix-chain-graph.ts(82,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-fix-chain-graph.ts(83,27): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-fix-chain-graph.ts(84,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-fix-chain-graph.ts(85,28): error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations.
scripts/checks/check-fix-chain-graph.ts(94,13): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(104,69): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(122,31): error TS2534: A function returning 'never' cannot have a reachable end point.
scripts/checks/check-fix-chain-graph.ts(124,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(128,16): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(211,15): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(325,14): error TS7006: Parameter 'f' implicitly has an 'any' type.
scripts/checks/check-fix-chain-graph.ts(383,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(616,7): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(620,7): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(623,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-fix-chain-graph.ts(630,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-nav-stack.ts
scripts/checks/check-nav-stack.ts(215,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-orientation.ts
scripts/checks/check-orientation.ts(33,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-orientation.ts(360,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-plan-store.ts
scripts/checks/check-plan-store.ts(59,28): error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations.
scripts/checks/check-plan-store.ts(60,30): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-plan-store.ts(61,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-plan-store.ts(62,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-plan-store.ts(63,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-plan-store.ts(778,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-quota-row.ts
scripts/checks/check-quota-row.ts(25,53): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-quota-row.ts(26,22): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-quota-row.ts(27,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-quota-row.ts(334,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-r1871-chat.ts
scripts/checks/check-r1871-chat.ts(241,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-r1873-fixes.ts
scripts/checks/check-r1873-fixes.ts(515,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-r1875-fixes.ts
scripts/checks/check-r1875-fixes.ts(24,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-r1875-fixes.ts(492,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-run-control-client.ts
scripts/checks/check-run-control-client.ts(184,9): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-run-control-client.ts(188,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-secret-events.ts
scripts/checks/check-secret-events.ts(199,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-secret-requests.ts
scripts/checks/check-secret-requests.ts(316,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-secret-scan.ts
scripts/checks/check-secret-scan.ts(34,30): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-secret-scan.ts(35,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-secret-scan.ts(36,25): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-secret-scan.ts(37,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-secret-scan.ts(67,14): error TS7006: Parameter 'f' implicitly has an 'any' type.
scripts/checks/check-secret-scan.ts(105,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-subagent-slice.ts
scripts/checks/check-subagent-slice.ts(19,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-subagent-slice.ts(468,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-team-confirm.ts
scripts/checks/check-team-confirm.ts(547,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-team-rows.ts
scripts/checks/check-team-rows.ts(625,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-thread-mapping.ts
scripts/checks/check-thread-mapping.ts(36,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-thread-mapping.ts(521,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-tool-summary.ts
scripts/checks/check-tool-summary.ts(18,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-tool-summary.ts(707,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-typing-memo.ts
scripts/checks/check-typing-memo.ts(36,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-typing-memo.ts(37,18): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-typing-memo.ts(38,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-typing-memo.ts(171,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-working-sql-agreement.ts
scripts/checks/check-working-sql-agreement.ts(48,30): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-working-sql-agreement.ts(54,22): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-working-sql-agreement.ts(60,3): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-working-sql-agreement.ts(79,49): error TS2503: Cannot find namespace 'NodeJS'.
scripts/checks/check-working-sql-agreement.ts(88,5): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-working-sql-agreement.ts(90,39): error TS2454: Variable 'dsn' is used before being assigned.
scripts/checks/check-working-sql-agreement.ts(91,14): error TS2503: Cannot find namespace 'NodeJS'.
scripts/checks/check-working-sql-agreement.ts(91,39): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-working-sql-agreement.ts(96,13): error TS2454: Variable 'dsn' is used before being assigned.
scripts/checks/check-working-sql-agreement.ts(97,13): error TS2454: Variable 'dsn' is used before being assigned.
scripts/checks/check-working-sql-agreement.ts(98,32): error TS2454: Variable 'dsn' is used before being assigned.
scripts/checks/check-working-sql-agreement.ts(99,32): error TS2454: Variable 'dsn' is used before being assigned.
scripts/checks/check-working-sql-agreement.ts(326,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-working-time.ts
scripts/checks/check-working-time.ts(371,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ serve-quota-7799.ts
scripts/checks/serve-quota-7799.ts(20,30): error TS2307: Cannot find module 'node:http' or its corresponding type declarations.
scripts/checks/serve-quota-7799.ts(22,21): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/serve-quota-7799.ts(270,15): error TS7006: Parameter 'req' implicitly has an 'any' type.
scripts/checks/serve-quota-7799.ts(270,20): error TS7006: Parameter 'res' implicitly has an 'any' type.
════════ check-chat-rich.tsx
scripts/checks/check-chat-rich.tsx(608,19): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-dismiss-peek.tsx
scripts/checks/check-dismiss-peek.tsx(47,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-dismiss-peek.tsx(48,34): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-dismiss-peek.tsx(49,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-dismiss-peek.tsx(423,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-settings-surface.tsx
forge-control-web/node_modules/.pnpm/next@15.1.3_react-dom@19.0.0_react@19.0.0__react@19.0.0_sass@1.51.0/node_modules/next/dist/client/link.d.ts(2,32): error TS2307: Cannot find module 'url' or its corresponding type declarations.
scripts/checks/check-settings-surface.tsx(225,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ check-stop-affordance.tsx
scripts/checks/check-stop-affordance.tsx(295,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
════════ summary
green 13 / red 29 / total 42
```

`Cannot find name 'process'` appears **51 times across all 29 red subjects** —
every single red subject carries at least one — and `Cannot find module 'node:…'`
a further 35 times, for 101 diagnostics in total. The sample the corpus has cited
since round 0, `check-close-gate.ts`, reproduces line for line:

```
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(92,10): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
```

### The numbers differ from the comment's, by one file — and this is a finding

| | green | red |
|---|---|---|
| the profile's comment, and `round0-probes.md` §1.2 profile F | **12** | **30** |
| `phase1-profile.md` U5a, measured 2026-08-18 pre-phase-3 | **12** | **30** |
| **this control, measured on the phase-3 tree** | **13** | **29** |

**SAY IT PLAINLY: 13 green / 29 red, not 12 green / 30 red.** The document
records what was measured. The profile and its comment were NOT edited to match —
corpus amendment is phase 5's, and a builder who "fixes" a comment to agree with
his own run has destroyed the only record of the disagreement.

The extra green is **one named file**, `serve-sse-808.ts`, established by set
difference against the twelve survivors phase 1 listed by name:

```
$ comm -13 /tmp/p4d-green-phase1.txt /tmp/p4d-green-now.txt     # green NOW, red at phase 1
serve-sse-808.ts
$ comm -23 /tmp/p4d-green-phase1.txt /tmp/p4d-green-now.txt     # green at phase 1, red NOW
(no output)
```

No file went the other way. The other twelve survivors are identical, in both
directions — so this is one file moving, not a census taken against a different
profile.

**Why it moved, measured rather than reasoned.** `serve-sse-808.ts` uses
`process.env` three times (lines 69, 84, 126), so under the comment's account it
should be red. It is green because phase 3's fix to it (commit `5823302`) changed
its two Hono specifiers from `…/hono/dist/index.js` to the package **directory**
`…/hono`, so that `tsc` resolves the package's `types` field. Those declarations
live under `forge-control/node_modules/`, which — unlike the config in
`mktemp -d` — *does* have `node_modules` ancestry, so the program pulls in
`@types/node` transitively and `process` is declared after all. Probed with
`--listFiles` while the mutation was still in place, before step 4:

```
$ tsc -p <generated cfg for serve-sse-808.ts> --listFiles | grep '^/' | grep -c '@types/node'
67
$ tsc -p <generated cfg for serve-sse-808.ts> --listFiles | grep '@types/node/index.d.ts'
/opt/ai-os/…/forge-control/node_modules/.pnpm/@types+node@22.19.21/node_modules/@types/node/index.d.ts

$ tsc -p <generated cfg for check-close-gate.ts> --listFiles | grep '^/' | grep -c '@types/node'
0
```

67 node declaration files in one program, 0 in the other, under the identical
mutated profile. That is the whole mechanism, and it sharpens the comment rather
than contradicting it: `typeRoots` is what makes `@types` discovery
*deterministic*. Without it, whether an instrument sees `process` depends on
whether something it happens to import drags `@types/node` in through a different
directory's ancestry — which is a property of that instrument's import list, not
of the gate. **12 was never a stable number; it was a headcount of which files
had not yet been repaired.** The three instruments phase 3 fixed are exactly the
population that could move it, and one of them did.

**For phase 5 (which owns corpus amendment), three locations state 12/30 and are
now one file stale:**

- `tsconfig.checks-instruments.json` lines 38–39 — and its citation
  `evidence/negative-controls.md control (d)` is wrong twice over: the file is
  `negative-controls-d.md`, and there is no `negative-controls.md`.
- `03-quality.md` §5 control (d), "Round 0 measured 12 green / 30 red" — this one
  is *correct as written*, because it attributes the number to round 0.
- `00-vision.md` line 152 and `04-phases.md` A1.5.

The honest amendment is not `13/29`. It is that the count is a function of the
tree, and what is invariant is: **every instrument that touches `process` or a
`node:` built-in without transitively importing a package that supplies
`@types/node` goes red.** 29 of 42 did here; 30 of 42 did in August.

### Incidental finding — `reproduce-census.sh` cries wolf, 29 times

The stderr above opens with 29 copies of:

```
ABORTED at line 137 — this census is NOT a reproduction.
```

One per red subject, and the census is a perfectly good reproduction that exits
0. Line 137 is `out="$("$TSC" -p "$cfg" 2>&1)"`, which sits inside `set +e`
deliberately because a red subject is the expected case. The script's
`trap … ERR` fires anyway: `set +e` disables `errexit`, it does **not** disable
the `ERR` trap. Phase 1's transcript never showed this because on the intact
profile only 6 subjects were red and phase 1 quoted stdout.

It is cosmetic — the table, the counts and the exit code are all correct — but
its text says the opposite of the truth to whoever runs it next. `reproduce-census.sh`
is phase 1's file and this control does not edit it; recorded here for phase 5.

**Establishes:** the collapse the comment describes is real and reproducible on
the current tree — 29 of 42 instruments, every one of them carrying
`Cannot find name 'process'` — and the specific figure 12/30 is one file stale
for a reason that is now understood and documented.

---

## Step 4 — revert

```
$ git checkout -- tsconfig.checks-instruments.json
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
$ sha256sum tsconfig.checks-instruments.json
837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8  tsconfig.checks-instruments.json
   expected: 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
$ jq -r '.compilerOptions.typeRoots[]' tsconfig.checks-instruments.json
./forge-control-web/node_modules/@types
$ git diff --stat -- tsconfig.checks-instruments.json
(no output — reverted)
```

The mutated file is gone and the restored sha256 is byte-identical to the one
step 1's gate printed in its own provenance block, so the restoration is proved
against the baseline rather than against a memory of it.

**Two untracked files are NOT this control's, and are disclosed rather than
tidied away:** `phase3-gate.md` and `phase3-redteam.md` were already untracked in
this shared worktree when this task began (`git status --porcelain` at task
start listed exactly those two) and belong to phase 3's concurrent tasks. Nothing
of this control's touches them and this control's commit does not include them.
Bar those two and this document, the tree is clean.

**Establishes:** no mutation was left behind. NF3.

---

## Step 5 — the gate on the restored profile → GREEN again

```
$ bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
```

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : dda76d863b5ee73b44b73aa313286dc98f861010
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.BcxV9e9Ia3

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-close-gate.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
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
  PASS scripts/checks/check-team-confirm.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-team-rows.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-thread-mapping.ts           exit 0, 0 diagnostics
  PASS scripts/checks/check-tool-summary.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-typing-memo.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-ui-prompt.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-usage-fold.ts               exit 0, 0 diagnostics
  PASS scripts/checks/check-working-sql-agreement.ts    exit 0, 0 diagnostics
  PASS scripts/checks/check-working-time.ts             exit 0, 0 diagnostics
  PASS scripts/checks/serve-agents-7798.ts              exit 0, 0 diagnostics
  PASS scripts/checks/serve-quota-7799.ts               exit 0, 0 diagnostics
  PASS scripts/checks/serve-sse-808.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/serve-v3-7798.ts                  exit 0, 0 diagnostics
  PASS scripts/checks/check-chat-rich.tsx               exit 0, 0 diagnostics
  PASS scripts/checks/check-dismiss-peek.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-integrations.tsx            exit 0, 0 diagnostics
  PASS scripts/checks/check-settings-surface.tsx        exit 0, 0 diagnostics
  PASS scripts/checks/check-stop-affordance.tsx         exit 0, 0 diagnostics

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 153s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT=0
```

And the restoration is exact rather than merely green — step 1 diffed against
step 5, whole transcripts:

```
$ diff /tmp/p4d-step1.txt /tmp/p4d-step5.txt
20c20
<   temp dir         : /tmp/tmp.8dovsDqvYD
---
>   temp dir         : /tmp/tmp.BcxV9e9Ia3
81c81
<   wall clock       : 166s
---
>   wall clock       : 153s
```

Two lines differ, and both are volatile by construction: the `mktemp -d` path and
the elapsed seconds. Every census number, every PASS line, every canary line and
both sha256 lines are identical.

**Establishes:** the tree the control was run on and the tree it was left in are
the same tree. A control that ends green-ish is a control that has quietly
changed something.

---

## Summary

| Step | What ran | Result | Exit |
|---|---|---|---|
| 1 | gate, intact profile | 42/42 green, 5 canaries ok | 0 |
| 2 | delete `"typeRoots"` from `compilerOptions` | `jq` → `null`; comment intact | — |
| 3 | gate, mutated profile | **refusal at self-test canary 3**, 0 of 42 subjects compiled | 1 |
| 3b | `reproduce-census.sh`, mutated profile | **13 green / 29 red**, 101 diagnostics, 51 × `Cannot find name 'process'` | 0 |
| 4 | `git checkout --` | sha256 back to `837f087c…` | — |
| 5 | gate, restored profile | 42/42 green; diff vs step 1 = temp dir + wall clock only | 0 |

---

## To the maintainer who is about to delete that line

You have found a `typeRoots` entry in a compile profile and it looks like
redundant belt-and-braces, because everywhere else in this repo TypeScript finds
`@types` on its own. It does — by walking up from the config file's directory to
the nearest `node_modules`. This gate does not have one. It writes a fresh
`tsconfig` into `mktemp -d` for every subject, one at a time, and `/tmp` has no
`node_modules` ancestry at all, so automatic discovery finds **nothing**: not
`@types/node`, not `@types/react`, nothing. Delete the line and here is what you
get, measured on this tree at `dda76d8` on 2026-08-18, not recalled:
`bash scripts/checks/check-instrument-typecheck.sh` stops at the third canary of
its self-test with exit 1, having compiled **0 of 42** subjects, because that
canary's one line of `process.env` no longer typechecks. Silence the canary and
run the compiler over the directory directly and you get **29 of 42 instruments
red — 101 diagnostics, 51 of them `error TS2580: Cannot find name 'process'`,
35 more `Cannot find module 'node:fs'` and its siblings** — against 42/42 green
and 0 diagnostics with the line in place. The 13 that survive are not the healthy
ones; they are the ones that either touch no node built-in or happen to import a
package whose own declarations drag `@types/node` in through a different
directory's ancestry, which is luck, not design. And the failure lies about its
cause: it looks exactly like a codebase where somebody forgot to install
`@types/node`, so the natural next move is to go and "fix" 29 instruments that
are not broken. One line, six words. Leave it.
