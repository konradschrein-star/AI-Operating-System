#!/usr/bin/env bash
#
# await-and-seed.sh — seed a project task AFTER a condition it cannot be a
# pending row for. Phase 8D of engine-task-graph (R63–R68).
#
#   await-and-seed.sh executor-restart <payload.json> [--substitute KEY=VALUE]...
#   await-and-seed.sh project-done <uuid> <payload.json> [--substitute KEY=VALUE]...
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS — the deadlock a pending row would create.
#
# `/opt/ai-os/scripts/safe-restart.sh` waits for the WHOLE FLEET to be quiet
# (`SELECT count(*) FROM runs WHERE last_heartbeat_at > now() - interval '45
# seconds'`, two consecutive quiet polls 15s apart) before it touches the
# executor. The manager tick promotes any ready task of an active project within
# ~10 seconds of the previous round draining. So a verification task numbered
# above the deploy task would (a) run BEFORE the restart it exists to verify,
# against the OLD engine still resident in the executor's memory, and (b) hold a
# heartbeat for its whole duration and so DELAY the very restart it is verifying.
# The two facts compose into a task that can never do its job.
#
# The repair is not a bigger round number. It is to stop being a fleet run at
# all: this script is launched DETACHED by the deploy task, holds no heartbeat,
# appears in no `runs` row, and therefore cannot itself block the idle window.
# It fires only once the condition it waits on is OBSERVED TRUE, and only then
# does a task row exist.
#
#   setsid nohup /opt/forge-ai-os/scripts/deploy/await-and-seed.sh \
#     executor-restart /opt/forge-ai-os/scripts/deploy/payload-verify.json \
#     >> /tmp/forge-phase8-seed.log 2>&1 &
#
# The caller launches it exactly like that and ENDS. It never blocks its caller
# and its caller never polls it.
#
# ---------------------------------------------------------------------------
# WHAT IT IS NOT ALLOWED TO DO, and how you can see that from here.
#
# It reads `pm2 jlist` and speaks HTTP to 127.0.0.1:7700. That is the whole of
# its authority. It restarts nothing (R66 — the prohibited command does not
# appear in this file in any form, so `03-quality.md` §4's sweep still finds
# exactly its four known hits and a fifth would be a real signal), it edits no
# file in /opt/forge-ai-os, it issues no SQL and never opens `content_forge`,
# and it holds no lock. If it cannot establish the state it is waiting on, it
# waits; if it runs out of time, it reports and dies. IT NEVER SEEDS BLIND.
#
# ---------------------------------------------------------------------------
# TESTABILITY HOOKS — how `scripts/checks/check-await-seed.sh` drives this
# without a live fleet. Every one of them has a production default, and the
# defaults are what the deploy task gets by supplying none of them.
#
#   AWAIT_SEED_PM2_CMD   command that prints pm2's JSON   default: `pm2 jlist`
#   AWAIT_SEED_API       forge-control base URL           default: http://127.0.0.1:7700
#   AWAIT_SEED_POLL      seconds between polls            default: 30 (executor-restart)
#                                                                  60 (project-done)
#   AWAIT_SEED_TIMEOUT   seconds before giving up         default: 46800 (13h)
#   AWAIT_SEED_SERVICE   pm2 process name to watch        default: forge-executor
#
# AWAIT_SEED_POLL has two documented defaults because the two conditions change
# on different timescales: the executor restart lands within about a minute of
# the fleet going quiet and is worth catching promptly, while a whole project
# finishing is an hours-long wait that does not deserve 120 HTTP requests an
# hour. Setting AWAIT_SEED_POLL overrides both, which is what the check does.
#
# The 46800s ceiling is `safe-restart.sh`'s own 43200s maximum wait plus an hour
# of margin: if the fleet never goes quiet, safe-restart gives up at 43200s
# without restarting anything, and this script must outlive that decision in
# order to report it rather than racing it.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A SUCCESS WRONGLY — and why it cannot
# (standing rule 3, `00-vision.md` §7).
#
#   (a) IT FIRED ON A RESTART THAT PREDATES IT. A watcher that only checks
#       "status == online" fires immediately, because the executor is online
#       right now. Guarded by capturing `restart_time` and `pm_uptime` BEFORE
#       the first poll and requiring restart_time to have strictly INCREASED
#       past that captured value AND pm_uptime to be later than this script's
#       own launch. Both are recorded on the provenance line, so the transcript
#       shows what it compared against.
#   (b) IT SEEDED A PAYLOAD FULL OF PLACEHOLDERS. A `write_set` reading
#       `after-<a literal token>.md` would look plausible in the Kanban and be
#       worthless. Guarded by refusing any rendered payload that still carries a
#       `__TOKEN__`, before a single byte is POSTed.
#   (c) IT RAN TWICE AND FANNED OUT TWO AGENTS. Guarded by migration 0035's
#       identity `(project, round, role, title)`: the second POST answers 409
#       with the ORIGINAL task id, which this script treats as success and logs
#       as such. Re-running the watcher is therefore safe by construction.
#   (d) IT SEEDED INTO A CLOSED PROJECT AND NOTHING PROMOTED. `createTask()`
#       does not reactivate a project and `promoteReadyTasks()` carries
#       `AND p.status = 'active'`, so a row POSTed into a `done` project is a
#       row that never runs. Guarded by POSTing the reactivation FIRST and
#       reporting the outcome verbatim.
#   (e) IT DECIDED FROM UNREADABLE INPUT. A `pm2 jlist` that prints nothing, or
#       an HTTP call that fails, must not read as "condition not met yet" in a
#       way that silently becomes "condition met". Guarded because every reader
#       returns an explicit `unknown` token that the fire test rejects, the
#       reason is logged on every poll it happens, and an unreadable BASELINE at
#       launch is a hard error rather than a zero.
#
# Exit: 0 = the task was seeded (201) or already existed (409).
#       1 = a hard error: unusable payload, unreadable baseline, a POST that
#           failed. Nothing was seeded, or the seeding is reported as partial.
#       2 = timed out. Nothing was seeded. The manager chat was told.
#
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"

# The project this script seeds INTO. Constant: this watcher exists for phase 8
# of engine-task-graph and seeds nowhere else. It is deliberately not an
# argument — an id typed at launch time is an id that can be typed wrong at
# 04:00, and the failure would be a task row in a stranger's project.
SEED_PROJECT="8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4"
# The manager chat run. Every terminal condition that seeds nothing reports here
# (see MANAGER COMMS in every brief of this project).
MANAGER_RUN="bfd1283a-b71b-4f35-b577-7d09aad803f2"

PM2_CMD="${AWAIT_SEED_PM2_CMD:-pm2 jlist}"
API="${AWAIT_SEED_API:-http://127.0.0.1:7700}"
TIMEOUT="${AWAIT_SEED_TIMEOUT:-46800}"
SERVICE="${AWAIT_SEED_SERVICE:-forge-executor}"

log() { printf '[%s] await-and-seed: %s\n' "$(date -Is)" "$*"; }

# ---------------------------------------------------------------------------
# Argument parsing. Every unrecognised form is a hard error with the usage
# printed — this script is launched once, unattended, by a task that has already
# ended, so a mis-typed flag that was quietly ignored would surface thirteen
# hours later as "nothing happened".
# ---------------------------------------------------------------------------
usage() {
  cat >&2 <<'USAGE'
usage:
  await-and-seed.sh executor-restart <payload.json> [--substitute KEY=VALUE]...
  await-and-seed.sh project-done <uuid> <payload.json> [--substitute KEY=VALUE]...
USAGE
}

die() {  # message...  — a hard error that seeds nothing.
  log "HARD ERROR: $*"
  exit 1
}

MODE="${1:-}"
[ -n "$MODE" ] || { usage; exit 1; }
shift

WATCH_PROJECT=""
case "$MODE" in
  executor-restart)
    PAYLOAD="${1:-}"
    [ -n "$PAYLOAD" ] || { usage; exit 1; }
    shift
    POLL="${AWAIT_SEED_POLL:-30}"
    ;;
  project-done)
    WATCH_PROJECT="${1:-}"
    PAYLOAD="${2:-}"
    [ -n "$WATCH_PROJECT" ] && [ -n "$PAYLOAD" ] || { usage; exit 1; }
    shift 2
    POLL="${AWAIT_SEED_POLL:-60}"
    ;;
  *)
    usage
    die "unknown mode '$MODE' — expected executor-restart or project-done"
    ;;
esac

SUBS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --substitute)
      [ $# -ge 2 ] || { usage; die "--substitute needs KEY=VALUE"; }
      SUBS+=("$2")
      shift 2
      ;;
    *)
      usage
      die "unexpected argument '$1'"
      ;;
  esac
done

[ -f "$PAYLOAD" ] || die "no payload at $PAYLOAD"

# ---------------------------------------------------------------------------
# Render the payload ONCE, at launch, and hold the rendered bytes. Substitution
# is a literal string replacement done in python3 rather than sed, because a
# VALUE containing `/` or `&` changes what sed means and a project id is exactly
# the kind of value nobody inspects before pasting.
# ---------------------------------------------------------------------------
render_payload() {
  python3 - "$PAYLOAD" ${SUBS[@]+"${SUBS[@]}"} <<'PY'
import json, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    text = fh.read()

for pair in sys.argv[2:]:
    if "=" not in pair:
        sys.stderr.write("substitution %r is not KEY=VALUE\n" % pair)
        sys.exit(2)
    key, value = pair.split("=", 1)
    if not key:
        sys.stderr.write("substitution %r has an empty KEY\n" % pair)
        sys.exit(2)
    if key not in text:
        # Not fatal, and said out loud: a substitution whose key is absent means
        # either the payload changed or the launch line did, and both are worth
        # a line in the log. It is not an error because a caller may reasonably
        # pass the same flag set to two payloads.
        sys.stderr.write("note: substitution key %s does not occur in %s\n" % (key, path))
    text = text.replace(key, value)

try:
    json.loads(text)
except Exception as exc:  # noqa: BLE001 — the message is the whole point
    sys.stderr.write("rendered payload is not valid JSON: %s\n" % exc)
    sys.exit(3)

sys.stdout.write(text)
PY
}

BODY="$(render_payload)" || die "could not render $PAYLOAD (see the python3 diagnostics above)"

# ---------------------------------------------------------------------------
# THE TOKEN GUARD. A rendered payload that still carries `__SOMETHING__` is a
# payload whose launch line and whose author disagree, and seeding it produces a
# task whose write_set names a placeholder file.
#
# It runs at LAUNCH, over the rendered bytes — which are the exact bytes that
# will be POSTed hours later — and again immediately before the POST. Failing at
# launch is strictly stronger than failing "at POST time" as the brief words it:
# the same payload is refused, nothing is seeded either way, and the operator
# hears about it now instead of after the wait. The pre-POST call is the belt:
# it is the same function over the same string, so no future edit that mutates
# $BODY between launch and fire can slip past.
#
# CONSEQUENCE FOR PAYLOAD AUTHORS, and it is not obvious: a payload whose BRIEF
# quotes an await-and-seed launch line cannot spell the token contiguously — the
# guard cannot tell a token meant for substitution from a token quoted inside
# prose, and it must not try, because "it looked like documentation" is exactly
# how a placeholder reaches production. Both payloads in this directory that
# quote a launch line build the token with `printf '__%s__' NAME` instead, and
# say why at the site.
# ---------------------------------------------------------------------------
assert_no_unsubstituted_tokens() {  # where
  local where="$1" found
  found="$(printf '%s' "$BODY" | grep -o '__[A-Za-z0-9_]\+__' | sort -u | tr '\n' ' ')" || true
  if [ -n "${found// /}" ]; then
    log "HARD ERROR ($where): the rendered payload still carries unsubstituted token(s): $found"
    log "  payload      : $PAYLOAD"
    log "  substitutions: ${SUBS[*]-none}"
    log "  seeding NOTHING."
    notify_manager "await-and-seed.sh REFUSED to seed $(basename "$PAYLOAD"): it still contains unsubstituted token(s) $found after substitutions [${SUBS[*]-none}]. Nothing was seeded. Phase 8's next task will not exist until this is relaunched with the right --substitute flags."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# HTTP. One helper, because every call in this script wants the same three
# things: the status code, the body, and no silent failure.
# `curl --fail` is deliberately NOT used — a 409 is a success here and --fail
# would turn it into an exit code the caller has to un-interpret.
# ---------------------------------------------------------------------------
HTTP_CODE=""
HTTP_BODY=""
http_post() {  # url json-body → sets HTTP_CODE / HTTP_BODY, returns curl's rc
  local url="$1" body="$2" tmp rc
  tmp="$(mktemp)"
  HTTP_CODE="$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X POST "$url" -H 'content-type: application/json' --data-binary "$body")" && rc=0 || rc=$?
  HTTP_BODY="$(cat "$tmp")"
  rm -f "$tmp"
  return $rc
}

http_get() {  # url → sets HTTP_CODE / HTTP_BODY
  local url="$1" tmp rc
  tmp="$(mktemp)"
  HTTP_CODE="$(curl -sS -o "$tmp" -w '%{http_code}' "$url")" && rc=0 || rc=$?
  HTTP_BODY="$(cat "$tmp")"
  rm -f "$tmp"
  return $rc
}

notify_manager() {  # text — best effort, never changes the exit path
  local text="$1" json
  json="$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "from": "worker"}))' "$text")"
  if http_post "$API/api/runs/$MANAGER_RUN/message" "$json"; then
    log "manager chat notified (HTTP $HTTP_CODE)"
  else
    log "WARNING: could not reach the manager chat at $API/api/runs/$MANAGER_RUN/message — the message above is only in this log"
  fi
}

# ---------------------------------------------------------------------------
# pm2 reader. `jq` is not guaranteed on this box; python3 is. Prints three
# space-separated fields — restart_time pm_uptime status — or the single token
# `unknown` with the reason on stderr. It NEVER prints a zero for a value it
# could not read: a zero would compare successfully against a baseline.
# ---------------------------------------------------------------------------
read_pm2() {
  # `|| true` inside the group, not after the pipeline: `set -o pipefail` would
  # otherwise make a failing `pm2` abort the whole watcher through `set -e`,
  # turning "pm2 hiccuped for one poll" into "the verification task never
  # exists". The reader's contract is to answer `unknown`, and that is what an
  # unreadable pm2 must produce here too.
  # shellcheck disable=SC2086 — PM2_CMD is a command line by contract (see the
  # AWAIT_SEED_PM2_CMD hook above), and word-splitting it is the point.
  { $PM2_CMD 2>/dev/null || true; } | python3 -c '
import json, sys

name = sys.argv[1]
raw = sys.stdin.read()
if not raw.strip():
    sys.stderr.write("pm2 produced no output\n")
    print("unknown"); raise SystemExit(0)
try:
    procs = json.loads(raw)
except Exception as exc:
    sys.stderr.write("pm2 output is not JSON: %s\n" % exc)
    print("unknown"); raise SystemExit(0)
if not isinstance(procs, list):
    sys.stderr.write("pm2 output is not a list\n")
    print("unknown"); raise SystemExit(0)

for proc in procs:
    if not isinstance(proc, dict) or proc.get("name") != name:
        continue
    env = proc.get("pm2_env") or {}
    restart = env.get("restart_time")
    uptime = env.get("pm_uptime")
    status = env.get("status")
    if not isinstance(restart, int) or not isinstance(uptime, int) or not isinstance(status, str):
        sys.stderr.write(
            "pm2 entry for %s is missing restart_time/pm_uptime/status (%r %r %r)\n"
            % (name, restart, uptime, status)
        )
        print("unknown"); raise SystemExit(0)
    print("%d %d %s" % (restart, uptime, status))
    raise SystemExit(0)

sys.stderr.write("no pm2 process named %s\n" % name)
print("unknown")
' "$SERVICE"
}

# ---------------------------------------------------------------------------
# Baseline capture + the provenance line. Both happen before the first poll, and
# the provenance line carries the baseline, because a transcript that does not
# say what the watcher compared against cannot be audited (standing rule 3).
# ---------------------------------------------------------------------------
LAUNCH_ISO="$(date -Is)"
LAUNCH_EPOCH="$(date +%s)"
LAUNCH_MS=$((LAUNCH_EPOCH * 1000))
SELF_SHA="$(sha256sum "$SCRIPT_PATH" | cut -d' ' -f1)"
GIT_HEAD="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'no-git')"

BASE_RESTART=""
BASE_UPTIME=""
BASE_STATUS=""
BASELINE_DESC=""

case "$MODE" in
  executor-restart)
    PM2_LINE="$(read_pm2)"
    if [ "$PM2_LINE" = "unknown" ] || [ -z "$PM2_LINE" ]; then
      # Hard error, NOT a zero baseline. A baseline of 0 would be beaten by the
      # executor's current restart_time on the very first poll, and the watcher
      # would fire on a restart that happened last week.
      log "provenance head=$GIT_HEAD self-sha256=$SELF_SHA mode=$MODE payload=$PAYLOAD launched=$LAUNCH_ISO baseline=UNREADABLE"
      die "could not read $SERVICE from '$PM2_CMD' at launch — refusing to watch with no baseline (see stderr above)"
    fi
    read -r BASE_RESTART BASE_UPTIME BASE_STATUS <<<"$PM2_LINE"
    BASELINE_DESC="restart_time=$BASE_RESTART pm_uptime=$BASE_UPTIME status=$BASE_STATUS service=$SERVICE"
    ;;
  project-done)
    if http_get "$API/api/projects/$WATCH_PROJECT" && [ "$HTTP_CODE" = "200" ]; then
      BASE_STATUS="$(printf '%s' "$HTTP_BODY" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("project") or {}).get("status") or "unknown")' 2>/dev/null || echo unknown)"
    else
      BASE_STATUS="unreadable(HTTP ${HTTP_CODE:-none})"
    fi
    BASELINE_DESC="project=$WATCH_PROJECT status=$BASE_STATUS"
    ;;
esac

log "provenance head=$GIT_HEAD self-sha256=$SELF_SHA mode=$MODE payload=$PAYLOAD launched=$LAUNCH_ISO baseline=[$BASELINE_DESC] poll=${POLL}s timeout=${TIMEOUT}s api=$API"
log "substitutions: ${SUBS[*]-none}"

assert_no_unsubstituted_tokens "at launch"

# `project-done` on an already-`done` project is a legitimate relaunch, not an
# error: 0035's identity makes the seeding idempotent, so firing immediately is
# the correct behaviour and is announced rather than hidden.
[ "$MODE" = "project-done" ] && [ "$BASE_STATUS" = "done" ] && \
  log "NOTE: $WATCH_PROJECT is ALREADY done at launch — this is a relaunch; the first poll will fire and the POST is idempotent (409)"

# ---------------------------------------------------------------------------
# The fire tests. Each returns 0 (fire), 1 (not yet) and logs its reason.
# ---------------------------------------------------------------------------
ready_executor_restart() {
  local line restart uptime status
  line="$(read_pm2)"
  if [ "$line" = "unknown" ] || [ -z "$line" ]; then
    log "poll: $SERVICE unreadable from '$PM2_CMD' — not firing"
    return 1
  fi
  read -r restart uptime status <<<"$line"
  if [ "$restart" -le "$BASE_RESTART" ]; then
    log "poll: restart_time=$restart has not passed the baseline $BASE_RESTART (status=$status) — not firing"
    return 1
  fi
  if [ "$status" != "online" ]; then
    log "poll: restart_time=$restart > $BASE_RESTART but status='$status' is not online — not firing"
    return 1
  fi
  if [ "$uptime" -le "$LAUNCH_MS" ]; then
    log "poll: restart_time=$restart and status=online, but pm_uptime=$uptime is not later than launch $LAUNCH_MS — not firing"
    return 1
  fi
  log "FIRE: $SERVICE restarted — restart_time $BASE_RESTART -> $restart, status=$status, pm_uptime=$uptime (launch $LAUNCH_MS)"
  return 0
}

ready_project_done() {
  local status
  if ! http_get "$API/api/projects/$WATCH_PROJECT"; then
    log "poll: GET /api/projects/$WATCH_PROJECT failed (curl error) — not firing"
    return 1
  fi
  if [ "$HTTP_CODE" != "200" ]; then
    log "poll: GET /api/projects/$WATCH_PROJECT answered HTTP $HTTP_CODE — not firing. body: $(printf '%s' "$HTTP_BODY" | head -c 300)"
    return 1
  fi
  status="$(printf '%s' "$HTTP_BODY" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("project") or {}).get("status") or "")' 2>/dev/null || echo "")"
  if [ -z "$status" ]; then
    log "poll: the /api/projects response carried no project.status — not firing. body: $(printf '%s' "$HTTP_BODY" | head -c 300)"
    return 1
  fi
  if [ "$status" != "done" ]; then
    log "poll: project $WATCH_PROJECT is '$status', not 'done' — not firing"
    return 1
  fi
  log "FIRE: project $WATCH_PROJECT reached status=done"
  return 0
}

# ---------------------------------------------------------------------------
# The seeding. Reactivate first, then POST the task. The order is load-bearing
# and is (d) above.
# ---------------------------------------------------------------------------
seed() {
  local rc=0
  assert_no_unsubstituted_tokens "before POST"

  log "POST $API/api/projects/$SEED_PROJECT/status {\"status\":\"active\"}"
  if http_post "$API/api/projects/$SEED_PROJECT/status" '{"status":"active"}' && [ "$HTTP_CODE" = "200" ]; then
    log "  reactivated: HTTP $HTTP_CODE"
  else
    # NOT fatal, and NOT silent. The task POST still goes out: a task row that
    # exists but does not promote is visible in the Kanban and recoverable with
    # one curl, whereas no row at all is invisible and phase 8 simply stops. The
    # failure is reported verbatim and the exit code carries it.
    log "  WARNING: reactivation answered HTTP ${HTTP_CODE:-curl-error}: $HTTP_BODY"
    log "  continuing to the task POST anyway; the task may sit un-promoted until the project is reactivated by hand"
    notify_manager "await-and-seed.sh: reactivating project $SEED_PROJECT answered HTTP ${HTTP_CODE:-curl-error} ($HTTP_BODY). The task POST follows, but promoteReadyTasks() carries AND p.status = 'active' — if the project is not active the seeded task will not promote."
    rc=1
  fi

  log "POST $API/api/projects/$SEED_PROJECT/tasks  <- $(basename "$PAYLOAD")"
  if ! http_post "$API/api/projects/$SEED_PROJECT/tasks" "$BODY"; then
    log "  HARD ERROR: curl could not reach $API — nothing was seeded"
    notify_manager "await-and-seed.sh could not reach $API to seed $(basename "$PAYLOAD"). Nothing was seeded; phase 8's next task does not exist."
    return 1
  fi
  case "$HTTP_CODE" in
    201)
      log "  SEEDED: HTTP 201 — $(printf '%s' "$HTTP_BODY" | head -c 400)"
      ;;
    409)
      # SUCCESS. Migration 0035's identity (project, round, role, title) already
      # holds a row, and the response carries that ORIGINAL task. Re-running this
      # watcher therefore cannot fan out a duplicate agent — which is the whole
      # reason a relaunch is a safe operator move.
      log "  ALREADY SEEDED (409 treated as SUCCESS — identity (project, round, role, title) already exists, migration 0035): $(printf '%s' "$HTTP_BODY" | head -c 400)"
      ;;
    *)
      log "  HARD ERROR: task POST answered HTTP $HTTP_CODE: $HTTP_BODY"
      notify_manager "await-and-seed.sh failed to seed $(basename "$PAYLOAD"): HTTP $HTTP_CODE — $HTTP_BODY. Phase 8's next task does not exist."
      return 1
      ;;
  esac
  return $rc
}

# ---------------------------------------------------------------------------
# The wait loop.
# ---------------------------------------------------------------------------
WAITING_FOR="$MODE"
[ "$MODE" = "executor-restart" ] && WAITING_FOR="$SERVICE to restart past restart_time=$BASE_RESTART and come back online"
[ "$MODE" = "project-done" ] && WAITING_FOR="project $WATCH_PROJECT to reach status=done"

log "waiting for: $WAITING_FOR"

while :; do
  if [ "$MODE" = "executor-restart" ]; then
    ready_executor_restart && break || true
  else
    ready_project_done && break || true
  fi

  ELAPSED=$(( $(date +%s) - LAUNCH_EPOCH ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    log "TIMEOUT after ${ELAPSED}s (ceiling ${TIMEOUT}s) — waiting for: $WAITING_FOR. SEEDING NOTHING."
    notify_manager "await-and-seed.sh TIMED OUT after ${ELAPSED}s waiting for $WAITING_FOR (baseline at launch: $BASELINE_DESC). It seeded NOTHING — $(basename "$PAYLOAD") was never POSTed, so phase 8's next task does not exist and nobody is waiting on it. Launched $LAUNCH_ISO from $GIT_HEAD, self-sha256 $SELF_SHA."
    exit 2
  fi
  sleep "$POLL"
done

if seed; then
  log "done — exit 0"
  exit 0
fi
log "done with errors — exit 1"
exit 1
