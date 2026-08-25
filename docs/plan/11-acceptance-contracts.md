# 11 — Acceptance contracts: a number measured from outside the worktree

Project `aios-verification-that-bites`, deliverable D5. **Design only — nothing in this
document is built.** Konrad says yes or no to §1. Every file:line below was read on
branch `project/169903ec-contract` at `259778b` on 2026-08-25; every measurement was taken
that day and its command is in `docs/research/round-0-9351a1cf.md`.

## 1. Recommendation

**Build it, small, and start with the write-set contract.** One pre-registered contract
type, `write_set_realised`, selected (never authored) at `POST /api/projects`, stored in
`projects.metadata.contract`, measured by **forge-executor** from the main checkout's git
object store — never from the worker's worktree — and made a term of **both** close
predicates. A project whose contract is unmet or whose measurement errors **stays
`active` and is held open**, exactly the way R70 holds a project with an unmerged
workstream today: one Telegram push, one manager-chat line, re-armed when it clears.

Three things the brief took as given are false, and the design is shaped by them:

1. **Workers hold the database credential.** `cc-runner.ts:438` is `const env = {
   ...process.env }` — the child inherits forge-executor's whole environment, and
   forge-executor's pm2 env carries `DATABASE_URL` (pm2 jlist, 2026-08-25). Measured from
   inside this run: `DATABASE_URL`, `PGPASSWORD`, `HCP_DATABASE_URL`, `AI_OS_DATABASE_URL`
   are all set in a worker's shell. `gemini-runner.ts:183` and `cli-runner.ts:1354,1547`
   do the same. The PreToolUse guard (`/opt/ai-os/scripts/guard-autonomy.py:182-190`)
   blocks `psql` only for `DROP|TRUNCATE|FLUSHALL|FLUSHDB`; an `UPDATE projects` passes.
   So substrate (i) below is *not* unreachable today. **Prerequisite P0 (its own task,
   not this project): delete the four DSN variables from the child env in those three
   runners.** Even after P0, `pm2 jlist` still prints forge-control's env to any root
   process, so "the worker cannot write to it" is a policy line plus a deliberate
   boundary crossing, not a wall. That is still a long way from "a file in my own tree".
2. **There are two close points, not one.** `closeFinishedProjects()`
   (`db/projects.ts:625-693`) is the R70-aware one. `reconcileProjectStatuses()`
   (`db/projects.ts:799-863`) *also* sets `status='done'` — for any `blocked` project
   whose tasks are all terminal, with no R70 term at all (`:848-853`). A contract wired
   into only the first is bypassed by `blocked → done`. Both must carry the term.
3. **Three-dot diffs against `main` are vacuous on this branch.** `git rev-parse main
   HEAD project/169903ec` returns one sha (`259778b`). The measurement therefore pins the
   base sha at provisioning and diffs two commits, never `main...`.

And the evidence the opener would have bitten, re-measured today rather than quoted:
**385 declared paths on `done` ai-os tasks in the last 3 days, 12 absent from the
declaring branch's tip.** Attributed one by one (§7): 2 renumbered migrations (false
positive by number), 2 rows for one test relocated to `src/lib/` "so pnpm test actually
runs it" (commit `2426884`), 2 tests declared under `src/db/`,`src/routes/` and written
under `src/lib/` (the glob workaround, evidence item 4), 1 declared under a different
name, and **5 never written on the declaring branch at all** — including a reviewer's
own review file and the researcher deliverable from memory note
`done-never-verifies-the-declared-write-set`. Nothing in the engine noticed any of them.

## 2. What the contract is

```
projects.metadata.contract = {
  "type": "write_set_realised",   // from the engine's library; the only v1 type
  "v": 1,
  "declared_at": "<iso>",         // set by buildProjectMetadata(), never by a worker
  "baseline": {                    // set by provisionWorkspace(), once
    "base_branch": "main",
    "base_sha": "259778be7d09b65b4f0fe4b56e1aa1f2bcb49240"
  },
  "result": null                   // written ONLY by the measurement (§4); shape in §5
}
```

**Definition of `write_set_realised`:** every path in every `done` task's `write_set`
appears in `git diff --name-only <base_sha> <work_branch>` (added, modified *or* deleted —
`--name-only` lists post-image names for all of them, git-diff(1)). Tasks in
`cancelled` are excluded; an empty `write_set` is vacuously met, which is what makes
fix-cycle rows (structurally `{}`) harmless.

**Why this one first.** It costs one `git diff` and one `SELECT`; its inputs are the
task rows the operator already ruled immutable (`ledger-gap-is-the-finding`, 2026-08-19:
never amend a done row's `write_set`); and the shortest path to green — actually writing
the file — is the behaviour we want. The cheapest *dishonest* path, `touch`ing a stub,
leaves a diff hunk a reviewer can see, which is strictly better than today's invisible
absence.

## 3. Measurement substrates, ranked by distance from the worker's hands

| # | Substrate | Measures | Cannot measure | Shortest-path defeat |
|---|---|---|---|---|
| (ii) | Command against the **pinned base sha** in a throwaway checkout (`git worktree add --detach <tmp> <sha>` or `git archive <sha>`) | The *before* of anything computable from a tree: test counts, gate verdicts, file existence, LOC | The *after* — by construction it is the old code | None. History at a sha is immutable; the worker never sees the checkout. Farthest. |
| (iii) | Executable **frozen at base sha**, run against the worker's branch | Any tree property an instrument that pre-dates the project can compute; `git diff` is the degenerate, fully self-contained case | Anything whose instrument the project itself builds — this project's new checks can never be their own contract | Only through the instrument's own seams: `gates-808.sh` at base sha still `tsx`'s `scripts/checks/*.ts` **from the tree it is pointed at**, so a tree-resident helper is worker-writable. Rank by self-containment; `git diff` has no seam. |
| (i) | SQL forge-control runs against its own DB | Row facts: task statuses, declared sets, spend, run counts, notifications | Code, behaviour, deployed effect | Today: `psql "$DATABASE_URL" -c "UPDATE projects …"` from the worker shell (§1 fact 1). After P0: `pm2 jlist` then the same. Both are a deliberate crossing every brief forbids; neither is a shortest path. |
| (iv) | External observation: HTTP probe, pm2 state, a live row count | The **observed effect** Konrad's framing asks for, after the deploy task | Anything before deploy; anything another project's deploy can move | Worker restarts a service (executor/control restarts are hook-blocked; others are not) or edits live data. Also fragile: an unrelated deploy turns it `error`. Use only with a project-specific, idempotent probe. |

**v1 uses (i)+(iii) with `git diff` as the frozen executable.** (ii) is the right
substrate for the *next* type (a before/after test-count or gate-verdict contract) and
its throwaway checkout is exactly what `unreachable-guard-needs-its-own-control` and the
mutation-rule worker already do by hand. (iv) is the type Konrad's framing wants most
and the one most likely to hold projects open for reasons unrelated to them; it earns
a second design once the first contract has run for a fortnight.

## 4. The six operability answers

**1. What owns the state.** `projects.metadata.contract` — declaration, baseline, and
result all in the one jsonb key. **No migration for storage**: `metadata` is already the
home of `mode`, `checkin_hours`, `origin_chat_id`, `tier_pin`, `strict_write_sets`
(`buildProjectMetadata()`, `routes/projects.ts:134-188`) and the task-create route
already reads a policy flag from it (`strict_write_sets`, `:756`). PostgreSQL's own
guidance is that jsonb is the right store when structure is "typically unenforced"
(datatype-json, PG 18). A real column would buy a CHECK constraint on the *shape* — the
thing that matters is the *write path*, and that is enforced by code: the key is written
by `buildProjectMetadata()` at creation and by the baseline/measurement steps in
forge-executor, and **no HTTP route writes it, ever** — the same no-PATCH ruling that
protects `write_set`. Note `:7700` is unauthenticated on loopback (GET `/api/projects` →
200 from this worker shell), so "no route" is the whole defence at the API layer.

**2. What dispatches the measurement.** `projectTick()` (`project-tick.ts:2909-2957`,
called from `executor.ts:1864` every ~10 s), in a new step `settleContracts()` placed
**after** `reconcileSettledTasks()` and **before** `closeFinishedProjects()`. It selects
the *closable* set only — `status='active'`, no row `NOT IN ('done','cancelled')`
(`stillOpen()`, `db/projects.ts:131`), `metadata->'contract' IS NOT NULL` — runs the
measurement, and writes `result`. Then both close predicates gain one term:

```sql
AND (p.metadata->'contract' IS NULL
     OR p.metadata->'contract'->'result'->>'status' = 'met')
```

— in `closeFinishedProjects()`'s UPDATE (`:635`) **and** in the `blocked → done` UPDATE
at `reconcileProjectStatuses()` (`:848-853`). The baseline is written once, by
`provisionWorkspace()` (`workspace.ts:104`, right after `resolveStartPoint()`), as
`git rev-parse <startPoint>`. Not a separate job: the tick already owns "may this
project close", and a second scheduler is a second place to be wrong.

**3. What happens on failure.** The project **stays `active`, held open**. Not `blocked`
— `reconcileProjectStatuses()` auto-closes it (`:848`) and `fleet-watchdog.sh:37-58`
unwedges it every ten minutes. Not `paused` — `projectAcceptsWork()` refuses new work
and a verdict lands in silence (`paused-project-swallows-fix-chain`). Not a new
`contract_failed` status — that is a migration on `projects_status_check`
(`0030:26-28`), plus every status switch in `ProjectsSurface.tsx`, `MobileApp.tsx`, the
watchdog and reconcile learning a new word. `active`+held is what R70 does today
(`reportUnintegratedWorkstreams`, `project-tick.ts:2859-2905`) and it has the property
that matters: **a fix task can still be seeded and will run.** Measurement error
(git non-zero, `work_branch` NULL, base sha unresolvable, timeout) is `status:'error'`
and holds exactly like `unmet` — never a skip. What unsticks it: (a) a task in `main`
that writes the missing path, after which the next tick re-measures and closes; or (b) a
**waiver**, `metadata.contract.waivers[] = {path, task_id, reason, by, at}`, which the
measurement honours and *prints in the close notification*. The `write_set` row is never
amended — the waiver is the disclosure the ruling asks for, and a renumbered migration
(2 of 385 paths) is what it is for. A worker waiving its own contract is not prevented at
the API (§4.1), but it is loud: the close push names the waiver and its `by`.

**4. How Konrad sees it broke.** Same three surfaces as R70, one message each, pushed
once on the crossing and re-armed on clear (`r70Escalated` pattern, `:2854`):
`notifications` → Telegram (source `project`, `db/notifications.ts:39`); the manager
chat when `origin_chat_id` is set (`managerChatRunId`, `db/projects.ts:2549`); and
`GET /api/projects/:id` → `metadata.contract.result`. The text distinguishes the two
failures by shape, and so does `result.status`:

```
⛔ Project "X" cannot close — contract write_set_realised UNMET: 3 declared path(s)
   never appeared in 259778b..project/abcd1234 —
   task a45cc887 (reviewer, r2): docs/review-goals-day-system.md
   task 5c696826 (builder, r0): forge-control-web/app/desktop/chat/open-file-bus.ts, …
   Write them in a fix task, or waive with a reason.
⛔ Project "X" cannot close — contract measurement BROKEN: git exit 128:
   "fatal: bad object 259778b…" — this is the engine, not the work; needs the operator.
```

`ProjectsSurface.tsx` renders only `status` today (`:688-704`, no `metadata` read); a
`contract unmet` / `contract broken` suffix on the chip is a one-line UI follow-up, not
part of this decision.

**5. Who writes the contract.** **A library, and the caller only selects.** The
architect is an agent; an agent that authors its own acceptance number and meets it has
proved nothing, and an agent-authored *shell string* stored in jsonb and executed by
forge-executor is remote code execution by design. So: contract types live in engine
code (`lib/contracts/*.ts`), each with a fixed measurement; `POST /api/projects` accepts
`"contract": {"type": <library name>, …params the type allows}`; the v1 type takes no
parameters at all — its inputs are the task rows. Konrad does not approve contracts
per project: he approves *types*, once, by merging them. An agent-authored contract
would still be worth something (declared before the work, like preregistration — COS:
"the same data cannot be used to generate *and* test a hypothesis"), but the write-set
type already gets the "declared before" property from the task rows themselves, so the
library costs nothing it was going to give us anyway.

**6. The migration path.** `contract` absent ⇒ both close terms are true ⇒ **closes as
today, unenforced. This is a ratchet, not a wall.** For *new* projects the default flips
on: `buildProjectMetadata()` sets `contract = {type:'write_set_realised', v:1}` unless
the body says `"contract": {"type": "none", "reason": "…"}`, which is stored verbatim
and printed in the creation line so an opt-out is visible where the project was born.
`repo:'scratch'` projects have no worktree and `work_branch='main'`
(`workspace.ts:57-81`); they cannot carry this type and the route returns 400 rather
than storing a contract that can only ever `error`. Existing live projects: untouched.

## 5. Worked example

`POST /api/projects` body (only `contract` is new; every other field is `:99-108`):

```json
{
  "name": "aios-example",
  "brief": "…",
  "repo": "ai-os",
  "architect_tier": "standard",
  "origin_chat_id": "e21f52b4-77b0-416b-8892-c83578715b90",
  "contract": { "type": "write_set_realised", "v": 1 }
}
```

Measurement, as forge-executor runs it inside `settleContracts()` — one query, one
git call, a set difference in code:

```sql
-- inputs: declared paths on FINISHED rows only (cancelled rows never wrote anything)
SELECT t.id AS task_id, t.role, t.round, t.workstream, unnest(t.write_set) AS path
  FROM project_tasks t
 WHERE t.project_id = $1 AND t.status = 'done';
-- the branch and the pinned base come from the projects row, not from the worker
SELECT work_branch, metadata->'contract'->'baseline'->>'base_sha' AS base_sha,
       metadata->'contract'->'waivers' AS waivers
  FROM projects WHERE id = $1;
```

```sh
# two-commit form, deliberately NOT `main...`: local main can equal HEAD (§1 fact 3).
# Run from the MAIN checkout: refs are shared, the worker's worktree is never entered.
timeout 30 git -C /opt/forge-ai-os diff --name-only "$BASE_SHA" "$WORK_BRANCH"
# exit != 0  → result.status = "error", stderr's first line into result.detail
```

Result written back by the same process — the only writer of this key after creation:

```json
"result": {
  "status": "unmet",                          // met | unmet | error
  "measured_at": "2026-08-25T14:02:11Z",
  "range": "259778be…..project/abcd1234",
  "declared": 385, "realised": 380, "waived": 2,
  "missing": [ {"task_id":"a45cc887-…","path":"docs/review-goals-day-system.md"} ],
  "detail": null                              // error: "git exit 128: fatal: …"
}
```

Then the two close UPDATEs run with the §4.2 term. A `met` result closes the project on
the same tick; nothing else about closing changes.

## 6. How a builder proves this bites (the mutation rule, applied to itself)

Not part of the decision, but the acceptance test for whoever builds it, so it is
written down now: (1) seed a scratch project with one `done` task declaring a path,
commit nothing → the tick must leave it `active` with `result.status='unmet'` and push
once; (2) commit the file → it closes; (3) set `base_sha` to a nonsense hex → `error`,
held, one push naming git's exit code; (4) set `status='blocked'` on an unmet project →
it must **not** be auto-closed by `reconcileProjectStatuses()` — that is the test that
proves the second close point carries the term. A build that cannot show (1) and (4)
failing on the old code has decorated the engine, not changed it.

## 7. Evidence — the 12 flagged paths, attributed

| declared path | task | what actually happened |
|---|---|---|
| `db/migrations/0043_goals_and_calendar.sql` | 4a854afb | exists as `0044_` — renumbered (false positive by number) |
| `db/migrations/0043_journal_entries.sql` | 95b00d42 | exists as `0045_` — renumbered |
| `forge-control/src/routes/files.test.ts` ×2 | 7f57052a, 16253cd5 | written, then moved to `src/lib/files-routes.test.ts` "so pnpm test actually runs it" (`2426884`) |
| `forge-control/src/db/autonomy-blanket.test.ts` | 87c01d40 | written as `src/lib/autonomy-blanket.test.ts` — the glob workaround |
| `forge-control/src/routes/autonomy-changes.test.ts` | 87c01d40 | written as `src/lib/autonomy-changes.test.ts` — same |
| `forge-control/src/lib/index-health.test.ts` | 5e9416a9 | written as `memory-index-health.test.ts` |
| `docs/review-goals-day-system.md` | a45cc887 (reviewer) | **never written anywhere** |
| `evidence/aios-journal-thoughts-stats/landing-manifest.json` | 5c696826 | **never written anywhere** |
| `…/chat/code-path-link.ts`, `…/chat/open-file-bus.ts` | 5c696826 | exist only on **another project's** branches (`project/ecacba29*`); never on the declaring branch |
| `evidence/aios-sidebar-live-sessions/activity-truth.md` | b0af6539 (researcher) | **never written anywhere** — the memory note's case |

Under the v1 rule as written, all 12 would have held their projects; 2 need a waiver, 10
are real gaps between the ledger and the tree. That ratio — 5:1 signal — is the argument
for building it with a waiver rather than for softening the rule.

## 8. Rejected alternatives

- **A reviewer subagent judging done-ness** — an agent judging an agent on the same
  evidence; it is what the fleet has, and it certified every row in §7.
- **Required green `gates-808.sh` at close** — repo-wide and unrelated to any one
  project; it was green over a committed credential for a month and RED at main from
  another project's palette (`gate5-raw-colours-red-at-main-from-week-board`).
- **Human sign-off on every close** — Konrad becomes the gate; the R70 push already
  shows what he wants to read is the *exception*, not the rule.
- **A `contract_failed` status** — migration plus five status switches for a state R70's
  active-and-held pattern already provides.
- **Landing in `blocked`** — auto-closed at `db/projects.ts:848` and unwedged by the
  watchdog; the one state that turns a failed contract into a success.
- **A new `project_contracts` table** — nothing joins on it yet; jsonb plus a code-only
  write path gives the same immutability today, and a table can follow when there are
  two types.
- **Architect-authored measurement commands** — worker-writable by construction and an
  RCE path through jsonb; the library (§4.5) is the whole answer.
- **Amending `write_set` to match the tree** — ruled out 2026-08-19; the waiver keeps the
  gap visible instead of erasing it.
- **Task-level fail at settle when a declared path is missing** — the right *next* step
  (memory note's "fix worth making"), but a task cannot fail itself today
  (`task-cannot-fail-itself`) and it is an interlock inside a round, not a close
  contract; keep it separate so neither waits on the other.
- **Measuring in the worker's worktree** — the worker can rewrite the instrument; the
  main checkout shares the refs and never the tree, which is the entire point.
