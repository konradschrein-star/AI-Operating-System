# 01 — Requirements

**Project:** `scripts-checks-typecheck-gate`
**Companion to:** `00-vision.md` (goal, DoD, non-goals), `02-architecture.md`
(how), `03-quality.md` (proof), `04-phases.md` (order)

Every requirement below is numbered, testable, and mapped to exactly one phase
in `04-phases.md` §8. A requirement that cannot be tested from a terminal is not
a requirement; it has been rewritten or deleted.

Conventions:

- **R** = functional. **NF** = non-functional. **C** = constraint (inherited
  from the repo or the fleet, not chosen by this project).
- **Verify:** the literal command or observation that decides pass/fail.
- All paths are repo-relative. All commands are run from the worktree root
  unless the command says otherwise.
- "The gate" = `scripts/checks/check-instrument-typecheck.sh`.
- "The profile" = the checked-in base tsconfig this project introduces
  (`tsconfig.checks-instruments.json`; naming argued in 02-architecture.md §3.4).

---

## 1. The compile profile

### R1 — One profile, checked in, extending the web app's tsconfig
The repo shall contain exactly one checked-in tsconfig governing instrument
typechecking. It shall `extends` `./forge-control-web/tsconfig.json` and
override only what the out-of-tree location forces.

**Verify:** the file exists; `jq -r .extends` on it returns
`./forge-control-web/tsconfig.json`; the `compilerOptions` it sets are a subset
of the six named in R2/R3/R4 plus `noEmit`, `incremental: false`,
`allowImportingTsExtensions`.

### R2 — `jsx: react-jsx` override, with the reason inline
The profile shall set `"jsx": "react-jsx"` and `"jsxImportSource": "react"`, and
shall carry a comment stating that the app's own `jsx: "preserve"` exists
because Next compiles the JSX while a check script is executed by `tsx`, which
does not.

**Verify:** the two options are present; the reason appears as a `"//"` key in
the file. `grep -c 'preserve' tsconfig.checks-instruments.json` ≥ 1.

### R3 — Four `paths` entries pointing at `@types`, not at runtime packages
The profile shall map `react`, `react/jsx-runtime`, `react-dom` and
`react-dom/server` to the corresponding packages under
`forge-control-web/node_modules/@types/`, and shall carry a comment recording
**why not the runtime packages**: the runtime `react` is a pnpm symlink into
`.pnpm/react@19.0.0/` that ships no declarations, and mapping to it defeats the
`@types/react` lookup, producing `TS7016` and then a `TS7026` flood
(`check-settings-surface.tsx`: 936 diagnostics under that mapping, 0 under this
one — `evidence/census-B-root-paths-profile.txt` vs
`evidence/census-E-web-extends-profile.txt`).

**Verify:** each of the four `paths` values contains the substring
`node_modules/@types/`; zero `paths` values point at a non-`@types` path other
than the inherited `@/*`; the measured counts appear in the comment.

### R4 — `typeRoots` pinned in the profile
The profile shall set `"typeRoots": ["./forge-control-web/node_modules/@types"]`
and carry a comment recording that automatic `@types` discovery walks up from
the *config file's own directory*, so a generated per-file config in a temp
directory finds no `@types` at all without this line.

**Verify:** the option is present. The negative control in R23 demonstrates the
failure it prevents.

### R5 — `@/*` path alias preserved
The profile shall preserve the app's `"@/*": ["./*"]` alias, resolved against
`forge-control-web/`, so instruments importing app modules by alias compile.

**Verify:** a check script importing via `@/` compiles; if no instrument uses
the alias today, the reviewer confirms the alias resolves by compiling a
throwaway file that uses it, and records that transcript.

### R6 — The profile is not reachable from any build
No `next.config.*`, no `package.json` script, and neither package's
`tsconfig.json` shall reference the profile.

**Verify:** `grep -rn 'checks-instruments' --include='*.json' --include='*.mjs'
--include='*.js' --include='*.ts' . | grep -v scripts/checks | grep -v docs/`
returns only the profile itself.

### R7 — The profile does not disturb the app's own typecheck
`cd forge-control-web && pnpm typecheck` shall exit 0 and produce no diagnostic
it did not produce before this project.

**Verify:** run it before the first commit and after the last; diff the outputs.
Both empty.

---

## 2. Enumeration and coverage

### R8 — Glob enumeration over the whole directory
The gate shall enumerate its subjects at run time by globbing
`scripts/checks/**/*.ts` and `scripts/checks/**/*.tsx`, **at any depth and
including dotfiles** (`globstar`, `dotglob`, `nullglob`). It shall not read a
hand-maintained inclusion list.

**Amended round 2, fix cycle 1.** The original text globbed one level and
without `dotglob`, and the red team walked through both gaps: a type-broken
`scripts/checks/sub/broken.ts` was uncompiled *and* unnamed, and `.broken.ts` —
and a file named exactly `.ts` — were skipped in silence (breaches B2, B3).
"Enumerate the directory" has to mean the directory, not its top level minus
its hidden files.

**Verify:** `bash scripts/checks/check-instrument-typecheck.sh` reports a
subject count equal to
`find scripts/checks \( -name '*.ts' -o -name '*.tsx' \) | wc -l`
(42 at the time of writing). Add a throwaway file to the directory — including
one in a new subdirectory, and one whose name begins with a dot; the count
rises by one each time with no edit to any list. (This is R23's control (b).)

The gate shall additionally reconcile its own enumeration against an
independent one taken with a different tool (`find`), and refuse when the two
disagree. **Rationale:** round 200's "a failure to enumerate is a refusal"
guard was structurally dead — a `for` loop over an empty glob returns 0, so a
full disk truncated the subject list 31 → 24 with the guard silent and the
census reconciling happily (finding F1). Enumeration now writes nothing, so
there is no partial write to detect; the second opinion is what proves that.

> **Precedent.** Universal gate item 10 (shell lint) already derives its subject
> list — `git log --no-merges --name-only main..HEAD -- '*.sh'` — rather than
> hand-listing. R8 applies the same principle to item 9. The derivation differs
> (item 10 lints what the branch touched; item 9 compiles what exists) and
> R9 says why.

### R9 — Coverage is of the directory, not of the diff
The gate shall compile every instrument present on disk, not only those the
branch modified.

**Rationale, stated because it is the load-bearing choice:** a diff-scoped gate
answers "did *you* break it." A directory-scoped gate answers "is it broken."
The four repetitions of this hole were all discovered by someone compiling a
file **nobody had touched in months**. Family B (`check-orientation.ts`) is
exactly that file. A diff-scoped gate would not have found it.

**Verify:** with a clean `git diff main...HEAD -- scripts/checks/` the gate still
reports 42 subjects and compiles all of them.

### R10 — Every TypeScript-family file is covered, or the run fails
`.ts` and `.tsx` are both enumerated. If a TypeScript-family file the subject
globs do not match is present anywhere under `scripts/checks/` — another
extension (`.mts`, `.cts`), at any depth, dotfile or not — the gate shall
**name it AND fail the run**.

**Amended round 2, fix cycle 1 — the requirement was the defect.** The original
said "either cover it or name it", and the gate implemented it faithfully: a
type-broken `zz-broken.cts` was named in the UNCOVERED block and the final line
still said `PASSED` with exit 0 (finding F7). That sentence — final line
`PASSED`, exit code 0, a type-broken file on disk — is verbatim what
`03-quality.md` §6 brief A2 defines as a breach of this gate. Naming is the
right *message*; exit 0 was the wrong *verdict*. A file this gate declines to
read cannot also be certified by it.

**Verify:** create `scripts/checks/throwaway.mts` containing a type error and
run the gate. Its output contains a line naming `throwaway.mts` as uncovered,
the census reports `uncovered 1`, and the run **exits non-zero**. Silence is a
defect; so is a green tick.

### R11 — One file per invocation
Each subject shall be compiled in its own `tsc` invocation.

**Rationale:** compiling them together merges 42 programs into one, which is how
round 800's whole-directory attempt pulled unrelated app modules into scope and
produced cross-file noise. Isolation also makes every failure attributable to
one file without reading a stack of paths.

**Verify:** the gate's transcript prints one PASS/FAIL line per subject; its
provenance block prints the invocation shape.

### R12 — The subject list and the compiled list are reconciled
The gate shall count subjects enumerated and subjects compiled and shall fail,
non-zero, if the two differ in either direction.

**Verify:** the census block prints both numbers. R23's controls exercise the
mismatch paths.

### R13 — Zero subjects is a refusal, not a pass
If the glob matches nothing, the gate shall exit non-zero with a message saying
a gate over nothing certifies nothing.

**Verify:** run the gate with `scripts/checks` temporarily emptied (in a copy of
the tree, never in place); it exits non-zero.

### R14 — Exclusions live in a waiver ledger, are named, and are justified
If any instrument cannot be made to compile, it shall be listed in
`scripts/checks/instrument-manifest.txt` — repurposed by this project from an
inclusion list into a **waiver ledger** — with, per entry: the path, the exact
diagnostic, why it cannot be fixed now, and which project owns fixing it. The
gate shall print every waiver in its transcript on every run, and shall fail if
a waived file compiles clean (a stale waiver is a defect).

**Target: the ledger is empty at completion.** It exists so that a future
exclusion cannot be invisible, not to hold one.

**Verify:** ledger is empty, or every entry has all four fields; the gate prints
the ledger; removing a real error from a waived file makes the gate fail with
"waived but clean".

### R15 — The manifest's inclusion-list semantics are retired in the same commit that removes their use
The file's header shall be rewritten to describe the ledger, and shall state
that the round-800 inclusion list and its manifest guard were retired by this
project because glob enumeration supersedes them.

**Verify:** the header contains no surviving claim that the file lists what gets
compiled. `grep -n 'MEASURED AT ROUND 800' scripts/checks/instrument-manifest.txt`
survives only inside text explicitly marked as history.

---

## 3. The gate's behaviour under failure

### R16 — Hard errors only, everywhere (NF1)
No branch of the gate shall swallow, downgrade, or disclose-and-continue any
error. Every abnormal condition exits non-zero.

**Verify:** read every `|| true`, `2>/dev/null`, `set +e` and `continue` in the
script and justify each in a review comment; the reviewer confirms none of them
can convert a failure into a pass. `set -euo pipefail` present; `ERR` trap
present.

### R17 — Missing compiler is a refusal that prints the fix
If `forge-control-web/node_modules/.bin/tsc` is absent or not executable, the
gate shall exit non-zero printing the exact install line.

**Verify:** rename `forge-control-web/node_modules` in a scratch copy; the gate
refuses; the message contains
`pnpm install --frozen-lockfile` and `--prod=false` (or the documented
`NODE_ENV=development` equivalent — R18).

### R18 — The install line in the refusal is the one that actually works
The printed install line shall not be one that `NODE_ENV=production` prunes into
uselessness. It shall carry `--prod=false` or set `NODE_ENV=development`
explicitly, and shall use `pnpm`, never `npm`.

**Verify:** run the printed line verbatim with `NODE_ENV=production` exported,
then run the gate. It passes. This is a real trap in this environment and the
verification is not optional.

### R19 — A missing subject is a failure, not a skip
If a subject disappears between enumeration and compilation, the gate shall fail
naming it.

**Verify:** the census reconciliation in R12 covers it; the reviewer confirms
the code path exists.

### R20 — The gate prints its own identity before any verdict
Provenance block first: worktree path, `git rev-parse HEAD`, branch, the gate
script's own `sha256sum`, the profile's `sha256sum`, `tsc --version`,
`node --version`, subject count, and the compile invocation shape.

**Rationale:** standing rule 3 — "a harness that does not expose its own build
identity is not evidence."

**Verify:** run it; all ten fields present, above the first PASS/FAIL line.

### R21 — Failures are attributable and complete
Each failing subject shall print its path and the compiler's full, unfiltered
output for that subject. No truncation, no `head`, no summarising.

**Verify:** break two subjects; both appear with all their diagnostics.

### R22 — The final line states the verdict unambiguously
A pass prints `PASSED` with `n/n` compiled clean; a failure prints `FAILED` with
counts of type failures and waiver violations. Exit code agrees with the word.

**Verify:** both paths observed in R23's transcripts.

---

## 4. Proving the gate can fail

### R23 — Three negative controls, transcribed
Each control shall be executed, its full output transcribed into
`docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`, and its
mutation reverted and the revert proven by `git status --porcelain` empty.

- **(a) Broken type in a covered instrument.** Append a type error to a file
  that is green. Gate exits non-zero naming that file and showing the
  diagnostic.
- **(b) A NEW file with a type error, added to the directory and manifested
  nowhere.** This is the control that distinguishes glob coverage from glob
  enumeration, and it is the control the round-800 design could not pass without
  its manifest guard. Gate exits non-zero naming the new file.
- **(c) No `forge-control-web/node_modules`.** Gate refuses, non-zero, printing
  R18's install line. Never `tsc: not found` as the gate's own answer.

**Verify:** the evidence file contains three transcripts, each with the command,
the full output, the exit code, and the revert proof.

### R24 — A control that only proves the harness is not a control
Each transcript shall show the gate green immediately before the mutation and
green again immediately after the revert.

**Verify:** three before/after pairs present.

---

## 5. Fixing the eleven genuine errors

### R25 — Family A: `TeamRow` / `XClickInput` drift, four files
`check-team-confirm.ts:207`, `check-team-rows.ts:84`,
`check-dismiss-peek.tsx:102,115`, `check-stop-affordance.tsx:98,111` shall
compile clean by constructing the current shapes.

**Verify:** each file exits 0 under the profile; each still runs green under
`tsx`; each still fails when its subject is deliberately broken (R29).

### R26 — Family B: the stale role union in `check-orientation.ts`
Lines 129, 133 and 138 assign `"operator_chat"` and `"project_worker"` to a
union of `"subagent" | "operator" | "worker" | "cron" | "unknown"`. The fix
shall begin by determining **whether the instrument still asserts anything** —
if the role names were renamed underneath it, its assertions may be structurally
unreachable.

Permitted outcomes, in order of preference:

1. The literals map onto current names; update them and the assertion holds.
2. The assertion is now vacuous; rewrite it to assert the same *property* about
   the current names, and say so in the commit message.
3. The assertion tests behaviour that no longer exists; retire it, naming the
   requirement it retires in the commit message (**standing rule 4**).

A cast, an `any`, or a widened annotation is **not** a permitted outcome.

**Verify:** the file compiles clean; the commit message states which outcome and
why; the red-team reviewer (R33) independently confirms the instrument still
fails when `OrientationStrip` is broken.

### R27 — Family C: the untyped Hono import in `serve-sse-808.ts`
Line 51's deep path import shall be replaced with whatever
`serve-agents-7798.ts`, `serve-quota-7799.ts` and `serve-v3-7798.ts` do — all
three are green — and line 90's implicitly-`any` `c` shall follow from the
types, not from an annotation bolted on.

**Verify:** the file compiles clean; `grep -n 'node_modules/hono' scripts/checks/serve-sse-808.ts`
is empty; the server still binds its port and serves SSE.

### R28 — No suppressions, no widening
This project shall introduce zero **`@ts-nocheck`**, zero `@ts-ignore`, zero
`@ts-expect-error`, zero `: any`, zero `as any`, zero `as unknown as`.

**`@ts-nocheck` added round 2, fix cycle 1, and it is listed first because it is
the strongest of the six:** one line at the top of a file disables typechecking
for the WHOLE file. It was in neither this requirement nor the P-A grep, so a
planted `nocheck-broken.ts` compiled clean and every gate in the corpus waved it
through (breach B4). R29's rationale — "the cheapest way to make a check compile
is to make it check nothing" — describes exactly this, and it is the obvious
move for a phase-3 builder facing six reds.

**Verify — two commands, because one of them cannot see the whole problem:**

```bash
# P-A, diff-scoped: did THIS branch introduce one?
# Pathspec narrowed to the TypeScript subjects (git matches subdirectories too):
# the gate is a .sh that must NAME these directives to refuse them, and the
# unscoped form reports the gate's own prose as suppressions. See 03-quality.md §3.
git diff main...HEAD -- 'scripts/checks/*.ts' 'scripts/checks/*.tsx' \
  | grep -E '^\+.*(@ts-nocheck|@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
# directory-scoped: is one PRESENT, whoever wrote it and whenever?
bash scripts/checks/check-instrument-typecheck.sh   # census reports `suppressions 0`
```

The first is empty; the second reports zero. The gate carries the second check
because P-A greps a diff and therefore cannot see a suppression that is already
on `main` — and R9's own argument ("all four repetitions of this hole were
found by someone compiling a file nobody had touched in months") applies
verbatim to suppressions (finding F2). The gate refuses the three comment
directives, which it can detect exactly; `: any` and the casts remain P-A's,
because a directory-wide grep for them would also match an instrument that
legitimately searches app source for that string.

### R29 — Every fixed instrument still detects its own subject's breakage
For each of the six fixed files, the reviewer shall break the thing it checks,
observe the instrument fail, and revert.

**Rationale:** the cheapest way to make a check compile is to make it check
nothing. R29 is the requirement that makes that path visible.

**Verify:** six transcripts in
`evidence/instruments-still-detect.md`, each with the mutation, the instrument's
failure, and the revert.

### R30 — Fixes are confined to `scripts/checks/`
No file under `forge-control-web/app/**` or `forge-control/src/**` shall be
modified to make an instrument compile.

**Verify:** `git diff --name-only main...HEAD` lists nothing under those trees.
If an app file genuinely must change, that is an escalation (see NF9), not a
quiet edit.

---

## 6. Corpus truthfulness

### R31 — `03-quality.md` §3.1 item 9 and §4 line 859 describe the gate that exists
Item 9's text and the §4 command block shall be amended in the same commit as
the gate change (standing rule 2). The amendment shall state that coverage is
now the whole directory by glob and that the manifest is a waiver ledger.

**Verify:** read both; no surviving claim of manifest-scoped coverage;
`git log --format=%H -1 -- docs/plan/engine-task-graph/03-quality.md` equals the
commit that changed the gate script.

### R32 — `evidence/phase8-tooling.md` §5 and §5.1 are reconciled
Its description of the gate and its three breakages shall either be updated or
shall carry an explicit "superseded by
`docs/plan/scripts-checks-typecheck-gate/`, round N" marker at the section head.
It shall not be silently left describing a gate that no longer exists.

**Verify:** the marker or the update is present; the reviewer reads both and
confirms no contradiction survives.

### R33 — Family B carries adversarial review
A reviewer briefed to **attack** — not to check — shall review R26's outcome,
with the explicit mandate of proving the fixed instrument no longer detects
what it was built to detect.

**Verify:** the review exists as a task with a VERDICT line, and it names the
specific attack it attempted.

### R34 — The successor project is named, not implied
`02-architecture.md` §7 shall state exactly what a follow-up must change to
cover `scripts/*.ts`, `forge-control/scripts/*.ts` and
`forge-control-mcp/scripts/*.ts` (NG3).

**Verify:** the section exists and names files and lines, not intentions.

---

## 7. Non-functional

### NF1 — No silent fallback anywhere (fleet policy)
Restates R16 as the fleet-wide rule it is. Applies to the gate, the profile
generation, and every fix. A `try` that logs and continues is a finding.

**Verify:** silent-fallback audit, universal gate item 6.

### NF2 — Determinism
Two consecutive runs on an unchanged tree produce identical verdicts and
identical per-subject results.

**Verify:** run twice; diff the transcripts modulo timing and the temp path.

### NF3 — No writes into the repo tree during a run
The gate shall not create, modify or leave any file inside the worktree.
Generated per-file configs live in `mktemp -d` and are removed.

**Verify:** `git status --porcelain` empty immediately after a run; the temp
directory does not exist afterwards; a trap removes it even on failure.

### NF4 — Concurrency-safe
Two gate runs in the same worktree at the same time shall not interfere.

**Verify:** run two simultaneously; both produce correct verdicts. (Follows from
NF3 if the temp directory is per-run; the point is that it must be, not shared.)

### NF5 — Cold-tree reproducible
See DoD-7. The documented install line then the gate yields 42/42 on a tree
with no `node_modules`.

**Verify:** performed by the deploy/verify phase, from a genuinely cold tree.

### NF6 — Runtime is recorded, not optimised away
Wall-clock is printed by the gate and recorded in the evidence. Coverage is
never traded for speed.

**Verify:** the number appears in the transcript and in
`evidence/negative-controls.md`.

### NF7 — Operator legibility
A reader who has never seen the gate can tell from one transcript: what was
compiled, what passed, what failed, why, what the gate refused to do, and what
it could not see. No output requires reading the source to interpret.

**Verify:** the gating reviewer states this explicitly in their verdict, or
names the line that fails it.

### NF8 — Dependency footprint unchanged
`git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'` is empty.
`pnpm`, never `npm`. `--frozen-lockfile` always.

**Verify:** the diff command, run by the gating reviewer of every phase.

### NF9 — Escalate rather than widen scope
If a fix appears to require changing an app file, a dependency, or an
instrument's meaning beyond R26's three outcomes, the builder escalates via
`POST /api/reminders` with the default it will take, and continues with
everything that does not depend on the answer.

**Verify:** any such change is accompanied by the escalation in the task record.

---

## 8. Constraints inherited, not chosen

### C1 — Worktree-only until deploy
`/opt/forge-ai-os` is untouched during build phases. Verification against live
services happens only in the explicitly-briefed deploy/verify phase.

### C2 — Never `pm2 restart forge-executor`
Restarting the executor kills every run in flight. Only the deploy phase
restarts anything, and only by the detached `safe-restart.sh` procedure.

### C3 — `NODE_ENV=production` prunes devDependencies
`tsx` and `typescript` are devDependencies. Every install line in every brief,
every doc and every error message is
`pnpm install --frozen-lockfile --prod=false` (or `NODE_ENV=development` +
`--frozen-lockfile`). This is the R18 trap and it has bricked this environment
before.

### C4 — Task identity is (project, round, role, title)
Titles are unique within a round and role. Rounds are computed from
`depends_on`.

### C5 — One workstream is one worktree, serialised
This project uses `main` only. No two builders in it may declare the same file
in their `write_set`; where a split is impossible, one builder writes the file
twice.

### C6 — Standing rules 2, 3 and 4 bind every phase
2: an unsatisfiable gate is amended here and where it is enforced, same commit,
reasoning inline. 3: a harness that does not expose its build identity is not
evidence. 4: deleting a test is a finding unless the commit message names the
requirement it retires.

---

## 9. Requirement → phase map

Authoritative mapping lives in `04-phases.md` §8. Reproduced here for review;
if the two disagree, `04-phases.md` wins and this section is the defect.

| Phase | Requirements |
|---|---|
| 1 — Compile profile | R1, R2, R3, R4, R5, R6, R7, NF2, NF8 |
| 2 — Gate rewrite | R8, R9, R10, R11, R12, R13, R16, R17, R18, R19, R20, R21, R22, NF1, NF3, NF4, NF6, NF7 |
| 3 — Fix the instruments | R25, R26, R27, R28, R29, R30, R33, NF9 |
| 4 — Negative controls | R23, R24 |
| 5 — Ledger + corpus | R14, R15, R31, R32, R34 |
| 6 — Deploy & verify | NF5, C1, C2, C3, plus a full re-run of every phase's criteria on the merged tree |

Every requirement appears exactly once. Count: 34 R + 9 NF = 43 mapped; 6 C are
constraints, enforced in every phase rather than owned by one.
