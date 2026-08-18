# Round 1861 — Pre-deploy (step 1 of 4)

Worktree: `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`, branch `project/8ea0cc08`.
`/opt/forge-ai-os` was not touched. No pm2 process was restarted, no migration applied, no browser started.

Run: 2026-08-17, worktree only.

---

## 1. Merge main — VERDICT: no divergence, merge is a no-op

```
$ git fetch --all --prune
(no output — nothing new on origin)

$ git rev-parse HEAD    1eae6f2f3a5056ab83fca0d8d3a130207c38357e
$ git rev-parse main    1eae6f2f3a5056ab83fca0d8d3a130207c38357e

$ git rev-list --count HEAD..main    0
$ git rev-list --count main..HEAD    0
$ git merge-base HEAD main           1eae6f2f3a5056ab83fca0d8d3a130207c38357e
$ git merge-base --is-ancestor main HEAD    → YES
```

**SHA before merge: `1eae6f2`. SHA after merge: `1eae6f2`.** `main` and `project/8ea0cc08`
are the *same commit*, not merely non-divergent. No merge commit was created, no empty
merge commit was created, no conflict arose. The planner's 09:20 state still holds: main
did not move while this task ran.

Cross-check against the live checkout, read-only:

```
$ git -C /opt/forge-ai-os rev-parse main    1eae6f2f3a5056ab83fca0d8d3a130207c38357e
```

The live checkout's `main` agrees. The authoritative `main` here is the local branch:
`origin/main` sits at `9ef01eb`, **129 commits behind** local `main` (`git branch -v` prints
`main … [ahead 129]`). Pushing `main` is not this task's business; noted so a later step
does not mistake `origin/main` for the deploy target.

### Migration numbering — the foreseen 0040 collision did not materialise

```
$ ls db/migrations/ | grep '^004'
0040_usage_hourly.sql
0041_ui_dismissals.sql
```

Only **one** `0040` exists in this tree. The brief anticipated a second one
(`0040_task_graph.sql` from engine-task-graph) arriving via the merge — it did not, because
main has not moved and that project has not deployed yet. Nothing was renamed. If
engine-task-graph deploys before this branch merges, the duplicate number will appear then
and remains, per the brief, known and expected: there is no migration runner and no
tracking table.

---

## 2. Type and build gates, re-run after the merge

All three run inside the worktree, at `1eae6f2`.

### `forge-control && npx tsc --noEmit`

```
(no output)
TSC_FORGE_CONTROL_EXIT=0
```

### `forge-control-web && npx tsc --noEmit`

```
(no output)
TSC_WEB_EXIT=0
```

### `forge-control-web && NODE_ENV=production pnpm build`

```
   ▲ Next.js 15.1.3
   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)

Route (app)                              Size     First Load JS
┌ ƒ /                                    7.11 kB         351 kB
├ ○ /desktop                             214 B           345 kB
├ ○ /canvas                              565 B           174 kB
├ ○ /document                            872 B           159 kB
├ ○ /settings                            1.54 kB         115 kB
├ ○ /settings/secrets                    2.35 kB         118 kB
└ ƒ /signin                              156 B           108 kB
+ First Load JS shared by all            108 kB
ƒ Middleware                             83.2 kB

BUILD_EXIT=0
```

12 routes, clean. No missing dependency, so no `pnpm add` was needed.

---

## 3. The gate suite, with the masking gone

### 3a. The pipefail fix is still in the tree — confirmed before trusting any result

`scripts/checks/gates-808.sh:85`:

```bash
  # Set inside `bash -c`, not on this shell: the gate body is the only thing
  # whose pipelines this may change.
  bash -c "set -o pipefail; $script"
```

Present, unmodified. And it does what it claims — negative control on the exact shape
`gate_sh` uses:

```
$ bash -c "set -o pipefail; false | tail -1"   → EXIT=1
$ bash -c "false | tail -1"                    → EXIT=0
```

So a red gate body whose output is piped now propagates; before the fix it did not.

### 3b. Full gate table — `bash scripts/checks/gates-808.sh`

Suite exit 0. 25 gate slots, 23 executed, 2 skipped.

| # | Gate | Exit |
|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | 0 |
| 2 | `npx tsc --noEmit` — forge-control-web | 0 |
| 3 | `NODE_ENV=production pnpm build` — forge-control-web | 0 |
| 4 | token purity — round 808's own files | 0 |
| 5 | `no-raw-colours.cjs` (whole app) | 0 |
| 6 | forbidden-file diff — three-dot `main...HEAD` | 0 |
| 7 | `forge-control/` untouched by round 808's own commits | 0 |
| 8 | `dollar-sweep.sh` | 0 |
| 9 | `check-composer-v3.ts` | 0 |
| 10 | `check-secret-requests.ts` | 0 |
| 11 | `contrast-canvas-banners.cjs` | 0 |
| 12 | `check-working-sql-agreement.ts` — standalone typecheck | 0 |
| 13 | `check-stop-affordance.tsx` — ⏸ disabled state vs what a click does | 0 |
| 14 | `check-dismiss-peek.tsx` — the way back out of a dismissal, both surfaces | 0 |
| 15 | `check-team-rows.ts` — flatten, hiddenRows, frozen time | 0 |
| 16 | `check-team-confirm.ts` — destructive-control machines (✕, stop, restore-all) | 0 |
| 17 | `verify-notification-gap-pins.mjs` — fenced quotes + prose pins | 0 |
| 18 | `check-usage-fold.ts` — hourly token fold, against a real Postgres | 0 |
| 19 | `check-usage-fold.ts` — standalone typecheck | 0 |
| 20 | `pnpm test` — forge-control unit suite | 0 |
| 21 | `psql-argv-leak.cjs` — round 807 finding 3 | 0 |
| 22 | `nav-walk-sampling.cjs` — round 807 finding 4 | 0 |
| 23 | `phase700/network-700.cjs` (NFU3) | — SKIPPED |
| 24 | `phase600/nav-walk.cjs` — P1/P2/P3 | — SKIPPED |
| 25 | reproduce-cleanliness — re-running a protocol leaves the tree untouched | 0 |

`RED: 0`.

Gates 23 and 24 are the browser harness. They are skipped by design without `--browser`
(the suite prints `SKIPPED — browser harness not requested`, never silently omits them).
They need an API on its own port with an isolated `SECRET_STORE_DIR` and a web build baked
against it; the brief forbids starting a browser in this task, so they stay for a later step.

Gate 20 detail: `# tests 862 / # pass 862 / # fail 0`.

### 3c. How many gates changed verdict now that the masking is gone: **ZERO**

Measured, not asserted. A byte-identical copy of the runner with **only** line 85 reverted
to the masking form was built and run against the same tree:

```
$ diff scripts/checks/gates-808.sh scripts/checks/.control-nopipefail.sh
85c85
<   bash -c "set -o pipefail; $script"
---
>   bash -c "$script"
```

Both suites ran to completion; the 23 executed exit codes were compared position by position:

```
pipefail-ON  : 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
pipefail-OFF : 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
diff → IDENTICAL
```

The control script was untracked and was removed immediately after the run; `git status`
is clean (also independently confirmed by gate 25, reproduce-cleanliness).

This result is what it should be, and the direction matters. `pipefail` is strictly the
*stricter* mode: if a pipeline exits 0 with `pipefail` on, every command in it exited 0, so
it exits 0 with `pipefail` off as well. Green-with-masking-gone therefore *implies*
green-with-masking. Zero changed verdicts is not evidence the fix was pointless — it is
evidence that **the reds the masking had been hiding were already found and fixed**, in
rounds 1354–1357, before this pre-deploy ran.

### 3d. `dollar-sweep.sh` — the planner's expected red is GONE, and not by allowlist padding

The brief warned that gate 8 was red on this branch with 6 unlisted files while the suite
reported it green, and told me explicitly not to "fix" it by adding files to
`scripts/checks/dollar-allowlist.txt`. **I added nothing.** The gate is genuinely green:

```
$ bash scripts/checks/dollar-sweep.sh     (run directly, unpiped)
primary gate: 95 hit(s), all allowlisted.
dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.
DIRECT_EXIT=0
```

Both sections pass — the primary gate and the reviewer's literal §6 command. The script's
exit logic is real (`dollar-sweep.sh:140-143`: prints FAIL and `exit 1` on any unlisted hit,
PASS otherwise), so the 0 is earned rather than swallowed.

The red the planner recorded was closed by **round 1356 (`1c0c23e`)**, one commit before
HEAD — after the planning snapshot's source observation was taken. That commit's *entire*
diff to the allowlist is one line, and it does not add a file; it narrows an existing
`UsagePanel.tsx` entry's pattern to also cover the token name `spend_log`:

```
-…UsagePanel.tsx  usd|USD|eur_per_usd|€|shadow|spent
+…UsagePanel.tsx  usd|USD|eur_per_usd|€|shadow|spent|spend_log
```

(reason recorded in the allowlist itself: two header comments name the *source table* the
bucket's turn count comes from — a table name in prose, not a rendered amount. The bare
word `spend` is still not allowlisted for that file, so a real spend value landing there
still fails the gate.)

**No open item remains on gate 8**, and there are no 6 unlisted files to name.

### 3e. Classification of every red

There are none. RED count is 0 in both the real run and the masked control, so there is
nothing to classify as (i) pre-existing or (ii) caused by the merge — and, the merge being
a no-op on an identical SHA, category (ii) is empty by construction. **Nothing blocks the
deploy on gate grounds.**

---

## 4. Push

See §5 of the final report. Push is plain, never forced.

---

## Open items for later steps

1. **Browser gates 23/24 have not run this round.** Skipped by design (no `--browser`, and
   this task forbids starting a browser). If the deploy wants them, they need the phase800
   §2 harness up first.
2. **`origin/main` is 129 commits behind local `main`.** The deploy target is the local
   `main` in `/opt/forge-ai-os`, not the GitHub remote. Do not let a later step resolve
   "main" to `origin/main`.
3. **Duplicate migration number is still latent, not present.** `0040_task_graph.sql` from
   engine-task-graph has not landed on main. When it does, both `0040`s coexist by design.
4. **forge-control-web is still stale on the live box** (last built 05:18, five commits
   behind). That is step 2–4's job; nothing was rebuilt or restarted here.
