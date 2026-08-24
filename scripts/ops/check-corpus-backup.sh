#!/usr/bin/env bash
# Runs on VPS1. Watches VPS2's JSON corpus backup and tells Konrad when it breaks.
# Added 2026-08-06, modelled on check-vps2-backup.sh — see that script's header
# for why the judging lives on this box and not on the one being judged.
#
# WHAT THIS WATCHES THAT check-vps2-backup.sh DOES NOT. That script covers the
# postgres and sqlite job. This one covers /opt/corpus-backup/corpus-backup.sh,
# which captures sweep.uk.json and sweep.jersey.json — the directory engine's
# primary irreplaceable asset, and the thing that had no backup at all until
# today beyond a 2026-08-02 copy holding 29,321 UK records against 271,784 live.
#
# THREE DISTINCT FAILURES, three distinct messages, because they need different
# responses:
#   1. the run failed                    (rc=1 in the sentinel)
#   2. the run succeeded on-box but the OFF-BOX copy did not land (rc=2)
#   3. the run never happened            (sentinel missing or stale)
# Collapsing 2 into "failed" would be wrong — the corpus IS backed up, just not
# off the machine — and collapsing it into "ok" would be worse, because the
# whole point of this job is surviving the loss of the box.
#
# Uses /root/.ssh/vps2_monitor, a key restricted on VPS2 to a forced command
# that can only print backup sentinels. It replaced vps2_mgmt, which was
# unrestricted root on the clean box held by the box that was compromised.

set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

VPS2_SSH="ssh -i /root/.ssh/vps2_monitor -o BatchMode=yes -o ConnectTimeout=20 root@167.233.145.218"
STATUS=/var/lib/corpus-backup.status
LOG=/var/log/corpus-backup-check.log
MAX_AGE_HOURS=14          # the job runs every 6h; 14 allows two misses of slack

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
  if $VPS2_SSH true 2>/dev/null; then
    alert "VPS2 corpus backup: sentinel $STATUS is missing — the corpus backup has never completed a run."
  else
    alert "VPS2 unreachable over SSH — cannot confirm the corpus backup ran."
  fi
  exit 1
fi

last_run="$(printf '%s\n' "$raw" | sed -n 's/^last_run=//p')"
rc="$(printf '%s\n'  "$raw" | sed -n 's/^rc=//p')"
offbox="$(printf '%s\n' "$raw" | sed -n 's/^offbox=//p')"
counts="$(printf '%s\n' "$raw" | sed -n 's/^counts=//p')"

age_h=99999
if [ -n "$last_run" ]; then
  then_s="$(date -d "$last_run" +%s 2>/dev/null || echo 0)"
  [ "$then_s" -gt 0 ] && age_h=$(( ( $(date +%s) - then_s ) / 3600 ))
fi

if [ "$age_h" -gt "$MAX_AGE_HOURS" ]; then
  alert "VPS2 corpus backup is STALE — last run was ${age_h}h ago ($last_run). The 6-hourly job has stopped."
  exit 1
fi

case "${rc:-1}" in
  0) : ;;
  2) alert "VPS2 corpus backup: on-box copy is good but the OFF-BOX push FAILED (offbox=$offbox, last run $last_run). The corpus now exists only on 167.233.145.218 — check /var/log/corpus-backup.log there."
     exit 1 ;;
  *) alert "VPS2 CORPUS BACKUP FAILED (rc=$rc, last run $last_run) — check /var/log/corpus-backup.log on 167.233.145.218"
     exit 1 ;;
esac

log "ok — corpus backup healthy (rc=0, ${age_h}h old, offbox=$offbox, $counts)"
exit 0
