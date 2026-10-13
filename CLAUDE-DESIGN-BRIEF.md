# Claude Design Brief — Personal AI OS Console (v3)

> A single-operator personal AI OS. Two coordinated UIs — a **desktop cockpit** built for running a business at compound leverage, and a **mobile companion** for glancing, capturing, and approving while away from the desk. One operator (Konrad), one VPS, one **agent fleet** that thinks of itself as a company that builds and improves itself.

The desktop is not a dashboard. It is the operator's **place of work** — open all day, eight to twelve hours, every day. The mobile app is not a smaller desktop. It is the **on-the-go nervous system** — quick capture, quick decisions, peace of mind.

The backend already exists at `http://127.0.0.1:7700` (Hono + TypeScript). Real JSON shapes for every surface are included in §16. New endpoints proposed for v3 are flagged `PROPOSED`.

> **What changed in v3 (the AI OS pass).** Three new surfaces — **Tasks**, **Skills**, **Memory** — make the agent fleet first-class. Chat becomes **run-aware** with multi-agent threads and visible cost. A **Stuck** detection system enters the chrome and routes worker questions to manager agents before they reach the human. Permissions become a **Guardrails** surface — basically infinite by default, with a small no-go rulebook the operator can toggle. The OS now treats itself as a **living organism**: skills are composable, memory is editable, agents review each other's work.

---

## Table of contents

- §1 — North star (the OS is a living organism)
- §2 — Visual direction (tokens, type, density, references)
- §3 — Voice and tone (UI + agent + inter-agent comms)
- §4 — Cross-surface chrome (top nav, left rail, status bar, command palette, global search)
- §5 — Desktop information architecture (13 surfaces + Settings)
- §6 — Desktop surface specs
- §7 — Mobile information architecture (5 tabs)
- §8 — Mobile surface specs
- §9 — The Chat surface (run-aware, multi-agent, cost-visible)
- §10 — Registries (Tools + Skills)
- §11 — Inbox, question routing, and the manager-first protocol
- §12 — Stuck detection and the unstick playbook
- §13 — Notifications, presence, sync
- §14 — Keyboard, gestures, command grammar
- §15 — Components needed (shadcn-compatible)
- §16 — Data shapes (real + proposed JSON)
- §17 — Interaction principles
- §18 — What this is **not**
- §19 — Out of scope for the first design pass
- §20 — Implementation note (next prompt)
- §21 — One-line summary

---

## 1. North star

The operator should feel **four uncommon things** every day:

1. **Total awareness.** Nothing is happening on the VPS, in the pipeline, in the bank account, or in his agent fleet's head that isn't surfaced somewhere he can see in under three seconds.
2. **Total leverage.** Any sentence he types or speaks is one step away from execution. The agent fleet is a hand, not a help line.
3. **Total recall.** Every decision, every conversation, every change is logged, searchable, and reviewable — months later.
4. **Total composability.** The agent fleet can build itself: new skills are added, new agents are spawned, memory is rewritten, manager agents teach worker agents. The operator is the gardener, not the gardener-and-the-grass.

If the design ever makes any of those four things harder, it's wrong.

The operator runs:

- A YouTube content engine (formats: `CASUALLY_EXPLAINED`, `POLITICAL_COMMENTARY`, `TECH_COMPARISON`, `TUTORIAL_STUDIO`, `DRAMA`, `SPACE_VIDEO`).
- ~10 small side products (each its own subdomain on the same VPS).
- A Hermes Claude-fleet of agentic workers (currently 5 `cc-*` workers in tmux; meant to scale).
- His own time and money.

The UI must keep all four in the same field of view without ever showing fewer than two at once.

**The agent fleet as a company.** Treat `cc-orchestrator` as a CTO/manager: it routes work, answers worker questions, escalates only what truly needs the human. Treat `cc-renderer-*`, `cc-uploader`, and future workers as line employees. Treat the operator as the CEO who reads briefings, makes the calls only the CEO can make, and goes back to thinking. The UI is the company's HQ.

---

## 2. Visual direction

| Token                | Value                                            | Notes                                                         |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Background base      | `#0d0d0d`                                        | Near-black, slight warmth                                     |
| Background raised    | `#161616`                                        | Cards, composer                                               |
| Background sunken    | `#080808`                                        | Code blocks, status bar, mono panels                          |
| Background highlight | `#1f1f1f`                                        | Selected row, focused input                                   |
| Border subtle        | `#1f1f1f`                                        | Inner dividers                                                |
| Border default       | `#262626`                                        | Card borders, table separators                                |
| Border strong        | `#3a3a3a`                                        | Focused elements                                              |
| Text primary         | `#e8e6e3`                                        | Off-white, never pure white                                   |
| Text secondary       | `#8a8a8a`                                        | Labels, captions                                              |
| Text tertiary        | `#5a5a5a`                                        | Timestamps, hint text                                         |
| **Accent**           | `#ff8c00`                                        | Single accent — action, focus, brand, "live"                  |
| Accent dim           | `#a35a00`                                        | Hover-off, fade target                                        |
| Accent soft          | `rgba(255,140,0,0.10)`                           | Selected row tint, focus halo                                 |
| Status ok            | `#7eb35a`                                        | Muted green, never neon                                       |
| Status warn          | `#d4a64a`                                        | Amber                                                         |
| Status bad           | `#c25450`                                        | Muted red                                                     |
| Status info          | `#6f8aa6`                                        | Cool blue, used sparingly                                     |
| Status stuck         | `#b06fc5`                                        | Distinct purple — agent is stuck (not yet failed, not yet ok) |
| Money in             | `#7eb35a`                                        | Revenue, deposits                                             |
| Money out            | `#d49a4a`                                        | Costs (amber, not red — costs are normal)                     |
| Font UI              | `Inter` 14px base                                | -0.005em tracking                                             |
| Font mono            | `JetBrains Mono`                                 | Every number, ID, timestamp, path, key                        |
| Font display         | `Inter Display` 28–48px                          | Headlines on Money / Goals, sparingly                         |
| Radius               | 4px on cards, 2px on inputs/buttons, 0 on tables | Never larger                                                  |
| Shadow               | None ever                                        | Use borders, not elevation                                    |
| Density grid         | 4 / 8 / 12 / 16 / 24                             | Almost never 32 or 40                                         |
| Default line height  | 1.4 UI, 1.55 prose, 1.5 mono                     |                                                               |
| Icons                | Material Symbols (outlined, weight 200, fill 0)  | Already loaded in the project per CLAUDE.md                   |

**Inspiration to feel:** Linear's command palette, Vercel's logs page, k9s, Datadog host map, the Bloomberg terminal, tmux, the Claude Code CLI, the Things 3 inbox, the SuperHuman inbox, the Stripe dashboard for the Money surface only.

**Anti-inspiration:** Notion, Slack, anything with rounded cards and pastel illustrations, anything that has "Welcome back, Konrad 👋" copy, anything that needs a logo lockup.

The aesthetic point: **everything you see is load-bearing.** If a pixel doesn't help him operate, it's wrong.

---

## 3. Voice and tone

The UI speaks the same way the agent does.

- Curt, factual, mono-friendly. `1 BLEED`, not `One issue requires your attention`.
- Numbers always with units. `184MB`, `47.7%`, `8s ago`, `€12,440 / mo`.
- Lowercase by default; sentence case where natural. No title case anywhere except top-nav labels.
- No emoji in chrome. (Status uses colored dots, not glyphs.)
- No exclamation points anywhere. Ever.
- Errors are diagnostic, not apologetic: `ElevenLabs V3 — 401 Unauthorized. Rotate key in /opt/content-forge/.env.`
- Agent is `agent` (any single agent in 1:1 chat). Worker is `worker` (a named cc-\* in a fleet thread). Manager is `manager` (the orchestrator). User is `konrad`. Never "AI", "assistant", "you".
- **Inter-agent comms** render with the sender's mono ID as prefix: `cc-renderer-1 → cc-orchestrator: asks about narrator for political-commentary pilot`. The middle `→` is `#5a5a5a`, the sender accent if it's a manager, neutral if it's a worker.

---

## 4. Cross-surface chrome

### 4.1 Desktop shell

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▮ forge   TODAY  INBOX(3)  CHAT  •  LIVE  PIPELINE  LIBRARY  MONEY  •  TASKS  SKILLS  ⌘K  │
├──────┬─────────────────────────────────────────────────────────────────────────────────────┤
│      │                                                                                     │
│ rail │                                                                                     │
│ 180  │                            PAGE CONTENT                                             │
│      │                                                                                     │
│      │                                                                                     │
├──────┴─────────────────────────────────────────────────────────────────────────────────────┤
│ ● 65.108.6.149  CPU 1.52  MEM 39%  / 47.7%  forge ●  hermes ●  1 BLEED  2 STUCK  ⌘K  up 5d│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Top nav (44px):**

- Brand mark left: `▮` block in `#ff8c00` + word `forge` in JetBrains Mono.
- Surface tabs separated by middots into three groups:
  - **Operator** — Today · Inbox(n) · Chat
  - **Work** — Live · Pipeline · Library · Money
  - **AI OS** — Tasks · Skills (Memory lives in the rail; Tasks and Skills earn the nav slot because they're used hourly)
- Active tab gets a 2px `#ff8c00` underline + `#e8e6e3` text. Inactive `#8a8a8a`.
- Right end: a compact search affordance showing `⌘K` in JetBrains Mono.

**Left rail (180px, always visible):**
A dense, mono-leaning vertical nav. Each item is one row, 32px tall, label in JetBrains Mono 12px.

```
TODAY                     ●
INBOX                 (3) ●
CHAT
────────────────────────────
LIVE
PIPELINE
LIBRARY
MONEY
────────────────────────────
TASKS                 (7) ●    ← active runs
SKILLS                (42)
MEMORY
────────────────────────────
GOALS
JOURNAL
MAP
────────────────────────────
⚙ SETTINGS
────────────────────────────

● cc-orchestrator  busy
● cc-renderer-1    idle
● cc-renderer-2    busy
● cc-renderer-3    stuck       ← purple dot
● cc-uploader      idle
+ spawn worker
────────────────────────────
konrad                  ●
```

- The left rail doubles as a **fleet glance**: the bottom block shows all `cc-*` workers with a dot — green ok, amber slow, red dead, **purple stuck**.
- A `+ spawn worker` row at the bottom of the fleet block triggers the `worker.spawn` agent action.
- Tap a worker → opens it in Chat with `/watch <worker>` (live thread of its current run).
- Section dividers are `#1f1f1f`, 1px.
- Selected item: `rgba(255,140,0,0.10)` background + 2px `#ff8c00` left border + white text.
- Hover: `#161616` background.

The top nav and left rail intentionally **overlap on the same surfaces**. The top nav is for muscle memory across the seven screens used most; the left rail is for _everything_ and provides the fleet glance.

**Status bar (28px, persistent, never wraps, never hides):**

1. `●` host dot + `65.108.6.149` mono.
2. CPU 1m load.
3. Memory used %.
4. Root disk used %.
5. Per-service rollup dots: `forge ●`, `hermes ●`.
6. `BLEED` counter — `1 BLEED` jumps to the offending Live row on click.
7. **NEW: `STUCK` counter** — `2 STUCK` jumps to the Stuck tab on Tasks. Purple background tint when > 0.
8. `⌘K` hint.
9. Uptime, right-aligned.

Status bar background `#080808`, top border `#262626`. Numbers JetBrains Mono. If a fetch is older than 30s the host dot turns amber; older than 2 min, red.

### 4.2 Mobile shell

```
┌─────────────────────────────────┐
│  forge          ●     ⌘  ▤      │   ← top, 52px
├─────────────────────────────────┤
│                                 │
│         TAB CONTENT             │
│                                 │
├─────────────────────────────────┤
│ ● 1 BLEED  2 STUCK  hermes ●    │   ← collapsible status strip, 28px
├─────────────────────────────────┤
│ ▤      ✉      ●●●      +     ☰ │   ← tab bar, 64px (large + safe area)
│ Today  Inbox  Chat   Capture  ··│
└─────────────────────────────────┘
```

Mobile is 5 tabs (see §7). The strip above the tab bar carries the same `BLEED` + `STUCK` rollup so the operator never loses peripheral awareness while away from the desk. The `More` (☰) drawer exposes Tasks, Skills, Memory among the other secondary surfaces.

### 4.3 Command palette (`⌘K`)

Overlay, 640px desktop / full-width mobile sheet from top. Single input + a flat result list with **scoped sections**:

```
> rotate elevenlabs key

ACTIONS
  ⚡  Rotate ElevenLabs V3 key                  ↵
  ⚡  Open /opt/content-forge/.env in chat       ↵

TASKS
  ●  task_01HX...  Render CE 12 months → AWAITING_QC   ↵
  ◐  task_01HY...  Drama smoke test  (stuck 12m)        ↵

JOBS
  ●  4ce58517  Why we have 12 months…  FAILED   ↵

WORKERS
  ●  cc-orchestrator                            ↵

SKILLS
  ▢  graphify                                    ↵
  ▢  systematic-debugging                        ↵

PAGES
  →  Money › Provider costs                     ↵
```

- Result row: leading icon/dot, mono ID, sans description, mono shortcut hint right.
- `↑/↓` navigates, `↵` runs, `⌘↵` opens in a side drawer instead of navigating away.
- Actions are typed and live in a registry (§14.3); jobs/workers/tasks/skills come from the same backend the surfaces use.
- The palette also accepts **commands** prefixed with `/` and **natural-language requests** prefixed with `>`. A `>` query dispatches to the agent as a fresh chat message.

### 4.4 Global search

Same input as the palette, no prefix → fuzzy across: tasks, runs, jobs, workers, PM2 processes, systemd units, library assets, journal entries, decisions, skills, memory entries, money line items. The palette is the search surface; there is no separate search page in v3.

---

## 5. Desktop information architecture

Thirteen surfaces. The first seven are top-nav. Tasks/Skills/Memory get top-nav slots too. Goals/Journal/Map/Settings live in the rail.

| #   | Group    | Surface      | What it answers                                              |
| --- | -------- | ------------ | ------------------------------------------------------------ |
| 1   | Operator | **Today**    | What should I do, and what is on fire, in the next 12 hours? |
| 2   | Operator | **Inbox**    | What is waiting on a decision from me?                       |
| 3   | Operator | **Chat**     | I want to do a thing — let me talk to the agent.             |
| 4   | Work     | **Live**     | What is the machine doing right now?                         |
| 5   | Work     | **Pipeline** | Where is each video in production, by channel?               |
| 6   | Work     | **Library**  | What assets, scripts, drafts, ideas do I have?               |
| 7   | Work     | **Money**    | What is coming in, going out, and what's my runway?          |
| 8   | AI OS    | **Tasks**    | What runs are alive, what are they doing, who is stuck?      |
| 9   | AI OS    | **Skills**   | What does my fleet know how to do?                           |
| 10  | AI OS    | **Memory**   | What does my fleet know, period — the persistent brain.      |
| 11  | Recall   | **Goals**    | What am I trying to accomplish this quarter / week / day?    |
| 12  | Recall   | **Journal**  | What happened today / this week — auto-logged.               |
| 13  | Recall   | **Map**      | Where does X live, and what runs it?                         |

**Settings** lives in the rail (cog icon). Its sub-pages are first-class: **Guardrails**, **Connectors**, **Providers** (read-mirror of Map → Providers, with credentials editor), **Notifications**, **Hotkeys**, **About**.

Two surfaces are explicitly **not** here:

- **External comms** (email, YouTube comments, social mentions) — separate tooling per operator preference. The OS may _link out_ to those tools from Chat actions, but does not host them.
- **Obsidian** — out of scope. His personal notes stay in his Obsidian vault. The OS reads a small reference subset, never writes.

---

## 6. Desktop surface specs

### 6.1 Today

The morning landing page. Replaces the "open laptop and figure out what to do" loop.

Layout: **single column, max-width 1280px, centered.** Five blocks stacked, each a `Card` with no shadow, 4px radius. The page reads top-down like a personal briefing.

#### Block 1 — The morning line

A single line in Inter Display 28px:

> `Tuesday, 16 June 2026.  3 to ship today.  1 bleed.  2 stuck.  €127 spent yesterday.`

Each clause is a chip you can click:

- The date → opens Journal at today's entry.
- `3 to ship today` → scrolls to Block 3 (Today's plan).
- `1 bleed` → jumps to the failing Live row.
- `2 stuck` → jumps to Tasks → Stuck.
- Money clause → jumps to Money.

This is the only "hero" copy in the entire app.

#### Block 2 — Priority cards (3 max)

Three cards in a horizontal row, each ≈360×140px. Each card represents a **top-of-mind item** the agent decided is the most leverage-positive thing the operator could touch today. Source: an `agent.priorities` table (the manager agent writes to this nightly).

A card:

- Tiny label top-left in mono: `PRIORITY · 1`.
- Title: 18px Inter, two lines max.
- One-line reason in `#8a8a8a` Inter 13px.
- Bottom strip: a `▶ Open` action that drops the priority into Chat as context, and a `× Dismiss` action.

Empty state: a single muted line `manager has nothing to escalate. quiet day.` — no illustration.

#### Block 3 — Today's plan

A checklist of what should happen today. Pulled from `agent.today_plan`, regenerated each morning and re-pinged when major events change (a job finishes, a bleed appears, a worker gets stuck).

Each row:

- A square checkbox (toggle = mark done).
- Title.
- A small `WHY` chip on hover showing the manager agent's one-line rationale.
- A right-side label: `via chat` (he'll handle it), `via fleet` (a worker is already on it — non-actionable for him), `wait` (gated on something).
- Drag-to-reorder.

Below the list: `+ Add` field. Typing here also accepts commands — `/ship 4ce58517` adds "Ship video 4ce58517" and tags it `via chat`.

#### Block 4 — Pipeline pulse

A horizontal funnel showing today's content production flow. Six bars from left to right: Idea → Script → Assets → Render → Upload → Live. Each bar shows: a number in JetBrains Mono 22px, and below it `format · format · format` in mono 11px (the formats whose jobs sit at that stage).

Click any bar → jumps to Pipeline filtered to that stage.

#### Block 5 — Money pulse

Three small tiles: Revenue MTD · Spend MTD · Runway. Numbers in JetBrains Mono Display 22px. Tiny sparkline below each (30 days).

#### Block 6 — Agent diary (collapsed by default)

A 1-line summary of what the agent fleet did overnight and a "▶ expand" to read the full diary entry — the manager agent's nightly write-up of: runs completed, runs blocked, money spent, learnings written to Memory, new skills installed, workers spawned or retired.

---

### 6.2 Inbox

The single surface for **everything that requires a human decision** — but only after the manager agent has been unable to resolve it. See §11 for the question-routing protocol that _prevents_ most things from reaching this Inbox.

Layout: **two-column**, like a mail client. Left list 360px, right detail flexible.

**Item types** (the agent fleet writes these via the `inbox.create` action):

| Kind               | Example title                                                             | Decision shape                          |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------- |
| `approve`          | "Ship video 4ce58517 to YouTube?"                                         | Approve / Reject / Edit before          |
| `decide`           | "Drama format: switch reference library to V2?"                           | Pick one of N options                   |
| `confirm`          | "Delete worker space-renderer-3 (idle 6h)?"                               | Yes / No / Snooze 1h                    |
| `triage`           | "Job 4ce58517 failed at TTS. Try Minimax, try ElevenLabs again, or skip?" | Pick a path                             |
| `review`           | "Script v2 ready for 'Why 12 months'."                                    | Open in Library                         |
| `alert`            | "AI33 primary key returned 429 for the 5th time."                         | Acknowledge / Open in Chat              |
| `bleed`            | "ElevenLabs V3 401."                                                      | Acknowledge / Open in Chat / Snooze     |
| `stuck-escalation` | "cc-renderer-3 stuck 12m on QMS step. Manager could not resolve."         | Resolve in Chat / Auto-skip / Kill task |
| `guardrail`        | "Action would spend €18 on a single image batch. Approve?"                | Approve once / Approve always / Reject  |

Each list row:

- Left edge: a 4px colored bar by kind (`bleed` red, `stuck-escalation` purple, `guardrail` amber, `approve` accent, etc.).
- Kind tag in mono 11px.
- Title.
- Timestamp dim mono.
- Right side: a checkmark and an `→` arrow.

Detail pane:

- Big title.
- A `WHY` block — the agent's reasoning, rendered as agent-message-style markdown.
- A `MANAGER TRIED` block (NEW in v3) — only present on `stuck-escalation` and `triage`. Shows what the manager agent already attempted, why it failed, why this is now on the human's desk. Mono code-block style.
- A `CONTEXT` block — quoted JSON / file snippets / task records that informed the decision.
- Decision affordances at the bottom, sized large (52px tall), keyboard-accessible: `A` approve, `R` reject, `E` edit, `S` snooze, `O` open in chat.

The Inbox supports **bulk-handling**: select N items, fire one of the actions if compatible. The Inbox count in the chrome reflects unresolved count.

Empty state: `0 items. fleet is handling itself.` — one line, dim. (Empty Inbox is the success state — it means the manager is doing its job.)

---

### 6.3 Chat — see §9 for the full spec

---

### 6.4 Live

Operator's view of the running machine. Two columns, dense, no scroll on 1440×900+.

#### Left column (≈70%)

**A. Hermes fleet** — one card per `cc-*` worker. Adds in v3: a tiny mono badge on each card showing the current run id the worker owns (`task_01HX...`), or `idle`. Click the badge → opens that run in Tasks.

**B. Content Forge — jobs in flight** — dense table; failed-row inline-expand to `error_message` + `▶ Open in chat`.

**C. PM2 fleet** — 3-column list with restart-count escalation.

**D. BullMQ queue depths** — a strip of mono badges:

```
qms 0 │ tts 0 │ image 1 │ render 0 │ upload 0 │ qc 0
```

Amber if any queue has waiting > 5, red if > 20.

**E. Docker containers** — one row per active container (Postgres, Redis, CouchDB, etc.). Name, image, uptime, mem.

#### Right column (≈30%)

**F. System pulse** — three stat tiles (CPU 1m, MEM, DISK) with sparklines.

**G. Provider pulse** — small badges per upstream provider:

```
Claude pool ●   ElevenLabs ●(401)   AI33 ●(429)   fast-gen ●   Gemini pool ●
```

Click any badge → opens that provider's failure log in Chat as quoted context.

**H. Recent events** — tail of `/api/hermes/events`, filter strip: `[ All | Workers | Tasks | Failures | Inter-agent ]`. The new `Inter-agent` filter shows the message-bus traffic between agents.

**I. Watched logs** — three pinnable slots for tmux/PM2 tails.

**J. Stuck strip (NEW)** — when `STUCK > 0`, a strip just under the events feed:

```
2 STUCK
●  cc-renderer-3   12m   QMS step — manager could not resolve   ▶ go
●  cc-uploader      4m   awaiting human answer (script tone)    ▶ go
```

Each row → opens the run in Tasks → Stuck.

Hidden until non-empty: `K. Systemd warnings`.

---

### 6.5 Pipeline

Content production at a glance. Layout: a horizontal funnel per channel.

Top strip: per-channel velocity for the trailing 7 / 30 / 90 days, in JetBrains Mono — `CE 4 / 12 / 38`, `PC 0 / 3 / 11`, etc.

Body: one row per format/channel. Each row is a horizontal funnel — 8 segments (the major states in the ~40-state machine, collapsed to: `Idea → Script → TTS → Assets → QMS → Render → Upload → Published`).

Each segment is a tiny stacked-bar; color-coded by age. Red = bottleneck.

Click any segment → reveals an inline drawer with the actual jobs in that state, sorted by age.

Below the per-channel rows: **Bottlenecks** — manager-agent-detected places in the funnel that have stalled jobs for longer than the format's median.

Right-side panel: **format launchers**. Six tiles, one per format, with a `▶ New job` button.

---

### 6.6 Library

Five tabs: **Scripts · Voices · Images · Clips · Templates**. Each tab is a dense grid of cards with filters. (Unchanged from v2.)

---

### 6.7 Money

A Stripe-density financial cockpit for one operator. Three stacked horizontal bands.

**Band 1 — Big numbers** (5 tiles): Revenue MTD · Spend MTD · Net MTD · Cash · Runway. Inter Display 36px numbers, mono. Trend chips: green positive, red negative.

**Band 2 — Two charts**: 30-day revenue vs spend (two-line chart, accent for revenue, amber for spend) · Provider cost breakdown (horizontal stacked bar, click segment to filter the ledger below).

**Band 3 — Ledger**: table of money events, newest first. Columns: date, kind, counterparty, description, amount, attachments, `▶`. Side panel: per-channel P&L. The agent imputes cost-per-job from provider invoices.

(Money is preserved from v2 — it is business-critical and stays.)

---

### 6.8 Tasks (NEW — the long-running operations surface)

The single most important AI OS surface after Chat. **Every autonomous run lives here.** A "task" / "run" is one goal executed by one agent, with optional sub-runs spawned by sub-tasking. The Tasks surface is to runs what a tmux session manager is to terminal sessions — but for agentic work.

Layout: **left list (320px) + right detail (flexible).** Plus a sub-tab strip at the top: `Active · Stuck · Queued · Done · All`.

#### 6.8.1 The Run object

A run has:

- `id` (`task_01HX...`)
- `goal` (one sentence the operator or agent wrote)
- `owner` (`cc-orchestrator`, `cc-renderer-1`, etc. — or `unassigned`)
- `status` (`queued`, `running`, `paused`, `stuck`, `done`, `failed`, `killed`)
- `parent` (the run that spawned this one, if any)
- `children` (sub-runs)
- `created_at`, `started_at`, `last_update_at`, `finished_at`
- `eta` (manager-estimated remaining wall-clock)
- `budget` (`time_seconds_cap`, `spend_cents_cap`)
- `spend_cents_so_far`
- `current_step` (one-line label of what the agent is doing this moment)
- `progress` (0–1 if applicable)
- `thread` (the conversation: agent messages, tool calls, inter-agent messages)
- `stuck_reason` (only if `status = stuck`; see §12)
- `result` (the output when done — text, file paths, job ids, etc.)

#### 6.8.2 Left list

Each row:

- Status icon: `●` running (accent, pulsing), `◐` stuck (purple), `▶` queued, `▣` paused, `✓` done (dim), `✗` failed (red).
- Goal title, single line truncated.
- Owner badge in mono.
- Right side: age since last update, mono dim. Stuck runs get a purple bar on the left edge.

Filter strip at the top: `Active(5) · Stuck(2) · Queued(1) · Done(28) · All`.

Search input below the filter strip — fuzzy across goal, owner, current step.

A `+ Dispatch` button at the bottom opens a small composer:

```
goal:    Render the political-commentary pilot end-to-end
owner:   cc-orchestrator ▾    (auto: routes to least loaded capable worker)
budget:  €5 time-cap 2h
[ dispatch ]
```

#### 6.8.3 Right detail

A run's detail pane has four stacked sections:

**1. Header strip (88px)**

```
●  Render the political-commentary pilot end-to-end       eta 18m   spent €0.42 / €5
   cc-orchestrator → cc-renderer-1                        running   step: ASSET_COLLECTION
   [▣ pause]  [✗ kill]  [↻ retry]  [⤴ handoff]  [+ subtask]
```

The handoff control reassigns the run to a different worker — useful when one worker is stuck and a peer can take over.
The `+ subtask` control spawns a child run with inherited context.

**2. Live thread (flexible)**
Renders the run's conversation in the same style as Chat (§9). Differences:

- Tool call cards are denser by default (header-only, expand on click) because runs accumulate dozens.
- **Inter-agent message blocks** are a new kind of card with a colored left edge:
  ```
  cc-renderer-1 → cc-orchestrator                 18s ago
  Asks: narrator for political-commentary pilot — default or sponsor-specific?
  cc-orchestrator → cc-renderer-1                 12s ago
  Answers: default. (channel.default_narrator = "biker_voice_1")
  ```
  Worker question = neutral border. Manager answer = accent border.
- **Stuck banner** appears at the top of the thread if `status = stuck`, with the unstick controls (§12).

**3. Run tree (right rail, 280px)**
Hierarchical view of parent / current / children, with each node showing status icon + goal first line + owner. The current run is bold.

```
▣ Ship CE_2026_06 batch
  ● Render the political-commentary pilot end-to-end   ← current
    ● Generate hero image set
    ◐ Generate voice over (stuck, ElevenLabs 401)
    ▶ QMS validate
```

Click any node → opens that run.

**4. Costs & meta (collapsed by default)**

- Spend by provider for this run.
- Tool/skill usage counts.
- Memory writes during this run (link to Memory).
- Inputs / outputs.

#### 6.8.4 Stuck tab

A filtered view of the left list (`status = stuck`) — surfaced as its own tab because **stuck is the most actionable category**. See §12.

#### 6.8.5 Dispatch board (sub-tab `+ Dispatch board`)

A small surface for sending the _same goal_ to _multiple agents_ in parallel — useful for "ask cc-renderer-1 and cc-renderer-2 to each draft a thumbnail, I'll pick".

```
goal:   draft a thumbnail for "12 months"
fanout: cc-renderer-1, cc-renderer-2, cc-renderer-3
merge:  manual pick                       ▾
[ dispatch fanout ]
```

When fanout dispatches, the resulting child runs appear in the parent run's tree, side-by-side, and the operator can compare results in Tasks.

---

### 6.9 Skills (NEW)

The fleet's composable expertise. Every skill is a markdown file with frontmatter (the existing skills system per CLAUDE.md). The Skills surface makes this **first-class**: every agent has access to every skill in the registry.

Layout: **two-column.** Left list (320px) + right detail (flexible).

#### 6.9.1 Left list

Filter strip: `All · Recent · Mine · Built-in · Inactive`. Search box.

Each row:

- Skill name in JetBrains Mono.
- One-line description in Inter 12px `#8a8a8a`.
- Right side: invocation count last 7 days, mono dim. `42×` if popular, blank if unused.

Sections:

- `★ Pinned` (top — operator-pinned, like `graphify`)
- Categories (auto-grouped by frontmatter `category`): `Process`, `Implementation`, `Operations`, `Personal`, `Custom`.

`+ New skill` button at top — opens a new-skill template editor.

#### 6.9.2 Right detail

Header strip:

```
graphify                                 Process · invoked 14× this week
"any input to knowledge graph"
[ ▶ test ]  [ ✎ edit ]  [ ⤓ disable ]  [ ⌘ copy invocation ]
```

Tabs underneath:

- **README** — the skill's markdown content rendered (the `SKILL.md`).
- **Recent invocations** — table of last N runs that called this skill, with run id, agent, status, duration, result link.
- **Tests** — synthetic prompts the operator can run to verify the skill still works after edits.
- **Permissions** — which agents and which conversation modes are allowed to invoke it. Default: all agents, all modes.
- **Source** — the raw file editor (Monaco-style) with syntax highlighting for the frontmatter.

#### 6.9.3 The skill-of-skills

A meta-skill: `skill-author` — the manager agent can write new skills based on observed patterns. When the manager writes a skill, it goes into the `Pending` section of the Skills list for operator review before being available to the fleet. This is the **self-improvement loop**.

---

### 6.10 Memory (NEW)

The fleet's persistent brain. The operator's auto-memory directory (`memory/MEMORY.md` + the per-topic `.md` files) plus the agent's read/write inspector.

Layout: **three columns.** Left index (260px) + middle reader/editor (flexible) + right metadata (260px).

#### 6.10.1 Left index

The auto-generated table of contents from `MEMORY.md`. Each entry: title + one-line hook + type chip (`user`, `feedback`, `project`, `reference`).

Filter strip: `All · User · Feedback · Project · Reference · Stale`.

The `Stale` filter shows entries the agent's heuristics flagged as possibly outdated (older than N days with no read-event since).

Search box. `+ New entry` button.

#### 6.10.2 Middle pane

The selected entry rendered as markdown, editable inline. Frontmatter pinned at the top in a small mono block.

A `↻ Re-link` button finds `[[name]]` references in the current entry and shows which are valid vs missing.

A `★ Promote to skill` button takes a recurring rule and converts it to a skill (with manager-agent help).

#### 6.10.3 Right metadata

- `Linked from` — list of other memory entries that reference this one (`[[name]]` graph).
- `Recent reads` — which runs read this entry recently, ordered by recency.
- `Recent writes` — when this entry was last edited and by whom (operator, manager, worker).
- `Decision history` — if this is a `feedback` or `project` entry, the chain of overrides/refinements over time.

This surface is **how the operator audits what the fleet believes** — and how he corrects it.

---

### 6.11 Goals · 6.12 Journal · 6.13 Map

(Preserved from v2.)

- **Goals** — Quarter cards · Week list · Today mirror.
- **Journal** — Day calendar strip + reading pane. Auto-populated; Decisions sub-section logs every Inbox resolution.
- **Map** — Services · Domains · Storage · Providers · Channels.

---

### 6.14 Settings (rail)

Sub-pages, each its own row in the rail when Settings is selected:

#### 6.14.1 Guardrails

The **no-go rulebook**. Per the operator: permissions are basically infinite, with a small set of toggleable rules to prevent the obvious disasters.

Layout: a single column of rule rows.

Each rule row:

- Rule name in mono.
- One-line description.
- A toggle switch (on/off).
- Last-trip badge: `tripped 3× this month` if any.
- A `▶ history` link → modal showing every time this rule fired and what the operator decided.

Default rules (all ON by default):

| Rule                      | Effect when ON                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `spend.cap.day`           | Total agent-driven spend > €X / day → halt, escalate to Inbox as `guardrail`. Configurable cap, default €50. |
| `spend.cap.provider.day`  | Per-provider daily cap. ElevenLabs / AI33 / Claude pool each get a sub-cap.                                  |
| `spend.cap.single_action` | Any single action > €Y → confirm. Default €5.                                                                |
| `destructive.fs`          | `rm -rf`, `dropdb`, `DROP TABLE`, anything irreversible → confirm.                                           |
| `git.push.force`          | `git push --force` → confirm.                                                                                |
| `git.main.push`           | Direct push to `main` → confirm.                                                                             |
| `prod.deploy`             | PM2 restart of `hub-web` or `worker-render` in production → confirm.                                         |
| `outbound.publish`        | YouTube upload to a live channel → confirm.                                                                  |
| `worker.spawn`            | Spawning > N workers in a window → confirm.                                                                  |
| `secrets.read`            | Reading `.env`, `.credentials.json`, anything matching `*secret*` → confirm.                                 |
| `outbound.email`          | Sending email to anyone → confirm.                                                                           |
| `outbound.social`         | Posting to any social account → confirm.                                                                     |

Below the table: a free-text **custom rules** editor where the operator writes plain-English no-gos. Example: `do not retry a job more than 3 times in any 1-hour window`. The manager agent parses these into structured rules.

A big `■ pause all agents` switch at the top — emergency stop.

#### 6.14.2 Connectors

A list of external service integrations. Each row: name, status dot, last sync, configure.

Sections:

- **Connected** — name, last sync ts, `▶ configure`, `× disconnect`.
- **Available** — generic shells the operator can wire up.
- **Failing** — status red, error preview, `▶ fix`.

The connector pattern is generic: each connector is a small TypeScript module exposing `auth()`, `sync()`, `act()`. A connector adds itself as one or more `agent.actions` so it becomes invocable from any chat / task.

Connectors the operator will want connected (per his ecosystem):

- YouTube channels (read analytics, upload videos)
- Hetzner API (server health, billing)
- Cloudflare (DNS, R2 storage)
- Stripe (revenue events when monetizing)
- GitHub (repos, issues, PRs)
- Anthropic / OpenAI / ElevenLabs / AI33 / fast-gen / Suno / Veo (provider accounts — usage + billing)
- Obsidian LiveSync (read-only into reference notes)
- NTFY / Telegram (mobile push)
- Calendar (read-only, surfaced on Today eventually)

This is a **shell** for the design pass. Each connector's setup wizard will be added over time.

#### 6.14.3 Providers · Notifications · Hotkeys · About

(Minor sub-pages; one screen each.)

---

## 7. Mobile information architecture

Five tabs at the bottom. Designed for one-handed use, vertical scroll only, large tap targets.

| #   | Tab         | Use case                                                                                                   |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Today**   | Glance: what should happen, what's on fire, what's stuck, what shipped overnight                           |
| 2   | **Inbox**   | Triage decisions in line at a coffee shop                                                                  |
| 3   | **Chat**    | Talk to the agent from anywhere                                                                            |
| 4   | **Capture** | Voice / photo / text → routed to the agent                                                                 |
| 5   | **More**    | Drawer to Live, Pipeline, Library, Money, **Tasks**, **Skills**, **Memory**, Goals, Journal, Map, Settings |

Tasks gets a thin presence on Today (Block: "Stuck runs"). Skills and Memory are read-mostly on mobile.

---

## 8. Mobile surface specs

### 8.1 Today (mobile)

A single vertical scroll. Sections:

1. **Header line** stacked over 2 lines:
   ```
   Tue, 16 Jun
   3 to ship · 1 bleed · 2 stuck · €127 yesterday
   ```
2. **Stuck runs (NEW)** — a horizontal card list, one card per stuck run. Each card: agent, age stuck, one-line reason, `[Resolve in chat]` button.
3. **Priority cards** — 3 cards stacked.
4. **Today's checklist** — same items as desktop.
5. **Pipeline pulse** — funnel as vertical strip.
6. **Money pulse** — three rows.
7. **Agent diary** — collapsible.

### 8.2 Inbox (mobile)

(Unchanged from v2 — list + full-screen detail, swipe gestures, sticky decision buttons.)

### 8.3 Chat (mobile)

(See §9.4 for the mobile-specific differences. Adds: tap a tool-call header to expand; long-press an agent message to "★ remember" the rule into Memory.)

### 8.4 Capture (mobile)

(Unchanged from v2 — voice, photo, text → `idea` / `inbox` / `chat` routes.)

### 8.5 More (mobile)

A drawer list with icon + label. Items: Live · Pipeline · Library · Money · **Tasks** · **Skills** · **Memory** · Goals · Journal · Map · Settings.

Tapping any opens a **read-only mobile rendition** of that surface. Tasks on mobile is especially valuable: the operator can glance at active runs and pause/kill from anywhere.

---

## 9. The Chat surface (PC + mobile, run-aware)

Chat is **the workhorse**. Every other surface drops context here. In v3, Chat is also **run-aware** — every conversation is, under the hood, a Run (§6.8). When the agent dispatches autonomous work, that work becomes a child Run visible in both Chat and Tasks.

### 9.1 Desktop layout — three columns

```
┌──────────────────┬────────────────────────────────────┬──────────────────────┐
│  CONVERSATIONS   │           CONVERSATION             │  CONTEXT · COST · ··│
└──────────────────┴────────────────────────────────────┴──────────────────────┘
   260px              flexible                              300px
```

### 9.2 Left column — Conversations

Search input at top. Sections: `● Active`, `Pinned`, `Today`, `Yesterday`, `This week`, `Older`.

Row: title, date mono, message + tool-call count.

`+ New` opens with a **mode** picker:

- `default` — broad agent.
- `triage` — diagnose only; no edits.
- `ship` — agent will deploy and push.
- `research` — WebSearch/WebFetch only.
- `journal` — talk-to-self; logs to Journal.
- **NEW: `fleet`** — multi-agent thread; the operator can address multiple `cc-*` workers in one conversation and they reply in-thread.
- **NEW: `manage`** — the operator is talking to `cc-orchestrator` as a CTO; this mode unlocks `worker.spawn`, `worker.kill`, `task.reassign` actions.

### 9.3 Middle column — Conversation

User messages: left-margined by 32px, `konrad >` prefix in mono `#8a8a8a`, plain text.

Agent messages: full-width, `agent >` (or worker id `cc-renderer-1 >`) prefix in mono accent, markdown rendered.

**Tool call blocks** — first-class cards, never collapsed by default (header-only on Tasks where density wins, expanded on Chat):

```
▶ Read  pacing.ts:120-160                                          142ms
```

**Skill call blocks (NEW)** — distinct from tool calls. A skill invocation renders as a slightly accented card:

```
▣ Skill  graphify                                                   running
   "any input to knowledge graph"
   →  builds a knowledge graph from the attached note...
```

**Inter-agent message blocks (NEW)** — in `fleet` mode, agents talking to each other render with the `sender → receiver` header:

```
cc-renderer-1 → cc-orchestrator                                   18s ago
asks: narrator for political-commentary pilot — default or sponsor-specific?
```

**Run links (NEW)** — when the agent dispatches autonomous work, the conversation shows a Run card:

```
▶ Run  task_01HX2K...  cc-renderer-1                              running
   goal: render the political-commentary pilot end-to-end
   eta 18m · spent €0.42 / €5
   [ ▶ open in tasks ]   [ ▣ pause ]   [ ✗ kill ]
```

**Streaming**: thin `#ff8c00` underline at the cursor. When a tool/skill/run begins, the underline pauses and the card slides in.

**Composer** (bottom):

- Multi-line, auto-grow.
- Mono `>` prefix.
- Context chips above (files, jobs, workers, runs, library items, memory entries, skills) — removable, drag-reorder.
- Control row:
  ```
  ⌘↵ send       + attach   tools   skills   mode: default ▾   agent: claude-opus-4-7
  ```
- `+ attach` sub-menu: file, job, worker, run, library item, inbox item, memory entry, skill, current selection.
- `tools` opens the tool selector for this turn (gated by mode).
- `skills` opens the skill picker.
- `mode` selector — switches conversation gating (and adds `fleet` / `manage`).
- `agent` selector — which model serves this turn.

### 9.4 Right column — Context · Cost · Tools · Skills · Watching

Five collapsible sections, stacked:

1. **Attached context** — chip list with previews.
2. **Cost (NEW)** — a small panel:
   ```
   tokens in       12,420
   tokens out       4,180
   cost              €0.18
   tool calls          47
   skill calls          3
   runs dispatched      2 (€0.42 + €1.10)
   ─────────────────────
   thread total      €1.70
   ```
   Updated live as the conversation proceeds. Each line is mono. The `runs dispatched` total includes child run spend.
3. **Tools** — see §10. Per-tool invocation count + permission state.
4. **Skills** — see §10. Per-skill invocation count + pin/unpin.
5. **Watching** — pinned background-tail resources (jobs, workers, PM2 procs, runs, Inbox items).

### 9.5 Persistence and the run model

Every conversation persists. Tool calls, skill calls, inter-agent messages, dispatched runs — all persisted to a `runs` table. The agent worker (`claude -p` in tmux, Hermes pattern) reads run state from the DB. Closing the browser doesn't kill the agent's run. The conversation continues server-side until the agent emits `done` — at which point a desktop notification fires.

### 9.6 Feedback affordances (NEW)

Two micro-affordances on every agent message:

- **`★ remember`** — long-press (mobile) or right-click (desktop) → opens a small popover: "what rule should the fleet remember from this message?" → writes to Memory as a `feedback` entry.
- **`✗ wrong`** — quick flag. Adds a one-line note to the run thread, posts a `lesson` event to the shared Memory, and the manager agent reviews the message at next nightly diary.

These are **the operator's leverage**: every correction compounds into the fleet's behavior.

### 9.7 Mobile

(Composer is the centerpiece. Mic button is 44×44. Push-to-talk overlay. Tool-call cards collapse to header by default. Long-press an agent message → `★ remember` / `✗ wrong` / `↗ open in tasks`.)

---

## 10. Registries (Tools + Skills)

The agent has two registries. Both visible in Chat's right rail and in their own dedicated surface (Tools live under Map → Map → Skills surface for now; Skills get the full §6.9 surface).

### 10.1 Tools registry

Built-in capabilities the agent invokes via the runtime.

```
TOOLS (built-in)
─────────────────────────────
Read              28×
Edit               7×
Bash              14×
Grep              19×
Glob               6×
WebFetch           2×
WebSearch          0×
─────────────────────────────
forge-control       (the read-only API)
  hermes.workers     3×
  forge.jobs         4×
  pm2.list           1×
  system.stats       6×
─────────────────────────────
agent.actions       (write-side actions, see §14.3)
  pm2.restart        0×
  job.retry          1×
  job.kill           0×
  worker.spawn       0×
  worker.kill        0×
  task.dispatch      2×
  task.reassign      0×
  inbox.create       2×
  memory.write       4×
  skill.install      0×
─────────────────────────────
```

### 10.2 Skills registry

Composable expertise. The agent invokes via the `Skill` tool. See §6.9 for the full surface.

```
SKILLS (composable, per §6.9)
─────────────────────────────
★ Pinned
  graphify                       14×
  systematic-debugging            6×
─────────────────────────────
Process
  brainstorming                   3×
  writing-plans                   2×
─────────────────────────────
Implementation
  frontend-design                 1×
  mcp-builder                     0×
─────────────────────────────
Personal
  remember                        4×
─────────────────────────────
+ new skill
```

**All skills are available to all agents in the fleet by default.** This is the operator's explicit preference. Per-skill permissioning is possible (the skill's Permissions tab in §6.9.2) but unused unless he opts in.

---

## 11. Inbox, question routing, and the manager-first protocol

The Inbox is **the operator's attention budget**. v3 introduces a routing protocol that funnels worker questions through the manager agent first.

### 11.1 The routing chain

```
worker question
   │
   ▼
manager-agent attempts answer
   │   ├─ resolved (most cases)  →  posted back in run thread, no human touch
   │   ├─ partial / uncertain    →  posted back with confidence chip, no human touch
   │   └─ unresolvable           →  escalated as Inbox `stuck-escalation`
```

Same chain for API errors:

```
worker hits API error
   │
   ▼
unstick-playbook attempts auto-fix (§12)
   │   ├─ resolved              →  worker continues, event logged
   │   └─ unresolvable          →  escalated as Inbox `bleed` or `stuck-escalation`
```

The point: **most questions never reach the human.** The manager is a CTO, not a passthrough.

### 11.2 The `MANAGER TRIED` block

Every escalated Inbox item must show, in mono, what the manager attempted. This forces the manager to be transparent and the operator to learn the fleet's failure patterns.

Example:

```
MANAGER TRIED
─────────────────────────────
1. Switched TTS provider to ai33_minimax    →  also 429
2. Backed off and retried after 60s         →  same 429
3. Checked AI33 dashboard via fast-gen      →  primary key 12/10 tasks queued
4. Looked for Memory rule "AI33 zombie tasks"  →  found, applied: still blocked
5. No further unstick rule applies. Escalating.
─────────────────────────────
```

### 11.3 Question routing rules (configurable in Guardrails)

By default, all worker questions route to `cc-orchestrator` (the manager). The operator can configure overrides per worker / per topic:

- "Questions about narrators always answer with channel default."
- "Questions about deletion of files always escalate to me."
- "Questions about cost > €5 always escalate to me."

### 11.4 The decision affordances stay one-keystroke

`A` approve, `R` reject, `E` edit, `S` snooze, `O` open in chat. Plus new:

- `M` "manager, handle this yourself" — bounces back to the manager with the instruction "you decide and report".

---

## 12. Stuck detection and the unstick playbook

The operator's biggest leverage loss is a worker silently spinning. v3 makes stuck a **first-class state** with detection rules and an unstick playbook.

### 12.1 Stuck signals (any one triggers `status = stuck`)

| Signal                    | Heuristic                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `no_progress_heartbeat`   | Worker heartbeat hasn't included a `progress` or `task_completed` event in N minutes (configurable per worker role; default 5 min). |
| `repeated_api_error`      | Same provider + same status code 3× in 60s.                                                                                         |
| `asks_question_no_action` | Agent message contains "should I" / "do you want me to" / "I'll wait" without an accompanying tool call within 30s.                 |
| `loop_detection`          | Same tool called > 5× with similar args in 2 min.                                                                                   |
| `budget_approaching`      | Run's `spend_cents_so_far` > 80% of `spend_cents_cap`.                                                                              |
| `time_approaching`        | Wall-clock > 80% of `time_seconds_cap`.                                                                                             |
| `manager_flagged`         | Manager agent explicitly marked the run stuck after attempting unstick.                                                             |

### 12.2 The unstick playbook (auto, before human escalation)

When a run enters stuck, the manager runs through these in order, posting each attempt as a `MANAGER TRIED` line:

1. **Identify class** (api error / question / loop / budget).
2. **Apply Memory rule** if one matches (e.g., feedback memory says "AI33 zombie tasks: kill primary key task with id matching `progress=15`").
3. **Switch provider** if the failure is provider-bound and a fallback exists (TTS gateway already supports this).
4. **Retry with backoff** if the failure is transient.
5. **Reassign** to a peer worker if the current worker is health-degraded.
6. **Decompose** if a loop is detected — try a smaller sub-task.
7. **Pause and ask the operator** if all of the above fail.

This playbook is **a skill** (`unstick-runs`) so it can be edited and improved over time.

### 12.3 The Stuck UI

- **Chrome counter** `STUCK` in the status bar. Click → Tasks → Stuck tab.
- **Stuck row in Tasks list** has a purple left bar + a stuck-age badge.
- **Stuck banner inside a run's thread**:
  ```
  ◐ STUCK  12m   class: repeated_api_error · provider: elevenlabs · code: 401
  manager tried:
    1. switched to ai33_minimax — 401 (key missing)
    2. memory rule "TTS providers" applied — said never use Edge TTS
    3. no more rules apply. escalating to operator.
  [ ▶ open inbox item ]   [ ↻ retry now ]   [ ⤴ reassign ]   [ ✗ kill ]
  ```

### 12.4 Stuck on mobile

On Today, a top-of-screen card lists every stuck run with `Resolve in chat` button. The mobile status strip shows the `STUCK` counter.

---

## 13. Notifications, presence, sync

### 13.1 Desktop notifications fire for

- Any `bleed` or `stuck-escalation` Inbox item.
- Any `guardrail` confirmation request.
- Any conversation completion when started in `ship` mode.
- A job entering `PUBLISHED`.
- A job entering `FAILED_*` after 3 retries.
- A run going stuck for > 5 min when the operator has no browser tab open.

### 13.2 Presence

Chrome dot next to `konrad` at the bottom of the left rail is green if a browser tab is open, dim if not. The manager reads this presence — if no tab is open and a `bleed` arrives, escalation goes to mobile push.

### 13.3 Sync

Server-of-record is the VPS. The UI is a thin client. No offline mode in v1. If the network drops, the UI shows a sunken `#080808` overlay strip: `disconnected — retrying in 3s…` and the host dot goes amber.

Mobile push uses a self-hosted notifier (NTFY). Token in Settings → Notifications.

---

## 14. Keyboard, gestures, command grammar

### 14.1 Global hotkeys

| Combo           | Action                                       |
| --------------- | -------------------------------------------- |
| `⌘K` / `Ctrl+K` | Open command palette                         |
| `g t`           | Today                                        |
| `g i`           | Inbox                                        |
| `g c`           | Chat                                         |
| `g l`           | Live                                         |
| `g p`           | Pipeline                                     |
| `g r`           | Library                                      |
| `g m`           | Money                                        |
| `g k`           | Tasks (k = "kanban")                         |
| `g s`           | Skills                                       |
| `g b`           | Memory ("brain")                             |
| `g o`           | Goals                                        |
| `g j`           | Journal                                      |
| `g x`           | Map                                          |
| `,`             | Settings                                     |
| `?`             | Hotkeys cheat sheet                          |
| `n`             | New conversation (Chat)                      |
| `d`             | Dispatch new run (Tasks)                     |
| `j / k`         | Move down / up in any list                   |
| `↵`             | Open/expand focused row                      |
| `e`             | Edit focused row (where applicable)          |
| `a / r`         | Approve / Reject focused Inbox item          |
| `m`             | "Manager, handle this" on focused Inbox item |
| `o`             | Open focused item in Chat as context         |
| `★` (`f`)       | Flag agent message → write to Memory         |
| `Esc`           | Close overlay / collapse drawer              |

### 14.2 Mobile gestures

Same as v2: swipe-right approve, swipe-left reject, long-press snooze, pull-to-refresh, edge-swipe drawer, long-press mic.

NEW: on a run row in Tasks (mobile), swipe-right → `pause`, swipe-left → `kill` (with confirm).

### 14.3 Action registry (`⚡` actions)

Initial set, expanded in v3:

Existing:

- `⚡ Open job in Chat` · `⚡ Open worker in Chat` · `⚡ Open run in Tasks`
- `⚡ Tail tmux session` · `⚡ Tail PM2 process`
- `⚡ Rotate ElevenLabs key` · `⚡ Rotate AI33 key`
- `⚡ Restart PM2 process` · `⚡ Retry failed job` · `⚡ Mark job ready to publish`
- `⚡ Start new job` · `⚡ Create Inbox item`
- `⚡ Capture idea` · `⚡ Pin to status bar`

NEW (the AI OS ones):

- `⚡ Dispatch run` (arg: goal, owner, budget)
- `⚡ Fanout dispatch` (arg: goal, list of workers)
- `⚡ Pause run` (arg: run id)
- `⚡ Kill run` (arg: run id)
- `⚡ Reassign run` (arg: run id, new owner)
- `⚡ Spawn worker` (arg: role, project_dir)
- `⚡ Kill worker` (arg: worker id)
- `⚡ Install skill from URL` (arg: url)
- `⚡ Write memory entry` (arg: name, type, body)
- `⚡ Manager, take over this run` (arg: run id) — escalation in reverse: bounce a thread back to manager
- `⚡ Pause all agents` (the emergency switch)

Actions in the palette show their **guardrail status** as a small chip. Gated by Guardrails → confirmation modal on dispatch.

---

## 15. Components needed (shadcn-compatible)

(Carried from v2, plus new.)

Core: `Card`, `Table`, `Badge`, `Tabs`, `Command`, `Sheet`, `Tooltip`, `Skeleton`, `Toast`, `ScrollArea`, `Dialog`.

Custom:

- `StatusDot` (ok / warn / bad / **stuck** colors, optional pulse).
- `Sparkline`.
- `KeyHint`.
- `Funnel`.
- `MoneyTile`.
- `ToolCallCard`.
- `InboxRow`.
- `WorkerCard`.
- `JobRow`.
- `LedgerRow`.
- `AgentMessage` / `UserMessage` / **`InterAgentMessage` (NEW)** / **`RunLinkCard` (NEW)** / **`SkillCallCard` (NEW)** / **`StuckBanner` (NEW)**.
- `Composer`.
- `CommandResultRow`.
- **`RunRow` (NEW)** — Tasks list row.
- **`RunTreeNode` (NEW)** — collapsible run-tree node with status icon + agent + goal.
- **`SkillRow` (NEW)** — Skills list row.
- **`MemoryEntryReader` (NEW)** — memory file viewer/editor with frontmatter pinned.
- **`GuardrailToggle` (NEW)** — rule row with toggle + last-trip badge + history modal trigger.
- **`ConnectorRow` (NEW)** — status dot + name + last sync + configure.
- **`CostPanel` (NEW)** — the Chat right-rail tokens/cost panel.

---

## 16. Data shapes (real + proposed JSON)

(Real backend shapes carried from v2: `/api/hermes/workers`, `/api/forge/jobs`, `/api/forge/jobs/by-status`, `/api/pm2/list`, `/api/system/stats`, `/api/hermes/events`. See v2 for full bodies.)

New v3 endpoints (PROPOSED):

```json
// GET /api/tasks?status=active,stuck&limit=50
{
  "count": 3,
  "tasks": [
    {
      "id": "task_01HX2K8B...",
      "goal": "Render the political-commentary pilot end-to-end",
      "owner": "cc-renderer-1",
      "status": "running",
      "parent": "task_01HX2K7Z...",
      "children": ["task_01HX2K9A...", "task_01HX2K9B..."],
      "created_at": "2026-06-16T07:55:11Z",
      "started_at": "2026-06-16T07:55:14Z",
      "last_update_at": "2026-06-16T08:14:02Z",
      "eta_seconds": 1080,
      "budget": { "time_seconds_cap": 7200, "spend_cents_cap": 500 },
      "spend_cents_so_far": 42,
      "current_step": "ASSET_COLLECTION",
      "progress": 0.34
    },
    {
      "id": "task_01HX2K9B...",
      "goal": "Generate voice over (political-commentary pilot)",
      "owner": "cc-renderer-2",
      "status": "stuck",
      "parent": "task_01HX2K8B...",
      "children": [],
      "stuck_reason": {
        "class": "repeated_api_error",
        "provider": "elevenlabs",
        "code": 401,
        "manager_tried": [
          "switched to ai33_minimax — 401 (key missing)",
          "applied memory rule 'TTS providers' — said never use Edge TTS",
          "no more rules apply. escalating."
        ]
      },
      "last_update_at": "2026-06-16T08:02:14Z"
    }
  ]
}
```

```json
// GET /api/tasks/:id  (single run, with thread)
{ "task": { ... },
  "thread": [
    { "kind": "agent_message", "from": "cc-renderer-1", "ts": "...", "body": "..." },
    { "kind": "tool_call", "name": "Read", "args": { "path": "pacing.ts", "lines": "120-160" }, "duration_ms": 142, "result_excerpt": "..." },
    { "kind": "skill_call", "name": "graphify", "duration_ms": 8430, "result_excerpt": "..." },
    { "kind": "inter_agent", "from": "cc-renderer-1", "to": "cc-orchestrator", "ts": "...", "body": "asks: narrator..." },
    { "kind": "inter_agent", "from": "cc-orchestrator", "to": "cc-renderer-1", "ts": "...", "body": "answers: default." }
  ]
}
```

```json
// POST /api/tasks  (dispatch)
{
  "goal": "Render the political-commentary pilot end-to-end",
  "owner": "auto",
  "budget": { "time_seconds_cap": 7200, "spend_cents_cap": 500 },
  "context": {
    "job_id": "a1b2c3d4-...",
    "memory_refs": ["project-political-commentary"]
  }
}
// → { "task": { "id": "task_01HX...", "status": "queued", ... } }
```

```json
// POST /api/tasks/:id/control
{ "action": "pause" | "resume" | "kill" | "reassign" | "retry",
  "new_owner": "cc-renderer-3"  // only for reassign
}
```

```json
// GET /api/skills
{
  "count": 42,
  "skills": [
    {
      "name": "graphify",
      "category": "Personal",
      "description": "any input to knowledge graph",
      "path": "~/.claude/skills/graphify/SKILL.md",
      "pinned": true,
      "invocations_7d": 14,
      "last_invoked_at": "2026-06-16T07:42:00Z",
      "permissions": { "agents": "all", "modes": "all" }
    },
    {
      "name": "systematic-debugging",
      "category": "Process",
      "description": "...",
      "invocations_7d": 6
    }
  ]
}
```

```json
// GET /api/memory
{
  "count": 28,
  "entries": [
    {
      "name": "feedback-no-synthetic-fallbacks",
      "type": "feedback",
      "description": "Never implement synthetic fallbacks for missing pipeline data.",
      "path": "memory/feedback-no-synthetic-fallbacks.md",
      "linked_from": ["project-ce-placement-fix-smoke-2026-06-15"],
      "last_read_at": "2026-06-16T07:55:33Z",
      "last_written_at": "2026-05-24T..."
    },
    {
      "name": "reference-elevenlabs-voices",
      "type": "reference",
      "description": "Saved ElevenLabs voice configs.",
      "linked_from": ["project-drama-stock-chain"]
    }
  ]
}
// PUT /api/memory/:name  → save edited body + frontmatter
```

```json
// GET /api/guardrails
{ "emergency_pause": false,
  "rules": [
    { "id": "spend.cap.day", "on": true, "config": { "cents": 5000 }, "tripped_30d": 0 },
    { "id": "spend.cap.single_action", "on": true, "config": { "cents": 500 }, "tripped_30d": 2 },
    { "id": "destructive.fs", "on": true, "config": {}, "tripped_30d": 1 },
    { "id": "git.push.force", "on": true, "config": {}, "tripped_30d": 0 },
    ...
  ],
  "custom_rules": [
    { "id": "custom_01", "text": "do not retry a job more than 3 times in any 1-hour window", "on": true }
  ]
}
// POST /api/guardrails/:id/toggle
// POST /api/guardrails/:id/trip-history → list of trip events
```

```json
// GET /api/connectors
{
  "connected": [
    {
      "id": "hetzner",
      "name": "Hetzner Cloud API",
      "status": "ok",
      "last_sync_at": "..."
    },
    { "id": "github", "name": "GitHub", "status": "ok", "last_sync_at": "..." }
  ],
  "available": [
    { "id": "stripe", "name": "Stripe" },
    { "id": "youtube", "name": "YouTube Data API" },
    { "id": "obsidian-livesync", "name": "Obsidian LiveSync" }
  ],
  "failing": []
}
```

```json
// GET /api/inbox  (expanded for v3)
{
  "items": [
    {
      "id": "ibx_01HX...",
      "kind": "stuck-escalation",
      "title": "cc-renderer-2 stuck on voice over",
      "why": "TTS 401 across both providers. Memory rule applied but couldn't unblock.",
      "manager_tried": [
        "switched to ai33_minimax — 401",
        "applied memory rule …",
        "…"
      ],
      "task_id": "task_01HX2K9B...",
      "options": [
        { "id": "rotate_key", "label": "I have a new key", "shortcut": "K" },
        {
          "id": "auto_skip",
          "label": "Skip TTS, render silent",
          "shortcut": "S"
        },
        { "id": "kill", "label": "Kill run", "shortcut": "X" }
      ],
      "created_at": "2026-06-16T08:02:14Z"
    }
  ]
}
```

---

## 17. Interaction principles

1. **No empty states.** (See v2.)
2. **Keyboard first on desktop, thumb-first on mobile.** (See v2.)
3. **Numbers always in mono with units.** (See v2.)
4. **Polling is invisible.** (See v2.)
5. **Failures loud, success quiet.** (See v2.)
6. **Tool calls visible.** (See v2.)
7. **One accent.** (See v2.)
8. **Density over breathing room.** (See v2.)
9. **Persistent presence.** (See v2.)
10. **Reversibility.** Every action the agent can take is logged in Journal AND inside the originating run's thread. Most are revertible from the action's tool-call card via a `↶ Undo` link (when applicable).
11. **(NEW) Manager-first.** The human is the last line of resolution, not the first. Every escalated Inbox item shows `MANAGER TRIED`.
12. **(NEW) Stuck is a state.** It is neither a failure nor a success. It is the moment the fleet needs help. Surface it loudly, route it smartly.
13. **(NEW) Compounding.** Every feedback flag, every memory entry, every new skill is permanent leverage. The UI makes writing them one keystroke.

---

## 18. What this is **not**

- Not a Notion-style workspace.
- Not a marketing dashboard.
- Not a chat product.
- Not a SaaS app. No onboarding screen, no pricing page, no team management.
- Not light-mode.
- Not a CMS.
- Not a place for personal notes (Obsidian).
- **Not an email client / CRM / calendar app** — separate software exists for those. The OS may link to them from Connectors.
- Not a permission jail. Permissions are infinite by default. Guardrails are a small no-go rulebook, not a sandbox.

---

## 19. Out of scope for the first design pass

Priority order for the designer:

1. Desktop chrome (top nav, left rail, status bar with BLEED + STUCK, command palette).
2. Desktop Today (with Stuck card).
3. Desktop Inbox — list + detail with `MANAGER TRIED` block.
4. Desktop Chat — three-column layout, with: expanded tool call, expanded skill call, inter-agent message block, Run link card, streaming, Cost panel.
5. **Desktop Tasks** — list + run detail (header + live thread + run tree + costs) + Stuck tab + Dispatch board.
6. Desktop Live (with Stuck strip).
7. **Desktop Skills** — list + detail (README / Recent / Tests / Permissions / Source).
8. **Desktop Memory** — index + reader/editor + metadata panel.
9. Desktop Pipeline.
10. Desktop Money.
11. **Desktop Settings → Guardrails** — rule list + custom rules editor + emergency pause.
12. **Desktop Settings → Connectors** — connected / available / failing.
13. Mobile chrome (top, status strip with BLEED + STUCK, tab bar).
14. Mobile Today (with Stuck card).
15. Mobile Inbox (list + detail + swipe).
16. Mobile Chat (with mic-recording overlay).
17. Mobile Capture sheet.
18. Mobile Tasks (read + pause/kill).
19. Library Scripts tab.
20. Goals · Journal · Map — one screen each.
21. Mobile More drawer.

Skip for now: auth pages, Settings beyond Guardrails/Connectors, light mode, tablet sizes, anything below 360px width.

---

## 20. Implementation note (for next prompt)

After the design returns, this brief becomes the implementation roadmap.

**Order of build** (so the OS becomes usable fastest):

1. **Backend v2 endpoints** — `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/control`, `/api/skills`, `/api/memory`, `/api/guardrails`, `/api/connectors`, `/api/inbox`. Plus a `runs` table, `inbox_items` table, `memory_entries` index table in Postgres on the VPS. ~2 days of work on `forge-control` and `hermes-control`.
2. **The run executor.** A persistent `claude -p` agent worker that reads `runs` table, picks up `queued` runs, runs them, writes thread events back, posts heartbeats, surfaces stuck via the playbook. This is the single most important piece of code in the AI OS.
3. **The manager loop.** `cc-orchestrator` becomes a long-lived loop that: polls worker questions from a `questions` table, answers what it can using a small Claude call against Memory + run context, escalates the rest as Inbox items.
4. **The unstick playbook.** Implemented as the `unstick-runs` skill, invoked by the manager whenever a run enters stuck.
5. **The Guardrails enforcer.** A middleware in front of `agent.actions` that consults the rules table and blocks/confirms.
6. **Frontend wiring.** Once the design returns from Claude design, the API client is already typed; surfaces wire to the endpoints above. Next.js 15 + Tailwind + shadcn + TanStack Query as in the original spec §9.
7. **Connector shells.** Each connector is a small TypeScript module added under `/opt/forge-control/connectors/` with `auth() / sync() / act()`. Add them incrementally.

**This brief is the spec for that roadmap.** Treat the next prompt's design files as the visual contract; this document as the behavioral and structural contract.

---

## 21. One-line summary

A dark, dense, monospace-leaning **personal AI OS** with a desktop cockpit (13 surfaces, persistent top nav + left rail + status bar with BLEED + STUCK) and a mobile companion (5 tabs, capture-first), built around **a run-aware Chat, a long-running Tasks surface, a Skills registry, a Memory inspector, and a Guardrails no-go rulebook** — all in service of an agent fleet that thinks of itself as a company the operator can grow, correct, and trust to keep itself unstuck.
