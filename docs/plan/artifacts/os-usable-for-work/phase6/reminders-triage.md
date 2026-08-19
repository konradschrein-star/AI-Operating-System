# Reminders triage — phase 6, workstream `perf`, task B

**Measured 2026-08-18, 20:16–20:22 UTC, read-only.** No `INSERT`, `UPDATE` or `DELETE` was run against
`reminders`. No source file was changed. The one outbound action was a single manager report, recorded
in [`reminders-policy-escalation.md`](./reminders-policy-escalation.md).

---

## The thirty-second version

**Nothing is overdue. Nothing is undelivered. Nothing is pending.** Delivery works, the R705 dedup fix
is in place and holding, and no part of the delivery path needs touching.

What Konrad is looking at is a **47-day delivered archive sorted oldest-first**. The top row on his
phone is a smoke test from **2 July**. Below it are 18 phone-screens of finished notices. The rows from
*today* are not on the screen at all — they fall off a `LIMIT 100` he cannot see.

Three defects, all presentation and retention:

| # | Defect | Evidence |
|---|---|---|
| **P1** | The list is ordered **oldest-first**, so the screen opens on July. | `db/reminders.ts:68`, screenshot |
| **P2** | 100 rows render at once — **15,546 px, 18.4 phone-screens** — every one with a live ✕. | browser measurement |
| **P3** | The **56 newest rows are silently truncated** by `LIMIT 100`. Today is invisible. | SQL, below |

And a fourth that is not on the Capture pane at all: **the mobile Inbox badge is 100 % reminder
mirror** — 51 open items, every single one a delivered reminder (§4).

---

## 1. The figures, each with the query that produced it

Connection: the `DATABASE_URL` the **live `forge-control` process** runs with —
`postgresql://postgres:***@127.0.0.1:5432/content_forge`.

> The connection string printed in the task brief,
> `postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge`, **fails authentication**
> (`FATAL: password authentication failed for user "postgres"`). `content_forge_prod` is the fallback
> literal at `forge-control/src/db/reminders.ts:17`, used only when `DATABASE_URL` is unset; it is not
> the password this box runs. Same host, same port, same database, different password. This is the
> *safe* failure — it errors instead of answering 0 rows. Full note in
> [`reminders-row-count-before.txt`](./reminders-row-count-before.txt).

### 1.1 Total — and it is not 124

```sql
SELECT count(*) FROM reminders;
```

| when (UTC) | total |
|---|---|
| 2026-08-18 20:16:06 | **176** |
| 2026-08-18 20:21:03 | **177** |
| 2026-08-18 20:21:40 | **179** |

The brief's figure of 124 (`00-vision.md` §2.6) was correct when it was measured this morning. **Three
more rows arrived during the six minutes of this triage**, and none of them were written by this task.
See §6 — this has consequences for success criterion S12.

### 1.2 Status split

```sql
SELECT status, count(*) FROM reminders GROUP BY status ORDER BY 2 DESC;
```

| status | count (at 20:16) |
|---|---|
| delivered | 153 |
| dismissed | 20 |
| pending | 3 → **0 by 20:21** |

The three pending rows were future-dated worker escalations from sibling lanes, due within 90 seconds;
they had all been delivered before the next query ran. **The steady state of this table is `pending = 0`.**

```sql
SELECT count(*) AS pending_overdue FROM reminders WHERE status='pending' AND due_at < now();   -- 0
SELECT count(*) AS delivered_without_ts FROM reminders
  WHERE status='delivered' AND delivered_at IS NULL;                                           -- 0
```

**R77, stated plainly: nothing is overdue and nothing is undelivered.** Every delivered row carries a
`delivered_at`. There is no queue, no backlog and no stuck item anywhere in this table.

### 1.3 Source split — and why the `source` column cannot answer "who made these"

```sql
SELECT source, count(*) FROM reminders GROUP BY source ORDER BY 2 DESC, 1;
```

| source | count |
|---|---|
| `chat` | 167 |
| `builder-r604` | 4 |
| `research-browser:scratch` | 2 |
| `r702-perplexity` | 1 |
| `research-browser:r704-loginwall` | 1 |
| `research-browser:smoke-r701` | 1 |

95 % of the table says `chat`, because `POST /api/reminders` defaults `source` to `"chat"`
(`routes/reminders.ts`, `body.source ?? "chat"`) and almost every agent posts without setting it. **The
column is not a usable grouping key.** Classifying by text instead:

```sql
SELECT CASE
    WHEN text LIKE '%Watchdog%'            THEN 'watchdog auto-unwedge'
    WHEN text LIKE 'SkyLab render%'        THEN 'ReelForge/SkyLab render notice'
    WHEN text LIKE 'Research browser needs%' OR text LIKE '%research-browser%'
                                           THEN 'research-browser login wall'
    WHEN text ~ '^[a-z0-9-]+ (deploy|r[0-9]+|phase)' OR text LIKE '%phase%'
                                           THEN 'agent worker escalation'
    ELSE 'other' END AS producer_class,
  count(*), min(created_at)::date, max(created_at)::date
FROM reminders GROUP BY 1 ORDER BY 2 DESC;
```

| producer class | count | first | last |
|---|---|---|---|
| other — SkyLab slate tallies, CRM status notes, prose-phrased agent escalations, one probe | 72 | 2026-07-02 | 2026-08-18 |
| **agent worker escalation** | 40 | 2026-08-17 | 2026-08-18 |
| **ReelForge / SkyLab render notice** | 37 | 2026-07-11 | 2026-07-15 |
| **watchdog auto-unwedge** | 20 | 2026-07-15 | 2026-08-18 |
| research-browser login wall | 7 | 2026-08-05 | 2026-08-17 |

**Machines wrote at least 104 of the 176 by that classification — and reading the rows says it is very
nearly all of them.** Two queries make it plain:

```sql
SELECT count(*) FROM reminders WHERE source = 'mobile';                     -- 0
SELECT count(*) FROM reminders WHERE created_at::date = date '2026-08-18'
  AND text !~ '(phase|round|r[0-9]+|deploy|Watchdog|worker|builder|reviewer|lane|commit)';  -- 8 of 67
```

**Not one reminder in the table was created from the Capture pane.** `CaptureScreen` posts
`source: "mobile"` (`MobileApp.tsx:1911`) and there are **zero** such rows. And the 8 of today's 67 that
escape the machine-shaped regex are not human either — they are agent escalations phrased in prose
("B4b NEEDS A DECISION: no secret named `github-pat` is stored…"). Reading the oldest rows of the
`other` bucket finds SkyLab tallies, CRM status notes, a goal-mode announcement, and exactly **one**
plausibly human row: the text `x`, from 11 July.

So the complaint sharpens to one sentence: **the reminders surface is an agent-to-Konrad notification
log that he has never once written to himself, presented to him as his personal to-do list.** That is
the single fact that explains it, and it is the argument for the history fold over any amount of
tidying.

### 1.4 Span, and the arrival rate

```sql
SELECT min(created_at), max(created_at),
       round(extract(epoch FROM (max(created_at)-min(created_at)))/86400.0, 1) AS span_days
FROM reminders;
```

`2026-07-02 19:36:18Z → 2026-08-18 20:13:26Z` = **47.0 days**.

```sql
SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*)
FROM reminders GROUP BY 1 ORDER BY 1 DESC LIMIT 12;
```

| day | created |
|---|---|
| **2026-08-18** | **63** at 20:16Z — **67** by 20:30Z, still climbing |
| 2026-08-17 | 13 |
| 2026-08-16 | 5 |
| 2026-08-06 | 3 |
| 2026-08-05 | 38 |
| 2026-08-04 | 6 |
| 2026-07-16 | 4 |
| 2026-07-15 | 13 |
| 2026-07-14 | 6 |
| 2026-07-13 | 8 |
| 2026-07-12 | 7 |
| 2026-07-11 | 9 |

Arrivals are **bursty and agent-driven**: 63 today (67 fourteen minutes later), 38 on 5 August, 3–13 on
ordinary days. The bursts line up exactly with multi-lane project days. A retention window sized for a quiet day will still be
swamped on a project day — which is the argument for the **history fold** rather than a bigger window.

### 1.5 Repeat clusters

```sql
SELECT count(*) AS n, left(text,90) FROM reminders
GROUP BY text HAVING count(*) > 1 ORDER BY 1 DESC, 2;
```

| n | text (head) |
|---|---|
| **4** | `🔧 Watchdog: project "operator-visibility" was blocked by a failed run — auto-unwedged, 1 t…` |
| **3** | `🔧 Watchdog: project "scripts-checks-typecheck-gate" was blocked by a failed run — auto-unw…` |
| 2 | `Research browser needs a ONE-TIME login: this site, profile "scratch". 1) tunnel: ssh -N -…` |
| 2 | `scripts-checks-typecheck-gate deploy: /opt/forge-ai-os has an uncommitted change to forge-…` |
| 2 | `🔧 Watchdog: project "engine-v2-research-lane" was blocked by a failed run — auto-unwedged,…` |
| 2 | `🔧 Watchdog: project "p6-r20-researcher-smoke" was blocked by a failed run — auto-unwedged,…` |

Six clusters, 15 rows. **These are not dedup failures.** Each is a genuinely separate event — the
watchdog unwedged the same project on four different occasions — and the R705 dedup is working
correctly by not suppressing them. They are a *presentation* problem: four identical-looking lines make
the surface read as broken. This is what the "Group repeats too" option in the escalation buys.

### 1.6 Recurring reminders

```sql
SELECT coalesce(recur,'(none)'), count(*) FROM reminders GROUP BY recur;
```

**`recur IS NOT NULL` → 0 rows. There is not one recurring reminder in the table.** All 176 are
one-shot. The policy's "recurring renders as one row" clause is therefore **forward-looking only**: it
governs behaviour when Konrad creates his first `daily 08:30`, and it changes nothing about the present
data. Task D must implement it anyway — but it must not claim a row-count reduction from it.

### 1.7 The `LIMIT 100` truncation — the R705 hazard, live

`forge-control/src/db/reminders.ts:64-70` (`listReminders`, default `limit = 100`):

```sql
SELECT … FROM reminders
 WHERE status != 'dismissed'
 ORDER BY (status = 'pending') DESC, due_at ASC
 LIMIT 100
```

```sql
SELECT count(*) FROM reminders WHERE status <> 'dismissed';   -- 156
```

**156 non-dismissed rows exist. The API returns 100. 56 rows — 36 % — fall off, and the client is never
told.** The response carries `count: 100` and `filter: null`; there is no `truncated` flag on this
branch (there *is* one on the `?contains=` branch — `routes/reminders.ts` sets
`truncated: items.length === REMINDER_MATCH_LIMIT`. The UI listing branch has no equivalent).

Confirmed live through the throwaway UI's proxy:

```
GET /api/proxy/reminders  ->  200, count: 100, all 100 status='delivered', filter: null
```

**Which 56 fall off, and this is the part that matters:**

```sql
WITH page AS (
  SELECT id, created_at,
         row_number() OVER (ORDER BY (status='pending') DESC, due_at ASC) AS rn
  FROM reminders WHERE status <> 'dismissed')
SELECT CASE WHEN rn<=100 THEN 'shown' ELSE 'TRUNCATED' END,
       count(*), min(created_at), max(created_at)
FROM page GROUP BY 1;
```

| bucket | count | oldest created | newest created |
|---|---|---|---|
| shown (rn ≤ 100) | 100 | 2026-07-02 19:36 | 2026-08-18 20:13 |
| **TRUNCATED (rn > 100)** | **56** | **2026-08-18 11:38** | **2026-08-18 20:13** |

**All 56 truncated rows were created today**, between 11:38 and 20:13. Only **7** of the 100 shown rows
are from today. Because the sort is `due_at ASC`, the page fills with the oldest history first and the
cut lands on the newest arrivals. The cut point:

| rn | due_at | text (head) |
|---|---|---|
| 99 | 2026-08-18 11:40 | `scripts-checks-typecheck-gate r4 builder (cont): p…` |
| **100** | **2026-08-18 16:41** | `🔧 Watchdog: project "scripts-checks-typecheck-gate…` |
| 101 | 2026-08-18 17:21 | `🔧 Watchdog: project "scripts-checks-typecheck-gate…` |
| 102 | 2026-08-18 17:22 | `scripts-checks-typecheck-gate deploy: /opt/forge-a…` |

This is the R705 hazard exactly as `db/reminders.ts:78-92` predicted it, now realised: the docstring on
`findRemindersByText` warns that "once 100 non-dismissed reminders exist — measured at 84 on 2026-08-05 — the page
stops containing the very reminder the caller is searching for". It is 156 now. The `?contains=` branch
was built to protect *programmatic dedup* from this, and it does. **Nothing protects the UI listing**,
which is why Konrad's phone shows him July and hides this afternoon.

**Load-bearing consequence for the policy:** a 7-day window is not merely tidier, it is *more complete*
than what ships today. Filtering to the last 7 days leaves 80 rows — under the cap — so the truncation
stops happening and Konrad sees **all** of the recent history for the first time.

---

## 2. Which rows are stale

**Definition used** (stated so it can be argued with): a reminder is **stale** when it is
`delivered` or `dismissed` — its job is finished, it has already reached Konrad through the inbox and
Telegram — **and** it was created more than **7 days** ago. A `pending` row is never stale regardless
of age.

```sql
SELECT count(*) FILTER (WHERE status <> 'pending' AND created_at <  now()-interval '7 days') AS stale,
       count(*) FILTER (WHERE status <> 'pending' AND created_at >= now()-interval '7 days') AS recent_done,
       count(*) FILTER (WHERE status =  'pending')                                          AS still_live
FROM reminders;
```

| bucket | count |
|---|---|
| **stale** (done, > 7 days old) | **95** |
| recent, done (≤ 7 days) | 81 |
| still live (`pending`) | 0 |

Restricted to rows the UI can actually reach (`status <> 'dismissed'`): **76 stale, 80 recent**, of 156.

All three numbers are a snapshot at **20:16Z** and they drift upward as agents write (§1.1, §6): by
20:31Z the same query returned 84 recent of 160 non-dismissed. **Task D must compute the fold count at
render time, never hard-code 76.**

So the default policy hides **76 of 156** rows behind a fold and shows **80** — and, per §1.7, those 80
are *more* than the surface can render today.

---

## 3. Where the list is rendered — verified

**The only reminders list in the entire web app is the Capture pane of `MobileApp.tsx`.**

```
$ grep -rn "fetchReminders" forge-control-web/app
forge-control-web/app/api.ts:907:export const fetchReminders = async () => {
forge-control-web/app/MobileApp.tsx:42:  fetchReminders,
forge-control-web/app/MobileApp.tsx:1894:    queryFn: fetchReminders,
```

Three hits: the definition, its import, and one call site. **There is no desktop reminders surface** —
`DesktopApp.tsx` and `app/surfaces/` contain no `fetchReminders` call. `routes/today.ts` and
`routes/inbox.ts` contain the string `reminder` **zero** times, so the Today API does not surface them
either.

Confirmed in a real browser (harness: [`browser-harness-perf.md`](./browser-harness-perf.md), the same
local copy of the phase-500 recipe that task A used; throwaway `next start` on **port 7787**, minted
`authjs.session-token`, `307 → /signin` without the cookie and `200` with it, and the mandatory
post-navigation `/signin` assertion in the script). The pane is reached at `/` with an **iPhone
User-Agent** — `app/page.tsx` picks `MobileApp` from the UA, not the viewport width, so a desktop UA at
390 px still renders `DesktopApp`.

Measured in the live DOM at a 390 × 844 viewport:

| measurement | value |
|---|---|
| reminder rows rendered | **100** |
| dismiss (✕) controls rendered | **100** |
| document scroll height | **15,546 px** |
| viewport height | 844 px |
| **screens of scroll** | **18.4** |
| section header text | `REMINDERS` — **no count, no unit** |
| refetch interval | 60 s (`refetchInterval: 60_000`) |

Screenshot: [`reminders-capture-before.png`](./reminders-capture-before.png) — the pane scrolled so the
`REMINDERS` header sits at the top of the phone screen, i.e. the frame Konrad actually gets.

**Read the first row of that screenshot.** It is `smoke test reminder — v2.0 deploy`, dated
**02.07.2026**, still carrying a live ✕. The second and third are July SkyLab render failures with
full signed download URLs wrapping across five lines each.

Three further defects visible in `MobileApp.tsx:2085-2157` and in the shot:

1. **The empty state lies about the contents.** It reads `none pending.` — but the list it labels is
   `status != 'dismissed'`, which is *delivered* rows. When it is empty it claims one thing; when it is
   full it shows another. (It did not fire during this measurement — `saysNonePending: false`.)
2. **The header carries a bare label and no number at all.** Not a wrong count — *no* count. Whatever
   task D renders there must carry its unit, per the A3 lesson: `0 pending · 80 delivered (7d)`, never
   a bare `80`.
3. **Every row is fully expanded**, including 300-character machine payloads and signed URLs. The rows
   have no truncation and no `title` affordance.

### 3.1 Reproducing the screenshot

The driver script is a **throwaway** at `/tmp/p6b-capture-shot.cjs` and is **deliberately not
committed** — this task's declared write-set is four artefact files, and adding a fifth would be an
undeclared write. Everything needed to rebuild it is here and in `browser-harness-perf.md`; the
measurement itself is in the table above.

```bash
cd forge-control-web && pnpm install --frozen-lockfile --prod=false     # --prod=false or tsc/next vanish
FORGE_CONTROL_URL=http://127.0.0.1:7700 ./node_modules/.bin/next build  # rewrite is baked at BUILD time
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a         # a READ of the live checkout
tmux new-session -d -s p6bweb "AUTH_URL=http://127.0.0.1:7787 AUTH_SECRET='$AUTH_SECRET' \
  FORGE_CONTROL_URL=http://127.0.0.1:7700 exec ./node_modules/.bin/next start -p 7787"
node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
  token:{name:"phase6b",email:"perf@localhost",sub:"perf"},
  secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400})))' > /tmp/p6b-cookie.txt
```

Both directions of the wall were checked with curl before the browser ran, because a harness that only
tests the success case cannot tell "authenticated" from "no wall at all":

```
307 -> http://127.0.0.1:7787/signin   (no cookie)
200                                   (with cookie)
```

Three things in the script are load-bearing and would each have produced a wrong report:

- **`waitUntil: "commit"`.** Next 15 on this app never fires `domcontentloaded` or `networkidle`
  through this harness; both hang the full timeout.
- **An iPhone User-Agent.** `app/page.tsx` selects `MobileApp` from the UA. A desktop UA at 390 px
  renders `DesktopApp`, which has no reminders list — and the first version of this script reported
  exactly that as "no Capture tab found".
- **The `/signin` assertion, immediately after the first navigation**, hard-erroring with the salt named
  as the first suspect:

  ```js
  if (/\/signin\b/.test(page.url())) throw new Error(
    `auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret: …`);
  ```

The tab label is `<span class="mono">Capture</span>`; the clickable element is its **parent** div, whose
`innerText` is `"edit_note\nCapture"` — the Material-Symbols ligature plus the label. An exact-innerText
match on `div` finds nothing and reads, wrongly, as "this is DesktopApp".

The script clicks **one** thing: the Capture bottom-nav tab. It never touches the per-row ✕
(`dismissReminder` — a mutation) and never submits the capture form.

---

## 4. The second surface — and it changes what task D must build

The brief asked whether Konrad might be seeing this count somewhere other than the Capture pane. **He
is.**

```sql
SELECT source, count(*) FILTER (WHERE resolved_at IS NULL) AS open,
                        count(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved
FROM inbox_items GROUP BY 1 ORDER BY 2 DESC;
```

| source | open | resolved |
|---|---|---|
| **`reminders`** | **51** | 105 |
| `hermes:hcp-worker-01` | 0 | 7 |
| `hermes:cf-worker` | 0 | 2 |
| `manual-test` | 0 | 1 |

**166 inbox items exist. 156 of them (94 %) are reminder mirrors. Of the 51 currently open, 51 are
reminder mirrors — 100 %.** They all carry `status = 'DECIDE'`.

`MobileApp.tsx:275` renders that number as a **red badge on the Inbox tab**. The badge counts the rows
the API returned, not the rows that exist: `fetchInbox` (`api.ts:235`) calls `/inbox` with no `limit`,
and `routes/inbox.ts` defaults that to **50**. So **51 open items produce a badge reading 50** — the
same silent-truncation shape as §1.7, on a different surface. Every item behind it is a notice Konrad
has already read on Telegram. He has hand-resolved 105 of them.

**Scope discipline on this point, and it matters:** the mirror into `inbox_items` is written by the
executor's `reminderTick` — it *is* the delivery path, and the delivery path is out of scope for this
entire phase. **Nothing in this report proposes changing what gets mirrored.** What is proposed is that
the *Inbox view* group reminder-sourced items — presentation only, on the read side. That is a second
decision and it is deliberately **not** bundled into the escalation block, which asks about the
reminders list alone. Task D implements the ruling on the reminders list. The Inbox grouping should be
raised separately, with its own ruling, and it belongs to whichever lane owns the Inbox surface — not
to this one.

---

## 5. Recommendation

**Do not touch delivery.** There is nothing wrong with it: 0 overdue, 0 pending, 0 delivered rows
missing a `delivered_at`, dedup working. `executor.ts`'s `reminderTick`, `claimDueReminders()` and the
Telegram path stay exactly as they are. This is the only working route to Konrad's inbox.

**Delete nothing.** Not one row. The escalation says so in Konrad's own terms and this report repeats
it: deleting a reminder needs his explicit instruction, and he has not given one.

**Change the presentation, in this order:**

1. **Reverse the sort.** `due_at DESC` for delivered rows. The single highest-value change in this
   report: it costs one clause and it stops the phone opening on 2 July. Pending rows still float to
   the top.
2. **Window the list, fold the rest.** Show pending + the last 7 days delivered (80 rows today, all of
   which fit under the cap — see §1.7); collapse everything older into one counted, expandable row:
   `76 older · show`. Nothing is deleted, nothing is unreachable.
3. **Label the count with its unit.** `REMINDERS` becomes something of the form
   `REMINDERS · 1 pending · 83 delivered (7d) · 76 older` (§5.1). A3's lesson applies here verbatim: a number
   with no unit is how this fleet has been bitten repeatedly.
4. **Fix the `LIMIT 100` honesty gap.** Either raise the cap for the windowed query or return a
   `truncated: true` flag on the unfiltered branch, the way the `?contains=` branch already does. A
   page that silently drops 36 % of its rows must say so.
5. **Correct the empty state.** `none pending.` is wrong for a list of delivered rows.
6. **Group repeat clusters** — 6 clusters, 15 rows. Worth doing for how the watchdog notices make the
   surface read as broken, not for the row count. **This is option 4 of the escalation and the default
   ruling did NOT take it** (`reminders-policy-escalation.md` §3.2). It stays documented and unbuilt
   until Konrad rules otherwise; task D must not build it on this report's say-so.
7. **Truncate long row text** to two lines with the full text on expand. The signed SkyLab URLs are
   five wrapped lines each.

Items 1–5 are the default policy and are what task D builds. Item 6 needs a ruling it has not got.
Item 7 is cosmetic and should ride along with 1–3 rather than justify its own task.

### 5.1 What the default policy would actually render — and the win it is NOT

Measured at 20:32Z, so task D has a target and nobody claims the wrong victory:

```sql
WITH nd AS (SELECT * FROM reminders WHERE status <> 'dismissed'),
     page AS (SELECT *, row_number() OVER (ORDER BY (status='pending') DESC, due_at ASC) AS rn FROM nd)
SELECT (SELECT count(*) FROM nd)                                                              AS non_dismissed,
       (SELECT count(*) FROM page WHERE rn<=100 AND due_at <  now()-interval '7 days')        AS rendered_stale,
       (SELECT count(*) FROM page WHERE rn<=100 AND due_at >= now()-interval '7 days')        AS rendered_recent,
       (SELECT count(*) FROM nd WHERE status='pending')                                       AS policy_pending,
       (SELECT count(*) FROM nd WHERE status<>'pending' AND due_at >= now()-interval '7 days') AS policy_recent,
       (SELECT count(*) FROM nd WHERE status<>'pending' AND due_at <  now()-interval '7 days') AS policy_folded;
```

| | today | under the default policy |
|---|---|---|
| rows rendered | **100** | **84** (1 pending + 83 delivered) **+ 1 fold row** |
| of those, older than 7 days | **76** | **0** — folded, count shown |
| of those, from the last 7 days | **24** | **83** |
| recent rows the surface cannot show at all | **59** (the `LIMIT 100` casualties) | **0** |

**The row count barely moves: 100 → 85.** Anyone reporting this as "we cut the list by 85 %" is
reporting a number that is not there. What changes is *which* rows: a screen that is 76 % stale becomes
a screen that is 100 % recent, and the ~59 recent rows currently amputated by the cap come back.

If Konrad wants the list **short** rather than **relevant**, that is option 2 of the escalation
("Pending only") and it renders **1 row plus a fold** today. He has not picked it, and the difference
between those two outcomes is exactly why R78 makes this his call and not ours.

**Not recommended, and stated so nobody re-derives it:** raising the 60 s refetch interval (it is not a
problem), adding a desktop reminders surface (out of scope, and `DesktopApp.tsx` belongs to the
`surfaces` lane), and any form of auto-dismissal — auto-dismissal is a write to the table, it is
indistinguishable from deletion from Konrad's side of the screen, and it was not asked for.

---

## 6. Hazard for the reviewer — success criterion S12

`00-vision.md` §4 S12 reads: *"count rows before and after phase 6 → **identical**; delivery tick still
fires."*

**As written, S12 cannot pass, and not because of anything phase 6 does.** The table grew 176 → 177 →
179 during the six minutes of this triage, written by sibling lanes' escalations and the watchdog. 63
rows arrived today. Any "before" count is stale by the time it is compared.

The substitute assertions are written into
[`reminders-row-count-before.txt`](./reminders-row-count-before.txt), with a frozen-set md5 so no
separate id dump is needed:

- **(a) no row destroyed** — `md5(string_agg(id ORDER BY id))` over rows created at or before
  `2026-08-18 20:21:03Z` must still be `d3005de3ee9e4057eb742e04fa4ed54b`, `n = 177`;
- **(b) no status rewritten by us** — dismissed count may only grow, and only by Konrad's action;
- **(c) delivery still fires** — `max(created_at)` and `max(delivered_at)` both still advancing.

---

## 7. What this task did and did not do

| | |
|---|---|
| Wrote to `reminders` | **no** — every statement was a `SELECT` |
| Changed forge-control source | **no** |
| Touched `executor.ts` / `claimDueReminders()` / delivery | **no** |
| Clicked a mutating control in the browser | **no** — navigation and selection only; the per-row ✕ is `dismissReminder`, and it was never touched |
| Outbound actions | **one** — the manager report in [`reminders-policy-escalation.md`](./reminders-policy-escalation.md) |

---

## 8. Requirement coverage — item by item

`01-requirements.md` states R76 with the vision's figures embedded. Every one of them was re-measured;
four have moved, and the movement is itself the finding (§1.1, §6).

| R76 asks for | requirement's figure | measured 2026-08-18 20:16Z | § |
|---|---|---|---|
| total rows | 124 | **176** (179 by 20:21:40Z) | 1.1 |
| what created them — `chat` | 115 | **167** | 1.3 |
| — `builder-r604` | 4 | **4** ✓ | 1.3 |
| — `research-browser*` | 4 | **4** ✓ — `:scratch` 2, `:r704-loginwall` 1, `:smoke-r701` 1 | 1.3 |
| — probes | 2 | **1** — `r702-perplexity`. The requirement's second probe is `research-browser:smoke-r701`, which it has already counted in the 4: 115 + 4 + 4 + 2 = **125**, one more than its own stated total of 124. Harmless, but it is a double-count and a reviewer ticking R76 line by line will find it. | 1.3 |
| status: delivered | 104 | **153** | 1.2 |
| status: dismissed | 20 | **20** ✓ | 1.2 |
| status: **pending** | **0** | **3 at 20:16 → 0 by 20:21**, and 0 overdue throughout | 1.2 |
| repeat clusters | watchdog 4× and 3× | **4× and 3×** ✓, plus four 2× clusters | 1.5 |
| which are stale | — | **95 of 176** by a stated definition | 2 |

| requirement | satisfied by |
|---|---|
| **R76** — triage report committed, live figures reproduced by its own queries | this file; every figure carries the SQL that produced it |
| **R77** — states plainly that nothing is overdue and nothing is undelivered | §1.2, and the opening summary |
| **R78** — policy proposed as a manager report with a `forge:ui` choice and a stated default; ruling or default-taken recorded with a date | [`reminders-policy-escalation.md`](./reminders-policy-escalation.md) — sent 20:20:51Z, HTTP 202, **DEFAULT TAKEN on 2026-08-18** |
| **R80 (before half)** — no row deleted; before-count recorded | [`reminders-row-count-before.txt`](./reminders-row-count-before.txt) — 177 at 20:21:03Z with a frozen-set md5, and the diff assertion below |
| **N7** — screenshots stamped, in `/opt/ai-os/uploads/$FORGE_RUN_ID`, read back, copied into the artefact directory | `20260818T201935Z-reminders-capture-before.png` → [`reminders-capture-before.png`](./reminders-capture-before.png), sha256 identical |
| **N10** — figures reproduced by this task rather than inherited | §1 in full; the brief's connection string does not even authenticate (§1) |

### 8.1 R80's diff assertion — and the grep that lies about it

R80's stated verification is *"assert the diff contains no `DELETE FROM reminders`"*. Run word-bounded,
against this task's staged diff:

```bash
git diff --cached | grep -nEi '\b(DELETE[[:space:]]+FROM[[:space:]]+reminders|TRUNCATE[[:space:]]+(TABLE[[:space:]]+)?reminders|DROP[[:space:]]+TABLE|UPDATE[[:space:]]+reminders[[:space:]]+SET|INSERT[[:space:]]+INTO[[:space:]]+reminders)\b'
#   -> no match
```

**A naive substring grep fires anyway — nine times — and every hit is this report's own prose.**
`grep -ci 'truncate'` returns **9**, because §1.7 is about the `LIMIT 100` *truncation* and the SQL
there labels a bucket `'TRUNCATED'`. This is the fleet's recurring "checker names its own forbidden
strings" failure, arriving on schedule: a document that describes a destructive operation trips a
checker that greps for the operation. **Use the word-bounded pattern above, or scope the pathspec to
`*.ts`/`*.tsx`/`*.sql` so prose cannot be mistaken for a statement.**

This task's diff is **four files: three text and one PNG**. It contains no executable code of any kind,
so there is no statement in it — destructive or otherwise — to run.
