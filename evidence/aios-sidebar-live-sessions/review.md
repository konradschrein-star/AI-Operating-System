# aios-sidebar-live-sessions — round 4 review (T6: server + client + after-evidence)

**Tip reviewed:** `bce734c0b298070301a4725048cd375796deb2db` on `project/fb3b5fb2`
(`git rev-parse HEAD`, run in this worktree at 2026-08-25 ~07:20–07:40 UTC, re-read
immediately before this verdict — unmoved).
**Diff reviewed:** `git diff main...HEAD`, merge-base `d0b5393`, local `main` =
`259778b`. 17 files, +2716/−161.
**Scope:** T3 (server), T4 (client), T5 (after-evidence). The scope toggle (T7) and its
reviewer (T8) are a separate, disjoint increment and are **not** reviewed here — no
`ChatSurface.tsx`, `sidebar-scope.ts` or `pollBudget.ts` change is in this diff.

**Verdict: NEEDS_FIXES** — 5 findings. None of them is a defect in the reviewed code.
The engineering in this diff is correct: all ten claims the plan makes were checked
against the code and all ten hold. The blockers are the live checkout's dirt (which is
mandatory to report and contains one sole-copy live fix that must NOT be reverted) and
three write-set / evidence-integrity gaps.

---

## Gates

**Suite:** `scripts/checks/gates-808.sh` — the repo's committed suite, run as
`bash scripts/checks/gates-808.sh --strict` from this worktree at
HEAD `bce734c`, after `cd forge-control && pnpm install --frozen-lockfile --prod=false`
(exit 0). Full log: `/tmp/gates-fb3b5fb2.log` (30 KB, read in full, not tailed).

**Quality document:** `docs/plan/03-quality.md` (the pre-per-project-layout path).
`docs/plan/aios-sidebar-live-sessions/03-quality.md` does **not** exist — I checked both
paths, as instructed. The doc's own command block (`pnpm test` =
`tsx --test src/lib/*.test.ts`; `npx tsc --noEmit`; `pnpm install --prod=false`) is
executed inside the suite as gates 1, 2 and 23, so it is covered rather than skipped.

```
 GATE EXIT  NAME
  1  0      npx tsc --noEmit — forge-control
  2  0      npx tsc --noEmit — forge-control-web
  3  0      NODE_ENV=production pnpm build — forge-control-web
  4  0      check-instrument-typecheck.sh
  5  0      check-secret-scan.ts
  6  0      check-classify.ts
  7  0      forge-control/ untouched by round 808's own commits
  8  0      check-migration-numbers.ts
  9  0      dollar-sweep.sh
 10  0      check-composer-v3.ts
 11  0      check-secret-requests.ts
 12  0      contrast-canvas-banners.cjs
 13  0      check-working-sql-agreement.ts — standalone typecheck
 14  0      check-stop-affordance.tsx — the ⏸ button
 15  0      check-dismiss-peek.tsx — the way back out of a dismissal
 16  0      check-team-rows.ts — flatten, hiddenRows, frozen time
 17  0      check-team-confirm.ts — ✕ / stop / restore-all machines
 18  0      check-live-sessions.ts — live predicate, badge map, degrade rules   ← NEW
 19  0      check-deep-link.ts
 20  0      verify-notification-gap-pins.mjs
 21  0      check-usage-fold.ts — against a real Postgres
 22  0      check-usage-fold.ts — standalone typecheck
 23  0      pnpm test — forge-control unit suite
 24  0      psql-argv-leak.cjs
 25  0      nav-walk-sampling.cjs
 26  -      phase700/network-700.cjs (NFU3)              SKIPPED (harness not up)
 27  -      phase600/nav-walk.cjs — P1/P2/P3             SKIPPED (harness not up)
 28  0      reproduce-cleanliness

 RED: 0        GATES_EXIT=0
```

**28 gates in the suite: 26 EXECUTED, 0 RED, 2 SKIPPED-by-design** (the two browser
gates, which require the phase-800 isolated-API harness; they are labelled SKIPPED by the
suite itself, not silently omitted). Nothing was allowlisted, widened or softened for this
run.

Notable individual results:
- gate 23 — `# tests 2138 / # pass 2138 / # fail 0`. `team-live.test.ts` lives in
  `src/lib/`, which is exactly the glob `pnpm test` uses, so its 9 tests really run.
- gate 18 (new) — `80 passed, 0 failed` / `check-live-sessions: PASS`.
- gate 15 — `check-dismiss-peek.tsx` green *with* its `element()` slicer rewritten in this
  diff. I verified the rewrite is a real fix and not a loosening: `gate_sh` wraps every
  body in `bash -c "set -o pipefail; …"`, so a `| tail -2` cannot swallow a nonzero exit.

---

## The ten claims, checked

| # | Claim | Verdict |
|---|---|---|
| 1 | Badge derived from the MODEL via `engineForModel`; `metadata.engine` read nowhere | **HOLDS** |
| 2 | Unknown/empty model ships `engine: null` → em dash, not a defaulted claude badge; departure implemented and commented | **HOLDS** |
| 3 | No codex badge anywhere | **HOLDS** |
| 4 | `activity` only on non-settled nodes, text truncated to a named cap | **HOLDS** |
| 5 | No new poll, no new endpoint; client reads the cached `TeamResponse`; 40 req/min ceiling intact | **HOLDS** |
| 6 | Nothing silently falls back — three cells + absent-field degradation | **HOLDS** |
| 7 | Tree behaviour intact (dismissals, cascade ✕, stop/terminate, peek) and `PLAN_FRACTION_KEY` drag still works, with a shot | **HOLDS** |
| 8 | Tests assert behaviour, not fixtures | **HOLDS** |
| 9 | Screenshots really taken, read back, from the worktree's build | **HOLDS on substance; the cited paths are wrong — finding 4** |
| 10 | before/after bytes/min real, browser-measured, flat or argued | **HOLDS — argued, and the argument is sound** |

Detail on the ones worth showing my work on:

**1 + 2.** `forge-control/src/routes/chat.ts:580` and `:610` both call
`badgeEngineForModel(sub.model)` / `badgeEngineForModel(run.model)`. Grep for
`metadata.engine` / `session_engine` across `forge-control/src/lib/team-live.ts` and the
whole of `forge-control-web/app/desktop/team/` returns **two hits, both inside comments**
(`engineBadge.ts:69`, `teamApi.ts:132`) explaining why the field is not read. The
departure from `engineForModel`'s claude default is implemented at
`team-live.ts:74-79` (`typeof !== "string"` → null; `trim() === ""` → null) and commented
at `team-live.ts:62-73` and again at the two call sites. It is asserted, not just
documented: `team-live.test.ts:32-40` pins `null`/`undefined`/`""`/`"   "` → `null`, all
four of which a bare `engineForModel(model)` would answer `"claude-code"`. That test
fails on the wrong implementation, which is the property that matters.

**3.** The only occurrences of "codex" in the diff are (a) Konrad's own quoted sentence in
two file headers, (b) the `THERE IS NO CODEX` header in `engineBadge.ts:10-17`, and (c)
`check-live-sessions.ts:280-300`, which uses `"codex"` as an *unknown-engine input* and
asserts it renders its own raw string, in `textMuted`, `known: false`, and specifically
that its label `!== "claude"`. `ENGINE_BADGE` has exactly two keys, asserted literally at
`check-live-sessions.ts:266-271`.

**4.** `projectActivity(src, {settled})` returns `null` on `settled` before touching
anything else (`team-live.ts:104`), and `capActivityText` clips at
`ACTIVITY_TEXT_CAP = 120` *including* the ellipsis (`team-live.ts:87-91`). Growth is
therefore (live count × 120 B), not (tree size × 120 B). The after-evidence measured the
marginal cost at **+408 B on a 10-node tree with 1 live node (+4.8 %)**, consistent with
the build task's own three samples (+311 B, +430 B, +772 B).

**5.** `git diff main...HEAD --stat -- forge-control-web/app/desktop/chat/pollBudget.ts`
is **empty** — the file is untouched, and `CHAT_SURFACE_REQ_PER_MIN_CEILING = 40`
(`pollBudget.ts:68`) is unchanged. `LiveSessionsStrip.tsx` contains no `useQuery`, no
`fetch`, and imports no fetcher from `teamApi` — it takes `data: TeamResponse | undefined`
as a prop from `ChatTeamPanel`'s existing query. Its only subscription is the shared
`useTick` store, and that subtree is mounted only when `countLiveSessions(data) > 0`
(`LiveSessionsStrip.tsx:470`), so a fully-settled chat costs zero timers. No new route was
added to `forge-control/src/routes/chat.ts` — the diff adds two optional fields to the
existing `TeamNode`.

**6.** All three, plus the absent-field case:
- unknown engine → `unknownEngine(engine)` renders `label: engine` (the raw string) in
  `textMuted` (`engineBadge.ts:89-100`);
- unnamed activity → `activityText` falls to `KIND_PHRASE[kind] ?? kind`
  (`liveSessions.ts:187-191`), never `""` — asserted over four kinds at
  `check-live-sessions.ts:428-433`, including a kind (`"compacting"`) the client has never
  seen. The age is rendered as its **own fixed-width sibling cell**
  (`LiveSessionsStrip.tsx:314-330`), which is the right fix for the failure the file's own
  comment describes (an ellipsising label eats the age exactly on the prose activities
  most likely to be stale);
- null elapsed → `fmtWorkingTime(null)` returns the em dash (`teamApi.ts:334`), asserted
  at `check-live-sessions.ts:486-495`;
- absent field (older API) → `engineFor`/`activityFor` distinguish `undefined`
  ("not-served") from `null` ("unknown") and render the em dash with *different tooltips*
  (`liveSessions.ts:135-157`), asserted at `check-live-sessions.ts:339-387`. Nothing
  crashes and nothing is fabricated.

**7.** Gates 14–17 (stop affordance, dismiss/peek, team rows, the destructive-control
machines) are all green at this tip, and `TeamRow.tsx` is not in the diff at all — the
strip is additive and holds no POST. The split: `ChatTeamPanel.tsx:838` still owns the
handle's parent with `flex:1, minHeight:0`, `:1093-1097` keeps `data-team-scroll` at
`flex:1, minHeight:0`, and the PLAN zone at `:1265` still reads
`flex: 0 0 ${planFraction*100}%` from `PLAN_FRACTION_KEY`. The new blocks sit above the
scroller as `flex:"none"` siblings, so they take space from the tree, not from PLAN.
Evidence: `after.md` capture 6 records `forge.layout.teamPlanFraction` going
`null → 0.28631394840402274 → 0.28631394840402274 after reload`, with three shots. I read
`…015947072Z-plan-split-after-drag-v2.png` back myself: it is a genuine, fully-hydrated
panel showing a bounded PROJECT switcher, LIVE SESSIONS with 2 rows, TEAM 10, and a
populated PLAN board.

**8.** No test in this diff imports a threshold from its subject and compares it to
itself. `team-live.test.ts:4-8` states the rule and follows it — every bound is a literal
(`120`, `119`, `"x".repeat(400)`), and `ACTIVITY_TEXT_CAP` appears exactly once, at
`:78`, as `assert.equal(ACTIVITY_TEXT_CAP, 120)` — a drift guard between the constant and
the literals, which is the legitimate use, not the inert one. `check-live-sessions.ts`
does not import `STATUS_RANK`; it asserts the ordering by naming the ids in the order they
must come out (`:198-202`). Several assertions are specifically shaped to fail on the
obvious wrong implementation (the four `badgeEngineForModel` null cases; "a settled node
shows no activity **even if the server shipped one**"; "a dismissed but running node is
still a live session").

**9 + 10.** See findings 4 and 5 below for the two gaps. On substance: the twelve PNGs
exist on disk under `/opt/ai-os/uploads/c7dcc38a9397/`, sized 69 KB–770 KB, timestamped
2026-08-25 03:57–03:59. I read two back myself (the mixed-engine money shot and the
after-drag split shot) and they are real renders of this feature, not placeholders — the
money shot shows `claude`/`opus-5` and `agy`/`gemini-3.7-flash-high` badged correctly in
the same frame, which is definition-of-done item 2. The chain in `after.md:24-35` is a
worktree-local `next start -p 7793` over this worktree's own routers; the live console was
not driven and nothing under `/opt/forge-ai-os` was built or restarted. The byte table is
browser-measured through the app's own React Query poll and the +67.3 % raw delta is
**not** rounded away — it is isolated (feature's own marginal cost +408 B / +4.8 %; the
other ~3,440 B is this chat's tree growing from ~4–5 to 10 nodes over ~26 h) and the
document states plainly that a cleaner re-baseline is owed next time. That is the honest
handling of a confounded measurement, not an excuse.

---

## Findings

### 1. BLOCKER — the live checkout `/opt/forge-ai-os` is dirty, and one of the changes is a SOLE COPY

Mandatory check, executed 2026-08-25 07:41 UTC (and again immediately before this verdict
— identical output):

```
$ git -C /opt/forge-ai-os status --porcelain
 M forge-control-web/app/desktop/ChatSurface.tsx
 M forge-control-web/app/desktop/chat/FileExplorerPanel.tsx
 M forge-control-web/app/desktop/chat/MessageMarkdown.tsx
 M forge-control-web/auth.ts
 M forge-control/src/routes/files.ts
?? forge-control-web/app/desktop/chat/code-path-link.ts
?? forge-control-web/app/desktop/chat/open-file-bus.ts
```

Not empty ⇒ finding, per the standing rule. **None of it is attributable to this
project** — this project's diff touches none of those seven paths, and the file mtimes
(00:33–01:43 UTC) sit inside the `aios-chat-ref-nav` window. Provenance, established
before recommending anything:

| path | already committed elsewhere? |
|---|---|
| `chat/code-path-link.ts` | yes — byte-identical to `27ab8d5` (`project/ecacba29*`) |
| `chat/open-file-bus.ts` | yes — byte-identical to `27ab8d5` |
| `chat/FileExplorerPanel.tsx` | yes — identical to `27ab8d5` |
| `chat/MessageMarkdown.tsx` | yes — identical to `27ab8d5` |
| `forge-control/src/routes/files.ts` | yes — identical to `27ab8d5` |
| `app/desktop/ChatSurface.tsx` | yes — the `fetchChatDelta` thunk is in `07613bc` |
| **`forge-control-web/auth.ts`** | **NO — `git log --all -S 'https://github.com/login/oauth'` returns nothing** |

`auth.ts` adds `issuer: "https://github.com/login/oauth"` to the GitHub provider, with a
29-line header explaining it fixes the RFC 9207 `iss` validation failure that broke every
new sign-in on 2026-08-25 ("auth error: configuration" on Konrad's phone). **The working
tree is the only copy of a fix that is serving Konrad's logins right now.**

**Fix:** do **not** revert, discard or `git stash` any of it — reverting `auth.ts` breaks
sign-in on every device again, and the ruling in
`live-checkout-dirty-protocol.md` (Konrad, 2026-08-18, corrected 2026-08-19) is explicit
that the dangerous verb here is *discard*, not *commit*. The seven paths must be resolved
by their owners: the six `ecacba29`/`07613bc` duplicates can be checked out from those
commits or simply left until that lane merges; **`auth.ts` needs committing in place, by a
task seeded with a named owner and a declared policy bypass**, before anything touches
that checkout. Escalated to the manager chat at review time.

### 2. FINDING — undeclared writes in commit `2b4b3eb` (T4, client)

The task row's declared `write_set` is:

```
{liveSessions.ts, LiveSessionsStrip.tsx, engineBadge.ts, teamApi.ts,
 ChatTeamPanel.tsx, PlanKanban.tsx, scripts/checks/check-live-sessions.ts}
```

`git log --name-only 2b4b3eb` shows nine files. The two undeclared ones:

- **`scripts/checks/gates-808.sh`** (+7) — registers the new gate 18.
- **`scripts/checks/check-dismiss-peek.tsx`** (+22/−2) — rewrites the `element()` slicer
  from `indexOf(attrName)` to a regex anchored on JSX-attribute shape.

Both edits are *correct and necessary* (the second is a real fix: the old `indexOf` was
matching `data-team-restore-all` inside a `closest()` selector string, and the round's new
self-closing tag made that latent bug visible). Neither is a defect. But
`scripts/checks/gates-808.sh` **governs every project in this repo**, and
`check-dismiss-peek.tsx` is another lane's instrument — those are exactly the two files a
write-set exists to make visible before the fact. Recording them after the fact in this
review is the mitigation, not the fix.

**Fix:** amend the T4 task row's `write_set` to include both paths, or state in the task's
report that they were taken deliberately and why. Do not amend a `done` row's `write_set`
silently — see `ledger-gap-is-the-finding.md`; the disclosure belongs in the report.

Same class, smaller: commit `0e930af` (T2, before-evidence, declared
`{evidence/aios-sidebar-live-sessions/before.md}`) also wrote
`docs/research/round-0-e4e503ab.md`. That file is the research harness's own pointer
convention, so it is closer to structural than to drift, but it is still undeclared.

### 3. FINDING — a `done` task's declared write never landed: `activity-truth.md` does not exist

Round-0 task **"Measure the activity-column blank rate on live runs"** is `status = done`
with `write_set = {evidence/aios-sidebar-live-sessions/activity-truth.md}`.

```
$ ls evidence/aios-sidebar-live-sessions/
after.md  before.md
$ git log --all --oneline -- '*activity-truth*'
(nothing)
```

The file exists in no commit on any branch. My own brief expected "the three evidence
documents"; there are two.

This is not bookkeeping. That task's measurement is the *entire* justification for the
`run-rollup.ts` change in `3e63a45` — the "60.8 % of live wall-clock in `tool_result`,
replayed over 321 runs / 66 h of thread" figure that `run-rollup.ts:262-277` and
`liveSessions.ts:159-180` both cite as the reason the state machine now carries the
answering tool's name. **The number is quoted in three source files and backed by no
artefact in the repo.** A later reader cannot check it, and cannot re-run it.

**Fix:** land `evidence/aios-sidebar-live-sessions/activity-truth.md` with the replay
method and the raw counts, or, if it was genuinely never written, correct the three code
comments to cite where the figure actually came from. `done` does not verify the declared
write-set (`done-never-verifies-the-declared-write-set.md`), so nothing caught this.

### 4. FINDING — `after.md` cites six screenshot paths that 404

`after.md:68-81` cites, e.g.,
`/api/uploads/c7dcc38a9397/20260825T015710853Z-live-sessions-linked-light.png`.
The file on disk is `2026-08-25T015710853Z-live-sessions-linked-light.png` — the
**extended** date form, not the compact one. Every one of the six cited paths is wrong in
the same way, so every link in the document resolves to nothing.

Two separate problems, and both are cheap to fix:
- the citations do not match the files (an evidence document whose paths do not resolve is
  the exact failure `browser-stream-viewer-round3-fabricated-evidence.md` was written
  about — here the shots are genuinely real, which is why this is a finding and not a
  blocker, but a reader who clicks and gets a 404 has no way to tell those two cases
  apart);
- the filenames themselves do not follow the required convention. The brief specifies a
  compact UTC ISO-8601 stamp (`20260818T093000Z`); these are a hybrid
  (`2026-08-25T015710853Z`) — extended date, compact time, and a millisecond field.

**Fix:** correct the six cited paths in `after.md` to the names actually on disk. Renaming
the files instead would be the cleaner fix but would break any link already sent.

### 5. FINDING — `forge-control/src/lib/run-rollup.ts` has no test at all, and this diff adds state to it

`3e63a45` adds a `pendingTools: Map<string, string>` to the per-run rollup, a
`rememberPendingTool()` with `PENDING_TOOL_CAP = 64` insertion-order eviction
(`run-rollup.ts:114-127`), a write at `:229-231` and a read-and-delete at `:278-279`.

I read the state machine closely and **found no defect**: entries are keyed by
`tool_use_id` so they cannot cross-talk; the delete on the result path keeps the map at
the true in-flight count; the cap bounds the never-answered case (a killed run, a Task
spawn whose parent exits first); `state.delete(runId)` in `finalizeRollup` (`:405`) drops
the whole rollup, so there is no leak past the existing lifetime; and the
`typeof e.toolUseId === "string"` guard already dominates both sites.

But there is **no `run-rollup.test.ts`** anywhere in `forge-control/src/lib/`, and gate 23
globs exactly `src/lib/*.test.ts` — so nothing in the 2138-test suite exercises
`rememberPendingTool`, the eviction, or the `tool_result` naming. This is the executor's
hot path, it is now stateful, and it is the change the whole "the activity column is never
blank" claim rests on. `team-live.test.ts` tests the *projection*; it cannot see the
rollup that produces the input.

**Fix:** add `forge-control/src/lib/run-rollup.test.ts` covering, at minimum: a
`tool_call`/`tool_result` pair naming the answering tool; a `tool_result` whose
`tool_use_id` was never seen → `tool: null` (not a stale neighbour's name); 65 unanswered
parent tool calls → the map holds 64 and the *oldest* was the one evicted; a sub-agent
`tool_call` (with `parentToolUseId`) not polluting `pendingTools`.

---

## Suggestions (not findings)

- **`liveSessions.ts` / `LiveSessionsStrip.tsx:367`** — `useTick()` is consumed at the
  *body* level, which re-renders the whole list once a second and, because
  `selectLiveSessions` allocates a fresh `row` object per tick, defeats the `memo` on
  `LiveSessionRowView`. The file says so itself and argues the cost is affordable because
  the block is bounded by the live count. I agree with the trade-off. It is worth naming
  only because `tickStore.ts:5-11` states the opposite rule in so many words ("`useTick`
  is therefore consumed ONLY by the leaf time component (round 502)"), and the next reader
  of that comment will find a counter-example one directory away. A sentence in
  `tickStore.ts` recording the sanctioned exception would close it.
- **`ChatTeamPanel.tsx:907-910`** — the PROJECT switcher's `maxHeight: 62, overflowY:
  "auto"` fix is genuinely good (the round-3 evidence carries an independent, in-thread
  confirmation from another agent that the overlap is real on deployed `main` and fixed on
  this branch). Note that local `main` here is `259778b`, *"fix(sidebar): bound the
  project switcher"* — the same fix appears to exist on main already. `git merge-base`
  says `259778b` is not an ancestor of this branch, so the merge will need a look; it is
  the kind of same-intent-both-sides change that produces a conflict rather than a clean
  fast-forward (`add-add-conflict-when-both-sides-extract-a-surface.md`).
- **`liveSessions.ts:47`** — `isLiveNode = !settled` means a `paused` or `stuck` node's
  elapsed keeps interpolating upward by up to `CLIENT_INTERPOLATION_CAP_MS` (15 s) per
  poll, because `interpolatedWorkingMs` only freezes on `settled`. This is inherited
  policy, identical to what the tree already does to the same nodes, so it is not a
  regression — but the LIVE block is the first surface to make queued/paused/stuck rows
  prominent, and a clock ticking on a paused agent is the sort of thing Konrad will notice
  before anyone else does.

---

## What I did not review

- The scope toggle (T7, `status = running` at the time of this review) and its files —
  out of scope by the plan's own task graph, reviewed by T8.
- The two SKIPPED browser gates, which need the phase-800 isolated-API harness that is not
  up on this box. I did not stand it up; the after-evidence's own browser run covers the
  same surface with photographs.

---

**VERDICT: NEEDS_FIXES** — findings 1–5 above. The reviewed code is sound and every claim
in the plan holds; the blockers are the dirty live checkout (with its sole-copy `auth.ts`
escalation) and three gaps in the write-set / evidence ledger.

**Tip:** `bce734c0b298070301a4725048cd375796deb2db`. **Gates:** 26 executed, 0 RED,
2 SKIPPED-by-design, suite exit 0.
