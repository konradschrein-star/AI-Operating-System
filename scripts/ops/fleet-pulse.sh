#!/usr/bin/env bash
# Fleet pulse (2026-08-25) — the thing that makes the detectors count.
#
# WHY THIS EXISTS. `scripts/ops/stalled-projects.sh` is a careful, controlled
# detector for the silent-stop failure class, written 2026-08-18 after three
# projects died unnoticed. `scripts/ops/fleet-watchdog.sh` auto-unwedges
# projects and its own header says "every 10 min via system cron".
#
# On 2026-08-25 neither was scheduled anywhere. Not in root's crontab, not in
# /etc/cron.d, not a systemd timer. `/var/log/fleet-watchdog.log` had not been
# written since 2026-08-19 00:20 — six days. The symlinks in /opt/ai-os/scripts
# were all in place, which is what made it read as installed. So the platform
# owned two good instruments and had no pulse: every stall was still found by a
# human noticing something felt quiet.
#
# This script is the pulse. It runs the read-only detector, and it escalates —
# once — when the detector fires. Konrad already has a backlog of DECIDE
# reminders, so a pulse that pushed every 30 minutes would be worse than no
# pulse at all; the dedup rules below are the load-bearing part, not the cron
# line.
#
# WHAT IT CHECKS
#   1. stalled-projects.sh — every stall shape that detector knows.
#   2. fleet-watchdog liveness — /var/tmp/fleet-watchdog.stamp is touched on
#      every invocation of the watchdog, BEFORE its early exit. A watchdog that
#      is never invoked and a watchdog with nothing to do write identical logs;
#      the stamp is the only thing that tells them apart. If the stamp is stale
#      the watchdog's cron entry has gone missing again — which is the exact
#      regression this script was written after.
#
# DEDUP. Alert when the normalised finding set CHANGES, or when it is still
# non-empty 6h after the last alert. Ages ("45h since last change") are
# normalised out of the hash first, otherwise every run would look like a new
# finding and the 6h floor would never bind.
#
# Read-only with respect to the fleet: it runs a read-only detector and POSTs a
# reminder. It never retries, cancels, or unwedges anything — the watchdog owns
# mutation, this owns noticing.
#
#   fleet-pulse.sh [--dry-run] [--force]
#     --dry-run  print what would be sent, POST nothing, do not touch state
#     --force    ignore dedup and alert if there is anything to alert about
#
# Exit 0 when clear, 1 when findings (so it composes like its siblings).

set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"

REPO_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/var/log/fleet-pulse.log
STATE=/var/tmp/fleet-pulse.state
STAMP=/var/tmp/fleet-pulse.stamp
WATCHDOG_STAMP=/var/tmp/fleet-watchdog.stamp
API=http://127.0.0.1:7700/api
# The watchdog is meant to run every 10 min. 25 min of silence is two missed
# invocations plus slack — long enough not to fire on a slow box, short enough
# that a lost cron entry is caught the same hour instead of the same week.
WATCHDOG_MAX_AGE_S=1500
REALERT_AFTER_S=21600   # 6h
DRY_RUN=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

# Every invocation leaves a mark, for the same reason the watchdog now does:
# this script's own silence must be distinguishable from its own good news.
[ "$DRY_RUN" = 1 ] || touch "$STAMP"

now="$(date +%s)"
findings=""

# ── 1. the stall detector ────────────────────────────────────────────────────
report="$("$REPO_SCRIPTS/stalled-projects.sh" 2>&1)"
stall_rc=$?

# Section walk: a section is a finding when its body is anything but "none".
# Kept in awk rather than parsed in bash so a body line containing "==" or a
# pipe cannot confuse it.
stall_findings="$(printf '%s\n' "$report" | awk '
  /^== / { section = substr($0, 4, length($0) - 6); next }
  /^$/   { next }
  $0 == "none" { next }
  /^STALLED/ { next }
  /^clear/ { next }
  section != "" { print section " :: " $0 }
')"

[ -n "$stall_findings" ] && findings="$stall_findings"

# ── 2. is the watchdog actually being invoked? ───────────────────────────────
if [ -f "$WATCHDOG_STAMP" ]; then
  wd_age=$(( now - $(stat -c %Y "$WATCHDOG_STAMP") ))
  if [ "$wd_age" -gt "$WATCHDOG_MAX_AGE_S" ]; then
    findings="${findings:+$findings$'\n'}WATCHDOG SILENT :: fleet-watchdog.sh has not run for $((wd_age / 60))m — its cron entry is missing"
  fi
else
  # No stamp at all: either the watchdog has not run since the stamp was added,
  # or it is not installed. Both are the same alarm.
  findings="${findings:+$findings$'\n'}WATCHDOG SILENT :: no $WATCHDOG_STAMP — fleet-watchdog.sh has not run since liveness stamping was added"
fi

log "pulse: stalled-projects rc=$stall_rc, findings=$(printf '%s' "$findings" | grep -c . || true)"
printf '%s\n' "$report" >>"$LOG"

if [ -z "$findings" ]; then
  echo "clear — no stalls, watchdog alive."
  exit 0
fi

echo "$findings"

# ── 3. escalate, but only when it is news ────────────────────────────────────
# Ages are volatile by construction; hashing them would make every run "new".
hash="$(printf '%s' "$findings" |
  sed -E 's/[0-9]+(m|h) (stale|dead|since last change)/N\1 \2/g' |
  md5sum | cut -d' ' -f1)"

last_hash=""; last_ts=0
if [ -f "$STATE" ]; then
  last_hash="$(sed -n '1p' "$STATE")"
  last_ts="$(sed -n '2p' "$STATE")"
  [ -n "$last_ts" ] || last_ts=0
fi

should_alert=0
reason=""
if [ "$FORCE" = 1 ]; then
  should_alert=1; reason="forced"
elif [ "$hash" != "$last_hash" ]; then
  should_alert=1; reason="finding set changed"
elif [ $(( now - last_ts )) -ge "$REALERT_AFTER_S" ]; then
  should_alert=1; reason="unchanged but still open after $(( (now - last_ts) / 3600 ))h"
fi

if [ "$should_alert" = 0 ]; then
  log "suppressed: same finding set ($hash), last alerted $(( (now - last_ts) / 60 ))m ago"
  echo "(already reported — suppressed)"
  exit 1
fi

count="$(printf '%s\n' "$findings" | grep -c .)"
# 500 chars is the reminders API's hard cap; over it the POST 400s and the
# alarm is silently lost, which would reproduce the bug this script fixes.
body="$(printf '%s\n' "$findings" | head -4 | cut -c1-110)"
text="$(printf '🩺 Fleet pulse: %s stall finding(s).\n%s\n\nFull report: /opt/ai-os/scripts/stalled-projects.sh' "$count" "$body" | cut -c1-490)"

if [ "$DRY_RUN" = 1 ]; then
  echo "--- would POST (${reason}) ---"
  printf '%s\n' "$text"
  exit 1
fi

payload="$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "when": "in 1m"}))' "$text")"
resp="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/reminders" \
  -H 'content-type: application/json' -d "$payload")"

if [ "$resp" = "200" ] || [ "$resp" = "201" ]; then
  printf '%s\n%s\n' "$hash" "$now" >"$STATE"
  log "alerted ($reason): $count finding(s), http $resp"
  echo "alerted Konrad ($reason)"
else
  # Do NOT record state on a failed POST: the next run must try again rather
  # than believe it already told him.
  log "ALERT FAILED: http $resp — state not recorded, will retry next pulse"
  echo "alert POST failed (http $resp)"
fi

exit 1
