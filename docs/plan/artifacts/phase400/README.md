# Phase 400 / round 401a — rail rescope, x/y badges, CSS-only hover

What this round did, and the evidence for each claim. Everything here was
produced against real servers; where live data could not exercise a branch, the
fixture is named as a fixture and says what it fakes.

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

## Reproducing

Both REPRODUCE.md traps from phase 1 still apply (proxy target baked at build
time; `/desktop` behind OAuth, so mint a cookie). Sequence:

```bash
cd <worktree>
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &   # worktree API

# a build to measure, and a main build to measure against
#   /tmp/hover-before ← copy of /opt/forge-ai-os/forge-control-web/.next (read-only copy; the
#                       live checkout is NOT started, edited, or rebuilt)
#   /tmp/hover-after  ← copy of this worktree's app/ + config, built here
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
(cd /tmp/hover-before && AUTH_URL=http://127.0.0.1:7797 npx next start -p 7797 &)
(cd /tmp/hover-after  && AUTH_URL=http://127.0.0.1:7796 npx next start -p 7796 &)

# cookie (60 min) — must run from inside forge-control-web, next-auth resolves there
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
  HOVER_URL=http://127.0.0.1:7797 HOVER_LABEL=before node docs/plan/artifacts/phase400/hover-cost.cjs
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
  HOVER_URL=http://127.0.0.1:7796 HOVER_LABEL=after  node docs/plan/artifacts/phase400/hover-cost.cjs

# screenshots + badge checks need the build pointed at the WORKTREE api
(cd /tmp/hover-after && FORGE_CONTROL_URL=http://127.0.0.1:7798 npx next build \
   && AUTH_URL=http://127.0.0.1:7795 npx next start -p 7795 &)
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" RAIL_URL=http://127.0.0.1:7795 \
  node docs/plan/artifacts/phase400/rail-shot.cjs
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" RAIL_URL=http://127.0.0.1:7795 \
  node docs/plan/artifacts/phase400/rail-zero-fixture.cjs
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" RAIL_URL=http://127.0.0.1:7795 \
  node docs/plan/artifacts/phase400/linkage-scope.cjs
```

## What this round did NOT do

- The `linked heuristically` marker for `link_source: "thread_scan"` (NFU6).
  `ChatThread` now receives `linkSource` / `linkAmbiguous` and renders nothing
  with them — round 402 owns the header and the marker.
- On a linkage fetch error the panel falls back to the unscoped global fleet
  view. Stated in a comment at the query; phase 500 replaces this panel with
  `ChatTeamPanel`, which renders an explicit inline error row instead.
