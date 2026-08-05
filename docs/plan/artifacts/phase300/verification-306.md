# Round 306 (phase 300i) — verification transcript

Code under test: the `GET /api/chat/:id/plan` and `GET /api/chat/:id/plan/doc` block added to
`forge-control/src/routes/chat.ts`. Nothing else changed — `git diff --name-only` lists that
one file; three artifacts are added.

Requirements: **U6** (plan endpoint + path-restricted doc), **NFU4** (additive API),
**NFU6** (hard errors, no silent fallbacks), **NFU7** (build gates), `13 §3` (route-local SQL),
`13 §7` (the response IS the Kanban/graph store), `14 §'Path traversal'`.

Served through the worktree harness on **:7798**. Production `:7700` was never restarted;
`forge-executor` was never touched.

---

## 0. Build gates — clean

```
$ cd forge-control     && npx tsc --noEmit ; echo exit=$?          → forge-control tsc exit=0
$ cd forge-control-web && npx tsc --noEmit ; echo exit=$?          → forge-control-web tsc exit=0
$ cd forge-control-web && npm run build    ; echo exit=$?          → web build exit=0
                                          (9/9 static pages, middleware 83.2 kB, shared JS 108 kB)
$ cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
    --allowImportingTsExtensions --isolatedModules --types node \
    ../scripts/checks/serve-v3-7798.ts                             → harness exit=0
```

---

## 1. THE FIXTURE PROBLEM — unchanged from round 305, handled the same way

`linkage-fixture-finding.md` (round 304) proved that chat `bfd1283a…` created this project
through a detached `setsid` script, so the `POST /api/projects` never entered its thread and
the bounded scan has nothing to find. In its natural state it resolves to `project: null`:

```
$ curl -sS -w "\nHTTP %{http_code}\n" :7798/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/plan
{"chat_id":"bfd1283a-b71b-4f35-b577-7d09aad803f2","project":null,"link_source":null,
 "link_ambiguous":false,"phases":[],"docs":[]}
HTTP 200
```

That IS §4's specified behaviour — but it is not this project's plan, and the round exists to
show this project's plan. **Round 305's protocol was reused verbatim:** link established with
the same additive idempotent statement the phase's own backfill uses, captured, reverted.

```sql
-- set    UPDATE projects SET metadata = metadata || jsonb_build_object('origin_chat_id',
--          'bfd1283a-b71b-4f35-b577-7d09aad803f2')
--          WHERE id='8ea0cc08-…' AND NOT (metadata ? 'origin_chat_id');      UPDATE 1
-- revert UPDATE projects SET metadata = metadata - 'origin_chat_id'
--          WHERE id='8ea0cc08-…';                                            UPDATE 1
```

Pre-state and post-state, byte-for-byte equal:

```
before  8ea0cc08-…|{"mode": "goal", "checkin_hours": 2, "last_checkin_at": "2026-08-05T13:02:14.767Z"}
after   8ea0cc08-…|{"mode": "goal", "checkin_hours": 2, "last_checkin_at": "2026-08-05T13:02:14.767Z"}

projects carrying origin_chat_id, before and after:
  46c8dd66-…|phase300-origin-probe      ← round 303d's probe
  4d3291c4-…|phase300-invalid-guard     ← round 304's fixture
```

The link was set twice (once for the plan/doc capture, once for the cost measurement in §7)
and reverted both times. Same reasoning as round 305 for not keeping it: that chat created
`4120f785…` too, so a one-sided `origin_chat_id` would report `link_ambiguous: false` for a
genuinely ambiguous chat — the laundering round 304's rule forbids.

---

## 2. THE PLAN (U6) — `docs/plan/artifacts/phase300/plan-endpoint.json`

Full payload committed (33,563 bytes). Rendered — 16 phase blocks, 36 tasks:

```
round_base  tasks  title                                                          statuses
      0       1    Plan: operator-visibility                                      done 1
    100       5    Plan phase 1: time truth (frozen settled durations)             done 5
    200       6    Plan phase 2: kind truth (row classification, model, lineage)   done 6
    300      11    Plan phase 300: read-side API (linkage, team, plan, capabili…)  done 9, running 1, pending 1
    400       1    Plan phase 400: rail progress, slim header, kill managers, …    pending 1
    500       2    Plan phase 500: ChatTeamPanel team tree (merged right panel…)   pending 2
    600       1    Plan phase 600: drill-in navigation + worker-chat legibility    pending 1
    700       1    Plan phase 700: plan-zone Kanban + phase docs + graph-ready …   pending 1
    800       1    Plan phase 800: composer v3 + two-way secrets + canvas perf     pending 1
    900       1    Plan phase 900: merge-main-first deploy + production verific…   pending 1
   1200       1    (no title — see below)                                          pending 1
   1300       1    Plan phase 3: hover performance (profile first, fix, before/…)  pending 1
   1400       1    Plan phase 4: agent comms as first-class chat blocks            pending 1
   1500       1    Plan phase 5: deploy to production + verification               pending 1
   1600       1    Phase 6 (injected by Konrad): dismiss done agents + browser/…   pending 1
   1900       1    Customer test: the deployed Manager Chat UI, as Konrad          pending 1
```

`docs` — all twelve markdown files of the corpus, sorted:

```
00-vision.md  01-requirements.md  02-architecture.md  03-quality.md  04-phases.md
10-ui-v3-spec.md  11-ui-v3-vision.md  12-ui-v3-requirements.md  13-ui-v3-architecture.md
14-ui-v3-quality.md  15-ui-v3-phases.md  16-ui-v3-graph-research.md
```

**Block 1200 has no `title`, on purpose.** Its only task is the round-1250 steward checkpoint;
nothing sits on round 1200 itself, so there is no task title to lift. `title` is the block's
opening-task title (the corpus's planner-at-k00 convention), never a synthesised label.

**No block carries `doc_path`, on purpose.** `matchPhaseDoc` requires a digit run in the file
name to equal the block number as a string. This corpus is numbered per DOCUMENT (`00-`…`16-`),
not per round, so nothing matches. Deliberately not "close enough": numeric comparison would
have made `00-vision.md` the plan document of round 0 by accident of zero-padding. U6's rule is
"no match → field absent". `docs[]` still lists everything, which is what U26's reader picks
from. A file named `300-*.md` would light the field up with no code change.

---

## 3. GROUND-TRUTH CROSS-CHECK — `/plan` vs `GET /api/projects/:id`

```
$ GT=$(curl -sS :7798/api/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838)
$ echo "$GT" | jq -S '[.tasks[] | {id,round,role,title,status,tier}] | sort_by(.round,.id)' > /tmp/gt.json
$ jq  -S '[.phases[].tasks[] | {id,round,role,title,status,tier}] | sort_by(.round,.id)' \
        docs/plan/artifacts/phase300/plan-endpoint.json                                  > /tmp/pl.json
$ diff /tmp/gt.json /tmp/pl.json
                                            (no output)
IDENTICAL task sets: 36 tasks
```

Per-block counts, ground truth vs `/plan` — `diff` clean:

```
ground truth  [{"rb":0,"n":1},{"rb":100,"n":5},{"rb":200,"n":6},{"rb":300,"n":11},{"rb":400,"n":1},
               {"rb":500,"n":2},{"rb":600,"n":1},{"rb":700,"n":1},{"rb":800,"n":1},{"rb":900,"n":1},
               {"rb":1200,"n":1},{"rb":1300,"n":1},{"rb":1400,"n":1},{"rb":1500,"n":1},
               {"rb":1600,"n":1},{"rb":1900,"n":1}]
/plan         …identical…
BLOCK COUNTS AGREE
```

Status rollup also agrees: ground truth `{done:21, pending:14, running:1}` = 36; the sum over
`/plan`'s phase blocks is `done 1+5+6+9 = 21`, `pending 14`, `running 1`. This is the number
U25's progress bar and the U3 rail badge must both show — one server-side source, per `13 §7`.

---

## 4. DEPS (13 §3) — the round-303 probe and a global invariant

The four round-303 builders (300c/300d/300e/300f) ran in parallel on disjoint files. Each:

```
TASK 5bda2ae6-… round=303 "Phase 300c — GET /api/capabilities (U8) + moun"
  deps=15  dep rounds=[0, 100, 101, 102, 103, 200, 201, 202, 203, 250, 299, 300, 301, 302]
  302 ids ['b66cc1bd-b754-49be-9d78-b12373aa6fff'] in deps: True
  301 ids ['d5024345-3a51-4b58-bf9b-ddaf946f8b27'] in deps: True
  3 same-round siblings intersect deps: []  -> excluded: True
  any dep at round >= 303: []
```

…identical for `6bed98a8-…` (300d), `9bdbc2b4-…` (300e), `2a274501-…` (300f). 15 dep ids across
14 rounds because round 101 holds two tasks (one is the `[VOID]` duplicate the planner created
twice — it is real data and it is reported, not filtered).

Global invariant over all 36 tasks / 623 edges:

```
GLOBAL: deps pointing at same-or-higher round: 0
GLOBAL: lower-round tasks missing from some deps list: 0
```

i.e. `deps` is exactly "every task in a strictly lower round", with nothing extra and nothing
missing. Coarse by construction (306 depends on 305 for real and on 101 only bureaucratically);
true by construction (no edge is a lie). Refining it changes ids in the array, never the shape.

*(A first pass at this check used jq and reported siblings as present. That was jq's
`index(.)`-inside-a-pipe scoping, not the endpoint: `$t.deps|index(.)` compares `$t.deps` to
itself. The python above binds the sibling id explicitly and agrees with the `dep rounds` line
that was already visible in the same output.)*

---

## 5. PATH-TRAVERSAL PROTOCOL — full transcript in `traversal.txt`

`14 §'Path traversal'` asks for three cases; the transcript runs eighteen. Summary:

| probe | result |
|---|---|
| `name=../../../../etc/passwd` | **400** `rejected: name must be a bare file name, got a path` |
| `name=..%2f..%2fsecrets` (raw) | **400** — Hono decodes to `../../secrets`, dies on the same rule |
| `name=/etc/passwd` | **400** same rule |
| `name=..` | **400** `name is a directory reference` |
| `name=....//....//etc/passwd` | **400** separator rule |
| `name=..%252f..%252fetc%252fpasswd` (double-encoded) | **400** `only .md documents are served` (decodes to a literal `..%2f…` file name) |
| `name=evil%00.md` (NUL) | **400** `name contains a NUL byte` |
| `name=../14-ui-v3-quality.md` | **400** separator rule (a real file, still refused) |
| `name=notes.txt` | **400** `only .md documents are served` |
| `name=` (empty) | **400** `missing ?name=` |
| `name=10-ui-v3-spec.md` | **200** `text/markdown; charset=utf-8`, body **byte-equal to the file on disk** |
| `name=nonexistent.md` | **404** `no such plan document` — not 400, not 500 |
| symlink → `/tmp/plan-escape-probe.md` | **400** `resolves outside the plan directory (…is not under …/docs/plan)` |
| symlink → `/etc/passwd` | **400** same |
| symlink → `10-ui-v3-spec.md` (stays inside) | **200** — the rule is containment, not a ban on symlinks |
| dangling symlink | **404**, not 500 |
| directory named `adir.md` | **400** `is not a regular file` |
| 3,145,728-byte `huge-306.md` | **413** `over the 2097152-byte plan-doc limit` |
| unlinked chat + valid name | **404** `chat is not linked to a project` |
| malformed chat id | **400** `invalid run id` |

The symlink cases are the reason the code calls `fs.realpath` on **both** sides rather than
trusting `path.resolve`: `escape-passwd.md` is a lexically perfect child of the plan dir and a
physical escape. The containment test compares against `realDir + path.sep`, so a sibling
directory named `plan-evil` cannot pass a bare `startsWith("…/plan")`.

Every fixture (5 symlinks, 1 directory, 1 3 MB file, 1 /tmp target) was removed inside the same
command block. Post-test state, in the transcript:

```
$ git status --porcelain docs/plan
?? docs/plan/artifacts/phase300/plan-endpoint.json
?? docs/plan/artifacts/phase300/traversal.txt
$ find docs/plan -maxdepth 1 -type l  →  0 symlinks (0 expected)
$ ls docs/plan/*.md | wc -l          →  12  (unchanged)
```

---

## 6. NFU6 — the docs-error path, exercised on real data

Two projects created by rounds 303d/304 have a `workspace_dir` whose `docs/plan/` was never
created. `/plan` returns their real phases AND names what it could not read — never `docs: []`
alone, which would read as "this project has no plan corpus":

```
$ curl -sS :7798/api/chat/01b820d1-9d46-4c6f-94da-525c5994dfd9/plan
{"chat_id":"01b820d1-…","project":{"id":"46c8dd66-…","status":"done"},
 "link_source":"metadata","link_ambiguous":false,
 "phases":[{"round_base":0,"tasks":[{"id":"3e0b3f15-…","round":0,"role":"architect",
            "title":"Plan: phase300-origin-probe","status":"done","tier":null,"deps":[]}],
            "title":"Plan: phase300-origin-probe"}],
 "docs":[],
 "error":"plan docs unreadable at /opt/ai-os/workspace/projects/46c8dd66-…/docs/plan:
          ENOENT: no such file or directory, scandir '…/docs/plan'"}
HTTP 200
```

Same for `c0de0304-…` → `4d3291c4-…`. Note what did NOT happen: the phases are still correct
and complete. The docs listing degrades alone; it does not take the plan down with it.

### Unlinked / unknown / malformed (self-verify §4)

```
bfd1283a-… (real chat, no resolvable project)  → {"project":null,"phases":[],"docs":[]}   HTTP 200
05187ada-… (plain chat, never made a project)  → {"project":null,"phases":[],"docs":[]}   HTTP 200
00000000-0000-4000-8000-000000000000 (no run)  → {"project":null,"phases":[],"docs":[]}   HTTP 200
nope (malformed)                               → {"error":"invalid run id"}               HTTP 400
```

`/plan` deliberately does not 404 an unknown chat: "no project" is the answer to "what work
exists here", and the endpoint has no reason to assert a run's existence when `/team` and
`/api/chat/:id` already do.

---

## 7. COST — and a frozen-truth property this endpoint gets for free

Five consecutive calls, full 36-task plan + a live `readdir`:

```
  call 1: 0.022250s  33563 bytes  HTTP 200      ← pool cold-start
  call 2: 0.003044s  33563 bytes  HTTP 200
  call 3: 0.002725s  33563 bytes  HTTP 200
  call 4: 0.002481s  33563 bytes  HTTP 200
  call 5: 0.002316s  33563 bytes  HTTP 200
```

Doc streaming, `13-ui-v3-architecture.md` (13,045 bytes): 4.7 ms cold, 2.6–2.9 ms warm.

`13 §3` says "no index, no cache" — 2.5 ms for one project row, one task query and a twelve-entry
readdir is why that is the right call, and why a cache here would be complexity buying nothing.

**Idempotence:** two calls three seconds apart are byte-identical (33,563 bytes, `cmp` clean).
There is no `now` in this response and no wall-clock derivation anywhere in it — the phase-1
time-truth rule holds here by construction rather than by care.

---

## 8. NFU4 — `api-diff.sh`: the same three pre-existing failures, attributed

```
ok    agents / agents-project / agents-run / projects-managers / secrets
FAIL  chat-list   — normalized VALUES differ
FAIL  chat-thread — KEY SET changed
FAIL  projects    — normalized VALUES differ
```

**The brief expects this script green. It is not, and it was not before this round either.**
Attribution test — `chat.ts` reverted to HEAD, harness restarted on that code, suite re-run:

```
$ cp forge-control/src/routes/chat.ts /tmp/chat-306.ts.bak
$ git checkout -- forge-control/src/routes/chat.ts       # no plan route at all
$ <restart :7798>
$ curl -o /dev/null -w "%{http_code}" :7798/api/chat/bfd1283a-…/plan   → 404
$ scripts/checks/api-diff.sh | grep -E '^(ok|FAIL|api-diff)'  > /tmp/apidiff-head.txt
$ cp /tmp/chat-306.ts.bak forge-control/src/routes/chat.ts
$ <restart :7798>
$ curl -o /dev/null -w "%{http_code}" :7798/api/chat/bfd1283a-…/plan   → 200
$ scripts/checks/api-diff.sh | grep -E '^(ok|FAIL|api-diff)'  > /tmp/apidiff-306.txt
$ diff /tmp/apidiff-head.txt /tmp/apidiff-306.txt
                                            (no output)
IDENTICAL — the three failures are pre-existing drift, not this round's
```

Cause, already characterised in `verification-305.md §8` and unchanged: the pinned operator
chat kept working since round 301 captured the baseline (`chat-list`, `chat-thread` — newer
thread entries carry `meta.blocked_by`, `meta.rule_label`, `meta.trip_id`), and `projects.count`
went 8 → 10 with rounds 303d/304's two probe projects. A documented blind spot of the gate's
normalizer (it only blanks non-terminal rows; that chat is `completed` in both captures yet was
resumed and completed again in between), not an API change.

`GET /api/chat/:id/plan` and `/plan/doc` are pure additions: no existing handler, response or
field was touched.

---

## 9. WHAT A REVIEWER SHOULD CHECK RATHER THAN TAKE ON FAITH

1. **`resolvePlanDoc`'s four layers, in order.** Reorder them and the guarantee breaks: the
   containment check is only meaningful because `realpath` ran on both sides, and `realpath`
   on the candidate is only safe to attempt because the lexical layer already refused paths.
2. **`realFile.startsWith(realDir + path.sep)`** — drop the separator and `/…/docs/plan-evil/x.md`
   passes. There is no test fixture for that in the transcript because creating a sibling
   directory in the corpus was not worth the pollution; the assertion is one line of code and
   the reviewer should read it rather than trust a curl.
3. **`teamPool` is reused, not duplicated.** Round 305 opened it (`max: 2`) for the team tree;
   `/plan` adds two read queries to the same pool rather than a third pool on the same database.
   Its name still says "team" — the comment at the plan block says so explicitly instead of
   renaming a symbol round 305's reviewer already signed off on.
4. **`groupPlanPhases` keeps siblings out of each other's deps** via the `pending` buffer that
   only drains on a round change. A naive "everything before me in the sorted array" would have
   made 300d depend on 300c. §4's probe is the proof; the invariant scan is the generalisation.
5. **No engine file, no web file, no `db/` file was touched.** `git diff --name-only`.
