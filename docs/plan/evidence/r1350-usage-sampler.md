# R1350 — hourly usage sampler: behavioural evidence

Round 1350, `operator-visibility`. Backend half of the usage panel: migration
0040, `lib/usage-sampler.ts`, `GET /api/usage/series`, `GET|PUT /api/usage/rate`.

All of this ran **out of the worktree** against a **scratch database**
(`forge_usage_probe_1351`, created additively on the local cluster, nothing
dropped) and a **single-router probe** on port 7871. No pm2 restart, no write to
the live database, `src/index.ts` never started.

---

## 0. Ground-truth correction to the task brief

The brief stated tokens live in `runs.metadata->'rollup_v1'->'usage'`. Verified
against the live `runs` table on 2026-08-17 — they do not:

| field | what it actually is | live rows |
|---|---|---|
| `metadata.rollup_v1` | a **timestamp scalar** (flush marker, `run-rollup.ts` `buildPayload`). `->'usage'` is always NULL. | 335 |
| `metadata.usage_running` | the **last assistant message only** — not cumulative. Summing it across runs under-counts by orders of magnitude. | 355 |
| `metadata.usage_total_running` | the cumulative parent-run total. **This is the field.** | 335 |
| `metadata.subagents_v2[].usage` | per-subagent totals, **not** folded into the parent total. | — |

```
$ psql -c "SELECT jsonb_pretty(metadata->'rollup_v1') FROM runs WHERE metadata ? 'rollup_v1' ORDER BY created_at DESC LIMIT 1"
 "2026-08-17T03:08:27.185Z"
```

The sampler therefore reads `usage_total_running + SUM(subagents_v2[].usage)`,
falling back to `usage_running` only for the 20 legacy rows that predate
`usage_total_running`. A regression test (`usage-sampler.test.ts` → "token
extraction guards every cast") asserts `rollup_v1` never reappears in the SQL.

Reported to the manager chat while building, because any UI reading
`rollup_v1->usage` renders null.

## 0b. Decision the brief left open: default EUR/USD rate

Brief suggested `0.92` "unless you find a better default in the repo". There is
one: `executor.ts:62` prices every `spend_log` row with `CC_USD_EUR ?? 0.86`.
`/api/spend` sums those EUR values. A usage panel converting the same USD at
0.92 would disagree with the money surface about the same spend and read as a
bug — so `DEFAULT_EUR_PER_USD` is `CC_USD_EUR ?? 0.86`, the same env var and the
same number. It stays overridable per-install via `app_settings`.

---

## 1. Migration applies, and applies twice

```
$ psql "$SCRATCH" -f db/migrations/0026_spend_log.sql
$ psql "$SCRATCH" -f db/migrations/0040_usage_hourly.sql
$ psql "$SCRATCH" -f db/migrations/0040_usage_hourly.sql     # again
NOTICE:  relation "usage_hourly" already exists, skipping
NOTICE:  relation "usage_hourly_bucket_start_desc_idx" already exists, skipping
NOTICE:  relation "app_settings" already exists, skipping
$ psql "$SCRATCH" -c '\dt'
 public | app_settings | table | postgres
 public | spend_log    | table | postgres
 public | usage_hourly | table | postgres
```

`migrations.test.ts` also lints 0040 statically: `ok 21 - 0040_usage_hourly.sql
guards every re-runnable DDL statement`.

## 2. Fixture — deliberately hostile

Five runs and seven `spend_log` rows in the 09:00–10:00 UTC window:

| run | rollup shape | purpose |
|---|---|---|
| A `1111…` | `usage_total_running` (100/200/30000/5000) + 2 subagents | the normal case |
| B `2222…` | `usage_running` only (7/11/13/17) | the 20 legacy rows |
| C `3333…` | `{}` — no rollup | executor restarted mid-run: cost, zero tokens |
| D `4444…` | `input_tokens: "not-a-number"`, `subagents_v2: "oops"` | one malformed blob must not abort the hour |
| E `5555…` | huge counts, spend row at **exactly 10:00:00** | half-open window `[start, end)` |

plus a `claude-code` row with **no `run_id` and `usd: "free"`**, and an
`elevenlabs` row in the same hour that must be ignored entirely.

## 3. `sampleHour` twice over the same hour

```
PASS 1: { bucket_start: 2026-08-17T09:00:00.000Z, tokens_in: 122, tokens_out: 241,
          cache_read: 31513, cache_write: 5167, shadow_usd: 0.3325, run_count: 5,
          sampled_at: 2026-08-17T03:16:05.033Z,
          meta: { runs_found: 4, runs_without_usage: 1, rows_without_usd: 1,
                  rows_without_run_id: 1, subagent_count: 2,
                  source: "spend_log+runs.metadata",
                  attribution: "counted at run completion" } }

PASS 2: { …identical…, sampled_at: 2026-08-17T03:16:06.153Z }

IDEMPOTENT (every column except sampled_at): true
sampled_at advanced (freshness stamp, by design): 03:16:05.033Z -> 03:16:06.153Z
```

Every number is hand-checkable:

- `tokens_in`  = 100 (A parent) + 15 (A subagents) + 7 (B fallback) + 0 (C) + 0 (D, string rejected) = **122**
- `tokens_out` = 200 + 27 + 11 + 0 + 3 = **241**
- `cache_read` = 30000 + 1500 + 13 = **31513**
- `cache_write`= 5000 + 150 + 17 = **5167**
- `shadow_usd` = 0.2125 + 0.01 + 0.1 + 0.01 + 0 (`"free"`, not a JSON number) = **0.3325**
- `run_count`  = 5 `claude-code` rows in the hour — elevenlabs excluded, the 10:00:00 row excluded

`sampled_at` is the one column that moves, on purpose: it records when we last
looked. The idempotency claim is about the measured columns.

## 4. The three failure modes that would have been silent

```
EMPTY HOUR  -> { bucket_start: 2026-08-17T03:00:00.000Z, tokens_in: 0,
                 tokens_out: 0, shadow_usd: 0, run_count: 0 }
NEXT HOUR   -> { bucket_start: 2026-08-17T10:00:00.000Z, tokens_out: 999999,
                 shadow_usd: 1, run_count: 1 }
```

- A quiet hour is a **zero row**, not a missing one. A hole is indistinguishable
  from "the sampler was down", and a chart that cannot tell those apart lies twice.
- The 10:00:00 spend row landed in the **10:00 bucket**, not the 09:00 one —
  `[start, end)` holds.
- Run D's `"not-a-number"` and `subagents_v2: "oops"` cost the hour nothing. Every
  `::numeric` cast sits behind a `jsonb_typeof(...) = 'number'` guard; without it
  one malformed blob raises and takes the whole bucket with it.

Runs with no usage at all are counted in `meta.runs_without_usage`, not rounded
away — the bucket says how much of itself it could not measure.

## 5. Boot backfill

```
backfill filled 720 bucket(s) in 2733ms
buckets | nonzero | min                    | max
    723 |       5 | 2026-07-18 03:00:00+00 | 2026-08-17 10:00:00+00
```

30 days of history reconstructed from `spend_log` in 2.7s, sequentially, on a
pool of 2 — it must not starve the HTTP server it shares a process with.

## 6. Endpoints — single-router probe on :7871

`routes/usage.ts` mounted alone; `src/index.ts` deliberately not imported
(it starts the cron, telegram and vault-sync ticks).

```
$ curl -s :7871/api/usage/rate
{"eur_per_usd":0.92,"source":"app_settings","updated_at":"2026-08-17T03:16:06.173Z","default_eur_per_usd":0.86}

$ curl -sX PUT :7871/api/usage/rate -d '{"eur_per_usd":0.88}'
{"eur_per_usd":0.88,"source":"app_settings","updated_at":"2026-08-17T03:17:09.433Z","default_eur_per_usd":0.86}

$ curl -sX PUT :7871/api/usage/rate -d '{"eur_per_usd":12}'
{"error":"eur_per_usd must be between 0.1 and 10, got 12"}          [HTTP 400]
$ curl -sX PUT :7871/api/usage/rate -d '{"eur_per_usd":"0.9"}'
{"error":"eur_per_usd must be a number, got string"}                [HTTP 400]
$ curl -sX PUT :7871/api/usage/rate -d '{"eur_per_usd":0}'
{"error":"eur_per_usd must be between 0.1 and 10, got 0"}           [HTTP 400]
$ curl -sX PUT :7871/api/usage/rate -d 'nope'
{"error":"body must be JSON: {\"eur_per_usd\": <number>}"}          [HTTP 400]
```

`"0.9"` is rejected rather than coerced on purpose: a form posts strings, and
coercion would let `"abc"` through as `NaN` two releases later.

```
$ curl -s :7871/api/usage/series
{ hourly: 26 pts, daily: 31 pts, weekly: 6 pts,
  eur_per_usd: 0.88, rate_source: "app_settings",
  attribution: "counted at run completion",
  sampled_through: "2026-08-17T10:00:00.000Z",

  hourly[…] { bucket_start: "2026-08-17T09:00:00.000Z", tokens_in: 122,
              tokens_out: 241, cache_read: 31513, cache_write: 5167,
              shadow_usd: 0.3325, eur: 0.2926, run_count: 5 }
  hourly[0] { bucket_start: "2026-08-16T04:00:00.000Z", …all zero…, run_count: 0 }

  daily[…]  { bucket_start: "2026-08-17T00:00:00.000Z", shadow_usd: 1.8325,
              eur: 1.6126, run_count: 7 }
  weekly[…] { bucket_start: "2026-08-17T00:00:00.000Z", … }   # ISO, Monday-start
}
```

`eur` checks out: 0.3325 × 0.88 = 0.2926. `hourly` is 26 points rather than 24
only because the fixture is dated ahead of the probe box's clock; in production
the sampler never writes a future bucket.

**Cost of a request** — three consecutive calls, `usage_hourly` only, never `runs`:

```
total=0.006911s
total=0.005037s
total=0.005071s
```

~5 ms for 24h + 30d + 12w. That is the whole point of the table: this is the
endpoint an always-open dashboard polls, and it must never become the read-time
JSONB fold that made the Live panel bog the machine down.

## 7. Static gates

```
$ npx tsc --noEmit              # forge-control
TSC CLEAN

$ pnpm test
# tests 831
# pass 831
# fail 0
```

## 8. Left behind on purpose

`forge_usage_probe_1351` still exists on the local cluster. Nothing was dropped
(destructive ops need an explicit instruction); it is inert and re-usable for
the next round's proof.

**Not run here, by design:** 0040 has NOT been applied to the live
`content_forge` database, and `forge-control` has NOT been restarted. Both belong
to the deploy phase, which must, in this order: apply 0040 with psql, then
restart `forge-control` — the sampler's boot backfill needs the table to exist,
and will log `boot backfill failed` (harmlessly, once) if the restart comes first.
