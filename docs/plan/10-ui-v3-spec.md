# Spec — Manager Chat UI v3 (Konrad, 2026-08-05)

Authoritative. Supersedes the manager-cards rail from `live-panel-manager-split`. Konrad dictated this after rejecting that UI; where this conflicts with anything older, THIS wins. Source conversation: operator chat, 2026-08-05 morning.

## The core model

**Every chat is a manager chat.** The thing Konrad talks to in any chat IS the manager — "a highly intelligent friend managing a team for me, my right-hand man." There is no separate managers section, no separate manager entity in the UI. A chat that has kicked off a goal/project owns that project's workers. The right sidebar and the Kanban are always views of **the currently open chat** — nothing else. Selection lives on the left; the right side never has its own independent selector.

## Left rail — chats

- All chats, most recently active at top. These are Konrad ↔ manager conversations.
- Keep: running/completed status dot. Add next to it: `x/y tasks` progress for chats that own a project.
- REMOVE all spend/€/$ numbers — Konrad runs on the Claude Code subscription, not API billing. Dollar figures are meaningless noise to him. (This applies across the entire UI: no $ anywhere. Tokens/context are the currency shown.)

## Middle — chat surface

Header (slim it down):
- Remove: title (already in the rail), the "completed" text (the dot covers it), spend + spend cap.
- Keep: colored status dot; model name (e.g. claude-fable-5) even though it repeats at the bottom; the canvas button (loved — but performance-optimize it).
- The "Live" indication moves under/next to the colored dot rather than its own header element.

Composer (bottom):
- Text/command input must **autogrow** with content so long messages stay readable (currently static height).
- Model selector stays and matters: **manager-only** model + effort selection (workers get models via the tier system, not this selector). **Effort buttons color-coded** (low→max as a color ramp).
- Secret sharer becomes **two-way**: when the agent asks Konrad for a secret, the secret panel opens itself with the agent's request text in it; Konrad answers there. Purpose: secrets never appear in chat logs, in either direction.
- Send button unchanged.

In-chat navigation:
- Clicking a worker (right sidebar) or a phase (Kanban) opens IN the chat window: worker chat transcript / phase plan markdown. A **back button at the top, animated** so the context switch is felt. Header then shows who/what you're looking at (architect / planner / builder / reviewer / researcher, or the phase doc). Deep navigation must always be able to walk back to the manager chat easily. Sub-agent chats nest the same way (Claude-Code-style: you can descend into a session's sub-agents).

## Right sidebar — ONE panel, two zones, always scoped to the open chat

Merge today's top ("running") and bottom ("project") halves — the separation is arbitrary. One panel:

**Top zone — the team of THIS chat:**
- The manager itself at the top (model shown), then its workers.
- Workers = real Claude Code sessions: indent one level. Their in-process sub-agents: indent one more level (they are "real sub-agents" — show them as children).
- Every row: role, model, **total context/token count**, and **actual working time** (time actively doing work, not wall-clock sitting time). Running rows tick; finished rows show tokens/model but need no time display.
- Status dots: blue running, gray planned/queued, green done (keep).
- Hover on ANY row: a small red **X** to terminate/dismiss it. Next to it a **stop** button (stop ≠ dismiss).
- Click a row → opens that agent's chat in the middle surface (see navigation above).
- **Finished sub-agents do NOT vanish**: the manager can re-engage them — ask follow-ups, reuse their context. (Konrad: "the manager can refer back to them and ask them questions and work with them again.") The manager can also terminate workers, message them mid-session, chat with them mid-session. This needs a real control plane (engine work, not just UI).
- Chats with no agents running: this zone is simply empty for that chat.

**Bottom zone — the plan (Kanban / graph):**
- The phases/tasks of THIS chat's project as a Kanban — "the tasks that are in front of us."
- Click a phase → the chat window shows the actual markdown of that phase's plan doc (docs/plan/…), with back-nav.
- Graph-engineering view: the plan is a task graph (nodes = tasks/phases, edges = dependencies). A graph visualization of the working agents + task DAG is the desired evolution of this zone (research refs: LangGraph-style task graphs, agent-graph monitoring with per-node metrics). Kanban first, graph view as a toggle.
- Progress tracking is first-class: it must always be obvious how far along the goal is.

## Engine/DevOps requirements attached to this spec

- Worktree isolation for parallel agents (exists — keep hardening), proper GitHub integration.
- **Agent-to-agent communication must be real and visible**: Konrad wants to see messages between manager and workers (and receive/send indications in the transcript, like Bash blocks).
- Control plane endpoints the UI needs: send-message-into-running-session, chat-with-finished-session (resume), terminate, stop. Per-chat ↔ project linkage so scoping works.

## Explicitly rejected

- Separate managers section in the left rail (shipped 2026-08-05 morning, rejected same day).
- Right-sidebar content driven by anything other than the selected chat.
- Dollar/hourly spend displays anywhere in the UI.

## Addendum (2026-08-05, before Konrad stepped out) — Worker-chat legibility

Konrad, watching a worker's chat live: "I'm completely fucking confused by what they are telling me and what's going on in the background." A worker's transcript is a raw CC session — tool-call walls with no narrative. Requirements:

- **Orientation strip** pinned at the top of any worker chat: role + model, its task title/round/phase, plain-language "currently: …" (derived from its latest activity), and how it fits the plan (which phase, what comes after).
- **Readable transcript by default**: tool calls collapse to one-line human summaries (command + outcome), expandable for the raw payload — the agent's *prose* (its reasoning and reports) is the primary reading layer, the machinery is the secondary one. Think: the story of what it's doing, with the terminal underneath.
- **"Story so far" digest** for long sessions: a short generated-or-derived summary at the top so Konrad doesn't have to scroll-read 200 tool calls to know where things stand.
- Same treatment applies to sub-agent chats.
