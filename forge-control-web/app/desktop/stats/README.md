# `app/desktop/stats` — the one stats panel

`StatsPanel` is mounted in **both** the JOURNAL surface and the GOALS/TASKS
surface (PLAN.md §3.4). It is one component on purpose: two stats views that
agree today drift by Friday, and a number that means one thing on JOURNAL and
another on GOALS is worse than no number.

```tsx
<StatsPanel mount="journal" day="2026-08-25" />   // F2 mounts this
<StatsPanel mount="goals" />                       // F4 mounts this
```

`mount` reorders the tiles and **nothing else** — same components, same
queries, same arithmetic. `day` is optional and only pre-selects the heatmap
cell. This directory does not mount itself anywhere; F2 and F4 do that.

## Files

| file | what it is |
|---|---|
| `StatsPanel.tsx` | the 30/90 filter row, the tile order, and the score heatmap wrapper |
| `ScoreTrend.tsx` | score line + 7-day MA + felt-rating dots, one 0–100 axis |
| `HabitMatrix.tsx` | 18 habit rows × N day columns, faceted by group, today rightmost |
| `HabitFelt.tsx` | which habits move the felt rating — signed diverging bars |
| `CalendarHours.tsx` | booked vs worked per week + the area split |
| `GoalsWeek.tsx` | goals moved this week + the unlinked-done honesty counter |
| `stats-math.ts` | every number. Pure, no React, no fetch |
| `stats-math.test.ts` | 36 assertions over the above |

Run the tests:

```bash
cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
  --test app/desktop/stats/stats-math.test.ts     # 36 pass
```

> **No gate runs this file.** `gates-808.sh` gate 22 runs `pnpm test` in
> **forge-control** only (`tsx --test src/lib/*.test.ts`); nothing in the repo
> executes a `*.test.ts` under `forge-control-web/`. The two existing web-side
> tests — `app/desktop/spend-skew.test.ts` and `app/desktop/goals/quick-add.test.ts`
> — are unwired for the same reason. Wiring a web test runner touches
> `gates-808.sh`, which is shared by every lane, so it belongs to an integration
> task rather than to this one. Until then this command is the only thing that
> runs these 36 assertions.

## How this was verified (round 2)

The stats **backend** (§4.2 `habit_felt`, `goals_week`, `habits[].ticks`,
`/daily/stats/calendar`) is lane B2's, in a different worktree — absent from
this branch *and* from live `:7700` (measured 2026-08-25). So the panel was
proved against a throwaway read-only probe that proxied the live API and derived
the additive fields from that real payload. Four screenshots, all with zero
console errors, `next dev` on a spare port, anonymous-request negative control
(→ `/signin`) on every run:

| what | result |
|---|---|
| live data, `mount="journal"` | the `0 of 20 rated days` sentence verbatim; honest empty states in all six tiles |
| synthetic data | every mark paints — score line, dashed MA, felt dots, heatmap, signed bars, matrix cells, goal meters, calendar bars + area split |
| `mount="goals"` | tile order really flips (GoalsWeek + CalendarHours lead) |
| calendar endpoint forced to 500 | that tile alone prints `500 … on /daily/stats/calendar?weeks=2`; the other five render normally |

## Six rules this directory keeps

**1. Every tile owns its query, its spinner and its error.** There is no
panel-level loading state and no panel-level error (PLAN.md §3.6). The five
Postgres tiles share the key `["daily-stats", days]`, so React Query serves
them from one fetch — per-tile ownership buys independent *failure*, not five
round trips. `CalendarHours` is alone on `["daily-stats-calendar", weeks]`
because it is the only tile that reaches Google; a 502 there greys one card and
leaves the other five reading. Reads are `retry: 1`.

**2. Error text is the message the API returned**, status and path included.
Never "something went wrong" — that sentence cannot be acted on.

**3. "Recorded nothing" and "scored zero" never look the same.** The score
heatmap is `goals/Heatmap.tsx` reused as-is precisely because it already draws
this distinction; `HabitMatrix` repeats it with three cell states (ticked /
recorded-but-not-ticked / no row at all). Re-implementing it would mean two
components disagreeing about what an empty day looks like.

**4. No chart of nothing.** `HabitFelt` prints one sentence and draws no bars
until `habit_felt.sufficient`, and each row gates again on its own
`sufficient`. The sentence is built in `stats-math.ts` and pinned character for
character by a test, because that string *is* the tile for the next ~60 days.

**5. Nothing is capped silently.** `foldAreas` returns how many areas it folded
into "Other" and the tile prints the count.

**6. Hard errors, no clamping.** `feltOnScoreAxis(47)` throws. A rating outside
1..10 is a backend contract break, and pinning it to the top of the axis draws
a perfect day and loses the bug forever.

## The colour decisions, and the measurements behind them

Colours come from `app/tokens.ts` only. **No raw hexes and no
`raw-colour-allowlist.txt` entry** — the WeekGrid precedent was available and
turned out not to be needed.

Every palette was checked with the `dataviz` skill's validator in **both**
themes before any chart code was written:

| use | encoding | tokens | worst pair (dark → light) |
|---|---|---|---|
| ScoreTrend score vs felt | categorical, 2 | `accent`, `ok` | ΔE 20.8 CVD / 22.0 normal → 23.6 / 24.9 |
| HabitFelt poles | diverging, warm↔cool | `bleed` ↔ `accent`, neutral midpoint | ΔE 21.5 / 25.7 → 24.6 / 29.8 |
| CalendarHours booked vs worked | categorical, 2 | `accent`, `ok` | as row 1 |
| HabitMatrix cells | sequential, 1 hue | `accent` + opacity | n/a — categorical checks do not apply to a ramp |

**Why the habit groups are faceted instead of coloured.** The brief asked for a
"weighted group colour". This palette cannot supply four hues — and re-measuring
in round 2 showed it cannot supply **three** either.

Exactly three tokens sit inside the OKLCH lightness band in dark *and* light
(`accent`, `ok`, `bleed`; `stuck`/`warn`/`info`/`decide` are all outside it in
dark). But those three **fail together**: `ok`↔`bleed` is CVD ΔE **2.0**
(deutan) in dark and **3.5** in light, against a floor of 6 — green and red at
the same lightness is the classic red-green confusion. Every 4-hue candidate
fails on the same pair or worse (`decide`+`accent`, ΔE 1.8).

So the real ceiling is **two categorical hues, and only certain pairs**. That is
exactly what the tiles use, and no tile ever puts `ok` and `bleed` in one chart:

| tile | hues | worst pair (dark) |
|---|---|---|
| ScoreTrend | `accent` + `ok` | 20.8 ✓ |
| HabitFelt | `accent` + `bleed` | 21.5 ✓ |
| CalendarHours | `accent` + `ok` | 20.8 ✓ |
| HabitMatrix | `accent` alone (sequential) | n/a |

The skill's rule for "not enough hues" is *cut the series count, facet, or
switch chart form* — never invent one. Four habit groups therefore became four
labelled blocks, and "weighted" survives as each group's printed density figure.
A printed label also survives colourblindness, a 4px cell and a screenshot, none
of which a fourth hue does.

Reproduce (the failing three, and a passing pair):

```bash
V=<dataviz-skill>/scripts/validate_palette.js
node $V "#5b8def,#57a06b,#cf6360" --mode dark --surface "#0b0b0c" --pairs all  # FAIL 2.0
node $V "#5b8def,#57a06b"         --mode dark --surface "#0b0b0c" --pairs all  # PASS 20.8
```

## Two things `ui.tsx` could not supply

`Bars`, `Meter`, `EmptyState`, `SectionLabel`, `CARD`, `chipStyle` and
`formatDay` are all reused. **`Line` is not**, and this is the one deliberate
non-reuse: it normalises to its *own* extent (`max = Math.max(...values, 1)`
inside each call), so two `Line`s in one box are two y-scales under one axis.
With scores `[10, 60, 20]` the 7-day MA is `[10, 35, 30]` and both peaks land on
the top edge — the average appears to track the peak it exists to smooth. That
is the dataviz skill's #1 anti-pattern, and it is live in
`goals/StatsTab.tsx:310-315` today (unmounted since the week board, so not
urgent — reported to the manager chat, and deleting that tab closes it).
`ScoreTrend` therefore owns one `<svg>` on a fixed 0..100 domain.

`movingAverage` **moved here** from `goals/StatsTab.tsx` (PLAN.md §5, "extract
the primitives, delete nothing yet"). StatsTab now imports and re-exports it, so
existing importers keep working and the live panel does not depend on a file
queued for deletion.
