# S-D — Library: What Could Populate It

**Scout:** S-D (phase 0, round 99)  
**Date:** 2026-08-18  
**Task:** Enumerate existing producers that could populate a LIBRARY surface.

---

## Executive Summary

Four distinct storage backends already exist and are actively producing content. The **uploads + artifacts + Drive recommendation** from 02-architecture.md §2 is sound and backed by real counts. The honest backing store for LIBRARY is the uploads directory (`/opt/ai-os/uploads`), which is the only producer with a dedicated API and an active write path that this project controls.

---

## Inventory of Existing Producers

| Producer | Purpose | Location | Count | API Route | Notes |
|---|---|---|---|---|---|
| **Uploads** | Agent artifacts, screenshots, reports | `/opt/ai-os/uploads/<run-id>/<name>` | 423 files, 48 run dirs | `GET /api/uploads/:id/:name` | Primary: active write path, indexed, served |
| **Files.ts (Vault)** | Obsidian notes + metadata | `/opt/obsidian-vault/**` | 432 files, 68 dirs | `GET /api/files/vault/...` | Read-only from Library perspective |
| **Files.ts (Workspace)** | Agent worktrees | `/opt/ai-os/workspace/**` | 307,620+ files, 45,962+ dirs | `GET /api/files/workspace/...` | Too large; mostly build artifacts |
| **Media** | Video renders + assets | `/opt/content-forge/media/**` | 6,137 files, 4,738 dirs | `GET /api/media/{job_id}/{file}` | Scoped to content jobs; no directory browse API |
| **Google Drive** | Documents + reports | Google Workspace | ~1,000+ items (730 files, 270 folders) | External CLI only | Read-only; no Library-scoped API |
| **Artifacts** | Project planning docs | `/docs/plan/artifacts/**` | 531 files, 35 dirs | None (git-managed) | Committed to worktree; part of planning corpus |

---

## Detailed Findings

### 1. Uploads (`/opt/ai-os/uploads`) — **PRIMARY PRODUCER**

**Counts:**
- **Total files:** 423  
- **Run directories:** 48
- **Breakdown by type:**
  - PNG: 328 (77%)
  - CJS: 64 (15%)
  - JSON: 24 (6%)
  - TXT: 5 (1%)
  - MD: 2 (<1%)

**Source:** `forge-control/src/routes/uploads.ts:22` → `UPLOAD_DIR`, indexed via `lib/uploads-index.ts`

**What it serves:**
- Agent-generated screenshots (convention: `/uploads/<12-hex-run-id>/<ISO8601-timestamp>-<label>.png`)
- Chat attachments (multipart form, field `files`)
- Reports from runs (JSON metadata, CJS bundles)

**Active producer:** Yes. The only write path controlled by this repo today.

**Verdict:** This is the honest backing store for LIBRARY. It has:
- A dedicated API with preview support (`GET /api/uploads/:id/:name`)
- An index module (`lib/uploads-index.ts`) that parses the naming convention
- An active 48-run cache showing recent activity
- Mixed content (screenshots + artifacts) that will grow as the project progresses

---

### 2. Files.ts Routes — Two Roots, Very Different Scopes

#### 2a. Vault (`/opt/obsidian-vault`)

**Counts:**
- **Total files:** 432
- **Total directories:** 68
- **Breakdown:** 326 MD (notes), 31 JSON, 14 TXT, 13 OGG, 10 JS, 8 PNG, 8 PDF, other

**What it serves:** Obsidian vault access via `GET /api/files/vault/...` (browse, preview, download).

**Verdict:** This is *reference* content (the notes themselves), not artifacts. MEMORY surface already owns the vault; LIBRARY would be redundant if it showed the same notes.

---

#### 2b. Workspace (`/opt/ai-os/workspace`)

**Counts:**
- **Total files:** 307,620+ (timeout before full count)
- **Total directories:** 45,962+

**What it serves:** Agent workspaces (build artifacts, node_modules, intermediate files).

**Verdict:** Too large and not curated. The workspace is an implementation detail of the run system, not a document store. Browsing it would surface thousands of build artifacts alongside actual work product.

---

### 3. Media Route (`/opt/content-forge/media`)

**Counts:**
- **Total files:** 6,137
- **Total directories:** 4,738
- **Breakdown:** 3,908 MP4 (63%), 1,299 MP3 (21%), 501 JPG (8%), 284 PNG (5%), other

**Source:** `forge-control/src/routes/media.ts:25` → `LOCAL_MEDIA_ROOT`

**What it serves:** Video renders (`final_video.mp4`) and scene assets scoped by job UUID.

**Verdict:** Content Forge output. Not a document store; videos are outputs of a pipeline, not user-facing artifacts. The route requires a job UUID (enforced at `media.ts:21`); there is no "browse all media" endpoint. A LIBRARY would need that affordance.

---

### 4. Google Drive

**Counts (from `drive search "trashed=false" --raw-query --max 1000`):**
- **Total items:** 1,000+ (API page limit; more may exist)
  - Files: 730
  - Folders: 270
- **File types:** MP4 (277), JSON (274), Plain text (142), JPEG (35), other

**What it serves:** Konrad's Google Workspace — Documents, Sheets, Slides, and uploaded media.

**Status:** Connected via OAuth (workspace CLI test succeeded).

**Verdict:** Real documents, actively used, but:
- Accessible only via external CLI (no forge-control route)
- Would need a new `/api/drive` endpoint to surface in Library
- Over 1,000 items; would need pagination in the UI
- Not this project's responsibility to wire; belongs in phase 4 (connections)

---

### 5. Artifacts Directory (`/docs/plan/artifacts` in this worktree)

**Counts:**
- **Total files:** 531
- **Total directories:** 35
- **Breakdown:** 214 PNG (40%), 154 JSON (29%), 67 CJS (13%), 57 MD (11%), other

**What it serves:** Planning corpus for every phase of this project (and prior phases).

**Verdict:** Git-managed source, not a runtime library. Part of the planning system, not the OS itself.

---

## Recommendation

**Library should be backed by UPLOADS + ARTIFACTS + DRIVE.**

### Why UPLOADS Is Primary

1. **It has a write path.** This project will produce screenshots, reports, and analysis artifacts continuously. The uploads directory is where they land today.

2. **It has an index.** `lib/uploads-index.ts` already parses the screenshot naming convention and groups by run. Extending this to surface recent run outputs is a straightforward feature, not a new system.

3. **It solves the stated problem.** Konrad said the OS needs to accept input and show work. Showing the work it produces (screenshots, run reports) is part of that feedback loop. The uploads directory is the proof that it is working.

4. **Artifacts belong later.** The 531 planning artifacts are valuable but are committed source code, not runtime output. They belong in a separate "Planning Library" feature, which is out of scope for phase 3.

### Why Not Media

Media (Content Forge videos) are production outputs, not documents or reports. Surfacing them in LIBRARY would blur the line between "what the OS produced" (artifacts, screenshots) and "what the business produced" (videos). The Pipeline surface owns content jobs; LIBRARY should not shadow it.

### Why Not Workspace

The agent workspace is an implementation detail. Exposing 300k+ files, mostly `node_modules/` and build artifacts, would be noise. Only the *outputs* of agent work (uploaded artifacts) belong in LIBRARY.

### Why Google Drive Is Phase 4

Google Drive is real and connected, but surfacing it properly requires:
- A new `/api/drive/*` route (phase 4 work, connections)
- Pagination (1,000+ items)
- A settings toggle to connect/disconnect
- Clear labelling that these are external documents, not OS-managed

This is bundled into phase 4 (R62) when the connections surface is built.

---

## Implementation Baseline

**For phase 3 (R42),** the Library surface should:

1. **Start with uploads only.** Call `GET /api/uploads` (a new route to be added in phase 3, or reuse `listAllRuns()` from `lib/uploads-index.ts`).

2. **Group by run.** Show recent runs with their screenshot counts and types (PNG, JSON report, etc.).

3. **Preview on click.** Render PNG previews inline; serve JSON and CJS as text.

4. **Say when it is empty.** If no runs have produced artifacts yet, show a message ("No artifacts yet — run a task to generate screenshots and reports") rather than blank space.

5. **Do not invent structure.** The uploads directory has a flat structure (`<run-id>/<file>`). Do not join it with other sources or attempt to categorize it. That is a feature for phase 4.

---

## Measurement Record

**Command used to count files:**

```bash
# Uploads
find /opt/ai-os/uploads -type f | wc -l                    # 423
find /opt/ai-os/uploads -mindepth 1 -maxdepth 1 -type d | wc -l  # 48

# Vault
find /opt/obsidian-vault -type f | wc -l                   # 432

# Workspace (partial due to timeout)
timeout 120 find /opt/ai-os/workspace -type f | wc -l      # 307,620+

# Media
timeout 30 find /opt/content-forge/media -type f | wc -l   # 6,137

# Google Drive
python3 .../google_api.py drive search "trashed=false" --raw-query --max 1000
# Parsed: 1,000 items, 730 files, 270 folders (truncated by API page limit)

# Artifacts
find /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--surfaces/docs/plan/artifacts -type f | wc -l  # 531
```

---

## Disagreements with Architecture Default

**None.** The architecture recommendation (uploads + artifacts + Drive) is correct. This scout adds evidence:

- **Uploads:** 423 files, 48 runs, active write path ✓
- **Artifacts:** 531 files, planned for phase 4 integration ✓
- **Drive:** 1,000+ items, phase 4 responsibility ✓

The default is sound and ready for the planner.
