# Phase 1 — gating review record

**Project:** `scripts-checks-typecheck-gate` · **Phase 1 gate**, round label 1
**Verdict:** PASS
**Tip reviewed:** `268ecde25a8c3eb0d8c7c6314f5d4851cc47afb8` (`project/b7ab4c57`)
**Re-read immediately before writing this verdict:** HEAD unmoved at `268ecde`.
**Profile under test:** `tsconfig.checks-instruments.json`,
sha256 `eda76e14a88fc54a7bd39e79e175ef21e49897269d3e64857707d86eef70fb1e` —
byte-identical to the hash recorded in `evidence/phase1-profile.md` §0, so the
file reviewed here is the file the builder measured.

**Quality document used:** `docs/plan/scripts-checks-typecheck-gate/03-quality.md`
(the per-project layout). `docs/plan/03-quality.md` also exists but belongs to a
different corpus; this project's document is the per-project one and it is what
was run. Its §3 delegates the universal gate to
`docs/plan/engine-task-graph/03-quality.md` §4's command block, which was run in
full — see §7 below.

Every claim below carries the command that produced it. Nothing here is a
described result.

---

## 0. Setup (mandatory — `NODE_ENV=production` prunes devDependencies and exits 0)

```
$ cd forge-control-web && pnpm install --frozen-lockfile --prefer-offline --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 890ms using pnpm v9.15.9

$ cd forge-control && pnpm install --frozen-lockfile --prefer-offline --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 676ms using pnpm v9.15.9

$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
```

---

## 1. U1 / A1.1 — the census reproduces round 0 byte-for-byte

```
$ bash docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh > /tmp/cen1.out 2> /tmp/cen1.err
EXIT=0
$ diff /tmp/cen1.out docs/plan/scripts-checks-typecheck-gate/evidence/census-G-generated-perfile-config.txt
DIFF_EXIT=0            # empty
$ awk '{print length($0)}' /tmp/cen1.out | sort -u
65                     # a single value: all 42 rows byte-exact, trailing spaces included
$ grep 'green ' /tmp/cen1.err
green 36 / red 6 / total 42
```

The six red, from the run's own stdout:

```
check-orientation.ts                           rc=2   errors=3
check-team-confirm.ts                          rc=2   errors=1
check-team-rows.ts                             rc=2   errors=1
serve-sse-808.ts                               rc=2   errors=2
check-dismiss-peek.tsx                         rc=2   errors=2
check-stop-affordance.tsx                      rc=2   errors=2
```

Exactly the six the brief names. `check-chat-rich.tsx` is `rc=0 errors=0`,
confirming that the project's one-line brief calling it red is the stale
round-800 measurement and that census-G is authoritative. The builder disclosed
this in `phase1-profile.md` §U1 rather than quietly reconciling it — correct.

**The census is not green by accident.** The strongest available proof that no
`tsc` invocation is a no-op is §5 below: removing one line from the profile turns
30 of these same 42 invocations red. A compiler that were skipping its subject
could not do that.

---

## 2. U2 — the eleven diagnostics, checked one by one, not counted

Full unfiltered stderr of the census run, reconciled against `00-vision.md` §3.2
**per diagnostic**:

| # | File | Line observed | §3.2 line | Code observed | §3.2 code | Family | Match |
|---|---|---|---|---|---|---|---|
| 1 | `check-orientation.ts` | 129,38 | 129 | TS2322 `"operator_chat"` | TS2322 | B | ✓ |
| 2 | `check-orientation.ts` | 133,7 | 133 | TS2322 `"project_worker"` | TS2322 | B | ✓ |
| 3 | `check-orientation.ts` | 138,23 | 138 | TS2322 `"project_worker"` | TS2322 | B | ✓ |
| 4 | `check-team-confirm.ts` | 207,30 | 207 | TS2345 `hidesRows` missing from `XClickInput` | TS2345 | A | ✓ |
| 5 | `check-team-rows.ts` | 84,3 | 84 | TS2322 `number \| undefined` vs `number` | TS2322 | A | ✓ |
| 6 | `serve-sse-808.ts` | 51,22 | 51 | TS7016 hono deep import | TS7016 | C | ✓ |
| 7 | `serve-sse-808.ts` | 90,21 | (unpinned) | TS7006 param `c` implicitly any | TS7006 | C | ✓ |
| 8 | `check-dismiss-peek.tsx` | 102,5 | 102 | TS2322 `"run"` vs `WorkingMsSource \| null` | TS2322 | A | ✓ |
| 9 | `check-dismiss-peek.tsx` | 115,3 | 115 | TS2741 `hidesRows` missing from `TeamRow` | TS2741 | A | ✓ |
| 10 | `check-stop-affordance.tsx` | 98,5 | 98 | TS2322 `"run"` vs `WorkingMsSource \| null` | TS2322 | A | ✓ |
| 11 | `check-stop-affordance.tsx` | 111,3 | 111 | TS2741 `hidesRows` missing from `TeamRow` | TS2741 | A | ✓ |

Eleven for eleven: same codes, same lines, same files, same three families.
Independently cross-checked against round 0's own capture:

```
$ diff /tmp/u2-actual.txt docs/plan/scripts-checks-typecheck-gate/evidence/residual-errors-profile-G.txt
U2 DIFF EMPTY
```

**One corpus arithmetic slip, non-blocking, not phase 1's:** `00-vision.md` §3.2
heads Family A *"(7 errors, 4 files)"* while its own table lists **6** rows.
6 + 3 + 2 = 11, and 11 is the number everywhere else in the corpus including the
closing sentence "Eleven, in six files, in three families." The table is right and
the heading's `7` is a typo. It originates in round 0's commit `b74ecb2`, is
outside phase 1's write_set, and misleads nobody who reads the table beneath it.
Recorded for the phase 5 corpus amendment; it does not affect this verdict.

---

## 3. U3 / A1.2 / S5 — zero diagnostics outside `scripts/checks/`

```
$ grep -E '^[^ ].*\([0-9]+,[0-9]+\): error TS' /tmp/cen1.err | grep -v '^scripts/checks/'
[exit=1 — no matches — EMPTY]

$ grep -cE '^[^ ].*\([0-9]+,[0-9]+\): error TS' /tmp/cen1.err
11
$ grep -c 'error TS' /tmp/cen1.err
11
```

Every one of the 11 diagnostics is located in `scripts/checks/`. Not one is in
`forge-control-web/app/**` or `forge-control/src/**`, so the profile is not
blaming the app for its own bug (02-architecture.md §3.3).

The count agreement matters: 11 location lines and 11 total `error TS`
occurrences means there are no *additional* diagnostics hiding in continuation
lines that the location-anchored grep would have missed.

**And the builder did not "fix" a profile bug by editing the app** — the
strongest form of that check is that the diff touches no app file at all:
`git diff --stat main...HEAD` (§8) lists five files, none under
`forge-control-web/app/` or `forge-control/src/`.

---

## 4. A1.3 / U4 / R7 — the app's own typecheck is unaffected

```
$ cd forge-control-web && pnpm typecheck
> forge-control-web@0.1.0 typecheck /opt/ai-os/.../forge-control-web
> tsc --noEmit
EXIT=0
```

Exit 0, and the output is the two-line pnpm banner with no diagnostics — which is
what the builder recorded as the pre-phase baseline in `phase1-profile.md` §U4
(sha256 `5546b0b4…` for both the before and after captures). My run reproduces
that same empty-diagnostic output. This is the expected result and it is
structural rather than lucky: §6 shows the profile is reachable from no build,
so it cannot influence the app's compile.

---

## 5. A1.5 / U5 — `typeRoots` is load-bearing, re-measured independently

The brief requires a transcript, not a description, *and* it exists because an
unchecked comment decays into folklore. So rather than read the builder's
transcript, I re-ran the collapse myself, with the profile copied into
`mktemp -d` (`typeRoots` deleted, `extends`/`baseUrl` absolutised) so that **the
repository was never modified**:

```
$ jq 'del(.compilerOptions.typeRoots) | .extends = ($r + "/forge-control-web/tsconfig.json")
      | .compilerOptions.baseUrl = ($r + "/forge-control-web")' tsconfig.checks-instruments.json > $T/no-typeroots.json
$ # one tsc -p per subject, all 42
=== U5 REPRODUCED: green 12 / red 30 / total 42 ===
$ grep -c "Cannot find name 'process'" $T/all.err
51
$ grep -m3 "Cannot find name 'process'\|Cannot find module 'node:" $T/all.err
scripts/checks/check-browser-shots.ts(30,30): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-browser-shots.ts(338,1): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
$ git status --porcelain
[empty]
```

**12 green / 30 red, with real `Cannot find name 'process'` output — exactly the
figure the `//typeRoots` comment claims and exactly profile F of
`round0-probes.md` §1.2.** The comment is true. It is not folklore.

The builder's own U5 transcript (`phase1-profile.md` §U5a/U5b) records the same
12/30, the twelve survivors by name, a full `check-close-gate.ts` diagnostic
block, and the restoration to 36/6 proven by sha256
(`eda76e14…` before and after) plus a clean `git status`. Its census table is
abridged with `… (30 more rows)`, but the substance the brief demands — the
collapse figure, real `Cannot find name 'process'` output, and the restoration —
is all present and, more to the point, I reproduced the load-bearing half myself
rather than accepting it.

---

## 6. A1.7 / R6 — the profile is reachable from no build

```
$ grep -rn 'checks-instruments' --include='*.json' --include='*.mjs' --include='*.js' --include='*.ts' . \
    | grep -v docs/ | grep -v scripts/checks | grep -v node_modules
./tsconfig.checks.json:18:    "SIBLING FILE, DO NOT MERGE: ./tsconfig.checks-instruments.json, beside this",
./tsconfig.checks.json:23:    "tsconfig.checks-instruments.json is TSC'S CONFIG, the compile profile the",
```

Two hits, both string elements of the `"//"` **comment array** in
`tsconfig.checks.json` — i.e. both are D1.2's mandated cross-reference, which the
same phase brief requires to name the other file *by path in both directions*.
Neither is an option, a script, or an `extends`.

R6's normative text is *"No `next.config.*`, no `package.json` script, and
neither package's `tsconfig.json` shall reference the profile"* — verified
directly rather than through the proxy grep:

```
$ grep -c 'checks-instruments' forge-control-web/next.config.mjs        → 0
$ forge-control/package.json, forge-control-web/package.json,
  forge-control-mcp/package.json                                        → 0, 0, 0
$ forge-control/tsconfig.json, forge-control-web/tsconfig.json,
  forge-control-mcp/tsconfig.json                                       → 0, 0, 0
$ no tsconfig in the repo extends the profile
```

A1.7 as written in `04-phases.md:79` is *"Nothing but docs references the
profile (R6)"* — **satisfied**. See §10 finding 1 for the imprecision in R6's
*verify clause* (`01-requirements.md:83`), which is a corpus defect, is
non-blocking, and which the builder disclosed rather than silently widened.

---

## 7. A1.4 — the profile read, not just run

```
$ jq -r .extends tsconfig.checks-instruments.json
./forge-control-web/tsconfig.json          # jq exit 0 → strict JSON, and R1's verify clause works
```

It **extends**; it is not a copied flag list. The whole of `compilerOptions` is
eight keys:

```
$ jq -r '.compilerOptions | keys[]' tsconfig.checks-instruments.json
allowImportingTsExtensions
baseUrl
incremental
jsx
jsxImportSource
noEmit
paths
typeRoots
```

Two forced overrides (`jsx`, `jsxImportSource`), the `paths` mapping and its
`baseUrl`, the pinned `typeRoots`, and three mechanical flags. Everything else is
inherited from the app's own tsconfig, which is the entire point of R1/S6.

**Every `paths` value is `@types`, none is a runtime package:**

```
$ jq -r '.compilerOptions.paths | to_entries[] | "\(.key) -> \(.value|join(","))"' tsconfig.checks-instruments.json
@/*                -> ./*                                        (the inherited alias)
react              -> ./node_modules/@types/react
react/jsx-runtime  -> ./node_modules/@types/react/jsx-runtime
react-dom          -> ./node_modules/@types/react-dom
react-dom/server   -> ./node_modules/@types/react-dom/server
```

**`typeRoots` present and pinned:**

```
$ jq -c '.compilerOptions.typeRoots' tsconfig.checks-instruments.json
["./forge-control-web/node_modules/@types"]
```

No rejection trigger fires: nothing points at a runtime package, `typeRoots` is
present, and the profile extends rather than copies.

### The comments — the deliverable, checked as one

```
$ grep -c preserve tsconfig.checks-instruments.json        → 1     (R2: the jsx reason is inline)
$ grep -n '936' tsconfig.checks-instruments.json           → 2 hits (R3: the measured 936-vs-0 counts)
    31:    "936 diagnostics under the runtime mapping, 0 under this one.",
    50:    "runtime targets cost check-settings-surface.tsx 936 diagnostics under tsc,",
$ grep -n 'CONFIG FILE' tsconfig.checks-instruments.json   → R4: the config-file-directory discovery
    36:    "directory of the CONFIG FILE, and the gate generates its per-file config",
$ grep -nE '^\s*//[^"]' tsconfig.checks-instruments.json   → [empty]  (no JSONC line comments)
```

No comment was stripped to save space. R2, R3 and R4 are each satisfied by text
still in the file.

### The sanctioned TS5025 deviation — verified three ways

The three comment arrays sit at the file's **top level**, not inside
`compilerOptions`. Per the brief this is measured and prescribed, so the checks
are (a) is the reason real, (b) did the text survive verbatim, (c) was
02-architecture.md §3.1 amended in the same commit.

**(a) The reason is real — I reproduced TS5025 myself**, rebuilding round 0's
as-written shape from `git show b74ecb2:…/02-architecture.md` into `mktemp -d`:

```
$ forge-control-web/node_modules/.bin/tsc -p "$T/one.json"
…/zz-probe-base.json(15,5): error TS5025: Unknown compiler option '//jsx'. Did you mean 'jsx'?
…/zz-probe-base.json(24,5): error TS5025: Unknown compiler option '//paths'. Did you mean 'paths'?
…/zz-probe-base.json(56,5): error TS5025: Unknown compiler option '//typeRoots'. Did you mean 'typeRoots'?
rc=2
$ forge-control-web/node_modules/.bin/tsc --version
Version 5.7.2
```

Three spurious diagnostics and `rc=2` on **every** invocation — which would have
produced a census of 0 green / 42 red. The correction is necessary, not
cosmetic. (Line numbers differ from the planner's 5/8/17 and the builder's
4/13/45 only because each probe was reconstructed with a different key layout;
the three codes, three keys and `rc=2` are identical in all three.)

**(b) The comment text survived verbatim** — compared array-by-array against
round 0's block:

```
//jsx        : TEXT VERBATIM IDENTICAL
//paths      : TEXT VERBATIM IDENTICAL
//typeRoots  : TEXT VERBATIM IDENTICAL
"//"         : IDENTICAL
compilerOptions (semantic, comments stripped) : OPTIONS IDENTICAL TO ROUND-0 DESIGN
```

Only the placement moved. Not one word of the reasoning was lost, and no option
was altered under cover of the move.

**(c) The amendment landed in the same commit (standing rule 2):**

```
$ git diff --stat b74ecb2 268ecde -- docs/plan/.../02-architecture.md tsconfig.checks-instruments.json
 .../02-architecture.md            | 105 +++++++++++++++------
 tsconfig.checks-instruments.json  |  83 ++++++++++++++++
```

§3.1 now carries the TS5025 measurement inline, verbatim, with the reason JSONC
was rejected (`jq` is R1's verify clause). And the amended block is not merely
*similar* to the shipped file:

```
$ awk '/^```jsonc$/{f=1;next} f&&/^```$/{exit} f' …/02-architecture.md > /tmp/doc-block.json
$ diff /tmp/doc-block.json tsconfig.checks-instruments.json
BYTE-IDENTICAL
```

A builder who copies that block now gets a working profile. That is precisely
the failure standing rule 2 exists to prevent, and it is closed.

**JSONC was not used** — `jq -r .extends` works, verified above.

---

## 8. D1.2 — the cross-reference, both directions, nothing else disturbed

```
$ jq . tsconfig.checks.json > /dev/null ; echo $?
0
$ diff <(git show main:tsconfig.checks.json | jq -S 'del(.["//"],.["//cross-reference"])') \
       <(jq -S 'del(.["//"],.["//cross-reference"])' tsconfig.checks.json)
NO OPTION CHANGED
```

The change to `tsconfig.checks.json` is purely additive text inside its existing
`"//"` array. Both directions are present: `tsconfig.checks.json` names
`./tsconfig.checks-instruments.json` by path (line 18), and the profile's
`//cross-reference` names `./tsconfig.checks.json` by path. Both state the same
substance — one is tsx's **runtime** config (paths → runtime react, so imports
load), the other is tsc's (paths → `@types`, so declarations resolve), same four
specifiers, opposite targets, never to be merged.

And the runtime config still does its job, which is the concrete demonstration
that they must not be merged:

```
$ cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
    --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-rich.tsx
PASS  no raw colour literal in the rendered chrome
PASS — 222/222 assertions
tsx exit=0
```

---

## 9. R5 — the `@/*` alias resolves, with a negative control

No instrument imports via `@/` today, so R5's own clause calls for a throwaway.
I ran my own rather than reading the builder's, in `mktemp -d`, never in the repo:

```
$ cat $T/r5-alias-probe.ts
import { fmtWorkingTime, fmtTokens } from "@/app/desktop/team/teamApi";
import type { TeamNodeKind } from "@/app/desktop/team/teamApi";
const kind: TeamNodeKind = "subagent";
const label: string = `${kind} ${fmtWorkingTime(1234)} ${fmtTokens(5678)}`;
console.log(label);

$ tsc -p "$T/r5.json"      → exit=0     (alias resolved, named exports found and typed)
```

**Exit 0 alone cannot distinguish "resolved" from "silently ignored", so the
negative control:**

```
$ tsc -p "$T/r5neg.json"   # same file, alias pointed at a module that does not exist
…/r5-neg.ts(1,43): error TS2307: Cannot find module '@/app/desktop/team/teamApi-NOPE' or its corresponding type declarations.
…/r5-neg.ts(2,35): error TS2307: Cannot find module '@/app/desktop/team/teamApi-NOPE' or its corresponding type declarations.
exit=2
$ git status --porcelain → [empty]
```

The compiler genuinely attempted the resolution and reported failure when it
could not, so the clean run above was a real resolution. The builder's own R5
transcript uses the same positive-plus-negative shape and reaches the same
result; the throwaway was created in `mktemp -d` and the tree is clean.

---

## 10. NF3 / U6 / I6 — the instrument's own properties

**NF3 — nothing left behind.** After three full census runs plus two `mktemp`
probes:

```
$ git status --porcelain
[empty]
$ ls -ldt /tmp/tmp.* | head -1
drwx------ 2 root root 4096 Aug 17 07:12 /tmp/tmp.QDZO1NhkIx     # newest is from YESTERDAY
```

No generated tsconfig, no `.tsbuildinfo`, no probe file, and not one temp
directory leaked today. The script uses `mktemp -d` at line 121 with
`trap 'rm -rf "$TMP"' EXIT` at line 122, so the cleanup survives the failure path
too, and it writes nothing into the repo.

**U6 / NF2 — determinism.** Two runs, diffed:

```
$ diff /tmp/cen1.out /tmp/cen2.out   → STDOUT IDENTICAL
$ diff /tmp/cen1.err /tmp/cen2.err   → STDERR IDENTICAL
```

Even stderr is identical — the `mktemp -d` path never reaches the output because
the generated config names its subject by absolute path and `tsc` reports the
subject, not the config.

**I6 — runs from any cwd:**

```
$ cd /tmp && bash /opt/ai-os/.../evidence/reproduce-census.sh
EXIT=0
$ diff /tmp/cen_tmp.out …/census-G-generated-perfile-config.txt
IDENTICAL
$ grep 'green ' /tmp/cen_tmp.err
green 36 / red 6 / total 42
```

Same verdict from `/tmp`. The repo root is resolved from `${BASH_SOURCE[0]}`
(line 35–36), not from `$PWD`.

**shellcheck** — clean at every level, not merely `-S error`:

```
$ shellcheck …/reproduce-census.sh              → exit=0
$ shellcheck -S error …/reproduce-census.sh     → exit=0
```

**Read-through of every construct that could convert a failure into a pass.**
The quality document requires this be stated explicitly rather than assumed.
Four exist and none of them can:

| Line | Construct | Can it turn red into green? |
|---|---|---|
| 112, 113 | `git rev-parse … 2>/dev/null \|\| echo '(not a git repo)'` | **No.** Provenance only, on stderr, outside the census loop. Cannot touch a row or a count. |
| 136 / 139 | `set +e` … `set -e` bracketing the `tsc` call | **No.** This is the *required* pattern — 6 of 42 subjects are expected non-zero, so `set -e` must not abort the loop. `rc` is captured on line 138 and used on line 147. |
| 142 | `grep -c 'error TS' \|\| true` | **No.** `grep -c` exits 1 on zero matches, which is a legitimate count of 0. And the green test on line 147 is `rc == 0 && n == 0` — an **AND**. A wrongly-zeroed `n` still cannot green a file whose `rc` is 2. |
| 75 | `shopt -s nullglob` | **No.** It makes an unmatched glob vanish so an empty directory reaches the zero-subject refusal on line 88 rather than being handed to `tsc` as a literal filename. It converts a silent pass into a loud refusal. |

There is no `continue` and no bare `2>/dev/null` on any path that decides a row.
Notably the enumeration deliberately avoids `ls` and `2>/dev/null || true` — the
builder records in `phase1-profile.md` §D1.3 that its first draft used exactly
that and shellcheck flagged it (SC2035, SC2015); the two real holes it closed
were a subject named `-something.ts` being read as an option, and a failed
enumeration degrading into an empty, silently-green census.

---

## 11. P-A / P-B / write-set — the diff itself

**`git diff --stat main...HEAD` — the five files of the builder's write_set and
nothing else** (the ten other paths are round 0's planning commit `b74ecb2`, not
phase 1's):

```
$ git log --name-only --format='=== %H %s' 268ecde -1
=== 268ecde feat(scripts-checks-typecheck-gate/round-100, phase 1): the compile profile, …
docs/plan/scripts-checks-typecheck-gate/02-architecture.md
docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md
docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh
tsconfig.checks-instruments.json
tsconfig.checks.json
```

**WRITE-SET AUDIT.** Declared on the task row (round 0, role `builder`, read from
`GET /api/projects/b7ab4c57-…` → `tasks[].write_set`, not reconstructed from the
brief):

```json
["tsconfig.checks-instruments.json",
 "tsconfig.checks.json",
 "docs/plan/scripts-checks-typecheck-gate/evidence/reproduce-census.sh",
 "docs/plan/scripts-checks-typecheck-gate/evidence/phase1-profile.md",
 "docs/plan/scripts-checks-typecheck-gate/02-architecture.md"]
```

Actual == declared, set-for-set. **Zero undeclared writes.** (The round-100
*planner* row declares a 4-file subset without `02-architecture.md`; the builder
row — the one that governs the builder's commits — carries all five, so the
standing-rule-2 amendment was declared before it was written, not after.)

**P-A — no suppressions, and no instrument touched at all:**

```
$ git diff main...HEAD -- scripts/checks/ | grep -E '^\+.*(@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|as unknown as)'
ok: no suppressions
$ git diff main...HEAD -- scripts/checks/ | wc -c
0
```

The stronger statement holds and is what phase 1 required: **`scripts/checks/` is
byte-untouched.** No instrument, not `check-instrument-typecheck.sh` (phase 2
owns it), not `instrument-manifest.txt` (phase 5 owns it).

**P-B / A1.6 — dependency footprint untouched:**

```
$ git diff main...HEAD -- '**/package.json' '**/pnpm-lock.yaml' | wc -c
0
```

---

## 12. The gate suite

**This project ships no `gates-*.sh` suite.** `scripts/checks/gates-808.sh` is
the only such file in the tree and it belongs to `engine-task-graph`, not to
this project; `03-quality.md` does not name it. Per the two available options,
the quality document's own command block was run instead — the universal gate at
`docs/plan/engine-task-graph/03-quality.md` §4, which this project's
`03-quality.md` §3 delegates to, plus this project's §3 "Phase 1 gate" block
(reproduced throughout §§1–11 above).

**12 gates EXECUTED, 0 RED, 0 SKIPPED.**

| # | Gate | Command | Result |
|---|---|---|---|
| 1 | typecheck (forge-control) | `pnpm typecheck` | **exit 0** |
| 2 | unit suite | `pnpm test` | **exit 0** — 1293 pass / 0 fail / 0 skipped, 239 suites |
| 3 | live checkout clean | `git -C /opt/forge-ai-os status --porcelain` | **empty** |
| 4 | branch commit census | `git log … --name-only` | 2 commits, both this project's |
| 5 | R66 sweep | `grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'` | **4 hits, expected 4** |
| 6 | consecutive rounds | `grep -rn "consecutive rounds" forge-control/` | **empty** |
| 7a | corpus map | `python3 …/check-corpus-map.py` | **exit 0** — R1..R71, NF1..NF7 agree |
| 7b | instrument identity | `python3 …/check-instrument-identity.py` | **exit 0** — 12 headers, 33 manifest lines |
| 8 | R20 census | `python3 scripts/checks/check-r20-census.py` | **exit 0** — R20 PASS, REGION PASS |
| 9 | instrument typecheck | `bash scripts/checks/check-instrument-typecheck.sh` | **exit 0** — 7/7 (see note) |
| 10 | shell lint | `shellcheck -S error <derived list>` | **exit 0** — 1 file: `reproduce-census.sh` |
| 11 | SQL executed | `bash scripts/check-schedule-sql.sh` | **exit 0** — 40 pass / 0 fail |
| 12 | screenshot render shapes (R902) | `npx tsx ../scripts/checks/check-screenshot-render-shapes.ts` | **exit 0** — ALL PASS, 16 checks |

**Item 5, read rather than counted** (R66's rule is "every hit inside a
prohibition, no hit in an executable position"). All four read:

```
forge-control/src/lib/project-tick.test.ts:217  /NEVER[^.]*pm2 restart forge-executor/,
forge-control/src/lib/project-tick.test.ts:218  "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
forge-control/src/lib/project-tick.ts:427       `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, …`
forge-control/src/lib/project-tick.ts:588       `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n`
```

Two are the shipped prohibitions themselves; two are the test asserting those
prohibitions still carry NEVER wording. None is in an executable position. The
count is unmoved at 4 — this branch added no `*.sh` or `*.ts` mentioning it.

**Item 9 is green, and its greenness is the project's own thesis.** The existing
`check-instrument-typecheck.sh` reports `PASSED — 7/7 entries compiled clean,
manifest complete` while **42** instruments exist on disk and **6** of them do
not typecheck. It passes because it reads a 7-line manifest, and because phase 1
touched no instrument so its manifest guard is vacuous ("this branch touched no
`scripts/checks/*.ts` — guard vacuous but reported"). That is exactly the hole
this project exists to close; phase 2 rewrites this script. It is reported green
here because it *is* green, not because it is right.

---

## 13. The three closing questions (`engine-task-graph/03-quality.md` §4)

**1. What would have made my instruments report a pass wrongly? Two mechanisms,
each shown impossible here.**

*(a) The census could have compiled nothing and diffed clean against an empty
file.* Impossible as measured: `census-G` carries 42 rows; my stdout carries 42
rows; `awk '{print length($0)}' | sort -u` returns the single value `65`, so
every row is a real, fully-formed record; and the stderr summary reads
`green 36 / red 6 / total 42`. A no-op run cannot produce six rows with `rc=2`
and eleven attributed diagnostics.

*(b) `tsc` could have been invoked without ever reading its subject* — a
resolution or config failure that returns 0 without compiling. Ruled out by §5:
deleting one line (`typeRoots`) from the profile turns **30 of these same 42
invocations red** with `Cannot find module 'node:fs'` and `Cannot find name
'process'`. An invocation that were not really reading and resolving its subject
could not change verdict when the subject's type environment changes. The 12
that stay green under that mutation are precisely the ones touching no node
built-in — the collapse is selective, which is what a real compile looks like.

*(c) A stale incremental cache could have short-circuited later runs.* The
profile sets `incremental: false` (verified in `compilerOptions`), the census was
run three times including once from `/tmp`, and all three are byte-identical.

**2. Which gate did I find unsatisfiable, and did I amend it where it is
enforced?** R6's *verify clause* — see finding 1 below. I did **not** amend it:
`01-requirements.md` is outside my write_set (which is exactly
`["docs/plan/scripts-checks-typecheck-gate/evidence/phase1-review.md"]`), and a
reviewer silently rewriting the criterion it is judging against is the failure
this separation exists to prevent. It is recorded below with the exact
amendment and its owner. I likewise did not widen any grep to make anything pass.

**3. Citations.** Every criterion is cited by its id (A1.1–A1.7, R1–R7, U1–U6,
P-A, P-B, S5, NF2, NF3, I6, D1.2, D1.3). Every line number in this document is
pinned to `268ecde25a8c3eb0d8c7c6314f5d4851cc47afb8`.

---

## 14. Findings — both non-blocking, neither in phase 1's write_set

**Finding 1 — `01-requirements.md:83`, R6's verify clause is unsatisfiable as
literally worded. Severity: low (documentation). Not a phase-1 defect.**

R6's verify clause ends *"returns only the profile itself."* That output is
impossible in principle, independently of anything phase 1 did: the grep matches
the string `checks-instruments`, and `tsconfig.checks-instruments.json` contains
no occurrence of its own name — its cross-reference names the file in the *other*
direction. So the clause can never return the profile. Layered on top,
D1.2 *requires* `tsconfig.checks.json` to name the profile by path, which the
grep's exclusion list (`-v docs/`, `-v scripts/checks`) does not exclude.

*Failure scenario:* a later reviewer runs the literal clause, sees two hits where
the text promised one, and either fails a compliant phase or — worse — "fixes" it
by deleting D1.2's cross-reference, removing the only thing standing between the
next maintainer and merging the two configs.

*The fix (phase 5, which already owns the corpus amendment):* restate R6's verify
clause as its own substance, e.g. — *"returns no hit in an executable position:
no `next.config.*`, no `package.json` script, no `tsconfig.json` `extends`.
Comment-array hits carrying D1.2's cross-reference are expected and are not
references."* Scope any exclusion to that sentence, not to the file.

The builder handled this correctly: it disclosed the collision in
`phase1-profile.md` §A1.7, proved R6's substance directly against
`next.config.mjs`, all three `package.json`s and all three `tsconfig.json`s, and
did **not** widen the grep or alter the criterion it was handed. A1.7's own
normative wording in `04-phases.md:79` ("Nothing but docs references the
profile") is satisfied.

**Finding 2 — `tsconfig.checks-instruments.json:39` cites an evidence file that
does not exist yet. Severity: informational.**

The `//typeRoots` comment ends *"See evidence/negative-controls.md control (d)."*
That file is phase 4's deliverable and is absent at `268ecde`
(`ls` → `No such file or directory`). The text is verbatim from round 0's design
and phase 4 is planned to create it, so this is a forward reference, not a broken
one. Recorded only so that if phase 4 is ever descoped, the pointer is known to
need repointing at `evidence/phase1-profile.md` §U5, which carries the same proof
today.

**Not findings, checked and cleared:** no suppression anywhere in the diff; no
app file touched; no dependency change; no instrument, gate script or manifest
touched; no temp leak; no `git status` stray; live checkout `/opt/forge-ai-os`
clean.

---

## 15. Verdict

The census reproduces round 0 **byte-for-byte** — the standard this gate was
written to enforce, and the one whose failure would void every downstream number
in phases 2–6. All eleven diagnostics match `00-vision.md` §3.2 by file, line and
code. The profile extends rather than copies, every `paths` value is `@types`,
`typeRoots` is pinned, and its load-bearing claim was re-measured from scratch
rather than believed. The sanctioned TS5025 deviation is real (reproduced
independently), its comment text survived verbatim, and `02-architecture.md` §3.1
was amended in the same commit to be byte-identical to the shipped file. The
write-set is exactly as declared. Twelve universal-gate items executed, none red.

**VERDICT: PASS**
