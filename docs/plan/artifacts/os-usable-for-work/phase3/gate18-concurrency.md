# Gate 18 — the scratch database is lane-unique BY DEFAULT

`os-usable-for-work`, phase 3, round 3. Subject: `scripts/checks/check-usage-fold.ts`
(gate 18 of `scripts/checks/gates-808.sh`).

---

## 0. The sentence that matters

**Every gate-18 red observed during a parallel run has been meaningless.** Not
"probably fine", not "worth a second look" — **unreadable**. The check shared one
scratch database across every concurrent invocation on this host and `TRUNCATE`d
three tables between fixtures, so a red told you only that a sibling lane happened
to be inside the same check at the same moment. A gate that fails on the weather
rather than on the diff teaches every reader to discount it, and that is precisely
how a real red gets waved through.

Two lanes measured this independently and agreed:

| lane | observation |
| --- | --- |
| surfaces | plain run RED 1; `USAGE_FOLD_DB=r1354_sampler_surfaces` RED 0; the check itself unchanged |
| phase-3 integration review | same red at tip `8ae6c7a`; re-run alone at the same tip, ALL PASS exit 0 |

---

## 1. What was wrong, precisely

`scripts/checks/check-usage-fold.ts:106` (pre-fix):

```ts
const SCRATCH_DB = process.env.USAGE_FOLD_DB ?? "r1354_sampler";
```

A **constant**. `reset()` at ~:279 issues `TRUNCATE runs, spend_log, usage_hourly`
before each of the nine fixture blocks. Five lanes share this host and each runs
the gate suite, so two runs land in one database and wipe each other's fixtures
mid-assertion.

Round 3's *first* attempt fixed this at the call site — `gates-808.sh` exported
`USAGE_FOLD_DB=r1354_sampler_$$ USAGE_FOLD_DROP=1`. That protects exactly one
caller. The check's own header tells operators to run it with no such variable,
and the next harness to invoke it would have inherited the collision. **An override
cannot fix a default**, so the default is what this round changed.

---

## 2. The control — the defect, reproduced on demand

Five concurrent runs forced onto the old shared constant. Setting
`USAGE_FOLD_DB=r1354_sampler` walks byte-for-byte the same code path the old
default did (`process.env.USAGE_FOLD_DB ?? "r1354_sampler"`), so this is the
pre-fix behaviour and not an approximation of it.

```
$ for i in 1 2 3 4 5; do ( USAGE_FOLD_DB=r1354_sampler tsx check-usage-fold.ts … ) & done

control-1 EXIT=1  6 FAILURE(S) — usage fold (scratch db: r1354_sampler)
control-2 EXIT=1  6 FAILURE(S) — usage fold (scratch db: r1354_sampler)
control-3 EXIT=1  <no verdict — died>
control-4 EXIT=1  7 FAILURE(S) — usage fold (scratch db: r1354_sampler)
control-5 EXIT=1  <no verdict — died>
```

5/5 red, and note that **the run count of failures is not even stable** — 6, 6, 7.

### 2.1 It fails with two different faces, and the quiet one is the dangerous one

**Face A — the deadlock.** Loud, obviously not about the code:

```
ERROR:  deadlock detected
DETAIL:  Process 780705 waits for AccessShareLock on relation 286521 of database 286483;
         blocked by process 780706.
         Process 780706 waits for AccessExclusiveLock on relation 286484 of database 286483;
         blocked by process 780705.
    at sampleHour (forge-control/src/lib/usage-sampler.ts:533:22)
```

**Face B — no error at all, just wrong arithmetic.** When the locks do not
actually cross, the sibling's `TRUNCATE` and `INSERT`s simply land between this
run's write and its assertion. The check then prints a perfectly well-formed
verdict:

```
FAIL  hour 10 still reports the run as billed
        expected 1
        actual   5           ← five lanes' fixtures, summed
FAIL  run_count counts SPEND ROWS, which is what it always meant
        expected 2
        actual   10
FAIL  hour 10 keeps its own turn's USD
        expected 0.1
        actual   0.3
```

`actual 5` against `expected 1`, from five lanes. That is indistinguishable on
sight from a genuine fold defect. **Face B is why no gate-18 red in a parallel run
could be read** — face A at least announces itself.

---

## 3. The fix

### 3.1 The name

```ts
const SCRATCH_DB_OVERRIDE = process.env.USAGE_FOLD_DB;
const SCRATCH_DB =
  SCRATCH_DB_OVERRIDE ?? `r1354_sampler_p${process.pid}_${randomBytes(4).toString("hex")}`;
```

Why this shape is collision-free **here**, rather than merely unlikely:

- **`process.pid` is unique among processes alive at one instant on this host** —
  which is exactly the window in which two runs can be inside the `TRUNCATE`
  together. Two concurrent runs cannot share a pid. That is the kernel's
  guarantee, not an assumption about how the lanes are launched.
- **pid alone would not be enough over time.** Pids are recycled after exit. A run
  that leaked its database (SIGKILL, a failed `DROP`) would eventually be met by a
  later run holding the recycled pid; that run would find the database already
  present, set `scratchCreatedHere = false`, and — correctly — refuse to drop a
  database it did not create. The leak would become permanent. Four random bytes
  turn that from a scheduled certainty into 1 in 4.3 × 10⁹.
- **The random half also covers what pid cannot see at all:** two containers with
  separate pid namespaces pointing at one Postgres server. `$$`-style pid naming
  is blind to that; this is not.
- **Length:** 15 + ≤7 + 1 + 8 = at most 31 bytes, well inside Postgres' 63-byte
  identifier limit, so the name is never silently truncated *into* a collision.
- **The `r1354_sampler_p` prefix is deliberate:** residue from a killed run is
  greppable in `pg_database` as this check's litter and nobody else's.

### 3.2 The teardown, tied to the same decision

A per-run name that is never dropped is not a fix — it trades a flaky gate for
unbounded scratch accumulation. So the two defaults are one decision:

| `USAGE_FOLD_DB` | `USAGE_FOLD_DROP` | scratch name | afterwards |
| --- | --- | --- | --- |
| unset | unset | generated | **dropped** — ephemeral by construction, cleans up by construction |
| set | unset | operator's | **kept** — a name a human chose is theirs |
| either | `1` | — | dropped (still only if *this* run created it) |
| either | `0` | — | kept, for a post-mortem; the name is on the verdict line |
| either | anything else | — | **throws with diagnostics**, exit 1 |

`USAGE_FOLD_DROP` is no longer a truthy-string test. A typo in it decides whether a
database survives, and guessing either way would be wrong in a way nobody notices
for weeks, so an unrecognised value is an explicit error rather than a silent
fallback.

Beyond that switch the drop stays **narrow**: it only ever fires on a database this
process created in this run (`scratchCreatedHere`). `USAGE_FOLD_DROP=1` cannot
outrank a pre-existing database belonging to someone else.

### 3.3 `gates-808.sh` no longer overrides anything

The `USAGE_FOLD_DB=r1354_sampler_$$ USAGE_FOLD_DROP=1` prefix is **removed**, and
the comment above the gate now says why setting it again would be a regression:
pinning the guarantee to one call site *and* stopping this gate from ever
exercising the default — the very thing that has to stay right. Left unset on
purpose, so **gate 18 is now the default's canary**.

---

## 4. The proof

### 4.1 Five concurrent, on the new default, no environment at all

```
leftover r1354_sampler_p* BEFORE: 0

fixed-1 EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1655441_dffa5f26)
fixed-2 EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1655442_146b44a4)
fixed-3 EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1655466_bb240d41)
fixed-4 EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1655447_609c7a5e)
fixed-5 EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1655468_1e7e7882)

(created scratch database r1354_sampler_p1655441_dffa5f26)
(dropped scratch database r1354_sampler_p1655441_dffa5f26)
… ×5, created and dropped, five distinct names …

leftover r1354_sampler_p* AFTER: 0
```

Same five processes, same host, same second — 5/5 green where the control was
5/5 red.

### 4.2 Two concurrent, as the brief names

```
pair-A EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1657892_911721c2)
pair-B EXIT=0  ALL PASS — usage fold (scratch db: r1354_sampler_p1657882_aef6aeb7)
```

### 4.3 Through the suite's own harness — the command `gates-808.sh` actually issues

`bash -c "set -o pipefail; cd forge-control && ./node_modules/.bin/tsx
../scripts/checks/check-usage-fold.ts | tail -3"`, two at once:

```
--- suite harness instance 1  EXIT=0
(dropped scratch database r1354_sampler_p1664920_92bfa9b3)

ALL PASS — usage fold (scratch db: r1354_sampler_p1664920_92bfa9b3)
--- suite harness instance 2  EXIT=0
(dropped scratch database r1354_sampler_p1664925_98e148a8)

ALL PASS — usage fold (scratch db: r1354_sampler_p1664925_98e148a8)
residue: 0
```

`tail -3` still ends on the verdict line: `dropScratch()` prints before the
summary precisely so the gate's `tail` window keeps the verdict last.

### 4.4 A single run still passes — no failure mode traded for another

```
$ tsx ../scripts/checks/check-usage-fold.ts        # no environment
(created scratch database r1354_sampler_p1651989_1eaf1cd9)
(dropped scratch database r1354_sampler_p1651989_1eaf1cd9)
ALL PASS — usage fold (scratch db: r1354_sampler_p1651989_1eaf1cd9)
EXIT=0                                                       real 0m6.049s
```

### 4.5 The teardown fires on the FAILURE paths, not only the happy one

This is the claim that matters for accumulation, so it was driven rather than
argued. Two controlled mutations of the subject, each run, each reverted, the file
restored **by hash**:

| mutation | path exercised | result |
| --- | --- | --- |
| an expected value flipped `1000 → 1001` | `main()`'s red path, `dropScratch()` before the summary | `EXIT=1`, `1 FAILURE(S)`, **`(dropped scratch database r1354_sampler_p1661252_27d44710)`** |
| `throw new Error("forced failure…")` inserted after `db.exec(SCHEMA)` | the top-level `catch` | `EXIT=1`, error printed, **`(dropped scratch database r1354_sampler_p1663585_34537364)`** |

```
sha256 before mutation: 03a44f768c71b518e64b3a6098d9c082e1e781b8b169f10f93b39b14ff7c94e3
sha256 after restore:   03a44f768c71b518e64b3a6098d9c082e1e781b8b169f10f93b39b14ff7c94e3
IDENTICAL — subject restored byte for byte
```

A red gate leaks nothing.

### 4.6 The environment matrix, each cell driven

```
USAGE_FOLD_DROP=yes  → throws, EXIT=1   (explicit error, not a silent "falsy → keep")
USAGE_FOLD_DROP=0    → (created r1354_sampler_p1658879_836bac0b) … ALL PASS, no drop line — KEPT
USAGE_FOLD_DB=r1354_sampler, DROP unset → ALL PASS, no create/drop line — operator's db untouched
```

### 4.7 Standalone typecheck (gate 19, the exact flags it uses)

```
$ npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
    --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions \
    --isolatedModules --types node ../scripts/checks/check-usage-fold.ts
TSC_EXIT=0
```

`bash -n scripts/checks/gates-808.sh` → parses.

---

## 5. Scratch accumulation on this server — a finding, not a fix

The brief asked for teardown to be confirmed and pointed at 61 GB of the same
mistake in `/tmp`. The Postgres server has its own version of it. As measured
during this task:

```
content_forge            283 MB    ← never touched by this check
fleet_selftest             7.9 MB
forge_dismiss_probe        8.0 MB
forge_dismiss_ui_1350       34 MB
forge_r203_gate … forge_r226_review   (10 databases, ~8-10 MB each)
forge_r850_dryrun / forge_r860_dryrun
forge_tg_scratch            14 MB
forge_usage_probe_1351     8.2 MB
r1354_sampler / r1354_sampler_surfaces
r1355_gap / r1355_gap2 / r1355_prefix
r1356_mut / r1356_repair
r1357empty / r1357mut
rev1353_scratch
usage_probe_1352
```

**28 abandoned scratch databases, roughly 250 MB**, every one of them the residue
of a harness that named a database and never dropped it. This change stops gate 18
adding to the pile; it does not clean the pile up. **Dropping them needs Konrad's
explicit instruction and none was given, so nothing here was deleted.** They are
all named for retired rounds and the two `usage_probe`/`sampler` ones are this
check's own ancestors — a sweep is almost certainly safe, but "almost certainly"
is not the standard for `DROP DATABASE`.

`content_forge` was never touched. The check refuses to run at all if
`DATABASE_URL`'s database name equals the scratch name, and every statement other
than `CREATE DATABASE`/`DROP DATABASE` is issued against the scratch DSN.

---

## 6. Write-set

Declared, and nothing outside it:

- `scripts/checks/check-usage-fold.ts`
- `scripts/checks/gates-808.sh`
- `docs/plan/artifacts/os-usable-for-work/phase3/gate18-concurrency.md` (this file)

Exactly one scratch database was dropped by hand — `r1354_sampler_p1658879_836bac0b`,
created by this task's own `USAGE_FOLD_DROP=0` matrix cell minutes earlier. Every
other database this task created was dropped by the subject itself. No pre-existing
database was altered or removed.
