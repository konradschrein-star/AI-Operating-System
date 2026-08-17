#!/usr/bin/env bash
#
# check-scheduler-sql.sh — the behavioural proof that the SQL in
# forge-control/src/db/projects.ts schedules from the GRAPH: R11 (a graph row
# promotes with its round undrained), R12 (a legacy row still waits for every
# strictly lower round), R13 (the p.status = 'active' gate is a filter, not a
# state change), R14 (a dangling dependency lands on `blocked` and notifies,
# never on `ready`) and R69 (the legacy-row term holds a frozen closure behind
# a post-migration legacy row).
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
# R14's two halves are EXACT COMPLEMENTS by construction: the sweep's predicate
# is the literal negation of the promote branch's cardinality term, and the
# sweep runs FIRST in the same function call. So there is no input for which
# the promote statement refuses a row the sweep did not already block, and case
# 3 cannot observe the front half in isolation through the public function.
# What it CAN assert, and does: the corrupt row is not among the ids promoted,
# and after the call NO pending row of an active project is left carrying a
# cardinality mismatch — the complement property itself, asserted mechanically
# instead of claimed in a comment.
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
EXPECTED_ASSERTIONS=40
ASSERTIONS_RUN=0
# Every row the seed inserts: 3 + 2 + 2 + 3 + 2 + 4 across the six cases.
# T3_GHOST is NOT among them — it is the id case 3 names and nobody inserts.
# Guard against failure mode (a).
SEED_EXPECTED_ROWS=16

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
assert_eq 'all three 0040 columns present' '3' \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCHEMA' AND table_name='project_tasks' AND column_name IN ('depends_on','workstream','write_set')")"
assert_eq 'notifications table reachable in this search_path' 'notifications' \
  "$(q "SELECT table_name FROM information_schema.tables WHERE table_schema='$SCHEMA' AND table_name='notifications'")"
assert_eq 'notifications starts empty (failure mode (d))' '0' \
  "$(q 'SELECT count(*) FROM notifications')"
echo

# ---------------------------------------------------------------------------
# 3. Seed. Seven synthetic projects, one per case, so that a project-scoped
#    rule (the legacy branch, R69's term, the sweep's project block) cannot
#    leak between cases. Every id is a literal, so every assertion names the
#    row it is about (failure mode (b), (c)).
# ---------------------------------------------------------------------------
echo '--- 3. seed -------------------------------------------------------------------'
P1='00000000-0000-4000-8000-0000000000c1'   # R11
P2='00000000-0000-4000-8000-0000000000c2'   # R12
P3='00000000-0000-4000-8000-0000000000c3'   # R14
P5='00000000-0000-4000-8000-0000000000c5'   # R69
P6='00000000-0000-4000-8000-0000000000c6'   # R13
P7='00000000-0000-4000-8000-0000000000c7'   # R16/R17 claim belt

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
T6_ROOT='00000000-0000-4000-8000-00000000130a'
T6_LEGACY='00000000-0000-4000-8000-00000000130b'
T7_A='00000000-0000-4000-8000-00000000160a'
T7_B='00000000-0000-4000-8000-00000000160b'
T7_C='00000000-0000-4000-8000-00000000160c'
T7_D='00000000-0000-4000-8000-00000000160d'

psql_run -q >/dev/null <<SQL
INSERT INTO projects (id, name, brief, repo, status) VALUES
  ('$P1','case1-R11','synthetic','ai-os','active'),
  ('$P2','case2-R12','synthetic','ai-os','active'),
  ('$P3','case3+4-R14','synthetic','ai-os','active'),
  ('$P5','case5-R69','synthetic','ai-os','active'),
  ('$P6','case6-R13','synthetic','ai-os','paused'),
  ('$P7','case7-R16','synthetic','ai-os','active');

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
SQL
SEEDED="$(q 'SELECT count(*) FROM project_tasks')"
echo "  seeded rows        : $SEEDED across 6 projects"
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
assert_eq 'R14 front: no pending row of an active project keeps a mismatch' '0' \
  "$(q "SELECT count(*) FROM project_tasks pt JOIN projects p ON p.id = pt.project_id
         WHERE p.status = 'active' AND pt.status = 'pending' AND pt.depends_on IS NOT NULL
           AND cardinality(pt.depends_on) <> (SELECT count(*) FROM project_tasks d WHERE d.id = ANY(pt.depends_on))")"
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
UPDATE project_tasks SET status = 'done' WHERE id IN ('$T2_LOW','$T5_LEGACY');
UPDATE projects SET status = 'active' WHERE id = '$P6';
SQL
snapshot "$WORK/s2.txt"
DATABASE_URL="$DRIVER_URL" "$TSX" "$WORK/drive.mts" promote | sed 's/^/  | /'
snapshot "$WORK/s3.txt"
PROMOTED2="$(promoted "$WORK/s2.txt" "$WORK/s3.txt")"
echo "  promoted on tick 2 : $PROMOTED2"
assert_eq 'R12: legacy candidate promotes once its round drains' 'yes' "$(inset "$T2_CAND" "$PROMOTED2")"
assert_eq 'R69: candidate promotes once the legacy row is done' 'yes' "$(inset "$T5_CAND" "$PROMOTED2")"
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
# 8. Did every probe actually fire? A sweep whose probes miss must fail, never
#    certify itself (standing rule 3).
# ---------------------------------------------------------------------------
echo '--- 8. assertion census -------------------------------------------------------'
echo "  assertions executed: $ASSERTIONS_RUN"
echo "  assertions defined : $EXPECTED_ASSERTIONS"
if [ "$ASSERTIONS_RUN" -ne "$EXPECTED_ASSERTIONS" ]; then
  echo "  FAIL: $ASSERTIONS_RUN assertions ran but $EXPECTED_ASSERTIONS are defined — refusing to certify." >&2
  exit 1
fi
echo
echo "PASS — the graph branch promotes past an undrained round (R11), the legacy"
echo "       branch still waits (R12), the active gate is a filter (R13), a dangling"
echo "       dependency lands on blocked and notifies (R14), the legacy-row term holds"
echo "       a frozen closure (R69), and the contention belt defers rather than fails"
echo "       (R16/R17)."
echo "       git $HEAD_SHA · sha256(projects.ts)=${SUBJECT_SHA256:0:16}… · db=$DB_NAME · schema=$SCHEMA"
