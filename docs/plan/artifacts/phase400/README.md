# Phase 400 (UI v3) — artifacts

Two rounds produced the code (401a, 401b, 402); round 403 produced the proof.
Nothing is claimed here without a file behind it, and every file says whether
its data is real or synthetic.

Round 403 changed **no application code** — it is an evidence round. What it
found and could not fix is in [§5 Bugs found while capturing](#5-bugs-found-while-capturing);
the reviewer decides what happens to them.

---

## 1. What each file is

### Round 403 — both-theme captures (all produced by `capture.cjs`)

| File | Data | Shows |
|---|---|---|
| `rail-{dark,light}.png` | **real** rendering, **synthetic** badge row | the chat rail: row 2 carries `1/1 tasks`, the other six carry nothing (U10, U13) |
| `header-live-{dark,light}.png` | **real** | the slim header with the SSE stream open — green dot, `live`, model, CANVAS (U12) |
| `header-polling-{dark,light}.png` | **real** | the same header with `/api/events/:id` aborted — `polling` in `tokens.warn` (U12) |
| `panel-live-{dark,light}.png` | **real** | the chat SidePanel's Live tab, scoped to the OPEN CHAT's project: two architect rows of `phase300-invalid-guard`, no manager selector anywhere (U9) |
| `livedest-{dark,light}.png` | **real** | the standalone LIVE destination — AgentActivity's other home, 3 running + 6 recent worker rows, zero currency (U11) |
| `statusbar-{dark,light}.png` | **real** | the bottom status bar: host, services, quota %, fleet, bleed/stuck — zero currency (U11) |
| `pipeline-{dark,light}.png` | **real** | the PIPELINE surface cards — zero rendered currency (U11); see the one allowlisted content hit below |
| `rail-rows-403.json` | **real** | the rail's rows as text — the screenshots' machine-readable twin, with the badged/unbadged split |
| `dollar-dom.json` | **real** | the `innerText` of exactly the elements screenshotted, tested against a currency regex. 2 hits, both the same allowlisted pipeline **item title**; **0 unlisted** |
| `capture.cjs` | — | the script that produces all fourteen PNGs and both JSONs |

### Round 403 — the network proof

| File | Data | Shows |
|---|---|---|
| `managers-network.md` | — | the write-up: U9 (zero `/api/projects/managers`) and NFU3 (requests/minute did not grow) |
| `managers-network-after.json` | **real** | this worktree, SSE aborted → **52.0** req/min, **0** managers |
| `managers-network-after-sse-live.json` | **real** | this worktree, SSE live → **34.4** req/min, **0** managers |
| `managers-network-baseline.json` | **real** | pre-phase build, SSE live → **42.4** req/min, **11** managers |
| `managers-network-baseline-sse-aborted.json` | **real** | pre-phase build, SSE aborted → **60.0** req/min, **11** managers |
| `network-watch.cjs` | — | the recorder; `raw` in each JSON is every `/api/proxy/*` request with a ms offset |

### Round 403 — supporting evidence

| File | Data | Shows |
|---|---|---|
| `gates-403.txt` | **real** | the five gate commands and their output, verbatim |
| `linkage-dryrun.mts` / `linkage-dryrun.txt` | **real** | which of today's seven rail chats the phase-300 resolver could backfill. Answer: none. This is why the brief's optional production write was **not** performed |

### Rounds 401–402 — kept from the earlier rounds

| File | Data | Shows |
|---|---|---|
| `hover-cost.cjs`, `hover-cost-before.json`, `hover-cost-after.json`, `hover-cost-after-run2.json` | **real** | the hover-storm measurement: 77 react commits + 1057 DOM mutations → 1 and 0 |
| `rail-shot.cjs`, `rail-hover-dark.png`, `rail-rows.json` | **real** | round 401's rail shot, plus the no-reflow-on-hover geometry assertion |
| `rail-zero-fixture.cjs`, `rail-zero-fixture-dark.png`, `rail-zero-fixture.json` | **synthetic** (browser-side fulfilled response) | `0/0 tasks` renders in `textMuted`, and an absent field stays absent — the truthiness-guard trap |
| `linkage-scope.cjs`, `linkage-scope.json` | **real** | 1 linkage request / 25s, every `/agents` scoped, 0 managers |
| `dollar-allowlist.md` | — | the prose behind `scripts/checks/dollar-allowlist.txt` |

Note: `rail-dark.png` / `rail-light.png` were **overwritten** by round 403's
`capture.cjs` (same surface, same finder, current data). `rail-rows.json` is
round 401's row dump; `rail-rows-403.json` is round 403's.

---

## 2. Reproducing

Both traps from `docs/plan/artifacts/phase1/REPRODUCE.md` still apply: the
proxy target is baked at **build** time, and `/desktop` is behind GitHub OAuth
so a session cookie has to be minted.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) worktree API on :7798. NEVER boot forge-control/src/index.ts (double cron +
#    stolen Telegram poll), never touch pm2.
(cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)

# B) build the worktree web AGAINST the harness
cd forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7798 NODE_ENV=production pnpm build
grep -o '127.0.0.1:77[0-9][0-9]' .next/routes-manifest.json | sort -u   # → 127.0.0.1:7798

# C) mint the cookie (REPRODUCE trap 2) — must run from inside forge-control-web
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase400 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 120 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie.txt && rm mint-cookie.mjs

# D) three servers, all from the SAME build
AUTH_URL=http://127.0.0.1:7789 FORGE_CONTROL_URL=http://127.0.0.1:7798 \
  pnpm exec next start -p 7789 &          # captures + the "after, SSE dead" watch
AUTH_URL=http://127.0.0.1:7788 FORGE_CONTROL_URL=http://127.0.0.1:7700 \
  pnpm exec next start -p 7788 &          # same build; only the SSE route differs
(cd /tmp/hover-before && AUTH_URL=http://127.0.0.1:7787 npx next start -p 7787 &)
                                          # pre-phase baseline build

# E) the evidence
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)"
node docs/plan/artifacts/phase400/capture.cjs
WATCH_URL=http://127.0.0.1:7788 WATCH_LABEL=after-sse-live \
  node docs/plan/artifacts/phase400/network-watch.cjs
WATCH_URL=http://127.0.0.1:7789 WATCH_LABEL=after ABORT_SSE=1 \
  node docs/plan/artifacts/phase400/network-watch.cjs
WATCH_URL=http://127.0.0.1:7787 WATCH_LABEL=baseline \
  node docs/plan/artifacts/phase400/network-watch.cjs
WATCH_URL=http://127.0.0.1:7787 WATCH_LABEL=baseline-sse-aborted ABORT_SSE=1 \
  node docs/plan/artifacts/phase400/network-watch.cjs

# F) gates LAST — the plain build re-bakes :7700 into .next, so anything that
#    needs the harness must be captured before this point.
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
bash scripts/checks/dollar-sweep.sh
git diff --name-only 35cd0d3..HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|FileExplorerPanel|VaultFileList|routes/files'
```

Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules`
and chromium is resolved from `/root/.cache/ms-playwright`, exactly as
`scripts/checks/frozen-dom.cjs:30-58` does (the absolute `require`, then
`resolveChromium`). It is not, and must not become, a dependency of either repo
(NFU8) — `gates-403.txt` greps both `package.json`s to prove it.

---

## 3. Deviations from the round-403 brief

Six, each with its reason.

**1. Port 7789, not 7799.** `:7799` was already held by a stale phase-300
probe (`/tmp/phase300-secrets-probe.ts`, pid 1497281, started 16:08). Killing
another round's process to free a port is not worth the risk; `AUTH_URL` was
moved to match the port, which is all the minted cookie cares about. Same for
`:7788` / `:7787`.

**2. A THIRD server, `:7788`, for the two header states.** The brief expects
both header shots from the harness build. They cannot both come from `:7789`:
`serve-v3-7798.ts` buffers its pass-through (its own header says so — it awaits
`arrayBuffer()` before writing a byte), so `GET /api/chat/:id/events` never
flushes a header through it, `EventSource` never fires `open`, and the header
can never read `live` there. `:7788` is the **same `.next` build** started with
`FORGE_CONTROL_URL=http://127.0.0.1:7700`; only one file reads that variable at
runtime (`app/api/events/[id]/route.ts`), so the proxy rewrites still point at
the worktree API and only the stream target changes. Verified before use:

```
$ curl -sN -H 'accept: text/event-stream' http://127.0.0.1:7788/api/events/bfd1283a-…
event: snapshot
data: {"run":{"id":"bfd1283a-…
```

`header-polling-*` was then forced on that same server by **aborting
`/api/events/**` via `page.route`** — the brief's first suggested method.

**3. The production database was NOT written to.** The brief's optional step —
open chat `bfd1283a…` once so the resolver backfills `origin_chat_id` and the
live project gains a rail badge — was checked before being done, and it would
have done nothing: the bounded scan finds **zero** candidates in that chat
(`linkage-dryrun.txt`). The premise is wrong, not the mechanism. No chat in
today's rail can gain a badge:

| chat | scan candidates | outcome |
|---|---|---|
| `bfd1283a…` "Okay when I click the file section…" | none | nothing to backfill |
| `a86cf7b3…` "let's make the AI operating system…" | `61d1935f…` | not a `projects` row → killed by bound 4 |
| `11dd264b…` "Okay this session is very important…" | `9632f076…`, `1d574922…` | both real → ambiguous → deliberately never backfilled |
| `ece63bdb…`, `da286217…`, `05187ada…` | none | nothing to backfill |
| `c0de0304…` phase-300 fixture | `4d3291c4…` | already linked via metadata |

Consequence, stated plainly: **the one `x/y tasks` badge in `rail-*.png` sits on
a synthetic chat row** — `c0de0304…`, inserted by phase 300, linked to the real
project `phase300-invalid-guard` (1 real task, done). The rendering, the rollup
query and the project are real; the chat that anchors them is not. The six rows
without a badge are all real conversations. Round 401's `rail-zero-fixture.*`
covers the third case (`0/0` present vs field absent).

**4. `01b820d1…` is not a rail chat.** The brief names it as "the real linked
chat today". It is linked — project `46c8dd66` (`phase300-origin-probe`) carries
it as `origin_chat_id` — but it is a **builder run of project 8ea0cc08**, and
`listRuns` excludes anything carrying `metadata.project_id`
(`forge-control/src/db/runs.ts:132`). It can never appear in the rail, so it
cannot carry a rail badge. `c0de0304…` was used instead.

**5. `dollar-dom.json` carries a one-entry content allowlist.** The scan found
`Best Speakers 2026 below 100$` on the PIPELINE surface. It is a pipeline item's
own `title`, straight from the database (verified: `GET /api/pipeline` →
`phases[].items[].title`). U11 is about figures the UI *renders*; blanking a row
of data because its title contains a currency mark would make the console lie
about its content. The entry excuses that one exact string on that one surface —
a different hit, even on the same file, still fails, same rule as
`scripts/checks/dollar-allowlist.txt`. **Unlisted hits across all fourteen
captures: 0.**

**6. NFU3 is measured four times, not twice.** The first attempt compared the
harness build (SSE dead → detail polls every 3s) against a baseline with a live
stream (20s) and read 52.0 vs 42.4 — phase 400 apparently *adding* traffic. The
17.6/min difference is `ChatSurface.tsx:474`, not this phase. `network-watch.cjs`
grew an `ABORT_SSE=1` flag so both branches can be held constant; both pairs are
reported in `managers-network.md`.

---

## 4. Requirement checklist

| Req | Claim | Evidence |
|---|---|---|
| **U9** | `ManagersSection` is gone; the Live panel is scoped by the OPEN CHAT | `panel-live-{dark,light}.png` (tabs are Live/Files, no manager cards); `managers-network-after*.json` → `managers_requests_including_startup: 0`, and all 18/18 `/agents` requests scoped to `4d3291c4…` = the open chat's project, where the **baseline** scoped to `8ea0cc08…` = whatever the selector picked; `linkage-scope.json` (round 401) |
| **U10** | the rail shows `x/y tasks` where a project exists, and nothing where none does | `rail-{dark,light}.png`, `rail-rows-403.json` → 1 badged row (`1/1 tasks`), 6 unbadged; `rail-zero-fixture.json` for the `0/0`-vs-absent distinction |
| **U11** | no rendered dollar or euro figure on any touched surface | `livedest-*`, `statusbar-*`, `pipeline-*`, `panel-live-*`, `header-*`, `rail-*` (14 PNGs) + `dollar-dom.json` → **0 unlisted** currency hits in the same DOM that was screenshotted; `gates-403.txt` → `dollar-sweep.sh: PASS` |
| **U12** | the chat header is slim: status dot + live/polling, model, actions — no title, no status word, no engine, no cost line | `header-live-{dark,light}.png`, `header-polling-{dark,light}.png` |
| **U13** | the rail is activity-ordered by the server, not re-sorted on the client | `rail-rows-403.json` (39m, 2h, 9h, 21h, 1d, 7d, 17d — descending); `ORDER BY updated_at DESC` in `forge-control/src/db/runs.ts:133`, no client sort |
| **NFU3** | the poll budget did not grow | `managers-network.md`: −8.0 req/min like-for-like on both SSE branches; the new `/chat/:id/linkage` fires once per chat opened and zero times in a 75s window |
| **NFU5** | no forbidden file touched | `gates-403.txt` — the grep over `35cd0d3..HEAD` is empty |
| **NFU8** | Playwright is not a dependency of either repo | `gates-403.txt` — grep over both `package.json`s is empty; both scripts load it from `/opt/hermes-workspace/node_modules` |
| **NFU6** | linkage-honesty markers in the header | **not visible in any capture, and cannot be**: the markers render only for `link_source: "thread_scan"` or an ambiguous link, and `linkage-dryrun.txt` shows no chat in today's rail resolves that way. The code path is `ChatSurface.tsx:1434-1451`; round 402 owns it |

Both themes: every capture exists as a `-dark` and a `-light` pair, produced in
the same page state with only `document.documentElement.dataset.theme` flipped
(the `applyTheme()` mechanism, `app/tokens.ts:101-109`).

---

## 5. Bugs found while capturing

Round 403 may not change application code. Both of these are for the reviewer.

**A. The left sidebar's active row is a black block in light mode.**
`DesktopApp.tsx:676` sets `background: surface === key ? "#141417" : "transparent"`
— a hardcoded dark hex, on top of which `color: tokens.text` resolves to
near-black in the light palette. The active nav item is unreadable. Visible in
`livedest-light.png` (the `LIVE` row) and `pipeline-light.png` (the `PIPELINE`
row); compare `livedest-dark.png`, where the same row reads correctly.

Not introduced by this phase — `git log -S'#141417'` dates it to the initial
commit `c7e488d`, and it is present at `35cd0d3`. It is reported here because
"both themes must work, zero hardcoded colors" is this project's bar and the
both-theme sweep is what surfaced it.

**B. Three more hardcoded colours in the same file, one in the same class of
bug.** `DesktopApp.tsx:1052` (`#0c0c0e`), `:1845` (`#000`), `:1898` (`#fff`),
plus `MobileApp.tsx:308,685`. Not audited in light mode by this round — only
`:676` was caught rendering wrong. Listed so the reviewer can decide whether a
phase-500 token sweep should cover them.

---

# Round 401a — rail rescope, x/y badges, CSS-only hover

*(kept from the round-401a artifact; every file it cites is still in this
directory. Its reproduce block is superseded by §2 above, which starts the same
servers on the ports round 403 actually used.)*

## The hover number (NFU2 — Konrad: "hovering the sidebar still lags")

`ChatListItem` held `useState(hover)` and swapped `<age>` for `<✕>` on every
pointer enter/leave. Every row the pointer crossed re-rendered and rebuilt DOM.
Now both children are always mounted, stacked in one slot, and swapped by
`.chat-row:hover` opacity rules in `app/globals.css`.

Measured with `hover-cost.cjs`: a `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim counts
react-dom commits, a `MutationObserver` counts DOM mutations inside the rail's
scroll container. Two 10s windows — pointer parked far away, then 76 crossings
of the 7 rail rows — and the reported cost is `hover − idle`, because the app
polls on its own.

| | react commits attributable to hover | rail DOM mutations |
|---|---|---|
| **before** (main build, `next start` of `/opt/forge-ai-os` output) | **77** | **1057** |
| **after** (this worktree's build) | **1** | **0** |
| after, second run | 1 | 0 |

77 commits ≈ one per crossing: that is the storm. The residual 1 is a poll
landing inside the longer window (idle 12 → hover 13 commits), not a per-row
render — 76 crossings producing 1 commit and 0 mutations is the point.

Both servers were built from the same `next.config.mjs` with the same proxy
target (`FORGE_CONTROL_URL=http://127.0.0.1:7700`), started with
`AUTH_URL=http://127.0.0.1:<port>` so the minted session cookie is accepted,
and measured by the same script in the same browser. No code was edited between
the two runs — the two builds ARE the comparison.

- `hover-cost-before.json`, `hover-cost-after.json`, `hover-cost-after-run2.json`
- `rail-hover-dark.png` — the ✕ revealed on row 2. `rail-shot.cjs` also asserts
  row geometry is byte-identical hovered vs not: **no reflow on hover**.

## U9 — ManagersSection is gone

`grep -rnE "ManagersSection|fetchManagers|projects/managers" forge-control-web/app`
returns nothing. `/api/projects/managers` is untouched on the server (NFU4);
`linkage-scope.json` shows **0** requests to it from the web app in a 25s window.

## Rescope — the panel follows the open chat

`linkage-scope.cjs` opens the linked fixture chat and watches the proxy traffic
for 25s (`linkage-scope.json`):

```
linkage_requests: 1        ← staleTime Infinity, no refetchInterval (NFU3)
agents_requests: 7
agents_requests_scoped: 7  ← every one carries project_id=…
project_ids_seen: ["4d3291c4-4eb3-483a-8d32-acc817a7b352"]
managers_requests: 0
```

## U10 — x/y tasks, and the presence guard

`rail-dark.png` / `rail-light.png` (both themes, real data via the worktree API
on :7798 — production :7700 runs main and has no rollup fields yet, so building
against it would have shown no badges for a reason unrelated to this round).
Row 2 is the phase-300 fixture chat: `1/1 tasks`, rendered in `tokens.ok`
because `tasks_done === tasks_total && tasks_total > 0`. Every other row has no
counter — those chats never started a project, and the server omits the fields
rather than sending `0/0`.

The "linked project, nothing planned yet" case does not exist in live data and
faking it would mean writing into Konrad's real database, so
`rail-zero-fixture.cjs` fakes it in the browser instead: it rewrites the
`/api/proxy/chat` response so row 0 carries `tasks_done: 0, tasks_total: 0` and
row 1 has the fields deleted. Result (`rail-zero-fixture.json`):

```
row 0 → badge "0/0 tasks", colour rgb(138,138,144) = tokens.textMuted (not ok)
row 1 → badge null
PASS: 0/0 renders, absent stays absent
```

A truthiness guard (`run.tasks_total &&`) would have hidden row 0's badge. This
check exists to catch exactly that.

## U13 — ordering is the server's job

`GET /api/chat` is already activity-ordered: `listRuns` in
`forge-control/src/db/runs.ts:133` (and its search twin at :188) ends with
`ORDER BY updated_at DESC`. Curl against the worktree harness:

```
curl -s '127.0.0.1:7798/api/chat?limit=30' | python3 -c "…"
activity order ok: True
```

No client-side sort was added — a second sort would be a second truth.

## What round 401a did NOT do

- The `linked heuristically` marker for `link_source: "thread_scan"` (NFU6).
  `ChatThread` now receives `linkSource` / `linkAmbiguous` and renders nothing
  with them — round 402 owns the header and the marker.
- On a linkage fetch error the panel falls back to the unscoped global fleet
  view. Stated in a comment at the query; phase 500 replaces this panel with
  `ChatTeamPanel`, which renders an explicit inline error row instead.
