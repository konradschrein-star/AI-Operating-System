# Evidence — Fleet Runtime Default Tier Switch & Gemini Dispatch Acceptance

**Project:** `aios-gemini-default-tier`  
**Branch:** `project/860c948e`  
**Date:** 2026-08-25  
**Goal:** Prove the runtime fleet default tier switch works end-to-end against live PostgreSQL (`content_forge`), allowing Gemini (`agy`) to serve as the runtime default engine for sub-agent work without requiring server restarts or code deploys.

---

## 1. Overview & Acceptance Criteria

The acceptance protocol requires empirical demonstration of runtime switchability and dynamic task tier resolution:

1. **Set default tier to `gemini` via API** (`PUT /api/fleet/default-tier {"tier":"gemini"}`).
2. **Verify `app_settings` row in PostgreSQL** (`SELECT * FROM app_settings WHERE key = 'fleet.default_tier'`).
3. **Create a task with omitted tier** via `POST /api/projects/:id/tasks` and measure its persisted tier in `project_tasks` — must be `'gemini'`.
4. **Set default tier to `junior` via API** (`PUT /api/fleet/default-tier {"tier":"junior"}`).
5. **Create another task with omitted tier** and measure its persisted tier in `project_tasks` — must be `'junior'`.
6. **Restore default tier to `gemini` via API**.
7. **Execute typecheck & static verification** (`bash scripts/checks/guard.sh --fast` and `pnpm test`).

All HTTP interactions were routed through the worktree's API router connected directly to live PostgreSQL (`DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/content_forge`) per worktree isolation conventions.

---

## 2. Live Acceptance Transcript

### Step 1: Set Fleet Default Tier to `gemini` via API

```bash
$ curl -i -X PUT http://127.0.0.1:27700/api/fleet/default-tier \
    -H 'content-type: application/json' \
    -d '{"tier":"gemini"}'
```

**HTTP Response:**
```http
HTTP/1.1 200 OK
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: application/json
content-length: 89
Date: Tue, 25 Aug 2026 17:49:04 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"default_tier":"gemini","source":"app_settings","updated_at":"2026-08-25T17:49:04.214Z"}
```

Verification via `GET /api/fleet/default-tier`:
```bash
$ curl -i http://127.0.0.1:27700/api/fleet/default-tier
```
```http
HTTP/1.1 200 OK
content-type: application/json
content-length: 89
Date: Tue, 25 Aug 2026 17:49:05 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"default_tier":"gemini","source":"app_settings","updated_at":"2026-08-25T17:49:04.214Z"}
```

---

### Step 2: Verify `app_settings` Row in PostgreSQL

```bash
$ docker exec content-forge-postgres psql -U postgres -d content_forge -c \
    "SELECT * FROM app_settings WHERE key = 'fleet.default_tier';"
```

**Database Output:**
```sql
        key         |  value   |          updated_at          
--------------------+----------+------------------------------
 fleet.default_tier | "gemini" | 2026-08-25 17:49:04.21493+00
(1 row)
```

---

### Step 3: Create Task with Omitted Tier & Verify `tier = 'gemini'`

**API Call:**
```bash
$ curl -i -X POST http://127.0.0.1:27700/api/projects/860c948e-eab4-4ad4-98ed-644250def72c/tasks \
    -H 'content-type: application/json' \
    -d '{"title":"acceptance-probe-gemini-default","brief":"Verify omitted tier defaults to gemini","role":"builder"}'
```

**HTTP Response:**
```http
HTTP/1.1 201 Created
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: application/json
content-length: 480
Date: Tue, 25 Aug 2026 17:49:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"task":{"id":"2c6a0a6c-04e1-4db3-acc1-707eaad3ca2f","project_id":"860c948e-eab4-4ad4-98ed-644250def72c","round":0,"role":"builder","title":"acceptance-probe-gemini-default","brief":"Verify omitted tier defaults to gemini","status":"pending","run_id":null,"fix_cycle":0,"tier":"gemini","attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"graph_frozen":false,"created_at":"2026-08-25 17:49:16.152263+00","updated_at":"2026-08-25 17:49:16.152263+00"}}
```

**Database Measurement (`project_tasks`):**
```bash
$ docker exec content-forge-postgres psql -U postgres -d content_forge -c \
    "SELECT id, project_id, title, role, tier, status, created_at FROM project_tasks WHERE id = '2c6a0a6c-04e1-4db3-acc1-707eaad3ca2f';"
```

```sql
                  id                  |              project_id              |              title              |  role   |  tier  | status  |          created_at           
--------------------------------------+--------------------------------------+---------------------------------+---------+--------+---------+-------------------------------
 2c6a0a6c-04e1-4db3-acc1-707eaad3ca2f | 860c948e-eab4-4ad4-98ed-644250def72c | acceptance-probe-gemini-default | builder | gemini | pending | 2026-08-25 17:49:16.152263+00
(1 row)
```

**Result:** Persisted task row resolved `tier = 'gemini'` from `app_settings`.

---

### Step 4: Switch Default Tier to `junior` via API

```bash
$ curl -i -X PUT http://127.0.0.1:27700/api/fleet/default-tier \
    -H 'content-type: application/json' \
    -d '{"tier":"junior"}'
```

**HTTP Response:**
```http
HTTP/1.1 200 OK
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: application/json
content-length: 89
Date: Tue, 25 Aug 2026 17:49:19 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"default_tier":"junior","source":"app_settings","updated_at":"2026-08-25T17:49:19.950Z"}
```

**Database Verification (`app_settings`):**
```bash
$ docker exec content-forge-postgres psql -U postgres -d content_forge -c \
    "SELECT * FROM app_settings WHERE key = 'fleet.default_tier';"
```

```sql
        key         |  value   |          updated_at           
--------------------+----------+-------------------------------
 fleet.default_tier | "junior" | 2026-08-25 17:49:19.950411+00
(1 row)
```

---

### Step 5: Create Second Task with Omitted Tier & Verify `tier = 'junior'`

**API Call:**
```bash
$ curl -i -X POST http://127.0.0.1:27700/api/projects/860c948e-eab4-4ad4-98ed-644250def72c/tasks \
    -H 'content-type: application/json' \
    -d '{"title":"acceptance-probe-junior-switch","brief":"Verify omitted tier defaults to junior after runtime switch","role":"builder"}'
```

**HTTP Response:**
```http
HTTP/1.1 201 Created
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: application/json
content-length: 500
Date: Tue, 25 Aug 2026 17:49:30 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"task":{"id":"5d0788f8-5a79-4119-b3f6-2dbc9dedbbc1","project_id":"860c948e-eab4-4ad4-98ed-644250def72c","round":0,"role":"builder","title":"acceptance-probe-junior-switch","brief":"Verify omitted tier defaults to junior after runtime switch","status":"pending","run_id":null,"fix_cycle":0,"tier":"junior","attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"graph_frozen":false,"created_at":"2026-08-25 17:49:30.421449+00","updated_at":"2026-08-25 17:49:30.421449+00"}}
```

**Database Measurement (`project_tasks`):**
```bash
$ docker exec content-forge-postgres psql -U postgres -d content_forge -c \
    "SELECT id, project_id, title, role, tier, status, created_at FROM project_tasks WHERE id = '5d0788f8-5a79-4119-b3f6-2dbc9dedbbc1';"
```

```sql
                  id                  |              project_id              |             title              |  role   |  tier  | status  |          created_at           
--------------------------------------+--------------------------------------+--------------------------------+---------+--------+---------+-------------------------------
 5d0788f8-5a79-4119-b3f6-2dbc9dedbbc1 | 860c948e-eab4-4ad4-98ed-644250def72c | acceptance-probe-junior-switch | builder | junior | pending | 2026-08-25 17:49:30.421449+00
(1 row)
```

**Result:** Persisted task row resolved `tier = 'junior'` dynamically without server restart or code change.

---

### Step 6: Restore Fleet Default Tier to `gemini`

**API Call:**
```bash
$ curl -i -X PUT http://127.0.0.1:27700/api/fleet/default-tier \
    -H 'content-type: application/json' \
    -d '{"tier":"gemini"}'
```

**HTTP Response:**
```http
HTTP/1.1 200 OK
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: application/json
content-length: 89
Date: Tue, 25 Aug 2026 17:49:34 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"default_tier":"gemini","source":"app_settings","updated_at":"2026-08-25T17:49:34.634Z"}
```

**Database Verification (`app_settings`):**
```bash
$ docker exec content-forge-postgres psql -U postgres -d content_forge -c \
    "SELECT * FROM app_settings WHERE key = 'fleet.default_tier';"
```

```sql
        key         |  value   |          updated_at           
--------------------+----------+-------------------------------
 fleet.default_tier | "gemini" | 2026-08-25 17:49:34.634259+00
(1 row)
```

**Probe Task Cleanup:** The test probe tasks (`2c6a0a6c-04e1-4db3-acc1-707eaad3ca2f` and `5d0788f8-5a79-4119-b3f6-2dbc9dedbbc1`) were cancelled cleanly via `POST /api/projects/:id/tasks/:taskId/cancel` with audit reason `"acceptance probe completed"`.

---

## 3. Verification & Guard Checks

### Unit Test Suite
Ran full test suite in `forge-control`:
```bash
$ pnpm test
```
```
ℹ tests 2365
ℹ suites 465
ℹ pass 2365
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21678.566403
```
All 2365 tests passed across 465 test suites.

### Guard Suite
Ran `bash scripts/checks/guard.sh --fast`:
```
================================================================================
 GUARD — mode=fast strict=off   2026-08-25T19:48:48+02:00
================================================================================

PH CHECK                    STATUS   TIME   DETAIL
-- ------------------------ ------   ----   ------
0  node-version             PASS       0s   
0  devdeps-forge-control    PASS       0s   
0  devdeps-forge-control-web PASS       0s   
1  no-raw-colours           FAIL       0s   forge-control-web/app/desktop/goals/WeekGrid.tsx:48
1  dollar-sweep             PASS       1s   
1  forbidden-file-diff      PASS       0s   
2  tsc-forge-control        PASS      17s   
2  tsc-forge-control-web    PASS       6s   
2  instrument-typecheck     SKIP       0s   deferred to --full
3  web-build                SKIP       0s   deferred to --full
4  gates-808-suite          SKIP       0s   deferred to --full

PASS: 7   FAIL: 1   SKIP: 3
```

*Note on `no-raw-colours` failure:* The failure in `forge-control-web/app/desktop/goals/WeekGrid.tsx:48` is the documented inherited baseline defect from commit `b41e824` at `main` (documented in memory note `gate5-raw-colours-red-at-main-from-week-board.md`). Typechecks (`tsc-forge-control`, `tsc-forge-control-web`) and forbidden file diff checks all passed green.

---

## 4. Summary

The live acceptance test successfully proved:
1. `PUT /api/fleet/default-tier` safely updates `app_settings` with valid task tiers.
2. `POST /api/projects/:id/tasks` resolves an untiered task to the active runtime default tier. **The scheduler-tick half is measured separately in §5** — round 3's wording claimed it here, and §2 did not exercise it.
3. Dynamically changing the runtime default tier immediately alters tier resolution for new tasks without process restarts or deploys.
4. Database state remains consistent and verifiable throughout all state transitions.

---

## 5. The SCHEDULER TICK half — measured (round 4)

Round 3's §4 item 2 said the tick "correctly resolve[s] untiered tasks to the
active runtime default tier". No tick appeared anywhere in the transcript: §2
exercised only `POST /api/projects/:id/tasks`, and the dispatch half
(`spawnTaskRuns`, `lib/project-tick.ts`) was held only by source-string
assertions in `project-tick.test.ts`. That claim has been struck from §4 and
replaced by this section, which runs the real thing.

### 5.1 Why a scratch database, and what makes this safe

The brief's acceptance says *"flip the switch via the API, run a tick, and show
a newly created task row landing with `tier='gemini'`"*. `spawnTaskRuns()` is not
exported, so the entry point is the exported `projectTick()`.

It is run against a **scratch database**, not `content_forge`:

* `projectTick()` only INSERTs a `runs` row. The executor that would turn that
  row into a paid engine process polls the **live** database, which this probe
  never opens — so no run is spawned, on either database.
* A build task has no business writing to the live fleet's tables. Reads in §2
  were through the API; this is a write path.

The schema is a **replay of the repo's own migrations**, not hand-written:
`db/migrations/0021…0049` applied in order into a fresh database, with the one
documented exception below.

```bash
$ SCRATCH="aios_tick_probe_${FORGE_RUN_ID}"      # aios_tick_probe_978085a8af2f
$ psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "CREATE DATABASE \"$SCRATCH\""
CREATE DATABASE

# The ONE hand-written statement. 0021 declares inbox_items.related_job_id
# REFERENCES content_jobs(id), and Postgres requires the referenced table to
# exist at CREATE TABLE time. Everything else below is the repo's own SQL.
$ psql ... -d "$SCRATCH" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE content_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());'

$ for f in db/migrations/00[2-9]*.sql; do psql ... -d "$SCRATCH" -f "$f"; done
files with errors: 0
```

### 5.2 The probe

`forge-control/tick-probe.mts`, run from inside the package (ESM resolves `pg`
from the file's own real path, so a `/tmp` probe cannot import it), then
deleted — `git status --porcelain` is clean, see §5.5.

It refuses to run without an explicit `SCRATCH_URL`, and refuses a `SCRATCH_URL`
that names `content_forge`. `DATABASE_URL` is repointed **before** the first
dynamic `import()`, because every `db/*.ts` module binds its `Pool` at import
time and setting it afterwards is a silent no-op.

For each of three cases it: writes `app_settings['fleet.default_tier']`, seeds
an `active` project and one `ready` `builder` task **with `tier` explicitly
`NULL`** (and throws if the seeded row is not NULL — the fixture is checked, not
assumed), calls `projectTick()`, then reads the result back out of the database.

```ts
const { projectTick } = await import("./src/lib/project-tick.ts");
...
const [row] = await q(
  `SELECT pt.tier, pt.status, pt.run_id::text,
          r.metadata->>'model'  AS model,
          r.metadata->>'effort' AS effort
     FROM project_tasks pt LEFT JOIN runs r ON r.id = pt.run_id
    WHERE pt.id = $1`, [taskId]);
```

`runs.metadata.model` is the measurement that matters: it is what `executor.ts`
hands the child process verbatim, so it is the engine the untiered row actually
got — not a tier label, and not a log line.

### 5.3 Transcript

```

===== A — fleet default gemini: app_settings['fleet.default_tier'] = "gemini" =====
seeded project bce36f7d-aa92-4219-a5ac-6c78be076f88 / task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 with tier = NULL (verified above)
[project-tick] task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 carries no tier — dispatching on the fleet default 'gemini' (app_settings['fleet.default_tier'])
[project-tick] spawned builder run 1a8d7319-31d9-483d-9133-916c327f167e for task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 (round 0, tier gemini, workstream=main, deps=legacy) — tick-probe A — fleet default gemini · untiered probe task A — fleet default gemini

--- MEASURED FROM THE SCRATCH DB (task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052) ---
  project_tasks.tier   = null   (still NULL by design — the tick does not write it back)
  project_tasks.status = running
  runs.metadata.model  = "gemini-3.7-flash-high"   <-- the engine the untiered row actually got
  runs.metadata.effort = "high"
  LOG: [project-tick] task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 carries no tier — dispatching on the fleet default 'gemini' (app_settings['fleet.default_tier'])
  LOG: [project-tick] spawned builder run 1a8d7319-31d9-483d-9133-916c327f167e for task 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 (round 0, tier gemini, workstream=main, deps=legacy) — tick-probe A — fleet default gemini · untiered probe task A — fleet default gemini

===== B — flipped to junior at runtime, no restart: app_settings['fleet.default_tier'] = "junior" =====
seeded project 76e58b4e-acb5-491e-863d-6413a6159c8a / task 19d4346c-5540-4f08-8d01-06e3ffd8cb84 with tier = NULL (verified above)
[project-tick] task 19d4346c-5540-4f08-8d01-06e3ffd8cb84 carries no tier — dispatching on the fleet default 'junior' (app_settings['fleet.default_tier'])
[project-tick] spawned builder run 6adc0830-c9cb-4b28-8c6e-2b97ef19c65d for task 19d4346c-5540-4f08-8d01-06e3ffd8cb84 (round 0, tier junior, workstream=main, deps=legacy) — tick-probe B — flipped to junior at runtime, no restart · untiered probe task B — flipped to junior at runtime, no restart

--- MEASURED FROM THE SCRATCH DB (task 19d4346c-5540-4f08-8d01-06e3ffd8cb84) ---
  project_tasks.tier   = null   (still NULL by design — the tick does not write it back)
  project_tasks.status = running
  runs.metadata.model  = "claude-sonnet-5"   <-- the engine the untiered row actually got
  runs.metadata.effort = "high"
  LOG: [project-tick] task 19d4346c-5540-4f08-8d01-06e3ffd8cb84 carries no tier — dispatching on the fleet default 'junior' (app_settings['fleet.default_tier'])
  LOG: [project-tick] spawned builder run 6adc0830-c9cb-4b28-8c6e-2b97ef19c65d for task 19d4346c-5540-4f08-8d01-06e3ffd8cb84 (round 0, tier junior, workstream=main, deps=legacy) — tick-probe B — flipped to junior at runtime, no restart · untiered probe task B — flipped to junior at runtime, no restart

===== C — flipped back to gemini: app_settings['fleet.default_tier'] = "gemini" =====
seeded project bb34368e-51c6-4707-9869-6a1a24ddbcf3 / task 06035aba-a9e6-4992-8d1c-711f65551e0b with tier = NULL (verified above)
[project-tick] task 06035aba-a9e6-4992-8d1c-711f65551e0b carries no tier — dispatching on the fleet default 'gemini' (app_settings['fleet.default_tier'])
[project-tick] spawned builder run 9b879604-aa96-41bd-a2c0-7b26f0e4c1dc for task 06035aba-a9e6-4992-8d1c-711f65551e0b (round 0, tier gemini, workstream=main, deps=legacy) — tick-probe C — flipped back to gemini · untiered probe task C — flipped back to gemini

--- MEASURED FROM THE SCRATCH DB (task 06035aba-a9e6-4992-8d1c-711f65551e0b) ---
  project_tasks.tier   = null   (still NULL by design — the tick does not write it back)
  project_tasks.status = running
  runs.metadata.model  = "gemini-3.7-flash-high"   <-- the engine the untiered row actually got
  runs.metadata.effort = "high"
  LOG: [project-tick] task 06035aba-a9e6-4992-8d1c-711f65551e0b carries no tier — dispatching on the fleet default 'gemini' (app_settings['fleet.default_tier'])
  LOG: [project-tick] spawned builder run 9b879604-aa96-41bd-a2c0-7b26f0e4c1dc for task 06035aba-a9e6-4992-8d1c-711f65551e0b (round 0, tier gemini, workstream=main, deps=legacy) — tick-probe C — flipped back to gemini · untiered probe task C — flipped back to gemini

================ VERDICT ================
A  runs.metadata.model = gemini-3.7-flash-high
B  runs.metadata.model = claude-sonnet-5
C  runs.metadata.model = gemini-3.7-flash-high
PASS — the tick resolved each untiered row against the setting live
```

### 5.4 The same rows, queried independently

Not from the probe's own output — a fresh `psql` against the scratch database
afterwards. Seven rows: the three cases above plus four from earlier runs of the
same probe during development, which are shown rather than filtered out.

```sql
SELECT pt.id::text AS task_id, pt.tier AS task_tier, pt.status,
       r.metadata->>'model' AS run_model
  FROM project_tasks pt
  LEFT JOIN runs r ON r.id = pt.run_id
 ORDER BY pt.created_at;
```
```
               task_id                | task_tier | status  |       run_model
--------------------------------------+-----------+---------+-----------------------
 83f2024a-bd48-4071-a086-527b9bd1d1ee |           | running | gemini-3.7-flash-high
 c499f019-ce40-4d4d-94af-cd49624b900d |           | running | gemini-3.7-flash-high
 6fd72f57-ac24-40af-8a67-bedf55402c24 |           | running | claude-sonnet-5
 5966c2f7-14a1-40a3-9932-3e91a3503e64 |           | running | gemini-3.7-flash-high
 6d35c63b-1234-46d7-a5c9-a5b88c3ef052 |           | running | gemini-3.7-flash-high
 19d4346c-5540-4f08-8d01-06e3ffd8cb84 |           | running | claude-sonnet-5
 06035aba-a9e6-4992-8d1c-711f65551e0b |           | running | gemini-3.7-flash-high
(7 rows)
```

`task_tier` is blank on **every** row — that is the point, not an omission. The
tick does **not** write the resolved tier back to `project_tasks`; it substitutes
it into the claimed object and dispatches on it. The consequence is documented in
`lib/project-tick.ts` and is a known, accepted gap: R870's dropout recovery
guards on the *persisted* tier (`demoteTaskTier … WHERE tier = $2`), so an
untiered row that gemini drops takes the ordinary failure path instead of the
one-retry. Tiering the row at creation (§2, the route) is the real fix; this is
the net under rows that predate it.

**What §5 does NOT claim.** It does not exercise `agy` itself, the engine
fallback chain, or `executor.ts`. It proves exactly one thing: a tick resolves a
NULL-tier row against `app_settings['fleet.default_tier']` as it stands at that
moment, and the model handed to the run changes when the setting changes.

### 5.5 Cleanup

```
$ rm forge-control/tick-probe.mts
$ git status --porcelain        # (only the round-4 source changes; no probe file)
```

The scratch database `aios_tick_probe_978085a8af2f` is **left in place** so the
re-check can re-query the rows above. It is a throwaway created by this run and
holds no fleet data.

### 5.6 The probe, in full

Reproducible by pasting this back into `forge-control/tick-probe.mts` and
running `SCRATCH_URL=… PROBE_WORKSPACE=… npx tsx tick-probe.mts` from the
package. It is not committed as a file: `forge-control/tsconfig.json` would
pull a package-root `.mts` into gate 1's `tsc --noEmit`, and an acceptance
probe that needs a hand-built database is not a gate.

```ts
/**
 * ACCEPTANCE PROBE — the SCHEDULER TICK half of the runtime default tier switch.
 *
 * Runs the real, exported `projectTick()` against a SCRATCH database whose
 * schema is a replay of db/migrations/0021..0049 (plus the one documented
 * content_jobs stub). Nothing here touches content_forge: DATABASE_URL is
 * repointed BEFORE the first dynamic import, because every db module binds its
 * Pool at import time.
 *
 * No engine process starts. `projectTick()` only INSERTs a `runs` row; the
 * executor that would pick it up polls the LIVE database, which this probe
 * never opens.
 *
 * Measured, not asserted: the `runs.model` column of the row the tick created
 * for a task whose `tier` is NULL.
 */
const SCRATCH_URL = process.env.SCRATCH_URL;
if (!SCRATCH_URL) throw new Error("SCRATCH_URL is required — refusing to run against the default DATABASE_URL");
if (/\/content_forge(\?|$)/.test(SCRATCH_URL)) throw new Error("SCRATCH_URL points at content_forge — refusing");
process.env.DATABASE_URL = SCRATCH_URL;

const pg = (await import("pg")).default;
const pool = new pg.Pool({ connectionString: SCRATCH_URL });

const WORKSPACE = process.env.PROBE_WORKSPACE;
if (!WORKSPACE) throw new Error("PROBE_WORKSPACE is required");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

/** Seed one active project + one READY task carrying NO tier at all. */
async function seed(label: string): Promise<{ projectId: string; taskId: string }> {
  const [p] = await q<{ id: string }>(
    `INSERT INTO projects (name, brief, repo, base_branch, status, workspace_dir, work_branch)
     VALUES ($1, 'tick acceptance probe', 'ai-os', 'main', 'active', $2, 'project/tick-probe')
     RETURNING id::text`,
    [`tick-probe ${label}`, WORKSPACE],
  );
  const [t] = await q<{ id: string; tier: string | null }>(
    `INSERT INTO project_tasks (project_id, round, role, title, brief, status, tier, workstream, write_set)
     VALUES ($1, 0, 'builder', $2, 'probe brief', 'ready', NULL, 'main', '{}')
     RETURNING id::text, tier`,
    [p.id, `untiered probe task ${label}`],
  );
  if (t.tier !== null) throw new Error(`seed is wrong: task tier is ${t.tier}, expected NULL`);
  return { projectId: p.id, taskId: t.id };
}

async function setSetting(tier: string): Promise<string> {
  const [row] = await q<{ value: string }>(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('fleet.default_tier', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING value::text AS value`,
    [JSON.stringify(tier)],
  );
  return row.value;
}

/* The tick module is imported ONCE, after DATABASE_URL is repointed. */
const { projectTick } = await import("./src/lib/project-tick.ts");

const spawnLines: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes("[project-tick]")) spawnLines.push(line);
  realLog(...args);
};

async function measure(label: string, tier: string) {
  realLog(`\n===== ${label}: app_settings['fleet.default_tier'] = ${await setSetting(tier)} =====`);
  const { projectId, taskId } = await seed(label);
  realLog(`seeded project ${projectId} / task ${taskId} with tier = NULL (verified above)`);

  spawnLines.length = 0;
  await projectTick();

  const [row] = await q<{ tier: string | null; status: string; run_id: string | null; model: string | null; effort: string | null }>(
    `SELECT pt.tier, pt.status, pt.run_id::text,
            r.metadata->>'model'  AS model,
            r.metadata->>'effort' AS effort
       FROM project_tasks pt LEFT JOIN runs r ON r.id = pt.run_id
      WHERE pt.id = $1`,
    [taskId],
  );
  realLog(`\n--- MEASURED FROM THE SCRATCH DB (task ${taskId}) ---`);
  realLog(`  project_tasks.tier   = ${JSON.stringify(row.tier)}   (still NULL by design — the tick does not write it back)`);
  realLog(`  project_tasks.status = ${row.status}`);
  realLog(`  runs.metadata.model  = ${JSON.stringify(row.model)}   <-- the engine the untiered row actually got`)
  realLog(`  runs.metadata.effort = ${JSON.stringify(row.effort)}`);
  for (const l of spawnLines.filter((l) => l.includes(taskId))) realLog(`  LOG: ${l}`);
  return { model: row.model, runId: row.run_id, taskId };
}

const a = await measure("A — fleet default gemini", "gemini");
const b = await measure("B — flipped to junior at runtime, no restart", "junior");
const c = await measure("C — flipped back to gemini", "gemini");

realLog("\n================ VERDICT ================");
realLog(`A  runs.metadata.model = ${a.model}`);
realLog(`B  runs.metadata.model = ${b.model}`);
realLog(`C  runs.metadata.model = ${c.model}`);
const ok = a.model === "gemini-3.7-flash-high" && b.model === "claude-sonnet-5" && c.model === "gemini-3.7-flash-high";
realLog(ok ? "PASS — the tick resolved each untiered row against the setting live" : "FAIL");
await pool.end();
process.exit(ok ? 0 : 1);
```

### 5.7 Gate suite at round 4's tip

`bash scripts/checks/gates-808.sh --strict` → **29 EXECUTED, 1 RED, 5 SKIPPED-by-design**,
`GATES_EXIT=1`. Identical to round 3's reading.

Gate 9 (`dollar-sweep.sh`) went RED mid-round on a doc-comment this round added
("…chooses which model spends Konrad's money"). Reworded rather than allowlisted, per
that gate's standing rule; green again at `a5cb4df`.

The single RED is gate 5, `no-raw-colours.cjs`, and it is inherited — verified two ways:

```
$ git diff --name-only main...HEAD | grep -c WeekGrid
0
$ git show main:forge-control-web/app/desktop/goals/WeekGrid.tsx | sed -n 48p
  { bg: "#3f51b5", fg: "#ffffff" }, // blueberry
```

Gate 6 (forbidden-file diff) is GREEN: the only engine files in `main...HEAD` are
`lib/project-tick.ts` and its `.test.ts`, both covered by the operator waiver recorded
in `PLAN.md` §4 and in `gates-808.sh`. Round 4 did not touch either of them.

`pnpm test`: **2382 tests / 469 suites / 0 fail** (round 3: 2365 / 465).
`fleet-tier.test.ts`: 36/36 (round 3: 19/19).
