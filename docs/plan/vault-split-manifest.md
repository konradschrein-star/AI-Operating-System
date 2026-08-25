# Vault split manifest — Konrad/ vs Forge/ (round 1, classify only, NO moves)

Read-only pass over `/opt/obsidian-vault` (69 loose root `.md` files + top-level
folders). Nothing in the vault was moved, renamed or edited. This document is the
input the mover script (`scripts/vault-split-move.ts`, PLAN.md §3.5) will consume
once Konrad gives the go-ahead.

Rule applied: **files Konrad wrote by hand → `Konrad/`; agent-generated →
`Forge/`.** Evidence used, in priority order: (1) explicit self-description in the
file ("For: a fresh Claude/VPS Cat session", "Synced to: /opt/hermes-control/...",
frontmatter `type: synthesis`), (2) mtime clustering, (3) prose register (Konrad's
own notes are terse, second-person, YouTube/business shorthand; agent notes are
structured, dated, cite files/line numbers), (4) known conventions confirmed live
in code (`VAULT_DAILY_DIR`/`VAULT_INBOX_DIR` defaults in
`forge-control/src/lib/vault.ts:97-99`).

## 1. Top-level folders

| Folder | Destination | Evidence | Confidence |
|---|---|---|---|
| `20_Coding/` (50 files) | `Konrad/` | His active coding projects (Tutorial Production Software, Stealth Uploader). Brief names it explicitly. **Caveat:** contains agent-authored sub-files (ADRs read as AI-assisted decision docs, e.g. `20_Coding/01_Tutorial Production Software/05_DECISIONS_ADR/ADR-0001-doc_system.md` — content is fine either way, structure/register is AI). Not re-classifying at folder level per brief instruction, but the mover should not assume every file inside is hand-typed. | sure (folder), caveat noted |
| `30_YouTube/` (83 files) | `Konrad/` | His YouTube business (TheSkyLab channel, niches, scripts). Brief names it explicitly. **Caveat, concrete:** `30_YouTube/TheSkyLab/HANDOFF.md` opens "**For: a fresh Claude/VPS Cat session. Read this first.**" — that file is agent-written operational handoff living inside a folder classified `Konrad/`. Same likely true of `TheSkyLab Production Log.md`. Folder-level verdict stands per brief, but a later per-file pass should pull session-handoff docs out. | sure (folder), caveat noted |
| `10_Idea_Reactor/` | — (empty) | 0 files. Designed, never used. | sure |
| `40_Life Knowledge/` | — (empty) | 0 files. Designed, never used. | sure |
| `99_System/` | — (empty) | 0 files. Designed, never used. | sure |
| `Use_Input_Archive/` | — (empty) | 0 files. | sure |
| `_Templates/` (2 files) | `Konrad/` | `Idea template.md`, `Knowledge Synthesis Template.md` — both are blank Obsidian templates with `{{title}}`/`{{date}}` placeholders, `Created: 2026-01-29` matching his root-note cluster. Brief names it explicitly. | sure |
| `_Attachements/` (19 files) | `Konrad/` | Binary attachments (PDFs, screenshots, videos) referenced by his notes (`![[MCP Connections 3.png]]` etc). Not agent output — a shared media pool. Keep with `Konrad/` since consuming notes stay there; nothing here is agent-generated. | likely |
| `How to price info/` (1 file) | `Konrad/` | Single note `service products.md`, same register/date-era as the root business notes. Not called out in the brief; classified by content. | likely |
| `Daily/` (16 files) | `Forge/` | Brief names it explicitly. Confirmed live: `forge-control/src/lib/vault.ts:97-99` — `DAILY_DIR = process.env.VAULT_DAILY_DIR ?? "Daily"`, written by `appendToDailyNote()`. Content is mentor/build-log entries ("Overnight AI OS build — kicked off 00:30, fleet running"), not Konrad's own daily journaling. | sure |
| `Mentor/` (8 files) | `Forge/` | Brief names it explicitly. `PERSONA.md` + `Profile/*` (mtime 2026-07-03, uniform batch) are the mentor system's own memory of Konrad; `log.md` is an append-only "Coach log" the mentor writes each session. All agent-authored, even though the *subject* is Konrad. | sure |
| `Inbox/` (2 files) | `Forge/` | Brief names it explicitly. Confirmed live: `VAULT_INBOX_DIR ?? "Inbox"` in `vault.ts`. One file (`AI OS Operator Log.md`) is literally a self-described misfile: "Misfiled by me (VPS Cat) on 2026-08-05: `POST /api/vault/note` flattens a title's `/`..." — a bug artefact, not content. | sure |
| `AI OS/` (24 files, incl. `Specs/`, `Canvas/`, `Integrations/`, `Reference/`) | `Forge/` | Brief names it explicitly. This is the current fleet's own operating documentation: `Operator Log.md`, `Session State - *.md`, `Policy - Agent Autonomy and Escalation.md`, `Spec - Task Graph and Workstream Worktrees.md`, `Org Model - Agent Company.md`. mtimes cluster 2026-07-09 → 2026-08-25, i.e. exactly the life of this AI-OS build. Zero Konrad-authored prose found. | sure |
| `90_AI_OS/` (56 files) | `Forge/` | **Diverges from a literal reading of the brief** ("90_AI_OS/ Session State + operator notes" read as *some* files) — measured, essentially the whole folder is agent-authored. Every sampled file (`Konrad Projects Overview.md`, `Infrastructure - Master Map.md`, `Spec - Personal AI OS Interface.md`, all `Client - *.md`, all `Project - *.md`, all `API - *.md`) carries either elaborate synthesis frontmatter (`type: synthesis`, `date_created`/`date_modified`) or an explicit self-description: `Infrastructure - Master Map.md` opens "**Written:** 2026-06-14 ... **Source of truth:** This file, synced to `/opt/hermes-control/INFRASTRUCTURE.md`" and `Spec - Personal AI OS Interface.md` opens "**For:** Claude (claude.ai design/canvas) to produce a UI design from." This is Hermes (the predecessor agent) writing Konrad's business/client/infra reference docs *for* him, not Konrad typing them. mtimes cluster in two bands: 2026-05-22 (33 files, the original client/project sweep) and 2026-06-01→2026-06-23 (23 files, the API/infra sweep) — both agent-batch patterns, not organic daily writing. **This is real business content Konrad depends on** (client names, infra map) even though an AI wrote the prose — flagged in §5 "ask Konrad" below rather than treated as settled. | **likely — ask** |
| `Excalidraw/` (17 files) | mixed | See §2, per-file. | — |
| `.obsidian`, `.stfolder`, `.trash` (dot-dirs) | **never move** | Syncthing marker and Obsidian config; per brief, must never move. `.trash` left untouched (it is Obsidian's own trash, moving it would resurrect/relocate deleted notes under a new root). | sure |

## 2. `Excalidraw/` — per file (17 files)

Two authorship signatures found in the raw content:
- **Default-named** `Drawing <timestamp>.excalidraw.md` = Obsidian's auto-filename when a human draws by hand in the Excalidraw plugin (desktop/mobile). All of these contain only a `compressed-json` blob (binary-ish, no readable text elements) — consistent with freehand sketching, not agent-generated content (the canvas API writes readable "Text Elements", see below).
- **Explicitly named**, with readable `## Text Elements` sections = either (a) Konrad's own typed/labelled planning canvases, or (b) throwaway fixtures created while build workers verified the canvas→plan-graph feature (`routes/canvas.ts`, confirmed live: memory note `canvas-probe-scratch-vault-and-tmux-env.md`, 2026-08-23 — "verifying the excalidraw→plans push gate"). The word "smoke" in a filename is the tell for (b).

| File | Destination | Evidence | Confidence |
|---|---|---|---|
| `Drawing 2026-06-13 21.29.57.excalidraw.md` | `Konrad/` | Default autoname, compressed-json blob only, no readable text | likely |
| `Drawing 2026-07-02 12.08.39.excalidraw.md` | `Konrad/` | Default autoname; per memory note this is the "34 tasks, 8 dependency edges" real subject used later as a canvas-feature test fixture — it is still Konrad's own drawing (a copy was made elsewhere for testing, not this file) | likely |
| `Drawing 2026-07-03 18.25.41.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-07-03 18.25.45.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-07-07 18.30.43.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-07-23 00.48.06.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-07-26 13.08.35.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-08-05 12.31.07.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-08-09 15.42.40.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Drawing 2026-08-23 16.25.26.excalidraw.md` | `Konrad/` | Default autoname, blob only | likely |
| `Untitled-2026-08-02-1208.excalidraw` (no `.md`) | `Konrad/` | Raw Excalidraw JSON export (`"source": ".../obsidian-excalidraw-plugin/..."`), default `Untitled-<timestamp>` name — same hand-drawing signature, just not yet plugin-wrapped into markdown | likely |
| `Stealth Uploader - System Map.excalidraw.md` | `Konrad/` | Readable text elements, substantive real content ("STEALTH UPLOADER — SYSTEM MAP", "0 · co-planning draft", control-plane/upload-node architecture) — his own project planning, not a test fixture. (Known bug, unrelated to authorship: fails to render, "invalid order key: a0080" per memory note.) | likely |
| `Stealth Uploader - Warming Timeline.excalidraw.md` | `Konrad/` | Readable text, "ACCOUNT WARMING TIMELINE — Oma 2 → upload-ready", same project as above | likely |
| `Directory Engine - Scraper System Map.excalidraw.md` | `Konrad/` | Named system-map pattern matching the two Stealth Uploader files above — his own project architecture sketch | likely |
| `AI OS - Life & Company OS - Planning Canvas.excalidraw.md` | `Konrad/` | Readable text opens "KONRAD'S AI OS → LIFE & COMPANY OPERATING SYSTEM · planning canvas v0 (2026-07-29)" — first-person framing, predates this build project, reads as his own planning session | likely |
| `gemini-canvas-smoke.excalidraw.md` | `Forge/` | Filename says "smoke" — a throwaway test fixture from verifying the canvas ingestion path, not real content | likely |
| `AI OS - Canvas Smoke Test.excalidraw.md` | `Forge/` | Filename says "Smoke Test" explicitly — same as above | sure |

## 3. Loose root `.md` files (69 files)

All 69 cluster mtime **2026-01-29 → 2026-02-11**, before this AI-OS project existed
(first `AI OS/` file is 2026-07-09). Every sampled file uses simple
`tags:`-only frontmatter or none, second-person/shorthand prose ("You have to
just copy the outliers..."), and several contain literal Windows paths
(`C:\Users\konra\OneDrive\Books` in `Books.md`) — conclusive: typed by Konrad on
his own machine, synced in. **All → `Konrad/`, confidence sure**, except the two
noted:

`000_Nexus.md`, `A content system for a business.md`, `AI for content.md`, `AI safety.md`,
`AI Stories Channels.md`, `Antigravity Skills.md`, `Automated Media Infrastructure.md`,
`Books.md`, `brand guidelines.md`, `cal.com.md`, `Closing on Social Media.md`,
`Context Engineering.md`, `Converting Make.com Automation to n8n.md`,
`Creating Social Media Content from Target Website Data.md`, `Current Situation Snapshot.md`,
`Documented Conflicts.md`, `Elevenlabs Voices.md`, `Execution Plan - Phase 1 Foundation.md`,
`Experience of locking in.md`, `Finance - Tier 1 Basic Operation.md`,
`Find a Niche for YTA longform.md`, `Focus System by Mark.md`, `Folder Structure.md`,
`Gary Guides You.md`, `Help from Harry.md`, `How a channel gets approved and what to avoid.md`,
`How to build something with AI.md`, `How to build websites with cool scroll animations like AntiGravity..md`,
`How to deliver your product to the client.md`, `How to design Landingpages that converts.md`,
`How to get social proof for your product.md`, `How to handle data in a business.md`,
`How to onboard clients.md`, `How to retain Software ownership.md`, `How to set up a YT Channel.md`,
`How to set up business contracts.md`, `Immediate things to do.md`, `Inauthentic Content.md`,
`KarmaBiker.md`, `Manychat.md`, `MCP Connections.md`, `memory of ai (RAG).md`,
`Notes on Scott YTA Video.md`, `Objections when closing on Social Media.md`, `Peak Elevation.md`,
`Phones With Peter.md`, `Project - AI Stories.md`, `Project - Search-Based Content Engine.md`,
`Project - Tutorials.md`, `Project - YTA.md`, `Prompting AI.md`, `Prompting AI Voice Agents TTS.md`,
`Proxies.md`, `Real Loofey.md`, `Research - Hardware Market Timing.md`,
`Research - Political Content Mechanics.md`, `SimplyStep.md`, `Social Media Funnels.md`,
`System - OpenClaw AI Agent.md`, `Tested niches YTA.md`, `Tested YTA Niches.md`,
`Tragetic times.md`, `Uploading via API.md`, `Vibecoding Tools.md`, `VidIQ on Copyright.md`,
`Where AI solved problems and made money.md`, `World Class Offers on Social Meidia.md`,
`YouTube Copyright.md`

- `Untitled.md`, `Untitled 1.md` — `Konrad/`, confidence **sure**, evidence: empty (0 bytes), default Obsidian new-note names, mtimes 2026-02-07 and 2026-02-11 fit the same cluster. No agent marker; agents don't create untitled empty notes.

## 4. Code references that must learn the new roots

`grep -rn 'obsidian-vault\|Daily/\|Inbox/\|Mentor/'` over
`forge-control/src forge-control agents scripts` (plus `/opt/ai-os/scripts` and
the Hermes skill), from `/opt/forge-ai-os`:

- **`forge-control/src/lib/vault.ts:97-99`** — `VAULT_DIR`, `DAILY_DIR = "Daily"`,
  `INBOX_DIR = "Inbox"` defaults. This is exactly the file PLAN.md §3.5 already
  targets for the `VAULT_LAYOUT=legacy|split` mechanism — no new discovery here,
  confirms the plan is pointed at the right file.
- **`forge-control/src/routes/map.ts:73-74`** — hardcodes literal relative paths
  `OVERVIEW_NOTE = "90_AI_OS/Konrad Projects Overview.md"` and
  `MASTER_MAP_NOTE = "90_AI_OS/Infrastructure - Master Map.md"`, joined against
  `VAULT_DIR` at line 143. **This is a concrete break if `90_AI_OS/` moves**
  under either root — the route already fails loudly on a missing file
  ("an unreadable vault is an error, not 'no drawings'", line 494) rather than
  silently, but it WILL fail at `--apply` time until these two constants are
  repointed to `Forge/90_AI_OS/...` (or wherever 90_AI_OS lands — see the ask in
  §5). Canvas discovery in the same file (`walkCanvases(VAULT_DIR, ...)`,
  line 496, glob `**/*.excalidraw.md`) is a full recursive walk, not a hardcoded
  subpath — the Excalidraw split does **not** need a code change here.
- **`forge-control/src/db/memory.ts`**, **`forge-control/src/lib/memory-ranking.ts`**,
  **`forge-control/src/lib/canvas-context.ts`**, **`forge-control/src/lib/telegram-bridge.ts`**,
  **`forge-control/src/lib/cc-runner.ts`**, **`forge-control/src/routes/run-control.ts`** —
  all reference `obsidian-vault`/`VAULT_DIR` but as the resolved root only (no
  hardcoded subpaths found in this pass); should be unaffected by folders moving
  one level deeper, but worth a grep pass again once `vault-layout.ts` lands.
- **`forge-control/src/lib/excalidraw-*.{ts,test.ts}`** (extract, extract-cli,
  graph, plan) — consume whatever paths `map.ts`/`canvas.ts` hand them; not
  independently path-hardcoded.
- **`agents/architect.md:8`** — prose mention "Obsidian vault at
  `/opt/obsidian-vault`" only (root, not a subpath) — update once `split` is the
  default, cosmetic only.
- **`scripts/checks/verify-control-plane.sh`, `scripts/seed-heartbeats.sh`** — not
  inspected in this pass (out of budget); flag for the planner to grep before
  `--apply`.
- **Hermes skill** (`.../skills/note-taking/obsidian/SKILL.md`) — **uses a
  different env var**, `OBSIDIAN_VAULT_PATH` (not `OBSIDIAN_VAULT_DIR`), default
  fallback `~/Documents/Obsidian Vault` if unset. If Hermes's `~/.hermes/.env`
  points `OBSIDIAN_VAULT_PATH` at `/opt/obsidian-vault`, Hermes is a **second,
  independent writer** into this same vault that the `actor: "agent"|"konrad"`
  guard in `lib/vault.ts` cannot see or enforce — Hermes has its own file-write
  tools, not `forge-control`'s `writeVaultFile`. **This means the `split` guard
  only governs forge-control's own writes; Hermes needs its own instruction
  update (skill doc) to write only under `Forge/`, or the split leaks on day
  one.** Not confirmed live (didn't have access to check `~/.hermes/.env`
  itself) — flag as an open question, not a measured fact.
- No matches for `Excalidraw/` as a hardcoded path anywhere in the grepped
  trees (confirms the recursive-walk finding above).

## 5. Wikilinks — what would break, what would not

Checked two ways: duplicate basenames vault-wide (ambiguity risk), and every
path-qualified `[[folder/note]]` link (the only kind whose resolution is
sensitive to a prefix change).

**Duplicate basenames found:** `System - OpenClaw AI Agent.md` (root, and
`30_YouTube/Plan for YouTube/`), `index.md` × 4 and `settings.md` × 2 (all inside
`20_Coding/01_Tutorial Production Software/06_UI/...`). **None cross the
Konrad/Forge boundary** — every duplicate pair lands on the same side
(`Konrad/`) under this manifest, so the split does not introduce new ambiguity
beyond what already exists today.

**Path-qualified wikilinks found** (`grep -rEo '\[\[[^]|#]+[/][^]|]*(\|[^]]*)?\]\]'`):
`[[10_Idea_Reactor/00_Idea_Board]]`, `[[20_Coding/00_Stack_Rules]]`,
`[[30_YouTube/00_Knowledge_Base]]`,
`[[30_YouTube/Plan for YouTube/System - OpenClaw AI Agent]]` (×2, one aliased),
`[[AI OS/Operator Log]]`, `[[How to price info/service products]]`.

Obsidian resolves a path-qualified wikilink by **suffix match** against the
full vault-relative path, not by exact-path match from vault root — so
`[[20_Coding/00_Stack_Rules]]` still resolves once the real path becomes
`Konrad/20_Coding/00_Stack_Rules.md`, because that path *ends with*
`20_Coding/00_Stack_Rules.md`. Under this manifest **none of these six break as
a result of the split**:
- `[[20_Coding/00_Stack_Rules]]`, `[[30_YouTube/.../System - OpenClaw AI Agent]]`
  (×2), `[[AI OS/Operator Log]]`, `[[How to price info/service products]]` — all
  targets exist and stay findable by suffix match after their folder gains a
  `Konrad/` or `Forge/` prefix.
- `[[10_Idea_Reactor/00_Idea_Board]]` and `[[30_YouTube/00_Knowledge_Base]]` are
  **already dangling today** (`10_Idea_Reactor/` is empty; the Knowledge_Base
  note is in `.trash`) — pre-existing breaks, not caused by the split, and not
  fixed by it either.

**Conclusion: zero wikilinks are newly broken by moving folders under `Konrad/`
or `Forge/`, as long as folder names themselves are preserved** (this manifest
does not rename any folder, only nests it one level deeper).

## 6. Ask Konrad

1. **`90_AI_OS/` (56 files)** — measured as entirely agent(Hermes)-authored
   prose (see §1), which makes it `Forge/` by the letter of the split rule, but
   it holds his real client list, project index and infrastructure map — the
   stuff he actually reads to remember what he's running. Options: (a) `Forge/`
   as the rule says, since he can still browse it there; (b) keep it under
   `Konrad/` as an exception because it's business-critical reference, not
   AI-OS operational output; (c) split it further (client/project docs →
   `Konrad/`, the `Session State`/synthesis-only docs → `Forge/`) — most correct
   but the most work, and this pass did not find a clean per-file line inside
   it beyond "all of it reads the same way." Default if unanswered: **(a)
   `Forge/`**, since that is what the content-authorship rule the brief itself
   states actually says.
2. **Hermes's independent vault writer** — `OBSIDIAN_VAULT_PATH` (not
   `OBSIDIAN_VAULT_DIR`) is the env var the laptop-side Hermes obsidian skill
   uses; not confirmed whether it currently points at `/opt/obsidian-vault` or
   a separate local vault. If it's the same vault, Hermes needs its own
   `actor`-style rule before `split` mode ships, or Hermes writes will land
   outside `Forge/` unguarded. Needs Konrad (or a live check on the laptop
   session) to confirm.
3. **`30_YouTube/TheSkyLab/HANDOFF.md`** (and likely `.../Production Log.md`) —
   agent-authored session-handoff docs sitting inside a folder classified
   `Konrad/`. Fine to leave for round 1 (folder-level granularity), but should
   be pulled into `Forge/` in a later per-file pass — flagging now so it isn't
   forgotten.

## 7. Machine-readable manifest (folder-level; consumed by `scripts/vault-split-move.ts`)

```json
[
  {"from": "20_Coding", "to": "Konrad/20_Coding", "confidence": "sure"},
  {"from": "30_YouTube", "to": "Konrad/30_YouTube", "confidence": "sure"},
  {"from": "_Templates", "to": "Konrad/_Templates", "confidence": "sure"},
  {"from": "_Attachements", "to": "Konrad/_Attachements", "confidence": "likely"},
  {"from": "How to price info", "to": "Konrad/How to price info", "confidence": "likely"},
  {"from": "Daily", "to": "Forge/Daily", "confidence": "sure"},
  {"from": "Mentor", "to": "Forge/Mentor", "confidence": "sure"},
  {"from": "Inbox", "to": "Forge/Inbox", "confidence": "sure"},
  {"from": "AI OS", "to": "Forge/AI OS", "confidence": "sure"},
  {"from": "90_AI_OS", "to": "Forge/90_AI_OS", "confidence": "likely-ask"},
  {"from": "10_Idea_Reactor", "to": null, "confidence": "sure (empty, no-op)"},
  {"from": "40_Life Knowledge", "to": null, "confidence": "sure (empty, no-op)"},
  {"from": "99_System", "to": null, "confidence": "sure (empty, no-op)"},
  {"from": "Use_Input_Archive", "to": null, "confidence": "sure (empty, no-op)"},
  {"from": ".obsidian", "to": null, "confidence": "sure (never move)"},
  {"from": ".stfolder", "to": null, "confidence": "sure (never move)"},
  {"from": ".trash", "to": null, "confidence": "sure (never move)"},
  {"from": "Excalidraw/Drawing 2026-06-13 21.29.57.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-06-13 21.29.57.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-02 12.08.39.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-02 12.08.39.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-03 18.25.41.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-03 18.25.41.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-03 18.25.45.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-03 18.25.45.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-07 18.30.43.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-07 18.30.43.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-23 00.48.06.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-23 00.48.06.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-07-26 13.08.35.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-07-26 13.08.35.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-08-05 12.31.07.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-08-05 12.31.07.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-08-09 15.42.40.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-08-09 15.42.40.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Drawing 2026-08-23 16.25.26.excalidraw.md", "to": "Konrad/Excalidraw/Drawing 2026-08-23 16.25.26.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Untitled-2026-08-02-1208.excalidraw", "to": "Konrad/Excalidraw/Untitled-2026-08-02-1208.excalidraw", "confidence": "likely"},
  {"from": "Excalidraw/Stealth Uploader - System Map.excalidraw.md", "to": "Konrad/Excalidraw/Stealth Uploader - System Map.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md", "to": "Konrad/Excalidraw/Stealth Uploader - Warming Timeline.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/Directory Engine - Scraper System Map.excalidraw.md", "to": "Konrad/Excalidraw/Directory Engine - Scraper System Map.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md", "to": "Konrad/Excalidraw/AI OS - Life & Company OS - Planning Canvas.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/gemini-canvas-smoke.excalidraw.md", "to": "Forge/Excalidraw/gemini-canvas-smoke.excalidraw.md", "confidence": "likely"},
  {"from": "Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md", "to": "Forge/Excalidraw/AI OS - Canvas Smoke Test.excalidraw.md", "confidence": "sure"}
]
```

Root loose `.md` files: all 69 → `Konrad/<same filename>`, confidence `sure`
except `Untitled.md`/`Untitled 1.md` (also `sure`, empty files) — full name list
is §3 above, omitted from the JSON block to keep it a manageable size; the mover
script should treat "no destination folder listed above and file sits at vault
root with `.md` extension, excluding dot-files" as the rule for this batch
rather than enumerating 69 identical `{"to": "Konrad/<name>"}` entries.

## 8. What this pass did not do (explicitly out of scope)

No files moved, renamed or edited — confirmed by `git status`-equivalent: this
worktree has read-only access to `/opt/obsidian-vault` and no write calls were
made. `scripts/vault-split-move.ts` and the `VAULT_LAYOUT=legacy|split` guard
in `lib/vault.ts` do not exist yet — this manifest is their input, not a
substitute for building them (that's PLAN.md §3.5's mechanism work, a separate
task).
