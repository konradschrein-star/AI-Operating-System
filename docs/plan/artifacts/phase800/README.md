# Phase 800 — artifacts

## Round 801 — U31 canvas open cost, BEFORE baseline

Round 801 measures only. It touches no application code: two other builders
were editing `ChatSurface.tsx` and `api.ts`/`SecretField.tsx` in this worktree
in parallel, so the measured tree is a `git archive` of committed HEAD rather
than the working copy. Both landed mid-round (`206323d`, `f9d5c23`); neither
touches any canvas file, and `31385c91` is a clean ancestor of both.

| file | what it is |
|---|---|
| `canvas-open.cjs` | the protocol. Its header comment is the runnable reproduce recipe (ports, cookie, isolated build, `--write` convention). Requires `../phase700/lib-703.cjs` directly |
| `canvas-open-before.json` | run A — the committed baseline, 4 scenarios × 6 open/close cycles, 18/18 checks PASS |
| `canvas-open-before-run2.json` | run B — an independent rerun, same verdict. The reproducibility leg |
| `canvas-perf.md` | what was measured, how, the numbers, and the ranked candidate causes with the evidence for each |

**Baseline:** `31385c91adf66ed9562c4af045acdd802d124e32`. Any AFTER run in round
803 must name the same sha or the comparison is not one.

**Verdict:** U31's 100 ms scripting gate is **EXCEEDED**. Cold open with a
remembered drawing costs **193–205 ms scripting over 580–691 ms wall**; the
pane's own frame is cheap at **19–29 ms** and is not the problem. Even with
every chunk served from the HTTP cache the open still costs **102–106 ms**, so
the network is not the gate. See `canvas-perf.md` §2 for the full table and §3
for the ranked causes.

**Round 803 must merge `main` first.** `main` has already replaced this
component's polling with SSE and is ahead of this branch — see `canvas-perf.md`
§5a. All four ranked causes survive the merge; the absolute numbers will not.

### Conventions inherited from phase 700

`lib-703.cjs` supplies `BASE`/`API`/`VIEWPORT`/`api`/`makeChecker`/`openChat`/
`resolveChat`/`withBrowser`/`watchErrors` and the round-705 non-destructive
rule: without `--write` a rerun writes to `/tmp/phase800-out`, prints the
`diff -u` line against the committed copy, and leaves `git status --porcelain`
empty.

One constant is deliberately **not** inherited. `lib-703.cjs` derives `SRC_DIR`
from its own `__dirname`, so `L.finish()` under `--write` would drop a phase-800
artifact into `docs/plan/artifacts/phase700/`. `canvas-open.cjs` steers
`PHASE700_OUT_DIR` before requiring the library and re-states `finish` against
this directory (`finish800`). Same stdout, same exit code, correct destination.

### Servers

Same three-server rule as phase 700, one port different:

- **BASE `:7811`** — isolated `next build` + `next start` of the archived HEAD
  (`/tmp/phase800-canvas-before/forge-control-web`), built with
  `FORGE_CONTROL_URL=http://127.0.0.1:7798`. Never pm2, never `:7701`. `:7811`
  was free; no other round's server was killed.
- **API `:7798`** — the worktree harness `scripts/checks/serve-v3-7798.ts`.
  `forge-control/src/index.ts` was never booted on any port.
- **forge-executor** — never touched.

The worktree's own `forge-control-web/.next` was never rebuilt.
