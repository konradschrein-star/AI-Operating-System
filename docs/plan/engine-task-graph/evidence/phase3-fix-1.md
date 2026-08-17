# Round 215 — fix cycle 1: the ten findings of round 214, closed

Two gating reviews landed NEEDS_FIXES in round 214 — phase 3 (task creation,
validation, cycle detection) with six findings, and phase 7 (the measurement
instrument) with four. This file records what was changed, what was **run**, and
for each defect the transcript of the instrument **failing before** the fix, so
that no claim here rests on an assertion that could have passed for the wrong
reason.

**Base:** `99cb121`, branch `project/8c591d6c`.
**Worktree only.** Nothing under `/opt/forge-ai-os` was touched; the only
database used was `$SCRATCH_DATABASE_URL` (`forge_tg_scratch`), created per
`check-task-api.ts`'s operator preamble.

---

## 0. The mandated block (`03-quality.md` §4)

```
$ cd $WORKTREE/forge-control && pnpm typecheck
> tsc --noEmit                                        → exit 0, no diagnostics

$ pnpm test
# tests 1004   # suites 183   # pass 1004
# fail 0       # cancelled 0  # skipped 0   # todo 0  → exit 0

$ git -C /opt/forge-ai-os status --porcelain
                                                      ← EMPTY. exit=0.
$ python3 docs/plan/engine-task-graph/check-corpus-map.py
  defined: 69 R + 7 NF ; phases 1–8 all "agree"
  OK — R1..R69 and NF1..NF7 complete, all three statements agree
                                                      → exit 0

$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
  forge-control/src/lib/project-tick.test.ts:213   (asserts the prohibition exists)
  forge-control/src/lib/project-tick.test.ts:214   (its failure message)
  forge-control/src/lib/project-tick.ts:313        (shipped prompt: "NEVER run …")
  forge-control/src/lib/project-tick.ts:345        (DEPLOY_GUIDE: "NEVER …")
  4 hits, the expected count, every one a string literal inside a NEVER-worded
  prohibition. No executable position.                → see finding 5
```

Test count moved 970 → 1004, +34: `task-graph.test.ts` 99 → 103 (finding 3),
`schedule-metrics.test.ts` 34 → 39 (phase-7 findings 1 and 2), the new
`schedule-source.test.ts` 23 (phase-7 finding 4), the new
`source-hygiene.test.ts` 2 (finding 2 — one arm per scanned tree). No test file was deleted and nothing was skipped
or marked todo.

**Scripts outside `tsconfig.include`, typechecked with their own invocation:**

```
$ tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
      --allowImportingTsExtensions --skipLibCheck --esModuleInterop --resolveJsonModule \
      ../scripts/measure-schedule.ts            → exit 0
      ../scripts/checks/check-task-api.ts       → exit 0   (was exit 2 at 99cb121 — §1.4)
```

---

## 1. Phase 3, finding 1 — the `round` guard accepted non-integers

**Fix:** `routes/projects.ts`, the same expression the two round-213 rulings
amended, now leads with `typeof body.round !== "number"` **before** `Number()`
can coerce. Message reused verbatim: unlike ruling 2's out-of-range case, `[]`
and `"1"` genuinely are not non-negative integers, so the existing sentence is
true of them. R22a's prose carries the clause (`01-requirements.md` §C).

### 1.1 The four bodies, measured through the mounted router at `99cb121`

Reproduced independently of the review, by reverting the new clause and running
the probe. Before:

```
{"round":[]}      → 201, stored round 0
{"round":true}    → 201, stored round 1
{"round":"0x10"}  → 201, stored round 16
{"round":""}      → 201, stored round 0
```

After (probe cases 2f–2i, pasted from the run):

```
req  {"role":"builder","title":"c2f",…,"round":[]}
res  400 {"error":"round must be a non-negative integer"}
ok   2f status is 400 and NOT a coerced 201 — = 400
req  {"role":"builder","title":"c2g",…,"round":true}
res  400 {"error":"round must be a non-negative integer"}
ok   2g status is 400 and NOT a coerced 201 — = 400
req  {"role":"builder","title":"c2h",…,"round":"0x10"}
res  400 {"error":"round must be a non-negative integer"}
ok   2h status is 400 and NOT a coerced 201 — = 400
req  {"role":"builder","title":"c2i",…,"round":""}
res  400 {"error":"round must be a non-negative integer"}
ok   2i status is 400 and NOT a coerced 201 — = 400
```

### 1.2 Case 2j — the consequence, not the coercion

The finding is not that `""` coerces; it is that a phase which made `round`
optional turned that coercion into a **round-0 pending row that blocks every
legacy row of the project**. So the probe asserts the redirection, not just the
refusal: the same body, twice, with a real dependency at round 600.

```
ok   2j the empty-string round is refused, not read as 0 — = 400
ok   2j omitting it computes 601 — the round the typo was stealing — = 601
```

### 1.3 Watched failing (the instrument, not the code)

Deleting the three new lines from `routes/projects.ts` and re-running:

```
FAIL 2f status is 400 and NOT a coerced 201 — expected 400, got 201
MISSED case 2 declares 21 assertion(s) but executed 12 — a case that does not
       run what it declares cannot certify anything.
  assertions executed 102 / declared 111 ; failed 1
  FAIL executed 102 assertions but 111 are declared
FAILED — 1 case(s): 2                                        PROBE_EXIT=1
```

Both halves of failure mode (b) fired: the assertion went red **and** the census
caught the nine assertions the aborted case never reached. Restored;
`git status --porcelain` empty.

### 1.4 One unbriefed repair, disclosed

`check-task-api.ts` did **not compile** under `tsc --strict` at `99cb121`:

```
check-task-api.ts(1100,84): error TS2322: Type 'Buffer<ArrayBufferLike>' is not
  assignable to type 'BodyInit | null | undefined'.
```

`tsx` strips types without checking them, so the probe ran and the defect was
invisible to every gate — an instrument that cannot be typechecked, in a project
about instrument honesty. Fixed by passing `new Uint8Array(body)` to `Request`,
which copies the same bytes; reasoning is inline at the site. Behaviour
unchanged, and the probe's 111 assertions are green either way.

### 1.5 The full probe run

```
git HEAD : 99cb121   branch: project/8c591d6c   (uncommitted: this fix cycle)
bind     : http://127.0.0.1:7799/api/projects (never 7700)
cases planned 20 / ran an assertion 20 ; declared 111 / executed 111 / failed 0
PASS — 20 cases …
teardown : schema tg_check_api dropped, :7799 closed          PROBE_EXIT=0
```

---

## 2. Phase 3, finding 2 — the NUL byte that blinded two gates

One `0x00` at byte offset 38998, line 766, of
`forge-control/src/lib/task-graph.ts` at SHA `99cb121` —
`normaliseWritePath()`'s doc-comment wrote `"a<NUL>b"` literally instead of as
an escape. Nothing misbehaved at runtime; what broke was every text tool that
reads the tree, including `03-quality.md` §3.2's own `TODO(R12-retire)` gate,
which reported **no occurrences where four exist**.

**Fix, two parts.** The byte is now written as the six-character escape
`\u0000` in the comment. That is also what the refusal message shows a caller
(`JSON.stringify` escapes it), so the doc and the behaviour spell it the same
way. And `forge-control/src/lib/source-hygiene.test.ts` scans for `0x00` bytes,
so the next one is caught by `pnpm test` rather than by a reviewer's first grep.

**The lint has two arms, and the second exists because I reproduced the defect
while writing this file.** Drafting §2 put a raw NUL into
`evidence/phase3-fix-1.md` — inside the sentence describing the escape — and
`grep -n` immediately answered `binary file matches` on the evidence document
itself. The corpus is precisely what a gating reviewer greps, so it is scanned
too. Arm 1 covers every file under `forge-control/src/` regardless of
extension, since that tree has no binaries and an unexpected `.bin` should be
caught rather than skipped. Arm 2 covers `docs/plan/` restricted to greppable
text extensions: that tree holds several hundred `.png` review artifacts, and a
PNG begins with a NUL by specification. Scanning them would have produced an
unsatisfiable gate — the exact defect this same round amended in finding 5 —
and the narrower question ("are the files a reviewer greps still greppable?")
is the one actually at stake. The exclusion is a named constant with the
reasoning beside it, not a silent skip.

```
$ file forge-control/src/lib/task-graph.ts
  before: … data
  after:  … JavaScript source, Unicode text, UTF-8 text

$ git grep -n "TODO(R12-retire)" -- forge-control/src/lib/task-graph.ts
  before: exit=1  (four occurrences exist)
  after:  4 lines
```

**The lint watched firing**, because a scan that never scans certifies
everything:

```
$ printf 'const x=1;//a\0b\n' > src/lib/__p.tmp.ts
not ok 1 - no file under forge-control/src/ contains a raw NUL byte
      lib/__p.tmp.ts: NUL at byte offset 13 (line 1)

$ printf 'a\0b\n' > ../docs/plan/__nul-probe.tmp.md
not ok 2 - no GREPPABLE file under docs/plan/ contains a raw NUL byte
      __nul-probe.tmp.md: NUL at byte offset 1 (line 1)

$ rm both probes && npx tsx --test src/lib/source-hygiene.test.ts
ok 1 - no file under forge-control/src/ contains a raw NUL byte
ok 2 - no GREPPABLE file under docs/plan/ contains a raw NUL byte
# pass 2  # fail 0
```

Each arm also asserts its own reach before believing its own verdict — a
minimum file count and one path the walk must contain — so a walk that silently
found nothing fails instead of certifying everything. The `docs/plan/` arm's
extension filter was measured, not assumed: run unfiltered it reported 300+
PNG "offenders", which is how the constant came to be named and reasoned about
rather than quietly applied.

### 2b. The NUL survives in git history, and that is expected — recorded round 217

Round 216's re-review, advisory finding 3, recorded here so the next reviewer's
`git log -p | grep` does not become a mystery. **The byte is gone from the
working tree and from every gate's field of view, but a commit that REMOVES a
NUL still contains one**, on its `-` line. Measured, round 217:

| command | NUL bytes | note |
|---|---|---|
| `git show 34268e9` | **1** | at offset 113463 of the diff stream — the removed line |
| `git log -p main..HEAD` | **2** | the same line, added and then removed |
| `git diff main...HEAD` | **0** | the form `03-quality.md` §3.1 and §4 actually use |
| working tree, `forge-control/src/` + `docs/plan/**.md` | **0** | `source-hygiene.test.ts`'s two arms |

So `git show`/`git log -p` will report `binary file matches` on this branch
forever, and that is **not** a regression: history rewriting is forbidden here
(standing rules; force-push needs explicit instruction), and no gate reads those
forms. Anyone re-deriving this: `grep -c $'\x00'` **cannot** measure it — bash
strips the NUL from `$'\x00'`, leaving an empty pattern that matches every line
and reports thousands. Round 217's first attempt did exactly that and had to be
thrown away. Count the bytes (`python3 -c "…stdout.count(b'\x00')"`), which is
what the table above did.

---

## 3. Phase 3, finding 3 — `normaliseWritePath` missed an interior `./`

`src/./a.ts` returned itself, so it and `src/a.ts` were **two spellings of one
file that did not conflict** under R16's exact string equality: two builders of
the same workstream, both claimable, one worktree, one file. That is
`03-quality.md` §6's "contention belt too loose", and phase 4's isolation rests
on this function being canonical.

**Fix:** `/\/\.\//g → "/"` joins the same fixpoint loop that collapses `/{2,}`.
Inside the loop, not beside it: `/./` matches overlap on the shared slash, so
one global replace leaves `src/././a.ts` half-done. R28's prose and the
doc-comment's "WHAT IS NOT REFUSED" paragraph were retired **in the same
commit** as the behaviour they described.

| entry | before | after |
|---|---|---|
| `src/./a.ts` | `src/./a.ts` | `src/a.ts` |
| `./src/./a.ts` | `src/./a.ts` | `src/a.ts` |
| `src/././a.ts` | `src/././a.ts` | `src/a.ts` |
| `src/../x` | refused | refused (`/../` holds no `/./`) |
| `src/a..b/c.ts` | unchanged | unchanged |
| `.` , `src/.` | unchanged | unchanged (still accepted, now stated) |

The test that matters asserts the **belt**, not the string:
`conflicts([normaliseWritePath("src/a.ts")], [normaliseWritePath("src/./a.ts")])
=== true`.

**Watched failing** — removing the one added `.replace()`:

```
not ok 11 - normaliseWritePath — normalise, then validate the result (R28)
# pass 101  # fail 2
```

Exactly two: the interior-collapse case and the `conflicts()` case. Restored →
103 pass, 0 fail.

---

## 4. Phase 3, findings 4 and 6; phase 7, finding 4 — the record, no code

- **F4 / P7-F4 (write-set audit).** `04-phases.md` §10 gains a
  "Writes recorded after the fact" table naming builder 4's two undeclared
  phase-3 writes (`routes/projects.ts`, `01-requirements.md`, required by
  standing rule 2), round 212's `schedule-source.ts`, and this round's two new
  test files. The ownership table itself gains `schedule-source.ts`,
  `check-task-api.ts` and `source-hygiene.test.ts` as rows.
- **F6 (R39's cap is TOCTOU).** Recorded under R39 in `01-requirements.md`:
  `listTasksForProject()` is read once, before validation, so two concurrent
  POSTs proposing different new workstreams can both pass a five-workstream
  check. Not fixed here — blast radius is disk, and phase 4's
  `provisionWorkstream()` holds a second refusal reading the same exported
  constant. **Phase 4's red team owns the decision.**

---

## 5. Phase 3, finding 5 — the unsatisfiable `pm2 restart forge-executor` gate

`03-quality.md` §4's block said `# any survivor is a finding` over a filter
(`grep -v -i "never\|forbidden\|not to deploy"`) narrower than R66's own rule
("except inside a sentence forbidding it"). **Measured: 13 survivors on this
tree, every one prose forbidding the command.** The gate could not be passed by
any tree, and three consecutive rounds disclosed-and-proceeded against it.

**Amended where it is enforced**, in the same commit as R66's "How proved"
clause. The sweep drops `--include='*.md'` (a `.md` executes nothing, and every
`.md` hit in this corpus is a prohibition by construction) and drops the `-v`
filter entirely; the comment now states R66's actual rule and names the expected
count, so a fifth hit is a signal.

```
before:  13 survivors, permanently                          → ungateable
after:    4 hits, all NEVER-worded string literals          → readable, passable
```

**A diff-narrowed form was considered and rejected**, and the measurement is
recorded so the next round does not re-derive it:
`git diff $(git merge-base main HEAD)...HEAD | grep '^+.*pm2 restart…'` yields
**10 hits** — this branch *created* the corpus, so every prohibitive prose line
is a `+` line on it. It would have been the same unsatisfiable gate wearing a
diff.

---

## 6. Phase 7, finding 1 — S3 reports 0 for a backfilled project

**The highest-severity finding of the round, and it succeeded through the
database rather than through the code.** `numberingStall()`'s D7 refusal keys on
`depends_on IS NULL`. Migration `0040_task_graph.sql`'s final statement writes
the strictly-lower-round closure over exactly that sentinel:

```sql
UPDATE project_tasks pt SET depends_on = COALESCE((SELECT array_agg(e.id …)
  FROM project_tasks e WHERE e.project_id = pt.project_id AND e.round < pt.round), '{}')
 WHERE pt.depends_on IS NULL;
```

Under that closure every dependency completes exactly when the task's round
drains, which is exactly when the old engine promoted it, so every stall term is
0 **by construction**.

### 6.1 Reproduced, independently of the review

A fixture holding the literal motivating case — one 32-minute reviewer at round
1, seven unrelated builders at round 2, `depends_on` as 0040 writes it — run
through the **committed** instrument at `99cb121`:

```
census:  tasks=8 runs=8 top-level=8 sub-agent=0 archived=0 tasks-without-run=0
         legacy-rows=0 graph-rows=8
S3 max numbering stall (min)          0 (over 7 tasks with a recorded dependency set)
                                                                        exit=0
```

The instrument certifying "no numbering stall" for the project whose numbering
stall is this project's entire justification, with no header field disclosing
why.

### 6.2 The fix — ordering *and* a detector, because neither suffices alone

**Ordering**, one commit across all three places that state it: `04-phases.md`
§8 gains **step 2b** (read the baseline BEFORE step 3 applies the migration),
E-3 in §12 carries the reasoning and the SQL, R62's prose in
`01-requirements.md` §H is amended from "before the after-measurement" — which
permitted the read *after* the migration — to step 2b, and `03-quality.md`
§3.2's phase-8 gate checks the order **in the evidence file, not the intent**.

**Detector**, because correctness must not rest on the order two deploy steps
happen to run in: `isClosureShaped()` in `schedule-metrics.ts` refuses S3 when
every row's `depends_on` equals the strictly-lower-round closure, and
`census.closureShapedRows` prints in the header in **both** modes. Same fixture,
same command, after the fix:

```
census:  … legacy-rows=0 graph-rows=8 closure-shaped-rows=8
S3 max numbering stall (min)          NOT COMPUTABLE (0 legacy rows, 8 closure-shaped rows)
   reason: all 8 tasks carry a depends_on equal to the set of tasks at a strictly
   lower round — byte for byte what migration 0040's R6 backfill writes … This is
   a SIGNATURE, not a proof …
```

**It is declared a signature, not a proof, and the cost is stated rather than
hidden.** A strictly serial graph-scheduled project produces the same bytes; for
it the refusal costs a true 0. The trade is one-sided on purpose: a wrong 0 is a
certified lie about the number this project is judged on, a wrong refusal is a
visible NOT COMPUTABLE naming its own reason. DoD-6's after-measurement wants a
project with real fan-out, and a closure-shaped one would mean the fan-out never
happened — itself the finding.

**Perfect fan-out is not accused of being a backfill.** Every task a root at one
round satisfies the closure test *vacuously*. The `hasEdge` guard keeps the
backfill reason off it; S3 is still not computable for that project, but for the
honest pre-existing reason that there is no edge to measure across. The guard
buys a correct explanation, not a different verdict, and the doc-comment says so
rather than overclaiming.

### 6.3 Regression check on the real fixture

```
$ tsx ../scripts/measure-schedule.ts rounds --fixture src/lib/fixtures/replay-operator-visibility.json
depends_on: absent (0/131 fixture rows carry a depends_on key)
census:     tasks=131 legacy-rows=131 graph-rows=0 closure-shaped-rows=0 …
            87 rounds, 131 tasks, 1.51 tasks per round                  exit=0
```

Unchanged against `evidence/baseline-8ea0cc08.md` §2 apart from the new header
field, which reads 0 as it must: an absent `depends_on` key is the *other* D7
arm, not this one.

---

## 7. Phase 7, finding 2 — the D7 test that never fed the hazardous input

The block's only closure-related assertion was
`assert.match(stall.reason, /backfilled closure/)`, which fires on the
`depends_on IS NULL` path. **No test ever fed rows carrying the closure**, which
is why finding 1 survived 970 green tests.

`describe("D7 — a project carrying migration 0040's backfilled closure")` adds
five table-driven cases: the refusal; a proof that the arithmetic it refuses
really would have been 0 (recomputed from the fixture, independently of the
module); the census disclosure; that **one** non-closure row restores
measurability; and that perfect fan-out gets the right reason.

**Watched failing against the pre-round-215 module** — the requirement finding 2
made explicit. Restoring `schedule-metrics.ts` from `HEAD` and running the new
test file:

```
not ok 1 - S3 REFUSES — it must not report the 0 the closure computes to
      Expected values to be strictly equal:  true !== false
not ok 3 - the census discloses it even though no row is legacy any more
not ok 4 - ONE row breaking the closure is enough to measure again
not ok 1 - counts every population the header names
# pass 35  # fail 4
```

Restored (`cmp` byte-identical) → 39 pass, 0 fail.

---

## 8. Phase 7, finding 3 — `MeasurementError`'s self-refuting enumeration

The block enumerated three D6 reasons plus "THREE FURTHER REASONS, DECLARED
RATHER THAN SMUGGLED" — six — while the code throws **seven**.
`"unterminated-run"` was thrown by `runIntervals()` and named in
`01-requirements.md`, but appeared in that enumeration nowhere; and
`"missing-timestamp"` was described as covering "a run in scope that started and
never terminated (D5)", which it does not and never did.

Corrected, both halves. `"unterminated-run"` is now declared as D5's, with its
`allowUnterminated` escape and the reason the two alternatives (treat as
instantaneous, or end at the window edge) both flatter S2. `"missing-timestamp"`
now describes what it actually covers: `Date.parse` failures, and the dependency
case in `numberingStall()` where a dependency's run has no `completed_at`. The
count reads FOUR further reasons.

Verified against the code, not the prose — and the first attempt at that
verification was itself wrong, which is worth recording. `grep -o
'MeasurementError("[a-z-]*"'` returns **six**, because `runIntervals()` throws
`"unterminated-run"` on the line *after* the constructor call and a single-line
grep cannot see it. That is how the string went undeclared in the first place: a
one-line sweep counts six and the block says six, and the two agree for the
wrong reason. `grep -A2 'new MeasurementError(' | grep -oE '"[a-z-]+"' | sort -u`
returns all **seven**, matching the amended enumeration exactly:

```
inverted-interval  missing-timestamp  no-measurable-runs  span-too-long
too-few-tasks      unresolvable-run   unterminated-run
```

---

## 9. Phase 7, finding 4 — `schedule-source.ts`, undeclared and untested

The declaration half is §4 above. The coverage half is
`forge-control/src/lib/schedule-source.test.ts`, **23 cases**, on the module
phase 8's live read runs entirely through.

`taskRow()` and `runRow()` are now exported for it, with the reason at the site:
everything in the module was reachable only through `readProjectRows()`, which
needs a pool, and NF3 forbids a test that opens a connection. The **mapping** is
pure, and it is the half most likely to be wrong — it is where `pg`'s runtime
types (a `Date` for `timestamptz`, `null` for an absent column) meet
`MetricTask`'s declared ones, invisible to `tsc` because the query result is
`Record<string, unknown>`.

Covered: the `no-dsn` refusal for both an **unset** and an **empty**
`DATABASE_URL` (`""` is what `export DSN=$MISSING` produces, and
`new pg.Pool({connectionString: ""})` silently falls back to libpq's defaults —
the wrong-database failure arriving by a different door); that the refusal never
echoes a connection string; `Date` → ISO for every timestamp; **`depends_on`
ABSENT rather than null on a pre-0040 schema**, which is E2's distinction and
cannot be caught downstream; the NULL sentinel surviving as `null`; and ten
`db-shape` refusals, each asserted to name its row index and the project.

NF3 holds: `readProjectRows()` builds its pool **inside** the function and the
`no-dsn` check is its first statement, so the one call in the suite returns
before a Pool exists. The SQL and the pool lifecycle are deliberately not tested
here — they need a database, they are phase 8's, and a mocked `pg` would prove
only that the module equals a mock.

---

## 10. Answers to §4's three questions

### Q1 — what would have made my instruments report a pass wrongly?

Four mechanisms, each closed by an action rather than by an argument.

1. **A test asserting the fix I just wrote.** Every behavioural claim above was
   watched **red first**, against the pre-fix bytes: the round guard (§1.3), the
   NUL lint (§2), the path normaliser (§3), the closure detector (§7). In each
   case the *number* of failures was checked too — two for the normaliser, not
   "some" — because a mutation that reddens everything proves only that the
   suite runs.
2. **Restoring a mutation imperfectly.** Every restore was verified with `cmp`
   against a pre-mutation copy, and `git status --porcelain` is clean in both
   the worktree and `/opt/forge-ai-os`.
3. **A probe reading a different database.** `check-task-api.ts`'s positive
   control (the seeded project must be visible through the mounted router)
   aborts before the first refusal is asserted; it was left in place and the run
   reached its 111 assertions, which is that control passing.
4. **A closure detector that fires on everything.** The false-positive class is
   real and is stated at the function, not discovered by a reviewer: a strictly
   serial graph project matches the signature. Two tests pin the boundary — one
   non-closure row restores measurability, and perfect fan-out is refused for
   the *other* reason with `assert.doesNotMatch(stall.reason, /0040/)`.

### Q2 — which gate did I find unsatisfiable?

**One, and it is finding 5** — `03-quality.md` §4's `pm2 restart forge-executor`
block, amended where it is enforced together with R66's "How proved" clause, in
one commit, with the measurement of both the old form (13 permanent survivors)
and the rejected diff form (10) recorded in §5 above. I also **rejected my own
first repair**: the diff narrowing was written, measured, found to be equally
unsatisfiable on this branch, and replaced — the rejection is in the corpus so
the next round does not spend a cycle on it.

No other gate resisted. The phase-8 gate gained two clauses (§6.2 and R31's
ordering) and both are checkable commands against artifacts phase 8 produces.

### Q3 — citations, write-set, silent fallbacks

**Citations.** Every claim above is by symbol name (`normaliseWritePath`,
`conflicts`, `isClosureShaped`, `isLegacyRow`, `numberingStall`, `runIntervals`,
`readProjectRows`, `taskRow`, `runRow`, `roundSupplied`, `legacyRoundReady`) or
by requirement/decision id. The one byte-level pin — the NUL at offset 38998,
line 766 — is pinned to SHA `99cb121` and is the defect itself, not a reference
to one. No bare `file.ts:NN` was introduced.

**Write-set, declared before the work and recorded in `04-phases.md` §10:**

```
forge-control/src/routes/projects.ts               (F1)
forge-control/src/lib/task-graph.ts                (F2, F3)
forge-control/src/lib/task-graph.test.ts           (F3)
forge-control/src/lib/source-hygiene.test.ts       (F2, new)
forge-control/src/lib/schedule-metrics.ts          (P7-F1, P7-F3)
forge-control/src/lib/schedule-metrics.test.ts     (P7-F1, P7-F2)
forge-control/src/lib/schedule-source.ts           (P7-F4)
forge-control/src/lib/schedule-source.test.ts      (P7-F4, new)
scripts/measure-schedule.ts                        (P7-F1 header)
scripts/checks/check-task-api.ts                   (F1)
docs/plan/engine-task-graph/01-requirements.md     (R22a, R28, R39, R62, R66)
docs/plan/engine-task-graph/03-quality.md          (§3.2 phase 8, §4)
docs/plan/engine-task-graph/04-phases.md           (§8 step 2b, §10, §12 E-3)
docs/plan/engine-task-graph/evidence/phase3-fix-1.md (this file, new)
```

Actual writes match this list exactly.

**Silent-fallback audit (NF1)** — every `catch`, `??` and `||` this round added:

| site | why it is not a swallowed error |
|---|---|
| `routes/projects.ts` `typeof body.round !== "number"` | A REFUSAL, the opposite of a fallback. The `Number()` below it is now a provable identity, kept and labelled so this stays the one expression all three rulings amended. |
| `schedule-metrics.ts` `isClosureShaped()` `return false` on a null/undefined `depends_on` | Routes the row to the OTHER D7 arm, which refuses. Not a default — a legacy row is refused either way, and answering `true` here would give it the wrong reason. |
| `numberingStall()` `hasEdge` guard | Chooses between two refusals, never between a refusal and a number. Both arms return `computable: false`. |
| `schedule-source.test.ts` `withDatabaseUrl` restore | Test scaffolding in a `finally`, restoring the *distinction* between an absent and an empty variable rather than collapsing it. |
| `source-hygiene.test.ts` `EXEMPT` set | **Empty**, and the emptiness is the point: adding to it is a decision someone has to write down beside a reason. |
| `check-task-api.ts` `body === undefined ? undefined : new Uint8Array(body)` | Preserves the GET/HEAD "no body" case exactly as before; a bodied request gets the same bytes copied. Nothing is defaulted. |

No `catch` was added anywhere in this cycle, and no existing one was widened.

---

## 11. What is NOT closed

- **F6 (R39 TOCTOU)** is recorded, not fixed, per the reviewer's own
  non-blocking judgement. Phase 4's red team decides whether
  `provisionWorkstream()`'s refusal is sufficient.
- **R42** — `createFixChain()` still mints a `depends_on IS NULL` row on every
  fix cycle, so NF6 stays unreachable. Mapped to phase 4
  (`04-phases.md` §10 deliverable 5), correctly not this round's.
- **Nothing was deployed.** `operator-visibility` (8ea0cc08) is live and this
  diff touches executor-loaded code. Deploy is phase 8's, by its own detached
  procedure.
