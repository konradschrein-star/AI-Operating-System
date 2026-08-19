# phase5/GATE-review.md — Phase 5 gating review: Businesses, Pipeline, Money

**VERDICT: NEEDS_FIXES** — one blocker, and it is a gate regression, not a defect in the product
work. Everything R59–R70 and N1–N10 actually asked for was built, and I verified it myself rather
than reading the builders' reports back to them.

| | |
|---|---|
| Tip reviewed | **`f4fa30c52f77492a5d6f35efce09778e082a2baa`** (`git rev-parse HEAD`, worktree `…7851068b…--business`) |
| HEAD re-read before writing the blocker | 2026-08-18T21:24:36Z — still `f4fa30c`, unmoved |
| Blocker re-confirmed at that tip | 2026-08-18T21:24:41Z |
| Branch | `project/7851068b-business`, off `project/7851068b` |
| Diff reviewed | `git diff 3f98e67114a8a1fd12fced068e2238b51c766462...HEAD` — 30 files, +8397 / −201 |
| Quality document used | **`docs/plan/os-usable-for-work/03-quality.md`** (the per-project path). `docs/plan/03-quality.md` also exists — it is the older repo-wide corpus; I read both and reviewed against the per-project one, which is the one this project was planned under. |
| Gate suite | `scripts/checks/gates-808.sh --strict` |

---

## 0. The blocker, in one paragraph

`gates-808.sh --strict` gate 8 (`dollar-sweep.sh`) is **RED at HEAD and GREEN in this lane's
baseline**. Two lines added by `c94b10d` in `businesses-inventory.ts` are currency-shaped and
unlisted. Both are *legitimate content* — one is the spec's own Axtrelis price list, the other is
the word "spend" inside a qualification criterion — so the fix is two scoped allowlist rows, not a
content change. It is perhaps ten minutes of work. But the rule is NO NEW RED versus the baseline,
the suite is what enforces it, and no builder in this phase ran the suite after the product code
landed: `grep -rl gates-808 phase5/` returns only `browser-harness.md` and the baseline file itself.
That is the whole of the NEEDS_FIXES.

---

## 1. The mandated command block, verbatim

`NODE_ENV=production` was in the environment for all of it — the tell the brief asks for is quoted
below.

```
=== NODE_ENV=production ===
=== [1] forge-control install ===
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 1s using pnpm v9.15.9
EXIT=0
=== [2] forge-control-web install ===
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 1s using pnpm v9.15.9
EXIT=0
=== [3] forge-control tsc ===
EXIT=0
=== [4] forge-control-web tsc ===
EXIT=0
=== [5] forge-control pnpm test ===
…
# tests 1347
# suites 250
# pass 1347
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5963.36952
EXIT=0
```

**On the `+ typescript` / `- typescript` line the brief asks me to quote: it is ABSENT, in both
packages, and its absence is the good outcome.** `--prod=false` was passed, the tree was already
installed with devDependencies by the builders, so pnpm printed `Already up to date` and listed no
package delta at all — neither a `+` nor a `-`. The dangerous transcript is the one carrying
`- typescript`; this one carries neither. I did not take the silence on trust:

```
$ ls forge-control/node_modules/.bin/tsc   →  forge-control/node_modules/.bin/tsc
$ cd forge-control && npx tsc --version    →  Version 5.9.3
```

typescript is present, and both typechecks then ran to `EXIT=0`, which they could not have done
under the pruning failure mode.

---

## 2. The gate suite

`bash scripts/checks/gates-808.sh --strict`, Bash `timeout 600000`. **Run twice.** The first run is
void and I am recording why: I had launched it in the background and then ran the flip-test
mutations against `pipeline-health.ts` while it was still going, so its gate 20 (`pnpm test`) caught
my own mutated subject and reported `1343/4`. That is contamination by the reviewer, not a property
of the tree. I restored the file by sha256, confirmed `git status --porcelain` empty, and re-ran the
whole suite serially. **Only the second run is evidence.**

```
 SUMMARY — 25 gates
================================================================================
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  1      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)
 13 0      check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does
 14 0      check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces
 15 0      check-team-rows.ts — flatten, hiddenRows, frozen time
 16 0      check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
 22 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 1
GATES_EXIT=1
```

**EXECUTED: 23. RED: 1 (gate 8). SKIPPED-by-design: 2 (gates 23 and 24 — the browser gates, which
require `--browser` and their own `PHASE600_BASE_URL`/`PHASE700_*` port set; they are skipped in the
baseline too, so this is not a gate that silently stopped running).**

**Gate 17 is GREEN, 92/92.** The brief calls it a known pre-existing red; that is superseded and has
been for some time. I am recording it so the next reader does not go looking for a red that is not
there.

**The baseline this is measured against** is `phase5/gates-baseline-business.txt`, captured by task 1
at this branch's tip. **This is a LANE-LOCAL baseline and must be reconciled at integration** — the
project baseline from phase 1 lives in the `vault` worktree and is not present here. Its summary is
`RED: 0`, all 25 rows zero, same two SKIPPED. So the delta is exactly one gate: **8, 0 → 1.**

### 2.1 The `forbidden-file diff` gate — adjudicated, not waved through

Gate 6 (`forbidden-file diff — three-dot main...HEAD`) **did not trip**: `EXIT=0`, identical to the
baseline. I checked its subject independently rather than trusting the exit code. Nothing in this
diff touches `DesktopApp.tsx`, `nav-items.ts`, `app/api.ts`, `forge-control/src/index.ts` or
`routes/pm2.ts`:

```
$ git diff --name-only 3f98e67...HEAD | grep -E "DesktopApp.tsx|nav-items.ts|app/api\.ts|forge-control/src/index.ts|routes/pm2.ts"
(no output, rc=1)
```

The lane took the documented escape hatch instead: `app/api-business.ts` is a new client file, so the
contended `app/api.ts` is untouched (02-architecture.md §0.3). That is the right call and it is why
this gate is green rather than adjudicated.

---

## 3. THE FLIP TEST — both layers, run by me

### 3a. Layer (a) — the unit tests bite, in BOTH directions

I mutated `pipeline-health.ts` myself and watched the assertions flip. `cp` to `/tmp/ph.orig` first,
restore-and-verify by sha256 after each (`98b0d0316e533ffb285187001a076bd54aa319e798be2eedb274cf8fcd30f506`,
matched after every restore; `git status --porcelain` empty at the end).

| Mutation | Failing subtests |
|---|---|
| `stalled: t < stallCutoffMs(...)` → `stalled: true` | `THE FLIP: a job updated NOW is NOT stalled` · `THE FLIP: an hour-old job is not stalled, a fortnight-old one is` · `the boundary is asserted BOTH ways, one minute either side` · `the boundary moves with the threshold` |
| → `stalled: false` | `the five live QC jobs render stalled with their real ages` · `THE FLIP: an hour-old…` · `the boundary is asserted BOTH ways…` · `the boundary moves with the threshold` |
| `classifyPhaseState`'s upstream scan → always empty | `THE WHOLE OF R65: two zero columns, two different sentences` · `blocked-upstream names every upstream phase holding work` · `singular/plural is written for a human` |

The two stall mutations fail **different** first tests, which is the property that matters: a suite
that only asserted "the five render stalled" would have survived the always-true mutation. It does
not. The boundary is asserted at 47h59m (`false`) and 48h01m (`true`), one minute either side.

**The threshold is not imported from the subject.** `pipeline-health.test.ts:23-32` imports
`DEFAULT_STALL_AFTER_HOURS` but every stall assertion passes the literal `48`, so the tests do not
move when the constant does. That is the difference between an assertion and a tautology.

### 3b. Layer (b) — a fresh job renders NOT stalled, in the browser, beside the stalled five

I did not re-use the builder's shot. I re-ran the whole protocol: `stub-pipeline.mjs` on `:7843`,
`serve-pipeline.ts` on `:7841`, `forge-control-web` **rebuilt** with
`FORGE_CONTROL_URL=http://127.0.0.1:7841` (the rewrite is baked into `.next/routes-manifest.json` at
build time — verified `['http://127.0.0.1:7841']` before starting), `next start -p 7840` under
`AUTH_URL=http://127.0.0.1:7840`, then the manifest patched to `:7843` and next restarted for the
stub pass.

Harness controls, both required, both green:

```
PASS  positive control — valid cookie reaches /desktop with the real nav — nav has TODAY/PIPELINE/MONEY/BUSINESSES
PASS  negative control — tampered cookie redirects to /signin
PASS  negative control — no cookie at all redirects to /signin
5/5 PASS
```

An unauthenticated `GET /api/proxy/pipeline` answered `HTTP/1.1 307` to `/signin`, not a 200 carrying
the sign-in page — so the wall is real and the shots below are of the authenticated app.

**Result (stub pass, `/opt/ai-os/uploads/4ba240ffd4f2/stub/20260818T212013Z-before-pipeline.png`,
Read back inline):** in the QC column, top card

```
AWAITING_QC   moving · 3m     STUB — a job whose status changed three…
AWAITING_UPLOADER  STALLED 11d   MacBook Air M3 vs Dell XPS 15
AWAITING_UPLOADER  STALLED 12d   Best budget standing desks under 400
…
```

Header: `6 active jobs · 5 stalled · stall threshold 48h`. The two opposite verdicts are one above
the other in the same column, with different type, colour and rule treatment. **A component that
marked everything stalled cannot produce this screen.**

The banner reads `5 of 6 jobs have not moved in over 48h` and `5 of the stalled jobs are waiting on
a human` — **5, not 6.** That is the defect `flip-test.md` §5 says the flip test caught on its first
run (the human-gate filter had been counting the fresh `AWAITING_QC` card into a sentence about
stalled ones, invisible against live data where every gate card is stalled). I confirm it is fixed at
HEAD, by re-running the thing that found it.

---

## 4. R68 — read-only against Content Forge. Clean.

```
$ git diff 3f98e67...HEAD -- '*.ts' '*.tsx' '*.mjs' | grep '^+' | grep -iE '\b(INSERT +INTO|UPDATE +[a-z_]+ +SET|DELETE +FROM|TRUNCATE|DROP +TABLE|ALTER +TABLE)\b'
(no output, rc=1)
```

Every `pm2` occurrence in an added line is either prose in an artefact or the string `pm2 jlist`.
There is no `pm2 restart`, `reload`, `stop`, `delete` or `start` anywhere in the diff, in code or in
a script. `routes/pipeline.ts` issues `getPipeline()` (SELECTs), `getWorkerHealth()` (`pm2 jlist`) and
`probeQueueDepths()` (`TYPE`/`LLEN`/`ZCARD`, plus `AUTH`/`SELECT` on the redis connection) and
nothing else.

**N4 — the live checkout.** Every `/opt/forge-ai-os` reference in the diff is a read of
`forge-control-web/.env.local` for `AUTH_SECRET`, which N4 explicitly permits, or prose saying so.
`forge-control/src/index.ts` appears only in comments explaining that it must never be booted.

```
$ git -C /opt/forge-ai-os status --porcelain
(no output — the only passing result)
```

Run twice: once at the start of this review, once immediately before writing this verdict. Empty both
times. **Nobody hot-applied anything into the live checkout.**

---

## 5. R66/R67/N1 — the unreachable path, PRODUCED rather than asserted

The diff is clean of the patterns:

```
$ git diff 3f98e67...HEAD -- <the nine code files> | grep '^+' | grep -E 'catch *\{ *\}|\?\? *0|\|\| *\[\]|\|\| *0\b'
```

Every hit is a comment saying the pattern is forbidden. Two real `?? []` survive, both in
`PipelineSurface.tsx`, both `cardsByPhase.get(k) ?? []` over a Map built from the *same successful*
response — a phase with no cards genuinely has no Map entry. Neither substitutes for a failed query.
The five `catch` blocks all either rethrow with the offending value or return `{ok:false, error}`.

**Then I broke it myself.** I started `serve-pipeline.ts` against the real `content_forge` and the
real pm2, with `REDIS_URL=redis://127.0.0.1:6399` — a dead port. At the API:

```json
"queues": {"ok": false, "as_of": "2026-08-18T21:17:57.636Z",
           "endpoint": "127.0.0.1:6399",
           "error": "connect ECONNREFUSED 127.0.0.1:6399"}
```

And on the surface (`/opt/ai-os/uploads/4ba240ffd4f2/20260818T211924Z-before-pipeline.png`, Read back
inline), the QUEUES panel renders, in warn:

> **queue not reachable: connect ECONNREFUSED 127.0.0.1:6399**
> endpoint 127.0.0.1:6399 · probed 2026-08-18 21:19:22Z
> No depths are shown, because none were read. A row of zeroes here would be indistinguishable from a
> queue that is genuinely empty.

**Not a zero on the screen.** Not a table of `0`s. Not "healthy". The panel refuses to publish a
number it does not have, and says why in a sentence.

For pm2 I could not kill the daemon — that is not read-only, and R68 forbids it. I took the other
route the lane built for exactly this: the stub serves `workers: {ok:false, error}`, and the same
component rendered

> **worker health unavailable: [PM2][ERROR] Daemon not running / connection refused**
> nothing is known about: worker-orchestrator, worker-render, worker-video-stitch, claude-pool
> Not "0 online" and not "healthy" — the probe failed, so this panel has no number to report.

Against live pm2 in the same session it rendered `WORKERS 4/4 online · pm2 jlist · 2026-08-18
21:19:22Z` with four processes at `up 7d 16h`, `0 restarts`. Both branches, same component, same run.

---

## 6. R64 / R65 — measured against live data at my run time

`psql "$DATABASE_URL"` against `content_forge`, 2026-08-18T21:16:31Z, read-only:

```
797bc9b0|AWAITING_UPLOADER|2026-08-04 01:01:34.885+00|14.84
6a9341e6|AWAITING_QC      |2026-08-04 11:53:01.457+00|14.39
bd4bfd38|AWAITING_UPLOADER|2026-08-05 20:37:24.549+00|13.03
75c0cbe8|AWAITING_UPLOADER|2026-08-05 21:26:34.847+00|12.99
c65abcfe|AWAITING_UPLOADER|2026-08-06 21:50:26.252+00|11.98
AWAITING_QC|1   AWAITING_UPLOADER|4
```

**The live split is 4 + 1, and the surface rendered 4 + 1** — S-C's correction to 00-vision §2.5's
3+2 holds, and nothing is hardcoded: the ages had drifted since the builder measured them (one job
crossed 12d→13d between their run and mine) and the surface showed `11d / 12d / 13d / 14d / 14d`,
the current values, not the recorded ones. Band 11–14, as R64 requires.

**R65 reads differently in words, not only in colour.** From the same live payload:

```
idea    | 0 | no_work_idle              | Nothing in Idea, and it is the first phase — no work has been created.
script  | 0 | no_work_idle              | Nothing in Script, and nothing in any earlier phase — idle, not blocked.
qc      | 5 | has_work                  | 5 jobs in QC.
render  | 0 | no_work_blocked_upstream  | Nothing in Render — 5 jobs held further up, in QC (5). This column is
                                          empty because work is stuck, not because there is none.
publish | 0 | no_work_blocked_upstream  | Nothing in Publish — 5 jobs held further up, in QC (5). …
```

On screen the empty columns carry `NO WORK · IDLE` versus `EMPTY · BLOCKED UPSTREAM` chips **plus**
the full sentence. Six columns show `0`; they no longer say the same thing. The footer publishes the
provenance of the counts themselves — "counts are true totals from content_jobs (a GROUP BY over
every matching row), not the length of the card preview · cards capped at 20 per phase · card query
scanned 5 of 500 rows" — which closes the `count`/`total`-are-really-caps defect that round 0 found
and folded in here rather than seeding a cycle for (N8, correctly).

---

## 7. R59–R63 — asserted in the browser, by my own instrument

I wrote my own assertion script (`/tmp/r5-assert.mjs`, scratch, nothing written to the worktree)
rather than re-reading the builder's. Twelve assertions, all PASS:

```
PASS  R62 data-business-slot DOM order
      got ["primary-directory","primary-youtube","secondary-arms","inventory"]
PASS  R62 vertical order matches DOM order
      [{"primary-directory":149},{"primary-youtube":1057},{"secondary-arms":1674},{"inventory":1956}]
PASS  R63 renders 891 sourced
PASS  R63 renders 271,758 scraped rows
PASS  R63 renders 0.33%
PASS  R63 renders zero outbound ever sent
PASS  R63 renders Axtrelis 5 seed orders
PASS  R60 Committed sits between Proposed and Won      Proposed@1720 Committed@1812 Won@2009
PASS  R60 signature moves to Committed, not Won
PASS  R61 every @as-of stamp sits in a row that also carries a status label and a dated dot
      22 property rows; undated/statusless: []
PASS  R61 the header's property count matches the number of dated rows      rows=22
PASS  R61 the LIVE badge legend explains the two categories
PASS  R61 the inventory says in words that it is NOT live-probed
ALL PASS
```

Two of those started as FAILs against my own instrument, not the code — I had guessed a
`data-inventory-status` attribute that does not exist, and then counted status words with a
case-sensitive regex against `textContent`, which holds the source case while CSS `text-transform`
uppercases the render. Both were my bugs; I fixed the probe and re-ran. Recording it because a
reviewer's instrument lies as readily as a builder's.

**R60 — I checked the spec myself**, line by line, against
`/opt/obsidian-vault/AI OS/Specs/Directory + Business Plan Hub — Business Model.md` (1164 lines):

| Cited | Actual content at that line | ✓ |
|---|---|---|
| §0 L32–35 | "Nothing has ever been sold… 271,758 scraped businesses… Zero outreach has ever been sent by any system on either box." | ✓ |
| §1.3 L114–117 | `places` = 271,758; `is_indexable=1` (cleared the enrichment gate) = **891 (0.33%)** | ✓ |
| §2.2 L207 | "Starter $197 · Standard $497 (anchor) · Premium $2,497" | ✓ |
| §2.2 L211 | "1 user, 5 seed orders, 0 leads, in a database named `axtrelis_dev`" | ✓ |
| §3.2 L263 | Stage 1 **Sourced** — the ICP filter definition | ✓ |
| §10 Q2 L701 | "Listing price **£49/month**" | ✓ |
| §10 Q4 L703 | "What counts as won? **Signature.** … see §11 on where payment b…" | ✓ |
| L764 | `## 10. Signature, payment, and the boundary between them — 2026-08-04` — **the SECOND §10** | ✓ |
| L784 | signed scope → **Committed**, with `signed_on` | ✓ |
| L785 | first payment clears → **Won — Client**, fires **once** | ✓ |
| L788 | "§3.4 already decided *won = first payment cleared*. That decision stands." | ✓ |
| L858 | §10.5 four concrete defects | ✓ |
| L887 | `## 11. Do we need an ERP?` — **the ERP section, not the payment boundary** | ✓ |

The trap the builder documented is real: the spec has **two sections numbered 10**, §10 Q4 points at
"§11" for the payment boundary, and §11 is the ERP chapter. The resolving text is the second §10 at
L764. Resolving that rather than copying the pointer is the difference between a funnel that matches
Konrad's ruling and one that contradicts it.

**One correction the builder made that I want to endorse in writing:** R63 asks for "891 of 271,758
directory records past the enrichment gate". The surface renders 891 and labels it as the
**enrichment** gate (`is_indexable=1`, L117), explicitly *not* §3.2's ICP filter, which has never
been counted and would be lower. Rendering 891 as an unqualified "Sourced" count would have been the
first lie on a surface built to stop lying. Correct call.

**Konrad's rulings, checked on the surface:** Layer 1 listings ✓, £49/month ✓, accountants ✓,
Jersey ✓, Twenty CRM ✓, **no Close.com anywhere in either file** (`grep`, rc=1) ✓, Ian owns outreach
("Ian makes the first 100 calls… Konrad may take the first ~20 himself to learn the objections") ✓,
Committed between Proposed and Won ✓, Won—Client on first cleared payment ✓.

**R59 — the spine and its provenance.** `business-spine-ruling.md` names it: **FUNNEL, by default,
not by his answer**, decided 2026-08-18, question asked 2026-08-18T18:51:39.618Z, mechanism
"default-on-silence declared in advance", reversible because the stage list is data. It also corrects
the task brief's own evidence (there *is* a human message after the question — "Drop the spend cap
please." at 19:56:11.939Z — it simply is not an answer), and records that `role='user'` in the thread
includes worker relays. **I re-ran the check at my own run time**, because Konrad has spoken in that
run since the doc was written:

```
$ psql … WHERE r.id='bfd1283a-…' AND n>2291 AND role='user'
        AND text NOT LIKE '[message from worker%' AND text ~* 'funnel|spine|business'
(no rows — 2026-08-18T21:23:58Z)
```

Still unanswered. The default stands, and the document is honest about being a default.

---

## 8. R69 / R70 — Money

`money-keep-cost.md` exists, carries files/LOC/routes/tables/consumers/what-breaks, and every number
carries its command with the connection string named. **The verdict is KEEP** and the code change is
two labels.

**`git diff MoneySurface.tsx` is label and presentation only** — no new data source, no new endpoint,
no behavioural change. The one thing that could be read as functional is passing the *already
existing* `claude_calls` field from `SpendWindow` into the card; `app/api.ts` is untouched, so nothing
was added to the wire. Within R70's permitted scope.

**R70's prescribed wording was measured false and correctly rejected.** I re-derived it myself at
2026-08-18T21:16:49Z:

```
$ psql "$DATABASE_URL" -Atc "SELECT COALESCE(SUM(amount_eur) FILTER (WHERE provider <> 'claude-code'),0),
    COUNT(*) FILTER (WHERE provider <> 'claude-code'),
    ROUND(SUM(amount_eur) FILTER (WHERE provider='claude-code'),2),
    COUNT(*) FILTER (WHERE provider='claude-code')
  FROM spend_log WHERE created_at >= now() - interval '30 days';"
0 | 0 | 2997.99 | 888

$ psql "$AI_OS_DATABASE_URL" -Atc "SELECT count(*), count(*) FILTER (WHERE direction='out'),
    sum(amount_eur)::numeric(12,2) FROM ledger_entries;"
172 | 172 | 176.07
```

The €0.00 is `spend_log`'s non-claude sum in `content_forge` on `:5432`. `ledger_entries` is a
different table in a different database on `:5434` and holds **172 rows**. Labelling that zero "no
ledger entries recorded" would have shipped a falsehood on both counts. **N10 sample re-run: the
ledger figures reproduce exactly (172 / 172 / €176.07).**

The shipped labels match the measurement (screenshot `…211927Z-before-money.png`, Read back inline):

- three tiles: `TODAY · METERED SPEND` / `LAST 7 DAYS · METERED SPEND` / `LAST 30 DAYS · METERED
  SPEND`, each `€0.00`, `0 billed calls`, each carrying *"no metered spend recorded {window} —
  nothing was billed by a metered provider. Not 'no revenue', not 'nothing ran'."*
- the shadow price out of the footnote: `CLAUDE CODE · SHADOW PRICE · NOT CHARGED`, **€3,004.18**,
  *"890 subscription calls · what these tokens would have cost on metered API pricing. No money left
  the account."*
- the chart's empty state, which used to contradict the panel beside it: *"no metered spend in the
  last 30 days — this chart is billed providers only, and claude-code (flat-rate subscription) is
  excluded from it."*

**The moving figure is the proof of correctness here, not a discrepancy.** I measured €2,997.99 / 888
calls at 21:16:49Z; the surface rendered €3,004.18 / 890 calls at 21:19:27Z. It is queried at request
time, and no test asserts a frozen euro value — which is exactly what round 0 warned about after
watching it move 2735.17 → 2773.48 inside a few minutes.

The report states the correction explicitly, in a section titled "how the shipped labels differ",
and flags that `by_area` still mixes shadow with metered — left alone under R69, disclosed rather
than silently fixed. Correct restraint.

**Corroboration the corpus did not have:** Konrad, in the manager run at index 2595/2598, after the
phase was planned — *"all of this weird money stuff we do not need to work on there because it's
quite irrelevant"* and *"We do not need to overly track our token spend in terms of dollars."* R69's
do-not-invest posture is not an inference. It is what he said.

---

## 9. Write-set audit

Declared on the task row, compared against `git log --name-only` over each task's commits.

| Task | Commit | Declared | Touched | Verdict |
|---|---|---|---|---|
| `c0cf2f7b` round 0 repro | `50d75d1` | 8 paths | the same 8 | **exact match** |
| `c6a3f535` round 1 API | `a120916` | 8 paths | the same 8 | **exact match** |
| `f2bd0c57` round 2 Businesses | `c94b10d` | 4 paths | the same 4 | **exact match** |
| `cf46cece` round 2 Pipeline+Money | `f4fa30c` | 8 paths | the same 8 | **exact match** |

**No undeclared writes by any phase-5 builder.** One observation for the integration reviewer rather
than a finding against a builder: the round-499 scout `f5bbf4c8` declared one path and its commit
`fa6eab4` also carries `docs/research/round-499-f5bbf4c8.md`, which is the engine's own
`round-<n>-<taskid>.md` pointer convention, not hand-authored product work. Noting it so it is not
rediscovered as a surprise at integration.

---

## 10. Findings

### BLOCKER

**B1 — `scripts/checks/dollar-sweep.sh` is a NEW RED versus `phase5/gates-baseline-business.txt`
(gate 8: `0` → `1`), and nothing in the phase adjudicates it.**

```
FAIL    forge-control-web/app/desktop/businesses-inventory.ts:467
FAIL    forge-control-web/app/desktop/businesses-inventory.ts:592
primary gate: 116 hit(s), one or more UNLISTED
dollar-sweep.sh: FAIL — unlisted currency-shaped hit(s) in forge-control-web/app.
```

`git blame` puts both lines in `c94b10d` — this phase, this lane.

- **`businesses-inventory.ts:467`** — `"…who does that work today, and who signs off on spend."`
  Fires on `\bspen[dt]`. It is the Qualified stage's criterion, faithful to §3.2, and it renders.
- **`businesses-inventory.ts:592`** — `"…Pricing is locked in code at $197 / $497 / $2,497 one-time
  — the most rigorously specified revenue model in the operation, with no customers in it."`
  Fires on `\$[0-9]`. It is the spec's own figure at L207, and it renders on the Businesses tab.

**Neither line should change.** They are correct, spec-sourced, and R63 wants exactly this kind of
honesty on the screen. The gate is about *agent-cost* currency leaking into the UI, not about a
business's own price list, and this is the allowlist's purpose.

**The fix** — two rows appended to `scripts/checks/dollar-allowlist.txt`, format
`FILE<TAB>EXTENDED-REGEX-PATTERN<TAB>ONE-LINE REASON`. The mechanism matches on *both* file and hit
content (`allowlist_reason()`, `dollar-sweep.sh:63-76`), so **scope each pattern to its own
sentence** — anchor on `signs off on spend` and on `\$197 / \$497 / \$2,497` respectively, never a
bare `\$[0-9]` or the file alone, so a genuinely new currency hit landing in the same file still
fails. Then re-run `bash scripts/checks/gates-808.sh --strict` and confirm the summary reads
`RED: 0`, matching the baseline. Update `docs/plan/artifacts/phase400/dollar-allowlist.md`, which
the script's header names as the prose table for that file.

The deeper fix is procedural and belongs in the next phase's brief: **no phase-5 builder ran the
gate suite after the product code landed.** The baseline exists; nothing was measured against it
until this review.

### FOLD-IN NOTES — N8, no fix cycle. Two sentences each; attach to whichever task closes B1.

**F1 — `forge-control/src/lib/pipeline-health.ts:317`.** `restarts` falls back to `0` when pm2 omits
`restart_time`, while `uptime_ms` on the two lines above correctly goes `null` for the same class of
missing data — with the comment "NEVER 0: a zero uptime reads as 'just restarted'". The surface then
renders `0 restarts`, a claim, for a value pm2 did not report. Make it `number | null` and render
"restarts not reported", exactly as uptime already does.

**F2 — `forge-control/src/db/pipeline.ts:378`.** The doc comment says "`pm2 list` is the ONLY pm2
verb used"; the code four lines down runs `pm2 jlist`. Harmless today, but this comment is the thing
an auditor greps for under R68. Fix the word.

**F3 — `docs/plan/artifacts/os-usable-for-work/phase5/premises-remeasured.md:124` and `:183`.** Two
command blocks are elided to `<the surface WHERE clause, no LIMIT>` and `<R70 30-day figure, verbatim
from the brief>`, so the numbers under them do not carry a runnable command (N10). Every other
measurement in this phase does — `money-keep-cost.md`'s CMD-M1/M2/M3 are the model. Paste the two SQL
bodies in.

### NOT findings — checked and clean

- No colour literal anywhere in the diff (`#rrggbb`, `rgba()`, `hsla()`): zero hits in added lines;
  gate 5 `no-raw-colours.cjs` green over the whole app.
- N2: `pipeline-health.test.ts` and `redis-probe.test.ts` are under `src/lib/`, which is the only
  path `pnpm test` runs (`tsx --test src/lib/*.test.ts`). 1347/1347. The socket path of
  `probeQueueDepths` is not unit-tested — the file says so — and I proved it end-to-end with a dead
  port instead, which is the stronger evidence.
- N7: before- and after-shots committed under `phase5/` (7 PNGs), upload paths referenced in the
  artefacts, and `/opt/ai-os/uploads/d1f5b807e1ba/` still holds its three. My own shots this run are
  under `/opt/ai-os/uploads/4ba240ffd4f2/` and were Read back inline.
- Ownership: none of `DesktopApp.tsx`, `nav-items.ts`, `app/api.ts`, `forge-control/src/index.ts`,
  `routes/pm2.ts` appears in the diff.
- Live checkout `/opt/forge-ai-os`: clean, twice.

---

## 11. What the next agent has to do

1. Two scoped rows in `scripts/checks/dollar-allowlist.txt` (B1), anchored to the two sentences.
2. `bash scripts/checks/gates-808.sh --strict`, `timeout 600000`. Confirm `RED: 0` against
   `phase5/gates-baseline-business.txt`. Paste the summary.
3. Fold F1, F2, F3 into the same commit.
4. Nothing else. R59–R70 are met, and I verified each of them against the running application rather
   than against the reports.

**VERDICT: NEEDS_FIXES** — at tip `f4fa30c52f77492a5d6f35efce09778e082a2baa`.
