# 05 — Control-plane boundary vs operator-visibility

**What this is.** A decision record fixing where `engine-v2-research-lane` (branch `project/4120f785`)
is allowed to write while `operator-visibility` (branch `project/8ea0cc08`) is in flight, so that the
Manager Control Plane API can be built without turning either lane's merge into a hand-resolved
thousand-line conflict.

**Who must read it.** (1) The round-800 architect, before planning any control-plane phase — this doc
is a precondition of that plan. (2) Every deploy-phase task on this branch, as a merge checklist.
(3) The operator-visibility lane, reached via the vault note written in round 762.

**Date / round.** 2026-08-05, rounds 760 (recon) / 761 (this doc). All facts below were re-run live in
round 761; where the live output disagreed with the round-760 recon it is called out under
*Corrections*. Paths are written in full from the repo root throughout.

**Source contract.** `/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md`, authored by
the operator-visibility architect at their round 250. It names *this* project as the implementer of
five verbs (§1 message-into-session, §2 resume-finished + subagent-message, §3 stop, §4 terminate)
and instructs us to announce each one by flipping a flag in `GET /api/capabilities`.

**The problem in one paragraph.** `forge-control/src/routes/capabilities.ts` does not exist on `main`.
It exists only on `project/8ea0cc08`, which is unmerged and does not reach its own merge phase until
its round 900 (it is at ~round 505, five phases out). The contract's announcement mechanism therefore
points at a file we cannot touch without either creating a rival copy or waiting on another project's
schedule. Worse, the two files that would carry any route registration — `forge-control/src/index.ts`
and `forge-control/src/routes/chat.ts` — are exactly where their branch has its largest and most
context-sensitive changes. Following the contract literally makes our next deploy a merge fight.

**What this doc does NOT decide.** It does not design any endpoint, does not choose delivery or
resume semantics, and does not authorise any code change. It draws lines; the r800 architect fills
them in.

**Numbering note.** The steward brief refers to "§4 chat linkage". In the contract as written, §4 is
Terminate and §6 is "Per-chat ↔ project linkage". This doc uses the contract's own numbering. Read
"§4 chat linkage" anywhere upstream as §6; noted once here so nobody re-derives it.

---

## D1 — Route ownership

**Decision.** Every control-plane endpoint the contract asks for lives in ONE new file we create,
`forge-control/src/routes/run-control.ts`, built on `forge-control/src/db/runs.ts`.

**Rationale.** F6: `forge-control/src/db/runs.ts` is ours, untouched by their branch (F2), and already
exports `getRun`, `appendMessage`, `setRunStatus`, `archiveRun` and the `RunStatus` type. Today's
cooperative cancel is `forge-control/src/routes/chat.ts` `r.post("/:id/status")` → `setRunStatus`,
with `forge-control/src/executor.ts:857` polling `status === "cancelled" || status === "paused"`.
Every contract verb can therefore be assembled from `forge-control/src/db/runs.ts` plus the executor
without opening `chat.ts` — which is +1052 lines on their branch (F1) and would conflict on contact.

**What this forbids.** On this branch we never create or edit:
`forge-control/src/routes/chat.ts`, `forge-control/src/routes/agents.ts`,
`forge-control/src/routes/secrets.ts`, `forge-control/src/lib/secret-store.ts` (all four exist on
`main` and are heavily rewritten on their branch), nor the four files that exist ONLY on
`project/8ea0cc08` and not on `main` — `forge-control/src/routes/capabilities.ts`,
`forge-control/src/routes/chat-linkage.ts`, `forge-control/src/routes/agents-shared.ts`,
`forge-control/src/routes/working-time.ts`. `forge-control/src/routes/run-control.ts` is the one file
this doc proposes we create; it does not exist yet on either branch.
`forge-control/src/routes/projects.ts` joins that list for this cycle (F1: +106 on their branch) —
the engine reaches project state through `forge-control/src/db/projects.ts`, not through the route,
so nothing we need requires editing it.

**Reviewer check.**
`git diff --name-only main...project/4120f785 -- forge-control/src` must contain
`forge-control/src/routes/run-control.ts` and must NOT contain any of the nine files above.

---

## D2 — `forge-control/src/index.ts`

**Decision.** The only edit we make to `forge-control/src/index.ts` is the minimum to mount our
router: ONE import appended at the END of the import block (after the `mentor` import, line 43) and
ONE `app.route` line appended at the END of the mount block (after `app.route("/webhooks", webhookIn);`,
line 192, immediately before `const port`). Append-only, at the far end, never inserted next to an
existing mount.

**Rationale.** F5: their hunk inserts `app.route("/api/capabilities", capabilities);` immediately
after `app.route("/api/projects", projects);`. On `main` that gap is already occupied — our lane put
`app.route("/api/tasks", tasks);` there (line 189), so their hunk's trailing context has drifted and
that region is now the single most contended spot in the file. Hono prefix routing is order-independent
for distinct prefixes, so our mount's position is free; maximum textual distance from their hunk is
what lets git merge both sides unattended.

**What this forbids.** No edit anywhere between `app.route("/api/projects", projects);` and
`app.route("/webhooks", webhookIn);`. No reordering, no comment reflow, no import re-sorting anywhere
in the file. If a future change genuinely needs a second mount, it also goes at the end.

**Reviewer check.**
`git diff main...project/4120f785 -- forge-control/src/index.ts` shows exactly two `+` lines and zero
`-` lines, and neither `+` line sits in a hunk whose context includes `app.route("/api/projects"`.

---

## D3 — The capability flag

**Decision.** We do NOT flip the flag. We ship the endpoint, prove it, and record in the contract note
which flag to flip and what proof backs it; whoever merges second flips it in one line.

**Rationale.** F1/F4: `forge-control/src/routes/capabilities.ts` is a 25-line file that exists only on
`project/8ea0cc08`. Creating our own copy on `main` guarantees a whole-file conflict on a file whose
entire purpose is to be a single source of truth — the worst possible thing to duplicate. Editing
theirs is impossible; it isn't on `main`.

**Protocol every deploy phase of ours follows.**
1. Land the endpoint on `main` (D1/D2 shape).
2. Capture proof: the exact `curl` and its verbatim response, into `docs/plan/evidence/`.
3. Append a row to an announcement table in the contract note
   (`/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md`): verb, route, flag name,
   date/round, evidence path. Append only — never rewrite their sections.
4. Done. The flip is a one-line change owned by whichever lane merges second.

**Defect to record, not to fix.** F4: their `CAPABILITIES` constant declares FOUR flags —
`message_into_session`, `resume_finished`, `stop`, `terminate`. Contract §5 specifies FIVE.
`subagent_message` is missing. If we ever ship §2's `POST /api/runs/:parentId/subagent-message`
there is no flag to flip. This is a one-line fix on their side; the vault note carries it to them.

**Reviewer check.**
`git diff --name-only main...project/4120f785 | grep capabilities` prints nothing, and every shipped
verb has a row in the contract note's announcement table pointing at a real file under
`docs/plan/evidence/`.

---

## D4 — Merge order

**Decision.** Every deploy phase of ours from here on: `git fetch`, merge `main` into
`project/4120f785` FIRST, re-run `pnpm install --prod=false && npx tsc --noEmit && pnpm test` in the
worktree, and only then merge to `main`.

**Rationale.** F3: the merge base is `a4865b6` ("feat(tiers): junior tier + researcher role"). They
forked before our corpus landed on `main`, so `main` has moved under both lanes and will keep moving.
Merging main-first localises every conflict to our worktree, where a builder can resolve it with the
test suite running, instead of to `main`, where a bad resolution is live.

**Additional checklist items.**
- If `operator-visibility` has landed by then, re-read `forge-control/src/routes/chat-linkage.ts` and
  `forge-control/src/routes/chat.ts` BEFORE writing anything that overlaps §6 — they may already have
  built what the contract asks of us (see D5).
- F10: `docs/plan/00-vision.md` … `docs/plan/04-phases.md` will conflict whole-file whichever way the
  merge runs. That resolution is mechanical; see D6. Do not attempt a semantic merge of the two
  corpora.

**What this forbids.** Merging to `main` without a green `npx tsc --noEmit` and `pnpm test` from the
worktree *after* the main-merge. A pre-merge green run does not count.

**Reviewer check.** The deploy phase's evidence file under `docs/plan/evidence/` shows, in order:
`git merge origin/main` output, then `npx tsc --noEmit` (silent), then `pnpm test` (pass counts), then
the merge to `main`.

---

## D5 — Contract §6 scope

**Decision.** Do not rebuild their surface. Our entire §6 obligation is one sentence in the operator
prompt in `forge-control/src/lib/cc-runner.ts` (line ~164, the line describing "POST /api/projects to
kick off a coding project") telling the operator to pass its own run id as `origin_chat_id` when it
creates a project.

**Rationale.** F8: their `forge-control/src/routes/chat-linkage.ts` (430 lines) already exports
`isProjectCreateCall`, `scanThreadForProjectIds`, `resolveChatProject`, `rollupChatProjects` and the
`ChatProjectLink` / `ChatProjectRollup` interfaces, covering metadata-first resolve, a bounded thread
scan with three documented bounds, backfill on an unambiguous hit, and an O(1) rollup for the rail.
It mounts no routes — `chat.ts` owns those. Their `forge-control/src/routes/projects.ts` (+106)
already accepts, uuid-validates and stores `body.origin_chat_id` into `projects.metadata`.
F9: `forge-control/src/lib/cc-runner.ts` is ours and untouched by their branch — zero collision. And
`main`'s `POST /api/projects` destructures a known-keys object and silently ignores unknown body keys,
so shipping the prompt change BEFORE their branch lands is inert and harmless, not an error.

**What this forbids.** Writing a project-linkage resolver, a thread scanner, a rollup query, or
`origin_chat_id` validation on this branch. A builder who does has wasted the round — stated plainly
so no one has to infer it.

**Reviewer check.**
`git diff main...project/4120f785 -- forge-control/src | grep -i origin_chat_id` matches only inside
`forge-control/src/lib/cc-runner.ts`.

---

## D6 — The `docs/plan` corpus collision

**Decision.** Change nothing now. Record the resolution recipe: whoever merges SECOND keeps BOTH
corpora by moving the loser's five files into a per-project subdirectory
(`docs/plan/<project-slug>/00-vision.md` …) rather than picking a side. Going forward, every project's
corpus is born at `docs/plan/<project-slug>/`.

**Rationale.** F10: both lanes rewrote the same five filenames from a common ancestor that was a
THIRD project's corpus (files-pane-fast-light) — ~529 insertions / 654 deletions on their side alone.
Their `docs/plan/00-vision.md` opens `# 00 — Vision: operator-visibility` and states "This corpus
replaces the previous project's plan (files-pane-fast-light) that main carried in `docs/plan/`". Ours
opens `# 00 — Vision: engine-v2-research-lane`. Neither corpus is obsolete while its project runs, so
"pick a side" destroys a live planning document. Renaming our own corpus mid-project would churn every
cross-reference inside it for zero benefit, which is why the recipe is written down rather than applied.
Their UI corpus additionally occupies `docs/plan/10-…` through `docs/plan/16-…`; this file
(`docs/plan/05-control-plane-boundary.md`) collides with nothing, and our `docs/plan/evidence/` and
their `docs/plan/artifacts/` are disjoint.

**What this forbids.** Renaming, moving or deleting any of our `docs/plan/00-04` files before the
merge. Resolving those five conflicts by taking either side wholesale.

**Reviewer check.**
`git diff --stat main...project/8ea0cc08 -- 'docs/plan/0*.md'` still lists exactly five files, and our
branch's `docs/plan/00-04` filenames are unchanged from their current names.

**Recommendation to the other lane.** Adopt `docs/plan/<project-slug>/` for new corpora too; the
round-762 vault note carries this across.

---

## Facts and how to re-verify

Run from `/opt/forge-ai-os` (read-only for build phases: `show`/`log`/`diff` only). Whole section
takes under two minutes.

| # | Command | Observed 2026-08-05 (round 761) |
|---|---|---|
| F1 | `git diff --stat main...project/8ea0cc08 -- forge-control/src` | 10 files, +2638/−429: `index.ts` +4, `lib/secret-store.ts` 46, `routes/agents-shared.ts` new 576, `routes/agents.ts` −428, `routes/capabilities.ts` new 25, `routes/chat-linkage.ts` new 430, `routes/chat.ts` +1052, `routes/projects.ts` +106, `routes/secrets.ts` 40, `routes/working-time.ts` new 360 |
| F2 | `git diff --name-only main...project/8ea0cc08 \| grep -E 'src/db/\|project-tick\|cc-runner\|executor\|migrations'` | no matches (exit 1). The engine is cleanly ours |
| F3 | `git merge-base main project/8ea0cc08` | `a4865b64…` = `a4865b6 feat(tiers): junior tier + researcher role; re-pin fleet models (Konrad 2026-08-05)` |
| F4 | `git show project/8ea0cc08:forge-control/src/routes/capabilities.ts` | 25 lines; `CAPABILITIES.control_plane` = `message_into_session, resume_finished, stop, terminate` — FOUR flags; §5 specifies five; `subagent_message` absent |
| F5 | `git diff main...project/8ea0cc08 -- forge-control/src/index.ts` | `+import capabilities …` after the `projects` import; `+app.route("/api/capabilities", capabilities);` immediately after the `/api/projects` mount |
| F5b | `grep -n 'app.route\|const port' forge-control/src/index.ts` (this worktree) | imports end `import mentor …` line 43; mounts: `/api/projects` 185, `/api/tasks` 189, `/webhooks` 192, `const port` 194 |
| F6 | `grep -n '^export' forge-control/src/db/runs.ts` | exports `RunStatus` (30), `getRun` (212), `appendMessage` (321), `setRunStatus` (425), `archiveRun` (444) among others; `forge-control/src/routes/chat.ts:384` is `r.post("/:id/status")` → `setRunStatus`; `forge-control/src/executor.ts:857` polls `status === "cancelled" \|\| status === "paused"` |
| F7 | read the contract's own headings | §4 = Terminate, §6 = "Per-chat ↔ project linkage". The steward brief's "§4 chat linkage" is an alias for §6 |
| F8 | `git show project/8ea0cc08:forge-control/src/routes/chat-linkage.ts` | exports `ChatProjectLink` (87), `isProjectCreateCall` (154), `scanThreadForProjectIds` (178), `resolveChatProject` (213), `ChatProjectRollup` (345), `rollupChatProjects` (383); zero `new Hono` / route handlers — mounts nothing |
| F9 | `grep -n 'POST /api/projects' forge-control/src/lib/cc-runner.ts` | line 164, the operator system prompt. `forge-control/src/routes/projects.ts:66` destructures `{name, brief, repo, base_branch, architect_tier, mode, checkin_hours}` — unknown keys silently ignored on `main` |
| F10 | `git diff --stat main...project/8ea0cc08 -- 'docs/plan/0*.md'` | five files, +529/−654: `00-vision.md`, `01-requirements.md`, `02-architecture.md`, `03-quality.md`, `04-phases.md` |

**Corrections vs the round-760 recon.** None. All ten facts reproduced exactly; F1's per-file counts,
F3's merge base, F4's four flags, F5's insertion point and F10's five-file rewrite all matched. The
only detail worth adding: their `docs/plan/` additionally carries `10-…` through `16-…` plus
`BASELINE-FINDINGS.md` and a large `docs/plan/artifacts/` tree, none of which collide with ours.

---

## Open questions deferred to the r800 architect

These are the contract's own four open questions, carried here UNANSWERED and attributed. They are
engine *design* calls, not boundary calls; answering them in a boundary doc would be overreach. The
contract asks that they be answered by editing the vault note itself.

1. **Echo policy (§1).** Does a manager→worker message appear in the manager's thread automatically,
   or must the UI write it there? The UI's stated preference: the engine writes both sides.
2. **Fork vs in-place resume (§2).** Which one, and is `resumed_run_id` stable across resumes?
3. **Stopped state naming (§3).** `paused`, or `stuck` with signal `"stopped-by-operator"`?
4. **First flag-flip timeline (§5).** So the UI project knows whether to demo with disabled controls
   or live ones. Note that under D3 the flip itself is not ours to perform — what we owe them is a
   date for the *endpoint*, not for the flag.
