#!/usr/bin/env bash
#
# check-workstream-e2e.sh — the behavioural proof for engine-task-graph phase 4A:
# R32 (provisionWorkstream, idempotent and race-safe), R33 (branch naming),
# R34 (sibling directories, and the cleanliness gate stays quiet), R35
# (removeWorkspace tears down every workstream), R38's proof obligation (a real
# merge conflict resolves NOTHING), R39's provisioning-side refusal, and NF1 on
# the recovery path (a re-provisioned workstream ANNOUNCES the uncommitted work
# it could not save — §9, added round 225 from phase 4's red-team finding 1).
#
# It is an INTEGRATION check, not a unit test: it needs a real git and a real
# pnpm, so it lives here and never runs inside `pnpm test` (NF3 — the unit suite
# is `tsx --test src/lib/*.test.ts`, hermetic, type-only imports of db/*).
#
# IT NEEDS NO DATABASE. Nothing here issues a SQL statement, so unlike
# check-migration-0040.sh there is no $SCRATCH_DATABASE_URL and no refuse-to-run
# DSN guard. `provisionWorkstream` does reach routes/projects.ts for R39's
# constant, which constructs pg Pools at module scope — pg's Pool is lazy and
# opens no connection until a query is issued, and this script issues none.
#
# ---------------------------------------------------------------------------
# IT NEVER TOUCHES A REAL REPO. Every git operation happens inside one
# `mktemp -d`, against a repository this script creates. The two environment
# variables lib/workspace.ts reads for its paths — AI_OS_REPO_DIR and
# PROJECT_WORKTREE_ROOT — are overridden to point inside that directory, so the
# code under test cannot reach /opt/forge-ai-os, this worktree, or
# /opt/ai-os/workspace/projects even if it wanted to. The temp directory is
# removed on exit.
#
# ---------------------------------------------------------------------------
# WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY — and why it cannot.
#
#   (a) IT TESTED A STALE BUILD. This is the failure that already cost this
#       fleet a round: a harness certifying bytes other than the ones it named.
#       Guarded by printing the identity of the bytes under test BEFORE any
#       assertion, and by making that identity content-addressed rather than a
#       branch name. `git rev-parse HEAD` names a COMMIT and would not change
#       when workspace.ts is edited and uncommitted, so it is printed as
#       context only; the authoritative line is `sha256sum` of
#       forge-control/src/lib/workspace.ts, the actual file this run imports,
#       resolved from this script's own location rather than from $PWD. The
#       driver additionally prints the absolute path it imported, so the
#       transcript records which file was loaded and not merely which one was
#       hashed.
#   (b) AN ASSERTION SILENTLY DID NOT RUN. A `case` that matched nothing, a
#       section skipped by an early `return`, a probe that missed. Guarded by
#       EXPECTED_ASSERTIONS: every assertion increments a counter and the final
#       gate fails if the counter is not EXACTLY that number. Too few means
#       probes were skipped; too many means an assertion was added without
#       updating the declared count, and both are failures rather than passes.
#       `set -e` plus the ERR trap means an abort anywhere reads as a failure
#       with a line number, never as a quiet early return.
#   (c) THE SUBJECT NEVER RAN. A driver that failed to import workspace.ts and
#       printed nothing would make several `assert_has` calls compare empty
#       strings. Guarded because the driver prints a JSON object on EVERY path
#       including its own failures, and because the first assertions are
#       positive ones on real returned values (a directory and a branch name)
#       rather than absences.
#   (d) THE CAP TEST PASSED BECAUSE 6 IS HARD-CODED HERE. R39's limit is
#       env-overridable, so an assertion hard-coding 6 would be a gate that
#       cannot be passed on a box that overrides it — the unsatisfiable-gate
#       failure standing rule 2 exists to kill. Guarded by asking the driver
#       for the limit the code actually resolved and computing the test from
#       it, and by asserting the UNSET default separately.
#   (e) THE MERGE CASE PASSED BECAUSE THE MERGE NEVER STARTED. A merge that
#       fails for an unrelated reason also exits non-zero. Guarded by asserting
#       all four of: non-zero exit, the conflicting filename verbatim in the
#       output, conflict markers left in the file, and HEAD unmoved.
#   (f) THE NF1 WARNING PASSED BECAUSE IT IS UNCONDITIONAL. A `console.warn` on
#       every provisioning would satisfy §9.4 while telling an operator nothing.
#       Guarded by two NEGATIVE controls on the same string — §5.6 (a first-ever
#       checkout) and §7.4 (the idempotent path) must both be SILENT — and by
#       §9.9, which asserts the uncommitted file really did disappear, so the
#       announcement is about a loss that actually happened.
#
# Usage:  bash scripts/checks/check-workstream-e2e.sh
# Exit:   0 = every assertion passed AND every assertion ran.
#
set -euo pipefail
trap 'rc=$?; [ $rc -ne 0 ] && echo "check-workstream-e2e.sh: ABORTED at line $LINENO (exit $rc) — NOT a pass" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO_ROOT/forge-control/src/lib/workspace.ts"
TSX="$REPO_ROOT/forge-control/node_modules/.bin/tsx"

# Every assertion this file defines. Kept in sync by hand and enforced at the
# end: a mismatch in either direction FAILS.
EXPECTED_ASSERTIONS=61
ASSERTIONS_RUN=0

# The distinguishing substring of `provisionWorkstream`'s NF1 loss warning
# (§5.6, §7.4, §9.4). Written once, asserted PRESENT in exactly one section and
# ABSENT in two others, so a warning that became unconditional — or that stopped
# firing — fails rather than passes.
LOSS_WARN="a previous checkout of branch"

pass() {
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
  printf '  ok   %-54s %s\n' "$1" "${2-}"
}
fail() {
  printf '  FAIL %-54s %s\n' "$1" "${2-}" >&2
  printf '\ncheck-workstream-e2e.sh FAILED after %d assertions\n' "$ASSERTIONS_RUN" >&2
  exit 1
}
assert_eq() {   # name expected actual
  [ "$2" = "$3" ] && pass "$1" "= $3" || fail "$1" "expected [$2] got [$3]"
}
assert_ne() {   # name notexpected actual
  [ "$2" != "$3" ] && pass "$1" "!= $2" || fail "$1" "must not be [$2]"
}
assert_has() {  # name haystack needle
  case "$2" in *"$3"*) pass "$1" "contains: $3" ;; *) fail "$1" "missing [$3] in [$2]" ;; esac
}
assert_nonzero() {  # name rc
  [ "$2" -ne 0 ] && pass "$1" "exit $2" || fail "$1" "expected non-zero exit, got 0"
}
assert_lacks() {  # name haystack needle
  case "$2" in *"$3"*) fail "$1" "found [$3] in [$2]" ;; *) pass "$1" "no: $3" ;; esac
}

# ---------------------------------------------------------------------------
# 0. BUILD IDENTITY — first, before a single assertion, so the transcript
#    records which bytes were exercised. See (a) above for why the sha256 and
#    not the commit is the authoritative line.
# ---------------------------------------------------------------------------
echo "check-workstream-e2e.sh — engine-task-graph phase 4 (R32–R35, R38, R39, NF1)"
echo
echo "BUILD IDENTITY OF THE CODE UNDER TEST"
echo "  worktree path      : $REPO_ROOT"
echo "  git HEAD           : $(git -C "$REPO_ROOT" rev-parse HEAD)"
echo "  git branch         : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
echo "  subject            : $SUBJECT"
echo "  subject sha256     : $(sha256sum "$SUBJECT" | cut -d' ' -f1)   <-- authoritative"
echo "  subject mtime      : $(date -r "$SUBJECT" '+%Y-%m-%d %H:%M:%S %z')"
echo "  workspace.ts dirty : $(git -C "$REPO_ROOT" status --porcelain -- forge-control/src/lib/workspace.ts | head -1 | sed 's/^/[/;s/$/]/' | grep . || echo '[committed, matches HEAD]')"
echo "  tsx                : $TSX"
echo "  node               : $(node --version)"
echo "  git                : $(git --version)"
echo "  pnpm               : $(pnpm --version)"
echo

[ -x "$TSX" ] || { echo "REFUSING TO RUN: no tsx at $TSX — run 'pnpm install' in forge-control first" >&2; exit 1; }
[ -f "$SUBJECT" ] || { echo "REFUSING TO RUN: no workspace.ts at $SUBJECT" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
WROOT="$TMP/worktrees"

# Two project ids. Fixed, so reruns are byte-comparable; they exist only inside
# $TMP. Both must satisfy UUID_RE in workspace.ts.
PID='11111111-2222-4333-8444-555555555555'
ID8='11111111'
PID_UNPROVISIONED='99999999-2222-4333-8444-555555555555'

# ---------------------------------------------------------------------------
# The driver. `provisionWorkstream` is exercised through the real exported
# function — its logic is never reimplemented in bash — and every path,
# including its own failures, prints one JSON object so the caller always has
# something to assert on.
# ---------------------------------------------------------------------------
DRIVER="$TMP/driver.mts"
cat > "$DRIVER" <<EOF
import {
  provisionWorkspace,
  provisionWorkstream,
  removeWorkspace,
} from "$SUBJECT";

const [cmd, id, workstream] = process.argv.slice(2);
const project = { id, repo: "ai-os" as const, base_branch: "main" };

try {
  if (cmd === "identity") {
    // Which file did this process actually import? Printed so the transcript
    // records the loaded path, not only the hashed one.
    const routes = await import("$REPO_ROOT/forge-control/src/routes/projects.ts");
    console.log(JSON.stringify({
      subject: "$SUBJECT",
      limit: routes.PROJECT_MAX_WORKSTREAMS,
    }));
  } else if (cmd === "workspace") {
    console.log(JSON.stringify(await provisionWorkspace(project)));
  } else if (cmd === "workstream") {
    console.log(JSON.stringify(await provisionWorkstream(project, workstream)));
  } else if (cmd === "remove") {
    await removeWorkspace(project);
    console.log(JSON.stringify({ removed: true }));
  } else {
    console.log(JSON.stringify({ error: \`driver: unknown command \${cmd}\` }));
    process.exit(2);
  }
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
// Explicit: routes/projects.ts constructs pg Pools at module scope. They hold
// no handles until a query is issued and none is, but exiting deliberately
// keeps a future eager handle from turning this check into a hang, which would
// read as neither a pass nor a fail.
process.exit(0);
EOF

DRIVE_OUT=""
DRIVE_ERR=""
DRIVE_RC=0
# `&& ... || ...` and NOT `set +e`: several probes here are EXPECTED to fail
# (a refused workstream, a conflicted merge), and bash runs the ERR trap on a
# failing command even while errexit is off. Written as an || list, the failure
# is exempt from both, so an intentional non-zero exit cannot print "ABORTED —
# NOT a pass" into the transcript of a passing run. A harness whose own output
# says it aborted while it reports success is an instrument nobody will read
# twice.
#
# STDOUT AND STDERR ARE CAPTURED SEPARATELY, and that is not tidiness. §9's NF1
# assertions read the subject's `console.warn`, which goes to STDERR, while
# every other assertion reads the driver's one JSON object on STDOUT — merged
# with `2>&1` as this used to be, a single warning line would make `jget`'s
# `json.load` throw and every JSON assertion in the run would collapse. Both
# streams are kept so a driver that dies before printing JSON still leaves its
# diagnosis in the transcript.
drive() {   # [env assignments handled by caller via DRIVE_ENV] cmd args...
  local o="$TMP/drive.out" e="$TMP/drive.err"
  env AI_OS_REPO_DIR="$REPO" PROJECT_WORKTREE_ROOT="$WROOT" \
    ${DRIVE_ENV:-} "$TSX" "$DRIVER" "$@" > "$o" 2> "$e" && DRIVE_RC=0 || DRIVE_RC=$?
  DRIVE_OUT="$(cat "$o")"
  DRIVE_ERR="$(cat "$e")"
}
jget() {    # json key
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$2"
}

# ---------------------------------------------------------------------------
# 1. R33 — THE BRANCH-NAMING REFUSAL, reproduced rather than taken on trust.
#    Its own repository, so nothing here can be confused with the subject.
# ---------------------------------------------------------------------------
echo "1. R33 — git refuses project/<id8>/<ws> beside project/<id8>"
R33="$TMP/r33"
git init -q -b main "$R33"
git -C "$R33" commit -q --allow-empty -m x
git -C "$R33" branch "project/abc123"
SLASH_OUT="$(git -C "$R33" branch "project/abc123/ui" 2>&1)" && SLASH_RC=0 || SLASH_RC=$?
git -C "$R33" branch "project/abc123-ui" >/dev/null 2>&1 && HYPHEN_RC=0 || HYPHEN_RC=$?
assert_nonzero "1.1 slash form refused"            "$SLASH_RC"
assert_has     "1.2 refusal names the ref conflict" "$SLASH_OUT" "cannot lock ref"
assert_eq      "1.3 hyphen form accepted"          "0" "$HYPHEN_RC"
echo "      transcript: $SLASH_OUT"
echo

# ---------------------------------------------------------------------------
# 2. THE SUBJECT'S OWN IDENTITY, and R39's limit as the CODE resolved it.
# ---------------------------------------------------------------------------
echo "2. subject identity and the resolved R39 limit"
DRIVE_ENV="" ; drive identity "$PID" ""
[ "$DRIVE_RC" -eq 0 ] || fail "2.0 driver ran" "driver exited $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
assert_eq "2.1 driver imported the hashed file" "$SUBJECT" "$(jget "$DRIVE_OUT" subject)"
DEFAULT_LIMIT="$(jget "$DRIVE_OUT" limit)"
assert_eq "2.2 unset PROJECT_MAX_WORKSTREAMS defaults to 6" "6" "$DEFAULT_LIMIT"
echo

# ---------------------------------------------------------------------------
# 3. A WORKSTREAM CANNOT PRECEDE ITS PROJECT'S OWN BRANCH.
# ---------------------------------------------------------------------------
echo "3. a workstream cannot precede its project branch"
# The throwaway 'ai-os' repo, with a lockfile fixture so the node_modules
# decision (§9) is exercised on a real pnpm install and not asserted in theory.
git init -q -b main "$REPO"
printf 'node_modules\n' > "$REPO/.gitignore"
printf 'one\ntwo\nthree\n' > "$REPO/shared.txt"
mkdir -p "$REPO/tiny" "$REPO/app"
printf '{"name":"tiny","version":"1.0.0","private":true,"main":"index.js"}\n' > "$REPO/tiny/package.json"
printf 'module.exports = 1;\n' > "$REPO/tiny/index.js"
printf '{"name":"app","version":"1.0.0","private":true,"dependencies":{"tiny":"file:../tiny"}}\n' > "$REPO/app/package.json"
( cd "$REPO/app" && pnpm install --lockfile-only >/dev/null 2>&1 && rm -rf node_modules )
git -C "$REPO" add -A
git -C "$REPO" -c user.email=e2e@local -c user.name=e2e commit -q -m "fixture"

DRIVE_ENV="" ; drive workstream "$PID_UNPROVISIONED" ui
assert_nonzero "3.1 refused with no project branch" "$DRIVE_RC"
assert_has     "3.2 error names the missing branch" "$(jget "$DRIVE_OUT" error)" "project/99999999"
echo

# ---------------------------------------------------------------------------
# 4. WORKSTREAM 'main' IS A PASSTHROUGH — the single most important
#    compatibility property in this phase. No live project changes branch or
#    directory, which is the whole reason the deploy is safe.
# ---------------------------------------------------------------------------
echo "4. workstream 'main' is a passthrough (R32, R33, R34)"
DRIVE_ENV="" ; drive workspace "$PID" ""
[ "$DRIVE_RC" -eq 0 ] || fail "4.0 provisionWorkspace ran" "exit $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
WS_DIR="$(jget "$DRIVE_OUT" workspace_dir)"
WS_BRANCH="$(jget "$DRIVE_OUT" work_branch)"
assert_eq "4.1 provisionWorkspace dir"    "$WROOT/$PID"     "$WS_DIR"
assert_eq "4.2 provisionWorkspace branch" "project/$ID8"    "$WS_BRANCH"

DRIVE_ENV="" ; drive workstream "$PID" main
[ "$DRIVE_RC" -eq 0 ] || fail "4.x provisionWorkstream(main) ran at all" "exit $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
assert_eq "4.3 provisionWorkstream(main) same dir"    "$WS_DIR"    "$(jget "$DRIVE_OUT" workspace_dir)"
assert_eq "4.4 provisionWorkstream(main) same branch" "$WS_BRANCH" "$(jget "$DRIVE_OUT" work_branch)"
echo

# ---------------------------------------------------------------------------
# 5. A SECOND WORKSTREAM — R33's naming and R34's sibling layout.
# ---------------------------------------------------------------------------
echo "5. workstream 'ui' — branch, directory, sibling layout (R33, R34)"
DRIVE_ENV="" ; drive workstream "$PID" ui
[ "$DRIVE_RC" -eq 0 ] || fail "5.0 provisionWorkstream(ui) ran" "exit $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
UI_DIR="$(jget "$DRIVE_OUT" workspace_dir)"
UI_BRANCH="$(jget "$DRIVE_OUT" work_branch)"
assert_eq "5.1 ui branch is the hyphen form" "project/$ID8-ui" "$UI_BRANCH"
assert_eq "5.2 ui dir uses the double hyphen" "$WROOT/$PID--ui" "$UI_DIR"
assert_eq "5.3 ui dir is a SIBLING of main"   "$(dirname "$WS_DIR")" "$(dirname "$UI_DIR")"
case "$UI_DIR" in
  "$WS_DIR"/*) fail "5.4 ui dir is NOT nested inside main" "[$UI_DIR] is under [$WS_DIR]" ;;
  *)           pass "5.4 ui dir is NOT nested inside main" "not under $WS_DIR" ;;
esac
assert_has "5.5 git registers the ui worktree" "$(git -C "$REPO" worktree list --porcelain)" "worktree $UI_DIR"
# NEGATIVE CONTROL for §9's NF1 warning. A warning that fired on EVERY
# provisioning would pass §9 while telling an operator nothing, so the FIRST
# ever checkout of a brand-new branch must be silent about lost work.
assert_lacks "5.6 a first-ever checkout does not warn about loss" "$DRIVE_ERR" "$LOSS_WARN"
echo

# ---------------------------------------------------------------------------
# 6. R34's REAL POINT — the cleanliness gate stays quiet. `git status
#    --porcelain` in the MAIN worktree is the literal input to
#    REVIEWER_LIVE_CHECK and to the deploy task's pre-merge check.
# ---------------------------------------------------------------------------
echo "6. the cleanliness gate stays quiet with a second workstream present (R34)"
MAIN_PORCELAIN="$(git -C "$WS_DIR" status --porcelain)"
assert_eq "6.1 main worktree porcelain is EMPTY" "" "$MAIN_PORCELAIN"
UI_PORCELAIN="$(git -C "$UI_DIR" status --porcelain)"
assert_eq "6.2 ui worktree porcelain is EMPTY (node_modules ignored)" "" "$UI_PORCELAIN"
echo

# ---------------------------------------------------------------------------
# 7. IDEMPOTENCE — calling again returns the same answer and creates nothing.
# ---------------------------------------------------------------------------
echo "7. idempotence (R32)"
BEFORE_N="$(git -C "$REPO" worktree list --porcelain | grep -c '^worktree ')"
DRIVE_ENV="" ; drive workstream "$PID" ui
[ "$DRIVE_RC" -eq 0 ] || fail "7.0 second call ran" "exit $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
assert_eq "7.1 second call returns the same dir"    "$UI_DIR"    "$(jget "$DRIVE_OUT" workspace_dir)"
assert_eq "7.2 second call returns the same branch" "$UI_BRANCH" "$(jget "$DRIVE_OUT" work_branch)"
assert_eq "7.3 second call created no new worktree" "$BEFORE_N" \
          "$(git -C "$REPO" worktree list --porcelain | grep -c '^worktree ')"
# The second negative control: the idempotent path returns an EXISTING worktree
# and has lost nothing, so it too must be silent. §5.6 and this one together are
# what make §9.4 evidence rather than a constant.
assert_lacks "7.4 the idempotent call does not warn about loss" "$DRIVE_ERR" "$LOSS_WARN"
echo

# ---------------------------------------------------------------------------
# 8. THE RACE (R32). Two OS processes, started concurrently, for the SAME
#    workstream — the 2026-08-05 failure reproduced deliberately
#    ("fatal: a branch named 'project/7d8d5a55' already exists").
# ---------------------------------------------------------------------------
echo "8. two concurrent provisionWorkstream calls for the same workstream (R32)"
A_OUT="$TMP/race-a.json"; B_OUT="$TMP/race-b.json"
( env AI_OS_REPO_DIR="$REPO" PROJECT_WORKTREE_ROOT="$WROOT" "$TSX" "$DRIVER" workstream "$PID" race > "$A_OUT" 2>&1 ) &
PA=$!
( env AI_OS_REPO_DIR="$REPO" PROJECT_WORKTREE_ROOT="$WROOT" "$TSX" "$DRIVER" workstream "$PID" race > "$B_OUT" 2>&1 ) &
PB=$!
wait $PA && RA=0 || RA=$?
wait $PB && RB=0 || RB=$?
assert_eq "8.1 racer A succeeded" "0" "$RA"
assert_eq "8.2 racer B succeeded" "0" "$RB"
RACE_A="$(jget "$(cat "$A_OUT")" workspace_dir)|$(jget "$(cat "$A_OUT")" work_branch)"
RACE_B="$(jget "$(cat "$B_OUT")" workspace_dir)|$(jget "$(cat "$B_OUT")" work_branch)"
assert_eq "8.3 both racers agree on the answer" "$RACE_A" "$RACE_B"
assert_eq "8.4 exactly one 'race' worktree exists" "1" \
          "$(git -C "$REPO" worktree list --porcelain | grep -c "^worktree $WROOT/$PID--race\$")"
# Positive control on 8.3: two racers that both FAILED would also agree, on the
# empty string. Assert the agreed answer is the right one.
assert_eq "8.5 the agreed answer is the expected dir and branch" \
          "$WROOT/$PID--race|project/$ID8-race" "$RACE_A"
echo "      A: $(cat "$A_OUT")"
echo "      B: $(cat "$B_OUT")"
echo

# ---------------------------------------------------------------------------
# 9. RECOVERY — the directory is deleted from disk, the same way
#    project-tick.ts's `wsMissing` branch recovers the main worktree today,
#    AND IT SAYS SO (NF1). Round 224's red team measured the asymmetry: the
#    `main` recovery warns ("gone from disk — re-provisioning") while the
#    workstream path re-provisioned with "any warning about loss: 0". The
#    recovery is necessarily lossy for UNCOMMITTED work — nothing can bring
#    back a directory that was `rm -rf`'d — so the requirement is that the loss
#    is announced, not that it is prevented.
#
#    An uncommitted file is written into the worktree before the deletion so the
#    case tested is the one that actually loses something, rather than a
#    deletion of a clean checkout.
# ---------------------------------------------------------------------------
echo "9. a workstream worktree deleted from disk is re-provisioned, LOUDLY (R32, NF1)"
printf 'work in progress, never committed\n' > "$UI_DIR/uncommitted.txt"
UI_TIP_BEFORE="$(git -C "$REPO" rev-parse "$UI_BRANCH")"
rm -rf "$UI_DIR"
[ -d "$UI_DIR" ] && fail "9.0 the directory was really deleted" "still present"
DRIVE_ENV="" ; drive workstream "$PID" ui
[ "$DRIVE_RC" -eq 0 ] || fail "9.1 re-provision after rm -rf" "exit $DRIVE_RC: stdout[$DRIVE_OUT] stderr[$DRIVE_ERR]"
assert_eq "9.1 re-provision returns the same dir"    "$UI_DIR"    "$(jget "$DRIVE_OUT" workspace_dir)"
assert_eq "9.2 re-provision returns the same branch" "$UI_BRANCH" "$(jget "$DRIVE_OUT" work_branch)"
if [ -e "$UI_DIR/.git" ]; then
  pass "9.3 the directory is a live worktree again" "$UI_DIR/.git present"
else
  fail "9.3 the directory is a live worktree again" "no .git at $UI_DIR"
fi
# NF1: the loss is ANNOUNCED. Asserted on stderr, which is where console.warn
# goes and which §5.6/§7.4 proved is otherwise quiet on this string.
assert_has "9.4 the re-provision WARNED about the lost checkout" "$DRIVE_ERR" "$LOSS_WARN"
assert_has "9.5 the warning names the project"                   "$DRIVE_ERR" "$PID"
assert_has "9.6 the warning names the workstream"                "$DRIVE_ERR" '"ui"'
assert_has "9.7 the warning says the uncommitted state is gone"  "$DRIVE_ERR" "UNCOMMITTED"
# The claim the warning makes about COMMITTED work has to be true, or the
# message is a different kind of lie: the branch tip must be exactly where it
# was, and the re-created checkout must be sitting on it.
assert_eq "9.8 the branch tip is unmoved (commits really are intact)" \
          "$UI_TIP_BEFORE" "$(git -C "$REPO" rev-parse "$UI_BRANCH")"
[ -e "$UI_DIR/uncommitted.txt" ] \
  && fail "9.9 the uncommitted file really is gone" "$UI_DIR/uncommitted.txt survived — the case tested nothing" \
  || pass "9.9 the uncommitted file really is gone" "absent, which is what 9.4 announces"
echo "      warning: $DRIVE_ERR"
echo

# ---------------------------------------------------------------------------
# 10. VALIDATION IS AN INJECTION GUARD, NOT A NAMING NIT. `run()` in
#     lib/exec.ts executes a SHELL STRING; the workstream name lands inside
#     `git worktree add`. R28's validateWorkstream() is the one definition of a
#     legal name and this asserts the call site honours it.
# ---------------------------------------------------------------------------
echo "10. an injection-shaped workstream name is refused before any shell runs (R28 call site)"
CANARY="$TMP/PWNED"
DRIVE_ENV="" ; drive workstream "$PID" "ui; touch $CANARY"
assert_nonzero "10.1 injection-shaped name refused" "$DRIVE_RC"
assert_has "10.2 refusal comes from validateWorkstream" "$(jget "$DRIVE_OUT" error)" "validateWorkstream"
[ -e "$CANARY" ] && fail "10.3 no shell side effect" "the injected command RAN — $CANARY exists" \
                 || pass "10.3 no shell side effect" "canary absent"
echo

# ---------------------------------------------------------------------------
# 11. ARTIFACT ISOLATION — the decision priced in evidence/phase4-workstreams.md
#     §2. Declared write-sets prevent SOURCE conflicts only; nobody declares
#     their compiler's scratch space, so the worktree needs its OWN node_modules
#     to get its own build output.
# ---------------------------------------------------------------------------
echo "11. the workstream worktree owns its node_modules, and does not share one"
[ -d "$UI_DIR/app/node_modules" ] && pass "11.1 ui worktree has its own node_modules" "$UI_DIR/app/node_modules" \
                                  || fail "11.1 ui worktree has its own node_modules" "absent at $UI_DIR/app/node_modules"
[ -L "$UI_DIR/app/node_modules" ] && fail "11.2 it is a real directory, not a symlink" "it is a symlink" \
                                  || pass "11.2 it is a real directory, not a symlink" "not a symlink"
assert_eq "11.3 its realpath is inside the ui worktree" "$(realpath "$UI_DIR")/app/node_modules" \
          "$(realpath "$UI_DIR/app/node_modules")"
assert_ne "11.4 it is not the main worktree's" "$(realpath "$WS_DIR")/app/node_modules" \
          "$(realpath "$UI_DIR/app/node_modules")"
echo

# ---------------------------------------------------------------------------
# 12. R39 — the provisioning-side refusal. The limit is read from the code
#     rather than hard-coded here (see (d) in the header). Lowered to 4 for
#     this section so the test is fast and deterministic; the code path that
#     reads it is identical, and §2 already asserted the unset default is 6.
# ---------------------------------------------------------------------------
echo "12. PROJECT_MAX_WORKSTREAMS refuses a new workstream past the cap (R39)"
CAP=4
DISTINCT_NOW="$(git -C "$REPO" worktree list --porcelain | grep -c "^worktree $WROOT/$PID")"
echo "      distinct workstream worktrees before: $DISTINCT_NOW (main, ui, race); cap for this section: $CAP"
# Fill to exactly the cap. main+ui+race = 3, so one more reaches 4.
DRIVE_ENV="PROJECT_MAX_WORKSTREAMS=$CAP" ; drive workstream "$PID" api
assert_eq "12.1 the workstream AT the cap is allowed" "0" "$DRIVE_RC"
DRIVE_ENV="PROJECT_MAX_WORKSTREAMS=$CAP" ; drive workstream "$PID" docs
assert_nonzero "12.2 the workstream PAST the cap is refused" "$DRIVE_RC"
CAP_ERR="$(jget "$DRIVE_OUT" error)"
assert_has "12.3 the refusal names the count"          "$CAP_ERR" "$CAP workstream worktree(s) already exist"
assert_has "12.4 the refusal names the limit"          "$CAP_ERR" "PROJECT_MAX_WORKSTREAMS=$CAP"
assert_has "12.5 the refusal names the refused stream" "$CAP_ERR" '"docs"'
[ -d "$WROOT/$PID--docs" ] && fail "12.6 the refused worktree was NOT created" "$WROOT/$PID--docs exists" \
                           || pass "12.6 the refused worktree was NOT created" "absent"
DRIVE_ENV="PROJECT_MAX_WORKSTREAMS=$CAP" ; drive workstream "$PID" ui
assert_eq "12.7 an EXISTING workstream is still allowed at the cap" "0" "$DRIVE_RC"
echo "      refusal: $CAP_ERR"
echo

# ---------------------------------------------------------------------------
# 13. R38's PROOF OBLIGATION — a REAL merge conflict. This is the assertion the
#     red team will attack, because it is the one that proves there is no
#     auto-merge: contention becomes a git conflict inside a named task instead
#     of two agents overwriting each other in one directory.
# ---------------------------------------------------------------------------
echo "13. a real merge conflict resolves NOTHING (R38)"
printf 'one\nMAIN EDIT\nthree\n' > "$WS_DIR/shared.txt"
git -C "$WS_DIR" add shared.txt
git -C "$WS_DIR" -c user.email=e2e@local -c user.name=e2e commit -q -m "main edits shared.txt"
printf 'one\nUI EDIT\nthree\n' > "$UI_DIR/shared.txt"
git -C "$UI_DIR" add shared.txt
git -C "$UI_DIR" -c user.email=e2e@local -c user.name=e2e commit -q -m "ui edits shared.txt"

HEAD_BEFORE="$(git -C "$WS_DIR" rev-parse HEAD)"
MERGE_OUT="$(git -C "$WS_DIR" -c user.email=e2e@local -c user.name=e2e merge "$UI_BRANCH" 2>&1)" \
  && MERGE_RC=0 || MERGE_RC=$?
assert_nonzero "13.1 the merge exits non-zero"                "$MERGE_RC"
assert_has     "13.2 the output names the conflicting file"   "$MERGE_OUT" "shared.txt"
assert_has     "13.3 the file still holds conflict markers"   "$(cat "$WS_DIR/shared.txt")" "<<<<<<<"
assert_eq      "13.4 no merge commit was created (HEAD unmoved)" "$HEAD_BEFORE" "$(git -C "$WS_DIR" rev-parse HEAD)"
[ -f "$(git -C "$WS_DIR" rev-parse --git-dir)/MERGE_HEAD" ] \
  && pass "13.5 the merge stopped mid-flight, unresolved" "MERGE_HEAD present" \
  || fail "13.5 the merge stopped mid-flight, unresolved" "no MERGE_HEAD — the merge never started"
echo "      transcript:"
printf '%s\n' "$MERGE_OUT" | sed 's/^/        /'
git -C "$WS_DIR" merge --abort
echo

# ---------------------------------------------------------------------------
# 14. R35 — removeWorkspace tears down EVERY workstream, not just main.
# ---------------------------------------------------------------------------
echo "14. removeWorkspace removes every workstream worktree (R35)"
BEFORE_LIST="$(git -C "$REPO" worktree list --porcelain | grep -c "^worktree $WROOT/$PID")"
echo "      project worktrees before removal: $BEFORE_LIST"
DRIVE_ENV="" ; drive remove "$PID" ""
assert_eq "14.1 removeWorkspace exited cleanly (never throws)" "0" "$DRIVE_RC"
[ -d "$WS_DIR" ] && fail "14.2 the MAIN worktree is gone"  "$WS_DIR still exists" \
                 || pass "14.2 the MAIN worktree is gone"  "$WS_DIR absent"
[ -d "$UI_DIR" ] && fail "14.3 the 'ui' worktree is gone"   "$UI_DIR still exists" \
                 || pass "14.3 the 'ui' worktree is gone"   "$UI_DIR absent"
assert_eq "14.4 no project worktree remains registered" "0" \
          "$(git -C "$REPO" worktree list --porcelain | grep -c "^worktree $WROOT/$PID" || true)"
assert_eq "14.5 the removal really had work to do" "4" "$BEFORE_LIST"
echo

# ---------------------------------------------------------------------------
# 15. THE PROBE-COUNT GATE. A sweep whose probes miss must FAIL, never certify
#     itself (00-vision.md §7 rule 3).
# ---------------------------------------------------------------------------
if [ "$ASSERTIONS_RUN" -ne "$EXPECTED_ASSERTIONS" ]; then
  printf 'check-workstream-e2e.sh FAILED: ran %d assertions, expected exactly %d.\n' \
    "$ASSERTIONS_RUN" "$EXPECTED_ASSERTIONS" >&2
  printf '  fewer  => probes were skipped and this run certifies nothing.\n' >&2
  printf '  more   => an assertion was added without updating EXPECTED_ASSERTIONS.\n' >&2
  exit 1
fi
printf 'check-workstream-e2e.sh PASSED — %d/%d assertions ran and passed.\n' \
  "$ASSERTIONS_RUN" "$EXPECTED_ASSERTIONS"
