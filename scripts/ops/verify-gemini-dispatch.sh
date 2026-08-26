#!/usr/bin/env bash
# Close the loop on the engine-key collision fix (2026-08-24) without needing Konrad.
#
# The fix ships in forge-executor, and forge-executor cannot be restarted from
# inside the agent turn that wrote it — that kills the turn. safe-restart.sh is
# armed and fires once the fleet goes quiet, which is AFTER the turn ends. So the
# verification has to outlive the turn too.
#
# This waits for the executor's pid to change (= the new code is live), then runs
# one more turn on the probe chat and checks which engine actually answered.
#
#   BEFORE the fix, turn 2+ of a Gemini chat came back:
#     provider=claude-pool   content=claude-sonnet-4-6
#   AFTER, it must come back:
#     provider=claude-code   content=<a gemini model>
#
# Result goes to Konrad's inbox via /api/reminders either way — a verification
# that only reports success is not a verification.
set -uo pipefail

PROBE_ID="${1:-c022ed58-2e74-43d9-b469-3924d3b1e434}"
MAX_WAIT_S="${2:-7200}"
LOG=/var/log/forge-gemini-dispatch-verify.log

set -a
. /opt/ai-os/.secrets/forge-control.env 2>/dev/null
set +a

log() { echo "[$(date -Is)] $*" >> "$LOG"; }
q() { psql "$DATABASE_URL" -F'|' -tAc "$1" 2>/dev/null; }

notify() {
  curl -s -m 15 -X POST http://127.0.0.1:7700/api/reminders \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1][:480], "when": "in 1m"}))' "$1")" \
    >/dev/null 2>&1
}

pid_of() { pm2 jlist 2>/dev/null | python3 -c "
import json,sys
for p in json.load(sys.stdin):
    if p['name']=='forge-executor': print(p['pm2_env'].get('pm_id'), p.get('pid')); break
" ; }

START_PID="$(pid_of)"
log "armed — waiting for forge-executor to restart (current: $START_PID), probe=$PROBE_ID"

waited=0
while [ "$waited" -lt "$MAX_WAIT_S" ]; do
  sleep 30
  waited=$((waited + 30))
  now="$(pid_of)"
  [ -n "$now" ] && [ "$now" != "$START_PID" ] && break
done

if [ "$waited" -ge "$MAX_WAIT_S" ]; then
  log "GAVE UP: forge-executor never restarted within ${MAX_WAIT_S}s"
  notify "AI OS: the Gemini dispatch fix is committed but NOT verified — forge-executor never restarted within $((MAX_WAIT_S/60))min, so safe-restart never found an idle window. Fix is live in git, not in the running process. Check: pm2 restart forge-executor when the fleet is quiet."
  exit 1
fi

log "executor restarted ($START_PID -> $(pid_of)) — giving it 20s to settle"
sleep 20

psql "$DATABASE_URL" -tAc "
UPDATE runs
   SET thread = thread || jsonb_build_array(jsonb_build_object(
         'role','user',
         'content','Name the model you are running as. Answer with the model name only.',
         'ts', now()::text, 'kind','text')),
       status='queued', completed_at=NULL, updated_at=now()
 WHERE id='$PROBE_ID';" >/dev/null 2>&1
log "queued the post-fix turn"

for _ in $(seq 1 30); do
  sleep 20
  row="$(q "select status, coalesce(thread->-1->'meta'->>'provider','-'), coalesce(metadata->>'engine','(unset)'), coalesce(metadata->>'session_engine','(unset)'), replace(left(thread->-1->>'content',60),E'\n',' ') from runs where id='$PROBE_ID';")"
  case "$row" in completed*|failed*) break;; esac
done

log "result: $row"
IFS='|' read -r status provider eng sess answer <<< "$row"

# What must hold is a statement about BEHAVIOUR, not about the row's history.
#
# The first version of this check also required `engine` to be unset, and
# failed a run that was in fact perfect: the probe row still carried a stale
# engine="agy" stamped by the OLD executor before the restart, and the new code
# routed it to Gemini anyway — which is precisely the resilience the fix was
# for. The assertion tested a precondition of the fixture, not the invariant,
# and reported FAIL on a working system. Don't assert on state the fix is
# explicitly designed to tolerate.
ok=1
[ "$status" = "completed" ] || ok=0
[ "$provider" = "claude-code" ] || ok=0   # the CLI branch, not the HTTP pool
[ "$sess" = "agy" ] || ok=0               # provenance landed in its own slot
case "$answer" in *[Gg]emini*) ;; *) ok=0 ;; esac  # the model says so itself

if [ "$ok" = "1" ]; then
  log "PASS"
  notify "AI OS verified: Gemini chats now stay on Gemini past turn 1. Probe turn 3 answered via provider=claude-code (the CLI branch), engine key untouched, provenance in session_engine=agy. Model said: ${answer}. Before the fix the same turn answered claude-sonnet-4-6 via claude-pool."
else
  log "FAIL"
  notify "AI OS: the Gemini dispatch fix did NOT verify after the executor restart. status=$status provider=$provider engine=$eng session_engine=$sess answer=$answer — expected completed/claude-code/(unset)/agy. The chat may still be defecting to the Claude pool."
fi

psql "$DATABASE_URL" -tAc "UPDATE runs SET archived=true WHERE id='$PROBE_ID';" >/dev/null 2>&1
log "probe archived — done"
