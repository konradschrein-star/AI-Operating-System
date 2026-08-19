# Index reconciliation — B1c

**Project:** `os-usable-for-work` · phase 1 · workstream `vault` · branch `project/7851068b-vault`
**Date:** 2026-08-18
**Requirements:** R12, R13, R14, R15, R16, R17, R20 · **Non-functionals:** N1, N10

---

## 1. The premise this task exists to retire

> **A4. 67 vault files are unindexed.** Find why `vault-sync-tick.ts` skipped them…

**That premise is FALSE, and nothing in this commit tries to fix it.**

The figures below are **cited from `docs/plan/os-usable-for-work/00-vision.md` §2.1**, which measured
them against the live system on 2026-08-18. They are quoted here, not re-run — the architect's round-0
measurement is the record, and re-deriving it would only invite two numbers where there should be one.

| Fact | Value | Command (00-vision §2.1) |
|---|---|---|
| `.md` under `/opt/obsidian-vault` **including** `.trash` | **326** | `find /opt/obsidian-vault -name '*.md' \| wc -l` |
| `.md` **excluding** dot-directories (the real vault) | **284** | `find … -not -path '*/.*'` |
| `.md` inside `.trash` | **42** | difference, confirmed by directory breakdown |
| `hcp.knowledge_note` rows written by `vault-sync` | **284** | `SELECT created_by, count(*) … GROUP BY 1` |
| `hcp.knowledge_note` rows written by Hermes workers | **198** | same query (`hcp-worker-01/02/03`) |
| `hcp.knowledge_note` total | **482** | `SELECT count(*)` |
| `content_forge.knowledge_embeddings` DISTINCT `source_path` | **259** | `SELECT count(DISTINCT source_path)` |
| `content_forge.knowledge_embeddings` chunk rows | **2,131** | `SELECT count(*)` |
| `content_forge.knowledge_triples` | **0** | `SELECT count(*)` |

**Where "67" came from.** `326 − 259 = 67`. That subtraction compares a `find` that *included the 42
deleted files in `.trash`* against a figure from a *different index, in a different database, owned by
a different process*. It is not a gap; it is a unit error committed twice in one line of arithmetic.

**The honest comparison is 284 against two indexes:**

- **`hcp.knowledge_note`** — written by `syncVaultNotes()` (`forge-control/src/db/memory.ts`), driven
  by `src/lib/vault-sync-tick.ts` every 5 minutes. **284 of 284. Coverage 100%. It skips nothing.**
  There is no indexer bug to find.
- **`content_forge.knowledge_embeddings`** — written by `/opt/knowledge-mcp/km-indexer.js`, a process
  **outside this repo**. 259 files. Its shortfall decomposes with no residue into 15 deliberately
  excluded `.excalidraw.md` drawings, 10 zero-byte files and 1 frontmatter-only note — **plus one
  stale row in the other direction** (`Coach/log.md`: embedding rows survive, the file is gone,
  because `km-indexer.js` has no prune step while `syncVaultNotes()` does).

**Real content gap: ZERO files.** Every absence is deliberate behaviour.

**So the defect is architectural and it is a labelling defect:** two indexes, two databases, two
owners, one of them on a tick and one of them with none — and until this commit not one surface said
which of them a number came from. Re-running an indexer would have fixed nothing, and the gap would
"return tomorrow" only in the sense that it never left.

**This task therefore builds an instrument, not a repair.** `GET /api/memory/index-health` reduces the
whole question to one number: `unexplained_count`. Silent at 0; loud the day it is not.

---

## 2. The five classification rules and where each evidence string comes from

`forge-control/src/lib/index-health.ts` — **no `pg`, no `fs`**, so every rule is exercised against
synthetic vaults with no database and no files. `classify()` takes one file's measured membership and
returns a `{reason, detail}` or `null`.

| Order | Condition | `reason` | `detail` | Source of the evidence |
|---|---|---|---|---|
| 0 | in neither disk nor embeddings | *(null — nothing to reconcile)* | — | `reconcile()`'s universe is disk ∪ embeddings; `classify()` is public and must not invent a discrepancy from nothing |
| 1 | **not on disk**, in embeddings | `stale_row_file_missing` | `embedding rows survive; km-indexer.js never prunes` | 00-vision §2.1 and 02-architecture §1.1 — `syncVaultNotes()` deletes its own orphans (`DELETE … WHERE created_by = 'vault-sync' AND NOT (vault_path = ANY(...))`); `km-indexer.js` has no prune step |
| 2 | on disk **and** in embeddings **and** not in the registry | `unexplained` | names both stores | `inRegistry` is in the fact set that 02-architecture §1.4 specifies; a file one index accepted and the other never saw is explained by none of the four exclusions |
| 3 | on disk, not embedded, path ends `.excalidraw.md` | `excluded_extension` | `km-indexer.js:29 EXCLUDED_EXTENSIONS` | `/opt/knowledge-mcp/km-indexer.js:29` — `EXCLUDED_EXTENSIONS = ['.excalidraw.md']` (00-vision §2.1) |
| 4 | on disk, not embedded, `bytes === 0` | `empty_file` | `0 bytes` | `stat -c%s` = 0 on each (00-vision §2.1) |
| 5 | on disk, not embedded, body empty after frontmatter | `frontmatter_only` | `<n> bytes, frontmatter only` | `cat -A 'brand guidelines.md'` shows `---\ntags:\n…` and nothing after the fence (00-vision §2.1) |
| 6 | on disk, not embedded, none of the above | **`unexplained`** | `<n> bytes with a non-empty body, on disk, no rows in content_forge.knowledge_embeddings and no deliberate exclusion applies` | **THE HEADLINE** |

**Every count is derived; no code path returns one of today's numbers (R13).** `15`, `10`, `259`,
`284`, `2131`, `198`, `482` and `65` appear in the three touched files **only inside comments** that
explain the measurement — verify with
`grep -n '\b\(15\|10\|259\|284\|2131\|198\|482\|65\)\b' forge-control/src/lib/index-health.ts
forge-control/src/db/memory.ts forge-control/src/routes/memory.ts`; every hit is prose, and the two
non-prose hits (`excludedOtherDot.slice(0, 10)` for a log line, and pre-existing ranking constants) do
not feed a count. A classifier that returned constants would pass any single fixture, which is why
the suite asserts the flip: *every absence explained → `unexplained_count === 0`; add **one** ordinary
note with real content and no embedding row → `unexplained_count === 1`, and the discrepancy names
that path.*

**Every discrepancy carries a non-null, non-`"unknown"` reason and a non-empty detail (R12).** Asserted
in the suite over all five reasons, and asserted against the live payload in §4 below.

### Two judgement calls worth naming

1. **Rule 2 (`unexplained` for a registry absence) is an extension of the brief's rule list.** The
   brief specifies `inRegistry` in `classify()`'s input; leaving it unused would have made it a
   decorative parameter. A file that is on disk and embedded but which `syncVaultNotes()` never
   registered is a genuine, unexplained index gap, and `unexplained` is exactly what that means. It
   fires on nothing today (`unexplained_count: 0` in §4).
2. **`frontmatter_only` also absorbs a whitespace-only file with no frontmatter.** `hasBody` is a
   boolean by the briefed signature, so rules 4 and 5 together mean "bytes on disk, nothing to embed".
   The byte count in `detail` keeps the claim checkable with `stat -c%s`. Tested explicitly (a 1-byte
   bodyless file lands in `frontmatter_only`, not `empty_file`).

### Scope of the candidate universe

`reconcile()` reconciles **disk ∪ embeddings**. A registry row with neither a file nor an embedding is
deliberately out of scope: `syncVaultNotes()` prunes its own orphans every 5 minutes, so that state is
transient by construction, whereas an embeddings orphan is *permanent* because `km-indexer.js` never
prunes. Registry membership is still reported per candidate as `in_registry`, and rule 2 above makes a
registry absence loud rather than invisible. Including the registry in the universe would also have
dragged in all 198 worker briefs — whose `vault_path` is, per `db/memory.ts`'s own comment, "a
self-declared label, not a path that exists on disk" — as 198 phantom discrepancies.

### One shape gap, disclosed rather than papered over

`IndexHealth.disk` is fixed by 02-architecture §1.4 to `{ md_files, excluded_trash }`. The scan
excludes **every** dot-directory segment (matching `syncVaultNotes()` exactly, which is what makes
`md_files` and `vault_sync_rows` comparable numbers), but the envelope has a field for `.trash` only.
Today that is lossless — `284 + 42 = 326`, so `.trash` accounts for every dot-excluded `.md` file, and
the run in §4 emitted no warning. If a `.md` file ever appears under another dot-directory it would be
counted in no field, so `measureIndex()` `console.warn`s and names the paths. **Flagged for phase 7:
if that warning ever fires, the envelope needs a third disk field.**

---

## 3. The counts ruling (R15–R17) and the phase-2 handoff

### What was removed

| Removed | Why |
|---|---|
| `all: 482` | Not a vault number. It silently unioned 284 real files with 198 agent-authored briefs. R15 forbids a top-level integer key that does not state its unit and source. |
| `rule`, `pref`, `fact`, `person`, `project`, `note` | `inferCategory()` matches frontmatter tags named `rule`/`pref`/`person`/`project`/`fact`. The vault's real tags are `recurring`, `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope`, and only **65 of 284** notes carry any tag at all. Five of six chips were **structurally incapable** of a non-zero number, and the sixth absorbed everything. A filter that always returns zero is worse than no filter: it teaches the operator his vault is empty. This is the whole of "it's zero and not eight" (00-vision §2.3). |

**No union replaces `all`.** R15 requires every top-level integer key to match
`/^(vault|agent|embedded|excluded|stale)_/`, and R16's fallback name `notes_all_sources` would violate
it. The vault/agent split — 284 real files against 198 worker briefs — **is** the honest presentation,
and phase 2 renders both (R29).

`inferCategory()` and the `NoteCategory` type are **kept**: `listMemoryPage()` still returns a per-note
`category` field the web list uses. Only the counts rail loses them. The existing `?source=vault|agent`
filter keeps working.

### What replaced them

```ts
interface MemoryCounts {
  vault_files_on_disk: number;   // .md under OBSIDIAN_VAULT_DIR, excluding dot-directories
  vault_notes_indexed: number;   // hcp.knowledge_note WHERE created_by = 'vault-sync'
  agent_notes: number;           // hcp.knowledge_note WHERE created_by <> 'vault-sync'
  embedded_files: number;        // DISTINCT source_path in content_forge.knowledge_embeddings
  embedded_chunks: number;       // chunk rows in the same table
  excluded: { excalidraw: number; empty: number; frontmatter_only: number };
  stale_embedding_rows: number;  // distinct source_paths whose file is gone from disk
  measured_at: string;
  source: "vault" | "agent" | "all";   // which rows folder_counts was derived from
  folder_counts: Record<string, number>;
  folder_rule: string;                 // the derivation, stated verbatim in the response
}
```

**`folder_counts` is an OBJECT, not a top-level integer, so it does not violate R15** — and neither do
`excluded` (object), `measured_at`, `source` and `folder_rule` (strings). R15's rule governs top-level
**integer** keys; that is what `offendingCountKeys()` checks and what the suite asserts, in both
directions: the real envelope shape yields `[]`, and injecting a bare `all` yields `["all"]`. Without
that second half the assertion could not fail and would prove nothing. (`notes_all_sources` is
asserted to offend too, so R16's rejected fallback cannot creep back in.)

**`folder_rule` states the derivation verbatim in the response:**

> `first "/"-separated segment of vault_path; a note with no "/" is counted under "(root)". Scope: <the rows it was derived from>.`

A note at the vault root has no folder segment and is counted under `(root)` — tested, because a
folder rail that silently drops the root notes is "it's zero and not eight" in a new costume.

`source` scopes `folder_counts` only. The totals above it are absolute and already labelled by source,
so they never move when the filter changes.

**`stale_embedding_rows` counts distinct stale `source_path`s (files), matching
`index-health`'s `stale_row_file_missing` discrepancy count.** The prune verb returns the deleted
*chunk*-row count separately as `count`.

### R14 — prune is explicit and has exactly one caller

`pruneStaleEmbeddingRows(paths)` deletes only `WHERE source_path = ANY($1::text[])`. The route
recomputes `index-health` and passes **only** the paths it classified `stale_row_file_missing` — the
client's body is never a path list, so a stale or hostile list cannot reach a `DELETE`. `{"confirm":
true}` is required; a body that fails to parse is a 400, never a silent `{}`.

The suite asserts by **source scan**, not by observation: it walks every `.ts` under
`forge-control/src`, and asserts the set of files mentioning `pruneStaleEmbeddingRows` is exactly
`["routes/memory.ts"]`. No tick, no startup path, no read reaches it. That test fails the day someone
wires it into a tick.

### R20 / N1 — hard errors

No `catch {}` returning a default, no `?? 0`, no `|| []` anywhere in the new code. Both queries and
the disk walk propagate. A `COUNT(*)` that returns no row throws with a diagnostic naming the query
rather than defaulting to zero. `reconcile()` throws `IndexHealthInputError` — naming the path — if it
ever needs a body that was not measured, rather than guessing one; a guessed body is a fabricated
reason, and a fabricated reason is what this endpoint exists to abolish.

`GET /index-health` and `POST /index-health/prune` both return **500 with the message**, never a
zeroed payload. Asserted in the suite by pointing both pools at a dead port: the response is
`500 {"error":"index-health failed: connect ECONNREFUSED 127.0.0.1:1"}` and the assertion additionally
checks that `unexplained_count` and `disk` are **absent** from that body — a payload of zeros is
indistinguishable from a total index collapse.

### ⚠️ HANDOFF TO PHASE 2 — DECLARED, NOT FIXED

**`forge-control-web/app/desktop/MemorySurface.tsx:176` renders:**

```tsx
{listQ.isLoading ? "loading…" : `${counts.all ?? 0} notes`}
```

`counts.all` no longer exists. **From this commit until phase 2 rewires it, that line renders
`0 notes` in the worktree.** This file is phase 2's (02-architecture §0.3) and this task must not
touch it.

It is a **declared handoff, not a shipped regression**: nothing deploys before phase 7, and phase 2
precedes integration.

Phase 2 must change **two** files, both of which are the `vault` lane's:

| File | Line | What it needs |
|---|---|---|
| `forge-control-web/app/desktop/MemorySurface.tsx` | **176** | render the labelled fields (R28/R29) — `vault_files_on_disk`, `vault_notes_indexed`, `agent_notes`, `embedded_files`; every number with its unit, and the vault/agent split visible and filterable |
| `forge-control-web/app/api.ts` | **468** | `fetchMemoryCounts` is still typed `Record<MemoryCategory \| "all", number>`. `getJson` casts without validating, so this does **not** fail a typecheck — it fails silently at runtime. Per 02-architecture §0.3 `api.ts` is contended and must not be edited: the lane adds `forge-control-web/app/api-vault.ts` with the new typed client and points `MemorySurface.tsx` at it. |

`grep -rn 'counts\.all\|memory/counts' forge-control-web/app forge-control/src` returns exactly these
two consumers and the server route — there is no third.

---

## 4. The live `indexHealth()` run — R12/R13 asserted against today's vault

Read-only, out of the worktree, no server started, no writes, no restarts:

```bash
cd forge-control && ./node_modules/.bin/tsx -e \
  'import("./src/db/memory.ts").then(async m=>console.log(JSON.stringify(await m.indexHealth(),null,2)))'
```

### Verdict

| R13 acceptance | Required | Measured | |
|---|---|---|---|
| `excluded_extension` | 15 | **15** | ✅ |
| `empty_file` | 10 | **10** | ✅ |
| `frontmatter_only` | 1 | **1** | ✅ |
| `stale_row_file_missing` | 1 | **1** (`Coach/log.md`) | ✅ |
| **`unexplained`** | **0** | **0** | ✅ |
| R12: every discrepancy has a non-null, non-`"unknown"` reason and a non-empty detail | all 27 | **all 27** | ✅ |
| R12: `disk.md_files` computed by the endpoint, not hardcoded | 284 | **284** | ✅ |

Tally reproduced from the captured payload:

```bash
python3 -c "
import json,collections
d=json.load(open('/tmp/index-health.json'))
print(collections.Counter(x['reason'] for x in d['discrepancies']))
print('unexplained_count',d['unexplained_count'],'total',len(d['discrepancies']))
print('no reason/detail:',[x['path'] for x in d['discrepancies']
                           if not x.get('reason') or x['reason']=='unknown' or not x.get('detail','').strip()])"
# Counter({'excluded_extension': 15, 'empty_file': 10, 'stale_row_file_missing': 1, 'frontmatter_only': 1})
# unexplained_count 0 total 27
# no reason/detail: []
```

### Cost of the run (N10)

`real 0m10.5s` end to end (`time` on the command above), which includes `tsx` cold start and both pool
connections. The I/O it performs is derivable from the payload itself and is deliberately small:

- **3 SQL queries** — one over `hcp.knowledge_note`, two over `content_forge.knowledge_embeddings`.
- **1 `readdir`** (recursive) + **284 `stat`** calls.
- **exactly 1 `readFile`.** The brief forbids slurping 284 files. Bodies are read only for files that
  need the `frontmatter_only` decision: on disk, absent from embeddings, non-zero bytes, not a
  drawing. From the payload: 284 on disk, 258 of them embedded (259 embedded files − the 1 stale
  `Coach/log.md` that is not on disk), leaving 26 candidates, of which 15 are `.excalidraw.md` and 10
  are 0 bytes → **1 file read** (`brand guidelines.md`, 57 bytes).

### Disclosed read-only probe (not part of the authorised run)

Before writing the query I checked whether `knowledge_embeddings.source_path` currently carries the
`worker-task://…` / `agent-message://…` pseudo-URIs that `indexAgentMessages()` writes, because
counting those as "embedded vault files" would report coverage the index does not have. SELECT-only,
no writes:

```bash
psql "$DATABASE_URL" -tA \
  -c "SELECT count(DISTINCT source_path), count(*) FROM knowledge_embeddings;" \
  -c "SELECT count(DISTINCT source_path), count(*) FROM knowledge_embeddings
        WHERE source_path LIKE '%.md' AND source_path NOT LIKE '%://%';"
# 259|2035
# 259|2035
```

Identical today — no pseudo-URI rows are present. The scoped predicate
(`VAULT_SOURCE_PATH_SQL`, already in `db/memory.ts`) is used anyway, so the number stays honest if
`indexAgentMessages()` runs again.

### A measured drift worth recording

`embedded_chunks` moved **2,131 → 2,035 → 2,042** across three measurements taken minutes apart today
(00-vision §2.1 · the psql probe above · the `indexHealth()` run below). `DISTINCT source_path` held
steady at **259** throughout. Something is actively rewriting chunk rows for the same file set —
consistent with `km-indexer.js` re-chunking on demand. **This is not a defect and needs no action
here**; it is recorded so a later reviewer does not read `2042 ≠ 2131` as a regression this commit
caused. It is also why `embedded_chunks` is derived on every request rather than cached.

### The payload, verbatim

```json
{
  "measured_at": "2026-08-18T20:16:52.498Z",
  "disk": {
    "md_files": 284,
    "excluded_trash": 42
  },
  "registry": {
    "vault_sync_rows": 284,
    "agent_rows": 198
  },
  "embeddings": {
    "files": 259,
    "chunks": 2042
  },
  "discrepancies": [
    {
      "path": "AI OS/Canvas/patch-test.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "AI Stories Channels.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Automated Media Infrastructure.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Coach/log.md",
      "in_disk": false,
      "in_registry": false,
      "in_embeddings": true,
      "reason": "stale_row_file_missing",
      "detail": "embedding rows survive; km-indexer.js never prunes"
    },
    {
      "path": "Documented Conflicts.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Directory Engine - Scraper System Map.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-06-13 21.29.57.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-02 12.08.39.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-03 18.25.41.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-03 18.25.45.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-07 18.30.43.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-23 00.48.06.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-07-26 13.08.35.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-08-05 12.31.07.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Drawing 2026-08-09 15.42.40.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Stealth Uploader - System Map.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "excluded_extension",
      "detail": "km-indexer.js:29 EXCLUDED_EXTENSIONS"
    },
    {
      "path": "Execution Plan - Phase 1 Foundation.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Finance - Tier 1 Basic Operation.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Help from Harry.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Research - Hardware Market Timing.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Research - Political Content Mechanics.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Untitled 1.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "Untitled.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "empty_file",
      "detail": "0 bytes"
    },
    {
      "path": "brand guidelines.md",
      "in_disk": true,
      "in_registry": true,
      "in_embeddings": false,
      "reason": "frontmatter_only",
      "detail": "57 bytes, frontmatter only"
    }
  ],
  "unexplained_count": 0
}
```

> The block above is the captured run byte for byte — `sha256` compared against the file the
> command wrote, not re-typed. My first transcription of it silently dropped three of the 27
> discrepancies; that is exactly why it is machine-copied and hash-checked rather than quoted.

---

## 5. Verification run for this commit

```bash
cd forge-control
pnpm install --frozen-lockfile --prod=false   # "Already up to date"; node_modules/.bin holds tsc + tsx
npx tsc --noEmit                              # exit 0, no output
pnpm test                                     # tsx --test src/lib/*.test.ts
#   tests 1364 · suites 254 · pass 1364 · fail 0 · duration_ms 7238
#   (new file alone: 33 tests, 6 suites, 33 pass, 0 fail)
```

`memory-index-health.test.ts` is hermetic: the classification tests touch no database and no vault; the
four route tests import the real router with both connection strings pointed at `127.0.0.1:1`, so the
hard-error path is exercised deterministically rather than depending on whether Postgres happens to be
up.

**Route ordering is asserted by test, not by eye** — and in three layers, because each alone is weak:

1. **A control that proves Hono shadows at all.** Two throwaway apps, the same two patterns, opposite
   registration order: the correct order answers `"health"`, the reversed order answers `"slug"`. Without
   this, asserting an order would prove nothing.
2. **The real router's own route table.** `GET /index-health` and `POST /index-health/prune` are both
   registered at a lower index than `GET /:slug{.+}`, with failure messages naming what moved.
3. **Real dispatch through `app.request()`.** `GET /index-health` returns `500` whose `error` starts
   with `index-health failed: ` — a prefix no other handler in the file produces. That is the dispatch
   proof.

---

## 6. Write-set

| File | Change |
|---|---|
| `forge-control/src/lib/index-health.ts` | **new** — pure classification, reconciliation, folder counts, R15 key rule |
| `forge-control/src/lib/memory-index-health.test.ts` | **new** — 33 hermetic tests |
| `forge-control/src/db/memory.ts` | extended — `measureIndex()`, `indexHealth()`, `pruneStaleEmbeddingRows()`; `noteCounts()` returns the labelled envelope |
| `forge-control/src/routes/memory.ts` | extended — `GET /index-health`, `POST /index-health/prune`, both before the catch-all |
| `docs/plan/artifacts/os-usable-for-work/phase1/index-reconciliation.md` | **new** — this file |

Nothing outside that list was written. `lib/vault.ts`, `routes/vault.ts`, `src/index.ts` and every file
under `forge-control-web/` are untouched.
