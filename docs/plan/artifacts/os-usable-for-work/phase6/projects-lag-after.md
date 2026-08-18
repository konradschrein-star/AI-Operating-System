# Projects click lag — the AFTER measurement, and the fix it proves

**Phase 6, task C.** Requirements R73, R74, R75; cross-cutting N1, N2, N7, N10.

The diagnosis this fix answers is `projects-lag-before.md` (task A), and it named exactly one dominant
cause, so this task did not have to guess:

> **The dominant cause is the 6-second board poll's PAYLOAD, not the render.** `GET /api/projects/board`
> returns 1,843,144 bytes and the board renders 34,834 of them — 1.9%. 88.2% of the payload is the
> `brief` column, which nothing on the board reads.

Raw output: `projects-lag-after.json` (same script, same shape, `RUN_LABEL=after`, unedited).
Before: `projects-lag-before.json`. Reachability: `projects-reachability.md`.
Screenshot: `projects-board-after.png` (152 cards at live scale, rendered from the lean payload).

---

## 1. The verdict

> ### The named cause is gone. The board poll now ships 14.1% of the bytes it used to, and every card is still there.
>
> **W4 — 30 idle seconds on the Projects board, the window that isolates the polls:**
> **9,320,340 → 1,310,800 decoded bytes (14.1% of before, −85.9%)** and
> **2,635,364 → 142,290 wire bytes (5.4% of before, −94.6%)**, three repetitions each, against the same
> in-app idle floor (TODAY: 0 bytes) in the same tab.
>
> R74 asks for the dominant metric **at or below 50% of before**. It is at **14.1%**.

The mechanism is one line of SQL: `listActiveTasks()` selects `BOARD_TASK_COLS_PT` instead of
`TASK_COLS_PT` — every row, every column **except `brief`**. No row `LIMIT`, no windowing, no library.

Reachability, measured rather than argued: **149/149 before and 152/152 after**, distinct task ids
compared against the server's own `count` in the same second, zero missing and zero extra in both runs
(`projects-reachability.md`).

---

## 2. The numbers, each with what produced it

Every figure is a field of `projects-lag-after.json` / `projects-lag-before.json` (path given) or the
output of the command quoted under it (N10).

### 2.1 W4 — the dominant metric, `summary.w4`

30 s idle on the board, paired with 30 s idle on TODAY, 3 repetitions:

| per 30 s idle window | before (3 reps) | after (3 reps) | change |
|---|---|---|---|
| requests | 7 / 8 / 7 | 7 / 8 / 7 | — (unchanged, deliberately: §3) |
| **decoded bytes** | **9,320,340 / 9,321,075 / 9,320,340** | **1,310,701 / 1,311,534 / 1,310,800** | **14.1%** |
| wire bytes (gzip) | 2,635,364 / 2,636,400 / 2,635,374 | 142,034 / 143,054 / 142,290 | **5.4%** |
| React commits | 3 / 5 / 3 | 3 / 5 / 3 | — |
| React commit ms (fiber `actualDuration`) | 13.3 / 9.9 / 10.4 | 13.8 / 16.2 / 8.3 | noise, §4.2 |
| script ms *(renderer-wide CDP aggregate)* | 35 / 27 / 26 | 33 / 38 / 21 | noise, §4.2 |
| long tasks | 0 | 0 | — |
| idle floor on TODAY (decoded) | 0 / 0 / 736 | 0 / 0 / 737 | identical |

Sustained cost of an operator sitting on this surface doing nothing:
**311 KB/s decoded → 44 KB/s. 88 KB/s over the wire → 4.7 KB/s.**

The arithmetic still closes, which is how the trace is known to be complete — 5 board fetches at the
6 s interval plus 2 projects fetches at the 15 s interval:

```
before:  5 × 1,843,144  +  2 × 52,310  =  9,320,340    measured: 9,320,340
after:   5 × 241,236    +  2 × 52,310  =  1,310,800    measured: 1,310,800
```

### 2.2 The payload itself, per fetch — `requestsByUrl["GET /api/proxy/projects/board"]`

| | before | after | change |
|---|---|---|---|
| decoded bytes per fetch | 1,843,144 | **241,229** | **13.1%** |
| wire bytes per fetch (gzip) | 518,811 | **20,207** | **3.9%** |
| fetches in the run | 23 | 24 | — |
| decoded bytes, whole run | 42,392,334 | **5,789,497** | 13.7% |
| wire bytes, whole run | 11,932,668 | **484,978** | 4.1% |

The wire number falls further than the decoded number (25.7× against 7.6×) because what was removed
was 149 long, highly-compressible English briefs; what is left is ids, enums and timestamps, which
gzip already had little purchase on. **On Konrad's laptop over the WAN the wire number is the one that
matters**, and the before report's own extrapolation was that 518,791 gzipped bytes every 6 s is 4.2 s
per fetch on a 1 Mbit/s link — *longer than the poll interval that triggers it*. At 20,207 bytes that
same link needs **0.16 s**.

Directly, without a browser — the fixed server on a spare port (§4.1) against the live one:

```bash
curl -s http://127.0.0.1:7789/api/projects/board -o /tmp/after.json -w 'FIXED %{size_download}\n'   # 241,205
curl -s http://127.0.0.1:7700/api/projects/board -o /tmp/live.json  -w 'LIVE  %{size_download}\n'   # 1,933,492
python3 -c "
import json
a=json.load(open('/tmp/after.json')); b=json.load(open('/tmp/live.json'))
print('rows', a['count'], b['count'], '| ids equal:', {t['id'] for t in a['tasks']}=={t['id'] for t in b['tasks']})
print('brief on fixed:', 'brief' in a['tasks'][0], '| R56 fields:', all(k in a['tasks'][0] for k in ('depends_on','workstream','write_set')))"
#   rows 152 152 | ids equal: True
#   brief on fixed: False | R56 fields: True
```

**Same 152 rows, same 152 ids, 12.5% of the bytes.**

### 2.3 The click that actually waited: cold entry — `preflight.firstBoardReadyMs`

| entering Projects cold (empty React Query cache) | before | after |
|---|---|---|
| time to first card | **192 ms** | **91 ms** |
| requests it waits on | 1 board fetch | 1 board fetch |

**52.6% of before**, and its entire content is still that one fetch — now a 20 KB one. Quoted with the
caveat the before report attached to it: the harness polls at ~55 ms granularity and this is two
samples, so treat it as ±one tick. It is not the metric R74 is scored on; W4 is.

### 2.4 What did NOT change, and must not be read as a regression

`summary.w2` (click a task card) and `summary.w3` (board→floor toggle) carry **more** bytes after than
before — 169,287 vs 104,169 in W2, 1,294,312 vs 1,197,886 in W3. That is not this fix leaking bytes.
It is the chat threads, and they are attributable by URL:

| whole-run decoded bytes, by endpoint class | before | after |
|---|---|---|
| `GET /api/proxy/projects/board` | **42,392,334** | **5,789,497** |
| `GET /api/proxy/chat/:id` (thread fetches) | 2,888,577 | 4,508,223 |
| `GET /api/events/:id` (SSE frames) | 3,837,040 | 4,673,336 |
| `GET /api/proxy/projects` (the 15 s list poll) | 627,720 | 627,720 |

W2 opens the detail pane for **the first running card**, and W3 opens the floor, and both then fetch
whole run threads whose size is a property of *which runs were running at the time*, not of the board
feed. The before run clicked run `4a1e3856…`; the after run clicked `17286f35…`. The board's share of
all decoded bytes in the run fell from **84%** to **37%** — chat threads and SSE are now the dominant
traffic on this surface, which is a real finding and is **out of scope for task C** (§6).

### 2.5 W5 and the 25.8 s stalls — still a harness artefact, still not Konrad's

`requestsByUrl` shows `maxDurationMs` 25,776 for the board in the after run against 25,855 before.
That is the HTTP/1.1 six-socket ceiling `browser-harness-perf.md §9` documents, reproduced identically,
and it is **not** a number this fix is credited with moving. Production negotiates HTTP/2. W5's byte
counts are the real quantity there and they are 0 in both runs, because SSE holds and the chat interval
is 20 s rather than 3 s.

---

## 3. What was changed, and what was deliberately not

**Changed — the named cause, and nothing else (R73):**

| file | change |
|---|---|
| `forge-control/src/lib/projects-board-limit.ts` | new. Pure column arithmetic: derive the board's select list from `TASK_COLS_PT` by omitting named columns, and throw on every way that derivation can go quietly wrong. |
| `forge-control/src/lib/projects-board-limit.test.ts` | new. 16 assertions, `pnpm test` (N2). |
| `forge-control/src/db/projects.ts` | `BOARD_TASK_COLS_PT = projectBoardColumns(TASK_COLS_PT)`; `listActiveTasks()` selects it and returns the new `ProjectBoardTask` type. |
| `forge-control/src/routes/projects.ts` | doc-comment on `GET /board` recording what it now serves and why. No behaviour change. |
| `forge-control-web/app/api-perf.ts` | new (this lane's client file, 02-architecture.md §0.3): `ProjectBoardTask`, `fetchProjectBoardCards()`, `fetchTaskBrief()`. |
| `forge-control-web/app/desktop/ProjectsSurface.tsx` | board query uses the lean feed and the lean type; `TaskDetail` fetches the one brief it shows. |

**NOT done, each because the measurement said so:**

* **No windowing.** The before report ranked 142 unwindowed `TaskCard`s second and refuted them: one
  React commit of 12.4 ms, 1,400 DOM nodes, zero long tasks. The after run confirms the render was
  never the problem — W1 is still exactly **1 commit** (12.8–18.0 ms for 152 cards, 1,476 nodes) and
  still **zero long tasks in every window**. Shipping `@tanstack/react-virtual` here on the strength of
  the `AssistantThread.tsx` analogy would have added a dependency and a regression surface to save
  ~15 ms, and would have shipped a false conclusion with it.
* **No change to the 6 s interval.** It is what makes warm entry cost zero requests and 3–4 ms. Making
  the payload small is strictly better than making it rare — and now that the payload is 20 KB on the
  wire, the interval is cheap rather than merely tolerable.
* **No `LIMIT` on `listActiveTasks()`.** R75 outranks it, and the before report is explicit: 142 rows
  is nothing; 142 rows × a 39,597-byte `brief` is everything.
* **`depends_on` (8.1% of the old payload) was NOT dropped**, though the board does not read it:
  **R56** (`engine-task-graph/01-requirements.md:1150`) requires `GET /api/projects/board` to carry
  `depends_on`, `workstream` and `write_set` on every task. Dropping it would have falsified a passed
  requirement to save 8%. It is asserted by test instead:
  `assert.ok(after.includes(c), "R56 requires …")`.

---

## 4. How the after run was produced, and the two ways it differs from the before run

### 4.1 The fixed server had to be somewhere, and it could not be pm2

`RUN_LABEL=after` measures a browser talking to a **built Next bundle** talking to **forge-control**.
The fix is in forge-control, and `pm2 restart forge-control` from a build task is forbidden (it is the
deploy phase's job, and the executor's runs are on that box). So the fixed router was mounted on a
spare port and everything else proxied to the live service:

```
Chrome → next start :7786 → /api/proxy/* rewrite → :7789 probe ─┬─ /api/projects/* → THIS WORKTREE's router → live Postgres (read-only)
                                                                 └─ everything else  → live :7700, unchanged
```

The probe (`/tmp/p6c-probe.mts`, outside the repo — it is scaffolding, not deliverable) **refuses every
non-GET with 405 before routing**, so the whole measurement is read-only by construction rather than by
good intentions. Verified: `POST /api/projects → 405`, logged `[probe] REFUSED POST /api/projects`.
SSE was verified end-to-end through the chain before the run (`event: snapshot` arrives), because a
broken stream would silently change W5's shape from the 20 s branch to the 3 s branch.

Two consequences, stated so nobody has to discover them:

1. **every non-projects request in the after run carries one extra loopback hop.** It is ~1 ms and it
   affects durations, never byte counts. The metric R74 is scored on is bytes.
2. **the before run was measured against `:7700` directly.** Same live database, same live scale.

### 4.2 Live scale moved between the two runs, and this file does not pretend otherwise

| | before | after |
|---|---|---|
| measured at | 2026-08-18T20:06:12Z | 2026-08-18T21:00:10Z |
| board cards (`preflight.cardsAtStart`, counted two independent ways, `agree: true`) | 142 | **152** |
| DOM nodes on the board | 1,400 | 1,476 |
| host loadavg | 8.43 | 5.02 |

**The after run measures 7% MORE cards than the before run and still ships 14.1% of the bytes.** The
comparison is therefore conservative rather than flattered: per card, the payload fell from 12,980 to
1,587 decoded bytes.

The two clocks disagree slightly on commit time in W4 (13.3 → 13.8 ms median) and on renderer-wide
script time (27 → 33 ms). Neither is a signal: this is a shared 16-core VPS whose loadavg moved from
8.43 to 5.02 between runs, the before report already recorded 9.9–13.3 ms across its own three reps,
and a payload that is 7.6× smaller cannot make React commit *more*. They are quoted rather than
suppressed because a report that only lists the numbers that moved the right way is not a measurement.

---

## 5. ADJUDICATION MATERIAL — the `forbidden-file diff` gate goes red by design

`scripts/checks/gates-808.sh:143` runs:

```bash
git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files' \
  && { echo '>>> FORBIDDEN FILE DIFFERS'; exit 1; } || { echo 'clean'; exit 0; }
```

**This branch changes `forge-control/src/db/projects.ts`, so that gate WILL report
`>>> FORBIDDEN FILE DIFFERS` and exit 1.** It is expected, it was expected before the change was made,
and the reviewer adjudicates it in writing against the phase-1 baseline rather than silently accepting
or silently failing it. The material:

**Which file, which lines.** `forge-control/src/db/projects.ts`, four hunks:

1. one import — `projectBoardColumns` from `../lib/projects-board-limit.ts` (pure, no DB, no cycle;
   the same shape as the existing `task-graph.ts` and `project-reconcile.ts` imports beside it);
2. one new derived constant, `BOARD_TASK_COLS_PT`, beside `TASK_COLS_PT`;
3. one new exported type, `ProjectBoardTask = Omit<ProjectTaskWithProject, "brief">`;
4. `listActiveTasks()` — the SELECT list and the return type. **Nine words of SQL.**

Nothing else in the file is touched: no scheduling predicate, no `promoteReadyTasks`, no
`claimReadyTasks`, no `setTaskStatus`, no `retryTask`, no `createFixChain`. `git diff` is the record.

**Why the requirement could not be met otherwise.** R73 requires the fix to address the measured cause.
The measured cause is that this exact function selects every column of 149 rows including a
1.6 MB-in-aggregate `brief` that nothing on the board renders — the response is produced *here* and
nowhere else. Every alternative was considered and each fails a stated requirement:

| alternative | why it fails |
|---|---|
| strip `brief` in `routes/projects.ts` after the query | Postgres still reads, serialises and ships 1.8 MB to the node process; the byte cost moves from the wire to the DB link and the JSON parse. It also puts the row shape in two places. |
| a new endpoint beside `/board`, leaving `listActiveTasks()` alone | the surface is *this* endpoint; a second one leaves the 1.8 MB path live for the next caller, and R73's "the named cause and nothing else" is not "a second cause beside the first". |
| lengthen the poll interval | refuted in `projects-lag-before.md §5`: the 6 s poll is what makes warm entry cost zero requests. Fewer 1.8 MB fetches is still 1.8 MB per fetch on cold entry. |
| window the board | refuted by measurement (§3). And it would not remove a single byte. |
| a row `LIMIT` here | an R75 reachability regression, and it caps the quantity that was never the problem. |

**What the risk is.** The changed function has exactly one caller — `GET /api/projects/board`
(`grep -rn "listActiveTasks" src/` returns the definition, the import and one call site) — and one
consumer of that endpoint in the entire web app (`fetchProjectBoard`, whose sole caller was
`ProjectsSurface.tsx`, now on `api-perf.ts`'s lean call). The blast radius is that endpoint. The
failure mode if this is wrong is a card whose `brief` is `undefined`, which TypeScript now makes
unrepresentable: `ProjectBoardTask` has no `brief` field, so a consumer that reads one does not
compile. Mitigations, all of them mechanical rather than remembered:

* module-load evaluation — a projection that can no longer be built is a **boot failure naming the
  column**, not a 500 on the next poll;
* the canary test reads the real `TASK_COLS_PT` out of `db/projects.ts` and fails if `brief` stops
  being in it, if a required column leaves it, or if a **new** column is added to it that neither
  constant accounts for;
* R56's three fields are asserted by name;
* reachability is measured, both directions, id by id (`projects-reachability.md`).

**Control run — the tests bite.** Renaming `pt.brief` to `pt.brief_text` in `TASK_COLS_PT` and
re-running (file restored afterwards, md5 verified identical):

```
not ok 1 - projects cleanly, and the result is missing exactly `brief`
not ok 3 - BOARD_REQUIRED_COLUMNS + BOARD_OMITTED_COLUMNS accounts for the whole list
# tests 16   # pass 14   # fail 2
```

The gate's own waiver comment (2026-08-16) shows the shape this adjudication is meant to take: the ban
exists to stop lanes colliding on engine files, and it is lifted by a named, scoped, reasoned decision
rather than by ignoring the red.

---

## 6. What this fix did NOT fix, and what should be looked at next

1. **Chat threads and SSE are now the dominant traffic on this surface** — 9.2 MB decoded across the
   after run against the board's 5.8 MB (§2.4). A run thread is fetched whole, repeatedly, and
   `AssistantThread` already windows the render of it. This is a payload problem of the same family
   and it is not phase 6's.
2. **`api.ts`'s `fetchProjectBoard` is now dead and its `ProjectTask.brief: string` over-promises for
   board rows.** This lane may not edit `app/api.ts` (02-architecture.md §0.3), and nothing calls it
   after this change — `grep -rn "fetchProjectBoard\b" app/` returns its definition and nothing else.
   Whoever next owns that file should delete the function; until then the trap is that a future caller
   would type-check against a `brief` the endpoint no longer sends. Recorded here rather than fixed
   silently across a lane boundary.
3. **The surface still has no backoff** when `/api/proxy/*` is unreachable — 164 requests per 30 s,
   reproduced four times in the before run (`projects-lag-before.md §4`). Untouched: it is a
   degradation-behaviour defect, not a lag cause.

---

## 7. Verification, in full

```bash
cd forge-control-web && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit
#   Already up to date. node_modules/.bin holds next AND tsc (+ typescript, not −)
#   tsc: exit 0, no output

cd ../forge-control && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit && pnpm test
#   tsc: exit 0
#   # tests 1309  # pass 1309  # fail 0        (16 of them this task's)

node scripts/checks/no-raw-colours.cjs
#   PASS — 222 literal(s) across 14 file(s), all accounted for (176 legitimate, 46 known debt, 0 unlisted)
```

Browser evidence, all through the authenticated harness (`browser-harness-perf.md`), all asserting
`/signin` was not reached:

* `projects-board-after.png` — 152 cards at live scale, rendered from the 241 KB payload;
* `projects-reachability.md` — 149/149 and 152/152 distinct ids reachable, zero missing, zero extra;
* **the fetch-on-select brief, exercised** — `measure-projects-lag.cjs` clicks the first *running* card
  by design, so it never opens the pane that used to read `task.brief`. A separate check clicked a
  **pending** card and asserted the whole path:

```
clicked: "pending r700 Plan phase 7 — integration and the self-proving deploy · os-usable-for-work"
taskRequests: [{ "url": "/api/proxy/tasks/a7d504bb-aa73-4718-aeb7-b73c1cd5b0fd", "status": 200 }]
pane: { open: true, notStarted: true, loading: false, failed: false, emptyBrief: false }
OK — brief rendered from /api/proxy/tasks/a7d504bb… (644+ chars visible)
```

  The pane distinguishes four states on purpose — loading, failed (with the error text), genuinely
  empty, and present — because `?? ""` would render all four as the same blank pane (N1).

Commit order, which is the check the gating reviewer runs:

```bash
git log --format=%H --reverse project/7851068b..HEAD -- docs/plan/artifacts/os-usable-for-work/phase6/projects-lag-before.md | head -1
git log --format=%H --reverse project/7851068b..HEAD -- forge-control-web/app/desktop/ProjectsSurface.tsx | head -1
git merge-base --is-ancestor <the first> <the second> && echo "COMMIT ORDER OK"
```

## 8. Reproduction

```bash
cd <worktree>/forge-control-web && pnpm install --frozen-lockfile --prod=false
# the fixed server on a spare port (§4.1), read-only, refusing every non-GET:
cd ../forge-control && DATABASE_URL=<live> ./node_modules/.bin/tsx /tmp/p6c-probe.mts        # :7789
cd ../forge-control-web
FORGE_CONTROL_URL=http://127.0.0.1:7789 ./node_modules/.bin/next build --profile             # BUILD_ID rgSqPRo__ETUwf-_N342h
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a                              # a READ of the live checkout
tmux new-session -d -s p6cweb "AUTH_URL=http://127.0.0.1:7786 AUTH_SECRET='$AUTH_SECRET' \
  FORGE_CONTROL_URL=http://127.0.0.1:7789 ./node_modules/.bin/next start -p 7786"
cd .. && RUN_LABEL=after PORT=7786 FORGE_SESSION_COOKIE="$(cat /tmp/p6c-cookie.txt)" \
  PROJECTS_LAG_SHOTS=/tmp/p6c-shots \
  node docs/plan/artifacts/os-usable-for-work/phase6/measure-projects-lag.cjs --commit-artifact
```

≈ 8 minutes. The script was **not edited**, which is the only thing that makes "before" and "after"
the same measurement. The check is against task A's commit, not against the branch point — the file
was *created* inside `project/7851068b..HEAD`, so a diff over that whole range shows 839 insertions and
proves nothing:

```bash
git log --format="%h %s" project/7851068b..HEAD -- .../measure-projects-lag.cjs
#   2868102 measure(os-usable-for-work/phase 6, round 0): the Projects board ships 1.8 MB …   ← one commit, task A's
git diff 2868102..HEAD -- .../measure-projects-lag.cjs
#   (no output)
```

Both the
pre-run and post-run `curl` of the throwaway server returned 200, so this is a measurement of the
application rather than of a browser talking to a dead port (`browser-harness-perf.md §7`).
