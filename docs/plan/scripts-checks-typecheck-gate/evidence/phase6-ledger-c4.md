# Phase 6 — control C4: a duplicate ledger entry, measured before and after the fix

**Project:** `scripts-checks-typecheck-gate` · **Round label 501** · one commit
(standing rule 2, A5.3).
**Closes:** the single code blocker of the phase-5 gating review
(`evidence/phase5-gate.md` §5.5, task `88f59b03`, commit `f30dfdc`). No fix cycle
ever ran on that verdict, so the hole was still live in the gate at `HEAD` when
this task started — reproduced below on this tree, not quoted from the review.

This file is the fourth member of the ledger-control set. Controls (a), (b) and
(c) live in `phase5-ledger.md` §2; **C4 is here** because it was written by the
reviewer rather than by the phase it tests, and because its *before* transcript
is a recording of the gate lying. C5 is here too: it is the control for the
defence-in-depth layer this fix added underneath C4's.

---

## 1. The blocker, by symbol

`scripts/checks/check-instrument-typecheck.sh`, at `f30dfdc`:

* **Step 8's parser** (the `ledger_error` call sites) enforced four conditions —
  a missing field, a `path` field disagreeing with the bare path, a path not on
  disk, and a path not among `SUBJECTS`. **There was no uniqueness condition.**
* **Step 11's reconciliation** iterates `WAIVER_PATHS` and, for every valid entry
  whose `SUBJECT_OUTCOME[$w_path]` is `fail`, runs `FAILED=$((FAILED - 1))`.
  `SUBJECT_OUTCOME` is keyed by path and is never consumed or cleared.

Therefore **N ledger entries naming ONE failing path decrement `FAILED` N times**,
and every decrement past the first cancels the failure of a subject nobody waived.
The verdict predicate is `[ "$FAILED" -eq 0 ] && …`, so with two broken subjects
and one of them waived twice, the gate satisfies it.

**The fix, as the reviewer prescribed it and as it is implemented:** a fifth
`ledger_error` in step 8 — a `path` already present in `WAIVER_PATHS` is a
duplicate entry and a **hard ledger error, naming both line numbers**. Not a skip
in step 11: a silent skip repairs the arithmetic while leaving the author
believing the ledger says what they wrote, which is the exact shape this design
forbids.

**Added beyond the prescription (defence in depth, §4):** step 11 now also
refuses to certify if it would discount the same path twice, or if
`FAILED + WAIVED` stops equalling the count the compile loop observed. Both are
**loud** — a printed refusal naming the entry and `exit 1` — never a silent skip
and never a clamp.

### 1.1 The prescription was MEASURED before it was copied

The reviewer's fix is *"increment `LEDGER_ERRORS`"*. That is only a fix if a
`LEDGER_ERRORS` increment is actually fatal, so the verdict predicate was read
and then measured rather than assumed.

Read — `check-instrument-typecheck.sh` step 14:

```bash
if [ "$FAILED" -eq 0 ] && [ "$FIDELITY" -eq 0 ] && [ "$MISSING" -eq 0 ] \
   && [ "$CENSUS_MISMATCH" -eq 0 ] && [ "$UNCOVERED_COUNT" -eq 0 ] && [ "$SUPPRESSED" -eq 0 ] \
   && [ "$LEDGER_ERRORS" -eq 0 ] && [ "$WAIVED_CLEAN" -eq 0 ]; then
```

Measured — §5's re-run of control (b) isolates it: a missing-field entry on a
subject that **compiles clean**, so `FAILED` is 0 and `LEDGER_ERRORS` is the only
non-zero counter:

```
check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
EXIT=1
```

**A `LEDGER_ERRORS` increment alone produces a non-`PASSED` verdict and exit 1.**
The prescription holds; there is no second finding.

---

## 2. C4 BEFORE the fix — `PASSED`, exit 0, over an unexcused TS2322

The fix was `git stash`ed so the gate on disk is byte-for-byte `HEAD`'s
(`md5sum` of the file and of `git show HEAD:…` are compared in the transcript).
The mutation is the reviewer's, verbatim: break **two** subjects, and waive
**one** of them **twice** with two complete, valid, four-field entries.

**Verdict: `PASSED`, `EXIT=0`, `type failures 0` — while
`scripts/checks/check-plan-api.ts`'s type error is printed eight lines above the
census and is waived by nobody.** The hole was real on this tree, at this HEAD,
today.

```
########## C4 — BEFORE THE FIX (gate at HEAD f30dfdc) ##########
$ git stash push -- scripts/checks/check-instrument-typecheck.sh
Saved working directory and index state WIP on project/b7ab4c57: f30dfdc review(scripts-checks-typecheck-gate/round 1, phase 5 GATE): NEEDS_FIXES — a duplicate ledger entry launders another file's failure into a PASS
$ git rev-parse HEAD
f30dfdcefcc87073187a4567eedaa790d8ecf81b
$ git status --porcelain
[end of git status]
$ md5sum scripts/checks/check-instrument-typecheck.sh  # == HEAD blob
6a409ab74688f779533009516633c146  scripts/checks/check-instrument-typecheck.sh
6a409ab74688f779533009516633c146  -

$ bash /tmp/c4-mutate.sh   # break two subjects, waive ONE of them TWICE
$ git diff --stat
 scripts/checks/check-close-gate.ts     |  2 ++
 scripts/checks/check-plan-api.ts       |  2 ++
 scripts/checks/instrument-manifest.txt | 12 ++++++++++++
 3 files changed, 16 insertions(+)
$ grep -n 'check-close-gate.ts$' scripts/checks/instrument-manifest.txt   # the two bare-path lines
160:# path        : scripts/checks/check-close-gate.ts
164:scripts/checks/check-close-gate.ts
166:# path        : scripts/checks/check-close-gate.ts
170:scripts/checks/check-close-gate.ts

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.G2Ui0Lrioz

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  FAIL scripts/checks/check-close-gate.ts               exit 2
         scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
  FAIL scripts/checks/check-plan-api.ts                 exit 2
         scripts/checks/check-plan-api.ts(1193,14): error TS2322: Type 'string' is not assignable to type 'number'.
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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 2 entry/entries, 0 error(s), 2 waived, 0 waived but clean
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 164)
    recorded diagnostic : TS2322 — reviewer control C4, entry 1 of 2 (same path twice)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
    reason              : reviewer round-500 control C4 — duplicate-entry probe
    owner               : reviewer, round 500 gating review
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 170)
    recorded diagnostic : TS2322 — reviewer control C4, entry 2 of 2 (same path twice)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
    reason              : reviewer round-500 control C4 — duplicate-entry probe
    owner               : reviewer, round 500 gating review

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 139s

check-instrument-typecheck.sh PASSED — 40/42 subjects compiled clean, 2 WAIVED (named in the WAIVERS block above).
EXIT=0
$ git checkout -- scripts/checks/instrument-manifest.txt scripts/checks/check-close-gate.ts scripts/checks/check-plan-api.ts
$ git status --porcelain
[end — the stash is still popped-out, so this must be empty]
$ git stash pop
On branch project/b7ab4c57
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   scripts/checks/check-instrument-typecheck.sh

no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (39cfaa5a0f140ddc88898f1639d70676519a870f)
$ git status --porcelain
 M scripts/checks/check-instrument-typecheck.sh
$ md5sum scripts/checks/check-instrument-typecheck.sh /tmp/c4-fixed-gate.sh
3649e64f0fb423f8f31f333953897ba1  scripts/checks/check-instrument-typecheck.sh
3649e64f0fb423f8f31f333953897ba1  /tmp/c4-fixed-gate.sh
```

Note the two `WAIVED` lines: both name `check-close-gate.ts`, both quote the same
observed diagnostic, both were counted. `40/42 subjects compiled clean, 2 WAIVED`
is arithmetic no compilation produced — 41 compiled clean and 1 was waived.

---

## 3. C4 AFTER the fix — `LEDGER ERROR` naming both lines, exit 1

The stash was popped (`md5sum` proof in §6), the identical mutation re-applied by
the identical script, and the gate re-run on the identical tree.

**Verdict: `FAILED`, `EXIT=1`, `1 type failure(s), 1 ledger error(s)`.** The
duplicate is `INVALID … excuses nothing`, the ledger error names **both line 164
and line 170**, and `check-plan-api.ts`'s failure survives into the census as the
one type failure it always was.

```
########## C4 — AFTER THE FIX (same mutation, same tree) ##########
$ bash /tmp/c4-mutate.sh
$ git diff --stat
 scripts/checks/check-close-gate.ts           |   2 +
 scripts/checks/check-instrument-typecheck.sh | 108 +++++++++++++++++++++++++--
 scripts/checks/check-plan-api.ts             |   2 +
 scripts/checks/instrument-manifest.txt       |  12 +++
 4 files changed, 116 insertions(+), 8 deletions(-)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: f195417ce242b4acf0071788b4c331acbb2a209f5a2e5b341d6d74840cdfd0c4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.ZcPkc1lqrz

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  FAIL scripts/checks/check-close-gate.ts               exit 2
         scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
  FAIL scripts/checks/check-plan-api.ts                 exit 2
         scripts/checks/check-plan-api.ts(1193,14): error TS2322: Type 'string' is not assignable to type 'number'.
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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 2 entry/entries, 1 error(s), 1 waived, 0 waived but clean
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 164)
    recorded diagnostic : TS2322 — reviewer control C4, entry 1 of 2 (same path twice)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
    reason              : reviewer round-500 control C4 — duplicate-entry probe
    owner               : reviewer, round 500 gating review
  INVALID scripts/checks/check-close-gate.ts (ledger line 170) — excuses nothing; see the LEDGER ERROR line(s) below.
  LEDGER ERROR at line 170: the path 'scripts/checks/check-close-gate.ts' is ALREADY WAIVED at line 164. One subject, one waiver: a second entry for the same path excuses a failure it does not own — step 11 discounts one failure per valid entry, so a duplicate discounts ANOTHER subject's failure and can turn this run green over a type error nobody waived. Delete one of the two entries (lines 164 and 170); if the two record different diagnostics, the surviving entry's `diagnostic` field must name them both.
  This run FAILS because of the line(s) above. Adding a path to the ledger
  EXCUSES a failure; it never obtains coverage — coverage is by glob and is
  automatic. Read scripts/checks/instrument-manifest.txt's header for the
  four required fields.

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 139s

check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
EXIT=1
```

---

## 4. C5 — the second layer, reached by deleting the first

Step 11's duplicate refusal is unreachable while step 8 rejects duplicates, which
is the point: it is the guard against the *edit that removes step 8's condition*.
An unreachable guard nobody has ever seen fire is a guard nobody knows is broken,
so it was reached deliberately — by deleting step 8's uniqueness block from the
working tree and re-running the same C4 mutation.

The block that was removed for this control (and restored immediately after,
`md5sum` in §6):

```bash
  # THE UNIQUENESS CONDITION (round 501, phase 6; the phase-5 gating review's
  # control C4). Step 11 decrements `FAILED` once per VALID entry naming a
  # failing subject, and `SUBJECT_OUTCOME` is keyed by path and never consumed,
  # so N entries naming ONE failing path decrement `FAILED` N times — and the
  # surplus decrements cancel the failures of subjects NOBODY waived. Measured
  # at f30dfdc: two broken subjects, one of them waived twice with two valid
  # four-field entries, and the gate printed both failures, `type failures 0`,
  # `PASSED`, exit 0. That is the failure-into-pass path this whole design
  # exists to make impossible, so the SECOND entry is a HARD ledger error
  # naming BOTH lines, not a skip: a skip would silently repair a ledger the
  # author still believes says what they wrote.
  ledger_dup_line=""
  ledger_dup_index=0
  while [ "$ledger_dup_index" -lt "${#WAIVER_PATHS[@]}" ]; do
    if [ "${WAIVER_PATHS[$ledger_dup_index]}" = "$ledger_entry" ]; then
      ledger_dup_line="${WAIVER_LINENO[$ledger_dup_index]}"
      break
    fi
    ledger_dup_index=$((ledger_dup_index + 1))
  done
  if [ -n "$ledger_dup_line" ]; then
    ledger_valid=0
    ledger_error "at line $ledger_lineno: the path '$ledger_entry' is ALREADY WAIVED at line $ledger_dup_line. One subject, one waiver: a second entry for the same path excuses a failure it does not own — step 11 discounts one failure per valid entry, so a duplicate discounts ANOTHER subject's failure and can turn this run green over a type error nobody waived. Delete one of the two entries (lines $ledger_dup_line and $ledger_lineno); if the two record different diagnostics, the surviving entry's \`diagnostic\` field must name them both."
  fi
```

**Verdict: `REFUSING TO CERTIFY`, `EXIT=1`, and no verdict line at all** — the run
does not print `PASSED` or `FAILED`, because a gate whose two steps disagree about
what a valid waiver is has no verdict to issue.

```
########## C5 — the SECOND LAYER, reached by neutering step 8 ##########
$ git diff --stat scripts/checks/check-instrument-typecheck.sh   # vs the fixed tree: the step-8 block deleted
1039,1063d1038
<   # THE UNIQUENESS CONDITION (round 501, phase 6; the phase-5 gating review's
<   # control C4). Step 11 decrements `FAILED` once per VALID entry naming a
<   # failing subject, and `SUBJECT_OUTCOME` is keyed by path and never consumed,
<   # so N entries naming ONE failing path decrement `FAILED` N times — and the
<   # surplus decrements cancel the failures of subjects NOBODY waived. Measured
<   # at f30dfdc: two broken subjects, one of them waived twice with two valid
<   # four-field entries, and the gate printed both failures, `type failures 0`,
<   # `PASSED`, exit 0. That is the failure-into-pass path this whole design
<   # exists to make impossible, so the SECOND entry is a HARD ledger error
<   # naming BOTH lines, not a skip: a skip would silently repair a ledger the
<   # author still believes says what they wrote.
<   ledger_dup_line=""
<   ledger_dup_index=0
<   while [ "$ledger_dup_index" -lt "${#WAIVER_PATHS[@]}" ]; do
<     if [ "${WAIVER_PATHS[$ledger_dup_index]}" = "$ledger_entry" ]; then
<       ledger_dup_line="${WAIVER_LINENO[$ledger_dup_index]}"
<       break
<     fi
<     ledger_dup_index=$((ledger_dup_index + 1))
<   done
<   if [ -n "$ledger_dup_line" ]; then
<     ledger_valid=0
<     ledger_error "at line $ledger_lineno: the path '$ledger_entry' is ALREADY WAIVED at line $ledger_dup_line. One subject, one waiver: a second entry for the same path excuses a failure it does not own — step 11 discounts one failure per valid entry, so a duplicate discounts ANOTHER subject's failure and can turn this run green over a type error nobody waived. Delete one of the two entries (lines $ledger_dup_line and $ledger_lineno); if the two record different diagnostics, the surviving entry's \`diagnostic\` field must name them both."
<   fi
< 
$ bash -n scripts/checks/check-instrument-typecheck.sh
syntax OK

$ bash scripts/checks/check-instrument-typecheck.sh   # SAME C4 mutation still applied
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 84ecea05db6fa0a53089df624924a8d24e14c4167965890cb6a8bb846aa07a41
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.VTS3kI3Ud4

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  PASS scripts/checks/check-browser-shots.ts            exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  FAIL scripts/checks/check-close-gate.ts               exit 2
         scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-composer-v3.ts              exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-fix-chain-graph.ts          exit 0, 0 diagnostics
  PASS scripts/checks/check-gemini-tally.ts             exit 0, 0 diagnostics
  PASS scripts/checks/check-nav-stack.ts                exit 0, 0 diagnostics
  PASS scripts/checks/check-orientation.ts              exit 0, 0 diagnostics
  FAIL scripts/checks/check-plan-api.ts                 exit 2
         scripts/checks/check-plan-api.ts(1193,14): error TS2322: Type 'string' is not assignable to type 'number'.
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

REFUSING TO CERTIFY: waiver 'scripts/checks/check-close-gate.ts' (ledger line 170) would discount
  a failure this run has ALREADY discounted for the same path. One subject,
  one waiver: a second discount cancels a failure belonging to a subject
  nobody waived, which is how a ledger turns a type error into a PASS.
  Step 8's duplicate-path check should have made this entry INVALID before
  step 11 ever saw it; that it did not means the two steps disagree about
  what a valid waiver is, and this gate will not issue a verdict on that.
EXIT=1
```

The third guard added in the same commit — the arithmetic identity
`FAILED + WAIVED == FAILED_OBSERVED`, checked after the reconciliation loop — is
not separately controlled here because C5's refusal fires first on this mutation.
It is a backstop for a *different* future edit: one that decrements `FAILED`
somewhere else in step 11. It cannot fire on a correct run by construction (the
only `FAILED` decrement in the file is the one guarded above, and it increments
`WAIVED` in the same breath), and §7's clean run measures that it does not.

---

## 5. The three existing ledger controls, re-run unchanged

A new parse condition inserted between the field checks and the on-disk check is
exactly the kind of edit that breaks its neighbours. All three controls from
`phase5-ledger.md` §2.1–§2.3 were re-run against the **fixed** gate, verbatim,
each applied → run → restored → `cmp`-proven byte-for-byte.

| Control | Expected | Measured at round 501 |
|---|---|---|
| (a) waived but clean (§2.1) | `1 waived but clean`, exit 1 | `WAIVED BUT CLEAN scripts/checks/check-close-gate.ts (ledger line 164)`, `0 ledger error(s), 1 waived but clean`, EXIT=1 |
| (b) a missing field (§2.2) | `1 ledger error(s)`, exit 1 | `missing required field(s): reason`, `INVALID … excuses nothing`, `1 ledger error(s)`, EXIT=1 |
| (c) waived path not on disk (§2.3) | `NOT ON DISK`, exit 1 | `the waived path 'scripts/checks/does-not-exist.ts' is NOT ON DISK`, `1 ledger error(s)`, EXIT=1 |

Unchanged in every respect that matters: same messages, same counters, same exit
codes, and in (c) the *not-among-the-subjects* check still does **not** also fire —
an absent path is still reported once, as absent. The new condition fires on none
of them, because none of them names a path twice.

### 5.1 Re-run of control (a) — WAIVED BUT CLEAN

```
########## RE-RUN of CONTROL (a) — WAIVED BUT CLEAN (phase5-ledger.md §2.1) ##########
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
# path        : scripts/checks/check-close-gate.ts
# diagnostic  : TS2322 at line 571 — Type 'string' is not assignable to type 'number'.
# reason      : transient negative control (a) for round 500 evidence; reverted in the same script that added it
# owner       : round 500, phase 5 — this control
scripts/checks/check-close-gate.ts
EOF
$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 6 ++++++
 1 file changed, 6 insertions(+)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: f195417ce242b4acf0071788b4c331acbb2a209f5a2e5b341d6d74840cdfd0c4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.Fe0rS2wjDk

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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 1 entry/entries, 0 error(s), 0 waived, 1 waived but clean
  WAIVED BUT CLEAN scripts/checks/check-close-gate.ts (ledger line 164) — waived but clean: this subject
    compiled with ZERO diagnostics, so its waiver is stale and this run FAILS.
    recorded diagnostic : TS2322 at line 571 — Type 'string' is not assignable to type 'number'.
    observed diagnostic : (none — the file compiles)
    owner               : round 500, phase 5 — this control
    Delete the entry. An excuse that outlives its error tells every later
    reader the file is still broken.
  This run FAILS because of the line(s) above. Adding a path to the ledger
  EXCUSES a failure; it never obtains coverage — coverage is by glob and is
  automatic. Read scripts/checks/instrument-manifest.txt's header for the
  four required fields.

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 140s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 0 ledger error(s), 1 waived but clean, census mismatch 0.
EXIT=1
$ cp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt && cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt
ledger restored byte-for-byte
$ git status --porcelain
 M scripts/checks/check-instrument-typecheck.sh
```

### 5.2 Re-run of control (b) — A MISSING FIELD

```
########## RE-RUN of CONTROL (b) — A MISSING FIELD (phase5-ledger.md §2.2) ##########
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
# path        : scripts/checks/check-plan-api.ts
# diagnostic  : TS2345 at line 12 — transient negative control (b)
# owner       : round 500, phase 5 — this control
scripts/checks/check-plan-api.ts
EOF
$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 5 +++++
 1 file changed, 5 insertions(+)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: f195417ce242b4acf0071788b4c331acbb2a209f5a2e5b341d6d74840cdfd0c4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.XnHDpdOean

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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 1 entry/entries, 1 error(s), 0 waived, 0 waived but clean
  INVALID scripts/checks/check-plan-api.ts (ledger line 163) — excuses nothing; see the LEDGER ERROR line(s) below.
  LEDGER ERROR at line 163: the entry 'scripts/checks/check-plan-api.ts' is missing required field(s): reason. All four of path/diagnostic/owner/reason are required by 02-architecture.md §4.6, and an entry without them excuses NOTHING — this run still counts its subject's failures.
  This run FAILS because of the line(s) above. Adding a path to the ledger
  EXCUSES a failure; it never obtains coverage — coverage is by glob and is
  automatic. Read scripts/checks/instrument-manifest.txt's header for the
  four required fields.

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 139s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
EXIT=1
$ cp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt && cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt
ledger restored byte-for-byte
$ git status --porcelain
 M scripts/checks/check-instrument-typecheck.sh
```

### 5.3 Re-run of control (c) — A WAIVED PATH NOT ON DISK

```
########## RE-RUN of CONTROL (c) — A WAIVED PATH NOT ON DISK (phase5-ledger.md §2.3) ##########
$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 6 ++++++
 1 file changed, 6 insertions(+)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: f195417ce242b4acf0071788b4c331acbb2a209f5a2e5b341d6d74840cdfd0c4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.rNLru4JUxs

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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 1 entry/entries, 1 error(s), 0 waived, 0 waived but clean
  INVALID scripts/checks/does-not-exist.ts (ledger line 164) — excuses nothing; see the LEDGER ERROR line(s) below.
  LEDGER ERROR at line 164: the waived path 'scripts/checks/does-not-exist.ts' is NOT ON DISK. A waiver for a file that is gone is stale by definition — delete the entry.
  This run FAILS because of the line(s) above. Adding a path to the ledger
  EXCUSES a failure; it never obtains coverage — coverage is by glob and is
  automatic. Read scripts/checks/instrument-manifest.txt's header for the
  four required fields.

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 139s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
EXIT=1
$ cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt
ledger restored byte-for-byte
$ git status --porcelain
 M scripts/checks/check-instrument-typecheck.sh
```

---

## 6. The revert proof

All four mutated artefacts — `check-close-gate.ts`, `check-plan-api.ts`,
`instrument-manifest.txt` and (for C5) the gate script itself — were restored, and
the restoration proven rather than assumed.

```
########## C4/C5 REVERT ##########
$ git checkout -- scripts/checks/instrument-manifest.txt scripts/checks/check-close-gate.ts scripts/checks/check-plan-api.ts
$ git status --porcelain
 M scripts/checks/check-instrument-typecheck.sh
[end — only the gate script, which is this task's fix]
$ git rev-parse HEAD
f30dfdcefcc87073187a4567eedaa790d8ecf81b
```

The gate script's restoration after C5 was proven by hash against the copy taken
before the first stash:

```
$ cp /tmp/c4-fixed-gate.sh scripts/checks/check-instrument-typecheck.sh
$ md5sum scripts/checks/check-instrument-typecheck.sh /tmp/c4-fixed-gate.sh
3649e64f0fb423f8f31f333953897ba1  scripts/checks/check-instrument-typecheck.sh
3649e64f0fb423f8f31f333953897ba1  /tmp/c4-fixed-gate.sh
```

and the same hash was printed after the `git stash pop` that ended §2, so the
file that ran §3, §5 and §7 is the same file that is committed.

The ledger was restored from `/tmp/ledger-pristine.txt` and `cmp`-proven byte-for-
byte after each of the three re-runs in §5 (visible in each transcript above).

**`HEAD` did not move at any point:** `f30dfdcefcc87073187a4567eedaa790d8ecf81b`
before the controls and after them. **`git status --porcelain` after the reverts
contains only this task's own write-set** — never a subject, never the ledger's
control entries, never a temp file.

---

## 7. The clean run — the gate is green on the pristine tree

The fixed gate, the empty ledger, no mutation. This is also the confirmation the
brief required that **the new condition does not fire on the manifest header's
own indented format example**: the header's five example lines all begin with
`#` followed by more than one space, so the bare-path line is prose and the field
lines are prose, and the ledger parses as `0 entry/entries, 0 error(s)`.

```
########## THE CLEAN RUN — fixed gate, final tree, AMENDED manifest header ##########
$ git status --porcelain   # this task's six declared paths, nothing else
 M docs/plan/engine-task-graph/03-quality.md
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md
 M scripts/checks/check-instrument-typecheck.sh
 M scripts/checks/instrument-manifest.txt
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase6-ledger-c4.md
$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : f30dfdcefcc87073187a4567eedaa790d8ecf81b
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: f195417ce242b4acf0071788b4c331acbb2a209f5a2e5b341d6d74840cdfd0c4
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.UBYTHmMKAP

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

WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 0 entry/entries, 0 error(s), 0 waived, 0 waived but clean
  ok: 0 waivers — the ledger is empty
  Every subject above was compiled and none was excused. An empty ledger is
  this project's target state, not an oversight: the file exists so that the
  NEXT exclusion has somewhere loud to live instead of becoming an --exclude
  flag nobody prints.

SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error

PROFILE FIDELITY — every diagnostic must be located under scripts/checks/
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 139s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT=0
```

`42/42 subjects compiled clean`, `ok: 0 waivers — the ledger is empty`, EXIT=0 —
byte-identical in every counter to the phase-5 baseline. The fix is a no-op on a
tree with no duplicate.

---

## 8. The diff of the change to the gate

```diff
diff --git a/scripts/checks/check-instrument-typecheck.sh b/scripts/checks/check-instrument-typecheck.sh
index 23259d0..d6c537a 100755
--- a/scripts/checks/check-instrument-typecheck.sh
+++ b/scripts/checks/check-instrument-typecheck.sh
@@ -252,11 +252,13 @@
 #       IMPLEMENTED HERE SINCE ROUND 500, in the two steps the round-200 hooks
 #       reserved. What closes it: a waived subject that compiles CLEAN fails
 #       the run with the words "waived but clean", naming the path, so an
-#       excuse cannot outlive the error it excuses. Three further failures
+#       excuse cannot outlive the error it excuses. Four further failures
 #       close the neighbouring holes — a waived path that is not on disk, a
-#       waived path this gate does not compile at all, and an entry missing any
-#       of the four required fields — because a waiver that names nothing, or
-#       justifies nothing, is an exclusion wearing a ledger's clothes. And the
+#       waived path this gate does not compile at all, an entry missing any of
+#       the four required fields, and (round 501) a path waived TWICE — because
+#       a waiver that names nothing, or justifies nothing, is an exclusion
+#       wearing a ledger's clothes, and a waiver counted twice excuses a
+#       failure it does not own. And the
 #       ledger cannot hide: every entry is printed above the verdict on every
 #       run, and an EMPTY ledger prints that it is empty rather than printing
 #       nothing. The ledger never removes a subject from the compile loop; it
@@ -276,14 +278,22 @@
 #         The last two arrived at round 500 with the waiver ledger (R14):
 #           ledger errors     — an entry missing one of its four required
 #                               fields, a field block with no path, a waived
-#                               path absent from disk, or a waived path this
-#                               gate does not compile. Each is named with the
-#                               line number in the ledger.
+#                               path absent from disk, a waived path this gate
+#                               does not compile, or a path waived TWICE. Each
+#                               is named with the line number in the ledger;
+#                               the duplicate names both of them.
 #           waived but clean  — a waived subject that compiled with zero
 #                               diagnostics. The excuse outlived the error.
 #         Neither can turn a failure into a pass: a waiver reclassifies an
 #         observed FAIL into an excused WAIVED and changes nothing else, and an
 #         INVALID entry excuses nothing at all.
+#         THAT SENTENCE WAS FALSE UNTIL ROUND 501 and is now enforced twice.
+#         A path waived twice discounted TWO failures — the second one belonging
+#         to a subject nobody waived — and the gate said PASSED, exit 0, over an
+#         unexcused TS2322 (measured at f30dfdc; `evidence/phase6-ledger-c4.md`).
+#         The duplicate is now a hard ledger error at step 8, and step 11 refuses
+#         to issue any verdict if it discounts one path twice or if FAILED and
+#         WAIVED stop summing to what the compile loop observed.
 #
 # `-E` (errtrace) is new at round 2 and is not decoration: an ERR trap is NOT
 # inherited by shell functions, command substitutions or subshells without it.
@@ -908,7 +918,13 @@ echo
 #        that is gone is stale by definition;
 #      * a waived path that is not among the enumerated SUBJECTS is an ERROR:
 #        a waiver must name something this gate actually compiles, or it is
-#        excusing nothing and hiding that fact.
+#        excusing nothing and hiding that fact;
+#      * a path named by MORE THAN ONE entry is an ERROR on the second entry
+#        and every later one, naming both lines. One subject, one waiver:
+#        step 11 discounts one failure per valid entry, so a duplicate
+#        discounts a failure it does not own and launders another subject's
+#        type error into a pass (round 501; the gating review's control C4,
+#        `evidence/phase6-ledger-c4.md`).
 #
 #    "One space after the `#`" is why the ledger's own header indents its
 #    format example: an example written in live shape would be parsed as a live
@@ -1020,6 +1036,31 @@ while IFS= read -r ledger_line || [ -n "$ledger_line" ]; do
     ledger_error "at line $ledger_lineno: the entry's \`path\` field says '$pend_path' but the bare path says '$ledger_entry'. The two must agree; this gate matches on the bare path and will not guess which one was meant."
   fi
 
+  # THE UNIQUENESS CONDITION (round 501, phase 6; the phase-5 gating review's
+  # control C4). Step 11 decrements `FAILED` once per VALID entry naming a
+  # failing subject, and `SUBJECT_OUTCOME` is keyed by path and never consumed,
+  # so N entries naming ONE failing path decrement `FAILED` N times — and the
+  # surplus decrements cancel the failures of subjects NOBODY waived. Measured
+  # at f30dfdc: two broken subjects, one of them waived twice with two valid
+  # four-field entries, and the gate printed both failures, `type failures 0`,
+  # `PASSED`, exit 0. That is the failure-into-pass path this whole design
+  # exists to make impossible, so the SECOND entry is a HARD ledger error
+  # naming BOTH lines, not a skip: a skip would silently repair a ledger the
+  # author still believes says what they wrote.
+  ledger_dup_line=""
+  ledger_dup_index=0
+  while [ "$ledger_dup_index" -lt "${#WAIVER_PATHS[@]}" ]; do
+    if [ "${WAIVER_PATHS[$ledger_dup_index]}" = "$ledger_entry" ]; then
+      ledger_dup_line="${WAIVER_LINENO[$ledger_dup_index]}"
+      break
+    fi
+    ledger_dup_index=$((ledger_dup_index + 1))
+  done
+  if [ -n "$ledger_dup_line" ]; then
+    ledger_valid=0
+    ledger_error "at line $ledger_lineno: the path '$ledger_entry' is ALREADY WAIVED at line $ledger_dup_line. One subject, one waiver: a second entry for the same path excuses a failure it does not own — step 11 discounts one failure per valid entry, so a duplicate discounts ANOTHER subject's failure and can turn this run green over a type error nobody waived. Delete one of the two entries (lines $ledger_dup_line and $ledger_lineno); if the two record different diagnostics, the surviving entry's \`diagnostic\` field must name them both."
+  fi
+
   if [ ! -f "$REPO_ROOT/$ledger_entry" ]; then
     ledger_valid=0
     ledger_error "at line $ledger_lineno: the waived path '$ledger_entry' is NOT ON DISK. A waiver for a file that is gone is stale by definition — delete the entry."
@@ -1047,6 +1088,7 @@ done < "$LEDGER"
 ledger_flush_dangling
 unset ledger_line ledger_field ledger_value ledger_entry ledger_missing
 unset ledger_valid ledger_in_subjects ledger_subject
+unset ledger_dup_line ledger_dup_index
 WAIVER_COUNT=${#WAIVER_PATHS[@]}
 
 # ---------------------------------------------------------------------------
@@ -1583,6 +1625,18 @@ echo
 #     run — because a waiver written for a different error is a waiver nobody
 #     re-read.
 #
+#     "BY ONE" IS ENFORCED HERE, NOT ASSUMED (round 501). Until then this
+#     sentence was FALSE: `SUBJECT_OUTCOME` is keyed by path and is never
+#     consumed, so two entries naming one failing path took `FAILED` down by
+#     TWO and the surplus cancelled a failure belonging to a subject nobody
+#     waived (measured at f30dfdc: `PASSED`, exit 0, `type failures 0`, over an
+#     unexcused TS2322). Step 8 now refuses a duplicate path as a hard ledger
+#     error, and the SECOND LAYER below refuses to issue a verdict if this loop
+#     ever discounts a path twice or if `FAILED` and `WAIVED` stop adding up to
+#     what the compile loop observed. Both layers are LOUD — a printed refusal
+#     and a non-zero exit. Neither is a skip: an entry quietly ignored is a
+#     ledger the author still believes says what they wrote.
+#
 #     WHAT A WAIVER CANNOT DO:
 #       * excuse a subject that compiled CLEAN. That is a FAILURE, in the exact
 #         words "waived but clean", naming the path. Stale waivers are how an
@@ -1604,6 +1658,14 @@ WAIVED=0
 WAIVED_CLEAN=0
 WAIVER_REPORT=""
 
+# The compile loop's OWN count, taken before any waiver acts on it, and the set
+# of paths this loop has already discounted. Together they are the second layer
+# described above: `FAILED` may only ever walk down from FAILED_OBSERVED, once
+# per path, and any other arithmetic is an internal inconsistency this gate
+# refuses to certify around.
+FAILED_OBSERVED="$FAILED"
+declare -A WAIVER_DISCOUNTED=()
+
 waiver_index=0
 while [ "$waiver_index" -lt "$WAIVER_COUNT" ]; do
   w_path="${WAIVER_PATHS[$waiver_index]}"
@@ -1623,6 +1685,22 @@ while [ "$waiver_index" -lt "$WAIVER_COUNT" ]; do
 
   case "$w_outcome" in
     fail)
+      # SECOND LAYER, and it is a refusal rather than a skip. Step 8 already
+      # made a duplicate path a ledger error and therefore INVALID, so this
+      # branch is unreachable today — exactly like the `*)` below, and kept for
+      # the same reason: the edit that removes step 8's uniqueness condition
+      # must not be able to restore the laundering path in silence.
+      if [ -n "${WAIVER_DISCOUNTED[$w_path]:-}" ]; then
+        echo "REFUSING TO CERTIFY: waiver '$w_path' (ledger line $w_line) would discount" >&2
+        echo "  a failure this run has ALREADY discounted for the same path. One subject," >&2
+        echo "  one waiver: a second discount cancels a failure belonging to a subject" >&2
+        echo "  nobody waived, which is how a ledger turns a type error into a PASS." >&2
+        echo "  Step 8's duplicate-path check should have made this entry INVALID before" >&2
+        echo "  step 11 ever saw it; that it did not means the two steps disagree about" >&2
+        echo "  what a valid waiver is, and this gate will not issue a verdict on that." >&2
+        exit 1
+      fi
+      WAIVER_DISCOUNTED[$w_path]=1
       FAILED=$((FAILED - 1))
       WAIVED=$((WAIVED + 1))
       WAIVER_REPORT+="  WAIVED  $w_path (ledger line $w_line)"$'\n'
@@ -1660,6 +1738,20 @@ while [ "$waiver_index" -lt "$WAIVER_COUNT" ]; do
 done
 unset waiver_index w_path w_line w_valid w_diag w_reason w_owner w_outcome w_observed
 
+# THE ARITHMETIC IDENTITY, asserted rather than trusted: every valid waiver on a
+# failing subject moved exactly one count from FAILED to WAIVED and nothing else
+# in this step touches either, so FAILED + WAIVED must still equal what the
+# compile loop counted. A future edit that decrements FAILED anywhere else in
+# step 11 — or twice — lands here instead of in a verdict.
+if [ "$(( FAILED + WAIVED ))" -ne "$FAILED_OBSERVED" ] || [ "$FAILED" -lt 0 ]; then
+  printf 'REFUSING TO CERTIFY: waiver reconciliation does not add up. The compile loop observed %d type failure(s); after reconciliation FAILED=%d and WAIVED=%d, which is %d.\n' \
+    "$FAILED_OBSERVED" "$FAILED" "$WAIVED" "$(( FAILED + WAIVED ))" >&2
+  echo "  A waiver may only move ONE observed failure into the excused column, and" >&2
+  echo "  only for its own path. Any other arithmetic means this run's verdict is" >&2
+  echo "  computed from a count no compilation produced, so no verdict is issued." >&2
+  exit 1
+fi
+
 echo "WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)"
 printf '  ledger: %s — %d entry/entries, %d error(s), %d waived, %d waived but clean\n' \
   "scripts/checks/instrument-manifest.txt" "$WAIVER_COUNT" "$LEDGER_ERRORS" "$WAIVED" "$WAIVED_CLEAN"
```

---

## 9. Where each claim this fix falsified was corrected

| Document | Claim at `229e084`/`f30dfdc` | Corrected to |
|---|---|---|
| `check-instrument-typecheck.sh`, step 11 header | "`FAILED` goes down by one and `WAIVED` goes up by one" | "*BY ONE* IS ENFORCED HERE, NOT ASSUMED (round 501)" — the sentence was false, and both layers that make it true are named at the place it is claimed |
| `check-instrument-typecheck.sh`, `Exit:` block | "Neither can turn a failure into a pass" | kept, followed by "THAT SENTENCE WAS FALSE UNTIL ROUND 501 and is now enforced twice", naming the measurement |
| `check-instrument-typecheck.sh`, failure mode (g) | "Three further failures close the neighbouring holes" | "Four further failures", the fourth being a path waived TWICE |
| `instrument-manifest.txt` header | "THE TWO PROPERTIES THAT MAKE A LEDGER SAFER THAN AN EXCLUSION FLAG" | "THE THREE PROPERTIES…", property 3 being *one subject, one waiver*, with the measurement and with the instruction for two rounds needing to waive one path |
| `02-architecture.md` §4.6 | "Two properties make it safe" | "Three properties make it safe"; and §5 gains failure mode **F16** with its guard and its proof |
| `evidence/phase5-ledger.md` §7.1 row 2 | "A waiver laundering a real type error into a green run — It cannot" | the row is kept and corrected: what was false, why, and what is true after round 501, pointing at C4 and C5 |
| `engine-task-graph/03-quality.md` §3.1 item 9 and §4 command block | the ledger's failures listed without uniqueness | both carry the duplicate-entry rule (also required by R31: item 9's verify clause pins this file's last-touching commit to the gate script's) |

---

## 10. Standing rule 2, discharged

Code and every document that claims otherwise land in **one commit**. Six paths,
all declared:

```
scripts/checks/check-instrument-typecheck.sh
scripts/checks/instrument-manifest.txt
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase6-ledger-c4.md
docs/plan/engine-task-graph/03-quality.md
```
