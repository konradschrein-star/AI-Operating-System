#!/usr/bin/env bash
#
# api-diff.sh — phase-300 read-side API regression gate.
#
# Re-captures the phase-300 endpoint set from the worktree harness on :7798 and
# diffs it against the committed baseline transcript
# (docs/plan/artifacts/phase300/baseline/). Round 301 captured that baseline
# while the worktree's routes were byte-identical to main, so a green run of
# this script means: "my refactor did not change what the API says".
#
# It exists for round 302 — the agents.ts helper extraction — where a silent
# shape change breaks the shipped Live panel with no compile error.
#
# Two independent layers, both must pass:
#   (a) SHAPE   — the recursive path set of each response (every key, every
#                 nesting level, array indices collapsed to []) must be
#                 identical. Catches a field added, removed or renamed.
#   (b) VALUES  — the normalized documents must diff byte-equal. Catches a
#                 field whose value changed.
#
# Usage:
#   scripts/checks/api-diff.sh                    # capture + diff
#   scripts/checks/api-diff.sh --current DIR      # diff an existing capture
#   scripts/checks/api-diff.sh --baseline DIR     # compare against another baseline
#   API_BASE=http://127.0.0.1:7700 scripts/checks/api-diff.sh   # against production
#
# ═══════════════════════════════════════════════════════════════════════════
# NORMALIZATION — the complete list. Nothing else is touched.
# ═══════════════════════════════════════════════════════════════════════════
# The rule: a SETTLED row is frozen history and must diff byte-equal, with zero
# normalization. Only rows that are still live, and only top-level fields
# derived from the wall clock, may be blanked to "<<volatile>>".
#
#   agents.json, agents-project.json
#     top   .now                          — literally new Date().toISOString()
#     top   .summary.*                    — running/queued/stuck/paused counts
#                                           and the *_last_hour rollups; all
#                                           recomputed against now on each call
#     rows  .agents[]  WHERE .settled == false in EITHER capture:
#           elapsed_ms, updated_at, last_heartbeat_at, current_activity,
#           usage_running, usage_total          ← the brief's list
#           usage_last_turn, spent_usd, subagents ← same class: live meters
#                                                   that tick on every turn
#           status, settled, settled_at          ← a row that was running at
#                                                   baseline may have settled by
#                                                   now; that is the real world
#                                                   moving, not a code change
#     A row settled in BOTH captures gets NONE of this — every one of its
#     fields, elapsed_ms included, must be byte-equal.
#
#   agents-run.json  (pinned SETTLED run)
#     nothing. Asserted settled; if it ever comes back non-settled the same
#     row normalization applies and the script says so.
#
#   chat-list.json
#     top   .counts.*                     — status counts over all chats
#     rows  .runs[] WHERE status ∉ {completed,failed,cancelled} in either:
#           updated_at, last_heartbeat_at, message_count, last_message_preview,
#           last_role, spent_usd, status
#     .count and .hasMore are NOT normalized.
#
#   chat-thread.json  (pinned operator chat)
#     nothing while it is settled. If it is running: run.updated_at,
#     last_heartbeat_at, message_count, last_message_preview, last_role,
#     spent_usd, status, completed_at, stuck_signal, thread, metadata.
#
#   projects-managers.json
#     rows  .managers[] WHERE .status == "active":
#           last_activity_at, tasks_done, tasks_total, tokens_in, tokens_out,
#           spent_usd — every one of these is a rollup over runs that are
#           executing right now.
#
#   projects.json
#     rows  .projects[] WHERE .status == "active":
#           updated_at, metadata.last_checkin_at (only if the key exists).
#           NOT the brief, NOT the metadata object, NOT status.
#
#   secrets.json
#     nothing at all.
#
# ── Row alignment (not normalization, but it changes what is compared) ─────
# Rows are matched by id (.id, or .project_id for managers) and compared only
# where the id exists on BOTH sides, sorted by id. Runs start and finish while
# this script runs; a row that appeared or vanished is the world moving, not a
# regression. Those ids, and any change in row ORDER, are printed loudly under
# "REAL-WORLD DRIFT" — read them, they are not failures but they are not noise
# either.
#
# ── Known blind spot, stated honestly ──────────────────────────────────────
# The SHAPE layer runs on the normalized documents, because a raw path set is
# defeated by live data (subagents: [] one minute, populated the next).
#
# Normalization blanks a volatile field in place and only when it is already
# present (see blank() below), so removing or renaming one is still caught by
# the shape layer. What is genuinely invisible is narrow and exact: the VALUE
# of a listed volatile field on a row that is live in either capture, and any
# structure NESTED inside such a value (a key added inside a running row's
# current_activity or usage_running). Everything on a settled row — which is
# every field phase 300 touches — is fully covered, values included.

set -euo pipefail

BASE="${API_BASE:-http://127.0.0.1:7798}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE="$REPO/docs/plan/artifacts/phase300/baseline"
CURRENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline) BASELINE="$2"; shift 2 ;;
    --current)  CURRENT="$2";  shift 2 ;;
    -h|--help)  sed -n '2,60p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "api-diff.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

[ -d "$BASELINE" ] || { echo "api-diff.sh: no baseline directory at $BASELINE" >&2; exit 2; }
command -v jq >/dev/null || { echo "api-diff.sh: jq is required" >&2; exit 2; }

WORK="$(mktemp -d /tmp/api-diff.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

if [ -z "$CURRENT" ]; then
  CURRENT="$WORK/current"
  echo "── capturing from $BASE"
  "$BASELINE/capture.sh" "$CURRENT" >&2
  echo
fi

# ── Per-endpoint normalization spec ────────────────────────────────────────
# ROWS   jq path to the row array, or "" for a document with no row list
# IDF    jq expression giving a row's identity
# LIVE   jq expression, true when the row is NOT settled
# ROWVOL jq expression rewriting a live row
# TOPNORM jq expression applied to the whole document first
AGENT_ROWVOL='blank(["elapsed_ms","updated_at","last_heartbeat_at","current_activity","usage_running","usage_total","usage_last_turn","spent_usd","subagents","status","settled","settled_at"])'
CHAT_ROWVOL='blank(["updated_at","last_heartbeat_at","message_count","last_message_preview","last_role","spent_usd","status"])'
TERMINAL='(.status | IN("completed","failed","cancelled"))'

spec_for() {
  ROWS=""; IDF="."; LIVE="false"; ROWVOL="."; TOPNORM="."
  case "$1" in
    agents|agents-project)
      ROWS='.agents'; IDF='.id'; LIVE='(.settled != true)'
      ROWVOL="$AGENT_ROWVOL"
      TOPNORM='blank(["now"]) | (if has("summary") then .summary |= with_entries(.value = V) else . end)'
      ;;
    agents-run)
      # Single pinned row, settled → untouched. The `if` is the honest escape
      # hatch: if it is ever not settled, normalize it like any live row.
      TOPNORM="if (.agent.settled == true) then . else .agent |= ($AGENT_ROWVOL) end"
      ;;
    chat-list)
      ROWS='.runs'; IDF='.id'; LIVE="($TERMINAL | not)"
      ROWVOL="$CHAT_ROWVOL"
      TOPNORM='if has("counts") then .counts |= with_entries(.value = V) else . end'
      ;;
    chat-thread)
      TOPNORM="if (.run | $TERMINAL) then . else .run |= blank([\"updated_at\",\"last_heartbeat_at\",\"message_count\",\"last_message_preview\",\"last_role\",\"spent_usd\",\"status\",\"completed_at\",\"stuck_signal\",\"thread\",\"metadata\"]) end"
      ;;
    projects-managers)
      ROWS='.managers'; IDF='.project_id'; LIVE='(.status == "active")'
      ROWVOL='blank(["last_activity_at","tasks_done","tasks_total","tokens_in","tokens_out","spent_usd"])'
      ;;
    projects)
      ROWS='.projects'; IDF='.id'; LIVE='(.status == "active")'
      ROWVOL='blank(["updated_at"]) | (if (.metadata | type) == "object" and (.metadata | has("last_checkin_at")) then .metadata.last_checkin_at = V else . end)'
      ;;
    secrets)
      : # no normalization whatsoever
      ;;
    *)
      echo "api-diff.sh: no normalization spec for '$1' — refusing to diff it blind" >&2
      echo "  (add it to spec_for(); a capture nobody normalized is a check that always fails)" >&2
      return 1
      ;;
  esac
}

jq_ids()  { jq -c "[ $ROWS[] | $IDF ]" "$1"; }
jq_live() { jq -c "[ $ROWS[] | select($LIVE) | $IDF ]" "$1"; }

# Recursive path set: every path in the document, array indices collapsed to
# [] so row order and row count do not masquerade as a shape change.
shape() {
  jq -r '[ paths | map(if type == "number" then "[]" else tostring end) | join(".") ] | unique | .[]' "$1"
}

# jq preamble shared by both normalize() branches.
#
# blank() overwrites ONLY keys that are already present — never `. + {k: V}`,
# which would resurrect a deleted key and hide a field removal from the shape
# layer. Presence of a volatile field is therefore still checked; only its
# value is waived.
JQ_PRELUDE='
  def V: "<<volatile>>";
  def blank($ks): reduce $ks[] as $k (.; if has($k) then .[$k] = V else . end);
'

normalize() {
  local file="$1" vol="$2" keep="$3"
  if [ -z "$ROWS" ]; then
    jq -S --argjson vol "$vol" --argjson keep "$keep" \
      "$JQ_PRELUDE $TOPNORM" "$file"
  else
    jq -S --argjson vol "$vol" --argjson keep "$keep" "
      $JQ_PRELUDE
      ($TOPNORM)
      | $ROWS |= ( map(select(($IDF) as \$i | \$keep | index(\$i)))
                 | map(if (($IDF) as \$i | \$vol | index(\$i)) then ($ROWVOL) else . end)
                 | sort_by($IDF) )
    " "$file"
  fi
}

failed=0
checked=0

for base_file in "$BASELINE"/*.json; do
  name="$(basename "$base_file" .json)"
  cur_file="$CURRENT/$name.json"

  if [ ! -f "$cur_file" ]; then
    echo "FAIL  $name — captured baseline has no counterpart in $CURRENT"
    failed=1
    continue
  fi

  spec_for "$name" || { failed=1; continue; }
  checked=$((checked + 1))

  vol='[]'; keep='[]'
  if [ -n "$ROWS" ]; then
    ids_b="$(jq_ids "$base_file")"; ids_c="$(jq_ids "$cur_file")"
    live_b="$(jq_live "$base_file")"; live_c="$(jq_live "$cur_file")"
    # Volatile = live in EITHER capture. A row that was running at baseline and
    # has settled since must be normalized on BOTH sides or its frozen values
    # would read as a regression.
    vol="$(jq -cn --argjson a "$live_b" --argjson b "$live_c" '($a + $b) | unique')"
    keep="$(jq -cn --argjson a "$ids_b" --argjson b "$ids_c" \
      '$a | map(select(. as $x | $b | index($x))) | unique')"

    gone="$(jq -cn --argjson a "$ids_b" --argjson b "$ids_c" '$a - $b')"
    new="$(jq -cn --argjson a "$ids_b" --argjson b "$ids_c" '$b - $a')"
    order_b="$(jq -cn --argjson a "$ids_b" --argjson k "$keep" '$a | map(select(. as $x | $k | index($x)))')"
    order_c="$(jq -cn --argjson b "$ids_c" --argjson k "$keep" '$b | map(select(. as $x | $k | index($x)))')"

    [ "$gone" = '[]' ] || echo "DRIFT $name — rows in baseline, gone now: $gone"
    [ "$new"  = '[]' ] || echo "DRIFT $name — rows new since baseline: $new"
    if [ "$order_b" != "$order_c" ]; then
      # Only the rows that actually MOVED, as "id  was→now". Printing both full
      # id lists is a 60-element wall of text nobody reads — and this report is
      # meant to be read: /api/agents is ordered by activity, so a settling run
      # reshuffles it legitimately, but a sort-key regression would show here too.
      moved="$(jq -rn --argjson b "$order_b" --argjson c "$order_c" '
        [ $b | to_entries[] | . as $e | ($c | index($e.value)) as $j
          | select($j != $e.key) | "        \($e.value)  \($e.key)→\($j)" ] | .[]')"
      moved_n="$(printf '%s\n' "$moved" | grep -c . || true)"
      echo "DRIFT $name — row ORDER changed ($moved_n of $(jq -rn --argjson k "$keep" '$k|length') common rows moved)"
      printf '%s\n' "$moved" | head -10
      [ "$moved_n" -le 10 ] && : || echo "        … $((moved_n - 10)) more"
    fi
  fi

  normalize "$base_file" "$vol" "$keep" > "$WORK/$name.base.norm"
  normalize "$cur_file"  "$vol" "$keep" > "$WORK/$name.cur.norm"

  # (a) SHAPE
  if ! diff -u <(shape "$WORK/$name.base.norm") <(shape "$WORK/$name.cur.norm") \
        > "$WORK/$name.shape.diff"; then
    echo "FAIL  $name — KEY SET changed (a field was added, removed or renamed)"
    sed 's/^/        /' "$WORK/$name.shape.diff"
    failed=1
    continue
  fi

  # (b) VALUES
  if ! diff -u "$WORK/$name.base.norm" "$WORK/$name.cur.norm" \
        > "$WORK/$name.value.diff"; then
    echo "FAIL  $name — normalized VALUES differ"
    head -c 20000 "$WORK/$name.value.diff" | sed 's/^/        /'
    lines=$(wc -l < "$WORK/$name.value.diff")
    [ "$lines" -le 400 ] || echo "        … ($lines diff lines total, truncated)"
    failed=1
    continue
  fi

  echo "ok    $name — key set identical, normalized values byte-equal"
done

echo
if [ "$failed" -ne 0 ]; then
  echo "api-diff.sh: FAILED — the read-side API changed. See the diffs above."
  exit 1
fi
echo "api-diff.sh: PASS — $checked endpoints match the baseline at $BASELINE"
