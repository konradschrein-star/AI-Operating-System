# Phase 2 plan — memory surface truth

**Planner round 200 · workstream `vault` · requirements R21–R36 + N1–N10**
**Corpus:** `docs/plan/os-usable-for-work/{00-vision,01-requirements,02-architecture,03-quality,04-phases}.md` @ `31ce944`
**Planned:** 2026-08-18 · worktree `project/7851068b-vault` @ `1b6fa9a`

---

## 0. Phase 1's gating verdict — checked before planning, as required

`R1-gate` (`10c93694`) is **still `pending`**. It has not issued a verdict, so there is no `PASS` to
build on. What *has* landed is the adversarial red team `R1-red` (`15fd8298`, commit `1b6fa9a`), and
it found **3 BLOCKERS**, all unrecoverable content loss:

| # | Attack | Site |
|---|---|---|
| B-1 | Two concurrent `PUT`s lose an acknowledged edit, no snapshot | `lib/vault.ts:380-413` |
| B-2 | `appendToDailyNote` read failure ≠ ENOENT replaces the note with the empty template | `lib/vault.ts` |
| B-3 | Crash during `appendToDailyNote`'s write truncates the note | `lib/vault.ts` |

**Those blockers sit at HEAD.** Two phase-1 rows are open to clear them: `Fix cycle 1 · vault`
(`b10af6c2`) and its `Re-review after fix cycle 1` (`31836b84`).

> **Correction made while seeding (2026-08-18, 23:09).** The phase-1 planner's `B1e` (`6c6fb2c8`,
> "fix all three red-team blockers + the symlink escape") was **retired as a duplicate** of
> `fix:vault:3:1` and now sits at status `blocked`. A `blocked` row never reaches `done`, so naming it
> in a `depends_on` would wedge every phase-2 task permanently. It is **not** a dependency here. The
> surviving owner of the three blockers is `b10af6c2`, reached through `31836b84`.

**Consequence for this plan, and it is structural:** every phase-2 task depends on both
`R1-gate` and the fix-cycle re-review. Phase 2 builds the UI that *drives* the write path.
Wiring an editor to a `PUT` that can lose an acknowledged save under concurrency would ship the
blocker with a friendly face on it. `B2a` re-reads the verdict as its first act and records what it
found.

---

## 1. What this phase does not do

Two of the brief's premises died under measurement (`00-vision.md §2`) and no task here revisits them:

- **There is no 67-file vault indexing gap.** `syncVaultNotes()` covers 284/284. The 26-file
  shortfall is in `content_forge.knowledge_embeddings`, a different table in a different database
  written by `/opt/knowledge-mcp/km-indexer.js` outside this repo, and it decomposes with no residue
  into 15 deliberately-excluded `.excalidraw.md`, 10 zero-byte files and 1 frontmatter-only note.
  **Real content gap: zero.**
- **The 3D graph is a data problem, not a rendering one.** `3d-force-graph@^1.77.0` and
  `three@^0.185.0` are installed, and `MemoryGraph3D.tsx:167`'s empty state is telling the truth.
  `knowledge_triples` holds 0 rows and **nothing refills it** — the extractor
  (`extractTriplesNextBatch`, `db/memory.ts:888`) is manual-only and scheduling it is an explicit
  non-goal (`00-vision.md §5.2`). The fix is to **repoint the endpoint** at `hcp.knowledge_note.links`,
  which already holds parsed wikilinks for 118 of 284 notes, refreshed every 5 minutes at zero
  marginal cost.

---

## 2. Findings from the scout pass that change the plan

### 2.1 R31's prescribed proving test is INERT — measured, not suspected

`B1d` already measured the font instruments in this exact app (`phase1/browser-harness.md §5`,
Failure 5), blocked vs allowed, same page, same run:

| instrument | fonts loaded | fonts blocked | discriminates? |
|---|---|---|---|
| `document.fonts.check("1em Inter")` | `true` | `true` | **NO** |
| `document.fonts.check("1em NoSuchFontXYZ")` | `true` | `true` | **NO — true for a family that does not exist** |
| `getComputedStyle(body).fontFamily` | echoes the CSS | echoes the CSS | **NO** |
| width probe `w("Inter") !== w("serif")` @64px | `609.81` vs `552.91` → true | `552.91` vs `552.91` → false | **YES** |

R30 mandates recording `document.fonts.check` and R31 makes it the proving test. **It cannot prove
anything.** This plan therefore:

- records `document.fonts.check` for both families verbatim, satisfying R30 as written; **and**
- makes the **width probe with third-party origins blocked** the actual discriminator for R31, run
  before the fix (must FAIL) and after (must PASS).

A requirement whose assertion passes at every value is a wish. Substituting the discriminating
instrument and saying so in writing is the honest reading of R31, not a deviation from it.

### 2.2 There are THREE webfonts, and the third is the likely complaint

`app/layout.tsx:39-50` links Inter, JetBrains Mono **and Material Symbols Outlined**, all three from
`fonts.googleapis.com`. `app/globals.css:13,23,29` names all three with **no local `@font-face`
anywhere** — `forge-control-web/public/` does not exist at all.

When Material Symbols fails to load, its ligature icons render as **their literal names**:
`description`, `open_in_new`, `settings`, `search`. That is visible in `phase1/harness-proof.png`. It
is also a far better match for "weird font" than a serif fallback would be. R31 names Inter and
JetBrains Mono; this plan self-hosts **all three**, because leaving the icon font on a third-party CDN
would fix two thirds of a defect and leave the loudest third in place.

And the mechanism is not hypothetical on this host: `fonts.googleapis.com` has A and AAAA records,
**this box has no working IPv6 egress**, and 2 of the first 3 harness navigations stalled to a 45 s
timeout on the render-blocking stylesheet (`phase1/browser-harness.md §5`, Failure 4).

### 2.3 The counts rail renders `0` at HEAD, right now

`MemorySurface.tsx:107` — `const counts = countsQ.data ?? { all: allNotes.length }` (an N1 silent
fallback) — and `:176` renders `` `${counts.all ?? 0} notes` ``. `B1c` correctly **removed** the bare
`all` key from `noteCounts()` (`db/memory.ts:549`, R15). So the rail now reads **"0 notes"**, and
`:261`'s `counts[c.key] ?? 0` zeroes all seven category chips. Konrad's *"it's zero and not eight"* is
reproducible in the source today. `B2d` owns it; until `B2d` lands it is a live regression at HEAD.

### 2.4 The web app's proxy target is baked at build time — a live-fire hazard

`next.config.mjs` rewrites `/api/proxy/*` to `$FORGE_CONTROL_URL` **at `pnpm build` time**, defaulting
to the live `:7700`. A throwaway `next start` therefore reads *and would write* the **live** vault.
Any browser test that clicks **Save** must rebuild against a throwaway forge-control bound to a
**fixture vault** (`lib/vault-fixture.ts`, from `B1a`). This is briefed into `B2d` as a hard rule.

### 2.5 `pnpm test` only globs `src/lib/*.test.ts`

`forge-control/package.json:12` — `tsx --test src/lib/*.test.ts`. A new test placed anywhere else is
never run by the gate. The graph test goes to `forge-control/src/lib/memory-graph.test.ts`.

---

## 3. The task graph

```
R1-gate  (10c93694) ┐
re-review(31836b84) ┴─→ B2a  reproduce + font measurement      artefacts only, no source
                             │
                             ├─→ B2b  server: wikilink graph + obsidian fields   (db/memory.ts, routes/memory.ts, +test)
                                        │
                                        └─→ B2c  client bindings + self-hosted fonts  (api-vault.ts, layout.tsx, globals.css, public/fonts)
                                                  ├─→ B2d  MemorySurface.tsx  (editor, 409 UI, Obsidian control, counts)
                                                  └─→ B2e  MemoryGraph3D.tsx  (source, empty_reason, unresolved, screenshot)
                                                              └─→ R2-gate  ← joins all five
```

Five builders, **five disjoint `write_set`s, no file declared twice**, one join.

**Why the chain is linear rather than fanned.** One workstream is one worktree that runs its tasks one
at a time, so a fan-out here would buy no wall-clock and would cost import correctness: `B2c` cannot
type a client against a server shape that does not exist, and `B2d`/`B2e` cannot import from an
`api-vault.ts` that has not been written. The one place fan-out is real — `B2d` and `B2e` both hang off
`B2c` and touch different components — is fanned.

**Deviation from `04-phases.md`'s sketch, and the reason.** The sketch pairs `MemoryGraph3D.tsx` with
the `db/memory.ts` graph source in one task. This plan splits them: the component **imports** the
client binding, so it must land after `api-vault.ts`, while the server function must land before it.
Same files, same owner count, corrected order.

---

## 4. The contracts, fixed here so both sides build to the same shape

### 4.1 `GET /api/memory/graph` (B2b)

```jsonc
{
  "source": "knowledge_note.links",          // R33 asserts this literal string
  "nodes": [{ "id": "…", "label": "…", "degree": 3,
              "resolved": true, "vault_path": "AI OS/Foo.md" | null,
              "notes": ["slug", …] }],
  "links": [{ "source": "…", "target": "…", "kind": "wikilink" }],
  "counts": { "notes_scanned": 284, "notes_with_links": 118,
              "links_total": 0, "unresolved_targets": 0, "self_links_dropped": 0 },
  "empty_reason": null,                       // non-null ONLY when nodes is empty
  "measured_at": "2026-08-18T…Z"
}
```

- `empty_reason` names **the table read and the row count found**, e.g.
  `"read hcp.knowledge_note.links: 284 rows scanned, 0 carried a wikilink. Refilled by
  syncVaultNotes() (db/memory.ts:225) on the 5-minute vault-sync tick."` (R35).
- Unresolved wikilink targets become **nodes with `resolved:false`**, never dropped (R34). A dangling
  link is a note Konrad meant to write.
- `triples` is gone. `knowledgeGraph()` is replaced by `wikilinkGraph()`; `routes/memory.ts:47` is its
  only caller and `MemoryGraph3D.tsx` the only consumer — both are inside this phase.

### 4.2 `GET /api/memory/:slug` gains two fields (B2b)

`vault_name: string` (from `vaultName()`, `lib/vault.ts:438`) and `obsidian_uri: string | null` (from
`obsidianUri()`, `lib/vault.ts:451`). **`null` for agent notes** — their `vault_path` is "a
self-declared label, not a path that exists on disk" (`db/memory.ts:69`), so a deep link to one would
be a link that silently fails, which R26 exists to forbid.

### 4.3 `forge-control-web/app/api-vault.ts` (B2c)

New file. **`app/api.ts` is not touched by any task in this phase** — every lane would conflict on it
(`02-architecture.md §0.3`). Its own error helper, because `api.ts:29`'s `getJson` throws
`${status} ${statusText}` and **discards the server's message**, which R24 requires.

---

## 5. Acceptance (the gate's checklist)

- S1, S5, S7 (`00-vision.md §4`) pass.
- R21–R36 each demonstrated by a committed artefact, not a claim.
- Every browser run carries the `/signin` assertion and exits 0.
- No hardcoded `font-family` in `MemorySurface.tsx` (R32); no **new** colour literal anywhere.
- A save that would clobber an agent's write is **refused and shown**, never merged, never retried.
- The universal block runs with `--prod=false`, and **no NEW red** versus `phase1/gates-baseline.txt`.
  Gate 17 is a known pre-existing red.

---

## 6. Riskiest step, and its rollback

**`B2c` — self-hosting the fonts.** It edits `app/globals.css` and `app/layout.tsx`, which every
surface in the product renders through. A wrong `@font-face` `src`, a missing `unicode-range`, or a
dropped Material Symbols `font-variation-settings` does not break one surface — it breaks **all of
them**, and the breakage looks exactly like the defect being fixed.

**Rollback:** `git revert` the single `B2c` font commit — the brief requires the font change to be one
commit, separate from `api-vault.ts`, precisely so this line works:

```bash
git -C /opt/ai-os/workspace/projects/7851068b-32d7-469b-b42f-f5e3c1d9e83a--vault revert --no-edit <B2c-font-commit>
```

Reverting restores the `fonts.googleapis.com` `<link>`s and the CDN-dependent behaviour — the
pre-phase state, which is degraded but shipped and known.
