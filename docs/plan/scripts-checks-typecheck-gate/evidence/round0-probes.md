# Round 0 — architect's probes

Five compile-profile censuses and four targeted probes, all run 2026-08-18 in the
project worktree at `git HEAD 9b960ef`, branch `project/b7ab4c57`. Every number
quoted in `00-vision.md`, `01-requirements.md` and `02-architecture.md` comes
from here.

Toolchain: `tsc 5.7.2` (from `forge-control-web/node_modules`), `node v22.x`,
`pnpm 9.15.9`. Both packages installed with
`NODE_ENV=development pnpm install --frozen-lockfile --prod=false --prefer-offline`
(1.6s and 0.96s respectively, from the local store).

---

## 1. The five censuses

Raw per-file results are the sibling `census-*.txt` files. Summary:

| Profile | Description | Green | Red |
|---|---|---|---|
| A | the gate's options today | 20 | 22 |
| B | + DOM lib, `jsx: react-jsx`, root `paths` → **runtime** react | 22 | 20 |
| C | B + `types: ["node","react","react-dom"]` | 31 | 11 |
| E | `extends forge-control-web/tsconfig.json`, `paths` → **`@types`** | 36 | 6 |
| G | E, delivered as base config + generated per-file config in `mktemp -d` | 36 | 6 |

`diff` of E against G over all 42 subjects: **identical**. The generated-config
mechanism is verified.

### 1.1 The profile-B pathology, in one file

`check-settings-surface.tsx`:

| Profile | Diagnostics |
|---|---|
| A | 11 |
| B | **936** |
| C | 92 |
| E / G | **0** |

Profile B's 936 are `TS7026` ("JSX element implicitly has type `any` because no
interface `JSX.IntrinsicElements` exists") cascading from `TS7016` ("Could not
find a declaration file for module `react`"). Mapping `"react"` to
`forge-control-web/node_modules/react` resolves the specifier to a pnpm symlink
into `.pnpm/react@19.0.0/` that ships `index.js` and no declarations — and in
resolving it, suppresses the `@types/react` lookup that would have supplied
them. Pointing the same mapping at `node_modules/@types/react` takes the file to
zero.

### 1.2 The `typeRoots` trap — profile F

Profile F was profile G **without** `typeRoots` pinned in the base config.

| | Green | Red |
|---|---|---|
| F | 12 | 30 |
| G | 36 | 6 |

Sample from `check-close-gate.ts` under F — a file that is green under both A
and G:

```
scripts/checks/check-close-gate.ts(74,55): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
scripts/checks/check-close-gate.ts(92,10): error TS2580: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
```

Cause: TypeScript's automatic `@types` discovery walks up from the **config
file's** directory. A config generated in `mktemp -d` has no `node_modules`
ancestry, so no `@types` at all are loaded. The failure impersonates a broken
codebase. `typeRoots` pinned in the base config fixes it because path options
resolve relative to the config that declares them.

### 1.3 `paths` cannot be passed on the command line

```
error TS6064: Option 'paths' can only be specified in 'tsconfig.json' file or set to 'null' on command line.
```

This is the constraint that forces the generated-per-file-config design. `tsc`
has no CLI equivalent of `files` either, so a config file per subject is the
only route to "one file per invocation, with `paths`".

---

## 2. Probe: is `check-orientation.ts` recoverable? (family B)

The census says three literals — `"operator_chat"` at line 129 and
`"project_worker"` at lines 133 and 138 — are not assignable to
`TeamNodeKind`.

The real union, `forge-control-web/app/desktop/live/agentsApi.ts:60` and
`forge-control-web/app/desktop/team/teamApi.ts:30`:

```typescript
export type AgentKind    = "operator" | "worker" | "cron" | "unknown";
export type TeamNodeKind = AgentKind | "subagent";
```

`"operator_chat"` and `"project_worker"` are **not renamed members — they never
existed in this union.** The instrument has been constructing a `TeamResponse`
fixture the server cannot produce, since the check was written.

**Probe.** A copy of the file with `"operator_chat"` → `"operator"` and
`"project_worker"` → `"worker"`:

- typecheck under profile G: **exit 0, zero diagnostics**
- runtime under `tsx`: **exit 0, `ALL PASS — orientation strip derivation`**

**Conclusion, and the caveat that matters.** The fix is two literals and it does
not cascade into an app defect. But the instrument passes **identically before
and after**, which means its assertions very likely never depended on `kind` at
all. That is not a reason to relax — it is the reason R33 puts an adversarial
reviewer on this file. The question the red-team must answer is not "does it
compile" but "did this instrument ever test the thing its name claims".

---

## 3. Probe: `serve-sse-808.ts`'s Hono import (family C)

Current, line 50–51:

```typescript
import { serve } from "../../forge-control/node_modules/@hono/node-server/dist/index.js";
import { Hono }  from "../../forge-control/node_modules/hono/dist/index.js";
```

`hono` ships no `dist/index.d.ts`; its `package.json` declares
`"types": "dist/types/index.d.ts"`. Importing `dist/index.js` explicitly bypasses
the package's `types` field entirely, so `Hono` is `any` (`TS7016`) and the
handler parameter `c` follows (`TS7006`).

`hono` and `@hono/node-server` **are** declared dependencies of
`forge-control/package.json` (`^4.6.0`, `^1.13.0`). The three sibling servers —
`serve-agents-7798.ts`, `serve-quota-7799.ts`, `serve-v3-7798.ts` — are green
because they use `node:http` and import no Hono at all, so they are a precedent
for avoiding the problem, not for solving it.

**Two variants probed:**

| Variant | Result |
|---|---|
| point both specifiers at the **package directory** (`.../node_modules/hono`, `.../node_modules/@hono/node-server`) | **exit 0, clean** |
| point at `dist/types/index.d.ts` | `TS2846: A declaration file cannot be imported without 'import type'` |

**Recommended fix: variant 1.** Deleting `/dist/index.js` from both specifiers
lets the package's own `types` field resolve, costs nothing, and keeps the
deep-path approach the file's header already explains.

**The constraint the builder must not miss:** this file is *executed*, under
`tsx`, and it binds a port. A specifier that satisfies `tsc` but breaks Node's
resolution turns a green typecheck into a dead server. Variant 1 resolves under
both because a package directory is exactly what Node's resolver expects — but
this must be **verified by running it**, not assumed. Runtime baseline recorded
below.

---

## 4. Runtime baseline of the six red instruments — before any fix

Every one of them passes today, with the type errors in place. This is the
project's justification in one table.

| Instrument | Exit | Final line |
|---|---|---|
| `check-orientation.ts` | 0 | `ALL PASS — orientation strip derivation` |
| `check-team-confirm.ts` | 0 | `ALL PASS — team confirm machine` |
| `check-team-rows.ts` | 0 | `ALL PASS — team row model` |
| `check-dismiss-peek.tsx` | 0 | `ALL PASS — dismissal peek affordance` |
| `check-stop-affordance.tsx` | 0 | `ALL PASS — stop affordance` |
| `serve-sse-808.ts` | 124 (timeout, expected — it is a server) | bound `:7845`, proxying to `127.0.0.1:7700` |

`tsx` strips the types and the invalid values flow through unchecked. Five
instruments print `ALL PASS` while constructing fixtures the wire contract
forbids.

---

## 5. The defect class this project actually found

Families A and B are the same defect wearing two error codes: **fixture drift**.
An instrument builds a fixture, the type it is a fixture *for* changes, and
because nothing compiles the instrument, the fixture keeps asserting against a
shape the system can no longer produce.

- `WorkingMsSource` is `"thread" | "rollup"`; `check-dismiss-peek.tsx:102` and
  `check-stop-affordance.tsx:98` both build `working_ms_source: "run"`.
- `TeamRow.hidesRows` is required; four instruments omit it.
- `TeamNodeKind` never contained `"operator_chat"`; `check-orientation.ts`
  builds one anyway.

A check whose fixture the server cannot produce is testing a hypothetical
system. It will keep printing `PASS` for as long as nobody compiles it — which,
before this project, was always.

---

## 6. Housekeeping

Every probe was performed on a **copy** (`zz-probe-*.ts`, removed immediately) or
in `mktemp -d`. All probe configs were deleted. `git status --porcelain` after
the last probe reported only the untracked
`docs/plan/scripts-checks-typecheck-gate/` directory this corpus lives in. No
instrument, no app file, no `package.json` and no lockfile was modified in round
0.
