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

**`task-graph.test.ts`** — new file. Cases, grouped, **each group labelled with
the phase that owns it** (added round 204). The groups are not all phase 2's: the
file is created in phase 2 and grows in 3 and 4 as the functions they own land, and
an unlabelled list read as one phase's checklist is how phase 2 came to be judged
against a `computeRound` that R23 assigns to phase 3.

*Readiness* — **phase 2**
- `readyRule` returns `legacy` for `depends_on: null` and `graph` for `[]` and
  for a populated array. Three cases, because the sentinel is the whole
  migration strategy and a mistake here is silent.
- `graphReady`: empty deps → ready; one done dep → ready; one pending dep → not
  ready; mixed done/failed → not ready; **dep id absent from the map → throws
  `GraphIntegrityError`** (R14, never `false`, never `true`); **a duplicated dep id
  → throws too**, naming it (added round 204: R14 is a cardinality rule, the
  shipped SQL blocks the project over a duplicate, and membership testing alone
  made the pure mirror disagree with the statement it mirrors); a duplicate across
  two DIFFERENT tasks — a fan-in — stays silent, or every diamond would block.
- `legacyRoundReady`: reproduces today's rule exactly, including "*every*
  strictly lower round", not "the previous one".

*Depth* — **phase 2**
- `taskDepth` over: a chain, a diamond, a wide fan-out, two disjoint roots, a
  mixture of NULL and array rows (the NULL row contributes its own `round`).
- Determinism: same input twice → identical map.

*Round computation* — **phase 3** (R23; struck from phase 2's deliverable 5 in
round 204, standing rules 2 and 4 — `computeRound()` throws until phase 3 and
that is not a defect)
- `computeRound([])` → 0; `computeRound([r=5, r=7])` → 8; the architect's
  explicit `k*100` passes through untouched; the block-overflow refusal at 99
  levels (R24) — **a 99-deep chain passes and the 100th is refused**, which is
  the case that proves the gate is satisfiable rather than decorative.

*Cycles* — table-driven (R25) — **phase 3**

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

*Contention* — **phase 2**
- `conflicts`: disjoint → false; identical → true; one shared entry → true;
  `{}` vs anything → **false** (R17); `src/a.ts` vs `src/a.tsx` → false (no
  prefix semantics); `src/` vs `src/a.ts` → false, with a comment saying this is
  deliberate.
- `selectClaimable`: two ready tasks sharing a file in one workstream → one
  claimed; the same two in different workstreams → **both** claimed; a ready
  task conflicting with a *running* task → not claimed; three-way chain
  a↔b, b↔c, a∌c → a and c claimed, b deferred (order-stable and asserted).

*Validators* — **phase 3** (R28)
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

**Six** cases (R18 a–f): base, retry of an early round after a later one
drained, insertion into a drained round, pause/resume, a permanently-failed task
(both must wedge identically), and — added round 106 — a fix chain inserted by
the old engine **after** the migration froze the closure (F13/R69). The first
five model *migrate-after-insert*; (f) is the other order, and until it existed
the harness could only ever see one of the two. `graphInput()` therefore takes
an explicit migration-time snapshot: rows outside it carry `depends_on: null`.
The harness prints the fixture row count and
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
| `scripts/checks/check-scheduler-sql.sh` | R11–R14, R16, R17, R27 (SQL half), R69 | Against the same scratch schema: a graph-ready task promotes with its round undrained; a NULL-deps task does not; a dangling dep yields `blocked`, not `ready`. **Round 204 added cases 8, 8b, 9, 10:** `retryTask()` refuses a corrupt row and the following claim does not claim it; a corrupt row written straight to `ready` is still swept; a duplicated id blocks and `graphReady()` agrees; a cross-project id resolves to nothing on both sides. Each new case also drives the real `graphReady()` over the same rows, so the mirror is measured rather than asserted in prose. |
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
python3 docs/plan/engine-task-graph/check-instrument-identity.py   # MUST exit 0
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
7. **Instrument-identity check (round 217, round 216's finding 1).**
   `check-instrument-identity.py` exits 0. It asserts that every
   `instrument-sha256:` header pasted anywhere in this corpus equals
   `sha256sum scripts/measure-schedule.ts` on disk, and that no retired identity
   is quoted without the literal marker `[historical instrument]` on the line.
   **Why it is a universal gate and not a phase-7 one:** round 215 edited the
   script from a phase-3 fix cycle, which moved the identity under eight pasted
   headers, a section heading, a ledger row and a `sha256sum` block the document
   offers as an *independent* re-derivation — and two reviewers read past it,
   because agreeing with a document is not the same as agreeing with the disk.
   Any phase can move the instrument, so every phase checks it.
   It carries its own positive controls: fewer than 8 headers found, or none
   found in `evidence/baseline-8ea0cc08.md`, is a **failure** and not a clean
   run, so a glob that matches nothing cannot certify itself
   (`00-vision.md` §7 rule 2).

### 3.2 Phase gates

**Phase 1 — schema, fixture, replica harness**
- `scripts/checks/check-migration-0040.sh` green, output pasted, including the
  "second application changed 0 rows" line.
- `migrations.test.ts` names `0040_task_graph.sql`.
- The fixture exists, has > 100 rows, and contains **no brief text** — the
  reviewer greps it for `curl`, `http`, and any string over 500 chars.
  **Amended at capture (round 102).** The row count holds: the capture is 131
  rows, so the `> 100` clause is satisfiable and stands unchanged. The grep
  clause was **not** satisfiable as written, and is restated here rather than
  disclosed-and-ignored. `grep -ci 'curl\|http'` over the captured fixture
  returns **1**, on a real task *title* — row `127e1b38-d981-483f-9502-4733f791a3d2`,
  round 904, `status: done`: *"U34 production verification: live endpoint curls,
  dark+light screenshots, and proof the four shipped features are actually
  live"*. That is live data, and R9's rule is that the six projected fields are
  copied faithfully; redacting or editing a title to make a grep return zero
  would corrupt the replay input to flatter an instrument. So the gate now reads:
  **`grep -ci 'curl\|http'` must return 0, or every matching line must be a
  `"title":` line already recorded in the fixture's sibling `.md` by row id.**
  A match on any other key, or on an unrecorded row, is a finding. The intent —
  no brief text, no prompts, no run ids, no secrets — is unchanged and is proved
  by the stronger mechanical clause the sibling `.md` reports: every element has
  **exactly** the six keys `{id, round, role, title, status, created_at}` and no
  others, and no string value exceeds 500 characters (longest observed: 127).
  Brief text cannot enter a document whose key set is closed.
- The replay harness runs and prints its SHA and row count. It may legitimately
  **fail** at this phase if phase 2 has not landed; the gate is that it runs and
  reports, not that it passes.
- **Added round 106.** The six R18 comparison cases stay `todo`, but the `F13`
  block is **not** `todo` and must be green: the frozen closure names no
  post-migration row, a mixed input carries real rounds while a pure-graph one
  withholds them, `graphInput()` refuses a snapshot it cannot honour, and
  today's rule demonstrably holds the captured pending rows behind an appended
  fix chain. Those four run without `graphReady()`, so every premise R69 rests
  on is proved at phase 1 rather than promised for phase 2. Each `todo` must
  report exactly `task-graph: readyRule() lands in phase 2 (R12)` — any other
  message means a legacy-side expectation is wrong and the body was never
  exercised.

**Phase 2 — graph scheduler**
- **The replay test passes.** This is the phase's whole point. All **six** cases
  (R18 a–f). Divergence output, if any, is pasted verbatim.
- **R69, the legacy-row term, is implemented** in `graphReady()` and in the
  graph branch of `promoteReadyTasks()`'s statement (E3, `02-architecture.md`
  §9.2). Case (f) is the test that fails without it. The reviewer checks that it
  was made to pass **by the term** and not by widening the harness's
  migration-time snapshot — the one way to make case (f) green while leaving F13
  wide open. Round 106 measured both: closure-only leaves (a)–(e) green and (f)
  diverging on tick 2; with the term all six agree
  (`evidence/phase1-migration.md` §13.4). Reproducing that mutation is the check.
- `grep -n "TODO(R12-retire)"` covers R69's site as well as R12's — the two
  retire together (standing rule 4) and a term left behind would silently
  re-serialize projects that have no legacy rows left.
- `check-scheduler-sql.sh` green, including the dangling-dependency case landing
  on `blocked` and **not** on `ready`.
- **Added round 204, from the fix cycle.** R14 is a guarantee about every route
  into `running`, not about the promote statement alone, and the reviewer checks
  all four of the paths the round-203 review found open: `retryTask()` (and
  therefore `unwedgeProject()` and `POST /api/tasks/:id/retry`) refuses a row
  whose `depends_on` is still corrupt, naming the ids, and is not overridable with
  `force`; a corrupt row sitting at `ready` with no run is swept; a duplicated id
  is refused by `graphReady()` and by the SQL alike; a cross-project id resolves
  to nothing in both. Cases 8, 8b, 9 and 10 of `check-scheduler-sql.sh` are the
  proof, each observed failing against the unfixed code
  (`evidence/phase2-fix-cycle-1.md` §4).
- **The reviewer asks of any claim in a doc-comment or in this corpus: does the
  named instrument actually execute it?** Round 203 found four places crediting
  the R18 replay with proving R17's contention clause, which it cannot — it
  imports neither `conflicts` nor `selectClaimable` and has no claim step. The
  check is mechanical: mutate the rule the claim is about and watch the named
  instrument. If it stays green, the claim is wrong.
- The reviewer states, in its own words, what would have made the replay test
  report a pass **wrongly** — e.g. a harness that runs both rules over the same
  backfilled array without actually applying the legacy rule; a fixture whose
  every task is already `done`; a tick loop that terminates before divergence.
  Then it checks that each of those is impossible. (Standing rule 3.)
- **`scripts/checks/check-r20-census.py` exits 0**, and
  `scripts/checks/check-r20-census.py --self-check` with it (R20). This replaces
  *"`grep -n "round" forge-control/src/db/projects.ts` with a justification for
  every surviving occurrence"*, **amended round 206 where it is enforced**. The
  grep was discharged by a hand-written table in `evidence/phase2-replay.md` §7
  and that table went stale twice — round 205 found its headline counts reading
  85/92 against a file of 99/108. Eleven of the nineteen `round` lines the fix
  cycle added are the literal citation "round 204", which recurs every cycle, so
  the gate as written was one no fix cycle could leave satisfied. The script
  discharges the same requirement and strictly more of it: it regenerates §7's
  census from the file, fails when the committed region is stale, fails when a
  symbol carrying `round` has no attribution, and — the part the grep never
  did — fails **by name** when a scheduling predicate reads `round` outside the
  labelled legacy surface. Reviewers may still run the grep; it is no longer the
  artefact.
- The reviewer confirms the census gate can fail, rather than trusting a green
  run: the mutations of `evidence/phase2-cycle-2.md` §3 (stale region, new
  predicate, unattributed symbol, altered attribution rule) each turn it red,
  and each is reproducible from that document. Mutation 5 of that section is the
  one to read first — the gate is also checked **after being committed**, since
  a region stamped with `git HEAD` goes stale the moment it lands and would have
  made this very gate unsatisfiable.

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
- **Added round 223 — the universal gate does not compile four of this phase's
  six code files, so this phase adds the check that does (standing rule 2).**
  §3.1's `cd forge-control && pnpm typecheck` runs `tsc --noEmit` against
  `forge-control/tsconfig.json`, whose `include` is `["src/**/*.ts"]`. Phase 6's
  web half — `planApi.ts`, `planStore.ts`, `PlanKanban.tsx` and `app/api.ts` —
  lives in **`forge-control-web/`**, a separate project with its own
  `tsconfig.json` that the universal gate never invokes. Without the block below
  the gate would report "`tsc --noEmit` clean" for a phase whose principal
  deliverable was not compiled at all: the same species of failure as phase 7's
  `measure-schedule.ts` gap ("Added round 212" above), and the same repair —
  amend the gate where it is enforced rather than disclose it. The gating
  reviewer runs all four lines and pastes them:

  ```bash
  # PRECONDITION. This worktree ships WITHOUT forge-control-web/node_modules
  # (gitignored), so `npx tsc` in a fresh worktree answers "tsc: not found" —
  # and a gate whose first response is an error is a gate that gets
  # disclosed-and-ignored. MEASURED, round 221: this completes offline in ~1s
  # from the local pnpm store. Keep --frozen-lockfile: it is what guarantees the
  # NFU8 diff below stays empty.
  cd forge-control-web && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline

  cd forge-control-web && npx tsc --noEmit          # exit 0
  cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
  git diff main -- forge-control-web/package.json   # MUST be empty (NFU8)
  ```

  Adding `../forge-control-web/**` to `forge-control/tsconfig.json` was rejected
  for the reason phase 7 rejected `../scripts/**`: it would change what **every
  other phase's** typecheck covers, and the two projects have different
  compiler options (JSX, DOM lib) that phase 6 does not own.
- **`check-plan-store.ts` prints its own provenance and censuses itself
  (standing rule 3, added round 223).** Its first output line is a header
  carrying `git rev-parse --short HEAD`, the branch, whether either subject file
  is uncommitted, the **sha256 of `planStore.ts` and `planApi.ts`**, the
  fixture's node count and the number of assertions it is about to run; its last
  is a census that exits **non-zero when the assertions executed differ from the
  hand-declared count in either direction**. The reviewer confirms both can
  fail rather than trusting the green run — the three mutations of
  `evidence/phase6-plan-api.md` §3.4 are reproducible, and the third is the one
  to read first: it prints **zero FAIL lines and still exits 1**, because the
  table declared a case it never reached.

**Phase 7 — measurement**
- The script runs against the fixture and prints its header (SHA, schema
  version, project id, row counts) **before** any number (R60).
- Fed a truncated fixture it exits **non-zero** (R61). The reviewer runs this
  case; an instrument that degrades quietly is worse than none.
- The baseline file for 8ea0cc08 exists and its header names the script's SHA
  (R62).
- **Added round 212 — the universal gate does not reach this phase's principal
  deliverable, so this phase adds the check that does (standing rule 2).**
  `forge-control/tsconfig.json` reads `"include": ["src/**/*.ts"]` — verified at
  git SHA `126969acd55985d9d7c79d63877718a55794349b` and still reading that at
  `5a1180d17af78c77fcbd8bd2fede1d3ded4808c4`. `scripts/measure-schedule.ts` lives
  at the **repo root**, outside that include, so `pnpm typecheck` — item 1 of
  §3.1, and the only typecheck any phase runs — never examines it. Without the
  line below the universal gate would report `tsc --noEmit clean` for a phase
  whose principal deliverable had not been compiled at all: a gate passed by a
  file nobody looked at, which is the same species of failure as a probe that
  never touches its target. The gating reviewer runs this and pastes it:

  ```bash
  cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
    --module ESNext --moduleResolution bundler --allowImportingTsExtensions \
    --resolveJsonModule ../scripts/measure-schedule.ts
  ```

  Adding `../scripts/**` to `forge-control/tsconfig.json`'s `include` was
  rejected deliberately: it would change what **every other phase's** typecheck
  covers, and phase 7 does not own that decision.

  The reviewer confirms the check is not vacuous by re-running it with
  `--listFiles` and finding `src/lib/schedule-source.ts` and `@types/pg` in the
  program — the wrapper reaches its database reader through a dynamic
  `await import()`, and a compile that resolved neither would be clean for the
  same reason an unread file is clean.
- **Added round 212 — `full` never degrades to `rounds` (R61).** The instrument
  takes a named subcommand, and the reviewer confirms the two modes do not leak
  into one another: `full` over a task-only fixture exits non-zero naming the
  missing `runs` key rather than printing the round table, and `full` over a
  4-row fixture exits non-zero on `too-few-tasks` having printed its header and
  **no** table. `rounds` prints, in its own header, the constant
  `S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no
  concurrency result.` A `full` run that emitted a smaller, prettier table and
  announced the degradation only in its exit status is the failure R61 names, and
  it is a finding.

**Phase 8 — deploy and verify**
- See `04-phases.md` §Phase 8. The gate is the deploy checklist itself, plus the
  two clauses below, both added round 215.
- **E-3's baseline read happened at step 2b, BEFORE step 3 applied migration
  0040.** Check the order in `evidence/phase8-deploy.md`, not the intent. Round
  214's phase-7 finding 1: 0040's R6 backfill overwrites the
  `depends_on IS NULL` sentinel with the strictly-lower-round closure, under
  which every S3 term is 0 by construction — the instrument certifying "no
  numbering stall" for the project whose numbering stall justified this work.
  Two independent things must both hold, and the gate fails if either is
  missing: the ordering above, **and** a header line reading
  `closure-shaped-rows=0` in the pasted baseline output. A non-zero count on the
  8ea0cc08 baseline means the read happened after the migration whatever the
  narrative says.
- **Read the S3 line correctly — amended round 217, round 216's finding 2, in
  the same commit as the step-2b prose it enforces.** This clause used to say
  that a `NOT COMPUTABLE` S3 meant the detector had caught a late read. Half of
  that was wrong, and it would have failed a correct deploy. **S3 is NOT
  COMPUTABLE at step 2b too**, and necessarily: before migration 0040 there is
  no `depends_on` column, so every row is a legacy row and D7's first arm
  refuses. Judge the refusal by its **counts**, which is what makes this gate
  satisfiable:
  - `S3 … NOT COMPUTABLE (131 legacy rows, 0 closure-shaped rows)` — the
    **PASS**. The read happened before the migration and the refusal names the
    legacy sentinel.
  - `S3 … NOT COMPUTABLE (0 legacy rows, N closure-shaped rows)` — a **finding
    and a redo**. `legacy-rows=0` on a project that has never been graph-planned
    means the backfill already ran; the detector caught a late read.
  - **Any S3 number at all for 8ea0cc08** — the worst outcome, and a finding
    whatever the ordering claims, because the only shape that produces one is
    the backfilled closure computing tautologically to 0.
  S1, S2, the run count, the mean run duration and the wall clock are what part
  2 actually owes (R62); those must be present and are unaffected by the
  migration either way.
- **Instrument identity, before the append.**
  `python3 docs/plan/engine-task-graph/check-instrument-identity.py` must exit 0
  *before* part 2 is appended to `evidence/baseline-8ea0cc08.md`. If the
  instrument has moved since round 217, part 1's seven commands are re-run and
  their headers replaced **in the same commit** that appends part 2 — see
  `04-phases.md` §12, E-3, and the re-run record in §1 of that file. A part 2
  whose header disagrees with part 1's breaks R62's one-instrument guarantee.
- **R31 must not reach production ahead of R47–R53.** R31 (`strict_write_sets`
  → a `builder`/`tester` task with no `write_set` is a `400`) is enforced from
  phase 3; the behaviour that satisfies it — planner, architect and builder
  prompts that declare a `write_set` — lands in phase 5. Today's shipped prompt
  in `project-tick.ts` mentions `write_set` **zero times**. Because there is
  exactly one deploy, at phase 8, no window exists in practice; this clause
  exists so that a phase-8 task tempted to ship early cannot open one. Verify
  before the restart: `grep -c "write_set" forge-control/src/lib/project-tick.ts`
  is **> 0**. If it is 0 while R31 is live, the first goal project created after
  the restart `400`s on its first builder fan-out.

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
# R66, amended round 215 — EXECUTABLE FILE TYPES ONLY, and no -v filter.
# Expect exactly 4 hits, all string literals inside NEVER-worded prohibitions
# (project-tick.ts ×2, project-tick.test.ts ×2). READ EACH ONE: R66 permits the
# string only inside a sentence forbidding it. A 5th hit, or any hit in an
# executable position, is a finding. Prose files are swept separately below.
grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
grep -rn "consecutive rounds" forge-control/         # must be empty from phase 5 on
# Round 217, §3.1 item 7 — instrument identity. Exits 0, or names every document
# that quotes a dead one. Reads the disk, not the corpus's claims about the disk.
python3 docs/plan/engine-task-graph/check-corpus-map.py
python3 docs/plan/engine-task-graph/check-instrument-identity.py
# plus this phase's scripts/checks/* from 03-quality.md §3.2
```

**Why this gate changed — round 214's phase-3 finding 5, amended here where it
is enforced.** The command used to sweep `*.ts`, `*.sh` **and `*.md`** and pipe
through `grep -v -i "never\|forbidden\|not to deploy"`, under the comment
`# any survivor is a finding`. Two things were wrong with it.

The filter is a **narrower rule than R66's own**, which forbids the string
*"except inside a sentence forbidding it"* — a sentence may prohibit without
using any of those three spellings. Twelve survivors came out of it on this tree
and **every one was prose prohibiting the command**: `00-vision.md`, R66 itself,
this document's own gate line, `deploy-playbook.md`, two evidence files. The gate
could never be clean, on this tree or any future one, and three consecutive
reviewers disclosed-and-proceeded against it. **A gate that can only be disclosed
teaches that disclosure is normal**, and that habit is what let a self-certifying
hover probe survive round 213 (`00-vision.md` §7 rule 2).

The repair is a scope narrowing plus an honest instruction, not a cleverer
filter. **Scope:** a `.md` cannot execute anything, and every `.md` hit in this
corpus is a prohibition by construction — the documents that discuss R66 are the
documents that forbid it. Sweeping `*.ts` and `*.sh` leaves **4 hits, a number
small enough to read**, and reading them is what R66's rule actually requires:
all four are string literals *inside* NEVER-worded prohibitions — two in
`project-tick.ts`'s shipped deploy guidance, two in `project-tick.test.ts`
asserting that guidance still carries the prohibition. **Instruction:** the
comment now states R66's rule and names the expected count, so a fifth hit is a
signal rather than noise, and no `grep -v` decides on the reviewer's behalf.

A CONSIDERED-AND-REJECTED ALTERNATIVE, recorded so the next round does not
re-derive it: narrowing to this branch's diff
(`git diff $(git merge-base main HEAD)...HEAD | grep '^+.*pm2 restart…'`) looks
tighter and is **not satisfiable here either** — this branch *created* the
corpus, so all ten prohibitive prose lines are `+` lines on it. Measured, round
215: 10 hits. It would have been the same unsatisfiable gate wearing a diff.

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

**The hand-renumber attack** (`02-architecture.md` §2.3.1, observed live during
round 0): with a fix chain already written for a group, change that group's
`round` by hand in the database and force a re-consolidation. Does the replay
compute a different `chain_key`, miss its own chain, and insert a second one?
`grep -n "SET round"` over the tree returns nothing — **no engine path writes
`round` after insert** — so this is reachable only by an operator with `psql`,
and an operator did exactly that to this project's own scout task at ~03:31 on
2026-08-17. The hazard predates this project and this project does not claim to
fix it. **Report the answer either way**; do not silently repair it in phase 4,
and do not report PASS on the grounds that it is pre-existing.

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
