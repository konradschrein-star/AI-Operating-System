# Evidence — P7 deploy (round 715)

The second phase permitted to touch `/opt/forge-ai-os`. Same protocol as
`docs/plan/evidence/p6-deploy.md`, run verbatim and in order, per
`docs/tools/deploy-playbook.md` §6. Every block below is pasted output from the command
above it — nothing is paraphrased.

Paths: **WORKTREE** = `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
(branch `project/4120f785`), **LIVE** = `/opt/forge-ai-os`.

---

## 0. Gate on the reviewer verdict

The brief conditions this entire task on a PASS. Round 705's red-team reviewer returned
NEEDS_FIXES, which inserted a fix builder at 706 and a re-reviewer at 707. The verdict read
is **707's**, the last word in the chain:

```
$ psql ... -c "select round, role, status, title from project_tasks
               where project_id='4120f785-…' and round >= 700 order by round"
700|planner |done|Phase 7 (injected by Konrad): browser-first reality for Perplexity/Gemini
701|researcher|done|R701 · Gemini Pool recon — can it actually carry video QA?
701|builder |done|R701 · scripts/research-browser.mjs — persistent profile + noVNC takeover …
702|builder |done|R702 · gemini-qa → Gemini Pool as primary backend, API key optional secondary
702|builder |done|R702 · perplexity.mjs → authenticated browser profile as primary …
703|builder |done|R703 · wire the browser lane into the researcher role, the engine prompt …
704|builder |done|R704 · execute the phase-7 smoke and write the evidence transcript
705|reviewer|done|R705 · red-team review of the phase-7 browser lane
706|builder |done|Fix cycle 1
707|reviewer|done|Re-review after fix cycle 1
715|builder |running|R715 · deploy phase 7 …
```

Round 707's final message ends:

```
VERDICT: PASS
```

with its own gate pasted above it: `npx tsc --noEmit` exit 0, `pnpm test` 466/466 across 87
suites, `git -C /opt/forge-ai-os status --porcelain` empty, dep gate empty, forbidden paths
untouched. Deploy proceeded.

## 1. Rollback anchor

```
$ git -C /opt/forge-ai-os rev-parse main
5594188…  (docs(evidence): P6 fix cycle 3 — R605 findings, merge to main, forge-control restart)
```

Rollback, should it be needed:
`git -C /opt/forge-ai-os reset --hard 5594188 && pm2 restart forge-control`.
No migration ships in this phase, so there is nothing to un-apply.

## 2. Sync in the WORKTREE — main had not moved

The brief anticipates the parallel `operator-visibility` project committing to main this
cycle. It had not:

```
$ git fetch
            (silent)

$ git log --oneline -1 main
5594188 docs(evidence): P6 fix cycle 3 — …

$ git log --oneline -1 origin/main
5594188 docs(evidence): P6 fix cycle 3 — …

$ git rev-list --count HEAD..main
0

$ git rev-list --count main..HEAD
7
```

`HEAD..main` = 0 — main is an ancestor of this branch. **No merge-back, therefore no
conflicts to report.** The branch is 7 commits ahead.

The live checkout was clean and on main before anything was touched (the same check
`REVIEWER_LIVE_CHECK` makes every reviewer run — any output would have stopped the deploy):

```
$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main

$ git -C /opt/forge-ai-os status --porcelain
            (empty)
```

## 3. Full gate, re-run in the WORKTREE

Run in `$WORKTREE/forge-control`, never in LIVE. `NODE_ENV=development` and `--prod=false`
are both load-bearing — see `docs/plan/03-quality.md` lines 3-18: the executor exports
`NODE_ENV=production`, under which a plain `pnpm install` silently skips devDependencies and
`npx tsc` then resolves the Debian `/usr/bin/tsc` impostor while `tsx` is simply missing.

```
$ NODE_ENV=development pnpm install --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 1.1s using pnpm v9.15.9
```

Proof the real toolchain resolved, not the impostor:

```
$ ls node_modules/.bin/ | grep -xE "tsc|tsx"
tsc
tsx

$ npx tsc --version
Version 5.9.3
```

```
$ npx tsc --noEmit
            (silent)
TSC_EXIT=0

$ NODE_ENV=development pnpm test
...
ok 104 - R704 — /api/uploads/:id/:name survives clients that leave mid-download
1..104
# tests 466
# suites 87
# pass 466
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10862.979074
```

**466/466 pass, 0 fail, 0 skipped** — the same count round 707 reported, reproduced
independently here after the fetch.

Dependency gate — the branch must add no dependency:

```
$ git diff main...HEAD -- '**/package.json' 'pnpm-lock.yaml'
            (empty)
```

Forbidden paths — `forge-control-web/app/**`, `desktop/**` and `src/routes/agents.ts` belong
to the parallel `operator-visibility` project:

```
$ git diff --name-only main...HEAD | grep -E "forge-control-web/(app|desktop)/|src/routes/agents.ts"
            (no match, grep exit=1)
```

The full diff, 26 files:

```
$ git diff --stat main...HEAD | tail -3
 scripts/gemini-qa.mjs                              |  854 +++++++-
 scripts/perplexity.mjs                             | 1669 ++++++++++++--
 scripts/research-browser.mjs                       | 2284 ++++++++++++++++++++
 26 files changed, 11482 insertions(+), 611 deletions(-)
```

Green on every count. Proceeded to merge.

## 4. Merge to main in LIVE

```
$ git -C /opt/forge-ai-os merge --no-ff project/4120f785 -m 'merge(p7): browser-first research lane — …'
...
 create mode 100644 docs/plan/evidence/p7-browser-lane.md
 create mode 100644 docs/research/round-701-33d8cba3.md
 create mode 100644 docs/tools/research-browser.md
 create mode 100644 forge-control/src/lib/cc-runner.test.ts
 create mode 100644 forge-control/src/lib/fixtures/perplexity-answer-capture.json
 create mode 100644 forge-control/src/lib/fixtures/uploads-serving-server.ts
 create mode 100644 forge-control/src/lib/reminder-dedup.test.ts
 create mode 100644 forge-control/src/lib/research-browser-cli.test.ts
 create mode 100644 forge-control/src/lib/uploads-serving.test.ts
 create mode 100755 scripts/research-browser.mjs
 26 files changed, 11482 insertions(+), 611 deletions(-)
```

No conflicts. Post-merge:

```
$ git -C /opt/forge-ai-os log --oneline -2
1826050 merge(p7): browser-first research lane — research-browser, gemini-qa pool backend, …
b0d0f4b fix(r706): reminder dedup storm, orphaned X/VNC stack, unvalidated model, stale lock

$ git -C /opt/forge-ai-os status --porcelain
            (empty)
```

## 5. GitHub push (plain push, never `--force`)

```
$ gh auth status
github.com
  ✓ Logged in to github.com account konradschrein-star (/root/.config/gh/hosts.yml)

$ git -C /opt/forge-ai-os push origin main
To github.com:konradschrein-star/AI-Operating-System.git
   5594188..1826050  main -> main
```

Fast-forward on the remote, no force. Remote state:

```
$ git ls-remote origin main refs/heads/project/4120f785
1826050…  refs/heads/main
b0d0f4b…  refs/heads/project/4120f785
```

No PR opened: this brief says merge to main, and `DEPLOY_GUIDE`'s PR branch only applies when
the brief asks for one.

## 6. forge-control restart (API side — allowed)

This discharges the R704 deploy obligation: the live API was still running the pre-fix
`/api/uploads` handler that cast a Node stream to a `ReadableStream` and killed the process
with an uncaught `ERR_INVALID_STATE` when a client abandoned a download mid-body.

```
$ pm2 restart forge-control
            (pm2 table)

$ pm2 jlist | …
forge-control  online restarts=33 uptime=10s
forge-executor online restarts=4  uptime=11628s
```

forge-control's uptime reset (restart landed, `online`); **forge-executor untouched at 3h14m
and 4 restarts** — not restarted by this task at any point.

Live probe:

```
$ curl -s -o /dev/null -w 'health HTTP %{http_code}\n' http://127.0.0.1:7700/api/today
health HTTP 200
```

The error log's last write predates the restart by 75 minutes, so the new process has logged
nothing at all — no rollback triggered:

```
$ stat -c '%y' ~/.pm2/logs/forge-control-error.log
2026-08-05 21:18:18 +0200
$ date -u
Wed Aug  5 08:33:07 PM UTC 2026        (= 22:33 +0200)
```

Out-log confirms it is serving: `GET /api/today 200`, `GET /api/projects/board 200`,
`[vault-sync] scanned=278 upserted=278 deleted=0 errors=0`.

## 7. `researcher.md` refresh (R703 deploy obligation)

`AGENTS_DIR` (`/root/.claude/agents/`) wins over the repo fallback in `roleFilePaths()`, so
merging alone would have left the executor loading the **old** researcher mission after the
restart — the one that knows nothing about `scripts/research-browser.mjs`, the browser-lane
rules, or the exit-4-means-stop protocol. The installed copy was indeed stale:

```
$ ls -la /root/.claude/agents/researcher.md /opt/forge-ai-os/agents/researcher.md
-rw-r--r-- 1 root root 7548 Aug  5 22:32 /opt/forge-ai-os/agents/researcher.md
-rw-r--r-- 1 root root 3355 Aug  5 17:26 /root/.claude/agents/researcher.md
                       ^^^^ P6's copy — 4193 bytes short of the merged mission
```

Refreshed and verified byte-identical:

```
$ cp /opt/forge-ai-os/agents/researcher.md /root/.claude/agents/researcher.md
cp exit=0
$ diff /root/.claude/agents/researcher.md /opt/forge-ai-os/agents/researcher.md
IDENTICAL — no drift
```

## 8. Detached executor restart

`src/lib/project-tick.ts`, `src/lib/cc-runner.ts` and `src/executor.ts` all changed in this
phase and the executor holds them in memory. `pm2 restart forge-executor` would kill every
run in flight — including this one. Launched detached instead, and **not waited on**:

```
$ setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &

$ ps -o pid,ppid,sid,cmd -p 2514836
    PID    PPID     SID CMD
2514836       1 2514836 bash /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45
```

`PPID 1` and its own session id: genuinely detached, it survives this run's exit. The script
logs its own progress to `/var/log/forge-safe-restart.log`, and the launch took:

```
$ tail -2 /var/log/forge-safe-restart.log
[2026-08-05T19:19:14+02:00] restarted forge-executor — status=online
[2026-08-05T22:33:21+02:00] waiting for idle to restart 'forge-executor' (max 43200s, idle window 45s)
```

It waits for a 45s window with no run heartbeating, up to 12h, then restarts. Not polled, not
slept for. Confirmed launched; that is the whole obligation.

Executor state at the end of this task, unchanged from the start:

```
forge-executor online restarts=4 uptime=11750s
```

## 9. Reminders

Two pending reminders were **deploy obligations discharged by this task**, so they were
dismissed rather than left to fire at Konrad with stale instructions:

```
$ curl -sS -X POST http://127.0.0.1:7700/api/reminders/016e3833-…/dismiss   # R703 researcher.md refresh → §7
{"ok":true}
$ curl -sS -X POST http://127.0.0.1:7700/api/reminders/f50d042d-…/dismiss   # R704 /api/uploads restart  → §6
{"ok":true}
```

Everything else was left alone. Still pending and still owed by Konrad:

| Due | What |
|---|---|
| 2026-08-06 07:00 | **Perplexity one-time login, 1/2 and 2/2** — profile `perplexity`, display `:109`, noVNC `http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale`, tunnel `ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149`. Blocked upstream: perplexity.ai currently 403s this VPS IP at the Cloudflare edge, so the login page does not even load. |
| 2026-08-06 07:00 | `PERPLEXITY_API_KEY` — `/opt/ai-os/.secrets/store/perplexity-api-key` or the env var. Only path to `perplexity.mjs search`. |
| 2026-08-06 07:00 | `GEMINI_API_KEY` — `/opt/ai-os/.secrets/store/gemini-api-key` or the env var. Unlocks `gemini-qa --backend api`. |
| 2026-08-06 07:00 | Gemini Pool `/v1/analyze` returns 500 code 1100 for **any** file — the default `gemini-qa` backend is down at the pool, not at the key. |
| 2026-08-06 07:05 | Gemini Pool part 2 — `VEOPARKING_JWT` hardcoded at `/opt/gemini-pool-api/src/pool.py:10` expired 2026-06-26. |
| 2026-08-06 07:00 | **SECURITY, pre-existing** — `websockify` pid 2015117 serves the qemu noVNC console on `0.0.0.0:6082`; `http://65.108.6.149:6082/vnc.html` answers 200 from the public internet. Not from this project. Firewall it or rebind it. |

Both keys re-confirmed absent at deploy time, not merely at planning time:

```
$ ls /opt/ai-os/.secrets/store/ | grep -iE "gemini|perplex"
no gemini/perplexity secret-store files
$ grep -rliE "GEMINI_API_KEY|PERPLEXITY_API_KEY" /opt/ai-os/.secrets/
no GEMINI/PERPLEXITY key in .secrets/
```

---

## Summary

| Step | Outcome |
|---|---|
| 0 Verdict gate | round 707 re-reviewer: **VERDICT: PASS** |
| 1 Rollback anchor | `5594188` |
| 2 Sync | `HEAD..main` = 0 — main had not moved, **no merge, no conflicts** |
| 3 Worktree gate | tsc 5.9.3 silent, exit 0; **466/466 pass, 0 fail** (87 suites); dep gate empty; forbidden paths untouched |
| 4 Merge to main | `1826050`, no conflicts, live tree clean |
| 5 GitHub | `main` pushed `5594188..1826050`, fast-forward, no force; no PR (not asked for) |
| 6 forge-control | restarted, `online`, `/api/today` HTTP 200, no new errors — discharges R704 |
| 7 `researcher.md` | stale 3355-byte P6 copy in `AGENTS_DIR` refreshed to the merged 7548-byte file — discharges R703 |
| 8 Executor | detached `safe-restart.sh` running (PID 2514836, PPID 1), "waiting for idle" logged; **never `pm2 restart forge-executor`** |
| 9 Reminders | 2 discharged obligations dismissed; 6 genuinely-owed items left pending |

forge-executor was **never** restarted by this task — 3h14m uptime and 4 restarts before,
during and after. The only executor restart is the detached one, which lands on its own once
the fleet goes quiet.

**What Konrad owes the system:** the one-time Perplexity login over noVNC (profile
`perplexity`, `http://127.0.0.1:6919/vnc.html?autoconnect=1&resize=scale` behind
`ssh -N -L 6919:127.0.0.1:6919 root@65.108.6.149`) — though the Cloudflare 403 on this VPS's
egress has to clear first; `GEMINI_API_KEY` and `PERPLEXITY_API_KEY`, neither of which exists
anywhere under `/opt/ai-os/.secrets/`; a working Gemini Pool (`/v1/analyze` 500s on every
file, and the pool's own JWT expired in June); and a decision on the pre-existing public
noVNC console on port 6082.
