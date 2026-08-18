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
