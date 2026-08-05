#!/usr/bin/env bash
#
# capture.sh — phase-300 read-side API transcript capture.
#
# Captures the exact endpoint set the phase-300 rounds are judged against,
# one raw JSON file per endpoint, from the worktree harness on :7798
# (scripts/checks/serve-v3-7798.ts). At round 301 the worktree's routes are
# byte-identical to main, so what this writes into its own directory IS the
# pre-change baseline; every later round re-runs it via api-diff.sh and must
# reproduce it.
#
# The pinned ids below are the planner's fixtures (plan-300.md §Facts) plus one
# settled run of this project. They are constants ON PURPOSE: a baseline that
# picks "the newest run" each time compares different rows every run and proves
# nothing.
#
# Usage:
#   ./capture.sh                 # (re)write this directory — the baseline
#   ./capture.sh /tmp/current    # capture the same set elsewhere (api-diff.sh)
#   API_BASE=http://127.0.0.1:7700 ./capture.sh /tmp/prod   # against production
#
# Requires the harness to be up:
#   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
#   cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts

set -euo pipefail

BASE="${API_BASE:-http://127.0.0.1:7798}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE}"

# ── Pinned fixtures ────────────────────────────────────────────────────────
# PROJECT_ID: operator-visibility (this project) — the ?project_id= filter.
# RUN_ID:     its architect run, status=completed since 07:02Z. A SETTLED run,
#             so every field of it is frozen history: it is the strongest
#             byte-equality evidence in the whole transcript.
# CHAT_ID:    the chat-thread fixture. REPINNED in round 308 (review finding 4)
#             from `bfd1283a…` — Konrad's own live operator chat, which he keeps
#             talking to, so its message_count and spent_usd drifted between
#             every capture and the values layer of this gate was permanently
#             red — to `da286217…`: a chat that has been `completed` since
#             2026-07-29 15:32Z, 183 entries, nobody's live conversation. A
#             settled run is frozen history, which is the only thing a
#             byte-equality gate can honestly pin.
PROJECT_ID="8ea0cc08-28d9-4301-9f28-c98e1c5d6838"
RUN_ID="3853c154-e07b-4378-9313-2b34f4a33342"
CHAT_ID="da286217-340c-4c11-bee3-5304fa346df4"

# ── Endpoint table ─────────────────────────────────────────────────────────
# name<TAB>path. api-diff.sh does NOT duplicate this list; it globs the
# baseline directory for *.json, so adding a line here is enough — but it does
# need a normalization spec in api-diff.sh's spec_for(), which refuses to diff
# an endpoint nobody described.
#
# /api/health is the PASS-THROUGH PROOF: no mount in serve-v3-7798.ts claims
# it, so a 200 here means the harness's proxy to :7700 is alive in the same
# capture that exercises the local routers. It took that job from /api/secrets
# in round 308, when secrets became a local mount (review finding 2).
#
# chat-list is captured at limit=50 rather than limit=5 (review finding 5).
# There are 7 chats in total, so the window now holds every one of them —
# including `c0de0304…`, the only chat that resolves to a project. At limit=5
# it fell outside the page, the row-alignment window dropped it, and the four
# additive fields U3 adds to a LINKED row were never compared by this gate.
ENDPOINTS=$(
  cat <<EOF
agents	/api/agents
agents-project	/api/agents?project_id=$PROJECT_ID
agents-run	/api/agents/$RUN_ID
chat-list	/api/chat?limit=50
chat-thread	/api/chat/$CHAT_ID
projects-managers	/api/projects/managers
projects	/api/projects
secrets	/api/secrets
health	/api/health
EOF
)

mkdir -p "$OUT"

fail=0
while IFS=$'\t' read -r name path; do
  [ -n "$name" ] || continue
  dest="$OUT/$name.json"
  # -f is deliberately NOT used: on a 500 we want the body, not an empty file.
  code=$(curl -sS -o "$dest.raw" -w '%{http_code}' "$BASE$path")
  if [ "$code" != "200" ]; then
    echo "FAIL  $name  $path → HTTP $code" >&2
    head -c 500 "$dest.raw" >&2 || true
    echo >&2
    rm -f "$dest.raw"
    fail=1
    continue
  fi
  # Pretty-print with sorted keys: raw JSON key order is whatever the driver
  # emitted, and a re-ordering is not an API change. Sorting here means the
  # diff in api-diff.sh is a real value diff, and it keeps the committed
  # artifact readable instead of one 385 KB line.
  if ! jq -S . "$dest.raw" > "$dest"; then
    echo "FAIL  $name  $path → response is not JSON" >&2
    fail=1
    continue
  fi
  rm -f "$dest.raw"
  printf 'ok    %-18s %-60s %s bytes\n' "$name" "$path" "$(wc -c < "$dest")"
done <<< "$ENDPOINTS"

if [ "$fail" -ne 0 ]; then
  echo "capture.sh: at least one endpoint failed — transcript is INCOMPLETE" >&2
  exit 1
fi

echo "captured $(ls -1 "$OUT"/*.json | wc -l) endpoints from $BASE into $OUT"
