# 08 — Manager Control Plane: quality plan

Test strategy and per-phase QA gates for the control plane (phases CP1–CP4, rounds 900–1200 —
see 09-control-plane-phases.md). Precedent: `src/lib/account-health.test.ts` — pure decision
functions extracted and table-tested; that is the pattern every phase follows.

## 1. Unit tests (pure logic — `run-control-rules.test.ts` and siblings)

**Eligibility matrices** (one exhaustive table per verb — all 7 statuses × expected outcome):
- `messageAction(status)` → `append | append_and_queue | reject(reason)` — 06 C1/C4.
- `resumeAction(status)` → `resume | reject(reason)` — C6.
- `stopAction(status)`, `terminateAction(status)` — C11/C12, including the
  already-paused→409-on-stop and already-cancelled→409-on-terminate cells.
- Property: for every status, **at least one** of `/message` and `/resume-chat` accepts OR both
  reject with reasons that name the other verb — no status may be unreachable by both without
  explanation (`failed`/`cancelled` reachable via resume-chat; `running`/`queued` via message).
  Corrected at R906: this bullet originally said "exactly one", which contradicts 07 §4's normative
  endpoint table — the two verbs deliberately OVERLAP on `paused|stuck|completed`, where both "say
  something to it" and "reopen it" are legitimate. The property is reachability, not exclusivity;
  the R902 test transcribed the stronger wording and was red for three rounds because of it.

**Completion transition** (07 §5-6): `completionTransition({outcome, rowStatus, pendingInput})`
table-tested for all outcome ∈ {completed, failed, stuck} × rowStatus ∈ {running, paused, cancelled,
completed} × pendingInput ∈ {true,false} — asserting: operator statuses always win; pending_input
redirects ONLY the completed outcome; the flag is cleared exactly when consumed.

**Comms entry construction**: prefix formats for from ∈ {konrad, manager, worker} and the relay
prefix for subagent-message; echo entry is `role:"agent"` and receiver `role:"user"`; meta shape
matches 07 §3 exactly (the UI parses it — this is a wire contract).

**`projectSlug`**: normal names, umlauts/punctuation, all-symbol names (fallback `project-<id8>`),
length cap, idempotence (`slug(slug(x)) === slug(x)`).

**Subagent address validation**: id present / absent / `subagents_v2` missing entirely (pre-rollup
runs) — absent metadata must 409, never throw.

## 2. Integration tests (route-level, DB-backed where the suite already does that)

- Each endpoint: happy path row effects (status, `completed_at` stamped on terminate and ONLY
  terminate, thread entry appended, echo appended to sender, sender status untouched).
- `/message` to a completed target requeues; to a failed target 409s.
- `/resume-chat` workspace pre-flight: fabricate metadata.workspace_dir pointing nowhere → 409, no
  status change.
- `GET /comms` returns only `kind:"comms"` entries, both directions, in order.
- Idempotence/races simulated at the SQL level: terminate-after-stop (409), double terminate (409),
  completion UPDATE with rowStatus flipped underneath (rowcount 0 path).

## 3. End-to-end smoke (worktree-safe, no live services)

Out-of-worktree engine behavior cannot be run in a build phase (worktree-only policy). E2E therefore
splits: (a) route handlers exercised via the Hono app in-process against the test DB pattern the
repo already uses; (b) the LIVE end-to-end scenario (06 §2's measurable scenario) belongs to the
deploy phase, scripted as `scripts/checks/verify-control-plane.sh` so it is reproducible in one
command and its transcript lands in `docs/plan/evidence/`.

## 4. QA gates — every phase's gating reviewer runs ALL of these

1. `pnpm install --prod=false && npx tsc --noEmit` — silent.
2. `pnpm test` — full suite, pass counts pasted into the review.
3. Boundary checks, verbatim from 05-control-plane-boundary.md:
   - `git diff --name-only main...project/4120f785 -- forge-control/src` contains
     `routes/run-control.ts` (from CP1 on) and NONE of the nine forbidden files.
   - `git diff main...project/4120f785 -- forge-control/src/index.ts` = exactly two `+` lines, zero
     `-` lines, neither in a hunk whose context includes `app.route("/api/projects"`.
   - `git diff --name-only main...project/4120f785 | grep capabilities` prints nothing.
   - `origin_chat_id` grep (from CP3 on) matches only `lib/cc-runner.ts` and `db/projects.ts`
     (C16 extends boundary D5's reviewer check by one file; recorded in the contract note).
4. Live-checkout cleanliness: `git -C /opt/forge-ai-os status --porcelain` → empty, output pasted.
5. Contract conformance read-through: response shapes against contract §1–§4 literally (status
   codes, field names — `queued`, `delivery`, `resumed_run_id`, `stopping`, `terminating`).
6. Hard-error audit: grep the new code for catch-and-continue around the new verbs; any swallowed
   error is NEEDS_FIXES (C20).

## 5. Red-team review (CP1 — mandatory, briefed to attack, not check)

Concrete scenarios the red-team reviewer must attempt to break on paper AND, where pure, in tests:

- **S1 message-vs-completion**: message lands between the child's last stream event and the
  completion UPDATE; then the mirror (lands just after). Prove delivery in both orders from the §5
  handshake, or produce the interleaving that loses it.
- **S2 stop-vs-completion**: `paused` written in the poll gap while the child exits 0. Does the §6
  guard hold on every completion path (completed/failed/stuck/cancel-catch)? Check the failover and
  resume-miss paths too — they call the same completion code.
- **S3 terminate-vs-reconciler**: terminate a reviewer run right as its round consolidates. Show
  the task/project end state is the documented one (task failed, project blocked, one notification
  — not two, not zero).
- **S4 message-to-settled-reviewer** (07 §7): message a reviewer in the ≤10s pre-consolidation
  window; confirm the group `wait`s and no duplicate fix chain can arise; confirm a verdict-flip on
  the resumed turn is honored exactly once.
- **S5 double-fire**: two operators (UI + manager agent) message/stop/terminate the same run in the
  same second. Any path to a mixed state (e.g. cancelled without completed_at) is a finding.
- **S6 executor restart** at each arrow of the §5 diagram — any interleaving that strands
  `pending_input=true` on a settled run with no consumer is a finding (the route's completed-path
  must cover it).
- **S7 echo abuse**: does an echo entry in a manager thread ever requeue the manager, break
  `trailingUserBlock`'s tail scan, or leak into `previewOf`/rail previews in a misleading way?
- **S8 relay honesty**: subagent-message to a parent whose session evaporated — prove the outcome is
  a visible failure or explicit 409, never a silently ignored relay.

## 6. Deploy-phase verification (CP4)

Per the restart matrix (07 §8): live-prove stop, terminate (+`completed_at`), resume-chat,
message→idle-target, `GET /comms`, echo entries — transcript into
`docs/plan/evidence/cp4-deploy.md`; append those announcement rows. For message→running and
subagent→running: queue the reminder naming `scripts/checks/verify-control-plane.sh`, the two
pending announcement rows, and where the proof transcript goes. The deploy reviewer checks the
reminder actually landed (GET /api/reminders) and that no row was appended on faith.
