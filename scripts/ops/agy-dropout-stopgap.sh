#!/usr/bin/env bash
# STOPGAP, 2026-08-23 — delete this once you have confirmed R870 is live.
#
# The permanent fix (forge-control commit 19828af) re-queues a task the Gemini
# engine dropped onto tier `junior` instead of failing it and blocking the
# project. It lives in lib/project-tick.ts, which runs INSIDE forge-executor,
# so it does nothing until that process restarts — and forge-executor cannot be
# restarted from inside a live agent turn (safe-restart.sh exists for exactly
# that reason and is waiting for the fleet to go quiet).
#
# In the gap, every agy dropout still wedges its project and still alarms
# Konrad's phone. This applies the same repair from outside, on a timer:
# demote the dropped task to `junior`, hand it back to 'ready', un-block the
# project. Same predicate as the code — ONLY the three agy envelope signatures,
# never a task whose WORK failed.
#
# Self-terminating: exits as soon as safe-restart.sh reports the restart (the
# real fix is then in the loop), or after MAX_SECS regardless.

set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

MAX_SECS="${1:-21600}"
POLL="${2:-180}"
LOG=/var/log/agy-dropout-stopgap.log
RESTART_LOG=/var/log/forge-safe-restart.log

set -a; source /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
DSN="${DATABASE_URL:?DATABASE_URL missing}"

# Line count at start: a "restarted" line appearing AFTER this point is ours.
BASE=$(wc -l <"$RESTART_LOG" 2>/dev/null || echo 0)
START=$(date +%s)

log() { echo "[$(date -Is)] $*" >>"$LOG"; }
log "stopgap armed (max ${MAX_SECS}s, poll ${POLL}s) — waiting out the R870 deploy"

SQL="
WITH dropped AS (
  SELECT t.id, t.project_id
    FROM project_tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN runs r ON r.id = t.run_id
   WHERE t.status='failed' AND t.tier='gemini' AND p.status='blocked'
     AND (SELECT elem->>'content' FROM jsonb_array_elements(r.thread) elem
           WHERE elem->>'kind' IN ('error','stuck_notice')
           ORDER BY (elem->>'ts')::timestamptz DESC LIMIT 1)
         ~ 'agy (returned status [A-Za-z]+ with no response text|produced no parseable JSON|exceeded [0-9]+ms)'
),
fixed AS (
  UPDATE project_tasks SET tier='junior', status='ready', run_id=NULL,
         attempt=attempt+1, updated_at=now()
   WHERE id IN (SELECT id FROM dropped) RETURNING project_id
)
UPDATE projects SET status='active', updated_at=now()
 WHERE id IN (SELECT project_id FROM fixed) AND status='blocked'
RETURNING name;
"

while :; do
  now=$(date +%s)
  if [ $((now - START)) -ge "$MAX_SECS" ]; then
    log "max wait reached — standing down (CHECK WHETHER R870 IS ACTUALLY LIVE)"
    exit 2
  fi
  if [ "$(wc -l <"$RESTART_LOG" 2>/dev/null || echo 0)" -gt "$BASE" ] &&
     tail -n +$((BASE + 1)) "$RESTART_LOG" | grep -q "restarted forge-executor"; then
    log "forge-executor restarted — R870 is live, standing down"
    exit 0
  fi
  # grep -v the command tag: a RETURNING statement that matched nothing still
  # prints "UPDATE 0", which would otherwise log as a repair every poll.
  repaired=$(psql "$DSN" -tAc "$SQL" 2>>"$LOG" | grep -v '^UPDATE [0-9]*$' | tr '\n' ' ' | sed 's/ *$//') || true
  [ -n "$repaired" ] && log "re-queued on junior + un-blocked: $repaired"
  sleep "$POLL"
done
