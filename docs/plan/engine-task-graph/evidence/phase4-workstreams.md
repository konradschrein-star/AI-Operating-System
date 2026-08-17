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

`scripts/checks/check-workstream-e2e.sh` — bash, `set -euo pipefail`, 53
assertions, each a separately named PASS/FAIL line, exits non-zero on any
failure. It operates entirely inside one `mktemp -d`: `AI_OS_REPO_DIR` and
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
  provisioning refusal here is the defence-in-depth that amendment describes:
  two concurrent POSTs proposing two different new workstreams can both pass the
  API's snapshot count, but the worktree that would actually consume the disk
  cannot be created without passing `provisionWorkstream`'s check. **Whether
  that is sufficient or the count needs a transaction is explicitly the phase-4
  red team's decision**, not this round's, and it is left open rather than
  closed by assertion.
- **Scratch-repo workstreams** are supported — `projectRefs()` resolves the
  repo, project branch and main directory per repo type — but a scratch
  project's workstream worktrees are **not** removed by `removeWorkspace`,
  because the existing rule that a scratch repo is never auto-deleted is left
  exactly as it was. They live inside the scratch repo's own worktree registry
  and `git worktree list` shows them to whoever removes it by hand.
- **Live verification** belongs to phase 8. Nothing here touched
  `/opt/forge-ai-os`, a live endpoint, a live service or the live database.
