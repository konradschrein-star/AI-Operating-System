# aios-guardrail-hardening — engine (round 0)

Closes the engine half of round-0 finding **P1-1**: *an agent can switch a rule off
with one curl, and nothing tells Konrad.* Two changes, one rule each:

1. **Enabled means blocked, whatever the config.** A guardrail rule that is enabled and
   has no rule-specific evaluator now blocks. Its config is not read at all.
2. **Every write to a guardrail is loud.** A rule patch or a trip resolve leaves a row in
   the new `guardrail_rule_changes` table and pings Konrad on Telegram. No bypass header,
   and the console is not exempt.

Everything below was measured in this worktree on 2026-08-25. Nothing was run against the
live `POST /api/autonomy/check`, and no `guardrail_trips` row was written.

---

## 1. What changed

| File | Change |
|---|---|
| `forge-control/src/db/autonomy.ts` | `evaluateOne` → exported as **`evaluateRule`** (pure, DB-free); default branch rewritten; header comment rewritten; unreachable second `fleet_state` sync removed from `updateRule`; `resolveRunProvider` now returns role + title in the same query; `hookAgentLabel`; `recordRuleChange` / `listRuleChanges` / `normalizeChangeSource`; `AutonomyResponse.rule_changes` |
| `forge-control/src/routes/autonomy.ts` | `createAutonomyRouter(deps)` factory (default export unchanged in behaviour); `POST /rules/:id` and `POST /trips/:id/resolve` now notify + audit; `ruleChangeNotice` / `tripResolveNotice` |
| `db/migrations/0051_guardrail_rule_changes.sql` | new table + `created_at DESC` index (round 5: renumbered from 0047, §4) |
| `forge-control/src/lib/autonomy-blanket.test.ts` | 21 tests — the enforcement matrix |
| `forge-control/src/lib/autonomy-changes.test.ts` | 15 tests — the route's audit + notify contract |
| `docs/plan/aios-guardrail-hardening/01-engine.md` | this file |

### ⚠ Write-set deviation — declared loudly

The brief declared the two test files at `forge-control/src/db/autonomy-blanket.test.ts`
and `forge-control/src/routes/autonomy-changes.test.ts`. **They were written to
`forge-control/src/lib/` instead**, and the reason is a finding in its own right:

```
$ grep '"test"' forge-control/package.json
    "test": "tsx --test src/lib/*.test.ts"
$ sed -n '255,256p' scripts/checks/gates-808.sh
gate_sh "pnpm test — forge-control unit suite" \
  "cd forge-control && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"
$ find forge-control/src -name '*.test.ts' -not -path '*/lib/*' | wc -l
0
```

The repo suite globs `src/lib/*.test.ts` and gate 22/8 runs exactly that. A test committed
to `src/db/` or `src/routes/` is never executed by any gate — it runs only when a human
types its path, which is the *"check scripts are compiled but never executed"* shape the
fleet has been bitten by before. `autonomy-gemini-cap.test.ts` documents the convention in
its own header for the same reason: it tests `src/db/autonomy.ts` and lives in `src/lib/`.

`forge-control/package.json` was deliberately **not** edited — it is a shared file and every
workstream on this project adds tests. Widening the glob to `src/**/*.test.ts` is a one-line
change and belongs to the integration task. Reported to the manager chat before the build
started.

Proof the new tests are inside the gated suite:

```
$ cd forge-control && pnpm test | grep -E '^ok [0-9]+ - (evaluateRule|hookAgentLabel|normalizeChangeSource|POST /|failure ordering|the read and check|notice text)'
ok 9  - evaluateRule — the catch-all branch
ok 10 - evaluateRule — bypass_blanket
ok 11 - evaluateRule — specific evaluators are unchanged
ok 12 - hookAgentLabel
ok 13 - normalizeChangeSource
ok 14 - POST /rules/:id
ok 15 - POST /trips/:id/resolve
ok 16 - failure ordering
ok 17 - the read and check routes are unchanged
ok 18 - notice text
```

---

## 2. The rule, before and after

**Before** (`db/autonomy.ts:509-514` at HEAD `c03d9aa`):

```ts
    default:
      if (Object.keys(cfg).length === 0 && rule.enabled) {
        if (payload.bypass_blanket === true) return { blocked: false };
        return { blocked: true, reason: `${rule.label} is enabled` };
      }
      return { blocked: false };
```

**After:**

```ts
    default:
      // Enabled, and nothing above knows how to evaluate it: BLOCK. `cfg` is
      // deliberately not read here — see the header. `=== true` is the whole
      // check on the escape hatch, so an agent-supplied "true", 1 or {} does
      // not open it.
      if (payload.bypass_blanket === true) return { blocked: false };
      return { blocked: true, reason: `${rule.label} is enabled` };
```

**Why.** The old condition made an empty config load-bearing, so one unauthenticated call
ended enforcement while the console kept rendering the rule as ON:

```
curl -sX POST http://127.0.0.1:7700/api/autonomy/rules/fs.destructive \
  -H 'content-type: application/json' -d '{"config":{"note":"x"}}'
```

`fs.destructive`, `comm.outbound`, `deploy.prod` and `secrets.read` all ride that branch —
one patch, all four. A control that reports itself on while it is off is worse than one
that is plainly off, and "under-enforce silently" is not the conservative direction; it is
the direction that hides. The config is now irrelevant on this branch and an
un-understood config fails towards blocking.

**What the change costs, stated plainly.** Adding a config key to an enabled catch-all rule
can no longer loosen it — only `enabled=false` can, and that is now a decision Konrad sees.
Rules that own a specific evaluator are untouched: `git.force_push` with an *empty* config
still allows every branch (its case returns before the default), which
`autonomy-blanket.test.ts` asserts from both sides so a future deletion of that case shows
up as a failing test rather than as a fleet-wide refusal to push a project lane.

`spend.per_run_cap`'s case was **kept as dead code**. The rule row was deleted from
`guardrail_rules` on 2026-08-25 at Konrad's instruction and **must not be re-seeded**;
keeping the case means a re-seeded row would evaluate tokens rather than blanket-block.
Nothing in this change re-seeds it.

### Unreachable code removed

`updateRule`'s second, non-transactional `fleet_state` sync (`db/autonomy.ts:202-208`) is
gone. The `runtime.pause_all` branch above it returns from inside a transaction that
already writes `fleet_state`, so the second copy could never run and only made the pause
path look like it had two owners.

---

## 3. Test-bite evidence

An assertion that passes at every value of the thing it claims to test is not an assertion.
So the matrix was pointed at a scratch copy of `src/db/autonomy.ts` carrying the **old**
default branch, and the regression case was watched to fail
(`/tmp/bite-control.py`; the copy lived at `src/db/zz-old-default.scratch.ts` and was
removed by the same script):

```
real src/db/autonomy.ts sha256[:12] = d7dbe74b1669
scratch copy carries the HEAD c03d9aa default branch

--- node:test against the OLD condition -------------------------
not ok 1 - THE REGRESSION: enabled + {note:'x'} still blocks
    a config patch must not be able to disable enforcement
  expected: true
  actual: false
  operator: 'strictEqual'
ok 2 - control: enabled + {} blocks even on the old code
# tests 2
# pass 1
# fail 1
--- tsx exit = 1 (non-zero == the assertion bit) ---

scratch removed: False False
real src/db/autonomy.ts sha256[:12] = d7dbe74b1669  unchanged=True
```

Two things this shows, and the second is the point:

- the `{note:'x'}` case **fails** against the old code — it discriminates;
- the `{}` case **passes** against the old code — it does not. The empty-config case is
  regression coverage, not the discriminating assertion, and the document says so rather
  than letting a green line stand in for a boundary it never crosses.

The real file is unchanged by sha before and after.

The route test bites structurally: `createAutonomyRouter`, `ruleChangeNotice` and
`tripResolveNotice` do not exist at `c03d9aa`, so `autonomy-changes.test.ts` cannot import
against the old code at all.

---

## 4. Audit + notify

New table, **`db/migrations/0051_guardrail_rule_changes.sql`**.

Round 1 wrote it as `0047` and proved that number free — with the wrong instrument. The
transcript below is kept verbatim as the record of what was actually run:

```
$ git ls-tree --name-only main db/migrations/ | tail -1
db/migrations/0046_task_status_cancelled.sql
$ git merge-tree $(git merge-base HEAD main) HEAD main | grep -c db/migrations
0
$ git log --all --oneline --diff-filter=A -- 'db/migrations/0047*'
(empty — no ref anywhere has added a 0047)
```

**All three checks were true when run and all three were blind to the collision.**
`git ls-tree main | tail -1` read main *at the fork point this branch already had
fetched*; `merge-tree | grep -c db/migrations` counts CONFLICT lines, and two files with
different names never conflict; `git log --diff-filter=A` walks commits reachable from
refs the worktree had at that moment. Round 4's reviewer ran the repo's own gate against
the merged file set instead and it failed: `main` carries `0047_day_tasks_gtask.sql`
(`b41e824`), plus `0048_glucose_readings.sql` and `0049_importance_six_levels.sql`.

Round 5 renumbered to **0051** — 0050 is `0050_day_tasks_goal.sql` on `project/d6371f2d`.
The survey that decides the number has to read the merged set and every sibling lane:

```
$ git ls-tree --name-only main db/migrations/ | grep -E '00(4[4-9]|5[0-9])'
db/migrations/0044_goals_and_calendar.sql … db/migrations/0049_importance_six_levels.sql
$ for b in $(git branch --format='%(refname:short)'); do \
    git ls-tree --name-only "$b" db/migrations/ | grep -E '005[0-9]'; done | sort -u
db/migrations/0050_day_tasks_goal.sql
$ ls /opt/ai-os/workspace/projects/*/db/migrations/005* | sed 's|.*/||' | sort -u
0050_day_tasks_goal.sql
```

`git mv` only — `sha256sum` was `432bdd1e…9df6c` before the move and after it, so no byte
of the schema moved. The committed digest differs from that value because the same commit
adds a provenance note to the file's own header explaining why 0050 was skipped.

Behaviour:

- `POST /rules/:id` → `kind='rule.update'`, `rule_id`, `patch` = the request body.
- `POST /trips/:id/resolve` → `kind='trip.resolve'`, `trip_id`, `patch = {}`.
- `source` = the `x-forge-source` header when it is `console`, `api` or `deploy`; anything
  else — absent, misspelt, or invented by the caller — is recorded as `api`, because a run
  that claims `x-forge-source: konrads-phone` hit the HTTP endpoint and that is what the
  log should say.
- Notification text: `🛡 guardrail fs.destructive: enabled=false (source api)` /
  `🛡 guardrail trip 7c9f1c58 resolved (source console)`.
- `GET /api/autonomy` gains an **additive** `rule_changes` field (last 20 rows). `trips`
  is untouched in shape and order — `AutonomySurface.tsx` renders it and is out of scope.

Three design decisions worth stating, because each has a cheaper wrong version:

1. **No bypass header, console included.** The moment "the console is trusted" becomes a
   rule, an agent's curl can claim to be the console and the quiet path is back. Konrad
   seeing his own toggle echoed is the honest version.
2. **Notify first, audit second.** `queueNotification` never throws (`db/notifications.ts`);
   `recordRuleChange` does, on purpose. The rule change has already landed in the database
   by the time either runs, so a broken audit table costs a 500 and a log line — never
   Konrad's notification. `autonomy-changes.test.ts` asserts the ordering and the
   audit-throws case explicitly.
3. **`rule_changes` is `GuardrailRuleChange[] | null`, not `[]` on failure.** A control
   plane talking to a database that has not had 0051 applied yet must not take the fleet's
   pause switch down with it, and an empty array would read as *"nobody has touched
   anything"*. Same shape and same reasoning as the existing `gemini_daily` field beside it.

### Migration proof — scratch database, created and dropped in one command

Route is `docker exec content-forge-postgres psql`; a host-side bare `psql` reaches an
unrelated cluster on :5434. Live `content_forge` was never written to.

Run in round 1, when the file was still named `0047_guardrail_rule_changes.sql` — the
transcript keeps that name because that is the command that ran. The file is `0051_…`
today and its SQL is byte-identical (`git mv`, sha256 `432bdd1e…9df6c` on both sides),
so the proof carries over unchanged.

```
scratch database: guardrail_0047_scratch_8858f1fe

--- CREATE (exit 0)
CREATE DATABASE

--- apply 0021_ai_os_tables.sql: exit 3, ERROR lines 1
    psql:<stdin>:50: ERROR:  relation "content_jobs" does not exist
--- apply 0047_guardrail_rule_changes.sql: exit 0, ERROR lines 0

--- \d guardrail_rule_changes (exit 0)
   Column   |           Type           | Nullable |      Default
------------+--------------------------+----------+-------------------
 id         | uuid                     | not null | gen_random_uuid()
 rule_id    | character varying(64)    |          |
 trip_id    | uuid                     |          |
 kind       | text                     | not null |
 patch      | jsonb                    | not null | '{}'::jsonb
 source     | text                     | not null |
 created_at | timestamp with time zone | not null | now()
Indexes:
    "guardrail_rule_changes_pkey" PRIMARY KEY, btree (id)
    "guardrail_rule_changes_created_idx" btree (created_at DESC)
Check constraints:
    "guardrail_rule_changes_kind_check" CHECK (kind = ANY (ARRAY['rule.update'::text, 'trip.resolve'::text]))

--- INSERT rule.update + trip.resolve (exit 0)   → INSERT 0 1 / INSERT 0 1
--- SELECT (listRuleChanges shape) (exit 0)      → 2 rows, both shapes read back
--- CHECK constraint refuses an unknown kind (exit 1)
ERROR:  new row for relation "guardrail_rule_changes" violates check constraint
        "guardrail_rule_changes_kind_check"
--- re-apply 0047 is a no-op (IF NOT EXISTS) (exit 0)
NOTICE:  relation "guardrail_rule_changes" already exists, skipping
NOTICE:  relation "guardrail_rule_changes_created_idx" already exists, skipping
--- DROP the scratch database (exit 0)
rows left in pg_database for guardrail_0047_scratch_8858f1fe: 0
```

The 0021 error is **pre-existing and not caused by this work**: `0021_ai_os_tables.sql:50`
references `content_jobs`, a table an earlier migration creates, so 0021 alone on an empty
database always fails there. 0047 depends on nothing 0021 makes and applied with zero
errors, which is what the scratch database was for. The `\d` output, the round-trip INSERT
and the CHECK rejection all come from the migration file as committed.

Note for A1: the `DROP DATABASE` above was **not** seen by the live Bash hook, because the
statement lived inside a Python file and the hook only saw `python3 /tmp/...`. That is the
pattern this project's own brief mandates for its builders, and it is the same measured
gap 00-findings §P2-1 records as a documented REJECT (*"interpreter bodies are
unbounded"*). It is worth stating out loud that the mandated safe workflow and the
classifier's largest blind spot are the same thing.

---

## 5. Attribution

`guardrail_trips.agent` was the literal string `bash-hook` for every run on the box
(00-findings §P3-2), so the audit log could not say who tried the thing.
`resolveRunProvider` now returns `metadata->>'role'` and the `runs.title` column in the
**same** query it already ran for model/engine, and `evaluateGuardrails` files the trip
under `bash-hook:<role>` — `bash-hook:builder`, `bash-hook:reviewer`. The run's title is
recorded on the trip payload as `run_title` so the log names the work, not only the command.

Constraints honoured:

- **`executor.ts` is never touched** — a forbidden file (gate 6, and `project-tick.test.ts`
  R36). The role is *pulled* from the run row inside the guardrail engine, which is the
  right layer anyway.
- **A failed lookup must not block.** Same `.catch` + `console.error` pattern the provider
  resolution already used; an unresolved run files as bare `bash-hook` rather than an
  invented attribution.
- **The run id is UUID-screened first.** `id = $1::uuid` throws on a non-UUID and the run id
  arrives from a hook payload, so a bad value is now rejected before the cast instead of
  becoming a caught-and-logged non-event.
- **The label is truncated to 64** — `guardrail_trips.agent` is `varchar(64)` and an
  over-long label would abort the INSERT, turning an attributed block into no block at all.
  Asserted directly (`hookAgentLabel('bash-hook', 'x'.repeat(200)).length === 64`).

The lookup now also runs when the provider is already known but the agent is `bash-hook` —
one query either way, never two.

---

## 6. Verification

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false   # NODE_ENV=production prunes tsx silently
$ ./node_modules/.bin/tsc --noEmit                          → exit 0
$ ./node_modules/.bin/tsx --test src/lib/autonomy-blanket.test.ts   → # tests 21  # pass 21  # fail 0
$ ./node_modules/.bin/tsx --test src/lib/autonomy-changes.test.ts   → # tests 15  # pass 15  # fail 0
$ pnpm test                                                 → # tests 2219 # pass 2219 # fail 0
$ bash scripts/checks/gates-808.sh                          → 27 gates, RED: 0
```

`gates-808.sh` summary (gates 25 and 26 are the browser harnesses, skipped without
`--browser`; every other gate exit 0):

```
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 ...
 8  0      check-migration-numbers.ts
 22 0      pnpm test — forge-control unit suite
 27 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched
 RED: 0
```

No inherited RED to attribute — the suite was green before and after.

---

## 7. Findings this task produced, for the next round

**E-1 (P2) — the repo test suite only runs `src/lib/*.test.ts`.** Detailed in §1. Any test
this project commits elsewhere is decorative. One-line fix, owned by integration.

**E-2 (P3) — `bypass_blanket` is reachable from an HTTP body, on one route.**
`middleware/guardrail.ts:39-45` passes the request body straight through as `payload`, so
`POST /api/autonomy/probe/destructive -d '{"bypass_blanket":true}'` opens the branch. This
matches 00-findings §A4 ("It IS reachable through `guardrail()` middleware"), and it
matters slightly more now that the branch blocks for every enabled catch-all rule. Severity
is genuinely low: the only route wearing that middleware is the demo probe, whose handler
returns `{"result":"probe passed"}` and does nothing. The fix is one line — strip
`bypass_blanket` from the body before building the payload — but it lives in
`middleware/guardrail.ts`, outside this task's write-set, so it is reported rather than
made.

**E-3 (P3) — the audit log is written and, so far, only half-read.** `rule_changes` now
ships in `GET /api/autonomy`, but nothing renders it: `AutonomySurface.tsx` is explicitly
out of scope for this task. Until a surface shows it, the Telegram push is the only part
of this change Konrad actually experiences. That is deliberate for round 0 — the loud path
is the one that had to exist first — but an unread audit log is the exact complaint
00-findings §A7 makes about `guardrail_trips`, and this change adds a second table with
the same property. Whoever owns the surface should render `rule_changes` beside `trips`.
