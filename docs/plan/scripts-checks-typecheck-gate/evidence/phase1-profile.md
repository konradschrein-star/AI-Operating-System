# Phase 1 — the compile profile: U1–U6 transcripts

**Project:** `scripts-checks-typecheck-gate` · **Phase 1**, round label 100
**Deliverables proven here:** D1.1 `tsconfig.checks-instruments.json`,
D1.2 the cross-reference in `tsconfig.checks.json`, D1.3 `reproduce-census.sh`.
**Tests:** `03-quality.md` §2.1 U1–U6, plus R5's substitute proof.

Every section below carries the command, its real output and its exit code.
Nothing here is prose standing in for a transcript.

---

## 0. Provenance

Round 0 measured on tsc 5.7.2 / node 22 / pnpm 9.15.9 at HEAD `9b960ef`. This
phase measured on the same compiler and the same runtime, at HEAD `b74ecb2`
(three planning commits later; no instrument changed between them).

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 956ms using pnpm v9.15.9

$ cd forge-control && pnpm install --frozen-lockfile --prefer-offline --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 880ms using pnpm v9.15.9

$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
$ node --version
v22.22.2
$ pnpm --version
9.15.9
$ git rev-parse HEAD
b74ecb26a68ed2ebb0baf929ef14ad160aee7a0c
$ git rev-parse --abbrev-ref HEAD
project/b7ab4c57
```

`--prod=false` is not optional: the runtime exports `NODE_ENV=production`, under
which `pnpm install --frozen-lockfile` prunes devDependencies, **exits 0**, and
removes `tsc` — after which the census dies with `tsc: not found` while the
install transcript looks clean.

The census script prints its own provenance to stderr on every run, so no
transcript below can be read without its toolchain:

```
════════ provenance
repo root : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5
profile   : /opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/tsconfig.checks-instruments.json
sha256    : eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e
tsc       : Version 5.7.2
node      : v22.22.2
HEAD      : b74ecb26a68ed2ebb0baf929ef14ad160aee7a0c
branch    : project/b7ab4c57
subjects  : 42 (expected 42)
invocation: one tsc -p <generated config> per subject
════════ census
```

---

## 0.1 The one correction to the corpus: TS5025

`02-architecture.md` §3.1 placed its three explanatory comment arrays — `//jsx`,
`//paths`, `//typeRoots` — **inside** `compilerOptions`. As literally written the
profile does not compile: `tsc` validates the keys of `compilerOptions` and
rejects unknown ones. Reproduced here independently of the planner, on a probe
copy of the profile rebuilt into the as-written shape inside `mktemp -d`,
compiling `check-settings-surface.tsx` — a file that **must** be green:

```
$ forge-control-web/node_modules/.bin/tsc -p "$T/one.json"
zz-probe-base.json(4,5): error TS5025: Unknown compiler option '//jsx'. Did you mean 'jsx'?
zz-probe-base.json(13,5): error TS5025: Unknown compiler option '//paths'. Did you mean 'paths'?
zz-probe-base.json(45,5): error TS5025: Unknown compiler option '//typeRoots'. Did you mean 'typeRoots'?
exit=2
```

(The line numbers differ from the planner's 5/8/17 only because the probe was
reconstructed programmatically with a different key layout; the three codes, the
three keys and `rc=2` are identical.)

Three spurious diagnostics and `rc=2` on **every** invocation. Left uncorrected
the census would have read 0 green / 42 red and proven nothing.

**The fix, also measured:** the three arrays are hoisted to the **top level**,
siblings of `"//"`, `extends` and `compilerOptions`, where `tsc` ignores
unrecognised keys. Text verbatim, reading order preserved. JSONC `//` line
comments compile equally clean and were rejected — they break `jq`, and R1's
verify clause is literally `jq -r .extends`. Top-level `"//"`-prefixed keys
holding arrays of strings are what the pre-existing `tsconfig.checks.json`
already does.

`02-architecture.md` §3.1 is amended in the same commit (standing rule 2), and
its block is now byte-identical to the committed file:

```
$ awk '/^```jsonc$/{f=1;next} /^```$/{if(f){exit}} f' \
    docs/plan/scripts-checks-typecheck-gate/02-architecture.md > /tmp/doc-block.json
$ jq -r .extends /tmp/doc-block.json
./forge-control-web/tsconfig.json
jq exit=0
$ diff /tmp/doc-block.json tsconfig.checks-instruments.json
DOC BLOCK IS BYTE-IDENTICAL TO THE REAL FILE
```

A builder who copies that block verbatim now gets a working profile. That was
the failure standing rule 2 exists to stop.

---

## U1 — the census over all 42 subjects

**Expected:** 36 green / 6 red, matching `census-G-generated-perfile-config.txt`
exactly.

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
check-browser-shots.ts                         rc=0   errors=0   
check-classify.ts                              rc=0   errors=0   
check-close-gate.ts                            rc=0   errors=0   
check-composer-v3.ts                           rc=0   errors=0   
check-duration.ts                              rc=0   errors=0   
check-fix-chain-graph.ts                       rc=0   errors=0   
check-gemini-tally.ts                          rc=0   errors=0   
check-nav-stack.ts                             rc=0   errors=0   
check-orientation.ts                           rc=2   errors=3   
check-plan-api.ts                              rc=0   errors=0   
check-plan-store.ts                            rc=0   errors=0   
check-project-metadata.ts                      rc=0   errors=0   
check-quota-row.ts                             rc=0   errors=0   
check-r1871-chat.ts                            rc=0   errors=0   
check-r1873-fixes.ts                           rc=0   errors=0   
check-r1875-fixes.ts                           rc=0   errors=0   
check-run-control-client.ts                    rc=0   errors=0   
check-screenshot-render-shapes.ts              rc=0   errors=0   
check-secret-events.ts                         rc=0   errors=0   
check-secret-requests.ts                       rc=0   errors=0   
check-secret-scan.ts                           rc=0   errors=0   
check-story-digest.ts                          rc=0   errors=0   
check-subagent-slice.ts                        rc=0   errors=0   
check-task-api.ts                              rc=0   errors=0   
check-team-confirm.ts                          rc=2   errors=1   
check-team-rows.ts                             rc=2   errors=1   
check-thread-mapping.ts                        rc=0   errors=0   
check-tool-summary.ts                          rc=0   errors=0   
check-typing-memo.ts                           rc=0   errors=0   
check-ui-prompt.ts                             rc=0   errors=0   
check-usage-fold.ts                            rc=0   errors=0   
check-working-sql-agreement.ts                 rc=0   errors=0   
check-working-time.ts                          rc=0   errors=0   
serve-agents-7798.ts                           rc=0   errors=0   
serve-quota-7799.ts                            rc=0   errors=0   
serve-sse-808.ts                               rc=2   errors=2   
serve-v3-7798.ts                               rc=0   errors=0   
check-chat-rich.tsx                            rc=0   errors=0   
check-dismiss-peek.tsx                         rc=2   errors=2   
check-integrations.tsx                         rc=0   errors=0   
check-settings-surface.tsx                     rc=0   errors=0   
check-stop-affordance.tsx                      rc=2   errors=2   
exit=0

(stderr) green 36 / red 6 / total 42
```

**The diff against round 0, which is the whole point of this phase:**

```
$ diff <(bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh) \
       docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
DIFF EMPTY
```

Byte-exactness of the layout, independently checked:

```
$ awk '{print length($0)}' /tmp/census-run1.txt | sort -u
65
```

A single line reading `65`: every one of the 42 rows is exactly 65 characters,
trailing spaces included, as `census-G` is.

The tree is untouched by the run — no generated config ever lands in the repo
(NF3):

```
$ git status --porcelain
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M tsconfig.checks.json
?? docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
?? tsconfig.checks-instruments.json
```

Only this phase's own deliverables. No stray `*.json` from any invocation.

**A1.1 note — `check-chat-rich.tsx`.** The project's one-line brief also names
`check-chat-rich.tsx` as red. It is not, and it never was under this profile:
census G records it `rc=0 errors=0` and so does this reproduction. That claim
descends from the older round-800 measurement taken under the gate's flag list
(profile A), not under profile E/G. The six files below are authoritative.

---

## U2 — the six red files, full diagnostics

**Expected:** exactly the eleven diagnostics of `00-vision.md` §3.2 — same
codes, same lines.

Emitted unfiltered by `reproduce-census.sh` on stderr:

```
════════ full diagnostics — every failing subject, unfiltered (U2)
════════ check-orientation.ts
scripts/checks/check-orientation.ts(129,38): error TS2322: Type '"operator_chat"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
scripts/checks/check-orientation.ts(133,7): error TS2322: Type '"project_worker"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
scripts/checks/check-orientation.ts(138,23): error TS2322: Type '"project_worker"' is not assignable to type '"subagent" | "operator" | "worker" | "cron" | "unknown"'.
════════ check-team-confirm.ts
scripts/checks/check-team-confirm.ts(207,30): error TS2345: Argument of type '{ nodeId: string; settled: false; armed: ArmedState | null; nowMs: number; canTerminate: boolean; }' is not assignable to parameter of type 'XClickInput'.
  Property 'hidesRows' is missing in type '{ nodeId: string; settled: false; armed: ArmedState | null; nowMs: number; canTerminate: boolean; }' but required in type 'XClickInput'.
════════ check-team-rows.ts
scripts/checks/check-team-rows.ts(84,3): error TS2322: Type '{ node: TeamNode; depth: number; parentDescription: string | null; hidesRows?: number | undefined; displayWorkingMs: number | null; }' is not assignable to type 'TeamRow'.
  Types of property 'hidesRows' are incompatible.
    Type 'number | undefined' is not assignable to type 'number'.
      Type 'undefined' is not assignable to type 'number'.
════════ serve-sse-808.ts
scripts/checks/serve-sse-808.ts(51,22): error TS7016: Could not find a declaration file for module '../../forge-control/node_modules/hono/dist/index.js'. '/opt/ai-os/workspace/projects/b7ab4c57-7ebd-4ef5-a7e3-9345941467c5/forge-control/node_modules/hono/dist/index.js' implicitly has an 'any' type.
scripts/checks/serve-sse-808.ts(90,21): error TS7006: Parameter 'c' implicitly has an 'any' type.
════════ check-dismiss-peek.tsx
scripts/checks/check-dismiss-peek.tsx(102,5): error TS2322: Type '"run"' is not assignable to type 'WorkingMsSource | null'.
scripts/checks/check-dismiss-peek.tsx(115,3): error TS2741: Property 'hidesRows' is missing in type '{ node: TeamNode; depth: number; parentDescription: string; displayWorkingMs: number | null; }' but required in type 'TeamRow'.
════════ check-stop-affordance.tsx
scripts/checks/check-stop-affordance.tsx(98,5): error TS2322: Type '"run"' is not assignable to type 'WorkingMsSource | null'.
scripts/checks/check-stop-affordance.tsx(111,3): error TS2741: Property 'hidesRows' is missing in type '{ node: TeamNode; depth: number; parentDescription: string; displayWorkingMs: number | null; }' but required in type 'TeamRow'.
════════ summary
green 36 / red 6 / total 42
```

Checked mechanically against round 0's own capture rather than by eye:

```
$ diff /tmp/u2-actual.txt docs/plan/scripts-checks-typecheck-gate/evidence/residual-errors-profile-G.txt
U2 DIFF EMPTY
```

Reconciled against `00-vision.md` §3.2:

| File | Line | Code | §3.2 family |
|---|---|---|---|
| `check-orientation.ts` | 129 | TS2322 | B — stale role union |
| `check-orientation.ts` | 133 | TS2322 | B |
| `check-orientation.ts` | 138 | TS2322 | B |
| `check-team-confirm.ts` | 207 | TS2345 | A — `TeamRow` drift |
| `check-team-rows.ts` | 84 | TS2322 | A |
| `serve-sse-808.ts` | 51 | TS7016 | C — untyped deep import |
| `serve-sse-808.ts` | 90 | TS7006 | C |
| `check-dismiss-peek.tsx` | 102 | TS2322 | A |
| `check-dismiss-peek.tsx` | 115 | TS2741 | A |
| `check-stop-affordance.tsx` | 98 | TS2322 | A |
| `check-stop-affordance.tsx` | 111 | TS2741 | A |

Eleven, in six files, in three families. The list is closed and unchanged.

---

## U3 — profile fidelity: zero diagnostics outside `scripts/checks/`

**Expected:** empty. A diagnostic in `forge-control-web/app/**` or
`forge-control/src/**` means the profile is wrong (02-architecture.md §3.3) —
and the fix is the profile, never the app.

Every distinct path the census produced a diagnostic for:

```
$ grep -oE '^[^ (]+\([0-9]+,[0-9]+\): error TS' /tmp/census-run1.err | sed 's/(.*//' | sort -u
scripts/checks/check-dismiss-peek.tsx
scripts/checks/check-orientation.ts
scripts/checks/check-stop-affordance.tsx
scripts/checks/check-team-confirm.ts
scripts/checks/check-team-rows.ts
scripts/checks/serve-sse-808.ts
```

Six paths, all six under `scripts/checks/`. The exclusion, stated as the grep
S5 actually specifies:

```
$ grep -v '^scripts/checks/' /tmp/u3-paths.txt
(no output)
grep exit=1        # 1 = no matches = EMPTY = PASS
```

And directly against the two forbidden trees, over the full unfiltered output:

```
$ grep -nE 'forge-control-web/app/|forge-control/src/' /tmp/census-run1.err | grep 'error TS'
(no output)
grep exit=1        # EMPTY = PASS
```

---

## U4 — the app's own typecheck is unaffected

**Expected:** exit 0, output byte-identical to the pre-project run.

Captured **before** any file was created or edited:

```
$ cd forge-control-web && pnpm typecheck > /tmp/web-typecheck-before.txt 2>&1; echo "exit=$?"
exit=0
$ cat /tmp/web-typecheck-before.txt

> forge-control-web@0.1.0 typecheck /opt/ai-os/.../forge-control-web
> tsc --noEmit

```

Re-run after all of phase 1's changes were in place:

```
$ cd forge-control-web && pnpm typecheck > /tmp/web-typecheck-after.txt 2>&1; echo "exit=$?"
exit=0
$ diff /tmp/web-typecheck-before.txt /tmp/web-typecheck-after.txt
U4 DIFF EMPTY — byte-identical
$ sha256sum /tmp/web-typecheck-before.txt /tmp/web-typecheck-after.txt
5546b0b40a0d1db2cd8cb6b1c99fe831d1ae1f895247c9b7c774714f2d5c356a  /tmp/web-typecheck-before.txt
5546b0b40a0d1db2cd8cb6b1c99fe831d1ae1f895247c9b7c774714f2d5c356a  /tmp/web-typecheck-after.txt
```

Same hash. R7 and A1.3 satisfied. This is the expected result and it is not an
accident: the profile is not reachable from the app's compile (see R6 below), so
it cannot influence it.

---

## U5 — `typeRoots` is load-bearing (MANDATORY)

U5 is a test of the profile's **own comment**. `//typeRoots` claims the line is
load-bearing and quantifies the collapse; a claim nobody re-checks decays into
folklore. This is the check.

Method: the profile was edited in place and reverted, with a pristine copy held
outside the repo and the restoration proven by hash. Only the `typeRoots`
*option* line was removed; the `//typeRoots` comment array stayed, so the file
under test differs from the committed one by exactly one line.

### U5a — removal

```
$ sha256sum tsconfig.checks-instruments.json
eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e  tsconfig.checks-instruments.json
$ cp tsconfig.checks-instruments.json /tmp/profile-pristine.json
$ grep -n '"typeRoots"' tsconfig.checks-instruments.json
75:    "typeRoots": ["./forge-control-web/node_modules/@types"],
$ sed -i '/^    "typeRoots": \["\.\/forge-control-web\/node_modules\/@types"\],$/d' tsconfig.checks-instruments.json
$ grep -c '^    "typeRoots"' tsconfig.checks-instruments.json
0
$ jq -r .extends tsconfig.checks-instruments.json
./forge-control-web/tsconfig.json          # still valid JSON — the collapse is not a parse error
```

Census without it:

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
check-browser-shots.ts                         rc=2   errors=2   
check-classify.ts                              rc=0   errors=0   
check-close-gate.ts                            rc=2   errors=16  
check-composer-v3.ts                           rc=2   errors=1   
check-duration.ts                              rc=2   errors=1   
check-fix-chain-graph.ts                       rc=2   errors=16  
check-gemini-tally.ts                          rc=0   errors=0   
check-nav-stack.ts                             rc=2   errors=1   
check-orientation.ts                           rc=2   errors=5   
check-plan-api.ts                              rc=0   errors=0   
check-plan-store.ts                            rc=2   errors=6   
check-project-metadata.ts                      rc=0   errors=0   
… (30 more rows)

(stderr) green 12 / red 30 / total 42
```

**12 green / 30 red — exactly profile F of `round0-probes.md` §1.2.**

The twelve survivors, which are precisely the instruments that touch no node
built-in and no `@types` package:

```
check-classify.ts               check-project-metadata.ts   check-usage-fold.ts
check-gemini-tally.ts           check-screenshot-render-shapes.ts  serve-agents-7798.ts
check-plan-api.ts               check-story-digest.ts       serve-v3-7798.ts
                                check-task-api.ts           check-integrations.tsx
                                check-ui-prompt.ts
```

`check-close-gate.ts` — green under the intact profile, and named in
`round0-probes.md` §1.2 as the sample — collapses like this:

```
════════ check-close-gate.ts
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(75,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(76,27): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(77,28): error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(78,31): error TS2307: Cannot find module 'node:url' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(92,10): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(107,31): error TS2534: A function returning 'never' cannot have a reachable end point.
```

`Cannot find module 'node:fs'` and `Cannot find name 'process'`, exactly as
§1.2 recorded. **This is the trap, and it is why the comment is worded as an
instruction rather than an observation:** the failure impersonates a broken
codebase. A maintainer meeting these 30 reds would reasonably conclude the
instruments are broken — when the only thing broken is that a config generated
in `mktemp -d` has no `node_modules` ancestry to walk up, so automatic `@types`
discovery finds nothing at all.

### U5b — restoration

```
$ cp /tmp/profile-pristine.json tsconfig.checks-instruments.json
$ sha256sum tsconfig.checks-instruments.json
eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e  tsconfig.checks-instruments.json
   expected: eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e
$ diff /tmp/profile-pristine.json tsconfig.checks-instruments.json
BYTE-IDENTICAL TO PRE-REMOVAL FORM
$ grep -n '"typeRoots": \["\./forge-control-web' tsconfig.checks-instruments.json
75:    "typeRoots": ["./forge-control-web/node_modules/@types"],
```

Census after restoration:

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
(stderr) green 36 / red 6 / total 42
$ diff <(…) docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
RESTORED CENSUS DIFF vs census-G: EMPTY
$ git status --porcelain
 M docs/plan/scripts-checks-typecheck-gate/02-architecture.md
 M tsconfig.checks.json
?? docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
?? tsconfig.checks-instruments.json
```

Restored, re-verified against round 0, tree clean of strays. 36 → 12 → 36.

---

## U6 — determinism (NF2)

**Expected:** two runs, identical verdicts.

```
$ bash …/reproduce-census.sh > /tmp/census-run1.txt 2>/tmp/census-run1.err ; echo exit=$?
exit=0
$ bash …/reproduce-census.sh > /tmp/census-run2.txt 2>/tmp/census-run2.err ; echo exit=$?
exit=0
$ diff /tmp/census-run1.txt /tmp/census-run2.txt
U6 STDOUT DIFF EMPTY — identical
$ diff /tmp/u6a.txt /tmp/u6b.txt     # the full-diagnostics section of each run's stderr
U6 STDERR DIAGNOSTICS DIFF EMPTY
```

Both the census table and the full diagnostic text are reproducible. The only
thing that varies between runs is the `mktemp -d` path, which never appears on
stdout and never appears in a diagnostic, because the generated config names
its subject by absolute path and `tsc` reports the subject, not the config.

---

## R5 — the `@/*` alias resolves (substitute proof)

R5 requires that instruments importing app modules by the `@/` alias compile.
**No instrument uses the alias today** — every one of the 27 that import app
modules does so by relative path (`../../forge-control-web/app/…`). R5's own
clause covers this: *"if no instrument uses the alias today, the reviewer
confirms the alias resolves by compiling a throwaway file that uses it, and
records that transcript."* This is that transcript. It is a substitute proof,
not a census subject.

The throwaway was created in `mktemp -d` and never in the repo:

```typescript
// $T/r5-alias-probe.ts
import { fmtWorkingTime, fmtTokens } from "@/app/desktop/team/teamApi";
import type { TeamNodeKind } from "@/app/desktop/team/teamApi";

const kind: TeamNodeKind = "subagent";
const label: string = `${kind} ${fmtWorkingTime(1234)} ${fmtTokens(5678)}`;
console.log(label);
```

```
$ cat "$T/r5.json"
{ "extends": "/opt/ai-os/.../tsconfig.checks-instruments.json",
  "files":   ["/tmp/tmp.dshzrh1AsK/r5-alias-probe.ts"] }
$ forge-control-web/node_modules/.bin/tsc -p "$T/r5.json"
exit=0
```

Zero diagnostics: the alias resolved, the named exports were found, and their
types were checked (a value import and a type import, both used, so neither is
elided).

**Negative control — because exit 0 alone cannot distinguish "resolved" from
"silently ignored".** The same file with the alias pointed at a module that does
not exist:

```
$ forge-control-web/node_modules/.bin/tsc -p "$T/r5neg.json"
…/r5-neg.ts(5,43): error TS2307: Cannot find module '@/app/desktop/team/teamApi-NOPE' or its corresponding type declarations.
…/r5-neg.ts(6,35): error TS2307: Cannot find module '@/app/desktop/team/teamApi-NOPE' or its corresponding type declarations.
exit=2
```

The compiler genuinely attempted the resolution and reported failure when it
could not — so the clean run above was a real resolution, not an unchecked
import. `$T` was removed and `git status --porcelain` showed no stray.

---

## D1.2 — the cross-reference, and that it did not break the runtime config

`tsconfig.checks.json` gains a cross-reference block appended to its existing
`"//"` array. Nothing existing was disturbed:

```
$ jq . tsconfig.checks.json > /dev/null ; echo "jq exit=$?"
jq exit=0
$ diff <(git show main:tsconfig.checks.json | jq -S .compilerOptions) <(jq -S .compilerOptions tsconfig.checks.json)
compilerOptions IDENTICAL to main
$ diff <(git show main:tsconfig.checks.json | jq -S '.["//paths"]') <(jq -S '.["//paths"]' tsconfig.checks.json)
//paths IDENTICAL to main
$ N=$(git show main:tsconfig.checks.json | jq -r '.["//"] | length')   # 14
$ diff <(git show main:tsconfig.checks.json | jq -c ".[\"//\"][0:$N][]") <(jq -c ".[\"//\"][0:$N][]" tsconfig.checks.json)
PREFIX IDENTICAL — no existing line disturbed
$ diff <(git show main:tsconfig.checks.json | jq -r 'keys_unsorted[]') <(jq -r 'keys_unsorted[]' tsconfig.checks.json)
KEY SET IDENTICAL
```

Purely additive: 14 comment entries became 29, every option byte-identical.

And the file still does its actual job — it is tsx's runtime config, so the
proof is that tsx still runs a check through it:

```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
    --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-rich.tsx
PASS  no raw colour literal in the rendered chrome

PASS — 222/222 assertions
tsx exit=0
```

That is the concrete demonstration of why the two files must never be merged:
this run needs `react-dom/server` to **load**, which the runtime `paths` deliver
and the `@types` paths could not; the census needs `react-dom/server` to carry
**declarations**, which the `@types` paths deliver and the runtime paths could
not. Same four specifiers, opposite targets, both correct.

---

## Acceptance — A1.1 to A1.7

| # | Criterion | Result | Evidence |
|---|---|---|---|
| A1.1 | census exactly 36/6, same 6 files, same 11 diagnostics | **PASS** | U1 diff empty; U2 diff empty vs `residual-errors-profile-G.txt` |
| A1.2 | zero diagnostics outside `scripts/checks/` | **PASS** | U3, both greps empty |
| A1.3 | `pnpm typecheck` exit 0, output unchanged | **PASS** | U4, identical sha256 |
| A1.4 | `extends`, all `paths` under `@types/`, `typeRoots` present | **PASS** | below |
| A1.5 | U5 shows collapse **and** restoration | **PASS** | U5a 12/30, U5b 36/6 + hash |
| A1.6 | no `package.json` / lockfile diff | **PASS** | below |
| A1.7 | R6 — profile referenced by nothing but docs | **PASS, with one disclosure** | below |

### A1.4, mechanically

```
$ jq -r .extends tsconfig.checks-instruments.json
./forge-control-web/tsconfig.json
$ jq -r '.compilerOptions|keys_unsorted|join(", ")' tsconfig.checks-instruments.json
jsx, jsxImportSource, baseUrl, paths, typeRoots, allowImportingTsExtensions, noEmit, incremental
```

Eight options, every one named by R2/R3/R4 plus `noEmit`, `incremental` and
`allowImportingTsExtensions`. No copied flag list; everything else is inherited.

```
$ jq -r '.compilerOptions.paths | to_entries[] | "\(.key) -> \(.value[0])"' tsconfig.checks-instruments.json
@/*               -> ./*
react             -> ./node_modules/@types/react
react/jsx-runtime -> ./node_modules/@types/react/jsx-runtime
react-dom         -> ./node_modules/@types/react-dom
react-dom/server  -> ./node_modules/@types/react-dom/server

# every non-@/* value NOT under node_modules/@types/ :
(none)

# and all four targets exist on disk:
react             -> forge-control-web/node_modules/@types/react              EXISTS
react/jsx-runtime -> forge-control-web/node_modules/@types/react/jsx-runtime  EXISTS
react-dom         -> forge-control-web/node_modules/@types/react-dom          EXISTS
react-dom/server  -> forge-control-web/node_modules/@types/react-dom/server   EXISTS

$ grep -c 'preserve' tsconfig.checks-instruments.json      # R2's reason present
1
$ grep -c '936' tsconfig.checks-instruments.json           # R3's measured counts present
2
$ jq -c '.compilerOptions.typeRoots' tsconfig.checks-instruments.json
["./forge-control-web/node_modules/@types"]
```

### A1.6 / P-B — dependency footprint untouched

```
$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml'
(empty, exit 0)
$ git status --porcelain -- '**/package.json' '**/pnpm-lock.yaml' | wc -l
0
```

### P-A — no suppressions, and no instrument touched at all

```
$ git diff main...HEAD -- scripts/checks/ | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
ok: no suppressions
$ git diff main...HEAD -- scripts/checks/ | wc -l
0
$ git status --porcelain -- scripts/checks/ | wc -l
0
```

The stronger statement holds: **`scripts/checks/` is byte-untouched.** Phase 1
changes no instrument, no gate script and no manifest. Phases 2, 3 and 5 own
those.

### A1.7 / R6 — with its one disclosure

```
$ grep -rn 'checks-instruments' --include='*.json' --include='*.mjs' --include='*.js' --include='*.ts' . \
    | grep -v docs/ | grep -v scripts/checks | grep -v node_modules
./tsconfig.checks.json:18:    "SIBLING FILE, DO NOT MERGE: ./tsconfig.checks-instruments.json, beside this",
./tsconfig.checks.json:23:    "tsconfig.checks-instruments.json is TSC'S CONFIG, the compile profile the",
```

**Read this rather than skipping it.** A1.7 is worded "returns only the profile
itself", and this grep returns two lines and none of them is the profile. Both
facts have a reason and neither is a violation:

- The two hits **are D1.2**, which the same brief mandates: *"Name the other
  file by path in both directions."* A cross-reference that names the other file
  by path is a string in a `"//"` comment array; the grep does not know a comment
  from an option. The two requirements are in tension only at the level of the
  grep's literal output, never at the level of what R6 protects against.
- The profile does not match its own name because nothing in it needs to say
  `checks-instruments` — its cross-reference names `tsconfig.checks.json`, the
  file in the other direction.

R6's substance is *"No `next.config.*`, no `package.json` script, and neither
package's `tsconfig.json` shall reference the profile."* Checked directly:

```
$ grep -c 'checks-instruments' forge-control-web/next.config.mjs
0
$ for p in $(find . -name package.json -not -path '*/node_modules/*'); do echo "$p : $(grep -c checks-instruments $p)"; done
./forge-control/package.json : 0
./forge-control-web/package.json : 0
./forge-control-mcp/package.json : 0
$ for t in forge-control/tsconfig.json forge-control-web/tsconfig.json forge-control-mcp/tsconfig.json; do echo "$t : $(grep -c checks-instruments $t)"; done
forge-control/tsconfig.json : 0
forge-control-web/tsconfig.json : 0
forge-control-mcp/tsconfig.json : 0

# no tsconfig anywhere in the repo extends it:
./tsconfig.checks-instruments.json extends: ./forge-control-web/tsconfig.json
./tsconfig.checks.json             extends: (none)
./forge-control/tsconfig.json      extends: (none)
./forge-control-web/tsconfig.json  extends: (none)
./forge-control-mcp/tsconfig.json  extends: (none)
```

The profile is a gate input and is reachable from no build. U4's identical
sha256 is the same fact observed from the other end.

**For phase 2's reviewer:** if the literal A1.7 grep is to return empty, the
exclusion list needs `| grep -v tsconfig.checks.json`, or the comment must be
allowed. Phase 1 does not silently alter an acceptance criterion it was handed —
it reports the collision and proves the substance.

---

## D1.3 — the reproduction instrument's own properties

`reproduce-census.sh` is the thing every later reviewer runs, so it is checked
the way an instrument should be.

**Clean under shellcheck at every level, not merely at `-S error`:**

```
$ shellcheck docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
exit=0
```

The first draft enumerated with `cd "$DIR" && LC_ALL=C ls -1 *.ts 2>/dev/null || true`,
which shellcheck flagged twice (SC2035, SC2015) and which had two real holes: a
subject whose name begins with `-` would have been read by `ls` as an option, and
`2>/dev/null || true` would have turned a failed enumeration into an empty,
silently-green census — the exact shape this project exists to eliminate. It is
now two `nullglob` globs in one `printf`, whose independent left-to-right
expansion is what produces census G's "all `.ts`, then all `.tsx`" order, with
the enumeration's own failure raised rather than swallowed.

**Runs from any cwd** — the repo root is resolved from `${BASH_SOURCE[0]}`:

```
$ cd /tmp && bash /opt/ai-os/.../evidence/reproduce-census.sh > /tmp/census-fromtmp.txt
exit=0
$ diff /tmp/census-fromtmp.txt /tmp/census-final.txt
IDENTICAL FROM ANY CWD
```

**Refuses rather than degrades.** Both refusal paths exercised against a
skeleton repo in `mktemp -d`, with a real `tsc` in place so the refusal under
test is the one intended:

```
# zero subjects
$ bash "$D/docs/plan/x/evidence/reproduce-census.sh"
REFUSING: zero subjects matched /tmp/tmp.Wj7VR6fobE/scripts/checks/*.ts and *.tsx.
  A census over nothing is not a green census.
exit=1

# subject count differs from round 0's 42
$ cp check-classify.ts "$D/scripts/checks/" && bash "$D/…/reproduce-census.sh"
WARNING: found 1 subjects, round 0 measured 42.
  The table below cannot diff clean against census-G. Either an instrument
  was added or removed since 2026-08-18, or the glob is wrong. The census
  is still printed, so the diff shows precisely which subject moved.
exit=2
```

A count mismatch prints the table anyway and exits **2** rather than aborting:
the reviewer's next move is the `diff` against census G, and that diff is only
informative if the table exists. The exit code makes the mismatch impossible to
miss; the table makes it diagnosable.

The missing-`tsc` refusal carries the working install line, `--prod=false`
included:

```
REFUSING: tsc not found or not executable at …/forge-control-web/node_modules/.bin/tsc
  Install it WITH devDependencies — NODE_ENV=production prunes them and exits 0:
    cd …/forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
exit=1
```

**Leaves nothing behind.** Every generated config lives in a per-run `mktemp -d`
removed by an `EXIT` trap; `git status --porcelain` after every run in this
document shows only phase 1's four deliverables and never a stray config.

---

## What phase 1 did NOT do

Stated so the next reviewer does not look for it:

- **No instrument was fixed.** The six red files are still red, with the same
  eleven diagnostics. Phase 3 owns them.
- **No gate exists yet.** `reproduce-census.sh` prints a table and decides
  nothing. `scripts/checks/check-instrument-typecheck.sh` is untouched; phase 2
  rewrites it.
- **`instrument-manifest.txt` is untouched.** Phase 5 owns it.
- **No `package.json`, lockfile, `next.config` or app source was touched.**

Phase 1's product is one checked-in tsconfig that reproduces round 0's census
byte-for-byte, and the transcripts proving it does.
