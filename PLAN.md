# PLAN — aios-verification-that-bites

Round 0, architect. Branch `project/169903ec`, HEAD `259778b`.
Konrad's framing: *"Projects close on a claim, not on an observed effect."*

---

## RECOMMENDATION

Do not add more checks. **Add the two registries the repo is missing, and make each
one fail on its own gap.**

The repo already has a complete, automatic, unforgettable registry of one thing —
`check-instrument-typecheck.sh` globs every `.ts`/`.tsx` under `scripts/checks/` and
compiles it, with `instrument-manifest.txt` as an open waiver ledger for anything
excused. That design is correct and it works. It just answers the wrong question.
It certifies that 56 instruments **compile**. Nothing in this repo asks which of
them **run**, and nothing asks which of them **can fail**.

So: build the execution registry in the exact shape of the compile registry
(glob + open ledger + printed waivers), and codify the mutation control as a
five-line harness so proving a check bites costs nothing. Both are boring, both
reuse a pattern this repo has already argued through and shipped, and both fail
loudly on the next gap rather than on the last one.

**Reasoning.** Every item in the brief is one symptom of a single structural fact:
*coverage in this repo is asserted by a list a human maintains, and lists rot
silently.* `check-secret-scan.ts` fell out of the list. `check-secret-requests.ts`
stayed in it and looks like the same thing. Three web tests were never in any list.
`detectPath`'s 18 cases were a list. `routes/files.ts` was declared read-only from a
list of two greps. The fix for a rotting list is never a longer list — it is a glob
plus a ledger of named exceptions, which is exactly what round 500 already built for
the compile axis and exactly what nobody built for the execution axis.

**Rejected alternatives, one line each.**
- *Wire every orphan into `gates-808.sh`.* Turns main red for every lane at once, on
  work nobody triaged — the same mistake D4 exists to avoid, and it would drag
  `check-secret-scan.ts` in against an explicit constraint.
- *Delete the orphans.* Destroys the only record of invariants that were once proven,
  and the deletion is itself unreviewable — you cannot tell a spent round-artefact
  from a live gate by looking at it, which is the whole problem.
- *A CI service that runs everything.* No CI exists here (`.github/workflows` is
  absent, verified); introducing one to fix a list problem is a new dependency and a
  second place for coverage to rot.
- *Teach reviewers to check for inert instruments.* Already tried — three workers in
  one night reported the same wrong thing. Judgement does not scale; a glob does.

---

## WHAT I MEASURED (round 0, all re-runnable in this worktree)

### F1 — The execution registry does not exist. 41 of 74 artefacts are invoked by nothing.

```
RUNNERS="scripts/checks/gates-808.sh scripts/checks/guard.sh scripts/checks/preflight-deploy.sh \
         scripts/checks/instrument-manifest.txt scripts/checks/test-guard-discrimination.sh \
         package.json forge-control/package.json forge-control-web/package.json forge-control-mcp/package.json"
for f in $(ls scripts/checks/ | grep -E '\.(ts|tsx|sh|cjs|py)$'); do
  hits=$(grep -n --fixed-strings "$f" $RUNNERS 2>/dev/null | grep -v "^scripts/checks/$f")
  [ -z "$hits" ] && printf '%-40s *** NOTHING ***\n' "$f"
done
```

14 artefacts are invoked by `gates-808.sh` / `guard.sh` / `package.json`.
41 are invoked by nothing executable. `check-secret-scan.ts` is one of the 41.
Among the other 40, by their own opening line:

| artefact | its own self-description | invoked by |
|---|---|---|
| `check-browser-takeover-ticket.ts` | "the gate on the ONE route in this repo…" | NOTHING |
| `verify-control-plane.sh` | "the one command that proves the manager control…" | NOTHING |
| `api-diff.sh` | "phase-300 read-side API regression gate" | NOTHING |
| `contrast-nav-rail.cjs` | "WCAG contrast gate for DesktopApp's LeftRail" | NOTHING |
| `contrast-role-tints.cjs` | "WCAG contrast gate for round 808's per-role chat" | NOTHING |
| `preflight-deploy.sh` | "the ONE executable gate deciding whether phase 7…" | NOTHING (invoked by a documented deploy procedure, not a runner) |

The three `contrast-*.cjs` files are the name-twin pattern again at gate scale: exactly
one of the three (`contrast-canvas-banners.cjs`, gate 6) is in the suite. A reader
scanning the gate list sees "contrast is covered".

**`instrument-manifest.txt` is not a runner and must not be read as one.** Its own
header (line 1) says it is the *waiver ledger* of `check-instrument-typecheck.sh`,
which enumerates its subjects "by GLOB over the whole of `scripts/checks/`". So all 56
`.ts`/`.tsx` instruments get a green tick every run — **for compiling**. Compiling is
not running. No artefact in this repo names that difference, and that is F1's root.

### F2 — `guard.sh`'s forbidden-file guard does not bite. Mutation-proven.

`scripts/checks/guard.sh:163` is the repo's protection of shared/engine files
(`DesktopApp.tsx`, `nav-items.ts`, `tokens.ts`, `globals.css`, `theme.css`, `v2.css`,
`project-tick`, `cc-runner`, `executor.ts`, `db/projects`, `VaultFileList`,
`routes/files`). Control run in this worktree:

```
cp forge-control/src/lib/cc-runner.ts /tmp/bak
echo "// MUTATION PROBE" >> forge-control/src/lib/cc-runner.ts
FORBIDDEN_RE='(^|/)app/desktop/DesktopApp\.tsx$|…|project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'
hits="$(git diff --name-only main...HEAD 2>/dev/null | grep -E "$FORBIDDEN_RE" || true)"
[ -n "$hits" ] && echo FAIL || echo PASS
git status --porcelain -- forge-control/src/lib/cc-runner.ts
cp /tmp/bak forge-control/src/lib/cc-runner.ts
```

Output: `PASS` — while `git status` printed ` M forge-control/src/lib/cc-runner.ts` at
the same instant. Restored; `md5sum` = `932a3d573328f50ad895fe7df915e5c4` both sides.

Two independent causes, both live:

1. **`main...HEAD` compares commits.** Every *uncommitted* edit is invisible. `guard.sh`
   is billed (line 39) as the thing to "run from an agent's worktree" — the exact
   moment an agent's edit is uncommitted.
2. **Local `main` == `HEAD`** in this worktree (both `259778b`; `origin/main` is
   `e8bd592`). `git diff --name-only main...HEAD | wc -l` → **0** at every input.
   Known trap: memory note `worktree-local-main-can-equal-head`.

`gates-808.sh:163` carries the identical body and the identical hole.

### F3 — `gates-808.sh` gate 7 ends in a literal `exit 0`.

`scripts/checks/gates-808.sh:167-172`, "forge-control/ untouched by round 808's own
commits", closes with `exit 0` unconditionally. Its assertion is **false right now**:

```
git diff --name-only 7b961b5..HEAD -- forge-control/ | wc -l    →  179
```

179 files differ and the gate reports `EXIT=0`. It is counted in the 27. It is a
reporter wearing a gate's costume.

### F4 — Three gates in `gates-808.sh` are frozen to round 808's own file list.

- Gate 4 (`:122`, "token purity") greps a hard-coded list of seven paths, two of which
  are `gates-808.sh` itself and `dollar-allowlist.txt`. No file written after round 808
  is ever its subject. Gate 5 (`no-raw-colours.cjs`) is the whole-app version, so gate 4
  adds nothing but a green tick.
- Gate 27 (`:271`, "reproduce-cleanliness") runs two hard-coded `.cjs` scripts and
  compares `md5sum` of `git status --porcelain` before/after. Its subject set is frozen;
  its *comparison* is repo-wide, so a sibling task writing a file mid-gate turns it red
  for an unrelated reason. Both a false-negative and a false-positive machine.

`gate_sh`'s pipeline-swallowing bug is **already fixed** (`set -o pipefail` inside
`bash -c`, `:83-88`) — credit where due; that one is closed.

### F5 — `pnpm guard` runs `--fast --strict`, which skips gates-808 entirely.

`package.json:7` → `guard.sh --fast --strict`. In `--fast`, phase 3 (production build),
the instrument typecheck, and **phase 4 (`gates-808.sh --strict`, the whole functional
suite)** are `skip_check`ed (`guard.sh:199,232`). The interaction between the deliberate
`--fast` skips and `--strict`'s "a SKIP also fails the run" is the first thing D2 must
resolve: either `pnpm guard` cannot pass, or `--strict` does not mean what line 30 says.

### F6 — D4 is small and clean.

Exactly three tracked test files escape every runner, all in `forge-control-web`, and
**all three pass today**:

```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx --test 'app/desktop/**/*.test.ts'
# tests 62 / # pass 62 / # fail 0
```

Baseline: `cd forge-control && pnpm test` → `# tests 2200 / # pass 2200 / # fail 0`, 15s.
`forge-control-web/package.json` has **no `test` script at all**, so "widen the glob" is
imprecise: the job is a second runner plus a gate, then the structural check that makes a
fourth escapee impossible. All 72 forge-control tests are flat in `src/lib/` — no nested
directories are missed today. `src/lib/vault-routes.test.ts:42` imports
`../routes/vault.ts`; its own header says why: *"a test file under `src/routes/` DOES NOT
RUN."*

### F7 — Terrain for D5: nothing gates a project's close.

> **CORRECTED 2026-08-25, after the C1 task contradicted this section and I re-measured.
> Two of the four claims below were wrong, and both were mine — relayed from a scout's
> report without re-running them because they agreed with what I expected. That is
> evidence item 5 of this project's own brief, committed into its own plan. The
> corrections are inline and marked; the original wording is struck so the mistake stays
> legible rather than being tidied away.**

`closeFinishedProjects()` (`forge-control/src/db/projects.ts:625-693`) closes a project
when: status is active, ≥1 task is done, no task is open, and every non-main workstream
has a main task depending on all of it.

~~**There is no other condition.**~~ **WRONG — there are TWO close points.**
`reconcileProjectStatuses()` (`db/projects.ts:799-863`) *also* sets `status='done'`:
`UPDATE projects SET status='done' … WHERE id=$1 AND status='blocked'`, for any *blocked*
project whose tasks are all terminal, **with no R70 term at all**. A contract wired into
only the first is bypassed by `blocked → done`. Verified by reading `:845-856`.

No `acceptance_criteria`, `success_metric`, `baseline`, or `verification_command` exists
anywhere in the schema. **Re-verified against the LIVE table** rather than by grep —
`select column_name from information_schema.columns where table_name='projects'` returns
exactly 11 columns: `id, name, brief, repo, workspace_dir, base_branch, work_branch,
status, metadata, created_at, updated_at`. This claim stands, on better evidence.
`projects.metadata` is free-form jsonb already carrying `mode`, `checkin_hours`,
`origin_chat_id`, `tier_pin`, `strict_write_sets`.

Two facts make an acceptance contract mechanically possible **without a migration**:

- `projects.metadata` jsonb is the seeding-time slot, already in the POST body path
  (`routes/projects.ts:99-108`, `buildProjectMetadata()` `:134-188`).
- ~~**Workers hold no database credentials.**~~ **WRONG, and this was the load-bearing
  fact.** `forge-control/src/lib/cc-runner.ts:438` is `const env = { ...process.env }` —
  the child inherits forge-executor's entire environment and only `ANTHROPIC_API_KEY` is
  deleted. Measured from inside this very run:
  `env | cut -d= -f1 | grep -iE 'PG|DATABASE'` → `AI_OS_DATABASE_URL`, `DATABASE_URL`,
  `HCP_DATABASE_URL`, `PGPASSWORD`. `gemini-runner.ts:183` and `cli-runner.ts:1354,1547`
  do the same, and `guard-autonomy.py:182-190` blocks `psql` only for
  `DROP|TRUNCATE|FLUSHALL|FLUSHDB` — an `UPDATE projects` passes. **A worker can reach
  the database that would hold its own acceptance number.** So substrate (i) is not
  out of reach today; C1 proposes stripping the four DSN variables from the child env in
  those three runners as a prerequisite in its own project — and notes honestly that even
  then `pm2 jlist` prints forge-control's env to any root process, so this is a policy
  line and a deliberate boundary crossing, not a wall. It is still far better than a file
  in the worker's own tree.
  The fleet memory note `worker-shell-inherits-database-url` recorded both this and the
  two-close-points correction at 05:36 today — twenty minutes into this project, while I
  was writing the opposite. **Read the memory directory before relaying a scout.**

And one free acceptance number is already sitting there unused: `write_set` is stored
verbatim and **never compared to the real `git diff`** (`lib/task-graph.ts:738-757`
compares declared sets to other *declared* sets). Memory note
`done-never-verifies-the-declared-write-set` measured 2 of 271 declared files never
written. That is a real observed effect, measurable from outside the worktree, that
costs one `git diff --name-only` to check.

---

## THE FOUR THINGS TO BUILD

1. **`check-instrument-execution.ts` + `execution-manifest.txt`** — the execution
   registry, in the shape of the compile registry. Globs `scripts/checks/`, resolves
   each artefact against the runners, fails on any artefact that is neither invoked nor
   ledgered. The ledger's entries carry the same four required fields as
   `instrument-manifest.txt` (`path`/`reason`/`owner` + here `invoked-by`), and it is
   seeded from D1's triage so the check is **green at main on the day it lands**. It
   goes red on the *next* orphan, not on the current 41.
2. **`prove-it-bites.sh`** — the mutation control, five lines to invoke. Backs a file up,
   applies a named mutation, re-runs the check, asserts non-zero, restores, proves the
   restore by hash. F2 above is this harness run by hand; the harness is that transcript
   made repeatable.
3. **The test-glob job (D4)** — verify, then widen, then make a fourth escapee impossible.
4. **The acceptance-contract proposal (D5)** — design only, no engine changes.

**Not built here, deliberately:** `check-secret-scan.ts` stays unwired (its line 112
prints the credential verbatim; order is redact → Konrad rotates → remove the literal →
wire in, and redaction is seeded on `aios-guardrail-hardening`). F2/F3/F4 are **reported
with reproductions, not fixed** — repairing the forbidden-file guard changes what every
lane in the repo is allowed to commit, and Konrad should see the measurement before the
semantics change. That is a follow-up project, and I say so rather than quietly
shipping it.

**On Konrad's work from last night:** `gate_sh`'s `pipefail` fix and `guard.sh` are his,
and they are good — `guard.sh` cites the right memory notes, refuses to reimplement what
it runs, and its devDeps check tests for `tsc` on disk rather than trusting the installer's
exit code. F2 is the one real defect in it, and it is inherited: the `main...HEAD` idiom
came from `gates-808.sh` and the comment at `guard.sh:159` cites a memory note to justify
three-dot over two-dot. The note is right about sibling work; it just does not cover the
case where local `main` has caught up to `HEAD`.

---

## TASK GRAPH

Five workstreams: `audit`, `mutation`, `contract`, `glob`, `main`.

**`gates-808.sh` has exactly one writer** (`GI`, integrating the `glob` lane). The new
execution check wires into **`guard.sh` phase 1**, not into `gates-808.sh` — three
reasons, and they are design reasons rather than contention ones: it is a static rule
with no runtime, it costs milliseconds, and phase 1 runs in `--fast`, which is what
`pnpm guard` actually invokes. `gates-808.sh` is `skip_check`ed in `--fast`
(`guard.sh:232`), so a gate placed there would be invisible to the default guard — the
same class of not-really-running this project exists to close.

| # | role | tier | ws | task | depends on |
|---|---|---|---|---|---|
| A1 | researcher | junior | audit | D1 execution audit — the 74×runner table | — |
| M1 | builder | standard | mutation | D3 `prove-it-bites.sh` + quality-doc rule | — |
| C1 | researcher | flagship | contract | D5 acceptance-contract proposal | — |
| G1 | builder | junior | glob | D4 test-glob, verified then widened | — |
| A2 | researcher | standard | audit | D2 can-it-fail, all 27 gates + 10 guard phases | A1 |
| MI | builder | junior | main | integrate `mutation` | M1 |
| CI | builder | junior | main | integrate `contract` | C1 |
| GI | builder | junior | main | integrate `glob` | G1 |
| AI | builder | junior | main | integrate `audit` | A1, A2 |
| S1 | builder | standard | main | `check-instrument-execution.ts` + ledger, wired into `guard.sh` phase 1 | AI, MI, GI |
| REV | reviewer | standard | main | the one review of the whole diff | G1, M1, S1, MI, CI, GI, AI |

Rounds are computed from `depends_on`; no round numbers are declared. Seeded task ids:
A1 `c9357b4f` · M1 `acb3fe5e` · C1 `9351a1cf` · G1 `8caa1e50` · A2 `995e4c0a` ·
MI `cf4a7ab0` · CI `c2b09897` · GI `67ff2645` · AI `6420d0ad` · S1 `96ed6573` ·
REV `b2c6bf5d`.

**Three things the graph deliberately does not do.** It does not wire
`check-secret-scan.ts` in (S1 is briefed that failing on it is *correct*, and that
ledgering it to get green is a stop-and-escalate). It does not repair F2/F3/F4 — the
inert forbidden-file guard, gate 7's `exit 0`, the frozen-scope gates — because
repairing the forbidden-file guard changes what every lane in this repo may commit, and
Konrad should read the measurement before the semantics move; REV is told not to file
their survival as a finding. And no reviewer is seeded for the audit documents or the
acceptance-contract proposal: they are reports, and a reviewer told to examine a report
buys a fix cycle for prose.

## THE RULE THIS PROJECT LEAVES BEHIND

A check that has never been observed failing is a decoration. Every task that ships a
check ships the transcript of that check failing on a named mutation — one
`prove-it-bites.sh` invocation, pasted verbatim, restore proven by hash.
