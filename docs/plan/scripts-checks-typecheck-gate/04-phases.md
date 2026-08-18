# 04 — Phases

**Project:** `scripts-checks-typecheck-gate`
**Workstream:** `main` only — one worktree, tasks serialised. §9 says why no
second workstream exists.

Six phases. Round labels 100…600; the engine computes real rounds from
`depends_on`. Each phase states scope, deliverables, acceptance criteria, and
the requirement IDs it owns. Every requirement in `01-requirements.md` appears
in exactly one phase (§8).

**Ordering.** Phase 1 gates everything: "green" is undefined until the profile
exists. Phases 2 and 3 are independent of each other — different files, no
shared state — and both depend only on phase 1. Phase 4 needs both. Phase 5
needs phase 4's evidence to describe. Phase 6 merges.

```
        ┌─────────────┐
        │ 1  profile  │  R1–R7
        └──────┬──────┘
         ┌─────┴─────┐
         ▼           ▼
   ┌──────────┐ ┌──────────┐
   │ 2  gate  │ │ 3  fixes │   R8–R13,R16–R22 │ R25–R30,R33
   └─────┬────┘ └────┬─────┘
         └─────┬─────┘
               ▼
        ┌─────────────┐
        │ 4 controls  │  R23,R24
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │ 5 ledger +  │  R14,R15,R31,R32,R34
        │   corpus    │
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │ 6  deploy   │  NF5,C1–C3
        └─────────────┘
```

---

## Phase 1 — The compile profile

**Round label 100.** Depends on nothing.

### Scope

Introduce the one checked-in tsconfig that defines what "compiles clean" means
for an instrument, and prove it reproduces round 0's census exactly. No gate
change, no instrument change.

### Deliverables

| # | Artifact | Notes |
|---|---|---|
| D1.1 | `tsconfig.checks-instruments.json` | Verbatim shape in 02-architecture.md §3.1, comments included — they carry the measurements |
| D1.2 | a cross-reference comment added to `tsconfig.checks.json` | pointing at D1.1, stating that one is tsx's runtime config and one is tsc's, and that their `paths` deliberately point at opposite targets |
| D1.3 | `docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh` | runs the profile over all 42 subjects and prints the same table round 0 produced; the phase-2 gate and every later reviewer use it |
| D1.4 | `docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md` | U1–U6 transcripts, including U5's `typeRoots`-removed run |

### Acceptance criteria

- **A1.1** D1.3 over all 42 subjects yields exactly 36 green / 6 red, and the 6
  are `check-orientation.ts`, `check-team-confirm.ts`, `check-team-rows.ts`,
  `serve-sse-808.ts`, `check-dismiss-peek.tsx`, `check-stop-affordance.tsx`,
  carrying exactly the 11 diagnostics of `00-vision.md` §3.2 at the same lines.
- **A1.2** Zero diagnostics anywhere outside `scripts/checks/` (S5).
- **A1.3** `cd forge-control-web && pnpm typecheck` exit 0, output identical to
  before the phase (S6).
- **A1.4** D1.1 uses `extends`, not a copied flag list; every `paths` entry
  resolves inside `node_modules/@types/` except the inherited `@/*`;
  `typeRoots` present.
- **A1.5** U5 transcript shows the `typeRoots`-removed collapse (12 green / 30
  red) and the restoration.
- **A1.6** `git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'`
  empty.
- **A1.7** Nothing but docs references the profile (R6).

### Requirements owned

R1, R2, R3, R4, R5, R6, R7, NF2, NF8.

### Risks

The census not reproducing. If phase 1's numbers differ from round 0's, **stop
and report** — do not adjust the profile until it matches. A profile tuned to
produce the expected answer is a profile that proves nothing. The likeliest
innocent cause is a different `tsc` version; the provenance block exists to
make that visible.

---

## Phase 2 — The gate rewrite

**Round label 200.** Depends on phase 1.

### Scope

Rewrite `check-instrument-typecheck.sh` to enumerate by glob and compile through
the profile. Keep its skeleton (provenance, refusals, census, full output);
replace its enumeration and its options; add the two guards round 0's
measurement showed were missing.

**This phase deliberately ends with the gate RED.** The six instruments are
phase 3's job. A phase-2 gate that exits 0 is compiling fewer than 42 files and
is a failure.

### Deliverables

| # | Artifact |
|---|---|
| D2.1 | `scripts/checks/check-instrument-typecheck.sh`, rewritten per 02-architecture.md §4.1 |
| D2.2 | `evidence/phase2-gate.md` — U7–U9, U12, U13, I1–I6 transcripts |

### Implementation notes the planner must pass through

- **Two named variables at the top**, per 02-architecture.md §7: the subject
  glob and the profile path. A successor project extends coverage by editing
  those two lines and nothing else.
- **`mktemp -d` + `trap 'rm -rf "$TMP"' EXIT`.** Never a file inside the repo:
  it dirties the tree (universal item 3), collides between concurrent runs, and
  survives a crash into someone's `git add -A`.
- **Absolute paths** in the generated per-file config, both in `extends` and in
  `files`. Measured working; relative paths from a temp dir are meaningless.
- **Filenames are hostile.** Quote every expansion; handle spaces and leading
  dashes (`tsc -p -- "$cfg"` or a `./`-prefixed path). A2's red-team will try
  them.
- **The install line in the refusal must carry `--prod=false`** (or
  `NODE_ENV=development`), and `pnpm`, never `npm`. C3 — this environment prunes
  devDependencies under `NODE_ENV=production`, `tsx` and `typescript` are
  devDependencies, and the pruned install exits 0 while removing the compiler.
- **Profile-fidelity guard:** any diagnostic whose path does not start
  `scripts/checks/` fails the run with a message saying the profile is wrong,
  not the app. This is what stops the next maintainer from "fixing" the app.
- **Uncovered-extension scan:** anything matching `scripts/checks/*.[mc]ts` and
  not enumerated must be named in the transcript. Silence is the defect.
- Keep the round-800 header's "what would make this report a pass wrongly"
  enumeration, updated: (b) becomes structural, (c) is superseded by the glob,
  and two entries are added for stale waivers and profile fidelity.

### Acceptance criteria

- **A2.1** Subjects found = subjects compiled = `ls scripts/checks/*.ts
  scripts/checks/*.tsx | wc -l` = 42.
- **A2.2** Exit 1 with exactly 6 failures — the phase-3 six, no others.
- **A2.3** Provenance block carries all ten fields of R20, above the first
  PASS/FAIL line.
- **A2.4** `git status --porcelain` empty after a run, including after a run
  that failed and after one interrupted with SIGINT (NF3).
- **A2.5** Two consecutive runs identical modulo timing and temp path (NF2);
  two concurrent runs both correct (NF4).
- **A2.6** Correct verdict when invoked from another cwd by absolute path (I6).
- **A2.7** `shellcheck -S error` clean (universal item 10).
- **A2.8** U7, U8, U9, U12, U13 transcripts present.
- **A2.9** The reviewer has read every `|| true`, `2>/dev/null`, `continue` and
  `set +e` and states in the verdict that none can convert a failure into a pass
  (R16/NF1).

### Requirements owned

R8, R9, R10, R11, R12, R13, R16, R17, R18, R19, R20, R21, R22, NF1, NF3, NF4,
NF6, NF7.

### Adversarial review

**Mandatory** — brief A2 from 03-quality.md §6, verbatim. This is the highest-risk
deliverable in the project: a gate that can be made to report PASS while a file
is broken is worse than the gap it replaces, because it converts "nobody
checked" into "somebody checked and it was fine."

---

## Phase 3 — Fix the six instruments

**Round label 300.** Depends on phase 1. Runs alongside phase 2; disjoint files.

### Scope

Eleven diagnostics, six files, three families. Fix them at the source. Change
nothing outside `scripts/checks/`.

### The families, with round 0's findings

**Family A — fixture drift against `TeamRow` / `XClickInput` / `WorkingMsSource`
(7 diagnostics, 4 files).**

| File | Line | Fix |
|---|---|---|
| `check-team-confirm.ts` | 207 | the `decideXClick({...})` call omits required `hidesRows: number`. Lines 82–87 of the same file already pass `hidesRows: 1` — match them. |
| `check-team-rows.ts` | 84 | `row(over: Partial<TeamRow> & { node: TeamNode })` spreads `Partial`, so required `hidesRows` becomes optional. Give the helper a default or tighten its parameter type. |
| `check-dismiss-peek.tsx` | 102 | `working_ms_source: "run"` — `WorkingMsSource` is `"thread" \| "rollup"`. Pick the one the fixture means and say why in the commit. |
| `check-dismiss-peek.tsx` | 115 | `row()` omits required `hidesRows`. |
| `check-stop-affordance.tsx` | 98, 111 | identical to the two above. |

**Family B — `check-orientation.ts` lines 129/133/138 (3 diagnostics).**
`TeamNodeKind = "operator" \| "worker" \| "cron" \| "unknown" \| "subagent"`.
`"operator_chat"` and `"project_worker"` **never existed in this union**.
Round 0 measured the correction: `"operator_chat"` → `"operator"`,
`"project_worker"` → `"worker"` typechecks clean **and** still runs
`ALL PASS`.

The builder must not stop there. The instrument passes identically before and
after, which strongly suggests **no assertion in it depends on `kind` at all**.
The builder reports, in the commit message and the task record, which assertions
(if any) exercise `kind`. If none do, that is a finding to state plainly, not a
defect to hide behind a green tick — and it is what A1's red-team reviewer is
briefed to establish independently.

**Family C — `serve-sse-808.ts` lines 51, 90 (2 diagnostics).**
`hono` declares `"types": "dist/types/index.d.ts"`; importing
`.../hono/dist/index.js` explicitly bypasses that field, so `Hono` is `any` and
handler parameter `c` follows. Round 0 measured the fix: **drop `/dist/index.js`
from both Hono specifiers**, leaving the package directory
(`../../forge-control/node_modules/hono` and
`../../forge-control/node_modules/@hono/node-server`). Exit 0, clean.

**The builder must run the server, not just compile it.** This file binds a port
and proxies SSE. A specifier that satisfies `tsc` but breaks Node's resolution
turns a green typecheck into a dead server, and the typecheck cannot see that.
Round 0's baseline: binds `:7845`, proxies to `127.0.0.1:7700`.

### Deliverables

| # | Artifact |
|---|---|
| D3.1 | the six instruments, compiling clean |
| D3.2 | `evidence/instruments-still-detect.md` — six R29 breakage transcripts |
| D3.3 | commit messages naming, per file, which of R26's three outcomes applies |

### Acceptance criteria

- **A3.1** All 42 subjects green under the phase-1 profile.
- **A3.2** Each of the five runnable instruments exits 0 under `tsx` with its
  `ALL PASS` line; `serve-sse-808.ts` binds its port and proxies.
- **A3.3** Six R29 transcripts: subject broken → instrument fails → reverted →
  instrument passes.
- **A3.4** P-A suppression grep empty (R28).
- **A3.5** `git diff --name-only main...HEAD` lists nothing under
  `forge-control-web/app/` or `forge-control/src/` (R30).
- **A3.6** Each repaired fixture is a value the wire contract permits, checked
  against the type definition by reading both (03-quality.md §7).

### Requirements owned

R25, R26, R27, R28, R29, R30, R33, NF9.

### Adversarial review

**Mandatory** — briefs A1 (family B) and A3 (all six) from 03-quality.md §6.

### Risks

- **The compiler-satisfying non-fix.** Guarded three ways: R28's grep, R29's
  transcripts, A3's red-team. None is sufficient alone.
- **A fix that cascades into the app.** Round 0 measured that family B does not.
  If any fix appears to require an app change, that is NF9's escalation, not a
  quiet edit — post the reminder, state the default, and continue with the
  other five.

---

## Phase 4 — Negative controls

**Round label 400.** Depends on phases 2 and 3.

### Scope

Make the gate fail, four ways, on purpose. Transcribe everything. This phase
produces no code.

### Deliverables

`docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`,
containing controls (a)–(d) per 03-quality.md §5, each with all five steps:
green before, mutation shown, full failing output with exit code, revert with
`git status --porcelain` empty, green after.

### Acceptance criteria

- **A4.1** Four controls, all five steps each. A missing step voids the control.
- **A4.2** Control (b) — a new type-broken file added to the directory and
  listed nowhere — makes the gate fail and reports 43 subjects. **If (b) does
  not fail, the project's central claim is false and phase 2 reopens.**
- **A4.3** Control (c) prints the install line, and that line, run verbatim with
  `NODE_ENV=production` exported, leaves a tree where the gate passes.
- **A4.4** Every mutation reverted; tree clean; the gate green at the end.
- **A4.5** Wall-clock of a full run recorded (S10, NF6).

### Requirements owned

R23, R24.

---

## Phase 5 — The ledger and the corpus

**Round label 500.** Depends on phase 4. Preceded by a scout at round label 499.

### Scope

Invert `instrument-manifest.txt` from inclusion list to waiver ledger, and make
every document that describes the gate describe the gate that now exists.
Standing rule 2: the amendment ships in the same commit as what it describes.

### Deliverables

| # | Artifact |
|---|---|
| D5.1 | `scripts/checks/instrument-manifest.txt` — header rewritten to the ledger semantics of 02-architecture.md §4.6; zero entries; the round-800 history retained but explicitly marked as history |
| D5.2 | `docs/plan/engine-task-graph/03-quality.md` — §3.1 item 9 and the §4 command block (item 9 sits at line 859) amended |
| D5.3 | `docs/plan/engine-task-graph/evidence/phase8-tooling.md` §5/§5.1 — updated, or marked superseded with a pointer to this corpus |
| D5.4 | `docs/plan/scripts-checks-typecheck-gate/02-architecture.md` §7 — the successor project named in files and lines (R34) |

### Scout task (round label 499)

The corpus references `instrument-manifest` / `check-instrument-typecheck`
roughly 127 times across 11 files. The scout enumerates **every** location that
asserts something about the gate's scope, coverage, manifest semantics or
invocation, as `file:line` plus the claim, and marks each still-true /
now-false / historical. The planner turns that list into the write_set. Without
it, phase 5 amends the three obvious places and leaves eight files quietly
lying.

### Acceptance criteria

- **A5.1** No document instructs a reader to add a line to the manifest to get a
  file compiled. That sentence, left standing, recreates the hole in the next
  builder's head even after the script stops having it.
- **A5.2** The ledger is empty; its header states what it is for and that a
  waived-but-clean entry is a failure.
- **A5.3** Code and documentation in one commit (standing rule 2), shown by
  `git log -1 --name-only`.
- **A5.4** Every location the scout marked now-false is either corrected or
  marked superseded with a pointer. None silently left.
- **A5.5** R34's successor section names files and line numbers, not intentions.

### Requirements owned

R14, R15, R31, R32, R34.

---

## Phase 6 — Deploy and verify

**Round label 600.** Depends on phase 5.

### Scope

Merge (or PR — R17 of the deploy block below), push, and verify on the merged
tree from a genuinely cold checkout.

### Deliverables

`docs/plan/scripts-checks-typecheck-gate/evidence/phase6-deploy.md` — the
cold-tree transcript, the final full-directory green, and the merge/PR record.

### Acceptance criteria

- **A6.1 — cold tree (DoD-7, NF5).** On a checkout with **no** `node_modules`:
  the gate refuses with the install line; that line is run verbatim; the gate
  then reports 42/42 green. Performed from a genuinely cold tree, not the warm
  one the phase was built in.
- **A6.2** Universal gate items 1–11 green on the merged tree.
- **A6.3** `git status --porcelain` empty in `/opt/forge-ai-os` (universal item
  3).
- **A6.4** P-B: no `package.json` or lockfile change (NF8).
- **A6.5** The final answer states the wall-clock of a full gate run (S10).

### Requirements owned

NF5, C1, C2, C3 — plus a re-run of every prior phase's acceptance criteria on
the merged tree.

### Executor restart — the expected answer, stated in advance

This project's diff touches `scripts/checks/*`, one root tsconfig, and
`docs/**`. It touches **none** of `src/lib/project-tick.ts`,
`src/lib/cc-runner.ts`, `src/executor.ts`, `src/db/*`, `agents/*.md`. **The
expected outcome is therefore that no executor restart is required at all.**

The deploy task must nevertheless *verify* that, by listing the diff, rather
than assuming it — and if the diff does touch executor-loaded code, it follows
the detached procedure below without exception.

### DEPLOY GUIDANCE (verbatim, and copied into the deploy task's brief)

- **EXECUTOR-LOADED CODE.** If the diff touches `src/lib/project-tick.ts`,
  `src/lib/cc-runner.ts`, `src/executor.ts`, `src/db/*` or the `agents/*.md`
  role files, the executor is holding the old code in memory and a plain restart
  would kill every run in flight — including the deploy task itself.
- **NEVER `pm2 restart forge-executor`.** Not to deploy, not to test, not "just
  this once".
- Instead, after merging, run exactly:
  ```
  setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
  ```
  launch it DETACHED and END the task — never wait for it, never poll it, never
  tail the log until it finishes. The script waits for the fleet to go idle and
  restarts then; your task must return immediately.
- `pm2 restart forge-control` (the API side) remains allowed and is the right
  way to pick up route/API changes, since nothing long-running lives in that
  process.
- **MERGE vs PR (R17):** if the project brief says to open a PR instead of
  merging, run `scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"` and do
  NOT merge to main — the PR is the deliverable. Otherwise merge per the brief
  (merge main into the work branch first if main moved, re-run typecheck +
  tests in the worktree, then merge to main; on conflicts STOP and report the
  files).

### GITHUB PUSH (phase completion — in every gating reviewer's brief)

- When a phase's gating reviewer issues VERDICT: PASS and the repo has an origin
  remote, run `scripts/git-sync-branch.sh <worktree-dir>` to push the work
  branch so the progress is visible on GitHub.
- Plain push only. NEVER force-push, never `--force`, never `--force-with-lease`
  — this branch is shared with whatever else is watching it.
- If the push fails (no origin, gh not authenticated, rejected), report the
  failure verbatim in your final message and move on. A push failure NEVER
  changes the verdict.

---

## 7. Dependencies before any gate — in every brief

`NODE_ENV=production` is exported into every run, so
`pnpm install --frozen-lockfile` **skips devDependencies**, says so quietly, and
**exits 0**. The typecheck then dies with `tsc: not found` while the install
looked clean. `tsx` and `typescript` are devDependencies. Always:

```bash
cd <the package holding the lockfile> && pnpm install --frozen-lockfile --prod=false
```

`pnpm`, never `npm` — `pnpm add` under that pruning has removed `tsx` and
bricked the executor.

Both packages are needed: `forge-control-web` supplies `tsc`, React and the app
types; `forge-control` supplies `tsx`, `pg` and `hono`.

---

## 8. Requirement → phase map (authoritative)

| Phase | Requirements owned |
|---|---|
| 1 | R1, R2, R3, R4, R5, R6, R7, NF2, NF8 |
| 2 | R8, R9, R10, R11, R12, R13, R16, R17, R18, R19, R20, R21, R22, NF1, NF3, NF4, NF6, NF7 |
| 3 | R25, R26, R27, R28, R29, R30, R33, NF9 |
| 4 | R23, R24 |
| 5 | R14, R15, R31, R32, R34 |
| 6 | NF5, C1, C2, C3 |

43 numbered R/NF requirements, each in exactly one phase. C4, C5 and C6 are
constraints enforced by every phase rather than owned by one.

---

## 9. Why one workstream

Everything runs in `main`. A second workstream buys concurrency at the cost of a
merge, and this project has no two teams needing the same file at the same time:

- Phases 2 and 3 are genuinely independent and could run in parallel worktrees,
  but their combined work is one script and six small fixes. Serialising them in
  one worktree costs a few minutes; isolating them costs an integration task, a
  merge, and a conflict path — for a project whose entire diff is under a
  thousand lines.
- Phase 3's six files could be split across three builders. They are not, for
  the same reason: three builders in one workstream serialise anyway, and the
  three families share one diagnosis. One builder holding all six sees family A
  and family B are the same defect.

The rule this respects: no two builders in one workstream declare the same file
in their `write_set`. The phase write_sets in §10 are disjoint by construction.

---

## 10. Write-set ownership

| Phase | Files written |
|---|---|
| 1 | `tsconfig.checks-instruments.json`, `tsconfig.checks.json`, `docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh`, `.../evidence/phase1-profile.md` |
| 2 | `scripts/checks/check-instrument-typecheck.sh`, `.../evidence/phase2-gate.md` |
| 3 | `scripts/checks/check-orientation.ts`, `check-team-confirm.ts`, `check-team-rows.ts`, `serve-sse-808.ts`, `check-dismiss-peek.tsx`, `check-stop-affordance.tsx`, `.../evidence/instruments-still-detect.md` |
| 4 | `.../evidence/negative-controls.md` |
| 5 | `scripts/checks/instrument-manifest.txt`, `docs/plan/engine-task-graph/03-quality.md`, `docs/plan/engine-task-graph/evidence/phase8-tooling.md`, `docs/plan/scripts-checks-typecheck-gate/02-architecture.md` |
| 6 | `.../evidence/phase6-deploy.md` |

Disjoint. No file appears twice.

Note for phase 5's planner: if the round-499 scout finds corpus claims in files
not listed above, those files join phase 5's write_set — the rule is that a
document quoting a constant this project changes belongs in the write_set of the
round that changes it.
