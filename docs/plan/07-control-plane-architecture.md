# 07 — Manager Control Plane: architecture

Companion to 06-control-plane-requirements.md. Everything here was designed against the code as it
exists on this branch — file:line references are to this worktree at round 800.

## 1. The machine we are extending (facts, not design)

- A run is a `runs` row; its conversation is `runs.thread` (jsonb array of
  `{role, content, ts, kind?, meta?}`). One CC child process per TURN, spawned by
  `executor.ts` → `processWithClaudeCode()` → `cc-runner.ts` `runClaudeCode()`. The child's stdin is
  written once and closed at spawn (`cc-runner.ts:374-375`) — there is no channel into a turn in
  flight. Follow-up turns pass `--resume <cc_session_id>` (`cc-runner.ts:342`); the session id is
  persisted in `runs.metadata.cc_session_id` (`executor.ts:410`).
- The prompt for a resumed turn is `trailingUserBlock(thread)` (`executor.ts:189-208`): every entry
  AFTER the last `assistant`/`tool` entry, `system` entries prefixed `[SYSTEM]`. So anything appended
  to the thread while a run is between turns is delivered verbatim on the next turn — this is the
  delivery mechanism `POST /api/chat/:id/message` already relies on.
- Every live turn polls `runs.status` every 5s (`cc-runner.ts:411-415`, `executor.ts:855-858`) and
  SIGTERMs the child when it reads `cancelled` or `paused`. The catch branch (`executor.ts:591-601`)
  then appends "Run stopped — engine process terminated." and leaves the operator-chosen status
  untouched. Stop/terminate therefore need NO new kill machinery.
- Resume-miss recovery exists: `CcResumeError` → retry once with the full transcript + a loud
  in-thread marker (`executor.ts:899-918`). Account failover re-sends the transcript too (a session
  lives inside one account's config dir, `executor.ts:962-967`).
- One executor process; concurrency via an in-flight map bounded by `agent.spawn_cap`
  (`executor.ts:1073-1090`); a procfs guard refuses a second engine process on the same session
  (`executor.ts:450-471, 752-782`).
- Claiming is atomic (`claimNextRun`, `executor.ts:129-156`): `status='queued'` AND
  `wake_after` passed, `FOR UPDATE SKIP LOCKED`.
- Sub-agents of a run are recorded by the rollup as `metadata.subagents_v2` — an array keyed by the
  spawning Task tool_use_id (`run-rollup.ts:184, 323`). That id is the only stable address a
  sub-agent has.
- Project tasks link to runs via `project_tasks.run_id` + `runs.metadata.task_id`; reconciliation
  reads ONLY tasks in `status='running'` whose run has settled (`listSettledRunningTasks`), so a
  task that is already `done` is invisible to the reconciler no matter what its run does later.

## 2. Component layout — what owns state, what dispatches, what can fail

| concern | owner | notes |
|---|---|---|
| All control-plane state | the `runs` row (status, thread, metadata, completed_at) | C23: no side tables, no memory |
| HTTP surface | `forge-control/src/routes/run-control.ts` (NEW — the only new file) | boundary D1; mounted per D2 (two appended lines in `index.ts`) |
| Status/thread primitives | `forge-control/src/db/runs.ts` (ours) | new helpers: `appendComms`, `stopRun`, `terminateRun`, `resumeChat`, `listComms` |
| Pure decision rules | `forge-control/src/lib/run-control-rules.ts` (NEW) | eligibility matrices + completion transition + `projectSlug` — pure, unit-tested, imported by BOTH route and executor so the two can never drift |
| Delivery into live turns | `forge-control/src/executor.ts` | the pending-input handshake (§5) + the completion guard (§6) |
| Worker/manager prompt wiring | `forge-control/src/lib/project-tick.ts` | MANAGER COMMS block; slug corpus paths |
| Operator linkage sentence | `forge-control/src/lib/cc-runner.ts` | boundary D5's one sentence |
| Announcement | the contract vault note's table | boundary D3 protocol, append-only |

Dispatch is unchanged: forge-control (API process) writes rows; forge-executor claims and runs them.
The two processes still communicate exclusively through Postgres, which is why every verb below is
expressible as row writes and why `pm2 restart forge-control` alone ships the whole route surface.

## 3. Data model: the `comms` thread entry

One new `kind` value on the existing ThreadEntry shape — no schema change:

```jsonc
// receiver side (target thread) — role "user" so prompt builders deliver it
{ "role": "user",
  "content": "[message from manager 3fa9c2d1] Ship the failing test first, then the fix.",
  "ts": "...", "kind": "comms",
  "meta": { "comms": { "direction": "in", "from": "manager", "peer_run_id": "<sender uuid>" } } }

// sender side (echo) — role "agent" so it renders as traffic, requeues nothing
{ "role": "agent",
  "content": "[to worker 9b1e44a0] Ship the failing test first, then the fix.",
  "ts": "...", "kind": "comms",
  "meta": { "comms": { "direction": "out", "from": "manager", "peer_run_id": "<target uuid>" } } }
```

Design points, each load-bearing:
- **Receiver entries are `role:"user"`** so both prompt builders (`trailingUserBlock` for resumed
  sessions, `buildPromptFromThread` for fresh ones) deliver them with zero changes. The in-band
  `[message from …]` prefix survives even a full-transcript rebuild, so attribution can never be
  lost to a resume-miss.
- **Echo entries are `role:"agent"`** — a role the DB type already allows (`db/runs.ts:40`) and
  neither prompt builder treats as engine output, so an echo in a manager's thread tail is carried
  into the manager's next prompt as context (harmless, and actually useful: the manager sees what it
  sent) but can never terminate the tail-scan the way an `assistant`/`tool` entry would.
- **`kind:"comms"` is the query key** for C14's `GET /comms` — a jsonb filter on the existing column.
- The `ThreadEntry` kind union in `db/runs.ts:43` gains `"comms"`; `executor.ts`'s local copy of the
  interface (`executor.ts:114-120`) is untyped on kind (`kind?: string`) and needs nothing.

## 4. The six endpoints (all in run-control.ts)

| endpoint | eligibility (run status) | effect | contract |
|---|---|---|---|
| `POST /:id/message` | queued, running, paused, stuck, completed | append comms entry (+echo); queued→append only; running→append + `pending_input`; paused/stuck/completed→append + status `queued` | §1; 409 for failed/cancelled with reason naming `/resume-chat` |
| `POST /:id/resume-chat` | completed, failed, cancelled, stuck, paused | workspace pre-flight (C7); append comms entry (+echo); status `queued`; respond `{resumed_run_id: id}` | §2; in-place, stable id |
| `POST /:parentId/subagent-message` | parent per `/message` rules | validate `subagent_id` ∈ `metadata.subagents_v2[*].id` else 409 "subagent context not addressable"; append relay-prefixed comms entry to parent | §2b |
| `POST /:id/stop` | queued, running, stuck | status → `paused`; kill-poll reaps a live child ≤5s | §3; stopped state = `paused` |
| `POST /:id/terminate` | queued, running, paused, stuck | status → `cancelled` AND `completed_at = now()` in one UPDATE | §4 incl. the completed_at consistency fix |
| `GET /:id/comms` | any | thread entries where `kind='comms'`, oldest first | our C14 extension |

Shared handler skeleton: UUID-validate → `getRun` → pure eligibility function from
`run-control-rules.ts` → single-row UPDATE(s) → 202/4xx. Every 409 body is
`{error: "<human reason>"}` rendered verbatim by the UI (contract ground rule).

Status writes race-harden by carrying their precondition into SQL — e.g. terminate is
`UPDATE runs SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1 AND status = ANY($2)`
with rowcount 0 → re-read → 409/404. Two operators clicking stop+terminate together resolve to
whichever UPDATE lands second finding the precondition gone — one 202, one 409, never a mixed state.

## 5. The delivery handshake (message → running run)

The only genuinely new mechanism in the whole plan. Everything rides `runs.metadata.pending_input`
(boolean) + the guarded completion write. Both sides close the race:

```
route side (target running):           executor side (turn just ended OK):
  T1 append comms entry                  E1 UPDATE runs SET status='completed', ...
  T2 UPDATE metadata.pending_input=true       WHERE id=$1 AND status='running'
     (single stmt with T1)                    RETURNING metadata->>'pending_input'
                                         E2 if RETURNING = 'true':
                                              UPDATE SET status='queued',
                                                metadata - 'pending_input'
                                              WHERE id=$1 AND status='completed'
```

- Append lands **before** E1 → E1's RETURNING sees the flag → E2 requeues → next turn's
  `trailingUserBlock` contains the message. Delivered.
- Append lands **after** E1 → the run is now `completed`, and `/message`'s own eligibility for
  `completed` is append + requeue (C4) → the route requeues it itself. Delivered.
- Both sides act → E2's `WHERE status='completed'` and the route's status write are idempotent
  towards `queued`; the claim loop clears `pending_input` on claim (belt) and E2 removed it (braces).
  One extra turn at absolute worst, never a lost message.
- The route loses the write race itself (the row moved between `getRun` and the UPDATE, so the
  precondition matched 0 rows) → **one bounded re-dispatch**: recompute `messageAction` against the
  status the failed UPDATE reported and attempt exactly once more. Safe because rowcount 0 means
  nothing was appended, so the retry is a first delivery against a freshly-read status. A second
  loss is an honest 409 and the caller owns the next move. This is asymmetric on purpose: `/stop`
  and `/terminate` never re-dispatch — a message means the same thing in every state that accepts
  it, whereas a verb applied to a state nobody looked at is a different decision. (Added R906: the
  original 409-only handler made this bullet's delivery promise depend on a caller retry the plan
  never required of managers.)
- Executor restarts between T2 and the next claim → the flag and the entry are in the row; nothing
  was in memory (C23). The requeue happens via the route's completed-path or the flag consumption on
  whatever completion eventually lands.
- Executor restarts **between E1 and E2** → the row is `completed` + `pending_input=true` and E2
  died with the process. The flag has exactly two consumers (`claimNextRun`, which only touches
  `queued` rows, and E2 itself) so nothing would ever pick it up, while the caller already holds a
  202 saying `delivery: next-turn`. Closed R906 by `pendingInputSweepTick()` on the manager loop:
  E2's UPDATE replayed from durable state, scoped to `status='completed' AND
  metadata->>'pending_input'='true'` and rows untouched for 60s so it cannot race a live E2.
  `failed`/`stuck` keep their flag — see the last bullet.
- Turn ends `failed`/`stuck` instead → no E2 by design (§4 table sends casual traffic to live-ish
  runs only); the message sits in the thread, the run's failure notification fires normally, and a
  `resume-chat`/existing resume delivers it. A message must never convert a failure into a silent
  retry loop.

The decision logic (`completionTransition({outcome, rowStatus, pendingInput}) → {status, clearFlag}`)
lives in `run-control-rules.ts` as a pure function with exhaustive table tests; the executor's SQL is
generated from / asserted against it in the unit suite so route and executor cannot drift (C5).

## 6. The completion guard (stop/terminate vs natural completion)

Today `completeRun` (`executor.ts:325-366`) writes status unconditionally. Window: child emits its
final events and exits cleanly in the same ~5s in which an operator sets `paused`/`cancelled` — the
kill-poll never fires, and the unconditional completion write would overwrite the operator's verb
with `completed`. Fix (C13): the CC-path completion write gains `AND status='running'`. Rowcount 0 →
log `[executor] run <id>: completion yielded to operator status <s>` and skip
notify/`completed_at` (the operator verb already stamped what it needed). The legacy claude-pool
branch keeps its current behavior — it is not on this control plane and changing it is scope creep.

`stuck`/`failed` writes get the same guard for symmetry: a run the operator terminated must not be
flipped to `stuck` by a timeout that was already moot. The stuck-watchdog
(`executor.ts:1094-1118`) already self-guards via `WHERE status='running'` — verified, no change.

Two further status writes were found unguarded at R905 and are covered from R906, because the
control plane is what makes them newly reachable by an operator:

- **The guardrail-block completion** (`processRun`'s spend pre-flight). It sits before the engine
  branch, so it fires for `claude-code` runs, and it is reached after two awaited round trips —
  a wide window for a terminate to land on a row it then overwrites with `failed`, plus a push about
  a run Konrad had just killed. Now takes `{guardRunning}` and gates its notification on the write
  applying. `engine`/`guardRunning` are hoisted to the top of `processRun` so every completion call
  site in it shares one declaration.
- **The session-contention requeue** (`processWithClaudeCode`, failure mode E10). `UPDATE runs SET
  status='queued' WHERE id=$1` with no precondition, executed after an awaited procfs scan — and it
  fires repeatedly, on exactly the wedged runs operators terminate. A terminate landing in that
  window was flipped back to `queued` and the killed run came back and kept spending; a stop's
  `paused` went the same way. Now carries `AND status='running'` and logs a yield on rowcount 0.
  Its `.catch` is gone with it: a pg failure here must surface (C20).

## 7. Interaction with project reconciliation (C9 — verified against code, not assumed)

- Task marked `done` → invisible to `listSettledRunningTasks` (filters `pt.status='running'`)
  forever. Resuming its run later cannot re-reconcile, double-notify, or re-consolidate. ✔
- Reviewer settled but NOT yet consolidated (≤10s window), then messaged/resumed: run leaves
  `completed`, so the round consolidator's `settled: r.run_status === "completed"` turns false and
  the group correctly `wait`s until the resumed run settles; the FINAL settled text is the verdict.
  **Only true if the message beats `listVerdictRound`'s read** — R905's red-team found the other
  half: a message landing AFTER that read but before mark-done was written over by an unconditional
  `setTaskStatus(done)`, and a 'done' task never re-surfaces, so the flipped verdict was honoured
  zero times in silence. Fixed R906 with optimistic concurrency: `markVerdictTaskDone` carries
  `AND r.status='completed'` into the UPDATE and reports whether the row moved; a refusal aborts the
  decision and the next tick re-consolidates. `r.status='completed'` is an exact detector, not an
  approximation — every write that can deliver a message to a settled run moves it out of
  `completed` in the same statement as the append. The two branches whose side effect precedes
  mark-done (`block` blocks the project and pushes; `fix` inserts the chain — both orders are
  crash-safety requirements and stay) additionally pre-check with `unsettledVerdictTasks()`
  immediately before that side effect, so the conditional mark-done only has to cover the remaining
  milliseconds.
- Terminating a task's run: run → `cancelled` → reconciler fails the task and blocks the project
  with a notification — exactly today's behavior for a died run, which is the correct reading of
  "Konrad killed my worker". Documented, not changed.
- Stopping (pausing) a task's run: run is non-settled → reconciler ignores it; the task sits
  `running` until resumed. The project heartbeat keeps reporting it. Acceptable and visible.

## 8. Executor-restart matrix — what is live when

Route-surface changes ship with `pm2 restart forge-control` (allowed). Executor-side changes (the
§5 handshake, §6 guard) load only when the DETACHED safe-restart lands — which, per this project's
hard rules, the deploy task launches and never waits for. Honest capability timeline:

| verb | live after forge-control restart alone | needs new executor |
|---|---|---|
| stop | ✔ (poll + kill are old code) | — |
| terminate (+completed_at) | ✔ | — |
| resume-chat | ✔ (claim/resume are old code) | — |
| message → queued/paused/stuck/completed target | ✔ | — |
| message → RUNNING target | appended but only delivered on natural completion+manual nudge | ✔ handshake |
| completion guard | — | ✔ |
| subagent-message → settled parent | ✔ | — |
| subagent-message → running parent | same caveat as message→running | ✔ |

Consequence for announcement (C19): the deploy phase appends rows for stop / terminate /
resume_finished with live proof; `message_into_session` and `subagent_message` rows are appended
only once the restart has landed and the running-target path is proven — via the deploy task's
queued reminder + a one-command verification script (`scripts/checks/verify-control-plane.sh`,
built in CP1) that Konrad or the operator chat runs post-restart. A fleet task cannot do this
itself: any fleet task in flight prevents the fleet-idle window the safe-restart waits for — that
circularity is structural, so the plan routes around it instead of pretending.

## 9. Linkage + corpus-path changes (CP3 scope)

- `cc-runner.ts` operator prompt, the `POST /api/projects` line: append the D5 sentence — pass your
  own run id (`$FORGE_RUN_UUID`) as `"origin_chat_id"` in the body. Inert until their route lands
  (main silently ignores unknown keys — boundary F9), correct after.
- `createRunForTask` (`db/projects.ts:870`): copy `project.metadata.origin_chat_id` → run metadata
  when present (C16). One spread line; no reads anywhere else change.
- `buildPrompt` (`project-tick.ts`): when the project carries `origin_chat_id`, append a MANAGER
  COMMS block to every role prompt (same `withPolicy`-style wrapper pattern as WORKTREE_POLICY so no
  role branch can forget it): manager run id, the report curl
  (`POST /api/runs/<origin_chat_id>/message` with `from:"worker"`, `sender_run_id:$FORGE_RUN_UUID`),
  and the rule that reports are for findings/blockers, not chatter.
- `projectSlug()` in `run-control-rules.ts` (pure, tested): the goal-mode architect branch's five
  hardcoded `docs/plan/0*.md` strings and the planner-corpus references
  (`project-tick.ts:413-419, 455`) interpolate `docs/plan/${slug}/…`. Affects only projects planned
  after deploy; this project's flat corpus is untouched until the D6 merge recipe.

## 10. Failure modes, enumerated

| failure | behavior | how Konrad sees it |
|---|---|---|
| message to unknown run | 404 | UI shows verbatim |
| message to failed/cancelled run | 409 naming `/resume-chat` | UI shows verbatim |
| resume into deleted worktree | 409 "workspace gone: `<path>`" | UI + nothing spawned |
| CC session file evaporated | full-transcript retry, loud in-thread marker (existing path) | marker in transcript |
| stop/terminate races completion | operator verb wins (§6 guard); executor logs the yield | status is what he chose; log line |
| message races completion | two-sided handshake (§5); worst case one extra turn | comms entry + next turn quotes it |
| double-click stop / stop+terminate | second UPDATE's precondition gone → 409 | one 202, one 409 |
| executor restart mid-delivery | state all in row; delivered on next completion/claim | nothing lost, at worst delayed |
| subagent id unknown | 409 "subagent context not addressable" | UI shows verbatim |
| relay to a parent that ignores it | parent's turn transcript shows the relay entry undelivered | visible in comms + transcript |
| terminate of a task run | task fails, project blocks, push notification (existing path) | Telegram push |

## 11. Rejected alternatives (one line each)

- **Mid-turn stdin/IPC injection** — `claude -p` closes stdin at spawn; anything else means forking
  the runner architecture for a feature the spec's own acceptance ("next turn") doesn't need.
- **Fork-on-resume (new run id)** — breaks task↔run linkage, splits transcripts, and the UI model
  treats a worker as one row; in-place is strictly simpler and the contract allows it.
- **New `stopped` status / `stuck` + signal** — `paused` already exists, already kills the child,
  already resumes; a new enum value ripples through every status switch in two codebases.
- **A `comms` side table** — second source of truth beside the thread; the thread already IS the
  transcript both the UI and the prompt builders read.
- **Postgres LISTEN/NOTIFY for delivery** — the 10s tick + 1.5s claim poll already bound latency;
  notify channels add a failure mode (dropped notifications) the row-state design cannot have.
- **Engine-side capabilities constant** — guaranteed whole-file conflict with the other lane's
  single-source-of-truth file; boundary D3 already settled this.
- **Fleet task that waits for the executor restart to verify the handshake** — structurally
  self-defeating (§8); a reminder + one-command script is the honest shape.
