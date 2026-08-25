# Sidebar scope toggle — evidence

Round 3, workstream `toggle`, branch `project/fb3b5fb2-toggle`.
Requirement, in Konrad's own words (vault `AI OS/Spec - Manager Chat UI v3.md`,
addendum 2026-08-25):

> "Add a toggle at the top of the right sidebar: 'this chat' vs 'everything
> running', defaulting to this chat."

Measured 2026-08-25, 05:14–05:22 UTC.

---

## What shipped

| Where | What |
|---|---|
| `forge-control-web/app/desktop/team/sidebar-scope.ts` | New pure module: the two scopes, the localStorage key, the default, the labels, the parse and `scopePolls`. No React, no DOM — so a check can assert it under plain `tsx`. |
| `forge-control-web/app/desktop/ChatSurface.tsx` | The toggle itself, in `SidePanel` above the panel body, and the branch that swaps `<ChatTeamPanel>` for `<AgentActivity>`. Deliberately NOT in `ChatTeamPanel`, which has another owner in this project. |
| `forge-control-web/app/desktop/live/AgentActivity.tsx` | `refetchInterval: 4_000` literal → `pollMs` prop defaulting to `AGENTS_POLL_MS`; new `enabled` prop. `/live` passes neither, so `/live` is byte-for-byte unchanged in behaviour. |
| `forge-control-web/app/desktop/chat/pollBudget.ts` | `AGENTS_POLL_MS = 4_000` (the /live rate, previously invisible to this file) and `SIDEBAR_AGENTS_POLL_MS = 8_000` (the sidebar's). |
| `scripts/checks/check-sidebar-scope.ts` | 34 assertions on the pure module + the two poll periods. |
| `scripts/checks/check-chat-delta.ts` | Both new constants pinned to their literals; the "everything running" mode added to the req/min sum. |

**Serialisation: JSON, not a bare string.** The key
`forge.layout.chat.sidebarScope` is read by `usePersistentState`, which
`JSON.parse`s — so the stored bytes for the default are `"this-chat"` *with*
the quotes, and `writeSidebarScope` stringifies. This is the opposite
convention from `forge.theme`, which layout.tsx's pre-paint script `===` as a
bare word (fleet note `theme-localstorage-is-bare-string-not-json`); getting it
backwards is silent, so `check-sidebar-scope.ts` case 3 feeds it the *bare* word
on purpose and asserts it falls back to "this chat".

**One thing the brief did not ask for, and why.** At the team tab's 260px
default width every fleet row rendered as `worker  aio…  1m 04s` — the row's
right-aligned age and ↓-token columns take a fixed slice and the
project-qualified title takes the remainder, which on /live is ~900px and here
was ~90. A mode whose entire purpose is "which project is this" cannot show
`aio…`. "Everything running" therefore gets its own remembered width
(`forge.layout.chat.sidePanel.team.everything`, initial 420 — the Files tab's
number), still draggable 200–760, and the scoped view keeps its own 260 key
untouched. The first shot pass, at 260px, is what made this visible; compare
`…-02-…` in this run against the truncated rows described here.

---

## The request-rate decision

`AgentActivity` polled at a hardcoded `refetchInterval: 4_000` — 15 req/min that
`pollBudget.ts` could not see, which is exactly the failure that file's own
header describes. Both halves of the operator's 2026-08-25 ruling are
implemented:

1. the literal is now `AGENTS_POLL_MS` in `pollBudget.ts` and `AgentActivity`
   reads it;
2. the interval is a **prop**, and the sidebar mounts at `SIDEBAR_AGENTS_POLL_MS`
   = 8_000 (7.5 req/min). `/live` passes nothing and stays at 4s.

The ceiling was **not** re-argued. In "everything running" the team tree
(6 req/min) and the plan zone (2 req/min) unmount, so the swap trades 8 out for
7.5 in — net **−0.5 req/min**. At /live's 4s it would have been net **+7**
(39 req/min against a 40 ceiling), which is a coincidence rather than a budget.

`check-chat-delta.ts` now prints and asserts:

```
Degraded fallback rate (4s):    32 req/min   (this chat)
Sidebar scope "everything running" (team + plan unmounted, /api/agents at 8s):
  Healthy:  18.5 req/min
  Degraded: 31.5 req/min      — vs 32 scoped to this chat
  Counterfactual at /live's 4s: 39 req/min (net +7 over the scoped surface)
```

with `flipping to everything-running does not raise the surface's request rate`
as a hard assertion, so a future edit that speeds this feed up goes red here.

---

## Measured in a real browser

Two 120-second windows, counted from `page.on("request")` — what the browser
actually issues, not a server-side count.

### `this chat` (the default)

| path | count / 120s | req/min |
|---|---|---|
| `/api/proxy/chat` (rail list) | 12 | 6.0 |
| `/api/proxy/chat/:id/team` | 11 | 5.5 |
| `/api/proxy/chat/:id` (transcript) | 5 | 2.5 |
| `/api/proxy/uploads/index` | 4 | 2.0 |
| `/api/proxy/chat/:id/plan` | 4 | 2.0 |
| `/api/proxy/usage/gemini-quota` | 1 | 0.5 |
| `/api/proxy/secrets` | 1 | 0.5 |
| `/api/secret-events` (SSE open) | 1 | 0.5 |
| **`/api/proxy/agents`** | **0** | **0.0** |
| **total** | **39** | **19.5** |

### `everything running`

| path | count / 120s | req/min |
|---|---|---|
| **`/api/proxy/agents`** | **15** | **7.5** |
| `/api/proxy/chat` (rail list) | 12 | 6.0 |
| `/api/proxy/chat/:id` (transcript) | 6 | 3.0 |
| `/api/proxy/uploads/index` | 4 | 2.0 |
| `/api/proxy/usage/quota` | 1 | 0.5 |
| **total** | **38** | **19.0** |

**The zero is the headline.** With the toggle on its default, `/api/agents` is
requested **zero** times — the component is not mounted *and* its query is
`enabled: false` (`fleetEnabled` in `ChatSurface`), the same belt-and-braces
`ChatTeamPanel`'s `visible` prop uses. And 7.5/min in the fleet scope is exactly
the 8s constant, measured, not asserted.

Flipping the toggle **lowers** the surface's rate, 19.5 → 19.0 req/min. An
earlier 60-second pair read 14.0 → 17.0 and 20.0 → 17.0; the 60s windows swing
because the team poll backs off when the tree settles and because the one-off
`secrets` / `gemini-quota` calls land inside or outside a short window. The 120s
pair above is the steady state and it matches the arithmetic in
`check-chat-delta.ts` (19 / 18.5 healthy) to within the one-offs.

---

## Screenshots — and which tree the pixels came from

All five read back with the Read tool.

| Shot | What it shows |
|---|---|
| `/opt/ai-os/uploads/8834241eda81/20260825T051426Z-01-this-chat-dark.png` | Default scope. `this chat` segment active; LIVE SESSIONS / TEAM / PLAN below it, and an `agy` badge on a `gemini-3.7-flash-high` session. |
| `/opt/ai-os/uploads/8834241eda81/20260825T051426Z-02-everything-running-dark.png` | Flipped. Rows from **twelve** distinct projects — aios-chat-list-etag, aios-sidebar-live-sessions, aios-verification-that-bites, aios-journal-thoughts-stats, aios-guardrail-hardening, aios-browser-takeover-live, zz-tierpin-verify, connect-clis-from-settings, aios-library-and-map, aios-devenv-and-cli, aios-excalidraw-to-plans, aios-chat-reference-navigation — with engine, model, role, elapsed and sub-agent nesting. |
| `…-03-everything-running-after-reload-dark.png` | After `page.reload()`: still `everything running`, and `localStorage["forge.layout.chat.sidebarScope"] === '"everything-running"'`. |
| `…-04-this-chat-light.png` | Light theme, scoped. |
| `…-05-everything-running-light.png` | Light theme, fleet. |

Panel text dump: `…-everything-running-panel.txt`.

**How I know these are this branch's pixels and not the live console's.**

- The page was served by a `next build` + `next start` of **this worktree** on
  `127.0.0.1:7743` (build exit 0, log `/tmp/sbscope-build.log`). The driver
  asserts `page.url() === "http://127.0.0.1:7743/desktop"` — the *origin*, not
  just the path, because an unauthenticated request here 307s to
  `https://os.schreinercontentsystems.com/signin` and a `.endsWith("/desktop")`
  assertion would have passed on the live console's own /desktop.
- `/api/chat/*` was served by a throwaway probe on `127.0.0.1:7742` mounting
  **only this worktree's** chat router, with a GET-only catch-all proxying
  everything else to `:7700` verbatim (non-GET refused with 405 before routing,
  so the run is read-only by construction — never `src/index.ts`, per fleet note
  `full-server-incident-telegram-and-vault-write`). Proof the probe is the
  worktree's code and not the deployed one:
  `GET :7742/api/chat/2ef126b7…/team` returns `engine` and `activity` on every
  node; the same call to `:7700` (deployed `main`, `b41e824`) returns neither.
- The live console never carries this branch and was not driven
  (fleet note `shots-aios-default-proves-wrong-tree`).

Cookie minted from `AUTH_SECRET` in `forge-control-web/.env.local` with
`@auth/core`'s `encode()`, salt `__Secure-authjs.session-token`, added with
`secure: true` on `127.0.0.1`. Chat selection seeded through `addInitScript`
into `localStorage["forge.chat.selected"]` (JSON) before `goto`;
`forge.theme` set as a **bare** string.

---

## What the driver asserts (12/12 OK)

```
OK  landed on the WORKTREE's /desktop (cookie is live, origin is mine)
OK  the panel opens on the DEFAULT scope, this chat
OK  dark theme is applied
OK  default scope issues ZERO /api/agents requests — 0
OK  clicking the second segment switches the scope
OK  everything-running DOES poll /api/agents — 15 in 120s
OK  the choice survives a reload
OK  and it survived in localStorage as JSON — "everything-running"
OK  light theme is applied
OK  seeded this-chat is read back
OK  still light after the flip
OK  an unparseable stored value falls back to this chat, in the real browser
```

The last one is the fallback rule exercised end-to-end: the bare word
`everything-running` (the wrong serialisation convention) is written into the
key before first paint, and the panel opens on **this chat**.

## Unit checks

```
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts
  → 34 passed, 0 failed · check-sidebar-scope: PASS

cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
    --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts
  → ALL PASS — check-chat-delta suite
```

`check-sidebar-scope.ts` was mutation-tested rather than merely run: flipping
`SIDEBAR_SCOPE_DEFAULT` to `"everything-running"` in the module under test turns
**15 of its 34 assertions red**, including every fallback case. It discriminates.

`tsc --noEmit` on `forge-control-web`: exit 0.

---

## What did not work / what is left

- **`check-sidebar-scope.ts` is NOT wired into `scripts/checks/gates-808.sh`.**
  That file is outside this task's declared write-set, so I did not touch it. A
  check nobody executes proves that it compiles and nothing else — the
  integration task should add, beside the round-2 `check-live-sessions` entry at
  `gates-808.sh:213`:

  ```sh
  gate_sh "check-sidebar-scope.ts — default scope, round-trip, unknown-value fallback" \
    "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts | tail -2"
  ```

- **No `.env.local` was written in this worktree.** The build and server took
  `FORGE_CONTROL_URL` / `AUTH_SECRET` / `AUTH_URL` on the command line, so
  nothing stale is baked in for the next round (fleet note
  `worktree-env-local-pins-a-dead-probe-port`). `/opt/forge-ai-os` was neither
  edited nor built.

- **The 60-second measurement windows were noisy** (14/17 and 20/17 req/min)
  before I lengthened them to 120s. Reported here rather than dropped: a single
  60s window on this surface is not a stable number, because the team poll's
  settled-backoff and three one-off calls all fall inside it.
