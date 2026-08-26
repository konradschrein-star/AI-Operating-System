#!/usr/bin/env bash
# prove-close-gate-bites.sh — the mutation control for R70's INTEGRATOR FILTER,
# the term that says only a `main` task can integrate a workstream.
#
# WHY THIS FILE EXISTS, and it is not a hypothetical. On 2026-08-26 the round-3
# reviewer deleted that filter from BOTH sides — `AND i.workstream = 'main'`
# from the SQL in forge-control/src/db/projects.ts, and
# `t.workstream === MAIN_WORKSTREAM &&` from the pure predicate in
# forge-control/src/lib/task-graph.ts — and check-close-gate.ts still reported
# 51/51 PASS, exit 0. The mutant survived the entire Postgres harness. Fixture
# (6) `ws-foreign-integrator` had been built as the control for exactly that
# term, and it went inert the moment R70 became transitive: under transitive
# reach the CORRECT rule also closes that project, so both sides of the
# mutation agree and the control stopped discriminating (fleet memory:
# transitivity-makes-the-foreign-integrator-fixture-inert,
# mutation-inert-because-a-sibling-fix-rescues-it).
#
# A PIN ON A LITERAL IS NOT A TEST OF A TERM. project-tick.test.ts greps the
# string `i.workstream = 'main'` out of db/projects.ts. Every rewrite that KEEPS
# the literal and widens the disjunction around it passes that pin and all of
# the harness's assertions. The only thing that can refuse such a rewrite is a
# fixture whose verdict changes when the term stops biting — check-close-gate's
# fixture (13) `mutual-cover-non-main` — and the only thing that can prove the
# fixture still bites is running the mutation. That is this script, on demand,
# forever, instead of a transcript pasted into a comment once and trusted after.
#
# SHAPE FOLLOWED. scripts/checks/prove-idle-alarm-bites.sh (the sibling control,
# same project, database-backed) and scripts/checks/prove-ops-mode-bites.sh: a
# self-contained bash script, a fixed sequence, one EXIT trap for cleanup, and
# EXPECTED_ASSERTIONS accounting so a probe that silently never ran fails the
# run instead of certifying it.
#
# RESTORE IS `cp` FROM A BYTE COPY, VERIFIED BY sha256 — NEVER `git checkout`
# (fleet memory: mutation-control-restore-must-not-use-git-checkout). The
# subject files may legitimately carry uncommitted work; a checkout would
# destroy it, and this script must be safe to run mid-edit. The originals are
# copied to a mktemp directory BEFORE the first mutation, their sha256 recorded,
# and the run asserts the restored bytes hash to the recorded value.
#
# ─────────────────────────────────────────────────────────────────────────
# HAND-RUN ONLY, and it must NEVER be added to gates-808.sh: it needs a scratch
# database, and a check that needs one, wired into the shared suite, makes that
# suite red for every project on the branch forever, on a gate none of them
# touched (fleet memory: shared-suite-gate-that-cannot-pass — the mistake this
# fleet already paid a fix cycle for on 2026-08-25 with check-ops-scripts.sh).
# It also MUTATES TWO ENGINE SOURCE FILES for a few seconds; it belongs nowhere
# near a build that another lane might be sharing a worktree with.
#
#   SCRATCH_DATABASE_URL   an EXISTING, local, throwaway postgres database. Not
#                          validated here beyond "set": it is passed straight
#                          through to check-close-gate.ts, whose refuse-to-run
#                          guard is the one that owns that decision (never
#                          content_forge, never postgres/template0/template1,
#                          never a database this fleet's config names).
#
# Run:
#   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
#   export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
#   bash scripts/checks/prove-close-gate-bites.sh
#
# Exit: 0 = the control ran every probe it declares and the mutant DIED.
#       Anything else is non-zero, and a non-zero exit with the restore probe
#       failed means the subject files are still mutated — the message says so.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_SUBJECT="forge-control/src/db/projects.ts"
PURE_SUBJECT="forge-control/src/lib/task-graph.ts"
HARNESS="scripts/checks/check-close-gate.ts"

# The two mutation sites, quoted here and nowhere else. Both are matched
# EXACTLY ONCE before anything is written — a site that has moved or been
# reworded must stop this script, not be silently skipped (a mutation that
# mutates nothing is the purest form of a control that cannot fail).
#
# Both are used verbatim: SQL_SITE as a `grep -F` pattern (whole line dropped),
# PURE_SITE as a `sed` SEARCH pattern — where `&` is literal, unlike in a
# replacement — so neither needs escaping and neither can drift out of sync
# with what the assertion below counts.
SQL_SITE="                  AND i.workstream = 'main'"
PURE_SITE="    .filter((t) => t.workstream === MAIN_WORKSTREAM && t.depends_on !== null)"
PURE_MUTANT="    .filter((t) => t.depends_on !== null)"

# 8 = two site probes, the green baseline, the "it really changed on disk"
# probe, the RED exit AND its attribution to fixture (13), the sha-verified
# restore, and the green re-run.
EXPECTED_ASSERTIONS=8
assertions_run=0
assertions_failed=0

ok()   { assertions_run=$((assertions_run + 1)); printf '      ok   %s\n' "$1"; }
bad()  { assertions_run=$((assertions_run + 1)); assertions_failed=$((assertions_failed + 1))
         printf '      FAIL %s\n' "$1" >&2; }
assert() { if [ "$1" = "yes" ]; then ok "$2"; else bad "$2 — $3"; fi; }

refuse() { printf 'REFUSING TO RUN: %s\n' "$1" >&2; exit 2; }

[ -n "${SCRATCH_DATABASE_URL:-}" ] || refuse \
  "\$SCRATCH_DATABASE_URL is unset. This control never guesses a connection string; see the header."
[ -f "$REPO_ROOT/$SQL_SUBJECT" ]  || refuse "$SQL_SUBJECT not found under $REPO_ROOT"
[ -f "$REPO_ROOT/$PURE_SUBJECT" ] || refuse "$PURE_SUBJECT not found under $REPO_ROOT"
[ -x "$REPO_ROOT/forge-control/node_modules/.bin/tsx" ] || refuse \
  "forge-control/node_modules/.bin/tsx is missing — run: cd forge-control && pnpm install --frozen-lockfile --prod=false"

BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prove-close-gate.XXXXXX")"
RESTORED=no

cleanup() {
  # Idempotent: the happy path restores and sets RESTORED=yes before exiting,
  # and this trap is the net for every other path (a psql that hangs and is
  # killed, an interrupt, an unexpected non-zero anywhere above).
  if [ "$RESTORED" != yes ] && [ -f "$BACKUP_DIR/projects.ts" ]; then
    cp "$BACKUP_DIR/projects.ts"   "$REPO_ROOT/$SQL_SUBJECT"
    cp "$BACKUP_DIR/task-graph.ts" "$REPO_ROOT/$PURE_SUBJECT"
    printf '\n  (EXIT trap restored both subject files from %s)\n' "$BACKUP_DIR" >&2
  fi
  rm -f "$BACKUP_DIR/projects.ts" "$BACKUP_DIR/task-graph.ts"
  rmdir "$BACKUP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

run_harness() {
  # Returns the harness's exit status; its output goes to $1.
  ( cd "$REPO_ROOT/forge-control" \
      && ./node_modules/.bin/tsx "../$HARNESS" ) > "$1" 2>&1
}

echo "=== prove-close-gate-bites.sh — build identity ==============================="
echo "  repo worktree     : $REPO_ROOT"
echo "  git HEAD          : $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '<no git>')"
echo "  git branch        : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<no git>')"
echo "  SQL subject       : $SQL_SUBJECT"
echo "  pure subject      : $PURE_SUBJECT"
echo "  harness           : $HARNESS"
echo "  backup dir        : $BACKUP_DIR"
echo "  expected probes   : $EXPECTED_ASSERTIONS"
echo "=============================================================================="
echo

echo "--- 1. both mutation sites exist, exactly once -------------------------------"
sql_hits=$(grep -cF "$SQL_SITE" "$REPO_ROOT/$SQL_SUBJECT")
pure_hits=$(grep -cF "$PURE_SITE" "$REPO_ROOT/$PURE_SUBJECT")
assert "$([ "$sql_hits" = 1 ] && echo yes || echo no)" \
  "the SQL integrator filter is present exactly once in $SQL_SUBJECT" \
  "grep -c found $sql_hits, expected 1 — the term moved or was reworded; re-read it before trusting this control"
assert "$([ "$pure_hits" = 1 ] && echo yes || echo no)" \
  "the pure integrator filter is present exactly once in $PURE_SUBJECT" \
  "grep -c found $pure_hits, expected 1 — the predicate moved; re-read it before trusting this control"
if [ "$sql_hits" != 1 ] || [ "$pure_hits" != 1 ]; then
  echo "  ABORTING before any write: a mutation that mutates nothing is a control that cannot fail." >&2
  exit 1
fi
cp "$REPO_ROOT/$SQL_SUBJECT"  "$BACKUP_DIR/projects.ts"
cp "$REPO_ROOT/$PURE_SUBJECT" "$BACKUP_DIR/task-graph.ts"
SQL_SHA=$(sha256sum "$BACKUP_DIR/projects.ts"   | cut -d' ' -f1)
PURE_SHA=$(sha256sum "$BACKUP_DIR/task-graph.ts" | cut -d' ' -f1)
echo "      sha256($SQL_SUBJECT)  = ${SQL_SHA:0:16}…"
echo "      sha256($PURE_SUBJECT) = ${PURE_SHA:0:16}…"
echo

echo "--- 2. GREEN baseline: the harness passes UNMUTATED ---------------------------"
run_harness "$BACKUP_DIR/green-before.log"; green_before=$?
assert "$([ "$green_before" = 0 ] && echo yes || echo no)" \
  "check-close-gate.ts exits 0 before the mutation" \
  "exit $green_before — fix the harness first; a control cannot tell you anything from a red baseline. Output: $BACKUP_DIR/green-before.log"
echo "      $(grep -E 'assertions run|PASS|FAILED' "$BACKUP_DIR/green-before.log" | tr '\n' ' ')"
echo

echo "--- 3. MUTATE: delete the integrator filter from BOTH sides -------------------"
# The SQL side: drop the whole line. The pure side: drop the workstream test
# from the filter, keeping the NULL test, so the mutant is exactly "any task
# that names a dependency may integrate a workstream" and nothing else changes.
grep -vF "$SQL_SITE" "$BACKUP_DIR/projects.ts" > "$REPO_ROOT/$SQL_SUBJECT"
sed "s|$PURE_SITE|$PURE_MUTANT|" "$BACKUP_DIR/task-graph.ts" > "$REPO_ROOT/$PURE_SUBJECT"
sql_mutated_sha=$(sha256sum "$REPO_ROOT/$SQL_SUBJECT"  | cut -d' ' -f1)
pure_mutated_sha=$(sha256sum "$REPO_ROOT/$PURE_SUBJECT" | cut -d' ' -f1)
assert "$([ "$sql_mutated_sha" != "$SQL_SHA" ] && [ "$pure_mutated_sha" != "$PURE_SHA" ] && echo yes || echo no)" \
  "both subject files actually changed on disk" \
  "sha256 unchanged on one or both — the mutation did not apply and the RED below would be meaningless"
echo "      $SQL_SUBJECT  → ${sql_mutated_sha:0:16}…"
echo "      $PURE_SUBJECT → ${pure_mutated_sha:0:16}…"
echo

echo "--- 4. RED: the mutant must DIE ----------------------------------------------"
run_harness "$BACKUP_DIR/red.log"; red=$?
assert "$([ "$red" != 0 ] && echo yes || echo no)" \
  "check-close-gate.ts exits NON-ZERO with the integrator filter deleted" \
  "exit 0 — THE MUTANT SURVIVED. This is the exact condition that made round 4 necessary; the fixture that is supposed to kill it is not killing it. Output: $BACKUP_DIR/red.log"
# Attribution, the same discipline check-close-gate's own positive control uses:
# a RED that comes from somewhere else proves nothing about this term.
assert "$(grep -qE 'FAIL \(13\)' "$BACKUP_DIR/red.log" && echo yes || echo no)" \
  "the failure is attributed to fixture (13), the integrator-filter control" \
  "no 'FAIL (13)' line in the output — the harness went red for some other reason, which is not evidence about this term. Output: $BACKUP_DIR/red.log"
grep -E 'FAIL |assertions failed' "$BACKUP_DIR/red.log" | sed 's/^/      /'
echo

echo "--- 5. RESTORE by cp, verified by sha256 -------------------------------------"
cp "$BACKUP_DIR/projects.ts"   "$REPO_ROOT/$SQL_SUBJECT"
cp "$BACKUP_DIR/task-graph.ts" "$REPO_ROOT/$PURE_SUBJECT"
sql_back=$(sha256sum "$REPO_ROOT/$SQL_SUBJECT"  | cut -d' ' -f1)
pure_back=$(sha256sum "$REPO_ROOT/$PURE_SUBJECT" | cut -d' ' -f1)
if [ "$sql_back" = "$SQL_SHA" ] && [ "$pure_back" = "$PURE_SHA" ]; then
  RESTORED=yes
  ok "both subject files restored byte-for-byte (sha256 matches the pre-mutation copy)"
else
  bad "RESTORE FAILED — $SQL_SUBJECT and/or $PURE_SUBJECT are NOT back to their original bytes. The copies are in $BACKUP_DIR and this script will NOT delete them."
  trap - EXIT
  echo "  originals kept at: $BACKUP_DIR" >&2
  exit 1
fi
echo

echo "--- 6. GREEN again: the restore did not leave a scar --------------------------"
run_harness "$BACKUP_DIR/green-after.log"; green_after=$?
assert "$([ "$green_after" = 0 ] && echo yes || echo no)" \
  "check-close-gate.ts exits 0 again after the restore" \
  "exit $green_after — the worktree is not back where it started. Output: $BACKUP_DIR/green-after.log"
echo "      $(grep -E 'assertions run|PASS|FAILED' "$BACKUP_DIR/green-after.log" | tr '\n' ' ')"
echo

echo "=== summary =================================================================="
echo "  probes run    : $assertions_run (expected $EXPECTED_ASSERTIONS)"
echo "  probes failed : $assertions_failed"
if [ "$assertions_run" != "$EXPECTED_ASSERTIONS" ]; then
  echo "  PROBE COUNT MISMATCH: a control whose probes miss must fail, not certify itself." >&2
  exit 1
fi
if [ "$assertions_failed" != 0 ]; then
  echo "  FAILED — the integrator filter has no behavioural control." >&2
  exit 1
fi
echo "  PASS — the mutant died on fixture (13)."
exit 0
