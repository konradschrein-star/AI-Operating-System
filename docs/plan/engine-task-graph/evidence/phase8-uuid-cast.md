# Phase 8G — round 811: the uuid cast, the SQL regression test, and an instrument sha that covers both halves

**Task:** cast the uuid arm in `forge-control/src/lib/schedule-source.ts`,
regression-test the SQL by EXECUTING it, and close the `instrument-sha256` hole
round 810 found.

**This task shipped nothing.** No deploy, no restart, no migration, no write
anywhere under `/opt/forge-ai-os`, and **no read of the live database**. Every
statement below was executed against a throwaway PostgreSQL cluster this task
created in `TMPDIR` and stopped again. The pre-0040 window is still open and
`8ea0cc08` is still done and quiet.

**Frozen instrument identity for this round** (moved ONCE, before a single
document was written, per round 802's rule — other agents paste this value):

```
instrument-sha256: fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b
instrument-files:  39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
                   c00fd096e0b8ddc57bad52d4bb6ef27dd17793aeda542603570ce3f454e861e5  forge-control/src/lib/schedule-source.ts
```

---

## 0. Write-set, declared

| file | what changed |
|---|---|
| `forge-control/src/lib/schedule-source.ts` | the cast; the three statements extracted as exported constants; header rewritten |
| `forge-control/src/lib/schedule-source.test.ts` | §4.1 static analysis and §4.2 executing suite; `withDatabaseUrl()` lifted to module scope |
| `scripts/check-schedule-sql.sh` | **new** — provisions a throwaway cluster and runs §4.2 |
| `scripts/measure-schedule.ts` | `instrument-sha256` composites both halves; `instrument-files:` block added |
| `docs/plan/engine-task-graph/check-instrument-identity.py` | the same composite, check 1b, one-pass/one-exemption refactor |
| `docs/plan/engine-task-graph/00-vision.md` | §2.2 heading and parenthetical |
| `docs/plan/engine-task-graph/01-requirements.md` | R62 and R68: the one-file clause retired |
| `docs/plan/engine-task-graph/03-quality.md` | §3.1 item 7 and §3.2's phase-8 gate: the same |
| `docs/plan/engine-task-graph/04-phases.md` | §12 E-3's quoted formulation: the same |
| `docs/plan/engine-task-graph/evidence/baseline-8ea0cc08.md` | 8 headers re-derived, re-run record, §5(3) re-executed, ledger |
| `docs/plan/engine-task-graph/evidence/phase8-instrument.md` | 2 headers re-derived, round-802 records marked historical |
| `docs/plan/engine-task-graph/evidence/phase8-deploy.md` | §6(d) closed; round-810 header marked historical |
| `docs/plan/engine-task-graph/evidence/phase8-corpus.md`, `fix-cycle-2.md` | retired identities marked |
| `docs/plan/engine-task-graph/evidence/phase8-uuid-cast.md` | this file |

**Nothing else under `forge-control/src/` was touched.** `project-reconcile.ts`,
`project-tick.ts`, `db/projects.ts`, `workspace.ts` and `executor.ts` are
untouched, and `project-reconcile.test.ts` passes **unmodified**.

---

## 1. The failure, reproduced BEFORE the fix

A throwaway cluster, `initdb` into `TMPDIR`, unix socket only, no network
listener, nothing live within reach. Schema types taken from
`db/migrations/0021_ai_os_tables.sql` and `0030_coding_projects.sql`, not from
the live database.

`$1` is declared to no type, exactly as node-postgres parses it — the server
infers:

```
=== A. UNCAST, parameter type INFERRED (exactly how node-pg parses it):
ERROR:  operator does not exist: uuid = text
LINE 5: ...SELECT run_id FROM project_tasks WHERE project_id = $1 AND r...
                                                             ^
HINT:  No operator matches the given name and argument types. You might need to add explicit type casts.
exit=1

=== B. CAST arm (project_id = $1::uuid):
exit=0

=== C. the tasks query (single context, no conflict expected):
exit=0
```

**The cause, stated once.** `RUNS_SQL` binds `$1` twice:
`metadata->>'project_id' = $1` forces `text`, `project_tasks.project_id = $1`
forces `uuid`. Postgres types a parameter once per statement, so it cannot
resolve, and it fails at parse/analyze time — before a row is read, on every
project, with or without `--exclude-task`. `$1::uuid` on the uuid arm resolves
it: `$1` stays `text` and the cast is applied to that text. The cast is on the
uuid arm and not the json arm because casting the json arm would cast a column
expression on every row and discard the index.

**Why no test could have caught it.** The statement is a TypeScript string
literal. `tsc` type-checks the literal, not the SQL; the resolution that fails
happens inside Postgres. Round 215 said as much and left it — *"the SQL and the
pool stay untested from here and are phase 8's business"* — and phase 8's first
execution was round 810's, against the live database, in the one task with no
worktree fallback.

---

## 2. The regression test — and it FAILS against the uncast statement

Two layers in `schedule-source.test.ts`. The module's three statements are now
exported constants, so the test PREPAREs **the bytes that ship** rather than a
retyped copy that can drift.

### 2.1 §4.1 — static, always runs, opens nothing

Derives, per bound parameter, the set of types its UNCAST comparison sites force,
and reports a parameter forced to two. It classifies `->>` as `text` and the uuid
columns of the two migrations as `uuid`, and **fails on an operand it does not
recognise** rather than passing it as safe.

### 2.2 §4.2 — executing, the oracle

A static analysis of SQL is an opinion about SQL. §4.2 runs `readProjectRows()`
and the raw statements against the throwaway cluster and asserts:

- the end-to-end read completes on a pre-0040 schema, `depends_on` absent;
- **both arms of the OR still fire** — one run reached only through
  `project_tasks.run_id` (the cast arm), one reached only through
  `metadata->>'project_id'` (the text arm). A cast that "fixed" the statement by
  breaking the json arm would return one row here, and this is the assertion that
  would catch it;
- the **UNCAST form still fails with SQLSTATE 42883** — a permanent negative
  control, derived from the shipped constant rather than pasted beside it;
- a malformed project id raises `22P02` at the cast rather than matching nothing
  (the cast's one behavioural cost, pinned rather than discovered later);
- the schema probe and both `tasksSql()` shapes execute, before and after a
  simulated migration 0040.

### 2.3 The failure, demonstrated — the test has SEEN the bug

The cast was removed from the worktree copy, both layers run, and the copy
restored byte-identically (sha checked before and after: `c00fd096…` → mutate →
`c00fd096…`). Against the UNCAST statement:

```
############ §4.1 STATIC layer against the UNCAST statement ############
not ok 4 - the shipped SQL, read statically
  error: '3 subtests failed'
# pass 28
# fail 3

############ §4.2 EXECUTING layer against the UNCAST statement ############
    not ok 1 - THE REGRESSION: readProjectRows() completes end to end on a pre-0040 schema
      error: 'operator does not exist: uuid = text'
      code: '42883'
      stack: |-
        async readProjectRows (…/forge-control/src/lib/schedule-source.ts:183:21)
    ok 2 - NEGATIVE CONTROL: the uncast statement still fails, with the error round 810 hit
    not ok 3 - the shipped RUNS_SQL prepares and executes with the same binding
      error: 'operator does not exist: uuid = text'
      code: '42883'
    not ok 4 - a malformed project id fails loudly at the cast rather than matching nothing
      error: |-
        Expected values to be strictly equal:
        '42883' !== '22P02'
=== script exit: 1
```

Note the shape of §4.1's failures. With the cast gone, the negative-control
fixture becomes *identical* to the shipped statement and would silently stop
testing anything — and the positive control designed for exactly that says so:
*"RUNS_SQL no longer contains `$1::uuid`, so the negative controls below are
vacuous — either the cast was removed (the round-810 bug is back) or the
statement was rewritten."*

With the cast restored, `scripts/check-schedule-sql.sh` reports `# pass 36 # fail 0`,
exit 0.

### 2.4 NF3 is not weakened, and the skip is not a loophole

`pnpm test` opens no connection: §4.2 is skipped unless
`SCHEDULE_SOURCE_TEST_DSN` is set, and the default run reports 36 → 31 tests with
that suite skipped. That skip is the risk, so:

- `scripts/check-schedule-sql.sh` is the one command that runs it, and it
  provisions the cluster itself rather than asking anyone to have one;
- **measured, not assumed:** when §4.2 is skipped, `node:test` counts the whole
  suite as one PASSING suite and prints `# skipped 0` — the summary is
  indistinguishable from a real run. The script's positive controls therefore do
  not read that summary. They assert the SKIP marker is absent and that the
  regression test appears **by name** in the output, and fail if a rename ever
  silently removes it;
- the suite refuses, rather than skips, if the DSN names any database other than
  the scratch `schedule_sql_check` — an instrument that can be aimed at
  production by setting one variable is the failure this project keeps paying
  for.

---

## 3. The instrument-sha hole, closed where it is ENFORCED

### 3.1 What was wrong

`instrument-sha256` hashed `scripts/measure-schedule.ts` alone.
`schedule-source.ts` holds every line of SQL and the whole `pg` lifecycle and was
covered by nothing. Round 810's patched dry run printed the shipped instrument's
identity unchanged; only `git-head` differed, and the header itself says
`git-head` names the tree rather than the bytes.

Demonstrated directly, on this tree, by changing only the SQL half:

```
$ sha256sum scripts/measure-schedule.ts                                    # the OLD one-file rule
39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum   # the NEW rule
fb5a64345109bcdf3d083706b789b5c5a34b1234be4288fd359351c57803cf0b  -

# --- now change ONLY the SQL half, exactly as round 810 did in its scratch copy ---
$ sha256sum scripts/measure-schedule.ts                                    # the OLD one-file rule
39dee069b52c53ab75098b663dec01e1a92b8491e088644ff6cda61605ac1d03  scripts/measure-schedule.ts
$ sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum   # the NEW rule
a680d07b396488dafa21a806905101f607ce0035986e71925a917e9d7a2b16ca  -
```

The old rule's digest does not move. That is the hole, executed rather than
argued, and round 811's fix landed inside it.

### 3.2 The replacement

`instrument-sha256` is the sha256 of a MANIFEST of both files, in a fixed order.
The manifest is byte-for-byte what `sha256sum` prints, so the header is
re-derivable with stock coreutils and no knowledge of either program:

```
sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum
```

The header now also prints an `instrument-files:` block naming each half's own
digest, so a mismatch says WHICH half moved. Reading those bytes is not importing
them — `pg` stays out of a fixture-mode run's module graph; `selfIdentity()` uses
`readFileSync`. The instrument additionally refuses (`self-misplaced`) if it is
not running from the path the manifest names, because `REPO_ROOT` is derived from
its own location and from the wrong location every digest under it would name
bytes chosen by accident.

`check-instrument-identity.py` computes the same manifest and gained:

- **check 1b** — every pasted `instrument-files:` line equals the current digest
  of the half it names;
- **a widened historical set** — retired *per-file* digests count as retired
  identities alongside retired composites;
- **one pass, one exemption rule.** Checks 1, 1b and 2 were three loops with
  three different notions of the `[historical instrument]` escape; check 1 had
  none at all, so a transcript of an older checker run could not be preserved
  without editing its bytes. They are now one loop over one `exempt` decision.
  Consequence, stated because it is a real change: an exempt header no longer
  counts toward `MIN_HEADERS` — a marked historical header says nothing about the
  disk now, and counting it would let the positive control be satisfied by
  headers that are all historical.

### 3.3 The checker, mutation-tested

A gate that has never failed is a gate nobody has tested. Three mutations, each
applied and reverted:

| mutation | verdict |
|---|---|
| append a byte to `schedule-source.ts` — **the exact hole** | `FAILED — 21`; names both the composite and *"THIS half of the instrument moved"* for `schedule-source.ts` |
| append a byte to `measure-schedule.ts` | `FAILED — 21`; names the composite and the `measure-schedule.ts` half |
| corrupt ONE pasted manifest line | `FAILED — 1`, naming that line and that half only |
| restored | `OK — 10 pasted header(s) … OK — 23 pasted manifest line(s) … OK — no retired identity quoted without the marker` |

---

## 4. The twelve headers, re-derived

All twelve were re-derived by **re-running the instrument**, never by editing a
digit — except the two that cannot be re-run, which are marked.

**Ten re-derived.** Seven fixture runs and one refusal in
`baseline-8ea0cc08.md`, two fixture runs in `phase8-instrument.md`. The
`phase8-instrument.md` fixture is not committed; its generator is pasted in that
file's §3.0 and was re-run first — it reproduced
`sha256=0eb6bc18266b6e4977762380ccf88bcde8a11a186464d7bebc4c64e128f62633`
byte-for-byte, so the runs above it are the same runs.

The substitution was done by a script that **refuses** to replace a header unless
every line of the block below `mode:` reproduces byte for byte between the pasted
transcript and the fresh run — a changed body would mean the numbers moved, which
is a finding and not a re-paste. It reported all ten reproduced:

```
all header blocks re-derived; every body below 'mode:' reproduced byte for byte
```

Exit codes reproduced too: 0 ×6 and **1** for run C, 1 for the un-excluded d8
demo and 0 with the exclusion.

**Two marked `[historical instrument]`, not invented:**

| where | why it cannot be re-derived |
|---|---|
| `phase8-deploy.md` §5.5 | printed by a **patched copy at `cc646b1`** reading the live database — that tree no longer exists, and this phase may not repeat that read |
| `phase8-corpus.md` §7.1 | a transcript of a checker run that FAILED at a past moment; re-running it would destroy the record it exists to keep |

Beyond the headers, every remaining mention of the retired one-file digests
(`6ec72b35…` for the script, `367c48fb…` for the SQL half) `[historical instrument]` was marked at its line
or, inside a transcript where an inline marker would falsify the paste, by the
checker's own declared prose-above-the-fence escape.

*(This document failed its own gate on the two lines above before they carried
the marker. That is the gate working, and it is recorded rather than quietly
fixed.)*

## 5. The gate clauses, retired WITH the rule

Standing rule: retire a requirement and its gate clause together, in one commit.
Four documents stated the identity as `sha256sum scripts/measure-schedule.ts`.
That command no longer produces the header's value, so those clauses were not
merely loose — they were **unsatisfiable**, which is the "gate that cannot be
passed" this project has been bitten by. All four amended in this commit:

- `01-requirements.md` §H **R62** *How proved*, and its part-1 bullet restatement
- `01-requirements.md` **R68** *How proved*
- `03-quality.md` §3.1 **item 7** (the universal gate — the enforcement point)
- `04-phases.md` §12 **E-3**'s block-quoted formulation

`evidence/phase8-corpus.md`'s quotation of the round-217 formulation is marked
superseded rather than rewritten, because it is a record of what round 802 read.

---

## 6. Gates

```
$ python3 docs/plan/engine-task-graph/check-instrument-identity.py     exit=0
    OK — 10 pasted header(s) across 2 file(s) name fb5a6434…
    OK — 23 pasted manifest line(s) name the current digest of their half
    OK — no retired identity quoted without '[historical instrument]'
$ python3 docs/plan/engine-task-graph/check-corpus-map.py              exit=0
    OK — R1..R71 and NF1..NF7 complete, all three statements of the map agree.
$ python3 scripts/checks/check-r20-census.py                           exit=0
$ bash scripts/checks/check-instrument-typecheck.sh                    exit=0
    6/6 entries compiled clean, manifest complete
$ cd forge-control && ./node_modules/.bin/tsc --noEmit                 exit=0
$ ./node_modules/.bin/tsx --test src/lib/*.test.ts
    # tests 1278  # suites 237  # pass 1278  # fail 0  # skipped 0     exit=0
$ scripts/check-schedule-sql.sh
    # tests 36  # pass 36  # fail 0                                    exit=0
```

`project-reconcile.test.ts` passes unmodified; this round changed no
consolidation code and no consolidation test.

---

## 7. What would have made my instruments report a pass WRONGLY

1. **A test written after the fix.** It would have passed against the uncast
   statement too, because it would only ever have asserted "no error". Answered
   by running both layers against the uncast statement and pasting the failures
   (§2.3), and by keeping the uncast form in the suite as a live negative
   control.
2. **A negative control that quietly stopped testing.** `RUNS_SQL_UNCAST` is
   derived from `RUNS_SQL`; if the cast is removed the two become identical and
   the control asserts nothing. Answered by the positive control that compares
   them and fails.
3. **A `# pass` line from a suite that skipped the half that matters.** Measured:
   `node:test` reports `# skipped 0` for a skipped suite. Answered by asserting
   on the SKIP marker and the regression test's name, not on the summary.
4. **A checker that never fails.** Answered by §3.3's three mutations.
5. **Re-deriving a header by editing its digits.** Answered by a substitution
   script that only ever copies fresh stdout, and refuses if the body moved.
6. **Marking a header historical to make a red gate go green.** Both marked
   headers are marked with a stated reason a reader can check: one names a tree
   (`cc646b1`) that is not in this repository, the other is a transcript of a
   FAILED run. Everything re-runnable was re-run.
7. **A composite only my own code can compute.** Answered by defining the
   manifest as `sha256sum`'s own output format, and pasting the coreutils
   pipeline's result beside the instrument's self-computed value in
   `baseline-8ea0cc08.md` §5(3). They agree.

---

## 8. Findings for the next round

1. **`check-instrument-identity.py`'s `historical shas:` block labels each digest
   `first seen <commit>`, but `git log` is reverse-chronological and the code
   takes the first commit it walks — so the label names the MOST RECENT commit
   carrying that digest, not the first.** Pre-existing, unchanged by this round,
   and diagnostic only: no check reads it. It is reported rather than fixed
   because the printed values are quoted in pasted transcripts, and changing the
   behaviour or the wording would invalidate them for no gain in what the gate
   proves. A round that touches this file should fix the label and re-derive
   those transcripts together.
2. **`scripts/check-schedule-sql.sh` leaves its scratch cluster on disk**
   (server stopped, path printed). Deliberate: this repo's standing rules reserve
   `rm -rf` for an explicit instruction. If a future round is told to, the
   cleanup is one line in the script's `cleanup` trap.
3. **The 22P02 path is pinned but unnamed.** A malformed project id now raises a
   raw `pg` error rather than a `ScheduleSourceError`. Left alone deliberately —
   it throws with a legible SQLSTATE and is not a silent fallback, and the
   instrument's sha is expensive to move twice. A future round wanting a named
   refusal has the assertion already in place to change.
