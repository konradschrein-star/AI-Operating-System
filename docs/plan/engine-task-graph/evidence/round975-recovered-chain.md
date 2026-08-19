# Round 975 — the recovered chain: R11 re-verified, the migration pattern proved, R73 written

**What this round is.** Round 973's review (run `66c9be0a-228c-45cf-bf7e-3d74acc0ccdb`)
returned `NEEDS_FIXES` with three findings. Its fix chain was seeded by hand after
the project sat paused for 17 hours, and the recovery brief was written as though
nothing had landed. **It had.** `20a2e8e` ("round-974, fix cycle 2") discharges
findings 1 and 2 in full. So findings 1 and 2 are **re-verified here, not
re-implemented** — an independent re-run rather than a citation of round 974's
transcript, because the standing rule is that instruments lie before code does and
a transcript is the instrument's own account of itself.

Finding 3 was genuinely open, and is the deliverable.

---

## 1. Finding 1 — the R11/R72 gate, both directions, re-measured

`check-scheduler-sql.sh` is the §2.2 gate for `promoteReadyTasks()`. The claim
under test: **the amended gate fails against the pre-972 statement and passes
against the shipped one.** Scratch database `forge_tg_r975`, created for this run
against the `postgres` maintenance database; no statement was issued against
`content_forge`.

### 1a. The shipped statement (HEAD `20a2e8e`) — PASS

**Which bytes this measured, since the build identity block below says "1 file
modified".** The subject — `db/projects.ts` — is unmodified and hashes to
`77aa1e9e…`, HEAD's blob. The one modified file is *this gate script*, carrying
§2's fix. The gate was also run against the pristine tree before any edit and
reported **104/104, exit 0**, with the four shell errors of §2 on stderr; the
transcript below is the post-fix run at **105/105** with that noise gone.

```
=== check-scheduler-sql.sh — build identity ====================================
  repo worktree      : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD           : 20a2e8e
  uncommitted (subj) : 1 file(s) of {projects.ts, task-graph.ts, this script} modified
  subject            : forge-control/src/db/projects.ts
  sha256(subject)    : 77aa1e9e44a4d6b6caa755df133638b913439c044f9c264bc5149acc75486c43
  pure decisions     : forge-control/src/lib/task-graph.ts
  sha256(pure)       : fdbd5489a92220023d8790342ca4dfd481fa7fcd49e7161b6c975b1a005c6a42
  scratch database   : forge_tg_r975 (local; DSN never printed)
  throwaway schema   : tg_check_sched (search_path via ?options=, verified pg 8.21)
  driven by          : tsx, importing the SHIPPED promoteReadyTasks/claimReadyTasks
  expected assertions: 105
===============================================================================
  ok   no shell expansion edits the SQL on its way out (failure mode (h)) = 0
...
--- 8. assertion census -------------------------------------------------------
  assertions executed: 105
  assertions declared: 105
  assertion CALLS in this file: 105
```

### 1b. The pre-972 statement — FAIL, at case 1b, on the assertion that names the cap

`forge-control/src/db/projects.ts` hash-swapped to `9c3f63a` (pre-cap; `grep -c
"lane_head\|R72"` → 0), the gate re-run unchanged, then restored and verified by
blob hash.

```
HEAD blob: 8acabf313ce26cc5c6f47dbe8ff2463594c036d7
swapped-in blob: a2889843680a5282265c5736640458b2b0431268
R72/lane_head hits: 0 (pre-cap confirmed)

--- 5. case 1 — R11: a graph row promotes with its round UNDRAINED ------------
  ok   R11 premise: a lower-round P1 row is not done            = pending
  ok   R11: candidate promoted despite the undrained round      = yes
  ok   R11: candidate is now ready                              = ready
  ok   R11: the lower-round graph row promoted too (it is a root) = yes
  ok   R11: round 100 of P1 is STILL undrained after the tick   = ready
  ok   R11: the candidate and the undrained row are in DIFFERENT lanes = alpha|main

--- 5. case 1b — R72: one live task per lane, and the lane frees -------------
  ok   R72 premise: all three P1b roots were pending before the tick = pending|pending|pending
  ok   R72: the lane head promoted                              = yes
  FAIL R72: its same-lane sibling did NOT                       expected [no] got [yes]

check-scheduler-sql.sh FAILED after 12 assertions
GATE EXIT=1

restored blob: 8acabf313ce26cc5c6f47dbe8ff2463594c036d7
RESTORE VERIFIED — byte-identical to HEAD
```

**Read this the right way round.** Case 1 (R11) passes in **both** directions —
that is the point of round 974's restatement: R11's rows were split across lanes,
so R11 now measures the ready rule and nothing else. The direction-sensitive
assertion is case 1b's, which asserts the retired behaviour directly. The gate is
therefore not "R11 broken and papered over"; the premise R11 lost (several roots
of ONE lane promoting together) is asserted as retired, and its loss is what the
red above detects.

**Operator ruling honoured:** `AI OS/Operator Decisions.md`, "R72's lane cap beats
R11's parallel promotion". The assertion was not weakened and was not deleted.

---

## 2. Failure mode (h) — four spans of SQL the shell was editing in flight

**Found while re-verifying finding 1, not briefed.** Every run of this gate — at
HEAD, at exit 0, with 104/104 — printed:

```
scripts/checks/check-scheduler-sql.sh: line 407: running: command not found
scripts/checks/check-scheduler-sql.sh: line 407: pending: command not found
scripts/checks/check-scheduler-sql.sh: command substitution: line 408: syntax error: unexpected end of file
scripts/checks/check-scheduler-sql.sh: command substitution: line 408: syntax error: unexpected end of file
```

The seed heredoc is opened **unquoted** (`<<SQL`) because the fixtures interpolate
`$T1_CAND` and friends — that expansion is wanted. It also hands bash the right to
expand **backquotes**, and four spans of ordinary prose in `--` comments (a symbol
written in backticks, the way this whole corpus writes symbols) were being run as
commands and replaced by their output.

**Why it mattered even though all four sat in comments.** Bash substitutes the
**empty string** for a span it cannot parse. A backquote landing in a `VALUES`
literal would change a seeded value while the row *count* — failure mode (a) —
still tallied at 33. And a backquoted word that happens to name a real command
would be executed during a gate run.

**Round 974 fixed one instance of this class by hand** and did not look for the
rest: `04-phases.md` §10 records it as *"fixes an unescaped backtick pair in the
unquoted driver heredoc"*. Four more survived in the seed. That is why the fix
here is a scan and not four backslashes.

### 2a. The scan, and proof it fires

Section 1b reads the file's own source, finds every heredoc, skips quoted ones
(`<<'PY'` expands nothing), and fails on an unescaped `` ` `` or `$(` in an
unquoted body. `$VAR` is deliberately not matched — it is the reason the heredocs
are unquoted.

```
CANARY 1 — an unescaped backquote in the seed heredoc
  UNESCAPED '`' at line 509, inside <<SQL opened at line 508: -- CANARY round 975: a symbol in `backquotes`, written the way t
  FAIL no shell expansion edits the SQL on its way out (failure mode (h)) expected [0] got [2]
  CANARY1 EXIT=1

CANARY 2 — an unescaped $( in the seed heredoc
  UNESCAPED '$(' at line 509, inside <<SQL opened at line 508: -- CANARY round 975: $(echo command-substitution-in-a-comment)
  FAIL no shell expansion edits the SQL on its way out (failure mode (h)) expected [0] got [1]
  CANARY2 EXIT=1

CANARY 3 — the scan's own abort path (synthetic fixture; unreachable in the real
file, which bash would refuse to parse at all)
  HEREDOC SCAN ABORTED: <<SQL opened at line 2 is never closed. The scan cannot certify a file it could not parse.
  CANARY3 EXIT=1

POSITIVE CONTROL — a clean fixture whose heredoc body contains $VAR
  0
  CLEAN EXIT=0
```

The positive control is the half that matters: it proves the scan is not simply
always-red, and that the expansion the fixtures depend on is still allowed. After
each canary the file was restored from a pre-canary copy and re-verified by
sha256 (`b4ea9a8a462d730f29733f87a5728484ce3e67b1942bab3f7ff6425e0046c2a3`).

### 2b. The gate after the fix

```
  ok   no shell expansion edits the SQL on its way out (failure mode (h)) = 0
--- 8. assertion census -------------------------------------------------------
  assertions executed: 105
  assertions declared: 105
  assertion CALLS in this file: 105
shell noise on stdout/stderr: none
SCHED EXIT=0
```

---

## 3. Finding 2 — the migration collision, and the pattern behind it

Round 974 renumbered `0042_task_graph.sql` → `0043_task_graph.sql`. Re-verified,
plus the half the brief asked for that a single renumber does not answer: **`main`
carries two files at `0040`.**

```
$ git ls-tree --name-only main db/migrations/ | sed "s|.*/||" | cut -c1-4 | sort | uniq -d
0040

$ ls db/migrations/ | cut -c1-4 | sort | uniq -d      # this worktree
(none)

$ git merge-tree --write-tree main HEAD   # computes the merge, writes nothing
2e973295252b0ba243c6920cfa135b594fc86088
$ git ls-tree --name-only <that tree> db/migrations/ | grep ^004
0040_usage_hourly.sql
0041_ui_dismissals.sql
0042_daily_goals.sql
0043_task_graph.sql
$ ... | cut -c1-4 | sort | uniq -d
(none)
```

**Conclusion, and the reason nothing further was renumbered.** `main`'s duplicate
is this project's own migration at its pre-round-950 number (`0040_task_graph.sql`,
created by `b428722`) sitting beside `0040_usage_hourly.sql`. This lane has already
moved that file — twice — so the merge **deletes** main's copy and the merged tree
carries no duplicate prefix at all. The pattern is real, it is one instance and not
two, and it closes when this lane lands. Renumbering anything else would have
manufactured a third collision.

The hermetic guard (`migrations.test.ts`, "no two migrations share a numeric
prefix (R70)") runs in `pnpm test` — 1381/1381 below.

---

## 4. Finding 3 — R73, the deliverable

The generalised rule did not exist anywhere in the tree before this round
(`grep -rniE "whether or not your brief|dedicated gate" docs/ forge-control/src/ scripts/`
→ no output at `20a2e8e`). Round 974 wrote only the file-specific instance.

Written into the **builder branch of `buildTaskPrompt()`**, because a builder reads
its brief and may never open a quality document — which is precisely how round 972
came to change `db/projects.ts` twice without anyone running that file's gate.

### 4a. Both directions watched red

The presence assertion, with the load-bearing clause inverted to a semantically
neutered form (`whether or not this brief mentions it` → `if your brief mentions it`):

```
error: "R73: it overrides the brief's silence — missing [whether or not this brief mentions it]"
# tests 1381 / # pass 1380 / # fail 1
```

The negative control, with the clause leaked into the reviewer prompt:

```
error: "R73: the clause leaked into the reviewer prompt, whose gate obligations are 03-quality.md §4's"
# tests 1381 / # pass 1380 / # fail 1
```

Both restored to sha256 `7b6dbaf4f5888b70f1237a19eeda01385aefb0e6b33e87e5946322a96cf592c9`.
One failure each, naming the right assertion: neither test is inert, and the
negative control is what stops the clause drifting into shared text where it would
tell reviewers to run builders' gates.

### 4b. The table that was deleted before it was committed

A subject → gate table was drafted for `03-quality.md` §2.2 and checked against
`grep -rln <path> scripts/checks/` before committing. **Four of six rows were
already wrong:** it credited `check-migration-0040.sh` with naming
`db/projects.ts` (it does not), listed one of the six checks that name
`lib/task-graph.ts`, and attributed `check-close-gate.ts` to `project-tick.ts` on
the strength of a loose `grep project-tick` that had matched prose. The table was
replaced by the grep itself, and the measurement kept in the document — a stale
gate index fails in the certifying direction, since a builder who runs the two
checks it lists has complied while leaving the rest unrun.

---

## 5. Gates — R73 applied to this round's own write-set

Each path this round wrote, run through `grep -rln <path> scripts/checks/`, and
every check that named one was run. This is the rule the round ships, executed on
the round that ships it.

```
pnpm typecheck                       clean (exit 0)
pnpm test                            1381/1381, 0 fail  (was 1379 at 20a2e8e; +2 = R73's two tests)
check-scheduler-sql.sh               105/105 executed / 105 declared / 105 calls in file, exit 0
gates-808.sh --strict                25 gates, RED: 0, 2 skipped-by-design
check-instrument-typecheck.sh        44/44 subjects compiled clean, 0 suppressions, 151s
check-corpus-map.py                  R1..R73 + NF1..NF7 complete, all three statements agree, phase 5 = 9
check-instrument-identity.py         13 pasted headers name the current digest, exit 0
check-r20-census.py                  R20 PASS, REGION PASS, exit 0
check-ui-prompt.ts                   PASS 55/55
check-screenshot-render-shapes.ts    ALL PASS — 16 checks
check-workstream-claim.ts            ALL PASS — 36 checks
measure-graph-guide-budget.ts        OK — measured 13474 against cap 13474
measure-prompt-baseline.sh           17 controls passed, 0 failures
check-forbidden-file-diff.sh         ALL PASS — 14 checks
shellcheck -S error <this gate>      exit 0
```

`measure-prompt-baseline.sh` and `measure-graph-guide-budget.ts` measure the
**planner** path, which this round did not touch; they are run because they name
`project-tick.ts`, which is exactly what R73 requires and exactly the reasoning
("my change is in a different branch of the file") that R73 exists to override.

Nothing was deployed. `/opt/forge-ai-os` was not touched. No statement was issued
against `content_forge`; the scratch database is `forge_tg_r975`.
