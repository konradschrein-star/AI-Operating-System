# aios-backfill-ledger-out-of-tree — plan (round 0)

**Goal.** Relocate the runtime `origin_chat_id` backfill ledger out of the git repository tree (`/var/log/forge/chat-linkage-backfill.log`) so that live engine operations no longer dirty tracked files in the live checkout (`/opt/forge-ai-os`). This makes the mandatory `REVIEWER_LIVE_CHECK` (`git -C <live> status --porcelain`) cleanly achievable without weakening or allowlisting the rule.

---

## 1. Recommendation

Relocate `BACKFILL_LOG` in `forge-control/src/routes/chat-linkage.ts` from `docs/plan/artifacts/phase300/backfill.log` to `/var/log/forge/chat-linkage-backfill.log` (with `process.env.FORGE_BACKFILL_LOG` fallback/override for testability).

1. **Out-of-tree runtime logging**: Define `BACKFILL_LOG = process.env.FORGE_BACKFILL_LOG ?? "/var/log/forge/chat-linkage-backfill.log"`.
2. **Directory creation & Non-throwing error handling**: In `backfillOriginChatId()`, ensure `await mkdir(path.dirname(BACKFILL_LOG), { recursive: true })` creates `/var/log/forge` if missing. Keep the `try ... catch` block that catches append/directory errors, logs loudly to `console.error`, and never throws to the caller.
3. **Preserve existing history**: `docs/plan/artifacts/phase300/backfill.log` remains in git as a frozen historical artifact. It must NOT be deleted.
4. **Preserve cleanliness gate absolutism**: `REVIEWER_LIVE_CHECK` in `forge-control/src/lib/project-tick.ts` must remain byte-identical to `main`. Do NOT add path exceptions or allowlists.
5. **One-shot dirt clearance in Deploy**: In the Deploy task running in `/opt/forge-ai-os` (authorized by fleet supervisor), commit the single uncommitted audit line in `docs/plan/artifacts/phase300/backfill.log` with a clear commit message, verifying `git status --porcelain` is clean before and after merging.

---

## 2. Reasoning

1. **Root Cause Resolution**: The live engine's runtime backfill of `origin_chat_id` previously wrote to `docs/plan/artifacts/phase300/backfill.log` in the live checkout. Because this file is git-tracked, every chat-linked project permanently dirtied `/opt/forge-ai-os`, causing `REVIEWER_LIVE_CHECK` to fail on valid runs.
2. **Rule Integrity**: Moving the runtime log target outside the repository tree (`/var/log/forge/`) removes the violation at its source. The reviewer cleanliness check's strength lies in its absolutism ("empty output is the only pass"). An allowlist would rot and introduce ambiguity.
3. **Operational Alignment**: `/var/log/forge/` is the standard destination for runtime daemon and ops logs across Konrad's VPS infrastructure (e.g. guard autonomy, pulse, safe restart logs).
4. **Narrow Blast Radius**: `BACKFILL_LOG` is referenced exclusively within `forge-control/src/routes/chat-linkage.ts` (lines 370, 384 doc comment, 404, 410) and nowhere else in the codebase.

---

## 3. Rejected Alternatives

- **Adding an allowlist/exception to `REVIEWER_LIVE_CHECK`**: Rejected — weakens the universal cleanliness gate and encourages exception creep.
- **Deleting `docs/plan/artifacts/phase300/backfill.log`**: Rejected — contains committed historical audit data; deleting tracked files is unauthorized.
- **Reverting or stashing `/opt/forge-ai-os` dirt**: Rejected — stash is shared across worktrees (`git-stash-is-shared-across-worktrees.md`) and reverting would discard a valid project linkage audit entry.
- **Relocating ledger into PostgreSQL table**: Rejected — unnecessary database schema change when standard host filesystem logging `/var/log/forge/` satisfies audit requirements without migration overhead.

---

## 4. State · Dispatch · Failure Modes · Operator Visibility

- **What owns state**:
  - Audit log: `/var/log/forge/chat-linkage-backfill.log` on VPS host.
  - Project linkage: `projects.metadata.origin_chat_id` in PostgreSQL (`content_forge`).
- **What dispatches work**:
  - Runtime linkage resolution in `forge-control/src/routes/chat-linkage.ts` (`resolveChatProject`).
- **What happens on failure**:
  - If `/var/log/forge` cannot be created or appended to (e.g. permissions or disk issue), `backfillOriginChatId` catches the error, outputs `[chat-linkage] backfill.log append failed` to `console.error`, and allows the resolution to complete successfully since the database row was already committed.
- **How Konrad sees it broke**:
  - pm2 logs for `forge-control` will show `[chat-linkage] backfill.log append failed (...)`.
  - Reviewer gates (`git -C /opt/forge-ai-os status --porcelain`) will flag any unexpected dirt.

---

## 5. Task Graph

```
T1 builder (gemini, main)
  Relocate backfill ledger to /var/log/forge/chat-linkage-backfill.log & add tests
  │
  ▼
T2 reviewer (standard, main)
  Review diff, verify REVIEWER_LIVE_CHECK byte-identical to main, verify out-of-tree path & tests
  │
  ▼ (round 20 band)
T3 deploy builder (junior, main)
  Deploy: commit live backfill audit line, merge branch & restart forge-control
```

---

## 6. Task Specifications

### T1: Builder (Role: `builder`, Tier: `gemini`, Workstream: `main`, Depends On: `[]`)
- **Title**: Relocate backfill ledger to /var/log/forge/chat-linkage-backfill.log & add tests
- **Write Set**: `["forge-control/src/routes/chat-linkage.ts", "forge-control/src/routes/chat-linkage.test.ts"]`
- **Instructions**:
  1. In `forge-control/src/routes/chat-linkage.ts`:
     - Import `mkdir` from `node:fs/promises`.
     - Update `BACKFILL_LOG`:
       ```typescript
       const BACKFILL_LOG =
         process.env.FORGE_BACKFILL_LOG ??
         "/var/log/forge/chat-linkage-backfill.log";
       ```
     - In `backfillOriginChatId()`, add `await mkdir(path.dirname(BACKFILL_LOG), { recursive: true });` inside the `try` block before `appendFile(BACKFILL_LOG, ...)`.
     - Update the doc comment at line 384 referencing the new log path.
     - Keep the `try / catch` error handler intact (`console.error` on failure without throwing).
  2. Create unit tests in `forge-control/src/routes/chat-linkage.test.ts`:
     - Test default `BACKFILL_LOG` points to `/var/log/forge/chat-linkage-backfill.log`.
     - Test custom `FORGE_BACKFILL_LOG` environment variable override works, creates parent directories recursively when missing, and appends the formatted audit line.
     - Test error handling when writing to a path that fails (e.g. read-only path) logs to `console.error` and does not throw.
  3. Ensure `pnpm --prefix forge-control test` and `pnpm --prefix forge-control typecheck` pass with zero errors.
  4. DO NOT touch `forge-control/src/lib/project-tick.ts` or `forge-control/src/db/projects.ts`.
  5. DO NOT delete or edit `docs/plan/artifacts/phase300/backfill.log`.

### T2: Reviewer (Role: `reviewer`, Tier: `standard`, Workstream: `main`, Depends On: `[T1]`)
- **Title**: Review out-of-tree ledger relocation & verify reviewer live check unchanged
- **Write Set**: `[]`
- **Instructions**:
  1. Verify diff of `forge-control/src/routes/chat-linkage.ts` and `forge-control/src/routes/chat-linkage.test.ts`.
  2. Verify `BACKFILL_LOG` is `/var/log/forge/chat-linkage-backfill.log`.
  3. Verify `mkdir(path.dirname(BACKFILL_LOG), { recursive: true })` ensures directory exists.
  4. Verify error handling catches append failures without throwing.
  5. Verify `REVIEWER_LIVE_CHECK` in `forge-control/src/lib/project-tick.ts` is byte-identical to `main` (`git diff main...HEAD -- forge-control/src/lib/project-tick.ts` is empty).
  6. Verify `docs/plan/artifacts/phase300/backfill.log` is untouched in the worktree.
  7. Run typecheck and tests.

### T3: Deploy Builder (Role: `builder`, Tier: `junior`, Workstream: `main`, Round: 20, Depends On: `[T2]`)
- **Title**: Deploy: commit live backfill audit line, merge project branch & restart forge-control
- **Write Set**: `["docs/plan/artifacts/phase300/backfill.log", "deploy/aios-backfill-ledger-out-of-tree.md"]`
- **Instructions**:
  1. In the live checkout `/opt/forge-ai-os` (authorized by fleet supervisor):
     - Check `git -C /opt/forge-ai-os status --porcelain`.
     - Confirm the ONLY dirty file is `docs/plan/artifacts/phase300/backfill.log`. If anything else is dirty, stop and report immediately.
     - Commit the file:
       `git -C /opt/forge-ai-os add docs/plan/artifacts/phase300/backfill.log`
       `git -C /opt/forge-ai-os commit -m "chore(audit): commit engine-written backfill line to clear live checkout dirt, appending moved out-of-tree"`
     - Confirm `git -C /opt/forge-ai-os status --porcelain` is now EMPTY.
  2. Merge `project/5b9b85e7` into `main` in `/opt/forge-ai-os`.
  3. Restart `forge-control` via `pm2 restart forge-control` (or safe-restart).
  4. Prove control:
     - Verify `git -C /opt/forge-ai-os status --porcelain` remains EMPTY.
     - Verify writing a backfill record writes to `/var/log/forge/chat-linkage-backfill.log` and leaves `/opt/forge-ai-os` completely clean.
  5. Write deploy record to `deploy/aios-backfill-ledger-out-of-tree.md`.
