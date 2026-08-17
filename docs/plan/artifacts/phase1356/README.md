# Round 1356 — the double fold, actually fixed

Round 1355's re-review returned **NEEDS_FIXES** on two points. This is the
evidence for both, in the order the reviewer raised them.

---

## Blocker 1 — the anti-join was only ever evaluated twice per bucket

**The claim that was false.** `usage-sampler.ts` said "every run lands in
exactly one bucket, every token is counted exactly once". The SQL does deliver
that *within one `sampleHour()` call*. The write schedule does not:

- `runSamplerTick` writes bucket H twice — once as the closing hour at
  H+1:00:30, once as the `RESAMPLE_LOOKBACK` hour at H+2:00:30.
- `backfill` only fills buckets with **no row yet**.

So from H+2:00:30 onward, H is frozen. A run whose last turn was in H, and
which resumes at H+3, is folded into H (correctly, at the time) **and** into
H+3 (correctly, now) — and nothing ever un-counts H.

### The fix

Two parts, both in `forge-control/src/lib/usage-sampler.ts`:

1. **`meta.folded_runs`** — every bucket now records the run ids whose
   cumulative totals were folded into it. `jsonb_agg` over the `linked` CTE;
   no schema change, no migration (the column is the existing `meta jsonb`).
2. **`repairDisplacedBuckets(now, db)`** — one audit query over the 30-day
   horizon, then one re-sample per bucket it names. Two reasons, reported
   separately:
   - `displaced` — the bucket's recorded set contains a run that has since
     been billed at or after that bucket's end.
   - `unaudited` — the bucket predates `folded_runs` and cannot be audited, so
     it is recomputed once. **This is what repairs the 16 (run, bucket) pairs
     the reviewer measured**; they were all written by the frozen-bucket code.

   Called by `runSamplerTick` **after** it samples, and once at boot.

**Why it terminates.** Re-sampling a displaced bucket drops the run from
`linked`, which drops it from `folded_runs`, so the same (bucket, run) pair is
never selected twice. Re-sampling an unaudited bucket gives it the field, so
`unaudited` is empty on every pass after the first. Asserted, not asserted-in-
prose: §2b and §2c both run a second pass and require it to find nothing.

**Why the order matters.** Repair-then-sample would empty a run's old bucket
before the new bucket that should hold its tokens exists — a window in which
the table *under*-counts. Sample-then-repair is never wrong in either
direction. `usage-sampler.test.ts` pins the order (`repairs AFTER sampling,
never before`).

### Measured, on the reviewer's own scenario

`scripts/checks/check-usage-fold.ts` §2b drives the **real** `runSamplerTick`
at production cadence (one tick per hour, 30 s past the boundary) — nothing in
it calls `sampleHour`. One turn in hour 10, four silent ticks, a resumed turn
in hour 14, one more tick.

```
$ cd forge-control && DATABASE_URL=<dsn> USAGE_FOLD_DB=r1356_repair \
    ./node_modules/.bin/tsx ../scripts/checks/check-usage-fold.ts
```

| | hour 10 | hour 14 | buckets sum | true total |
|---|---|---|---|---|
| **before** (mutant, see below) | 1000 | 5000 | **6000** | 5000 |
| **after** (as shipped) | 0 | 5000 | **5000** | 5000 |

Full run: `ALL PASS` (36 assertions, 12 of them new), exit 0. Gate 18 of `gates-808.sh`.

### The check fails on the pre-fix code — proven, not asserted

Both mutations were applied to an **out-of-tree copy** (`/tmp/r1356mut`, a real
file copy with only `node_modules` symlinked — a symlinked source tree would
have silently tested HEAD and reported ALL PASS).

**Mutation 1 — `runSamplerTick` no longer repairs** (i.e. the pre-1356 tick):

```
── §2b the same, but driven by the REAL tick over a 3h gap ─
PASS  hour 10 holds the run while it is the run's latest turn
PASS  hour 14 takes the resumed run's whole total
FAIL  hour 10 gives it up — this was 1000 before round 1356
        expected 0
        actual   1000
FAIL  …so every bucket, summed, is the run's real total and not 6000
        expected 5000
        actual   6000
FAIL  a second repair pass finds nothing displaced
        expected 0
        actual   1
EXIT:1
```

Those are round 1355's numbers exactly: `10:00|1000`, `14:00|5000`, true total
5000, buckets sum 6000.

**Mutation 2 — `lower()` removed from both sides of the run-id join** (round
1355's non-blocking note):

```
── §2d an UPPERCASE run id in spend_log still matches ──────
FAIL  hour 10 is found displaced by the uppercase-id turn
        expected 1
        actual   0
FAIL  …and the table sums to the run's real total
        expected 5000
        actual   6000
EXIT:1
```

`folded_runs` holds `uuid::text` (lowercase-canonical by construction) and
`spend_log.meta->>'run_id'` is free text, so the guard is now on both sides —
the anti-join in `sampleHour` and the audit join in `repairDisplacedBuckets`.
Zero uppercase rows exist live, which is exactly why it needed a check rather
than a comment.

---

## Blocker 2 — `run_count` counts turns, and two places still said "runs"

The panel was already corrected in `8c0f9f6` (`UsagePanel.tsx:872` and `:980`
both read `turns`, and `sumSlots` names the field `turns`). What round 1355
left behind, and this round fixes:

| site | was | now |
|---|---|---|
| `usage-sampler.ts` tick log | `${closed.run_count} run(s)` | `${closed.run_count} turn(s)` |
| `db/migrations/0040_usage_hourly.sql` | `-- finished runs billed into this hour` | `-- BILLED TURNS, not runs` + a paragraph with the live 217-vs-101 measurement |

Additionally, `meta.distinct_runs` (`COUNT(DISTINCT run_id)`) is now written
per bucket — the number the word "runs" would honestly describe. It is
deliberately **not** in `/api/usage/series`: the series rolls hours up into
days and weeks by summing, and a run spanning three hours is distinct in each
of them, so a summed distinct-count would claim three runs where there was
one. The honest label ships in the UI; the honest number is in `meta` for
anyone querying the table.

---

## Gates

```
DATABASE_URL=<dsn> bash scripts/checks/gates-808.sh
 SUMMARY — 25 gates ·  RED: 0     (23–24 SKIPPED: browser harness not requested)
```

- `npx tsc --noEmit` — forge-control: exit 0
- `npx tsc --noEmit` — forge-control-web: exit 0
- `npm run build` — forge-control-web: `BUILD_EXIT:0`, 12 routes
- `pnpm test` — `# tests 862 # pass 862 # fail 0` (33 in the sampler suite, 6 new)
- `check-usage-fold.ts` — ALL PASS against a real Postgres

**Gate 8 (`dollar-sweep.sh`) was already RED at `8c0f9f6`** — verified by
stashing this round's work and re-running (`HEAD_EXIT:1`). Round 1355's final
commit added two header comments to `UsagePanel.tsx` naming `spend_log`, after
the reviewer's gate run; the newly-pipefail-honest gate caught them. Fixed by
scoping the file's existing allowlist pattern to include `spend_log` — the bare
word `spend` is still not waived there, so a real spend value arriving in that
file still fails the gate.

---

## Cleanup this round created and did not remove

Scratch databases on the same server (nothing in `content_forge`'s `public`
schema was written — the DSN is used only to reach the server and create these):

```sql
DROP DATABASE r1356_repair;   -- the check's own scratch db
DROP DATABASE r1356_mut;      -- the two mutation runs
```

Out-of-tree mutant copy: `/tmp/r1356mut` (a file copy plus one symlink to
`forge-control/node_modules`). `DROP` and `rm -rf` are destructive operations
this task carries no instruction to perform, so — as in rounds 1353 and 1355 —
they are recorded here rather than executed.
