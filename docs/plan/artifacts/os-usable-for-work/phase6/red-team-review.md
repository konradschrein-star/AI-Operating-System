# Phase 6 — ADVERSARIAL RED-TEAM REVIEW (workstream `perf`)

**Reviewed tip:** `e6372dfc2a106a2401ac296b3b9b66168bd3ace1` (branch `project/7851068b-perf`).
**Merge base:** `3f98e67114a8a1fd12fced068e2238b51c766462`. Diff range used throughout:
`git diff 3f98e67...HEAD`.
**HEAD re-read immediately before this file was written:** still `e6372df`, working tree clean.
**Date:** 2026-08-18.
**Role:** adversarial reviewer, read-only. No source edit, no INSERT/UPDATE/DELETE anywhere. The only
live traffic issued was `GET /api/projects/board` and `GET /api/projects/<id>` (read-only).
**Verdict authority:** this file issues NO phase verdict. The gating reviewer (task
`98cbb26e-ce88-4588-810c-b22dfa27db62`) owns that and reads this.

**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` — the per-project layout.
`docs/plan/03-quality.md` also exists (the older repo-wide corpus); I read both paths and reviewed
against the per-project one, which is the file this project's phases reference.

---

## 0. THE HEADLINE

**Three attacks, three failures to break it.** I could not stop a delivery, could not find a deletion
path, and could not construct a `Reminder[]` in which a `pending` row fails to appear in `visible` —
15 hostile fixtures, all of which the code survived.

Four small findings are folded into §6 as a note for the gating reviewer (N8 — none is worth a fix
cycle). One of them, F5, is procedural and the gating reviewer needs it before it runs its own suite.

---

## 1. ATTACK 1 — find a change that stops a due reminder from being delivered

### VERDICT: **NO.** I could not.

The delivery path is byte-for-byte untouched and the new code cannot reach it, for five independent
reasons. Each is a command, not an opinion.

#### 1.1 `claimDueReminders()` is byte-identical

```
$ git show 3f98e67:forge-control/src/db/reminders.ts \
    | sed -n '/export async function claimDueReminders/,/^}/p' | sha256sum
c2197c44b6372303be089a3a44feda42ffd97c4ee6ca00ce585aba3a559b4edf  -

$ sed -n '/export async function claimDueReminders/,/^}/p' \
    forge-control/src/db/reminders.ts | sha256sum
c2197c44b6372303be089a3a44feda42ffd97c4ee6ca00ce585aba3a559b4edf  -
```

Identical hashes. The `SELECT … WHERE status = 'pending' AND due_at <= now() ORDER BY due_at ASC
LIMIT 20 FOR UPDATE SKIP LOCKED`, the recurrence advance, the `status = 'delivered'` flip and the
`BEGIN` / `COMMIT` / `ROLLBACK` frame all survive unchanged. (`forge-control/src/db/reminders.ts:212`.)

#### 1.2 `executor.ts` is not in the diff at all — not even whitespace

```
$ git diff --name-only 3f98e67...HEAD | grep -c executor
0
```

`claimDueReminders` has exactly one caller in the repo, and it is in that file:

```
$ grep -rn "claimDueReminders" forge-control/src/ | grep -v db/reminders.ts
forge-control/src/executor.ts:24:import { claimDueReminders } from "./db/reminders.ts";
forge-control/src/executor.ts:1526:    const due = await claimDueReminders();
```

#### 1.3 No new query takes a row lock, and no shared helper can refactor into the claim

The diff adds exactly one SQL statement to `reminders`
(`forge-control/src/db/reminders.ts:141-144`):

```sql
SELECT id::text, text, due_at::text, recur, status, source, created_at::text, delivered_at::text
  FROM reminders
 ORDER BY (status = 'pending') DESC, due_at DESC
```

A plain `SELECT` with no `FOR UPDATE` takes no row lock in Postgres, so it cannot block
`FOR UPDATE SKIP LOCKED` — and `SKIP LOCKED` means the claim would step over a locked row rather than
wait even if one existed. `listRemindersForView()` shares no transaction and no helper with the claim:
it calls `pool.query()` directly, never `pool.connect()`, so it never holds a client across statements.
The fold it delegates to (`lib/reminder-retention.ts`) has no `pg` import at all.

#### 1.4 The pool cannot be starved, because the two functions are in different processes

`forge-control/src/db/reminders.ts:25` opens a pool with `max: 2`, which is the one plausible starvation
vector — but the claim and the view never share it:

```
$ pm2 jlist  (name | script)
forge-control  | /opt/forge-ai-os/forge-control/src/index.ts     | online
forge-executor | /opt/forge-ai-os/forge-control/src/executor.ts  | online
```

`listRemindersForView()` is reachable only from `routes/reminders.ts`, mounted by `index.ts:182` — the
**forge-control** process. `claimDueReminders()` is reachable only from `executor.ts:1526` — the
**forge-executor** process. Two processes, two module instances, two independent `pg.Pool`s of 2
connections each. The API cannot exhaust the executor's pool.

#### 1.5 The `external_id` dedup key and its inputs are untouched

`external_id` is `reminder:<id>:<due_at>` (migration `db/migrations/0027_reminders.sql:4`, built in
`executor.ts:1522`). Its two inputs are `rem.id` and `rem.due_at` as read by the claim's own `SELECT`.
The diff changes neither:

- `COLS` (`db/reminders.ts:43`) is unchanged — `due_at::text` is still the same cast;
- `createReminder()` is unchanged — `input.dueAt.toISOString()`, `assertReminderTextFits()` intact,
  no trim added;
- no new statement writes `due_at`, or any column of `reminders`. §2 proves the diff adds no write at all.

#### 1.6 The route is purely additive, and the R705 branches are unreachable from the new one

```
$ git diff 3f98e67...HEAD -- forge-control/src/routes/reminders.ts | grep "^-" | grep -v "^---"
(no output — NO DELETED LINES)
```

The new branch is gated on `if (view !== undefined)` (`routes/reminders.ts:63`) and returns before the
`contains` branch is read. `c.req.query("view")` is `undefined` for every caller that does not send the
parameter, so the dedup lookup and the unfiltered page are reached byte-identically. I tried the
looser readings the code deliberately avoids: `?view=` (empty string) is `!== undefined` and therefore
**400s naming the value**, rather than falling through to the old page under a parameter the caller
believed had changed the result.

`listReminders()` — the R705 ordering fix — is also byte-identical:

```
$ git show 3f98e67:.../reminders.ts | sed -n '/export async function listReminders/,/^}/p' | sha256sum
72991507d6572b03a7819e713e8920779a72004837aff3e6551e69a041ed3b37  -
$ sed -n '/export async function listReminders(limit/,/^}/p' .../reminders.ts | sha256sum
72991507d6572b03a7819e713e8920779a72004837aff3e6551e69a041ed3b37  -
```

`ORDER BY (status = 'pending') DESC, due_at ASC LIMIT $1` — unchanged.

#### 1.7 The test that guards this path was edited — I checked it was not weakened

`reminder-dedup.test.ts` is the file that asserts the R705 behaviour, and task D modified it. A builder
editing the test that guards its own change is worth attacking. `git diff` on that file shows **one
insertion block and zero deletions or modifications**: a new `describe("GET /api/reminders?view=window
— additive, not a rewrite")` between §2 and §3. Every pre-existing assertion is untouched. The added
assertions are load-bearing rather than decorative — `assert.doesNotMatch(DB, /\bDELETE\b/i)` fails on
the word appearing anywhere in `db/reminders.ts`, including a comment.

---

## 2. ATTACK 2 — find a way a row could be deleted

### VERDICT: **NO.** There is no deletion path in this diff.

#### 2.1 No destructive verb reaches any added source line

```
$ git diff 3f98e67...HEAD -- . ':(exclude)*.png' | grep -E '^\+' \
    | grep -inE '\b(DELETE|TRUNCATE|DROP|prune|cleanup|archive|purge|remove|unlink|rm -|ON DELETE)\b'
```

Every one of the 30 hits is in a `.md` artefact, a doc-comment, or a test *name* — the strings
`no DELETE reaches the reminders route or its data layer`, `NO ROW IS DELETED`, `Delete nothing. Not
one row`, `would silently drop cards off the board`. **Zero hits in executable source.** The only new
SQL touching `reminders` anywhere in the diff is the single `SELECT` quoted in §1.3.

#### 2.2 No migration, therefore no cascade

```
$ git diff --name-status 3f98e67...HEAD | grep -c "\.sql"
0
```

No migration file, no new foreign key, so no `ON DELETE CASCADE` is reachable. `reminders` has no
inbound FK in `0027_reminders.sql` in any case.

#### 2.3 No test connects to the real database

`pnpm test` is `tsx --test src/lib/*.test.ts`. Both new test files
(`reminder-retention.test.ts`, `projects-board-limit.test.ts`) build every fixture from literals and
read source text with `readFileSync`; neither imports `pg` or `db/*.ts` at runtime — the `db/` imports
across the suite are all `import type`, which erases. The one file in the suite that does import `pg`,
`schedule-source.test.ts`, is **pre-existing** (not in this diff) and exists to prove an unset or empty
`DATABASE_URL` is refused *before a pool is constructed* — it never dials `content_forge`.

#### 2.4 No script, no cron entry

`measure-projects-lag.cjs` is the only executable artefact added. It is not referenced by `scripts/`,
by any gate, or by the plan corpus as a scheduled job:

```
$ grep -rn "measure-projects-lag" scripts/ docs/plan/os-usable-for-work/
(no output)
```

It issues no non-GET HTTP and opens no DB client — its single `method:` hit is
`e.request.method`, a read off a Chrome DevTools network event. Its only writes are report files
under its own artefact directory.

#### 2.5 Dismissal is still the only archive verb

`dismissReminder()` remains an `UPDATE … SET status = 'dismissed'`, unchanged. Retention hides,
groups, collapses and counts; it removes nothing. Note the design choice that makes this auditable:
`listRemindersForView()` deliberately omits `WHERE status != 'dismissed'` so that `counts.input`
equals `SELECT count(*) FROM reminders` — the view's own arithmetic is a standing proof that no row
vanished, and it is the number the gating reviewer can check against its own query.

---

## 3. ATTACK 3 — find a grouping rule that hides a reminder that has not fired yet

### VERDICT: **NO.** 15 hostile fixtures, none of them hid a pending row.

I wrote my own fixture file rather than trusting the builder's, ran it against the **real exported
`foldReminders`** from the worktree, and attacked every vector the brief names plus five it does not.

```
$ npx tsx --test /tmp/redteam-retention.test.ts
# tests 15
# suites 1
# pass 15
# fail 0
```

| # | The attack | Result |
|---|---|---|
| A1 | pending 400 days stale, `windowDays: 1` | visible — the window predicate is never applied to `pending` (`reminder-retention.ts:224-229`) |
| A2 | pending whose text is identical to 4 delivered, **grouping forced ON** | visible as its own row; its id is absent from `groups[0].ids` |
| A2b | **two** pending rows sharing one text, grouping on | both visible |
| A3 | pending with `due_at = null` | visible (`new Date(null)` → epoch 0, finite; the row is `pending`, so the window is not consulted anyway) |
| A4 | pending with `due_at` = `""`, `"infinity"`, `"-infinity"`, `"not a date"`, `"0000-00-00 00:00:00+00"` | **throws** `ReminderRetentionError` naming the row — never a silent drop |
| A4b | one malformed *delivered* row alongside a healthy pending one | throws (see F3 — blast radius, not silence) |
| A5 | recurring pending advanced 365 days past the window | visible |
| A6 | pending and delivered **exactly at the cutoff instant**, plus one 1 ms older | pending visible; at-cutoff delivered is IN (`>=`); 1 ms older is history, counted |
| A7 | the same instant written `20:00:00+00` and `22:00:00+02` | identical placement — no timezone-text seam |
| A8 | 3000 pending rows | all 3000 visible; `counts.pending === 3000`. **There is no `LIMIT` to be the (n+1)th of.** |
| A9 | `status` = `"Pending"`, `"pending "`, `"PENDING"`, `"snoozed"`, `""` | **throws** — an unknown status cannot fall through to "not pending, therefore hideable" |
| A10 | `windowDays = REMINDER_VIEW_MAX_DAYS` (36 500) | cutoff stays a finite instant; `history_count` 0 |
| A11 | duplicate ids among delivered, grouping on | pending visible; no double-consume |
| A12 | `text` = `"__proto__"` / `"constructor"` | visible (`byText` is a `Map`, not an object); `represented` = 3 |
| A13 | empty input | empty view, not a throw |

**Why the pending row cannot be hidden, structurally.** Two independent places enforce it, and I
confirmed both by reading:

1. the window test is in the `delivered` arm only — `pending` `continue`s before it
   (`reminder-retention.ts:224-231`);
2. `byText` is built from `deliveredInWindow` alone, so a pending row is never a grouping key and can
   never be `consumed` (`reminder-retention.ts:244-249`, `272-286`).

**The truncated-page vector does not exist.** `listRemindersForView()` has no `LIMIT`
(`db/reminders.ts:141`); it reads the whole table and folds in memory. The `REMINDER_VIEW_ROW_CEILING`
of 20 000 **throws with both numbers** rather than returning a short list — the right choice, because
a capped list makes `history_count` wrong while looking right.

**The UI's own fold does not swallow anything.** `MobileApp.tsx:2165` maps
`remindersQ.data?.reminders` with no `slice`, no filter and no client-side grouping — every row the
API returns is rendered, pending first. `.brief`-style client-side hiding does not exist here. I also
checked the two states that could *look* like hiding:

- a failed fetch renders a red `reminders unavailable — <message>` panel (`MobileApp.tsx:2125`), not an
  empty list — the client hard-errors on a missing `view` key rather than defaulting
  (`api-reminders.ts:118-125`), so an old forge-control answering the unfiltered 100-row page is loud;
- both mutations invalidate with the bare prefix `["reminders"]` (`MobileApp.tsx:1919`, `1960`), which
  prefix-matches `["reminders","window",N]` under React Query's default. A dismissal refreshes both
  cached windows; neither uses `exact: true`.

---

## 4. THE CHEAP CHECKS THE BRIEF ALSO ASKED FOR

### 4.1 `?contains=` and the `filter` echo — `pnpm test`, verbatim

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
   (+ typescript, + tsx present: node_modules/.bin/tsc and node_modules/.bin/tsx both resolve)

$ npx tsx --test src/lib/reminder-dedup.test.ts src/lib/reminder-text.test.ts
ok 1 - findRemindersByText — the query the dedup actually needs
ok 2 - GET /api/reminders?contains=
ok 3 - GET /api/reminders?view=window — additive, not a rewrite
ok 4 - interpretReminderPage
ok 5 - why the old page-scan failed
ok 6 - assertReminderTextFits
ok 7 - the storage path never truncates
ok 8 - the inbox card
# tests 37
# suites 8
# pass 37
# fail 0
```

Full suite: `pnpm test` → **1347 tests, 253 suites, 1347 pass, 0 fail, 0 skipped**.

### 4.2 `listReminders()` ordering — unchanged

Proven by sha256 in §1.6. `ORDER BY (status = 'pending') DESC, due_at ASC`.

### 4.3 The Projects fix did not reduce reachability — I tried to disprove it

`projects-reachability.md` claims set equality between the ids the server serves and the ids reachable
in the DOM, 149/149 before and 152/152 after. I attacked it four ways:

1. **A column it did not count.** I extracted the *real* `TASK_COLS_PT` from `db/projects.ts` and ran
   the *real* `projectBoardColumns()` over it out of process — the module-load projection is exercised
   by nothing in `pnpm test`, so this was worth proving independently:

   ```
   TASK_COLS_PT columns  : 18  id,project_id,round,role,title,brief,status,run_id,fix_cycle,
                               tier,attempt,chain_key,depends_on,workstream,write_set,
                               graph_frozen,created_at,updated_at
   BOARD projection      : 17  (same list, minus brief)
   DROPPED               : ["brief"]
   R56 fields present    : true
   ```

   Exactly one column dropped. `depends_on`, `workstream`, `write_set` all survive (R56). The builder's
   own canary test reads the live constant too rather than a copy — the right call; a hand-copied
   column list is the "verbatim quote rots" defect.

2. **A row filter.** `listActiveTasks()` gained no `LIMIT` and its `WHERE p.status IN
   ('active','blocked')` is unchanged (`db/projects.ts:357-372`). There is no mechanism in SQL.

3. **A view mode.** `ProjectsSurface.tsx:111` filters by `project_id` only — a user-chosen rail
   selection, not a hidden default (`projectFilter` null renders everything).

4. **An unrenderable role.** `ProjectsSurface.tsx:126` is `byRole.get(t.role)?.push(t)` — a non-`done`
   task whose role is not one of the five UI columns is silently dropped. This is **pre-existing** (the
   diff changed only the type annotation on the surrounding declarations), and I confirmed against the
   live board that it has never fired: 167 tasks, roles `{reviewer:51, builder:94, planner:15,
   architect:2, scout:5}`, **0 non-done tasks with an unrenderable role**. The reachability report's
   own per-column table sums to the server count in both runs (0+2+0+10+14+123 = 149;
   0+2+0+12+13+125 = 152), which independently rules it out at measurement time. See F2.

**The claim survives.** I could not find a column, a filter or a view mode it failed to count.

### 4.4 The "after" measurement used task A's script unchanged

```
$ git log --oneline -- docs/plan/artifacts/os-usable-for-work/phase6/measure-projects-lag.cjs
2868102 measure(os-usable-for-work/phase 6, round 0): the Projects board ships 1.8 MB to render 34 KB of it
$ ... | wc -l
1
```

**Exactly one commit, and it is task A's** (round 0, the "before" measurement). The script was not
touched between the before and after runs.

---

## 5. GATES AND AUDITS

### 5.1 The repo gate suite

The project ships one: `scripts/checks/gates-808.sh`, named in
`docs/plan/os-usable-for-work/03-quality.md:268`. Run with the documented invocation, `--strict`,
against tip `e6372df`:

```
$ bash scripts/checks/gates-808.sh --strict
```

**25 gates defined · 23 EXECUTED · 2 SKIPPED-by-design · 1 RED · exit 1**

| # | gate | exit |
|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | 0 |
| 2 | `npx tsc --noEmit` — forge-control-web | 0 |
| 3 | `NODE_ENV=production pnpm build` — forge-control-web | 0 |
| 4 | token purity — round 808's own files | 0 |
| 5 | `no-raw-colours.cjs` (whole app) | 0 |
| **6** | **forbidden-file diff — three-dot `main...HEAD`** | **1 — see §5.2** |
| 7 | forge-control/ untouched by round 808's own commits | 0 |
| 8 | `dollar-sweep.sh` | 0 |
| 9 | `check-composer-v3.ts` | 0 |
| 10 | `check-secret-requests.ts` | 0 |
| 11 | `contrast-canvas-banners.cjs` | 0 |
| 12 | `check-working-sql-agreement.ts` — standalone typecheck | 0 |
| 13 | `check-stop-affordance.tsx` | 0 |
| 14 | `check-dismiss-peek.tsx` | 0 |
| 15 | `check-team-rows.ts` | 0 |
| 16 | `check-team-confirm.ts` | 0 |
| 17 | `verify-notification-gap-pins.mjs` | 0 |
| 18 | `check-usage-fold.ts` — against a real Postgres | 0 |
| 19 | `check-usage-fold.ts` — standalone typecheck | 0 |
| 20 | `pnpm test` — forge-control unit suite | 0 |
| 21 | `psql-argv-leak.cjs` | 0 |
| 22 | `nav-walk-sampling.cjs` | 0 |
| 23 | `phase700/network-700.cjs` (NFU3) | SKIPPED — browser harness not requested (`--browser`) |
| 24 | `phase600/nav-walk.cjs` | SKIPPED — browser harness not requested (`--browser`) |
| 25 | reproduce-cleanliness — re-running a protocol leaves the tree untouched | 0 |

Gate 17 is **green**, not the historical pre-existing red. Gates 1, 2 and 3 green mean both packages
typecheck and the web app builds at this tip.

### 5.2 Gate 6 — RED, and it is the red this project authorised in advance

```
$ git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
forge-control/src/db/projects.ts
>>> FORBIDDEN FILE DIFFERS
```

**Adjudication material for the gating reviewer, which is where the decision belongs
(04-phases.md:329):**

1. **It is new on this branch, not inherited.** The same predicate is clean at the merge base:
   `git diff --name-only main...3f98e67 | grep -E …` → no output. The commit responsible is `27faa28`.
2. **It was authorised in writing, twice, before the work began.**
   `03-quality.md:279-281`: *"the `forbidden-file diff` gate's file list includes `db/projects`. If
   phase 6's fix requires touching `forge-control/src/db/projects.ts` … that gate will go red **by
   design**, and the reviewer must adjudicate it against the baseline and record the justification
   rather than silently accept or silently fail it."* `04-phases.md:329` repeats it as a deliverable.
3. **The file is a DECLARED write.** Task `7b4293e8`'s `write_set` on the task row lists
   `forge-control/src/db/projects.ts` explicitly.
4. **The gate's file list belongs to round 808, not to this project.** `03-quality.md:271-273` records
   that several gates in this suite are scoped to round 808's own commits and read red or meaningless
   here.
5. **I did not widen the gate.** No allowlist entry was added, no pathspec was scoped. The gate is
   still red at HEAD and this file says so.

**I did not treat this exit-1 as a blocker on the work**, because there is nothing for a builder to
fix: the required action is a written adjudication, which is the gating reviewer's own deliverable.
See F5 for the one procedural gap that makes that adjudication harder than the quality document
assumed.

### 5.3 Write-set audit — CLEAN, no undeclared write

Declared sets read from the task rows via `GET /api/projects/7851068b-…`, compared against
`git log --name-only` per commit.

| commit | task | files touched | declared? |
|---|---|---|---|
| `2868102` | `0606edd1` measure the lag | 6 files | ✅ exactly the 6 declared |
| `494784a` | `d7df37b9` reminders triage | 4 files | ✅ exactly the 4 declared |
| `27faa28` | `7b4293e8` fix the lag | 6 files | ✅ all 6 in the declared set |
| `96d4468` | `7b4293e8` re-measure | 4 files | ✅ all 4 in the declared set |
| `e6372df` | `c41b68f8` retention | 9 files | ✅ exactly the 9 declared |

**29 paths across 5 commits, every one declared. No undeclared write.**

### 5.4 Live-checkout cleanliness — PASS

```
$ git -C /opt/forge-ai-os status --porcelain
```

**No output.** The live checkout is clean; nothing was hot-applied there. Corroborated independently:
the live board feed at `127.0.0.1:7700` still carries `brief` on every row, i.e. `/opt/forge-ai-os` is
still running the pre-fix code and this branch has not leaked into it.

---

## 6. NOTE FOR THE GATING REVIEWER — five small findings, no fix cycle (N8)

None of these is a blocker and none is worth a round. They are recorded so the gate can decide with
them in hand rather than rediscover them.

**F1 · `forge-control-web/app/api.ts:1352` — a typed lie with zero callers.**
`fetchProjectBoard()` still declares `Promise<ProjectTaskWithProject[]>`, whose `brief: string` the
endpoint no longer sends. It has **no callers** (`grep -rn fetchProjectBoard forge-control-web/app` —
the only hits are its own definition, `ProjectsSurface`'s import of the *new* `fetchProjectBoardCards`,
and a doc-comment), so nothing is broken today. The trap is for a future caller, who would get
`undefined` typed as `string`. This lane may not edit `api.ts` (02-architecture.md §0.3, one client file
per lane), and the builder disclosed it in `projects-lag-after.md §6` and `api-perf.ts:16`. **Action:
hand to whoever next owns `api.ts` — delete the export.** Not this phase's to fix.

**F2 · `ProjectsSurface.tsx:126` — `byRole.get(t.role)?.push(t)` drops an unrenderable role silently.**
Pre-existing; this diff changed only the surrounding type annotations. Verified never to have fired
(§4.3.4: 167 live tasks, 0 orphan roles). The only consequence is that
`projects-reachability.md §1`'s sentence *"there is no mechanism by which a card could go missing"* is
one notch stronger than the code supports — there is such a mechanism, it is older than this change,
and it did not fire in either measured run. §2 of that same file already scopes its claim correctly to
the measured runs. **No edit requested.**

**F3 · `reminder-retention.ts:152-162` and `:213-219` — correct policy, wide blast radius.**
One unparseable `due_at` or one unknown `status` throws and takes down the *entire* view, pending rows
included. This is the deliberate N1 choice (no silent fallback) and the surface fails loudly rather
than rendering an empty list, which is the right trade. Worth knowing that it is **unreachable from
the real schema**: `db/migrations/0027_reminders.sql:10-13` declares `due_at timestamptz NOT NULL` and
`status text NOT NULL CHECK (status IN ('pending','delivered','dismissed'))`. I also confirmed Node 22
parses the Postgres text format the driver actually returns —
`new Date("2026-08-18 20:16:06+00")` and the `.123456+00` microsecond form both yield finite epochs,
so the throw does not fire on ordinary rows. The one legal-but-fatal value is
`'infinity'::timestamptz`, which no code path can insert (`createReminder` goes through
`dueAt.toISOString()`, and `new Date(Infinity).toISOString()` throws first). **No action.**

**F4 · `db/reminders.ts:141` — an unbounded full-table `SELECT` on a 60 s poll.**
At the measured 180 rows this is nothing, and the design reason for having no `LIMIT` is sound (§3).
The `REMINDER_VIEW_ROW_CEILING` of 20 000 throws rather than truncating — also right. Recording it only
so the growth curve is somebody's known quantity rather than a surprise. **No action.**

**F5 · The phase-1 gates baseline this suite is supposed to be judged against does not exist.**
`03-quality.md:274-276` states the rule for every later phase is *"no NEW red versus that baseline"*,
and that phase 1 *"captures a baseline run and commits it as
`docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`"*. That file is not in the tree:

```
$ find docs/plan/artifacts/os-usable-for-work -name "gates*"
(no output)
```

So the documented method for adjudicating gate 6 — compare against the baseline — is **undecidable as
written**, and a gating reviewer that goes looking for it will not find it. I substituted a tighter
comparison that does not depend on it: the same gate predicate run at the **merge base** `3f98e67`,
which is clean (§5.2.1). That establishes gate 6's red as new-on-this-branch, attributable to one
commit, and covered by a declared write — everything the adjudication actually needs. **Action for the
gating reviewer: use the merge-base comparison above and note the missing artefact in its own verdict;
do not seed a fix cycle to backfill a phase-1 deliverable from phase 6.**

---

## 7. WHAT I RAN

```bash
git rev-parse HEAD                                     # e6372df, re-read before writing
git merge-base project/7851068b HEAD                   # 3f98e67
git diff 3f98e67...HEAD                                # read line by line
git diff --name-only 3f98e67...HEAD | grep -c executor # 0
git log --name-only 3f98e67..HEAD                      # write-set audit
git -C /opt/forge-ai-os status --porcelain             # empty
cd forge-control && pnpm install --frozen-lockfile --prod=false   # + typescript, + tsx
pnpm test                                              # 1347/1347
npx tsx --test src/lib/reminder-dedup.test.ts src/lib/reminder-text.test.ts   # 37/37
npx tsx --test /tmp/redteam-retention.test.ts          # my 15 hostile fixtures, 15/15
npx tsx /tmp/rt-board.ts                               # real TASK_COLS_PT projection, out of process
bash scripts/checks/gates-808.sh --strict              # 23 executed, 2 skipped, 1 red, exit 1
curl -s http://127.0.0.1:7700/api/projects/board       # read-only: 167 tasks, 0 orphan roles
curl -s http://127.0.0.1:7700/api/projects/7851068b-…  # read-only: declared write_sets
node -e 'new Date("2026-08-18 20:16:06+00")…'          # PG text format parses in Node 22
```

The two fixture files I wrote live in `/tmp` deliberately — a red-team probe is not a repo artefact,
and this task's `write_set` is this file alone. Both are reproduced in substance above; the fixture
table in §3 is the part worth keeping.

---

## 8. SUMMARY FOR THE GATE

| Attack | Verdict |
|---|---|
| 1 · stop a due reminder being delivered | **NO** — claim byte-identical, executor untouched, different process, no row lock, dedup inputs unchanged |
| 2 · delete a row | **NO** — no destructive verb in source, no migration, no live-DB test, no script, no cron |
| 3 · hide a pending reminder | **NO** — 15 hostile fixtures, all survived; two independent structural guarantees |

Write-set audit clean · live checkout clean · 1347/1347 unit tests · gate suite 23 executed / 1 red,
that red authorised in writing before the work and caused by a declared write.

**No blocker found. Nothing was reported to the manager as a blocker, because there was none.**
