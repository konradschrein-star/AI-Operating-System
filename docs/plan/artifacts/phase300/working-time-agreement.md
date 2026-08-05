# Working-time agreement: JS core vs SQL fragment (round 303, U5)

Proof that `workingTimeFromTimestamps()` and `WORKING_MS_SQL` in
`forge-control/src/routes/working-time.ts` compute the **same number**, run over the
same real data: all 20 `runs` rows of project `8ea0cc08-28d9-4301-9f28-c98e1c5d6838`
(this project's own architect/planner/builder/reviewer/scout fleet).

Measured 2026-08-05 ~14:10 UTC. The two running rows kept appending to their threads
during the session, so their absolute numbers are a moving target — the *agreement*
is what this artifact asserts, and both paths were read from the same query for the
table below.

## How it was produced

1. `WORKING_MS_SQL` is exported by the module, not retyped: the query was emitted by
   importing the constant, so the fragment tested here is byte-identical to the one
   round 305 will ship.
   ```
   cd forge-control && ./node_modules/.bin/tsx /tmp/emit-agree-sql.ts > /tmp/agree.sql
   psql "$DATABASE_URL" -tA -f /tmp/agree.sql > /tmp/agree.json   # sql_working_ms + the raw ts array per run
   ./node_modules/.bin/tsx /tmp/agree.ts                          # JS core over the same ts arrays; exit 1 on any Δ
   ```
2. Both sides compute the **entry-gap sum only**. The running-node extension
   (`min(now − last_ts, CAP)`) is deliberately not in the SQL — it needs `now`, which
   belongs on the node side where the frozen/live decision is already made. It is
   applied by `workingMsRunningExtension()` and shown separately below.

## Per-run table

| run | role | status | entries | JS working_ms | SQL working_ms | Δ | skipped ts | wall_ms | working/wall |
|---|---|---|---|---|---|---|---|---|---|
| `3853c154` | architect | completed | 285 | 949813 (15m 50s) | 949813 | **0** | 0 | 949322 (15m 49s) | 100.1% |
| `6eeec7bf` | planner | completed | 117 | 505878 (8m 26s) | 505878 | **0** | 0 | 506150 (8m 26s) | 99.9% |
| `51694164` | builder | completed | 125 | 491867 (8m 12s) | 491867 | **0** | 0 | 491422 (8m 11s) | 100.1% |
| `b4d241ea` | builder | completed | 212 | 1377843 (22m 58s) | 1377843 | **0** | 0 | 1377198 (22m 57s) | 100.0% |
| `3d26461f` | reviewer | completed | 149 | 876916 (14m 37s) | 876916 | **0** | 0 | 876756 (14m 37s) | 100.0% |
| `20bb47eb` | planner | completed | 60 | 345906 (5m 46s) | 345906 | **0** | 0 | 344840 (5m 45s) | 100.3% |
| `fdc1eacf` | builder | completed | 86 | 271649 (4m 32s) | 271649 | **0** | 0 | 276232 (4m 36s) | 98.3% |
| `9a937009` | builder | completed | 208 | 1193619 (19m 54s) | 1193619 | **0** | 0 | 1319600 (22m 00s) | 90.5% |
| `1110e146` | reviewer | completed | 151 | 794368 (13m 14s) | 794368 | **0** | 0 | 798381 (13m 18s) | 99.5% |
| `ab331865` | architect | completed | 273 | 662324 (11m 02s) | 662324 | **0** | 0 | 812689 (13m 33s) | 81.5% |
| `0ed80848` | scout | completed | 70 | 200336 (3m 20s) | 200336 | **0** | 0 | 199459 (3m 19s) | 100.4% |
| `2c535643` | planner | completed | 100 | 612979 (10m 13s) | 612979 | **0** | 0 | 612093 (10m 12s) | 100.1% |
| `a59d2cf8` | builder | failed | 37 | 92530 (1m 33s) | 92530 | **0** | 0 | 91242 (1m 31s) | 101.4% |
| `5f359463` | builder | completed | 178 | 822057 (13m 42s) | 822057 | **0** | 0 | 821345 (13m 41s) | 100.1% |
| `03e54ad6` | builder | failed | 2 | 1457 (0m 01s) | 1457 | **0** | 0 | 27 (0m 00s) | 5396.3% |
| `0faca9b9` | builder | completed | 111 | 593747 (9m 54s) | 593747 | **0** | 0 | 592945 (9m 53s) | 100.1% |
| `8e036e52` | builder | completed | 93 | 233554 (3m 54s) | 233554 | **0** | 0 | 238294 (3m 58s) | 98.0% |
| `2598ec14` | builder | running | 58 | 322209 (5m 22s) | 322209 | **0** | 0 | 321771 (5m 22s) | 100.1% |
| `9d6c0782` | builder | completed | 103 | 299928 (5m 00s) | 299928 | **0** | 0 | 299899 (5m 00s) | 100.0% |
| `01b820d1` | builder | running | 91 | 319868 (5m 20s) | 319868 | **0** | 0 | 319429 (5m 19s) | 100.1% |

```
rows: 20   mismatches: 0   skipped timestamps: 0 across all 20 threads   running rows: 2
running 2598ec14: last ts 2026-08-05T14:09:41.100Z → running extension 11665 ms (node side, not SQL)
running 01b820d1: last ts 2026-08-05T14:09:38.775Z → running extension 13990 ms (node side, not SQL)
```

**Δ = 0 on every row.** The check script's exit code is the gate: `/tmp/agree.ts`
exits 1 on any non-zero Δ, and it exited 0.

## The honest observation: on these runs the cap barely earns its keep

`working_ms ≈ wall_ms` for almost every row — 16 of 20 sit between 98% and 101%.
These are builder/reviewer/architect sessions launched by the engine: they start
working immediately, emit a tool event every few seconds, and stop when they are
done. There is no queue wait inside the run, no human to wait for, nothing to idle
on. For this population the cap is nearly a no-op, and `working_ms` is close enough
to wall-clock that a reader could mistake one for the other.

That is not an argument against the cap; it is the population being unrepresentative.
The cap exists for the rows that are **not** in this table:

- **operator chats** — Konrad sends a message, the operator answers, and then hours
  pass before the next message. Wall-clock says "9 hours"; the truth is a few minutes
  of work. Those runs live outside a `project_id`, which is exactly why none of them
  appear above.
- **queue waits and stuck runs** — a run created at 06:00 and picked up at 06:40
  has 40 idle minutes inside `started_at → completed_at`.

Two rows here do show the cap working, and they are the reason the model says
"over-cap → 0" rather than "over-cap → CAP":

- `ab331865` (architect) — 81.5% of wall. ~2.5 minutes of real silence.
- `9a937009` (builder) — 90.5% of wall. ~2 minutes discarded.

One row is a caution about `wall_ms`, not about `working_ms`:

- `03e54ad6` — a builder that failed after 2 thread entries. `completed_at −
  started_at` = **27 ms**, while its two thread stamps are 1457 ms apart. Wall time
  is not a superset of working time when the run's lifecycle stamps and its thread
  stamps are written by different code paths. `working_ms` is derived from the thread
  alone and is unaffected; any UI that renders "working / wall" as a percentage must
  tolerate values above 100%.

## Two divergences found and resolved

### 1. `least(gap, CAP)` credits idle time — fixed with `CASE`

The planner's draft fragment used `least(extract(...)*1000, 120000)`, which gives an
over-cap gap a full CAP instead of 0 — the opposite of the binding model in
`13-ui-v3-architecture.md §4`. This is not theoretical. Both variants, same 20 runs:

| run | binding model (`CASE`) | planner draft (`least`) | Δ |
|---|---|---|---|
| `9a937009` | 1193619 | 1313619 | **+120000** |
| `ab331865` | 662324 | 782324 | **+120000** |
| *(the other 18)* | — | — | 0 |

Each over-cap gap is silently credited a full two minutes of work that never
happened. The shipped fragment uses
`CASE WHEN gap_ms >= 0 AND gap_ms <= 120000 THEN gap_ms ELSE 0 END`, and
`check-working-time.ts` asserts `least(` never reappears in `WORKING_MS_SQL`.

*(The two running rows read higher in this second query than in the table above —
350949 and 343391 — because their threads grew between the two queries. Both
variants agree with each other on those rows, which is what the comparison tests.)*

### 2. Malformed timestamps: skip in JS, filter in SQL

The JS core skips an unparseable `ts` and joins its neighbours. `::timestamptz`
throws instead, which would fail the whole query, so the SQL filters entries whose
`ts` does not match `^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}`
*before* the cast and before the `lag()` re-sequencing — same skip-don't-zero,
don't-throw semantics.

Two residual differences, stated rather than hidden:

- **The accepted set is not identical.** `Date.parse` accepts strings the regex
  rejects (`"Aug 5 2026"`), and Postgres accepts shapes the regex rejects. On real
  data this is moot: **0 skipped timestamps across all 20 threads, 2509 entries** —
  `runs.thread` timestamps are uniformly ISO-8601, as the planner recorded.
- **`skipped_ts` is not available from SQL.** A scalar sub-select returns one number.
  A caller that needs the count must use the JS core. Round 305 should therefore
  report `working_ms_source: "thread"` from the SQL path without a skip count, which
  is honest because the count is 0 today — if `runs.thread` ever gains a non-ISO
  writer, a string matching the shape but not a real date
  (`2026-13-45T99:99:99`) makes Postgres **throw**, loudly, rather than return a
  wrong number. The caller catches it and falls back to the JS core.

PG 17's `CAST(… AS timestamptz DEFAULT NULL ON ERROR)` would close this exactly.
This box runs **PostgreSQL 16.13**, so the regex pre-filter is the available answer.

## Cost

`29.45 ms` for the working-time column over all 20 runs (2509 thread entries at
capture time — the two running rows are still appending; 2544 a few minutes later,
~74 KB of timestamps), matching the planner's 30 ms measurement. This is the whole
reason the SQL path exists: the alternative is shipping every run's full `thread`
(megabytes) to node on every team-panel poll.

```
SELECT count(*), sum(w) FROM (SELECT <WORKING_MS_SQL> AS w FROM runs r
  WHERE r.metadata->>'project_id' = '8ea0cc08-…') x;
 20 | 11021111
Time: 29.452 ms
```

## Verdict

One model, two implementations, zero disagreement on real data. The JS core is the
definition of truth; the SQL fragment is an optimisation of it that has been shown
to agree. Round 305 may use either, and should use SQL for the team endpoint's list
query plus `workingMsRunningExtension()` for running rows.
