# Phase 4A — workstream worktrees: what was verified, and the price of isolation

Round 221. Requirements discharged: **R32** (`provisionWorkstream`, idempotent
and race-safe), **R33** (branch naming), **R34** (sibling directories and the
cleanliness gate), **R35** (`removeWorkspace` tears down every workstream),
**R38**'s proof obligation (a real merge conflict resolves nothing), and
**R39**'s provisioning-side refusal.

Files written by this round: `forge-control/src/lib/workspace.ts`,
`scripts/checks/check-workstream-e2e.sh`, and this document. Phase 4B owns
`project-reconcile.ts`, `db/projects.ts`, `project-tick.ts`, `task-graph.ts` and
the reconcile tests and was running concurrently in the same worktree; none of
them is touched here.

---

## 1. Provisioning — the transcripts

### 1.1 R33, reproduced rather than taken on trust

The brief asserts git refuses the slash form. Verified independently in a
throwaway repository under `/tmp` on **2026-08-17**, `git version 2.43.0`, this
host:

```
$ git init -q x && cd x && git commit -q --allow-empty -m x

$ git branch project/abc123
  exit=0

$ git branch project/abc123/ui
fatal: cannot lock ref 'refs/heads/project/abc123/ui': 'refs/heads/project/abc123' exists; cannot create 'refs/heads/project/abc123/ui'
  exit=128

$ git branch project/abc123-ui
  exit=0

$ git branch --list
* master
  project/abc123
  project/abc123-ui
```

This matches `01-requirements.md` R33 and `02-architecture.md` §4.1 exactly. The
constraint is not a convention that could be revisited by preference: refs are
files in a directory tree, so `refs/heads/project/abc123` and
`refs/heads/project/abc123/ui` are a file and a directory at the same path.

**It is asserted on every run**, not only here — `check-workstream-e2e.sh`
section 1 reproduces it, so the day a future git version changes this behaviour
the harness says so rather than the design quietly resting on a stale finding.

### 1.2 The mapping as implemented (R33, R34)

| workstream | branch | directory |
|---|---|---|
| `main` | `project/<id8>` — **the existing branch, unchanged** | `${PROJECT_WORKTREE_ROOT}/<project-id>` — **the existing directory, unchanged** |
| `<ws>` | `project/<id8>-<ws>` | `${PROJECT_WORKTREE_ROOT}/<project-id>--<ws>` |

Double hyphen in the directory because a project id contains single hyphens.

`provisionWorkstream(p, 'main')` **delegates to `provisionWorkspace(p)`** rather
than recomputing the same two strings. That is the difference between the
passthrough being true by construction and being true because two code paths
agree today. It is the single most important compatibility property in this
phase — no live project changes its branch or its directory when this lands, and
it is why the deploy is safe — so it is asserted directly (e2e 4.3, 4.4).

### 1.3 R34 — sibling, and the cleanliness gate stays quiet

`${PROJECT_WORKTREE_ROOT}/<project-id>/<ws>` would put a worktree *inside* the
main worktree, where `git status --porcelain` reports it as untracked content.
That output is the literal input to `REVIEWER_LIVE_CHECK` in `project-tick.ts`
and to the deploy task's pre-merge check, and a gate that cries wolf trains
reviewers to ignore it.

Asserted three ways, because "it is a sibling" and "the gate is quiet" are
different claims: the returned directory uses the `--` form (e2e 5.2), its
parent equals main's parent (5.3), it is *not* under the main directory (5.4),
and `git status --porcelain` in the main worktree is **empty** with a second
workstream present (6.1).

The nested layout was also confirmed to be detectable rather than assumed —
sabotaging `workstreamDir()` to emit `${mainDir}/${workstream}` makes the
harness fail at 5.2 (control B, §3.2 below).

### 1.4 R39's constant — a finding about import direction

R39's amendment (`01-requirements.md` §D) puts `PROJECT_MAX_WORKSTREAMS` in
phase 3's `routes/projects.ts` and requires phase 4 to read **that** constant
"rather than re-reading the environment so the two refusals cannot disagree
about the limit". Phase 3 had landed it before this round ran, correctly, with a
refuse-to-boot guard on a malformed override.

A **static** `import` of it from `lib/workspace.ts` is not available, and the
reason is measured rather than aesthetic. Importing `routes/projects.ts`
constructs **three pg Pools against `content_forge`** at module scope:

```
$ env -u DATABASE_URL npx tsx probe-cycle.mts     # pg.Pool counted by a monkeypatched constructor
pg Pools constructed by importing routes/projects.ts: 3
  -> postgresql://postgres:***@127.0.0.1:5432/content_forge
  -> postgresql://postgres:***@127.0.0.1:5432/content_forge
  -> postgresql://postgres:***@127.0.0.1:5432/content_forge
```

`lib/project-tick.test.ts` **value-imports** `lib/workspace.ts` for
`liveCheckoutPath()` while type-importing `db/projects.ts` — deliberately, so
that `pnpm test` never opens a pool. A static import here would put all three
pools into the unit-test process and break the standing rule that tests never
touch a database.

**Resolution taken:** a dynamic `import()` behind a private `maxWorkstreams()`
accessor. The static graph of `workspace.ts` stays a leaf (`node:fs`,
`./exec.ts`, `./task-graph.ts` — all pure), the constant keeps exactly one
definition, and the module is cached after the first non-`main` provisioning.

**Reported to the manager chat as a follow-up, not fixed here:** the clean end
state is for the constant to live in `lib/task-graph.ts`, the leaf both layers
already import statically and which already owns the other workstream-shaped
rule (`validateWorkstream()`, R28). `04-phases.md` §10 shares `task-graph.ts`
between phases 3 and 4, and phase 4B was editing it concurrently, so moving it
was not this round's to take.

### 1.5 R32's race, R35's teardown, R28's call site

- **Race (R32).** Two OS processes, started with `&` and joined with `wait`, ask
  for the same workstream at the same moment — the 2026-08-05 failure
  (`fatal: a branch named 'project/7d8d5a55' already exists`) reproduced
  deliberately. Both succeed, both return the same directory and branch, and
  exactly one worktree exists afterwards (e2e 8.1–8.5). The three moves that
  make losing the race harmless are `provisionWorkspace`'s, reused verbatim:
  `lookupWorktree()` first, adopt an existing branch instead of `-b`-ing it, and
  prune-then-recheck before throwing.
  8.3 alone would pass if *both* racers failed and agreed on the empty string,
  so 8.5 asserts the agreed answer is the right one.
- **Recovery.** The workstream directory is deleted with `rm -rf` and
  re-provisioned, the way `project-tick.ts`'s `wsMissing` branch recovers the
  main worktree today (e2e 9.1–9.3).
- **Teardown (R35).** `removeWorkspace` enumerates the project's worktrees from
  `git worktree list --porcelain` by directory prefix and removes every one.
  The prefix match is `=== dir` or `startsWith(dir + "--")` and never a bare
  `startsWith(dir)`, because `<root>/<id>` is a prefix of `<root>/<id>--ui`.
  Both existing properties are kept: best-effort and never throws, and a
  `scratch` repo is still never auto-deleted. Four worktrees existed before the
  call and none remained after (e2e 14.1–14.5); 14.5 asserts the count was four
  so that a removal with nothing to do cannot pass as a removal that worked.
- **Validation (R28's call site).** `run()` in `lib/exec.ts` executes a **shell
  string**, so the workstream name is interpolated straight into
  `git worktree add`. `validateWorkstream()` from `lib/task-graph.ts` had landed
  and is called rather than re-spelled. A name of the form `ui; touch <canary>`
  is refused, the refusal names `validateWorkstream`, and the canary does not
  exist afterwards (e2e 10.1–10.3).

---

## 2. The honest price of isolation

### 2.1 The failure this buys off

Two runs of project `operator-visibility` on **2026-08-17** died on what looked
like a corrupt bundle:

- **r1353** — `next build` printed `Compiled successfully`, then threw
  `SyntaxError: Unexpected end of JSON input`.
- **r1357** — two builds died on `ENOENT` for `pages-manifest.json` and
  `_not-found/page.js.nft.json`, with `ps` showing a sibling task building
  against the same `.next`.

Both pairs of tasks had **entirely disjoint source write-sets**. They collided
on shared build output. The failure mode is the worst kind available: it does
not look like contention, it looks like a corrupt bundle, so the natural
response is to hunt in code that just compiled fine — and it is
non-deterministic, so a re-run "fixes" it and the real cause is never found.

### 2.2 Method

All numbers taken on this box, 2026-08-17, pnpm 9.15.9, warm store
(`/root/.local/share/pnpm/store/v3`, 7.7 GB), disk `/dev/md2` with 277 GB free.
Each install ran in a **fresh empty directory** holding only `package.json` and
`pnpm-lock.yaml` copied from this worktree — which is exactly what a freshly
added worktree is, since `node_modules` is gitignored and therefore absent from
a new checkout.

Two sizes are reported for every install and they differ by a factor of forty:

- **apparent** — `du -sh node_modules`.
- **actual disk** — `df --output=used` before and after. pnpm hardlinks from its
  content-addressable store, so `du` counts blocks the store already owns. A
  file sampled from the tree carried `links=6`.

Quoting only the apparent number would overstate the cost by ~40×, which is
precisely how a cost objection gets manufactured.

### 2.3 Option (a) — a real per-workstream `node_modules`

```
forge-control      NODE_ENV=production pnpm install --frozen-lockfile --prod=false
                   0.98 s     58 MB apparent      34 MB actual disk   (postinstall scripts ON)

forge-control-web  NODE_ENV=production pnpm install --frozen-lockfile --prod=false
                   1.35 s    919 MB apparent      23 MB actual disk

per ai-os workstream, both packages:  ~2.4 s, ~57 MB actual
at R39's cap of six workstreams:      ~15 s, ~340 MB actual, against 277 GB free
```

**Round 101's constraint reproduced, and it is worse than a footnote.** The
executor runs with `NODE_ENV=production` and `run()` inherits its environment.
Without `--prod=false`:

```
$ NODE_ENV=production pnpm install --frozen-lockfile
devDependencies: skipped because NODE_ENV is set to production
Done in 1.3s using pnpm v9.15.9
exit=0
$ ls -d node_modules/typescript
ls: cannot access 'node_modules/typescript': No such file or directory
```

`tsx` and `typescript` are silently absent **and the install exits 0**. Every
agent in that worktree would then fail to run a single test for a reason that
looks nothing like the cause. `--prod=false` is therefore not a tuning flag, and
the reason is recorded at the call site in `ensureNodeModules()`.

### 2.4 Option (b) — a symlinked shared `node_modules`

This is r1357's own mitigation
(`git worktree add --detach <tmp> && ln -s <shared>/node_modules <tmp>/node_modules`),
and the phase planner's stated lean.

```
ln -s <shared>/node_modules <ws>/node_modules
                   0.001 s     0 bytes
```

Cheaper by every measure. Its failure modes, named as the brief requires:

1. **The declared one — package.json divergence.** If one workstream adds a
   dependency, the shared store is wrong for every other workstream
   simultaneously. Adding a dependency is ordinary work, not a corner case.
2. **Worse: `pnpm install` inside a workstream writes *through* the symlink**,
   mutating the directory every other workstream is building against, while they
   are building. This is the same class of defect as the `.next` collision — a
   shared mutable build directory — with a wider blast radius.
3. **Node resolves through the symlink to the real path.** Measured, not
   assumed: a package loaded from a symlinked tree reports the **shared**
   directory as its `__dirname`.

   ```
   $ cd /tmp/.../ws-ui                     # node_modules is a symlink to .../shared/node_modules
   $ node -e 'console.log(require("probepkg").where)'
   /tmp/.../shared/node_modules/probepkg
   ```

   So a tool that locates its project root from a module's location lands in the
   shared checkout, which is the exact isolation the worktree was created to
   provide.

### 2.5 D1 — the decision

Written in the style of `02-architecture.md` §9's E-entries, so a later round
argues with it rather than rediscovering the question.

**D1 — each workstream worktree gets its own real `node_modules`, installed at
provisioning time with `--prod=false`. The planner's lean toward the symlink is
overruled, by the number.**

The lean was reasonable and rested on one premise: that a real install is
expensive enough to need buying off. It is not. **2.4 seconds and 57 MB per
workstream**, ~15 s and ~340 MB at R39's cap, is not a price worth paying
anything for — and what the symlink buys is a shared mutable directory, which is
the disease this phase exists to cure. Trading correctness for two seconds is a
bad trade in any round; it is an absurd one here, where the failure it
reintroduces is non-deterministic and misdiagnoses itself.

The apparent-vs-actual distinction is what settles it. Against `du`'s 919 MB the
symlink looks obviously right; against `df`'s 23 MB it looks like complexity
bought for nothing.

Implemented in `ensureNodeModules()`, which is called on the provisioning path
**and on the idempotent path**. That is deliberate: a worktree can exist while
its `node_modules` do not — the install threw last time, or the worktree predates
this code — and a bare early return would cement that half-provisioned state. A
failed install throws with the directory and stderr rather than leaving a
worktree that looks provisioned and cannot build (NF1).

**Scope, stated so it is not overread:** `main` is untouched. It does not
install, because it is not a new workstream and its worktree is provisioned
exactly as it was before phase 4. Agents in `main` install by hand as they
always have.

### 2.6 Two things confirmed rather than assumed

**(i) `.next/` and `node_modules/` are gitignored**, so neither appears in R34's
`git status --porcelain` gate. Not inferred from a root `.gitignore` — the root
`.gitignore` of this repo contains neither pattern. They are ignored by
per-package files, which are tracked and therefore present in every worktree:

```
$ git check-ignore -v forge-control-web/.next/PROBE forge-control/node_modules/PROBE forge-control-web/node_modules/x
forge-control-web/.gitignore:2:.next        forge-control-web/.next/PROBE
forge-control/.gitignore:1:node_modules     forge-control/node_modules/PROBE
forge-control-web/.gitignore:1:node_modules forge-control-web/node_modules/x

$ git status --porcelain          # with .next/ and node_modules/ present
                                  # (empty)
```

The e2e harness asserts the same property end to end: its throwaway repo carries
a `node_modules` ignore rule, and the `ui` worktree's porcelain is empty **after**
a real install ran in it (e2e 6.2).

**(ii) Nothing outside the worktree re-shares build output.** Checked, because a
cache path outside the checkout would defeat directory isolation entirely and is
the kind of thing phase 8 should not be the one to discover:

- `forge-control-web/next.config.mjs` sets no `distDir` and no `cacheDir`; its
  `webpack()` hook only adds an `@` alias. `.next` is therefore relative to the
  checkout.
- No `turbo.json` anywhere in the repo, and no `turbo` key in
  `forge-control-web/package.json`.
- No `NEXT_*` or `TURBO_*` environment variables in the executor's environment,
  and none in either `ecosystem.config.cjs`.

**No defect found.** The one shared thing that remains is pnpm's global
content-addressable store, and that is correct: it is append-only and
content-addressed, so two workstreams reading it cannot produce divergent trees.

### 2.7 The bound this places on write-set declaration

Worth stating plainly, because a reader who misses it will eventually
reintroduce a shared build directory for speed and reintroduce r1353 with it:

> **Declared write-sets prevent SOURCE conflicts only.** Nobody declares their
> compiler's scratch space. `.next/`, `dist/`, `*.tsbuildinfo` and
> `node_modules/.cache` appear in no `write_set` and never will, because they are
> not written by the agent — they are written by the toolchain the agent invoked.
> Only real directory isolation prevents ARTIFACT conflicts.

Two corollaries follow, and the second is a **live limitation of this phase**:

1. The contention belt and the write-set audit (R57) are necessary and not
   sufficient. They are the defence for source files; the worktree is the
   defence for everything else.
2. **Workstream isolation fixes artifact collisions BETWEEN workstreams. It does
   not fix them WITHIN one.** Two tasks of the same workstream with disjoint
   write-sets are permitted to run concurrently by the contention belt, and they
   share a directory and therefore a `.next` — which is exactly the r1353/r1357
   configuration. This phase does not close that, and does not claim to. The
   options, for whoever picks it up: serialise tasks within a workstream, or
   give each *task* an isolated build directory. Naming it here so it is a known
   open edge rather than a surprise.

---

## 3. The harness

### 3.1 What it is, and what it refuses to do

`scripts/checks/check-workstream-e2e.sh` — bash, `set -euo pipefail`, **61
assertions as of round 225** (53 when phase 4A wrote it; §6 below records the
eight added for NF1 on the recovery path, and every transcript in §3 is the
53-assertion run at phase 4A's sha), each a separately named PASS/FAIL line,
exits non-zero on any failure. It operates entirely inside one `mktemp -d`: `AI_OS_REPO_DIR` and
`PROJECT_WORKTREE_ROOT` are overridden to point inside it, so the code under
test cannot reach `/opt/forge-ai-os`, this worktree, or the real worktree root.
It needs no database and issues no SQL.

It **prints its own build identity first** — and the authoritative line is
`sha256sum` of `forge-control/src/lib/workspace.ts`, not `git rev-parse HEAD`.
That distinction is the point: this round's work was uncommitted while it was
being tested, so a commit sha would have named bytes that were not the ones
running. It also prints whether the subject is dirty relative to HEAD, and the
driver reports the absolute path it actually imported, so the transcript records
the file that was loaded and not merely the one that was hashed.

`provisionWorkstream` is driven through the real exported function by a
`tsx` driver the script writes into its temp directory. Its logic is never
reimplemented in bash.

### 3.2 What would make it report a pass wrongly — with the controls run

Not answered by reasoning alone; each mechanism was made to happen.

**"It tested a stale build."** The identity line is content-addressed, so the
question is whether it actually tracks the bytes. Sabotaging `workstreamDir()`
to emit the nested form changed the printed sha256 from
`b5da526f3a46…` to `e04154c0683c…` and the run failed:

```
  subject sha256     : e04154c0683cc121a07d7ea5a27656691098822b6ace30bb20ed0a14044661d2   <-- authoritative
  FAIL 5.2 ui dir uses the double hyphen   expected [...--ui] got [.../ui]
check-workstream-e2e.sh FAILED after 12 assertions
exit=1
```

Restoring the file returned the hash to `b5da526f3a46…` — the restore was
verified by hash rather than assumed. A stale build cannot pass, because the
harness resolves its subject from its own location and the sha names that file.

**"An assertion silently did not run."** `EXPECTED_ASSERTIONS` is declared and
enforced **exactly** — too few means probes were skipped, too many means an
assertion was added without updating the count, and both fail. Two controls:

```
CONTROL A — declared 54, actual 53
check-workstream-e2e.sh FAILED: ran 53 assertions, expected exactly 54.
exit=1

CONTROL C — assertion 13.3 deleted from the file
check-workstream-e2e.sh FAILED: ran 52 assertions, expected exactly 53.
exit=1
```

A sweep whose probes miss exits non-zero rather than certifying itself.

**Three more, guarded by construction and recorded in the script's header:** the
driver prints a JSON object on every path *including its own failures*, so a
subject that never ran cannot leave `assert_has` comparing empty strings; R39's
limit is read from the code rather than hard-coded, so the cap gate is passable
on a box that overrides it; and the merge case asserts all four of non-zero
exit, the filename verbatim, markers left in the file, and HEAD unmoved, so a
merge that failed for an unrelated reason cannot pass as a conflict.

One instrument defect was found and fixed during this round: bash runs an `ERR`
trap even while `errexit` is off, so the intentionally-failing probes were
printing `ABORTED — NOT a pass` into the transcript of a passing run. Rewritten
as `&& rc=0 || rc=$?` lists. A harness whose own output says it aborted while it
reports success is an instrument nobody will read twice.

### 3.3 R38 — the assertion the red team will attack

A real conflict, driven end to end: divergent edits to one file committed on
`project/<id8>` and on `project/<id8>-<ws>`, then merged in the main worktree.

```
13. a real merge conflict resolves NOTHING (R38)
  ok   13.1 the merge exits non-zero                          exit 1
  ok   13.2 the output names the conflicting file             contains: shared.txt
  ok   13.3 the file still holds conflict markers             contains: <<<<<<<
  ok   13.4 no merge commit was created (HEAD unmoved)        = d7e682a8849fc6283f934daf5c58326840a16aab
  ok   13.5 the merge stopped mid-flight, unresolved          MERGE_HEAD present
      transcript:
        Auto-merging shared.txt
        CONFLICT (content): Merge conflict in shared.txt
        Automatic merge failed; fix conflicts and then commit the result.
```

Nothing in `lib/workspace.ts` merges anything. There is no auto-merge path in
this round's code, which is R38 and N3: auto-merge resolves conflicts in favour
of whoever finishes last, which is silent clobbering wearing a merge commit. The
gain of this design is not extra concurrency — it is that **contention becomes a
git conflict inside a named task instead of two agents overwriting each other in
one directory.**

### 3.4 Full transcript

```
check-workstream-e2e.sh — engine-task-graph phase 4A (R32–R35, R38, R39)

BUILD IDENTITY OF THE CODE UNDER TEST
  worktree path      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 7efa36b660964c3b330cf98471961d6db0227152
  git branch         : project/8c591d6c
  subject            : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/src/lib/workspace.ts
  subject sha256     : b5da526f3a46254552311e3777a3be73efad812a380494d1b3a1777dfc102a26   <-- authoritative
  subject mtime      : 2026-08-17 22:10:45 +0200
  workspace.ts dirty : [ M forge-control/src/lib/workspace.ts]
  tsx                : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/forge-control/node_modules/.bin/tsx
  node               : v22.22.2
  git                : git version 2.43.0
  pnpm               : 9.15.9

1. R33 — git refuses project/<id8>/<ws> beside project/<id8>
  ok   1.1 slash form refused                                 exit 128
  ok   1.2 refusal names the ref conflict                     contains: cannot lock ref
  ok   1.3 hyphen form accepted                               = 0
      transcript: fatal: cannot lock ref 'refs/heads/project/abc123/ui': 'refs/heads/project/abc123' exists; cannot create 'refs/heads/project/abc123/ui'

2. subject identity and the resolved R39 limit
  ok   2.1 driver imported the hashed file                    = .../forge-control/src/lib/workspace.ts
  ok   2.2 unset PROJECT_MAX_WORKSTREAMS defaults to 6        = 6

3. a workstream cannot precede its project branch
  ok   3.1 refused with no project branch                     exit 1
  ok   3.2 error names the missing branch                     contains: project/99999999

4. workstream 'main' is a passthrough (R32, R33, R34)
  ok   4.1 provisionWorkspace dir                             = <root>/11111111-2222-4333-8444-555555555555
  ok   4.2 provisionWorkspace branch                          = project/11111111
  ok   4.3 provisionWorkstream(main) same dir                 = <root>/11111111-2222-4333-8444-555555555555
  ok   4.4 provisionWorkstream(main) same branch              = project/11111111

5. workstream 'ui' — branch, directory, sibling layout (R33, R34)
  ok   5.1 ui branch is the hyphen form                       = project/11111111-ui
  ok   5.2 ui dir uses the double hyphen                      = <root>/11111111-2222-4333-8444-555555555555--ui
  ok   5.3 ui dir is a SIBLING of main                        = <root>
  ok   5.4 ui dir is NOT nested inside main                   not under <root>/11111111-2222-4333-8444-555555555555
  ok   5.5 git registers the ui worktree                      contains: worktree <root>/...--ui

6. the cleanliness gate stays quiet with a second workstream present (R34)
  ok   6.1 main worktree porcelain is EMPTY                   =
  ok   6.2 ui worktree porcelain is EMPTY (node_modules ignored) =

7. idempotence (R32)
  ok   7.1 second call returns the same dir                   = <root>/...--ui
  ok   7.2 second call returns the same branch                = project/11111111-ui
  ok   7.3 second call created no new worktree                = 3

8. two concurrent provisionWorkstream calls for the same workstream (R32)
  ok   8.1 racer A succeeded                                  = 0
  ok   8.2 racer B succeeded                                  = 0
  ok   8.3 both racers agree on the answer                    = <root>/...--race|project/11111111-race
  ok   8.4 exactly one 'race' worktree exists                 = 1
  ok   8.5 the agreed answer is the expected dir and branch   = <root>/...--race|project/11111111-race
      A: {"workspace_dir":"<root>/...--race","work_branch":"project/11111111-race"}
      B: {"workspace_dir":"<root>/...--race","work_branch":"project/11111111-race"}

9. a workstream worktree deleted from disk is re-provisioned
  ok   9.1 re-provision returns the same dir                  = <root>/...--ui
  ok   9.2 re-provision returns the same branch               = project/11111111-ui
  ok   9.3 the directory is a live worktree again             .git present

10. an injection-shaped workstream name is refused before any shell runs (R28 call site)
  ok   10.1 injection-shaped name refused                     exit 1
  ok   10.2 refusal comes from validateWorkstream             contains: validateWorkstream
  ok   10.3 no shell side effect                              canary absent

11. the workstream worktree owns its node_modules, and does not share one
  ok   11.1 ui worktree has its own node_modules              <root>/...--ui/app/node_modules
  ok   11.2 it is a real directory, not a symlink             not a symlink
  ok   11.3 its realpath is inside the ui worktree            = <root>/...--ui/app/node_modules
  ok   11.4 it is not the main worktree's                     != <root>/.../app/node_modules

12. PROJECT_MAX_WORKSTREAMS refuses a new workstream past the cap (R39)
      distinct workstream worktrees before: 3 (main, ui, race); cap for this section: 4
  ok   12.1 the workstream AT the cap is allowed              = 0
  ok   12.2 the workstream PAST the cap is refused            exit 1
  ok   12.3 the refusal names the count                       contains: 4 workstream worktree(s) already exist
  ok   12.4 the refusal names the limit                       contains: PROJECT_MAX_WORKSTREAMS=4
  ok   12.5 the refusal names the refused stream              contains: "docs"
  ok   12.6 the refused worktree was NOT created              absent
  ok   12.7 an EXISTING workstream is still allowed at the cap = 0
      refusal: refusing to provision workstream "docs" for project 11111111-...: 4 workstream
               worktree(s) already exist (limit PROJECT_MAX_WORKSTREAMS=4): api, main, race, ui.
               A full checkout is not free; raise PROJECT_MAX_WORKSTREAMS or integrate and
               retire a workstream first (R39).

13. a real merge conflict resolves NOTHING (R38)
  ok   13.1 the merge exits non-zero                          exit 1
  ok   13.2 the output names the conflicting file             contains: shared.txt
  ok   13.3 the file still holds conflict markers             contains: <<<<<<<
  ok   13.4 no merge commit was created (HEAD unmoved)        = d7e682a8849fc6283f934daf5c58326840a16aab
  ok   13.5 the merge stopped mid-flight, unresolved          MERGE_HEAD present
      transcript:
        Auto-merging shared.txt
        CONFLICT (content): Merge conflict in shared.txt
        Automatic merge failed; fix conflicts and then commit the result.

14. removeWorkspace removes every workstream worktree (R35)
      project worktrees before removal: 4
  ok   14.1 removeWorkspace exited cleanly (never throws)     = 0
  ok   14.2 the MAIN worktree is gone                         absent
  ok   14.3 the 'ui' worktree is gone                         absent
  ok   14.4 no project worktree remains registered            = 0
  ok   14.5 the removal really had work to do                 = 4

check-workstream-e2e.sh PASSED — 53/53 assertions ran and passed.
```

Temporary directory paths are elided to `<root>` for readability; the raw run
prints absolute `mktemp -d` paths that differ on every invocation.

---

## 4. What this round did not do

- **R36, R37, R38's task creation, R40–R46** belong to phase 4B and phase 5.
  Nothing here writes `project-tick.ts`, `project-reconcile.ts`,
  `db/projects.ts` or `task-graph.ts`.
- **R39's user-facing `400`** stays phase 3's, in `routes/projects.ts`. This
  round adds no second, differently-worded refusal at the API; it adds the
  provisioning-side refusal R39's amendment assigns to phase 4, reading phase
  3's constant.
- **The phase-3 TOCTOU on that `400`** (recorded round 215) is unchanged. The
  provisioning refusal here is defence-in-depth against SERIAL excess.
  ~~but the worktree that would actually consume the disk cannot be created
  without passing `provisionWorkstream`'s check~~ — **RETRACTED round 225.**
  That sentence was measured false: round 224's red team and gating reviewer
  each ran two concurrent `provisionWorkstream()` calls for two different new
  workstreams at a filled cap and both returned 0, one over cap. The
  provisioning check reads the worktree list and then adds, with no lock, so it
  carries the identical TOCTOU. **The phase-4 red team's decision, which this
  bullet correctly left to it, was taken in round 224: ACCEPT the race in both
  places, no transactional count** — the slip is clean, the spawn loop
  serialises it in the deployed topology, and the priced cost is one checkout of
  disk. See R39 in `01-requirements.md` §D and `provisionWorkstream`'s own R39
  comment block, both amended in the same commit as this line.
- **Scratch-repo workstreams** are supported — `projectRefs()` resolves the
  repo, project branch and main directory per repo type — but a scratch
  project's workstream worktrees are **not** removed by `removeWorkspace`,
  because the existing rule that a scratch repo is never auto-deleted is left
  exactly as it was. They live inside the scratch repo's own worktree registry
  and `git worktree list` shows them to whoever removes it by hand.
- **Live verification** belongs to phase 8. Nothing here touched
  `/opt/forge-ai-os`, a live endpoint, a live service or the live database.

---

# Phase 4D — the R69 straddle, ruled by experiment

Round 223, the last phase-4 builder. **One decision, decided by measurement.**
Requirement touched: **R69** (narrowed, not deleted). Escalation recorded:
**E4** in `02-architecture.md` §9.3. Failure mode tabled: **F14**. Files written
by this round: `scripts/checks/check-r69-straddle.sh` (new),
`docs/plan/engine-task-graph/02-architecture.md` (§3.2, §3.2.1, §3.2.2 new, §6's
F14 row, §9's heading, §9.3 new), `docs/plan/engine-task-graph/01-requirements.md`
(R6's matching clause, R69), `forge-control/src/db/projects.ts` (**one
doc-comment clause — no statement changed**), and this section.

Phase 6's round-223 builder was committing into the same worktree while this ran
(`9b04039`, `6426893`); nothing above is touched by it and nothing here touches
`forge-control/src/routes/` or the web types.

## 5. The R69 straddle experiment

### 5.1 The question, and why it could not be settled on paper

R69 holds a frozen row — one whose closure `0040_task_graph.sql` computed at
migration time — behind LEGACY rows only, rows carrying `depends_on IS NULL`.
R42 (round 221) gives a fix chain created by the **new** engine real graph
fields. So a row the new engine inserts below a frozen row is invisible to R69's
term. `02-architecture.md` §3.2 said a straddling project *"finishes under its
original semantics"*, which is wider than that.

The root is not a bug: `depends_on` is immutable by design (§2.3, §2.3.2), and
that immutability is exactly what lets `round` be computed once and never move.
A fix chain created after a row was frozen **cannot** be added to that row's
dependencies. The edge cannot exist, so the graph branch cannot see it.

Two options, both defensible — A, widen R69's predicate for frozen rows only;
B, narrow §3.2 and state the blast radius. The operator's instruction:

> *"treat it as a hypothesis to test, not a ruling. Overrule it with evidence and
> I will endorse the overrule."*
> *"Prove your choice the way phase 1 proved R69 — fill the stubs both ways in a
> scratch repo and show what diverges — rather than reasoning about it on paper."*

### 5.2 The instrument

`scripts/checks/check-r69-straddle.sh`. **No database**: it is a tick simulation
over pure functions and the committed R9 fixture, so it needs neither
`$DATABASE_URL` nor `$SCRATCH_DATABASE_URL`, and probe `0e` says so from inside
the driver rather than leaving it to be believed.

**No arm re-implements the rule under test.** `NARROW` is `readyRule()` plus the
SHIPPED `graphReady()` — the same composition the replay harness's `GRAPH_RULE`
uses. Every widened arm is `wide(gate)`, which calls `NARROW` first and can only
ever take readiness away. "The narrow arm ran the shipped predicate" is therefore
structural, not a claim.

Three fixtures:

| | what it is | why it is here |
|---|---|---|
| **S1** | the 131-row R9 fixture, every row frozen (closure over the migration-time snapshot), plus a post-restart fix chain at **1307/1308** carrying real `depends_on` | a straddle with **no gap row** — the case R69 was never designed for |
| **S2** | S1 **plus one row**: `…04d3`, status `done`, `depends_on NULL`, round 1306 | a straddle **with** a gap row. Under R69 that row is inert — R69 only refuses on a legacy row that is *not* `done` |
| **S3** | 1 planner, 1 long reviewer, 7 unrelated builders numbered above it | `00-vision.md` §2's measured motivating case. It carries the **price** of each option |

Six arms: `LEGACY`, `NARROW`, and four widenings — gated on the NULL sentinel,
on `isClosureShaped()`, on a `created_at` horizon, and ungated.

**Reachability is derived, not assumed.** The chain hangs off the fixture's
highest `done` reviewer (round 1306, derived exactly as the replay harness's case
(f) derives it), and the instrument refuses if the pair does not land strictly
below every non-`done` row. Why a post-restart consolidation is *likely* rather
than merely possible: `safe-restart.sh` waits for a **quiet** fleet, and quiet
means the last run has just finished — so the last group's consolidation is the
one guaranteed to land after the restart, under the new engine, with R42's
fields.

### 5.3 What would have made this experiment lie, and why it did not

Two were named in the brief. Both are answered by a counter, not by a paragraph.

**"Both arms of my experiment ran the same code because the widened predicate was
never actually reached."** Every widened arm counts three things and prints all
three, per arm per fixture: how many graph rows the widening was **evaluated**
on, how many times its gate **opened**, and how many times the term actually
**fired** — changed an answer from ready to not-ready. An arm asserted to be
silent must show `gate-open 0`; an arm asserted to close the divergence must show
`fired > 0`. On S1: `WIDE-SENTINEL` evaluated 52, gate-open **0**, fired 0 —
genuinely silent, and the probe fails if it is not. `WIDE-UNGATED` evaluated 76,
gate-open 76, fired **6** — genuinely different code, and the probe fails if it
is not.

**"My straddling fixture was not straddling — every row had real graph fields, so
the frozen branch never ran."** Probe `0b`: on S1, `graph-branch=133`,
`legacy-branch=0`, `frozen=131`, `post-restart=2`, and — the number that matters
— **8** frozen `pending` rows sit above the chain with a closure that cannot name
it, with `graphReady()` answering for **8/8** of them. Zero on any of those is a
refusal, not a footnote.

Three more the instrument guards that the brief did not name:

- **A transcription that drifted.** `simulate()` here is a transcription of the
  replay harness's tick loop. Probe `0a` re-derives the tick count the harness
  **pins at 14** for the base fixture under the legacy rule, and gets 14, with
  8 promotions.
- **A second definition of `isClosureShaped()`.** It is module-private in
  `lib/schedule-metrics.ts` and cannot be imported, so the driver transcribes it
  — and probe `0d` asserts the transcription's per-row count equals the SHIPPED
  `inputCensus().closureShapedRows` on **all three** fixtures (102/102, 102/102,
  2/2). Checked on every run, not at review time.
- **A sha naming the worktree rather than the build.** The header prints `git
  rev-parse HEAD`, the branch, the sha256 of all four files it exercises, and
  **which of them are dirty against that HEAD** — and it refuses outright to run
  inside `/opt/forge-ai-os`.

One gate was **amended where it is enforced** (standing rule 2) rather than
disclosed and worked around: `simulate()`'s tick cap is `2n + 2`, not the
harness's `n + 2`. A row settles the tick *after* it promotes, so a fully
serialized project needs two ticks per task — and the `WIDE-UNGATED` arm
serializes by construction, which is the cost this experiment exists to price. An
`n + 2` cap would make the instrument REFUSE the one arm it was built to measure.
The reasoning is inline at the constant. `2n + 2` is still a live guard: only a
rule that promotes nothing while something is in flight can exceed it.

Two stale pins in this script's own header were found and fixed before it was
committed — it claimed "FOUR PROMOTION ARMS" after a fifth widening was added,
and cited a probe `0c` that does not exist. Recorded because the standing rule
that produced them applies to the instrument as much as to the corpus.

### 5.4 The transcript

Run at `6426893`, with `check-r69-straddle.sh` itself untracked at the time of
the run and committed unchanged in this commit; the four sha256 values in the
header are what actually executed.

```
--- 1. the divergence R69 does not close --------------------------------------
  S1 — straddle, NO gap row — 131 frozen rows + a post-restart fix chain at 1307/1308
      LEGACY         ticks= 17 promoted= 10 widest-tick= 2
      NARROW         ticks= 14 promoted= 10 widest-tick= 2
      WIDE-SENTINEL  ticks= 14 promoted= 10 widest-tick= 2   widening: evaluated=52 gate-open=0 fired=0
      WIDE-CLOSURE   ticks= 14 promoted= 10 widest-tick= 2   widening: evaluated=52 gate-open=0 fired=0
      WIDE-HORIZON   ticks= 17 promoted= 10 widest-tick= 2   widening: evaluated=76 gate-open=72 fired=6
      WIDE-UNGATED   ticks= 17 promoted= 10 widest-tick= 2   widening: evaluated=76 gate-open=76 fired=6
  S2 — S1 + ONE already-done row carrying the NULL sentinel (inert under R69)
      LEGACY         ticks= 17 promoted= 10 widest-tick= 2
      NARROW         ticks= 14 promoted= 10 widest-tick= 2
      WIDE-SENTINEL  ticks= 17 promoted= 10 widest-tick= 2   widening: evaluated=76 gate-open=76 fired=6
      WIDE-CLOSURE   ticks= 14 promoted= 10 widest-tick= 2   widening: evaluated=52 gate-open=0 fired=0
      WIDE-HORIZON   ticks= 17 promoted= 10 widest-tick= 2   widening: evaluated=76 gate-open=72 fired=6
      WIDE-UNGATED   ticks= 17 promoted= 10 widest-tick= 2   widening: evaluated=76 gate-open=76 fired=6
  S3 — post-restart project — 1 planner, 1 long reviewer, 7 unrelated builders numbered above it
      LEGACY         ticks= 17 promoted=  8 widest-tick= 1
      NARROW         ticks=  3 promoted=  8 widest-tick= 8
      WIDE-SENTINEL  ticks=  3 promoted=  8 widest-tick= 8   widening: evaluated=8 gate-open=0 fired=0
      WIDE-CLOSURE   ticks=  3 promoted=  8 widest-tick= 8   widening: evaluated=8 gate-open=1 fired=0
      WIDE-HORIZON   ticks= 17 promoted=  8 widest-tick= 1   widening: evaluated=64 gate-open=64 fired=56
      WIDE-UNGATED   ticks= 17 promoted=  8 widest-tick= 1   widening: evaluated=64 gate-open=64 fired=56
  ok   1  S1: the SHIPPED engine (NARROW) diverges from today's engine on a straddling project
         first divergence, legacy vs narrow — tick 2: only-first []; only-second [511070c9, 608dbecb]
         legacy ticks=17, narrow ticks=14

--- 4. probe accounting --------------------------------------------------------
  registered 11   ran 11   passed 11   failed 0   never-ran 0
```

The full per-probe output is reproduced by running the script; the paragraphs
below quote the numbers that decided the question.

### 5.5 Finding 1 — the divergence is real, and it is F13's own divergence

Legacy takes **17 ticks**; the shipped engine takes **14**. First divergence on
**tick 2**, on **`511070c9…` and `608dbecb…`**.

Those are, to the id and to the tick, the two rows `02-architecture.md` §3.2.1
records for phase 1's closure-only measurement of F13 — *"case (f) diverging on
tick 2 — legacy promoted [], graph promoted [511070c9…, 608dbecb…]"*. **The
divergence R69 closed and the divergence it does not close are the same
divergence**, on the same two rows, on the same tick. Only the provenance of the
row doing the blocking differs: a NULL sentinel there, real graph fields here.

That is what makes this a genuine gap rather than a philosophical one, and it is
why it could not be left as *"phase 1 read it as intended DAG behaviour"*.

### 5.6 Finding 2 — option A's arithmetic is right

`WIDE-UNGATED` on S1: the widened term fired **6** times and the graph reproduced
today's schedule **exactly, tick for tick** (probe 2d). The operator's proposal
computes the right answer. Everything that follows is about its gate.

### 5.7 Finding 3 — option A has no gate, and this is where it was decided

*"While a row is frozen"* is not a predicate this schema can evaluate. The
migration records nothing that distinguishes a closure it wrote from a dependency
set a planner declared — `0040_task_graph.sql` adds three columns and sets
`depends_on`, and that is all. Four stand-ins exist. Each was built and measured.

**(a) Gate on the NULL sentinel — "this project contains a legacy row".** The
only gate expressible at zero cost, and it costs nothing on a post-restart
project (S3: gate-open **0**, schedule unchanged at 3 ticks / 8-wide). On S1 it
is **silent**: gate-open **0/52**. The reason is structural and worth stating
plainly — **0040's backfill overwrites the sentinel on every pre-existing row**,
so a straddle in which the old engine happened to insert nothing in the deploy
gap holds *no legacy row at all*.

**(b) The same gate, on S2.** S2 is S1 plus one row: `…04d3`, `done`,
`depends_on NULL`, scheduling-inert under R69. The gate opens 76 times, fires 6,
and the divergence **closes** — while `NARROW` on the same fixture still diverges
at tick 2 on the same two rows. So the same straddling project is scheduled
correctly or incorrectly according to whether an unrelated, already-finished row
happens to carry NULL. **That is not a predicate. It is a coincidence**, and
building a correctness property on it means the property holds when the old
engine was busy during the deploy window and lapses when it was idle.

**(c) Gate on `isClosureShaped()` — the corpus's own frozen-row detector.** The
closest thing to "while a row is frozen" that exists anywhere in this system;
round 215 added it precisely to recognise 0040's backfill signature. It **goes
blind exactly where it is needed**. It compares a row's closure against the
CURRENT row list, so a post-migration row at a lower round breaks the signature
of every frozen row above it:

| | closure-shaped, whole project | **of the 8 exposed rows** |
|---|---|---|
| before the post-restart chain exists | 131/131 | **8/8** |
| after it exists | 102/133 | **0/8** |

The 102 that survive are the rows *below* the chain, which need nothing. The
detector is sighted on every row the widening does not care about and blind on
every row it does. Fired **0** times.

**(d) Gate on a `created_at` horizon taken from the row's own closure.** The
cleverest gate the data can express, and it repairs (c)'s defect exactly: take
the newest `created_at` among the ids a row names, and ask whether it names every
lower-round row that existed *then*. A genuinely frozen row does by construction,
and every row it fails to name was created after the migration. No stored
timestamp is needed.

It is **right on the straddle**: S1 identical to legacy, tick for tick, fired 6.
And it is **ruinous everywhere else**. On S3 — where not one row is frozen and
not one carries the sentinel — it fires **56** times and takes the schedule from
**3 ticks / 8-wide to 17 ticks / 1-wide**, which is today's engine, number for
number. The reason is one sentence: *a builder created before its siblings names
every lower-round row that existed when it was created, because they had not been
created yet.* The gate cannot tell "my closure is complete because a migration
wrote it" from "my closure is complete because I was first".

**(e) No gate.** The same collapse: S3 goes 3 → 17 ticks, 8-wide → 1-wide,
identical to `LEGACY`. This is the measurement `00-vision.md` §2 exists to
delete — 255 minutes of wall clock for work that at a concurrency of 6 is about
45 — reintroduced by the mitigation.

### 5.8 The ruling — option B

Recorded as **E4** in `02-architecture.md` §9.3, in the register E1–E3 are
recorded in. §3.2's sentence is retired and R69's description narrowed **in the
same commit** (standing rule 4). Before narrowing, the sentence was grepped for
across the whole corpus and both source trees: it is asserted in **no gate
anywhere**, so nothing retires with it beyond R6's matching clause and one
over-wide sentence in `db/projects.ts`'s module preamble. The gates that touch
R69 — `03-quality.md` §3.2's phase-2 gate, `check-scheduler-sql.sh`, R18 case (f)
— all test the narrow term, which is **unchanged**.

**Why B is the right line and not a concession.** `depends_on IS NULL` does not
mean "old row" by accident. It means *created under the old semantics*. Holding a
frozen row behind such a row replays the rule that row was born under, which is
what R18's replica claim is about. Refusing to hold it behind a NEW-semantics row
is the graph doing its job: that row declared its dependencies, the frozen row is
not among them, and inventing an edge out of a round number is the exact
conflation this project exists to end. **R69's sentinel is the semantic boundary,
not an implementation detail that happens to sit near one.**

**The blast radius, stated so it cannot be discovered at 3am.** In a straddling
project, a row the new engine inserts at a lower round does not hold a frozen row
above it. A fix builder repairing round-1306 work may run beside a frozen builder
at 1352 that today's engine would have held. Both are `workstream = 'main'`, so
both are in one worktree; both carry `write_set = '{}'`, because the backfill
gives frozen rows an empty write-set, so R17's contention filter does not
separate them either. **R63 requires the deploy's own target (`8ea0cc08`) to have
no `running` and no `pending` task before anything happens**, so the project
§3.2.1 built its reachability argument on is drained at the moment the risk would
begin. What remains is any *other* project holding frozen `pending` rows that
later produces a lower-round insertion. Tabled as **F14** in §6, which is where a
reader looking for accepted risk will look.

### 5.9 What reopens it, priced

Option A becomes implementable the moment a frozen row is **marked** rather than
**inferred**: one more additive statement in 0040 —

```sql
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS graph_frozen boolean NOT NULL DEFAULT false;
-- …and the backfill UPDATE sets graph_frozen = true on the rows it writes.
```

after which the gate is `pt.graph_frozen`, every objection in §5.7 evaporates,
and §3.2's original sentence comes back. It is **cheap only while 0040 is
un-applied**, which is true until phase 8 runs `psql -f`, and impossible to do
honestly afterwards — a column added later cannot know which closures were
frozen.

It is a phase-1 change touching six files across three phases:
`db/migrations/0040_task_graph.sql`, `forge-control/src/db/projects.ts`,
`forge-control/src/lib/task-graph.ts` (the pure mirror `graphReady()`, which
`db/projects.ts`'s own preamble names as the definition the SQL mirrors — so the
SQL cannot be widened alone), `task-graph.test.ts`, `task-graph-replay.test.ts`
(a case (g) for the post-restart order), and `scripts/checks/check-scheduler-sql.sh`,
plus R3/R6/R69. **Round 223's write set covers none of it**, which is a second,
independent reason option A could not have been landed in this round even had it
won on the merits — and it is recorded here so the next round does not rediscover
it. It was reported to the manager chat as an explicit choice, not described in
prose.

### 5.10 What this round did not do

- **It did not modify `task-graph.ts` or `task-graph-replay.test.ts`.** They are
  phase 3's and phase 1's, and they are the instruments this experiment is
  measured against; a builder that edits its own reference is measuring itself.
  The experiment composes them from the outside instead.
- **It did not change any promotion predicate.** `db/projects.ts` is touched in
  **comments only** — one over-wide clause in the module preamble. The statement
  is byte-identical, which is exactly what phase 2's replay proof would have
  caught had it not been.
- **It did not touch a live endpoint, a live service, the live database, or
  `/opt/forge-ai-os`.** The instrument refuses to run inside the live checkout.

---

# Round 225 — fix cycle 1: three retracted claims and one silence made loud

Fix cycle 1 against round 224's two reviews (the phase-4 gating review and the
phase-4 red team), which agreed on a verdict of NEEDS_FIXES and between them
raised six findings, three of them the same defect seen from two sides. **Every
functional deliverable of phase 4 was already discharged; what failed was
prose** — three sentences in shipped source and in the requirements corpus that
read as authoritative and were measurably wrong — plus one genuinely silent
failure path. This section records the fix and the evidence.

Files written by this round:

```
forge-control/src/lib/workspace.ts          maxWorkstreams() JSDoc, provisionWorkstream()'s
                                            R39 block, and the NF1 warning (the ONLY
                                            behavioural change in this commit)
forge-control/src/lib/project-reconcile.ts  sameIdSet() and duplicatesFixChain() headers
forge-control/src/db/projects.ts            closeFinishedProjects() doc comment
docs/plan/engine-task-graph/01-requirements.md          R39 §D, R70 §D
docs/plan/engine-task-graph/evidence/phase4-workstreams.md   §3.1, §4, and this §6
docs/plan/engine-task-graph/evidence/phase2-replay.md   §7's GENERATED region (--write)
scripts/checks/check-workstream-e2e.sh      §5.6, §7.4, §9.4–9.9, split streams
scripts/checks/check-r20-census.py          one ATTRIBUTIONS entry
```

## 6. The findings, and what each one cost

### 6.1 Gating finding 1 — a SQL mirror that does not exist

`sameIdSet()`'s JSDoc called itself *"the exact mirror of the `cardinality(...)
= ... AND @> AND <@` triple in db/projects.ts's guard SQL"*, and
`duplicatesFixChain()`'s header called it a mirror *"term for term, exactly as
`markVerdictTaskDone` mirrors `verdictMemberSettled`"*. Re-measured rather than
re-read:

```
$ grep -n "cardinality\|@>\|<@" forge-control/src/db/projects.ts
42: * A `depends_on` whose cardinality does not match the same-project rows it names
684: *  explanation of a cardinality mismatch, and the only three that exist.
685: *  `cardinality(depends_on)` counts array ELEMENTS; the comparison counts
728:          AND cardinality(pt.depends_on)
781: * The front half — the `cardinality` equality in promoteReadyTasks()'s graph
830: *     closed loudly: promote by the cardinality equality (R14 front half), retry
972: *  forever with a matching cardinality that the sweep could not see — while
1026:               = cardinality(pt.depends_on)            -- R14: no dangling dep may satisfy
```

**No `@>`. No `<@`. Every `cardinality` hit belongs to R14's dangling-dependency
term in `promoteReadyTasks()`, a different rule entirely.** The comment
contradicted R41's own decision text, `createFixChain`'s inline comment beside
the call, and `02-architecture.md` §1.2 — three correct statements and one wrong
one, and the wrong one sat in the file an auditor of R41 would open first. Both
headers now say what is true: one definition, called from the transaction; the
SELECT beside it narrows and decides nothing. The
`markVerdictTaskDone`/`verdictMemberSettled` analogy is deleted rather than
softened, because that pair is this module's one GENUINE SQL mirror and
conflating the two sends the next auditor hunting a second copy that does not
exist.

### 6.2 Gating finding 2 — a measurement retracted in the doc, alive in the file

`maxWorkstreams()`'s JSDoc still claimed importing `routes/projects.ts`
*"constructs THREE pg Pools against content_forge at module scope"* and that a
static import would *"break the standing rule that tests never touch a
database"*. `02-architecture.md` §4.3 retracted exactly that in round 222 —
measured with a counting `pg.Pool` subclass, `project-tick.ts` **alone**
constructs **5**, and `routes/projects.ts` on top adds **0** — and said in as
many words that *"a correct decision resting on a measurement that does not hold
is one audit away from being reversed for the wrong reason"*. Round 224's
reviewer re-measured at `HEAD=b201f22` and reproduced 5 / +0.

The retraction had landed in the architecture doc and **not** in the file the
retraction was about. Phase 4C could not have fixed it — `workspace.ts` was
outside its declared write set — so it is inherited rather than caused. The
paragraph now carries §4.3's actual reasoning (`lib/` must not statically depend
on `routes/`; a `pg.Pool` constructs lazily and connects on first query, so NF3
was never at risk from either import), states the measured 5 / +0, and marks the
three-pool claim retracted in place. The stale line *"phase 4B is editing it
concurrently"* went with it, replaced by §4.3's actual ruling: phase 4C reviewed
the move and the constant **stays**.

### 6.3 Gating finding 3 = red-team finding 2 — R39's TOCTOU, overclaimed in three places

Round 215 accepted the API's TOCTOU on the ground that phase 4's
`provisionWorkstream()` *"actually guards the disk, because the checkout that
would consume it cannot be created without passing here."* Both round-224
reviews attacked that sentence with two concurrent processes at a filled cap,
independently, and both broke it — the gating reviewer measured cap 4 → 5
distinct workstreams, the red team cap 5 → 6 worktrees. The provisioning check
reads `git worktree list` and then runs `worktree add`, with no lock: the
**identical** TOCTOU it was cited as closing.

**The ruling, which R39 explicitly left to phase 4's red team, was taken in
round 224: ACCEPT the race in both places; do NOT make the count
transactional.** Recorded now where the rule is enforced, on the grounds that
were actually measured rather than the claim that was not:

- the race is **unreachable in the deployed topology** — `provisionWorkstream`
  has exactly two call sites, both inside `spawnTaskRuns()`'s sequential
  `for … await` loop in a single executor process;
- the slip is **clean** — consistent branch+worktree pairs, no orphan branch, no
  orphan directory, nothing half-provisioned, and `removeWorkspace()` enumerates
  from the registry so teardown still reaches every one; checked both ways;
- a refusal **writes nothing**, because the cap check runs before any git write
  (e2e §12.6);
- the priced cost is **one extra full checkout of disk**, never a corrupt
  workspace.

The sentence is retired from all three places it was restated — R39 in
`01-requirements.md` §D, `provisionWorkstream()`'s R39 comment block, and §4 of
this document — **in this one commit**, which is the standing rule about
retiring a claim and its restatements together.

### 6.4 Red-team finding 3 — R70's residual, stated instead of implied

An integration task marked `done` **without its merge having happened** is
caught by nothing structural: R70 verifies existence and edges, never git. The
covering task exists, its `depends_on` covers W, the term is satisfied, the
project closes with the branch unmerged. The designed catch is R38's integration
**reviewer**, which a hand-edit in psql bypasses — the same operator-with-psql
class as the hand-renumber R41 guards, and accepted for the same reason. One
sentence each now in R70 (§D) and in `closeFinishedProjects()`'s doc comment,
because R70's presence otherwise implies a completeness it does not have.

### 6.5 Red-team finding 1 — the silent re-provision, and the only code change

The one finding that was not prose. A workstream worktree deleted from disk was
re-provisioned with **zero output**, while the equivalent `main` recovery has
always warned (`wsMissing` in `resolveTaskWorkspace()`). Uncommitted work in the
old directory is gone — necessarily; nothing can restore an `rm -rf`'d directory
— so the requirement is that the loss is ANNOUNCED, not that it is prevented.
NF1 is not satisfied by a workstream losing work more quietly than `main` does.

`provisionWorkstream()` now warns on the `branchExists && !already` path, after
a successful `worktree add`:

```
[workspace] project <id> workstream "<ws>": a previous checkout of branch
<branch> existed and is no longer registered — re-created at <dir>. Commits on
<branch> are intact; any UNCOMMITTED state in the old checkout is unrecoverable.
```

**The race-loser does not reach it, by construction rather than by hope.** Git
refuses `worktree add` for a branch already checked out elsewhere, so a racer
whose rival won lands in the `!add.ok` branch and returns from the re-check.
Only a checkout that is genuinely no longer registered gets past `add.ok`.

## 7. The instrument, and what would have made it certify wrongly

`check-workstream-e2e.sh` goes from 53 to **61** assertions. Three of the eight
are the finding; five exist to stop the finding certifying itself.

**Stream separation was a prerequisite, not tidiness.** `drive()` captured
`2>&1`. `console.warn` goes to stderr, and one warning line interleaved into the
driver's single JSON object would make `jget`'s `json.load` throw — every JSON
assertion in the run would have collapsed. Stdout and stderr are now captured
separately, and both are quoted into failure diagnostics so a driver that dies
before printing JSON still leaves its diagnosis.

**Failure mode (f), added to the header's list: the warning passed because it is
unconditional.** A `console.warn` on every provisioning would satisfy the
positive assertion while telling an operator nothing. Two negative controls on
the same string:

```
  ok   5.6 a first-ever checkout does not warn about loss     no: a previous checkout of branch
  ok   7.4 the idempotent call does not warn about loss       no: a previous checkout of branch
```

**And the case must genuinely lose something.** §9 writes an uncommitted file
into the worktree before deleting it, then asserts the loss really happened and
that the warning's claim about COMMITTED work is true — a message that said
"commits are intact" while the tip had moved would be a different kind of lie:

```
9. a workstream worktree deleted from disk is re-provisioned, LOUDLY (R32, NF1)
  ok   9.1 re-provision returns the same dir                  = <root>/…--ui
  ok   9.2 re-provision returns the same branch               = project/11111111-ui
  ok   9.3 the directory is a live worktree again             …/.git present
  ok   9.4 the re-provision WARNED about the lost checkout    contains: a previous checkout of branch
  ok   9.5 the warning names the project                      contains: 11111111-2222-4333-8444-555555555555
  ok   9.6 the warning names the workstream                   contains: "ui"
  ok   9.7 the warning says the uncommitted state is gone     contains: UNCOMMITTED
  ok   9.8 the branch tip is unmoved (commits really are intact) = 6ef21ba4297e8d8f47623c39c7ef3da7812d6977
  ok   9.9 the uncommitted file really is gone                absent, which is what 9.4 announces
      warning: [workspace] project 11111111-2222-4333-8444-555555555555 workstream "ui": a previous
      checkout of branch project/11111111-ui existed and is no longer registered — re-created at
      <root>/…--ui. Commits on project/11111111-ui are intact; any UNCOMMITTED state in the old
      checkout is unrecoverable.
```

### 7.1 Both mutations, observed failing

Standing rule 3 says instruments lie before code does, and an assertion never
seen to fail is a claim rather than a measurement. Both directions were mutated
in the subject, run, and reverted (`sha256sum` used to confirm the revert):

```
MUTATION 1 — the guard removed, `if (branchExists.ok)` → `if (true)`
  FAIL 5.6 a first-ever checkout does not warn about loss     found [a previous checkout of branch] in […]
  check-workstream-e2e.sh FAILED after 16 assertions          exit=1

MUTATION 2 — the whole `console.warn` block deleted
  FAIL 9.4 the re-provision WARNED about the lost checkout    missing [a previous checkout of branch] in []
  check-workstream-e2e.sh FAILED after 31 assertions          exit=1
```

An unconditional warning fails at 5.6. A missing warning fails at 9.4. Neither
survives.

## 8. The full gate, at this round's bytes

Every command run, output as printed. `pnpm test` and `pnpm typecheck` from
`forge-control/`; the rest from the worktree root.

```
pnpm typecheck                → TYPECHECK_EXIT=0  (tsc --noEmit, clean)
pnpm test                     → tests 1113 | suites 201 | pass 1113 | fail 0
                                cancelled 0 | skipped 0 | todo 0
check-workstream-e2e.sh       → PASSED — 61/61 assertions ran and passed
check-close-gate.ts           → 27 (expected 27), failed 0, PASS      [scratch DB]
check-fix-chain-graph.ts      → 33 (expected 33), failed 0, PASS      [scratch DB]
check-r69-straddle.sh         → registered 11  ran 11  passed 11  failed 0  never-ran 0
check-corpus-map.py           → OK — R1..R70 and NF1..NF7 complete, all three statements agree
check-instrument-identity.py  → OK — 8 pasted headers name f6828a68…, no unmarked retired identity
check-r20-census.py --self-check → OK at 27d300f (85 / 92 / 41 / 44 reproduced)
check-r20-census.py           → SYMBOLS 25 attributed; R20 PASS; REGION matches  (after --write)
```

**The R20 census moved, and why.** §6.4's sentence in
`closeFinishedProjects()`'s doc comment contains the citation *"round 224's red
team"*, which is a `round` hit in `db/projects.ts` — so the census gained a
symbol and refused it as **UNATTRIBUTED**, correctly, before anything was
regenerated. `check-r20-census.py` gained one `ATTRIBUTIONS` entry recording
what that hit is (a citation of a review round; the closure statement reads
`workstream` and `depends_on` and never `round`), and
`evidence/phase2-replay.md` §7's generated region was regenerated with `--write`
— **123 → 124 hits, sha256 `47e25793…` → `f620b372…`.** That file is outside
this round's obvious set and the write is declared here and in the commit
message. The `--self-check` at `27d300f` is unchanged, which is the evidence the
attribution rule itself did not move.

**Not run, and why.** No live endpoint, no live service, no live database, and
nothing under `/opt/forge-ai-os` — this is a build task and verification against
live belongs to the deploy task. The two Postgres-touching checks ran against
`forge_tg_scratch`, created via the `postgres` maintenance database, never
`content_forge`.

## 9. Citations

By symbol or requirement id throughout: `provisionWorkstream`, `maxWorkstreams`,
`listProjectWorktrees`, `removeWorkspace`, `resolveTaskWorkspace`, `wsMissing`,
`spawnTaskRuns`, `sameIdSet`, `duplicatesFixChain`, `createFixChain`,
`markVerdictTaskDone`, `verdictMemberSettled`, `promoteReadyTasks`,
`closeFinishedProjects`, `unintegratedWorkstreams`; R14, R28, R29, R32, R38,
R39, R41, R42, R70, NF1, NF3. **No bare `file.ts:NN` pin is added by this
round.** Commit shas are cited as identities (`b201f22` — the HEAD every
measurement above was taken at, worktree carrying only this round's changes;
`27d300f` — the census self-check's historical tree).

## 10. The e2e re-run AT the commit, not merely at the bytes

§7's transcript was taken with the worktree dirty — the run that produced it
printed `workspace.ts dirty : [ M forge-control/src/lib/workspace.ts]`, which is
honest but leaves the reader to trust that the committed bytes are the tested
ones. Round 225's fix landed as `57d3c97`; the check was then run again with
nothing uncommitted:

```
check-workstream-e2e.sh — engine-task-graph phase 4 (R32–R35, R38, R39, NF1)

BUILD IDENTITY OF THE CODE UNDER TEST
  git HEAD           : 57d3c97b5cd5e5d143aad5c84d6e561f64edf63b
  git branch         : project/8c591d6c
  subject sha256     : 081aaedbd59a84e6d22f8bb6400191f89145b4aee4f10459356038962b778706   <-- authoritative
  workspace.ts dirty : [committed, matches HEAD]
  …
check-workstream-e2e.sh PASSED — 61/61 assertions ran and passed.

$ git status --porcelain          # worktree root
                                  # (no output)
```

**The subject sha256 is byte-identical to §7's run** — `081aaedb…` before the
commit and `081aaedb…` after it — which is the point of a content-addressed
identity: committing does not change the bytes, so it cannot change the answer.
What the second run adds is the `[committed, matches HEAD]` line plus an empty
porcelain, so "the bytes I tested" and "the bytes I committed" are the same
claim rather than two. This is the failure round 224's reviews both listed
first: *a sha naming the worktree rather than the build*.
