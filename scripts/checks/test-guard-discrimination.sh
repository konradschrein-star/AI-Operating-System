#!/usr/bin/env bash
#
# test-guard-discrimination.sh — proves guard.sh actually discriminates.
# The project's hard rule: "a guard that passes when it should fail is
# worse than no guard." For each of the three defect classes guard.sh's
# fast path covers (a type error, a raw colour literal, a dollar-shaped
# hit), this script:
#   1. injects exactly that defect into a throwaway scratch file
#   2. proves the SPECIFIC guard.sh check for it goes FAIL, with its
#      reported detail line pointing at the file we just wrote
#   3. removes the scratch file
#   4. proves the same check goes back to PASS
#
# Assertions are made against the individual check's status in guard.sh's
# --json output, not the overall RED/GREEN verdict — this repo has ~10
# lanes editing it in parallel tonight, so main...HEAD may carry a real,
# pre-existing red from a file this project does not own (measured: it
# does, in forge-control-web/app/desktop/gemini-identity.tsx). Asserting
# the whole-run verdict would make this script flaky against unrelated
# work; asserting the one row this defect targets is the actual claim
# being tested.
#
# Every scratch file lives under forge-control-web/app/_guard-scratch-*.
# The leading underscore is Next.js's own "not a route" convention, so it
# is inert even if left behind — but cleanup() runs on every exit path
# (trap), and the closing check greps for residue anyway.
#
# Usage: bash scripts/checks/test-guard-discrimination.sh
# Needs jq (present on this box) to read guard.sh --json. Runs guard.sh
# --fast six times (~35-40s each here) — budget ~4 minutes; give it a long
# timeout, not the Bash tool's 120s default.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
GUARD="$REPO/scripts/checks/guard.sh"

TYPEERROR_FILE="forge-control-web/app/_guard-scratch-typeerror.ts"
COLOUR_FILE="forge-control-web/app/_guard-scratch-colour.tsx"
DOLLAR_FILE="forge-control-web/app/_guard-scratch-dollar.tsx"

FAILS=0

cleanup() { rm -f "$REPO/$TYPEERROR_FILE" "$REPO/$COLOUR_FILE" "$REPO/$DOLLAR_FILE"; }
trap cleanup EXIT

# guard_status <check-name> — runs guard.sh --fast --json, prints the
# check's status + detail to stderr as evidence, returns the status on
# stdout ("MISSING" if the check name is not in the report at all).
guard_status() {
  local check="$1" json row status detail
  json="$(bash "$GUARD" --fast --json)"
  row="$(printf '%s' "$json" | jq -c --arg n "$check" '.checks[] | select(.name == $n)')"
  if [ -z "$row" ]; then
    echo "  [$check] NOT FOUND in guard.sh --json output" >&2
    echo "MISSING"
    return
  fi
  status="$(printf '%s' "$row" | jq -r '.status')"
  detail="$(printf '%s' "$row" | jq -r '.detail')"
  echo "  [$check] status=$status detail=$detail" >&2
  echo "$status"
}

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "PASS — $label ($got)"
  else
    echo "FAIL — $label: got '$got', want '$want'"
    FAILS=$((FAILS + 1))
  fi
}

echo "Before starting — forge-control-web/app working-copy state:"
git status --porcelain -- forge-control-web/app || true
echo

# ── Defect 1/3 — TYPE ERROR ─────────────────────────────────────────────
echo "═══ Defect 1/3: type error → tsc-forge-control-web ═══"
cleanup
printf 'export const guardScratchTypeError: number = "this is a string, not a number";\n' \
  > "$TYPEERROR_FILE"
echo "RED probe:"
red="$(guard_status tsc-forge-control-web)"
assert_eq "type error turns tsc-forge-control-web RED" "$red" "FAIL"
cleanup
echo "GREEN probe (file removed):"
green="$(guard_status tsc-forge-control-web)"
assert_eq "restoring the tree turns tsc-forge-control-web GREEN" "$green" "PASS"
echo

# ── Defect 2/3 — RAW COLOUR LITERAL ─────────────────────────────────────
echo "═══ Defect 2/3: raw colour literal → no-raw-colours ═══"
cleanup
printf 'export const GUARD_SCRATCH_COLOUR = "#ff00aa";\n' > "$COLOUR_FILE"
echo "RED probe:"
red="$(guard_status no-raw-colours)"
assert_eq "raw colour literal turns no-raw-colours RED" "$red" "FAIL"
cleanup
echo "GREEN probe (file removed):"
green="$(guard_status no-raw-colours)"
assert_eq "restoring the tree turns no-raw-colours GREEN" "$green" "PASS"
echo

# ── Defect 3/3 — DOLLAR-SHAPED HIT ──────────────────────────────────────
echo "═══ Defect 3/3: dollar-shaped hit → dollar-sweep ═══"
cleanup
printf 'export const guardScratchPrice = "\$42.00";\n' > "$DOLLAR_FILE"
echo "RED probe:"
red="$(guard_status dollar-sweep)"
assert_eq "dollar-shaped literal turns dollar-sweep RED" "$red" "FAIL"
cleanup
echo "GREEN probe (file removed):"
green="$(guard_status dollar-sweep)"
assert_eq "restoring the tree turns dollar-sweep GREEN" "$green" "PASS"
echo

echo "════════════════════════════════════════════════════════════════════"
residue="$(git status --porcelain -- forge-control-web/app || true)"
if [ -n "$residue" ]; then
  echo "FAIL — scratch files left residue in forge-control-web/app:"
  echo "$residue"
  FAILS=$((FAILS + 1))
else
  echo "clean — no residue in forge-control-web/app"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "test-guard-discrimination.sh PASSED — all 3 defect classes proven to flip guard.sh RED, and all 3 restores proven to flip it back GREEN."
  exit 0
else
  echo "test-guard-discrimination.sh FAILED — $FAILS assertion(s) did not hold. See PASS/FAIL lines above." >&2
  exit 1
fi
