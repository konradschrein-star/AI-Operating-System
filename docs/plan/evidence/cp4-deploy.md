# Evidence — CP4 deploy (control-plane waterfall)

The deploy phase of the Manager Control Plane. Same protocol as
`docs/plan/evidence/p6-deploy.md` / `p7-deploy.md`: every block below is pasted output from the
command written above it — nothing is paraphrased, nothing is reconstructed from memory.

Paths: **WORKTREE** = `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
(branch `project/4120f785`), **LIVE** = `/opt/forge-ai-os`.

Round split: **1201** (this task) does merge + re-verify + merge-to-main + push. **1202** owns
`pm2 restart forge-control` and live verification (`scripts/checks/verify-control-plane.sh`).
**1203** owns the detached executor restart and the final docs merge. This task restarted nothing.

---

## 1. Merge + re-verify (D4)

Boundary `docs/plan/05-control-plane-boundary.md` D4 is normative here: merge `main` into
`project/4120f785` FIRST, re-run typecheck + tests AFTER that merge, only then merge to `main`.
A pre-merge green run does not count. The order below is D4's order.

### 1.0 Rollback anchor — PRE-MERGE `main`

Captured before anything was merged, per the brief's riskiest-step protocol.

```
$ git -C /opt/forge-ai-os rev-parse main
76a60855521ec0fab3b99834fa60399c728b07cc
```

Rollback **before** the push: `git -C /opt/forge-ai-os reset --hard 76a6085`.
Rollback **after** the push (which is where we now are — both pushes succeeded):
`git -C /opt/forge-ai-os revert -m 1 2e64f1e` and push that revert. No reset, no force-push.
No migration ships in this phase, so there is nothing to un-apply.

### 1.1 Step 1 — `git fetch origin`, then the read-only conflict probe

Refs after the fetch, so the probe's inputs are on the record:

```
$ git fetch origin; echo "fetch exit=$?"
fetch exit=0
HEAD=9a23d103accffac75ad99d21692b65d0b38b2c41
origin/main=76a60855521ec0fab3b99834fa60399c728b07cc
main=76a60855521ec0fab3b99834fa60399c728b07cc
origin/project/4120f785=9a23d103accffac75ad99d21692b65d0b38b2c41
```

The probe itself (read-only; prints the merged tree oid on success, the conflicted path list on
conflict):

```
$ git merge-tree --write-tree --name-only HEAD origin/main; echo exit=$?
c1489d9034248e55305c79f743721db59c10208b
exit=0
```

Exit 0 and a bare tree oid — **no conflicted paths**. The round-1200 planner snapshot held.

Why D2 and D6 did not fire, verified rather than assumed — `operator-visibility`
(`project/8ea0cc08`) has still not landed on `main`:

```
$ git cat-file -t main:forge-control/src/routes/capabilities.ts
fatal: path 'forge-control/src/routes/capabilities.ts' does not exist in 'main'
```

So the D2 `index.ts` two-hunk conflict and the D6 corpus recipe were both out of scope for this
merge. They remain live for whoever merges `project/8ea0cc08`.

### 1.2 Step 2 — `git merge origin/main` in the WORKTREE

```
$ git merge origin/main
Merge made by the 'ort' strategy.
merge exit=0

$ git rev-parse HEAD
de260b6a1c9cca53046e1b8ac87f2d58bed12a44

$ git status --porcelain
(empty)
```

`main` was one commit ahead (`76a6085`, a merge commit whose tree equalled the merge base's), so
the merge produced a merge commit with no file changes — consistent with the step-1 probe.

### 1.3 Step 3 — post-merge QA gate, from `WORKTREE/forge-control`

D4: this is the run that counts. All three commands ran with cwd
`/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365/forge-control` (confirmed by
`pwd` + the presence of `package.json` and `tsconfig.json` there).

```
$ pnpm install --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 850ms using pnpm v9.15.9
install exit=0
```

```
$ npx tsc --noEmit; echo "tsc exit=$?"
tsc exit=0
```

`npx tsc --noEmit` printed **nothing at all** — the only line in the block above is the exit-code
echo this transcript added. Silent, exit 0, as 08 §4.1 requires.

```
$ pnpm test

> forge-control@0.1.0 test /opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365/forge-control
> tsx --test src/lib/*.test.ts

  … 164 top-level suites …
1..164
# tests 753
# suites 147
# pass 753
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6613.663168
test exit=0
```

**753 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**, across 147 suites, 6.6 s. Green.

### 1.4 Step 4 — the four 08 §4.3 boundary checks

**B1 — changed files under `forge-control/src`.** Must contain `routes/run-control.ts` and none of
the nine forbidden paths.

```
$ git diff --name-only main...project/4120f785 -- forge-control/src
forge-control/src/db/notifications.ts
forge-control/src/db/projects.ts
forge-control/src/db/runs.ts
forge-control/src/executor.ts
forge-control/src/index.ts
forge-control/src/lib/cc-runner.ts
forge-control/src/lib/cp2-reconciler-interaction.test.ts
forge-control/src/lib/cp3-linkage.test.ts
forge-control/src/lib/executor-completion-guard.test.ts
forge-control/src/lib/perplexity-cli.test.ts
forge-control/src/lib/project-reconcile.test.ts
forge-control/src/lib/project-reconcile.ts
forge-control/src/lib/project-tick.test.ts
forge-control/src/lib/project-tick.ts
forge-control/src/lib/run-control-rules.test.ts
forge-control/src/lib/run-control-rules.ts
forge-control/src/lib/run-control-surface.test.ts
forge-control/src/lib/usage-wall.test.ts
forge-control/src/lib/usage-wall.ts
forge-control/src/routes/run-control.ts
```

20 files. `forge-control/src/routes/run-control.ts` is present (last line). The forbidden-nine
scan:

```
$ git diff --name-only main...project/4120f785 -- forge-control/src \
    | grep -E 'routes/(capabilities|chat|chat-linkage|agents|agents-shared|working-time|secrets)\.ts$|lib/secret-store\.ts$|routes/projects\.ts$'
(no output)
grep exit=1   ← 1 = no match = no forbidden file touched
```

**B2 — `forge-control/src/index.ts`.** Must be exactly two `+` lines, zero `-` lines, neither in a
hunk whose context includes `app.route("/api/projects"`.

```
$ git diff main...project/4120f785 -- forge-control/src/index.ts
diff --git a/forge-control/src/index.ts b/forge-control/src/index.ts
index a7f3c22..b6bd680 100644
--- a/forge-control/src/index.ts
+++ b/forge-control/src/index.ts
@@ -41,6 +41,7 @@ import { startCronTick } from "./lib/cron-tick.ts";
 import { startTelegramBridge } from "./lib/telegram-bridge.ts";
 import { startVaultSyncTick } from "./lib/vault-sync-tick.ts";
 import mentor from "./routes/mentor.ts";
+import runControl from "./routes/run-control.ts";

 const app = new Hono();

@@ -190,6 +191,7 @@ app.route("/api/tasks", tasks);
 // Inbound webhook receiver: external services hit /webhooks/in/:slug directly.
 // NOT under /api so the CORS preflight middleware above doesn't affect it.
 app.route("/webhooks", webhookIn);
+app.route("/api/runs", runControl);

 const port = Number(process.env.PORT ?? 7700);
 serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

plus=2
minus=0

$ git diff main...project/4120f785 -- forge-control/src/index.ts | grep -n 'app.route("/api/projects"'
(no /api/projects context in the diff — correct)
```

Both `+` lines sit at the far end of their blocks, exactly as D2 prescribes: the import after
`mentor`, the mount after `/webhooks`. Neither hunk's context reaches the `/api/projects` mount.

**B3 — nothing named `capabilities` anywhere in the branch diff.**

```
$ git diff --name-only main...project/4120f785 | grep capabilities
(prints nothing — correct)
```

D3 holds: the capability flip is the other lane's to perform, and this branch never touches their
file.

**B4 — `origin_chat_id` confined to `lib/cc-runner.ts` and `db/projects.ts`** (08 §4.3's CP3
extension of D5).

```
$ git diff main...project/4120f785 -- forge-control/src | grep -i origin_chat_id
+const ORIGIN_CHAT_KEY = "origin_chat_id";
+ *  `origin_chat_id` to appear only in `lib/cc-runner.ts` and this file, so the
+  // the WHOLE check by design — boundary D5 forbids origin_chat_id validation
+- forge-control API: http://127.0.0.1:7700/api/* (… pass your own run id — the `$FORGE_RUN_UUID`
  environment variable, exported into every run — as "origin_chat_id" in the POST body, so the
  project's workers can report findings back into that chat.

per-file attribution:
forge-control/src/db/projects.ts: 3
forge-control/src/lib/cc-runner.ts: 1
```

Exactly the two permitted files, no third. (The fourth match is the operator system prompt string
that lives inside `lib/cc-runner.ts`.)

### 1.5 Step 5 — LIVE checkout cleanliness

08 §4.4. Checked immediately before the merge to `main`:

```
$ git -C /opt/forge-ai-os status --porcelain
(empty — zero lines)

$ git -C /opt/forge-ai-os status --porcelain | wc -l
0

$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main
```

Clean. Nothing edited the live checkout during the build phases — the worktree-only policy held
across the whole control-plane waterfall.

### 1.6 Step 6 — merge to `main` in the LIVE checkout

```
$ git -C /opt/forge-ai-os merge --no-ff project/4120f785 \
    -m "merge(cp4): manager control plane — run-control routes, executor handshake, prompts, corpus paths"
Merge made by the 'ort' strategy.
 agents/builder.md                                  |    1 +
 agents/researcher.md                               |    9 +-
 agents/scout.md                                    |    1 +
 docs/plan/02-architecture.md                       |   96 +-
 docs/plan/03-quality.md                            |   77 +-
 docs/plan/04-phases.md                             |    3 +-
 docs/plan/05-control-plane-boundary.md             |  426 +++++++
 docs/plan/06-control-plane-requirements.md         |  209 +++
 docs/plan/07-control-plane-architecture.md         |  302 +++++
 docs/plan/08-control-plane-quality.md              |  107 ++
 docs/plan/09-control-plane-phases.md               |  140 +++
 .../10-policy-agent-autonomy-and-escalation.md     |   27 +
 docs/plan/evidence/cp2-c9-reconciler.md            |  599 +++++++++
 docs/plan/evidence/p8-consolidation-live.md        | 1324 ++++++++++++++++++++
 docs/plan/evidence/p8-research-lane-value.md       |  452 +++++++
 docs/plan/evidence/r850-tester-verdicts.md         |  136 ++
 docs/plan/evidence/r860-dryrun.mts                 |  166 +++
 docs/plan/evidence/r860-usage-wall.md              |  174 +++
 docs/tools/gemini-qa.md                            |   45 +-
 docs/tools/perplexity.md                           |  140 ++-
 docs/tools/run-control.md                          |  903 +++++++++++++
 forge-control/src/db/notifications.ts              |   31 +
 forge-control/src/db/projects.ts                   |  313 ++++-
 forge-control/src/db/runs.ts                       |  328 ++++-
 forge-control/src/executor.ts                      |  267 +++-
 forge-control/src/index.ts                         |    2 +
 forge-control/src/lib/cc-runner.ts                 |    2 +-
 .../src/lib/cp2-reconciler-interaction.test.ts     |  631 ++++++++++
 forge-control/src/lib/cp3-linkage.test.ts          |  346 +++++
 .../src/lib/executor-completion-guard.test.ts      |  390 ++++++
 forge-control/src/lib/perplexity-cli.test.ts       |  103 +-
 forge-control/src/lib/project-reconcile.test.ts    |  497 +++++++-
 forge-control/src/lib/project-reconcile.ts         |  271 +++-
 forge-control/src/lib/project-tick.test.ts         |  463 ++++++-
 forge-control/src/lib/project-tick.ts              |  713 +++++++++--
 forge-control/src/lib/run-control-rules.test.ts    |  845 +++++++++++++
 forge-control/src/lib/run-control-rules.ts         |  612 +++++++++
 forge-control/src/lib/run-control-surface.test.ts  |  675 ++++++++++
 forge-control/src/lib/usage-wall.test.ts           |  436 +++++++
 forge-control/src/lib/usage-wall.ts                |  517 ++++++++
 forge-control/src/routes/run-control.ts            |  754 +++++++++++
 scripts/checks/verify-control-plane.sh             |  690 ++++++++++
 scripts/perplexity.mjs                             |   95 +-
 43 files changed, 13938 insertions(+), 380 deletions(-)
 create mode 100644 docs/plan/05-control-plane-boundary.md
 create mode 100644 docs/plan/06-control-plane-requirements.md
 create mode 100644 docs/plan/07-control-plane-architecture.md
 create mode 100644 docs/plan/08-control-plane-quality.md
 create mode 100644 docs/plan/09-control-plane-phases.md
 create mode 100644 docs/plan/10-policy-agent-autonomy-and-escalation.md
 create mode 100644 docs/plan/evidence/cp2-c9-reconciler.md
 create mode 100644 docs/plan/evidence/p8-consolidation-live.md
 create mode 100644 docs/plan/evidence/p8-research-lane-value.md
 create mode 100644 docs/plan/evidence/r850-tester-verdicts.md
 create mode 100644 docs/plan/evidence/r860-dryrun.mts
 create mode 100644 docs/plan/evidence/r860-usage-wall.md
 create mode 100644 docs/tools/run-control.md
 create mode 100644 forge-control/src/lib/cp2-reconciler-interaction.test.ts
 create mode 100644 forge-control/src/lib/cp3-linkage.test.ts
 create mode 100644 forge-control/src/lib/executor-completion-guard.test.ts
 create mode 100644 forge-control/src/lib/run-control-rules.test.ts
 create mode 100644 forge-control/src/lib/run-control-rules.ts
 create mode 100644 forge-control/src/lib/run-control-surface.test.ts
 create mode 100644 forge-control/src/lib/usage-wall.test.ts
 create mode 100644 forge-control/src/lib/usage-wall.ts
 create mode 100644 forge-control/src/routes/run-control.ts
 create mode 100755 scripts/checks/verify-control-plane.sh
merge exit=0

$ git -C /opt/forge-ai-os rev-parse main
2e64f1ed65e513be3b8e85869ae8640fb72e762e

$ git -C /opt/forge-ai-os rev-parse --abbrev-ref HEAD
main

$ git -C /opt/forge-ai-os status --porcelain
(empty)
```

No conflicts. The live checkout is left **on `main`**, clean, as the brief requires.

Note the file count differs from the CP4 planner's `forge-control/src` view (20) because this is
the whole-branch merge: 43 paths, including the `docs/plan` corpus, `docs/tools/run-control.ts`
documentation, `scripts/checks/verify-control-plane.sh` and three `agents/*.md` role files.

### 1.7 Step 7 — pushes (plain, never forced)

Work branch:

```
$ scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365
git-sync-branch.sh: pushing project/4120f785 to git@github.com:konradschrein-star/AI-Operating-System.git
To github.com:konradschrein-star/AI-Operating-System.git
   9a23d10..de260b6  HEAD -> project/4120f785
pushed-branch: project/4120f785
origin-url: git@github.com:konradschrein-star/AI-Operating-System.git
exit=0
```

`main`:

```
$ scripts/git-sync-branch.sh /opt/forge-ai-os
git-sync-branch.sh: pushing main to git@github.com:konradschrein-star/AI-Operating-System.git
To github.com:konradschrein-star/AI-Operating-System.git
   76a6085..2e64f1e  HEAD -> main
pushed-branch: main
origin-url: git@github.com:konradschrein-star/AI-Operating-System.git
exit=0
```

Both fast-forward (`..`, not `+...`). No force, no lease, no retry.

---

## What this task deliberately did NOT do

- **No restart of anything.** `pm2 restart forge-control` belongs to round 1202;
  the detached `safe-restart.sh forge-executor` belongs to round 1203. The executor is still
  running the pre-merge code, holding every run in flight — including this one.
- **No `scripts/checks/verify-control-plane.sh`.** Round 1202 owns live verification. The control
  plane is on `main` but not yet served: the router is mounted in `index.ts`, and the running
  `forge-control` process has not reloaded it.
- **No announcement rows, no `flipped?` cell.** 08 §6 assigns those to the post-restart rounds,
  after the verbs are proven live. Nothing may be announced on faith.
- **This evidence commit is not merged to `main`.** Round 1203 does the final docs merge, per the
  brief.
