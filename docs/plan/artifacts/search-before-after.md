# Vault search: before/after Excalidraw indexing backfill

Round 2 of `aios-vault-and-search`. Produced by `scripts/verify-vault-search.ts`,
run against the **live** `content_forge`/`hcp` Postgres instance and the live
embed sidecar (`:8766`) — the same data `GET /api/memory/search` reads. Raw
JSON: `/tmp/vault-search-report.json` (not committed; regenerate with the
script — see its header for the run command).

Before pass: `2026-08-23T00:45:17.481Z`. Backfill: `syncVaultNotes()` —
`{"scanned":294,"upserted":294,"deleted":0,"errors":0}`. After pass:
`2026-08-23T00:50:02.145Z`.

## Coverage

| | before | after |
|---|---|---|
| vault `.md` files on disk | 294 | 294 |
| embedded (searchable by content) | 270 | **279** |
| excluded — Excalidraw, no extractable text | 12 | **3** |
| excluded — empty file (0 bytes) | 10 | 10 |
| excluded — frontmatter-only | 1 | 1 |
| unexplained (no embedding, no exclusion reason) | 1 | 1 |

**9 of the 16 `.excalidraw.md` drawings went from unindexed to embedded** in
this run (4 of the 16 were already embedded before this backfill — outside
`syncVaultNotes()`'s history, not investigated further since it isn't a
regression). The 3 that remain excluded are confirmed empty, not a bug:
`AI OS - Canvas Smoke Test.excalidraw.md` (531 B), `gemini-canvas-smoke.excalidraw.md`
(450 B), `Directory Engine - Scraper System Map.excalidraw.md` (526 B) — each
is a blank test canvas or, per the `excalidraw-file-shapes-vary` memory note,
a drawing whose elements are all `isDeleted`. Extracting nothing from them is
correct; misreporting them as embedded would not be.

**Coverage against the brief's 282+/293 target: 279 embedded.** Short by 3,
and the shortfall is not Excalidraw-related: it is one pre-existing,
unrelated gap — `Daily/2026-08-23.md` (2455 bytes, real body, on disk, no
embedding row, no exclusion reason applies) — present in **both** the before
and after pass. That file is `km-indexer.js`'s job (regular-note embedding),
not `syncVaultNotes()`'s (Excalidraw + registry only); it's outside this
round's write-set and is flagged here rather than silently absorbed into the
excalidraw number. Net: **293 of 294 files are now fully explained**
(embedded, or excluded for a stated, checked reason) — one unexplained file,
down from the same one unexplained file before. The `disk` count read 294 at
run time, not 293 as measured at brief-writing time (00:45 UTC); the vault
gained/lost a file in between, consistent with `Daily/2026-08-23.md` being
today's note.

## The 10 queries

Same `searchMemory()` call the UI makes via `searchMemoryExpanded()` →
`GET /api/memory/search?expand=1`, `limit=5`. Full hit lists are in the raw
JSON; top result shown here.

| # | query | kind | before: count / top hit | after: count / top hit |
|---|---|---|---|---|
| 1 | `Spec - Manager Chat UI v3` | exact title | 3 / **exact_title**, score 1.0 | 3 / **exact_title**, score 1.0 (unchanged) |
| 2 | `Operator Decisions` | exact title | 3 / **exact_title**, score 1.0 | 3 / **exact_title**, score 1.0 (unchanged) |
| 3 | `Help from Harry` | empty note | 1 / **exact_title**, `is_empty: true` | 1 / **exact_title**, `is_empty: true` (unchanged) |
| 4 | `Documented Conflicts` | empty note | 2 / **exact_title**, `is_empty: true` | 2 / **exact_title**, `is_empty: true` (unchanged) |
| 5 | `brand guidelines` | frontmatter-only | 2 / **exact_title**, `is_empty: true` | 2 / **exact_title**, `is_empty: true` (unchanged) |
| 6 | `Stealth Uploader - System Map` | Excalidraw title | 2 / exact_title, reason "Exact title match" | 2 / exact_title, reason **"Exact title match + semantic similarity"** |
| 7 | `AI OS - Life & Company OS - Planning Canvas` | Excalidraw title | 4 / exact_title, reason "Exact title match" | 4 / exact_title, reason **"Exact title match + semantic similarity"** |
| 8 | `warming the jar fingerprint stable` | Excalidraw **content** (words drawn inside the "Warming Timeline" card, not in any title) | **0 — the drawing was invisible to search** | **1 — `Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md`, score 0.55, via vector** |
| 9 | `how does the executor recover from a stuck run` | semantic, no exact string anywhere | 2 / vector hits on relevant chat notes | 2 / same hits (unchanged — not Excalidraw-related) |
| 10 | `why does vault search return nothing for a title` | semantic, adversarial (asks about the bug itself) | 0 | 0 (unchanged — correctly no false hit) |

## What changed and what didn't

- **Query 8 is the proof the brief asked for**: "index the Excalidraw notes
  … so a drawing is findable by the words written in it." Before the
  backfill, a phrase drawn on a card inside `Stealth Uploader - Warming
  Timeline` returned zero hits — the drawing was as invisible as the ticket
  said. After, it's the #1 (only) hit via vector similarity on the extracted
  text elements.
- **Queries 6–7 show a quieter, real improvement**: the exact-title lexical
  layer already found these two drawings before this round (that's round 1's
  fix — `findDbLexicalMatches()` reads `hcp.knowledge_note`, independent of
  embeddings). What changed is `match_reason`: "Exact title match" alone →
  "Exact title match + semantic similarity", because the hybrid fusion in
  `searchMemory()` now has a vector hit to merge in. So title search for a
  drawing was not the gap; content search was, and query 8 is where that gap
  actually closes.
- **Queries 1–5, 9–10 are unchanged**, as expected — none of them touch
  Excalidraw content, so this backfill has no reason to move them. Included
  as a control: the empty-note and frontmatter-only cases (3, 4, 5) already
  return `is_empty: true` with a real hit rather than silently nothing, which
  is round 1's fix, still holding after this round's write.

## Coverage discrepancy list (after), for the record

```
excluded_extension (3): AI OS - Canvas Smoke Test, Directory Engine - Scraper
  System Map, gemini-canvas-smoke — all confirmed <600 bytes, no extractable
  text (see excalidraw-file-shapes-vary memory note)
unexplained (1): Daily/2026-08-23.md — km-indexer.js gap, not Excalidraw,
  outside this round's write-set
```

Full per-file list (all reasons, both passes): `/tmp/vault-search-report.json`
→ `.before.health.discrepancies` / `.after.health.discrepancies`.
