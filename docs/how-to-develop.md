# How to Develop on Konrad's Personal AI OS

This playbook is the hands-on, step-by-step guide for developers and agent lanes building and modifying features in `forge-ai-os`. Follow these procedures to work safely in parallel with other lanes without breaking live services or failing verification gates.

---

## 0. How to invoke `aios` (do this before any example below)

`aios` is a `bin` entry in `forge-control/package.json`. Nothing links it automatically, so **bare `aios` is `command not found` until someone installs it**. Every runnable block in this playbook therefore uses the always-true form:

```bash
node forge-control/bin/aios.mjs guard fast          # from the repo or worktree root
node /opt/forge-ai-os/forge-control/bin/aios.mjs guard fast   # from anywhere
```

Working in an interactive shell on this box and want the short form? One-time install, pointing at the **live checkout**:

```bash
ln -sf /opt/forge-ai-os/forge-control/bin/aios.mjs /usr/local/bin/aios
command -v aios && aios terminal list      # verify
```

Agent lanes must not do that from a worktree — `/usr/local/bin` is shared, and a symlink into a worktree hijacks Konrad's `aios` and dies with the worktree. In the quick-reference table of §7 commands are written as `aios …` for readability; prefix them with `node forge-control/bin/aios.mjs` if you skipped the install.

---

## 1. Quickstart: Worktree Setup & Dependencies

All development occurs within isolated git worktrees created off `main`.

### Step 1: Install Dependencies Safely
The environment exports `NODE_ENV=production`. You **must** supply `--prod=false` to prevent `pnpm` from silently pruning dev dependencies (`tsc`, `tsx`, linters):

```bash
# Web frontend dependencies:
cd forge-control-web && pnpm install --frozen-lockfile --prod=false

# Backend API dependencies:
cd ../forge-control && pnpm install --frozen-lockfile --prod=false
```

### Step 2: Verify Local Typecheckers Exist
Confirm that `tsc` was installed and is executable:
```bash
./forge-control/node_modules/.bin/tsc --version
./forge-control-web/node_modules/.bin/tsc --version
```

---

## 2. Blast Radius & File Ownership Rules

Tonight ~8-10 agent lanes operate concurrently in the same repository. To prevent catastrophic merge conflicts:

### Off-Limits Shared Files
**NEVER edit these files without explicit brief instruction:**
- `forge-control-web/app/desktop/DesktopApp.tsx` (Root desktop layout)
- `forge-control-web/app/desktop/nav-items.ts` (Global surface registry)
- `forge-control-web/app/tokens.ts` (Design token catalog)
- `forge-control-web/app/globals.css`, `app/theme.css`, `app/v2.css` (CSS variables & cascade)
- Core engine files (`project-tick`, `cc-runner`, `executor.ts`, `db/projects`, `VaultFileList`, `routes/files`)

### The `HANDOFF.md` Workflow
If your feature requires a wire-up in `DesktopApp.tsx` or an addition in `nav-items.ts`:
1. Build your surface self-contained inside `forge-control-web/app/desktop/YourSurface.tsx`.
2. Do not touch `DesktopApp.tsx` or `nav-items.ts`.
3. Document the required import and mount line in `HANDOFF.md` in the worktree root. The integrator lane will apply it cleanly.

---

## 3. UI Design Standards & Token Purity

Konrad uses this OS outdoors in bright sunlight and indoors in low light. All UI components must adhere to the design system:

### Rules:
1. **Zero Raw Colours**:
   Never use `#hex`, `rgb()`, `rgba(literal)`, or `hsl()` in TSX styles. Use tokens from `app/tokens.ts`:
   ```tsx
   import { tokens, dot } from "../tokens";

   // Correct:
   <div style={{ background: tokens.bgCard, color: tokens.text, border: `1px solid ${tokens.border}` }}>
     <span style={dot(tokens.ok)} />
     <span style={{ color: tokens.textMuted }}>Live</span>
   </div>
   ```
2. **Every Surface Needs 4 States**:
   - **Loading**: Skeleton placeholders (not jumpy spinners).
   - **Empty**: Explain *why* there is no data and what action populates it.
   - **Error**: Render the actionable failure message and provide a retry button.
   - **Populated**: Formatted cleanly with realistic data volume.
3. **No Mock Data**:
   Never hardcode mock arrays or placeholder numbers. If the API is missing, render an explicit "Not wired to backend yet" indicator.

---

## 4. Running the Code Guard

The code guard is the single gate standing between code changes and `main`. Run it continuously during development.

### Fast Guard (< 30 seconds)
Runs preflight checks, token purity scanner (`no-raw-colours`), currency scanner (`dollar-sweep`), forbidden file diff validator, and high-speed TypeScript compilation across both apps:
```bash
# Direct script:
bash scripts/checks/guard.sh --fast

# Or via aios CLI:
node forge-control/bin/aios.mjs guard fast
```
Measured on this VPS under real load (~10 lanes, load average 17-26 on 16 cores, 2026-08-23): the cached instrument typecheck inside it takes **15-19s**, not the <2s `PLAN.md` §1.1 targets. Those targets assume an idle box; check `uptime` before treating a slow run as a regression.

### Full Pre-Merge Guard
Runs everything in `--fast` plus Next.js production build (`pnpm build`) and the complete functional gate suite (`gates-808.sh`):
```bash
bash scripts/checks/guard.sh --full
# Or:
node forge-control/bin/aios.mjs guard full
```

### Strict Mode (CI Gate)
Fails if any check is skipped:
```bash
bash scripts/checks/guard.sh --full --strict
# Or:
node forge-control/bin/aios.mjs guard strict
```

### How to Resolve Guard Failures:
- **`no-raw-colours` FAIL**: Replace hardcoded color literals with `tokens.*`. If WebGL/Canvas, add allowlist entry in `scripts/checks/raw-colour-allowlist.txt`.
- **`forbidden-file-diff` FAIL**: Revert edits to shared files (`DesktopApp.tsx`, `nav-items.ts`, `tokens.ts`) and document them in `HANDOFF.md`.
- **`tsc-forge-control` / `tsc-forge-control-web` FAIL**: Fix TypeScript compiler errors at the indicated file and line.

---

## 5. Negative Control Verification (Proving Checks Discriminate)

Before relying on a newly introduced check or validation rule, prove that it **discriminates**:

1. **Break it intentionally**: Put an invalid property or raw color into a test component.
2. **Assert Red**: Confirm the check fails with a non-zero exit code and points to the defect.
3. **Restore code**: Remove the intentional defect.
4. **Assert Green**: Confirm the check passes with exit code `0`.

Run the automated discrimination suite anytime:
```bash
bash scripts/checks/test-guard-discrimination.sh
```
There is **no** `aios guard test-discrimination` subcommand — `handleGuard()` in
`cli-runner.ts` only recognizes `fast`/`full`/`strict` as actions and silently
falls back to `--fast` for anything else. Invoke the script directly.

---

## 6. Capturing Visual Verification Screenshots

For all UI and surface changes, visual verification with screenshots is mandatory.

### Protocol:
1. Ensure the test session cookie is available:
   ```bash
   export FORGE_SESSION_COOKIE="$(cat /tmp/aios-cookie.txt 2>/dev/null || echo '')"
   ```
2. Run the screenshot harness with targeted surface and timestamp:
   ```bash
   SHOT_SURFACES=terminal,projects \
   SHOT_STAMP=$(date -u +%Y%m%dT%H%M%SZ) \
   SHOT_OUT=/opt/ai-os/uploads/$FORGE_RUN_ID \
     node /opt/ai-os/workspace/shots-aios.mjs
   ```
   The stamp must be colon-free compact UTC ISO-8601. `date -u +%Y%m%d%T` yields `2026082316:53:40` — wrong; `date -u +%Y%m%dT%H%M%SZ` yields `20260823T171055Z` — right.
3. Or use the `aios` CLI — the surface is positional, there is no `--url`/`--label`:
   ```bash
   node forge-control/bin/aios.mjs screenshots take projects --out /opt/ai-os/uploads/$FORGE_RUN_ID
   ```
4. Verify the screenshot exists on disk and open/inspect it before claiming visual verification.

---

## 7. `aios` CLI Quick Reference

The `aios` command (`forge-control/bin/aios.mjs`) provides unified CLI tooling:

| Command | Action | Example |
|---|---|---|
| `aios projects list` | List all agent coding projects | `aios projects list` |
| `aios projects create` | Create new multi-agent project | `aios projects create "UI Redesign" --brief "Update styles"` |
| `aios projects pause/resume` | Control project execution | `aios projects pause 323661ce` |
| `aios runs list` | List background agent runs | `aios runs list --project <id> --limit 10` — no `--status` filter |
| `aios runs message` | Send message into an active run | `aios runs message <id> "Proceed with phase 2"` |
| `aios tasks list` | List tasks in project task graphs | `aios tasks list --project 323661ce` |
| `aios tasks retry` | Retry a failed task | `aios tasks retry <task-id>` |
| `aios vault search` | Search Konrad's Obsidian knowledge graph | `aios vault search "Content Forge architecture"` |
| `aios vault today` | View today's daily log note | `aios vault today` |
| `aios vault append` | Append entry to vault note | `aios vault append "Daily/2026-08-23" "### Note
Done."` |
| `aios pipeline status` | Check Content Forge BullMQ queues | `aios pipeline status` (topics: `aios pipeline topics list`) |
| `aios spend summary` | Audit token & LLM costs (3 fixed windows + provider×kind) | `aios spend summary` — no `--days` flag exists |
| `aios terminal list` | List active VPS tmux shells | `aios terminal list` |
| `aios terminal run` | Run a command in a shell you name | `aios terminal run "git status" --session <id>` — `--session` is mandatory; use `--new` for a fresh one |
| `aios guard fast/full` | Execute code guard pre-merge gate | `aios guard fast` |

---

## 8. Final Pre-Commit & Review Checklist

Before finishing your task:
- [ ] Dependencies installed with `--prod=false`.
- [ ] Only declared write-set files modified (`git status`).
- [ ] `cd forge-control-web && npx tsc --noEmit` is clean (exit 0).
- [ ] `cd forge-control && npx tsc --noEmit` is clean (exit 0).
- [ ] `bash scripts/checks/guard.sh --fast` passes with **GUARD: GREEN**.
- [ ] Visual changes captured and verified via screenshot harness.
- [ ] Atomic, conventional git commits made as you go.
