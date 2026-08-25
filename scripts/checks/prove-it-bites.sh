#!/usr/bin/env bash
#
# prove-it-bites.sh — the mutation control, in one command.
#
# WHY THIS FILE EXISTS. A check that has never been observed failing is a
# decoration. This repo has shipped several: `check-secret-scan.ts` was driven
# green in August and wired into nothing; `gates-808.sh` gate 7 ends in a
# literal `exit 0` and is counted in the suite total; `detectPath` shipped 18
# hand-written cases, 18/18 green, and a corpus sweep then found nine classes of
# false positive the table never imagined. In every case the *claim* was the
# artefact and nobody produced the *effect*.
#
# The cure is cheap and mechanical: break the thing the check protects, and show
# the check go red. Two workers did exactly that by hand on 2026-08-24/25 (the
# tool-block browser check, and the guardrail matrix re-run against a scratch
# copy of the old code), and round 0 of aios-verification-that-bites ran it by
# hand a third time on guard.sh's forbidden-file guard — PLAN.md §F2. Three
# hand-rolled transcripts is two too many. This script is that transcript made
# repeatable, so the control costs one line instead of an afternoon.
#
# USAGE
#   bash scripts/checks/prove-it-bites.sh \
#     --subject <file> \
#     --mutation '<shell that edits the subject>' \
#     --check '<the exact command under test>' \
#     --expect-fail
#
#   --subject <file>        the ONE file the mutation edits. Must be clean.
#   --mutation '<shell>'    a shell fragment run from the repo root with
#                           $SUBJECT exported. Repeatable: each mutation is
#                           applied to the PRISTINE subject, measured, and
#                           restored before the next one, so the run reports
#                           per-mutation which DISCRIMINATED and which did not.
#                           That distinction is the difference between a control
#                           and regression coverage.
#   --mutation-file <path>  same, for a mutation too gnarly for one argv string.
#                           Repeatable, and interleaves with --mutation in order.
#                           A file starting with `#!` is run by THAT interpreter
#                           (so a python edit is run by python); a file without
#                           one has its contents run as shell.
#   --check '<command>'     the check under test, run from the repo root under
#                           `set -o pipefail` (the same way gates-808.sh's
#                           gate_sh runs a gate body — without pipefail a piped
#                           gate reports `tail`'s status and cannot fail at all).
#   --expect-fail           REQUIRED. The expectation is declared, never inferred.
#                           It is the only supported expectation: a mutation that
#                           leaves the check green is the finding, not a pass.
#   --subject-copy          restore from a /tmp byte copy instead of
#                           `git checkout --`. REQUIRED for an untracked or
#                           ignored subject, and the right mode when the mutation
#                           DELETES a first layer to reach an unreachable second
#                           one (memory note unreachable-guard-needs-its-own-control):
#                           the copy restores content and mode byte-exactly even
#                           when the mutation removed the file outright.
#   --timeout <seconds>     per check run. Default 600, 0 disables. A check that
#                           TIMES OUT is INCONCLUSIVE, never proof — see below.
#   --tail <n>              lines of check output to print. Default 20.
#
# EXIT CODES — there is no third outcome and no silent fallback.
#   0  BITES         unmutated exit 0, EVERY mutation drove it non-zero, md5 restored
#   2  usage error, or the subject was already dirty
#   3  the check was ALREADY FAILING unmutated — you cannot demonstrate that a
#      red check bites. This is the control that stops a worker reporting a
#      pre-existing RED as proof of their own new assertion.
#   4  INCONCLUSIVE — restore FAILED. Both hashes are printed and the backup kept.
#   5  INERT         at least one mutation left the check green. Named, per mutation.
#   6  INCONCLUSIVE — a check run hit the timeout. A hang exits non-zero and would
#      otherwise read as a bite; it is not one.
#
# RESTORE IS ON A `trap ... EXIT`, deliberately, not ERR: bash does not inherit
# an ERR trap into functions or subshells without `set -E`, so an ERR trap here
# would silently not fire from inside a helper (memory note
# err-trap-not-inherited-by-functions). INT, TERM and HUP are trapped into
# `exit` so that they run the EXIT handler too — bash runs an EXIT trap when it
# exits because of a TRAPPED signal and skips it entirely on an untrapped fatal
# one, which is how an early version of this script lost a subject to a SIGHUP.
# SIGKILL cannot be trapped — after a `kill -9` the backup path printed at
# STEP 2 is the manual restore.

set -uo pipefail   # NOT -e: this script's whole job is to run a command that
                   # is expected to fail, and to keep going afterwards.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

SUBJECT=""
CHECK=""
EXPECT_FAIL=0
SUBJECT_COPY=0
TIMEOUT=600
TAIL_LINES=20
declare -a MUT_SRC=() MUT_TEXT=() MUT_RUN=()

# Prints this file's own header comment, up to the first line of code. Not a
# line range: a line range silently orphans itself the first time someone adds a
# paragraph (memory note notification-gap-pin-rules-anchored).
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

die_usage() {
  echo "prove-it-bites: $1" >&2
  echo "  run with --help for the full contract" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --subject)       [ $# -ge 2 ] || die_usage "--subject needs a value"; SUBJECT="$2"; shift 2 ;;
    --check)         [ $# -ge 2 ] || die_usage "--check needs a value";   CHECK="$2";   shift 2 ;;
    --mutation)      [ $# -ge 2 ] || die_usage "--mutation needs a value"
                     MUT_SRC+=("argv"); MUT_TEXT+=("$2"); MUT_RUN+=("$2"); shift 2 ;;
    --mutation-file) [ $# -ge 2 ] || die_usage "--mutation-file needs a value"
                     [ -f "$2" ]  || die_usage "--mutation-file: no such file: $2"
                     MUT_SRC+=("file:$2"); MUT_TEXT+=("$(cat "$2")")
                     # Honour a shebang. Without this a python mutation file is
                     # handed to bash, which runs `import os, re, sys` as a
                     # command — measured 2026-08-25, and ImageMagick's `import`
                     # answered it. A mutation that misfires is not a control.
                     mf_first="$(head -n 1 "$2")"
                     if [ "${mf_first:0:2}" = "#!" ]; then
                       MUT_RUN+=("${mf_first:2} \"$2\"")
                     else
                       MUT_RUN+=("$(cat "$2")")
                     fi
                     shift 2 ;;
    --expect-fail)   EXPECT_FAIL=1; shift ;;
    --subject-copy)  SUBJECT_COPY=1; shift ;;
    --timeout)       [ $# -ge 2 ] || die_usage "--timeout needs a value"; TIMEOUT="$2"; shift 2 ;;
    --tail)          [ $# -ge 2 ] || die_usage "--tail needs a value";    TAIL_LINES="$2"; shift 2 ;;
    --help|-h)       usage; exit 0 ;;
    *)               die_usage "unknown argument: $1" ;;
  esac
done

[ -n "$SUBJECT" ]        || die_usage "--subject is required"
[ -n "$CHECK" ]          || die_usage "--check is required"
[ "${#MUT_RUN[@]}" -gt 0 ] || die_usage "at least one --mutation or --mutation-file is required"
[ "$EXPECT_FAIL" -eq 1 ] || die_usage "--expect-fail is required — the expectation is declared, never inferred"
[ -e "$SUBJECT" ]        || die_usage "--subject does not exist: $SUBJECT"
[ -f "$SUBJECT" ]        || die_usage "--subject is not a regular file: $SUBJECT"
case "$TIMEOUT"    in ''|*[!0-9]*) die_usage "--timeout must be a whole number of seconds: $TIMEOUT" ;; esac
case "$TAIL_LINES" in ''|*[!0-9]*) die_usage "--tail must be a whole number of lines: $TAIL_LINES" ;; esac
[ "$TAIL_LINES" -gt 0 ]  || die_usage "--tail must be greater than 0"

# ── helpers ────────────────────────────────────────────────────────────────

md5_of() {
  if [ -f "$1" ]; then md5sum "$1" | awk '{print $1}'; else echo "<ABSENT>"; fi
}

rule() { printf '%s\n' "--------------------------------------------------------------------------"; }

step() { echo; echo "STEP $1 — $2"; }

MD5_BEFORE=""
BACKUP=""
RESTORE_MODE=""
SUBJECT_MUTATED=0
BACKUP_KEEP=0
# Set before the traps are installed: `cleanup` reads it, and under `set -u` an
# unset variable would turn a signal into an unbound-variable error instead of a
# restore.
CHECK_PID=""

restore_subject() {
  case "$RESTORE_MODE" in
    git)  git checkout -- "$SUBJECT" ;;
    copy) cp -p "$BACKUP" "$SUBJECT" ;;
    *)    echo "  restore mode was never set — cannot restore" >&2; return 1 ;;
  esac
}

# Restore, then PROVE the restore by hash. A restore nobody has watched fail is
# a restore nobody knows is broken.
restore_and_verify() {
  restore_subject
  local after; after="$(md5_of "$SUBJECT")"
  echo "  restore mode : $RESTORE_MODE"
  echo "  md5 BEFORE   : $MD5_BEFORE"
  echo "  md5 AFTER    : $after"
  if [ "$after" != "$MD5_BEFORE" ]; then
    echo "  RESTORE FAILED — the subject was NOT returned to its pre-mutation bytes."
    BACKUP_KEEP=1
    return 1
  fi
  SUBJECT_MUTATED=0
  echo "  restore verified by hash"
  return 0
}

cleanup() {
  local rc=$?
  # Kill the check BEFORE restoring, not after: if a signal interrupted `wait`
  # the check is still running against the mutated file, and a restore landing
  # underneath a live reader is a race this script has no reason to run.
  if [ -n "$CHECK_PID" ] && kill -0 "$CHECK_PID" 2>/dev/null; then
    echo
    echo "TRAP (EXIT) — killing the still-running check (pid $CHECK_PID)"
    kill -TERM "$CHECK_PID" 2>/dev/null
    wait "$CHECK_PID" 2>/dev/null
  fi
  if [ "$SUBJECT_MUTATED" -eq 1 ]; then
    echo
    echo "TRAP (EXIT) — the run ended with $SUBJECT still mutated. Restoring."
    if ! restore_and_verify; then
      echo
      echo "VERDICT: INCONCLUSIVE — restore failed during cleanup. Backup kept at $BACKUP"
      trap - EXIT
      exit 4
    fi
  fi
  if [ -n "$BACKUP" ] && [ "$BACKUP_KEEP" -eq 0 ]; then
    rm -f "$BACKUP"
  elif [ -n "$BACKUP" ]; then
    echo "backup retained: $BACKUP"
  fi
  trap - EXIT
  exit "$rc"
}
# HUP is trapped too, and that is not paranoia: bash runs an EXIT trap when it
# exits because of a TRAPPED signal, and dies WITHOUT running it on an untrapped
# fatal one. Measured 2026-08-25 — a detached run lost its session, took an
# untrapped SIGHUP mid-check, and left the subject mutated with the transcript
# stopped at STEP 5.1. Control (e) in D3-mutation-rule.md is that transcript.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

CHECK_CODE=0
CHECK_OUT=""
CHECK_TIMED_OUT=0

run_check() {
  local label="$1"
  CHECK_OUT="$(mktemp -t prove-it-bites-out.XXXXXX)"
  CHECK_TIMED_OUT=0
  echo "  \$ $CHECK"
  # Backgrounded and `wait`ed, NOT run in the foreground: bash defers a trapped
  # signal until the current foreground command returns, so a TERM arriving
  # during a 20-minute check would not restore the subject until that check
  # finished. `wait` is interruptible, so the trap — and the restore — fire at once.
  if [ "$TIMEOUT" -gt 0 ]; then
    timeout "$TIMEOUT" bash -c "set -o pipefail; $CHECK" >"$CHECK_OUT" 2>&1 &
  else
    bash -c "set -o pipefail; $CHECK" >"$CHECK_OUT" 2>&1 &
  fi
  CHECK_PID=$!
  wait "$CHECK_PID"
  CHECK_CODE=$?
  CHECK_PID=""
  if [ "$TIMEOUT" -gt 0 ] && { [ "$CHECK_CODE" -eq 124 ] || [ "$CHECK_CODE" -eq 137 ]; }; then
    CHECK_TIMED_OUT=1
  fi
  echo "  last $TAIL_LINES lines of $label output:"
  rule
  tail -n "$TAIL_LINES" "$CHECK_OUT" | sed 's/^/  | /'
  rule
  echo "  exit code ($label): $CHECK_CODE"
  rm -f "$CHECK_OUT"
}

# ── STEP 0 — what is being proven ──────────────────────────────────────────

echo "=========================================================================="
echo "prove-it-bites — mutation control"
echo "=========================================================================="
echo "repo        : $REPO"
echo "subject     : $SUBJECT"
echo "check       : $CHECK"
echo "mutations   : ${#MUT_RUN[@]}"
echo "expectation : --expect-fail (mutated run MUST exit non-zero)"
echo "timeout     : ${TIMEOUT}s per check run"

# ── STEP 1 — refuse to start on a dirty subject ────────────────────────────

step 1 "subject cleanliness — a mutation control on an already-dirty file cannot prove a restore"
PORCELAIN="$(git status --porcelain -- "$SUBJECT")"
echo "  \$ git status --porcelain -- $SUBJECT"
echo "  [${PORCELAIN}]"

TRACKED=0
if git ls-files --error-unmatch -- "$SUBJECT" >/dev/null 2>&1; then TRACKED=1; fi
echo "  tracked by git: $TRACKED"

if [ -n "$PORCELAIN" ]; then
  if [ "${PORCELAIN:0:2}" = "??" ] && [ "$SUBJECT_COPY" -eq 1 ]; then
    echo "  untracked subject, --subject-copy given: the /tmp copy IS the baseline. Proceeding."
  else
    echo
    echo "HARD ERROR — subject is dirty: $SUBJECT"
    echo "  Commit, revert or stash it first. A restore proven against already-modified"
    echo "  bytes proves nothing about the mutation this run applies."
    if [ "${PORCELAIN:0:2}" = "??" ]; then
      echo "  (This subject is UNTRACKED. Re-run with --subject-copy to use a /tmp baseline.)"
    fi
    exit 2
  fi
fi

if [ "$SUBJECT_COPY" -eq 1 ] || [ "$TRACKED" -eq 0 ]; then
  RESTORE_MODE="copy"
  if [ "$TRACKED" -eq 0 ] && [ "$SUBJECT_COPY" -eq 0 ]; then
    echo
    echo "HARD ERROR — subject is not tracked by git and --subject-copy was not given:"
    echo "  $SUBJECT"
    echo "  \`git checkout --\` cannot restore it. Re-run with --subject-copy."
    exit 2
  fi
else
  RESTORE_MODE="git"
fi
echo "  restore mode  : $RESTORE_MODE"

# ── STEP 2 — record the baseline ───────────────────────────────────────────

step 2 "baseline hash"
MD5_BEFORE="$(md5_of "$SUBJECT")"
BACKUP="$(mktemp -t "prove-it-bites-backup.XXXXXX")"
cp -p "$SUBJECT" "$BACKUP"
echo "  md5sum $SUBJECT"
echo "  BEFORE : $MD5_BEFORE"
echo "  backup : $BACKUP  (the manual restore if this run is SIGKILLed)"

# ── STEP 3 — the check must be GREEN before it can be shown to go red ──────

step 3 "check UNMUTATED"
run_check "unmutated"
UNMUTATED_CODE=$CHECK_CODE

if [ "$CHECK_TIMED_OUT" -eq 1 ]; then
  echo
  echo "VERDICT: INCONCLUSIVE — the unmutated check hit the ${TIMEOUT}s timeout."
  echo "  A hang is not a measurement. Raise --timeout or fix the check."
  exit 6
fi

if [ "$UNMUTATED_CODE" -ne 0 ]; then
  echo
  echo "HARD ERROR — the check was ALREADY FAILING before any mutation (exit $UNMUTATED_CODE)."
  echo "  You cannot demonstrate that a red check bites: every mutated run would also be"
  echo "  red, and the run would read as proof of an assertion that was never exercised."
  echo "  Fix or attribute the pre-existing RED first, then re-run this control."
  exit 3
fi

# ── STEPS 4-6, once per mutation ───────────────────────────────────────────

declare -a MUT_CODE=() MUT_RESULT=()
RESTORE_BROKEN=0
TIMED_OUT_ANY=0

i=0
while [ "$i" -lt "${#MUT_RUN[@]}" ]; do
  idx=$((i + 1))
  mut="${MUT_RUN[$i]}"
  mut_text="${MUT_TEXT[$i]}"
  src="${MUT_SRC[$i]}"

  step "4.$idx" "apply mutation $idx of ${#MUT_RUN[@]} (source: $src)"
  echo "  mutation:"
  rule
  printf '%s\n' "$mut_text" | sed 's/^/  | /'
  rule
  SUBJECT_MUTATED=1
  SUBJECT="$SUBJECT" bash -c "set -o pipefail; $mut"
  mut_status=$?
  if [ "$mut_status" -ne 0 ]; then
    echo "  HARD ERROR — the mutation command itself failed (exit $mut_status)."
    echo "  Nothing was measured. The EXIT trap restores the subject."
    exit 2
  fi

  # Print the command that ACTUALLY produced the diff below. Labelling a
  # `diff -u` against the backup as `git diff` would be a small lie in the one
  # artefact whose entire value is being literally true.
  if [ "$RESTORE_MODE" = "git" ]; then
    echo "  \$ git diff -- $SUBJECT"
    rule
    git diff -- "$SUBJECT" | sed 's/^/  | /'
  else
    # In copy mode there may be no git baseline at all (untracked or ignored
    # subject), so the /tmp copy is the baseline.
    echo "  \$ diff -u $BACKUP $SUBJECT"
    rule
    diff -u "$BACKUP" "$SUBJECT" | sed 's/^/  | /'
  fi
  rule
  after_mut="$(md5_of "$SUBJECT")"
  echo "  md5 while mutated: $after_mut"
  if [ "$after_mut" = "$MD5_BEFORE" ]; then
    echo "  HARD ERROR — the mutation did not change the subject's bytes."
    echo "  A no-op mutation cannot discriminate anything. Fix the mutation."
    exit 2
  fi

  step "5.$idx" "check MUTATED"
  run_check "mutated/$idx"
  MUT_CODE+=("$CHECK_CODE")
  if [ "$CHECK_TIMED_OUT" -eq 1 ]; then
    MUT_RESULT+=("TIMEOUT")
    TIMED_OUT_ANY=1
  elif [ "$CHECK_CODE" -ne 0 ]; then
    MUT_RESULT+=("DISCRIMINATED")
  else
    MUT_RESULT+=("did NOT discriminate")
  fi

  step "6.$idx" "restore and prove it by hash"
  if ! restore_and_verify; then
    RESTORE_BROKEN=1
    break
  fi

  i=$((i + 1))
done

# ── STEP 7 — the verdict ───────────────────────────────────────────────────

step 7 "VERDICT"
echo "  unmutated exit : $UNMUTATED_CODE"
echo
# The source goes LAST: a --mutation-file path is arbitrarily long, and a fixed
# width in front of the verdict would shove the column that matters off the grid.
printf '  %-3s %-12s %-22s %s\n' "#" "mutated exit" "result" "mutation source"
printf '  %-3s %-12s %-22s %s\n' "---" "------------" "----------------------" "---------------"
j=0
while [ "$j" -lt "${#MUT_CODE[@]}" ]; do
  printf '  %-3s %-12s %-22s %s\n' "$((j + 1))" "${MUT_CODE[$j]}" "${MUT_RESULT[$j]}" "${MUT_SRC[$j]}"
  j=$((j + 1))
done
echo

if [ "$RESTORE_BROKEN" -eq 1 ]; then
  echo "VERDICT: INCONCLUSIVE — restore FAILED after mutation $((i + 1)); hashes printed at STEP 6.$((i + 1))."
  echo "  The measurement above cannot be trusted: the subject is not back to its"
  echo "  pre-mutation bytes and every later run would start from mutated code."
  exit 4
fi

if [ "$TIMED_OUT_ANY" -eq 1 ]; then
  echo "VERDICT: INCONCLUSIVE — at least one mutated run hit the ${TIMEOUT}s timeout."
  echo "  A timeout exits non-zero and would otherwise read as a bite. It is not one."
  exit 6
fi

INERT_LIST=""
j=0
while [ "$j" -lt "${#MUT_RESULT[@]}" ]; do
  if [ "${MUT_RESULT[$j]}" != "DISCRIMINATED" ]; then
    INERT_LIST="$INERT_LIST $((j + 1))"
  fi
  j=$((j + 1))
done

if [ -n "$INERT_LIST" ]; then
  echo "VERDICT: INERT — the check stayed GREEN under mutation(s):$INERT_LIST"
  echo "  The check does not observe what those mutations changed. That is the finding."
  echo "  Do NOT close it by weakening the mutation; either the check is a decoration or"
  echo "  the mutation missed the property it protects — say which, with this transcript."
  exit 5
fi

echo "VERDICT: BITES — unmutated exit 0, ${#MUT_CODE[@]}/${#MUT_CODE[@]} mutation(s) drove it non-zero, subject restored (md5 $MD5_BEFORE)."
exit 0
