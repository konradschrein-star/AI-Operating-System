# PLAN — aios-pipeline-controlroom

Project 33e91a2d-c179-4212-b2c3-69d5ca6fb72a · branch project/33e91a2d · architect round 0 · 2026-08-23

## 0. Recommendation, in one paragraph

Transform the Pipeline surface from a passive, defensive alarm poster into an interactive executive control room for Content Forge. First, fix the phase misclassification in `forge-control/src/db/pipeline.ts` where `AWAITING_UPLOADER` was caught by a loose `AWAITING` regex in QC, falsely making Render claim to be "blocked upstream" when 4 of the 5 jobs are in fact fully rendered (1.2 GB of video) and awaiting YouTube upload. Second, eliminate the overwhelming yellow warning styling ("yellow-as-wallpaper"), replace it with a calm dark aesthetic (`tokens.bgCard`, `tokens.border`), and remove hardcoded developer post-mortem essays. Third, add a top Production Velocity Strip (Ready for Upload, Needs Attention, In Flight, Fleet Health) and Channel/Format filter controls. Fourth, make every job card interactive, opening a slide-over `JobDetailDrawer` displaying the generated script, video/render stats, manifests, history logs, and VA assignment info with deep links to Content Forge Hub (`https://hub.schreinercontentsystems.com/jobs/:id`). Fifth, provide operational control endpoints (`/api/pipeline/jobs/:id/retry`, `/assign`, `/advance`) and move low-level Redis memory telemetry into a clean collapsible drawer.

Rejected alternatives (one line each):
- Building a full non-linear Remotion video timeline editor inside AI OS: out of scope, Content Forge Hub and Remotion CLI already own frame-accurate editing.
- Directly mutating PostgreSQL without stage transition guards: bypasses worker locks and timestamp invariants; mutations must use typed endpoints with state validation.
- Keeping the 7-phase column layout with bright yellow warnings for idle phases: causes severe alarm fatigue and hides genuine failures like frozen frames.
- Replacing Redis BullMQ queue telemetry entirely: telemetry is valuable for debugging, but belongs in an expandable panel rather than the primary creative view.
- Hardcoding VA assignment status: S-C audit note was static; live queries must join `users` table on `assigned_production_va_id` / `assigned_uploader_va_id`.

---

## 1. What exists (read, not remembered)

- `forge-control/src/db/pipeline.ts` (410 lines): `getPipeline()` maps `content_jobs` statuses to phases. Regex `/(QMS|QC|AWAITING)/i` in `qc` matches `AWAITING_UPLOADER` before `publish` regex is evaluated, misplacing 4 finished videos into QC. SQL query reads `content_jobs` without joining `users` for assigned VA names.
- `forge-control/src/lib/pipeline-health.ts` (332 lines): Pure classifiers `classifyStall()`, `classifyPhaseState()`, `parsePm2Jlist()`. Unit tested in `src/lib/pipeline-health.test.ts` (1,649 tests in suite passing).
- `forge-control/src/routes/pipeline.ts` (35 lines): Exposes `GET /` combining pipeline snapshot, worker health, and queue probe. Has no mutation or job detail routes.
- `forge-control/src/routes/forge.ts` & `src/db/forge.ts`: Exposes `GET /api/forge/jobs/:id` returning complete `content_jobs` row (script, manifests, history, logs).
- `forge-control-web/app/desktop/PipelineSurface.tsx` (1,044 lines): Renders yellow `StallSummary` banner, `WorkerStrip`, `QueuePanel`, 7 `PhaseColumn`s, and `JobCard`s. Cards are dead `<div>`s with no `onClick`, no links to Hub, and no drawer. Hardcoded `ASSIGNMENT_NOTE` and developer argumentation strings.
- `forge-control-web/app/api-business.ts` (148 lines): Client fetching `/api/proxy/pipeline`. Owns typed contracts for business lane.
- Content Forge Database (`content_forge` on PostgreSQL `:5432`): Table `content_jobs` with columns `script`, `initial_topic`, `error_message`, `assigned_production_va_id`, `assigned_uploader_va_id`, `final_video_size_bytes`, `final_video_duration_seconds`, `render_completed_at`, `assembly_manifest`, `r2_asset_manifest`, `state_machine_history`, `generation_log`. Table `users` with `id`, `name`, `email`, `role`. Table `channels` with `id`, `name`, `youtube_channel_id`.
- Content Forge Hub (`hub-web` on port 3000, `https://hub.schreinercontentsystems.com`): Validated routes include `/jobs/[id]`, `/jobs/[id]/timeline`, `/jobs/[id]/va-review`, `/jobs/[id]/image-qc`, `/jobs/[id]/edit-list`, `/jobs/create`.

---

## 2. Ownership (the four questions)

| Question | Answer |
|---|---|
| **What owns state** | PostgreSQL `content_forge` database (table `content_jobs`) owns job execution and lifecycle state. PM2 owns worker process status; Redis BullMQ owns in-flight queue items. AI OS acts as an operational control plane and cockpit over this state. |
| **What dispatches work** | `forge-control/src/routes/pipeline.ts` HTTP handlers for operator actions (`retry`, `assign`, `advance`), triggering status updates in PostgreSQL and re-dispatching to Content Forge BullMQ queues (`queue-render-heavy`, `queue-asset-collection`, `queue-ai-generation`). Content Forge workers (`worker-orchestrator`, `worker-render`, `worker-video-stitch`) pick up and execute jobs. |
| **What happens on failure** | Backend errors return standard JSON `{ error: string, details?: string }` with HTTP 4xx/5xx status. In the UI, mutation errors display toast/banner notifications and do not corrupt local state. Unreachable worker or queue probes degrade gracefully with verbatim error text rather than false zeroes. |
| **How does Konrad see it broke** | The Production Velocity Strip highlights `Needs Attention` (e.g. `1 QA Freeze Failure`). Cards with errors render distinct amber/danger alert badges with exact error summaries (e.g. `QA FAILED: Video is frozen for 5.1s`). Clicking the card opens the `JobDetailDrawer` showing the full error trace and logs with a one-click `[ Retry Stage ]` button. |

---

## 3. Architecture & Target Design

### 3.1 Corrected Phase Topography (`forge-control/src/db/pipeline.ts`)

Refactor `PHASES` regex to prevent first-match pollution:
```ts
const PHASES = [
  {
    key: "idea",
    label: "Idea",
    description: "Topic + brief, pre-script",
    match: /^(IDEA_GENERATION|TOPIC_SELECTION|BRIEF|AWAITING_RESEARCH|RESEARCH_UPLOADED)/i,
  },
  {
    key: "script",
    label: "Script",
    description: "Scripting & TTS voiceover",
    match: /^(SCRIPTING|SCRIPT_READY|SCRIPT_REVIEW|TTS|VOICE)/i,
  },
  {
    key: "assets",
    label: "Assets",
    description: "Visual footage & image collection",
    match: /^(ASSET_COLLECTION|CLIP_SELECTION|AWAITING_IMAGE_QC|AWAITING_CLIP_REVIEW)/i,
  },
  {
    key: "qc",
    label: "QC",
    description: "QMS validation & pre-render review",
    match: /^(QMS|AWAITING_QC|AWAITING_VA_REVIEW|FAILED_QMS)/i,
  },
  {
    key: "render",
    label: "Render",
    description: "Routing, Remotion render & stitching",
    match: /^(ROUTING_RENDER|RENDERING|RENDER|STITCH|FAILED_RENDER|VIDEO_STITCH)/i,
  },
  {
    key: "publish",
    label: "Publish",
    description: "Uploader claim & YouTube publication",
    match: /^(AWAITING_UPLOADER|UPLOADING|PUBLISHED|FAILED_UPLOAD)/i,
  },
];
```

### 3.2 Enriched Pipeline Card & Job Detail Data

Update `getPipeline()` SQL query to join `users` and select rich media telemetry:
```sql
SELECT j.id::text, j.title, j.status::text AS status, j.format::text AS format,
       COALESCE(c.name, '—') AS channel,
       COALESCE(t.name, '—') AS template,
       j.status_updated_at::text AS status_updated_at,
       j.final_video_size_bytes,
       j.final_video_duration_seconds,
       j.render_completed_at::text AS render_completed_at,
       j.error_message,
       j.assigned_production_va_id::text AS assigned_production_va_id,
       u1.name AS production_va_name,
       j.assigned_uploader_va_id::text AS assigned_uploader_va_id,
       u2.name AS uploader_va_name
  FROM content_jobs j
  LEFT JOIN channels c ON c.id = j.channel_id
  LEFT JOIN content_templates t ON t.id = j.template_id
  LEFT JOIN users u1 ON u1.id = j.assigned_production_va_id
  LEFT JOIN users u2 ON u2.id = j.assigned_uploader_va_id
 WHERE j.status <> 'MARKED_FOR_DELETION'
 ORDER BY j.status_updated_at DESC
 LIMIT 500;
```

### 3.3 New Backend Control Endpoints (`forge-control/src/routes/pipeline.ts`)

1. `GET /api/pipeline/jobs/:id`: Fetches complete job record for drawer (script, manifests, error details, state history).
2. `GET /api/pipeline/meta`: Fetches channels, active templates, and VA user directory for assignment selectors and filters.
3. `POST /api/pipeline/jobs/:id/retry`: Increments retry count, resets status to appropriate restart phase, and enqueues to BullMQ.
4. `POST /api/pipeline/jobs/:id/assign`: Updates `assigned_production_va_id` or `assigned_uploader_va_id`.
5. `POST /api/pipeline/jobs/:id/advance`: Advances human gate (e.g. `AWAITING_QC` → `ROUTING_RENDER`).

### 3.4 Web UI: Executive Cockpit Layout (`PipelineSurface.tsx`)

- **Header Bar**: Title `Content Forge Pipeline`, subtitle with active counts, search input, channel dropdown filter, format dropdown filter, `Open Hub ↗` link button, `⟳ Refresh` button.
- **Production Velocity Strip**: 4 KPI summary cards (Ready for Upload, Needs Attention, Active Renders, Fleet Health).
- **6-Phase Kanban Board**: Clean columns (`Idea`, `Script`, `Assets`, `QC`, `Render`, `Publish`) with dark card palette (`tokens.bgCard`, `tokens.border`). No bright yellow wallpaper on empty columns.
- **Interactive Job Cards**: Clickable cards with format tag, channel name, status badge, render metrics (filesize, duration), assigned VA name, subtle age badge (`16d`), and hover action bar (`[ 🔍 Details ]`, `[ Hub ↗ ]`).
- **Collapsible Engine Telemetry**: Bottom drawer toggle showing pm2 worker table and BullMQ queue matrix.

### 3.5 Slide-over Job Detail Drawer (`JobDetailDrawer.tsx`)

A full-height slide-over drawer triggered on card click:
- **Header**: Title, Channel, Format, Status pill, `Open in Content Forge Hub ↗` link button, Close button.
- **Tab 1: Overview & Media**:
  - Render metrics (duration, file size, render timestamp, media path).
  - QA status & error summary alert box (if error exists).
  - VA assignment controls (`Assign Production VA`, `Assign Uploader VA`).
  - Action buttons: `[ ⟳ Retry Stage ]`, `[ ⏩ Advance Stage ]`.
- **Tab 2: Script & Prompt**:
  - Initial topic & generation prompt.
  - Formatted generated script text with word count and copy button.
- **Tab 3: Manifests & Assets**:
  - R2 asset list and assembly manifest.
- **Tab 4: History & Logs**:
  - `state_machine_history` timeline with timestamps.
  - Execution logs and LLM trace metadata.

---

## 4. Implementation Task Breakdown

The work is split into focused, sequential builder tasks in workstream `main`, each with strict file write sets, followed by a single join reviewer task.

### Task 1: Backend Phase Topography & Enriched Data Layer
- **Role**: `builder`
- **Tier**: `junior`
- **Workstream**: `main`
- **Depends on**: `[]`
- **Write Set**:
  - `forge-control/src/db/pipeline.ts`
  - `forge-control/src/lib/pipeline-health.ts`
  - `forge-control/src/lib/pipeline-health.test.ts`
- **Scope**:
  1. Fix `PHASES` regex in `db/pipeline.ts` so `AWAITING_UPLOADER` maps to `publish` and `AWAITING_QC` maps to `qc`.
  2. Join `users` table on `assigned_production_va_id` and `assigned_uploader_va_id` to publish `production_va_name` and `uploader_va_name`.
  3. Include `final_video_size_bytes`, `final_video_duration_seconds`, `render_completed_at`, and `error_message` in card payloads.
  4. Update `pipeline-health.ts` and `pipeline-health.test.ts` to ensure all tests pass.

### Task 2: Backend Control Endpoints & Detail Routes
- **Role**: `builder`
- **Tier**: `junior`
- **Workstream**: `main`
- **Depends on**: `[Task 1 ID]`
- **Write Set**:
  - `forge-control/src/routes/pipeline.ts`
- **Scope**:
  1. Implement `GET /api/pipeline/jobs/:id` for full job inspection.
  2. Implement `GET /api/pipeline/meta` for channel and VA directory metadata.
  3. Implement `POST /api/pipeline/jobs/:id/retry` with status validation and BullMQ queue re-dispatch.
  4. Implement `POST /api/pipeline/jobs/:id/assign` for VA assignment updates.
  5. Implement `POST /api/pipeline/jobs/:id/advance` for stage progression.

### Task 3: Web Client API & Typed Contracts
- **Role**: `builder`
- **Tier**: `junior`
- **Workstream**: `main`
- **Depends on**: `[Task 2 ID]`
- **Write Set**:
  - `forge-control-web/app/api-business.ts`
- **Scope**:
  1. Extend `BusinessPipelineCard` and `BusinessPipelineResponse` interfaces with enriched fields.
  2. Define `JobDetail` and `PipelineMeta` interfaces.
  3. Export typed client fetchers: `fetchJobDetail(id)`, `fetchPipelineMeta()`, `retryJob(id)`, `assignJob(id, payload)`, `advanceJob(id, payload)`.

### Task 4: Interactive Control Room UI & Job Detail Drawer
- **Role**: `builder`
- **Tier**: `junior`
- **Workstream**: `main`
- **Depends on**: `[Task 3 ID]`
- **Write Set**:
  - `forge-control-web/app/desktop/PipelineSurface.tsx`
  - `forge-control-web/app/desktop/pipeline/JobDetailDrawer.tsx`
- **Scope**:
  1. Rebuild `PipelineSurface.tsx` with calm dark styling, top Velocity Strip KPI cards, Channel/Format/Search filters, and collapsible Engine Telemetry.
  2. Create `JobDetailDrawer.tsx` with full tabbed view (Overview/Media, Script, Manifests, History/Logs) and direct actions.
  3. Wire up Hub deep links (`https://hub.schreinercontentsystems.com/jobs/:id`).
  4. Verify typecheck (`npx tsc --noEmit`) and build (`npm run build`) in `forge-control-web`.
  5. Capture verification screenshot via `shots-aios.mjs` and inspect output.

### Task 5: Reviewer & Verification Join
- **Role**: `reviewer`
- **Tier**: `standard`
- **Workstream**: `main`
- **Depends on**: `[Task 4 ID]`
- **Write Set**: `[]`
- **Scope**:
  1. Adversarial review of complete diff across `forge-control` and `forge-control-web`.
  2. Run `pnpm test` in `forge-control`.
  3. Run `npx tsc --noEmit` and `npm run build` in `forge-control-web`.
  4. Verify before/after screenshots confirming yellow alert wall is replaced with clean dark control room, phase classification is truthful, cards open drawer, and action endpoints work safely.

---

## 5. Verification Protocol

1. **Unit Tests**:
   ```bash
   cd forge-control && pnpm install --frozen-lockfile --prod=false && pnpm test
   ```
2. **Web Typecheck & Build**:
   ```bash
   cd forge-control-web && npx tsc --noEmit && npm run build
   ```
3. **Screenshot Verification**:
   ```bash
   export FORGE_SESSION_COOKIE="$(cat /tmp/aios-cookie.txt 2>/dev/null || true)"
   SHOT_SURFACES=pipeline SHOT_STAMP=controlroom-after SHOT_OUT=/opt/ai-os/uploads/$FORGE_RUN_ID \
     node /opt/ai-os/workspace/shots-aios.mjs
   ```
