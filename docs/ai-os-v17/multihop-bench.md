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
ssh root@127.0.0.1 'cd /opt/forge-ai-os && bash scripts/bench-multihop.sh'
```

Appends a fresh row to this doc each time triple coverage moves materially.

---

## v1.8 follow-up — same queries at full coverage

Triple extraction loop drained the corpus. Re-ran the same five queries.

Corpus at run: **205 of 205 chunks extracted (100%), 1452 triples, 498 distinct entities**, all 8 categories populated (first time `decision=9` and `rule=14` are non-zero). Bench was identical at 200/205 — the last 5 chunks didn't move any of these queries.

| Query                          | new@hop2 at 72/205 (v1.7) | new@hop2 at 205/205 (v1.8) | Δ      |
| ------------------------------ | ------------------------- | -------------------------- | ------ |
| `worker gemini`                | 2                         | 1                          | **-1** |
| `tts providers ai33`           | 2                         | 0                          | **-2** |
| `fastgen gateway image`        | 1                         | 3                          | **+2** |
| `drama stock chain`            | 3                         | 1                          | **-2** |
| `tutorial studio claude pool`  | 3                         | 1                          | **-2** |

Counter-intuitive at first: more triples ≠ more hop-2 lift. The marginal value of hop 2 **falls** as triple density rises for 4 of 5 queries; `tts providers ai33` collapses to zero.

The mechanism is graph densification: at high triple density more chunks are reachable directly from the seed at hop 1, so hop 2 has less new ground to cover. The 3-slot hop-2 budget chases chunks that hop 1 — given enough triples — already finds. `fastgen gateway image` is the exception: it gained new bridging entities (the v1.8 batches included more chunks discussing fastgen + image flows together) that opened up genuinely-novel 2-hop reach.

### Updated takeaway

Multi-hop **isn't strictly better at scale**. It's a discovery method that pays best at **medium density**, when 1-hop alone leaves obvious gaps and 2-hop bridges the entity graph cheaply. At full density, the same fixed budget is better spent widening hop 1 than reaching for hop 2.

Concrete implications for the default UI behavior:

- `hops=2` (current default) is the right choice during the early phase of a vault, when triple coverage is sparse-to-medium.
- Once the vault grows triple-dense (informal threshold: >~7 triples per chunk on a corpus), the default should probably fall back to `hops=1` or the budget should grow to compensate. Worth a UI hint when this regime is detected.
- The category-narrowed walk (`?category=decision`) becomes more interesting at high density — narrowing the lens through a sparse category should still surface novel bridges. Untested.

### Open

- **Wider-budget bench**: re-run with a fixed total budget that grows with `hops` (e.g. `12 + 6*hops`) instead of redistributing the same 18. Would isolate "more depth surfaces more chunks" from "depth displaces width".
- **~~Category-narrowed bench~~**: shipped in v1.9, results below.
- **LLM-judge quality pass**: of the chunks hop-2 surfaces (new@hop2), how many are load-bearing for the original query?

---

## v1.9 — Category-narrowed bench

Tests whether the `?category=` filter we added in v1.7 phase 2 actually changes *which* chunks surface vs just trimming the result set. Method: for each query, run baseline `hops=2` (no category) and `hops=2` filtered to each of seven categories. Report result-set size, Jaccard overlap with baseline, and the symmetric difference.

Script: `scripts/bench-category-narrowed.sh`. Corpus: 205/205, 1452 triples, all 8 categories populated.

### Setup constraint that bounds the change

Baseline at `hops=2` is 12 vector seed hits + 6 graph hits. The category filter applies **only to the graph walk**; the vector seed is unchanged. So at most 6 of 18 chunks can change between baseline and narrowed. Maximum `new` and `lost` per query is 6.

### Results

| query                          | category   | n   | jaccard | new | lost |
| ------------------------------ | ---------- | --- | ------- | --- | ---- |
| `worker gemini`                | decision   | 12  | 0.67    | 0   | 6    |
|                                | rule       | 13  | 0.63    | 1   | 6    |
|                                | error      | 18  | 0.50    | 6   | 6    |
|                                | provider   | 17  | 0.52    | 5   | 6    |
|                                | format     | 18  | 0.57    | 5   | 5    |
|                                | job        | 18  | 0.57    | 5   | 5    |
|                                | person     | 18  | 0.50    | 6   | 6    |
| `tts providers ai33`           | decision   | 12  | 0.67    | 0   | 6    |
|                                | rule       | 13  | 0.63    | 1   | 6    |
|                                | error      | 18  | 0.80    | 2   | 2    |
|                                | provider   | 18  | **0.89**| 1   | 1    |
|                                | format     | 18  | 0.50    | 6   | 6    |
|                                | job        | 18  | 0.50    | 6   | 6    |
|                                | person     | 18  | 0.50    | 6   | 6    |
| `fastgen gateway image`        | decision   | 12  | 0.67    | 0   | 6    |
|                                | rule       | 13  | 0.63    | 1   | 6    |
|                                | error      | 18  | 0.64    | 4   | 4    |
|                                | provider   | 18  | 0.71    | 3   | 3    |
|                                | format     | 18  | 0.57    | 5   | 5    |
|                                | job        | 18  | 0.50    | 6   | 6    |
|                                | person     | 18  | 0.50    | 6   | 6    |
| `drama stock chain`            | decision   | 14  | 0.60    | 2   | 6    |
|                                | rule       | 13  | 0.63    | 1   | 6    |
|                                | error      | 18  | 0.57    | 5   | 5    |
|                                | provider   | 18  | 0.50    | 6   | 6    |
|                                | format     | 18  | 0.57    | 5   | 5    |
|                                | job        | 18  | 0.64    | 4   | 4    |
|                                | person     | 18  | 0.50    | 6   | 6    |
| `tutorial studio claude pool`  | decision   | 12  | 0.67    | 0   | 6    |
|                                | rule       | 13  | 0.63    | 1   | 6    |
|                                | error      | 18  | 0.57    | 5   | 5    |
|                                | provider   | 16  | 0.55    | 4   | 6    |
|                                | format     | 18  | 0.64    | 4   | 4    |
|                                | job        | 18  | 0.57    | 5   | 5    |
|                                | person     | 18  | 0.50    | 6   | 6    |

### Findings

1. **The filter is not trimming — it's rotating.** For every non-sparse category (error/provider/format/job/person), the result set fills to 18 but with substantially different chunks (Jaccard 0.50-0.89). Only `decision` and `rule` reduce total size, because they're sparse (9 and 14 triples total).

2. **Topical alignment matters.** `provider`-filtered walk on `tts providers ai33` is the highest-Jaccard pair in the table (0.89, only 1 new + 1 lost) — narrowing by the category that already dominates the query's natural triple graph leaves the walk nearly unchanged. Sanity check passed.

3. **Cross-category narrowing reveals different angles.** `format` on the same query collapses to Jaccard 0.50 — the 6 graph slots fill with chunks about formats that *use* TTS providers, a different question from "what providers are configured." This is the right behavior for an analyst toggling lenses.

4. **`person` narrowing is uniformly Jaccard 0.50** across all 5 queries. With person=66 triples but topically orthogonal to the seed queries, the walk consistently rotates the entire 6-slot graph budget. Useful for "who's involved" but rarely refines the query.

5. **`decision` narrowing consistently kills the graph slots** (n=12 for 4 of 5 queries, n=14 for `drama stock chain`). At 9 decision triples total, the graph walk almost never finds a qualifying chunk reachable from the seed entities. The `decision` filter is useful for "show me only decisions" intent but won't broaden discovery.

### Implication for the UI

The current MemorySurface treats `category` as a filter chip. The bench says it's actually a **lens**, not a filter: the vector seed always survives, and the graph budget rotates entirely. The label "filter to category X" is misleading because at most 33% of the 18 result slots are affected.

Better UI framing: "view through {category} lens" with a per-lens result-set-size hint so the user knows which categories have meaningful graph density. A sparse-category lens (`decision`, `rule`) should display the size collapse explicitly ("12 of 18 — graph walk found no qualifying triples").
