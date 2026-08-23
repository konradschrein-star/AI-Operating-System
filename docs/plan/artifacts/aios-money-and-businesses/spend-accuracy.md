# Is the spend number correct, and what does it mean?

Project `aios-money-and-businesses`, round 3 (fix cycle 1). Every figure below was
measured against live `content_forge` on 2026-08-23, not recalled.

## Short answer

**The old number was wrong in the way that matters: it was real arithmetic over a
notional price, presented as cash.** `€102.47 of €50 cap` was not a billing
figure. It was the sum of `spend_log.amount_eur` including rows whose provider is
`claude-code` — a **flat-rate subscription**. Konrad is not billed per token for
Claude. Adding those rows to a euro total and comparing it to a euro cap produced
a number that implied metered API billing and tripped a guardrail that exists to
protect cash.

**What Konrad actually pays for metered AI, all time, is €0.00.**

## The evidence

```
SELECT provider, kind, count(*) rows, round(sum(amount_eur)::numeric,2) eur,
       min(created_at)::date first_seen, max(created_at)::date last_seen
  FROM spend_log GROUP BY 1,2 ORDER BY 4 DESC;

  provider   |    kind    | rows |   eur   | first_seen | last_seen
-------------+------------+------+---------+------------+------------
 claude-code | llm_output | 1315 | 4088.96 | 2026-07-02 | 2026-08-23
 gemini      | llm_output |   42 |    0.00 | 2026-08-22 | 2026-08-23
 gemini      | llm_input  |   42 |    0.00 | 2026-08-22 | 2026-08-23

SELECT count(*) total_rows,
       count(*) FILTER (WHERE provider='claude-code')  claude_rows,
       count(*) FILTER (WHERE provider<>'claude-code') metered_rows,
       round(sum(amount_eur) FILTER (WHERE provider<>'claude-code')::numeric,4) metered_eur_all_time
  FROM spend_log;

 total_rows | claude_rows | metered_rows | metered_eur_all_time
------------+-------------+--------------+----------------------
       1399 |        1315 |           84 |               0.0000
```

Read that table as three separate facts:

1. **94% of all spend rows are `claude-code`.** Their €4,088.96 is a *shadow
   price* — what those tokens would have cost at Anthropic's metered API rates.
   It is a real measure of compute consumed. It is not an invoice.
2. **The only non-Claude provider ever logged is `gemini`, and it logs €0.00.**
   Gemini runs on Konrad's Google subscription; the rows carry token `units`
   (9.8M input, 696k output over the horizon) but no price, correctly.
3. **Therefore metered, out-of-pocket AI cost is €0.00 all time.** Not "small" —
   zero, across 1,399 rows and 52 days.

## What the fix was, and what it means now

`db/spend.ts` (commit `9a6ad2e`, round 2) splits the two at the SQL level with
`FILTER (WHERE provider <> 'claude-code')` and `FILTER (WHERE provider =
'claude-code')`. They are never summed into one figure. `todaySpendRollup()`
returns `total_eur` (metered, what the cap should watch) and `shadow_eur`
(notional) as separate fields, and `spendSummary()` does the same per day plus a
`total_compute_eur` that is explicitly labelled "how much compute ran, never a
cash total".

The Money surface renders them under three headings that cannot be confused:

| Tile | Reads | Means |
|---|---|---|
| METERED BILLED (REAL CASH) | €0.00 | money that leaves Konrad's account |
| CLAUDE SHADOW (SUBSCRIPTION) | €3,994.33 (30d) | notional price of Claude compute |
| TOTAL COMPUTE FOOTPRINT | €3,994.33 | the two added — a workload measure |

## What Konrad is actually spending money on

Not tokens. `spend_log` cannot answer this, and this project did not invent a
table that pretends to. The real outflows are **servers** (two Hetzner boxes),
**subscriptions** (Claude Code, Google/Gemini), **domains and SaaS**, and
**people** (VAs). Those live in the ledger, not in `spend_log` — and the ledger
currently returns zero rows over 30 days, which the surface reports as *"No
recent ledger arm transactions recorded in this timeframe"* rather than as
€0.00 revenue. That is a genuine gap in the DATA, not in the code: nothing is
writing Konrad's real bills into `ledger_entries` yet. **That is the highest-value
follow-up on this surface** — the compute cockpit is now accurate and the cash
view is accurate-but-empty.

## The one caveat that has not changed

`usage_hourly` is **box-wide**. There is no per-run attribution of token cost, so
no column anywhere claims one. A per-run euro figure would have to be invented,
and this project did not invent it.

## Residual known imprecision, disclosed

`forge-control/src/lib/mercury.ts` carries `USD_EUR_FX_RATE = 1.08`, a **static
constant, not a quote** — nothing here subscribes to an FX feed. Round 3 added
`fx_rate_source: "static_fallback"` to the `/api/accounts/bank` response and the
Money surface now renders "FX 1.08 · static, not a quote" rather than "FX: 1.08".
It is currently inert (no account is linked, so nothing is converted) and stops
being inert the moment `MERCURY_API_TOKEN` lands.
