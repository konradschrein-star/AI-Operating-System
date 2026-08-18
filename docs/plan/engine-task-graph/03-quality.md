# 03 — Quality: engine-task-graph

Base commit of this corpus: `20bd46abc9228ca1e8c06a7a17be13f06e6d287e`.

This is the document a reviewer of this project reads. Every gate below is
**satisfiable** — if you find one that is not, amend it *here and where it is
enforced*, in the same commit, with the reasoning inline (standing rule 2).

---

## 1. The harness that exists

There is no vitest, no jest, no ledger, no migration runner. What there is:

| Job | Command | Where run |
|---|---|---|
| Typecheck | `tsc --noEmit` (`pnpm typecheck` in `forge-control/`) | worktree |
| Unit tests | `tsx --test src/lib/*.test.ts` (`pnpm test` in `forge-control/`) | worktree |
| Web checks | `scripts/checks/check-plan-store.ts` and friends, under `tsx` | worktree |
| Migrations | manual `psql -f db/migrations/NNNN_*.sql` | **deploy task only** |

**Tests never touch a database.** `project-reconcile.test.ts` states the rule in
its header — *"a value import of `db/*` would open a pg Pool in the test
process"* — and `project-tick.test.ts` follows it with `import type` plus object
factories (`project(over)`, `task(over)`). Every new test in this project obeys
the same rule (NF3). Proof of obedience: `pnpm test` passes with Postgres
stopped, and the reviewer of each phase states that they ran it that way or that
they could not and why.

`migrations.test.ts` is a **linter**, not a runner. It asserts every
`CREATE TABLE` carries `IF NOT EXISTS`, every `CREATE (UNIQUE)? INDEX` carries
it, every `ADD COLUMN` carries it, and it names `0039_reviewer_chain_key.sql`
specifically. Phase 1 adds an equivalent named case for `0042_task_graph.sql`.

---

## 2. Test strategy by layer

### 2.1 Unit — pure functions, `forge-control/src/lib/*.test.ts`

The bulk of the proof lives here, because the bulk of the *decisions* live in
`lib/task-graph.ts` by design (`02-architecture.md` §1.1).

**`task-graph.test.ts`** — new file. Cases, grouped, **each group labelled with
the phase that owns it** (added round 204). The groups are not all phase 2's: the
file is created in phase 2 and grows in 3 and 4 as the functions they own land, and
an unlabelled list read as one phase's checklist is how phase 2 came to be judged
against a `computeRound` that R23 assigns to phase 3.

*Readiness* — **phase 2**
- `readyRule` returns `legacy` for `depends_on: null` and `graph` for `[]` and
  for a populated array. Three cases, because the sentinel is the whole
  migration strategy and a mistake here is silent.
- `graphReady`: empty deps → ready; one done dep → ready; one pending dep → not
  ready; mixed done/failed → not ready; **dep id absent from the map → throws
  `GraphIntegrityError`** (R14, never `false`, never `true`); **a duplicated dep id
  → throws too**, naming it (added round 204: R14 is a cardinality rule, the
  shipped SQL blocks the project over a duplicate, and membership testing alone
  made the pure mirror disagree with the statement it mirrors); a duplicate across
  two DIFFERENT tasks — a fan-in — stays silent, or every diamond would block.
- `legacyRoundReady`: reproduces today's rule exactly, including "*every*
  strictly lower round", not "the previous one".

*Depth* — **phase 2**
- `taskDepth` over: a chain, a diamond, a wide fan-out, two disjoint roots, a
  mixture of NULL and array rows (the NULL row contributes its own `round`).
- Determinism: same input twice → identical map.

*Round computation* — **phase 3** (R23; struck from phase 2's deliverable 5 in
round 204, standing rules 2 and 4 — `computeRound()` throws until phase 3 and
that is not a defect)
- `computeRound([])` → 0; `computeRound([r=5, r=7])` → 8; the architect's
  explicit `k*100` passes through untouched; the block-overflow refusal at 99
  levels (R24) — **a 99-deep chain passes and the 100th is refused**, which is
  the case that proves the gate is satisfiable rather than decorative.

*Cycles* — table-driven (R25) — **phase 3**

| graph | expect |
|---|---|
| `a → a` | cycle `[a, a]` |
| `a → b → a` | cycle naming both, oldest first |
| `a → b → c → a` | cycle naming all three |
| diamond `a→b, a→c, b→d, c→d` plus `d→a` | cycle through one branch |
| chain of 50, no back edge | `null` |
| wide DAG, 1 root → 30 leaves | `null` |
| candidate depending on a node whose own deps are NULL (legacy) | `null`, and no crash |

Each cycle case asserts the returned path's **ids in order**, not just its
length — a detector that finds "a cycle exists" without naming it fails R25.

*Contention* — **phase 2**
- `conflicts`: disjoint → false; identical → true; one shared entry → true;
  `{}` vs anything → **false** (R17); `src/a.ts` vs `src/a.tsx` → false (no
  prefix semantics); `src/` vs `src/a.ts` → false, with a comment saying this is
  deliberate.
- `selectClaimable`: two ready tasks sharing a file in one workstream → one
  claimed; the same two in different workstreams → **both** claimed; a ready
  task conflicting with a *running* task → not claimed; three-way chain
  a↔b, b↔c, a∌c → a and c claimed, b deferred (order-stable and asserted).

*Validators* — **phase 3** (R28)
- `validateWorkstream`: `main`, `ui`, `api-v2` pass; `Main`, `-ui`, `ui_`, a
  41-char name, `../x`, empty all throw.
- `normaliseWritePath`: `./src/a.ts` → `src/a.ts`; `src//a.ts` → `src/a.ts`;
  `/etc/passwd`, `../x`, `a\0b`, a 401-char path, all throw naming the entry.

**`task-graph-replay.test.ts`** — the replica proof, R18. Its own file because
it is the single most important test in the project and must be findable.

```
FIXTURE  forge-control/src/lib/fixtures/replay-operator-visibility.json
         {id, round, role, title, status, created_at} × ~124, no briefs
HARNESS  simulate(rule): tick until quiescent, recording per tick the SET of
         tasks promoted; a promoted task "runs" and becomes done on the next tick
ASSERT   simulate(legacyRoundReady) deep-equals simulate(graphReady-over-backfill)
```

**Six** cases (R18 a–f): base, retry of an early round after a later one
drained, insertion into a drained round, pause/resume, a permanently-failed task
(both must wedge identically), and — added round 106 — a fix chain inserted by
the old engine **after** the migration froze the closure (F13/R69). The first
five model *migrate-after-insert*; (f) is the other order, and until it existed
the harness could only ever see one of the two. `graphInput()` therefore takes
an explicit migration-time snapshot: rows outside it carry `depends_on: null`.
The harness prints the fixture row count and
`git rev-parse --short HEAD` **before** asserting — standing rule 3: a harness
that does not expose its own build identity is not evidence.

**Extensions to existing test files** — new cases only, no edits to existing
ones (R43):
- `project-reconcile.test.ts` — `chainKeys` for a named workstream; the existing
  `main` cases must pass byte-identically.
- `cp2-reconciler-interaction.test.ts` — two same-round reviewers in different
  workstreams yield two independent chains (R40).
- `project-tick.test.ts` — prompt-content assertions for R47–R53, and the
  prompt-length budget (NF7).
- `migrations.test.ts` — the named `0042_task_graph.sql` case (R2).

### 2.2 Integration — `scripts/checks/*`, run explicitly, never in `pnpm test`

Anything needing Postgres or a real git repository is a script, so the unit
suite stays hermetic (NF3).

| Script | Proves | How |
|---|---|---|
| `scripts/checks/check-migration-0040.sh` | R2, R6, R7 | Creates a throwaway schema in a **local scratch database**, seeds it from the replay fixture, applies 0040 **twice**, diffs the resulting `project_tasks` rows, asserts the second application changed zero rows and the indexes exist. |
| `scripts/checks/check-scheduler-sql.sh` | R11–R14, R16, R17, R27 (SQL half), R69 | Against the same scratch schema: a graph-ready task promotes with its round undrained; a NULL-deps task does not; a dangling dep yields `blocked`, not `ready`. **Round 204 added cases 8, 8b, 9, 10:** `retryTask()` refuses a corrupt row and the following claim does not claim it; a corrupt row written straight to `ready` is still swept; a duplicated id blocks and `graphReady()` agrees; a cross-project id resolves to nothing on both sides. Each new case also drives the real `graphReady()` over the same rows, so the mirror is measured rather than asserted in prose. |
| `scripts/checks/check-workstream-e2e.sh` | R32–R35, R38 | In a throwaway git repo under `/tmp`: provision `main` + two workstreams, assert branch names and sibling directories, assert `git status --porcelain` in `main` is **empty**, have two workstreams write the same file, run the integration merge, assert it exits non-zero and names the conflicting file, assert nothing was auto-resolved. |
| `scripts/checks/check-task-api.ts` | R22–R31 | Mounts **only** `routes/projects.ts` on a spare port against the scratch database (the single-router probe pattern — `src/index.ts` starts cron/telegram/vault ticks and must not be booted), then drives the 400s and the 409. |
| `scripts/checks/check-plan-store.ts` | R54–R56 | Extended: real edges in, `planEdges()` out, phase grouping intact. |
| `scripts/checks/check-workstream-claim.ts` | round 960 (R48's criterion, R33's branch form) | The second check of that class, and the reason it exists is measured: `GRAPH_GUIDE`'s workstream bullet closed with a SAME-FILE criterion while the round-222 spawn belt serialises a workstream whatever its tasks write, so round 815's project produced a correct DAG that ran 1-wide (`evidence/phase8-verify.md` §7c). Drives `busyWorkstreams()` + `partitionByWorkstream()` + `selectClaimable()` with that exact shape: two disjoint tasks in one workstream spawn ONE while the contention gate would have run both; the same file in two workstreams spawns BOTH; six independent tasks over k workstreams reach width k for k ∈ {1,2,3,6}; `workstreamBranch()` is the hyphen form R33 verified against git and never the slash form three documents predicted. Then the guide is asserted to state exactly what the table proved, and to no longer carry the retired criterion. Needs no database and no git repo, so a build task may run it; prints the resolved path and sha256 of every module it imported, and fails rather than certifies if its case census comes up short. Mutation-tested at round 960 — five injected faults, each red, each restored by sha (`evidence/round960-workstream-criterion.md` §4). |
| `scripts/checks/check-screenshot-render-shapes.ts` | round 902, review finding 1 | The FIRST check that executes a PROMPT'S CLAIM against the code it describes — "the only" until round 960 added the row above, corrected here in the commit that made it false. Seven payload shapes — a `Read` of the saved path, a JSON `"url"` member, a bare URL echoed as text, an MCP screenshot call, a silent `cp`, an unstamped name, prose mentioning the directory — through the shipped `extractBrowserShots`, then the two prompts asserted to state exactly what the table proved. Needs no database and no git repo, so it is safe from a build task; prints the resolved path and sha256 of every module it imported, and fails rather than certifies if its case census comes up short. |

**Scratch database, not the live one.** Every script takes its connection string
from `SCRATCH_DATABASE_URL` and **refuses to run** if that variable is unset or
points at `content_forge`. A check that can be pointed at production by
forgetting an environment variable is an incident waiting for a tired night.

### 2.3 End-to-end — phase 8 only

Live verification against the real database, the real executor and the real API
happens **only** in the explicitly-briefed deploy/verify task (R67). No build
task touches `/opt/forge-ai-os`, live endpoints, or the live database. If a
builder genuinely cannot prove something from the worktree, it says so in its
final message and lets phase 8 prove it.

---

## 3. QA gates per phase

Each phase's gating reviewer runs **all of §3.1** plus its own phase block, and
quotes the output. A review without executed checks is not a review.

### 3.1 Universal gate — every phase

```bash
cd forge-control && pnpm typecheck && pnpm test
git -C /opt/forge-ai-os status --porcelain          # MUST be empty
git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
python3 docs/plan/engine-task-graph/check-instrument-identity.py   # MUST exit 0
python3 scripts/checks/check-r20-census.py                          # MUST exit 0
bash scripts/checks/check-instrument-typecheck.sh                   # MUST exit 0
```

1. `tsc --noEmit` clean.
2. `tsx --test src/lib/*.test.ts` — **all green, zero skipped**. A skipped test
   is a finding; deleting a test is a finding unless the commit message names the
   requirement it retires (standing rule 4).
3. `git -C /opt/forge-ai-os status --porcelain` empty. **Any** output means
   someone hot-applied work into the live checkout. By itself a `NEEDS_FIXES`,
   with the dirty files named verbatim. Paste the output — or its emptiness —
   into the review.
4. **Write-set audit (R57/F8).** For every builder task in the group, compare
   `git log --name-only` for that task's commits against its declared
   `write_set`. An undeclared write is a finding. This is satisfiable exactly
   because write-sets are declared rather than reconstructed.
5. **Citation audit.** Every `file.ts:NN` in the phase's commits, briefs and
   docs is either resolved against the recorded SHA beside it or reported as a
   finding. Three rounds on the previous project found rotted pins that read as
   authoritative and were wrong.
6. **Silent-fallback audit (NF1).** List every `catch`, `?? default`,
   `|| fallback` and `.catch(() => {})` the phase added, and state for each why
   it is not a swallowed error.
7. **Instrument-identity check (round 217, round 216's finding 1;
   **the one-file clause retired round 811**).**
   `check-instrument-identity.py` exits 0. It asserts that every
   `instrument-sha256:` header pasted anywhere in this corpus equals the
   **composite of BOTH instrument files** on disk, that every pasted
   `instrument-files:` manifest line equals the current digest of the half it
   names, and that no retired identity — composite or per-file — is quoted
   without the literal marker `[historical instrument]` on the line.
   *Re-derive the composite with:*
   `sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum`
   **What was retired and why it had to be.** This clause said the header equals
   `sha256sum scripts/measure-schedule.ts` — ONE file. That command no longer
   produces the header's value, so the clause is not merely weaker, it is
   **unsatisfiable**, and standing rule 4 forbids leaving it standing beside the
   change. It was also wrong before it was unsatisfiable: `schedule-source.ts`
   holds every line of the instrument's SQL and its whole `pg` lifecycle, and
   could be rewritten without this gate moving a bit. Round 810 proved that in
   the field — its patched dry run printed the shipped instrument's identity
   unchanged, which is round 213's *"a sha naming the tree rather than the
   build"* one file over. Retired here, in the same commit as the checker that
   enforces the replacement, as `01-requirements.md` §H R62 and `04-phases.md`
   §12 E-3.
   **Why it is a universal gate and not a phase-7 one:** round 215 edited the
   script from a phase-3 fix cycle, which moved the identity under eight pasted
   headers, a section heading, a ledger row and a `sha256sum` block the document
   offers as an *independent* re-derivation — and two reviewers read past it,
   because agreeing with a document is not the same as agreeing with the disk.
   Any phase can move either half of the instrument, so every phase checks it.
   It carries its own positive controls: fewer than 8 live headers found, fewer
   than 8 manifest lines found, or no header found in
   `evidence/baseline-8ea0cc08.md`, is a **failure** and not a clean run, so a
   glob that matches nothing cannot certify itself (`00-vision.md` §7 rule 2).

8. **R20 census (round 242, on round 223's recommendation).**
   `scripts/checks/check-r20-census.py` exits 0. It re-measures every `round`
   occurrence in `db/projects.ts`, asserts that **every non-comment `round` line
   inside `promoteReadyTasks`, `claimReadyTasks` and `sweepDanglingDependencies`
   is one of the justified lines** — a new scheduling predicate that reads
   `round` fails it by name — and verifies the generated census region in
   `evidence/phase2-replay.md` byte-for-byte against the file it describes.
   **Why it is universal and not phase-2's:** it sat red across three rounds
   precisely *because* it blocked nobody, which is the failure mode it exists to
   catch. Any phase can add a `round` predicate or move a doc-comment, and the
   document it guards rots silently in either case — round 205 found its
   headline pair stale in a table the round-204 commit had itself edited.
   It carries its own calibration: `--self-check` re-censuses `27d300f` and
   fails if the four numbers a human derived by hand there move, so an
   attribution rule that drifted cannot launder itself into the document with
   `--write`. When it reports STALE, the fix is `--write`, in the same commit as
   the change that moved the numbers.
   *At round 242 it exits 0 at 129 hits (51 code / 78 comment, 3 SQL
   annotations) over `db/projects.ts` sha256 `79a62da97552c1c2…`. The count is
   not a gate — the R20 assertion and the region comparison are; it is recorded
   so a reader can tell a re-measurement from a rot.*

9. **Instrument typecheck (round 802, phase 8C — operator ruling, third
   instance of the same hole).** `bash scripts/checks/check-instrument-typecheck.sh`
   exits 0. It typechecks every check script named in
   `scripts/checks/instrument-manifest.txt`, **one file per `tsc` invocation**,
   and additionally **fails if any `scripts/checks/*.ts` this branch adds or
   modifies is absent from the manifest.** Both halves are the gate; the second
   is the one that keeps the first honest.

   **The hole.** `scripts/checks/*.ts` is compiled by **nothing**. `tsx` strips
   types without checking them, and that directory sits outside **both**
   projects' tsconfig `include` — `forge-control/tsconfig.json` includes
   `src/**/*.ts`, and `tsconfig.checks.json` exists only to give `tsx` a JSX
   transform. So a check script can carry a type error, an implicit `any` or a
   dead import indefinitely, and still *run*, and still *print PASS*. These are
   the scripts whose entire job is to certify other code — **the least-verified
   code in the repo is the code that issues the verdicts.**

   **Why UNIVERSAL and not a phase-8 clause.** It has now been hit three times,
   by three different phases, and each time it was repaired only inside that
   phase: **phase 7** (`measure-schedule.ts`, at the repo root, outside every
   `include`), **phase 6** (four of six deliverables under
   `forge-control-web/`), **phase 6B** (which measured the whole directory and
   left it as a finding). A per-phase clause repairs the instance and leaves
   every other phase's instruments unchecked — which is precisely the mechanism
   by which it stayed invisible three times. Any phase can add an instrument, so
   every phase checks its own.

   **Why MANIFEST-SCOPED and not directory-wide — measured at round 800, and it
   changes the shape of the gate.** 6B's invocation over **all** the directory's
   `*.ts` at once **does not pass and cannot be made to pass by this project**.
   Compiled together they pull `forge-control-web/app` into the program (DOM-lib
   errors in `useAutogrow.ts` and `tokens.ts`), and three other projects'
   scripts are independently red: `check-orientation.ts` (3 type errors plus a
   `--jsx` failure), `serve-sse-808.ts` (implicit `any`s), `check-chat-rich.tsx`.
   Fixing another project's instruments is not phase 8's remit. A gate that can
   only ever be **disclosed** teaches that disclose-and-proceed is normal, and
   that habit is what let a self-certifying hover probe survive round 213
   (`00-vision.md` §7 rule 2). **Compiled one file per invocation, all six of
   this branch's own check scripts pass — exit 0, zero errors:**
   `check-close-gate.ts`, `check-fix-chain-graph.ts`, `check-plan-api.ts`,
   `check-plan-store.ts`, `check-project-metadata.ts`, `check-task-api.ts`.
   Re-measured at `3dd39b4` by round 802; the transcript is
   `evidence/phase8-corpus.md` §5.
   **The other projects' red scripts are REPORTED, not fixed here** — named
   above and in that transcript, so the next project that owns them inherits a
   finding rather than a surprise.

   **What the manifest guard buys: a new instrument cannot escape the gate by
   being new.** A manifest alone would be a gate that shrinks to fit — the
   easiest way to pass it is to leave your script out of it. The guard inverts
   that: adding or modifying a `scripts/checks/*.ts` **without** listing it is
   itself a failure, so the manifest can only grow with the branch. The
   directory-wide alternative fails the opposite way, and measurably: the
   directory held **21** `.ts` files at this branch's merge-base and **36**
   after round 801's merge — a directory-wide gate written today would be red
   tomorrow from another project's merge alone, having caught nothing about this
   branch.

   *Two instrument traps found while measuring this gate, recorded because they
   would each have made it report wrongly (`evidence/phase8-corpus.md` §5.2):*
   **(a)** the invocation's working directory is load-bearing — run from the
   repo root, all six fail with `TS2307 Cannot find module 'node:fs'` and
   `TS2580 Cannot find name 'process'`, because `@types/node` resolves from
   `forge-control/node_modules` and nowhere else. A false red on green code.
   **(b)** the branch-ownership set must **not** be computed from
   `merge-base...HEAD`: after round 801's merge that expression returns 25
   files, `main`'s included, because the merge commit carries them. The
   expression that returns exactly the six is
   `git log --no-merges --name-only --pretty=format: main..HEAD -- 'scripts/checks/*.ts'`.

   The script and the manifest are builder 8D's
   (`scripts/checks/check-instrument-typecheck.sh`,
   `scripts/checks/instrument-manifest.txt`, §10 of `04-phases.md`); this clause
   and the §4 command line are what run them.

10. **Shell lint (round 804, finding 4 — the gate that keeps a retired
    disclosure retired).** `shellcheck -S error` over every `*.sh` this branch
    adds or modifies exits 0. The file list is **derived, never typed**:

    ```bash
    SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
    for f in $SH_ALL; do [ -f "$f" ] || echo "deleted on this branch, not linted: $f"; done
    shellcheck -S error $(for f in $SH_ALL; do [ -f "$f" ] && printf '%s\n' "$f"; done)
    ```

    **Why this exists at all.** It is item 9's hole one directory over. `*.ts`
    under `scripts/checks/` was compiled by nothing; `*.sh` under
    `scripts/checks/` and `scripts/deploy/` was *linted* by nothing — `bash -n`
    was the only static check, and it reads syntax, not directives or quoting.
    The branch now ships **seven** shell scripts, one of which is
    `scripts/deploy/await-and-seed.sh`: the detached watcher 811 launches, which
    runs unattended for up to thirteen hours with nobody reading its output.

    **It caught a real defect on its first run.** `await-and-seed.sh` carried
    `# shellcheck disable=SC2086 — <rationale>`; the em-dash makes an invalid
    key=value pair, so the linter reported **SC1125 (error)** and that one file
    failed while the other six passed. Fixed in the same commit as this clause
    (round 804 finding 1). Transcript: `evidence/phase8-tooling.md` §6.1.

    **Why `-S error` and not the default severity — this gate is written to be
    PASSABLE (standing rule 2, `00-vision.md` §7 rule 2).** At default severity
    the same seven files emit SC2154, SC2015 and SC1010 across five of the six
    check scripts *already shipped* — `rc` assigned inside an ERR trap, and the
    `A && pass || fail` assert idiom in which `pass` cannot fail. A
    default-severity gate would be red the day it was written, and a gate that
    can only be disclosed teaches that disclosure is normal. `-S error` is the
    severity at which the whole set is clean today, which is what makes it
    enforceable today. If a future round wants the warnings, it raises the
    severity **and** clears them in the same commit — never one without the
    other.

    **It cannot certify an empty sweep**, which is the property a derived file
    list most needs. If the expression ever returns nothing — a branch that
    touched no `*.sh`, or an expression someone broke — `shellcheck` answers
    `No files specified.` and **exits 3**, not 0. A gate whose probes match
    nothing must fail rather than report clean (`00-vision.md` §7 rule 2);
    measured, not assumed. **The two-line preamble does not weaken this**: when
    every derived path is gone the filtered list is empty, `shellcheck` receives
    no arguments, and the run still exits 3. Measured on a scratch repo whose
    branch deletes its only `*.sh`.

    **Why the list is filtered before it is linted — round 805's second
    non-blocker, amended here where it is enforced (standing rule 2).** The
    derived list names every `*.sh` the branch *touched*, and a delete is a
    touch. The unfiltered form handed the vanished path straight to the linter,
    which answers with a **filesystem** error, not a lint one. Measured on a
    scratch repo — a branch adding `added.sh` and deleting `doomed.sh`, the two
    files made textually distinct so git records a `D` and not an `R`, which a
    first attempt at this measurement got wrong:

    ```
    doomed.sh: doomed.sh: openBinaryFile: does not exist (No such file or directory)
    exit=2
    ```

    **What is actually broken is the exit code, and that is worse than it
    looks.** The surviving files *are* still linted — run again with a
    deliberate SC1125 in `added.sh`, the finding is printed. But the run exits
    **2** either way: 2 with a clean `added.sh`, 2 with a broken one. So a
    branch that retires a script cannot exit 0 by any means available to it —
    the unsatisfiable shape standing rule 2 forbids, reached by a route nobody
    typed — and for as long as it is in that state the gate's own verdict stops
    telling clean from dirty. A gate whose pass and fail are the same number is
    not a gate.

    The filter drops only paths absent from the tree and **names each one on
    stdout** — a disclosed skip is not a silent one, and a reviewer reading
    `deleted on this branch, not linted: …` can check the delete was intended.
    Re-measured after the change: the delete case exits **0** with the note and
    `added.sh` linted; the same case with SC1125 planted in `added.sh` exits
    **1** with the finding; the pre-fix `await-and-seed.sh` fed through the
    filtered pipeline still fails at exit **1**. Transcripts in
    `evidence/phase8-tooling.md` §6.2. The amendment removed a crash and no
    teeth.

    **What its silence does NOT prove.** SC2086 is an *info*, so this gate can
    never emit it. A quoting question must be settled by measurement at the
    site, not by a green run here — which is exactly how finding 1's second half
    was answered (`evidence/phase8-tooling.md` §6.1).

    **Its own trap, recorded because it is not guessable.** A comment line that
    *begins* with the hash, a space and the linter's name is parsed as a
    directive anywhere in a file, prose included — the paragraph explaining
    finding 1 produced SC1073/SC1072 until it was reworded. Re-run the gate
    after any comment that discusses it.

    *Prerequisite, checked by the command itself: `shellcheck` 0.9.0 at
    `/usr/bin/shellcheck`. If it is ever absent, that is a **finding** naming
    this item — not a silent skip. A missing linter reporting nothing looks
    identical to a clean tree, which is the failure mode `00-vision.md` §7 rule 3
    is about.*

11. **The SQL is executed (round 812 finding 1, added round 813 — the
    instrument nobody was required to run).** `bash scripts/check-schedule-sql.sh`
    exits 0. It provisions a throwaway PostgreSQL cluster, points
    `schedule-source.test.ts` §4.2 at it, and reports non-zero if any shipped
    statement fails to resolve.

    **Why it is a gate and not a nicety, measured rather than argued.** Round
    811 wrote this script — the only instrument that puts
    `schedule-source.ts`'s statements in front of a server, and the only SQL
    instrument in the repo that **provisions its own** cluster rather than
    consuming a scratch database somebody prepared first (`check-scheduler-sql.sh`
    executes the *scheduler's* SQL from `db/projects.ts`, is a phase-2/3 gate in
    §3.2, and refuses without `$SCRATCH_DATABASE_URL`) — and wired it into no
    gate list at all:
    §3.1, §3.2, §4 and `04-phases.md` were silent, so the one command that runs
    the SQL depended on a reviewer remembering it. Round 812's reviewer measured
    what that costs. Swap the two `OR` arms of `RUNS_SQL`, keeping `$1::uuid`
    verbatim, and at round 811's bytes `pnpm test` reported **31/31 green** and
    `tsc --noEmit` **exit 0** — every gate this document listed passed — while a
    real Postgres answers `operator does not exist: text = uuid`, SQLSTATE
    `42883`. That is round 810's death with the operands transposed, reaching
    the deploy through a fully green board.

    **`check-instrument-identity.py` does not cover this, and it is worth being
    exact about why.** It goes red only because the digest moved, and its own
    message says *"re-run the transcript or amend the document"* — re-derivation
    is the prescribed workflow, and it clears. It certifies that the pasted
    numbers describe the bytes on disk; it says nothing about whether those
    bytes resolve.

    **Round 813 also closed the specific mutant one layer earlier, and that does
    not retire this item.** `schedule-source.test.ts` §4.1 now asserts the
    ORDER of the two `$1` sites, so the transposition is caught by `pnpm test`
    alone (measured on a shadow tree: 2 of 34 static tests fail, exit 1). But
    the *class* is what this item guards — a statement that typechecks, that no
    unit test can parse-analyze because NF3 forbids the suite opening a
    connection, and that fails only inside the server. Only the server closes
    that class. A static assertion added per-mutant is a patch on the last bug;
    executing the statement is the gate.

    **It is written to be passable and it is measured passable.** At round 813
    it reports `# tests 40 # pass 40 # fail 0 # skipped 0`, exit 0, in under a
    second of test time on a cluster that takes a few seconds to provision (at
    round 811: 36/36). It creates that cluster in a fresh directory, on a unix
    socket, with `listen_addresses=''` — no network listener, no configured
    database touched, no live data read — so it is runnable from a **build**
    task under the worktree-only policy (§2.3), which is the property that makes
    it gateable at every phase rather than only at the deploy.

    **It cannot certify a skip**, which is the failure mode its own subject
    matter is made of: §4.2 is skipped unless `SCHEDULE_SOURCE_TEST_DSN` is set,
    and `node:test` counts a fully skipped suite as one passing suite reporting
    `# skipped 0`. So the script greps its own output for the skip marker, for
    the regression test **by name**, and for at least one pass, and exits 1 on
    any of the three before it reports the runner's status.

    *Prerequisite, checked by the command itself: PostgreSQL server binaries
    (`initdb`, `pg_ctl`, `createdb`; Debian/Ubuntu `postgresql-<v>`, found at
    `/usr/lib/postgresql/*/bin` or on `PATH`), and — when run as root, which
    cannot own a cluster — a `postgres` system user. Absent, the script exits
    **1** naming what is missing. It never skips, for item 10's reason: a
    missing tool reporting nothing looks identical to a clean tree. Measured
    here on PostgreSQL 16.14.*

    *It leaves its scratch cluster on disk and prints the path. That is
    deliberate — this repo reserves `rm -rf` for an explicit instruction — and
    is a disclosed cost, not an oversight.*

### 3.2 Phase gates

**Phase 1 — schema, fixture, replica harness**
- `scripts/checks/check-migration-0040.sh` green, output pasted, including the
  "second application changed 0 rows" line.
- `migrations.test.ts` names `0042_task_graph.sql`.
- The fixture exists, has > 100 rows, and contains **no brief text** — the
  reviewer greps it for `curl`, `http`, and any string over 500 chars.
  **Amended at capture (round 102).** The row count holds: the capture is 131
  rows, so the `> 100` clause is satisfiable and stands unchanged. The grep
  clause was **not** satisfiable as written, and is restated here rather than
  disclosed-and-ignored. `grep -ci 'curl\|http'` over the captured fixture
  returns **1**, on a real task *title* — row `127e1b38-d981-483f-9502-4733f791a3d2`,
  round 904, `status: done`: *"U34 production verification: live endpoint curls,
  dark+light screenshots, and proof the four shipped features are actually
  live"*. That is live data, and R9's rule is that the six projected fields are
  copied faithfully; redacting or editing a title to make a grep return zero
  would corrupt the replay input to flatter an instrument. So the gate now reads:
  **`grep -ci 'curl\|http'` must return 0, or every matching line must be a
  `"title":` line already recorded in the fixture's sibling `.md` by row id.**
  A match on any other key, or on an unrecorded row, is a finding. The intent —
  no brief text, no prompts, no run ids, no secrets — is unchanged and is proved
  by the stronger mechanical clause the sibling `.md` reports: every element has
  **exactly** the six keys `{id, round, role, title, status, created_at}` and no
  others, and no string value exceeds 500 characters (longest observed: 127).
  Brief text cannot enter a document whose key set is closed.
- The replay harness runs and prints its SHA and row count. It may legitimately
  **fail** at this phase if phase 2 has not landed; the gate is that it runs and
  reports, not that it passes.
- **Added round 106.** The six R18 comparison cases stay `todo`, but the `F13`
  block is **not** `todo` and must be green: the frozen closure names no
  post-migration row, a mixed input carries real rounds while a pure-graph one
  withholds them, `graphInput()` refuses a snapshot it cannot honour, and
  today's rule demonstrably holds the captured pending rows behind an appended
  fix chain. Those four run without `graphReady()`, so every premise R69 rests
  on is proved at phase 1 rather than promised for phase 2. Each `todo` must
  report exactly `task-graph: readyRule() lands in phase 2 (R12)` — any other
  message means a legacy-side expectation is wrong and the body was never
  exercised.

**Phase 2 — graph scheduler**
- **The replay test passes.** This is the phase's whole point. All **six** cases
  (R18 a–f). Divergence output, if any, is pasted verbatim.
- **R69, the legacy-row term, is implemented** in `graphReady()` and in the
  graph branch of `promoteReadyTasks()`'s statement (E3, `02-architecture.md`
  §9.2). Case (f) is the test that fails without it. The reviewer checks that it
  was made to pass **by the term** and not by widening the harness's
  migration-time snapshot — the one way to make case (f) green while leaving F13
  wide open. Round 106 measured both: closure-only leaves (a)–(e) green and (f)
  diverging on tick 2; with the term all six agree
  (`evidence/phase1-migration.md` §13.4). Reproducing that mutation is the check.
- `grep -n "TODO(R12-retire)"` covers R69's site as well as R12's — the two
  retire together (standing rule 4) and a term left behind would silently
  re-serialize projects that have no legacy rows left.
- `check-scheduler-sql.sh` green, including the dangling-dependency case landing
  on `blocked` and **not** on `ready`.
- **Added round 204, from the fix cycle.** R14 is a guarantee about every route
  into `running`, not about the promote statement alone, and the reviewer checks
  all four of the paths the round-203 review found open: `retryTask()` (and
  therefore `unwedgeProject()` and `POST /api/tasks/:id/retry`) refuses a row
  whose `depends_on` is still corrupt, naming the ids, and is not overridable with
  `force`; a corrupt row sitting at `ready` with no run is swept; a duplicated id
  is refused by `graphReady()` and by the SQL alike; a cross-project id resolves
  to nothing in both. Cases 8, 8b, 9 and 10 of `check-scheduler-sql.sh` are the
  proof, each observed failing against the unfixed code
  (`evidence/phase2-fix-cycle-1.md` §4).
- **The reviewer asks of any claim in a doc-comment or in this corpus: does the
  named instrument actually execute it?** Round 203 found four places crediting
  the R18 replay with proving R17's contention clause, which it cannot — it
  imports neither `conflicts` nor `selectClaimable` and has no claim step. The
  check is mechanical: mutate the rule the claim is about and watch the named
  instrument. If it stays green, the claim is wrong.
- The reviewer states, in its own words, what would have made the replay test
  report a pass **wrongly** — e.g. a harness that runs both rules over the same
  backfilled array without actually applying the legacy rule; a fixture whose
  every task is already `done`; a tick loop that terminates before divergence.
  Then it checks that each of those is impossible. (Standing rule 3.)
- **`scripts/checks/check-r20-census.py` exits 0**, and
  `scripts/checks/check-r20-census.py --self-check` with it (R20). This replaces
  *"`grep -n "round" forge-control/src/db/projects.ts` with a justification for
  every surviving occurrence"*, **amended round 206 where it is enforced**. The
  grep was discharged by a hand-written table in `evidence/phase2-replay.md` §7
  and that table went stale twice — round 205 found its headline counts reading
  85/92 against a file of 99/108. Eleven of the nineteen `round` lines the fix
  cycle added are the literal citation "round 204", which recurs every cycle, so
  the gate as written was one no fix cycle could leave satisfied. The script
  discharges the same requirement and strictly more of it: it regenerates §7's
  census from the file, fails when the committed region is stale, fails when a
  symbol carrying `round` has no attribution, and — the part the grep never
  did — fails **by name** when a scheduling predicate reads `round` outside the
  labelled legacy surface. Reviewers may still run the grep; it is no longer the
  artefact.
- The reviewer confirms the census gate can fail, rather than trusting a green
  run: the mutations of `evidence/phase2-cycle-2.md` §3 (stale region, new
  predicate, unattributed symbol, altered attribution rule) each turn it red,
  and each is reproducible from that document. Mutation 5 of that section is the
  one to read first — the gate is also checked **after being committed**, since
  a region stamped with `git HEAD` goes stale the moment it lands and would have
  made this very gate unsatisfiable.

**Phase 3 — task creation, validation, cycles**
- `check-task-api.ts` green, with the 400 bodies pasted — cycle path named,
  dangling ids named, bad write-set entry named.
- The cycle table (R25) is complete: seven rows, each asserting the path's ids.
- The reviewer confirms R26's belt comment exists and is honest — a detector
  documented as unreachable is a detector nobody deletes by accident.
- Double-POST with an identical body → exactly one row, `409` on the second
  (R30).

**Phase 4 — worktrees, integration, consolidation** — *highest risk, red team required*
- `check-workstream-e2e.sh` green, with the conflict case's non-zero exit and
  named files pasted.
- `git status --porcelain` in the main worktree empty after a second workstream
  exists (R34).
- **Every existing reconcile test passes unmodified** (R43). The reviewer runs
  `git diff main -- forge-control/src/lib/project-reconcile.test.ts
  forge-control/src/lib/cp2-reconciler-interaction.test.ts` and confirms it is
  empty, or reads the commit-message justification for each hunk.
- `grep -rn "merge" forge-control/src` with a justification for every hit; the
  reviewer confirms there is no path that merges a workstream branch without a
  task (R38, N3).
- **Adversarial reviewer** (see §5).

**Phase 5 — prompts**
- `grep -rn "consecutive rounds" forge-control/` is **empty** (R49). The old
  `PARALLELISM_GUIDE` is deleted, not commented out, not left unreferenced.
- Prompt-content assertions for R47–R53 green.
- Prompt-length budget assertion green (NF7), and the reviewer reads the built
  planner prompt end to end once, as a planner would, and says whether it is
  followable. A prompt that passes a `.includes()` check and confuses a planner
  is a passing gate on a broken deliverable.

**Phase 6 — observability**
- `check-plan-store.ts` green.
- The reviewer loads the `/plan` response for a fixture project and confirms
  `deps` are real edges for graph rows and synthesised for NULL rows, and that
  the response shape is unchanged from the base commit (diff the TypeScript
  interface).
- **Added round 223 — the universal gate does not compile four of this phase's
  six code files, so this phase adds the check that does (standing rule 2).**
  §3.1's `cd forge-control && pnpm typecheck` runs `tsc --noEmit` against
  `forge-control/tsconfig.json`, whose `include` is `["src/**/*.ts"]`. Phase 6's
  web half — `planApi.ts`, `planStore.ts`, `PlanKanban.tsx` and `app/api.ts` —
  lives in **`forge-control-web/`**, a separate project with its own
  `tsconfig.json` that the universal gate never invokes. Without the block below
  the gate would report "`tsc --noEmit` clean" for a phase whose principal
  deliverable was not compiled at all: the same species of failure as phase 7's
  `measure-schedule.ts` gap ("Added round 212" above), and the same repair —
  amend the gate where it is enforced rather than disclose it. The gating
  reviewer runs all four lines and pastes them:

  ```bash
  # PRECONDITION. This worktree ships WITHOUT forge-control-web/node_modules
  # (gitignored), so `npx tsc` in a fresh worktree answers "tsc: not found" —
  # and a gate whose first response is an error is a gate that gets
  # disclosed-and-ignored. MEASURED, round 221: this completes offline in ~1s
  # from the local pnpm store. Keep --frozen-lockfile: it is what guarantees the
  # NFU8 diff below stays empty.
  cd forge-control-web && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline

  cd forge-control-web && npx tsc --noEmit          # exit 0
  cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-plan-store.ts
  git diff main -- forge-control-web/package.json   # MUST be empty (NFU8)
  ```

  Adding `../forge-control-web/**` to `forge-control/tsconfig.json` was rejected
  for the reason phase 7 rejected `../scripts/**`: it would change what **every
  other phase's** typecheck covers, and the two projects have different
  compiler options (JSX, DOM lib) that phase 6 does not own.
- **`check-plan-store.ts` prints its own provenance and censuses itself
  (standing rule 3, added round 223).** Its first output line is a header
  carrying `git rev-parse --short HEAD`, the branch, whether either subject file
  is uncommitted, the **sha256 of `planStore.ts` and `planApi.ts`**, the
  fixture's node count and the number of assertions it is about to run; its last
  is a census that exits **non-zero when the assertions executed differ from the
  hand-declared count in either direction**. The reviewer confirms both can
  fail rather than trusting the green run — the three mutations of
  `evidence/phase6-plan-api.md` §3.4 are reproducible, and the third is the one
  to read first: it prints **zero FAIL lines and still exits 1**, because the
  table declared a case it never reached.

**Phase 7 — measurement**
- The script runs against the fixture and prints its header (SHA, schema
  version, project id, row counts) **before** any number (R60).
- Fed a truncated fixture it exits **non-zero** (R61). The reviewer runs this
  case; an instrument that degrades quietly is worse than none.
- The baseline file for 8ea0cc08 exists and its header names the script's SHA
  (R62).
- **Added round 212 — the universal gate does not reach this phase's principal
  deliverable, so this phase adds the check that does (standing rule 2).**
  `forge-control/tsconfig.json` reads `"include": ["src/**/*.ts"]` — verified at
  git SHA `126969acd55985d9d7c79d63877718a55794349b` and still reading that at
  `5a1180d17af78c77fcbd8bd2fede1d3ded4808c4`. `scripts/measure-schedule.ts` lives
  at the **repo root**, outside that include, so `pnpm typecheck` — item 1 of
  §3.1, and the only typecheck any phase runs — never examines it. Without the
  line below the universal gate would report `tsc --noEmit clean` for a phase
  whose principal deliverable had not been compiled at all: a gate passed by a
  file nobody looked at, which is the same species of failure as a probe that
  never touches its target. The gating reviewer runs this and pastes it:

  ```bash
  cd forge-control && ./node_modules/.bin/tsc --noEmit --strict --target ES2022 \
    --module ESNext --moduleResolution bundler --allowImportingTsExtensions \
    --resolveJsonModule ../scripts/measure-schedule.ts
  ```

  Adding `../scripts/**` to `forge-control/tsconfig.json`'s `include` was
  rejected deliberately: it would change what **every other phase's** typecheck
  covers, and phase 7 does not own that decision.

  The reviewer confirms the check is not vacuous by re-running it with
  `--listFiles` and finding `src/lib/schedule-source.ts` and `@types/pg` in the
  program — the wrapper reaches its database reader through a dynamic
  `await import()`, and a compile that resolved neither would be clean for the
  same reason an unread file is clean.
- **Added round 212 — `full` never degrades to `rounds` (R61).** The instrument
  takes a named subcommand, and the reviewer confirms the two modes do not leak
  into one another: `full` over a task-only fixture exits non-zero naming the
  missing `runs` key rather than printing the round table, and `full` over a
  4-row fixture exits non-zero on `too-few-tasks` having printed its header and
  **no** table. `rounds` prints, in its own header, the constant
  `S1, S2, S3 NOT COMPUTED — this mode reads no run data and claims no
  concurrency result.` A `full` run that emitted a smaller, prettier table and
  announced the degradation only in its exit status is the failure R61 names, and
  it is a finding.

**Phase 8 — deploy and verify**
- See `04-phases.md` §Phase 8. The gate is the deploy checklist itself, plus the
  clauses below — the first two added round 215, the last three round 802.
- **TWO MERGES, TWO DIFFERENT ANSWERS ON A CONFLICT — amended round 802 (phase
  8C), in the same commit as `04-phases.md` §Phase 8 step 2 which it enforces.**
  The step used to say **"on conflicts STOP"** of both merges at once. Measured
  at round 800 and re-derived at round 801: `main` had moved **55 commits** and
  `git merge-tree --write-tree main HEAD` reported **three** content conflicts
  (`forge-control/src/routes/chat.ts`, `.../team/planApi.ts`,
  `.../team/PlanKanban.tsx`). Read across both merges, STOP made phase 8
  permanently undeployable — it forbade the very work that makes the deploy
  merge clean. **The amendment is a distinction, not a relaxation**, and the
  reviewer checks both halves:
  - **Merge 1, `main` → work branch, in the WORKTREE:** conflicts **RESOLVED**
    by a briefed task that read **both sides**, reviewed before anything ships.
    The reviewer confirms **no `-X ours` and no `-X theirs`** appears in the
    merge record — a strategy option resolves in favour of whoever finishes
    last, which is silent clobbering in a new costume — and that no conflict
    marker survives in the tree. Round 801's three conflicts, six hunks and
    resolutions are in `evidence/phase8-merge.md` §3; §6.6 drives the merged
    `chat.ts` through `check-plan-api.ts` and §5 re-derives the phase-6 claim on
    the merged file, because a resolution is not proved by compiling.
  - **Merge 2, work branch → `main`, in the LIVE checkout:** **STOP**, verbatim
    and unrelaxed. A conflict there means the branch was not prepared, and
    resolving it inside an irreversible deploy step is how a silent clobber gets
    shipped. If merge 2 conflicts, the answer is to go back to merge 1.
- **R14 MUST BE CONFIRMED PRESENT IN THE TREE THAT IS ABOUT TO SHIP, BEFORE THE
  RESTART, and the confirmation stated explicitly in the deploy report — added
  round 802 (phase 8C).** This is not a belt-and-braces re-test. Round 203
  **measured**, not theorised, that `retryTask()` moved a swept task
  `blocked → ready` where neither the sweep nor `promoteReadyTasks()` could see
  it, and `claimReadyTasks()` claimed it anyway.
  `/opt/ai-os/scripts/fleet-watchdog.sh` runs on cron **every 10 minutes**,
  calls `POST /api/projects/:id/unwedge` on every blocked project, and
  force-retries once when both quota windows are clear. So the first blocked
  project after the graph engine ships has that exact path exercised
  **unattended, by a robot, within ten minutes** — this project ships an
  automated caller of its own one known correctness hole.
  **Verified the way round 203 verified it:** by driving the **shipped**
  functions against a scratch database through `retryTask()` → `claimReadyTasks()`
  and showing the task does **NOT** reach `running` —
  `scripts/checks/check-scheduler-sql.sh` **cases 8, 8b, 9 and 10**, output
  pasted. **A unit test that never calls `retryTask()` proves nothing here**: the
  defect was in the SQL's visibility, not in a predicate a mirror could model.
  **If for any reason the fix is not present in the shipping tree, the gate says
  plainly: the watchdog must be DISABLED until it is.** Do not ship the
  scheduler with an automated caller of a hole it still has.
- **E-3's baseline read happened at step 2b, BEFORE step 3 applied migration
  0040.** Check the order in `evidence/phase8-deploy.md`, not the intent. Round
  214's phase-7 finding 1: 0040's R6 backfill overwrites the
  `depends_on IS NULL` sentinel with the strictly-lower-round closure, under
  which every S3 term is 0 by construction — the instrument certifying "no
  numbering stall" for the project whose numbering stall justified this work.
  Two independent things must both hold, and the gate fails if either is
  missing: the ordering above, **and** a header line reading
  `closure-shaped-rows=0` in the pasted baseline output. A non-zero count on the
  8ea0cc08 baseline means the read happened after the migration whatever the
  narrative says.
- **Read the S3 line correctly — amended round 217, round 216's finding 2, in
  the same commit as the step-2b prose it enforces.** This clause used to say
  that a `NOT COMPUTABLE` S3 meant the detector had caught a late read. Half of
  that was wrong, and it would have failed a correct deploy. **S3 is NOT
  COMPUTABLE at step 2b too**, and necessarily: before migration 0040 there is
  no `depends_on` column, so every row is a legacy row and D7's first arm
  refuses. Judge the refusal by its **counts**, which is what makes this gate
  satisfiable:
  - `S3 … NOT COMPUTABLE (131 legacy rows, 0 closure-shaped rows)` — the
    **PASS**. The read happened before the migration and the refusal names the
    legacy sentinel.
  - `S3 … NOT COMPUTABLE (0 legacy rows, N closure-shaped rows)` — a **finding
    and a redo**. `legacy-rows=0` on a project that has never been graph-planned
    means the backfill already ran; the detector caught a late read.
  - **Any S3 number at all for 8ea0cc08** — the worst outcome, and a finding
    whatever the ordering claims, because the only shape that produces one is
    the backfilled closure computing tautologically to 0.
  S1, S2, the run count, the mean run duration and the wall clock are what part
  2 actually owes (R62); those must be present and are unaffected by the
  migration either way.
- **Instrument identity, before the append.**
  `python3 docs/plan/engine-task-graph/check-instrument-identity.py` must exit 0
  *before* part 2 is appended to `evidence/baseline-8ea0cc08.md`. If **either
  half** of the instrument has moved since part 1 was written, part 1's seven
  commands are re-run and their headers replaced **in the same commit** that
  appends part 2 — see `04-phases.md` §12, E-3, and the re-run record in §1 of
  that file. A part 2 whose header disagrees with part 1's breaks R62's
  one-instrument guarantee. *Round 811 discharged this in advance: both halves
  moved, and part 1 was re-run then rather than deferred to the append, because
  deferring would have left this gate red across the intervening rounds.*
- **R31 must not reach production ahead of R47–R53.** R31 (`strict_write_sets`
  → a `builder`/`tester` task with no `write_set` is a `400`) is enforced from
  phase 3; the behaviour that satisfies it — planner, architect and builder
  prompts that declare a `write_set` — lands in phase 5. Today's shipped prompt
  in `project-tick.ts` mentions `write_set` **zero times**. Because there is
  exactly one deploy, at phase 8, no window exists in practice; this clause
  exists so that a phase-8 task tempted to ship early cannot open one. Verify
  before the restart: `grep -c "write_set" forge-control/src/lib/project-tick.ts`
  is **> 0**. If it is 0 while R31 is live, the first goal project created after
  the restart `400`s on its first builder fan-out.

---

## 4. What the reviewer must run, in one block

Copy-pasteable, for every phase's gating reviewer:

```bash
set -x
cd "$WORKTREE/forge-control"
pnpm typecheck
pnpm test
cd "$WORKTREE"
git -C /opt/forge-ai-os status --porcelain ; echo "exit=$? (empty output is the only pass)"
git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
# R66, amended round 215 — EXECUTABLE FILE TYPES ONLY, and no -v filter.
# THE ASSERTION IS R66'S RULE: every hit is a string literal inside a sentence
# forbidding the command. READ EACH ONE. Any hit in an EXECUTABLE position is a
# finding regardless of the count. Prose files are swept separately below.
# The count is a TRIPWIRE, not the assertion, and it is restated whenever the
# tree gains a prohibition — see the reconciliation note below (round 802).
# Expect exactly 4 hits: project-tick.ts ×2, project-tick.test.ts ×2.
grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
grep -rn "consecutive rounds" forge-control/         # must be empty from phase 5 on
# Round 217, §3.1 item 7 — instrument identity. Exits 0, or names every document
# that quotes a dead one. Reads the disk, not the corpus's claims about the disk.
python3 docs/plan/engine-task-graph/check-corpus-map.py
python3 docs/plan/engine-task-graph/check-instrument-identity.py
# §3.1 item 8 — the R20 census. Exits 0, or names the scheduling line that reads
# `round` without a justification / the generated region that no longer matches
# the file. Re-measures; never trusts the document.
python3 scripts/checks/check-r20-census.py
# §3.1 item 9 — the instruments are the least-verified code in the repo. Exits 0,
# or names the manifest script that no longer typechecks / the scripts/checks/*.ts
# this branch touched and did not list. One tsc invocation per file, from
# forge-control/ (that is where @types/node resolves) — see §3.1 item 9's traps.
bash scripts/checks/check-instrument-typecheck.sh
# §3.1 item 10 — shell lint. Exits 0, or names the *.sh this branch touched that
# fails at ERROR severity. The file list is DERIVED (no-merges main..HEAD), not
# typed, for the same reason as item 9's: a merge commit carries main's files.
# -S error is deliberate and its limits are stated in item 10 — do not raise the
# severity here without clearing the warnings in the same commit.
# A path this branch DELETED is on the derived list and not on disk; unfiltered it
# aborts the linter at exit 2 before the surviving files are read (item 10). Absent
# paths are named and skipped; an all-absent list still leaves shellcheck at exit 3.
SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
for f in $SH_ALL; do [ -f "$f" ] || echo "deleted on this branch, not linted: $f"; done
shellcheck -S error $(for f in $SH_ALL; do [ -f "$f" ] && printf '%s\n' "$f"; done)
# §3.1 item 11 — the SQL is EXECUTED. Exits 0, or names the shipped statement a
# real Postgres refuses. `tsc` cannot see inside a query string and `pnpm test`
# opens no connection (NF3), so this is the only command in this block that puts
# any shipped SQL in front of a server, and the only one that needs no scratch
# database prepared in advance. (`check-scheduler-sql.sh` covers db/projects.ts,
# but it is a §3.2 phase gate and arrives via the last line below.) It is here
# because without it a
# transposition of RUNS_SQL's two OR arms passed every OTHER line above — 31/31
# green, tsc 0 — while Postgres answered `text = uuid`, 42883 (round 812 finding
# 1). It provisions its own throwaway cluster on a unix socket with no listener,
# so it is safe from a build task; it exits 1, never skips, if the server
# binaries are missing or if its suite was skipped rather than run.
bash scripts/check-schedule-sql.sh
# Round 902 — the prompts' claim about the renderer, EXECUTED. Exits 0, or names
# the payload shape that does not render the way SCREENSHOT_CONVENTION and
# buildSystemPrompt() say it does. It is here and not in `pnpm test` because the
# claim spans two packages and forge-control's suite cannot import the web app;
# it needs no database and no git repo, so a build task may run it.
(cd forge-control-web && npx tsx ../scripts/checks/check-screenshot-render-shapes.ts)
# Round 960 — GRAPH_GUIDE's workstream bullet, EXECUTED against the scheduler.
# Exits 0, or names the claim the engine no longer honours. Run from
# forge-control/ (that is where @types/node resolves — item 9's trap (a)); it
# imports forge-control/src only, opens no connection and needs no git repo, so
# a build task may run it. It is here rather than in `pnpm test` for the reason
# the line above is: a substring gate cannot tell a true clause from a false
# one, and the criterion this check replaced passed every substring gate in the
# repo for eight rounds.
(cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-workstream-claim.ts)
# plus this phase's scripts/checks/* from 03-quality.md §3.2
```

**Why this gate changed — round 214's phase-3 finding 5, amended here where it
is enforced.** The command used to sweep `*.ts`, `*.sh` **and `*.md`** and pipe
through `grep -v -i "never\|forbidden\|not to deploy"`, under the comment
`# any survivor is a finding`. Two things were wrong with it.

The filter is a **narrower rule than R66's own**, which forbids the string
*"except inside a sentence forbidding it"* — a sentence may prohibit without
using any of those three spellings. Twelve survivors came out of it on this tree
and **every one was prose prohibiting the command**: `00-vision.md`, R66 itself,
this document's own gate line, `deploy-playbook.md`, two evidence files. The gate
could never be clean, on this tree or any future one, and three consecutive
reviewers disclosed-and-proceeded against it. **A gate that can only be disclosed
teaches that disclosure is normal**, and that habit is what let a self-certifying
hover probe survive round 213 (`00-vision.md` §7 rule 2).

The repair is a scope narrowing plus an honest instruction, not a cleverer
filter. **Scope:** a `.md` cannot execute anything, and every `.md` hit in this
corpus is a prohibition by construction — the documents that discuss R66 are the
documents that forbid it. Sweeping `*.ts` and `*.sh` leaves **4 hits, a number
small enough to read**, and reading them is what R66's rule actually requires:
all four are string literals *inside* NEVER-worded prohibitions — two in
`project-tick.ts`'s shipped deploy guidance, two in `project-tick.test.ts`
asserting that guidance still carries the prohibition. **Instruction:** the
comment now states R66's rule and names the expected count, so a fifth hit is a
signal rather than noise, and no `grep -v` decides on the reviewer's behalf.

**The count re-measured after round 801's merge, and the rule that keeps it from
going stale — round 802 (phase 8C).** Re-run at `3dd39b4`, after `main`'s 55
commits landed on this branch, the sweep returns **4 hits, unmoved**:
`project-tick.test.ts:216` and `:217` (a regex and its assertion message, both
asserting that the shipped `DEPLOY_GUIDE` still carries a NEVER-worded
prohibition), `project-tick.ts:410` and `:571` (the two shipped prohibitions
themselves). Every one read; all four are string literals inside sentences
forbidding the command. **`main` brought fifteen new `scripts/checks/*.ts` and
none of them mentions the command.**

**How the count is reconciled rather than disclosed.** A stated count is a gate
whose value the *next commit* can falsify — and a gate whose stated count is
stale is a gate that gets disclosed and ignored, which is the failure mode §4
was rewritten in round 215 to remove. So the rule, stated where the count is:
**when the tree gains a legitimate prohibition, the reviewer re-measures, reads
every hit, and restates the expected count in this block in the same commit,
naming each new hit and the sentence that forbids it.** The assertion never
moves — *every hit inside a prohibition, no hit in an executable position* — only
the tripwire's current value does. Round 802 is the first round to run this rule:
builder 8D adds `scripts/checks/check-instrument-typecheck.sh`,
`scripts/checks/check-await-seed.sh` and `scripts/deploy/await-and-seed.sh` in
this same round, all `*.sh` and therefore all inside the sweep's scope. If any of
them carries the string in a prohibition, round 803's reviewer restates the
expectation as **4 + N** with each new hit named here; if the count moves without
such a hit, that is a **finding**, and the deploy does not proceed on it.
Re-measured **after** those three landed: **still 4** — none of them mentions the
command.

**A new carrier the sweep does not cover, found by that re-measurement, and
ruled here.** Round 802 is the first round to add `*.json` **task payloads**
(`scripts/deploy/payload-*.json`, POSTed to `/api/projects/:id/tasks`), and
`payload-review.json` contains the string **once** — inside the reviewer brief's
copy of §4's own command block, i.e. as the `grep` that *enforces* R66. That is
the same shape as this document's own gate line, which round 215 examined and
kept. **Not a violation**: executed, the line greps; it does not restart
anything. **But the scope note matters more than the hit.** A payload is a
`brief`, and R66's own words are *"in any script, brief or doc"* — so a brief
that has become a **file** is inside R66's rule while sitting outside the sweep's
`--include` list. The sweep is not widened here, for round 215's reason: a `.json`
payload cannot execute, and widening the file types is how the gate became
unsatisfiable the first time. Instead the obligation is stated: **when a round
adds a new file type that carries briefs, the reviewer greps it separately and
records the result**, as done here. Measured at round 802:
`grep -rn "pm2 restart forge-executor" scripts/deploy/` → **1 hit**,
`payload-review.json`, the enforcing grep, read and cleared.

A CONSIDERED-AND-REJECTED ALTERNATIVE, recorded so the next round does not
re-derive it: narrowing to this branch's diff
(`git diff $(git merge-base main HEAD)...HEAD | grep '^+.*pm2 restart…'`) looks
tighter and is **not satisfiable here either** — this branch *created* the
corpus, so all ten prohibitive prose lines are `+` lines on it. Measured, round
215: 10 hits. It would have been the same unsatisfiable gate wearing a diff.

Then, before writing `VERDICT:`, answer in the review:

1. What would have made my instruments report a pass **wrongly**? Name at least
   two mechanisms and show each is impossible here.
2. Which gate in this document did I find unsatisfiable, and did I amend it
   where it is enforced in the same commit?
3. Every citation I made: symbol name or requirement id? Any line number pinned
   to a SHA?

Close with exactly one line, as the **last** verdict declaration in the message:
`VERDICT: PASS` or `VERDICT: NEEDS_FIXES` followed by a concrete numbered list.

---

## 5. Adversarial review — where and why

A red-team reviewer is briefed to **attack**, not to check, on the two phases
where a plausible-looking pass is most expensive:

**Phase 2 (scheduler).** Attack the replay proof. Try to make it pass while the
schedulers genuinely differ: feed it a fixture where every task is already
`done`; make the tick loop exit early; run both rules over the backfilled array
so "legacy" is not legacy at all; construct a task list where the closure
backfill and the round rule coincide by luck. Then try to make the *engine*
wrong while the test stays green: a dangling dep, a `depends_on` containing a
task of another project, a task whose dependency is `failed` rather than
`pending`, a project paused mid-promotion.

**Phase 4 (worktrees + consolidation).** Attack the isolation and the group key.
Two workstreams at the same computed round — do they get two chains or one? A
workstream whose integration task is skipped — does the project close with the
branch unmerged? `closeFinishedProjects()` marks a project done when every task
is `done`; an unmerged workstream branch with all its tasks done would close the
project **and lose the work**. Prove that cannot happen or find that it can.
Delete a workstream worktree from disk mid-run. Provision the same workstream
from two processes at once. Merge with a conflict and check nothing resolved it.

**The hand-renumber attack** (`02-architecture.md` §2.3.1, observed live during
round 0): with a fix chain already written for a group, change that group's
`round` by hand in the database and force a re-consolidation. Does the replay
compute a different `chain_key`, miss its own chain, and insert a second one?
`grep -n "SET round"` over the tree returns nothing — **no engine path writes
`round` after insert** — so this is reachable only by an operator with `psql`,
and an operator did exactly that to this project's own scout task at ~03:31 on
2026-08-17. The hazard predates this project and this project does not claim to
fix it. **Report the answer either way**; do not silently repair it in phase 4,
and do not report PASS on the grounds that it is pre-existing.

Both red-team briefs must say explicitly: **your job is to find the case where
this reports success and is wrong.** A red-team reviewer that returns PASS
without having attempted a named attack has not done the job, and its own
reviewer says so.

---

## 6. Regression surface — what this project could break, ranked

| Risk | Blast radius | Guard |
|---|---|---|
| Chain-key change breaks replay of an in-flight fix cycle | Duplicate fix builders in one worktree — bug 1 of the first night | R41's `main` special case; existing `chainKeys` tests unmodified; `insertChainRow`'s `occupied` branch blocks loudly rather than dropping the verdict |
| `depends_on` default releases legacy rows as roots | A live project's re-review runs before its fix builder | The NULL sentinel (§2.2 of `02-architecture.md`); R18-a; the deploy order in R64 |
| Group key change splits or merges a verdict round wrongly | A dropped verdict, or two fix builders | R40 + the new `cp2` case; the phase-4 red team |
| Contention belt too strict | Under-parallelism — the disease, silently | R17's empty-set rule; S1/S2 in the measurement |
| Contention belt too loose | Two agents clobbering in one worktree | `strict_write_sets` for new projects (R31); the reviewer write-set audit (R57) |
| Project closes with an unmerged workstream branch | Silent loss of a whole team's work | Phase-4 red team's named attack; the integration task is a task, so `closeFinishedProjects` cannot fire until it is `done` |
| Prompt regression | Planners produce unschedulable graphs | R47–R53 assertions; the phase-5 reviewer reads the prompt as a planner |
| Deploy kills runs in flight | Every live agent, including the deploy task | R63, R65, R66; `safe-restart.sh` detached, never `pm2 restart forge-executor` |

---

## 7. Definition of "green"

A phase is green when, and only when:

1. `pnpm typecheck` and `pnpm test` are clean, zero skipped.
2. That phase's `scripts/checks/*` are green and their output is pasted into the
   review.
3. The live checkout is clean.
4. Every requirement id assigned to the phase in `01-requirements.md` §K is
   named in the review with the artefact that proves it.
5. The reviewer answered §4's three questions.
6. `VERDICT: PASS` is the last verdict line in the reviewer's final message.

Anything less is `NEEDS_FIXES`. **Disclose-and-proceed is not a verdict.**
