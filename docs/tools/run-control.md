# `/api/runs/*` — the manager control plane (six endpoints)

> ## ⚠ STATUS as of CP3 (round 1101): implemented, unit-tested, **not proven live**
>
> Every endpoint below is shipped code on branch `project/4120f785` and covered by the unit
> suite. **Not one of them has been exercised against a running forge-control.** No verb in
> this document may be read as "proven"; the word used throughout is *implemented*.
>
> Live proof is CP4's job and has a single mechanism: `scripts/checks/verify-control-plane.sh`
> against a live server, transcript into `docs/plan/evidence/cp4-deploy.md` (§11). Until that
> transcript exists, the contract note's announcement table stays empty of rows for these
> endpoints — a row appended on faith is a gate failure
> (`docs/plan/06-control-plane-requirements.md` C19).

Transcribed from the shipped source, line by line, at round 1101. Every claim below cites
`file:line`. Primary sources, all read in full while writing this:

- `forge-control/src/routes/run-control.ts` — the six handlers, every status code, every
  reason string.
- `forge-control/src/lib/run-control-rules.ts` — the eligibility matrices, the completion
  transition, the comms-entry builders. Pure; no fs, no pg, no clock.
- `forge-control/src/db/runs.ts` — what each verb actually writes to the row.
- `docs/plan/06-control-plane-requirements.md` §3–4 (C1–C14, C20–C24),
  `docs/plan/07-control-plane-architecture.md` §4 (row effects), §5 (pending-input handshake),
  §6 (completion guard), §7 (reconciler), §8 (restart matrix),
  `docs/plan/08-control-plane-quality.md` §3b/§6.
- `/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md` — the shared contract,
  read-only from here. Where it and the code disagree, **this document describes the code** and
  names the divergence in §12.

---

## 1. What it is

Six HTTP verbs over a `runs` row, mounted at `/api/runs` by the two appended lines in
`forge-control/src/index.ts` (boundary 05 D2). They let a manager chat — or Konrad — do to a
worker run what a human lead does to a teammate: talk to it mid-task, reopen a finished one,
relay to one of its sub-agents, stop it, kill it, and read the traffic.

| verb | method + path | one line |
|---|---|---|
| message | `POST /api/runs/:id/message` | append a message; delivered on the target's next turn |
| stop | `POST /api/runs/:id/stop` | status → `paused`; the child dies within ~5s; stays resumable |
| terminate | `POST /api/runs/:id/terminate` | status → `cancelled` **and** `completed_at = now()` |
| resume-chat | `POST /api/runs/:id/resume-chat` | reopen a settled run **in place**, same id |
| comms | `GET /api/runs/:id/comms` | the run's `kind:"comms"` thread entries, oldest first |
| subagent-message | `POST /api/runs/:parentId/subagent-message` | relay to a sub-agent through its parent |

All state is the `runs` row — status, `thread`, `metadata`, `completed_at` (C23). There are no
side tables, no in-memory queues, and zero migrations (C21).

### 1.1 The handler skeleton every endpoint shares

`run-control.ts:15-20`: uuid-validate → `getRun` → a pure decision function from
`run-control-rules.ts` → **one** guarded single-row write from `db/runs.ts` → 202/4xx. No
eligibility logic is re-implemented in the route; the route and the executor import the same
rules module so the two cannot drift (C5).

Two consequences worth knowing before reading any endpoint section:

- **Hard errors only (C20).** The only `try/catch` in the whole file is the one around
  `c.req.json()` (`run-control.ts:184-186`) — a malformed body is a 400, not a 500. A pg
  failure propagates and becomes a visible 5xx. Nothing answers 2xx for work that did not
  happen.
- **Rowcount 0 is a question, not a failure.** The db helpers carry the eligibility
  precondition *into* the UPDATE's `WHERE` (`db/runs.ts:743-747, 774, 800`), so a miss means
  either "no such run" or "the status moved under us". They re-read the status once
  (`db/runs.ts:624-630`) and hand it back; the handler turns `status === null` into 404 and a
  present status into a 409 naming it (`run-control.ts:29-35`).

### 1.2 The error envelope

Every 4xx body is exactly `{"error": "<reason>"}`. The UI renders that string verbatim in a
toast, which is why each one is written for a human (`run-control-rules.ts:32-37`). Reason
strings in this document are **quoted verbatim from the source**; they are a wire contract, not
prose.

### 1.3 Shared request body

`message`, `resume-chat` and `subagent-message` take the same body type
(`run-control.ts:167-173`). Every field arrives as `unknown` and is narrowed per handler.

| field | type | required | notes |
|---|---|---|---|
| `text` | string | **yes**, on all three | trimmed; empty after trim → 400 (`run-control.ts:198-199`) |
| `from` | `"konrad" \| "manager" \| "worker"` | yes on `message` + `resume-chat`; **optional** on `subagent-message` (defaults `"manager"`) | validated against `COMMS_FROM` (`run-control.ts:77`) |
| `sender_run_id` | uuid string | no | the general spelling; enables the echo (§1.4) |
| `manager_run_id` | uuid string | no | the contract's **older** spelling for the same field |
| `subagent_id` | string | **yes**, `subagent-message` only | opaque Task `tool_use_id`; only shape check is non-empty |

**The aliasing, exactly as the code does it** (`run-control.ts:212, 449, 636`):

```js
const senderRaw = body.sender_run_id ?? body.manager_run_id ?? null;
```

`sender_run_id` wins when both arrive — the explicit one, per the comment at
`run-control.ts:209-211`. If the resolved value is present but not a uuid, that is a 400
(`run-control.ts:213-217`); absent is fine and simply means no echo.

### 1.4 The echo (C3)

When a `sender_run_id`/`manager_run_id` resolves, the engine also appends a `role:"agent"`,
`kind:"comms"` entry to the **sender's** thread (`run-control.ts:298-310, 563-572, 725-734`),
built by `commsEntries` (`run-control-rules.ts:482-500`). That write carries **no status change
and no eligibility list** — a manager must never be requeued by its own outbound message.

If the echo target does not exist, the delivery that already happened is **not** retracted: the
202 carries `"echo": false` and a `console.warn` is logged (`run-control.ts:306-309`). The
`echo` key is absent from the 202 body entirely when no sender was supplied
(`run-control.ts:323`).

### 1.5 The thread entries that get written (07 §3 — a wire contract)

Receiver side, in the target's thread (`run-control-rules.ts:458-473`):

```jsonc
{ "role": "user",
  "content": "[message from manager 3fa9c2d1] Ship the failing test first, then the fix.",
  "ts": "2026-08-06T…", "kind": "comms",
  "meta": { "comms": { "direction": "in", "from": "manager", "peer_run_id": "<sender uuid>" } } }
```

Sender side, the echo (`run-control-rules.ts:484-499`):

```jsonc
{ "role": "agent",
  "content": "[to worker 9b1e44a0] Ship the failing test first, then the fix.",
  "ts": "2026-08-06T…", "kind": "comms",
  "meta": { "comms": { "direction": "out", "from": "manager", "peer_run_id": "<target uuid>" } } }
```

`role:"user"` on the receiver so both prompt builders deliver it unchanged; `role:"agent"` on
the echo so it can never requeue the sender nor terminate `trailingUserBlock`'s tail scan. The
in-band `[message from …]` prefix survives a full-transcript rebuild, so attribution cannot be
lost to a resume-miss (`run-control-rules.ts:400-404`). Actor labels: `konrad`,
`manager <id8>`, `worker <id8>` — the 8-char short id (`run-control-rules.ts:368-370, 405-416`).

### 1.6 The one bounded re-dispatch (07 §5)

`message`, `resume-chat` and `subagent-message` each retry **exactly once** when their first
UPDATE's precondition was gone (`run-control.ts:264-275, 536-544, 698-709`). Not a loop, not a
poll. It is safe precisely because rowcount 0 means *nothing was appended*, so the retry is a
first delivery against a freshly-read status. A second loss is an honest 409.

`stop` and `terminate` **never** re-dispatch (`run-control.ts:353-365`). The asymmetry is
deliberate: a message means the same thing in every state that accepts it, whereas a verb
applied to a state nobody looked at is a different decision.

The 409 that ends a lost race is (`run-control.ts:134-136`):

```
run moved to '<status>' while the <verb> was being applied - re-read the run and retry
```

with `<verb>` ∈ `message` | `resume-chat` | `subagent-message` | `stop` | `terminate`
(`run-control.ts:289, 372, 383, 554, 719`).

---

## 2. `POST /api/runs/:id/message`

Contract §1; requirements C1–C5. Handler: `run-control.ts:192-327`.

### 2.1 Request

```jsonc
{
  "text": "Ship the failing test first, then the fix.",   // string, REQUIRED, trimmed
  "from": "manager",                                       // "konrad"|"manager"|"worker", REQUIRED
  "sender_run_id": "3fa9c2d1-…",                           // uuid, optional (alias: manager_run_id)
}
```

### 2.2 Success — `202`

```json
{ "queued": true, "delivery": "next-turn" }
```

Field names are the contract's and are not to be renamed (`run-control.ts:320`). `delivery` is
always the literal string `"next-turn"` (`run-control.ts:322`) — see §12.3. `"echo": true|false`
is present only when a sender run id was supplied (§1.4).

### 2.3 Eligibility by run status

Source: `messageAction` (`run-control-rules.ts:131-162`) and `MESSAGE_WRITE`
(`run-control.ts:92-122`). Matches 07 §4's row literally.

| status | outcome | row effect |
|---|---|---|
| `queued` | 202 | append only — the pending turn's prompt builder folds the thread tail in (`run-control-rules.ts:133-134`) |
| `running` | 202 | append **+** `metadata.pending_input = true`, in ONE statement (07 §5 T1/T2; `run-control.ts:104-106`) |
| `paused` | 202 | append **+** `status='queued'`, `completed_at=NULL`, `wake_after=NULL` (`run-control.ts:117-121`) |
| `stuck` | 202 | same as `paused`; for `stuck` this doubles as the contract's nudge |
| `completed` | 202 | same as `paused` |
| `failed` | **409** | `run failed - use POST /api/runs/:id/resume-chat to reopen it` |
| `cancelled` | **409** | `run cancelled - use POST /api/runs/:id/resume-chat to reopen it` |

Why `completed_at` and `wake_after` are cleared on the requeue: a live row carrying a past
completion time makes every duration in the UI lie, and the watchdog can then leave a `stuck`
row with `completed_at` set, which `completeRun`'s own invariant forbids; a `wake_after` left
over from a usage-wall backoff would silently delay a message Konrad just sent
(`run-control.ts:107-116`, `db/runs.ts:662-671`).

### 2.4 Every failure

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:id` is not a uuid | `run-control.ts:194` |
| 400 | `text required` | `text` absent, not a string, or empty after trim | `run-control.ts:198-199` |
| 400 | `from must be one of: konrad, manager, worker` | `from` absent or not in the set | `run-control.ts:201-206` |
| 400 | `invalid sender run id` | `sender_run_id`/`manager_run_id` present but not a uuid | `run-control.ts:213-217` |
| 404 | `unknown run` | `getRun` found no row | `run-control.ts:222` |
| 404 | `unknown run` | the row vanished between read and write (status re-read is null) | `run-control.ts:278` |
| 409 | `run failed - use POST /api/runs/:id/resume-chat to reopen it` | target is `failed` | `run-control-rules.ts:147-151` |
| 409 | `run cancelled - use POST /api/runs/:id/resume-chat to reopen it` | target is `cancelled` | `run-control-rules.ts:153-158` |
| 409 | `run moved to '<status>' while the message was being applied - re-read the run and retry` | lost the write race twice (§1.6) | `run-control.ts:134-136, 289` |
| 5xx | (pg error, unmodified) | database failure — deliberately not caught (C20) | `run-control.ts:24-28` |

A body that is not valid JSON is not a 500: `readCommsBody` yields `{}` and the `text required`
400 fires (`run-control.ts:184-186`).

### 2.5 Happy path

```bash
curl -i -X POST http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/message \
  -H 'content-type: application/json' \
  -d '{"text":"Ship the failing test first, then the fix.","from":"konrad"}'
```

---

## 3. `POST /api/runs/:id/stop`

Contract §3; requirements C11, C13. Handler: `run-control.ts:368-377`, sharing the
`statusVerb` skeleton at `run-control.ts:337-366`. Write: `stopRun` (`db/runs.ts:768-781`).

### 3.1 Request

**No body.** The path parameter is the whole request. Any body sent is ignored.

### 3.2 Success — `202`

```json
{ "stopping": true }
```

Row effect: `status='paused'`, `updated_at=now()` — **no** `completed_at` write, because a
paused run is not finished, it is interrupted, and it stays resumable
(`db/runs.ts:760-766, 770-776`). No new kill machinery: the executor's existing 5s status poll
reads `paused` and SIGTERMs the child within ~5s (07 §1).

### 3.3 Eligibility by run status

Source: `stopAction` (`run-control-rules.ts:211-230`), `STOP_ELIGIBLE`
(`run-control-rules.ts:88-92`). Matches 07 §4.

| status | outcome | row effect |
|---|---|---|
| `queued` | 202 | → `paused` |
| `running` | 202 | → `paused` (child SIGTERM'd ≤5s) |
| `paused` | **409** | `run is already paused` |
| `stuck` | 202 | → `paused` |
| `completed` | **409** | `run is already settled (completed)` |
| `failed` | **409** | `run is already settled (failed)` |
| `cancelled` | **409** | `run is already settled (cancelled)` |

### 3.4 Every failure

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:id` is not a uuid | `run-control.ts:370` |
| 404 | `unknown run` | `getRun` found no row | `run-control.ts:344` |
| 404 | `unknown run` | row gone between read and write | `run-control.ts:356` |
| 409 | `run is already paused` | target is `paused` | `run-control-rules.ts:218` |
| 409 | `run is already settled (<status>)` | target is `completed`, `failed` or `cancelled` — the status is interpolated | `run-control-rules.ts:221-226` |
| 409 | `run moved to '<status>' while the stop was being applied - re-read the run and retry` | precondition gone between read and write, and the current status does not itself reject | `run-control.ts:363-364, 372` |

The double-click case resolves here: two operators clicking stop and terminate in the same
second produce **one 202 and one 409**, never a mixed state, because the precondition travels
in the UPDATE's `WHERE` (`db/runs.ts:774`).

### 3.5 Happy path

```bash
curl -i -X POST http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/stop
```

---

## 4. `POST /api/runs/:id/terminate`

Contract §4; requirements C12, C13. Handler: `run-control.ts:379-388`. Write: `terminateRun`
(`db/runs.ts:793-807`).

### 4.1 Request

**No body.**

### 4.2 Success — `202`

```json
{ "terminating": true }
```

Row effect, all in **one** statement: `status='cancelled'`, `completed_at=now()`,
`updated_at=now()` (`db/runs.ts:795-802`). The `completed_at` stamp is the consistency fix the
contract §4 explicitly invites — today's cancel path leaves it NULL and durations fall back to
`updated_at`. Because the precondition excludes `cancelled`, a double-terminate's second call is
refused rather than re-stamping, so there is no ordering in which a row ends up `cancelled`
with a NULL `completed_at` (`db/runs.ts:788-791`).

### 4.3 Eligibility by run status

Source: `terminateAction` (`run-control-rules.ts:237-256`), `TERMINATE_ELIGIBLE`
(`run-control-rules.ts:94-99`). Matches 07 §4.

| status | outcome | row effect |
|---|---|---|
| `queued` | 202 | → `cancelled` + `completed_at` |
| `running` | 202 | → `cancelled` + `completed_at` (child SIGTERM'd ≤5s) |
| `paused` | 202 | → `cancelled` + `completed_at` |
| `stuck` | 202 | → `cancelled` + `completed_at` |
| `completed` | **409** | `run is already settled (completed)` |
| `failed` | **409** | `run is already settled (failed)` |
| `cancelled` | **409** | `run is already cancelled` |

Note the asymmetry with stop: `paused` is terminable, and `cancelled` gets its own wording
rather than the settled wording.

### 4.4 Every failure

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:id` is not a uuid | `run-control.ts:381` |
| 404 | `unknown run` | `getRun` found no row | `run-control.ts:344` |
| 404 | `unknown run` | row gone between read and write | `run-control.ts:356` |
| 409 | `run is already cancelled` | target is `cancelled` | `run-control-rules.ts:245` |
| 409 | `run is already settled (<status>)` | target is `completed` or `failed` | `run-control-rules.ts:247-252` |
| 409 | `run moved to '<status>' while the terminate was being applied - re-read the run and retry` | precondition gone between read and write | `run-control.ts:363-364, 383` |

### 4.5 Happy path

```bash
curl -i -X POST http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/terminate
```

### 4.6 Downstream effect on a project task

Terminating a project task's run makes the reconciler fail the task and block the project with
a notification — exactly today's behavior for a died run, which is the correct reading of
"Konrad killed my worker" (07 §7). Documented, not changed. Stopping a task's run instead
leaves it non-settled: the reconciler ignores it and the task sits `running` until resumed,
with the project heartbeat still reporting it.

---

## 5. `POST /api/runs/:id/resume-chat`

Contract §2; requirements C6, C7, C8. Handler: `run-control.ts:429-589`.

Reopen a settled run **IN PLACE** — same row, same id, stable across any number of resumes.
This handler never creates a run, and `resumed_run_id` is always the `:id` it was called with
(`run-control.ts:407-412, 584`).

### 5.1 Request

Same body as `/message` (§1.3), validated in the same order with the same reasons, so an
operator switching verbs never meets a different vocabulary of 400s (`run-control.ts:435-437`).

```jsonc
{
  "text": "One follow-up: did you check the paused branch?",  // string, REQUIRED
  "from": "konrad",                                            // REQUIRED
  "sender_run_id": "3fa9c2d1-…"                                // optional (alias: manager_run_id)
}
```

**`text` is required and that is a decision, not an oversight** (`run-control.ts:414-418`):
resume-chat means "reopen it *with something to say*". Waking a run with nothing to say is
`/message`'s job against a paused or completed target, which requeues it the same way. A resume
carrying no text would spend a CC turn on an empty prompt, so it is a 400 rather than a
silently accepted no-op (C20).

### 5.2 Success — `202`

```json
{ "resumed_run_id": "9b1e44a0-0000-4000-8000-000000000000" }
```

Not `queued`, not `delivery` — a resume answers with the id it reopened
(`run-control.ts:582-584`). `"echo": true|false` appears only when a sender was supplied.

Row effect, in ONE statement (`run-control.ts:522-530`, `db/runs.ts:673-696`): append the comms
entry **and** `status='queued'`, `completed_at=NULL`, `wake_after=NULL`, and
`metadata - 'pending_input'`.

That single-statement property is load-bearing, not stylistic. `markVerdictTaskDone` in
`db/projects.ts` detects "nobody has touched this settled run" with a status term in its
`WHERE`; that detector is only exact while *every write that can deliver a message to a settled
run moves it out of `completed` in the same statement as the append* (07 §7).
Split it in two and a round consolidation landing in the gap marks the reviewer task `done`
while the resumed run is about to produce a flipped verdict — honoured zero times, in silence
(`run-control.ts:498-505`).

`pending_input` is cleared because a run can be `completed` with the flag still raised (the
executor died between E1 and E2 of the 07 §5 handshake); the next turn delivers that message
along with the resume text, so the flag has been consumed and must not requeue the run a second
time (`run-control.ts:511-515`).

### 5.3 The C7 workspace pre-flight — before any write

`run-control.ts:467-483`. If `metadata.workspace_dir` is set and the directory is gone from
disk, the handler answers **409 `workspace gone: <path>`** and writes nothing at all — no
append, no status move. A resumed turn is spawned with `metadata.workspace_dir` as its cwd, so
a run whose worktree was deleted can only fail noisily mid-turn, after the thread already holds
a message nobody will ever act on.

The extraction is pure (`workspaceDirOf`, `run-control-rules.ts:562-569`) and the wording is a
constant-producing function (`workspaceGoneReason`, `run-control-rules.ts:576-578`) so the route
cannot paraphrase it into something the UI does not recognise. The `existsSync` stays in the
route: the rules module has no fs, no pg and no clock, which is what makes it table-testable
without a database.

**No `workspace_dir` is not an error.** Plain Chat and Manager runs share `CC_WORKSPACE` and
carry no such key; `workspaceDirOf` returns `null` and the resume proceeds
(`run-control-rules.ts:551-560`).

### 5.4 Eligibility by run status

Source: `resumeAction` (`run-control-rules.ts:170-196`), `RESUME_ELIGIBLE`
(`run-control-rules.ts:80-86`). Matches 07 §4.

| status | outcome | row effect |
|---|---|---|
| `queued` | **409** | `run is queued and will start on its own - use POST /api/runs/:id/message to talk to it` |
| `running` | **409** | `run is still running - use POST /api/runs/:id/message to talk to it` |
| `paused` | 202 | append + → `queued`, stamps cleared |
| `stuck` | 202 | same |
| `completed` | 202 | same |
| `failed` | 202 | same |
| `cancelled` | 202 | same |

`/message` and `/resume-chat` deliberately **overlap** on `paused|stuck|completed` — both "say
something to it" and "reopen it" are legitimate there. The invariant the unit suite asserts is
*reachability*, not exclusivity: for every status at least one of the two accepts, or both
reject with reasons naming the other verb (08 §1).

### 5.5 Every failure

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:id` is not a uuid | `run-control.ts:431` |
| 400 | `text required` | `text` absent or empty after trim | `run-control.ts:438-439` |
| 400 | `from must be one of: konrad, manager, worker` | `from` absent or not in the set | `run-control.ts:441-446` |
| 400 | `invalid sender run id` | sender field present but not a uuid | `run-control.ts:450-454` |
| 404 | `unknown run` | `getRun` found no row | `run-control.ts:459` |
| 404 | `unknown run` | row gone between read and write | `run-control.ts:547` |
| 409 | `workspace gone: <path>` | `metadata.workspace_dir` set, directory missing | `run-control.ts:481-482` |
| 409 | `run is still running - use POST /api/runs/:id/message to talk to it` | target is `running` | `run-control-rules.ts:181-185` |
| 409 | `run is queued and will start on its own - use POST /api/runs/:id/message to talk to it` | target is `queued` | `run-control-rules.ts:186-192` |
| 409 | `run moved to '<status>' while the resume-chat was being applied - re-read the run and retry` | lost the write race twice | `run-control.ts:553-554` |

### 5.6 Context recovery (C8) — no code here, and none should be added

If the CC session file for the run is gone, the executor's existing `CcResumeError` path
handles it: retry once with the FULL transcript plus a loud in-thread marker. That is
context-preserving, which is why the contract's opt-in `allow_fresh` fresh-start fallback was
withdrawn in the contract note itself and is **not implemented** (`run-control.ts:420-426`;
divergence §12.4). There is no silent-fresh path in this system.

### 5.7 Happy path

```bash
curl -i -X POST http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/resume-chat \
  -H 'content-type: application/json' \
  -d '{"text":"One follow-up: did you check the paused branch?","from":"konrad"}'
```

---

## 6. `GET /api/runs/:id/comms`

Requirement C14 — our additive extension; it is **not** in the contract note. Handler:
`run-control.ts:398-405`. Query: `listComms` (`db/runs.ts:836-861`).

### 6.1 Request

No body, no query parameters.

### 6.2 Success — `200`

```jsonc
{
  "run_id": "9b1e44a0-0000-4000-8000-000000000000",
  "comms": [
    { "role": "user",
      "content": "[message from konrad] Ship the failing test first.",
      "ts": "2026-08-06T09:12:44.101Z",
      "kind": "comms",
      "meta": { "comms": { "direction": "in", "from": "konrad", "peer_run_id": null } } }
  ]
}
```

Only `kind:"comms"` entries, both directions, **oldest first**. Filtering happens in Postgres,
not in Node: a long-running worker's thread is megabytes of tool calls, and shipping all of it
to filter out a dozen entries would make the UI's cheapest panel the most expensive query in
the system (`db/runs.ts:818-825`). `WITH ORDINALITY … ORDER BY ord` preserves thread order —
`jsonb_agg` over a set has no inherent ordering guarantee, so that clause is load-bearing.

Each entry is rebuilt with `jsonb_build_object` so every declared key is present: an entry
written without `meta` comes back as `"meta": null`, never an absent key
(`db/runs.ts:843-850`).

### 6.3 Eligibility by run status

| status | outcome |
|---|---|
| `queued` / `running` / `paused` / `stuck` / `completed` / `failed` / `cancelled` | **200** — any status is queryable |

A settled run's traffic is exactly what an operator wants to read after the fact
(`run-control.ts:392-395`).

### 6.4 Every failure

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:id` is not a uuid | `run-control.ts:400` |
| 404 | `unknown run` | no such row | `run-control.ts:403`, `db/runs.ts:858-859` |

**A known run with no comms is `{"run_id": …, "comms": []}`, never a 404** — "no traffic yet"
is a normal state and must not read as "no such run" (`db/runs.ts:832-834, 860`).

### 6.5 Happy path

```bash
curl -s http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/comms | jq .
```

---

## 7. `POST /api/runs/:parentId/subagent-message`

Contract §2b; requirement C10. Handler: `run-control.ts:610-752`.

A sub-agent has **no session of its own** outside its parent, so the only honest mechanism is a
relay: a `kind:"comms"` entry appended to the **parent's** thread instructing it to hand the
text over via its harness (SendMessage) and report the reply back
(`run-control.ts:591-598`). Pretending otherwise would be exactly the silent fallback this
system bans.

### 7.1 Request

```jsonc
{
  "subagent_id": "toolu_01ABC…",   // string, REQUIRED, trimmed; the Task tool_use_id
  "text": "Re-check the second finding.",  // string, REQUIRED
  "from": "manager",               // OPTIONAL — defaults to "manager"
  "sender_run_id": "3fa9c2d1-…"    // optional (alias: manager_run_id)
}
```

`from` is optional because a relay comes by definition from whoever holds the parent's manager
role, and the contract's own §2b body does not carry the field. **Present-but-invalid is still
a 400** — a default is not a licence to accept nonsense (`run-control.ts:604-607, 625-634`).

The address space is `metadata.subagents_v2[*].id` (`subagentAddressable`,
`run-control-rules.ts:518-531`), opaque, so the only shape check possible on `subagent_id` is
"a non-empty string" (`run-control.ts:619-623`).

### 7.2 Success — `202`

```json
{ "queued": true, "delivery": "next-turn", "subagent_id": "toolu_01ABC…" }
```

§2b of the contract declares no response shape ("202 / 409 / 404 as above"), so this is §1's
body plus the `subagent_id` the relay was addressed to (`run-control.ts:600-603, 743-751`).
`"echo"` appears only when a sender was supplied.

The relay entry's content is built by `commsEntries({relaySubagentId})`
(`run-control-rules.ts:454-456`) and never assembled in the route:

```
[relay from manager 3fa9c2d1 -> sub-agent toolu_01ABC…] Deliver this to that sub-agent via your
harness (SendMessage) and report its reply back here: Re-check the second finding.
```

Still `role:"user"`, still `kind:"comms"`, still `direction:"in"` — only the content and one
meta key (`meta.comms.subagent_id`) differ.

### 7.3 Order of checks — addressability BEFORE eligibility

`run-control.ts:648-660`. This is a decision, not an accident: addressability is a property of
the **address**, not of timing. An unknown `subagent_id` must produce the same refusal whether
the parent happens to be `running` or `completed` at that instant — otherwise the UI shows
"run failed - use resume-chat" for an id that never existed, and an operator retries a relay
that can never be delivered.

`subagentAddressable` never throws: a run predating the sub-agent rollup simply has no
`subagents_v2` key, and the correct answer for that is the 409, not a 500
(`run-control-rules.ts:510-517`).

### 7.4 Eligibility by run status — **of the PARENT**

The relay is delivered under `/message`'s rules applied to the parent, because the parent is
the run that has to act on it (`run-control.ts:662-676`; C10, 07 §4). Identical to §2.3:

| parent status | outcome | row effect on the parent |
|---|---|---|
| `queued` | 202 | append relay entry only |
| `running` | 202 | append **+** `pending_input` |
| `paused` | 202 | append **+** → `queued`, stamps cleared |
| `stuck` | 202 | same |
| `completed` | 202 | same |
| `failed` | **409** | `run failed - use POST /api/runs/:id/resume-chat to reopen it` |
| `cancelled` | **409** | `run cancelled - use POST /api/runs/:id/resume-chat to reopen it` |

A failed/cancelled parent therefore 409s naming `/resume-chat` — the honest refusal 08 §5's S8
demands. There is no path that answers 2xx without an entry having been appended to the
parent's thread; if a parent's session has evaporated, the visible outcome is that parent's own
next-turn transcript reporting the relay undelivered, never a silently swallowed one.

### 7.5 Every failure

Validation order in the handler is: uuid → `text` → `subagent_id` → `from` → sender → `getRun`
→ addressability → parent eligibility. The first failing check wins.

| status | body `error` (verbatim) | cause | source |
|---|---|---|---|
| 400 | `invalid run id` | `:parentId` is not a uuid | `run-control.ts:612` |
| 400 | `text required` | `text` absent or empty after trim | `run-control.ts:616-617` |
| 400 | `subagent_id required` | absent, not a string, or empty after trim | `run-control.ts:621-623` |
| 400 | `from must be one of: konrad, manager, worker` | `from` present but not in the set | `run-control.ts:626-634` |
| 400 | `invalid sender run id` | sender field present but not a uuid | `run-control.ts:637-641` |
| 404 | `unknown run` | no such parent run | `run-control.ts:646` |
| 404 | `unknown run` | parent row gone between read and write | `run-control.ts:712` |
| 409 | `subagent context not addressable` | `subagent_id` ∉ `metadata.subagents_v2[*].id`, or the key is absent entirely | `run-control-rules.ts:508`, `run-control.ts:658-659` |
| 409 | `run failed - use POST /api/runs/:id/resume-chat to reopen it` | parent is `failed` | `run-control-rules.ts:147-151` |
| 409 | `run cancelled - use POST /api/runs/:id/resume-chat to reopen it` | parent is `cancelled` | `run-control-rules.ts:153-158` |
| 409 | `run moved to '<status>' while the subagent-message was being applied - re-read the run and retry` | lost the write race twice | `run-control.ts:718-719` |

### 7.6 Happy path

```bash
curl -i -X POST http://127.0.0.1:7700/api/runs/9b1e44a0-0000-4000-8000-000000000000/subagent-message \
  -H 'content-type: application/json' \
  -d '{"subagent_id":"toolu_01ABCdefGHI","text":"Re-check the second finding.","from":"manager"}'
```

---

## 8. Consolidated eligibility matrix

One table, all six verbs, seven statuses. Every cell is the outcome for a request that passes
validation and does not lose a write race. Sourced from `run-control-rules.ts:131-256` and
identical to 07 §4.

| status | message | resume-chat | subagent-message (parent) | stop | terminate | comms |
|---|---|---|---|---|---|---|
| `queued` | 202 append | 409 → `/message` | 202 append | 202 → `paused` | 202 → `cancelled` | 200 |
| `running` | 202 append + flag | 409 → `/message` | 202 append + flag | 202 → `paused` | 202 → `cancelled` | 200 |
| `paused` | 202 append + requeue | 202 requeue | 202 append + requeue | 409 already paused | 202 → `cancelled` | 200 |
| `stuck` | 202 append + requeue | 202 requeue | 202 append + requeue | 202 → `paused` | 202 → `cancelled` | 200 |
| `completed` | 202 append + requeue | 202 requeue | 202 append + requeue | 409 settled | 409 settled | 200 |
| `failed` | 409 → `/resume-chat` | 202 requeue | 409 → `/resume-chat` | 409 settled | 409 settled | 200 |
| `cancelled` | 409 → `/resume-chat` | 202 requeue | 409 → `/resume-chat` | 409 settled | 409 already cancelled | 200 |

The eligibility lists are exported as **data**, not just baked into the switches, because they
are carried into SQL as the UPDATE's precondition (`WHERE id=$1 AND status = ANY($2)`) — which
is what makes two operators clicking at once resolve to one 202 and one 409
(`run-control-rules.ts:39-60`).

Who carries which list, precisely:

- `STOP_ELIGIBLE` / `TERMINATE_ELIGIBLE` are imported by `db/runs.ts` and baked into
  `stopRun`/`terminateRun`'s own `WHERE` (`db/runs.ts:776, 802`). The route never sees them.
- `/message` has **three** preconditions, not one — a message to a `running` row must not land
  on a row that became `completed` under it, because the two need different writes. So the
  per-status precondition travels inside the action itself (`MessageAction.eligible`) and the
  route puts *that* in the `WHERE` (`run-control.ts:242-245`). `MESSAGE_ELIGIBLE`
  (`run-control-rules.ts:74-78`) is derived from the same three arrays, so the union and the
  partition cannot drift.
- `RESUME_ELIGIBLE` is carried by the route into `RESUME_WRITE` (`run-control.ts:522-528`).

---

## 9. What each verb writes — the row-effects table (07 §4)

| verb | `thread` | `status` | `completed_at` | `metadata` | `wake_after` |
|---|---|---|---|---|---|
| message → `queued` | +1 entry | — | — | — | — |
| message → `running` | +1 entry | — | — | `pending_input: true` | — |
| message → `paused`/`stuck`/`completed` | +1 entry | → `queued` | → NULL | — | → NULL |
| resume-chat (any eligible) | +1 entry | → `queued` | → NULL | `- pending_input` | → NULL |
| subagent-message | as message, on the **parent**, with the relay prefix + `meta.comms.subagent_id` | as message | as message | as message | as message |
| stop | — | → `paused` | — | — | — |
| terminate | — | → `cancelled` | → `now()` | — | — |
| comms | — | — | — | — | — |

Every one of those is a **single** `UPDATE … RETURNING status` (`db/runs.ts:749-757, 769-780,
794-806`). The echo, when present, is a second independent append to a *different* row with no
preconditions (§1.4).

Two guards that are not visible in the table but constrain it:

- `appendCommsEntry` **throws** if both `setPendingInput` and `clearPendingInput` are passed —
  two conflicting SET fragments on one `metadata` column in one statement would make the result
  depend on fragment order (`db/runs.ts:716-722`). No route passes both; the throw is the C20
  backstop for a future caller.
- An **empty** `eligible` array means nothing is eligible and the write is refused. It is not
  silently treated as "no precondition"; omit the key for that (`db/runs.ts:658-660`).

---

## 10. Restart matrix — what is live when

Reproduced from `docs/plan/07-control-plane-architecture.md` §8.

Route-surface changes ship with `pm2 restart forge-control` (allowed by this project's rules).
Executor-side changes — the 07 §5 pending-input handshake and the 07 §6 completion guard —
load **only** when the DETACHED `safe-restart.sh forge-executor` lands, which the deploy task
launches and never waits for.

| verb | live after `pm2 restart forge-control` alone | needs the new executor |
|---|---|---|
| stop | ✔ (poll + kill are old code) | — |
| terminate (+`completed_at`) | ✔ | — |
| resume-chat | ✔ (claim/resume are old code) | — |
| message → `queued`/`paused`/`stuck`/`completed` target | ✔ | — |
| message → **RUNNING** target | appended, but only delivered on natural completion + a manual nudge | ✔ handshake |
| completion guard | — | ✔ |
| subagent-message → settled parent | ✔ | — |
| subagent-message → **running** parent | same caveat as message → running | ✔ handshake |

**Stated plainly: `message` → RUNNING target, `subagent-message` → running parent, and the
completion guard are the executor-dependent half.** Everything else in this document is live
the moment the API process restarts. Before the executor restart lands, a message into a
running target is appended to the thread and answered 202 — but the row's `pending_input` flag
has no consumer in the old executor binary, so delivery waits for that run to complete
naturally and then be nudged.

Consequence for the announcement (C19): the deploy phase appends contract-note rows for
`stop` / `terminate` / `resume_finished` with live proof; the `message_into_session` and
`subagent_message` rows are appended **only** once the restart has landed and the
running-target path is proven. A fleet task cannot do this itself — any fleet task in flight
prevents the fleet-idle window the safe-restart waits for. That circularity is structural,
which is why the plan routes around it with a reminder plus a script instead of pretending.

---

## 11. How to verify

The one command is **`scripts/checks/verify-control-plane.sh`** (built in CP1; 08 §3b/§6).

```bash
scripts/checks/verify-control-plane.sh              # message / resume-chat / subagent-message / stop / terminate / comms
scripts/checks/verify-control-plane.sh --running    # additionally exercises message-into-RUNNING
FORGE_URL=http://127.0.0.1:7700 scripts/checks/verify-control-plane.sh
scripts/checks/verify-control-plane.sh --help
```

**It runs against a LIVE forge-control.** It creates its own disposable scratch runs via
`POST /api/chat` (`budget_usd: 0`, a harmless no-op prompt), drives them through
message → stop → message → terminate → message, plus a message into a run the live executor
actually finished (the only way to prove the requeue clears `completed_at`), resume-chat in
place on that now-cancelled run, the queued-target refusal naming `/message`, and
subagent-message's honest-refusal paths against a run that never spawned a sub-agent. It
asserts the HTTP status code and body at every step and best-effort terminates leftovers on
exit. Exit status is 0 iff every step passed; a step that cannot even be attempted counts as
failed. Nothing in it is a silent skip.

**Therefore it may be run ONLY from CP4's deploy/verify task, or by Konrad by hand — never from
a build task.** Running it from a build phase violates this project's worktree-only policy
(`docs/plan/05-control-plane-boundary.md`; every phase brief repeats it): it writes real rows
in the live `runs` table and talks to the live API. That is also why nothing in this document
is marked proven — no build task is permitted to produce that proof.

Its full stdout transcript goes verbatim into `docs/plan/evidence/cp4-deploy.md`. That paste is
the deploy phase's proof artifact and the source for the announcement table's "proof" column.

Before the detached executor restart lands, failures in the `--running` section are **expected**
and are printed as `[EXPECTED PRE-RESTART]` rather than reported as control-plane defects — but
they are still counted in the final tally, so the transcript never quietly claims more than it
saw.

### 11.1 What a build task *can* verify

Only what runs out of the worktree: `npx tsc --noEmit`, `pnpm test` (the pure rules are
table-tested per the `src/lib/account-health.test.ts` precedent), and reading the source. That
is the full extent of the evidence behind this document.

---

## 12. Known divergences — code vs. the contract note

Where `/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md` and the shipped code
disagree, **this document describes the code**. Each divergence below is deliberate and
recorded; none is a bug report.

### 12.1 `from` accepts `"worker"`; the contract lists only `konrad | manager`

Contract §1 and §2 declare `from: "konrad" | "manager"`. The code accepts a third value,
`"worker"` (`run-control.ts:77`, `run-control-rules.ts:30`), so worker→manager reports ride the
same verb instead of needing a second endpoint. This is our additive extension, declared in
requirement C1 and recorded in the contract note. Strictly widening: every contract-conformant
request still behaves as specified.

### 12.2 `sender_run_id` does not exist in the contract

The contract's field is `manager_run_id` only. The code accepts both, `sender_run_id` first
(`run-control.ts:212, 449, 636`), because with `from:"worker"` the sender is not a manager and
the old name would be a lie. `manager_run_id` remains fully supported — nothing that speaks the
contract breaks.

### 12.3 `delivery` is always `"next-turn"`; the contract allows `"immediate"`

Contract §1 types the field `"next-turn" | "immediate"`. The code returns the literal
`"next-turn"` unconditionally (`run-control.ts:322`) and there is no code path producing
`"immediate"`. `claude -p` closes the child's stdin at spawn, so there is no channel into a turn
in flight; "next turn" is the spec's own acceptance criterion and the only honest mechanism
(06 §5, 07 §11). A client must not branch on `"immediate"` — it will never arrive.

### 12.4 `allow_fresh` / `mode: "fresh"` is not implemented, on purpose

Contract §2 offers an opt-in `body.allow_fresh: true` returning
`{resumed_run_id, mode: "fresh"}`. **No such flag is read anywhere and none should be added**
(`run-control.ts:420-426`). The executor's existing `CcResumeError` path already retries once
with the FULL transcript plus a loud in-thread marker, which is context-preserving, so the
fallback is unnecessary; it was withdrawn in the contract note's own Q2 answer (C8). Sending
`allow_fresh` today is silently ignored as an unknown key, which is the one place this surface
does not hard-error on a bad input — it is a *body* key the handler never reads, not a decision
it fakes.

### 12.5 `resume-chat` requires `text`; the contract does not say so

The contract's §2 body shows `text: string` without marking it required. The code 400s on empty
text (`run-control.ts:438-439`) because a resume with nothing to say would spend a CC turn on an
empty prompt; `/message` against a paused or completed target is the verb for waking a run with
no payload, and it requeues identically (`run-control.ts:414-418`).

### 12.6 `resume-chat` is IN PLACE; the contract permits a fork

Contract §2 allows `resumed_run_id` to be "same id if resumed in place, new id if forked". This
implementation is always in place — same row, stable id, across any number of resumes
(contract Q2, answered in the note; `run-control.ts:407-412`). Forking would break the
task↔run linkage and split transcripts (07 §11).

### 12.7 `stop`/`terminate` 409 in more cases than "already settled"

The contract says 409 "if already settled". The code additionally 409s for stop on an
already-`paused` run (`run-control-rules.ts:218`), for terminate on an already-`cancelled` run
with its own wording (`run-control-rules.ts:245`), and for either verb when the precondition
disappears between read and write (`run-control.ts:363-364`). All three are refusals the
contract's ground rule ("never a 200 that did nothing") requires; none of them accepts a request
the contract says must be accepted.

### 12.8 `subagent-message` accepts `from` and `sender_run_id`; §2b's body has neither

Contract §2b's body is `{subagent_id, text}`. The code additionally accepts optional `from`
(default `"manager"`) and the sender aliases (`run-control.ts:625-643`), and its 202 body adds
`subagent_id` alongside §1's `queued`/`delivery` (`run-control.ts:743-751`) — §2b declares no
response shape at all ("202 / 409 / 404 as above"), so this is an interpretation, not a
contradiction.

### 12.9 `GET /:id/comms` is not in the contract

It is our additive extension for comms visibility, requirement C14 (06 §3). The contract's §1
asks the implementer to state where both sides of the traffic land; this endpoint is that
answer, plus a way to read it without scanning full threads client-side.

### 12.10 The `echo` response field is in no contract section

Contract Q1 asked whether the engine or the UI writes the sender-side copy; the note's answer is
the engine (C3). The code goes one step further and reports whether that second write landed, as
a boolean `echo` in the 202 body — present only when a sender run id was supplied
(`run-control.ts:323, 585, 748`). It is additive: a client that ignores the key sees exactly the
contract's response.

### 12.11 The capabilities flag for `subagent_message` does not exist yet

Contract §5 specifies five flags; `CAPABILITIES.control_plane` on the operator-visibility branch
declares four — `subagent_message` is missing. That file
(`forge-control/src/routes/capabilities.ts`) is on this lane's never-touch list (boundary 05
D1/D3) and the key is theirs to add. Recorded in the contract note's negotiation section and in
`scripts/checks/verify-control-plane.sh`'s header; not a defect in anything documented here, and
this lane will not invent a flag to fix it.

---

## 13. Related documents

| what | where |
|---|---|
| Requirements C1–C24 | `docs/plan/06-control-plane-requirements.md` |
| Architecture: endpoint table, handshake, guard, restart matrix | `docs/plan/07-control-plane-architecture.md` §4–§8 |
| Test strategy, QA gates, red-team scenarios | `docs/plan/08-control-plane-quality.md` |
| Phase plan CP1–CP4 | `docs/plan/09-control-plane-phases.md` |
| Cross-lane boundary treaty (D1–D6) | `docs/plan/05-control-plane-boundary.md` |
| The contract (read-only from this lane) | `/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md` |
| The live-verification script | `scripts/checks/verify-control-plane.sh` |
