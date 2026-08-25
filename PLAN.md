# Plan: aios-chat-reference-navigation

Architect round 0, 2026-08-25. Every claim below was read from the code or observed
in a real browser (screenshots under `/opt/ai-os/uploads/051c7e2a92b5/`).

## Recommendation, in one paragraph

Port the uncommitted live-checkout work onto this branch first (it is the sole copy),
then extend it along five disjoint file clusters in parallel workstreams: **detect**
(`code-path-link.ts`: `path:line`, folders, wikilink parsing, false-positive fixes,
memory root), **preview** (`FilePreview.tsx`: frontmatter strip, line-numbered code
viewer with a highlighted line, real previews per format), **panel**
(`FileExplorerPanel`/`VaultFileList`/bus: reveal + flash the opened entry, open folders,
carry the line), **markdown** (`MessageMarkdown.tsx` + a tiny remark wikilink plugin,
resolution order, pending state, no-listener fallback, restrained discoverability),
and **test** (a committed Playwright regression test that clicks a pill from the Team
tab). Server work is one small task in `main` (a read-only `memory` root). One reviewer
joins everything; one deploy/verify task ends it with live screenshots.

## What I found (facts, not the brief's claims)

1. **The "already done" work is the SOLE COPY.** `code-path-link.ts`, `open-file-bus.ts`
   and the hunks in `MessageMarkdown.tsx`, `FileExplorerPanel.tsx`, `ChatSurface.tsx`,
   `routes/files.ts` exist only as uncommitted edits in `/opt/forge-ai-os`
   (`git log --all -S consumePendingOpenFile` → nothing). Preserved:
   `/opt/ai-os/uploads/051c7e2a92b5/live-chat-ref-nav-tracked.patch` (4 tracked files,
   re-snapshotted after the manager's `readOnly` edit) plus `live-code-path-link.ts`,
   `live-open-file-bus.ts`, `live-detect-test.mts`. Round 1 ports them. The live
   checkout is NOT to be edited or reverted by anyone in this project — deploy handles it
   with Konrad's explicit OK (protocol: `live-checkout-dirty-protocol`).
2. **`routes/files.ts` was never read-only.** `PUT /files/write` has been on main since
   `ad35016` (the LIBRARY editor). The manager has since added `readOnly: true` on
   `aios`/`forge-src` in the live file and `/write` answers 403 (verified live). That
   edit is inside the preserved patch and ships with the port.
3. **R1 is satisfied at the API level**: after the 02:5x restart `/api/files/roots`
   lists `aios` and `forge-src`; `/read?root=forge-src&path=docs/plan/03-quality.md` →
   200, 28 KB. In the browser the pills render with `data-openable-path` on the live
   build (BUILD_ID 02:50 contains the attribute). A click on an absolute `forge-src`
   pill could not be photographed: the thread is windowed ("show 60 older"), so older
   pills are not in the DOM, and worker reports render in the collapsed AGENT COMMS
   strip. The deploy/verify task proves it with a seeded message.
4. **A clicked `.ts/.tsx/.py` file cannot render.** `FilePreview` (used by BOTH the Files
   panel and `/document`) knows only `.md .txt .json .csv` + media; everything else is
   "no inline preview — download". The line-numbered viewer exists only in
   `MediaDocumentViewer` (Library surface). This is what Konrad's "still don't open up
   in a proper way" and his later "proper inline previews for the different file formats"
   are about. D1 is impossible without fixing this.
5. **Bare names resolve slowly and to the wrong tree.** `SEARCH_ROOTS` walks `workspace`
   before `forge-src`; `MessageMarkdown.tsx` has 46 copies under `workspace/projects/*`
   and 1 under `forge-src`. Live click on `ChatSurface.tsx`: 4 s later nothing visible,
   panel still on Team, no toast (shot `20260825T010724Z-r1-bare-chatsurface-after.png`).
   There is no pending state while the searches run.
6. **False affordances exist today**: `.txt`, `.md .txt .json .csv`,
   `.ts .tsx .js .py .sh .sql` are marked openable on the live page (dead clicks).
7. **D6**: `resolveInRoot`'s dot-segment guard inspects only the root-RELATIVE path
   (`files.ts:76`), so a root whose own directory contains `.claude` is fine. Decision:
   add a dedicated read-only root `memory` → `/root/.claude/projects/-opt-forge-ai-os/memory`.
8. **D8**: `MobileApp.tsx` renders no chat at all (control tabs only). Nothing to make
   work. The markdown task adds a fallback: if no Files panel is listening, a click
   navigates to `/document` in the same tab — so any surface without a panel still opens
   the file instead of doing nothing.
9. `metadata.tier_pin = flagship` on this project overrides every per-task tier. Reported
   to the manager chat with a choice block; tiers below are set honestly anyway.
10. `aios-sidebar-live-sessions` has not touched `ChatSurface.tsx` yet (its toggle task is
    round 3, pending). Our only change to that file is the 16-line subscribe effect at
    ~line 711 — far from the right-panel block. Keep it that way.

## Design decisions (owner of state / dispatch / failure / visibility)

- **State**: the Files panel owns navigation + selection (unchanged). The bus carries one
  request `{root, path, line?, isDir?}` with the latch (unchanged, load-bearing).
  `requestOpenFile` returns the listener count so a caller can tell "nobody heard".
- **Dispatch**: `MessageMarkdown` resolves → `requestOpenFile`. Resolution moves into
  `resolve-path.ts` (shared with `/document`). Order: vault → forge-src → aios →
  uploads → memory → workspace, and inside workspace non-`projects/` paths rank first.
- **Failure**: every miss toasts (kept); resolution longer than ~1 s shows a pending
  state; zero listeners → `window.location.assign(/document…)`. No silent branch anywhere.
- **Visibility**: the regression test asserts tab flip + zero new tabs + rendered content.
- **Wikilinks (D2)**: a 40-line remark plugin (no dependency) turns `[[Note]]`,
  `[[Note|Alias]]`, `[[Note\|Alias]]` (table escape), `[[Note#Heading]]`,
  `[[Dir/Note]]` into a `link` node with `href=/document?wikilink=<name>`. That href
  passes `safeHref` (same-origin relative) and the allowlist keeps `href` on `a`; the
  `a` component override — our code, not markup — intercepts `/document?…` hrefs on
  plain click. NO rehype-raw. Both gates stay.
- **Frontmatter (D3)**: `splitFrontmatter()` pure helper; rendered as a compact
  mono meta strip above the body, never as prose.
- **Discoverability (D7), default pending Konrad**: openable pills take the link colour
  (`var(--v2-accent)`) with the existing dotted underline; other pills unchanged. Nothing
  else. Escalated with alternatives.
- **Attach (D9)**: no new pill affordance. After D4 the clicked file is selected and
  revealed, so the panel's existing "attach" button is one click away.
- Rejected: server-side `/files/resolve` (cleaner, but a new API shape while the client
  resolver already works); adopting `MediaDocumentViewer` in the panel (900 lines with an
  edit mode — the chat must not grow an editor); rehype wikilink plugin (would run inside
  the sanitised tree; remark is earlier and simpler); a badge on every pill (D7).

## Task graph (ids appended below after seeding)

Workstreams: main, detect, preview, panel, markdown, test (6 = the cap).

- R0 `main` **port** — apply the preserved patch, port the 18 detect cases into
  `scripts/checks/check-code-path-link.ts`, wire the gate. Everything depends on it.
- R1 parallel: `detect` (A), `preview` (B), `panel` (C), `main` server `memory` root (D),
  `test` Playwright regression (E).
- R2: integrations of detect / preview / panel back into `project/ecacba29`.
- R3: `markdown` (F) — depends on the detect + panel integrations (it consumes both).
- R4: `/document` page (G, markdown workstream). R5: markdown integration.
- R6: extend the regression test with D1–D6 cases (H, test workstream) after all
  integrations. R7: test integration. R8: ONE reviewer. R9: deploy + verify on live.

## Constraints every builder inherits

- Work only in this project's worktrees. Never edit `/opt/forge-ai-os`. Never restart
  forge-executor. forge-control restarts only via the deploy task's safe-restart.
- `pnpm install --frozen-lockfile --prod=false` before any gate; typecheck takes ~150 s —
  raise the Bash timeout.
- `MessageMarkdown.tsx`: memo on `source` alone; no rehype-raw; allowlist + urlTransform.
- `routes/files.ts`: no new write verb; every new root is `readOnly: true`.
- No new poll. `fetchFileRoots` stays a cached module promise.
- Read `/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md` first; the browser
  harness notes there (`playwright-driver-two-launch-traps`,
  `nextauth-salt-must-equal-cookie-name`, `stale-session-cookie-fakes-a-perfect-score`,
  `real-client-network-capture-recipe`, `chat-renders-shots-two-shapes`) cost hours each.

## Seeded task ids (2026-08-25)

- 0c92ecdf-7dba-4ced-af77-5d0006b21b21 builder r0 [main] Port the live chat-reference-navigation patch onto the branch + detect unit check
- 07002755-264f-4ec0-8f66-68e7649f6ad2 builder r1 [detect] detectPath: line refs, folders, wikilink parsing, memory root, no false affordances
- 8c875963-ef2f-4306-b694-8539811cc57e builder r1 [preview] FilePreview: frontmatter strip, line-numbered code viewer with highlighted line, real previews per format
- e462d94a-d6bc-484b-ad20-93e4c6c23b7b builder r1 [panel] Files panel: reveal + flash the opened entry, open folders, carry the line, bus listener count
- 7f57052a-1c5c-407d-816e-3dc4b5cbc6c2 builder r1 [main] files.ts: read-only memory root for the fleet knowledge base + node:test for readOnly and roots
- 155bcf50-e3b5-4579-90fe-dd4e5dcccee8 builder r1 [test] Playwright regression: click a path pill from the Team tab, assert tab flip, no new tab, content rendered
- ff136563-a4eb-43d8-a435-4cfc9a768a64 builder r2 [main] Integrate workstream detect into project/ecacba29
- 3c047062-3f60-4303-8956-f9e27a7daea8 builder r2 [main] Integrate workstream preview into project/ecacba29
- 8f48e1c4-de49-498e-8953-556269d3a63a builder r2 [main] Integrate workstream panel into project/ecacba29
- e99810f4-285a-45f4-9e44-6878bda3583c builder r3 [markdown] MessageMarkdown: wikilinks, line refs, resolution order, pending state, no-listener fallback, discoverability
- f687d7f7-f1c6-46fc-a6cb-a966b50f71aa builder r4 [markdown] /document: accept ?line= and ?wikilink= via the shared resolver
- 796e0c33-377e-4a29-bfe7-f56ae61b3b62 builder r5 [main] Integrate workstream markdown into project/ecacba29
- 27ed1984-3a1c-4dce-a852-cc7f77bc40e1 builder r6 [test] Extend the regression test: line highlight, wikilink, folder, frontmatter strip, memory root, dead-pill guard
- d6fa60e3-2ea7-40b6-9685-b9fbfdcc91a4 builder r7 [main] Integrate workstream test into project/ecacba29
- 3d7b732c-8910-4ab3-81fe-f8619ccd0431 reviewer r8 [main] Review chat reference navigation: the whole diff of project/ecacba29 against main
- f7232d26-b44f-486c-a3ff-084ddda3a99b builder r9 [main] Deploy chat reference navigation to live and verify by clicking, with screenshots
