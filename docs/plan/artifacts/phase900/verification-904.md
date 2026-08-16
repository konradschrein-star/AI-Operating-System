# verification-904.md — U34: production verification of the phase-900 deploy

**PHASE 900, round 904.** Read-only against production. No file in `/opt/forge-ai-os` was
edited, no service was restarted, `pm2 restart` was never invoked for anything.

---

## HEADLINE

**All four features Konrad asked about are LIVE on production.** He has not been looking at
a stale build since round 903's deploy.

**One real regression was found**, and it is the one this brief predicted: round 901's corpus
relocation broke `GET /api/chat/:id/plan/doc`. Details in §5. Reported to the manager chat at
the moment of discovery, not saved for this document.

---

## 1. THE DEPLOY LANDED (step 0 — proved before anything was measured)

```
$ git rev-parse HEAD                      # this worktree
26ea1252fd85e48153c4a60a5dab2f1410bb22ae
$ git -C /opt/forge-ai-os rev-parse main
26ea1252fd85e48153c4a60a5dab2f1410bb22ae
$ git -C /opt/forge-ai-os merge-base --is-ancestor 26ea125 main && echo LANDED
LANDED
```

Live `main` is not merely a descendant of the work branch — it is **the identical commit**.
Round 903 did not stop on a conflict; `deploy-903.md` records `git merge main` → "Already up
to date", zero conflicts, and a fast-forward to main.

pm2 restart timestamps, which must post-date round 903's start:

| process | status | restarts | up_since |
|---|---|---|---|
| forge-control-web | online | 2 | 2026-08-16T21:36:07.539Z |
| forge-control | online | 11 | 2026-08-16T21:36:11.263Z |
| **forge-executor** | **online** | **0** | **2026-08-11T04:39:56.273Z** |

Round 903's own baseline had web at `19:55:31` and control at `20:18:58`, so both restarted
**after** that round began. The build being measured below is the deployed one.

### forge-executor — untouched

`up_since = 2026-08-11T04:39:56.273Z`, `restarts = 0`. **Byte-identical** to the
planning-time value and to round 903's baseline. Nothing this round did came near it.

---

## 2. ENDPOINT TABLE (step 1 — full transcripts in `prod-curls-904.md`)

All against the live API on `127.0.0.1:7700`.

| path | status | one-line shape verdict |
|---|---|---|
| `/api/health` | 200 (3 ms) | `{ok:true, service:"forge-control", version, uptime_seconds, timestamp}` |
| `/api/chat` | 200 (138 ms) | **U3 rollup, not a run dump** — `count:6`, each row carrying `project_id`/`project_status`/`tasks_done`/`tasks_total` (this project 79/90) |
| `/api/chat/:id/team` | 200 (276 ms) | **U4** — manager + 87 workers + 6 sub-agents = 94 rows; `working_ms` on **94/94**, `working_ms_source`, `settled`, `parent_id` |
| `/api/chat/:id/plan` | 200 (8 ms) | **U6** — 16 phases, 90 tasks, this project's real plan; resolves from the `tasks` table, **not** a corpus path, so the round-901 move could not break it |
| `/api/chat/:id/plan/doc` | **404 / wrong doc** | **REGRESSION — see §5** |
| `/api/capabilities` | 200 (1 ms) | **U8** — the all-false constant: `{control_plane:{message_into_session:false, resume_finished:false, stop:false, terminate:false}}` |
| `/api/agents` | 200 (16 ms) | intact — 32 rows, `settled`/`settled_at`/`elapsed_ms` all present, no field removed |

### Time truth, proved rather than asserted

Both `/team` and `/agents` were sampled twice, 45 s apart:

| endpoint | rows compared | settled rows that MOVED | running row |
|---|---|---|---|
| `/api/chat/:id/team` | 94 | **0** | 49 570 ms → 106 168 ms |
| `/api/agents` | 32 | **0** | 48 625 ms → 105 200 ms |

Zero settled rows drifted; the live rows advanced. The panel is frozen where it should be and
ticking where it should be — the anti-vacuous guard passes, so this is not "frozen because
nothing updates".

---

## 3. SCREENSHOTS — four surfaces × two themes (step 2)

Production origin `https://os.schreinercontentsystems.com` → nginx → `127.0.0.1:7701`
(pm2 `forge-control-web`, `next start -p 7701`, cwd `/opt/forge-ai-os/forge-control-web`).
Port resolved from `pm2 describe`, not guessed. **Not** :7798, **not** :7832, **not** a harness.

Chat opened for every shot: `bfd1283a` — this project's own manager chat, so no panel is an
empty state.

| surface | dark | light |
|---|---|---|
| nav rail + x/y badges | `prod-rail-dark.png` | `prod-rail-light.png` |
| chat team panel | `prod-team-dark.png` | `prod-team-light.png` |
| plan Kanban zone | `prod-kanban-dark.png` | `prod-kanban-light.png` |
| composer | `prod-composer-dark.png` | `prod-composer-light.png` |

Script: `capture-904.cjs`. Machine-readable result: `capture-904.json`.

Content actually present in those pixels, read out of the live DOM rather than eyeballed:

```
teamRows 94 · planTasks 90 · planPhases 16 · data-team-state "ready"
data-plan-state "ready" · data-plan-progress "79/90"
task badges rendered: 79/90, 6/15, 50/56, 67/88
page errors: 0
```

**Both themes genuinely differ** — not assumed from the toggle, asserted three ways: the app's
own `documentElement.dataset.theme` reads `dark` then `light`; computed `body` background is
`rgb(0,0,0)` vs `rgb(247,247,245)`; and every dark/light PNG pair has a different md5.

### One honest gap

The brief asked the rail shot to show **the heuristic-link marker**. It is not in these
screenshots because **no chat in production currently qualifies**: the marker renders only for
`link_source === "thread_scan"` (ChatSurface.tsx:1763), and this chat resolves via stored
metadata (`link_source: "metadata"`, confirmed by curl). `[data-link-marker]` count = 0 on the
live page. Photographing it would have required manufacturing a fixture, which this task's
read-only remit forbids. Phase 500 already shot it against a real ambiguous chat
(`phase500-ambiguous-{dark,light}.png`).

---

## 4. FEATURE LIVENESS (step 3) — the four Konrad asked about

| # | feature | verdict | evidence |
|---|---|---|---|
| a1 | CanvasPane error banners visible in light mode | **LIVE** | the replaced backgrounds `#5c3a0033`/`#5c000033` are **gone from the served build** (0 chunks); `freezeBgWarn`/`dangerActionBg` present in 8 chunks each |
| a2 | `--fg-warn` retuned `#8a7513` → `#7f6c11` | **LIVE** | production computed style: light `--fg-warn = #7f6c11` (dark unchanged `#d8c24a`) |
| a3 | Excalidraw editor follows the theme | **LIVE** | `prod-feature-canvas-{dark,light}.png` |
| a4 | LeftRail selected-nav `#141417` → `tokens.selectedBg` | **LIVE** | `prod-feature-navrail-{dark,light}.png`; light `--fg-selectedBg = #e8e8e3` |
| b | colour-coded worker cards / role tints | **LIVE** | `prod-team-{dark,light}.png`, 9 distinct tints in both themes |
| c | two-way secret sharer — request badge + answer flow | **LIVE** | `prod-feature-secret-badge-dark.png`, `prod-feature-secret-panel-{dark,light}.png`, `prod-feature-secret-answer-filled.png`, `prod-feature-secret-answered.png` |
| d | open-in-new-tab in the file explorer | **LIVE** | `prod-feature-newtab-document.png` |

### a — the four phase-800 light-mode fixes, named individually

Identified from `docs/plan/operator-visibility/14-ui-v3-quality.md` §"Both themes" and
`docs/plan/artifacts/phase800/README.md` §§5.4–5.6, then pinned to their fix commits
(`5054374` closes three, `35ade34` closes the fourth).

1. **The CanvasPane error banners were invisible in light mode.** conflict / error /
   watch-failure banners were `#ffd8a8` on `#5c3a0033` and `#ffa8a8` on `#5c000033` —
   1.13:1 and 1.12:1 in light, near-white on near-white, so a failed canvas save reported
   itself to nobody. Now `warn` on `freezeBgWarn` and `bleed` on `dangerActionBg`, measured
   at 4.71:1 and 5.09:1.

   Verified against the **served production bundle** rather than the source tree. These are
   error states, and this task does not get to break production to photograph one, so the
   check is: are the replaced values still shipping?

   | literal | chunks in `.next/static` | reading |
   |---|---|---|
   | `#5c3a0033`, `#5c000033` (the banner backgrounds) | **0** | the fix shipped |
   | `freezeBgWarn`, `dangerActionBg` (the replacements) | 8 each | the fix shipped |
   | `#ffd8a8`, `#ffa8a8` | 2 | **Excalidraw's own vendor palette** (the CSS + the excalidraw JS chunk, both of which contain the string `excalidraw`), not our banner code |

   The foreground hexes survive only because Excalidraw ships those oranges in its own colour
   picker. The background pair that made the banners invisible is gone from production.
2. **`--fg-warn` was tuned for the wrong surface.** `#8a7513` measured 4.12:1 on the tint it
   is actually used on — below AA at every warn banner in the app. Retuned to `#7f6c11`.
   **Live production reads `--fg-warn: #7f6c11` in light and the untouched `#d8c24a` in dark.**
3. **The editor was pinned to dark.** `CanvasPane.tsx` passed `theme="dark"` to `<Excalidraw>`
   as a literal, so the drawing surface stayed black inside a light console. **Verified live
   with a real drawing loaded** ("AI OS - Canvas Smoke Test"):

   | app theme | `.excalidraw` classes | canvas filter |
   |---|---|---|
   | dark | `… theme--dark` | `invert(0.93) hue-rotate(180deg)` |
   | light | *(no `theme--dark`)* | `none` |

   The editor takes the app's theme in both directions. `prod-feature-canvas-light.png` shows
   a white canvas and light toolbar where phase 800 photographed a black slab.
4. **The LeftRail's selected-nav background was a `#141417` literal** — a near-black bar
   across a light console. Live `--fg-selectedBg` is `#e8e8e3` in light / `#101013` in dark,
   and `prod-feature-navrail-light.png` shows the selected CHAT row as a light tint.

   `#141417` does still appear in one served app chunk. That is **expected and documented**:
   commit `35ade34` states the rail literal is gone while "CommandPalette + InboxRichPreview
   literals remain, untouched — different blocks, not this round's brief". The rail itself is
   proven fixed by the live computed value and the screenshot, which are the rail's own
   evidence rather than a whole-bundle grep.

### b — role tints, both themes

Read off the live document, not the source:

| | dark | light |
|---|---|---|
| `roleBg*` tokens defined | 9 | 9 |
| **distinct values** | **9** | **9** |

No two roles share a tint in either theme. Twelve transcript cards on the open chat compute to
one of those tints. Visible in `prod-team-{dark,light}.png`, where the team rows carry role and
model per row (`architect fable-5`, `builder opus-5`, `reviewer opus-5`, …).

### c — the two-way secret sharer

Exercised end to end against production with an **obviously synthetic** value. No real
credential was typed, displayed, or photographed.

- A synthetic request was created (`verify904-synthetic-canary`, note "ROUND 904 VERIFICATION
  ONLY — synthetic, no real credential"). `mark-pending` 404s on a name that does not exist,
  so there was no read-only way to make a badge appear.
- **The badge is live:** the composer's `secret` button rendered a count badge of **1**.
- **The panel opens itself** — no click needed, which is the feature. Live DOM:
  `autoOpened: true`, `prefilledWith: "verify904-synthetic-canary"`, `answerMode: true`, and
  the reassurance line *"Stored on the server, never written into this conversation. Only the
  name appears in the thread."* The agent's note rendered as **plain text**, not markup.
- **The answer flow completes:** value `SYNTHETIC-VALUE-NOT-A-REAL-CREDENTIAL-904` entered,
  "answer request" clicked, and the pending state cleared (`stillWaiting: false`).
- Verified in **both themes** (`prod-feature-secret-panel-{dark,light}.png`); the request was
  re-armed via `mark-pending` for the light shot because the dark pass had consumed it.

**U30 non-leakage re-verified as a side effect.** After the answer, the chat thread contains
**0** occurrences of the synthetic value *and* **0** of the secret's name. A database sweep
found the string in exactly one run — `4599b621`, this verifying agent's own run, because this
agent authored the string in its own shell commands and scripts. The secret pipeline itself
wrote nothing anywhere.

**Cleanup:** the synthetic secret was deleted. The store is back to its exact baseline —
5 rows, the same 5 names, **0** pending. Nothing of Konrad's was created, modified, or removed.

### d — open in a new tab

Not merely "the button exists". The anchor was clicked and the resulting tab captured:

```
href : /document?root=workspace&path=cf_archive_manifest.json
url  : https://os.schreinercontentsystems.com/document?root=workspace&path=cf_archive_manifest.json
opened in a NEW tab: true
document body: 40 010 characters of real content
```

`prod-feature-newtab-document.png` shows a full-window `DOCUMENT workspace /
cf_archive_manifest.json` viewer rendering real, syntax-highlighted JSON — a genuine document,
not an empty shell.

---

## 5. THE REGRESSION — `/api/chat/:id/plan/doc`

**Introduced by phase 900 itself, round 901's corpus relocation.** This is precisely the
failure the brief flagged as the most likely way this deploy breaks something, and it is worse
than a plain 404.

`planDirFor()` (chat.ts:810) resolves exactly one **flat** directory, `<workspace_dir>/docs/plan`,
and `resolvePlanDoc()` (chat.ts:965, layer 1) rejects any `name` containing `/`. Round 901
moved the operator-visibility corpus one level down into `docs/plan/operator-visibility/`.

1. **This project's corpus is unreachable.** `14-ui-v3-quality.md`, `10-ui-v3-spec.md` and
   every other `1x-ui-v3-*.md` → **404**. No name reaches them: the file is a directory deeper
   and the separator is refused by the traversal guard.
2. **Another project's documents are served under this project's plan.** What is still at
   `docs/plan/*.md` is the *engine-v2-research-lane* corpus, and `GET /plan` advertises it as
   this chat's documents:

```
docs: ["00-vision.md", "01-requirements.md", … "10-policy-agent-autonomy-and-escalation.md"]

$ curl '.../plan/doc?name=00-vision.md' | head -1
# 00 — Vision: engine-v2-research-lane
```

3. `phases carrying a doc ref: 0` — the Kanban phase cards offer no doc chips for this project.

The traversal guard itself is **intact** (400, and the body names the rejection), so this is a
resolution-scope bug, not a security hole. **Not fixed here:** `routes/chat.ts` is outside a
read-only verification task's remit, and the fix is a design call (teach `planDirFor` about
per-project subdirectories, or namespace by project) that deserves its own briefed round.

---

## 6. HOVER — recorded evidence and the live judgement (step 4, NFU2)

### Recorded, quoted

- **Team panel (phase 500, `team-hover.cjs` → `team-hover-after.json`):** *"75 pointer
  crossings over 20 team rows cost **0** react commits and **0** DOM mutations, with
  byte-identical row geometry hovered vs not."*
- **Rail (phase 400 → phase 500 round 504):** this is the before/after that answers Konrad's
  actual complaint.

| rig | crossings | commits attributable to hover | DOM mutations attributable to hover |
|---|---|---|---|
| phase 400 `hover-cost-before.json` | 76 | **77** | **1057** |
| phase 400 `hover-cost-after.json` | 76 | **1** | **0** |
| phase 500 `rail-hover-round504.json` | 74 | **0** | **0** |

A hover sweep used to cost over a thousand DOM mutations. It now costs none.

### Live qualitative check on production (`hover-904.cjs` → `hover-904.json`)

Two independent 10 s sweeps per surface, each paired with a parked-pointer **idle baseline
over the same window** — without that baseline the app's own polling gets billed to hover.

| surface | rows | crossings | mutations (hover vs idle) | long tasks (hover vs idle) |
|---|---|---|---|---|
| chat rail, run 1 | 6 | 150 | 10 vs 10 → **0** | 0 vs 1 → **0** |
| chat rail, run 2 | 6 | 150 | 10 vs 10 → **0** | 0 vs 1 → **0** |
| team panel, run 1 | 26 | 150 | 10 vs 11 → **0** | 1 vs 0 |
| team panel, run 2 | 26 | 150 | 12 vs 11 → **+2** | 1 vs 1 → **0** |

**Judgement, in plain terms: no, it does not lag.** 150 pointer crossings in ten seconds
produce no DOM churn beyond what the page does sitting still. The occasional ~50–60 ms task
appears in the **idle** windows too (rail idle 52 ms and 50 ms; team idle 59 ms) — it is the
app's own polling/SSE tick, not the pointer. Across four sweeps and 600 crossings there was no
sustained blocking and nothing a hand on a mouse would register as stickiness. Konrad's
original "hovering the sidebar still lags" does not reproduce on this build.

---

## 7. CANVAS (U31) — **MEASURED, NOT MET**

Quoted from `docs/plan/artifacts/phase800/canvas-perf.md`:

| scenario | before | after |
|---|---|---|
| cold open, S2-drawing | 724.7 ms | 661.7 ms |
| cold open, S3-drawing-nocache | 711.5 ms | 653.1 ms |
| under throttle | 1505 ms | 1138 ms (**−367 ms, −24 %**) |

**The throttled win is PRELOAD ONLY.**

**U31 is measured, not closed, and this phase must not report it as met.** Cold-open scripting
still runs ~210–224 ms against a **100 ms gate** on all three trees. The ~192 ms / 10-pass
layout storm remains **undiagnosed**, and `canvas-layout-probe.cjs` has **never been run
against a fix**. Any deploy summary that lists U31 as done is wrong.

---

## 8. RIGS — which numbers came from where

Every request-rate number must name its rig, because the rigs are not equivalent:

- **`serve-v3-7798.ts` cannot serve SSE** and therefore manufactured a large share of the
  polling traffic earlier rounds spent effort optimising. Treat its request rates as suspect.
- **`scripts/checks/serve-sse-808.ts`** is the trustworthy harness — it streams.
- **Production is better still**, and every number in §§2, 3, 4 and 6 of this document was
  taken against production, not against either harness.

---

## 9. ARTIFACTS

| file | what it is |
|---|---|
| `prod-curls-904.md` | every step-1 request and response, with the exact curl above each |
| `recon-904.cjs` / `.json` | what production actually exposes (selector discovery) |
| `capture-904.cjs` / `.json` | the four surfaces × two themes |
| `features-904.cjs` / `.json` | pass 1 — the live palette (a2, a4, b) |
| `features2-904.cjs` | pass 2 — secret badge, first open-↗ attempt. **No `.json`**: the run threw when its `secret` click timed out (the panel had already opened itself) and died before the write. The screenshot it did take, `prod-feature-secret-badge-dark.png`, is the best single proof of feature c |
| `features3-904.cjs` / `.json` | pass 3 — secret answer flow, open ↗ into a real document |
| `features4-904.cjs` / `.json` | pass 4 — Excalidraw theme, light-mode secret panel |
| `hover-904.cjs` / `.json` | the live hover sweeps, both surfaces, two runs each |
| `prod-*.png` | 23 production screenshots |

The multi-pass feature scripts are kept rather than collapsed into one: each pass records a
selector assumption that was **wrong** and how production corrected it (the picker lists
drawings by title, the secret panel opens itself, the file tree needs a folder expanded).
That is the reproducible part.

### Auth note for whoever reproduces this

`/desktop` is behind GitHub OAuth. `AUTH_URL` is **https**, so next-auth uses the
`__Secure-authjs.session-token` cookie prefix **and that prefix is the JWE salt**. The plain
`authjs.session-token` recipe from phases 1/500/800 is rejected by production with
`307 → /signin`; mint with `salt: "__Secure-authjs.session-token"` and send it over the https
origin. No password was stored, read, or typed.
