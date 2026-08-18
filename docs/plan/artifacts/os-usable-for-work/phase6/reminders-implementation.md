# Reminders retention — what was ruled, what was built, and what proves it

**Phase 6, workstream `perf`, task D. 2026-08-18, 21:30–21:45 UTC.** Requirements R79, R80, R81, R82;
cross-cutting N1, N2, N7.

No live write of any kind was performed. Every statement this task ran against `content_forge` was a
`SELECT`, the throwaway API it drove refuses every non-`GET` at the door (§5.2), and the row-identity
anchor left by task B is **unchanged** (§6).

---

## 1. The ruling this implements — and the one thing it deliberately does NOT build

[`reminders-policy-escalation.md`](./reminders-policy-escalation.md) §3 records that the report was
delivered to the manager chat at **2026-08-18T20:20:51Z**, that Konrad posted nothing in the following
sixteen minutes, and that **the stated default was therefore taken**:

> pending + last 7 days delivered; older collapsed into a counted history fold; recurring renders as
> one row; per-item dismissal persists.

Two consequences are not this task's choices and are called out because they look like omissions:

| ruling | what shipped |
|---|---|
| §3.1 — the window is measured from **`due_at`** | `foldReminders` reads `due_at` and nothing else. `delivered_at` is NULL on every pending row and a NULL in a window predicate drops exactly the class of row that must never be hidden. |
| §3.2 — **"No repeat-grouping. That is option 4 of the block and Konrad did not pick it."** | The grouping logic exists in `reminder-retention.ts`, is unit-tested from both sides, and is **off**: `groupRepeats` defaults to `false` and neither `db/reminders.ts` nor `routes/reminders.ts` passes `true`. Clusters are **reported** (`view.groups`), never **collapsed**. |

That second row is the deliberate departure from this task's own brief, which listed a collapsing
`groups[]` under WHAT TO BUILD. The brief also opens with *"implement THAT RULING, no wider"*, and
**R79's failure condition is "the implementation quietly exceeds the ruling"** — so shipping a
collapse Konrad declined would have failed the requirement it was meant to satisfy. The capability is
one boolean from being live if he later clicks option 4; the count badge that must ship with it is
already in the surface (`MobileApp.tsx`, `r.repeat_count > 1`) and renders nothing until then. Reported
to the manager separately.

Live check of what "reported, not collapsed" means today: **2 clusters** exist inside the 7-day window
and all of their rows render as their own separate rows.

## 2. What was built

| file | what it is |
|---|---|
| `forge-control/src/lib/reminder-retention.ts` | The pure fold. No `pg`, no `Date.now()` — the clock is a parameter. Returns `{ visible, groups, history_count, window_days, counts }`. |
| `forge-control/src/lib/reminder-retention.test.ts` | 33 tests over fixtures. Attacks rule (a) from three directions. |
| `forge-control/src/db/reminders.ts` | **One** new export, `listRemindersForView({ windowDays })`, alongside the untouched ones. |
| `forge-control/src/routes/reminders.ts` | A **third** branch on `GET /`, keyed on `?view=window&days=N`. The other two branches are byte-identical (§4). |
| `forge-control/src/lib/reminder-dedup.test.ts` | 5 assertions ADDED that the third branch is additive. Every pre-existing assertion is byte-identical — the diff of this file contains no `-` line. |
| `forge-control-web/app/api-reminders.ts` | The client. Imports `Reminder` from `api.ts`; does not modify it (architecture §0.3). |
| `forge-control-web/app/MobileApp.tsx` | The Capture pane's REMINDERS section: labelled header, counted fold, error state, badge. |

### 2.1 The rules, and where each one lives

* **(a) every `pending` row is always visible, as its own row.** Enforced twice: the window test is
  reached only by delivered rows, and the grouping buckets are built from `deliveredInWindow` only.
  Both guards were proven live by mutation, not by reading (§4.2).
* **(b)** delivered rows inside the window are visible (boundary inclusive), older ones increment
  `history_count`.
* **(c)** identical texts form a cluster carrying an honest count and the **newest** `due_at`; a
  cluster never contains a pending row, so "the pending row renders separately" is true by
  construction. Collapsing is off per the ruling.
* **(d)** a recurring reminder **is already one row** — `claimDueReminders()` UPDATEs `due_at` and
  never INSERTs. Asserted against source rather than "fixed". There are still **0** recurring rows in
  the table (`reminders-triage.md` §1.6), so nothing in this phase may claim a row reduction from it.
* **(e)** nothing is dropped without being counted. `input === dismissed + pending +
  delivered_in_window + history` is **checked at the end of every fold and throws** if it fails.

### 2.2 Two correctness fixes that ride along (escalation §3.3)

1. **Delivered rows render newest-first.** `listReminders()` orders `due_at ASC`, which is why the
   phone opened on a 2 July smoke test — that query is untouched (R705 asserts its text); the new path
   sorts the other way. Visible in panel A of the screenshot: the top row is 18.08, not 02.07.
2. **No silent truncation.** The old page returns `LIMIT 100` of 161 non-dismissed rows with no flag.
   The view branch reads every row and returns counts; the fold's "show" widens the window to the whole
   table rather than lifting a cap.
3. Cosmetic, same class: the header was a bare `REMINDERS` over a truncated list and the empty state
   read `none pending.` for a list of *delivered* rows. Both now carry their unit (§3.3).

### 2.3 `counts.input` is the whole table, on purpose

`listRemindersForView` deliberately does **not** filter `status != 'dismissed'` in SQL; the fold
excludes dismissed rows and reports them. So `counts.input` equals `SELECT count(*) FROM reminders`,
and the surface's own arithmetic is a live proof that no row was destroyed — measured through the API
at 21:32Z: `input 181, dismissed 20, pending 0, delivered_in_window 85, history 76`, and
`20 + 0 + 85 + 76 = 181`, against a database count of **181** at 21:35Z.

There is a `REMINDER_VIEW_ROW_CEILING` of 20 000 rows. It **throws** with both numbers rather than
returning a short list, because a wrong history count looks exactly like a right one. At today's 181
rows and the worst observed arrival day of 67, it is years away; the fix when it arrives is to move the
split into SQL, and the error message says so.

## 3. The proofs

### 3.1 R79 — the ruled behaviour, in a browser

Harness: [`browser-harness-perf.md`](./browser-harness-perf.md), the local copy of the phase-500 recipe
this workstream already runs (`docs/plan/artifacts/phase1871/README.md:306`). Worktree build, throwaway
`next start` on **7787**, `authjs.session-token` salt (http `AUTH_URL`), iPhone User-Agent — `page.tsx`
picks `MobileApp` from the **UA, not the viewport**, so a desktop-UA window screenshots `DesktopApp`,
which has no reminders surface at all and reads as "feature missing".

The mandatory assertion is in the script and fires before anything else: the URL must not contain
`/signin`, and the error names the **salt** as first suspect. The server answered 200 on `/signin`
before the run and 200 after it — a run that ends with a dead server is not a measurement of the
application.

Text read out of the live DOM, not from the code:

```json
{
  "header":         "REMINDERS · 85 SHOWN · LAST 7 DAYS · 0 PENDING",
  "fold":           "76 older — show",
  "expanded":       "showing all 161 — hide older",
  "headerExpanded": "REMINDERS · 161 SHOWN · ALL HISTORY · 0 PENDING",
  "emptyState":     "no reminders in the last 7 days — 104 in history."
}
```

[`reminders-surface-after.png`](./reminders-surface-after.png) is a three-panel contact sheet of that
one run, assembled by the same browser from three **unedited** 390×844 frames, because one phone-width
frame cannot hold both ends of an 85-row list:

* **A — live**, top of the pane: the labelled header, newest-first rows.
* **B — live**, bottom of the pane: `76 older — show`.
* **C — the empty state**, with the payload **stubbed at the network layer** and labelled as such in
  the sheet. The server was not asked to lie and no row was touched; stubbing the response is the only
  way to see an empty window while 85 real rows sit inside it.

The raw frames (including the expanded state) are at
`/opt/ai-os/uploads/dcfcb425b225/20260818T213517Z-reminders-*.png`; the committed sheet is byte-identical
to the uploaded one, `sha256 ecda06c49e4f83c9118684130e49abd8f55cbfa7eee765ef84fef435d1ec020f`.

### 3.2 R79 — the four branches of `GET /api/reminders`, against live data

Served by the GET-only probe of §5.2 on 7788 (the live forge-control on 7700 predates this branch):

| request | result |
|---|---|
| `?view=window&days=7` | 200 · 85 rows · `window_days 7`, `history_count 76`, counts as §2.3 |
| `?view=window` (no days) | 200 · identical — the ruled default of 7, **echoed** in `window_days`, never silent |
| `?view=window&days=36500` | 200 · 161 rows · `history_count 0` — this is what "show" asks for |
| `?view=window&days=0` / `-1` / `abc` / `99999` | **400**, each naming its own value: `days must be a whole number of days between 1 and 36500, got "abc"` |
| `?view=list` | **400** · `unknown view "list" — the only view is "window"…` |
| *(no params)* | 200 · **count=100, `filter: null`** — the original page, unchanged |
| `?contains=Watchdog` | 200 · count=20 · `filter {"contains":"Watchdog","limit":50,"order":"created_at DESC","truncated":false}` — R705 intact |

The client refuses a reply with no `view` block. That is not theoretical: the first run of this harness
pointed at the live 7700, which ignored `?view=` and returned the unfiltered 100-row page — exactly the
old surface, restored silently. The handshake caught it, which is why it is in the code.

### 3.3 R82 and the R705 dedup — green

```
$ cd forge-control && pnpm test
# tests 1347   # pass 1347   # fail 0
$ npx tsx --test src/lib/reminder-dedup.test.ts src/lib/reminder-text.test.ts src/lib/reminder-retention.test.ts
# tests 70     # pass 70     # fail 0
$ npx tsc --noEmit          # clean
$ cd ../forge-control-web && npx tsc --noEmit   # clean
$ node ../scripts/checks/no-raw-colours.cjs
no-raw-colours: PASS — 222 literal(s) across 14 file(s), all accounted for (176 legitimate, 46 known debt, 0 unlisted)
    forge-control-web/app/MobileApp.tsx  (3)  :312 #fff  :689 #000  :742 rgba(255,255,255,0.02)
```

MobileApp still carries exactly its three allow-listed literals, at the same three lines. Every colour
added by this task comes from `tokens`.

### 3.4 The tests bite — three controlled mutations, each restored by hash

A test that cannot fail is not evidence. Each mutation was applied to the worktree, run, and reverted
from a byte copy verified by `sha256sum`:

| mutation | result |
|---|---|
| `reminder-retention.ts`: apply the window to pending rows too | **4 suites fail**, `rule (a)` first |
| `reminder-retention.ts`: let pending rows join the grouping buckets | **`rule (a)` fails** |
| `routes/reminders.ts`: `if (view !== undefined)` → `if (view)` | **the added dedup suite fails** |

## 4. THE THREE THINGS THAT MUST NOT MOVE

### 4.1 No row is deleted (R80)

```
$ grep -n "DELETE" forge-control/src/db/reminders.ts forge-control/src/routes/reminders.ts
   (no output)
$ git diff -- forge-control/src/db/reminders.ts | grep -n "claimDueReminders"
   (no output)
$ git diff -U0 -- forge-control/src/routes/reminders.ts | grep -E "^-[^-]"
   (no output — the unfiltered and ?contains= branches are byte-identical)
```

Dismissal remains the only archive verb and remains an `UPDATE … SET status = 'dismissed'`. The surface
never dismisses on its own: escalation §3.2 forbids auto-dismissal, because from Konrad's side of the
screen it is indistinguishable from deletion.

### 4.2 The delivery path (R81)

`executor.ts` was never opened. `claimDueReminders()` does not appear in the diff of
`db/reminders.ts` — its `FOR UPDATE SKIP LOCKED` claim, its recurrence advance and its
`status = 'delivered'` write are all asserted intact by `reminder-retention.test.ts` §8. The live
end-to-end delivery test belongs to the gating reviewer, so that exactly one task creates exactly one
row.

### 4.3 The R705 dedup (R82)

`listReminders()`, `findRemindersByText()`, `REMINDER_MATCH_LIMIT` and both existing route branches are
untouched. The five assertions added to `reminder-dedup.test.ts` are additions only; lines 119, 130 and
133–137 of that file are where they always were.

## 5. Row count, before and after this task

### 5.1 The count, and the anchor that survives the count moving

`SELECT count(*) FROM reminders` is **not** stable across this phase and never could be: 63 rows
arrived on 2026-08-18 alone, written by this fleet's own agents, and three arrived during the six
minutes of task B's triage. Task B left the discriminating anchor instead
([`reminders-row-count-before.txt`](./reminders-row-count-before.txt)), and it is the query a verifier
should run:

| | total | frozen set (`created_at <= 2026-08-18 20:21:03+00`) |
|---|---|---|
| task B, 20:21Z (before) | 177 | `d3005de3ee9e4057eb742e04fa4ed54b` / 177 |
| task B re-test, 20:33Z | 180 | `d3005de3ee9e4057eb742e04fa4ed54b` / 177 |
| **task D, 21:35Z (after)** | **181** | **`d3005de3ee9e4057eb742e04fa4ed54b` / 177** |

The table grew by four rows written by other agents. **The frozen set did not move by a single byte.**
Status split after: `delivered 161, dismissed 20, pending 0` — the 20 dismissed rows of the before
measurement are still exactly 20.

### 5.2 What this task ran against live services, and what it refused to

* **Reads only.** `SELECT`s against `content_forge` using the `DATABASE_URL` the live `forge-control`
  process runs with (the literal fallback in `db/reminders.ts:17` does not authenticate — see
  `reminders-row-count-before.txt` NOTE 1).
* **A GET-only probe.** The new route cannot be exercised through the live 7700, which runs the old
  code, and `pm2 restart forge-control` is forbidden. So the worktree's reminders router alone was
  mounted on **7788** — never `src/index.ts`, which starts cron, telegram and vault ticks — with every
  other `/api` path proxied to 7700 so the rest of the UI still rendered. **Every non-`GET` is refused
  with a 405 before it reaches either the router or the proxy**, so no click in the browser could have
  written anything, including a stray dismiss ✕. The browser drove navigation and selection only.
* Nothing was written in `/opt/forge-ai-os`. It was **read** once, for `AUTH_SECRET`, as the standing
  policy permits.
* No `pm2 restart` of anything.

The probe and the screenshot script live in `/tmp` rather than in the repo, because they are outside
this task's declared write-set. Both are reproduced verbatim below so the run can be repeated without
them.

<details>
<summary><code>/tmp/p6d-probe.mts</code> — the GET-only probe (run with <code>npx tsx -e "$(cat …)"</code> from <code>forge-control/</code>)</summary>

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import reminders from "./src/routes/reminders.ts";

const PORT = Number(process.env.PROBE_PORT ?? 7788);
const UPSTREAM = "http://127.0.0.1:7700";
const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    return c.json({ error: `probe is GET-only — refused ${c.req.method} ${c.req.path}` }, 405);
  }
  await next();
});
app.route("/api/reminders", reminders);
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const res = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
    headers: { accept: c.req.header("accept") ?? "application/json" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
});
serve({ fetch: app.fetch, port: PORT });
```

</details>

Reproducing the whole run:

```bash
cd <worktree>/forge-control && pnpm install --frozen-lockfile --prod=false
tmux new-session -d -s p6dprobe "cd $PWD && set -a && . /tmp/p6d-db.env && set +a && \
  exec npx tsx -e \"\$(cat /tmp/p6d-probe.mts)\""      # DATABASE_URL from the pm2 env of forge-control
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
FORGE_CONTROL_URL=http://127.0.0.1:7788 ./node_modules/.bin/next build     # the rewrite is baked AT BUILD
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a            # a READ of the live checkout
tmux new-session -d -s p6dweb "cd $PWD && AUTH_URL=http://127.0.0.1:7787 AUTH_SECRET='$AUTH_SECRET' \
  FORGE_CONTROL_URL=http://127.0.0.1:7788 exec ./node_modules/.bin/next start -p 7787"
node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
  token:{name:"phase6d",email:"perf@localhost",sub:"perf"},
  secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400})))' > /tmp/p6d-cookie.txt
PORT=7787 FORGE_SESSION_COOKIE="$(cat /tmp/p6d-cookie.txt)" \
  SHOT_DIR=/opt/ai-os/uploads/$FORGE_RUN_ID STAMP=$(date -u +%Y%m%dT%H%M%SZ) node /tmp/p6d-shot.cjs
```

## 6. What is NOT done, and is deliberately left

* **Repeat-grouping is off** (§1). One boolean, one ruling.
* **The Inbox mirror is untouched.** 51 of Konrad's open inbox items are delivered-reminder mirrors
  (`reminders-triage.md` §4). That is a second surface needing a second ruling, and the Inbox belongs
  to another lane.
* **No desktop reminders surface** was added. `DesktopApp.tsx` and `nav-items.ts` belong to the
  `surfaces` lane; the Capture pane is the only reminders list in the product.
* **The `?days=` window is not persisted.** Expanding the fold is per-visit state. If Konrad wants a
  30-day default he has option 3 of the escalation block, and it is then a one-line change to
  `REMINDER_VIEW_DEFAULT_DAYS`, which both the route and the client read from one place.
* **The live end-to-end delivery test (R81) is the gating reviewer's**, by the brief, so exactly one
  task creates exactly one row and the arithmetic above stays legible.
