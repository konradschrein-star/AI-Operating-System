# Phase 1354 — fix cycle 1

Nine findings from round 1353's two reviews, addressed. Two were real defects
that shipped (a button that lied, a SQL fold that double-counted); three were
comments and headers that had become false the moment the capability flags
flipped; two were gate machinery that could not fail; two were deploy
prerequisites nobody had written down.

Every claim below is reproducible from this worktree. Where a fix has a
before/after, the "before" was measured by reverting the fix and re-running the
same check, not by reasoning about it.

---

## 1 — The ⏸ button was a silent no-op on settled rows

**`forge-control-web/app/desktop/team/TeamRow.tsx`, `confirm.ts`, `ChatTeamPanel.tsx`**

`disabled={!canStop}` gated on the CAPABILITY only. While
`GET /api/capabilities` answered `stop:false` that was indistinguishable from
correct. Round 1353's `8ec83cc` flipped it to `true`, and every COMPLETED row
grew an enabled ⏸ — `cursor: pointer`, `tokens.warn`, title "Stop this agent" —
whose click reached `{action:"blocked", reason:"settled"}` and was discarded
with a bare `return`. Zero requests, zero toasts. NFU6 forbids exactly that.

The fix is not a second condition bolted onto the first. `confirm.ts` now
exports `stopBlockReason()`, which IS `decideStopClick` with the id dropped, and
the button's `disabled`, `title`, colour and cursor are all read from its one
answer. The affordance and the click decision are now two readings of one
function and cannot drift apart.

`ChatTeamPanel.tsx:290` no longer drops the blocked decision either — it raises
an `info` toast naming the reason, so a reviewer who strips `disabled` in
devtools gets a sentence instead of silence.

**Proof — `scripts/checks/check-stop-affordance.tsx` (new).** It renders
`TeamRowView` through `renderToStaticMarkup` and reads the emitted
`<button data-team-stop …>` attributes: the same markup a browser receives,
with no browser and no engine. 23 assertions over the full 2×2 of
(capability on/off) × (row settled/running), plus a token-purity sweep of the
rendered row.

| | before (fix reverted) | after |
|---|---|---|
| `check-stop-affordance.tsx` | **4 FAILURES**, exit 1 | **ALL PASS**, exit 0 |
| completed row, `stop:true` → `disabled` | `false` | `true` |
| completed row → `title` | "Stop this agent" | "Run has already settled — nothing to stop" |
| completed row → `cursor` | `pointer` | `not-allowed` |

The "before" column was produced by patching `TeamRow.tsx` back to
`disabled={!canStop}`, running the script, and restoring — not by inference.

## 2 & 3 — Comments that the capability flip falsified

- **`ChatTeamPanel.tsx:350`** claimed the terminate path was "still unreachable
  today: with an all-false capabilities response `decideXClick` never returns
  this action". The r1353 reviewer reached it and got a 202. Replaced with the
  live state: enabled, capability-gated on `terminate:true`, driven end to end
  in a browser, and it re-disables with a stated reason if the engine withdraws
  the flag.
- **`scripts/checks/check-run-control-client.ts:7`** carried the same staleness
  as its *justification* ("a browser cannot prove anything about it"). The
  script is kept — its value never depended on the flag, because a browser
  cannot make the engine answer 404, or 500 with an HTML proxy page, or a 2xx
  with a torn body, or accept a "/" in a run id. The header now says that
  instead, and points at the two checks that hold the other halves.

## 4 & 5 — Deploy prerequisites, written down

Documented in `../phase1350/README.md` under **Deploy notes**, because that is
the phase whose code needs them. Confirmed against the live database this
round:

```
$ psql "$DATABASE_URL" -tAc \
    "SELECT to_regclass('public.usage_hourly'), to_regclass('public.ui_dismissals'), to_regclass('public.app_settings')"
||
```

Three NULLs — **none** of migration 0040 or 0041 has been applied to
`content_forge`. There is no migration runner in this repo. A deploy that
restarts `forge-control` first ships a team panel that does not render (500
`relation "ui_dismissals" does not exist`) and a usage series that 500s hourly.
The phase-1350 README now carries the apply order, the re-runnability evidence,
the symptom table and the verify command above.

The reviewer's leftover `rev1353_shim` schema is recorded there too, with the
`DROP` written out and explicitly NOT executed — no build task here is
authorised to issue one, and leaving it breaks nothing.

## 6 — Tokens were double-counted across hourly buckets

**`forge-control/src/lib/usage-sampler.ts`**

The module header asserted "spend_log gets exactly one row per finished run".
It does not: `executor.ts:1147` calls `recordSpend` once per executor
INVOCATION, and a chat run is re-entered for every turn. `linked` was
`SELECT DISTINCT run_id FROM billed` — every run billed in the hour, folded at
its CUMULATIVE `usage_total_running` — so a run touching N hours contributed its
whole total N times. Closed buckets were not stable either: `RESAMPLE_LOOKBACK`
re-closes the previous hour every tick and re-read the still-growing counter.

`linked` is now an anti-join keeping a run only when no claude-code spend row
for it exists at or after the bucket's end — i.e. its LATEST turn is in this
hour. One bucket per run, the newest. Cost is deliberately untouched: `cost`
still aggregates `billed` directly, because each spend row carries its own
turn's usd.

The header, the `ATTRIBUTION` string, migration 0040's header, `usageApi.ts`
and `UsagePanel.tsx` all said "counted at run completion". They now say what
the SQL does. The word "floor" is gone from the header too — the count was
wrong in both directions, and a floor is a promise.

**Proof — `scripts/checks/check-usage-fold.ts` (new).** A real Postgres, its
own scratch database, synthetic rows, seven sections / 22 assertions. It
imports `sampleHour` and injects a psql-backed `Querier`, so the SQL under test
is the module's own and is never retyped.

Run against the **pre-fix** sampler it fails with precisely the r1353
reviewer's numbers:

| | before | after |
|---|---|---|
| run with turns at 10:05 and 11:05, `usage_total_running` 1000 — hour 10 | **1000** | 0 |
| …hour 11 | 1000 | 1000 |
| …sum across the two hours | **2000** (2× the run's real total) | **1000** |
| re-close hour 11 after the run grows to 5000 | **5000** (a settled hour rewriting itself) | 0 — the total moved to hour 12, where the latest turn is |
| sub-agent totals in a hour the run does not belong to | **1100** | 0 |
| two runs billed in hour 10, both continuing at 12:00 | **3000** | 0 |
| cost in each hour (must NOT change) | $0.10 / $0.20 | $0.10 / $0.20 |
| `check-usage-fold.ts` overall | **7 FAILURES**, exit 1 | **ALL PASS**, exit 0 |

Planner shape on the fixed statement, printed by the script's last section:

```
Nested Loop Anti Join
  ->  Unique
        ->  Index Scan using spend_log_provider_created_idx on spend_log s
              Index Cond: ((provider = 'claude-code') AND (created_at >= …) AND (created_at < …))
  ->  Index Scan using spend_log_provider_created_idx on spend_log s2
        Index Cond: ((provider = 'claude-code') AND (created_at >= <bucket end>))
```

One anti-join pass on the existing `(provider, created_at DESC)` index, not one
subquery per candidate run.

`usage-sampler.test.ts` gains a no-DB guard so `pnpm test` alone catches a
revert: reverting `linked` to the old shape turns it red (verified — 855/856
pass, 1 fail; restored: 856/856).

## 7 — A RED gate reported EXIT=0

**`scripts/checks/gates-808.sh:75`**

`gate_sh` ran its body as `bash -c "$script"`. Gate 8 is
`bash scripts/checks/dollar-sweep.sh | tail -6`; the sweep exits 1, but without
`pipefail` the pipeline's status is `tail`'s. The gate printed EXIT=0 and the
summary said "RED: 0". Gates 9, 10, 15 and 16 pipe the same way.

`bash -c "set -o pipefail; $script"` — set inside the child, so only gate bodies
are affected. Demonstrated on a deliberately-broken allowlist, same command
both ways:

```
--- OLD helper (no pipefail) ---   EXIT=0     ← the lie
--- NEW helper (set -o pipefail) ---  EXIT=1  ← the truth
--- restored allowlist ---            EXIT=0
```

## 8 — The dollar sweep's six unlisted files

Every FAIL the exposed gate reported was a file rounds 1351–1352 introduced and
never allowlisted: `UsagePanel.tsx`, `usageApi.ts`, `IntegrationsPanel.tsx`,
`SettingsSurface.tsx`, `QuotaStrip.tsx`, `context-window.ts`. Added to
`dollar-allowlist.txt` with the per-file justification the sweep prints —
settings is the sanctioned money destination (10-ui-v3-spec.md), `QuotaStrip.tsx:8`
is a comment rather than a rendered value, and `context-window.ts`'s `toFixed(2)`
is the same token-magnitude false positive already excused for
`AgentActivity.tsx` and `teamApi.ts`.

Patterns are scoped per file, never `.*`, so a genuinely new dollar landing in
any of them still fails the gate.

`dollar-sweep.sh`: **93 hits, all allowlisted, exit 0.**

## 9 — `DELETE` missing from CORS

**`forge-control/src/index.ts:62`** — `integrations.ts:352` exposes
`DELETE /gemini/key` but `Access-Control-Allow-Methods` listed only
`GET,POST,PUT,OPTIONS`. Latent (the web UI reaches the API through a
same-origin Next rewrite and never preflights), but the :7701 mobile UI and
Tailscale traffic do. Now `GET,POST,PUT,DELETE,OPTIONS`, with the reason in the
comment beside `PUT`'s.

## 10 — `h1 { display: none }` hid every h1 in the embedded page

**`forge-control-web/app/desktop/settings/SecretsPanel.tsx:44`** — the file's own
header promised the overrides "cannot silently hide new content"; a descendant
selector on `h1` does exactly that to any heading a future section adds. Scoped
to the one element it means — `> div > div > h1:first-of-type`, the page title
at `app/settings/secrets/page.tsx:89` directly under the `maxWidth: 780` wrapper
at :76. A second h1 anywhere now renders, which is the honest default.

---

## Gates run for this round

```
forge-control      npx tsc --noEmit                              exit 0
forge-control-web  npx tsc --noEmit                              exit 0
forge-control-web  NODE_ENV=production pnpm build                exit 0, 12 routes
forge-control      pnpm test                                     856/856 pass
scripts/checks/gates-808.sh                                      21 gates, RED: 0
scripts/checks/dollar-sweep.sh                                   PASS, 93 hits allowlisted
check-stop-affordance.tsx                                        ALL PASS (23)
check-usage-fold.ts                                              ALL PASS (22)
check-run-control-client.ts                                      18/18 PASS
check-team-confirm.ts                                            ALL PASS
check-settings-surface.tsx                                       PASS
no-raw-colours.cjs                                               PASS
```

`gates-808.sh` grew four gates this round (13–16): the two new checks, the
standalone typecheck the `scripts/` tree needs, and `pnpm test`, which the
suite ran but never gated on. `check-usage-fold.ts` SKIPS rather than passes
when `DATABASE_URL` is unset — a gate that cannot connect must not report
green.

`gates-808.sh` gate 3 went red twice mid-round with `✓ Compiled successfully`
followed by `ENOENT … .next/server/pages-manifest.json`. That is a sibling task
in this shared worktree building into the same `.next` concurrently —
`ps aux | grep "[n]ext build"` showed **two** running at the time, and the same
hazard is what made round 1353's reviewer build outside the worktree. Waiting
for them to clear and re-running gave exit 0 with 12 routes, and the next full
gates run was RED: 0 across all 21. Recorded rather than hidden: a reviewer who
sees this should check for a concurrent build before triaging a break that is
not one.

## Reproducing the two new checks

```bash
# the button, no browser needed
cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
  --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx

# the SQL, needs a Postgres SERVER (makes its own scratch db; never writes to
# the database named in the DSN)
cd forge-control && DATABASE_URL=<any dsn on that server> \
  ./node_modules/.bin/tsx ../scripts/checks/check-usage-fold.ts
```

To see the "before" numbers for yourself: revert the `linked` CTE to
`SELECT DISTINCT run_id FROM billed WHERE run_id IS NOT NULL`, or
`TeamRow.tsx`'s stop button to `disabled={!canStop}`, and re-run the matching
script. Both go red, loudly.

## What this round left on the box

- **Scratch database `r1354_sampler`** on the same Postgres server as
  `content_forge`. Created by `check-usage-fold.ts`, which recreates it on
  demand if it is missing, so it is a cache rather than state — but it is real
  and it is recorded here rather than left for someone to find. `content_forge`
  itself was only ever READ (three `to_regclass` calls); nothing in it was
  created, altered or dropped by this round. Safe to remove with
  `DROP DATABASE r1354_sampler;` — a `DROP`, so not executed here.
- **Nothing else.** No processes left listening, no pm2 entry touched,
  `forge-executor` at 6D uptime with 0 restarts, and both this worktree and
  `/opt/forge-ai-os` clean at commit time.
