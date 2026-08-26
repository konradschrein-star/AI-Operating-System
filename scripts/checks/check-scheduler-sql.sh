#!/usr/bin/env bash
#
# check-scheduler-sql.sh — the behavioural proof that the SQL in
# forge-control/src/db/projects.ts schedules from the GRAPH: R11 (a graph row
# promotes with its round undrained), R12 (a legacy row still waits for every
# strictly lower round), R13 (the p.status = 'active' gate is a filter, not a
# state change), R14 (a dangling dependency lands on `blocked` and notifies,
# never on `ready`) and R69 (the straddle term: a frozen closure is held behind
# a post-migration legacy row — case 5 — and, since E4/R71, behind a post-RESTART
# graph row too, while a row that declared its own dependencies is not — case 5b).
#
# ROUND 204 ADDED CASES 8, 8b, 9 AND 10, each the measured shape of a round-203
# finding. R14 was a guarantee with holes in it, and they are closed here against
# the shipped functions rather than argued in a comment:
#   8  — THE OPERATOR PATH. `retryTask()` moved a corrupt `blocked` row to
#        `ready`, past a sweep scoped to `pending`, into `claimReadyTasks()`.
#   8b — THE OUT-OF-BAND PATH. A corrupt row written straight to `ready` by
#        anything that is not the promote statement — `psql`, an import, a future
#        writer — was invisible to the sweep forever.
#   9  — DUPLICATED IDS. `cardinality` counts elements and the comparison counts
#        rows, so the SQL blocked the project while `graphReady()` called the row
#        ready: the pure mirror and the statement disagreed on one input.
#   10 — CROSS-PROJECT IDS. Neither dependency subquery was correlated on
#        `project_id`, so another project's `done` row satisfied a dependency and
#        another project's `pending` row stalled one forever, silently.
# ROUND 2026-08-26 ADDED CASES 11 AND 11b (TERMINAL_TASK_STATUSES divergence):
#   11  — CANCELLED DEPENDENCY (R11). `db/projects.ts` moved stillOpen() to
#         exclude 'cancelled' rows as terminal; `graphReady()` previously checked
#         only status !== "done". A candidate with a cancelled dependency promotes
#         in SQL, and the mirror agrees.
#   11b — CANCELLED LOWER ROUND (R69 straddle term). A graph_frozen candidate over
#         a cancelled lower-round row is released by stillOpen() in SQL and by
#         the pure mirror.
# Every one of the cases also asserts THE MIRROR (02-architecture.md §1.2): the
# `mirror` driver step loads the project's rows and calls the real `graphReady()`
# on the same row, so "the pure side and the SQL agree" is a measurement here and
# not a doc-comment's promise.
#
# 03-quality.md §2.2 names this script and what it must prove:
#   "Against the same scratch schema: a graph-ready task promotes with its
#    round undrained; a NULL-deps task does not; a dangling dep yields
#    `blocked`, not `ready`."
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
# HOW THE REAL FUNCTIONS ARE DRIVEN — and why not by re-pasting their SQL.
#
# A check that re-pastes the statement under test proves that the paste is
# consistent with itself and nothing else. So this script imports
# `promoteReadyTasks()` and `claimReadyTasks()` FROM forge-control/src/db/
# projects.ts and calls them, under `tsx`, with `DATABASE_URL` pointed at the
# scratch schema.
#
# BOTH db/projects.ts and db/notifications.ts default to
# `postgresql://…/content_forge` WHEN $DATABASE_URL IS UNSET. That default is a
# loaded gun pointed at the live database from a build task. Belt AND braces:
#   - DATABASE_URL is exported explicitly here, from $SCRATCH_DATABASE_URL;
#   - the driver asserts `current_database()` over its OWN connection and
#     aborts before it so much as IMPORTS db/projects.ts if the answer is
#     `content_forge` (the import is dynamic for exactly that reason).
#
# The scratch target is SCHEMA-scoped: `?options=-c search_path=<schema>` is
# parsed by pg-connection-string@2.13 into `{options: "-c search_path=…"}` and
# passed by pg@8.21 in the startup packet. Verified on this host while writing
# this script (`current_schema()` answered the schema name, not `public`). The
# notifications table lives in the same search path, which matters because the
# R14 sweep writes to it through db/notifications.ts's separate pool.
#
# The driver runs in a temp directory OUTSIDE the repo with a symlink to
# forge-control/node_modules, so `import pg` resolves while nothing is written
# into the worktree — a check that leaves untracked files behind would make the
# reviewer cleanliness gate cry wolf.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) AN EMPTY SEED. A check that certifies an empty database certifies
#       nothing. Guarded: the seeded row count must equal SEED_EXPECTED_ROWS
#       exactly, and every case below names its rows by literal uuid, so a row
#       that was never inserted makes its own assertion fail rather than
#       silently vanish.
#   (b) A CASE WHOSE ROWS WERE NEVER INSERTED. Each case asserts the STATUS of
#       a named id. A missing row returns the empty string from psql -At and
#       fails the comparison against 'ready'/'pending'/'blocked'.
#   (c) A PROMOTE THAT RETURNED 0 FOR THE WRONG REASON. Never asserted on a
#       count. The promoted SET is computed by diffing a full status snapshot
#       taken before and after each call (pending → ready), and every assertion
#       names the id it expects to find or not find in that set. A promote that
#       did nothing at all fails case 1 and case 6 immediately.
#   (d) THE SWEEP'S NOTIFICATION COUNTED FROM A PREVIOUS RUN. The schema is
#       dropped and recreated at the start, so `notifications` is empty before
#       the first call; the assertion is on the TOTAL row count being exactly
#       1 AND on that row's text containing this run's own task title and its
#       own missing uuid.
#   (e) A FALSE RED MANUFACTURED IN CASE 1. If the undrained lower-round rows
#       of case 1 were LEGACY rows (`depends_on IS NULL`), R69's term would
#       correctly hold the candidate and the script would "discover" a bug that
#       is in fact the specification. Case 1's lower-round rows are therefore
#       GRAPH rows, deliberately, and the seed says so inline.
#   (f) PROBES THAT MISS. The script counts the assertions it actually executed
#       and exits non-zero if that count differs from EXPECTED_ASSERTIONS. A
#       sweep whose probes miss must fail, never certify itself.
#
# A NOTE ON WHAT CASE 3 CAN AND CANNOT SEE, recorded rather than glossed.
# The sweep's cardinality predicate is the literal negation of the promote
# branch's, and the sweep runs FIRST in the same function call, so there is no
# input for which the promote statement refuses a row the sweep did not already
# block, and case 3 cannot observe the front half in isolation through the public
# function. What it CAN assert, and does: the corrupt row is not among the ids
# promoted, and after the call NO unstarted row of an active project is left
# carrying a cardinality mismatch — the complement property itself, asserted
# mechanically instead of claimed in a comment.
#
# AMENDED ROUND 204: the sweep is now a SUPERSET of the promote branch's
# refusal, not its exact complement. It covers `pending` rows, which promote
# judges, AND `ready` rows with no run attached, which promote never looks at —
# because that is the state `retryTask()` and an out-of-band write produce, and a
# row there was invisible to R14 entirely. Still not `running`, and still not a
# `ready` row that already has a `run_id`: blocking one of those would strand a
# live run. The complement assertion below is scoped to match.
#
# Usage:  SCRATCH_DATABASE_URL=... scripts/checks/check-scheduler-sql.sh
# Exit:   0 = every assertion passed and every assertion ran.
#
set -euo pipefail
# An abort anywhere (a psql error under ON_ERROR_STOP, a driver that threw)
# must read as a FAILURE with a location, never as a quiet early return that a
# caller could mistake for "nothing to report".
trap 'rc=$?; [ $rc -ne 0 ] && echo "check-scheduler-sql.sh: ABORTED at line $LINENO (exit $rc) — NOT a pass" >&2' ERR

SCHEMA='tg_check_sched'
SUBJECT='forge-control/src/db/projects.ts'
PURE='forge-control/src/lib/task-graph.ts'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Every assertion this file defines. Kept in sync by hand and enforced at the
# end: if the counter comes in lower, probes were skipped and the run FAILS.
EXPECTED_ASSERTIONS=106
ASSERTIONS_RUN=0
# Every row the seed inserts: 3 + 2 + 2 + 3 + 2 + 4 across cases 1–7, plus
# 2 + 2 + 2 + 2 + 2 for cases 8, 8b, 9, 10 and case 10's foreign project, plus
# 2 + 3 for cases 11 and 11b.
# T3_GHOST and T8_GHOST are NOT among them — they are the ids cases 3 and 8 name
# and nobody inserts. Guard against failure mode (a).
SEED_EXPECTED_ROWS=35

pass() {
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
  printf '  ok   %-56s %s\n' "$1" "${2-}"
}
fail() {
  printf '  FAIL %-56s %s\n' "$1" "${2-}" >&2
  printf '\ncheck-scheduler-sql.sh FAILED after %d assertions\n' "$ASSERTIONS_RUN" >&2
  exit 1
}
assert_eq() {   # name expected actual
  [ "$2" = "$3" ] && pass "$1" "= $3" || fail "$1" "expected [$2] got [$3]"
}
assert_has() {  # name haystack needle
  case "$2" in *"$3"*) pass "$1" "contains: $3" ;; *) fail "$1" "missing [$3] in [$2]" ;; esac
}

# ---------------------------------------------------------------------------
# 0. REFUSE-TO-RUN GUARD — first thing, before a single statement is issued.
#    "A check that can be pointed at production by forgetting an environment
#    variable is an incident waiting for a tired night" (03-quality.md §2.2).
#    Identical in intent and in code to check-migration-0040.sh's guard:
#    resolves the target NAME, refuses content_forge, refuses any database this
#    fleet actually runs on, refuses a non-local host, prints the NAME only.
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
# config. The DSNs are read and discarded; only database NAMES are compared,
# and none of them is printed.
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

# The schema-scoped DSN the DRIVER gets. Built from the guarded value, never
# from a second environment variable that could name a different database.
DRIVER_URL="${SCRATCH_DATABASE_URL}?options=-c%20search_path%3D${SCHEMA}"

# ---------------------------------------------------------------------------
# 1. BUILD IDENTITY — printed before any assertion. A harness that does not
#    expose its own build identity is not evidence (standing rule 3). The SHA
#    alone is not enough: this check drives the WORKING TREE's copy of the
#    files under test, so their dirtiness is part of the identity.
# ---------------------------------------------------------------------------
HEAD_SHA="$(git rev-parse --short HEAD)"
SUBJECT_DIRTY="$(git status --porcelain -- "$SUBJECT" "$PURE" "${BASH_SOURCE[0]}" | wc -l | tr -d ' ')"
SUBJECT_SHA256="$(sha256sum "$SUBJECT" | cut -d' ' -f1)"
PURE_SHA256="$(sha256sum "$PURE" | cut -d' ' -f1)"

echo '=== check-scheduler-sql.sh — build identity ===================================='
echo "  repo worktree      : $REPO_ROOT"
echo "  git HEAD           : $HEAD_SHA"
echo "  uncommitted (subj) : $SUBJECT_DIRTY file(s) of {projects.ts, task-graph.ts, this script} modified"
echo "  subject            : $SUBJECT"
echo "  sha256(subject)    : $SUBJECT_SHA256"
echo "  pure decisions     : $PURE"
echo "  sha256(pure)       : $PURE_SHA256"
echo "  scratch database   : $DB_NAME (local; DSN never printed)"
echo "  throwaway schema   : $SCHEMA (search_path via ?options=, verified pg 8.21)"
echo "  driven by          : tsx, importing the SHIPPED promoteReadyTasks/claimReadyTasks"
echo "  expected assertions: $EXPECTED_ASSERTIONS"
echo '==============================================================================='

WORK="$(mktemp -d -t check-sched-XXXXXX)"
# Symlinked node_modules so `import pg` resolves from a directory outside the
# repo; nothing is written into the worktree.
ln -s "$REPO_ROOT/forge-control/node_modules" "$WORK/node_modules"
trap 'rm -rf "$WORK"' EXIT
echo "  artifacts          : $WORK"
echo

psql_run() { PGOPTIONS="-c search_path=$SCHEMA" psql "$SCRATCH_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
q()        { psql_run -q -At -c "$1"; }

# ---------------------------------------------------------------------------
# 2. Throwaway schema + the real project_tasks shape, from the real migrations.
#    Dropped and recreated so `notifications` starts empty (failure mode (d))
#    and so no row survives from a previous run.
#    0040 IS applied here — unlike check-migration-0040.sh, this script is not
#    testing the migration, it needs the columns it adds.
# ---------------------------------------------------------------------------
echo '--- 2. schema + migrations ----------------------------------------------------'
psql "$SCRATCH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA IF EXISTS $SCHEMA CASCADE" -c "CREATE SCHEMA $SCHEMA"
# The one forced placeholder, for the same reason check-migration-0040.sh
# documents: 0021 declares a FK to content_jobs, which no migration creates.
q "CREATE TABLE content_jobs (id uuid PRIMARY KEY)" >/dev/null
applied=0
for f in db/migrations/*.sql; do
  psql_run -q -f "$f" >/dev/null 2>&1
  applied=$((applied + 1))
done
echo "  applied $applied migrations (including 0040) into $SCHEMA"
assert_eq 'all four 0040 columns present' '4' \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name IN ('depends_on','workstream','write_set','graph_frozen')")"
assert_eq 'notifications table reachable in this search_path' 'notifications' \
  "$(q "SELECT table_name FROM information_schema.tables WHERE table_schema='$SCHEMA' AND table_name='notifications'")"
assert_eq 'notifications starts empty (failure mode (d))' '0' \
  "$(q 'SELECT count(*) FROM notifications')"
echo

# ---------------------------------------------------------------------------
# 3. Seed. Eleven synthetic projects, one per case, so that a project-scoped
#    rule (the legacy branch, R69's term, the sweep's project block) cannot
#    leak between cases. Every id is a literal, so every assertion names the
#    row it is about (failure mode (b), (c)).
#
#    CASES 8–10 ARE SEEDED PAUSED and activated in section 9. Their corrupt rows
#    would otherwise be swept on tick 1 and the notification census of case 4
#    ("exactly one notification") would be counting five runs' worth of work
#    instead of its own. Every pre-existing assertion is therefore untouched by
#    the new cases — which is the point: a new case that quietly moves an old
#    case's expected number has changed what the old case proved.
# ---------------------------------------------------------------------------
echo '--- 3. seed -------------------------------------------------------------------'
P1='00000000-0000-4000-8000-0000000000c1'   # R11
P2='00000000-0000-4000-8000-0000000000c2'   # R12
P3='00000000-0000-4000-8000-0000000000c3'   # R14
P5='00000000-0000-4000-8000-0000000000c5'   # R69
P5B='00000000-0000-4000-8000-0000000000d5'  # R69 widened — E4/R71, round 242
P6='00000000-0000-4000-8000-0000000000c6'   # R13
P7='00000000-0000-4000-8000-0000000000c7'   # R16/R17 claim belt
P8='00000000-0000-4000-8000-0000000000c8'   # R14 via retryTask (round 204)
P8B='00000000-0000-4000-8000-0000000000cb'  # R14 via an out-of-band 'ready' write
P9='00000000-0000-4000-8000-0000000000c9'   # R14, duplicated ids
P10='00000000-0000-4000-8000-0000000000ca'  # R14/R27, cross-project ids
P10F='00000000-0000-4000-8000-0000000000cf' # the FOREIGN project cases 10 names
P11='00000000-0000-4000-8000-0000000000cc'  # R11 cancelled dep (round 2026-08-26)
P11B='00000000-0000-4000-8000-0000000000cd' # R69 cancelled lower round (round 2026-08-26)

T1_LOW='00000000-0000-4000-8000-00000000110a'   # graph, undrained, lower round
T1_DEP='00000000-0000-4000-8000-00000000110b'   # graph, done, the real dependency
T1_CAND='00000000-0000-4000-8000-00000000110c'  # the R11 candidate
T2_LOW='00000000-0000-4000-8000-00000000120a'
T2_CAND='00000000-0000-4000-8000-00000000120c'
T3_DEP='00000000-0000-4000-8000-00000000140a'
T3_CAND='00000000-0000-4000-8000-00000000140c'
T3_GHOST='00000000-0000-4000-8000-0000000014ff'  # named by T3_CAND, inserted NOWHERE
T5_LEGACY='00000000-0000-4000-8000-00000000690a'
T5_DEP='00000000-0000-4000-8000-00000000690b'
T5_CAND='00000000-0000-4000-8000-00000000690c'
T5B_GRAPH='00000000-0000-4000-8000-00000000710a'   # a NEW-engine row at a LOWER round
T5B_DEP='00000000-0000-4000-8000-00000000710b'
T5B_FROZEN='00000000-0000-4000-8000-00000000710c'  # graph_frozen — must be held
T5B_DECLARED='00000000-0000-4000-8000-00000000710d' # same shape, NOT frozen — must promote
T6_ROOT='00000000-0000-4000-8000-00000000130a'
T6_LEGACY='00000000-0000-4000-8000-00000000130b'
T7_A='00000000-0000-4000-8000-00000000160a'
T7_B='00000000-0000-4000-8000-00000000160b'
T7_C='00000000-0000-4000-8000-00000000160c'
T7_D='00000000-0000-4000-8000-00000000160d'
T8_DEP='00000000-0000-4000-8000-00000000180a'
T8_CAND='00000000-0000-4000-8000-00000000180c'
T8_GHOST='00000000-0000-4000-8000-0000000018ff'  # named by T8_CAND, inserted NOWHERE
T8B_DEP='00000000-0000-4000-8000-0000000018ba'
T8B_CAND='00000000-0000-4000-8000-0000000018bc'  # seeded 'ready' AND corrupt
T9_DEP='00000000-0000-4000-8000-00000000190a'
T9_CAND='00000000-0000-4000-8000-00000000190c'
T10_CAND='00000000-0000-4000-8000-000000001a0c'   # names a FOREIGN done row
T10_CAND2='00000000-0000-4000-8000-000000001a0d'  # names a FOREIGN pending row
T10F_DONE='00000000-0000-4000-8000-000000001f0a'
T10F_PENDING='00000000-0000-4000-8000-000000001f0b'
T11_DEP='00000000-0000-4000-8000-000000001b0a'
T11_CAND='00000000-0000-4000-8000-000000001b0c'
T11B_LOW='00000000-0000-4000-8000-000000001c0a'
T11B_DEP='00000000-0000-4000-8000-000000001c0b'
T11B_CAND='00000000-0000-4000-8000-000000001c0c'

psql_run -q >/dev/null <<SQL
INSERT INTO projects (id, name, brief, repo, status) VALUES
  ('$P1','case1-R11','synthetic','ai-os','active'),
  ('$P2','case2-R12','synthetic','ai-os','active'),
  ('$P3','case3+4-R14','synthetic','ai-os','active'),
  ('$P5','case5-R69','synthetic','ai-os','active'),
  ('$P5B','case5b-R69-widened','synthetic','ai-os','active'),
  ('$P6','case6-R13','synthetic','ai-os','paused'),
  ('$P7','case7-R16','synthetic','ai-os','active'),
  -- Cases 8–10 start PAUSED so their sweep happens in section 9, after case 4's
  -- notification census has been taken against its own single notification.
  ('$P8','case8-R14-retry','synthetic','ai-os','paused'),
  ('$P8B','case8b-R14-outofband','synthetic','ai-os','paused'),
  ('$P9','case9-R14-duplicate','synthetic','ai-os','paused'),
  ('$P10','case10-R27-crossproject','synthetic','ai-os','paused'),
  -- Cases 11 & 11b start PAUSED and activate in section 10.
  ('$P11','case11-R11-cancelled-dep','synthetic','ai-os','paused'),
  ('$P11B','case11b-R69-cancelled-straddle','synthetic','ai-os','paused'),
  -- Never activated: it exists only to own the rows case 10 points at from
  -- another project. Its own rows must not promote and must not be swept.
  ('$P10F','case10-foreign-project','synthetic','ai-os','paused');

-- CASE 1 (R11). The candidate's round is 200 and round 100 is UNDRAINED, so
-- today's rule would refuse it and the graph branch must not.
-- THE LOWER-ROUND ROW IS DELIBERATELY A GRAPH ROW ('{}', not NULL). A LEGACY
-- row here would engage R69's term, which would correctly hold the candidate,
-- and this script would report a bug that is in fact the specification
-- (failure mode (e)). Case 5 is where a legacy row belongs.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T1_LOW','$P1',100,'builder','c1 lower-round graph row, never done','x','pending','{}','main','{}'),
  ('$T1_DEP','$P1',100,'builder','c1 the real dependency','x','done','{}','main','{}'),
  ('$T1_CAND','$P1',200,'reviewer','c1 candidate, deps done, round undrained','x','pending','{$T1_DEP}','main','{}');

-- CASE 2 (R12). Both rows are LEGACY (depends_on IS NULL). The lower round is
-- held by a 'running' row, which promote never touches, so the only way the
-- candidate moves is the legacy branch releasing it after the drain.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T2_LOW','$P2',100,'builder','c2 lower-round legacy row, running','x','running',NULL,'main','{}'),
  ('$T2_CAND','$P2',200,'reviewer','c2 legacy candidate','x','pending',NULL,'main','{}');

-- CASES 3 + 4 (R14). Every REAL dependency is done; one named id exists
-- nowhere. Front half: it must not be promoted. Back half: it must land on
-- 'blocked', its project must land on 'blocked', and one notification must
-- name it and the missing id.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T3_DEP','$P3',100,'builder','c3 the real dependency','x','done','{}','main','{}'),
  ('$T3_CAND','$P3',200,'reviewer','c3 candidate naming a ghost','x','pending','{$T3_DEP,$T3_GHOST}','main','{}');

-- CASE 5 (R69), the SQL-layer twin of R18 case (f) / failure F13. The
-- candidate's frozen closure is entirely done, and a LEGACY row sits at a
-- strictly lower round, not done — exactly the fix chain the old engine
-- inserts between \`psql -f 0040\` and the restart. It must be held.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T5_LEGACY','$P5',100,'builder','c5 post-migration legacy row','x','pending',NULL,'main','{}'),
  ('$T5_DEP','$P5',150,'builder','c5 frozen dependency, done','x','done','{}','main','{}'),
  ('$T5_CAND','$P5',200,'reviewer','c5 frozen-closure candidate','x','pending','{$T5_DEP}','main','{}');

-- CASE 5b (R69 WIDENED — E4, R71, round 242), the SQL-layer twin of R18 case
-- (g). Same shape as case 5 with ONE difference that is the whole case: the row
-- sitting at a strictly lower round is not a legacy row but a GRAPH row the new
-- engine wrote — the fix chain a post-restart consolidation creates (R42),
-- which carries real depends_on and which R69's original term could not see.
--
-- TWO CANDIDATES, IDENTICAL BUT FOR THE MARKER, and that is the control: both
-- name the same done dependency, both sit at round 200 above the same open row.
-- The frozen one must be held (its closure was derived from a round number
-- against a snapshot that predates \$T5B_GRAPH); the declared one must promote
-- (its dependencies are exactly what it says they are). If the widening were
-- keyed on anything but the marker, the two would share a fate.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set, graph_frozen) VALUES
  ('$T5B_GRAPH','$P5B',100,'builder','c5b post-restart fix builder, real graph fields','x','pending','{}','main','{}',false),
  ('$T5B_DEP','$P5B',150,'builder','c5b frozen dependency, done','x','done','{}','main','{}',true),
  ('$T5B_FROZEN','$P5B',200,'reviewer','c5b FROZEN candidate, closure entirely done','x','pending','{$T5B_DEP}','main','{}',true),
  ('$T5B_DECLARED','$P5B',200,'reviewer','c5b DECLARED candidate, same deps, not frozen','x','pending','{$T5B_DEP}','main','{}',false);

-- CASE 6 (R13). One graph root and one legacy row in a PAUSED project. Both
-- would promote on their own merits; the gate must stop both, and flipping the
-- project back to 'active' must promote THE SAME TWO ROWS — a filter, not a
-- state change.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T6_ROOT','$P6',100,'builder','c6 graph root in a paused project','x','pending','{}','main','{}'),
  ('$T6_LEGACY','$P6',100,'builder','c6 legacy row in a paused project','x','pending',NULL,'main','{}');

-- CASE 7 (R16/R17), beyond the six the brief mandates: the CLAIM path, driven
-- through the shipped claimReadyTasks(). Four graph roots, all promoted at
-- T1. A and B collide on src/x.ts in workstream 'main'; C writes the same path
-- in workstream 'ui' and therefore does not collide with either; D declares
-- nothing and is always claimable (R17). Created in a,b,c,d order so the
-- ORDER BY pt.round, pt.created_at makes the outcome deterministic.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set, created_at) VALUES
  ('$T7_A','$P7',100,'builder','c7 a writes src/x.ts in main','x','pending','{}','main','{src/x.ts}', now() - interval '4 min'),
  ('$T7_B','$P7',100,'builder','c7 b writes src/x.ts in main','x','pending','{}','main','{src/x.ts}', now() - interval '3 min'),
  ('$T7_C','$P7',100,'builder','c7 c writes src/x.ts in ui','x','pending','{}','ui','{src/x.ts}', now() - interval '2 min'),
  ('$T7_D','$P7',100,'builder','c7 d declares nothing','x','pending','{}','main','{}', now() - interval '1 min');

-- CASE 8 (R14 on the OPERATOR PATH, round 204 gating finding 1 / red-team
-- finding 1). Shape identical to case 3 — one real done dep, one ghost — but the
-- assertions continue past the block: retryTask() must REFUSE this row instead
-- of moving it to 'ready', and claimReadyTasks() must never see it.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T8_DEP','$P8',100,'builder','c8 the real dependency','x','done','{}','main','{}'),
  ('$T8_CAND','$P8',200,'reviewer','c8 candidate naming a ghost','x','pending','{$T8_DEP,$T8_GHOST}','main','{}');

-- CASE 8b (the OUT-OF-BAND path). The candidate is seeded ALREADY 'ready' with
-- no run attached and a dangling dep — the state an operator psql, an import, or
-- a retry against an older build leaves behind. A sweep scoped to 'pending'
-- could never see it and claimReadyTasks() would spawn a run for it.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T8B_DEP','$P8B',100,'builder','c8b the real dependency','x','done','{}','main','{}'),
  ('$T8B_CAND','$P8B',200,'reviewer','c8b corrupt row already READY','x','ready','{$T8B_DEP,$T8_GHOST}','main','{}');

-- CASE 9 (R14, DUPLICATED IDS — round 204 red-team finding 2). Every id
-- resolves, and to a done row of this project; the array is nevertheless longer
-- than the rows it names. The SQL blocks it; graphReady() must now agree.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T9_DEP','$P9',100,'builder','c9 the only real dependency','x','done','{}','main','{}'),
  ('$T9_CAND','$P9',200,'reviewer','c9 candidate naming one dep twice','x','pending','{$T9_DEP,$T9_DEP}','main','{}');

-- CASE 10 (R14/R27, CROSS-PROJECT IDS — round 204 red-team finding 3). Both
-- candidates name a row that EXISTS, of another project: one 'done' (which used
-- to satisfy the dependency and promote) and one 'pending' (which used to stall
-- forever with a matching cardinality that the sweep could not see).
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T10F_DONE','$P10F',100,'builder','c10 foreign done row','x','done','{}','main','{}'),
  ('$T10F_PENDING','$P10F',100,'builder','c10 foreign pending row','x','pending','{}','main','{}'),
  ('$T10_CAND','$P10',200,'reviewer','c10 candidate naming a foreign DONE row','x','pending','{$T10F_DONE}','main','{}'),
  ('$T10_CAND2','$P10',200,'reviewer','c10 candidate naming a foreign PENDING row','x','pending','{$T10F_PENDING}','main','{}');

-- CASE 11 (R11 on CANCELLED dependency). The candidate's ONLY dependency has
-- status 'cancelled'. The SQL promoter's stillOpen() treats 'cancelled' as
-- terminal (NOT IN ('done','cancelled')), so the row promotes to ready.
-- graphReady() mirrors this by checking TERMINAL_TASK_STATUSES.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set) VALUES
  ('$T11_DEP','$P11',100,'builder','c11 cancelled dependency','x','cancelled','{}','main','{}'),
  ('$T11_CAND','$P11',200,'reviewer','c11 candidate with cancelled dep','x','pending','{$T11_DEP}','main','{}');

-- CASE 11b (R69 straddle term over CANCELLED lower round). The candidate is
-- graph_frozen with a done dependency at round 150, and a strictly lower-round
-- row at round 100 is 'cancelled'. In SQL, stillOpen() does not hold on cancelled
-- rows; graphReady()'s straddle loop likewise skips terminal rows.
INSERT INTO project_tasks (id, project_id, round, role, title, brief, status, depends_on, workstream, write_set, graph_frozen) VALUES
  ('$T11B_LOW','$P11B',100,'builder','c11b lower-round cancelled row','x','cancelled','{}','main','{}',false),
  ('$T11B_DEP','$P11B',150,'builder','c11b done dependency','x','done','{}','main','{}',false),
  ('$T11B_CAND','$P11B',200,'reviewer','c11b frozen candidate over cancelled lower round','x','pending','{$T11B_DEP}','main','{}',true);
SQL
SEEDED="$(q 'SELECT count(*) FROM project_tasks')"
echo "  seeded rows        : $SEEDED across 13 projects"
assert_eq 'seed inserted exactly the rows the cases name' "$SEED_EXPECTED_ROWS" "$SEEDED"
echo

# ---------------------------------------------------------------------------
# 4. The driver. Written once, invoked per step. It asserts current_database()
#    over its own connection BEFORE it imports db/projects.ts — the import is
#    dynamic so that even the module-level `new Pool(...)` in projects.ts and
#    notifications.ts cannot run against the wrong target.
# ---------------------------------------------------------------------------
cat > "$WORK/drive.mts" <<DRIVER
import pg from "pg";

const step = process.argv[2];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const meta = await pool.query<{ db: string; schema: string }>(
  "select current_database() as db, current_schema() as schema",
);
const { db, schema } = meta.rows[0];
if (db === "content_forge") {
  console.error("DRIVER REFUSING TO RUN: current_database() is content_forge.");
  process.exit(3);
}
console.error(\`  driver: db=\${db} schema=\${schema} step=\${step}\`);
await pool.end();

// Dynamic, and only now: importing projects.ts constructs its pool from
// \$DATABASE_URL, and the guard above is what makes that safe.
const projects = await import("$REPO_ROOT/forge-control/src/db/projects.ts");

if (step === "promote") {
  const n = await projects.promoteReadyTasks();
  console.log(\`PROMOTED_ROWCOUNT=\${n}\`);
} else if (step === "claim") {
  const claimed = await projects.claimReadyTasks();
  console.log(\`CLAIMED_IDS=\${claimed.map((t) => t.id).sort().join(",")}\`);
} else if (step === "retry") {
  // The OPERATOR path (round 204). Drives the shipped retryTask(), which is what
  // POST /api/tasks/:id/retry and unwedgeProject() both call.
  const out = await projects.retryTask(process.argv[3]);
  console.log(\`RETRY_OK=\${out.ok}\`);
  console.log(\`RETRY_REASON=\${out.ok ? "-" : out.reason}\`);
  console.log(
    \`RETRY_STATUS=\${out.ok ? out.task.status : (out.task?.status ?? "-")}\`,
  );
  console.log(
    \`RETRY_DETAIL=\${
      !out.ok && out.reason === "dependencies_corrupt"
        ? projects.describeDepsCorruption(out.corruption) ?? "(unexplained)"
        : "-"
    }\`,
  );
} else if (step === "mirror") {
  // THE MIRROR, measured (02-architecture.md §1.2): load the named row's project
  // exactly as promoteReadyTasks() would see it, and ask the PURE decision. A
  // divergence between this answer and the row's SQL fate is the bug the
  // doc-comments claim cannot exist.
  const graph = await import("$REPO_ROOT/forge-control/src/lib/task-graph.ts");
  const probe = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const row = await probe.query<{ project_id: string }>(
    "select project_id::text from project_tasks where id = \$1",
    [process.argv[3]],
  );
  if (row.rows.length !== 1) {
    console.error("mirror: no such task");
    process.exit(5);
  }
  const all = await probe.query<import("$REPO_ROOT/forge-control/src/lib/task-graph.ts").GraphTask>(
    // graph_frozen is SELECTed, not defaulted: an absent field would arrive as
    // `undefined`, read as falsy inside graphReady()'s R69 term, and make the
    // mirror answer for a rule the engine is not running (R71, E4).
    "select id::text, round, workstream, status, depends_on::text[] as depends_on, write_set," +
      " graph_frozen from project_tasks where project_id = \$1",
    [row.rows[0].project_id],
  );
  await probe.end();
  const byId = new Map(all.rows.map((t) => [t.id, t]));
  const task = byId.get(process.argv[3]);
  if (!task) {
    console.error("mirror: the row is not in its own project's row set");
    process.exit(6);
  }
  try {
    const rule = graph.readyRule(task);
    console.log(\`MIRROR_RULE=\${rule}\`);
    console.log(
      \`MIRROR=\${rule === "graph" ? String(graph.graphReady(task, byId)) : "n/a"}\`,
    );
  } catch (e) {
    console.log(\`MIRROR=threw:\${e instanceof Error ? e.constructor.name : "?"}\`);
    console.log(\`MIRROR_MESSAGE=\${e instanceof Error ? e.message : String(e)}\`);
  }
} else {
  console.error(\`unknown step: \${step}\`);
  process.exit(4);
}
// pg pools keep the event loop alive and neither module exports its pool, so
// the process is ended explicitly. Everything above has already been awaited.
process.exit(0);
DRIVER

TSX="$REPO_ROOT/forge-control/node_modules/.bin/tsx"
[ -x "$TSX" ] || fail 'tsx binary present' "not executable: $TSX"
snapshot() { psql_run -q -At -F'|' -c \
  "SELECT id::text, status FROM project_tasks ORDER BY id" > "$1"; }
# promoted(before, after) — the ids that went pending → ready. Failure mode
# (c): every assertion below names an id in this set, never a bare count.
promoted() {
  python3 - "$1" "$2" <<'PY'
import sys
def load(p):
    out = {}
    for line in open(p, encoding='utf-8'):
        line = line.rstrip('\n')
        if line:
            k, v = line.split('|', 1)
            out[k] = v
    return out
before, after = load(sys.argv[1]), load(sys.argv[2])
if not before or not after:
    sys.exit('REFUSING TO CERTIFY: a status snapshot was empty.')
if set(before) != set(after):
    sys.exit('ROW SET CHANGED between snapshots — the seed is not stable.')
print(','.join(sorted(k for k in before
                      if before[k] == 'pending' and after[k] == 'ready')))
PY
}

echo '--- 4. tick 1: promoteReadyTasks() --------------------------------------------'
snapshot "$WORK/s0.txt"
# THE MIRROR FOR CASE 5b IS TAKEN HERE, BEFORE THE PROMOTE, and the timing is
# the assertion's whole content. `graphReady()` answers `false` for any row that
# is not `pending` (its first term, operator ruling round 102), so a mirror read
# AFTER tick 1 would report `false` for a row precisely because the statement
# had just promoted it — an instrument agreeing with itself about the wrong
# question. Both 5b candidates are `pending` at this instant, so the pure side
# is asked the same question the statement is about to answer.
MIRROR5BF="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T5B_FROZEN" 2>/dev/null)"
MIRROR5BD="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T5B_DECLARED" 2>/dev/null)"
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote | sed 's/^/  | /'
snapshot "$WORK/s1.txt"
PROMOTED1="$(promoted "$WORK/s0.txt" "$WORK/s1.txt")"
echo "  promoted on tick 1 : $PROMOTED1"
st() { q "SELECT status FROM project_tasks WHERE id = '$1'"; }
pst() { q "SELECT status FROM projects WHERE id = '$1'"; }
inset() { case ",$2," in *",$1,"*) echo yes ;; *) echo no ;; esac; }
echo

# ---------------------------------------------------------------------------
# 5. The cases.
# ---------------------------------------------------------------------------
echo '--- 5. case 1 — R11: a graph row promotes with its round UNDRAINED ------------'
# The premise, asserted rather than assumed: round 100 of P1 really is undrained
# at the moment the candidate promoted. Without this the case could pass because
# the round happened to drain, which proves nothing about R11.
assert_eq 'R11 premise: a lower-round P1 row is not done' 'pending' "$(sed -n "s/^$T1_LOW|//p" "$WORK/s0.txt")"
assert_eq 'R11: candidate promoted despite the undrained round' 'yes' "$(inset "$T1_CAND" "$PROMOTED1")"
assert_eq 'R11: candidate is now ready' 'ready' "$(st "$T1_CAND")"
assert_eq 'R11: the lower-round graph row promoted too (it is a root)' 'yes' "$(inset "$T1_LOW" "$PROMOTED1")"
assert_eq 'R11: round 100 of P1 is STILL undrained after the tick' 'ready' "$(st "$T1_LOW")"
echo

echo '--- 5. case 2 — R12: a legacy row waits for its lower round -------------------'
assert_eq 'R12: legacy candidate NOT promoted on tick 1' 'no' "$(inset "$T2_CAND" "$PROMOTED1")"
assert_eq 'R12: legacy candidate is still pending' 'pending' "$(st "$T2_CAND")"
echo

echo '--- 5. cases 3+4 — R14: dangling dependency ----------------------------------'
assert_eq 'R14 front: corrupt row NOT among the promoted ids' 'no' "$(inset "$T3_CAND" "$PROMOTED1")"
# The complement property, asserted mechanically: after the call there is no
# pending row of an active project left carrying a cardinality mismatch. This
# is what makes "the promote branch never has to refuse a row the sweep missed"
# a measurement instead of a claim.
assert_eq 'R14 front: no unstarted row of an active project keeps a mismatch' '0' \
  "$(q "SELECT count(*) FROM project_tasks pt JOIN projects p ON p.id = pt.project_id
         WHERE p.status = 'active' AND pt.status IN ('pending','ready') AND pt.run_id IS NULL
           AND pt.depends_on IS NOT NULL
           AND cardinality(pt.depends_on) <> (SELECT count(*) FROM project_tasks d
                                               WHERE d.id = ANY(pt.depends_on)
                                                 AND d.project_id = pt.project_id)")"
assert_eq 'R14 back: the corrupt task is blocked' 'blocked' "$(st "$T3_CAND")"
# Asserted explicitly and separately, because "not ready" is the outcome R14
# exists to guarantee and a status of 'ready' is the one result that must never
# be reachable — a single assertion on 'blocked' would also pass if the sweep
# started writing some third status.
assert_eq 'R14 back: the corrupt task is NOT ready' 'no' \
  "$([ "$(st "$T3_CAND")" = 'ready' ] && echo yes || echo no)"
assert_eq 'R14 back: the project is blocked' 'blocked' "$(pst "$P3")"
assert_eq 'R14 back: exactly one notification was queued' '1' \
  "$(q "SELECT count(*) FROM notifications")"
NOTE="$(q "SELECT text FROM notifications ORDER BY created_at LIMIT 1")"
echo "  notification       : $NOTE"
assert_has 'R14 back: notification names the task title' "$NOTE" 'c3 candidate naming a ghost'
assert_has 'R14 back: notification names the missing id' "$NOTE" "$T3_GHOST"
assert_has 'R14 back: notification names the project' "$NOTE" 'case3+4-R14'
assert_eq 'R14 back: the notification source is project-graph' 'project-graph' \
  "$(q "SELECT source FROM notifications ORDER BY created_at LIMIT 1")"
# Decision 1 of the sweep, observable: blocking the project stops the rest of
# it. P3's dependency row is done, so nothing else was pending here — assert
# instead that the project gate now holds P3 by re-reading its status above.
echo

echo '--- 5. case 5 — R69: the legacy-row term holds a frozen closure ---------------'
assert_eq 'R69 premise: every frozen dep of the candidate is done' 'done' "$(st "$T5_DEP")"
assert_eq 'R69 premise: a lower-round LEGACY row of P5 is not done' 'no' \
  "$([ "$(st "$T5_LEGACY")" = 'done' ] && echo yes || echo no)"
assert_eq 'R69: candidate NOT promoted while the legacy row is open' 'no' "$(inset "$T5_CAND" "$PROMOTED1")"
assert_eq 'R69: candidate is still pending' 'pending' "$(st "$T5_CAND")"
echo

echo '--- 5. case 5b — R69 widened: graph_frozen holds a DERIVED closure (E4) -------'
assert_eq 'E4 premise: the candidates share one done dependency' 'done' "$(st "$T5B_DEP")"
assert_eq 'E4 premise: the lower-round row is a GRAPH row, not a legacy one' 'f' \
  "$(q "SELECT depends_on IS NULL FROM project_tasks WHERE id='$T5B_GRAPH'")"
# NOT `= pending`: it is a graph root of an ACTIVE project, so tick 1 promotes
# it to `ready` on its own merits — which is exactly the post-restart fix
# builder starting work. What the case needs is that it is not DONE, because
# that is what R69's term reads.
assert_eq 'E4 premise: that lower-round row is not done' 'no' \
  "$([ "$(st "$T5B_GRAPH")" = 'done' ] && echo yes || echo no)"
assert_eq 'E4: the FROZEN candidate is NOT promoted' 'no' "$(inset "$T5B_FROZEN" "$PROMOTED1")"
assert_eq 'E4: the frozen candidate is still pending' 'pending' "$(st "$T5B_FROZEN")"
# THE CONTROL, and the reason this case is two rows rather than one: without it
# a term that held EVERY graph row behind every lower round would pass every
# assertion above while re-serialising every project this engine exists to
# parallelise (17 ticks against 3 — probe 3 of check-r69-straddle.sh).
assert_eq 'E4 CONTROL: the DECLARED candidate promotes in the same tick' 'yes' \
  "$(inset "$T5B_DECLARED" "$PROMOTED1")"
# THE MIRROR (02-architecture.md §1.2), read from the pre-tick capture in
# section 4: the pure predicate answered, on the same rows in the same state,
# exactly what the statement then did — refuse the frozen candidate, release the
# declared one. Both took the graph branch, so neither answer came from the
# legacy rule by accident.
assert_has 'E4 MIRROR: the frozen candidate took the graph branch' "$MIRROR5BF" 'MIRROR_RULE=graph'
assert_has 'E4 MIRROR: graphReady() also refuses the frozen candidate' "$MIRROR5BF" 'MIRROR=false'
assert_has 'E4 MIRROR: the declared candidate took the graph branch' "$MIRROR5BD" 'MIRROR_RULE=graph'
assert_has 'E4 MIRROR: graphReady() also releases the declared one' "$MIRROR5BD" 'MIRROR=true'
echo

echo '--- 5. case 6 — R13: the active gate is a FILTER ------------------------------'
assert_eq 'R13: paused project promoted nothing (graph row)' 'no' "$(inset "$T6_ROOT" "$PROMOTED1")"
assert_eq 'R13: paused project promoted nothing (legacy row)' 'no' "$(inset "$T6_LEGACY" "$PROMOTED1")"
echo

# ---------------------------------------------------------------------------
# 6. Tick 2 — drain what each case was waiting for, resume the paused project,
#    and prove each held row moves. Same function, no other change.
# ---------------------------------------------------------------------------
echo '--- 6. tick 2: drain the blockers, then promoteReadyTasks() again -------------'
psql_run -q >/dev/null <<SQL
UPDATE project_tasks SET status = 'done' WHERE id IN ('$T2_LOW','$T5_LEGACY','$T5B_GRAPH');
UPDATE projects SET status = 'active' WHERE id = '$P6';
SQL
snapshot "$WORK/s2.txt"
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote | sed 's/^/  | /'
snapshot "$WORK/s3.txt"
PROMOTED2="$(promoted "$WORK/s2.txt" "$WORK/s3.txt")"
echo "  promoted on tick 2 : $PROMOTED2"
assert_eq 'R12: legacy candidate promotes once its round drains' 'yes' "$(inset "$T2_CAND" "$PROMOTED2")"
assert_eq 'R69: candidate promotes once the legacy row is done' 'yes' "$(inset "$T5_CAND" "$PROMOTED2")"
assert_eq 'E4: the frozen candidate promotes once the graph row is done' 'yes' \
  "$(inset "$T5B_FROZEN" "$PROMOTED2")"
assert_eq 'R13: resumed project promotes its graph row' 'yes' "$(inset "$T6_ROOT" "$PROMOTED2")"
assert_eq 'R13: resumed project promotes its legacy row' 'yes' "$(inset "$T6_LEGACY" "$PROMOTED2")"
assert_eq 'R14: the blocked project promoted nothing on tick 2 either' 'blocked' "$(st "$T3_CAND")"
assert_eq 'R14: still exactly one notification — the sweep is idempotent' '1' \
  "$(q "SELECT count(*) FROM notifications")"
echo

# ---------------------------------------------------------------------------
# 7. Case 7 — the CLAIM path through the shipped claimReadyTasks(). Beyond the
#    six cases the brief mandates; it is here because the brief also says the
#    check must drive BOTH functions, and the contention belt is the other half
#    of what phase 2 changed.
# ---------------------------------------------------------------------------
echo '--- 7. case 7 — R16/R17: the contention belt in claimReadyTasks() -------------'
for t in "$T7_A" "$T7_B" "$T7_C" "$T7_D"; do
  [ "$(st "$t")" = 'ready' ] || fail 'case 7 premise: all four P7 rows are ready' "$t is $(st "$t")"
done
pass 'case 7 premise: all four P7 rows are ready' '4 rows'
CLAIMED="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" claim | sed -n 's/^CLAIMED_IDS=//p')"
echo "  claimed ids        : $CLAIMED"
assert_eq 'R16: a (first writer of src/x.ts in main) was claimed' 'yes' "$(inset "$T7_A" "$CLAIMED")"
assert_eq 'R16: b (same path, same workstream) was DEFERRED' 'no' "$(inset "$T7_B" "$CLAIMED")"
assert_eq 'R16: b stays ready — deferred, never failed' 'ready' "$(st "$T7_B")"
assert_eq 'R16: c (same path, DIFFERENT workstream) was claimed' 'yes' "$(inset "$T7_C" "$CLAIMED")"
assert_eq 'R17: d (empty write_set) was claimed' 'yes' "$(inset "$T7_D" "$CLAIMED")"
assert_eq 'R16: a is running' 'running' "$(st "$T7_A")"
echo

# ---------------------------------------------------------------------------
# 9. ROUND 204 — the three holes in R14, each driven through the shipped
#    functions. Cases 8–10 are activated only now, so every assertion above was
#    measured against the same six-case world it was written for.
# ---------------------------------------------------------------------------
echo '--- 9. cases 8-10: activate the four round-204 projects ------------------------'
psql_run -q >/dev/null <<SQL
UPDATE projects SET status = 'active' WHERE id IN ('$P8','$P8B','$P9','$P10');
SQL
# The premise, asserted rather than assumed: the corrupt rows are still in the
# state the case is about at the moment the sweep runs.
assert_eq 'case 8 premise: the candidate is pending, unswept' 'pending' "$(st "$T8_CAND")"
assert_eq 'case 8b premise: the candidate is READY with no run attached' 'ready|' \
  "$(q "SELECT status || '|' || coalesce(run_id::text,'') FROM project_tasks WHERE id = '$T8B_CAND'")"
assert_eq 'case 9 premise: the duplicated id resolves to a DONE row' 'done' "$(st "$T9_DEP")"
assert_eq 'case 10 premise: the foreign done row exists, in another project' "$P10F" \
  "$(q "SELECT project_id FROM project_tasks WHERE id = '$T10F_DONE'")"

# THE MIRROR PROBES ARE TAKEN NOW, BEFORE THE TICK, AND THAT IS NOT A
# CONVENIENCE. `graphReady()`'s first term is `pending` (operator ruling, round
# 102), so once the sweep has moved a row to `blocked` the pure function answers
# `false` for a reason that has nothing to do with its dependencies — asking it
# then would report agreement it never expressed. The honest moment to ask the
# pure side what it makes of a row is while the row is in the state the promote
# statement is about to judge. Case 8b has no mirror assertion for the same
# reason, stated rather than omitted: its row is `ready`, which `graphReady()` is
# silent about by design, and covering exactly what the pure promotion decision
# cannot see is what the sweep is FOR.
MIRROR8="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T8_CAND" 2>/dev/null)"
MIRROR9="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T9_CAND" 2>/dev/null)"
MIRROR10="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T10_CAND" 2>/dev/null)"
snapshot "$WORK/s4.txt"
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote | sed 's/^/  | /'
snapshot "$WORK/s5.txt"
PROMOTED3="$(promoted "$WORK/s4.txt" "$WORK/s5.txt")"
echo "  promoted on tick 3 : ${PROMOTED3:-<none>}"
note_for() { q "SELECT text FROM notifications WHERE text LIKE '%$1%' ORDER BY created_at LIMIT 1"; }
echo

echo '--- 9. case 8 — R14 through retryTask(): the operator path ---------------------'
assert_eq 'case 8: the corrupt row was swept to blocked' 'blocked' "$(st "$T8_CAND")"
assert_eq 'case 8: its project was blocked' 'blocked' "$(pst "$P8")"
assert_eq 'case 8: it was NOT promoted' 'no' "$(inset "$T8_CAND" "$PROMOTED3")"
# THE FINDING ITSELF. Before round 204 this call answered {ok:true,
# status:'ready'} and the next claim gave the row a run.
RETRY_OUT="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" retry "$T8_CAND" 2>/dev/null)"
echo "$RETRY_OUT" | sed 's/^/  | /'
assert_eq 'case 8: retryTask REFUSED the corrupt row' 'RETRY_OK=false' \
  "$(printf '%s\n' "$RETRY_OUT" | grep '^RETRY_OK=')"
assert_eq 'case 8: … with reason dependencies_corrupt' 'RETRY_REASON=dependencies_corrupt' \
  "$(printf '%s\n' "$RETRY_OUT" | grep '^RETRY_REASON=')"
assert_has 'case 8: the refusal names the missing id' \
  "$(printf '%s\n' "$RETRY_OUT" | grep '^RETRY_DETAIL=')" "$T8_GHOST"
assert_eq 'case 8: the row is STILL blocked after the retry' 'blocked' "$(st "$T8_CAND")"
assert_eq 'case 8: the row is NOT ready after the retry' 'no' \
  "$([ "$(st "$T8_CAND")" = 'ready' ] && echo yes || echo no)"
assert_eq 'case 8: the project was NOT resumed by the refused retry' 'blocked' "$(pst "$P8")"
assert_eq 'case 8: the attempt counter was not spent on a refusal' '0' \
  "$(q "SELECT attempt FROM project_tasks WHERE id = '$T8_CAND'")"
CLAIMED8="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" claim | sed -n 's/^CLAIMED_IDS=//p')"
assert_eq 'case 8: claimReadyTasks() did NOT claim it' 'no' "$(inset "$T8_CAND" "$CLAIMED8")"
assert_eq 'case 8: it never reached running' 'blocked' "$(st "$T8_CAND")"
assert_eq 'case 8 MIRROR: graphReady() throws GraphIntegrityError on the same row' \
  'MIRROR=threw:GraphIntegrityError' "$(printf '%s\n' "$MIRROR8" | grep '^MIRROR=')"
echo

echo '--- 9. case 8b — R14 on a row written straight to ready ------------------------'
assert_eq 'case 8b: the sweep reached a READY row (decision 2, widened)' 'blocked' "$(st "$T8B_CAND")"
assert_eq 'case 8b: its project was blocked' 'blocked' "$(pst "$P8B")"
NOTE8B="$(note_for 'c8b corrupt row already READY')"
echo "  notification       : $NOTE8B"
assert_has 'case 8b: the notification says which state it was swept from' "$NOTE8B" '(ready)'
assert_has 'case 8b: … and names the missing id' "$NOTE8B" "$T8_GHOST"
echo

echo '--- 9. case 9 — R14 on DUPLICATED ids: SQL and graphReady() agree -------------'
assert_eq 'case 9: the duplicate-bearing row was NOT promoted' 'no' "$(inset "$T9_CAND" "$PROMOTED3")"
assert_eq 'case 9: it was swept to blocked' 'blocked' "$(st "$T9_CAND")"
NOTE9="$(note_for 'c9 candidate naming one dep twice')"
echo "  notification       : $NOTE9"
assert_has 'case 9: the notification names the DUPLICATE shape' "$NOTE9" 'duplicated ids'
assert_has 'case 9: … and names the id' "$NOTE9" "$T9_DEP"
echo "$MIRROR9" | sed 's/^/  | /'
assert_eq 'case 9 MIRROR: graphReady() no longer calls a duplicate READY' \
  'MIRROR=threw:GraphIntegrityError' "$(printf '%s\n' "$MIRROR9" | grep '^MIRROR=')"
assert_has 'case 9 MIRROR: the pure message names the duplicate' \
  "$(printf '%s\n' "$MIRROR9" | grep '^MIRROR_MESSAGE=')" 'duplicated dependency id'
echo

echo '--- 9. case 10 — R27 in SQL: a cross-project dep resolves to nothing ----------'
assert_eq 'case 10: naming a foreign DONE row did NOT promote' 'no' "$(inset "$T10_CAND" "$PROMOTED3")"
assert_eq 'case 10: … it was swept to blocked instead of stalling' 'blocked' "$(st "$T10_CAND")"
assert_eq 'case 10: naming a foreign PENDING row did NOT promote' 'no' "$(inset "$T10_CAND2" "$PROMOTED3")"
assert_eq 'case 10: … and it too was swept rather than silently held' 'blocked' "$(st "$T10_CAND2")"
NOTE10="$(note_for 'c10 candidate naming a foreign DONE row')"
echo "  notification       : $NOTE10"
assert_has 'case 10: the notification names the CROSS-PROJECT shape' "$NOTE10" 'ANOTHER project'
assert_has 'case 10: … and names the foreign id' "$NOTE10" "$T10F_DONE"
assert_eq 'case 10 MIRROR: graphReady() throws on the identical row' \
  'MIRROR=threw:GraphIntegrityError' "$(printf '%s\n' "$MIRROR10" | grep '^MIRROR=')"
# The foreign project is untouched: the sweep must not reach into it, and its own
# pending row must not have been promoted by a tick it does not belong to.
assert_eq 'case 10: the FOREIGN project was not blocked' 'paused' "$(pst "$P10F")"
assert_eq 'case 10: the foreign pending row was not touched' 'pending' "$(st "$T10F_PENDING")"
echo

echo '--- 9. the census: every notification of this run is accounted for -------------'
# Five corrupt rows across the run (case 3, 8, 8b, 9 and two in case 10 = six),
# each notified exactly once. Asserted as a total AND as a per-row count, because
# a total alone would pass if one row notified twice and another not at all.
assert_eq 'notifications: exactly one per corrupt row, six rows' '6' \
  "$(q 'SELECT count(*) FROM notifications')"
assert_eq 'notifications: no corrupt row notified twice' '0' \
  "$(q "SELECT count(*) FROM (SELECT text FROM notifications GROUP BY text HAVING count(*) > 1) d")"
assert_eq 'notifications: every one of them came from project-graph' '6' \
  "$(q "SELECT count(*) FROM notifications WHERE source = 'project-graph'")"
# Idempotence across a further tick, for the widened predicate too.
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote >/dev/null 2>&1
assert_eq 'notifications: a fourth tick added none — the sweep is still idempotent' '6' \
  "$(q 'SELECT count(*) FROM notifications')"
assert_eq 'no unstarted row of an ACTIVE project is left corrupt, run-wide' '0' \
  "$(q "SELECT count(*) FROM project_tasks pt JOIN projects p ON p.id = pt.project_id
         WHERE p.status = 'active' AND pt.status IN ('pending','ready') AND pt.run_id IS NULL
           AND pt.depends_on IS NOT NULL
           AND cardinality(pt.depends_on) <> (SELECT count(*) FROM project_tasks d
                                               WHERE d.id = ANY(pt.depends_on)
                                                 AND d.project_id = pt.project_id)")"
assert_eq 'no corrupt row anywhere reached running' '0' \
  "$(q "SELECT count(*) FROM project_tasks pt
         WHERE pt.status = 'running' AND pt.depends_on IS NOT NULL
           AND cardinality(pt.depends_on) <> (SELECT count(*) FROM project_tasks d
                                               WHERE d.id = ANY(pt.depends_on)
                                                 AND d.project_id = pt.project_id)")"
echo

# ---------------------------------------------------------------------------
# 10. CASES 11 & 11b — CANCELLED DEPENDENCIES AND STRADDLE (TERMINAL_TASK_STATUSES).
#     Cases 11 and 11b are activated now, so every assertion above was measured
#     against the same eleven-project world it was written for.
# ---------------------------------------------------------------------------
echo '--- 10. cases 11+11b: activate the two cancelled-status projects ----------------'
psql_run -q >/dev/null <<SQL
UPDATE projects SET status = 'active' WHERE id IN ('$P11','$P11B');
SQL

assert_eq 'case 11 premise: dependency is cancelled' 'cancelled' "$(st "$T11_DEP")"
assert_eq 'case 11 premise: candidate is pending' 'pending' "$(st "$T11_CAND")"
assert_eq 'case 11b premise: lower-round row is cancelled' 'cancelled' "$(st "$T11B_LOW")"
assert_eq 'case 11b premise: candidate dependency is done' 'done' "$(st "$T11B_DEP")"
assert_eq 'case 11b premise: candidate is pending and frozen' 'pending|true' \
  "$(q "SELECT status || '|' || graph_frozen FROM project_tasks WHERE id = '$T11B_CAND'")"

# THE MIRROR PROBES ARE TAKEN BEFORE THE TICK while candidate rows are still pending.
MIRROR11="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T11_CAND" 2>/dev/null)"
MIRROR11B="$(DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" mirror "$T11B_CAND" 2>/dev/null)"

snapshot "$WORK/s6.txt"
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote | sed 's/^/  | /'
snapshot "$WORK/s7.txt"
PROMOTED4="$(promoted "$WORK/s6.txt" "$WORK/s7.txt")"
echo "  promoted on tick 4 : ${PROMOTED4:-<none>}"
echo

echo '--- 10. case 11 — R11: cancelled dependency satisfies the candidate ------------'
assert_eq 'case 11: candidate with cancelled dependency PROMOTED' 'yes' "$(inset "$T11_CAND" "$PROMOTED4")"
assert_eq 'case 11: candidate is now ready' 'ready' "$(st "$T11_CAND")"
assert_has 'case 11 MIRROR: candidate took the graph branch' "$MIRROR11" 'MIRROR_RULE=graph'
assert_has 'case 11 MIRROR: graphReady() releases candidate with cancelled dep' "$MIRROR11" 'MIRROR=true'
echo

echo '--- 10. case 11b — R69: cancelled lower-round row does not hold frozen candidate -'
assert_eq 'case 11b: frozen candidate over cancelled lower round PROMOTED' 'yes' "$(inset "$T11B_CAND" "$PROMOTED4")"
assert_eq 'case 11b: frozen candidate is now ready' 'ready' "$(st "$T11B_CAND")"
assert_has 'case 11b MIRROR: frozen candidate took the graph branch' "$MIRROR11B" 'MIRROR_RULE=graph'
assert_has 'case 11b MIRROR: graphReady() releases frozen candidate with cancelled lower round' "$MIRROR11B" 'MIRROR=true'
echo

# ---------------------------------------------------------------------------
# 8. Did every probe actually fire? A sweep whose probes miss must fail, never
#    certify itself (standing rule 3).
# ---------------------------------------------------------------------------
echo '--- 8. assertion census -------------------------------------------------------'
# EXPECTED_ASSERTIONS is maintained by hand, so it is ALSO checked against the
# file (round 204). Otherwise the only failure mode left is the tempting one: an
# author whose new case never runs edits the constant to match the run, and the
# census then certifies its own drift. Two independent numbers, both printed.
DEFINED_IN_FILE="$(grep -c "^assert_eq \|^assert_has \|^pass " "${BASH_SOURCE[0]}")"
echo "  assertions executed: $ASSERTIONS_RUN"
echo "  assertions declared: $EXPECTED_ASSERTIONS"
echo "  assertion CALLS in this file: $DEFINED_IN_FILE"
if [ "$DEFINED_IN_FILE" -ne "$EXPECTED_ASSERTIONS" ]; then
  echo "  FAIL: the file contains $DEFINED_IN_FILE assertion calls but declares" >&2
  echo "        EXPECTED_ASSERTIONS=$EXPECTED_ASSERTIONS — update the constant with the case." >&2
  exit 1
fi
if [ "$ASSERTIONS_RUN" -ne "$EXPECTED_ASSERTIONS" ]; then
  echo "  FAIL: $ASSERTIONS_RUN assertions ran but $EXPECTED_ASSERTIONS are defined — refusing to certify." >&2
  exit 1
fi
echo
echo "PASS — the graph branch promotes past an undrained round (R11), the legacy"
echo "       branch still waits (R12), the active gate is a filter (R13), a dangling"
echo "       dependency lands on blocked and notifies (R14), the legacy-row term holds"
echo "       a frozen closure (R69), that graph_frozen holds a DERIVED closure behind"
echo "       a post-restart row while releasing a declared one (E4/R71, case 5b), and"
echo "       the contention belt defers rather than fails"
echo "       (R16/R17). Round 204: no route into 'running' survives a corrupt"
echo "       depends_on — not promote, not retryTask, not an out-of-band 'ready'"
echo "       write — a duplicated id is refused by BOTH sides, and a cross-project"
echo "       id resolves to nothing in the SQL as well as in graphReady() (R27)."
echo "       Round 2026-08-26: cancelled dependencies (R11) and lower-round cancelled"
echo "       rows (R69 straddle) are recognized as terminal by SQL promoter and graphReady() (cases 11, 11b)."
echo "       git $HEAD_SHA · sha256(projects.ts)=${SUBJECT_SHA256:0:16}… · db=$DB_NAME · schema=$SCHEMA"
