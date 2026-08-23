# Library & Map — round 2 integration verification

Round 2's brief named four files. `git status`/`git diff` at the start of this
turn showed a **clean working tree already carrying the three integration
commits** (`2b6c3e1` nav flags, `514802d` placeholder checks, `aa67072`
DesktopApp wiring) from an earlier turn. This report re-verifies that work
against real gates and adds the fourth deliverable, this file, plus real
screenshots — it does not re-implement anything.

## 1. nav-items.ts / DesktopApp.tsx / check-phase3-placeholders.ts — verified as-is

- `nav-items.ts`: `library` and `map` NAV entries carry no `unbuilt: true`
  (grepped directly, forge-control-web/app/desktop/nav-items.ts:111,122).
- `DesktopApp.tsx`: imports `LibrarySurface`/`MapSurface`
  (lines 48–49), `PlaceholderKey = "journal" | "search"` (line 127), and
  renders `{surface === "library" && <LibrarySurface />}` /
  `{surface === "map" && <MapSurface .../>}` (lines 480–482) ahead of the
  `isPlaceholderKey` fallback.
- `check-phase3-placeholders.ts`: `EXPECTED_UNBUILT = ["journal"]` (line 80).

No edits were needed to these three files — they matched the brief exactly.

## 2. Gate: check-phase3-placeholders.ts

```
$ cd forge-control-web && npx tsx ../scripts/checks/check-phase3-placeholders.ts
...
── the flip: LIBRARY and MAP re-marked unbuilt are caught ──
PASS  the fixture really is different from NAV
PASS  …and the audit names LIBRARY
PASS  the fixture really is different from NAV
PASS  …and the audit names MAP
...
ALL PASS — phase 3 placeholders (R40)
```
Full run: 26/26 checks pass, including the dedicated LIBRARY/MAP flip added
for this round.

## 3. Gate: tsc --noEmit

```
$ cd forge-control-web && npx tsc --noEmit   → exit 0, no output
$ cd forge-control    && npx tsc --noEmit   → exit 0, no output
```

## 4. Gate: npm run build (forge-control-web)

Built against a **throwaway forge-control probe**, not live `:7700` — live
`main` (`/opt/forge-ai-os`) is behind this branch and 404s `/api/map`
entirely, so building against live would have baked in a broken rewrite and
proved nothing about this round's `/api/map` route. Per
`[[live-api-hides-worktree-regression]]` / `[[next-proxy-rewrite-baked-at-build]]`:

- Probe: `/tmp/probe-7798.mts`, mounts only `files`, `map`, `uploads` from
  this worktree, refuses every non-GET with 405, proxies everything else
  verbatim to live `:7700` (`app.all("*", ...)`). Started with `setsid ...
  disown` on `127.0.0.1:7798`. DATABASE_URL is unused by these three routers.
- Build: `FORGE_CONTROL_URL=http://127.0.0.1:7798 npm run build` → exit 0,
  `.next/routes-manifest.json` rewrite destination confirmed
  `http://127.0.0.1:7798/api/:path*`.
- Serve: throwaway `next start -p 3999` (`setsid ... disown`, confirmed
  listening via `ss -ltn`).

```
✓ Compiled successfully
✓ Generating static pages (10/10)
Route (app) ... ○ /desktop  219 B  414 kB
```

Both throwaway processes (probe :7798, next start :3999) were used
read-only, never touched `/opt/forge-ai-os`, and were torn down after
verification.

## 5. Screenshots

Captured with `shots-aios.mjs` (`SHOT_BASE=http://127.0.0.1:3999`, the
throwaway server above, cookie from `/tmp/aios-cookie.txt`) plus a small
interactive Playwright script (`/tmp/library-viewer-demo.mjs`) for the
media-viewer walkthrough.

- `20260823T010139Z-library.png` — LIBRARY surface, default state: root tabs
  (Run Artefacts & Uploads / Obsidian Vault / Content Forge Media / Agent
  Workspace), grid of real run artefacts, and the right-hand
  `MediaDocumentViewer` already open on a real PNG
  (`20260823T030500Z-autonomy-light.png`, 251.2 KB) with zoom controls —
  demonstrates the **image** preview path.
- `20260823T010139Z-map.png` — MAP surface, Mind Map mode: real topology
  sourced from `/api/map` (vault + pm2 + nginx), root node "Konrad AI OS &
  Enterprise Hub" fanning into Commercial Ventures / AI OS Core & Agent
  Fleet / Physical Infrastructure columns, each card backed by real
  data (TheSkyLab, ReelForge, VPS1/VPS2, Postgres, Anthropic/Gemini/Ollama
  gateways) with live stat chips (5 Businesses, 22/28 PM2 online, 19 Domains
  Ingress, 64GB RAM 61.9% used).
- `..._library-md.png` — LIBRARY surface, Obsidian Vault root, `Books.md`
  opened: `MediaDocumentViewer` renders the markdown (tags list, strikethrough
  line) with `wrap` / `edit` / `copy raw` / `download` controls — demonstrates
  the **markdown, render + editable** path.
- `..._library-mp4.png` — LIBRARY surface, Content Forge Media root,
  `tutorial/002910a1-c309-448e-89c1-fc4cb231c1cf/final.mp4` opened: a real
  HTML5 `<video>` element (`VIDEO_TAG_COUNT: 1` asserted in the driver
  script), playhead at `00:00 / 02:51`, full control bar (speed, volume,
  PiP, fullscreen) — demonstrates the **mp4, inline player** path.

All four screenshots are saved under
`/opt/ai-os/uploads/93d0b2ad-282b-47e8-b600-58b13d1a638a/` and were read back
so they render inline in the run's camera feed.

## 5a. Note for future navigation of Content Forge Media

`/opt/content-forge/media/tutorial/` holds 2732 run folders; `files.ts`'s
`/api/files/list` caps a directory listing at `LIST_CAP = 1000`, alphabetical,
dirs-first. A folder whose UUID sorts past the 1000th entry (e.g. anything
starting `c`, `d`, `e`...) never appears in the LIBRARY grid/list and the
in-browser search box can't find it either, because search filters only the
entries already loaded for the *current* directory — it does not query the
API again. Pick a folder near the alphabetic front (`00...`, `00291...`) when
demonstrating or testing this root.

## Write-set

Declared: `forge-control-web/app/desktop/nav-items.ts`,
`forge-control-web/app/desktop/DesktopApp.tsx`,
`scripts/checks/check-phase3-placeholders.ts`,
`evidence/library-map-verification.md`.

**Only `evidence/library-map-verification.md` was written this turn** — the
other three files already existed at HEAD with the exact contents the brief
asked for (commits `2b6c3e1`, `aa67072`, `514802d` from an earlier turn on
this task). No file outside the declared write-set was created or modified
in the repo. `/tmp/probe-7798.mts` and `/tmp/library-viewer-demo.mjs` are
throwaway verification scripts outside the repo, not committed, not part of
the write-set.

## What's left

Nothing outstanding for this round's brief. Both `unbuilt` flags are cleared,
both surfaces render real data end-to-end, the media viewer is proven on all
three required formats, and all four verification gates pass.
