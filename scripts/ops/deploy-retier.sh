#!/usr/bin/env bash
# One-shot (2026-08-05 morning): restart forge-executor when idle so the new
# tier map (junior/standard→Opus 5, flagship→Fable 5) + role-file pins load,
# then seed the two daytime goal projects. Detached via setsid; safe to
# delete after the cycle.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
LOG=/var/log/forge-goal-mode-deploy.log

notify() {
  curl -sX POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"),\"when\":\"in 1m\"}" \
    >>"$LOG" 2>&1
}

seed() { # $1 = json path, prints project id or empty
  curl -s -X POST http://127.0.0.1:7700/api/projects \
    -H 'content-type: application/json' -d @"$1" |
    python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d["project"]["id"]); sys.stderr.write(str(d.get("warning") or ""))
except Exception as e: sys.stderr.write(str(e))'
}

{
  echo "[$(date -Is)] retier deploy: waiting for executor idle"
  /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45
  rc=$?
  echo "[$(date -Is)] safe-restart rc=$rc"
  if [ "$rc" -ne 0 ]; then
    notify "⚠️ Retier deploy: forge-executor restart didn't happen (rc=$rc). New model tiers NOT live, daytime projects NOT seeded. Rerun /opt/ai-os/scripts/deploy-retier.sh."
    exit "$rc"
  fi
  sleep 10
  p1="$(seed /opt/ai-os/scripts/goal-operator-visibility.json)"
  p2="$(seed /opt/ai-os/scripts/goal-engine-v2.json)"
  echo "[$(date -Is)] seeded: operator-visibility=$p1 engine-v2=$p2"
  if [ -n "$p1" ] && [ -n "$p2" ]; then
    notify "🚀 Retier live (junior=Sonnet 5, standard=Opus 5, flagship=Fable 5) and two goals seeded: operator-visibility ($p1) and engine-v2-research-lane ($p2). Heartbeats every 2h."
  else
    notify "⚠️ Retier live but seeding partly failed (visibility='$p1', engine='$p2') — check /var/log/forge-goal-mode-deploy.log."
  fi
} >>"$LOG" 2>&1
