# 03 — Quality: engine-task-graph

Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e`.

This is the document a reviewer of this project reads. Every gate below is
**satisfiable** — if you find one that is not, amend it *here and where it is
enforced*, in the same commit, with the reasoning inline (standing rule 2).

---

## 1. The harness that exists

There is no vitest, no jest, no ledger, no migration runner. What there is:

| Job | Command | Where run |
|---|---|---|
| Typecheck | `tsc --noEmit` (`pnpm typecheck` in `forge-control/`) | worktree |
| Unit tests | `tsx --test src/lib/*.test.ts` (`pnpm test` in `forge-control/`) | worktree |
| Web checks | `scripts/checks/check-plan-store.ts` and friends, under `tsx` | worktree |
| Migrations | manual `psql -f db/migrations/NNNN_*.sql` | **deploy task only** |

**Tests never touch a database.** `project-reconcile.test.ts` states the rule in
its header — *"a value import of `db/*` would open a pg Pool in the test
process"* — and `project-tick.test.ts` follows it with `import type` plus object
factories (`project(over)`, `task(over)`). Every new test in this project obeys
the same rule (NF3). Proof of obedience: `pnpm test` passes with Postgres
stopped, and the reviewer of each phase states that they ran it that way or that
they could not and why.

`migrations.test.ts` is a **linter**, not a runner. It asserts every
`CREATE TABLE` carries `IF NOT EXISTS`, every `CREATE (UNIQUE)? INDEX` carries
it, every `ADD COLUMN` carries it, and it names `0039_reviewer_chain_key.sql`
specifically. Phase 1 adds an equivalent named case for `0040_task_graph.sql`.

---

## 2. Test strategy by layer

### 2.1 Unit — pure functions, `forge-control/src/lib/*.test.ts`

The bulk of the proof lives here, because the bulk of the *decisions* live in
`lib/task-graph.ts` by design (`02-architecture.md` §1.1).

**`task-graph.test.ts`** — new file. Cases, grouped:

*Readiness*
- `readyRule` returns `legacy` for `depends_on: null` and `graph` for `[]` and
  for a populated array. Three cases, because the sentinel is the whole
  migration strategy and a mistake here is silent.
- `graphReady`: empty deps → ready; one done dep → ready; one pending dep → not
  ready; mixed done/failed → not ready; **dep id absent from the map → throws
  `GraphIntegrityError`** (R14, never `false`, never `true`).
- `legacyRoundReady`: reproduces today's rule exactly, including "*every*
  strictly lower round", not "the previous one".

*Depth*
- `taskDepth` over: a chain, a diamond, a wide fan-out, two disjoint roots, a
  mixture of NULL and array rows (the NULL row contributes its own `round`).
- Determinism: same input twice → identical map.

*Round computation*
- `computeRound([])` → 0; `computeRound([r=5, r=7])` → 8; the architect's
  explicit `k*100` passes through untouched; the block-overflow refusal at 99
  levels (R24) — **a 99-deep chain passes and the 100th is refused**, which is
  the case that proves the gate is satisfiable rather than decorative.

*Cycles* — table-driven (R25)

| graph | expect |
|---|---|
| `a → a` | cycle `[a, a]` |
| `a → b → a` | cycle naming both, oldest first |
| `a → b → c → a` | cycle naming all three |
| diamond `a→b, a→c, b→d, c→d` plus `d→a` | cycle through one branch |
| chain of 50, no back edge | `null` |
| wide DAG, 1 root → 30 leaves | `null` |
| candidate depending on a node whose own deps are NULL (legacy) | `null`, and no crash |

Each cycle case asserts the returned path's **ids in order**, not just its
length — a detector that finds "a cycle exists" without naming it fails R25.

*Contention*
- `conflicts`: disjoint → false; identical → true; one shared entry → true;
  `{}` vs anything → **false** (R17); `src/a.ts` vs `src/a.tsx` → false (no
  prefix semantics); `src/` vs `src/a.ts` → false, with a comment saying this is
  deliberate.
- `selectClaimable`: two ready tasks sharing a file in one workstream → one
  claimed; the same two in different workstreams → **both** claimed; a ready
  task conflicting with a *running* task → not claimed; three-way chain
  a↔b, b↔c, a∌c → a and c claimed, b deferred (order-stable and asserted).

*Validators*
- `validateWorkstream`: `main`, `ui`, `api-v2` pass; `Main`, `-ui`, `ui_`, a
  41-char name, `../x`, empty all throw.
- `normaliseWritePath`: `./src/a.ts` → `src/a.ts`; `src//a.ts` → `src/a.ts`;
  `/etc/passwd`, `../x`, `a\0b`, a 401-char path, all throw naming the entry.

**`task-graph-replay.test.ts`** — the replica proof, R18. Its own file because
it is the single most important test in the project and must be findable.

```
FIXTURE  forge-control/src/lib/fixtures/replay-operator-visibility.json
         {id, round, role, title, status, created_at} × ~124, no briefs
HARNESS  simulate(rule): tick until quiescent, recording per tick the SET of
         tasks promoted; a promoted task "runs" and becomes done on the next tick
ASSERT   simulate(legacyRoundReady) deep-equals simulate(graphReady-over-backfill)
```

Five cases (R18 a–e): base, retry of an early round after a later one drained,
insertion into a drained round, pause/resume, and a permanently-failed task
(both must wedge identically). The harness prints the fixture row count and
`git rev-parse --short HEAD` **before** asserting — standing rule 3: a harness
that does not expose its own build identity is not evidence.

**Extensions to existing test files** — new cases only, no edits to existing
ones (R43):
- `project-reconcile.test.ts` — `chainKeys` for a named workstream; the existing
  `main` cases must pass byte-identically.
- `cp2-reconciler-interaction.test.ts` — two same-round reviewers in different
  workstreams yield two independent chains (R40).
- `project-tick.test.ts` — prompt-content assertions for R47–R53, and the
  prompt-length budget (NF7).
- `migrations.test.ts` — the named `0040_task_graph.sql` case (R2).

### 2.2 Integration — `scripts/checks/*`, run explicitly, never in `pnpm test`

Anything needing Postgres or a real git repository is a script, so the unit
suite stays hermetic (NF3).

| Script | Proves | How |
|---|---|---|
| `scripts/checks/check-migration-0040.sh` | R2, R6, R7 | Creates a throwaway schema in a **local scratch database**, seeds it from the replay fixture, applies 0040 **twice**, diffs the resulting `project_tasks` rows, asserts the second application changed zero rows and the indexes exist. |
| `scripts/checks/check-scheduler-sql.sh` | R11–R14 | Against the same scratch schema: a graph-ready task promotes with its round undrained; a NULL-deps task does not; a dangling dep yields `blocked`, not `ready`. |
| `scripts/checks/check-workstream-e2e.sh` | R32–R35, R38 | In a throwaway git repo under `/tmp`: provision `main` + two workstreams, assert branch names and sibling directories, assert `git status --porcelain` in `main` is **empty**, have two workstreams write the same file, run the integration merge, assert it exits non-zero and names the conflicting file, assert nothing was auto-resolved. |
| `scripts/checks/check-task-api.ts` | R22–R31 | Mounts **only** `routes/projects.ts` on a spare port against the scratch database (the single-router probe pattern — `src/index.ts` starts cron/telegram/vault ticks and must not be booted), then drives the 400s and the 409. |
| `scripts/checks/check-plan-store.ts` | R54–R56 | Extended: real edges in, `planEdges()` out, phase grouping intact. |

**Scratch database, not the live one.** Every script takes its connection string
from `SCRATCH_DATABASE_URL` and **refuses to run** if that variable is unset or
points at `content_forge`. A check that can be pointed at production by
forgetting an environment variable is an incident waiting for a tired night.

### 2.3 End-to-end — phase 8 only

Live verification against the real database, the real executor and the real API
happens **only** in the explicitly-briefed deploy/verify task (R67). No build
task touches `/opt/forge-ai-os`, live endpoints, or the live database. If a
builder genuinely cannot prove something from the worktree, it says so in its
final message and lets phase 8 prove it.

---

## 3. QA gates per phase

Each phase's gating reviewer runs **all of §3.1** plus its own phase block, and
quotes the output. A review without executed checks is not a review.

### 3.1 Universal gate — every phase

```bash
cd forge-control && pnpm typecheck && pnpm test
git -C /opt/forge-ai-os status --porcelain          # MUST be empty
git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
```

1. `tsc --noEmit` clean.
2. `tsx --test src/lib/*.test.ts` — **all green, zero skipped**. A skipped test
   is a finding; deleting a test is a finding unless the commit message names the
   requirement it retires (standing rule 4).
3. `git -C /opt/forge-ai-os status --porcelain` empty. **Any** output means
   someone hot-applied work into the live checkout. By itself a `NEEDS_FIXES`,
   with the dirty files named verbatim. Paste the output — or its emptiness —
   into the review.
4. **Write-set audit (R57/F8).** For every builder task in the group, compare
   `git log --name-only` for that task's commits against its declared
   `write_set`. An undeclared write is a finding. This is satisfiable exactly
   because write-sets are declared rather than reconstructed.
5. **Citation audit.** Every `file.ts:NN` in the phase's commits, briefs and
   docs is either resolved against the recorded SHA beside it or reported as a
   finding. Three rounds on the previous project found rotted pins that read as
   authoritative and were wrong.
6. **Silent-fallback audit (NF1).** List every `catch`, `?? default`,
   `|| fallback` and `.catch(() => {})` the phase added, and state for each why
   it is not a swallowed error.

### 3.2 Phase gates

**Phase 1 — schema, fixture, replica harness**
- `scripts/checks/check-migration-0040.sh` green, output pasted, including the
  "second application changed 0 rows" line.
- `migrations.test.ts` names `0040_task_graph.sql`.
- The fixture exists, has > 100 rows, and contains **no brief text** — the
  reviewer greps it for `curl`, `http`, and any string over 500 chars.
- The replay harness runs and prints its SHA and row count. It may legitimately
  **fail** at this phase if phase 2 has not landed; the gate is that it runs and
  reports, not that it passes.

**Phase 2 — graph scheduler**
- **The replay test passes.** This is the phase's whole point. All five cases
  (R18 a–e). Divergence output, if any, is pasted verbatim.
- `check-scheduler-sql.sh` green, including the dangling-dependency case landing
  on `blocked` and **not** on `ready`.
- The reviewer states, in its own words, what would have made the replay test
  report a pass **wrongly** — e.g. a harness that runs both rules over the same
  backfilled array without actually applying the legacy rule; a fixture whose
  every task is already `done`; a tick loop that terminates before divergence.
  Then it checks that each of those is impossible. (Standing rule 3.)
- `grep -n "round" forge-control/src/db/projects.ts` with a justification for
  every surviving occurrence (R20).

**Phase 3 — task creation, validation, cycles**
- `check-task-api.ts` green, with the 400 bodies pasted — cycle path named,
  dangling ids named, bad write-set entry named.
- The cycle table (R25) is complete: seven rows, each asserting the path's ids.
- The reviewer confirms R26's belt comment exists and is honest — a detector
  documented as unreachable is a detector nobody deletes by accident.
- Double-POST with an identical body → exactly one row, `409` on the second
  (R30).

**Phase 4 — worktrees, integration, consolidation** — *highest risk, red team required*
- `check-workstream-e2e.sh` green, with the conflict case's non-zero exit and
  named files pasted.
- `git status --porcelain` in the main worktree empty after a second workstream
  exists (R34).
- **Every existing reconcile test passes unmodified** (R43). The reviewer runs
  `git diff main -- forge-control/src/lib/project-reconcile.test.ts
  forge-control/src/lib/cp2-reconciler-interaction.test.ts` and confirms it is
  empty, or reads the commit-message justification for each hunk.
- `grep -rn "merge" forge-control/src` with a justification for every hit; the
  reviewer confirms there is no path that merges a workstream branch without a
  task (R38, N3).
- **Adversarial reviewer** (see §5).

**Phase 5 — prompts**
- `grep -rn "consecutive rounds" forge-control/` is **empty** (R49). The old
  `PARALLELISM_GUIDE` is deleted, not commented out, not left unreferenced.
- Prompt-content assertions for R47–R53 green.
- Prompt-length budget assertion green (NF7), and the reviewer reads the built
  planner prompt end to end once, as a planner would, and says whether it is
  followable. A prompt that passes a `.includes()` check and confuses a planner
  is a passing gate on a broken deliverable.

**Phase 6 — observability**
- `check-plan-store.ts` green.
- The reviewer loads the `/plan` response for a fixture project and confirms
  `deps` are real edges for graph rows and synthesised for NULL rows, and that
  the response shape is unchanged from the base commit (diff the TypeScript
  interface).

**Phase 7 — measurement**
- The script runs against the fixture and prints its header (SHA, schema
  version, project id, row counts) **before** any number (R60).
- Fed a truncated fixture it exits **non-zero** (R61). The reviewer runs this
  case; an instrument that degrades quietly is worse than none.
- The baseline file for 8ea0cc08 exists and its header names the script's SHA
  (R62).

**Phase 8 — deploy and verify**
- See `04-phases.md` §Phase 8. The gate is the deploy checklist itself.

---

## 4. What the reviewer must run, in one block

Copy-pasteable, for every phase's gating reviewer:

```bash
set -x
cd "$WORKTREE/forge-control"
pnpm typecheck
pnpm test
cd "$WORKTREE"
git -C /opt/forge-ai-os status --porcelain ; echo "exit=$? (empty output is the only pass)"
git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh' --include='*.md' \
  | grep -v -i "never\|forbidden\|not to deploy"    # any survivor is a finding
grep -rn "consecutive rounds" forge-control/         # must be empty from phase 5 on
# plus this phase's scripts/checks/* from 03-quality.md §3.2
```

Then, before writing `VERDICT:`, answer in the review:

1. What would have made my instruments report a pass **wrongly**? Name at least
   two mechanisms and show each is impossible here.
2. Which gate in this document did I find unsatisfiable, and did I amend it
   where it is enforced in the same commit?
3. Every citation I made: symbol name or requirement id? Any line number pinned
   to a SHA?

Close with exactly one line, as the **last** verdict declaration in the message:
`VERDICT: PASS` or `VERDICT: NEEDS_FIXES` followed by a concrete numbered list.

---

## 5. Adversarial review — where and why

A red-team reviewer is briefed to **attack**, not to check, on the two phases
where a plausible-looking pass is most expensive:

**Phase 2 (scheduler).** Attack the replay proof. Try to make it pass while the
schedulers genuinely differ: feed it a fixture where every task is already
`done`; make the tick loop exit early; run both rules over the backfilled array
so "legacy" is not legacy at all; construct a task list where the closure
backfill and the round rule coincide by luck. Then try to make the *engine*
wrong while the test stays green: a dangling dep, a `depends_on` containing a
task of another project, a task whose dependency is `failed` rather than
`pending`, a project paused mid-promotion.

**Phase 4 (worktrees + consolidation).** Attack the isolation and the group key.
Two workstreams at the same computed round — do they get two chains or one? A
workstream whose integration task is skipped — does the project close with the
branch unmerged? `closeFinishedProjects()` marks a project done when every task
is `done`; an unmerged workstream branch with all its tasks done would close the
project **and lose the work**. Prove that cannot happen or find that it can.
Delete a workstream worktree from disk mid-run. Provision the same workstream
from two processes at once. Merge with a conflict and check nothing resolved it.

Both red-team briefs must say explicitly: **your job is to find the case where
this reports success and is wrong.** A red-team reviewer that returns PASS
without having attempted a named attack has not done the job, and its own
reviewer says so.

---

## 6. Regression surface — what this project could break, ranked

| Risk | Blast radius | Guard |
|---|---|---|
| Chain-key change breaks replay of an in-flight fix cycle | Duplicate fix builders in one worktree — bug 1 of the first night | R41's `main` special case; existing `chainKeys` tests unmodified; `insertChainRow`'s `occupied` branch blocks loudly rather than dropping the verdict |
| `depends_on` default releases legacy rows as roots | A live project's re-review runs before its fix builder | The NULL sentinel (§2.2 of `02-architecture.md`); R18-a; the deploy order in R64 |
| Group key change splits or merges a verdict round wrongly | A dropped verdict, or two fix builders | R40 + the new `cp2` case; the phase-4 red team |
| Contention belt too strict | Under-parallelism — the disease, silently | R17's empty-set rule; S1/S2 in the measurement |
| Contention belt too loose | Two agents clobbering in one worktree | `strict_write_sets` for new projects (R31); the reviewer write-set audit (R57) |
| Project closes with an unmerged workstream branch | Silent loss of a whole team's work | Phase-4 red team's named attack; the integration task is a task, so `closeFinishedProjects` cannot fire until it is `done` |
| Prompt regression | Planners produce unschedulable graphs | R47–R53 assertions; the phase-5 reviewer reads the prompt as a planner |
| Deploy kills runs in flight | Every live agent, including the deploy task | R63, R65, R66; `safe-restart.sh` detached, never `pm2 restart forge-executor` |

---

## 7. Definition of "green"

A phase is green when, and only when:

1. `pnpm typecheck` and `pnpm test` are clean, zero skipped.
2. That phase's `scripts/checks/*` are green and their output is pasted into the
   review.
3. The live checkout is clean.
4. Every requirement id assigned to the phase in `01-requirements.md` §K is
   named in the review with the artefact that proves it.
5. The reviewer answered §4's three questions.
6. `VERDICT: PASS` is the last verdict line in the reviewer's final message.

Anything less is `NEEDS_FIXES`. **Disclose-and-proceed is not a verdict.**
