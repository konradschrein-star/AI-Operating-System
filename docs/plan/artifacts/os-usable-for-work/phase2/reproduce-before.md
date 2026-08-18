# The memory surface, before any change (R21) — reproduced, photographed, measured

**Task:** `B2a` (phase 2, workstream `vault`) · **Captured:** 2026-08-18T23:35:58Z
**Tree:** `project/7851068b-vault` @ `c0615ae` · **No source file was changed by this task.**
**Auth:** `browser-harness.mjs`, `--wait-until commit`, exit 0 — the `/signin` assertion cleared on
every run below. Nothing here was screenshotted past a failed wall check.

---

## 0. The one thing a reader must know before believing any number on these screenshots

**The web app you are looking at is this worktree's build, but the API behind it is the LIVE
forge-control on `:7700`, which predates phase 1.**

`next.config.mjs:7` bakes the proxy target at **build** time:

```js
const FORGE_CONTROL = process.env.FORGE_CONTROL_URL ?? 'http://127.0.0.1:7700';
{ source: '/api/proxy/:path*', destination: `${FORGE_CONTROL}/api/:path*` }
```

Nothing has deployed (deploy is phase 7), so `:7700` still runs the **pre-`B1c`** `noteCounts()`. The
consequence is specific and it changes what B2d must reproduce:

| | counts rail renders | why |
|---|---|---|
| **What these screenshots show** | **`287 notes`**, chips `0/0/2/0/0/285` | live `:7700`, which still returns a bare `all` key |
| **What HEAD would render** | **`0 notes`**, all seven chips `0` | `B1c` removed `all`; `MemorySurface.tsx:176` reads `counts.all ?? 0` |

Both are measured below (§3). Neither is a guess. A reviewer who re-runs my browser commands and sees
`287 notes` has **not** refuted `phase2-plan.md` §2.3 — they have hit the proxy target.

---

## 1. The three screenshots (R21)

All three are committed next to this file and were Read back during the run that produced them.

| artefact | what a reader should see |
|---|---|
| [`before-note-view.png`](./before-note-view.png) | The memory surface with a **real vault note open** — `Daily/2026-08-19.md`, 2 619 words, rendered in the right-hand reader with its four `[[wikilinks]]` at the foot. Fonts reachable, so this is the surface as Konrad's looks when nothing interferes: icons are icons. The `Open in Obsidian` control sits at the top-right of the reader header — it looks exactly like a button and is a `<div>` (§2). |
| [`before-counts-rail.png`](./before-counts-rail.png) | The counts rail, clipped and rendered at 3× so 9–10 px type is legible: `Obsidian vault` / `287 notes` / a `Vault \| Agent` toggle / `All 287`, `Rules 0`, `Preferences 0`, `Facts 2`, `People 0`, `Projects 0`, `Notes 285` / `3D net`. **Four of the six categories read `0`.** This is Konrad's *"it's zero and not eight"*, photographed. |
| [`before-graph-tab.png`](./before-graph-tab.png) | The 3D graph tab: an entirely black canvas with one small badge reading **`0 entities · 0 relations`**, and the hint `Left-click: rotate, Mouse-wheel/middle-click: zoom, Right-click: pan` at the foot. No nodes, no error, no explanation. |

One further screenshot is committed and is **outside my declared write-set** — see §6:

| artefact | what a reader should see |
|---|---|
| [`before-fonts-blocked-note-view.png`](./before-fonts-blocked-note-view.png) | The identical URL and build with `fonts.googleapis.com` unreachable: `hub Obsidian vault`, `graph_3 3D net`, `settings SETTINGS`, `description Vault › Daily/2026-08-19.md`, `open_in_new Open in Obsidian`, `search search everything`, `light_mode` spilling off the right edge. This is the "weird font" failure mode, and it is the evidence `font-measurement.md` §5 reports from. **Third-party blocking is the harness's DEFAULT** (`browser-harness.md` §5, Failure 5) — this image is a deliberate simulation, not the VPS's own behaviour today. |

Commands that produced them, and the DOM dump:

```bash
# server started and driven in ONE bash invocation (harness §5, Failure 7)
(cd forge-control-web && setsid nohup bash -c 'set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a;
  AUTH_URL=http://127.0.0.1:7791 NEXTAUTH_URL=http://127.0.0.1:7791 \
  exec ./node_modules/.bin/next start -p 7791' > /tmp/next-7791.log 2>&1 < /dev/null &)

node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7791 --path /desktop --wait-until commit --quiet \
  --cookie-out /tmp/b2a-cookie.txt --shot "$UP/20260818T233558Z-harness-wall-cleared.png"
# HARNESS EXIT=0  ok=true          ← the /signin assertion, cleared

node /tmp/b2a-memory-drive.mjs --base http://127.0.0.1:7791 --cookie-file /tmp/b2a-cookie.txt \
  --allow-external --viewport 1600x2200 \
  --shot "$UP/20260818T233558Z-before-note-view.png" \
  --dump-html /tmp/b2a-before-dom-note-view.html --out /tmp/b2a-allowed.json          # EXIT=0

node /tmp/b2a-memory-drive.mjs ... --clip 188,50,186,336 --scale 3 \
  --shot "$UP/20260818T233558Z-before-counts-rail.png"                                 # EXIT=0

node /tmp/b2a-memory-drive.mjs ... --click-nav "3D net" \
  --shot "$UP/20260818T233558Z-before-graph-tab.png"                                   # EXIT=0

node /tmp/b2a-memory-drive.mjs ... --viewport 1600x2200 \
  --shot "$UP/20260818T233558Z-fonts-blocked-note-view.png"    # harness default: BLOCKED, EXIT=0
```

`--viewport 1600x2200` rather than `--full-page`: the desktop shell scrolls internally, so a full-page
shot equals the viewport.

**Why a driver at all.** `browser-harness.mjs` evaluates `--eval` **after** the screenshot
(`browser-harness.mjs:533` vs `:546`), so it cannot select a surface held behind a `localStorage` key
(`DesktopApp.tsx:239`, `"forge.desktop.surface"`) before it shoots. `/tmp/b2a-memory-drive.mjs` mints
nothing — it consumes the token `--cookie-out` already produced and re-asserts `/signin` itself (exit 2,
no screenshot written). **Suggested harness improvement for the integration task: an `--init-script` /
`--local-storage` flag** (`browser-harness.md` §7). The harness was not forked or edited.

---

## 2. The Obsidian control (R25, R26, R27) — proven from the DOM, not from the source

`--dump-html` wrote 53 364 bytes to [`before-dom-note-view.html`](./before-dom-note-view.html).
`03-quality.md` §1.5 requires exactly this: a DOM dump showing no handler. Here is the element,
**verbatim from the dump**:

```html
<div style="display: flex; align-items: center; gap: 5px; cursor: pointer;
            border: 1px solid var(--fg-invariantBorder); border-radius: 6px;
            padding: 4px 9px; background: rgb(14, 12, 20);">
  <span class="ms"   style="font-size: 13px; color: var(--fg-decide);">open_in_new</span>
  <span class="mono" style="font-size: 10px; color: var(--fg-decide);">Open in Obsidian</span>
</div>
```

A plain `<div>`. `cursor: pointer`. **No `href`, no `onclick`, no `role`, no `tabindex`, no `title`, no
element of any kind that could carry a target.** It is not inside an `<a>`. Exactly as
`MemorySurface.tsx:803-829` reads, now confirmed against what the browser actually built.

Counted over the whole dump:

```bash
$ python3 -c "h=open('/tmp/b2a-before-dom-note-view.html').read(); \
  print('bytes', len(h)); \
  [print(repr(p), h.count(p)) for p in ['Open in Obsidian','open_in_new','obsidian://','vault=','onclick=','Copy path','copy path']]"
bytes 53364
'Open in Obsidian' 1
'open_in_new'      1
'obsidian://'      0      ← the URI R18/R25 requires appears NOWHERE in the rendered document
'vault='           0
'onclick='         0
'Copy path'        0
'copy path'        0
```

R26 and R27, answered from the same dump by an in-page probe:

| question | answer | evidence |
|---|---|---|
| Is there any caveat text on screen? (R26) | **No** | `/obsidian-vault\|vault name\|Vault:/i` against `document.body.innerText` → `false`. The only "Vault" strings on screen are the `Vault \| Agent` source toggle and the breadcrumb `Vault › Daily/2026-08-19.md` — neither is a precondition. |
| Is the vault name shown? (R26) | **No** | `vault=` occurs 0 times; no vault name renders anywhere. |
| Is there a copy-path affordance? (R27) | **No** | `/copy path/i` → `false`; 0 occurrences in the dump. |

**Expected no, no, no. Measured no, no, no.** The control is decorative: it presents as a button,
carries a `cursor: pointer` that promises a click, and does nothing at all.

---

## 3. The counts rail (R28, R29)

### 3.1 What it renders, quoted

From the rendered surface (`before-counts-rail.png`, and the in-page probe):

```
Obsidian vault
● 287 notes
[ Vault ] [ Agent ]
  ● All            287
  ● Rules            0
  ● Preferences      0
  ● Facts            2
  ● People           0
  ● Projects         0
  ● Notes          285
[ 3D net ]
```

Bare integers scraped from the surface — R28's failure condition is *"a bare integer survives
anywhere"*, and eight do:

| value | element | container text |
|---|---|---|
| `287` | `span.mono` | `All287` |
| `0` | `span.mono` | `Rules0` |
| `0` | `span.mono` | `Preferences0` |
| `2` | `span.mono` | `Facts2` |
| `0` | `span.mono` | `People0` |
| `0` | `span.mono` | `Projects0` |
| `285` | `span.mono` | `Notes285` |
| `30` | `span.mono` | `Memory30` (the surface's own header badge) |

Only `287 notes` carries a unit. **None of the eight carries a source** — nothing on screen says
whether `287` counts files on disk, rows in `hcp.knowledge_note`, or the union with agent briefs. R29's
vault/agent split exists as a *filter* (the `Vault | Agent` toggle) but the two figures are never shown
together, so Konrad cannot see that 287 are his notes and 198 are agent briefs.

### 3.2 The live envelope, for comparison (read-only GETs, as briefed)

```bash
$ curl -s http://127.0.0.1:7700/api/memory/counts | jq
{ "all": 485, "rule": 0, "pref": 0, "fact": 2, "person": 0, "project": 0, "note": 483 }

$ curl -s 'http://127.0.0.1:7700/api/memory/counts?source=vault' | jq
{ "all": 287, "rule": 0, "pref": 0, "fact": 2, "person": 0, "project": 0, "note": 285 }
```

The surface defaults to `source=vault`, which is why the rail reads `287` and not `485`. **Konrad's
"it's zero and not eight" is reproduced exactly**: `rule`, `pref`, `person` and `project` are `0` at the
API and `0` on screen, for the reason `00-vision.md` §2.3 gives — `inferCategory()` matches frontmatter
tags the vault does not use.

*(These figures have drifted from `00-vision.md` §2.3's `all: 482 / vault 284` because the vault is
live and agents write to it constantly; the shape is identical.)*

### 3.3 The regression the plan predicted, confirmed at HEAD by a different instrument

`phase2-plan.md` §2.3 predicts the rail reads **`0 notes`** at HEAD. The browser cannot show that (§0 —
it is talking to `:7700`), so I called the worktree's own function directly:

```bash
$ cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ ./node_modules/.bin/tsx ./b2a-headcounts.ts     # imports noteCounts() from src/db/memory.ts
TOP-LEVEL KEYS AT HEAD: agent_notes, embedded_chunks, embedded_files, excluded, folder_counts,
                        folder_rule, measured_at, source, stale_embedding_rows,
                        vault_files_on_disk, vault_notes_indexed
HAS 'all' KEY: false
{
  "vault_files_on_disk": 287, "vault_notes_indexed": 287, "agent_notes": 198,
  "embedded_files": 261, "embedded_chunks": 2173,
  "excluded": { "excalidraw": 15, "empty": 10, "frontmatter_only": 1 },
  "stale_embedding_rows": 1, "measured_at": "2026-08-18T23:38:23.138Z", "source": "all",
  "folder_counts": { "ops": 147, "(root)": 70, "90_AI_OS": 56, "30_YouTube": 54, "tech": 50,
                     "20_Coding": 49, "AI OS": 20, "Excalidraw": 14, "Daily": 11, "Mentor": 8,
                     "Inbox": 2, "_Templates": 2, "content": 1, "How to price info": 1 },
  "folder_rule": "first \"/\"-separated segment of vault_path; a note with no \"/\" is counted under \"(root)\". Scope: all hcp.knowledge_note rows (vault-sync files and worker briefs)."
}
```

*(The scratch file was written into `forge-control/`, run, and deleted in the same invocation; it is not
in the commit — `git status --short` is clean of it.)*

**`HAS 'all' KEY: false`, and no `rule`/`pref`/`fact`/`person`/`project`/`note` keys either.** So at HEAD:

- `MemorySurface.tsx:107` — `countsQ.data ?? { all: allNotes.length }` — resolves to the *real* payload
  (the fallback never fires, because the request succeeds), and that payload has no `all`.
- `MemorySurface.tsx:176` — `` `${counts.all ?? 0} notes` `` → **`0 notes`**.
- `MemorySurface.tsx:261` — `counts[c.key] ?? 0` → **`0` on all seven chips**, including `All` and
  `Notes`, which today read `287` and `285`.

`phase2-plan.md` §2.3 is **confirmed**. It is a live regression at HEAD, invisible until deploy, and
B2d owns it. Note the shape B2d must bind to: the new envelope is `vault_files_on_disk` /
`vault_notes_indexed` / `agent_notes` / `embedded_files` / `folder_counts` — labelled, sourced, and
carrying `folder_rule` and `measured_at`, which is what R28 and R29 want.

---

## 4. The graph (R33, R34, R35)

### 4.1 The endpoint, verbatim

```bash
$ curl -s http://127.0.0.1:7700/api/memory/graph | jq
{
  "nodes": [],
  "links": [],
  "triples": 0
}
```

Three keys. **No `source` field** (R33 requires the literal `"knowledge_note.links"`), **no
`empty_reason`** (R35), **no counts object**, nothing naming the table read or the rows found.

### 4.2 What the tab renders — and the empty-state string does NOT appear

`MemoryGraph3D.tsx:163-167`:

```tsx
{dataQ.isLoading
  ? "weaving the net…"
  : stats
    ? `${stats.nodes} entities · ${stats.links} relations`
    : "no graph yet — index the vault"}
```

**Measured on screen: `0 entities · 0 relations`.** The string `"no graph yet — index the vault"` never
renders, and this is a finding that changes B2e's work:

`stats` is `useState<{nodes,links} | null>(null)` (`:38`) and is set to
`setStats({ nodes: data.nodes.length, links: data.links.length })` (`:122`) once the force-graph mounts.
With an empty-but-valid payload that is `{nodes: 0, links: 0}` — **truthy** — so the ternary takes the
middle branch. The `"no graph yet"` fallback is reachable only when the effect never ran at all
(no data, or a mount failure).

`00-vision.md` §2.2 says *"the component's empty state (`MemoryGraph3D.tsx:167`) already says 'no graph
yet — index the vault'. It is telling the truth and being ignored."* **The component is telling the
truth about the data — `0 entities · 0 relations` is exactly correct — but it is not saying that
sentence, and the pre-fix state is worse than the corpus records:** the operator sees a black void and
a pair of zeros, with no table named, no row count, and no suggestion of what would populate it.
R35's stated failure condition ("the generic 'no graph yet — index the vault' survives") therefore
cannot be tested as written — there is nothing generic to survive, only two bare integers.

### 4.3 The plain statement

**The component is telling the truth and the table behind it is empty.** `knowledgeGraph()`
(`db/memory.ts`) selects from `content_forge.knowledge_triples`, which holds **0 rows**, and nothing
refills it (`00-vision.md` §2.2). `3d-force-graph@^1.77.0` and `three@^0.185.0` are installed and the
canvas mounts — the graph *renders*; it renders nothing, because there is nothing. **B1's premise that
the 3D graph is a rendering defect is false, and this screenshot is the proof.** The fix is B2b's:
repoint the endpoint at `hcp.knowledge_note.links` and give it `source`, `counts` and `empty_reason`.

---

## 5. Everything measured here, in one table

| claim | measured | instrument |
|---|---|---|
| `/signin` assertion cleared on every run | yes, 5 of 5 | `browser-harness.mjs` exit 0 / driver exit 0 |
| A real note opens by default | `Daily/2026-08-19.md`, 2 619 words | `before-note-view.png`, DOM dump |
| "Open in Obsidian" has a handler | **no** — 0 `onclick`, 0 `href`, 0 `obsidian://` | `before-dom-note-view.html` |
| Caveat text / vault name / copy-path on screen | **no / no / no** | in-page probe over `body.innerText` |
| Counts rail (against live `:7700`) | `287 notes`; `0/0/2/0/0/285` | `before-counts-rail.png` |
| Counts rail (at HEAD) | would be `0 notes`, all chips `0` | `noteCounts()` via `tsx` — no `all` key |
| Bare integers on the surface | **8** | in-page scrape |
| `GET /api/memory/graph` | `{"nodes":[],"links":[],"triples":0}` | `curl` |
| Graph tab on screen | `0 entities · 0 relations`, black canvas | `before-graph-tab.png` |
| `"no graph yet — index the vault"` renders | **no — unreachable with empty-but-valid data** | `MemoryGraph3D.tsx:38,122,163-167` |
| Fonts, third-party allowed | all three render; icons are icons | `font-measurement.md` §3 |
| Fonts, third-party blocked | all three fall back; **8/8 icons render as literal words** | `font-measurement.md` §5 |

---

## 6. Write-set disclosure

Declared: `phase1-verdict-observed.md`, `reproduce-before.md`, `font-measurement.md`,
`before-note-view.png`, `before-counts-rail.png`, `before-graph-tab.png`, `before-dom-note-view.html`.

**Written and NOT declared — one file:**

- **`before-fonts-blocked-note-view.png`.** Task 3(f) of the brief requires *"Screenshot the evidence
  either way"* for the Material Symbols ligature question, and that evidence is the blocked-condition
  render. `/opt/ai-os/uploads` is explicitly not permanent, so leaving it there would have left
  `font-measurement.md` §5 — the section the self-host conclusion rests on — citing an image that
  disappears at the next reboot. It is inside the permitted directory
  (`docs/plan/artifacts/os-usable-for-work/phase2/`) and touches no source file.

Nothing else was written anywhere. The interaction driver lives at `/tmp/b2a-memory-drive.mjs` and the
`noteCounts` scratch file was deleted in the invocation that ran it; neither is in the repo.
