# 04 — Phases: os-usable-for-work

Seven phases. Every requirement R1–R90 maps to **exactly one**. N1–N10 are checked in all of them.

**Round numbers are phase labels, not a schedule.** Each phase's planner carries an explicit round
(100, 200, … 700) so a human and the Kanban can say "phase 4". Every task those planners create
declares `depends_on` / `workstream` / `write_set` and lets the engine compute its round. The gaps of
100 leave room for fix cycles.

**Ordering is the dependency graph, not the numbering.** Lanes 2–5 do not wait for lane 1; they run
concurrently in their own worktrees. Lane 1 is *first* in the sense that it is the one Konrad cannot
work around, so it gets the earliest start and the deepest review — not in the sense that everything
else queues behind it.

---

## Workstream map

| Workstream | Phases | Why it is separate |
|---|---|---|
| `main` | 7 | integration and deploy only |
| `vault` | 1, 2 | owns `lib/vault.ts`, `routes/vault.ts`, `db/memory.ts`, `routes/memory.ts`, `MemorySurface.tsx`, `MemoryGraph3D.tsx` |
| `surfaces` | 3 | **sole owner of `DesktopApp.tsx` and `nav-items.ts`** — the two files every other lane would otherwise fight over |
| `connections` | 4 | owns `routes/accounts.ts`, `routes/integrations.ts`, `app/desktop/settings/**` |
| `business` | 5 | owns `routes/pipeline.ts`, `db/pipeline.ts`, the Businesses/Pipeline/Money surfaces |
| `perf` | 6 | owns `routes/reminders.ts`, `db/reminders.ts`, `ProjectsSurface.tsx` |

Six distinct workstreams — **exactly `PROJECT_MAX_WORKSTREAMS`**. There is no headroom. No planner may
open a seventh; a task that tries is refused with a 400 naming the count. Fix cycles inherit their
parent's workstream, so none is needed.

Phases 1 and 2 share `vault` deliberately: one worktree runs its tasks one at a time, so phase 2's
surface work cannot begin before phase 1's API exists. That serialisation is correct — a UI that saves
through an endpoint that does not exist is not parallelism.

---

## Phase 0 — Research (round 99, `depends_on: []`, workstream `main`)

Four independent scouts, no shared files, no ordering between them — the cheapest parallelism
available. They answer questions the corpus could not settle from the codebase alone, and they answer
them **before** the phase that needs them starts planning.

| Scout | Question | Consumed by |
|---|---|---|
| **S-A** | The `agy` CLI: run `/root/.local/bin/agy --help`, attempt a login, record the **exact** prompts, flags and outputs. Does it use a device code? Where does it write its profile? Does it work under `env -i` (a scrubbed `PATH`, as pm2 runs it)? | Phase 4 (R53) |
| **S-B** | The `obsidian://` URI: confirm against Obsidian's real documentation whether `file=` takes the path with or without `.md`, how `vault=` resolves (folder name vs vault ID), and how a `+`, `&`, `#` and em dash in a path must be encoded. Test against `AI OS/Specs/Directory + Business Plan Hub — Business Model.md`. | Phase 1 (R18, R19) |
| **S-C** | Content Forge live state: the BullMQ queue names and depths reachable from this box, the pm2 process list with uptimes, and **why** 5 jobs have sat in QC for 11–14 days — which worker should have picked them up and what its log says. Read-only. | Phase 5 (R66, R67) |
| **S-D** | Library: enumerate what `routes/uploads.ts`, `routes/files.ts`, `routes/media.ts`, `lib/uploads-index.ts` and Google Drive actually hold today, with counts. What would populate a Library surface **that already exists**? | Phase 3 (R42) |

**Deliverable:** one artefact each under `docs/plan/artifacts/os-usable-for-work/phase0/`.
**Acceptance:** each records real command output, not a description of it. S-C touches nothing.

---

## Phase 1 — Vault write path and index truth

**Round 100 · workstream `vault` · requirements R1–R20 · depends on S-B**

The phase Konrad cannot work around, and the only phase in this project that can destroy data.

### Scope

1. **The baseline.** Run `bash scripts/checks/gates-808.sh --strict` (Bash `timeout 600000`) and commit
   the output verbatim as `phase1/gates-baseline.txt`. Every later phase's "no NEW red" is decided
   against this file. Also run both typechecks and record them.
2. **The browser harness** (architecture §0.2, N3) — built once here, committed as
   `phase1/browser-harness.md` plus a runnable script, and reused by phases 2–6. It must include the
   mandatory `/signin` assertion.
3. **Reproduce** the vault-edit complaint: show that `routes/vault.ts` exposes only append/note/daily
   and that no write path exists.
4. **`GET /api/vault/file`** — content + sha256 + mtime + bytes (R1).
5. **`PUT /api/vault/file`** — compare-and-swap on `base_sha256`, 409 with both versions, snapshot
   before write, atomic temp+rename, empty-body refusal, no delete verb, reused path guard
   (R2–R11).
6. **`GET /api/memory/index-health`** — three-way reconciliation, every discrepancy classified, and an
   `unexplained_count` headline (R12, R13). Plus explicit-only prune (R14).
7. **Counts envelope** — labelled fields, `all` removed, category chips made honest or deleted with the
   reason recorded (R15–R17).
8. **`obsidianUri()`** — shared, unit-tested, configurable vault name (R18, R19).
9. **Hard errors throughout** (R20, N1).

### Deliverables

- `forge-control/src/lib/vault.ts` — extended; existing exports byte-identical to `main`
- `forge-control/src/routes/vault.ts` — two new verbs
- `forge-control/src/db/memory.ts`, `forge-control/src/routes/memory.ts` — index-health, counts
- `forge-control/src/lib/vault.test.ts`, `.../memory-index-health.test.ts`
- `phase1/gates-baseline.txt`, `phase1/browser-harness.md`, `phase1/index-reconciliation.md`

### Acceptance criteria

- S1–S4 and S6 from `00-vision.md §4` pass.
- The fixture vault is used; no test touches `/opt/obsidian-vault`.
- `index-health` reports `unexplained: 0` today **and** flips to 1 when a fixture note is left
  unembedded.
- Adversarial reviewer (§3.4 of `03-quality.md`) **cannot** produce an unrecoverable content loss.
- Gate: universal block, no NEW red versus the baseline this phase just created.

### Task shape

```
S-B (round 99) ─→ P1 planner (round 100)
                    ├─ B1a  lib/vault.ts + vault.test.ts            (read/write/snapshot/uri)
                    ├─ B1b  routes/vault.ts                          (the two verbs)
                    ├─ B1c  db/memory.ts + routes/memory.ts          (index-health, counts)
                    ├─ B1d  gates baseline + browser harness         (artefacts only)
                    ├─ R1-red   ADVERSARIAL reviewer — "lose a note"  ← depends on B1a,B1b
                    └─ R1-gate  gating reviewer                       ← depends on ALL of the above
```

Four builders, four disjoint `write_set`s, one join.

---

## Phase 2 — Memory surface truth

**Round 200 · workstream `vault` · requirements R21–R36 · depends on the phase-1 planner**

### Scope

1. **Reproduce first** (R21): note view, counts rail, graph tab — screenshotted before any edit.
2. **Editor**: open, edit, save through `PUT`, conflict UI showing both versions, loud failures
   (R22–R24).
3. **Open in Obsidian**: real URI, on-screen caveat with the vault name, copy-path fallback
   (R25–R27).
4. **Counts rendered with units and source**, vault/agent split visible and filterable (R28, R29).
5. **The font**: measured, then fixed against what the measurement showed — self-hosting only if the
   webfonts demonstrably fail (R30–R32).
6. **The graph**: fed from `knowledge_note.links`, `source` declared, unresolved links marked rather
   than dropped, `empty_reason` on empty (R33–R35), and screenshotted working (R36).

### Deliverables

- `MemorySurface.tsx`, `MemoryGraph3D.tsx`, `app/api-vault.ts`
- `db/memory.ts` graph function (same workstream as phase 1 — no cross-lane contention)
- possibly `public/fonts/**` and `globals.css` **only if** the measurement justifies it
- `phase2/` — before/after screenshots, `font-measurement.md`, `graph-after.png`

### Acceptance criteria

- S1, S5, S7 pass.
- Every browser test carries the `/signin` guard.
- No hardcoded `font-family`; no colour literal (the token gate).
- A save that would clobber an agent's write is refused and shown, not merged.

### Task shape

```
P1 planner ─→ P2 planner (round 200)
                ├─ B2a  reproduce + screenshots + font measurement   (artefacts only)
                ├─ B2b  MemorySurface.tsx  (editor, conflict, obsidian, counts)
                ├─ B2c  MemoryGraph3D.tsx + db/memory.ts graph source
                ├─ B2d  api-vault.ts + fonts/globals.css if justified
                └─ R2-gate  gating reviewer   ← depends on all four
```

`B2a` runs first inside the lane by dependency, because a fix for an unphotographed defect is a guess.

---

## Phase 3 — Honest placeholders

**Round 300 · workstream `surfaces` · requirements R37–R43 · depends on S-D**

Runs **concurrently** with phases 1, 2, 4, 5, 6. Its files are touched by nobody else.

### Scope

1. Reproduce and screenshot all four surfaces (R37).
2. `PlaceholderSurface` → an unmistakable NOT BUILT state: warning treatment, the words, purpose,
   requirement, scheduling status (R38, R39).
3. Nav marks unbuilt entries (R40).
4. Written determination per surface with build-or-defer and a cost estimate (R41).
5. Library's determination names a producer that **already exists**, informed by S-D (R42).
6. No behavioural change to any built surface (R43).

### Deliverables

- `DesktopApp.tsx` (placeholder branch only), `nav-items.ts`
- `phase3/surface-determinations.md` + four before screenshots + four after screenshots

### Acceptance criteria

- S8 passes: "not built" visible above the fold on all four.
- The nav marker appears on exactly four entries.
- `git diff DesktopApp.tsx` is confined to the placeholder branch.
- The reviewer answers YES to: *would a tired operator read this as unbuilt rather than broken?*

### Task shape

```
S-D (round 99) ─→ P3 planner (round 300)
                    ├─ B3a  reproduce + 4 screenshots + determinations doc
                    ├─ B3b  DesktopApp.tsx placeholder + nav-items.ts
                    └─ R3-gate  gating reviewer
                  ─→ I3  integration into main  ← depends on R3-gate
                  ─→ RI3 reviewer of the integration
```

---

## Phase 4 — Settings connections

**Round 400 · workstream `connections` · requirements R44–R58 · depends on S-A**

### Scope

1. **Determination first** (R44): trace `account=arved health=healthy` to `ai_os.claude_accounts` on
   **port 5434**, `listAccounts()`, `classifyCredential()`. Written before any code.
2. **Claude accounts** (R45–R47): list with health and probe age, per-account Probe now, an add flow
   honest about needing an interactive `claude login`, priority switching.
3. **Google** (R48–R51): persist the probe result so it survives `pm2 restart forge-control`; three
   distinct states; real API call recording the returned email; scheduled re-check with staleness
   handling.
4. **`agy`** (R52–R54): absolute-path constant asserted by test; the affordance built to what S-A
   observed; verification by running a real command.
5. **GitHub** (R55, R56): PAT via `POST /api/secrets`, never through chat; status from a real
   `GET /user` showing login and scopes.
6. **The invariant** (R57, R58): no positive state without `checked_at`; verbatim upstream errors.

### Deliverables

- `routes/accounts.ts`, `routes/integrations.ts`
- `app/desktop/settings/{ConnectionsPanel,accountRegistry,integrationCards,connections}.tsx|ts`
- `app/api-connections.ts`
- `phase4/executor-auth-determination.md`, `phase4/agy-flow.md`, screenshots

### Acceptance criteria

- S9 passes: every connection carries `checked_at`; `null` renders UNKNOWN, never green.
- The twelve state assertions (4 integrations × 3 states) all pass.
- `agy` spawns under `env -i`.
- Adversarial reviewer finds no path to a green state without a probe, and no secret in any diff,
  transcript or artefact.

### Task shape

```
S-A (round 99) ─→ P4 planner (round 400)
                    ├─ B4a  determination doc + claude accounts (routes/accounts.ts + registry UI)
                    ├─ B4b  google persistence + scheduled recheck (routes/integrations.ts)
                    ├─ B4c  agy + github (integrationCards.tsx + api-connections.ts)
                    ├─ R4-red   ADVERSARIAL reviewer — "make it lie, leak the token"
                    └─ R4-gate  gating reviewer
                  ─→ I4  integration into main
                  ─→ RI4 reviewer of the integration
```

`routes/integrations.ts` is 781 lines and wanted by both B4b and B4c. **B4b owns it exclusively**; B4c
works in `integrationCards.tsx` and `api-connections.ts` and hands B4b any route change it needs. Two
builders in one workstream may not declare the same file — where a split is impossible, one builder
writes that file twice rather than two builders serialising on it.

---

## Phase 5 — Businesses, Pipeline, Money

**Round 500 · workstream `business` · requirements R59–R70 · depends on S-C**

### Scope

1. **The spine** (R59): build to Konrad's ruling — escalated in round 0 with a `forge:ui` choice
   (Funnel / Money / Operations / Two-deep-cards), **default Funnel** if unanswered. Record which and
   when.
2. **Read the spec** (R60): `AI OS/Specs/Directory + Business Plan Hub — Business Model.md`, including
   the 2026-08-04 §10 rulings — Layer 1 only, accountants, Jersey, Ian owns outreach, **won =
   signature**, **Committed** between Proposed and Won.
3. **Sourced figures** (R61): live probe or a visible as-of date. No 2026-08-04 status dot rendering as
   current.
4. **Directory and YouTube primary** (R62); the honest zeroes reported (R63).
5. **Pipeline** (R64–R68): stall age, no-work vs stuck-work, worker health, queue depth,
   unreachable-renders-as-unreachable, and strictly read-only against Content Forge.
6. **Money** (R69, R70): keep-cost report; two label corrections; nothing else.

### Deliverables

- `BusinessesSurface.tsx`, `businesses-inventory.ts`, `PipelineSurface.tsx`, `MoneySurface.tsx`
  (labels only), `routes/pipeline.ts`, `db/pipeline.ts`, `app/api-business.ts`
- `phase5/business-spine-ruling.md`, `phase5/money-keep-cost.md`, screenshots

### Acceptance criteria

- S10 passes: the 5 QC jobs render stalled with ages 11–14 days, and a fresh job renders not-stalled.
- pm2 and Redis unavailable → explicit "unavailable: `<err>`", never 0 and never "healthy".
- Zero writes to `content_forge`; zero `pm2 restart`.
- Every Businesses figure carries a probe time or an as-of date.

### Task shape

```
S-C (round 99) ─→ P5 planner (round 500)
                    ├─ B5a  BusinessesSurface.tsx + businesses-inventory.ts + spine doc
                    ├─ B5b  routes/pipeline.ts + db/pipeline.ts + api-business.ts
                    ├─ B5c  PipelineSurface.tsx + MoneySurface.tsx labels + money keep-cost report
                    └─ R5-gate  gating reviewer
                  ─→ I5  integration into main
                  ─→ RI5 reviewer of the integration
```

---

## Phase 6 — Projects lag and reminder policy

**Round 600 · workstream `perf` · requirements R71–R82 · depends on []**

Starts immediately — its measurement work depends on nothing but the browser harness, which it takes
from phase 1 when available and otherwise builds a local copy of rather than blocking.

### Scope

1. **Measure the lag before touching it** (R71): React commit count and duration, DOM node count,
   network trace. Committed as `phase6/projects-lag-before.md` **before** `ProjectsSurface.tsx` appears
   in any diff.
2. **Attribute** to one dominant cause (R72). Suspects, not conclusions: 127 unwindowed `TaskCard`s,
   the 6 s board poll, the 3 s per-running-task chat fetch, `listActiveTasks()` without a `LIMIT`.
3. **Fix that cause** (R73), prove it with the identical measurement (R74), preserve reachability of
   all 127 tasks (R75).
4. **Reminder triage** (R76, R77): what created the 124, the status split, the repeat clusters, and the
   finding that **nothing is overdue and nothing is undelivered** — this is a presentation defect, not
   a delivery defect.
5. **Policy ruled on before data moves** (R78): manager report with a `forge:ui` choice and a stated
   default; then implement the ruling (R79).
6. **Nothing deleted** (R80); **delivery path untouched and proven** (R81); **dedup preserved** (R82).

### Deliverables

- `ProjectsSurface.tsx`, `routes/reminders.ts`, the reminders UI, `app/api-perf.ts`
- possibly `db/projects.ts` — **if** touched, the `forbidden-file diff` gate goes red by design and the
  reviewer adjudicates it in writing against the baseline
- `phase6/projects-lag-before.md`, `phase6/projects-lag-after.md`, `phase6/reminders-triage.md`

### Acceptance criteria

- S11 passes, or the metric is explained and replaced in writing.
- S12 passes: reminder row count identical before and after, **verified by the reviewer's own query**.
- A test reminder created, delivered to the inbox, and its row flipped to `delivered`.
- `git diff` shows no change to `executor.ts` or `claimDueReminders()`.

### Task shape

```
(no dependency) ─→ P6 planner (round 600)
                    ├─ B6a  measure the lag — artefacts only, no source change
                    ├─ B6b  reminders triage + the policy escalation — artefacts + one curl
                    ├─ B6c  the lag fix                    ← depends on B6a
                    ├─ B6d  reminders surface per ruling    ← depends on B6b
                    ├─ R6-red   ADVERSARIAL reviewer — "break delivery, delete a row, hide a pending"
                    └─ R6-gate  gating reviewer
                  ─→ I6  integration into main
                  ─→ RI6 reviewer of the integration
```

`B6c` depending on `B6a` is what makes measure-before-fix structural rather than a request. `B6d`
depending on `B6b` is what makes ruled-before-implemented structural.

---

## Phase 7 — Integration and deploy

**Round 700 · workstream `main` · requirements R83–R90 · depends on every gating reviewer**

> **CORRECTION TO THE PHASE-7 PLANNER'S BRIEF (round 0, after seeding).** That brief tells you to list
> the project's tasks with `curl -s http://127.0.0.1:7700/api/projects/<id>/tasks`. **That path is
> POST-only and answers `404 Not Found` on GET.** The corpus is authoritative and this is the correct
> lookup:
>
> ```bash
> curl -s http://127.0.0.1:7700/api/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a
> # → {"project": {...}, "tasks": [ {id, round, role, workstream, status, title, depends_on}, ... ]}
> ```
>
> `GET /api/projects/board` also exists but returns active/blocked tasks across **every** project, so
> filter by `project_id` if you use it. Everything else in the phase-7 brief stands.

### Scope

1. **Integration tasks** — one per non-`main` workstream, each carrying the union of its lane's
   `write_set`s, each merging that lane's branch into `main` and, **on conflict, STOPPING and reporting
   the conflicting files verbatim, unresolved**. Each has its own reviewer. Auto-merge resolves in
   favour of whoever finished last: silent clobbering in a new costume.
2. **Dependencies before any gate** — `pnpm install --frozen-lockfile --prod=false` in each package
   holding a lockfile. `pnpm`, never `npm`.
3. **Full gate run** — both typechecks, unit tests, `gates-808.sh --strict` with `timeout 600000`,
   compared to the phase-1 baseline.
4. **Deploy** — per the verbatim guidance below.
5. **GitHub push** — on each `VERDICT: PASS`, `scripts/git-sync-branch.sh <worktree-dir>`. Plain push
   only.

### DEPLOY GUIDANCE (verbatim — copied into the deploy task's brief)

- **EXECUTOR-LOADED CODE.** If the diff touches `src/lib/project-tick.ts`, `src/lib/cc-runner.ts`,
  `src/executor.ts`, `src/db/*` or the `agents/*.md` role files, the executor is holding the old code
  in memory and a plain restart would kill every run in flight — including the deploy task itself.
- **NEVER `pm2 restart forge-executor`.** Not to deploy, not to test, not "just this once".
- Instead, after merging, run exactly:
  ```
  setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
  ```
  launch it DETACHED and END the task — never wait for it, never poll it, never tail the log until it
  finishes. The script waits for the fleet to go idle and restarts then; your task must return
  immediately.
- `pm2 restart forge-control` (the API side) remains allowed and is the right way to pick up route/API
  changes, since nothing long-running lives in that process.
- **MERGE vs PR (R17):** if the project brief says to open a PR instead of merging, run
  `scripts/git-sync-branch.sh <worktree-dir> --pr "<title>"` and do NOT merge to main — the PR is the
  deliverable. Otherwise merge per the brief (merge main into the work branch first if main moved,
  re-run typecheck + tests in the worktree, then merge to main; on conflicts STOP and report the
  files).

### GITHUB PUSH (phase completion — copied into every phase's gating reviewer brief)

- When a phase's gating reviewer issues `VERDICT: PASS` and the repo has an `origin` remote, run
  `scripts/git-sync-branch.sh <worktree-dir>` to push the work branch so the progress is visible on
  GitHub.
- **Plain push only. NEVER force-push, never `--force`, never `--force-with-lease`** — this branch is
  shared with whatever else is watching it.
- If the push fails (no origin, `gh` not authenticated, rejected), report the failure verbatim in your
  final message and move on. **A push failure NEVER changes the verdict.**

### Acceptance criteria

- S13: no NEW red versus the phase-1 baseline, or each new red adjudicated in writing.
- S14: the served HTML at the live host references a `BUILD_ID` different from the pre-deploy one, and
  both are recorded.
- The deploy transcript contains the detached `safe-restart.sh` line and **no**
  `pm2 restart forge-executor`.
- Install transcripts show `+ typescript`, never `- typescript`.

### Task shape

```
R3-gate ─→ I3 ─→ RI3 ┐
R4-gate ─→ I4 ─→ RI4 ├─→ P7 planner (round 700) ─→ B7 deploy ─→ R7-gate
R5-gate ─→ I5 ─→ RI5 │
R6-gate ─→ I6 ─→ RI6 │
R2-gate ──────────────┘   (vault lane merges via I2/RI2 on the same pattern)
```

---

## Requirement → phase map (complete)

| Phase | Round | Workstream | Requirements | Count |
|---|---|---|---|---|
| 0 — Research | 99 | main | (feeds 1, 3, 4, 5) | — |
| 1 — Vault write path and index truth | 100 | vault | R1–R20 | 20 |
| 2 — Memory surface truth | 200 | vault | R21–R36 | 16 |
| 3 — Honest placeholders | 300 | surfaces | R37–R43 | 7 |
| 4 — Settings connections | 400 | connections | R44–R58 | 15 |
| 5 — Businesses, Pipeline, Money | 500 | business | R59–R70 | 12 |
| 6 — Projects lag and reminders | 600 | perf | R71–R82 | 12 |
| 7 — Integration and deploy | 700 | main | R83–R90 | 8 |
| Cross-cutting | — | all | N1–N10 | 10 |

Every R1–R90 appears exactly once. No requirement is unassigned and none is assigned twice.

---

## Risks and how the plan absorbs them

| Risk | Absorbed by |
|---|---|
| A builder loses one of Konrad's notes | Phase 1's adversarial reviewer is briefed to try; snapshot-before-write makes every loss recoverable; empty writes are a 400 |
| A lane screenshots `/signin` and reports a working surface as dead | The harness's mandatory `/signin` assertion (N3), reviewed in every browser test file |
| Two lanes conflict on `DesktopApp.tsx` or `app/api.ts` | Exclusive ownership (`surfaces`) and per-lane `api-<lane>.ts` (architecture §0.3) |
| A phase "fixes" A4's non-existent 67-file gap | `00-vision.md §2.1` records the measurement and the phase-1 brief states the premise is false |
| Phase 6 breaks the only path to Konrad's inbox | Delivery path out of scope, adversarial reviewer, live end-to-end delivery test |
| A gate goes red for round-808 reasons and stalls a phase | Phase 1 commits a baseline; the rule is "no NEW red", which is only decidable against it |
| `pnpm install` silently prunes `typescript` and every gate dies with `tsc: not found` | `--prod=false` mandated; the tell (`+` vs `- typescript`) named in the reviewer's block |
| The deploy kills every run in flight | `pm2 restart forge-executor` forbidden; detached `safe-restart.sh` only |
| A planner opens a seventh workstream and gets a 400 mid-run | The cap is documented in every planner brief; six are pre-assigned |
| Konrad does not rule on the Businesses spine or the reminder policy | Both have stated defaults (Funnel; pending + 7 days) recorded with the date the default was taken |
| A phase drifts into building Goals/Journal/Map | Explicit non-goal in `00-vision.md §5`; phase 3's scope is words, not features |

---

## 10. Write-set ownership and disclosed exceptions

Authoritative. This is what the next round and the successor project read to learn who owns a file and
which behavioural freezes have been lifted. A commit message is not consulted; this table is.

### 10.1 Requirement exception — R11 vs R20, `appendToDailyNote` and `readDailyNote`

**Ruled by the operator on 2026-08-19, at round 100 fix cycle 1, on R1-red's blockers B-2 and B-3.**

R11 freezes the three pre-existing verbs: `POST /append`, `POST /note`, `GET /daily` must "behave
identically to before this project". R20 requires the vault verbs to hard-error, with no `catch {}`
that returns a default. `lib/vault.ts:161` could not satisfy both: a bare `catch` read *every* read
failure as "today's note does not exist yet" and then wrote the empty daily template over the note
that was sitting right there, returning `{ok:true, created:true}`. Measured by the red team: **4 245
bytes → 76, no snapshot, unrecoverable.**

**Ruling: R20 wins, and R11 is excepted here.** R11 protects append-or-create **semantics**, not a
data-destroying fallback. Silently replacing a note with an empty template is not "append behaving
identically" — it is the opposite of appending.

| Verb | Frozen behaviour that changed | Now |
|---|---|---|
| `appendToDailyNote` | any read failure → write `DAILY_TEMPLATE` over the note, resolve `{ok:true, created:true}` | ENOENT → create from template, unchanged. Anything else → **throw**, note untouched |
| `appendToDailyNote` | `fs.writeFile(abs, …)` — destination opened `O_TRUNC` | temp file → fsync → rename (`atomicWrite`). **The bytes that land are unchanged**, which is why R11's byte-level characterisation tests still pass unmodified |
| `readDailyNote` | any read failure → `content: null` ("no daily note today") | ENOENT → `content: null`, unchanged. Anything else → **throw** |

`readDailyNote` is not in the reviewer's blocker list — it was raised as note N-2, "same R20 smell as
B-2". It is fixed under the same ruling and disclosed here rather than left as a known R20 violation
inside the phase that owns R20. `createNote` is untouched: it only ever opens `wx`.

**What did NOT change:** the exact bytes written by an append, the section-insertion rule, the
`{path, created}` result shape, the daily filename and timezone, and `POST /note` in every respect.

### 10.2 Undeclared writes — round 100, fix cycle 1 (task `R1-fix`), disclosed here

The fix-cycle task row inherited its `write_set` from the **reviewer** row it was seeded from
(`docs/plan/artifacts/os-usable-for-work/phase1/red-team-vault-write.md` — a report file), which is
unsatisfiable for a task whose entire brief is "fix three blockers in `lib/vault.ts`". This is the
condition `03-quality.md` §3.5 names: audit a fix cycle against the **parent phase row** (B1a/B1b),
not against the inherited row. Every path below is inside B1a's or B1b's declared write set, except
the two corpus files, which are named in the reviewer's own prescription.

| File | Owner row | Why it had to change |
|---|---|---|
| `forge-control/src/lib/vault.ts` | B1a | the three blockers (B-1, B-2, B-3), the symlink escape, and folded findings F-2, F-3, F-6 |
| `forge-control/src/lib/vault.test.ts` | B1a | 20 regression assertions, each verified to fail against the pre-fix tree |
| `forge-control/src/routes/vault.ts` | B1b | folded finding F-5 — the 409 body cap |
| `forge-control/src/lib/vault-routes.test.ts` | B1b | the two 409-cap assertions |
| `docs/plan/os-usable-for-work/02-architecture.md` | — | §1.2 stated two things that are false (F-4); blocker 1's prescription is explicitly "and correct §1.2's claim" |
| `docs/plan/os-usable-for-work/04-phases.md` | — | this section — the R11 exception and this disclosure |
| `docs/plan/artifacts/os-usable-for-work/phase1/red-team-vault-write.md` | **the declared row** | resolution appendix appended (nothing removed) |
| `docs/plan/artifacts/os-usable-for-work/phase1/fix-cycle-1-vault-write.md` | — | the before/after evidence the fixes are proven by |

`forge-control/src/lib/vault-fixture.ts` was **not** touched: the symlink fixtures are created inside
the test that needs them, because a symlink committed into a shared fixture would change what every
other lane-1 test resolves.
