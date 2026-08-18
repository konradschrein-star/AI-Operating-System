# phase5/premises-remeasured.md — three corpus statements, settled with output

Round 0 of phase 5 (workstream `business`), task 1 of 4. **No product code was
changed by this task.** Everything below is measurement.

Every number here carries the command that produced it (N10). Where a command
was run more than once its outputs differ, and that is itself a finding — see
P3.

- Branch: `project/7851068b-business`
- Commit measured at: `bd4601ca3541b376e8f9abc151ebb6cb1f676917`
- Instruments: `phase5/serve-pipeline.ts` (worktree API on :7841),
  `phase5/harness.mjs` (authenticated browser on :7840). Both documented in
  `phase5/browser-harness.md`.
- Connection strings: `/opt/ai-os/.secrets/forge-control.env`. `DATABASE_URL`
  is `content_forge` on 127.0.0.1:5432; `AI_OS_DATABASE_URL` is `ai_os` on
  127.0.0.1:**5434**. They are different servers, and the Money question turns
  on that.
- **Read-only.** No `INSERT`/`UPDATE`/`DELETE` was executed against any
  database, and no `pm2 restart` was run (R68).

---

## Headline: what changed for builders 2–4

| # | The corpus said | It is actually | Who must act |
|---|---|---|---|
| P1 | `AWAITING_QC`/`AWAITING_UPLOADER` fold into **render** | They fold into **`qc`**. `Publish` renders `empty` while four jobs sit at the human upload gate. | builder 2 (`db/pipeline.ts`), builder 3 (`PipelineSurface.tsx`) |
| P2 | `count` and `total` are counts | They are **caps** (20 / 500) wearing the name of a count — but at today's data (5 rows) neither cap binds, so the defect is **latent and invisible in a screenshot** | builder 2 |
| P3 | Money's `€0.00` means "no ledger entries recorded" | **Wrong twice.** The `€0.00` is `spend_log`'s non-claude sum and has nothing to do with a ledger. `ledger_entries` holds **172 rows** and **no UI renders it**. The surface already labels the claude figure "(not billed)". | builder 3 — **R70's prescribed wording would ship a falsehood** |

---

## P1 — where `AWAITING_QC` and `AWAITING_UPLOADER` actually land

**The claim.** `phase0/S-C-content-forge-state.md` §3: *"If Phase 5 keeps a flat
7-bucket model, both `AWAITING_QC` and `AWAITING_UPLOADER` are being folded into
'render' today — that is the actual defect R65 is naming."*

**It is false.** `forge-control/src/db/pipeline.ts:44-90` declares `PHASES` as an
**ordered array** and `phaseFor()` returns on the **first** match:

```ts
function phaseFor(status: string): string {
  if (status === "MARKED_FOR_DELETION") return "deleted";
  for (const p of PHASES) if (p.match.test(status)) return p.key;
  return "other";
}
```

`qc` is declared at index 4 with `match: /(QMS|QC|AWAITING)/i`; `render` is
index 5 and `publish` index 6. So `AWAITING_QC` matches `qc` (twice over) and
`AWAITING_UPLOADER` matches `qc` on the bare `AWAITING` alternative — before
`render` or `publish` is ever tested.

**Measured through the harness, against the live `content_forge`:**

```
### CMD-A
$ curl -sS http://127.0.0.1:7841/api/pipeline | node -e "<bucket dump>"
total: 5
  idea     count=0   cards=0   statuses=[]
  script   count=0   cards=0   statuses=[]
  voice    count=0   cards=0   statuses=[]
  assets   count=0   cards=0   statuses=[]
  qc       count=5   cards=5   statuses=[AWAITING_UPLOADER, AWAITING_QC]
  render   count=0   cards=0   statuses=[]
  publish  count=0   cards=0   statuses=[]
--- where did AWAITING_QC / AWAITING_UPLOADER land? ---
  AWAITING_UPLOADER  -> phase "qc"  age=11d  id=c65abcfe
  AWAITING_UPLOADER  -> phase "qc"  age=12d  id=75c0cbe8
  AWAITING_UPLOADER  -> phase "qc"  age=12d  id=bd4bfd38
  AWAITING_QC        -> phase "qc"  age=14d  id=6a9341e6
  AWAITING_UPLOADER  -> phase "qc"  age=14d  id=797bc9b0
```

Confirmed in the browser too — `before-pipeline.png` shows all five cards
stacked in the **QC** column.

### R65's defect is still real, and this is the correct statement of it

Not "a rendered job looks like a mid-render job". The two live defects are:

1. **`Publish` renders `empty` — and it is the wrong kind of empty.** Four jobs
   are `AWAITING_UPLOADER`, i.e. sitting at the gate immediately before publish,
   yet the Publish column is indistinguishable from `Idea`, `Script`, `Voice`
   and `Assets`, which are empty because *nothing was ever started*. That is
   precisely R65's "no work" vs "work stuck upstream", and today **six of seven
   columns render `0` for two completely different reasons**.
2. **`qc` conflates a machine gate with a human gate.** `QMS_VALIDATING` (an
   automated check a worker performs) and `AWAITING_UPLOADER` (a job waiting for
   a VA to open `hub-web` on port 3000) are the same bucket. S-C §4 established
   that no worker will *ever* pick these up — `dispatch-next.ts` explicitly
   refuses to dispatch them. A column that mixes "a worker is on it" with "no
   worker will ever be on it" cannot answer the only question Konrad asks of
   this screen.

S-C's recommended fix — an eighth bucket, or a `blocked_on: "VA"` flag — stands.
Only its diagnosis of the current bucketing was wrong.

---

## P2 — `count` and `total` are caps, and today the caps do not bind

**The claim, confirmed by reading.** `db/pipeline.ts:150` pushes a card only
`if (arr.length < 20)`, and `count` is reported as `phaseMap.get(p.key)?.length`
— *the length of the truncated array*, not the number of matching rows. `total`
is `r.rows.length` under `LIMIT 500` (line 133). Both are caps named as counts.
A 21st job in one phase would silently not exist for the surface, and the
`count` badge would say `20`.

**But the caps do not bind at today's data, and that matters for the fix.**

```
### CMD-B
$ psql "$DATABASE_URL" -c "SELECT status::text, count(*) FROM content_jobs GROUP BY 1 ORDER BY 2 DESC;"
       status        | count 
---------------------+-------
 MARKED_FOR_DELETION |    19
 AWAITING_UPLOADER   |     4
 AWAITING_QC         |     1
(3 rows)

$ psql "$DATABASE_URL" -c "<the surface WHERE clause, no LIMIT>"
      status       | count 
-------------------+-------
 AWAITING_UPLOADER |     4
 AWAITING_QC       |     1
(2 rows)

 rows_matching_where 
---------------------
                   5
(1 row)

$ psql "$DATABASE_URL" -c "<ages>"
   id8    |      status       |     status_updated_at      |       age        
----------+-------------------+----------------------------+------------------
 797bc9b0 | AWAITING_UPLOADER | 2026-08-04 01:01:34.885+00 | 14 days 18:40:13
 6a9341e6 | AWAITING_QC       | 2026-08-04 11:53:01.457+00 | 14 days 07:48:46
 bd4bfd38 | AWAITING_UPLOADER | 2026-08-05 20:37:24.549+00 | 12 days 23:04:23
 75c0cbe8 | AWAITING_UPLOADER | 2026-08-05 21:26:34.847+00 | 12 days 22:15:13
 c65abcfe | AWAITING_UPLOADER | 2026-08-06 21:50:26.252+00 | 11 days 21:51:21
(5 rows)

```

**True per-bucket numbers, right now:** `qc` = 5 (4 `AWAITING_UPLOADER` +
1 `AWAITING_QC`); every other bucket = 0. `total` = 5. The whole `content_jobs`
table is 24 rows, 19 of them `MARKED_FOR_DELETION`.

So: `count: 5` and `total: 5` are **numerically correct today** and will stay
correct until a bucket exceeds 20 or the table exceeds 500 live rows. Two
consequences builder 2 must not miss:

- **No screenshot can show this defect.** It cannot be reproduced by looking; it
  is proven by reading the code, which is what the block above does. A reviewer
  asking for a before/after picture of P2 is asking for something that does not
  exist.
- **Do not "fix" it by raising the cap.** The cap on `cards` is a legitimate
  payload limit. The bug is that `count` is derived from the capped array
  instead of from the match. `count` should come from a `COUNT(*)` over the
  matching statuses (or from the pre-truncation tally), and `total` should be a
  real total with the LIMIT reported separately — otherwise it will be wrong
  precisely on the day the pipeline gets busy, which is the day it matters.

**R64 evidence, for free, from the same query.** Ages at
`2026-08-18 19:27:24 UTC`: 14d18h, 14d07h, 12d22h, 12d22h, 11d21h. The 11–14
day band in the vision doc holds. The surface renders these as `11d`/`12d`/`14d`
in `humanAge()` — but as ordinary metadata in the corner of a card, with no
stall treatment whatsoever. See `before-pipeline.png`.

**There is no fresh job to prove the not-stalled branch against, and R68 forbids
creating one.** Use `serve-pipeline.ts`'s stub mode (`PIPELINE_STUB_FILE`) —
that is what it exists for. See `browser-harness.md` § "Mode B".

---

## P3 — the Money premise, wrong twice, and R70's prescribed label is worse

```
### CMD-C
$ psql "$DATABASE_URL" -c "<R70 30-day figure, verbatim from the brief>"
 non_claude_eur | claude_code_eur | rows_30d 
----------------+-----------------+----------
              0 |       2773.4815 |      837
(1 row)

$ psql "$DATABASE_URL" -c "<spend_log all-time by provider>"
  provider   | count |    eur    |             first             |             last              
-------------+-------+-----------+-------------------------------+-------------------------------
 claude-code |   964 | 2868.1100 | 2026-07-02 19:39:03.231984+00 | 2026-08-18 19:40:52.055065+00
(1 row)

$ psql "$AI_OS_DATABASE_URL" -c "SELECT count(*) FROM ledger_entries;"   # ai_os on :5434
 ledger_entries 
----------------
            172
(1 row)

 direction | count |  eur   |   first    |    last    
-----------+-------+--------+------------+------------
 out       |   172 | 176.07 | 2026-07-02 | 2026-08-03
(1 row)

$ grep -rn "api/ledger" forge-control-web/app
(no hits — zero consumers in forge-control-web)
```

### P3a — the numbers

| Figure | Brief's value | Measured now | Note |
|---|---|---|---|
| `spend_log` 30d, `provider <> 'claude-code'` | 0 | **0** | confirmed |
| `spend_log` 30d, `provider = 'claude-code'` | 2735.1686 | **2773.4815** | **it moved while this task ran** |
| `spend_log` 30d row count | 829 | **837** | likewise |
| `ledger_entries` (ai_os :5434) | 172 | **172** | confirmed, and all 172 are `direction='out'`, €176.07 total, `occurred_on` 2026-07-02 → 2026-08-03 |

**`spend_log` is a live, monotonically growing table, and this run is writing to
it.** The three measurements above were taken minutes apart and returned
2735.1686 → 2766.7064 → 2773.4815. Builder 3 must therefore render this figure
**from a query at request time and never from a constant**, and any test that
asserts an exact euro value will be flaky by construction. Assert the *shape*
(a positive number, the "not billed" label) — not the amount.

### P3b — what the Money surface ACTUALLY says today

Read `before-money.png` before writing a line of R70. The surface is titled
**"Money · AI Spend"**, subtitled `spend_log · gateway estimates, not invoices`,
and its standfirst already reads:

> *"the totals below are real spend only — images, TTS, video, everything
> actually billed. claude-code is excluded: you're on a flat-rate subscription,
> so its number (shown small, under each total) is just what those tokens
> would've cost on metered API pricing — not money that left your account."*

The 30-day tile reads `€0.00` / `0 calls · €0.00/day` / `+ €2,766.71 claude (not
billed)`, and the "where it goes" panel reads `claude-code · llm_output ·
€2,766.71 · 836 calls`.

**So R70's premise does not survive contact with the screen.** The shadow price
is *already* labelled "(not billed)" and *already* explained in prose. And the
`€0.00` is not a revenue figure and never was — it is the non-claude spend sum.

### P3c — R70's prescribed wording would introduce a falsehood

> R70: *"The Money tab's `€0.00` is labelled honestly as **'no ledger entries
> recorded'** rather than implying zero revenue."*

Shipping that label would state something untrue on three counts:

1. The `€0.00` is computed from `spend_log`, on `content_forge` (:5432). The
   ledger is `ledger_entries`, on `ai_os` (:5434). **Different table, different
   database.** The figure cannot report on entries it never reads.
2. `ledger_entries` is **not empty** — 172 rows. "No ledger entries recorded" is
   false as a statement about the ledger.
3. The tile is a *spend* tile on a surface titled *AI Spend*. It never implied
   zero revenue; it implies zero **non-claude API spend**, which is exactly what
   it is and exactly what happened (the last non-claude row is older than 30
   days; `spend_log` has one provider, all-time).

### P3d — the honest defects that ARE on this surface

Handing builder 3 the real list, all inside R69/R70's "labels only" scope:

1. **The typographic hierarchy inverts the truth.** `€0.00` is set in the
   largest type on the screen; `+ €2,766.71 claude (not billed)` is small grey
   text beneath it. The number that is zero shouts; the number that is nearly
   three thousand whispers. This — not the wording — is what makes the tile
   read as "nothing happened".
2. **`0 calls` contradicts `836 calls` on the same screen.** The tile says
   `0 calls`; the panel eighteen centimetres to its right says `836 calls`. One
   of them needs a qualifier ("0 billed calls").
3. **"no spend recorded in the last 30 days"** sits directly beside a chart
   showing €2,766.71 of it. Same fix: the word missing is *billed*.
4. **The 172-row ledger is rendered by nothing.** `GET /api/ledger/summary`
   exists (`forge-control/src/routes/ledger.ts:95`) and is mounted
   (`index.ts:161`). `grep -rn "api/ledger" forge-control-web/app` returns
   nothing. If Konrad ever wondered where his €176.07 of recorded outgoings
   went, they are in a table with a working endpoint and no screen. That is a
   *finding*, not a licence to build the screen — R69 says no feature work on
   Money. **Report it in `money-keep-cost.md` and let Konrad rule.**
5. **The ledger holds no revenue.** All 172 entries are `direction='out'`. So
   "zero revenue recorded" happens to be TRUE of the ledger — just not of the
   figure R70 points at. If a revenue statement is wanted, it belongs on a tile
   sourced from `ledger_entries`, not on the AI-spend tile.

**Recommendation to the phase-5 reviewer:** treat R70 as satisfied by (1)–(3)
plus a written record of (4)–(5), and record that its literal wording was
measured and rejected. Implementing it verbatim would trade one misleading
label for one false one.

---

## What this task did NOT settle

- **R59's spine ruling.** Not this task's scope; still owed by whoever escalates
  it. The `forge:ui` escalation route is currently **unavailable**: the manager
  chat `bfd1283a-b71b-4f35-b577-7d09aad803f2` is in a FAILED state and
  `POST /api/runs/.../message` answers `409 {"error":"run failed - use POST
  /api/runs/:id/resume-chat to reopen it"}`. Findings from this task were sent
  as reminders instead. **Do not call `resume-chat`** — a failed manager run
  drops worker reports.
- **R66 / R67** (worker health, queue depth). Neither exists on the surface at
  all today — there is no pm2 panel and no queue panel in `PipelineSurface.tsx`.
  They are *unbuilt*, not broken. S-C §1–§2 already has the probe recipes.
- **The Businesses figures.** `before-businesses.png` shows `5 ventures · 22
  properties` — the brief says 25 properties. Whoever builds R62/R63 should
  settle 22 vs 25 before quoting either.
