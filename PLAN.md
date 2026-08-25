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
T1 builder [standard]   DB & API: app_settings helper & /api/fleet/default-tier routes (depends: [])
T2 builder [standard]   Engine: TIER_GUIDE, project-tick default tier & budget ledger (depends: [T1])
T3 builder [standard]   UI: Surface default tier in desktop settings panel (depends: [T1])
T4 builder [standard]   Verification: API toggle, tick DB measurement & acceptance evidence (depends: [T2, T3])
T5 reviewer [standard]  Gating Review: Review full diff against requirements (depends: [T4])
```

---

## Definition of Done & Acceptance

1. `PUT /api/fleet/default-tier {"tier": "gemini"}` returns 200 with `default_tier: "gemini"`, `source: "app_settings"`.
2. A newly created task without an explicit tier lands with `tier = 'gemini'` in `project_tasks` (measured via SQL from `content_forge` DB).
3. `PUT /api/fleet/default-tier {"tier": "junior"}` returns 200, and the subsequent created task row lands with `tier = 'junior'`.
4. `guard.sh --fast` passes typecheck and static tests.
5. Evidence documented in `docs/plan/evidence/acceptance-gemini-default-tier.md`.
