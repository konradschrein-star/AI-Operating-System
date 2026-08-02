# Claude account health-failover + real settings route — design

**Date:** 2026-08-02
**Status:** approved in conversation, pending written review
**Repo:** `AI-Operating-System` (`forge-control`, `forge-control-web`)

---

## 1. Problem

On 2026-08-02 at 10:01:52 the AI OS stopped working entirely. Every run failed with
`Failed to authenticate: OAuth session expired and could not be refreshed`.

Root cause, established by inspection on the VPS:

- `/root/.claude/.credentials.json` still contains a `claudeAiOauth` object, but the
  access token is 0 bytes, the refresh token is 0 bytes, and `expiresAt` is `0`. A refresh
  attempt failed and the CLI zeroed the tokens in place. There is nothing left to refresh.
- No credential backup exists (`/root/.claude/backups/` holds only `.claude.json` config
  snapshots). The tokens are **not recoverable**; an interactive `claude /login` is required.
- The second account, `/home/claude-worker/.claude`, expired **2026-06-03** and had been
  dead for two months without anyone noticing.
- A third account is referenced by the operator's mental model but **was never provisioned
  on this machine**.

Why nothing took over:

1. `CLAUDE_POOL_ACCOUNTS` is unset on the VPS, so the pool falls back to a single implicit
   account — the ambient `/root/.claude`, i.e. the dead one.
2. Both rows in `llm_pool_accounts` (content_forge DB) are `enabled = false`.
3. **The AI OS executor never used the account system at all.** `cc-runner.ts` spawns
   `claude` bare and inherits whatever `/root/.claude` happens to hold. The multi-account
   code lives in Content Forge's `claude-pool`, a different service the AI OS does not call.

Ruled out as a cause: the daily `claude-code-autoupdate.sh` cron. The CLI has been pinned at
2.1.220 since before 2026-07-31; no version changed under the process.

Not established: *why* the refresh failed. Server-side revocation related to the 2026-07-28
root compromise is plausible — the tokens were root-readable throughout, and the key
rotation owed from that incident was never performed — but it is unproven and is not
asserted here.

### 1.1 The real defect

Failover would not have prevented this outage. Both accounts were dead; any rotation logic
would have walked a list of corpses and thrown the same error.

The actual defect is that **nothing was watching**. A credential died in June and the system
held no opinion about it until August. This mirrors an existing house rule — an unprobed
backend must never report green — and the same failure shape (silence read as health) caused
this outage.

Therefore: **monitoring and alerting are the primary deliverable**, and failover is the
secondary one.

---

## 2. Goals

1. The AI OS executor selects a Claude account explicitly instead of inheriting ambient state.
2. Account health is probed, has three states, and `unknown` is never rendered as healthy.
3. A **broken** account is automatically skipped in favour of a healthy one.
4. Konrad is alerted **before** a credential dies, via the Telegram bot already in service.
5. `/settings` is a real route, reachable from the sidebar tab, showing and controlling accounts.

## 3. Non-goals

1. **No rotation on rate-limit exhaustion.** Explicitly decided. When an account hits its
   usage limit the system fails visibly and falls through to the existing DeepSeek chain.
   Switching accounts to obtain more capacity than one account provides is the
   limit-circumvention path; it risks termination of every linked account. Health-failover
   moves off accounts that are *broken*, never off accounts that are *busy*. This distinction
   is the single most important invariant in this design and is enforced in code by
   §6.3 error classification.
2. No wholesale refactor of `DesktopApp.tsx`. Only the settings surface is extracted.
3. No credential material in the database. The registry stores directory paths and
   non-secret metadata only, matching the existing `claude-pool` approach.
4. No automated re-authentication. OAuth login is interactive by design and stays manual.

---

## 4. Account registry

This section changed twice. The history matters, because the second change was made for a
wrong reason and the third restores the first conclusion on a better one.

- **Draft 1:** a new `claude_accounts` table in a separate `ai_os` database, assuming the two
  systems used different databases.
- **Draft 2:** extend Content Forge's `llm_pool_accounts` instead — because inspection showed
  `forge-control` runs with `DATABASE_URL=…@127.0.0.1:5432/content_forge`, the *same*
  database, so a second table would just be a second source of truth drifting from the first.
- **Draft 3 (current), decided by Konrad 2026-08-02:** back to a separate table in a separate
  database. The shared database was never a constraint to design around — **it was itself the
  defect.** Content Forge is one business unit; the AI OS runs across all of them. Coupling
  them at the data layer is how the mess was made, and draft 2 would have cemented it.

**Decision: the AI OS owns its own account registry in its own database** (`ai_os` on
:5434). Content Forge's `claude-pool` keeps `llm_pool_accounts` for its own consumers. The
two are separate systems with separate lifecycles and must not share a table.

This is not the drift risk draft 2 feared. Drift comes from two tables describing *the same*
thing with no owner. Here each table has exactly one owner and one consumer set. What must
not happen is a *third* uncontrolled description of the same accounts — which is why
`CLAUDE_POOL_ACCOUNTS` should be deleted rather than left as an unread env mirror (§11).

```sql
-- in the ai_os database (:5434), NOT content_forge
CREATE TABLE claude_accounts (
  slug            TEXT PRIMARY KEY,       -- names the IDENTITY, not the directory
  config_dir      TEXT NOT NULL,          -- CLAUDE_CONFIG_DIR for the child. Never a secret.
  login_email     TEXT,                   -- from `claude auth status`, for operator sanity
  plan_label      TEXT,
  priority        INTEGER NOT NULL DEFAULT 100,  -- lower wins
  enabled         BOOLEAN NOT NULL DEFAULT true,
  health          TEXT NOT NULL DEFAULT 'unknown',  -- healthy|broken|unknown
  health_detail   TEXT,
  has_refresh     BOOLEAN,                -- the real liveness bit (§5.1)
  last_probed_at  TIMESTAMPTZ,
  last_ok_at      TIMESTAMPTZ,            -- last CONFIRMED successful run
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.1 This table is the pilot for the database split

`forge-control` today has one `DATABASE_URL`, pointing at `content_forge`. Isolating the AI OS
(§12) means giving it a second connection and moving ~15 tables. Rather than build that
wholesale first, **this table is created in `ai_os` from the start** and becomes the first
consumer of the new connection — a small, new, self-contained table with no existing data to
migrate. It proves the connection, the migration pattern, and the deployment path before
anything with 1,452 rows moves.

Consequence: accounts do **not** wait on the full split, and the split gains a working
reference implementation.

### 4.2 Seeding

Current `llm_pool_accounts` rows are both `enabled = false` and must be reconciled with
reality rather than copied:

- `/root/.claude` — re-authenticated 2026-08-02, now holds the newly purchased **"Arved
  Account"** (`media.asphaltaction@gmail.com`, `max`). The `max_20x` identity previously in
  this directory is gone; do not assume the old `plan_label` still describes it.
- `/home/claude-worker/.claude` — dead since 2026-06-03, needs its own login or removal.
- Third account: config dir to be created under `/opt/claude-accounts/<slug>/`.

**Slugs should name the identity, not the directory.** `root` and `claude-worker` describe
filesystem locations, which is why nobody noticed the identity inside `/root/.claude` had
changed. One directory holds exactly one identity; the slug should say which.

Migrations are hand-written (drizzle-kit generate is broken in this stack).

---

## 5. Health probing

A prober runs in `forge-control` on a 10-minute interval and on demand from the settings page.

### 5.1 Cheap tier — credential file inspection

**Corrected 2026-08-02 after inspecting a freshly-issued credential.** An earlier draft
classified an account as `expiring` when `expiresAt` was within 7 days. That rule is wrong
and would have made the whole alerting system worthless.

A healthy Claude credential, thirty seconds after a successful login, looks like this:

```
expiresAt : 2026-08-02T17:37Z   →  0.33 days away
refreshLen: 108
```

Access tokens are **8-hour** tokens that the refresh token renews silently and continuously.
Under the 7-day rule every healthy account is permanently `expiring`, the alert fires forever,
and Konrad learns to ignore the channel — an alert that is always on is the same as no alert.

**The access-token countdown carries no health information and must not be surfaced as
though it does.** It is a number that looks meaningful and isn't.

What actually separates this morning's corpse from a working account:

| Condition | State |
|---|---|
| file missing / unparseable | `broken` (`"no credential file"`) |
| **refresh token empty or absent** | `broken` (`"credentials blanked — re-login required"`) |
| access token empty | `broken` (`"no access token"`) |
| access token expired **and** refresh attempt fails | `broken` (`"refresh rejected"`) |
| refresh token present, no confirmed successful run in 7 days | `unknown` (`"unexercised"`) |
| refresh token present, recent confirmed run | `healthy` |

The `expiring` state is **removed** from the design. It has no honest definition here: the
refresh token's own lifetime is not exposed in the credential file, so there is nothing to
count down to. What replaces it is `unknown` for **unexercised** accounts — an account nobody
has successfully used recently is not known to work, whatever its token file claims.

That is the rule that catches the June failure. `claude-worker`'s credential file sat on disk
looking structurally plausible for two months while the account behind it was dead, because
nothing ever exercised it and nothing ever asked. It is the same principle as the existing
house rule that an unprobed backend must never report green.

This tier would have caught **both** real failures: the August one on the empty-refresh-token
row, the June one on the unexercised row.

### 5.2 Live tier — confirm the token is honoured

A token can be present and well-formed yet revoked. Once per hour per account, spawn
`claude -p --model haiku` with a trivial prompt and `CLAUDE_CONFIG_DIR` set, with a short
timeout. Auth failure → `broken`. Rate-limit response → **leave health unchanged** (a busy
account is not a broken one). Any other error → `unknown`, never `healthy`.

### 5.3 The `unknown` state

`unknown` means not-yet-probed, probe-inconclusive, **or unexercised** (§5.1) — three ways of
saying the same thing: nobody currently knows whether this account works. It renders amber,
is never counted as healthy, and is usable but ranked below `healthy` candidates.

Never collapse `unknown` into `healthy`. The optimistic collapse is what let a dead account
report green for two months.

---

## 6. Selection and failover

### 6.1 Selection

At run start, `cc-runner` calls `resolveAccount()`, which returns the enabled account with
the best health rank, tie-broken by lowest `priority`. The rank is:

```
healthy  >  unknown  >  (broken: excluded entirely)
```

An `unknown` account is still selectable — it is unproven, not condemned, and selecting it
is exactly how it becomes proven. It simply loses to any account known to work. The chosen
account's `config_dir` is set as `CLAUDE_CONFIG_DIR` on the child env. `ANTHROPIC_API_KEY`
continues to be stripped.

If **no** account is selectable, throw a typed `NoHealthyAccountError` whose message names
every account and its reason. The run fails loudly with a diagnosis instead of a bare
authentication error — this is the message Konrad should have seen this morning.

### 6.2 Failover

If a run fails and the error classifies as **auth** (§6.3):

1. Mark the account `broken` with the error text.
2. Fire the alert (§7).
3. Retry the run **once** on the next selectable account.
4. If that also fails on auth, fail the run with the combined diagnosis. No further retries.

Failover is capped at one hop per run to avoid burning every account on a systemic fault.

### 6.3 Error classification — the safety-critical function

```
auth        → /failed to authenticate|oauth session expired|could not be refreshed
               |invalid_grant|unauthorized|401/i      → FAILOVER
rate_limit  → /rate limit|429|usage limit|quota exceeded/i → NO FAILOVER, surface to user
other       → anything else                           → NO FAILOVER
```

Classification defaults to `other` when ambiguous. A misclassification of rate-limit as auth
would silently produce exactly the account-rotation behaviour this design refuses to build,
so the rate-limit patterns are checked **first** and win over auth patterns when both match.

---

## 7. Alerting

Uses the existing Telegram bot. Alerts fire on **state transitions**, not on every probe,
and are debounced to at most one message per account per 6 hours.

- → `broken`: page immediately, with the account slug and the exact re-login command.
- → `unknown` **by way of going unexercised** (§5.1): a low-urgency nudge that an account has
  gone 7 days without a confirmed successful run, so a silently-dead account surfaces within a
  week instead of within two months. This is the alert that would have caught the June death.
- → `healthy` after being broken: a short recovery confirmation, so a fix is visibly confirmed.

There is deliberately **no** periodic "token expires soon" alert — per §5.1 that number is
meaningless here, and an always-on alert is indistinguishable from no alert.

Message bodies carry the copy-pasteable command, e.g.
`sudo -u claude-worker env HOME=/home/claude-worker claude /login`.

This is what converts a two-month silent outage into a Tuesday notification.

---

## 8. Settings route

`forge-control-web/app/settings/page.tsx` — a real Next.js route. The sidebar `settings` nav
item navigates to it instead of switching a client-side surface. The current `settings` entry
in `PLACEHOLDER_SURFACES` (a hardcoded mockup with an icon list) is deleted.

The page shows one card per account:

- slug, identity (login email, read from `claude auth status`), plan label, config dir
- health badge (green healthy / amber unknown / red broken) with the reason text
- **last confirmed successful run**, last probed — *not* an access-token countdown (§5.1)
- enable/disable toggle, priority
- a **Re-authenticate** panel, prominent when broken, showing the exact command
- a **Probe now** button

Plus a global panel stating the failover policy in plain language, so the rate-limit
behaviour is discoverable rather than surprising: *health-failover only; a rate-limited
account fails visibly and does not hand off.*

API: `GET /api/accounts`, `PATCH /api/accounts/:slug` (enabled, priority, plan_label),
`POST /api/accounts/:slug/probe`, `POST /api/accounts` (add), `DELETE /api/accounts/:slug`.
Routes must be registered in `forge-control/src/index.ts`.

Extracting only this surface is deliberate; `DesktopApp.tsx` is 2,621 lines and a full
decomposition is separate work.

---

## 9. Testing

Unit, no network:

- `classifyError` — table-driven over real observed strings, including the literal
  `"Failed to authenticate: OAuth session expired and could not be refreshed"` from this
  outage, and rate-limit strings. **Asserts rate-limit never classifies as auth.**
- `resolveAccount` — health ranking, priority tie-break, disabled exclusion,
  `NoHealthyAccountError` when nothing is selectable.
- Cheap-tier classification — fixture credential files: blanked (today's exact shape:
  `expiresAt: 0`, both token lengths 0), expired-no-refresh, missing, malformed, and a
  **freshly-issued healthy credential whose access token expires in 8 hours** — that last
  fixture is the regression guard for the corrected §5.1, and it must classify as `healthy`,
  never as expiring-anything.
- Unexercised detection — an account with a valid-looking credential and no confirmed run in
  8 days classifies `unknown`, not `healthy`. This is the June-failure regression test.
- Failover — a run failing on auth retries once on the next account; a run failing on
  rate-limit **does not** fail over.

Integration, on the VPS after deploy: probe both real accounts and confirm the reported
states match the on-disk reality established in §1.

---

## 10. Rollout

1. Migration + seed the two known accounts.
2. Deploy `forge-control` and `forge-control-web`.
3. Konrad runs `claude /login` for `root` (and optionally `claude-worker`).
4. Probe; confirm the settings page shows the true state.
5. Confirm one real run succeeds end to end.
6. Verify a Telegram alert fires by temporarily disabling an account.

### 10.1 Working-copy hazard

The VPS at `/opt/forge-ai-os` is **ahead of GitHub** by 3 unpushed commits and carries ~2,852
uncommitted insertions, including an in-flight idle-budget timeout rewrite in `cc-runner.ts`
— the same file this design modifies. A backup was taken before any work
(`/opt/backups/forge-ai-os-worktree-*.tar.gz` and a `--all` git bundle).

Implementation must build on the VPS working tree, not on the stale local clone or on
`origin/main`, and must not revert the in-flight timeout work. Reconciling the VPS, the local
clone, and GitHub is a prerequisite task, not part of this feature.

---

## 11. Open questions

1. ~~The third account: does a config dir exist for it?~~ **Resolved 2026-08-02.** Purchased
   that day ("Arved Account"), authenticated into `/root/.claude`, and now serves as primary.
   The remaining two accounts still need dirs under `/opt/claude-accounts/<slug>/`.
2. ~~Should `claude-pool` consume this registry rather than its own env mirror?~~ **Resolved
   by §4** — they share one database, so they share one table. The open sub-question is
   whether `CLAUDE_POOL_ACCOUNTS` should be deleted outright once `claude-pool` reads the
   table directly. It is currently unset on the VPS, so nothing depends on it today, and
   leaving a second unread configuration source in place invites exactly the drift §4
   describes. Recommendation: delete it.
3. ~~What becomes of the identity formerly in `/root/.claude`?~~ **Decided 2026-08-02:** stays
   out until the new primary has survived a few days. It may have been revoked server-side
   (§1); re-authenticating it into a directory the OS actively uses would destroy the signal
   that tells us whether credentials are still leaking.

---

## 12. Appendix — AI OS database isolation (separate project)

Decided by Konrad 2026-08-02: the AI OS must not share a database with Content Forge. Scoped
here because §4 depends on it; **it needs its own plan before implementation.**

### 12.1 Current state

`forge-control` has a single `DATABASE_URL` pointing at `content_forge` (:5432, docker). An
`ai_os` database already exists on a *different* server — host postgres, :5434, renamed from
`hcp` during the 2026-07-29 Hermes removal — holding `runs` (0 rows), `fleet_state` (1),
`guardrail_rules`, `guardrail_trips`, `connector_configs`. It was created and never wired up,
so there are now two `runs` tables and the live one is in the wrong database.

> **§12.2–12.5 were revised 2026-08-02 after a dedicated read-only investigation.**
> Five of my original assumptions were wrong; each correction is marked inline. A separate
> full implementation plan lives at `docs/superpowers/specs/2026-08-02-ai-os-db-split-plan.md`.

### 12.2 Scope — measured, not estimated

AI-OS-owned tables currently in `content_forge`, with live row counts:

| table | rows | | table | rows |
|---|---|---|---|---|
| knowledge_triples | 1452 | | reminders | 48 |
| knowledge_embeddings | 212 | | project_tasks | 37 |
| runs | 196 | | guardrail_rules | 9 |
| spend_log | 167 | | cron_schedules | 4 |
| notifications | 154 | | projects | 4 |
| decisions | 63 | | fleet_state | 1 |
| inbox_items | 58 | | webhooks | 0 |

**CORRECTION — it is 18 tables, not 15.** Three were missed: `guardrail_trips` (6 rows),
`mentor_metrics` (2), `tg_state` (1). Row total is still ~2,400. The data volume is trivial;
the risk is in the cutover and in finding every query, not in the migration itself.

**CORRECTION — a THIRD database is in play.** `hcp` (:5432, retained from the Hermes removal)
is live and holds `knowledge_note` (466 rows) and `agent_message` (1,484 rows), read
unguarded by `db/memory.ts`. The split is not two-way; any plan that ignores `hcp` leaves the
knowledge system half-migrated.

### 12.3 Cross-boundary reads

**CORRECTION — `content_jobs` is not the only one.** Three Content Forge tables are read from
AI OS code, across seven call sites:

| CF table | read at |
|---|---|
| `content_jobs` | pipeline surface |
| `channels` | `db/ai_os.ts:306`, `db/pipeline.ts:130` |
| `content_templates` | `db/pipeline.ts:131` |

All three become HTTP calls to the Content Forge API. **Blocker:** the existing
`cf-api.listJobs` returns 8 of the 22 columns the UI needs, so this phase requires a Content
Forge PR *before* it can start — it is not self-contained within this repo.

No dual connections into `content_forge` for convenience — that rebuilds the coupling under a
different name.

### 12.3.1 Foreign keys — the sequencing correction

**CORRECTION — the original "leaf tables" phase was wrong.** Verified against `pg_constraint`:

```
webhooks.last_run_id        -> runs            ← NOT a leaf
cron_schedules.last_run_id  -> runs            ← NOT a leaf
decisions.inbox_item_id     -> inbox_items     ← internal pair, must move together
inbox_items.related_job_id  -> content_jobs    ← crosses the split boundary
decisions.related_job_id    -> content_jobs    ← crosses the split boundary
```

`webhooks` and `cron_schedules` must move **with the runs cluster**, not before it. Moving
them as "leaves" would have dropped or broken their FK to `runs`.

The two FKs into `content_jobs` cross the split and cannot survive it. Both columns are
**100% NULL** (0 of 63 decisions, 0 of 58 inbox_items), so dropping the constraints is
lossless — but it must be an explicit, recorded decision rather than a silent casualty.

### 12.3.2 Query sites and connection sprawl

**CORRECTION — worse than the 10 pools I first counted.** There are **19 separate
`new Pool(...)` constructions across 17 files**, and **142 query call sites across 16 files**.
There is no shared client module. Every pool carries a hardcoded
`postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge` fallback, so a stale
pm2 env does not fail — it silently reconnects to the old database and appears to work.

This makes "remove the connection" (step 8) the load-bearing step, not a cleanup step. A
shared connection module is a **prerequisite**, not a nicety.

`forge-control-web` opens no database connection at all — the entire split is backend-only.

### 12.4 Sequencing (revised)

0. **Prerequisites:** verified backups of both databases, a shared connection module
   replacing the 19 ad-hoc pools, drop the orphaned `ai_os.runs` stub, resolve pgvector.
1. `claude_accounts` in `ai_os` — the pilot. **DONE 2026-08-02.**
2. Guardrail/mentor leaves (`guardrail_rules`, `guardrail_trips`, `mentor_metrics`).
3. Notification/reminder/spend leaves (`notifications`, `reminders`, `spend_log`, `tg_state`,
   `fleet_state`).
4. Query-splitting prep — no data movement.
5. Knowledge cluster (`knowledge_embeddings`, `knowledge_triples`, plus `hcp`'s
   `knowledge_note` and `agent_message`). **Blocked — see 12.5.**
6. Runs/projects cluster, fleet frozen: `runs`, `project_tasks`, `projects`, `decisions`,
   `inbox_items`, **`webhooks`, `cron_schedules`**.
7. Replace the three CF table reads with `/api/v1` calls (needs the CF PR first).
8. Remove the `content_forge` connection and every hardcoded fallback.

### 12.5 Known hazards

- **BLOCKER — pgvector is too old on the target.** `knowledge_embeddings.embedding` is
  `halfvec(1024)` with a halfvec HNSW index. halfvec requires pgvector ≥ 0.7.0. Verified:
  source (:5432) runs **0.7.4**; target (:5434) has the extension **not installed at all** and
  its highest *available* version is **0.6.0**, with no PGDG repo configured. Phase 5 cannot
  start until pgvector is upgraded on the host cluster — and whether that upgrade succeeds on
  this host is unverified.
- **A second writer outside the repo.** `/opt/knowledge-mcp/km-indexer.js` writes
  `knowledge_embeddings` using its own hardcoded connection strings. It is **not** gated by
  `/api/fleet/freeze`, so freezing the fleet does not make the knowledge tables quiet. It must
  be stopped explicitly during phase 5 or it will write into the old database mid-migration.
- **No automated backups exist for either database.** Not "unverified" — none found. This must
  be fixed in phase 0, before anything holds the only copy of 1,452 knowledge triples.
- **No migration runner exists.** Migrations are applied by hand with `psql`. Either accept
  that explicitly or build one in phase 0.
- **Two databases, two servers.** No cross-database joins, no spanning transactions;
  `pg_dump | psql` between them is a network copy.
