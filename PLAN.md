# PLAN — aios-journal-and-mentor

Project 86632a79 · branch project/86632a79 · architect round 0 · 2026-08-23

## 0. Recommendation, in one paragraph

Build `JournalSurface.tsx` as a **2-column split retrospective workspace**: the **Left Pane (55%)** serves as the **Retrospective & Paper Journal Hub**, providing paper-first photo capture (drag-and-drop uploads stored at `/opt/ai-os/uploads/<id>/<name>` via `POST /api/journal/upload`), a zoomable high-resolution lightbox gallery for handwritten journal pages, compare-and-swap (CAS) markdown editing of the Obsidian daily note's `## Journal` section (`/opt/obsidian-vault/Daily/YYYY-MM-DD.md` via `GET/PUT /api/vault/file`), and a date-filtered stream of the day's logged decisions from `content_forge.decisions` (`GET /api/decisions?day=YYYY-MM-DD`). The **Right Pane (45%)** provides a dedicated home for the **Interactive Mentor Agent Deck**, embedding `AssistantThread.tsx` (reusing the exact assistant-ui / SSE streaming chat plumbing from `ChatSurface.tsx`) bound to the day's mentor debrief runs and backed by `/opt/obsidian-vault/Mentor/PERSONA.md` and `/opt/obsidian-vault/Mentor/Profile/`. The **Header Bar** provides a date stepper, streak & accountability metrics from `GET /api/mentor/metrics`, and a **live, fully wired toggle switch** that directly controls the real `mentor-evening` cron schedule (ID: `90577448-93f4-41dd-a991-14885c74644c`) via `PATCH /api/cron/:id`. Storage is backed by re-runnable PostgreSQL migration `0043_journal_entries.sql` and the existing `/opt/ai-os/uploads/` directory.

### Rejected alternatives (one line each):
- *Automated machine diary generator (the obsolete June 2026 placeholder)*: Rejected because Konrad wants real human reflection on paper with his own words, not LLM hallucinations pretending to be him.
- *Bespoke chat engine for Mentor*: Rejected because `AssistantThread.tsx` and `/api/chat` already provide token streaming, tool call timelines, and rich interaction; duplicating chat engines invites divergence and bugs.
- *In-browser handwriting canvas / drawing tool*: Rejected because Konrad journals on physical paper notebooks; high-resolution image upload + lightbox zoom is the exact matching workflow.
- *Storing journal notes in a custom SQL table instead of Obsidian*: Rejected because Obsidian `/opt/obsidian-vault/Daily/YYYY-MM-DD.md` is Konrad's established second brain; duplicating note storage fractures his knowledge base.
- *Mock/fake toggle for mentor cron*: Rejected because setting a disconnected state flag deceives the operator; the toggle must mutate the live `cron_schedules` row (`90577448-93f4-41dd-a991-14885c74644c`).

---

## 1. What exists (read, not remembered)

- **Audit findings document**: `/opt/ai-os/workspace/audits/journal.md` confirms `JournalSurface.tsx` is completely unbuilt, flagged with `unbuilt: true` in `nav-items.ts:121`, and routed to `PlaceholderSurface` in `DesktopApp.tsx:504-506`.
- **Existing live data & routes**:
  - `GET /api/decisions` (`forge-control/src/routes/decisions.ts` + `db/ai_os.ts:652-662`) holds 120+ decisions in `content_forge.decisions`.
  - `GET /api/mentor/metrics` (`forge-control/src/routes/mentor.ts` + `db/mentor.ts`) returns streak and 30-day accountability metrics.
  - `GET /api/cron` and `PATCH /api/cron/:id` (`forge-control/src/routes/cron.ts` + `db/cron.ts`) manage live schedules, including `mentor-evening` (ID: `90577448-93f4-41dd-a991-14885c74644c`, `30 21 * * *`, `enabled: true`) and `mentor-morning` (`8ef6886f-c9e9-4cd7-8474-4fe04b7989ab`, `enabled: false`).
  - `GET /api/vault/file?path=Daily/YYYY-MM-DD.md` and `PUT /api/vault/file` (`forge-control/src/routes/vault.ts` + `lib/vault.ts`) provide CAS reads/writes for Obsidian daily notes.
  - `POST /api/uploads` and `GET /api/uploads/:id/:name` (`forge-control/src/routes/uploads.ts`) store and serve files at `/opt/ai-os/uploads/<id>/<name>`.
  - `POST /api/chat`, `GET /api/chat/:id`, `POST /api/chat/:id/message`, and `GET /api/chat/:id/events` (`forge-control/src/routes/chat.ts`) provide the SSE streaming chat execution engine.
- **Obsidian Vault & Mentor Persona**:
  - `/opt/obsidian-vault/Mentor/PERSONA.md`: Defines the Mentor persona ("Andrew Tate's frame control and zero-excuse mentality, Alex Hormozi's volume-and-skills doctrine... Said vs. done is the only scoreboard").
  - `/opt/obsidian-vault/Mentor/Profile/`: Contains Konrad's `About Me.md`, `Current Chapter.md`, `Principles & Beliefs.md`, `Operating Manual.md`, `Goals & Aspirations.md`.
  - `/opt/obsidian-vault/Mentor/log.md`: Tracks daily debrief continuity.
  - `/opt/obsidian-vault/Daily/YYYY-MM-DD.md`: Active daily notes containing `## Tasks`, `## Notes`, and `## Journal` sections.

---

## 2. Ownership & Invariants (The Four Questions)

| Question | Answer |
| :--- | :--- |
| **What owns state** | **Paper journal uploads & metadata**: `journal_entries` table in PostgreSQL (`content_forge` DB). **Written journal text**: `/opt/obsidian-vault/Daily/YYYY-MM-DD.md` (`## Journal` heading), managed via CAS `PUT /api/vault/file`. **Decisions**: `decisions` table in `content_forge`. **Mentor schedule & arming**: `cron_schedules` table (`mentor-evening` row). **Mentor conversations**: `runs` table (`metadata.kind = "mentor"`). |
| **What dispatches work** | **Uploads**: Browser form upload directly to `POST /api/journal/upload` storing in `/opt/ai-os/uploads/<id>/<name>`. **Vault writes**: CAS `PUT /api/vault/file`. **Mentor cron toggle**: Optimistic React Query mutation calling `PATCH /api/cron/:id`. **Mentor chat**: `POST /api/chat` and `POST /api/chat/:id/message` dispatched to `forge-executor` runs queue with SSE token streaming. |
| **What happens on failure** | **Upload failure**: 413/400/500 returned with exact error message; UI displays retry banner. **Vault conflict (409)**: Returns current server content and sha256; UI renders conflict resolver (Reload vs Overwrite). **Cron toggle failure**: Optimistic UI rolls back state and displays red error toast. **Mentor chat failure**: `AssistantThread` renders exact error part and status indicator without swallowing. |
| **How does Konrad see it broke** | Clear visual feedback in every state (Loading skeleton, Empty prompt, Error banner with retry, Populated content). Every API error surfaces the real upstream error message. No silent fallbacks. |

---

## 3. Architecture & Design Specification

### 3.1 Backend & Database Layer
1. **Migration `db/migrations/0043_journal_entries.sql`**:
   ```sql
   CREATE TABLE IF NOT EXISTS journal_entries (
     id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     day         date NOT NULL,
     type        text NOT NULL DEFAULT 'paper', -- 'paper' | 'written' | 'video'
     upload_id   text,                          -- directory in /opt/ai-os/uploads/<upload_id>/
     file_path   text NOT NULL,                 -- absolute path on VPS
     file_url    text NOT NULL,                 -- /api/uploads/<id>/<name>
     file_name   text NOT NULL,
     mime_type   text NOT NULL,
     size_bytes  bigint NOT NULL DEFAULT 0,
     ocr_text    text,                          -- extracted text if available
     ocr_status  text NOT NULL DEFAULT 'none',  -- 'none' | 'completed' | 'failed'
     caption     text,                          -- optional human caption
     created_at  timestamptz NOT NULL DEFAULT now(),
     updated_at  timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS journal_entries_day_idx ON journal_entries(day, created_at DESC);
   ```
2. **Database Module `forge-control/src/db/journal.ts`**:
   - `listJournalEntries(day?: string, from?: string, to?: string)`
   - `createJournalEntry(data: ...)`
   - `deleteJournalEntry(id: string)`
   - `updateJournalEntry(id: string, patch: ...)`
3. **Decisions Query Extension (`forge-control/src/db/ai_os.ts` & `src/routes/decisions.ts`)**:
   - Support `day` (YYYY-MM-DD) or `from`/`to` ISO timestamp query filters.
4. **Journal Router (`forge-control/src/routes/journal.ts`)**:
   - `GET /api/journal/day?day=YYYY-MM-DD`: Aggregates paper entries, vault daily note (`## Journal` slice), day's decisions, mentor metrics, and active/latest mentor run.
   - `POST /api/journal/upload`: Multipart upload storing to `/opt/ai-os/uploads/<id>/<name>`, inserting into `journal_entries`, and appending markdown image link `![[uploads/...]]` to `/opt/obsidian-vault/Daily/YYYY-MM-DD.md` under `## Journal`.
   - `DELETE /api/journal/entries/:id`: Deletes entry.
   - Mounted in `forge-control/src/index.ts`.

### 3.2 Frontend Surface Components (`forge-control-web`)
1. **Header Control Bar**:
   - Date stepper (`<`, `Sun 23 Aug 2026`, `>`, `[Today]`).
   - `MentorCronSwitch.tsx`: Live query of `/api/cron`, finds `mentor-evening`, displays armed pill (`● Debrief Armed (21:30 CEST)` vs `○ Disabled`), next fire countdown, and optimistic toggle switch invoking `PATCH /api/cron/:id`.
   - Quick action button `[⚡ Trigger Debrief Now]`.
   - Accountability streak and score badges from `GET /api/mentor/metrics`.
2. **Left Pane (55%) — `JournalRetrospectivePane.tsx`**:
   - `PaperCaptureDeck.tsx`: Drag-and-drop / file picker zone for photographing handwritten paper scans, thumbnail gallery, OCR status pill.
   - `ImageLightbox.tsx`: Full-resolution zoomable modal for inspecting handwritten notes.
   - `JournalVaultEditor.tsx`: CAS markdown editor reading/writing `## Journal` in `/opt/obsidian-vault/Daily/YYYY-MM-DD.md` with conflict resolution modal.
   - `DailyDecisionsStream.tsx`: Filtered timeline cards of logged decisions.
3. **Right Pane (45%) — `MentorAgentDeck.tsx`**:
   - Reuses `AssistantThread.tsx` connected to the day's mentor debrief run (or latest active mentor session) with live SSE token streaming (`/api/chat/:id/events`).
   - Displays Mentor persona branding and tagline ("Said vs Done is the only scoreboard").
   - Quick prompt pills (`⚡ Give me my evening debrief`, `🎯 Diagnose what blocked my top goal today`, `📊 Audit my volume this week`).
   - Autogrow message composer for live two-way debriefing.
4. **Surface Integration**:
   - In `nav-items.ts`: Clear `unbuilt: true` for `journal`.
   - In `DesktopApp.tsx`: Import `JournalSurface`, mount `{surface === "journal" && <JournalSurface />}`, retire `"journal"` from `PlaceholderKey` and `PLACEHOLDER_SURFACES`.

---

## 4. Execution Graph (Tasks & Dependencies)

```
[Task 1: Backend Data Layer & Endpoints]
                  │
                  ▼
[Task 2: Frontend API Client & Left Retrospective Pane]
                  │
                  ▼
[Task 3: Frontend Mentor Agent Deck, Live Cron Switch & Surface Assembly]
                  │
                  ▼
[Task 4: Integration Review & Visual Verification]
```

---

## 5. Task Definitions

### Task 1: Backend Data Layer & Endpoints
- **Role**: `builder`
- **Tier**: `junior`
- **Workstream**: `main`
- **Write Set**:
  - `db/migrations/0043_journal_entries.sql`
  - `forge-control/src/db/journal.ts`
  - `forge-control/src/db/ai_os.ts`
  - `forge-control/src/routes/journal.ts`
  - `forge-control/src/routes/decisions.ts`
  - `forge-control/src/index.ts`
  - `forge-control/src/lib/migrations.test.ts`
- **Brief**:
  1. Create `db/migrations/0043_journal_entries.sql` with re-runnable `IF NOT EXISTS` DDL for `journal_entries` table.
  2. Implement `forge-control/src/db/journal.ts` with typed helpers to list, create, and delete journal entries.
  3. Update `listDecisions` in `forge-control/src/db/ai_os.ts` and `forge-control/src/routes/decisions.ts` to accept `day`, `from`, `to` filter parameters.
  4. Implement `forge-control/src/routes/journal.ts` providing `GET /api/journal/day`, `POST /api/journal/upload` (storing to `/opt/ai-os/uploads/<id>/<name>`, appending link to Obsidian daily note, inserting record), `DELETE /api/journal/entries/:id`.
  5. Mount `/api/journal` in `forge-control/src/index.ts`.
  6. Ensure migration hygiene test `forge-control/src/lib/migrations.test.ts` passes (`pnpm test`).
  7. Verify with curl tests against throwaway / mock endpoints.

### Task 2: Frontend API Client & Left Retrospective Pane
- **Role**: `builder`
- **Tier**: `standard`
- **Workstream**: `main`
- **Depends on**: `[Task 1 ID]`
- **Write Set**:
  - `forge-control-web/app/api.ts`
  - `forge-control-web/app/desktop/journal/PaperCaptureDeck.tsx`
  - `forge-control-web/app/desktop/journal/ImageLightbox.tsx`
  - `forge-control-web/app/desktop/journal/JournalVaultEditor.tsx`
  - `forge-control-web/app/desktop/journal/DailyDecisionsStream.tsx`
  - `forge-control-web/app/desktop/journal/JournalRetrospectivePane.tsx`
- **Brief**:
  1. Add typed API client functions to `forge-control-web/app/api.ts` (`fetchJournalDay`, `uploadJournalPaper`, `deleteJournalEntry`, `fetchDecisionsForDay`).
  2. Implement `PaperCaptureDeck.tsx`: drag-and-drop / file selector for photographing handwritten paper scans, thumbnail gallery, OCR status indicators.
  3. Implement `ImageLightbox.tsx`: high-resolution zoomable viewer for handwritten notes.
  4. Implement `JournalVaultEditor.tsx`: CAS markdown editor reading/writing `## Journal` section of `/opt/obsidian-vault/Daily/YYYY-MM-DD.md` via `GET/PUT /api/vault/file`, with sync status indicator and conflict resolution modal.
  5. Implement `DailyDecisionsStream.tsx`: rendering day's logged decisions with actor badges and timestamps.
  6. Implement `JournalRetrospectivePane.tsx` combining paper capture, vault editor, and decisions stream into the left column.
  7. Strict adherence to `app/tokens.ts` (zero raw colour literals) and all four data states (loading skeleton, honest empty, error banner, populated).

### Task 3: Frontend Mentor Agent Deck, Live Cron Switch & Surface Assembly
- **Role**: `builder`
- **Tier**: `standard`
- **Workstream**: `main`
- **Depends on**: `[Task 2 ID]`
- **Write Set**:
  - `forge-control-web/app/desktop/journal/MentorAgentDeck.tsx`
  - `forge-control-web/app/desktop/journal/MentorCronSwitch.tsx`
  - `forge-control-web/app/desktop/JournalSurface.tsx`
  - `forge-control-web/app/desktop/nav-items.ts`
  - `forge-control-web/app/desktop/DesktopApp.tsx`
- **Brief**:
  1. Implement `MentorCronSwitch.tsx`: queries `/api/cron`, binds to `mentor-evening` (ID: `90577448-93f4-41dd-a991-14885c74644c`), shows armed status pill, and directly toggles schedule via `PATCH /api/cron/:id` with optimistic update.
  2. Implement `MentorAgentDeck.tsx`: embeds `AssistantThread.tsx` (exact same plumbing as `ChatSurface.tsx`) bound to mentor debrief runs, renders persona badge (`PERSONA.md`), quick debrief triggers (`⚡ Give me my evening debrief`), and reply composer.
  3. Implement `JournalSurface.tsx`: 2-column split workspace (Header with date stepper, cron switch, metrics pills; Left Pane `JournalRetrospectivePane`; Right Pane `MentorAgentDeck`). Responsive for narrow viewports.
  4. In `nav-items.ts`: clear `unbuilt: true` on `journal` line (touch nothing else).
  5. In `DesktopApp.tsx`: import `JournalSurface`, add `{surface === "journal" && <JournalSurface />}`, retire `journal` from `PlaceholderKey` and `PLACEHOLDER_SURFACES`.
  6. Verification: `npx tsc --noEmit` and `npm run build` in `forge-control-web`.

### Task 4: Integration Review & Visual Verification
- **Role**: `reviewer`
- **Tier**: `standard`
- **Workstream**: `main`
- **Depends on**: `[Task 3 ID]`
- **Brief**:
  1. Review git diff across all modified files for adherence to design tokens, no raw colour literals, error handling, and strict house rules.
  2. Verify migration hygiene (`pnpm test` in `forge-control`).
  3. Verify Next.js build (`npx tsc --noEmit` and `npm run build` in `forge-control-web`).
  4. Run screenshot harness: `node /opt/ai-os/workspace/shots-aios.mjs` with `SHOT_SURFACES=journal` and visually verify rendered state.
  5. Confirm real backend API responses (`/api/journal/day`, `/api/cron`, `/api/decisions`).
