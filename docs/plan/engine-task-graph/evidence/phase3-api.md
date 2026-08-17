# Phase 3 — the API's behavioural record — `engine-task-graph`

Round 213, builder 4 of 4. Round 212 shipped fifteen `400` families on
`POST /api/projects/:id/tasks` and **exercised none of them** — they need a
database, and worktree-only plus NF3 forbid one from a build task. Builder 3
said so in its own words, marking nine of the fifteen rows *"written, **not
exercised**"*. This document is the record of exercising them.

**Nothing was deployed.** No live endpoint, no live service, no `pm2` command,
no write to `/opt/forge-ai-os`. Every measurement below is against this worktree
and the scratch database `forge_tg_scratch`, reached through a throwaway schema
that is dropped on every exit path. The one read against a live service was
read-only: `GET /api/chat/<run-id>` on `:7700`, to fetch builders 1–3's final
messages for §8 rather than invent them.

---

## 1. Provenance — which bytes produced every transcript here

The transcript in §4 was produced **after** the code it reports was committed,
against the committed bytes. A transcript re-run against different bytes than
the ones that shipped is the defect phase 2 cycle 3 was spent on.

```
worktree                /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
branch                  project/8c591d6c
transcript §4 produced  3b54229   (uncommitted, of the three files under test: none)
this file committed at  the commit that adds it, one commit later
base                    b1bb731   (phase 7b, round 212 — the tree builder 4 started from)

REVISION. §4's transcript was first produced at ba09b2a, 20 cases / 96
assertions. Operator ruling 2 on finding F2 (§7) then added case 2's fourth and
fifth probes and one clause to the guard, so the transcript was RE-RUN at
3b54229 — the bytes that ship — rather than left reporting a tree that no longer
exists. 20 cases / 101 assertions. The ba09b2a numbers survive only where this
document quotes them as history, in §5.1 and §7.

sha256 forge-control/src/routes/projects.ts   0fd8c8f0767fdabc801cb23a28074aac03f870e4a24c2e449564ea88c142e9ba
sha256 forge-control/src/lib/task-graph.ts    00f4c66bd128f0233613a58deac4afe3904f9deb4f27affe7eb5429a483cbb07
sha256 forge-control/src/db/projects.ts       50ba76906e166f3c5e835c2bf01d3b5abbf0690d15722e3dae3458e54b059de7
```

The three builder commits this instrument tests:

| builder | commit | file | run id (transcript source for §8) |
|---|---|---|---|
| 1 — `computeRound`, `findCycle`, the validators | `88a20e4` | `forge-control/src/lib/task-graph.ts` | `35e13f66-55c8-4848-bfdb-1c52420f11b3` |
| 2 — `createTask` writes the three columns | `87b7743` | `forge-control/src/db/projects.ts` | `cab41564-19ec-4002-8826-09c1d99f12af` |
| 3 — the route, the fifteen `400`s | `5a1180d` | `forge-control/src/routes/projects.ts` | `4ca137bb-ddba-45bd-8b27-7c2748304c84` |

`routes/projects.ts`'s sha256 above is **not** the one `5a1180d` shipped
(`8baa3346129b54f9bb069198707b342dad7f2e6ec92925c22e581922df5089ac`): round 213
amended one expression in it under **two** operator rulings, one at each end of
the same guard. §5 is the first, §7's F2 the second; both are measured on both
sides. The intermediate state, after ruling 1 and before ruling 2, was
`b55c7c29ff14d8920073694ff619f58cd4e54a49211a16074b30e9786594e297` at `ba09b2a`
— named because §6.2's mutation transcript was taken against it.

## 2. The universal gate (`03-quality.md` §3.1)

```
$ cd forge-control && pnpm typecheck              → tsc --noEmit, exit 0, no diagnostics
$ pnpm test                                       → # tests 970  # suites 179  # pass 970
                                                    # fail 0  # skipped 0  # todo 0
$ ./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022 --skipLibCheck \
    --allowImportingTsExtensions --resolveJsonModule --types node \
    ../scripts/checks/check-task-api.ts           → exit 0, no diagnostics
$ git -C /opt/forge-ai-os status --porcelain      → empty
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
                                                  → OK, R1..R69 + NF1..NF7,
                                                    all three statements agree, exit 0
```

**The script's own typecheck is a separate invocation on purpose.** It lives at
the repo root, outside `forge-control/tsconfig.json`'s `include`
(`"include": ["src/**/*.ts"]`, verified at git SHA `ba09b2a`), so
`pnpm typecheck` — the only typecheck any phase runs — never examines it. This
is the same gap `03-quality.md` §3.2 opened for `scripts/measure-schedule.ts` at
phase 7, and it is closed the same way: by naming the invocation, not by
widening every other phase's `include`.

The one diagnostic it did produce, and how it was fixed rather than suppressed:
`TS2367 — comparison between '7799' and '7700' has no overlap`. The
never-bind-7700 guard is a **runtime** check that must survive someone editing
the port constant; against a literal type `tsc` folds it away as dead. `PORT` is
therefore annotated `: number`. Deleting the guard to silence the compiler would
have removed the protection the guard exists for.

**NF3 — this script is not, and must never be, part of `pnpm test`.** That
script is `tsx --test src/lib/*.test.ts`; `grep -rn "check-task-api"` over the
tree returns exactly two hits, both prose: this document and one doc-comment
citation in `routes/projects.ts`. Nothing wires it into the unit suite.

## 3. The instrument

`scripts/checks/check-task-api.ts` — 20 cases, 101 assertions, exit 0 only when
every case ran **exactly** the assertions it declares and all of them passed.

**Exactly**, in both directions, and it earned its keep during ruling 2: case 2
was declared at `9` while executing `11` after F2's probes were added, and the
runner refused to certify it — `MISSED case 2 declares 9 assertion(s) but
executed 11`. An over-count catches a probe that was skipped; an under-count
catches a declaration that went stale when the case grew. A one-directional
check would have passed that edit silently.

**Assertions were written from the contract first.** Phase 3's fifteen-row
`400` table and `01-requirements.md` §C were the source; `routes/projects.ts`
was read afterwards, to find the disagreements in §7. A probe derived from the
code it tests proves only that the code equals itself.

**Constraints, each verified rather than assumed** (the full reasoning is the
script's own header, which is where it belongs):

- **Only `routes/projects.ts` is mounted**, on `127.0.0.1:7799` behind
  `node:http`, driven with real `fetch` so what is proved is wire behaviour.
  Booting `index.ts` would start `startCronTick()`, `startTelegramBridge()` and
  `startVaultSyncTick()` against the same database and the same bot token.
  `serve-agents-7798.ts` is the precedent.
- **No bare imports.** Re-verified for this script: a file under
  `scripts/checks/` doing `import pg from "pg"` dies `MODULE_NOT_FOUND`. So
  `psql` via `node:child_process` for the database, and a **relative** import of
  the router, whose own bare imports resolve from `forge-control/node_modules`.
- **The pool is built at module load**, from `process.env.DATABASE_URL`,
  defaulting to `content_forge` when unset. The router is therefore loaded by a
  **dynamic** `await import()` after `DATABASE_URL` and `PGOPTIONS` are set — a
  static import hoists above every statement and would build the pool against
  the wrong DSN.
- **`PGOPTIONS` was measured, not assumed.** Before the script relied on it: a
  `pg.Pool` built from a bare connection string, with
  `PGOPTIONS="-c search_path=pgopt_probe"` in the environment, answered
  `show search_path` → `pgopt_probe` and resolved an unqualified table in that
  schema (`t.x = 42`). That matches pg's `connection-parameters.js`, where
  `this.options = val('options', config)` and `val` falls back to
  `process.env['PG' + KEY]`. **Path taken: PGOPTIONS + a throwaway schema.** The
  documented fallback — a dedicated scratch database whose `public` schema
  carries the migrations — was not needed and not taken.
- **Schema:** all 20 `db/migrations/*.sql` in lexical order into `tg_check_api`,
  including `check-migration-0040.sh`'s one named deviation, a placeholder
  `content_jobs (id uuid primary key)` — `0021_ai_os_tables.sql` declares foreign
  keys onto it and no migration in this repo creates it.
- **Refuse-to-run guard, before any statement is issued**, ported from
  `check-migration-0040.sh`: unset or unparsable `$SCRATCH_DATABASE_URL`, a DSN
  naming no database, a non-local host, `content_forge`, the maintenance and
  template databases, and — computed, so it stays correct as services are added
  — every database named by a DSN in the fleet's own env files. It prints the
  database **NAME**; the DSN is never printed and never logged.
- **Teardown on every exit path**, including failure: the schema is dropped and
  the server closed in a `finally`.

**What would make it report a pass wrongly**, answered in the script's header
and enforced in its code:

| mechanism | how it is disarmed | where you can see it work |
|---|---|---|
| (a) the router is talking to the wrong database, so a `400` production produced gets certified | positive control runs FIRST and aborts: the project is seeded by `psql` into `tg_check_api` and read back **through the router**; a pool on `content_forge` or an empty schema 404s there | §4 line `--- 0. positive control` |
| (b) a probe that never fired | each case declares its assertion count beside itself; the runner compares declared vs executed per case and cases-planned vs cases-that-asserted | §6.2, where the mutation drops case 16 to `2` of `3` and the run fails on it |
| (c) a `400` matched by status alone | every refusal asserts a body substring naming the **offender**; case 8 deep-equals the `cycle` array's ids **in order** | §4 cases 6–13 |
| (d) a double-POST that looks idempotent because the first POST failed | case 15 asserts 201 → 409, the **same task id** in both bodies, and `count(*) = 1` through `psql` | §4 case 15 |
| (e) reading NULL-vs-empty through JSON | cases 16/17 assert `SELECT depends_on IS NULL` in `psql`, and one query prints both rows side by side | §4 cases 16–17; §6.2 |
| (f) a harness that does not say which bytes it checked | build identity prints worktree, SHA, branch, dirtiness and the **sha256 of all three files under test**, before any assertion | §4 header block; the mutated sha in §6.2 |

## 4. The full output — `check-task-api.ts`, exit 0

Every `400` body verbatim: the cycle path named, the dangling ids named, the
cross-project ids named, the bad write-set entry named
(`03-quality.md` §3.2 makes the pasted bodies the phase-3 gate).

**One line of this transcript is elided and says so inline**: case 11b's request
body, 201 write-set entries, 2834 bytes on one line. Nothing else is elided,
abbreviated or reflowed.

```
=== check-task-api.ts — build identity =======================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 3b54229
  git branch         : project/8c591d6c
  uncommitted (subj) : none
  sha256             : 0fd8c8f0767fdabc801cb23a28074aac03f870e4a24c2e449564ea88c142e9ba  forge-control/src/routes/projects.ts
  sha256             : 00f4c66bd128f0233613a58deac4afe3904f9deb4f27affe7eb5429a483cbb07  forge-control/src/lib/task-graph.ts
  sha256             : 50ba76906e166f3c5e835c2bf01d3b5abbf0690d15722e3dae3458e54b059de7  forge-control/src/db/projects.ts
  scratch database   : forge_tg_scratch (local; DSN never printed)
  throwaway schema   : tg_check_api
  schema reached by  : PGOPTIONS=-c search_path=tg_check_api (verified empirically; see header)
  bind               : http://127.0.0.1:7799/api/projects (never 7700)
  migrations applied : 20 (+1 forced content_jobs placeholder)
  cases to run       : 20
  assertions declared: 101
==============================================================================

  PROJECT_MAX_WORKSTREAMS (from the router module) = 6

--- 0. positive control: is the ROUTER reading the scratch schema? ------------
      GET /api/projects/00000000-0000-4000-8000-0000000000a1 → 200
      ok   router reads tg_check_api: project 00000000-0000-4000-8000-0000000000a1 found, 5 seeded tasks

--- case 1: role missing or unknown → 400 (existing message)
    1a role absent
      req  {"title":"c1a","brief":"b"}
      res  400 {"error":"role must be one of: architect, planner, scout, researcher, builder, reviewer, steward, tester"}
      ok   1a status — = 400
      ok   1a message — = "role must be one of: architect, planner, scout, researcher, builder, reviewer, steward, tester"
    1b role unknown
      req  {"role":"wizard","title":"c1b","brief":"b"}
      res  400 {"error":"role must be one of: architect, planner, scout, researcher, builder, reviewer, steward, tester"}
      ok   1b status — = 400
      ok   1b message — = "role must be one of: architect, planner, scout, researcher, builder, reviewer, steward, tester"

--- case 2: round supplied but not a non-negative int4 → 400 (two operator rulings, round 213)
    2a round: "abc"
      req  {"role":"builder","title":"c2a","brief":"check-task-api.ts fixture body — never executed by any agent.","round":"abc"}
      res  400 {"error":"round must be a non-negative integer"}
      ok   2a status — = 400
      ok   2a message — = "round must be a non-negative integer"
    2b round: -1
      req  {"role":"builder","title":"c2b","brief":"check-task-api.ts fixture body — never executed by any agent.","round":-1}
      res  400 {"error":"round must be a non-negative integer"}
      ok   2b status — = 400
      ok   2b message — = "round must be a non-negative integer"
    2c round: 1.5 (ruling 1)
      req  {"role":"builder","title":"c2c","brief":"check-task-api.ts fixture body — never executed by any agent.","round":1.5}
      res  400 {"error":"round must be a non-negative integer"}
      ok   2c status is 400 and NOT 500 — = 400
      ok   2c message — = "round must be a non-negative integer"
    2d round: 2147483648 (ruling 2, F2)
      req  {"role":"builder","title":"c2d","brief":"check-task-api.ts fixture body — never executed by any agent.","round":2147483648}
      res  400 {"error":"round must be at most 2147483647 (project_tasks.round is a 32-bit integer); got 2147483648"}
      ok   2d status is 400 and NOT 500 — = 400
      ok   2d message names the bound — body names "at most 2147483647"
      ok   2d message names the offending value — body names "got 2147483648"
    2e round: 2147483647 (the boundary, accepted)
      req  {"role":"builder","title":"c2e boundary","brief":"check-task-api.ts fixture body — never executed by any agent.","round":2147483647}
      res  201 {"task":{"id":"9436ddd4-5d4d-44d8-99b1-277f2e00001e","project_id":"00000000-0000-4000-8000-0000000000a1","round":2147483647,"role":"builder","title":"c2e boundary","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.413471+00","updated_at":"2026-08-17 18:33:10.413471+00"}}
      ok   2e status — = 201
      ok   2e stored round is int4's maximum — = 2147483647

--- case 3: title or brief missing → 400 (existing messages)
    3a title absent
      req  {"role":"builder","brief":"b"}
      res  400 {"error":"title required"}
      ok   3a status — = 400
      ok   3a message — = "title required"
    3b brief absent
      req  {"role":"builder","title":"c3b"}
      res  400 {"error":"brief required"}
      ok   3b status — = 400
      ok   3b message — = "brief required"

--- case 4: tier unknown → 400 (existing message)
    4 tier: "wizard"
      req  {"role":"builder","title":"c4","brief":"check-task-api.ts fixture body — never executed by any agent.","tier":"wizard"}
      res  400 {"error":"tier must be one of: fast, junior, standard, flagship"}
      ok   4 status — = 400
      ok   4 message — = "tier must be one of: fast, junior, standard, flagship"

--- case 5: depends_on present and not an array of uuid strings → 400
    5a depends_on: "x"
      req  {"role":"builder","title":"c5a","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":"x"}
      res  400 {"error":"depends_on must be an array of task uuids"}
      ok   5a status — = 400
      ok   5a message — = "depends_on must be an array of task uuids"
    5b depends_on: ["not-a-uuid"]
      req  {"role":"builder","title":"c5b","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["not-a-uuid"]}
      res  400 {"error":"depends_on must be an array of task uuids"}
      ok   5b status — = 400
      ok   5b message — = "depends_on must be an array of task uuids"
    5c depends_on: [123] (non-string element)
      req  {"role":"builder","title":"c5c","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":[123]}
      res  400 {"error":"depends_on must be an array of task uuids"}
      ok   5c status — = 400
      ok   5c message — = "depends_on must be an array of task uuids"
    5d depends_on: null (explicit null)
      req  {"role":"builder","title":"c5d","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":null}
      res  400 {"error":"depends_on must be an array of task uuids"}
      ok   5d status — = 400
      ok   5d message — = "depends_on must be an array of task uuids"

--- case 6: depends_on names ids that exist in NO project → 400 naming them (R27)
    6a one unknown id
      req  {"role":"builder","title":"c6a","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000d1"]}
      res  400 {"error":"depends_on names 1 dependency id(s) that do not exist: 00000000-0000-4000-8000-0000000000d1","unknown_dependencies":["00000000-0000-4000-8000-0000000000d1"]}
      ok   6a status — = 400
      ok   6a message names the id — body names "do not exist: 00000000-0000-4000-8000-0000000000d1"
      ok   6a unknown_dependencies — ["00000000-0000-4000-8000-0000000000d1"]
    6b unknown + cross-project in one body
      req  {"role":"builder","title":"c6b","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000d1","00000000-0000-4000-8000-0000000000c1"]}
      res  400 {"error":"depends_on names 1 dependency id(s) that do not exist: 00000000-0000-4000-8000-0000000000d1","unknown_dependencies":["00000000-0000-4000-8000-0000000000d1"]}
      ok   6b status — = 400
      ok   6b message is the unknown-id family — body names "do not exist"
      ok   6b unknown_dependencies alone — ["00000000-0000-4000-8000-0000000000d1"]
      ok   6b carries no cross_project_dependencies — body omits "cross_project_dependencies"

--- case 7: depends_on names ids belonging to ANOTHER project → 400 naming them (R27)
    7 cross-project dependency
      req  {"role":"builder","title":"c7","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000c1"]}
      res  400 {"error":"depends_on names 1 dependency id(s) belonging to another project: 00000000-0000-4000-8000-0000000000c1","cross_project_dependencies":["00000000-0000-4000-8000-0000000000c1"]}
      ok   7 status — = 400
      ok   7 message names the id — body names "belonging to another project: 00000000-0000-4000-8000-0000000000c1"
      ok   7 cross_project_dependencies — ["00000000-0000-4000-8000-0000000000c1"]

--- case 8: depends_on would close a cycle → 400 naming the PATH (R25)
    8 depends_on: [cycle node A]
      req  {"role":"builder","title":"c8","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000b4"]}
      res  400 {"error":"depends_on would close a cycle: cycle node A (00000000-0000-4000-8000-0000000000b4) -> cycle node B (00000000-0000-4000-8000-0000000000b5) -> cycle node A (00000000-0000-4000-8000-0000000000b4)","cycle":[{"id":"00000000-0000-4000-8000-0000000000b4","title":"cycle node A"},{"id":"00000000-0000-4000-8000-0000000000b5","title":"cycle node B"},{"id":"00000000-0000-4000-8000-0000000000b4","title":"cycle node A"}]}
      ok   8 status — = 400
      ok   8 message opens with the cycle family — body names "depends_on would close a cycle: "
      ok   8 cycle ids in order — ["00000000-0000-4000-8000-0000000000b4","00000000-0000-4000-8000-0000000000b5","00000000-0000-4000-8000-0000000000b4"]
      ok   8 message uses the house separator — body names " -> "
      ok   8 message names a title, not just an id — body names "cycle node B"

--- case 9: workstream invalid → 400 with validateWorkstream's message (R28/R4)
    9a workstream: "UI Team"
      req  {"role":"builder","title":"c9a","brief":"check-task-api.ts fixture body — never executed by any agent.","workstream":"UI Team"}
      res  400 {"error":"task-graph: validateWorkstream(): \"UI Team\" is not a legal workstream name; it must match ^[a-z0-9][a-z0-9-]{0,39}$ — character for character the CHECK constraint project_tasks_workstream_chk in db/migrations/0040_task_graph.sql (R28, R4)"}
      ok   9a status — = 400
      ok   9a message is validateWorkstream's — body names "task-graph: validateWorkstream()"
      ok   9a message quotes the offender — body names "\"UI Team\""
    9b workstream: 42 (non-string)
      req  {"role":"builder","title":"c9b","brief":"check-task-api.ts fixture body — never executed by any agent.","workstream":42}
      res  400 {"error":"workstream must be a string; got number"}
      ok   9b status — = 400
      ok   9b message — = "workstream must be a string; got number"
      ok   9b did not reach validateWorkstream — body omits "validateWorkstream"

--- case 10: a write_set entry invalid → 400 with normaliseWritePath's message (R28)
    10a write_set: ["/etc/passwd"]
      req  {"role":"builder","title":"c10a","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":["/etc/passwd"]}
      res  400 {"error":"task-graph: normaliseWritePath(): a write_set entry must be repo-relative, never absolute: \"/etc/passwd\" (R28)"}
      ok   10a status — = 400
      ok   10a message is normaliseWritePath's — body names "task-graph: normaliseWritePath()"
      ok   10a message names the entry — body names "\"/etc/passwd\""
    10b write_set: ["src/../../etc/x"]
      req  {"role":"builder","title":"c10b","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":["src/../../etc/x"]}
      res  400 {"error":"task-graph: normaliseWritePath(): a write_set entry must not contain a '..' path segment: \"src/../../etc/x\" (R28)"}
      ok   10b status — = 400
      ok   10b message names the rule — body names "'..' path segment"
      ok   10b message names the entry — body names "\"src/../../etc/x\""

--- case 11: write_set not an array, or > 200 entries → 400
    11a write_set: "src/a.ts"
      req  {"role":"builder","title":"c11a","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":"src/a.ts"}
      res  400 {"error":"write_set must be an array of at most 200 repo-relative paths"}
      ok   11a status — = 400
      ok   11a message — = "write_set must be an array of at most 200 repo-relative paths"
    11b write_set: 201 entries
      req  {"role":"builder","title":"c11b","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":["src/f0.ts","src/f1.ts", … ,"src/f200.ts"]}      [201 entries; this ONE line elided from 2834 bytes, nothing else in this transcript is]
      res  400 {"error":"write_set must be an array of at most 200 repo-relative paths"}
      ok   11b status — = 400
      ok   11b message — = "write_set must be an array of at most 200 repo-relative paths"
    11c write_set: [42] (non-string element)
      req  {"role":"builder","title":"c11c","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":[42]}
      res  400 {"error":"write_set must be an array of at most 200 repo-relative paths"}
      ok   11c status — = 400
      ok   11c message is row 11's, not normaliseWritePath's — = "write_set must be an array of at most 200 repo-relative paths"
    11d write_set: null (explicit null)
      req  {"role":"builder","title":"c11d","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":null}
      res  400 {"error":"write_set must be an array of at most 200 repo-relative paths"}
      ok   11d status — = 400
      ok   11d message — = "write_set must be an array of at most 200 repo-relative paths"

--- case 12: computed round leaves its phase block → 400 with computeRound's message (R24)
    12 dep at round 399, round omitted
      req  {"role":"builder","title":"c12","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000b3"]}
      res  400 {"error":"task-graph: computeRound(): computed round 400 leaves phase block 3 (rounds 300-399), the block of its shallowest dependency at round 399; a phase has 99 depth levels and this would be the 100th (R24)"}
      ok   12 status — = 400
      ok   12 message is computeRound's — body names "task-graph: computeRound()"
      ok   12 message names the computed round and block — body names "computed round 400 leaves phase block 3"
      ok   12 message names the requirement — body names "(R24)"

--- case 13: project would exceed the workstream cap → 400 (R39)
    13 seventh workstream on a capped project
      req  {"role":"builder","title":"c13","brief":"check-task-api.ts fixture body — never executed by any agent.","workstream":"zeta"}
      res  400 {"error":"project already has 6 workstream(s) (limit PROJECT_MAX_WORKSTREAMS=6): alpha, beta, delta, epsilon, gamma, main; refusing to create a task in new workstream \"zeta\""}
      ok   13 status — = 400
      ok   13 message names the limit — body names "limit PROJECT_MAX_WORKSTREAMS=6"
      ok   13 message lists the workstreams sorted — body names "alpha, beta, delta, epsilon, gamma, main"
      ok   13 message names the refused workstream — body names "new workstream \"zeta\""

--- case 14: strict_write_sets + builder/tester with empty write_set → 400 (R31)
    14a builder, no write_set, strict project
      req  {"role":"builder","title":"c14a","brief":"check-task-api.ts fixture body — never executed by any agent."}
      res  400 {"error":"this project sets metadata.strict_write_sets: a builder task requires a non-empty write_set"}
      ok   14a status — = 400
      ok   14a message names the flag — body names "metadata.strict_write_sets"
      ok   14a message names the rule — body names "builder task requires a non-empty write_set"
    14b tester, write_set: [] , strict project
      req  {"role":"tester","title":"c14b","brief":"check-task-api.ts fixture body — never executed by any agent.","write_set":[]}
      res  400 {"error":"this project sets metadata.strict_write_sets: a tester task requires a non-empty write_set"}
      ok   14b status — = 400
      ok   14b message names the role — body names "tester task requires a non-empty write_set"
    14c reviewer, no write_set, strict project
      req  {"role":"reviewer","title":"c14c","brief":"check-task-api.ts fixture body — never executed by any agent."}
      res  201 {"task":{"id":"e47a890c-874f-4c6d-9f71-a1d91e62ec5b","project_id":"00000000-0000-4000-8000-0000000000a3","round":0,"role":"reviewer","title":"c14c","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.482166+00","updated_at":"2026-08-17 18:33:10.482166+00"}}
      ok   14c status — = 201
      ok   14c reviewer row was created — = "reviewer"

--- case 15: identical body POSTed twice → 409, and exactly ONE row (R30)
    15a first POST
      req  {"role":"builder","title":"c15 idempotency subject","brief":"check-task-api.ts fixture body — never executed by any agent.","round":500}
      res  201 {"task":{"id":"705905cc-f011-45fc-8934-8213e45f532c","project_id":"00000000-0000-4000-8000-0000000000a1","round":500,"role":"builder","title":"c15 idempotency subject","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.485936+00","updated_at":"2026-08-17 18:33:10.485936+00"}}
      ok   15a status — = 201
    15b identical POST
      req  {"role":"builder","title":"c15 idempotency subject","brief":"check-task-api.ts fixture body — never executed by any agent.","round":500}
      res  409 {"task":{"id":"705905cc-f011-45fc-8934-8213e45f532c","project_id":"00000000-0000-4000-8000-0000000000a1","round":500,"role":"builder","title":"c15 idempotency subject","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.485936+00","updated_at":"2026-08-17 18:33:10.485936+00"},"error":"duplicate task: this project already has a task with that round/role/title"}
      ok   15b status — = 409
      ok   15b message — body names "duplicate task"
      ok   15b returned the same task id — = "705905cc-f011-45fc-8934-8213e45f532c"
      ok   15c exactly one row exists (psql, not the API) — = "1"

--- case 16: depends_on ABSENT → 201, stored as SQL NULL — the legacy sentinel (E2)
    16 depends_on absent
      req  {"role":"builder","title":"c16 legacy sentinel","brief":"check-task-api.ts fixture body — never executed by any agent.","round":501}
      res  201 {"task":{"id":"49986ee4-7e79-49e1-a72b-8b849cae31dd","project_id":"00000000-0000-4000-8000-0000000000a1","round":501,"role":"builder","title":"c16 legacy sentinel","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.537939+00","updated_at":"2026-08-17 18:33:10.537939+00"}}
      ok   16 status — = 201
      ok   16 stored depends_on IS NULL (psql) — = "t"
      ok   16 the column is NULL, not an empty array — = "NULL"

--- case 17: depends_on: [] → 201, stored as '{}' — a graph ROOT, not NULL
    17 depends_on: []
      req  {"role":"builder","title":"c17 explicit root","brief":"check-task-api.ts fixture body — never executed by any agent.","round":502,"depends_on":[]}
      res  201 {"task":{"id":"149def39-ba72-4c0d-be2a-959d4966250a","project_id":"00000000-0000-4000-8000-0000000000a1","round":502,"role":"builder","title":"c17 explicit root","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":[],"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.627502+00","updated_at":"2026-08-17 18:33:10.627502+00"}}
      ok   17 status — = 201
      ok   17 stored depends_on IS NOT NULL (psql) — = "f"
      ok   17 stored depends_on is the empty array — = "{}"
      ok   16 vs 17 are distinguishable in one query — = "c16 legacy sentinel=NULL|c17 explicit root={}"

--- case 18: round omitted, deps at rounds {300, 305} → 201 with round 306 (R23)
    18 round omitted, two deps
      req  {"role":"builder","title":"c18 computed round","brief":"check-task-api.ts fixture body — never executed by any agent.","depends_on":["00000000-0000-4000-8000-0000000000b1","00000000-0000-4000-8000-0000000000b2"]}
      res  201 {"task":{"id":"37d8f4d4-1bd2-4cb0-a6f7-607cfb0b0c76","project_id":"00000000-0000-4000-8000-0000000000a1","round":306,"role":"builder","title":"c18 computed round","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":["00000000-0000-4000-8000-0000000000b1","00000000-0000-4000-8000-0000000000b2"],"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.76653+00","updated_at":"2026-08-17 18:33:10.76653+00"}}
      ok   18 status — = 201
      ok   18 response round is 1 + max(dep.round) — = 306
      ok   18 stored round is 306 (psql) — = "306"

--- case 19: round SUPPLIED (700) is honoured untouched, even with deps (R23/E1)
    19 round 700 supplied with deps
      req  {"role":"builder","title":"c19 supplied round","brief":"check-task-api.ts fixture body — never executed by any agent.","round":700,"depends_on":["00000000-0000-4000-8000-0000000000b1","00000000-0000-4000-8000-0000000000b2"]}
      res  201 {"task":{"id":"e16f5978-82e2-4646-bac5-2d80a5c76920","project_id":"00000000-0000-4000-8000-0000000000a1","round":700,"role":"builder","title":"c19 supplied round","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":["00000000-0000-4000-8000-0000000000b1","00000000-0000-4000-8000-0000000000b2"],"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.820994+00","updated_at":"2026-08-17 18:33:10.820994+00"}}
      ok   19 status — = 201
      ok   19 response round is the supplied 700, not 306 — = 700
      ok   19 stored round is 700 (psql) — = "700"

--- case 20: workstream + write_set valid → 201, write_set stored NORMALISED (R28)
    20 workstream ui, write_set needing normalisation
      req  {"role":"builder","title":"c20 normalised write set","brief":"check-task-api.ts fixture body — never executed by any agent.","round":503,"workstream":"ui","write_set":["./src/a.ts","src//b.ts"]}
      res  201 {"task":{"id":"2ebf0da1-32c1-4c13-9c41-62a8bcecd0d9","project_id":"00000000-0000-4000-8000-0000000000a1","round":503,"role":"builder","title":"c20 normalised write set","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"ui","write_set":["src/a.ts","src/b.ts"],"created_at":"2026-08-17 18:33:10.87251+00","updated_at":"2026-08-17 18:33:10.87251+00"}}
      ok   20 status — = 201
      ok   20 workstream stored — = "ui"
      ok   20 write_set stored normalised (psql) — = "{src/a.ts,src/b.ts}"
      ok   20 workstream stored (psql) — = "ui"

--- census -------------------------------------------------------------------
  cases planned              : 20
  cases that ran an assertion: 20
  assertions declared        : 101
  assertions executed        : 101
  assertions failed          : 0

PASS — 20 cases, every declared assertion executed and green: the fifteen 400 families (R22, R22a, R24, R25, R27, R28, R31, R39), the 409 (R30), and the happy paths — the NULL-vs-'{}' sentinel (E2), the computed and the supplied round, the normalised write-set, and int4's maximum accepted at the bound.
  teardown           : schema tg_check_api dropped, :7799 closed
```

## 5. The operator ruling — a fractional round, measured on both sides

Round 212 found its own brief self-contradictory: told twice to keep today's
round guard exactly (`Number(...)` + `isFinite` + `>= 0`, which **accepts**
`1.5`) while the contract table says *"finite integer"*, it kept the expression
verbatim and reported the conflict rather than guessing. The ruling: **add
`Number.isInteger`; a supplied round of `1.5` returns 400.**

### 5.1 Before — what `1.5` actually did, at `b1bb731`

Case 2c against unmodified round-212 bytes, at `b1bb731`, with
`routes/projects.ts` at sha256 `8baa3346…`. This is the measurement the ruling
predicted, not an argument for it.

Read from `2b` for context. **Case 2c prints no `2c round: 1.5` label here**,
and that is itself instrument history rather than a missing line: `post()`
prints the exchange *after* the response resolves, and this response never
resolved — the harness threw inside `JSON.parse`. §5.4 is the hardening that
fixed it, and §5.3 shows the label present afterwards. The line numbers in the
two stack traces below are the runtime's own, from the **pre-hardening**
harness; they are output, not citations, and resolve against nothing that
shipped.

```
    2b round: -1
      req  {"role":"builder","title":"c2b","brief":"check-task-api.ts fixture body — never executed by any agent.","round":-1}
      res  400 {"error":"round must be a non-negative integer"}
      ok   2b status — = 400
      ok   2b message — = "round must be a non-negative integer"
error: invalid input syntax for type integer: "1.5"
    at /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/node_modules/.pnpm/pg-pool@3.14.0_pg@8.21.0/node_modules/pg-pool/index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async createTask (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/src/db/projects.ts:405:13)
    at async Array.<anonymous> (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/src/routes/projects.ts:617:29)
    at async <anonymous> (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:1053:26) {
  length: 146,
  severity: 'ERROR',
  code: '22P02',
  detail: undefined,
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: "unnamed portal parameter $2 = '...'",
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'numutils.c',
  line: '617',
  routine: 'pg_strtoint32_safe'
}
      ERROR case 2 threw: SyntaxError: Unexpected token 'I', "Internal S"... is not valid JSON
    at JSON.parse (<anonymous>)
    at request (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:409:35)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async post (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:422:17)
    at async Object.run (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:560:26)
    at async main (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:1118:9)
      MISSED case 2 declares 6 assertion(s) but executed 4 — a case that does not run what it declares cannot certify anything.
…
--- census -------------------------------------------------------------------
  cases planned              : 20
  cases that ran an assertion: 20
  assertions declared        : 96
  assertions executed        : 94
  assertions failed          : 1
  FAIL executed 94 assertions but 96 are declared
FAILED — 1 case(s): 2
  teardown           : schema tg_check_api dropped, :7799 closed
```

`1.5` reached the `INSERT` and Postgres refused it: SQLSTATE **22P02**, out of
`pg_strtoint32_safe`. Hono answers an unhandled throw with a plain-text
`Internal Server Error` — a **500**, telling the caller the server is broken
when the truth is that the request was malformed.

### 5.2 The amendment, where it is enforced

`forge-control/src/routes/projects.ts`, the supplied-round guard in the
`POST /:id/tasks` handler:

```diff
-    if (!Number.isFinite(round) || round < 0) {
+    if (!Number.isInteger(round) || round < 0) {
```

with the reasoning inline beside it, in the same commit (`ba09b2a`, standing
rule 2). `Number.isInteger` implies finite, so the old clause is subsumed rather
than dropped. It changes behaviour that was never previously a `400`, in the one
safe direction: **a 500 becomes a 400.** Nothing that currently succeeds starts
failing.

### 5.3 After

```
    2c round: 1.5 (the ruling)
      req  {"role":"builder","title":"c2c","brief":"check-task-api.ts fixture body — never executed by any agent.","round":1.5}
      res  400 {"error":"round must be a non-negative integer"}
      ok   2c status is 400 and NOT 500 — = 400
```

### 5.4 One instrument change the failure forced, disclosed

The pre-amendment run died inside the harness with
`SyntaxError: Unexpected token 'I'` — `JSON.parse` on Hono's plain-text 500 body.
The harness now returns a non-JSON body verbatim as `text` with an empty parsed
`body`, so the case fails on its **status assertion** and the transcript shows
the 500. A harness that reports a `SyntaxError` about itself, when the finding is
a 500 from the API, is an instrument obscuring its own measurement.

## 6. The probe, observed failing

### 6.1 Why this section exists

A probe never observed failing is not an instrument. §4 shows 101 green
assertions; on its own that is equally consistent with 101 assertions that
cannot go red.

**This section's transcripts were taken at `ba09b2a`**, before ruling 2 added
case 2's fourth and fifth probes, so its counts read 96 rather than §4's 101.
They are not re-run against `3b54229`: the mutation targets the sentinel at the
`createTask` call, which ruling 2 did not touch, and re-running a mutation
against newer bytes to make two numbers match would be cosmetic. The sha256 in
each transcript says which tree it was taken against, which is the whole reason
it is printed.

### 6.2 Mutation — the sentinel flipped, case 16 goes red

The cleanest single mutation available: make the `depends_on`-absent path pass
`[]` instead of `undefined` at the `createTask` call in `routes/projects.ts` —
the E2 deploy race, re-opened in one character sequence.

```diff
-    depends_on: dependsOn,
+    depends_on: dependsOn ?? [],
```

The mutation was applied to the working tree, measured, and reverted. **It is
not in any commit** — it was taken at `ba09b2a`, between the two rulings, so the
restored sha256 it prints is that commit's `b55c7c29…` and not §1's `0fd8c8f0…`;
under the mutation the same line of the build-identity block read
`2378478dcf1312c3471f6de7733c6e74b88293fbcd220d47fea6a61cc15f0d2f` and
`uncommitted (subj) : M forge-control/src/routes/projects.ts`. The instrument
named its own contamination, which is the point of printing the sha256 at all.

```
--- case 16: depends_on ABSENT → 201, stored as SQL NULL — the legacy sentinel (E2)
    16 depends_on absent
      req  {"role":"builder","title":"c16 legacy sentinel","brief":"check-task-api.ts fixture body — never executed by any agent.","round":501}
      res  201 {"task":{"id":"2e1383ed-2f60-4fe4-bd57-adc359f80600","project_id":"00000000-0000-4000-8000-0000000000a1","round":501,"role":"builder","title":"c16 legacy sentinel","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":[],"workstream":"main","write_set":[],"created_at":"2026-08-17 18:19:16.500704+00","updated_at":"2026-08-17 18:19:16.500704+00"}}
      ok   16 status — = 201
      FAIL 16 stored depends_on IS NULL (psql) — expected "t", got "f"
      MISSED case 16 declares 3 assertion(s) but executed 2 — a case that does not run what it declares cannot certify anything.

--- case 17: depends_on: [] → 201, stored as '{}' — a graph ROOT, not NULL
    17 depends_on: []
      req  {"role":"builder","title":"c17 explicit root","brief":"check-task-api.ts fixture body — never executed by any agent.","round":502,"depends_on":[]}
      res  201 {"task":{"id":"d7163094-e3d3-4508-a7db-15276773dcee","project_id":"00000000-0000-4000-8000-0000000000a1","round":502,"role":"builder","title":"c17 explicit root","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":[],"workstream":"main","write_set":[],"created_at":"2026-08-17 18:19:16.548272+00","updated_at":"2026-08-17 18:19:16.548272+00"}}
      ok   17 status — = 201
      ok   17 stored depends_on IS NOT NULL (psql) — = "f"
      ok   17 stored depends_on is the empty array — = "{}"
      FAIL 16 vs 17 are distinguishable in one query — expected "c16 legacy sentinel=NULL|c17 explicit root={}", got "c16 legacy sentinel={}|c17 explicit root={}"

--- case 18: round omitted, deps at rounds {300, 305} → 201 with round 306 (R23)
```

and the run refused to certify:

```
--- census -------------------------------------------------------------------
  cases planned              : 20
  cases that ran an assertion: 20
  assertions declared        : 96
  assertions executed        : 95
  assertions failed          : 2
  FAIL executed 95 assertions but 96 are declared

FAILED — 2 case(s): 16, 17
  teardown           : schema tg_check_api dropped, :7799 closed
```

Two things to read here. Case 16 goes red on the **psql** assertion, not on the
API's JSON — the API returned `201` and its serialized `depends_on` was `[]`,
which is exactly the shape failure mode (e) describes as indistinguishable from
absence. And case 17 stayed green on its own two assertions while its **joint**
query caught the collapse: `c16 legacy sentinel={}|c17 explicit root={}` where
the contract says `c16 legacy sentinel=NULL|c17 explicit root={}`. The sentinel
is proved by the pair, not by either row alone.

### 6.3 Restored, green again

After reverting, the same command exited 0 with 96/96 at `ba09b2a`, and case 16
is green in §4's `3b54229` run at 101/101 —
`16 stored depends_on IS NULL (psql) — = "t"` in both.

## 7. Findings — where the contract and the shipped code disagreed

**Nineteen of twenty cases agreed with the contract on the first run**, against
unmodified round-212 bytes, including all five of the gap specifications the
round-213 brief made rather than left to guesswork: non-string elements in
`depends_on` (row 5's message) and in `write_set` (row 11's, **not**
`normaliseWritePath`'s), a non-string `workstream` (its own message), explicit
JSON `null` for either array (refused, never read as absent), and the separator
bytes — `", "` between ids, `" -> "` between cycle nodes, workstream names
**sorted** in row 13. Each is asserted in §4 and each was already right.

### F1 — a fractional round was a 500 (RESOLVED)

§5. Found by round 212 as a reading conflict, ruled by the operator, amended
where it is enforced, and exercised by case 2c. Closed.

### F2 — a round above int4 was a 500 (RESOLVED by operator ruling 2)

**Raised as OPEN by this task, ruled the same round, and closed in `3b54229`.**
Recorded in full because the decision, not just the diff, is what the next
reader needs.

`Number.isInteger(2147483648)` is `true`, so ruling 1's guard passed it, and
`project_tasks.round` is declared `round int` in
`db/migrations/0030_coding_projects.sql`. Measured with case 2d **before** the
bound existed:

```
error: value "2147483648" is out of range for type integer
    at /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/node_modules/.pnpm/pg-pool@3.14.0_pg@8.21.0/node_modules/pg-pool/index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async createTask (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/src/db/projects.ts:405:13)
    at async Array.<anonymous> (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/src/routes/projects.ts:638:29)
    at async <anonymous> (/opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/check-task-api.ts:1095:26) {
  length: 153,
  severity: 'ERROR',
  code: '22003',
  detail: undefined,
  hint: undefined,
  position: undefined,
  internalPosition: undefined,
  internalQuery: undefined,
  where: "unnamed portal parameter $2 = '...'",
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'numutils.c',
  line: '611',
  routine: 'pg_strtoint32_safe'
}
    2d round: 2147483648 (ruling 2, F2)
      req  {"role":"builder","title":"c2d","brief":"check-task-api.ts fixture body — never executed by any agent.","round":2147483648}
      res  500 Internal Server Error
      FAIL 2d status is 400 and NOT 500 — expected 400, got 500
      MISSED case 2 declares 9 assertion(s) but executed 7 — a case that does not run what it declares cannot certify anything.
```

SQLSTATE **22003**, `integer out of range`, out of `pg_strtoint32_safe` — F1's
exact mechanism at the other end of the same expression. Note that the harness
reported it as `res  500 Internal Server Error` and failed on the **status**,
rather than dying inside `JSON.parse` as it did for F1: §5.4's hardening paying
for itself one ruling later.

**What this builder did NOT do, and why it was right not to.** No fix, and no
assertion in either direction. Contract row 2 refused a round that is not a
non-negative *finite integer*; `2147483648` **is** one, so the table as written
said accept it — and accepting it means widening the column, a schema decision
nobody had made. Writing an assertion for either behaviour would have been this
builder choosing between them under cover of a green check.

**The ruling.** Bound the guard to int4; `2147483648` returns `400`. Widening
`project_tasks.round` to `bigint` was rejected on R19's grounds: `round` is
becoming a DERIVED value — `taskDepth()`'s longest-path depth from the roots —
and a dependency graph's depth cannot approach 2³¹, so a wider column would be a
migration, a fresh deploy-window risk and permanent dead weight bought to store
a value the engine will never legitimately produce. Meanwhile `2147483648` is
unambiguously caller input, and this phase's own design says caller input is
`400` and corrupt stored state is `500`.

**After**, at `3b54229`:

```
    2d round: 2147483648 (ruling 2, F2)
      req  {"role":"builder","title":"c2d","brief":"check-task-api.ts fixture body — never executed by any agent.","round":2147483648}
      res  400 {"error":"round must be at most 2147483647 (project_tasks.round is a 32-bit integer); got 2147483648"}
      ok   2d status is 400 and NOT 500 — = 400
      ok   2d message names the bound — body names "at most 2147483647"
      ok   2d message names the offending value — body names "got 2147483648"
    2e round: 2147483647 (the boundary, accepted)
      req  {"role":"builder","title":"c2e boundary","brief":"check-task-api.ts fixture body — never executed by any agent.","round":2147483647}
      res  201 {"task":{"id":"9436ddd4-5d4d-44d8-99b1-277f2e00001e","project_id":"00000000-0000-4000-8000-0000000000a1","round":2147483647,"role":"builder","title":"c2e boundary","brief":"check-task-api.ts fixture body — never executed by any agent.","status":"pending","run_id":null,"fix_cycle":0,"tier":null,"attempt":0,"chain_key":null,"depends_on":null,"workstream":"main","write_set":[],"created_at":"2026-08-17 18:33:10.413471+00","updated_at":"2026-08-17 18:33:10.413471+00"}}
```

**Two deviations from the ruling's letter, both deliberate and disclosed.**

1. *"One line"* became one line plus its own message. `2147483648` **is** a
   non-negative integer, so reusing `round must be a non-negative integer` would
   tell the caller something false about their own input — the same misleading
   response both rulings exist to remove. The precedent is case 9b: a non-string
   `workstream` gets its own message rather than borrowing
   `validateWorkstream()`'s for a value that function never judged. The
   pre-existing message is untouched for the inputs that always produced it
   (2a, 2b, 2c), so row 2's *"existing message"* clause still holds where it
   applied.
2. **Case 2e was added, which the ruling did not ask for**: `2147483647` is
   POSTed and must be **accepted**, `201`, stored. A bound that refused the
   largest legal value would be an off-by-one nobody notices until a real round
   sits on the edge — a gate that cannot be passed (standing rule 2). The
   boundary is asserted, not assumed.

**Row 2 amended where it is enforced, in the same commit.** The fifteen-row
contract table lives in the round-212/213 task briefs, not in this repo; its
durable statement in the corpus was **R22**'s *"every existing field keeps its
exact current validation"*, which two rulings have now made false.
`01-requirements.md` §C therefore gains **R22a** — the guard's three clauses,
both `500`→`400` moves with their SQLSTATEs, the rejected `bigint` alternative
with its reason, and the proof named — and R22 points at it instead of claiming
the round validation is untouched. Fixing the code without fixing the table
would have left the next reader with the same question that produced two rounds
of ambiguity.

### F3 — no unsatisfiable gate was found in phase 3's gate list

Checked each clause of `03-quality.md` §3.2, *Phase 3*, against an artefact:

| gate clause | discharged by | state |
|---|---|---|
| "`check-task-api.ts` green, with the 400 bodies pasted — cycle path named, dangling ids named, bad write-set entry named" | §4, in full | satisfied |
| "The cycle table (R25) is complete: seven rows, each asserting the path's ids" | **builder 1's** `task-graph.test.ts` (`88a20e4`), not this script — its final message reports a seven-row table asserting ids in order, and mutation (a), `findCycle → []`, failing the deep-equal | satisfied elsewhere; named here so the reviewer does not hunt for seven rows in `check-task-api.ts`, which asserts the API-level cycle once, as case 8 |
| "The reviewer confirms R26's belt comment exists and is honest" | `findCycle`'s doc-comment in `lib/task-graph.ts` | the reviewer's, not mine |
| "Double-POST with an identical body → exactly one row, 409 (R30)" | §4 case 15, count through `psql` | satisfied |

Nothing here demands a threshold no artefact can reach, so nothing needed
amending. The one amendment this round did make is §5.2, and it is a code
expression, not a gate clause.

## 8. Builders 1–3, in their own words

Fetched read-only from `GET /api/chat/<run-id>` on `:7700` — the last assistant
message of each builder's run — rather than reconstructed. Quoted, not
paraphrased.

### 8.1 Builder 1's five mutations (`88a20e4`, `lib/task-graph.ts`)

> **Verification**: `pnpm typecheck` clean; `pnpm test` 970 pass / 0 fail / 0
> skipped / 0 todo; `check-corpus-map.py` exit 0. All five mutations observed red
> and restored — (a) `findCycle → []` fails the deep-equal on
> `['a','b','c','a']`, not a length; (b) skipping R24 → "Missing expected
> exception"; (c) `base` from max → exactly the `{199,205}` case (proving it
> distinguishes the two readings); (d) `.includes("..")` → `a..b.ts` refused;
> (e) reworded message → `computeRound() threw without the expected diagnostic`,
> proving the helper reads `.message`.

**Gap named rather than papered over:** builder 1's message reports the five
mutations as a summary and says the transcripts *"are in the commit message and
in my manager report"* — it does not paste the five raw transcripts. Round 213
did not re-run them: they belong to `task-graph.test.ts`, which is not this
task's file, and re-running them would mean mutating a sibling's committed
module. **What round 213 can vouch for independently** is that the same four
symbols are exercised through the API in §4 — `computeRound` (cases 12, 18, 19),
`findCycle` with its ids in order (case 8), `normaliseWritePath` (cases 10, 20),
`validateWorkstream` (case 9) — and that each names its offender in the response
body. Mutation (c), the `{199,205}` shallowest-vs-deepest discrimination, is a
unit-level distinction the API cannot reach; it stays builder 1's evidence, and
the phase-3 reviewer should read it there.

Builder 1 also flagged, and it holds:

> **`GraphValidationError` is builder 3's 400; `GraphIntegrityError` stays the
> 500.** Don't collapse them.

§4 confirms the split at the wire: every `GraphValidationError` family (cases 9,
10, 12) arrives as a `400` carrying the module's message verbatim, and no case
produced a `500`.

### 8.2 Builder 2's INSERT walk (`87b7743`, `db/projects.ts`)

> **The statement it emits, quoted from source**
>
> ```
> INSERT INTO project_tasks (project_id, round, role, title, brief, fix_cycle, tier,
>                                 depends_on, workstream, write_set)
>      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10::text[])
>      ON CONFLICT (project_id, round, role, title) DO NOTHING
>      RETURNING <TASK_COLS>
> ```
>
> The four cases, walked against node-pg 8.21.0's own `prepareValue()`
> (`/tmp/r211-insert-proof.mjs`, no database):
>
> | input | bound | on the wire | meaning |
> |---|---|---|---|
> | `undefined` | `null` | SQL NULL | legacy row |
> | `null` | `null` | SQL NULL | legacy row, explicitly |
> | `[]` | `[]` | `'{}'` | graph root, promotes immediately |
> | `[a,b]` | `[a,b]` | `'{a,b}'` | promotes when both done |
>
> `[]` and NULL take demonstrably different paths.

and, closing its own message:

> **Stated plainly:** this file cannot be unit-tested — a value import opens a pg
> Pool (NF3, R10) — so the proof above is textual and serializer-level, not
> behavioural. **The behavioural proof of this change is
> `scripts/checks/check-task-api.ts`, written by builder 4 in round 213.**

That proof is now in. Builder 2's walk was **textual**; §4 cases 16, 17 and 20
are the same four cases observed **in the column**:

| builder 2's row | round 213's case | what the database says |
|---|---|---|
| `undefined` → SQL NULL | 16 | `depends_on IS NULL` → `t`; `coalesce(depends_on::text,'NULL')` → `NULL` |
| `[]` → `'{}'` | 17 | `depends_on IS NULL` → `f`; `depends_on::text` → `{}` |
| both, distinguishable | 17 | `c16 legacy sentinel=NULL\|c17 explicit root={}` in one query |
| `[a,b]` → `'{a,b}'` | 18, 19 | stored `round` 306 and 700 computed from two real dependency rows |
| identity unchanged (R30) | 15 | 201 → 409, same task id, `count(*) = 1` |

The `null`-input row of builder 2's table is deliberately **not** reachable
through the API: at the wire boundary an explicit `"depends_on": null` is
refused with row 5's `400` (case 5d), because reinterpreting it as "make this a
legacy row" is a guess with the E2 deploy race behind it. Builder 2's `null`
branch remains correct for internal callers and is what `createFixChain` relies
on; the route simply never sends it.

### 8.3 Builder 3's nine unexercised rows (`5a1180d`, `routes/projects.ts`)

Builder 3 marked rows 6, 7, 8, 9, 12, 13, 14 *"written, **not exercised**"* and
rows 1–4 and 15 *"untouched"* / *"unchanged"*, concluding:

> Every "not exercised" row needs a database. Worktree-only plus NF3 forbid one
> from a build task, so **I did not exercise the route at all** — builder 4's
> `check-task-api.ts` in round 213 is the proof, against
> `$SCRATCH_DATABASE_URL`.

Every one of those rows is now exercised. §9 is the map.

## 9. Coverage — every contract row to the case that exercises it

| # | contract row | case | evidence in §4 |
|---|---|---|---|
| 1 | role missing/unknown → 400 | 1a, 1b | the eight-role message, both spellings |
| 2 | round not a non-negative **int4** → 400 (R22a) | 2a, 2b, **2c**, **2d**, **2e** | `"abc"`, `-1`, `1.5` (§5), `2147483648` (§7 F2), and `2147483647` **accepted** — the bound is passable |
| 3 | title or brief missing → 400 | 3a, 3b | `title required` / `brief required` |
| 4 | tier unknown → 400 | 4 | the four-tier message |
| 5 | `depends_on` not an array of uuid strings → 400 | 5a–5d | non-array, non-uuid, **non-string element**, **explicit null** |
| 6 | ids that exist in NO project → 400 (R27) | 6a, 6b | `unknown_dependencies` deep-equalled; both buckets firing, unknown returned first and **alone** |
| 7 | ids of ANOTHER project → 400 (R27) | 7 | `cross_project_dependencies` deep-equalled |
| 8 | would close a cycle → 400 (R25) | 8 | ids **in order** `[A, B, A]`, `" -> "` separator, a title named |
| 9 | workstream invalid → 400 (R28/R4) | 9a, 9b | `validateWorkstream`'s message verbatim; **non-string** gets its own and never reaches it |
| 10 | a write_set entry invalid → 400 (R28) | 10a, 10b | absolute path and `..` segment, entry quoted in both |
| 11 | write_set not an array, or > 200 → 400 | 11a–11d | string, 201 entries, **non-string element**, **explicit null** |
| 12 | computed round leaves its phase block → 400 (R24) | 12 | `computed round 400 leaves phase block 3` |
| 13 | workstream cap → 400 (R39) | 13 | `PROJECT_MAX_WORKSTREAMS=6`, names **sorted**, refused name quoted |
| 14 | strict_write_sets + builder/tester, empty write_set → 400 (R31) | 14a, 14b, **14c** | both refusals **and** the other branch: a reviewer without a write_set is created |
| 15 | identical body twice → 409, exactly ONE row (R30) | 15 | 201 → 409, same task id, `count(*) = 1` via psql |
| 16 | `depends_on` absent → 201, stored **SQL NULL** | 16 | `depends_on IS NULL` → `t` — the E2 sentinel |
| 17 | `depends_on: []` → 201, stored `'{}'`, not NULL | 17 | `IS NULL` → `f`, and both rows in one query |
| 18 | round omitted, deps at {300, 305} → 201, round 306 (R23) | 18 | response **and** stored round |
| 19 | round supplied (700) honoured, deps present (R23/E1) | 19 | response **and** stored round |
| 20 | workstream + write_set stored **normalised** (R28) | 20 | `["./src/a.ts","src//b.ts"]` → `{src/a.ts,src/b.ts}` |

Requirement ids exercised end to end: **R22** (the three fields accepted and
stored), **R23** (both halves — computed and supplied), **R24**, **R25**,
**R27** (both buckets), **R28** (workstream, write-set entries, normalisation),
**R30**, **R31** (both branches), **R39** (the API half). **R26** is a review
requirement — the belt's doc-comment — and case 8 is the belt firing against a
graph that could only be made cyclic by `psql`, which is R26's own argument made
concrete. **R29** is structural (`depends_on` immutable after insert) and is
proved by review, not by this script.

## 10. How to re-run this

```bash
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
psql "${DATABASE_URL%/*}/postgres" -c 'CREATE DATABASE forge_tg_scratch'   # once; ignore "already exists"
export SCRATCH_DATABASE_URL="${DATABASE_URL%/*}/forge_tg_scratch"
unset DATABASE_URL                       # the script sets it from SCRATCH_DATABASE_URL itself
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-task-api.ts
```

The guard refuses to run without `$SCRATCH_DATABASE_URL`, and refuses
`content_forge` by name. Port `7799` must be free; on `EADDRINUSE` the script
exits non-zero naming the port rather than silently binding another, because a
probe on an unknown port proves nothing about this one.
