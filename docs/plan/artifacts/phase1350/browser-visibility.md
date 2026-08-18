# Browser activity in the UI — what is covered, and what is not

Round 1350, PHASE 6 item 2 (client half). Konrad's ask: *"I want to know which
UI you looked at when saying this needs more work."*

Read with `browser-index.md` (round 1351, the server half).

---

## 1. The convention, exactly as it exists today

Nothing in this round invented a pipeline. Three pieces already existed and
this work only reads them:

| Piece | Where | What it does |
|---|---|---|
| The writer | `scripts/research-browser.mjs:306` (`screenshotRecord`), `:1759` | Writes `/opt/ai-os/uploads/<run_id>/<compact-ISO8601>-<label>.png` and prints a JSON record `{label, path, url, url_servable}` on stdout. |
| The id | `forge-control/src/lib/cc-runner.ts:138` (`uploadsRunId`) | Exports `FORGE_RUN_ID` = the run UUID's **first 12 hex characters** into every Claude Code child process. `FORGE_RUN_UUID` carries the full id alongside it. |
| The server | `forge-control/src/routes/uploads.ts:103,108,118` | `GET /api/uploads/index`, `GET /api/uploads/:id/shots`, `GET /api/uploads/:id/:name`. The id gate is `/^[a-f0-9]{12}$/` and 400s anything else. |

So a run's screenshot directory is `runId.toLowerCase().replace(/[^a-f0-9]/g,"").slice(0,12)`.
`app/desktop/chat/browser-shots.ts` **re-derives** that locally rather than
importing `cc-runner.ts` (engine internals are owned by a parallel project this
cycle), and `scripts/checks/check-browser-shots.ts` pins the derivation to the
engine's own test vector — `ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f → ece63bdb1f2a`
(`cc-runner.test.ts:80`). If the engine ever changes the convention, that
assertion fails and this renderer is the thing that is wrong.

## 2. What the rendering covers

**In the transcript** (`BrowserShots.tsx`, mounted by `AssistantThread.tsx`'s
`ToolCallRow`), two shapes, both extracted from data the row already had:

* **`source: "bash"`** — a `Bash` tool_result carrying a `"url": "/api/uploads/<12hex>/<name>"`
  member. Matched on the record *shape*, not parsed as JSON and not matched on
  prose: the real captured payload in
  `fixtures/run-7a0c6432-browser.json` (entry 121) reached the thread through
  `… | grep -A3 '"path"'`, i.e. four lines out of the middle of a JSON object.
  A Bash result that merely *mentions* `/api/uploads` in a sentence yields
  nothing — asserted.
* **`source: "read"`** — a `Read` tool_call whose `file_path` is under
  `/opt/ai-os/uploads/<12hex>/`: the operator opening a shot to look at it.

On the real run `7a0c6432-cde4-4ca1-8f17-ff340c236c0a` that produces four
blocks over two files — *photographed it*, then *looked at it*, twice — which
is the sequence the screenshots in `browser-ui/` show.

**In the panels** (`TeamRow.tsx`, `live/AgentActivity.tsx`): a camera indicator
on any row whose derived 12-hex directory appears in `/api/uploads/index`, with
the image count. One shared `["uploads-index"]` react-query poll at 30s serves
every row on the page (react-query dedupes by key; structural sharing means an
unchanged payload re-renders nothing); `/api/uploads/:id/shots` is requested
only when a strip is opened.

**Opened by CLICK, never by hover.** Hover cost is a gate on this project
(NFU2 / DoD #3), and both panels are built on the rule that a pointer moving
across the list mounts nothing and sets no state. An indicator's `<img>` tags
do not exist in the DOM until its strip is open.

**No screenshot is rendered through markdown.**
`app/desktop/chat/rehype-forge-allowlist.ts` turns every markdown image into
inert text — a closed beacon hole, not an oversight. It is unchanged. Every
`src` on the page is built by `shotSrc()` from a 12-hex id and a filename that
were each validated against a fixed character class, so agent output can only
choose *which file already on this disk* is displayed.

## 3. What is NOT covered — OPEN ITEM, owned by whoever owns the engine prompts

**Only the research lane is instructed to put screenshots where this UI can see
them.** The convention is honoured by `scripts/research-browser.mjs`, and that
tool is reached when a role's brief tells it to use it. There is **no
engine-side instruction** telling any other role to write its screenshots to
`/opt/ai-os/uploads/$FORGE_RUN_ID`. Concretely:

* **The operator itself** — a browser session it drives outside
  `research-browser.mjs` lands wherever that tool puts it.
* **Builders using `playwright-skill`** — that skill writes its scripts and
  screenshots to `/tmp` by design. Those shots exist, are never served, and are
  gone at the next reboot. This UI cannot show them and does not pretend to.
* **Any future tool** that screenshots without adopting the convention.

The fix is a line in the role prompts (or a wrapper that defaults the output
directory), and it lives in `forge-control/src/lib/cc-runner.ts` /
`project-tick.ts` — **files this project is explicitly forbidden to touch this
cycle** (engine internals belong to `engine-v2-research-lane`). It is therefore
recorded here as an open item rather than worked around: no new plumbing was
built, no shim was added, and the panel claims coverage of exactly the
directories that exist.

Two smaller, honest limits worth stating:

* **A `read`-sourced ref may be a chat attachment, not a browser shot.**
  `POST /api/uploads` writes Konrad's dropped files into the same tree with the
  same id shape, so a `Read` of `/opt/ai-os/uploads/<id>/image.png` cannot be
  told apart from a screenshot by its path. The UI says "N images" instead of
  "N screenshots" whenever any ref came in that way, and only claims
  "screenshots" when every ref came from a browser-tool record.
* **A sub-agent has no directory of its own.** It inherits its parent process's
  `FORGE_RUN_ID`, so its shots land in the parent run's directory; sub-agent
  rows therefore show no indicator (`runId={null}`) rather than an invented one.

## 4. Evidence

* `scripts/checks/check-browser-shots.ts` — 87 assertions over the real
  captured fixtures plus the negative cases. `cd forge-control-web && npx tsx
  ../scripts/checks/check-browser-shots.ts` → ALL PASS.
* `browser-ui/*.png` — the transcript block collapsed and expanded, and the
  panel indicator closed and open, in **both themes**, captured from the real
  components rendered against the real run with thumbnails loading over the
  real `/api/uploads` route (`naturalWidth: 1600`, i.e. the images actually
  arrived).
