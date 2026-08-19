# Phase 7 deploy — STOPPED on precondition 1 and 2

**Task:** `fe3749e0` — "Deploy phase 7 — merge to main, rebuild, and prove it with a moved
BUILD_ID in served HTML", round 15, workstream `main`, run `70bfc0d3-e9db-4a56-833a-b40bffa5e723`.
**Date:** 2026-08-20.
**Outcome: NO DEPLOY.** Nothing was merged into `main`, nothing was rebuilt, nothing was
restarted, and `/opt/forge-ai-os` is byte-for-byte as this task found it.

The brief's own instruction is the one being obeyed here, verbatim:

> `bash scripts/checks/preflight-deploy.sh` → **exit 0**. Paste the full output. If it fails,
> STOP and report; you may not deploy over an open verdict, a dirty live checkout or an
> unmerged lane.

It failed. And the second precondition — that the phase-7 pre-deploy gate issued
`VERDICT: PASS` — is **false as written in the brief**. The gate issued `NEEDS_FIXES`.

---

## 1. Precondition 1 — the preflight gate: **FAIL (exit 1)**

Full output, unedited:

```
$ bash scripts/checks/preflight-deploy.sh
----------------------------------------
### C1 — every lane's final verdict is PASS ###
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: highest reviewer is round 16 (task ea8360e4-e880-4c57-b028-50d5edb2b7b1, status=pending) — no run_id yet, so no verdict exists ('Re-review after fix cycle 1')
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
  4c94920cc356ce6c67e7207ce12fb634b5dfc4bc
PASS — C4 — merge-tree probe is conflict-free (tree 4c94920cc356ce6c67e7207ce12fb634b5dfc4bc)
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
EXIT=1
```

Four of five checks are green. **C1 is red**, and it is red for exactly the reason round 14's
gate wrote down: `check_c1` (`scripts/checks/preflight-deploy.sh:85-89`) selects each
workstream's reviewer by `sort_by(.round) | last`, and for workstream `main` that resolves to
round **16** — a reviewer that has not run and cannot have run, because it is downstream of
this task. The script asserts the future.

The failure is **not** a lane verdict. All five lanes are PASS.

## 2. Precondition 2 — the pre-deploy gate's verdict: **NEEDS_FIXES, not PASS**

The brief states the gate "issued `VERDICT: PASS`". It did not. Read from `runs.thread` rather
than from the artefact, as the brief itself instructs:

```
$ psql -h 127.0.0.1 -p 5432 -U postgres -d content_forge -Atc "
    select o, substring(e->>'content' from 'VERDICT: [A-Z_]+')
      from runs r, jsonb_array_elements(r.thread) with ordinality a(e,o)
     where (r.metadata->>'task_id')='4b9e9a75-4261-4f7d-b84a-1b040fe74194'
       and e->>'role'='assistant' and e->>'content' ~ 'VERDICT: '
     order by o desc limit 5;"
146|VERDICT: NEEDS_FIXES
```

One `VERDICT:` line in the whole run, at message 146, and it is the last assistant message.
Task `4b9e9a75-4261-4f7d-b84a-1b040fe74194` = "Phase 7 pre-deploy gate", round 14, status
`done`, run `704942f2-1e50-4a1c-baf5-6efa44201e3d`. Tail of that final message:

> **Fix:** ignore reviewer rows that have never run (`run_id == null`), judge the highest-round
> reviewer that has one, still FAIL a workstream with no completed reviewer, and print every
> skipped row so a green C1 is not read as "all rows checked" — that keeps the teeth, because an
> unrun re-review after a `NEEDS_FIXES` leaves the `NEEDS_FIXES` row as the newest run one. Ship
> a forced-failure fixture for the new selection; this is the gate that judges its own author.
>
> Everything else is green — nothing in the integrated tree needs to change for this to clear,
> one script does.
>
> VERDICT: NEEDS_FIXES

The verdict artefact `docs/plan/artifacts/os-usable-for-work/phase7/pre-deploy-gate.md` (commit
`c50a4c7`, 490 lines) agrees with the thread. Both sources say NEEDS_FIXES; the brief's claim of
PASS is the only thing that says otherwise.

**N9 — nothing reaches the live checkout without a gating reviewer's PASS — is therefore
dispositive on its own, independently of the preflight exit code.**

## 3. Precondition 3 — the live checkout: **CLEAN, re-read now**

```
$ git -C /opt/forge-ai-os status --porcelain
(no output)
$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main
$ git -C /opt/forge-ai-os log --oneline -3
9c3f63a merge: cheaper verification — review only what can break, Sonnet by default
de7b603 feat(prompt): review only what can break, and stop defaulting every task to Opus
553fa38 feat(daily): Goals/Tasks daily surface — commit the work that was already live
```

Confirmed clean at `main = 9c3f63a`, exactly as the phase-7 planner measured on 2026-08-19.
Konrad's Goals work is present as `553fa38`. No preservation patch was needed and none was
taken. Nothing in `/opt/forge-ai-os` was written, checked out, reset or cleaned by this task.

## 4. The BUILD_ID baseline, recorded before anything was touched

```
$ cat /opt/forge-ai-os/forge-control-web/.next/BUILD_ID
TsvXpNcIwjauqnJDJB2dy

$ curl -s -L -m 10 http://127.0.0.1:7701/signin | grep -c TsvXpNcIwjauqnJDJB2dy
1
```

The verbatim served-HTML fragment carrying it:

```
0:{\"P\":null,\"b\":\"TsvXpNcIwjauqnJDJB2dy\"
```

(inside `<script>self.__next_f.push([1,"0:{\"P\":null,\"b\":\"TsvXpNcIwjauqnJDJB2dy\",\"p\":\"\",\"c\":[\"\",\"signin\"],...`)

Listener check — `pm2 online` is not `listening`:

```
$ ss -lntp | grep 7701
LISTEN 0 511 *:7701 *:* users:(("next-server (v1",pid=1901687,fd=23))
```

See `build-ids.txt` for the ledger.

## Why there is no second id

Producing a second BUILD_ID requires merging `project/7851068b` into `main` in the live
checkout and rebuilding there. That is precisely the action both failed preconditions forbid.
A moved BUILD_ID obtained by deploying over an open `NEEDS_FIXES` would be a *proof of a
violation*, not a proof of a deploy.

## 5. Branch topology at the moment of the stop (the merge is ready, only ungated)

```
$ git rev-parse --abbrev-ref HEAD          # worktree
project/7851068b
$ git rev-parse HEAD
c50a4c7f53489c8f195de825ac7d0b746ca5d5fc
$ git rev-parse main
9c3f63aa161a29b844699fcf537e9c8ae22f374d
$ git rev-list --count main..project/7851068b
92
$ git rev-list --count project/7851068b..main
0
$ git status --porcelain
(no output)
```

`main` has **not** moved since integration, so the briefed `git merge --no-ff main` into the
work branch is a no-op — there is nothing to merge down. The 92 commits are ready to go up, and
C4's `git merge-tree --write-tree` probe already resolved them against `main` conflict-free
(tree `4c94920cc356ce6c67e7207ce12fb634b5dfc4bc`). **The tree is deployable; the gate is not
satisfied.** That distinction is the whole content of this report.

## 6. What the round-14 gate actually found, and what already exists to clear it

The gate's blocker is the deploy gate script itself, not the integrated work. Its recorded
measurements of the tree: 1645/1645 unit tests pass, both typechecks exit 0, `gates-808.sh
--strict` gives 22 executed-green / 2 skipped-by-design / 1 red with that red (gate 6,
forbidden-file diff on `forge-control/src/db/projects.ts`, the perf lane's declared R73/R75
column projection) adjudicated in writing against a `RED:0` baseline. Six of seven merges are
byte-identical to `git merge-tree --write-tree` of their own parents. No lane's work is
reversed.

The remedy is seeded and waiting:

| task | round | role | status | title |
|---|---|---|---|---|
| `4b9e9a75` | 14 | reviewer | done | Phase 7 pre-deploy gate → **NEEDS_FIXES** |
| `fe3749e0` | 15 | builder | running | **this task** — Deploy phase 7 |
| `8802e61a` | 15 | builder | **pending** | Fix cycle 1 (carries the C1 feedback verbatim) |
| `6d92b80e` | 16 | reviewer | pending | Phase 7 GATE — R83–R90, BUILD_ID from the live host |
| `ea8360e4` | 16 | reviewer | pending | Re-review after fix cycle 1 |

`8802e61a` is briefed with the gate's full feedback, so the C1 fix has an owner. This task did
**not** pre-empt it: repairing `scripts/checks/preflight-deploy.sh` here would be an undeclared
write into a file another pending round-15 builder is about to edit in this same shared
worktree, and — more to the point — a deploy task that repairs its own gate and then declares
itself cleared is the exact failure mode the gate exists to prevent.

## 7. THE STRUCTURAL PROBLEM THE MANAGER MUST RESOLVE

**This deploy task will end `done`, and nothing re-seeds it.** The ordering that phase 7 now
needs is:

1. `8802e61a` fix cycle 1 → repair C1 (skip never-run reviewer rows; print the skipped ones;
   ship a forced-failure fixture)
2. `ea8360e4` re-review → `VERDICT: PASS`
3. **a NEW deploy task** — merge, rebuild, restart, prove the moved BUILD_ID
4. `6d92b80e` phase-7 gate → checks R83–R90 including the moved BUILD_ID

Step 3 does not exist. A refused task is `done`, and this fleet has already measured that a
correctly-refused integration is never re-seeded. If nobody creates it, `6d92b80e` will run
against a live host still serving `TsvXpNcIwjauqnJDJB2dy` and fail on R89/S14 — "the deploy did
not prove itself" — for a deploy that was never attempted. This was reported to the manager
chat (`bfd1283a-b71b-4f35-b577-7d09aad803f2`) at the time of the stop.

Note also that C1, once repaired as the gate prescribes, will read `main`'s newest **run**
reviewer — which after step 2 is `ea8360e4`'s PASS. Until step 2 completes it is `4b9e9a75`'s
`NEEDS_FIXES`, and the preflight will correctly keep refusing. That is the teeth working, not a
second bug.

## 8. Statement of what was and was not run

- **`pm2 restart forge-executor` was NEVER run** by this task — not to deploy, not to test, not
  once. (Quoting the forbidden string as evidence is a use, not a violation.)
- `safe-restart.sh` was not launched: there is nothing to restart for, since nothing merged.
- `pm2 restart forge-control` / `pm2 restart forge-control-web` were not run.
- `pnpm install`, `pnpm build`, `git merge`, `git push` were not run.
- `/opt/forge-ai-os` was accessed **read-only**: `git status`, `git rev-parse`, `git log`,
  `cat .next/BUILD_ID`, and HTTP GETs against `127.0.0.1:7701`.
- No screenshot was taken: the post-deploy memory-surface verification is downstream of a
  deploy that did not happen, and screenshotting the *old* build would produce an image that
  looks like proof of this round's work and is not.

## 9. Write-set

Declared: `docs/plan/artifacts/os-usable-for-work/phase7/deploy-report.md`,
`docs/plan/artifacts/os-usable-for-work/phase7/build-ids.txt`.
Written: exactly those two files. **No undeclared write.**

---

## APPENDED CORRECTION — 2026-08-20, same run, after the report above was committed

**§7's central claim is now FALSE, and this note exists so no reviewer chases a closed gap.**

Section 7 said: *"Step 3 does not exist... If nobody creates it, `6d92b80e` will run against a
live host still serving `TsvXpNcIwjauqnJDJB2dy`."* Between committing that (`d1b1811`) and
re-reading the graph, **the manager seeded it.** Measured, not assumed:

```
$ curl -s http://127.0.0.1:7700/api/projects/7851068b-.../ | (tasks, round >= 14)
14 done    reviewer main 4b9e9a75 deps=[999c250d]           Phase 7 pre-deploy gate
15 running builder  main fe3749e0 deps=[4b9e9a75]           Deploy phase 7            <- this task
15 pending builder  main 8802e61a deps=[4b9e9a75, fe3749e0] Fix cycle 1        chain=fix:14:1
16 pending reviewer main ea8360e4 deps=[8802e61a]           Re-review          chain=rereview:14:1
17 pending builder  main d4561713 deps=[ea8360e4]           Deploy phase 7 (re-seeded)
18 pending reviewer main 6d92b80e deps=[d4561713]           Phase 7 GATE — R83-R90, BUILD_ID
```

Two changes from the graph §7 describes:

1. **`d4561713` exists** — "Deploy phase 7 (re-seeded) — merge to main, rebuild, prove the
   BUILD_ID moved", round 17, `depends_on = [ea8360e4]`, workstream `main`, `write_set` = the
   same two artefact paths as this task.
2. **The phase gate moved from round 16 to round 18** and now depends on `d4561713`. That was
   the second half of the ordering problem §7 raised, and it is fixed at the edge rather than
   by round arithmetic.

The row is well-formed on the axes that have wedged this project before: it has a real
`depends_on` (not `NULL`, which is a project-wide barrier), it declares a workstream, and it is
a builder row so no `consolidateVerdictGroup` demands a verdict from it.
`/opt/ai-os/scripts/stalled-projects.sh` reports **clear** — no wedge, no zombie, no legacy
barrier, no failed row with a pending successor.

**So the standing ruling "A CORRECT REFUSAL MUST LEAVE A SUCCESSOR"
(`AI OS/Operator Decisions.md`) is satisfied for this refusal.** The successor is
`d4561713-4eaa-42a2-bdc6-cd7cd347838c`, and it owns the deploy. This report's §7 should be read
as the diagnosis that produced that row, not as an open gap.

**One consequence worth stating plainly:** `d4561713` declares *these same two files*. When it
runs it will overwrite this report with the real deploy's evidence — correctly, because a
deployed phase should not ship a stop-report as its deploy record. This refusal survives in git
as commit `d1b1811` regardless of what later overwrites the working file, which is where a
reviewer auditing round 15 should look.

Nothing else in this document changes: no merge, no rebuild, no restart, and
`pm2 restart forge-executor` still never run.
