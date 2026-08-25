# T3 — why does `last_heartbeat_at` go stale past 90s?

Round 0, `aios-stuck-run-is-not-a-failed-task`. This task **measures**; it does
not tune `HEARTBEAT_STUCK_THRESHOLD_MS` or `max=5`, and it changes nothing in
`forge-control/`. All queries in §1 are read-only against `content_forge`. §2 is
a throwaway database, named and left in place below. Isolation is asserted and
pasted at the end of §2.

Known/verified going in (PLAN.md §1, not re-derived): single fork-mode
`forge-executor` process; `heartbeat()` interval is 5s per in-flight run
(`executor.ts:857`); `stuckWatchdogTick()` and `projectTick()` share that one
event loop and one `pg` pool with `max=5` (`forge-control/src/db/ai_os.ts:19-24`);
guardrail `agent.spawn_cap` = 10; zero heartbeat errors and zero pool errors in
the retained log window; worst single loss run `f874ba1b` (132 turns, stuck,
124847 bytes of thread — see below).

---

## 1. Live, read-only measurement against `content_forge`

Connection used throughout this section (read-only, no writes):
```
postgresql://postgres:***@127.0.0.1:5432/content_forge
```

### 1.1 How big does `runs.thread` actually get?

```sql
SELECT id, jsonb_array_length(thread) AS turns, pg_column_size(thread) AS bytes
FROM runs ORDER BY pg_column_size(thread) DESC LIMIT 15;
```
```
                  id                  | turns | bytes  
--------------------------------------+-------+--------
 11dd264b-f173-44d7-ada4-f1eb39fb4abd |  2477 | 896547
 a86cf7b3-9283-4315-a389-ab60bd2ea4df |  1991 | 819692
 ece63bdb-884c-4d2c-9680-deca13cf2dda |  1911 | 807850
 2ef126b7-d6d9-4a55-a8e7-d9acf0508645 |  1491 | 644728
 6528014e-c026-4e68-ae6d-0ed02bde6e59 |  1134 | 519002
 e21f52b4-77b0-416b-8892-c83578715b90 |   923 | 485382
 765e56ad-6c68-4d23-854d-5ea539b39d0c |  1067 | 465831
 3f03be16-436f-4adc-ba7f-90e661a7cda7 |   990 | 430511
 be190829-f869-4d26-910f-fb9395b89274 |   864 | 308855
 2ba5db07-f7ff-4ac6-b771-a4f65782dffc |   613 | 298196
 bfd1283a-b71b-4f35-b577-7d09aad803f2 |   489 | 272731
 2d39402f-450e-428e-b9b6-acb25fa0b11e |   490 | 253145
 3c75b171-59cf-4831-8362-41cb1d5dc6e1 |   605 | 250476
 d67f29bc-e710-478c-80ed-3b82787bfd21 |   465 | 230425
 683d2fd6-cccc-42e2-8fa4-6a319f359168 |   475 | 208947
(15 rows)
```

Same query restricted to `status='stuck'` (the population that matters for
this project):
```sql
SELECT id, status, jsonb_array_length(thread) AS turns, pg_column_size(thread) AS bytes
FROM runs WHERE status='stuck' ORDER BY pg_column_size(thread) DESC LIMIT 15;
```
```
                  id                  | status | turns | bytes  
--------------------------------------+--------+-------+--------
 2ef126b7-d6d9-4a55-a8e7-d9acf0508645 | stuck  |  1491 | 644728
 e21f52b4-77b0-416b-8892-c83578715b90 | stuck  |   923 | 485382
 3f03be16-436f-4adc-ba7f-90e661a7cda7 | stuck  |   990 | 430511
 bfff5e4e-3220-4e86-b98a-8db95840dab1 | stuck  |   336 | 152814
 cc62a6ae-0c8d-4862-bfe7-81f9ff7eafb6 | stuck  |   310 | 143968
 f874ba1b-55f1-4370-8aba-1e2589a56da9 | stuck  |   280 | 124847
 104a85c9-8323-45eb-be92-6b3afa1f1b6e | stuck  |   235 | 113288
 6d8523eb-bae8-4de7-ac18-c87849721309 | stuck  |   248 | 104921
 d519f8ed-ddaa-4e86-922c-b4cd0c436e44 | stuck  |   195 |  90978
 9a515505-ee4d-4455-a361-74e015dfecbf | stuck  |   193 |  89667
 445fa13d-72fe-4e48-9b74-4102d4dcf781 | stuck  |   188 |  80662
 e9d18c6a-e98b-45b8-b242-37566b4fa5dd | stuck  |   198 |  79839
 bcf70624-480b-42dd-98c3-787ee681e4c5 | stuck  |   150 |  78882
 26d1108c-fc9f-4631-b1ab-265ab36ba552 | stuck  |   131 |  67851
 ff229a99-14e2-4ce0-bf3d-cac67edccdc9 | stuck  |   119 |  62120
(15 rows)
```

Percentiles over the `stuck` population, used as the seed sizes for the
microbenchmark:
```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pg_column_size(thread)) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY pg_column_size(thread)) AS p95,
       max(pg_column_size(thread)) AS max
FROM runs WHERE status='stuck';
```
```
  p50  |        p95        |  max   
-------+-------------------+--------
 51953 | 446972.2999999998 | 644728
```

**p50 ≈ 52 KB, p95 ≈ 447 KB, max observed 645 KB (turn `2ef126b7`, 1491 turns).**
Even the worst single row is well inside "large JSONB" territory but nowhere
near pathological (multi-MB) — Postgres TOASTs anything over ~2 KB, so every row
in the p50+ range is already going through TOAST on every append.

### 1.2 Is `thread || …` rewriting the whole TOASTed value on every append?

Yes, structurally: Postgres has no in-place JSONB patch. `thread = thread ||
$2::jsonb` reads the current value (detoasting/decompressing it if TOASTed),
concatenates in memory, and writes the **entire new value** back, re-TOASTing
it. At p95 (447 KB) that is ~447 KB decompressed, concatenated, recompressed,
and rewritten **per append**, and `appendThreadEntry` fires on every streamed
engine event — potentially many times per second during active generation.
This is real, measurable cost; §2 quantifies it instead of asserting it.

TOAST table sizes:
```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
FROM pg_class WHERE relname LIKE 'pg_toast%' ORDER BY pg_total_relation_size(oid) DESC LIMIT 5;
```
```
       relname        | pg_size_pretty 
----------------------+----------------
 pg_toast_48024       | 124 MB
 pg_toast_27738       | 54 MB
 pg_toast_28465       | 17 MB
 pg_toast_48024_index | 12 MB
 pg_toast_69737       | 8608 kB
```
`pg_toast_48024` is `runs`'s own TOAST table:
```sql
SELECT reltoastrelid::regclass AS toast_table, pg_total_relation_size('runs') AS runs_total
FROM pg_class WHERE relname='runs';
```
```
       toast_table       | runs_total 
-------------------------+------------
 pg_toast.pg_toast_48024 |  184 MB (total, table+toast+indexes)
```
124 MB of that 184 MB is TOAST — confirms `thread` is the dominant contributor
to `runs`'s on-disk footprint, consistent with frequent large-JSONB rewrites.

### 1.3 `pg_stat_activity` and `pg_stat_statements`

Three samples, 2s apart:
```sql
SELECT count(*), state, wait_event_type, wait_event
FROM pg_stat_activity WHERE datname='content_forge' GROUP BY 2,3,4;
```
```
sample 1:  26 idle (Client/ClientRead) + 1 active
sample 2:  25 idle (Client/ClientRead) + 1 active
sample 3:  25 idle (Client/ClientRead) + 1 active
```
No lock waits, no `IO`/`Lock` wait_event_type in any sample — at these three
points in time the box was not saturated. This is a point-in-time snapshot, not
a historical trace; it cannot rule out a transient spike that happened between
samples, only say that *steady state* is quiet.

Breakdown by `application_name`:
```sql
SELECT application_name, count(*) FROM pg_stat_activity WHERE datname='content_forge' GROUP BY 1;
```
```
 application_name | count 
------------------+-------
 postgres.js      |    16   -- a DIFFERENT client library (content-forge's own workers), not forge-control's `pg` Pool
                   |    10   -- unlabeled: node-postgres (`pg`) does not set application_name by default; this is forge-control's share
 psql              |     1   -- this measurement session
```
`max_connections = 100`. So even though `pg pool max=5` is the number under
test, the DATABASE itself is shared with content-forge's separate worker fleet
(`postgres.js` client) — 26 total connections against 100 max, no global
exhaustion visible.

`pg_stat_statements` is **not installed**:
```sql
SELECT extname FROM pg_extension WHERE extname='pg_stat_statements';
-- (0 rows)
```
So there is no historical per-query latency percentile to pull for the actual
`last_heartbeat_at` UPDATE; the microbenchmark in §2 is the only percentile
data this document has.

### 1.4 Concurrency at flip time — reconstructed, with a stated flaw

`runs` has no historical status log, so "how many other runs were `running` at
flip time" is reconstructed from `started_at`/`completed_at`, using the flipped
row's own `updated_at` as the flip timestamp (the watchdog's UPDATE sets
`updated_at = now()` alongside `status='stuck'` — `executor.ts:1518-1529`).

**First attempt — naive, and wrong in a way worth showing rather than hiding:**
```sql
WITH stuck AS (SELECT id, updated_at AS flip_at FROM runs WHERE status='stuck')
SELECT s.id, s.flip_at,
  (SELECT count(*) FROM runs r WHERE r.id <> s.id AND r.started_at <= s.flip_at
     AND (r.completed_at IS NULL OR r.completed_at > s.flip_at)) AS overlapping_runs
FROM stuck s ORDER BY overlapping_runs DESC LIMIT 5;
```
```
                  id                  |            flip_at            | overlapping_runs 
--------------------------------------+--------------------------------+------------------
 e21f52b4-77b0-416b-8892-c83578715b90 | 2026-08-25 10:21:01.930573+00 |               42
 822eba27-3bae-46c3-b4d6-ddbca84c54a2 | 2026-08-25 10:16:38.143268+00 |               42
 6c2e0502-7f1a-4f4c-85ca-a17589365118 | 2026-08-25 10:05:27.126801+00 |               41
```
42 "concurrent" runs is more than 4× the `agent.spawn_cap` of 10 — implausible
on its face. The reason: `completed_at IS NULL` is true forever for the 35 rows
that are themselves `stuck` (they never reach a terminal state), so every
already-broken row counts as "still running" against every later flip,
compounding without bound. **This number is an artifact of the very bug being
measured, not a concurrency measurement.**

**Corrected — restrict "other" to runs that reached an actual terminal status
(`completed`/`failed`/`cancelled`) and were genuinely open across the flip
instant:**
```sql
WITH stuck AS (SELECT id, updated_at AS flip_at FROM runs WHERE status='stuck')
SELECT s.id, s.flip_at,
  (SELECT count(*) FROM runs r
     WHERE r.id <> s.id AND r.status IN ('completed','failed','cancelled')
       AND r.started_at <= s.flip_at AND r.completed_at > s.flip_at) AS terminal_overlap
FROM stuck s ORDER BY terminal_overlap DESC LIMIT 20;
```
```
                  id                  |            flip_at            | terminal_overlap 
--------------------------------------+--------------------------------+------------------
 3cc4908e-ae71-404d-966a-3db17c6d9848 | 2026-08-23 09:59:11.71861+00  |               13
 6d8523eb-bae8-4de7-ac18-c87849721309 | 2026-08-23 17:40:31.389489+00 |                5
 bfff5e4e-3220-4e86-b98a-8db95840dab1 | 2026-08-23 17:47:14.839186+00 |                5
 2736499f-14fe-41cc-b025-4cb53ea955e0 | 2026-08-25 06:16:07.296358+00 |                3
 ff229a99-14e2-4ce0-bf3d-cac67edccdc9 | 2026-08-25 06:19:13.554959+00 |                1
 (14 of the 20 rows shown: 0)
```
The corrected count tops out at **13** (once, at 09:59:11 on 08-23) and is
**0 for 14 of the 20 highest-overlap flips**. This is a *lower* bound (it
excludes other runs that were themselves concurrently `running`/`stuck` at the
moment, which the data cannot distinguish after the fact), while the naive
count is an *upper* bound inflated by zombie rows. **Truth is bracketed between
0–13 (corrected, most flips) and 42 (naive, contaminated) — closer to the low
end, since the naive number's inflation mechanism is understood and explains
itself.** Either way, most individual flips were not obviously coincident with
heavy concurrency; a handful were.

---

## 2. Reproducible microbenchmark — throwaway database, never `content_forge`

**Database used:** `cf_stuck_hb_probe_da13f2406f8e` (created this run inside
the `content-forge-postgres` container's Postgres instance — a sibling
database, not `content_forge`). Schema loaded via
`pg_dump -U postgres -s -t runs content_forge` (schema-only, read-only against
live) into that database; the two `gin_trgm_ops` index errors during load are
the same benign, already-documented artifact as every prior scratch-DB probe
in this repo (the extension isn't installed in the dump target — harmless for
a table that never receives a trigram query in this probe).

**Script:** `docs/plan/evidence/heartbeat-latency-probe.mts`, modelled on
`docs/plan/evidence/r860-dryrun.mts` (same `createRequire('pg')` resolution
trick, same "refuse without `DRYRUN_DATABASE_URL`" gate). It additionally
refuses if the URL ends in `/content_forge`. Negative-path proof, both refused
with exit 1 before touching any connection:
```
$ env -u DRYRUN_DATABASE_URL npx tsx heartbeat-latency-probe.mts
Error: DRYRUN_DATABASE_URL is not set — point it at a THROWAWAY database, never content_forge

$ DRYRUN_DATABASE_URL=postgresql://…/content_forge npx tsx heartbeat-latency-probe.mts
Error: DRYRUN_DATABASE_URL ends in /content_forge — refusing to run against the live database: postgresql://…/content_forge
```

**Design.** A `pg.Pool` with `max=5` (the exact value under test). For each
`N ∈ {1, 5, 10, 20}`: seed `N` rows with realistic thread payloads (alternating
the measured p50 = 51953 B and p95 = 446972 B sizes from §1.1, `N=1` uses p95
— the single worst-case row is the common real report), then run `N` workers
in a tight loop against the **exact production SQL**
(`thread = thread || $2::jsonb`, copied verbatim from `executor.ts:658-664`)
for a 30s window, while one extra worker fires the **exact production heartbeat
SQL** (`UPDATE runs SET last_heartbeat_at = now() WHERE id = $1 AND status =
'running'`, verbatim from `executor.ts:732`) every 5000ms against its own
separate row, timing wall-clock from "the interval fired" to "the UPDATE
resolved" with `performance.now()`.

Seed content is `randomBytes(...).toString("hex")`, not repeated characters —
a first attempt padded with `"x".repeat(340)` and TOAST's `pglz` compression
crushed the intended 446972-byte target down to an 11278-byte on-disk column
(`pg_column_size` measures stored, possibly-compressed size). Random hex is
close to incompressible, and the corrected seed lands within ~3% of target:
```
N=1 seed: targetBytes=446972 actualBytes=459256
N=5 seed: targetBytes=51953  actualBytes=53902   (and 446972 → 459256 alternating)
```
This is a conservative/pessimistic proxy: real conversational JSON has *some*
redundancy random hex does not, so this seed's TOAST/decompress cost is an
upper bound on the real cost at the same byte count, not an exact reproduction.

**Results** (heartbeat UPDATE latency, ms, interval-fired → UPDATE resolved,
6 samples per level = 30s / 5000ms):
```
N=1:  p50=4.9ms   p95=21.2ms   max=21.2ms   samples=6
N=5:  p50=24.1ms  p95=84.7ms   max=84.7ms   samples=6
N=10: p50=103.9ms p95=946.8ms  max=946.8ms  samples=6
N=20: p50=258.0ms p95=913.4ms  max=913.4ms  samples=6
```
Zero append errors, zero heartbeat errors at every level. Full raw JSON output
(seed reports, per-level) is in the run log this document was written from;
the numbers above are the complete summary block the script itself prints.

**Isolation, asserted and pasted:**
```sql
-- on content_forge, the LIVE database, never written by this task:
SELECT count(*) FROM runs WHERE title = 'heartbeat-probe';
```
```
 count 
-------
     0
```
The scratch database `cf_stuck_hb_probe_da13f2406f8e` is left in place for the
reviewer to re-inspect, per the brief — dropping it is a destructive verb this
task does not need.

---

## 3. The verdict

**Pool saturation on `max=5` alone does not explain a >90000ms gap.** Even at
`N=20` — double the `agent.spawn_cap` of 10, and far above the §1.4 concurrency
reconstruction's observed range (0–13, mostly 0, at actual flip moments) — the
worst heartbeat latency measured was **946.8ms**, about **1/95th** of the
90000ms threshold, and every level's p50 stayed under 260ms. The `thread ||`
append pattern is real, measurable cost (§1.2's TOAST-rewrite argument holds,
and larger seeds do move latency up with N, visibly), but the magnitude is two
orders of magnitude short of what would be needed to single-handedly produce
the flips this project exists to fix. Extrapolating the N=10→N=20 slope
(~+90ms p50 per +10 workers) would need roughly N≈9000 concurrent appenders to
reach 90s by this mechanism alone — nowhere near anything this fleet's
guardrails permit.

Combined with §1.3 (zero pool/lock waits in three live samples, no historical
percentile data because `pg_stat_statements` is absent) and §1.4 (most flips
show low-to-zero reconstructed concurrency), the evidence does not support
"the pg pool queues heartbeats behind large JSONB appends for 90+ seconds" as
the mechanism. **The measurement does not support that conclusion — say so
plainly rather than assume it, per the brief's evidence standard.**

**What to measure next**, in order of plausibility given what this task ruled
out:
1. **The executor's own event loop, not the pool.** `stuckWatchdogTick()`'s
   liveness walk (`readEngineCmdlines()`, `forge-control/src/lib/run-liveness.ts:66-93`)
   does a **serial** `for` loop of `await readFile('/proc/<pid>/cmdline')` over
   every PID on the box — measured at **749** PIDs on this host right now. Each
   read yields the event loop individually (it's `fs/promises`, not sync), so
   it cannot single-handedly *block* for 90s, but 749 sequential awaited
   syscalls under I/O pressure is real added latency this task did not
   quantify — instrument it with `performance.now()` bracketing the call.
2. **Node GC pauses.** Threads up to 645 KB, held in-memory as parsed JS
   objects (not just JSONB on the Postgres side) inside a single Node process
   handling every in-flight run's `thread` at once, are exactly the shape that
   produces old-generation GC pauses. Run with `--trace-gc` (or attach a GC
   observer) during a live incident window and correlate pause duration against
   `stuck_signal='heartbeat_stale'` timestamps.
3. **Host-level CPU/IO contention.** This VPS runs `forge-executor` alongside
   Docker containers for `content-forge`, other Postgres instances
   (`tps-postgres`, `tl-postgres`, `axtrelis-postgres-1`, `fleet-postgres-1`
   were all running alongside `content-forge-postgres` during this
   measurement), and whatever else pm2 supervises. `vmstat`/`pidstat` sampled
   across a live flip window, correlated against the flip timestamp, would
   show whether the *executor process itself* was starved of CPU rather than
   stalling on its own work.
4. **A genuine, if rarer, transient network stall** between the executor host
   and Postgres — the brief's "zero pool errors" observation only rules out
   *failed* connections, not slow-but-successful ones outside a pool-exhaustion
   pattern; nothing in this task's tooling can distinguish that from (1)–(3)
   without a live incident to catch in the act.

None of 1–4 is assumed here; they are what remains once the leading hypothesis
this task was built to test has been measured and found insufficient on its
own to explain the gap.
