# D6 — the execution registry: `check-instrument-execution.ts` + an open ledger

Project `aios-verification-that-bites`, round 3, task S1. Branch `project/169903ec`.
Everything below was run in this worktree on 2026-08-25 and every command is
re-runnable as written.

> **The problem, once.** This repo has a COMPLETE, AUTOMATIC registry of one axis
> and had NO registry of the other. `check-instrument-typecheck.sh` enumerates its
> subjects by GLOB over all of `scripts/checks/` and COMPILES each one, with
> `instrument-manifest.txt` as an open waiver ledger. So all 56 instruments earn a
> green tick every run — **for compiling**. Nothing asked which of them **run**.
> D1 measured the answer: 41 of 74 artefacts executed by nothing, and
> `check-secret-scan.ts` sat in that set over a live committed credential while
> the suite reported `RED: 0`.

---

## 1. What was built, and why it is a copy rather than a new idea

Two files and three lines of wiring.

| file | what it is |
|---|---|
| `scripts/checks/check-instrument-execution.ts` | the registry — glob, resolve, reconcile, fail |
| `scripts/checks/execution-manifest.txt` | the open ledger — SPENT / NOT-A-CHECK / PROCEDURE-INVOKED |
| `scripts/checks/guard.sh` (phase 1) | the wiring — `run_check 1 "instrument-execution" …` |

**It copies `instrument-manifest.txt` line for line, deliberately.** That file's
header (lines 1–60) already argues the design and this one does not re-argue it:

- **Enumeration is by GLOB, never by list.** Every `*.{ts,tsx,sh,cjs,mjs,py}`
  under `scripts/checks/` at any depth, dotfiles included, plus every git-tracked
  `*.test.ts`/`*.test.tsx` in the repo. **150 subjects today.** A file written by
  someone who has never heard of this check is its subject the moment it exists.
  The fix for a rotting list is never a longer list.
- **A coverage scan names what it cannot read.** `instrument-manifest.txt`'s
  header does exactly this for `.mts`/`.cts`; here, any extension under
  `scripts/checks/` that is neither a subject extension nor a declared DATA
  extension (`txt`) is **named and fails the run**. A file the registry declines
  to read cannot also be certified by it.
- **The ledger is open, and every entry is printed on every run**, above the
  verdict, with all four fields. An exclusion nobody sees is an `--exclude` flag
  with extra steps.
- **A ledgered path that turns out to be invoked is a FAILURE** ("ledgered but
  INVOKED"), the same way a waived-but-clean subject fails in the compile
  registry. That is the mechanism by which an exclusion list outlives its reason.
- **One subject, one entry**; a path not on disk, or not among the subjects, is
  an error; a field block with no bare path after it is an error.

Two things it does that the compile registry does not have to:

1. **It distinguishes two kinds of non-coverage** (§4). The compile registry has
   one bucket (waived); this one has to separate *"nothing needs to run this"*
   from *"a live gate that nobody runs"*, because only the first is excusable.
2. **It states its matching rule and proves the rule rejects prose** (§2).
   Compilation has no ambiguity about what a subject is; execution does, and
   getting that wrong in the permissive direction is precisely how this hole
   stayed open for four months.

---

## 2. The matching rule — command position, not any occurrence

The rule is in the file header as R1–R9. In short: only the closed runner set is
read; full-line comments are stripped; `\`-continuations are joined; each logical
line is tokenised and **quoted tokens are recursed into** (because this repo
writes its gates as `gate_sh "<label>" "<the command>"`); tokens are grouped into
commands at shell operators; a command's head is its first token, or an
interpreter token immediately preceded by a complete quoted string (the
`gate "<label>" node <path>` wrapper idiom). An invocation is recorded only when
the head is itself a subject, or the head is an **interpreter** and a following
token resolves to a subject. A token with no `/` never resolves — that is what
makes `gate_sh "check-composer-v3.ts" "<cmd>"`'s first argument a *label*.

**`tsc` is deliberately not an interpreter.** `npx tsc --noEmit <check>` compiles
a check; it does not execute it. Conflating those two is the entire subject of
this project. Such references are recorded and printed under `REFERENCED BUT NOT
EXECUTED`, and count as coverage for nothing.

### The rule rejects prose — three live cases in this repo

All three are shapes a naive `grep -c "<filename>" <runner>` gets wrong:

```
$ sed -n '211,214p' scripts/checks/guard.sh
if [ "$MODE" = "full" ]; then
  run_check 2 "instrument-typecheck" \
    "see the full per-subject report: bash scripts/checks/check-instrument-typecheck.sh" \
    "bash scripts/checks/check-instrument-typecheck.sh"
```
The first of those two strings is a *fix hint*. Its `bash` is preceded by the
bare word `report:` — not a command start and not a quoted argument — so R4 does
not make it a head, and nothing is recorded from it. The line below it is the
real invocation. Control C4 removes the real one and keeps the hint; the registry
stays red.

```
$ sed -n '122,127p' scripts/checks/gates-808.sh
gate_sh "token purity — round 808's own files" \
  "grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' \
     …
     scripts/checks/check-working-sql-agreement.ts \
```
The command head is `grep`. The check is an *argument* to it. Recorded as
`REFERENCED BUT NOT EXECUTED (grep)`, never as coverage.

```
$ sed -n '144p' scripts/checks/preflight-deploy.sh
# scripts/checks/fixtures/preflight-c1-fixture.sh
```
A comment. R2 removes the line before tokenising. The fixture is ledgered
NOT-A-CHECK, and its ledger entry says so in its `reason` field.

### Test files resolve against what the glob expands to

Per D4 §4's invariant, but with real glob semantics rather than D4's
`find`-based shell. D4's `find` is correct **only because** both of today's
patterns are rooted double-star patterns. The day someone writes
`src/lib/*.test.ts` again, a `find`-based resolver would certify
`src/lib/nested/x.test.ts` as covered when the runner never runs it — the same
false-green this registry exists to refuse. So `*` stays inside a path segment
and `**` crosses segments, and the expansion is done against the files on disk.

The package half of the runner set is **discovered by glob**: every tracked
`package.json`, every script whose name matches `test | test:* | guard | guard:*`.
A fifth package added next year is read without editing this file. The four shell
runners are declared, and a declared runner missing from disk is a **refusal**,
not a skip — its absence would silently reclassify every check it invokes as an
orphan while the registry looked like it was working.

---

## 3. The ledger's seeded contents — 13 entries

Seeded from `execution-audit.tsv`, D1's validated output, so that the check is
**green at main on the day it lands**. A gate that lands red turns main red for
every lane at once and is disabled within a day; that is not a stricter gate, it
is no gate.

| bucket | n | paths |
|---|---|---|
| `SPENT` | 5 | `check-r1871-chat.ts`, `check-r1873-fixes.ts`, `check-r1875-fixes.ts`, `check-r20-census.py`, `check-r69-straddle.sh` |
| `NOT-A-CHECK` | 5 | `serve-agents-7798.ts`, `serve-quota-7799.ts`, `serve-sse-808.ts`, `serve-v3-7798.ts`, `fixtures/preflight-c1-fixture.sh` |
| `PROCEDURE-INVOKED` | 3 | `verify-control-plane.sh`, `check-browser-takeover-ticket.ts`, `prove-it-bites.sh` |

Every `PROCEDURE-INVOKED` citation was re-read before it was written down:

```
$ sed -n '756p' docs/tools/run-control.md
The one command is **`scripts/checks/verify-control-plane.sh`** (built in CP1; 08 §3b/§6).
$ sed -n '39,41p' docs/plan/aios-browser-takeover-live/deploy.md
cd /opt/forge-ai-os/forge-control-web && \
  ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
  ../scripts/checks/check-browser-takeover-ticket.ts
$ sed -n '380,385p' docs/plan/03-quality.md
**A check that has never been observed failing is a decoration.** A task that
ships a check ships ONE `prove-it-bites.sh` transcript with it, pasted verbatim
into its artefact doc, restore proven by hash. One line, so nobody can plead cost:
```

`check-browser-takeover-ticket.ts` is the weakest entry in the file and its
`reason` field says so: it gates the one route in this repo reachable from the
public internet without a NextAuth session, and its runbook has *not been
executed* (`deploy.md:4`). It is `PROCEDURE-INVOKED` rather than an open finding
only because a current doc still tells a human to run it going forward. **It is
the first entry in this ledger that should become a wired gate.**

### The header example does not parse as a record

`instrument-manifest.txt` had to solve this and the fleet memory note
`header-example-is-live-syntax` records the run where a gate read its own
documentation as a live waiver. The example here is indented by four extra
spaces, and the reason is stated at the indentation so the next editor does not
tidy it back. Measured, as that note prescribes:

```
$ awk '/^# (path|bucket|reason|owner)[ \t]*:/' scripts/checks/execution-manifest.txt | wc -l
52          # = 13 entries × 4 fields. The header example contributes 0.
```

---

## 4. The open-findings inventory — 45 paths, and why they are not in the ledger

**The ledger cannot express a LIVE-ORPHAN.** `bucket` takes three values and
`LIVE-ORPHAN` is not one of them, so an attempt to excuse a live gate in that
file is a ledger error that fails the run by name. Open findings live in
`KNOWN_OPEN_FINDINGS` in the check itself: **an inventory that only shrinks**.
Every one of the 45 is printed by name on every run, as a debt register. The
count is declared separately from the list so that editing one without the other
is itself an error. And an inventory entry that becomes *invoked* fails the run
until it is deleted — the list cannot rot in the safe direction either.

`check-secret-scan.ts` is entry 29 of the 45. It is **not** ledgered and it has
**not** been wired into anything: its line 112 prints the matched credential
verbatim, and the fixed order is redact → Konrad rotates → remove the literal →
wire in.

**Two subjects the resolver classifies more strictly than D1's hand audit did.**
Both differences are the resolver being stricter, not looser, and both are worth
Konrad's attention:

1. **`check-working-sql-agreement.ts` — `execution-audit.tsv:11` calls it
   LIVE-WIRED, "gate 13 of 24, standalone typecheck". It is an orphan.** The gate
   is `npx tsc --noEmit … ../scripts/checks/check-working-sql-agreement.ts`
   (`gates-808.sh:180-183`). That *compiles* the check. Nothing executes its
   assertions, and `check-instrument-typecheck.sh` already compiles every file in
   that directory — so gate 13 is a duplicate compile wearing an execution gate's
   costume, and it is counted in the suite's gate total.

   ```
   $ sed -n '180,183p' scripts/checks/gates-808.sh
   gate_sh "check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)" \
     "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
        --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
        ../scripts/checks/check-working-sql-agreement.ts"
   ```
   The registry prints it under `REFERENCED BUT NOT EXECUTED`, with both of its
   non-executing citations:
   ```
   NOT-RUN  scripts/checks/check-working-sql-agreement.ts
              <- scripts/checks/gates-808.sh:122 (grep <subject> — compiles/reads, does not execute)
              <- scripts/checks/gates-808.sh:180 (tsc <subject> — compiles/reads, does not execute)
   ```
   This is D1's own thesis applied to D1's own table, and I say so plainly: the
   audit was right about 73 of 74 rows and this row conflates compiling with
   running, which is the exact conflation the audit exists to expose.

2. **`preflight-deploy.sh` — a runner in form, an orphan in fact.** It has its
   own C1–C5 body, so it appears in the closed runner set; but nothing invokes
   *it*, so that body never runs. D1 reached the same conclusion
   (`execution-audit.tsv:29`); it is recorded here because a reader scanning the
   runner list would otherwise assume a runner runs.

`check-usage-fold.ts` is the useful contrast: it carries a *non-executing*
citation too (`gates-808.sh:250`, the standalone typecheck), but it also has a
real one (`gates-808.sh:243`, `tsx <subject>`), so it is `also-run` and counted.

---

## 5. Wiring — `guard.sh` phase 1, not `gates-808.sh`

```
$ sed -n '154,169p' scripts/checks/guard.sh
```
Three reasons, and they are in the file header at the call site:

1. It is a **static rule with no runtime** — it reads files and starts nothing.
2. It costs **milliseconds** (measured: 1–2s in the guard table below).
3. **Phase 1 runs in `--fast`, which is what `pnpm guard` actually invokes**
   (`package.json:7`). `gates-808.sh` is `skip_check`ed in `--fast`
   (`guard.sh:249`), so a gate placed there is invisible to the default guard —
   the same class of not-really-running this project exists to close.

`gates-808.sh` was not edited: another task owns that file.

---

## 6. The five controls, verbatim

> A check that has never been observed failing is a decoration.

C2, C3 and C4 are `prove-it-bites.sh` runs. **C1 is by hand, and here is why:**
`prove-it-bites.sh`'s contract is *back the subject up, mutate it, restore it,
prove the restore by hash*, and it refuses a check that is already red before the
mutation (exit 3). C1's mutation is **the appearance of a file that does not yet
exist** — there is no baseline to back up, and a probe that exists in the
unmutated state makes the check red before the control starts. So C1 is run with
the same discipline by hand: baseline green, mutation, red naming the exact path,
restore, green, and the before/after transcripts proven identical by hash.

### C1 — NEW ORPHAN. The future of `check-secret-scan.ts`.

```
== C1 baseline: the probe does not exist, the registry is green
ls: cannot access 'scripts/checks/check-zzz-probe.ts': No such file or directory
  exit(before)=0
PASSED — 92 executed, 13 ledger-excused, 45 open finding(s) declared, 0 unaccounted for.

== C1 mutation: a new instrument appears, written by someone who never read this check
?? scripts/checks/check-zzz-probe.ts
  exit(mutated)=1
249:  FAIL scripts/checks/check-zzz-probe.ts — executed by nothing, and neither ledgered nor a declared open finding
254:  * scripts/checks/check-zzz-probe.ts: this artefact is executed by nothing. Wire it into a runner, or ledger it in scripts/checks/execution-manifest.txt with a bucket (SPENT | NOT-A-CHECK | PROCEDURE-INVOKED), a reason and an owner. If it is a live gate nobody runs, that is an OPEN FINDING, not a waiver: add it to KNOWN_OPEN_FINDINGS and talk to Konrad.
FAILED — 1 problem(s)

== C1 restore: delete the probe, re-run
ls: cannot access 'scripts/checks/check-zzz-probe.ts': No such file or directory
  exit(after)=0
PASSED — 92 executed, 13 ledger-excused, 45 open finding(s) declared, 0 unaccounted for.

== C1 restore proof: before and after transcripts are byte-identical, tree is clean
b260a69461c0d5ca5b8baf8d19315148  /tmp/d6-mut/c1-before.txt
b260a69461c0d5ca5b8baf8d19315148  /tmp/d6-mut/c1-after.txt
  (empty = clean)
```

The probe asserts nothing and was never listed anywhere. **Coverage was automatic
and could not be forgotten** — which is the whole claim, and it is now an
observed effect rather than a design intention.

### C2 — UNWIRING. A fix cycle can no longer quietly leave a gate unexecuted.

Subject `scripts/checks/guard.sh`; mutation removes the ONE invocation of
`check-instrument-typecheck.sh`, prose and all.

```
$ bash scripts/checks/prove-it-bites.sh \
    --subject scripts/checks/guard.sh \
    --mutation-file /tmp/d6-mut/c2-unwire.py \
    --mutation-file /tmp/d6-mut/c4-prose.py \
    --check 'forge-control/node_modules/.bin/tsx scripts/checks/check-instrument-execution.ts | grep -E "FAIL|PASSED|FAILED" | head -8' \
    --expect-fail --tail 12

STEP 1 — subject cleanliness — a mutation control on an already-dirty file cannot prove a restore
  $ git status --porcelain -- scripts/checks/guard.sh
  []
  tracked by git: 1
  restore mode  : git

STEP 2 — baseline hash
  BEFORE : 25aa848a7e16293ab905811a9470d132

STEP 3 — check UNMUTATED
  | PASSED — 92 executed, 13 ledger-excused, 45 open finding(s) declared, 0 unaccounted for.
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 2 (source: file:/tmp/d6-mut/c2-unwire.py)
  $ git diff -- scripts/checks/guard.sh
  | @@ -210,8 +210,8 @@ run_check 2 "tsc-forge-control-web" \
  |  if [ "$MODE" = "full" ]; then
  |    run_check 2 "instrument-typecheck" \
  | -    "see the full per-subject report: bash scripts/checks/check-instrument-typecheck.sh" \
  | -    "bash scripts/checks/check-instrument-typecheck.sh"
  | +    "no hint" \
  | +    "true"
  |  else
  md5 while mutated: 86ca60f65f8ba41ecfc2d719cab38e0e

STEP 5.1 — check MUTATED
  |   FAIL scripts/checks/check-instrument-typecheck.sh — executed by nothing, and neither ledgered nor a declared open finding
  | FAILED — 1 problem(s)
  exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  restore mode : git
  md5 BEFORE   : 25aa848a7e16293ab905811a9470d132
  md5 AFTER    : 25aa848a7e16293ab905811a9470d132
  restore verified by hash
```

### C4 — PROSE IMMUNITY. A mention is not an invocation.

Same run, mutation 2 of 2: the **invocation** is removed but the fix-hint string
naming the identical path is kept, and two comment lines naming it are added.
Three prose mentions of `check-instrument-typecheck.sh` in the runner, zero
commands.

```
STEP 4.2 — apply mutation 2 of 2 (source: file:/tmp/d6-mut/c4-prose.py)
  $ git diff -- scripts/checks/guard.sh
  | @@ -211,7 +211,9 @@ run_check 2 "tsc-forge-control-web" \
  |  if [ "$MODE" = "full" ]; then
  |    run_check 2 "instrument-typecheck" \
  |      "see the full per-subject report: bash scripts/checks/check-instrument-typecheck.sh" \
  | -    "bash scripts/checks/check-instrument-typecheck.sh"
  | +    "true"
  | +# PROSE PROBE: see scripts/checks/check-instrument-typecheck.sh for the report
  | +# PROSE PROBE: run it by hand with bash scripts/checks/check-instrument-typecheck.sh
  |  else
  md5 while mutated: 68122aef569b29f352fe34aca43f7bf7

STEP 5.2 — check MUTATED
  |   FAIL scripts/checks/check-instrument-typecheck.sh — executed by nothing, and neither ledgered nor a declared open finding
  | FAILED — 1 problem(s)
  exit code (mutated/2): 1

STEP 6.2 — restore and prove it by hash
  md5 BEFORE   : 25aa848a7e16293ab905811a9470d132
  md5 AFTER    : 25aa848a7e16293ab905811a9470d132
  restore verified by hash

STEP 7 — VERDICT
  unmutated exit : 0

  #   mutated exit result                 mutation source
  --- ------------ ---------------------- ---------------
  1   1            DISCRIMINATED          file:/tmp/d6-mut/c2-unwire.py
  2   1            DISCRIMINATED          file:/tmp/d6-mut/c4-prose.py

VERDICT: BITES — unmutated exit 0, 2/2 mutation(s) drove it non-zero, subject restored (md5 25aa848a7e16293ab905811a9470d132).
```

### C4b — the other half of prose immunity: prose does not rescue, a command does

C4 shows prose failing to *sustain* coverage. C4b shows prose failing to *create*
it, and — the part that makes it a control rather than a coincidence — shows a
single command-position line succeeding where three prose mentions did not.

```
25aa848a7e16293ab905811a9470d132  scripts/checks/guard.sh

== C4b step 1 — PROSE ONLY. A comment line and a fix-hint string in the runner, both naming the probe.
# PROSE PROBE (C4b): scripts/checks/check-zzz-probe.ts is the new instrument.
# To see its report, run: bash scripts/checks/check-zzz-probe.ts
run_check 1 "zzz-prose" \
  "see the full report: node scripts/checks/check-zzz-probe.ts" \
  "true"
  exit(prose only)=1
  mentions of the probe in guard.sh: 3
  249:  FAIL scripts/checks/check-zzz-probe.ts — executed by nothing, and neither ledgered nor a declared open finding

== C4b step 2 — now a REAL invocation in command position, nothing else changed.
run_check 1 "zzz-real" "no hint" "node scripts/checks/check-zzz-probe.ts"
  exit(real invocation)=0
  156:  ok  scripts/checks/check-zzz-probe.ts  <- scripts/checks/guard.sh:335 (node <subject>)

== C4b restore
25aa848a7e16293ab905811a9470d132  scripts/checks/guard.sh
  (empty = clean)
```

Three mentions, still red. One command, green. That is the matching rule
measured rather than asserted.

### C3 — LEDGER INTEGRITY. A four-field entry with three fields excuses nothing.

Subject `scripts/checks/execution-manifest.txt`; mutation deletes one entry's
`reason` line.

```
$ bash scripts/checks/prove-it-bites.sh \
    --subject scripts/checks/execution-manifest.txt \
    --mutation-file /tmp/d6-mut/c3-ledger.py \
    --check 'forge-control/node_modules/.bin/tsx scripts/checks/check-instrument-execution.ts | grep -E "FAIL|PASSED|FAILED" | head -8' \
    --expect-fail --tail 12

STEP 2 — baseline hash
  BEFORE : cf333df6c3bc09ef902954c623af54e3

STEP 3 — check UNMUTATED
  exit code (unmutated): 0

STEP 4.1 — apply mutation 1 of 1 (source: file:/tmp/d6-mut/c3-ledger.py)
  $ git diff -- scripts/checks/execution-manifest.txt
  | @@ -107,7 +107,6 @@
  |  # path    : scripts/checks/check-r1871-chat.ts
  |  # bucket  : SPENT
  | -# reason  : round-numbered one-shot verification of round 1870's findings; that round is settled and its subject questions are answered (execution-audit.tsv:20)
  |  # owner   : project aios-verification-that-bites, round 3 (D1 triage)
  |  scripts/checks/check-r1871-chat.ts
  md5 while mutated: 98718485e8d3812c89edc065772c1af6

STEP 5.1 — check MUTATED
  |     FAIL at line 111: the entry 'scripts/checks/check-r1871-chat.ts' is missing required field(s): reason. All four of path/bucket/reason/owner are required, and an entry without them excuses NOTHING — this run still counts its subject as executed by nothing.
  |   FAIL scripts/checks/check-r1871-chat.ts — executed by nothing, and neither ledgered nor a declared open finding
  | FAILED — 2 problem(s)
  exit code (mutated/1): 1

STEP 6.1 — restore and prove it by hash
  md5 BEFORE   : cf333df6c3bc09ef902954c623af54e3
  md5 AFTER    : cf333df6c3bc09ef902954c623af54e3
  restore verified by hash

STEP 7 — VERDICT
  1   1            DISCRIMINATED          file:/tmp/d6-mut/c3-ledger.py

VERDICT: BITES — unmutated exit 0, 1/1 mutation(s) drove it non-zero, subject restored (md5 cf333df6c3bc09ef902954c623af54e3).
```

Note the **second** failure line: the invalid entry does not merely get reported,
it stops excusing. A three-field entry buys nothing at all.

### C5 — MY OWN REACHABILITY. Does the runner actually report this check?

Wiring a check into a runner and never watching the runner report it red is the
exact failure this project is closing, one level up.

**C5a — it runs in `--fast`, and it is named in the summary:**

```
$ bash scripts/checks/guard.sh --fast --strict
PH CHECK                    STATUS   TIME   DETAIL
-- ------------------------ ------   ----   ------
0  node-version             PASS       0s
0  devdeps-forge-control    PASS       0s
0  devdeps-forge-control-web PASS       0s
1  no-raw-colours           FAIL       0s   forge-control-web/app/desktop/goals/WeekGrid.tsx:48
1  dollar-sweep             PASS       1s
1  instrument-execution     PASS       2s
1  forbidden-file-diff      PASS       0s
2  tsc-forge-control        PASS      25s
2  tsc-forge-control-web    PASS       9s
2  instrument-typecheck     SKIP       0s   deferred to --full …
3  web-build                SKIP       0s   deferred to --full …
4  gates-808-suite          SKIP       0s   deferred to --full …

PASS: 8   FAIL: 1   SKIP: 3
EXIT=1
```

**C5b — the same run with C1's probe on disk. Guard's own verdict flips, carrying
this check's fix string:**

```
1  instrument-execution     FAIL       1s   FAIL scripts/checks/check-zzz-probe.ts — executed by nothing, and neither ledgered nor a declared open finding

PASS: 7   FAIL: 2   SKIP: 3

instrument-execution (phase 1)
  at:  FAIL scripts/checks/check-zzz-probe.ts — executed by nothing, and neither ledgered nor a declared open finding
  fix: this artefact is executed by nothing: wire it into a runner, or ledger it in scripts/checks/execution-manifest.txt with a reason and an owner. Read that file's header first — a LIVE-ORPHAN (a live gate nothing runs) may NOT be ledgered; it goes in KNOWN_OPEN_FINDINGS in check-instrument-execution.ts and it is a conversation with Konrad. Full report: forge-control/node_modules/.bin/tsx scripts/checks/check-instrument-execution.ts

GUARD: RED — do not merge. Fix the failure(s) above and re-run.
```

`guard.sh`'s `extract_detail` picks the right line because the registry prints
its per-subject failures as `  FAIL <path> — …`, which is the second pattern that
function looks for (`guard.sh:82`). That was designed for, not discovered.

The `EXIT=1` in C5a is **not** this check: `--fast` deliberately skips three
phases and `--strict` fails on any SKIP, so `pnpm guard` cannot exit 0 by
construction (fleet memory `pnpm-guard-can-never-exit-zero`). The `no-raw-colours`
FAIL is inherited — see §8.

---

## 7. Compile gate

The new instrument is itself a subject of the compile registry, and it compiles:

```
$ bash scripts/checks/check-instrument-typecheck.sh
  PASS scripts/checks/check-instrument-execution.ts     exit 0, 0 diagnostics
CENSUS
  subjects found 53   subjects compiled 53   type failures 1   fidelity violations 0   missing 0   uncovered 0   suppressions 0
```

The one type failure is `check-chat-pagination-browser.ts`, inherited — §8.

---

## 8. `guard.sh --full --strict`, and what is inherited

```
$ bash scripts/checks/guard.sh --full --strict
```

```
PH CHECK                    STATUS   TIME   DETAIL
-- ------------------------ ------   ----   ------
0  node-version             PASS       0s
0  devdeps-forge-control    PASS       0s
0  devdeps-forge-control-web PASS       0s
1  no-raw-colours           FAIL       1s   forge-control-web/app/desktop/goals/WeekGrid.tsx:48
1  dollar-sweep             PASS       0s
1  instrument-execution     PASS       0s
1  forbidden-file-diff      PASS       1s
2  tsc-forge-control        PASS       8s
2  tsc-forge-control-web    PASS       3s
2  instrument-typecheck     FAIL      19s   scripts/checks/check-chat-pagination-browser.ts(139,11): error TS2339: Property 'createRequire' does not exist on type '{ default: typeof Module; ... }'.
3  web-build                PASS      62s
4  gates-808-suite          FAIL      99s   forge-control-web/app/desktop/goals/WeekGrid.tsx:48

PASS: 9   FAIL: 3   SKIP: 0
GUARD: RED — do not merge. Fix the failure(s) above and re-run.
EXIT=1
```

**RED, on three failures, none of them this task's**, and the same three D4
reported from the merged tree before this task existed. `instrument-execution`
is `PASS 0s` in `--full` as well as in `--fast`.

**Attribution of every red that is not this task's:**

```
$ git log -1 --format='%h %an %ad' -- forge-control-web/app/desktop/goals/WeekGrid.tsx
b41e824 Konrad Schreiner Tue Aug 25 03:45:55 2026 +0200
  -> main ALREADY carries that commit
$ git log -1 --format='%h %an %ad' -- scripts/checks/check-chat-pagination-browser.ts
75529e5 Konrad Schreiner Tue Aug 25 01:42:58 2026 +0200
  -> main ALREADY carries that commit
```

- `no-raw-colours` / `gates-808-suite` both point at
  `forge-control-web/app/desktop/goals/WeekGrid.tsx:48`, the week-board palette
  from `b41e824` — already on `main`, already tracked in fleet memory
  `gate5-raw-colours-red-at-main-from-week-board` as today's expected baseline
  red. D4 reported the identical pair. This task touched no `.tsx` file.
- `instrument-typecheck` fails on `check-chat-pagination-browser.ts` (`75529e5`,
  also already on `main`). This task did not touch that file.

Nothing was softened to get green. Both reds pre-date this task and both are
Konrad's own commits from earlier today.

### `pnpm guard:test` — one inherited assertion fails, and it is the same red

```
$ bash scripts/checks/test-guard-discrimination.sh
═══ Defect 2/3: raw colour literal → no-raw-colours ═══
RED probe:
  [no-raw-colours] status=FAIL detail=forge-control-web/app/_guard-scratch-colour.tsx:1
PASS — raw colour literal turns no-raw-colours RED (FAIL)
GREEN probe (file removed):
  [no-raw-colours] status=FAIL detail=forge-control-web/app/desktop/goals/WeekGrid.tsx:48
FAIL — restoring the tree turns no-raw-colours GREEN: got 'FAIL', want 'PASS'
…
test-guard-discrimination.sh FAILED — 1 assertion(s) did not hold.
```

`test-guard-discrimination.sh` asserts that removing its scratch file returns
`no-raw-colours` to PASS. It cannot, because `WeekGrid.tsx:48` holds that check
red independently — the detail line in the GREEN probe names the inherited file,
not the scratch one. **This is the mutation harness meeting an inherited red**,
exactly the condition `prove-it-bites.sh` exits 3 on. It is a pre-existing
condition of `main`, not a consequence of adding a phase-1 check; the other two
defect classes pass in both directions.

---

## 9. What this check still cannot see

It answers "does a runner name this artefact in command position", and that is
strictly narrower than "does this artefact's verdict reach a human who acts on
it". Five limits, stated so nobody mistakes a green tick here for the other
thing.

**It cannot see whether an executed check can fail.** `gates-808.sh` gate 7 ends
in a literal `exit 0` (PLAN.md §F3) and this registry counts it as executed,
correctly and uselessly — D2 is the instrument for that axis and the two are
independent. An artefact can be LIVE-WIRED here and still certify nothing.

**It cannot see conditional execution.** `check-usage-fold.ts` is counted because
`gates-808.sh:243` invokes it; that call site sits inside
`if [ -n "${DATABASE_URL:-}" ]`, and with no DSN the gate SKIPs. The call site
exists, so the registry says executed. "Executed on every run" is a third axis
nobody measures yet.

**Its shell resolver is a heuristic, not `bash`.** It handles quoting, `\`
continuations, `$(…)`, simple `VAR=` assignments and the `npx`/`pnpm exec`
wrappers, because those are the shapes this repo actually uses. It does not
evaluate `eval`, arrays, `source`, parameter expansion with defaults, or a path
assembled at runtime from two variables. A runner written in one of those shapes
would produce a **false orphan** — noisy and safe — but a sufficiently indirect
invocation inside a quoted string could in principle produce a false green. The
mitigation is that every invocation is printed with its citation, so a wrong
attribution is visible in the transcript rather than hidden in a count.

**Its shell runner set is four declared paths.** The package half is
glob-discovered and grows by itself; the shell half does not. A fifth shell
runner added next year is read only if someone adds it to `SHELL_RUNNERS`. D1
proved the set closed on 2026-08-25 (no `.github/`, no Makefile, no pm2 process,
no cron entry reaching `scripts/checks/`) and the file cites that proof, but
"closed then" is not "closed forever". A missing declared runner is a refusal;
an *undeclared* one is invisible.

**It says nothing about `scripts/ops/`, `scripts/deploy/` or
`docs/plan/artifacts/`.** D1 audited all three — cron is a genuinely separate
runner class and it caught a live failure that day — and this registry's subject
glob deliberately stops at `scripts/checks/` plus tracked test files, per the
brief. The 60-odd `.cjs` probes under `docs/plan/artifacts/` are outside it. That
is a scope decision, not a measurement: extending the glob is a config change of
two lines, and the ledger would then need a triage pass those artefacts have
never had.

---

## 10. Files changed (declared write-set)

- `scripts/checks/check-instrument-execution.ts` — new, the registry
- `scripts/checks/execution-manifest.txt` — new, the open ledger (13 entries)
- `scripts/checks/guard.sh` — one `run_check` in phase 1 plus its comment block
- `docs/plan/artifacts/verification-that-bites/D6-execution-registry.md` — this file

Nothing outside that list was written. `scripts/checks/check-zzz-probe.ts` was
created and deleted twice inside controls C1 and C4b; `guard.sh` and
`execution-manifest.txt` were mutated and restored inside C2/C3/C4, every restore
proven by `md5sum` on both sides and by `git status --porcelain -- scripts/checks/`
returning empty afterwards.
