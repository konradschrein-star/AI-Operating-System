# Evidence — createFixChain conflict arbitration (R308, review finding 3)

Round 308, fix cycle 2. Proves the claim behind finding 3 of the round-307 review and the
fix for it. The live `content_forge` database was touched **read-only** (two catalog
SELECTs, quoted below); everything else ran against a throwaway database
`forge_f3_dryrun`, created and dropped inside this run.

## The claim being tested

`main` shipped `db/migrations/0035_task_idempotency.sql` while this branch was out. It is
applied live. A chain row written by `createFixChain` is therefore subject to **two**
unique indexes, not one:

| Index | Columns | Source | Live? |
|---|---|---|---|
| `project_tasks_identity_idx` | `(project_id, round, role, title)` | `main`, migration 0035 | **yes** |
| `project_tasks_chain_key_uniq` | `(project_id, chain_key) WHERE chain_key IS NOT NULL` | this branch, migration 0039 | not yet |

`createFixChain` named only the second as its `ON CONFLICT` target. A collision on the
first is then an unhandled `unique_violation`, which aborts the whole transaction,
propagates to the per-group `catch` in `reconcileSettledTasks()`, and after
`MAX_GROUP_FAILURES` strikes freezes the round with a "failed to consolidate 3 times in a
row" push.

## S0 — the premise, verified against live

```
$ docker exec content-forge-postgres psql -U postgres -d content_forge -tAc "
    SELECT indexname || ' :: ' || indexdef FROM pg_indexes
     WHERE tablename='project_tasks' ORDER BY indexname;"
project_tasks_identity_idx :: CREATE UNIQUE INDEX project_tasks_identity_idx ON public.project_tasks USING btree (project_id, round, role, title)
project_tasks_pending_idx  :: CREATE INDEX project_tasks_pending_idx ON public.project_tasks USING btree (project_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying])::text[]))
project_tasks_pkey         :: CREATE UNIQUE INDEX project_tasks_pkey ON public.project_tasks USING btree (id)
project_tasks_project_idx  :: CREATE INDEX project_tasks_project_idx ON public.project_tasks USING btree (project_id, round, status)
project_tasks_run_idx      :: CREATE INDEX project_tasks_run_idx ON public.project_tasks USING btree (run_id) WHERE (run_id IS NOT NULL)
```

`project_tasks_identity_idx` is live. `chain_key` is not. Both halves of the reviewer's
premise hold.

The reviewer's concrete colliding row exists too — written by the currently-live engine,
in this very project:

```
$ ... -d content_forge -c "SELECT round, role, title, status FROM project_tasks
     WHERE project_id='4120f785-fd86-414c-9a04-f10b2cd0c365'
       AND round BETWEEN 305 AND 308 ORDER BY round, created_at;"
 round |   role   |                             title                             | status
-------+----------+---------------------------------------------------------------+---------
   305 | reviewer | Phase 3 gate: researcher role + R20 smoke (03-quality P3 row) | done
   306 | builder  | Fix cycle 1                                                   | done
   307 | reviewer | Re-review after fix cycle 1                                   | done
   308 | builder  | Fix cycle 2                                                   | running
```

Round 306's `(project, round, role, title)` is exactly what a re-surfaced round-305
reviewer group makes `createFixChain` try to insert, and its `chain_key` is NULL.

## S1–S5 — raw SQL, both forms, on the throwaway DB

Table built with both indexes and seeded with the round-306 row (chain_key NULL).

```
=== S1: OLD form, ON CONFLICT (project_id, chain_key) WHERE chain_key IS NOT NULL ===
NOTICE:  S1: unique_violation -> tx aborts -> noteGroupFailure. THIS IS THE BUG.

=== S2: NEW form, bare ON CONFLICT DO NOTHING ===
NOTICE:  S2: no error, rows inserted = 0 -> builderCreated=false -> replay absorbed

=== S3: bare form still guards chain_key (the original R7 job) ===
NOTICE:  S3: same chain_key + different identity -> rows inserted = 0 (0 = guard fires)

=== S4: a genuinely NEW chain still inserts — the guard is not a wall ===
NOTICE:  S4: fresh chain -> rows inserted = 1 (1 = real work still happens)

=== S5: final state ===
 round |   role   |            title            |   chain_key
-------+----------+-----------------------------+----------------
   306 | builder  | Fix cycle 1                 |
   307 | reviewer | Re-review after fix cycle 1 | rereview:305:1
   309 | builder  | Fix cycle 2                 | fix:308:2
```

S3 is the one that matters for not over-correcting: dropping the conflict target must not
weaken the chain_key guard R7 exists for. Same `chain_key`, deliberately different title
so the identity index cannot catch it — still zero rows inserted.

## A1–A3 — the REAL `createFixChain`, not a hand-written INSERT

`DATABASE_URL` pointed at `forge_f3_dryrun`, `createFixChain` imported from
`src/db/projects.ts` and called directly.

```
$ npx tsx ./f3-live.ts
A1 identity+chain_key collision: {"builderCreated":false,"reviewerCreated":false}
A2 replay                      : {"builderCreated":false,"reviewerCreated":false}
A3 fresh cycle                 : {"builderCreated":true,"reviewerCreated":true}
```

A1 is the reviewer's scenario end to end: no throw, both flags false. A3 confirms a
genuinely new cycle still creates both tasks.

> Recorded against the `{builderCreated, reviewerCreated}` return shape, which §B replaced
> with per-row outcomes later in the same round. The point A1 proves — the identity
> collision no longer throws — is unchanged; what A1 got WRONG is that "both flags false"
> was then read as a harmless replay. §B is the correction.

Same script against the **pre-fix** code:

```
$ npx tsx ./f3-live.ts      # with ON CONFLICT (project_id, chain_key) restored
error: duplicate key value violates unique constraint "project_tasks_identity_idx"
  routine: '_bt_check_unique'
```

Exactly the failure the reviewer predicted, from the code path that ships.

## B1–B3 — the second gap: `rowCount` cannot say WHICH index fired

A red-team pass over the merge (R308) found that A1's `builderCreated:false` was still
wrong, just not in the way finding 3 described. `DO NOTHING` reports zero rows whichever
index absorbed the insert, so two very different situations arrived as the same boolean:

| | meaning | correct action |
|---|---|---|
| **replay** | the existing row carries OUR chain_key — our own chain, re-created after a crash | proceed, nothing lost |
| **occupied** | a DIFFERENT row holds our identity tuple, with someone else's chain_key or none | its brief is not ours; the merged feedback reaches nobody |

The reachable trigger is the deploy window itself. Round R has two reviewers. A settles
before the P6 restart, so the LIVE pre-0039 engine reconciles it per task and writes
`(project, R+1, 'builder', 'Fix cycle 1')` with `chain_key` NULL and A's feedback alone.
B settles after the restart, the new engine consolidates round R, computes the same
`fix:R:1`, and collides on identity. Reported as "replay absorbed", the round was marked
done, no push was sent, and **B's findings were dropped in silence**.

`insertChainRow()` now classifies the conflict by looking the row up — chain_key first
(a row with our key is our chain), then the identity tuple (a row with only that is a
stranger), and throws if neither explains it. Proven against a throwaway DB seeded with
exactly the row above:

```
$ npx tsx ./f3b.ts
B1 stranger holds identity : {"builder":{"kind":"occupied","id":"66c11c5d-…","title":"Fix cycle 1","chain_key":null},
                              "reviewer":{"kind":"created","id":"a62cd914-…"}}
B2 fresh round             : {"builder":{"kind":"created","id":"8bcf68cd-…"},"reviewer":{"kind":"created","id":"c7f312af-…"}}
B3 replay of B2            : {"builder":{"kind":"replay","id":"8bcf68cd-…"},"reviewer":{"kind":"replay","id":"c7f312af-…"}}
```

B3 returns the SAME ids as B2 — a replay is recognised as the same chain, not a new one.
B1 correctly separates the occupied builder from the freshly-created re-reviewer.

On `occupied`, `consolidateReviewerGroup`'s `fix` branch now blocks the project and pushes
a message naming the occupying task id and title, instead of logging a successful replay.
The verdicts are not lost — they are in the reviewer run threads, and the message says so
and names the round. The group is still marked done, deliberately: a blocked project
promotes and claims nothing, and leaving the reviewers `running` would re-decide and
re-notify the same round every 10 seconds.

## Regression guard in the suite

`T15 createFixChain conflict arbitration` in
`forge-control/src/lib/project-reconcile.test.ts` — five cases: the bare `DO NOTHING`
survives, no parenthesised or `ON CONSTRAINT` target appears in either function, the
swallowed conflict is classified into created/replay/occupied with `rowCount` banned and
the two lookups in the right order, `createTask` never writes `chain_key`, and the caller
blocks the project on `occupied` before it can send a fix-cycle push. Mutation-tested:
restoring the targeted conflict form turns 2 of the 5 red.

That suite has no database, so T15 is a cheap guard against either regression creeping
back — not the proof. The proof is S1–S5, A1–A3 and B1–B3 above.

## Cleanup

```
$ docker exec content-forge-postgres psql -U postgres -q -c "DROP DATABASE forge_f3_dryrun;"
$ docker exec content-forge-postgres psql -U postgres -q -c "DROP DATABASE forge_f3b;"
```

Both scratch databases (`forge_f3_dryrun`, `forge_f3b`) and the throwaway `f3-live.ts` /
`f3b.ts` are gone; this transcript is the
artifact. `git status --porcelain` clean of both.
