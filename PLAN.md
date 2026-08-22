# PLAN — aios-library-and-map

Project `5ca15ae2-f954-4db9-bcab-64ba761db761` · branch `project/5ca15ae2` · architect round 0 · 2026-08-23

---

## 0. Recommendation, in One Paragraph

Build **LIBRARY** as the unified **OS Artifact & Media Hub** paired with a reusable `MediaDocumentViewer` primitive (`_ui/`) that handles rendered/editable Markdown, syntax-highlighted code/text, high-res images, inline seekable MP4/WebM video, audio, and PDF across four unified roots (`vault`, `workspace`, `uploads`, `media`). Build **MAP** as the **Dual-Mode AI OS & Business Atlas** combining (1) an interactive visual Mind Map connecting Konrad's 5 commercial ventures, AI OS agent fleet, and physical infrastructure with drill-in inspector drawers, (2) direct bi-directional integration with the Obsidian Excalidraw planning canvas (`AI OS - Life & Company OS - Planning Canvas.excalidraw.md`), and (3) a live 4-column Topology Grid (PM2 processes, parsed Nginx ingress domains, storage/databases, and LLM/API integrations) backed by a new `/api/map` route. Clear `unbuilt: true` for both `library` and `map` in `nav-items.ts`, update `scripts/checks/check-phase3-placeholders.ts` to assert `EXPECTED_UNBUILT = ["journal"]`, and wire `DesktopApp.tsx`.

### Rejected Alternatives (One Line Each)
- *A static hardcoded JSON topology inventory (`businesses-inventory.ts` model)*: Stales within days; real topology must be aggregated dynamically from live PM2, systemd, Nginx vhosts, and the vault.
- *Building Library exclusively for Content Forge video jobs*: Superseded by `PIPELINE`; Library's core mission in the AI OS is the entire artifact & deliverables catalog across all runs, media renders, and vault files.
- *Separate standalone viewer routes for Chat vs Library*: Duplicates rendering logic; building `MediaDocumentViewer` in `_ui/` allows both Chat and Library to share identical document and video inspection capabilities.
- *A third-party React-Flow heavyweight canvas for Map*: Unnecessary bundle bloat; SVG/CSS hierarchical layout for the live Mind Map plus mounting built-in `CanvasPane` for freeform Excalidraw gives the best of both worlds.
- *Allowing silent fallback on missing domain/process telemetry in `/api/map`*: Hard errors and explicit sectional isolation are OS policy; failed sub-queries report error states with retry buttons.

---

## 1. What Exists (Read, Not Remembered)

1. **Placeholder Definitions & Nav Flags**:
   - `forge-control-web/app/desktop/nav-items.ts`: `NAV` lines 111 & 122 flag `library` and `map` as `unbuilt: true`. `UNBUILT_NAV_KEYS` computes `["journal", "library", "map"]`.
   - `scripts/checks/check-phase3-placeholders.ts`: Asserts `EXPECTED_UNBUILT = ["journal", "library", "map"]` and checks flips.
   - `forge-control-web/app/desktop/DesktopApp.tsx`: Lines 125, 159–184, 504–506 dispatch `library` and `map` to `PlaceholderSurface`.
2. **Files & Uploads Backend**:
   - `forge-control/src/routes/files.ts`: Mounted at `/api/files`. Provides `/roots`, `/list`, `/read`, `/search`, `/attach`. Currently defines roots `vault` (`/opt/obsidian-vault`) and `workspace` (`/opt/ai-os/workspace`).
   - `forge-control/src/routes/uploads.ts` & `lib/uploads-index.ts`: Mounted at `/api/uploads`. `GET /api/uploads/index` lists 84 runs with 479 screenshots in `/opt/ai-os/uploads`. `ID_RE` currently restricts to `/^[a-f0-9]{12}$/` and indexer drops non-image runs (patches, logs, JSON).
   - `forge-control/src/routes/media.ts`: Mounted at `/api/media`. Serves `/opt/content-forge/media` with HTTP Range support for video seeking.
3. **Canvas & Graph Machinery**:
   - `forge-control/src/routes/canvas.ts`: Mounted at `/api/canvas`. Provides `/list`, `/file`, `/stat`, `/events`, `/patch`. Verified live with `Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md`.
   - `forge-control-web/app/desktop/CanvasPane.tsx`: 832-line full Excalidraw editor with optimistic concurrency (mtime conflict guards) and Syncthing safety.
   - `forge-control-web/app/desktop/MemoryGraph3D.tsx`: 405-line 3D force-directed WebGL graph.
4. **Telemetry & Live Systems**:
   - `/api/pm2/list` (28 processes, 22 online live), `/api/systemd/units` (97 units), `/api/system/stats` (disk, RAM).
   - `/etc/nginx/sites-enabled/`: 19 live vhost configurations (`hub.schreinercontentsystems.com`, `schichtkommunikationstool...`, `keywordtool...`, `thumbnails...`, etc.).
   - Vault files: `/opt/obsidian-vault/90_AI_OS/Infrastructure - Master Map.md`, `Konrad Projects Overview.md`, `Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md`.

---

## 2. Ownership & Four Core Questions

| Question | Answer |
|---|---|
| **What owns state?** | For **Library**: The underlying VPS filesystem directories (`/opt/ai-os/uploads`, `/opt/obsidian-vault`, `/opt/content-forge/media`, `/opt/ai-os/workspace`) are the single source of truth, read via `/api/files` and `/api/uploads`. Client-side browsing state (selected root, active folder, selected file, search/filter query, edit draft) is held in `LibrarySurface` React state.<br>For **Map**: Backend aggregated state is computed dynamically by `routes/map.ts` from live host telemetry (PM2, systemd, Nginx, databases, integrations). Canvas state is stored in `.excalidraw.md` files in the Obsidian vault via `routes/canvas.ts`. Selected node/tab state is held in `MapSurface` React state. |
| **What dispatches work?** | Handlers in `forge-control-web` dispatch queries via `@tanstack/react-query` to `/api/files/*`, `/api/uploads/*`, `/api/map`, and `/api/canvas/*`. File save operations dispatch `PUT /api/files/write` or `PUT /api/canvas/file`. |
| **What happens on failure?** | Sectional Error Isolation: each quadrant / column / pane has its own `ErrorBoundary` and fallback card with a retry button. If Nginx parsing fails, only the Domains column fails while PM2, systemd, and Canvas continue rendering. If a file preview fails, an explicit error banner with a "Download raw file" fallback renders. |
| **How does Konrad see it broke?** | Immediate inline error cards displaying the exact HTTP error / failure reason, with no silent empty states or swallowed exceptions. `npx tsc --noEmit` and `check-phase3-placeholders.ts` fail loudly during build if contracts break. |

---

## 3. Detailed Component Architecture

### 3.1 Reusable Media & Document Viewer (`forge-control-web/app/desktop/_ui/MediaDocumentViewer.tsx`)
A unified viewer component supporting:
- **Markdown (`.md`)**: Rendered rich view via `MessageMarkdown` + togglable "Edit" mode with textarea and `Save` button (mtime-guarded save).
- **Code / Plain Text (`.ts`, `.tsx`, `.js`, `.py`, `.json`, `.sh`, `.patch`, `.diff`, `.log`, `.txt`, `.csv`, `.yml`, `.yaml`)**: Syntax highlighting / formatted pre-wrap, line numbers, copy raw content.
- **Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`)**: Full preview with zoom, dimensions, checkerboard background, copy path, download.
- **Video (`.mp4`, `.webm`, `.mov`)**: HTML5 video player with range-request streaming, playback controls, scrubber, speed controls.
- **Audio (`.mp3`, `.wav`, `.m4a`, `.ogg`)**: Inline audio player with playback bar.
- **PDF (`.pdf`)**: Embedded iframe.
- **Unsupported**: File format icon, size, path, and clear "Download" action.

### 3.2 Library Surface (`forge-control-web/app/desktop/LibrarySurface.tsx`)
- **Top Control Bar**:
  - Root Selector: `Run Artefacts & Uploads (/opt/ai-os/uploads)`, `Obsidian Vault (/opt/obsidian-vault)`, `Content Forge Media (/opt/content-forge/media)`, `Agent Workspace (/opt/ai-os/workspace)`.
  - Live Counter: e.g. `84 Runs · 818 Files · 479 Screenshots`.
  - Search Input: real-time search across file names and labels.
  - Type Filter Chips: `All`, `Screenshots & Images`, `Videos & Media`, `Notes & Markdown`, `Patches & Diffs`, `Data & JSON`.
  - View Mode Toggle: `Grid` (cards with thumbnails) / `List` (dense table with file sizes and timestamps).
- **Split Explorer / Preview Pane (`ResizableSplit`)**:
  - Left / Top: Folder tree and file list (allowing continuous browsing of neighbouring files without losing context).
  - Right / Bottom: Deep inspection powered by `MediaDocumentViewer`.

### 3.3 Map Surface (`forge-control-web/app/desktop/MapSurface.tsx`)
- **Header Mode Switch**:
  - `[🗺️ Mind Map]` (Interactive Visual Graph)
  - `[✏️ Planning Canvas]` (Embedded Excalidraw Editor)
  - `[📊 System Atlas]` (Live 4-Column Topology Grid)
- **Mode 1: Visual Mind Map (`map/VisualMindMap.tsx`)**:
  - Auto-generated hierarchical SVG / HTML node graph:
    - Root: `Konrad AI OS & Enterprise Hub`
    - Cluster 1: `Commercial Ventures` (TheSkyLab YouTube, Jersey/UK Directory, Axtrelis, Client SaaS ShiftSync/KeywordTool/Thumbnails).
    - Cluster 2: `AI OS Core Fleet` (Hermes Supervisor, Agent Workers, Task Graphs, Obsidian Vault, pgvector Memory, LLM Gateways).
    - Cluster 3: `Physical Infrastructure` (VPS1 `65.108.6.149` 28 PM2/97 Systemd/Nginx/Postgres, VPS2 `167.233.145.218`, Windows 11 VM).
  - Clicking any node opens `MapInspectorDrawer` with live health status, port, domain, repo path, and quick action links (`[Open URL]`, `[View in Live]`, `[Open in Files/Library]`).
- **Mode 2: Planning Canvas (`CanvasPane.tsx` Integration)**:
  - Mounts `CanvasPane` loading `Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md` with seamless vault saving and file switching dropdown.
- **Mode 3: System Topology Atlas (`map/TopologyAtlasGrid.tsx`)**:
  - 4 Live Columns:
    1. *Processes & Services* (PM2 processes + Systemd units).
    2. *Domains & Ingress* (19 Nginx vhosts with SSL cert status and proxy targets).
    3. *Storage & Databases* (Disk `/`, RAM, Postgres 5432/5434, Redis, Vault).
    4. *Providers & Integrations* (Claude OAuth, Gemini Pool 5/5, ElevenLabs, GitHub).

---

## 4. Backend Endpoints & API Changes

1. **`forge-control/src/routes/files.ts`**:
   - Add `uploads` (`/opt/ai-os/uploads`, "Run Artefacts & Uploads") and `media` (`/opt/content-forge/media`, "Content Forge Media") to `ROOTS`.
   - Add `PUT /write` endpoint: receives `{ root, path, content }`, verifies containment via `resolveInRoot`, and writes file safely.
2. **`forge-control/src/routes/uploads.ts` & `src/lib/uploads-index.ts`**:
   - Broaden `ID_RE` to allow UUIDs: `/^[a-f0-9]{12}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
   - Include non-image artifacts (.patch, .diff, .txt, .json, .log) in run counts and list endpoints.
3. **`forge-control/src/lib/nginx-parser.ts` & `src/routes/map.ts`**:
   - Parse `/etc/nginx/sites-enabled/` safely for server names, proxy passes, listen ports.
   - Aggregate businesses, PM2 processes, systemd units, domains, databases, and canvas files into `GET /api/map` with per-section try/catch error containment.
   - Mount in `forge-control/src/index.ts`.
4. **`forge-control-web/app/api.ts`**:
   - Add typed client methods: `fetchUploadRuns()`, `fetchRunArtifacts()`, `fetchMapTopology()`, `writeFileContent()`.

---

## 5. File Ownership & Write Sets

| Task | Role | Tier | Write Set | Brief Summary |
|---|---|---|---|---|
| **T1: Backend & API Foundations** | builder | standard | `forge-control/src/routes/files.ts`<br>`forge-control/src/routes/uploads.ts`<br>`forge-control/src/lib/uploads-index.ts`<br>`forge-control/src/lib/nginx-parser.ts`<br>`forge-control/src/routes/map.ts`<br>`forge-control/src/index.ts`<br>`forge-control-web/app/api.ts` | Expand file roots (`uploads`, `media`), add file write endpoint, update upload UUID regex, implement Nginx parser, mount `/api/map`, and export typed frontend API client methods. |
| **T2: Media Viewer & Library Surface** | builder | standard | `forge-control-web/app/desktop/_ui/MediaDocumentViewer.tsx`<br>`forge-control-web/app/desktop/_ui/MediaDocumentViewer.css`<br>`forge-control-web/app/desktop/LibrarySurface.tsx`<br>`forge-control-web/app/desktop/LibrarySurface.css` | Build `MediaDocumentViewer` supporting rendered/editable markdown, code/text, images, mp4 video player, audio, PDF. Build `LibrarySurface` with 4-root selector, filter chips, grid/list toggle, and resizable split preview. |
| **T3: Map Surface (Atlas, Mind Map, Canvas)** | builder | standard | `forge-control-web/app/desktop/MapSurface.tsx`<br>`forge-control-web/app/desktop/MapSurface.css`<br>`forge-control-web/app/desktop/map/VisualMindMap.tsx`<br>`forge-control-web/app/desktop/map/MapInspectorDrawer.tsx`<br>`forge-control-web/app/desktop/map/TopologyAtlasGrid.tsx` | Build `MapSurface` with Mind Map node graph linking businesses/agents/infra, inspector drawer, Excalidraw `CanvasPane` planning integration, and 4-column live topology atlas grid. |
| **T4: Navigation Wiring & Gating Suite** | builder | junior | `forge-control-web/app/desktop/nav-items.ts`<br>`forge-control-web/app/desktop/DesktopApp.tsx`<br>`scripts/checks/check-phase3-placeholders.ts`<br>`evidence/library-map-verification.md` | Clear `unbuilt` flags for library and map in `nav-items.ts`, wire `LibrarySurface` and `MapSurface` in `DesktopApp.tsx`, update `check-phase3-placeholders.ts` assertions, run build/tsc, and capture screenshot evidence. |
| **T5: Full Integration & Gating Review** | reviewer | standard | `evidence/library-map-verification.md` | Review complete diff across backend routes, Library surface, Map surface, nav wiring, placeholder checks, and screenshot proofs. |

---

## 6. Definition of Done & Verification Plan

1. **TypeScript & Build Gates**:
   ```bash
   cd forge-control && pnpm install --frozen-lockfile --prod=false
   cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
   npx tsc --noEmit
   npm run build
   ```
2. **Placeholder Assertion Check**:
   ```bash
   cd forge-control && ./node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-phase3-placeholders.ts
   ```
3. **Live API Verification**:
   - `curl -s http://127.0.0.1:7700/api/files/roots` → includes `vault`, `workspace`, `uploads`, `media`.
   - `curl -s http://127.0.0.1:7700/api/map` → returns aggregated topology with businesses, domains, processes, storage.
   - `curl -s http://127.0.0.1:7700/api/uploads/index` → returns 84+ runs including UUID directories and non-image artifacts.
4. **Visual Screenshots**:
   - Capture `library` surface on desktop (1440px) and verify artifact grid, media player, and markdown viewer.
   - Capture `map` surface in both Mind Map, Canvas, and Topology Atlas modes.
   - Demonstrate `MediaDocumentViewer` rendering a real `.mp4` video, a real `.md` file, and a real `.png` image from the VPS.
