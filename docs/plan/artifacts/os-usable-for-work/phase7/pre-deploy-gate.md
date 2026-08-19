# Phase 7 pre-deploy gate — the integrated tree, the baseline diff, and nothing clobbered

**Task** `4b9e9a75-4261-4f7d-b84a-1b040fe74194` (round 14, workstream `main`, role reviewer)
**Run** `704942f2-1e50-4a1c-baf5-6efa44201e3d`
**Tree reviewed** `project/7851068b` @ **`a128fe221e91bc63c9a45660b8492ceafefc9e50`**
(worktree `/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`; working copy clean
throughout; HEAD re-read immediately before the blocker below was written and had not moved)
**Merge-base with `main`** `9c3f63aa161a29b844699fcf537e9c8ae22f374d`
**Gate run** 2026-08-19T22:07–22:15Z

**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` (the per-project layout).
The legacy `docs/plan/03-quality.md` also exists on this branch; the per-project file is the one this
project is planned under and the one this review followed. §3.1 is its universal gate block, §3.5 the
fix-cycle audit rule, §3.6 the verdict-artefact rule.

---

## VERDICT: NEEDS_FIXES

**One blocker, and it is the gate itself.** `scripts/checks/preflight-deploy.sh` exits **1** at this
tip, and it cannot exit 0 at any point in the phase-7 sequence where it is meant to run. Everything
else in this review is green: 1 645 unit tests pass, both typechecks are clean, the gate suite runs
25 gates with 22 executed-green / 2 skipped-by-design / 1 red that is adjudicated below against the
baseline, no lane's work is reversed, and six of the seven merge commits on this branch are
**byte-identical to the automatic merge** (R83 satisfied by construction, not by inspection).

The blocker is a small, well-scoped change to one script. The tree itself is in good shape.

---

## 1. The preflight gate — FAIL (exit 1)

Full output, run at `a128fe2`:

```
----------------------------------------
### C1 — every lane's final verdict is PASS ###
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: highest reviewer is round 16 (task 6d92b80e-0b93-4ed8-8fad-270d6a078abf, status=pending) — no run_id yet, so no verdict exists ('Phase 7 GATE — R83-R90, the baseline diff, and the BUILD_ID fetched from the live host')
FAIL — C1 — every lane's final verdict is PASS: main=not-yet-run
----------------------------------------
### C2 — live checkout (/opt/forge-ai-os) is clean ###
PASS — C2 — /opt/forge-ai-os is clean at main=9c3f63a
----------------------------------------
### C3 — no lane branch has unmerged work into project/7851068b ###
  vault (project/7851068b-vault): 0 commit(s) not yet in project/7851068b
  surfaces (project/7851068b-surfaces): 0 commit(s) not yet in project/7851068b
  connections (project/7851068b-connections): 0 commit(s) not yet in project/7851068b
  business (project/7851068b-business): 0 commit(s) not yet in project/7851068b
  perf (project/7851068b-perf): 0 commit(s) not yet in project/7851068b
PASS — C3 — no lane branch has unmerged work
----------------------------------------
### C4 — merge-tree probe: main <- project/7851068b ###
  1758431ab7e6daf4a825925bc393cc76a503660f
PASS — C4 — merge-tree probe is conflict-free (tree 1758431ab7e6daf4a825925bc393cc76a503660f)
----------------------------------------
### C5 — MemorySurface reads no field routes/memory.ts does not emit ###
  emitted (routes/memory.ts -> noteCounts): agent_notes, embedded_chunks, embedded_files, excluded, folder_counts, folder_rule, measured_at, source, stale_embedding_rows, vault_files_on_disk, vault_notes_indexed
  accessed (MemorySurface.tsx): agent_notes, embedded_chunks, embedded_files, excluded, folder_counts, folder_rule, measured_at, stale_embedding_rows, vault_files_on_disk, vault_notes_indexed
  self-test (bogus field __bogusField99__ must be caught): selfTestOk=true
PASS — C5 — MemorySurface.tsx reads no field routes/memory.ts does not emit, and the comparator's self-test passed
----------------------------------------
SUMMARY: 5 checks — 4 PASS, 1 FAIL
----------------------------------------
PREFLIGHT: FAIL — phase 7 may NOT deploy
PREFLIGHT_EXIT=1
```

Re-run at the same tip immediately before this verdict was written: same result, `PREFLIGHT_EXIT=1`.

### 1.1 Why this is a defect in the gate and not a state of the tree

`check_c1` (`scripts/checks/preflight-deploy.sh:74-134`) selects, per workstream, the **highest-round**
reviewer row whose title is not `[MERGED`/`[FOLDED`/`[RETIRED` — the jq at `:85-89`:

```
88:       | sort_by(.round) | last
```

For workstream `main`, phase 7's own task graph is:

| round | role | task | status |
|---|---|---|---|
| 13 | builder | `999c250d` integrate main + vault + surfaces | done |
| **14** | **reviewer** | `4b9e9a75` — **this pre-deploy gate** | running |
| 15 | builder | `fe3749e0` deploy: merge to main, rebuild, BUILD_ID | pending |
| **16** | **reviewer** | `6d92b80e` — the post-deploy gate | pending |

So the row C1 picks for `main` is always a reviewer that runs **strictly after** the caller:

- at **round 14** (this run) — round 16 is `pending`, `run_id` is null → the `:103-106` branch →
  `main=not-yet-run` → FAIL;
- at **round 15** (the deploy builder, which the script's own header says runs it: *"Both the deploy
  task and the phase-7 gating reviewer run this; a non-zero exit means the deploy does not happen"*)
  — round 16 is still `pending` → FAIL;
- at **round 16** itself — the row now has a `run_id`, but a reviewer has emitted no `VERDICT:`
  assistant message at the moment it runs its own preflight, so `c1_fetch_verdict` returns the empty
  string and the `*` branch (`:122-124`) records `main=unparseable` → FAIL.

The third case is not inferred. It was measured against this run's own task row, which is exactly
that shape — a `running` reviewer with no verdict yet — using the script's own query:

```
$ psql … -Atc "select coalesce(substring(e->>'content' from 'VERDICT: [A-Z_]+'),'<null>')
    from runs r, jsonb_array_elements(r.thread) with ordinality a(e,o)
    where (r.metadata->>'task_id')='4b9e9a75-4261-4f7d-b84a-1b040fe74194' and e->>'role'='assistant'
      and e->>'content' ~ 'VERDICT: ' order by o desc limit 1"
(no rows)
```

Empty → C1's `*` branch → `unparseable` → FAIL. **The gate is unsatisfiable at all three points at
which it is meant to be run**, and the deploy is therefore permanently blocked by its own
precondition. That is a real defect in a file committed on this branch (`5c8b3e3`, amended by
`a128fe2`), not a property of the integrated work.

The brief's instruction — *"if it exits non-zero, that alone is `VERDICT: NEEDS_FIXES` — do not
reason around it"* — and the substance agree here, which is why this is the verdict rather than a
noted exception.

### 1.2 The prescribed fix

`scripts/checks/preflight-deploy.sh`, `check_c1` (`:74`), the jq selection at `:85-89` and the
null-`run_id` branch at `:103-106`:

> Ignore reviewer rows that have **never run** (`run_id == null`), and evaluate the highest-round
> reviewer per workstream that **has** a run. A workstream with no completed reviewer at all must
> still FAIL. Print each skipped never-run row by round and title, loudly, so nobody reads a green
> C1 as "every reviewer row was checked".

That keeps every tooth the check has today: a workstream whose newest *rendered* verdict is
`NEEDS_FIXES` still fails, including the case where a re-review is seeded but not yet run — the
`NEEDS_FIXES` row is then the newest one with a run. The residual it accepts is stated rather than
hidden: work committed after the newest rendered verdict is not covered by C1, which is what C3, C4
and the round-16 post-deploy gate exist for.

Per the script's own convention (and `checker-reads-its-own-documentation-as-code`), the fix should
ship a **forced-failure demo of the new selection** — a scratch fixture where the newest run
reviewer is `NEEDS_FIXES` and a later row is pending, proving C1 still fails — since this is the gate
that judges its own author's output.

### 1.3 C1 spot-check, done independently

The brief requires re-verifying C1 by hand for the two lanes whose last verdict before a fix cycle
was `NEEDS_FIXES`. Read directly from `runs.thread`, LAST assistant message only
(`verdict-grep-matches-the-brief`: a whole-column regex matches every brief and classifies every
reviewer as both):

| lane | reviewer task | run | completed (UTC) | last assistant verdict | lane tip | tip committed (UTC) | verdict post-dates tip? |
|---|---|---|---|---|---|---|---|
| connections | `2c112799` (round 6) | `eedec96a` | 2026-08-19 00:23:06 | `VERDICT: PASS` | `0c65e35` | 2026-08-19 00:12:58 | yes |
| business | `8e2da884` (round 5) | `744facc9` | 2026-08-18 22:29:05 | `VERDICT: PASS` | `8eed286` | 2026-08-18 22:18:46 | yes |
| vault | `938740f4` (round 12) | `bec0dfbd` | 2026-08-19 02:39:53 | `VERDICT: PASS` | `5f98eb9` | 2026-08-19 02:36:16 | yes |
| perf | `98cbb26e` (round 3) | `94f4b12d` | 2026-08-18 22:10:18 | `VERDICT: PASS` | `a080a19` | 2026-08-18 22:08:55 | yes |
| surfaces | `da6385eb` (round 4) | `7f3fa471` | 2026-08-18 20:44:40 | `VERDICT: PASS` | `b29ceb8` | 2026-08-19 20:28:08 | **no — see below** |

**The surfaces row deserves a sentence, and it is not a finding.** Its round-4 PASS pre-dates its
lane tip by ~24 h, because four later commits landed on that branch (`67638af`, `742a34c`, the
reconciliation merge `823db93`, `b29ceb8`) during the phase-7 reconciliation. Those commits were
reviewed — by the `main`-workstream round-8 re-check, task `ab659f37`, run `f1ef34b5`, whose last
assistant message is `VERDICT: PASS` at 2026-08-19 20:32:52Z, four minutes after `b29ceb8`. C1's
per-workstream selection cannot see that, because the covering verdict lives in a different
workstream. Worth knowing; not worth a fix cycle. The `main` workstream's two other completed
reviewers, `69f543cc` (2026-08-19 21:27:36Z) and `ab659f37`, are both PASS; `a30becc8` and
`9afffb14` are the superseded `NEEDS_FIXES` rows that those two closed.

---

## 2. Nothing was clobbered — PASS

`git merge-base <lane> HEAD` equals each lane tip exactly, so for this tree the brief's literal
two-dot command and the merge-base-anchored three-dot form are **the same diff**
(`two-dot-diff-shows-sibling-work-reversed` does not bite here, and that was checked rather than
assumed):

| lane | tip | merge-base(lane, HEAD) | source files the lane touched | reversals in HEAD |
|---|---|---|---|---|
| vault | `5f98eb9` | `5f98eb9` | 19 | none |
| surfaces | `b29ceb8` | `b29ceb8` | 3 | none |
| connections | `0c65e35` | `0c65e35` | 22 | none |
| business | `8eed286` | `8eed286` | 12 | 1 line **added** to `scripts/checks/dollar-allowlist.txt` (§4.3) |
| perf | `a080a19` | `a080a19` | 13 | `api-perf.ts` −5/+7, comment only (below) |

`forge-control-web/app/api-perf.ts:13-22` — the perf lane left a debt note saying `api.ts` still
exports the now-over-promising `fetchProjectBoard` and *"whoever next owns that file should delete
it"*. The phase 4–6 integration (`040a664`) deleted it after confirming zero callers repo-wide, and
rewrote that comment to say so. A discharged debt note, not a reversal.

### 2.1 The four named survivals

| claim | evidence at `a128fe2` |
|---|---|
| `553fa38`'s `<GoalsSurface/>` route survives | `DesktopApp.tsx:47` imports it; `:503` renders `{surface === "goals" && <GoalsSurface />}`, once, with `:500` explaining why it is not double-rendered |
| JOURNAL / MAP / LIBRARY honest placeholders survive | `nav-items.ts:111,121,122` carry `unbuilt: true` for `library`, `journal`, `map`; `:129-134` derive `UNBUILT_NAV_KEYS` off the model rather than a second hand-written list. GOALS is correctly **not** flagged (`:96-102`, `:120`) |
| `AgyCard` and `GitHubCard` are MOUNTED | `ConnectionsPanel.tsx:56,58` import them, `:287` `<AgyCard onFacts={setAgy} />`, `:300` `<GitHubCard onFacts={setGithub} />`. The connections lane's own BLOCKER — built, tested, unreachable — is closed |
| vault `PUT /api/vault/file` and its snapshot guard | `routes/vault.ts:156` `r.put("/file", …)`; body parsed in a real `try/catch` that refuses a malformed body **before** any write (`:158-177`); `VaultConflictError` → 409 with `current_sha256`, a capped `current_content` and an explicit `current_content_truncated` flag (`:200-230`). `lib/vault.ts:530 snapshotBeforeWrite()` writes with `"wx"` so a snapshot can never overwrite another, reads the snapshot back and compares byte counts (`:545-556`), and throws **`THE NOTE WAS NOT WRITTEN`** if the snapshot fails; `:700` takes it before the write, inside `serialiseOnPath` |

---

## 3. R83 — no integrator resolved a conflict by choosing a side — PASS

Tested by construction rather than by reading the merges: for each merge commit, the tree it actually
recorded was compared against the tree `git merge-tree --write-tree <parent1> <parent2>` produces
today. Identical trees mean the merge carries **no** hand edit, conflicted or otherwise.

| merge | produced by | combined-diff lines | auto merge-tree | recorded tree | |
|---|---|---|---|---|---|
| `3330996` perf | `e5d2076c` | 0 | `082d0780…` | `082d0780…` | IDENTICAL |
| `6dde6bd` business | `e5d2076c` | 0 | `9d70dfbc…` | `9d70dfbc…` | IDENTICAL |
| `7b2dd77` connections | `e5d2076c` | 0 | `ad460c95…` | `ad460c95…` | IDENTICAL |
| `19d35e0` main→branch | `999c250d` | 0 | `ce4a9299…` | `ce4a9299…` | IDENTICAL |
| `d6dc6b1` vault | `999c250d` | 0 | `b6b8fa40…` | `b6b8fa40…` | IDENTICAL |
| `6bcef8d` surfaces | `999c250d` | 0 | `f323135b…` | `f323135b…` | IDENTICAL |
| `823db93` surfaces↔main reconciliation | surfaces lane, round 9 (`f4a7e71e`) | 256 | `793e815c…` | `405e6799…` | DIFFERENT — see below |

The six merges the brief names carry **zero** combined-diff lines. R83 is satisfied.

`823db93` is the one merge on this branch that resolved a real conflict, and it is **outside R83's
scope as briefed** (neither integrator produced it): it is the surfaces lane's round-9 reconciliation
task, whose entire brief was *"the two files that still conflict"*. Its combined diff touches exactly
those two — `DesktopApp.tsx` and `nav-items.ts` — the resolution is documented in
`docs/plan/artifacts/os-usable-for-work/phase7/surfaces-main-reconciliation.md`, and it was reviewed
by the round-8 `main` re-check (`ab659f37`, PASS) four minutes after the last commit on that branch.
Recorded here so no later reader mistakes it for an undocumented side-choice.

---

## 4. The universal block — run serially on a clean tree, recorded verbatim

Working copy was clean before and after; no experiment of this review's own landed in the suite's
`pnpm test` gate (`background-gate-run-self-contaminated`).

### 4.1 Steps 1–5

```
=== STEP 1: forge-control install ===
+ pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 756ms using pnpm v9.15.9
RC=0
=== STEP 2: forge-control-web install ===
+ pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 927ms using pnpm v9.15.9
RC=0
=== STEP 3: forge-control tsc ===        RC=0   (no output)
=== STEP 4: forge-control-web tsc ===    RC=0   (no output)
=== STEP 5: forge-control pnpm test ===
# tests 1645
# suites 308
# pass 1645
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5928.997763
RC=0
```

**R84 — the `+ typescript` / `- typescript` tell.** Neither string appears, because both stores were
already complete and pnpm added and removed nothing ("Already up to date"). Presence was therefore
proved directly rather than read off the transcript:

```
-rwxr-xr-x forge-control/node_modules/.bin/tsc       → Version 5.9.3
-rwxr-xr-x forge-control/node_modules/.bin/tsx
-rwxr-xr-x forge-control-web/node_modules/.bin/tsc   → Version 5.7.2
```

Both typechecks were run, separately, and both exited 0 (R85). The gate suite's own gates 1 and 2 ran
them a second time, also 0.

### 4.2 Step 6 — `gates-808.sh --strict`, given `timeout 600000` (R86)

**25 gates — 22 EXECUTED green, 2 SKIPPED-by-design (browser), 1 RED. Suite exit 1.**

```
 SUMMARY — 25 gates
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  1      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck
 13 0      check-stop-affordance.tsx
 14 0      check-dismiss-peek.tsx
 15 0      check-team-rows.ts
 16 0      check-team-confirm.ts
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs
 22 0      nav-walk-sampling.cjs
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness
 RED: 1
```

**Gate 17 is GREEN**, as `03-quality.md` §3.1's correction says it must be read. It was re-anchored on
content by `c31c6f7` before the `main` merge, not re-pinned by line.
**Gate 18 is GREEN** and its scratch DB has been per-process since `f283d5b`, so this is not a
concurrency artefact; it did not need a solo re-run.

### 4.3 The one red, adjudicated in writing against the baseline

Baseline: `docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`, **RED: 0**. This run,
**RED: 1**. The single delta:

**Gate 6 — `forbidden-file diff — three-dot main...HEAD`, EXIT 1 on `forge-control/src/db/projects.ts`.**

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
forge-control/src/db/projects.ts
>>> FORBIDDEN FILE DIFFERS
```

- **Provenance.** Exactly one commit since the merge-base touches it: `27faa28`, *"fix(phase 6, round
  1): the board poll's payload — column-project the query, do not window the board"* — the perf lane,
  E1, requirements R73/R75.
- **What it does.** Adds `ProjectBoardTask = Omit<ProjectTaskWithProject,"brief">` and
  `BOARD_TASK_COLS_PT = projectBoardColumns(TASK_COLS_PT)`, and has `listActiveTasks()` select that
  projection. `brief` was 88.2 % of a 1 843 144-byte board response of which 34 834 bytes were
  rendered. **No `LIMIT` was added** — R75 forbids it, and the header says so at the site; all 149
  active/blocked cards stay reachable. The projection is evaluated at module load, so a projection
  this file can no longer build is a boot failure naming the column rather than a 500 on the next
  poll.
- **Why the gate fires anyway.** Gate 6's file list is round 808's, and `03-quality.md` §3.1 states
  in advance that this gate *"pins `main...HEAD` against a round-808 file list and will read red or
  meaningless for this project"*. The perf lane cannot fix the Projects lag without touching the
  module holding the board query. The brief for this gate anticipates the same red by name.
- **Declared?** Yes — `forge-control/src/db/projects.ts` is in the perf lane's own declared write set,
  and the perf lane adjudicated this identical red at its round 3 (`f4aa994`).
- **Ruling: ACCEPTED, not new damage.** The red is a scope collision between a round-808 file list and
  a requirement of this project, on a change that is declared, reviewed and required. It is recorded
  here so it is never silently accepted again. The standing repair — binding gate 6's list to the
  declared write set rather than to a frozen list — is `operator-visibility` work and is **recorded,
  not done**, exactly as the gate-8/gate-17 pair was in `04-phases.md` §"round 13".

No other gate differs from the baseline in either direction.

### 4.4 The design-token gate — checked by hit count, not by exit code

`no-raw-colours.cjs` allowlist entries are whole-file `.*` patterns for the debt files, so the exit
code cannot catch a new literal in an already-listed file. Counts:

| | baseline | this run |
|---|---|---|
| total literals | 222 across 14 files | **221 across 14 files** |
| legitimate | 176 | **178** |
| known debt | 46 | **43** |

Every debt file's count is unchanged **except** `MemorySurface.tsx`, **8 → 5** — the vault lane
removed three, none added. `scripts/checks/raw-colour-allowlist.txt` is **byte-identical to the
merge-base**: no entry was widened, added or reworded to make this gate pass.

The `+2 legitimate` is accounted for. Six colour literals are added across `main...HEAD`, all six in
`forge-control-web/app/desktop/MemoryGraph3D.tsx`, which carries a pre-existing *legitimate* `.*`
entry ("three.js / WebGL … paints into a GL context that never sees the CSS cascade"):

```
:63   const UNRESOLVED_COLOR = "hsl(38, 34%, 52%)";
:118  …color:#cdc3d7;background:#0b0b10cc;border:1px solid …   (tooltip HTML string)
:192  chipBase   background: "#0b0b10ee"
:280  empty-state panel   background: "#0b0b10ee"
```

**Observation, folded here rather than seeded as a fix cycle** (`:192` and `:280`): those two are
React style objects on DOM overlays, not the GL context, and every other property on the same objects
resolves through `tokens.*`. They are theme-blind, and they are excused only because the file's
allowlist rule is whole-file. Both sit over a WebGL canvas that is dark in either theme, so the
visible consequence today is nil — which is why this is a note and not a blocker. Whoever next owns
that file should either tokenise the two overlay backgrounds or narrow the allowlist rule to the GL
palette and the tooltip string.

### 4.5 `check-secret-scan`

Run at this tip, not softened, `SAFE_MARKERS` untouched:

```
$ cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-secret-scan.ts
ALL PASS — 1039 tracked files carry no unlabelled DB credential
```

Caveat recorded rather than glossed: the scan's corpus is `git ls-files`, so **this document was not
in it at the time of that run** (`scan-corpus-excludes-your-own-evidence`). Re-run after it is
tracked; the recipe above is one line.

---

## 5. Live-checkout cleanliness — PASS

```
$ git -C /opt/forge-ai-os status --porcelain
(no output)
```

Empty, at `main=9c3f63a`. Confirmed twice — once directly at the top of this review and once by the
preflight gate's own C2.

---

## 6. Write-set audit

Both phase-7 integration tasks were audited against **their own declared `write_set`**, taken from
`GET /api/projects/<id>`, against the files their commits actually changed. Task commits were
partitioned by run window, which splits cleanly with no overlap:

| task | run | window (UTC) | first-parent segment | files changed |
|---|---|---|---|---|
| `e5d2076c` (round 5, perf+business+connections) | `2b618154` | 20:47:03 → 21:19:28 | `5c8b3e3..040a664` | 132 |
| `999c250d` (round 13, main+vault+surfaces) | `caa62c8f` | 21:28:35 → 22:04:59 | `040a664..a128fe2` | 121 |

**`999c250d` — 9 written-but-not-declared paths, 8 of them already disclosed** in
`04-phases.md` §"Undeclared writes, disclosed (round 13, the three-merge integration)" (line 526),
each with owner and reason: `docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`,
`scripts/checks/dollar-allowlist.txt`, `docs/plan/artifacts/phase400/dollar-allowlist.md`,
`phase7/goals-proof-r13.cjs`, the three `phase7/r13-*.png`, and `scripts/checks/preflight-deploy.sh`.
The disclosure landed in `10615be`, in the same commit as the write it discloses, per
`undeclared-write-needs-phases-section-10`.

The ninth is `docs/plan/artifacts/os-usable-for-work/phase7/surfaces-main-reconciliation.md` — merge
payload from the surfaces lane's own round-9 task, not integrator-authored, and inside the subject
matter of the merge. A bookkeeping gap; **recorded, and the row is not amended**
(`ledger-gap-is-the-finding`).

**`e5d2076c` — 37 written-but-not-declared paths.** Provenance was checked per file rather than
assumed. Thirty-four arrived as **lane merge payload** (`phase4/*`, `phase5/*`, `phase6/*` artefacts,
`docs/research/round-{399,499}-*.md`, `routes/usage.ts`, the quota client files,
`check-secret-scan.ts`, `check-gemini-tally.ts`, `serve-quota-7799.ts`, `dollar-allowlist.txt`) —
authored and reviewed inside their lanes, and reaching this branch through merges the integrator
performed but did not hand-write. The integrator's declaration enumerated most of the merge payload
and under-enumerated the rest.

Three were **hand-written by the integrator**, in `040a664`, and all three are disclosed — in that
commit's message under `UNDECLARED WRITES, DISCLOSED:` and in `04-phases.md` in the same commit
(`forge-control-web/middleware.ts` is tabled at line 330):

| file | disclosed | note |
|---|---|---|
| `forge-control-web/app/api.ts` | yes | deleted the zero-caller `fetchProjectBoard`; correctly refused the briefed "delete the `brief` field", which was measured to be a build break |
| `forge-control-web/middleware.ts` | yes | auth matcher excludes `fonts/` **with the slash** — a bare `fonts` is a prefix that would also unguard `/fontsecret-probe`, measured. Verified both directions on a throwaway server; `/desktop`, `/`, `/settings`, `/api/proxy/today` still 307 |
| `docs/plan/os-usable-for-work/04-phases.md` | yes | the disclosure itself, same commit |

No `done` row's `write_set` was amended by this review, and no PATCH was proposed for one.

---

## 7. What is NOT claimed by this review

- **No live verification.** This is a build-phase gate; nothing was run against `/opt/forge-ai-os`,
  the live executor or the live web server beyond the read-only `git status` above. The BUILD_ID
  proof belongs to rounds 15 and 16.
- **No browser reproduction.** This gate's checklist is the tree, the merges, the suite and the
  baseline; the surface-level proofs (GOALS rendering, the unbuilt marks, the memory surface) were
  taken by round 13 and by each lane's own gate, and were read here as commits and code, not
  re-photographed.
- **`check-secret-scan`'s corpus** excluded this file at the time it ran (§4.5).

---

## VERDICT: NEEDS_FIXES

1. **`scripts/checks/preflight-deploy.sh:85-89` and `:103-106` (`check_c1`, `:74`)** — the gate exits 1 and
   cannot exit 0 at any point in the phase-7 sequence. `sort_by(.round) | last` over reviewer rows
   picks, for workstream `main`, a reviewer that runs strictly after the caller: round 16
   (`6d92b80e`, `pending`, `run_id` null) at both round 14 and round 15, and at round 16 the running
   reviewer's own row, which has no `VERDICT:` assistant message yet and lands in the `*`
   → `unparseable` branch (measured against this run's row: the query returns no rows). The deploy
   task's own precondition is therefore permanently unsatisfiable.
   **Fix:** skip reviewer rows that have never run (`run_id == null`) and evaluate the highest-round
   reviewer per workstream that has one; a workstream with no completed reviewer still FAILS; print
   every skipped never-run row by round and title so a green C1 is not read as "all rows checked".
   Ship a forced-failure fixture for the new selection — newest-run reviewer `NEEDS_FIXES` with a
   later pending row must still fail — because this is the gate that judges its own author.

Everything else in §§2–6 is green. Nothing in the integrated tree needs to change for this verdict to
clear; one script does.

---

# Fix cycle 1 (round 15) — the response

Appended by the fix-cycle builder. **Nothing above this line was altered**; the round-14 verdict,
its evidence and its blocker text stand as written. This section records what was done about the one
blocker and how it was proved.

**Tree at the start of this fix cycle** `6958f5f63d9e4ee8529de224643cd0ae2d674d4a`
(worktree `/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`, branch
`project/7851068b`). `/opt/forge-ai-os` was not touched: this is a build task, and C2 is the check
that would notice.

## 1. What changed

| File | Change |
|---|---|
| `scripts/checks/preflight-deploy.sh` | `check_c1`'s selection rewritten; `c1_run_status()` added; `SELF_RUN_ID` / `C1_IN_FLIGHT_RE` added; the trailing `main "$@"` guarded so the file can be sourced |
| `scripts/checks/fixtures/preflight-c1-fixture.sh` | **new** — eight-case forced-failure fixture for the new selection |
| `docs/plan/os-usable-for-work/04-phases.md` §10 | the undeclared-write disclosure for the two above |
| `docs/plan/artifacts/os-usable-for-work/phase7/preflight-evidence.md` | one paragraph marking §2's C1 demo superseded |

## 2. The new selection, and why it is wider than the fix the gate prescribed

The gate prescribed: ignore rows with `run_id == null`, judge the highest-round reviewer that has
one, still fail a workstream with no completed reviewer, print every skipped row. That is
implemented. It is **not sufficient on its own**, and the gate's own §"blocker" says why: it lists
three unsatisfiable points, and rule 1 only fixes two of them. At round 16 the post-deploy gate has a
`run_id` — its own, still running — so under the prescribed rule it selects itself, finds no
`VERDICT:` assistant message, and lands in `unparseable`. The third point survives the prescribed
fix. So C1 now walks each workstream's reviewer rows from the highest round **down** and skips for
exactly three reasons:

1. `run_id` is null — the row has never run.
2. `run_id == $FORGE_RUN_UUID` — it is the caller's own run. **A gate must not read its own verdict.**
3. There is no verdict yet **and** the run is still in flight (`queued|running|pending|starting|resuming`).

The first round-band that is not entirely skipped is judged — the whole band, not one row of it,
because `main` genuinely carries two round-6 reviewers and `sort_by(.round) | last` chose between
them on array order alone.

What was deliberately **not** loosened:

- A reviewer whose run has **ended** without a `VERDICT:` line is judged, and fails as `unparseable`.
  This is the load-bearing distinction: rule 3 turns on the run's lifecycle status, not on the
  absence of a verdict, so a reviewer that crashed still blocks the deploy. Case 5 below is that
  control, and mutation C shows the check going green without it.
- A workstream where every row was skipped fails as `no-completed-reviewer`, never falls through.
- The `[MERGED`/`[FOLDED`/`[RETIRED` filter, the DB-error branch, and the "no reviewer at all"
  branch are unchanged.

The teeth the gate was worried about are intact by construction: an unrun re-review seeded above a
`NEEDS_FIXES` is skipped by rule 1, which leaves that `NEEDS_FIXES` as the newest **run** row, so it
still blocks. That is case 1 of the fixture, and it is also the live situation right now.

Every skip is printed with its round, task id, status and title, and a green C1 carries the count:

```
PASS — C1 — every lane's final verdict is PASS (vault surfaces …); 1 reviewer row(s) skipped as
not-yet-run/in-flight/self, listed above — this is NOT 'every row checked'
```

## 3. The sourcing guard, and why it is not an env-var test hook

The fixture drives **the real script**, sourced out of `scripts/checks/`, never a patched copy — a
shadow copy of a gate is a gate nobody has tested. That needed the trailing entrypoint guarded:

```bash
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
```

`BASH_SOURCE` vs `$0`, deliberately, and **not** an environment variable: no env var can make an
executed `preflight-deploy.sh` skip its checks and exit 0. Executed, `$0` is the script path and the
gate runs; sourced, `$0` is the caller and only the functions are defined. Verified both ways — the
live run in §4 is the executed path, all eight fixture cases are the sourced path.

## 4. The live run — C1 now fails for the true reason

`bash scripts/checks/preflight-deploy.sh` at `6958f5f`, C1 section verbatim:

```
### C1 — every lane's final verdict is PASS ###
  (caller run 66325073-9579-47e6-ade7-a1ae033efbdd — reviewer rows pointing at it are skipped, never judged)
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: SKIP round 18 (task 6d92b80e-…, status=pending) — never run, no run_id ('Phase 7 GATE — …')
  main: SKIP round 16 (task ea8360e4-…, status=pending) — never run, no run_id ('Re-review after fix cycle 1')
  main: NEEDS_FIXES (round 14, task 4b9e9a75-…, 'Phase 7 pre-deploy gate — …')
FAIL — C1 — every lane's final verdict is PASS: main=NEEDS_FIXES (2 row(s) skipped)
```

C2/C3/C4/C5 are PASS; the script exits 1 on C1 alone.

**Read this carefully, because it is the point.** The preflight still exits 1 — and that is now
*correct*, not broken. It no longer says `main=not-yet-run` about a gate scheduled two rounds in the
future; it says `main=NEEDS_FIXES` about the round-14 verdict this very fix cycle exists to close.
The row it names is real, open, and at the top of this file. When the round-16 re-review runs and
returns PASS, that row becomes the newest run one and C1 goes green with round 18 skipped — which is
fixture case 2, run and asserted below. **No task should read this exit 1 as "the fix did not
land".**

## 5. The forced-failure fixture

`scripts/checks/fixtures/preflight-c1-fixture.sh`, no arguments, ~20s. Isolation: a per-run scratch
Postgres database named `preflight_c1_fixture_<pid>_<epoch>` (created, then dropped at exit, and only
ever by that prefix — the script aborts if the name resolves to `content_forge`), and a throwaway
`python3 -m http.server` on a free port serving the fixture task graph at
`/api/projects/<the real project id>`, with `FORGE_CONTROL_API` pointed at it. The live forge-control
API and the live `content_forge` DB are never read. Nothing is written to the repo or
`/opt/forge-ai-os`.

Five of the eight cases are failures. Verbatim:

```
fixture subject : …/scripts/checks/preflight-deploy.sh
subject sha256  : 5afa546acfc86352e38e332e3bbaad53a24a152ab44c93bf354ae84006323329
scratch database: preflight_c1_fixture_2892207_1787178932
fixture API     : http://127.0.0.1:33223

── the eight cases ──────────────────────────────────────────────────────
  ok   — unrun re-review does not launder a NEEDS_FIXES (C1 FAIL, as expected)
  ok   — cleared blocker + pending post-deploy gate passes (C1 PASS, as expected)
  ok   — post-deploy gate running its own preflight (C1 PASS, as expected)
  ok   — a foreign reviewer still in flight is skipped (C1 PASS, as expected)
  ok   — a reviewer that ended without a VERDICT blocks (C1 FAIL, as expected)
  ok   — no reviewer has ever run for a workstream (C1 FAIL, as expected)
  ok   — a NEEDS_FIXES sibling at the same round still blocks (C1 FAIL, as expected)
  ok   — every reviewer row [MERGED] is still no-reviewer (C1 FAIL, as expected)

────────────────────────────────────────────────────────────────────────
FIXTURE: 8 cases — 8 as expected, 0 wrong
FIXTURE: PASS
```

Cases 2, 3 and 4 are the three points the gate named as unsatisfiable, each asserted to PASS now.
Cases 1, 5, 6, 7 and 8 are the teeth. Every case asserts on **needle strings in C1's output**, not
only on the pass/fail bit — a case that reaches the right verdict by the wrong route is reported
`BAD`, which is what makes §6 discriminating.

## 6. Mutation controls — the fixture is not inert

A fixture that only ever runs against the fixed script proves nothing. Each of the four rules above
was removed in turn, in a scratch copy of the tree (the worktree file's sha256 was re-checked
afterwards and is unchanged), and the fixture re-run against the mutant:

| Mutation | Cases that go `BAD` |
|---|---|
| **A** — rule 1 removed (never-run rows are judged) | 1, 2, 6, 7 → `4 wrong` |
| **B** — rule 2 removed (the caller judges itself) | 3 → `1 wrong` |
| **C** — the in-flight skip made unconditional | 5 → `1 wrong` |
| **D** — the round-band collapsed back to a single row | 1, 2, 3, 4, 7 → `5 wrong` |

Each mutation was verified to have actually applied (a mutation that does not change the file aborts
the control) and to change exactly one line. Note that under A, D and B several cases keep the right
pass/fail bit and are still reported `BAD` — the needle assertions catch the wrong reason. Mutation C
is the important one: without the lifecycle-status condition, "a reviewer that ended without a
VERDICT blocks" flips to PASS, which is precisely the hole a careless reading of rule 3 would open.

## 7. What this fix cycle did NOT do

- **No change to the integrated tree.** The gate said so explicitly and it was true: not one file of
  `forge-control`, `forge-control-web` or any lane's work was touched. The diff is one gate script,
  one new fixture, and two documents.
- **The gate-6 red is not re-adjudicated.** It is accepted and recorded in the round-14 review above
  and in `03-quality.md` §3.1; nothing here changes it.
- **No verdict was written for `main`.** That is round 16's job. This section is a builder's report,
  and it deliberately does not contain the string that a verdict grep would match.

## 8. Undeclared writes, disclosed

This task's declared write-set is **`docs/plan/artifacts/os-usable-for-work/phase7/pre-deploy-gate.md`
alone** — the round-14 reviewer's artefact, inherited by the fix-cycle row (`fixChainGraphFields()`
unions the *gating reviewers'* write-sets, and reviewers declare none by design). Satisfying it
literally would mean writing nothing but this file, and the blocker cannot be fixed that way. Three
files outside it changed, all tabled in `04-phases.md` §10 in the same commit:

| File | Why |
|---|---|
| `scripts/checks/preflight-deploy.sh` | the blocker itself — the gate ordered this exact file changed |
| `scripts/checks/fixtures/preflight-c1-fixture.sh` | the gate ordered a forced-failure fixture; a fixture that is not committed cannot be re-run by round 16 |
| `docs/plan/os-usable-for-work/04-phases.md` | standing rule 5: an undeclared write is disclosed at the site **and** in §10, in the same commit |
| `docs/plan/artifacts/os-usable-for-work/phase7/preflight-evidence.md` | §2's C1 forced-failure demo describes the old selection and patches a `main "$@"` line that no longer exists; left alone it would read as current. Marked superseded, four sentences, nothing deleted |
