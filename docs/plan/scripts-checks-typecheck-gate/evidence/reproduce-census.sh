#!/usr/bin/env bash
# reproduce-census.sh — re-measure the compile census over every instrument in
# scripts/checks/, one tsc invocation per file, through the checked-in profile
# tsconfig.checks-instruments.json.
#
# THIS IS NOT THE GATE. scripts/checks/check-instrument-typecheck.sh (phase 2)
# is the gate; it decides pass/fail, reconciles waivers and checks profile
# fidelity. This script decides nothing. It exists so that any later reviewer
# can reproduce round 0's census on demand and diff it byte-for-byte against
# evidence/census-G-generated-perfile-config.txt:
#
#   diff <(bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh) \
#        docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
#
# STDOUT carries the census table and nothing else, so that diff is meaningful.
# Provenance, progress and the full unfiltered diagnostics of every failing
# subject go to STDERR.
#
# Output layout is byte-exact and deliberately so — every line is 65 characters:
#   name left-padded to 47, "rc=" at column 48 (value padded to 4),
#   "errors=" at column 55 (value padded to 4), trailing spaces present.
# Verify with: awk '{print length($0)}' out.txt | sort -u   →   a single "65".
#
# Why a generated per-file config instead of tsc flags: `paths` cannot be passed
# on the command line at all (error TS6064) and tsc has no CLI equivalent of
# `files`. See 02-architecture.md §4.2. The generated config lands in a per-run
# mktemp -d and NEVER in the repo (NF3) — `git status --porcelain` is empty
# after a run.

set -euo pipefail

trap 'echo "ABORTED at line $LINENO — this census is NOT a reproduction." >&2' ERR

# Repo root from this script's own location, so the script runs from any cwd.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF/../../../.." && pwd)"

PROFILE="$REPO_ROOT/tsconfig.checks-instruments.json"
TSC="$REPO_ROOT/forge-control-web/node_modules/.bin/tsc"
SUBJECT_DIR="$REPO_ROOT/scripts/checks"
EXPECTED_SUBJECTS=42

# --- refusals -----------------------------------------------------------------
# A missing input is refused, never worked around: a census taken with a
# substitute profile or a substitute compiler is not the census.

if [[ ! -f "$PROFILE" ]]; then
  echo "REFUSING: compile profile not found at $PROFILE" >&2
  exit 1
fi

if [[ ! -x "$TSC" ]]; then
  echo "REFUSING: tsc not found or not executable at $TSC" >&2
  echo "  Install it WITH devDependencies — NODE_ENV=production prunes them and exits 0:" >&2
  echo "    cd $REPO_ROOT/forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false" >&2
  exit 1
fi

if [[ ! -d "$SUBJECT_DIR" ]]; then
  echo "REFUSING: subject directory not found at $SUBJECT_DIR" >&2
  exit 1
fi

# --- enumeration --------------------------------------------------------------
# All *.ts sorted, then all *.tsx sorted — that is exactly the order of
# census-G-generated-perfile-config.txt. The two globs expand independently and
# in the order written, which is what produces the "all .ts, then all .tsx"
# grouping; LC_ALL=C pins the collation inside them so the order does not depend
# on the reviewer's locale. `nullglob` makes an unmatched glob vanish instead of
# passing through literally, so an empty directory reaches the refusal below
# rather than being handed to tsc as a filename. No `ls`, and no `2>/dev/null`:
# a failure to enumerate must be loud, not an empty census.

if ! SUBJECT_LIST="$(
  LC_ALL=C bash -c 'cd "$1" || exit 1; shopt -s nullglob; printf "%s\n" *.ts *.tsx' _ "$SUBJECT_DIR"
)"; then
  echo "REFUSING: could not enumerate subjects under $SUBJECT_DIR" >&2
  exit 1
fi

SUBJECTS=()
while IFS= read -r f; do
  [[ -n "$f" ]] && SUBJECTS+=("$f")
done <<< "$SUBJECT_LIST"

FOUND=${#SUBJECTS[@]}

if (( FOUND == 0 )); then
  echo "REFUSING: zero subjects matched $SUBJECT_DIR/*.ts and *.tsx." >&2
  echo "  A census over nothing is not a green census." >&2
  exit 1
fi

COUNT_MISMATCH=0
if (( FOUND != EXPECTED_SUBJECTS )); then
  COUNT_MISMATCH=1
  echo "WARNING: found $FOUND subjects, round 0 measured $EXPECTED_SUBJECTS." >&2
  echo "  The table below cannot diff clean against census-G. Either an instrument" >&2
  echo "  was added or removed since 2026-08-18, or the glob is wrong. The census" >&2
  echo "  is still printed, so the diff shows precisely which subject moved." >&2
fi

# --- provenance (stderr) ------------------------------------------------------

{
  echo "════════ provenance"
  echo "repo root : $REPO_ROOT"
  echo "profile   : $PROFILE"
  echo "sha256    : $(sha256sum "$PROFILE" | cut -d' ' -f1)"
  echo "tsc       : $("$TSC" --version)"
  echo "node      : $(node --version)"
  echo "HEAD      : $(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo '(not a git repo)')"
  echo "branch    : $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unknown)')"
  echo "subjects  : $FOUND (expected $EXPECTED_SUBJECTS)"
  echo "invocation: one tsc -p <generated config> per subject"
  echo "════════ census"
} >&2

# --- the census ---------------------------------------------------------------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GREEN=0
RED=0
FAILURES=""

for base in "${SUBJECTS[@]}"; do
  subject="$SUBJECT_DIR/$base"
  cfg="$TMP/$base.json"
  printf '{ "extends": "%s",\n  "files":   ["%s"] }\n' "$PROFILE" "$subject" > "$cfg"

  # tsc exits non-zero on diagnostics, which is the expected case for 6 of the
  # 42 — so its status is captured, never allowed to abort the loop, and never
  # discarded either.
  set +e
  out="$("$TSC" -p "$cfg" 2>&1)"
  rc=$?
  set -e

  # grep -c exits 1 on zero matches; that is a count of 0, not an error.
  n="$(printf '%s\n' "$out" | grep -c 'error TS' || true)"

  printf '%-47s' "$base"
  printf 'rc=%-4serrors=%-4s\n' "$rc" "$n"

  if (( rc == 0 && n == 0 )); then
    GREEN=$(( GREEN + 1 ))
  else
    RED=$(( RED + 1 ))
    FAILURES+="════════ $base"$'\n'"$out"$'\n'
  fi
done

# --- full diagnostics of every failing subject (stderr, unfiltered) -----------

{
  echo "════════ full diagnostics — every failing subject, unfiltered (U2)"
  if [[ -n "$FAILURES" ]]; then
    printf '%s' "$FAILURES"
  else
    echo "(none — every subject compiled clean)"
  fi
  echo "════════ summary"
  echo "green $GREEN / red $RED / total $FOUND"
} >&2

if (( COUNT_MISMATCH == 1 )); then
  echo "EXITING NON-ZERO: subject count differs from round 0's $EXPECTED_SUBJECTS." >&2
  exit 2
fi

exit 0
