# Evidence — migration 0035 dry run (quality gate I2)

Phase 1, round 101 (DB layer). Migration `db/migrations/0035_reviewer_chain_key.sql` was
applied **only** to a throwaway database `forge_p1_dryrun`, created and dropped inside this
run. The live `content_forge` database was touched **read-only** (`pg_dump -s`, one
`information_schema` SELECT) and does **not** have the `chain_key` column — proven in S9
below. Applying 0035 to live is Phase 6's job.

Reproduce with `SCRATCH_PW=… bash /tmp/dryrun-all.sh` from `forge-control/`; the script and
its two SQL fixtures are throwaway (`/tmp`), deliberately not committed — the transcript is
the artifact.

## What this proves

| # | Claim | Where |
|---|---|---|
| S4 | `chain_key text` NULLable, and `project_tasks_chain_key_uniq UNIQUE btree (project_id, chain_key) WHERE chain_key IS NOT NULL` exists | `\d project_tasks` |
| T1 | Two rows with the same `(project_id, chain_key)` → **unique violation**. The idempotency key is real, not decorative. | S5 |
| T2 | Two rows with `chain_key IS NULL` in the same project → **both succeed**. This is why the first goal-mode night's duplicate fix/deploy rows survive the migration untouched. | S5 |
| T3 | The same `chain_key` under a different project → succeeds. Uniqueness is scoped per project, as designed. | S5 |
| T4 | `ON CONFLICT (project_id, chain_key) WHERE chain_key IS NOT NULL DO NOTHING RETURNING id` on an existing key → `INSERT 0 0`, empty `RETURNING`. This is the exact form `createFixChain()` uses, and it is what makes a replayed tick a no-op. | S5 |
| T5 | Same statement with a fresh key → inserts, `RETURNING` yields the id. `rowCount > 0` is therefore a sound "I created this" signal. | S5 |
| T6 | The `ON CONFLICT ON CONSTRAINT project_tasks_chain_key_uniq` fallback the brief offered **cannot** be used: a partial unique *index* is not a *constraint*, and Postgres rejects it outright. Index inference is the only viable conflict target. Recorded in a comment on `createFixChain()` so nobody "simplifies" it back. | S5 |
| E1–E3 | The changed/new SQL parses and plans index-driven: gated `promoteReadyTasks()` UPDATE, gated `claimReadyTasks()` SELECT, and `listReviewerRound()`. E2's plan shows `LockRows` over the `pt` scan only — `FOR UPDATE OF pt` does not lock the joined `projects` row. | S6 |
| F1 | `createFixChain()` called twice with identical input → `{builderCreated: true, reviewerCreated: true}` then `{false, false}`, and exactly **2** chain rows exist. Builder lands at round+1 with the tier, re-reviewer at round+2 with `tier=null`. R7 satisfied. | S7 |
| F2 | `listReviewerRound()` returns both reviewers of the round with `run_status: null` (no run yet → caller maps to `settled: false`), and excludes the same-round builder. | S7 |
| F3 | With a paused project B and an active project C both holding a pending round-0 task: `promoteReadyTasks()` promotes **1**, `claimReadyTasks()` claims **1**, and both are C's. B's task is still `pending`. R8/R9 satisfied. | S7 |
| F4 | Flipping B back to `active` promotes and claims exactly that same task — the round resumes where it stopped rather than being skipped. | S7 |

Note on S1: the brief's `pg_dump -s -t project_tasks` is included and works, but loading it
alone into an empty database fails — `project_tasks` has FKs to `projects` and `runs`. The
full schema-only dump is loaded instead, which is a superset and a faithful replica of live.

## Full transcript

```
### S1: schema-only dump of the LIVE table definition (read-only against content_forge)
$ pg_dump -U postgres -s -t project_tasks content_forge > /tmp/pt.sql
  ok, 100 lines
$ pg_dump -U postgres -s content_forge > /tmp/full_schema.sql   # full DDL: project_tasks' FKs need projects+runs
  ok, 7592 lines

### S2: create the scratch DB and load that schema
$ createdb -U postgres forge_p1_dryrun
  ok
  schema loaded

### S3: apply migration 0035
ALTER TABLE
CREATE INDEX

### S4: \d project_tasks
                                Table "public.project_tasks"
   Column   |           Type           | Collation | Nullable |           Default            
------------+--------------------------+-----------+----------+------------------------------
 id         | uuid                     |           | not null | gen_random_uuid()
 project_id | uuid                     |           | not null | 
 round      | integer                  |           | not null | 0
 role       | character varying(16)    |           | not null | 
 title      | text                     |           | not null | 
 brief      | text                     |           | not null | 
 status     | character varying(16)    |           | not null | 'pending'::character varying
 run_id     | uuid                     |           |          | 
 fix_cycle  | integer                  |           | not null | 0
 created_at | timestamp with time zone |           | not null | now()
 updated_at | timestamp with time zone |           | not null | now()
 tier       | character varying(16)    |           |          | 
 chain_key  | text                     |           |          | 
Indexes:
    "project_tasks_pkey" PRIMARY KEY, btree (id)
    "project_tasks_chain_key_uniq" UNIQUE, btree (project_id, chain_key) WHERE chain_key IS NOT NULL
    "project_tasks_pending_idx" btree (project_id) WHERE status::text = ANY (ARRAY['pending'::character varying::text, 'ready'::character varying::text])
    "project_tasks_project_idx" btree (project_id, round, status)
    "project_tasks_run_idx" btree (run_id) WHERE run_id IS NOT NULL
Check constraints:
    "project_tasks_role_check" CHECK (role::text = ANY (ARRAY['architect'::character varying::text, 'planner'::character varying::text, 'scout'::character varying::text, 'researcher'::character varying::text, 'builder'::character varying::text, 'reviewer'::character varying::text]))
    "project_tasks_status_check" CHECK (status::text = ANY (ARRAY['pending'::character varying::text, 'ready'::character varying::text, 'running'::character varying::text, 'done'::character varying::text, 'failed'::character varying::text, 'blocked'::character varying::text]))
    "project_tasks_tier_check" CHECK (tier IS NULL OR (tier::text = ANY (ARRAY['fast'::character varying::text, 'junior'::character varying::text, 'standard'::character varying::text, 'flagship'::character varying::text])))
Foreign-key constraints:
    "project_tasks_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    "project_tasks_run_id_fkey" FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL


### S5: the index enforces exactly what we claim
INSERT 0 2
--- T1: two rows, SAME (project_id, chain_key) — the second MUST fail
INSERT 0 1
psql:/tmp/index-proof.sql:9: ERROR:  duplicate key value violates unique constraint "project_tasks_chain_key_uniq"
DETAIL:  Key (project_id, chain_key)=(11111111-1111-1111-1111-111111111111, fix:1:1) already exists.
--- T2: two rows, chain_key NULL, same project — BOTH must succeed (partial index skips NULLs,
        which is what lets the first goal-mode night's duplicate rows survive the migration)
INSERT 0 1
INSERT 0 1
--- T3: the SAME chain_key under a DIFFERENT project — must succeed (uniqueness is per project)
INSERT 0 1
--- T4: the ON CONFLICT form createFixChain() uses — replay inserts nothing, RETURNING is empty
 id 
----
(0 rows)

INSERT 0 0
--- T5: same statement, FRESH chain_key — inserts, RETURNING yields the id
                  id                  
--------------------------------------
 48107c19-1467-4d30-9f09-fcdc3a4358b1
(1 row)

INSERT 0 1
--- T6: the ON CONSTRAINT fallback the brief offered — MUST fail: a partial unique INDEX
        is not a constraint, so index inference is the only usable conflict target
psql:/tmp/index-proof.sql:39: ERROR:  constraint "project_tasks_chain_key_uniq" for table "project_tasks" does not exist
--- cleanup: drop the index-proof fixtures so S7 starts from an empty board
DELETE 2

### S6: the query plans of the changed/new SQL (EXPLAIN — plans, executes nothing)
=== E1: promoteReadyTasks() — status-gated UPDATE (EXPLAIN only, nothing is written) ===
                                                     QUERY PLAN                                                      
---------------------------------------------------------------------------------------------------------------------
 Update on project_tasks pt  (cost=0.43..29.38 rows=1 width=76)
   ->  Nested Loop Anti Join  (cost=0.43..29.38 rows=1 width=76)
         ->  Nested Loop  (cost=0.29..16.34 rows=1 width=32)
               ->  Index Scan using projects_status_idx on projects p  (cost=0.14..8.16 rows=1 width=22)
                     Index Cond: ((status)::text = 'active'::text)
               ->  Index Scan using project_tasks_project_idx on project_tasks pt  (cost=0.14..8.16 rows=1 width=26)
                     Index Cond: ((project_id = p.id) AND ((status)::text = 'pending'::text))
         ->  Index Scan using project_tasks_project_idx on project_tasks earlier  (cost=0.14..8.17 rows=1 width=26)
               Index Cond: ((project_id = pt.project_id) AND (round < pt.round))
               Filter: ((status)::text <> 'done'::text)
(10 rows)

=== E2: claimReadyTasks() — JOIN gate + FOR UPDATE OF pt SKIP LOCKED ===
                                                         QUERY PLAN                                                         
----------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=16.37..16.39 rows=1 width=434)
   ->  LockRows  (cost=16.37..16.39 rows=1 width=434)
         ->  Sort  (cost=16.37..16.38 rows=1 width=434)
               Sort Key: pt.round, pt.created_at
               ->  Nested Loop  (cost=0.29..16.36 rows=1 width=434)
                     ->  Index Scan using projects_status_idx on projects p  (cost=0.14..8.16 rows=1 width=22)
                           Index Cond: ((status)::text = 'active'::text)
                     ->  Index Scan using project_tasks_project_idx on project_tasks pt  (cost=0.14..8.16 rows=1 width=324)
                           Index Cond: ((project_id = p.id) AND ((status)::text = 'ready'::text))
                           Filter: (run_id IS NULL)
(10 rows)

=== E3: listReviewerRound() ===
                                                   QUERY PLAN                                                   
----------------------------------------------------------------------------------------------------------------
 Sort  (cost=18.01..18.02 rows=1 width=504)
   Sort Key: pt.created_at
   ->  Nested Loop Left Join  (cost=0.29..18.00 rows=1 width=504)
         ->  Index Scan using project_tasks_project_idx on project_tasks pt  (cost=0.14..8.17 rows=1 width=318)
               Index Cond: ((project_id = '11111111-1111-1111-1111-111111111111'::uuid) AND (round = 3))
               Filter: ((role)::text = 'reviewer'::text)
         ->  Index Scan using runs_pkey on runs r  (cost=0.14..8.16 rows=1 width=98)
               Index Cond: (id = pt.run_id)
         SubPlan 1
           ->  Limit  (cost=1.52..1.53 rows=1 width=40)
                 ->  Sort  (cost=1.52..1.53 rows=1 width=40)
                       Sort Key: (((elem.value ->> 'ts'::text))::timestamp with time zone) DESC
                       ->  Function Scan on jsonb_array_elements elem  (cost=0.00..1.51 rows=1 width=40)
                             Filter: ((value ->> 'role'::text) = 'assistant'::text)
(14 rows)


### S7: the real db/projects.ts functions, run against the scratch DB
### F1: createFixChain() is idempotent (R7)
  project A = cf0dc61c-76d1-4d59-a9ba-3d001c7e0780 status=active
  call #1          -> { builderCreated: true, reviewerCreated: true }
  call #2 (replay) -> { builderCreated: false, reviewerCreated: false }
  chain rows in DB: 2 (must be 2 — one builder, one re-reviewer)
    round=5 role=builder fix_cycle=1 tier=junior chain_key=fix:4:1
    round=6 role=reviewer fix_cycle=1 tier=null chain_key=rereview:4:1

### F2: listReviewerRound() — group view, run-less reviewer surfaces as run_status null
    title=Review A role=reviewer run_status=null last_text=null
    title=Review B role=reviewer run_status=null last_text=null
  (the round-9 builder is correctly absent)

### F3: status gating (R8/R9) — project B paused, project C active
  B=2731905e-1ead-49e3-a6ec-a07af672fff7 paused | C=304b3042-3f62-48ac-a99e-061ac442e744 active
  B before:
    [pending] round=0 architect "Plan: dryrun-B-paused" chain_key=null
  C before:
    [pending] round=0 architect "Plan: dryrun-C-active" chain_key=null
  promoteReadyTasks() -> 1 promoted
  claimReadyTasks()   -> 1 claimed: ["dryrun-C-active/Plan: dryrun-C-active"]
  B after  (must still be pending — paused):
    [pending] round=0 architect "Plan: dryrun-B-paused" chain_key=null
  C after  (must be running — active):
    [running] round=0 architect "Plan: dryrun-C-active" chain_key=null

### F4: B flips back to 'active' — the round resumes where it stopped
  promoteReadyTasks() -> 1 promoted
  claimReadyTasks()   -> 1 claimed: ["dryrun-B-paused/Plan: dryrun-B-paused"]
  B after resume:
    [running] round=0 architect "Plan: dryrun-B-paused" chain_key=null

### S8: tear the scratch DB down
$ dropdb -U postgres forge_p1_dryrun
  ok

### S9: content_forge untouched — 0035 is NOT applied to live in this phase
$ psql -U postgres -d content_forge -c "select column_name from information_schema.columns where table_name='project_tasks' and column_name='chain_key'"
 column_name 
-------------
(0 rows)

```
