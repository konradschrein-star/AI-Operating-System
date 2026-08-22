# HANDOFF — aios-excalidraw-to-plans, round 0 (builder)

## 1. The one thing I did NOT apply, and why

My task's step 5 says: *"Update `/opt/knowledge-mcp/km-indexer.js` to route
`.excalidraw.md` files through the text extractor before chunking and embedding
into `content_forge.knowledge_embeddings`."*

**I did not edit that file.** It is the only step I left undone, and this is the
reasoning, so the next agent can overrule it with facts rather than repeat it:

1. It is outside this repo and outside my worktree. The fleet-wide worktree-only
   policy says a build task touches neither the live checkout nor a live
   service; changes to a running service belong to a deploy/verify task.
2. `/opt/knowledge-mcp` **is not a git repository** (`git status` → "not a git
   repository"). A bad edit there is recoverable only through the ad-hoc
   `km-indexer.js.bak.*` convention, not through git.
3. It was in use while I worked. `pm2 list` at 01:05 on 2026-08-23 showed
   `km-chat-backfill` **online for 31 minutes** running that same script, plus
   `km-resume-watcher`, both started by another agent this evening.
   `knowledge-indexer-watch` is **stopped** and
   `/opt/knowledge-mcp/resume-watcher-after-backfill.sh` will restart it when
   the backfill finishes — so an edit landing now takes effect unattended, at
   night, on the process that maintains Konrad's whole vault index.

Everything the change needs is built, tested and committed. What is left is the
five hunks below, applied by whoever owns the deploy step.

## 2. The integration, ready to apply

The bridge already exists and is exercised:
`forge-control/src/lib/excalidraw-extract-cli.ts`.

```
tsx src/lib/excalidraw-extract-cli.ts <absolute-file> [vault-relative-path]
  exit 0 — stdout is the rendering, index it
  exit 3 — the drawing is blank, skip it (not a failure)
  exit 1 — unreadable, diagnostic on stderr (NOT the same as blank)
```

Measured against the real vault:

```
$ npx tsx src/lib/excalidraw-extract-cli.ts \
    "/opt/obsidian-vault/Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md"
# Stealth Uploader - Warming Timeline
…
EXIT=0
$ … "Directory Engine - Scraper System Map.excalidraw.md"   → EXIT=3 (blank, no stdout)
$ … "Daily/2026-08-22.md"                                    → EXIT=1 (not a drawing)
```

A subprocess per drawing is affordable: there are 15 `.excalidraw.md` files in
the whole vault, and the alternative — a second copy of the extractor written in CommonJS — drifts
from the tested one the first time either side changes.

### Hunk 1 — `km-indexer.js:29-36`, the exclusion

```js
// Files whose content is machine-generated JSON with no semantic prose. The
// pre-2026-08-04 indexer embedded these as pure noise vectors — most damaging
// was Excalidraw drawing JSON.
//
// 2026-08-23: '.excalidraw.md' LEFT this list. The blob is still noise; the
// DRAWING is not. forge-control's extractor renders labels, containment and
// arrows as text (33 KB file → 3.9 KB of prose), and that is what gets embedded.
const EXCLUDED_EXTENSIONS = [];

const DRAWING_EXTENSION = '.excalidraw.md';
const DRAWING_TSX = '/opt/forge-ai-os/forge-control/node_modules/.bin/tsx';
const DRAWING_EXTRACTOR =
  '/opt/forge-ai-os/forge-control/src/lib/excalidraw-extract-cli.ts';
```

`DRAWING_TSX` is an absolute path on purpose: under pm2 a PATH walk for a
dev-dependency binary reports "not installed".

### Hunk 2 — a renderer, next to `isExcludedFile` (~line 346)

```js
const { execFileSync } = require('child_process');

function isDrawingFile(name) {
  return name.toLowerCase().endsWith(DRAWING_EXTENSION);
}

/**
 * Render a drawing as semantic text. Returns null when the canvas is blank
 * (exit 3) — skip it, that is not an error. Throws on anything else, because a
 * file we could not read must not be indexed as an empty one.
 */
function renderDrawing(filePath, rel) {
  try {
    return execFileSync(DRAWING_TSX, [DRAWING_EXTRACTOR, filePath, rel], {
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.status === 3) return null;
    throw new Error(
      `excalidraw extractor failed for ${rel} (exit ${err.status}): ` +
        String(err.stderr || err.message).trim(),
    );
  }
}
```

### Hunk 3 — `indexFile`, replacing the single `chunkNote` call (~line 425)

```js
  let source = raw;
  if (isDrawingFile(filePath)) {
    source = renderDrawing(filePath, rel);
    if (source === null) {
      // Blank canvas. Drop any chunks a previous version of it left behind.
      await deleteNote(db, rel);
      return 0;
    }
  }
  const { title, meta, chunks } = chunkNote(filePath, source);
```

The skip check above it still hashes `raw` (the file), so a drawing re-indexes
exactly when Konrad edits it.

### Hunk 4 — `chunkNote:199`, the compound extension

```js
  // basename(f, '.md') leaves ".excalidraw" behind, and it ends up in the
  // embedding's title.
  const fileName = path.basename(filePath, '.md').replace(/\.excalidraw$/i, '');
```

### Hunk 5 — `km-indexer.js:957`, the log line

With an empty `EXCLUDED_EXTENSIONS` this prints "after excluding: ". Replace:

```js
  console.log(`Found ${files.length} notes in vault (drawings included).`);
```

### After applying

```bash
node /opt/knowledge-mcp/km-indexer.js --dry-run --no-chats   # nothing written
node /opt/knowledge-mcp/km-indexer.js --no-chats             # the state file
                                                            # skips unchanged notes
psql -U postgres -d content_forge -c \
  "SELECT source_path, count(*) FROM knowledge_embeddings
    WHERE source_path LIKE '%.excalidraw.md' GROUP BY 1 ORDER BY 1;"
```

Expect **9 of the 15** `.excalidraw.md` files to produce chunks — 41 KB of text
out of 1.43 MB of drawings. The other six carry nothing extractable (see §3).

## 3. Findings the next task needs

**a) Six of the fifteen `.excalidraw.md` files hold nothing extractable.**
Measured by running the extractor over every one of them:

| file | why nothing comes out |
|---|---|
| `AI OS - Canvas Smoke Test` (527 B) | never drawn on |
| `Directory Engine - Scraper System Map` (522 B) | never drawn on |
| `gemini-canvas-smoke` (446 B) | never drawn on |
| `Drawing 2026-07-03 18.25.41` (566 B) | never drawn on; also the odd `## Drawing`-only file shape |
| `Drawing 2026-06-13 21.29.57` (31 KB) | all 55 elements marked deleted — a husk, not a new canvas |
| `Drawing 2026-08-09 15.42.40` (416 KB) | 382 freedraw strokes and 5 images, zero text elements — handwriting, unreadable without OCR |

**The project brief names `Directory Engine - Scraper System Map` as one of the
"real system maps" that are invisible to search. It is not a map — nothing has
ever been drawn on it.** Do not plan work that assumes it has content.

The nine with content are: `Stealth Uploader - System Map` (44 nodes, 12 arrows),
`Stealth Uploader - Warming Timeline` (29), `AI OS - Life & Company OS - Planning
Canvas` (20), and the dated drawings of 2026-07-02, 07-03 18.25.45 (237 nodes,
44 arrows — the largest real graph in the vault), 07-07, 07-23, 07-26 and 08-05.

There is also `Untitled-2026-08-02-1208.excalidraw` with no `.md` suffix; no
indexer in this stack looks at it, and neither does the extractor.

**b) Label text on disk is missing its first character, systematically.**
In `Stealth Uploader - System Map` the labels read `ontent Forge (existing
engine)`, `ideo + Thumbnail + Metadata`, `olphin profile = IDENTITY`; in
`Warming Timeline`, `HASE 1 · Days 1–3`, `ge the jar 48–72h`. It is exactly one
leading character, and it is **in the file** — both in the drawing payload and
in the plugin's own `## Text Elements` index, so it is not an extraction
artefact (verified by reading the raw markdown). Whatever wrote these drawings
dropped a character per label. The extractor carries the text through
faithfully, so the damage is visible but not amplified. **This is a real data
loss in Konrad's vault and it is worth a task of its own** — it is not in this
project's write-set (`lib/excalidraw-build.ts` and `routes/canvas.ts` own the
write path) and I did not go looking further than confirming the file is the
source.

**c) The Memory surface's label will read oddly until someone who owns it
adjusts it.** `MemoryCounts.excluded.excalidraw` now counts BLANK drawings only
(5), not all drawings (was 15/16). `forge-control-web/app/desktop/MemorySurface.tsx:401`
renders it as "excluded: N excalidraw". The key name is kept deliberately —
`app/api-vault.ts:293` types it and I do not own either file. Renaming it to
`blank_drawings` is a one-line change for whoever owns the Memory surface.

**d) `unexplained_count` will jump on the live endpoint, correctly.** Until hunk
1–5 land, every drawing with content is now classified `unexplained` with a
detail naming `km-indexer.js:29`. That is the defect being fixed, made visible.
It returns to zero when the indexer is patched, not before.
