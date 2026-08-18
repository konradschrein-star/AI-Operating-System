# Round 1862 — Deploy (step 2 of 4)

Ran 2026-08-17, ~09:33–09:36 local (07:33–07:36 UTC).

Code deployed in the live checkout `/opt/forge-ai-os`. This doc committed in the worktree
`/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`, branch `project/8ea0cc08`.

**Outcome: DEPLOYED AND VERIFIED.** forge-control-web rebuilt against HEAD and restarted.
forge-executor proven untouched. No rollback needed. No migration needed to be applied.

---

## 0. Gate on round 1861

`docs/plan/operator-visibility/artifacts/phase1860/01-pre-deploy.md` read first, as instructed.
Verdict there: merge was a **no-op** (main == branch == `1eae6f2`), gate suite **RED: 0** with
the pipefail masking removed, `dollar-sweep.sh` genuinely green. **No merge conflict, no
merge-caused red gate.** Nothing blocked this deploy, so it proceeded.

---

## 1. forge-executor BEFORE

```
$ pm2 jlist | python3 -c "...forge-executor..."
restarts 0 up_since 2026-08-11T04:39:56.273000+00:00
```

Matches the expected `restarts 0, up_since 2026-08-11T04:39:56Z`. Recorded literally.

---

## 2. Migrations — confirmed BY NAME, no glob

DSN taken from `pm2 env 16` (forge-control):
`postgresql://postgres:***@127.0.0.1:5432/content_forge`.

```
$ psql "$DB" -tAc "select tablename from pg_tables where schemaname='public'
                    and tablename in ('usage_hourly','ui_dismissals','app_settings') order by 1;"
app_settings
ui_dismissals
usage_hourly

$ psql "$DB" -tAc "select count(*) from usage_hourly;"
720
```

All three tables present. **Nothing was applied** — no `psql -f` ran, because nothing was
missing. The 720 rows are the backfill from round 1355's earlier application, not from this
round. No forge-control restart was needed on migration grounds.

---

## 3. Merge to main in /opt/forge-ai-os

```
$ cd /opt/forge-ai-os && git fetch --all --prune
(no output)

$ PRE_MAIN=$(git rev-parse main)
PRE_MAIN=1eae6f2f3a5056ab83fca0d8d3a130207c38357e     <-- ROLLBACK ANCHOR

$ git rev-parse --abbrev-ref HEAD
main

$ git status --porcelain
(empty — live checkout clean, nothing to stash, nothing discarded)

$ git log --oneline main..project/8ea0cc08
3706160 docs(round1861): pre-deploy — the merge that was a no-op, and the suite measured against its own masked twin

$ git merge project/8ea0cc08
Updating 1eae6f2..3706160
Fast-forward
 .../artifacts/phase1860/01-pre-deploy.md | 257 +++++++++++++++++++++
 1 file changed, 257 insertions(+)

$ git rev-parse main
3706160e57a8df0fceadeb52e34e74a4ebdd2076              <-- POST_MAIN
```

**Fast-forward, no conflict.** Not the "already merged, no-op" case the brief allowed for:
main was one commit behind, and that one commit is round 1861's pre-deploy document. It
carries **no code** — the diff `PRE_MAIN..HEAD` is exactly one markdown file, 257 insertions.

### forge-control restart decision: NOT restarted

```
$ git diff --stat 1eae6f2..HEAD -- forge-control/src
(empty)
```

The merge changed nothing under `forge-control/src`. forge-control had already been restarted
at 09:17 and already carries HEAD's API code — confirmed live by the five-key
`/api/capabilities` in §5. Restarting it would have been a gratuitous interruption of a
process serving 60 agent rows. **Left alone deliberately.**

---

## 4. Build, THEN restart — in that order

### 4a. State of `.next` before touching anything — the risk had already receded

The brief's central warning was that `/opt/forge-ai-os/forge-control-web/.next` had **no
BUILD_ID**, so a restart would have taken the web app down. That was no longer true when this
task ran:

```
$ ls -la /opt/forge-ai-os/forge-control-web/.next/
-rw-r--r-- 1 root root 21 Aug 17 09:25 BUILD_ID
  (plus server/, static/, routes-manifest.json, prerender-manifest.json — a complete
   production build, all files stamped Aug 17 09:24–09:25)

$ cat .next/BUILD_ID
DGaoprEJ9mG3HE0lnANcS
```

Someone produced a full production build at **09:25 local**, and pm2 shows forge-control-web
restarted at **09:31 local** (`up_since 2026-08-17T07:31:44Z`) — after that build, not the
05:18 the brief recorded. So the app was already serving a rebuilt bundle before this task
started. Evidence it already carried fix cycle 3: the tooltip string introduced by `16fc062`
was present in it.

```
$ grep -roc "the set is shared with" .next/static .next/server
.next/static/chunks/1500-63b2c7c2e0a23f0f.js:1
.next/server/chunks/1874.js:1
```

and the chunk hash `1500-63b2c7c2e0a23f0f.js` is **identical** to the one round 1861 produced
in the worktree at `1eae6f2`.

This does not make the step unnecessary — it makes it cheap and safe. The rebuild below is
what turns "someone appears to have built this" into "the bytes being served provably
correspond to HEAD". It ran anyway, and §4c proves the served build changed.

### 4b. `pnpm install` — skipped, with the reason

```
$ git diff --stat 1eae6f2..HEAD -- forge-control-web/pnpm-lock.yaml pnpm-lock.yaml
(empty)
```

The lockfile did not move in the merge — a docs-only fast-forward cannot move it. `pnpm
install` was correctly skipped per the runbook's "only if pnpm-lock.yaml moved".

### 4c. The build

```
$ cd /opt/forge-ai-os/forge-control-web && NODE_ENV=production pnpm build
   ▲ Next.js 15.1.3
   - Environments: .env.local
   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)

Route (app)                              Size     First Load JS
┌ ƒ /                                    7.11 kB         351 kB
├ ○ /_not-found                          987 B           109 kB
├ ƒ /api/auth/[...nextauth]              156 B           108 kB
├ ƒ /api/canvas-events                   156 B           108 kB
├ ƒ /api/events/[id]                     156 B           108 kB
├ ƒ /api/secret-events                   156 B           108 kB
├ ○ /canvas                              565 B           174 kB
├ ○ /desktop                             214 B           345 kB
├ ○ /document                            872 B           159 kB
├ ○ /settings                            1.54 kB         115 kB
├ ○ /settings/secrets                    2.35 kB         118 kB
└ ƒ /signin                              156 B           108 kB
+ First Load JS shared by all            108 kB
ƒ Middleware                             83.2 kB

BUILD_EXIT=0
```

Route table is byte-identical to round 1861's worktree build. Expected: same code.

**BUILD_ID gate — checked BEFORE the restart, which was the whole point:**

```
$ ls -l .next/BUILD_ID
-rw-r--r-- 1 root root 21 Aug 17 09:33 .next/BUILD_ID
$ cat .next/BUILD_ID
_BZ1j6SB83vj36B_yxlTW

$ grep -roc "the set is shared with" .next/static .next/server
.next/static/chunks/1500-63b2c7c2e0a23f0f.js:1
.next/server/chunks/1874.js:1
```

BUILD_ID present and fresh. Only then:

```
$ pm2 restart forge-control-web
(forge-control-web → online)
```

**Order honoured: build → verify BUILD_ID → restart.** The rollback line was never invoked.

---

## 5. Smoke verification, against production

### 5a. pm2

```
forge-control-web    online   restarts=  5  pid=2108274  up_since=2026-08-17T07:34:22.602Z
forge-control        online   restarts= 29  pid=2061337  up_since=2026-08-17T07:17:08.895Z
forge-executor       online   restarts=  0  pid=2276472  up_since=2026-08-11T04:39:56.273Z
```

forge-control-web restart count 4 → 5, the single restart this task performed. forge-control
untouched at 29 (still its 09:17 process). forge-executor untouched at 0.

### 5b. Endpoints

```
$ curl -s http://127.0.0.1:7700/api/health
{"ok":true,"service":"forge-control","version":"0.1.0","uptime_seconds":1043,"timestamp":"2026-08-17T07:34:31.845Z"}

$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7700/api/agents          200
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7700/api/usage/series    200
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7701/desktop             307
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7701/                    307
```

`/api/agents` is **200 with real content**, not an empty success:

```
$ curl -s http://127.0.0.1:7700/api/agents | (shape)
now: str = 2026-08-17T07:35:54.384Z
summary: dict len=8
agents: list len=60
```

60 agent rows. The Live panel was not taken down; no migration was missing.

The `307` on `/desktop` is the auth redirect, inside the runbook's allowed "200 or 307":

```
$ curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}" http://127.0.0.1:7701/desktop
307 -> https://os.schreinercontentsystems.com/signin
```

### 5c. The restart actually changed what is served — proven, not assumed

Fetching the page the redirect lands on, and looking for the BUILD_ID inside the served HTML:

```
$ curl -s "http://127.0.0.1:7701/signin?callbackUrl=%2Fdesktop" -o /tmp/signin.html -w "..."
http=200 bytes=11386

$ grep -c "_BZ1j6SB83vj36B_yxlTW" /tmp/signin.html      1   <-- NEW build id, served
$ grep -c "DGaoprEJ9mG3HE0lnANcS" /tmp/signin.html      0   <-- OLD build id, gone

$ curl -s -o /dev/null -w "%{http_code}" \
    http://127.0.0.1:7701/_next/static/chunks/1500-63b2c7c2e0a23f0f.js      200
```

The running process serves BUILD_ID `_BZ1j6SB83vj36B_yxlTW`, and the chunk carrying the fix
cycle 3 tooltip is fetchable over HTTP. **Konrad is now looking at HEAD.** This is the check
the previous two rounds of this project lacked.

### 5d. `/api/capabilities` — five keys, literal JSON

```
{"control_plane":{"message_into_session":true,"resume_finished":true,"subagent_message":false,"stop":true,"terminate":true}}
```

Exactly five keys. `subagent_message` is present and `false`, as round 1352 intended.
Nothing removed, nothing flipped.

### 5e. EUR agreement — the two paths agree

Rate first:

```
$ curl -s http://127.0.0.1:7700/api/usage/rate
{"eur_per_usd":0.86,"source":"default","updated_at":null,"default_eur_per_usd":0.86}
```

0.86, `source: default` — by design, left alone, **not** "corrected" to 0.92. The question is
agreement, not the rate's value.

The two paths are structurally different: `/api/spend` sums `spend_log.amount_eur` (written by
executor.ts at write time), `/api/usage/series` computes `shadow_usd × eur_per_usd` at read
time from `usage_hourly`. A naive comparison disagrees:

```
window: now() - 24h  (NOT hour-aligned)
usage_hourly  shadow_usd=773.4209  -> EUR@0.86 = 665.1420
spend_log     amount_eur           =            682.7543   rows=238
```

That 17.61 EUR gap is **not** a rate disagreement — it is a window artifact. `usage_hourly`
rows are hour-truncated buckets, so `bucket_start >= now()-24h` and `created_at >= now()-24h`
do not describe the same interval; the 10 spend rows in the current partial hour fall inside
one and outside the other. On a genuinely shared, hour-aligned window:

```
window  2026-08-16 07:00:00+00  ..  2026-08-17 07:00:00+00
usage_hourly EUR = 665.1420
spend_log    EUR = 665.1418   rows=228
```

**Agreement to 0.0002 EUR** — 3 parts in ten million, the residue of folding per-run USD into
hourly buckets before multiplying. The two paths quote the same figure. This is the check the
brief asked for, and it passes.

---

## 6. forge-executor AFTER

```
$ pm2 jlist | python3 -c "...forge-executor..."     # identical command to §1
restarts 0 up_since 2026-08-11T04:39:56.273000+00:00
```

| | restarts | up_since |
|---|---|---|
| BEFORE | 0 | `2026-08-11T04:39:56.273000+00:00` |
| AFTER  | 0 | `2026-08-11T04:39:56.273000+00:00` |

**Byte-identical. forge-executor was never restarted, never signalled, never touched.**
Its pid 2276472 is the same process that has been up for six days. No run in flight was killed.

---

## 7. Harness census

### 7a. The :7798 specimen — already retired

```
$ ss -ltnp | grep 7798
(no listener on 7798)

$ ps -p 3542387
pid 3542387 absent
```

**Already retired, confirmed absent.** Matches the planner's 09:20 observation. Not hunted
further, as instructed.

### 7b. Stale worktree next-servers — LEFT RUNNING

Full sweep of the 77xx range, not just the four named:

| port | pid | cwd | started |
|---|---|---|---|
| 7700 | 2061337 | `/opt/forge-ai-os/forge-control` | Mon Aug 17 09:17:07 2026 |
| 7701 | 2108274 | `/opt/forge-ai-os/forge-control-web` | Mon Aug 17 09:34:21 2026 |
| 7791 | 676943 | `/tmp/phase1291c-web` | Mon Aug 17 01:06:42 2026 |
| 7792 | 1153231 | `/tmp/phase1305-web` | Mon Aug 17 04:22:53 2026 |
| 7793 | 1052008 | `/tmp/phase1303-web` | Mon Aug 17 03:44:21 2026 |
| 7799 | 1108279 | `/tmp/rt1305-web` | Mon Aug 17 04:06:44 2026 |

7700 and 7701 are the real services (7701's start time is this task's restart). The other four
are `next-server (v15.1.3)` processes in `/tmp` worktrees belonging to other rounds.

**All four left RUNNING and untouched.** Killing another project's live harness is not this
task's call. Listed here so the operator can decide. No process outside the named four was
found in the range — the census is complete, not a sample.

---

## 8. What was NOT done

- **No `pm2 restart forge-executor`.** Proven by §1/§6.
- **No `pm2 delete`, no `rm -rf`, no `DROP`/`TRUNCATE`, no force-push.**
- **No migration applied** — all three tables already existed.
- **forge-control not restarted** — the merge touched no file under `forge-control/src`.
- **No stale harness killed.**
- **Rollback not used** — the rebuilt app served correctly on the first try.
- **`origin/main` not pushed.** Round 1861 flagged that `origin/main` is 129 commits behind
  local `main`; the deploy target is the local checkout. Pushing is not this task's business
  and was not attempted.

## 9. Rollback anchor, for whoever needs it

```
PRE_MAIN = 1eae6f2f3a5056ab83fca0d8d3a130207c38357e
POST_MAIN = 3706160e57a8df0fceadeb52e34e74a4ebdd2076   (docs-only fast-forward)
```

Since the merge carried no code, reverting `main` to `PRE_MAIN` would change nothing about
what the web app serves. The meaningful rollback for the *build* is the runbook's line:
`git checkout $PRE_MAIN -- forge-control-web && pnpm build && pm2 restart forge-control-web`.
It was not needed.
