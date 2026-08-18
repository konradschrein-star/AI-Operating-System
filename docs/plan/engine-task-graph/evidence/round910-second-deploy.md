# Round 910 — second deploy: shipping the inherited screenshot-convention change

Branch `project/8c591d6c` at `9b960ef`. Host clock is `+02:00` throughout; each
step carries the wall-clock time its command was issued, in execution order,
because a deploy's evidence is only worth the ordering it can prove.

**Declared write-set (one):**
`docs/plan/engine-task-graph/evidence/round910-second-deploy.md` (this file, new).
Nothing else was written in the worktree. The deploy's effect on the live
checkout is a fast-forward of `main`, which moves no file this task authored.

**Why a second deploy exists at all.** The main deploy of this project (phase 8,
round 820) shipped at `b8a5116`. Rounds 900 and 902 landed *after* it and both
edit **executor-loaded code** — `forge-control/src/lib/project-tick.ts` and
`forge-control/src/lib/cc-runner.ts`, imported by `src/executor.ts` (`import
{ projectTick } from "./lib/project-tick.ts"`, and the `cc-runner.ts` import
block above it). The executor holds the old module graph in memory until it is
restarted, so the round-900/902 prompts do not reach a single agent until this
task runs.

---

## STEP 0 — the precondition: round 903's verdict

This task's brief conditions the deploy on round 901's reviewer issuing
`VERDICT: PASS`. Round 901 returned **NEEDS_FIXES** and `createFixChain()`
opened `fix:901:1` (round 902, builder) and `rereview:901:1` (round 903,
reviewer). The operator's note re-pointed the precondition at the re-review, and
the tree to ship with it: *"Ship the tree round 903's re-review passes, not
round 900's commit."*

Round 903 (`d6b0d057`, run `0a1edbe1`) closes with **`VERDICT: PASS`**. Read
from the run thread, not from a summary of it.

**Both inherited fixes re-derived at `HEAD`, not assumed:**

| fix | where it had to land | verified at `9b960ef` |
|---|---|---|
| inline-rendering clause | `SCREENSHOT_CONVENTION` in `project-tick.ts`, and `buildSystemPrompt`'s `- Screenshots:` bullet in `cc-runner.ts` | present — prescribes *save, **THEN READ THE FILE BACK with the Read tool***, names the two shapes the renderer actually matches (a `Read` of the path, or a printed JSON `"url"` member), and states the fallback honestly: *"A shot only written is NOT inline — it reaches Konrad through the run's camera indicator in the Team and Live panels"* |
| `03-quality.md` T16 correction | `docs/plan/03-quality.md` | present — T16 now scopes itself to the **URL half** (`the on-disk half moved out at R900, see §1.3`), carries the amendment banner `T16's on-disk screenshot half AMENDED at R900, recorded at R902`, and the new §1.3 records the split |

## STEP 1 — 08:10:24 — the fleet is clear

```
       name        | status | round |   role   | task_status
-------------------+--------+-------+----------+-------------
 canvas-ux         | paused |     4 | reviewer | pending
 canvas-ux         | paused |     4 | reviewer | pending
 engine-task-graph | active |   910 | builder  | running     <- this task
 engine-task-graph | active |   950 | builder  | pending     <- this project's remaining work
 live-agent-panel  | paused |     8 | reviewer | pending
```

Nothing outside this project can move. The three foreign rows all sit in
**paused** projects, and promotion is gated on `p.status = 'active'` — the
gating this project's own scheduler work was required to keep. Confirmed
independently: exactly **one** run was live fleet-wide (`480570ec`,
`project:builder`, this task).

The main deploy's guard was re-checked rather than taken on trust: project
`operator-visibility` (`8ea0cc08`) is **`done`, 0 open tasks**. The brief's
"live RIGHT NOW with agents running" premise has since expired — recorded here
because a stale premise that happens to be harmless is still a measured fact,
and round 820's evidence made the same disclosure about its own brief.

## STEP 2 — the worktree's own gates

```
$ pnpm typecheck
TYPECHECK_EXIT=0

$ pnpm test
# tests 1293
# suites 239
# pass 1293
# fail 0
# cancelled 0
# skipped 0
# todo 0
TEST_EXIT=0
```

**The first instrument lied and was replaced.** The first typecheck ran as
`pnpm typecheck 2>&1 | tail -20; echo "TYPECHECK_EXIT=$?"` — which reports
**`tail`'s** exit status, not `tsc`'s, and would have printed `0` over a failing
compile. It was re-run writing to a log with `$?` read directly off `pnpm`. The
`0` above is `tsc`'s. Both numbers match round 903's independently (1293/239).

## STEP 3 — 08:10:24 — the live checkout is clean

```
$ git -C /opt/forge-ai-os status --porcelain
$          <- no output, exit 0
$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main
```

## STEP 4 — 08:10:27 — merge

**Main did not move.** `git log --oneline HEAD..main` is empty; the branch is 3
commits ahead. No merge of main into the work branch was needed, so no
post-merge re-run of the gates was owed — the tree the gates ran on in step 2
*is* the tree that shipped, and step 4b proves that rather than asserting it.

`origin/main` is at `9ef01eb`, many commits **behind** local `main` and an
ancestor of `HEAD`. That is pre-existing: this repo merges to `main` locally and
pushes work branches. It is not divergence and nothing was rebased over it. No
push of `main` was performed — this task was not asked to, and it would be a new
policy rather than a deploy step.

```
$ git -C /opt/forge-ai-os merge --ff-only project/8c591d6c
Updating b8a5116..9b960ef
Fast-forward
 11 files changed, 1529 insertions(+), 22 deletions(-)
merge exit=0
```

Zero conflicts. `main` is now `9b960ef`; `git status --porcelain` in the live
checkout is empty after the merge.

**No `pnpm install`**: `git diff --name-only main..HEAD` matched no
`package.json`, no lockfile, no `migrations/` and no `.sql` — so unlike round
820 this deploy carries **no migration**, and there is nothing to apply.

**No `pm2 restart forge-control`.** Permitted by the brief, but not warranted:
no route changed, and the two shipped modules are imported by `src/executor.ts`
alone. `src/index.ts` only *mentions* `project-tick.ts`, in a comment
(`// inside forge-executor's manager loop (lib/project-tick.ts), not here.`).
Restarting the API would have deployed nothing and cost a blip.

### STEP 4b — what would have made this report a pass wrongly

The failure mode this project has been bitten by is an instrument that certifies
a *different* artefact than the one under test — a sha naming the worktree
rather than the build. So the shipped tree was compared to the tested tree
directly:

```
worktree HEAD tree: 1771f9b9521efa41ec971fdd663bc615c88cdc55
live main   tree:   1771f9b9521efa41ec971fdd663bc615c88cdc55
$ git diff --stat main..HEAD      <- no output

blob digests, the two executor-loaded files, on live main:
  74e9ea4561982556a7ed8b0966f8b587a71711f3  forge-control/src/lib/project-tick.ts
  ef3197efc9a480b07c0b2fc89aec28ff56276289  forge-control/src/lib/cc-runner.ts
the same two files in the tested worktree:
  74e9ea4561982556a7ed8b0966f8b587a71711f3
  ef3197efc9a480b07c0b2fc89aec28ff56276289
```

Identical root tree, identical blobs. 1293/1293 was measured on the bytes that
shipped, not on a sibling of them.

## STEP 5 — the detached restart

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 \
  >> /tmp/safe-restart.log 2>&1 &
```

Launched detached; this task then ended. The log was never tailed, the process
never polled, and `pm2 restart forge-executor` was never run — not to deploy,
not to test.

**When it will actually fire, stated rather than implied.** `safe-restart.sh`
defines quiet as `SELECT count(*) FROM runs WHERE last_heartbeat_at > now() -
interval '45 seconds'` reaching **0** on two consecutive 15s polls — heartbeat,
deliberately not status. Round 950 (`1e255d8d`, pending) lists this task in its
`depends_on`, so it promotes the moment this run ends and will hold the fleet
un-quiet for its own duration. **The restart therefore lands after round 950
finishes, not at the end of this task** — and round 950 consequently runs on the
*old* executor code. That is harmless for its work (renumbering a migration
file, which drives no browser and reads no prompt this deploy changes), and it
is the script behaving exactly as designed: it never restarts under a live turn.
The 43200s ceiling gives it 12 hours before it would give up with exit 2.

---

## Residual carried forward, not fixed here

Round 903 recorded one non-blocking residual: the `SCREENSHOT_CONVENTION`
doc-comment in `project-tick.ts` and a comment in `project-tick.test.ts` both
say **"six payload shapes"**, while the instrument
`scripts/checks/check-screenshot-render-shapes.ts` declares and runs **seven**
(`DECLARED_CASES = 7`, cases A–G) and
`docs/plan/engine-task-graph/03-quality.md` correctly says seven. Two comments
undercount their own instrument.

**Deliberately not fixed by this task.** A deploy ships the tree a reviewer
passed; editing executor-loaded source *while merging it* would mean shipping
bytes no reviewer ever saw, and would break the step-4b tree-identity proof that
is this deploy's main defence. It belongs to the next commit that touches those
files — round 950 is that commit's natural home, since it is already re-deriving
references across the corpus.
