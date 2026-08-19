#!/usr/bin/env bash
#
# preflight-c1-fixture.sh — forced-failure fixture for check_c1 in
# scripts/checks/preflight-deploy.sh.
#
# Round 15 (fix cycle 1) rewrote C1's selection: it now walks each workstream's
# reviewer rows from the highest round DOWN, skipping rows that cannot hold a
# verdict yet (never run / the caller's own run / still in flight), and judges
# the first round-band that can. That is a loosening, and a loosening of the
# gate that judges this project's own deploy has to be demonstrated failing,
# not asserted to be safe. This fixture drives the REAL check_c1 — sourced
# straight out of scripts/checks/preflight-deploy.sh, never a patched copy —
# against a fabricated task graph and a fabricated runs DB, and asserts eight
# outcomes, five of them failures.
#
# Isolation, in order of how badly it would hurt to get wrong:
#   • a per-run scratch Postgres database, name prefixed `preflight_c1_fixture_`
#     and dropped at exit. The script REFUSES to run if PGDATABASE resolves to
#     content_forge, and refuses to drop anything not carrying that prefix.
#   • a throwaway static HTTP server on a free port serving the fixture project
#     JSON at /api/projects/<the real project id>; FORGE_CONTROL_API points at
#     it, so the live forge-control API is never called.
#   • nothing is written to the repo, /opt/forge-ai-os, or the live DB.
#
# Usage: bash scripts/checks/fixtures/preflight-c1-fixture.sh
# Exit 0 only if all eight cases produce their expected verdict.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PREFLIGHT="$REPO/scripts/checks/preflight-deploy.sh"
[ -f "$PREFLIGHT" ] || { echo "FIXTURE ABORT — $PREFLIGHT not found"; exit 2; }

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-90d4iBxMYP6m3DYrsP1fjSSU7uWDVE}"

PROJECT_ID="7851068b-32d7-469b-b42f-f5e3c1d9e83a"
SCRATCH_DB="preflight_c1_fixture_$$_$(date +%s)"
WORK="$(mktemp -d)"
SERVER_PID=""

case "$SCRATCH_DB" in
  preflight_c1_fixture_*) ;;
  *) echo "FIXTURE ABORT — refusing to use scratch DB name '$SCRATCH_DB'"; exit 2 ;;
esac
if [ "$SCRATCH_DB" = "content_forge" ]; then
  echo "FIXTURE ABORT — scratch DB resolved to content_forge"; exit 2
fi

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  # Only ever drops a database this script created, by prefix.
  case "$SCRATCH_DB" in
    preflight_c1_fixture_*)
      psql -d postgres -Atc "drop database if exists \"$SCRATCH_DB\"" >/dev/null 2>&1 || true
      ;;
  esac
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "fixture subject : $PREFLIGHT"
echo "subject sha256  : $(sha256sum "$PREFLIGHT" | cut -d' ' -f1)"
echo "scratch database: $SCRATCH_DB"

# ---------------------------------------------------------------------------
# Scratch DB — only the two columns C1 reads, plus id/status for c1_run_status
# ---------------------------------------------------------------------------
psql -d postgres -Atc "create database \"$SCRATCH_DB\"" >/dev/null
psql -d "$SCRATCH_DB" -Atc "
  create table runs (
    id uuid primary key,
    status varchar(16) not null,
    thread jsonb not null default '[]'::jsonb,
    metadata jsonb not null default '{}'::jsonb
  )" >/dev/null

# add_run <run_id> <task_id> <status> <verdict-or-empty>
add_run() {
  local run_id="$1" task_id="$2" status="$3" verdict="${4:-}"
  local thread='[]'
  if [ -n "$verdict" ]; then
    thread="$(jq -cn --arg v "$verdict" '[
      {role:"user",   content:"Review this lane. End with VERDICT: PASS or VERDICT: NEEDS_FIXES."},
      {role:"assistant", content:("… full review text …\nVERDICT: " + $v)}
    ]')"
  fi
  psql -d "$SCRATCH_DB" -Atc "
    insert into runs (id, status, thread, metadata)
    values ('$run_id', '$status', '$(printf '%s' "$thread" | sed "s/'/''/g")'::jsonb,
            jsonb_build_object('task_id','$task_id'))" >/dev/null
}

# ---------------------------------------------------------------------------
# Fixture HTTP server
# ---------------------------------------------------------------------------
SERVE_ROOT="$WORK/serve"
mkdir -p "$SERVE_ROOT/api/projects"
PROJECT_FILE="$SERVE_ROOT/api/projects/$PROJECT_ID"

PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SERVE_ROOT" >"$WORK/http.log" 2>&1 &
SERVER_PID=$!

echo '{"tasks":[]}' >"$PROJECT_FILE"
for _ in $(seq 1 50); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/projects/$PROJECT_ID" -o /dev/null && break
  sleep 0.1
done
curl -sf -m 2 "http://127.0.0.1:$PORT/api/projects/$PROJECT_ID" -o /dev/null \
  || { echo "FIXTURE ABORT — fixture HTTP server never came up on $PORT"; exit 2; }
echo "fixture API     : http://127.0.0.1:$PORT"
echo

# ---------------------------------------------------------------------------
# Task-graph builders
# ---------------------------------------------------------------------------
# reviewer_row <workstream> <round> <task_id> <status> <run_id|null> <title>
reviewer_row() {
  jq -cn --arg ws "$1" --argjson round "$2" --arg id "$3" --arg status "$4" \
        --arg run "$5" --arg title "$6" \
    '{id:$id, round:$round, workstream:$ws, role:"reviewer",
      status:$status, title:$title,
      run_id: (if $run == "null" then null else $run end)}'
}

# The five lane workstreams, all green, in every case — `main` is the variable.
LANE_ROWS=()
lane_seed() {
  local i=1 lane
  for lane in vault surfaces connections business perf; do
    local tid="aaaaaaaa-0000-4000-8000-00000000000$i"
    local rid="bbbbbbbb-0000-4000-8000-00000000000$i"
    LANE_ROWS+=("$(reviewer_row "$lane" 5 "$tid" done "$rid" "Re-review · $lane")")
    add_run "$rid" "$tid" completed PASS
    i=$((i + 1))
  done
}
lane_seed

write_graph() {  # write_graph <main-row-json>...
  local rows=("${LANE_ROWS[@]}" "$@")
  printf '%s\n' "${rows[@]}" | jq -s '{tasks: .}' >"$PROJECT_FILE"
}

# ---------------------------------------------------------------------------
# Case runner — sources the REAL preflight and calls check_c1, nothing else
# ---------------------------------------------------------------------------
CASES_RUN=0
CASES_BAD=0

# run_case <name> <expect: PASS|FAIL> <self-run-uuid-or-empty> <must-contain>...
run_case() {
  local name="$1" expect="$2" self="$3"; shift 3
  local out rc
  CASES_RUN=$((CASES_RUN + 1))
  set +e
  out="$(FORGE_CONTROL_API="http://127.0.0.1:$PORT" PGDATABASE="$SCRATCH_DB" FORGE_RUN_UUID="$self" \
    bash -c 'source "$1"; check_c1; [ "$FAIL_COUNT" -eq 0 ]' _ "$PREFLIGHT" 2>&1)"
  rc=$?
  set -e

  local got="PASS"; [ "$rc" -ne 0 ] && got="FAIL"
  local ok=1
  [ "$got" = "$expect" ] || ok=0
  local needle
  for needle in "$@"; do
    grep -qF -- "$needle" <<<"$out" || { ok=0; echo "    MISSING FROM OUTPUT: $needle"; }
  done

  if [ "$ok" -eq 1 ]; then
    echo "  ok   — $name (C1 $got, as expected)"
  else
    CASES_BAD=$((CASES_BAD + 1))
    echo "  BAD  — $name (expected C1 $expect, got $got)"
    sed 's/^/       | /' <<<"$out"
  fi
}

MAIN_T14="cccccccc-0000-4000-8000-000000000014"
MAIN_R14="dddddddd-0000-4000-8000-000000000014"
MAIN_T16="cccccccc-0000-4000-8000-000000000016"
MAIN_R16="dddddddd-0000-4000-8000-000000000016"
MAIN_T18="cccccccc-0000-4000-8000-000000000018"
MAIN_R18="dddddddd-0000-4000-8000-000000000018"
MAIN_T16B="cccccccc-0000-4000-8000-00000000016b"
MAIN_R16B="dddddddd-0000-4000-8000-00000000016b"
CALLER_RUN="eeeeeeee-0000-4000-8000-0000000000ca"

echo "── the eight cases ──────────────────────────────────────────────────────"

# 1. TEETH. An unrun re-review seeded above a NEEDS_FIXES must NOT launder it.
#    This is the exact hole the loosening could have opened, and it is the first
#    thing asserted. (It is also the live phase-7 shape at round 15.)
add_run "$MAIN_R14" "$MAIN_T14" completed NEEDS_FIXES
write_graph \
  "$(reviewer_row main 14 "$MAIN_T14" done "$MAIN_R14" 'Phase 7 pre-deploy gate')" \
  "$(reviewer_row main 16 "$MAIN_T16" pending null 'Re-review after fix cycle 1')"
run_case "unrun re-review does not launder a NEEDS_FIXES" FAIL "$CALLER_RUN" \
  "main=NEEDS_FIXES" \
  "SKIP round 16" \
  "never run, no run_id"

# 2. GREEN BASELINE + the deploy's own point of call. Round 16 has now run and
#    PASSed; round 18 (the post-deploy gate) is still pending. This is what the
#    deploy task sees, and under the OLD selection it read `main=not-yet-run`.
add_run "$MAIN_R16" "$MAIN_T16" completed PASS
write_graph \
  "$(reviewer_row main 14 "$MAIN_T14" done "$MAIN_R14" 'Phase 7 pre-deploy gate')" \
  "$(reviewer_row main 16 "$MAIN_T16" done "$MAIN_R16" 'Re-review after fix cycle 1')" \
  "$(reviewer_row main 18 "$MAIN_T18" pending null 'Phase 7 GATE')"
run_case "cleared blocker + pending post-deploy gate passes" PASS "$CALLER_RUN" \
  "main: PASS (round 16" \
  "SKIP round 18" \
  "1 reviewer row(s) skipped"

# 3. THE CALLER DOES NOT JUDGE ITSELF. Round 18 is running, and its run IS this
#    script's caller. Under the OLD selection this was `main=unparseable`, which
#    is the third and last unsatisfiable point.
add_run "$CALLER_RUN" "$MAIN_T18" running ""
write_graph \
  "$(reviewer_row main 16 "$MAIN_T16" done "$MAIN_R16" 'Re-review after fix cycle 1')" \
  "$(reviewer_row main 18 "$MAIN_T18" running "$CALLER_RUN" 'Phase 7 GATE')"
run_case "post-deploy gate running its own preflight" PASS "$CALLER_RUN" \
  "caller's own run, C1 does not judge itself" \
  "main: PASS (round 16"

# 4. A FOREIGN reviewer still in flight is skipped for a different, stated
#    reason — run status, not identity. FORGE_RUN_UUID is deliberately empty
#    here, so rule 2 cannot be what saves it.
psql -d "$SCRATCH_DB" -Atc "delete from runs where id='$MAIN_R18'" >/dev/null
add_run "$MAIN_R18" "$MAIN_T18" running ""
write_graph \
  "$(reviewer_row main 16 "$MAIN_T16" done "$MAIN_R16" 'Re-review after fix cycle 1')" \
  "$(reviewer_row main 18 "$MAIN_T18" running "$MAIN_R18" 'Phase 7 GATE')"
run_case "a foreign reviewer still in flight is skipped" PASS "" \
  "reviewer still in flight (run status=running)" \
  "FORGE_RUN_UUID is unset" \
  "main: PASS (round 16"

# 5. TEETH. The same row, same missing verdict — but the run has ENDED. A
#    reviewer that died without speaking must block the deploy, and must NOT be
#    laundered by the round-16 PASS underneath it.
psql -d "$SCRATCH_DB" -Atc "update runs set status='failed' where id='$MAIN_R18'" >/dev/null
run_case "a reviewer that ended without a VERDICT blocks" FAIL "" \
  "main=unparseable" \
  "a reviewer that ended without a verdict blocks the deploy"

# 6. TEETH. A workstream whose every reviewer row was skipped fails; it does not
#    fall through to a vacuous green.
write_graph \
  "$(reviewer_row main 16 "$MAIN_T16" pending null 'Re-review after fix cycle 1')" \
  "$(reviewer_row main 18 "$MAIN_T18" pending null 'Phase 7 GATE')"
run_case "no reviewer has ever run for a workstream" FAIL "$CALLER_RUN" \
  "main=no-completed-reviewer" \
  "no reviewer has ever produced a verdict"

# 7. TEETH. Two reviewers at the SAME round, one PASS and one NEEDS_FIXES —
#    `main` really does carry two round-6 rows in this project. The old
#    `sort_by(.round) | last` picked one of them on array order; the band rule
#    judges both, so the NEEDS_FIXES cannot hide behind a sibling.
psql -d "$SCRATCH_DB" -Atc "delete from runs where id='$MAIN_R16B'" >/dev/null
add_run "$MAIN_R16B" "$MAIN_T16B" completed NEEDS_FIXES
write_graph \
  "$(reviewer_row main 16 "$MAIN_T16" done "$MAIN_R16" 'Re-review after fix cycle 1 (a)')" \
  "$(reviewer_row main 16 "$MAIN_T16B" done "$MAIN_R16B" 'Re-review after fix cycle 1 (b)')" \
  "$(reviewer_row main 18 "$MAIN_T18" pending null 'Phase 7 GATE')"
run_case "a NEEDS_FIXES sibling at the same round still blocks" FAIL "$CALLER_RUN" \
  "main=NEEDS_FIXES"

# 8. TEETH. The pre-existing failure modes must survive the rewrite: a
#    workstream with no live reviewer row at all.
write_graph \
  "$(reviewer_row main 18 "$MAIN_T18" done "$MAIN_R18" '[MERGED] Phase 7 GATE')"
run_case "every reviewer row [MERGED] is still no-reviewer" FAIL "$CALLER_RUN" \
  "main=no-reviewer"

echo
echo "────────────────────────────────────────────────────────────────────────"
echo "FIXTURE: $CASES_RUN cases — $((CASES_RUN - CASES_BAD)) as expected, $CASES_BAD wrong"
if [ "$CASES_BAD" -eq 0 ]; then
  echo "FIXTURE: PASS"
  exit 0
fi
echo "FIXTURE: FAIL"
exit 1
