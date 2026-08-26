#!/usr/bin/env bash
# prove-idle-alarm-bites.sh — the mutation control for the two sections R70's
# sibling task added to scripts/ops/stalled-projects.sh: "FINISHED BUT STILL
# ACTIVE" and the "FLEET-WIDE OPEN WORK" idle-fleet alarm line.
#
# WHY THIS FILE EXISTS. Both new sections return ZERO rows on live data the
# moment the R70 fix ships — that is the whole point of shipping R70, but it
# also means a green run of stalled-projects.sh proves nothing about either
# section from that day forward. A section that has never been OBSERVED
# returning a row is indistinguishable from a typo in its `having` clause.
# This fleet has already shipped, on the same day, a gate that could not fail
# (check-ops-scripts.sh's 750 assertion, main forever) and a gate that could
# not pass (the same file wired into gates-808.sh) in two projects that could
# not see each other. This script is the standing answer for these two
# sections: construct the shape, watch the section fire, mutate the shape,
# watch it go quiet, on demand, forever — not a transcript pasted into a
# comment once and trusted after.
#
# SHAPE FOLLOWED, AND WHY. scripts/checks/prove-it-bites.sh is the generic
# "mutate a FILE, watch a CHECK go red" harness — it EXPECTS the mutation and
# the subject to be the same file's bytes (md5-before/md5-after). That does
# not fit here: what changes between RED and GREEN is not a byte in
# stalled-projects.sh, it is a ROW in a database. scripts/checks/
# prove-ops-mode-bites.sh is the closer model — a self-contained bash script
# that builds a throwaway fixture (there: a scratch directory + chmod; here: a
# scratch database + two INSERTs), drives the real subject script across two
# states, and asserts the two states print differently — so THIS script
# follows prove-ops-mode-bites.sh's shape: no --subject/--mutation flags, a
# fixed sequence, a single EXIT trap for cleanup. It borrows two things from
# check-close-gate.ts instead, because that file is the one in this repo that
# already solved them correctly for a Postgres-backed control: the
# refuse-to-run guard (never invent credentials, never touch a protected
# database) and the EXPECTED_ASSERTIONS accounting (a probe that silently
# never ran must fail the run, not certify it).
#
# WHAT IT DOES NOT DO. It does not edit scripts/ops/stalled-projects.sh — that
# file is the task before this one's write_set, not this one's. It never
# writes to content_forge: the only write surface is a throwaway scratch
# database, and even there the only writes are two fixture rows, inserted and
# then deleted again on exit. It is HAND-RUN ONLY (see below) and must NEVER
# be added to gates-808.sh: a check that needs a scratch database, wired into
# the shared suite, makes that suite red for every project on the branch
# forever, on a gate none of them touched (memory note
# shared-suite-gate-that-cannot-pass) — the exact mistake this fleet already
# made and paid a fix cycle for on 2026-08-25 with check-ops-scripts.sh.
#
# ─────────────────────────────────────────────────────────────────────────
# HAND-RUN ONLY. Two environment variables, both consumed and neither invented:
#
#   SCRATCH_DATABASE_URL   an EXISTING, local, throwaway postgres database —
#                          never content_forge, postgres, template0/template1,
#                          and never a database this fleet's own config names
#                          (checked against /opt/forge-ai-os/.env,
#                          /opt/content-forge/.env, /opt/ai-os/.secrets/*.env).
#                          Refused loudly, exit 2, if unset, unparsable, or
#                          protected. This is the SAME variable
#                          check-close-gate.ts consumes, for the same reason.
#
#   DATABASE_URL           the LIVE fleet database. Used exactly once, READ
#                          ONLY, for `pg_dump -s` of the three tables this
#                          control needs (projects, project_tasks, runs) —
#                          never written to. Every worker shell already
#                          inherits this (memory note
#                          worker-shell-inherits-database-url); if it is
#                          somehow unset, source the usual secrets file first.
#                          Skipped entirely once the scratch database already
#                          carries the schema (idempotent — see step 2 below).
#
# OPERATOR PREAMBLE (run once, by hand — the recipe named in this task's brief,
# mirroring check-close-gate.ts's own header and the recipe recorded in memory
# note scratch-db-fixture-for-projects-and-project-tasks):
#
#   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
#   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_idle_alarm_scratch'
#   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_idle_alarm_scratch"
#   bash scripts/checks/prove-idle-alarm-bites.sh
#
# The CREATE DATABASE step is authorised only while connected to the
# `postgres` MAINTENANCE database (as above) and never against content_forge.
# Re-running the script is safe and idempotent: the schema load is skipped the
# second time (step 2 checks for it first), and stale fixture rows from a
# prior crash are deleted before new ones are seeded.
#
# EXIT CODES — there is no silent fallback:
#   0  BITES     — every assertion passed, and exactly EXPECTED_ASSERTIONS ran.
#   1  INERT     — at least one assertion failed: a section did not
#                  discriminate between the RED and GREEN database states.
#   2  refuse / usage / setup error — bad or missing environment, a missing
#                  binary, a schema load that failed. Not a verdict on the
#                  sections under test.
#   3  PROBE COUNT MISMATCH — fewer (or more) assertions ran than declared.
#                  A sweep whose probes silently skipped must fail, not
#                  certify itself (mirrors check-close-gate.ts's own rule).
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STALLED_SH="$REPO/scripts/ops/stalled-projects.sh"

refuse() {
  echo "REFUSING TO RUN: $1" >&2
  exit 2
}

[ -f "$STALLED_SH" ] || refuse "cannot find $STALLED_SH — run this from inside the ai-os worktree."
[ -x "$STALLED_SH" ] || refuse "$STALLED_SH exists but is not executable."
command -v psql    >/dev/null 2>&1 || refuse "psql is not on PATH."
command -v pg_dump >/dev/null 2>&1 || refuse "pg_dump is not on PATH."
command -v sha256sum >/dev/null 2>&1 || refuse "sha256sum is not on PATH."

# ── 1. refuse-to-run guard, ported from check-close-gate.ts ────────────────
# Never invent credentials; never touch a protected database. Checked BEFORE
# a single statement is issued.
SCRATCH_URL="${SCRATCH_DATABASE_URL:-}"
[ -n "$SCRATCH_URL" ] || refuse "\$SCRATCH_DATABASE_URL is unset. This control never guesses a connection string — see the OPERATOR PREAMBLE in this file's header."

SCRATCH_URL_RE='^postgres(ql)?://([^@/]*@)?([^:/]+)(:[0-9]+)?/(.*)$'
if [[ "$SCRATCH_URL" =~ $SCRATCH_URL_RE ]]; then
  SCRATCH_HOST="${BASH_REMATCH[3]}"
  SCRATCH_DBNAME="${BASH_REMATCH[5]%%\?*}"
else
  refuse "\$SCRATCH_DATABASE_URL does not parse as a postgres:// URL."
fi
[ -n "$SCRATCH_DBNAME" ] || refuse "\$SCRATCH_DATABASE_URL names no database."

case "$SCRATCH_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) refuse "scratch database must be local; host resolved to '$SCRATCH_HOST'." ;;
esac

case "$SCRATCH_DBNAME" in
  content_forge|postgres|template0|template1)
    refuse "'$SCRATCH_DBNAME' is a protected database. Point \$SCRATCH_DATABASE_URL at a throwaway scratch database." ;;
esac

# Also refuse any database name this fleet's own config files mention — the
# same live-name scan check-close-gate.ts runs before it issues anything.
LIVE_NAMES=""
for f in /opt/forge-ai-os/.env /opt/content-forge/.env /opt/ai-os/.secrets/*.env; do
  [ -f "$f" ] || continue
  while IFS= read -r url; do
    dbpart="${url##*/}"; dbpart="${dbpart%%\?*}"
    [ -n "$dbpart" ] && LIVE_NAMES="$LIVE_NAMES $dbpart"
  done < <(grep -oE 'postgres(ql)?://[^[:space:]"'"'"']+' "$f" 2>/dev/null)
done
for n in $LIVE_NAMES; do
  [ "$n" = "$SCRATCH_DBNAME" ] && refuse "'$SCRATCH_DBNAME' is a database this fleet runs on (found in fleet config). Use a throwaway scratch database."
done

# Prove the guard actually connects to what it validated, before trusting it.
psql "$SCRATCH_URL" -Atc 'SELECT 1' >/dev/null 2>&1 || refuse "could not connect to \$SCRATCH_DATABASE_URL (database '$SCRATCH_DBNAME' on '$SCRATCH_HOST'). Create it per the OPERATOR PREAMBLE first."

echo "scratch database validated: '$SCRATCH_DBNAME' on $SCRATCH_HOST (DSN never printed)"

# ── fixture identity + cleanup, installed only once the guard above passed ─
FIX_PID="00000000-0000-4000-9000-0000000a1a01"
FIX_T1="00000000-0000-4000-9000-0000000a1a02"
FIX_T2="00000000-0000-4000-9000-0000000a1a03"

wipe_fixture() {
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM project_tasks WHERE project_id = '$FIX_PID'" >/dev/null
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM projects WHERE id = '$FIX_PID'" >/dev/null
}

cleanup() {
  local rc=$?
  echo
  echo "-- cleanup: removing fixture rows ($FIX_PID) from '$SCRATCH_DBNAME' --"
  wipe_fixture
  exit "$rc"
}
trap cleanup EXIT
# bash skips an EXIT trap on an untrapped fatal signal (memory note
# bash-exit-trap-skipped-on-untrapped-signal) — trap these explicitly so the
# fixture is still removed on ^C or a killed session.
trap 'exit 130' INT TERM HUP

# ── 2. schema, loaded once and only once (idempotent across re-runs) ───────
HAVE_SCHEMA="$(psql "$SCRATCH_URL" -Atc "SELECT to_regclass('public.projects') IS NOT NULL")"
if [ "$HAVE_SCHEMA" != "t" ]; then
  echo "-- loading projects/project_tasks/runs schema into '$SCRATCH_DBNAME' (first run) --"
  [ -n "${DATABASE_URL:-}" ] || refuse "schema must be loaded from \$DATABASE_URL (the live fleet DB, schema-only, read-only) but it is unset."
  # pg_trgm FIRST: the dump carries gin_trgm_ops indexes, and under
  # ON_ERROR_STOP=1 they abort the load partway through if the extension is
  # missing — memory note scratch-db-fixture-for-projects-and-project-tasks.
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null
  TMP_SCHEMA="$(mktemp /tmp/idle-alarm-scratch-schema.XXXXXX.sql)"
  # runs is dumped too even though no fixture below touches it: stalled-
  # projects.sh's ZOMBIE section joins it unconditionally, and Q()'s hardened
  # guard aborts the WHOLE script with exit 2 the moment a query fails to
  # compile, before this control's own assertions ever run.
  pg_dump "$DATABASE_URL" -s -t public.projects -t public.project_tasks -t public.runs > "$TMP_SCHEMA"
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f "$TMP_SCHEMA"
  rm -f "$TMP_SCHEMA"
else
  echo "-- schema already present in '$SCRATCH_DBNAME' — skipping load --"
fi

# Stale rows from a prior crashed run would corrupt the RED state below
# (the project would start with two tasks, not one) — wipe before seeding.
wipe_fixture

# ── 3. build identity — printed before a single assertion ──────────────────
GIT_HEAD="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '<unknown>')"
GIT_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<unknown>')"
GIT_DIRTY="$(git -C "$REPO" status --porcelain -- "$STALLED_SH" 2>/dev/null)"
SHA256_STALLED="$(sha256sum "$STALLED_SH" | awk '{print $1}')"

EXPECTED_ASSERTIONS=10
ASSERTIONS_RUN=0
ASSERTIONS_FAILED=0

echo "=== prove-idle-alarm-bites.sh — build identity ================================"
echo "  repo worktree        : $REPO"
echo "  git HEAD             : $GIT_HEAD"
echo "  git branch           : $GIT_BRANCH"
echo "  subject uncommitted  : ${GIT_DIRTY:-(clean)}"
echo "  sha256(stalled-projects.sh actually exercised): $SHA256_STALLED"
echo "  scratch database     : $SCRATCH_DBNAME (local; DSN never printed)"
echo "  expected assertions  : $EXPECTED_ASSERTIONS"
echo "================================================================================="
echo

# ── assertion helpers ────────────────────────────────────────────────────
pass() { ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1)); printf '      ok   %s\n' "$1"; }
fail() { ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1)); ASSERTIONS_FAILED=$((ASSERTIONS_FAILED + 1)); printf '      FAIL %s -- %s\n' "$1" "$2" >&2; }

assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1 (= $3)"; else fail "$1" "expected [$2] got [$3]"; fi
}
assert_contains() { # name haystack needle
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1" "did not find [$3]" ;;
  esac
}
assert_not_contains() { # name haystack needle
  case "$2" in
    *"$3"*) fail "$1" "unexpectedly found [$3]" ;;
    *) pass "$1" ;;
  esac
}

# Isolates one `== HEADER ==` section's body out of stalled-projects.sh's
# stdout, so an assertion about "FINISHED BUT STILL ACTIVE" cannot be
# satisfied by the fixture name showing up in some unrelated section.
section_body() {
  awk -v hdr="$2" '
    /^== / {
      if (found) exit
      if (index($0, hdr)) { found = 1 }
      next
    }
    found { print }
  ' <<< "$1"
}

# ── 4. fixtures + RUN 1 (RED): one project, one DONE task, zero open work ──
echo "--- seeding RED state: active project, 1 done task, 0 non-terminal tasks -----"
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO projects (id, name, brief, repo, base_branch, status)
  VALUES ('$FIX_PID', 'idle-alarm-fixture', 'fixture', 'ai-os', 'main', 'active')
" >/dev/null
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, depends_on)
  VALUES ('$FIX_T1', '$FIX_PID', 1, 'builder', 'idle-fixture-t1', 'fixture', 'done', 'main', NULL)
" >/dev/null

FIXTURE_TASK_COUNT="$(psql "$SCRATCH_URL" -Atc "SELECT count(*) FROM project_tasks WHERE project_id = '$FIX_PID'")"
assert_eq "RED fixture seeded with exactly one task" "1" "$FIXTURE_TASK_COUNT"

echo
echo "--- RUN 1 (RED): stalled-projects.sh against the scratch database -------------"
OUT1="$(STALLED_PROJECTS_DB_URL="$SCRATCH_URL" "$STALLED_SH" 2>&1)"; RC1=$?
echo "$OUT1" | sed 's/^/      | /'
echo "      exit=$RC1"
echo

BODY1_SECTION1="$(section_body "$OUT1" "FINISHED BUT STILL ACTIVE")"
BODY1_FLEET="$(section_body "$OUT1" "FLEET-WIDE OPEN WORK")"

assert_eq "RED: stalled-projects.sh exits 1 (something is stalled)" "1" "$RC1"
assert_contains "RED: FINISHED BUT STILL ACTIVE names the fixture project" "$BODY1_SECTION1" "idle-alarm-fixture"
assert_contains "RED: fleet-wide alarm fires on zero open rows" "$BODY1_FLEET" "THE FLEET HAS NOTHING QUEUED"

# The header itself declares this detector read-only — prove it rather than
# take the comment's word: a project row it merely REPORTS on must not move.
FIXTURE_STATUS_AFTER_RUN1="$(psql "$SCRATCH_URL" -Atc "SELECT status FROM projects WHERE id = '$FIX_PID'")"
assert_eq "RED: the detector is read-only — fixture project still 'active' after RUN 1" "active" "$FIXTURE_STATUS_AFTER_RUN1"

# ── 5. mutate to GREEN: give the same project one pending (open) task ──────
echo "--- mutating to GREEN state: same project, +1 pending task --------------------"
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, workstream, depends_on)
  VALUES ('$FIX_T2', '$FIX_PID', 1, 'builder', 'idle-fixture-t2', 'fixture', 'pending', 'main', NULL)
" >/dev/null

FIXTURE_TASK_COUNT2="$(psql "$SCRATCH_URL" -Atc "SELECT count(*) FROM project_tasks WHERE project_id = '$FIX_PID'")"
assert_eq "GREEN fixture now carries two tasks (1 done + 1 pending)" "2" "$FIXTURE_TASK_COUNT2"

echo
echo "--- RUN 2 (GREEN): stalled-projects.sh against the mutated scratch database ---"
OUT2="$(STALLED_PROJECTS_DB_URL="$SCRATCH_URL" "$STALLED_SH" 2>&1)"; RC2=$?
echo "$OUT2" | sed 's/^/      | /'
echo "      exit=$RC2"
echo

BODY2_SECTION1="$(section_body "$OUT2" "FINISHED BUT STILL ACTIVE")"
BODY2_FLEET="$(section_body "$OUT2" "FLEET-WIDE OPEN WORK")"

assert_eq "GREEN: stalled-projects.sh exits 0 (clear)" "0" "$RC2"
assert_not_contains "GREEN: FINISHED BUT STILL ACTIVE no longer names the fixture project" "$BODY2_SECTION1" "idle-alarm-fixture"
assert_not_contains "GREEN: fleet-wide alarm does not fire with one open row" "$BODY2_FLEET" "THE FLEET HAS NOTHING QUEUED"
assert_contains "GREEN: overall verdict reads clear" "$OUT2" "clear — no silently stopped projects."

# ── 6. summary — assertion accounting is itself an assertion of the run ────
echo
echo "=== summary ====================================================================="
echo "  assertions run    : $ASSERTIONS_RUN (expected $EXPECTED_ASSERTIONS)"
echo "  assertions failed : $ASSERTIONS_FAILED"

if [ "$ASSERTIONS_RUN" -ne "$EXPECTED_ASSERTIONS" ]; then
  echo "  PROBE COUNT MISMATCH: $ASSERTIONS_RUN ran, $EXPECTED_ASSERTIONS declared." >&2
  echo "  A control whose probes miss must fail, not certify itself." >&2
  exit 3
fi

if [ "$ASSERTIONS_FAILED" -gt 0 ]; then
  echo "  INERT — at least one section did not discriminate between RED and GREEN." >&2
  exit 1
fi

echo "  BITES — both sections fire on the RED state and go quiet on the GREEN one."
exit 0
