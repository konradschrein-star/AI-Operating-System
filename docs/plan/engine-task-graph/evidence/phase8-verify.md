# Phase 8G — live verification after the restart (round 815)

Task `b7f5bc24-789d-4f09-a97f-c4501f37c9b4`, run `0b560da5-71e3-4ada-ac0e-188ef79b9d82`,
seeded by the detached watcher `scripts/deploy/await-and-seed.sh executor-restart`
at `2026-08-18T06:34:35Z` — i.e. **after** `forge-executor` restarted, so the engine
under test is the new one. Verification window opened `2026-08-18T06:35Z`.

This is the one task in the project with live authority (`03-quality.md` §2.3, R67).
Everything below was run against the live checkout `/opt/forge-ai-os`, the live
`content_forge` database, the live API on `127.0.0.1:7700` and the live pm2 fleet.
**R66 was not violated: `pm2 restart forge-executor` was never run by this task.**

## 0. Verdict, up front

| # | Item | Result |
|---|---|---|
| 1 | The restart landed | **PASS** — `online`, `restart_time` 1→2, `pm_uptime` 06:34:28Z. One finding: the two logs, and a two-instance race. |
| 2 | Live checkout clean | **PASS** — porcelain empty. One finding: HEAD names the round-**910** deploy, not the "round-811" deploy the brief predicted. |
| 3 | Schema on the live DB | **PASS on the schema.** The R71 consistency pair is **NOT 0 and cannot be** — the gate is arithmetically unsatisfiable from the first post-migration graph row onward. Diagnosed, gate amended where enforced (standing rule 2). **Not a data defect.** |
| 4 | Migrations that rode along | **PASS** — all three tables exist, both routes 200. One finding: the brief's `\dt` command silently ignores its 2nd and 3rd arguments. |
| 5 | R14 in the deployed tree | **PASS** — `dependencies_corrupt` is present in the deployed tree and `force` does not open it. The watchdog does **not** need disabling. |
| 6 | The cycle 400, honestly | **PASS** — both reachable 400s observed, each naming the offending id. No cycle was claimed. |
| 7 | DoD-1 / DoD-2 live observations | see §7 — **recorded at the end of this run**; if open, handed to round 817 by name. |
| 8 | DoD-6 project created + watcher launched | **DONE** — project `b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`, watcher pid alive. One finding: the brief's `POST /api/projects` body is **wrong against the deployed route** and 400s. |

---

## 1. The restart landed

### 1.1 pm2 — the three fields

```text
$ date -u +%Y-%m-%dT%H:%M:%SZ
2026-08-18T06:39:52Z
$ pm2 jlist | python3 -c "...forge-executor status/restart_time/pm_uptime..."
name        : forge-executor
status      : online
restart_time: 2
pm_uptime   : 1787034868815 = 2026-08-18T06:34:28.815000Z
pm_id       : 17  pid: 2116495
```

`status: online`. `restart_time: 2` — the watcher recorded the baseline as `1` and
fired on the increment (transcript in §1.4). `pm_uptime` `2026-08-18T06:34:28.815Z`
is later than the round-910 deploy task's own finish (its last log line is the
detached launch at `2026-08-18T06:12:38Z` = `08:12:38+02:00`).

### 1.2 `/var/log/forge-safe-restart.log`

```text
$ grep -nE "waiting for idle to restart|idle confirmed|restarted forge-executor|ERROR:" /var/log/forge-safe-restart.log | tail -12
318:[2026-08-06T05:28:33+02:00] restarted forge-executor — status=online
319:[2026-08-06T05:28:35+02:00] idle confirmed — restarting forge-executor
351:[2026-08-06T05:28:41+02:00] restarted forge-executor — status=online
352:[2026-08-17T00:42:56+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
353:[2026-08-17T12:32:18+02:00] idle confirmed — restarting forge-executor
389:[2026-08-17T12:32:24+02:00] restarted forge-executor — status=online
390:[2026-08-18T07:18:13+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
391:[2026-08-18T08:12:38+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
392:[2026-08-18T08:34:26+02:00] idle confirmed — restarting forge-executor
394:[2026-08-18T08:34:27+02:00] idle confirmed — restarting forge-executor
397:[2026-08-18T08:34:27+02:00] ERROR: pm2 restart forge-executor failed
432:[2026-08-18T08:34:32+02:00] restarted forge-executor — status=online
```

(The log stamps local time, `+02:00`; `08:34:32+02:00` = `06:34:32Z`, matching
`pm_uptime` above to the second.)

Both required lines are present: the idle wait at `07:18:13+02:00`, and
`restarted forge-executor — status=online` at `08:34:32+02:00`.

### FINDING 1A (MEDIUM) — two safe-restart instances raced; one logged a false ERROR

Line 390 is the watcher launched by the **round-820** deploy (phase 8F, commit
`6fcb5f3`); line 391 is the one launched by the **round-910** deploy (`480570ec`'s
report). Both were still waiting when the fleet went quiet, so **both** logged
`idle confirmed` one second apart (392, 394) and both called `pm2 restart`. One
won; the loser got `[PM2][ERROR] Process 17 not found` mid-restart and logged
`ERROR: pm2 restart forge-executor failed` (397). `restart_time` moved 1→2, so
exactly **one** restart actually occurred and the fleet is fine.

Why it still matters: `safe-restart.sh` takes no lock. Two instances that confirm
idle in the same second can each restart the service — the second one landing
**while the first restart's new process is booting**, which is precisely the
"restart under a live run" the script exists to prevent. It was harmless here only
because the second `pm2 restart` lost a race against pm2's own process table. The
fix (not made by this task — it is not in my write-set and touches deploy tooling
mid-phase) is an `flock` on a fixed path around the confirm-and-restart section of
`safe-restart.sh`, plus not treating an `ERROR:` line as authoritative when
`restart_time` shows the restart happened.

### 1.3 `/tmp/safe-restart.log` — the second log the brief asks for does not exist

```text
$ ls -la /tmp/safe-restart.log; wc -l /tmp/safe-restart.log
-rw-r--r-- 1 root root 7847 Aug  5 19:19 /tmp/safe-restart.log
0 /tmp/safe-restart.log
$ grep -cE "waiting for idle|idle confirmed|restarted forge-executor" /tmp/safe-restart.log
0
$ head -c 200 /tmp/safe-restart.log
{"project":{"id":"899f96f3-6570-4f98-8978-f7960080f019","name":"p6-r20-researcher-smoke","brief":"R20 SMOKE — end-to-end proof that the researcher role resolves and runs. Keep this project TINY; it
```

### FINDING 1B (LOW, documentation) — the two logs do not disagree; only one of them is ever written

The brief says "safe-restart.sh writes its own to /var/log and the detached launch
redirects stdout to /tmp; if they disagree, say so." They cannot disagree: **every
line `safe-restart.sh` emits goes to `$LOG`**, and it never writes stdout.

```text
$ grep -n '^LOG=\|>>"$LOG"' /opt/ai-os/scripts/safe-restart.sh | head -5
33:LOG=/var/log/forge-safe-restart.log
43:log() { echo "[$(date -Is)] $*" >>"$LOG"; }
70:           pm2 restart "$ECOSYSTEM" --only "$SVC" --update-env >>"$LOG" 2>&1; } ||
71:       { [ -z "$ECOSYSTEM" ] && pm2 restart "$SVC" --update-env >>"$LOG" 2>&1; }; then
```

`log()` and both `pm2 restart` invocations append to `$LOG`; the `>> /tmp/safe-restart.log`
in the detached launch therefore receives nothing. The file at that path is an
unrelated 2026-08-05 artefact (a `POST /api/projects` response body, no trailing
newline — hence 7847 bytes and `wc -l` = 0), and its mtime is **Aug 5**, thirteen
days before this deploy. Reported rather than reinterpreted, per standing rule 1:
the pin exists, it just does not resolve to what the brief expected.

*Instruments-lie check (standing rule 3):* what would have made this report a pass
wrongly? Reading the /var/log file and calling it "both logs". I did not — I
`ls`'d and `wc`'d the /tmp path, showed its content is from another month, and
showed in the script itself why it is empty.

### 1.4 The watcher's own record of the increment

```text
[2026-08-18T08:34:05+02:00] await-and-seed: poll: restart_time=1 has not passed the baseline 1 (status=online) — not firing
[2026-08-18T08:34:35+02:00] await-and-seed: FIRE: forge-executor restarted — restart_time 1 -> 2, status=online, pm_uptime=1787034868815 (launch 1787030293000)
[2026-08-18T08:34:35+02:00] await-and-seed: POST http://127.0.0.1:7700/api/projects/8c591d6c-.../status {"status":"active"}
[2026-08-18T08:34:35+02:00] await-and-seed:   reactivated: HTTP 200
[2026-08-18T08:34:35+02:00] await-and-seed:   SEEDED: HTTP 201 — {"task":{"id":"b7f5bc24-789d-4f09-a97f-c4501f37c9b4",...,"round":815,...}}
[2026-08-18T08:34:35+02:00] await-and-seed: done — exit 0
```

---

## 2. The live checkout is clean

```text
$ git -C /opt/forge-ai-os status --porcelain
(exit 0; no output above = clean)
$ git -C /opt/forge-ai-os log --oneline -4
9b960ef fix(engine-task-graph/round-902, fix cycle 1): the screenshot convention states what the renderer actually does
7464f4c feat(engine-task-graph/round-900): screenshot convention reaches every browser-driving role, F-E verified, GRAPH_GUIDE gets round 244's follow-up
6fcb5f3 deploy(engine-task-graph/round-820, phase 8F): steps 3-6 executed back to back, in execution order with timestamps
b8a5116 fix(engine-task-graph/round-820, phase 8F): the after-measurement's convention, pinned where the gate is enforced
$ git -C /opt/forge-ai-os rev-parse HEAD; git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
9b960ef51e690bba061a42e7110640cbfb6dea05
main
```

**Porcelain is EMPTY** — no finding under `03-quality.md` §3.1 item 3.

### FINDING 2A (LOW, stale pin — reported, not reinterpreted) — HEAD names the round-910 deploy

The brief says HEAD "must name the merge landed by the **round-811** deploy task".
It does not, and no commit in this repo does. What actually happened, from the
commit graph and the manager chat:

- the phase-8F deploy was **round 820**, not 811 (`6fcb5f3`, fast-forward
  `4f6cd31..b8a5116`);
- a **second** deploy, **round 910**, then fast-forwarded `b8a5116..9b960ef`
  (11 files, no migration, no lockfile change) — that is today's HEAD.

Both deploys are accounted for and both are this project's. The brief's "round 811"
is a planning-time round number that the phase re-numbered when it was re-planned;
per standing rule 1 I report the unresolvable pin rather than quietly re-reading it
as "some deploy". **Round 817 should cite `9b960ef` (round 910) as the deployed
tree, not "the round-811 merge".**

---

## 3. The schema on the live database

### 3.0 Which postgres is "the live database" — the brief's command reaches the wrong one

```text
$ psql -U postgres -d content_forge -c "\d project_tasks"   # the brief command, verbatim
psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5434" failed: FATAL:  Peer authentication failed for user "postgres"
$ grep -n '^PSQL=' /opt/ai-os/scripts/safe-restart.sh
41:PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -tAc)
$ psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -c "select current_database(), inet_server_addr(), inet_server_port(), version();"
 current_database | inet_server_addr | inet_server_port |                                         version
------------------+------------------+------------------+------------------------------------------------------------------------------------------
 content_forge    | 172.17.0.4       |             5432 | PostgreSQL 16.13 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
(1 row)
```

### FINDING 3A (MEDIUM) — `psql -U postgres -d content_forge` does not reach the live database

The host has a **local** PostgreSQL 16 cluster on port **5434** (`pg_lsclusters`:
`16 main 5434 online`), and that is what a bare `psql` hits — it refuses on peer
auth here, but on a host where peer auth succeeded it would answer questions about
a *different, empty* database and every check below would silently describe the
wrong server. The live database is the **containerised** PG 16.13 reachable at
`127.0.0.1:5432` (`inet_server_addr 172.17.0.4`, an Alpine build — not the Debian
cluster), which is what `DATABASE_URL` names and what `safe-restart.sh` itself
uses. Every query in this document was run with `-h 127.0.0.1 -p 5432`, and the
identity query above is pasted so the reader can see which server answered.
Credentials came from this run's environment (`PGPASSWORD`); no secret is pasted.

*This is exactly the "instruments lie before code does" failure mode:* a check that
"passed" against 5434 would have been a confident, wrong PASS. Round 817 must use
the `-h 127.0.0.1 -p 5432` form.

### 3.1 The four columns and both indexes, by name

```text
$ psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -c "\d project_tasks"
                                 Table "public.project_tasks"
    Column    |           Type           | Collation | Nullable |           Default
--------------+--------------------------+-----------+----------+------------------------------
 id           | uuid                     |           | not null | gen_random_uuid()
 project_id   | uuid                     |           | not null |
 round        | integer                  |           | not null | 0
 role         | character varying(16)    |           | not null |
 title        | text                     |           | not null |
 brief        | text                     |           | not null |
 status       | character varying(16)    |           | not null | 'pending'::character varying
 run_id       | uuid                     |           |          |
 fix_cycle    | integer                  |           | not null | 0
 created_at   | timestamp with time zone |           | not null | now()
 updated_at   | timestamp with time zone |           | not null | now()
 tier         | character varying(16)    |           |          |
 attempt      | integer                  |           | not null | 0
 chain_key    | text                     |           |          |
 depends_on   | uuid[]                   |           |          |
 workstream   | text                     |           | not null | 'main'::text
 write_set    | text[]                   |           | not null | '{}'::text[]
 graph_frozen | boolean                  |           | not null | false
Indexes:
    "project_tasks_pkey" PRIMARY KEY, btree (id)
    "project_tasks_chain_key_uniq" UNIQUE, btree (project_id, chain_key) WHERE chain_key IS NOT NULL
    "project_tasks_depends_on_gin" gin (depends_on)
    "project_tasks_identity_idx" UNIQUE, btree (project_id, round, role, title)
    "project_tasks_pending_idx" btree (project_id) WHERE status::text = ANY (ARRAY['pending'::character varying, 'ready'::character varying]::text[])
    "project_tasks_project_idx" btree (project_id, round, status)
    "project_tasks_run_idx" btree (run_id) WHERE run_id IS NOT NULL
    "project_tasks_workstream_idx" btree (project_id, workstream, status)
Check constraints:
    "project_tasks_role_check" CHECK (role::text = ANY (ARRAY['architect'::character varying, 'planner'::character varying, 'scout'::character varying, 'researcher'::character varying, 'builder'::character varying, 'reviewer'::character varying, 'steward'::character varying, 'tester'::character varying]::text[]))
    "project_tasks_status_check" CHECK (status::text = ANY (ARRAY['pending'::character varying, 'ready'::character varying, 'running'::character varying, 'done'::character varying, 'failed'::character varying, 'blocked'::character varying]::text[]))
    "project_tasks_tier_check" CHECK (tier IS NULL OR (tier::text = ANY (ARRAY['fast'::character varying, 'junior'::character varying, 'standard'::character varying, 'flagship'::character varying]::text[])))
    "project_tasks_workstream_chk" CHECK (workstream ~ '^[a-z0-9][a-z0-9-]{0,39}$'::text)
Foreign-key constraints:
    "project_tasks_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    "project_tasks_run_id_fkey" FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
```

Confirmed **by name**, on the live server identified in §3.0:

- columns `depends_on uuid[]` (nullable — the legacy sentinel), `workstream text NOT NULL DEFAULT 'main'`,
  `write_set text[] NOT NULL DEFAULT '{}'`, `graph_frozen boolean NOT NULL DEFAULT false` (R71);
- indexes `project_tasks_depends_on_gin` (GIN over `depends_on`) and
  `project_tasks_workstream_idx` (btree `(project_id, workstream, status)`);
- plus `project_tasks_workstream_chk`, the name-shape constraint.

### 3.2 The R71 consistency pair — and why the second number is not 0, and never can be again

```text
$ ... -c "SELECT graph_frozen, count(*) FROM project_tasks GROUP BY 1;"
 graph_frozen | count
--------------+-------
 f            |     4
 t            |   473
(2 rows)

$ ... -c "SELECT count(*) FROM project_tasks WHERE graph_frozen <> (depends_on IS NOT NULL);"
 count
-------
     2
(1 row)

$ ... the offending rows, named
-[ RECORD 1 ]+----------------------------------------------
id           | b7f5bc24-789d-4f09-a97f-c4501f37c9b4
project_id   | 8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
round        | 815
role         | builder
status       | running
graph_frozen | f
depends_on   | {}
workstream   | main
created_at   | 2026-08-18 06:34:35.265097+00
title        | Phase 8G: live verification after the restart
-[ RECORD 2 ]+----------------------------------------------
id           | 69686d9e-62db-467c-ad72-f95654b40b0b
project_id   | b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
round        | 0
role         | architect
status       | running
graph_frozen | f
depends_on   | {}
workstream   | main
created_at   | 2026-08-18 06:38:19.426013+00
title        | Plan: scripts-checks-typecheck-gate

$ ... the directional invariant that IS true: frozen implies a closure
 frozen_without_closure
------------------------
                      0
(1 row)

$ ... breakdown
 graph_frozen | dep_is_null | count
--------------+-------------+-------
 f            | f           |     2
 f            | t           |     2
 t            | f           |   473
(3 rows)
```

### FINDING 3B (HIGH — but a **gate defect**, NOT a data defect; nothing was repaired)

The brief states that a non-zero second number "means the backfill and the sentinel
disagree on the live data". **On this data it means no such thing.** The two rows it
counts are:

1. **this very task** (`b7f5bc24`, round 815), seeded by the watcher at 06:34:35Z; and
2. the **DoD-6 architect task** (`69686d9e`), created by this task at 06:38:19Z.

Both were created *after* the backfill, both carry `depends_on = '{}'`, and both
are `graph_frozen = false` — which is exactly what the design requires. Cited by
symbol, from the sentinel table in the module header of
`forge-control/src/db/projects.ts` (live tree, HEAD `9b960ef`):

> `'{}'` names nothing, is trivially satisfied, and promotes immediately: **an
> explicit root**.

and, from the same header:

> `graph_frozen` (R71), **written by 0040's backfill itself**

So `graph_frozen` marks *provenance* — "the backfill wrote this row's closure" —
in one direction only. The true live invariant is

```sql
SELECT count(*) FROM project_tasks WHERE graph_frozen AND depends_on IS NULL;  -- 0
```

(`graph_frozen → depends_on IS NOT NULL`), and it **is** 0 above. The converse
(`depends_on IS NOT NULL → graph_frozen`) is false by construction for every row
the new engine writes, because a new graph root has a non-NULL `'{}'` closure and
no backfill provenance. The count is therefore **monotonically increasing**: it was
1 when I first ran it at 06:36Z, 2 at 06:39Z after the DoD-6 architect row landed,
and it will equal *the number of post-migration tasks that declare `depends_on`* —
which is every task this engine now creates. A gate stated as "MUST BE 0" against
live data is unsatisfiable from the first graph row onward.

`scripts/checks/check-migration-0040.sh` — the place this pair is actually
*enforced* — is **correct and unchanged**: it runs against a throwaway schema whose
every row is a backfilled row, and it already contains the negative control that
proves this reading rather than contradicting it —

> `# The negative control, inserted AFTER the backfill exactly as the engine does:`
> `# an INSERT that does not name the column must produce a NOT-frozen row`
> `assert_eq 'R71 CONTROL: a row inserted after the backfill is NOT frozen' 'f' …`

— inserting a row with `depends_on = '{}'::uuid[]` and asserting `graph_frozen` is
`false`. That control row *is* the shape of the two live rows above. The check
passes because it asserts the pair *before* inserting the control and deletes it
after; the assertion is scoped to a population where the biconditional holds.

**Amended where enforced (standing rule 2), in this commit:** the live-database
clause in `docs/plan/engine-task-graph/04-phases.md` §"Verification task", which is
the only place the biconditional is asserted about *live* data. Its own prose
already said the right thing ("`false` on every row inserted after it"); the SQL
beside it did not express that sentence. The clause now demands
`graph_frozen AND depends_on IS NULL` = 0, keeps the `GROUP BY 1` census as
context, and states inline why the converse cannot be demanded. The throwaway-schema
assertion in `check-migration-0040.sh` is deliberately left alone — see the
reasoning recorded there.

**Nothing on the live database was repaired, altered or deleted by this task.**
There is nothing to repair: the data is right and the gate was wrong.

---

## 4. The other migrations that rode along

```text
$ psql ... -c "\dt usage_hourly app_settings ui_dismissals"   # the brief command, verbatim
            List of relations
 Schema |     Name     | Type  |  Owner
--------+--------------+-------+----------
 public | usage_hourly | table | postgres
(1 row)

\dt: extra argument "app_settings" ignored
\dt: extra argument "ui_dismissals" ignored
```

### FINDING 4A (MEDIUM, instrument) — the brief's `\dt` command silently checks only the first table

`\dt` takes **one** pattern. The 2nd and 3rd arguments are discarded with a notice
that is easy to scroll past, and the output shows one row — which reads exactly
like "one of the three exists" *and* like "the command worked". Taken at face value
it would have certified `app_settings` and `ui_dismissals` without looking at them.
Run one pattern at a time, or use `to_regclass`:

```text
$ psql ... -c "\dt usage_hourly" / "\dt app_settings" / "\dt ui_dismissals"   # one pattern each
            List of relations
 Schema |     Name     | Type  |  Owner
--------+--------------+-------+----------
 public | usage_hourly | table | postgres
(1 row)

            List of relations
 Schema |     Name     | Type  |  Owner
--------+--------------+-------+----------
 public | app_settings | table | postgres
(1 row)

             List of relations
 Schema |     Name      | Type  |  Owner
--------+---------------+-------+----------
 public | ui_dismissals | table | postgres
(1 row)

$ psql ... -c "SELECT to_regclass(...) x3"
 usage_hourly | app_settings | ui_dismissals
--------------+--------------+---------------
 usage_hourly | app_settings | ui_dismissals
(1 row)
```

All three exist, confirmed by name and twice by two different mechanisms.

### 4.1 The two routes that read them

```text
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7700/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team
200
$ curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:7700/api/usage/series"
200
$ curl -s .../team | head -c 240
{"chat_id":"bfd1283a-b71b-4f35-b577-7d09aad803f2","now":"2026-08-18T06:39:53.800Z","project":{"id":"8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4","status":"active"},"link_source":"metadata","link_ambiguous":true,"candidates":[{"id":"8c591d6c-5642-4
$ curl -s ".../api/usage/series" | head -c 240
{"hourly":[{"bucket_start":"2026-08-17T07:00:00.000Z","tokens_in":115,"tokens_out":181,"cache_read":4421290,"cache_write":251541,"shadow_usd":23.7637,"eur":20.4368,"run_count":12},{"bucket_start":"2026-08-17T08:00:00.000Z","tokens_in":120,"
```

Both **200**, with real bodies rather than empty envelopes — the status code alone
would not have distinguished a 200 with `{"hourly":[]}` from a working read.

---

## 5. R14 is in the deployed tree

Read from `/opt/forge-ai-os/forge-control/src/db/projects.ts` at live HEAD
`9b960ef51e690bba061a42e7110640cbfb6dea05` (blob `a288984368…`). Cited by symbol:
`RetryOutcome`, `retryTask()`, `MAX_TASK_ATTEMPTS`.

```ts
export type RetryOutcome =
  | { ok: true; task: ProjectTask; project_resumed: boolean }
  | { ok: false; reason: "not_found" | "not_retryable" | "attempts_exhausted"; task: ProjectTask | null }
  /** R14 on the operator path: the row's `depends_on` is still corrupt, so
   *  `ready` is not a state it may occupy. Carries the ids so the API can name
   *  them … */
  | { ok: false; reason: "dependencies_corrupt"; task: ProjectTask; corruption: DepsCorruption };

export async function retryTask(
  id: string,
  opts: { force?: boolean } = {},
): Promise<RetryOutcome> {
  const task = await getTask(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (task.status !== "failed" && task.status !== "blocked") {
    return { ok: false, reason: "not_retryable", task };
  }
  if (task.depends_on !== null) {
    const corruption = await dependencyCorruption(id);
    if (corruption) return { ok: false, reason: "dependencies_corrupt", task, corruption };
  }
  if (task.attempt >= MAX_TASK_ATTEMPTS && !opts.force) {
    return { ok: false, reason: "attempts_exhausted", task };
  }
```

**The finding, stated explicitly: R14 IS present in the deployed tree, and `force`
does not override it.** The integrity check is evaluated *before* the cap check and
does not consult `opts.force` at all; `force` appears only in the
`attempts_exhausted` arm. The shipped doc-comment says why in the deployed tree's
own words: *"Integrity is checked BEFORE the attempt cap and is NOT bypassable by
`force` … `force` is an override of a budget, not of a fact."*

`unwedgeProject()` surfaces it rather than swallowing it:

```ts
(s) => `task ${s.id} was NOT retried: its depends_on ${s.detail ?? "is corrupt"} (R14) — force does not override this`,
```

The unattended path is real and does use `force`:

```text
$ grep -n "unwedge" /opt/ai-os/scripts/fleet-watchdog.sh
2:# Fleet watchdog (2026-08-05): every 10 min via system cron, unwedge projects
35:  resp="$(curl -s -X POST "$API/projects/$id/unwedge" -H 'content-type: application/json' -d '{}')"
63:      f="$(curl -s -X POST "$API/projects/$id/unwedge" -H 'content-type: application/json' -d '{"force":true}' |
$ crontab -l | grep fleet-watchdog
*/10 * * * * /opt/ai-os/scripts/fleet-watchdog.sh
```

Line 63 is the exact 04:00-with-nobody-watching scenario the brief names — the
watchdog escalates to `{"force":true}` once retries are exhausted. Because the
deployed `retryTask()` checks integrity first, that escalation cannot turn a
corrupt-`depends_on` row into a run. **The watchdog does NOT need to be disabled.**

---

## 6. The cycle 400, honestly

R25 (`01-requirements.md`) demands a cycle be rejected naming the path; **R26** says
a cycle is *structurally unreachable* given R27 and R29 — dependencies may only
name rows that already exist, and `depends_on` is immutable after insert, so ids
are only ever named in insert order. The deployed route says the same at the belt,
in `POST /:id/tasks` (live tree, `forge-control/src/routes/projects.ts`):

```ts
/* R25 — the belt (R26 says why it is one). The candidate row does not exist
 * yet, so it is walked under a MINTED id, and the placeholder is sound for a
 * stated reason rather than a convenient one: R29 makes `depends_on`
 * immutable after insert, so the only edges this node can ever have are the
 * ones in this request body, and a v4 uuid cannot collide with a stored row's
 * id. Nothing is written under the placeholder — createTask() below lets the
 * database mint the real id. */
```

**No cycle was inserted and none is claimed.** The two reachable 400s, live:

### 6a — a `depends_on` naming an id that exists nowhere

```text
request:
{"role":"builder","title":"probe-a dangling dependency (phase 8G, MUST 400)","brief":"Live 400 probe for R25/R26 item 6a. This task must never exist.","depends_on":["00000000-0000-4000-8000-00000000dead"],"write_set":["docs/plan/engine-task-graph/evidence/phase8-verify.md"]}

response (2026-08-18T06:38:53Z):
{"error":"depends_on names 1 dependency id(s) that do not exist: 00000000-0000-4000-8000-00000000dead","unknown_dependencies":["00000000-0000-4000-8000-00000000dead"]}
HTTP 400
```

### 6b — a `depends_on` naming a real task id belonging to a different project

The id used is the DoD-6 project's architect task (`69686d9e…`, project `b7ab4c57…`),
POSTed to project `8c591d6c…`.

```text
request:
{"role":"builder","title":"probe-b foreign-project dependency (phase 8G, MUST 400)","brief":"Live 400 probe for R25/R26 item 6b. This task must never exist.","depends_on":["69686d9e-62db-467c-ad72-f95654b40b0b"],"write_set":["docs/plan/engine-task-graph/evidence/phase8-verify.md"]}

response (2026-08-18T06:38:53Z):
{"error":"depends_on names 1 dependency id(s) belonging to another project: 69686d9e-62db-467c-ad72-f95654b40b0b","cross_project_dependencies":["69686d9e-62db-467c-ad72-f95654b40b0b"]}
HTTP 400
```

Each 400 **names the offending id** — in the prose message *and* in a machine-readable
key (`unknown_dependencies`, `cross_project_dependencies`), so a planner can retry
without parsing English. Neither probe wrote a row:

```text
$ psql ... -c "SELECT count(*) AS probe_rows FROM project_tasks WHERE title LIKE 'probe-%(phase 8G%';"
 probe_rows
------------
          0
(1 row)
```

### The paragraph the brief asks for

A true cycle is unreachable at insert. `depends_on` may only name rows that already
exist (R27 — the dangling check in 6a is that rule's enforcement) and it is
immutable after insert (R29), so the graph is only ever extended by a node whose
every out-edge points into the already-committed past; a set of edges built that
way is a DAG by induction on insert order. The candidate row itself cannot be named
by anything, because nothing can reference an id the database has not minted yet —
which is why the route walks it under a placeholder uuid and why that placeholder
is sound rather than merely convenient. The detector is kept anyway for two reasons
that have nothing to do with the API: `depends_on` is an ordinary array column that
an operator with `psql` can write by hand, and any future bulk-insert path — a
planner POSTing a whole fan-out in one transaction, which is the obvious next
optimisation — would let two rows in the same statement name each other and reopen
the door immediately. A detector documented as unreachable is a detector nobody
deletes by accident; a detector deleted because "it can't happen" is discovered
missing by the first bulk insert.

---

## 7. The two live observations DoD-1 and DoD-2 owe

*Filled in at the end of this run, from live SQL and live disk. Nothing here is
asserted from expectation. See §7.3 for what was open when this task ended.*

<!-- OBSERVATIONS -->

---

## 8. The DoD-6 measurement project

### 8.0 The manager chat was read first, before any POST

```text
$ curl -s http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/comms
```

Every entry in `comms` carries `meta.comms.from = "worker"`, `direction = "in"` —
34 worker reports, the newest being round 950 at `2026-08-18T06:32:33Z`. **There is
no message from Konrad naming a different goal**, so the default goal was used
verbatim, as ruled.

### 8.1 FINDING 8A (HIGH, instrument) — the brief's create-project body is wrong against the deployed route

The brief's curl sends `{"repo","mode":"goal","architect_tier","goal":…}`. The
deployed route (`POST /` in `forge-control/src/routes/projects.ts`, type
`CreateProjectBody`) has **no `goal` field**; it requires `name` and `brief`:

```text
$ curl -sX POST http://127.0.0.1:7700/api/projects -H 'content-type: application/json' -d '{"repo":"ai-os","mode":"goal","architect_tier":"standard","goal":"…"}'
HTTP 400
{"error":"name required"}
```

This is the good failure mode — it 400s loudly rather than creating a project with
an empty brief. But note what would have happened had `name` been present: `goal` is
an unknown key on `CreateProjectBody` and would have been **silently dropped**, and
the project would have been created with an empty brief and a round-0 architect
staring at nothing. The instruction was corrected here, not worked around: the goal
text was sent **verbatim as `brief`**, with a `name` derived from it.

### 8.2 The project, created

```text
request (2026-08-18T06:38:19Z):
{"name": "scripts-checks-typecheck-gate", "brief": "Bring every script under scripts/checks/ under a typecheck gate and fix what it finds. tsx strips types without checking them and scripts/checks/ sits outside both tsconfig include lists, so the fleet's verification instruments are the least-verified code in the repo. Measured 2026-08-18: compiled one file per invocation, six scripts pass and check-orientation.ts, serve-sse-808.ts and check-chat-rich.tsx are red. Fix each red script, extend scripts/checks/instrument-manifest.txt to cover the whole directory, and prove the gate goes red when a file's types are broken.", "repo": "ai-os", "mode": "goal", "architect_tier": "standard"}

response: HTTP 201
PROJECT_ID: b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
name: scripts-checks-typecheck-gate | status: active | repo: ai-os
workspace_dir: /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5 | base: main | work_branch: project/b7ab4c57
metadata: {"mode": "goal", "strict_write_sets": true}
architectTask: 69686d9e-62db-467c-ad72-f95654b40b0b round 0 architect pending tier standard depends_on [] workstream main
```

**`DOD6_PROJECT_ID = b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`.**

`metadata.strict_write_sets: true` is R31 firing on a new goal-mode project — every
builder and tester of this project will be required to declare a write-set, which is
the input to the contention computation DoD-6 is measuring.

A decision the brief did not cover: **`origin_chat_id` was deliberately omitted.**
The manager chat `bfd1283a…` already resolves to this project (`8c591d6c…`) through
`metadata`, and its `/team` response already reports `"link_ambiguous": true`.
Attaching a second project to the same chat would have made round 304's linkage
resolver choose between two metadata-linked projects for the chat round 817 reports
into. DoD-6 needs the project *measured*, not *conversational*.

Also verified before POSTing, because Konrad is cost-sensitive and a duplicate
measurement project is real money: no such project already existed —
`SELECT id,name,status FROM projects WHERE created_at > now() - interval '12 hours'`
returned 0 rows, and no project's brief matched `%instrument-manifest%` or
`%typecheck gate%`. **Nothing was seeded beyond this one project.**

### 8.3 The second watcher, detached

```text
$ NEW_ID=b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
$ TOK="$(printf '__%s__' DOD6_PROJECT_ID)"
$ setsid nohup /opt/forge-ai-os/scripts/deploy/await-and-seed.sh project-done "$NEW_ID" \
    /opt/forge-ai-os/scripts/deploy/payload-report.json --substitute "$TOK=$NEW_ID" \
    >> /tmp/forge-phase8-seed.log 2>&1 &

$ pgrep -af 'await-and-seed.sh'
2126219 bash /opt/forge-ai-os/scripts/deploy/await-and-seed.sh project-done b7ab4c57-7ebd-4ef5-a7e3-9345941467c5 /opt/forge-ai-os/scripts/deploy/payload-report.json --substitute __DOD6_PROJECT_ID__=b7ab4c57-7ebd-4ef5-a7e3-9345941467c5

$ tail -4 /tmp/forge-phase8-seed.log
[2026-08-18T08:38:29+02:00] await-and-seed: provenance head=9b960ef self-sha256=9429971eea0c1aa77afe346f58988c0405b57410e373a282b55b5630c6e2a8d0 mode=project-done payload=/opt/forge-ai-os/scripts/deploy/payload-report.json launched=2026-08-18T08:38:29+02:00 baseline=[project=b7ab4c57-7ebd-4ef5-a7e3-9345941467c5 status=active] poll=60s timeout=46800s api=http://127.0.0.1:7700
[2026-08-18T08:38:29+02:00] await-and-seed: substitutions: __DOD6_PROJECT_ID__=b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
[2026-08-18T08:38:29+02:00] await-and-seed: waiting for: project b7ab4c57-7ebd-4ef5-a7e3-9345941467c5 to reach status=done
[2026-08-18T08:38:29+02:00] await-and-seed: poll: project b7ab4c57-7ebd-4ef5-a7e3-9345941467c5 is 'active', not 'done' — not firing
```

The watcher is alive, carries its own provenance line (`head=9b960ef`,
`self-sha256=9429971e…` — a harness that states its build identity, standing rule 3),
and the `__DOD6_PROJECT_ID__` token resolved. It was **not** polled to completion by
this task. Round 817's task (`payload-report.json`, "Phase 8H: the number, or the
honest absence of one", round 817) will be seeded by it when the project reaches
`done`.

### 8.4 The falsifiable fan-out spot observation

<!-- FANOUT -->

---

## 9. Undeclared writes, disclosed

My declared write-set is **`docs/plan/engine-task-graph/evidence/phase8-verify.md`**
alone. This commit also touches:

- **`docs/plan/engine-task-graph/04-phases.md`** — required by **standing rule 2**:
  finding 3B is an unsatisfiable gate, and §"Verification task" is where that gate
  is stated about live data. Amended in the same commit, reasoning inline, plus the
  ownership row in §10 recording this write. No other section of that file changed.

Nothing else. `git show --stat` on this commit is the proof.
