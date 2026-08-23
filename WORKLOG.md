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

Repo gate suite `scripts/checks/gates-808.sh --strict`: **25 gates, 23 executed,
2 skipped by design** (`--browser` not requested), **1 RED**.

The first run showed 6 reds. All six were `forge-control-web` gates failing on a
missing `typescript` — devDependencies had never been installed in this worktree
(`npx tsc` printed *"This is not the tsc command you are looking for"*). After
`pnpm install --frozen-lockfile --prod=false`, gates 2, 3, 9, 13 and 14 went
green. A seventh red in the very first run (gate 20, `pnpm test`) was my own
contention: I had the same suite running in the background. It is green in both
clean runs.

The remaining red is **gate 5, `no-raw-colours.cjs`**, and it is not mine:

```
── FAIL: 2 raw colour literal(s) with no allowlist entry ──
  forge-control-web/app/desktop/gemini-identity.tsx:27  #8b7bf0
  forge-control-web/app/desktop/gemini-identity.tsx:30  rgba(139, 123, 240, 0.16)
```

That gate scans `forge-control-web/app` only (`no-raw-colours.cjs:77`), and
`git diff --name-only main...HEAD` shows this branch touches no file under it.
I did not fix it — I do not own that file and this round adds no web code.

### Not done

- `/opt/knowledge-mcp/km-indexer.js` — deliberately not edited. Reasons and the
  five exact hunks are in `HANDOFF.md` §1–2.
- No screenshot: this round is backend only and touches no surface.

## Round 1 — Builder: Drawing Structure Parser and Actionable Plan Engine

### What I built

| file | state |
|---|---|
| `forge-control/src/lib/excalidraw-graph.ts` | new, 570 lines — spatial DAG parser with container hierarchies, proximity arrow snapping, legend-driven status inference, and explicit ambiguity detection (cycles, dangling arrows, unlabelled shapes, unconnected nodes, unexplained colours) |
| `forge-control/src/lib/excalidraw-graph.test.ts` | new, 232 lines — 6 test suites covering synthetic fixtures (legend overrides, proximity resolution, cycle detection, ambiguity discovery) and real vault drawings (`Stealth Uploader - System Map`, `Stealth Uploader - Warming Timeline`) |
| `forge-control/src/lib/excalidraw-plan.ts` | new, 470 lines — actionable plan compilation (topological phase sorting, container-to-workstream grouping, role/tier selection heuristics, task briefs, write_set inference, and bidirectional Markdown serialization with prominent Ambiguities & Open Questions) |
| `forge-control/src/lib/excalidraw-plan.test.ts` | new, 306 lines — 11 tests covering synthetic DAG compilation, workstream grouping, ambiguity rendering, real vault drawings, and full route testing for `GET /api/canvas/plan`, `POST /api/canvas/plan/save`, and `POST /api/canvas/plan/to-project` |
| `forge-control/src/routes/canvas.ts` | updated (+226 lines) — added `GET /api/canvas/plan`, `POST /api/canvas/plan/save`, and `POST /api/canvas/plan/to-project` with input validation, vault path escaping guards, topological task creation, and workspace provisioning |

### Design decisions worth knowing

- **Ambiguities are surfaced as questions, never guessed.** Dangling arrows, cycles, unconnected nodes, unlabelled elements, and unmapped colors produce concrete questions in an explicit "Ambiguities & Open Questions" block.
- **Proximity arrow resolution.** Endpoints within 50px of candidate shapes are snapped to closest shapes with tie-breaking safeguards.
- **Topological DAG layering for phases.** Phase numbers are derived from in-degree dependency depth so prerequisite steps are scheduled in earlier rounds.
- **Real vault testing.** Unit tests parse actual vault drawings (such as `Stealth Uploader - System Map.excalidraw.md`) into phased tasks and workstreams.

### Verified — commands run, output observed

```
cd forge-control
npx tsc --noEmit                                           → clean, exit 0
npx tsx --test src/lib/excalidraw-*.test.ts                 → pass 54 / fail 0 (7 suites)
pnpm --filter forge-control test                           → pass 1701 / fail 0

cd forge-control-web
npx tsc --noEmit                                           → clean, exit 0
```

