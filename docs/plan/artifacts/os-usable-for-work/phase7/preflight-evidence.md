# Preflight-deploy evidence — round 0, `main`

`scripts/checks/preflight-deploy.sh`, tree `c9ebed9` (`project/7851068b`, this worktree). Read-only
throughout: `/opt/forge-ai-os` is `9c3f63a` before this document was written and `9c3f63a` after —
every forced-failure demo below runs against a **scratch clone or scratch git repo in `/tmp`**, never
against the live checkout. Timestamps UTC, captured 2026-08-19.

## 1. Real run against the tree as it stands today

Two of five checks fail today — that is the correct, expected result. Nothing has merged into `main`
yet (that is the entire reason phase 7 exists), and the phase-7 gating reviewer (round 16, task
`6d92b80e`) has not run yet, so `main`'s own lane has no verdict.

```
$ bash scripts/checks/preflight-deploy.sh
----------------------------------------
### C1 — every lane's final verdict is PASS ###
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: highest reviewer is round 16 (task 6d92b80e-0b93-4ed8-8fad-270d6a078abf, status=pending) — no run_id yet, so no verdict exists ('Phase 7 GATE — R83-R90, the baseline diff, and the BUILD_ID fetched from the live host')
FAIL — C1 — every lane's final verdict is PASS: main=not-yet-run
----------------------------------------
### C2 — live checkout (/opt/forge-ai-os) is clean ###
PASS — C2 — /opt/forge-ai-os is clean at main=9c3f63a
----------------------------------------
### C3 — no lane branch has unmerged work into project/7851068b ###
  vault (project/7851068b-vault): 22 commit(s) not yet in project/7851068b
  surfaces (project/7851068b-surfaces): 17 commit(s) not yet in project/7851068b
  connections (project/7851068b-connections): 20 commit(s) not yet in project/7851068b
  business (project/7851068b-business): 8 commit(s) not yet in project/7851068b
  perf (project/7851068b-perf): 7 commit(s) not yet in project/7851068b
FAIL — C3 — lanes with unmerged commits: vault=22 surfaces=17 connections=20 business=8 perf=7
----------------------------------------
### C4 — merge-tree probe: main <- project/7851068b ###
  20f8596349fe4040637618d6f4c5edc80992ceec
PASS — C4 — merge-tree probe is conflict-free (tree 20f8596349fe4040637618d6f4c5edc80992ceec)
----------------------------------------
### C5 — MemorySurface reads no field routes/memory.ts does not emit ###
  emitted (routes/memory.ts -> noteCounts): all, fact, note, person, pref, project, rule
  accessed (MemorySurface.tsx): all, fact, note, person, pref, project, rule
  self-test (bogus field __bogusField99__ must be caught): selfTestOk=true
PASS — C5 — MemorySurface.tsx reads no field routes/memory.ts does not emit, and the comparator's self-test passed
----------------------------------------
SUMMARY: 5 checks — 3 PASS, 2 FAIL
----------------------------------------
PREFLIGHT: FAIL — phase 7 may NOT deploy
$ echo "exit=$?"
exit=1
```

Note the C3 counts (22/17/20/8/7) differ slightly from the 22/7/20/8/7 the operator measured when
writing this task's brief — `surfaces` grew from 7 to 17 commits between then and this run. That is
exactly why C3 re-derives the counts at run time instead of trusting a number written into a brief;
see [[diff-range-cannot-prove-unedited]] and the brief's own C2 instruction to the same effect.

Runtime: **0.5s** (measured with `time`).

## 2. Forced-failure demonstrations, one check at a time

Method for C1/C2/C3/C4: copy `preflight-deploy.sh` to `/tmp/preflight-demo/preflight-cN-demo.sh`,
change exactly the one line that names the real data source (project API URL / `/opt/forge-ai-os`
path / branch name / ref name) into an environment-variable override that **defaults to the real
value**, and disable the trailing `main "$@"` so the check function can be called directly. The full
diff for every demo copy is below — each is a one-line data-source substitution plus the disabled
entrypoint, nothing in the check logic itself changed. None of these copies were committed; they
exist only under `/tmp/preflight-demo/`.

Method for C5: no patch was needed — `check_c5` already resolves its two source paths from `$REPO`,
so the demo simply points `$REPO` at a scratch copy of the two files.

```diff
=== diff for preflight-c1-demo.sh ===
--- scripts/checks/preflight-deploy.sh	2026-08-19 22:38:50.503297207 +0200
+++ /tmp/preflight-demo/preflight-c1-demo.sh	2026-08-19 22:40:28.624069671 +0200
@@ -74,7 +74,9 @@
 check_c1() {
   echo "### C1 — every lane's final verdict is PASS ###"
   local project_json="$TMPDIR/project.json"
-  if ! curl -sf -m 15 "$API_BASE/api/projects/$PROJECT_ID" -o "$project_json"; then
+  if [ -n "${C1_DEMO_FIXTURE:-}" ]; then
+    cp "$C1_DEMO_FIXTURE" "$project_json"
+  elif ! curl -sf -m 15 "$API_BASE/api/projects/$PROJECT_ID" -o "$project_json"; then
     fail_check "C1 — could not fetch $API_BASE/api/projects/$PROJECT_ID (project tasks)"
     return
   fi
@@ -384,4 +386,4 @@
   fi
 }
 
-main "$@"
+# main "$@"  -- disabled for demo; caller invokes check_c1 directly

=== diff for preflight-c2-demo.sh ===
--- scripts/checks/preflight-deploy.sh	2026-08-19 22:38:50.503297207 +0200
+++ /tmp/preflight-demo/preflight-c2-demo.sh	2026-08-19 22:40:50.328240435 +0200
@@ -26,7 +26,7 @@
 cd "$REPO"
 
 PROJECT_ID="7851068b-32d7-469b-b42f-f5e3c1d9e83a"
-LIVE_CHECKOUT="/opt/forge-ai-os"
+LIVE_CHECKOUT="${C2_DEMO_LIVE_CHECKOUT:-/opt/forge-ai-os}"
 BASE_BRANCH="project/7851068b"
 LANE_WORKSTREAMS=(vault surfaces connections business perf)
 ALL_WORKSTREAMS=(vault surfaces connections business perf main)
@@ -384,4 +384,4 @@
   fi
 }
 
-main "$@"
+# main "$@"  -- disabled for demo; caller invokes check_c2 directly

=== diff for preflight-c3-demo.sh ===
--- scripts/checks/preflight-deploy.sh	2026-08-19 22:38:50.503297207 +0200
+++ /tmp/preflight-demo/preflight-c3-demo.sh	2026-08-19 22:41:08.947386899 +0200
@@ -27,7 +27,7 @@
 
 PROJECT_ID="7851068b-32d7-469b-b42f-f5e3c1d9e83a"
 LIVE_CHECKOUT="/opt/forge-ai-os"
-BASE_BRANCH="project/7851068b"
+BASE_BRANCH="${C3_DEMO_BASE_BRANCH:-project/7851068b}"
 LANE_WORKSTREAMS=(vault surfaces connections business perf)
 ALL_WORKSTREAMS=(vault surfaces connections business perf main)
 API_BASE="${FORGE_CONTROL_API:-http://127.0.0.1:7700}"
@@ -384,4 +384,4 @@
   fi
 }
 
-main "$@"
+# main "$@"  -- disabled for demo; caller invokes check_c3 directly

=== diff for preflight-c4-demo.sh ===
--- scripts/checks/preflight-deploy.sh	2026-08-19 22:38:50.503297207 +0200
+++ /tmp/preflight-demo/preflight-c4-demo.sh	2026-08-19 22:41:49.078702505 +0200
@@ -27,7 +27,7 @@
 
 PROJECT_ID="7851068b-32d7-469b-b42f-f5e3c1d9e83a"
 LIVE_CHECKOUT="/opt/forge-ai-os"
-BASE_BRANCH="project/7851068b"
+BASE_BRANCH="${C4_DEMO_BASE_BRANCH:-project/7851068b}"
 LANE_WORKSTREAMS=(vault surfaces connections business perf)
 ALL_WORKSTREAMS=(vault surfaces connections business perf main)
 API_BASE="${FORGE_CONTROL_API:-http://127.0.0.1:7700}"
@@ -188,13 +188,13 @@
 # ---------------------------------------------------------------------------
 check_c4() {
   echo "### C4 — merge-tree probe: main <- $BASE_BRANCH ###"
-  if ! git rev-parse --verify main >/dev/null 2>&1; then
+  if ! git rev-parse --verify "${C4_DEMO_MAIN_REF:-main}" >/dev/null 2>&1; then
     fail_check "C4 — local ref 'main' does not exist in this checkout"
     return
   fi
   local out rc
   set +e
-  out="$(git merge-tree --write-tree --name-only main "$BASE_BRANCH" 2>&1)"
+  out="$(git merge-tree --write-tree --name-only "${C4_DEMO_MAIN_REF:-main}" "$BASE_BRANCH" 2>&1)"
   rc=$?
   set -e
   echo "$out" | sed 's/^/  /'
@@ -384,4 +384,4 @@
   fi
 }
 
-main "$@"
+# main "$@"  -- disabled for demo; caller invokes check_c4 directly

=== diff for preflight-c5-demo.sh ===
--- scripts/checks/preflight-deploy.sh	2026-08-19 22:38:50.503297207 +0200
+++ /tmp/preflight-demo/preflight-c5-demo.sh	2026-08-19 22:42:10.845873644 +0200
@@ -384,4 +384,4 @@
   fi
 }
 
-main "$@"
+# main "$@"  -- disabled for demo; caller invokes check_c5 directly
```

### C1 — every lane's final verdict is PASS

Three shapes demonstrated against fixture copies of the real project-tasks JSON (`jq`-derived from a
live `GET /api/projects/<id>`, never re-fetched or hand-typed):

**(a) A lane's verdict is NEEDS_FIXES.** The fixture points `vault`'s round-12 winner at task
`31836b84-a42d-4024-8a5a-885a71ea13ea` — a **real** historical reviewer row (round 5, "Re-review
after fix cycle 1 · vault") whose recorded verdict in `runs.thread` is genuinely `NEEDS_FIXES`. No
verdict text was fabricated.

```
=== C1 forced-failure demo #1: NEEDS_FIXES lane (fixture points vault's round-12 winner at a REAL NEEDS_FIXES verdict task, 31836b84...) ===
### C1 — every lane's final verdict is PASS ###
  vault: NEEDS_FIXES (round 12, task 31836b84-a42d-4024-8a5a-885a71ea13ea, 'Re-review after fix cycle 1 · vault')
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: highest reviewer is round 16 (task 6d92b80e-0b93-4ed8-8fad-270d6a078abf, status=pending) — no run_id yet, so no verdict exists ('Phase 7 GATE — R83-R90, the baseline diff, and the BUILD_ID fetched from the live host')
FAIL — C1 — every lane's final verdict is PASS: vault=NEEDS_FIXES main=not-yet-run
```

**(b) A lane has no eligible reviewer at all.** The fixture deletes every reviewer row for `perf`:

```
=== C1 forced-failure demo #2: no reviewer at all (fixture deletes every reviewer row for perf) ===
### C1 — every lane's final verdict is PASS ###
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: no reviewer task (every reviewer row is [MERGED]/[FOLDED]/[RETIRED], or none exists)
  main: highest reviewer is round 16 (task 6d92b80e-0b93-4ed8-8fad-270d6a078abf, status=pending) — no run_id yet, so no verdict exists ('Phase 7 GATE — R83-R90, the baseline diff, and the BUILD_ID fetched from the live host')
FAIL — C1 — every lane's final verdict is PASS: perf=no-reviewer main=not-yet-run
```

**(c) Passing shape — all six lanes PASS.** The fixture points `main`'s round-16 gate at task
`ab659f37-8119-48ab-97ac-225f6064c89a` — the real round-8 "Re-check fix cycle 2 · main" reviewer,
whose recorded verdict genuinely is `PASS` (see commit `c9ebed9`'s message, which quotes it):

```
=== C1 passing shape: all six lanes verdict PASS (fixture points main's round-16 gate at a REAL PASS verdict task, ab659f37...) ===
### C1 — every lane's final verdict is PASS ###
  vault: PASS (round 12, task 938740f4-9939-4d8a-926f-98ca3f2c8259)
  surfaces: PASS (round 4, task da6385eb-a845-4a01-930e-7555271a0282)
  connections: PASS (round 6, task 2c112799-7d19-4099-b784-a7a90886d42e)
  business: PASS (round 5, task 8e2da884-c94d-410b-9ae4-76cda0b06936)
  perf: PASS (round 3, task 98cbb26e-ce88-4588-810c-b22dfa27db62)
  main: PASS (round 16, task ab659f37-8119-48ab-97ac-225f6064c89a)
PASS — C1 — every lane's final verdict is PASS (vault surfaces connections business perf main)
```

The real run above (§1) is itself a fourth, organic demonstration of C1's FAIL path — `main`'s
`not-yet-run` case — needing no fixture at all.

### C2 — the live checkout is clean

`git clone -q /opt/forge-ai-os /tmp/preflight-demo/scratch-checkout`, then one file edited in the
clone. `/opt/forge-ai-os` itself was never touched (`git -C /opt/forge-ai-os status --porcelain`
printed nothing before, during and after this demo — reconfirmed in §3 below).

```
=== C2 forced-failure demo: scratch clone of /opt/forge-ai-os with one file dirtied ===
### C2 — live checkout (/tmp/preflight-demo/scratch-checkout) is clean ###
   M README.md
  (archive of prior dirt, if any, lives at /opt/ai-os/backups/live-dirty/ — never discard; escalate)
FAIL — C2 — /tmp/preflight-demo/scratch-checkout has uncommitted changes, see paths above
```

Passing shape is the real run in §1: `PASS — C2 — /opt/forge-ai-os is clean at main=9c3f63a`.

### C3 — no lane branch has unmerged work

A scratch git repo (`/tmp/preflight-demo/scratch-repo3`) with a base branch and five lane branches,
built fresh for each of three shapes:

**(a) One lane unmerged, four clean:**

```
=== C3 forced-failure demo: one lane (surfaces) unmerged, four lanes clean ===
### C3 — no lane branch has unmerged work into demo/base ###
  vault (demo/base-vault): 0 commit(s) not yet in demo/base
  surfaces (demo/base-surfaces): 1 commit(s) not yet in demo/base
  connections (demo/base-connections): 0 commit(s) not yet in demo/base
  business (demo/base-business): 0 commit(s) not yet in demo/base
  perf (demo/base-perf): 0 commit(s) not yet in demo/base
FAIL — C3 — lanes with unmerged commits: surfaces=1
```

**(b) Passing shape — all five lanes fully merged:**

```
=== C3 passing shape: all five lanes fully merged (0 commits ahead) ===
### C3 — no lane branch has unmerged work into demo/base ###
  vault (demo/base-vault): 0 commit(s) not yet in demo/base
  surfaces (demo/base-surfaces): 0 commit(s) not yet in demo/base
  connections (demo/base-connections): 0 commit(s) not yet in demo/base
  business (demo/base-business): 0 commit(s) not yet in demo/base
  perf (demo/base-perf): 0 commit(s) not yet in demo/base
PASS — C3 — no lane branch has unmerged work
```

**(c) A lane branch is missing entirely** (distinct failure mode — the branch never existed rather
than existing-but-ahead):

```
=== C3 forced-failure demo (missing branch): perf lane branch deleted ===
### C3 — no lane branch has unmerged work into demo/base ###
  vault (demo/base-vault): 0 commit(s) not yet in demo/base
  surfaces (demo/base-surfaces): 0 commit(s) not yet in demo/base
  connections (demo/base-connections): 0 commit(s) not yet in demo/base
  business (demo/base-business): 0 commit(s) not yet in demo/base
  perf: FAIL — branch demo/base-perf does not exist
FAIL — C3 — lanes with unmerged commits: perf=missing-branch
```

The real run in §1 organically demonstrates C3's FAIL path against the actual lane branches
(22/17/20/8/7 commits ahead) — needing no fixture at all.

### C4 — the merge is conflict-free before it is attempted

A second scratch repo (`/tmp/preflight-demo/scratch-repo4`) with two branches that both edit the same
line of the same file — a genuine merge conflict, not a simulated one:

```
=== C4 forced-failure demo: real merge conflict (both branches edit the same line) ===
### C4 — merge-tree probe: main <- demo/feature ###
  fe1674b32f3e241fc5b4c545f1d9bf911bb23543
  conflict.txt
  
  Auto-merging conflict.txt
  CONFLICT (content): Merge conflict in conflict.txt
FAIL — C4 — merge-tree probe reports conflicts (exit 1), paths above
```

A second fail mode — the local `main` ref not existing in the checkout at all:

```
=== C4 forced-failure demo: local 'main' ref missing ===
### C4 — merge-tree probe: main <- demo/feature ###
FAIL — C4 — local ref 'main' does not exist in this checkout
```

Passing shape is the real run in §1: `PASS — C4 — merge-tree probe is conflict-free (tree
20f8596349fe4040637618d6f4c5edc80992ceec)`. `git merge-tree --write-tree` writes nothing to the
working tree in either shape (git 2.43.0, confirmed via `git --version`) — both demos above ran with
the scratch repos' working trees never checked out to the conflicting branches.

### C5 — the memory surface will not render "0 notes"

Scratch copies of `forge-control/src/routes/memory.ts`, `forge-control/src/db/memory.ts` and
`forge-control-web/app/desktop/MemorySurface.tsx` under `/tmp/preflight-demo/scratch-c5/`, with the
**exact historical defect this check exists to catch** reproduced: `counts.all` renamed to
`counts.total` in the surface file, so it reads a field the backend's `noteCounts()` genuinely does
not emit — the string-literal `counts.all` no longer appears anywhere, which is precisely the case a
literal-string grep would miss and this comparator does not:

```
=== C5 forced-failure demo: the ACTUAL historical bug shape reproduced (counts.all renamed to counts.total in a scratch copy) ===
### C5 — MemorySurface reads no field routes/memory.ts does not emit ###
  emitted (routes/memory.ts -> noteCounts): all, fact, note, person, pref, project, rule
  accessed (MemorySurface.tsx): all, fact, note, person, pref, project, rule, total
  self-test (bogus field __bogusField99__ must be caught): selfTestOk=true
FAIL — C5 — MemorySurface.tsx reads field(s) routes/memory.ts does not emit: total
```

Note the self-test line: it runs on **every** invocation of C5 (real or demo, PASS or FAIL) and
independently re-proves the comparator can detect a fabricated bogus field
(`counts.__bogusField99__`) before the real comparison's own PASS/FAIL is trusted. This is the
"negative control in the script's own self-test section" the brief asks for — not a one-off run, a
standing part of every C5 execution.

Passing shape is the real run in §1: `emitted` and `accessed` are the identical seven-field set
(`all, fact, note, person, pref, project, rule`), `violations` is empty, `selfTestOk=true`.

## 3. Live checkout untouched, confirmed after all demos

```
$ git -C /opt/forge-ai-os status --porcelain
$ echo "(nothing above — still clean, still 9c3f63a, confirmed after every demo in §2)"
$ git -C /opt/forge-ai-os rev-parse --short HEAD
9c3f63a
```

## 4. Dependencies, typecheck and test — verbatim

`NODE_ENV=production` is exported in this runtime; every install below used `--prod=false` to avoid
the silent devDependency prune described in [[pnpm-prod-prune-reads-as-success]] (`tsc`/`tsx` are
devDependencies — a bare `--frozen-lockfile` here would exit 0, print "Already up to date", and
remove them). `pnpm`, never `npm`, throughout.

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 742ms using pnpm v9.15.9
$ ls -l node_modules/.bin/tsc && node_modules/.bin/tsc --version
-rwxr-xr-x 1 root root 1488 Aug 19 22:42 node_modules/.bin/tsc
Version 5.9.3
```

```
$ cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 954ms using pnpm v9.15.9
```

```
$ cd ../forge-control && npx tsc --noEmit
$ echo "exit=$?"
exit=0
```

(No output — a clean `tsc --noEmit` prints nothing. Confirmed by explicit exit-code capture, not by
absence of visible errors alone.)

```
$ pnpm test
...
1..258
# tests 1293
# suites 239
# pass 1293
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5645.587687
$ echo "exit=$?"
exit=0
```

Full TAP transcript (258 suites, 1293 tests) captured verbatim during this run; only the closing
summary is reproduced here for length — every one of the 1293 tests reports `ok`, none `not ok`.

```
$ cd ../forge-control-web && npx tsc --noEmit
$ echo "exit=$?"
exit=0
```

(No output — clean, confirmed the same way as `forge-control`'s typecheck above.)

## 5. Declared write-set

`scripts/checks/preflight-deploy.sh`, `docs/plan/artifacts/os-usable-for-work/phase7/preflight-evidence.md`
— nothing else. Every demo artefact above (`preflight-cN-demo.sh` copies, scratch git repos, fixture
JSON files) lives under `/tmp/preflight-demo/` and was never committed.
