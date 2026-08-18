# Phase 5 — the waiver ledger, the gate's two hooks, and the corpus amendment

**Project:** `scripts-checks-typecheck-gate` · **Round label 500** · one commit
(standing rule 2, A5.3).
**Requirements owned:** R14, R15, R31, R32, R34.
**Preceded by:** the round-499 scout, `docs/research/round-499-550e6620.md`.

Phase 5 does three things and this file is the evidence for all three:

1. **The ledger.** `scripts/checks/instrument-manifest.txt` inverted from an
   inclusion list into a waiver ledger with **zero entries** (D5.1, R14, R15).
2. **The gate's two hooks, implemented.** Round 200 left two comments in
   `check-instrument-typecheck.sh` — step 8 "read the waiver ledger" and step 11
   "waived but clean" — each saying in its own text that *phase 5 implements
   this hook in the same commit as the ledger*. They are implemented. A header
   claiming those two properties while the script read the file **nowhere** was
   the corpus lie this phase existed to kill.
3. **The corpus, made true** (D5.2–D5.4, R31, R32, R34, A5.1, A5.4, A5.5).

---

## 0. Preconditions (C3)

`NODE_ENV=production` is exported in this runtime, so a bare
`--frozen-lockfile` prunes devDependencies, exits 0, and removes the compiler.
Both installs were run with `--prod=false` and **the output read**, not just the
exit code:

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 968ms using pnpm v9.15.9

$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 755ms using pnpm v9.15.9

$ ls forge-control/node_modules/.bin | grep -E '^(tsc|tsx)$'
tsc
tsx
```

**No `- typescript` line in either install.** Nothing was pruned; `tsc` and
`tsx` are both present afterwards, which is the direction C3 requires.

---

## 1. V1 — THE GATE'S VERDICT MOVED FOR NOBODY

The baseline was taken **before any edit**, and the second run **after every
edit**, both on the same tree, both full runs (~150 s).

### 1.1 BEFORE — `/tmp/gate-before.txt`, exit 0

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 60ca3fc22711473ab0424e6af1e3fbee352dc01d
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.5RdOhh2W1F

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

### 1.2 AFTER — `/tmp/gate-after.txt`, exit 0

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 60ca3fc22711473ab0424e6af1e3fbee352dc01d
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.tgcGi58hpw

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
  wall clock       : 152s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
```

### 1.3 The diff

```
$ diff /tmp/gate-before.txt /tmp/gate-after.txt
13c13
<   this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
---
>   this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
20c20
<   temp dir         : /tmp/tmp.5RdOhh2W1F
---
>   temp dir         : /tmp/tmp.tgcGi58hpw
72a73,80
> WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
>   ledger: scripts/checks/instrument-manifest.txt — 0 entry/entries, 0 error(s), 0 waived, 0 waived but clean
>   ok: 0 waivers — the ledger is empty
>   Every subject above was compiled and none was excused. An empty ledger is
>   this project's target state, not an oversight: the file exists so that the
>   NEXT exclusion has somewhere loud to live instead of becoming an --exclude
>   flag nobody prints.
> 
81c89
<   wall clock       : 153s
---
>   wall clock       : 152s
```

**Four differences, all four permitted:**

| Difference | Why it is permitted |
|---|---|
| `this check sha256` | this commit edits the gate script; the sha256 is *supposed* to move, and a run in which it did not would mean the edited script was not the one that ran |
| `temp dir` | `mktemp -d`, per run (NF4) |
| `wall clock` 153 s → 152 s | timing |
| the WAIVERS block, 8 new lines | the deliverable |

**Everything else is byte-identical.** `subjects found 42`, `subjects compiled
42`, all 42 per-subject `PASS` lines, COVERAGE, SELF-TEST, SUPPRESSIONS,
PROFILE FIDELITY, CENSUS and the verdict line
`check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.` are
unchanged, and both runs exit 0. **The ledger changed which files are compiled
for nobody, and changed the verdict of an unchanged tree for nobody.**

---

## 2. V2 — PROVING THE LEDGER CAN FAIL

Three transient mutations. Each was **applied, run, and reverted**, and the
revert proven with `cmp` against a byte-for-byte copy taken before the first
mutation. **Each transcript below is complete and unedited** — the mutation, the
`git diff --stat` proving it landed, the gate's entire output including all 42
per-subject lines, the exit code, the revert, `git status --porcelain` and the
`cmp` proof. Nothing is elided.

The runner is reproduced here so the controls can be re-run verbatim:

```bash
LED=scripts/checks/instrument-manifest.txt
cp "$LED" /tmp/ledger-pristine.txt
# per control: append the entry, run the gate, capture, restore, prove restored
printf '\n%s' "$entry" >> "$LED"
bash scripts/checks/check-instrument-typecheck.sh
cp /tmp/ledger-pristine.txt "$LED"
cmp /tmp/ledger-pristine.txt "$LED" && echo "ledger restored byte-for-byte"
```

### 2.1 Control (a) — WAIVED BUT CLEAN

A complete four-field entry for `scripts/checks/check-close-gate.ts`, which
compiles clean today.

```
########## CONTROL (a) ##########
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
# path        : scripts/checks/check-close-gate.ts
# diagnostic  : TS2322 at line 571 — Type 'string' is not assignable to type 'number'.
# reason      : transient negative control (a) for round 500 evidence; reverted in the same script that added it
# owner       : round 500, phase 5 — this control
scripts/checks/check-close-gate.ts
EOF

$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 207 +++++++++++++++++++++++++--------
 1 file changed, 156 insertions(+), 51 deletions(-)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 60ca3fc22711473ab0424e6af1e3fbee352dc01d
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.spHi9hG2hU

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
  wall clock       : 151s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 0 ledger error(s), 1 waived but clean, census mismatch 0.
exit=1

--- REVERT ---
$ git status --porcelain
 M docs/plan/engine-task-graph/03-quality.md
 M docs/plan/engine-task-graph/evidence/phase8-tooling.md
 M docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M docs/plan/scripts-checks-typecheck-gate/03-quality.md
 M docs/plan/scripts-checks-typecheck-gate/04-phases.md
 M scripts/checks/check-instrument-typecheck.sh
 M scripts/checks/instrument-manifest.txt
 M scripts/deploy/payload-review.json
$ cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt && echo 'ledger restored byte-for-byte'
ledger restored byte-for-byte
```

**Verdict: FAILURE, exit 1, the file named, and the required words present** —
`waived but clean` appears in the block, twice (the label
`WAIVED BUT CLEAN` and the sentence `— waived but clean: this subject compiled
with ZERO diagnostics`). Note `waived but clean 1` in the final line and that
`type failures` stayed **0**: a stale waiver is its own counter, not a
laundered type error.

### 2.2 Control (b) — A MISSING FIELD

The same shape with `# reason` omitted, on `scripts/checks/check-plan-api.ts`.

```
########## CONTROL (b) ##########
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
# path        : scripts/checks/check-plan-api.ts
# diagnostic  : TS2345 at line 12 — transient negative control (b)
# owner       : round 500, phase 5 — this control
scripts/checks/check-plan-api.ts
EOF

$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 206 +++++++++++++++++++++++++--------
 1 file changed, 155 insertions(+), 51 deletions(-)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 60ca3fc22711473ab0424e6af1e3fbee352dc01d
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.uCbkDuGaLE

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
  wall clock       : 152s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
exit=1

--- REVERT ---
$ git status --porcelain
 M docs/plan/engine-task-graph/03-quality.md
 M docs/plan/engine-task-graph/evidence/phase8-tooling.md
 M docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M docs/plan/scripts-checks-typecheck-gate/03-quality.md
 M docs/plan/scripts-checks-typecheck-gate/04-phases.md
 M scripts/checks/check-instrument-typecheck.sh
 M scripts/checks/instrument-manifest.txt
 M scripts/deploy/payload-review.json
$ cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt && echo 'ledger restored byte-for-byte'
ledger restored byte-for-byte
```

**Verdict: FAILURE, exit 1, naming the path AND the missing field** —
`the entry 'scripts/checks/check-plan-api.ts' is missing required field(s):
reason`. The entry is also printed as `INVALID … excuses nothing`, which is the
substantive point: a malformed waiver does not quietly excuse its subject.

### 2.3 Control (c) — A WAIVED PATH THAT IS NOT ON DISK

```
########## CONTROL (c) ##########
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
# path        : scripts/checks/does-not-exist.ts
# diagnostic  : TS2307 — a file that is not on disk
# reason      : transient negative control (c) for round 500 evidence
# owner       : round 500, phase 5 — this control
scripts/checks/does-not-exist.ts
EOF

$ git diff --stat -- scripts/checks/instrument-manifest.txt
 scripts/checks/instrument-manifest.txt | 209 +++++++++++++++++++++++++--------
 1 file changed, 157 insertions(+), 52 deletions(-)

$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 60ca3fc22711473ab0424e6af1e3fbee352dc01d
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.4HS7njp80w

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
  wall clock       : 156s

check-instrument-typecheck.sh FAILED — 0 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), 1 ledger error(s), 0 waived but clean, census mismatch 0.
exit=1

--- REVERT ---
$ git status --porcelain
 M docs/plan/engine-task-graph/03-quality.md
 M docs/plan/engine-task-graph/evidence/phase8-tooling.md
 M docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M docs/plan/scripts-checks-typecheck-gate/03-quality.md
 M docs/plan/scripts-checks-typecheck-gate/04-phases.md
 M scripts/checks/check-instrument-typecheck.sh
 M scripts/checks/instrument-manifest.txt
 M scripts/deploy/payload-review.json
$ cmp /tmp/ledger-pristine.txt scripts/checks/instrument-manifest.txt && echo 'ledger restored byte-for-byte'
ledger restored byte-for-byte
```

**Verdict: FAILURE, exit 1** — `the waived path
'scripts/checks/does-not-exist.ts' is NOT ON DISK. A waiver for a file that is
gone is stale by definition`. Note that the *not-among-the-subjects* check did
**not** also fire: a path that is absent is reported once, as absent, rather
than twice under two headings.

### 2.4 After all three: the tree holds only the intended edits

The `git status --porcelain` printed after each revert (see the transcripts
above) is identical all three times and contains **only this task's declared
write-set**, with the ledger restored byte-for-byte each time:

```
 M docs/plan/engine-task-graph/03-quality.md
 M docs/plan/engine-task-graph/evidence/phase8-tooling.md
 M docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M docs/plan/scripts-checks-typecheck-gate/03-quality.md
 M docs/plan/scripts-checks-typecheck-gate/04-phases.md
 M scripts/checks/check-instrument-typecheck.sh
 M scripts/checks/instrument-manifest.txt
 M scripts/deploy/payload-review.json
```

(`docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md` — this file
— was written after the controls ran and is the tenth path.)

---

## 3. V3 — the payload is still valid JSON · V4 — shellcheck

```
$ python3 -c "import json;json.load(open(...))"
payload-review.json parses as valid JSON
exit=0

$ shellcheck -S error scripts/checks/check-instrument-typecheck.sh
exit=0
```

`scripts/deploy/payload-review.json` was edited **through `json.loads` /
`json.dumps`**, not by hand: the file was parsed, the one paragraph replaced
inside the decoded string, and re-serialised with the same two-space indent.
`git diff --stat` on it reports **1 insertion, 1 deletion** — a single line, the
`"brief"` line — so the escaped newlines (`\n`) and every other key are provably
untouched.

---

## 4. V5 — `forge-control` typecheck and tests, untouched-green

This commit changes **no TypeScript**. Run to prove it changed nothing:

```
$ cd forge-control && pnpm typecheck && pnpm test

> forge-control@0.1.0 typecheck /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control
> tsc --noEmit

typecheck exit=0
    ok 3 - the summary exits non-zero when any step failed
      ---
      duration_ms: 0.400264
      type: 'test'
      ...
    1..3
ok 258 - verify-control-plane.sh — properties the deploy phase depends on
  ---
  duration_ms: 1.601944
  type: 'suite'
  ...
1..258
# tests 1293
# suites 239
# pass 1293
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5498.317978
test exit=0
```

`tsc --noEmit` exit 0; **1293 tests, 1293 pass, 0 fail, 0 skipped**, exit 0.
Green before this task and green after.

---

## 5. V6 — the three corpus checkers this commit's edits are read by

All three read files this commit edits. All three are green **after** the edits:

```
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
check-corpus-map.py
  self            863bc25
  01-requirements c442de8   95455 bytes
  04-phases       b8a5116   86477 bytes

  defined: 71 R + 7 NF

  phase   01§K   04§9   header   verdict
    1      12     12     12     agree
    2      15     15     15     agree
    3      11     11     11     agree
    4      19     19     19     agree
    5       8      8      8     agree
    6       5      5      5     agree
    7       4      4      4     agree
    8       8      8      8     agree

OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
exit=0

$ python3 docs/plan/engine-task-graph/check-instrument-identity.py
== check-instrument-identity — provenance ==
this script:       4ee7789135556f423e95b916cef1322a33e8a528d4e8bcea6ea4e26d54b03dee
instrument-sha256: fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b   <- every pasted header must name THIS
instrument-files:  39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
                   c00fd096e0b8ddc57bad52d4bb6ef27dd17793aeda542603570ce3f454e861e5  forge-control/src/lib/schedule-source.ts
                   re-derive: sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum
historical shas:   8 (must not appear unmarked)
                   367c48fbe9e017c715e40c32ca44fc5a0303910edb2d62de4110e69149b84032  first seen 674d860
                   394be7236aa6d8738e6107612f84ce7de855fee555bc9a9787e408abcce7a4bf  first seen 674d860
                   6ec72b35374d619f3f383cecca716e3f3d9b668e98a8cd08162b77a39ff622ff  first seen 674d860
                   80ef11235ffe3e2cc12dd58404533070d4b7575a050ff96d44acf49226ef6afb  first seen b1bb731
                   932cf915603ce199ed46d2e5d62e23f8edd48f9a7f122a0debfa43a9de081bc7  first seen 34268e9
                   bb65b555aee34092d15e7b7a0ef133f0d00b0815d3f257e5042710f9b50d3f70  first seen b1bb731
                   dd00957c84d4c8af7f7761623ff09a66fdc34b8db2550acf0aeb7444b3d150cc  first seen b1bb731
                   f6828a684e5ffc39361d061097ef4f0097ad010f289a9d177907487e47d5bac2  first seen 34268e9
corpus:            26 markdown file(s) under docs/plan/engine-task-graph/

OK — 12 pasted header(s) across 3 file(s) name fb5a6434…
OK — 33 pasted manifest line(s) name the current digest of their half
OK — no retired identity quoted without '[historical instrument]'
exit=0

$ python3 scripts/checks/check-r20-census.py
check-r20-census: SOURCE  forge-control/src/db/projects.ts
check-r20-census: HEAD    60ca3fc
check-r20-census: SHA256  79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
check-r20-census: HITS    129 (142 case-insensitive), 51 code / 78 comment, 3 sql-annotations
check-r20-census: SYMBOLS 25 attributed
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  docs/plan/engine-task-graph/evidence/phase2-replay.md matches the measurement  PASS
exit=0
```

Nothing here needed fixing, and nothing here was disclosed and stepped around.

---

## 6. V7 — the A5.1 sweep, re-run at the end

```
$ grep -rn "add .* to the manifest\|missing from the manifest\|absent from the manifest\|list it in\|named in .*manifest" .   (excluding node_modules)
./scripts/checks/check-instrument-typecheck.sh:23:# manifest.txt` — and compiled the seven paths named in it, with a "manifest
./scripts/deploy/payload-verify.json:5:  "brief": "You are the explicitly-briefed POST-RESTART VERIFICATION TASK (R67,\n`03-quality.md` §2.3). You verify against LIVE — t…
./forge-control/src/lib/project-tick.test.ts:3346:          "does not list it in ROLES — the prompt would teach a call the API refuses with a 400, " +
./docs/research/round-499-550e6620.md:13:> "The round-800 gate read an INCLUSION LIST — `scripts/checks/instrument-manifest.txt` — and compiled the seven paths named in i…
./docs/research/round-499-550e6620.md:27:**Claim (verbatim):** "It typechecks every check script named in `scripts/checks/instrument-manifest.txt`, **one file per `tsc` i…
./docs/research/round-499-550e6620.md:95:**Claim (verbatim):** "The round-800 gate read an INCLUSION LIST — `scripts/checks/instrument-manifest.txt` — and compiled the se…
./docs/plan/scripts-checks-typecheck-gate/04-phases.md:328:- **A5.1** No document instructs a reader to add a line to the manifest to get a
./docs/plan/engine-task-graph/evidence/phase8-tooling.md:628:diff is missing from the manifest. Closing the rest of the directory is the DoD-6
./docs/plan/engine-task-graph/evidence/phase8-tooling.md:1467:is missing from the manifest. Do not accept its green run on faith — the

$ grep -rn "manifest" agents/*.md
exit=1 (1 = no match — agents/*.md carries nothing about the manifest)

$ grep -rn "manifest" scripts/deploy/*.json | (semantic read below)
scripts/deploy/payload-review.json:1
scripts/deploy/payload-verify.json:1
scripts/deploy/payload-report.json:0
```

**`agents/*.md` CONFIRMED CLEAN** — `grep -rn 'manifest' agents/*.md` exits 1,
no match. That was the site worth confirming by hand: a role file carrying "add
your script to the manifest" would recreate the hole in the head of every
builder the fleet ever launches, and no gate reads role files.

Every surviving hit above, read individually:

| Hit | Verdict |
|---|---|
| `check-instrument-typecheck.sh:23` | **history, correctly marked.** "The round-800 gate *read* an INCLUSION LIST … Both are GONE" — past tense, inside the WHAT CHANGED AT ROUND 200 block. |
| `scripts/deploy/payload-verify.json:5` | **false positive of the grep, and a C7 no-edit site.** The BRE `named in .*manifest` is greedy over a one-line JSON file: "named in" and "manifest" are 3 kB apart. The file's only real mention is the launch goal quoted verbatim — see §8. |
| `forge-control/src/lib/project-tick.test.ts:3346` | **unrelated.** "does not list it in ROLES" — the `list it in` alternation, about the ROLES table. |
| `docs/research/round-499-550e6620.md` ×3 | **a dated recon record**, whose hits are all inside lines explicitly labelled `**Claim (verbatim):**` — quotations of the then-corpus, every one of which this commit corrected. See §9 for its two inaccuracies. |
| `04-phases.md:328` | **A5.1's own text**, the sentence that states the prohibition. A checker that fails on the prose forbidding the thing is a checker nobody keeps. |
| `phase8-tooling.md:628` | inside §5, which now carries a **SUPERSEDED** marker at its head. |
| `phase8-tooling.md:1467` | inside §7's verbatim paste, which now carries an **AMENDED ON DISK** marker at its subsection head. |

**No document instructs a reader to add a line to the manifest to get a file
compiled.** The ledger's own header says the opposite outright, in capitals:
*ADDING A PATH HERE DOES NOT OBTAIN COVERAGE — IT EXCUSES A FAILURE.*

---

## 7. What was implemented in the gate, and why each piece is not optional

| Where | Round 200 | Round 500 |
|---|---|---|
| header ~line 32 | "THE MANIFEST IS NOT READ BY THIS SCRIPT AT ALL" | "THE MANIFEST IS NEVER READ AS AN INCLUSION LIST" + the distinction spelled out: the script **does** read it, as a ledger; nothing in it can add or remove a subject |
| header ~line 44 | "STANDING RULE 2 IS SATISFIED BY PHASE 5, NOT HERE" | a WHAT CHANGED AT ROUND 500 block naming what this commit landed |
| failure mode (g) | "A STALE WAIVER … NOT IMPLEMENTED HERE" | "IMPLEMENTED HERE SINCE ROUND 500", naming the four failures that close it |
| Usage / Exit | six counters | plus `ledger errors` and `waived but clean`, each described |
| step 8 | a hook comment | parse + validate: four required fields, `path` field must agree with the bare path, path must exist, path must be a subject |
| step 11 | a hook comment | the WAIVERS block + reconciliation: a valid waiver reclassifies an observed FAIL into an excused WAIVED; a waived-clean subject fails with "waived but clean" |
| SUPPRESSIONS message ~1381 | "phase 5's waiver ledger *is where*…" (future tense) | present tense, naming the file, and adding that a waiver excuses a failure and does not make a suppression acceptable |
| verdict, PASSED line | `%d/%d subjects compiled clean.` | unchanged **when `WAIVED` is 0**; a second branch prints `…, %d WAIVED` otherwise, because a waived subject did not compile clean and the verdict line is the sentence a reader quotes |

**What was deliberately NOT touched:** `SUBJECT_GLOBS`, `PROFILE`,
`TS_EXTENSIONS`, the census, the three canaries, the fifth canary, the
suppression scan and the fidelity scan. §1.3's diff is the proof.

### 7.1 Standing rule 3 — what would make this instrument report a pass wrongly

| Candidate | Why it cannot |
|---|---|
| **The ledger silently excluding a subject from the compile loop.** | The loop has no branch that consults the ledger — step 8 runs *after* enumeration and writes nothing into `SUBJECTS`, and step 11 runs *after* the loop. §1.3 measures it: 42 found, 42 compiled, before and after. |
| **A waiver laundering a real type error into a green run.** | It cannot: a valid waiver moves one failure from `FAILED` to `WAIVED`, and the PASSED line then says `N WAIVED` instead of "compiled clean". `WAIVED` is only ever incremented for a subject the loop **observed failing**. |
| **An invalid entry excusing its subject anyway.** | Control (b) measures the opposite: `INVALID … excuses nothing`, `ledger error(s) 1`, exit 1. |
| **The WAIVERS block silently disappearing** (a `if [ $count -gt 0 ]` around the whole block — the classic). | It prints unconditionally, and with zero entries prints `ok: 0 waivers — the ledger is empty`. A reviewer diffing two transcripts sees its absence. |
| **The parser silently seeing nothing** — the failure mode that killed round 2's suppression grep. | Measured directly: `awk '/^# (path\|diagnostic\|reason\|owner)[[:space:]]*:/' scripts/checks/instrument-manifest.txt` returns **0 hits on the header alone** and **4 hits with a control entry appended**, and all three controls in §2 produced their expected failure. A parser that saw nothing would have made control (b) and control (c) pass. |
| **The header's own format example being read as a live entry** — a real hazard, since §4.6's example is a syntactically valid record. | The example is indented by four extra spaces and the field pattern requires exactly `# ` before the field name. The header says why it is indented, at the place it is indented, so the next editor does not "fix" it. |
| **`set -e` aborting mid-parse and the run reading as green.** | The `ERR` trap (with `-E`) prints "ABORTED … this run is NOT a pass". One concrete instance was avoided by construction: `[ -z "$x" ] && missing+=…` would make a complete four-field entry the loop's exit status and kill the run; the code uses `if` blocks and says so inline. |

---

## 8. Corpus: corrected vs marked superseded

The rule applied throughout: **a document that PRESCRIBES gets corrected; a
transcript or verbatim paste that RECORDS gets a superseded marker at its
section head**, because editing a record falsifies it.

### 8.1 CORRECTED

| Location | What was false | What it says now |
|---|---|---|
| `docs/plan/engine-task-graph/03-quality.md` §3.1 item 9, opening | "typechecks every check script named in `instrument-manifest.txt` … and additionally fails if any `scripts/checks/*.ts` this branch adds or modifies is absent from the manifest" | the whole directory by glob, recursive, dotfiles included, `.ts`/`.tsx` compiled and `.mts`/`.cts` named-and-failed; one `tsc` per file; the manifest is a **waiver ledger**; the manifest guard is **retired** because glob enumeration makes its question unaskable |
| same, §4 command block item 9 comment | "names the manifest script that no longer typechecks / the `scripts/checks/*.ts` this branch touched and did not list. One tsc invocation per file, **from forge-control/**" | scope is the whole directory, not the manifest and not the diff; **one tsc invocation per file kept** (it is R11 and it is true); "from forge-control/" corrected to **from the repo root** — see §9, scout miss 2 |
| same, trap (b) | implied the derived-file-list expression scopes item 9 | marked history *as an input to the retired guard*, and states what it is **still** for: the identical expression with `'*.sh'` derives **item 10**'s shell-lint subject list, and the merge-commit trap is why item 10 spells it out |
| `phase8-tooling.md` §1 table, 2 rows | "Compiles every manifested instrument"; "why it is scoped rather than directory-wide" | glob-enumerated whole directory; waiver ledger, target empty — a prescriptive index line, so corrected rather than marked |
| `scripts/deploy/payload-review.json` `brief` | **a LIVE reviewer brief** instructing a future reviewer to expect manifest-scoped coverage and a manifest guard | the glob-scoped gate and the waiver ledger, with the census-count expectation stated so the reviewer knows what a *smaller* number means |
| `02-architecture.md` §7 | named intentions ("the glob in step 5 of §4.1") | files and line numbers, SHA-pinned, per-line "changes it to", and the uncovered subjects counted **on disk** — see §9, scout-independent correction |
| `04-phases.md` §10 phase-5 row | four files | the ten actually written, with a paragraph saying why the row grew (E1) |
| `03-quality.md` (this project) Phase 5 gate | `sed -n '855,865p'` — a window this commit's own edit moved | `sed -n '903,911p'`, re-derived after the edit, plus the `grep` that re-derives it next time (E2) |

### 8.2 MARKED SUPERSEDED, with the pointer text used

Pointer text, verbatim, in every case: **"superseded by
`docs/plan/scripts-checks-typecheck-gate/`, round 500"**.

| Location | Why a marker and not a correction |
|---|---|
| `phase8-tooling.md` §5 head | evidence record of the **round-802** gate; its transcripts are what that gate printed |
| `phase8-tooling.md` §5.1 head | the three breakage transcripts, one of which breaks the *manifest guard* — a control for a mechanism that no longer exists. The marker names where the current controls live. |
| `phase8-tooling.md` §7 `payload-review.json` subsection head | the **verbatim paste** of what was rendered into a task. Not edited; the marker says the on-disk payload's item-9 paragraph was amended in round 500 and quotes the replacement in one line. |
| `round902-screenshot-convention-fixes.md` control (e) | an instruction about how coverage was obtained ("its manifest guard would fail by name if it were not listed") — an A5.1 site. Marked, with the statement that the instrument is now covered by glob and lists nothing, and that the control's *point* survives and is stronger. |
| `round902-screenshot-convention-fixes.md` write-set line 18 | a true record of a round-902 write; the note says a round-902-shaped write-set today would not contain that line |
| `03-quality.md` §3.1 item 9, "Why MANIFEST-SCOPED…" and "What the manifest guard buys" | **history whose measurements are real.** Kept under an explicit history block naming round 800, with one line saying what superseded them: the profile compiles each subject alone, which removes the merged-program argument, and phase 3 fixed the three red scripts rather than scoping around them. |
| `instrument-manifest.txt` round-800 and round-902 history | a clearly delimited `▼▼▼ HISTORY` block whose first line says it describes a file that no longer works this way. **R15's verify line holds:** `grep -n 'MEASURED AT ROUND 800'` returns two hits, both inside that block. |

### 8.3 NOT EDITED, deliberately

`scripts/deploy/payload-verify.json` quotes the project's **launch goal**
verbatim, including *"extend `scripts/checks/instrument-manifest.txt` to cover
the whole directory"*. It is the record of what was launched and editing it
falsifies that record (C7). The sentence is instead **named in the ledger's
header**, which states that the goal's phrasing was superseded by glob
enumeration: the directory is covered without the manifest naming anything, and
the goal's intent is met with the ledger empty.

---

## 9. Scout misses and scout inaccuracies

The round-499 scout enumerated; this phase verified. Recorded here as A5.4
requires, and left in `docs/research/round-499-550e6620.md` unedited — a dated
recon record is a record.

**Misses — sites the scout did not enumerate:**

1. **`scripts/deploy/payload-review.json` — the worst site in the corpus, and
   the only one that is not prose.** A live reviewer brief, rendered into a
   task's instructions, telling a future reviewer that the gate "compiles each
   entry of `scripts/checks/instrument-manifest.txt` in ITS OWN tsc invocation
   and fails if any file this branch touched under `scripts/checks/*.ts` is
   missing from the manifest." The scout's sweep was `*.md`-shaped; the payloads
   are `*.json` and carry live briefs.
2. **`docs/plan/engine-task-graph/03-quality.md` §4 item 9's "from
   `forge-control/`".** Not a manifest claim, so no manifest-grep found it, but
   false all the same: the gate compiles **from the repo root**, deliberately,
   because `tsc` prints diagnostic paths relative to its own cwd and the
   fidelity check compares them against `scripts/checks/`. Corrected, and trap
   (a) of item 9 — the "working directory is load-bearing" note that produced
   that sentence — marked history with what replaced it.
3. **`round902-screenshot-convention-fixes.md`** control (e) and its write-set
   line. Named by this task's brief, not by the scout.
4. **§7's count of `forge-control/scripts/`.** Not a scout site at all — an
   error inside this project's own architecture document, found by counting on
   disk as A5.5 requires. §7 said "nine `smoke-*.ts`". There are **seven**
   (`find forge-control/scripts -name '*.ts'` → `probe-usage-router.ts` + 7
   `smoke-*.ts` = 8 files). The directory also holds `canvas-cli.mjs` and
   `twenty/mint-api-key.mjs`, which are `.mjs` and therefore neither subjects
   nor uncovered. Corrected, with the derivation named in the table.

**Inaccuracies — claims in the scout report that are wrong:**

5. Scout §"Lines 4-5", classification *PARTIALLY NOW-FALSE*: *"'one file per
   invocation' is no longer accurate. The script may compile multiple files in
   one tsc invocation depending on how the glob is grouped."* **False.** One
   `tsc` invocation per subject is **R11**, it is what the loop does — one
   generated per-file config, `"files": [<one path>]` — and the gate prints the
   invocation shape in its own PROVENANCE block. The 42 `PASS` lines in §1.2 are
   42 invocations. The claim was not acted on; the phrase is kept everywhere it
   appears because it is true.
6. Scout §"Lines 44-47", classification *NOW-FALSE or MISDIRECTED*: *"Phase 5
   (round 500) has already completed … The fact that they weren't [amended]
   suggests this rule was not followed."* **False at the time of writing** —
   phase 5 had not run; it is this task. The scout inferred completion from a
   round label.

---

## 10. Standing rule 2, discharged: ONE commit

`git log -1 --name-only` is the acceptance test (A5.3) and shows the ledger, the
gate script, the payload, every document and this evidence file together:

```
$ git log -1 --name-only

feat(scripts-checks-typecheck-gate/phase 5, round 500): the waiver ledger, the gate's two hooks, and the corpus amendment

docs/plan/engine-task-graph/03-quality.md
docs/plan/engine-task-graph/evidence/phase8-tooling.md
docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/03-quality.md
docs/plan/scripts-checks-typecheck-gate/04-phases.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md
scripts/checks/check-instrument-typecheck.sh
scripts/checks/instrument-manifest.txt
scripts/deploy/payload-review.json

All ten paths of the declared write_set, together: the ledger, the gate script,
the payload, every document and this evidence file.
```

The file list above was inserted into this file after the commit was made and
the commit `--amend`ed once, which is why no SHA is quoted here: a commit cannot
contain its own hash. The list is unaffected by the amend — the same ten paths
before and after — and the round-500 SHA resolves with
`git log -1 --format=%H -- scripts/checks/instrument-manifest.txt`.
