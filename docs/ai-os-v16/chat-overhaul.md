# AI OS v16 — Chat Surface Overhaul

## TL;DR

`ChatSurface.tsx` is a thin CRUD over `runs`: textarea + bubbles + 3s polling, no slash commands, no streaming, Cmd+Enter only, and the scroll container uses the browser default scrollbar. Backend executor hard-caps every run at 180s and marks timeouts as `failed`, deleting the partial assistant turn. Plan: rebuild ChatSurface around a tokenizing composer + slash registry + SSE stream, raise/relax the executor timeout (`stuck` not `failed`, partial-thread persistence, `/resume-run` to continue), and tint the scrollbar. Match Claude Code in feel, not in code — lift no components from `codeaashu/claude-code`.

## Current state and exact bugs found

- `forge-control-web/app/desktop/ChatSurface.tsx:468` — `onKeyDown` only fires on `Enter + (metaKey || ctrlKey)`. **Plain Enter does nothing.** Same bug repeats in `NewChat` at line 630.
- Same file, no `/` handling anywhere → slash menu impossible.
- Line 429 — scroll div has no class, inherits OS default chrome (the "horrible" scrollbar). `.scroll` in `globals.css:42` only _hides_ scrollbars; there is no tinted thin-bar style yet.
- Line 370–373 — auto-scroll fires unconditionally on `thread.length` change; will yank the user back down if they scrolled up to read.
- `ThreadBubble` (529) renders `entry.content` as raw `pre-wrap` text. `kind: "tool_call" | "tool_result" | "error"` exists in the type but is ignored. No code highlighting, no JSON folding.
- `forge-control/src/executor.ts:27` — `RUN_TIMEOUT_MS = 180000`. Line 117 passes it to claude-pool. Line 184–197 — on any throw (incl. timeout) the assistant turn is discarded and the run is marked `failed`. That's the verbatim `Executor failed: pool 502: Run failed: claude timed out after 180000ms`.
- `forge-control/src/routes/chat.ts:46` — `POST /chat` accepts `metadata` but `createRun` never threads `timeout_ms` through to the executor.
- No SSE endpoint. Detail polled every 3s (`refetchInterval: 3000`).

## Proposed UX

````
┌─ Chats (24) [+ new] ─────────┬─ run · executor · $0.12 / $5.00 ──────────────┐
│ ● running  · 2m              │  USER · 14:02                                  │
│   "fix the chat scrollbar"   │  > fix the chat scrollbar                      │
│ ● stuck    · 12m  RESUMABLE  │                                                │
│   "render CE job ce-aa…"     │  ASSISTANT · 14:02                             │
│ ● completed · 1h             │  Reading ChatSurface.tsx ▾                     │
│   "audit forge-control"      │  ┌─ tool_call: read_file ──────────────────┐   │
│                              │  │  path: forge-control-web/.../ChatSurf… │   │
│                              │  └────────────────────────────────────────┘   │
│                              │  ```ts                                         │
│                              │  if (e.key === "Enter" && !e.shiftKey) …      │
│                              │  ```                                           │
│                              │                                                │
│                              │  [⏸ paused — partial thread saved]            │
│                              ├────────────────────────────────────────────────┤
│                              │ /resume-run                                   ⨯│
│                              │ ┌─ slash menu ────────────────────────────┐    │
│                              │ │ /resume-run   continue stuck run        │    │
│                              │ │ /cancel       cancel current run        │    │
│                              │ │ /switch <w>   change worker             │    │
│                              │ └─────────────────────────────────────────┘    │
│                              │ Enter send · Shift+Enter newline · Ctrl+K jump │
└──────────────────────────────┴────────────────────────────────────────────────┘
````

Key behaviours: Enter sends, Shift+Enter newline, `/` at column 0 opens a menu (fuzzy filtered), Esc closes, ↑/↓ navigate, Tab/Enter accepts. Ctrl+K opens a thread quick-switcher over the left rail. Auto-scroll sticks to bottom only when the user is already within ~120px of bottom.

## Slash command registry

Single file `forge-control-web/app/desktop/chat/slash-registry.ts`:

```ts
export interface SlashCmd { name: string; label: string; help: string;
  handler: (ctx: SlashCtx, args: string) => Promise<void> | void; }
export const SLASH: Map<string, SlashCmd> = new Map([...]);
```

v1 commands: `/clear` (local thread clear, run untouched), `/freeze`, `/resume` (fleet status via existing `/control` route), `/skills`, `/memory`, `/spend`, `/workers` (open respective surface or inline list via existing APIs), `/pause`, `/resume-run`, `/cancel`, `/switch <worker>` (map to existing `/chat/:id/status` + a new `PATCH /chat/:id` for worker). Pure client dispatch — the composer intercepts before `sendChatMessage`. Unknown `/foo` is sent as a plain message.

## Streaming + persistence model

- Add `GET /chat/:id/stream` (SSE) in `forge-control/src/routes/chat.ts`. Yields `{ kind: 'delta'|'tool_call'|'tool_result'|'done'|'error', ts, content }`.
- Executor pushes deltas through a Postgres `LISTEN/NOTIFY` channel `runs:<id>:delta`; route subscribes per connection. Cheap and survives executor restarts (next reconnect replays from `thread` snapshot).
- ChatSurface uses `EventSource(/api/proxy/chat/${id}/stream)` while `status === 'running'`, falls back to the existing 3s poll otherwise.
- claude-pool already supports `timeout_ms`; if it lacks SSE we still get progressive UI via NOTIFY (executor flushes assistant text incrementally — see backend fix).

## Backend timeout fix

1. `executor.ts:27` — `const DEFAULT_RUN_TIMEOUT_MS = 600_000;` per-run override read from `run.metadata.timeout_ms` (clamped 30s–1800s).
2. New helper `appendPartialAndPark(id, partialText, signal)`: on AbortError or pool 5xx, append assistant turn with `kind: "text"` + `meta.partial: true` and set status `stuck` with `stuck_signal = "timeout"`. **Never `failed` on timeout.**
3. Add `kind: "tool_call" | "tool_result"` rows to `thread` from claude-pool's stream so the UI can render them.
4. `/resume-run` slash command POSTs to a new `POST /chat/:id/resume` route that flips `stuck → queued` and lets the executor re-claim with the existing thread.

## File edit list (ordered)

1. `forge-control-web/app/desktop/ChatSurface.tsx` — rewrite (~640 → ~520 LOC).
2. `forge-control-web/app/desktop/chat/slash-registry.ts` — new (~140 LOC).
3. `forge-control-web/app/desktop/chat/SlashMenu.tsx` — new (~110 LOC).
4. `forge-control-web/app/desktop/chat/CodeBlock.tsx` — new, wraps `react-syntax-highlighter/dist/esm/prism-light` with only `ts/json/bash/md` registered (~60 LOC; bundle <40kB).
5. `forge-control-web/app/globals.css` — add `.scroll-tinted` thin scrollbar using `rgba(var(--v2-accent-rgb), 0.35)` (~25 LOC).
6. `forge-control-web/app/api.ts` — add `streamChat`, `resumeRun` (~40 LOC).
7. `forge-control/src/routes/chat.ts` — add SSE `GET /:id/stream`, `POST /:id/resume`, accept `metadata.timeout_ms` (~110 LOC).
8. `forge-control/src/executor.ts` — partial-park, NOTIFY deltas, configurable timeout (~80 LOC delta).
9. `forge-control-web/app/MobileApp.tsx` — mirror Enter-sends + scrollbar fix only (~30 LOC).
10. claude-pool config on VPS — bump default `timeout_ms` to 600s; SSE optional v2.

## Risks

- **Nginx SSE** at `/etc/nginx/sites-enabled/os.example.com` — must set `proxy_buffering off; proxy_read_timeout 1h;` for `/api/proxy/chat/*/stream`. Verify before shipping.
- **Slash vs paste** — paste of `/something` shouldn't trigger menu. Gate by `event.key === '/'` + caret at line start.
- **Resume semantics** — re-prompting includes the partial assistant turn; risk of duplicate output. Mitigation: append a `[SYSTEM] continue from previous partial` marker and strip on next claim.
- **Mobile parity** — `MobileApp.tsx` is separate; ship Enter+scrollbar fixes in same PR, defer slash menu to v2.
- **react-syntax-highlighter** bundle — use prism-light + register only needed langs.

## Recommended next step

**Rebuild in V2 style; do not lift `codeaashu/claude-code`.** That repo uses Tailwind + heavy component libs incompatible with the inline-token V2 system Konrad enforces. Cherry-pick _patterns_ (slash menu, tool-call disclosure, sticky auto-scroll) and re-implement against `tokens.ts`. First PR: file edits 1, 5, 8, 9 — fixes Enter, scrollbar, mobile, and the 180s timeout. Ships immediate relief; slash + SSE land in PR 2.
