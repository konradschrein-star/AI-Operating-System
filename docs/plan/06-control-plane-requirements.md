# 06 — Manager Control Plane: vision + requirements

Round 800 architect corpus, engine-v2-research-lane. This document and its siblings (07-architecture,
08-quality, 09-phases) plan the control-plane extension ordered in round 800: chat-with-workers,
mid-session messaging, terminate/resume, chat linkage, comms visibility.

**Sources, all read in full during round 800:**
- `/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md` — the API contract, authored by
  the operator-visibility architect (their round 250), including our own lane's negotiation note
  (rounds 760–764). The contract is the shared source of truth; we implement to it and answer its
  open questions by editing it (done in round 800 — see the note's dated appendix).
- `/opt/obsidian-vault/AI OS/Spec - Manager Chat UI v3.md` — Konrad's authoritative UI model
  (2026-08-05). Relevant parts quoted below so builders never need vault access to know the intent.
- `docs/plan/05-control-plane-boundary.md` — the cross-lane treaty (D1–D6). Every decision here
  respects it; its reviewer checks apply to every phase this corpus seeds.
- Engine code as it exists on this branch: `forge-control/src/executor.ts`,
  `forge-control/src/lib/cc-runner.ts`, `forge-control/src/db/runs.ts`,
  `forge-control/src/db/projects.ts`, `forge-control/src/lib/project-tick.ts`,
  `forge-control/src/lib/run-rollup.ts`.

## 1. Vision

Every chat in Konrad's UI is a manager. A chat that kicked off a goal project owns that project's
workers, and the manager (or Konrad directly) must be able to do to a worker what a human lead can do
to a teammate: talk to them mid-task, ask a finished one a follow-up, tell one to stop, or dismiss one
entirely — with every exchange visible in both transcripts.

From the UI spec, the engine-facing sentences verbatim:

> **Finished sub-agents do NOT vanish**: the manager can re-engage them — ask follow-ups, reuse their
> context. The manager can also terminate workers, message them mid-session, chat with them
> mid-session. This needs a real control plane (engine work, not just UI).

> **Agent-to-agent communication must be real and visible**: Konrad wants to see messages between
> manager and workers (and receive/send indications in the transcript, like Bash blocks).

> Control plane endpoints the UI needs: send-message-into-running-session, chat-with-finished-session
> (resume), terminate, stop. Per-chat ↔ project linkage so scoping works.

> Hover on ANY row: a small red **X** to terminate/dismiss it. Next to it a **stop** button
> (stop ≠ dismiss).

The engine already has every load-bearing part of this in embryonic form: runs are turn-based CC
sessions that resume by `cc_session_id`; a status poll inside every live turn kills the child within
~5s of a `cancelled`/`paused` write; `POST /api/chat/:id/message` already appends-and-requeues. The
control plane is not a new machine — it is a hardened, contract-shaped, race-audited surface over the
machine that exists. That is deliberate: this is a single-operator system and the winning design is
the one whose failure modes Konrad can reason about from the `runs` table alone.

## 2. Definition of done

1. `forge-control/src/routes/run-control.ts` exists and serves, per the contract:
   `POST /api/runs/:id/message`, `POST /api/runs/:id/resume-chat`, `POST /api/runs/:id/stop`,
   `POST /api/runs/:id/terminate`, `POST /api/runs/:parentId/subagent-message`, plus
   `GET /api/runs/:id/comms` (our additive extension for comms visibility).
2. A message posted into a RUNNING worker is seen by that worker as user input on its next turn,
   without killing or restarting the turn in flight.
3. A settled run (completed/failed/cancelled/stuck/paused) can be re-engaged in place — same run id,
   same CC session where recoverable, full-transcript fallback loudly marked in-thread when not.
4. Stop leaves a session alive and resumable (`paused`); terminate ends it (`cancelled`,
   `completed_at` stamped). Both take effect on a live child within ~5s.
5. Manager→worker and worker→manager traffic lands as structured thread entries in BOTH threads and
   is queryable via one endpoint.
6. Projects created by the operator carry `metadata.origin_chat_id`; worker prompts tell the worker
   which chat is its manager and how to report to it.
7. Every new-project planning corpus is born at `docs/plan/<project-slug>/` (the D6 forward rule made
   real in the architect/planner prompts).
8. `npx tsc --noEmit` clean; existing tests plus the new unit tests pass; every pure decision
   (eligibility, completion transition, slugging) is extracted and unit-tested per the
   `account-health.test.ts` precedent.
9. Each shipped endpoint has a row in the contract note's announcement table with a real proof cell;
   the `flipped?` cells are left empty (boundary D3). No file on the D1 never-touch list is created
   or edited; `capabilities.ts` is never created or flipped by this lane.

**Measurable success scenario** (the deploy phase must reproduce it live, modulo the executor-restart
matrix in 07 §8): a scratch project's worker is mid-task; `POST /api/runs/:id/message` from a second
terminal lands; the worker's next turn quotes the message back; `stop` pauses it mid-work;
`resume-chat` wakes it with a follow-up; `terminate` ends it with `completed_at` set; the full
exchange is visible in `GET /api/runs/:id/comms` on both sides.

## 3. Functional requirements

Numbered C1… to keep clear of the existing corpus's R-series. Each is testable; 09-phases maps every
one to exactly one phase.

**Message into a session (contract §1)**
- C1. `POST /api/runs/:id/message` accepts `{text, from: "konrad"|"manager"|"worker", manager_run_id?,
  sender_run_id?}` and returns `202 {queued: true, delivery: "next-turn"}` for targets in status
  `queued|running|paused|stuck|completed`; `409 {error}` for `failed|cancelled` (those are
  `resume-chat`'s job — deliberate reopening, not casual messaging); `404` unknown id; `400` empty
  text or bad `from`. (`from:"worker"` and `sender_run_id` are our additive extension so
  worker→manager reports ride the same verb; recorded in the contract note.)
- C2. The message lands in the TARGET thread as a `role:"user"`, `kind:"comms"` entry whose `meta`
  carries `{comms:{direction:"in", from, peer_run_id}}` and whose content is prefixed in-band
  (`[message from konrad]` / `[message from manager <id8>]` / `[message from worker <id8>]`) so the
  CC session sees attribution even without meta.
- C3. Echo policy (contract Q1 — answered: engine writes both sides): when `manager_run_id` (or
  `sender_run_id`) is present, the engine ALSO appends a `role:"agent"`, `kind:"comms"` entry to the
  SENDER's thread with `meta.comms.direction:"out"`. The echo NEVER changes the sender's status —
  a manager must not be requeued by its own outbound message.
- C4. Delivery is next-turn, atomically: target `queued` → append only (the pending turn's prompt
  builder already folds the tail in); target `running` → append + `metadata.pending_input`, consumed
  by the executor's completion handshake (07 §5) so the turn that is streaming finishes untouched and
  the run requeues itself instead of completing; target `paused|stuck|completed` → append + status
  `queued` (for `stuck` this doubles as the contract's nudge).
- C5. No message is ever silently dropped: every 4xx names the reason verbatim; a message appended
  during the completion race window is provably consumed (the two-sided handshake in 07 §5, covered
  by unit tests on the pure transition rules).

**Resume a finished session (contract §2)**
- C6. `POST /api/runs/:id/resume-chat` accepts the same body shape and returns
  `202 {resumed_run_id: id}` — resume is IN PLACE (contract Q2 — answered): same run row, same id,
  stable across any number of resumes. Eligible statuses: `completed|failed|cancelled|stuck|paused`.
  `running|queued` → 409 pointing at `/message`.
- C7. Pre-flight: if `metadata.workspace_dir` is set and the directory is gone from disk, 409
  `"workspace gone: <path>"` — never spawn a CC child into a deleted worktree.
- C8. Context recovery: the executor's existing `CcResumeError` path (resume-miss → retry once with
  the FULL transcript + a loud in-thread marker) is the fallback and is context-preserving, so the
  contract's opt-in `allow_fresh` is unnecessary; this is recorded in the contract note. A resume
  that cannot recover context at all fails the run visibly — never a silent fresh start.
- C9. Resuming a settled project task run does not corrupt task bookkeeping: a task already `done`
  stays `done`; a reviewer whose round was already consolidated is not re-consolidated (the
  reconciler only reads `status='running'` tasks — verified in 07 §7); a reviewer NOT yet
  consolidated defers consolidation until the resumed run settles again, and the final settled text
  is the verdict.

**Sub-agent messaging (contract §2b)**
- C10. `POST /api/runs/:parentId/subagent-message` `{subagent_id, text}`: the address space is
  `metadata.subagents_v2[*].id` (the Task tool_use_id the rollup already records). Unknown id → 409
  `"subagent context not addressable"` (contract's honest-refusal wording). Known id → the engine
  relays through the parent: a specially-prefixed `kind:"comms"` user entry instructing the parent to
  deliver via its harness (SendMessage) and report the reply; delivery follows C4's rules for the
  parent's status. This is the only real mechanism — a sub-agent has no session of its own outside
  its parent, and pretending otherwise would be the silent fallback this system bans.

**Stop and terminate (contract §3, §4)**
- C11. `POST /api/runs/:id/stop` → `202 {stopping: true}`; sets status `paused` (contract Q3 —
  answered: `paused`, an existing status the executor's kill-poll already honors; no new enum value,
  no `stuck_signal` overload). Eligible: `queued|running|stuck`. Settled or already paused → 409.
  A live child is SIGTERM'd within ~5s by the existing poll; the executor appends its existing
  "Run stopped — engine process terminated." marker; the session stays resumable (C6 applies).
- C12. `POST /api/runs/:id/terminate` → `202 {terminating: true}`; sets status `cancelled` AND stamps
  `completed_at = now()` (the consistency fix the contract explicitly invites). Eligible:
  `queued|running|paused|stuck`. `completed|failed|cancelled` → 409. Kill semantics as C11.
- C13. Neither verb can be overwritten by a completion race: the executor's completion write is
  guarded (`WHERE status='running'`), so an operator's `paused`/`cancelled` set in the window between
  the child's last event and the completion UPDATE wins, and the executor logs that it yielded
  (07 §5).

**Comms visibility**
- C14. `GET /api/runs/:id/comms` returns the run's `kind:"comms"` thread entries (content + meta +
  ts), both directions, oldest first — one endpoint the UI can render as Bash-block-style cards
  without scanning full threads client-side.

**Chat ↔ project linkage (contract §6, scope per boundary D5)**
- C15. The operator system prompt in `forge-control/src/lib/cc-runner.ts` instructs the operator to
  pass its own run id (`$FORGE_RUN_UUID`) as `origin_chat_id` when POSTing `/api/projects`. (Inert
  until the other lane's route change lands; harmless before — verified in boundary F9.)
- C16. `createRunForTask` copies the project's `metadata.origin_chat_id` (when present) into each
  task run's metadata — additive convenience so a worker run is self-describing without a resolver
  JOIN. No resolver, scanner, rollup, or validation is built (boundary D5 forbids it).
- C17. When a project has `origin_chat_id`, every worker prompt gains a MANAGER COMMS block: which
  run id is the manager chat, and the exact curl to report to it (`from:"worker"`,
  `sender_run_id: $FORGE_RUN_UUID`). No linkage → no block (never interpolate a null).

**Corpus path forward rule (boundary D6)**
- C18. A pure `projectSlug(name)` (lowercase, non-alphanumerics collapsed to `-`, trimmed, length-
  capped, id-prefixed fallback for degenerate names) is interpolated into the goal-mode architect
  prompt's five corpus paths and the planner-brief template in
  `forge-control/src/lib/project-tick.ts`, so every FUTURE project's corpus is born at
  `docs/plan/<slug>/`. This project's own flat corpus stays where it is until the D6 merge recipe
  runs — moving it early is explicitly forbidden by the boundary doc.

**Announcement (boundary D3)**
- C19. Each shipped endpoint gets an appended row in the contract note's announcement table (five
  columns, exact format from boundary D3), proof cell naming a real file under
  `docs/plan/evidence/`. `flipped?` stays empty. The `message_into_session` and `subagent_message`
  rows are appended only after their executor-dependent halves are proven live (see the restart
  matrix, 07 §8): if the detached executor restart has not landed by end of deploy, the deploy task
  queues a reminder telling Konrad exactly what to verify and which row to append afterwards, and
  says so in its final message — never a row on faith.

## 4. Non-functional requirements

- C20. Hard errors only: every rejected action is a 4xx/5xx with a reason string the UI can show
  verbatim. No 200-that-did-nothing, no silent fallback anywhere on this surface.
- C21. Zero migrations: everything rides existing columns (`runs.status`, `runs.completed_at`,
  `runs.thread`, `runs.metadata` jsonb). If a phase discovers it genuinely needs DDL it stops and
  escalates rather than improvising schema.
- C22. Boundary compliance is mechanical: `git diff --name-only main...project/4120f785 --
  forge-control/src` never contains the nine D1 files; `index.ts` diff is exactly two appended `+`
  lines; every phase's gating reviewer runs the boundary doc's reviewer checks verbatim.
- C23. All state lives in the `runs` row. No in-memory queues, no side tables, no process-local
  delivery state (the executor's `pending_input` handshake reads/writes only `runs.metadata`), so an
  executor restart can never strand a message.
- C24. Observability: every control-plane action is visible three ways without new infrastructure —
  the thread entry itself, the executor log line, and the run row's status/timestamps.

## 5. Explicit non-goals

- No UI work; the UI degrades via capability flags until the other lane flips them (contract §7).
- No SSE/streaming channels — 202-and-poll per the contract.
- No auth changes — localhost/proxy trust as the rest of :7700.
- No mid-turn injection into a live CC child. `claude -p` closes stdin at spawn; "the worker sees it
  as user input on its next turn" is the spec's own acceptance and the only honest mechanism.
- No fork-on-resume, no run cloning.
- No capabilities file, no flag flips, no edits to any file on the D1 never-touch list.
- No chat-linkage resolver/scanner/rollup (theirs, built, verified — boundary F8).
- No changes to the reviewer-consolidation machinery beyond what C9 verifies about it.
