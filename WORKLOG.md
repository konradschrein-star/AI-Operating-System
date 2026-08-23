# WORKLOG — aios-devenv-and-cli

## Round 2 — fix cycle 1 (2026-08-23)

Addressing the six items in the round-1 gating review (reviewed at `9cf15e9`).

### Write-set disclosure (read this first)

**The round-2 task declared an EMPTY write set** — a fix-cycle row inherits the
reviewer's declaration, which is `[]`, so it is unsatisfiable by construction.
Every file below is therefore an undeclared write. Named explicitly:

| File | Why it had to change | Round-1 owner |
|---|---|---|
| `forge-control/src/lib/cli-runner.ts` | Review findings 1-3 (spend shape, comms shape, terminal session ownership) | Task 3 |
| `forge-control/src/lib/cli-runner.test.ts` | **New file.** The three defects all typechecked cleanly; only running the handlers against real-shaped payloads catches them | none (new) |
| `scripts/checks/raw-colour-allowlist.txt` | Review finding 4 (whole-file `.*` → pinned pattern) | none — undeclared in round 1 too, see PLAN.md §4.2 |
| `docs/DEVELOPMENT.md` | Review findings 5, 6, 7 | Task 4 |
| `docs/how-to-develop.md` | Review findings 5, 6 | Task 4 |
| `PLAN.md` | Review finding 7 asked for the perf caveat to live here. **Appended** a §4, no existing line edited | architect (round 0) |
| `WORKLOG.md` | This file, required by the house rules | none (new) |

Not touched: any surface file, `DesktopApp.tsx`, `nav-items.ts`, `tokens.ts`,
any stylesheet, `guard.sh`, `test-guard-discrimination.sh`,
`check-instrument-typecheck.sh`, `TerminalPane.tsx`.
`forge-control-web/app/desktop/gemini-identity.tsx` was modified **only** as a
temporary red probe and restored byte-for-byte from a backup copy (verified:
absent from `git status --porcelain`).

### What changed and how it was proven

**1-3. `forge-control/src/lib/cli-runner.ts`** — commit `aa0ffc5`.

- `spend summary` read `res.days_30` / `res.by_provider`. `/api/spend/summary`
  returns `today` / `d7` / `d30` and a `by_area` **array**. Every 30-day figure
  printed `€0.00` against real spend, and the breakdown never rendered at all.
  Now reads the real shape, renders metered spend and claude-code's notional
  subscription cost as separate columns, and **throws** naming the keys it did
  receive if the shape is unrecognised, rather than printing an invented zero.
- `runs show` read `entry.text` / `entry.from`. `listComms()` projects
  `content`, with the sender at `meta.comms.from`. Every comms line rendered as
  `[worker] ` with a blank body. Now renders body, sender, direction and peer
  role; an entry with no `content` is named explicitly instead of printing as
  silence.
- `terminal run` reused the first alive session when `--session` was omitted —
  the same pool the desktop `TerminalPane` drives, so an agent could submit a
  command into the shell Konrad is typing in. `--session` is now required, with
  `--new` to create a session of your own; the refusal lists the alive sessions.
- `parseArgs` gained `BOOLEAN_FLAGS` so `--new "git status"` no longer swallows
  the command as the flag's value.

Proof (`forge-control/src/lib/cli-runner.test.ts`, 9 cases against a stub HTTP
server that records every request):

```
against the fixed code:   # tests 9  # pass 9  # fail 0
against HEAD (9cf15e9):   # tests 9  # pass 1  # fail 8
```

The pre-fix run's failure on `terminal run --new` is itself the security proof:
`stub has no route for POST /api/terminal/sessions/konrad-desktop-shell/input`
— the old code was posting into the desktop's session.

**4. `scripts/checks/raw-colour-allowlist.txt`** — commit `0abaabd`.
Whole-file `.*` replaced with `^export const GEMINI_ACCENT(_SOFT)? = `.
Discrimination proven both ways with the same injected literal
(`const SNEAKY_EXTRA_ACCENT = "#ff00ff";` appended to `gemini-identity.tsx`):

```
pinned entry  → FAIL: 1 raw colour literal(s) with no allowlist entry
                gemini-identity.tsx:120  #ff00ff                        (exit 1)
old .* entry  → PASS — 224 literal(s) … (181 legitimate, 0 unlisted)    (exit 0)
restored      → PASS — 223 literal(s) … (180 legitimate, 0 unlisted)    (exit 0)
```

**5-6. `docs/DEVELOPMENT.md`, `docs/how-to-develop.md`.**
Both gained a §0 "how to invoke `aios`": bare `aios` is not on `PATH`, so every
runnable block now uses `node forge-control/bin/aios.mjs …`, plus a verified
one-time `ln -sf … /usr/local/bin/aios` install for an interactive shell (with
the warning that a worktree must never install it globally). `SHOT_STAMP` fixed
to `date -u +%Y%m%dT%H%M%SZ` (`20260823T171055Z`, colon-free). While in there,
the CLI reference was corrected against the CLI's actual `--help`: no
`spend --days`, no `runs list --status`, `screenshots take <surface>` is
positional, `terminal run <cmd> --session <id>`, `pipeline topics list`.

**7. Perf caveat** — `PLAN.md` §4.1 (appended) and `docs/DEVELOPMENT.md` §4 now
carry the measured numbers instead of the targets.

### Left undone

- The second half of finding 4 (adding the allowlist path to a task's declared
  write set) is deliberately declined — see `PLAN.md` §4.2.
- No screenshot taken: nothing visual changed this round. `TerminalPane.tsx`
  was not reopened.

### Final verification (all run, all pasted)

At `49b6262`'s parent `1d606c0` and again at `49b6262`, worktree clean:

```
bash scripts/checks/guard.sh --full
  0 node-version PASS | 0 devdeps-forge-control PASS | 0 devdeps-forge-control-web PASS
  1 no-raw-colours PASS | 1 dollar-sweep PASS | 1 forbidden-file-diff PASS
  2 tsc-forge-control PASS | 2 tsc-forge-control-web PASS | 2 instrument-typecheck PASS
  3 web-build PASS | 4 gates-808-suite PASS
  PASS: 11   FAIL: 0   SKIP: 0
  GUARD: GREEN — safe to merge at mode=full.          (260.61s at 49b6262)

bash scripts/checks/test-guard-discrimination.sh      → exit 0
  type error      → tsc-forge-control-web RED, restore → GREEN
  raw colour      → no-raw-colours RED,        restore → GREEN
  dollar literal  → dollar-sweep RED,          restore → GREEN

cd forge-control && pnpm test                          → exit 0
  # tests 1658  # pass 1658  # fail 0     (includes the 9 new cli-runner cases)

cd forge-control && npx tsc --noEmit                   → exit 0
```

Three `guard.sh --full` runs the same evening took 235s, 340s and 359s as the box's
load moved between 22 and 58 — hence the range in `docs/DEVELOPMENT.md` §4 rather
than a single number.

The only commit after the green run above is this WORKLOG.md append. No gate reads
`WORKLOG.md`; `gates-808.sh` reads only `docs/plan/artifacts/*`, and
`forbidden-file-diff` watches the named shared surface/engine files.

### Post-verification: the branch is behind main on this very file

Checked after the green run, because a sibling lane's chat surfaced
`gemini-identity.tsx` as its own gate-5 blocker.

**main has already landed two exact-literal allowlist rows for
`gemini-identity.tsx`** (`export const GEMINI_ACCENT = "#8b7bf0";` and the
escaped `rgba\(139, 123, 240, 0\.16\)`), added after this branch was cut from
`e2f4812`. The file itself is byte-identical on both sides
(`941e3b76` on `main` and on this branch), so there is no code disagreement —
only a governance one.

`git merge-tree --write-tree main HEAD` (non-destructive, neither side touched):

```
scripts/checks/raw-colour-allowlist.txt   Auto-merging — NO conflict
  → merged file carries THREE rules for one file: mine at line 36,
    main's canonical pair at 54-55
PLAN.md                                   CONFLICT (content)   — expected, every lane conflicts here
WORKLOG.md                                CONFLICT (add/add)   — another lane also created a root WORKLOG.md
```

The row therefore now carries its own removal instruction rather than becoming a
silent duplicate (commit `0da4e11`). It cannot just be deleted on this branch:
main's rows are not reachable from this merge-base, so the two literals would go
unlisted and the gate would go red here.

Gate run against the **merged tree** `e23ef545` (extracted with `git archive`,
scanned, extraction deleted afterwards):

```
no-raw-colours: PASS — 238 literal(s) across 17 file(s),
                all accounted for (181 legitimate, 57 known debt, 0 unlisted).   exit 0
```

Caveat stated plainly: that tree contains conflict markers in `PLAN.md` and
`WORKLOG.md`, which `no-raw-colours.cjs` does not read — the result is valid for
the colour gate and says nothing about the other two files.

**For whoever merges this branch:** delete the `gemini-identity.tsx` row at
line 36 in favour of main's pair, and expect to resolve `PLAN.md` and
`WORKLOG.md` by hand.

### Inherited RED on the merged tree — attributed, not mine

Prompted by a sibling lane's note that `main` is red on gate 8. Measured, both
runs pasted:

```
bash scripts/checks/dollar-sweep.sh            (this branch, HEAD 005cdbf)
  dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.   exit 0

bash <merged tree>/scripts/checks/dollar-sweep.sh   (merge-tree of main + HEAD)
  FAIL  forge-control-web/app/desktop/goals/GoalsTab.tsx:113,127,169,183
        → no allowlist entry covers this hit
  dollar-sweep.sh: FAIL — unlisted currency-shaped hit(s).              exit 1
```

The four hits are Konrad's own goal notes (`-$300/week`, `$6k + 15% rev share`,
`~$28–32k/month burn`, `~$2,500/mo`) in `goals/GoalsTab.tsx`, landed on `main`
by the goals lane. **This branch's diff touches seven files and that is not one
of them** — `PLAN.md`, `WORKLOG.md`, `docs/DEVELOPMENT.md`,
`docs/how-to-develop.md`, `forge-control/src/lib/cli-runner.ts`,
`forge-control/src/lib/cli-runner.test.ts`,
`scripts/checks/raw-colour-allowlist.txt`.

So: gate 8 is green here and will be red the moment this branch meets main,
through no change of this lane's. It needs sentence-scoped allowlist rows from
whoever owns `GoalsTab.tsx` — not from here, and not a `.*` row.
