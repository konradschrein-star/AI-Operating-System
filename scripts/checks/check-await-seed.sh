#!/usr/bin/env bash
#
# check-await-seed.sh — the behavioural proof for `scripts/deploy/await-and-seed.sh`
# (engine-task-graph phase 8D).
#
# The watcher it tests has exactly one job and no second chance: it is launched
# detached by a task that immediately ends, it waits hours, and it fires once. If
# it fires early, phase 8's verification runs against the OLD engine and reports
# a pass that means nothing. If it never fires, phase 8 simply stops and nobody
# is waiting on it. Neither failure is visible while it is happening. So it is
# proved here, before it is ever launched, against fakes.
#
# ---------------------------------------------------------------------------
# IT TOUCHES NOTHING REAL. Two substitutions and that is the whole rig:
#   * `AWAIT_SEED_PM2_CMD` is pointed at a shell shim that prints canned pm2
#     JSON out of a state file this script rewrites between polls. No pm2 is
#     invoked, no process is signalled.
#   * `AWAIT_SEED_API` is pointed at a throwaway python3 HTTP server on an
#     ephemeral port, which RECORDS every request it receives (method, path,
#     body) as one JSON line and answers with a code this script chooses. No
#     request reaches 127.0.0.1:7700, so the live project cannot be reactivated
#     and no task can be seeded by a test run.
# Everything lives under one `mktemp -d`, removed on exit.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot
# (standing rule 3, `00-vision.md` §7 rule 3).
#
#   (a) A PROBE THAT NEVER TOUCHED ITS TARGET. Case 1 asserts an ABSENCE —
#       "nothing was POSTed" — and an absence is also what you get from a
#       watcher that crashed at startup, a shim that was never executed, or a
#       recorder that was never listening. Guarded three ways: the shim appends
#       to a call log and case 1 asserts it was called at least three times; the
#       watcher's own transcript must carry at least three "not firing" lines
#       naming the baseline it compared against; and the recorder is proved
#       reachable by a liveness GET before the first case runs.
#   (b) A CASE DECLARED AND NEVER REACHED. This is the failure round 223 caught
#       in `check-plan-store.ts`: a table that lists a case it never executed
#       reads as coverage. Guarded by CASES_DECLARED vs CASES_EXECUTED, printed
#       as a census and compared IN BOTH DIRECTIONS, and by the same
#       both-directions gate on the assertion count.
#   (c) AN EARLY `return` OR AN ABORTED SECTION READING AS A PASS. Guarded by
#       `set -e` plus an ERR trap that prints "NOT a pass" with a line number,
#       and by (b): an abort cannot reach the census.
#   (d) THE WATCHER "PASSED" BECAUSE IT DIED. An exit code of 1 satisfies "exits
#       non-zero" whether the reason was the token guard or a syntax error.
#       Guarded because every non-zero case additionally asserts the EXPECTED
#       REASON in the transcript and the expected request pattern at the
#       recorder — a watcher that died early POSTs no manager message either.
#   (e) THE FIRE CASE PASSED ON A STALE BASELINE. If the shim's initial state
#       already satisfied the fire test, case 2 would pass without the flip ever
#       mattering. Guarded because case 2 asserts the transcript carries at
#       least one pre-flip "not firing" line before the FIRE line, so the
#       watcher is proved to have refused the baseline first.
#   (f) A STUB THAT ONLY EVER SAYS YES (round 804 finding 2). Every case here
#       POSTs its manager message to a recorder that answered 202
#       unconditionally, so "the manager was told" was asserted six times and
#       the REFUSAL branch zero times — and the watcher duly reported a 409 as
#       "notified" for two rounds. A stub whose every answer is a success cannot
#       distinguish a handled failure from an unhandled one. Guarded by making
#       the `/message` code settable (`$TMP/message-code`, default 202) and by
#       case 7, which refuses the message with the LIVE route's bytes and
#       asserts both the WARNING and the unchanged exit code. The general rule:
#       every response code this watcher branches on gets a case, or the branch
#       is untested however green the run looks.
#
# Usage:  bash scripts/checks/check-await-seed.sh
# Exit:   0 = every case ran and every assertion passed.
#
set -euo pipefail
trap 'rc=$?; [ $rc -ne 0 ] && echo "check-await-seed.sh: ABORTED at line $LINENO (exit $rc) — NOT a pass" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO_ROOT/scripts/deploy/await-and-seed.sh"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# The project id the watcher is hard-wired to seed into, and the manager run it
# reports to. Asserted here rather than assumed: if either constant drifts, the
# watcher would POST somewhere this check is not looking and every case below
# would still pass.
SEED_PROJECT="8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4"
MANAGER_RUN="bfd1283a-b71b-4f35-b577-7d09aad803f2"

# Kept in sync by hand and enforced at the end, in BOTH directions.
EXPECTED_ASSERTIONS=56
ASSERTIONS_RUN=0
CASES_DECLARED=7
CASES_EXECUTED=0

pass() {
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
  printf '  ok   %-56s %s\n' "$1" "${2-}"
}
fail() {
  printf '  FAIL %-56s %s\n' "$1" "${2-}" >&2
  printf '\ncheck-await-seed.sh FAILED after %d assertions, %d/%d cases\n' \
    "$ASSERTIONS_RUN" "$CASES_EXECUTED" "$CASES_DECLARED" >&2
  exit 1
}
assert_eq()   { [ "$2" = "$3" ] && pass "$1" "= $3" || fail "$1" "expected [$2] got [$3]"; }
assert_ne()   { [ "$2" != "$3" ] && pass "$1" "!= $2" || fail "$1" "must not be [$2]"; }
assert_ge()   { [ "$3" -ge "$2" ] && pass "$1" ">= $2 (got $3)" || fail "$1" "expected >= $2, got $3"; }
assert_has()  { case "$2" in *"$3"*) pass "$1" "contains: $3" ;; *) fail "$1" "missing [$3]" ;; esac; }
assert_lacks(){ case "$2" in *"$3"*) fail "$1" "found [$3]" ;; *) pass "$1" "no: $3" ;; esac; }
assert_nonzero(){ [ "$2" -ne 0 ] && pass "$1" "exit $2" || fail "$1" "expected non-zero exit, got 0"; }
case_begin()  { CASES_EXECUTED=$((CASES_EXECUTED + 1)); echo; echo "CASE $1"; }

# ---------------------------------------------------------------------------
# 0. BUILD IDENTITY — before a single assertion. A harness that does not expose
#    its own build identity is not evidence (standing rule 3).
# ---------------------------------------------------------------------------
echo "check-await-seed.sh — engine-task-graph phase 8D (await-and-seed.sh)"
echo
echo "BUILD IDENTITY OF THE CODE UNDER TEST"
echo "  worktree path    : $REPO_ROOT"
echo "  git HEAD         : $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo no-git)"
echo "  git branch       : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo no-git)"
echo "  subject          : $SUBJECT"
echo "  subject sha256   : $(sha256sum "$SUBJECT" | cut -d' ' -f1)   <-- authoritative"
echo "  subject dirty    : $(git -C "$REPO_ROOT" status --porcelain -- scripts/deploy/await-and-seed.sh | head -1 | grep . || echo '[committed, matches HEAD]')"
echo "  this check sha256: $(sha256sum "$SELF" | cut -d' ' -f1)"
echo "  bash             : $BASH_VERSION"
echo "  python3          : $(python3 --version 2>&1)"
echo "  curl             : $(curl --version | head -1)"
echo

[ -f "$SUBJECT" ] || { echo "REFUSING TO RUN: no await-and-seed.sh at $SUBJECT" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; pkill -f "recorder.py $TMP" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# The fake pm2. Prints whatever is in $TMP/pm2-state.json and records that it
# was called — the call log is what turns case 1's absence into evidence.
# ---------------------------------------------------------------------------
cat > "$TMP/fake-pm2.sh" <<'SHIM'
#!/usr/bin/env bash
echo "called $(date +%s)" >> "$FAKE_PM2_CALLS"
cat "$FAKE_PM2_STATE"
SHIM

pm2_state() {  # restart_time pm_uptime status
  cat > "$TMP/pm2-state.json" <<JSON
[
  {"name":"forge-control","pm2_env":{"restart_time":3,"pm_uptime":1000,"status":"online"}},
  {"name":"forge-executor","pm2_env":{"restart_time":$1,"pm_uptime":$2,"status":"$3"}}
]
JSON
}

# ---------------------------------------------------------------------------
# The recorder. Records every request as one JSON line; answers with codes this
# script controls through two one-line files. Paths beginning `/__` are liveness
# probes and are deliberately NOT recorded, so the census of real requests stays
# exact.
# ---------------------------------------------------------------------------
cat > "$TMP/recorder.py" <<'PY'
import json, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = sys.argv[1]
PORT = int(sys.argv[2])
LOG = os.path.join(BASE, "requests.jsonl")
TASK_CODE = os.path.join(BASE, "task-code")
PROJECT_STATUS = os.path.join(BASE, "project-status")
# Round 804 finding 2. This used to be a hard-wired 202, so the watcher's
# rejection path had never once been observed — a stub that only ever accepts
# proves only that the happy branch exists.
MESSAGE_CODE = os.path.join(BASE, "message-code")


def read(path, default):
    try:
        with open(path) as fh:
            value = fh.read().strip()
        return value or default
    except OSError:
        return default


class Handler(BaseHTTPRequestHandler):
    def record(self, method, body):
        if self.path.startswith("/__"):
            return
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"method": method, "path": self.path, "body": body}) + "\n")

    def answer(self, code, payload):
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.record("GET", "")
        if self.path.startswith("/__"):
            return self.answer(200, {"ready": True})
        if "/api/projects/" in self.path:
            return self.answer(200, {
                "project": {"id": self.path.rsplit("/", 1)[-1],
                            "status": read(PROJECT_STATUS, "active")},
                "tasks": [],
            })
        return self.answer(404, {"error": "unexpected GET %s" % self.path})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        self.record("POST", body)
        if self.path.endswith("/tasks"):
            code = int(read(TASK_CODE, "201"))
            payload = {"task": {"id": "11111111-2222-4333-8444-555555555555"}}
            if code == 409:
                payload["error"] = ("duplicate task: this project already has a "
                                    "task with that round/role/title")
            elif code >= 400:
                payload = {"error": "recorder was told to answer %d" % code}
            return self.answer(code, payload)
        if self.path.endswith("/status"):
            return self.answer(200, {"project": {"status": "active"}})
        if self.path.endswith("/message"):
            code = int(read(MESSAGE_CODE, "202"))
            if 200 <= code < 300:
                return self.answer(code, {"queued": True, "delivery": "next-turn"})
            # VERBATIM from the live route, not a paraphrase: a stub answering
            # bytes the real API never emits proves the watcher handles the
            # stub. Copied from `messageAction()`'s `cancelled` rejection in
            # `forge-control/src/lib/run-control-rules.ts`.
            return self.answer(code, {
                "error": "run cancelled - use POST /api/runs/:id/resume-chat to reopen it",
            })
        return self.answer(404, {"error": "unexpected POST %s" % self.path})

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
PY

PORT="$(python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
API="http://127.0.0.1:$PORT"
python3 "$TMP/recorder.py" "$TMP" "$PORT" &
RECORDER_PID=$!

# Liveness. A recorder that never bound would make every "nothing was POSTed"
# assertion below pass for the wrong reason — (a).
READY=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -sf -o /dev/null "$API/__ready" 2>/dev/null; then READY=yes; break; fi
  sleep 0.25
done
[ -n "$READY" ] || { echo "REFUSING TO RUN: the recorder never came up on $API" >&2; exit 1; }
echo "recorder listening on $API (pid $RECORDER_PID), request log $TMP/requests.jsonl"

# A payload that is byte-identical in shape to the real ones. Deliberately NOT
# one of scripts/deploy/payload-*.json: those carry 12 kB briefs whose text would
# drown the transcript, and this check is about the watcher, not about them.
cat > "$TMP/payload-ok.json" <<'JSON'
{
  "role": "builder",
  "round": 815,
  "title": "check-await-seed fake task — never POSTed to a real API",
  "brief": "fake",
  "tier": "standard",
  "write_set": ["docs/plan/engine-task-graph/evidence/phase8-verify.md"],
  "depends_on": []
}
JSON

# The same payload with a token left in the write_set — the exact shape the
# guard exists to refuse: a task whose declared file is a placeholder.
python3 - "$TMP/payload-ok.json" "$TMP/payload-token.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["write_set"] = ["docs/plan/engine-task-graph/evidence/after-" + "__DOD6_PROJECT_ID__" + ".md"]
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY

RESET_RECORDER() { : > "$TMP/requests.jsonl"; : > "$TMP/pm2-calls.log"; }
REQ_COUNT() { [ -s "$TMP/requests.jsonl" ] && wc -l < "$TMP/requests.jsonl" | tr -d ' ' || echo 0; }
REQ_PATHS() { [ -s "$TMP/requests.jsonl" ] && python3 -c '
import json, sys
for line in open(sys.argv[1]):
    entry = json.loads(line)
    print("%s %s" % (entry["method"], entry["path"]))
' "$TMP/requests.jsonl" || true; }
REQ_NTH()  { REQ_PATHS | sed -n "${1}p"; }
# The recorder stores each body JSON-ENCODED inside its line, so a raw grep for
# `{"status":"active"}` would look for bytes that are not there. Decoded here so
# the assertions compare what the watcher actually sent.
REQ_BODY() { python3 -c '
import json, sys
lines = open(sys.argv[1]).read().splitlines()
idx = int(sys.argv[2])
print(json.loads(lines[idx - 1])["body"] if 0 < idx <= len(lines) else "")
' "$TMP/requests.jsonl" "$1"; }
# The body of the FIRST request whose path contains $1. Positional indexing is
# wrong for project-done mode, where the poll GETs sit between the launch and
# the two POSTs — "the second request" is a GET there and an assertion pinned to
# it would compare against the wrong bytes.
REQ_BODY_MATCH() { python3 -c '
import json, sys
needle = sys.argv[2]
for line in open(sys.argv[1]):
    entry = json.loads(line)
    if needle in entry["path"]:
        print(entry["body"]); break
' "$TMP/requests.jsonl" "$1"; }
REQ_BODIES() { python3 -c '
import json, sys
for line in open(sys.argv[1]):
    print(json.loads(line)["body"])
' "$TMP/requests.jsonl" 2>/dev/null || true; }
SHOW()     { echo "      --- $1 ---"; sed 's/^/      /' "$2"; echo "      --- end ---"; }

run_watcher() {  # logfile timeout mode args... ; sets WATCHER_PID
  local logfile="$1" timeout="$2"; shift 2
  AWAIT_SEED_PM2_CMD="bash $TMP/fake-pm2.sh" \
  AWAIT_SEED_API="$API" \
  AWAIT_SEED_POLL=1 \
  AWAIT_SEED_TIMEOUT="$timeout" \
  AWAIT_SEED_SERVICE=forge-executor \
  FAKE_PM2_STATE="$TMP/pm2-state.json" \
  FAKE_PM2_CALLS="$TMP/pm2-calls.log" \
    bash "$SUBJECT" "$@" > "$logfile" 2>&1 &
  WATCHER_PID=$!
}

# ---------------------------------------------------------------------------
case_begin "1 — the restart counter is UNMOVED: the watcher POSTs NOTHING"
# ---------------------------------------------------------------------------
RESET_RECORDER
pm2_state 7 900000 online
run_watcher "$TMP/case1.log" 600 executor-restart "$TMP/payload-ok.json"
sleep 5
kill "$WATCHER_PID" 2>/dev/null || true
RC=0; wait "$WATCHER_PID" || RC=$?
C1="$(cat "$TMP/case1.log")"
SHOW "case1.log" "$TMP/case1.log"
assert_eq  "1.1 no request of any kind reached the API"        "0" "$(REQ_COUNT)"
assert_ge  "1.2 the pm2 shim was really called (probe reached)" "3" "$(wc -l < "$TMP/pm2-calls.log" | tr -d ' ')"
assert_ge  "1.3 the transcript shows repeated refusals"        "3" "$(grep -c 'not firing' "$TMP/case1.log")"
assert_has "1.4 it names the baseline it compared against"     "$C1" "has not passed the baseline 7"
assert_has "1.5 the provenance line came first"                "$(head -1 "$TMP/case1.log")" "provenance head="
assert_has "1.6 the provenance line carries its own sha256"    "$(head -1 "$TMP/case1.log")" "self-sha256=$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
assert_has "1.7 the provenance line carries the baseline"      "$(head -1 "$TMP/case1.log")" "baseline=[restart_time=7 pm_uptime=900000 status=online"
assert_ne  "1.8 it was still running when we killed it"        "0" "$RC"

# ---------------------------------------------------------------------------
case_begin "2 — the counter MOVES and status is online: exactly one seeding, status POST first"
# ---------------------------------------------------------------------------
RESET_RECORDER
echo 201 > "$TMP/task-code"
pm2_state 7 900000 online
run_watcher "$TMP/case2.log" 600 executor-restart "$TMP/payload-ok.json"
sleep 2
# The flip. pm_uptime must be later than the watcher's launch, which is `now`
# in milliseconds — so a value derived from the current clock, not a constant.
pm2_state 8 "$(( $(date +%s) * 1000 + 5000 ))" online
RC=0; wait "$WATCHER_PID" || RC=$?
C2="$(cat "$TMP/case2.log")"
SHOW "case2.log" "$TMP/case2.log"
echo "      requests seen:"; REQ_PATHS | sed 's/^/        /'
assert_eq  "2.1 the watcher exited 0"                          "0" "$RC"
assert_eq  "2.2 exactly two requests were made"                "2" "$(REQ_COUNT)"
assert_eq  "2.3 the FIRST request is the reactivation"         "POST /api/projects/$SEED_PROJECT/status" "$(REQ_NTH 1)"
assert_eq  "2.4 the SECOND request is the task POST"           "POST /api/projects/$SEED_PROJECT/tasks"  "$(REQ_NTH 2)"
assert_eq  "2.5 exactly one task POST, never two"              "1" "$(REQ_PATHS | grep -c '/tasks$')"
assert_has "2.6 the reactivation body is status:active"        "$(REQ_BODY 1)" '{"status":"active"}'
assert_has "2.7 the task body is the rendered payload"         "$(REQ_BODY 2)" "check-await-seed fake task"
assert_has "2.8 it refused the baseline BEFORE the flip"       "$C2" "has not passed the baseline 7"
assert_has "2.9 the FIRE line names the transition"            "$C2" "restart_time 7 -> 8"
assert_has "2.10 it logged the 201"                            "$C2" "SEEDED: HTTP 201"
assert_lacks "2.11 no manager-chat message was needed"         "$(REQ_PATHS)" "/message"

# ---------------------------------------------------------------------------
case_begin "3 — a 409 on the task POST is SUCCESS and is logged as such"
# ---------------------------------------------------------------------------
RESET_RECORDER
echo 409 > "$TMP/task-code"
pm2_state 8 900000 online
run_watcher "$TMP/case3.log" 600 executor-restart "$TMP/payload-ok.json"
sleep 2
pm2_state 9 "$(( $(date +%s) * 1000 + 5000 ))" online
RC=0; wait "$WATCHER_PID" || RC=$?
C3="$(cat "$TMP/case3.log")"
SHOW "case3.log" "$TMP/case3.log"
assert_eq  "3.1 a 409 exits 0 — it is a success"               "0" "$RC"
assert_has "3.2 the transcript calls it a SUCCESS"             "$C3" "409 treated as SUCCESS"
assert_has "3.3 it names the identity that already exists"     "$C3" "(project, round, role, title)"
assert_has "3.4 the API's duplicate message is quoted"         "$C3" "duplicate task"
assert_eq  "3.5 it still POSTed exactly once"                  "1" "$(REQ_PATHS | grep -c '/tasks$')"
echo 201 > "$TMP/task-code"

# ---------------------------------------------------------------------------
case_begin "4 — an unsubstituted __TOKEN__ seeds NOTHING and exits non-zero"
# ---------------------------------------------------------------------------
RESET_RECORDER
pm2_state 9 900000 online
run_watcher "$TMP/case4.log" 600 executor-restart "$TMP/payload-token.json"
RC=0; wait "$WATCHER_PID" || RC=$?
C4="$(cat "$TMP/case4.log")"
SHOW "case4.log" "$TMP/case4.log"
assert_nonzero "4.1 it exits non-zero"                         "$RC"
assert_eq  "4.2 the reason is the token guard, not a crash"    "1" "$(grep -c 'unsubstituted token' "$TMP/case4.log")"
assert_has "4.3 the offending token is NAMED"                  "$C4" "__DOD6_PROJECT_ID__"
assert_has "4.4 it says it seeded nothing"                     "$C4" "seeding NOTHING"
assert_eq  "4.5 no reactivation POST"                          "0" "$(REQ_PATHS | grep -c '/status$' || true)"
assert_eq  "4.6 no task POST"                                  "0" "$(REQ_PATHS | grep -c '/tasks$' || true)"
assert_eq  "4.7 exactly one manager-chat message"              "1" "$(REQ_PATHS | grep -c "/api/runs/$MANAGER_RUN/message" || true)"
assert_has "4.8 the message names the payload"                 "$(REQ_BODIES)" "payload-token.json"

# ---------------------------------------------------------------------------
case_begin "5 — on TIMEOUT it seeds nothing, tells the manager, exits non-zero"
# ---------------------------------------------------------------------------
RESET_RECORDER
pm2_state 9 900000 online
run_watcher "$TMP/case5.log" 3 executor-restart "$TMP/payload-ok.json"
RC=0; wait "$WATCHER_PID" || RC=$?
C5="$(cat "$TMP/case5.log")"
SHOW "case5.log" "$TMP/case5.log"
assert_nonzero "5.1 it exits non-zero"                         "$RC"
assert_eq  "5.2 and specifically with 2, the timeout code"     "2" "$RC"
assert_has "5.3 the transcript says TIMEOUT"                   "$C5" "TIMEOUT after"
assert_has "5.4 it says it seeded nothing"                     "$C5" "SEEDING NOTHING"
assert_eq  "5.5 no reactivation POST"                          "0" "$(REQ_PATHS | grep -c '/status$' || true)"
assert_eq  "5.6 no task POST"                                  "0" "$(REQ_PATHS | grep -c '/tasks$' || true)"
assert_eq  "5.7 exactly one manager-chat message"              "1" "$(REQ_PATHS | grep -c "/api/runs/$MANAGER_RUN/message" || true)"
assert_has "5.8 the message says WHAT it was waiting for"      "$(REQ_BODIES)" "to restart past restart_time=9"
assert_has "5.9 the message says nothing was seeded"           "$(REQ_BODIES)" "seeded NOTHING"

# ---------------------------------------------------------------------------
case_begin "6 — project-done mode fires on status=done and not before"
# ---------------------------------------------------------------------------
# The second watcher of phase 8 runs in this mode with payload-report.json, so
# leaving it unexercised would ship half the deliverable unproved.
RESET_RECORDER
echo 201 > "$TMP/task-code"
echo active > "$TMP/project-status"
DOD6='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
run_watcher "$TMP/case6.log" 600 project-done "$DOD6" "$TMP/payload-token.json" \
  --substitute "$(printf '__%s__' DOD6_PROJECT_ID)=$DOD6"
sleep 2
echo done > "$TMP/project-status"
RC=0; wait "$WATCHER_PID" || RC=$?
C6="$(cat "$TMP/case6.log")"
SHOW "case6.log" "$TMP/case6.log"
echo "      requests seen:"; REQ_PATHS | sed 's/^/        /'
assert_eq  "6.1 it exited 0"                                   "0" "$RC"
assert_has "6.2 it refused 'active' at least once"             "$C6" "is 'active', not 'done'"
assert_has "6.3 the FIRE line names status=done"               "$C6" "reached status=done"
assert_eq  "6.4 the reactivation came first"                   "POST /api/projects/$SEED_PROJECT/status" "$(REQ_PATHS | grep '^POST' | sed -n 1p)"
assert_eq  "6.5 exactly one task POST"                         "1" "$(REQ_PATHS | grep -c '/tasks$')"
assert_has "6.6 --substitute rendered the token in write_set"  "$(REQ_BODY_MATCH /tasks)" "after-$DOD6.md"
assert_lacks "6.7 no token survived into the POSTed body"      "$(REQ_BODY_MATCH /tasks)" "DOD6_PROJECT_ID"
assert_eq  "6.8 it polled the project, not pm2"                "0" "$(wc -l < "$TMP/pm2-calls.log" | tr -d ' ')"

# ---------------------------------------------------------------------------
case_begin "7 — the manager chat REFUSES the message: a WARNING, not 'notified'"
# ---------------------------------------------------------------------------
# Round 804 finding 2. Cases 4 and 5 both POST a manager message and both were
# only ever answered 202, so the watcher's rejection branch had never been
# observed — a gate seen only passing is not a gate.
#
# THE SCENARIO THIS REPRODUCES. 811 launches the watcher; the restart never
# lands; thirteen hours later it times out and POSTs "SEEDED NOTHING" to the
# manager run — which by then has FAILED or been CANCELLED, and `messageAction()`
# answers those two with a 409. Before the fix, `curl -sS` (no `--fail`) exits 0
# on a 409, so the transcript read "manager chat notified (HTTP 409)" and the
# only record that phase 8 had stopped was a log nobody opens.
#
# MEASURED CORRECTION to the round-803 finding's wording, recorded rather than
# quietly reinterpreted (standing rule 1): the finding named a *settled* run as
# the rejecting state. `messageAction()` ACCEPTS `completed` (`append_and_queue`
# — it requeues the run). The states that reject are `failed` and `cancelled`,
# both 409, and `unknown run` is a 404. The defect and its fix are unchanged;
# only the trigger moves, and this stub answers the `cancelled` text verbatim.
#
# The timeout path is used because it is the one that matters most — it is the
# path on which the message IS the entire deliverable — and because it lets 7.1
# assert the exit code is UNCHANGED against case 5's measured 2.
RESET_RECORDER
echo 409 > "$TMP/message-code"
pm2_state 9 900000 online
run_watcher "$TMP/case7.log" 3 executor-restart "$TMP/payload-ok.json"
RC=0; wait "$WATCHER_PID" || RC=$?
C7="$(cat "$TMP/case7.log")"
SHOW "case7.log" "$TMP/case7.log"
# 7.1 is the "never changes the exit path" contract: 2 is exactly what case 5
# measured with a 202, so a rejected message costs the caller nothing.
assert_eq  "7.1 the exit code is UNCHANGED — still 2"          "2" "$RC"
assert_has "7.2 the timeout reason is still reported"          "$C7" "TIMEOUT after"
# 7.3 without 7.6 would be satisfiable by a watcher that died before notifying.
assert_eq  "7.6 the message really WAS POSTed (probe reached)" "1" "$(REQ_PATHS | grep -c "/api/runs/$MANAGER_RUN/message" || true)"
assert_lacks "7.3 it does NOT claim the chat was notified"     "$C7" "manager chat notified"
assert_has "7.4 a WARNING names the refusal and its code"      "$C7" "REJECTED the message — HTTP 409"
assert_has "7.5 the WARNING quotes the API's body verbatim"    "$C7" "run cancelled - use POST /api/runs/:id/resume-chat"
assert_eq  "7.7 nothing was seeded despite the refusal"        "0" "$(REQ_PATHS | grep -c '/tasks$' || true)"
echo 202 > "$TMP/message-code"

# ---------------------------------------------------------------------------
# THE CENSUS. A sweep whose probes miss must exit non-zero rather than certify
# itself, and a table that declares a case it never reached is the same defect
# wearing a different hat (round 223, `check-plan-store.ts`).
# ---------------------------------------------------------------------------
echo
echo "CENSUS"
printf '  cases      declared %d   executed %d\n' "$CASES_DECLARED" "$CASES_EXECUTED"
printf '  assertions declared %d   executed %d\n' "$EXPECTED_ASSERTIONS" "$ASSERTIONS_RUN"

STATUS=0
if [ "$CASES_EXECUTED" -ne "$CASES_DECLARED" ]; then
  printf 'check-await-seed.sh FAILED: %d cases ran, %d declared.\n' "$CASES_EXECUTED" "$CASES_DECLARED" >&2
  printf '  fewer => a declared case never ran and this run certifies nothing.\n' >&2
  printf '  more  => a case was added without updating CASES_DECLARED.\n' >&2
  STATUS=1
fi
if [ "$ASSERTIONS_RUN" -ne "$EXPECTED_ASSERTIONS" ]; then
  printf 'check-await-seed.sh FAILED: ran %d assertions, expected exactly %d.\n' \
    "$ASSERTIONS_RUN" "$EXPECTED_ASSERTIONS" >&2
  printf '  fewer => probes were skipped and this run certifies nothing.\n' >&2
  printf '  more  => an assertion was added without updating EXPECTED_ASSERTIONS.\n' >&2
  STATUS=1
fi
[ "$STATUS" -eq 0 ] || exit 1

printf '\ncheck-await-seed.sh PASSED — %d/%d cases, %d/%d assertions.\n' \
  "$CASES_EXECUTED" "$CASES_DECLARED" "$ASSERTIONS_RUN" "$EXPECTED_ASSERTIONS"
