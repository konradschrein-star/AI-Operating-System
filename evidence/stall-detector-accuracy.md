# Evidence: Stall Detector Accuracy Transcripts

Project: `aios-stall-detector-accuracy`  
Subject: `scripts/ops/stalled-projects.sh` (live detector)  
Reference: [PLAN.md](file:///opt/ai-os/workspace/projects/30747e2a-fb40-4375-a3a6-4cc6a991ea45/PLAN.md)  
Write-set: `evidence/stall-detector-accuracy.md` (only file modified in this task)

---

## Notice: Zero Rows on Live Data (Constructed-Shape Proof Rationale)

As established on 2026-08-25 and re-measured during this verification on 2026-08-26:
- The **Item 1 query** (§"BLOCKED or PAUSED with NO OPEN WORK LEFT") returned **ZERO rows** against the live `content_forge` database (the one real historical instance, `aios-sidebar-live-sessions`, had already been recovered).
- The **Item 2 query** (§"WEDGED DESPITE SATISFIED DEPENDENCIES") returned **ZERO rows** against the live `content_forge` database (the historical `aios-guardrail-hardening` row had already shipped).

Because both queries return 0 rows on live data, a green/empty run of the script against the live database is **not evidence** that either check works. The primary proof of correctness rests on the **constructed-shape transcripts** executed against an isolated scratch database (`cf_stall_probe_evidence`), documented in Section 3 below.

All live queries in Section 2 were executed **read-only** (`SELECT` statements only) against `content_forge`. Scratch-database transcripts reflect B1's task (`8ea74ac`) and were re-verified end-to-end in this task turn.

---

## 1. Defect 0: `Q()` Before vs After (Broken Query Handling)

### Defect Mechanism
Previously, `Q()` was defined as:
```bash
Q() { psql "$DATABASE_URL" -At -F'|' -c "$1" 2>/dev/null; }
```
Caller invoked:
```bash
out=$(Q "...")
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"
```
Because `2>/dev/null` discarded stderr and `psql`'s exit code was never checked, any broken SQL query (syntax error, missing column/table) produced an empty string `out=""`. The section printed `none`, and the script exited `0` (`clear — no silently stopped projects.`). A broken detector was indistinguishable from a healthy fleet.

Furthermore, inside `out=$(Q "...")`, command substitution executes `Q()` in a subshell, so a bare `exit 2` inside `Q()` would only terminate the subshell without halting the parent script.

### 1.1 Before Fix (Old `Q()` with Broken Query)

Command:
```bash
bash -c '
Q_old() { psql "$DATABASE_URL" -At -F"|" -c "$1" 2>/dev/null; }
out=$(Q_old "select p.name from projects p where p.nonexistent_column = 1")
echo "rc=$? out=[$out]"
[ -n "$out" ] && echo rows || echo none
'
```

Output:
```
rc=1 out=[]
none
```
*Result: The query failed (`rc=1`), but the script evaluated `[ -n "$out" ]` to false, output `none`, and would continue to exit 0 (CLEAN).*

---

### 1.2 After Fix (New `Q()` with Broken Query)

The new `Q()`:
1. Captures `psql`'s exit status.
2. Allows stderr through to report database diagnostic errors.
3. Exits with code `2` (distinct from `0=clear` and `1=stalled`) so wrappers/cron cannot mistake an engine failure for a clean fleet.
4. Uses statement syntax `Q "..."` reading the global `out`.
5. Enforces a `BASH_SUBSHELL` guard that fatals if invoked inside `$( )`.

Command:
```bash
bash -c '
Q() {
  local rc
  if [ "$BASH_SUBSHELL" -ne 0 ]; then
    printf "FATAL: Q() called inside a subshell (BASH_SUBSHELL=%d) — its exit 2 cannot reach the script.\n" "$BASH_SUBSHELL" >&2
    printf "FATAL: call it as a statement -- Q \"select ...\" -- and read the global variable out.\n" >&2
    exit 2
  fi
  out=$(psql "$DATABASE_URL" -At -F"|" -c "$1"); rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "FATAL: query failed (psql rc=%d). This detector does not report CLEAN on a broken query.\n" "$rc" >&2
    printf "FATAL: the query was:\n%s\n" "$1" >&2
    exit 2
  fi
}
out=""
Q "select p.name from projects p where p.nonexistent_column = 1"
echo "unreachable"
' ; echo "exit_code=$?"
```

Output:
```
ERROR:  column p.nonexistent_column does not exist
LINE 1: select p.name from projects p where p.nonexistent_column = 1
                                            ^
FATAL: query failed (psql rc=1). This detector does not report CLEAN on a broken query.
FATAL: the query was:
select p.name from projects p where p.nonexistent_column = 1
exit_code=2
```
*Result: Database error is printed to stderr, FATAL diagnostic is emitted, and script immediately aborts with exit code 2.*

---

### 1.3 Subshell Misuse Guard

Command:
```bash
bash -c '
Q() {
  local rc
  if [ "$BASH_SUBSHELL" -ne 0 ]; then
    printf "FATAL: Q() called inside a subshell (BASH_SUBSHELL=%d) — its exit 2 cannot reach the script.\n" "$BASH_SUBSHELL" >&2
    printf "FATAL: call it as a statement -- Q \"select ...\" -- and read the global variable out.\n" >&2
    exit 2
  fi
  out=$(psql "$DATABASE_URL" -At -F"|" -c "$1"); rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "FATAL: query failed (psql rc=%d). This detector does not report CLEAN on a broken query.\n" "$rc" >&2
    printf "FATAL: the query was:\n%s\n" "$1" >&2
    exit 2
  fi
}
out=""
out=$(Q "select 1")
' ; echo "exit_code=$?"
```

Output:
```
FATAL: Q() called inside a subshell (BASH_SUBSHELL=1) — its exit 2 cannot reach the script.
FATAL: call it as a statement -- Q "select ..." -- and read the global variable out.
exit_code=2
```
*Result: Calling `out=$(Q ...)` immediately triggers the subshell trap with exit code 2.*

---

## 2. Item 1: Live Database `HAVING` Term Relaxations (Read-Only)

Executed against `content_forge` (`DATABASE_URL`). Read-only `SELECT` statements only.

### 2.1 Full Query as Briefed (Negative Control)

Command:
```bash
psql "$DATABASE_URL" -At -F'|' -c "select p.name, p.status,
         count(*) filter (where t.status='failed') as failed,
         count(*) filter (where t.status='done') as done
  from projects p join project_tasks t on t.project_id = p.id
  where p.status in ('blocked','paused')
  group by p.id, p.name, p.status
  having count(*) filter (where t.status in ('pending','ready','running')) = 0
     and count(*) filter (where t.status='failed') > 0
     and count(*) filter (where t.status='done') > 0
  order by p.name;"
```

Output:
```
(0 rows returned, exit code 0)
```

---

### 2.2 Relaxation A: Drop `count(*) filter (where t.status='done') > 0`

Tests what happens if we do not require completed work: detects failed starts.

Command:
```bash
psql "$DATABASE_URL" -At -F'|' -c "select p.name, p.status,
         count(*) filter (where t.status='failed') as failed,
         count(*) filter (where t.status='done') as done
  from projects p join project_tasks t on t.project_id = p.id
  where p.status in ('blocked','paused')
  group by p.id, p.name, p.status
  having count(*) filter (where t.status in ('pending','ready','running')) = 0
     and count(*) filter (where t.status='failed') > 0
  order by p.name;"
```

Output:
```
smoke-test|paused|1|0
```
*Count: Exactly 1 row (`smoke-test|paused|1|0`). A project that never finished a task failed to start, which is a setup issue rather than an in-flight stall.*

---

### 2.3 Relaxation B: Drop `count(*) filter (where t.status='failed') > 0`

Tests what happens if we do not require failed work: detects clean deliberate pauses.

Command:
```bash
psql "$DATABASE_URL" -At -F'|' -c "select p.name, p.status,
         count(*) filter (where t.status='failed') as failed,
         count(*) filter (where t.status='done') as done
  from projects p join project_tasks t on t.project_id = p.id
  where p.status in ('blocked','paused')
  group by p.id, p.name, p.status
  having count(*) filter (where t.status in ('pending','ready','running')) = 0
     and count(*) filter (where t.status='done') > 0
  order by p.name;"
```

Output:
```
connect-clis-from-settings|paused|0|4
```
*Count: Exactly 1 row (`connect-clis-from-settings|paused|0|4`). Four tasks done, 0 failed, 0 open — a clean pause is an operator decision, not a stall.*

---

## 3. Scratch-Database Constructed Shape Transcripts (Items 1 & 2)

Quoted from B1 (`8ea74ac`) and re-executed end-to-end against a dedicated scratch database (`cf_stall_probe_evidence`) via `STALLED_PROJECTS_DB_URL`.

### 3.1 Setup Script

```bash
SCRATCH="cf_stall_probe_evidence"
docker exec content-forge-postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"$SCRATCH\";"
docker exec content-forge-postgres psql -U postgres -d postgres -c "CREATE DATABASE \"$SCRATCH\";"
docker exec content-forge-postgres pg_dump -U postgres -s -t projects -t project_tasks -t runs content_forge > /tmp/stall_schema.sql
docker exec -i content-forge-postgres psql -U postgres -d "$SCRATCH" -f - < /tmp/stall_schema.sql

SCRATCH_URL="${DATABASE_URL%/content_forge}/$SCRATCH"

psql "$SCRATCH_URL" << 'EOF'
-- Item 1: scratch-dead-blocked (blocked, 1 failed, 2 done, 0 open)
INSERT INTO projects (id, name, brief, repo, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'scratch-dead-blocked', 'test', 'ai-os', 'blocked');

INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, updated_at) VALUES
('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111111', 0, 'planner', 't0', 'b0', 'done', now()),
('11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111111', 1, 'builder', 't1', 'b1', 'done', now()),
('11111111-1111-1111-1111-111111111103', '11111111-1111-1111-1111-111111111111', 2, 'reviewer', 't2', 'b2', 'failed', now());

-- Item 2 Shape 1: scratch-held (active, round 20 deploy frozen+pending, round 10 task pending)
-- MUST BE EXCLUDED from wedged report (engine is holding it while round 10 drains)
INSERT INTO projects (id, name, brief, repo, status)
VALUES ('22222222-2222-2222-2222-222222222222', 'scratch-held', 'test', 'ai-os', 'active');

INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, graph_frozen, updated_at) VALUES
('22222222-2222-2222-2222-222222222201', '22222222-2222-2222-2222-222222222222', 0, 'planner', 'plan', 'b', 'done', '{}', false, now()),
('22222222-2222-2222-2222-222222222202', '22222222-2222-2222-2222-222222222222', 10, 'reviewer', 'rev', 'b', 'pending', '{}', false, now()),
('22222222-2222-2222-2222-222222222203', '22222222-2222-2222-2222-222222222222', 20, 'builder', 'deploy: ship project', 'b', 'pending', '{"22222222-2222-2222-2222-222222222201"}', true, now() - interval '30 minutes');

-- Item 2 Shape 2: scratch-wedged-failed (active, round 20 deploy frozen+pending, round 10 task failed)
-- MUST BE REPORTED in wedged report (permanently blocked behind a failed task)
INSERT INTO projects (id, name, brief, repo, status)
VALUES ('33333333-3333-3333-3333-333333333333', 'scratch-wedged-failed', 'test', 'ai-os', 'active');

INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, graph_frozen, updated_at) VALUES
('33333333-3333-3333-3333-333333333301', '33333333-3333-3333-3333-333333333333', 0, 'planner', 'plan', 'b', 'done', '{}', false, now()),
('33333333-3333-3333-3333-333333333302', '33333333-3333-3333-3333-333333333333', 10, 'reviewer', 'rev', 'b', 'failed', '{}', false, now()),
('33333333-3333-3333-3333-333333333303', '33333333-3333-3333-3333-333333333333', 20, 'builder', 'deploy: ship project', 'b', 'pending', '{"33333333-3333-3333-3333-333333333301"}', true, now() - interval '30 minutes');

-- Item 2 Shape 3: scratch-wedged-terminal (active, round 20 deploy frozen+pending, round 10 task cancelled)
-- MUST BE REPORTED in wedged report (lower rounds all terminal, deploy still not advancing)
INSERT INTO projects (id, name, brief, repo, status)
VALUES ('44444444-4444-4444-4444-444444444444', 'scratch-wedged-terminal', 'test', 'ai-os', 'active');

INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, graph_frozen, updated_at) VALUES
('44444444-4444-4444-4444-444444444401', '44444444-4444-4444-4444-444444444444', 0, 'planner', 'plan', 'b', 'done', '{}', false, now()),
('44444444-4444-4444-4444-444444444402', '44444444-4444-4444-4444-444444444444', 10, 'reviewer', 'rev', 'b', 'cancelled', '{}', false, now()),
('44444444-4444-4444-4444-444444444403', '44444444-4444-4444-4444-444444444444', 20, 'builder', 'deploy: ship project', 'b', 'pending', '{"44444444-4444-4444-4444-444444444401"}', true, now() - interval '30 minutes');
EOF
```

---

### 3.2 Scratch Execution Output

Command:
```bash
SCRATCH="cf_stall_probe_evidence"
SCRATCH_URL="${DATABASE_URL%/content_forge}/$SCRATCH"
STALLED_PROJECTS_DB_URL="$SCRATCH_URL" ./scripts/ops/stalled-projects.sh; echo "exit_code=$?"
```

Output:
```
NOTE: using STALLED_PROJECTS_DB_URL — this is NOT the fleet database.

== BLOCKED or PAUSED while holding open work ==
none

== BLOCKED or PAUSED with NO OPEN WORK LEFT — dead, and invisible twice ==
scratch-dead-blocked|blocked|1|2

== WEDGED BY POSITION — a non-done row below the lowest open round ==
scratch-wedged-failed|10|failed|rev

== WEDGED DESPITE SATISFIED DEPENDENCIES — could run, has not ==
scratch-wedged-failed|main|20|deploy: ship project|30m stale
scratch-wedged-terminal|main|20|deploy: ship project|30m stale

== LEGACY BARRIER — a depends_on IS NULL row holding back the graph ==
none

== ZOMBIE — task says running, its run is over ==
none

== TWO LIVE SESSIONS IN ONE WORKTREE — contention inside a lane ==
none

== FAILED task with a pending successor — nothing will retry it ==
scratch-wedged-failed|10|rev

== CLOSED PROJECT STILL HOLDING OPEN WORK — the status is a claim, not a fact ==
none

== ACTIVE, work queued, but NOTHING running and nothing started recently ==
none

STALLED — see above. A stopped project does not report; that is the whole point of this check.
exit_code=1
```

### Analysis of Scratch Results
1. **Item 1:** §"BLOCKED or PAUSED with NO OPEN WORK LEFT" successfully catches `scratch-dead-blocked|blocked|1|2`.
2. **Item 2 Exclusion (Held):** `scratch-held` is **absent** from §"WEDGED DESPITE SATISFIED DEPENDENCIES" because its lower round 10 is `pending` (live work draining).
3. **Item 2 Control (Wedged behind Failed):** `scratch-wedged-failed` is **present** in §"WEDGED DESPITE SATISFIED DEPENDENCIES" because `failed` is not in `('pending','ready','running')`. This proves the ruling in [PLAN.md](file:///opt/ai-os/workspace/projects/30747e2a-fb40-4375-a3a6-4cc6a991ea45/PLAN.md) — `stillOpen()` would have incorrectly suppressed this row.
4. **Item 2 Terminal:** `scratch-wedged-terminal` is **present** because lower rounds are terminal (`cancelled`), but round 20 deploy has not moved.

---

## 4. Full Live Run of Finished Script

Executed directly in the worktree against the live fleet database (`DATABASE_URL`).

Command:
```bash
./scripts/ops/stalled-projects.sh; echo "exit_code=$?"
```

Output:
```
== BLOCKED or PAUSED while holding open work ==
zz-tierpin-verify|paused|1

== BLOCKED or PAUSED with NO OPEN WORK LEFT — dead, and invisible twice ==
none

== WEDGED BY POSITION — a non-done row below the lowest open round ==
none

== WEDGED DESPITE SATISFIED DEPENDENCIES — could run, has not ==
none

== LEGACY BARRIER — a depends_on IS NULL row holding back the graph ==
none

== ZOMBIE — task says running, its run is over ==
none

== TWO LIVE SESSIONS IN ONE WORKTREE — contention inside a lane ==
aios-stall-detector-accuracy|main|2|builder

== FAILED task with a pending successor — nothing will retry it ==
none

== CLOSED PROJECT STILL HOLDING OPEN WORK — the status is a claim, not a fact ==
none

== ACTIVE, work queued, but NOTHING running and nothing started recently ==
none

STALLED — see above. A stopped project does not report; that is the whole point of this check.
exit_code=1
```

### Explanation of Live Findings
- `zz-tierpin-verify|paused|1`: Documented permanent noise in this detector.
- `aios-stall-detector-accuracy|main|2|builder`: Sibling concurrency in the active workstream during execution.
- §"BLOCKED or PAUSED with NO OPEN WORK LEFT": `none` (as expected on live data; proven via scratch DB).
- §"WEDGED DESPITE SATISFIED DEPENDENCIES": `none` (as expected on live data; proven via scratch DB).
