# Phase 300 — baseline read-side API transcript (round 301)

The PRE-CHANGE transcript every later phase-300 round is judged against.
Captured from the worktree harness on `:7798` (`scripts/checks/serve-v3-7798.ts`),
which serves **this worktree's** `agents`, `chat` and `projects` routers and
proxies everything else to production `:7700`.

| | |
|---|---|
| Captured at | 2026-08-05 ~13:05Z |
| Branch / HEAD | `project/8ea0cc08` @ `cf87d9a` |
| Source | `http://127.0.0.1:7798` (worktree routers) |
| DB | `content_forge` @ 127.0.0.1:5432 |
| Reproduce | `./capture.sh` |
| Verify | `scripts/checks/api-diff.sh` |

## Files

| File | Endpoint | Notes |
|---|---|---|
| `agents.json` | `/api/agents` | 60 rows, 58 settled |
| `agents-project.json` | `/api/agents?project_id=8ea0cc08…` | this project only |
| `agents-run.json` | `/api/agents/3853c154…` | pinned **settled** architect run — zero normalization applies to it |
| `chat-list.json` | `/api/chat?limit=5` | |
| `chat-thread.json` | `/api/chat/bfd1283a…` | the pinned linkage fixture, 314 thread entries |
| `projects-managers.json` | `/api/projects/managers` | |
| `projects.json` | `/api/projects` | 8 projects |
| `secrets.json` | `/api/secrets` | **unmounted** — proves the harness pass-through to :7700 works |

Pinned ids are constants in `capture.sh`. A baseline that picks "the newest run"
each time compares different rows every run and proves nothing.

## Correction to the round-301 brief — this is NOT main's output

The brief stated *"current code == main for these routes, so this is the true
baseline"*. **That is false, and it was worth checking.** Measured, not assumed:

```
git rev-list --left-right --count main...HEAD   →  main-only: 14   branch-only: 14
```

The live checkout `/opt/forge-ai-os` is exactly `main` @ `cf0ebdb`, so `:7700`
serves main's code. Capturing the same endpoint set from `:7700` and running
`api-diff.sh --current` against it measures worktree-vs-main directly:

| Endpoint | worktree vs main |
|---|---|
| `agents`, `agents-project`, `agents-run` | **KEY SET differs** |
| `chat-list`, `chat-thread`, `projects`, `projects-managers`, `secrets` | identical |

The `/api/agents` delta is **purely additive** — phases 1–2 of this project,
which are on the branch and not yet deployed:

```
rows      + agent_kind  + cron_name  + project_id  + role  + settled  + settled_at
subagents + description + ended_at
                                          (nothing removed, nothing renamed)
```

Main's four route commits the branch lacks (`d95e002` incremental SSE,
`c7522d3` idempotent fan-out, `bf77f52` unwedge, `cf0ebdb` steward/tester) touch
the SSE stream and POST handlers only — none of the captured GET responses
changes, which is why those five diff clean.

**Consequences, in order of who trips over them:**

1. **Round 302 is unaffected.** Its gate is "did my refactor change the output",
   and the correct reference for that is the state immediately before the
   refactor — which is exactly this transcript. Use it as-is.
2. **After the deploy-phase `merge main` this baseline is stale by construction.**
   Re-capture (`./capture.sh`) after the merge and before trusting a green run,
   or `api-diff.sh` will be comparing across two code versions and reporting
   real merge deltas as regressions.
3. If a later round needs a true *main* reference, it is one command:
   `API_BASE=http://127.0.0.1:7700 ./capture.sh /tmp/main-ref`.

## What `api-diff.sh` guarantees

Normalization is conservative and fully enumerated in the script header. The
guarantee that matters: **a row settled in both captures is compared with zero
normalization** — every field, `elapsed_ms` included, must be byte-equal. Only
live rows' listed clock fields and top-level `now`/rollups are waived, and even
then only their *values*: `blank()` overwrites keys in place and never recreates
a deleted one, so a removed or renamed field is still caught by the key-set
layer.

Round-301 evidence that the check works in both directions is in
`../verification-301.md`.
