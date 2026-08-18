# Phase 4 GATE — A4.1–A4.5, the four negative controls re-measured

**Tip reviewed:** `9c40765893010d61f76ee3e28d22c12bab1c3af1`, branch
`project/b7ab4c57`. Re-read immediately before each blocker below was written —
**unchanged**. Every claim in this document is a command run in this worktree
(`/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`) with its
output quoted. Nothing here is a quotation of a builder's document offered as
proof of itself.

**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
(the per-project layout). `docs/plan/03-quality.md` also exists — it is the older
repo-wide corpus, superseded for this project — and I read both before choosing.
The phase-4 protocol is §5 of the per-project document; the phase-4 gate block is
its "Phase 4 gate — the negative controls".

**Dependencies, before any gate run:**

```
$ cd forge-control-web && NODE_ENV=production pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 972ms using pnpm v9.15.9

$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
```

`Already up to date` with **no** `- typescript` line, and a `tsc` that answers —
the distinction that matters under `NODE_ENV=production`, and the one control (c)
measures from the other side.

**Live-checkout cleanliness (mandatory):**

```
$ git -C /opt/forge-ai-os status --porcelain
(no output)
```

Empty. No work was hot-applied into the live checkout.

---

## 0. THE GOVERNING SENTENCE, applied to me

A gate cannot certify itself, and a reviewer cannot certify a transcript by
reading it. So this document establishes, by measurement:

1. that each of the four transcripts **contains** the gate's real unfiltered
   output rather than a description of it (§1, structural checks);
2. that the four are byte-identical reproductions inside `negative-controls.md`
   (§6, re-run split and sha256);
3. that the central claim — control (b) — is true when **I** run it, not when the
   builder reports it (§2, my own transcript in full).

---

## 1. A4.1 — the five steps, control by control

Protocol (`03-quality.md` §5): 1. green before, with exit code. 2. the mutation
SHOWN. 3. the FULL unfiltered failing output plus the exit code. 4. the revert,
with `git status --porcelain` shown. 5. green after.

| | 1 green before | 2 mutation shown | 3 full output + exit | 4 revert + porcelain | 5 green after | Verdict |
|---|---|---|---|---|---|---|
| **(a)** | ✔ `EXIT=0`, 84-line transcript, 42/42 (`negative-controls-a.md:53–155`) | ✔ `git diff` hunk `@@ -353,3 +353,4 @@` (`:157–190`) | ✔ `EXIT=1`, full 84-line transcript, `TS2322` at (356,14) (`:192–286`) | ✔ `git checkout --` + porcelain + `git diff --stat` empty (`:367–402`) | ✔ `EXIT=0`, 42/42 (`:404–514`) | **PASS** |
| **(b)** | ✔ `EXIT=0`, 42/42 (`negative-controls-b.md:75–181`) | ✔ `ls -l` (379 B) + `cat` + porcelain `??` + `grep` exit 1 + repo-wide grep (`:183–281`) | ✔ `EXIT=1`, full transcript, **43** subjects, `TS2322` at (5,14) (`:283–378`) | ✔ `rm` + porcelain + `ls` absent (`:514–558`) | ✔ `EXIT=0`, 42/42, `diff` vs step 1 (`:560–682`) | **PASS** |
| **(c)** | ✔ `EXIT=0`, 42/42 (`negative-controls-c.md:104–203`) | ✔ `ls` of `forge-control-web/`, `du -sh` 919 M at the aside path, `.bin/tsc` gone, porcelain (`:205–256`) | ✔ `EXIT=1`, the refusal in full, `cat -A` of the printed line (`:258–383`) | ✔ the printed line run verbatim under `NODE_ENV=production`, then porcelain + `git check-ignore` (`:385–494`); second porcelain after cleanup (`:618–645`) | ✔ `EXIT=0`, 42/42, `diff` vs step 1 = temp dir + wall clock only (`:496–616`) | **PASS** |
| **(d)** | ✔ `EXIT=0`, 42/42 (`negative-controls-d.md:113–212`) | ✔ `git diff` of the profile, plus `jq` proving the JSON still parses and the `//typeRoots` comment survived (`:214–261`) | ✔ `EXIT=1`, the refusal in full — 34 lines, no TYPECHECK, no CENSUS (`:263–347`); plus step 3b, the profile-level census (`:349–701`) | ✔ `git checkout --` + porcelain + `sha256sum` restored to `837f087c…` + `jq` typeRoots back (`:703–732`) | ✔ `EXIT=0`, 42/42, `diff` vs step 1 = temp dir + wall clock only (`:734–850`) | **PASS** |

**No control is voided.** All four carry all five steps. I did not average
anything: each cell above is a line range I opened.

### 1.1 Structural checks — is step 3 the gate's output, or a summary of it?

A described-not-run control fails these. All four pass them.

**Does each step-3 block carry the gate's own furniture?** Measured across the
four originals: every block opens with the two-line banner and the
`coverage: every file matching …` line, then `COVERAGE`, then `PROVENANCE`
(worktree path, git HEAD, the check's own sha256, the profile's sha256, `tsc`
version + absolute path, `node` version + path, subjects found, invocation form,
`mktemp` dir), then `SELF-TEST` with its named canaries, then per-subject
`PASS`/`FAIL` lines, then `SUPPRESSIONS`, `PROFILE FIDELITY`, `CENSUS` and the
verdict line. Control (d)'s step 3 is the one exception **by construction** — it
stops after canary 3, which is the result being reported, and its transcript is
34 lines against step 1's 84. A summary would carry none of this.

**Is each tally internally consistent with the subject count in the same block?**

| Block | subjects found | PASS lines | FAIL lines | sum | verdict line |
|---|---|---|---|---|---|
| (a) step 3 | 42 | 41 | 1 | 42 ✔ | `FAILED — 1 type failure(s)` |
| (b) step 3 | **43** | 42 | 1 | **43** ✔ | `FAILED — 1 type failure(s)` |
| (c) step 3 | — (refusal before enumeration is reported) | — | — | — | `REFUSING TO RUN: no executable tsc` |
| (d) step 3 | 42 found, **0 compiled** | 0 | 0 | ✔ | `REFUSING TO RUN: the compiler self-test failed` |

Each control also states its own arithmetic mechanically rather than by eye —
(a) at `:350–356`, (b) at `:455–461` — with `grep -c '^  PASS '` counts quoted.

**Do the green runs differ where real runs differ and agree where they must?**
I extracted every fenced block containing a `PROVENANCE` header from the four
originals and hashed them:

```
$ python3  # eleven gate-output blocks extracted from the four originals, sha256, first 12 hex
af86efc5a16f ('a', 83 lines)      709d0c68531f ('b', 83)      81d28dd5afad ('c', 83)      21d3d07b0c15 ('d', 84)
c009510b9e2c ('a', 84)            7754b571d6dc ('b', 85)      a8a05c12656d ('c', 83)      7e9b4f33aa06 ('d', 34)
a42ca597c585 ('a', 83)            e69bf1075491 ('b', 83)                                  6ab67dd95f4d ('d', 84)
```

**Eleven blocks, eleven distinct hashes — no two byte-identical.** Where they
must vary they do: eleven distinct `mktemp` directories (`tmp.41m9S7IFe2`,
`tmp.NRM9yiPT9s`, `tmp.GVgB8THtS0`, `tmp.uR18wbj4Sd`, `tmp.L9ilOiheU4`,
`tmp.8LYzUfZaKt`, `tmp.JdYVWBDicY`, `tmp.LgL9jMGqMt`, `tmp.8dovsDqvYD`,
`tmp.LkuWDmU6iD`, `tmp.BcxV9e9Ia3`) and ten distinct wall clocks (151–177 s).
Where they must agree they do: `tsc Version 5.7.2` at the same absolute path and
`node v22.22.2` in all eleven; `subjects found 42` in all but (b)'s mutated run,
which reads 43. The `git HEAD` line advances `3b90700 → bedda20 → dda76d8 →
1ef8ef4` in step with each control's own commit, and the profile sha256 moves
`837f087c… → 6067d1e2…` exactly across (d)'s mutated run and back — so the
refusing run is provably the mutated one and the greens either side provably are
not. Two runs pasted twice would collide on at least one of these; none do.

---

## 2. A4.2 — control (b), re-measured by me, end to end

**This is the criterion the project's central claim rests on.** I ran the whole
five-step sequence myself in this worktree, at tip `9c40765`, with a file of my
own construction — deliberately a different length from the builder's, so that
the diagnostic's *line number* has to come from my file and cannot be inherited
from theirs.

Script: `/tmp/reviewer-control-b.sh`. It creates and removes exactly one path,
`scripts/checks/zz-control-b.ts` — the removal explicitly authorised by my brief,
that path only, the file I created. Raw output follows, unedited:

```

===== 0. TREE STATE BEFORE =====
$ git rev-parse HEAD
9c40765893010d61f76ee3e28d22c12bab1c3af1
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
(end)

===== 1. GATE, GREEN BEFORE =====
$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 9c40765893010d61f76ee3e28d22c12bab1c3af1
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.LH4aQZyxR8

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
EXIT CODE: 0

===== 2. MUTATION APPLIED AND SHOWN =====
$ ls -l scripts/checks/zz-control-b.ts
-rw-r--r-- 1 root root 222 Aug 18 16:25 scripts/checks/zz-control-b.ts
$ cat scripts/checks/zz-control-b.ts
// Reviewer's negative control (b): a NEW file in scripts/checks/, listed in no
// manifest, carrying a deliberate type error. Removed at the end of this run.
export const controlB: number = 'this string is not a number';
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
?? scripts/checks/zz-control-b.ts
$ grep -c zz-control-b scripts/checks/instrument-manifest.txt
0

===== 3. GATE UNDER THE MUTATION — FULL UNFILTERED OUTPUT =====
$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 43 file(s); enumerated as subjects: 43
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 9c40765893010d61f76ee3e28d22c12bab1c3af1
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 43
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.eIbS9l8POl

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
         scripts/checks/zz-control-b.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.
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
  wall clock       : 155s

check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 0 uncovered file(s), 0 suppression(s), census mismatch 0.
EXIT CODE: 1

===== 4. REVERT =====
$ rm scripts/checks/zz-control-b.ts
$ ls scripts/checks/zz-control-b.ts
ls: cannot access 'scripts/checks/zz-control-b.ts': No such file or directory
(ls exit: 2)
$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md
(end of porcelain)

===== 5. GATE, GREEN AFTER =====
$ bash scripts/checks/check-instrument-typecheck.sh
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)
coverage: every file matching scripts/checks/**/*.ts scripts/checks/**/*.tsx, enumerated at run time

COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 9c40765893010d61f76ee3e28d22c12bab1c3af1
  git branch       : project/b7ab4c57
  this check       : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/scripts/checks/check-instrument-typecheck.sh
  this check sha256: 4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67
  profile          : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2  (/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control-web/node_modules/.bin/tsc)
  node             : v22.22.2  (/usr/bin/node)
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.R66FPMyJ1A

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
  wall clock       : 162s

check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.
EXIT CODE: 0

===== SUMMARY =====
step1 rc=0  step3 rc=1  step5 rc=0
DONE
```

### 2.1 What my run establishes, and how it compares with the builder's

| A4.2 requirement | My measurement | Builder's transcript | Agree? |
|---|---|---|---|
| the gate exits **non-zero** | `EXIT CODE: 1` | `EXIT=1` | ✔ |
| it **names** `zz-control-b.ts` | `FAIL scripts/checks/zz-control-b.ts   exit 2` | same line | ✔ |
| it reports **43 subjects** | `43 file(s); enumerated as subjects: 43`; `subjects found : 43`; `subjects found 43   subjects compiled 43` | identical three restatements | ✔ |
| the other 42 still reported | 42 `PASS` lines + 1 `FAIL` = 43 | 42 + 1 = 43 | ✔ |
| green before / green after | `EXIT CODE: 0` / `EXIT CODE: 0`, 42/42 both | `EXIT=0` / `EXIT=0`, 42/42 | ✔ |

**The one place my run must differ from theirs, and does.** My control file
carries a two-line header where the builder's carries four, so the type error
sits on line 3 of mine and line 5 of theirs. The gate reported:

```
mine:      scripts/checks/zz-control-b.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.
builder's: scripts/checks/zz-control-b.ts(5,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

Same code, same column, **different line** — each matching the file that was
actually on disk when that run happened. A transcript that had been copied,
synthesised or re-used would have carried the other file's line number. This is
the single strongest piece of evidence in this review that control (b) was run
and not written.

**Two further agreements my run reproduces independently.** `zz-control-b.ts`
appears in the sorted table **between** `serve-v3-7798.ts` and
`check-chat-rich.tsx` in both runs — it slots into the middle of the `.ts` run
because it is a member of a globbed set, not appended to a list. And every
post-failure section still ran in both: `SUPPRESSIONS`, `PROFILE FIDELITY`,
`CENSUS` and the verdict line all appear below the `FAIL`, so the loop did not
abort on the broken subject and leave the five `.tsx` files unmeasured.

**My run does not contradict the transcript in any particular. A4.2: PASS.**
The project's central claim holds: coverage is structural. 42 → 43 without a
single list being edited, and the manifest — which I read at HEAD and which still
names seven paths, none of them mine — had nothing to do with it.

```
$ grep -c zz-control-b scripts/checks/instrument-manifest.txt
0
```

---

## 3. A4.3 — the install line, measured against the gate's source

The gate's own occurrences, from my own grep at tip `9c40765`:

```
$ grep -n 'pnpm install' scripts/checks/check-instrument-typecheck.sh
210:#       `pnpm install --frozen-lockfile` says "skipping devDependencies"
448:  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
451:NODE_ENV=production; under it a plain \`pnpm install --frozen-lockfile\` prints
1073:  echo "  Install as step 3 says: cd forge-control-web && pnpm install --frozen-lockfile --prod=false" >&2

$ sed -n '448p' scripts/checks/check-instrument-typecheck.sh | cat -A
  cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false$
```

Line 448 is the line the no-compiler refusal prints, and therefore the line
control (c) is about. Byte-identity, computed by me rather than quoted from the
control:

```
$ sed -n '448p' scripts/checks/check-instrument-typecheck.sh | sed 's/^  //' | sha256sum
6d2c3eba8cc0f64a68e720fe395a9ad0d91ed6125a99d061878d3b6ec139a52d  -

$ grep -m1 -o 'cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false' \
    docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md | sha256sum
6d2c3eba8cc0f64a68e720fe395a9ad0d91ed6125a99d061878d3b6ec139a52d  -
```

One sha256 across the source line and the line the control quotes as printed —
and it is the same `6d2c3eb…` the control claims. It carries `--prod=false`, it
carries `pnpm`, and `cat -A` shows no trailing whitespace on either side.

**Was it run VERBATIM with `NODE_ENV=production` exported, and did the gate pass
afterwards?** `negative-controls-c.md:385–494` shows, in this order: `echo
"NODE_ENV=$NODE_ENV"` → `NODE_ENV=production`; `ls -l …/.bin/tsc` → absent; the
line itself, unmodified; exit 0; an output block headed **`devDependencies:`**
containing `+ typescript 5.7.2`; `.bin/tsc` present; `tsc --version` →
`Version 5.7.2`; `git status --porcelain` unchanged; `git check-ignore -v` proving
why. Then §5 (`:496–616`) runs the gate: exit 0, 42/42, and its `diff` against
step 1 differs only in the `mktemp` name and the wall clock — **including both
sha256 lines**, so the tree the prescribed install rebuilt is indistinguishable
from the one that was moved aside. The reinstall step is present, not skipped.

**A4.3: PASS.**

**Recorded, not held against the control.** Line 1073 is a *second*, different
refusal — the one reached when the suppression scanner has no TypeScript parser —
and it prescribes the same fix minus `--prefer-offline`, so the two refusals are
not byte-identical to each other. Control (c) found this itself, at `:373–383`,
states it plainly, and correctly declines to turn it into a finding: that line
still carries `--prod=false`, so it teaches nothing dangerous, and control (c)
does not exercise it. I agree with that adjudication. It is phase 5's to
reconcile if it wants one string.

---

## 4. A4.4 — the closing state, verified now, by me, at tip `9c40765`

```
$ git rev-parse HEAD
9c40765893010d61f76ee3e28d22c12bab1c3af1

$ git status --porcelain
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase3-redteam.md

$ ls scripts/checks/zz-control-b.ts
ls: cannot access 'scripts/checks/zz-control-b.ts': No such file or directory

$ ls -d /opt/ai-os/workspace/.phase4-nm-aside
ls: cannot access '/opt/ai-os/workspace/.phase4-nm-aside': No such file or directory

$ ls -d forge-control-web/node_modules
forge-control-web/node_modules
```

No mutation survives. Control (b)'s file is gone — including the copy **I**
created minutes earlier. Control (c)'s 919 MB aside path is gone. The compiler is
in place.

**No gate, profile or instrument edit survived phase 4** — the check that would
catch a control "made to pass". Compared against the phase-3 tip `3b90700`:

```
$ diff <(git diff --name-only main...HEAD    -- scripts/checks tsconfig.checks-instruments.json) \
       <(git diff --name-only main...3b90700 -- scripts/checks tsconfig.checks-instruments.json)
(no output — identical file lists)

$ git diff --stat 3b90700..HEAD -- scripts/checks tsconfig.checks-instruments.json
(no output — untouched by phase 4)
```

Not merely the same list of files: the same **content**. Phase 4 changed nothing
under `scripts/checks/` and nothing in the profile. Confirmed from the other
direction by the commits themselves:

```
$ git log --name-only --format='COMMIT %h %s' 3b90700..HEAD
COMMIT 9c40765 …assembled, with the wall-clock of a full run
  docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md
COMMIT 1ef8ef4 …control d
  docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-d.md
COMMIT dda76d8 …control c
  docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-c.md
COMMIT 89c3849 …control b
  docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-b.md
COMMIT bedda20 …control a
  docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls-a.md
```

Five commits, five documents, one each, no code.

**The gate is green at the end** — not on the builder's word but on mine: step 5
of my own control-(b) run above, at this tip, `EXIT CODE: 0`,
`check-instrument-typecheck.sh PASSED — 42/42 subjects compiled clean.`, every
counter zero and all five self-test canaries `ok`.

**A4.4: PASS**, with one qualification stated rather than smoothed. `git status
--porcelain` is **not** literally empty: it carries two untracked files,
`evidence/phase3-gate.md` and `evidence/phase3-redteam.md`. Every control
discloses them identically and accurately — they predate phase 4, no control
created or removed them, and none is in any phase-4 commit. As phase-4 residue,
there is none. As a project fact they are a finding, and I raise them as one in §9
below, because of what is *inside* them.

---

## 5. A4.5 — the wall clock

`negative-controls.md` §5 records one full run, timed by the assembling task:
`real 2m32.097s` = **152.1 s**, cross-checked against the gate's own printed
`wall clock       : 152s` and `EXIT=0` over 42/42. The section states, in terms,
that the number is **recorded and not gated** ("No threshold anywhere in this
project compares against it") and that the remedy for a slow gate is batching
subjects, "and NEVER a reason to narrow coverage… Narrowing coverage to buy speed
rebuilds the exact hole this project exists to close." Both required statements
are present, in the document, not merely implied.

My own three runs at this tip corroborate the magnitude independently:

| run | wall clock (the gate's own line) |
|---|---|
| my step 1 (green, 42 subjects) | **153 s** |
| my step 3 (red, 43 subjects) | **155 s** |
| my step 5 (green, 42 subjects) | **162 s** |

153/155/162 against the recorded 152, inside the 151–177 s spread the four
controls' eleven runs already show. **A4.5: PASS.**

---

## 6. Control (d) — is the reconciliation honest?

Control (d) is the one control that does not test the gate; it tests whether a
comment in `tsconfig.checks-instruments.json` is true. Three judgements were
asked of me.

**(i) Is the canary refusal correct rather than a defect, and does the document
say so?** Yes, and yes. Removing `typeRoots` is precisely the condition canary 3
exists to detect, so the gate refuses at the self-test having compiled 0 of 42 —
a *stronger* outcome than the ~30 red subjects the comment predicts, because the
gate declines to certify anything at all under a profile it has just watched
misbehave. The document leads with this (`negative-controls-d.md:32–56`), calls
it "the correct behaviour and… itself the control's first result", and states
what it did **not** do: "Suppressing canary 3 to reach the subjects would have
meant editing the gate — phase 2's frozen artifact — to make a phase 4 document
tidier, which is the exact trade this project exists to refuse." I checked that
claim rather than accepting it: `git diff --stat 3b90700..HEAD -- scripts/checks`
is empty (§4). The gate was not touched.

**(ii) Is the 12/30 census reproduced separately via `reproduce-census.sh`?** Yes
(`:349–440`), one `tsc` per subject through the still-mutated profile, with the
whole table quoted, both `awk` counts shown, and stderr's 173 lines quoted whole.

**(iii) Is the discrepancy stated or smoothed?** **Stated, in the strongest form
available.** The measurement came out **13 green / 29 red**, not the corpus's
12/30. The document prints a three-row table putting its own number beside the
comment's and phase 1's, then: *"SAY IT PLAINLY: 13 green / 29 red, not 12 green /
30 red. The document records what was measured. The profile and its comment were
NOT edited to match — corpus amendment is phase 5's, and a builder who 'fixes' a
comment to agree with his own run has destroyed the only record of the
disagreement."* It then identifies the single moved file by set difference
(`serve-sse-808.ts`, with `comm` shown in both directions and nothing moving the
other way), explains the mechanism with a `--listFiles` probe (67 `@types/node`
declaration files reachable in that program, 0 in `check-close-gate.ts`'s under
the identical mutated profile), and lands on the honest generalisation — that 12
was never a stable number, and what is invariant is *which kind* of instrument
goes red. It lists the four corpus locations phase 5 must amend, and correctly
exempts `03-quality.md` §5, which attributes its number to round 0 and is true as
written.

It also volunteers an incidental defect it was not asked for and does not own:
`reproduce-census.sh` fires `ABORTED at line 137 — this census is NOT a
reproduction.` once per red subject, because `set +e` disables `errexit` but not
the `ERR` trap. Cosmetic, correctly attributed to phase 1, recorded for phase 5,
not silently fixed.

**This is what a control that found an inconvenient number is supposed to look
like.** Control (d): **PASS.**

---

## 7. Does `negative-controls.md` reproduce the four originals verbatim?

The assembled document claims it does and quotes a proof. A gate cannot certify
itself, so I re-ran the split myself, against the file at HEAD:

```
$ awk 'BEGIN{n=0} /^# Phase 4, control \(/{n++} {print > ("/tmp/rv-split-" n ".part")}' \
    docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md
$ wc -c /tmp/rv-split-1.part /tmp/rv-split-2.part /tmp/rv-split-3.part /tmp/rv-split-4.part
 30025 /tmp/rv-split-1.part
 38734 /tmp/rv-split-2.part
 36977 /tmp/rv-split-3.part
 56249 /tmp/rv-split-4.part
161985 total
$ sha256sum /tmp/rv-split-{1,2,3,4}.part
a213722e86a3c247178605c5c23778e039a0be61cb4be16578b5a52317e1c47a  /tmp/rv-split-1.part
942b2bfa2db95eb8d4538ff6223315df4f1baf3edd5f6e49a37c509018568eb8  /tmp/rv-split-2.part
fedf7ea5cd3f531ff43a38a8c04244e6b9acd34c7eed3eeebfc6827f60d936db  /tmp/rv-split-3.part
9db3a6bb941e4a9e83511050183dee07aad6b82469ff24400999a00eb1671822  /tmp/rv-split-4.part
$ sha256sum negative-controls-{a,b,c,d}.md
a213722e86a3c247178605c5c23778e039a0be61cb4be16578b5a52317e1c47a  negative-controls-a.md
942b2bfa2db95eb8d4538ff6223315df4f1baf3edd5f6e49a37c509018568eb8  negative-controls-b.md
fedf7ea5cd3f531ff43a38a8c04244e6b9acd34c7eed3eeebfc6827f60d936db  negative-controls-c.md
9db3a6bb941e4a9e83511050183dee07aad6b82469ff24400999a00eb1671822  negative-controls-d.md
```

Four byte counts and four sums, matching the originals, in order (a), (b), (c),
(d). I also diffed the segments against the originals in Python, line by line
rather than by hash alone, to rule out a hash quoted from the wrong file: the
segments are equal to the originals after stripping only the trailing separator
rule the assembler adds between parts. **Reproduced verbatim, in order, without
editorial improvement.** The header — everything above part (a)'s H1 — is the
only prose the assembling task wrote, which the split makes auditable by
construction.

One consequence of sealing the originals rather than improving them is worth
naming for phase 5, not for a fix here: control (d) says of the profile comment's
citation that *"there is no `negative-controls.md`"*. That was true at commit
`1ef8ef4`. Commit `9c40765` created it. Editing the sealed transcript to keep up
would be worse than the staleness; the corpus amendment belongs in phase 5.

---

## 8. Write-set audit

Declared write-sets read from the task rows (`GET /api/projects/b7ab4c57…`,
`metadata.write_set` — declared on the row, not reconstructed from briefs),
against what each task's commits actually touched:

| Task | Declared write_set | Commit | Files actually touched | Undeclared |
|---|---|---|---|---|
| Control (a) | `evidence/negative-controls-a.md` | `bedda20` | `evidence/negative-controls-a.md` | none |
| Control (b) | `evidence/negative-controls-b.md` | `89c3849` | `evidence/negative-controls-b.md` | none |
| Control (c) | `evidence/negative-controls-c.md` | `dda76d8` | `evidence/negative-controls-c.md` | none |
| Control (d) | `evidence/negative-controls-d.md` | `1ef8ef4` | `evidence/negative-controls-d.md` | none |
| Assemble | `evidence/negative-controls.md` | `9c40765` | `evidence/negative-controls.md` | none |

**Zero undeclared writes.** Every commit touches exactly the one path its task
declared. Nothing to disclose and proceed past.

**Project-level checks from `03-quality.md` §3 (run on both, at this tip):**

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
    | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)' \
    && echo "FAIL: suppression introduced" || echo "ok: no suppressions"
ok: no suppressions                                                    # P-A

$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml' | wc -c
0                                                                      # P-B, NF8
```

---

## 9. The gate suite

This project ships one: `scripts/checks/gates-808.sh`. Run with `--strict`, its
documented gating invocation, at tip `9c40765`:

```
$ bash scripts/checks/gates-808.sh --strict
…
================================================================================
 SUMMARY — 25 gates
================================================================================
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)
 13 0      check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does
 14 0      check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces
 15 0      check-team-rows.ts — flatten, hiddenRows, frozen time
 16 0      check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)
 17 1      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
 22 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 1
GATES808 EXIT=1
```

**25 gates defined, 23 EXECUTED, 2 SKIPPED-by-design** (23 and 24 need the
`--browser` harness; they announce the skip, they are not silently omitted),
**1 RED**, suite exit **1**.

Gate 17, verbatim:

```
########## GATE 17 — verify-notification-gap-pins.mjs — fenced quotes + prose pins ##########
$ node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs | tail -2

8 FAILURE(S) — 78/78 pins in docs/plan/notification-gap.md classified (11 fenced quotes, 12 prose, 4 live, 7 cross-doc, 25 repeat, 19 historical).
Denominator = every `path.ext:NNN` and every bare `:NNN` citation in docs/plan/notification-gap.md, fenced or not. Outside it: pins carrying no line number, and other documents' pins into this one.

EXIT=1
```

**Attribution, measured rather than assumed.** Neither the checker nor its
subject is on this branch:

```
$ git diff --name-only main...HEAD | grep -E 'notification-gap|verify-notification-gap-pins'
(no output — grep exit 1)

$ git log -1 --format='%h %ad %s' --date=short -- docs/plan/notification-gap.md \
    docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs
0bfe05c 2026-08-17 fix(round1875): gate suite back to RED:0 — two rounds' unlisted hits, one file's rotted pins
```

Pre-existing on `main`, outside this project's write-set, and — note the commit
subject — last "fixed to RED:0" the day before. I did **not** widen the gate, add
an allowlist, or scope a waiver to clear it. The standing rule in my brief is
unambiguous: *a nonzero exit BLOCKS the PASS.* Phase 3's gating reviewer reached
the same conclusion on the same gate and issued FAIL for it; nothing has changed
since.

---

## 10. Findings

### BLOCKER 1 — the suite is red at HEAD: `gates-808.sh --strict` exits 1

`docs/plan/notification-gap.md` (checker
`docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`), 8 failures over
78 pins, suite exit 1, measured by me at `9c40765` and pasted in §9.

Not phase 4's regression, and not phase 4's to fix — but a red suite blocks a
PASS by the rule I am given, and this project has now carried the same red past
two consecutive phase gates without it being recorded anywhere on the branch.
*Smallest change:* the project that owns `notification-gap.md` repairs the 8
pins; or the corpus records an explicit **sentence-scoped** waiver naming those
eight pins by line, so that any other violation in the same file still fails.
Never a file-level or token-level allowlist, and never silence.

### BLOCKER 2 — phase 3's gating verdict is `FAIL`, its evidence is uncommitted, and its code blocker is still open at HEAD

`docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md:988` reads
`VERDICT: FAIL`; `evidence/phase3-redteam.md:802` reads `VERDICT: NEEDS_FIXES`.
**Both files are untracked** — they are the two `??` lines every phase-4 control
disclosed, and the reason a reader of the *branch* cannot tell that phase 3 was
failed at all. Phase 4 depends on phase 3.

Its blocker 1 is a live claim in shipped code, and I confirmed it is unchanged at
this tip rather than taking the reviewer's word:

- `scripts/checks/check-dismiss-peek.tsx:123–130` — the comment on `hidesRows`
  still reads *"Anything above 1 would render the two-click cascade ✕"*;
- `scripts/checks/check-stop-affordance.tsx:117–125` — the comment still reads
  *"A value above 1 would put the settled row's ✕ into the two-click cascade
  machine"*;
- `git diff --stat 3b90700..HEAD -- scripts/checks` → empty, so neither comment
  has been amended since the FAIL was written.

This is the exact failure this project exists to name — an instrument whose
comment claims more coverage than it checks — and it is currently invisible to
anyone reading the branch. *Smallest change:* (i) commit the two phase-3 evidence
documents so the FAIL is on the record; (ii) run the phase-3 fix cycle its
reviewer's finding 1 prescribes — replace the second half of each comment with
the measured truth, by addendum to `6bdd24a`, not by rewriting history; (iii)
re-run the phase-3 gate. Phase 4's artifacts survive all of this untouched: they
neither depend on those two comments nor are invalidated by amending them.

### NOTE 1 — `git status --porcelain` is not literally empty after any control

Consequence of BLOCKER 2, not a defect of the controls. Every control discloses
the two files by name, identically, and accurately; none created, removed or
committed them. Once BLOCKER 2 is cleared the porcelain goes empty on its own.

### NOTE 2 — two install lines in one gate

`check-instrument-typecheck.sh:448` prints `--prefer-offline`, `:1073` does not.
Both carry `--prod=false`, so neither teaches the trap. Control (c) found and
disclosed this itself. For phase 5, if it wants one string.

---

## 11. Verdict

**Phase 4's own work is sound and I could not break it.** All five protocol steps
are present in all four controls; no control is voided. The transcripts contain
the gate's real, unfiltered output — eleven distinct gate-output blocks, none a
duplicate of another, varying in `mktemp` path and wall clock and agreeing on
`tsc`, `node` and subject count exactly where they must. The assembled document
reproduces the four sealed originals byte for byte, which I re-verified by
re-running the split. Control (b) — the claim the whole project rests on — is
true when I run it myself with a file of my own: exit 1, `zz-control-b.ts` named,
**43** subjects, and a diagnostic on *my* line number. Control (d) reports a
number that disagrees with the corpus and says so in bold rather than smoothing
it. The write-set audit is clean: five tasks, five declared paths, five commits,
zero undeclared writes. A4.1, A4.2, A4.3, A4.4 and A4.5 all pass on the evidence
I measured.

What blocks the phase is not in the negative controls. It is the tree they were
measured in: the gate suite is red at HEAD, and phase 3's gating reviewer's
`VERDICT: FAIL` — together with the code finding behind it — is sitting untracked
in this worktree while the project builds on top of it.

**A4.1 PASS · A4.2 PASS · A4.3 PASS · A4.4 PASS · A4.5 PASS · gate suite RED (1/23
executed) · phase-3 gate FAIL unrecorded and unremediated.**

VERDICT: FAIL

1. `docs/plan/notification-gap.md` (checker `docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`) — `gates-808.sh --strict` exits 1 with 8 failures over 78 pins (§9). Fix the pins, or record a sentence-scoped waiver naming those eight; never a file-level allowlist.
2. `docs/plan/scripts-checks-typecheck-gate/evidence/phase3-gate.md` and `evidence/phase3-redteam.md` — untracked at HEAD, carrying `VERDICT: FAIL` and `VERDICT: NEEDS_FIXES`. Commit them so the branch records what phase 3 actually concluded.
3. `scripts/checks/check-dismiss-peek.tsx:123-130` and `scripts/checks/check-stop-affordance.tsx:117-125` — the phase-3 blocker is unfixed at this tip (`git diff --stat 3b90700..HEAD -- scripts/checks` is empty). Replace the second half of each comment with the measured truth, by addendum to `6bdd24a`, then re-run the phase-3 gate.

None of the three is a defect in the four negative controls, and none requires
re-running them: phase 4's evidence stands as measured at `9c40765`.
