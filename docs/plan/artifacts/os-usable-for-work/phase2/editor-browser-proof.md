# The editor, the conflict, the Obsidian control and the counts — proved in a real browser

**Tasks:** `B2d` + `B2e` (phase 2, workstream `vault`) · **Executed:** 2026-08-19T02:00Z – 02:10Z
**Commits:** `5fc2367` (MemorySurface), `9c395ec` (MemoryGraph3D)
**Requirements demonstrated:** R22, R23, R24, R25, R26, R27, R28, R29, R32 · plus B2e's R33/R34/R35

> **NO SAVE CLICK IN THIS DOCUMENT TOUCHED `/opt/obsidian-vault`.** Every write landed in
> `/tmp/b2d/obsidian-vault`. §1 is the recipe that guarantees it, and it is the first thing to
> re-run.

---

## 1. The throwaway stack — re-runnable, and why each piece is there

`next.config.mjs` bakes the `/api/proxy/*` rewrite target **at `pnpm build` time**, defaulting to the
live forge-control on `:7700`. A throwaway `next start` therefore reads — and would **write** — the
real vault. Setting `FORGE_CONTROL_URL` at `next start` changes nothing.

### 1.1 A sandbox vault that is not the fixture, and why

`03-quality.md` mandates a fixture vault for lane-1 tests. I used the fixture **and** something
larger, for a reason that only appears when you drive the UI rather than the library:

**the note list comes from Postgres (`hcp.knowledge_note`), not from disk.** A fixture vault holds
seven files that no `knowledge_note` row points at, so the UI would list 288 live notes and be unable
to open any of them — every `GET /vault/file` a 404. The proof would have tested nothing.

So the sandbox is a **full copy of the vault's 288 `.md` files** plus the fixture tree under
`Fixture/`, and the live databases are read as-is. The scope-widening note asked for exactly this
(*"verify against the live index, not a fixture"*) and it composes: real rows, real paths, real
`obsidian_uri`, real counts — and every byte written goes to `/tmp`.

```bash
mkdir -p /tmp/b2d/obsidian-vault /tmp/b2d/snapshots
cd /opt/obsidian-vault && find . -name '*.md' -not -path './.*' -print0 \
  | tar --null -T - -cf - | (cd /tmp/b2d/obsidian-vault && tar xf -)     # 288 files, 4.8 MB
# + makeFixtureVault() (lib/vault-fixture.ts, B1a) copied under Fixture/
```

**The temp directory is named `obsidian-vault` on purpose.** `vaultName()` is
`basename(OBSIDIAN_VAULT_DIR)`, so a directory called `b2d-sandbox` would have made the R26 caveat
render a temp-dir artefact instead of the name the live server produces. The vault name in §5 is the
real one.

### 1.2 A throwaway forge-control with only two routers

**Not `tsx src/index.ts`** — that starts the cron tick, the Telegram poller and the vault-sync tick
against live state. `/tmp/b2d-server.mts` mounts `routes/vault.ts` and `routes/memory.ts` on a bare
Hono app, the fleet's single-router probe pattern. (Bare specifiers do not resolve from `/tmp`, so
`hono` and `@hono/node-server` are imported by absolute path out of `forge-control/node_modules`.)

```bash
cd forge-control && set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
export OBSIDIAN_VAULT_DIR=/tmp/b2d/obsidian-vault VAULT_SNAPSHOT_DIR=/tmp/b2d/snapshots PROBE_PORT=7795
setsid nohup ./node_modules/.bin/tsx /tmp/b2d-server.mts > /tmp/b2d-server.log 2>&1 < /dev/null &

$ curl -sS http://127.0.0.1:7795/api/_probe
{"ok":true,"vault_dir":"/tmp/b2d/obsidian-vault","snapshot_dir":"/tmp/b2d/snapshots"}
```

That probe response is the sandbox proof, and it is asserted at the start of every run.

### 1.3 REBUILD the web app against it, then drive — in ONE bash call

```bash
cd forge-control-web && FORGE_CONTROL_URL=http://127.0.0.1:7795 NODE_ENV=production pnpm build
$ grep -o 'http://127.0.0.1:7795' .next/routes-manifest.json | head -1
http://127.0.0.1:7795                      # the rewrite is baked, verified rather than assumed

# server + drive in the SAME invocation — a backgrounded server does not survive between tool calls
(cd forge-control-web && setsid nohup bash -c 'set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a;
   AUTH_URL=http://127.0.0.1:7796 NEXTAUTH_URL=http://127.0.0.1:7796 \
   exec ./node_modules/.bin/next start -p 7796' > /tmp/next-7796.log 2>&1 < /dev/null &)

node docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.mjs \
  --base http://127.0.0.1:7796 --path /desktop --wait-until commit --quiet \
  --cookie-out /tmp/b2d-cookie.txt                              # HARNESS_EXIT=0  ok=true

PROOF_SHOT_DIR=$UP PROOF_STAMP=$STAMP node /tmp/b2c-drive.mjs \
  --base http://127.0.0.1:7796 --cookie-file /tmp/b2d-cookie.txt \
  --surface memory --viewport 1600x2200 --settle 8000 \
  --script /tmp/b2d-proof.mjs --out /tmp/b2d-proof.json        # DRIVER_EXIT=0
```

Traps this run actually hit, so the next reader does not pay for them again:

- **`pkill -f 'next start -p 7796'` killed my own shell with exit 144** — the pattern matches pkill's
  own command line. Kill by PID from `ss -lntp` instead, or make it the very last command of a call.
- **`--wait-until commit`** — Next 15 never fires `domcontentloaded` here.
- **Playwright strict mode**: `getByText("Copy vault path")` matched two nodes, because R26's caveat
  text *mentions* the control by name. `{ exact: true }`.
- **`consoleErrors` is full of 404s and they are expected.** The throwaway server mounts two routers;
  every other surface's polling (`/api/today`, `/api/fleet`, …) 404s. Nothing on the memory surface
  does.

Every run in this document cleared the `/signin` assertion and exited 0. Nothing was screenshotted
past a failed wall check.

---

## 2. THE NEGATIVE CONTROL — "0 notes", reproduced before it was fixed

This is the round's most important measurement, and it nearly did not get taken.

**Against the LIVE `:7700` API the bug does not appear.** The live server still runs the pre-B1c
`noteCounts()`, which still emits the bare `all` key, so the old surface renders **"288 notes"** and
looks healthy. Anyone reproducing R28 against live would conclude the defect was already fixed.

So the control was run against the **same throwaway server, same 288 notes, same session**, changing
only the component:

```bash
git show a810074:forge-control-web/app/desktop/MemorySurface.tsx > .../MemorySurface.tsx  # pre-B2d
cd forge-control-web && FORGE_CONTROL_URL=http://127.0.0.1:7795 NODE_ENV=production pnpm build
# … drive, scrape the rail …
git checkout -- forge-control-web/app/desktop/MemorySurface.tsx    # restored; blob hash re-checked
```

**PRE-B2d (`a810074`), rail `innerText`:**

```
hub
Obsidian vault
0 notes                ← Konrad's "it's zero and not eight"
Vault
Agent
All          0
Rules        0
Preferences  0
Facts        0
People       0
Projects     0
Notes        0
```

**POST-B2d (`5fc2367`), same server, same second:**

```
288 vault notes indexed
198 agent briefs (no file on disk)
292 .md files on disk
263 files embedded · 2,208 chunks embedded
excluded: 15 excalidraw · 10 empty · 1 frontmatter-only
1 stale embedding rows
measured at 2026-08-19T02:06:21.982Z
```

`zero_notes_rendered: true` before, `false` after. Screenshot of the before state:
`/opt/ai-os/uploads/25175c0e7d69/20260819T020826Z-before-zero-notes.png`.

**Restoration was verified by blob hash, not by eye:** `git hash-object` of the working tree file
equals `git rev-parse HEAD:…`.

---

## 3. R22 — the editor saves, and the bytes on disk change

**Screenshot:** `after-note-editor.png`. Note driven: `AI OS/Session State - 2026-08-19.md` — a real
note from the live index, whose file lives in the sandbox copy.

The body is read with `fetchVaultFile()`, **not** with the memory note detail: `note.body` comes from
an index and is not guaranteed byte-identical to disk, and a `base_sha256` over bytes you did not
load is theatre. `{content, sha256}` are held in one `LoadedFile` object and only ever replaced
together, so they cannot drift apart.

```
typed  : <the file's exact bytes> + "\n\nB2D-PROOF-EDIT 20260819T020619Z\n"
assert : the ON-DISK bytes now equal exactly what was typed
result : sha256 d83503cac2c6… → aaad5741257c…   (3,670 → 3,704 chars)
```

Both directions are asserted — `afterDisk === typed` **and** `afterDisk !== before` — because the
first alone would pass if nothing had ever differed.

On-screen confirmation, scraped from the rendered DOM:

```
saved · 3,741 bytes on disk · new sha256 aaad5741257c… ·
previous version kept at /tmp/b2d/snapshots/2026-08-19/AI OS__Session State - 2026-08-19.md.1787105191820-f86dbcd0.md
```

The snapshot directory held **1** entry afterwards: the undo contract fired, and the path is in the
sandbox. The server's returned `sha256` is adopted as the new base, so a second edit works without a
reload — §4 depends on that and would fail if it did not.

**Agent notes render read-only** with the reason on screen (*"its path is a self-declared label, not a
file on disk — there is nothing to open in Obsidian and nothing to save"*). No save button is rendered
for them, so none can 400.

---

## 4. R23 — a 409 shows both versions and requires an explicit choice

**Screenshot:** `after-conflict-409.png`. This is the requirement with the most ways to be wrong, so
the assertions are itemised.

Method: with the editor open and holding a loaded base hash, the file was rewritten **out of band**
from the shell side of the driver — `fs.writeFile(abs, theirs)` — exactly as an agent or the
vault-sync tick would. Then more text was typed and Save clicked.

| assertion | result |
|---|---|
| a 409 banner is shown, not a generic "save failed" | `CONFLICT — HTTP 409. NOTHING HAS BEEN WRITTEN.` |
| the UI contains **text from both versions** | `KONRAD-KEPT-TYPING` **and** `AGENT-WROTE-THIS-WHILE-HE-WAS-TYPING` both present in `body.innerText` |
| both versions are **labelled with whose they are** | `YOUR UNSAVED VERSION · 3,742 characters` / `THE VERSION NOW ON DISK · 3,797 bytes` |
| exactly three explicit choices | `["Keep mine — overwrite the 3,797 bytes now on disk", "Take theirs — load the disk version into the editor", "Cancel and keep editing"]` |
| the editor still holds his text | `textarea.value.includes("KONRAD-KEPT-TYPING") === true` |
| **the file on disk still holds the out-of-band version** | `diskAfter409 === theirs`, sha256 `a26975dd018a…` — **the 409 wrote nothing** |

The last row is the one that matters: a 409 that wrote anything is a failed 409.

**What the code cannot do**, by construction rather than by discipline:

- **No auto-merge**, under any heuristic. There is no merge code.
- **No silent retry.** `saveVaultFile()` has **no retry parameter** and never re-reads the file to
  build a fresh base. The only path that saves against the newer hash is the labelled
  *"Keep mine — overwrite the 3,797 bytes now on disk"* click, which passes
  `conflict.current_sha256` explicitly. The button says what it will destroy, in bytes.
- **His text survives every path.** *"Take theirs"* stashes the draft in `displaced` and renders
  *"restore my discarded version (N characters)"*; nothing in the component clears the draft.
- **"Take theirs" refuses when the payload is truncated.** The 409 body is capped at 8 Mi code units
  and the server flags it; offering a prefix back as a whole note would destroy the tail on the next
  save. The button renders disabled with that reason. *(Not exercised here — no note in this vault is
  within three orders of magnitude of the cap. Named as unproven rather than claimed; the branch is
  four lines and reads on `current_content_truncated`.)*

---

## 5. R24 — a failed save is loud, persistent, and keeps his text

Proved **twice**, because each half proves something the other cannot.

**(a) An injected 400 at the transport**, so the editor still holds *real* text at the moment of
failure (`page.route` fulfils the PUT with `{"error":"path must end in .md — refused"}`). This is
R24's test as written — *"point a save at a path that 400s"* — which the UI cannot otherwise reach,
because it never lets the user choose the path.

```
SAVE FAILED — HTTP 400
400 Bad Request on /vault/file — path must end in .md — refused (injected transport 400)
Nothing was written. Your unsaved text is still in the editor above.
```

| assertion | result |
|---|---|
| the HTTP **status** is visible | `SAVE FAILED — HTTP 400` |
| the **server's message** is visible | the `.error` string, rendered verbatim |
| the editor still holds the unsaved text | `draft_intact: true` |
| nothing suggests the save succeeded | `no_success_claim: true` (no `saved · ` anywhere) |

**(b) A real 400 from the real server**, end to end: clearing the body to whitespace is refused by
`writeVaultFile()`.

```
SAVE FAILED — HTTP 400
400 Bad Request on /vault/file — empty content refused: a whitespace-only body
would erase AI OS/Session State - 2026-08-19.md
```

…and `diskAfter400 === theirs`: a refused save wrote nothing.

The error panel is a **persistent block**, not a toast. It is cleared only by a subsequent save
attempt. **This is the requirement `api-vault.ts` exists for**: `api.ts:29`'s `getJson` throws
`${status} ${statusText}` and discards the body, so the second line above — the half that tells Konrad
*why* — would have been unavailable to any UI built on it.

---

## 6. R25 / R26 / R27 — the control that was a `<div>` with no handler

**Screenshot:** `after-obsidian-control.png`. Before this round, `MemorySurface.tsx:803-829` rendered
a `<div>` with `cursor:"pointer"` and **no `onClick`, no `href`, no handler of any kind**. B2a's DOM
dump proves it. Konrad had been clicking it for a week.

| requirement | assertion | result |
|---|---|---|
| **R25** | `href` starts `obsidian://open?vault=` | `obsidian://open?vault=obsidian-vault&file=AI%20OS%2FSession%20State%20-%202026-08-19.md` |
| **R26** | the caveat is **visible text** in the rendered DOM, adjacent to the control, and **names the vault** | present in `body.innerText`, quoted below |
| **R27** | a second control copies the vault-relative path, with visible confirmation | `content_copy Copy vault path` → `copied to clipboard: AI OS/Session State - 2026-08-19.md` |

The caveat, as rendered:

> Open in Obsidian only works on a machine running Obsidian with a vault named **“obsidian-vault”** —
> this server does not run Obsidian, and the name comes from the vault directory on THIS host, so it
> may differ from the folder name on yours. If it does nothing, use Copy vault path instead.

It is a `<div>` of body text, not a `title` attribute and not a tooltip — R26's failure column names
all three, and the assertion reads `body.innerText`, which contains neither hover state nor
attributes.

**THE VAULT NAME IS STILL A SERVER-SIDE GUESS, AND THE UI SAYS SO.** `OBSIDIAN_VAULT_NAME` is **not
set** in `/opt/ai-os/.secrets/forge-control.env` (checked at 2026-08-19T00:30Z), so `vaultName()`
falls back to `basename(OBSIDIAN_VAULT_DIR)` = `obsidian-vault` — the **server's** folder name.
Syncthing replicates contents, not folder names. Per the standing instruction I shipped the link with
the caveat and **hardcoded nothing**; the sentence above is what makes a link that may open nothing
honest instead of broken. If Konrad supplies the real name, setting that env var is the whole fix and
no code changes.

The URI is **not rebuilt in the browser**: `note.obsidian_uri` comes from `obsidianUri()`
(`lib/vault.ts`), which encodes each path component separately. Note the `%2F` above — a
single-`encodeURIComponent` implementation in the client would have produced a different string, and
two implementations of an encoding rule drift. `obsidian_uri` is `null` for agent notes and **neither
control renders** for them.

---

## 7. R28 / R29 — every number carries a unit, and the split is visible

**Screenshot:** `after-counts-rail.png`.

**The first version of this assertion was inert and is worth reading before writing another one.** It
located the rail by walking up until `clientWidth >= 180`, which stopped at the 190 px **header row
inside** the rail and scraped `"hub\nObsidian vault"` — a string with no digits, on which
"no numeric text node lacks a unit" passed **vacuously**. It reported `PASS — 0 numeric lines`. Two
changes fixed it:

1. anchor on a rail-only marker (`BY FOLDER`) instead of a width threshold, and
2. a **positive control**: `must(numericLines.length >= 6)`. An empty scrape can no longer pass.

**A bare integer is a standalone numeric token** — digits with no word character glued to either
side. Without that qualifier the check fires on the folder names `90_AI_OS`, `30_YouTube`,
`20_Coding`, the Material Symbols ligature `graph_3` and the label `3D net`: identifiers that happen
to contain a digit and that no unit could sensibly follow. This is R28's rule made precise, and the
precise version is the one that caught real cases.

The 19 numeric lines judged, all carrying units:

```
288 vault notes indexed          | 288 notes (Every folder)   | 21 notes (AI OS)
198 agent briefs (no file...)    | 70 notes ((root))          | 14 notes (Excalidraw)
292 .md files on disk            | 56 notes (90_AI_OS)        | 11 notes (Daily)
263 files embedded · 2,208 chunks| 54 notes (30_YouTube)      | 8 notes (Mentor)
excluded: 15 excalidraw · 10 …   | 49 notes (20_Coding)       | 2 notes (_Templates, Inbox)
1 stale embedding rows           | measured at 2026-08-19T…   | 1 notes (How to price info)
```

**R29 — both figures render at once**, whichever tab is selected: `288 vault notes indexed` and
`198 agent briefs (no file on disk)` are adjacent lines, and the existing `Vault | Agent` toggle
(already wired to `?source=`) remains the filter. The agent figure is labelled honestly, and a line
under the toggle states which half is listed.

`folder_rule` is rendered verbatim under the folder chips:

> first "/"-separated segment of vault_path; a note with no "/" is counted under "(root)". Scope:
> hcp.knowledge_note rows where created_by = 'vault-sync'.

### The seven category chips were deleted, and this is the reason

They read `counts[c.key] ?? 0` against per-category totals from `inferCategory()`, which matches
frontmatter tags named `rule`/`pref`/`person`/`project`/`fact`. The vault's real tags are `recurring`,
`wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope` — and only 65 of 284 notes carry any tag
at all. **Five of six were structurally incapable of a non-zero number**, which the §2 control shows
directly: all seven read `0`. A filter that always returns zero teaches its operator that his vault is
empty.

They are replaced by **`folder_counts`** — a real partition, counted server-side over every note
rather than over the 30 currently paged in. The folder chips also **filter** the loaded list, and
because that filter is client-side over a page, the middle column states the gap explicitly rather
than implying the chip's number is what is shown:

```
folder "20_Coding" · 12 notes loaded of 49 notes in this folder
```

`inferCategory()` itself survives — the list rows and the detail header still show `category` as a
**label**. It is no longer a **count**, because it could not compute one.

**N1**: `counts.all ?? 0` and `countsQ.data ?? { all: allNotes.length }` are both gone. Loading renders
`loading counts…`; a failure renders the error in a bordered block. Neither renders a number.

---

## 8. B2e — the graph's honesty surface

**Screenshot:** `/opt/ai-os/uploads/25175c0e7d69/20260819T020619Z-after-graph-3d.png` (read back into
the run transcript; not copied into this directory, because the after-shot paths here belong to B2d's
write_set and two tasks may not write one path).

The renderer was never the problem and is barely touched — B2b established that the existing component
already renders the new payload. What changed is the three things it could not say.

| assertion | result |
|---|---|
| the rail renders labelled counts | `292 nodes drawn · 624 edges drawn` / `288 notes scanned · 122 notes carrying links` / `128 unresolved targets · 1 self-links dropped` |
| **R33** — the rail names its source table verbatim | `source: knowledge_note.links · measured at 2026-08-19T02:06:34.745Z` |
| a WebGL canvas is mounted | `true` — the scene draws |

- **R34 — unresolved targets are marked, not dropped.** 128 of 292 nodes have no note behind them.
  They are drawn in one flat amber (a class you can see at a glance, not 128 individually hashed
  tints), at 0.62× radius and a third of the emissive intensity, and the picked-node panel says in
  words: *"Unresolved: notes link to this name but no note has it. A note you meant to write — kept in
  the graph on purpose, not dropped."* Dropping them would under-report the graph by 44% while looking
  perfectly healthy.
- **R35 — an empty graph says why, in the server's words.** The empty state is keyed on
  `data.nodes.length === 0`, **not** on the truthiness of `data`: a response object is truthy even
  when it describes nothing, which is exactly how an empty state gets skipped and a black rectangle
  ships. It renders `empty_reason`, which names the table read and the rows found.
  **Not exercised in this run** — the live graph has 292 nodes. Named as unproven rather than claimed;
  a reviewer can drive it by pointing the throwaway server at a `knowledge_note` with no wikilinks.
- The old `stats` state — set only *inside* the async render effect — is gone. It was why the chip
  could read *"no graph yet — index the vault"* while a graph existed, and the advice was wrong
  anyway: nothing refills `knowledge_triples`.

---

## 9. What I could NOT prove from this worktree

Named explicitly, for the phase-7 deploy/verify task.

1. **Anything about Konrad's own browser.** Every measurement here is a headless Chromium on the VPS.
   The self-hosted fonts remove the *dependency* that made his complaint possible; only he can confirm
   the symptom is gone.
2. **`obsidian://` actually opening a note.** This host runs no Obsidian. R25 proves the emitted URI;
   whether it resolves depends on the vault name on his machine — see §6, and the unset
   `OBSIDIAN_VAULT_NAME`.
3. **The clipboard on a non-secure origin.** `127.0.0.1` is a secure context, so the
   `navigator.clipboard` path is what ran. The `document.execCommand` fallback for LAN-over-http is
   written and typechecked but did not execute.
4. **The truncated-conflict branch** (§4) — no note approaches the 8 Mi cap.
5. **`empty_reason` rendering** (§8) — the live graph is not empty.
6. **`/fonts/*` behind the auth wall** — measured (`307`) and reported, but `middleware.ts` is not in
   my write_set. One line: add `|fonts` to its matcher. See `font-decision.md` §3.
