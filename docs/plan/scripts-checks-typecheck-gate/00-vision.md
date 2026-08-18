# 00 — Vision: bring `scripts/checks/` under a typecheck gate

**Project:** `scripts-checks-typecheck-gate`
**Branch:** `project/b7ab4c57` off `main`
**Architect round:** 0
**Measured:** 2026-08-18, in this worktree, at git HEAD `9b960ef`

---

## 1. The recommendation, first

**Replace the manifest-scoped, hand-listed, one-option-set typecheck gate with a
glob-enumerated, whole-directory gate driven by ONE checked-in compile profile
that extends `forge-control-web/tsconfig.json`, and fix the eleven genuine type
errors that profile exposes across six instruments.**

That single sentence is the project. Everything below is why, and what "done"
means.

The reason it is one sentence and not three is a measurement, not a preference.
The current gate's difficulty was never the check scripts — it was the compiler
options the gate invents for itself. Under the options
`check-instrument-typecheck.sh` uses today, **22 of the 42 TypeScript
instruments in `scripts/checks/` are red**. Under a profile that extends the web
app's own `tsconfig.json`, **36 of 42 are green with no code change at all**, and
every one of the 11 remaining errors is a real defect in a check script's own
source. The directory was never mostly-broken. It was mostly-miscompiled.

That inverts the project's shape. The brief anticipated a long tail of fixes and
a manifest that grows entry by entry. The measurement says the fix list is
short, closed, and knowable tonight — and that a manifest, once the profile is
right, is no longer protection but a liability: a hand-maintained list is
precisely the thing that can silently omit a file.

---

## 2. The goal, restated precisely

`scripts/checks/` holds the instruments the fleet uses to verify itself: 42
TypeScript files (37 `.ts`, 5 `.tsx`), 10 shell scripts, 5 CommonJS files, 1
Python file, 3 data files. Every phase of every project on this repo is gated by
scripts that live in that directory.

Nothing compiles them.

- `tsx` — how every one of them is executed — **strips types without checking
  them.** A `.ts` file that cannot possibly typecheck runs to completion under
  `tsx` and prints `PASS`.
- `forge-control/tsconfig.json` reads `"include": ["src/**/*.ts"]`. The
  directory is outside it.
- `forge-control-web/tsconfig.json` reads `"include": ["next-env.d.ts",
  "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]` — relative to
  `forge-control-web/`. The directory is outside it too.
- No `package.json` in the repo has a script that compiles anything under
  `scripts/`. (Root has no `package.json` at all.)

So the code that decides whether every other piece of code is correct is the
only code in the repo that no compiler has ever read. This has now been found
**four** times — phase 7's `measure-schedule.ts` (03-quality.md §3.2 "Added
round 212"), phase 6's `forge-control-web/` half ("Added round 223"), phase 6B's
whole-directory measurement, and round 800's manifest scoping — and repaired
zero times at the level of the directory.

Round 802 built `check-instrument-typecheck.sh` as universal gate item 9. It is
a good instrument and this project keeps its skeleton: provenance banner,
per-entry compile, existence test, census in both directions, refusal on a
missing toolchain, refusal on an empty manifest. What it does not do is cover
the directory. It covers **seven files out of forty-two** — the six it measured
green at round 800 plus `check-screenshot-render-shapes.ts` added at round 902.

**This project closes the gap: all 42, enumerated by construction, compiling
clean, with the gate proven to go red when they do not.**

---

## 3. What the measurement actually found

Five compile profiles were measured over all 42 files, one file per invocation,
in this worktree. Raw transcripts are in `evidence/`.

| Profile | What it is | Green | Red |
|---|---|---|---|
| **A** | The gate's options today: `--strict --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022` | 20 | 22 |
| **B** | A + `--lib DOM,DOM.Iterable`, `jsx: react-jsx`, root `paths` → runtime `react` (the `tsconfig.checks.json` shape) | 22 | 20 |
| **C** | B + `types: ["node","react","react-dom"]` | 31 | 11 |
| **E** | `extends forge-control-web/tsconfig.json`, override `jsx: react-jsx`, `paths` → **`@types/*`** | **36** | **6** |
| **G** | E, delivered as a checked-in base config + a per-file config generated in a temp dir — the mechanism the gate will actually use | **36** | **6** |

Profile G is byte-identical in verdict to profile E. The mechanism works.

### 3.1 The three error populations, and why the distinction is the whole design

Profile A's 22 failures are not 22 broken scripts. Sorted by *which file the
error is in*, they fall into three populations:

**Population 1 — the compiler was told the wrong environment.** `TS2584`
("Cannot find name `console`… try changing the `lib` option to include `dom`"),
`TS2304`, `TS2749`, `TS2503`, `TS6142` ("module was resolved to `.tsx` but
`--jsx` is not set"), `TS17004` ("cannot use JSX unless the `--jsx` flag is
provided"). These say nothing about the code. They say the gate compiled a
DOM-touching, JSX-rendering script with `--lib ES2022` and no `--jsx`. **13
files were red for this reason alone.**

**Population 2 — the compiler was told the wrong `react`.** This is the subtle
one, and it is why profile B *increased* the error count on some files while
fixing others. `tsconfig.checks.json` maps `"react"` to
`forge-control-web/node_modules/react` — the **runtime** package, a pnpm symlink
into `.pnpm/react@19.0.0/`, which ships `index.js` and no `.d.ts`. That mapping
does resolve the import, and in doing so it **defeats the normal `@types/react`
lookup that would otherwise have supplied the types.** The result is `TS7016`
("Could not find a declaration file for module `react`") on every app file, and
then `TS7026` ("JSX element implicitly has type `any` because no interface
`JSX.IntrinsicElements` exists") on every JSX tag downstream. `check-settings-surface.tsx`
went from 11 errors under profile A to **936** under profile B — not because it
got worse, but because the JSX finally compiled and had nothing to compile
against. Pointing the same four mappings at `node_modules/@types/react` instead
of `node_modules/react` takes that file to **zero**.

**Population 3 — genuine type errors in `scripts/checks/` source.** Eleven of
them, in six files, in three families. These are the project's actual work, and
§3.2 names every one.

The design consequence is stated once here and enforced everywhere below:

> **An error in `forge-control-web/app/**` reported by this gate is a profile
> bug, not a finding.** Those files are green under
> `cd forge-control-web && pnpm typecheck`. If the instrument gate disagrees
> with the app's own compiler about the app's own files, the instrument gate is
> wrong. The correct profile is not "what flags make it pass" — it is "the
> app's own tsconfig, with the minimum overrides the out-of-tree location
> forces."

Exactly two overrides are forced, and both have a one-line reason:

1. **`jsx: react-jsx`** — the app's `tsconfig.json` says `jsx: "preserve"`
   because Next compiles the JSX. A check script is executed by `tsx`, which
   does not, so the check needs a real JSX transform. (This is the same reason
   the existing root `tsconfig.checks.json` exists; that reasoning survives.)
2. **Four `paths` entries → `@types/react` / `@types/react-dom`** — a check
   script lives in `scripts/checks/`, which has no `node_modules` and no
   `node_modules` ancestor up to the repo root, so a bare `react-dom/server`
   import resolves nowhere no matter what the compiler's cwd is. Pointing at
   the `@types` packages resolves the specifier **and** supplies the
   declarations, which is exactly what pointing at the runtime package failed
   to do.

Plus one mechanical requirement that only shows up when the per-file config is
generated outside the repo: **`typeRoots` must be pinned in the base config**,
because TypeScript's automatic `@types` discovery walks up from the *config
file's* directory, and a config in `mktemp -d` has no `node_modules` ancestry.
Profile F — identical to G but without the pinned `typeRoots` — collapsed to 12
green / 30 red with `Cannot find name 'process'` everywhere. That failure is
recorded in `evidence/` deliberately: it is the trap the next person will hit.

### 3.2 The eleven genuine errors — the complete, closed fix list

**Family A — `TeamRow` drift (7 errors, 4 files).** A `hidesRows` property
became required on `TeamRow`/`XClickInput`, and a `WorkingMsSource` union stopped
admitting `"run"`. Four instruments still construct the old shape:

| File | Line | Error |
|---|---|---|
| `check-team-confirm.ts` | 207 | `TS2345` — `hidesRows` missing from `XClickInput` argument |
| `check-team-rows.ts` | 84 | `TS2322` — `hidesRows?: number \| undefined` vs required `number` |
| `check-dismiss-peek.tsx` | 102 | `TS2322` — `"run"` not assignable to `WorkingMsSource \| null` |
| `check-dismiss-peek.tsx` | 115 | `TS2741` — `hidesRows` missing from `TeamRow` |
| `check-stop-affordance.tsx` | 98 | `TS2322` — `"run"` not assignable to `WorkingMsSource \| null` |
| `check-stop-affordance.tsx` | 111 | `TS2741` — `hidesRows` missing from `TeamRow` |

**Family B — stale role union (3 errors, 1 file).** `check-orientation.ts` lines
129, 133 and 138 assign the literals `"operator_chat"` and `"project_worker"` to
a union that reads `"subagent" | "operator" | "worker" | "cron" | "unknown"`.

This is the single most important finding in the census, and it is **not** a
"fix the type annotation" task. An instrument that asserts on role names the
type no longer admits is an instrument that may be asserting on nothing. Phase 3
treats it as a correctness investigation with an explicit possible outcome of
"this check is vacuous and must be rewritten or retired under standing rule 4",
and it is the one place in this project where a red-team reviewer is mandatory.

**Family C — untyped deep import (2 errors, 1 file).** `serve-sse-808.ts` line
51 imports Hono by the deep path
`../../forge-control/node_modules/hono/dist/index.js`, which resolves to
JavaScript with no declarations (`TS7016`), so its handler parameter `c` is
implicitly `any` (`TS7006`). Its three sibling servers —
`serve-agents-7798.ts`, `serve-quota-7799.ts`, `serve-v3-7798.ts` — are green;
whatever they do is the model to copy.

There is no fourth family. The list is closed.

---

## 4. Definition of done

The project is done when **all seven** of these hold simultaneously, on the
committed tree, verified by a gating reviewer who ran the commands themselves:

- **DoD-1 — Coverage is total and structural.**
  `bash scripts/checks/check-instrument-typecheck.sh` compiles **every**
  `scripts/checks/*.ts` and `scripts/checks/*.tsx` present on disk, enumerated
  by glob at run time. Adding a new file to the directory places it under the
  gate with no edit to any list.
- **DoD-2 — Every instrument compiles clean.** 42/42 exit 0 with zero
  diagnostics. Zero exclusions, or every exclusion carried in the waiver ledger
  with a named reason and a named owner (§5, R14).
- **DoD-3 — The gate is proven to fail.** Three deliberate breakages, each
  transcribed with its full output in
  `docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`: a
  broken type in a covered file; a new file added to the directory carrying a
  type error (proving glob coverage, not just glob enumeration); and a tree with
  no `forge-control-web/node_modules`. Each must exit non-zero and name the
  offending file.
- **DoD-4 — The gate cannot pass vacuously.** It refuses, non-zero, on: zero
  files enumerated; a compiler it cannot find; a census whose "files found" and
  "files compiled" counts disagree in either direction. No silent skip, no
  disclosed-and-continued error, anywhere in the script (NF1).
- **DoD-5 — The eleven errors are fixed at the source, not silenced.** No `any`,
  no `as unknown as`, no `@ts-expect-error`, no `@ts-ignore` introduced by this
  project. Each fix preserves what the instrument asserts, and the reviewer
  confirms each fixed instrument still runs green under `tsx` and still fails
  when its subject is broken.
- **DoD-6 — The corpus tells the truth.** `03-quality.md` §3.1 item 9 and its §4
  command block, `instrument-manifest.txt`'s header, and
  `evidence/phase8-tooling.md` §5 all describe the gate that now exists. Every
  claim in them that the measurement contradicts is corrected in the same commit
  as the code that contradicts it (standing rule 2).
- **DoD-7 — It survives a cold worktree.** On a checkout with no
  `node_modules`, the documented install line followed by the gate produces
  42/42 green. The reviewer performs this from a clean clone or a stashed
  `node_modules`, not from the warm tree they have been working in.

---

## 5. Measurable success criteria

| # | Criterion | How it is measured | Target |
|---|---|---|---|
| S1 | Instrument coverage | files enumerated by the gate ÷ `ls scripts/checks/*.ts scripts/checks/*.tsx \| wc -l` | 42/42 = 100% |
| S2 | Compile cleanliness | gate exit code, and its own failure count | exit 0, 0 failures |
| S3 | Genuine errors resolved | the 11 in §3.2, re-measured | 11/11, 0 suppressions |
| S4 | Negative controls | breakages that produce a non-zero exit naming the file | 3/3 |
| S5 | Profile fidelity | gate diagnostics located in `forge-control-web/app/**` | exactly 0 |
| S6 | App unaffected | `cd forge-control-web && pnpm typecheck` before vs after | exit 0 both, no new diagnostics |
| S7 | Lockfile untouched | `git diff main -- '**/package.json' '**/pnpm-lock.yaml'` | empty (NFU8) |
| S8 | Cold-tree reproducibility | DoD-7 run | 42/42 green |
| S9 | Runtime preserved | each fixed instrument under `tsx` | same verdict as before the fix |
| S10 | Gate wall-clock | `time bash scripts/checks/check-instrument-typecheck.sh` | recorded; a regression past ~4× the round-800 baseline is a finding, not a failure |

S10 is a recorded number, not a pass/fail bar. 42 separate `tsc` invocations,
each loading the web app's full program, is not free — measured tonight at
roughly 4–10s per file. If that lands somewhere intolerable, the answer is
recorded as a finding for a follow-up project (batching by population), **not**
a silent narrowing of coverage. Narrowing coverage to buy speed would rebuild
the exact hole this project exists to close.

---

## 6. Explicit non-goals

- **NG1 — Fixing `forge-control-web/app/**` or `forge-control/src/**`.** If the
  gate reports an error in an app file, the profile is wrong; fix the profile.
  The only exception is if the app's own `pnpm typecheck` also reports it, which
  would be a pre-existing defect to report, not to repair here.
- **NG2 — Type-checking the 5 `.cjs`, 10 `.sh` and 1 `.py` files.** "Typecheck"
  means TypeScript. Shell is already covered by universal gate item 10 (shell
  lint); `.cjs` and `.py` are out of scope and stay out. `checkJs` over the
  `.cjs` files is a defensible follow-up project and is named as one here so
  nobody mistakes its absence for an oversight.
- **NG3 — Other untyped `.ts` outside this directory.** `scripts/*.ts`
  (`measure-schedule.ts`, `import-scraper-places.ts`),
  `forge-control/scripts/*.ts` (nine `smoke-*.ts` plus `probe-usage-router.ts`)
  and `forge-control-mcp/scripts/smoke-list-tools.ts` sit outside every
  `include` list too. Same hole, different directory. **This project's design
  must make covering them a configuration change and not a rewrite** — but it
  does not cover them, and 02-architecture.md §7 records how the successor
  extends it.
- **NG4 — Changing what any instrument asserts.** Fixes make existing assertions
  compile. The one place this may not hold is family B, where the assertion may
  already be meaningless; there the change is deliberate, argued, adversarially
  reviewed, and cited under standing rule 4.
- **NG5 — Installing, upgrading or adding any dependency.** `--frozen-lockfile`
  throughout. S7 is the check.
- **NG6 — Wiring the gate into CI or a `package.json` script.** It is a
  reviewer-run gate, consistent with items 1–11 of §3.1. Automating it is a
  different decision with a different owner.
- **NG7 — Touching `/opt/forge-ai-os`.** Worktree-only until the deploy phase,
  which has its own briefed procedure.

---

## 7. Why this is worth a project

A gate that covers 7 of 42 files and reports `PASSED` is worse than no gate,
because it converts "nobody checked" into "somebody checked and it was fine."
Round 800 scoped it to seven honestly, in the open, with the reasoning inline —
and it explicitly named closing the rest as another project's job. This is that
project.

The finding that justifies the whole exercise is family B. `check-orientation.ts`
runs green today. It has run green for every round since the role union was
renamed underneath it. A human reading the fleet's output would have seen it
pass. The compiler needs three seconds to see that it is asserting on values
that cannot exist.

That is what nobody compiling the instruments costs.
