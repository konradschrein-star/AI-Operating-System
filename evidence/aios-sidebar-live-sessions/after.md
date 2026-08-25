# aios-sidebar-live-sessions — round 3: after-evidence

**Date:** 2026-08-25, ~01:50–02:00 UTC (capture), resumed and finished 2026-08-26 after a
subscription-usage pause parked the run overnight — nothing changed in the worktree across the
pause. **Method:** real browser (Chromium via `/opt/hermes-workspace/node_modules/playwright`,
the same bundled `chromium-1234/chrome-linux64/chrome` before.md used), driving **this worktree's
own build**, never the live console. **Read-only.** No file in `/opt/forge-ai-os` was edited,
built, or restarted; `pm2 restart forge-executor`/`forge-control` was never run; no
control (stop/dismiss/project-switch) was clicked.

## Which tree the pixels came from, and how I know

Every screenshot in this document is `forge-control-web` built from this worktree's `HEAD`,
**`2b4b3eb9a1517d277c9ad637af4731e462e3e7e9`** (`feat(sidebar): LIVE SESSIONS…`), stacked on
`3e63a45` (`feat(team): every live node says which engine and what it is doing`) — the two commits
this round is supposed to photograph. Checkable independently: `git -C
/opt/ai-os/workspace/projects/fb3b5fb2-26cb-463b-9830-ba0b27b6a145 rev-parse HEAD` returns that
SHA, and the working tree was clean (`git status` → nothing to commit) for the entire capture
session — no uncommitted edits could have leaked into the build.

**The serving chain, entirely inside the worktree, nothing borrowed from `/opt/forge-ai-os` or
live `:7700`/`:7701`:**

```
Playwright (cookie-authenticated)
  → next start -p 7793   (this worktree's forge-control-web, built with
                           FORGE_CONTROL_URL=http://127.0.0.1:7899)
      → :7899 fixture-overlay (read-only, 405 on non-GET; serves ONE fixture
                                path, proxies everything else to :7798)
          → :7798 scripts/checks/serve-v3-7798.ts (THIS worktree's own
                    chat/agents/projects/capabilities/secrets/uploads
                    routers, mounted directly — not imported from
                    /opt/forge-ai-os; everything unmounted proxies to live
                    :7700, read GETs only, per forge-control-probe-single-router.md)
```

`serve-v3-7798.ts` is the fleet's existing, shared read-only harness (used by prior rounds too);
I did not edit it. The one new piece is `/tmp/fixture-proxy-7799.mjs` (a throwaway, not part of
this round's write-set — see disclosure at the end), which exists only to answer one synthetic
chat id used for capture 2 below; every other path it sees proxies straight through to `:7798`
verbatim, and it 405s any non-GET before routing anything.

**Sign-in:** `@auth/core`'s `encode()`
(`forge-control-web/node_modules/.pnpm/@auth+core@0.37.2/node_modules/@auth/core/jwt.js`),
`secret` = `AUTH_SECRET` from this worktree's `forge-control-web/.env.local` (copied read-only
from the live checkout's `.env.local` — the worktree ships none — never written back), `salt` =
bare `authjs.session-token` (no `__Secure-` prefix, because `AUTH_URL` was overridden to this
throwaway server's own `http://127.0.0.1:7793`, per `authurl-https-forces-secure-cookie-over-plain-http.md`
— inheriting the live checkout's `https://` `AUTH_URL` would otherwise silently demand the
prefixed cookie name over plain http). Every capture asserts `page.url().endsWith("/desktop")`
before being trusted, per `stale-session-cookie-fakes-a-perfect-score.md` — all landed correctly,
no `/signin` redirect anywhere in this round. Chat selection is `localStorage['forge.chat.selected']`
(a JSON-encoded chat-id string) plus `forge.desktop.surface = "chat"`, set via
`page.addInitScript()` before `page.goto()`, per `real-client-network-capture-recipe.md`.

`page.goto(..., { waitUntil: "networkidle" })` never fires on this app — `/desktop` opens a
long-lived `secret-events` SSE stream on load, which the browser correctly treats as ongoing
traffic forever, so `networkidle` hangs to its 30s timeout. Switched to `waitUntil: "load"` plus
an explicit wait for `[data-team-panel]`/`[data-live-sessions]`. Noting this because it cost one
full timeout to discover and isn't written down anywhere yet — added as a new memory note,
`networkidle-never-fires-on-desktop-sse.md`.

## Screenshots

All saved to `/opt/ai-os/uploads/c7dcc38a9397/` and read back with the `Read` tool before being
cited here. Viewport `1600×2400` throughout, matching before.md.

1. **`/api/uploads/c7dcc38a9397/20260825T015710853Z-live-sessions-linked-light.png`** — real live
   LIVE SESSIONS block, linked chat (`2ef126b7…`), light theme.
2. **`/api/uploads/c7dcc38a9397/20260825T015718338Z-live-sessions-linked-dark.png`** — same chat,
   dark theme.
3. **`/api/uploads/c7dcc38a9397/20260825T015731961Z-money-shot-mixed-engine-fixture.png`** — mixed
   engine, see capture 2 below.
4. **`/api/uploads/c7dcc38a9397/20260825T015723581Z-picker-expanded-29-candidates.png`** — picker +
   overlap scan, see capture 4 below.
5. **`/api/uploads/c7dcc38a9397/20260825T015830796Z-unlinked-chat-single-note.png`** — unlinked
   chat, see capture 5 below.
6. **Plan split** (superseded set, v2 is the one to trust — see capture 6):
   `20260825T015945533Z-plan-split-before-drag-v2.png`,
   `20260825T015947072Z-plan-split-after-drag-v2.png`,
   `20260825T015948968Z-plan-split-after-reload-v2.png`.

## Capture 1 — the LIVE SESSIONS block with real live sessions: **done**

Chat `2ef126b7-d6d9-4a55-a8e7-d9acf0508645` (this project's own manager chat), light and dark.
Row read straight from the DOM (`[data-live-row]`), not eyeballed:

```json
{
  "engine": "claude-code",
  "status": "running",
  "model": "claude-sonnet-5",
  "title": "Integration: merge server, client, and harness workstreams to main",
  "activity": "Read",
  "age": "· 6s",
  "elapsed": "1m 05s"
}
```

`data-live-count="1"`. All five facts legible in both themes: engine badge, model, task title,
current activity + its own age, elapsed. Note the row's engine/model at the moment of THIS
screenshot (`claude-code` / `claude-sonnet-5`) differs from what was live in the SAME chat ~10
minutes earlier when I first scouted it (`agy` / `gemini-3.7-flash-high`, same task title,
`Integration: merge…`) — the fleet requeued that round's builder from Gemini to Claude in between;
not a bug in what I'm measuring, just the underlying system moving in real time.

## Capture 2 — the money shot: mixed engine in the same frame: **done, disclosed as a fixture**

**No live chat tree currently contains both a live claude-code row and a live agy row at once** —
checked by walking every `running`/`paused`/`stuck` row in `/api/agents` (60+ rows) and querying
each one's own `/api/chat/:id/team`: the two live Gemini rows found (`91bd84ad…`, paused;
`3cc4908e…`, stuck) each head their own single-node chat, with no Claude sibling in the same tree,
and the chat with the most candidates and most activity (`2ef126b7…`) had exactly one live row at
capture time. Per the brief's explicit fallback, I built the shot from **two real, currently-live
API captures**, merged into one `TeamResponse` — not fabricated field shapes, real ones:

- **manager** (claude-code): `id 8834241e…`, `model: claude-opus-5`, `status: running`,
  `engine: claude-code`, task "Sidebar scope toggle: this chat vs everything running" — captured
  live via `GET /api/chat/8834241e…/team` at 01:50 UTC.
- **workers[0]** (agy): `id 7c05e49d…`, `model: gemini-3.7-flash-high`, `status: running`,
  `engine: agy`, task "Integration: merge server, client, and harness workstreams to main" —
  captured live via `GET /api/chat/2ef126b7…/team` at the same time (this was the gemini row
  from capture 1's chat, ~10 minutes before it got requeued to Claude).

Every field on both nodes is the real value the live API returned for that node — nothing was
invented; only their assembly into one `TeamResponse` (`chat_id`, `project: null`, `workers: […]`)
is synthetic. Served from `chat_id
eeeeeeee-1111-4222-8333-444444444444` (a chosen sentinel id, not a real chat), by the 405-gated
overlay described above. Row-level readout, again from the DOM not by eye:

```json
[
  { "engine": "claude-code", "model": "claude-opus-5" },
  { "engine": "agy", "model": "gemini-3.7-flash-high" }
]
```

Both badges render in the same frame, correctly derived from `model` (the fixture's `engine`
fields were themselves already server-derived when captured, and the client badge component reads
`row.engine` verbatim — it does not re-derive from `model` a second time, by design, per
`engineBadge.ts`'s own contract with the server). The fixture also incidentally exercises the
"no project linked" empty state (`project: null`), visible once in the same screenshot.

## Capture 3 — both themes: **done**

Light and dark for the real linked chat (captures 1/1-dark above), and the money-shot fixture was
also taken in light. Not repeated per-capture below for brevity; every panel-visible capture in
this document was spot-checked and no color is broken in either theme.

## Capture 4 — project-linked chat with the picker expanded: **done, overlap re-confirmed clean**

Same chat and picker size as before.md's finding (`2ef126b7…`, now **29** candidates, was 28 at
round 0 — one more project seeded since). `[data-project-switcher] button` count = 29.

**Measurement, not eyeballing** — same clipped-`Range.getClientRects()` method before.md's
finding 1 established, scoped to `[data-team-panel]`:

```json
{ "boxCount": 217, "intersections": 0, "sampleHits": [] }
```

**Zero pairwise text-box intersections**, in the exact state Konrad's original complaint
describes (linked chat, picker rendered, live worker present). This is a **second** clean result
on this exact check, now against the ACTUAL round-2 code (before.md's round-0 measurement was
against pre-fix `main`; this one is against `2b4b3eb`, which the commit message says added a
density cap — `maxHeight`/`overflowY: auto` — to the picker's chip row).

**Unplanned but load-bearing corroboration.** While capturing the plan-split "before" screenshot
(01:59 UTC), a *different*, concurrently-running agent in this same chat (`2ef126b7…`) was live
debugging the exact same question from the opposite direction — Konrad had just attached a
screenshot of the **deployed `main`** console showing the picker overlapping the PLAN rows, and
that agent traced it live, in-thread, to: *"the switcher is a `flexWrap` container with no
`max-height` and no overflow handling… The fix already exists — on the branch, undeployed. The
lane bounded the switcher with `maxHeight: 62, overflowY: "auto"`. You're looking at deployed
`main`, which is still unbounded."* That is an independent, differently-sourced confirmation of
exactly this round's own conclusion: **the overlap is real on deployed `main` and already fixed on
this branch** — visible verbatim in the transcript captured incidentally inside
`20260825T015945533Z-plan-split-before-drag-v2.png` and
`20260825T015947072Z-plan-split-after-drag-v2.png` (main chat column, mid-page). I did not seed
this confirmation and could not have predicted it landing inside my own capture window; noting it
because it is real evidence, from a source I don't control, agreeing with the measurement above.

## Capture 5 — unlinked chat, note renders once: **done, but not on the chat before.md used**

before.md's unlinked chat, `3f03be16-436f-4adc-ba7f-90e661a7cda7`, **has since gained a project
link** (`aios-journal-thoughts-stats`, `link_source: metadata`) — confirmed live via
`GET /api/chat/3f03be16…/team` returning a non-null `project` today. Using it would have measured
"linked chat" evidence under an "unlinked" label. Re-picked a chat confirmed unlinked *right now*
(`ecf244a5-964c-4195-bfe0-7f09176827ec`, `project: null`, scanned across the 21 most-recent chats,
16 of which are currently unlinked). Count, by DOM text search, not by eye:

```json
{ "count": 1 }
```

`"no project linked to this chat"` appears **exactly once** — matches the commit's claim
("THE DUPLICATE NOTE IS GONE") and matches before.md's finding that this was working-as-designed,
just duplicated across two zones pre-fix. This chat's LIVE SESSIONS block correctly shows the
`EmptyNote` path too ("nothing running — every agent in this chat has settled",
`data-live-count="0"`) — a bonus confirmation the empty state renders cleanly, not asked for by
the brief but visible in the same screenshot.

## Capture 6 — the PLAN split still drags: **done**

Same chat (`2ef126b7…`), light theme. First attempt (files timestamped `…-plan-split-before-drag.png`
without `-v2`) took the "before" shot too early — right after `page.goto()`, before the panel had
hydrated real content (visible in that file: an empty "select a chat or create a new one" state) —
so it is **not** cited as evidence; the retry below (`-v2` suffix) waits for `[data-team-panel]`,
the resize handle, and the literal text "PLAN" before taking the reference shot.

| | localStorage `forge.layout.teamPlanFraction` |
|---|---|
| Before drag | `null` (default fraction, never persisted in this fresh browser context) |
| After drag (handle moved down 260px) | `0.28631394840402274` |
| After a full page reload | `0.28631394840402274` — **unchanged** |

The PLAN zone visibly grows between the before and after-drag screenshots (a thin collapsed strip
→ a full task board with `00-vision.md`'s tree and the PLAN DOCS list), and the after-reload shot
is pixel-equivalent to the after-drag shot — the value survives a reload, confirmed by both the
stored number and the rendered layout.

## Byte measurement — `GET /api/proxy/chat/:id/team`, steady state, real browser

Same chat and same method as before.md (`page.on('response')`, filtered to the exact pathname
`/api/proxy/2ef126b7-d6d9-4a55-a8e7-d9acf0508645/team`, through the app's own React Query poll —
not `page.evaluate(fetch(...))`, per `etag-304-needs-an-explicit-client.md`), over 200.98s
(> 3 minutes, per the brief).

| | before.md (round 0, pre-fix `main`) | this round (`2b4b3eb`) |
|---|---|---|
| Window | 195.1 s | 200.98 s |
| Requests | 20 | 20 |
| Requests/min | 6.15 | 5.97 |
| Bytes/response | 5,254–5,256 (flat) | 9,051–9,147 |
| Total bytes | 105,090 | 181,116 |
| **Bytes/min** | **32,323** | **54,070 (+67.3%)** |
| ETag / Cache-Control on any response | none | none |

**This raw number looks like a regression, and by the brief's own instruction I am not rounding it
away — but it is the wrong comparison to draw a conclusion from, and here is the isolated one
that answers "is it justified":**

Fetched the current `/team` response for this same chat (8,985 bytes) and mechanically stripped
every node's `engine`/`activity` fields (the two fields this round's server commit, `3e63a45`,
added) — recursively, manager + every worker + every subagent:

```
current response (with engine + activity): 8,985 bytes
same response, fields stripped:            8,577 bytes
feature's own marginal cost:                 408 bytes  (+4.8%)
live nodes in this tree right now: 1 / 10 total nodes
```

That +4.8% / +408B is in the same range the build commit itself measured on three other chats
(+6.2%/+311B, +8.0%/+430B, +15.3%/+772B) — consistent, and small, because the design is explicitly
bounded by the LIVE count (currently 1) and not the tree size (10 nodes here, up to 165 measured
elsewhere).

**The other ~3,440 bytes (roughly 90% of the size increase) is not this round's code — it is this
chat's tree growing.** Even with `engine`/`activity` stripped out entirely, today's response
(8,577 B) is 3,321 B bigger than before.md's 5,254–5,256 B baseline. `2ef126b7…` is Konrad's own
manager chat, actively used by the whole fleet; between before.md's capture (2026-08-25 ~00:24
UTC) and this one (~01:50–02:00 UTC same day, then finished 2026-08-26 after the pause) it
accumulated more workers (its tree is now 10 nodes, was ~4–5) and one more picker candidate
(29 vs 28). That growth is organic chat activity, not a consequence of anything built in this
project, and no round of this project should try to "fix" it by trimming an actively-growing
chat's tree.

**Verdict:** the feature is cheap and matches its own build-time claim; the observed 32,323 →
54,070 B/min delta is dominated by an unrelated confound (this specific chat's natural growth
over ~26 hours), not by the code this round is evidence for. A cleaner regression check next time
should either re-baseline on a smaller, less-actively-used chat, or repeat this round's
before/after-on-identical-tree isolation directly rather than diffing two different points in
time on a chat that keeps growing.

## What did not work, stated plainly

- The FIRST plan-split "before" shot (no `-v2` suffix) was taken before the page had hydrated and
  shows an empty loading state, not the panel — not cited as evidence; the `-v2` retry is.
- before.md's unlinked chat (`3f03be16…`) is no longer unlinked; had to re-pick one, disclosed
  above rather than silently substituted.
- The mixed-engine "money shot" is a disclosed fixture, not a naturally-occurring simultaneous
  state — no live chat had both engines live at once during this capture window, checked across
  every currently non-settled row on the box, not just the chats this round happened to already
  know about.
- The byte comparison against before.md is confounded by organic chat growth; I did not treat the
  raw number as clean and instead isolated the feature's own cost separately (above).

## Outside the declared write-set, disclosed

**Declared write-set: `evidence/aios-sidebar-live-sessions/after.md`.** Everything else this round
touched was throwaway verification tooling, never committed, and is listed here per the fleet's
write-set discipline:

- `/tmp/fixture-proxy-7799.mjs`, `/tmp/capture-aios-sidebar-live-sessions.mjs`,
  `/tmp/capture-unlinked-retry.mjs`, `/tmp/capture-plan-split-retry.mjs`,
  `/tmp/measure-team-bytes.mjs`, `/tmp/mint-cookie.mjs` — throwaway Playwright/probe scripts, `/tmp`
  only, not part of this repo.
- `forge-control-web/.env.local` — copied read-only from the live checkout's own file (source of
  `AUTH_SECRET`) so a cookie could be minted; this file is gitignored (`.env.local`) and was never
  staged or committed.
- `forge-control-web/.next/` — rebuilt twice (once pointed at the throwaway proxy chain for
  capture, once rebuilt at the end with the default `FORGE_CONTROL_URL` so the next task's build
  isn't proxying to a dead port); build output, gitignored, not committed.
- Three tmux sessions (`probe7798`, `fixture7799`, `web7793`) — all killed before finishing; `ss
  -ltn` confirms ports 7798/7899/7793 are clear.
- A new fleet memory note, `networkidle-never-fires-on-desktop-sse.md` (the SSE/`networkidle`
  finding above) — written to
  `/root/.claude/projects/-opt-forge-ai-os/memory/`, outside this repo, per the fleet's own
  memory-maintenance convention.

## Sources

- This worktree, `HEAD 2b4b3eb9a1517d277c9ad637af4731e462e3e7e9`:
  `forge-control-web/app/desktop/team/{ChatTeamPanel,LiveSessionsStrip,engineBadge,liveSessions,teamApi,PlanKanban,plan-split}.ts(x)`,
  `forge-control-web/app/desktop/_ui/ResizableSplit.tsx`,
  `forge-control/src/routes/chat.ts`, `forge-control/src/lib/team-live.ts` — read to build the
  fixture correctly and to locate the resize handle's real selector (no `data-*` attribute; it's
  `role="separator"` with a fixed `title`).
- Live API, read-only, via the worktree's own routers proxying to `:7700` for unmounted paths:
  `GET /api/chat?limit=60`, `GET /api/agents`, `GET /api/chat/:id/team` (multiple ids, to find
  live rows and a currently-unlinked chat) — 2026-08-25 01:4x–02:0x UTC.
- `evidence/aios-sidebar-live-sessions/before.md` (round 0) — the baseline this round diffs
  against.
- Fleet memory (`/root/.claude/projects/-opt-forge-ai-os/memory/`):
  `forge-control-probe-single-router.md`, `next-proxy-rewrite-baked-at-build.md`,
  `authurl-https-forces-secure-cookie-over-plain-http.md`, `throwaway-next-server-lifecycle.md`,
  `real-client-network-capture-recipe.md`, `stale-session-cookie-fakes-a-perfect-score.md`,
  `etag-304-needs-an-explicit-client.md`, `shots-aios-default-proves-wrong-tree.md`,
  `browser-stream-viewer-round3-fabricated-evidence.md`,
  `preview-page-plus-proxy-probe-screenshots-unwired-surface.md`,
  `chat-rail-payload-fixture-fabrication.md` — all read before driving the browser or building the
  fixture.
