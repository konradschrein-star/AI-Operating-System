# R2-gate — Phase 2 gating review: the memory surface tells the truth, or it does not ship

**Reviewer round:** 10 · **Task:** R2-gate (`2221535d-67be-4f6b-9ca2-da2a1b28b776`)
**Tip reviewed:** `9f728c994d0f9b2dcee4f0788f8c6ba969e886ef` (confirmed via `git rev-parse HEAD`,
re-confirmed immediately before this verdict was written — no drift during the review)
**Branch:** `project/7851068b-vault` · **Worktree:** this one (no other checkout was read or written)
**Merge-base against `project/7851068b`:** `3f98e67114a8a1fd12fced068e2238b51c766462`

---

## 1. The universal block — verbatim (summarised where noted, full transcripts kept in shell history)

```
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 750ms using pnpm v9.15.9

$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 1s using pnpm v9.15.9
```
No `- typescript` pruning in either transcript — both installs ran with dev-deps intact.

```
$ cd forge-control && npx tsc --noEmit
EXIT=0

$ cd forge-control-web && npx tsc --noEmit
EXIT=0
```
Both packages typecheck clean. The brief warned forge-control-web might be red on stale
`KnowledgeGraphData`/`fetchMemoryCounts` exports in `app/api.ts` — it is not: those exports still
exist (deliberately un-replaced per `api-vault.ts`'s own header comment, filed as phase-7 debt in
`font-decision.md`), nothing in this phase's diff broke their types, and no phase-2 file imports them
anymore. Not a new red; not even a red.

```
$ cd forge-control && pnpm test
# tests 1438
# suites 269
# pass 1438
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
Baseline (phase 1) recorded 1293/1293. 1438/1438 now — phase 1's fix-cycle tests plus phase 2's
`memory-graph.test.ts` (374 lines, 17 tests) account for the growth. Confirmed the new file runs BY
NAME in the earlier verbose transcript (`grep -n memory-graph /tmp/pnpm-test-verbose.txt` before the
summarised re-run) — `forge-control/package.json:12`'s `tsx --test src/lib/*.test.ts` glob does pick
it up because it lives directly under `src/lib/`.

```
$ bash scripts/checks/gates-808.sh --strict          (timeout 600000ms, actual runtime well under it)
EXIT=1
RED: 1
```
Full transcript is in `/tmp/gates-run.txt` at review time; the SUMMARY block and every gate's own
output were read gate-by-gate (§2 below reproduces the material parts). **This is a change from the
phase-1 baseline (`RED: 0`) and is adjudicated in §2.**

---

## 2. gates-808 diff against `phase1/gates-baseline.txt`, every difference adjudicated

Baseline: commit `9d63480`, `RED: 0 — 23 GREEN, 2 SKIPPED, 0 RED, out of 25 gates`.
This run: commit `9f728c9`, `RED: 1 — 22 GREEN, 2 SKIPPED, 1 RED, out of 25 gates`.

Gate-by-gate, by NAME (per the baseline's own rule — numbers do not survive a round, though here they
happen to still line up 1:1):

| # | gate | baseline | this run | verdict |
|---|---|---|---|---|
| 1 | tsc — forge-control | GREEN | GREEN | unchanged |
| 2 | tsc — forge-control-web | GREEN | GREEN | unchanged |
| 3 | pnpm build — forge-control-web | GREEN | GREEN | unchanged. `BUILD_ID` differs (expected, new commits); not compared here, phase 7's job |
| 4 | token purity — round 808's own files | GREEN | GREEN | unchanged, structurally cannot see this project |
| 5 | no-raw-colours.cjs | GREEN | GREEN | unchanged **verdict**, but the internals moved — see §3 below (MemorySurface.tsx debt count fell 8→5) |
| 6 | forbidden-file diff | GREEN | GREEN | unchanged |
| 7 | forge-control/ untouched reporter | GREEN | GREEN | unchanged (structural, cannot fail) |
| **8** | **dollar-sweep.sh** | **GREEN** | **RED** | **NEW RED — BLOCKER, see below** |
| 9 | check-composer-v3.ts | GREEN | GREEN | unchanged |
| 10 | check-secret-requests.ts | GREEN | GREEN | unchanged |
| 11 | contrast-canvas-banners.cjs | GREEN | GREEN | unchanged |
| 12 | check-working-sql-agreement.ts | GREEN | GREEN | unchanged |
| 13 | check-stop-affordance.tsx | GREEN | GREEN | unchanged |
| 14 | check-dismiss-peek.tsx | GREEN | GREEN | unchanged |
| 15 | check-team-rows.ts | GREEN | GREEN | unchanged |
| 16 | check-team-confirm.ts | GREEN | GREEN | unchanged |
| 17 | verify-notification-gap-pins.mjs | GREEN | GREEN | unchanged. No phase-2 task touched `docs/plan/notification-gap.md` (not in any write_set, confirmed absent from the whole-diff file list in §4) |
| 18 | check-usage-fold.ts (live PG) | GREEN | GREEN | unchanged. `DATABASE_URL` was set in this shell, so it ran rather than skipped — consistent with WARNING 4, not a regression either way |
| 19 | check-usage-fold.ts (standalone tsc) | GREEN | GREEN | unchanged |
| 20 | pnpm test | GREEN | GREEN | unchanged, 1438/1438 (see §1) |
| 21 | psql-argv-leak.cjs | GREEN | GREEN | unchanged |
| 22 | nav-walk-sampling.cjs | GREEN | GREEN | unchanged |
| 23 | phase700/network-700.cjs | SKIPPED | SKIPPED | unchanged, dark in both — no verdict either baseline or now, per WARNING 5 |
| 24 | phase600/nav-walk.cjs | SKIPPED | SKIPPED | unchanged, same reason |
| 25 | reproduce-cleanliness | GREEN | GREEN | unchanged |

**One difference, and it is real.** Gate 8 (`dollar-sweep.sh`) flipped GREEN→RED. Isolating the cause:

```
$ bash scripts/checks/dollar-sweep.sh 2>&1 | grep -n "FAIL"
FAIL    forge-control-web/app/layout.tsx:49
                    TLS handshake spent on nothing. */}
        → no allowlist entry covers this hit
```

`app/layout.tsx:49` is inside a comment B2c added in commit `a810074` (self-hosting the fonts),
explaining why the two `fonts.googleapis.com` `<link>`s and their `preconnect` hints were removed
together: *"A preconnect to a host nothing requests is a DNS + TLS handshake spent on nothing."* The
word **"spent"** trips `dollar-sweep.sh`'s primary-gate regex (`\bspen[dt]`), which exists to catch
money-shaped values leaking into working surfaces (N1/R69/R70's territory) — it has no way to tell
"spent" meaning *wasted effort* from "spent" meaning *currency outlay*, and this hit is unambiguously
the former: a network-timing remark in a `<head>` comment, nowhere near a rendered value, nowhere near
money.

**This is a NEW RED versus the phase-1 baseline, introduced by this phase's own commit, and it is not
excused by the false-positive reading.** `01-requirements.md` R86 and `00-vision.md` S13 both set the
bar at "no NEW red versus the pre-project baseline," full stop — the baseline file itself is explicit
that phases 2–7 sit at a **zero-red bar** with nothing pre-existing to shelter under (WARNING 1). A
gate that is wrong to fire is still a gate that fired; the fix is one line (reword the comment to drop
"spent," e.g. *"...is a DNS + TLS handshake wasted for nothing"*, or a scoped allowlist entry naming
the exact sentence — never a widened pattern, per this gate's own standing rule). Cheap, mechanical,
one file — but it is red at HEAD right now and the rule this project is gated on has no exception for
"the regex was wrong."

**BLOCKER.**

---

## 3. The design-token gate, in detail

```
$ node scripts/checks/no-raw-colours.cjs
no-raw-colours: PASS — 221 literal(s) across 14 file(s), all accounted for (178 legitimate, 43 known debt, 0 unlisted).
EXIT=0
```

Baseline: `222 literal(s) … (176 legitimate, 46 known debt, 0 unlisted)`.

`MemorySurface.tsx`'s own allowlist entry, baseline → now:

| baseline (8 hits) | this run (5 hits) |
|---|---|
| `:207 #141417`, `:233 #141417` | *(gone — converted)* |
| `:813 #0e0c14` | *(gone — converted, this is the one the brief named)* |
| `:848 #0a1316` → | `:1273 #0a1316` (same literal, shifted by the file's growth) |
| `:849 #16323a` → | `:1274 #16323a` |
| `:918 #0e0c14` → | `:1742 #0e0c14` |
| `:919 #221d33` → | `:1743 #221d33` |
| `:960 #0a0a0c` → | `:1784 #0a0a0c` |

**Debt count fell 8 → 5, not increased.** B2d converted the two `#141417` selected-row backgrounds and
the Obsidian-control `#0e0c14` (the specific instance the brief named) to tokens, and left the
remaining five annotated exactly as before. This satisfies the brief's "must not increase" bar with
room to spare. The whole-app total fell 222 → 221 (debt −3, legitimate +2 — the +2 is new
`tokens.*`-based colour usage elsewhere in the diff, e.g. the conflict-panel styling, which
`no-raw-colours.cjs` counts as legitimate because it resolves through the token system, not a literal).

**R32:**
```
$ grep -n "fontFamily" forge-control-web/app/desktop/MemorySurface.tsx
1537:  fontFamily: "inherit",
1572:  fontFamily: "inherit",
1694:  fontFamily: "inherit",
```
All three are `inherit`. No one-off font stack. PASS.

---

## 4. Requirements table — R21–R36, personally re-run

Every "evidence" cell below is something I read or ran myself in this worktree, not a restatement of a
builder's claim. Screenshots were opened with the Read tool, not trusted by filename.

| ID | Verdict | Evidence I personally ran/read |
|---|---|---|
| **R21** | PASS | `before-note-view.png`, `before-counts-rail.png`, `before-graph-tab.png` all exist at their committed paths and are cited from `reproduce-before.md` / `phase1-verdict-observed.md`. Opened `after-counts-rail.png` myself (§5) — real UI, not a placeholder. |
| **R22** | PASS | `api-vault.ts:227-231` — `put()` sends `{path, content, base_sha256: base}` where `base` is `loaded.sha256`, and `loaded` is seeded exactly once from `fetchVaultFile()`'s response (`MemorySurface.tsx:200-210`, `staleTime: Infinity`, `retry:false` — a background refetch cannot swap the base under an open editor). Saves via `PUT /api/vault/file`, never `POST /append`. |
| **R23** | PASS | `MemorySurface.tsx:1467-1660` — both versions render stacked and labelled on 409 (`YOUR UNSAVED VERSION`, `THE VERSION NOW ON DISK`); nothing happens until an explicit click; "Keep mine" passes `saveState.conflict.current_sha256` (the fresh, server-supplied base) only on click, never automatically. Grepped `saveVaultFile` and `put(` for any code path that re-reads-then-re-PUTs without a click — none exists; `api-vault.ts:185-190`'s own doc comment states the "no retry, no auto-merge" contract and the implementation matches it. |
| **R24** | PASS | `MemorySurface.tsx:1417-1465` — on `saveState.kind === "error"` the editor's `dirty` state is untouched (nothing in the catch branch clears `draft`), the panel shows `HTTP <status>` and `saveState.message` (which is `VaultApiError`'s combined status+serverMessage string from `api-vault.ts:44-68`), and states explicitly "Nothing was written. Your unsaved text is still in the editor above." No toast, no auto-dismiss. |
| **R25** | PASS | `MemorySurface.tsx:1127-1151` — `href={note.obsidian_uri}`, sourced from the server (`fetchMemoryNoteV2`'s `MemoryNoteDetailV2.obsidian_uri`, built by `obsidianUri()` server-side per `api-vault.ts:421-427`'s doc comment, explicitly NOT rebuilt client-side). Verified visually in `after-counts-rail.png` — the control is a real link with real caveat text, not the `<div>` the requirement's fail-column names. |
| **R26** | PASS | Same screenshot: "Open in Obsidian only works on a machine running Obsidian with a vault named 'obsidian-vault' — this server does not run Obsidian, and the name comes from the vault directory on THIS host, so it may differ from the folder name on yours. If it does nothing, use Copy vault path instead." Rendered as visible body text directly under the control, not a title attribute or tooltip. |
| **R27** | PASS | Same screenshot: a "Copy vault path" button sits beside "Open in Obsidian." `copyPath()` (`MemorySurface.tsx:254-277`) writes to the clipboard with a documented non-secure-context fallback. |
| **R28** | PASS | Read `after-counts-rail.png` directly: every numeric string on the rail carries an adjacent unit — "288 vault notes indexed," "198 agent briefs (no file on disk)," "292 .md files on disk," "263 files embedded · 2,208 chunks embedded," "excluded: 15 excalidraw · 10 empty · 1 frontmatter-only," "1 stale embedding rows," folder counts as "N notes." No bare integer found anywhere in the visible surface. Source: `MemorySurface.tsx:373-411`, every render path uses `n(counts.<field>)` immediately followed by a literal unit string; the loading/error states render prose, never a number (`:349-372`). |
| **R29** | PASS | Both figures render simultaneously (`vault_notes_indexed` and `agent_notes` both shown, `:381-392`); the Vault/Agent toggle (`:419-444`) calls `setSource(s)`, and `countsQ`'s `queryFn` is `() => fetchMemoryCountsLabelled(source)` (`:124`) — confirmed the state variable is what drives the `?source=` query param, not cosmetic. |
| **R30** | PASS | `font-measurement.md` and `font-decision.md` both record `document.fonts.check` for Inter, JetBrains Mono, Material Symbols **and** the negative control `document.fonts.check('12px "NoSuchFontXYZ"')`, which returns `true` in every state including pre-fix-blocked — proving the instrument cannot discriminate, exactly as R30 asks it to demonstrate before any CSS changes. Measured before B2c's commit (font-measurement.md is B2a's, `23531f6`, which lands before `a810074`). |
| **R31** | PASS | `font-decision.md`'s width-probe table, read directly: PRE-FIX `b6eb201` — `w("Inter")` vs `w("serif")` = `552.91` vs `552.91` → **false** (fonts did not apply); POST-FIX `a810074` — `609.81` vs `552.91` → **true**. Same pattern for JetBrains Mono and Material Symbols (`.ms` glyphs: 8/8 rendering as literal words pre-fix at >1.4 em box/font-size, 0/8 post-fix, all exactly 1.00 em). `blockedExternal`/`failedRequests` go from 2 URLs to `[]` post-fix — the third-party dependency is gone, not just fronted with a fallback. This is the actual before-FAILS/after-PASSES proof the brief demanded, not the inert `document.fonts.check` reading (which the artefact itself calls out as "recorded to satisfy R30 and it is not the evidence for R31"). |
| **R32** | PASS | See §3. |
| **R33** | PASS | `memory-graph.test.ts:134-139` pins the literal `"knowledge_note.links"` (not read from the subject) for both a populated and an empty graph. Server route confirmed at `db/memory.ts` (`buildWikilinkGraph`). Live browser screenshot (§5, not committed — see finding below) shows `source: knowledge_note.links` rendered verbatim with `292 nodes drawn`, comfortably over the ≥100 bar. |
| **R34** | PASS | `memory-graph.test.ts:168-209` — a one-character-off dangling link is asserted `resolved:false, vault_path:null`, present as its own node (not folded into the real note, not dropped), and an edge is asserted to point at it; flipped by adding the missing note and re-asserting `unresolved_targets` falls to 0 with the same link count. Self-links: asserted dropped from `links[]` but counted in `self_links_dropped` (`:225-254`), flipped against a row with none. Client renders unresolved nodes in a distinct visual class per `graph-report.md`'s described intent — not independently re-verified in the client bundle beyond the screenshot in §5, which does show a visibly distinct amber cluster. |
| **R35** | PARTIAL — see finding below | Server-side: strongly proven. `memory-graph.test.ts:315-374` covers empty-with-rows (`empty_reason` names `hcp.knowledge_note.links`, the row count `3`, and `syncVaultNotes()`), empty-by-self-link-only, the non-empty direction (`empty_reason === null`, guarding against a builder that always returns the sentence), and true zero-rows. Every case is flipped both directions — not inert. **Not exercised live in the browser** — `editor-browser-proof.md §8` discloses this explicitly ("Not exercised in this run… Named as unproven rather than claimed") rather than claiming it. Honest disclosure of a real gap, not a violation, but the requirement's own test ("force an empty result… assert the rendered text") was not run against the client. |
| **R36** | FAIL — see finding below | A real post-fix screenshot exists and shows nodes (`/opt/ai-os/uploads/25175c0e7d69/20260819T020619Z-after-graph-3d.png` — I opened it directly: 292 illuminated nodes, visible clusters, an amber unresolved-node cluster, the counts overlay reading "292 nodes drawn · 624 edges drawn"). **It was never copied to `docs/plan/artifacts/os-usable-for-work/phase2/` nor committed.** `git ls-files | grep -i graph-after` returns nothing; `graph-after.png`, `graph-empty-state.png` and `graph-report.md` — all three declared in task `c6b7e49e`'s write_set — do not exist anywhere in the repository. R36's literal test is "the PNG exists" (at a committed path); it does not. |

**N7** (screenshots copied to the phase artefact directory for permanence) is violated by the same
gap: the graph screenshot was taken and Read back into the run transcript (satisfying the inline-render
half) but never reached the committed, permanent half.

---

## 5. Cross-cutting N1–N10

| ID | Verdict | Evidence |
|---|---|---|
| **N1** | PASS | `git diff <merge-base>...HEAD -- forge-control/src/db/memory.ts forge-control/src/routes/memory.ts forge-control-web/app/api-vault.ts forge-control-web/app/desktop/MemorySurface.tsx forge-control-web/app/desktop/MemoryGraph3D.tsx \| grep -nE '(catch\s*\{\|\?\?\s*0\|\?\?\s*\[\]\|\|\|\s*\[\])'` — every real hit is justified: the two `catch {}` blocks in `api-vault.ts` (`serverMessageFrom`, the 409-body parse) degrade a diagnostic's format after the request has ALREADY failed, never substitute a success value; `(row.links ?? [])` in `db/memory.ts` handles a genuinely nullable DB column (the test corpus itself constructs rows with `links: null` as valid data), not a failed query. No `?? 0` survives on any count. |
| **N2** | PASS | `memory-graph.test.ts` exists at `forge-control/src/lib/`, inside the `src/lib/*.test.ts` glob `package.json:12` actually runs; confirmed 17 tests execute under `pnpm test`'s 1438-test total. Not inert: no constant is imported from `db/memory.ts` into an assertion (literals like `"knowledge_note.links"`, the maxLinks cap of `2`, are pinned in the test, not read from the subject) — spot-checked by reading the file in full; every boundary case I looked for (empty vs non-empty `empty_reason`, resolved vs dangling, self-link present vs absent) is asserted in BOTH directions. |
| **N3** | PASS (carried from phase 1) | `phase1/browser-harness.md` and `.mjs` used throughout `editor-browser-proof.md`; no new login harness invented. |
| **N4** | PASS | `git -C /opt/forge-ai-os status --porcelain` → empty (see §6). Grepped the full phase-2 diff for `/opt/forge-ai-os` — every hit is prose in artefact documents discussing the N4 check itself or phase-1 fix-cycle reports, none is a write. |
| **N5** | PASS | The write-path proof ran against a throwaway forge-control on `:7795` bound to `/tmp/b2d/obsidian-vault` (a full copy, not the sparse fixture — see §6), rebuilt with `FORGE_CONTROL_URL=http://127.0.0.1:7795` before `next start`, verified via `grep -o 'http://127.0.0.1:7795' .next/routes-manifest.json`. |
| **N6** | PASS | Still 6 workstreams; no task in this review requested a 7th. |
| **N7** | FAIL for the graph screenshot (see R36); PASS for the other four `after-*.png` and all `before-*.png` | See R36. |
| **N8** | Applied | The two soft findings below (R35's unexercised browser case, the write-set bookkeeping gap) are folded into this verdict's numbered list rather than seeded as their own fix cycle — each is a few sentences and a file copy, not new work. |
| **N9** | Applied | This is that gate. |
| **N10** | PASS | Every number I cite above was reproduced by a command or a direct read I ran myself in this session, not copied from a builder's artefact — the `gates-808.sh` run, the `tsc`/`pnpm test` runs, the direct reads of `MemorySurface.tsx`, `api-vault.ts`, `memory-graph.test.ts`, and the two screenshots opened with the Read tool. |

---

## 6. The live-fire hazard, checked independently of B2d's own claim

`editor-browser-proof.md §1` describes rebuilding `forge-control-web` with `FORGE_CONTROL_URL=http://127.0.0.1:7795` (a throwaway forge-control) before `next start`, and verifying the bake with
`grep -o 'http://127.0.0.1:7795' .next/routes-manifest.json`. That is the correct sequence per
`next-proxy-rewrite-baked-at-build` (setting the env var only at `next start` does nothing).

I did not re-run the build myself (expensive, and the artefact's own verification command is sound and
specific — not a bare claim), but I independently checked its **consequence**: the sandbox vault was a
full copy of the real 288-file vault (`/tmp/b2d/obsidian-vault`, per `§1.1`, because a fixture-only vault
lists live `hcp.knowledge_note` rows the fixture can't open — the documented reason matches
`fixture-vault-alone-breaks-ui-proof`'s known trap). That copy includes real note titles, e.g.
`AI OS/Session State - 2026-08-19.md`, which appears, edited with test markers ("B2D-PROOF-EDIT
20260819T020406Z", "AGENT-WROTE-THIS-WHILE-HE-WAS-TYPING 20260819T020406Z"), in the committed
`after-counts-rail.png`.

I checked the REAL file:
```
$ grep -c "B2D-PROOF-EDIT\|AGENT-WROTE-THIS-WHILE-HE-WAS-TYPING" "/opt/obsidian-vault/AI OS/Session State - 2026-08-19.md"
0
$ date -u -r "/opt/obsidian-vault/AI OS/Session State - 2026-08-19.md"
Tue Aug 18 11:48:14 PM UTC 2026
```
Zero occurrences of either marker, and the file's mtime (2026-08-18T23:48Z) predates the entire proof
run window (2026-08-19T02:00Z–02:10Z, per the artefact's own header). **The live vault was not
touched.** This corroborates the throwaway-rebuild claim rather than just trusting it.

`git -C /opt/forge-ai-os status --porcelain` → **empty**. Clean. No live-checkout incident.

---

## 7. Write-set audit

Per-task declared write_sets (from `GET /api/tasks/<id>`, the row's `write_set` field, never
reconstructed from a brief) versus commits:

- **B2a** (`5667b6d3`) declared 7 artefact paths. Commit `23531f6` touches 8 files: the 7 declared,
  plus `before-fonts-blocked-note-view.png`, which is NOT in the declared write_set. **Undeclared
  write** — minor: it is an artefact PNG squarely inside B2a's own subject matter (the font
  measurement), committed under the same task, and it is cited by name from `font-measurement.md`
  (B2a's own declared artefact). Reads as an omission in the write_set restatement, not a scope
  violation.
- **B2b** (`21307c65`) declared 3 files; commit `6379c07` touches exactly those 3. Clean.
- **bd47e519** ("B2c + B2e") declared 9 paths (`api-vault.ts`, `layout.tsx`, `globals.css`, 3 font
  files, `LICENSE.md`, `font-decision.md`, `MemoryGraph3D.tsx`). Commits attributable to its run
  (`run_id 25175c0e-7d69-49dd-9dc8-802bc35cd867`) are `b6eb201`, `a810074`, `9c395ec` — matching the
  declared set — **and also `5fc2367`**, which touches `forge-control-web/app/desktop/MemorySurface.tsx`,
  **not in `bd47e519`'s declared write_set**. That exact file IS declared, verbatim, on a separate task
  row (`58cc6033`, "B2d," titled `[FOLDED into the sibling task]`, `run_id: null`), whose own write_set
  matches the commit precisely. **Undeclared write on the row that actually executed it.** The
  underlying content is not a scope violation — MemorySurface.tsx is squarely B2d's intended subject and
  I reviewed it in full above — but the fold mechanism left `bd47e519`'s write_set stale relative to
  what its run actually produced, and `bd47e519.report` reads back as `None` (no restated write_set to
  cross-check against, unlike the brief's mandatory-audit assumption that a report exists to restate
  it against).
- **c6b7e49e** ("B2e," also folded) declared `MemoryGraph3D.tsx` plus 3 artefacts
  (`graph-after.png`, `graph-empty-state.png`, `graph-report.md`). The component file was written (as
  part of `bd47e519`'s commits); **the three artefacts were never written at all** — see R36/N7 above.

**Both are FINDINGS, not footnotes, per the mandatory audit.** Neither is a blocker on its own — the
first is a same-task artefact omission, the second overlaps with the already-blocking R36 gap — but the
next planner should know the fold mechanism (retiring a sub-task's row into a sibling's execution
without updating the sibling's declared write_set) is how this happened, so it does not recur silently
in later phases.

---

## 8. Verdict

**One genuine, new, zero-tolerance gate red** (dollar-sweep.sh, `layout.tsx:49`, caused by this
phase's own font-hosting commit) directly fails S13/R86's "no NEW red versus the pre-project baseline"
bar, which the baseline file itself states is a zero-red bar for every phase from here on. That alone
is enough.

Independently, **R36's literal test — a committed PNG showing the post-fix graph — is unmet**: the
underlying capability works (I viewed the actual screenshot; it shows a real, populated, correctly
composed 3D graph, not a placeholder or a black rectangle), but nothing was copied to
`docs/plan/artifacts/os-usable-for-work/phase2/` or committed. A working feature with no delivered
proof fails the requirement as written, and this project's standing rule is that a fix nobody
photographed does not ship (R21's own principle, applied here to the AFTER state instead of the
BEFORE).

Everything else reviewed — the write path's conflict handling (R22–R24), the Obsidian control
(R25–R27), the labelled counts (R28–R29), the font fix proven with a real discriminating instrument in
both directions (R30–R31), the design-token debt count (falling, not rising), the wikilink graph's
server-side correctness under a genuinely adversarial unit test (R33–R35's unit-level proof), N1's hard
errors, N2's real test coverage, N4's untouched live checkout, and the live-fire hazard (independently
corroborated, not just trusted) — is solid, careful work and does not need to be redone.

Both blockers are small and mechanical: reword one comment (or add one scoped allowlist entry) in
`layout.tsx`, and commit the two already-taken graph screenshots (or retake the after-shot and force
the empty case once, cheaply, against the still-live throwaway server) to their declared paths under
`docs/plan/artifacts/os-usable-for-work/phase2/`. Neither requires new engineering. The next builder
task should also true up `bd47e519`'s write_set restatement issue named in §7, and, while in
`editor-browser-proof.md`'s throwaway server, exercise R35's empty case live (point it at a
`knowledge_note` row with no links) rather than leave it "not exercised" going into integration.

### Blockers for the next planner, numbered

1. **`forge-control-web/app/layout.tsx:49`** — the comment "…is a DNS + TLS handshake spent on
   nothing." trips `scripts/checks/dollar-sweep.sh`'s `\bspen[dt]` primary gate (NEW red vs
   `phase1/gates-baseline.txt`, gate 8, S13/R86 blocker). Fix: reword to remove "spent" (e.g. "...is a
   DNS + TLS handshake wasted for nothing."), then re-run `bash scripts/checks/gates-808.sh --strict`
   and confirm gate 8 returns to GREEN with `RED: 0`.
2. **R36 / N7 unmet** — `docs/plan/artifacts/os-usable-for-work/phase2/graph-after.png` does not exist
   in the repository. A real post-fix screenshot already exists at
   `/opt/ai-os/uploads/25175c0e7d69/20260819T020619Z-after-graph-3d.png` and shows a correct, populated
   graph (292 nodes, 624 edges, an amber unresolved cluster, the `source: knowledge_note.links` label
   visible) — copy it to the committed path (or retake it against the same or a fresh throwaway server)
   and commit it under the `vault` workstream. `graph-empty-state.png` and `graph-report.md` (declared
   in task `c6b7e49e`'s write_set) were never produced at all — either produce them by forcing the empty
   case against the throwaway server (closes R35's live-exercise gap in the same pass) or explicitly
   retire that part of the write_set with a stated reason.

### Not blockers, folded per N8 — for whoever picks up the two items above

3. Task `bd47e519`'s declared `write_set` omits `forge-control-web/app/desktop/MemorySurface.tsx`,
   which its own run committed (`5fc2367`). Update the row's write_set to match what was actually
   written, or note in the task's report why the file is instead attributed to the folded `58cc6033`
   row. No code change needed.
4. Task `5667b6d3`'s (B2a) declared `write_set` omits
   `docs/plan/artifacts/os-usable-for-work/phase2/before-fonts-blocked-note-view.png`, which its commit
   (`23531f6`) produced. Same fix as #3.

---

## VERDICT: NEEDS_FIXES

1. `forge-control-web/app/layout.tsx:49` — reword the comment (drop "spent") to clear the NEW
   `dollar-sweep.sh` red (gate 8) against the phase-1 baseline; re-run `gates-808.sh --strict` and
   confirm `RED: 0`.
2. Commit `docs/plan/artifacts/os-usable-for-work/phase2/graph-after.png` (already captured at
   `/opt/ai-os/uploads/25175c0e7d69/20260819T020619Z-after-graph-3d.png`, verified to show a real
   populated graph) and either produce `graph-empty-state.png` + `graph-report.md` by forcing the empty
   case live, or explicitly retire that part of task `c6b7e49e`'s write_set with a stated reason —
   closing R36 and R35's live-exercise gap.

Everything else reviewed in this phase (R21–R35 except the live-exercise half of R35, R28–R34, N1–N6,
N9–N10, the write path, the Obsidian control, the font fix, the live-fire hazard) is sound and does not
need rework.
