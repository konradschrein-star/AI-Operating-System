-- 0043: Task graph — concurrency computed, not hand-numbered (engine-task-graph,
-- 2026-08-17). Three columns that turn `round` from the scheduler's input into a
-- display label, and let two tasks that write the same file run at once in
-- different workstreams.
--
--   depends_on  uuid[]  — the tasks this one waits for. THE ORDERING DEPENDENCY,
--                         and only that. Today a round conflates ordering, file
--                         contention and narrative phase; only the first is real.
--   workstream  text    — which git worktree the task runs in. Same workstream =
--                         serialized against its siblings; different workstreams =
--                         isolated directories that may write the same path and
--                         merge back through an explicit, reviewed integration
--                         task. Never an automatic merge.
--   write_set   text[]  — repo-relative POSIX paths the task intends to write.
--                         The input to contention, declared rather than
--                         archaeologically reconstructed from brief text.
--   graph_frozen bool   — TRUE on exactly the rows whose closure THIS migration
--                         computed. The provenance of `depends_on`, recorded at
--                         the moment it is true by the process that makes it
--                         true, rather than inferred afterwards. See below.
--
-- WHY THIS FILE IS 0043 AND NOT 0040 — AND WHAT WAS ACTUALLY APPLIED.
-- This file shipped as `0040_task_graph.sql` and was APPLIED TO content_forge
-- UNDER THAT NAME on 2026-08-18 (round 811's deploy, re-run at round 910 — see
-- evidence/phase8-deploy.md). Phase 8A's merge of `main` then brought in
-- `0040_usage_hourly.sql`, a second, unrelated file claiming the same number:
-- two projects numbered a migration independently and git raised no conflict,
-- because the filenames differ. Round 950 renumbered THIS file to 0042 —
-- 0041_ui_dismissals.sql was already taken — as a pure `git mv` plus reference
-- update. THE `git mv` CHANGED NO BYTES: sha256 read 5c0ad159911d10b6… both
-- immediately before and immediately after it. The SAME COMMIT then edited
-- comments — this paragraph, and the provenance sentence in the graph_frozen
-- COMMENT ON below — so the file at that commit hashes differently
-- (5a0c9d58cef400c7…) and a reader running sha256sum should expect the second
-- number, not the first. NO DDL AND NO BACKFILL STATEMENT WAS TOUCHED: the two
-- shas bracket a comment-only diff, which `check-migration-0040.sh` re-proved
-- by applying this file twice against a scratch schema (44/44 assertions,
-- second application `UPDATE 0`, snapshots byte-identical).
--
-- AND WHY IT IS NOW 0043 — THE SAME COLLISION, A SECOND TIME, ROUND 974.
-- `main` acquired `0042_daily_goals.sql` (commit 553fa38) while this lane owned
-- 0042, and round 972's merge of main brought the two together: two files
-- claiming 0042, exactly the hazard round 950 had just fixed, reintroduced with
-- no conflict for the same reason as before. Round 973's reviewer found it
-- because `forge-control/src/db/projects.test.ts` REFUSED TO RUN rather than
-- choose an order — the guard doing its job. THIS file moved again, for two
-- measured reasons: nothing named 0042 was ever applied to content_forge (this
-- one was applied as 0040, the paragraph above), whereas `0042_daily_goals.sql`
-- was applied under its own name and is `main`'s; and `main` still carries this
-- file at 0040, so the number this lane picks must be free on `main` at merge —
-- 0043 is. Pure `git mv` again: sha256 read 497fdae6cc31d672… immediately before
-- and immediately after, and the commit then edited this comment block, which
-- moves the digest a reader will compute. No DDL, no backfill, no re-application.
-- A DUPLICATE-PREFIX ASSERTION NOW LIVES IN `pnpm test`
-- (`forge-control/src/lib/migrations.test.ts`), not only in the integration test
-- that happened to catch it: the collision arrives through a MERGE, so it must
-- be caught by something that runs on every commit.
-- NOTHING was re-applied to content_forge: `depends_on`, `workstream`,
-- `write_set` and `graph_frozen` were
-- already live and stayed live across the rename, verified by querying
-- information_schema on content_forge before and after.
-- THE RULE THIS COST US, twice now: APPLY MIGRATIONS BY EXPLICIT FILENAME,
-- NEVER BY GLOB. `for f in db/migrations/*.sql` sorts `0040_task_graph.sql`
-- before `0040_usage_hourly.sql` and thereby silently decides an order nobody
-- chose. There is no ledger table and no runner in this repo, so the filename
-- an operator types IS the version control. R70.
--
-- WHY depends_on IS NULLABLE WITH NO DEFAULT, against the project brief's
-- `default '{}'`: NULL is a sentinel, not an absence. It means "this row was
-- never graph-scheduled — apply the legacy round rule". A non-null array,
-- INCLUDING the empty array, means "graph-scheduled; these and only these are my
-- predecessors". The distinction is the whole migration strategy: there is no
-- flag day, and a row's behaviour is decided by its own data.
-- The concrete reason is a deploy race. This migration is applied BEFORE the
-- executor restarts (R8/R64), and the OLD engine keeps creating rows in the gap
-- — fix chains, architect and planner curls — none of which name depends_on.
-- With DEFAULT '{}' every one of those rows is born a graph root and is promoted
-- en masse the moment the new engine loads, releasing a re-review before its fix
-- builder has run. With no default they are born legacy and keep the round
-- semantics they were created under, forever, with no timing window at all.
-- Escalation E2, ruled on by Konrad on the record: 02-architecture.md sections
-- 2.2 and 9.1 (commit 0ea9d28). R3.
--
-- WHY THE BACKFILL IS A CLOSURE and not "round N depends on round N-1": today's
-- rule is "EVERY strictly lower round is done", not "the previous one is done".
-- Rounds are also sparse (operator-visibility runs 1290..1293, 1300..), so
-- "N-1" would leave 1300's tasks with no dependencies at all. And under
-- retryTask()/unwedgeProject() a previous-round-only backfill diverges outright:
-- retry a failed task in 1290 back to ready, and a task in 1292 depending only
-- on 1291 promotes when today's engine would hold it. The closure is provably
-- exact, which is what the phase-2 replay proof needs it to be.
-- 02-architecture.md section 3.3. R6.
--
-- WHY graph_frozen IS RECORDED AND NOT INFERRED (E4 reopened, round 242).
-- `depends_on` is a FROZEN value: the backfill below writes the closure of the
-- rows that exist at the instant this file runs. Today's rule is evaluated
-- continuously against the CURRENT task set, so a row inserted afterwards at a
-- lower round is named by no closure here and a backfilled row above it can
-- promote where today's engine holds it (F13 from the old engine's side, F14
-- from the new engine's). The fix is one predicate — hold a row whose closure
-- THIS migration wrote behind ANY non-done row of a strictly lower round — and
-- the predicate needs one fact: was this closure written by the migration?
-- Round 223 built and measured all four ways to infer that fact after the event
-- (NULL sentinel; sentinel plus one settled inert row; the corpus's own
-- isClosureShaped() detector; a created_at horizon taken from the row's own
-- closure) and every one of them either goes blind exactly where sight is
-- needed or convicts ordinary fan-out of being a backfill —
-- 02-architecture.md section 9.3, evidence/phase4-workstreams.md sections 5.7
-- and 11. So the fact is RECORDED HERE, by the statement that makes it true, in
-- the same UPDATE and the same transaction as the closure it describes: a row's
-- closure and its provenance marker can never disagree, because one statement
-- writes both. DEFAULT false means every row written by any engine, old or new,
-- before or after this file runs, is correctly not-frozen and keeps exactly the
-- behaviour it had. R71.
--
-- Purely additive (R8): nothing here renames, drops, retypes, or adds a NOT NULL
-- without a default to anything that already exists, and no statement the
-- currently-running old engine executes names any new column. Safe to apply
-- while the fleet is live, exactly like 0039.
-- Re-runnable, like 14 of the 19 migrations beside it: there is no ledger table
-- and no runner, so re-application is a manual `psql -f` and must be a zero-row
-- no-op rather than an error. R1, R2.

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS depends_on uuid[];
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS workstream text NOT NULL DEFAULT 'main';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS write_set text[] NOT NULL DEFAULT '{}';
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS graph_frozen boolean NOT NULL DEFAULT false;

-- The sentinel lives in the database, not only in this corpus (R3): a reader at
-- a psql prompt must be able to learn what a NULL here means without finding
-- the migration that wrote it.
COMMENT ON COLUMN project_tasks.depends_on IS
  'Ids of the project_tasks rows this task waits for. NULL is a SENTINEL, not an empty list: it means "this task was never graph-scheduled, so apply the legacy round rule — promote when no strictly lower round of the same project holds a non-done task". A non-null array, INCLUDING the empty array, means "graph-scheduled: promote when exactly these ids are done". The empty array is therefore an explicit graph ROOT and promotes immediately. This is why the column deliberately carries no default value. See 02-architecture.md sections 2.2 and 9.1.';

COMMENT ON COLUMN project_tasks.workstream IS
  'Which workstream worktree this task runs in. Same workstream means the same worktree, serialized. Different workstreams are isolated directories that may write the same file and are merged back by an explicit integration task with a reviewer, never automatically. Constrained to ^[a-z0-9][a-z0-9-]{0,39}$ — the intersection of "safe in a git branch name", "safe in a directory name" and "readable in a Kanban chip". No semicolon appears in any comment body here on purpose: migrations.test.ts splits the file on semicolons, and a literal that straddles two fragments makes the lint reason about statements that do not exist.';

COMMENT ON COLUMN project_tasks.graph_frozen IS
  'TRUE on exactly the rows whose depends_on closure was written by the backfill of db/migrations/0043_task_graph.sql (applied to this database under its original name 0040_task_graph.sql, before round 950 renumbered it to 0042 off a collision with 0040_usage_hourly.sql and round 974 renumbered it to 0043 off a collision with 0042_daily_goals.sql, with the file bytes otherwise unchanged), FALSE on every row any engine wrote itself. It is the PROVENANCE of depends_on, recorded by the statement that makes it true rather than inferred afterwards. The scheduler uses it for one thing: a frozen row is held behind ANY non-done row of the same project in a strictly lower round, because its closure was computed against a snapshot and cannot name a row inserted later, while a non-frozen row is held only by the ids it actually declares. Four ways of inferring this fact after the event were built and measured in round 223 and all four failed — see 02-architecture.md section 9.3. Never written outside that backfill. R71, E4.';

COMMENT ON COLUMN project_tasks.write_set IS
  'Repo-relative POSIX paths this task intends to write, declared by its planner. The input to computed contention: within one workstream the scheduler will not claim a task whose write_set intersects that of a running sibling. An empty array intersects nothing and is always claimable, which is exactly today behaviour and is what keeps the replay proof exact.';

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the guard is a DO block that
-- tests pg_constraint first (02-architecture.md section 2.1). Scoped by conrelid
-- as well as conname: constraint names are unique per table, not per schema.
-- The regex is LOAD-BEARING — phase 3 validateWorkstream() must match it
-- character for character (R4).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_tasks_workstream_chk'
       AND conrelid = 'project_tasks'::regclass
  ) THEN
    ALTER TABLE project_tasks
      ADD CONSTRAINT project_tasks_workstream_chk
      CHECK (workstream ~ '^[a-z0-9][a-z0-9-]{0,39}$');
  END IF;
END $$;

-- Containment lookups over depends_on ("which tasks name this id?") — GIN is the
-- index type for array operators. R7.
CREATE INDEX IF NOT EXISTS project_tasks_depends_on_gin
  ON project_tasks USING gin (depends_on);
-- The claim path filters by project, then workstream, then status. R7.
CREATE INDEX IF NOT EXISTS project_tasks_workstream_idx
  ON project_tasks (project_id, workstream, status);

-- Backfill: every pre-existing row becomes an EXACT replica of today's rule, so
-- the graph starts as a re-encoding of current behaviour rather than a change to
-- it. Full transitive closure — every task of the SAME project in a strictly
-- lower round (R6). The ORDER BY inside array_agg is not decoration: it makes
-- two applications byte-comparable. The WHERE guard makes the second
-- application a zero-row no-op (R2), and also means a graph-scheduled row that
-- already carries '{}' is never overwritten with its round's closure.
--
-- graph_frozen IS SET BY THIS STATEMENT AND BY NO OTHER (R71). Same UPDATE,
-- same WHERE, same transaction as the closure it describes: there is no
-- interleaving in which a row carries a backfilled closure and a false marker,
-- or the reverse. A second application changes zero rows, so it neither writes
-- a closure nor marks one. Every row this statement does not touch keeps the
-- column default, false, which is the correct answer for it.
UPDATE project_tasks pt
   SET depends_on = COALESCE((
         SELECT array_agg(e.id ORDER BY e.round, e.created_at, e.id)
           FROM project_tasks e
          WHERE e.project_id = pt.project_id
            AND e.round < pt.round
       ), '{}'::uuid[]),
       graph_frozen = true
 WHERE pt.depends_on IS NULL;
