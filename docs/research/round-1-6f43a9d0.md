# Round 1 — vault classification, Konrad/ vs Forge/ split manifest

Task: PLAN.md §3.5. Read-only classification pass over `/opt/obsidian-vault`
(69 loose root `.md` files, 15 top-level folders, 17 Excalidraw files). No
moves, renames or edits — confirmed nothing was written under `/opt/obsidian-vault`
in this session.

**Full manifest, per-folder/per-file evidence, code-reference audit, wikilink-break
analysis, machine-readable JSON, and the ask-list: `docs/plan/vault-split-manifest.md`.**
This file is a pointer + the headline findings; read the manifest for the actual
table and evidence.

## Headline findings

1. **The four "designed, never used" folders are confirmed empty**:
   `10_Idea_Reactor/`, `40_Life Knowledge/`, `99_System/`, `Use_Input_Archive/` —
   0 files each. No-ops for the mover.
2. **All 69 loose root `.md` files are Konrad's**, mtime-clustered 2026-01-29 →
   2026-02-11 (before this AI-OS project existed — first `AI OS/` file is
   2026-07-09), simple frontmatter, personal shorthand prose, one with a literal
   Windows path (`Books.md`). Sure confidence, uniform rule: → `Konrad/<name>`.
3. **`90_AI_OS/` (56 files) is NOT cleanly "his" despite topic being his
   business** — every sampled file is agent(Hermes)-authored (frontmatter
   `type: synthesis`, or explicit "Written:... Synced to:
   /opt/hermes-control/..." / "For: Claude ... to produce a UI design from").
   This deviates from a literal reading of the brief's "Known" line. Classified
   `Forge/` by the content-authorship rule, but flagged as an **ask** — it's
   business-critical reference content he reads, even though an AI wrote the
   prose. See manifest §6 for the three options put to him.
4. **`Excalidraw/` really is mixed, at the level the brief expected**: default
   `Drawing <timestamp>.excalidraw.md` autonames (blob-only, no readable text)
   are hand-drawn by Konrad; two files with "smoke" in the name are throwaway
   test fixtures from verifying the canvas→plan-graph feature and go to
   `Forge/`; the rest (`Stealth Uploader - *`, `Directory Engine - *`, `AI OS -
   Life & Company OS - Planning Canvas`) have real, substantive readable text
   content and read as Konrad's own planning, not test data.
5. **A concrete code break to flag for whoever writes the mover**:
   `forge-control/src/routes/map.ts:73-74` hardcodes
   `"90_AI_OS/Konrad Projects Overview.md"` and
   `"90_AI_OS/Infrastructure - Master Map.md"` as literal relative paths joined
   against `VAULT_DIR`. If `90_AI_OS/` moves under either root, this route
   breaks (loudly — it already treats a missing file as a hard error, not
   silently — but it WILL break at `--apply` time) until these two constants
   are repointed. Canvas discovery in the same file is a full recursive walk
   (`**/*.excalidraw.md`), not path-hardcoded, so the Excalidraw split needs no
   code change.
6. **A second, currently-unaudited vault writer may exist**: the Hermes
   (laptop-side) Obsidian skill uses `OBSIDIAN_VAULT_PATH` — a different env var
   name than forge-control's `OBSIDIAN_VAULT_DIR` — with its own fallback
   default. Not confirmed whether it points at this same vault. If it does, the
   planned `actor: "agent"|"konrad"` guard in `lib/vault.ts` (PLAN.md §3.5) only
   governs forge-control's own writes and does nothing for Hermes — flagged as
   an open question, not a measured fact, since checking Hermes's own env file
   was out of reach from this worktree.
7. **Zero wikilinks are newly broken by the split**, as long as folder names
   are preserved one level deeper. Verified two ways: no duplicate basename
   crosses the Konrad/Forge boundary (all dupes land on the same side already),
   and Obsidian resolves path-qualified `[[folder/note]]` links by suffix match
   against the full path — so `[[20_Coding/00_Stack_Rules]]` still resolves once
   the real path is `Konrad/20_Coding/00_Stack_Rules.md`. The two path-qualified
   links that do look broken (`[[10_Idea_Reactor/00_Idea_Board]]`,
   `[[30_YouTube/00_Knowledge_Base]]`) are **already dangling today** — pre-existing,
   not caused by or fixed by this split.
8. **Internal mixing exists even inside folders classified whole**:
   `30_YouTube/TheSkyLab/HANDOFF.md` opens "For: a fresh Claude/VPS Cat session"
   — an agent-authored session-handoff doc sitting inside a folder the brief
   calls "his." Left as `Konrad/` for this folder-granularity pass per the
   brief's instruction, but flagged (manifest §6, item 3) so a later per-file
   pass doesn't lose it.

## What a planner can act on directly

- The JSON block in `docs/plan/vault-split-manifest.md` §7 is ready to feed
  `scripts/vault-split-move.ts` once that script and the `VAULT_LAYOUT`
  mechanism exist (neither exists yet — this round did not build them).
- Before `--apply` ever runs: update `map.ts:73-74`'s two constants, and get an
  answer on `90_AI_OS/` and the Hermes env-var question (manifest §6).
- No vault content needs touching to unblock the mechanism work (`lib/vault.ts`
  guard, `vault-layout.ts`) — that can proceed in parallel with Konrad's answer,
  since `VAULT_LAYOUT` defaults to `legacy` (inert) per PLAN.md §3.5.
