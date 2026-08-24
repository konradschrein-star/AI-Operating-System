#!/usr/bin/env bash
# Restart a pm2 service WITHOUT killing a live agent turn.
#
# Why this exists: `pm2 restart forge-executor` from inside a running turn
# kills that turn (it's the process hosting the conversation) — the operator
# has done this once and it surfaced as the nonsensical "claude-code exit 0".
# So deploying executor changes used to require Konrad to run the command by
# hand between messages. He wants the system autonomous, so instead we wait
# for the system to go quiet and restart ourselves.
#
# "Quiet" = no run has heartbeat recently. Status is NOT a reliable signal:
# a run can sit in 'stuck' while its process is very much alive and working
# (that's exactly what a wall-clock timeout used to produce).
#
#   safe-restart.sh <pm2-service> [max-wait-seconds] [idle-seconds]
#
# Exits 0 on restart, 2 if it gave up waiting (never force-kills a live turn).

set -euo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

SVC="${1:-forge-executor}"
MAX_WAIT="${2:-7200}"     # give up after 2h rather than restart under a live run
IDLE_SECS="${3:-45}"      # no heartbeat for this long = quiet
# Optional ecosystem file. `pm2 restart <name> --update-env` only re-reads the
# SHELL env — it does NOT re-read ecosystem.config.cjs, so env changes made
# there (e.g. pinning CC_MODEL) silently never take effect. Passing the
# ecosystem path makes the restart authoritative.
ECOSYSTEM="${4:-}"
POLL=15
STABLE_NEEDED=2           # consecutive quiet polls before we act

LOG=/var/log/forge-safe-restart.log
# Credentials live in the secrets env file (password rotates); never hardcode.
set -a; source /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
export PGPASSWORD="${PGPASSWORD:-${DB_PASSWORD:-}}"
if [ -z "$PGPASSWORD" ] && [ -n "${DATABASE_URL:-}" ]; then
  PGPASSWORD="$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-z+]+://[^:]+:([^@]+)@.*$|\1|')"
  export PGPASSWORD
fi
PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -tAc)

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

# ── THE CALLER'S OWN HEARTBEAT (added 2026-08-23, operator) ──────────────────
# Why: "quiet" was "no run has heartbeat recently" — counting ALL runs, with no
# exclusion for the run that invoked this script. An agent turn heartbeats every
# few seconds, so a turn calling `safe-restart.sh forge-control` could never
# observe quiet: it waited out MAX_WAIT and exited 2 with the log line "system
# never went quiet". Measured 2026-08-23 — the only live run was the caller.
# A gate that the act of invoking it makes unpassable is not a gate.
#
# The exclusion is deliberately NOT applied to forge-executor. That service
# HOSTS the calling turn, so excluding the caller there would let the script
# restart the very process running it — the exact failure this file exists to
# prevent ("claude-code exit 0"). For forge-executor the caller's heartbeat is
# the most important one to count; for every other service it is noise.
SELF_EXCLUDE=""
if [ -n "${FORGE_RUN_UUID:-}" ] && [ "$SVC" != "forge-executor" ]; then
  SELF_EXCLUDE="AND id::text <> '${FORGE_RUN_UUID}'"
fi

live_runs() {
  "${PSQL[@]}" \
    "SELECT count(*) FROM runs WHERE last_heartbeat_at > now() - interval '${IDLE_SECS} seconds' ${SELF_EXCLUDE}" \
    2>/dev/null | tr -d '[:space:]' || echo "?"
}

# ── SINGLE-INSTANCE LOCK (added 2026-08-18, operator) ────────────────────────
# Why: on 2026-08-18 two instances of this script (round 820's and round 910's,
# launched 54 minutes apart) confirmed idle one second apart and BOTH called
# `pm2 restart forge-executor`. Exactly one restart happened and the loser
# logged a spurious "ERROR: ... Process 17 not found" — harmless that time, by
# luck. Two instances CAN restart a service while the first restart is still
# booting, which is the precise failure this script exists to prevent.
#
# `flock -n` per service: if another instance already holds it, that instance
# will perform the restart, so exiting 0 is correct — the caller's intent is
# satisfied by someone else. Exiting non-zero would make a duplicate waiter
# look like a failed deploy.
# `-E 99` gives the lock-conflict its OWN exit code. Without it flock exits 1 on
# conflict, indistinguishable from the child script failing. And `exec` cannot be
# used here at all: a successful exec replaces this process, so any `||` fallback
# after it is unreachable and the conflict path silently returns 1. Both mistakes
# were made and measured before this form was kept.
LOCKFILE="/var/lock/forge-safe-restart-${SVC}.lock"
if [ -z "${SAFE_RESTART_LOCKED:-}" ]; then
  set +e
  env SAFE_RESTART_LOCKED=1 flock -n -E 99 "$LOCKFILE" "$0" "$@"
  rc=$?
  set -e
  if [ "$rc" -eq 99 ]; then
    log "another safe-restart instance already holds $LOCKFILE for '$SVC' — exiting 0, it will do the restart"
    exit 0
  fi
  exit "$rc"
fi

log "waiting for idle to restart '$SVC' (max ${MAX_WAIT}s, idle window ${IDLE_SECS}s)"
start=$(date +%s)
stable=0

while :; do
  n="$(live_runs)"
  if [ "$n" = "?" ]; then
    log "db unreachable — backing off, will not restart blind"
    stable=0
  elif [ "$n" -eq 0 ] 2>/dev/null; then
    stable=$((stable + 1))
  else
    [ "$stable" -gt 0 ] && log "activity resumed ($n live) — resetting"
    stable=0
  fi

  if [ "$stable" -ge "$STABLE_NEEDED" ]; then
    log "idle confirmed — restarting $SVC${ECOSYSTEM:+ (from $ECOSYSTEM)}"
    if { [ -n "$ECOSYSTEM" ] &&
           pm2 restart "$ECOSYSTEM" --only "$SVC" --update-env >>"$LOG" 2>&1; } ||
       { [ -z "$ECOSYSTEM" ] && pm2 restart "$SVC" --update-env >>"$LOG" 2>&1; }; then
      sleep 4
      state="$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('unknown'); raise SystemExit
print(next((p['pm2_env']['status'] for p in d if p['name']=='$SVC'),'missing'))
" 2>/dev/null || echo unknown)"
      log "restarted $SVC — status=$state"
      [ "$state" = "online" ] && exit 0
      log "WARNING: $SVC is '$state' after restart"
      exit 1
    fi
    log "ERROR: pm2 restart $SVC failed"
    exit 1
  fi

  if [ $(( $(date +%s) - start )) -ge "$MAX_WAIT" ]; then
    log "gave up after ${MAX_WAIT}s — system never went quiet; NOT restarting"
    exit 2
  fi
  sleep "$POLL"
done
