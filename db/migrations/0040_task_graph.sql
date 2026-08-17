-- 0040: Task graph — concurrency computed, not hand-numbered (engine-task-graph,
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

-- The sentinel lives in the database, not only in this corpus (R3): a reader at
-- a psql prompt must be able to learn what a NULL here means without finding
-- the migration that wrote it.
COMMENT ON COLUMN project_tasks.depends_on IS
  'Ids of the project_tasks rows this task waits for. NULL is a SENTINEL, not an empty list: it means "this task was never graph-scheduled, so apply the legacy round rule — promote when no strictly lower round of the same project holds a non-done task". A non-null array, INCLUDING the empty array, means "graph-scheduled: promote when exactly these ids are done". The empty array is therefore an explicit graph ROOT and promotes immediately. This is why the column deliberately carries no default value. See 02-architecture.md sections 2.2 and 9.1.';

COMMENT ON COLUMN project_tasks.workstream IS
  'Which workstream worktree this task runs in. Same workstream means the same worktree, serialized. Different workstreams are isolated directories that may write the same file and are merged back by an explicit integration task with a reviewer, never automatically. Constrained to ^[a-z0-9][a-z0-9-]{0,39}$ — the intersection of "safe in a git branch name", "safe in a directory name" and "readable in a Kanban chip". No semicolon appears in any comment body here on purpose: migrations.test.ts splits the file on semicolons, and a literal that straddles two fragments makes the lint reason about statements that do not exist.';

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
UPDATE project_tasks pt
   SET depends_on = COALESCE((
         SELECT array_agg(e.id ORDER BY e.round, e.created_at, e.id)
           FROM project_tasks e
          WHERE e.project_id = pt.project_id
            AND e.round < pt.round
       ), '{}'::uuid[])
 WHERE pt.depends_on IS NULL;
