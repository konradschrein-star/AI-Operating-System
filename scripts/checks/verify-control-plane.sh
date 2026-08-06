#!/usr/bin/env bash
#
# verify-control-plane.sh — the one command that proves the manager control
# plane (contract §1/§2/§2b/§3/§4; docs/plan/06-control-plane-requirements.md;
# docs/plan/07-control-plane-architecture.md §4/§8; docs/plan/08-control-plane-
# quality.md §3b/§6) works end to end against a LIVE forge-control.
#
# WHAT IT PROVES. It exercises, against a real running server, the verbs the
# contract's announcement table (05-control-plane-boundary.md D3, "AI OS/
# Contract - Manager Control Plane API.md") tracks:
#
#   endpoint | capabilities flag to flip | shipped on (branch/round) | proof (command + observed response) | flipped?
#
# A clean run of this script IS the "proof" column's content for the rows:
#   POST /api/runs/:id/message              -> control_plane.message_into_session*
#   POST /api/runs/:id/resume-chat          -> control_plane.resume_finished
#   POST /api/runs/:parentId/subagent-message -> control_plane.subagent_message†
#   POST /api/runs/:id/stop                 -> control_plane.stop
#   POST /api/runs/:id/terminate            -> control_plane.terminate
#   GET  /api/runs/:id/comms                -> (additive extension, no flag of its own)
# (* message_into_session's RUNNING-target half is gated separately — see
# --running below and 07 §8's executor-restart matrix.
# † subagent_message has no flag to flip yet — CAPABILITIES.control_plane on
# main is missing it (05-control-plane-boundary.md "Defect to record, not to
# fix"); that is their bug to fix, not ours, and this script does not invent
# one. Its RUNNING-parent relay half carries the same executor-restart
# caveat as message -> RUNNING target (07 §8); the honest-refusal halves that
# ARE fully provable against a scratch run are steps 8 and 9 below.)
#
# It is NOT run as part of any build phase — running it here would violate
# this project's worktree-only policy (docs/plan/05-control-plane-boundary.md;
# the CP1 task brief). CP4's deploy task, or Konrad by hand, runs it against
# the live server and pastes its full stdout transcript verbatim into
# docs/plan/evidence/cp4-deploy.md — that paste is the deploy phase's proof
# artifact and the source for the announcement table's "proof" column.
#
# WHAT IT DOES. It never touches a real run. It creates its own disposable
# scratch runs via POST /api/chat (budget_usd:0, a harmless no-op prompt) and
# drives them through message -> stop -> message -> terminate -> message, plus
# (step 6b) a message into a run the live executor actually finished, which is
# the only way to prove the requeue clears `completed_at` (R906); (step 8)
# resume-chat on that same now-cancelled run, in place, then the queued-target
# refusal naming /message; and (step 9) subagent-message's honest-refusal
# paths (unaddressable id, empty id) against a fresh scratch run that has
# never spawned a sub-agent — asserting the HTTP status code and response
# body the contract promises at every step, then best-effort terminates
# whatever scratch runs are left before it exits. Because these are real rows
# in a live `runs` table, the live executor's own claim loop may pick one up
# and run it for real before this script gets to stop/terminate it
# (budget_usd:0 does not prevent a claim) — that is an accepted, documented
# cost of proving this live rather than in the worktree, not a script bug.
#
# USAGE
#   scripts/checks/verify-control-plane.sh            # message/resume-chat/subagent-message/stop/terminate/comms
#   scripts/checks/verify-control-plane.sh --running   # also exercises message-into-RUNNING
#   FORGE_URL=http://127.0.0.1:7700 scripts/checks/verify-control-plane.sh
#
# --running documents and exercises the message-into-a-RUNNING-target path
# (07 §8's restart matrix: "message -> RUNNING target" is only fully live
# once the DETACHED forge-executor restart has landed). Before that restart,
# a failure in the --running section is EXPECTED and is printed as such
# ("[EXPECTED PRE-RESTART]") rather than being reported as a control-plane
# defect — but per this script's no-silent-skip rule it is still counted in
# the final tally, so the transcript never quietly claims more than it saw.
#
# EXIT STATUS: 0 iff every check passed. Non-zero otherwise, with the failed
# step numbers named in the final summary line. A step that cannot even be
# attempted (e.g. the initial run-id extraction fails) prints why and counts
# as a failed step — nothing here is a silent skip.

set -euo pipefail

BASE="${FORGE_URL:-http://127.0.0.1:7700}"
RUNNING_MODE=0

for arg in "$@"; do
  case "$arg" in
    --running)
      RUNNING_MODE=1
      ;;
    -h|--help)
      sed -n '/^# USAGE/,/^# EXIT STATUS/p' "$0"
      exit 0
      ;;
    *)
      echo "verify-control-plane.sh: unknown argument '$arg' (see --help)" >&2
      exit 2
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "verify-control-plane.sh: curl not found on PATH - cannot run" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "verify-control-plane.sh: jq not found on PATH - cannot run" >&2
  exit 2
fi

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

STEP_TOTAL=0
STEP_PASSED=0
FAILED_STEPS=()      # "N: description"
CURRENT_STEP=""
STEP_FAILS=()

# Scratch runs created along the way, terminated best-effort on exit.
CREATED_RUNS=()

# Out-parameters. create_scratch_run / run_status / run_completed_at return
# their value HERE, not on stdout, because they call http() and http() writes
# the whole pasteable transcript to stdout by design. A caller using
# `id="$(create_scratch_run …)"` captures that transcript along with the value
# (round 1202 shipped exactly that bug: RUN_A became a ~1.9 KB blob, every
# later URL was malformed, and all 10 steps failed with HTTP_CODE=000 without
# a single control-plane endpoint being reached). Out-parameters keep the
# transcript whole and on stdout, which the header promises, and keep the
# value clean.
SCRATCH_RUN_ID=""
RUN_STATUS=""
RUN_COMPLETED_AT=""

cleanup() {
  local rc=$?
  for id in "${CREATED_RUNS[@]:-}"; do
    if [ -n "$id" ]; then
      curl -sS -o /dev/null -X POST "$BASE/api/runs/$id/terminate" >/dev/null 2>&1 || true
    fi
  done
  exit "$rc"
}
trap cleanup EXIT

step_start() {
  STEP_TOTAL=$((STEP_TOTAL + 1))
  CURRENT_STEP="$1"
  STEP_FAILS=()
  echo
  echo "=== step $1: $2 ==="
}

# All step_assert_* helpers ALWAYS return 0 — they record failures into
# STEP_FAILS rather than signalling failure through their own exit status, so
# they are safe to call as bare statements under `set -e` (no dependence on
# being wrapped in `if`, and no `$(cmd; echo $?)`-style subshell, which would
# itself abort under `set -e` before the echo ever ran).

step_assert_code() {   # step_assert_code <expected-http-code> <label>
  if [ "$HTTP_CODE" != "$1" ]; then
    STEP_FAILS+=("$2: expected HTTP $1, got $HTTP_CODE")
  fi
  return 0
}

step_assert_jq() {     # step_assert_jq <jq-boolean-filter> <body> <label>
  if ! printf '%s' "$2" | jq -e "$1" >/dev/null 2>&1; then
    STEP_FAILS+=("$3: jq filter [$1] did not hold for body: $2")
  fi
  return 0
}

step_assert_eq() {     # step_assert_eq <actual> <expected> <label>
  if [ "$1" != "$2" ]; then
    STEP_FAILS+=("$3: expected '$2', got '$1'")
  fi
  return 0
}

step_assert_nonempty() {  # step_assert_nonempty <value> <label>
  if [ -z "$1" ]; then
    STEP_FAILS+=("$2: expected a non-empty value, got empty")
  fi
  return 0
}

step_finish() {
  # step_finish ["expected-pre-restart"] — optional tag prefixes failures so
  # the deploy transcript can tell "known 07 §8 gap" from "control-plane bug"
  # without hiding the failure from the tally (no silent skips).
  local tag="${1:-}"
  if [ "${#STEP_FAILS[@]}" -eq 0 ]; then
    STEP_PASSED=$((STEP_PASSED + 1))
    echo "${GREEN}PASS${RESET} step $CURRENT_STEP"
    return 0
  fi
  local prefix=""
  if [ "$tag" = "expected-pre-restart" ]; then
    prefix="[EXPECTED PRE-RESTART] "
  fi
  local reason=""
  for f in "${STEP_FAILS[@]}"; do
    reason="${reason}${f}; "
  done
  echo "${RED}FAIL${RESET} step $CURRENT_STEP: ${prefix}${reason}" >&2
  FAILED_STEPS+=("$CURRENT_STEP: ${prefix}${reason}")
  return 0
}

# http METHOD PATH [JSON_BODY]
# Sets HTTP_CODE and HTTP_BODY. Echoes the exact curl invocation and the
# verbatim response so the transcript can be pasted straight into
# docs/plan/evidence/cp4-deploy.md. Never trips `set -e` on a non-2xx
# response or a connection failure — HTTP_CODE becomes "000" and the caller's
# own assertions are what fail the step.
http() {
  local method="$1" path="$2" data="${3-}"
  local url="$BASE$path"
  local out err
  out="$(mktemp)"
  err="$(mktemp)"
  if [ -n "$data" ]; then
    echo "\$ curl -sS -X $method '$url' -H 'content-type: application/json' -d '$data'"
    HTTP_CODE="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" \
      -H 'content-type: application/json' -d "$data" 2>"$err")" || HTTP_CODE="000"
  else
    echo "\$ curl -sS -X $method '$url'"
    HTTP_CODE="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$url" 2>"$err")" || HTTP_CODE="000"
  fi
  HTTP_BODY="$(cat "$out")"
  if [ "$HTTP_CODE" = "000" ]; then
    echo "  -> connection failed: $(cat "$err")"
  else
    echo "  -> HTTP $HTTP_CODE"
    echo "$HTTP_BODY" | (jq . 2>/dev/null || cat)
  fi
  rm -f "$out" "$err"
  return 0
}

# jq_field <jq-filter> <body> -> prints the field via `<filter> // empty`, so
# a missing/null field prints nothing (never the literal text "null").
jq_field() {
  printf '%s' "$2" | jq -r "($1) // empty" 2>/dev/null || true
}

create_scratch_run() {
  # create_scratch_run <title-suffix> -> sets SCRATCH_RUN_ID, returns 0/1.
  # NEVER print the id on stdout — see the out-parameter comment above.
  local title="control-plane verify - $1"
  local body id
  SCRATCH_RUN_ID=""
  body="$(jq -n --arg title "$title" '{
    title: $title,
    prompt: "Automated control-plane verification scratch run (scripts/checks/verify-control-plane.sh). Take no action; reply \"ack\" and stop.",
    budget_usd: 0,
    metadata: { verify_control_plane: true }
  }')"
  http POST "/api/chat" "$body"
  if [ "$HTTP_CODE" != "201" ]; then
    echo "  cannot create scratch run '$1': expected HTTP 201, got $HTTP_CODE" >&2
    return 1
  fi
  id="$(jq_field '.run.id' "$HTTP_BODY")"
  if [ -z "$id" ]; then
    echo "  cannot create scratch run '$1': no .run.id in response body" >&2
    return 1
  fi
  CREATED_RUNS+=("$id")
  SCRATCH_RUN_ID="$id"
  return 0
}

run_status() {
  # run_status <id> -> sets RUN_STATUS, empty on any failure.
  RUN_STATUS=""
  http GET "/api/chat/$1"
  if [ "$HTTP_CODE" = "200" ]; then
    RUN_STATUS="$(jq_field '.run.status' "$HTTP_BODY")"
  fi
  return 0
}

run_completed_at() {
  # run_completed_at <id> -> sets RUN_COMPLETED_AT, empty if null/absent.
  RUN_COMPLETED_AT=""
  http GET "/api/chat/$1"
  if [ "$HTTP_CODE" = "200" ]; then
    RUN_COMPLETED_AT="$(jq_field '.run.completed_at' "$HTTP_BODY")"
  fi
  return 0
}

echo "verify-control-plane.sh - proving the manager control plane against $BASE"
echo "(contract: /opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md §1/§3/§4)"

# --------------------------------------------------------------------------
# Setup: two scratch runs. runA is the message/stop/terminate target for
# steps 1, 3-6. runB exists only to be the SENDER in step 2 (C3: an echo
# must never change the sender's own status).
# --------------------------------------------------------------------------

echo
echo "--- setup: creating scratch runs ---"

RUN_A=""
RUN_B=""
if ! create_scratch_run "target"; then
  echo "${RED}setup failed: could not create target scratch run${RESET}" >&2
  FAILED_STEPS+=("setup: could not create target scratch run")
  STEP_TOTAL=$((STEP_TOTAL + 1))
else
  RUN_A="$SCRATCH_RUN_ID"
  echo "  target run id: $RUN_A"
fi
if ! create_scratch_run "sender"; then
  echo "${RED}setup failed: could not create sender scratch run${RESET}" >&2
  FAILED_STEPS+=("setup: could not create sender scratch run")
  STEP_TOTAL=$((STEP_TOTAL + 1))
else
  RUN_B="$SCRATCH_RUN_ID"
  echo "  sender run id: $RUN_B"
fi

if [ -z "$RUN_A" ] || [ -z "$RUN_B" ]; then
  echo "${RED}cannot continue without both scratch runs${RESET}" >&2
  echo
  echo "SUMMARY: 0/$STEP_TOTAL checks passed (setup failure)"
  exit 1
fi

run_status "$RUN_B"
RUN_B_STATUS_BEFORE="$RUN_STATUS"

# --------------------------------------------------------------------------
# Step 1: message to the fresh (queued) target -> 202, then GET comms shows
# the entry with meta.comms.direction "in".
# --------------------------------------------------------------------------

step_start 1 "message to fresh (queued) run -> 202, direction 'in' in comms"

http POST "/api/runs/$RUN_A/message" \
  "$(jq -n '{text:"step1 hello from konrad", from:"konrad"}')"
step_assert_code "202" "message to fresh run"
step_assert_jq '.queued == true and .delivery == "next-turn"' "$HTTP_BODY" \
  "message to fresh run body shape"

http GET "/api/runs/$RUN_A/comms"
step_assert_code "200" "GET comms on target"
step_assert_jq '.comms | any(.meta.comms.direction == "in")' "$HTTP_BODY" \
  "comms entry with direction 'in'"

step_finish

# --------------------------------------------------------------------------
# Step 2: message with sender_run_id -> echo lands in SENDER's comms with
# direction "out", and the sender's status is explicitly unchanged (C3).
# --------------------------------------------------------------------------

step_start 2 "message with sender_run_id -> echo in sender comms (direction 'out'), sender status unchanged (C3)"

http POST "/api/runs/$RUN_A/message" \
  "$(jq -n --arg sid "$RUN_B" '{text:"step2 hello from worker", from:"worker", sender_run_id:$sid}')"
step_assert_code "202" "message with sender_run_id"
step_assert_jq '.queued == true and .delivery == "next-turn"' "$HTTP_BODY" \
  "message with sender_run_id body shape"

http GET "/api/runs/$RUN_B/comms"
step_assert_code "200" "GET comms on sender"
step_assert_jq '.comms | any(.meta.comms.direction == "out")' "$HTTP_BODY" \
  "echo entry with direction 'out' in sender's comms"

run_status "$RUN_B"
RUN_B_STATUS_AFTER="$RUN_STATUS"
echo "  sender status before echo: '$RUN_B_STATUS_BEFORE', after: '$RUN_B_STATUS_AFTER'"
step_assert_nonempty "$RUN_B_STATUS_BEFORE" "sender status readable before echo"
step_assert_eq "$RUN_B_STATUS_AFTER" "$RUN_B_STATUS_BEFORE" \
  "sender status must be unchanged by its own echo (C3)"

step_finish

# --------------------------------------------------------------------------
# Step 3: stop -> 202 {stopping:true}; status becomes paused; a second stop
# -> 409 with a reason.
# --------------------------------------------------------------------------

step_start 3 "stop -> 202, status paused; second stop -> 409"

http POST "/api/runs/$RUN_A/stop" ""
step_assert_code "202" "stop"
step_assert_jq '.stopping == true' "$HTTP_BODY" "stop body shape"

run_status "$RUN_A"
STATUS_AFTER_STOP="$RUN_STATUS"
echo "  status after stop: '$STATUS_AFTER_STOP'"
step_assert_eq "$STATUS_AFTER_STOP" "paused" "status after stop"

http POST "/api/runs/$RUN_A/stop" ""
step_assert_code "409" "second stop"
step_assert_jq '.error | length > 0' "$HTTP_BODY" "second stop carries a reason"

step_finish

# --------------------------------------------------------------------------
# Step 4: message to the paused run -> 202 and status back to queued.
# --------------------------------------------------------------------------

step_start 4 "message to paused run -> 202, status back to queued"

http POST "/api/runs/$RUN_A/message" \
  "$(jq -n '{text:"step4 wake up", from:"konrad"}')"
step_assert_code "202" "message to paused run"
step_assert_jq '.queued == true' "$HTTP_BODY" "message to paused run body shape"

run_status "$RUN_A"
STATUS_AFTER_WAKE="$RUN_STATUS"
echo "  status after message-to-paused: '$STATUS_AFTER_WAKE'"
step_assert_eq "$STATUS_AFTER_WAKE" "queued" "status after message to paused run"

step_finish

# --------------------------------------------------------------------------
# Step 5: terminate -> 202 {terminating:true}; status cancelled AND
# completed_at non-null (the §4 consistency fix); a second terminate -> 409.
# --------------------------------------------------------------------------

step_start 5 "terminate -> 202, status cancelled + completed_at stamped (§4 fix); second terminate -> 409"

http POST "/api/runs/$RUN_A/terminate" ""
step_assert_code "202" "terminate"
step_assert_jq '.terminating == true' "$HTTP_BODY" "terminate body shape"

run_status "$RUN_A"
STATUS_AFTER_TERMINATE="$RUN_STATUS"
run_completed_at "$RUN_A"
COMPLETED_AT="$RUN_COMPLETED_AT"
echo "  status after terminate: '$STATUS_AFTER_TERMINATE', completed_at: '$COMPLETED_AT'"
step_assert_eq "$STATUS_AFTER_TERMINATE" "cancelled" "status after terminate"
step_assert_nonempty "$COMPLETED_AT" \
  "completed_at stamped after terminate (the §4 consistency fix)"

http POST "/api/runs/$RUN_A/terminate" ""
step_assert_code "409" "second terminate"
step_assert_jq '.error | length > 0' "$HTTP_BODY" "second terminate carries a reason"

step_finish

# --------------------------------------------------------------------------
# Step 6: message to the cancelled run -> 409 naming /resume-chat.
# --------------------------------------------------------------------------

step_start 6 "message to cancelled run -> 409 naming /resume-chat"

http POST "/api/runs/$RUN_A/message" \
  "$(jq -n '{text:"step6 are you there", from:"konrad"}')"
step_assert_code "409" "message to cancelled run"
step_assert_jq '.error | test("resume-chat")' "$HTTP_BODY" \
  "error names /resume-chat"

step_finish

# --------------------------------------------------------------------------
# Step 6b: message to a run that reached `completed` -> 202, status back to
# queued, and `completed_at` CLEARED (R906, gating finding 3 / red-team S1).
#
# Why this needs its own step. `append_and_queue` puts a settled run back to
# work; if the write leaves `completed_at` stamped, the rail renders a live run
# as settled-at-<past> and its duration is nonsense until it settles again --
# and if the watchdog catches it first, the row is `stuck` WITH a completion
# timestamp, which completeRun's own invariant forbids. Nothing in steps 1-6
# reaches that state: run A goes queued -> paused -> queued -> cancelled and
# never carries a completion stamp on an eligible status.
#
# It uses run B, which has been sitting on the live queue since setup, and
# waits for the executor to finish it. If it never completes within the window
# the step FAILS rather than skipping (this script has no silent skips) -- read
# such a failure as "the executor is not draining the queue", which is worth
# knowing on a deploy either way.
# --------------------------------------------------------------------------

step_start "6b" "message to a completed run -> 202, status queued, completed_at cleared"

RUN_B_COMPLETED=0
for _ in $(seq 1 60); do
  run_status "$RUN_B"
  s="$RUN_STATUS"
  if [ "$s" = "completed" ]; then
    RUN_B_COMPLETED=1
    break
  fi
  if [ "$s" = "failed" ] || [ "$s" = "cancelled" ]; then
    break
  fi
  sleep 3
done

if [ "$RUN_B_COMPLETED" -ne 1 ]; then
  run_status "$RUN_B"
  step_assert_eq "$RUN_STATUS" "completed" \
    "run B must reach 'completed' within 180s for this step to be meaningful (executor draining?)"
else
  run_completed_at "$RUN_B"
  COMPLETED_AT_BEFORE="$RUN_COMPLETED_AT"
  echo "  run B completed_at before the message: '$COMPLETED_AT_BEFORE'"
  step_assert_nonempty "$COMPLETED_AT_BEFORE" \
    "a completed run must carry completed_at before we message it (else this step proves nothing)"

  http POST "/api/runs/$RUN_B/message" \
    "$(jq -n '{text:"step6b one more thing", from:"konrad"}')"
  step_assert_code "202" "message to completed run"
  step_assert_jq '.queued == true and .delivery == "next-turn"' "$HTTP_BODY" \
    "message to completed run body shape"

  run_status "$RUN_B"
  STATUS_AFTER_REQUEUE="$RUN_STATUS"
  run_completed_at "$RUN_B"
  COMPLETED_AT_AFTER="$RUN_COMPLETED_AT"
  echo "  run B after the message: status '$STATUS_AFTER_REQUEUE', completed_at '$COMPLETED_AT_AFTER'"
  # The executor may already have re-claimed it (queued -> running); both are
  # live states and both must be free of a completion stamp.
  case "$STATUS_AFTER_REQUEUE" in
    queued|running) : ;;
    *)
      STEP_FAILS+=("status after message to completed run must be queued or running, got '$STATUS_AFTER_REQUEUE'")
      ;;
  esac
  step_assert_eq "$COMPLETED_AT_AFTER" "" \
    "completed_at must be CLEARED when a message requeues a completed run (R906)"
fi

step_finish

# --------------------------------------------------------------------------
# Step 7: GET comms on both runs, printed in full as the evidence transcript.
# --------------------------------------------------------------------------

step_start 7 "GET comms on both runs (evidence transcript)"

echo "--- run A ($RUN_A) comms ---"
http GET "/api/runs/$RUN_A/comms"
step_assert_code "200" "GET comms on run A"

echo "--- run B ($RUN_B) comms ---"
http GET "/api/runs/$RUN_B/comms"
step_assert_code "200" "GET comms on run B"

step_finish

# --------------------------------------------------------------------------
# Step 8: resume-chat on a settled run (RUN_A, terminated -> cancelled by
# step 5). Proves C6 in place: same id back, queued, completed_at cleared
# (the same R906 property step 6b proves for /message) -- then the other
# half of step 6's sentence, the queued-target refusal naming /message.
# --------------------------------------------------------------------------

step_start 8 "resume-chat on a cancelled run -> 202 in place, queued, completed_at cleared; second resume-chat while queued -> 409 naming /message"

http POST "/api/runs/$RUN_A/resume-chat" \
  "$(jq -n '{text:"step 8 resume follow-up", from:"konrad"}')"
step_assert_code "202" "resume-chat on cancelled run"
step_assert_jq ".resumed_run_id == \"$RUN_A\"" "$HTTP_BODY" \
  "resumed_run_id echoes the same id (C6: in place, never a new run)"

run_status "$RUN_A"
STATUS_AFTER_RESUME="$RUN_STATUS"
run_completed_at "$RUN_A"
COMPLETED_AT_AFTER_RESUME="$RUN_COMPLETED_AT"
echo "  status after resume-chat: '$STATUS_AFTER_RESUME', completed_at: '$COMPLETED_AT_AFTER_RESUME'"
step_assert_eq "$STATUS_AFTER_RESUME" "queued" "status after resume-chat on cancelled run"
step_assert_eq "$COMPLETED_AT_AFTER_RESUME" "" \
  "completed_at must be CLEARED by resume-chat (same R906 property step 6b proves for /message)"

http GET "/api/runs/$RUN_A/comms"
step_assert_code "200" "GET comms on run A after resume-chat"
step_assert_jq '.comms | any(.meta.comms.direction == "in")' "$HTTP_BODY" \
  "comms entry with direction 'in' still present after resume-chat"
step_assert_jq '.comms | any(.meta.comms.direction == "in" and (.content | test("step 8 resume follow-up")))' \
  "$HTTP_BODY" "the new resume-chat entry is present in the thread"

# The refusal direction. This second call can legitimately race the live
# executor claiming RUN_A into `running` before this line runs (queued runs
# get picked up) - either way the answer is a 409 naming /message
# (resumeAction's "run is queued ... use POST /api/runs/:id/message"), which
# is exactly what the assertion below checks, so the race does not make this
# step flaky.
http POST "/api/runs/$RUN_A/resume-chat" \
  "$(jq -n '{text:"step 8 second resume attempt", from:"konrad"}')"
step_assert_code "409" "second resume-chat while queued/running"
step_assert_jq '.error | test("/message")' "$HTTP_BODY" \
  "second resume-chat's refusal names /message"

step_finish

# --------------------------------------------------------------------------
# Step 9: subagent-message with an unaddressable id, against a fresh scratch
# run that has never spawned a sub-agent (C10's honest-refusal path, fully
# provable live).
# --------------------------------------------------------------------------

step_start 9 "subagent-message with an unaddressable id -> 409; empty id -> 400; refused calls append nothing"

RUN_D=""
if ! create_scratch_run "subagent-parent"; then
  STEP_FAILS+=("could not create the subagent-parent scratch run")
else
  RUN_D="$SCRATCH_RUN_ID"
  echo "  subagent-parent run id: $RUN_D"

  http POST "/api/runs/$RUN_D/subagent-message" \
    "$(jq -n '{subagent_id:"toolu_definitely_not_a_real_id", text:"step 9 relay"}')"
  step_assert_code "409" "subagent-message with unaddressable id"
  step_assert_jq '.error | test("not addressable")' "$HTTP_BODY" \
    "error names the honest 'not addressable' refusal (C10)"

  http POST "/api/runs/$RUN_D/subagent-message" \
    "$(jq -n '{subagent_id:"", text:"step 9 relay with empty id"}')"
  step_assert_code "400" "subagent-message with empty subagent_id"

  http GET "/api/runs/$RUN_D/comms"
  step_assert_code "200" "GET comms on subagent-parent"
  step_assert_jq '.comms | length == 0' "$HTTP_BODY" \
    "neither refused call appended anything to the parent's thread"
fi

echo
echo "${YELLOW}step 9 note (no silent skips): the ADDRESSABLE relay path -- a${RESET}"
echo "${YELLOW}subagent_id present in metadata.subagents_v2 -- cannot be exercised here.${RESET}"
echo "${YELLOW}A scratch run created via POST /api/chat has never spawned a sub-agent, so${RESET}"
echo "${YELLOW}there is no live id to address; fabricating metadata.subagents_v2 would mean${RESET}"
echo "${YELLOW}writing to the live DB behind the API, which this script never does. That${RESET}"
echo "${YELLOW}path IS proven: src/lib/run-control-rules.test.ts's 'subagentAddressable'${RESET}"
echo "${YELLOW}table tests cover the address-space matching itself, and${RESET}"
echo "${YELLOW}src/lib/run-control-surface.test.ts asserts the addressability-before-${RESET}"
echo "${YELLOW}eligibility ordering in the route source. Its live proof -- an actual relay${RESET}"
echo "${YELLOW}delivered to a real sub-agent -- belongs to CP4 against a real fleet run.${RESET}"
echo "${YELLOW}This note is not counted as a pass.${RESET}"

step_finish

# --------------------------------------------------------------------------
# Note (no silent skips): the C7 workspace-gone 409 cannot be provoked from
# HTTP by this script. A scratch run created via POST /api/chat carries no
# metadata.workspace_dir (plain Chat/Manager runs share CC_WORKSPACE), and
# the only way to give one a workspace_dir that points nowhere would be
# writing directly to the live DB behind the API -- which this script never
# does. That path IS proven: run-control-rules.test.ts's `workspaceDirOf`
# table tests, plus run-control-surface.test.ts's assertion that the
# `existsSync` pre-flight in routes/run-control.ts runs BEFORE any write.
# --------------------------------------------------------------------------

echo
echo "${YELLOW}note (no silent skips): the C7 workspace-gone 409 (resume-chat against a${RESET}"
echo "${YELLOW}run whose metadata.workspace_dir no longer exists on disk) cannot be${RESET}"
echo "${YELLOW}provoked from HTTP -- a scratch run has no workspace_dir, and fabricating${RESET}"
echo "${YELLOW}one means writing to the live DB behind the API, which this script never${RESET}"
echo "${YELLOW}does. It IS proven: run-control-rules.test.ts's workspaceDirOf table tests${RESET}"
echo "${YELLOW}plus run-control-surface.test.ts's pre-flight-before-write ordering${RESET}"
echo "${YELLOW}assertion. Not counted as a step or a pass.${RESET}"

# --------------------------------------------------------------------------
# --running: message into a RUNNING target. Only half-live until the
# DETACHED executor restart lands (07 §8) - see the header comment.
# --------------------------------------------------------------------------

if [ "$RUNNING_MODE" -eq 1 ]; then
  echo
  echo "${YELLOW}--running requested: exercising message-into-a-RUNNING-target.${RESET}"
  echo "${YELLOW}This half of message_into_session only fully lands once the DETACHED${RESET}"
  echo "${YELLOW}forge-executor restart has run (07-control-plane-architecture.md §8's${RESET}"
  echo "${YELLOW}restart matrix). A failure below, before that restart, is EXPECTED and${RESET}"
  echo "${YELLOW}must NOT be read as a control-plane defect - it is still counted in the${RESET}"
  echo "${YELLOW}final tally below (no silent skips), tagged [EXPECTED PRE-RESTART].${RESET}"

  step_start "R1" "wait for a scratch run to reach status=running, then message it"

  RUN_C=""
  if ! create_scratch_run "running-target"; then
    STEP_FAILS+=("could not create the running-target scratch run")
    step_finish "expected-pre-restart"
  else
    RUN_C="$SCRATCH_RUN_ID"
    echo "  running-target run id: $RUN_C"
    OBSERVED_RUNNING=0
    for _ in $(seq 1 30); do
      run_status "$RUN_C"
      s="$RUN_STATUS"
      if [ "$s" = "running" ]; then
        OBSERVED_RUNNING=1
        break
      fi
      sleep 2
    done

    if [ "$OBSERVED_RUNNING" -ne 1 ]; then
      STEP_FAILS+=("run $RUN_C never reached status=running within 60s (executor may not be claiming, or has not been restarted yet)")
      step_finish "expected-pre-restart"
    else
      http POST "/api/runs/$RUN_C/message" \
        "$(jq -n '{text:"R1 message into a running target", from:"konrad"}')"
      step_assert_code "202" "message to running target"
      step_assert_jq '.queued == true and .delivery == "next-turn"' "$HTTP_BODY" \
        "message to running target body shape"

      http GET "/api/runs/$RUN_C/comms"
      step_assert_code "200" "GET comms on running target"
      step_assert_jq '.comms | any(.meta.comms.direction == "in")' "$HTTP_BODY" \
        "comms entry with direction 'in' on running target (delivery on next turn is the executor-side half - not provable from HTTP alone before the restart)"

      step_finish "expected-pre-restart"
    fi
  fi
else
  echo
  echo "(skipping --running section - pass --running to also exercise message-into-a-RUNNING-target)"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

echo
if [ "${#FAILED_STEPS[@]}" -eq 0 ]; then
  echo "${GREEN}PASS ${STEP_PASSED}/${STEP_TOTAL} checks${RESET}"
  exit 0
else
  echo "${RED}FAILED steps (${#FAILED_STEPS[@]}/${STEP_TOTAL}):${RESET}"
  for f in "${FAILED_STEPS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
