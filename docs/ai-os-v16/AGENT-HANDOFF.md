# Agent handoff — Personal AI OS, post-migration to `AI-Operating-System` repo

_Written 2026-06-21, end of session that shipped v1.6 phase 1 + phase 2.
You (the new agent) are picking up after Konrad migrated the AI OS code
out of the `content-forge` monorepo into its own dedicated repository
(`github.com/konradschrein-star/AI-Operating-System`)._

**Read this entire file before touching anything.**

---

## What this thing is

Personal AI OS Console — Konrad's "one pane of glass" for his fleet. It is
the control surface; it is NOT content production itself. It controls and
observes:

- **Content Forge** — separate codebase (`content-forge` repo, deployed to
  `/opt/content-forge` on the VPS). Long-running video production engine
  (PostgreSQL + BullMQ + FFmpeg + Remotion + AI33 + claude-pool, ~19 PM2
  services).
- **Hermes** — separate stack (`/opt/hermes-control-plane`, `/opt/hermes-workspace`
  on VPS). The cc-\* Claude-fleet that does the work. AI OS surfaces its
  escalations / approvals / anomalies as Inbox items, and routes Konrad's
  decisions back as `hcp.agent_message` rows.
- **Adjacent app constellation** — claude-pool (self-hosted Claude Opus 4.7
  API at :8092), forge-api (VEO Studio wrapper), gemini-pool, auto-browser,
  etc. Most of these are read-only from AI OS's perspective.

**Live URL:** https://os.schreinercontentsystems.com (TLS via Let's
Encrypt, nginx → 127.0.0.1:7701 forge-control-web → /api/proxy/\*
rewrites to 127.0.0.1:7700 forge-control).

**Mantra:** AI OS _controls_ the fleet, it is not part of the fleet. The
boundary between AI OS and Content Forge must remain clean. The reason
this repo exists is that they were entangled before — don't re-entangle.

---

## What was shipped this session

Three commits, all pushed to `content-forge` repo branch
`feat/political-commentary-reactor` and deployed to the VPS:

1. **`98b8aaff` — v1.6 phase 1: timeout/stuck/resume + guardrails + Enter sends**
   - `forge-control/src/executor.ts`: default timeout 180s → 600s; per-run
     override via `runs.metadata.timeout_ms` (clamped 30..1800s); on
     timeout marks `stuck` (not `failed`) + appends `stuck_notice` system
     turn; manager loop now also runs `stuckWatchdogTick` flipping stale
     `running` rows to `stuck` after 90s of no heartbeat; pre-flight
     `evaluateGuardrails(category:financial, spend.per_run_cap, runtime.pause_all)`
     before every claude-pool POST.
   - `forge-control/src/routes/chat.ts`: new `POST /api/chat/:id/resume`
     route. Only valid when `status='stuck'`. Appends a `[continue marker]`
     SYSTEM turn (Konrad-approved phrasing) and flips status to `queued`.
     `buildPromptFromThread` already surfaces system turns as `[SYSTEM]`
     blocks to claude-pool.
   - `forge-control-web/app/desktop/ChatSurface.tsx`: Enter sends,
     Shift+Enter newline, IME `isComposing` respected. Sticky auto-scroll
     (only yanks to bottom within 120px). Resume button when `status='stuck'`.
   - `forge-control-web/app/api.ts`: `resumeChat()` binding.
   - `forge-control-web/app/globals.css`: thin accent scrollbar (later
     superseded by Phase 2's v2.css global scrollbar — see commit `7ca840f0`).

2. **`d359f6c4` — fix(executor): split completeRun into two queries**
   - Caught by smoke. Postgres refused to bind `$3` simultaneously as
     `status = $3` (enum target) and `$3::text` in the same query
     (`inconsistent types deduced for parameter $3`). Fix: branch in JS
     instead of SQL — one query for `stuck`, one for `completed`/`failed`.
   - **This pattern matters for any future executor change.** Don't
     reintroduce CASE expressions that reference the same `$N` as both an
     enum-target binding and a text cast.

3. **`7ca840f0` — v1.6 phase 2: lift V2 design system from apps/hub-web**
   - `forge-control-web/app/v2.css` (NEW, 380 LOC) — lifted from
     `apps/hub-web/src/app/(authenticated)/v2.css` (Apache-2.0). Provides
     design tokens (`--v2-accent`, `--v2-surface-1..4`, `--v2-text-1..3`,
     etc.), button classes (`.v2-btn`, `.v2-btn-accent`, `-outline`,
     `-warn`, `-danger`, `-ghost`), interactive effects (`.v2-glow`,
     `.v2-card-hover`), form classes (`.v2-input`, `.v2-select`), and a
     global thin scrollbar.
   - **One deliberate change vs hub-web:** default `--v2-accent` is
     overridden from Hermes lime (`#aaff00`) to AI OS blue (`#5b8def`,
     rgb 91,141,239) so the lift is visually non-disruptive. Lime,
     purple, teal, orange, blue, green themes are all available via
     `.theme-lime` / `.theme-purple` / etc. class on `<html>` or any
     ancestor.
   - `forge-control-web/app/layout.tsx`: imports v2.css after globals.css.
   - `forge-control-web/app/_components/` (NEW dir, 4 files):
     - `GlassCard.tsx` — frosted card primitive.
     - `V2Button.tsx` — themed button (default/accent/outline/ghost/warn/
       danger × sm/md/lg). **Inline-style only** (no Tailwind), unlike
       hub-web's original — see "design rules" below.
     - `V2Card.tsx` — solid-surface card.
     - `PulseStatusBadge.tsx` — colored pill with optional animated dot
       (mirrors hub-web's STATUS_MAP).
   - `forge-control-web/app/desktop/ChatSurface.tsx`: stripped
     `className="scroll-tinted"` since v2.css does scrollbar globally.
   - `forge-control-web/app/globals.css`: dropped the .scroll-tinted block.

**Phase 2 didn't yet REPLACE any ad-hoc inline buttons / cards with the new
primitives** — that lands incrementally in Phase 3 (inbox) and Phase 4
(chat). Phase 2 was foundation only.

---

## What was about to start (and is still on the table) — Phase 3

**Spec:** `docs/ai-os-v16/inbox-rich-card.md` (verbatim plan, ~500 words
incl. ASCII mockup and file edit list).

**Goal:** Replace the thin "APPROVAL: title / [Approve] [Deny]" inbox card
with a rich preview showing video player, scene thumb strip, stats grid,
and Deny-with-reason inline. Konrad's complaint that triggered this work:
_"I want to see more data. I want to see a preview. I want to see the
video. I want to see some stats about it and not just approve or deny."_

**Key facts already established by the audit subagent:**

- `inbox_items` table already has `related_job_id` wired — it's just not
  JOIN-ed in `listOpenInbox` or `getInboxItemPreview` (the latter doesn't
  exist yet, you build it).
- The final video lives at
  `${LOCAL_MEDIA_ROOT}/${channel_id}/${job_id}/final_video.mp4` on the
  **same VPS** as `forge-control`. `content_jobs.r2_asset_manifest` is a
  historical misnomer; entries have `storage_tier:'local'`. **Do not
  build R2 / S3 signed-URL infrastructure** — stream from local FS with
  Range support, mirror the pattern in
  `apps/hub-web/src/app/api/drama/[id]/file/route.ts` (you may not be
  able to read content-forge's hub-web from the new repo — see the
  pattern recap in `inbox-rich-card.md`).
- API contract is already defined — see `InboxPreview` interface in
  `docs/ai-os-v16/inbox-rich-card.md`. ~50 KB payload cap; scene strip
  capped at 60 entries (SPACE_VIDEO can have 400+ scenes — sample
  every Nth).
- File edit list is in the spec. New route file: `forge-control/src/
routes/media.ts` (mounted at `/api/media`). Range support required.
- Reason field on Deny — extend `POST /inbox/:id/resolve` body to
  accept `resolution.reason: string`. UI must require it for Deny only.

**Use the Phase 2 primitives:** `GlassCard` for the preview frame,
`V2Card` for the stats grid, `V2Button` (accent/danger) for Approve/Deny,
`PulseStatusBadge` for the format/state header pill.

**The big question only you and Konrad can answer:** the **proxy / media
streaming auth model**. forge-control-web is the NextAuth-gated public
edge (port 7701). forge-control is the backend (port 7700, bound to
127.0.0.1). Range-streaming a 100 MB MP4 through Next.js's API route
will buffer — you want to either (a) add a passthrough rewrite in
`next.config.mjs` for `/api/proxy/media/*` that proxies bytes without
Next handling them, or (b) put nginx in front of media and reuse the
session cookie. The spec mentions risk #2; pick a path with Konrad
before writing code.

---

## Current production VPS state

**SSH:** `root@65.108.6.149` with key
`//wsl.localhost/Ubuntu/home/konra/.ssh/content-forge-key` (or wherever
Konrad's local key lives on your machine). Read-only by default;
ask before destructive ops.

**Filesystem:**

- `/opt/forge-ai-os/` — AI OS code on VPS. **After migration this should
  become a clone of `AI-Operating-System` instead of `content-forge`**.
  Verify the remote before pulling. The directory layout in the new repo
  is whatever Konrad set up — could be `forge-control/` + `forge-control-web/`
  at the root (matches current), or restructured. **Check with `ls
/opt/forge-ai-os` and `cat /opt/forge-ai-os/package.json` before
  running anything.**
- `/opt/content-forge/` — Content Forge monorepo. **DO NOT TOUCH for AI
  OS work.** It has its own uncommitted work and is a separate
  responsibility (other agents are working on comparison-renderer,
  political-commentary-reactor, etc.). The only legitimate AI OS use
  of /opt/content-forge is: streaming a final-render MP4 from
  `${LOCAL_MEDIA_ROOT}/${channel_id}/${job_id}/final_video.mp4` for
  inbox preview. **Read-only.**
- `/opt/hermes-control-plane/` — HCP backend. Edits in place (not a git
  repo). Build with `./node_modules/.bin/tsc --build --force`,
  restart with `pm2 restart hermes-control-plane` (id 11). Honors
  `content_forge.fleet_state.is_paused` for dispatcher freeze.
- `/opt/auto-browser/` — Docker stack (controller :8000, noVNC :6081,
  VNC :5901). 35 MCP browser tools. Don't touch unless you're adding
  browser-driven workflows.

**PM2 fleet (relevant IDs):**

- **18 — forge-control** — Hono backend on 127.0.0.1:7700
- **19 — forge-control-web** — Next.js 15 on 127.0.0.1:7701
- **21 — forge-executor** — drains `content_forge.runs`, calls
  claude-pool, runs manager loop + watchdog
- 15 — claude-pool — port 8092, `x-api-key` header (read from `pm2 env 15`,
  never bake key in source)
- 11 — hermes-control-plane
- 16 — forge-api (VEO Studio wrapper)
- 9 — hermes-workspace
- 0 — pm2-logrotate (module)

After AI OS migration: PM2 entries 18/19/21 should still exist; the
underlying paths may need re-pointing to the new clone. If you `pm2
delete forge-*` you'll need to re-register from `ecosystem.config.cjs`
— confirm with Konrad before doing this.

**Database:**

- `content_forge` (PG, 127.0.0.1:5432, user `postgres`, password
  `content_forge_prod`) — AI OS reads/writes its own tables (`fleet_state`,
  `inbox_items`, `decisions`, `runs`, `guardrail_rules`, `guardrail_trips`,
  `connector_configs`, `knowledge_embeddings`) but **also reads
  content-forge tables** for cross-cuts (job preview JOINs, fleet status
  reads, decision-log feeds). This dual ownership is the price of having
  AI OS cleanly separated at the code level while leaving the DB shared.
  Migrations live in `packages/db/src/migrations/0021_ai_os_tables.sql`
  and `0022_inbox_items_external_id.sql` (within content-forge before
  migration; new repo will need its own migration runner pointing at the
  same DB).
- `hcp` (separate DB) — HCP's own state. AI OS reads via secondary pg
  pool with `HCP_DATABASE_URL`. Manager loop mirrors
  `hcp.agent_message` (intent ESCALATE / APPROVAL_REQUEST / ANOMALY,
  7-day window) into `inbox_items` via `external_id = 'hcp:' + msg_id`.
  Inbox resolution writes a reply row back to `hcp.agent_message` with
  intent map: APPROVAL_REQUEST→APPROVAL_DECISION, ESCALATE→ANSWER,
  ANOMALY→CHAT.

**Env vars the AI OS processes need** (set in pm2 ecosystem, NOT
checked into source):

- `DATABASE_URL` — content_forge connection (default
  `postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge`)
- `HCP_DATABASE_URL` — hcp connection (default
  `…@127.0.0.1:5432/hcp`)
- `CLAUDE_POOL_URL` — `http://127.0.0.1:8092` (default ok)
- `CLAUDE_POOL_API_KEY` — read from `pm2 env 15` at deploy time, NEVER
  bake into source. Memory note: `feedback-claude-code-vps-auth.md`.
- `RUN_TIMEOUT_MS` — default 600000 (10 min). Per-run override via
  `runs.metadata.timeout_ms`.
- `HEARTBEAT_STUCK_THRESHOLD_MS` — default 90000.
- `LOCAL_MEDIA_ROOT` — Phase 3 needs this. Find current value with
  `pm2 env 1` or `pm2 env 17` (worker-render / worker-orchestrator).

**Smoke test pattern** (use this for every phase):

```bash
ssh -i KEY root@65.108.6.149 "cd /opt/forge-ai-os && git pull --ff-only \
  origin <branch> && cd forge-control-web && pnpm install \
  --ignore-workspace && pnpm build && pm2 restart forge-control-web \
  forge-control forge-executor"
# Then hit forge-control direct on 127.0.0.1:7700 (bypasses NextAuth)
ssh -i KEY root@65.108.6.149 "curl -s http://127.0.0.1:7700/api/<endpoint>"
# And forge-control-web through nginx on https://os.schreinercontentsystems.com
```

**Known-good chat smoke** (validates the v1.6 phase 1 stack end-to-end):

```bash
curl -s -X POST http://127.0.0.1:7700/api/chat -H 'content-type: application/json' \
  -d '{"prompt":"reply with PONG and nothing else","title":"smoke"}'
# returns {"run":{"id":"...","status":"queued",...}}
# Wait ~20s, fetch /api/chat/<id> — should be status:completed with assistant:PONG
```

---

## Standing user preferences and confirmed approvals

From conversation history (Konrad-confirmed, not invented):

- **Resume semantics (confirmed 2026-06-21):** `/resume-run` injects a
  `[continue marker]` SYSTEM turn — `"Resume from where you stopped. Do
not repeat what you already produced; pick up from the last partial
assistant turn."` — then flips status to `queued`. Don't strip the
  partial; don't re-feed the original prompt as-is. The marker stays in
  the thread as historic context.
- **5-phase v1.6 plan (approved 2026-06-21):** Phase 1 ✅, Phase 2 ✅,
  Phase 3 ⏸️ (interrupted by migration), Phase 4 (chat overhaul), Phase 5
  (memory GraphRAG). Don't reorder without asking.
- **Money permissions:** _"permissions are basically infinite for now,
  apart from that this thing is basically free to roam and should not
  be restricted. I don't want it to drain my bank account randomly."_
  — Translation: take initiative; respect `guardrail_rules.spend.*`
  caps; flag spend that looks unusual before proceeding.
- **VPS-first:** _"we want all of this to be on the VPS, my pc is
  irrelevant here."_ — Even though Phase 1 + 2 edits happened on
  Konrad's local PC (and pushed to GitHub then pulled on VPS), the
  long-term goal is local-PC-independent. After migration, prefer
  editing directly on VPS via SSH for hot iteration; commit to
  AI-Operating-System repo from VPS so the git history is authoritative.
- **No synthetic / estimated fallbacks** (memory:
  `feedback-no-synthetic-fallbacks.md`). If pipeline data is missing,
  throw a hard error. Don't paper over.
- **No Edge TTS in prod** (memory: `feedback-tts-providers.md`).
  Doesn't apply to AI OS directly but Konrad's broader rule.
- **OAuth only on VPS Claude Code** (memory:
  `feedback-claude-code-vps-auth.md`). Never set `ANTHROPIC_API_KEY`
  env var on cc-\* workers.
- **No commits unless explicitly asked OR working autonomously on a
  multi-phase plan that's already been approved.** The v1.6 plan is
  approved; commits per phase are expected. Pushing to a NEW
  destination (different repo / different branch) needs to be confirmed.
- **Don't touch `/opt/content-forge` on VPS** for AI OS work. Read-only
  observe. (Exception: streaming a final-render MP4 for inbox preview.)

---

## V2 design system rules (Phase 2 established these)

- **Inline styles only in React components.** No Tailwind utility
  classes in `forge-control-web/app/_components/` or elsewhere in
  `forge-control-web`. The `tokens.ts` map at `forge-control-web/app/tokens.ts`
  is the canonical token source (still exists alongside the CSS
  variables from `v2.css` — both work, prefer `var(--v2-*)` for new
  code).
- **The four primitives are the building blocks:** `GlassCard`,
  `V2Button`, `V2Card`, `PulseStatusBadge`. Don't reinvent these
  inline. Don't introduce new component-level CSS files; extend
  `v2.css` if you need new global classes.
- **Material Symbols** are already linked in `layout.tsx`. Use
  `<span className="material-symbols-outlined">icon_name</span>`.
- **Hermes themes** (lime, purple, teal, orange, blue, green) are
  available via `.theme-*` class on `<html>` or an ancestor. Default
  is AI OS blue. Don't change the default without asking.
- **Color tokens** — `--v2-accent`, `--v2-success`, `--v2-warning`,
  `--v2-error`, `--v2-text-1..3`, `--v2-surface-1..4`, `--v2-border-0..3`.
  See `forge-control-web/app/v2.css` for the full set.

---

## What the agent before you (me) was about to do — and why I stopped

I had just finished reading
`forge-control/src/routes/inbox.ts` and grep-ing
`forge-control/src/db/ai_os.ts` for `listOpenInbox` / `resolveInbox` to
start Phase 3 (the inbox rich card). Specifically I was about to:

1. Add `getInboxItemPreview(itemId)` to `forge-control/src/db/ai_os.ts`
   — ~110 LOC, JOIN on `inbox_items.related_job_id → content_jobs`,
   shape the payload per the `InboxPreview` interface in
   `docs/ai-os-v16/inbox-rich-card.md`.
2. Add `GET /api/inbox/:id/preview` to `forge-control/src/routes/inbox.ts`
   — ~25 LOC, UUID guard, 404 if no related_job_id.
3. Add `forge-control/src/routes/media.ts` — ~120 LOC, Range-stream
   `${LOCAL_MEDIA_ROOT}/${channel_id}/${job_id}/final_video.mp4` + scene
   thumbs. Mount at `/api/media` in `forge-control/src/index.ts`.
4. Extend `forge-control-web/app/api.ts` — `fetchInboxPreview(id)`,
   `resolveInboxItem(id, payload + reason)`.
5. Refactor `forge-control-web/app/desktop/DesktopApp.tsx`
   `InboxSurface` (around lines 1186–1440) — extract `InboxDetail`
   subcomponent, render the new preview using `useQuery`. Mobile
   equivalent in `forge-control-web/app/MobileApp.tsx` `InboxScreen`
   (around line 480+).

**Why I stopped:** Konrad sent _"Ok I have to migrate our AIOS since I
accidentally entangled it with the Content Forge"_ and asked me to
write this handoff so the next agent doesn't destroy his migration
in flight.

**You should NOT start Phase 3 until:**

- Konrad confirms the new repo is in a buildable state on VPS at
  `/opt/forge-ai-os`.
- You verify `pm2 list` still shows forge-control / forge-control-web /
  forge-executor online and on the new code.
- You run the known-good chat smoke (above) and get a `completed` run
  with `assistant: PONG`.
- You and Konrad agree on which file path becomes the "media" router
  (probably `<new-root>/forge-control/src/routes/media.ts` if the
  layout is preserved, but verify).

---

## Don't destroy

1. **The three commits already on `content-forge` `feat/political-commentary-reactor`.**
   They might be migrated by Konrad as 1:1 commits OR squashed into a
   single "v1.6 initial state" commit on the new repo's `main`. Either
   way: every line of those three commits is intentional and was
   smoke-tested in production. Don't rewrite them defensively.
2. **The continue-marker phrasing.** Konrad approved it verbatim. Don't
   rewrite "Resume from where you stopped. Do not repeat what you
   already produced; pick up from the last partial assistant turn."
3. **The SQL split-query pattern in `completeRun`.** Don't refactor it
   back to a single `CASE` query. The Postgres type binding will break.
4. **`/opt/content-forge` on the VPS** — separate codebase, separate
   responsibility, separate agents in flight on it.
5. **Cross-DB env vars** — `HCP_DATABASE_URL` and (if used) any pointer
   to a third DB. AI OS reads multiple databases through separate pools.
6. **Watchdog SQL** — uses `interval '1 millisecond' * $1`. The
   alternative (`($1 || ' ms')::interval`) doesn't work cleanly because
   pg deduces $1 as text and the join with `now() - …` complains.
7. **Material Symbols + Inter + JetBrains Mono links in `layout.tsx`.**
   If you swap them out for self-hosted, do it explicitly with Konrad's
   sign-off (offline first-paint matters at the VPS edge).
8. **`/api/proxy/*` rewrite in `forge-control-web/next.config.mjs`.**
   That's how the frontend reaches the backend through NextAuth.
   Phase 3's `/api/media/*` path WILL need either a new entry here or
   a different access pattern.

---

## Memory pointers (claude-code memory dir)

If you have access to Konrad's memory (`C:\Users\konra\.claude\projects\C--Users-konra-OneDrive-Projekte-20260330-Content-Forge\memory\`),
these are the relevant entries for AI OS work:

- `project-ai-os-shipped-mobile-desktop.md` — v1.5 + v1.6 phase 1
  shipping summary. Should be updated for phase 2 + (when you get
  there) phase 3.
- `project-ai-os-build-pending.md` — original v1 brief.
- `project-auto-browser-pending.md` — browser MCP integration.
- `reference-claude-pool.md` — claude-pool API contract.
- `reference-gemini-pool.md` — gemini-pool API contract.
- `reference-ai33-api.md` — AI33 endpoints (used by Content Forge, not
  AI OS directly).
- `feedback-claude-code-vps-auth.md` — OAuth not API key on VPS.
- `feedback-no-synthetic-fallbacks.md` — throw, don't paper over.
- `feedback-tts-providers.md` — no Edge TTS in prod.

If you don't have memory access in the new repo's working directory,
these notes don't auto-load. Either Konrad will surface what's
relevant, or you'll need to ask before assuming.

---

## TL;DR for "I just landed in the new repo, what do I do"

1. Read this file end-to-end (you're here).
2. Read `docs/ai-os-v16/inbox-rich-card.md` (Phase 3 spec).
3. Read `docs/ai-os-v16/chat-overhaul.md` (Phase 4 spec) and
   `docs/ai-os-v16/backend-hardening.md` (the remaining v1.6 backend
   work the audit surfaced).
4. SSH to VPS, run the known-good chat smoke, confirm Phase 1 + 2 are
   live on `/opt/forge-ai-os` after Konrad's migration.
5. Ask Konrad: "Confirmed AI OS is live on the new repo. Phase 3 (inbox
   rich card) was paused at the spec stage — want me to start it now,
   or is there something else higher-priority post-migration?"
6. Do NOT autonomously start Phase 3 until Konrad green-lights it
   post-migration. The migration may have introduced changes you
   need to absorb first (new directory layout, new repo's lockfile,
   etc.).

Good luck. Don't break the chat — Konrad uses it every day.
