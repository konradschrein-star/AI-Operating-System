# Round 0 research — D5 acceptance contracts: the terrain, re-measured

Project `aios-verification-that-bites`, workstream `contract`, run `9351a1cf`. The design
itself is `docs/plan/11-acceptance-contracts.md`; this file is what it stands on. Every
claim below was read or run on 2026-08-25 on branch `project/169903ec-contract` at
`259778b`, from this worker's shell. No browser session was needed: every source was a
repo file, a live read-only query, or a plain `WebFetch` of a public doc.

## 1. Terrain claims in the brief, each verified — three are false

| Brief said | Measured | Verdict |
|---|---|---|
| `POST /api/projects` body fields at `routes/projects.ts:99-108`; metadata at `:134-188`; handler `:230-282` | Read: `CreateProjectBody` `:100-108` (name, brief, repo, base_branch, architect_tier, mode, checkin_hours, origin_chat_id); `buildProjectMetadata()` `:134-188`; `r.post("/")` `:230-282` | true |
| `createProject()` inserts project + round-0 architect in one transaction | `db/projects.ts:319-375`: `BEGIN` … two INSERTs … `COMMIT` | true |
| `metadata` jsonb free-form, carries mode/checkin_hours/origin_chat_id/tier_pin/strict_write_sets | `0030_coding_projects.sql:29` `metadata jsonb NOT NULL DEFAULT '{}'`; keys set at `routes/projects.ts:138,143,149,171,185`; read back at `:756` | true |
| `closeFinishedProjects()` is the **single** close point | `db/projects.ts:625-693` is one; **`reconcileProjectStatuses()` `:799-863` is a second**: `UPDATE projects SET status='done' … WHERE id=$1 AND status='blocked'` at `:848-853`, with no R70 term — `evaluateProjectStatusReconciliation()` `:729-731` returns `close` for any `blocked` project whose tasks are all terminal | **false** |
| Close conditions: active, ≥1 done, none open, every non-main workstream covered | Quoted from `:635-676`: `p.status='active'`, `EXISTS (… status='done')`, `NOT EXISTS (… ${stillOpen()})` where `stillOpen()` = `status NOT IN ('done','cancelled')` (`:131-133`), and the three-level R70 `NOT EXISTS` | true (for that function) |
| Nothing like acceptance_criteria / success_metric / baseline / verification_command in the schema | `grep -rniE "acceptance_criteria\|success_metric\|baseline\|verification_command\|acceptance_contract" forge-control/src db/migrations` → only prose/fixtures (`schedule-metrics.ts`, `canvas.ts` mtime baseline, replay fixture titles); no column, no key | true |
| **Workers hold no database credentials** — metadata carries `workspace_dir` and nothing else | Metadata part true (`createRunForTask`, `db/projects.ts:2529-2569`). Credential part **false**: `cc-runner.ts:438` `const env = { ...process.env }` then only `ANTHROPIC_API_KEY` is deleted (`:439`); `gemini-runner.ts:183` and `cli-runner.ts:1354,1547` spread `process.env` too. In this run's shell: `DATABASE_URL`, `PGPASSWORD`, `HCP_DATABASE_URL`, `AI_OS_DATABASE_URL` all set (`env \| cut -d= -f1 \| grep -iE "PG\|DATABASE"`). Parent chain: this `claude -p` → pid 606582 `node /opt/forge-ai-os/forge-control/src/executor.ts` → pm2. `pm2 jlist` shows `DATABASE_URL` present for forge-control, forge-control-web, forge-executor; absent for claude-pool | **false** |
| `write_set` stored verbatim and never compared to git | Stored `db/projects.ts:503-559` (`$10::text[]`); validated only for shape `task-graph.ts:878-891`; compared only to other declared sets `task-graph.ts:738-757` (`conflicts(candidate.write_set, other.write_set)`); the reviewer prompt *asks* the agent to audit it (`project-tick.ts:1331-1340`) — no engine code does | true |

Further facts the design leans on:

- `projectTick()` runs from `executor.ts:1864` inside `managerLoop()` with a 10 000 ms
  sleep (`:1866`); order inside the tick (`project-tick.ts:2909-2957`):
  `promoteReadyTasks → spawnTaskRuns → reconcileSettledTasks → closeFinishedProjects →
  reportUnintegratedWorkstreams → reconcileProjectStatuses → goalHeartbeats`.
- R70's hold pattern: `reportUnintegratedWorkstreams()` `:2859-2905`, process-local
  `r70Escalated` set `:2854`, one `queueNotification(…, "project")` per crossing.
- `queueNotification` → `notifications` table → Telegram bridge (`db/notifications.ts:1-8,39-56`).
- `projects.status` CHECK is `('active','paused','done','blocked','cancelled')`
  (`0030:26-28`), never altered since (grep over `db/migrations/*.sql`). Tasks gained
  `cancelled` in `0046`.
- `blocked` is unstable: `fleet-watchdog.sh:37-58` retries failed tasks and unwedges
  blocked projects every 10 min; `reconcileProjectStatuses()` closes them (above).
- Provisioning: `workspace.ts:84-134` — `work_branch = project/<first uuid segment>`,
  start point from `resolveStartPoint(repoPath, base_branch)` (`:104`); **no sha is
  recorded anywhere** (`grep -rnE "base_sha\|fork_point\|merge_base"` → only the
  reviewer prompt's `$(git merge-base …)` at `project-tick.ts:1321` and vault ETags).
  Scratch projects get `work_branch:'main'` and no worktree (`:57-81`).
- Lane branches are visible from the main checkout: `git -C /opt/forge-ai-os worktree
  list` lists all five `169903ec` worktrees; `git -C /opt/forge-ai-os diff --name-only
  main..project/169903ec-contract` exits 0 without entering any worktree.
- `git rev-parse main HEAD project/169903ec` → all `259778b`; `origin/main` is `e8bd592`
  (memory note `worktree-local-main-can-equal-head` reproduced here).
- `:7700` is unauthenticated on loopback: `curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:7700/api/projects` → `200` from this worker shell; `src/index.ts`
  has no bearer/authorization middleware (grep).
- `guard-autonomy.py:182-190` — `psql|mysql|mongo|redis-cli` blocked only on
  `DROP (TABLE|DATABASE|SCHEMA)|TRUNCATE|FLUSHALL|FLUSHDB`.
- `ProjectsSurface.tsx:688-704` renders `selectedProject.status` only; no `metadata`
  read in that file (grep).
- Host git is `2.43.0`; the docs cited below are 2.54/2.55. `--name-only`,
  `--diff-filter` and `worktree add --detach` all predate 2.43 — flagged, not a risk.
- `PLAN.md` at the repo root is the **browser-takeover** plan (round 0 of a different
  project), not this project's; no round-0 plan for `aios-verification-that-bites`
  is visible on this lane.

## 2. The write-set gap, re-measured (read-only, live DB)

```sh
psql "$DATABASE_URL" -tAF'|' -c "
select p.id,p.name,p.status,p.work_branch,t.id,t.round,t.role,t.workstream,t.status,
       array_to_string(t.write_set,';')
  from project_tasks t join projects p on p.id=t.project_id
 where p.repo='ai-os' and t.status='done' and cardinality(t.write_set)>0
   and t.updated_at > now() - interval '3 days' order by p.name,t.round"
# then per path: git -C /opt/forge-ai-os cat-file -e "<branch>:<path>"
#   branch = work_branch for workstream main, else work_branch-<workstream> if it exists
```

Result: **115 rows, 385 declared paths, 12 absent at the declaring branch's tip.**
Attribution via `git log --all --diff-filter=A --format=%h -1 -- <path>` and a
same-basename search — full table in `11-acceptance-contracts.md` §7. Summary: 2
renumbered migrations, 2 rows for a relocated test (`2426884` "relocate
routes/files.test.ts into lib so pnpm test actually runs it"), 3 declared under one
path and written under another, 5 never written on the declaring branch (3 never
anywhere). Tip-existence is a proxy: the real contract diffs `<base_sha>..<work_branch>`
and would also count deletions — no base sha is pinned today, so that exact measurement
cannot be run retroactively.

## 3. Instruments

Not used: the task is repo archaeology plus public docs. `scripts/perplexity.mjs` would
need `PERPLEXITY_API_KEY` (exit 2 per its `--help` contract, not exercised);
`research-browser.mjs` was not opened because no source was behind a login. No
screenshots exist for this run, deliberately.

## Sources

Repo files (branch `project/169903ec-contract` @ `259778b`, read 2026-08-25):
`forge-control/src/routes/projects.ts`, `forge-control/src/db/projects.ts`,
`forge-control/src/db/notifications.ts`, `forge-control/src/lib/project-tick.ts`,
`forge-control/src/lib/task-graph.ts`, `forge-control/src/lib/workspace.ts`,
`forge-control/src/lib/cc-runner.ts`, `forge-control/src/lib/gemini-runner.ts`,
`forge-control/src/lib/cli-runner.ts`, `forge-control/src/executor.ts`,
`forge-control-web/app/desktop/ProjectsSurface.tsx`,
`db/migrations/0030_coding_projects.sql`, `db/migrations/0046_task_status_cancelled.sql`,
`docs/plan/engine-task-graph/01-requirements.md` (R70 at `:755`).

Live host (2026-08-25): `/opt/ai-os/scripts/guard-autonomy.py`,
`/opt/ai-os/scripts/fleet-watchdog.sh`, `pm2 jlist`, `git -C /opt/forge-ai-os …`,
`psql "$DATABASE_URL"` read-only queries above.

Fleet memory (`/root/.claude/projects/-opt-forge-ai-os/memory/`, read 2026-08-25):
`done-never-verifies-the-declared-write-set`, `ledger-gap-is-the-finding`,
`task-cannot-fail-itself`, `paused-project-swallows-fix-chain`,
`cancelled-projects-strand-open-task-rows`, `worktree-local-main-can-equal-head`,
`db-url-recoverable-from-pm2-jlist`, `do-not-soften-check-secret-scan`,
`gates-808-is-the-repo-suite`, `assertion-inert-shared-substring`,
`verifier-asserted-on-fixture-not-invariant`, `unreachable-guard-needs-its-own-control`,
`forge-project-shared-worktree`, `workstream-forks-from-project-branch-at-dispatch`.

Public docs (WebFetch, accessed 2026-08-25):
- SLSA v1.2 Build Requirements — https://slsa.dev/spec/v1.2/build-requirements
  (Approved): "The data in the provenance MUST be obtained from the build platform …";
  "MUST have some security control to prevent tenants from tampering with the
  provenance"; secret material "MUST NOT be accessible to the environment running the
  user-defined build steps". (v1.0 page, https://slsa.dev/spec/v1.0/requirements, says the
  same and is marked Retired.)
- git-diff(1) — https://git-scm.com/docs/git-diff (last updated 2.55.0, 2026-06-29):
  `--name-only` "Show only the name of each changed file in the post-image tree";
  `<commit>..<commit>` "synonymous to the earlier form"; `A...B` "equivalent to
  `git diff $(git merge-base A B) B`".
- git-worktree(1) — https://git-scm.com/docs/git-worktree (2.54.0, 2026-04-20):
  `--detach` "detach HEAD in the new worktree"; `add <path> <commit-ish>` "sharing
  everything except per-worktree files such as HEAD, index, etc."
- PostgreSQL 18 — https://www.postgresql.org/docs/current/datatype-json.html: jsonb
  structure "typically unenforced (though enforcing some business rules declaratively is
  possible)"; https://www.postgresql.org/docs/current/ddl-constraints.html (CHECK);
  https://www.postgresql.org/docs/current/sql-altertable.html (18.6, 2026-08-13): adding a
  CHECK "requires scanning the table … but does not require a table rewrite"; `NOT VALID`.
- Center for Open Science, Preregistration — https://www.cos.io/initiatives/prereg
  (no date on page): "the same data cannot be used to generate *and* test a hypothesis".
