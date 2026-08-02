# canvas-ux — implementation plan

## What we're building

Five features that complete the Excalidraw canvas UX in the AI OS. All implementation is in `forge-control` (Hono API) and `forge-control-web` (Next 15 + React 19). No new services, no new dependencies.

---

## Current state (read from code)

**forge-control:**
- `src/lib/excalidraw-md.ts` — lossless codec, both payload encodings
- `src/routes/canvas.ts` — `GET /list`, `GET /file`, `PUT /file` (mtime-guarded), `POST /new`
- `src/routes/chat.ts` — `POST /:id/model`, `POST /:id/effort` as the pattern to copy for canvas
- `src/db/runs.ts` — `setRunModel(id, model|null)` and `setRunEffort(id, effort|null)` as the exact pattern for `setRunCanvas`; `metadata jsonb NOT NULL DEFAULT '{}'` is already on the runs table

**forge-control-web:**
- `app/desktop/ChatSurface.tsx` — canvas state lives in `localStorage.forge.canvasByRun` as `Record<runId, {open, path}>`. `canvasOpen` and `canvasPath` are derived from this. `patchCanvas()` updates it locally only.
- `app/desktop/CanvasPane.tsx` — picker is a `picking` boolean that shows a flat list of canvases; no search; no drag/drop handler.
- `app/desktop/chat/FileExplorerPanel.tsx` — exports `VPS_FILE_DRAG_MIME = "application/x-forge-vps-file"`, sets `{ root, rel }` as drag payload on dragstart.

---

## Feature breakdown

### F1 — Server-side per-chat canvas state

**Backend (forge-control):**

1. Add to `src/db/runs.ts`:
   ```ts
   export async function setRunCanvas(
     id: string,
     canvas_path: string | null,
     canvas_open: boolean,
   ): Promise<RunDetail | null>
   ```
   Implementation mirrors `setRunModel`: JSONB merge if path is provided, strip both keys if null. Keys: `canvas_path` (string|null) and `canvas_open` (boolean).

2. Add to `src/routes/chat.ts`:
   ```
   POST /:id/canvas   { path?: string | null, open?: boolean }
   ```
   Validates `open` is boolean, `path` is string or null. Calls `setRunCanvas`. Returns 200 + run detail or 404.

**Frontend (forge-control-web):**

Replace all localStorage `canvasByRun` usage in `ChatSurface.tsx`:
- Remove `useState<Record<string, ...>>('canvasByRun')` and localStorage sync.
- Derive `canvasOpen = detailQ.data?.metadata?.canvas_open === true`.
- Derive `canvasPath = (detailQ.data?.metadata?.canvas_path as string) ?? null`.
- Add `useMutation` that `POST`s to `/api/chat/:id/canvas`.
- Replace `patchCanvas(patch)` with a call to that mutation — fire-and-forget (optimistic UI is fine; the `detailQ` refetch confirms).

---

### F2 — Agent can open a drawing

No new code needed beyond F1. Once canvas state lives in `runs.metadata`, any process (including the operator agent) can `POST /api/chat/:id/canvas { path: "...", open: true }`.

`detailQ` already refetches every 3 s for live runs and 20 s for completed ones. Since `canvasOpen` is derived from `detailQ.data`, it will flip within one poll interval.

Exact curl (document in summary):
```sh
curl -sX POST http://127.0.0.1:7700/api/chat/<RUN_ID>/canvas \
  -H 'content-type: application/json' \
  -d '{"path":"Excalidraw/Directory Engine - Scraper System Map.excalidraw.md","open":true}'
```

---

### F3 — Searchable drawings

**Backend:** In `src/routes/canvas.ts`, `GET /list` handler:
```ts
const q = c.req.query('q')?.toLowerCase().trim()
if (q) items = items.filter(i =>
  i.name.toLowerCase().includes(q) || i.folder.toLowerCase().includes(q)
)
```

**Frontend:** In `CanvasPane.tsx`, replace the `picking` boolean + flat list:
- Add `search` string state (default `""`).
- On picker button click, show a controlled `<input>` that fires `listCanvases({ q: search })` (or client-filters an already-loaded list — either works; client filter is simpler since the list is small).
- Show results as rows: `<folder> / <name>` + relative mtime (e.g. "3 days ago").
- Clicking a row loads the drawing and closes the picker.

Client-side filter on a pre-fetched list is fine (vault rarely has >200 canvases). Use the `?q=` backend param when the user stops typing (300 ms debounce) for future-proofing.

---

### F4 — Drag and drop into canvas

**Only (a) is implemented.** (b) — inserting image elements — requires fetching binary, computing Excalidraw `DataURL`, generating a stable `fileId`, patching `files` and `elements`, and calling `updateScene`. That is a full afternoon of fiddly Excalidraw-API work for an edge case. Ship (a); call out (b) explicitly.

**Implementation (a):** In `CanvasPane.tsx`, on the root wrapper `<div>`:
```ts
onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
onDrop={e => {
  e.preventDefault();
  const raw = e.dataTransfer.getData(VPS_FILE_DRAG_MIME);
  if (!raw) return;
  const { root, rel } = JSON.parse(raw) as { root: string; rel: string };
  if (root !== 'vault' || !rel.endsWith('.excalidraw.md')) return;
  load(rel);   // existing load function
}}
```

Import `VPS_FILE_DRAG_MIME` from `FileExplorerPanel`. Only vault-root files accepted; non-canvas drops are silently ignored (no error — the user dragged to the wrong target).

---

### F5 — Thin chat rows when canvas is open

In `ChatSurface.tsx`, each chat row is rendered in the left rail. When `canvasOpen === true`, render a compact variant:
- Status dot only (no text badge)
- Relative time (e.g. "3h")
- Title truncated to first ~20 chars or 2 words, whichever is shorter
- No preview text
- No hover actions (close button etc.)

Do this inline in the chat list render — a `canvasOpen ? <compact> : <full>` conditional per row. No new component needed.

---

## Hard constraints (from brief)

- Do NOT edit `app/desktop/DesktopApp.tsx`, `app/tokens.ts`, or anything under `app/desktop/live/`.
- Use CSS vars from `app/tokens.ts` — no hardcoded hex.
- pnpm package manager in both repos.
- Never restart `forge-executor`.
- Verify: `npx tsc --noEmit` in both repos, `npm run build` in web repo, curl every new endpoint.

---

## Task breakdown

### Round 1 — three parallel builders

| # | Repo | Files touched | Tier |
|---|------|---------------|------|
| 1a | forge-control | `src/db/runs.ts`, `src/routes/chat.ts`, `src/routes/canvas.ts` | standard |
| 1b | forge-control-web | `app/desktop/ChatSurface.tsx` | standard |
| 1c | forge-control-web | `app/desktop/CanvasPane.tsx` | standard |

Tasks 1b and 1c touch different files; they can commit to the same branch independently. The reviewer reconciles.

### Round 2 — reviewer

One reviewer task reads the full diff across both repos and verifies against this plan.

---

## Verification checklist (for reviewer)

- [ ] `npx tsc --noEmit` passes in `forge-control`
- [ ] `npx tsc --noEmit` passes in `forge-control-web`
- [ ] `npm run build` passes in `forge-control-web`
- [ ] `curl -X POST http://127.0.0.1:7700/api/chat/<id>/canvas -d '{"path":"...","open":true}'` returns 200
- [ ] `curl 'http://127.0.0.1:7700/api/canvas/list?q=engine'` returns filtered results
- [ ] Reloading the page with an open canvas restores the split (canvas_open from metadata, not localStorage)
- [ ] Dropping a `.excalidraw.md` file from the file explorer onto the canvas pane loads that drawing
- [ ] Chat rows compact when canvas is open
- [ ] No hardcoded hex colours in changed files
- [ ] No edits to forbidden files
