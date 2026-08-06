# CP2-2 — C9 re-verified against the current reconciler (round 1001)

Scope: 06 C9 and the four claims 07 §7 makes about it, re-read against the code as it stands on
`project/4120f785` at round 1001 — i.e. AFTER R850 (tester joined `VERDICT_ROLES`) and AFTER R906
(`markVerdictTaskDone`'s optimistic concurrency, `unsettledVerdictTasks`, the two pre-checks, the
pending-input sweep) — plus four questions 07 §7 predates because CP2's verbs did not exist when it
was written.

Every line number below is this worktree at commit `2e784b8` (CP2-1's `clearPendingInput` landed
mid-round; §E re-checks against it and the re-check is recorded at the end of §E). Nothing in this
document was run against a live service: the argument is source-level, per the worktree-only policy,
and the structural facts it rests on are pinned by
`forge-control/src/lib/cp2-reconciler-interaction.test.ts`.

**Bottom line up front: A, C, D, E, G hold. B holds for the interleaving it was written for and has a
hole R906 did not close (F1). F splits — F(i) exposes a second hole (F2), F(ii) is acceptable. H
holds, and answering it surfaced a third, operationally likely problem (F3).**

---

## 0. The machine, in the five facts the rest of this depends on

1. **Entry into reconciliation is one query.** `reconcileSettledTasks()`
   (`project-tick.ts:1207-1208`) starts from `listSettledRunningTasks()` and nothing else. A round is
   consolidated only if that query returned at least one of its verdict tasks
   (`project-tick.ts:1256-1259` builds the `verdictRounds` map; `:1285` is the ONLY call site of
   `consolidateVerdictGroup` in the repo — grepped, and pinned by a test).
2. **That query filters the TASK, not just the run** (`db/projects.ts:745-756`):
   ```sql
   FROM project_tasks pt JOIN runs r ON r.id = pt.run_id
   WHERE pt.status = 'running'
     AND r.status IN ('completed','failed','cancelled','stuck')
   ```
3. **The group query does not filter the task at all** (`db/projects.ts:780-800`): `LEFT JOIN runs r`,
   `WHERE pt.project_id = $1 AND pt.round = $2 AND pt.role = ANY($3)`. Deliberate, and documented at
   `:775-777` — a `done` member stays in the group so a late sibling cannot re-decide the round on a
   partial view.
4. **`settled` is computed from the run's CURRENT status and nothing else**
   (`project-tick.ts:764`): `settled: r.run_status === "completed"`. Any member not settled ⇒
   `consolidateVerdictRound` returns `wait` before parsing anything
   (`project-reconcile.ts:257-260`).
5. **The verdict text is the newest `assistant` entry of the run, by thread timestamp**
   (`db/projects.ts:108-112`, `LAST_ASSISTANT_TEXT`, shared by both queries), and `parseVerdict`
   takes the LAST `VERDICT:` match in that one message (`project-reconcile.ts:87-102`). Comms entries
   are `role:"user"` (receiver) and `role:"agent"` (echo) per 07 §3, so no control-plane traffic can
   ever be mistaken for a verdict.

---

## A. A `done` task is invisible to the reconciler forever

**Claim (07 §7, bullet 1).** Task marked `done` ⇒ invisible to `listSettledRunningTasks` ⇒ resuming
its run later cannot re-reconcile, double-notify or re-consolidate.

**Code.** Fact 0.2's `WHERE pt.status = 'running'`. `TaskStatus` never returns from `done` to
`running`: the only writers of task status are `setTaskStatus` (`db/projects.ts:543`),
`markVerdictTaskDone` (which only ever writes `'done'`, `:579-580`), `claimReadyTasks`
(`ready → running`) and `retryTask` (`failed|blocked → ready`, `:648-654` — note `done` is NOT in its
`WHERE status IN ('failed','blocked')`). So `done` is terminal for the row, and the run's later life
is irrelevant to fact 0.1's entry query.

**Interleaving tried.** Reviewer task T is `done`, its run R is `completed`. Manager posts
`/api/runs/R/resume-chat`; R goes `queued`, runs another turn, settles `completed` again with a
different verdict text.
- `listSettledRunningTasks` → T not returned (`pt.status='done'`). No per-task path, no notification.
- No round key is added for T. If T's round has no other `running` verdict task, the round is never
  re-entered: no second fix chain, no second push, no re-consolidation.

**Verdict: HOLDS**, for the task itself. But note what A does NOT say, and 07 §7 reads as if it did:
invisibility protects T from being *re-decided*; it does not stop T from *vetoing* its round through
fact 0.3 + 0.4. That is F2, argued in §F(i).

---

## B. A settled-but-not-yet-consolidated reviewer, messaged or resumed

**Claim (07 §7, bullet 2).** The run leaves `completed` ⇒ the group's `settled` turns false ⇒ the
group waits ⇒ the FINAL settled text is the verdict. Plus the R906 half: `markVerdictTaskDone`
carries `AND r.status='completed'`, reports whether the row moved, a refusal aborts the decision, and
the `block`/`fix` branches pre-check with `unsettledVerdictTasks` immediately before their
irreversible side effect.

**Code, in order of the two windows.**

*Window 1 — the message beats `listVerdictRound`'s read.* `/message` to a `completed` target is
`append_and_queue` (`run-control-rules.ts:140-143`), written by `appendCommsEntry` with
`setStatus:'queued', clearCompletedAt, clearWakeAfter` (`routes/run-control.ts:102-106, 203-206`) in
ONE `UPDATE` (`db/runs.ts:725-756`, one `pool.query`). `listVerdictRound` then reads
`run_status='queued'` ⇒ `settled:false` (fact 0.4) ⇒ `consolidateVerdictRound` returns `wait` at
`project-reconcile.ts:260`, before `parseVerdict` is called at all. Nothing is marked, nothing is
created, nothing is pushed (`project-tick.ts:780-789`). Next tick re-reads. ✔

*Window 2 — the message lands AFTER that read.* This is R905's red-team S4. The decision is computed
from a stale snapshot; the guard is now:
```sql
UPDATE project_tasks pt SET status='done', updated_at=now()
  FROM runs r
 WHERE pt.id=$1 AND r.id=pt.run_id AND r.status='completed'   -- db/projects.ts:579-585
```
returning `(r.rowCount ?? 0) > 0` (`:587`). `markGroupDone` (`project-tick.ts:1023-1029`) collects
refusals; all four branches consume them:
- `pass` — mark-done FIRST (`:798`), abort before any notification or `roundIsComplete`
  (`:799-802`). A PASS is the decision with no undo, so nothing precedes it.
- `block` — `unsettledVerdictTasks` pre-check (`:855-864`) immediately before `setProjectStatus`
  (`:865`) and the push (`:870`); conditional mark-done after (`:879-880`).
- `fix` — same pre-check (`:901-910`) immediately before `createFixChain` (`:912`); conditional
  mark-done after the chain exists (`:979-983`), and a refusal returns BEFORE the fix-cycle push
  (`:998-1005`), so a chain whose premise may have been withdrawn is never announced.
- `wait` — no side effect at all.

**Interleaving tried, and where it breaks (F1).** The claim rests on the sentence in
`db/projects.ts:567-570`: *"`r.status='completed'` is an exact detector … every write that could
deliver a message to a settled run moves it out of `completed` in the SAME statement as the
append. So a row still `completed` here is a row whose text nobody has touched."*

The first sentence is true (see §E and §G — I enumerated every `thread = thread ||` writer in the
repo). **The second does not follow.** A row can be `completed` and still owe a turn carrying an
already-appended, undelivered message — via the 07 §5 handshake:

1. Reviewer run R is `running` and has already streamed its final `VERDICT: PASS` assistant entry
   into the thread (`executor.ts:483-493` appends stream events without touching status).
2. `POST /api/runs/R/message` → `append_and_flag`: comms entry appended, `metadata.pending_input=true`,
   status stays `running` (`run-control-rules.ts:135-139`; `db/runs.ts:730-735`).
3. The turn ends. E1 (`executor.ts:388-401`) writes `status='completed'` … `RETURNING
   metadata->>'pending_input'`.
4. **The executor dies here** — OOM, `pm2 restart`, or this project's own DETACHED
   `safe-restart.sh`, which is a routine event, not a thought experiment. E2 (`:430-439`) never runs.
   The row is now `completed`, `pending_input='true'`, with an undelivered message in its thread.
   Its only rescuer is `pendingInputSweepTick` (`executor.ts:1611-1637`), which is scoped
   `WHERE status='completed' AND metadata->>'pending_input'='true' AND updated_at < now() - 60s`
   (`:1620-1622`) and runs on the manager loop — i.e. **≥60 s, and unbounded while the executor is
   down**.
5. During that whole window `listSettledRunningTasks` sees `r.status='completed'` (fact 0.2),
   `listVerdictRound` reports `settled:true` (fact 0.4), `unsettledVerdictTasks` reports nothing
   moved (`db/projects.ts:609-616`, `r.status IS DISTINCT FROM 'completed'` — it is not), and
   `markVerdictTaskDone` moves the row (`r.status='completed'` holds). The round closes on the
   PRE-MESSAGE verdict.
6. The sweep (or the returning executor) then requeues R, R takes its extra turn, and its revised
   verdict lands in a task that is `done` — invisible forever by §A. **Honoured zero times, in
   silence.** That is verbatim the outcome R906 exists to prevent; the same defect simply arrives
   through the `running`-target door instead of the `completed`-target door.

The no-crash variant of the same window (between E1 and E2, two back-to-back `await pool.query`
calls in one process) is not practically reachable: the reconciler would have to complete
`listSettledRunningTasks` → `getProject` → `listVerdictRound` → `unsettledVerdictTasks` →
`markVerdictTaskDone` — five round trips — inside one round trip. The crash/restart variant needs no
such luck and lasts a minute or more.

**Verdict: HOLDS for the interleaving 07 §7 documents; F1 stands against the "exact detector"
claim.** See VERDICT section for the file and predicate that would have to change.

---

## C. Terminate of a task's run → cancelled → task fails, project blocks, ONE notification

**Claim (07 §7, bullet 3).** Exactly today's behaviour for a died run — not two notifications, not
zero.

**Code.** `terminateRun` (`db/runs.ts:793-806`) writes `status='cancelled', completed_at=now()` in
one statement, precondition `TERMINATE_ELIGIBLE = queued|running|paused|stuck`
(`run-control-rules.ts:94-99`) — so a double-terminate's second call is refused and no row can end
`cancelled` with a NULL `completed_at`.

`listSettledRunningTasks` includes `'cancelled'` (fact 0.2). In `reconcileSettledTasks` the branch at
`project-tick.ts:1222-1239` fires **before** the `isVerdictRole` check at `:1240`, so a cancelled
REVIEWER never reaches consolidation:
- `deferForUsageWall` refuses immediately — `if (task.run_status !== "failed" ...) return false`
  (`:1149`), so a cancellation is never mistaken for a usage wall.
- `setTaskStatus(failed)` (`:1227`), `setProjectStatus(blocked)` (`:1228`), **one**
  `queueNotification` (`:1233-1237`), then `continue` (`:1238`).

**Count of notifications = 1.** Not two: the task is now `failed`, so fact 0.2's `pt.status='running'`
filter never returns it again, and the group cannot also block-and-push for it (its round would need
another `running` verdict task to be re-entered at all, and that group would see `settled:false` and
`wait` — see the tail below). Not zero: the push is unconditional on this path, and its `.catch(() =>
{})` only swallows a Telegram failure, after the state writes have already landed.

**Tail worth stating (documented, not a finding).** If the cancelled reviewer had a sibling verdict
task in the same round that is still `running` with a `completed` run, that sibling re-triggers the
round every tick and the group answers `wait` forever (the cancelled member is `settled:false` by
fact 0.4, permanently). The sibling therefore sits `running` until Konrad acts. This is visible and
escapable: the project is `blocked`, the push names `POST /api/tasks/<id>/retry`, and `retryTask`
(`db/projects.ts:635-659`) sets the failed task back to `ready` with `run_id = NULL`, which spawns a
fresh run whose settlement releases the group. Same shape as F2 but with a notification and an
operator escape, which is what makes it acceptable and F2 not.

**Verdict: HOLDS.**

---

## D. Stop (pause) → run non-settled → reconciler ignores it

**Claim (07 §7, bullet 4).** The task sits `running` until resumed; the heartbeat keeps reporting it.

**Code.** `stopRun` writes `status='paused'` only, no `completed_at` (`db/runs.ts:768-780`).
`'paused'` is absent from fact 0.2's `r.status IN (...)` list, so the task is not surfaced: no
per-task failure, no `setProjectStatus('blocked')`, no push. In the group it counts as unsettled —
`settled` is `run_status === 'completed'` and nothing else (fact 0.4) — so any round it gates
answers `wait`.

The heartbeat does report it: `listGoalProgress` (`db/projects.ts:417-437`) aggregates
`array_agg(pt.title) FILTER (WHERE pt.status='running')` into `running_titles`, which
`goalHeartbeats` (`project-tick.ts:1313-1333`) prints as `Running: …` every `checkin_hours`
(default 3). The project stays `active`, so it is inside the query's `WHERE p.status='active'`.

**Interleaving tried.** Stop lands while the child is streaming ⇒ the 5 s kill-poll SIGTERMs it and
the catch branch appends its marker while leaving `paused` untouched (07 §1, `executor.ts:591-601`);
the completion guard (`:370`, `AND status='running'`) makes a clean exit in the same window yield to
the operator (`:407-415`). Either way the row is `paused` and the reconciler is blind to it, which is
the intent.

**Verdict: HOLDS.**

---

## E. Resume-chat and the detector — is the requeue ONE statement?

**Question.** CP2 adds a second write that can deliver a message to a settled run. The detector in
`markVerdictTaskDone` is exact only while every such write moves the row out of `completed` in the
SAME statement as the append.

**Answer: yes, one statement — verified against code, not against the plan.** CP2-1 landed during
this round (commit `2e784b8`) and deliberately did NOT add a `resumeRun` helper. Resume rides
`appendCommsEntry` with `eligible: RESUME_ELIGIBLE, setStatus:'queued', clearCompletedAt:true,
clearWakeAfter:true, clearPendingInput:true` — the rationale is written into the helper's JSDoc at
`db/runs.ts:669-702` and names this exact hazard. The body (`db/runs.ts:704-757`) assembles every
mutation into one `sets` array — thread append (`:725`), status (`:727-730`), pending-input raise
(`:731-735`) or strip (`:736-738`), `completed_at`/`wake_after` clears (`:739-740`) — and issues
**exactly one** `pool.query`: `UPDATE runs SET ${sets.join(", ")} WHERE ${where} RETURNING status`
(`:750`). The only other `pool.query` reachable in the function is `readRunStatus` on the
rowcount-0 path (`:753`), which is a SELECT and runs only when nothing was written. `setPendingInput`
+ `clearPendingInput` together throw (`:716-722`) rather than letting fragment order decide — C20.

**What breaks if it ever becomes two statements** (append first, status second):

```
t0  reviewer run R: completed, thread ends "VERDICT: PASS"
t1  resume-chat stmt 1: thread = thread || <comms entry>        R is STILL completed
t2  project-tick: listSettledRunningTasks → task T (running) + R (completed)
t3  listVerdictRound → settled:true, lastText = "VERDICT: PASS" → decision `pass`
t4  unsettledVerdictTasks([T]) → []            (R.status = 'completed', so "settled")
t5  markVerdictTaskDone(T) → rowCount 1        (R.status = 'completed')  → T is 'done'
t6  resume-chat stmt 2: status='queued'
t7  R runs one more turn, says "VERDICT: NEEDS_FIXES"
t8  nothing reads it: T is 'done', invisible to listSettledRunningTasks forever (§A)
```
The round was released on a verdict the reviewer withdrew; the next phase's builders were already
promoted by `promoteReadyTasks`; no log line, no push, no failed task. **The flipped verdict is
honoured zero times, silently** — and unlike a lost message, nothing in the system is left in an
odd state to notice later. Both pre-checks are useless against it because they read the same column
in the same window (t4 and t5 both see `completed`). This is why the split is not a style question:
it re-creates R905's S4 defect with the guard R906 added still in place and still green.

**Re-check at end of round:** re-read `db/runs.ts` after CP2-1's commit; the assertion above is
against the merged code, and `cp2-reconciler-interaction.test.ts` pins the one-statement property so
CP2-3's route work cannot regress it.

---

## F. Resume of a run that is settled but not `completed`

`RESUME_ELIGIBLE = completed|failed|cancelled|stuck|paused` (`run-control-rules.ts:80-86`), so both
sub-cases are reachable by design.

### F(i) — the reconciler already consumed the run

Two shapes, and they differ:

**(a) task `failed` (run was `cancelled`/`failed`/`stuck`).** Resuming R puts it back to `queued`.
`listSettledRunningTasks` needs `pt.status='running'` — the task is `failed` — so it cannot re-enter
the per-task path: no second "task failed" push, no second block. ✔ Cannot re-enter consolidation
either, for the same reason. ✔

**(b) task `done` (round consolidated).** Cannot re-enter consolidation as a *decision* (§A). **But it
can prevent its round from ever deciding — F2.** Facts 0.3 and 0.4 together mean a `done` member is
re-read from the DB on every consolidation of its round and is judged settled or not by its run's
CURRENT status. The comment at `db/projects.ts:775-777` and `project-tick.ts:756-759` assume a `done`
member's run stays `completed` forever. CP2's headline use case — 06 §1's *"Finished sub-agents do
NOT vanish: the manager can re-engage them"* — is exactly what breaks that assumption.

Concrete interleaving, all steps reachable with today's code:

```
round R of project P gates on reviewer A and tester B (both VERDICT_ROLES → ONE group)
t0  both runs settle 'completed'; tick consolidates; decision `pass`
t1  markGroupDone: markVerdictTaskDone(A) → true    → A is 'done'
t2  (before B's mark) POST /api/runs/<B.run>/message   → B's run leaves 'completed'
t3  markVerdictTaskDone(B) → false → refused=[B] → logGroupNotReleased, return
    state: A 'done' (run completed) · B 'running' (run queued)      ← R906's deliberate mixed state
t4  B's extra turn settles 'completed' again → B re-triggers round R every tick (fact 0.1)
t5  manager asks A a follow-up: POST /api/runs/<A.run>/resume-chat  → A's run leaves 'completed'
t6  A's follow-up turn ends 'failed' (or Konrad stops it → 'paused', or terminates it → 'cancelled')
t7  every tick: listVerdictRound returns A (task 'done', run 'failed') + B (task 'running',
    run 'completed') → A.settled = false → consolidateVerdictRound returns `wait` at
    project-reconcile.ts:260 → nothing is marked, nothing is pushed
t8  A's task is 'done', so listSettledRunningTasks NEVER returns it (fact 0.2) → the per-task
    failure path at project-tick.ts:1222 never runs for A → the project is never blocked,
    Konrad is never told, and round R can never close.
```
Terminal state: project `active`, one task `running` forever, `promoteReadyTasks` blocked behind the
unfinished round (an earlier-round task is still outstanding), one `wait (1/2 settled, 1 reviewer +
1 tester)` line every 10 s in the executor log, and a 3-hourly heartbeat that says `Running: <B's
title>` — i.e. it reads as a task still working, not as a wedged round. **Indefinite, silent, and
triggered by the single most ordinary thing the control plane exists to allow.**

The mixed state at t3 is not exotic: `markGroupDone` loops over ALL inputs and does not break on the
first refusal (`project-tick.ts:1025-1027`), so any refusal at all leaves some members `done` and
some `running`, and R906 documents that as the intended shape (`:876-878`). The `block` and
`fix` branches produce it too.

**Verdict: F2 is a finding.** Also worth noting: the same wedge is reachable WITHOUT `/resume-chat`,
through CP1's own verbs — `/message` against A's `completed` run (`completed ∈ QUEUE_ELIGIBLE`,
`run-control-rules.ts:67`) requeues it, and a `/stop` on the now-`queued` run, or simply a follow-up
turn that fails, strands it outside `completed`. So the hole is not strictly new in CP2; CP2 widens
it from "operator messaged a finished reviewer" to "manager asked a finished reviewer a question".

**Corrected at R1005 (review finding 3).** The original sentence here credited `/stop` ALONE with
that wedge. It cannot do it: `STOP_ELIGIBLE` is `queued|running|stuck` and `stopAction("completed")`
returns `{kind:"reject", status:409, reason:"run is already settled (completed)"}`
(`run-control-rules.ts:219-226`), so `/stop` against a `done` member's `completed` run 409s. The
conclusion stands by the `/message`-first route above; the mechanism did not. This sentence carried
the "the hole is not strictly new in CP2" weight, so it had to be right rather than merely
directionally true.

### F(ii) — a `cancelled` run resumed BEFORE the next reconcile tick

```
t0  reviewer task T 'running', run R 'running'
t1  POST /terminate  → R 'cancelled', completed_at stamped
t2  POST /resume-chat (cancelled ∈ RESUME_ELIGIBLE) → R 'queued', completed_at cleared,
    comms entry appended — one statement (§E)
t3  next tick: listSettledRunningTasks → r.status='queued' ∉ ('completed','failed','cancelled',
    'stuck') → T not returned. No task failure, no project block, no push.
    listVerdictRound (if the round is re-entered by a sibling) → run_status='queued' →
    settled:false → `wait`.
```
So the terminate's documented consequence (claim C) is **pre-empted**, not duplicated: the run goes
back to work, the task stays `running`, and the group waits for it. Nothing is double-counted and
nothing is lost.

**Is that acceptable?** Yes, and it is the right reading: a terminate that the operator immediately
undoes should not also fail the task and block the project. Konrad sees it as a running task in the
goal heartbeat (`Running: <title>`), the same way any in-flight task appears; the terminate and the
resume are both in the run's own `GET /comms` and thread. It cannot wedge a round indefinitely,
because the run is `queued` and the executor's claim loop (`executor.ts:141-163`) will pick it up —
`wake_after` is cleared by the resume (`clearWakeAfter`) and again on claim (`:155`), so nothing
parks it. If the resumed run later dies, T is still `running` and the ordinary per-task failure path
fires with its one notification. The only residue is the terminate's `completed_at`, cleared by
`clearCompletedAt` — which is exactly why CP2-1 put those two flags on the resume call.

**Verdict: HOLDS (acceptable, visible).**

---

## G. Sub-agent message — no separate requeue path

**Claim.** The relay is an ordinary comms append against the PARENT under `/message`'s rules, so it
inherits everything above; there must be no other code path that requeues a settled parent without
moving it out of `completed` in the same statement.

**Method.** Enumerated every writer of `runs.thread` in `forge-control/src` (`thread = thread ||`,
the only append idiom — `routes/chat.ts:79` notes the same):

| site | statement shape | settled-run risk |
|---|---|---|
| `db/runs.ts:725-750` `appendCommsEntry` | ONE UPDATE, append + status + flags | none (§E) |
| `db/runs.ts:336-350` `appendMessage` | ONE UPDATE per variant; the `setStatus` variant sets `thread` and `status` together (`:337-342`) | none when `setStatus` is passed |
| `db/runs.ts:559-572` `requeueRunAfterUsageWall` | ONE UPDATE, `WHERE status='failed'` | none — never touches a `completed` row |
| `executor.ts:369-401` `completeRun` | ONE UPDATE (append + status), guarded `AND status='running'` | none |
| `executor.ts:484-492` `appendThreadEntry` | append only, no status | none — streams into a `running` run |

`appendMessage`'s callers: `routes/chat.ts:261-270` (`POST /api/chat/:id/message`, `setStatus:
'queued'`), `routes/chat.ts:291-302` (`POST /:id/resume`, stuck-only, `setStatus:'queued'`),
`lib/telegram-bridge.ts:246-250` (`setStatus:'queued'`). All three deliver-and-requeue in one
statement. ✔

CP2-3's `subagent-message` is specified (07 §4, C10) as a relay-prefixed comms entry appended to the
PARENT under `/message`'s rules — i.e. the same `messageAction` → `MESSAGE_WRITE` →
`appendCommsEntry` pipeline the route already uses at `routes/run-control.ts:185-206`, with the only
addition being the `subagents_v2` address check (`subagentAddressable`,
`run-control-rules.ts:518`), which is pure and writes nothing. There is no second write path to
build, and the test file pins "exactly one `pool.query` in `appendCommsEntry`" so a CP2-3 that
invents one fails the suite.

**Verdict: HOLDS**, with one pre-existing exception found while enumerating, recorded as **F4**:
`routes/chat.ts:248-254` appends a `role:"system"` canvas-delta entry with NO `setStatus`, and then
issues `setRunCanvasSnapshot` and the real append as separate statements. A `completed` run messaged
through the chat UI with a changed canvas therefore sits `completed`-with-a-fresh-thread-entry across
two round trips plus filesystem work. It is a `system` canvas dump, not a verdict, so it cannot flip
a decision by itself — but it is a real (if narrow) instance of the same class as F1, in a D1
never-touch file, and it predates this lane. Noted, not touched.

---

## H. Stop AFTER the verdict text, BEFORE consolidation

**Setup.** Reviewer's turn has already streamed `VERDICT: NEEDS_FIXES` into the thread
(`executor.ts:484-492`, no status change). Operator hits `/stop`. Run is `paused`.

**Trace.**
1. `paused` ∉ fact 0.2's run-status list ⇒ the task is not surfaced ⇒ if this is the round's only
   verdict task, `consolidateVerdictGroup` is not even called (fact 0.1). If a sibling settles, the
   group is entered and answers `wait`, because `settled: r.run_status === "completed"` is false
   (fact 0.4). Either way: **the verdict text sitting in the thread is NOT decided on while the run
   is `paused`.**
2. The group decides only after the run leaves `paused` and lands `completed`. The paths out:
   `/resume-chat` or `/message` (both → `queued`, `paused ∈ QUEUE_ELIGIBLE`,
   `run-control-rules.ts:67`), or `/terminate` (→ `cancelled`, which routes to claim C: task failed,
   project blocked, one push — the pre-stop verdict is never read).
3. **On which text?** `LAST_ASSISTANT_TEXT` (fact 0.5) is `ORDER BY (elem->>'ts')::timestamptz DESC
   LIMIT 1` over `role='assistant'` entries — the newest assistant message in the thread, not the
   one that was last when the stop landed. So the answer is: **the resumed turn's final assistant
   message, and only that one.** The pre-stop `VERDICT: NEEDS_FIXES` is authoritative only if the
   resumed turn adds no assistant entry at all, which does not happen on a run that settles
   `completed` (the CC engine streams every assistant turn; a turn that produces nothing settles
   `failed`/`stuck`, which routes to claim C's failure path instead).

**Which surfaces F3.** `parseVerdict` reads ONE message (`project-reconcile.ts:89-102`). A reviewer
resumed to answer a follow-up ("why did you flag the pool import?") will typically answer the
question and stop. Its last assistant message then has no `VERDICT:` substring ⇒ `parseVerdict` →
`null` ⇒ `consolidateVerdictRound` returns `block(no_verdict)` (`:264-273`) ⇒ the project is blocked
and Konrad gets `🚫 Project "…" blocked — round R verdicts (no_verdict)` on his phone
(`project-tick.ts:865-874`). The verdict the reviewer actually gave is two messages up the thread and
is now unreachable to the parser.

This is loud, not silent — C20-compatible, and strictly better than guessing — but it converts the
control plane's most inviting action (talk to a finished reviewer) into a blocked project. It is a
behaviour CP2 introduces at scale and nothing in the corpus currently warns anyone about.

**Verdict: HOLDS** (the trace answers the question exactly). **F3 is a finding of the
"design/documentation gap" kind**, not a race.

---

## VERDICT

| claim | result |
|---|---|
| A — `done` task invisible to `listSettledRunningTasks` forever | **HOLDS** (`db/projects.ts:754`); see F2 for what it does not cover |
| B — settled-not-consolidated reviewer messaged/resumed → group waits, final text wins; R906 guard + pre-checks | **HOLDS for the documented interleaving; the "exact detector" claim is FALSE → F1** |
| C — terminate → task failed, project blocked, exactly ONE notification | **HOLDS** (`project-tick.ts:1222-1239`) |
| D — stop → non-settled → ignored, task stays `running`, heartbeat reports it | **HOLDS** (`db/projects.ts:755`, `:427`) |
| E — resume-chat's requeue is ONE statement carrying the append | **HOLDS** (`db/runs.ts:704-757`, verified against CP2-1's merged code) |
| F(i) — an already-consumed run, resumed, cannot re-enter consolidation | **HOLDS as stated — but a `done` member can veto its round forever → F2** |
| F(ii) — `cancelled` run resumed before the next tick | **HOLDS, acceptable** — round waits, run is `queued` and will be claimed; no wedge |
| G — subagent-message inherits `/message`'s single-statement write; no other path | **HOLDS** (all five thread writers enumerated); pre-existing exception F4 |
| H — stopped-after-verdict: group waits, decides on the RESUMED turn's text | **HOLDS** — and that is exactly what makes F3 bite |

### F1 — `markVerdictTaskDone`'s detector accepts a `completed` run that owes an undelivered turn

*Interleaving:* §B steps 1-6. `/message` to a RUNNING reviewer sets `pending_input` and leaves the
row `running`; E1 completes it; the executor dies (or is safe-restarted) before E2; the row sits
`completed` + `pending_input='true'` for ≥60 s (`PENDING_INPUT_STRANDED_MS`, `executor.ts:1578`) and
unboundedly longer while the executor is down. Consolidation in that window marks the reviewer task
`done` on the pre-message verdict; the sweep then requeues the run and its revised verdict lands in a
task nothing will ever read. Silent.

*File that would have to change:* `forge-control/src/db/projects.ts` — the predicate in
`markVerdictTaskDone` (`:579-585`) and its mirror in `unsettledVerdictTasks` (`:609-616`). The
minimal repair is to treat a pending message as unsettled, e.g. add
`AND (r.metadata->>'pending_input') IS DISTINCT FROM 'true'` to the mark-done UPDATE and the matching
`OR r.metadata->>'pending_input' = 'true'` to the unsettled predicate — the same column both existing
consumers already read, no migration (C21). The group would then `wait` until the sweep or E2
requeues the run, which is exactly claim B's intended behaviour. Deciding this is the reviewer's and
the next fix cycle's call, not this task's.

*Resolution — FIXED at R1005 (CP2 fix cycle 1).* Both predicates carry the term, and the flag now
travels on `listVerdictRound` as a boolean so the DECISION layer calls such a row unsettled too and
returns `wait` instead of computing a decision it would then have to abandon. The rule itself is
`verdictMemberSettled()` in `lib/project-reconcile.ts`, table-tested (T20) over the full cross
product; the two SQL halves are asserted to be its exact complements in
`cp2-reconciler-interaction.test.ts`. Claim B's "exact detector" sentence in `db/projects.ts` was
rewritten: it no longer claims exactness from `completed` alone, it enumerates the three terms.

### F2 — a `done` group member whose run is later resumed/stopped wedges its round indefinitely

*Interleaving:* §F(i)(b), t0-t8, verbatim. Requires (1) a partially-refused `markGroupDone` (R906's
documented mixed state, `project-tick.ts:1025-1027`) leaving one member `done` and one `running`, and
(2) the `done` member's run leaving `completed` and not returning — `/resume-chat` followed by a
failed turn, or (CP1-only route, see §F(i)'s R1005 correction) `/message` to requeue it followed by a
`/stop` or a failed turn. NOT `/stop` alone: `completed ∉ STOP_ELIGIBLE` and `stopAction` 409s it.
Result: `wait` forever, project stays `active`, no notification, the per-task failure path can never
fire for the `done` member because fact 0.2 filters it out.

*File that would have to change:* `forge-control/src/lib/project-tick.ts` — the `settled` mapping at
`:764`. A task already marked `done` was settled by BOOKKEEPING and its verdict is already in the
round's history; the honest predicate is closer to `settled: r.status === "done" || r.run_status ===
"completed"` (with the corresponding `lastText` sourced the same way). Note the trade-off the fixer
must weigh: that also means a resumed `done` reviewer's NEW text can re-enter a re-decision of its
round with a different verdict, which is arguably desirable and arguably a second S4 — hence a
decision for the reviewer, not a drive-by patch here. `unsettledVerdictTasks`/`markVerdictTaskDone`
would need the matching treatment so the two halves keep agreeing.

*Resolution — FIXED at R1005 (CP2 fix cycle 1), all three parts together,* because the one-line
version the paragraph above proposes is not enough: with only the `settled` mapping changed,
`markGroupDone` still calls `markVerdictTaskDone` for the `done` member whose run is no longer
`completed`, so the round would be refused release forever instead of waiting forever — the same
wedge with a different log line. What landed:

1. `lib/project-reconcile.ts` — `verdictMemberSettled()`: `taskStatus === 'done'` ⇒ settled,
   unconditionally; otherwise `runStatus === 'completed' && !pendingInput`.
   `lib/project-tick.ts`'s mapping calls it instead of testing `run_status` inline.
2. `db/projects.ts` `markVerdictTaskDone` — `AND (pt.status = 'done' OR EXISTS (… completed …))`.
   EXISTS rather than `UPDATE … FROM runs r`, which is an inner join and would strand a `done` task
   whose `run_id` was cleared by `retryTask`.
3. `db/projects.ts` `unsettledVerdictTasks` — `AND pt.status IS DISTINCT FROM 'done'`.

The trade-off flagged above was taken deliberately, and the reviewer at R1004 endorsed it: a resumed
`done` member's NEW text does re-enter `parseVerdict`, so a follow-up that does not restate its
verdict line yields `block(no_verdict)` — loud, pushed, `/unwedge`-recoverable — instead of a silent
wedge. That is F3, and F3's prompt-level closure is now written into CP3's scope in
`docs/plan/09-control-plane-phases.md` rather than living only here.

### F3 — resuming a verdict role blocks the round unless the new turn restates `VERDICT:`

*Interleaving:* §H. `parseVerdict` reads only the LAST assistant message
(`project-reconcile.ts:89-102`, by design — first-match parsing read reviewers' rehearsals). A
reviewer resumed for a follow-up answers the question, its last message carries no `VERDICT:` line,
`consolidateVerdictRound` returns `block(no_verdict)`, and the project is blocked with a push. Loud,
recoverable (`/unwedge` + a re-review), but surprising and currently undocumented.

*File that would have to change:* cheapest and most in keeping with the corpus is prompt-level —
`forge-control/src/lib/project-tick.ts`'s `buildPrompt`, in the MANAGER COMMS block CP3 already plans
to add (C17): tell a verdict role that if it is messaged after it has answered, its reply MUST end
with its `VERDICT:` line again (restating the unchanged one is fine). A reconciler-level alternative
(scan the last N assistant entries for a verdict) is worse: it re-opens exactly the "read the
rehearsal, not the verdict" bug the `/g` + last-match parser was written to close.

### F4 — pre-existing, out of scope, recorded only

`routes/chat.ts:248-254` appends a canvas-delta `system` entry to a possibly-`completed` run without
a status move, two statements before the real message append. Same class as F1, narrower payload
(never a verdict), and in a D1 never-touch file. Not touched, not fixed, named here so the next
person who reads the "exact detector" comment knows the enumeration was complete.

### F5 — the same stranded shape is unguarded on the NON-verdict path (R1006, recorded only)

Raised by the R1006 re-review as an explicitly non-blocking observation, and recorded here rather
than fixed because it is pre-existing, untouched by the R1005 diff, and outside that round's
feedback.

R1005 finding 1's `pending_input` term was applied to the two VERDICT predicates, which is what was
prescribed. `listSettledRunningTasks` (`db/projects.ts`) carries no such filter, so a
builder/planner/architect run stranded `completed` + `pending_input` surfaces as settled, falls
through `project-tick.ts`'s per-task branch into the non-verdict `else`, and is marked `done`. The
stranded-input sweep then requeues the run ~60s later, and that turn's output lands in a task
already closed. Milder than the verdict case — no verdict is buried and no round is decided on it —
but it is the same hole through the same door.

*Owner:* not CP3 (prompts) and not CP4 (deploy). It is a one-term change to one query plus its
complement in the per-task branch, so it belongs to whichever round next opens `db/projects.ts`'s
task-listing surface; until then it lives here, named, with the failure spelled out.

---

## R1005 — the two repaired predicates, EXECUTED (not only source-asserted)

Structural assertions prove the SQL says what it should; they cannot prove Postgres agrees. So both
predicates were run verbatim against a **throwaway `postgres:16-alpine` container** — created for
this check, `--rm`, torn down after, never `content_forge` and never the live checkout — over two
five-column tables carrying one row per interesting cell:

| task | `pt.status` | run | `pending_input` | `unsettledVerdictTasks` | `markVerdictTaskDone` |
|---|---|---|---|---|---|
| a1 | running | completed | – | – | **moved** |
| a2 | running | completed | `'true'` | **unsettled** | refused ← F1 |
| a3 | running | queued | – | **unsettled** | refused |
| a4 | done | failed | – | – | **moved** ← F2 |
| a5 | done | *(run_id NULL)* | – | – | **moved** ← F2, the inner-join trap |
| a6 | running | *(no run)* | – | **unsettled** | refused |

`unsettled = {a2,a3,a6}`, `moved = {a1,a4,a5}`: disjoint, and their union is all six rows — the
complementarity claim, empirically, not just term-for-term in the source. a5 is the case that would
have failed under `UPDATE … FROM runs r`: a `done` task whose run reference `retryTask` cleared can
still re-confirm itself.

Not covered by this: the cross-process ORDERING that creates the states (executor loop vs manager
loop vs HTTP handler). That remains a written argument, for the reason below.

## Not provable by pure/structural test — and why (09 §CP2 allows the written argument)

- **F1's and F2's interleavings** are cross-process orderings between the executor loop, the manager
  loop and an HTTP handler against one Postgres row. There is no test database in this suite and both
  `db/*.ts` and `routes/*.ts` open a pg Pool at module load (see the header of
  `run-control-surface.test.ts`), so no test in this repo can drive them. What IS pinned structurally
  is every predicate the argument rests on: the two `WHERE`s, the LEFT JOIN's missing `pt.status`
  filter, the `settled` mapping, the single-statement append, the E1/E2 split and the sweep's ≥60 s
  scope. If any of those changes, `cp2-reconciler-interaction.test.ts` fails and this document is
  known to be stale.
  **Narrowed at R1005:** the settlement RULE is no longer only structural — it was extracted to the
  pure `verdictMemberSettled()` and is driven over its whole cross product by T20, and both SQL
  predicates were executed against a disposable Postgres (section above). What stays a written
  argument is only the cross-process ordering, not the predicates it acts through.
- **"Exactly one notification" (C)** is asserted structurally (one `queueNotification` call in the
  branch, followed by `continue`), not dynamically — counting real pushes needs the live notification
  queue, which belongs to CP4's deploy verification.
- **F3's likelihood** ("a reviewer answering a follow-up usually does not restate its verdict") is a
  judgement about model behaviour, not a code property. The code property — one message parsed, no
  verdict ⇒ `block(no_verdict)` — is pinned in `project-reconcile.test.ts` already.
