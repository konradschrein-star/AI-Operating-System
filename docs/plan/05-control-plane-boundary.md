# 05 — Control-plane boundary vs operator-visibility

**What this is.** A decision record fixing where `engine-v2-research-lane` (branch `project/4120f785`)
is allowed to write while `operator-visibility` (branch `project/8ea0cc08`) is in flight, so that the
Manager Control Plane API can be built without turning either lane's merge into a hand-resolved
thousand-line conflict.

**Who must read it.** (1) The round-800 architect, before planning any control-plane phase — this doc
is a precondition of that plan. (2) Every deploy-phase task on this branch, as a merge checklist.
(3) The operator-visibility lane, reached via the vault note written in round 762.

**Date / round.** 2026-08-05, rounds 760 (recon) / 761 (first draft) / 764 (this revision). All facts
were re-run live in round 761 and the merge behaviour was executed for real in round 764 (F11–F13);
disagreements with earlier rounds are called out under *Corrections*, including one in this document's
own round-761 text. Paths are written in full from the repo root throughout.

**What round 764 changed**, so a reader who saw the r761 version knows where to look: D2 now states
that `forge-control/src/index.ts` conflicts at merge no matter what either lane does, and how to
resolve it. D3 makes the capability flip unconditionally the other lane's, quotes the announcement
table's five column headers verbatim, and gains the *What this forbids* block it was missing. D6
replaces a one-sentence sketch with a numbered, executed recipe naming both project slugs. Q4 moves out
of the deferred list, because the round-762 vault note already answered it. Facts F11–F13 are new.

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

**Rationale.** F5: their hunk inserts `import capabilities from "./routes/capabilities.ts";` directly
after the `projects` import and `app.route("/api/capabilities", capabilities);` immediately after
`app.route("/api/projects", projects);`. Both of those spots are already occupied on `main` — our lane
put `import tasks …` (line 39) and `app.route("/api/tasks", tasks);` (line 189) in exactly them. Hono
prefix routing is order-independent for distinct prefixes, so our mount's position is free; putting it
at the far end is what keeps OUR two lines out of the contested region. It does not, and cannot, keep
the file itself out of conflict — see the next block.

**`forge-control/src/index.ts` WILL conflict at merge, in two places. This is already baked into
`main` and is not ours to avoid.** F11: `git merge-tree --write-tree main project/8ea0cc08` reports
`CONFLICT (content): Merge conflict in forge-control/src/index.ts`. Both lanes added a line at the
same offset relative to the fork base `a4865b6`, which carried neither:

- **Import block** — `import tasks from "./routes/tasks.ts";` (ours, on `main`) vs
  `import capabilities from "./routes/capabilities.ts";` (theirs). Both inserted between
  `import projects from "./routes/projects.ts";` and `import { startCronTick } …`.
- **Mount block** — `app.route("/api/tasks", tasks);` (ours, with its three-line comment) vs
  `app.route("/api/capabilities", capabilities);` (theirs, with its two-line comment). Both inserted
  between `app.route("/api/projects", projects);` and the `/webhooks` mount.

**Resolution: keep BOTH sides in BOTH hunks.** Delete the `<<<<<<<` / `=======` / `>>>>>>>` markers and
nothing else. Order is irrelevant: the two routers share no prefix and Hono matches by prefix, not by
registration order. Resolving by taking one side wholesale silently drops either `/api/tasks` or
`/api/capabilities` — an unmounted router throws no startup error, so the route simply 404s with
nothing in the log. That is the failure mode to design against.

**Our two appended lines are unaffected — verified, not assumed.** F11b simulates the D2-shaped edit
(`import runControl …` after the `mentor` import, `app.route("/api/runs", runControl);` after the
`/webhooks` mount) on top of `main` and re-runs the merge: both lines land OUTSIDE both conflict
regions in the merged file and need no hand-resolution. D2's shape is doing its job; the conflict it
cannot prevent is one it did not cause.

**What this forbids.** No edit anywhere between `app.route("/api/projects", projects);` and
`app.route("/webhooks", webhookIn);`. No reordering, no comment reflow, no import re-sorting anywhere
in the file. If a future change genuinely needs a second mount, it also goes at the end.

**Reviewer check.**
`git diff main...project/4120f785 -- forge-control/src/index.ts` shows exactly two `+` lines and zero
`-` lines, and neither `+` line sits in a hunk whose context includes `app.route("/api/projects"`.

---

## D3 — The capability flag

**Decision.** We NEVER flip the flag — not before their branch lands, not after, regardless of which
lane merges first. `forge-control/src/routes/capabilities.ts` is the operator-visibility lane's file
and the flip is unconditionally theirs. We ship the endpoint, prove it, and record in the contract note
which flag to flip and what proof backs it; they flip it in one line whenever they next touch the file.

**Why unconditional, and not "whoever merges second".** "Second" is only well-defined while both
branches are open. If their branch lands on `main` first, `capabilities.ts` becomes a `main` file we
*could* edit — and a rule phrased as "whoever merges second" would then quietly hand us the flip while
D1 still forbids us from touching that file. Two artefacts, two readings, and the failure is silent:
the endpoint is live, the flag reads `false`, the UI renders a disabled button with the plausible
tooltip "engine support pending (control plane contract)". Nobody sees an error. So the rule is written
by OWNERSHIP, not by ordering: their file, their flip, always. The announcement table's `flipped?`
column is the outstanding-work list they work through.

**Rationale.** F1/F4: `forge-control/src/routes/capabilities.ts` is a 25-line file that exists only on
`project/8ea0cc08`. Creating our own copy on `main` guarantees a whole-file conflict on a file whose
entire purpose is to be a single source of truth — the worst possible thing to duplicate. Editing
theirs is impossible *today*, because it isn't on `main` yet. The day their branch lands it becomes
possible — and it stays forbidden, for the ownership reason above, not the availability one.

**Protocol every deploy phase of ours follows.**
1. Land the endpoint on `main` (D1/D2 shape).
2. Capture proof: the exact `curl` and its verbatim response, into `docs/plan/evidence/`.
3. Append a row to the announcement table that already exists in the contract note
   (`/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md`, under **The announcement
   table**). Do not invent a format — the table is already there with five columns, and a row must fit
   them exactly, in this order:

   | column header (verbatim) | what goes in the cell |
   |---|---|
   | `endpoint` | verb + full route, e.g. `POST /api/runs/:id/stop` |
   | `capabilities flag to flip` | the key under `CAPABILITIES.control_plane`, e.g. `stop` |
   | `shipped on (branch/round)` | e.g. `project/4120f785 / r812` |
   | `proof (command + observed response)` | the exact `curl`, its verbatim response, AND the path of the evidence file from step 2 — all three in this one cell |
   | `flipped?` | **leave empty.** The operator-visibility lane fills it. |

   Append the row and nothing else — never rewrite their sections, never edit an existing row.
4. Done. The flip is a one-line change in their file, owned by them (see Decision above).

**Defect to record, not to fix.** F4: their `CAPABILITIES` constant declares FOUR flags —
`message_into_session`, `resume_finished`, `stop`, `terminate`. Contract §5 specifies FIVE.
`subagent_message` is missing. If we ever ship §2's `POST /api/runs/:parentId/subagent-message`
there is no flag to flip. This is a one-line fix on their side; the vault note carries it to them.

**What this forbids.** Creating `forge-control/src/routes/capabilities.ts` on this branch or on `main`;
editing theirs; rewriting any pre-existing section of the contract note
(`/opt/obsidian-vault/AI OS/Contract - Manager Control Plane API.md` — we append only); filling the
`flipped?` cell of any announcement row; and flipping any capability flag ourselves, including after
their branch lands on `main` and the file is sitting there editable.

**Reviewer check.**
`git diff --name-only main...project/4120f785 | grep capabilities` prints nothing; every shipped verb
has exactly one row in the contract note's announcement table whose `proof` cell names a real file
under `docs/plan/evidence/`; and every one of those rows has an EMPTY `flipped?` cell. A `flipped?`
cell filled in by us is a boundary violation even when the flag genuinely is flipped.

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
- F11: the merge of their branch into `main` conflicts in NINE paths, not five. Read D6 for the full
  list and the executed recipe before starting, and D2 for `forge-control/src/index.ts`. Re-run
  `git merge-tree --write-tree --name-only main project/8ea0cc08` on the day — it is read-only, takes
  seconds, and tells you the current list instead of this document's snapshot.

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

**Decision.** Change nothing now. Record an executable resolution recipe: at merge time, keep BOTH
corpora by moving EACH into a subdirectory named for its project slug. Nobody wins and nobody loses —
there is no "losing side" to identify, which is the whole point. The two slugs, written out:

| project slug | branch | its corpus files today |
|---|---|---|
| `engine-v2-research-lane` | `project/4120f785` — ours; already on `main` | `docs/plan/00-vision.md` … `docs/plan/04-phases.md` |
| `operator-visibility` | `project/8ea0cc08` — theirs; unmerged | `docs/plan/00-vision.md` … `docs/plan/04-phases.md`, plus `docs/plan/10-ui-v3-spec.md` … `docs/plan/16-ui-v3-graph-research.md` |

**The top level is vacated — BOTH move, neither stays.** Leaving one corpus at `docs/plan/0*.md`
re-creates this collision for the next project, because that is exactly how it was born: the
`files-pane-fast-light` corpus occupied the top level, our architect was told to write flat, and `main`
now carries `docs/plan/archive/2026-08-files-pane-fast-light/` as the cleanup (commit `b916520`). After
the recipe runs, `docs/plan/` holds only material belonging to no single project:
`docs/plan/05-control-plane-boundary.md` (this file — a cross-lane treaty, not a corpus document),
`docs/plan/evidence/` (ours), `docs/plan/artifacts/` (theirs), `docs/plan/archive/`, and the two
per-slug directories.

**Rationale.** F10: both lanes rewrote the same five filenames from a common ancestor that was a
THIRD project's corpus (files-pane-fast-light) — ~529 insertions / 654 deletions on their side alone.
Their `docs/plan/00-vision.md` opens `# 00 — Vision: operator-visibility` and states "This corpus
replaces the previous project's plan (files-pane-fast-light) that main carried in `docs/plan/`". Ours
opens `# 00 — Vision: engine-v2-research-lane`. Neither corpus is obsolete while its project runs, so
"pick a side" destroys a live planning document. The recipe is written down rather than applied now
because the merge is the only moment at which BOTH corpora are in one tree — moving ours today would
leave the top level occupied anyway, when their branch arrives, and would strand the dozen external
prose references for weeks with nothing gained. (It would NOT break intra-corpus links: verified, the
corpora cross-reference by section rather than by full path. See *Cross-references* below.)
Their UI corpus additionally occupies `docs/plan/10-…` through `docs/plan/16-…`; this file
(`docs/plan/05-control-plane-boundary.md`) collides with nothing, and our `docs/plan/evidence/` and
their `docs/plan/artifacts/` are disjoint.

**The recipe.** Written for the case where `project/8ea0cc08` is merged INTO `main` (the likely one —
our lane merges to `main` every deploy phase, theirs merges once at its round 900). Run from the repo
root of a clean checkout. Every step below was executed against the real trees on 2026-08-05 in a
throwaway clone at `/tmp/mergesim` (F12); the conflict list is what git actually produced, not a guess.

```bash
# 1. Start the merge and let it stop. Expect exactly nine conflicted paths:
#    five content conflicts in docs/plan/0*.md, two rename/delete conflicts under
#    docs/plan/archive/, plus forge-control/src/index.ts (see D2) and
#    forge-control-web/app/desktop/ChatSurface.tsx (neither lane's business — see below).
git checkout main && git merge project/8ea0cc08

# 2. Take OUR side of the five corpus files verbatim. Do NOT hand-merge two unrelated plans.
git checkout --ours docs/plan/0{0,1,2,3,4}-*.md
git add docs/plan/0{0,1,2,3,4}-*.md

# 3. Recover THEIR five out of their branch into their slug directory.
mkdir -p docs/plan/operator-visibility
for f in 00-vision 01-requirements 02-architecture 03-quality 04-phases; do
  git show project/8ea0cc08:docs/plan/$f.md > docs/plan/operator-visibility/$f.md
done
git add docs/plan/operator-visibility

# 4. Their UI corpus (10-16) merged cleanly as plain additions; move it alongside.
git mv docs/plan/1{0,1,2,3,4,5,6}-*.md docs/plan/operator-visibility/

# 5. Move OUR five off the top level.
mkdir -p docs/plan/engine-v2-research-lane
git mv docs/plan/0{0,1,2,3,4}-*.md docs/plan/engine-v2-research-lane/

# 6. The two rename/delete conflicts: `main` archived those files, their branch deleted them.
#    Keep the archived copies — the archive is deliberate, the delete is a side effect of
#    their branch replacing the old corpus in place.
git add docs/plan/archive/2026-08-files-pane-fast-light/BASELINE-FINDINGS.md \
        docs/plan/archive/2026-08-files-pane-fast-light/baseline-screenshot-dark.png

# 7. Confirm docs/plan is fully resolved. Only the two CODE conflicts may remain.
git diff --name-only --diff-filter=U
#   → forge-control-web/app/desktop/ChatSurface.tsx
#   → forge-control/src/index.ts      (resolve per D2: KEEP BOTH SIDES, both hunks)

# 8. Sanity-check the layout before committing.
ls docs/plan/    # → 05-control-plane-boundary.md  archive  artifacts
                 #   engine-v2-research-lane  evidence  operator-visibility
                 # (in the /tmp/mergesim run 05-* was absent, because the r761 commit
                 #  that adds it had not reached main yet. Everything else matched.)
```

**Cross-references.** Inside both corpora the documents refer to their siblings by section, never by
full path — verified: `grep -rl 'docs/plan/0[0-4]-' docs/plan/engine-v2-research-lane/
docs/plan/operator-visibility/` prints nothing after the move. So no intra-corpus link breaks and step 5
needs no follow-up edit. References from OUTSIDE the corpora do go stale, and they are all prose
(`forge-control/src/lib/project-reconcile.ts:13`, `project-tick.test.ts:6`, `project-reconcile.test.ts:6`,
`project-tick.ts:488,601`, `scripts/checks/*.ts`, `docs/tools/*.md`). Leave them; they are comments, they
break no build, and rewriting a dozen files inside a merge commit is how a merge goes wrong. Fix them in
a follow-up commit if anyone cares.

**`ChatSurface.tsx` is not ours and not a boundary failure.** `main` carries UI-audit commits on it
(`2130af4`, `83f0c62`) from a different lane; their branch rewrote it too. Our branch touches nothing
under `forge-control-web/` (`git diff --name-only main...project/4120f785 -- forge-control-web` is
empty). It is listed here only so the merger is not surprised by a tenth path they were not warned about.

**The forward rule needs an engine change — it is not self-executing.** "Every project's corpus is born
at `docs/plan/<project-slug>/`" cannot happen on its own: the architect prompt in
`forge-control/src/lib/project-tick.ts:410-414` hardcodes flat paths (`docs/plan/00-vision.md` …
`docs/plan/04-phases.md`), and line 419 hardcodes `"Plan phase k per docs/plan/04-phases.md"`. Until
those strings interpolate the project slug, every new project writes flat into whatever the top level
already holds — which is this bug, reproduced. Flagged for the r800 architect as a small, separate
change; deliberately NOT made here, because this doc authorises no code change (see the preamble).

**What this forbids.** Renaming, moving or deleting any of our `docs/plan/00-04` files before the
merge. Resolving those five conflicts by taking either side wholesale. Declaring a "winner" corpus and
dropping the other. Rewriting the dozen external prose references inside the merge commit.

**Reviewer check.**
`git diff --stat main...project/8ea0cc08 -- 'docs/plan/0*.md'` still lists exactly five files, and our
branch's `docs/plan/00-04` filenames are unchanged from their current names.

**Recommendation to the other lane.** Agree to the recipe above — specifically that BOTH corpora move
and the top level is vacated, rather than one side keeping `docs/plan/0*.md`. The round-762 vault note
carries the proposal across and asks them to record agreement or dissent by editing that note; whatever
the note says at merge time is what the merger follows.

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
| F11 | `git merge-tree --write-tree --name-only main project/8ea0cc08` (exit 1) | NINE conflicted paths, the complete merge picture: `docs/plan/00-vision.md`, `01-requirements.md`, `02-architecture.md`, `03-quality.md`, `04-phases.md` (content); `docs/plan/archive/2026-08-files-pane-fast-light/BASELINE-FINDINGS.md` and `…/baseline-screenshot-dark.png` (rename/delete — renamed in `main`, deleted on their branch); `forge-control-web/app/desktop/ChatSurface.tsx` (content, neither lane's — see D6); `forge-control/src/index.ts` (content, TWO hunks — import block `tasks` vs `capabilities`, mount block `/api/tasks` vs `/api/capabilities`) |
| F11b | Same merge, run against a simulated `main` carrying the D2-shaped edit (`import runControl …` after the `mentor` import; `app.route("/api/runs", runControl);` after the `/webhooks` mount), built with `git hash-object -w` + `git commit-tree` — no working tree touched | `index.ts` still conflicts in the same two hunks, and both of OUR lines survive OUTSIDE them (`import runControl` at merged line 48, `app.route("/api/runs", …)` at merged line 204). D2's shape works; the conflict is pre-existing and not ours |
| F12 | The D6 recipe, executed step by step in a throwaway `git clone /opt/forge-ai-os /tmp/mergesim` | After steps 2–6, `git diff --name-only --diff-filter=U` prints exactly `forge-control-web/app/desktop/ChatSurface.tsx` and `forge-control/src/index.ts` — every `docs/plan` conflict resolved, no path lost. `ls docs/plan/` → `archive artifacts engine-v2-research-lane evidence operator-visibility` |
| F13 | `git ls-tree --name-only project/8ea0cc08 docs/plan/` and `git cat-file -t project/8ea0cc08:docs/plan/BASELINE-FINDINGS.md` | Their top level: `00-`…`04-`, `10-`…`16-`, `artifacts/`, `baseline-screenshot-light.png`, `verify-round502-*`. `BASELINE-FINDINGS.md` **does not exist** on their branch — it was deleted, which is what produces F11's rename/delete conflict |

**Corrections vs the round-760 recon.** All ten of F1–F10 reproduced exactly; F1's per-file counts,
F3's merge base, F4's four flags, F5's insertion point and F10's five-file rewrite all matched.

**Correction vs the round-761 draft of this document (this file, made in round 764).** The closing
paragraph previously stated that their `docs/plan/` "additionally carries `10-…` through `16-…` plus
`BASELINE-FINDINGS.md`". The `BASELINE-FINDINGS.md` half is **wrong** — F13: their branch deleted that
file. The error mattered, because that deletion is precisely what turns `main`'s archival rename into a
rename/delete conflict (F11), and the round-761 text implied the file merged cleanly. Corrected here
rather than quietly edited away. The `10-…16-` half and the `docs/plan/artifacts/` tree are correct and
do not collide with ours.

---

## The contract's four open questions — three deferred, one already answered

The contract closes with four open questions. THREE are deferred to the r800 architect; the fourth was
answered in the round-762 vault note and is recorded here so the two artefacts agree.

### Deferred to the r800 architect — Q1, Q2, Q3

Carried UNANSWERED and attributed. They are engine *design* calls, not boundary calls; answering them
in a boundary doc would be overreach. The contract asks that they be answered by editing the vault note
itself, and the r800 architect is required to read this document before planning.

1. **Echo policy (§1).** Does a manager→worker message appear in the manager's thread automatically,
   or must the UI write it there? The UI's stated preference: the engine writes both sides.
2. **Fork vs in-place resume (§2).** Which one, and is `resumed_run_id` stable across resumes?
3. **Stopped state naming (§3).** `paused`, or `stuck` with signal `"stopped-by-operator"`?

### Answered — Q4, first flag-flip timeline (§5)

**Not open.** The round-762 vault note answers it, in the words the other lane will read: *"no endpoint
ships before our round-800 architect plans the control-plane phases, so plan your demo with disabled
controls."* That is the operative answer; this doc does not reopen it.

Two riders, both already in the note. First, when a date does exist it appears in the announcement
table and nowhere else — that table is the only place we publish one. Second, under D3 the flip itself
is never ours to perform, so what we owe them is a date for the *endpoint*; the flag follows whenever
they next touch `capabilities.ts`.
