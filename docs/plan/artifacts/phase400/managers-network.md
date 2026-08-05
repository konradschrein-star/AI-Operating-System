# The poll budget after phase 400 — U9 and NFU3, measured

Two claims, both read straight off `managers-network-*.json`:

**(a) ZERO requests to `/api/projects/managers` (U9).** Not "fewer" — none, in
either window, including page load.

**(b) requests/minute did not grow (NFU3).** It fell by 8.0/min on both sides
of the one variable that dwarfs everything phase 400 touched.

Everything below was produced by `network-watch.cjs`, which records every
`/api/proxy/*` request the page issues with a project chat open and the Live
panel visible. Window: 75s, started 5s after the chat opened so page-load and
open-the-chat traffic sits *outside* it and is reported separately.

## The variable that has to be held constant

`ChatSurface` polls the open chat's detail at `live ? 20_000 : 3_000` — 3/min
with the SSE stream up, 20/min with it down. That 17.6/min swing is larger than
anything this phase changed, so a run with a live stream and a run without one
are not comparable in either direction. `ABORT_SSE=1` pins the fallback branch;
every pair below holds the flag constant.

(The first attempt at this measurement did not: the after-build ran on the
harness, where SSE can never open, against a baseline where it could. It read
52.0 vs 42.4 — phase 400 apparently *adding* 10 requests/minute. It was the
stream, not the code. That is why the flag exists.)

## The four runs

| file | build | SSE | total req/min | `/projects/managers` |
|---|---|---|---|---|
| `managers-network-baseline.json` | pre-phase (main) | live, 20s detail | **42.4** | 11 |
| `managers-network-after-sse-live.json` | this worktree | live, 20s detail | **34.4** | **0** |
| `managers-network-baseline-sse-aborted.json` | pre-phase (main) | aborted, 3s detail | **60.0** | 11 |
| `managers-network-after.json` | this worktree | aborted, 3s detail | **52.0** | **0** |

Like-for-like, both branches: **−8.0 requests/minute**. Nothing in this phase
polls more often than it did; one poll was removed.

Per endpoint, SSE live (`per_minute` in the JSON):

```
                     baseline      after
/chat                    8.0         8.0     unchanged (8s)
/chat/:id                2.4         2.4     unchanged (20s live branch)
/agents                 15.2        14.4     unchanged (4s; ±1 sample per window)
/projects/board          9.6         9.6     unchanged (6s)
/projects/managers       7.2         0.0     ← gone
/chat/:id/linkage        —           0.0     ← new, and NOT on an interval
                       ─────       ─────
                        42.4        34.4
```

## The new call fires once per chat opened, not on a timer

`/chat/:id/linkage` appears **zero** times inside every 75s window and twice
before it, in `before_window` — once for the chat the app auto-selects on load,
once for the chat the script clicks:

```
3677 ms  /chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/linkage
6600 ms  /chat/c0de0304-0000-4000-8000-000000000304/linkage
```

Two chats opened, two requests, then silence for 75 seconds — `staleTime:
Infinity`, no `refetchInterval` (`ChatSurface.tsx:542-548`).

## Bonus, from the same capture: the panel follows the CHAT (U9)

Every `/agents` request in the window carries `project_id`, and *which* project
is the behavioural change:

```
after            18/18 scoped → 4d3291c4…   the project the OPEN CHAT started
after-sse-live   18/18 scoped → 4d3291c4…   same
baseline         19/19 scoped → 8ea0cc08…   whatever ManagersSection auto-selected,
                                            unrelated to the chat on screen
```

## Reproducing

```bash
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)"

# this worktree, both SSE branches
WATCH_URL=http://127.0.0.1:7788 WATCH_LABEL=after-sse-live \
  node docs/plan/artifacts/phase400/network-watch.cjs
WATCH_URL=http://127.0.0.1:7789 WATCH_LABEL=after ABORT_SSE=1 \
  node docs/plan/artifacts/phase400/network-watch.cjs

# pre-phase build (/tmp/hover-before — a read-only copy of the live checkout's
# .next; the live checkout is never started, edited or rebuilt), both branches
WATCH_URL=http://127.0.0.1:7787 WATCH_LABEL=baseline \
  node docs/plan/artifacts/phase400/network-watch.cjs
WATCH_URL=http://127.0.0.1:7787 WATCH_LABEL=baseline-sse-aborted ABORT_SSE=1 \
  node docs/plan/artifacts/phase400/network-watch.cjs
```

See `README.md` for how the three servers are started and why there are three.

## What this does not prove

The baseline build's proxy target is production `:7700`, not the worktree
harness `:7798` — it is the shipped bundle, and rebuilding it would make it
something other than the baseline. Only request **paths and rates** are
compared here, never payloads, so the different backend cannot affect either
claim. It does mean the two runs saw different `/agents` bodies; nothing in
this document depends on their contents.
