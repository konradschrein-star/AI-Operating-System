#!/usr/bin/env bash
# Fleet watchdog (2026-08-05): every 10 min via system cron, unwedge projects
# that got blocked by transient run failures (usage walls, guardrail trips,
# session deaths). Zero-token: pure API calls. The engine's own attempt cap
# bounds retries — this NEVER passes force:true, so a genuinely failing task
# stops being retried after the cap and we notify Konrad exactly once.
# Interim measure until engine-v2 lands native auto-recovery (task r860);
# harmless to keep afterwards.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
LOG=/var/log/fleet-watchdog.log
STATE=/var/tmp/fleet-watchdog.state
API=http://127.0.0.1:7700/api
touch "$STATE"

log() { echo "[$(date -Is)] $*" >>"$LOG"; }

notify() {
  curl -sX POST "$API/reminders" -H 'content-type: application/json' \
    -d "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"),\"when\":\"in 1m\"}" \
    >>"$LOG" 2>&1
}

blocked="$(curl -s "$API/projects" | python3 -c '
import json,sys
try:
  for p in json.load(sys.stdin)["projects"]:
    if p["status"]=="blocked": print(p["id"]+" "+p["name"])
except Exception: pass')"

[ -z "$blocked" ] && exit 0

while read -r id name; do
  [ -z "$id" ] && continue
  resp="$(curl -s -X POST "$API/projects/$id/unwedge" -H 'content-type: application/json' -d '{}')"
  read -r retried skipped <<<"$(printf '%s' "$resp" | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  print(len(d.get("retried") or []), len(d.get("skipped") or []))
except Exception: print(0,0)')"
  sig="$id:$retried:$skipped"
  if [ "${retried:-0}" -gt 0 ]; then
    log "unwedged $name: retried=$retried skipped=$skipped"
    notify "🔧 Watchdog: project \"$name\" was blocked by a failed run — auto-unwedged, $retried task(s) retrying."
  elif [ "${skipped:-0}" -gt 0 ]; then
    # Retry cap reached. Distinguish two very different worlds:
    #  (a) the cap was burned by a USAGE WALL that has since reset — the task
    #      never really failed, so force ONE retry. (2026-08-16: a project sat
    #      blocked for six days on an Aug-10 weekly-limit kill because the
    #      watchdog only ever notified here.)
    #  (b) a genuine failure — notify once, leave it for a human.
    wall="$(curl -s "$API/usage/quota" | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
  fh=d.get("five_hour") or {}; sd=d.get("seven_day") or {}
  u=[x for x in (fh.get("utilization"), sd.get("utilization")) if isinstance(x,(int,float))]
  # headroom in BOTH windows => any wall that killed this task is over
  print("clear" if u and max(u) < 90 else "wall")
except Exception: print("unknown")')"
    if [ "$wall" = "clear" ] && ! grep -qF "forced:$id" "$STATE"; then
      f="$(curl -s -X POST "$API/projects/$id/unwedge" -H 'content-type: application/json' -d '{"force":true}' |
        python3 -c 'import json,sys
try: print(len(json.load(sys.stdin).get("retried") or []))
except Exception: print(0)')"
      log "$name: cap burned but quota windows clear — forced retry of $f task(s)"
      notify "🔧 Watchdog: project \"$name\" was stuck at the retry cap from an earlier usage-limit kill. Quota has reset — force-retried $f task(s), work resumed."
      echo "forced:$id" >>"$STATE"
    elif ! grep -qF "$sig" "$STATE"; then
      log "$name stuck at retry cap (skipped=$skipped, quota=$wall) — notifying once"
      notify "🛑 Watchdog: project \"$name\" is blocked and its failed task(s) hit the retry cap — this looks like a REAL failure, not a transient. Needs you or the operator (unwedge with force, or read the failing run)."
      echo "$sig" >>"$STATE"
    fi
  else
    log "$name blocked, nothing retriable (resp: $(printf '%s' "$resp" | head -c 120))"
  fi
done <<<"$blocked"
