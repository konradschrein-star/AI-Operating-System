# Phase 4 · B4a — What the executor authenticates with today

**Requirement:** R44 · **Workstream:** `connections` · **Written:** 2026-08-18 · **Committed before any implementation code.**

Every claim below carries either a `file:line` or the command that produced it (N10). Nothing here is
recalled; the registry was read read-only with `psql`, and no `UPDATE`, `INSERT` or `DELETE` was
issued against it at any point.

---

## 1. The one-line answer

The log line

```
[executor] run <id>: account=arved health=healthy
```

is **not a live probe**. Both halves are read straight out of a **stored row** in the table
`claude_accounts`, in the database **`ai_os`**, on **`127.0.0.1` port `5434`** — the host PostgreSQL
instance, **not** the Content Forge instance on `5432`. `health` is a stored `text` column, last
written by whichever of `recordProbe()` / `markSuccess()` / `markAuthFailure()` ran most recently.

Reading a stored classification instead of probing on every run is **correct and cheap**. It is only
honest if the **age of the last probe is displayed**. It currently is not. That is the defect this
task fixes.

---

## 2. The path, end to end

| # | Step | Evidence |
|---|---|---|
| 1 | The executor resolves an account before starting a run | `forge-control/src/executor.ts:996` — `let account = await resolveAccount();` |
| 2 | …and prints the line Konrad sees in the logs | `forge-control/src/executor.ts:997-999` — `` `[executor] run ${run.id}: account=${account.slug} health=${account.health}` `` |
| 3 | `resolveAccount()` lists every registry row and ranks them | `forge-control/src/lib/accounts.ts:214-217` — `pickAccount((await listAccounts()).map(toSelectable))` |
| 4 | `toSelectable()` copies `health` through **verbatim** — no re-classification, no probe | `forge-control/src/lib/accounts.ts:82-91` |
| 5 | `pickAccount()` → `rankAccounts()` filters `enabled && health !== "broken"`, sorts by health rank, then `priority`, then `slug` | `forge-control/src/lib/account-health.ts:183-201`; rank map at `:173` |
| 6 | `listAccounts()` issues the SELECT | `forge-control/src/db/claude-accounts.ts:105-110` — `SELECT ${COLS} FROM claude_accounts ORDER BY priority ASC, slug ASC` |
| 7 | The pool refuses to guess its database | `forge-control/src/db/claude-accounts.ts:41-63` — throws when `AI_OS_DATABASE_URL` is unset, with an explicit *"Refusing to fall back to content_forge"* |

**So `health` on the log line is column `claude_accounts.health`, and nothing on the run path
recomputes it.**

### The database, named exactly

```
$ set -a; . /root/.ai_os_db_url; set +a
$ psql "$AI_OS_DATABASE_URL" -c "SELECT current_database(), inet_server_port(), current_user"
 current_database | inet_server_port | current_user
------------------+------------------+--------------
 ai_os            |             5434 | ai_os_app
```

The connection string is `postgresql://ai_os_app:***@127.0.0.1:5434/ai_os`, held in
`/root/.ai_os_db_url` and injected into the pm2 environment of **both** processes:

```
$ pm2 jlist | python3 -c "...  print(p['name'],'->',v.split('@')[-1]) ..."
forge-control  -> 127.0.0.1:5434/ai_os
forge-executor -> 127.0.0.1:5434/ai_os
```

**It is demonstrably not the `content_forge` instance on 5432.** The table does not exist there:

```
$ psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -c "SELECT to_regclass('public.claude_accounts')"
 to_regclass
-------------

(1 row)
```

`to_regclass` returning NULL is the proof: `claude_accounts` has no existence on 5432.

---

## 3. The table

```
$ psql "$AI_OS_DATABASE_URL" -c '\d claude_accounts'
                            Table "public.claude_accounts"
      Column       |           Type           | Nullable |     Default
-------------------+--------------------------+----------+-----------------
 slug              | text                     | not null |
 config_dir        | text                     | not null |
 login_email       | text                     |          |
 plan_label        | text                     |          |
 priority          | integer                  | not null | 100
 enabled           | boolean                  | not null | true
 health            | text                     | not null | 'unknown'::text
 health_detail     | text                     |          |
 has_refresh       | boolean                  |          |
 access_expires_at | timestamp with time zone |          |
 last_probed_at    | timestamp with time zone |          |
 last_ok_at        | timestamp with time zone |          |
 last_error        | text                     |          |
 created_at        | timestamp with time zone | not null | now()
 updated_at        | timestamp with time zone | not null | now()
Indexes:
    "claude_accounts_pkey" PRIMARY KEY, btree (slug)
    "claude_accounts_config_dir_key" UNIQUE CONSTRAINT, btree (config_dir)
    "claude_accounts_selection_idx" btree (enabled, health, priority)
Check constraints:
    "claude_accounts_health_check" CHECK (health = ANY (ARRAY['healthy','broken','unknown']))
```

**The columns this phase needs already exist.** `last_probed_at` and `last_ok_at` are both present and
both populated by the existing write path. **No migration is required, and this project adds none**
(`02-architecture.md` §8).

### The live rows, as observed

```
$ psql "$AI_OS_DATABASE_URL" -x -c "SELECT slug, config_dir, login_email, plan_label, priority,
    enabled, health, health_detail, has_refresh, access_expires_at, last_probed_at, last_ok_at,
    last_error, now() AS observed_at FROM claude_accounts ORDER BY priority"
```

| column | `arved` | `claude-worker-legacy` |
|---|---|---|
| `config_dir` | `/root/.claude` | `/home/claude-worker/.claude` |
| `login_email` | `media.asphaltaction@gmail.com` | *(null)* |
| `plan_label` | `max` | `max_5x` |
| `priority` | `10` | `90` |
| `enabled` | `t` | `f` |
| `health` | `healthy` | `broken` |
| `health_detail` | `confirmed by a successful run` | `token expired 2026-06-03; unused since. Not re-authenticated by choice.` |
| `has_refresh` | `t` | *(null)* |
| `access_expires_at` | `2026-08-18 22:48:45.305+02` | *(null)* |
| `last_probed_at` | `2026-08-18 21:17:40.408769+02` | **(null — never probed)** |
| `last_ok_at` | `2026-08-18 21:22:20.320508+02` | *(null)* |
| `last_error` | *(null)* | *(null)* |

Observed at `2026-08-18 21:23:56.576441+02` (the query's own `now()`).

Two rows. `arved` serves every run; `claude-worker-legacy` is disabled and would be excluded anyway
by `rankAccounts()`'s `health !== "broken"` filter (`account-health.ts:187`).

---

## 4. The credential file — what it is and what it is not

`classifyCredential()` is fed by `readCredentialSnapshot()`, which reads
`<config_dir>/.credentials.json` and returns **presence only** — no token material is returned,
logged, or stored (`forge-control/src/lib/accounts.ts:42-80`).

```
$ for d in /root/.claude /home/claude-worker/.claude; do f="$d/.credentials.json";
    [ -f "$f" ] && echo "$f EXISTS bytes=$(stat -c%s "$f") mode=$(stat -c%a "$f")" || echo "$f ABSENT"; done
/root/.claude/.credentials.json EXISTS bytes=509 mode=600
/home/claude-worker/.claude/.credentials.json EXISTS bytes=470 mode=600
```

Structure of `/root/.claude/.credentials.json` (keys and lengths only — **no values were printed,
logged or committed**):

```
$ python3 -c "import json;d=json.load(open('/root/.claude/.credentials.json'));…"
top keys: ['claudeAiOauth']
claudeAiOauth keys: ['accessToken','refreshToken','expiresAt','refreshTokenExpiresAt','scopes','subscriptionType','rateLimitTier']
accessToken len: 108
refreshToken len: 108
expiresAt: 1787086125305
```

`expiresAt: 1787086125305` = `2026-08-18T20:48:45.305Z` = `22:48:45+02`, which matches
`access_expires_at` in the registry row exactly. That is the round trip
file → `readCredentialSnapshot()` → `recordProbe()` → column, closed.

**The finding that matters most here:**
`/home/claude-worker/.claude/.credentials.json` **exists, is 470 bytes, and is mode 0600** — and that
account has been dead since 2026-06-03. A credential file on disk proves *storage*, not
*authorisation*. This single row is the counter-example to every "the file is there, so it must be
connected" inference in the product.

### Why the file cannot decide health on its own

`classifyCredential()` (`forge-control/src/lib/account-health.ts:55-103`) applies, in order:

| Order | Condition | Verdict | Line |
|---|---|---|---|
| 1 | `!exists` | `broken` — *"no credential file — never logged in"* | `:64-66` |
| 2 | `!parseable` | `broken` — *"credential file is not valid JSON"* | `:67-69` |
| 3 | `!hasRefreshToken` | `broken` — *"credentials blanked (no refresh token) — re-login required"* | `:73-78` |
| 4 | `!hasAccessToken` | `broken` — *"no access token — re-login required"* | `:79-84` |
| 5 | `lastOkAt === null` | **`unknown`** — *"never confirmed working — no successful run on record"* | `:87-92` |
| 6 | `now - lastOkAt > unexercisedAfterMs` | **`unknown`** — *"unexercised — no confirmed successful run in N days"* | `:93-100` |
| 7 | otherwise | `healthy` — *"credential present, recently confirmed"* | `:102` |

`unexercisedAfterMs` defaults to `DEFAULT_UNEXERCISED_MS = 7 days` (`account-health.ts:39`).

Rules 5 and 6 are the load-bearing ones: **a structurally perfect credential file is classified
`unknown`, not `healthy`, unless something has actually succeeded against it recently.** The code
already believes the invariant this phase enforces (R57). The surface is where it gets lost.

`expiresAt` is deliberately **not** a health input (`account-health.ts:41-54`): a Claude access token
expires roughly every 8 hours by design and the refresh token renews it silently, so an
"expires soon" rule would mark every healthy account as failing, permanently.

---

## 5. Who writes the column

| Writer | When | What it sets | Evidence |
|---|---|---|---|
| `recordProbe()` | every probe, cheap tier | `health`, `health_detail`, `has_refresh`, `access_expires_at`, **`last_probed_at = now()`**. Explicitly does **not** touch `last_ok_at`. | `forge-control/src/db/claude-accounts.ts:121-137` |
| `markSuccess()` | a run completed OK | `last_ok_at = now()`, `health = 'healthy'`, detail `'confirmed by a successful run'`, clears `last_error`. **Does not touch `last_probed_at`.** | `forge-control/src/db/claude-accounts.ts:144-153` |
| `markAuthFailure()` | a run died with `classifyError() === "auth"` | `health = 'broken'`, `last_error = <verbatim upstream message, truncated to 2000 chars>` | `forge-control/src/db/claude-accounts.ts:160-171` |
| `createAccount()` | registration | inserts `health = 'unknown'`, detail `'created — awaiting first probe'` | `forge-control/src/db/claude-accounts.ts:210-211` |

Callers: `probeAccount()` calls `recordProbe()` (`lib/accounts.ts:106-111`);
`recordRunOutcome()` calls `markSuccess()` / `markAuthFailure()` (`lib/accounts.ts:239-246`), invoked
from `executor.ts:1058`, `:1111`, `:1126`.

`startProbeLoop()` runs `probeAll()` every **10 minutes** by default
(`lib/accounts.ts:264`, `default intervalMs = 10 * 60_000`) and is started once at
`forge-control/src/index.ts:237`. `probeAll()` probes **enabled accounts only**
(`lib/accounts.ts:199-207`) — which is exactly why `claude-worker-legacy.last_probed_at` is still
NULL after being registered.

**Consequence, and it is the point of R45:** `arved`'s row is refreshed every 10 minutes, so its
`health` word is at most ~10 minutes stale. `claude-worker-legacy`'s `health = 'broken'` was written
by hand and has **never** been re-derived from anything. Two rows, the same column, one of them 77
days old — and the surface renders both identically, with no clock attached to either. That is the
whole defect in one table.

---

## 6. How the row reaches the browser

| Step | Evidence |
|---|---|
| `GET /api/accounts` → `listAccounts()` → `shape()` per row | `forge-control/src/routes/accounts.ts:68-97`, `shape()` at `:42-66` |
| `shape()` emits `last_probed_at` and `last_ok_at` as raw ISO timestamps | `routes/accounts.ts:57-58` |
| `shape()` computes `reauth_command` server-side | `routes/accounts.ts:60-64` — `claude auth login --claudeai` for `/root/.claude`, otherwise `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai` |
| The web client fetches `/api/proxy/accounts` on mount and every 30 s | `forge-control-web/app/desktop/settings/accountRegistry.tsx:107-134` |
| `HEALTH_STYLE` maps `unknown` → amber, and says so in a comment | `accountRegistry.tsx:72-79` |

So the data required by R45 **is already on the wire**. Nothing was missing from the API; the row
simply never rendered the two timestamps as an *age*, and the health word carried no clock.

---

## 7. Defects this determination establishes, before any code

**D1 — the health word has no clock (R45).** `AccountCard` renders `HEALTH_STYLE[a.health].label`
(`accountRegistry.tsx:175, 206`) with no indication of when that verdict was reached. `LAST PROBED`
exists as a field (`:267`) but sits below the fold of the collapsed row, and the collapsed row — the
only thing visible until Konrad clicks — carries the health word alone.

**D2 — a stored `healthy` can outlive its probe (R45 invariant, R57).** `AccountCard` and the row
chip both key off `a.health` alone. If `last_probed_at` were NULL while `health` read `healthy`, the
UI would render green. Nothing in the render path prevents it. The fix belongs at the boundary that
owns the data, not in each renderer.

**D3 — `POST /api/accounts` swallows its own probe (R46 fail condition, N1).**
`routes/accounts.ts:182` is `await probeAccount(created).catch(() => {})`. The registration probes,
then discards any failure and returns whatever `getAccount()` finds — which, if the probe threw, is
the bare `unknown` / `'created — awaiting first probe'` insert with **no explanation of why**. That is
"accepts a directory without probing it" wearing a probe's clothes, and it is a textbook N1 silent
fallback.

**D4 — `IDENTITY` is configuration presented as verification.** `arved.login_email` is
`media.asphaltaction@gmail.com`, a value written by `patchAccount()`'s `loginEmail` field
(`db/claude-accounts.ts:191`) — **not** returned by any probe. The cheap-tier probe reads presence
only (`lib/accounts.ts:42-80`); it never learns an email. `AccountCard` labels it `IDENTITY`
(`accountRegistry.tsx:261`), which reads as *verified*. Per `02-architecture.md` §3 — *"`identity`
comes from the probe response, never from configuration"* — this must be labelled as configured, not
silently upgraded. The honest fix within this phase's no-migration constraint is **to label it**, not
to invent a probe that could return it.

**D5 — no add flow exists in the UI at all.** `ConnectionsPanel.tsx` renders one `Row` per existing
account and an `Empty` when there are none (`:152-169`). There is no control anywhere that reaches
`POST /api/accounts`, and no place that shows the `reauth_command` for an account that is not already
`broken` (`accountRegistry.tsx:292`).

**D6 — priority is display-only (R47).** `AccountCard` renders `PRIORITY` as a static `Field`
(`accountRegistry.tsx:278`). `PATCH /api/accounts/:slug` accepts `priority`
(`routes/accounts.ts:144-146`) and `useAccountRegistry().act(slug, "toggle", body)` can carry it
(`accountRegistry.tsx:136-156`) — the route and the client both support it and no control invokes it.

---

## 8. What is explicitly NOT wrong

- **The database split is correct and enforced.** `getPool()` refuses to fall back to `content_forge`
  (`db/claude-accounts.ts:41-50`). Do not add a default.
- **Reading a stored health instead of probing per run is correct.** Probing on the run path would
  add a filesystem read and a registry write to every run for a verdict that changes every 10
  minutes at most. The fix is a visible probe age, not a live probe.
- **`expiresAt` is correctly excluded from health.** See §4.
- **`last_error` is already verbatim.** `markAuthFailure()` stores the upstream message truncated to
  2000 chars and applies no friendly rewriting (`db/claude-accounts.ts:169`). R58 is therefore a
  *rendering* requirement here, not a storage one — the verbatim text exists and
  `AccountCard:319-330` already prints it. What is missing is that the collapsed row, the only thing
  visible before a click, does not.

---

## 9. Read-only compliance

Every statement in this document was produced by `SELECT`, `\d`, `stat`, `pm2 jlist`, or reading a
file in this worktree. **No `UPDATE`, `INSERT`, `DELETE` or DDL was issued against `ai_os` at any
point**, per the explicit read-only brief. No token material was printed, logged or committed —
§4 shows key names and byte lengths only.
