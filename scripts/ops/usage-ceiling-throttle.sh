#!/usr/bin/env bash
# Keep the 5-hour usage window near its ceiling — full, not half-empty.
#
# KONRAD'S RULING, 2026-08-25: "don't park at 85%, park at 95% bruh, the other
# agents can't work."
#
# He is right, and the reasoning matters: the 5-hour window RESETS. Utilisation
# left unspent at reset is not saved, it is thrown away. Parking the fleet at
# 81% with three hours to go wasted roughly a fifth of the budget AND stalled
# 34 queued tasks. The failure mode to avoid is the WALL (which wedges the
# fleet — usage-windows-are-the-budget), not high utilisation. So run hot and
# brake late.
#
#   < PAUSE_AT   : everything runs. This is the normal state.
#   >= PAUSE_AT  : pause the lowest-priority ACTIVE lanes, newest first, until
#                  under. In-flight tasks always finish — pausing only stops the
#                  tick picking the lane up again, so nothing is killed mid-write.
#   <= RESUME_AT : resume everything that THIS script paused. It never resumes a
#                  lane a human paused, because it only touches its own list.
#
# PRIORITY_LANES never get paused: they are what the operator is actually
# waiting on. Everything else is fair game.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

PAUSE_AT=95
RESUME_AT=80
STATE=/var/tmp/usage-throttle.paused          # lanes THIS script paused
STAMP=/var/tmp/usage-throttle.stamp           # liveness: touched every run
LOG=/var/log/usage-ceiling-throttle.log
API=http://127.0.0.1:7700/api

# Lanes the operator is waiting on — never throttled.
PRIORITY_LANES="aios-sidebar-live-sessions aios-browser-takeover-live aios-chat-list-etag"

touch "$STAMP" "$STATE"
log() { echo "[$(date -Is)] $*" >>"$LOG"; }

set -a; . /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
[ -z "${DATABASE_URL:-}" ] && exit 0

util=$(curl -s -m 10 "$API/usage/quota" 2>/dev/null | python3 -c "
import json,sys
try: print(int(json.load(sys.stdin)['five_hour']['utilization']))
except Exception: print(-1)
")
[ "$util" -lt 0 ] 2>/dev/null && exit 0

q() { psql "$DATABASE_URL" -tAc "$1" 2>/dev/null; }

if [ "$util" -ge "$PAUSE_AT" ]; then
  # Newest first: the youngest lane has the least sunk work behind it.
  excl=$(printf "'%s'," $PRIORITY_LANES); excl="${excl%,}"
  victim=$(q "select name from projects
               where status='active' and name not in ($excl)
                 and exists (select 1 from project_tasks t
                             where t.project_id=projects.id
                               and t.status in ('pending','ready'))
               order by created_at desc limit 1")
  if [ -n "$victim" ]; then
    q "update projects set status='paused', updated_at=now() where name='$victim'" >/dev/null
    grep -qxF "$victim" "$STATE" 2>/dev/null || echo "$victim" >>"$STATE"
    log "util ${util}% >= ${PAUSE_AT}% — paused '$victim' (in-flight tasks finish)"
  else
    log "util ${util}% >= ${PAUSE_AT}% but nothing left to pause except priority lanes — riding it out"
  fi
  exit 0
fi

if [ "$util" -le "$RESUME_AT" ] && [ -s "$STATE" ]; then
  n=0
  while IFS= read -r lane; do
    [ -z "$lane" ] && continue
    q "update projects set status='active', updated_at=now()
        where name='$lane' and status='paused'" >/dev/null && n=$((n+1))
  done < "$STATE"
  : > "$STATE"
  [ "$n" -gt 0 ] && log "util ${util}% <= ${RESUME_AT}% — resumed $n lane(s) this script had paused"
fi
exit 0
