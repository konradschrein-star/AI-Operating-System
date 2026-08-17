# Phase 1350 — CP-flip: close the control-plane handshake

The join that was missing. The engine lane (`project/4120f785`) shipped the
control-plane endpoints at r1203 and recorded their proof rows in the
announcement table of the vault note "AI OS/Contract - Manager Control Plane
API.md". Nobody flipped the matching flags, so `GET /api/capabilities` kept
reporting a control plane that did not exist and the UI kept rendering
plausible disabled buttons with nothing in any log. This phase flips them and
fills the handshake column that exists precisely so this cannot happen twice.

## Artifacts in this directory

| file | round | what it is |
|---|---|---|
| `cp-reproof-base.log` | 1351 | `scripts/checks/verify-control-plane.sh` — PASS 10/10 |
| `cp-reproof-running.log` | 1351 | same script `--running` — PASS 11/11 |
| `cp-reproof-verdict.md` | 1351 | the flip decision per flag, read from those two transcripts |
| `README.md` | 1352 | this note |

## What round 1352 changed

- `forge-control/src/routes/capabilities.ts` (commit `8ec83cc`) — `stop`,
  `terminate`, `resume_finished` and `message_into_session` flipped to `true`;
  the fifth key `subagent_message` ADDED (contract §5 specifies five keys, ours
  declared four) and left `false`; header comment rewritten to say the flip is
  unconditionally ours in every merge order, per the contract's r764 revision,
  and that the announcement table's `flipped?` column is the worklist.
- The vault note's announcement table — `flipped?` cells filled for the three
  r1203 rows, `n/a (no flag)` for `GET /comms`, plus one dated line under the
  table. Nothing else in that note was touched.

Served shape, proved out of the worktree with `scripts/checks/serve-v3-7798.ts`
on `SERVE_V3_PORT=7813` (production untouched; `:7798` was held by a sibling
round's harness, which was left running):

```
$ curl -s http://127.0.0.1:7813/api/capabilities | jq .
{
  "control_plane": {
    "message_into_session": true,
    "resume_finished": true,
    "subagent_message": false,
    "stop": true,
    "terminate": true
  }
}
```

## Deferred: the re-engage composer in `AgentChatView`

Decided by the planner. Do not reopen; the reason is written here rather than
implied:

> POST /api/runs/:id/resume-chat is live and proved in place (same run id back,
> r1203), and resume_finished is flipped true so the capability is now
> truthful. The UI affordance is deferred because AgentChatView has no composer
> today — it would be a new input surface plus thread-refresh semantics in a
> file that the round-1300 hover work also owns, and this phase is the flag-flip
> join, not a new surface. Deferred with a written reason, not implied; it is an
> open item for a later round.

## Open item carried forward

`subagent_message` stays `false`. Round 1351's verdict is NOT VERIFIABLE AS
WRITTEN: the honest-refusal halves are proven, but nothing has populated the
address space `runs.metadata.subagents_v2` since 2026-08-05, so no running
parent holds a live sub-agent id to relay to without fabricating a DB row.
Flip it on a CP4-style proof against a real fleet run with a running sub-agent,
and add its row to the announcement table.

## Rollback

`git revert 8ec83cc` restores the all-false constant and the buttons re-disable
with their existing tooltip; then blank the `flipped?` cells written above.
