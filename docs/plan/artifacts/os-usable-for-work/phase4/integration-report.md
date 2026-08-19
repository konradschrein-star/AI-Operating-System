# phase4/integration-report.md — MERGE 3 of 3: the connections lane, and the six folded items

Integrator: I4, workstream `main`, branch `project/7851068b`, worktree
`/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`.
Merge 3 of a single-session three-lane integration (perf → business → **connections**).

**Outcome: MERGED CLEAN.** Merge commit **`7b2dd77`**.

---

## 0. HEADLINE

| | |
|---|---|
| Lane branch | `project/7851068b-connections`, tip `0c65e35`, 20 commits |
| Target tip before this merge | `7652d81` (carrying merges 1 and 2) |
| Conflicts | **none** — `git diff --name-only --diff-filter=U` empty |
| Merge commit | **`7b2dd77`**, 53 paths (22 source, 31 artefacts) |
| forge-control tsc / tests | exit 0 / **1476 pass, 0 fail** (1404 before — +72) |
| forge-control-web tsc | exit 0 |
| `gates-808.sh --strict` | EXIT=1, **RED: 1 — gate 6 only, identical to merges 1 and 2. This merge introduced NO new red.** |
| Lane harnesses at the merged tip | `check-connection-states.ts` ALL PASS · `check-quota-row.ts` ALL PASS · `check-integrations.tsx` PASS · `check-settings-surface.tsx` PASS |

**Of the six items folded onto this task, two were already done, one was refuted as a build break,
and three were executed.** Details in §4–§9. The pattern is worth naming: this brief's
"KNOWN, DO NOT REDISCOVER" section was, in three of five claims, out of date. Re-measuring each took
minutes; acting on any of them unverified would have cost a cycle or broken the build.

---

## 1. THE PRECONDITION — the gate artefact says NEEDS_FIXES and is two fix cycles stale

Step 1 of my brief: *"Read phase4/gate-report.md on the connections branch. If the gating reviewer
issued `VERDICT: NEEDS_FIXES`, DO NOT MERGE."* It does say that:

```
**VERDICT: NEEDS_FIXES.** Three blockers, listed in §7.
```

Taken literally that refuses the merge. It is stale. Reconstructed from run windows and commit
timestamps rather than from task titles or task status:

| UTC | what |
|---|---|
| 2026-08-18 22:13:44 | `07f1c4b` — R4-gate commits **NEEDS_FIXES**, three blockers |
| 22:39 – 23:13 | fix cycle 1 (rounds 4–5): `04c79b1`, `dc7bd5a`, `e0a721f`, `6a1fa33` |
| 23:14:12 – 23:23:29 | re-review task `bf73f43f` → **NEEDS_FIXES** (still open) |
| 23:37 – 23:49 | more of fix cycle 1 (round 5): `3c5a6c8`, `d3fe3d1`, `5ef6286`, `4b31971`, `ce742f9` |
| **23:45:04 – 00:16:04** | **fix cycle 2**, task `e06343a6`, run `15cddfa0` |
| 00:10:05 / 00:11:59 / 00:12:58 | `28c12c1`, `b35f043`, **`0c65e35`** land inside that window — the current tip |
| **00:16:54 – 00:23:06** | re-review task `2c112799`, run `eedec96a` — **began after the tip existed** |
| 00:23:06 | its last assistant message: **`VERDICT: PASS`** |

Cleared to merge.

**A trap worth recording.** The PASS covering fix cycle 2 is filed under a task *titled* "Re-review
after fix cycle **1**". The row that was titled "Re-review after fix cycle 2" (`832fdfdc`) is marked
`[RETIRED/FOLDED into rereview:connections:4:1]` and has **no run at all** — querying it returns
nothing, which reads exactly like a reviewer that never answered. Titles did not settle this; the run
windows did. Had I gated on the row named for fix cycle 2 I would have concluded there was no verdict.

Verdicts were read as the **LAST assistant message** of each run, never by grepping the thread — every
reviewer's brief quotes both verdict strings, so a whole-thread regex marks every reviewer as both.

## 2. THE MERGE

```
$ git merge-tree --write-tree --name-only HEAD project/7851068b-connections   # re-probed at 7652d81
probe exit=0

$ git status --short                          # clean
$ git log --oneline -1 project/7851068b-connections
0c65e35 docs(phase 4/round 6): the scanner recommendation was overruled before this round wrote it

$ git merge --no-commit --no-ff project/7851068b-connections
Automatic merge went well; stopped before committing as requested
merge exit=0

$ git diff --name-only --diff-filter=U        # EMPTY — no conflicts
$ git commit ...                              # 7b2dd77
```

22 source files came in:

```
forge-control-web/app/api-connections.ts              forge-control/src/lib/account-health.test.ts
forge-control-web/app/desktop/quota/geminiLine.ts     forge-control/src/lib/account-health.ts
forge-control-web/app/desktop/quota/quotaQuery.ts     forge-control/src/lib/connection-status.test.ts
forge-control-web/app/desktop/settings/ConnectionsPanel.tsx   forge-control/src/lib/connection-status.ts
forge-control-web/app/desktop/settings/accountRegistry.tsx    forge-control/src/lib/cron-tick.ts
forge-control-web/app/desktop/settings/connections.ts         forge-control/src/routes/accounts.ts
forge-control-web/app/desktop/settings/integrationCards.tsx   forge-control/src/routes/integrations.ts
scripts/checks/check-connection-states.ts             forge-control/src/routes/usage.ts
scripts/checks/check-gemini-tally.ts                  scripts/checks/check-integrations.tsx
scripts/checks/check-quota-row.ts                     scripts/checks/check-secret-scan.ts
scripts/checks/check-settings-surface.tsx             scripts/checks/serve-quota-7799.ts
```

Six are outside my declared write-set and arrived because a merge writes everything its parent
carried — disclosed in §10.

## 3. THE UNIVERSAL BLOCK, AND THE GATE SUITE

Always `--prod=false` (`NODE_ENV=production` is exported here; a bare `--frozen-lockfile` prunes
devDependencies, exits 0, deletes `typescript`, and the typecheck then dies with `tsc: not found`
behind a clean-looking install). `typescript` was neither added nor removed in any of the three
installs.

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false   # Already up to date
$ npx tsc --noEmit                                                  # exit 0
$ pnpm test
# tests 1476 / # suites 274 / # pass 1476 / # fail 0
$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
$ npx tsc --noEmit                                                  # exit 0
$ cd .. && bash scripts/checks/gates-808.sh --strict                # Bash timeout 600000
EXIT=1 ... 6  1  forbidden-file diff ... RED: 1
```

**The test count across the whole session — 1293 → 1347 → 1404 → 1476.** Each step is the merged
lane's own suites actually executing (+54 perf, +57 business, +72 connections). A merge that carried
files but not behaviour would have left the number flat.

**The one red is gate 6, on `forge-control/src/db/projects.ts`, which is a PERF-lane file
(`27faa28`)** — byte-identical to the red after merges 1 and 2, adjudicated and ACCEPTED by the
phase-6 gate before it issued PASS (quoted in `phase6/integration-perf.md §5.4`). Neither business nor
connections nor my own edits added a red. Transcripts: `phase6/gates-baseline-premerge.txt` (RED 0,
pre-merge), `phase6/gates-after-merge-perf.txt`, `phase5/gates-after-merge-business.txt`,
`phase4/gates-after-merge-connections.txt` (this one, final, with my edits in place).

### 3.1 The lane's own harnesses, re-run at the merged tip

A merge is exactly where a lane's checks stop being about the lane, so all four were re-run here:

```
check-connection-states.ts   ALL PASS — 4 integrations × 5 states + the failed READ over all five rows
check-quota-row.ts           ALL PASS — round 1876 quota row + connections
check-integrations.tsx       PASS
check-settings-surface.tsx   PASS
```

The two `.tsx` checks first failed with `Cannot find module 'react-dom/server'`. **That was my
invocation, not a regression:** each file's header names its own run line, and they must be run from
`forge-control-web` (whose `node_modules` holds react) with the checks tsconfig —
`../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/<f>`.
Recorded because "the check errored" and "the code broke" look identical for about a minute.

---

## 4. FOLDED ITEM 1 — the `brief` field in `api.ts`. DONE, BUT NOT AS INSTRUCTED, AND THE DIFFERENCE IS A BUILD BREAK

The instruction: *"`fetchProjectBoard()` still declares `brief: string` — the endpoint no longer sends
it. Zero callers today… **Delete the field.** If anything does consume it by the time you get there,
say so instead."*

I measured before deleting, and the literal instruction is unsafe. `brief: string` is **not** a field
of `fetchProjectBoard`; it is a field of `interface ProjectTask` (`api.ts:1303`), and that interface's
own doc comment states what it mirrors:

> One row of `project_tasks`, as `GET /api/projects/:id` **and** `GET /api/projects/board` serve it.

Only the **board** stopped sending `brief`. The other endpoints still send it, and it is read:

```
$ grep -rn "\.brief\b" forge-control-web/app/
app/api-perf.ts:74   if (typeof r.task?.brief !== "string") {
app/api-perf.ts:81   return r.task.brief;          # fetchTaskBrief, over GET /api/tasks/:id
```

**Deleting the field would have broken `fetchTaskBrief` and the one pane that renders a brief.** That
is precisely the "say so instead" branch — except the consumer is not on the board endpoint, so it
does not mean the endpoint regressed; it means the field is shared by three endpoints and only one
dropped it.

What I did instead, which removes the over-promise without touching the shared type: **deleted the
dead `fetchProjectBoard` function.** Proof it was dead, repo-wide, before deleting:

```
$ grep -rn "fetchProjectBoard\b" --include=*.ts --include=*.tsx . | grep -v node_modules | grep -v '^./docs/'
./forge-control-web/app/api.ts:1352:export const fetchProjectBoard = ...      # the definition
./forge-control-web/app/api-perf.ts:16: * `api.ts` exports `fetchProjectBoard` ...   # a comment
```

One definition, one comment, zero calls. `ProjectsSurface` moved to `fetchProjectBoardCards`
(`api-perf.ts`), typed `Omit<ProjectTaskWithProject, "brief">`, which matches what the server sends
(`db/projects.ts:368 listActiveTasks(): Promise<ProjectBoardTask[]>`). And this was the disposal the
perf lane itself asked for — `api-perf.ts:19`, before my edit:

> this lane may not edit `api.ts` to remove it; **whoever next owns that file should delete it.**

A comment block replaces it in `api.ts` recording why the function went and why the field stayed;
`api-perf.ts`'s note is updated from a request to a discharge. `ProjectTaskWithProject` survives —
`api-perf.ts:55` still derives from it. `npx tsc --noEmit` exit 0 in both packages afterwards.

## 5. FOLDED ITEM 2 — the fonts behind the auth wall. DONE, MEASURED IN BOTH DIRECTIONS, AND I TIGHTENED IT

The filing: `middleware.ts:21`'s matcher excludes only `_next/static|_next/image|favicon.ico`, so
`curl /fonts/inter-variable-latin.woff2` returns **307** to `/signin`. Fix: add `|fonts`. Verify by
curling the woff2 **unauthenticated** and getting 200.

**First measurement, and it changes the shape of the job: `public/fonts/` does not exist on this
branch.** There is no `public/` directory at all here. The self-hosted faces live only on
`project/7851068b-vault`, which is not one of my three lanes and is not merged:

```
$ git ls-tree -r --name-only project/7851068b-vault | grep -i "woff\|fonts/"
forge-control-web/public/fonts/LICENSE.md
forge-control-web/public/fonts/inter-variable-latin.woff2
forge-control-web/public/fonts/jetbrains-mono-variable-latin.woff2
forge-control-web/public/fonts/material-symbols-outlined.woff2
```

So the briefed verification — curl the real woff2 — is not runnable at this tip, and shipping the
one-word change unverified is the thing this project exists to stop. I built a **canary** instead:
`public/fonts/probe-canary.woff2`, 34 bytes, containing the merge sha so the response could not be
confused with anything else. Untracked, and removed afterwards.

**Negative control first, on the UNFIXED middleware** — because a fix whose "before" was never
measured is a guess, and because a broken harness (an unset `AUTH_SECRET` makes the wall fail open and
turns everything into a 200) is indistinguishable from a working fix:

```
# built and served from the worktree on :7788, AUTH_SECRET set
GET /fonts/probe-canary.woff2 -> 307 location=.../signin      <- the defect, reproduced
GET /desktop                  -> 307 location=.../signin      <- the wall is genuinely up
GET /signin                   -> 200
```

**After adding `fonts` to the matcher, rebuilt and re-served:**

```
GET /fonts/probe-canary.woff2 -> 200 bytes=34
  body: wOF2CANARY-not-a-real-font-7b2dd77                    <- my file, at my tip
GET /desktop /  /settings /api/proxy/today -> 307 each, all to /signin
GET /signin -> 200
```

### 5.1 My own probe found a hole the filing did not name, so the shipped pattern is not the one filed

I also asked whether a path that merely *starts* with those five letters is now public:

```
GET /fontsecret-probe -> 404          # NOT 307 — middleware did not run on it
```

A bare `fonts` in a negative lookahead is a **prefix, not a directory**. `|fonts` would silently make
every future route whose name begins with "fonts" unauthenticated. The shipped matcher is therefore
`fonts/` **with the slash**:

```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
```

Re-measured on a third build, all four assertions at once:

```
GET /fonts/probe-canary.woff2  -> 200      (the fix still works)
GET /fontsecret-probe          -> 307      (the hole is closed)
GET /desktop / /settings /api/proxy/today -> 307 each
GET /signin                    -> 200
```

Then the canary was deleted and `public/` removed; `git status --short` shows only `middleware.ts`.

**Consequence for the vault lane:** the moment `project/7851068b-vault` merges, its real woff2 files
are served unauthenticated with no further change. Nothing there needs to be redone, and nobody needs
to re-litigate the matcher.

## 6. FOLDED ITEM 3 — the three "dead exports". **REFUTED. I DELETED NOTHING, AND DELETING THEM WOULD HAVE BROKEN THE BUILD**

The filing: *"`api.ts` now carries three exports that nothing imports any more — `fetchMemoryCounts`,
`KnowledgeGraphData`, `fetchMemoryGraph`. Safe to delete here, in ONE commit… **Prove the claim before
acting on it**: grep the whole web app for each symbol and paste the empty result."*

I ran exactly that grep. **The result is not empty.**

```
$ grep -rn "\bfetchMemoryCounts\b" app/
app/api.ts:468:export const fetchMemoryCounts = async (
app/desktop/MemorySurface.tsx:8:  fetchMemoryCounts,
app/desktop/MemorySurface.tsx:72:    queryFn: () => fetchMemoryCounts(source),

$ grep -rn "\bfetchMemoryGraph\b" app/
app/api.ts:519:export const fetchMemoryGraph = async (): Promise<KnowledgeGraphData> =>
app/desktop/MemoryGraph3D.tsx:18:import { fetchMemoryGraph, type GraphNode } from "../api";
app/desktop/MemoryGraph3D.tsx:44:    queryFn: fetchMemoryGraph,

$ grep -rn "\bKnowledgeGraphData\b" app/
app/api.ts:514:export interface KnowledgeGraphData {
app/api.ts:519,520   # the return type of fetchMemoryGraph, which is live
```

Two of the three have live importers; the third is the return type of one of them. All three
deletions are build breaks. **Nothing was deleted.**

I checked whether the claim was at least true on the lane that filed it. It is not:

```
$ git grep -n "fetchMemoryCounts\|fetchMemoryGraph" project/7851068b-surfaces -- forge-control-web/app
project/7851068b-surfaces:...MemorySurface.tsx:8,72
project/7851068b-surfaces:...MemoryGraph3D.tsx:18,44
```

`MemorySurface.tsx` and `MemoryGraph3D.tsx` are at the same commit (`dcd0cb1`) on both branches — the
consumers were never removed anywhere. The filing was simply mistaken, not merely stale.

This is the branch the filing itself anticipated: *"A dead export that turns out to have one caller is
a build break at integration, and this is the last place that would be caught cheaply."* It had two.
The instruction to prove before acting is what caught it, and it is the reason this section exists
instead of a revert.

## 7. FOLDED ITEM 4 — gate 17. **GREEN AT EVERY TIP I MEASURED. Adjudicated in writing, as required**

The brief devotes a section to gate 17 going red at merge: *"`verify-notification-gap-pins.mjs` was
`ALL PASS 92/92` on its lane and shows 20 FAILURES after main merges in… GATE 17 WILL BE RED WHEN YOU
MERGE, AND IT IS NOT YOUR DOING."*

**It never went red.** Measured, not assumed, at four tips:

| tip | what it is | gate 17 |
|---|---|---|
| `5c8b3e3` | pre-merge baseline, before any lane merged | **0 — green**, 92/92 |
| `3330996` | after merge 1 (perf) | **0 — green** |
| `6dde6bd` | after merge 2 (business) | **0 — green** |
| `7b2dd77` + my edits | final | **0 — green** |

**Adjudication, which the brief requires in writing rather than as a silent pass.** The predicted
failure mode is real and correctly described — the verifier pins document lines by `^`-anchored
context regexes, so any commit that inserts lines above a pin orphans it, and the verifier exists only
on lane branches, so `main` has never run it. What the prediction got wrong is its trigger: the two
commits blamed (`6a9406d`, `1e0330b`) are on **`main`**, and this integration **does not merge
`main`** — it merges three lane branches into `project/7851068b`, whose relationship to those commits
is unchanged by anything I did. The red the brief predicted belongs to whichever task next merges
`main` into a lane, or a lane into `main` — phase 7's deploy, not phase 4–6's integration.

So there is **no red here to accept or fix**, and I did not re-anchor the pins. **The underlying
fragility is not closed, and I am filing it rather than silently leaving it**, exactly as the brief's
escape hatch allows ("If re-anchoring is more than this task should carry, say so and file it"):

> **FILED — gate 17 re-anchoring.** `verify-notification-gap-pins.mjs` pins by line-anchored context
> regex, and lives only on lane branches. It will go red at the first merge that moves lines in
> `docs/plan/notification-gap.md` or brings `main`'s history into a lane — most likely phase 7. The
> operator ruling (`AI OS/Operator Decisions.md`, "where a doc-gate lives") prescribes two steps:
> re-anchor the pins on symbols or fenced content rather than line numbers, then move the verifier to
> where its subjects live or narrow its subject to files one lane owns. Bumping the numbers buys
> exactly one merge. **Phase 7 should do this before it merges `main`, not after it sees the red.**

## 8. FOLDED ITEM 5 — `AgyCard` / `GitHubCard`. **ALREADY MOUNTED. I added nothing**

The brief, under "KNOWN, DO NOT REDISCOVER": *"`AgyCard` and `GitHubCard` are built, tested and
**unreachable** — `ConnectionsPanel.tsx` mounts only claude/google/gemini-key/gemini-ultra. They need
two `<Row summary={agyConnection(...)}><AgyCard/></Row>` blocks, ~6 lines."*

**Stale.** That was R4-gate's blocker 1 and fix cycle 1 closed it at `04c79b1` ("one binary, one
verdict — the agy row is on the screen"). At the merged tip:

```
$ grep -n "<Row\|<AgyCard\|<GitHubCard" app/desktop/settings/ConnectionsPanel.tsx
217:  <Row summary={googleConnection(google)}
229:  <Row summary={geminiKeyConnection(
241:  <Row summary={ultraConnection(quota.data?.gemini, agy)}
281:  <Row summary={agySummary}      287:    <AgyCard onFacts={setAgy} />
294:  <Row summary={githubSummary}   300:    <GitHubCard onFacts={setGithub} />
```

with the panel's own comment recording the history:

> THE agy ROW. R53/R54 lived in `AgyCard` for a whole phase without a mount point, which made them
> unreachable on the only surface Konrad opens — R4-gate blocker 1.

**Adding the briefed ~6 lines would have mounted both cards twice.** `check-integrations.tsx` and
`check-quota-row.ts` both PASS at the merged tip (§3.1), including *"one connections panel, two entry
points"* — which is the assertion a double mount would have broken.

## 9. FOLDED ITEM 6 — the GOALS hunk. **OUT OF SCOPE: it belongs to a lane this task does not merge**

The brief calls this *"the single highest-risk hunk in the whole integration… the one place where a
merge can silently delete a feature Konrad built and uses"*, and requires four checks that `main`'s
`GoalsSurface` survives into the merged `DesktopApp.tsx`.

**None of it applies to these three merges, and I want that stated plainly rather than ticked off.**

```
$ git merge-base --is-ancestor 553fa38 project/7851068b      # main's GoalsSurface commit
NO
$ git ls-tree -r --name-only project/7851068b | grep -i goals
(nothing)
```

`GoalsSurface.tsx` does not exist on this branch at all, and neither `DesktopApp.tsx` nor
`nav-items.ts` is touched by perf, business or connections — the three lanes' complete source
footprint is listed in §2 and in the two sibling reports. The risk is real but it lives in **the
surfaces lane merge and/or the `main` merge**, neither of which is this task. There is nothing here
for me to protect, and performing the four checks against a tree that has no GOALS surface would
produce four green ticks that mean nothing.

**Escalated to the manager chat** so it lands on an owner rather than being closed by this report.
Its sharpest form: **none of the five lanes was merged before today.** `perf`, `business` and
`connections` are in as of this session; **`surfaces` and `vault` are still out**, each ~17 and ~22
commits ahead. Whoever takes those two owns the GOALS hunk, the `check-phase3-placeholders.ts`
three-unbuilt-keys assertion, and the real woff2 files that §5 has already cleared the path for.

---

## 10. WRITE-SET DISCLOSURE — LOUDLY

### 10.1 Files I authored or edited that are NOT on my declared write-set

Two, both source, both required by items folded onto this task by its own brief:

| path | why it had to change | authority |
|---|---|---|
| `forge-control-web/app/api.ts` | Item 1 (§4) — delete the dead `fetchProjectBoard`, whose return type over-promises `brief`. My brief explicitly assigns this file to me ("The perf lane could not touch `api.ts` — one client file per lane — so it belongs to you as the integrator"), but the path was never added to the declaration. | brief 3/3, "a two-line deletion in `api.ts`, folded here" |
| `forge-control-web/middleware.ts` | Item 2 (§5) — the auth matcher put `public/fonts` behind the sign-in wall. Likewise assigned in prose ("`middleware.ts` belongs to this integration, not the vault lane") and likewise absent from the declaration. | brief 3/3, "ONE-LINE FIX FILED BY B2c" |

A third, and it is the disclosure mechanism itself: **`docs/plan/os-usable-for-work/04-phases.md`**,
also undeclared. Disclosing an undeclared write in a commit message and an artefact is only half the
rule — the phase record must move in the **same commit**, so the append to its "Undeclared writes,
disclosed" section is not optional and could not be deferred to a task that has that path declared.

`forge-control-web/app/api-perf.ts` was also edited (its comment asking a future owner to delete
`fetchProjectBoard` is now a record that it happened) — that one **is** on the declared write-set.

This is the same engine defect `04-phases.md` §"Undeclared writes, disclosed" already documents three
turns of: a row is seeded with a declaration that does not include the files its own brief instructs
it to change. Per the operator ruling recorded there, the task row is **not** amended — `write_set`
records what a task declared, the commit records what it wrote, and the gap between them is the only
signal a collision happened. Disclosed here, in `04-phases.md`, and in the commit message.

### 10.2 Paths that entered by merge

The three merge commits write every path their lane parents carried; my brief acknowledges this
("Your write_set is the UNION of theirs because a merge writes all of them"). Those outside my
declaration, named so the reviewer's comparison finds them disclosed:

- **from business (`6dde6bd`)** — `phase0/S-C-content-forge-state.md`, `docs/plan/artifacts/phase400/dollar-allowlist.md`,
  `docs/research/round-499-f5bbf4c8.md`, `scripts/checks/dollar-allowlist.txt`
- **from connections (`7b2dd77`)** — `forge-control-web/app/desktop/quota/geminiLine.ts`,
  `forge-control-web/app/desktop/quota/quotaQuery.ts`, `forge-control/src/routes/usage.ts`,
  `scripts/checks/check-gemini-tally.ts`, `scripts/checks/check-secret-scan.ts`,
  `scripts/checks/serve-quota-7799.ts`, plus the lane's `fix-cycle-*`, `gates-round*.txt`,
  `r4fix-*`, `r5-*` and `r6-*` artefacts
- **from perf (`3330996`)** — none; all 13 source paths were declared

I edited none of these. `scripts/checks/dollar-allowlist.txt` and `check-secret-scan.ts` are the two
with executable consequence (gates 8 and the secret scan); both are **green** in the final run.

## 11. BOUNDARIES OBSERVED

- Merged into `project/7851068b` only — **not** `main`, **no deploy**, no push, no PR. Phase 7 owns
  the deploy and has a detached procedure I did not pre-empt.
- **No `pm2 restart` of anything**, least of all `forge-executor`.
- `/opt/forge-ai-os` never touched. Verified clean at `9c3f63a` at the start of the run
  (`git status --porcelain` empty) — see `phase6/integration-perf.md §8`; brief 1/3's
  commit-in-place ruling was already discharged by an earlier round.
- `content_forge` read-only — `select`s against `runs`/`project_tasks` to recover verdicts, nothing
  else. No writes, no Content Forge worker restarted.
- The throwaway server in §5 ran from **this worktree** on port 7788 and was stopped by PID; it never
  touched the live app on its own port.
- No lane's code was "improved" while merging it. The two edits in §4 and §5 are folded items this
  brief assigned to the integrator by name, not opportunistic cleanup, and each was verified in both
  directions.
