# P6 fix cycle 3 — resolving the three R605 review findings

Round 605, branch `project/4120f785`. R604 closed the *storage* path: reminder
text over 500 characters is now a 400 with numbers instead of a silent
`slice(0, 500)` and a 201. The reviewer then found the same defect class one
file over, on the same data — and, correctly, that none of it was deployed.

This cycle fixes the delivery path and **ships**. It is the first cycle in P6
that ends with live main carrying the fix rather than describing it.

---

## Finding 1 — the inbox card truncated the reminder at delivery (HIGH)

**The defect.** `executor.ts` `reminderTick()` built the card like this:

```ts
rem.text.slice(0, 120),                                    // → title
`Reminder — due ${dueLocal}${recur}`,                      // → ask
```

`inbox_items` has exactly two text-bearing columns, `title` and `ask`. The
title took the first 120 characters and `ask` took only the due line, so the
remainder had nowhere to go. Live proof at review time: three REMINDER cards
sitting at exactly 120 characters, cut mid-sentence. The four armed R20
watchers are 485–491 characters — whose payload *is* the pass criteria and the
re-arm command — and would have surfaced as fragments ending mid-path.

The Telegram push at what is now line 1415 sends `rem.text` whole, so the
phone was never affected. The Console was.

**The fix.** Two pure functions in `lib/reminder-text.ts`, next to the storage
guard they complete:

```ts
export const REMINDER_TITLE_MAX = 120;

export function reminderCardTitle(text: string): string   // a lede
export function reminderCardAsk(text, dueLabel, recur): string  // the payload
```

- `ask` is the reminder **verbatim**, then `\n\n— due <local>` and the
  recurrence when there is one. `inbox_items.ask` is unbounded `text`
  (`db/migrations/0021`), and both Console surfaces — `MobileApp.tsx:671`,
  `DesktopApp.tsx:1719` — render `item.ask` with no clamp. Neither file was
  touched; the parallel operator-visibility project owns them.
- `title` is the reminder's first line, collapsed to single spaces, cut at a
  word boundary and closed with `…` when it overruns the 120-char layout
  budget. The ellipsis is load-bearing: it is what tells a reader the title is
  a lede and the body below is the reminder. A 120-char title is no longer a
  claim to be the whole thing.

`executor.ts` now calls both; no `slice` remains anywhere on the reminder path.

**Tests** (`lib/reminder-text.test.ts`, 9 new):

- The fourth source-level enforcement point the review asked for, in the
  "storage path never truncates" block: `executor.ts` must not match
  `/rem\.text\.slice\(/` and must match
  `reminderCardAsk(rem.text, dueLocal, rem.recur)`.
- Behavioural cover for the rest: `ask` starts with the reminder byte-for-byte
  at 500 chars; the recurrence suffix; short text passing through as its own
  title untouched; elision staying ≤ 120 and ending in `…`; the elided lede
  remaining a real *prefix* of the reminder; no dangling space before the
  ellipsis; a single unbroken 400-char token cut hard rather than emptied
  (`lastIndexOf(" ") === -1`); newlines never leaking into a title; a leading
  blank line falling back to the body instead of yielding an empty title.

---

## Finding 3 — the agent-facing instruction omitted the cap

`lib/cc-runner.ts:129`, the system prompt every run receives, told agents to
POST `/api/reminders` and never mentioned a limit. That omission is what
produced the R603 over-length writes. Post-R604 it produces a 400 an agent may
not read. One line, appended:

> `Max 500 chars; longer text is rejected with 400, split it into several
> reminders.`

---

## Finding 2 — deployment

Live main was `452f5f3`; `8e23860` and `814ce73` were branch-only, so every
reminder the fleet wrote tonight — including Phase 7's key reminders — still
went through the truncating code. P6 is the deploy phase and was ending with
undeployed source in its own diff.

Main had moved (`a27605f`, `452f5f3`), so this was not the fast-forward the
review predicted. P6 protocol: merge main into the branch first, re-verify,
then merge out.

```
$ git merge main            # in the worktree
Merge made by the 'ort' strategy.        → d7f437e, no conflicts

$ npx tsc --noEmit          # after the merge
tsc exit=0
$ pnpm test
# tests 218   # pass 218   # fail 0

$ git diff --name-only main...HEAD | grep -E 'forge-control-web/|routes/agents\.ts|package\.json|pnpm-lock'
(no matches — scope clean)

$ git -C /opt/forge-ai-os merge --ff-only project/4120f785
exit=0   → d7f437e
$ git -C /opt/forge-ai-os status --porcelain
(empty)
```

Live source, post-merge:

| File | Line | State |
|---|---|---|
| `db/reminders.ts` | 49 | `assertReminderTextFits(input.text)` — the `slice` is gone |
| `executor.ts` | 1401–1402 | `reminderCardTitle` / `reminderCardAsk` |
| `cc-runner.ts` | 129 | carries the 500-char cap |

`pm2 restart forge-control` — API-side, explicitly allowed by the brief.
forge-control went 1616560 → **1761744**, restarts 26 → 27, `GET /api/today`
returned 200 six seconds later.

**forge-executor was not touched**: still pid 744650, restarts 3, 9h uptime.
The detached `safe-restart.sh` chain (pids 1617631/1617632, alive since
17:26:03 on 2026-08-04) is still in its wait loop and will load the merged
executor code when the fleet goes idle.

**Live proof of the deployed guard**, against the restarted API:

```
$ curl -X POST :7700/api/reminders -d '{"text":"<501 chars>","when":"in 90m"}'
HTTP=400
{"error":"reminder text is 501 chars, max 500 — split it into several
 reminders; the overflow is not stored","length":501,"max":500}

$ curl -X POST :7700/api/reminders -d '{"text":"<exactly 500 chars>", ...}'
HTTP=201   stored text length: 500   (unsliced)
```

The 500-char probe (`31e651c2`) was dismissed immediately afterwards —
`{"ok":true}` — so it will not reach Konrad's phone.

Rendering that exact stored text through the **deployed** module:

```
stored text length : 500
card title length  : 120 | ends with ellipsis: true
card ask length    : 527
ask contains the FULL text: true
chars lost on delivery: 0
ask tail: "yyyy…yyy\n\n— due 5. Aug. 2026, 22:13"
```

---

## Residual risk, stated plainly

`executor.ts` is executor-loaded. forge-executor is still running the code it
loaded 9 hours ago, and the brief's hard rule — never restart it — stands, so
the R605 fix is *merged* but not yet *live in the process*.

Two R20 watchers (485 and 489 chars) are due **2026-08-05 17:26:00Z**, about
70 minutes after this merge. The fleet is not idle (rounds 700–860 pending),
so the detached restart will very likely not have fired by then, and those two
cards will land truncated at 120 characters — the last two victims of a defect
that is already fixed in source. Their Telegram push carries the full text, so
the payload reaches Konrad regardless; only the Console copy is degraded, and
only until the restart lands. The two 04:00Z watchers and Phase 7's key
reminders (07:00Z) are far enough out to be safe.

Raising it rather than papering over it: the alternative was restarting
forge-executor mid-fleet, which is the one thing this project's constraints
forbid outright and which would kill live runs.

## Carried forward, non-blocking

- `CREATE UNIQUE INDEX IF NOT EXISTS` in `0039` matches by **name** only — an
  index of that name lacking the partial predicate would make the migration a
  silent no-op. `migrations.test.ts` guards the file, not the DB.
- `claimDueReminders` commits `delivered` before `queueNotification` runs; a
  crash in that window loses the reminder outright. Narrow and pre-existing,
  but it is the R20 backstop.
