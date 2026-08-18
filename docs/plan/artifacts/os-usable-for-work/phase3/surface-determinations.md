# Phase 3 — Surface determinations

**Project:** `os-usable-for-work` · phase 3 (round 300) · workstream `surfaces`
**Requirements:** R41 (a determination per surface), R42 (Library names an existing producer), R37, N1, N10
**Date:** 2026-08-18 · **Author:** B3a (builder, measure half — no application code changed)
**Before state and how it was reproduced:** `reproduction-before.md` in this directory

Five sections: GOALS, JOURNAL, MAP, LIBRARY, and SEARCH. The first four are `NAV` entries Konrad can
click. The fifth is a placeholder key with no way in; it is here because the same render branch serves
it, and because a surface nobody can reach is a different defect requiring a different answer.

Every number carries its command (N10). **Building any of these is an explicit non-goal of this
project** (00-vision.md §5); the cost estimates exist so that deferring is a decision with a price on
it rather than a shrug.

---

## 0. The evidence common to all five

Run in the worktree, 2026-08-18:

```bash
$ grep -rn "api/goals\|api/journal\|api/map\|api/library" forge-control/src forge-control-web/app
$ echo $?
1
```

**Zero matches.** Not one line of server or client code in this repo mentions any of those four
endpoints.

```bash
$ ls forge-control/src/routes/
accounts.ts       cron.ts           inbox.ts          projects.ts       systemd.ts
agents-shared.ts  decisions.ts      integrations.ts   reminders.ts      tasks.ts
agents.ts         entities.ts       ledger.ts         run-control.ts    today.ts
autonomy.ts       files.ts          live.ts           search.ts         uploads.ts
canvas.ts         fleet.ts          media.ts          secrets.ts        usage.ts
capabilities.ts   forge.ts          memory.ts         skills.ts         vault.ts
chat-linkage.ts   health.ts         mentor.ts         spend.ts          webhook-in.ts
chat.ts           hermes.ts         pipeline.ts       system.ts         webhooks.ts
control.ts        pm2.ts            working-time.ts
$ ls forge-control/src/routes/ | wc -l
43
```

43 route modules. **No `goals.ts`, no `journal.ts`, no `map.ts`, no `library.ts`.** There *is* a
`search.ts` — see §5, it changes that surface's answer completely.

```bash
$ ls forge-control/src/db/
ai-os-pool.ts       cron.ts       hermes.ts    mentor.ts          projects.ts   skills.ts
ai_os.ts            entities.ts   ledger.ts    notifications.ts   reminders.ts  spend.ts
autonomy.ts         forge.ts      memory.ts    pipeline.ts        runs.ts       webhooks.ts
claude-accounts.ts
$ ls forge-control/src/db/ | wc -l
19
```

19 data-access modules. **No goals, journal, map or library module.**

Tables, across all three databases forge-control reaches:

```bash
$ for db in ai_os content_forge hcp; do psql <url> -Atc \
    "SELECT table_schema||'.'||table_name FROM information_schema.tables
      WHERE table_name ~* 'goal|journal|^map|librar'"; done
ai_os          (10 tables total)  → (none)
content_forge  (124 tables total) → public.format_style_libraries, public.format_style_library_assets,
                                    public.music_library, public.clip_libraries,
                                    public.clip_library_configs, public.clip_library_reference_scripts
hcp            (23 tables total)  → public.goal
```

Two name collisions, neither of them a backing store for these surfaces:

- The six `*_librar*` tables in `content_forge` are **ReelForge content-format libraries** (clip
  libraries, music beds, format styles). They belong to the video pipeline, not to an OS artefact
  browser. Reusing the name would be the worst kind of false positive.
- `hcp.goal` is real but is **the Hermes HCP business-line schema** — `business_line_id NOT NULL`
  foreign-keyed to `business_line(id)`, referenced by `plan`, holding **1 row**
  (`psql hcp -Atc 'SELECT count(*) FROM goal'` → `1`). forge-control never reads it:
  `grep -rn 'FROM goal' forge-control/src/` returns nothing; every `goal` hit in that tree is
  `metadata.mode === "goal"` on the projects table (`lib/project-tick.ts:285`), which is the
  long-horizon-project flag and unrelated.

**The only statement of intent that exists anywhere** for these five is the `PLACEHOLDER_SURFACES`
record itself, `DesktopApp.tsx:73-188`. There is no spec, no ticket, no vault note. It was written in
the initial commit and has not been touched since:

```bash
$ git log --format='%h %ad %s' --date=short -S'PLACEHOLDER_SURFACES' --reverse -- forge-control-web/app/desktop/DesktopApp.tsx
c7e488d 2026-06-21 feat: initial v1.6 state — Personal AI OS (forge-control + forge-control-web)
$ git log -1 --format='%h %ad' --date=short -S'PLACEHOLDER_SURFACES' -- forge-control-web/app/desktop/DesktopApp.tsx
c7e488d 2026-06-21
```

So every "intended purpose" quoted below is quoted from that record, and is **58 days old and
unrevised**. Where I judge the intent no longer matches what the machine now needs, I say so and say
which is which.

**Cost units.** This engine's units: *builder tasks at a tier* (`fast` / `standard` / `flagship`,
the `architect_tier` values `POST /api/projects` accepts), *reviewers* (a gating reviewer per phase,
N9), and *rounds* (one planner → builders → gating reviewer band). A fix cycle inside a phase is an
extra round. Estimates below assume the standing constraint that **no new tables and no migrations**
are introduced in this project (02-architecture.md, design constraints) — where a table is needed, the
estimate says so and that alone puts the work outside this project.

---

## 1. GOALS

### Intended purpose

Quoted verbatim from `PLACEHOLDER_SURFACES.goals`, `DesktopApp.tsx:146-155` — **the only statement of
intent that exists**:

> **tag** `GOALS`
> **title** "What I'm trying to do"
> **desc** "Quarter cards, week list, today mirror."
> **items** `flag` "quarter objectives" · `list` "this week" · `today` "today mirror"

In concrete terms: a three-horizon objective tracker. Quarter-level objectives with success metrics,
a week-level list beneath them, and a "today mirror" — the subset of the week that is due today,
reflected from (or into) the TODAY surface.

### Current state: **UNBUILT**

- `NAV` entry `{ key: "goals", label: "GOALS", group: "recall" }` — `nav-items.ts:93`
- falls through the render switch (`DesktopApp.tsx:423-476` handles fourteen surfaces; `goals` is not
  among them) to the placeholder branch at `DesktopApp.tsx:477-486`
- rendered by `PlaceholderSurface`, defined `DesktopApp.tsx:2777`
- fed from the hardcoded record at `DesktopApp.tsx:73`
- no `/api/goals` (§0), no `routes/goals.ts` (§0), no `db/goals.ts` (§0), no table in any of the three
  databases (§0)
- reproduced in the browser: `before-goals.png`. DOM probe: placeholder tag present, `/not built/i`
  **absent**, 3 feature bullets rendered.

**Of the five, GOALS is the only one with no existing producer at all.** Nothing in this system knows
what Konrad's quarter objectives are.

### What it would need

| Piece | Concretely |
|---|---|
| Table | `ai_os.goals` — `id uuid pk`, `horizon text check (horizon in ('quarter','week','today'))`, `parent_id uuid null references goals(id)`, `title text not null`, `success_metric text null`, `status text`, `due_on date null`, `position int`, `created_at`, `updated_at` |
| Route | `forge-control/src/routes/goals.ts` — `GET /api/goals?horizon=`, `POST /api/goals`, `PATCH /api/goals/:id`, `DELETE /api/goals/:id`; mounted in `index.ts` beside `app.route("/api/decisions", decisions)` (`index.ts:164`) |
| Data access | `forge-control/src/db/goals.ts` on the `ai_os` pool (`db/ai-os-pool.ts`) — this is operator state, not content state, so 5434/`ai_os`, not 5432/`content_forge` |
| Producer | **None exists and none is plausible to automate.** Objectives are typed by Konrad. The "today mirror" is a *read* joining `goals` where `due_on = current_date` into the existing `/api/today` payload (`routes/today.ts`); it is not a writer |
| Surface | `GoalsSurface.tsx` — three-column or three-band layout, inline create/edit, drag-to-reorder is optional |

### Recommendation: **DEFER**, and it is the strongest defer of the five

Two reasons beyond scope. First, it needs a **new table**, which this project has ruled out wholesale
(02-architecture.md: "No new tables, no migrations, anywhere in this project — a schema change is a
deploy risk this project does not need"). Second, and more importantly: **GOALS is a data-entry
surface, and this project's entire thesis is that the OS cannot yet accept input.** Lane 1 is building
the vault write path precisely because that is missing. Shipping a second write surface before the
first one is proven is how you get two half-trusted editors instead of one trusted one.

There is also a real question of whether it should be a table at all. Konrad's objectives already live
in the vault (`/opt/obsidian-vault`, 284 real `.md` files, 100% indexed into `hcp.knowledge_note` by
`syncVaultNotes()` — 00-vision.md §2.1). A GOALS surface reading a *convention* over vault notes
(frontmatter `horizon: quarter`) would need **no table, no migration, and no new write path** once
lane 1 lands. That is a materially cheaper design and it is not mine to choose — it is a preference
decision for Konrad, and it should be asked before anyone estimates the table version seriously.

**Cost if built as specified (table-backed):**

| | |
|---|---|
| Rounds | 2 (build + one fix cycle; a new write surface will not pass its first gate) |
| Builder tasks | 3 — 1× `standard` (migration + `db/goals.ts` + `routes/goals.ts` + unit tests per N2), 1× `standard` (`GoalsSurface.tsx` + render switch + nav), 1× `fast` (today-mirror join into `/api/today`) |
| Reviewers | 1 gating reviewer, plus 1 integration reviewer |
| Also required | a migration, which forces a deploy of `forge-control`, not just the web bundle |

**Cost if built as a vault convention (recommended alternative, and only *after* lane 1 lands):**
1 round, 2 builder tasks (1× `standard` reader + surface, 1× `fast` today-mirror), 1 gating reviewer,
**no migration**.

---

## 2. JOURNAL

### Intended purpose

Quoted verbatim from `PLACEHOLDER_SURFACES.journal`, `DesktopApp.tsx:156-165`:

> **tag** `JOURNAL`
> **title** "What happened"
> **desc** "Auto-logged day-by-day. Every inbox resolution recorded as a decision."
> **items** `calendar_month` "day calendar strip" · `gavel` "decisions log" · `notes` "auto-written entries"

In concrete terms: a retrospective day view. A date strip to pick a day, a log of decisions taken that
day, and narrative entries written by the machine rather than by hand.

### Current state: **UNBUILT — but half of it is already running**

Unbuilt, on the same evidence as §1: `nav-items.ts:94`, falls through to `DesktopApp.tsx:477-486`, no
`/api/journal`, no `routes/journal.ts`, no `db/journal.ts`, no table (§0). Reproduced:
`before-journal.png`; `/not built/i` absent, 3 bullets.

**But the second bullet is not a wish — it exists, it is mounted, and it is populated.** The copy
promises "Every inbox resolution recorded as a decision", and that is exactly what
`content_forge.decisions` holds:

```bash
$ grep -n 'decisions' forge-control/src/index.ts
17:import decisions from "./routes/decisions.ts";
108:      "/api/decisions",
164:app.route("/api/decisions", decisions);

$ curl -s http://127.0.0.1:7700/api/decisions | head -c 260
{"count":50,"decisions":[{"id":"3501b7de-…","ts":"2026-08-18 18:41:40.670615+00","kind":"resolve",
"actor":"user","action":"resolved inbox item REMINDER: 🔧 Watchdog: project \"engine-task-graph\" was
blocked by a failed run — auto-unwedged, 1 task(s) retrying.","payload":{"action_id":"resolve"},
"inbox_item_id":"bc824a0a-…"

$ psql content_forge -Atc 'SELECT count(*) FROM decisions'
120
```

**120 rows, timestamped, with `kind`, `actor`, `action`, `payload` and `inbox_item_id`** — read by
`listDecisions()` (`db/ai_os.ts:652-660`, on the `DATABASE_URL` pool, i.e. `content_forge` at 5432).
`GET /api/decisions?limit=` accepts 1-500 (`routes/decisions.ts:6-13`). No web code consumes it:

```bash
$ grep -rn "api/decisions" forge-control-web/
(no matches)
```

So JOURNAL is not four features away from existing. It is **one feature away from being useful**: a
day-grouped view of a table that has been filling itself for weeks.

### What it would need

| Piece | Concretely |
|---|---|
| Table | **None for the decisions log** — `content_forge.decisions` exists and is populated by the inbox resolve path. Only "auto-written entries" (narrative prose per day) would need storage, and that is the expensive third of the surface |
| Route | `GET /api/journal?date=YYYY-MM-DD` in a new `routes/journal.ts`, or — cheaper and honest — extend `routes/decisions.ts` with `GET /api/decisions?from=&to=` and let the surface group client-side. The second needs **no new module** |
| Data access | extend `listDecisions()` (`db/ai_os.ts:652`) with a date range; it currently takes only `limit` |
| Producer | **already running** for the decisions log — the inbox resolve handler writes a row per resolution. For "auto-written entries" there is no producer and writing one means an LLM pass per day with a recurring cost, which is the same objection 00-vision.md §5.2 raises against the triple extractor |
| Surface | `JournalSurface.tsx` — date strip + grouped decision list |

### Recommendation: **DEFER the surface, but record that two-thirds of it is cheap**

Defer, because it is out of scope (00-vision.md §5) and because the phase-3 answer for an unbuilt
surface is words, not features. But the determination would be dishonest if it left the impression
that JOURNAL is as far away as GOALS. It is not. The date strip and the decisions log are a read over
an existing populated table with an existing mounted route.

**Only the third bullet — "auto-written entries" — is genuinely expensive**, and it carries a
recurring LLM cost per day forever. My recommendation if JOURNAL is ever picked up: **build the first
two bullets and delete the third from the copy**, rather than carry a promise nobody intends to fund.

**Cost, first two bullets only:**

| | |
|---|---|
| Rounds | 1 |
| Builder tasks | 2 — 1× `fast` (date-range parameter on `listDecisions()` + `routes/decisions.ts`, plus the unit test N2 requires), 1× `standard` (`JournalSurface.tsx`, render switch, nav) |
| Reviewers | 1 gating reviewer |
| Migration | **none** |

**Cost including auto-written entries:** +1 round, +1 `standard` builder (a summariser tick in
`forge-control/src/lib/`), +1 table for the generated prose, **+ a recurring token cost per day**. Not
recommended.

---

## 3. MAP

### Intended purpose

Quoted verbatim from `PLACEHOLDER_SURFACES.map`, `DesktopApp.tsx:166-176`:

> **tag** `MAP`
> **title** "Where everything lives"
> **desc** "Services, domains, storage, providers, channels — and what runs them."
> **items** `lan` "services + systemd" · `language` "domains" · `database` "storage" · `cloud` "providers"

In concrete terms: an infrastructure inventory. What is running, on what host, behind which domain,
writing to which volume, through which external provider.

### Current state: **UNBUILT — and it is the one whose producers are most nearly complete**

Unbuilt on the same evidence: `nav-items.ts:95`, falls through to `DesktopApp.tsx:477-486`, no
`/api/map`, no `routes/map.ts`, no table (§0). Reproduced: `before-map.png`; `/not built/i` absent,
4 bullets.

Its four bullets, measured against what already answers today:

| Bullet | Producer | Live measurement (2026-08-18) |
|---|---|---|
| services + systemd | `routes/pm2.ts:6` `GET /api/pm2/list` and `routes/systemd.ts:91` `GET /api/systemd/units` | `curl -s http://127.0.0.1:7700/api/pm2/list` → **24 processes, 19 online**; `curl -s http://127.0.0.1:7700/api/systemd/units` → **97 units, 1 flapping** |
| storage | `routes/system.ts:89` `GET /api/system/stats` | returns live `uptime_seconds`, `cpu.load_1m/5m/15m`, `memory.total/used/available_bytes` — `67,346,612,224` total bytes, `40,772,870,144` used at the time of measurement |
| providers | `routes/integrations.ts:287` `GET /api/integrations/gemini`, `:555` `GET /api/integrations/google` | partial today; **phase 4 of this very project (workstream `connections`, R44-R58) is building probe-backed status for Claude accounts, Google Workspace, `agy` and GitHub** |
| domains | **no route** | 19 vhosts exist on disk (`ls /etc/nginx/sites-enabled/ \| wc -l` → `19`); nothing in `forge-control/src/routes/` reads nginx |

**Three of four bullets have live producers today; the fourth is 19 files nobody has parsed.** MAP is
an aggregation view over endpoints that already return real data, not a new subsystem.

### What it would need

| Piece | Concretely |
|---|---|
| Table | **none** — every source is a live probe of the host. Caching it would make it stale, which is the exact defect class 00-vision.md §6 says this project exists to remove |
| Route | `forge-control/src/routes/map.ts` → `GET /api/map`, fanning out to the pm2, systemd and system readers already in the tree and returning one payload with a `checked_at` per section. **N1 applies hard here**: a section whose probe fails must return an error for *that section*, never an empty list that renders as "no services" |
| New producer | one — an nginx `sites-enabled` parser for the domains column, in `forge-control/src/lib/`. Parse `server_name` and `proxy_pass` from 19 files; deterministic, no external calls |
| Surface | `MapSurface.tsx` — four sections, each with its own `checked_at` and its own failure state |

### Recommendation: **DEFER — but MAP is the cheapest of the five and the natural phase-4 neighbour**

Defer, because out of scope. But note the adjacency honestly: **phase 4 of this project is already
building probe-backed connection status with `checked_at`** (00-vision.md definition-of-done #6,
R44-R58). MAP's providers column is the same data with a different frame. If MAP is ever built, it
should be built **immediately after phase 4 lands and should reuse its probe contract**, not invent a
second one. Building it before phase 4 would guarantee two status models.

**Cost:**

| | |
|---|---|
| Rounds | 1 |
| Builder tasks | 3 — 1× `fast` (nginx parser + unit test), 1× `standard` (`routes/map.ts` aggregator with per-section `checked_at` and per-section hard errors + tests), 1× `standard` (`MapSurface.tsx`, render switch, nav) |
| Reviewers | 1 gating reviewer |
| Migration | **none** |
| Precondition | phase 4's probe contract must exist first, or the providers column forks the model |

---

## 4. LIBRARY  *(R42)*

### The ruling: asked, unanswered, default stands

The phase-3 planner posted the question to Konrad on 2026-08-18. The manager chat run
`bfd1283a-b71b-4f35-b577-7d09aad803f2` was already closed, so it went out as a reminder. **Checked
twice while writing this document — at the start of the task and again at the moment of writing —
and it is still undecided:**

```bash
$ curl -s 'http://127.0.0.1:7700/api/inbox?limit=25' | python3 -c "…filter for LIBRARY…"
DECIDE | 2026-08-18 19:18:12.101755+00 | Phase 3 (surfaces): what is LIBRARY for? Ruled in the manager
chat — artefact store (default), document store, media, or defer. Default taken 2026-08-18: artefact
store (uploads, 423 files, live write path). Work proceeds either way.
```

Status `DECIDE`, not resolved. `curl -s http://127.0.0.1:7700/api/today` shows the same item under
`needs`, age 4m at first check.

> **Therefore this section ships the DEFAULT.** It is a default, taken on **2026-08-18**, by **the
> phase-3 planner** (02-architecture.md §2, corroborated by scout S-D, phase 0 round 99) and recorded
> here by **B3a**. **Konrad's ruling, whenever it comes, overrides it**, and the override is cheap
> while nothing is built — which is another argument for deferring rather than building now.

### Intended purpose

Quoted verbatim from `PLACEHOLDER_SURFACES.library`, `DesktopApp.tsx:103-113`:

> **tag** `LIBRARY`
> **title** "Assets & drafts"
> **desc** "Scripts, voices, images, clips, templates — a dense filterable grid."
> **items** `description` "scripts" · `graphic_eq` "voices" · `image` "images" · `dashboard` "templates"

**This copy is the one place where the 58-day-old intent is now actively wrong, and R42 forces the
issue.** "Scripts, voices, images, clips, templates" describes a **video-production asset browser** —
Content Forge's material. It was written when this UI was closer to a ReelForge console. Today
PIPELINE owns content jobs (`PipelineSurface.tsx` → `GET /api/pipeline` → `content_forge.content_jobs`,
a genuine live chain per 00-vision.md §2.5) and MEMORY owns the vault. A LIBRARY built to this copy
would shadow PIPELINE.

The default reframes it: **LIBRARY = the artefact and document store** — what the OS itself produced
(uploads: screenshots, reports, run artefacts), plus generated reports and Drive documents.
02-architecture.md §2 states this default; scout S-D confirmed it against counted reality and recorded
"Disagreements with Architecture Default: **None**".

### Current state: **UNBUILT**

Same evidence: `nav-items.ts:84`, falls through to `DesktopApp.tsx:477-486`, no `/api/library`, no
`routes/library.ts`, no `db/library.ts` (§0). Reproduced: `before-library.png`; `/not built/i` absent,
4 bullets. The six `*_librar*` tables in `content_forge` are ReelForge format libraries and are not
this (§0).

Konrad's complaint in the brief — "Library is completely empty" — is exact and is the phase-3 thesis
in miniature: it renders a four-row card that reads as a grid which failed to load.

### The producer — and it already exists, with an endpoint, today  *(R42)*

**Recommended backing store: `/opt/ai-os/uploads`, via the route that is already mounted.**

Not a proposal. `GET /api/uploads/index` is live right now:

```bash
$ curl -s http://127.0.0.1:7700/api/uploads/index | head -c 200
{"runs":[{"id":"2a6a5bac3022","count":1,"latest_ts":"2026-08-18T19:09:43.111Z"},
{"id":"2ba5db07f7ff","count":1,"latest_ts":"2026-08-18T18:50:29.674Z"},
{"id":"dbb65f80ce12","count":45,"latest_ts":"2026-08-17T08:01:29.119Z"},…
```

| Piece | It exists as | Evidence |
|---|---|---|
| Store | `/opt/ai-os/uploads/<run-id>/<stamp>-<label>.png` | `find /opt/ai-os/uploads -type f \| wc -l` → **423 files**; `find … -mindepth 1 -maxdepth 1 -type d \| wc -l` → **48 directories** |
| Index | `forge-control/src/lib/uploads-index.ts` — `parseShotName()` `:35`, `listRunShots()` `:51`, `listAllRuns()` `:108`, 10 s in-process cache | read from the file |
| Browse endpoint | `routes/uploads.ts:103` `GET /api/uploads/index` | live output above |
| Per-run endpoint | `routes/uploads.ts:108` `GET /api/uploads/:id/shots` | — |
| Fetch endpoint | `routes/uploads.ts:118` `GET /api/uploads/:id/:name` | — |
| Write path | `routes/uploads.ts:58` `POST /api/uploads` (multipart), plus every agent in this fleet writing to `$FORGE_RUN_ID` under N7 | the five screenshots beside this document were produced that way an hour ago |

**A LIBRARY over uploads needs no new route, no new table and no new producer.** It needs a surface.
That is why it is the recommendation: it is the only one of the five candidates that satisfies R42
without inventing anything.

**The unit trap, and it is already live.** `GET /api/uploads/index` returns **42 runs** while **48
directories** exist on disk:

```bash
$ curl -s http://127.0.0.1:7700/api/uploads/index | python3 -c "import sys,json;print(len(json.load(sys.stdin)['runs']))"
42
$ find /opt/ai-os/uploads -mindepth 1 -maxdepth 1 -type d | wc -l
48
```

The six-directory difference decomposes with no residue, from `computeAllRuns()`
(`lib/uploads-index.ts:83`), which keeps a directory only if it matches `ID_RE = /^[a-f0-9]{12}$/`
(`routes/uploads.ts:24`) **and** contains at least one file with an extension in `IMAGE_EXT`
(`:20`, `:57-58`):

| Cause | Dirs | Which |
|---|---|---|
| directory name is a full UUID, not the 12-hex run-id convention | 4 | `15346561-7172-…`, `2ab046fb-beb7-…`, `54158388-a2f6-…`, `9099e1af-7094-…` — at least one of these *does* contain PNGs (`ls /opt/ai-os/uploads/15346561-…` → `01-today-dark.png`, …) and is silently excluded by name alone |
| 12-hex directory containing no image | 2 | `4f2045fa7ef7` (empty), `beb589be59a0` (holds only `test-upload.txt`) |

So the endpoint's number means **"run directories containing at least one image and named to the
convention"**, not "runs". That is precisely the defect class this project exists to remove
(00-vision.md §6: *make it say what it is*). **Any LIBRARY built on this endpoint must label the
number, and should surface the non-conforming directories rather than hide them** — a run whose
artefacts are invisible because a script named its folder with a UUID is the same silent-fallback
failure as an unlabelled count.

**What was rejected, and why** (scout S-D, with counts; all rejections are the scout's and I concur):

| Candidate | Count | Why not |
|---|---|---|
| vault via `routes/files.ts` | 432 files | MEMORY already owns the notes; LIBRARY would shadow it |
| workspace via `routes/files.ts` | 307,620+ files | uncurated build artefacts and `node_modules`; an implementation detail of the run system |
| media via `routes/media.ts:25` | 6,137 files | job-scoped by design (`media.ts:99` rejects anything that is not a job UUID), **no browse endpoint exists**, and it is PIPELINE's material |
| Google Drive | 1,000+ items | no forge-control route at all; external CLI only; correctly phase 4's business (R62) |
| planning artifacts `docs/plan/artifacts/**` | 531 files | git-managed source, not runtime output |

### Recommendation: **DEFER the build; adopt the default as the recorded intent**

Defer, because building it is an explicit non-goal. But the determination is not neutral: **when
LIBRARY is built, it is uploads-backed**, and the phase-3 placeholder copy B3b writes should say so —
"LIBRARY would show the artefacts this OS produces (screenshots, reports, run outputs). It needs a
surface over `GET /api/uploads/index`, which already exists. Not scheduled by os-usable-for-work." That
sentence is worth more than the current four bullets because it is true, it is checkable, and it
survives Konrad ruling differently — if he rules "document store" or "media", the *route* changes and
the honest-placeholder wording is what gets edited, not a shipped feature.

**Cost:**

| | |
|---|---|
| Rounds | 1 |
| Builder tasks | 2 — 1× `standard` (`LibrarySurface.tsx`: run list from `/api/uploads/index`, shots from `/api/uploads/:id/shots`, inline PNG preview from `/api/uploads/:id/:name`, labelled counts, an explicit empty state, render switch, nav), 1× `fast` (label the count honestly at source: return both `runs_with_images` and `directories_total` from `/api/uploads/index`, plus the unit test N2 requires) |
| Reviewers | 1 gating reviewer |
| Migration | **none** |
| Route work | **none for the default** — all three endpoints exist. `+1 standard builder` if Konrad rules "document store" (Drive needs a new `/api/drive/*` route and pagination over 1,000+ items) or "media" (`routes/media.ts` has no browse endpoint and would need one) |

---

## 5. SEARCH  *(the fifth key — and the one whose answer is not "unbuilt")*

### Why it is here

`PLACEHOLDER_SURFACES` holds **ten** keys (`chat, pipeline, library, skills, memory, autonomy, goals,
journal, map, search` — `DesktopApp.tsx:73-188`). The placeholder branch (`DesktopApp.tsx:477-486`)
excludes seven by name, so it actually renders for **five**: goals, journal, map, library **and
search**. `search` is in `SURFACES` (`nav-items.ts:65`) but **not in `NAV`** (`nav-items.ts:78-96`).

### Reachability: settled, with the commands

Full working in `reproduction-before.md` §5. Summary:

```bash
$ grep -rn 'setSurface(' forge-control-web/app/
forge-control-web/app/desktop/DesktopApp.tsx:463:                  setSurface(s);
forge-control-web/app/desktop/DesktopApp.tsx:506:            setSurface(s);
```

**No `setSurface("search")` caller exists.** Every rendering nav maps over `NAV` (rail
`DesktopApp.tsx:997-1001`, top strip `:627`, phone sheet `:781`); the command palette filters `NAV`
(`:1236-1239`); `StatusBar`'s `onNav` literals are `"autonomy"` and `"inbox"` only (`:1168`, `:1185`,
`:1196`); the chat slash-nav whitelist names eight surfaces and `SurfaceKey`
(`chat/slash-registry.ts:28-37`) does not contain `search`; the only global keyboard handler is
⌘K/Escape for the palette (`:275-285`).

**One door is open.** `usePersistentState<Surface>("forge.desktop.surface", "today", isSurface)`
(`DesktopApp.tsx:239-243`) restores any stored value that passes `isSurface`
(`_ui/ResizableSplit.tsx:313-331`), and `isSurface` tests `SURFACES`, which **includes `search`**.
Proven in the browser, not argued — seeded the key, reloaded, and the SEARCH placeholder rendered:

```
{ tagVisible: true, hasNotBuilt: false, bulletCount: 4, storedSurface: "\"search\"" }
```

**Answer: unreachable through every UI affordance; reachable through exactly one non-UI path, a
stored `localStorage` value.** Note the near-miss that makes this easy to get wrong: the header's
`search everything ⌘K` box is **not** this surface — it opens the command palette (`onPalette`), which
navigates and does not search.

### Intended purpose

Quoted verbatim from `PLACEHOLDER_SURFACES.search`, `DesktopApp.tsx:177-187`:

> **tag** `SEARCH`
> **title** "Search the vault, runs, workers, skills, decisions"
> **desc** "Routing hypervisor picks vector / grep / BM25 / SQL per query."
> **items** `search` "multi-engine routing" · `description` "vault hits" · `conveyor_belt` "live runs" ·
> `bolt` "skills + workers + inbox items"

### Current state: **BACKEND BUILT AND LIVE. FRONTEND UNBUILT. UNREACHABLE.**

This is the finding that separates SEARCH from the other four, and it is why it must not receive the
same "not built yet" banner.

```bash
$ head -34 forge-control/src/routes/search.ts
…
/**
 * Routing hypervisor — runs the same query through every engine that can
 * answer it and returns one set of grouped, source-tagged hits.
 *
 *  vault   — semantic vector search via knowledge_embeddings (pgvector cosine)
 *  inbox   — ILIKE over open inbox_items.title + ask
 *  runs    — ILIKE over runs.title + prompt
 *  jobs    — ILIKE over content_jobs.title
 *  decisions — ILIKE over decisions.action
 */

$ grep -n 'search' forge-control/src/index.ts
22:import search from "./routes/search.ts";
112:      "/api/search?q=...",
166:app.route("/api/search", search);
```

The route's own docstring is a near-verbatim restatement of the placeholder copy — "Routing hypervisor"
appears in both. **Somebody built the backend for this surface and the frontend never followed.**

It works right now:

```bash
$ curl -s "http://127.0.0.1:7700/api/search?q=vault" | head -c 300
{"q":"vault","count":9,"groups":[{"key":"runs","label":"Runs","engine":"sql","engine_label":"sql · ilike",
"rows":[{"icon":"conveyor_belt","title":"os-usable-for-work · Phase 4 · B4a — executor-auth determination…",
"meta":"run · running","nav":{"surface":"tasks","id":"ef04f1e2-…"}},…
```

**9 hits, grouped, each row carrying `engine_label` and a `nav` object naming the destination surface
and id.** That payload was shaped for a UI that was never written. And nothing consumes it:

```bash
$ grep -rn "api/search" forge-control-web/ --include=*.ts --include=*.tsx
(no matches)
```

### What it would need

| Piece | Concretely |
|---|---|
| Table | **none** |
| Route | **none — `/api/search` exists, is mounted at `index.ts:166`, is advertised at `index.ts:112`, and returns live grouped results with per-group engine labels** |
| Nav | one line in `NAV` (`nav-items.ts`), the only one of the five that needs a nav entry *added* rather than *marked* |
| Surface | `SearchSurface.tsx` — a query box, grouped results, and `onNav(row.nav.surface)` wired to the `nav` object the API already returns |

### Recommendation: **DEFER the surface, but treat this as a different defect, and tell B3b so**

Three concrete consequences, and the first is a change to phase 3's own work:

1. **B3b must not print "not built yet" on SEARCH.** It is false: the backend is built, mounted and
   answering. The honest copy is *"SEARCH's engine is built and live (`GET /api/search`, multi-engine,
   returning results today). The surface for it was never written, and there is no way to reach this
   screen from the UI — you are seeing it because a stored value put you here. Not scheduled by
   os-usable-for-work."* Applying the four-surface template unmodified would replace one wrong label
   with another, which is exactly the failure 00-vision.md §6 names.
2. **R40's nav marker cannot apply to SEARCH.** There is no nav entry to mark. The four markers go on
   goals/journal/map/library, and that is the correct count for the acceptance criterion "the nav
   marker appears on exactly four entries" (04-phases.md, phase 3).
3. **It is the cheapest surface in the whole product to finish**, and the only one where deferring
   leaves working, paid-for code unreachable. That is worth Konrad knowing even though it is out of
   scope: he asked for a machine he can work in, and a search over vault + runs + jobs + inbox +
   decisions is running behind a door with no handle.

**Cost:**

| | |
|---|---|
| Rounds | 1 |
| Builder tasks | 1× `standard` — `SearchSurface.tsx`, one `NAV` entry, render switch. Optionally 1× `fast` to bind the header's `search everything` box to it instead of (or alongside) the palette, which is a UX decision for Konrad and not mine |
| Reviewers | 1 gating reviewer |
| Migration | **none** · **Route work: none** |

---

## 6. Summary

| Surface | State | Backing route needed | Table needed | Producer exists | Recommendation | Cost (rounds · builders · reviewers) |
|---|---|---|---|---|---|---|
| GOALS | UNBUILT | `routes/goals.ts` | **yes** — `ai_os.goals` | **no** | **DEFER** — and ask whether it should be a vault convention instead of a table | 2 · 3 (2 std, 1 fast) · 1+1 |
| JOURNAL | UNBUILT, ⅔ backed | date range on existing `/api/decisions` | no | **yes** — 120 rows, growing | **DEFER**; if built, drop "auto-written entries" from the copy | 1 · 2 (1 std, 1 fast) · 1 |
| MAP | UNBUILT, ¾ backed | `routes/map.ts` aggregator | no | **yes** — pm2 24, systemd 97, system stats live | **DEFER**; build only after phase 4's probe contract exists | 1 · 3 (2 std, 1 fast) · 1 |
| LIBRARY | UNBUILT | **none** — `/api/uploads/index` exists | no | **yes** — 423 files, 48 dirs, live write path | **DEFER**; default recorded: uploads-backed artefact store | 1 · 2 (1 std, 1 fast) · 1 |
| SEARCH | **backend LIVE**, frontend unbuilt, **unreachable** | **none** — `/api/search` mounted and answering | no | **yes** — 9 hits live | **DEFER**, but its placeholder copy must not say "not built" | 1 · 1 (std) · 1 |

**The pattern worth carrying out of this phase:** only one of the five (GOALS) is genuinely
unbuilt from the ground up. The other four are **surfaces missing from features that already exist**
— a populated decisions table, three live infrastructure probes, a mounted uploads index, and a
working multi-engine search endpoint. The wireframes are not lies about features nobody wrote; three
of them are lies about *where the work stopped*, which is a more expensive kind of lie because it
hides paid-for code.

**What this changes for B3b:** four surfaces take the R38/R39 "not built yet" treatment and the R40
nav marker. SEARCH takes a different sentence (§5, consequence 1) and no nav marker. And the stale
`live in this build:` caption at `DesktopApp.tsx:2858-2864` — which claims five of the fourteen built
surfaces are live and has been wrong since 2026-06-21 — should be **deleted**, not updated;
see `reproduction-before.md` §6.1.
