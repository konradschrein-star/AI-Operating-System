# Hermes UI VPS Inventory (read-only audit, 2026-06-21)

## TL;DR

"Hermes UI" on the VPS is the **content-forge `hub-web` Next.js 15 app** at `/opt/content-forge/apps/hub-web/` (served at `hub.example.com`). It's the same monorepo we're editing locally, so every file path below also exists in our local checkout — meaning **lifts are free copy/paste plus dependency add** (no fetch from VPS required). Stack is Next.js 15 + React 19 + Tailwind v4 + Zustand + TanStack Query + cmdk + sonner + lucide + Material Symbols, license **Apache-2.0** (same owner). The most valuable single lift for AI OS is the **`v2-*` design-token system + GlassCard + `_components/` primitives** under `src/app/(authenticated)/_components/` — they're already inline-styled, theme-swappable, and trivially portable. Konrad's scrollbar complaint is fixable by copying ~10 lines of `v2.css` (6px transparent track + accent thumb).

## VPS layout discovered

- pm2 confirms only one user-facing Next.js UI on the VPS: `hub-web` (id 14, port 3000) → nginx `hub.example.com`.
- `os.example.com` already proxies to our `forge-control-web` (port 7701) — that's the AI OS frontend we're upgrading.
- `agent-dashboard` is a 1-file Flask app (`/opt/agent-dashboard/app.py`, 931 bytes) — not a real UI, ignore.
- `hermes-control-plane` / `hermes-workspace` are headless Node services, no UI files.
- Hub-web repo on VPS = same `content-forge` repo we have locally (`git@github.com:konradschrein-star/content-forge.git`). No VPS-only edits in `apps/hub-web/`.

## Hermes UI stack (`apps/hub-web/package.json`)

- **Framework:** Next.js 15.1 (App Router), React 19, custom tsx server entry (`src/server/index.ts`)
- **State:** Zustand 5, TanStack React Query 5, TanStack Table/Virtual, immer
- **UI primitives:** Tailwind v4 + custom `v2.css` design tokens, `cmdk`, `sonner`, `lucide-react`, Material Symbols (icon font), `class-variance-authority`, `tailwind-merge`
- **Forms/DnD:** react-hook-form + zod, @dnd-kit, react-dropzone, dnd-timeline
- **Realtime:** native `EventSource` (SSE) backed by pg-listen — see `src/hooks/use-sse.ts` + `src/app/api/events/route.ts`
- **Auth:** custom JWT (`jose`) + bcryptjs, session in `_lib/v2-auth.ts`
- **Keybinds:** custom Context-based chord engine (`g+d` style) in `_lib/keybinds.tsx`

## Component catalog

All paths relative to `apps/hub-web/src/`. "AUTH" = `app/(authenticated)/`. License Apache-2.0 for all (own repo).

| Path                                                                                | Purpose                                                 | LOC        | Coupling                               | Liftability                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `app/(authenticated)/_components/glass-card.tsx`                                    | Frosted card primitive                                  | 23         | Zero — pure CSS                        | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-button.tsx`                                     | Themed button (5 variants × 3 sizes)                    | 72         | `cn()` util + `v2.css` classes         | Drop-in + copy `v2.css` `.v2-btn*` block                                                                          |
| `app/(authenticated)/_components/v2-card.tsx`                                       | Card shell                                              | 48         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-input.tsx`                                      | Themed input                                            | 60         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-select.tsx`                                     | Themed select                                           | 67         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-tab-nav.tsx`                                    | Tab bar                                                 | 68         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-typography.tsx`                                 | H1/H2/body presets                                      | 84         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/v2-meta-grid.tsx`                                  | Key/value spec grid                                     | 53         | None                                   | Drop-in                                                                                                           |
| `app/(authenticated)/_components/command-palette.tsx`                               | ⌘K palette (`cmdk` + Material icons)                    | 103        | `cmdk`, next router, `v2.css` vars     | Drop-in (swap PAGES array)                                                                                        |
| `app/(authenticated)/_components/keybind-overlay.tsx`                               | `?`-triggered shortcuts modal                           | 56         | `KeybindProvider`                      | Pair with `_lib/keybinds.tsx`                                                                                     |
| `app/(authenticated)/_lib/keybinds.tsx`                                             | Chord-key Context (`g+d`, `g+j`)                        | 110        | None — pure React                      | Drop-in, becomes our slash/keybind engine                                                                         |
| `app/(authenticated)/_components/sidebar.tsx`                                       | Nav rail + keybind registration                         | 328        | `keybinds`, JWT session shape          | Lift shell, rewrite NAV_ITEMS                                                                                     |
| `app/(authenticated)/_components/header.tsx`                                        | Top bar w/ palette trigger                              | 127        | sidebar context                        | Lift                                                                                                              |
| `app/(authenticated)/_components/pulse-status-badge.tsx`                            | Animated state pills (~40 states mapped)                | 203        | `v2.css` vars only                     | Drop-in (rewrite STATUS_MAP)                                                                                      |
| `app/(authenticated)/_components/jobs-table.tsx`                                    | Sortable/keyboard-navigable list                        | 437        | `date-fns`, PulseStatusBadge, keybinds | Lift as inbox/list base                                                                                           |
| `components/jobs/generation-log-viewer.tsx`                                         | Expandable LLM call log (prompt/output/error)           | 442        | V2Button + v2.css                      | **High-value for AI OS "Run drill-down"**                                                                         |
| `components/jobs/error-detail-panel.tsx`                                            | Failure card w/ stack + retry                           | 205        | V2Button                               | Drop-in                                                                                                           |
| `components/jobs/job-stage-progress.tsx`                                            | Multi-stage horizontal stepper                          | 132        | V2 vars                                | Drop-in for AI OS task stages                                                                                     |
| `components/jobs/pipeline-progress-bar.tsx`                                         | Linear progress w/ stage label                          | 62         | V2 vars                                | Drop-in                                                                                                           |
| `components/dashboard/activity-timeline.tsx`                                        | SSE-fed event feed                                      | 113        | `useSSE`                               | Lift as live activity stream                                                                                      |
| `components/dashboard/metric-card.tsx`                                              | KPI tile                                                | 86         | V2 vars                                | Drop-in                                                                                                           |
| `components/dashboard/pipeline-visualizer.tsx`                                      | Stage-flow viz                                          | 75         | V2 vars                                | Drop-in                                                                                                           |
| `components/dashboard/queue-health-widget.tsx`                                      | Queue depth widget                                      | 69         | TanStack Query                         | Drop-in                                                                                                           |
| `components/system-health/system-health-tabs.tsx` + 4 sibling tabs                  | Worker/queue/error console                              | ~830 total | lucide, TanStack Query                 | Lift `error-console-tab.tsx` (237 LOC) for AI OS "Live" surface                                                   |
| `components/providers/failure-alert-listener.tsx` + `hooks/use-job-error-alerts.ts` | Toast-on-failure via SSE                                | ~70        | sonner + useSSE                        | Drop-in                                                                                                           |
| `hooks/use-sse.ts`                                                                  | Auto-reconnecting SSE client w/ exp backoff             | 130        | None                                   | **Drop-in**                                                                                                       |
| `app/api/events/route.ts` + `server/pg-listen-server.ts`                            | Server SSE fan-out (PG LISTEN)                          | ~180       | pg, session                            | Lift if AI OS needs realtime (yes)                                                                                |
| `app/(authenticated)/approvals/_components/approval-inbox-client.tsx`               | Approve/reject inbox list                               | 237        | GlassCard, fetch                       | **High-value for AI OS Inbox**                                                                                    |
| `app/(authenticated)/production/_components/studio.tsx`                             | Tutorial Studio (job rail + per-job detail pane)        | **2927**   | many internal hooks/types              | Reference only — too coupled, but the **two-pane "job rail + detail" layout pattern** is the model for AI OS chat |
| `app/(authenticated)/v2.css`                                                        | All design tokens, 6 accent themes, buttons, scrollbars | ~700       | None                                   | **Drop-in the whole file**                                                                                        |

No slash-command system exists in hub-web — Konrad's "all of the slash commands won't work here" likely refers to the **chord keybind engine** (`g+d`, `g+j`, etc.) which uses keyboard chords, not text `/commands`. That engine is drop-in; building a true `/`-text slash menu is new work but `command-palette.tsx` + `cmdk` is 80% of it.

## Top 3 immediate lift candidates

1. **`v2.css` + entire `_components/` primitive set** → unblocks the scrollbar complaint + gives AI OS the same look as hub-web in one PR. ~1.1k LOC across ~12 files, zero runtime coupling beyond `cmdk`/`sonner`/Material Symbols (already trivial deps). Maps to: every AI OS surface.
2. **`generation-log-viewer.tsx` (442 LOC) + `error-detail-panel.tsx` (205 LOC)** → ready-made "run drill-down" view for AI OS Today/Control. Each LLM call is an expandable card with prompt/output/duration/model/error — exactly what AI OS executor needs to show per task step.
3. **`approval-inbox-client.tsx` (237 LOC) + `hooks/use-sse.ts` (130 LOC) + `pulse-status-badge.tsx` (203 LOC)** → assemble into AI OS Inbox: list of pending items, live-updating via SSE, status pills with the same visual language as Hermes. Konrad's existing HCP approvals endpoint is already the back-end model.

## Risks

- **Tailwind v4** — hub-web uses `@tailwindcss/postcss` v4 alpha; AI OS frontend may be on v3. Lifting `v2.css` is safe (raw CSS), but lifting components that use Tailwind utility classes (`flex items-center`, etc.) requires matching Tailwind major.
- **Material Symbols font** — many components use `<span className="material-symbols-outlined">`. Need the Google Fonts link in AI OS root layout or icons render blank.
- **`v2-button` references CSS classes (`v2-btn`, `v2-btn-accent`) defined only in `v2.css`** — copying the .tsx without the .css block leaves unstyled buttons.
- **`studio.tsx` is 2927 LOC** and tightly coupled to tutorial job schema — do not lift wholesale; copy layout pattern (rail + detail) only.
- **SSE plumbing depends on pg-listen + Postgres NOTIFY** — AI OS already has Postgres so this fits, but the `pg-listen-server.ts` singleton needs careful porting (it's a server-side stateful module).
- **Auth shapes differ** — hub-web uses custom JWT, AI OS uses NextAuth. Sidebar/header lift requires stripping the `session: JWTPayload` prop and re-wiring to NextAuth session.
