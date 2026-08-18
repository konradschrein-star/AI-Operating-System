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
