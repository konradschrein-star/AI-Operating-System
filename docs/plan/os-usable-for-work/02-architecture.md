# 02 — Architecture: os-usable-for-work

Every design below answers the four questions this fleet requires of any design:
**what owns state · what dispatches work · what happens on failure · how does Konrad see it broke.**

Recommendations come first, reasoning second, rejected alternatives one line each.

---

## 0. The three decisions that shape everything else

### 0.1 No new route files. Extend the existing ones.

**Recommendation:** every new endpoint in this project is added to an **existing** route file.
`src/index.ts` is not modified by any phase.

**Why.** `forge-control/src/index.ts` mounts 40 routers (`:146`–`:215`). It is the one file every lane
would otherwise need to touch, and five workstreams editing it concurrently in five isolated worktrees
guarantees an integration conflict on a file where a conflict is meaningless — nobody disagrees about
anything, they just all appended a line. Because the existing route files are already lane-shaped, the
contention disappears for free:

| Lane | Existing route file it extends | Endpoints added |
|---|---|---|
| `vault` | `routes/vault.ts`, `routes/memory.ts` | file read/write, index-health, counts envelope, graph source |
| `connections` | `routes/accounts.ts`, `routes/integrations.ts` | account add/switch, google persistence, agy, github |
| `business` | `routes/pipeline.ts` | stall/worker/queue enrichment |
| `perf` | `routes/reminders.ts` | grouping/retention query params |
| `surfaces` | — (no API needed) | none |

**Rejected:** a new `routes/vault-edit.ts` + `index.ts` mount — cleaner namespacing, guaranteed merge
conflict on the one file all five lanes would touch.

### 0.2 One shared authenticated-browser harness, built once in phase 1.

**Recommendation:** phase 1 builds and commits the harness; phases 2–6 consume it.

**Why.** Five lanes each need to screenshot an authenticated UI. Five lanes independently discovering
the OAuth wall is five wasted rounds, and the failure mode is silent: an agent screenshots `/signin`,
sees an empty surface, and reports a **working** feature as dead. That is the exact class of error this
project exists to eliminate, so it must not be introduced by the project's own instruments.

The harness, per the recipe already proven in this repo since phase 500
(`docs/plan/artifacts/phase1871/README.md:306`, consumed by `scripts/checks/gates-808.sh:22`):

```
1. read AUTH_SECRET from /opt/forge-ai-os/forge-control-web/.env.local   (a READ of the live
   checkout — permitted; the file is never written)
2. build + `next start` from THIS worktree on a spare port (7780+lane)
3. mint the cookie:
     node -e 'import("next-auth/jwt").then(async m=>console.log(await m.encode({
       token:{name:"os-usable",email:"check@localhost",sub:"check"},
       secret:process.env.AUTH_SECRET, salt:"authjs.session-token", maxAge:14400})))'
4. drive headless Chrome with Cookie: authjs.session-token=<that>
5. assert on arrival that the URL is NOT /signin — a hard error, not a warning
```

Step 5 is the whole point. **Every browser task must assert it is past the wall before it believes
anything it sees.** A harness that silently screenshots the login page is worse than no harness.

#### THERE ARE TWO SALTS. Using the wrong one fails as a 307 that looks exactly like an expired token.

The recipe above salts with `authjs.session-token`, which is correct **only** for the throwaway
`next start` on a spare port, because that harness runs `AUTH_URL=http://…`. It is **rejected by
production**.

Production `AUTH_URL` is `https://os.schreinercontentsystems.com`, so auth.js v5 uses secure cookies:
the session cookie is named `__Secure-authjs.session-token` **and in auth.js v5 the cookie name is also
the JWE salt**. This applies to `http://127.0.0.1:7701` too — the port is not what decides it, the
running server's `AUTH_URL` is. So any task reproducing against the **live** UI needs the other salt:

```js
// PRODUCTION / :7701 / the https host — mint AND name the cookie with the __Secure- prefix
await encode({ token: {...}, secret: process.env.AUTH_SECRET,
               salt: "__Secure-authjs.session-token", maxAge: 60*300 })
// hand to Playwright/CDP as:
{ name: "__Secure-authjs.session-token", domain: "127.0.0.1", secure: true }
// `secure: false` with a __Secure- prefixed name is rejected by CDP with
//   Protocol error (Storage.setCookies): Invalid cookie fields
```

| Target | `AUTH_URL` | salt **and** cookie name | `secure` |
|---|---|---|---|
| throwaway `next start` from this worktree | `http://127.0.0.1:<spare>` | `authjs.session-token` | `false` |
| live UI (`:7701`, the https host) | `https://os.schreiner…` | `__Secure-authjs.session-token` | `true` |

**Why this is called out here rather than left to be discovered:** the failure is a `307 → /signin`,
which is indistinguishable from "your token expired" — and my own step-5 assertion reports it as *"the
cookie did not take"*, steering the next agent toward `AUTH_SECRET` and `maxAge` instead of the salt.
It has now cost this fleet at least two rounds (`docs/plan/artifacts/phase900/verification-904.md:366`;
`docs/plan/operator-visibility/artifacts/phase1860/03-acceptance.md:40`, where all four plausible
cookie names returned 307 with the wrong salt and 200 with the right one).

**So the step-5 assertion must name the salt as the first suspect:**

```js
if (/\/signin\b/.test(page.url())) {
  throw new Error(`auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret: ` +
    `an https AUTH_URL needs salt AND cookie name "__Secure-authjs.session-token" with secure:true; ` +
    `a plain http harness needs "authjs.session-token". A wrong salt is a 307 that looks expired.`);
}
```

Phases 5, 6 and 7 are the likely victims — Pipeline reproduction, the Projects-lag measurement and the
deploy verification all want real data at real scale, which is the live UI.

**Rejected:** a persistent logged-in Chrome profile via noVNC takeover — durable, but needs Konrad's
hands once and blocks five lanes until he provides them. I stood one up, proved the wall, then tore it
down when I found the cookie recipe.
**Rejected:** disabling `middleware.ts` in the worktree build — smallest change, but the thing under
test is then not the thing that ships.

### 0.3 File ownership is the concurrency design.

Two workstreams are isolated directories that **may write the same file at once**, and the conflict
surfaces only at integration. So ownership is assigned up front and is exclusive:

| File / directory | Owner | Never touched by |
|---|---|---|
| `forge-control/src/lib/vault.ts` | `vault` | all others |
| `forge-control/src/routes/vault.ts` | `vault` | all others |
| `forge-control/src/db/memory.ts` | `vault` | all others |
| `forge-control/src/routes/memory.ts` | `vault` | all others |
| `forge-control-web/app/desktop/MemorySurface.tsx` | `vault` | all others |
| `forge-control-web/app/desktop/MemoryGraph3D.tsx` | `vault` | all others |
| `forge-control-web/app/desktop/DesktopApp.tsx` | **`surfaces`** | all others |
| `forge-control-web/app/desktop/nav-items.ts` | **`surfaces`** | all others |
| `forge-control/src/routes/accounts.ts`, `integrations.ts` | `connections` | all others |
| `forge-control-web/app/desktop/settings/**` | `connections` | all others |
| `forge-control/src/routes/pipeline.ts`, `src/db/pipeline.ts` | `business` | all others |
| `forge-control-web/app/desktop/{BusinessesSurface,PipelineSurface,MoneySurface}.tsx`, `businesses-inventory.ts` | `business` | all others |
| `forge-control/src/routes/reminders.ts`, `src/db/reminders.ts` | `perf` | all others |
| `forge-control-web/app/desktop/ProjectsSurface.tsx` | `perf` | all others |
| `forge-control-web/app/api.ts` | **contended — see below** | |
| `forge-control/src/index.ts` | **nobody** (§0.1) | everyone |
| `forge-control/src/executor.ts` | **nobody** | everyone |

**`app/api.ts` is the one genuine cross-lane file.** Every lane adds client functions to it. Options
considered: (a) five lanes append to it and integration resolves five conflicts in one file — cheap
conflicts, but conflicts; (b) each lane creates `app/api-<lane>.ts` and `api.ts` is never touched.

**Recommendation: (b).** Each lane owns `forge-control-web/app/api-<lane>.ts` — `api-vault.ts`,
`api-connections.ts`, `api-business.ts`, `api-perf.ts` — importing shared helpers from `api.ts` without
modifying it. It costs one file per lane and removes the last contended file in the project. The
`surfaces` lane needs no API client at all.

**Rejected:** one lane "owns" `api.ts` and the others queue behind it — reintroduces the serialisation
that workstreams exist to remove.

---

## 1. Lane 1 — the vault write path

### 1.1 What owns state

**The filesystem at `/opt/obsidian-vault` is the sole source of truth for note content.** Postgres holds
*indexes* of it, never the content of record. That is already true and this project must not change it:
LiveSync propagates the vault to Konrad's devices, so a note whose truth lived in Postgres would
diverge from the copy on his laptop within minutes.

Three derived stores, each with exactly one writer:

| Store | Writer | Cadence | Prunes? |
|---|---|---|---|
| `/opt/obsidian-vault/**.md` | Obsidian, LiveSync, agents, **and now the OS write path** | on demand | never |
| `hcp.knowledge_note` | `syncVaultNotes()` in `db/memory.ts:225`, driven by `lib/vault-sync-tick.ts` | 5 min | **yes** — deletes `vault-sync` rows whose file vanished |
| `content_forge.knowledge_embeddings` | `/opt/knowledge-mcp/km-indexer.js` — **outside this repo** | manual/unknown | **no** — hence the stale `Coach/log.md` row |
| `/opt/ai-os/vault-snapshots/**` | the new write path only | on every PUT | never (retention is a later decision) |

### 1.2 The write path

```
  GET /api/vault/file?path=Daily/2026-08-18.md
      → { path, content, sha256, mtime_ms, bytes }

  PUT /api/vault/file
      { path, content, base_sha256 }

      resolveInVault(path)            ← REUSED from lib/vault.ts, not reimplemented
        ├─ dot segment?      → 400
        ├─ escapes vault?    → 400
        └─ not *.md?         → 400
      content empty/blank?            → 400        (R7)
      read current bytes → sha256
        └─ ≠ base_sha256   → 409 { current_sha256, current_content }   NOTHING WRITTEN
      snapshot current bytes → /opt/ai-os/vault-snapshots/<date>/<flat>.<epoch>.md
        └─ snapshot failed  → 500                  NOTHING WRITTEN     (R5)
      write <file>.tmp-<pid> → fsync → rename over <file>              (R6)
      → 200 { path, sha256, bytes, snapshot }
```

**The core architectural move: the append-only contract becomes an *undo* contract.**

The existing header in `lib/vault.ts` says the module "can never delete or truncate a note; worst case
it appends a duplicate line". That guarantee is what made the vault safe to hand to autonomous agents,
and the brief is explicit that it must be extended, not discarded. Editing necessarily gives up
"content is never removed". What replaces it must be **at least as strong an operational guarantee**,
and it is: *no content this API ever removes is unrecoverable.* Three mechanisms enforce it —

1. **Snapshot-before-write, and the snapshot is load-bearing.** If the snapshot fails, the write does
   not happen (R5). A best-effort backup is not a guarantee, it is a hope with a directory.
2. **Empty writes are refused outright** (R7). The realistic catastrophe is not a malicious delete; it
   is a UI bug, a dropped fetch body, or an agent serialising `undefined`, sending `""`, and erasing a
   year of thinking. That specific accident is now a 400.
3. **No delete verb exists at all** (R8). Not disabled — absent.

Snapshots live **outside** the vault because `resolveInVault()` rejects dot-segments, so a
`.forge-backups/` inside the vault would be unreachable by the module's own guard, and a non-dot folder
inside the vault would show up in Obsidian's file tree, in search, in the graph, and in
`syncVaultNotes()`'s 284-file scan. Backups that pollute the thing they protect are not backups.

**Naming:** `/opt/ai-os/vault-snapshots/<YYYY-MM-DD>/<path with / → __>.<epoch-ms>.md`. Flat, sorted by
date, greppable, and recoverable with `cp`. No index, no database, no manifest — a restore path that
needs a working database is a restore path that fails exactly when you need it.

**Concurrency.** Single-process Node, so the read-compare-snapshot-write sequence is not interleaved
with another request *in this process* — but agents write to the vault from other processes entirely.
The `base_sha256` compare-and-swap is therefore the real serialisation mechanism, and there is a
residual window between the compare and the rename. Accepted, explicitly: closing it needs a lock file,
a lock file needs a stale-lock policy, and a stale-lock policy on a vault that LiveSync also writes is
a larger system than the problem. The snapshot makes the worst case recoverable, which is the right
trade for a single-operator system. **This is written down so a reviewer does not "discover" it as a
defect.**

**Rejected:** `PATCH` with a JSON-patch or diff body — smaller payloads, but it makes the client
responsible for constructing a valid patch and turns every client bug into a corrupted note.
**Rejected:** mtime-based conflict detection — cheaper than hashing, but LiveSync touches mtimes
without changing content, producing false conflicts that train Konrad to click through them.
**Rejected:** git-backed vault with commits per edit — real history for free, but it puts a `.git` in a
LiveSync-replicated directory, which is a synchronisation disaster with a good reputation.

### 1.3 Interfaces

```ts
// forge-control/src/lib/vault.ts  — EXTENDED, existing exports unchanged
export async function readVaultFile(rel: string):
  Promise<{ path: string; content: string; sha256: string; mtimeMs: number; bytes: number }>;

export async function writeVaultFile(input: { path: string; content: string; baseSha256: string }):
  Promise<{ path: string; sha256: string; bytes: number; snapshot: string }>;
// throws VaultConflictError { currentSha256, currentContent } → 409
// throws VaultRefusedError  { reason }                        → 400

export function obsidianUri(input: { vaultName: string; vaultRelativePath: string }): string;
```

`obsidianUri` percent-encodes with `encodeURIComponent` on **each component**, not `encodeURI` on the
whole. `encodeURI` leaves `&`, `#` and `?` intact, and the vault contains
`AI OS/Specs/Directory + Business Plan Hub — Business Model.md` — a `+`, an em dash, and spaces in one
path. Getting this wrong produces a link that opens the wrong note or no note, silently, which is the
project's signature failure mode.

The vault name is `OBSIDIAN_VAULT_NAME`, defaulting to `basename(OBSIDIAN_VAULT_DIR)` = `obsidian-vault`.
It is **configuration and not a guess** because Obsidian derives the vault name from the folder name on
*Konrad's* machine, and the vault is LiveSync-replicated — the folder there may well be called something
else. The UI displays the name it is using, so a wrong one is diagnosable in one glance instead of
presenting as "the button does nothing".

### 1.4 Index health — the reconciliation model

```ts
interface IndexHealth {
  measured_at: string;
  disk: { md_files: number; excluded_trash: number };
  registry: { vault_sync_rows: number; agent_rows: number };   // hcp.knowledge_note
  embeddings: { files: number; chunks: number };               // content_forge.knowledge_embeddings
  discrepancies: Array<{
    path: string;
    in_disk: boolean; in_registry: boolean; in_embeddings: boolean;
    reason: "excluded_extension" | "empty_file" | "frontmatter_only"
          | "stale_row_file_missing" | "unexplained";
    detail: string;                    // e.g. "0 bytes", "km-indexer.js:29 EXCLUDED_EXTENSIONS"
  }>;
  unexplained_count: number;           // the headline. Today it is 0.
}
```

`unexplained_count` is the number that matters. Today's vault yields
`excluded_extension: 15, empty_file: 10, frontmatter_only: 1, stale_row_file_missing: 1,
unexplained: 0` — and the classifier **derives** those, never hardcodes them, so tomorrow's genuinely
unindexed note lands in `unexplained` and is visible the same day.

**How Konrad sees it broke:** one number on the memory surface. `unexplained: 0` is silent;
`unexplained: 7` is loud. That is the entire mechanism, and it is the difference between a gap that
"returns tomorrow" and a gap that announces itself.

**Failure modes.** Two databases on two ports (`hcp` and `content_forge` on 5432; `ai_os` on **5434**).
If either query fails, `index-health` returns **5xx with the message** — it never returns partial
counts, because a partial reconciliation reads as a real gap and would send someone hunting a phantom
for an afternoon. This is N1 in its most consequential form.

**Prune is explicit.** `POST /api/memory/index-health/prune` removes embedding rows for files that no
longer exist. It is never called by a tick, never on read, never on startup. An index that deletes its
own rows on a schedule is one bad mount away from deleting all of them.

### 1.5 Counts

```ts
interface MemoryCounts {
  vault_files_on_disk: number;    // 284 — find, excluding dot dirs
  vault_notes_indexed: number;    // 284 — knowledge_note WHERE created_by='vault-sync'
  agent_notes: number;            // 198 — knowledge_note WHERE created_by<>'vault-sync'
  embedded_files: number;         // 259 — DISTINCT source_path
  embedded_chunks: number;        // 2131
  excluded: { excalidraw: number; empty: number; frontmatter_only: number };
  stale_embedding_rows: number;   // 1
  measured_at: string;
  categories?: Record<string, number>;
  category_rule?: string;         // required whenever categories is present
}
```

Every field name carries its unit. The bare `all: 482` disappears — it silently unioned 284 real notes
with 198 agent briefs whose `vault_path` is, per the code's own comment at `db/memory.ts:69`, "a
self-declared label, not a path that exists on disk".

**On the category chips.** Five of six are structurally incapable of a non-zero value:
`inferCategory()` matches frontmatter tags named `rule`/`pref`/`person`/`project`/`fact`, and the
vault's real tags are `recurring`, `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope` — with
only 65 of 284 notes tagged at all. **Recommendation: delete the chips.** They are a taxonomy the vault
does not use, and a filter that always returns zero is worse than no filter because it teaches the
operator the vault is empty. If a replacement is wanted, the honest one is *folder* — `90_AI_OS` (56),
`30_YouTube` (54), `20_Coding` (49), `AI OS` (18) — which is real, derivable, needs no frontmatter, and
matches how Konrad already navigates. Whichever branch is taken, `category_rule` must state it in the
response.

**Rejected:** inferring categories with an LLM — accurate-ish, recurring cost, non-deterministic, and
unexplainable when wrong.

### 1.6 The graph

**Recommendation: `GET /api/memory/graph` reads `hcp.knowledge_note.links` — the wikilink graph.**

Measured basis: `knowledge_triples` holds **0 rows** (1,452 at the 2026-08-02 audit); the extractor
exists (`extractTriplesNextBatch()`, `db/memory.ts:888`, exposed at
`POST /api/memory/triples/extract-batch`) but is **manual-only** — its own comment says "Bulk
vault-wide cron deferred to v1.7" — so nothing has refilled it and nothing will. Meanwhile
`knowledge_note.links` already holds parsed wikilinks for **118 of 284** notes, refreshed every 5
minutes by the sync tick, at zero marginal cost.

```ts
interface KnowledgeGraph {
  source: "knowledge_note.links" | "knowledge_triples";   // NEW — always present
  nodes: Array<{ id: string; label: string; degree: number; resolved: boolean }>;
  links: Array<{ source: string; target: string; kind: "wikilink" | "triple" }>;
  counts: { notes_scanned: number; links_total: number; links_unresolved: number };
  empty_reason?: string;   // present iff nodes.length === 0
}
```

Wikilink targets are resolved against note basenames; unresolved targets become nodes marked
`resolved: false` rather than being dropped, because a dangling link is information — it is a note
Konrad meant to write.

`empty_reason` is the requirement that would have saved a week: whenever the graph is empty it names
the table it read and the row count it found. "no graph yet — index the vault" sent this defect into
the rendering lane when the rendering was never broken.

**Rejected:** scheduling the LLM extractor on a tick — restores the richer semantic graph, but adds a
recurring per-token cost over 2,131 chunks that Konrad did not ask for, on a table whose contents
already vanished once without anyone noticing. It stays available on demand as an overlay.
**Rejected:** computing the graph in the browser from the note list — no backend change, but ships all
284 notes' link arrays to the client on every view.

---

## 2. Lane 2 — the dead surfaces

**What owns state:** nothing. Goals, Journal, Map and Library have no route and no table. That is the
finding, not a gap in the recon.

**Recommendation: do not build them. Make them tell the truth, and write down what building each
would cost.**

The defect Konrad reported is "don't work quite yet" — which is what a *convincing wireframe* produces.
`PLACEHOLDER_SURFACES` (`DesktopApp.tsx:73`) renders each unbuilt surface as a tidy card with three or
four feature bullets. It looks like a feature that failed to load. It is a feature that was never
written. Those must not look the same, and the cheapest correct fix is words.

```
┌──────────────────────────────────────────────┐
│  ⚠  NOT BUILT YET                            │   ← warning treatment, not a neutral card
│                                              │
│  GOALS would show: quarter objectives, this  │   ← what it is FOR
│  week, today mirror.                         │
│                                              │
│  It needs: a goals table and /api/goals.     │   ← what it NEEDS to exist
│  Neither exists.                             │
│                                              │
│  Not scheduled by os-usable-for-work.        │   ← whether anyone is coming
└──────────────────────────────────────────────┘
```

The nav marks unbuilt entries too (R40) so the truth is visible before the click.

**Library specifically.** The determination must pick from producers that already exist rather than
invent one. Real candidates, all already built: `routes/uploads.ts` + `lib/uploads-index.ts` (agent
artefacts, screenshots, reports — the very files this project will generate), `routes/files.ts`,
`routes/media.ts`, and Google Drive via the workspace CLI. **Default recommendation: Library = the
artefact and document store** — uploads, generated reports, and Drive documents. It is the honest
complement to MEMORY, which already owns notes, and it has a live producer today. Konrad's ruling
overrides this default.

**Rejected:** building Goals/Journal/Map now — each is a real feature with a real data model, and doing
four of them inside a project about making existing surfaces honest is how a 7-phase plan becomes a
20-phase one.
**Rejected:** removing them from the nav — hides the intent and loses the roadmap they encode.

---

## 3. Lane 3 — connections

**What owns state.** Three different stores, and the split is not incidental:

| Integration | State lives in | Read via |
|---|---|---|
| Claude accounts | `ai_os.claude_accounts` on **127.0.0.1:5434** (not 5432) | `db/claude-accounts.ts` `listAccounts()` |
| Gemini API key, GitHub PAT | files at `/opt/ai-os/.secrets/store/<name>`, mode 0600 | `lib/secret-store.ts` |
| Google Workspace | an OAuth credential file **+ an in-memory check result** | `routes/integrations.ts:549` |
| `agy` / Antigravity | a CLI profile on disk under `/root` | none yet |

The `account=arved health=healthy` line resolves to `claude_accounts.health`, a **stored** column
written by `recordProbe()`/`markSuccess()`, classified by `classifyCredential()`
(`lib/account-health.ts:55`) from the credential file plus `last_ok_at`. It is not a live probe at read
time — which is correct and cheap, provided the age of the last probe is displayed. It currently is not.

**The one invariant that makes this lane worth doing:**

> **No connection renders a positive state without a `checked_at`.** A `checked_at` of `null` renders
> UNKNOWN, in amber, always.

The existing code already believes this — `account-health.ts:88` returns
`"never confirmed working — no successful run on record"` — and the surface then loses it. Google is the
clearest case: `lastGoogleCheck` is a **module-level variable** (`routes/integrations.ts:549`). It dies
on every `pm2 restart forge-control`, so after any deploy the answer to "is Google connected?" resets to
"nobody has ever asked", and the credential file still existing makes it look connected. **That is
precisely "a status that cannot distinguish connected from never checked", which the brief names as
worse than none.**

**Recommendation:** persist every probe result — `{integration, ok, detail, identity, checked_at}` —
next to the state it describes. Claude accounts already have columns for this. Google and GitHub get
a sidecar record beside their credential in the secret store, which needs no migration and no new
table. A scheduled re-check hangs off an existing tick; a `checked_at` older than 3× the interval
renders UNKNOWN rather than ageing silently into a lie.

```ts
interface ConnectionStatus {
  id: string;
  state: "connected" | "unknown" | "broken" | "absent";
  identity: string | null;       // the email/login the PROBE returned, never configuration
  checked_at: string | null;     // null ⇒ state must be "unknown"
  detail: string;                // verbatim upstream error on failure — status code and message
  action: string;                // the exact next step
}
```

`identity` comes from the probe response, never from config. Displaying a configured email as if it
were verified is the same lie in a smaller font.

**`agy` — the trap that has bitten before.** `/root/.local/bin/agy` is not on `PATH` for
non-interactive shells; `PATH` is set in `.bashrc`, which pm2 does not read. Every invocation uses one
named absolute-path constant, asserted absolute by a unit test. Its auth flow is **researched by a
scout before the UI is designed** (run `--help`, attempt a login, record the real prompts) because
building a paste-a-code affordance against an assumed flow costs a full build-review cycle.

**GitHub.** The PAT arrives through `POST /api/secrets` and never through chat or a brief. If it must
be requested, it is requested with a `forge:ui` **secret** block, whose value travels through the
secure panel and never enters the transcript. Status is verified by a real
`GET https://api.github.com/user`, showing the returned login and the `x-oauth-scopes` header. "Token
present" is storage, not authorisation.

**Rejected:** a new `integration_status` table — cleanest model, but a migration and a new store for
four rows when both existing stores already hold this shape.
**Rejected:** probing on every page load — always fresh, but four upstream calls per render and a
rate-limit incident waiting for a bad afternoon.

---

## 4. Lane 4 — businesses, pipeline, money

### 4.1 Businesses

**What owns state today:** `businesses-inventory.ts` — 322 hardcoded lines, 25 properties, status words
frozen on 2026-08-04. It is a server inventory wearing a business label.

The spine is **Konrad's to rule** (escalated in round 0: Funnel / Money / Operations / Two-deep-cards;
default **Funnel**). What the architecture fixes regardless of the ruling:

1. **Every figure is either live-probed or carries a visible as-of date.** A dot that was green in
   August must not read as green today.
2. **Directory and YouTube are primary**; the other three arms and the 25-property inventory are
   demoted. Konrad runs two businesses; five equal cards make a dormant agency look like a going
   concern.
3. **The zeroes are reported, not hidden.** 891 of 271,758 records past the enrichment gate (0.33%),
   zero outbound ever sent, Axtrelis pre-launch on 5 seed orders. A scoreboard that hides the score is
   decoration.
4. **The funnel stages match his 2026-08-04 §10 ruling** — Layer 1 only, accountants, Jersey, Ian owns
   outreach, **won = signature**, with a **Committed** stage between Proposed and Won. Modelling a
   different funnel would contradict a decision he already made and recorded.

### 4.2 Pipeline

The chain `PipelineSurface.tsx → GET /api/pipeline → db/pipeline.ts → content_forge.content_jobs` is
**already real**. The defect is expressiveness, not wiring. Live state: 5 jobs, all stalled 11–14 days
in QC, nothing in the six other phases, four pm2 workers online with 7-day uptimes.

The surface cannot currently distinguish:

- *no work* — nothing was created, the business is idle; from
- *stuck work* — work exists and has not moved in a fortnight while four workers sat idle.

Those are opposite operational facts rendering as the same empty column. Three additions:

| Addition | Source | Failure mode |
|---|---|---|
| stall age per job | `status_updated_at` vs now, threshold in config | none — arithmetic on data already fetched |
| worker health | pm2 (already used by `routes/pm2.ts`) | pm2 unreachable → render "worker health unavailable: <err>", never "all healthy" |
| queue depth | Redis/BullMQ `bull:*` keys | Redis unreachable → render "queue not reachable: <err>", never depth 0 |

Both failure modes are the same rule: **an unreachable source renders as unreachable, never as zero.**
A zero from a dead probe is how a stuck pipeline looks calm.

**Read-only, absolutely.** No task writes to `content_forge` and no task restarts a Content Forge
worker. Unstalling the QC queue is a Content Forge problem; this project's job is to make the stall
impossible to miss.

### 4.3 Money

**Recommendation: change nothing except two labels, and write the keep-cost down.**

Measured cost to keep: `routes/spend.ts` 113 + `routes/ledger.ts` 132 + `db/spend.ts` 248 +
`db/ledger.ts` 255 ≈ **750 LOC**, 2 tables (`spend_log` in `content_forge`, `ledger_entries` in
`ai_os`), **one** UI consumer (`MoneySurface.tsx`), **no scheduled writes** — `recordSpend()` fires on
billable gateway events, `addEntry()` is manual. Carrying cost is therefore close to zero: it consumes
no CPU on a timer and shows up only in typecheck and gate surface area. Removing it would destroy the
per-model cost tracking and the only honest revenue ledger.

The two labels that must change, because they are the same class of defect as everything else here:
`€0.00` means **"no ledger entries recorded"**, not "no revenue"; and the 30-day **€2,695.77** is
**shadow-priced Claude Code usage**, not cash out the door. Both currently read as measured financial
facts.

---

## 5. Lane 5 — performance and reminders

### 5.1 Projects lag — measure, then attribute, then fix

Known: 127 active/blocked tasks rendered unwindowed (`ProjectsSurface.tsx:421`, `:468`), board poll
every **6 s**, projects every **15 s**, each running task's full chat thread every **3 s** when not
live, and `listActiveTasks()` (`db/projects.ts:334`) has **no `LIMIT`**.

**These are suspects, not a diagnosis.** The chat-scroll freeze fixed on 2026-08-18 mounted 2,200 rows;
127 cards is an order of magnitude smaller, so the analogy is a hypothesis. The brief says MEASURE, and
the reason is this fleet's standing lesson: instruments lie before code does. A windowing library added
because it worked last time, against a lag actually caused by a 3-second poll storm, ships a
regression and a false conclusion in one commit.

**Procedure, fixed in advance so before and after are comparable:** authenticated browser, React
Profiler commit count and total duration across the click, `document.querySelectorAll('*').length`
before and after, and a network trace of everything the click triggers. Recorded in
`projects-lag-before.md`; the identical procedure produces `projects-lag-after.md`.

The fix must address the **named** cause. If the cause is polling, the fix is polling. If it is the
mount, the fix is windowing — and windowing must not reduce reachability: all 127 tasks stay reachable
(R75), or we have traded a slow board for a lying one.

### 5.2 Reminders

Measured: **124 rows — 104 delivered, 20 dismissed, 0 pending.** Nothing overdue, nothing undelivered,
R705 dedup in place and working. Sources: chat 115, `builder-r604` 4, research-browser 4, probes 2.

**So the diagnosis is not a delivery defect. It is a retention and presentation defect:** a 47-day
delivered history is being presented as a queue, and the two repeated watchdog clusters (4× and 3×)
make it look like a malfunction on top.

**What must not move.** `executor.ts:1524 reminderTick` → `claimDueReminders()` → `inbox_items`
(deduped on `external_id = reminder:<id>:<due_at>`) → `queueNotification()` → Telegram. This is the
**only working path to Konrad's inbox**. It is out of scope for edits, and a live end-to-end test
proves it still fires after the phase (R81).

**Policy — proposed, not imposed.** Sent as a manager report with a `forge:ui` choice block and a
stated default: show pending plus the last 7 days delivered; collapse older into a counted history
fold; render a recurring reminder as one row rather than N; per-item dismissal persists.
**Nothing is deleted** — deletion needs Konrad's explicit instruction and he has not given one. Row
count before and after phase 6 must be identical (R80).

---

## 6. Failure modes, consolidated

| # | Failure | Blast radius | Mitigation | How Konrad sees it |
|---|---|---|---|---|
| F1 | PUT overwrites an agent's concurrent write | one note's edits lost | `base_sha256` CAS → 409 with both versions | conflict UI showing both |
| F2 | PUT lands empty and erases a note | one note | 400 on blank content (R7) + snapshot (R4) | 400 in the editor, editor stays dirty |
| F3 | Crash mid-write truncates a note | one note | temp-file + `fsync` + `rename` (R6) | never occurs |
| F4 | Snapshot store unwritable, writes proceed | undo guarantee silently void | snapshot failure aborts the PUT (R5) | 500 on save |
| F5 | Path traversal / dotfile write | vault or host config | `resolveInVault()` reused, not reimplemented (R9) | 400 |
| F6 | `index-health` half-fails and reports a phantom gap | an afternoon hunting nothing | 5xx on any query failure, never partial (N1) | error, not a number |
| F7 | Prune deletes rows for a temporarily-unmounted vault | the embedding index | prune is explicit-only, never on a tick (R14) | never automatic |
| F8 | Graph renders empty with no explanation | a week in the wrong lane | `empty_reason` names table and row count (R35) | the surface says which table was empty |
| F9 | Browser task screenshots `/signin` and reports a live surface as dead | wrong diagnosis, wrong fix | harness asserts it is past the wall, hard-errors if not (§0.2) | the task fails instead of lying |
| F10 | Integration auto-merges and clobbers a lane | a whole lane's work | integration STOPS on conflict and reports files verbatim (R83) | the task reports conflicting files |
| F11 | `pnpm install --frozen-lockfile` under `NODE_ENV=production` prunes `typescript` | every gate dies with `tsc: not found` after a clean-looking install | always `--prod=false`; check for `+ typescript` not `- typescript` (R84) | the install transcript |
| F12 | `pm2 restart forge-executor` during deploy | **every run in flight, including the deploy** | forbidden; detached `safe-restart.sh` only (R87) | never occurs |
| F13 | `agy` spawned by bare name under pm2 | integration silently ENOENTs | absolute-path constant, asserted by test (R52) | verbatim spawn error |
| F14 | A probe fails and status degrades to "ok" | a lie in the one place trust is measured | no positive state without `checked_at` (R57); verbatim upstream errors (R58) | amber UNKNOWN with the error |
| F15 | Reminder delivery breaks during the surface change | **his only inbox path** | delivery path out of scope; live end-to-end test (R81) | a test reminder arrives |
| F16 | Windowing hides tasks from reachability as well as the DOM | a task nobody sees | reachable-count equality assertion (R75) | count matches |
| F17 | A lane opens a 7th workstream | 400 mid-run, phase stalls | cap documented, planners told (N6) | the 400 names the count |
| F18 | Two lanes edit `app/api.ts` | integration conflict on a file nobody disagreed about | per-lane `api-<lane>.ts` (§0.3) | never occurs |

---

## 7. Observability — how progress and breakage are visible

**During the build**, without asking anyone:

- **Kanban** — one planner per phase carries an explicit round (100…700) as a phase label, so the board
  reads "phase 4" at a glance.
- **Manager chat** (`bfd1283a-b71b-4f35-b577-7d09aad803f2`) — findings, blockers and decisions only.
  Not progress narration.
- **Phase artefacts** — `docs/plan/artifacts/os-usable-for-work/phase<N>/` holds the before/after
  screenshots, the measurement transcripts, and the gate output verbatim. Every number is accompanied
  by the command that produced it (N10), so a reviewer re-derives rather than trusts.
- **Reviewer verdicts** — one gating reviewer per phase, `VERDICT: PASS` or `VERDICT: NEEDS_FIXES`. A
  `NEEDS_FIXES` does **not** auto-seed a fix cycle; its blocker sits at HEAD into the next phase, so
  every planner checks the previous gate's verdict before planning (N9).

**After the deploy**, in the product itself — this is the part that outlives the project:

| Question | Where it is answered | Before this project |
|---|---|---|
| Is my vault fully indexed? | `unexplained_count` on the memory surface | nowhere; discovered by hand-subtracting two tables |
| Which index is this number from? | every count field names its source | nowhere; one number, two tables |
| Why is the graph empty? | `empty_reason` names the table and row count | "no graph yet — index the vault" |
| Is this surface broken or unbuilt? | the NOT BUILT banner | indistinguishable |
| Is Google actually connected? | `checked_at` beside the state | a green dot from a file's existence |
| Is the pipeline idle or stuck? | stall age, worker health, queue depth | one empty column for both |
| Did my note save? | the editor stays dirty and shows the status and message | no save path existed |

---

## 8. Technology choices

| Choice | Rationale (one line) |
|---|---|
| Extend existing route files; never touch `index.ts` | removes the only file all five lanes would edit |
| Per-lane `api-<lane>.ts` client modules | removes the last contended frontend file |
| sha256 compare-and-swap for conflicts | content-addressed, immune to LiveSync's mtime churn |
| Snapshot to disk outside the vault | recoverable with `cp`; needs no database to restore |
| temp-file + `fsync` + `rename` | atomic on the same filesystem; a crash cannot truncate |
| Wikilinks as the graph source | already computed, free, deterministic, matches Obsidian's own graph |
| Keep the LLM triple extractor manual | it exists and works; a cron over 2,131 chunks is a cost nobody asked for |
| `next-auth/jwt` minted cookie for browser tests | proven in this repo since phase 500; ships the real middleware |
| Probe result persisted beside its credential | no migration, no new table, survives restart |
| pm2 + Redis probes for pipeline health | both already used elsewhere in this codebase |
| No new tables, no migrations, anywhere in this project | a schema change is a deploy risk this project does not need |

Note the last row. **This project adds no database migration.** Every store it needs already exists.
That is deliberate: the riskiest thing a 7-phase project can do to a live single-operator system is
change its schema while five lanes are writing to it concurrently.
