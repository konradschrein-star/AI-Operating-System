# 00 — Vision: files-pane-fast-light

## The goal, precisely

Make the Files experience in `forge-control-web` **genuinely fast** and **fully
correct in light mode**. Konrad's words: *"when I click the file section, things
still lag and they still don't work in light mode."*

This is the overnight proving run for goal mode. The bar is **quality over
speed**, but the work must be **DONE and DEPLOYED by morning** — merged into
`main` in the live checkout `/opt/forge-ai-os`, rebuilt, and serving.

## Where the Files experience lives

- **UI:** `forge-control-web/app/desktop/chat/FileExplorerPanel.tsx` — mounted as
  the "Files" tab of the right-hand `SidePanel` in
  `forge-control-web/app/desktop/ChatSurface.tsx` (line ~378). Today it wraps the
  third-party component `@cubone/react-file-manager` (v1.35.0) plus our own
  `FilePreview`, `SearchResultsList`, and a drag-out handler.
- **Panel CSS:** `forge-control-web/app/desktop/chat/FileExplorerPanel.css` — a
  49-line block of hardcoded dark hex values, every one marked `!important`,
  overriding the library's light-only theme.
- **API:** `forge-control/src/routes/files.ts` — Hono routes
  `/api/files/{roots,list,search,read,attach}`, path-contained to two named roots
  (`vault` → `/opt/obsidian-vault`, `workspace` → `/opt/ai-os/workspace`).
- **Tokens:** `forge-control-web/app/tokens.ts` maps each `tokens.*` to
  `var(--fg-*)`; `forge-control-web/app/theme.css` defines both palettes (`:root`
  = dark, `html[data-theme="light"]` = light). Any hardcoded hex/rgb/hsl in a
  Files component is therefore a light-mode bug **by definition** — it cannot flip.

## What is actually wrong (measured, not assumed)

Baseline captured against the live API on `:7700` and the real vault
(see `docs/plan/BASELINE-FINDINGS.md`):

1. **Light mode is broken by `FileExplorerPanel.css`.** It pins the entire
   `.file-explorer` subtree to dark hex (`#0b0b0c`, `#08080a`, `#ededee`, …) with
   `!important`. Those declarations do not participate in the theme cascade, so in
   light mode the pane stays a dark rectangle inside an otherwise white app —
   exactly the reported symptom. Census: **49 hardcoded-color lines** across
   `FileExplorerPanel.tsx` + `.css`; **49 `!important`** in the CSS.

2. **The lag is client-side, not the API.** `/api/files/list` returns in
   **1–14 ms** and the largest *real* directory in the vault is **86 entries**.
   The lag comes from (a) mounting the heavy third-party `FileManager` on every
   Files-tab switch, and (b) an **unbounded, ever-growing flat `files` array** —
   `loadDir` appends each visited directory's children and never drops siblings,
   so the array accumulates across the whole session and the un-virtualized
   library lays out every row it holds on each render.

3. **No virtualization anywhere.** `@cubone/react-file-manager` ships no windowing
   (confirmed: no `react-window`/virtual in its `dist`). A 1000+ entry directory
   would freeze the main thread. Real dirs are small today, but the Definition of
   Done requires this case to stay responsive.

4. **A silent error swallow.** `loadDir` does `fetchFileList(...).catch(() => [])`
   — a failed listing renders as an *empty directory* with no signal. Hard errors
   are policy in this system; this must surface.

## Definition of Done (verbatim, with the measurable form)

| # | DoD statement | Measurable form |
|---|---|---|
| D1 | Clicking into Files renders visibly within ~200 ms on typical directories | Click-to-first-paint of the Files tab ≤ 200 ms on a ≤100-entry dir (typical) |
| D2 | Large directories (1000+ entries) stay responsive — virtualized or paginated, no frozen main thread | A synthetic 1000+ entry dir scrolls at ≥ ~50 fps; no long task > 200 ms on open |
| D3 | No API call in the click path fetches recursively more than the directory being viewed | `/list` is single-level (already true); the click path issues exactly one `/list` |
| D4 | Zero hardcoded colors in Files components; readable & consistent in BOTH themes | `grep -nE '#[0-9a-fA-F]{3,8}\|rgba?\(\|hsla?\('` over touched components = 0 hits; both themes screenshot-verified |
| D5 | `npx tsc --noEmit` clean in `forge-control` AND `forge-control-web` | Both exit 0 |
| D6 | `npm run build` (i.e. `pnpm build`) passes in `forge-control-web` | Exit 0 |

## Measurable success criteria (acceptance for the whole goal)

- **S1** — Files-tab click-to-first-paint ≤ 200 ms on a typical directory, and
  **re-visiting** an already-seen directory paints from cache in < ~30 ms.
- **S2** — A directory of ≥ 1000 entries opens without a main-thread stall > 200 ms
  and scrolls smoothly (windowed rendering).
- **S3** — The Files pane is fully legible and visually consistent in **both**
  light and dark themes; a reviewer confirms via screenshots in both modes.
- **S4** — Zero hardcoded color literals in every touched Files component
  (`.tsx` and `.css`); all colors resolve through `tokens.*` / `var(--fg-*)`.
- **S5** — `tsc --noEmit` clean in both repos; `pnpm build` green in the web app.
- **S6** — A failed directory listing renders an explicit error row, never a
  silently-empty folder.
- **S7** — Deployed: merged to `main` in `/opt/forge-ai-os`, both pm2 processes
  online, `/api/health` 200, web app HTTP 200 on its port.

## Non-goals (explicitly out of scope)

- **N1** — No redesign of the desktop shell. `DesktopApp.tsx` and
  `app/desktop/live/` stay untouched (a single-line integration point is tolerated
  only if strictly unavoidable, and must be called out).
- **N2** — No new file *operations* (create / rename / move / delete / upload).
  The pane stays read-only browse + preview + download + attach + drag-to-chat, as
  today. `permissions` in the current component are already all-false except
  `download`/`move` (move is only used to enable the native `draggable` attribute).
- **N3** — No change to the security/containment model in `files.ts`
  (`resolveInRoot`, dotfile/symlink/traversal guards) beyond what perf hardening
  strictly requires — and any such change must preserve identical containment.
- **N4** — No drive-by refactors outside the Files experience. The diff stays
  focused on the files pane, its API routes, its client helpers, and the two
  theme-token files it depends on.
- **N5** — No new roots, no arbitrary filesystem browsing. The two named roots
  stay as-is.
- **N6** — Not touching `forge-executor` in any way (hard rule).

## One-paragraph statement of intent

We will replace the third-party `FileManager` list surface with a small,
purpose-built, **virtualized, token-native** list component that we fully own —
because that single move eliminates *both* root causes at once: it deletes the
49-line `!important` shadow-palette (fixing light mode structurally rather than by
patching hex), and it gives us windowed rendering plus a bounded per-directory
data model (fixing the lag). Everything already ours — preview, search, attach,
drag-out, and the secure backend — is preserved unchanged. See
`docs/plan/02-architecture.md` for the decision and its rejected alternatives.
