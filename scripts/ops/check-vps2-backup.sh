#!/usr/bin/env bash
# Runs on VPS1. Watches VPS2's nightly backup and tells Konrad when it breaks.
#
# WHY IT LIVES HERE AND NOT THERE: a machine cannot alert on its own silence.
# If /opt/ai-os-backup/vps2-backup.sh stops being scheduled, or VPS2 is down, or
# cron is wedged, a self-alerting script on VPS2 produces exactly nothing — and
# nothing is indistinguishable from success. VPS2 also cannot reach the
# reminders API: forge-control listens on 127.0.0.1:7700 here, and a probe from
# VPS2 returns 000.
#
# So the split is: VPS2 records a verdict, VPS1 judges it. This catches the two
# failures that matter, and the second one is the one that actually bites:
#   1. the run failed            (rc != 0 in the sentinel)
#   2. the run never happened    (sentinel missing, or older than MAX_AGE)

set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

VPS2_SSH="ssh -i /root/.ssh/vps2_monitor -o BatchMode=yes -o ConnectTimeout=20 root@167.233.145.218"
STATUS=/var/lib/vps2-backup.status
LOG=/var/log/vps2-backup-check.log
MAX_AGE_HOURS=30          # nightly job + 6h of slack before we call it stale

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

alert() {
  log "ALERT: $*"
  curl -s --max-time 10 -X POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "when": "in 1m"}))' "$*")" \
    >/dev/null 2>&1 || log "warn: could not queue reminder"
}

raw="$($VPS2_SSH "cat $STATUS" 2>/dev/null)"

if [ -z "$raw" ]; then
  # Distinguish "box unreachable" from "backup never ran" — they need different
  # responses from Konrad, and collapsing them into one message wastes the alert.
  if $VPS2_SSH true 2>/dev/null; then
    alert "VPS2 backup: sentinel $STATUS is missing — the nightly backup has never completed a run."
  else
    alert "VPS2 unreachable over SSH — cannot confirm its nightly backup ran."
  fi
  exit 1
fi

last_run="$(printf '%s\n' "$raw" | sed -n 's/^last_run=//p')"
rc="$(printf '%s\n' "$raw" | sed -n 's/^rc=//p')"

age_h=99999
if [ -n "$last_run" ]; then
  then_s="$(date -d "$last_run" +%s 2>/dev/null || echo 0)"
  [ "$then_s" -gt 0 ] && age_h=$(( ( $(date +%s) - then_s ) / 3600 ))
fi

if [ "${rc:-1}" != "0" ]; then
  alert "VPS2 BACKUP FAILED (rc=$rc, last run $last_run) — check /var/log/vps2-backup.log on 167.233.145.218"
  exit 1
fi

if [ "$age_h" -gt "$MAX_AGE_HOURS" ]; then
  alert "VPS2 backup is STALE — last successful run was ${age_h}h ago ($last_run). The nightly job has stopped."
  exit 1
fi

log "ok — VPS2 backup healthy (rc=0, ${age_h}h old)"
exit 0
