# P6 fix cycle 2 — resolving the four R604 review findings

Round 604, branch `project/4120f785`. Round 603's engine work survived
re-verification intact; what failed the gate was that the fix for R603's
finding 3 — the watcher whose entire job is to tell Konrad the R20 smoke never
ran, and how to re-run it — had been **silently amputated at 500 characters**
by `createReminder`. The evidence document then certified the text that had
been discarded, because it verified the reminder's *status* and never its
*content*.

That is the same defect class the round exists to catch: something that looks
armed and isn't. So this cycle fixes the truncation, not only its two victims.

Nothing here touches the live checkout. `git -C /opt/forge-ai-os status
--porcelain` is empty before and after, `forge-executor` is still pid 744650
(3 restarts, unchanged), and the detached `safe-restart.sh` chain launched by
P6 is still in its wait loop — which is again why the payload was still
fixable: the chained `curl … --data @/tmp/p6-r20-smoke.json` reads the file at
POST time, not at launch time.

---

## Finding 1 — `createReminder` truncated silently (HIGH)

**The defect.** `db/reminders.ts` enforced the 500-char limit inside the
INSERT parameter list:

```ts
input.text.slice(0, 500),
```

No error, no warning, HTTP 201. Both round-603 reminders were stored at
*exactly* 500 characters, cut mid-word:

| Reminder | Stored | Cut at | What was lost |
|---|---|---|---|
| `4b20dd16` | 500 | `…Expect TWO tasks: round` | the two-task assertion and the corrected `docs/research/` glob check — i.e. the reminder half of R603 finding 2 |
| `a3c10b77` | 500 | `…then tail ` | the entire re-arm command and the pointer to the committed payload — i.e. the whole remediation the R603 finding-3 watcher existed to deliver |

The concrete failure: `safe-restart.sh` exits 2 at 03:26Z, the `&&` chain
short-circuits, R20 never runs, and at 04:00Z Konrad receives a fragment
ending in "then tail " with no instruction on how to re-arm.

**The fix, in two parts.**

*The truncation itself.* The limit moved out of the INSERT and into
`src/lib/reminder-text.ts`, which exports `REMINDER_TEXT_MAX`,
`ReminderTextTooLongError` and `assertReminderTextFits()`. `createReminder`
now calls the assert and passes `input.text` through unmodified. The limit
stays — reminders land on a phone — but over-length text is an error the
caller sees, never a shortened string it doesn't:

| Caller | Before | After |
|---|---|---|
| `POST /api/reminders` | 201 + truncated body | **400** `{error, length, max}` |
| telegram `/remind` | truncated reminder, cheerful confirmation | "too long — N chars, max 500. Send it as several /remind commands" |
| `createReminder()` direct | truncated row | throws `ReminderTextTooLongError` |

It lives in `lib/` rather than `db/` so it is testable without opening a pg
Pool — `pnpm test` globs `src/lib/*.test.ts`, and importing `db/reminders.ts`
would construct one.

*The two victims.* The reminders API exposes only create and dismiss, so the
correction is again a replace — but this time as four reminders that fit,
split so that each carries one complete thought, and **byte-compared against
storage before anything was dismissed**:

| Reminder | Due | Chars | Role |
|---|---|---|---|
| `fe30783f` | 2026-08-05 17:26Z (19:26 local) | 485 | check #1a — where to look |
| `b67cf1e8` | 2026-08-05 17:26Z (19:26 local) | 489 | check #1b — the pass criteria, incl. "only ONE task = FAILED" |
| `f54b5653` | 2026-08-06 04:00Z (06:00 local) | 491 | check #2a — the timeout watcher |
| `4b7e6a83` | 2026-08-06 04:00Z (06:00 local) | 488 | check #2b — the re-arm command and payload pointer |
| `4b20dd16`, `a3c10b77` | — | 500, 500 | dismissed, truncated, superseded |

The script that issued them (`/tmp/r604-reissue-reminders.py`) refuses to POST
anything over the limit — it caught two of its own drafts at 502 and 515 chars
before they reached the still-truncating deployed API — then re-reads every
reminder through `GET /api/reminders` and compares byte-for-byte with what it
sent. Its output:

```
=== read-back verification (GET /api/reminders) ===
  fe30783f  len=485  status=pending   INTACT (byte-identical to what was sent)
  b67cf1e8  len=489  status=pending   INTACT (byte-identical to what was sent)
  f54b5653  len=491  status=pending   INTACT (byte-identical to what was sent)
  4b7e6a83  len=488  status=pending   INTACT (byte-identical to what was sent)

=== dismissing the truncated pair ===
  4b20dd16  {'ok': True}
  a3c10b77  {'ok': True}
```

Note that the fix to `createReminder` did **not** protect these writes: it is
in this worktree, undeployed, and the running forge-control still truncates.
The pre-flight length check is what stood in for it. That is precisely why the
read-back is the verification of record and the `pending` status is not.

## Finding 2 — the evidence doc certified text that was never stored (MEDIUM)

`p6-fix-cycle-1.md` claimed at line 65 that the reminder "was re-issued with
the same glob semantics", and at line 85 that "check #2 carries the re-arm
command and points at the committed copy of the payload". Neither string
survived storage. Line 87 recorded the verification that was actually
performed — "created and confirmed `pending`" — which is exactly the check
that cannot see this failure.

Both passages in `p6-fix-cycle-1.md` are now marked **Corrected in round 604**,
state what was actually lost, and point here. The claims are replaced below by
the text read back out of Postgres — `psql`, not the API, and not the create
response:

```
--- fe30783f (485 chars, due 2026-08-05 17:26:00.225+00) ---
P6 R20 smoke — check #1a of 2 (T+2h). Replaces 4b20dd16, which was stored
truncated. Step 1: tail /var/log/forge-safe-restart.log — the detached
safe-restart.sh forge-executor lands only once the fleet goes idle (exit 0 =
restarted; exit 2 = gave up, possible as late as 05:26 CEST tomorrow — check
#2a watches for that). Step 2: 20s after the restart the scratch project
p6-r20-researcher-smoke is POSTed; find it at
http://127.0.0.1:7700/api/projects. Pass criteria are in check #1b.

--- b67cf1e8 (489 chars, due 2026-08-05 17:26:00.237+00) ---
P6 R20 smoke — check #1b of 2, PASS CRITERIA for p6-r20-researcher-smoke.
(1) It must have EXACTLY TWO tasks: round 1 researcher + round 2 reviewer. If
it has only ONE task the smoke FAILED — ignore any 'done' status, that is the
silent-green auto-close bug reproducing. (2) The researcher must have
committed one markdown file under docs/research/ — the engine picks the
filename, so list the directory, do not look for a fixed name. (3) The round-2
reviewer must end with a VERDICT line.

--- f54b5653 (491 chars, due 2026-08-06 04:00:00.24+00) ---
P6 R20 smoke — check #2a of 2, the watcher for the safe-restart TIMEOUT
branch. Replaces a3c10b77, which was stored truncated. safe-restart.sh
forge-executor launched 17:26 CEST 2026-08-05, max wait 43200s, so it can log
'gave up after 43200s — NOT restarting' and exit 2 as late as 05:26 CEST
today. The R20 POST is chained to it with &&, so exit 2 means the researcher
smoke NEVER RAN. Check: pgrep -fa safe-restart (absent = the chain finished),
then tail /var/log/forge-safe-restart.log.

--- 4b7e6a83 (488 chars, due 2026-08-06 04:00:00.243+00) ---
P6 R20 smoke — check #2b of 2, RE-ARM. Run if #2a showed exit 2, or if
p6-r20-researcher-smoke is missing from /api/projects. Canonical payload:
docs/plan/evidence/p6-r20-smoke.json on branch project/4120f785, worktree
/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365 — copy to
/tmp/p6-r20-smoke.json if /tmp was cleared, then: curl -sS -X POST
http://127.0.0.1:7700/api/projects -H 'content-type: application/json'
--data @/tmp/p6-r20-smoke.json — then apply check #1b.
```

(Line wrapping is this document's; the stored rows are single-line. The
character counts above are the stored `length(text)`.)

Both truncated originals are confirmed `dismissed` in the same query.

## Finding 3 — Haiku owned a two-task verbatim paste (MEDIUM)

**The defect.** `architect_tier: "fast"` maps to `claude-haiku-4-5` at medium
effort (`project-tick.ts` `TIER_MODELS`). R603's finding-1 fix had quietly
enlarged that architect's job from "create one task" into "create two tasks,
paste two multi-paragraph briefs verbatim, and substitute a UUID throughout
the second one". If it drops Task B, `closeFinishedProjects()` closes the
project `done` with no verification — byte-for-byte the R603 outcome. Nothing
in the engine asserts Task B exists, and the human backstop that would have
caught it had been truncated away at the words "Expect TWO tasks".

**The fix.** `architect_tier` is now `"standard"` (`claude-opus-5`, effort
high). The review allowed `junior` or `standard`; `standard` was taken because
the failure mode is silent and unguarded on the engine side, and the run is a
single short task where the tier costs nothing that matters. The payload diff
is one line — the brief is byte-identical:

```
-  "architect_tier": "fast",
+  "architect_tier": "standard",
```

The second half of the fix is human: reminder `b67cf1e8` (check #1b) now
carries the explicit assertion — *"It must have EXACTLY TWO tasks … If it has
only ONE task the smoke FAILED — ignore any 'done' status"*. Model choice
lowers the odds; the reminder is what catches it when the odds lose.

`/tmp/p6-r20-smoke.json` was refreshed with an atomic `mv` (write-then-rename,
so the waiting chain can never read a half-written file) and re-diffed against
the committed copy: identical. The chain is still alive on pid 1617631.

## Finding 4 — unasserted slice end-markers (LOW)

**The defect.** `r20-smoke-arming.test.ts` asserted `start > 0` for each role
branch but never checked that the *end* marker was found. A renamed guard
makes `indexOf` return -1, `slice(start, -1)` runs to EOF, and a branch-scoped
assertion silently becomes a whole-file one. Since the `scout` branch carries
a `docs/research/round-…` string identical to the researcher's, the F2
assertion would still have passed with the researcher branch's own filename
instruction deleted. A file whose stated contract is to "go stale loudly" had
a path that went stale quietly.

**The fix.** Both slices — and the architect slice inside the F4 block, which
had the same defect — now go through one `roleBranch(role, endRole)` helper
that asserts `end > start` before slicing.

**Proof the defect was real.** With `scout` renamed to `recon` in a scratch
copy of `project-tick.ts`, the old slice logic produced a 24,323-character
region instead of the 532-character branch, and the F2 assertion passed
against it:

```
end marker index: -1 (-1 = not found)
old slice length: 24323 vs branch-only: 532
F2 assertion under the OLD slice: PASSES (silently wrong)
scout branch also carries that filename: true
```

The same mutation against the fixed test aborts the file at load:
`AssertionError: the scout branch no longer follows the researcher branch —
this test has gone stale`.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (forge-control) | exit 0 |
| `pnpm test` | **tests 209, pass 209, fail 0** (was 201 — 8 new) |
| Reminder text read back from Postgres | 4/4 byte-identical to what was sent |
| Truncated pair `4b20dd16` / `a3c10b77` | `dismissed`, confirmed by `psql` |
| Payload vs `/tmp/p6-r20-smoke.json` | byte-identical after the atomic refresh |
| `git -C /opt/forge-ai-os status --porcelain` | empty |
| `forge-executor` | pid 744650, 3 restarts — untouched |
| Detached P6 chain | pid 1617631, still waiting, will read the `standard`-tier payload |

### Mutation check

Every new guard was run against the exact text it is meant to reject:

| Mutation | Result |
|---|---|
| restore `input.text.slice(0, 500)` in `createReminder` | `reminder-text.test.ts` **1 fail** ("the round-604 defect, by name") |
| `architect_tier` back to `"fast"` | `r20-smoke-arming.test.ts` **1 fail** |
| rename the `scout` guard in `project-tick.ts` | `r20-smoke-arming.test.ts` **aborts at load**, stale-marker message |

All three files were restored afterwards; `git diff --quiet` on
`project-tick.ts` confirms the engine source is untouched by this cycle.

### New tests

- `src/lib/reminder-text.test.ts` (7) — the limit itself (at, under, one over),
  the error's `length`/`max`/message, and source-level assertions that the
  three enforcement points did not drift back: no `input.text.slice(` in
  `createReminder`, a 400 mapping in the route, a length guard in the telegram
  `/remind` path. `db/` and `routes/` are read as text rather than imported —
  importing either constructs a pg Pool.
- `src/lib/r20-smoke-arming.test.ts` (+1, plus the `roleBranch` end-marker
  assertions) — the architect tier must not be `fast`, must be one the route
  accepts, and must exist in `TIER_MODELS`; the `fast → claude-haiku` mapping
  is itself asserted, since it is the premise of the finding.

## Left for a later cycle

Unchanged from cycle 1: `buildPrompt()` appends a hardcoded research filename
*after* the brief, so any brief naming its own path silently loses. Still not
fixed here — it is deployed-engine behaviour that would not reach the running
executor before R20 fires.

Newly noted: `REMINDER_TEXT_MAX` is 500 by convention, not by schema — the
column is unbounded `text`. If reminders ever need to carry a payload rather
than a sentence, the limit is the thing to revisit, not the enforcement.
