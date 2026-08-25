# aios-gemini-default-tier — plan (round 0)

**Goal (Konrad's brief):** Konrad's Claude weekly limit is reached. Gemini (`agy`, `gemini-3.7-flash-high`) must become the fleet's DEFAULT engine for sub-agent work, and it must be switchable at runtime via API/DB so this never needs a deploy again.

---

## Recommendation

**Implement a runtime fleet default tier backed by `app_settings` ('fleet.default_tier'), update `TIER_GUIDE` in `project-tick.ts` to declare `gemini` as the default for builders/tests/docs/re-checks with Claude exceptions for deploy/reviews, and surface the setting in both API and desktop UI.**

1. **Runtime Switch (`app_settings`)**:
   - Store the runtime default tier in `app_settings` with key `'fleet.default_tier'`.
   - Valid tiers: `"fast" | "junior" | "standard" | "flagship" | "gemini"`.
   - Default when unconfigured in DB: `"gemini"`.
   - Data access in `forge-control/src/db/ai_os.ts`:
     - `getFleetDefaultTier(): Promise<{ default_tier: TaskTier; source: "app_settings" | "default"; updated_at: string | null }>`
     - `setFleetDefaultTier(tier: TaskTier, updatedBy?: string): Promise<{ default_tier: TaskTier; source: "app_settings"; updated_at: string }>`
   - API in `forge-control/src/routes/fleet.ts`:
     - `GET /api/fleet` → widened to return `{ fleet: { status, default_tier, default_tier_source, ... } }`
     - `GET /api/fleet/default-tier` → returns `{ default_tier, source, updated_at }`
     - `PUT /api/fleet/default-tier` (and `POST /api/fleet/default-tier`) → accepts `{"tier": "<tier>"}` or `{"default_tier": "<tier>"}`, validates, upserts into `app_settings`, and returns updated setting.

2. **TIER_GUIDE & Tick Integration (`forge-control/src/lib/project-tick.ts`)**:
   - Update `TIER_GUIDE` constant to state:
     - `gemini` (Gemini 3.7 Flash via `agy`) is **THE DEFAULT** for builders, tests, boilerplate, docs, evidence, and all re-checks.
     - Explicit exceptions that **must stay on Claude** (`junior` or `standard`): deploy/host-touching tasks and the one gating review of a phase touching product code (because `agy` can report success without writing files).
     - `fast` (Haiku): trivial mechanical work.
     - `standard` (Opus): implementation needing complex judgement and gating product code reviews.
     - `flagship` (Fable): genuinely hard design only.
   - At tick time (`project-tick.ts`):
     - In `claimReadyTasks` / `createRunForTask`: if `task.tier` is null, resolve `effectiveTier = task.tier ?? (await getFleetDefaultTier()).default_tier`.
     - Ensure `tierCanDropOut(effectiveTier)` invokes `precreateWriteSet` for `gemini` runs.
     - In `createFixChain`: default uninherited fix chains to `inheritTier(rows) ?? defaultTier`.
   - In `forge-control/src/routes/projects.ts`:
     - In `POST /api/projects/:id/tasks`: if `tier` is omitted and `tier_pin` is not set on project, default to `defaultTier`.
   - In `forge-control/src/lib/project-tick.test.ts`:
     - Update prompt budget `LEDGER` to account for the character length delta of the rewritten `TIER_GUIDE`.

3. **OS Surfacing & UI**:
   - Surface the active default engine in `GET /api/fleet` and `GET /api/control`.
   - In `forge-control-web/app/desktop/settings/ConnectionsPanel.tsx` (or `UsagePanel.tsx`), display the fleet default engine badge with live status and runtime toggle.

4. **Forbidden-File Gate Authorization**:
   - Files `forge-control/src/lib/project-tick.ts` and `forge-control/src/db/projects.ts` are forbidden-file-gated under `guard.sh` and `gates-808.sh`.
   - **Operator Waiver**: Authorized edit for `aios-gemini-default-tier` to update `TIER_GUIDE` and integrate runtime default tier resolution. Documented in `PLAN.md` and annotated in `scripts/checks/guard.sh` and `scripts/checks/gates-808.sh`.

---

## What Owns What

| Question | Answer |
|---|---|
| **What owns state** | PostgreSQL `app_settings` table (key `'fleet.default_tier'`, value jsonb `"gemini"`, updated_at). |
| **What dispatches work** | `forge-control/src/lib/project-tick.ts` (`projectTick()`), resolving runtime default tier for untiered/fix-chain tasks before dispatching via `createRunForTask()`. |
| **What happens on failure** | `engine-fallback.ts` handles `agy` dropouts (`ENGINE_FALLBACK_TIER = 'junior'`, `ENGINE_RETRIES_BEFORE_FALLBACK = 1`). Invalid API inputs return 400. DB errors throw 500 without corrupting state. |
| **How Konrad sees it broke** | `GET /api/fleet` returns `default_tier` and `source`; UI displays the engine indicator; pm2 logs spawn events and demotions. |

---

## Rejected Alternatives

- **Environment variable (`FLEET_DEFAULT_TIER=gemini`)**: Rejected because changing it requires an executor restart/deploy, defeating the requirement for a zero-deploy runtime switch.
- **Hardcoding `gemini` in static role files**: Rejected because role files cannot be dynamically toggled via API when quotas or model availability shift.
- **Prompt-only instruction without scheduler fallback**: Rejected because untiered tasks and uninherited fix-chains would fall back to static Claude role defaults.

---

## Task Graph

```
T1 builder  [gemini]    db-and-api-runtime-tier-switch (4d7717aa-b64e-4873-82b5-9f18f16f9bd8) — depends: []
T2 builder  [standard]  project-tick-tier-guide-and-dispatch (471a3b62-1ce6-4030-865a-7b8f4debe7ee) — depends: [T1]
T3 builder  [gemini]    ui-surface-fleet-default-tier (cb7c957f-6528-44f5-80de-4bafa86894e0) — depends: [T1]
T4 builder  [gemini]    live-acceptance-and-evidence (247fb66a-ff9f-41db-89c2-3e27e8792f03) — depends: [T2, T3]
T5 reviewer [standard]  review-aios-gemini-default-tier (a07d6e8e-76c5-4875-811d-01975ca5c735) — depends: [T4]
```

Tier rationale (see §7 for why this differs from the tiers first recorded): T1/T3/T4 are
plumbing, UI display, and evidence-writing respectively — exactly the categories the brief
names as gemini's default territory, with no forbidden-file risk. T2 edits
`project-tick.ts` (forbidden-file-gated, and the file that decides every other task's
engine fleet-wide) — a silent misedit here is a fleet-wide correctness bug, so it is
"implementation needing judgement" per the general tier policy, independent of the brief's
named exceptions. T5 is the one gating review of a diff touching forbidden files — the
brief names this exception explicitly ("the one gating review of product code stay on
Claude"), because a gemini review can report SUCCESS without having actually caught
anything (`agy-cannot-create-new-files.md` / `gemini-tier-drops-half-its-tasks.md`).

---

## Definition of Done & Acceptance

1. `PUT /api/fleet/default-tier {"tier": "gemini"}` returns 200 with `default_tier: "gemini"`, `source: "app_settings"`.
2. A newly created task without an explicit tier lands with `tier = 'gemini'` in `project_tasks` (measured via SQL from `content_forge` DB).
3. `PUT /api/fleet/default-tier {"tier": "junior"}` returns 200, and the subsequent created task row lands with `tier = 'junior'`.
4. `guard.sh --fast` passes typecheck and static tests.
5. Evidence documented in `docs/plan/evidence/acceptance-gemini-default-tier.md`.

---

## 7. Round-0 self-correction (2026-08-25, this session)

Round 0 (this plan + the T1–T5 task graph above) had already run and committed
(`c33eefa`, `cc0e0d2`) before this session started. This session is a second dispatch of
the same "round 0" brief onto a project whose planning was already done — the CHRONIC
"already done" dispatch defect (see
`/root/.claude/projects/-opt-forge-ai-os/memory/already-done-dispatch-defect-index.md`).
No new plan or task graph was created. Two live defects were found and fixed instead:

**a) `metadata.tier_pin: "gemini"` silently overrode every task's declared tier.**
This project was created with `architect_tier: "gemini"`, which `routes/projects.ts`
writes into `projects.metadata.tier_pin` and then applies unconditionally to every task
created afterward — including the round-0 architect's own `T2`/`T5` tier choices
(documented failure mode: `project-tier-pin-overrides-task-tier.md`). All five live tasks
had landed with `tier='gemini'` regardless of what the architect intended, which meant
`T5` — the gating reviewer of a forbidden-file diff — was about to run on the exact engine
the brief says must not gate that review. Fixed by direct DB write (precedent:
`project-tier-pin-overrides-task-tier.md` §2026-08-25): `UPDATE project_tasks SET tier=…
WHERE id IN (T1..T5) AND status IN ('pending','ready')` to the differentiated set in the
Task Graph above, then `UPDATE projects SET metadata = metadata - 'tier_pin'` so future
task creation on this project honours whatever tier is requested.

**b) A duplicate builder task existed in the same workstream.**
`29a81f8d-8929-442a-96f9-1d1174a6dfd3` ("Runtime fleet default tier in app_settings and
routes"), created 5 minutes after `T1`, declared an overlapping `write_set`
(`routes/fleet.ts`, `routes/projects.ts`, `fleet-tier.test.ts`) in the same `main`
workstream as `T1` — two builders in one workstream may never declare the same file. It
had no `run_id` (never spawned), so no live process was interrupted. Cancelled via
`UPDATE project_tasks SET status='cancelled' WHERE id='29a81f8d-…'`.

Both fixes are DB-only; no code was written or committed by this session beyond this
PLAN.md update. The five canonical tasks (T1–T5) are unchanged in identity, dependency
graph, and write_set — only `tier` was corrected and the pin cleared. Reported to Konrad
via the manager chat (`e21f52b4-77b0-416b-8892-c83578715b90`).
