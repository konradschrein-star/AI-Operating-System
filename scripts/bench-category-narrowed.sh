#!/usr/bin/env bash
# Bench category-narrowed graph walk against unfiltered. For each query, run
# hops=2 with no category filter (baseline) and with each non-trivial
# category, then report:
#   - result-set size (chunks)
#   - Jaccard overlap with baseline (how much does narrowing change the
#     surfaced chunks vs just trimming?)
#   - new chunks the narrowed walk surfaces that baseline doesn't.
#
# v1.7 phase 2 added the ?category= param; this is the first formal bench.
set -euo pipefail

QUERIES=(
  "worker gemini"
  "tts providers ai33"
  "fastgen gateway image"
  "drama stock chain"
  "tutorial studio claude pool"
)

CATEGORIES=("decision" "rule" "error" "provider" "format" "job" "person")

base="http://127.0.0.1:7700/api/memory/search"

for q in "${QUERIES[@]}"; do
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")
  curl -s "$base?q=$enc&expand=1&hops=2" > /tmp/cb-base.json
  python3 - <<PY
import json
base = json.load(open('/tmp/cb-base.json'))['hits']
base_set = {(h['vault_path'], h['chunk_index']) for h in base}
print()
print(f"=== query: {'$q'} (baseline hops=2, n={len(base_set)}) ===")
PY
  for cat in "${CATEGORIES[@]}"; do
    curl -s "$base?q=$enc&expand=1&hops=2&category=$cat" > /tmp/cb-cat.json
    python3 - <<PY
import json
base = json.load(open('/tmp/cb-base.json'))['hits']
nar = json.load(open('/tmp/cb-cat.json'))['hits']
base_set = {(h['vault_path'], h['chunk_index']) for h in base}
nar_set = {(h['vault_path'], h['chunk_index']) for h in nar}
inter = base_set & nar_set
union = base_set | nar_set
jacc = len(inter) / len(union) if union else 0.0
new_in_nar = nar_set - base_set
lost_from_base = base_set - nar_set
print(f"  cat={'$cat':9s}  n={len(nar_set):2d}  jaccard={jacc:.2f}  new={len(new_in_nar):2d}  lost={len(lost_from_base):2d}")
PY
  done
done
