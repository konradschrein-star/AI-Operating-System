# Evidence — Phase 5 GATING REVIEW: the waiver ledger, the gate's two hooks, and the corpus

**Reviewer task:** `88f59b03-f2bd-43cc-8d5a-adfb878cfc71`, round 1, phase 5 gate.
**Builder under review:** `4a957904-4010-4939-b540-c9a0a8b26451`, commit `229e084`.
**Tip reviewed:** `229e08413ab442435de872422f567bcb7e72cdaa` (`git rev-parse HEAD`,
run in this worktree; re-read immediately before the blocker was written and
unchanged).
**Worktree:** `/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`,
branch `project/b7ab4c57`, merge-base `9b960ef`.
**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
(the per-project layout). `docs/plan/03-quality.md` **does not exist**; the
universal gate this project inherits is `docs/plan/engine-task-graph/03-quality.md`
§3.1 items 1–11 via its §4 command block, and that is the one run below.

**VERDICT: NEEDS_FIXES.** One blocker in the new gate code, reproduced by a
control of my own design; one mandatory live-checkout finding. Everything else —
A5.1 through A5.5, the write-set audit, the three ledger failure controls, the
verdict-invariance claim, the full gate suite — passes on measurement.

---

## 0. Dependencies (C3)

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 949ms using pnpm v9.15.9

$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 708ms using pnpm v9.15.9

$ ls forge-control/node_modules/.bin/tsc forge-control/node_modules/.bin/tsx \
     forge-control-web/node_modules/.bin/tsc
forge-control/node_modules/.bin/tsc
forge-control/node_modules/.bin/tsx
forge-control-web/node_modules/.bin/tsc
```

No `- typescript` line in either install. The compiler is present in both trees;
the pruning trap did not fire.

---

## 1. The universal gate, §3.1 items 1–11, via §4's command block

### item 1–2 — `forge-control` typecheck and unit suite

```
$ cd forge-control && pnpm typecheck
> forge-control@0.1.0 typecheck
> tsc --noEmit
TYPECHECK_EXIT=0

$ cd forge-control && pnpm test
# tests 1293
# suites 239
# pass 1293
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6211.097875
TEST_EXIT=0
```

### item 3 — the live checkout (**FINDING**)

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/chat/AssistantThread.tsx
```

**NOT EMPTY. This is a NEEDS_FIXES finding by itself** (§3.1 item 3: "ANY output
is BY ITSELF a NEEDS_FIXES finding, with the dirty files named verbatim"). The
dirty file, verbatim: `forge-control-web/app/desktop/chat/AssistantThread.tsx`,
85 insertions / 1 deletion. Reading the diff, it is **not this project's work** —
it is a message-windowing change (`WINDOW_STEP = 60`, a `useEffect` import, a
comment dated 2026-08-18 about a 2200-entry / 2.8 MB thread freezing the main
thread). Someone hot-applied a chat performance fix into the live checkout
instead of doing it in a worktree. This project did not write it and must not
revert it silently; it is reported here and listed in the verdict.

Worktree side, by contrast:

```
$ git status --porcelain
[empty — 0 bytes]
```

### item 3b — the branch's commits

```
$ git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
229e084 feat(scripts-checks-typecheck-gate/phase 5, round 500): the waiver ledger, the gate's two hooks, and the corpus amendment
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
60ca3fc docs(round-499-scout): corpus claims audit for instrument-typecheck gate
docs/research/round-499-550e6620.md
5018ac7 fix(scripts-checks-typecheck-gate/round 6, fix cycle 3): gate 17 back to green — every cc-runner.ts pin, re-resolved
…
```

### items 7, 8 — the three corpus checkers

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
instrument-sha256: fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b
OK — 12 pasted header(s) across 3 file(s) name fb5a6434…
OK — 33 pasted manifest line(s) name the current digest of their half
OK — no retired identity quoted without '[historical instrument]'

$ python3 scripts/checks/check-r20-census.py
check-r20-census: SOURCE  forge-control/src/db/projects.ts
check-r20-census: HEAD    229e084
check-r20-census: SHA256  79a62da97552c1c2cd7ac3a2d931be43b14b0b9e9223a94dccc5508310abcf28
check-r20-census: HITS    129 (142 case-insensitive), 51 code / 78 comment, 3 sql-annotations
check-r20-census: SYMBOLS 25 attributed
check-r20-census: R20     every scheduling `round` line is justified  PASS
check-r20-census: REGION  docs/plan/engine-task-graph/evidence/phase2-replay.md matches the measurement  PASS
```

### item 9 — the instrument typecheck gate, baseline run at `229e084`

Given `timeout 600000`; the run took 152 s and the transcript ends with the
verdict line **and** the `EXIT=` line my wrapper appends after the process exits,
so it is not truncated.

```
COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
  git HEAD         : 229e08413ab442435de872422f567bcb7e72cdaa
  git branch       : project/b7ab4c57
  this check sha256: aeb5d2a4a1c2258b79e76516b6acae16a6a4968846e23ae783f090f40d6eaf30
  profile sha256   : 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
  tsc              : Version 5.7.2
  node             : v22.22.2
  subjects found   : 42
  invocation       : (cd $REPO_ROOT && $TSC -p $TMP/NNNN.json --pretty false)  # one file per invocation
  temp dir         : /tmp/tmp.iTj2cFYoqJ

SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
  ok: the suppression scanner works         — 5 comment shapes seen, 1 string decoy ignored

TYPECHECK — one tsc invocation per subject, through the profile
  [42 lines, ALL "PASS … exit 0, 0 diagnostics"]

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
EXIT=0
```

**Verdict-invariance corroborated independently.** `this check sha256`
`aeb5d2a4…` and the wall clock `152s` in my own run are byte-identical to the
"AFTER" transcript of `evidence/phase5-ledger.md` §1.2, as is every per-subject
line and the verdict. The builder's §1.3 diff — four differences: script sha256,
temp dir, wall clock, the eight-line WAIVERS block — is what I measure too.
Subjects found, subjects compiled, every per-file line and the verdict did not
move. Phase 4's negative controls still describe this gate.

### item 10 — shell lint over the derived list

```
$ SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
$ echo "$SH_ALL"
docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
scripts/checks/check-instrument-typecheck.sh
$ shellcheck -S error $SH_ALL ; echo "exit=$?"
exit=0

$ shellcheck -S error scripts/checks/check-instrument-typecheck.sh; echo "exit=$?"
exit=0
```

### R66 — `pm2 restart forge-executor`

```
$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
./forge-control/src/lib/project-tick.test.ts:217:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:218:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:427:    `- NEVER run \`pm2 restart forge-executor\`. …
./forge-control/src/lib/project-tick.ts:588:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
```

Exactly four, all string literals inside sentences forbidding the command, none
in an executable position. Passes.

```
$ grep -rn "consecutive rounds" forge-control/
[empty — passes, "must be empty from phase 5 on"]
```

### P-A and P-B

```
$ git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
    | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)' \
    && echo "FAIL: suppression introduced" || echo "ok: no suppressions"
ok: no suppressions

$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml' | wc -c
0
```

---

## 2. The gate suite — `gates-808.sh --strict`

This project ships a gate suite (`scripts/checks/gates-808.sh`); it governs every
ai-os project, not only the 808 lane. Run with `--strict`, its documented flag
for a nonzero exit on RED>0.

```
 SUMMARY — 25 gates
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
 12 0      check-working-sql-agreement.ts — standalone typecheck
 13 0      check-stop-affordance.tsx
 14 0      check-dismiss-peek.tsx
 15 0      check-team-rows.ts
 16 0      check-team-confirm.ts
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs
 22 0      nav-walk-sampling.cjs
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched
 RED: 0
GATES808_EXIT=0
```

**25 gates: 23 EXECUTED, 0 RED, 2 SKIPPED-by-design** (23 and 24 need the
`--browser` harness of `docs/plan/artifacts/phase800/README` §2 — an API on its
own port with an isolated `SECRET_STORE_DIR` and a web build baked against it —
and are skipped loudly, labelled, never silently omitted). Gate 17, the one
`5018ac7` repaired, is green at this tip.

---

## 3. This project's Phase 5 gate block (`03-quality.md` §252–261), every line

```
$ grep -n 'manifest' docs/plan/engine-task-graph/03-quality.md
209:   `instrument-files:` manifest line equals the current digest of the half it
233:   than 8 manifest lines found, or no header found in
270:   **`scripts/checks/instrument-manifest.txt` is a WAIVER LEDGER, not an
271:   inclusion list, and the manifest guard is retired.** Nothing in that file can
332:   **What the manifest guard buys: a new instrument cannot escape the gate by
337:   them.] A manifest alone would be a gate that shrinks to fit — the
340:   itself a failure, so the manifest can only grow with the branch. The
363:   **(b)** [HISTORY as an input to the retired manifest guard; the expression
378:   `scripts/checks/instrument-manifest.txt`, §10 of `04-phases.md`) and were
```

No surviving inclusion-list claim. 209 and 233 belong to **item 7**'s
`instrument-files:` manifest line — a different artefact (the schedule
instrument's identity ledger), not this gate's. 270–271 is the corrected
prescriptive text. 332/337/340 sit under `[HISTORY, superseded at round 500 …]`
and under the blockquote at 318–326 that names both passages. 363 is marked
`[HISTORY as an input to the retired manifest guard …]` and states what the
expression is **still** for (item 10's shell-lint list). 378 is an ownership
sentence.

### The `sed` window (job E2) — re-derived and checked against the tree

```
$ sed -n '903,911p' docs/plan/engine-task-graph/03-quality.md
# §3.1 item 9 — the instruments are the least-verified code in the repo. Exits 0,
# or names the instrument under scripts/checks/ that no longer typechecks. Scope
# is THE WHOLE DIRECTORY, enumerated by glob at run time — not the manifest, not
# the diff. One tsc invocation per file (R11), from the repo root, through
# tsconfig.checks-instruments.json. instrument-manifest.txt is a WAIVER LEDGER:
# it excuses a named failure, it never obtains coverage, and the gate prints
# every entry above its verdict and fails on a waived file that compiles clean.
# ~150s for 42 subjects; do not background it and read the verdict line.
bash scripts/checks/check-instrument-typecheck.sh

$ grep -n '§3.1 item 9 — the instruments' docs/plan/engine-task-graph/03-quality.md
903:# §3.1 item 9 — the instruments are the least-verified code in the repo. Exits 0,
```

**The window lands exactly on item 9's eight comment lines plus the command they
introduce, and on nothing else.** The old `855,865` was unsatisfiable after this
commit's own edit lengthened the file; `903,911` is correct, the re-derivation
`grep` is published beside it, and the amendment landed in the same commit as the
edit that moved it (standing rule 2). The claim "from the repo root" is true —
`compile_config` pins cwd to `REPO_ROOT`, and the fidelity scan depends on it.

```
$ grep -n 'superseded' docs/plan/engine-task-graph/evidence/phase8-tooling.md
593: ## 5. … — **superseded by `docs/plan/scripts-checks-typecheck-gate/`, round 500**
688: ### 5.1 PROVING IT CAN FAIL — three ways — **superseded by … round 500**
1421:### `payload-review.json` … — **the on-disk payload was amended in round 500; the paste below is unchanged**

$ grep -n 'WAIVERS\|waived but clean' scripts/checks/check-instrument-typecheck.sh
254, 263, 282, 285, 891, 1569, 1580, 1588, 1636, 1663 — the two hooks, implemented
```

---

## 4. The five acceptance criteria, each re-derived

### A5.1 — PASS. No document instructs a reader to add a line to the manifest to get a file compiled.

Grep 1, whole repo, node_modules excluded: **173 hits across 27 files.** Every
hit adjudicated. Distribution and verdicts:

| File | Hits | Verdict |
|---|---|---|
| `evidence/phase5-ledger.md` | 41 | (iii) this phase's own transcripts |
| `engine-task-graph/evidence/phase8-tooling.md` | 29 | §1 table **corrected**; §5, §5.1, §7 heads carry the round-500 marker |
| `docs/research/round-499-550e6620.md` | 24 | (iii) dated recon record; every hit is a `**Claim (verbatim):**` quotation the document itself classifies NOW-FALSE |
| `scripts/checks/check-instrument-typecheck.sh` | 8 | past tense under "WHAT CHANGED AT ROUND 200 … Both are GONE" |
| this project's `evidence/*.md` (phase2/3/4, negative-controls) | 22 | (iii) this project's own transcripts of the gate it replaced |
| `engine-task-graph/03-quality.md` | 6 | adjudicated line-by-line in §3 above |
| `round902-screenshot-convention-fixes.md` | 6 | control (e) and the write-set line, both marked SUPERSEDED with the pointer |
| `02-architecture.md`, `01-requirements.md`, `04-phases.md`, `00-vision.md`, `03-quality.md` | 18 | describe the **ledger**; `04-phases.md:328` is A5.1's own text; `01-requirements.md:303` is control (b), whose whole point is "manifested **nowhere**" |
| `scripts/deploy/payload-review.json` | 1 | **corrected** — see below |
| `scripts/deploy/payload-verify.json` | 1 | (iii) the launch goal, verbatim; named in the ledger header instead |
| `scripts/checks/instrument-manifest.txt` | 1 | (i) the ledger's own header |
| `engine-task-graph/04-phases.md`, `phase8-corpus.md`, `phase8-deploy*.md` | 7 | records; see the one observation below |

Grep 2 — the prescriptive shapes:

```
$ grep -rniI 'add .*to the manifest\|missing from the manifest\|absent from the manifest\|named in .*manifest\|listed in the manifest\|add it to .*manifest\|adding .*to .*manifest' .
./scripts/checks/check-instrument-typecheck.sh:23         → past tense, "Both are GONE"
./scripts/deploy/payload-verify.json:5                    → greedy-BRE false positive across a one-line JSON; the real content is the launch goal
./docs/research/round-499-550e6620.md:13,27,95            → quoted claims in the recon record
./docs/plan/.../04-phases.md:328                          → A5.1's own text
./docs/plan/.../evidence/phase5-ledger.md:859-992         → this phase's transcripts
./docs/plan/engine-task-graph/evidence/phase8-tooling.md:628, 784, 1467 → §5 / §5.1 / §7, all three under a marked head
```

**Grep 3 — the worst survival site, run rather than trusted:**

```
$ grep -rn 'manifest' agents/ .claude/ 2>/dev/null
grep exit=2    (2 = `.claude/` does not exist in this repo; agents/ WAS searched)

POSITIVE CONTROL that the machinery reaches those files:
$ grep -rlc 'write_set\|reviewer\|the' agents/ .claude/
agents/researcher.md  agents/builder.md  agents/planner.md
agents/scout.md       agents/architect.md  agents/reviewer.md
$ grep -rl '' agents/ .claude/ | wc -l
6
```

**All six role files are reachable by the same grep and none contains the string
`manifest`.** The hole is not recreated in any future builder's head.

The one edit that mattered most is `scripts/deploy/payload-review.json` — a
**live** reviewer brief rendered into a future task, which told that reviewer the
gate "compiles each entry of `scripts/checks/instrument-manifest.txt` … and fails
if any file this branch touched … is missing from the manifest". Now corrected to
the glob-scoped gate and the waiver ledger. It still parses:

```
$ python3 -c "import json;d=json.load(open('scripts/deploy/payload-review.json'));print('JSON OK, keys:',list(d.keys()))"
JSON OK, keys: ['role', 'round', 'title', 'brief', 'tier', 'write_set', 'depends_on']
```

**One observation, NOT a blocker.** `docs/plan/engine-task-graph/evidence/phase8-deploy.md:279`
and `phase8-deploy-rerun.md:358` contain the round-802 gate's own stdout,
`MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be
manifested`, inside a fenced code block under a timestamped heading
(`### 3.7 05:41:59 — …`). These are verbatim stdout pastes in a deploy log —
category (iii) — but their section heads carry a timestamp rather than the
round-500 marker. I do not block on it: a fenced paste of a gate's stdout cannot
be read as an instruction, the scout did not enumerate these files, and marking
every transcript in the engine-task-graph evidence tree is a different and larger
job. Recorded so the next reader knows it was seen and judged.

### A5.2 — PASS. The ledger is empty and its header says what it is for.

```
$ git show 229e084:scripts/checks/instrument-manifest.txt | grep -nv '^#' | grep -v '^[0-9]*:$'
[no output — ZERO entries]
$ git show 229e084:scripts/checks/instrument-manifest.txt | wc -l
158
$ grep -n 'MEASURED AT ROUND 800' scripts/checks/instrument-manifest.txt
109:#   WHY A MANIFEST AND NOT THE WHOLE DIRECTORY. MEASURED AT ROUND 800.
122:#   MEASURED AT ROUND 800: one file per invocation, all six below exit 0 with
```

The `▼▼▼ HISTORY` block spans lines **92–154**; both hits are inside it. R15's
verify line holds. The header states, in this order: what the file is; that
**ADDING A PATH HERE DOES NOT OBTAIN COVERAGE — IT EXCUSES A FAILURE**; that the
ledger is empty and that this is the target state; the four required fields with
a worked example; that every waiver is printed on every run; that **a waived file
that compiles clean is a FAILURE**; and that the ledger never excludes a file
from compilation.

**The header's own format example is live syntax, and it is handled.** The
example is indented four extra spaces, the parser's field pattern is
`^# (path|diagnostic|reason|owner)[[:space:]]*:` anchored at column 1, and the
header says why it is indented at the place it is indented. The baseline run
reads the header and reports `0 entry/entries` — measured, not asserted.

### A5.3 — PASS. Code and documentation in ONE commit.

```
$ git log -1 --name-only
229e084 feat(scripts-checks-typecheck-gate/phase 5, round 500): …
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
```

One commit, code and documentation together. Standing rule 2 satisfied.

### A5.4 — PASS. Every scout NOW-FALSE location walked, file by file.

| Scout entry | What happened | Evidence |
|---|---|---|
| `engine-task-graph/03-quality.md` §3.1 item 9 opening | **CORRECTED** | now "the whole of `scripts/checks/`, enumerated by glob at run time"; the guard is named retired |
| same, "Why MANIFEST-SCOPED…" | **SUPERSEDED** | `[HISTORY, superseded at round 500.]` inline + the blockquote naming both passages and pointing at `docs/plan/scripts-checks-typecheck-gate/` |
| same, "What the manifest guard buys" | **SUPERSEDED** | `[HISTORY, superseded at round 500 — the glob catches a new instrument structurally …]` |
| `instrument-manifest.txt` header lines 2–3 ("Read by …") | **CORRECTED** | the header is rewritten; the claim is now true — the script *does* read it, as a ledger |
| same, "WHY A MANIFEST AND NOT THE WHOLE DIRECTORY" | **SUPERSEDED** | inside `▼▼▼ HISTORY` (92–154) |
| same, round-902 entry | **SUPERSEDED** | same block |
| `check-instrument-typecheck.sh:3` (STILL-TRUE) | unchanged, still true | still universal gate item 9 |
| same, lines 4–5 "one file per invocation" (scout: PARTIALLY NOW-FALSE) | **SCOUT IS WRONG; nothing to do** | `write_config` emits `{"extends": …, "files": ["<one path>"]}` and `compile_config` runs one `tsc -p` per config. 42 subjects → 42 `PASS` lines → 42 invocations. R11 holds. |
| same, lines 22–25 (HISTORICAL) | unchanged, correctly past tense | "Both are GONE" |
| same, lines 26–38 "THE MANIFEST IS NOT READ BY THIS SCRIPT AT ALL" | **CORRECTED** — and this one *became* false because of this commit | now "THE MANIFEST IS NEVER READ AS AN INCLUSION LIST", with "since round 500 this script DOES read that file — as a WAIVER LEDGER" spelled out |
| same, lines 44–47 "STANDING RULE 2 IS SATISFIED BY PHASE 5, NOT HERE" | **CORRECTED** | replaced by "WHAT CHANGED AT ROUND 500 (phase 5) — STANDING RULE 2, DISCHARGED". *(Judged against the tree, as instructed: the scout's reasoning here — that phase 5 "has already completed" — was wrong; phase 5 is this commit.)* |
| `engine-task-graph/04-phases.md:945` (STILL-TRUE) | unchanged | an ownership claim, still accurate |
| `02-architecture.md` A2/A3 rows and §363–370 (STILL-TRUE) | unchanged | design-intent claims, accurate |
| `phase8-tooling.md` §1 table, 2 rows | **CORRECTED** | prescriptive index lines: now "every instrument under `scripts/checks/`, enumerated by glob"; the manifest row now reads "waiver ledger … It does not scope the gate." |
| `phase8-tooling.md` lines 1429–1430 (now §7's paste at 1467) | **SUPERSEDED** | the subsection head at 1421 says the on-disk payload was amended in round 500 and the paste is unchanged |

**None silently left.** Beyond the scout's list, the builder found and fixed three
more sites (`payload-review.json`, item 9's "from `forge-control/`",
`round902-screenshot-convention-fixes.md` control (e)) and one error in this
project's own `02-architecture.md` §7 count — all recorded in
`evidence/phase5-ledger.md` §9.

### A5.5 — PASS. Every line number in §7 resolves.

| Pin | Resolved at | Result |
|---|---|---|
| `check-instrument-typecheck.sh:310` — `SUBJECT_GLOBS` | `229e084` | `SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" )   # repo-relative` ✓ |
| `check-instrument-typecheck.sh:311` — `PROFILE` | `229e084` | `PROFILE="$REPO_ROOT/tsconfig.checks-instruments.json"` ✓ |
| `forge-control/tsconfig.json:15` — `"include"` | `60ca3fc` and `229e084` | `  "include": ["src/**/*.ts"]` ✓ (identical at both) |
| `forge-control-mcp/tsconfig.json:15` — `"include"` | `60ca3fc` and `229e084` | `  "include": ["src/**/*.ts"]` ✓ (identical at both) |
| "unchanged at `60ca3fc`" claim for both tsconfigs | `git diff --name-only 60ca3fc 229e084 \| grep tsconfig` | no output — the claim holds ✓ |
| the resolver `git log -1 --format=%H -- scripts/checks/instrument-manifest.txt` | run | `229e08413ab442435de872422f567bcb7e72cdaa` ✓ |

The file counts, re-derived from `git ls-files` rather than from the document:
`scripts/` → 2 (`measure-schedule.ts`, `import-scraper-places.ts`);
`forge-control/scripts/` → 8 (`probe-usage-router.ts` + **seven** `smoke-*.ts`);
`forge-control-mcp/scripts/` → 1. **Total 11, exactly as §7 claims.** The two
`.mjs` siblings (`canvas-cli.mjs`, `twenty/mint-api-key.mjs`) exist and are
correctly excluded. The document's own correction of "nine `smoke-*.ts`" to seven
is right.

---

## 5. The gate script: can this turn a failure into a pass?

### 5.1 The ledger excludes nothing from compilation — CONFIRMED

The compile loop (`for subject in "${SUBJECTS[@]}"`) reads no ledger variable.
Step 8 runs **after** `enumerate_and_reconcile` and writes only `WAIVER_*`
arrays; step 11 runs **after** the loop. There is no `--exclude`, no `continue`
that skips a subject on a ledger condition, and no `if` between the ledger and
`SUBJECTS`. Measured: 42 found / 42 compiled in every one of my five runs,
including the four with ledger entries present. Correct.

### 5.2 The WAIVERS block prints on every run — CONFIRMED

Unconditional `echo` at step 11; with an empty ledger it prints
`ok: 0 waivers — the ledger is empty` (baseline run, above). Never silence.

### 5.3 Every construct the phase-5 diff introduces

Filtering the added lines of `git show 229e084 -- scripts/checks/check-instrument-typecheck.sh`:

- **no `|| true`**, **no `2>/dev/null`**, **no `set +e`** introduced anywhere.
- `while IFS= read -r ledger_line || [ -n "$ledger_line" ]` — the unterminated
  final line guard. Cannot mask a failure; it makes the parser *more* likely to
  see an entry.
- three `continue`s in the parser loop (blank line, comment line, field line) —
  each ends a field block or skips prose. A skipped line cannot excuse anything;
  the four error paths still fire.
- one `continue` in step 11's `INVALID` branch — reached only when the entry was
  already counted as a `LEDGER_ERROR`, which is a hard verdict condition.
- the unreachable `*)` branch in step 11's `case` **refuses and exits 1** rather
  than falling through, which is the right shape.
- `set -euEo pipefail` with an `ERR` trap printing "this run is NOT a pass";
  `-E` is present, so the trap survives the functions. Correct.

### 5.4 The three ledger failure controls, re-run by me — all three reproduce

Each: append, run, capture, `git checkout --`, `git status --porcelain`.

**C1 — a four-field waiver on a file that compiles clean** (`check-close-gate.ts`):

```
  ledger: … — 1 entry/entries, 0 error(s), 0 waived, 1 waived but clean
  WAIVED BUT CLEAN scripts/checks/check-close-gate.ts (ledger line 164) — waived but clean: this subject
    compiled with ZERO diagnostics, so its waiver is stale and this run FAILS.
    observed diagnostic : (none — the file compiles)
check-instrument-typecheck.sh FAILED — … 1 waived but clean, census mismatch 0.
EXIT=1        git status --porcelain after revert: 0 bytes
```

**C2 — a three-field entry (`reason` omitted)**:

```
  ledger: … — 1 entry/entries, 1 error(s), 0 waived, 0 waived but clean
  INVALID scripts/checks/check-close-gate.ts (ledger line 163) — excuses nothing; …
  LEDGER ERROR at line 163: the entry '…' is missing required field(s): reason. …
check-instrument-typecheck.sh FAILED — … 1 ledger error(s), …
EXIT=1        git status --porcelain after revert: 0 bytes
```

**C3 — a waiver for a path not on disk** (`zz-does-not-exist.ts`):

```
  ledger: … — 1 entry/entries, 1 error(s), 0 waived, 0 waived but clean
  INVALID scripts/checks/zz-does-not-exist.ts (ledger line 164) — excuses nothing; …
  LEDGER ERROR at line 164: the waived path '…' is NOT ON DISK. …
check-instrument-typecheck.sh FAILED — … 1 ledger error(s), …
EXIT=1        git status --porcelain after revert: 0 bytes
```

### 5.5 C4 — **BLOCKER**: a DUPLICATE ledger entry launders another file's failure into a PASS

A control of my own, not the builder's. Mutation: break **two** subjects, and
waive **one** of them **twice** (both entries four-field, both valid).

```
$ printf '\nexport const __c4_reviewer_probe: number = "not a number";\n'  >> scripts/checks/check-close-gate.ts
$ printf '\nexport const __c4_reviewer_probe2: number = "not a number";\n' >> scripts/checks/check-plan-api.ts
$ cat >> scripts/checks/instrument-manifest.txt <<'EOF'

# path        : scripts/checks/check-close-gate.ts
# diagnostic  : TS2322 — reviewer control C4, entry 1 of 2 (same path twice)
# reason      : reviewer round-500 control C4 — duplicate-entry probe
# owner       : reviewer, round 500 gating review
scripts/checks/check-close-gate.ts

# path        : scripts/checks/check-close-gate.ts
# diagnostic  : TS2322 — reviewer control C4, entry 2 of 2 (same path twice)
# reason      : reviewer round-500 control C4 — duplicate-entry probe
# owner       : reviewer, round 500 gating review
scripts/checks/check-close-gate.ts
EOF

$ git diff --stat
 scripts/checks/check-close-gate.ts     |  2 ++
 scripts/checks/check-plan-api.ts       |  2 ++
 scripts/checks/instrument-manifest.txt | 12 ++++++++++++
 3 files changed, 16 insertions(+)
```

The gate observed **both** failures:

```
  FAIL scripts/checks/check-close-gate.ts               exit 2
         scripts/checks/check-close-gate.ts(570,14): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/check-plan-api.ts                 exit 2
         scripts/checks/check-plan-api.ts(1193,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

and then reported:

```
WAIVERS — every exclusion is printed here, on every run (R14, 02-architecture.md §4.6)
  ledger: scripts/checks/instrument-manifest.txt — 2 entry/entries, 0 error(s), 2 waived, 0 waived but clean
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 164)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: …
  WAIVED  scripts/checks/check-close-gate.ts (ledger line 170)
    observed diagnostic : scripts/checks/check-close-gate.ts(570,14): error TS2322: …

CENSUS
  subjects found 42   subjects compiled 42   type failures 0   fidelity violations 0   missing 0   uncovered 0   suppressions 0
  wall clock       : 154s

check-instrument-typecheck.sh PASSED — 40/42 subjects compiled clean, 2 WAIVED (named in the WAIVERS block above).
EXIT=0
```

**`scripts/checks/check-plan-api.ts` is waived by nobody, its type error is
printed above the verdict, and the gate exits 0 saying PASSED.** The census even
reports `type failures 0`.

**Mechanism, by symbol.** Step 11's reconciliation loop iterates `WAIVER_PATHS`
and, for each valid entry whose `SUBJECT_OUTCOME[$w_path]` is `fail`, executes
`FAILED=$((FAILED - 1))`. `SUBJECT_OUTCOME` is keyed by path and is never
consumed or cleared, so **N ledger entries naming one failing path decrement
`FAILED` N times**. Step 8's parser (`ledger_error` call sites) enforces four
conditions — missing field, `path` field vs bare path disagreement, path not on
disk, path not among `SUBJECTS` — and **no uniqueness condition**. With two
failing subjects and one duplicated waiver, `FAILED` reaches 0 and the verdict
predicate `[ "$FAILED" -eq 0 ] && …` is satisfied.

**What this falsifies, in the gate's own words** (all at `229e084`):

- `check-instrument-typecheck.sh`, step 11's header comment: *"WHAT A VALID
  WAIVER DOES, exactly one thing: an already-observed FAIL is reclassified as an
  excused WAIVED. `FAILED` goes down by one and `WAIVED` goes up by one"* — it
  goes down by two.
- the same file's `Exit:` block: *"Neither can turn a failure into a pass: a
  waiver reclassifies an observed FAIL into an excused WAIVED and changes nothing
  else"* — it changed another subject's verdict.
- `instrument-manifest.txt` header, property 2's closing sentence: *"a waiver
  must name something this gate actually reads, or it is excusing nothing"* — the
  second entry excuses a failure that is not its own.
- `evidence/phase5-ledger.md` §7.1, row 2: *"A waiver laundering a real type
  error into a green run — It cannot"* — measured above, it can.

**Why this blocks rather than being noted.** The ledger is empty at `229e084`, so
no verdict on this tree is wrong today. But the ledger is the one file in this
design that is **meant** to be hand-edited by future rounds, a duplicated path is
an ordinary hand-edit slip (two projects excusing the same stubborn instrument,
or one copy-paste), and the whole premise of R14 is that a ledger is safer than
an `--exclude` flag *because it cannot quietly change a verdict*. A gate with a
reachable failure-to-pass path is the exact thing this project exists to
eliminate, and it is what §4 of the quality document instructs the reviewer to
read for.

**The fix is local:** a fifth `ledger_error` in step 8 — a `path` already present
in `WAIVER_PATHS` is a duplicate entry and a hard ledger error, naming both line
numbers. Do not "fix" it by making step 11 skip the second entry: a silent skip
is the shape the design forbids. Add the control to the ledger-control set beside
C1–C3.

```
$ git checkout -- scripts/checks/instrument-manifest.txt scripts/checks/check-close-gate.ts scripts/checks/check-plan-api.ts
$ git status --porcelain
[empty — 0 bytes]
$ git rev-parse HEAD
229e08413ab442435de872422f567bcb7e72cdaa
```

All four controls reverted; the tree is byte-clean and HEAD did not move.

### 5.6 The payload still parses

```
$ python3 -c "import json;json.load(open('scripts/deploy/payload-review.json'))"
[no output, exit 0]
```

---

## 6. Write-set audit

Declared on the builder's task row `4a957904-4010-4939-b540-c9a0a8b26451`
(`GET /api/projects/b7ab4c57-…`), ten paths. Touched by that task's commits
(`git log -1 --name-only 229e084`), ten paths. **Identical sets. Zero undeclared
writes.**

The commit message's "UNDECLARED WRITES, DISCLOSED" paragraph describes the
divergence from the **planner's** four-path row and from `04-phases.md` §10's
table — both of which were amended in the same commit. Against the row the gate
actually audits, there is nothing to disclose. The gate is satisfied by
construction, as it claims to be.

*(For completeness: `60ca3fc` was written by the round-499 scout task
`550e6620-…`, whose row declares an empty `write_set` while the commit adds
`docs/research/round-499-550e6620.md`. That is a different task and a different
role, outside this group; noted, not charged to phase 5.)*

---

## 7. §4's three questions

**1. What would have made MY instruments report a pass wrongly?**

- **A grep whose pattern cannot match the sentence it is looking for.** The A5.1
  sweep is BRE with `\|` alternation under plain `grep -rn`; had I written `-E`
  with backslashed pipes it would have searched for a literal `\|` and returned
  nothing, and "no hits" would have read as "clean". Shown impossible: grep 1
  returned **173 hits across 27 files** and grep 2 returned hits in eight files —
  the patterns demonstrably match. For the one grep that legitimately returned
  nothing (`agents/` + `.claude/`), I ran an explicit **positive control** with
  the same machinery over the same paths, which listed all six role files; and I
  established that grep's exit 2 there is `.claude/` not existing, not a failure
  to read `agents/`.
- **A gate run truncated by a Bash timeout.** The gate takes ~152 s and the
  default Bash timeout is 120 s; a truncated transcript ends mid-`TYPECHECK` and
  reads like a run in progress, not a failure. Shown impossible: every gate
  invocation was given `timeout 600000`, and each transcript is terminated by an
  `EXIT=n` line that my wrapper writes **after** the process exits. A truncated
  run has no `EXIT=` line. All five have one.
- **A control whose revert silently failed**, leaving a mutated tree so that the
  next control measures the wrong thing. Guarded: `git status --porcelain`
  captured after each of the four reverts — 0 bytes each — plus a final live
  check and `git rev-parse HEAD` unchanged.
- **`pnpm install` pruning the compiler under `NODE_ENV=production`**, so the
  gate would die with `tsc: not found` while the install looked clean. Guarded:
  `--prod=false` on both installs, no `- typescript` line, and `ls` of the three
  `.bin/tsc` / `.bin/tsx` paths before anything ran.

**2. Which gate did I find UNSATISFIABLE, and did I amend it where it is
enforced?** **None.** The phase-5 gate block's `sed -n '903,911p'` — the one
candidate, and unsatisfiable at `855,865` — was re-derived by the builder in the
same commit that moved it and lands exactly on item 9. The write-set audit is
satisfiable against the declared row. I found nothing to amend, so standing rule
2 imposed no edit on me, which is fortunate: my write-set is `phase5-gate.md`
alone and I could not have made one.

**3. Every citation: symbol name or requirement id? Any line number pinned to a
SHA?** Every claim about code is cited by **symbol** — `SUBJECT_GLOBS`,
`PROFILE`, `write_config`, `compile_config`, `enumerate_and_reconcile`,
`SUBJECT_OUTCOME`, `WAIVER_PATHS`, `ledger_error`, `ledger_flush_dangling`,
`FAILED`, `WAIVED`, `WAIVED_CLEAN`, `LEDGER_ERRORS` — or by requirement id (R11,
R14, R15, R19, R28, R34, NF1–NF4, A5.1–A5.5). The line numbers I do quote are
§7's own pins and the §3 grep output, and **all of them are resolved against
`229e084`** (or `60ca3fc` where §7 says so), with the resolution printed above.

---

## 8. Summary

| Item | Result |
|---|---|
| Dependencies (C3) | OK, compiler present, no prune |
| `pnpm typecheck` / `pnpm test` (forge-control) | 0 / **1293 pass, 0 fail** |
| `git -C /opt/forge-ai-os status --porcelain` | **DIRTY — finding 2** |
| `git status --porcelain` (worktree) | empty |
| check-corpus-map.py / check-instrument-identity.py / check-r20-census.py | all green |
| `check-instrument-typecheck.sh` at `229e084` | **PASSED 42/42, exit 0, 152 s** |
| `shellcheck -S error` (derived list + the gate) | 0 |
| R66 grep / "consecutive rounds" grep | 4 prohibiting hits / empty |
| P-A / P-B | no suppressions / 0 bytes |
| `gates-808.sh --strict` | **25 gates, 23 EXECUTED, 0 RED, 2 SKIPPED-by-design, exit 0** |
| Phase 5 gate block, incl. the E2 `sed` window | all lines run, window correct |
| A5.1 / A5.2 / A5.3 / A5.4 / A5.5 | **PASS / PASS / PASS / PASS / PASS** |
| Write-set audit | 10 declared, 10 touched, **0 undeclared** |
| Verdict invariance | corroborated independently, byte-for-byte |
| Ledger controls C1, C2, C3 | all three reproduce, exit 1, tree clean |
| **Ledger control C4 (duplicate entry)** | **gate says PASSED, exit 0, over an unexcused type error — blocker 1** |

VERDICT: NEEDS_FIXES
