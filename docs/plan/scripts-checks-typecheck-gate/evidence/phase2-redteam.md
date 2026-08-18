# Phase 2 RED TEAM — `check-instrument-typecheck.sh`

**Brief (03-quality.md §6, A2):** *"Make this gate report PASS while a
`scripts/checks/*.ts` file on disk has a type error. […] You have succeeded if
the final line says PASSED and the exit code is 0 while something is broken."*

**Tree reviewed:** `git rev-parse HEAD` = `16963462e57b4c4ade2ee012484631de851ed023`,
branch `project/b7ab4c57`, worktree
`/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5`.
Gate sha256 `dbf1f946d747500355c3a593ac55d4178fcce03b0978cb18b45c3b1d75b416f4`;
profile sha256 `eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e`;
tsc 5.7.2, node v22.22.2.

**Answer to the brief: YES. The gate can be made to lie, six distinct ways.**
Four of them require nothing but adding an ordinary-looking file to
`scripts/checks/`. The strongest is reproduced below on the real 37-subject
directory, not on a toy: **`check-instrument-typecheck.sh PASSED — 37/37
subjects compiled clean.`, exit 0**, with two genuinely type-broken files
sitting under `scripts/checks/`.

---

## Summary table

| # | Attack | Result | Severity |
|---|---|---|---|
| B1 | `scripts/checks/*.d.ts` — enumerated, counted compiled, **never typechecked** (`skipLibCheck: true` inherited) | **BREACHED** | **CRITICAL** |
| B2 | `scripts/checks/<subdir>/*.ts` — not enumerated **and not named** as uncovered | **BREACHED** | **CRITICAL** |
| B3 | Dotfile subject: `.broken.ts`, or a file named exactly `.ts` — glob has no `dotglob` | **BREACHED** | HIGH |
| B4 | `// @ts-nocheck` in an instrument — gate green, and P-A's suppression grep does not list it | **BREACHED** | **CRITICAL** |
| B5 | Fake `node` on PATH — gate pins `tsc` absolutely, but the pnpm shim `exec node`s from PATH | **BREACHED** | MEDIUM |
| B6 | Profile `extends` redirected to an empty base — checks silently weaken, and the run emits `.js` into the tree | **BREACHED** | MEDIUM |
| F1 | Enumeration-failure guard is structurally dead when the last `SUBJECT_GLOB` matches nothing; ENOSPC silently truncated the subject list 31 → 24 with a self-consistent census | FINDING | **HIGH** |
| F2 | `@ts-ignore` / `@ts-expect-error` — gate green; defended only by a diff-scoped grep that cannot see a suppression already on `main` | FINDING | MEDIUM |
| F3 | Filename containing a newline → spurious fidelity violation, garbled attribution, blames the profile | FINDING | LOW |
| F4 | Filename containing `\` → spurious "no parseable path" fidelity violation | FINDING | LOW |
| F5 | `SIGKILL` leaks the temp directory (`SIGINT`/`SIGTERM`/`SIGHUP` are clean) | FINDING | LOW |
| F6 | TOCTOU: a file created after enumeration is not compiled (~55 s window) | FINDING | LOW |
| F7 | A type-broken `.mts`/`.cts` is named but the run still exits 0 PASSED — permitted by R10 as written | FINDING | MEDIUM |
| S1–S9 | Symlinks (6 shapes), hostile filenames (11 shapes), TTY/colour, fake `tsc`, TMPDIR family, empty directory, concurrency ×2 and ×10, invocation/cwd/env matrix, git provenance, `GLOBIGNORE`/`SHELLOPTS`/`IFS`/`CDPATH`, CRLF/BOM, mid-run delete, fidelity-parser probes | SURVIVED | — |

**Method.** Every destructive experiment ran in a scratch copy under
`mktemp -d` (`/tmp/rt-sdBpfz/repo`, `rsync -a --exclude node_modules` + symlinked
`node_modules`). The live checkout `/opt/forge-ai-os` was never touched. For fast
iteration the scratch was trimmed to two known-green subjects
(`check-classify.ts`, `check-duration.ts`); this changes the *size* of the
subject set and nothing about the enumeration, compilation or verdict logic.
Every breach is additionally reproduced on the full directory (§B1/B2 below).

---

## BREACHES

### B1 — a `.d.ts` under `scripts/checks/` is counted as compiled and is never typechecked  ★ CRITICAL

`SUBJECT_GLOBS` is `scripts/checks/*.ts` (line 124), which **matches
`broken.d.ts`**. So a declaration file is enumerated, handed to `tsc`, and
increments `COMPILED`. But the profile `extends
./forge-control-web/tsconfig.json`, which sets `"skipLibCheck": true`
(`forge-control-web/tsconfig.json:6`), and the profile never overrides it
(`tsconfig.checks-instruments.json:62-80`). `skipLibCheck` *is* "skip
typechecking declaration files". The subject is opened, skipped, and reported
`PASS … exit 0, 0 diagnostics`.

This is exactly attack-surface item 12 — *found == compiled while a subject was
never actually compiled* — and the census cannot see it, because from the
script's point of view nothing went wrong.

```bash
cat > scripts/checks/broken.d.ts <<'EOF'
export interface Foo { a: string; }
export interface Foo { a: number; }
export declare const bad: string;
EOF
bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
```

```
  PASS scripts/checks/broken.d.ts                       exit 0, 0 diagnostics
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics

CENSUS
  subjects found 3   subjects compiled 3   type failures 0   fidelity violations 0   missing 0

check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0
```

The same file, same compiler, `skipLibCheck` off:

```
$ forge-control-web/node_modules/.bin/tsc --noEmit --skipLibCheck false --strict \
    scripts/checks/broken.d.ts --pretty false
scripts/checks/broken.d.ts(2,24): error TS2717: Subsequent property declarations must have
  the same type.  Property 'a' must be of type 'string', but here has type 'number'.
rc=2
```

**Verdict: BREACHED.** Final line `PASSED`, exit 0, with a real `TS2717` on
disk under `scripts/checks/`.

### B2 — a subdirectory under `scripts/checks/` is invisible AND unnamed  ★ CRITICAL

The glob does not recurse. R8 defines it flat, so that alone is a design choice —
but `UNCOVERED_GLOBS` (line 132) covers only `*.mts` and `*.cts`, so a
subdirectory is not merely uncompiled, it is **silently** uncompiled. The
`UNCOVERED EXTENSIONS` block, whose entire purpose (R10, lines 252-257) is that
"the defect R10 exists against is SILENCE, not the file", prints `none`.

```bash
mkdir -p scripts/checks/sub
echo 'export const n: number = "not a number";' > scripts/checks/sub/broken.ts
bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
```

```
UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts
…
  subjects found 2   subjects compiled 2   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
EXIT=0
```

**Verdict: BREACHED.** Honest scoping to a flat directory would still *name* what
it declined to look at; this reports "none".

*Ranking note, in the gate's favour:* a subdirectory helper that a covered
instrument **imports** is still caught, as a type failure attributed to the
importer (attack R4 below, exit 1). Only files nothing imports go dark.

### B1+B2 reproduced on the REAL directory (37 subjects)

To rule out an artifact of the trimmed scratch: all 42 instruments restored, the
six legitimately-red files removed (phase 3 has not run), the two shapes planted.

```bash
# 36 real instruments on disk, plus the two plants
cat > scripts/checks/instrument-types.d.ts <<'EOF'
export interface Foo { a: string; }
export interface Foo { a: number; }
EOF
mkdir -p scripts/checks/sse
echo 'export const n: number = "not a number";' > scripts/checks/sse/broken.ts
bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
```

```
UNCOVERED EXTENSIONS — TypeScript-family files this gate does NOT compile
  none: no file matches scripts/checks/*.mts scripts/checks/*.cts
…
  PASS scripts/checks/instrument-types.d.ts             exit 0, 0 diagnostics
…
  subjects found 37   subjects compiled 37   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 37/37 subjects compiled clean.
EXIT=0

--- the planted files, still broken, verified independently ---
scripts/checks/instrument-types.d.ts(2,24): error TS2717: …   d.ts rc=2
scripts/checks/sse/broken.ts(1,14): error TS2322: …           sub  rc=2
```

A reviewer reading that transcript sees a green tick, a reconciled census, an
`UNCOVERED` block saying `none`, and has no signal whatsoever.

### B3 — dotfile subjects are skipped silently  ★ HIGH

`shopt -s nullglob` is set (line 218); `dotglob` is not. `*.ts` therefore never
matches `.broken.ts`, `.check-foo.ts`, or a file named exactly `.ts`.

```bash
echo 'export const n: number = "not a number";' > scripts/checks/.broken.ts
bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
#   subjects found 2   subjects compiled 2   type failures 0 …
#   check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.
#   EXIT=0
echo 'export const n: number = "not a number";' > 'scripts/checks/.ts'
#   … PASSED — 2/2 subjects compiled clean.   EXIT=0
```

**Verdict: BREACHED.** Lower severity than B1/B2 only because a hidden
instrument is a less natural thing to write than a `.d.ts` or a subdirectory.

### B4 — `// @ts-nocheck` makes an instrument green, and P-A does not catch it  ★ CRITICAL

R29's rationale says "the cheapest way to make a check compile is to make it
check nothing." R28 forbids `@ts-ignore`, `@ts-expect-error`, `: any`, `as any`,
`as unknown as` — and P-A (03-quality.md §3, run on every phase) greps for
exactly those five. **`@ts-nocheck` is in neither list**, and it is strictly more
powerful than all of them: one line disables the whole file.

```bash
cat > scripts/checks/nocheck-broken.ts <<'EOF'
// @ts-nocheck
export const n: number = "not a number";
export const t: { a: string } = { a: 1, b: 2 };
EOF
bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
```

```
  PASS scripts/checks/nocheck-broken.ts                 exit 0, 0 diagnostics
  subjects found 3   subjects compiled 3   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0
```

```bash
$ printf '+// @ts-nocheck\n' | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
(no match — NOT CAUGHT by R28/P-A)
```

**Verdict: BREACHED**, and this is the one most likely to happen by accident
rather than by attack: it is the obvious move for a phase-3 builder under
pressure to turn six reds green, and every gate in the corpus would wave it
through.

### B5 — the gate pins `tsc` absolutely but not `node`  ★ MEDIUM

Line 135 resolves `TSC="$WEB/node_modules/.bin/tsc"` — a fake `tsc` earlier on
PATH is correctly ignored (attack J1, survived). But that file is a pnpm shim
whose last line is `exec node "$basedir/../typescript/bin/tsc" "$@"` — **`node`
from PATH**.

```bash
printf '#!/bin/sh\nexit 0\n' > /tmp/fakenode/node; chmod +x /tmp/fakenode/node
PATH=/tmp/fakenode:$PATH bash scripts/checks/check-instrument-typecheck.sh; echo "EXIT=$?"
```

```
  node             :                       <-- provenance line 332, EMPTY, unchecked
  PASS scripts/checks/check-classify.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/check-duration.ts                 exit 0, 0 diagnostics
  PASS scripts/checks/zz-broken.ts                      exit 0, 0 diagnostics
  subjects found 3   subjects compiled 3   type failures 0   fidelity violations 0   missing 0
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.
EXIT=0
```

**Verdict: BREACHED.** The precondition (PATH control) is strong, so MEDIUM, not
CRITICAL. What makes it worth fixing is that **the gate printed its own evidence
of the failure and did not read it**: `node : ` came back empty, and the run
continued to a green tick. The non-adversarial version of this is a half-broken
`nvm`/`volta`/`asdf` shim, not an attacker.

### B6 — a degraded profile weakens the checks silently, and dirties the tree  ★ MEDIUM

The gate refuses when the profile is *absent* (G4, survived) and fails loudly
when it is *corrupt* (G2, 30 fidelity violations) or missing `typeRoots` (G1,
survived). It has no defence against a profile that is **valid but weaker**.

```bash
echo '{}' > empty-base.json
# tsconfig.checks-instruments.json: "extends" -> "./empty-base.json"
cat > scripts/checks/strictly-broken.ts <<'EOF'
const s: string = null;
export default s;
EOF
```

| profile | result |
|---|---|
| real | `FAIL scripts/checks/strictly-broken.ts exit 2` → `FAILED`, exit 1 |
| `extends: {}` | `PASS scripts/checks/strictly-broken.ts` → `PASSED — 2/2 subjects compiled clean.`, **exit 0** |

**Verdict: BREACHED.** The mitigation that exists — `profile sha256` in the
provenance block — is a number no reviewer compares against anything.

Two aggravating notes measured during this attack:

1. Losing the base config also loses `"noEmit": true`, so the degraded run
   **wrote `.js` files into the worktree**, violating NF3:
   `scripts/checks/check-classify.js`, `scripts/checks/check-duration.js`,
   `forge-control/src/db/runs.js`, `forge-control/src/lib/dismissals.js`,
   `forge-control/src/lib/run-control-rules.js`,
   `forge-control/src/routes/agents.js`, `agents-shared.js`,
   `forge-control-web/app/desktop/live/agentsApi.js`.
2. The same coupling applies **upward**: the profile inherits from the app's own
   `forge-control-web/tsconfig.json`. Anyone who relaxes `strict` there for an
   unrelated reason silently relaxes the instrument gate, with no signal in the
   transcript. (This is also the root of B1 — `skipLibCheck` was inherited, not
   chosen.)

---

## FINDINGS (fail closed, but move the gate toward lying)

### F1 — the enumeration-failure guard is structurally dead  ★ HIGH

Lines 210-213 promise: *"No `ls`. No `2>/dev/null`. A failure to enumerate is a
refusal, not an empty subject list."* Lines 215-228 implement it as
`if ! LC_ALL=C bash -c '…for g in "$@"; do for f in $g; do printf …' > "$TMP/subjects.nul"`.

A `for` loop over an **empty** glob returns 0. `SUBJECT_GLOBS`' last entry is
`scripts/checks/*.tsx`, which matched nothing in the trimmed tree — so the
subshell's exit status is 0 **regardless of every `printf` having failed**.
Deterministic proof, stdout to `/dev/full`:

```bash
if ! LC_ALL=C bash -c 'cd "$1"||exit 1; shift; shopt -s nullglob
      for g in "$@"; do for f in $g; do printf "%s\0" "$f"; done; done' \
      _ "$PWD" "scripts/checks/*.ts" "scripts/checks/*.tsx" > /dev/full
then echo "guard WOULD fire"; else echo "guard does NOT fire"; fi
```
```
_: line 6: printf: write error: No space left on device
_: line 6: printf: write error: No space left on device
    *** guard does NOT fire: subshell rc=0 despite every write failing ***
```
Reversing the glob order so the last one is non-empty makes the guard fire —
confirming the mechanism exactly.

Consequence, measured on a 100 %-full tmpfs as `TMPDIR`, 31 subjects on disk
including a type-broken one:

```
_: line 6: printf: write error: No space left on device   (×7)
  subjects found   : 24        <-- silently truncated 31 -> 24
```

The subject list was truncated, the enumeration guard stayed silent, and the
census would have reconciled 24/24. **Honest disclosure: this run still exited 1**,
because the same exhausted disk also broke the per-file config write at line 443
and the `ERR` trap fired. I did not achieve a `PASSED` from this path — the
arithmetic does not permit it (the config bytes always exceed the remaining
free bytes after a truncating flush), and I say so rather than claim a breach I
did not get. It is ranked HIGH anyway because the guard is *provably* dead, it is
the exact silent-fallback shape NF1/R16 forbid, and R13's "zero subjects" refusal
is doing work the script credits to a different guard — with a message that
blames an empty directory for a full disk.

With `TMPDIR` merely missing, by contrast, the gate is exemplary:

```
$ TMPDIR=/nope/nope bash scripts/checks/check-instrument-typecheck.sh
mktemp: failed to create directory via template ‘/nope/nope/tmp.XXXXXXXXXX’: No such file or directory
check-instrument-typecheck.sh: ABORTED at line 195 (exit 1) — this run is NOT a pass.
exit=1
```

### F2 — `@ts-ignore` is invisible to the gate, and P-A is diff-scoped

```
  PASS scripts/checks/ignore-broken.ts                  exit 0, 0 diagnostics
check-instrument-typecheck.sh PASSED — 3/3 subjects compiled clean.   EXIT=0
```
No compiler can see through `@ts-ignore`, so this is not a defect in the gate.
It is a defect in the *system*: the only thing standing between the gate and a
suppressed error is P-A's `git diff main...HEAD` grep, which by construction
cannot see a suppression that is already on `main`. R9's own argument — "all four
repetitions of this hole were found by someone compiling a file nobody had
touched in months" — applies verbatim to the suppression check.

### F3 / F4 — hostile filenames that produce *wrong* diagnoses (both still fail closed)

A newline in a subject name splits the diagnostic across lines; the parser reads
the tail as a path outside `scripts/checks/` and prints the "THE PROFILE IS
WRONG, NOT THE APP" essay about a filename:

```
  FAIL scripts/checks/nl-a
         scripts/checks/nl-a
         b.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
  while compiling scripts/checks/nl-a
    b.ts(1,14): error TS2322: …
  subjects found 3   subjects compiled 3   type failures 1   fidelity violations 1   missing 0
exit=1
```
A backslash yields a spurious `diagnostic with NO parseable path — a
config-level error` alongside the correct type failure (exit 1, 1 fidelity
violation). Both fail closed; both would send a maintainer to edit the profile.

### F5 — signal handling

| signal | exit | temp dir |
|---|---|---|
| `SIGINT` | 130 | removed |
| `SIGTERM` | 143 | removed |
| `SIGHUP` | 129 | removed |
| `SIGQUIT` | — | inconclusive, the run had already completed |
| `SIGKILL` | 137 | **leaked** |

`git status --porcelain` stayed clean throughout. The `SIGKILL` leak is inherent
and worth at most a note. `SIGHUP` is not trapped explicitly (lines 196-198 trap
`EXIT`/`INT`/`TERM`) yet cleaned up correctly here; I would not rely on that.

### F6 — TOCTOU

A file created 1 s after the run starts is enumerated by nobody and compiled by
nobody; the run reports `PASSED — 2/2`, exit 0, with `scripts/checks/late-broken.ts`
on disk. The window is the full run, ~55 s on the real directory. Inherent to any
enumerate-then-act gate; ranked LOW because it requires the write to land inside
the window.

### F7 — a broken `.mts`/`.cts` yields PASSED

R10 permits "either cover it or name it", and the gate names it correctly:

```
  UNCOVERED scripts/checks/zz-broken.cts — matched by scripts/checks/*.mts scripts/checks/*.cts,
    not by scripts/checks/*.ts scripts/checks/*.tsx
…
check-instrument-typecheck.sh PASSED — 2/2 subjects compiled clean.   EXIT=0
```

Behaviour matches the requirement, so this is not a gate defect — it is a
**requirement** defect. R10 as written permits the final line to say PASSED and
the exit code to be 0 while a type-broken instrument sits in the directory,
which is precisely the sentence A2 defines as a breach. Naming a file and then
certifying the run green are not compatible.

---

## SURVIVED — the attacks the gate defeated

Each ran with a genuinely type-broken `scripts/checks/zz-broken.ts` present, so a
correct gate must exit non-zero. All did.

**S1 — Symlinks (all six shapes).** Every one fails loudly and, notably, with the
*right* diagnosis.

| shape | result |
|---|---|
| → type-broken file outside `scripts/checks/` | `FAIL … exit 2`, diagnostic reported at the **symlink** path, 0 fidelity violations, exit 1 |
| → `/dev/null` | `MISSING`, census mismatch, exit 1 |
| → a directory | `MISSING`, census mismatch, exit 1 |
| dangling | `MISSING`, census mismatch, exit 1 |
| loop (`a→b→a`) | 2× `MISSING`, census mismatch, exit 1 |
| hard link to a broken file outside | `FAIL … exit 2`, exit 1 |

The `[ ! -f "$abs" ]` test at line 436 plus the R19 `MISSING` path is doing real
work here: it converts every un-compilable shape into a named failure and a
census mismatch, never a skip.

**S2 — Hostile filenames.** All correctly `FAIL`, exit 1, no command injection —
`$(touch /tmp/PWNED).ts` and `` tick`touch /tmp/PWNED2`.ts `` left no `/tmp/PWNED*`
behind. The index-named config plus `json_escape` (lines 347-355) and the
subject reaching `tsc` only inside JSON is the right design and it holds:

`has space.ts` · `-broken.ts` · `--help.ts` · `-p.ts` · `q"uote.ts` ·
`back\slash.ts` (F4) · `$(id).ts` · `` tick`id`.ts `` · `chëck-ünïcode-日本語.ts` ·
200-character name · `x(1,1): error TS9999: y.ts` (the greedy-`.+` bait in
`DIAG_RE` line 141 — resolved to the last `(line,col):`, exactly as the comment
claims) · CRLF · UTF-8 BOM · broken `.tsx`.

**S3 — Compiler output shape.** `--pretty false` holds under everything:
`FORCE_COLOR=3`, `NO_COLOR=1`, `TERM=dumb`, and a real TTY via
`script -qec … /dev/null` (0 ANSI escapes in the captured output). A fake `tsc`
earlier on PATH is ignored — `TSC` is absolute. All exit 1.

**S4 — TMPDIR.** nonexistent → clean `ERR`-trap abort (quoted in F1);
`/tmp/has space dir` → exit 1, correct; read-only → *void as a test*, see
"not run" below.

**S5 — Enumeration environment.** `GLOBIGNORE='*broken*'`, `GLOBIGNORE='*'`,
`IFS=.`, `CDPATH=/tmp`, `LC_ALL`/`LANG` changes, `BASHOPTS=dotglob` (readonly in
this bash) — all exit 1 with the identical 3-subject census.
`env SHELLOPTS=noglob` degrades honestly: the literal globs arrive as subjects,
are recorded `MISSING`, and the census mismatch fires (exit 1) — confusing, but
never a pass.

**S6 — Empty directory (R13).**
```
REFUSING TO RUN: zero subjects matched scripts/checks/*.ts scripts/checks/*.tsx under …
  A gate over nothing certifies nothing. …
exit=1
```

**S7 — Concurrency (NF4).** 2 simultaneous runs, then 10: all ten exited 1 with
byte-identical verdicts (`10 check-instrument-typecheck.sh FAILED — 1 type
failure(s), …`). No interference, no temp-dir collision,
`git status --porcelain` clean.

**S8 — Invocation, cwd and environment matrix.** All exit 1 with the same result:
`cwd=/`, `cwd=/tmp`, `cwd=forge-control-web/`, relative path, `bash -x`,
`HOME` unset, `PATH=/usr/bin:/bin`, `NODE_ENV=production`. `sh` (dash) exits 2
on a syntax error — loud, not a pass. A symlink to the script in `/tmp` refuses:
`REFUSING TO RUN: no compile profile at //tsconfig.checks-instruments.json`.
A deleted cwd exits 1.

**S9 — Git provenance.** Detached `HEAD` → exit 1, correct. `.git` removed
entirely → exit 1, correct, with honest degradation:
```
  git HEAD         : no-git
  git branch       : no-git
```
The gate consults `main` nowhere (`grep -n 'main\b'` hits only comments at lines
33 and 179), so the round-800 manifest guard's dependency on a `main` ref is
genuinely gone and there is nothing there to attack.

**S10 — Fidelity-parser probes (attack-surface item 6).** Both directions held.
A broken module at `forge-control-web/app/scripts/checks/x.ts` — a path that
*contains* but does not *start with* `scripts/checks/` — imported by a covered
instrument produced 1 type failure **and** 1 fidelity violation, exit 1: the
`case "$diag_path" in scripts/checks/*)` prefix match (lines 390-399) cannot be
defeated by a path that merely contains the string. A broken helper in
`scripts/checks/lib/` imported by a covered instrument produced 1 type failure,
0 fidelity violations, exit 1 — correctly attributed to the importer.

**S11 — Mid-run subject deletion (R19).** Deleting `check-classify.ts` 0.4 s in:
`MISSING scripts/checks/check-classify.ts`, `subjects found 37 subjects
compiled 36 … missing 1`, `census mismatch 1`, exit 1. The structural claim at
lines 70-75 is true.

---

## Attacks considered and NOT run, with reasons

- **`chmod 000` on the profile, on a subject, and on `scripts/checks/` itself.**
  Attempted; the result is **void, not a pass**. This box runs as root
  (`id -u` = 0) and `EUID 0` ignores permission bits, so the gate read every file
  normally. Testing this needs an unprivileged user or a restrictive mount; a
  gate run by root can never meet an unreadable file. Flagged rather than
  silently dropped because a future non-root CI runner *will* meet it, and the
  behaviour there is unmeasured.
- **`shopt -s failglob` / `nullglob` injected from outside.** Not exportable
  across `bash -c`; `BASHOPTS` is readonly in this bash (tested, refused).
  `SHELLOPTS=noglob` was run instead as the strongest reachable variant (S5).
- **Pre-creating colliding temp names.** `mktemp -d` is atomic and fails rather
  than reusing an existing directory; there is no way to force a collision
  without root-level `/tmp` manipulation that would equally break every other
  tool on the box. Considered, judged unwinnable, not run.
- **Shallow clone / no `main` ref.** Subsumed by two strictly stronger cases
  already run — detached `HEAD` and a tree with no `.git` at all (S9) — and by
  the grep proving the gate never consults `main`.
- **Hijacking `sha256sum`, `sed`, `git`, `mktemp` via PATH.** Subsumed by B5:
  once PATH is attacker-controlled the verdict is already forfeit. Reported once
  as one finding rather than five times as five.
- **`SIGSTOP`/`SIGCONT`.** Cannot change a verdict, only wall-clock.
- **Tampering inside `node_modules`** (patching `typescript/bin/tsc`, the
  `.d.ts` files of `@types/*`). A gate is entitled to trust its own compiler
  install; an attacker who can write there has already won, and the finding
  would be unactionable.
- **Making `tsc` exit 0 while emitting `error TS`.** Read the code rather than
  attacking it: line 459 requires `[ "$rc" -eq 0 ] && [ -z "$OUT" ]` for a
  `PASS`, so output-without-nonzero-status is already handled. No attack needed;
  recorded so the coverage claim is complete.
- **`x="$(cmd)"` / `local x=$(cmd)` under `set -e`, and `while read` fed by a
  pipe.** Audited by reading (attack-surface item 12). `if OUT="$(…)"; then rc=0;
  else rc=$?; fi` (lines 450-454) captures status correctly; `scan_fidelity`
  accumulates into `FIDELITY`/`FIDELITY_LOG` through a **here-string** (`<<< "$out"`,
  line 405), not a pipe, so the counters survive — a pipe there would have lost
  every fidelity violation. Both are correct as written; no attack was available.

---

## Cleanliness proof

Every experiment above ran in `/tmp/rt-sdBpfz/repo`, a scratch copy. The live
checkout was never touched, and the worktree carries only this evidence file.

```
$ git -C /opt/forge-ai-os status --porcelain
(empty)

$ git status --porcelain        # in the worktree, after the full attack run
?? docs/plan/scripts-checks-typecheck-gate/evidence/phase2-redteam.md
```

The gate's own NF3/NF4/NF2 behaviour, measured in the real worktree at the tip
under review:

```
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/a 2>&1   # exit 1
$ bash scripts/checks/check-instrument-typecheck.sh > /tmp/b 2>&1   # exit 1
$ diff /tmp/a /tmp/b
19c19
<   temp dir         : /tmp/tmp.AEutzNbhCF
---
>   temp dir         : /tmp/tmp.yAgdqHKU2d
85c85
<   wall clock       : 55s
---
>   wall clock       : 54s
```
Exactly the two lines NF2 permits. Temp dirs before = after = 10 (no leak).
`git status --porcelain` empty. Run from `/tmp` by absolute path (I6): identical
PASS/FAIL lines, exit 1.

---

## What the fix cycle must change

Ranked by how far each moves the gate toward lying.

1. **B1** — set `"skipLibCheck": false` in `tsconfig.checks-instruments.json`, or
   exclude `*.d.ts` from `SUBJECT_GLOBS` **and** add it to `UNCOVERED_GLOBS` so
   it is named. Silently counting an unchecked file as compiled is the worst
   outcome available to this gate.
2. **B4** — add `@ts-nocheck` to R28 and to P-A's grep; consider having the gate
   itself refuse a subject containing it, since the gate is the only thing that
   reads every file every run.
3. **B2 + B3** — either recurse (`**/*.ts` with `globstar`, plus `dotglob`), or
   keep the flat glob and add a *coverage* scan that names every
   TypeScript-family file under `scripts/checks/` that the subject globs did not
   match — by depth and by dotfile, not only by extension. The existing
   `UNCOVERED` block is the right shape; its input set is too narrow.
4. **F1** — make the enumeration subshell's failure detectable: `set -o pipefail`
   is not enough, the loop needs an explicit failure flag, or the write needs
   checking after the fact (e.g. compare the NUL count against a second,
   independent count). While it is dead, lines 210-213 assert a guarantee the
   code does not provide.
5. **F7** — amend R10 so that an uncovered TypeScript-family file **fails** the
   run rather than merely being named. Naming is the right *message*; exit 0 is
   the wrong *verdict*.
6. **B5** — resolve `node` absolutely too, or assert that `tsc --version` and
   `node --version` are non-empty and well-formed before trusting a single
   `PASS`. The gate already collects both.
7. **B6** — assert the profile's identity, not just its existence: pin its
   sha256 in the script (or verify `extends` resolves to
   `forge-control-web/tsconfig.json` and that the effective
   `strict`/`skipLibCheck` are what the profile intends) and refuse otherwise.
8. **F3/F4** — cosmetic, but they send a maintainer to edit the wrong file.
   Fold the newline and backslash cases into the fidelity reporter.
