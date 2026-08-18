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
