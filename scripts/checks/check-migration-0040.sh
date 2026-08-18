#!/usr/bin/env bash
#
# check-migration-0040.sh — the behavioural proof that db/migrations/
# 0040_task_graph.sql is re-runnable (R2), that its backfill is the FULL
# TRANSITIVE CLOSURE of today's round rule (R6), and that both R7 indexes are
# created by name.
#
# 03-quality.md §2.2 names this script and what it must prove:
#   "Creates a throwaway schema in a local scratch database, seeds it from the
#    replay fixture, applies 0040 twice, diffs the resulting project_tasks rows,
#    asserts the second application changed zero rows and the indexes exist."
#
# It is an INTEGRATION check, not a unit test: it needs a real Postgres, so it
# lives here and never runs inside `pnpm test` (NF3 — the unit suite is
# `tsx --test src/lib/*.test.ts`, hermetic, type-only imports of db/*).
#
# ---------------------------------------------------------------------------
# OPERATOR PREAMBLE — run these three lines once, by hand, before this script.
# This script NEVER invents credentials: it only consumes $SCRATCH_DATABASE_URL.
# Creating a scratch DATABASE on this host is authorised and conventional
# (forge_r850_dryrun, forge_r860_dryrun, fleet_selftest already exist beside
# it). Authorised means CREATE DATABASE issued while connected to the
# `postgres` MAINTENANCE database. It never means a statement of any kind
# against content_forge.
#
#   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
#   psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
#   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
#
# The password never enters this repo, a log, or a report. This script prints
# the resolved database NAME and never the DSN.
#
# ---------------------------------------------------------------------------
# HOW THE REAL project_tasks SHAPE IS BUILT — and which path was taken.
#
# PREFERRED path, taken: every db/migrations/*.sql below 0040 is applied in
# lexical order into the throwaway schema, so 0040 is proven to compose with
# the schema it will actually meet (0030's CREATE TABLE plus the ALTERs of
# 0032, 0034, 0035, 0037, 0038 and 0039, verbatim, not a hand-simplified
# replica).
#
# ONE deviation, forced and named: 0021_ai_os_tables.sql declares
# `inbox_items.related_job_id uuid REFERENCES content_jobs(id)` and
# `nudges.related_job_id` likewise, and NO migration in this repo creates
# content_jobs — it belongs to the content-forge pipeline schema that the AI OS
# tables were grafted onto. Applying 0021 into an empty schema therefore fails
# with `relation "content_jobs" does not exist`. Rather than fall back to
# extracting DDL by hand (which would make project_tasks a hand-copied replica
# and defeat the point), this script creates ONE placeholder outside-the-repo
# table — `content_jobs (id uuid primary key)` — purely to satisfy that foreign
# key, and then applies every migration for real. Nothing in project_tasks, its
# constraints or its indexes is hand-written here.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) AN EMPTY SEED. A check that certifies an empty table certifies nothing.
#       Guarded twice: the seeded row count must equal the fixture's own row
#       count AND be > 0 (assertions "seed rows > 0" / "seed count == fixture"),
#       and the closure verifier fails if it compares zero rows.
#   (b) COLUMNS ALREADY PRESENT from an earlier run, so `IF NOT EXISTS` silently
#       skips a broken DDL and the assertions read a column some previous
#       version created. Guarded by dropping and recreating the schema at the
#       start AND by the pre-flight assertion that all three columns and both
#       indexes are ABSENT immediately before pass 1. Pass 1 therefore really
#       executes the DDL under test.
#   (c) TWO SNAPSHOT FILES BOTH WRITTEN BY THE SAME FAILED QUERY, so `cmp`
#       compares two identical empty files and reports success. Guarded by
#       ON_ERROR_STOP plus an explicit non-empty + row-count assertion on EACH
#       snapshot before they are compared.
#   (d) A BACKFILL THAT ASSERTS ITSELF. The expected depends_on is recomputed in
#       Python from the fixture's own round/created_at values (helper
#       `expected_closure`), never by re-running the migration's SQL expression.
#   (e) PROBES THAT MISS. The script counts the assertions it actually executed
#       and exits non-zero if that count is below EXPECTED_ASSERTIONS. A sweep
#       whose probes miss must fail, never certify itself.
#
# Usage:  SCRATCH_DATABASE_URL=... scripts/checks/check-migration-0040.sh
# Exit:   0 = every assertion passed and every assertion ran.
#
set -euo pipefail
# An abort anywhere (a psql error under ON_ERROR_STOP, a missing file) must read
# as a FAILURE with a location, never as a quiet early return that a caller
# could mistake for "nothing to report".
trap 'rc=$?; [ $rc -ne 0 ] && echo "check-migration-0040.sh: ABORTED at line $LINENO (exit $rc) — NOT a pass" >&2' ERR

SCHEMA='tg_check_0040'
MIGRATION='db/migrations/0040_task_graph.sql'
FIXTURE='forge-control/src/lib/fixtures/replay-operator-visibility.json'
# The synthetic project the fixture rows hang off. Fixed, so reruns are
# byte-comparable; it exists only inside the throwaway schema.
PROJECT_ID='00000000-0000-4000-8000-00000000f1c1'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Every assertion this file defines. Kept in sync by hand and enforced at the
# end: if the counter comes in lower, probes were skipped and the run FAILS.
EXPECTED_ASSERTIONS=43
ASSERTIONS_RUN=0

pass() {
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
  printf '  ok   %-52s %s\n' "$1" "${2-}"
}
fail() {
  printf '  FAIL %-52s %s\n' "$1" "${2-}" >&2
  printf '\ncheck-migration-0040.sh FAILED after %d assertions\n' "$ASSERTIONS_RUN" >&2
  exit 1
}
assert_eq() {   # name expected actual
  [ "$2" = "$3" ] && pass "$1" "= $3" || fail "$1" "expected [$2] got [$3]"
}
assert_ne() {   # name notexpected actual
  [ "$2" != "$3" ] && pass "$1" "= $3" || fail "$1" "must not be [$2]"
}
assert_ge() {   # name floor actual
  [ "$3" -ge "$2" ] 2>/dev/null && pass "$1" "$3 >= $2" || fail "$1" "expected >= $2, got [$3]"
}
assert_has() {  # name haystack needle
  case "$2" in *"$3"*) pass "$1" "contains: $3" ;; *) fail "$1" "missing [$3] in [$2]" ;; esac
}

# ---------------------------------------------------------------------------
# 0. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
#    "A check that can be pointed at production by forgetting an environment
#    variable is an incident waiting for a tired night" (03-quality.md §2.2).
#    Resolves the target NAME, refuses content_forge, refuses any database this
#    fleet actually runs on (every DSN found in the fleet's env files), refuses
#    a non-local host, and prints the NAME only — never the DSN.
# ---------------------------------------------------------------------------
GUARD_OUT="$(SCRATCH_DATABASE_URL="${SCRATCH_DATABASE_URL-}" python3 - <<'PY'
import glob, os, re, sys
from urllib.parse import urlparse

dsn = os.environ.get('SCRATCH_DATABASE_URL', '').strip()
if not dsn:
    sys.exit('REFUSING TO RUN: $SCRATCH_DATABASE_URL is unset. This check never '
             'guesses a connection string; see the operator preamble in the header.')
try:
    u = urlparse(dsn)
except ValueError as exc:
    sys.exit(f'REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a parsable URL ({exc}).')
if u.scheme not in ('postgres', 'postgresql'):
    sys.exit('REFUSING TO RUN: $SCRATCH_DATABASE_URL is not a postgres:// URL.')

name = (u.path or '').lstrip('/').split('?')[0]
if not name:
    sys.exit('REFUSING TO RUN: $SCRATCH_DATABASE_URL names no database.')

host = u.hostname or 'localhost'
if host not in ('127.0.0.1', 'localhost', '::1'):
    # Never echo the DSN; the host alone is enough to diagnose.
    sys.exit(f'REFUSING TO RUN: scratch database must be local, host resolved to {host!r}.')

# Hard denylist: the live database by name, the maintenance database, and the
# templates. content_forge is named explicitly because it is THE database this
# fleet runs on and the one mistake this guard exists to prevent.
BANNED = {'content_forge', 'postgres', 'template0', 'template1'}

# Soft denylist, computed: every database named by a DSN in the fleet's own
# config. This is the "any database this fleet runs on" clause — it stays
# correct when a new service is added. The DSNs are read and discarded; only
# database NAMES are ever compared, and none of them is printed.
live = set()
for path in (glob.glob('/opt/ai-os/.secrets/*.env')
             + ['/opt/forge-ai-os/.env', '/opt/content-forge/.env']):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            blob = fh.read()
    except OSError:
        continue
    for m in re.finditer(r'postgres(?:ql)?://[^\s\'"]+', blob):
        try:
            live.add(urlparse(m.group(0)).path.lstrip('/').split('?')[0])
        except ValueError:
            continue
live.discard('')

if name in BANNED:
    sys.exit(f'REFUSING TO RUN: {name!r} is a protected database. Point '
             '$SCRATCH_DATABASE_URL at a throwaway scratch database.')
if name in live:
    sys.exit(f'REFUSING TO RUN: {name!r} is a database this fleet runs on '
             '(found in the fleet config). Use a throwaway scratch database.')

print(name)
PY
)" || { printf '%s\n' "$GUARD_OUT" >&2; exit 2; }
DB_NAME="$GUARD_OUT"

# ---------------------------------------------------------------------------
# 1. BUILD IDENTITY — printed before any assertion. A harness that does not
#    expose its own build identity is not evidence (standing rule 3).
# ---------------------------------------------------------------------------
HEAD_SHA="$(git rev-parse --short HEAD)"
HEAD_DIRTY="$(git status --porcelain -- "$MIGRATION" "$FIXTURE" | wc -l | tr -d ' ')"
MIGRATION_SHA256="$(sha256sum "$MIGRATION" | cut -d' ' -f1)"
FIXTURE_SHA256="$(sha256sum "$FIXTURE" | cut -d' ' -f1)"
FIXTURE_ROWS="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$FIXTURE")"

echo '=== check-migration-0040.sh — build identity ==================================='
echo "  repo worktree      : $REPO_ROOT"
echo "  git HEAD           : $HEAD_SHA"
echo "  uncommitted (subj) : $HEAD_DIRTY file(s) of {migration, fixture} modified"
echo "  migration          : $MIGRATION"
echo "  sha256(migration)  : $MIGRATION_SHA256"
echo "  fixture            : $FIXTURE"
echo "  sha256(fixture)    : $FIXTURE_SHA256"
echo "  fixture rows       : $FIXTURE_ROWS"
echo "  scratch database   : $DB_NAME (local; DSN never printed)"
echo "  throwaway schema   : $SCHEMA"
echo "  schema build path  : PREFERRED — every db/migrations/*.sql below 0040, in"
echo "                       lexical order. One forced placeholder: content_jobs,"
echo "                       FK target of 0021_ai_os_tables.sql, created by no"
echo "                       migration in this repo."
echo "  expected assertions: $EXPECTED_ASSERTIONS"
echo '==============================================================================='

WORK="$(mktemp -d -t check-0040-XXXXXX)"
echo "  artifacts          : $WORK"
echo

# psql helpers. -X ignores ~/.psqlrc, ON_ERROR_STOP turns any SQL error into a
# non-zero exit rather than a silently skipped statement.
psql_run() { PGOPTIONS="-c search_path=$SCHEMA" psql "$SCRATCH_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
q()        { psql_run -q -At -c "$1"; }

# ---------------------------------------------------------------------------
# 2. Throwaway schema, dropped and recreated so reruns start clean. This is the
#    guard against failure mode (b): the columns under test cannot survive from
#    a previous run and make `ADD COLUMN IF NOT EXISTS` a no-op.
#    Then: the real project_tasks shape, from the real migrations.
# ---------------------------------------------------------------------------
echo '--- 2. schema + migrations ----------------------------------------------------'
psql "$SCRATCH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA IF EXISTS $SCHEMA CASCADE" -c "CREATE SCHEMA $SCHEMA"
q "CREATE TABLE content_jobs (id uuid PRIMARY KEY)"   # the one forced placeholder; see header
applied=0
for f in db/migrations/*.sql; do
  case "$f" in *0040_task_graph.sql) continue ;; esac   # 0040 is the subject, applied later and twice
  psql_run -q -f "$f" >/dev/null
  applied=$((applied + 1))
done
echo "  applied $applied migrations below 0040 into $SCHEMA"
assert_eq 'project_tasks exists' 'project_tasks' \
  "$(q "SELECT table_name FROM information_schema.tables WHERE table_schema='$SCHEMA' AND table_name='project_tasks'")"
# Pre-flight (failure mode (b)): none of the four columns, neither index.
assert_eq 'pre-0040: none of the 4 columns present' '0' \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name IN ('depends_on','workstream','write_set','graph_frozen')")"
assert_eq 'pre-0040: neither R7 index present' '0' \
  "$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='$SCHEMA' AND indexname IN ('project_tasks_depends_on_gin','project_tasks_workstream_idx')")"
echo

# ---------------------------------------------------------------------------
# 3. Seed from the round-102 fixture: one synthetic projects row plus every
#    fixture task, run_id NULL. A check that certifies an empty database is the
#    self-certifying failure this fleet has already been burned by.
# ---------------------------------------------------------------------------
echo '--- 3. seed from the R9 fixture -----------------------------------------------'
python3 - "$FIXTURE" "$PROJECT_ID" > "$WORK/seed.sql" <<'PY'
import json, sys

fixture, project_id = sys.argv[1], sys.argv[2]
rows = json.load(open(fixture, encoding='utf-8'))
if not rows:
    sys.exit('fixture is empty — refusing to emit a seed that certifies nothing')

def lit(s):
    return "'" + str(s).replace("'", "''") + "'"

out = [
    "INSERT INTO projects (id, name, brief, repo, status) VALUES ("
    f"{lit(project_id)}, 'replay-operator-visibility (synthetic)', "
    "'Scratch project for check-migration-0040.sh. Not a real project.', "
    "'ai-os', 'active');"
]
# brief is NOT NULL in 0030 and the R9 fixture deliberately carries no brief
# text (it captures id/round/role/title/status/created_at only) — a stated
# placeholder, never a guessed reconstruction of what the real brief said.
BRIEF = 'R9 fixture row — brief text not captured by the fixture.'
for r in rows:
    out.append(
        "INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, run_id, created_at) VALUES ("
        f"{lit(r['id'])}, {lit(project_id)}, {int(r['round'])}, {lit(r['role'])}, "
        f"{lit(r['title'])}, {lit(BRIEF)}, {lit(r['status'])}, NULL, {lit(r['created_at'])}::timestamptz);"
    )
print('\n'.join(out))
PY
psql_run -q -f "$WORK/seed.sql" >/dev/null
SEEDED="$(q 'SELECT count(*) FROM project_tasks')"
echo "  seeded rows        : $SEEDED"
assert_ge 'seed rows > 0' 1 "$SEEDED"
assert_eq 'seed count == fixture rows' "$FIXTURE_ROWS" "$SEEDED"
assert_eq 'seed: every row starts non-graph (depends_on absent)' '0' \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='depends_on'")"
echo

# ---------------------------------------------------------------------------
# 4. Apply 0040, pass 1.
# ---------------------------------------------------------------------------
echo '--- 4. apply 0040, pass 1 -----------------------------------------------------'
psql_run -f "$MIGRATION" > "$WORK/pass1.out" 2> "$WORK/pass1.err" || fail 'pass 1 applies cleanly' "see $WORK/pass1.err"
sed 's/^/  | /' "$WORK/pass1.out"
[ -s "$WORK/pass1.err" ] && sed 's/^/  ! /' "$WORK/pass1.err"
PASS1_UPDATE="$(grep -E '^UPDATE [0-9]+$' "$WORK/pass1.out" | tail -1 || true)"
assert_eq 'pass 1 backfilled every seeded row' "UPDATE $SEEDED" "$PASS1_UPDATE"

# --- the three columns, their types and their defaults ---
assert_eq 'depends_on type is uuid[]'  '_uuid' \
  "$(q "SELECT udt_name FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='depends_on'")"
# THE E2 SENTINEL, and the single most important assertion in this file.
# depends_on must carry NO default: NULL means "never graph-scheduled, apply the
# legacy round rule", and DEFAULT '{}' would make every row the OLD engine
# writes between `psql -f` and the executor restart a graph root, promoted en
# masse the moment the new engine loads (R3; 02-architecture.md §2.2, §9.1;
# Konrad's ruling, commit 0ea9d28). Checked twice, through both catalogs.
assert_eq 'E2 SENTINEL: depends_on has NO column_default' '' \
  "$(q "SELECT coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='depends_on'")"
assert_eq 'E2 SENTINEL: no pg_attrdef entry for depends_on' '0' \
  "$(q "SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='$SCHEMA.project_tasks'::regclass AND a.attname='depends_on'")"
assert_eq 'E2 SENTINEL: depends_on is nullable' 'YES' \
  "$(q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='depends_on'")"
assert_has 'depends_on COMMENT states the sentinel' \
  "$(q "SELECT col_description('$SCHEMA.project_tasks'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid='$SCHEMA.project_tasks'::regclass AND attname='depends_on'))")" \
  'SENTINEL'
assert_eq 'workstream type is text' 'text' \
  "$(q "SELECT udt_name FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='workstream'")"
assert_eq "workstream defaults to 'main'" "'main'::text" \
  "$(q "SELECT column_default FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='workstream'")"
assert_eq 'workstream is NOT NULL' 'NO' \
  "$(q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='workstream'")"
assert_eq 'write_set type is text[]' '_text' \
  "$(q "SELECT udt_name FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='write_set'")"
assert_eq "write_set defaults to '{}'" "'{}'::text[]" \
  "$(q "SELECT column_default FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='write_set'")"
assert_eq 'graph_frozen type is boolean' 'bool' \
  "$(q "SELECT udt_name FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='graph_frozen'")"
assert_eq 'graph_frozen defaults to false' 'false' \
  "$(q "SELECT column_default FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='graph_frozen'")"
assert_eq 'graph_frozen is NOT NULL' 'NO' \
  "$(q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='graph_frozen'")"
assert_eq 'write_set is NOT NULL' 'NO' \
  "$(q "SELECT is_nullable FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name='write_set'")"

# --- the workstream CHECK, whose regex phase 3's validateWorkstream() must
#     match character for character (R4) ---
WS_CHK="$(q "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='project_tasks_workstream_chk' AND conrelid='$SCHEMA.project_tasks'::regclass")"
assert_ne 'workstream CHECK constraint exists' '' "$WS_CHK"
assert_has 'workstream CHECK carries the R4 regex' "$WS_CHK" '^[a-z0-9][a-z0-9-]{0,39}$'

# --- both R7 indexes, by name ---
GIN_DEF="$(q "SELECT indexdef FROM pg_indexes WHERE schemaname='$SCHEMA' AND indexname='project_tasks_depends_on_gin'")"
assert_ne 'R7 index project_tasks_depends_on_gin exists' '' "$GIN_DEF"
assert_has 'R7 depends_on index is GIN over depends_on' "$GIN_DEF" 'USING gin (depends_on)'
WS_DEF="$(q "SELECT indexdef FROM pg_indexes WHERE schemaname='$SCHEMA' AND indexname='project_tasks_workstream_idx'")"
assert_ne 'R7 index project_tasks_workstream_idx exists' '' "$WS_DEF"
assert_has 'R7 workstream index keys (project_id, workstream, status)' "$WS_DEF" '(project_id, workstream, status)'

# --- the two defaulted columns actually landed on the pre-existing rows ---
assert_eq "every backfilled row workstream='main'" "$SEEDED" \
  "$(q "SELECT count(*) FROM project_tasks WHERE workstream='main'")"
assert_eq "every backfilled row write_set='{}'" "$SEEDED" \
  "$(q "SELECT count(*) FROM project_tasks WHERE write_set='{}'")"
assert_eq 'no row left with NULL depends_on' '0' \
  "$(q 'SELECT count(*) FROM project_tasks WHERE depends_on IS NULL')"
# --- R71 (E4): the marker landed on exactly the rows the backfill wrote ------
# The property the widened R69 term rests on. Asserted three ways, because
# "every row is true" alone would also pass if the column had simply been
# DEFAULTed to true — which would mark every row any engine ever writes and
# re-serialise every future project (probe 3 of check-r69-straddle.sh prices
# that at 17 ticks against 3).
assert_eq 'R71: every backfilled row carries graph_frozen' "$SEEDED" \
  "$(q 'SELECT count(*) FROM project_tasks WHERE graph_frozen')"
assert_eq 'R71: the marker and the closure agree on every row' '0' \
  "$(q 'SELECT count(*) FROM project_tasks WHERE graph_frozen <> (depends_on IS NOT NULL)')"
# The negative control, inserted AFTER the backfill exactly as the engine does:
# an INSERT that does not name the column must produce a NOT-frozen row, or the
# column would be marking rows no migration ever touched.
q "INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on)
   SELECT '00000000-0000-4000-8000-0000000f0040', id, 9999, 'builder', 'post-backfill control', 'x', 'pending', '{}'::uuid[]
     FROM projects LIMIT 1" >/dev/null
assert_eq 'R71 CONTROL: a row inserted after the backfill is NOT frozen' 'f' \
  "$(q "SELECT graph_frozen FROM project_tasks WHERE id='00000000-0000-4000-8000-0000000f0040'")"
q "DELETE FROM project_tasks WHERE id='00000000-0000-4000-8000-0000000f0040'" >/dev/null
echo

# ---------------------------------------------------------------------------
# 5. VERIFY THE CLOSURE INDEPENDENTLY (R6). The expected depends_on is
#    recomputed in Python from the fixture's own round/created_at/id values —
#    never by re-running the migration's own SQL expression. A backfill that
#    asserts itself with the expression it ran is not evidence.
# ---------------------------------------------------------------------------
echo '--- 5. independent closure verification (R6) ----------------------------------'
psql_run -q -At -F'|' -c 'SELECT id, depends_on FROM project_tasks ORDER BY id' > "$WORK/actual-deps.txt"
CLOSURE="$(python3 - "$FIXTURE" "$WORK/actual-deps.txt" <<'PY'
import json, sys

fixture, actual_path = sys.argv[1], sys.argv[2]
rows = json.load(open(fixture, encoding='utf-8'))

# Today's rule, written out: a task waits for EVERY task of the same project in
# a STRICTLY LOWER round (02-architecture.md §3.3 — not "the previous round";
# rounds are sparse and previous-round-only diverges under retryTask()).
# The migration orders the array by (round, created_at, id) so two applications
# are byte-comparable; the expected value is ordered the same way, computed here
# from the fixture, independently of the SQL.
def sort_key(t):
    return (t['round'], t['created_at'], t['id'])

ordered = sorted(rows, key=sort_key)
expected = {
    t['id']: [e['id'] for e in ordered if e['round'] < t['round']]
    for t in rows
}

actual = {}
for line in open(actual_path, encoding='utf-8'):
    line = line.rstrip('\n')
    if not line:
        continue
    tid, arr = line.split('|', 1)
    body = arr.strip()
    if not (body.startswith('{') and body.endswith('}')):
        sys.exit(f'MALFORMED depends_on for {tid}: {arr!r}')
    body = body[1:-1]
    actual[tid] = [x for x in body.split(',') if x]

if not actual:
    sys.exit('REFUSING TO CERTIFY: the database returned zero rows to compare.')
if set(actual) != set(expected):
    sys.exit(f'ID SET MISMATCH: {len(actual)} rows in db, {len(expected)} in fixture')

mismatches = [tid for tid in expected if actual[tid] != expected[tid]]
for tid in mismatches[:5]:
    print(f'MISMATCH {tid}: expected {len(expected[tid])} ids, got {len(actual[tid])}',
          file=sys.stderr)

print(f'ROWS={len(actual)}')
print(f'MISMATCHES={len(mismatches)}')
print(f'MAXLEN={max(len(v) for v in actual.values())}')
print(f'ROOTS={sum(1 for v in actual.values() if not v)}')
print(f'ORDER_SENSITIVE=yes')
PY
)" || fail 'independent closure recomputation ran' 'python verifier exited non-zero'
sed 's/^/  | /' <<<"$CLOSURE"
# Parsed field by field rather than `eval`-ed: a verifier's stdout is data, and
# data is never executed, however trusted its author.
metric() { sed -n "s/^$1=//p" <<<"$CLOSURE" | tail -1; }
ROWS="$(metric ROWS)"; MISMATCHES="$(metric MISMATCHES)"
MAXLEN="$(metric MAXLEN)"; ROOTS="$(metric ROOTS)"
assert_eq 'closure compared every seeded row' "$SEEDED" "$ROWS"
assert_eq 'closure: 0 rows differ from the independently computed one' '0' "$MISMATCHES"
assert_ge 'closure: at least one row carries a large array' 100 "$MAXLEN"
assert_ge 'closure: at least one root row carries {}' 1 "$ROOTS"
echo

# ---------------------------------------------------------------------------
# 6. Snapshot. Guarded non-empty and row-counted BEFORE it is ever compared —
#    two empty files compare equal, and that must never read as a pass.
# ---------------------------------------------------------------------------
echo '--- 6. snapshot ---------------------------------------------------------------'
SNAP_SQL='SELECT id, depends_on, workstream, write_set, graph_frozen FROM project_tasks ORDER BY id'
psql_run -q -At -F'|' -c "$SNAP_SQL" > "$WORK/snap1.txt"
SNAP1_LINES="$(wc -l < "$WORK/snap1.txt" | tr -d ' ')"
echo "  $WORK/snap1.txt — $SNAP1_LINES lines, $(wc -c < "$WORK/snap1.txt" | tr -d ' ') bytes"
assert_eq 'snapshot 1 has one line per seeded row' "$SEEDED" "$SNAP1_LINES"
echo

# ---------------------------------------------------------------------------
# 7. Apply 0040, pass 2 — the re-runnability proof (R2). The backfill UPDATE
#    must report ZERO rows and the snapshot must be byte-identical.
# ---------------------------------------------------------------------------
echo '--- 7. apply 0040, pass 2 (re-runnability, R2) --------------------------------'
psql_run -f "$MIGRATION" > "$WORK/pass2.out" 2> "$WORK/pass2.err" || fail 'pass 2 applies cleanly' "see $WORK/pass2.err"
sed 's/^/  | /' "$WORK/pass2.out"
[ -s "$WORK/pass2.err" ] && sed 's/^/  ! /' "$WORK/pass2.err"
PASS2_UPDATE="$(grep -E '^UPDATE [0-9]+$' "$WORK/pass2.out" | tail -1 || true)"
assert_eq 'pass 2 backfill UPDATE changed zero rows' 'UPDATE 0' "$PASS2_UPDATE"
# The IF NOT EXISTS clauses must have actually ENGAGED — three columns and two
# indexes skipped. Without this, a pass 2 against a fresh table would also
# report UPDATE 0 (nothing to backfill) and look identical.
SKIPS="$(grep -c 'already exists, skipping' "$WORK/pass2.err" || true)"
assert_ge 'pass 2: IF NOT EXISTS engaged on 6 objects' 6 "$SKIPS"
# R71 again, after the replay: a second application must not mark anything new.
# It cannot — its UPDATE matched zero rows — but a marker that drifted on replay
# would change which rows R69 holds, and the snapshot comparison below would
# report it as a diff without naming what changed.
assert_eq 'R71: pass 2 marked no additional row' "$SEEDED" \
  "$(q 'SELECT count(*) FROM project_tasks WHERE graph_frozen')"

psql_run -q -At -F'|' -c "$SNAP_SQL" > "$WORK/snap2.txt"
SNAP2_LINES="$(wc -l < "$WORK/snap2.txt" | tr -d ' ')"
assert_eq 'snapshot 2 has one line per seeded row' "$SEEDED" "$SNAP2_LINES"
cmp -s "$WORK/snap1.txt" "$WORK/snap2.txt" \
  && pass 'snapshots byte-identical across both applications' "$(wc -c < "$WORK/snap2.txt" | tr -d ' ') bytes" \
  || fail 'snapshots byte-identical across both applications' "$(diff "$WORK/snap1.txt" "$WORK/snap2.txt" | head -5)"
echo
echo 'second application changed 0 rows'
echo

# ---------------------------------------------------------------------------
# 8. Did every probe actually fire? A sweep whose probes miss must fail, never
#    certify itself (standing rule 3).
# ---------------------------------------------------------------------------
echo '--- 8. assertion census -------------------------------------------------------'
echo "  assertions executed: $ASSERTIONS_RUN"
echo "  assertions defined : $EXPECTED_ASSERTIONS"
if [ "$ASSERTIONS_RUN" -lt "$EXPECTED_ASSERTIONS" ]; then
  echo "  FAIL: $((EXPECTED_ASSERTIONS - ASSERTIONS_RUN)) assertion(s) never ran — refusing to certify." >&2
  exit 1
fi
if [ "$ASSERTIONS_RUN" -gt "$EXPECTED_ASSERTIONS" ]; then
  echo "  FAIL: $ASSERTIONS_RUN assertions ran but $EXPECTED_ASSERTIONS are defined — update EXPECTED_ASSERTIONS." >&2
  exit 1
fi
echo
echo "PASS — 0040 is re-runnable (R2), its backfill is the closure (R6), both indexes exist (R7)."
echo "       git $HEAD_SHA · sha256(0040)=${MIGRATION_SHA256:0:16}… · db=$DB_NAME · schema=$SCHEMA"
