# P6 fix cycle 1 — resolving the five R603 review findings

Round 603, branch `project/4120f785`. The P6 deploy itself passed every
structural check; what failed the gate was the **arming of R20** — the
researcher smoke could have reported success while proving nothing. Four of
the five findings are about that payload; the fifth is migration hygiene.

Nothing in this cycle touches the live checkout. `git -C /opt/forge-ai-os
status --porcelain` is empty before and after, `forge-executor` stayed on pid
744650 throughout, and the detached `safe-restart.sh` launched by P6 is still
in its wait loop (pid 1617631) — which is precisely why findings 1, 2 and 4
were still fixable: the chained `curl ... --data @/tmp/p6-r20-smoke.json`
reads that file at POST time, not at launch time.

---

## Finding 1 — nobody was authorised to create the round-2 reviewer

**The defect.** The brief told the architect to *"create EXACTLY ONE task —
round 1, role 'researcher' … Then STOP"*, while the reviewer was specified in
a block addressed to a task that did not yet exist. The researcher cannot
create it either: `project-tick.ts:434-441` appends *"Deep research only — no
implementation, no task creation"*. So the sequence would have been: architect
creates one task → researcher settles → `closeFinishedProjects()` flips the
project to `done`, because its only guard is that no task has
`status <> 'done'`:

```sql
-- db/projects.ts, closeFinishedProjects()
AND NOT EXISTS (
  SELECT 1 FROM project_tasks
   WHERE project_id = p.id AND status <> 'done'
)
```

Konrad's reminder would then have found a green `done` project with zero
verification, indistinguishable from a real pass.

**The fix.** Round-0 now reads *"create EXACTLY TWO tasks — and nothing
else"*, naming Task A (round 1, `researcher`, `junior`) and Task B (round 2,
`reviewer`, `standard`), with both briefs quoted verbatim in the payload for
the architect to paste. The brief states *why* the architect cannot defer:
a researcher is forbidden from creating tasks. A pending round-2 reviewer is
exactly what holds `closeFinishedProjects()` off until a verdict exists.

## Finding 2 — the research filename fought the engine

**The defect.** The payload demanded `docs/research/perplexity-api-smoke.md`.
The engine appends, *after* the brief in the same prompt, its own instruction
(`project-tick.ts:437-439`):

```ts
`findings to docs/research/round-${task.round}-${task.id.slice(0, 8)}.md in the worktree and commit that ` +
```

Trailing text wins. The researcher would have written `round-1-<id8>.md`,
and both the smoke's reviewer clause and Konrad's reminder — keyed on
`perplexity-api-smoke.md` — would have reported a false failure.

**The fix.** The researcher clause now says *"commit your findings to the
`docs/research/*.md` file the engine names for you … do not invent a different
filename"*. The reviewer clause opens with `ls -la docs/research/` and
`git log --oneline -3`, and states explicitly *"do NOT assume any particular
filename"*; an empty `docs/research/` is itself NEEDS_FIXES. The reminder was
re-issued with the same glob semantics (see finding 3).

## Finding 3 — the timeout branch had no watcher

**The defect.** Reminder `7c9fc079` was due T+2h (19:26 local). `safe-restart.sh`
can wait until T+12h (05:26 tomorrow) before logging *"gave up … NOT
restarting"* and `exit 2`; because the R20 POST is chained with `&&`, exit 2
means the smoke never runs — and nothing was scheduled after T+2h to notice.

**The fix.** The live `&&` chain cannot be rewritten without killing a process
that is mid-wait, so the coverage is added on the reminder side, which is the
alternative the review itself named. The reminders API exposes only create and
dismiss (`routes/reminders.ts`), so the correction is a replace:

| Reminder | Due | Role |
|---|---|---|
| `4b20dd16` | 2026-08-05 17:26Z (19:26 local) | check #1, replaces `7c9fc079`, filename check corrected to a glob |
| `a3c10b77` | 2026-08-06 04:00Z (06:00 local) | check #2 — the watcher, fires *after* the 05:26 give-up point |
| `7c9fc079` | — | dismissed, superseded |

Check #2 carries the re-arm command and points at the committed copy of the
payload in case `/tmp` was cleared. Order of operations was deliberate: both
replacements were created and confirmed `pending` before the stale one was
dismissed.

## Finding 4 — `<this-project-id>` was unresolvable

**The defect.** The reviewer prompt header (`project-tick.ts:363-368`) carries
name, repo, branch and brief — not the project UUID. `taskCurl(project.id)`,
which embeds it, is injected only at lines 385 and 408 (architect) and 420
(planner). The reviewer branch at line 451 has none, so
`POST /api/projects/<this-project-id>/status` was unexecutable as written.

**The fix.** The payload uses the token `PROJECT_ID` and instructs the
architect — which *does* receive the id, in its own curl example — to
substitute it before pasting the reviewer brief.

## Finding 5 — migration 0039 was not re-runnable

`ADD COLUMN` and `CREATE UNIQUE INDEX` now carry `IF NOT EXISTS`, matching the
convention of the sibling migrations. After this change **no** migration in
`db/migrations/` has an unguarded `ADD COLUMN` / `CREATE [UNIQUE] INDEX` /
`CREATE TABLE`.

Proven twice. First, against the live database — the fixed file applied to
`content_forge`, where the objects already exist:

```
NOTICE:  column "chain_key" of relation "project_tasks" already exists, skipping
ALTER TABLE
NOTICE:  relation "project_tasks_chain_key_uniq" already exists, skipping
CREATE INDEX
```

Second, from scratch in a stub schema inside a rolled-back transaction, so the
real table was never involved:

```
BEGIN / CREATE SCHEMA mig39_probe / SET LOCAL search_path / CREATE TABLE project_tasks
--- application 1 ---            ALTER TABLE / CREATE INDEX
--- application 2 (no-op) ---    NOTICE: ... already exists, skipping (×2)
 chain_key | text
 CREATE UNIQUE INDEX project_tasks_chain_key_uniq ON mig39_probe.project_tasks
   USING btree (project_id, chain_key) WHERE (chain_key IS NOT NULL)
ROLLBACK                          psql exit=0
```

Live state afterwards: one `project_tasks_chain_key_uniq` index on
`public.project_tasks`, 173 rows, 0 non-null `chain_key` (the deployed
executor is still on pre-merge code and never writes the column, as the P6
review established). `mig39_probe` does not exist.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (forge-control) | exit 0 |
| `pnpm test` | **tests 201, pass 201, fail 0** (was 167 — 34 new) |
| Mutation check: revert all five fixes, re-run | **12 test failures**, one per guarded property |
| `git -C /opt/forge-ai-os status --porcelain` | empty |
| `forge-executor` | pid 744650, untouched |
| Detached P6 chain | pid 1617631, still waiting — will read the corrected payload |
| Repo payload vs `/tmp/p6-r20-smoke.json` | byte-identical (`diff` clean) |

The mutation check matters more than the pass count: each new test was run
against the exact pre-fix text it is meant to reject, and each one failed.
A guard that cannot fail is not a guard.

### New tests

- `src/lib/migrations.test.ts` — lints every `db/migrations/*.sql` for guarded
  DDL, plus a named 0039 case asserting both statements *and* the partial
  `WHERE chain_key IS NOT NULL` predicate, whose loss would turn a hygiene fix
  into a migration that cannot apply at all.
- `src/lib/r20-smoke-arming.test.ts` — asserts the arming contract of the
  committed payload, each assertion cross-checked against the engine fact that
  makes the finding real: the researcher branch's own filename, the reviewer
  branch's *lack* of `taskCurl(project.id)`, the architect branch's possession
  of it, and the `closeFinishedProjects()` predicate. When the engine moves,
  these go stale loudly rather than leaving the smoke quietly mis-armed.

The payload now lives at `docs/plan/evidence/p6-r20-smoke.json` and is copied
to `/tmp`; `/tmp` is no longer the source of truth for a document the gate
depends on.

## Left for a later cycle

The root cause behind finding 2 is an engine footgun, not a payload bug:
`buildPrompt()` appends a hardcoded output filename *after* the brief, so any
brief that names its own path silently loses. Softening that to "unless your
brief names one" is a change to deployed engine behaviour, and it would not
reach the running executor before R20 fires — so it is deliberately **not**
in this cycle. Filed here rather than fixed quietly.
