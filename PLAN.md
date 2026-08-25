# aios-stall-detector-accuracy — plan (round 0)

**Goal.** Make `scripts/ops/stalled-projects.sh` tell the truth (items 1 and 2), and
re-arm the proof that binds the `graphReady()` oracle to the SQL promoter (item 3).

Every fact below was measured in this worktree or against the live DB **read-only** on
2026-08-25 20:0x–21:0x UTC. Commands and outputs are inline; nothing is recalled.

---

## Recommendation

Four things, in this order of consequence:

1. **Harden `Q()` before adding any section.** The file's own query helper cannot tell
   "no rows" from "the query is broken". A typo'd section prints `none` and the script
   exits `clear`. Every section added below inherits that defect unless it is fixed
   first. This is the `grep … || true` trap one level in, and it is the single largest
   risk in the whole project.
2. **Item 1 — add the zero-open-rows section**, with both `having` relaxations
   re-measured and pasted into the comment block per the file's convention.
3. **Item 2 — narrow the wedged section's new exclusion to `('pending','ready','running')`,
   NOT the brief's `not in ('done','cancelled')`.** The brief's literal predicate
   contradicts the brief's own stated requirement; see the ruling below. Getting this
   wrong silently deletes the exact rows the item exists to keep.
4. **Item 3 — invert the ownership of `TERMINAL_TASK_STATUSES` instead of importing it.**
   The brief says "import it rather than re-typing the literal". A value import from
   `db/*` into `lib/task-graph.ts` is forbidden by that module's own invariant and would
   close a runtime ESM cycle. Move the definition down to the pure leaf and re-export.

---

## Measured facts (read-only, live DB, 2026-08-25 20:05Z)

`psql "$DATABASE_URL"` → `current_database=content_forge`.

| ref | query | rows |
|-----|-------|------|
| A | item-1 full query as briefed | **0** |
| B | A minus `done > 0` | **1** — `smoke-test\|paused\|1\|0` |
| C | A minus `failed > 0` | **1** — `connect-clis-from-settings\|paused\|0\|4` |
| D | existing §"BLOCKED or PAUSED while holding open work" | **1** — `zz-tierpin-verify\|paused\|1` |
| E | existing §"WEDGED DESPITE SATISFIED DEPENDENCIES" | **0** |

B and C reproduce the vault note's two controls exactly. `project_tasks.graph_frozen`
exists (`boolean NOT NULL`). 41 `cancelled` rows across 12 projects, top:
`aios-autonomy-and-automation` 5, `aios-journal-and-mentor` 5, `aios-goals-day-system` 5,
`aios-gemini-default-tier` 5, `canvas-ux` 4, `live-agent-panel` 2.

**Finding the brief did not carry: E is 0 today.** The `aios-guardrail-hardening|main|20`
row measured at 18:00Z has shipped. So item 2, exactly like item 1, has **no live
instance to demonstrate against**. Both new/changed predicates need a constructed-shape
proof; a green run proves nothing for either.

---

## Defect 0 — `Q()` cannot fail (must be fixed first)

`stalled-projects.sh:30` is `Q() { psql "$DATABASE_URL" -At -F'|' -c "$1" 2>/dev/null; }`
and every section is `[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"`.
stderr is discarded and the exit status is never read. Measured:

```
$ out=$(Q "select p.name from projects p where p.nonexistent_column = 1"); echo "rc=$? out=[$out]"
rc=1 out=[]
$ [ -n "$out" ] && echo rows || echo none
none        <-- a BROKEN query reads as CLEAN
```

A section whose SQL does not compile is indistinguishable from a section that found
nothing, and the script still exits 0 with `clear — no silently stopped projects.`

**Fix shape** (same shape the fleet already ruled for `grep || true`): capture the status,
treat non-zero as fatal, and let stderr through.

```bash
Q() {
  local out rc
  out=$(psql "$DATABASE_URL" -At -F'|' -c "$1"); rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'FATAL: query failed (psql rc=%d). This detector does not report CLEAN on a broken query.\n' "$rc" >&2
    exit 2
  fi
  printf '%s' "$out"
}
```

Exit **2** is a third code, distinct from `0=clear` and `1=stalled`, so a cron wrapper
cannot read a broken detector as a healthy one.

---

## Defect 0b — the script cannot be pointed at a scratch database

`stalled-projects.sh:28` is `set -a; . /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a`.
`set -a` + source **overwrites** an already-exported `DATABASE_URL`. Measured:

```
$ DATABASE_URL="postgresql://scratch@127.0.0.1:1/scratch_marker" bash -c \
    'set -a; . /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a; echo "$DATABASE_URL"' \
  | grep -q scratch_marker && echo SURVIVED || echo OVERWRITTEN
OVERWRITTEN
```

So the bite-proof both items require **cannot be run against the script at all** today —
only against hand-copied SQL, which proves the copy, not the script.

**Fix: an explicit, single-purpose override.** Not `if [ -z "$DATABASE_URL" ]` — worker
shells inherit a live `DATABASE_URL`, so that form changes which database a normal
invocation hits, which is exactly the silent behaviour this repo forbids.

```bash
if [ -n "${STALLED_PROJECTS_DB_URL:-}" ]; then
  DATABASE_URL="$STALLED_PROJECTS_DB_URL"          # test-only; never set in cron/pm2
  echo "NOTE: using STALLED_PROJECTS_DB_URL — this is NOT the fleet database." >&2
else
  set -a; . /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
fi
```

Boring, explicit, cannot fire by accident, and announces itself when it does.

---

## Item 1 — blocked/paused with zero open rows

Add the briefed query as a new section. Comment block records, per the file's existing
convention, the two relaxations with **re-measured** counts (B and C above), plus the
constructed-shape proof (below), because A is 0 on live data.

## Item 2 — held vs wedged: the ruling

The brief says two things that cannot both hold:

> exclude … `graph_frozen` AND some LOWER round in a non-terminal state
> (`status not in ('done','cancelled')`) … **KEEP reporting one blocked by a `failed`
> lower round: `failed` is not terminal and wedges a deploy permanently.**

`failed` **is** in `not in ('done','cancelled')`. Written literally, the exclusion
swallows the failed-lower-round case the same sentence demands be kept — and swallows it
invisibly, by the row simply ceasing to appear.

**Ruling: the exclusion set is `('pending','ready','running')`, not `stillOpen()`.**

`stillOpen()` answers the engine's question — *does the promoter hold this row?* The
detector asks a different one — *will this row ever move on its own?* A frozen row behind
a `failed` or `blocked` lower round is held by the engine **and** permanently wedged;
that is the same row, and it must still be reported. Only a lower round in
`pending`/`ready`/`running` is live work that will drain.

```sql
and not (t.graph_frozen and exists (
      select 1 from project_tasks lo
       where lo.project_id = t.project_id
         and lo.round < t.round
         and lo.status in ('pending','ready','running')))
```

Checks against the three required behaviours: round-20 deploy with live lower rounds →
excluded ✓; frozen row whose lower rounds are all terminal → no match, still reported ✓;
frozen row blocked by `failed` → `failed` not in the set, still reported ✓. Documented
edge: a row with *both* a failed and a live lower round is excluded — something is still
draining. `graph_frozen` is `NOT NULL`, so no three-valued-logic hole.

Konrad has been asked to confirm the ruling (reminder filed); the default above ships if
he does not answer, because the alternative provably deletes a class of real stalls.

**Out of scope, deliberately:** `zz-tierpin-verify` and `smoke-test` are documented
permanent noise. Not touched.

---

## Item 3 — the oracle, and why "just import it" is wrong

**The import is forbidden by the target module's own contract.** `task-graph.ts`'s header:

> *Everything here is pure and synchronous so it can be tested without a database … The
> `import type` below is deliberate: a value import would drag the pg pool into the test
> process, and the replay proof (R18) has to run under `tsx --test` on a host with
> Postgres stopped.*

and `task-graph-replay.test.ts:101`:

> *NF3: `db/*` is imported TYPE-ONLY. A value import would open a pg Pool in the test
> process; this suite runs with Postgres stopped.*

`task-graph.ts:60` is `import type { TaskStatus } from "../db/projects.ts"` — types erase,
so today there is no runtime edge. `db/projects.ts:54` value-imports `selectClaimable`
from `lib/task-graph.ts`, and `db/projects.ts:70` runs `new Pool(...)` at module scope.
Adding a **value** import the other way closes a runtime ESM cycle across a module-scope
`new Pool` — the `module-cycle-tdz-crashes-at-boot` shape, which hides until the
production import order hits it.

**Recommendation: invert ownership.** Define `TERMINAL_TASK_STATUSES` canonically in
`lib/task-graph.ts` (pure leaf, already owns the graph vocabulary) and re-export it from
`db/projects.ts`. One definition, no new edge — the `db → lib` edge already exists — and
every current importer keeps working. Then `graphReady()`'s two sites read it:

- `task-graph.ts:361` `if (byId.get(id)!.status !== "done") return false;`
- `task-graph.ts:374` `if (other.round >= task.round || other.status === "done") continue;`

Known cost, taken deliberately: `project-status-reconcile.test.ts:294` pins the literal
`export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"]` in
`PROJECTS_DB_SRC` by regex. It must move with the constant. That test file is in the
write set — a declared edit, not drift.

Left alone, deliberately: `stillOpen()`/`isTerminal()` in `db/projects.ts` build SQL
strings and cannot consume a TS array without a codegen step nobody wants. The existing
`\w+\.status <> 'done'` census in the same test file remains their drift guard.

### Where the proof actually lives — the brief is half right

The brief calls `task-graph-replay.test.ts` "the ORACLE that replays the SQL". It is not.
Its own header says it proves **`graphReady()` ≡ `legacyRoundReady()`** over a fixture —
two TypeScript rules against each other. It never reads the SQL.

Worse, it **cannot see this divergence at all**:

```
$ python3 -c "import json,collections; d=json.load(open('forge-control/src/lib/fixtures/replay-operator-visibility.json')); print(len(d), collections.Counter(r['status'] for r in d))"
131 Counter({'done': 120, 'pending': 8, 'running': 3})
```

Zero `cancelled` rows; `toStatus()` (line ~334) would *throw* on one; and the fixture is
sha256-pinned to `replay-operator-visibility.md`, so it may not be edited. **Fixing
`graphReady()` alone leaves that suite green before and green after — precisely the
outcome the brief forbids.**

The instrument that *does* bind oracle to SQL is **`scripts/checks/check-scheduler-sql.sh`**
(953 lines): it drives the real `promoteReadyTasks()` SQL against a scratch schema and
calls the **real `graphReady()`** through its `mirror` driver step (line 547), asserting
the two agree. And:

```
$ grep -c cancelled scripts/checks/check-scheduler-sql.sh scripts/checks/check-r69-straddle.sh forge-control/src/lib/task-graph.ts
scripts/checks/check-scheduler-sql.sh:0
scripts/checks/check-r69-straddle.sh:0
forge-control/src/lib/task-graph.ts:1
```

No case anywhere exercises a `cancelled` dependency. That gap is the finding; the new
case is the deliverable.

**The discrimination proof**, restated so it can actually be executed: add a case whose
candidate's only dependency is `cancelled`. SQL (`stillOpen`) promotes it; today's oracle
(`!== "done"`) withholds it; the `mirror` assertion sees the disagreement → **RED before
the fix, GREEN after**. Then mutate `graphReady()` back to `"done"` and watch it go RED
again — that is the control, and it is run with `prove-it-bites.sh`, restoring by `cp` +
sha (never `git checkout`). That helper is **not on this branch**; fetch it with
`git show <commit>:scripts/checks/prove-it-bites.sh`, run it, delete it untracked.

Noted, not fixed (scope): neither `check-scheduler-sql.sh` nor `check-r69-straddle.sh` is
wired into `scripts/checks/gates-808.sh` — both are orphan checks.

---

## Task graph

One workstream, `main`. All four builders write disjoint file sets; ordering is by
`depends_on` alone.

| id | role | ws | tier | writes | depends |
|----|------|-----|------|--------|---------|
| B1 | builder | main | standard | `scripts/ops/stalled-projects.sh` | — |
| B3 | builder | main | standard | `task-graph.ts`, `db/projects.ts`, `project-status-reconcile.test.ts` | — |
| B2 | builder | main | junior | `evidence/stall-detector-accuracy.md` | B1 |
| B4 | builder | main | standard | `scripts/checks/check-scheduler-sql.sh` | B3 |
| R1 | reviewer | main | standard | — | B1, B2, B3, B4 |

No integration task: nothing forks, so there is no branch to merge and no conflict to
stop on.

**Why one workstream and not two — this was forced, and it cost the parallelism.**
The plan first put item 3 in an `oracle` workstream. Both of its tasks failed to
dispatch, twice, at `attempt 0` with no run:

```
[project-tick] failed to spawn run for task b0979a7d-… (builder):
  The requested module '../db/ai_os.ts' does not provide an export named 'getFleetDefaultTier'
```

The export exists on disk (`/opt/forge-ai-os/forge-control/src/db/ai_os.ts:161`). The
*running* executor holds a stale ESM module graph from a deploy landing mid-flight;
`project-tick.ts:95` imports the symbol statically (resolved at boot, fine), but
`workspace.ts:197` does `await import("../routes/projects.ts")` in the **worktree-creation
path**, which re-resolves changed code against the cached old module. That path fires only
for a workstream with no worktree yet — which is why `main`, `web` and `toggle` kept
spawning normally and only the new lane died. No `--oracle` worktree was ever created.

The fix is an executor restart, which this phase may not perform (it kills every run in
flight). So the lane was collapsed into `main`; the four superseded rows are `cancelled`,
not deleted. Under the round-222 ruling (one running task per workstream) this does cost
real concurrency — the work is small enough to absorb it.

## What owns what, and how a failure is seen

- **State:** Postgres `projects` / `project_tasks` (live, read-only here). Scratch
  databases are created and dropped by the checks; `content_forge` is never written.
- **Dispatch:** cron/supervisor runs `stalled-projects.sh`; `gates-808.sh` runs the unit
  suite. The two scheduler checks are orphaned (above) and run by hand.
- **On failure:** the detector exits `1` (stalled) or, after this work, `2` (its own query
  broke) — both loud. The oracle's failure mode is a `mirror` mismatch in
  `check-scheduler-sql.sh`, which aborts under `ON_ERROR_STOP`.
- **How Konrad sees it broke:** exit codes above, plus the section text in the supervisor
  transcript. Defect 0 is precisely the case where he would *not* have seen it, which is
  why it is fixed first.

## Preconditions every task inherits

- `forge-control/node_modules` **does not exist** in this worktree. Before any test or
  typecheck: `cd forge-control && pnpm install --frozen-lockfile --prod=false`
  (`NODE_ENV=production` is exported; without `--prod=false` the install exits 0 and
  `tsc` is then missing). `npx tsx --version` → `tsx v4.23.12, node v22.22.2`.
- Work **only** in this worktree. `/opt/forge-ai-os` is never edited; `/opt/ai-os/scripts/stalled-projects.sh`
  is a symlink into it and is likewise never touched.
- Never `pm2 restart forge-executor`.
- Live DB access is **read-only SELECT** for re-measurement. All constructed shapes go in
  a scratch database.

## Rejected alternatives

- *Import `TERMINAL_TASK_STATUSES` from `db/projects.ts` into `task-graph.ts` (as briefed)* — violates NF3 and closes a runtime ESM cycle over a module-scope `new Pool`.
- *New leaf module `lib/task-status.ts` for the constant* — same test edit, one more file; `task-graph.ts` already owns the graph vocabulary.
- *Re-type the literal in `task-graph.ts` with a drift-guard test* — two definitions is the defect being fixed.
- *Add a `cancelled` row to the replay fixture* — the fixture is sha256-pinned to its provenance record and is a real capture.
- *Prove item 3 in `task-graph-replay.test.ts`* — that suite compares two TS rules and cannot reach the SQL; it would be green before and after.
- *Use the brief's `not in ('done','cancelled')` exclusion verbatim* — silently drops the failed-lower-round stalls the same brief requires be kept.
- *`if [ -z "$DATABASE_URL" ]` for the scratch override* — worker shells inherit a live one, so it would silently redirect ordinary runs.
- *One workstream for all four builders* — B3/B4 run suites while B1 edits the same tree.
- *Fix `zz-tierpin-verify` / `smoke-test`* — documented permanent noise; explicitly out of scope.
