# 02 — Architecture

**Project:** `scripts-checks-typecheck-gate`

Four questions must be answered by any design in this fleet. They are answered
first, in four sentences, and the rest of the document is the evidence.

- **What owns state?** Nothing. The gate is a pure function of the working tree:
  the files on disk, one checked-in tsconfig, and the installed compiler. There
  is no database row, no cache, no incremental build info, no manifest of record.
- **What dispatches work?** A gating reviewer, by hand, running one command —
  the same way universal gate items 1–11 are dispatched today.
- **What happens on failure?** The gate exits non-zero, having printed the full
  compiler output for every failing file and a census that reconciles what it
  found against what it compiled. There is no partial success and no
  disclose-and-continue.
- **How does Konrad see it broke?** The phase does not pass. A gating reviewer
  cannot issue `VERDICT: PASS` with item 9 red, and the transcript naming the
  file and the diagnostic is pasted into the task record verbatim.

---

## 1. Components

Five artifacts. Three are new or rewritten; two are edits to existing text.

| # | Artifact | Status | Owns |
|---|---|---|---|
| A1 | `tsconfig.checks-instruments.json` | **new** | The one compile profile |
| A2 | `scripts/checks/check-instrument-typecheck.sh` | **rewritten** | Enumeration, invocation, census, verdict |
| A3 | `scripts/checks/instrument-manifest.txt` | **repurposed** | The waiver ledger (target: empty) |
| A4 | the six red instruments | **fixed** | Their own assertions |
| A5 | `03-quality.md` §3.1 item 9 + §4 line 859; `phase8-tooling.md` §5 | **amended** | The corpus's account of the gate |

Nothing else changes. No `package.json`, no lockfile, no app source, no
`next.config`, no CI.

---

## 2. Data model

There is one, and it is deliberately trivial.

```
SUBJECT  := a path matched by scripts/checks/*.ts or scripts/checks/*.tsx
WAIVER   := { path, diagnostic, reason, owning-project }   -- from A3
VERDICT  := { subjects_found:int, subjects_compiled:int,
              failures:int, waivers:int, stale_waivers:int, exit:int }
```

`SUBJECT` is derived at run time from the filesystem. It is never stored,
never cached, never diffed against a previous run. That is the entire point:
**a list that is derived cannot go stale, and a list that cannot go stale cannot
silently omit a file.**

`WAIVER` is the one hand-maintained structure, and it exists to make omission
loud. A waiver is a confession, printed on every run.

`VERDICT` is printed, not persisted. The gate is stateless; the task record is
where results live.

---

## 3. The compile profile (A1)

### 3.1 The decision

**Extend `forge-control-web/tsconfig.json`. Override exactly three things.**

> **Amended in phase 1 (round 100), standing rule 2 — where the `//…` comment
> keys sit.** This block originally placed `//jsx`, `//paths` and `//typeRoots`
> *inside* `compilerOptions`. As written it does not compile: `tsc` validates
> the keys of `compilerOptions` against the known options and rejects the rest.
> Measured 2026-08-18, tsc 5.7.2, on a probe copy of the profile:
>
> ```
> zz-probe-base.json(5,5): error TS5025: Unknown compiler option '//jsx'. Did you mean 'jsx'?
> zz-probe-base.json(8,5): error TS5025: Unknown compiler option '//paths'. Did you mean 'paths'?
> zz-probe-base.json(17,5): error TS5025: Unknown compiler option '//typeRoots'. Did you mean 'typeRoots'?
> ```
>
> Three spurious diagnostics and `rc=2` on **every** invocation, which would have
> read out as a census of 0 green / 42 red — including `check-settings-surface.tsx`,
> the file §3.1 exists to take to zero. The three arrays are therefore siblings of
> `"//"`, `extends` and `compilerOptions` at the **top level**, where `tsc` ignores
> unrecognised keys; their text is unchanged and they still sit in reading order
> beside the options they explain. JSONC `//` line comments compile equally clean
> and were rejected: they break `jq`, and R1's verify clause is literally
> `jq -r .extends`. Top-level `"//"`-prefixed keys holding arrays of strings are
> also what the pre-existing `tsconfig.checks.json` already does.
>
> `//cross-reference` is new, and satisfies §3.4's requirement that each of the
> two configs name the other; §3.1's original text mentioned `tsconfig.checks.json`
> only in passing, inside `//jsx`. The block below is the file as committed.

```jsonc
{
  "//": [
    "The ONE compile profile for scripts/checks/*.{ts,tsx}. It extends the web",
    "app's own tsconfig because 27 of the 42 instruments import app modules, and",
    "an instrument gate that disagrees with the app's own compiler about the",
    "app's own files is wrong by construction. Measured 2026-08-18: this profile",
    "takes the directory from 20/42 green to 36/42, and every one of the 6",
    "remaining reds is a genuine defect in the instrument's own source.",
    "",
    "NOT referenced by next.config, by either package's tsconfig, or by any",
    "package.json script. It is a gate input, not a build input."
  ],
  "//jsx": [
    "The app says jsx:preserve because NEXT compiles its JSX. A check script",
    "is executed by tsx, which does not. So the check needs a real transform.",
    "Same reasoning as the pre-existing root tsconfig.checks.json, which this",
    "profile does not replace — that one is tsx's runtime config, this one is",
    "the compiler's."
  ],
  "//paths": [
    "A check script lives in scripts/checks/, which has no node_modules and no",
    "node_modules ancestor up to the repo root, so a bare `react-dom/server`",
    "import resolves NOWHERE regardless of the compiler's cwd.",
    "",
    "These point at @types/ and NOT at the runtime packages, and that is the",
    "whole trick. forge-control-web/node_modules/react is a pnpm symlink into",
    ".pnpm/react@19.0.0/ which ships index.js and no declarations. Mapping to",
    "it resolves the specifier AND defeats the @types/react lookup that would",
    "have supplied the types — producing TS7016 on every app file and then a",
    "TS7026 flood on every JSX tag. Measured: check-settings-surface.tsx =",
    "936 diagnostics under the runtime mapping, 0 under this one.",
    "See evidence/census-B-root-paths-profile.txt vs census-E-*.txt."
  ],
  "//typeRoots": [
    "MUST be pinned. TypeScript's automatic @types discovery walks up from the",
    "directory of the CONFIG FILE, and the gate generates its per-file config",
    "in `mktemp -d`, which has no node_modules ancestry. Without this line the",
    "whole directory collapses with `Cannot find name 'process'`: measured at",
    "12/42 green, 30 red. See evidence/negative-controls.md control (d)."
  ],
  "//cross-reference": [
    "SIBLING FILE, DO NOT MERGE: ./tsconfig.checks.json at this same repo root.",
    "That file is TSX'S RUNTIME CONFIG — its four react paths deliberately point",
    "at the RUNTIME packages (forge-control-web/node_modules/react, react-dom,",
    "…) so that `import ReactDOMServer from 'react-dom/server'` actually LOADS",
    "when tsx executes the instrument. THIS file is TSC'S CONFIG — its four",
    "paths must point at forge-control-web/node_modules/@types/… so that the",
    "DECLARATIONS resolve. Same four specifiers, opposite targets, each correct",
    "for its own consumer. Merging them breaks whichever consumer loses: the",
    "runtime targets cost check-settings-surface.tsx 936 diagnostics under tsc,",
    "and the @types targets have no runtime to load under tsx.",
    "THEY MUST NEVER BE MERGED. See 02-architecture.md §3.4.",
    "",
    "COMMENT-KEY PLACEMENT: the three //jsx, //paths and //typeRoots arrays sit",
    "at the TOP LEVEL, not inside compilerOptions. tsc rejects unknown keys in",
    "compilerOptions with `error TS5025: Unknown compiler option '//jsx'`, which",
    "would add three spurious diagnostics and rc=2 to EVERY invocation. Measured",
    "2026-08-18; recorded in 02-architecture.md §3.1. JSONC `//` line comments",
    "also compile clean but break `jq -r .extends`, which is R1's verify clause."
  ],
  "extends": "./forge-control-web/tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",

    "baseUrl": "./forge-control-web",
    "paths": {
      "@/*": ["./*"],
      "react": ["./node_modules/@types/react"],
      "react/jsx-runtime": ["./node_modules/@types/react/jsx-runtime"],
      "react-dom": ["./node_modules/@types/react-dom"],
      "react-dom/server": ["./node_modules/@types/react-dom/server"]
    },

    "typeRoots": ["./forge-control-web/node_modules/@types"],

    "allowImportingTsExtensions": true,
    "noEmit": true,
    "incremental": false
  },
  "files": [],
  "include": []
}
```

Despite the `jsonc` fence, the file is **strict JSON** and must stay so: R1's
verify clause is `jq -r .extends`, and `jq` does not read JSONC.

`incremental: false` overrides the app's `incremental: true`: an incremental
build writes a `.tsbuildinfo`, and NF3 forbids the gate from writing into the
tree.

`files: []` and `include: []` make the base config compile nothing on its own.
Subjects arrive only through the generated per-file config (§4).

### 3.2 Why not the four alternatives

- **Keep the current flag list and widen it** — rejected in one line: the flags
  are a hand-rolled approximation of the app's tsconfig that drifts from it
  silently. It already has: it is why 13 files were red for `--lib`/`--jsx`
  alone.
- **Two profiles, node-side and web-side** — rejected: measured unnecessary. All
  42 subjects, including the four that import only `forge-control/src` and the
  six that import `pg`/`hono`, are green under the single web-extending profile
  (`evidence/census-E-web-extends-profile.txt`). One profile is one thing to
  keep true.
- **Give `scripts/checks/` its own `package.json` and `node_modules`** —
  rejected: a third install to keep in sync, a lockfile to maintain, and it
  violates NF8 for no gain the `paths` mapping does not already deliver.
- **`tsc --noEmit` over the whole directory in one program** — rejected, and
  this is the round-800 finding restated: one program merges 42 unrelated
  entry points and produces cross-file noise nobody can attribute. R11.

### 3.3 What the profile is NOT allowed to do

If the gate reports a diagnostic located in `forge-control-web/app/**` or
`forge-control/src/**`, **the profile is wrong.** Those trees are green under
`cd forge-control-web && pnpm typecheck`. Success criterion S5 is "exactly zero
such diagnostics," and it is checked by grepping the gate's own output for
paths outside `scripts/checks/`. This is the guard that stops a future
maintainer from "fixing" a profile bug by editing the app.

### 3.4 Naming

`tsconfig.checks-instruments.json`, at the repo root, beside the existing
`tsconfig.checks.json`.

Root, because `extends` and `baseUrl` must reach into `forge-control-web/` and
the subject files live in `scripts/checks/` — root is the only directory above
both, which is the identical argument the existing `tsconfig.checks.json` header
makes for its own placement.

A distinct name, because the two files are genuinely different instruments and
merging them would be a bug: `tsconfig.checks.json` is **tsx's runtime config**
(it makes JSX execute), and its `paths` deliberately point at the **runtime**
react so that `import ReactDOMServer from 'react-dom/server'` actually loads at
run time. `tsconfig.checks-instruments.json` is **tsc's config** and its `paths`
must point at `@types` for exactly the reason §3.1 records. Same four
specifiers, opposite targets, both correct for their own consumer. Phase 1 adds
a cross-reference comment to each file pointing at the other, because the next
person to read one of them will otherwise try to unify them.

---

## 4. The gate (A2)

### 4.1 Control flow

```
0.  set -euEo pipefail; ERR trap that prints "ABORTED … NOT a pass"
       -E because an ERR trap is NOT inherited by functions or subshells
1.  resolve REPO_ROOT, SELF, PROFILE, LEDGER, WEB; export LC_ALL=C
2.  REFUSE unless PROFILE exists                                  → exit 1
3.  REFUSE unless $WEB/node_modules/.bin/tsc exists and is exec   → exit 1
       message carries the exact --prod=false install line        (R17,R18,C3)
3b. resolve node absolutely; REFUSE unless `tsc --version` and
       `node --version` are both well-formed                      → exit 1 (B5)
4.  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT                   (NF3,NF4)
5.  enumerate SUBJECTS := glob scripts/checks/**/*.ts *.tsx,
       globstar + dotglob + nullglob, IN-PROCESS into an array,
       deduplicated: overlapping globs yield a SET, not a bag     (R8,R9,R10)
5b. REFUSE unless an independent `find -L` SET agrees with it,
       naming every file the two differ over, and the symlinked
       ancestor when there is one                                 → exit 1 (F1)
6.  REFUSE if |SUBJECTS| == 0                                     → exit 1 (R13)
7.  COVERAGE scan: every TS-family file under the roots at any
       depth, minus SUBJECTS → name each, and FAIL the run        (R10 amended)
8.  read LEDGER → WAIVERS                                         (R14)
9.  PROVENANCE block: paths, HEAD, branch, sha256 of self and
       profile, tsc/node versions, subject count, invocation shape (R20)
9b. SELF-TEST: three canaries through the same generated-config
       path — strict-null MUST yield TS2322, a .d.ts MUST yield
       TS2717, a clean .tsx MUST compile clean — then assert
       nothing was emitted beside them; REFUSE otherwise    → exit 1 (B1,B5,B6)
9c. SELF-TEST: the suppression scanner MUST report all five
       comment shapes in one canary and MUST NOT report the
       string-literal decoy beside them; REFUSE otherwise   → exit 1 (round 3)
10a. one pass of tsc's OWN PARSER over every subject: the
       directives it honours — commentDirectives (@ts-ignore,
       @ts-expect-error) and checkJsDirective (@ts-nocheck) →
       failure, named by line                                     (R28,B4)
10. for each SUBJECT:
       report the directives step 10a found for it               (R28,B4)
       write $TMP/<n>.json = { extends: <abs PROFILE>, files: [<abs SUBJECT>] }
       run  $WEB/node_modules/.bin/tsc -p $TMP/<n>.json
       record PASS | FAIL + full unfiltered output                (R11,R21)
       compiled++
11. WAIVER RECONCILIATION: a waived subject that compiled clean   → failure (R14)
12. PROFILE FIDELITY: any diagnostic path outside the SUBJECT
       ROOTS (derived from SUBJECT_GLOBS, not inlined)           → failure (S5)
       node_modules/ and hostile-filename cases reported apart    (F3,F4)
13. CENSUS: found vs compiled, both directions                    → failure (R12)
14. verdict line + wall-clock; exit 0 only if every counter is 0  (R22,NF6)
```

Steps 11 and 12 are the two checks the round-800 gate did not have, and both
exist because of something the measurement found rather than something the
design imagined.

**Steps 3b, 5b, 9b, and the failing half of step 7 and step 10, were added at
round 2 fix cycle 1** — every one of them because the red team walked through
where it now stands, not because a second design pass imagined it. Their common
shape is worth naming: round 200 checked its inputs for EXISTENCE (the profile
is there, tsc is there, the glob returned something) and never for BEHAVIOUR.
Step 9b is the correction in one line — the gate watches its compiler fail twice
and succeed once before it is allowed to certify anything.

### 4.2 The generated per-file config

`tsc` has no command-line equivalent of `files`, and — measured — `paths` cannot
be passed on the command line at all: `error TS6064: Option 'paths' can only be
specified in 'tsconfig.json' file`. That single compiler restriction is what
forces the generated-config mechanism, and it is worth stating plainly because
it is the least obvious part of the design.

Each subject therefore gets a two-line config in the run's temp directory:

```json
{ "extends": "/abs/path/tsconfig.checks-instruments.json",
  "files":   ["/abs/path/scripts/checks/check-foo.ts"] }
```

Absolute paths throughout, because the config is not in the repo and relative
resolution from `mktemp -d` would be meaningless. `extends` with an absolute
path is supported and was measured end to end: profile G reproduced profile E's
verdict for all 42 subjects with zero differences
(`evidence/census-G-generated-perfile-config.txt`).

**The trap this mechanism carries** — and the reason `typeRoots` is pinned — is
recorded in §3.1 and re-proven as a negative control. A config outside the repo
loses automatic `@types` discovery, and the failure it produces
(`Cannot find name 'process'`, 30 files red) looks exactly like a broken
codebase rather than a broken config. Anyone who touches `typeRoots` must
re-run the census.

### 4.3 Why the temp directory and not a file in the repo

Writing `forge-control-web/.checks-one.json` would be simpler and is rejected:
it dirties the tree (violating NF3 and universal gate item 3, `git status
--porcelain` empty), it collides between concurrent runs (NF4), and a crashed
run leaves a file that the next `git add -A` publishes. `mktemp -d` plus an
`EXIT` trap costs two lines and has none of those properties.

### 4.4 What was kept from the round-800 gate

The skeleton, deliberately, because it was right: `set -euo pipefail` with an
`ERR` trap that denies the run was a pass; a provenance block before any
verdict; refusal rather than degradation on a missing toolchain; a census
compared in both directions; full unfiltered compiler output per failure. The
round-800 header's enumeration of "what would make this instrument report a pass
wrongly" (a)–(e) is preserved and extended — (b) becomes structural rather than
a per-entry existence test, (c) is replaced by glob coverage, and two new
entries are added for stale waivers and profile fidelity.

### 4.5 What was removed, and the same-commit amendment

Removed: the manifest as an inclusion list, and the manifest guard that compared
`git diff --diff-filter=ACMR main..HEAD -- 'scripts/checks/*.ts'` against it.

The guard was a good answer to the wrong question. It asked "did the author of
this branch remember to add their new file to the list," which is a question
that only exists because there is a list. With glob enumeration there is no
list, so there is nothing to forget: a new instrument is covered the moment it
is written, including one written by someone who never read this document.

Standing rule 2 governs the removal: the guard is described in
`03-quality.md` §3.1 item 9, in `instrument-manifest.txt`'s header, and in
`phase8-tooling.md` §5.1 control (b). All three are amended **in the same commit
that removes it**, with the reasoning inline. Phase 5 owns that, and its
write_set carries all three files for exactly this reason.

### 4.6 The waiver ledger (A3)

`instrument-manifest.txt` keeps its path and inverts its meaning: it listed what
*is* compiled, it now lists what *is not*, and the target is that it lists
nothing.

Format — four required fields per entry:

```
# path        : scripts/checks/check-example.ts
# diagnostic  : TS2345 at line 88 — <verbatim first line of the error>
# reason      : <why it cannot be fixed by the project holding it>
# owner       : <the project or round that will fix it>
scripts/checks/check-example.ts
```

Three properties make it safe:

1. **Every waiver is printed on every run**, in the transcript, above the
   verdict. A waiver cannot be quiet.
2. **A waived file that compiles clean is a FAILURE** ("waived but clean"). Stale
   waivers are the mechanism by which an exclusion list outlives its reason, and
   this closes it.
3. **One subject, one waiver — a path named twice is a LEDGER ERROR** naming both
   line numbers. This is the third property and it was missing until round 501.
   The gate discounts one observed failure per valid entry, so a second entry for
   the same path discounts a failure it does not own: with two broken subjects and
   one of them waived twice, the surplus decrement cancelled the *other* subject's
   failure and the gate printed both failures, `type failures 0`, `PASSED`, exit 0
   — a waiver laundering an unexcused type error into a green run, which is the
   one thing properties 1 and 2 exist to make impossible. Measured at `f30dfdc`
   and closed at round 501; the transcript, before and after, is
   `evidence/phase6-ledger-c4.md`. The second entry is REFUSED, not skipped: a
   silent skip repairs the arithmetic while leaving the author believing the
   ledger says what they wrote.

At completion the ledger holds zero entries and its header says so. It is kept
rather than deleted because deleting it would make the *next* exclusion
invisible — someone would reach for a `--exclude` flag or an `if` in the loop
instead, and that is precisely the shape this project exists to eliminate.

---

## 5. Failure modes

Enumerated as "what would make this gate report a pass wrongly," which is the
only question worth asking of an instrument.

| # | Failure mode | Guard | Proven by |
|---|---|---|---|
| F1 | Glob matches nothing (moved dir, wrong cwd) | refuse if 0 subjects | R13 |
| F2 | A file exists but is skipped | census, found vs compiled, both ways | R12, control (a) |
| F3 | A new instrument escapes coverage | glob is derived, not stored | control (b) |
| F4 | A new *extension* escapes coverage (`.mts`) | explicit uncovered-extension scan | R10 |
| F5 | `tsc: not found`, disclosed and ignored | refuse, print the working install line | R17/R18, control (c) |
| F6 | Wrong install line printed (prod pruning) | line carries `--prod=false`; verified under `NODE_ENV=production` | R18, C3 |
| F7 | `@types` invisible → mass false failures | `typeRoots` pinned; census re-run required if touched | §3.1, control (d) |
| F8 | Profile drifts from the app's tsconfig | `extends`, not a copied flag list | R1, S6 |
| F9 | Gate blames the app for a profile bug | profile-fidelity check: any path outside `scripts/checks/` fails the run | S5 |
| F10 | A waiver outlives its reason | "waived but clean" is a failure | R14 |
| F11 | An instrument is made to compile by making it check nothing | R29 breakage transcripts; R28 suppression grep; R33 red-team on family B | phase 3 |
| F12 | Gate leaves a temp file in the tree | `mktemp -d` + `EXIT` trap; `git status --porcelain` after | NF3 |
| F13 | Two runs interfere | per-run temp dir | NF4 |
| F14 | Gate passes because it never ran (`set -e` abort mid-loop) | `ERR` trap prints "ABORTED … NOT a pass"; final verdict line is the only pass signal | R22 |
| F15 | Corpus keeps describing the old gate | phase 5 write_set carries all three documents; standing rule 2 | R31, R32 |
| F16 | **A duplicate ledger entry launders another subject's failure into a pass** — the gate discounts one failure per valid entry, so N entries naming one failing path discount N failures and the surplus cancels a failure nobody waived | step 8 refuses a path already present in the ledger as a hard LEDGER ERROR naming both lines; step 11 additionally refuses to certify if it would discount one path twice, or if `FAILED + WAIVED` stops equalling what the compile loop observed — both LOUD, both exit 1, neither a skip | C4 in `evidence/phase6-ledger-c4.md`: `PASSED`/exit 0 before, `LEDGER ERROR at line 170 … ALREADY WAIVED at line 164` / exit 1 after; C5 reaches the second layer by deleting the first |

F16 is the failure mode this table was written to catch and did not: F10 guards
the excuse that outlives its error, F16 guards the excuse that was never anyone's
to spend. Both layers are refusals rather than repairs, for the reason F14 gives —
a guard that quietly corrects a count is a guard nobody can see stop working.

F11 deserves its own sentence, because it is the only failure mode no script can
detect. The cheapest way to satisfy a typecheck gate is to delete the assertion
that does not compile. Three independent guards exist — a mechanical grep for
suppressions, a human transcript proving each instrument still fails on a broken
subject, and an adversarial reviewer on the one family where the assertion's
meaning is genuinely in question. None of the three is sufficient alone.

---

## 6. Observability: how progress and breakage are seen

**During the project.** Each phase is a task in the project engine with a round
label; the Kanban shows phase, round and state. Each gating reviewer pastes the
gate's transcript verbatim into the task record. Konrad sees phases advancing;
if one stalls, it stalls red with the compiler output attached.

**After the project.** The gate is universal gate item 9 and is run by every
gating reviewer of every phase of every project on this repo, via
`03-quality.md` §4 line 859. Its transcript answers, without interpretation:
how many instruments exist, how many compiled, which failed and with what, what
is waived and why, and what the gate refused to look at.

**The negative signal that matters most** is not a red gate — it is a gate that
passes while covering less than the directory. The census line
`subjects found N / compiled N` printed against the directory's real file count
is the one number a reader should check, and NF7 requires that it be legible
without reading the source.

---

## 7. The successor project (NG3)

Three directories carry the identical hole and are out of scope. **Amended at
round 500 (R34, A5.5): named in files and lines, re-derived on the tree this
commit ships, not in intentions.**

**How to read the pins (standing rule 1).** Every line number below was
re-resolved by round 500 against the tree it committed. Two of the four files
are UNCHANGED by that commit, so their numbers hold at its parent
`60ca3fc` as well and can be checked today. The two in
`scripts/checks/check-instrument-typecheck.sh` are valid **as of the round-500
commit** — the one that rewrote steps 8 and 11 — which resolves as:

```bash
git log -1 --format=%H -- scripts/checks/instrument-manifest.txt   # the round-500 commit
```

Each pin also carries its SYMBOL, which is what a successor should search for if
a later commit moves the line. A pin that will not resolve is a finding to
report, not a footnote to reinterpret.

#### The uncovered subjects, by name — 11 files, counted on disk at round 500

| Directory | Files | Why uncovered today |
|---|---|---|
| `scripts/` | `scripts/measure-schedule.ts`, `scripts/import-scraper-places.ts` (2) | outside every `include`; the repo root has no `package.json` |
| `forge-control/scripts/` | `probe-usage-router.ts` and **seven** `smoke-*.ts` — `smoke-cron-parser.ts`, `smoke-memory-prefetch.ts`, `smoke-project-pause.ts`, `smoke-project-recovery.ts`, `smoke-skills-curator.ts`, `smoke-thread-compressor.ts`, `smoke-webhook-helpers.ts` (8) | `forge-control/tsconfig.json:15` — `"include": ["src/**/*.ts"]` |
| `forge-control-mcp/scripts/` | `smoke-list-tools.ts` (1) | `forge-control-mcp/tsconfig.json:15` — the same line, the same shape |

*Round 3 of this project said "nine `smoke-*.ts`". There are **seven**;
re-counted at round 500 with `find forge-control/scripts -name '*.ts'`. The
directory also holds `canvas-cli.mjs` and `twenty/mint-api-key.mjs`, which are
`.mjs` and therefore not TypeScript-family files at all — they are neither
subjects nor uncovered.*

#### What the successor changes, line by line

| File:line (pin) | Symbol | Today | What the successor changes it to |
|---|---|---|---|
| `scripts/checks/check-instrument-typecheck.sh:310` *(round-500 commit)* | `SUBJECT_GLOBS` | `SUBJECT_GLOBS=( "scripts/checks/**/*.ts" "scripts/checks/**/*.tsx" )` | append `"scripts/*.ts" "forge-control/scripts/**/*.ts" "forge-control-mcp/scripts/**/*.ts"`. Nothing else in the script moves: the coverage globs, the fidelity prefixes and the `find` second opinion are all derived from this array by `decompose_glob` (the round-3 table below is why). Both glob shapes it supports are represented — `scripts/*.ts` is depth-1 deliberately, so that `scripts/checks/**` is not walked twice. |
| `scripts/checks/check-instrument-typecheck.sh:311` *(round-500 commit)* | `PROFILE` | `PROFILE="$REPO_ROOT/tsconfig.checks-instruments.json"` | **the single variable that must become a path-prefix→profile mapping.** A parallel array or an associative array from prefix to profile path, longest prefix wins, with a REFUSAL — never a default — when a subject matches no prefix, because a subject compiled under a profile nobody chose is the round-800 flag-list drift returning. `write_config` already takes the profile only through `$PROFILE`, so the mapping is read there and in the three canaries of step 9b, which must then run once per distinct profile. |
| `tsconfig.checks-instruments.json` *(unchanged at `60ca3fc`)* | the whole file | `extends: ./forge-control-web/tsconfig.json`; the only profile that exists | keep it, unchanged, for `scripts/checks/`. |
| — (new file, beside the above) | — | — | `tsconfig.checks-node.json`, extending `forge-control/tsconfig.json`, for the three node-side roots. It needs `typeRoots` pinned at `./forge-control/node_modules/@types` for the reason R4 records — automatic `@types` discovery walks up from the *config file's own directory*, and the generated per-file config lives in a temp dir. It does **not** need R2's `jsx` override or R3's four React `paths`: no node-side subject renders JSX. |
| `forge-control/tsconfig.json:15` *(unchanged at `60ca3fc`)* | `"include"` | `"include": ["src/**/*.ts"]` | **unchanged — do not widen it.** Widening it puts eight scripts into the app's own build and its `pnpm typecheck`, which is a different decision with a different owner (NF8, R6: the profile must not be reachable from any build). The successor reaches those files with the gate's glob, exactly as this project reached `scripts/checks/`. |
| `forge-control-mcp/tsconfig.json:15` *(unchanged at `60ca3fc`)* | `"include"` | `"include": ["src/**/*.ts"]` | unchanged, for the same reason. |

**The measurement the successor must take first, because this project did not:**
compile all eleven files above one at a time under the new node-side profile and
count the reds. That number decides whether the successor is a fifteen-line
change or a fix-the-instruments project like this one was. Round 3 of this
project already measured the `scripts/*.ts` half of it — adding that one glob
and nothing else yielded 44 subjects found, 44 compiled, both root scripts green
(`evidence/phase2-fixcycle1-round3.md` §3) — so the open question is the eight
`forge-control/scripts/` files and the one under `forge-control-mcp/`.

It is deliberately not done here: this project's scope is `scripts/checks/`.

The design constraint this imposes on phase 2 is therefore explicit: **the
subject glob and the profile path must each be a single named variable at the
top of the script, not inlined at their point of use.** A successor must be able
to extend coverage by editing two lines.

**Amended round 3 — the constraint was stated and not met.** Round 2 had the
two named variables, and three further copies of `scripts/checks/` derived by
hand, each of which a successor would have had to find and edit as well:

| Copy | What it would have done to a successor | Now |
|---|---|---|
| the fidelity prefix in `scan_fidelity` | every diagnostic in the new root reported as a profile violation, under the "THE PROFILE IS WRONG, NOT THE APP" essay | `ACCEPTED_PREFIXES`, derived from the SUBJECT_GLOBS roots |
| `COVERAGE_GLOBS`' hardcoded roots | R10's safety net silently absent under the new root — the one place that names a file the gate declines to read | derived from the same roots × `TS_EXTENSIONS` |
| the second opinion's root/name cross-product | `scripts/*.ts` added → `find` walks `scripts/checks` twice (44 globbed vs 86 found) → **permanent refusal, no subject compiled** | one `find` per glob, deduplicated by resolved path |

Measured after the fix, by making exactly the edit this section promises —
`SUBJECT_GLOBS=( scripts/checks/**/*.ts scripts/checks/**/*.tsx scripts/*.ts )`
and nothing else: 44 subjects found, 44 compiled, `scripts/measure-schedule.ts`
and `scripts/import-scraper-places.ts` both green, coverage scan and fidelity
prefixes both widened to `scripts/` on their own, exit 1 on the same six reds.
The transcript is in `evidence/phase2-fixcycle1-round3.md` §3.

One list remains hand-maintained, and it is deliberately not a knob for
reaching new directories: `TS_EXTENSIONS` (`ts tsx mts cts`) is the set of
extensions TypeScript HAS. It is edited when the language gains one, not when
this gate gains a directory.

---

## 8. Technology choices, one line each

| Choice | Rationale |
|---|---|
| Bash, not Node | Every other universal gate item is bash; a gate that needs the toolchain it is testing to start is a gate that cannot report a missing toolchain. |
| `tsc` from `forge-control-web/node_modules` | The instruments' heaviest dependency is the web app; using its exact compiler version removes a whole class of "works for me". |
| `extends` the app tsconfig | The only way to stay true to the app's compiler without copying its flags, which is how the current gate drifted. |
| Glob enumeration | A derived list cannot go stale; item 10 (shell lint) already derives rather than lists. |
| One `tsc` per file | Attributable failures; avoids the merged-program noise measured at round 800. |
| Generated config in `mktemp -d` | `paths` cannot be passed on the CLI (TS6064) and the tree must stay clean (NF3). |
| Ledger instead of deletion | Makes the next exclusion loud instead of inventing a quiet one. |
| No CI wiring | Consistent with items 1–11; automating a gate is a separate decision with a separate owner (NG6). |
