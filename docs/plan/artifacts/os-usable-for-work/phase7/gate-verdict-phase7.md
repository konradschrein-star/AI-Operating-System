# Phase 7 GATE — os-usable-for-work — round 18

## VERDICT: PASS

**Tip reviewed:** `c10cbe29c8f15ad5cc4af07887f169f0bd757196` (branch `project/7851068b`), re-read
immediately before this verdict was written and unmoved.
**Live checkout:** `/opt/forge-ai-os` at `a32cd54f34cd8c83eef1f22e2097932224a7be5d`.
**Task** `6d92b80e` · **run** `3fced573-948c-…` · **2026-08-19/20 UTC**.
**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` (the per-project layout).
`docs/plan/03-quality.md` also exists — it is the repo-wide document for a different corpus; both
were read, and the per-project one governs here.

---

## 0. Live-checkout cleanliness — PASS (mandatory)

```
$ git -C /opt/forge-ai-os status --porcelain
$ git -C /opt/forge-ai-os rev-parse HEAD
a32cd54f34cd8c83eef1f22e2097932224a7be5d
```

No output. Empty is the only pass, and it is empty. Re-read a second time at the end of this
review, after every browser and gate run: still empty. The worktree
`/opt/ai-os/workspace/projects/7851068b-…` is likewise clean (`git status --porcelain` → no output).

---

## 1. R83 — integration, never auto-merge — PASS

The three ids in the brief are **task** ids, not commits: `e5d2076c` (round 5, three lanes),
`999c250d` (round 13, main + vault + surfaces), `fe3749e0` (round 15, the deploy that correctly
refused and produced no merge; the deploy that ran is `d4561713`, round 17). Every merge commit
those tasks produced, tested by whole-tree equality — recompute what git would have produced unaided
and compare to the tree the merge actually recorded:

```
7b2dd77  tree=IDENTICAL  combined-diff-lines=0   connections lane        (e5d2076c)
6dde6bd  tree=IDENTICAL  combined-diff-lines=0   business lane           (e5d2076c)
3330996  tree=IDENTICAL  combined-diff-lines=0   perf lane               (e5d2076c)
19d35e0  tree=IDENTICAL  combined-diff-lines=0   main -> project branch  (999c250d)
d6dc6b1  tree=IDENTICAL  combined-diff-lines=0   vault lane              (999c250d)
6bcef8d  tree=IDENTICAL  combined-diff-lines=0   surfaces lane           (999c250d)
457f101  tree=IDENTICAL  combined-diff-lines=0   THE DEPLOY MERGE        (d4561713)
a32cd54  tree=IDENTICAL  combined-diff-lines=0   docs-only merge         (d4561713)
```

`git merge-tree --write-tree $m^1 $m^2` equals `git rev-parse $m^{tree}` for all eight, and
`git show --format= --cc $m | wc -l` is **0** for all eight. Whole-tree equality, so unlike a spot
check it cannot miss a file: no conflict was resolved by choosing a side, and no file was touched in
passing. `git show --cc --stat` is NOT this test — with `--stat` git diffs against the first parent
and a clean merge lists every file the second parent brought in.

One merge on this branch is **not** tree-identical and is not an R83 subject: `823db93`
(combined diff 256 lines, `merge-tree` exits 1), produced by `f4a7e71e` — the round-9 *briefed
reconciliation* task whose entire purpose was to resolve two files main and the surfaces lane both
changed. Named here so a later reader does not mistake its silence for an omission.

---

## 2. R84 — dependencies before any gate — PASS, with the literal-token caveat stated

The deploy transcript's two installs are `pnpm install --frozen-lockfile --prod=false` in
`forge-control` and in `forge-control-web`, both printing `Already up to date`. **Neither prints
`+ typescript`, and neither prints `- typescript`** — a `pnpm` install with nothing to do emits no
`+`/`−` lines at all, so the absence of `+ typescript` is evidence of nothing in either direction.
The deploy measured the property that token is a proxy for, directly and in the transcript:

```
$ ls -d node_modules/typescript node_modules/tsx     # forge-control
node_modules/tsx
node_modules/typescript
$ ./node_modules/.bin/tsc --version && ./node_modules/.bin/tsx --version
Version 5.9.3
tsx v4.22.4
```

That adjudication is correct, and this gate confirms it independently by producing the literal
evidence R84 asks for. A **cold clone of `main` at the deployed sha** (`/tmp/main-gate-r18`, no
`node_modules`), installed with the mandated flags under this runtime's `NODE_ENV=production`:

```
$ cd /tmp/main-gate-r18/forge-control && pnpm install --frozen-lockfile --prod=false
devDependencies:
+ @types/better-sqlite3 7.6.13
+ @types/node 22.19.21
+ @types/pg 8.20.0
+ tsx 4.22.4
+ typescript 5.9.3
Done in 934ms using pnpm v9.15.9

$ cd /tmp/main-gate-r18/forge-control-web && pnpm install --frozen-lockfile --prod=false
devDependencies:
+ @types/node 22.10.2
+ @types/react 19.0.2
+ @types/react-dom 19.0.2
+ typescript 5.7.2
Done in 1.4s using pnpm v9.15.9
```

`+ typescript` and `+ tsx`, never `- typescript`; `--prod=false` on every install; `pnpm`
throughout, `npm` never invoked, no bare `--frozen-lockfile`.

---

## 3. R85 — both typechecks clean — PASS

Four runs recorded, two trees:

| Where | forge-control | forge-control-web |
|---|---|---|
| deploy transcript (round 17, live checkout) | `npx tsc --noEmit` exit 0 | `npx tsc --noEmit` exit 0 |
| this gate, worktree `c10cbe2` (gates-808 gates 1–2) | EXIT=0 | EXIT=0 |
| this gate, cold clone of `main` `a32cd54` (gates 1–2) | EXIT=0 | EXIT=0 |

Neither package was assumed from the other.

---

## 4. R86 / S13 — the gate suite and the baseline diff — PASS

`bash scripts/checks/gates-808.sh --strict`, run **serially on a clean tree**, from the worktree at
`c10cbe2`, with a **600000 ms** Bash timeout. Nothing else was running against this tree while it ran;
no experiment of this gate's landed in its `pnpm test`.

```
 SUMMARY — 25 gates
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
 13 0      check-stop-affordance.tsx
 14 0      check-dismiss-peek.tsx
 15 0      check-team-rows.ts
 16 0      check-team-confirm.ts
 17 0      verify-notification-gap-pins.mjs — fenced quotes + prose pins
 18 0      check-usage-fold.ts — hourly token fold, against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs
 22 0      nav-walk-sampling.cjs
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness

 RED: 0
EXIT=0
```

**25 gates: 23 EXECUTED, 2 SKIPPED-by-design (23/24, browser harness, not requested via `--browser`),
0 RED.** Byte-identical, line for line, to
`docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`'s summary block. **No NEW red.**
S13 satisfied. No allowlist was widened by this review; nothing was made to pass.

### 4.1 The `forbidden-file diff` gate — the red is REAL and is adjudicated here, not silently green

**This is the one number in the table that must not be read at face value.** Gate 6 is
`git diff --name-only main...HEAD | grep -E '…|db/projects|…'` (`gates-808.sh:143-145`). The deploy
merged this branch into `main`, so `main` now *contains* `HEAD`:

```
$ git merge-base main HEAD
c10cbe29c8f15ad5cc4af07887f169f0bd757196     # == HEAD
$ git diff main...HEAD --name-only | wc -l
0
```

The three-dot range is empty and the gate passes **vacuously**. Re-run against the base the branch
was actually merged over — `main` as it stood pre-deploy, `9c3f63a` — it still fires:

```
$ git diff --name-only 9c3f63a...HEAD | grep -E 'project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
forge-control/src/db/projects.ts
```

**Adjudicated, in writing, at this tip.** One file, one commit — `27faa28`, the phase-6 lag fix
(`+38/−4`): it introduces `ProjectBoardTask = Omit<ProjectTaskWithProject,"brief">` and
`BOARD_TASK_COLS_PT = projectBoardColumns(TASK_COLS_PT)` so the Kanban board's poll stops shipping
149 briefs it never renders — 88.2% of a 1,843,144-byte response. That is E1, the defect this
project was chartered to fix. `03-quality.md` §3.1 pre-authorises exactly this and names the file:
*"If phase 6's fix requires touching `forge-control/src/db/projects.ts` … that gate will go red by
design, and the reviewer must adjudicate it against the baseline and record the justification rather
than silently accept or silently fail it."* Accepted, with the justification recorded. It is the
same red the round-14 gate adjudicated (`pre-deploy-gate.md` §4.3); nothing new appeared.

### 4.2 Gate 8 — the allowlist row was checked for scope, not just for green

`scripts/checks/dollar-allowlist.txt` carries **no `.*` pattern**. The row added for the sparkline
false positive is scoped to the coordinate pair —
`forge-control-web/app/desktop/goals/ui.tsx <TAB> x\.toFixed\(2\).*y\.toFixed\(2\)` — and `bb793e6`
records the control that proves it does not waive the file: appending
`// control: renders a cost of $12.50 to the user` to that same listed file still FAILS the sweep at
`:471`, exit 1, restored from a pre-mutation copy by sha256 rather than `git checkout --`.

---

## 5. R87 — the restart — PASS

The forbidden string appears **ten times** in the deploy run's thread. Every one is a *mention*, and
each was read with 200 characters of left context to tell use from mention: **five** are in the
brief itself (`role=user`, message #1, all of the form "NEVER `pm2 restart forge-executor`"), and
**five** are in the deploy's own reports, commit message and vault entry, all of the form
"`pm2 restart forge-executor` was never run". **Not one is a command.** Quoting the string here is
likewise a use, not a violation.

The detached launch is a real `Bash` tool call — thread entry #130, verbatim:

```
Bash {"command":"setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &\necho \"launched detached, pid=$!\"…
```

and its result, #131:

```
launched detached, pid=2979135
[1]+  Done   setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1
forge-executor status=online restarts=3
```

`[1]+ Done` is the *backgrounded shell job* returning, not the watcher exiting — `setsid` detached
it. **The task did not wait on it, poll it or tail it**: #131 is the last thing before the run's
final message. Measured now, hours later: `pgrep -af safe-restart.sh` → `2979137 bash
/opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45`, still alive and still waiting for the
fleet to go idle. `pm2` reports `forge-executor status=online restarts=3` — the same counter the
deploy recorded, which is the independent confirmation that no plain restart was ever issued.

**Consequence, stated because it is live state and not a defect:** until that watcher fires, the
running executor holds **pre-merge** code. The API (`forge-control`) and the UI
(`forge-control-web`) are deployed; the executor picks the new code up at the next idle window.

---

## 6. R88 — `pm2 restart forge-control` — PASS

Thread entry #48, a `Bash` tool call:

```
Bash {"command":"pm2 restart forge-control-web 2>&1 | tail -8\npm2 restart forge-control 2>&1 | tail -8\nsleep 6\n…ss -lntp | grep -E '770[01]'…
```

Recorded in `deploy-report.md` §4 with the resulting listeners on new PIDs.

---

## 7. R89 / S14 — the self-proof, fetched by this gate — PASS

**Not accepted from the deploy's own quote.** Fetched here, at review time:

```
$ ss -lntp | grep 7701
LISTEN 0  511  *:7701  *:*  users:(("next-server (v1",pid=2965178,fd=23))

$ curl -s -o /dev/null -w "%{http_code}\n" -L -m 10 http://127.0.0.1:7701/signin
200

$ cat /opt/forge-ai-os/forge-control-web/.next/BUILD_ID
s5xDVZg4vNWFK40pXIcf6

$ curl -s -L -m 10 http://127.0.0.1:7701/signin | grep -c "s5xDVZg4vNWFK40pXIcf6"
1
$ curl -s -L -m 10 http://127.0.0.1:7701/signin | grep -c "TsvXpNcIwjauqnJDJB2dy"
0
```

The served fragment, verbatim from the response body:

```
<script>self.__next_f.push([1,"0:{\"P\":null,\"b\":\"s5xDVZg4vNWFK40pXIcf6\",\"p\":\"\",\"c\":[\"\",\"signin\"]…
```

| | |
|---|---|
| Pre-deploy `BUILD_ID` (measured 2026-08-19) | `TsvXpNcIwjauqnJDJB2dy` |
| Post-deploy `BUILD_ID`, served now | `s5xDVZg4vNWFK40pXIcf6` |

**They differ, and the new one is what the host serves.** The old one is gone from the response.
Checked with `ss`, not with `pm2`, because a pm2 process can read `online` and have lost its socket.

**The build is from the code merge, not from the docs merge.** `.next/BUILD_ID` was written
`2026-08-20 00:55:13`; the code merge `457f101` is `00:54:31` (42 s earlier) and the docs-only merge
`a32cd54` is `01:01:16` (6 min later). `git diff --name-only 457f101 a32cd54` returns two paths, both
under `docs/` — nothing outside it. So the served bundle carries every code change of the deploy and
the second merge cannot have moved the id. The merge's own scale checks out against the report:
96 commits, 233 files, +81 683 / −1 344, confirmed by `git rev-list --count` and `git diff --shortstat`.

---

## 8. R90 — the push — PASS

```
$ bash scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/7851068b-…
   818425a..2ad7c63  HEAD -> project/7851068b
pushed-branch: project/7851068b
sync exit=0
```

Plain push, no `--force`, no `--force-with-lease`, no rewritten history. Verified against the remote
now: `git ls-remote origin refs/heads/project/7851068b` → `c10cbe29…`, byte-equal to local `HEAD`,
so the later docs commit reached GitHub too. The deploy did **not** downgrade itself over a push —
the push succeeded.

**Operational note, not a finding against R90:** `origin/main` is at `9ef01eb`, behind local `main`
`a32cd54`. R90 governs the work branch and that is pushed; the deploy merge is on the box but not on
GitHub. Whether `main` should be pushed is an operator call, outside this gate.

---

## 9. Write-set audit — PASS

Declarations read from the task rows and cross-read against each builder's own disclosure.

| Task | Declared | Commits | Actually touched | Verdict |
|---|---|---|---|---|
| `d4561713` round 17, THE DEPLOY | `phase7/deploy-report.md`, `phase7/build-ids.txt` | `2ad7c63`, `c10cbe2` | exactly those two files, nothing else | **clean** |
| `8802e61a` round 15, fix cycle 1 | `phase7/pre-deploy-gate.md` (one path) | `818425a` | five paths | **four undeclared — all disclosed** |

The fix cycle's four undeclared writes are `scripts/checks/preflight-deploy.sh`,
`scripts/checks/fixtures/preflight-c1-fixture.sh`,
`docs/plan/artifacts/os-usable-for-work/phase7/preflight-evidence.md` and
`docs/plan/os-usable-for-work/04-phases.md`. **All four are tabled in `04-phases.md` §10 in the same
commit**, and again in `pre-deploy-gate.md` §8, with a reason per row. This is the required handling,
not a footnote past it: the row was unsatisfiable by construction — a fix-cycle row inherits the
*gating reviewers'* write-sets (`fixChainGraphFields()`), so the file the gate ordered changed could
not have been declared, and satisfying the row literally would have meant not fixing the blocker.
The builder disclosed at the site and in §10 rather than abstaining. No undisclosed write exists.

---

## 10. R13's first standing item — CLOSED. Every gate is present and executable on `main`

R13's finding was that gates 17 and 8 both went red the first time `main`'s own commits met them,
because **neither gate existed on `main`** and neither author could have run it. Asserted directly
here, not inferred.

**Presence.** All 17 scripts `gates-808.sh` invokes are in `main`'s tree at the deployed sha
(`git cat-file -e a32cd54:<path>` for each): the five under `docs/plan/artifacts/phase{4,600,700,800}/`
and the twelve under `scripts/checks/`, `gates-808.sh` itself included. Zero missing.

**Executability.** A cold `git clone --local --no-hardlinks /opt/forge-ai-os /tmp/main-gate-r18`,
checked out at `a32cd54f34cd8c83eef1f22e2097932224a7be5d`, deps installed with the mandated flags,
then `bash scripts/checks/gates-808.sh --strict` **run on `main` itself**:

```
 repo:   /tmp/main-gate-r18
 HEAD:   a32cd54f34cd8c83eef1f22e2097932224a7be5d

 SUMMARY — 25 gates
 1  0   npx tsc --noEmit — forge-control            14 0   check-dismiss-peek.tsx
 2  0   npx tsc --noEmit — forge-control-web        15 0   check-team-rows.ts
 3  0   NODE_ENV=production pnpm build              16 0   check-team-confirm.ts
 4  0   token purity                                17 0   verify-notification-gap-pins.mjs
 5  0   no-raw-colours.cjs (whole app)              18 0   check-usage-fold.ts (real Postgres)
 6  0   forbidden-file diff — main...HEAD           19 0   check-usage-fold.ts standalone typecheck
 7  0   forge-control/ untouched by 808             20 0   pnpm test — forge-control unit suite
 8  0   dollar-sweep.sh                             21 0   psql-argv-leak.cjs
 9  0   check-composer-v3.ts                        22 0   nav-walk-sampling.cjs
 10 0   check-secret-requests.ts                    23 -   phase700/network-700.cjs (SKIPPED)
 11 0   contrast-canvas-banners.cjs                 24 -   phase600/nav-walk.cjs   (SKIPPED)
 12 0   check-working-sql-agreement.ts              25 0   reproduce-cleanliness
 13 0   check-stop-affordance.tsx

 RED: 0
EXIT=0
```

**25 gates on `main`: 23 EXECUTED, 2 SKIPPED-by-design, 0 RED.** The two gates R13 named are green
there and demonstrably not inert:

```
GATE 17  ALL PASS — 92/92 pins in docs/plan/notification-gap.md classified
         (11 fenced quotes, 12 prose, 4 live, 7 cross-doc, 32 repeat, 26 historical).
GATE 8   dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.
GATE 20  # tests 1645 / # pass 1645 / # fail 0
```

**No gate is lane-only any more.** `main`'s author can now run the whole suite before pushing, which
is the property the operator ruling asked for. Nothing is filed against an owner because nothing is
outstanding. One honest limit, stated rather than hidden: gate 6 is scoped to `main...HEAD` and is
therefore *vacuous* when run on `main` itself — it is present and executable, but it can only measure
a branch. That is the gate's shape, unchanged by this phase, and §4.1 above measures it against a
real base instead.

---

## 11. R13's second standing item — CLOSED. `preflight-deploy.sh` C1 is fixed, both directions proven

C1 was circular: it took `sort_by(.round) | last` over each workstream's reviewer rows, which for
`main` is always a reviewer scheduled strictly *after* the caller — unsatisfiable at all three points
the script runs. An adjudication was the right call at round 13; it was not a fix.

**Amended where it is enforced**, in `scripts/checks/preflight-deploy.sh` (`818425a`), with the
arithmetic stated inline at `:104-145` and the selection at `:146-232`. C1 now walks each
workstream's reviewer rows from the highest round **down**, judges the first round-band that can hold
a verdict, and skips exactly three cases — printing every skip with its reason:

1. `run_id` is null — the row has never run;
2. `run_id == FORGE_RUN_UUID` — the caller's own run; a gate must not read its own verdict;
3. no verdict yet **and** the run is still in flight (`C1_IN_FLIGHT_RE`, `:50`).

The teeth are intact by construction, and rule 3 is the load-bearing one: a reviewer whose run
**ended** without a `VERDICT:` line is judged and fails as `unparseable`; a workstream where every
row was skipped fails as `no-completed-reviewer`; an unrun re-review seeded above a `NEEDS_FIXES`
is skipped by rule 1, leaving that `NEEDS_FIXES` as the newest *run* row, so it still blocks. The
whole round-band is judged rather than one arbitrary row, because `main` genuinely carries two
round-6 reviewers and `sort_by | last` chose between them on array order.

**Both directions proven**, and by driving the real script, not a copy —
`scripts/checks/fixtures/preflight-c1-fixture.sh`, re-run by this gate:

```
fixture subject : …/scripts/checks/preflight-deploy.sh
subject sha256  : 5afa546acfc86352e38e332e3bbaad53a24a152ab44c93bf354ae84006323329
scratch database: preflight_c1_fixture_2998645_1787180896
  ok — unrun re-review does not launder a NEEDS_FIXES        (C1 FAIL, as expected)
  ok — cleared blocker + pending post-deploy gate passes      (C1 PASS, as expected)
  ok — post-deploy gate running its own preflight             (C1 PASS, as expected)
  ok — a foreign reviewer still in flight is skipped          (C1 PASS, as expected)
  ok — a reviewer that ended without a VERDICT blocks         (C1 FAIL, as expected)
  ok — no reviewer has ever run for a workstream              (C1 FAIL, as expected)
  ok — a NEEDS_FIXES sibling at the same round still blocks   (C1 FAIL, as expected)
  ok — every reviewer row [MERGED] is still no-reviewer       (C1 FAIL, as expected)
FIXTURE: 8 cases — 8 as expected, 0 wrong        FIXTURE: PASS   (exit 0)
```

**Five of the eight are failures.** It still goes red for a lane that genuinely failed — case 1 and
case 7 are exactly that, and case 7 is the sibling-order trap a `sort_by | reverse` fixture would
otherwise hide. The entrypoint guard is `[ "${BASH_SOURCE[0]}" = "$0" ]`, deliberately not an
environment variable: no env var can make an executed `preflight-deploy.sh` exit 0 without running
its checks. Four mutation controls — each removing one rule, each verified to have changed exactly
one line — are recorded in `pre-deploy-gate.md` §6; mutation C (the in-flight skip made
unconditional) flips "a reviewer that ended without a VERDICT blocks" to PASS, which is precisely the
hole a careless reading of rule 3 would open. The fixture is not inert.

The live proof that the loosening did not blunt the gate: at `6958f5f` the preflight **still exited
1**, naming `main=NEEDS_FIXES (round 14)` — the real open blocker — instead of a gate two rounds in
the future. It went green only after the round-16 re-review returned PASS, and it printed the count
of skipped rows alongside, so a green C1 is never read as "every reviewer row was checked".

---

## 12. The two preconditions this project exists for — both verified against the LIVE surface

### 12.1 A labelled, non-zero note count

`GET http://127.0.0.1:7700/api/memory/counts`, live index, `measured_at 2026-08-19T23:08:57Z`:

```json
{"vault_files_on_disk":289,"vault_notes_indexed":289,"agent_notes":198,
 "embedded_files":264,"embedded_chunks":2107,
 "excluded":{"excalidraw":15,"empty":10,"frontmatter_only":1},
 "stale_embedding_rows":1,"source":"all","folder_counts":{…14 folders…}}
```

Independently confirmed on disk: `find /opt/obsidian-vault -name '*.md' -type f -not -path '*/.*/*' | wc -l`
→ **289**, matching `vault_files_on_disk` exactly. Including dot-directories it is 331; the 42-file
gap is `.trash`, deleted notes the surface is right not to count.

And what the **browser actually rendered** — scraped from `document.body.innerText`, never quoted
from source, so a component that renders nothing cannot pass this:

```
289 vault notes indexed
198 agent briefs (no file on disk)
289 .md files on disk
264 files embedded · 2,111 chunks embedded
excluded: 15 excalidraw · 10 empty · 1 frontmatter-only
1 stale embedding rows
measured at 2026-08-19T23:09:24.333Z
```

**Every number carries a unit.** The "0 notes" defect — `counts.all` removed from the API while
`MemorySurface` still read `counts.all ?? 0` — is closed, and preflight C5 now compares the emitted
field set against the accessed one on every deploy, self-testing its comparator against a fabricated
field first.

Screenshot: `/opt/ai-os/uploads/3fced573948c/20260819T230923Z-r18-memory-surface-live.png`, **Read
back into this review's transcript**. Session minted by `phase1/browser-harness.mjs` with the
`__Secure-authjs.session-token` salt and the `/signin` assertion cleared (`ok:true`, `status:200`)
before anything was believed; `waitUntil:"commit"` (Next 15 here hangs the full timeout on
`networkidle` and `domcontentloaded`); viewport `1600x2200` rather than `--full-page`, because the
desktop shell scrolls internally and a full-page shot equals the viewport. Also visible live in that
shot: the note list populated (30 loaded), the folder census, **Open in Obsidian** with its honest
caveat, **Copy vault path** beside it, the `edit` affordance, and `LIBRARY`/`JOURNAL`/`MAP` carrying
explicit **UNBUILT** badges rather than rendering empty.

### 12.2 The live checkout is clean

Recorded in §0. Empty, twice.

---

## 13. What this review does NOT claim

- **It does not re-review the lanes' code.** R83–R90 are integration, deploy and proof requirements;
  each lane was gated by its own reviewer and those verdicts are `PASS` (C1's output, §11).
- **It does not claim the executor runs the new code.** It does not, yet, and that is by design —
  §5. The detached watcher is alive and fires at the next idle window.
- **It does not claim `main` is on GitHub.** It is not — §8.
- **Gate 6's green in §4 is vacuous** and is adjudicated against a real base in §4.1 instead. Any
  later reader taking `RED: 0` at face value without §4.1 will draw a stronger conclusion than the
  measurement supports.

---

## VERDICT: PASS
