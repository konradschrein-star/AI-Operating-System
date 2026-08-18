# Round 1352 — credit tracker UI (UsagePanel), and how to re-run its verification

Builder's evidence for `forge-control-web/app/desktop/settings/UsagePanel.tsx`
and `.../usageApi.ts`. Everything below was run inside the project worktree;
`/opt/forge-ai-os` was not touched and no pm2 process was restarted.

## The endpoint contract, as read from the code (not from the brief)

`forge-control/src/routes/usage.ts` (round 1350, commit `e33408e`) returns one
field the brief did not mention, and the panel prints it:

    GET /api/usage/series → { hourly, daily, weekly, eur_per_usd,
                              rate_source,        ← NOT in the brief
                              attribution, sampled_through }

`rate_source` is `"app_settings" | "default"`, the same discriminator
`GET /usage/rate` returns. Everything else matches the brief exactly. Two
further facts the panel depends on:

* `/usage/series` selects `bucket_start >= now() - 30 days`, which can yield a
  **31st** partial day bucket. The panel plots it rather than dropping it, and
  titles the card from the bar count (`LAST 31 DAYS`) instead of claiming 30.
* the series carries only the buckets the sampler actually wrote. Absence is
  the normal encoding of "no sample". `usageApi.alignSlots` lays the points on
  a continuous grid and leaves `null` in the holes.

## Probe harness (no live services, no live database)

Added: `forge-control/scripts/probe-usage-router.ts` — mounts ONLY the usage
router. It never imports `src/index.ts`, so no cron / telegram / vault tick and
no project engine starts.

    # 1. scratch database — NOT content_forge, because PUT /usage/rate writes
    psql "$ADMIN_DSN" -c "CREATE DATABASE usage_probe_1352"
    psql "$PROBE_DSN" -f db/migrations/0040_usage_hourly.sql

    # 2. fixture: 90 days of hourly buckets with DELIBERATE holes —
    #    hours 03:00 and 04:00 UTC never sampled, and one whole missing day
    #    nine days back. Gaps are the thing under test.
    INSERT INTO usage_hourly (bucket_start, tokens_in, tokens_out, cache_read,
                              cache_write, shadow_usd, run_count)
    SELECT h, …sin/cos shapes…
      FROM generate_series(date_trunc('hour', now()) - interval '89 days',
                           date_trunc('hour', now()) - interval '1 hour',
                           interval '1 hour') h
     WHERE extract(hour from h)::int NOT IN (3,4)
       AND h::date <> (now() - interval '9 days')::date;

    # 3. router alone on a spare port, deliberately offline for quota
    cd forge-control
    DATABASE_URL="$PROBE_DSN" CLAUDE_CREDENTIALS=/nonexistent PORT=7842 \
      npx tsx scripts/probe-usage-router.ts

    # 4. the web app against it, on a spare port
    cd forge-control-web
    NODE_ENV=development FORGE_CONTROL_URL=http://127.0.0.1:7842 \
      npx next dev -p 7843

The panel was reached through a scratch route (`app/probe-usage-r1352/page.tsx`)
with `middleware.ts` parked, because the app's GitHub OAuth wall cannot be
passed headlessly. **Both were reverted before committing** — `middleware.ts` is
byte-identical to HEAD and the scratch route is gone. The scratch database was
left in place (dropping it is a destructive op and was not briefed); it is
`usage_probe_1352` on 127.0.0.1:5432 and nothing reads it.

## What the browser actually showed (Chromium, playwright, 1280px)

| check | result |
|---|---|
| hourly chart | 24 bars, **4 drawn as gaps** (03:00, 04:00 ×2 days windowed) |
| daily chart | 31 bars, **1 gap** — the missing day, a hole, not an interpolated bar |
| gap tooltip | `08.08 00:00 UTC — no sample` |
| bar tooltip | `16.08 05:00 UTC / in 62,467 · out 7,158 / cache read 1,628,212 · write 52,029 / 1,749,866 tokens total · 6 runs / shadow $4.20 = €6.30` — €6.30 because the rate was 1.5 at that moment, which is the conversion being tested |
| weekly | 13 rows, ISO weeks Monday-start UTC, newest first |
| attribution printed | `counted at run completion` (verbatim from the API) |
| freshness printed | `sampled through: 17.08 02:00 UTC (1h ago)` |
| rate edit 0.86 → 1.2 | every EUR figure re-priced in the same tick: `€70.27 €5.06 €2129 €81.40` → `€98.05 €7.07 €2970 €114` |
| rate 50 (out of band) | `PUT /usage/rate failed: 400 Bad Request — eur_per_usd must be between 0.1 and 10, got 50` — the server's own message, verbatim |
| quota, no token | bars render EMPTY with `—`, not 0%, plus `no oauth token on disk` |
| quota, fixture 42 / 93 / 71 % | green / red / amber, `resets in 47m · 06:35`, `read 3m ago · cached`, refresh button present |
| metric toggle | `LAST 24 HOURS: tokens per hour`, peak `2.81M` |
| dark theme | bar fill `rgb(91,141,239)`, gap `rgb(72,72,78)` |
| light theme | bar fill `rgb(44,98,212)`, gap `rgb(166,166,174)` |

Both themes resolve every chart colour, which is the point of routing SVG
colours through `style` rather than presentation attributes: a presentation
attribute does not resolve `var()`.

Screenshots from the run: `/tmp/r1352-dark.png`, `/tmp/r1352-light.png`,
`/tmp/r1352-final-dark.png`, `/tmp/r1352-quota.png`, `/tmp/r1352-verify-dark.png`.

## Gates

    forge-control-web $ npx tsc --noEmit      → clean
    forge-control-web $ npm run build         → passes (10/10 pages)
    forge-control     $ npx tsc --noEmit      → clean
    grep -Ei '#[0-9a-f]{3,8}|rgba?\(|hsla?\(' UsagePanel.tsx usageApi.ts → zero hits

## Known limits, stated rather than hidden

* The **quota** card was exercised against a fixture, not against Anthropic:
  the probe runs with `CLAUDE_CREDENTIALS=/nonexistent` on purpose, so a build
  task never spends the shared 5-hour quota reading or trips the 429 cooldown
  that `routes/usage.ts` guards. The degraded path (no token) IS real.
* Neither `usage_hourly` nor `app_settings` exists in the live `content_forge`
  database yet, and the live forge-control still 404s `/api/usage/series`
  (round 1350's router is not deployed). **Migration `0040_usage_hourly.sql`
  must be applied at deploy** or the panel will show its error card —
  correctly, but the reader will see a red box.
