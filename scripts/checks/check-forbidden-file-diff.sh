#!/usr/bin/env bash
#
# check-forbidden-file-diff.sh — the control for `forbidden-file-diff.sh`,
# which is `gates-808.sh` gate 6.
#
# WHY A CONTROL AT ALL. Gate 6 spent four rounds red and nobody could tell
# whether it was red for a real reason, because its only input was whatever
# `git diff main...HEAD` held that day — one fixture, never varied, and one
# nobody could vary without committing a file they were not allowed to commit.
# A gate you cannot drive is a gate you cannot trust in EITHER direction: the
# amendment this control exists to prove is `GATES_ENGINE_ALLOW`, and the thing
# most worth proving about an allow list is what it still REFUSES.
#
# Table-driven, both directions, and the probes are counted: if a case stops
# executing, the run exits non-zero rather than reporting a smaller clean sweep
# (`00-vision.md` §7 rule 2 / rule 3).
#
# Run:  bash scripts/checks/check-forbidden-file-diff.sh
# Exit: 0 = every case behaved as stated;  1 = a case did not, or a probe missed.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$REPO/scripts/checks/forbidden-file-diff.sh"

# This project's allow list, as `03-quality.md` §4 hands it to the reviewer.
# It is repeated here so the control can assert the exact list the gate is run
# with is the list that passes — and so a fourth engine file appearing in the
# diff without being declared turns this control red, not just the gate.
#
# THAT IS EXACTLY WHAT HAPPENED, ROUND 972 FIX CYCLE 1. `af3cba6` created
# `forge-control/src/db/projects.test.ts` — a fourth banned-pattern path — and
# declared it nowhere, so case 13 went red on the live diff while cases 1-12
# stayed green. The control did its job; the list was stale. Amended here in the
# same commit as `03-quality.md` §3.1 item 12 and the `04-phases.md` §10 row that
# buys the entry, per standing rule 2 — the three statements must agree, and a
# reviewer diffing any one against another is the check.
PROJECT_ALLOW='forge-control/src/db/projects.ts,forge-control/src/lib/project-tick.ts,forge-control/src/lib/project-tick.test.ts,forge-control/src/db/projects.test.ts'

EXPECTED_CASES=14
CASES=0
SKIPPED=0
FAILED=0
OUT=""
RC=0

echo "check-forbidden-file-diff.sh"
echo "  repo            : $REPO"
echo "  subject         : $SUBJECT"
echo "  subject sha256  : $(sha256sum "$SUBJECT" | cut -d' ' -f1)"
echo "  this control    : ${BASH_SOURCE[0]}"
echo "  control sha256  : $(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
echo "  HEAD            : $(git -C "$REPO" rev-parse HEAD)"
echo "  branch          : $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
echo

# run <allow-list> <newline-separated paths>
#
# `printf '%s\n'` terminates the last line, which is what `git diff --name-only`
# does. Case 14 drives the UNTERMINATED form on purpose, because feeding only
# the well-formed shape is how the subject's dropped-last-path defect survived
# being written at all.
run() {
  OUT=$(printf '%s\n' "$2" | GATES_ENGINE_ALLOW="$1" bash "$SUBJECT" 2>&1)
  RC=$?
}

pass_case() { CASES=$((CASES + 1)); echo "  PASS  case $1 — $2"; }
fail_case() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "  FAIL  case $1 — $2"
  echo "$OUT" | sed 's/^/        | /'
}
skip_case() {
  SKIPPED=$((SKIPPED + 1))
  echo "  SKIP  case $1 — $2"
}

# expect <n> <label> <wanted rc> [<substring that must appear> …]
expect() {
  local n="$1" label="$2" want="$3" ok=1 needle
  shift 3
  [ "$RC" = "$want" ] || ok=0
  for needle in "$@"; do
    case "$OUT" in *"$needle"*) ;; *) ok=0 ;; esac
  done
  if [ "$ok" = 1 ]; then pass_case "$n" "$label"; else fail_case "$n" "$label (rc=$RC, wanted $want)"; fi
}

echo "A. THE DEFAULT — an unset/empty allow list must behave exactly as the"
echo "   one-line gate this replaced, because every other project in this repo"
echo "   runs it that way and the operator ruling requires them unaffected."
echo

run "" 'forge-control/src/lib/task-graph.ts
docs/plan/engine-task-graph/03-quality.md
README.md'
expect 1 "no banned path in the list, empty allow -> clean" 0 "clean — no engine/Files file differs"

run "" 'forge-control/src/lib/project-tick.ts
README.md'
expect 2 "an engine file differs, empty allow -> REFUSED and named" 1 \
  ">>> FORBIDDEN FILE DIFFERS" \
  ">>>   forge-control/src/lib/project-tick.ts"

echo
echo "B. THE AMENDMENT — a declared path is permitted, and nothing else is."
echo

# Every entry of PROJECT_ALLOW is exercised here, not a subset: an entry that
# permitted nothing would otherwise sit in the list unmeasured and be read as
# load-bearing. The fourth path was added round 972 with the list itself.
run "$PROJECT_ALLOW" 'forge-control/src/lib/project-tick.ts
forge-control/src/db/projects.ts
forge-control/src/lib/project-tick.test.ts
forge-control/src/db/projects.test.ts
README.md'
expect 3 "the four declared engine files, declared -> clean" 0 \
  "clean — 4 banned path(s) differ and every one was declared"

run 'forge-control/src/db/projects.ts' 'forge-control/src/lib/project-tick.ts'
expect 4 "an allow list naming a DIFFERENT engine file does not blanket" 1 \
  ">>>   forge-control/src/lib/project-tick.ts"

echo
echo "C. WHAT THE ALLOW LIST STILL REFUSES — the property worth protecting."
echo "   These three are what round 808's operator waiver kept forbidden, and"
echo "   this project's allow list must not have quietly bought them."
echo

run "$PROJECT_ALLOW" 'forge-control-web/app/desktop/vault/VaultFileList.tsx
forge-control/src/lib/project-tick.ts'
expect 5 "VaultFileList is still refused under this project's allow list" 1 \
  ">>>   forge-control-web/app/desktop/vault/VaultFileList.tsx" \
  "declared   forge-control/src/lib/project-tick.ts"

run "$PROJECT_ALLOW" 'forge-control/src/routes/files.ts'
expect 6 "routes/files is still refused" 1 ">>>   forge-control/src/routes/files.ts"

run "$PROJECT_ALLOW" 'forge-control/src/lib/cc-runner.ts'
expect 7 "cc-runner is still refused" 1 ">>>   forge-control/src/lib/cc-runner.ts"

echo
echo "D. THE INSTRUMENT'S OWN FAILURE MODES."
echo

run 'forge-control/src/lib/workspace.ts' 'forge-control/src/lib/project-tick.ts'
expect 8 "an entry the ban never matches is reported INERT and grants nothing" 1 \
  "INERT   forge-control/src/lib/workspace.ts" \
  ">>>   forge-control/src/lib/project-tick.ts"

run 'forge-control/src/lib/project-tick.ts
forge-control/src/db/projects.ts' 'forge-control/src/lib/project-tick.ts
forge-control/src/db/projects.ts'
expect 9 "a NEWLINE-separated allow list parses like a comma-separated one" 0 \
  "clean — 2 banned path(s) differ and every one was declared"

run '  forge-control/src/lib/project-tick.ts ,	forge-control/src/db/projects.ts  ' \
  'forge-control/src/lib/project-tick.ts
forge-control/src/db/projects.ts'
expect 10 "leading/trailing blanks around entries are stripped" 0 \
  "clean — 2 banned path(s) differ and every one was declared"

run 'forge-control/src/db/projects.ts' 'forge-control/src/db/projects.test.ts'
expect 11 "matching is EXACT — a declared path does not permit its .test.ts neighbour" 1 \
  ">>>   forge-control/src/db/projects.test.ts" \
  "UNUSED  forge-control/src/db/projects.ts"

# Case 12 executes the composed pipeline `gates-808.sh` actually runs, rather
# than asserting in prose that `set -o pipefail` covers a failing producer.
# `false` stands in for a `git diff` that could not run: the subject then reads
# zero paths and prints a clean verdict, and the PIPELINE must still be nonzero.
OUT=$(bash -c "set -o pipefail; false | GATES_ENGINE_ALLOW='' bash '$SUBJECT'" 2>&1)
RC=$?
expect 12 "a failing producer is caught by the call site's pipefail, not by a clean verdict" 1 \
  "paths read on stdin: 0" \
  "clean — no engine/Files file differs"

# Case 14 — the defect this control found on its first run. A last path with no
# trailing newline must still be read. Driven through the subject directly,
# because run() deliberately terminates its input.
OUT=$(printf '%s' 'README.md
forge-control/src/lib/project-tick.ts' | GATES_ENGINE_ALLOW='' bash "$SUBJECT" 2>&1)
RC=$?
expect 14 "an unterminated final path is read, not silently dropped" 1 \
  "paths read on stdin: 2" \
  ">>>   forge-control/src/lib/project-tick.ts"

echo
echo 'E. THE LIVE BRANCH — the same list 03-quality.md §4 hands the reviewer,'
echo '   against the real diff, plus the mutation that proves it discriminates.'
echo

LIVE_DIFF=$(git -C "$REPO" diff --name-only main...HEAD)
LIVE_BANNED=$(printf '%s\n' "$LIVE_DIFF" | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files')
if [ -z "$LIVE_BANNED" ]; then
  skip_case 13 "no banned path differs on this branch, so there is nothing here to discriminate; cases 1-12 carry the property"
else
  run "$PROJECT_ALLOW" "$LIVE_DIFF"
  live_rc="$RC"
  live_out="$OUT"
  # The mutation: drop the FIRST live banned path from the allow list. If the
  # gate is doing anything at all, the same diff must now be refused.
  DROP=$(printf '%s\n' "$LIVE_BANNED" | head -1)
  MUTATED=$(printf '%s\n' "$PROJECT_ALLOW" | tr ',' '\n' | grep -vxF "$DROP" | paste -sd,)
  run "$MUTATED" "$LIVE_DIFF"
  if [ "$live_rc" = 0 ] && [ "$RC" = 1 ]; then
    pass_case 13 "the live diff is clean under the declared list, and refused with '$DROP' removed"
  else
    echo "        | --- with the full list (rc=$live_rc) ---"
    echo "$live_out" | sed 's/^/        | /'
    fail_case 13 "live diff: full list rc=$live_rc (wanted 0), mutated list rc=$RC (wanted 1)"
  fi
fi

echo
echo "SUMMARY"
echo "  cases executed : $CASES"
echo "  cases skipped  : $SKIPPED"
echo "  failures       : $FAILED"

if [ "$((CASES + SKIPPED))" -ne "$EXPECTED_CASES" ]; then
  echo "PROBE MISS — $((CASES + SKIPPED)) of $EXPECTED_CASES cases accounted for. A sweep that"
  echo "quietly stops running cases must fail rather than report a smaller clean run."
  exit 1
fi

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED FAILURE(S) — gate 6's decision does not behave as documented"
  exit 1
fi

echo "ALL PASS — $CASES checks"
exit 0
