# Phase 300 — baseline read-side API transcript (recaptured round 308)

The reference transcript every phase-300 round is judged against. **Round 308
recaptured it from `:7700` — production, i.e. `main`** — which is what item 3 of
the round-301 correction below said to do when a round needed a true main
reference. Round 308 is that round: review findings 4 and 5 asked for a gate
that attributes failures instead of going permanently red, and attribution needs
a baseline whose code version is known.

| | |
|---|---|
| Captured at | 2026-08-05 15:41Z |
| Source | `http://127.0.0.1:7700` — **main**, the live checkout `/opt/forge-ai-os` @ `452f5f3` |
| Worktree at capture time | `project/8ea0cc08` @ `7e278d9` (not the source; the branch is what gets compared *against* this) |
| DB | `content_forge` @ 127.0.0.1:5432 |
| Reproduce | `API_BASE=http://127.0.0.1:7700 ./capture.sh` |
| Verify | `scripts/checks/api-diff.sh --control` |

The previous baseline (round 301, from `:7798` while the worktree was
byte-identical to main) is in git history at `7e278d9` if a round ever needs it.

## Files

| File | Endpoint | Notes |
|---|---|---|
| `agents.json` | `/api/agents` | 60 rows, 58 settled |
| `agents-project.json` | `/api/agents?project_id=8ea0cc08…` | this project only |
| `agents-run.json` | `/api/agents/3853c154…` | pinned **settled** architect run — zero normalization applies to it |
| `chat-list.json` | `/api/chat?limit=50` | all 7 chats, so the one that resolves to a project is inside the row-alignment window (finding 5) |
| `chat-thread.json` | `/api/chat/da286217…` | repinned in round 308: **settled since 2026-07-29**, 183 entries. The old pin was Konrad's live operator chat, which drifted between every capture (finding 4) |
| `projects-managers.json` | `/api/projects/managers` | |
| `projects.json` | `/api/projects` | 10 projects |
| `secrets.json` | `/api/secrets` | now a LOCAL mount on :7798 (finding 2) — it is how U7's additive field is gated |
| `health.json` | `/api/health` | **unmounted** — took over from `secrets` as the proof that the harness pass-through to :7700 is alive |

Pinned ids are constants in `capture.sh`. A baseline that picks "the newest run"
each time compares different rows every run and proves nothing.

## Reading a `--control` run

The worktree differs from this baseline in ways that are *supposed* to differ:
phases 1–2 add six fields to every agents row and two to every sub-agent, U3
adds four to a linked chat row, U7 adds one to a secret. All of them are
declared in `api-diff.sh`'s `additive_for()` and printed as `ADD` lines, and the
gate FAILS if one of them is missing from the worktree capture or already
present in the control — an undeclared addition or any removal fails too. Value
differences fail only when the control does not reproduce them.

Round-308 mutation evidence that this can fail is in `../verification-308.md`.

## History — the round-301 baseline and why it was replaced

*(Everything below describes the ORIGINAL capture, from `:7798` at 2026-08-05
~13:05Z, branch `cf87d9a`. It is kept because its measurement of the
worktree↔main delta is still the authoritative description of what this phase
adds — and it is exactly the list `additive_for()` now enforces.)*

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
