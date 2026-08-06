# Evidence — the tester gates a round like the reviewer (R850)

Round 850. Proves the two claims the unit suite cannot reach, because they are properties
of SQL rather than of a pure function: the widened group query, and the fix chain with
more than one re-checker.

Everything below ran against a throwaway database `forge_r850_dryrun`, created for this
run on the `content-forge-postgres` container. **`content_forge` was not touched at all** —
not read, not written. The scratch database carries BOTH live unique indexes
(`project_tasks_identity_idx` from 0035, `project_tasks_chain_key_uniq` from 0039) and the
role CHECK from 0038, so the conflict behaviour is the real one.

The scratch database is still on the box. Dropping it needs an explicit instruction, which
this build task does not have — `DROP DATABASE forge_r850_dryrun;` when convenient.

## The bug being fixed

`reconcileSettledTasks()` deferred a settled task to round consolidation only when
`task.role === "reviewer"`. A settled **tester** — same `VERDICT: PASS / NEEDS_FIXES`
contract in `agents/tester.md`, same gating position in a phase — fell into the else
branch, was marked `done`, and its verdict was never parsed. A customer-facing
`VERDICT: NEEDS_FIXES` therefore became an approval, with no log line, no notification and
no fix cycle. That is the same failure `block(no_verdict)` exists to prevent for
reviewers, only quieter.

## Design, in one paragraph

Reviewer and tester of one round are ONE group, not two. Two groups would put two fix
builders into the same round and the same worktree, each carrying half the feedback —
first-night bug 1 wearing a different hat. So: `VERDICT_ROLES = ["reviewer", "tester"]`,
`listVerdictRound()` loads both, `consolidateVerdictRound()` folds them into one decision,
and a `fix` yields ONE builder plus **one re-check per dissenting ROLE** (never per
dissenting task — two unhappy reviewers still produce exactly one re-review). The role
split on the re-check is the point: only a tester can confirm a broken checkout flow now
works, and only a reviewer can confirm the diff that fixed it is sound.

Chain keys: `fix:R:c` (unchanged), `rereview:R:c` (unchanged — frozen, rows written since
0039 carry it), `retest:R:c` (new).

## A — `listVerdictRound(project, 200, VERDICT_ROLES)`

Seeded round 200 with a reviewer, a tester and a builder, each with a settled run whose
thread ends in a verdict.

```json
[
  { "role": "reviewer", "title": "Diff review",    "run_status": "completed",
    "last_text": "The catch swallows the error.\nVERDICT: NEEDS_FIXES" },
  { "role": "tester",   "title": "Customer sweep", "run_status": "completed",
    "last_text": "Empty state shows a stack trace.\nVERDICT: NEEDS_FIXES" }
]
```

Both gating roles present, `last_text` is the LAST assistant message (the seed put a
"thinking out loud" message before it), and the round's builder is absent — `role = ANY($3::text[])`
filters as intended.

## B — one decision, one builder, two re-checks, replay-safe

`consolidateVerdictRound(200, inputs, 3)`:

```json
{
  "action": "fix",
  "cycle": 1,
  "builderChainKey": "fix:200:1",
  "checkers": [
    { "role": "reviewer", "chainKey": "rereview:200:1" },
    { "role": "tester",   "chainKey": "retest:200:1" }
  ]
}
```

`createFixChain(...)` called twice with that same decision:

| call | builder | re-review | re-test |
|---|---|---|---|
| first  | `created` | `created` | `created` |
| replay | `replay`  | `replay`  | `replay`  |

Rows in the table afterwards — three, not six, and not four:

```
 round |   role   |           title            | chain_key       | fix_cycle
-------+----------+----------------------------+-----------------+-----------
   201 | builder  | Fix cycle 1                | fix:200:1       |         1
   202 | reviewer | Re-review after fix cycle 1| rereview:200:1  |         1
   202 | tester   | Re-test after fix cycle 1  | retest:200:1    |         1
```

Both re-checks land in round 202, so they are themselves consolidated as one group when
they settle — the chain is self-similar, and a second fix cycle from that round merges
their feedback the same way.

## C — a fix builder with nobody to check it is refused

```
createFixChain: no re-checkers for project <id> round 900 cycle 1 —
a fix cycle must be re-checked by at least one verdict role
```

`RoundDecision`'s `checkers` is non-empty by construction, so this is unreachable from the
tick; it is a guard against a future caller closing a round on unverified work.

## D — the merged brief the fix builder receives

```
Feedback from round 200's reviewer + tester (fix cycle 1). Address EVERY point below;
the re-check will go through all of them against your new work.

## Feedback from reviewer: Diff review
The catch swallows the error.
VERDICT: NEEDS_FIXES

## Feedback from tester: Customer sweep
Empty state shows a stack trace.
VERDICT: NEEDS_FIXES
```

Nothing is summarised or dropped, and each section names the ROLE that raised it — a
tester's finding and a reviewer's are answered in different places, and a builder reading
a flat list of quotes cannot tell which kind it is holding.

## Unit coverage (T17, `src/lib/project-reconcile.test.ts`)

12 new tests: `isVerdictRole` over all eight roles; tester PASS alone; tester NEEDS_FIXES
alone → re-TEST not re-review; tester `no_verdict` → block; tester capped by the same
`max_cycles` ceiling; tester + reviewer both dissenting → one builder, one re-check each,
both voices in the brief; reviewer PASS + tester NEEDS_FIXES → fix (a PASS cannot outvote
the customer); reviewer NEEDS_FIXES + tester PASS → reviewer-only re-check; an unsettled
tester freezes a round whose reviewer already passed; a tester's `no_verdict` outranks a
reviewer's NEEDS_FIXES; the same group decided twice is byte-identical; role-specific
re-check titles and briefs.

`pnpm test` (whole suite, unchanged files included): 481 pass, 0 fail, 88 suites.
`npx tsc --noEmit`: clean.
