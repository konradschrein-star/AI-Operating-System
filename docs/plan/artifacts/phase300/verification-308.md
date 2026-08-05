# Round 308 — fix cycle 1 for the round-307 review

Six findings, six fixes, each with the evidence the reviewer asked for. Every command
below was run in this worktree against the harness on `:7798`; nothing outside the
worktree was modified, and `/opt/forge-ai-os` was not touched.

| # | finding | fix | evidence |
|---|---|---|---|
| 1 | `working_ms: 0` for sub-agents that ran | `null` when the rollup has no independent end stamp | §1 |
| 2 | U7 unreachable through the harness | `/api/secrets` mounted on :7798 | §2 + `u7-secrets-7798.md` |
| 3 | `traversal.txt` not reproducible from its own text | fixture disclosed in the header + a fixture-free re-run | §3 |
| 4 | `api-diff.sh` permanently red | `--control` attribution + a settled chat pin | §4 |
| 5 | additive fields never exercised | executable allowlist, asserted; baseline recaptured at `limit=50` | §4 |
| 6 | JS/SQL disagree below the millisecond | each stamp truncated before the subtraction | §5 |

---

## §1 — `working_ms: null`, not `0` (finding 1)

**Root cause, confirmed in the database.** Run `11dd264b…` carries no
`metadata.subagents_v2` and **zero** parent-tagged thread entries:

```
$ psql -c "select (metadata ? 'subagents_v2') as has_v2,
           count(*) filter (where e.val->'meta'->>'parent_tool_use_id' is not null)
             as parent_tagged_entries ..."
 has_v2 | parent_tagged_entries
--------+-----------------------
 f      |                     0
```

So `agents-shared.ts` synthesises each sub-agent from its spawn call alone and sets
`started_at === updated_at === the spawn ts`. The rollup subtracted those two identical
stamps and reported `0` — a measurement of nothing, rendered as "did no work".

**Fix.** `workingTimeFromRollup()` now returns a `RollupWorkingTime` whose `working_ms`
is `number | null`, and answers `null` whenever there is no independent end stamp:
either stamp missing or unparseable, `end === start`, or `end < start`. A RUNNING
rollup keeps its number, because `now` **is** a second observation — a sub-agent
spawned this instant has genuinely done 0 ms of work and ticks up on the next poll.
`working_ms_source` stays `"rollup"` in every case: the provenance flag does not
disappear because the number is unknown.

**After, on the endpoint from the finding:**

```
$ curl -s :7798/api/chat/11dd264b-f173-44d7-ada4-f1eb39fb4abd/team | jq …
rollup sub-agents: 7; working_ms values now: [null]
{"complete":true, "manager_working":9442198,
 subs:[{"role":"agent","status":"done","working_ms":null,"working_ms_source":"rollup", …} ×7]}
```

Before: seven nodes with `working_ms: 0, working_ms_source: "rollup", status: "done"`.
After: the same seven with `null`. The tree's other sub-agent — the one WITH a thread
slice — is untouched and still a number:

```
{"id":"toolu_01KA","role":"scout","working_ms":34295,"status":"done"}   ← source "thread"
```

**Unit coverage** — `check-working-time.ts` went from 38 to 51 `check()` call sites
(121 PASS lines at runtime, the table cases being looped), including `updated_at === started_at → null, NOT 0`, `end before start → null`,
`missing end → null`, unparseable start/end → null with the stamp counted, and the two
running cases that must still be `0`. `ALL PASS`, exit 0.

**One gap, stated rather than papered over.** A rollup with a *genuine* span
(`updated_at > started_at`) must still return that number, and the unit table asserts
it (`rollup settled span → uncapped wall clock (300s)`), but there is no end-to-end
curl of one: the only two chats in the database that resolve to a project reach
projects whose runs have no such sub-agent, and every run that does have one belongs to
project `8ea0cc08` (this project, active) or `4120f785` (engine-v2-research-lane, out of
bounds this cycle). Reaching one would mean writing `origin_chat_id` onto an ACTIVE
project row. Round 306 did exactly that and the resulting transcript is finding 3;
round 308 declines to repeat it.

## §2 — U7 is now exercisable on :7798 (finding 2)

`serve-v3-7798.ts` mounts `secrets` (`MOUNTS`), and the harness header documents the
consequence: the mount is LOCAL, so a write hits whatever `SECRET_STORE_DIR` the
process started with. The full transcript — 11 numbered cases, isolated store at
`/tmp/u7-store-308`, Konrad's real store verified untouched afterwards — is in
`u7-secrets-7798.md`. The headline:

```
worktree :7798 →  bytes,name,note,pending,requestedByRunId,updatedAt
main     :7700 →  bytes,name,note,pending,updatedAt
difference     →  requestedByRunId          ← strict superset, exactly one field
```

The pass-through proof that `/api/secrets` used to provide moved to `/api/health`,
which no mount claims; it is now the ninth endpoint in the capture set.

## §3 — `traversal.txt` (finding 3)

Two changes, no deletion:

1. A `!!`-marked block at the top gives the exact `UPDATE`, the exact revert (`metadata
   - 'origin_chat_id'`, because the key was ABSENT before — not `null`), and the
   confirming query. It also says why round 308 did not re-apply it.
2. A new **section 11** re-runs the protocol against `c0de0304…`, which resolves to a
   project through `metadata->>'origin_chat_id'` with **no fixture at all**: 12
   rejection cases, the missing-plan-directory 404, the malformed-uuid 400 and the
   unlinked-chat 404. Every line in it can be pasted as-is. Its own scope limit is
   printed in the section: that project has no `docs/plan` on disk, so the 200/413
   cases and the symlink fixtures still need a project with a real plan directory.

```
$ git status --porcelain docs/plan | grep -v artifacts/phase300 | wc -l  →  0
$ find docs/plan -maxdepth 1 -type l | wc -l                            →  0
```

## §4 — the gate attributes instead of glowing red (findings 4, 5)

**`--control`.** `api-diff.sh --control [URL]` captures CURRENT from `$API_BASE`
(:7798, the worktree) and CONTROL from `$CONTROL_BASE` (:7700, main), diffs both
against the same baseline with the same row alignment — narrowed to the three-way id
intersection so the two failure sets cover the same rows — and fails only on what
differs in CURRENT and not in CONTROL.

**The additive allowlist is executable and asserted.** `additive_for()` declares every
field this phase adds; `--control` fails if one is missing from CURRENT, if one is
already present in CONTROL, if any other key is added, or if any key is removed.

**Baseline recaptured from `:7700`** so "control = main = baseline's code version" is
true by construction, with two pins changed:

* `chat-list` at `limit=50` instead of `limit=5`. There are 7 chats; the only one that
  resolves to a project (`c0de0304…`) sat outside the old page, so the four U3 fields
  fell outside the row-alignment window and the gate proved nothing about them. It is
  now at index 1 of the baseline capture.
* `chat-thread` repinned from `bfd1283a…` (Konrad's live operator chat — `message_count`
  314 → 354 and `spent_usd` 49.92 → 55.44 between captures) to `da286217…`, `completed`
  since 2026-07-29, 183 entries.

**A defect the new gate found in the old normalization.** `LIVE` for an agents row was
`.settled != true`, and `settled` is one of the fields this phase ADDS — so against a
baseline captured from main, where the key does not exist, every finished row was
classified live and blanked to `<<volatile>>` on both sides. The comparison waived
itself. `AGENT_SETTLED` now falls back to a terminal `status` when the key is absent.

**A defect the new gate had in itself.** The first `leafdiff()` used
`reduce (paths(scalars)) as $p ({}; .[…] = (getpath($p)|tojson))` — inside `reduce`, `.`
is the accumulator, so `getpath` read the half-built object and every value came back
`null`. It reported "byte-equal" on documents where `agent.elapsed_ms` was 31 821 774 on
one side and 949 322 on the other. Fixed with `. as $doc`; the sanity check that caught
it is now written into the function's comment.

**Result — green, and non-vacuous:**

```
ADD   agents      — + agent_kind + cron_name + project_id + role + settled + settled_at
                    + subagents[].description + subagents[].ended_at
ok    agents      — no worktree-only difference (58 drifted value(s), control drifted identically)
ok    agents-project — … (24 drifted)
ok    agents-run  — … (1 drifted)
ADD   chat-list   — + runs[].project_id + project_status + tasks_done + tasks_total
ok    chat-list, chat-thread, health, projects-managers, projects
ADD   secrets     — + secrets[].requestedByRunId
ok    secrets

api-diff.sh: PASS — 9 endpoints; every difference from the baseline is reproduced by
                    the control, plus the declared additive fields.
```

**Mutation test — four ways to break it, four failures, one clean control:**

| mutation | exit | message |
|---|---|---|
| *(none)* | **0** | PASS — 9 endpoints |
| `projects.count` 10 → 999 in CURRENT | **1** | `FAIL projects — 1 value(s) differ against the worktree ONLY` |
| `chat-list` rows gain `sneaky: 1` | **1** | `FAIL chat-list — key(s) ADDED but not declared in additive_for(): + runs.[].sneaky` |
| `chat-list` rows lose `project_id` | **1** | `FAIL chat-list — declared additive field(s) NOT PRESENT in the current capture: ? runs.[].project_id` |
| `secrets` rows lose `note` | **1** | `FAIL secrets — key(s) REMOVED by the worktree (control still has them): − secrets.[].note` |

## §5 — sub-millisecond agreement (finding 6)

The reviewer's option A, not option B: the divergence is removed rather than documented.
`Date.parse` keeps three fractional digits and truncates the rest (measured: `.674825`,
`.674999` and `.6745` all parse to `…674`), so the SQL now truncates **each stamp** to
whole milliseconds before the `lag()` subtraction rather than differencing raw
`timestamptz` values. Truncating the gap instead would be a different function
(`0.6 + 0.6` → 1, versus 0 + 1 from two truncated stamps).

Measured on the exact pair from the finding:

```
OLD (raw timestamptz subtraction)  = 1000.500000     ← a fractional working_ms
NEW (trunc per stamp)              = 1001
JS core                            = 1001            ← agreement
```

**`check-working-sql-agreement.ts` is new** — the round-307 reviewer had to write their
own script to re-verify the round-303 proof, so it is now a committed check that imports
`WORKING_MS_SQL` (never retypes it) and exits 1 on any Δ. It shells out to `psql` because
the repo-root `scripts/` tree has no `node_modules` and `import { Pool } from "pg"` does
not resolve there (the same limitation `serve-v3-7798.ts` documents for `hono`).

```
── A. synthetic threads: 8 cases × (JS, SQL, Δ) — including the two µs cases
── B. live data
rows: 28   thread entries: 6418   mismatches: 0   skipped timestamps: 0
ALL PASS — JS/SQL working-time agreement (U5)          exit 0
```

Part B covers every run of this project plus three real chats, among them the 2 477-entry
`11dd264b…` and Konrad's 358-entry operator chat.

## Universal gates

| gate | result |
|---|---|
| `npx tsc --noEmit` forge-control | **exit 0** |
| `npx tsc --noEmit` forge-control-web | **exit 0** |
| standalone tsc, each `scripts/checks/*.ts` | **7/7 exit 0** (six existing + the new agreement check) |
| `NODE_ENV=production npx next build` | **exit 0**, ✓ compiled, 9/9 static pages |
| `check-classify` / `check-duration` / `check-project-metadata` / `check-working-time` / `check-working-sql-agreement` | **5/5 exit 0** |
| `api-diff.sh --control` | **exit 0** |
| forbidden paths | `project-tick.ts`, `cc-runner.ts`, `executor.ts`, `db/projects.ts`, `FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts` — **0 changed** |
| `forge-control-web` source files changed | **0** |
| `/opt/forge-ai-os` | untouched |

## Files changed

```
forge-control/src/routes/working-time.ts     RollupWorkingTime + null semantics; trunc in the SQL
forge-control/src/routes/chat.ts             subagentWorkingTime → number | null; docs
scripts/checks/check-working-time.ts         +14 assertions (null-not-zero, trunc in the fragment)
scripts/checks/check-working-sql-agreement.ts  NEW — the JS/SQL proof, re-runnable
scripts/checks/serve-v3-7798.ts              mount /api/secrets; header on SECRET_STORE_DIR
scripts/checks/api-diff.sh                   --control, additive_for(), changed_for(), leafdiff(),
                                             AGENT_SETTLED, health spec
docs/plan/artifacts/phase300/baseline/        recaptured from :7700; capture.sh repins + health
docs/plan/artifacts/phase300/traversal.txt    fixture disclosed; §11 fixture-free re-run
docs/plan/artifacts/phase300/additive-fields.md  round-308 section, matches additive_for()
docs/plan/artifacts/phase300/u7-secrets-7798.md  NEW — the U7 transcript finding 2 asked for
```
