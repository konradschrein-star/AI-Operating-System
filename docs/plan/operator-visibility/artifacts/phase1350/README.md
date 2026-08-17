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

## Deploy notes — MIGRATIONS FIRST, then the restart

**There is no migration runner in this repo.** `forge-control` does not apply
schema on boot and nothing else does either, so a deploy that restarts the API
before the SQL is applied ships a 500. Both findings 4 (r1353 CP-flip review)
and 5 (r1353 settings review) are this, from two directions.

Apply, in this order, **before** `pm2 restart forge-control`:

```bash
cd /opt/forge-ai-os
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a   # or read DATABASE_URL from pm2 env
psql "$DATABASE_URL" -f db/migrations/0040_usage_hourly.sql
psql "$DATABASE_URL" -f db/migrations/0041_ui_dismissals.sql
```

Both are re-runnable — every statement is `IF NOT EXISTS`, verified by applying
0040 twice into a scratch database (second run: all NOTICE/skip). Running them
against a database that already has them is a no-op, so "am I sure it was
applied?" is answered by applying it again.

What breaks if you skip them, precisely:

| skipped | symptom |
|---|---|
| `0041_ui_dismissals.sql` | `GET /api/chat/:id/team` → 500 `relation "ui_dismissals" does not exist`; `/api/agents/dismissals` fails; **the team panel does not render at all** |
| `0040_usage_hourly.sql` | `GET /api/usage/series` → 500; the usage sampler logs an error every hour; `PUT /api/usage/rate` throws its own "has migration 0040 been applied" diagnostic |

Boot cost is not a concern: the sampler's backfill measured **9.06 ms** per
bucket against live data (574 runs / 673 spend rows), so a full 720-bucket
30-day backfill is ≈6.5 s, once, on the first boot after 0040 lands.

Verify before restarting:

```bash
psql "$DATABASE_URL" -tAc \
  "SELECT to_regclass('public.usage_hourly'), to_regclass('public.ui_dismissals'), to_regclass('public.app_settings')"
# expects: usage_hourly|ui_dismissals|app_settings — a NULL in any column means that migration did not land
```

## Deploy-time cleanup left by round 1353's reviewer

Proving the team panel without `ui_dismissals` required an isolated auxiliary
schema in `content_forge`: **`rev1353_shim`**, holding one empty
`ui_dismissals` table. Nothing in `public` was altered, the schema is off every
default `search_path`, and nothing reads it.

It is dead weight, not a hazard. Removing it is a `DROP`, which no build task
here is authorised to issue, so it is recorded rather than performed:

```sql
DROP SCHEMA rev1353_shim CASCADE;   -- needs Konrad's explicit go-ahead
```

Leaving it in place breaks nothing. Do it during the deploy phase, or not at
all; do not let it block the deploy.

## Rollback

1. `git revert 8ec83cc` restores the all-false constant and the buttons
   re-disable with their existing tooltip; then blank the `flipped?` cells
   written above.
2. The migrations do **not** need reverting — `usage_hourly`, `app_settings`
   and `ui_dismissals` are additive tables that no reverted code reads. Dropping
   them would destroy the dismissal set Konrad has built up. Leave them.
