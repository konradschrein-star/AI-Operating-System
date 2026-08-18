# Phase 2, fix cycle 2 — independent re-verification of the round-3 blockers

## What this file is, and what it is not

The code answering the round-3 re-review landed in `5948d33`, committed by an
earlier invocation of **this same task row** that was cut off by the run timeout
before it reported (the deadlock is a known engine failure mode). This round
therefore inherited a tree whose commit message already claimed all four
blockers. A commit message is not evidence.

So nothing below is copied from `phase2-fixcycle1-round3.md`. Every measurement
here was **taken again, from scratch, at the committed sha**, by a process that
did not write the code it is measuring. Where my numbers agree with that file
they agree independently; where my method differs I say so. The one claim I did
NOT re-derive — that the reviewer's *original* pre-fix behaviour was as
described — I could not, because the pre-fix code is gone; I verified instead
that the post-fix behaviour is the inverse of the sentence the reviewer quoted.

**Toolchain at measurement:** tsc 5.7.2, node v22.22.2, bash 5.2.21,
shellcheck 0.9.0.
**Gate sha256 that produced every measurement below:**
`7d11f4c067e079fd10f11fe518606ca1e9c31a51bbec8bf595e6ba9885b03281`
**Gate sha256 at the tip of this round:**
`4d73803b0b8155d48a319ddb3bff6f9d87b2256b57387d9c56e3e09dc5f44e67`
The difference between the two is **comment-only** and provably so: `git diff
-U0`, with `+++/---` and `#`-prefixed lines removed, leaves **0 lines**. Two
stale cross-references called the suppression canary the "fourth" when the
SELF-TEST block prints five (round 3 added a fifth to the existing four); a
reviewer checking "four canaries" against a five-line block would have been
sent looking for a missing one. The gate was re-run at the tip sha anyway —
same baseline, same five `ok:` lines, `shellcheck -S warning` clean.
**Profile sha256:** `837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8`
— unchanged since round 2, so `census-G` and `reproduce-census.sh` remain valid
and were not re-run.
**Tree:** `git status --porcelain` empty before and after every probe below.
Every probe was removed and the emptiness re-asserted.

**Baseline, re-measured:**
`42 found / 42 compiled / 6 type failures / 0 fidelity / 0 missing / 0 uncovered
/ 0 suppressions`, exit 1, wall clock 148s. The same six reds. Unchanged.

All five self-test canaries print their own `ok:` line before any subject is
compiled — including the new fifth, `ok: the suppression scanner works — 5
comment shapes seen, 1 string decoy ignored`. I checked specifically that the
new canary is not silent-on-success: a canary an operator cannot see in the
transcript is a canary nobody knows stopped singing. It is not silent; the
only defect was that two comments and `03-quality.md` line 180 miscounted it
as the fourth, which this round corrected.

---

## Blocker 1 — the JSDoc suppression breach ✅ CLOSED, re-measured two ways

### 1a. Ground truth: does each shape suppress, and does the scanner see it?

I extracted the scanner **verbatim** from the gate (`awk` over the heredoc at
step 9c, sha256 `792d6320437ce199a19d901506c6dad36df908a142ffb4c8fc203e67715aee4e`)
and cross-tabulated it against the compiler, using the gate's own compile
mechanism — a generated per-file config extending the profile — on fifteen
probe files, each carrying one comment shape above `export const broken: string
= null;`.

| Probe | Comment shape | tsc | scanner |
|---|---|---|---|
| c00 | *(none — control)* | reports TS2322 | `-` |
| s01 | `// @ts-ignore` | suppresses | `1:@ts-ignore` |
| s02 | `//@ts-ignore` | suppresses | `1:@ts-ignore` |
| s03 | `/// @ts-ignore` | suppresses | `1:@ts-ignore` |
| s04 | `/* @ts-ignore */` | suppresses | `1:@ts-ignore` |
| **s05** | **`/** @ts-ignore */`** | **suppresses** | **`1:@ts-ignore`** |
| **s06** | **`/**@ts-ignore*/`** | **suppresses** | **`1:@ts-ignore`** |
| **s07** | **`/** @ts-expect-error */`** | **suppresses** | **`1:@ts-expect-error`** |
| s08 | `/**@ts-expect-error*/` | suppresses | `1:@ts-expect-error` |
| s09 | `/* @ts-expect-error */` | suppresses | `1:@ts-expect-error` |
| s10 | `// @ts-expect-error` | suppresses | `1:@ts-expect-error` |
| s11 | `//   @ts-ignore` | suppresses | `1:@ts-ignore` |
| s12 | `@ts-ignore` on line 2 of a JSDoc block | **reports TS2322** | `-` |
| d01 | the directive text inside a STRING | *(no error to report)* | `-` |
| d02 | `@ts-nocheck` as prose mid-comment | *(no error to report)* | `-` |

The three bolded rows are exactly the three the reviewer measured as
`gate-grep:MISSED`. All three are now seen. **Zero disagreements between the
compiler and the scanner across all fifteen probes** — in both directions:
nothing tsc honours is missed, and nothing tsc ignores is flagged.

s12 is the case that makes an approximation dangerous in the *other* direction:
tsc does NOT honour it, and the scanner does not flag it. A gate that failed a
subject over an inert comment would teach the next maintainer to distrust it.

d01/d02 close the false-positive direction the reviewer named in the same
paragraph — an instrument that legitimately greps app source for these strings
is no longer failed by its own search term.

### 1b. End-to-end: the reviewer's own repro, on the real 42-subject directory

Planted, side by side:

- `scripts/checks/zz-jsdoc-breach.ts` — `/** @ts-ignore */` + `export const
  definitelyBroken: string = null;` (the reviewer's file, verbatim)
- `scripts/checks/zz-legit-grepper.ts` — the directive text in three string
  literals, no type error

Full gate run, unmodified script:

```
  SUPPRESSED scripts/checks/zz-jsdoc-breach.ts          1:@ts-ignore
  PASS scripts/checks/zz-jsdoc-breach.ts                exit 0, 0 diagnostics
  PASS scripts/checks/zz-legit-grepper.ts               exit 0, 0 diagnostics
  ...
  subjects found 44  subjects compiled 44  type failures 6  ...  suppressions 1
check-instrument-typecheck.sh FAILED — 6 type failure(s), ... 1 suppression(s), census mismatch 0.
```
exit **1**.

The reviewer measured, on the identical file: `PASS … exit 0`, `suppressions 0`,
`ok: 0 subjects carry @ts-nocheck, @ts-ignore or @ts-expect-error`, and the
final line `PASSED — 37/37 subjects compiled clean.`, exit 0 — the sentence A2
defines as a breach. That outcome is now inverted. Note the subject still
*compiles* clean (`PASS … 0 diagnostics`) — it must, the directive works — and
the run fails anyway, on the `SUPPRESSED` line and the census counter. That is
the correct shape: the gate is not pretending the compiler reported something
it did not.

`zz-legit-grepper.ts` passing in the same run proves both directions in one
transcript.

---

## Blocker 2 — the wedged extension path ✅ CLOSED, re-measured

I made **exactly** the edit `02-architecture.md` §7 promises a successor can
make, and nothing else — one line, the first of the two named variables:

```
SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" "scripts/*.ts" )
```
(`git diff --stat` → `1 file changed, 1 insertion(+), 1 deletion(-)`.)

Result:

```
  PASS scripts/import-scraper-places.ts                 exit 0, 0 diagnostics
  PASS scripts/measure-schedule.ts                      exit 0, 0 diagnostics
  subjects found 44  subjects compiled 44  type failures 6  fidelity violations 0
                     missing 0  uncovered 0  suppressions 0
```
exit 1, on the same six reds. **No `REFUSING TO RUN` line anywhere in the
transcript.**

The reviewer measured `REFUSING TO RUN: the two enumerations disagree. bash
globs found 44; find found 86.` — unrecoverable without editing a third
function. Gone.

Three consequences worth naming, because each was a separate hand-derived copy
before and each moved on its own from the single edit:

- `fidelity violations 0` — the accepted-prefix set widened to `scripts/`
  itself. Had it not, both new subjects' diagnostics would have been reported
  as profile violations under the "THE PROFILE IS WRONG, NOT THE APP" essay.
- `uncovered 0` — the coverage globs widened to the new root, so R10's safety
  net follows the subjects instead of staying behind at `scripts/checks/`.
- The second opinion agreed at 44, not 86: one `find` per glob, deduplicated by
  **resolved path**, so the two overlapping roots no longer multiply.

The edit was reverted (`cp` from a pre-edit copy) and the tree re-asserted
clean before the next probe.

---

## Blocker 3 — the symlinked subdirectory ✅ CLOSED, both halves measured

The two halves behave differently on purpose, and I measured them separately.

**Half A — the reviewer's exact repro: a symlinked directory holding one `.ts`
at depth 1.** `ln -s /tmp/linktarget scripts/checks/zz-link`, one file inside:

```
  PASS scripts/checks/zz-link/zz-linked-shallow.ts      exit 0, 0 diagnostics
  subjects found 43  subjects compiled 43  ...  uncovered 0
```
No refusal. The file is **enumerated and compiled**, which is the round-200
behaviour the reviewer said had regressed. The reviewer measured `bash globs
found 46; find found 45`, exit 1, no subject compiled.

**Half B — a file DEEPER inside the symlink**, which bash's `**` genuinely
cannot reach (I confirmed this independently: with `globstar nullglob dotglob`
set, the glob yields `zz-link/zz-linked-shallow.ts` and never
`zz-link/deeper/zz-linked-deep.ts`). Here the gate still refuses — correctly,
because a TypeScript instrument would otherwise sit unreachable and unnamed —
but it now refuses *diagnosably*:

```
REFUSING TO RUN: the two enumerations of the subject set disagree.
  globs: scripts/checks/**/*.ts scripts/checks/**/*.tsx
  ONLY find saw:      scripts/checks/zz-link/deeper/zz-linked-deep.ts
     reachable through the SYMLINKED directory scripts/checks/zz-link — bash's `**` does
     not recurse through a symlink, so this file can never be a subject
     while it lives there. Replace scripts/checks/zz-link with a real directory, or move
     the file: it is a TypeScript instrument this gate cannot reach.
  1 file(s) above. bash globbed 43; find resolved 44.
```

Against the reviewer's complaint — "the message gives the operator no way to
diagnose it", "One of them is wrong and this gate does not know which" — this
names the file, names the symlinked ancestor, states the mechanism, and gives
two remedies. The set difference replaced the bare count.

Symlink and target removed; tree re-asserted clean.

---

## Blocker 4 — the fix-cycle row's `write_set` ❌ STILL NOT FIXABLE HERE

Not the builder's, per the reviewer's own words, and outside this worktree
(the defect is in `forge-control`'s task seeding). **It has now appeared in a
second, distinct shape**, which strengthens the case rather than repeating it:

| Round | Row | Declared `write_set` | Consequence |
|---|---|---|---|
| r2 | `17eb28b3` | two **reviewer evidence files** | writing them = tampering with reviewer evidence; six real writes undeclared |
| r3 | `d95aeca4` | one reviewer verdict file | same |
| **r4 (this one)** | — | **empty — nothing declared at all** | **every path written is undeclared, by construction** |

So the gate is unsatisfiable on fix-cycle rows in both directions: inherit the
reviewer's set and it names files you must not touch; inherit nothing and every
write is undeclared. Re-escalated via `/api/reminders` with this second data
point (reminders `e478615f`, `2a7e1862`; the round-3 escalation was `11:06`,
delivered). Proceeding by default, with every path disclosed in the report.

---

## Out of scope this round, named so it is not mistaken for an omission

`scripts/checks/instrument-manifest.txt` still holds its seven round-800
inclusion-list entries and is **read by nothing**. That is deliberate and
planned: `02-architecture.md` §4.6 and `04-phases.md` D5.1 invert it from an
inclusion list into a waiver ledger in **phase 5**, in the same commit that
implements the reader hooked at step 8 of the gate. Pointing a ledger reader at
it today would read seven bare paths as seven waivers, find all seven clean,
and report seven "waived but clean" violations — destroying A2.2's "exactly 6
failures" with noise from a file this phase does not own.

The brief's phrasing ("extend `instrument-manifest.txt` to cover the whole
directory") was superseded during phase 1 by a stronger answer to the same
requirement: the gate enumerates the directory **at run time**, so there is no
list that can go stale, and R10 fails the run on any TypeScript-family file the
globs decline to read. The brief's goal — the whole directory under the gate —
is met at `42 found / 42 compiled / 0 uncovered`; the named mechanism is not
the one used, and that substitution is recorded in `02-architecture.md` §4.6,
not invented here.

Phase 3 — fixing the six red scripts — has not run. Exit 1 on the baseline is
correct at this phase.

---

## Standing gates, at the measured sha

| Check | Result |
|---|---|
| Baseline | 42/42, 6 reds, 0 uncovered, 0 suppressions, 0 fidelity, exit 1 |
| Self-test | five canaries, each printing its own `ok:` line before any subject compiles |
| `shellcheck -S error` | clean |
| `shellcheck -S warning` | clean |
| Scanner vs compiler | 15 probes, 0 disagreements, both directions |
| §7 extension edit | 44/44, no refusal, all three derivations widened from one line |
| Symlink, depth 1 | enumerated and compiled |
| Symlink, deeper | refuses with a named set difference and the ancestor identified |
| Tree after every probe | `git status --porcelain` empty |
