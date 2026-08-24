#!/usr/bin/env bash
# One-shot deploy for goal mode (2026-08-05): wait for the executor to go
# idle, restart it so the new project-tick code loads, then seed the
# overnight test goal. Runs detached (setsid) so it survives the very
# restart it performs. Safe to delete after the night.
set -uo pipefail
export PATH="/usr/bin:/usr/local/bin:$PATH"
LOG=/var/log/forge-goal-mode-deploy.log
SEED=/opt/ai-os/scripts/goal-files-pane.json

notify() {
  curl -sX POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"),\"when\":\"in 1m\"}" \
    >>"$LOG" 2>&1
}

{
  echo "[$(date -Is)] goal-mode deploy starting — waiting for executor idle"
  /opt/ai-os/scripts/safe-restart.sh forge-executor 14400 45
  rc=$?
  echo "[$(date -Is)] safe-restart exited rc=$rc"
  if [ "$rc" -ne 0 ]; then
    notify "⚠️ Goal-mode deploy: forge-executor restart did not happen (rc=$rc). New tick code is NOT live and the overnight goal was NOT seeded. Run /opt/ai-os/scripts/deploy-goal-mode.sh again."
    exit "$rc"
  fi
  sleep 10
  resp="$(curl -s -X POST http://127.0.0.1:7700/api/projects \
    -H 'content-type: application/json' -d @"$SEED")"
  echo "[$(date -Is)] seed response: $resp"
  pid="$(printf '%s' "$resp" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["project"]["id"])
except Exception: print("")')"
  if [ -n "$pid" ]; then
    notify "🚀 Goal mode is live. Overnight goal seeded: files-pane-fast-light ($pid) — Files pane speed + light mode, flagship architect, heartbeats every 2h. Watch it on the Kanban board."
  else
    notify "⚠️ Goal-mode deploy: executor restarted fine but seeding the overnight goal failed. Response: $resp"
  fi
} >>"$LOG" 2>&1
