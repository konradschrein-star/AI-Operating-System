# deploy-903.md — U33 deploy evidence (phase 900, round 903)

Branch: `project/8ea0cc08` → `main`. Live checkout: `/opt/forge-ai-os`.
Worktree: `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`.

Headline: **main had NOT moved** (step 1 was a no-op), **nothing conflicted**, the corpus
guard printed nothing, and **forge-executor was never touched**.

---

## BASELINE (captured before anything else)

```
$ pm2 jlist | node -e '...forge-* name, status, restart_time, pm_uptime...'
forge-api          online restarts=0  up_since=2026-08-11T04:39:56.234Z
forge-control-web  online restarts=1  up_since=2026-08-16T19:55:31.627Z
forge-control      online restarts=10 up_since=2026-08-16T20:18:58.894Z
forge-executor     online restarts=0  up_since=2026-08-11T04:39:56.273Z
```

forge-executor's triple matches the planning-time value exactly
(`online restarts=0 up_since=2026-08-11T04:39:56.273Z`).

SHAs at start:

```
$ git -C /opt/forge-ai-os rev-parse main
9ef01eb891652964d1b0c3beb25523c02a81e8ba
$ git rev-parse HEAD          # this worktree
4db2f86e95c6badb1e07e56a43e2a7faf98f7beb
$ git -C /opt/forge-ai-os branch --show-current
main
$ git -C /opt/forge-ai-os status --porcelain
(empty)
```

---

## STEP 1 — merge main into the work branch (in this worktree)

```
$ git fetch --all
(no output)
$ git rev-parse main
9ef01eb891652964d1b0c3beb25523c02a81e8ba
$ git merge-base HEAD main
9ef01eb891652964d1b0c3beb25523c02a81e8ba
$ git merge main
Already up to date.
EXIT=0
$ git rev-parse HEAD
4db2f86e95c6badb1e07e56a43e2a7faf98f7beb
$ git status --porcelain
(empty)
```

`merge-base HEAD main` == main's HEAD == `9ef01eb`, exactly as the brief predicted.
**main did not move; the merge was a no-op; zero conflicts.** No `--abort` was needed and
no `-X ours` / `-X theirs` was used anywhere in this task.

---

## STEP 2 — re-verify in the worktree

### 2a. `npx tsc --noEmit` — forge-control

```
$ cd forge-control && npx tsc --noEmit
TSC_CONTROL_EXIT=0
```
(no diagnostics emitted — 0 errors)

### 2b. `npx tsc --noEmit` — forge-control-web

```
$ cd forge-control-web && npx tsc --noEmit
TSC_WEB_EXIT=0
```
(no diagnostics emitted — 0 errors)

### 2c. Build — forge-control-web

Real build command confirmed from the repo, not guessed: `forge-control-web/package.json`
declares `"build": "next build"` and the repo carries `pnpm-lock.yaml`, so the build is
`pnpm build` (pnpm, not npm).

```
$ cd forge-control-web && pnpm build

> forge-control-web@0.1.0 build /opt/ai-os/workspace/projects/8ea0cc08-.../forge-control-web
> next build

   ▲ Next.js 15.1.3

   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
   Collecting page data ...
 ✓ Generating static pages (10/10)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                              Size     First Load JS
┌ ƒ /                                    7.11 kB         331 kB
├ ○ /_not-found                          987 B           109 kB
├ ƒ /api/auth/[...nextauth]              156 B           108 kB
├ ƒ /api/canvas-events                   156 B           108 kB
├ ƒ /api/events/[id]                     156 B           108 kB
├ ƒ /api/secret-events                   156 B           108 kB
├ ○ /canvas                              565 B           174 kB
├ ○ /desktop                             211 B           324 kB
├ ○ /document                            872 B           159 kB
├ ○ /settings                            3.26 kB         115 kB
├ ○ /settings/secrets                    2.35 kB         118 kB
└ ƒ /signin                              156 B           108 kB
+ First Load JS shared by all            108 kB
  ├ chunks/2459-0fd034f1fd4b0720.js      50.7 kB
  ├ chunks/91de8857-2da4f0b1fb30b258.js  53 kB
  └ other shared chunks (total)          4.32 kB

ƒ Middleware                             83.2 kB

BUILD_EXIT=0
```

### 2d. `bash scripts/checks/gates-808.sh --strict`

```
================================================================================
 SUMMARY — 17 gates
================================================================================
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck
 13 0      psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard
 14 0      nav-walk-sampling.cjs — round 807 finding 4, the arithmetic
 15 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 16 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 17 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 0
GATES_EXIT=0
```

15/15 non-browser gates green, **RED: 0**, `--strict` exited 0. Gates 15 and 16 are the
browser harness, skipped by design because `--browser` was not passed (they are round 904's
scope, not the deploy's). No red gate to reconcile against round 902's `gates-900.txt`, so
the "same red as 902?" branch of the runbook did not apply.

---

## STEP 3 — corpus guard, re-run after the step-1 merge and immediately before the merge to main

```
$ git diff --name-status main -- docs/plan/ | grep -E '^(D|M)' | grep -vE 'operator-visibility/|artifacts/'
(empty — 0 lines)
```

Stronger than required: the unfiltered probe also came back empty —

```
$ git diff --name-status main -- docs/plan/ | grep -E '^(D|M)'
(no D/M lines at all)
```

i.e. this branch **adds** files under `docs/plan/` and modifies or deletes **nothing**
that main already had. engine-v2-research-lane's `docs/plan/00..04` was never at risk.
Verified again post-merge on main (see step 4).

---

## STEP 4 — merge to main

```
$ cd /opt/forge-ai-os
$ git status --porcelain
(empty)
$ git branch --show-current
main
$ git rev-parse main            # BEFORE
9ef01eb891652964d1b0c3beb25523c02a81e8ba

$ git merge project/8ea0cc08
Updating 9ef01eb..4db2f86
Fast-forward
 README.md | 55 +-
 ... 429 files changed, 226476 insertions(+), 1282 deletions(-)
 create mode 100644 scripts/checks/serve-sse-808.ts
 create mode 100644 scripts/checks/serve-v3-7798.ts
 create mode 100644 tsconfig.checks.json
MERGE_EXIT=0

$ git rev-parse main            # AFTER
4db2f86e95c6badb1e07e56a43e2a7faf98f7beb
$ git status --porcelain
(empty)
```

**Zero conflicts.** Fast-forward, as predicted. Code-only slice of the merge (excluding
docs): 91 files changed, 23812 insertions(+), 1281 deletions(-).

Post-merge corpus check on main — the other project's plan documents are intact:

```
$ ls -1 /opt/forge-ai-os/docs/plan/
00-vision.md
01-requirements.md
02-architecture.md
03-quality.md
04-phases.md
05-control-plane-boundary.md
06-control-plane-requirements.md
07-control-plane-architecture.md
08-control-plane-quality.md
09-control-plane-phases.md
10-policy-agent-autonomy-and-escalation.md
archive
artifacts
evidence
operator-visibility
```

Both main SHAs: **before `9ef01eb891652964d1b0c3beb25523c02a81e8ba`**,
**after `4db2f86e95c6badb1e07e56a43e2a7faf98f7beb`**.

---

## STEP 5 — rebuild and restart

Dependency check first — no install was needed, because the merge changed no manifest:

```
$ git diff --name-only 9ef01eb..4db2f86 -- '*package.json' '*pnpm-lock.yaml'
(empty)
```

### Build (live checkout)

```
$ cd /opt/forge-ai-os/forge-control-web && pnpm build

> forge-control-web@0.1.0 build /opt/forge-ai-os/forge-control-web
> next build

   ▲ Next.js 15.1.3
   - Environments: .env.local

   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
   Collecting page data ...
 ✓ Generating static pages (10/10)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                              Size     First Load JS
┌ ƒ /                                    7.11 kB         331 kB
├ ○ /desktop                             211 B           324 kB
├ ○ /canvas                              565 B           174 kB
├ ○ /document                            872 B           159 kB
├ ○ /settings                            3.26 kB         115 kB
├ ○ /settings/secrets                    2.35 kB         118 kB
└ ƒ /signin                              156 B           108 kB
+ First Load JS shared by all            108 kB

ƒ Middleware                             83.2 kB

LIVE_BUILD_EXIT=0
```

Bundle sizes are byte-identical to the worktree build — the deployed artifact is the one
that was verified.

### Restarts — the complete list, and nothing else

```
$ pm2 restart forge-control-web
RESTART_WEB_EXIT=0

$ pm2 restart forge-control
[PM2] Applying action restartProcessId on app [forge-control](ids: [ 16 ])
[PM2] [forge-control](16) ✓
RESTART_CONTROL_EXIT=0
```

forge-control was restarted because API files did change this cycle (routes/agents.ts,
agents-shared.ts, chat.ts, chat-linkage.ts, capabilities.ts, working-time.ts, secrets.ts,
run-control.ts, projects.ts …).

**`pm2 restart forge-executor` was never run.** Neither was `pm2 reload`,
`pm2 restart all`, nor `pm2 save`. forge-api was also left alone.

---

## STEP 6 — smoke

```
$ pm2 jlist | node -e '...'   # same one-liner as the baseline
forge-api          online restarts=0  up_since=2026-08-11T04:39:56.234Z
forge-control-web  online restarts=2  up_since=2026-08-16T21:36:07.539Z
forge-control      online restarts=11 up_since=2026-08-16T21:36:11.263Z
forge-executor     online restarts=0  up_since=2026-08-11T04:39:56.273Z
```

| process           | restarts before | restarts after | delta | verdict                   |
|-------------------|-----------------|----------------|-------|---------------------------|
| forge-control-web | 1               | 2              | +1    | expected                  |
| forge-control     | 10              | 11             | +1    | expected                  |
| forge-executor    | 0               | 0              | **0** | **untouched**             |
| forge-api         | 0               | 0              | 0     | untouched (not on list)   |

forge-executor `up_since` = `2026-08-11T04:39:56.273Z` — **byte-identical to the baseline
and to the planning-time value. No SEV.**

```
$ curl -s http://127.0.0.1:7700/api/health
{"ok":true,"service":"forge-control","version":"0.1.0","uptime_seconds":11,"timestamp":"2026-08-16T21:36:22.448Z"}
```

Web port resolved from `forge-control-web/package.json` (`next start -p 7701`), not guessed:

```
$ curl -sI http://127.0.0.1:7701 | head -1
HTTP/1.1 307 Temporary Redirect
location: https://os.schreinercontentsystems.com/signin

$ curl -sI http://127.0.0.1:7701/signin | head -1
HTTP/1.1 200 OK
```

The 307 on `/` is the auth middleware redirecting an unauthenticated request to `/signin`,
which itself serves 200. The web app is up.

---

## SCOPE NOTE

Per the brief this task deploys and does not verify features: no browser was opened, no
screenshots were taken, no feature-liveness curls were run. Production verification is
round 904's.

## PROVENANCE OF THIS FILE

Steps 1–3 were executed and recorded before the step-4 merge; steps 4–6 were appended
after. This document is therefore committed on `project/8ea0cc08` *after* the main merge
already happened, and is brought to main by a second fast-forward of the same branch —
docs-only, no code delta, so no rebuild or restart follows it. The final main SHA in the
"after" row above is the code-bearing merge; the doc commit sits one fast-forward beyond it
and is recorded in the final message.
