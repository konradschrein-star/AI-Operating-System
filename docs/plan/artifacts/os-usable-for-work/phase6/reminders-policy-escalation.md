# Reminders retention policy — the escalation, and the ruling

**Requirement R78: policy is PROPOSED, NOT IMPOSED.** No reminder data and no reminders surface may be
changed until the ruling below is recorded. **Task D implements this file and nothing wider.**

---

## 1. What was sent

**One** outbound curl — the only outbound action of phase 6 task B.

```bash
curl -sX POST http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/message \
  -H 'content-type: application/json' \
  -d @/tmp/reminders-policy.json
```

The payload was assembled in Python (`json.dump`) rather than by shell quoting, so the fenced block
survived intact, and was validated before sending: the block between the fences parses as JSON, and the
opening fence sits at the start of its own line (an indented fence is not a block at all).

`"from": "worker"`, `"sender_run_id": "c3286d5f-aa7d-4636-8eb0-031b8d1bb1cf"` — this task's own
`$FORGE_RUN_UUID`, passed through as a shell variable, never pasted.

### 1.1 Exact text sent, verbatim

```text
Reminders triage (phase 6 / perf lane) — the complaint is not a delivery defect.

176 reminders, 0 pending, nothing overdue, nothing undelivered — it is a 47-day delivered history rendered as a to-do list. (The brief's figure of 124 was measured this morning; 63 rows were created today, all by our own agents, so the number moves while you read this.) Nothing will be deleted; deleting a reminder needs your explicit instruction and you have not given one.

Two surfaces show them, not one. The Capture pane lists 100 rows OLDEST-FIRST — the top of the screen is a 2 July "smoke test reminder", 18 phone-screens of scroll below it — and the 56 newest rows fall off the LIMIT 100 entirely, so today is invisible. Your mobile Inbox badge is separately 100% reminder mirror: 51 open items, every single one a delivered reminder.

I need one ruling before task D touches the surface.
```

followed by the block, fence at line start:

~~~text
```forge:ui
{"kind":"choice","prompt":"How should the reminders list behave? Nothing is ever deleted — hide, group, collapse only.","options":[
 {"value":"reminders: keep the default — pending plus the last 7 days delivered, older collapsed into a counted history fold, recurring as one row, dismissal persists","label":"Default (7-day window)","hint":"what ships if you say nothing"},
 {"value":"reminders: pending only, every delivered row goes straight into the history fold","label":"Pending only","hint":"strictest; history is one click away"},
 {"value":"reminders: pending plus the last 30 days delivered, otherwise the default","label":"30-day window","hint":"more history in view"},
 {"value":"reminders: group repeated texts into one row with a count (the watchdog 4x and 3x clusters), keep the 7-day window","label":"Group repeats too","hint":"collapses the noise that makes it look broken"}]}
```
~~~

### 1.2 Two deliberate departures from the text the brief dictated — disclosed

The brief specified the prose above the block word for word. Two changes were made, both because the
brief also ordered the figures to be **reproduced** (STEP 1, N10) and reproduction contradicted them.
A manager report is read by Konrad; sending a number this task had just measured as false would be
lying to him with his own instrument.

1. **"124 reminders" → "176 reminders", with the discrepancy explained in the same sentence.** The
   table held **176** rows at 20:16:06 UTC and **179** by 20:21:40. 124 was accurate when
   `00-vision.md` §2.6 measured it this morning; 63 rows arrived during the day, written by this
   fleet's own agents.
2. **One paragraph added, naming the second surface.** STEP 2 of the brief explicitly asks: *"if
   Konrad is seeing 124 somewhere else (the inbox, a Telegram digest, the Today API), name that
   surface, because it changes what task D must build."* It does — 100 % of his open Inbox is reminder
   mirror — so it is named. See `reminders-triage.md` §4, including why that is a **separate** ruling
   and is deliberately **not** in the choice block.

Everything else — the structure of the sentence, the "nothing will be deleted" clause, and the entire
`forge:ui` block including all four option values, labels and hints — was sent **exactly** as dictated.

## 2. Timestamps and response

| | |
|---|---|
| **Sent (UTC)** | **2026-08-18T20:20:51Z** |
| **HTTP response** | **202** — `{"queued":true,"delivery":"next-turn","echo":true}` |
| Landed in the manager thread | 2026-08-18T20:20:51.489Z, thread entry 2393, `role: user`, `kind: comms`, `peer_run_id: c3286d5f-aa7d-4636-8eb0-031b8d1bb1cf` — verified by reading `GET /api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2` |
| Manager run status at send time | `running` (not `failed`, so no 409 hazard) |

`202 / next-turn` means the manager relays it to Konrad on its next turn; it is not a delivery receipt
from Konrad.

## 3. THE RULING

<!-- RULING BLOCK — the single thing task D reads. -->

**DEFAULT TAKEN on 2026-08-18: pending + last 7 days delivered; older collapsed into a counted history
fold; recurring renders as one row; per-item dismissal persists.**

**Why the default, and not a longer wait.** The report was delivered into the manager thread at
20:20:51Z. The thread was then polled once a minute to **20:36:16Z**. In that window the manager posted
**19 further assistant turns** (the last at 20:35:59Z) and **Konrad posted 0** — counted, not eyeballed:

```python
after = [m for m in thread if m['ts'] > '2026-08-18T20:20:51.489']
human = [m for m in after if m['role'] == 'user' and m.get('kind') != 'comms']   # len 0
```

(The `kind != 'comms'` filter matters: worker reports arrive in the thread as `role: user` too, so an
unfiltered count would have shown five "replies" that were other lanes' escalations, not Konrad.)

**The absence is confirmed, not inferred.** At 20:23:06Z the manager itself wrote *"Konrad's away and
five lanes are running concurrently"*, and at 20:24:41Z *"I'm seeding no new projects or lanes until
you rule"*. A sibling lane hit the same wall the same evening: worker `d1f5b807` reported at 20:21:13Z
that its Businesses-tab question "landed 18:51:39Z and you never answered it", and took its own stated
default.

Taking the default is therefore the **stated behaviour of the escalation**, not a guess: the block
labels this option *"what ships if you say nothing"*, and he said nothing. Blocking task D on an
absent operator would have been the failure mode the brief names — *"never end without recording a
decision. An unrecorded ruling leaves task D unable to start."*

**This ruling is revisable at zero cost until task D commits.** If Konrad clicks any of the four
options later, the click writes a line beginning `reminders:` into his composer; that line supersedes
this paragraph, and whoever sees it should amend this section rather than start a new argument.

### 3.1 What the default authorises task D to build — exhaustively

| # | Behaviour | Status |
|---|---|---|
| D1 | `pending` rows render first, always visible, never folded | **authorised** |
| D2 | Delivered rows from the **last 7 days** render in the open list | **authorised** |
| D3 | Delivered rows **older than 7 days** collapse into **one** row carrying a **count** (`76 older · show`), expandable in place | **authorised** |
| D4 | A `recur IS NOT NULL` reminder renders as **one** row, not one per occurrence | **authorised** (forward-looking: there are **0** recurring rows today — see `reminders-triage.md` §1.6; task D must not claim a row-count reduction from it) |
| D5 | Per-item dismissal **persists** — the existing `POST /reminders/:id/dismiss` behaviour is preserved, not replaced | **authorised** |

**Which timestamp the "7 days" is measured from — decided here so task D does not guess.** Use
**`due_at`**: it is when the reminder *fired*, which is the moment Konrad remembers, and it is the
column the list is already ordered by, so the window and the sort agree. `delivered_at` is the truest
record of delivery but is `NULL` on any `pending` row (1 of 160 non-dismissed at the time of writing),
and a `NULL` in a window predicate silently drops the row — the one class of row that must never be
hidden. (Counts below measured 20:31Z, by which point the table had grown to 160 non-dismissed; the
ratios, not the absolutes, are the point.) `created_at` answers a different question (when it was *queued*). The three barely differ on
today's data, which is exactly why the choice must be written down rather than discovered later:

```sql
SELECT count(*) FILTER (WHERE created_at   >= now()-interval '7 days') AS by_created_at,    -- 84
       count(*) FILTER (WHERE due_at       >= now()-interval '7 days') AS by_due_at,        -- 84
       count(*) FILTER (WHERE delivered_at >= now()-interval '7 days') AS by_delivered_at,  -- 83
       count(*) FILTER (WHERE delivered_at IS NULL)                    AS delivered_at_null -- 1
FROM reminders WHERE status <> 'dismissed';
```

Pending rows are exempt from the window entirely (D1), whatever their dates.

### 3.2 What the default does NOT authorise

- **No deletion.** Not one row, not a purge, not an archive-by-delete. Deleting a reminder requires
  Konrad's explicit instruction and he has not given one.
- **No auto-dismissal.** Dismissal is a write, and from Konrad's side of the screen an automatic one is
  indistinguishable from deletion. Only he dismisses.
- **No change to delivery.** `executor.ts`'s `reminderTick`, `claimDueReminders()`, the `inbox_items`
  mirror and the Telegram path are untouched. This is the only working route to his inbox and it is out
  of scope for the entire phase.
- **No repeat-grouping.** That is option 4 of the block and Konrad did not pick it. The clusters are
  documented (`reminders-triage.md` §1.5 — 6 clusters, 15 rows) and stay as separate rows.
- **No 30-day window.** Option 3, not picked.
- **No Inbox change.** The 51 open reminder mirrors are a **second** surface needing a **second**
  ruling, and the Inbox belongs to another lane (`reminders-triage.md` §4).
- **No desktop reminders surface.** None exists, and `DesktopApp.tsx` / `nav-items.ts` belong to the
  `surfaces` lane.

### 3.3 Two fixes that are not policy, and ride along regardless

Both are correctness, not preference, so they need no ruling — but task D should carry them, because
the windowed list is what makes the first one safe to ship:

1. **Sort delivered rows newest-first.** `db/reminders.ts:68` orders `due_at ASC`, which is why the
   phone opens on a 2 July smoke test. Pending still floats to the top.
2. **Stop the silent `LIMIT 100` truncation.** 156 non-dismissed rows exist, 100 are returned, 56 are
   dropped with no flag — and all 56 dropped rows are from today. Either the window brings the count
   under the cap (it does: 80) or the unfiltered branch returns `truncated: true`, the way the
   `?contains=` branch already does.

Also worth carrying, cosmetic: the header reads a bare `REMINDERS` with **no number and no unit**, and
the empty state reads `none pending.` for a list of *delivered* rows. Label the count with its unit.
