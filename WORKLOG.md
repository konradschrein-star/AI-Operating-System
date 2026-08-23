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

## Round 2 — Builder: CanvasPane Plan UI, Editor, and Project Push

This round's write-set (`app/api.ts`, `app/desktop/canvasLive.ts`,
`app/desktop/CanvasPane.tsx`) was **already implemented and committed** when
this task started — commits `f2c75ec` (typed client methods) and `0da594f`
(drawer UI, ambiguity banner, markdown editor, push-to-project) were on the
branch already. This round is verification plus one real defect found and
fixed, not a from-scratch build.

### What I found and fixed

`scripts/checks/gates-808.sh` gate 5 (`no-raw-colours.cjs`) was RED on a
literal this round's own commit introduced:
`CanvasPane.tsx:1289  boxShadow: "0 8px 32px rgba(0,0,0,0.4)"` on the plan
drawer's confirm-modal card. Fixed by routing it through `tokens.overlay`
(already used one element up, for the same modal's backdrop) —
`` boxShadow: `0 8px 32px ${tokens.overlay}` `` — which is theme-aware where
the literal wasn't. Commit `019bebf`. Re-ran the gate: 0 new-and-unlisted
hits from this file; the remaining 2 (`gemini-identity.tsx`) predate this
project (see Round 0 note) and are outside this write-set.

### Verified — commands run, output observed

```
cd forge-control-web
npx tsc --noEmit          → clean, exit 0
npm run build             → exit 0, 12 routes, /canvas and /desktop both emitted
node ../scripts/checks/no-raw-colours.cjs → CanvasPane.tsx clean after the fix
```

Screenshots (real vault drawing `Excalidraw/Stealth Uploader - System
Map.excalidraw.md`, 44 nodes / 12 arrows, the same one Round 1's tests use),
Plan drawer open, both themes:
- `20260823T023700Z-canvas-plan-visual-dark.png` — Structured Plan tab, dark
- `20260823T024200Z-canvas-plan-visual-light.png` — Structured Plan tab, light
- `20260823T024500Z-canvas-plan-markdown-dark.png` — `.plan.md` tab, dark

All three show: the Ambiguity Alert Banner (`tokens.warn`, left border +
icon) listing 6 concrete open questions (dangling arrow, 5 unconnected
nodes) rather than a silent guess; workstream filter chips; phase-grouped
task cards with status chips (GAP/PLANNED/PROPOSAL/BLOCKED/DONE); a
`Push to Project` button; and, on the markdown tab, a live-editable
`.plan.md` body with a `Save .plan.md` button. Both themes render with
correct contrast, no white-on-white or black-on-black.

Not shot: the loading skeleton, the empty state (no drawing selected), and
the error+retry state — all three exist in the code (`planLoading`,
`!planLoading && planErr` branches, `Retry` button) but I did not
force-trigger them for a screenshot this round; read `CanvasPane.tsx:1583-1690`
to see them directly.

### How I verified without touching live services (see HANDOFF for the incident)

The declared brief for this house says to screenshot via
`/opt/ai-os/workspace/shots-aios.mjs` against the live :7701/:7700 pair, but
those live processes do NOT yet have this branch's backend routes deployed
(`GET /api/canvas/plan` 404s on live :7700 — the Round 1 backend work is
merged to this branch, not to `/opt/forge-ai-os`). I mounted a **read-only
probe**: only `routes/canvas.ts`, global non-GET-refusing middleware ahead of
it, everything else proxied read-only to live :7700 for real vault-list data.
Verified refusal directly: `POST .../plan/save` → 405, `PUT .../file` → 405.
Built `forge-control-web` with `FORGE_CONTROL_URL` pointed at that probe (the
rewrite bakes at build time) and served it on a throwaway port for the
screenshots above. Full teardown confirmed after: no stray listeners on
7797–7799, `pm2 list` restart counts for `forge-control` (75) /
`forge-control-web` (38) / `forge-executor` (5) unchanged from before this
round, `curl :7700/api/today` still 200.


## Round 3 — fix cycle 1 (reviewer findings from round 2)

### Finding 1 (HIGH) — silent depends_on drop, `canvas.ts:846-871` — FIXED

`POST /api/canvas/plan/to-project` inserted tasks in `plan.tasks` order (phase,
workstream, id) and `.filter()`ed out any dependency whose row did not exist
yet. No error, no log, no field in the response.

Measured over all 15 vault drawings before the fix: **`Drawing 2026-07-07
18.30.43` lost 3 of its 8 dependency edges**, silently. That is the reviewer's
finding on real data, not a fixture.

- `lib/excalidraw-plan.ts` — new `resolvePlanInsertionOrder()`. Kahn over the
  plan's own ids, so every representable edge survives regardless of the order
  `plan.tasks` happens to be in. The `unresolvable` set is a **replay** of the
  caller's insert over the resulting order, not a prediction — my first version
  predicted from where Kahn stalled and reported `leaf <- b` (downstream of a
  cycle, but perfectly writable) as lost. A test caught it; deriving the report
  from the final order makes it exact by construction.
- `routes/canvas.ts` — refuses with **409** and names every edge, *before*
  `createProject()` so a refusal leaves nothing half-created.
  `allow_unresolved_dependencies: true` is the explicit override; the omissions
  then come back as `droppedDependencies` and are logged.
- 8 new tests in `lib/excalidraw-plan.test.ts`.

Verified against the real drawing through a throwaway probe (canvas router only,
scratch vault, port 7413 — never `src/index.ts`, never the live checkout):

```
HTTP 409
"error": "3 dependency edge(s) in this plan cannot be written as a task graph
          — 3 of them close a cycle, which would also wedge the project permanently"
"unresolvable": [ Architect/Planner <- Implementer(s) (cycle) x3 ]
```

### Finding 2 (Milestone 1 not live) — ESCALATED, still open

Re-verified read-only: `/opt/knowledge-mcp/km-indexer.js:36` still carries
`.excalidraw.md` in `EXCLUDED_EXTENSIONS`. Reported to the manager chat as
needing a deploy task; the hunks are in `HANDOFF.md` §1/§2. **Not fixed here** —
editing an untracked, in-use live service from a build task is exactly what the
worktree-only policy forbids, and round 0 refused it for the same reason.

### Finding 3 (process — live UPDATE from a build task) — ACKNOWLEDGED

No live-database write was made in this round. The only live-system read was
`grep` over `km-indexer.js`. The probe above mounts one router against a
**scratch vault** (`/tmp/aios-4a01858a-vault`) and proxies everything else to
:7700 read-only.

### Reviewer's verdict item 2 — UI gate — FIXED

`CanvasPane.tsx`: Create Project now requires an explicit acknowledgement when
`plan.ambiguities.length > 0`, naming what is unresolved ("3 cycles, 1 dangling
arrow"). The acknowledgement re-arms on every dialog open and every plan
refresh. A 409 renders each refused edge with a separate "Create anyway,
omitting N edges" action, and a lossy push reports its omissions in the success
panel so it can never read as a clean one. `api.ts` grew a typed
`UnresolvedDependenciesError` because the shared `postJson` discards the body.

### Round 3 verification (all run, all output real)

| what | result |
|---|---|
| `forge-control` `npx tsc --noEmit` | EXIT=0 |
| `forge-control-web` `npx tsc --noEmit` | EXIT=0 |
| `forge-control-web` `npm run build` | EXIT=0 |
| `forge-control` `npm test` | **1719/1719 pass** (8 new) |
| `scripts/checks/gates-808.sh --strict` | 25 gates · 23 EXECUTED · 2 SKIPPED (no `--browser`) · **1 RED** |

The single RED is gate 5, `no-raw-colours.cjs`, on
`forge-control-web/app/desktop/gemini-identity.tsx:27,30`. Not this branch:
`git log -1` on that file is `784e7df`, and `git merge-base --is-ancestor`
confirms that commit is already on `origin/main`. Pre-existing debt, same
finding the round-2 reviewer recorded. My files produce no gate-5 hits.

One of my own tests failed the first full-suite run: I fixed the 409 message's
singular/plural grammar *after* running the plan tests, so `/close a cycle/`
no longer matched `"1 of them closes a cycle"`. Stale assertion, not a code
defect — fixed in `795769e` and re-run green. Recording it because the first
`npm test` genuinely printed `# fail 1`.

### Browser evidence

Driven against a throwaway `next start` on :7419, built with
`FORGE_CONTROL_URL=http://127.0.0.1:7413` so `/api/proxy` reached **this
worktree's** canvas router and not live :7700 (the rewrite is baked at build
time). The probe served a scratch vault holding one copied real drawing;
`/opt/forge-ai-os` was never touched and no project was created — the run
clicks "Create Project" once, which the API answers 409 from the plan alone,
and never clicks "Create anyway".

- `20260823T104944Z-push-gate-{dark,light}.png` — the ambiguity gate: "23
  UNRESOLVED QUESTIONS … 10 unlabelled shapes, 6 cycles, 4 unconnected nodes,
  2 dangling arrows, 1 unexplained color", Create Project **disabled**
  (asserted in-page: `disabled=true`, then `false` after the tick).
- `20260823T104729Z-push-409-{dark,light}.png` and the `104944Z` pair — the
  refusal: "3 DEPENDENCIES CANNOT BE SEEDED / Nothing was created", all three
  edges named with their plan-local ids, and "Create anyway, omitting 3 edges"
  as a separate action.
- Zero page errors in either theme. Both themes checked, not just dark.

Anti-evidence worth stating: this drawing renders fine in the Excalidraw
canvas. The `invalid order key: a0080` crash the round-2 reviewer hit is
specific to `Stealth Uploader - System Map`, still unfixed, still out of scope.

Teardown: both throwaway servers killed, ports released, `.env.local` removed
from the worktree, and `forge-control-web` rebuilt with the default so
`.next/routes-manifest.json` points back at `http://127.0.0.1:7700/api/:path*`.
