# Phase 2, fix cycle 1 — closing the six breaches and three findings

Answers `evidence/phase2-redteam.md` (commit `aa2ab5b`, verdict NEEDS_FIXES,
nine numbered points) and the round-2 gate FAIL (`19f9e6f`). Every point below
is closed and every closure was **re-planted on the real 42-subject
directory**, not on a trimmed scratch — the red team's own standard.

Reviewed tip: `19f9e6fdb51f4055d36fec4ac4388c63c1b15958`.
Toolchain: tsc 5.7.2, node v22.22.2, bash 5.2.21, shellcheck at `-S warning`.

## What changed

| File | Change |
|---|---|
| `tsconfig.checks-instruments.json` | `"skipLibCheck": false` — an OVERRIDE of the base config, with the measurement and the consequence in its own comment block |
| `scripts/checks/check-instrument-typecheck.sh` | enumeration, coverage scan, toolchain assertions, compiler self-test, suppression scan, fidelity reporter, verdict counters |
| `01-requirements.md` | R8 (depth + dotfiles + second opinion), R10 (uncovered FAILS), R28 (`@ts-nocheck`, and the directory-scoped check beside diff-scoped P-A) |
| `02-architecture.md` §4.1 | the control flow now describes the gate that exists: steps 3b, 5b, 7, 9b, 10b |
| `03-quality.md` | P-A's alternation; phase-2 gate expectations |

## Baseline — the gate still answers phase 2 correctly

```
CENSUS
  subjects found 42   subjects compiled 42   type failures 6   fidelity violations 0   missing 0   uncovered 0   suppressions 0
check-instrument-typecheck.sh FAILED — 6 type failure(s), … census mismatch 0.
exit=1
```

Per-subject verdicts are byte-identical to the pre-fix run (`diff` of the
`PASS`/`FAIL`/`MISSING` lines is empty), so A2.1 and A2.2 are untouched: 42
found, 42 compiled, exactly the phase-3 six red. The only content difference
anywhere in the transcript is that `skipLibCheck: false` changes the ORDER in
which tsc prints the members of one union in `check-orientation.ts`'s TS2322
text — same file, same line, same column, same code.

`reproduce-census.sh` still reproduces `census-G` **byte-for-byte** under the
new profile (`green 36 / red 6 / total 42`), so the phase-1 artifact the whole
project is anchored to survives the profile edit. That was checked before
anything else, because a census that differs would have voided every downstream
number.

Wall clock: **54s → ~140s**. That is the price of `skipLibCheck: false`: tsc
now also reads the declaration files it used to skip, on all 42 invocations.
Measured on the heaviest subject, `check-settings-surface.tsx`: 3.2s → 5.6s.
S10 records the gate's wall clock and calls a regression past ~4× the round-800
baseline a finding; this is ~2.6× the round-200 baseline and is bought with the
answer to the worst breach on the list.

---

## 1. B1 — a `.d.ts` counted as compiled and never checked  ✅ CLOSED

**Fix:** `"skipLibCheck": false` in the profile — an explicit override of
`forge-control-web/tsconfig.json:6`, which is right for the app and
catastrophic here, because `skipLibCheck` *means* "do not typecheck declaration
files" and `*.ts` matches `*.d.ts`. The alternative the reviewer offered —
drop `.d.ts` from the subject set and name it — was rejected: combined with
point 6 below (uncovered files must fail) it would make every legitimate
`.d.ts` under `scripts/checks/` a permanent red, and it would leave a `.d.ts`
that an instrument *imports* unchecked as well. Both holes close with the
override.

Re-planted, real directory:

```
  FAIL scripts/checks/zz-probe-types.d.ts               exit 2
         scripts/checks/zz-probe-types.d.ts(2,24): error TS2717: Subsequent property declarations
         must have the same type.  Property 'a' must be of type 'string', but here has type 'number'.
```

Round 1 reported that same file as `PASS … exit 0, 0 diagnostics`.

**And the fix is now itself guarded.** Setting `skipLibCheck` back to `true` —
a one-word edit a future maintainer could make while "cleaning up" — no longer
degrades the gate silently:

```
SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
REFUSING TO RUN: the compiler self-test failed — a declaration file was NOT typechecked
  (expected TS2717; skipLibCheck must be false) (canary-declaration.d.ts).
exit=1
```

## 2. B4 — `@ts-nocheck` and the suppression list  ✅ CLOSED

`@ts-nocheck` is now first in R28 and first in P-A's alternation. Both were
amended; and because P-A greps a DIFF and therefore cannot see a suppression
already on `main` (finding F2), the gate — the only thing that opens every
subject on every run — now scans the directory for the three comment
directives:

```
  SUPPRESSED scripts/checks/zz-nocheck.ts               1:// @ts-nocheck
  PASS scripts/checks/zz-nocheck.ts                     exit 0, 0 diagnostics
…
SUPPRESSIONS — no subject may ask the compiler to look away (R28)
  1 directive(s) found, named above, and this run FAILS because of them.
```

The `PASS` line is kept deliberately: it is the evidence that the compiler was
lied to. The subject is still compiled and still counted, so the census
reconciles; the run fails on the `suppressions` counter.

`: any` / `as any` / `as unknown as` stay with P-A alone, stated in R28: a
directory-wide grep for those would also fire on an instrument that
legitimately searches app source for that string. The three comment directives
have no such ambiguity — they are matched only in comment position.

Today's directory: zero matches, so the scan starts clean and can only fire on
something new.

## 3 + 4. B2, B3 — subdirectories and dotfiles  ✅ CLOSED

`SUBJECT_GLOBS` is now `scripts/checks/**/*.ts` / `**/*.tsx` expanded with
`globstar`, `dotglob` and `nullglob`. Both shapes are now COMPILED rather than
merely named:

```
  FAIL scripts/checks/.zz-hidden.ts                     exit 2
         scripts/checks/.zz-hidden.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/zz-sub/broken.ts                  exit 2
         scripts/checks/zz-sub/broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

A file named exactly `.ts` is matched too (`*` matches the empty string under
`dotglob`; verified in isolation before the change went in).

The `UNCOVERED` block that printed `none` while a broken file sat in a
subdirectory is replaced by a **coverage scan** which is defined by depth AND
extension, independently of what the subject globs happen to be:

```
COVERAGE — every TypeScript-family file under the subject roots must be compiled
  scanned scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/checks/**/*.mts scripts/checks/**/*.cts: 42 file(s); enumerated as subjects: 42
  ok: 0 uncovered — every TypeScript-family file on disk is a subject below
```

## 5. F1 — the dead enumeration guard  ✅ CLOSED

The fix is not a better guard on the write; **there is no write.** Enumeration
happens in this shell, directly into an array — no subshell, no temp file, no
pipe, no command substitution. The ENOSPC shape that truncated 31 → 24 has
nothing left to truncate.

What remains — a glob that silently sees less than the tree holds — is checked
against a **second opinion taken with a different tool**, whose roots and name
patterns are derived from the same variables so the two cannot drift:

```
REFUSING TO RUN: the two enumerations disagree.
  bash globs found 43; find found 42.
  globs: scripts/checks/**/*.ts scripts/checks/**/*.tsx
```

That transcript is the guard firing on the real directory, produced by a probe
copy of the gate whose `find` was narrowed to `-type f` while a directory named
`scripts/checks/zz-dir.ts` was present. The shipped gate does **not** filter by
type — a glob matches by name, so the second opinion must too — and on the same
tree it reaches the precise path instead:

```
  MISSING scripts/checks/zz-dir.ts                      enumerated but ABSENT at compile time — NOT compiled
  subjects found 43   subjects compiled 42   …   missing 1
  MISMATCH: compiled 42 of 43 subjects found — a subject was SKIPPED and this run certifies nothing.
```

The guard also fired for real during development, before any deliberate probe:
a bug in the root deduplication made `find` walk `scripts/checks` twice and
report 84 against the globs' 42. It refused, and that is how the bug was found.

Related, and load-bearing: the script now runs under `set -E`. An ERR trap is
NOT inherited by shell functions or command substitutions, and round 200 had no
functions. The first version of this change aborted with an **empty transcript**
and exit 1 — the trap's whole job undone by scoping. A gate that dies silently
is indistinguishable from a gate that found nothing.

## 6. F7 / R10 — uncovered files were named and then certified  ✅ CLOSED

R10 is amended (the requirement was the defect, as the red team said). A
TypeScript-family file the subject globs do not match is named **and fails the
run**:

```
  UNCOVERED scripts/checks/zz-probe.cts — matched by … *.mts *.cts, not by … *.ts *.tsx
  These are NOT compiled and NOT counted below, and this run FAILS because of them.
…
  subjects found 46   subjects compiled 46   type failures 9   fidelity violations 0   missing 0   uncovered 1   suppressions 1
check-instrument-typecheck.sh FAILED — 9 type failure(s), 0 fidelity violation(s), 0 missing subject(s), 1 uncovered file(s), 1 suppression(s), census mismatch 0.
```

Round 1 answered the same file with `PASSED`, exit 0.

*(That census line is the combined probe: all five plants — `.d.ts`,
subdirectory, dotfile, `.cts`, `@ts-nocheck` — present at once on the real
directory. 46 subjects = 42 + 4 compiled plants; 9 type failures = the phase-3
six plus three plants; the `.cts` is the uncovered one and is not compiled.)*

## 7. B5 — `tsc` pinned, `node` not  ✅ CLOSED

`node` is resolved absolutely and recorded; both version strings must be
well-formed before anything is compiled. Three escalating fakes, each run
against the real directory:

| fake `node` on PATH | round 1 | now |
|---|---|---|
| exits 0, prints nothing | `PASSED — 3/3`, exit 0 | `REFUSING TO RUN: the compiler did not identify itself` (`tsc --version` printed `''`), exit 1 |
| prints `Version 5.7.2` for everything | — | `REFUSING TO RUN: node did not identify itself` (`node --version` printed `Version 5.7.2`), exit 1 |
| answers `node --version` as node **and** the tsc shim as tsc — both assertions satisfied | — | reaches the self-test and dies there, exit 1 |

The third is the one that matters, because it is the honest limit of a version
check: a fake that lies convincingly walks straight past it. What stops it is
that the compiler is asked to **produce a specific diagnostic**:

```
  node             : v22.22.2  (/tmp/tmp.Zj472KlopD/node)
…
SELF-TEST — the compiler and the profile must prove themselves first
REFUSING TO RUN: the compiler self-test failed — a strict-null violation was NOT reported
  (expected TS2322) (canary-strict.ts).
```

## 8. B6 — the profile was checked for existence, not identity  ✅ CLOSED

Three canaries, written into the run's own temp directory and compiled through
the same generated-config path a subject travels, assert the properties the
profile exists to provide — and one assertion afterwards that nothing was
emitted:

```
SELF-TEST — the compiler and the profile must prove themselves first
  ok: strict null checking is live          — the canary produced TS2322
  ok: declaration files are typechecked     — the canary produced TS2717
  ok: typeRoots, @types paths and jsx work  — the canary compiled clean
  ok: noEmit is in effect                   — 0 files emitted beside the canaries
```

The red team's exact attack — `extends` redirected at `{}`, with
`const s: string = null` sitting under `scripts/checks/`:

```
  subjects found   : 43
SELF-TEST — the compiler and the profile must prove themselves first
REFUSING TO RUN: the compiler self-test failed — a strict-null violation was NOT reported
  (expected TS2322) (canary-strict.ts).
exit=1
--- .js emitted anywhere in the tree? ---
(none)
```

Round 1: `PASSED — 2/2`, exit 0, **and eight `.js` files written into the
worktree**. The degraded run now refuses before compiling a single subject, so
it cannot emit either. `noEmit: false` in the profile is caught as well, via
TS5096 on the first canary (`allowImportingTsExtensions` requires `noEmit`).

**Why not the sha256 pin the red team also offered.** A hash asserts a NUMBER:
every legitimate profile edit becomes a two-file change whose second half is a
mechanical re-paste, which is the exact ritual that teaches a maintainer to
update a checksum without reading what it covers. The canaries assert the
PROPERTIES, and they keep asserting them across edits that keep those
properties true. The profile's sha256 is still printed in the provenance block,
where a number is worth something: it identifies the file.

## 9. F3 / F4 — hostile filenames diagnosed as profile faults  ✅ CLOSED (newline), MITIGATED (backslash)

A subject whose name contains a newline no longer produces a spurious fidelity
violation: its own path is folded back onto one line before the diagnostic is
parsed. Only the copy used for parsing is folded — the `FAIL` block is still
the compiler's full unfiltered output (R21). Re-planted, both shapes at once:

```
  FAIL scripts/checks/zz-nl-a
b.ts                      exit 2
         scripts/checks/zz-nl-a
         b.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
  FAIL scripts/checks/zz-back\slash.ts                  exit 2
         error TS6053: File '…/scripts/checks/zz-back/slash.ts' not found.
…
  subjects found 44   subjects compiled 44   type failures 8   fidelity violations 1   missing 0
```

Round 1: two fidelity violations, both blaming the profile. Now: the newline
case is clean, and the backslash case — which is tsc's own doing, it normalises
`\` into a path separator and answers TS6053 — is still one violation, but the
report leads with the cause:

```
  READ THIS FIRST: 1 violation(s) above came from compiling a subject whose FILENAME
  contains a newline or a backslash. … (Measured: a backslash makes tsc normalise the
  name into a directory separator and answer TS6053 "File … not found".) Rename that
  file and re-run before reading a single word of the paragraph below.
```

The "THE PROFILE IS WRONG, NOT THE APP" essay still follows, unchanged, for the
case it was written for. A third branch was added while the parser was open:
a diagnostic located inside `node_modules/` is reported as a DEPENDENCY's
declarations, because `skipLibCheck: false` makes that reachable for the first
time and the remedy is to upgrade or pin the dependency — emphatically not to
turn `skipLibCheck` back on, which would restore B1.

---

## Regression battery

| Check | Result |
|---|---|
| gate on the untouched directory | 42 found / 42 compiled / 6 failures / 0 uncovered / 0 suppressions, exit 1 |
| per-subject verdicts vs pre-fix | identical |
| `reproduce-census.sh` vs `census-G` | byte-for-byte, `green 36 / red 6 / total 42` |
| `shellcheck -S error`, `-S warning` | clean |
| NF2 — two consecutive runs | only the temp-dir and wall-clock lines differ |
| I6 — run from `/tmp` by absolute path | identical transcript modulo those same two lines, exit 1 |
| NF3 — `git status --porcelain` after every probe | empty but for the files this task changed |
| temp leak | none |
| hostile filenames | five planted, five compiled, zero injection |
| P-A suppressions | none introduced |
| P-B dependency diff | empty |

**NF2**, verbatim:

```
=== NF2 diff of two consecutive runs ===
20c20
<   temp dir         : /tmp/tmp.Dm2WbkyT5g
---
>   temp dir         : /tmp/tmp.Ia2RacjiZJ
95c95
<   wall clock       : 139s
---
>   wall clock       : 144s
```

**I6** — `cd /tmp && bash <abs>/scripts/checks/check-instrument-typecheck.sh`:
`diff` against run A with those two lines filtered out is **empty**, exit 1.
The diagnostic paths still read `scripts/checks/…`, because the compile pins
tsc's cwd to `REPO_ROOT`; an inherited cwd would make every diagnostic look
like a fidelity violation.

**Temp leak:** `ls /tmp | wc -l` went 3807 → 3810 across the three runs, and
the three new entries are this battery's own `nf2-a.txt`, `nf2-b.txt`,
`i6.txt`. No run left a `tmp.XXXX` directory behind.

**Hostile filenames** — the new enumeration sorts through `sort -z` and passes
subjects to tsc only inside JSON, so the round-1 survivors must survive the
rewrite too. Five planted at once, each type-broken:

```
  FAIL scripts/checks/-zz-leading-dash.ts               exit 2
  FAIL scripts/checks/zz probe space.ts                 exit 2
  FAIL scripts/checks/zz$dollar.ts                      exit 2
  FAIL scripts/checks/zz'quote.ts                       exit 2
  FAIL scripts/checks/zz;semi&amp.ts                     exit 2
  subjects found 47   subjects compiled 47   type failures 11   fidelity violations 0   missing 0   uncovered 0   suppressions 0
```

Five names, five subjects, five attributed diagnostics, zero fidelity noise,
zero command execution.

## Cleanliness

Every probe planted its files, ran, and removed them inside one shell with an
EXIT trap, and `git status --porcelain` was read after each. No probe file
survives; no `.js` was emitted anywhere by any run, including the deliberately
degraded ones.

## One defect this fix cycle introduced, and closed

Running the amended P-A against the amended gate reported **five suppressions
— all of them the gate's own prose.** `check-instrument-typecheck.sh` has to
NAME `@ts-nocheck`, `@ts-ignore` and `@ts-expect-error` in its comments and in
its own output in order to refuse them, and P-A's pathspec was the whole
directory.

Fixed by narrowing P-A's pathspec from `scripts/checks/` to
`scripts/checks/*.ts` `scripts/checks/*.tsx` — git matches those across
subdirectories too (verified in a scratch repo, `sub/a.ts` matched). A
suppression directive inside a shell script suppresses nothing, and a check
that fires on the text of the check is a check every later phase learns to
wave through.

```
=== P-A (amended alternation, narrowed pathspec) ===
ok: no suppressions
=== P-B dependency footprint ===
(empty)
=== R30 — nothing under forge-control-web/app or forge-control/src ===
ok: no app files
```

## Provenance of the transcripts above

Every transcript in this document was produced by

```
gate    sha256 cec1850f984b4a283ebba7a117ccb14c09776b6bd507b7156282672e2ba11dac
profile sha256 837f087c97c14091f01e8da4c4096ad75493e19b588a4f44fa96f433f42c71f8
```

which are the committed files, byte for byte — with two exceptions, both
stated where they appear: the `.d.ts` / subdirectory / dotfile / `.cts` /
`@ts-nocheck` combined probe and the fake-`node` and degraded-profile probes
ran against an intermediate revision of the gate whose only later changes were
(a) dropping the `-type` filter from the second opinion and (b) the wording of
the hostile-filename paragraph. Neither touches any behaviour those probes
exercised. The baseline, NF2, I6 and hostile-filename runs are all on the
committed sha256 above.
