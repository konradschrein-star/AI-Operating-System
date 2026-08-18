# R29 — every fixed instrument still detects its own subject's breakage

Six controls, one per fixed instrument, each in the five-step shape of
`03-quality.md` §5. Produced at git sha `5823302a8d9d78a59a99be0f6241d779e691e56f` on branch
`project/b7ab4c57`, on the real worktree — every mutation is applied to
the instrument's SUBJECT (app code), never to the instrument, and every one
is reverted with `git status --porcelain` shown empty before the next
control starts.

The six subjects carry the R30 exception in the project brief: a temporary
app mutation that is reverted, leaving the working tree clean and nothing in
the committed diff, is not a committed app change. `git diff --name-only
main...HEAD` is shown at the bottom to prove it.

Instrument runs use the phase-1 command verbatim:
```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/<instrument>
```

## Summary — what each control proved

| # | Instrument | Subject mutated | Step 3 result |
|---|---|---|---|
| 1 | `check-orientation.ts` | `chat/OrientationStrip.tsx` — `findTeamNode` loses `sub.parent_id === runId` | exit 1, **1 FAILURE** — "the SAME sub-agent id under a DIFFERENT parent does not match" |
| 2 | `check-team-confirm.ts` | `team/confirm.ts` — `MIN_CONFIRM_MS` 500 → 150 | exit 1, **5 FAILURES** — incl. "8 clicks 350ms apart (rage-click) → terminates: expected 0, got 4" |
| 3 | `check-team-rows.ts` | `team/teamRows.ts` — the settled freeze deleted from `interpolatedWorkingMs` | exit 1, **4 FAILURES** — incl. "settled row at t+30s is IDENTICAL (U16 frozen truth): expected 130000, got 145000" |
| 4 | `check-dismiss-peek.tsx` | `team/peek.ts` — `dismissedToggleLabel` reverts to "N hidden · show" | exit 1, **2 FAILURES** — "the toggle label reads the same on both" |
| 5 | `check-stop-affordance.tsx` | `team/TeamRow.tsx` — `disabled={stopBlock !== null}` → `disabled={false}` | exit 1, **4 FAILURES** — incl. "a COMPLETED row with stop:true renders a DISABLED ⏸" |
| 6 | `serve-sse-808.ts` | `forge-control/src/routes/chat.ts` — the `/:id/events` liveness guard inverted | **0 bytes** of SSE in 6s where step 1 delivered **232,669**; the server closes the stream itself (`curl_exit=0`, not the `124` a live stream produces) |

Every mutation is a BEHAVIOURAL regression, several of them ones this code has
already shipped once (the 150ms floor is round 506's; the enabled ⏸ on a
settled row is production's state after `8ec83cc`). None is a type error: an
instrument that only notices a broken type would have passed all six.

## Reproducing these by hand

The five steps were driven by a script so that nothing was transcribed from
memory, but every command it ran is printed verbatim in the transcripts below.
The six mutations, in full, are:

```bash
# 1
perl -0pi -e 's/        sub\.id === subagentId &&\n        sub\.parent_id === runId\n/        sub.id === subagentId\n/' \
  forge-control-web/app/desktop/chat/OrientationStrip.tsx
# 2
perl -0pi -e 's/export const MIN_CONFIRM_MS = 500;/export const MIN_CONFIRM_MS = 150;/' \
  forge-control-web/app/desktop/team/confirm.ts
# 3
perl -0pi -e 's/  if \(row\.node\.settled\) return base;\n//' \
  forge-control-web/app/desktop/team/teamRows.ts
# 4
perl -pi -e 's/\} dismissed · \$\{/} hidden · \${/' \
  forge-control-web/app/desktop/team/peek.ts
# 5
perl -0pi -e 's/            disabled=\{stopBlock !== null\}/            disabled={false}/' \
  forge-control-web/app/desktop/team/TeamRow.tsx
# 6
perl -0pi -e 's/      if \(!alive\) return false;\n      try \{\n        await stream\.writeSSE\(\{ event, data \}\);/      if (alive) return false;\n      try {\n        await stream.writeSSE({ event, data });/' \
  forge-control/src/routes/chat.ts
```

Each is reverted with `git checkout -- <subject>`.


---

## 1. `check-orientation.ts` → `forge-control-web/app/desktop/chat/OrientationStrip.tsx`

**The behaviour broken:** `findTeamNode` matches a sub-agent on its
`tool_use_id` **under the parent it was spawned from**. Removing the
`sub.parent_id === runId` conjunct is the exact mis-attribution the
function's own comment names — a `tool_use_id` collision across two runs
attaching one worker's task to another's row.

**1. Green, before anything is touched**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts

── plan position is arithmetic on task.round, nothing else ──
PASS  round 601 → phase 600→700
PASS  round 603 → phase 600→700
PASS  round 600 → phase 600→700
PASS  round 699 → phase 600→700
PASS  round 700 → phase 700→800
PASS  round 500 → phase 500→600
PASS  round 0 → phase 0→100
PASS  round 42 → phase 0→100
PASS  round -1 yields no phase at all
PASS  round 1.5 yields no phase at all
PASS  round NaN yields no phase at all
PASS  round Infinity yields no phase at all

── a tree only supplies a task for the node it describes ──
PASS  a worker is found by run id
PASS  the manager is found by run id
PASS  a sub-agent is found by tool_use_id under its parent
PASS  the SAME sub-agent id under a DIFFERENT parent does not match
PASS  an unknown run id does not match
PASS  a run id is never satisfied by a sub-agent whose id happens to equal it

── every degraded state is named, never blank (NFU6) ──
PASS  no active team query → team-not-polling
PASS  an errored query → team-error
PASS  a pending query → team-loading
PASS  a live tree that does not contain the node → node-absent
PASS  a node with no task → no-task
PASS  a node with a task → not degraded
PASS  …and it carries the task title
PASS  …and derives phase 600 from round 601
PASS  …with 700 next
PASS  team-not-polling carries no task
PASS  team-not-polling carries no plan
PASS  node-absent carries no task
PASS  node-absent carries no plan
PASS  no-task carries no task
PASS  no-task carries no plan
PASS  "team-not-polling" has rendered text
PASS  "team-error" has rendered text
PASS  "team-loading" has rendered text
PASS  "node-absent" has rendered text
PASS  "no-task" has rendered text
PASS  a junk payload is not a TeamResponse
PASS  null is not a TeamResponse
PASS  the real tree is
PASS  a junk payload degrades rather than matching
PASS  the tree containing the node wins over one that does not

── the four observed activity kinds, per round-599 §taxonomy ──
PASS  a non-object activity is null
PASS  an empty object is null, not four blanks
PASS  assistant_text → writing
PASS  …with the prose verbatim as its detail
PASS  tool_call → calling <tool>
PASS  …and the tool name is not repeated as its own detail
PASS  tool_result → <tool> returned
PASS  …with the outcome snippet
PASS  thinking → thinking
PASS  …with no detail to show
PASS  an unseen kind is shown verbatim
PASS  …and marked as not understood
PASS  a known kind is marked known
PASS  a long line is clipped to the budget + ellipsis
PASS  …and marked clipped
PASS  …and is a prefix of the original
PASS  a short line is untouched
PASS  …and not marked
PASS  newlines collapse to spaces for a one-line strip

── against the 285-entry reference run ──
PASS  the reference run has a current_activity
PASS  …of kind assistant_text
PASS  …rendered as 'writing'
PASS  …whose detail is the architect's own words, verbatim
PASS  …and it carries the timestamp the executor stamped

ALL PASS — orientation strip derivation
exit=0
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control-web/app/desktop/chat/OrientationStrip.tsx b/forge-control-web/app/desktop/chat/OrientationStrip.tsx
index 0c1f14d..53b9b08 100644
--- a/forge-control-web/app/desktop/chat/OrientationStrip.tsx
+++ b/forge-control-web/app/desktop/chat/OrientationStrip.tsx
@@ -240,8 +240,7 @@ export function findTeamNode(
       if (
         subagentId !== undefined &&
         sub.kind === "subagent" &&
-        sub.id === subagentId &&
-        sub.parent_id === runId
+        sub.id === subagentId
       ) {
         return sub;
       }
```

**3. The instrument, against the broken subject**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts

── plan position is arithmetic on task.round, nothing else ──
PASS  round 601 → phase 600→700
PASS  round 603 → phase 600→700
PASS  round 600 → phase 600→700
PASS  round 699 → phase 600→700
PASS  round 700 → phase 700→800
PASS  round 500 → phase 500→600
PASS  round 0 → phase 0→100
PASS  round 42 → phase 0→100
PASS  round -1 yields no phase at all
PASS  round 1.5 yields no phase at all
PASS  round NaN yields no phase at all
PASS  round Infinity yields no phase at all

── a tree only supplies a task for the node it describes ──
PASS  a worker is found by run id
PASS  the manager is found by run id
PASS  a sub-agent is found by tool_use_id under its parent
FAIL  the SAME sub-agent id under a DIFFERENT parent does not match
        expected null, got {"role":"Explore","model":null,"status":"running","tokens":{"input":0,"output":0,"cache_read":0,"cache_creation":0,"total":0},"working_ms":null,"working_ms_source":null,"started_at":null,"settled":false,"description":null,"parent_id":"3853c154-e07b-4378-9313-2b34f4a33342","dismissed_at":null,"subagents":[],"task":null,"id":"toolu_014raMUrJcAiXV61BerokrjN","kind":"subagent"}
PASS  an unknown run id does not match
PASS  a run id is never satisfied by a sub-agent whose id happens to equal it

── every degraded state is named, never blank (NFU6) ──
PASS  no active team query → team-not-polling
PASS  an errored query → team-error
PASS  a pending query → team-loading
PASS  a live tree that does not contain the node → node-absent
PASS  a node with no task → no-task
PASS  a node with a task → not degraded
PASS  …and it carries the task title
PASS  …and derives phase 600 from round 601
PASS  …with 700 next
PASS  team-not-polling carries no task
PASS  team-not-polling carries no plan
PASS  node-absent carries no task
PASS  node-absent carries no plan
PASS  no-task carries no task
PASS  no-task carries no plan
PASS  "team-not-polling" has rendered text
PASS  "team-error" has rendered text
PASS  "team-loading" has rendered text
PASS  "node-absent" has rendered text
PASS  "no-task" has rendered text
PASS  a junk payload is not a TeamResponse
PASS  null is not a TeamResponse
PASS  the real tree is
PASS  a junk payload degrades rather than matching
PASS  the tree containing the node wins over one that does not

── the four observed activity kinds, per round-599 §taxonomy ──
PASS  a non-object activity is null
PASS  an empty object is null, not four blanks
PASS  assistant_text → writing
PASS  …with the prose verbatim as its detail
PASS  tool_call → calling <tool>
PASS  …and the tool name is not repeated as its own detail
PASS  tool_result → <tool> returned
PASS  …with the outcome snippet
PASS  thinking → thinking
PASS  …with no detail to show
PASS  an unseen kind is shown verbatim
PASS  …and marked as not understood
PASS  a known kind is marked known
PASS  a long line is clipped to the budget + ellipsis
PASS  …and marked clipped
PASS  …and is a prefix of the original
PASS  a short line is untouched
PASS  …and not marked
PASS  newlines collapse to spaces for a one-line strip

── against the 285-entry reference run ──
PASS  the reference run has a current_activity
PASS  …of kind assistant_text
PASS  …rendered as 'writing'
PASS  …whose detail is the architect's own words, verbatim
PASS  …and it carries the timestamp the executor stamped

1 FAILURE(S) — orientation strip derivation
exit=1
```

**4. Revert**
```
$ git checkout -- forge-control-web/app/desktop/chat/OrientationStrip.tsx
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-orientation.ts

── plan position is arithmetic on task.round, nothing else ──
PASS  round 601 → phase 600→700
PASS  round 603 → phase 600→700
PASS  round 600 → phase 600→700
PASS  round 699 → phase 600→700
PASS  round 700 → phase 700→800
PASS  round 500 → phase 500→600
PASS  round 0 → phase 0→100
PASS  round 42 → phase 0→100
PASS  round -1 yields no phase at all
PASS  round 1.5 yields no phase at all
PASS  round NaN yields no phase at all
PASS  round Infinity yields no phase at all

── a tree only supplies a task for the node it describes ──
PASS  a worker is found by run id
PASS  the manager is found by run id
PASS  a sub-agent is found by tool_use_id under its parent
PASS  the SAME sub-agent id under a DIFFERENT parent does not match
PASS  an unknown run id does not match
PASS  a run id is never satisfied by a sub-agent whose id happens to equal it

── every degraded state is named, never blank (NFU6) ──
PASS  no active team query → team-not-polling
PASS  an errored query → team-error
PASS  a pending query → team-loading
PASS  a live tree that does not contain the node → node-absent
PASS  a node with no task → no-task
PASS  a node with a task → not degraded
PASS  …and it carries the task title
PASS  …and derives phase 600 from round 601
PASS  …with 700 next
PASS  team-not-polling carries no task
PASS  team-not-polling carries no plan
PASS  node-absent carries no task
PASS  node-absent carries no plan
PASS  no-task carries no task
PASS  no-task carries no plan
PASS  "team-not-polling" has rendered text
PASS  "team-error" has rendered text
PASS  "team-loading" has rendered text
PASS  "node-absent" has rendered text
PASS  "no-task" has rendered text
PASS  a junk payload is not a TeamResponse
PASS  null is not a TeamResponse
PASS  the real tree is
PASS  a junk payload degrades rather than matching
PASS  the tree containing the node wins over one that does not

── the four observed activity kinds, per round-599 §taxonomy ──
PASS  a non-object activity is null
PASS  an empty object is null, not four blanks
PASS  assistant_text → writing
PASS  …with the prose verbatim as its detail
PASS  tool_call → calling <tool>
PASS  …and the tool name is not repeated as its own detail
PASS  tool_result → <tool> returned
PASS  …with the outcome snippet
PASS  thinking → thinking
PASS  …with no detail to show
PASS  an unseen kind is shown verbatim
PASS  …and marked as not understood
PASS  a known kind is marked known
PASS  a long line is clipped to the budget + ellipsis
PASS  …and marked clipped
PASS  …and is a prefix of the original
PASS  a short line is untouched
PASS  …and not marked
PASS  newlines collapse to spaces for a one-line strip

── against the 285-entry reference run ──
PASS  the reference run has a current_activity
PASS  …of kind assistant_text
PASS  …rendered as 'writing'
PASS  …whose detail is the architect's own words, verbatim
PASS  …and it carries the timestamp the executor stamped

ALL PASS — orientation strip derivation
exit=0
```

---

## 2. `check-team-confirm.ts` → `forge-control-web/app/desktop/team/confirm.ts`

**The behaviour broken:** the confirm floor, put back to the 150ms that
round 506 defeated with four discrete clicks 350ms apart. Not a type error
— a real regression this machine already shipped once.

**1. Green, before anything is touched**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-confirm.ts
── constants ────────────────────────────────────────────────
PASS  arm window is 3s (U17)
PASS  confirm floor is 500ms — the platform multi-click window
PASS  the disabled tooltip names the contract flag (NFU6)

── fire-without-arm ─────────────────────────────────────────
PASS  first click on a running row arms, never fires
PASS  …and with capabilities off it still only arms
PASS  an arming on a DIFFERENT row does not count as this row's arming
PASS  …and arming this row is what disarms the other (one slot, this id wins)

── fire under the floor: double-click bypass ────────────────
PASS  two clicks in the same tick: second is swallowed
PASS  a physical double-click (40ms) is swallowed
PASS  499ms is still too fast
PASS  a clock that ran backwards lands on the safe side
PASS  a swallowed click does NOT disarm — the row is still armed after it
PASS  the floor exactly is a deliberate second click (capabilities on → fires)

── sustained click STREAMS (round 505 finding #1) ───────────
PASS  20 clicks 30ms apart, capabilities ON → terminates
PASS  …and every click after the first is a rearm, never a fire
PASS  3 clicks 60ms apart → terminates
PASS  3 clicks 149ms apart → terminates
PASS  8 clicks 350ms apart (rage-click) → terminates
PASS  6 clicks 499ms apart → terminates
PASS  30 clicks 33ms apart (held key cadence) → terminates
PASS  200 clicks 10ms apart → terminates
PASS  …the same 200-click stream with capabilities OFF
PASS  a ragged sub-floor stream (14 clicks) → terminates
PASS  two deliberate clicks 1s apart still fire exactly once
PASS  …and with capabilities OFF the same pair fires nothing
PASS  a stream that PAUSES past the floor fires once, at the pause

── spurious activations are dropped before the machine ──────
PASS  a plain single click is honoured
PASS  the 2nd click of a double-click is dropped
PASS  the 3rd of a triple-click is dropped
PASS  a 15th rapid click is dropped
PASS  keyboard activation (detail 0) is honoured
PASS  …but an autorepeat keydown is dropped — one held Enter is one decision
PASS  25 autorepeat keydowns yield 0 activations

── arm + 3.1s: the arming goes stale ────────────────────────
PASS  at 3.0s the arming still holds
PASS  at 3.1s it reads as disarmed even though no timer ran
PASS  …and a click at 3.1s RE-ARMS instead of firing (capabilities on)
PASS  a five-minute-old 'sure?' cannot be cashed in

── capability-false: the guard holds even when armed ────────
PASS  armed + past the floor + capabilities off → blocked at the gate
PASS  …at the very end of the arm window too
PASS  the SAME input with the flag on is the only thing that fires

── settled rows: dismiss is one click, and reversible ───────
PASS  X on a settled row dismisses immediately
PASS  …even while another row is armed
PASS  …and capabilities are irrelevant to it (nothing leaves the browser)

── stop ─────────────────────────────────────────────────────
PASS  stop with the flag off is blocked at the gate
PASS  …with reason 'capability'
PASS  stopping an already-settled row is refused, not faked
PASS  stop fires only with the flag on and a live row

── exhaustive sweep: nothing fires today ────────────────────
PASS  90 combinations swept, terminates issued

── restore-all: the two-click confirm ───────────────────────
PASS  first click can only ARM — a fresh control never restores
PASS  a second click after a real pause restores
PASS  …and 1ms under the floor does not
PASS  a double-click's trailing half is swallowed
PASS  a stale arming re-arms rather than firing
PASS  exactly at the arm window, still a confirm
PASS  a clock that ran backwards lands on the safe side
PASS  32 sub-floor click streams, restore-alls issued
PASS  two deliberate clicks restore exactly once

ALL PASS — team confirm machine
exit=0
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control-web/app/desktop/team/confirm.ts b/forge-control-web/app/desktop/team/confirm.ts
index 5213f8a..a2c8de8 100644
--- a/forge-control-web/app/desktop/team/confirm.ts
+++ b/forge-control-web/app/desktop/team/confirm.ts
@@ -99,7 +99,7 @@ export const ARM_WINDOW_MS = 3_000;
  *  is still only a fifth of the 3s arm window, so a person who reads "sure?"
  *  and clicks has 2.5 full seconds to do it. Nothing a hand does inside half a
  *  second is a considered second act. */
-export const MIN_CONFIRM_MS = 500;
+export const MIN_CONFIRM_MS = 150;
 
 /** Which row is armed, and when it was armed. One instance for the whole
  *  panel — arming a second row replaces this, which is what disarms the
```

**3. The instrument, against the broken subject**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-confirm.ts
── constants ────────────────────────────────────────────────
PASS  arm window is 3s (U17)
FAIL  confirm floor is 500ms — the platform multi-click window
        expected 500, got 150
PASS  the disabled tooltip names the contract flag (NFU6)

── fire-without-arm ─────────────────────────────────────────
PASS  first click on a running row arms, never fires
PASS  …and with capabilities off it still only arms
PASS  an arming on a DIFFERENT row does not count as this row's arming
PASS  …and arming this row is what disarms the other (one slot, this id wins)

── fire under the floor: double-click bypass ────────────────
PASS  two clicks in the same tick: second is swallowed
PASS  a physical double-click (40ms) is swallowed
FAIL  499ms is still too fast
        expected rearm:worker-a, got terminate:worker-a
PASS  a clock that ran backwards lands on the safe side
PASS  a swallowed click does NOT disarm — the row is still armed after it
PASS  the floor exactly is a deliberate second click (capabilities on → fires)

── sustained click STREAMS (round 505 finding #1) ───────────
PASS  20 clicks 30ms apart, capabilities ON → terminates
PASS  …and every click after the first is a rearm, never a fire
PASS  3 clicks 60ms apart → terminates
PASS  3 clicks 149ms apart → terminates
FAIL  8 clicks 350ms apart (rage-click) → terminates
        expected 0, got 4
FAIL  6 clicks 499ms apart → terminates
        expected 0, got 3
PASS  30 clicks 33ms apart (held key cadence) → terminates
PASS  200 clicks 10ms apart → terminates
PASS  …the same 200-click stream with capabilities OFF
PASS  a ragged sub-floor stream (14 clicks) → terminates
PASS  two deliberate clicks 1s apart still fire exactly once
PASS  …and with capabilities OFF the same pair fires nothing
PASS  a stream that PAUSES past the floor fires once, at the pause

── spurious activations are dropped before the machine ──────
PASS  a plain single click is honoured
PASS  the 2nd click of a double-click is dropped
PASS  the 3rd of a triple-click is dropped
PASS  a 15th rapid click is dropped
PASS  keyboard activation (detail 0) is honoured
PASS  …but an autorepeat keydown is dropped — one held Enter is one decision
PASS  25 autorepeat keydowns yield 0 activations

── arm + 3.1s: the arming goes stale ────────────────────────
PASS  at 3.0s the arming still holds
PASS  at 3.1s it reads as disarmed even though no timer ran
PASS  …and a click at 3.1s RE-ARMS instead of firing (capabilities on)
PASS  a five-minute-old 'sure?' cannot be cashed in

── capability-false: the guard holds even when armed ────────
PASS  armed + past the floor + capabilities off → blocked at the gate
PASS  …at the very end of the arm window too
PASS  the SAME input with the flag on is the only thing that fires

── settled rows: dismiss is one click, and reversible ───────
PASS  X on a settled row dismisses immediately
PASS  …even while another row is armed
PASS  …and capabilities are irrelevant to it (nothing leaves the browser)

── stop ─────────────────────────────────────────────────────
PASS  stop with the flag off is blocked at the gate
PASS  …with reason 'capability'
PASS  stopping an already-settled row is refused, not faked
PASS  stop fires only with the flag on and a live row

── exhaustive sweep: nothing fires today ────────────────────
PASS  90 combinations swept, terminates issued

── restore-all: the two-click confirm ───────────────────────
PASS  first click can only ARM — a fresh control never restores
PASS  a second click after a real pause restores
PASS  …and 1ms under the floor does not
PASS  a double-click's trailing half is swallowed
PASS  a stale arming re-arms rather than firing
PASS  exactly at the arm window, still a confirm
PASS  a clock that ran backwards lands on the safe side
FAIL  32 sub-floor click streams, restore-alls issued
        expected 0, got 262
PASS  two deliberate clicks restore exactly once

5 FAILURE(S) — team confirm machine
exit=1
```

**4. Revert**
```
$ git checkout -- forge-control-web/app/desktop/team/confirm.ts
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-confirm.ts
── constants ────────────────────────────────────────────────
PASS  arm window is 3s (U17)
PASS  confirm floor is 500ms — the platform multi-click window
PASS  the disabled tooltip names the contract flag (NFU6)

── fire-without-arm ─────────────────────────────────────────
PASS  first click on a running row arms, never fires
PASS  …and with capabilities off it still only arms
PASS  an arming on a DIFFERENT row does not count as this row's arming
PASS  …and arming this row is what disarms the other (one slot, this id wins)

── fire under the floor: double-click bypass ────────────────
PASS  two clicks in the same tick: second is swallowed
PASS  a physical double-click (40ms) is swallowed
PASS  499ms is still too fast
PASS  a clock that ran backwards lands on the safe side
PASS  a swallowed click does NOT disarm — the row is still armed after it
PASS  the floor exactly is a deliberate second click (capabilities on → fires)

── sustained click STREAMS (round 505 finding #1) ───────────
PASS  20 clicks 30ms apart, capabilities ON → terminates
PASS  …and every click after the first is a rearm, never a fire
PASS  3 clicks 60ms apart → terminates
PASS  3 clicks 149ms apart → terminates
PASS  8 clicks 350ms apart (rage-click) → terminates
PASS  6 clicks 499ms apart → terminates
PASS  30 clicks 33ms apart (held key cadence) → terminates
PASS  200 clicks 10ms apart → terminates
PASS  …the same 200-click stream with capabilities OFF
PASS  a ragged sub-floor stream (14 clicks) → terminates
PASS  two deliberate clicks 1s apart still fire exactly once
PASS  …and with capabilities OFF the same pair fires nothing
PASS  a stream that PAUSES past the floor fires once, at the pause

── spurious activations are dropped before the machine ──────
PASS  a plain single click is honoured
PASS  the 2nd click of a double-click is dropped
PASS  the 3rd of a triple-click is dropped
PASS  a 15th rapid click is dropped
PASS  keyboard activation (detail 0) is honoured
PASS  …but an autorepeat keydown is dropped — one held Enter is one decision
PASS  25 autorepeat keydowns yield 0 activations

── arm + 3.1s: the arming goes stale ────────────────────────
PASS  at 3.0s the arming still holds
PASS  at 3.1s it reads as disarmed even though no timer ran
PASS  …and a click at 3.1s RE-ARMS instead of firing (capabilities on)
PASS  a five-minute-old 'sure?' cannot be cashed in

── capability-false: the guard holds even when armed ────────
PASS  armed + past the floor + capabilities off → blocked at the gate
PASS  …at the very end of the arm window too
PASS  the SAME input with the flag on is the only thing that fires

── settled rows: dismiss is one click, and reversible ───────
PASS  X on a settled row dismisses immediately
PASS  …even while another row is armed
PASS  …and capabilities are irrelevant to it (nothing leaves the browser)

── stop ─────────────────────────────────────────────────────
PASS  stop with the flag off is blocked at the gate
PASS  …with reason 'capability'
PASS  stopping an already-settled row is refused, not faked
PASS  stop fires only with the flag on and a live row

── exhaustive sweep: nothing fires today ────────────────────
PASS  90 combinations swept, terminates issued

── restore-all: the two-click confirm ───────────────────────
PASS  first click can only ARM — a fresh control never restores
PASS  a second click after a real pause restores
PASS  …and 1ms under the floor does not
PASS  a double-click's trailing half is swallowed
PASS  a stale arming re-arms rather than firing
PASS  exactly at the arm window, still a confirm
PASS  a clock that ran backwards lands on the safe side
PASS  32 sub-floor click streams, restore-alls issued
PASS  two deliberate clicks restore exactly once

ALL PASS — team confirm machine
exit=0
```

---

## 3. `check-team-rows.ts` → `forge-control-web/app/desktop/team/teamRows.ts`

**The behaviour broken:** U16's frozen truth. `interpolatedWorkingMs`
returns a settled row's value unchanged; deleting that line lets a finished
run's working time keep climbing on the client's clock.

**1. Green, before anything is touched**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-rows.ts
── flattenTeam: ordering + depth ─────────────────────────────
PASS  row count = 1 manager + 2 workers + 2 sub-agents
PASS  order is manager, worker-a, its two sub-agents, worker-b
PASS  depths are 0,1,2,2,1
PASS  manager has no parent description
PASS  a worker's parentDescription is the manager's
PASS  a sub-agent's parentDescription is its worker's
PASS  displayWorkingMs is node.working_ms verbatim
PASS  manager's own sub-agents render at depth 1, before the workers
PASS  a chat with no project still renders its manager
PASS  …at depth 0

── flattenTeam: dismissal ────────────────────────────────────
PASS  dismissing a worker takes its sub-agents with it
PASS  dismissing one sub-agent leaves its sibling and its parent
PASS  dismissing the manager hides only the manager's subtree, not the workers
PASS  dismissing everything yields an empty array
PASS  an unknown dismissed id changes nothing

── flattenTeam: hiddenCount is ROWS, not ids (round 505 #3) ──
PASS  nothing dismissed → 0
PASS  dismissing a parent counts its whole subtree
PASS  …and it equals the rows actually withheld
PASS  ids matching nothing count 0
PASS  …and every row still renders
PASS  a leaf dismissal counts 1
PASS  nested dismissals do not double-count
PASS  …rows left = manager + worker-b
PASS  dismissing everything counts every node
PASS  …and renders nothing
PASS  junk beside a real dismissal does not inflate the count

── flattenTeam: hiddenRows, the peek list ───────────────────
PASS  nothing dismissed → no peek rows
PASS  a dismissed parent brings its whole subtree into the peek
PASS  …so the list matches the label exactly
PASS  …at the depths they had in the tree
PASS  …only the dismissed node itself is restorable
PASS  …and the peeked children carry their lineage
PASS  a dismissed leaf is one restorable peek row
PASS  …and it is restorable
PASS  …while its parent stays in the main list
PASS  a nested dismissal does not add a second peek entry
PASS  …and stays non-restorable while its parent is hidden
PASS  …count and list still agree
PASS  restoring the parent surfaces the child's own dismissal
PASS  …now restorable in its own right
PASS  …and it is the child
PASS  everything dismissed → every node is peekable
PASS  …in tree order
PASS  …three of them restorable
PASS  …and nothing left in the main list
PASS  ids matching nothing produce no peek rows
PASS  …and no phantom count
PASS  the cache holds only the rendered rows
PASS  …not the peeked ones
PASS  …and the peek list is still complete
PASS  (sanity: the full tree cached five)

── flattenTeam: wrapper identity (round 1302 L1) ─────────────
PASS  same response twice → same row count
PASS  same response twice → EVERY wrapper is the identical object
PASS  …and the nodes inside them are untouched too
PASS  one node changed → exactly one fresh wrapper
PASS  …and it is the node that changed
PASS  …every other wrapper survives by identity
PASS  the fresh wrapper carries the new node, not the stale one
PASS  a renamed parent refreshes itself AND its sub-agents' wrappers
PASS  no cache → no wrapper is shared
PASS  …but the content is identical
PASS  dismissal removes the subtree's rows
PASS  …and the survivors keep their identity across it
PASS  …the cache dropped the dismissed subtree
PASS  …and kept exactly the rendered rows
PASS  restore brings every row back
PASS  …the never-dismissed manager still keeps identity
PASS  …the restored rows are fresh wrappers
PASS  manager-only tree caches exactly one wrapper
PASS  everything dismissed → no rows
PASS  …hiddenCount still counts ROWS, not ids
PASS  …and the cache is empty, not stale

── interpolatedWorkingMs ─────────────────────────────────────
PASS  responseNowMs parses the response clock
PASS  settled row at t = the server's value
PASS  settled row at t+30s is IDENTICAL (U16 frozen truth)
PASS  …and identical to itself, not merely close
PASS  settled row six hours later is still identical
PASS  running row at t = the server's value
PASS  running row grows with the clock
PASS  running row grows to exactly the cap at +15s
PASS  running row CLAMPS past the cap (poll stalled, tab backgrounded)
PASS  a clock behind the response never subtracts
PASS  an unparsable response clock yields the base, not NaN
PASS  null on a settled row stays null at t
PASS  null on a settled row stays null at t+30s
PASS  null on a running row stays null at t
PASS  null on a running row stays null at t+30s — unknown never becomes 0
PASS  a measured 0 survives as 0, not null
PASS  …and renders as '0s', not '—'

── fmtWorkingTime ───────────────────────────────────────────
PASS  null → em dash, NEVER '0s'
PASS  negative → em dash
PASS  NaN → em dash
PASS  measured zero → '0s'
PASS  45s
PASS  59.9s floors to 59s
PASS  60s → '1m 00s'
PASS  12m 30s
PASS  1h 04m

── fmtTokens ────────────────────────────────────────────────
PASS  0 → '0'
PASS  negative → '0'
PASS  NaN → '0'
PASS  987 → '987'
PASS  987.4 rounds to '987'
PASS  999 → '999'
PASS  1000 → '1.0k'
PASS  9999 → '10.0k'
PASS  12_345 → '12.3k'
PASS  204_700 → '205k'
PASS  1_200_000 → '1.20M'
PASS  12_300_000 → '12.3M'

ALL PASS — team row model
exit=0
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control-web/app/desktop/team/teamRows.ts b/forge-control-web/app/desktop/team/teamRows.ts
index f28de17..15b0b39 100644
--- a/forge-control-web/app/desktop/team/teamRows.ts
+++ b/forge-control-web/app/desktop/team/teamRows.ts
@@ -386,7 +386,6 @@ export function interpolatedWorkingMs(
 ): number | null {
   const base = row.displayWorkingMs;
   if (base === null) return null;
-  if (row.node.settled) return base;
   if (!Number.isFinite(responseNow) || !Number.isFinite(nowMs)) return base;
   const elapsed = Math.min(
     Math.max(0, nowMs - responseNow),
```

**3. The instrument, against the broken subject**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-rows.ts
── flattenTeam: ordering + depth ─────────────────────────────
PASS  row count = 1 manager + 2 workers + 2 sub-agents
PASS  order is manager, worker-a, its two sub-agents, worker-b
PASS  depths are 0,1,2,2,1
PASS  manager has no parent description
PASS  a worker's parentDescription is the manager's
PASS  a sub-agent's parentDescription is its worker's
PASS  displayWorkingMs is node.working_ms verbatim
PASS  manager's own sub-agents render at depth 1, before the workers
PASS  a chat with no project still renders its manager
PASS  …at depth 0

── flattenTeam: dismissal ────────────────────────────────────
PASS  dismissing a worker takes its sub-agents with it
PASS  dismissing one sub-agent leaves its sibling and its parent
PASS  dismissing the manager hides only the manager's subtree, not the workers
PASS  dismissing everything yields an empty array
PASS  an unknown dismissed id changes nothing

── flattenTeam: hiddenCount is ROWS, not ids (round 505 #3) ──
PASS  nothing dismissed → 0
PASS  dismissing a parent counts its whole subtree
PASS  …and it equals the rows actually withheld
PASS  ids matching nothing count 0
PASS  …and every row still renders
PASS  a leaf dismissal counts 1
PASS  nested dismissals do not double-count
PASS  …rows left = manager + worker-b
PASS  dismissing everything counts every node
PASS  …and renders nothing
PASS  junk beside a real dismissal does not inflate the count

── flattenTeam: hiddenRows, the peek list ───────────────────
PASS  nothing dismissed → no peek rows
PASS  a dismissed parent brings its whole subtree into the peek
PASS  …so the list matches the label exactly
PASS  …at the depths they had in the tree
PASS  …only the dismissed node itself is restorable
PASS  …and the peeked children carry their lineage
PASS  a dismissed leaf is one restorable peek row
PASS  …and it is restorable
PASS  …while its parent stays in the main list
PASS  a nested dismissal does not add a second peek entry
PASS  …and stays non-restorable while its parent is hidden
PASS  …count and list still agree
PASS  restoring the parent surfaces the child's own dismissal
PASS  …now restorable in its own right
PASS  …and it is the child
PASS  everything dismissed → every node is peekable
PASS  …in tree order
PASS  …three of them restorable
PASS  …and nothing left in the main list
PASS  ids matching nothing produce no peek rows
PASS  …and no phantom count
PASS  the cache holds only the rendered rows
PASS  …not the peeked ones
PASS  …and the peek list is still complete
PASS  (sanity: the full tree cached five)

── flattenTeam: wrapper identity (round 1302 L1) ─────────────
PASS  same response twice → same row count
PASS  same response twice → EVERY wrapper is the identical object
PASS  …and the nodes inside them are untouched too
PASS  one node changed → exactly one fresh wrapper
PASS  …and it is the node that changed
PASS  …every other wrapper survives by identity
PASS  the fresh wrapper carries the new node, not the stale one
PASS  a renamed parent refreshes itself AND its sub-agents' wrappers
PASS  no cache → no wrapper is shared
PASS  …but the content is identical
PASS  dismissal removes the subtree's rows
PASS  …and the survivors keep their identity across it
PASS  …the cache dropped the dismissed subtree
PASS  …and kept exactly the rendered rows
PASS  restore brings every row back
PASS  …the never-dismissed manager still keeps identity
PASS  …the restored rows are fresh wrappers
PASS  manager-only tree caches exactly one wrapper
PASS  everything dismissed → no rows
PASS  …hiddenCount still counts ROWS, not ids
PASS  …and the cache is empty, not stale

── interpolatedWorkingMs ─────────────────────────────────────
PASS  responseNowMs parses the response clock
PASS  settled row at t = the server's value
FAIL  settled row at t+30s is IDENTICAL (U16 frozen truth)
        expected 130000, got 145000
FAIL  …and identical to itself, not merely close
        expected true, got false
FAIL  settled row six hours later is still identical
        expected 130000, got 145000
PASS  running row at t = the server's value
PASS  running row grows with the clock
PASS  running row grows to exactly the cap at +15s
PASS  running row CLAMPS past the cap (poll stalled, tab backgrounded)
PASS  a clock behind the response never subtracts
PASS  an unparsable response clock yields the base, not NaN
PASS  null on a settled row stays null at t
PASS  null on a settled row stays null at t+30s
PASS  null on a running row stays null at t
PASS  null on a running row stays null at t+30s — unknown never becomes 0
FAIL  a measured 0 survives as 0, not null
        expected 0, got 15000
PASS  …and renders as '0s', not '—'

── fmtWorkingTime ───────────────────────────────────────────
PASS  null → em dash, NEVER '0s'
PASS  negative → em dash
PASS  NaN → em dash
PASS  measured zero → '0s'
PASS  45s
PASS  59.9s floors to 59s
PASS  60s → '1m 00s'
PASS  12m 30s
PASS  1h 04m

── fmtTokens ────────────────────────────────────────────────
PASS  0 → '0'
PASS  negative → '0'
PASS  NaN → '0'
PASS  987 → '987'
PASS  987.4 rounds to '987'
PASS  999 → '999'
PASS  1000 → '1.0k'
PASS  9999 → '10.0k'
PASS  12_345 → '12.3k'
PASS  204_700 → '205k'
PASS  1_200_000 → '1.20M'
PASS  12_300_000 → '12.3M'

4 FAILURE(S) — team row model
exit=1
```

**4. Revert**
```
$ git checkout -- forge-control-web/app/desktop/team/teamRows.ts
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-team-rows.ts
── flattenTeam: ordering + depth ─────────────────────────────
PASS  row count = 1 manager + 2 workers + 2 sub-agents
PASS  order is manager, worker-a, its two sub-agents, worker-b
PASS  depths are 0,1,2,2,1
PASS  manager has no parent description
PASS  a worker's parentDescription is the manager's
PASS  a sub-agent's parentDescription is its worker's
PASS  displayWorkingMs is node.working_ms verbatim
PASS  manager's own sub-agents render at depth 1, before the workers
PASS  a chat with no project still renders its manager
PASS  …at depth 0

── flattenTeam: dismissal ────────────────────────────────────
PASS  dismissing a worker takes its sub-agents with it
PASS  dismissing one sub-agent leaves its sibling and its parent
PASS  dismissing the manager hides only the manager's subtree, not the workers
PASS  dismissing everything yields an empty array
PASS  an unknown dismissed id changes nothing

── flattenTeam: hiddenCount is ROWS, not ids (round 505 #3) ──
PASS  nothing dismissed → 0
PASS  dismissing a parent counts its whole subtree
PASS  …and it equals the rows actually withheld
PASS  ids matching nothing count 0
PASS  …and every row still renders
PASS  a leaf dismissal counts 1
PASS  nested dismissals do not double-count
PASS  …rows left = manager + worker-b
PASS  dismissing everything counts every node
PASS  …and renders nothing
PASS  junk beside a real dismissal does not inflate the count

── flattenTeam: hiddenRows, the peek list ───────────────────
PASS  nothing dismissed → no peek rows
PASS  a dismissed parent brings its whole subtree into the peek
PASS  …so the list matches the label exactly
PASS  …at the depths they had in the tree
PASS  …only the dismissed node itself is restorable
PASS  …and the peeked children carry their lineage
PASS  a dismissed leaf is one restorable peek row
PASS  …and it is restorable
PASS  …while its parent stays in the main list
PASS  a nested dismissal does not add a second peek entry
PASS  …and stays non-restorable while its parent is hidden
PASS  …count and list still agree
PASS  restoring the parent surfaces the child's own dismissal
PASS  …now restorable in its own right
PASS  …and it is the child
PASS  everything dismissed → every node is peekable
PASS  …in tree order
PASS  …three of them restorable
PASS  …and nothing left in the main list
PASS  ids matching nothing produce no peek rows
PASS  …and no phantom count
PASS  the cache holds only the rendered rows
PASS  …not the peeked ones
PASS  …and the peek list is still complete
PASS  (sanity: the full tree cached five)

── flattenTeam: wrapper identity (round 1302 L1) ─────────────
PASS  same response twice → same row count
PASS  same response twice → EVERY wrapper is the identical object
PASS  …and the nodes inside them are untouched too
PASS  one node changed → exactly one fresh wrapper
PASS  …and it is the node that changed
PASS  …every other wrapper survives by identity
PASS  the fresh wrapper carries the new node, not the stale one
PASS  a renamed parent refreshes itself AND its sub-agents' wrappers
PASS  no cache → no wrapper is shared
PASS  …but the content is identical
PASS  dismissal removes the subtree's rows
PASS  …and the survivors keep their identity across it
PASS  …the cache dropped the dismissed subtree
PASS  …and kept exactly the rendered rows
PASS  restore brings every row back
PASS  …the never-dismissed manager still keeps identity
PASS  …the restored rows are fresh wrappers
PASS  manager-only tree caches exactly one wrapper
PASS  everything dismissed → no rows
PASS  …hiddenCount still counts ROWS, not ids
PASS  …and the cache is empty, not stale

── interpolatedWorkingMs ─────────────────────────────────────
PASS  responseNowMs parses the response clock
PASS  settled row at t = the server's value
PASS  settled row at t+30s is IDENTICAL (U16 frozen truth)
PASS  …and identical to itself, not merely close
PASS  settled row six hours later is still identical
PASS  running row at t = the server's value
PASS  running row grows with the clock
PASS  running row grows to exactly the cap at +15s
PASS  running row CLAMPS past the cap (poll stalled, tab backgrounded)
PASS  a clock behind the response never subtracts
PASS  an unparsable response clock yields the base, not NaN
PASS  null on a settled row stays null at t
PASS  null on a settled row stays null at t+30s
PASS  null on a running row stays null at t
PASS  null on a running row stays null at t+30s — unknown never becomes 0
PASS  a measured 0 survives as 0, not null
PASS  …and renders as '0s', not '—'

── fmtWorkingTime ───────────────────────────────────────────
PASS  null → em dash, NEVER '0s'
PASS  negative → em dash
PASS  NaN → em dash
PASS  measured zero → '0s'
PASS  45s
PASS  59.9s floors to 59s
PASS  60s → '1m 00s'
PASS  12m 30s
PASS  1h 04m

── fmtTokens ────────────────────────────────────────────────
PASS  0 → '0'
PASS  negative → '0'
PASS  NaN → '0'
PASS  987 → '987'
PASS  987.4 rounds to '987'
PASS  999 → '999'
PASS  1000 → '1.0k'
PASS  9999 → '10.0k'
PASS  12_345 → '12.3k'
PASS  204_700 → '205k'
PASS  1_200_000 → '1.20M'
PASS  12_300_000 → '12.3M'

ALL PASS — team row model
exit=0
```

---

## 4. `check-dismiss-peek.tsx` → `forge-control-web/app/desktop/team/peek.ts`

**The behaviour broken:** the shared toggle label reverts to round 1350's
"N hidden · show" — the wording whose whole history is that it got a
fleet-wide restore clicked by someone who thought it revealed rows.

**1. Green, before anything is touched**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-dismiss-peek.tsx
── the row, normal ──────────────────────────────────────────
PASS  carries the ⏸
PASS  carries the ✕
PASS  carries NO restore control
PASS  is not marked peeked
PASS  its controls are hover-gated by CSS
PASS  the ✕ names the affordance that brings the row back

── the row, peeked and restorable ───────────────────────────
PASS  is marked peeked
PASS  …and faded by opacity, not by a colour
PASS  carries a restore control
PASS  …keyed by the node id the handler will be given
PASS  …with the shared title
PASS  …and it is a real button
PASS  carries NO ⏸ — a hidden row's only verb is the way back
PASS  carries NO ✕
PASS  its restore is NOT hover-gated — the list was summoned on purpose

── the row, hidden together with its parent ─────────────────
PASS  is marked peeked
PASS  carries NO restore control
PASS  …because restoring it alone would change nothing on screen
PASS  …and says so instead of offering a dead button
PASS  …as a span, not a disabled button
PASS  …wearing the shared mark
PASS  carries no ⏸ or ✕ either

── tokens only, all three states (NFU1: both themes) ────────
PASS  normal: no colour literal in the markup
PASS  peeked-restorable: no colour literal in the markup
PASS  peeked-with-parent: no colour literal in the markup

── the panel's footer: label ↔ verb ─────────────────────────
PASS  the footer renders a peek toggle
PASS  …and a separately-labelled restore-all
PASS  the peek toggle only toggles
PASS  …and cannot reach restoreAll — THE round-1354 regression
PASS  …and its label comes from ./peek
PASS  …which never says 'restore'
PASS  restore-all names itself
PASS  …goes through the confirm machine
PASS  …and is the only caller of restoreAll in the file
PASS  …it is rendered only while peeking
PASS  the label says the verb out loud
PASS  the armed label names the global count
PASS  …and says the count is not just this panel's
PASS  …and the tooltip warns it crosses panels
PASS  the peeked rows are rendered with their own restore
PASS  …and handleRestore is the per-id verb, not the global one
PASS  …under the shared heading

── both surfaces, one vocabulary ────────────────────────────
PASS  team panel imports the shared peek vocabulary
PASS  team panel renders no hand-written "N dismissed · " label
PASS  team panel uses dismissedToggleLabel
PASS  team panel renders the shared group heading
PASS  /live imports the shared peek vocabulary
PASS  /live renders no hand-written "N dismissed · " label
PASS  /live uses dismissedToggleLabel
PASS  /live renders the shared group heading
PASS  the toggle label reads the same on both
PASS  …and flips to hide when open
PASS  the group heading is one constant

── the tooltip names the OTHER panel ────────────────────────
PASS  /live: its toggle's title comes from dismissedToggleTitle()
PASS  /live: …passing the other surface
PASS  /live: …and never naming itself — THE round-1356 regression
PASS  /live: hand-writes no copy of the sentence
PASS  team panel: its toggle's title comes from dismissedToggleTitle()
PASS  team panel: …passing the other surface
PASS  team panel: …and never naming itself — THE round-1356 regression
PASS  team panel: hand-writes no copy of the sentence
PASS  the sentence still says dismissing never deletes
PASS  …and the two readings differ
PASS  the /live reading names the chat team panel
PASS  the team panel's reading names the Live panel

ALL PASS — dismissal peek affordance
exit=0
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control-web/app/desktop/team/peek.ts b/forge-control-web/app/desktop/team/peek.ts
index ad53ca5..1812769 100644
--- a/forge-control-web/app/desktop/team/peek.ts
+++ b/forge-control-web/app/desktop/team/peek.ts
@@ -35,7 +35,7 @@ export const DISMISSED_GROUP_LABEL = "DISMISSED";
  *  The verb is "show"/"hide", never "restore": this control reveals, it never
  *  writes. That distinction is the whole of round 1354's A4 finding. */
 export function dismissedToggleLabel(hiddenRowCount: number, peeking: boolean): string {
-  return `${hiddenRowCount} dismissed · ${peeking ? "hide" : "show"}`;
+  return `${hiddenRowCount} hidden · ${peeking ? "hide" : "show"}`;
 }
 
 /** The two surfaces that share the dismissal store, named the way a reader
```

**3. The instrument, against the broken subject**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-dismiss-peek.tsx
── the row, normal ──────────────────────────────────────────
PASS  carries the ⏸
PASS  carries the ✕
PASS  carries NO restore control
PASS  is not marked peeked
PASS  its controls are hover-gated by CSS
PASS  the ✕ names the affordance that brings the row back

── the row, peeked and restorable ───────────────────────────
PASS  is marked peeked
PASS  …and faded by opacity, not by a colour
PASS  carries a restore control
PASS  …keyed by the node id the handler will be given
PASS  …with the shared title
PASS  …and it is a real button
PASS  carries NO ⏸ — a hidden row's only verb is the way back
PASS  carries NO ✕
PASS  its restore is NOT hover-gated — the list was summoned on purpose

── the row, hidden together with its parent ─────────────────
PASS  is marked peeked
PASS  carries NO restore control
PASS  …because restoring it alone would change nothing on screen
PASS  …and says so instead of offering a dead button
PASS  …as a span, not a disabled button
PASS  …wearing the shared mark
PASS  carries no ⏸ or ✕ either

── tokens only, all three states (NFU1: both themes) ────────
PASS  normal: no colour literal in the markup
PASS  peeked-restorable: no colour literal in the markup
PASS  peeked-with-parent: no colour literal in the markup

── the panel's footer: label ↔ verb ─────────────────────────
PASS  the footer renders a peek toggle
PASS  …and a separately-labelled restore-all
PASS  the peek toggle only toggles
PASS  …and cannot reach restoreAll — THE round-1354 regression
PASS  …and its label comes from ./peek
PASS  …which never says 'restore'
PASS  restore-all names itself
PASS  …goes through the confirm machine
PASS  …and is the only caller of restoreAll in the file
PASS  …it is rendered only while peeking
PASS  the label says the verb out loud
PASS  the armed label names the global count
PASS  …and says the count is not just this panel's
PASS  …and the tooltip warns it crosses panels
PASS  the peeked rows are rendered with their own restore
PASS  …and handleRestore is the per-id verb, not the global one
PASS  …under the shared heading

── both surfaces, one vocabulary ────────────────────────────
PASS  team panel imports the shared peek vocabulary
PASS  team panel renders no hand-written "N dismissed · " label
PASS  team panel uses dismissedToggleLabel
PASS  team panel renders the shared group heading
PASS  /live imports the shared peek vocabulary
PASS  /live renders no hand-written "N dismissed · " label
PASS  /live uses dismissedToggleLabel
PASS  /live renders the shared group heading
FAIL  the toggle label reads the same on both
        expected "4 dismissed · show"
        actual   "4 hidden · show"
FAIL  …and flips to hide when open
        expected "4 dismissed · hide"
        actual   "4 hidden · hide"
PASS  the group heading is one constant

── the tooltip names the OTHER panel ────────────────────────
PASS  /live: its toggle's title comes from dismissedToggleTitle()
PASS  /live: …passing the other surface
PASS  /live: …and never naming itself — THE round-1356 regression
PASS  /live: hand-writes no copy of the sentence
PASS  team panel: its toggle's title comes from dismissedToggleTitle()
PASS  team panel: …passing the other surface
PASS  team panel: …and never naming itself — THE round-1356 regression
PASS  team panel: hand-writes no copy of the sentence
PASS  the sentence still says dismissing never deletes
PASS  …and the two readings differ
PASS  the /live reading names the chat team panel
PASS  the team panel's reading names the Live panel

2 FAILURE(S) — dismissal peek affordance
exit=1
```

**4. Revert**
```
$ git checkout -- forge-control-web/app/desktop/team/peek.ts
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-dismiss-peek.tsx
── the row, normal ──────────────────────────────────────────
PASS  carries the ⏸
PASS  carries the ✕
PASS  carries NO restore control
PASS  is not marked peeked
PASS  its controls are hover-gated by CSS
PASS  the ✕ names the affordance that brings the row back

── the row, peeked and restorable ───────────────────────────
PASS  is marked peeked
PASS  …and faded by opacity, not by a colour
PASS  carries a restore control
PASS  …keyed by the node id the handler will be given
PASS  …with the shared title
PASS  …and it is a real button
PASS  carries NO ⏸ — a hidden row's only verb is the way back
PASS  carries NO ✕
PASS  its restore is NOT hover-gated — the list was summoned on purpose

── the row, hidden together with its parent ─────────────────
PASS  is marked peeked
PASS  carries NO restore control
PASS  …because restoring it alone would change nothing on screen
PASS  …and says so instead of offering a dead button
PASS  …as a span, not a disabled button
PASS  …wearing the shared mark
PASS  carries no ⏸ or ✕ either

── tokens only, all three states (NFU1: both themes) ────────
PASS  normal: no colour literal in the markup
PASS  peeked-restorable: no colour literal in the markup
PASS  peeked-with-parent: no colour literal in the markup

── the panel's footer: label ↔ verb ─────────────────────────
PASS  the footer renders a peek toggle
PASS  …and a separately-labelled restore-all
PASS  the peek toggle only toggles
PASS  …and cannot reach restoreAll — THE round-1354 regression
PASS  …and its label comes from ./peek
PASS  …which never says 'restore'
PASS  restore-all names itself
PASS  …goes through the confirm machine
PASS  …and is the only caller of restoreAll in the file
PASS  …it is rendered only while peeking
PASS  the label says the verb out loud
PASS  the armed label names the global count
PASS  …and says the count is not just this panel's
PASS  …and the tooltip warns it crosses panels
PASS  the peeked rows are rendered with their own restore
PASS  …and handleRestore is the per-id verb, not the global one
PASS  …under the shared heading

── both surfaces, one vocabulary ────────────────────────────
PASS  team panel imports the shared peek vocabulary
PASS  team panel renders no hand-written "N dismissed · " label
PASS  team panel uses dismissedToggleLabel
PASS  team panel renders the shared group heading
PASS  /live imports the shared peek vocabulary
PASS  /live renders no hand-written "N dismissed · " label
PASS  /live uses dismissedToggleLabel
PASS  /live renders the shared group heading
PASS  the toggle label reads the same on both
PASS  …and flips to hide when open
PASS  the group heading is one constant

── the tooltip names the OTHER panel ────────────────────────
PASS  /live: its toggle's title comes from dismissedToggleTitle()
PASS  /live: …passing the other surface
PASS  /live: …and never naming itself — THE round-1356 regression
PASS  /live: hand-writes no copy of the sentence
PASS  team panel: its toggle's title comes from dismissedToggleTitle()
PASS  team panel: …passing the other surface
PASS  team panel: …and never naming itself — THE round-1356 regression
PASS  team panel: hand-writes no copy of the sentence
PASS  the sentence still says dismissing never deletes
PASS  …and the two readings differ
PASS  the /live reading names the chat team panel
PASS  the team panel's reading names the Live panel

ALL PASS — dismissal peek affordance
exit=0
```

---

## 5. `check-stop-affordance.tsx` → `forge-control-web/app/desktop/team/TeamRow.tsx`

**The behaviour broken:** the ⏸ stops being disabled — production's exact
state after 8ec83cc, a completed row wearing an enabled stop button that
fires `decideStopClick` → `{blocked, "settled"}` → nothing. The silent
no-op NFU6 forbids.

**1. Green, before anything is touched**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx
── the ⏸ button, as it actually renders ─────────────────────
PASS  canStop=true settled=false → disabled
PASS  canStop=true settled=false → title
PASS  canStop=true settled=false → cursor
PASS  canStop=true settled=false → data-stop-blocked
PASS  canStop=true settled=false → the click decision agrees with the affordance
PASS  canStop=true settled=true → disabled
PASS  canStop=true settled=true → title
PASS  canStop=true settled=true → cursor
PASS  canStop=true settled=true → data-stop-blocked
PASS  canStop=true settled=true → the click decision agrees with the affordance
PASS  canStop=false settled=false → disabled
PASS  canStop=false settled=false → title
PASS  canStop=false settled=false → cursor
PASS  canStop=false settled=false → data-stop-blocked
PASS  canStop=false settled=false → the click decision agrees with the affordance
PASS  canStop=false settled=true → disabled
PASS  canStop=false settled=true → title
PASS  canStop=false settled=true → cursor
PASS  canStop=false settled=true → data-stop-blocked
PASS  canStop=false settled=true → the click decision agrees with the affordance

── the regression, stated on its own ────────────────────────
PASS  a COMPLETED row with stop:true renders a DISABLED ⏸
PASS  …and says why, without blaming the engine

── tokens only (NFU1: both themes) ──────────────────────────
PASS  no colour literal in the rendered row

ALL PASS — stop affordance
exit=0
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control-web/app/desktop/team/TeamRow.tsx b/forge-control-web/app/desktop/team/TeamRow.tsx
index 9b367ae..7b8b0f1 100644
--- a/forge-control-web/app/desktop/team/TeamRow.tsx
+++ b/forge-control-web/app/desktop/team/TeamRow.tsx
@@ -680,7 +680,7 @@ function TeamRowViewImpl({
             data-team-stop
             type="button"
             data-stop-blocked={stopBlock ?? "none"}
-            disabled={stopBlock !== null}
+            disabled={false}
             title={
               stopBlock === null
                 ? "Stop this agent"
```

**3. The instrument, against the broken subject**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx
── the ⏸ button, as it actually renders ─────────────────────
PASS  canStop=true settled=false → disabled
PASS  canStop=true settled=false → title
PASS  canStop=true settled=false → cursor
PASS  canStop=true settled=false → data-stop-blocked
PASS  canStop=true settled=false → the click decision agrees with the affordance
FAIL  canStop=true settled=true → disabled
        expected true
        actual   false
PASS  canStop=true settled=true → title
PASS  canStop=true settled=true → cursor
PASS  canStop=true settled=true → data-stop-blocked
PASS  canStop=true settled=true → the click decision agrees with the affordance
FAIL  canStop=false settled=false → disabled
        expected true
        actual   false
PASS  canStop=false settled=false → title
PASS  canStop=false settled=false → cursor
PASS  canStop=false settled=false → data-stop-blocked
PASS  canStop=false settled=false → the click decision agrees with the affordance
FAIL  canStop=false settled=true → disabled
        expected true
        actual   false
PASS  canStop=false settled=true → title
PASS  canStop=false settled=true → cursor
PASS  canStop=false settled=true → data-stop-blocked
PASS  canStop=false settled=true → the click decision agrees with the affordance

── the regression, stated on its own ────────────────────────
FAIL  a COMPLETED row with stop:true renders a DISABLED ⏸
        expected true
        actual   false
PASS  …and says why, without blaming the engine

── tokens only (NFU1: both themes) ──────────────────────────
PASS  no colour literal in the rendered row

4 FAILURE(S) — stop affordance
exit=1
```

**4. Revert**
```
$ git checkout -- forge-control-web/app/desktop/team/TeamRow.tsx
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx
── the ⏸ button, as it actually renders ─────────────────────
PASS  canStop=true settled=false → disabled
PASS  canStop=true settled=false → title
PASS  canStop=true settled=false → cursor
PASS  canStop=true settled=false → data-stop-blocked
PASS  canStop=true settled=false → the click decision agrees with the affordance
PASS  canStop=true settled=true → disabled
PASS  canStop=true settled=true → title
PASS  canStop=true settled=true → cursor
PASS  canStop=true settled=true → data-stop-blocked
PASS  canStop=true settled=true → the click decision agrees with the affordance
PASS  canStop=false settled=false → disabled
PASS  canStop=false settled=false → title
PASS  canStop=false settled=false → cursor
PASS  canStop=false settled=false → data-stop-blocked
PASS  canStop=false settled=false → the click decision agrees with the affordance
PASS  canStop=false settled=true → disabled
PASS  canStop=false settled=true → title
PASS  canStop=false settled=true → cursor
PASS  canStop=false settled=true → data-stop-blocked
PASS  canStop=false settled=true → the click decision agrees with the affordance

── the regression, stated on its own ────────────────────────
PASS  a COMPLETED row with stop:true renders a DISABLED ⏸
PASS  …and says why, without blaming the engine

── tokens only (NFU1: both themes) ──────────────────────────
PASS  no colour literal in the rendered row

ALL PASS — stop affordance
exit=0
```

---

## 6. `serve-sse-808.ts` → `forge-control/src/routes/chat.ts`

A server, so "the instrument fails" means the endpoint stops answering as
it did in step 1. The transcript is the curl, not a claim.

**The behaviour broken:** the SSE route this harness mounts at
`/api/chat/:id/events` inverts its liveness guard, so every `send` refuses
and the loop breaks on the opening frame. The stream still opens — 200,
`text/event-stream` — and then says nothing, which is precisely the
pathology (`serve-v3-7798.ts` buffering a stream into silence) that this
harness exists to avoid.

**1. Green, before anything is touched** — binds, and the mounted SSE route speaks
```
$ cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ export SECRET_STORE_DIR=/tmp/p808-store
$ SERVE_SSE_PORT=7845 ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts &
[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
[serve-sse-808] SECRET_STORE_DIR=/tmp/p808-store

$ timeout 6 curl -sS -N -D /tmp/sse-h.txt -o /tmp/sse-b.txt http://127.0.0.1:7845/api/chat/53651819-5c6e-4a57-bd80-ab79ea637f7f/events
curl_exit=124   (124 = the 6s timeout killed a stream that was STILL OPEN; 0 = the server closed it itself)
--- response headers ---
HTTP/1.1 200 OK
cache-control: no-cache
connection: keep-alive
content-type: text/event-stream
transfer-encoding: chunked
Date: Tue, 18 Aug 2026 12:31:54 GMT

--- body, first 300 bytes of 232669 received in 6s ---
event: snapshot
data: {"run":{"id":"53651819-5c6e-4a57-bd80-ab79ea637f7f","title":"scripts-checks-typecheck-gate · Phase 3 — fix the six red instruments at the source (families A, B, C) and transcribe the six R29 breakage controls","prompt":"You are the builder for Konrad's Personal AI OS. You wr
$ kill $SERVER; ss -ltn | grep 7845
(no listener — port released)
```

**2. The mutation**, on the SUBJECT — not on the instrument:
```diff
diff --git a/forge-control/src/routes/chat.ts b/forge-control/src/routes/chat.ts
index a90dd9f..59a272d 100644
--- a/forge-control/src/routes/chat.ts
+++ b/forge-control/src/routes/chat.ts
@@ -1468,7 +1468,7 @@ r.get("/:id/events", (c) => {
      *  request down. Closing is a normal, expected end to an SSE connection,
      *  not an error: treat a failed write as "client left" and stop cleanly. */
     const send = async (event: string, data: string): Promise<boolean> => {
-      if (!alive) return false;
+      if (alive) return false;
       try {
         await stream.writeSSE({ event, data });
         return true;
```

**3. The harness, against the broken route** — it still binds; the endpoint no longer answers
```
$ cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ export SECRET_STORE_DIR=/tmp/p808-store
$ SERVE_SSE_PORT=7845 ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts &
[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
[serve-sse-808] SECRET_STORE_DIR=/tmp/p808-store

$ timeout 6 curl -sS -N -D /tmp/sse-h.txt -o /tmp/sse-b.txt http://127.0.0.1:7845/api/chat/53651819-5c6e-4a57-bd80-ab79ea637f7f/events
curl_exit=0   (124 = the 6s timeout killed a stream that was STILL OPEN; 0 = the server closed it itself)
--- response headers ---
HTTP/1.1 200 OK
cache-control: no-cache
connection: keep-alive
content-type: text/event-stream
transfer-encoding: chunked
Date: Tue, 18 Aug 2026 12:32:03 GMT

--- body, first 300 bytes of 0 received in 6s ---

$ kill $SERVER; ss -ltn | grep 7845
(no listener — port released)
```

**4. Revert**
```
$ git checkout -- forge-control/src/routes/chat.ts
$ git status --porcelain
(empty above = the tree is exactly as committed)
```

**5. Green again**
```
$ cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ export SECRET_STORE_DIR=/tmp/p808-store
$ SERVE_SSE_PORT=7845 ./node_modules/.bin/tsx ../scripts/checks/serve-sse-808.ts &
[serve-sse-808] :7845 — worktree routers + streaming proxy to http://127.0.0.1:7700
[serve-sse-808] SECRET_STORE_DIR=/tmp/p808-store

$ timeout 6 curl -sS -N -D /tmp/sse-h.txt -o /tmp/sse-b.txt http://127.0.0.1:7845/api/chat/53651819-5c6e-4a57-bd80-ab79ea637f7f/events
curl_exit=124   (124 = the 6s timeout killed a stream that was STILL OPEN; 0 = the server closed it itself)
--- response headers ---
HTTP/1.1 200 OK
cache-control: no-cache
connection: keep-alive
content-type: text/event-stream
transfer-encoding: chunked
Date: Tue, 18 Aug 2026 12:32:06 GMT

--- body, first 300 bytes of 232669 received in 6s ---
event: snapshot
data: {"run":{"id":"53651819-5c6e-4a57-bd80-ab79ea637f7f","title":"scripts-checks-typecheck-gate · Phase 3 — fix the six red instruments at the source (families A, B, C) and transcribe the six R29 breakage controls","prompt":"You are the builder for Konrad's Personal AI OS. You wr
$ kill $SERVER; ss -ltn | grep 7845
(no listener — port released)
```

---

## Confinement (R30) after all six controls
```
$ git status --porcelain
(empty)

$ git diff --name-only main...HEAD
docs/plan/scripts-checks-typecheck-gate/00-vision.md
docs/plan/scripts-checks-typecheck-gate/01-requirements.md
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/03-quality.md
docs/plan/scripts-checks-typecheck-gate/04-phases.md
docs/plan/scripts-checks-typecheck-gate/evidence/census-A-current-gate-options.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-B-root-paths-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-C-root-paths-plus-react-types.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-E-web-extends-profile.txt
docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1-round3.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle1.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-fixcycle2.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-gate.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-redteam.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase2-review.md
docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
docs/plan/scripts-checks-typecheck-gate/evidence/residual-errors-profile-G.txt
docs/plan/scripts-checks-typecheck-gate/evidence/round0-probes.md
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-orientation.ts
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
scripts/checks/serve-sse-808.ts
tsconfig.checks-instruments.json
tsconfig.checks.json
```

Nothing under `forge-control-web/app/` or `forge-control/src/`; the six
mutations above exist only in this transcript.

Produced at `5823302a8d9d78a59a99be0f6241d779e691e56f`.

---

## Addendum (round 6, fix cycle 3) — the `hidesRows` coverage claim in `6bdd24a`, corrected

**This section amends a commit message it cannot rewrite.** `6bdd24a`
(*"fix(scripts-checks-typecheck-gate/phase 3, family A): the fixture drift
against TeamRow, XClickInput and WorkingMsSource"*) contains this paragraph:

> `check-dismiss-peek.tsx:115` and `check-stop-affordance.tsx:111` — the local
> `row()` helpers omitted `hidesRows`. Value chosen: 1 in both, **and here it IS
> behavioural.** … In check-dismiss-peek the settled, non-operator row at 1 wears
> the one-click undoable ✕ (`data-x-confirms=false`) that "the ✕ names the
> affordance that brings the row back" is asserted against. In
> check-stop-affordance the CASES table walks settled and running; at 1 the
> settled ✕ is the one-click dismissal and the running ✕ is the
> capability-gated terminate.

**The value 1 is correct. "Here it IS behavioural" is not.** Phase 3's gate
(`evidence/phase3-gate.md`, finding 1, upheld as a blocker) and phase 3's red
team (`evidence/phase3-redteam.md`) each found it independently; round 6
re-measured it from scratch rather than reading either, and the transcript below
is round 6's own.

**What is true instead.** `hidesRows` is **inert in both `.tsx` files**. Neither
one's assertions can observe the one-click/two-click boundary at all, so no value
of this field can move them:

- `check-dismiss-peek.tsx` — the only assertion that could see the boundary
  matches `.includes("dismissed · show")`. `dismissTitle`
  (`team/confirm.ts:244-263`) builds that phrase once, as the local `undo`, and
  appends it to **all three** of its return branches. A substring shared by every
  branch is true at every value. (Round 6's own note on the shape: an assertion
  over a clause common to every branch passes at every fixture value, which is
  why the flip must be measured in both directions rather than reasoned about.)
- `check-stop-affordance.tsx` — the file never reads `data-team-x`,
  `data-x-confirms` or `data-x-hides` in any assertion. Before this round the
  single occurrence of `data-x-confirms` in the file was **inside the comment
  making the claim**; it is still the only occurrence, and it is still a comment.

**What this does and does not change.** No coverage was lost and none is being
restored: `hidesRows` was *absent* from both fixtures on `main` — that absence is
the type error phase 3 repaired — so there was never a prior assertion to delete.
The inertness and the shared-substring weakness are pre-existing limits this
project exposed, not defects it introduced. What phase 3 *did* introduce is the
false coverage claim, in the commit message above and in the two comment blocks;
the comments are corrected in round 6's fix-cycle commit and this section
corrects the message. The behaviour itself is guarded elsewhere and always was —
`check-team-confirm.ts:378-396` (3 failures) and `check-r1873-fixes.ts:168/189`
(2) both go red on the real mutation, as part C shows. **A defect in the record,
not a hole in the coverage.**

**The wording to model, twenty lines away in a sibling file**, is
`check-team-confirm.ts:213-220`, which measured the same inertness on the same
field, stated it, and gave the mechanism. Both corrected comments now follow it.

### Transcript

Four parts. (A) flips the fixture across the boundary in both files. (B) is the
positive control that the flip method detects a real dependency where one exists.
(C) mutates the **subject** and shows which instruments notice. (D) reads the
mechanism out of the source. Every mutation is reverted in the same block and the
tree is shown clean afterwards.

```
$ git rev-parse --short HEAD ; node -v ; forge-control/node_modules/.bin/tsc -v
e86f4b9
v22.22.2
Version 5.9.3

=== A. FLIP hidesRows ACROSS THE needsConfirm BOUNDARY (team/confirm.ts:173, `> 1`) ===
hidesRows=0    check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
hidesRows=1    check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
hidesRows=2    check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
hidesRows=5    check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
hidesRows=165  check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
hidesRows=0    check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
hidesRows=1    check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
hidesRows=2    check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
hidesRows=5    check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
hidesRows=165  check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0

=== B. POSITIVE CONTROL — the same fixture flip where the value IS load-bearing ===
$ sed -n '87p' scripts/checks/check-team-confirm.ts
const TODAY = { canTerminate: false, hidesRows: 2 } as const;
TODAY hidesRows=2  check-team-confirm.ts          2 FAILURE(S) — team confirm machine      exit=1

=== C. MUTATE THE SUBJECT — every settled leaf ✕ now demands a two-click confirm ===
$ git diff --unified=0 -- forge-control-web/app/desktop/team/confirm.ts | tail -3
@@ -173 +173 @@ export function needsConfirm(i: DismissScope): boolean {
-  return i.hidesRows > 1; // a cascade of hides
+  return i.hidesRows >= 1; // a cascade of hides

check-dismiss-peek.tsx         ALL PASS — dismissal peek affordance     exit=0
check-stop-affordance.tsx      ALL PASS — stop affordance               exit=0
check-team-confirm.ts          3 FAILURE(S) — team confirm machine      exit=1
check-team-rows.ts             ALL PASS — team row model                exit=0
check-r1873-fixes.ts           2 FAILURE(S) — round 1873 fixes          exit=1
check-orientation.ts           ALL PASS — orientation strip derivation  exit=0

$ the failing assertions, by name
FAIL  X on a settled row dismisses immediately
FAIL  …even while another row is armed
FAIL  …and capabilities are irrelevant to it (nothing leaves the browser)
FAIL  a settled leaf: one click
FAIL  first click on a settled LEAF dismisses

$ git status --porcelain -- forge-control-web scripts/checks
 M scripts/checks/check-dismiss-peek.tsx
 M scripts/checks/check-stop-affordance.tsx

=== D. THE ROOT CAUSE, READ NOT GUESSED ===
$ grep -n 'dismissed · show' scripts/checks/check-dismiss-peek.tsx
134:   * `.includes("dismissed · show")` — and `dismissTitle`
205:    (attr(tag(html, "data-team-x") ?? "", "title") ?? "").includes("dismissed · show"),
356:  check("the toggle label reads the same on both", dismissedToggleLabel(4, false), "4 dismissed · show");
$ sed -n '244,263p' forge-control-web/app/desktop/team/confirm.ts
export function dismissTitle(i: DismissScope): string {
  const undo =
    "Reversible: the toast offers an undo of exactly this gesture, and every " +
    "hidden row stays listed under “N dismissed · show”.";
  if (i.widerReach === true) {
    return (
      `Hide this row, everything settled under it, and — if this chat started a ` +
      `project — that project's finished workers, which this panel cannot count ` +
      `in advance. Click twice to confirm. ${undo}`
    );
  }
  if (i.hidesRows > 1) {
    return (
      `Hide this row and the ${i.hidesRows - 1} settled row${i.hidesRows === 2 ? "" : "s"} ` +
      `under it — ${i.hidesRows} in total. Click twice to confirm. ${undo} The server ` +
      `may also hide finished runs of the same project that this tree is not listing.`
    );
  }
  return `Hide this row. Nothing else goes with it. ${undo}`;
}

$ grep -n 'data-team-x\|data-x-confirms\|data-x-hides' scripts/checks/check-stop-affordance.tsx
126:   * file for `data-team-x`, `data-x-confirms` or `data-x-hides` and the only
```

The `M` lines under part C are round 6's own corrected comments, which were
already in the tree when the transcript was taken; `forge-control-web/` is clean,
so the `confirm.ts` mutation exists only in this transcript. Same confinement
property as the six controls above.

Produced at `e86f4b9` — `node v22.22.2`, `tsc 5.9.3`.
