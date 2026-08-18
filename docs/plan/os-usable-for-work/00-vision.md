# 00 — Vision: os-usable-for-work

**Project:** `os-usable-for-work` · project id `7851068b-32d7-469b-b42f-f5e3c1d9e83a`
**Branch:** `project/7851068b` off `main`
**Architect round:** 0 · **Date:** 2026-08-18
**Repo:** `ai-os` (forge-control API, forge-control-web Next.js UI, forge-control-mcp)

---

## 1. The goal, restated precisely

Konrad has lived inside this UI for a week. He wants to reach the point where he can say:

> "when I can actually start wiring in my companies in here and start using this to plan and code stuff outside of itself"

That sentence contains two distinct demands, and conflating them is the first way this project could fail.

**Demand A — the machine must stop lying.** Right now several surfaces show numbers whose unit is
undeclared, statuses that were true on 2026-08-04, and empty views that look identical whether the
feature is unbuilt, broken, or simply has no data today. An operator cannot delegate work to a
machine he cannot trust to report its own state. Every defect in Konrad's list is, underneath, an
instrument that reads something other than what its label claims.

**Demand B — the machine must accept input.** The vault is his second brain and the OS can only
append to it. He cannot correct a note, cannot fix a typo, cannot restructure a plan. A second brain
you can only write to and never edit is a notebook with the pen chained to the "add" button. Until
the OS has a real write path, every act of thinking has to leave the OS and happen in Obsidian —
which is exactly the "using this to plan" that he says he cannot yet do.

**This project delivers both, and nothing else.** It does not strategise about the businesses; Konrad
does that separately. It makes the machine ready to receive that strategy.

---

## 2. What we measured before planning (the ground truth)

Everything below was measured on 2026-08-18 against the live system, not recalled. Two of the
brief's own premises did not survive measurement, and the plan is built on the measurements.

### 2.1 The vault index is not broken. There are two indexes and nobody labels them.

| Fact | Value | How measured |
|---|---|---|
| `.md` files under `/opt/obsidian-vault` including `.trash` | **326** | `find /opt/obsidian-vault -name '*.md' \| wc -l` |
| `.md` files excluding dot-directories (the real vault) | **284** | `find … -not -path '*/.*'` |
| `.md` files inside `.trash` | **42** | difference, confirmed by directory breakdown |
| `hcp.knowledge_note` rows written by `vault-sync` | **284** | `SELECT created_by, count(*) … GROUP BY 1` |
| `hcp.knowledge_note` rows written by Hermes workers | **198** | same query (`hcp-worker-01/02/03`) |
| `hcp.knowledge_note` total | **482** | `SELECT count(*)` |
| `content_forge.knowledge_embeddings` distinct `source_path` | **259** | `SELECT count(DISTINCT source_path)` |
| `content_forge.knowledge_embeddings` chunk rows | **2,131** | `SELECT count(*)` |
| `content_forge.knowledge_triples` | **0** | `SELECT count(*)` |

**The "67-file gap" does not exist.** It was produced by subtracting an embeddings-table figure
(259) from a file count that included `.trash` (326). The honest comparison is 284 real files against
two separate indexes:

- **`hcp.knowledge_note`** — written by `syncVaultNotes()` in `forge-control/src/db/memory.ts:225`,
  driven by `src/lib/vault-sync-tick.ts` every 5 minutes. It holds **284 of 284 files. Coverage is
  100%. It skips nothing.** Requirement A4's premise — that `vault-sync-tick.ts` skipped 67 files —
  is false and must not be "fixed".
- **`content_forge.knowledge_embeddings`** — written by `/opt/knowledge-mcp/km-indexer.js`, a process
  that lives outside this repo entirely. It covers 259 files. Its 26-file shortfall decomposes with
  no residue:

  | Cause | Count | Evidence |
  |---|---|---|
  | `.excalidraw.md` drawings, excluded deliberately | **15** | `km-indexer.js:29` — `EXCLUDED_EXTENSIONS = ['.excalidraw.md']` |
  | Zero-byte files (`Untitled.md`, `Help from Harry.md`, `Research - Political Content Mechanics.md`, …) | **10** | `stat -c%s` = 0 on each |
  | `brand guidelines.md` — 57 bytes, frontmatter only, empty body | **1** | `cat -A` shows `---\ntags:\n…` and nothing else |
  | **Total** | **26** | 284 − 259 = 25, plus one stale row (below) |

  Every one of those exclusions is *correct behaviour*. There is **no note with content that failed
  to index.** The real content gap is zero files.

- **One stale row exists in the other direction:** `Coach/log.md` has embedding rows but the file is
  gone from disk. `km-indexer.js` never prunes. `syncVaultNotes()` does prune (`DELETE … WHERE
  created_by = 'vault-sync' AND NOT (vault_path = ANY(...))`, `db/memory.ts:281`), which is why the
  registry is clean and the embeddings are not.

**The actual defect is architectural, and it is a labelling defect:** two indexes, in two databases,
with two owners — one inside this repo on a tick, one outside it with no tick — and not one surface
in the product tells you which of them a number came from. That is what this project fixes. Re-running
an indexer would fix nothing, because nothing is broken; the gap would "return tomorrow" only in the
sense that it never left, because it was never a gap.

### 2.2 The 3D graph is empty because its table is empty.

`GET /api/memory/graph` returns `{"nodes":[],"links":[],"triples":0}` right now, live.
`knowledgeGraph()` (`db/memory.ts:1341`) selects from `content_forge.knowledge_triples`, which holds
**0 rows**. The 2026-08-02 database-split audit recorded **1,452 rows** in that same table
(`docs/superpowers/specs/2026-08-02-ai-os-db-split-plan.md:44`). It was emptied between then and now,
and **nothing refills it**: no extractor runs on any tick, in this repo or outside it. `scripts/triple-status.sh`
and `scripts/triple-coverage.sh` are read-only reporters, not producers.

The rendering side is fine. `3d-force-graph@^1.77.0` and `three@^0.185.0` are both declared in
`forge-control-web/package.json` and the component's empty state (`MemoryGraph3D.tsx:167`) already
says "no graph yet — index the vault". It is telling the truth and being ignored.

Meanwhile a real graph already exists and is unused: `knowledge_note.links` holds parsed wikilinks
for **118 of the 284** vault notes, populated on every sync tick by `extractWikilinks()`.

### 2.3 "It's zero and not eight" is the category chips.

Live `GET /api/memory/counts`:

```json
{"all":482,"rule":0,"pref":0,"fact":2,"person":0,"project":0,"note":480}
```

Two independent defects share one payload:

1. **`all: 482` is not a vault number.** It is 284 real vault files plus 198 agent-authored briefs
   written by Hermes fleet workers via `POST /knowledge` — rows whose `vault_path` is, in the code's
   own words, "a self-declared label, not a path that exists on disk" (`db/memory.ts:69`). The API
   *can* separate them (`?source=vault` returns `all: 284`) and the surface does not say which it is
   showing.
2. **Every category is zero because `inferCategory()` looks for words the vault does not use.** It
   matches frontmatter tags named exactly `rule`, `pref`/`preference`, `person`, `project`,
   `fact`/`reference` (`db/memory.ts:132`). The vault's actual most-common tags are `recurring`,
   `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope`. Only 65 of 284 vault notes carry any
   tags at all. So five of six chips are structurally incapable of showing a non-zero number, and the
   sixth (`note: 480`) absorbs everything by default.

### 2.4 Goals, Journal, Map, Library are unbuilt, and the UI does not say so.

All four are entries in `NAV` (`forge-control-web/app/desktop/nav-items.ts:78`) that render
`PlaceholderSurface` from a hardcoded `PLACEHOLDER_SURFACES` record (`DesktopApp.tsx:73`, rendered at
`:477`). No `/api/goals`, `/api/journal`, `/api/map`, `/api/library` route exists. No table backs any
of them. Each renders a tidy wireframe of three or four feature bullets — which is precisely why
Konrad reads them as "don't work quite yet" rather than "not written yet". **A convincing wireframe is
a lie told in CSS.**

### 2.5 Pipeline is wired to real data, and the real data is stuck.

`PipelineSurface.tsx` → `GET /api/pipeline` → `db/pipeline.ts` → `content_forge.content_jobs`. That
chain is genuine. The live state: **5 jobs, all of them stalled 11–14 days in QC** (3
`AWAITING_UPLOADER`, 2 `AWAITING_QC`), and **zero** jobs in idea, script, voice, assets, render or
publish. The pm2 workers (`worker-orchestrator`, `worker-render`, `worker-video-stitch`,
`claude-pool`) are all online with 7-day uptimes.

So the surface is not disconnected — it is *insufficiently expressive*. It cannot distinguish "this
business has no work today" from "this business has work that has not moved in a fortnight while four
workers sat idle". Those are opposite operational facts and they render identically.

### 2.6 Reminders: 124 rows, and none of them are pending.

| Status | Count |
|---|---|
| delivered | 104 |
| dismissed | 20 |
| **pending** | **0** |

Span 2026-07-02 → 2026-08-18 (47 days). Sources: `chat` 115, `builder-r604` 4, `research-browser:*` 4,
one each from two probe rounds. The most-repeated texts are watchdog auto-unwedge notices (4× and 3×).

Nothing is overdue, nothing is undelivered, and the R705 dedup fix is in place and working. **The
complaint is not that reminders are broken — it is that a delivered-and-read history of 124 items is
being presented as if it were a to-do list.** That reframing changes the fix entirely: this is a
surface and retention problem, not a delivery problem, and the delivery path
(`executor.ts:1524 reminderTick` → `inbox_items` + Telegram) must not be touched.

### 2.7 Projects tab: 127 unwindowed cards, three polling loops.

17 projects (11 active), 514 `project_tasks` of which **127 are active/blocked**.
`ProjectsSurface.tsx` renders all 127 as `TaskCard` components with no virtualisation
(`:421`, `:468`), refetches the board every **6 s**, projects every **15 s**, and each running task's
full chat thread every **3 s** when not live. `listActiveTasks()` (`db/projects.ts:334`) has no
`LIMIT`.

This is *plausible* as the cause of click lag and is **not yet proven**. The chat-scroll freeze fixed
on 2026-08-18 had a 2,200-row mount; 127 cards is an order of magnitude smaller. The plan therefore
requires a measurement (React commit count + DOM node count across the click) **before** anyone
touches a line of `ProjectsSurface.tsx`.

### 2.8 The UI is behind GitHub OAuth — and this repo already knows how to get past it.

`forge-control-web/middleware.ts` redirects every unauthenticated request to `/signin`. An agent that
naively points a browser at the OS will screenshot a sign-in page and may report a working surface as
a dead one. I reproduced exactly that (screenshot: `20260818T185028Z-os-ui-first-open.png`).

The established solution is already in the repo and has been used since phase 500: mint an
`authjs.session-token` JWT with `next-auth/jwt`'s `encode()` against the `AUTH_SECRET` in
`/opt/forge-ai-os/forge-control-web/.env.local`, start a throwaway `next start` **from the worktree**
on a spare port, and drive headless Chrome with that cookie. `scripts/checks/gates-808.sh:22` consumes
it as `FORGE_SESSION_COOKIE`; the recipe is recorded verbatim at
`docs/plan/artifacts/phase1871/README.md:306`. This is worktree-compliant — it *reads* the live env
file and never edits the live checkout.

---

## 3. Definition of done

The project is done when **all** of the following are true and demonstrated by artefacts committed
under `docs/plan/artifacts/`:

1. **Konrad can open a vault note in the OS, change a word, save it, and see the change on disk** —
   and if an agent wrote to that file while he was typing, he is shown the conflict rather than
   silently overwriting it or being silently overwritten.
2. **Every number on the memory surface carries a unit and a source.** No bare integer survives.
   "284 vault files · 259 embedded · 198 agent notes" is acceptable; "482" is not.
3. **The index gap is permanently visible and permanently explained** via an endpoint that
   reconciles disk against both indexes and classifies every discrepancy by reason.
4. **The 3D graph renders Konrad's actual wikilink graph**, or states in plain words which data
   source it wanted and why that source is empty. It never renders empty without an explanation.
5. **No surface in the product renders a wireframe of a feature that does not exist.** Goals,
   Journal, Map and Library each either work or say "not built yet" in words a tired operator reads
   correctly at 23:00.
6. **Every connection in settings shows a state derived from a timestamped probe** — Claude accounts,
   Google Workspace, Gemini/`agy`, GitHub. "Never checked" is a distinct, visible state from
   "connected". No optimistic green.
7. **The Businesses tab shows the spine Konrad ruled on**, sourced from live data rather than a
   322-line hardcoded inventory frozen on 2026-08-04.
8. **Pipeline distinguishes "no work" from "stuck work"** and surfaces stall age, worker health and
   queue depth.
9. **The Projects click lag is measured, attributed, fixed, and the fix proven by re-running the same
   measurement.**
10. **A reminders retention/grouping policy is ruled on by Konrad and implemented**, with the
    delivery path proven intact and **not one reminder deleted**.
11. **The Money tab is untouched and its keep-cost is documented.**
12. **The deploy proves itself**: a `BUILD_ID` that moved, referenced in served HTML.

---

## 4. Measurable success criteria

| # | Criterion | Measurement | Pass |
|---|---|---|---|
| S1 | Vault round-trip | `GET` a note, `PUT` it changed, `GET` again | byte-identical to what was PUT |
| S2 | Conflict detection | `PUT` with a stale `base_sha256` | HTTP 409, body carries current content + sha, **file unchanged on disk** |
| S3 | No destructive write | `PUT` with empty body | HTTP 400, file unchanged |
| S4 | Undo exists | after any `PUT` | prior content readable from the snapshot store |
| S5 | Counts labelled | scrape the rendered memory surface | zero numeric strings without an adjacent unit |
| S6 | Index reconciliation | `GET /api/memory/index-health` | `disk=284`, both index counts, and every discrepancy carries a `reason` |
| S7 | Graph non-empty | `GET /api/memory/graph` | `nodes ≥ 100` from wikilinks, and a `source` field naming its table |
| S8 | Honest placeholders | screenshot each of Goals/Journal/Map/Library | the words "not built" (or equivalent) visible without scrolling |
| S9 | Probe-backed status | `GET` each connection status | every one carries `checked_at`; `null` renders as UNKNOWN, never green |
| S10 | Pipeline expressiveness | `GET /api/pipeline` with the current stuck data | the 5 QC jobs are flagged stalled with an age in days |
| S11 | Projects lag | React commits + DOM nodes across a tab click, before vs after | after ≤ 50% of before on the dominant metric, or a written explanation of why the metric was the wrong one |
| S12 | Reminders intact | count rows before and after phase 6 | **identical**; delivery tick still fires |
| S13 | Gates | `bash scripts/checks/gates-808.sh --strict` | no NEW red vs the pre-project baseline |
| S14 | Deploy proven | served HTML at the live host | contains a `BUILD_ID` different from the pre-deploy one |

---

## 5. Explicit non-goals

These are **out of scope** and a task that drifts into one is failing, not over-delivering.

1. **Business strategy.** Konrad strategises about the directory and YouTube businesses separately.
   This project builds the surface that will display that strategy; it does not choose it.
2. **Rebuilding the LLM triple extractor.** `knowledge_triples` is empty and refilling it means an
   LLM pass over 2,131 chunks with a recurring cost. The wikilink graph is free, deterministic, and
   already computed. Triples may return later as an *overlay*; they are not this project's problem.
3. **Fixing `/opt/knowledge-mcp/km-indexer.js`.** It lives outside this repo. This project *reports*
   on its coverage and prunes what it leaves stale; it does not adopt it.
4. **Unstalling the Content Forge QC queue.** Pipeline must *show* that 5 jobs have been stuck for
   two weeks. Making them move is a Content Forge task, not an AI OS task.
5. **The Money tab.** Report its keep-cost, correct any dishonest label, invest nothing, delete
   nothing.
6. **Deleting reminders.** Requires Konrad's explicit instruction, which has not been given. The
   plan may hide, group, collapse and archive. It may not delete.
7. **A general-purpose Obsidian client.** The write path is read-edit-save on one note at a time. No
   folder operations, no renames, no moves, no deletions, no bulk edits.
8. **Redesigning surfaces Konrad did not complain about** — Today, Inbox, Chat, Skills, Live,
   Control, Autonomy, Automation, Canvas. Touching them is scope theft.
9. **Authentication changes.** The GitHub OAuth wall stays exactly as it is. We mint test cookies; we
   do not weaken the door.
10. **`/opt/forge-ai-os`.** The live checkout is read-only to every task in this project except the
    single briefed deploy task in phase 7.

---

## 6. The one thing that decides whether this project succeeds

Every defect in Konrad's list is an instrument that reads something other than what its label claims.
The vault count reads two tables and names neither. The graph reads a table nobody fills. The chips
read tags nobody writes. The placeholders read as features. The status dots read as verified. The
reminders list reads as a queue. Pipeline reads silence as calm.

So the governing rule for every phase is not "make it work" — it is **make it say what it is**. A
surface that honestly reports "not built" has satisfied this project. A surface that renders a
plausible number nobody can trace has failed it, no matter how good it looks.

See `01-requirements.md` for the numbered, testable form of all of the above.
