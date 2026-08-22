# WORKLOG — aios-excalidraw-to-plans

## Round 0 — Builder: index Excalidraw drawings into the knowledge base

### What I built

| file | state |
|---|---|
| `forge-control/src/lib/excalidraw-extract.ts` | new, 918 lines — the codec-to-graph-to-text pipeline |
| `forge-control/src/lib/excalidraw-extract.test.ts` | new, 37 tests |
| `forge-control/src/lib/excalidraw-extract-cli.ts` | new — the bridge km-indexer.js needs (undeclared, see HANDOFF §5) |
| `forge-control/src/lib/index-health.ts` | `excluded_extension` → `empty_drawing` |
| `forge-control/src/lib/memory-index-health.test.ts` | updated with it (undeclared; the declared `index-health.test.ts` does not exist) |
| `forge-control/src/lib/vault-fixture.ts` | two comments (undeclared) |
| `forge-control/src/db/memory.ts` | `syncVaultNotes` and `measureIndex` route drawings through the extractor |
| `HANDOFF.md` | the km-indexer hunks I did not apply, plus findings |

### Design decisions worth knowing

- **Containment, not frames.** There are zero `frame` elements in the whole
  vault. Sections are dashed rectangles drawn behind their contents, so grouping
  is computed from geometry: smallest strictly-larger box wins, `frameId` wins
  over geometry when present.
- **Section titles match on their ORIGIN point, not their bounding box.** Two of
  five section titles on the Stealth map are wider than the box they name.
  Confined to the title pass; every other relation needs real containment.
- **Colour is named, never interpreted.** The drawing's own legend is quoted
  verbatim. See HANDOFF §4 — this is the decision the plan task must not undo.
- **Unbound arrows are reported, not resolved.** A proximity heuristic would
  have produced plausible edges the file does not support.
- **Mute nodes are tallied.** 300+ unlabelled freedraw strokes collapse to one
  line, so the 416 KB handwriting page renders to 682 B instead of 9 KB of noise.

### Verified — commands run, output observed

```
cd forge-control
npx tsc --noEmit                       → clean, no output
npx tsx --test src/lib/*.test.ts       → 1687 pass / 0 fail (317 suites)
pnpm test                              → 1687 pass / 0 fail

cd forge-control-web
pnpm install --frozen-lockfile --prod=false   → typescript 5.7.2 added
npx tsc --noEmit                       → clean, exit 0
npm run build                          → succeeded, 12 routes emitted
```

Against the real vault (read-only, no database touched):

- extractor over all 15 `.excalidraw.md` files: 9 render, 6 hold nothing
  extractable. 1.43 MB of drawings → 41 KB of text.
- `Stealth Uploader - System Map`: 33,107 B → 3,934 B, 7 titled sections, 11
  resolved arrows, 1 ambiguous one reported as ambiguous, legend quoted.
- CLI contract exercised on real files: exit 0 (Warming Timeline), exit 3
  (Directory Engine, blank), exit 1 (a Daily note, not a drawing).
- registry preview: topic `"AI OS   Life & Company OS   Planning
  Canvas.excalidraw"` → `"AI OS - Life & Company OS - Planning Canvas"`;
  wikilinks `[]` → 3 real targets on `Drawing 2026-07-03 18.25.45`.

Repo gate suite `scripts/checks/gates-808.sh --strict`: 25 gates, 23 executed,
2 skipped by design (`--browser` not requested). The 6 reds in the first run
were all `forge-control-web` gates failing on a missing `typescript` —
devDependencies had never been installed in this worktree (`npx tsc` printed
"This is not the tsc command you are looking for"). Installed with
`--prod=false` and re-ran. `forge-control` gates (1, 20) are green.

### Not done

- `/opt/knowledge-mcp/km-indexer.js` — deliberately not edited. Reasons and the
  five exact hunks are in `HANDOFF.md` §1–2.
- No screenshot: this round is backend only and touches no surface.
