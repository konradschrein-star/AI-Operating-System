# Phase 6 — Deploy and verify

**Project:** `scripts-checks-typecheck-gate` · **Round label 600** · deploy task,
round 1 · written 2026-08-18.

**Merged tip: `6c3dc9f`.** `main` in `/opt/forge-ai-os` is at it, fast-forward,
no conflict.

---

## 0. The three things a reader should take away

1. **No executor restart was required and none was performed.** Proven from the
   diff, path by path (§2), and from `pm2 jlist` uptimes taken after the merge
   (§11). `pm2 restart forge-executor` was never run; neither was
   `pm2 restart forge-control`; no `safe-restart.sh` was launched.

2. **A6.1 — the cold-tree criterion — FOUND A REAL DEFECT, and it is fixed.**
   On a genuinely cold `git clone` the gate refused and printed one install
   line. That line, run verbatim, left the gate **RED: 13 type failures, 423
   fidelity violations** — because `forge-control/node_modules` is required too
   and the refusal never named it. A6.1 reads *"that line is run verbatim; the
   gate then reports 42/42 green"*, and it did not. Fixed at `6c3dc9f`, with
   four controls; A6.1 now passes end to end (§8).

3. **A6.3 is an EXCEPTION, not a pass.** `/opt/forge-ai-os` carries one
   uncommitted file that is not this project's and was not touched (§6).

**A6.5 — wall clock of a full gate run: 142 s** as the gate reports it,
**2 m 21.5 s** by `time(1)`, on the cold tree at `6c3dc9f` with 42 subjects.
The same run on the merged live checkout: **142 s / 2 m 21.7 s**.

---

## 1. STEP 0 — dependencies, before any gate

`NODE_ENV=production` is exported into this runtime, so both installs carry
`--prod=false`. C3.

```
$ cd forge-control     && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 685ms using pnpm v9.15.9

$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 864ms using pnpm v9.15.9
```

Neither printed a `- typescript` line, so the prune did not fire. Binaries
confirmed present:

```
PRESENT  forge-control/node_modules/.bin/tsc
PRESENT  forge-control/node_modules/.bin/tsx
PRESENT  forge-control-web/node_modules/.bin/tsc
```

---

## 2. STEP 1 — the restart question, answered by measurement

### 2.1 A correction to the brief's premise, recorded rather than repeated

The brief asks for `git diff main...HEAD --name-only`. **On this tree that
command returns nothing**, because `main` had already been fast-forwarded to the
work branch before this task ran — see §5. `main...HEAD` is therefore empty by
construction and says nothing about the project.

The meaningful basis is the plan-time tip of `main`, **`9b960ef`**. Everything
below uses `9b960ef...HEAD`.

### 2.2 The listing — 50 files

```
$ git diff 9b960ef...HEAD --name-only
docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
docs/plan/engine-task-graph/03-quality.md
docs/plan/engine-task-graph/evidence/phase8-tooling.md
docs/plan/engine-task-graph/evidence/round902-screenshot-convention-fixes.md
docs/plan/notification-gap.md
docs/plan/scripts-checks-typecheck-gate/00-vision.md
docs/plan/scripts-checks-typecheck-gate/01-requirements.md
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/03-quality.md
docs/plan/scripts-checks-typecheck-gate/04-phases.md
docs/plan/scripts-checks-typecheck-gate/evidence/census-A-current-gate-options.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-B-root-paths-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-C-root-paths-plus-react-types.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-E-web-extends-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
docs/plan/scripts-checks-typecheck-gate/evidence/instruments-still-detect.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-a.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-b.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-d.md
docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1-round3.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle2.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-redteam.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase4-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase5-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase6-ledger-c4.md
docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
docs/plan/scripts-checks-typecheck-gate/evidence/residual-errors-profile-G.txt
docs/plan/scripts-checks-typecheck-gate/evidence/round0-probes.md
docs/research/round-499-550e6620.md
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-orientation.ts
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
scripts/checks/instrument-manifest.txt
scripts/checks/serve-sse-808.ts
scripts/deploy/payload-review.json
tsconfig.checks-instruments.json
tsconfig.checks.json
```

### 2.3 The executor-loaded set, path by path

| Executor-loaded path | Hits in the listing |
|---|---|
| `forge-control/src/lib/project-tick.ts` | **0** |
| `forge-control/src/lib/cc-runner.ts` | **0** |
| `forge-control/src/executor.ts` | **0** |
| `forge-control/src/db/*` | **0** |
| `agents/*.md` | **0** |

And the complement — every path in the listing falls into one of four buckets,
verified by inverting the pattern:

```
$ grep -vE '^(scripts/checks/|scripts/deploy/|docs/|tsconfig\.checks(-instruments)?\.json$)' <listing>
(no output — every path falls in the four expected buckets)
```

**RESTART VERDICT: none required.** No executor-loaded file is in the diff, so
the running executor is not holding stale copies of anything this project
changed. `safe-restart.sh` was correctly not invoked.

### 2.4 The plan's own phrasing was wrong, and the correction is recorded here

`04-phases.md` §"Executor restart" says the diff touches *"`scripts/checks/*`,
**one root tsconfig**, and `docs/**`"*. Measured, it touches **two** root
tsconfigs — `tsconfig.checks-instruments.json` (new, D1.1) and
`tsconfig.checks.json` (D1.2's cross-reference comment) — **plus**
`scripts/deploy/payload-review.json`, a live reviewer brief amended by phase 5.
The restart conclusion is unaffected: none of the three is executor-loaded.

---

## 3. STEP 2 — the phase-5 blocker, re-measured from scratch

Control C4 of `evidence/phase5-gate.md` §5.5, re-run by this task rather than
read from `evidence/phase6-ledger-c4.md`.

**Mutation.** Two subjects broken; one of them waived **twice**, both entries
valid four-field records.

```
$ printf '\nexport const __c4_reviewer_probe: number = "not a number";\n'  >> scripts/checks/check-close-gate.ts
$ printf '\nexport const __c4_reviewer_probe2: number = "not a number";\n' >> scripts/checks/check-plan-api.ts
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'
  (two four-field entries, both naming scripts/checks/check-close-gate.ts)
EOF

$ git diff --stat
 scripts/checks/check-close-gate.ts     |  2 ++
 scripts/checks/check-plan-api.ts       |  2 ++
 scripts/checks/instrument-manifest.txt | 12 ++++++++++++
 3 files changed, 16 insertions(+)

$ grep -n '^scripts/checks/check-close-gate.ts$' scripts/checks/instrument-manifest.txt
179:scripts/checks/check-close-gate.ts
185:scripts/checks/check-close-gate.ts
```

**Result — the gate refuses, loudly, naming BOTH line numbers, exit 1.**

```
  FAIL scripts/checks/check-close-gate.ts               exit 2
  FAIL scripts/checks/check-plan-api.ts                 exit 2

  ledger: … — 2 entry/entries, 1 error(s), 1 waived, 0 waived but clean
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 179)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
  INVALID scripts/checks/check-close-gate.ts (ledger line 185) — excuses nothing; see the LEDGER ERROR line(s) below.
  LEDGER ERROR at line 185: the path 'scripts/checks/check-close-gate.ts' is ALREADY WAIVED at line 179. One
    subject, one waiver: a second entry for the same path excuses a failure it does not own — step 11 discounts
    one failure per valid entry, so a duplicate discounts ANOTHER subject's failure and can turn this run green
    over a type error nobody waived. Delete one of the two entries (lines 179 and 185); …

  subjects found 42   subjects compiled 42   type failures 1   …
check-instrument-typecheck.sh FAILED — 1 type failure(s), … 1 ledger error(s), … census mismatch 0.
EXIT=1
```

Both sides of the hole are now closed and both are visible in one transcript:
the duplicate is refused as a ledger error **and** the arithmetic is honest —
`type failures 1` is `check-plan-api.ts`, the subject nobody waived, no longer
laundered by the second entry.

**Revert, and the tree proved unchanged:**

```
$ git checkout -- scripts/checks/check-close-gate.ts scripts/checks/check-plan-api.ts scripts/checks/instrument-manifest.txt
$ git status --porcelain
(0 bytes)
$ git rev-parse HEAD
b757896f7c630ad6a12869a610d2426b30b18177   # unmoved
```

**C4: PASS.** The merge proceeded.

---

## 4. STEP 3 — A6.4 / NF8, measured before the merge

```
$ git diff 9b960ef...HEAD -- "**/package.json" "**/pnpm-lock.yaml"
(no output)
```

**A6.4: PASS.** No `package.json` and no lockfile changed anywhere in the
project's diff.

---

## 5. STEP 4 — main's position, and a deviation from the brief

The brief states that at plan time `git merge-base main HEAD` equalled main's
tip `9b960ef`, so the merge would be a fast-forward. **Main had moved by the
time this task ran.** Measured:

```
$ git rev-parse HEAD                 b757896f7c630ad6a12869a610d2426b30b18177
$ git rev-parse main                 b757896f7c630ad6a12869a610d2426b30b18177
$ git merge-base main HEAD           b757896f7c630ad6a12869a610d2426b30b18177
$ git log --oneline main..HEAD       (empty)
$ git log --oneline HEAD..main       (empty)
```

`main` and `project/b7ab4c57` were already the **same commit**. The reflog says
who and when:

```
$ git reflog show main --date=iso | head -2
b757896 main@{2026-08-18 19:24:15 +0200}: merge project/b7ab4c57: Fast-forward
9b960ef main@{2026-08-18 08:10:27 +0200}: merge project/8c591d6c: Fast-forward
```

**This was a prior attempt of this same phase-6 deploy task.** It merged at
19:24:15, cloned `/tmp/cold-b7ab4c57-deploy` eight seconds later at 19:24:23,
installed dependencies into it at 19:27, and then died without writing evidence
— the known run-timeout failure. That earlier clone was therefore **warm**, and
is the reason §8 uses a new path.

Consequences, all handled: the code merge had already landed, so §7's first
merge was a no-op; the real merge performed by this task is the one carrying
`6c3dc9f` (§7.2). Nothing was lost and no history was rewritten.

---

## 6. STEP 5 — A6.3, an EXCEPTION with the file named

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx

$ git -C /opt/forge-ai-os diff --stat
 .../app/desktop/chat/AssistantThread.tsx           | 86 +++++++++++++++++++++-
 1 file changed, 85 insertions(+), 1 deletion(-)
```

**What it is, in one line:** a render-only message-windowing change — mounts
only the newest 60 messages of a chat thread behind a "show older" control, to
fix a scroll freeze caused by mounting all 2200 entries at once; the `messages`
array itself is untouched so counts and the ledger still describe the whole
transcript.

**Whose it is:** not this project's. Last committed at `ed601ff`
(`fix(round1875): five customer findings …`), modified 2026-08-18 17:22.

**Can it collide with the merge?** No. `AssistantThread.tsx` appears **0 times**
in this project's 50-file diff (§2.2), and R30/A3.5 independently confirms this
branch changed nothing under `forge-control-web/app/` or `forge-control/src/`.

**Action taken: none.** The file was not reverted, stashed, checked out,
deleted or cleaned. It was merged around. Konrad was told, once:

```
$ curl -sX POST http://127.0.0.1:7700/api/reminders …
{"ok":true,"reminder":{"id":"8323213d-adde-4fe8-a384-82cb761ed9dd", … ,"due_at":"2026-08-18 17:45:35+00" …}}
```

**A6.3 / universal item 3: EXCEPTION.** The live checkout is not clean, and the
one dirty path is `forge-control-web/app/desktop/chat/AssistantThread.tsx`,
which belongs to someone else. Every other tree touched in this phase — the
worktree and both cold clones — was verified clean at every step.

---

## 7. STEP 6 — the merge

### 7.1 First merge — already landed by the prior attempt

```
$ git -C /opt/forge-ai-os merge project/b7ab4c57
Already up to date.

$ git -C /opt/forge-ai-os log --oneline -3
b757896 fix(scripts-checks-typecheck-gate/phase 6, round 501): one subject, one waiver …
f30dfdc review(scripts-checks-typecheck-gate/round 1, phase 5 GATE): NEEDS_FIXES …
229e084 feat(scripts-checks-typecheck-gate/phase 5, round 500): the waiver ledger …

$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx
```

### 7.2 Second merge — the A6.1 fix

```
$ git -C /opt/forge-ai-os merge project/b7ab4c57
Updating b757896..6c3dc9f
Fast-forward
 docs/plan/engine-task-graph/03-quality.md    | 32 +++++++++++
 scripts/checks/check-instrument-typecheck.sh | 79 ++++++++++++++++++++++++++++
 2 files changed, 111 insertions(+)

$ git -C /opt/forge-ai-os log --oneline -3
6c3dc9f fix(scripts-checks-typecheck-gate/phase 6, round 600): the cold tree needs BOTH dependency trees, and the gate named one
b757896 fix(scripts-checks-typecheck-gate/phase 6, round 501): one subject, one waiver …
f30dfdc review(scripts-checks-typecheck-gate/round 1, phase 5 GATE): NEEDS_FIXES …

$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx
```

**No conflicts at either merge.** Both fast-forward.

---

## 8. STEP 7 — A6.1, the cold tree (DoD-7 / NF5)

### 8.1 The briefed path could not serve, and was not destroyed

`/tmp/cold-b7ab4c57-deploy` already existed, created 19:24:23 by the prior
attempt (§5), **with `node_modules` already installed**:

```
$ find . -maxdepth 4 -name node_modules -not -path './.git/*'
./forge-control/node_modules
./forge-control/node_modules/.pnpm/node_modules
./forge-control-web/node_modules
./forge-control-web/node_modules/.pnpm/node_modules
```

A run there is warm and proves nothing about A6.1. It was **left in place, not
deleted** — no `rm -rf`, no instruction to destroy it. A fresh path was used
instead.

### 8.2 The cold clone, and the finding

```
$ git clone /opt/forge-ai-os /tmp/cold-b7ab4c57-a61
Cloning into '/tmp/cold-b7ab4c57-a61'... done.
$ git log --oneline -1
b757896 fix(scripts-checks-typecheck-gate/phase 6, round 501): …
$ find . -maxdepth 4 -name node_modules -not -path './.git/*'
(nothing)
$ command -v tsc ; command -v tsx
tsc: not on PATH
tsx: not on PATH
```

The gate refused, exit 1, and printed **this line, verbatim**:

```
  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
```

Run verbatim, unedited, no flags added, `pnpm` not substituted:

```
devDependencies:
+ @types/node 22.10.2
+ @types/react 19.0.2
+ @types/react-dom 19.0.2
+ typescript 5.7.2
Done in 1.3s using pnpm v9.15.9
```

`+ typescript`, not `- typescript` — the prune did not fire. Then:

```
$ time bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
…
  subjects found 42   subjects compiled 42   type failures 13   fidelity violations 423   missing 0   uncovered 0   suppressions 0
  wall clock       : 131s
check-instrument-typecheck.sh FAILED — 13 type failure(s), 423 fidelity violation(s), …
EXIT=1
real	2m11.296s
```

**A6.1 FAILED as written.** The 13 subjects and the cause:

```
  FAIL check-classify.ts  check-gemini-tally.ts  check-plan-api.ts  check-project-metadata.ts
       check-screenshot-render-shapes.ts  check-story-digest.ts  check-task-api.ts
       check-ui-prompt.ts  check-usage-fold.ts  serve-agents-7798.ts  serve-sse-808.ts
       serve-v3-7798.ts  check-integrations.tsx

$ grep -oE "error TS2307: Cannot find module '[^']*'" … | sort | uniq -c | sort -rn
     86 error TS2307: Cannot find module 'pg'
     42 error TS2307: Cannot find module 'hono'
     10 error TS2307: Cannot find module 'hono/streaming'
      6 error TS2307: Cannot find module 'lz-string'
      1 error TS2307: Cannot find module '../../forge-control/node_modules/@hono/node-server'
      1 error TS2307: Cannot find module '../../forge-control/node_modules/hono'

$ ls -d forge-control/node_modules
ls: cannot access 'forge-control/node_modules': No such file or directory
```

`04-phases.md` §7 has said since round 0: *"Both packages are needed:
`forge-control-web` supplies `tsc`, React and the app types; `forge-control`
supplies `tsx`, `pg` and `hono`."* Only the script did not say it.

**Why this is a refusal and not 13 honest failures.** Every one of those
diagnostics is located outside `scripts/checks/`, so the profile-fidelity guard
fired 423 times and printed *"THE PROFILE IS WRONG, NOT THE APP … Fix
tsconfig.checks-instruments.json"* — sending the next reader to edit a correct
profile over an install they had never run, after 131 s. A gate that
misdiagnoses loudly is worse than one that refuses quietly.

### 8.3 The fix, and its four controls

`6c3dc9f` adds **step 3a**, a sibling of the `tsc` refusal, with two sentinels:
`pg` absent means no install at all; `@types/pg` absent while `pg` is present
means `NODE_ENV=production` pruned the devDependencies — the same `--prod=false`
trap the first refusal already teaches, in a costume that reads as an app type
error.

| Control | Tree state | Result |
|---|---|---|
| **G1** | nothing installed | refuses at `tsc` — unchanged behaviour |
| **G2** | `forge-control-web` only | **refuses at step 3a immediately**, naming the second install line — previously 131 s and a wrong diagnosis |
| **G3** | `forge-control` installed **without** `--prod=false` | pnpm printed `devDependencies: skipped because NODE_ENV is set to production` and exited 0; the gate refuses, naming `pg` present / `@types/pg` absent |
| **G4** | the chain obeyed verbatim | **PASSED, 42/42, exit 0, 138 s** |

`shellcheck -S error`: clean. `bash -n`: clean.

### 8.4 A6.1, re-run end to end on the merged tree

Fresh clone of merged `main`, path **`/tmp/cold-b7ab4c57-a61-final`**:

```
$ git clone /opt/forge-ai-os /tmp/cold-b7ab4c57-a61-final
$ git log --oneline -1
6c3dc9f fix(scripts-checks-typecheck-gate/phase 6, round 600): the cold tree needs BOTH dependency trees, and the gate named one
$ find . -maxdepth 4 -name node_modules -not -path './.git/*'
(nothing — genuinely cold)
```

**Refusal 1**, verbatim:

```
REFUSING TO RUN: no executable tsc at /tmp/cold-b7ab4c57-a61-final/forge-control-web/node_modules/.bin/tsc
…
  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
```

Run verbatim → `+ typescript 5.7.2`. **Refusal 2**, verbatim:

```
REFUSING TO RUN: no dependency tree at /tmp/cold-b7ab4c57-a61-final/forge-control/node_modules
…
  cd forge-control && pnpm install --frozen-lockfile --prefer-offline --prod=false
```

Run verbatim → `+ @types/pg 8.20.0`, `+ tsx 4.22.4`, `+ typescript 5.9.3`. Then:

```
$ time bash scripts/checks/check-instrument-typecheck.sh ; echo "EXIT=$?"
  ledger: scripts/checks/instrument-manifest.txt — 0 entry/entries, 0 error(s), 0 waived, 0 waived but clean
  ok: 0 waivers — the ledger is empty
  ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error
  ok: 0 diagnostics outside scripts/checks/, 0 unlocated diagnostics

  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 142s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT=0
real	2m21.484s

$ git status --porcelain
(empty)
```

**A6.1: PASS.** 42/42 green, exit 0, ledger empty, tree clean.

**Clones left in place for the reviewer** (the reviewer makes its own, separate
cold clone):

- `/tmp/cold-b7ab4c57-a61-final` — the authoritative A6.1 run, at `6c3dc9f`
- `/tmp/cold-b7ab4c57-a61` — the run that caught the defect, at `b757896`
- `/tmp/cold-b7ab4c57-guard` — the G1–G4 control tree
- `/tmp/cold-b7ab4c57-deploy` — the prior attempt's warm clone, untouched

---

## 9. STEP 8 — the universal gate on the merged tree

Run in `/opt/forge-ai-os` at `6c3dc9f`, per `docs/plan/engine-task-graph/03-quality.md` §4.

| # | Item | Result |
|---|---|---|
| 1 | `cd forge-control && pnpm typecheck` | **PASS** — exit 0 |
| 2 | `pnpm test` | **PASS** — `# tests 1293  # pass 1293  # fail 0` (239 suites) |
| 3 | `git -C /opt/forge-ai-os status --porcelain` | **EXCEPTION** — §6, one foreign file |
| 4 | `git log --oneline $(git merge-base main HEAD)..HEAD --name-only` | empty — `HEAD == main`, the branch is merged |
| 5 | R66 sweep | **PASS** — exactly **4** hits, every one read (below) |
| 6 | `grep -rn "consecutive rounds" forge-control/` | **PASS** — empty, exit 1 |
| 7 | `check-corpus-map.py` · `check-instrument-identity.py` | **PASS** — `R1..R71 and NF1..NF7 complete, all three statements agree`; `12 pasted header(s) … name fb5a6434…`, `33 pasted manifest line(s)`, exit 0 |
| 8 | `check-r20-census.py` | **PASS** — `R20 … PASS`, `REGION … PASS`, HEAD `6c3dc9f`, sha256 `79a62da9…` |
| 9 | `check-instrument-typecheck.sh` | **PASS** — 42/42, exit 0, **142 s** / `real 2m21.690s` |
| 10 | `shellcheck -S error` over the derived `*.sh` list | **PASS** — exit 0 |
| 11 | `bash scripts/check-schedule-sql.sh` | **PASS** — `# tests 40  # pass 40  # fail 0` |
| +902 | `check-screenshot-render-shapes.ts` | **PASS** — `ALL PASS — 16 checks` |

**Item 5 read in full.** The expectation in §4 is 4 hits, all string literals
inside NEVER-worded prohibitions; any hit in an executable position is a finding
regardless of count.

```
./forge-control/src/lib/project-tick.test.ts:217:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:218:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:427:    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
./forge-control/src/lib/project-tick.ts:588:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
```

Two are the shipped prohibitions themselves; two are a regex and its assertion
message checking that the shipped guidance still carries one. **None is in an
executable position.** Count unmoved at 4 — `6c3dc9f` adds prose to a `*.sh`
inside the sweep's scope and does not mention the command, so no restatement of
the tripwire is owed.

**Item 4, note.** On `main`, `merge-base main HEAD` is `HEAD`, so this is empty
by construction rather than by evidence. The meaningful listing is §2.2.

**Item 10, note.** The derived list `main..HEAD` is likewise empty post-merge.
Re-derived against the project base, it is
`docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh` and
`scripts/checks/check-instrument-typecheck.sh`; both present on disk, both clean
at `-S error`.

---

## 10. STEP 9 — every prior phase's criteria, re-measured on the merged tree

Nothing below is copied from a prior transcript.

### Phase 1

| # | Criterion | Command | Result |
|---|---|---|---|
| **A1.1** | the census reproduces | `bash …/evidence/reproduce-census.sh` | **PASS, with the expected shift** — see below |
| **A1.2** | zero diagnostics outside `scripts/checks/` | gate's fidelity section | **PASS** — `0 diagnostics outside scripts/checks/, 0 unlocated` |
| **A1.3** | `cd forge-control-web && pnpm typecheck` exit 0 | run | **PASS** — exit 0, no output |
| **A1.4** | `extends`, `paths` inside `@types/`, `typeRoots` present | parsed the profile | **PASS** — `extends: ./forge-control-web/tsconfig.json`; `typeRoots: ['./forge-control-web/node_modules/@types']`; all four non-`@/*` paths under `node_modules/@types/` and resolving |
| **A1.5** | U5 `typeRoots`-removed transcript | `evidence/phase1-profile.md` | present (historical) |
| **A1.6** | no `package.json` / lockfile change | §4 | **PASS** |
| **A1.7** | nothing but docs references the profile | grep | **PASS** — see note |

**A1.1 in detail.** The script exits 0 and emits 42 lines, every one 65
characters. **42 green, 0 red.** Diffed against round 0's baseline
`census-G-generated-perfile-config.txt`, it differs at **exactly six lines** —
and they are exactly the six instruments phase 3 fixed:

```
  round0: check-orientation.ts        rc=2  errors=3
  round0: check-team-confirm.ts       rc=2  errors=1
  round0: check-team-rows.ts          rc=2  errors=1
  round0: serve-sse-808.ts            rc=2  errors=2
  round0: check-dismiss-peek.tsx      rc=2  errors=2
  round0: check-stop-affordance.tsx   rc=2  errors=2
                        total errors = 11
```

**36 of 42 lines are byte-identical**, and the six that moved carry exactly the
**11 diagnostics** `00-vision.md` §3.2 enumerated. A1.1 was phase 1's criterion
against the *unfixed* tree (36 green / 6 red); on the merged tree the correct
answer is 42 green, and the diff is the proof that nothing else drifted.
`git status --porcelain` empty after the run.

**A1.7 note.** Outside `docs/`, three files name the profile:
`scripts/checks/check-instrument-typecheck.sh` (the gate — it must),
`tsconfig.checks.json` (D1.2's mandated cross-reference comment), and
`scripts/deploy/payload-review.json` (a reviewer brief, prose rendered into a
task, amended by phase 5 on purpose). No build config, no application code.

### Phase 2

| # | Criterion | Result |
|---|---|---|
| **A2.1** | found = compiled = `ls` count | **PASS** — `ls … \| wc -l` = **42**; census `subjects found 42   subjects compiled 42` |
| **A2.2** | exit 1 with exactly 6 failures | **historical** — that was phase 2's deliberate red end-state, before phase 3. On the merged tree the correct value is exit 0 / 0 failures, and the six are green (A3.1) |
| **A2.3** | provenance above the first PASS/FAIL, all R20 fields | **PASS** — `PROVENANCE` at line 8, first `PASS` at line 30; 12 fields incl. `this check sha256`, `profile sha256`, `tsc`, `node`, `git HEAD`, `git branch`, `temp dir`, `invocation` |
| **A2.4** | tree clean after a run, a failed run, and SIGINT | **PASS** — empty after all runs; SIGINT mid-run → **exit 130**, temp dir `/tmp/tmp.OBJu6ei1xk` **removed by the trap**, porcelain empty |
| **A2.5** | two runs identical modulo timing/temp; two concurrent both correct | **PASS** — X and Y launched concurrently, both `PASSED 42/42` exit 0, distinct temp dirs (`tmp.BWN1muw61t` / `tmp.qr8SCXZaGv`), transcripts **identical** after normalising temp path and wall clock |
| **A2.6** | correct verdict from another cwd by absolute path | **PASS** — run Z from `/` by absolute path: `PASSED 42/42`, exit 0, provenance resolved its own repo root correctly |
| **A2.7** | `shellcheck -S error` clean | **PASS** — exit 0 |
| **A2.8** | U7–U9, U12, U13 transcripts | present in `evidence/phase2-gate.md` |

### Phase 3

| # | Criterion | Result |
|---|---|---|
| **A3.1** | all 42 green under the profile | **PASS** — item 9 and A6.1 both 42/42 |
| **A3.2** | five runnable instruments exit 0 with `ALL PASS`; `serve-sse-808.ts` binds and proxies | **PASS** — see below |
| **A3.3** | six R29 breakage transcripts | present in `evidence/instruments-still-detect.md` |
| **A3.4** | P-A suppression grep empty | **PASS** — grep empty; the gate's own AST scanner: `0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error` |
| **A3.5** | nothing under `forge-control-web/app/` or `forge-control/src/` | **PASS** — `git diff --name-only 9b960ef...6c3dc9f` filtered: no hits |
| **A3.6** | each repaired fixture is a value the contract permits | checked at phase 3 against the type definitions |

**A3.2, measured.** The documented invocation is
`cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json …`:

```
check-orientation.ts      exit 0   ALL PASS — orientation strip derivation
check-team-confirm.ts     exit 0   ALL PASS — team confirm machine
check-team-rows.ts        exit 0   ALL PASS — team row model
check-dismiss-peek.tsx    exit 0   ALL PASS — dismissal peek affordance
check-stop-affordance.tsx exit 0   ALL PASS — stop affordance
```

*A first attempt with a bare `npx tsx` (no `--tsconfig`) failed the two `.tsx`
files with `Cannot find module 'react-dom/server'`. That is the operator's
invocation being wrong, not the instrument: `tsconfig.checks.json` exists
precisely to map the four react specifiers at the RUNTIME packages, and `npx`
also resolved tsx from the global cache. Recorded because a future reader who
runs the short form will see the same thing.*

`serve-sse-808.ts` — it refuses without an explicit port (`SERVE_SSE_PORT is
required — this harness has no default port on purpose`), which is the right
error path. With `SERVE_SSE_PORT=7845`:

```
[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
LISTEN 0  511  127.0.0.1:7845  0.0.0.0:*
direct  :7700 /api/today -> 200
proxied :7845 /api/today -> 200
BODIES IDENTICAL — the proxy works
```

Port released after the probe; 0 listeners on :7845.

### Phase 4

Controls (a) and (b) re-run in full; both mutations reverted with proof.

**Control (a) — a broken type in a covered instrument.**

```
$ printf '\nexport const __a4a_deploy_probe: number = "not a number";\n' >> scripts/checks/check-task-api.ts
$ bash scripts/checks/check-instrument-typecheck.sh   ->  EXIT=1
  FAIL scripts/checks/check-task-api.ts                 exit 2
         scripts/checks/check-task-api.ts(1302,14): error TS2322: Type 'string' is not assignable to type 'number'.
  subjects found 42   subjects compiled 42   type failures 1   …
$ git checkout -- scripts/checks/check-task-api.ts
$ git status --porcelain      (empty)      HEAD 6c3dc9f, unmoved
```

**Control (b) — a NEW type-broken file listed nowhere. A4.2, the project's
central claim.**

```
$ cat > scripts/checks/zz-deploy-control-b.ts   (untracked; 0 mentions in instrument-manifest.txt)
$ bash scripts/checks/check-instrument-typecheck.sh   ->  EXIT=1
  scanned …: 43 file(s); enumerated as subjects: 43
  subjects found   : 43
  FAIL scripts/checks/zz-deploy-control-b.ts            exit 2
         scripts/checks/zz-deploy-control-b.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.
  subjects found 43   subjects compiled 43   type failures 1   …
$ rm -f scripts/checks/zz-deploy-control-b.ts
$ git status --porcelain      (empty)      HEAD 6c3dc9f, unmoved
```

**A4.2: PASS — 43 subjects reported, the unlisted file found and failed.**
Coverage is by glob and cannot be forgotten.

**A4.3** re-proved by §8.4: both refusal lines run verbatim under
`NODE_ENV=production` leave a tree where the gate passes.
**A4.4** — every mutation reverted, tree clean, gate green at the end.
**A4.5** — wall clock recorded: §0.

### Phase 5

| # | Criterion | Result |
|---|---|---|
| **A5.1** | no document tells a reader to add a manifest line to get compiled | **PASS** — 5 hits, each read (below) |
| **A5.2** | the ledger is empty and its header says what it is for | **PASS** — 0 non-comment lines; gate prints `0 entry/entries … ok: 0 waivers — the ledger is empty` |
| **A5.3** | code and documentation in one commit | **PASS** — `229e084` carries the ledger, the gate and 8 corpus files together; `6c3dc9f` likewise carries script + `03-quality.md` |
| **A5.4** | every now-false location corrected or marked superseded | done at phase 5; `check-corpus-map.py` and `check-instrument-identity.py` green (item 7) |
| **A5.5** | R34 successor section names files and lines | verified at the phase-5 gate; §7 pins re-resolve |
| **R31** | identity clause | **PASS** — both `6c3dc9f` (below) |

**A5.1, each hit read rather than counted.** All five are the criterion's own
wording, a finding statement about it, or a transcript of the sweep — the
checker naming its own forbidden string. **None is an instruction:**

- `04-phases.md:328` — the criterion A5.1 itself: *"No document instructs a reader to add a line to the manifest…"*
- `phase5-ledger.md:877` — a pasted transcript quoting that same line
- `phase5-ledger.md:907` — the finding: *"**No document instructs a reader to add a line…**"*
- `phase5-gate.md:368` — *"### A5.1 — PASS. No document instructs a reader…"*
- `phase5-gate.md:391` — the `grep` command of the sweep, in a transcript

**R31 identity clause, re-measured:**

```
$ git log --format=%H -1 -- docs/plan/engine-task-graph/03-quality.md
6c3dc9f012052791dab63af7327594467af018a7
$ git log --format=%H -1 -- scripts/checks/check-instrument-typecheck.sh
6c3dc9f012052791dab63af7327594467af018a7
EQUAL — PASS
```

The clause was live before this task (both at `b757896`) and is live after it;
`6c3dc9f` moved the two together on purpose.

---

## 11. STEP 10 — restart: none needed, none performed

The diff touches no executor-loaded file (§2.3), so nothing needed restarting.

- **`pm2 restart forge-executor` was NOT run.** `pm2 jlist`, read after the
  merge at 20:22: `forge-executor  status=online  restarts=2  up since
  2026-08-18T08:34:28`. This task began at 19:24. Its uptime predates the task
  by eleven hours and its restart count did not move.
- **`pm2 restart forge-control` was NOT run**, and is stated here explicitly
  rather than done reflexively: it is the right tool for route/API changes and
  **this diff contains none** — no file under `forge-control/src/routes/`, none
  under `forge-control/src/` at all (A3.5). `forge-control  up since
  2026-08-18T07:17:39`, unchanged.
- **No `safe-restart.sh` was launched.** `/tmp/safe-restart.log` carries no
  entry from this task; the file predates it.

---

## 12. Undeclared writes, disclosed

This task's declared `write_set` is
`docs/plan/scripts-checks-typecheck-gate/evidence/phase6-deploy.md` **alone**.
Two files outside it were written, both in commit `6c3dc9f`:

| File | Why it had to change |
|---|---|
| `scripts/checks/check-instrument-typecheck.sh` | **NF5 / A6.1 is a requirement phase 6 OWNS** (`04-phases.md` §8) and was measurably false: on a cold clone the gate's own install line, run verbatim, left it red. Reporting the criterion failed and merging anyway would ship a gate no fresh clone can pass. |
| `docs/plan/engine-task-graph/03-quality.md` | **R31 forbids moving the gate script without it in the same commit**, and §3.1 item 9 plus the §4 command block both had to state the two-package requirement. Leaving it would have falsified a criterion that passes today. |

Recorded per `03-quality.md` §3.1 item 4 — the rule is disclose, not abstain.
Both are disclosed at the site (the commit message of `6c3dc9f` states them
under `UNDECLARED WRITES`) and here.

*One further note for completeness: `rm -rf` was used once, on
`/tmp/cold-b7ab4c57-guard`, immediately before creating that scratch clone. The
path did not exist — the clone that followed succeeded, which is only possible
against an empty target — so nothing was destroyed. No repository, no clone and
no file belonging to anyone was deleted at any point in this phase; the prior
attempt's warm clone at `/tmp/cold-b7ab4c57-deploy` was deliberately left in
place.*

---

## 13. Acceptance criteria of phase 6

| # | Criterion | Verdict |
|---|---|---|
| **A6.1** | cold tree: refuses with the install line, that line run verbatim, then 42/42 green | **PASS** — after `6c3dc9f`. It **failed** on the merged tree before it, and that failure is the finding of this phase (§8) |
| **A6.2** | universal gate items 1–11 green on the merged tree | **PASS**, except item 3 → A6.3 |
| **A6.3** | `git status --porcelain` empty in `/opt/forge-ai-os` | **EXCEPTION** — one foreign file, `forge-control-web/app/desktop/chat/AssistantThread.tsx`, named and escalated, not touched (§6) |
| **A6.4** | no `package.json` or lockfile change | **PASS** (§4) |
| **A6.5** | wall clock of a full gate run stated | **PASS** — 142 s / `real 2m21.5s` (§0) |
