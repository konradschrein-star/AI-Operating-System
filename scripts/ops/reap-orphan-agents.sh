#!/usr/bin/env bash
# Reap orphaned `claude` engine processes.
#
# Why: a turn killed by the old wall-clock timeout could leave its `claude -p
# --resume <session>` child alive. The next message spawned a NEW process for
# the SAME session, so two-plus copies of one conversation ran concurrently —
# each making tool calls and writing files from a stale view. That corrupted
# builds, reverted edits, and inflated tool-call counts.
#
# Rule: for any session id with more than one live process, keep the NEWEST and
# terminate the rest. Never touch a session with only one process.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
LOG=/var/log/forge-reaper.log

ps -eo pid,lstart,args | grep -F -- "--resume " | grep -F "claude" | grep -v grep |
while read -r line; do
  pid=$(echo "$line" | awk '{print $1}')
  sid=$(echo "$line" | grep -oE -- "--resume [0-9a-f-]{36}" | awk '{print $2}')
  [ -z "$sid" ] && continue
  start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || continue
  echo "$sid $start $pid"
done | sort -k1,1 -k2,2nr | awk '
  { if ($1 == last) { print $3 } else { last = $1 } }
' | while read -r victim; do
  kill -TERM "$victim" 2>/dev/null &&
    echo "[$(date -Is)] reaped duplicate engine pid=$victim" >>"$LOG"
done
