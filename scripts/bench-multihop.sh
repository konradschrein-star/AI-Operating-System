#!/usr/bin/env bash
# Bench multi-hop vs single-hop GraphRAG on the live forge-control.
# Used by the v1.7 phase 1 verification flow.
set -euo pipefail

QUERIES=(
  "worker gemini"
  "tts providers ai33"
  "fastgen gateway image"
  "drama stock chain"
  "tutorial studio claude pool"
)

base="http://127.0.0.1:7700/api/memory/search"

for q in "${QUERIES[@]}"; do
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")
  curl -s "$base?q=$enc&expand=1&hops=1" > /tmp/h1.json
  curl -s "$base?q=$enc&expand=1&hops=2" > /tmp/h2.json
  python3 - <<PY
import json
from collections import Counter
h1 = json.load(open('/tmp/h1.json'))['hits']
h2 = json.load(open('/tmp/h2.json'))['hits']
lanes1 = Counter((h['via'], h['hop']) for h in h1)
lanes2 = Counter((h['via'], h['hop']) for h in h2)
s1 = {(h['vault_path'], h['chunk_index']) for h in h1}
s2 = {(h['vault_path'], h['chunk_index']) for h in h2}
new = s2 - s1
print(f"q={'$q'!r:40s}  1-hop={len(h1):2d} lanes={dict(lanes1)}  2-hop={len(h2):2d} lanes={dict(lanes2)}  new@hop2={len(new)}")
PY
done
