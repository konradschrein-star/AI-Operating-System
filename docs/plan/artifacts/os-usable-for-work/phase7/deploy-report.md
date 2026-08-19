# Phase 7 deploy — DEPLOYED (round 17, re-seeded)

**Task** `d4561713` · **run** `3d5c6e98-5b92-4637-9edf-684c4b2c4e8b` · **2026-08-19 UTC**
**Worktree** `/opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a`, branch `project/7851068b` at `818425a`
**Live checkout** `/opt/forge-ai-os`, `main` `9c3f63a` → **`457f101`**

**BUILD_ID `TsvXpNcIwjauqnJDJB2dy` → `s5xDVZg4vNWFK40pXIcf6`, and the new one is what the host
serves.** Full evidence in [`build-ids.txt`](./build-ids.txt).

Round 15's deploy (`fe3749e0`) refused, correctly, on two independent preconditions. Both are now
closed — not waived. This report shows how each was closed and what was measured after.

---

## 1. Preconditions

### 1.1 The gate verdict — read from `runs.thread`, not from an artefact

The brief's precondition said the phase-7 pre-deploy gate `4b9e9a75` issued `VERDICT: PASS`.
**It did not.** That claim was written at seeding time, before the gate ran, and it is a prediction
rather than a measurement. Read from the runs database, joining on `metadata->>'task_id'` and taking
the **last** assistant message carrying the marker (a whole-column regex classifies every reviewer as
both verdicts, because the brief itself contains both strings):

| Task | Round | Run | Run status | Verdict |
|---|---|---|---|---|
| `4b9e9a75` pre-deploy gate | 14 | `704942f2` | completed | **`VERDICT: NEEDS_FIXES`** |
| `ea8360e4` re-review after fix cycle 1 | 16 | `8c8c4332` | completed | **`VERDICT: PASS`** |

The round-14 `NEEDS_FIXES` is the blocker that fix cycle `8802e61a` (`818425a`) was seeded to close;
the round-16 re-review is the row that closes it, and it is the newest reviewer for `main` that has
run. Quoting its own words:

> **FIXED.** `scripts/checks/preflight-deploy.sh:180-232`. […] The preflight still exits 1, and that
> is the correct answer at this tip […] **This verdict is what closes that row and turns C1 green for
> round 17.**

So the precondition is satisfied by `ea8360e4`, not by `4b9e9a75`. Deploying on the strength of the
brief's assertion alone would have deployed over an open `NEEDS_FIXES`.

### 1.2 `preflight-deploy.sh` → exit 0

Run unmodified, before the merge. **The script was not edited by this task** — a deploy that clears
its own gate is exactly what the gate exists to prevent.

```
### C1 — every lane's final verdict is PASS ###
  (caller run 3d5c6e98-5b92-4637-9edf-684c4b2c4e8b — reviewer rows pointing at it are skipped, never judged)
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: SKIP round 18 (task 6d92b80e-0b93-4ed8-8fad-270d6a078abf, status=pending) — never run, no run_id ('Phase 7 GATE — R83-R90, the baseline diff, and the BUILD_ID fetched from the live host')
  main: PASS (round 16, task ea8360e4-e880-4c57-b028-50d5edb2b7b1)
PASS — C1 — every lane's final verdict is PASS (vault surfaces connections business perf main); 1 reviewer row(s) skipped as not-yet-run/in-flight/self, listed above — this is NOT 'every row checked'
----------------------------------------
### C2 — live checkout (/opt/forge-ai-os) is clean ###
PASS — C2 — /opt/forge-ai-os is clean at main=9c3f63a
----------------------------------------
### C3 — no lane branch has unmerged work into project/7851068b ###
  vault (project/7851068b-vault): 0 commit(s) not yet in project/7851068b
  surfaces (project/7851068b-surfaces): 0 commit(s) not yet in project/7851068b
  connections (project/7851068b-connections): 0 commit(s) not yet in project/7851068b
  business (project/7851068b-business): 0 commit(s) not yet in project/7851068b
  perf (project/7851068b-perf): 0 commit(s) not yet in project/7851068b
PASS — C3 — no lane branch has unmerged work
----------------------------------------
### C4 — merge-tree probe: main <- project/7851068b ###
  9d88f3c2b6427895e651e17b4221b8bca0b60edf
PASS — C4 — merge-tree probe is conflict-free (tree 9d88f3c2b6427895e651e17b4221b8bca0b60edf)
----------------------------------------
### C5 — MemorySurface reads no field routes/memory.ts does not emit ###
  emitted (routes/memory.ts -> noteCounts): agent_notes, embedded_chunks, embedded_files, excluded, folder_counts, folder_rule, measured_at, source, stale_embedding_rows, vault_files_on_disk, vault_notes_indexed
  accessed (MemorySurface.tsx): agent_notes, embedded_chunks, embedded_files, excluded, folder_counts, folder_rule, measured_at, stale_embedding_rows, vault_files_on_disk, vault_notes_indexed
  self-test (bogus field __bogusField99__ must be caught): selfTestOk=true
PASS — C5 — MemorySurface.tsx reads no field routes/memory.ts does not emit, and the comparator's self-test passed
----------------------------------------
SUMMARY: 5 checks — 5 PASS, 0 FAIL
----------------------------------------
PREFLIGHT: PASS — phase 7 may deploy
```

**`=== PREFLIGHT EXIT: 0 ===`**

C1 went green exactly as the fix cycle predicted, and the predicted mechanism is visible in the
output: round 18 is skipped as never-run, round 16 is judged and is `PASS`. C4's tree is
`9d88f3c2`, not the `4c94920c` the brief recorded — the branch tip moved to `818425a` (the fix
cycle) after that measurement, so a different tree is expected.

Re-run **after** the merge it still exits 0, with `C2 — /opt/forge-ai-os is clean at main=457f101`.

### 1.3 The live checkout was clean, re-read at run time

```
$ git -C /opt/forge-ai-os status --porcelain
$ git -C /opt/forge-ai-os rev-parse HEAD
9c3f63aa161a29b844699fcf537e9c8ae22f374d
```

No output. Re-read immediately before the merge and again after: still no output. Nothing was
preserved, discarded or escalated, because there was nothing there. `git reflog show main` showed no
prior merge of `project/7851068b` — this was not a retry over a partially-completed deploy.

---

## 2. The merge

`main` is the deliverable; the project brief does not ask for a PR (R17). No PR was opened.

```
$ cd <worktree> && git merge --no-ff main
Already up to date.
```

`main` had not moved: `rev-list --count project/7851068b..main` = 0. The tip stayed
`818425aeffa2a8966c67645619c9d6c41d814b05` — byte-for-byte the tip the round-16 reviewer passed, so
the re-run below measures what was reviewed and nothing else.

Re-run in the worktree after that no-op merge:

| Check | Result |
|---|---|
| `forge-control` install `--frozen-lockfile --prod=false` | `Already up to date`, tsc **5.9.3**, tsx **4.22.4** present |
| `forge-control` `tsc --noEmit` | **exit 0** |
| `forge-control-web` install `--frozen-lockfile --prod=false` | `Already up to date`, tsc **5.7.2** present |
| `forge-control-web` `tsc --noEmit` | **exit 0** |
| `pnpm test` | **1645 tests, 1645 pass, 0 fail**, 308 suites |

Then, in the live checkout:

```
$ git -C /opt/forge-ai-os merge --no-ff project/7851068b -m "merge(os-usable-for-work): phase 7 deploy — …"
merge exit=0
$ git -C /opt/forge-ai-os rev-parse HEAD
457f1011f42118ecd31fe35dcaa01be2a3f9e4f1
$ git -C /opt/forge-ai-os status --porcelain      # empty
```

**No conflicts at either step.** 96 commits, 233 files, +81 683 / −1 344.

---

## 3. Install and rebuild — `NODE_ENV=production`, so `--prod=false` everywhere

```
$ echo $NODE_ENV
production

$ cd /opt/forge-ai-os/forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 700ms using pnpm v9.15.9
$ ls -d node_modules/typescript node_modules/tsx
node_modules/tsx
node_modules/typescript
$ ./node_modules/.bin/tsc --version && ./node_modules/.bin/tsx --version
Version 5.9.3
tsx v4.22.4

$ cd /opt/forge-ai-os/forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 1s using pnpm v9.15.9
$ ls -d node_modules/typescript node_modules/next && ./node_modules/.bin/tsc --version
node_modules/next
node_modules/typescript
Version 5.7.2
```

**On the `+ typescript` requirement.** The brief asks for a transcript showing `+ typescript` rather
than `- typescript` (R84 — a bare `--frozen-lockfile` under `NODE_ENV=production` exits 0, says
`Already up to date`, and silently *removes* typescript). Both installs were already correct, so
pnpm printed neither line: `Already up to date` emits no `+`/`−` at all. A missing `+ typescript` is
therefore not evidence of anything, in either direction. What settles it is the state of the tree
after the install, which is why the `ls -d` and `--version` calls above are in the transcript:
typescript and tsx are **present and executable in both packages after the install ran**. That is the
property `+ typescript` is a proxy for, measured directly. `pnpm` was used throughout; `npm` was
never invoked.

```
$ cd /opt/forge-ai-os/forge-control-web && pnpm build
   ▲ Next.js 15.1.3
 ✓ Compiled successfully
   Linting and checking validity of types ...
 ✓ Generating static pages (10/10)
=== build exit=0 ===
```

---

## 4. The restarts

```
$ pm2 restart forge-control-web
$ pm2 restart forge-control
$ ss -lntp | grep -E '770[01]'
LISTEN 0  511  127.0.0.1:7700  0.0.0.0:*  users:(("node /opt/forge",pid=2965204,fd=31))
LISTEN 0  511          *:7701        *:*  users:(("next-server (v1",pid=2965178,fd=23))
```

Both on new PIDs (7701 was `1901687`), both **listening** — checked with `ss`, not with pm2, because
a pm2 process can be `online` and have lost its socket.

### `pm2 restart forge-executor` WAS NEVER RUN

Stated explicitly, as the brief requires. It was not run to deploy, not to test, not once. The
executor's restart counter is unchanged at **3** across this whole task. The diff does touch
executor-loaded code — `forge-control/src/db/memory.ts`, `db/pipeline.ts`, `db/projects.ts`,
`db/reminders.ts` — so a plain restart would have killed every run in flight including this one.
The restart is delegated to the detached procedure, launched at the very end of this run and never
waited on, polled, or tailed:

```
setsid nohup /opt/ai-os/scripts/safe-restart.sh forge-executor 43200 45 >> /tmp/safe-restart.log 2>&1 &
```

It waits for the fleet to go idle and restarts then. **Until it fires, the running executor still
holds the pre-merge code** — the API and the web UI are deployed, the executor picks the new code up
at the next idle window.

---

## 5. The self-proof (R89, S14)

| | |
|---|---|
| Pre-deploy `BUILD_ID` | `TsvXpNcIwjauqnJDJB2dy` |
| Post-deploy `BUILD_ID` | `s5xDVZg4vNWFK40pXIcf6` |

Verbatim from what the live host serves:

```
$ curl -s -L -m 10 http://127.0.0.1:7701/signin | grep -o 'self.__next_f.push(\[1,"0:{\\"P\\":null,\\"b\\":\\"[A-Za-z0-9_-]*\\"'
self.__next_f.push([1,"0:{\"P\":null,\"b\":\"s5xDVZg4vNWFK40pXIcf6\"
```

New id: **1 occurrence**. Old id: **0 occurrences**. `/` → 307 → `/signin` → **200**.

---

## 6. The two preconditions that motivated the project, verified against the LIVE index

### 6.1 The memory surface does not lie

`GET http://127.0.0.1:7700/api/memory/counts` against the live index, `measured_at`
`2026-08-19T22:58:05Z` — a fresh measurement taken during this run, not a cached one:

```json
{"vault_files_on_disk":288,"vault_notes_indexed":288,"agent_notes":198,
 "embedded_files":263,"embedded_chunks":2224,
 "excluded":{"excalidraw":15,"empty":10,"frontmatter_only":1},
 "stale_embedding_rows":1,"source":"all"}
```

And what the browser actually rendered — scraped from `document.body.innerText`, never quoted from
the source, so a component that renders nothing cannot pass this:

```
288 vault notes indexed
198 agent briefs (no file on disk)
288 .md files on disk
263 files embedded · 2,224 chunks embedded
excluded: 15 excalidraw · 10 empty · 1 frontmatter-only
1 stale embedding rows
measured at 2026-08-19T22:58:05.000Z
```

**Every number carries a unit.** The defect this replaces — `counts.all` removed from the API while
`MemorySurface` still read `counts.all ?? 0`, rendering "0 notes" for a full vault — cannot recur
silently: preflight C5 compares the emitted field set against the accessed one on every deploy, and
self-tests its own comparator against a fabricated field first.

Screenshot: `/opt/ai-os/uploads/3d5c6e985b92/20260819T225804Z-r17-memory-surface-live.png`, Read back
into the transcript. Driven at `--viewport 1600x2200` rather than `--full-page` (the desktop shell
scrolls internally, so a full-page shot equals the viewport), `waitUntil: "commit"` (Next 15 here
hangs the full timeout on `networkidle` and `domcontentloaded`), session minted and the `/signin`
assertion cleared by `phase1/browser-harness.mjs` (`ok: true`, `status: 200`,
`salt: __Secure-authjs.session-token`) before anything was believed.

Also visible in that shot, live: the note list populated, the **Open in Obsidian** control present
with its honest caveat ("only works on a machine running Obsidian with a vault named
`obsidian-vault` — this server does not run Obsidian"), **Copy vault path** beside it, the `edit`
affordance on the note, the folder census, and `LIBRARY`/`JOURNAL`/`MAP` carrying explicit
**UNBUILT** badges instead of rendering empty.

### 6.2 A discrepancy checked rather than assumed

`find /opt/obsidian-vault -name '*.md' -type f | wc -l` returns **330**, against the surface's 288.
Not a defect: the difference is **entirely `.trash`**.

```
all .md:            330
excluding dotdirs:  288
.md under dot-directories:   42  .trash
```

288 = 330 − 42 exactly. The surface is right to count live notes and not deleted ones.

---

## 7. GitHub push — succeeded

```
$ bash scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/7851068b-…
git-sync-branch.sh: pushing project/7851068b to git@github.com:konradschrein-star/AI-Operating-System.git
To github.com:konradschrein-star/AI-Operating-System.git
   818425a..2ad7c63  HEAD -> project/7851068b
pushed-branch: project/7851068b
sync exit=0
```

Plain push. No `--force`, no `--force-with-lease`, no rewritten history.

---

## 8. Write-set

Declared: `deploy-report.md`, `build-ids.txt` — **both**, and nothing else. This task wrote no
source file, edited no gate, and touched `/opt/forge-ai-os` only through `git merge`, `pnpm
install`, `pnpm build` and the two allowed `pm2 restart`s.

The one file written outside the repo is `/tmp/r17-memory-drive.mjs`, the throwaway surface driver
for §6.1 — untracked, outside every worktree, not part of any commit. It mints no credential: it
consumes the token `browser-harness.mjs --cookie-out` already minted and re-asserts `/signin`
itself (exit 2, no screenshot written, on a wall). It exists because `browser-harness.mjs` evaluates
`--eval` *after* its screenshot and so cannot select a surface held behind
`localStorage["forge.desktop.surface"]` (`DesktopApp.tsx:253`) before it shoots — the improvement
already filed against the harness in phase 2. The harness itself was not forked or edited.

## 9. Final state of `main`

The deploy merge landed at `457f101`, which is the commit that was built and is being served. This
report and `build-ids.txt` were written **after** that build, so they arrive on `main` in a second,
docs-only merge on top of it. That merge changes no code and therefore does **not** move the
`BUILD_ID` — `s5xDVZg4vNWFK40pXIcf6` remains what the host serves, and the §5 proof stands. The
final `main` tip is recorded in the task's report.
