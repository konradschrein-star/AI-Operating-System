#!/usr/bin/env bash
#
# dollar-sweep.sh — phase-400 "no dollars anywhere" gate (U11, NFU1).
#
# Konrad runs on the Claude Code subscription, not API billing — a rendered
# $/€ agent-cost number is noise he explicitly rejected (10-ui-v3-spec.md).
# This script is the U11 gate: it fails non-zero the moment an UNLISTED
# currency-shaped hit lands in forge-control-web/app.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY \bspen[dt]\b, NOT the naive `spend` from 14-ui-v3-quality.md §6
# ═══════════════════════════════════════════════════════════════════════════
# §6's reviewer gate is `grep -rniE "usd|spend" forge-control-web/app
# --include="*.tsx" -l`. Run literally, "spend" case-insensitively matches
# "isPending" (i-s-P-e-n-d-i-n-g) in every mutation-loading-state check in the
# app — ~15 files as of round 401, none of them rendering a dollar. `\bspen[dt]`
# requires a WORD BOUNDARY immediately before "spen": in "isPending" the 's' of
# "sPending" is preceded by the word character 'i', so there is no boundary
# there and the anchored pattern does not fire, while "spend"/"spent" as their
# own word still do. That is the whole difference and the whole point.
#
# This script runs BOTH gates:
#   1. THE PRIMARY GATE (anchored, precise) — what actually fails the build.
#   2. THE REVIEWER'S LITERAL §6 COMMAND — run as-is, every file it returns
#      classified ALLOWLISTED / UNLISTED, so a reviewer who runs §6 by hand
#      gets a documented answer instead of a fresh grep to triage from scratch.
#
# ═══════════════════════════════════════════════════════════════════════════
# Allowlist
# ═══════════════════════════════════════════════════════════════════════════
# scripts/checks/dollar-allowlist.txt — FILE<TAB>PATTERN<TAB>REASON. A primary
# gate hit is excused only if BOTH the file matches AND the hit's own content
# matches PATTERN (an ERE) — listing a file does not blanket-excuse it; a new,
# different dollar hit landing in an already-listed file still fails.
#
# The full per-line table (file, line, snippet, reason) this file encodes is
# docs/plan/artifacts/phase400/dollar-allowlist.md — read that for the prose.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALLOWLIST="$REPO/scripts/checks/dollar-allowlist.txt"
cd "$REPO"

[ -f "$ALLOWLIST" ] || { echo "dollar-sweep.sh: no allowlist at $ALLOWLIST" >&2; exit 2; }

# PRIMARY_PATTERN is the brief's literal gate — kept as one variable so the
# header comment above and the command below can never drift apart.
PRIMARY_PATTERN='\$[0-9]|€|_usd|\busd\b|\bspen[dt]|toFixed\(2\)'

# ── Load the allowlist ──────────────────────────────────────────────────────
# Parallel arrays keyed by index; bash 3.2 (macOS default) has no assoc-array-
# of-arrays, and this script has to run on whatever the reviewer has.
AL_FILE=(); AL_PATTERN=(); AL_REASON=()
while IFS=$'\t' read -r f p r; do
  [ -n "$f" ] || continue
  case "$f" in \#*) continue ;; esac
  AL_FILE+=("$f"); AL_PATTERN+=("$p"); AL_REASON+=("$r")
done < "$ALLOWLIST"

# Reason + reachability flag for a given file, content pair. Prints the
# reason and returns 0 if some allowlist row matches; returns 1 (silent) if
# none does.
allowlist_reason() {
  local file="$1" content="$2" i
  for i in "${!AL_FILE[@]}"; do
    [ "${AL_FILE[$i]}" = "$file" ] || continue
    if [[ "$content" =~ ${AL_PATTERN[$i]} ]]; then
      echo "${AL_REASON[$i]}"
      return 0
    fi
  done
  return 1
}

# True if FILE appears anywhere in the allowlist (regardless of whether any
# particular hit on it matched) — used only for the §6 classification pass.
allowlist_has_file() {
  local file="$1" i
  for i in "${!AL_FILE[@]}"; do
    [ "${AL_FILE[$i]}" = "$file" ] && return 0
  done
  return 1
}

echo "── 1. PRIMARY GATE ── grep -rniE '$PRIMARY_PATTERN' forge-control-web/app --include='*.tsx' --include='*.ts'"
echo

failed=0
checked=0
declare -A file_has_unlisted_hit=()

while IFS= read -r line; do
  [ -n "$line" ] || continue
  checked=$((checked + 1))
  file="${line%%:*}"
  rest="${line#*:}"
  lineno="${rest%%:*}"
  content="${rest#*:}"

  if reason="$(allowlist_reason "$file" "$content")"; then
    printf 'ALLOW   %s:%s\n        %s\n        → %s\n' "$file" "$lineno" "$content" "$reason"
  else
    printf 'FAIL    %s:%s\n        %s\n        → no allowlist entry covers this hit\n' "$file" "$lineno" "$content"
    failed=1
    file_has_unlisted_hit["$file"]=1
  fi
done < <(grep -rniE "$PRIMARY_PATTERN" forge-control-web/app --include='*.tsx' --include='*.ts' || true)

echo
if [ "$checked" -eq 0 ]; then
  echo "primary gate: no hits at all (unexpected — the allowlisted files should still match)."
  failed=1
elif [ "$failed" -eq 0 ]; then
  echo "primary gate: $checked hit(s), all allowlisted."
else
  echo "primary gate: $checked hit(s), one or more UNLISTED — see FAIL lines above."
fi

echo
echo "── 2. REVIEWER'S LITERAL §6 COMMAND ── grep -rniE \"usd|spend\" forge-control-web/app --include=\"*.tsx\" -l"
echo

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if [ -n "${file_has_unlisted_hit[$file]:-}" ]; then
    echo "UNLISTED     $file  (has an unallowlisted primary-gate hit — see section 1)"
  elif allowlist_has_file "$file"; then
    echo "ALLOWLISTED  $file"
  else
    # Returned by the naive command but has NO primary-gate hit at all: this
    # is exactly the isPending-class false positive the header comment
    # describes — the naive `spend` substring matched inside a longer word.
    echo "ALLOWLISTED  $file  (false positive — no \\bspen[dt]-anchored hit; matches only via a substring like isPending)"
  fi
done < <(grep -rniE "usd|spend" forge-control-web/app --include="*.tsx" -l || true)

echo
if [ "$failed" -ne 0 ]; then
  echo "dollar-sweep.sh: FAIL — unlisted currency-shaped hit(s) in forge-control-web/app. See section 1 above."
  exit 1
fi
echo "dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist."
