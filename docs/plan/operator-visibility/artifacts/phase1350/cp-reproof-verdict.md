# CP-flip 1/4 — live re-proof of `message_into_session` and `subagent_message`

Round 1350. Run against the LIVE forge-control on `http://127.0.0.1:7700`
(pm2 id 16, online). No product code changed; no DB write by hand; no
forge-executor restart; `/opt/forge-ai-os` never edited.

Transcripts (full stdout+stderr, verbatim):

- `cp-reproof-base.log` — `scripts/checks/verify-control-plane.sh` → **PASS 10/10 checks**
- `cp-reproof-running.log` — `scripts/checks/verify-control-plane.sh --running` → **PASS 11/11 checks**

Both exited 0. No step failed in either transcript.

---

## `message_into_session`

### VERDICT: PROVEN — flip to true? **yes**

Every assertion the script makes for `POST /api/runs/:id/message` passed green,
including the RUNNING-target half that the header tags `[EXPECTED PRE-RESTART]`.

**Queued / paused / cancelled / completed targets** (`cp-reproof-base.log`):

| step | line | observed |
|---|---|---|
| 1 — message to a fresh (queued) run | 132 | `-> HTTP 202` / `{"queued": true, "delivery": "next-turn"}`; `GET /comms` `-> HTTP 200` with a `direction: "in"` entry |
| 2 — message with `sender_run_id` | 165, 239 | `-> HTTP 202`; sender comms carries `direction: "out"`; `sender status before echo: 'queued', after: 'queued'` (C3 holds — the echo does not disturb the sender) |
| 4 — message to a paused run | 323, 403 | `-> HTTP 202`; `status after message-to-paused: 'queued'` |
| 6 — message to a cancelled run | 575 | `-> HTTP 409` / `{"error": "run cancelled - use POST /api/runs/:id/resume-chat to reopen it"}` |
| 6b — message to a run the live executor actually finished | 852, 857, 1062 | `run B completed_at before the message: '2026-08-17 03:08:06.086303+00'` → `-> HTTP 202` → `run B after the message: status 'queued', completed_at ''` (R906: the requeue clears `completed_at`) |

**RUNNING target — step R1** (`cp-reproof-running.log`, lines 1493–1636). The
script waited for scratch run `08ad3cfe-2d70-4a45-b041-f94c8cf14ec6` to be
claimed, observed `"status": "running"`, `"worker": "forge-executor"`,
`"started_at": "2026-08-17 03:08:21.123968+00"`, then:

```
$ curl -sS -X POST 'http://127.0.0.1:7700/api/runs/08ad3cfe-2d70-4a45-b041-f94c8cf14ec6/message' \
    -H 'content-type: application/json' -d '{ "text": "R1 message into a running target", "from": "konrad" }'
  -> HTTP 202
{
  "queued": true,
  "delivery": "next-turn"
}
$ curl -sS -X GET 'http://127.0.0.1:7700/api/runs/08ad3cfe-2d70-4a45-b041-f94c8cf14ec6/comms'
  -> HTTP 200
{
  "run_id": "08ad3cfe-2d70-4a45-b041-f94c8cf14ec6",
  "comms": [
    {
      "ts": "2026-08-17T03:08:22.620Z",
      "kind": "comms",
      "meta": { "comms": { "from": "konrad", "direction": "in", "peer_run_id": null } },
      "role": "user",
      "content": "[message from konrad] R1 message into a running target"
    }
  ]
}
PASS step R1
```

### Why the `[EXPECTED PRE-RESTART]` caveat does not apply any more

The script's header gates the RUNNING half on "the DETACHED forge-executor
restart" (07-control-plane-architecture.md §8). **That restart already
happened, unattended, and this task did not cause it.**

- `forge-control/src/executor.ts` — which carries the pending-input handshake
  (07 §5's E2: `completeRun` → `completionTransition` → requeue with
  `completed_at = NULL`) — last changed **2026-08-06 02:36:00** in
  `48931bd fix(control-plane): R905 fix cycle 1 — all 10 reviewer findings (CP1, R906)`.
- The live `forge-executor` process (pid 2276472) has been up since
  **Tue Aug 11 06:39:55 2026** — five days *after* that commit. The running
  process therefore already contains the handshake.

### Independent corroboration of the executor-side half (zero writes by me)

Step R1 proves the HTTP contract but deliberately does not assert delivery
("delivery on next turn is the executor-side half — not provable from HTTP
alone"). That half is nonetheless observable in already-existing state, from a
real fleet run, on the currently-running executor process:

`/root/.pm2/logs/forge-executor-out.log:62`

```
[executor] run 38f3a5c5-7d45-42f5-b621-f93a16d831ff ok via claude-code in 564092ms (31 turns, $3.4545)
[executor] run 38f3a5c5-7d45-42f5-b621-f93a16d831ff: pending input consumed - requeued for next turn
[executor] claimed run 38f3a5c5-7d45-42f5-b621-f93a16d831ff (operator-visibility · STEWARD SCOPE RULING for phase 1300 — )
[executor] run 38f3a5c5-7d45-42f5-b621-f93a16d831ff ok via claude-code in 51945ms (7 turns, $1.6617)
```

`GET /api/runs/38f3a5c5-7d45-42f5-b621-f93a16d831ff/comms` → `HTTP 200`, and the
injected message is there:

```
ts 2026-08-16T22:55:16.576Z  direction "in"  from "konrad"
"[message from konrad] OPERATOR DECISION IN, 2026-08-17 — Konrad answered your escalation: (d). …"
```

That run started `2026-08-16 22:51:17`, took the message at `22:55:16` **while
running**, and the executor requeued it for a second turn rather than
completing it. The full loop — message into a RUNNING session → next-turn
delivery — is live today.

---

## `subagent_message`

### VERDICT: NOT VERIFIABLE AS WRITTEN — flip to true? **no (and there is no flag to flip)**

Read this one carefully: the blocker is **not** the forbidden executor restart.
Three separate facts, in ascending order of importance.

**1. The honest-refusal halves are proven.** Step 9 (`cp-reproof-base.log`
lines 1480–1558), against fresh scratch run
`1188d49b-c7ec-4289-af9b-432ebdb7028c`:

```
$ curl -sS -X POST '…/api/runs/1188d49b-c7ec-4289-af9b-432ebdb7028c/subagent-message' \
    -d '{ "subagent_id": "toolu_definitely_not_a_real_id", "text": "step 9 relay" }'
  -> HTTP 409
{
  "error": "subagent context not addressable"
}
$ curl -sS -X POST '…/api/runs/1188d49b-c7ec-4289-af9b-432ebdb7028c/subagent-message' \
    -d '{ "subagent_id": "", "text": "step 9 relay with empty id" }'
  -> HTTP 400
{
  "error": "subagent_id required"
}
$ curl -sS -X GET '…/api/runs/1188d49b-c7ec-4289-af9b-432ebdb7028c/comms'
  -> HTTP 200
{
  "run_id": "1188d49b-c7ec-4289-af9b-432ebdb7028c",
  "comms": []
}
PASS step 9
```

Refused calls append nothing — asserted and green. Identical in
`cp-reproof-running.log` (line 1476, `PASS step 9`).

**2. The addressable relay half has no live target to address, today.** The
address space is `runs.metadata.subagents_v2[*].id`
(`run-control-rules.ts:546`, `subagentAddressable`). Read-only census of the
live `runs` table (SELECT only — no write):

```
SELECT count(*) FROM runs;                                                        -> 542
SELECT count(*) FROM runs WHERE metadata ? 'rollup_v1';                           -> 335
SELECT count(*) FROM runs
  WHERE jsonb_array_length(COALESCE(metadata->'subagents_v2','[]'::jsonb)) > 0;   ->   6
```

All six carry `status = completed`, and none is newer than **2026-08-05**:

```
888b2031 | completed | 2026-08-05 13:14 | subs=1 | engine-v2-research-lane · Re-verify Gemini + Perpl
97143435 | completed | 2026-08-05 09:04 | subs=1 | engine-v2-research-lane · Fix cycle 2
ab331865 | completed | 2026-08-05 08:58 | subs=4 | operator-visibility · Chat-Manager UI v3 — full re
3853c154 | completed | 2026-08-05 07:02 | subs=2 | operator-visibility · Plan: operator-visibility
2751c30d | completed | 2026-08-05 06:59 | subs=3 | engine-v2-research-lane · Plan: engine-v2-research
5fee372a | completed | 2026-08-04 23:09 | subs=2 | live-panel-manager-split · Plan: live-panel-manage
```

A relay needs a **running** parent holding a **live** sub-agent id. No such row
exists right now, and the only way to manufacture one is to fabricate
`metadata.subagents_v2` by hand — a DB write this task forbids — or to fire a
relay into another project's real run, which is a write outside the
one-scratch-run policy. So the path stays unexercised. Note in passing, for
whoever owns the rollup: **nothing has populated `subagents_v2` since
2026-08-05**, though 335 runs since carry `rollup_v1`. Not chased here.

**3. The decisive one: `subagent_message` is not a flag.** The live endpoint
returns four keys, and the worktree source has the same four:

```
$ curl -sS http://127.0.0.1:7700/api/capabilities
{
  "control_plane": {
    "message_into_session": false,
    "resume_finished": false,
    "stop": false,
    "terminate": false
  }
}
```

`forge-control/src/routes/capabilities.ts` (worktree and
`/opt/forge-ai-os`, identical) declares exactly those four. There is no
`subagent_message` key. This is the defect the check script's header already
records — "CAPABILITIES.control_plane on main is missing it
(05-control-plane-boundary.md 'Defect to record, not to fix')" — confirmed live.

**Round 1352 cannot flip `subagent_message` to true, because there is no such
flag to flip.** Adding one belongs to the lane that owns
`capabilities.ts`, and it should not be added until the relay half has a live
proof (CP4, against a real fleet run with a running sub-agent).

---

## The three already-proven flags

`stop`, `terminate` and `resume_finished`: **proof row exists in the vault
announcement table, r1203** ("AI OS/Contract - Manager Control Plane API.md").
Not re-run for the flip decision. This transcript did exercise them, and they
were green in both logs — recorded here for completeness, not as the basis of
the decision:

| verb | step | observed |
|---|---|---|
| `stop` | 3 (base:242–316) | `-> HTTP 202`; `status after stop: 'paused'`; second stop `-> HTTP 409` |
| `terminate` | 5 (base:406–568) | `-> HTTP 202`; `status after terminate: 'cancelled', completed_at: '2026-08-17 03:08:00.261607+00'`; second terminate `-> HTTP 409` |
| `resume_finished` | 8 (base:1149–1478) | resume-chat on the cancelled run `-> HTTP 202`, resumed in place, status `queued`, `completed_at` cleared; second resume-chat while queued `-> HTTP 409` naming `/message` |
| `GET /comms` | 7 (base:1065–1147) | `-> HTTP 200` on both runs (additive extension, no flag of its own) |

---

## Recommendation to round 1352

| flag | flip? |
|---|---|
| `message_into_session` | **true** — proven end to end, including the RUNNING target; the restart its caveat waited on landed on 2026-08-11 |
| `resume_finished` | **true** — r1203 proof row, re-observed green here (step 8) |
| `stop` | **true** — r1203 proof row, re-observed green here (step 3) |
| `terminate` | **true** — r1203 proof row, re-observed green here (step 5) |
| `subagent_message` | **no change — the key does not exist in `capabilities.ts`.** Do not invent it. Refusal halves proven; relay half unproven for want of a live sub-agent address |

## Scope statement

Writes caused by this task: the scratch runs the script creates via
`POST /api/chat`, and the control-plane verbs it drives against them
(terminated best-effort by the script's own `cleanup` trap). Nothing else.
Everything else in this file is a read: `GET`s, `SELECT`s, pm2 logs, and
`git log` against the read-only live checkout. No `.ts`/`.tsx` file touched;
the entire diff of this round is under
`docs/plan/operator-visibility/artifacts/phase1350/`.
