# Phase 2, round 3 — the re-review's four blockers, and the gate review's finding 8

Answers the round-3 re-review of fix cycle 1 (tip reviewed `10eb312`, verdict
NEEDS_FIXES, blockers 1–4) and the one point of the round-2 gate FAIL (`19f9e6f`)
that the re-review's table did not cover — finding 8, `scan_fidelity`'s inlined
prefix. Every closure below was **re-planted on the real 42-subject directory**,
never on a trimmed scratch, and every transcript is pinned to the sha256 that
produced it.

**Toolchain:** tsc 5.7.2, node v22.22.2, bash 5.2.21, shellcheck 0.9.0
(`-S error` AND `-S warning` clean).
**Final gate:** `check-instrument-typecheck.sh` sha256
`7d11f4c067e079fd10f11fe518606ca1e9c31a51bbec8bf595e6ba9885b03281`.
**Profile:** `tsconfig.checks-instruments.json` sha256
`837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8` —
**unchanged this round.** The re-review confirmed `skipLibCheck: false` and the
`noEmit` measurement; nothing here required touching it.

## What changed

| File | Change |
|---|---|
| `scripts/checks/check-instrument-typecheck.sh` | the suppression scan (now tsc's own parser + a fourth canary), the second opinion (per-glob `find -L`, set difference, symlink diagnosis), enumeration set semantics, `decompose_glob` and the three derivations that used to be hand-copied |
| `01-requirements.md` | R8 (set comparison, `-L`, dedup), R28 (the eleven-shape table and the property the requirement now states) |
| `02-architecture.md` | §4.1 steps 5, 5b, 9c, 10a, 12; §7 — the "two variables" contract, which was stated and not met, with the table of what was hand-derived |
| `03-quality.md` | P-A's unanchored alternation is now load-bearing and says so; phase-2 gate expectations; a new reviewer-reject clause for hand-derived roots |

**The baseline is untouched.** At the final sha, on the unmodified directory:
`42 found / 42 compiled / 6 type failures / 0 fidelity / 0 missing / 0 uncovered
/ 0 suppressions`, exit 1, the same six reds as round 2
(`check-orientation.ts`, `check-team-confirm.ts`, `check-team-rows.ts`,
`serve-sse-808.ts`, `check-dismiss-peek.tsx`, `check-stop-affordance.tsx`).
Wall clock 140–154s, unchanged: the suppression scan replaced 42 `grep`
invocations with ONE node process, which is why parsing every subject with the
compiler costs nothing measurable.

---

## 1. Re-review blocker 1 — `/** @ts-ignore */` compiled green and unnamed ✅ CLOSED

**Reproduced first.** `SUPPRESSION_RE` required `//` or `/*` followed only by
whitespace, so the JSDoc form matched nothing. Measured directly against the
compiler, one file per shape, each containing
`export const definitelyBroken: string = null;`:

```
01-slash-ignore        // @ts-ignore              SUPPRESSED
02-slash-tight         //@ts-ignore               SUPPRESSED
03-triple-slash        /// @ts-ignore             SUPPRESSED
04-block               /* @ts-ignore */           SUPPRESSED
05-jsdoc               /** @ts-ignore */          SUPPRESSED   <- grep missed
06-jsdoc-tight         /**@ts-ignore*/            SUPPRESSED   <- grep missed
07-jsdoc-expect        /** @ts-expect-error */    SUPPRESSED   <- grep missed
08-block-expect        /* @ts-expect-error */     SUPPRESSED
09-slash-expect        // @ts-expect-error        SUPPRESSED
10-indented                // @ts-ignore          SUPPRESSED
11-trailing-prose      // @ts-ignore because …    SUPPRESSED
12-nocheck-slash       // @ts-nocheck             SUPPRESSED
15-nocheck-triple      /// @ts-nocheck            SUPPRESSED
13-nocheck-jsdoc       /** @ts-nocheck */         reported (tsc does NOT honour it)
14-nocheck-block       /* @ts-nocheck */          reported (tsc does NOT honour it)
16-jsdoc-2nd-line      /**\n * @ts-ignore\n */    reported (tsc does NOT honour it)
```

The compiler's own source says the same thing —
`forge-control-web/node_modules/typescript/lib/typescript.js:11484-11485`:

```js
var commentDirectiveRegExSingleLine = /^\/\/\/?\s*@(ts-expect-error|ts-ignore)/;
var commentDirectiveRegExMultiLine = /^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore)/;
```

**The fix is not a better regex.** Matching tsc's two regexes by hand would
have closed today's leak and left the next one open — and it cannot close the
FALSE-POSITIVE direction at all, because a grep cannot tell a comment from a
string literal. The gate now asks the compiler: `ts.createSourceFile` from the
same installation `$TSC` runs out of, then `commentDirectives` (what tsc
honours as `@ts-ignore`/`@ts-expect-error`, in comment position only) and
`checkJsDirective` (`@ts-nocheck`, where `enabled: false` IS the suppression).
One node process for all subjects, before the compile loop.

**Re-planted, real directory, final sha** (`/tmp/gate-final-A.txt`) — eleven
probes at once: the five suppressing shapes, the two shapes tsc ignores, the
JSDoc-second-line shape, a string-literal decoy, a subdirectory file, a dotfile
and an uncovered `.cts`:

```
  SUPPRESSED scripts/checks/zz-expect.ts                1:@ts-expect-error
  PASS scripts/checks/zz-expect.ts                      exit 0, 0 diagnostics
  SUPPRESSED scripts/checks/zz-jsdoc-tight.ts           1:@ts-ignore
  PASS scripts/checks/zz-jsdoc-tight.ts                 exit 0, 0 diagnostics
  SUPPRESSED scripts/checks/zz-jsdoc.ts                 1:@ts-ignore
  PASS scripts/checks/zz-jsdoc.ts                       exit 0, 0 diagnostics
  SUPPRESSED scripts/checks/zz-nocheck.ts               1:@ts-nocheck
  PASS scripts/checks/zz-nocheck.ts                     exit 0, 0 diagnostics
  SUPPRESSED scripts/checks/zz-triple.ts                1:@ts-ignore
  PASS scripts/checks/zz-triple.ts                      exit 0, 0 diagnostics
  PASS scripts/checks/zz-literal.ts                     exit 0, 0 diagnostics
  FAIL scripts/checks/zz-nocheck-jsdoc.ts               exit 2
  FAIL scripts/checks/zz-jsdoc-2ndline.ts               exit 2
  FAIL scripts/checks/.zz-dot.ts                        exit 2
  FAIL scripts/checks/zz-sub/zz-deep.ts                 exit 2
  UNCOVERED scripts/checks/zz-uncov.cts …
CENSUS
  subjects found 52   subjects compiled 52   type failures 10   fidelity violations 0
  missing 0   uncovered 1   suppressions 5
check-instrument-typecheck.sh FAILED — 10 type failure(s), …, 1 uncovered file(s),
5 suppression(s), census mismatch 0.
```

Read it line by line: **every shape tsc honours is named and fails the run**
(the `PASS` beside each is deliberate — it is the evidence that the compiler was
lied to, and the census still reconciles because the subject was compiled).
**Every shape tsc ignores is left alone** and fails as ordinary broken code, so
the gate does not fail an instrument over an inert comment. **The string-literal
decoy passes**, which is the direction the old grep got wrong: an instrument
that legitimately searches app source for `@ts-ignore` is no longer failed by
its own search term. B2 (subdirectory), B3 (dotfile) and F7 (uncovered `.cts`)
are re-proven in the same run.

**The scanner is itself guarded (step 9c).** Two internal SourceFile fields
carry this check, and a scanner that silently stops matching is exactly what it
replaced. Probe sha `60313bb9…` — the final gate with one field renamed to
simulate a TypeScript upgrade:

```
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
REFUSING TO RUN: the suppression scanner failed its own canary (exit 0).
  expected:
    1	1:@ts-ignore,2:@ts-ignore,3:@ts-ignore,4:@ts-ignore,5:@ts-expect-error
    2	1:@ts-nocheck
  got:
    1	-
    2	1:@ts-nocheck
```

Refused before a single subject was compiled.

**A defect this fix introduced, found by measuring rather than reading.** The
first version detected all five shapes, stored them, and printed none:
`suppressions 0` over a subject it had already identified. `printf '%s'` writes
no trailing newline, and `read` returns non-zero on an unterminated final line,
so the loop dropped the last — usually the only — directive. It is fixed
(`printf '%s\n'`), the comment at that line says why, and it is recorded here
because the transcript above is only trustworthy if the path that produced it
was exercised, not inspected.

## 2. Re-review blocker 2 — the second opinion wedged the documented extension path ✅ CLOSED

Roots and name patterns were deduplicated independently and then multiplied, so
two roots where one contains the other made `find` walk the inner one twice:
`bash globs found 44; find found 86`, permanent refusal, no subject compiled.

Now: one `find` per glob, with that glob's own root, name and depth
(`decompose_glob`), and deduplication of the **resolved paths**. Overlapping
globs are free.

**Measured by making exactly the edit `02-architecture.md` §7 promises** — one
line, verified by `diff` — probe sha `355b6242…` (`/tmp/gate-final-D.txt`):

```
$ diff <probe> <gate>
264c264
< SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" "scripts/*.ts" )
---
> SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" )

  scanned …: 44 file(s); enumerated as subjects: 44
  subjects found   : 44
  PASS scripts/import-scraper-places.ts                 exit 0, 0 diagnostics
  PASS scripts/measure-schedule.ts                      exit 0, 0 diagnostics
PROFILE FIDELITY — every diagnostic must be located under scripts/checks/ scripts/
  subjects found 44   subjects compiled 44   type failures 6   … uncovered 0   suppressions 0
```

No refusal; the two node-side scripts compile; the coverage scan and the
fidelity prefixes widened to `scripts/` **on their own**. That last line is
finding 8 as well as blocker 2 — see §4.

**A second defect the same measurement exposed.** With three overlapping globs
the coverage scan reported `86 file(s)` for 44 files: `enumerate_globs` returned
a bag, not a set. It reached the right verdict — reconciliation and the
uncovered scan are membership tests, not counts — but a census nobody can add up
is a census nobody checks. Enumeration now deduplicates, first occurrence
winning so the per-glob order census-G is anchored to survives. Re-measured with
`scripts/*.ts` AND `scripts/**/*.ts` both added: `scanned …: 44 file(s);
enumerated as subjects: 44`.

## 3. Re-review blocker 3 — a symlinked subdirectory took the gate offline ✅ CLOSED

bash's `**` matches a symlinked directory as one path component and resolves
through it; `find` without `-L` never enters it. A benign tree shape therefore
produced `46 vs 45` and compiled nothing — a regression against round 200 — and
the refusal ("one of them is wrong and this gate does not know which") gave the
operator nothing to act on.

**Depth 1 — now enumerated and compiled** (`/tmp/gate-final-B.txt`, final sha).
`scripts/checks/zz-link -> /tmp/zz-linked-target`, one broken `.ts` inside:

```
  subjects found   : 43
  FAIL scripts/checks/zz-link/zz-shallow.ts             exit 2
         scripts/checks/zz-link/zz-shallow.ts(1,14): error TS2322: Type 'null' is not
         assignable to type 'string'.
  subjects found 43   subjects compiled 43   type failures 7   … census mismatch 0.
```

**Depth 2 — refused, and DIAGNOSED** (`/tmp/gate-final-C.txt`). The two tools
genuinely part company here, because bash's `**` will not recurse THROUGH a
symlink while `-L` will, so the file is one the glob can never reach:

```
REFUSING TO RUN: the two enumerations of the subject set disagree.
  globs: scripts/checks/**/*.ts scripts/checks/**/*.tsx
  ONLY find saw:      scripts/checks/zz-link/deeper/zz-deep.ts
     reachable through the SYMLINKED directory scripts/checks/zz-link — bash's `**` does
     not recurse through a symlink, so this file can never be a subject
     while it lives there. Replace scripts/checks/zz-link with a real directory, or move
     the file: it is a TypeScript instrument this gate cannot reach.
  1 file(s) above. bash globbed 43; find resolved 44.
```

Failing closed is right here — an unreachable TypeScript instrument under the
subject root is R10's case exactly — but the operator is now told which file,
which symlink, and what to do about it.

## 4. Round-2 gate review, finding 8 — `scan_fidelity` inlined `scripts/checks/` ✅ CLOSED

§7 promised "a successor extends this gate by editing the two named variables
and nothing else". Round 2 had two named variables and **three** hand-derived
copies of `scripts/checks/`, none of which fails loudly when forgotten:

| Copy | What a successor would have got | Now |
|---|---|---|
| `scan_fidelity`'s prefix | every diagnostic in the new root reported as a profile violation, under the "THE PROFILE IS WRONG, NOT THE APP" essay | `ACCEPTED_PREFIXES`, derived from the SUBJECT_GLOBS roots |
| `COVERAGE_GLOBS`' roots | R10's safety net silently absent under the new root | derived from the same roots × `TS_EXTENSIONS` |
| the second opinion | permanent refusal (blocker 2) | one `find` per glob |

All three now go through `decompose_glob`, which supports `<root>/**/<name>` and
`<root>/<name>` and **refuses** anything else rather than guessing — a glob
whose root is itself a pattern has no faithful `find` equivalent, and a second
opinion that is not faithful is worse than none. The proof is §2's transcript:
the one-line edit moved the fidelity prefixes and the coverage globs with it.
`02-architecture.md` §7 now states this, with the table, instead of claiming it.

`TS_EXTENSIONS` is the one hand-maintained list left. It is the set of
extensions TypeScript HAS, not a knob for reaching directories.

## 5. Re-review blocker 4 — the fix-cycle row's `write_set` ❌ NOT FIXED HERE, ESCALATED

The re-review's own words: "not the builder's — the fix-cycle row needs a write
set derived from the feedback it is answering, not inherited from the reviewer
row that produced the feedback. Until then this mandatory audit gate is
unsatisfiable on every fix-cycle task in the fleet."

This round's row (`d95aeca4`, r3 builder, `chain_key fix:2:1`) declares exactly
one path — `evidence/phase2-review.md` — the **reviewer's** verdict file from
round 2. Writing it would mean editing reviewer evidence; not writing it means
every path this task touched is undeclared. The defect is in the engine's task
seeding (`forge-control`), which is outside this project's brief and outside
this worktree's scope. Escalated via `/api/reminders`. Disclosed in full in
this round's report; the five paths actually written are all named in "What
changed" above and all sit squarely inside the feedback's scope.

## 6. The standing gates, at the final sha

| Check | Result |
|---|---|
| Baseline | 42 found / 42 compiled / 6 failures / 0 uncovered / 0 suppressions / 0 fidelity, exit 1 |
| Self-test | four canaries `ok` before any subject compiles |
| `shellcheck -S error` | clean |
| `shellcheck -S warning` | clean |
| NF2 determinism | two runs differ on the temp-dir line only (wall clock happened to match at 154s) |
| I6, run from `/tmp` by absolute path | identical but the temp-dir and wall-clock lines |
| NF4, two concurrent runs | both correct, both complete, transcripts identical but the temp dir |
| NF3 tree | `git status --porcelain` shows only this round's four edited files; every probe removed |
| Temp leak | none — the newest `/tmp/tmp.*` predates this round's runs |
| SIGINT | exit 130, temp directory removed, **no verdict line printed** |

The two documents whose numbers this round could have invalidated were checked
first: the profile is byte-identical to round 2, so `census-G` and
`reproduce-census.sh` are untouched, and the per-subject verdicts on the
unmodified directory are the same six reds.
