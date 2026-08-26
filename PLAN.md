# aios-ops-inventory-red — plan (round 0)

**Goal.** Resolve the persistent gate failure on `main` where `scripts/checks/check-ops-scripts.sh` exits 1 due to `scripts/ops/assert-merge-scope.sh` and `scripts/ops/recover-stuck-task.sh` missing from the `FILES` array in `scripts/ops/install-symlinks.sh`. Make the repo gate suite `gates-808` green on this gate and ensure the recovery/merge tools are properly symlinked into `/opt/ai-os/scripts/` upon deploy.

## Recommendation

Add `assert-merge-scope.sh` and `recover-stuck-task.sh` to the `FILES` array in `scripts/ops/install-symlinks.sh`. Do not add either script to `RESTRICTED_MODE_FILES` or `EXEC_MODE_FILES`.

### Reasoning
1. **Inventory Consistency**: `install-symlinks.sh` manages symlinks for all operational scripts from `scripts/ops/` into `/opt/ai-os/scripts/`. `check-ops-scripts.sh` enforces parity between files in `scripts/ops/` and the `FILES` array in `install-symlinks.sh`. Both `assert-merge-scope.sh` and `recover-stuck-task.sh` exist on disk but were not registered in `FILES`, causing `check-ops-scripts.sh` (and thus `gates-808.sh`) to fail on pristine `main`.
2. **Mode Classification**:
   - `RESTRICTED_MODE_FILES`: Reserved solely for files embedding private keys / host credentials (such as `check-vps2-backup.sh` which requires mode `750`). `assert-merge-scope.sh` is a pure git diff validator and `recover-stuck-task.sh` loads environment credentials dynamically at runtime via `/opt/ai-os/.secrets/forge-control.env`. Neither needs 750 mode.
   - `EXEC_MODE_FILES`: Defensive belt-and-braces list for the PreToolUse hook Python scripts and hook installation/test scripts (`guard-*.py`, `test-guard-*.py`, `install-hooks.sh`) invoked by Claude CLI. Neither script is a PreToolUse hook; standard git tracking (`755` executable) suffices.

### Rejected Alternatives
- **Adding scripts to `RESTRICTED_MODE_FILES`**: Rejected — unnecessary restriction as neither script embeds secrets or requires 750 mode.
- **Adding scripts to `EXEC_MODE_FILES`**: Rejected — neither script is a PreToolUse hook requiring defensive hook-execution chmod.
- **Softening `check-ops-scripts.sh` to ignore unregistered scripts**: Rejected — violates inventory policy and masks uninstalled ops tooling.
- **Running `install-symlinks.sh` inside the project worktree**: Rejected — `install-symlinks.sh` explicitly refuses to run from worktrees to prevent creating dangling symlinks when worktrees are cleaned up.

---

## State · Dispatch · Failure Modes · Operator Visibility

- **What owns state**:
  - Repo inventory: `scripts/ops/install-symlinks.sh` (`FILES` array) and `scripts/ops/` filesystem contents.
  - Host symlinks: `/opt/ai-os/scripts/` symlinks pointing to `/opt/forge-ai-os/scripts/ops/*`.
- **What dispatches work**:
  - In-lane validation: Builder runs `scripts/checks/check-ops-scripts.sh` and mutation controls.
  - Repo gate suite: `scripts/checks/gates-808.sh` line 381 executes `check-ops-scripts.sh`.
  - Host deploy: Deploy task runs `scripts/ops/install-symlinks.sh` from the live checkout `/opt/forge-ai-os`.
- **What happens on failure**:
  - If a file is missing from `FILES`, `check-ops-scripts.sh` prints a diff of expected vs actual and exits 1.
  - If `install-symlinks.sh` is run in a worktree, it halts immediately with exit 1 and a descriptive refusal.
- **How Konrad sees it broke**:
  - Repo gate status: `gates-808` reports gate failure on `check-ops-scripts.sh`.
  - Host scripts: `ls -la /opt/ai-os/scripts/assert-merge-scope.sh` / `recover-stuck-task.sh` would show missing or broken symlinks.

---

## Task Graph

```
T1 builder (gemini, main)
  Register assert-merge-scope.sh and recover-stuck-task.sh in install-symlinks.sh
  │
  ▼
T2 reviewer (standard, main)
  Review diff, verify check-ops-scripts.sh PASS, mutation proof & gates-808
  │
  ▼
T3 deploy builder (junior, main)
  Deploy symlinks on live checkout /opt/forge-ai-os & verify live resolution
```

### Tasks Detail

1. **T1 (Builder, tier: gemini, workstream: main, depends_on: [])**
   - **Title**: Register assert-merge-scope.sh and recover-stuck-task.sh in install-symlinks.sh
   - **Write Set**: `["scripts/ops/install-symlinks.sh"]`
   - **Actions**:
     - Edit `scripts/ops/install-symlinks.sh` to add `assert-merge-scope.sh` and `recover-stuck-task.sh` to the `FILES` array.
     - Run `bash scripts/checks/check-ops-scripts.sh` and verify exit 0.
     - Execute mutation control: temporarily delete an entry from `FILES`, verify `check-ops-scripts.sh` fails with exit 1, restore and verify exit 0.
     - Run `bash scripts/checks/gates-808.sh` and verify gate status.
     - Commit changes cleanly.

2. **T2 (Reviewer, tier: standard, workstream: main, depends_on: [T1])**
   - **Title**: Review ops scripts registration and gate-808 status
   - **Write Set**: `[]`
   - **Actions**:
     - Review diff against base branch: verify only `scripts/ops/install-symlinks.sh` was modified.
     - Verify `check-ops-scripts.sh` passes and mutation proof is recorded in builder notes.
     - Run `bash scripts/checks/gates-808.sh --strict` (apply sibling contention rule if unrelated unit tests flake once).
     - Issue review verdict.

3. **T3 (Deploy Builder, tier: junior, workstream: main, depends_on: [T2])**
   - **Title**: Deploy ops symlinks to /opt/ai-os/scripts and verify live
   - **Write Set**: `["deploy/aios-ops-inventory-red.md"]`
   - **Actions**:
     - Merge branch to main on live checkout `/opt/forge-ai-os`.
     - Run `scripts/ops/install-symlinks.sh` from `/opt/forge-ai-os`.
     - Verify symlinks resolve: `ls -la /opt/ai-os/scripts/assert-merge-scope.sh` and `ls -la /opt/ai-os/scripts/recover-stuck-task.sh`.
     - Run `bash scripts/checks/check-ops-scripts.sh` from `/opt/forge-ai-os` and show exit 0.
     - Write deploy record `deploy/aios-ops-inventory-red.md`.
