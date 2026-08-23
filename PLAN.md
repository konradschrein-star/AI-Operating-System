# PLAN — aios-excalidraw-to-plans

Project 4a01858a · branch project/4a01858a · architect round 0 · 2026-08-23

## 0. Recommendation, in one paragraph

Build a semantic drawing compiler and bidirectional plan engine across forge-control and forge-control-web:
1. **Semantic Text Extractor & Knowledge Indexer** (forge-control/src/lib/excalidraw-extract.ts): Decodes .excalidraw.md payloads and extracts preamble markdown, container/frame hierarchies, node labels with color/status metadata, and directed relation paths into structured text. Feeds this directly into knowledge_embeddings (updating /opt/knowledge-mcp/km-indexer.js and index-health.ts) and hcp.knowledge_note (db/memory.ts:syncVaultNotes()), making all 16 vault drawings searchable by agents and search APIs.
2. **Spatial Graph Parser** (forge-control/src/lib/excalidraw-graph.ts): Transforms visual drawing elements into a typed DAG (DrawingGraph). Resolves frames, parent containers, cards, and text bindings using both explicit bindings (containerId/boundElements) and spatial geometry (containment boxes and arrow-endpoint proximity). Classifies nodes into lifecycle statuses (built, partial, planned, gap, blocked, proposal) from Konrads palette. Detects structural ambiguities (unconnected nodes, dangling arrows, cycles, ambiguous branches).
3. **Actionable Plan Engine** (forge-control/src/lib/excalidraw-plan.ts): Compiles the graph into a typed CanvasPlan with topologically ordered phases, workstreams, task specs (id, title, workstream, status, depends_on, role, tier, brief), and an explicit **Ambiguities & Open Questions** section that asks rather than guessing when a drawing is ambiguous. Exposes GET /api/canvas/plan, POST /api/canvas/plan/save, and POST /api/canvas/plan/to-project in routes/canvas.ts.
4. **CanvasPane Plan Drawer & Project Push** (CanvasPane.tsx, canvasLive.ts): Adds a [Plan] affordance in the Canvas editor. Toggling opens a side panel with structured task visualization, ambiguity alerts (tokens.warn), markdown editor/preview, plan persistence to <drawing>.plan.md, and a one-click Push to Project action that dispatches the plan DAG into POST /api/projects.

### Rejected alternatives (one line each):
- Raw JSON text chunking in embeddings: Pollutes vector search with coordinate numbers, seed nonces, and styling metadata (measured: 138 KB of noise per drawing).
- Pure containerId/boundElements parsing without spatial geometry: Misses 90%+ of text and arrow relationships in freehand drawings where containerId is null (verified: Drawing 2026-07-23 has 106/108 unbound texts).
- LLM-only heuristic drawing interpretation: Non-deterministic, expensive on large maps (480 KB payload = ~120k tokens), and silently hallucinates missing dependency links.
- Auto-guessing ambiguous connections: Violates Konrads core requirement (instead of just drawings that one can interpret multiple ways) — ambiguities must be highlighted as explicit questions.

---

## 1. System Design & State Architecture

### What owns state?
- **Drawings**: .excalidraw.md files in /opt/obsidian-vault/ remain the single source of truth for visual designs (synced via Syncthing, edited via Excalidraw, watched by fs.watch).
- **Derived Plans**: Saved as companion notes <drawing-path>.plan.md in /opt/obsidian-vault/ and/or embedded in the drawings preamble markdown block.
- **Knowledge Embeddings**: content_forge.knowledge_embeddings (Postgres, halfvec(1024)) stores semantic summary chunks of each drawing.
- **Note Registry & Wikilinks**: hcp.knowledge_note stores drawing titles, tags, and wikilink relations.
- **Live Projects**: content_forge.projects and project_tasks store execution state when a plan is pushed to forge-control.

### What dispatches work?
- POST /api/canvas/plan/to-project: Takes a CanvasPlan, creates a project record via POST /api/projects, and creates all builder/reviewer tasks in topological order with their exact depends_on, workstream, write_set, and tier.
- km-indexer.js and syncVaultNotes(): Background indexers triggered on schedule/file change to keep vector embeddings and graph relations up to date.

### What happens on failure?
- Parse/Decompress error on corrupt drawing: Returns 400 with exact error details; CanvasPane displays error banner with retry.
- Missing dependencies or cyclic graph: excalidraw-graph.ts flags cycles as explicit ambiguities; plan generation notes the cycle rather than failing silently.
- Push to project failure: UI alerts user with the API error message, keeps plan draft intact in localStorage/editor state.

### How does Konrad see it broke?
- Drawings: If an element is ambiguous or unlinked, an amber warning box (tokens.warn) appears at the top of the Plan panel in CanvasPane listing the unresolved questions.
- Indexing: GET /api/memory/index-health reports any unindexed drawings with exact discrepancy reasons.
- Project creation: Error banner in CanvasPane with the API status code and message.

---

## 2. Component Specifications

### 2.1 Excalidraw Semantic Text Extractor (forge-control/src/lib/excalidraw-extract.ts)
Converts .excalidraw.md into clean semantic markdown for vector search:
- Decodes drawing using excalidraw-md.ts.
- Extracts preamble/back-of-note markdown, frames, containers, cards with status colors, and directed edges.
- Formats an information-dense semantic representation for content_forge.knowledge_embeddings.
- Updates db/memory.ts:syncVaultNotes() to index drawing titles, tags, and wikilinks into hcp.knowledge_note, and updates lib/index-health.ts and /opt/knowledge-mcp/km-indexer.js to embed drawings instead of skipping them.

### 2.2 Spatial Graph Parser (forge-control/src/lib/excalidraw-graph.ts)
Parses visual elements into a typed graph structure (DrawingGraph):
- Resolves frames and container boxes (large rectangles, proximity/containment bounds).
- Resolves action nodes (rectangles, ellipses, diamonds) and binds text via containerId, boundElements, or bounding box containment.
- Maps statuses from background/stroke colors (built, partial, planned, gap, blocked, proposal).
- Resolves edges via startBinding/endBinding or spatial arrow-to-box proximity.
- Detects structural ambiguities (unconnected nodes, dangling arrows, cycles, unlabeled branches, straddling containers).

### 2.3 Actionable Plan Generator (forge-control/src/lib/excalidraw-plan.ts)
Converts DrawingGraph into an actionable, phased execution plan (CanvasPlan):
- Topological sort of nodes and edges into ordered phases and workstreams.
- For each task: id, title, workstream, status, depends_on, role, tier (fast, junior, standard), and actionable brief.
- Explicit **Ambiguities & Open Questions** section: reports any uncertainty with concrete questions rather than guessing.
- Markdown serializer rendering plans into standard Obsidian notes.

### 2.4 API Routes (forge-control/src/routes/canvas.ts)
- GET /api/canvas/plan?path=<rel>: Derives graph and plan for vault drawing.
- POST /api/canvas/plan/save: Saves plan markdown to <rel>.plan.md.
- POST /api/canvas/plan/to-project: Creates a new project in forge-control and seeds the task DAG with exact depends_on, workstreams, write_sets, and tiers.

### 2.5 CanvasPane UI (forge-control-web/app/desktop/CanvasPane.tsx, canvasLive.ts)
- Adds a [Plan] toggle button in the header toolbar.
- Responsive side drawer with tabs:
  - **Structured View**: DAG summary, workstreams, phase cards, status chips, ambiguity callouts (tokens.warn).
  - **Markdown Editor**: Live editable markdown with save action.
  - **Push to Project**: Single-click modal/action calling /api/canvas/plan/to-project.

---

## 3. Work Breakdown & Task Graph

- **Task 1** (Builder, standard): src/lib/excalidraw-extract.ts, src/lib/excalidraw-extract.test.ts, src/db/memory.ts, src/lib/index-health.ts, /opt/knowledge-mcp/km-indexer.js.
- **Task 2** (Builder, standard): src/lib/excalidraw-graph.ts, src/lib/excalidraw-graph.test.ts, src/lib/excalidraw-plan.ts, src/lib/excalidraw-plan.test.ts, src/routes/canvas.ts.
- **Task 3** (Builder, standard): forge-control-web/app/desktop/CanvasPane.tsx, forge-control-web/app/desktop/canvasLive.ts, forge-control-web/app/api.ts. Depends on Task 2.
- **Task 4** (Reviewer, standard): Complete join review across all files, verify TypeScript build, check light/dark themes, and verify on real drawings (Stealth Uploader - System Map.excalidraw.md, AI OS - Life & Company OS - Planning Canvas.excalidraw.md).
