# AI OS database isolation — implementation plan

**Date:** 2026-08-02
**Status:** plan only. Nothing in this document has been executed. All investigation was read-only.
**Scope:** move the AI OS (`forge-control`, `forge-control-web`, `/opt/forge-ai-os`) off
`content_forge` (docker postgres :5432) onto `ai_os` (host postgres :5434), and remove the
`content_forge` connection entirely.
**Supersedes:** §12 of `docs/superpowers/specs/2026-08-02-claude-account-health-failover-design.md`,
which this plan corrects in four material ways (see §1).

---

## 0. TL;DR

Eight phases. The data is trivial (~2,400 rows). The work is in the 142 query sites, the
19 independently-constructed connection pools, five cross-boundary reads, two FKs into
Content Forge, one extension that does not exist on the target server, and two writer
processes outside `forge-control` that nobody has counted yet.

The single hardest blocker is **pgvector**: `knowledge_embeddings.embedding` is
`halfvec(1024)`, `halfvec` requires pgvector ≥ 0.7.0, and the host postgres on :5434 has
0.6.0 with no newer version available from the configured apt sources. This must be resolved
before Phase 5 or the knowledge cluster cannot move.

---

## 1. Corrections to the design spec (§12)

| Spec claim | Verified reality |
|---|---|
| "15 AI-OS tables" | **18.** The spec omits `guardrail_trips` (6 rows), `mentor_metrics` (2), `tg_state` (1). |
| "Move the leaf tables nobody joins across: `guardrail_rules`, `cron_schedules`, `webhooks`, `fleet_state`, `notifications`, `reminders`" | `cron_schedules.last_run_id` and `webhooks.last_run_id` both carry **FKs into `runs`**. They are not leaves. `guardrail_rules` has `guardrail_trips` hanging off it. |
| "`content_jobs` is the only legitimate cross-system read" | **Three** CF tables are read: `content_jobs`, `channels`, `content_templates`. |
| "Two databases, two servers" | **Three.** `forge-control` also holds a live connection to the `hcp` database (docker :5432), which is not in the spec's scope at all. |

---

## 2. Verified inventory

### 2.1 AI-OS-owned tables in `content_forge` (18 tables, 2,414 rows)

| table | rows | | table | rows |
|---|---|---|---|---|
| knowledge_triples | 1452 | | guardrail_rules | 9 |
| knowledge_embeddings | 212 | | guardrail_trips | 6 |
| runs | 196 | | cron_schedules | 4 |
| spend_log | 169 * | | projects | 4 |
| notifications | 154 | | mentor_metrics | 2 |
| decisions | 63 | | fleet_state | 1 |
| inbox_items | 58 | | tg_state | 1 |
| reminders | 48 | | connector_configs | 0 |
| project_tasks | 37 | | webhooks | 0 |

\* `spend_log` was 167 at the start of this investigation and 169 twenty minutes later. The
fleet is writing live. This is the reason every move needs a freeze, not a "quiet moment".

Plus, in a **third** database (`hcp`, docker :5432): `knowledge_note` (466 rows) and
`agent_message` (1,484 rows). Both are read and written by `forge-control`. See §2.4.

### 2.2 Connection layer — there is no shared client module

19 separate `new Pool(...)` constructions across 17 files. Each one independently reads
`process.env.DATABASE_URL` (or `HCP_DATABASE_URL`) and each one carries its own **hardcoded
production fallback string** `postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge`.

Consequence: changing `DATABASE_URL` in pm2 does **not** guarantee a file stops talking to
`content_forge` — every file's literal default must be removed too, or a missing env var
silently reconnects to the old database. This is the single most dangerous property of the
current code and Phase 0 exists to fix it before anything moves.

| file | pools | query sites |
|---|---|---|
| `forge-control/src/db/projects.ts` | 1 | 26 |
| `forge-control/src/db/ai_os.ts` | 2 (cf + hcp) | 17 |
| `forge-control/src/db/memory.ts` | 2 (cf + hcp) | 16 |
| `forge-control/src/executor.ts` | 2 (cf + hcp) | 13 |
| `forge-control/src/db/runs.ts` | 1 | 13 |
| `forge-control/src/db/webhooks.ts` | 1 | 9 |
| `forge-control/src/db/reminders.ts` | 1 | 9 |
| `forge-control/src/db/cron.ts` | 1 | 8 |
| `forge-control/src/db/autonomy.ts` | 1 | 8 |
| `forge-control/src/db/spend.ts` | 1 | 6 |
| `forge-control/src/db/notifications.ts` | 1 | 5 |
| `forge-control/src/db/forge.ts` | 1 | 5 |
| `forge-control/src/routes/agents.ts` | 1 | 4 |
| `forge-control/src/routes/search.ts` | 1 | 4 |
| `forge-control/src/db/mentor.ts` | 1 | 2 |
| `forge-control/src/db/pipeline.ts` | 1 | 1 |
| **total** | **19** | **142** |

`forge-control/src/db/hermes.ts` uses better-sqlite3 against `/opt/hermes-control/control.db`
(read-only) — not postgres, out of scope. `forge-control/src/db/skills.ts` is filesystem-only.

**`forge-control-web` does not open any postgres connection.** Verified: no `pg` import
anywhere under `forge-control-web`. It talks to `forge-control` over HTTP. Its pm2 env
nevertheless carries `DATABASE_URL` and `HCP_DATABASE_URL` — dead config that should be
deleted so it cannot become load-bearing later.

### 2.3 Table → file map (query sites, excluding migrations)

```
knowledge_triples      db/memory.ts (5), web/desktop/MemoryGraph3D.tsx (1, display only)
knowledge_embeddings   db/memory.ts (6)
runs                   db/runs.ts (16), executor.ts (13), routes/agents.ts (5),
                       routes/usage.ts (1), routes/search.ts (1), routes/chat.ts (via db/runs),
                       lib/cc-runner.ts (1), db/projects.ts (1)
spend_log              db/spend.ts (6), executor.ts (1)
notifications          db/notifications.ts (4)
decisions              db/ai_os.ts (3), routes/search.ts (1)
inbox_items            executor.ts (4), db/ai_os.ts (3), routes/search.ts (1),
                       routes/reminders.ts (1), db/reminders.ts (1)
reminders              db/reminders.ts (6)
project_tasks          db/projects.ts (15)
projects               db/projects.ts (8)
guardrail_rules        db/autonomy.ts (5), executor.ts (1)
guardrail_trips        db/autonomy.ts (3)
cron_schedules         db/cron.ts (9)
fleet_state            db/ai_os.ts (3), executor.ts (1), db/autonomy.ts (1)
webhooks               db/webhooks.ts (9)
mentor_metrics         db/mentor.ts (4)
tg_state               db/notifications.ts (2)
connector_configs      (none — table is dead code, 0 rows, no reader)
```

### 2.4 The `hcp` database — undocumented third connection

`HCP_DATABASE_URL=postgresql://…@127.0.0.1:5432/hcp` is set in pm2 for `forge-control`,
`forge-executor` and (uselessly) `forge-control-web`. Live usage:

- `db/memory.ts` — `knowledge_note` (466 rows): INSERT, DELETE, 3× SELECT. This is **half the
  memory system**; the other half (`knowledge_embeddings`, `knowledge_triples`) is in
  `content_forge`. The knowledge graph is already split across two databases today.
- `executor.ts:1141` — `SELECT … FROM agent_message` (Hermes escalation mirroring).
- `db/ai_os.ts:573,628` — SELECT + INSERT on `agent_message` (inbox reply path).

`inbox_items.external_id` is populated on 57 of 58 rows with `hcp:<agent_message_id>` values,
so the inbox is soft-coupled to `hcp.agent_message`.

Hermes was removed on 2026-07-29 (`project-hermes-removal-2026-07-29`), so `agent_message`
is a dead upstream that is still being polled. **Decision required (see §9 risk R7):** either
move `knowledge_note` into `ai_os` and delete the `agent_message` code paths, or keep the
`hcp` connection. This plan assumes the former; if Konrad wants `agent_message` kept, the
`hcp` pool survives the split and the "one database" goal is not met.

---

## 3. Cross-boundary reads (AI OS → Content Forge)

Five call sites across four files. All must be gone before Phase 8.

| # | site | reads | replacement |
|---|---|---|---|
| 1 | `db/forge.ts:60,71,84` — `listActiveJobs`, `listRecentJobs`, status rollup | `content_jobs` (22 columns) | `GET /api/v1/jobs` — **needs field extension**, see §3.1 |
| 2 | `db/forge.ts:97` — `getJob` | `content_jobs` (`SELECT *`) | `GET /api/v1/jobs/:id` — already returns the full row |
| 3 | `db/pipeline.ts:129-131` — pipeline board | `content_jobs` **JOIN `channels` JOIN `content_templates`** | needs a new CF endpoint or a widened `/api/v1/jobs` returning `channel_name`/`template_name` |
| 4 | `db/ai_os.ts:305-306` — `getInboxPreview` | `inbox_items` **LEFT JOIN `content_jobs` LEFT JOIN `channels`** | genuine cross-DB join; must be decomposed into local query + HTTP fetch |
| 5 | `db/ai_os.ts:443` — `getJobChannelId` (used by `routes/media.ts` to build on-disk paths) | `content_jobs.channel_id` | `GET /api/v1/jobs/:id` |
| 6 | `routes/search.ts:93` — global search | `content_jobs.title ILIKE` | `GET /api/v1/jobs` + client-side filter, or drop the jobs facet |
| 7 | `db/ai_os.ts:733-734` — today's shipped/pipeline counters | 2× `count(*) FROM content_jobs` | needs a CF counts endpoint, or derive from `/api/v1/jobs` |

Mitigating fact: **site 4's join can never match today.** `inbox_items.related_job_id` is
NULL on all 58 rows and `decisions.related_job_id` is NULL on all 63 rows (verified). The
LEFT JOINs are permanently returning NULL job columns. The code path still has to work, but
no data is lost by cutting it.

`routes/search.ts` is easy despite appearances: it is four **separate parallel queries**, not
a UNION. Only the `content_jobs` one moves.

### 3.1 Content Forge API readiness

`/api/v1` already exists, is exempted in `hub-web`'s deny-by-default middleware allow-list,
and authenticates via `Authorization: Bearer ${CF_API_TOKEN}` (`api/v1/_lib/auth.ts`).
`CF_API_TOKEN` **is** set in `/opt/content-forge/.env` (verified present, value not read).

Existing endpoints: `/api/v1/jobs`, `/api/v1/jobs/:id`, `/api/v1/channels`, `/api/v1/formats`.

Gap: `packages/cf-api/src/jobs/list.ts::listJobs` selects only **8 columns**
(`id, title, status, format, channel_id, created_at, updated_at, status_updated_at`).
`db/forge.ts` needs 22 (render timings, `published_at`, `views`, `youtube_video_id`, VA
assignments, file sizes) and `db/pipeline.ts` additionally needs `channels.name` and
`content_templates.name`. **There is no `/api/v1/templates` endpoint at all.**

So Phase 7 is not purely an AI-OS change — it requires a widening of `listJobs` in the
Content Forge repo. That is a separate PR in a separate repo and should be sequenced first.

---

## 4. Foreign keys across the split boundary

Queried from `pg_constraint` in `content_forge`. Nine FKs involve AI-OS tables:

**Cross-boundary (AI-OS → Content Forge) — must be dropped:**

```
decisions.related_job_id    → content_jobs(id) ON DELETE SET NULL   [decisions_related_job_id_fkey]
inbox_items.related_job_id  → content_jobs(id) ON DELETE SET NULL   [inbox_items_related_job_id_fkey]
```

Resolution: **drop both constraints; keep both columns as unconstrained `uuid`.** Justified
because (a) a cross-database FK is impossible in postgres, and (b) both columns are 100% NULL
across all 121 rows, so nothing is orphaned. After the split they become soft references
resolved through `/api/v1/jobs/:id`, and the resolving code must tolerate a 404 (job deleted
in CF) — that is the price of the split and must be handled explicitly, not by swallowing.

**No FK points from a Content Forge table into an AI-OS table.** Verified — the reverse
direction is clean.

**Intra-AI-OS FKs — dictate move ordering:**

```
guardrail_trips.rule_id   → guardrail_rules(id)  ON DELETE CASCADE
decisions.inbox_item_id   → inbox_items(id)      ON DELETE SET NULL
project_tasks.project_id  → projects(id)         ON DELETE CASCADE
project_tasks.run_id      → runs(id)             ON DELETE SET NULL
cron_schedules.last_run_id→ runs(id)             ON DELETE SET NULL
webhooks.last_run_id      → runs(id)             ON DELETE SET NULL
runs.parent_run_id        → runs(id)             ON DELETE SET NULL   (self)
```

Population: `cron_schedules.last_run_id` 4/4 non-null, `project_tasks.run_id` 34/37,
`project_tasks.project_id` 37/37, `runs.parent_run_id` 30/196, `webhooks` 0 rows.

**Soft references (no FK):** `spend_log.job_id uuid` — 0 of 169 rows populated, matches
neither `runs` nor `content_jobs`. Harmless; carry the column across as-is.
`inbox_items.related_worker_id` — 0 of 58 populated. `inbox_items.external_id` — 57 of 58
populated with `hcp:` prefixes (see §2.4).

**Consequence for sequencing:** `cron_schedules` and `webhooks` cannot move before `runs`
without dropping their FK to `runs`. This plan moves them **with** the runs cluster rather
than dropping a real constraint. The spec's "leaf" phase shrinks accordingly.

---

## 5. Schema drift: `ai_os.runs` vs `content_forge.runs`

Column-by-column comparison (`information_schema.columns`):

- Columns 1–16 are **identical** in name, type, nullability and default.
- `ai_os.runs` is **missing column 17: `archived boolean NOT NULL DEFAULT false`**, added by
  `db/migrations/0031_runs_archived.sql`. The stub predates that migration.

The stub is 0 rows and orphaned. Do not patch it — **drop it** (Phase 0) and recreate `runs`
from the live `content_forge` DDL so no drift can survive. The same applies to the other four
stub tables:

- `ai_os.guardrail_rules` has 9 rows and `content_forge.guardrail_rules` has 9 rows. They are
  copies from the 2026-07-29 `hcp` → `ai_os` rename and have diverged in unknown ways. The
  live rows are the ones in `content_forge` (the executor reads `agent.spawn_cap` from there).
- `ai_os.fleet_state` says `running / 2026-06-18 / updated_by=migration-0021`;
  `content_forge.fleet_state` says `running / 2026-07-09 / updated_by=konrad`. The live one is
  in `content_forge`. Confirmed divergence.
- `ai_os.guardrail_trips` 0 rows vs live 6; `ai_os.connector_configs` 0 vs live 0.

**All five stub tables get dropped in Phase 0.** They are decoys, and `guardrail_rules` in
particular would silently serve stale spawn-cap config if left in place.

---

## 6. Environment, extensions, tooling, backups

### 6.1 Server comparison

| | `content_forge` | `ai_os` |
|---|---|---|
| host | docker `content-forge-postgres` | host postgres |
| port | 127.0.0.1:5432 | 127.0.0.1:5434 |
| version | 16.13 | 16.14 (Ubuntu) |
| datadir | docker volume | `/var/lib/postgresql/16/main` |
| extensions installed | `plpgsql`, `uuid-ossp 1.1`, `vector 0.7.4` | `plpgsql` only |
| extensions available | — | `vector 0.6.0`, `pgcrypto 1.3`, `uuid-ossp 1.1`, `pg_trgm 1.6` |
| `wal_level` / `archive_mode` | not checked | `replica` / **off** |

`gen_random_uuid()` is a PG13+ builtin, so no `pgcrypto` install is needed for the uuid
defaults. `uuid-ossp` is installed in `content_forge` but no AI-OS table default uses it —
all use `gen_random_uuid()`.

### 6.2 pgvector — HARD BLOCKER for Phase 5

```
content_forge.knowledge_embeddings.embedding  halfvec(1024)
index knowledge_embeddings_hnsw  hnsw (embedding halfvec_cosine_ops) m=16 ef_construction=64
```

`halfvec`, `halfvec_cosine_ops` and halfvec HNSW were introduced in **pgvector 0.7.0**.
The host has `postgresql-16-pgvector 0.6.0-1` from `mirror.hetzner.com/ubuntu noble/universe`,
and **that is also the apt candidate** — no newer version is reachable. No PGDG apt source is
configured on this box (verified: nothing matching `pgdg`/`apt.postgresql.org` under
`/etc/apt/`). `CREATE EXTENSION vector` on `ai_os` today yields 0.6.0, and
`CREATE TABLE … halfvec(1024)` will fail with "type halfvec does not exist".

`halfvec` is not incidental — it is used in the query path in four places:
`db/memory.ts:536,539` (`embedding <=> $1::halfvec`), `/opt/knowledge-mcp/km-server.js:79,82`
and `km-indexer.js:123` (`$5::halfvec(1024)`).

Two options, decide before Phase 5:

- **A (preferred): upgrade pgvector on the host to ≥ 0.7.** Add the PGDG apt repo (ships
  0.8.x for pg16) or build from source. Keeps the schema and all query text identical, keeps
  the 2-byte-per-dimension storage. Cost: touching a shared host postgres that also serves
  `veo` and `scs` databases — requires a restart of the host postgres cluster, which affects
  those two other systems. Must be scheduled.
- **B (fallback): convert to `vector(1024)`** and rebuild the HNSW index with
  `vector_cosine_ops`. 212 rows × 1024 dims × 2 extra bytes ≈ 430 KB more — irrelevant at
  this size. Cost: every `::halfvec` cast in `memory.ts` **and in the out-of-repo
  `/opt/knowledge-mcp/*.js`** must change in lockstep, and recall changes very slightly.

Whichever is chosen, it is a Phase 5 prerequisite, not a Phase 5 step.

### 6.3 Migration tooling — there is none

`/opt/forge-ai-os/db/migrations/` holds 12 hand-written `.sql` files (`0021_ai_os_tables.sql`
… `0032_task_tiers.sql`). There is:

- no root `package.json` in `/opt/forge-ai-os`,
- no migration runner script anywhere in `scripts/` (which holds only MCP/bench/smoke shell
  scripts),
- no `migrate` entry in `forge-control/package.json` (`dev`, `start`, `executor`,
  `typecheck` only),
- no migrations table in either database,
- no reference to `db/migrations` anywhere in `docs/` or the READMEs.

Migrations are applied **by hand via `psql`**, and there is no record of which have been
applied. Consistent with the house rule that drizzle-kit generate is broken in this stack and
migrations are hand-written.

**Plan consequence:** keep the hand-written convention (do not introduce a migration
framework as part of this work — that is scope creep on a risky change), but **do** add a
`schema_migrations(version text primary key, applied_at timestamptz default now())` table to
`ai_os` in Phase 0 and insert a row for each file applied. Without it there is no way to tell
whether a phase actually ran on a given database. This is 6 lines of SQL and it is the
difference between a revertable plan and a hopeful one.

Numbering: new files continue at `0033_…`. Files `0021`–`0032` describe tables that will be
**created fresh in `ai_os`**; do not attempt to replay them (they encode intermediate states
and reference `content_forge` objects). Phase DDL should be generated from the live
`content_forge` DDL via `pg_dump --schema-only -t <table>`, reviewed by hand, and committed
as new numbered files.

### 6.4 Backups — none for either database

Searched crontabs, `/etc/cron.d`, `/etc/cron.daily`, `/etc/systemd/system`, and systemd timers.

- **No postgres backup exists for `ai_os` (:5434).** `archive_mode = off`, `wal_level = replica`,
  no pgbackrest / barman / wal-g / pg_dump timer.
- **No postgres backup exists for `content_forge` (docker :5432).** Same sweep, nothing.
- The only backup-ish cron entry is `#0 3 * * * /opt/content-forge/scripts/backup-media.sh` —
  **commented out**, and it backs up media files, not the database.
- `veo-fleet-backup.timer` runs nightly but backs up the VEO FLEET **sqlite** orchestrator DB.
- The only postgres dumps on disk are one-off manual artefacts from 2026-07-29:
  `/root/backups/aios-db-2026-07-29/content_forge-5434.dump`,
  `/root/backups/hermes-2026-07-29/hcp.dump`,
  `/root/backups/2026-07-29-deploy/content_forge-FULL-pre-deploy.dump`. Nothing since.

**Stated plainly: no automated database backup mechanism was found for either server.**
Moving the knowledge graph (1,452 triples + 212 embeddings, the accumulated memory of the
system) onto an unbacked database is the largest non-technical risk in this plan. Phase 0
must install a nightly `pg_dump` for `ai_os` before Phase 5, and this is non-negotiable per
the spec's own §12.5.

### 6.5 Live writers outside `forge-control` — the ones nobody counted

The freeze (`POST /api/fleet/freeze` → `fleet_state.status = 'paused'`) is honoured by:
`executor.ts:902` (holds the run queue), `lib/cron-tick.ts:81`, `lib/project-tick.ts:279`,
`lib/telegram-bridge.ts:285`. It is **not** honoured by:

1. **`/opt/knowledge-mcp/km-indexer.js`** — pm2 process `knowledge-indexer-watch`, **online**.
   Watches `/opt/obsidian-vault` and does `DELETE FROM knowledge_embeddings` +
   `INSERT INTO knowledge_embeddings` against a **hardcoded** connection string
   (`km-indexer.js:18`, no env override) plus `hcp` for `knowledge_note` (line 19).
   It is a full second writer of the knowledge cluster and it is outside the AI OS repo.
   `/opt/knowledge-mcp/km-server.js` is a matching reader.
   **This process must be stopped for Phase 5 and its two hardcoded URLs edited.**
2. **`lib/vault-sync-tick.ts`** — calls `syncVaultNotes()` in `db/memory.ts`, which writes
   `knowledge_note` and reads embeddings. No fleet_state check anywhere in the file.
3. **`lib/telegram-bridge.ts`** — the `/on` and `/off` commands deliberately bypass the freeze
   (lines 269-272), and the bridge writes `tg_state.last_update_id` on every poll regardless.
   Sending a Telegram message during a `tg_state` cutover will lose or replay updates.
4. **`lib/memory-prefetch.ts`** — reads `knowledge_embeddings`/`knowledge_triples`; no freeze
   check (read-only, so lower risk).

Also note `/opt/ai-os/workspace/projects/4056b6b1-7f06-4f66-a8e3-0bea8f42da0c/forge-control/`
— a **full second checkout of the repo** inside the AI OS agent workspace, containing its own
copies of every file in §2.3. It is a scratch working copy, not a running service, but a
grep-based audit that includes it will double-count, and an agent editing it will not affect
production. Exclude it from all sweeps; do not edit it.

### 6.6 Deploy surface

Two pm2 processes run the API and executor from `/opt/forge-ai-os/forge-control` via
`tsx` **directly from `src/`** (no build step): `forge-control` (`src/index.ts`, port 7700)
and `forge-executor` (`src/executor.ts`). Both take env from
`forge-control/ecosystem.config.cjs`, which **hardcodes** `DATABASE_URL` and
`HCP_DATABASE_URL` in the `env` block. `forge-control-web` has its own ecosystem file and
carries the same two vars pointlessly.

Because `tsx` runs from source, a "deploy" is `pm2 restart` — no build, no artefact. That
makes each phase genuinely fast to revert (`git checkout` the file, `pm2 restart`), which
this plan leans on. Remember pm2 pins env in `dump.pm2`: after editing an ecosystem file,
restart with `--update-env` or `pm2 delete` + `pm2 start ecosystem.config.cjs`, otherwise the
old `DATABASE_URL` survives (house rule: `feedback-pm2-env-staleness-and-global-keys`).

VPS repo state at time of writing: branch `main`, clean working tree, HEAD `ba0644b`. The
spec's §10.1 warning about 2,852 uncommitted insertions is **stale** — that work is now
committed as `2ffc597` and `ba0644b`. Backups from that session exist at
`/opt/backups/forge-ai-os-worktree-20260802-112426.tar.gz` and the matching git bundle.

---

## 7. The plan

Every phase is independently deployable and revertable. Phases 1–4 and 6 need no freeze.
Phase 5 needs the indexer stopped. Phase 6 needs a full fleet freeze.

### Phase 0 — Prerequisites (no data moves, no behaviour change)

**Goal:** make the rest of the plan safe and observable.

1. **Take a full dump of both databases.**
   ```
   docker exec content-forge-postgres pg_dump -U postgres -Fc content_forge \
     > /root/backups/split-2026-08-02/content_forge-pre-split.dump
   docker exec content-forge-postgres pg_dump -U postgres -Fc hcp \
     > /root/backups/split-2026-08-02/hcp-pre-split.dump
   sudo -u postgres pg_dump -p 5434 -Fc ai_os \
     > /root/backups/split-2026-08-02/ai_os-pre-split.dump
   ```
2. **Install a nightly `pg_dump` for `ai_os`** (systemd timer or `/etc/cron.d`), retaining 14
   days, writing to `/root/backups/ai_os/`. Verify by running the unit once and restoring the
   dump into a throwaway `ai_os_restoretest` database. Do not proceed to Phase 5 until a
   restore has actually been performed once.
3. **Drop the five orphaned stub tables in `ai_os`** (`runs`, `fleet_state`, `guardrail_rules`,
   `guardrail_trips`, `connector_configs`). They are decoys with drifted content (§5).
   Take the dump in step 1 first.
4. **Create `ai_os.schema_migrations`** and a `forge` role/credentials for the AI OS to use
   (do not reuse the `postgres` superuser; the 2026-07-28 compromise is recent enough to
   matter). Grant only what is needed on the `public` schema of `ai_os`.
5. **Introduce a single connection module** `forge-control/src/db/pool.ts` exporting
   `aiOsPool` and (temporarily) `cfPool`, both reading env with **no hardcoded fallback** —
   throw on missing env instead. Refactor all 19 `new Pool(...)` sites to import from it.
   *This is a pure refactor; no query changes, no table moves.* Every later phase becomes a
   one-line import swap instead of a pool-construction edit, and the throw-on-missing-env
   makes a misconfigured pm2 fail loudly rather than silently reconnecting to `content_forge`.
6. Decide and execute the **pgvector resolution** (§6.2 option A or B). If option A, schedule
   the host postgres restart — it also serves `veo` and `scs`.

**Verify:**
```sql
-- stubs gone
\c ai_os
SELECT tablename FROM pg_tables WHERE schemaname='public';   -- expect: schema_migrations only
-- vector ready (option A)
SELECT extversion FROM pg_extension WHERE extname='vector';  -- expect >= 0.7.0
SELECT '[0.1,0.2]'::halfvec;                                  -- must not error
```
```bash
grep -rn "content_forge_prod" /opt/forge-ai-os/forge-control/src   # expect: no matches
grep -rc "new Pool(" /opt/forge-ai-os/forge-control/src            # expect: only db/pool.ts
```
**Rollback:** `git checkout` the refactor; `pm2 restart forge-control forge-executor
--update-env`. Dropping the `ai_os` stubs is not reverted (they were orphaned and dumped).

---

### Phase 1 — Pilot: `claude_accounts` in `ai_os`

**Goal:** prove the second connection end to end with a table that has no history and no
consumer yet. This is the §4.1 table from the account-health design.

1. Write `db/migrations/0033_claude_accounts.sql` — create the table **in `ai_os` only**.
   Apply by hand with `psql -p 5434 -d ai_os -f …`; record it in `schema_migrations`.
2. Add `AI_OS_DATABASE_URL` to both ecosystem files
   (`postgresql://forge:…@127.0.0.1:5434/ai_os`) and wire `aiOsPool` to it.
3. Write `db/accounts.ts` using `aiOsPool` exclusively. Seed the known accounts.
4. Restart with `--update-env`.

**Verify:**
```sql
\c ai_os
SELECT count(*) FROM claude_accounts;               -- expect: seeded count
```
```bash
curl -s localhost:7700/api/accounts | head          -- returns the seeded rows
# and prove it is NOT reading content_forge:
docker exec content-forge-postgres psql -U postgres -d content_forge \
  -c "select to_regclass('public.claude_accounts')"  # expect: NULL
```
**Rollback:** revert `db/accounts.ts` + route registration, `pm2 restart`. `DROP TABLE
claude_accounts` in `ai_os`. Zero blast radius — nothing else reads it.

---

### Phase 2 — True leaves, no FKs, low write rate

**Tables:** `guardrail_rules` + `guardrail_trips` (move as a pair — FK), `mentor_metrics`,
`connector_configs` (or drop it: 0 rows, no reader — recommend **drop**, do not migrate dead
schema).

Note `guardrail_rules` is read by `executor.ts` for the `agent.spawn_cap` concurrency limit on
every tick, so a brief inconsistency degrades to the safety default rather than "unlimited"
(verified in `executor.ts` comments) — acceptable without a freeze, but do this phase during
a quiet window anyway.

Per-table procedure (the **standard move procedure**, referenced by later phases):

1. `pg_dump --schema-only -t <table>` from `content_forge`, hand-review, commit as a numbered
   migration, apply to `ai_os`.
2. `pg_dump --data-only --column-inserts -t <table>` from `content_forge`, pipe into
   `psql -p 5434 -d ai_os`. (Network copy between two servers — no `dblink`, no cross-DB
   transaction. At these row counts, seconds.)
3. Compare row counts and a checksum on both sides (see verify block).
4. Switch the module's pool import from `cfPool` to `aiOsPool` (one line, thanks to Phase 0).
5. `pm2 restart forge-control forge-executor --update-env`.
6. **Leave the `content_forge` copy in place**, renamed to `<table>_migrated_20260802` only
   after the phase has been observed healthy for 24h. Do not drop in the same window — the
   rename is the revert point and the drop is a separate, later cleanup.

**Verify:**
```sql
-- run against both, expect identical output
SELECT count(*), md5(string_agg(t::text, '|' ORDER BY t::text)) FROM guardrail_rules t;
SELECT count(*), md5(string_agg(t::text, '|' ORDER BY t::text)) FROM guardrail_trips t;
SELECT count(*), md5(string_agg(t::text, '|' ORDER BY t::text)) FROM mentor_metrics t;
```
```bash
curl -s localhost:7700/api/autonomy | jq '.rules | length'   # matches ai_os count
pm2 logs forge-executor --lines 50 --nostream | grep -i 'spawn_cap\|guardrail'
```
**Rollback:** revert the import line, `pm2 restart`. The `content_forge` copy is still live
and still current (nothing wrote to `ai_os` yet except through the switched module — replay
any deltas by re-dumping the `ai_os` table back, or accept the loss for these tables, which
are config not history).

---

### Phase 3 — Notification / reminder leaves

**Tables:** `notifications` (154), `reminders` (48), `tg_state` (1), `spend_log` (169).

None has an FK. `spend_log.job_id` is a soft column, 0/169 populated — carry it as
unconstrained `uuid`.

`tg_state` needs care despite being one row: `telegram-bridge.ts` writes
`last_update_id` on every Telegram poll and **ignores the freeze**. Stop the bridge for the
90 seconds this takes, or accept one duplicate/dropped Telegram update. Recommend: send no
Telegram messages during this phase and move `tg_state` last within it.

Files touched: `db/notifications.ts` (5 sites), `db/reminders.ts` (9), `db/spend.ts` (6),
`executor.ts` (1 spend site).

Watch out: `routes/reminders.ts` and `db/reminders.ts` each touch `inbox_items`, which is
**not** moving until Phase 6. Audit those two sites — if a reminders query joins
`inbox_items`, that join must be split before the reminders module changes pool. This is the
most likely place for a silent Phase-3 break.

**Verify:** row-count + md5 per table as in Phase 2, plus:
```bash
curl -s localhost:7700/api/reminders | jq 'length'
curl -s localhost:7700/api/spend/today | jq
# Telegram round trip: send /status to the bot, confirm exactly one reply
```
**Rollback:** revert imports, `pm2 restart`. `notifications` and `reminders` accumulate rows
in `ai_os` after the switch — to revert cleanly, dump the delta back into `content_forge`
before flipping the imports back.

---

### Phase 4 — `cron_schedules` FK decoupling (prep for Phase 6)

`cron_schedules` and `webhooks` cannot move before `runs` because of their FKs into it. Two
choices: (a) move them **with** the runs cluster in Phase 6, or (b) drop the FK now and move
them early.

**Recommendation: (a).** `cron_schedules.last_run_id` is populated 4/4 and is a real
referential relationship; dropping the constraint to gain a phase boundary trades a
correctness guarantee for scheduling convenience. `webhooks` has 0 rows and could go either
way — keep it with `runs` for symmetry.

So Phase 4 is **not a data move**. It is:

1. Audit and split every query that joins across the future boundary but has not yet been
   caught: re-run the sweep in §2.3 against the current tree and diff against this document.
2. Split `routes/search.ts` — move the `content_jobs` branch behind a feature-flagged HTTP
   call (flag default off, so behaviour is unchanged), leaving `inbox_items`, `runs`,
   `decisions` on the local pool.
3. Split `db/ai_os.ts::getInboxPreview` into (i) a local `inbox_items` query and (ii) an
   optional job fetch, still hitting the DB behind the same flag. Because
   `related_job_id` is NULL on all 58 rows, this is provably a no-op today.

**Verify:**
```bash
curl -s 'localhost:7700/api/search?q=test' | jq 'keys'    # still 4 facets
curl -s localhost:7700/api/inbox | jq '.[0]'              # preview shell unchanged
```
```sql
-- prove the join is vacuous, i.e. the refactor cannot regress anything
SELECT count(*) FROM inbox_items WHERE related_job_id IS NOT NULL;  -- expect 0
SELECT count(*) FROM decisions   WHERE related_job_id IS NOT NULL;  -- expect 0
```
**Rollback:** pure code revert; no schema change.

---

### Phase 5 — Knowledge cluster (`knowledge_embeddings` + `knowledge_triples` + `knowledge_note`)

**Prerequisites:** Phase 0 step 2 (verified restore) and step 6 (pgvector) both done.

This phase is larger than the spec allows for, because the cluster spans three databases
today: triples and embeddings in `content_forge`, notes in `hcp`. Move **all three**, or the
split does not remove the `hcp` connection and §12.4 step 7 becomes impossible.

1. `pm2 stop knowledge-indexer-watch`. Confirm no writes:
   `SELECT max(indexed_at) FROM knowledge_embeddings;` twice, 60s apart, identical.
2. Freeze the fleet (`POST /api/fleet/freeze`) — `vault-sync-tick` does not honour it, so also
   confirm no `knowledge_note` writes for 60s, or temporarily disable the tick.
3. Standard move procedure for `knowledge_embeddings` (with the HNSW index recreated **after**
   the data load — building it on an empty table then inserting is slower and gives a worse
   graph), `knowledge_triples` (6 indexes + 1 unique + 1 CHECK constraint on `category`), and
   `knowledge_note` from `hcp`.
4. Update `db/memory.ts` — both its pools collapse to `aiOsPool`. 16 query sites.
5. Update `/opt/knowledge-mcp/km-indexer.js` line 18/19 and `km-server.js` — **out-of-repo,
   hardcoded, and easy to forget.** If option B was chosen in §6.2, also change every
   `::halfvec` cast in these two files and in `memory.ts`.
6. `pm2 restart forge-control forge-executor knowledge-indexer-watch --update-env`, unfreeze.

**Verify:**
```sql
\c ai_os
SELECT count(*) FROM knowledge_triples;      -- expect 1452 (+ any produced while frozen: 0)
SELECT count(*) FROM knowledge_embeddings;   -- expect 212
SELECT count(*) FROM knowledge_note;         -- expect 466
SELECT count(*) FROM knowledge_embeddings WHERE embedding IS NULL;  -- expect same as source
SELECT indexname FROM pg_indexes WHERE tablename='knowledge_embeddings';  -- hnsw present
```
```bash
# semantic search must return hits, not an empty array — an empty array is what a
# silently-broken vector index looks like
curl -s 'localhost:7700/api/memory/search?q=stealth+uploader' | jq '.hits | length'
# touch a vault file and confirm the indexer re-indexes into ai_os, not content_forge
```
```sql
-- the trap: prove nothing is still writing to the old copy
\c content_forge
SELECT max(indexed_at) FROM knowledge_embeddings;   -- must stop advancing
```
**Rollback:** `pm2 stop knowledge-indexer-watch`, revert `memory.ts` and the two
`/opt/knowledge-mcp` files, `pm2 restart`. The `content_forge` copies are untouched and
current as of the freeze. Vault edits made after cutover must be re-indexed (the indexer will
do that on its own from the on-disk vault, which is the source of truth — this cluster is the
easiest to rebuild and the worst to lose).

---

### Phase 6 — Runs / projects cluster, fleet frozen

**Tables:** `runs` (196), `projects` (4), `project_tasks` (37), `decisions` (63),
`inbox_items` (58), `cron_schedules` (4), `webhooks` (0).

Largest blast radius: `executor.ts` (13 sites), `db/runs.ts` (13), `db/projects.ts` (26),
`db/ai_os.ts` (partial), `routes/agents.ts` (5), `routes/chat.ts`, `routes/usage.ts`,
`lib/cc-runner.ts`.

1. `POST /api/fleet/freeze`. **Confirm the freeze actually took effect** — the executor holds
   the *queue*, it does not kill in-flight runs (`executor.ts:975` loop). Wait until
   `SELECT count(*) FROM runs WHERE status IN ('running','claimed')` is 0. Do not skip this;
   copying a table mid-run produces a run that exists in neither database's truth.
2. Also stop `forge-executor` outright for the copy window — belt and braces, since the freeze
   is a soft gate.
3. Create the schema in `ai_os` in FK order: `runs` (self-FK), `projects`, `project_tasks`,
   `inbox_items`, `decisions`, `cron_schedules`, `webhooks`.
   **Omit** `decisions_related_job_id_fkey` and `inbox_items_related_job_id_fkey` (§4) —
   keep the columns, drop the constraints.
4. Load data in the same order.
5. Switch all imports to `aiOsPool`. `db/forge.ts` and `db/pipeline.ts` still hold `cfPool`
   at this point — that is expected and is Phase 7's job.
6. Restart, unfreeze (`POST /api/fleet/unfreeze` or the Telegram `/on`).

**Verify:**
```sql
\c ai_os
SELECT 'runs', count(*) FROM runs
UNION ALL SELECT 'projects', count(*) FROM projects
UNION ALL SELECT 'project_tasks', count(*) FROM project_tasks
UNION ALL SELECT 'decisions', count(*) FROM decisions
UNION ALL SELECT 'inbox_items', count(*) FROM inbox_items
UNION ALL SELECT 'cron_schedules', count(*) FROM cron_schedules
UNION ALL SELECT 'webhooks', count(*) FROM webhooks;
-- expect 196 / 4 / 37 / 63 / 58 / 4 / 0

-- referential integrity survived the copy
SELECT count(*) FROM project_tasks t LEFT JOIN projects p ON p.id=t.project_id
 WHERE p.id IS NULL;                                  -- expect 0
SELECT count(*) FROM project_tasks t LEFT JOIN runs r ON r.id=t.run_id
 WHERE t.run_id IS NOT NULL AND r.id IS NULL;         -- expect 0
SELECT count(*) FROM cron_schedules c LEFT JOIN runs r ON r.id=c.last_run_id
 WHERE c.last_run_id IS NOT NULL AND r.id IS NULL;    -- expect 0
SELECT count(*) FROM runs a LEFT JOIN runs b ON b.id=a.parent_run_id
 WHERE a.parent_run_id IS NOT NULL AND b.id IS NULL;  -- expect 0 (30 rows have parents)
```
```bash
# end-to-end: create a real run and watch it complete
curl -s -XPOST localhost:7700/api/runs -d '{"title":"split smoke","prompt":"echo ok"}'
# then confirm it landed in ai_os and NOT in content_forge
```
```sql
\c content_forge
SELECT max(created_at) FROM runs;   -- must stop advancing after cutover
```
**Rollback:** the expensive one. Freeze, dump the `ai_os` copies of all seven tables back into
`content_forge` (they will have diverged by however long the phase ran), revert the imports,
restart. Because the reverse copy is lossy in the presence of new rows with FK relationships,
**decide a rollback deadline up front** — e.g. 4 hours; after that, roll forward and fix.

---

### Phase 7 — Replace the `content_jobs` / `channels` / `content_templates` reads

**Prerequisite (Content Forge repo, separate PR):** widen
`packages/cf-api/src/jobs/list.ts::listJobs` from 8 to the 22 columns `db/forge.ts` needs, add
`channel_name` and `template_name` (or add a dedicated pipeline endpoint), and add a counts
endpoint for the two `count(*)` queries at `db/ai_os.ts:733-734`. Deploy Content Forge first
and verify with `curl -H "Authorization: Bearer $CF_API_TOKEN"` before touching the AI OS.

Then in the AI OS:

1. Add `forge-control/src/lib/cf-api-client.ts` — a typed HTTP client with `CF_API_URL` +
   `CF_API_TOKEN` from env, an explicit timeout, and **explicit error paths**: a failed call
   throws with diagnostics; it must never return an empty list on error. (House rule: no
   synthetic fallbacks — an empty pipeline board that means "the API was down" is exactly the
   silent-failure shape this codebase keeps getting burned by.)
2. Rewrite `db/forge.ts` (5 sites) and `db/pipeline.ts` (1 site) against it.
3. Flip the Phase-4 feature flag on for `routes/search.ts` and `db/ai_os.ts::getInboxPreview`.
4. Rewrite `db/ai_os.ts::getJobChannelId` (used by `routes/media.ts` for on-disk paths) —
   this one is security-relevant: it exists specifically so the path is not built from
   untrusted URL input. The HTTP replacement must preserve that property (fetch the job, read
   `channel_id` from the response; never fall back to a URL-supplied channel).
5. Rewrite the two dashboard counters.

**Verify:**
```bash
curl -s localhost:7700/api/pipeline | jq '[.phases[].cards|length]|add'   # ~= 19
curl -s localhost:7700/api/forge/jobs | jq 'length'
curl -s 'localhost:7700/api/search?q=a' | jq '.jobs|length'
curl -s localhost:7700/api/media/<known-job-id>/final_video.mp4 -I         # 200 + Range
# negative test — the most important one:
#   stop hub-web, hit /api/pipeline, confirm a 5xx with a real message,
#   NOT a 200 with an empty board
```
```bash
grep -rn "content_jobs\|content_templates\|LEFT JOIN channels" \
  /opt/forge-ai-os/forge-control/src   # expect: comments only
```
**Rollback:** revert the client + the six files; `pm2 restart`. `cfPool` is still present at
this point, so revert is clean.

---

### Phase 8 — Remove the `content_forge` connection

**This is the phase that makes the split real.** Until it lands, any future code can quietly
re-open the coupling.

1. Delete `cfPool` from `db/pool.ts`. Delete `HCP_DATABASE_URL` and its three pools if Phase 5
   moved `knowledge_note` and the `agent_message` code paths were removed; if `agent_message`
   is being kept, say so explicitly in the module header and in `CLAUDE.md`, because it is
   then a permanent second database and the goal is not met.
2. Delete `DATABASE_URL` and `HCP_DATABASE_URL` from all three ecosystem files
   (`forge-control` ×2 entries, `forge-control-web`). `pm2 delete` + `pm2 start` (not
   `restart`) so the pinned env in `dump.pm2` is actually cleared, then `pm2 save`.
3. Revoke the AI OS's grants on `content_forge` at the database level — a code change is a
   convention, a revoked grant is an enforcement. If `forge-control` connects as `postgres`
   today (it does), this means creating the dedicated `forge` role in Phase 0 and using it
   from Phase 1 onward; without that, this step is impossible.
4. After 7 days of clean operation, drop the `<table>_migrated_20260802` tables from
   `content_forge`.
5. Update `.claude/CLAUDE.md` (AI OS repo) and `INFRASTRUCTURE.md` with the new topology, and
   add a note to the Content Forge memory that the AI OS no longer shares its database.

**Verify:**
```bash
grep -rn "content_forge" /opt/forge-ai-os/forge-control/src \
  /opt/forge-ai-os/forge-control/ecosystem.config.cjs \
  /opt/forge-ai-os/forge-control-web/ecosystem.config.cjs   # expect: none, or comments only
pm2 describe forge-control | grep -i database    # expect: AI_OS_DATABASE_URL only
```
```sql
-- the definitive test: from the AI OS's role, the old DB must be unreachable
\c content_forge
SELECT count(*) FROM pg_stat_activity
 WHERE datname='content_forge' AND usename='forge';   -- expect 0
```
Leave `forge-control` running for 24h and re-check `pg_stat_activity` — a connection that
appears on an hourly tick is exactly the kind of thing a 5-minute check misses.

**Rollback:** re-add the env vars and the pool. Trivial, which is why this phase is safe to do
promptly once Phase 7 is verified — and why it should not be deferred.

---

## 8. Cutover procedure (the freeze windows)

Used verbatim in Phase 5 and Phase 6.

**Freeze:**
```bash
curl -s -XPOST localhost:7700/api/fleet/freeze -H 'content-type: application/json' \
  -d '{"actor":"db-split"}'
# confirm it took
sudo -u postgres psql -p 5434 -d ai_os -c "select status, updated_by from fleet_state"   # after phase 2
# drain in-flight runs — the freeze holds the QUEUE, it does not kill running work
watch -n5 'psql … -c "select count(*) from runs where status in (\"running\",\"claimed\")"'
# belt and braces for phase 6
pm2 stop forge-executor
# phase 5 only
pm2 stop knowledge-indexer-watch
```
Additionally, for any phase touching `tg_state` or the knowledge cluster: **send no Telegram
messages and make no vault edits during the window** — `telegram-bridge` and
`vault-sync-tick`/`km-indexer` do not honour the freeze.

**Move:** standard move procedure (§Phase 2, steps 1–3) per table, in FK order.

**Unfreeze:**
```bash
pm2 restart forge-control forge-executor --update-env
pm2 start forge-executor           # if stopped
pm2 start knowledge-indexer-watch  # if stopped
curl -s -XPOST localhost:7700/api/fleet/unfreeze -d '{"actor":"db-split"}'
# or Telegram /on
```
Then run the phase's verify block **before** declaring done, and re-run it 15 minutes later —
several of the failure modes here (a tick that fires hourly, an indexer that only writes on a
vault change) do not appear immediately.

---

## 9. Risks

**R1 — pgvector 0.6.0 on the target (HIGH, blocking).** `halfvec` does not exist there and no
newer package is available from configured apt sources. Phase 5 cannot start until this is
resolved. Option A (upgrade) requires restarting a host postgres shared with `veo` and `scs`.

**R2 — No backups anywhere (HIGH).** Neither database has any automated backup. The knowledge
graph is the system's accumulated memory and would move onto an unbacked server. Mitigated by
Phase 0 step 2, which must include a *proven restore*, not just a dump that exits 0.

**R3 — 19 hardcoded fallback connection strings (HIGH).** Every pool silently defaults to
`content_forge` when its env var is missing. A pm2 env that goes stale (a known recurring
problem on this box) reconnects the whole app to the old database without a single error
message. Phase 0 step 5 converts this into a startup crash, which is the correct behaviour.

**R4 — Writers outside the freeze (HIGH).** `km-indexer.js` (separate pm2 process, hardcoded
URLs, outside the repo), `vault-sync-tick`, and `telegram-bridge` all write while the fleet is
"frozen". Any of them will silently split-brain a table mid-cutover.

**R5 — The freeze does not stop in-flight runs (MEDIUM).** `executor.ts` holds the *queue*;
runs already claimed keep writing to `runs`, `spend_log`, `project_tasks`. Phase 6 must drain
to zero, not just freeze.

**R6 — `/api/v1/jobs` returns 8 of the 22 columns needed (MEDIUM).** Phase 7 depends on a
Content Forge PR that does not exist yet, in a different repo, and there is no
`/api/v1/templates` at all. Sequence the CF change first.

**R7 — The `hcp` database is not in the spec's scope (MEDIUM).** `knowledge_note` (466 rows,
half the memory system) and `agent_message` (1,484 rows, dead Hermes upstream) are read and
written live. If they are not addressed, the split leaves the AI OS on two databases and
Phase 8 cannot complete.

**R8 — Concurrent sessions in the same repo (MEDIUM).** Another agent and the live AI OS work
in `/opt/forge-ai-os` continuously; the AI OS also keeps a full second checkout at
`/opt/ai-os/workspace/projects/4056b6b1-…/`. Check `git log`/HEAD before each phase, exclude
the workspace copy from every sweep, and never let a phase span an unattended window.

**R9 — Reverting Phase 6 is lossy (MEDIUM).** Once the fleet runs against `ai_os`, new runs,
tasks and decisions exist only there. A revert must copy them back or drop them. Set an
explicit rollback deadline before starting.

**R10 — No migration tracking exists (LOW, but compounding).** Nothing records which of the 12
hand-written migrations have been applied where. Phase 0 step 4 adds `schema_migrations`;
without it, "did phase N actually run on this database" is unanswerable.

**R11 — `guardrail_rules` exists in both databases with 9 rows each and unknown divergence
(LOW).** The `ai_os` copy is a stale artefact of the 2026-07-29 rename. If it is not dropped
in Phase 0 it becomes a plausible-looking wrong answer for the executor's spawn cap.

**R12 — Superuser connection (LOW→MEDIUM).** The AI OS connects as `postgres`. That makes the
Phase 8 "revoke the grant" enforcement impossible and is poor practice on a box that was
root-compromised on 2026-07-28. Fix in Phase 0.

---

## 10. Not verified / open

State these as unknowns rather than assumptions:

1. **Whether the pgvector upgrade path (option A) actually works on this host.** PGDG has
   0.8.x for pg16, but the repo is not configured and I did not attempt to add it (read-only
   constraint). The restart's impact on the `veo` and `scs` databases is also unassessed.
2. **`content_forge`'s own backup story.** I found none, but I only swept crontabs, cron.d,
   cron.daily, systemd units/timers and looked for dump files. An external/off-box backup
   (Hetzner storage box, another host pulling dumps) would not appear in that sweep.
3. **Exact row-level divergence between `ai_os.guardrail_rules` and
   `content_forge.guardrail_rules`.** Both have 9 rows; I could not diff them without knowing
   the column list (my probe used a `name` column that does not exist) and chose not to keep
   guessing. Diff them before dropping the stub — with a dump taken first.
4. **Whether `routes/reminders.ts` / `db/reminders.ts` join `inbox_items` inside a single SQL
   statement.** Both files reference `inbox_items`, and they are in different phases (3 vs 6).
   I confirmed the references exist but did not read every statement body. This is the most
   likely place for a Phase-3 regression — audit before executing Phase 3.
5. **Whether anything besides `forge-control` and `km-indexer` writes the AI-OS tables.** I
   swept `/opt/knowledge-mcp`, `/opt/content-forge`, and `/opt/ai-os`. Content Forge's own
   references to `fleet_state`/`notifications` are **comments only** (verified), and
   `packages/db/src/schema/index.ts:81` explicitly documents that the Drizzle mirror of the
   AI-OS tables was removed in the 2026-06-21 split — so `pnpm db:push` will not touch them.
   But I did not sweep the whole filesystem, only those trees.
6. **Whether `POST /api/fleet/unfreeze` exists** under that exact name. I verified
   `/api/fleet/freeze` (registered in `index.ts:85`) and that Telegram `/on` sets
   `fleet_state` to `running`; I did not enumerate the unfreeze route.
7. **`forge-control-mcp`.** It contains no `pg` import (verified), but I did not read it in
   full — if it shells out to `psql` anywhere, that would be an uncounted access path.
8. **Whether the `agent_message` code paths are still doing anything useful** now that Hermes
   is gone. The table has 1,484 rows and 57 of 58 `inbox_items` reference it, but whether new
   rows still arrive was not checked. This decides R7.
