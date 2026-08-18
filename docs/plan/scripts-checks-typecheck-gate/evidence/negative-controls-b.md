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
