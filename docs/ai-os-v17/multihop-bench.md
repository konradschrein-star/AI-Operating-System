# Multi-hop GraphRAG Bench — v1.7 phase 1

Captures the lift from extending `searchMemoryWithGraph` from single-hop expansion to N-hop walk with score decay. Run on the live forge-control instance against the production embedding corpus.

## TL;DR

At a 35% extracted corpus (72/205 chunks, 504 triples), every one of the five seed queries surfaces 1–3 new chunks at hop 2 that hop-1 misses. The lift is real but modest at this coverage and is expected to grow as triple density does — sparsely-extracted regions still graph-isolate fast.

## Method

For each query `q`:

1. Hit `GET /api/memory/search?q=<q>&expand=1&hops=1`.
2. Hit `GET /api/memory/search?q=<q>&expand=1&hops=2`.
3. Diff the `(vault_path, chunk_index)` sets.
4. Report `new@hop2` — chunks present in the 2-hop result that the 1-hop result did not return.

The `expand=1` flag turns the graph walk on; without it the search is vector-only. The `hops` param caps the BFS depth in the entity graph. A fixed budget (default 18 hits per response) is divided between lanes: vector seed at 12, graph at 6. At `hops=2` the 6-slot graph budget splits 3/3 across hops.

Script: `scripts/bench-multihop.sh`.

## Seed queries

```
worker gemini
tts providers ai33
fastgen gateway image
drama stock chain
tutorial studio claude pool
```

Chosen because each maps to a known multi-entity cluster in the corpus (a worker pool + a model, a format + a provider, a gateway + an asset class). Single-hop search retrieves the seed entities; the lift question is whether the second hop pulls in adjacent chunks the seed alone misses.

## Results

Corpus at run: **72 of 205 chunks extracted (35%), 504 triples, 185 distinct entities**.

| Query                          | 1-hop lanes              | 2-hop lanes                     | new@hop2 |
| ------------------------------ | ------------------------ | ------------------------------- | -------- |
| `worker gemini`                | vec=12, g@1=6            | vec=12, g@1=3, g@2=3            | **2**    |
| `tts providers ai33`           | vec=12, g@1=6            | vec=12, g@1=3, g@2=3            | **2**    |
| `fastgen gateway image`        | vec=12, g@1=6            | vec=12, g@1=3, g@2=3            | **1**    |
| `drama stock chain`            | vec=12, g@1=6            | vec=12, g@1=3, g@2=3            | **3**    |
| `tutorial studio claude pool`  | vec=12, g@1=6            | vec=12, g@1=3, g@2=3            | **3**    |

Triple distribution (informs which hop-2 paths are reachable):

| category   | count |
| ---------- | ----- |
| `job`      | 299   |
| `other`    | 58    |
| `error`    | 57    |
| `format`   | 55    |
| `person`   | 24    |
| `provider` | 19    |
| `rule`     | 5     |
| `decision` | 0     |

`decision` is empty because the seed corpus is heavy on HCP message chunks (operational state) rather than vault notes (where decisions get recorded). Triple coverage rebalances when vault-note chunks dominate extraction.

## What "new@hop2" actually measures

Not "the 2-hop result is N items longer" — the total budget is fixed at 18, so list length is the same. It measures **which chunks the rebalanced lane budget surfaces that hop 1 alone cannot reach**. The 3 slots reserved for hop-2 force-include chunks 2 entity-hops out from the seed, dropping 3 of the original hop-1 chunks to make room. The exercise of judgement is whether the new chunks are worth losing the displaced hop-1 ones.

Manual spot-check: yes — the dropped hop-1 chunks are typically tangentially related notes that share one entity with the seed but don't add much signal. The added hop-2 chunks bridge from the seed entity to a related concept (e.g. `drama stock chain` → seed pulls the format spec, hop 2 pulls the clip-library schema overlap note that the format spec references through a shared `clip_libraries` entity).

## Comparison to v1.7 wrap baseline

At v1.7 wrap, the corpus was 58/205 (407 triples, 164 entities) and 4 of 5 queries showed gains at hop 2 (`tutorial studio claude pool` showed +0). After 14 more chunks (1 batch with the new v1.8 extractor), all 5 queries show gains and `tutorial studio claude pool` jumped from 0 → 3 new chunks. Strong signal that hop-2 utility tracks triple density.

## Method limits + next steps

- **Top-line counts are fixed.** A different way to bench the same change would be to widen the budget at `hops=2` (e.g. 12 vec + 8 graph) so hop-2 chunks are additive rather than displacing. Worth doing once we settle on a UI default — currently the budget stays parked at 18.
- **No relevance scoring of the new chunks.** This bench measures discovery, not quality. A future LLM-judge pass would mark each `new@hop2` chunk as load-bearing / nice-to-have / noise.
- **Corpus snapshot.** The reported numbers will move every time the extractor runs. The v1.8 background loop is currently working through the remaining 133 chunks; re-running this bench at full coverage is a v1.8 close-out task.
- **Category-filtered runs.** v1.7 phase 2 added `?category=` to the graph walk. We haven't yet benched whether category-narrowed expansion (e.g. expand only through `decision` triples) changes recall in the expected direction. Open for v1.8.

## Rerun command

```bash
ssh root@65.108.6.149 'cd /opt/forge-ai-os && bash scripts/bench-multihop.sh'
```

Appends a fresh row to this doc each time triple coverage moves materially.
