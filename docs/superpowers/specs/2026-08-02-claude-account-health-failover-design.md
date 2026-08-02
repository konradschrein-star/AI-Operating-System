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

The AI OS gets its own table in the `ai_os` database. It does **not** read
`content_forge.llm_pool_accounts` — the repo split exists to stop cross-DB reads, and the two
services have genuinely different consumers.

```sql
CREATE TABLE claude_accounts (
  slug            TEXT PRIMARY KEY,
  config_dir      TEXT NOT NULL,          -- CLAUDE_CONFIG_DIR for the child. Never a secret.
  plan_label      TEXT,                   -- 'max_20x' | 'max_5x' | free text
  priority        INTEGER NOT NULL DEFAULT 100,  -- lower wins
  enabled         BOOLEAN NOT NULL DEFAULT true,
  health          TEXT NOT NULL DEFAULT 'unknown',  -- healthy|expiring|broken|unknown
  health_detail   TEXT,                   -- human-readable reason
  expires_at      TIMESTAMPTZ,            -- parsed from the credential file
  last_probed_at  TIMESTAMPTZ,
  last_ok_at      TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Seed rows: `root` → `/root/.claude` (max_20x, priority 10), `claude-worker` →
`/home/claude-worker/.claude` (max_5x, priority 20). The third account is added through the
settings UI once its config dir exists — the design does not invent a path for it.

Migrations are hand-written (drizzle-kit generate is broken in this stack).

---

## 5. Health probing

A prober runs in `forge-control` on a 10-minute interval and on demand from the settings page.

### 5.1 Cheap tier — credential file inspection

Reads `<config_dir>/.credentials.json` and classifies:

| Condition | State |
|---|---|
| file missing / unparseable | `broken` (`"no credential file"`) |
| access token empty **or** `expiresAt === 0` | `broken` (`"credentials blanked — re-login required"`) |
| `expiresAt` in the past, no refresh token | `broken` (`"expired, no refresh token"`) |
| `expiresAt` within 7 days | `expiring` |
| otherwise | `healthy` (pending live confirmation) |

This tier alone would have caught **both** real failures — the June death and the August one.

### 5.2 Live tier — confirm the token is honoured

A token can be present and well-formed yet revoked. Once per hour per account, spawn
`claude -p --model haiku` with a trivial prompt and `CLAUDE_CONFIG_DIR` set, with a short
timeout. Auth failure → `broken`. Rate-limit response → **leave health unchanged** (a busy
account is not a broken one). Any other error → `unknown`, never `healthy`.

### 5.3 The `unknown` state

`unknown` means not-yet-probed or probe-inconclusive. It renders amber in the UI, is never
counted as healthy, and an account in `unknown` is usable but ranked below `healthy`
candidates. Never collapse `unknown` into `healthy`.

---

## 6. Selection and failover

### 6.1 Selection

At run start, `cc-runner` calls `resolveAccount()`, which returns the enabled account with
the best health rank, tie-broken by lowest `priority`. The rank is:

```
healthy == expiring  >  unknown  >  (broken: excluded entirely)
```

`expiring` ranks **equal to** `healthy`, not below it. An account with six days left is
fully working; demoting it would shift load onto a less-proven account for no reason and
would make the 7-day warning self-fulfilling. `expiring` is a signal to Konrad, not an
instruction to the scheduler. The chosen
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

- → `expiring` (7 days out, and again at 24 hours): warn, include the account slug and the
  exact re-login command.
- → `broken`: page immediately, same content.
- → `healthy` after being broken: a short recovery confirmation, so a fix is visibly confirmed.

Message bodies carry the copy-pasteable command, e.g.
`sudo -u claude-worker env HOME=/home/claude-worker claude /login`.

This is what converts a two-month silent outage into a Tuesday notification.

---

## 8. Settings route

`forge-control-web/app/settings/page.tsx` — a real Next.js route. The sidebar `settings` nav
item navigates to it instead of switching a client-side surface. The current `settings` entry
in `PLACEHOLDER_SURFACES` (a hardcoded mockup with an icon list) is deleted.

The page shows one card per account:

- slug, plan label, config dir
- health badge (green healthy / amber expiring or unknown / red broken) with the reason text
- expiry countdown, last probed, last OK
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
- Cheap-tier classification — fixture credential files: blanked (today's exact shape),
  expired-no-refresh, expiring-soon, healthy, missing, malformed.
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

1. The third account: does a config dir exist for it anywhere, or does it need a first-time
   `claude /login` into a new directory?
2. Should `claude-pool` (Content Forge) eventually consume this same registry over HTTP
   rather than keeping its own `CLAUDE_POOL_ACCOUNTS` env mirror? Out of scope here; worth
   deciding before the two drift further.
