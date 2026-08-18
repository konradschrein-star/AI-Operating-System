#!/usr/bin/env bash
# check-schedule-sql.sh — execute the instrument's SQL against a THROWAWAY
# PostgreSQL cluster, and exit non-zero if any statement fails to resolve.
#
# WHY THIS EXISTS. Round 810 ran `forge-control/src/lib/schedule-source.ts` for
# the first time and it died on every project, before reading a row, with
# `operator does not exist: uuid = text`: `$1` was bound in two contexts forcing
# two different types in one statement. `tsc` cannot see that — the query is a
# string literal and the resolution happens inside Postgres. Neither could any
# unit test, because NF3 forbids the suite opening a connection, so the module
# shipped with its SQL untested and the untested path surfaced in the one task
# that has no worktree fallback.
#
# This script closes that hole without weakening NF3. `schedule-source.test.ts`
# §4.2 is SKIPPED unless `SCHEDULE_SOURCE_TEST_DSN` is set, so `pnpm test` still
# opens nothing. This script sets it — pointed at a cluster it creates itself,
# in a fresh directory, on a unix socket, listening on no network address, and
# stopped again on exit. It touches no configured database and reads no live
# data, so it is runnable from a build task under the worktree-only policy
# (`03-quality.md` §2.3).
#
# THE SKIP IS THE RISK, SO THE SKIP IS LOUD. A gate nobody runs is a gate that
# is disclosed around; this script is the one command that runs it, and it fails
# rather than skips if the suite reports zero executed tests.
#
# Usage:  scripts/check-schedule-sql.sh
# Exit:   0 — every shipped statement resolved, and the uncast form still fails
#         1 — a statement failed, or the suite could not be executed at all
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH_DB="schedule_sql_check"   # must match SCRATCH_DB in schedule-source.test.ts

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  if command -v initdb >/dev/null 2>&1; then
    PGBIN="$(dirname "$(command -v initdb)")"
  else
    echo "FAIL: no initdb found. This check needs PostgreSQL's server binaries" >&2
    echo "      (Debian/Ubuntu: /usr/lib/postgresql/<v>/bin, package postgresql-<v>)." >&2
    exit 1
  fi
fi

# initdb refuses to run as root, so when we are root the cluster is owned by the
# postgres system user. The socket directory stays world-readable so the test
# process — running as the invoking user — can connect to it.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  if ! id postgres >/dev/null 2>&1; then
    echo "FAIL: running as root and there is no 'postgres' user to own the scratch cluster." >&2
    exit 1
  fi
  RUNAS="postgres"
fi

CLUSTER="${TMPDIR:-/tmp}/schedule-sql-check.$$"
SOCK="$CLUSTER/sock"
PORT=5432

as_pg() {
  if [ -n "$RUNAS" ]; then su -s /bin/bash "$RUNAS" -c "$1"; else bash -c "$1"; fi
}

stopped=0
cleanup() {
  if [ "$stopped" = "0" ] && [ -f "$CLUSTER/data/postmaster.pid" ]; then
    as_pg "$PGBIN/pg_ctl -D $CLUSTER/data -m immediate -w stop" >/dev/null 2>&1 || true
  fi
  # The cluster directory is LEFT ON DISK deliberately: this repo's standing
  # rules reserve `rm -rf` for an explicit instruction, and a scratch tree under
  # TMPDIR costs nothing. Its path is printed so it can be removed by hand.
  echo "scratch cluster left at $CLUSTER (server stopped; remove it when you like)"
}
trap cleanup EXIT

mkdir -p "$CLUSTER/data" "$SOCK"
chmod 755 "$CLUSTER" "$SOCK"
if [ -n "$RUNAS" ]; then chown -R "$RUNAS" "$CLUSTER"; fi

echo "== check-schedule-sql — provenance =="
echo "repo:            $REPO"
echo "git-head:        $(git -C "$REPO" rev-parse HEAD)$(test -n "$(git -C "$REPO" status --porcelain)" && echo ' -dirty')"
echo "statements from: forge-control/src/lib/schedule-source.ts"
echo "                 $(sha256sum "$REPO/forge-control/src/lib/schedule-source.ts" | cut -d' ' -f1)"
echo "postgres:        $("$PGBIN/postgres" --version)"
echo "cluster:         $CLUSTER (throwaway, unix socket only, no network listener)"
echo

as_pg "$PGBIN/initdb -D $CLUSTER/data -U postgres -A trust" > "$CLUSTER/initdb.log" 2>&1
as_pg "$PGBIN/pg_ctl -D $CLUSTER/data -l $CLUSTER/pg.log -o \"-c listen_addresses='' -k $SOCK -p $PORT\" -w start"
as_pg "$PGBIN/createdb -h $SOCK -p $PORT -U postgres $SCRATCH_DB"

DSN="postgresql://postgres@/$SCRATCH_DB?host=$SOCK&port=$PORT"

set +e
( cd "$REPO/forge-control" && SCHEDULE_SOURCE_TEST_DSN="$DSN" ./node_modules/.bin/tsx --test src/lib/schedule-source.test.ts ) > "$CLUSTER/test.out" 2>&1
rc=$?
set -e
cat "$CLUSTER/test.out"

as_pg "$PGBIN/pg_ctl -D $CLUSTER/data -m fast -w stop" >/dev/null
stopped=1

# POSITIVE CONTROLS, BEFORE THE VERDICT (00-vision.md §7 rule 2).
#
# MEASURED, NOT ASSUMED: when §4.2 is skipped, node:test counts the whole suite
# as ONE PASSING SUITE and reports `# skipped 0` — the summary line looks
# identical to a run that executed it. So the controls name the two things that
# are actually distinguishable: the skip marker must be absent, and the
# regression test must appear by name in the passing output.
if grep -q '# SKIP SCHEDULE_SOURCE_TEST_DSN' "$CLUSTER/test.out"; then
  echo
  echo "FAIL: the executing suite SKIPPED — SCHEDULE_SOURCE_TEST_DSN did not reach it, so the" >&2
  echo "      SQL was never executed and this run must not report a pass." >&2
  exit 1
fi
if ! grep -q 'THE REGRESSION: readProjectRows() completes end to end' "$CLUSTER/test.out"; then
  echo
  echo "FAIL: the regression test did not appear in the output at all. Either it was renamed" >&2
  echo "      and this control was not updated with it, or the suite did not run." >&2
  exit 1
fi
if ! grep -qE '^# pass [1-9]' "$CLUSTER/test.out"; then
  echo
  echo "FAIL: no test reported a pass — the suite did not run." >&2
  exit 1
fi

exit "$rc"
