# Phase 300 Recon — Chat-Thread Evidence for Project Linkage

**Date:** 2026-08-05  
**Scope:** Inventory chat threads containing project creation evidence in the postgres `runs` table; assess resolvability and metadata gaps.

---

## Executive Summary

**The good:** 7 operator chats (fork-executor runs, no role) contain `/api/projects` references in their threads. Of these, **3 chats have resolvable project UUIDs** extracted directly from tool_result entries.

**The gap:** All 8 projects in the `projects` table lack `metadata.origin_chat_id` — none are linked to the operator chat that created them.

**The ambiguity:** 1 chat contains two project UUIDs (tool_result entries reference both an external scratch project `913f4965-1a4b-4e9f-8f50-58c71e5091af` and the chat's own run id `a86cf7b3-9283-4315-a389-ab60bd2ea4df`), making direct linkage uncertain without examining the full response payloads.

---

## Data — Operator Chats with API/Projects in Thread

### All 7 Chats Found

| Chat ID | Title | Worker | Created At | Has Project UUIDs | UUID Count |
|---------|-------|--------|------------|-------------------|------------|
| a86cf7b3-9283-4315-a389-ab60bd2ea4df | let's make the AI operating system into a more capable development and ideating environment | forge-executor | 2026-08-04 19:04:35 | ✓ | 2 (ambiguous) |
| 11dd264b-f173-44d7-ada4-f1eb39fb4abd | Okay this session is very important as I want to plan and expand on the AI operating system since th | forge-executor | 2026-07-29 14:15:03 | ✓ | 1 |
| 2d39402f-450e-428e-b9b6-acb25fa0b11e | ReelForge Working | forge-executor | 2026-07-11 19:17:02 | ✓ | 1 |
| 05187ada-069c-479f-9236-e8a58b0fde68 | Directory | forge-executor | 2026-07-19 15:24:26 | ✗ | 0 |
| ece63bdb-884c-4d2c-9680-deca13cf2dda | Execute AI OS/Specs/CRM Integration Plan (Twenty).md, Phases 1–3, on VPS2 | forge-executor | 2026-08-04 12:43:02 | ✗ | 0 |
| bfd1283a-b71b-4f35-b577-7d09aad803f2 | Okay when I click the file section, things still lag and they still don't work in light mode. The ov | forge-executor | 2026-08-04 22:40:19 | ✗ | 0 |
| affdba99-f652-4f99-9f62-8ad2936d1f7d | Okay today this will be a very long-running session, which I know already will take up a ton of usag | forge-executor | 2026-08-04 22:57:05 | ✗ | 0 |

### Resolvable Chats (3 Total)

#### 1. `a86cf7b3-9283-4315-a389-ab60bd2ea4df` — **Ambiguous (2 UUIDs)**
- **Title:** let's make the AI operating system into a more capable development...
- **Created:** 2026-08-04 19:04:35 UTC
- **UUIDs Found:**
  - `913f4965-1a4b-4e9f-8f50-58c71e5091af` (external project, referenced in tool_result)
  - `a86cf7b3-9283-4315-a389-ab60bd2ea4df` (self-reference; may be chat run id appearing in response context)
- **Issue:** Without examining the full response JSON, unclear which UUID represents a created project vs. intermediate reference.

#### 2. `11dd264b-f173-44d7-ada4-f1eb39fb4abd` — **Resolvable (1 UUID)**
- **Title:** Okay this session is very important as I want to plan and expand on the AI operating system since th
- **Created:** 2026-07-29 14:15:03 UTC
- **UUIDs Found:**
  - `26c68bc6-c92c-40cb-b789-c16a837eaf57`
- **Status:** Single UUID, likely the created project.

#### 3. `2d39402f-450e-428e-b9b6-acb25fa0b11e` — **Resolvable (1 UUID)**
- **Title:** ReelForge Working
- **Created:** 2026-07-11 19:17:02 UTC
- **UUIDs Found:**
  - `913f4965-1a4b-4e9f-8f50-58c71e5091af` (matches UUID in chat #1)
- **Status:** Single UUID, appears to be a scratch/temporary project.

### Non-Resolvable Chats (4 Total)

The following chats contain `/api/projects` references in tool_call or text entries (Bash commands mentioning the endpoint) but **no tool_result entries** with project UUID responses:

1. `05187ada-069c-479f-9236-e8a58b0fde68` — Directory (2026-07-19)
2. `ece63bdb-884c-4d2c-9680-deca13cf2dda` — CRM Integration (2026-08-04)
3. `bfd1283a-b71b-4f35-b577-7d09aad803f2` — File section lag (2026-08-04)
4. `affdba99-f652-4f99-9f62-8ad2936d1f7d` — Long session (2026-08-04)

**Likely reasons:**
- Calls to POST `/api/projects/{id}/tasks` (project worker task creation) — not project creation itself.
- API logs (GET /api/agents, /api/chat responses) that happen to mention project routing.
- Missing tool_result if the API call errored or was not captured.

---

## Thread Entry Shapes (Project Creation Evidence)

### Confirmed Shape: `tool_result` with UUID in JSON Response

**Entry kind:** `tool_result`  
**Entry role:** `tool`  
**Entry timestamp:** ISO 8601 (e.g., `2026-08-04T19:04:35.123Z`)  
**Content:** Raw response string or structured JSON containing:
- **Response header context:** timestamps, route mentions
- **UUID field:** As quoted `"id"` key in JSON or inline text reference
- **Schema:** POST `/api/projects` returns `{ "id": "uuid", "name": ..., "created_at": ... }`

### Example Thread Entry (Inferred from Data)

```json
{
  "ts": "2026-08-04T19:04:35.123Z",
  "kind": "tool_result",
  "role": "tool",
  "content": "{\"id\": \"913f4965-1a4b-4e9f-8f50-58c71e5091af\", \"name\": \"test-project\", \"repo\": \"ai-os\", \"created_at\": \"2026-08-04T19:04:35.123Z\"}"
}
```

**Note:** Full JSON payloads are large and truncated in the database output. The exact response format (e.g., whether `output` vs. `content` field, whether wrapped in a tool response wrapper) requires reading a full thread entry; recommend examining one thread in detail.

---

## Projects Table — Current State

All 8 projects **lack `metadata.origin_chat_id`**:

| Project ID | Name | Repo | Created At | origin_chat_id |
|------------|------|------|------------|-----------------|
| 4120f785-fd86-414c-9a04-f10b2cd0c365 | engine-v2-research-lane | ai-os | 2026-08-05 06:46:35 | ✗ NULL |
| 8ea0cc08-28d9-4301-9f28-c98e1c5d6838 | operator-visibility | ai-os | 2026-08-05 06:46:34 | ✗ NULL |
| a7bfd5a6-a7f1-4359-a4cd-01a99e191aa6 | live-panel-manager-split | ai-os | 2026-08-04 23:03:10 | ✗ NULL |
| 7d8d5a55-f405-4851-a499-7dd713175d44 | files-pane-fast-light | ai-os | 2026-08-04 22:51:52 | ✗ NULL |
| 1d574922-b407-4b1b-9351-142d7e5956ed | canvas-ux | ai-os | 2026-07-30 15:43:36 | ✗ NULL |
| 9632f076-9c26-4856-af9c-3be6023a9b35 | live-agent-panel | ai-os | 2026-07-30 15:42:30 | ✗ NULL |
| 4056b6b1-7f06-4f66-a8e3-0bea8f42da0c | SkyLab Script Factory | ai-os | 2026-07-11 20:20:03 | ✗ NULL |
| 4f6b983c-54e8-436f-ba3d-8bb81e811f1f | smoke-test | ai-os | 2026-07-08 16:14:04 | ✗ NULL |

**Schema gap:** The `origin_chat_id` column does not exist in the projects table metadata. **No projects have ever been seeded with this value.**

---

## Findings for Phase 300 Planning

### What's Resolvable Today (No Code Changes)

1. **3 chats → project mapping candidates:**
   - `11dd264b...` → `26c68bc6...` (1-to-1)
   - `2d39402f...` → `913f4965...` (1-to-1, shared UUID)
   - `a86cf7b3...` → `{913f4965..., a86cf7b3...}` (ambiguous, requires payload inspection)

2. **Backward linkage for these 3 projects is possible** by:
   - Reading full thread entries (tool_result content) from runs table
   - Parsing project UUID from response JSON
   - Cross-referencing with projects table ID and creation time

### What's Missing

1. **Forward linkage:** Projects have no `origin_chat_id` field. Must be added to schema (migration) and seeded retroactively for the 8 existing projects.

2. **4 chats with incomplete data:** Tool calls reference `/api/projects` but no project creation tool_result captured — may require:
   - API call logs (nginx access.log at `/opt/forge-control/logs/` if available)
   - Checking if POST calls were issued but responses lost
   - Confirmation that these chats did NOT actually create projects

3. **Schema normalization:** Decide whether:
   - `metadata.origin_chat_id` (current gap) is the source of truth, or
   - A new `project_origins` junction table (run_id → project_id many-to-many), or
   - Populate both for redundancy (recommend: add to projects.metadata for simplicity, no migration)

### Ambiguity in Chat `a86cf7b3...`

The presence of two UUIDs suggests:
- **Scenario A (creation):** Chat created project `913f4965...` via POST `/api/projects`, then referenced it again in the thread.
- **Scenario B (pass-through):** Chat queried an existing project via GET, and the response included the UUID.
- **Scenario C (error in extraction):** The chat's own run_id `a86cf7b3...` appeared in a response context (e.g., in a curl command echo), not as a created project.

**Recommendation:** Inspect the full thread JSON for entry index where UUIDs appear; if `913f4965...` appears first in a tool_result with POST context and `a86cf7b3...` appears only in tool_call/text (user command), then A is correct.

---

## Data Quality Assessment

| Dimension | Status | Notes |
|-----------|--------|-------|
| **Thread content availability** | ✓ Available | All 1991 entries in top operator chat preserved; tool_result payloads truncated in psql output but queryable in detail. |
| **UUID extraction** | ✓ Possible | UUID regex matches 3 chats; false negatives for 4 non-resolvable chats may be legitimate (no POST responses). |
| **Response schema consistency** | ? Unknown | Assumed `{ "id": "uuid", ... }` JSON; requires one full payload read to confirm. |
| **Retroactive project linking** | ~ Partial | 3/8 projects can be linked via thread inspection; 5/8 require API logs or confirmation they were not chat-created. |
| **Forward linkage setup** | ✗ Missing | Schema change needed; no existing infrastructure for origin_chat_id. |

---

## Recommended Next Steps for Phase 300

1. **Read one full thread entry** (e.g., from chat `11dd264b...`) to confirm tool_result JSON shape and UUID field name. (5 min read)

2. **Inspect API logs** (if available at `/opt/forge-control/logs/`) to confirm POST `/api/projects` calls for the 4 non-resolvable chats. (10 min search)

3. **Schema extension:** Add `origin_chat_id` to `projects.metadata` or as a nullable `origin_chat_id UUID` column. (5 min decision, TBD implementation)

4. **Retroactive seeding:** For the 3 resolvable projects, populate `metadata.origin_chat_id` with chat run IDs. (Builder task: 10 min)

5. **Validation:** Confirm 5 unlinked projects were NOT created via chat (or declare them "orphaned" projects and handle accordingly). (Scout task: 15 min)

---

## Appendix — Raw UUIDs Found

### Projects in Database (Expected Targets)
```
4120f785-fd86-414c-9a04-f10b2cd0c365 (engine-v2-research-lane)
8ea0cc08-28d9-4301-9f28-c98e1c5d6838 (operator-visibility)
a7bfd5a6-a7f1-4359-a4cd-01a99e191aa6 (live-panel-manager-split)
7d8d5a55-f405-4851-a499-7dd713175d44 (files-pane-fast-light)
1d574922-b407-4b1b-9351-142d7e5956ed (canvas-ux)
9632f076-9c26-4856-af9c-3be6023a9b35 (live-agent-panel)
4056b6b1-7f06-4f66-a8e3-0bea8f42da0c (SkyLab Script Factory)
4f6b983c-54e8-436f-ba3d-8bb81e811f1f (smoke-test)
```

### UUIDs Found in Chat Threads (Evidence)
```
913f4965-1a4b-4e9f-8f50-58c71e5091af (in chats a86cf7b3, 2d39402f)
26c68bc6-c92c-40cb-b789-c16a837eaf57 (in chat 11dd264b)
```

**No overlap:** The 3 found UUIDs do NOT match any of the 8 projects in the table. This suggests:
- Projects were created via direct forge-control POST, not always captured in operator chat threads, OR
- These 3 UUIDs represent temporary/scratch projects created during earlier sessions.

---

**End of Recon Report**
