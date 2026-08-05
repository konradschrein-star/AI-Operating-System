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
#   scripts/checks/api-diff.sh --control          # ← the gate. See below.
#   scripts/checks/api-diff.sh --current DIR      # diff an existing capture
#   scripts/checks/api-diff.sh --baseline DIR     # compare against another baseline
#   API_BASE=http://127.0.0.1:7700 scripts/checks/api-diff.sh   # against production
#
# ═══════════════════════════════════════════════════════════════════════════
# --control — why the plain run is not the gate (round 308, review finding 4)
# ═══════════════════════════════════════════════════════════════════════════
# The baseline is a photograph of a live system. Konrad keeps talking to his
# chats, runs start and settle, projects appear — so some of these endpoints
# will differ from ANY committed baseline within the hour, forever, on code
# that has not changed. A plain run therefore goes red and stays red, and every
# reviewer has to re-derive a control run by hand to attribute the failures.
# The round-307 reviewer did exactly that, and so did round 304's builder.
#
# `--control [URL]` (default http://127.0.0.1:7700, i.e. production, which runs
# main) does it in one command:
#
#   capture CURRENT  from $API_BASE      — the worktree, :7798
#   capture CONTROL  from $CONTROL_BASE  — main, :7700
#   diff BOTH against the same baseline, with the same row alignment
#   FAIL only on what differs in CURRENT and NOT in CONTROL
#
# A difference both sides show is the world moving. A difference only the
# worktree shows is this phase's doing, and that is the only thing that can
# fail the gate. Rows are then aligned across all THREE captures (see below),
# so the two failure sets are computed over exactly the same rows.
#
# ── ADDITIVE fields (round 308, review finding 5) ──────────────────────────
# One class of "only CURRENT shows it" is intended: the fields phase 300 ADDS.
# They are enumerated in additive_for() below, and in --control mode they are
# not merely tolerated, they are ASSERTED:
#
#   * a listed field missing from CURRENT           → FAIL (the gate proved
#                                                     nothing about it)
#   * a listed field already present in CONTROL     → FAIL (then it is not an
#                                                     addition of this phase)
#   * any OTHER key added, or ANY key removed       → FAIL
#
# That is what makes this an additive-API gate rather than a diff nobody reads.
# For the assertion to be meaningful the fields have to be reachable: U3's four
# chat-list fields only appear on a chat that resolves to a project, which is
# why capture.sh pins limit=50 (7 chats exist; the linked one is in the window)
# instead of the round-301 limit=5 that dropped it.
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
#   health.json  (the pass-through proof)
#     top   .uptime_seconds, .timestamp   — both are literally a clock.
#           .ok, .service and .version are the assertion.
#
# ── Row alignment (not normalization, but it changes what is compared) ─────
# Rows are matched by id (.id, or .project_id for managers) and compared only
# where the id exists on BOTH sides — on ALL THREE sides in --control mode, so
# that the current and control failure sets cover the same rows and can be
# subtracted from one another — sorted by id. Runs start and finish while
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

# comm(1) demands identically-collated input and this script feeds it jq's
# codepoint-ordered output. Pin the collation instead of inheriting the
# reviewer's locale, where "A" and "a" may sort together.
export LC_ALL=C

BASE="${API_BASE:-http://127.0.0.1:7798}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE="$REPO/docs/plan/artifacts/phase300/baseline"
CURRENT=""
CONTROL=""
CONTROL_BASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --baseline) BASELINE="$2"; shift 2 ;;
    --current)  CURRENT="$2";  shift 2 ;;
    --control)
      # Optional argument: a URL, or an existing capture directory. Bare
      # --control means "production on :7700".
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ] && [ -n "${2:-}" ]; then
        case "$2" in
          http://*|https://*) CONTROL_BASE="$2" ;;
          *) CONTROL="$2" ;;
        esac
        shift 2
      else
        CONTROL_BASE="${CONTROL_API_BASE:-http://127.0.0.1:7700}"
        shift
      fi
      ;;
    -h|--help)  sed -n '2,100p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "api-diff.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# One flag for "is control attribution on", whichever way it was supplied.
# Written as an `if` and not a `[ … ] || [ … ] && …` chain on purpose: under
# `set -e` that chain exits the script when both tests are false.
HAS_CONTROL=0
if [ -n "$CONTROL" ] || [ -n "$CONTROL_BASE" ]; then HAS_CONTROL=1; fi

[ -d "$BASELINE" ] || { echo "api-diff.sh: no baseline directory at $BASELINE" >&2; exit 2; }
command -v jq >/dev/null || { echo "api-diff.sh: jq is required" >&2; exit 2; }

WORK="$(mktemp -d /tmp/api-diff.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

if [ -z "$CURRENT" ]; then
  CURRENT="$WORK/current"
  echo "── capturing CURRENT from $BASE"
  "$BASELINE/capture.sh" "$CURRENT" >&2
  echo
fi

if [ -n "$CONTROL_BASE" ]; then
  CONTROL="$WORK/control"
  echo "── capturing CONTROL from $CONTROL_BASE"
  API_BASE="$CONTROL_BASE" "$BASELINE/capture.sh" "$CONTROL" >&2
  echo
fi
if [ -n "$CONTROL" ] && [ ! -d "$CONTROL" ]; then
  echo "api-diff.sh: no control capture directory at $CONTROL" >&2
  exit 2
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

# "This agent row is finished", written so it also holds on a capture that has
# no `settled` field at all (round 308).
#
# `settled` is one of the fields THIS PHASE ADDS (see additive_for()), so a
# capture taken from main answers `.settled == true` with `null != true` →
# every finished row was treated as LIVE and blanked. Against the round-301
# baseline that was invisible, because both sides were the same code. Against a
# baseline captured from main it silently waived the entire comparison — every
# settled row's fields, on both sides, replaced by "<<volatile>>". The fallback
# to a terminal status is what the row means on main.
AGENT_SETTLED='((.settled == true) or ((has("settled") | not) and '"$TERMINAL"'))'

spec_for() {
  ROWS=""; IDF="."; LIVE="false"; ROWVOL="."; TOPNORM="."
  case "$1" in
    agents|agents-project)
      ROWS='.agents'; IDF='.id'; LIVE="($AGENT_SETTLED | not)"
      ROWVOL="$AGENT_ROWVOL"
      TOPNORM='blank(["now"]) | (if has("summary") then .summary |= with_entries(.value = V) else . end)'
      ;;
    agents-run)
      # Single pinned row, settled → untouched. The `if` is the honest escape
      # hatch: if it is ever not settled, normalize it like any live row.
      TOPNORM="if (.agent | $AGENT_SETTLED) then . else .agent |= ($AGENT_ROWVOL) end"
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
    health)
      # The pass-through proof (capture.sh). Both fields are literally a clock:
      # `uptime_seconds` counts since the last pm2 restart, `timestamp` is
      # new Date(). `ok`, `service` and `version` are the assertion.
      TOPNORM='blank(["uptime_seconds","timestamp"])'
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

# ── The additive allowlist (NFU4) ──────────────────────────────────────────
# Every field phase 300 ADDS to an existing endpoint, as a shape path with
# array indices collapsed to `[]` — the form shape() emits. Keep this in step
# with docs/plan/artifacts/phase300/additive-fields.md; that file is the prose,
# this is the executable copy.
#
# In --control mode each entry must be ABSENT from the control capture and
# PRESENT in the current one. An entry that stops being reachable fails the
# gate instead of quietly proving nothing.
additive_for() {
  ADDITIVE=""
  case "$1" in
    agents|agents-project)
      # KIND TRUTH (DoD 2) and TIME TRUTH (DoD 1), phases 1-2 of this project.
      # `settled`/`settled_at` are what let a client freeze a finished run's
      # duration instead of ticking it forever; `agent_kind`/`role`/`project_id`
      # /`cron_name` are what let it say WHAT a row is. `description`/`ended_at`
      # are the same story one level down, on a sub-agent.
      ADDITIVE='agents.[].agent_kind
agents.[].cron_name
agents.[].project_id
agents.[].role
agents.[].settled
agents.[].settled_at
agents.[].subagents.[].description
agents.[].subagents.[].ended_at'
      ;;
    agents-run)
      # Same fields, single-run shape.
      ADDITIVE='agent.agent_kind
agent.cron_name
agent.project_id
agent.role
agent.settled
agent.settled_at
agent.subagents.[].description
agent.subagents.[].ended_at'
      ;;
    chat-list)
      # U3, round 304: only on a row whose chat resolves to a project.
      ADDITIVE='runs.[].project_id
runs.[].project_status
runs.[].tasks_done
runs.[].tasks_total'
      ;;
    secrets)
      # U7, round 303: the run that asked for the credential.
      ADDITIVE='secrets.[].requestedByRunId'
      ;;
    *) ADDITIVE="" ;;
  esac
}

# ── Declared value changes ─────────────────────────────────────────────────
# A field that already exists on main and whose VALUE this phase deliberately
# changes. Matched as a prefix of the collapsed path, so declaring
# `agents.[].subagents` covers everything under it.
#
# This list is short on purpose and every entry needs a reason: it is a waiver,
# and a waiver on a settled row waives frozen history. Anything not listed here
# and not in additive_for() fails the gate.
changed_for() {
  CHANGED=""
  case "$1" in
    agents|agents-project|agents-run)
      # elapsed_ms — THE deliverable (DoD 1, TIME TRUTH). Main computes it
      # against `now` for every row, so a run that finished at 07:02 reads
      # 8h 53m at 15:59 and grows while you watch it; the worktree freezes it
      # at settled_at − started_at. Measured on the pinned settled run
      # 3853c154 in this very capture: main 31 977 125 ms, worktree 949 322 ms
      # (15m 49s, its real span). Konrad's words: "elapsed times are still
      # growing even though they are done."
      CHANGED='elapsed_ms'
      ;;
    *) CHANGED="" ;;
  esac
}

# True when a collapsed path is covered by the CHANGED list (exact match, or
# the declared path is a prefix of it — `agents.[].subagents` covers
# `agents.[].subagents.[].role`). Bare field names match at any depth, which is
# how one `elapsed_ms` entry covers both the list and single-run shapes.
is_declared_change() {
  local path="$1" d
  [ -n "$CHANGED" ] || return 1
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in
      *.*) case "$path" in "$d"|"$d".*) return 0 ;; esac ;;
      *)   case "$path" in "$d"|*".$d") return 0 ;; esac ;;
    esac
  done <<< "$CHANGED"
  return 1
}

# Leaf paths whose VALUE differs between two normalized documents, one per
# line, indices kept (rows are aligned and sorted by id, so index i is the same
# row on both sides). A path present on one side only also counts as differing.
#
# Blind spot, same class as the shape layer's: `paths(scalars)` does not emit a
# path for an empty array or object, so `[] → [1]` shows up in the shape layer
# rather than here. Nothing is silently dropped by both.
leafdiff() {
  # `. as $doc` is load-bearing: inside `reduce`, `.` is the ACCUMULATOR, so a
  # bare `getpath($p)` reads the half-built object instead of the document and
  # every value comes back null — which makes the whole comparison silently
  # pass. Caught by checking a value known to differ (agent.elapsed_ms,
  # 31 821 774 vs 949 322) against a run that had reported "byte-equal".
  jq -rn --slurpfile a "$1" --slurpfile b "$2" '
    def leaves: . as $doc | reduce (paths(scalars)) as $p ({};
      .[$p | map(tostring) | join(".")] = ($doc | getpath($p) | tojson));
    ($a[0] | leaves) as $A | ($b[0] | leaves) as $B
    | (($A | keys) + ($B | keys) | unique)
    | map(select($A[.] != $B[.]))
    | .[]
  '
}

# Collapse a concrete leaf path (`runs.3.tasks_done`) to its shape form
# (`runs.[].tasks_done`) so it can be matched against the additive allowlist
# and reported as a field rather than as 40 near-identical rows. Nested arrays
# collapse at every level (`agents.3.subagents.0.role`). A JSON object key that
# is itself all digits would collapse too; none of these endpoints has one.
collapse_paths() {
  # The `:a … ta` loop, not a `g` flag: a global substitution consumes the dot
  # that separates the next index, so `a.3.b.0.c` would only lose its first
  # index. Looping until nothing changes catches every level.
  sed -E ':a;s/\.[0-9]+(\.|$)/.[]\1/;ta' | sort -u
}

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
  additive_for "$name"
  changed_for "$name"
  checked=$((checked + 1))

  ctl_file=""
  if [ "$HAS_CONTROL" = 1 ]; then
    ctl_file="$CONTROL/$name.json"
    if [ ! -f "$ctl_file" ]; then
      echo "FAIL  $name — control capture is missing it ($ctl_file)"
      failed=1
      continue
    fi
  fi

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

    # In control mode the two comparisons must run over the SAME rows, or the
    # difference between their failure sets is not attributable: keep narrows
    # to the three-way intersection, vol widens to anything live anywhere.
    if [ -n "$ctl_file" ]; then
      ids_x="$(jq_ids "$ctl_file")"; live_x="$(jq_live "$ctl_file")"
      vol="$(jq -cn --argjson a "$vol" --argjson b "$live_x" '($a + $b) | unique')"
      keep="$(jq -cn --argjson k "$keep" --argjson x "$ids_x" \
        '$k | map(select(. as $i | $x | index($i))) | unique')"
    fi

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
  [ -z "$ctl_file" ] || normalize "$ctl_file" "$vol" "$keep" > "$WORK/$name.ctl.norm"

  if [ "$HAS_CONTROL" = 0 ]; then
    # ── Plain mode: baseline equality, exactly as rounds 301-307 ran it ────
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
    continue
  fi

  # ── Control mode: attribute every difference before failing on it ────────
  shape "$WORK/$name.base.norm" | sort -u > "$WORK/$name.base.shape"
  shape "$WORK/$name.cur.norm"  | sort -u > "$WORK/$name.cur.shape"
  shape "$WORK/$name.ctl.norm"  | sort -u > "$WORK/$name.ctl.shape"

  # Keys added / removed on each side, relative to the same baseline.
  cur_added="$(comm -13 "$WORK/$name.base.shape" "$WORK/$name.cur.shape")"
  cur_removed="$(comm -23 "$WORK/$name.base.shape" "$WORK/$name.cur.shape")"
  ctl_added="$(comm -13 "$WORK/$name.base.shape" "$WORK/$name.ctl.shape")"
  ctl_removed="$(comm -23 "$WORK/$name.base.shape" "$WORK/$name.ctl.shape")"

  # `grep -v '^$'` exits 1 when everything was blank, which under `set -e -o
  # pipefail` would kill the script — an empty list is the normal case here.
  printf '%s\n' "$ADDITIVE"  | grep -v '^$' | sort -u > "$WORK/$name.additive"  || true
  printf '%s\n' "$cur_added" | grep -v '^$' | sort -u > "$WORK/$name.cur.added" || true
  printf '%s\n' "$ctl_added" | grep -v '^$' | sort -u > "$WORK/$name.ctl.added" || true

  endpoint_failed=0

  # 1. A key REMOVED on the worktree side and not on main's is this phase
  #    breaking a client. Nothing in phase 300 removes a field.
  only_removed="$(comm -13 <(printf '%s\n' "$ctl_removed" | { grep -v '^$' || true; } | sort -u) \
                           <(printf '%s\n' "$cur_removed" | { grep -v '^$' || true; } | sort -u))"
  if [ -n "$only_removed" ]; then
    echo "FAIL  $name — key(s) REMOVED by the worktree (control still has them):"
    printf '%s\n' "$only_removed" | sed 's/^/        − /'
    endpoint_failed=1
  fi

  # 2. A key ADDED on the worktree side that is not on the additive list, and
  #    that main does not also show, is an unannounced API change.
  unexpected_added="$(comm -23 <(comm -13 "$WORK/$name.ctl.added" "$WORK/$name.cur.added") \
                               "$WORK/$name.additive")"
  if [ -n "$unexpected_added" ]; then
    echo "FAIL  $name — key(s) ADDED but not declared in additive_for():"
    printf '%s\n' "$unexpected_added" | sed 's/^/        + /'
    echo "        (declare them there and in additive-fields.md, or stop adding them)"
    endpoint_failed=1
  fi

  # 3. Every declared additive field must be PRESENT on the worktree side and
  #    ABSENT from control. Otherwise this gate is not exercising it, which is
  #    exactly the hole review finding 5 reported.
  if [ -s "$WORK/$name.additive" ]; then
    missing_additive="$(comm -23 "$WORK/$name.additive" "$WORK/$name.cur.shape")"
    if [ -n "$missing_additive" ]; then
      echo "FAIL  $name — declared additive field(s) NOT PRESENT in the current capture:"
      printf '%s\n' "$missing_additive" | sed 's/^/        ? /'
      echo "        (the field is unreachable through this fixture — the gate proves nothing about it)"
      endpoint_failed=1
    fi
    already_in_control="$(comm -12 "$WORK/$name.additive" "$WORK/$name.ctl.shape")"
    if [ -n "$already_in_control" ]; then
      echo "FAIL  $name — declared additive field(s) already present in CONTROL:"
      printf '%s\n' "$already_in_control" | sed 's/^/        = /'
      echo "        (then it is not an addition of this phase — fix additive_for())"
      endpoint_failed=1
    fi
    present_additive="$(comm -12 "$WORK/$name.additive" "$WORK/$name.cur.shape")"
    [ -z "$present_additive" ] || {
      echo "ADD   $name — additive field(s) present here and absent from control:"
      printf '%s\n' "$present_additive" | sed 's/^/        + /'
    }
  fi

  # 4. VALUES, attributed. Compare the SET OF PATHS that differ, not the diff
  #    text: a path that differs against both captures is the world moving; a
  #    path that differs only against the worktree is this phase's doing.
  leafdiff "$WORK/$name.base.norm" "$WORK/$name.cur.norm" > "$WORK/$name.cur.leaf"
  leafdiff "$WORK/$name.base.norm" "$WORK/$name.ctl.norm" > "$WORK/$name.ctl.leaf"
  only_cur="$(comm -23 <(sort -u "$WORK/$name.cur.leaf") <(sort -u "$WORK/$name.ctl.leaf"))"
  # Two classes of worktree-only value difference are accounted for already:
  # a declared ADDITIVE field's own value (absent from the baseline by
  # construction), and a declared CHANGED path (this phase's deliverable).
  # Everything else survives to fail the gate.
  declared_changed=""
  if [ -n "$only_cur" ]; then
    kept=""
    while IFS= read -r leaf; do
      [ -n "$leaf" ] || continue
      c="$(printf '%s\n' "$leaf" | collapse_paths)"
      if [ -s "$WORK/$name.additive" ] && grep -qxF "$c" "$WORK/$name.additive"; then
        continue
      fi
      if is_declared_change "$c"; then
        declared_changed="$declared_changed$c
"
        continue
      fi
      kept="$kept$leaf
"
    done <<< "$only_cur"
    only_cur="$(printf '%s' "$kept")"
  fi
  if [ -n "$declared_changed" ]; then
    echo "CHG   $name — declared value change(s) present (changed_for()):"
    printf '%s' "$declared_changed" | sort -u | sed 's/^/        ~ /'
  fi
  shared_n="$(comm -12 <(sort -u "$WORK/$name.cur.leaf") <(sort -u "$WORK/$name.ctl.leaf") | grep -c . || true)"
  if [ -n "$only_cur" ]; then
    fields="$(printf '%s\n' "$only_cur" | collapse_paths)"
    n="$(printf '%s\n' "$only_cur" | grep -c . || true)"
    echo "FAIL  $name — $n value(s) differ against the worktree ONLY (control agrees with the baseline):"
    printf '%s\n' "$fields" | head -20 | sed 's/^/        ≠ /'
    printf '%s\n' "$only_cur" | head -10 | sed 's/^/          at /'
    endpoint_failed=1
  fi

  if [ "$endpoint_failed" -ne 0 ]; then
    failed=1
    continue
  fi
  if [ "$shared_n" -gt 0 ]; then
    echo "ok    $name — no worktree-only difference ($shared_n drifted value(s), control drifted identically)"
  else
    echo "ok    $name — key set identical, normalized values byte-equal"
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  if [ "$HAS_CONTROL" = 1 ]; then
    echo "api-diff.sh: FAILED — the worktree changed the read-side API in a way main does not. See above."
  else
    echo "api-diff.sh: FAILED — the read-side API changed. See the diffs above."
  fi
  exit 1
fi
if [ "$HAS_CONTROL" = 1 ]; then
  echo "api-diff.sh: PASS — $checked endpoints; every difference from $BASELINE"
  echo "                    is reproduced by the control, plus the declared additive fields."
  exit 0
fi
echo "api-diff.sh: PASS — $checked endpoints match the baseline at $BASELINE"
