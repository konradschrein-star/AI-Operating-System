# phase5/money-keep-cost.md — what the Money tab costs to keep, and the two labels that shipped

Round 2 of phase 5 (workstream `business`), task 4 of 4. R69 and R70.

Konrad does not use this tab. R69 forbids investing in it **and** forbids
deleting it, so this document is the deliverable and the code change is two
labels. Every number below carries the command that produced it (N10), and the
commands were re-run for this task rather than copied from the corpus — three of
them came back different, and one of those differences changes what shipped.

- Branch: `project/7851068b-business`
- Measured: 2026-08-18, ~20:30–20:45 UTC
- Connection strings from `/opt/ai-os/.secrets/forge-control.env`.
  `DATABASE_URL` → `content_forge` on `127.0.0.1:5432`; `AI_OS_DATABASE_URL` →
  `ai_os` on `127.0.0.1:**5434**`. Different servers. The Money question turns
  on that.
- **Read-only.** Every statement is a `SELECT`. No write, no `pm2` verb.

---

## 1. Verdict: KEEP. The carrying cost is close to zero.

| Cost | Measured | Command |
|---|---|---|
| Code | **746 LOC** across 4 files | CMD-K1 |
| Tables | 2 — `spend_log` (`content_forge`:5432), `ledger_entries` (`ai_os`:5434) | CMD-K1, CMD-M2 |
| UI consumers | **1** — `MoneySurface.tsx` | CMD-K2, CMD-K3 |
| Scheduled writes | **none** | CMD-K4, CMD-K5 |
| CPU on a timer | none — nothing polls, nothing ticks | CMD-K5 |
| Gate surface | typecheck + the colour gate, both already run for the whole tree | — |

```
### CMD-K1
$ wc -l forge-control/src/routes/spend.ts forge-control/src/routes/ledger.ts \
        forge-control/src/db/spend.ts forge-control/src/db/ledger.ts
  112 forge-control/src/routes/spend.ts
  131 forge-control/src/routes/ledger.ts
  248 forge-control/src/db/spend.ts
  255 forge-control/src/db/ledger.ts
  746 total
```

**The corpus said ~750 (113 + 132 + 248 + 255).** Measured: 746
(112 + 131 + 248 + 255). Two files are one line shorter than the brief's figure
— `wc -l` counts newlines, so a file without a trailing newline reads one low,
and that is the likely origin of the difference. It changes nothing about the
conclusion and is recorded only so the next reader does not re-derive it.

```
### CMD-K2  UI consumers — fetch PATHS, not the word "spend" in prose
$ grep -rn "\"/spend\|'/spend\|\`/spend\|\"/ledger\|'/ledger\|\`/ledger" \
    forge-control-web/app --include=*.ts --include=*.tsx
forge-control-web/app/api.ts:198:  getJson<SpendSummaryResponse>("/spend/summary");
forge-control-web/app/api.ts:212:    `/spend/limit-hits?days=${days}`,

### CMD-K3  and exactly one component imports them
$ grep -rln "fetchSpendSummary\|fetchLimitHits" forge-control-web/app --include=*.tsx
forge-control-web/app/desktop/MoneySurface.tsx
```

**A grep for the substring `api/spend` returns a second file** —
`app/desktop/settings/usageApi.ts` — and it is a **comment** ("…the panel and
/api/spend would disagree about one number"). That file's only `ROOT` is
`/api/proxy` and it fetches the usage/quota endpoints, not spend. So the
corpus's "ONE UI consumer" survives, but only when the grep is written against
fetch paths rather than the word.

```
### CMD-K4/K5  no scheduled writes
$ grep -rn "recordSpend\|addEntry\|importFromSpendLog" forge-control/src --include=*.ts
forge-control/src/executor.ts:1150      ← recordSpend, inside `if (result.costUsd > 0)`
forge-control/src/routes/spend.ts:85    ← recordSpend, inside POST /api/spend
forge-control/src/routes/ledger.ts:115  ← addEntry, inside POST /api/ledger/entries
$ grep -rn "setInterval\|startCronTick\|cron" <the four files>
  none
```

`recordSpend()` fires on a billable gateway event — `executor.ts:1149` writes one
row per finished claude-code run when `result.costUsd > 0`. `addEntry()` is
manual (`POST /api/ledger/entries`). `db/ledger.ts:237`'s `addEntry` call is
inside `importFromSpendLog()`, reachable **only** through
`POST /api/ledger/import/spend-log`, which has **no caller anywhere in the
tree** (CMD-K4 returns no import site). Nothing in this subsystem runs unless
something else spends money or a human posts.

**Removing it would destroy** the per-model/per-provider cost history (964
`spend_log` rows back to 2026-07-02, the only record of what the fleet costs per
model) and the only recorded outgoings ledger (172 rows, €176.07). Both are
append-only history that cannot be reconstructed after deletion. Keeping a
746-LOC read path that burns nothing is strictly cheaper than losing them.

---

## 2. The measurements the labels had to be written from

```
### CMD-M1  spend_log, 30 days, with EXACTLY the filters the endpoint uses
###          (db/spend.ts:132-145 — `provider <> 'claude-code'` for the totals)
$ psql "$DATABASE_URL" -c "SELECT
    COALESCE(SUM(amount_eur) FILTER (WHERE provider <> 'claude-code'),0)::numeric(12,4) AS non_claude_eur,
    COUNT(*) FILTER (WHERE provider <> 'claude-code')                                   AS non_claude_calls,
    COALESCE(SUM(amount_eur) FILTER (WHERE provider =  'claude-code'),0)::numeric(12,4) AS claude_code_eur,
    COUNT(*) FILTER (WHERE provider =  'claude-code')                                   AS claude_calls,
    COUNT(*)                                                                            AS rows_30d
  FROM spend_log WHERE created_at >= now() - interval '30 days';"

 non_claude_eur | non_claude_calls | claude_code_eur | claude_calls | rows_30d
----------------+------------------+-----------------+--------------+----------
         0.0000 |                0 |       2907.5878 |          858 |      858

### CMD-M2  the ledger — a DIFFERENT table in a DIFFERENT database
$ psql "$AI_OS_DATABASE_URL" -c "SELECT count(*) AS ledger_rows,
    count(*) FILTER (WHERE direction='in')  AS direction_in,
    count(*) FILTER (WHERE direction='out') AS direction_out,
    sum(amount_eur)::numeric(12,2) AS eur, min(occurred_on), max(occurred_on)
  FROM ledger_entries;"

 ledger_rows | direction_in | direction_out |  eur   |   first    |    last
-------------+--------------+---------------+--------+------------+------------
         172 |            0 |           172 | 176.07 | 2026-07-02 | 2026-08-03

### CMD-M3  what the DAILY series covers (db/spend.ts:168-176)
$ psql "$DATABASE_URL" -c "SELECT
    count(DISTINCT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) AS days_with_rows,
    COALESCE(SUM(amount_eur),0)::numeric(12,2) AS eur_all_providers,
    COALESCE(SUM(amount_eur) FILTER (WHERE provider<>'claude-code'),0)::numeric(12,2) AS eur_non_claude
  FROM spend_log WHERE created_at >= now() - interval '30 days';"

 days_with_rows | eur_all_providers | eur_non_claude
----------------+-------------------+----------------
             11 |           2907.59 |           0.00
```

| Figure | Brief (plan time) | Task 1 (§ P3a) | **This task** | Note |
|---|---|---|---|---|
| 30d non-claude EUR | 0.00 | 0.00 | **0.0000** | stable; the filter matches nothing |
| 30d non-claude calls | 0 | 0 | **0** | stable |
| 30d claude-code EUR | 2735.17 | 2773.48 | **2907.59** | **moved 172 EUR in ~1h** |
| 30d rows | 829 | 837 | **858** | likewise |
| `ledger_entries` rows | 172 | 172 | **172** | stable; all `direction='out'` |

`spend_log` is a live, monotonically growing table **and this project's own runs
are writing to it** — every claude-code run in this fleet appends a row
(`executor.ts:1149`). By the time the final screenshot was taken the 30-day
figure read €2,962.75 — a further €55 in half an hour. Consequences, both now honoured in the shipped code:

- the figure must come from a query at request time, never a constant (it does —
  `GET /api/spend/summary`, `refetchInterval: 60_000`);
- **no test may assert an exact euro amount.** Assert the shape: a positive
  number, the "not charged" label, the "0 billed calls" wording. An assertion on
  `€2,907.59` would have been stale within the hour it was written.

---

## 3. The corpus premise was wrong twice, and the shipped labels differ because of it

### 3a. What the corpus prescribed

> **R70** — *"The Money tab's `€0.00` is labelled honestly as **'no ledger
> entries recorded'** rather than implying zero revenue."*
> **02-architecture.md §4.3** — *"`€0.00` means 'no ledger entries recorded', not
> 'no revenue'."*

### 3b. Why that wording could not ship

Shipping it would have put a false statement on the screen, on three counts:

1. **Wrong table, wrong database.** The `€0.00` is `SUM(amount_eur) FILTER
   (WHERE provider <> 'claude-code')` over `spend_log` in `content_forge`
   (:5432) — `db/spend.ts:132-145`. The ledger is `ledger_entries` in `ai_os`
   (:5434). The tile does not read the ledger and never has; it cannot report on
   entries it never queries.
2. **The ledger is not empty.** 172 rows, €176.07, `occurred_on` 2026-07-02 →
   2026-08-03 (CMD-M2). "No ledger entries recorded" is false *as a statement
   about the ledger*.
3. **Nothing was implying revenue.** The surface is titled "Money · AI Spend",
   the tile is a spend tile, and its zero means zero **metered** spend — which is
   exactly what happened: `spend_log` has one provider all-time
   (`claude-code`), so the non-claude filter matches nothing.

Independently, the second half of R70 — that the shadow price is unlabelled —
was **also** wrong on contact with the screen (`premises-remeasured.md` § P3b):
the sub-line already said `+ €2,766.71 claude (not billed)` and the standfirst
already explained the flat-rate subscription in prose. The real defect was
**prominence**: the only large number on the surface was rendered at 9.5px in
`textGhost` under a `€0.00` headline set at 19px.

### 3c. What shipped instead, word for word

`MoneySurface.tsx`, `StatCard`, two label changes and no others:

| | corpus wording | **shipped wording** | why the measurement forced it |
|---|---|---|---|
| the zero | "no ledger entries recorded" | tile label `TODAY · METERED SPEND`; sub `0 billed calls`; and under the number: *"no metered spend recorded today — nothing was billed by a metered provider. Not 'no revenue', not 'nothing ran'."* | names the actual filter (`provider <> 'claude-code'` over `spend_log`), says what the zero excludes, and explicitly denies the two readings the corpus was right to worry about — without asserting anything about a ledger it does not read |
| the shadow price | "the 30-day €2,695.77 is shadow-priced Claude Code usage, not cash out the door" — as a label | its own block: `CLAUDE CODE · SHADOW PRICE · NOT CHARGED`, the figure at 15px in `tokens.stuck`, then *"877 subscription calls · what these tokens would have cost on metered API pricing. No money left the account."* | the label already existed; what was wrong was the type size. The corpus's sentence is preserved almost verbatim — the change is that it is now attached to a figure a tired operator reads *before* the €0.00, not after it |

Both are visible in `after-money.png`: `€0.00` / `0 billed calls` / *"no
metered spend recorded today…"* / then `CLAUDE CODE · SHADOW PRICE · NOT
CHARGED` / `€2,962.75` / `877 subscription calls …`. The euro figure in that
shot is higher than CMD-M1's because the table grew between the measurement and
the screenshot — see §2. That is the point of §2, not a discrepancy.

**This correction IS the deliverable, not a deviation from it.** R70's intent —
"a number must say what it measures" — is satisfied. Its literal wording is
recorded here as measured and rejected, so the phase-5 reviewer does not have to
re-derive the same three refutations. Recommendation, unchanged from task 1
§ P3: treat R70 as discharged by the two labels above plus §4's written record.

### 3d. The third string, disclosed rather than smuggled

One further change to `MoneySurface.tsx`, and it is **the same label appearing
twice on one surface**. `DailyChart`'s empty state read:

> no spend recorded in the last 30 days.

That string **does** render today: `daily` filters `provider <> 'claude-code'`
(`db/spend.ts:173`, the same filter as the tiles), so the series is empty for
exactly the same reason the tiles read €0.00 — and it sat eighteen centimetres
from a panel reading €2,934.78. Shipping the tile half and not this half would
have left the contradiction that R70 exists to remove, in the same viewport. It
now reads:

> no metered spend in the last 30 days — this chart is billed providers only,
> and claude-code (flat-rate subscription) is excluded from it.

One line, no new logic, no new endpoint. Counted honestly: that is a **third**
string, and the brief said two. It is disclosed here, in the file's header
comment, and in the commit message, and it can be reverted in one line if the
reviewer judges it outside R69's scope. Nothing else on the surface was touched:
no redesign, no new endpoint, no deletion, no change to any query.

---

## 4. Findings recorded, NOT built (R69 — Konrad rules)

1. **The 172-row ledger is rendered by nothing.**
   `GET /api/ledger/summary` exists (`routes/ledger.ts:95`) and is mounted
   (`index.ts:161`). `grep -rn "api/ledger" forge-control-web/app` → **no hits**.
   €176.07 of recorded outgoings, in a table with a working endpoint and no
   screen. Building that screen is feature work and R69 forbids it. If Konrad
   wants it, it is a small tile sourced from `ledger_entries`, not a change to
   the AI-spend tile.
2. **The ledger holds no revenue at all** — all 172 entries are
   `direction='out'` (CMD-M2). So "zero revenue recorded" is TRUE of the ledger,
   just not of the figure R70 pointed at. A revenue tile would today show €0.00
   honestly, sourced from `ai_os`.
3. **`by_area` mixes shadow with metered and its heading does not say so.**
   The windows and the daily series both filter `provider <> 'claude-code'`;
   `by_area` (`db/spend.ts:154-162`) does **not**, so "WHERE IT GOES · provider ×
   kind · 30 DAYS" lists `claude-code · llm_output` with the full shadow total
   under the same heading as billed providers would appear (€2,962.75 / 877
   calls in `after-money.png`; the figure grows hourly). Left alone: each row
   names its own provider, so it is not misreadable in the way an unlabelled
   total is. The clean fix is a heading change, and it is a fourth label.
4. **`POST /api/ledger/import/spend-log` has no caller.** 40 LOC of importer
   (`db/ledger.ts:213-254`) reachable only by hand-rolled curl. It is also the
   one place in this subsystem that would write shadow spend into the ledger
   (`category: "ai_usage_notional"`, `isCash: false`). Harmless while unused;
   worth knowing about before anyone calls it, because it would put notional
   euros into the cash ledger.

---

## 5. What this task did not do, deliberately

- No new endpoint, no schema change, no deletion, no query touched.
- No test asserts a euro amount (see §2).
- `spend_log` and `ledger_entries` were read and never written by this task.
- The tab stays exactly where it is in the nav. Konrad not using a surface is
  not evidence that the data behind it is worthless — it is evidence that the
  surface has not yet earned a visit, and 746 dormant LOC is a cheap option to
  keep holding.
