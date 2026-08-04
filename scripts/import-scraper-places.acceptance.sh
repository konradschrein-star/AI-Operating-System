#!/usr/bin/env bash
# import-scraper-places.acceptance.sh — Phase 3 acceptance test.
#
# Runs import-scraper-places.ts TWICE over the same 500-row window and proves
# exactly one entity remains per business. This is the concrete acceptance
# criterion from CRM Integration Plan §8 Phase 3:
#
#   "a scraped business appears in Twenty exactly once after two consecutive
#    imports"
#
# We prove it at the OS layer (entities + entity_links) — the Twenty half of
# Phase 3 is not this task's scope. If dedupe holds here, it holds by the same
# UNIQUE(system, external_id) constraint regardless of what Twenty does.
#
# The test is deliberately narrow: 500 rows keyed by sqlite rowid, so both
# runs process exactly the same input. It counts scraper-linked entities
# before Run 1, after Run 1, and after Run 2, then asserts Run 2 inserted 0.
#
# Set LIMIT=N in the environment to override the 500-row window.

set -euo pipefail

LIMIT="${LIMIT:-500}"
BATCH="${BATCH:-500}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMPORTER="$SCRIPT_DIR/import-scraper-places.ts"

# Load the same DSN the pm2 processes use. Required, no fallback — same reason
# the aiOsPool refuses to guess (db/ai-os-pool.ts).
if [ -f /opt/ai-os/.secrets/forge-control.env ]; then
  # shellcheck disable=SC1091
  set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
fi
if [ -z "${AI_OS_DATABASE_URL:-}" ]; then
  echo "AI_OS_DATABASE_URL is not set; refusing to run." >&2
  exit 2
fi

psql_count() {
  # Ask sudo -u postgres so we do not need the app-user password on-disk here.
  # Peer auth over the unix socket is the same path pg-backup.sh uses.
  sudo -u postgres psql -p 5434 -d ai_os -Atc "$1"
}

banner() {
  echo
  echo "=================================================================="
  echo "$1"
  echo "=================================================================="
}

banner "Phase 3 acceptance — LIMIT=$LIMIT BATCH=$BATCH"

# Baseline counts, scoped to scraper-linked entities (the only ones this
# importer touches). Total counts are printed too for context.
before_links=$(psql_count "SELECT count(*) FROM entity_links WHERE system='scraper'")
before_entities=$(psql_count \
  "SELECT count(DISTINCT l.entity_id) FROM entity_links l WHERE l.system='scraper'")
before_events=$(psql_count "SELECT count(*) FROM events WHERE system='scraper'")

echo "BEFORE run 1:"
echo "  entity_links(system=scraper) = $before_links"
echo "  distinct entities via scraper links = $before_entities"
echo "  events(system=scraper) = $before_events"

banner "RUN 1"
cd /opt/forge-ai-os/forge-control
run1_output=$(node --import tsx "$IMPORTER" --limit "$LIMIT" --batch "$BATCH" 2>&1)
echo "$run1_output"
run1_result=$(echo "$run1_output" | grep '^RESULT ' | tail -n1 | sed 's/^RESULT //')

after1_links=$(psql_count "SELECT count(*) FROM entity_links WHERE system='scraper'")
after1_entities=$(psql_count \
  "SELECT count(DISTINCT l.entity_id) FROM entity_links l WHERE l.system='scraper'")
after1_events=$(psql_count "SELECT count(*) FROM events WHERE system='scraper'")

echo
echo "AFTER run 1:"
echo "  entity_links(system=scraper) = $after1_links (delta +$((after1_links - before_links)))"
echo "  distinct entities via scraper links = $after1_entities (delta +$((after1_entities - before_entities)))"
echo "  events(system=scraper) = $after1_events (delta +$((after1_events - before_events)))"
echo "  importer RESULT = $run1_result"

banner "RUN 2 (same 500-row window; must be idempotent)"
run2_output=$(node --import tsx "$IMPORTER" --limit "$LIMIT" --batch "$BATCH" 2>&1)
echo "$run2_output"
run2_result=$(echo "$run2_output" | grep '^RESULT ' | tail -n1 | sed 's/^RESULT //')

after2_links=$(psql_count "SELECT count(*) FROM entity_links WHERE system='scraper'")
after2_entities=$(psql_count \
  "SELECT count(DISTINCT l.entity_id) FROM entity_links l WHERE l.system='scraper'")
after2_events=$(psql_count "SELECT count(*) FROM events WHERE system='scraper'")

echo
echo "AFTER run 2:"
echo "  entity_links(system=scraper) = $after2_links (delta from run1: $((after2_links - after1_links)))"
echo "  distinct entities via scraper links = $after2_entities (delta from run1: $((after2_entities - after1_entities)))"
echo "  events(system=scraper) = $after2_events (delta from run1: $((after2_events - after1_events)))"
echo "  importer RESULT = $run2_result"

banner "ASSERTIONS"

fail=0

# The whole point: the second run must be a pure no-op on the write path.
inserted2=$(echo "$run2_result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["inserted"])')
renamed2=$(echo "$run2_result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["renamed"])')

if [ "$inserted2" != "0" ]; then
  echo "FAIL: second run inserted $inserted2 (expected 0). Dedupe is broken." >&2
  fail=1
else
  echo "PASS: second run inserted 0."
fi

if [ "$renamed2" != "0" ]; then
  echo "FAIL: second run renamed $renamed2 (expected 0; input did not change)." >&2
  fail=1
else
  echo "PASS: second run renamed 0."
fi

# Row-count invariants: link and entity counts must not have moved between
# run 1 and run 2. If they did, the second run wrote something, which is
# exactly the failure mode this test exists to catch.
if [ "$after2_links" != "$after1_links" ]; then
  echo "FAIL: entity_links moved from $after1_links to $after2_links between runs." >&2
  fail=1
else
  echo "PASS: entity_links unchanged between runs ($after1_links)."
fi

if [ "$after2_entities" != "$after1_entities" ]; then
  echo "FAIL: distinct entities moved from $after1_entities to $after2_entities." >&2
  fail=1
else
  echo "PASS: distinct entities unchanged between runs ($after1_entities)."
fi

# One-link-per-entity invariant: every scraper link points at a distinct
# entity. If this ever went above 1, a business would have two OS identities,
# which is the failure the whole registry exists to prevent.
max_links_per_entity=$(psql_count \
  "SELECT COALESCE(MAX(c),0) FROM (SELECT COUNT(*) AS c FROM entity_links WHERE system='scraper' GROUP BY entity_id) t")
if [ "$max_links_per_entity" != "1" ] && [ "$after1_links" -gt "0" ]; then
  echo "FAIL: some entity has $max_links_per_entity scraper links (expected 1)." >&2
  fail=1
else
  echo "PASS: at most one scraper link per entity."
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ACCEPTANCE PASS"
  exit 0
else
  echo "ACCEPTANCE FAIL"
  exit 1
fi
