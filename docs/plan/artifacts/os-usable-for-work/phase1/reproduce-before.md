# Phase 1 · B1d — the before-state reproduction

Captured **2026-08-18** at commit `9d63480f30e9688636b3abd57553789f5b1cc87a`, branch
`project/7851068b-vault`, worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--vault`.

Everything below is a **read-only observation**, explicitly briefed and confined to this task. No
write reached `/opt/obsidian-vault`, no statement reached any database, no service was restarted, and
no `PUT`/`POST`/`DELETE` was sent to the live API. The two `curl`s are `GET`s; the third is an
`OPTIONS` preflight.

---

## ⚠️ READ THIS FIRST — the brief's "67 unindexed files" premise is FALSE

**There is no 67-file gap, and no task in this phase re-runs an indexer.**

The figure was produced by subtracting a **content_forge embeddings** count (259 distinct
`source_path`) from a **filesystem** count that included `.trash` (326 `.md` files). Those two numbers
do not measure the same population and their difference measures nothing.

Against the honest denominator — **284** real `.md` files, i.e. excluding dot-directories —
`hcp.knowledge_note` covers **284 of 284. Coverage is 100%; `syncVaultNotes()` skips nothing.**
Requirement **A4's premise is false and must not be "fixed"**: `vault-sync-tick.ts` did not skip 67
files, or any file.

**The real content gap is ZERO.** The embeddings table's 25-file shortfall decomposes with no residue
into three deliberate, correct exclusions (15 `.excalidraw.md` drawings excluded by the indexer's own
`EXCLUDED_EXTENSIONS`, 10 zero-byte files, and 1 frontmatter-only 57-byte file). There is **no note
with content that failed to index**.

The defect that does exist is a **labelling** defect: two indexes, in two databases, with two owners
— one inside this repo on a 5-minute tick, one (`/opt/knowledge-mcp/km-indexer.js`) outside it with no
tick — and not one surface in the product says which of them a number came from. See §(c) below and
`00-vision.md §2.1`.

---

## (a) VAULT EDIT — the API has no edit verb

Root cause, already found in round 0; not re-derived here. The evidence is the route table itself.

```
$ grep -nE '^r\.(get|post|put|patch|delete)' forge-control/src/routes/vault.ts
23:r.post("/append", async (c) => {
49:r.post("/note", async (c) => {
71:r.get("/daily", async (c) => {
```

Three verbs. `POST /append`, `POST /note`, `GET /daily`. **No `PUT`, no `PATCH`** — append-or-create
only, so the surface structurally cannot save what it shows.

The live API agrees. One read-only `GET`, `2026-08-18T19:28:33Z`:

```
$ curl -si 'http://127.0.0.1:7700/api/vault/file?path=Daily/2026-08-18.md'
HTTP/1.1 404 Not Found
access-control-allow-headers: content-type
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-allow-origin: *
content-type: text/plain; charset=UTF-8
content-length: 13
Date: Tue, 18 Aug 2026 19:28:33 GMT
Connection: keep-alive
Keep-Alive: timeout=5

404 Not Found
```

**Control, so the 404 cannot be read as "the router is not mounted":** the one `GET` that does exist
on the same router answers 200 on the same live process, seconds later.

```
$ curl -si 'http://127.0.0.1:7700/api/vault/daily'
HTTP/1.1 200 OK
content-type: application/json
content-length: 13124
Date: Tue, 18 Aug 2026 19:28:42 GMT
```

So `/api/vault` **is** mounted and serving; `/api/vault/file` is absent from it. That is the whole of
requirement A1's root cause and it needs no further derivation.

**One thing a later task must not trust.** Every response above carries

```
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
```

from the blanket CORS middleware — including the `OPTIONS` preflight on the missing path, which
answers `204 No Content` rather than a 404:

```
$ curl -si -X OPTIONS 'http://127.0.0.1:7700/api/vault/file'
HTTP/1.1 204 No Content
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
```

**That header advertises a `PUT` this API does not implement, on a path that does not exist.** A
browser or an agent that probes capability by preflight will be told the write path is available. It
is not. Capability must be decided by the route table, never by the CORS header.

No `PUT` was sent to the live API — per the brief, and because the 404 above already settles it.

---

## (b) COUNTS — today's payload, verbatim

One read-only `GET`, `2026-08-18T19:28:33Z`:

```
$ curl -s http://127.0.0.1:7700/api/memory/counts
{"all":482,"rule":0,"pref":0,"fact":2,"person":0,"project":0,"note":480}
```

`00-vision.md §2.3` records, from the same live endpoint earlier the same day:

```json
{"all":482,"rule":0,"pref":0,"fact":2,"person":0,"project":0,"note":480}
```

**No drift. The payload is byte-identical, field for field**, including field order. The complaint
reproduces exactly as recorded, and both defects §2.3 names are still live:

1. **`all: 482` is not a vault number** — it is 284 real vault files plus 198 agent-authored briefs
   written by Hermes fleet workers via `POST /knowledge`, whose `vault_path` is (in the code's own
   words at `db/memory.ts:69`) "a self-declared label, not a path that exists on disk". The API *can*
   separate them — `?source=vault` returns `all: 284` — and the surface does not say which it shows.
   A number with no unit is how this fleet has been bitten repeatedly.
2. **Five of six category chips are structurally incapable of being non-zero.** `inferCategory()`
   (`db/memory.ts:132`) matches frontmatter tags named exactly `rule`, `pref`/`preference`, `person`,
   `project`, `fact`/`reference`. The vault's actual most-common tags are `recurring`, `wasted-lease`,
   `inbox_triage`, `gmail`, `mcp`, `oauth-scope`, and only 65 of 284 notes carry any tag at all. So
   `note: 480` absorbs everything by default.

**This is Konrad's "it's zero and not eight".** It is the category chips, not the total.

---

## (c) INDEX — cited, not re-run

**The reconciliation was NOT re-run for this document, by instruction.** `00-vision.md §2.1` records
every figure together with the command that produced it, on 2026-08-18 against the live system. That
table is the citation:

| Fact | Value | How measured (`00-vision.md §2.1`) |
|---|---|---|
| `.md` files under `/opt/obsidian-vault` **including** `.trash` | **326** | `find /opt/obsidian-vault -name '*.md' \| wc -l` |
| `.md` files **excluding** dot-directories — the real vault | **284** | `find … -not -path '*/.*'` |
| `.md` files inside `.trash` | **42** | difference, confirmed by directory breakdown |
| `hcp.knowledge_note` rows written by `vault-sync` | **284** | `SELECT created_by, count(*) … GROUP BY 1` |
| `hcp.knowledge_note` rows written by Hermes workers | **198** | same query (`hcp-worker-01/02/03`) |
| `hcp.knowledge_note` total | **482** | `SELECT count(*)` |
| `content_forge.knowledge_embeddings` distinct `source_path` | **259** | `SELECT count(DISTINCT source_path)` |
| `content_forge.knowledge_embeddings` chunk rows | **2,131** | `SELECT count(*)` |
| `content_forge.knowledge_triples` | **0** | `SELECT count(*)` |

The arithmetic that produced the brief's premise: `326 − 259 = 67`. The left term counts files on disk
including `.trash`; the right counts rows in a *different database*, written by a process in a
*different repository*. **67 is the difference between two populations that were never comparable.**

The honest comparison, 284 real files against two separate indexes:

- **`hcp.knowledge_note`** — written by `syncVaultNotes()` (`forge-control/src/db/memory.ts:225`),
  driven by `src/lib/vault-sync-tick.ts` every 5 minutes. **284 of 284. It skips nothing.** It also
  prunes (`DELETE … WHERE created_by = 'vault-sync' AND NOT (vault_path = ANY(...))`,
  `db/memory.ts:281`), which is why the registry is clean.
- **`content_forge.knowledge_embeddings`** — written by `/opt/knowledge-mcp/km-indexer.js`, outside
  this repo, on no tick. 259 files. The shortfall, with no residue:

  | Cause | Count | Evidence (`00-vision.md §2.1`) |
  |---|---|---|
  | `.excalidraw.md` drawings, excluded deliberately | **15** | `km-indexer.js:29` — `EXCLUDED_EXTENSIONS = ['.excalidraw.md']` |
  | Zero-byte files (`Untitled.md`, `Help from Harry.md`, `Research - Political Content Mechanics.md`, …) | **10** | `stat -c%s` = 0 on each |
  | `brand guidelines.md` — 57 bytes, frontmatter only, empty body | **1** | `cat -A` shows `---\ntags:\n…` and nothing else |
  | **Total** | **26** | 284 − 259 = 25, plus one stale row (below) |

- **One stale row runs the other way:** `Coach/log.md` has embedding rows and the file is gone from
  disk. `km-indexer.js` never prunes.

**Consequences for later tasks in this phase and beyond:**

1. **No task re-runs an indexer.** There is nothing to re-index. A "fix" here would move no file from
   unindexed to indexed, and declaring victory after re-running it would be a fabricated win.
2. **A4 is satisfied by explanation, not by repair.** The deliverable is
   `GET /api/memory/index-health` (S6) reporting `disk=284`, both index counts, and every discrepancy
   carrying a `reason` — with `unexplained_count` as the headline. Today that headline is **0**.
3. **The prune asymmetry is the only real defect in this area** — one index prunes, the other never
   does — and requirement R14 makes prune explicit-only.

---

## What this document does not cover

Deliberately out of scope for B1d, and reproduced by the phase that fixes each: the Obsidian-URI
handler (phase 2), the font (phase 2), the 3D graph render (phase 2), the four placeholder surfaces
(phase 3), connections (phase 4), businesses and pipeline (phase 5), the projects-lag measurement and
the 124 reminders (phase 6). `03-quality.md §1.5` maps each complaint to the reproduction that must
exist before its first edit.
