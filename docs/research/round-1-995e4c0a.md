# Round 1 — D2 can-it-fail: research record

Project `aios-verification-that-bites`, workstream `audit`, run
`c2bcea3f-1fa1-4359-8d47-87714c10ced8`, 2026-08-25.

The deliverable is
[`docs/plan/artifacts/verification-that-bites/D2-can-it-fail.md`](../plan/artifacts/verification-that-bites/D2-can-it-fail.md)
— 27 gates, one verdict each, every transcript. **This file is the research
record behind it**: the sources actually opened this run, the external
primary documentation that the mechanical claims rest on, and the places where
a source and this repo disagree.

**No browser session was used.** Everything below came from either (a) a
command run in this worktree, transcript captured, or (b) a plain HTTP fetch
of a vendor documentation page. Nothing needed a login, so nothing needed the
`research-browser` profile stack and no login wall was hit. That distinction
matters for reproducibility: every source here is re-fetchable unauthenticated
by the next reader.

---

## 1. Headline result

Of the **25 gates that execute** in a default `gates-808.sh --strict` run,
**20 bite and 5 do not.** Two more (25, 26) never run at all without
`--browser` and are counted in the "27 gates" headline.

Round 0 named four non-biting gates. All four reproduce independently. **One
more was found — gate 24 — and a third, previously unreported cause was found
for gate 6.**

| gate | verdict | why it matters |
|---|---|---|
| 4 token purity | FROZEN-SCOPE | 7 hard-coded paths; nothing written after round 808 is its subject |
| 6 forbidden-file diff | INERT in its own use case | the engine-core guard passes over a live edit to `cc-runner.ts` |
| 7 forge-control untouched | INERT | body ends in a literal `exit 0`; its own name is false at HEAD (179 files) |
| **24 nav-walk-sampling.cjs** | **INERT — new** | reads zero repo files; a pure closed-form + fixed-seed simulation |
| 27 reproduce-cleanliness | INERT for its subject set | its two scripts write to `/tmp`; a sibling's write reddens it |

And **F5 is resolved**: `pnpm guard` — `package.json:7`, the repo's default
merge command — cannot return 0 in any tree state.

---

## 2. External primary sources, and what each one settles

### 2.1 `git diff A...B` compares commits, via the merge base

The whole of gate 6's finding rests on what the three-dot form does. Quoting
the git manual verbatim:

> "This form is to view the changes on the branch containing and up to the
> second *\<commit\>*, starting at a common ancestor of both *\<commit\>*.
> `git diff A...B` is equivalent to `git diff $(git merge-base A B) B`."
>
> — *git-diff Documentation*, git-scm.com, accessed 2026-08-25

That equivalence is the finding in one line. `git merge-base main HEAD` in
this worktree at the time of measurement was `259778b`, identical to `main` —
so the gate's input set is `259778b..HEAD` and **nothing in the working tree
appears in it at all**. The same page enumerates the forms that *do* see the
working tree, and the three-dot form is not among them:

> "`git diff [<options>] [--merge-base] <commit> [--] [<path>...]` — This form
> is to view the changes you have in your working tree relative to the named
> *\<commit\>*."
>
> — ibid.

**Consequence, not stated in either source (inference):** a guard whose stated
audience is *"an agent's worktree"* (`guard.sh:38`) and whose implementation is
a three-dot commit range is blind by construction at exactly the moment the
agent is working. The two halves were written by different rounds and neither
is wrong on its own.

Measured confirmation is in the deliverable §4.2 — three separate blind states,
each with a discriminating control (the gate goes RED before the state is
entered and GREEN after, over a byte-identical edit).

### 2.2 Node 22's test runner expands quoted globs itself

Gate 22 is one directory wide because `forge-control/package.json:test` is
`tsx --test src/lib/*.test.ts` — a **shell** glob. Node's own runner would do
better, and says so:

> "Alternatively, one or more glob patterns can be provided as the final
> argument(s) to the Node.js command… Glob patterns follow the behavior of
> `glob(7)`. The glob patterns should be enclosed in double quotes on the
> command line to prevent shell expansion, which can reduce portability across
> systems."
>
> — *Node.js v22.x Documentation — Test runner*, nodejs.org, accessed 2026-08-25

And when **no** path is given at all, its default discovery is already
recursive over TypeScript:

> "`**/*.test.{cts,mts,ts}` · `**/*-test.{cts,mts,ts}` · `**/*_test.{cts,mts,ts}`
> · `**/test-*.{cts,mts,ts}` · `**/test.{cts,mts,ts}` · `**/test/**/*.{cts,mts,ts}`"
>
> — ibid., default TypeScript patterns

**Verified on this toolchain rather than assumed** (node v22.22.2, `tsx` from
`forge-control/node_modules`): `tsx --test "src/**/d2glob-*.test.ts"` collected
one file from `src/lib/` and one from `src/routes/`, `# tests 2`; the current
unquoted single-directory form collected `# tests 1`. Full transcript in the
deliverable §8. So D4 has two documented shapes to choose between, both
measured on the actual binaries, not inferred from the docs.

### 2.3 Mutation-testing vocabulary — the two halves of a control

D3 is being asked to make "prove your check bites" cheap. The established
vocabulary is worth adopting rather than reinventing, and it names exactly the
distinction this repo keeps losing:

> **Killed:** "When at least one test failed while this mutant was active, the
> mutant is killed."
> **Survived:** "When all tests passed while this mutant was active, the mutant
> survived."
> **No coverage:** "The mutant isn't covered by one of your tests and survived
> as a result."
>
> — *Mutant states and metrics*, stryker-mutator.io, accessed 2026-08-25

with

> Mutation score: `detected / valid * 100`
>
> — ibid.

Note the distinction Stryker draws between **Survived** and **No coverage**:
both are green, and they are different defects. Mapped onto this repo's
findings — this mapping is **my inference, not in the source** — gates 4, 22,
23 and 27 are *no coverage* (the mutation is outside the subject set), while
gate 6's uncommitted-edit case and gate 15's boundary case are *survived* (the
subject is in scope, the assertion is too weak). They need different fixes:
widen the subject set versus strengthen the assertion. Collapsing both into
"the gate didn't fire" is how the last few rounds of this repo lost the thread.

The reason `check-secret-scan.ts` matters at all is the same taxonomy applied
one level up: a check with **no runner** is not even a surviving mutant; it is
a test suite that was never executed.

### 2.4 A note on where these sources do *not* help

Nothing external settles whether a given gate's **subject set** is the right
one — that is a judgement about this repo, and every such judgement in the
deliverable is backed by a command, not a citation. Where I could not construct
a reddening input, I said so and gave the structural proof (the code path) plus
the mutation that should have worked and did not. That is the brief's INERT
bar and it is met for gates 7, 24 and 27.

---

## 3. Internal sources — what was opened, measured, and disagreed with

Every claim below traces to a command run in this worktree today. Full
transcripts in the deliverable.

### 3.1 Corrections to documents I was handed

| document | claim | measured |
|---|---|---|
| `D1-execution-audit.md`, runner table | `gates-808.sh` runs "24 numbered gates" | **27.** The summary block prints `SUMMARY — 27 gates`; 25 execute, 2 SKIP without `--browser`. Counted independently from the 27 `gate`/`gate_sh`/`skip` call sites. |
| brief / round 0 | gate 6: "in this worktree local main == HEAD… so the diff is empty at every input" | **Needs one correction, and it changes the fix.** `main == HEAD` does *not* hide a NEW commit — I measured RED for one. It hides every commit already in `main`'s history, i.e. from the moment `main` is fast-forwarded onto the lane. Also, at measurement time this worktree had `main=259778b`, `HEAD=2209245`, so that state was **not** live here; the uncommitted-edit cause was. |
| fleet memory `forbidden-file-guard-does-not-bite` | "`gates-808.sh:163` carries the identical body and the identical hole" | **The diff is identical; the guard is not.** `guard.sh:162` wraps it in `git rev-parse --verify main` and SKIPs when the ref is missing. `gates-808.sh:163` has no such guard, and with no `main` ref it prints `clean — no engine/Files file differs`, EXIT=0, over a committed edit to `cc-runner.ts`. gates-808's copy is strictly weaker. |
| `PLAN.md` in this worktree | should be this project's plan; the brief asks to "resolve F5 from PLAN.md" | It is the **`aios-browser-takeover-live`** plan (a ticket-signed noVNC design). No F5, no D-numbers. The lane forked before this project's PLAN.md landed — fleet memory `commit-plan-md-before-seeding-tasks`. F5 was resolved from the brief's own description of it instead, and the answer is in §4 below. |
| brief, trap (a) at `check-dismiss-peek.tsx:193` | an undisclosed inert assertion | **Already disclosed, accurately.** The assertion is now at `:205` and carries a 20-line comment at `:123-142` naming the inertness, the mechanism, the values measured, and the two instruments that do catch the boundary. Every claim in it reproduces (5 fixture values, both directions, all green; the real boundary break green here and 3 FAILURES in `check-team-confirm.ts`). This is a fixed record, not an open defect. |

### 3.2 The measurement that surprised me

`gate 24 — nav-walk-sampling.cjs`. It reads **no repo file**:

```
$ grep -cE 'readFileSync|require\("\.|require\(.\.' docs/plan/artifacts/phase800/nav-walk-sampling.cjs
0
```

Its inputs are a literal `POLLS` table (`:148-153`), `WINDOW_MS = 30_000`
(`:88`) and `SEED = 808` (`:92`). Its 11 assertions are a closed-form formula
checked against a Monte-Carlo of the same formula. Empirically: I moved the
real chat-list poll to 11 s — `CHAT_LIST_POLL_MS` at
`forge-control-web/app/desktop/chat/pollBudget.ts:33`, the change that makes
its own headline assertion A4 false — and it printed `ALL PASS`, `EXIT=0`.

It is a correct and well-argued analysis. It is not a gate. One `readFileSync`
of `pollBudget.ts` plus a regex would turn it into one, and would have caught
that mutation.

### 3.3 The measurement that arrived by itself

At `07:49:26`, three seconds before one of my `git status` reads, a **sibling
task in this same shared worktree** modified
`docs/plan/artifacts/verification-that-bites/D1-execution-audit.md` and
`execution-audit.tsv`, and committed them as `b308ddb` around 07:52. I left
them alone.

That is not an interruption; it is gate 27's input. Gate 27 md5s
`git status --porcelain` **repo-wide** before and after running two scripts
that both write to `/tmp`. Its window is 0.51 s (measured). One untracked file
created 0.3 s in reddens it:

```
before: 5159ddbe4985314abe5800a3de4809f3
after:  2263b4e9a5e595a5164772a3aa2d8b58
FAIL — tree changed
GATE27_EXIT=1
```

while its own subject set cannot dirty the tree at all, because `OUT_DIR`
defaults to `os.tmpdir()` (`psql-argv-leak.cjs:61-62`). Blind to what it names,
sensitive to what it does not.

---

## 4. F5, resolved

`package.json:7` is `guard.sh --fast --strict`. `--fast` unconditionally
`skip_check`s phases 2, 3 and 4 (`guard.sh:199, 211, 232` — all in the `else`
arm of `if [ "$MODE" = "full" ]`). `--strict` sets `EXIT_CODE=1` on any SKIP
(`guard.sh:250`). Therefore `SKIP_COUNT ≥ 3` always in fast mode, and the exit
code is always 1.

Isolated from the inherited gate-5 red by running the identical command on a
tree with **zero** failures — an isolated clone at `b41e824^`, the commit
before the week-board palette:

```
PASS: 7   FAIL: 0   SKIP: 4
GUARD: RED — do not merge. Fix the failure(s) above and re-run.
GUARD_EXIT=1
```

`FAIL: 0`, exit 1, and no "FAILURES" section because there are none — the
verdict tells the reader to fix failures that do not exist.

**Does `--strict` mean anything in fast mode?** No. Its only effect is
"fail on SKIP", and in fast mode that fires unconditionally, so it is a
constant. Its documented purpose — *"nothing may be silently skipped"* —
is defeated precisely because the three skips are not silent: they are
deliberate, announced, and structural. The class `--strict` was built to catch
is the *other* kind, and one of those appeared in the clone run above:
`forbidden-file-diff SKIP — no local 'main' branch to diff against`.

Proposed shape (not applied — this changes every lane's merge command):
tag a `skip_check` as deliberate or environmental, and have `--strict` fail
only on the latter. `guard.sh` already draws that line in prose at `:193`
versus `:173`.

---

## 5. What the repo already gets right, and should be generalised

`scripts/checks/test-guard-discrimination.sh` (wired at
`package.json:guard:test`) is the model D3 is looking for: inject a defect,
assert the specific check goes FAIL, remove it, assert it goes back to PASS,
`trap cleanup EXIT`, and a residue check at the end. Its header states the
one insight that makes it survive a shared worktree — assert on the individual
check's row in `guard.sh --json`, **not** the overall verdict, because
*"~10 lanes editing it in parallel tonight"*.

Two things D3 must take from it, both measured today:

1. **It covers 3 of guard.sh's 8 fast-path checks** — `tsc-forge-control-web`,
   `no-raw-colours`, `dollar-sweep`. It does not cover `node-version`,
   `devdeps-*`, or `forbidden-file-diff`. The one guard.sh check proven not to
   bite is the one its own mutation harness does not test. That is not a
   coincidence worth ignoring.

2. **It is RED right now, and the reason is the rule D3 must encode.**
   `GUARDTEST_EXIT=1`; the failing assertion is Defect 2's GREEN probe:
   `FAIL — restoring the tree turns no-raw-colours GREEN: got 'FAIL', want 'PASS'`,
   with `detail=forge-control-web/app/desktop/goals/WeekGrid.tsx:48` — an
   inherited red in the same check. The RED half is robust (it asserts the
   check names *your* scratch file); the GREEN half is not (it asserts the
   whole check is green, which is an assertion about other lanes' work).

   **The rule:** a mutation control's RED half asserts the check *now names
   your mutation*; its GREEN half asserts the check *no longer names your
   mutation* — never that the check is green. Same discipline as fleet memory
   `verifier-asserted-on-fixture-not-invariant`: assert on the behaviour under
   test, never on the state the system exists to tolerate.

---

## 6. Method notes for whoever re-runs this

- **Every mutation was hashed on both sides.** `md5sum` before, mutate, run,
  restore, `md5sum` after, `RESTORED=yes` printed. Created files were removed
  and confirmed absent. Final `git status --porcelain` is clean, and a second
  full `gates-808.sh --strict` run diffs **identical** to the baseline summary.
- **`set -o pipefail` inside the `bash -c`**, exactly as `gate_sh`
  (`gates-808.sh:85`) does it. Without it a `| tail -3` reports `tail`'s status
  and every measurement here would be a fabrication. That is round 1353's own
  finding, recorded in the script's header.
- **Ref-moving experiments ran in a throwaway `git clone --no-hardlinks`**, never
  in this worktree. The git stash stack and branch refs are shared across every
  worktree of this repo; `git branch -f main …` in the real checkout would have
  hit five other lanes.
- **The gate suite takes ~7 minutes** and `check-instrument-typecheck.sh` alone
  ~147 s — past the Bash tool's 120 s default. Both were backgrounded. Fleet
  memory `gate-run-exceeds-bash-default-timeout`.
- **`NODE_ENV=production` is exported here**, so `pnpm install --frozen-lockfile`
  would prune `tsx`/`typescript` and exit 0 doing it. No install was needed this
  run (both `node_modules/.bin/tsc` present), but `guard.sh:130-138` checks for
  exactly this and it bites.

---

## Sources

**Fetched this run (plain HTTP, no browser, no authentication):**

1. *git-diff Documentation* — <https://git-scm.com/docs/git-diff> — accessed
   2026-08-25. Used for the `A...B` ≡ `$(git merge-base A B) B` equivalence
   and for the enumeration of the working-tree diff forms (§2.1).
2. *Node.js v22.x Documentation — Test runner* —
   <https://nodejs.org/docs/latest-v22.x/api/test.html> — accessed 2026-08-25.
   Used for quoted-glob expansion and the default TypeScript discovery
   patterns (§2.2).
3. *Mutant states and metrics — Stryker Mutator* —
   <https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/>
   — accessed 2026-08-25. Used for the Killed / Survived / No-coverage
   definitions and the mutation-score formula (§2.3).
4. *What is mutation testing? — Stryker Mutator* — <https://stryker-mutator.io/docs/>
   and *Frequently Asked Questions* — <https://stryker-mutator.io/docs/General/faq/>
   — accessed 2026-08-25 via search result summaries; corroborating only, no
   load-bearing claim rests on them alone.

**Opened in this worktree (branch `project/169903ec-audit`, HEAD `2209245`,
2026-08-25):** `scripts/checks/gates-808.sh`, `scripts/checks/guard.sh`,
`scripts/checks/test-guard-discrimination.sh`,
`scripts/checks/check-migration-numbers.ts`, `check-secret-requests.ts`,
`check-dismiss-peek.tsx`, `check-deep-link.ts`, `contrast-canvas-banners.cjs`,
`no-raw-colours.cjs`, `dollar-sweep.sh`,
`docs/plan/artifacts/phase800/psql-argv-leak.cjs`,
`docs/plan/artifacts/phase800/nav-walk-sampling.cjs`,
`docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs`,
`forge-control-web/app/desktop/team/confirm.ts`, `team/TeamRow.tsx`,
`team/teamRows.ts`, `chat/effort-ramp.ts`, `chat/secret-requests.ts`,
`chat/pollBudget.ts`, `chat/thread-mapping.ts`, `app/theme.css`,
`forge-control/src/lib/usage-sampler.ts`, `package.json` (root and both
packages), `PLAN.md`,
`docs/plan/artifacts/verification-that-bites/D1-execution-audit.md`.

**Fleet memory read before starting**
(`/root/.claude/projects/-opt-forge-ai-os/memory/`): `MEMORY.md` index plus
`assertion-inert-shared-substring`, `verifier-asserted-on-fixture-not-invariant`,
`worktree-local-main-can-equal-head`, `forbidden-file-guard-does-not-bite`,
`do-not-soften-check-secret-scan`, `unreachable-guard-needs-its-own-control`,
`gates-808-is-the-repo-suite`, `gate5-raw-colours-red-at-main-from-week-board`,
`inherited-gate-red-may-be-a-stale-allowlist`,
`gate6-allow-list-lives-in-two-places`, `tests-outside-src-lib-never-run`,
`gate-run-exceeds-bash-default-timeout`,
`gates-808-unit-suite-flakes-under-sibling-contention`,
`element-slicer-anchors-on-a-selector-string`. Three of these were corrected or
sharpened by today's measurements — see §3.1.

**Transcripts** (host-local, not committed): `/tmp/d2-c2bcea3f/baseline-gates.log`,
`final-gates.log`, `guardtest.log`, `gate3.log`.
