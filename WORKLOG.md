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
