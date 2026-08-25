# chat-ref-nav — the regression test this feature never had

`scripts/checks/check-chat-reference-navigation.mjs` drives a real Chrome against a
real console, clicks a file-path pill **from the Team tab**, and asserts that the file
actually opens. This document is the recipe: four commands to stand the stack up, what
each assertion means, and what it measured the first time it ran.

## Why a browser test and not a unit test

Every bug this feature has shipped was **wiring between components that each worked
perfectly in isolation**, and not one of them was visible to `tsc`, to
`check-code-path-link.ts` (18 detector cases, all green while the feature was broken),
or to a grep of the bundle:

1. **The bus had no latch.** `FileExplorerPanel` mounts *only* on the Files tab
   (`ChatSurface`: `tab === "team" ? <ChatTeamPanel/> : <FileExplorerPanel/>`) and Team
   is the default — so a click dispatched *before* the subscriber existed. The tab
   flipped and the file never opened.
2. **Resolution searched by full path** against `/files/search`, which matches on
   `name.toLowerCase().includes(q)`. Any query containing a `/` matched nothing, ever.
3. **A miss was silent**, which is indistinguishable from a dead handler.

All three are questions of the form *"when I click this, does the file appear?"*. That
question has exactly one honest instrument: a browser.

## 1. Scratch database (zero live writes)

The test seeds its own chat — an assistant message carrying one pill per case. Seeding
into the live database is the deploy task's privilege, so a build task uses a scratch
copy. Schema only, which is a read-only operation on live:

```bash
PGPASSWORD=… psql -h 127.0.0.1 -U postgres -d postgres -c 'CREATE DATABASE "forge_probe_refnav"'
PGPASSWORD=… pg_dump -h 127.0.0.1 -U postgres -s content_forge > /tmp/refnav-schema.sql
PGPASSWORD=… psql -h 127.0.0.1 -U postgres -d forge_probe_refnav -f /tmp/refnav-schema.sql
```

Expect **0 ERRORs** and `select count(*) from runs` = 0.

The check **refuses** to seed into `content_forge` unless `ALLOW_LIVE_SEED=1` is set —
safe by construction, not by the operator remembering.

## 2. Probe forge-control on a spare port

Mounts **only** the chat router, against the scratch database, and proxies every other
`/api` path to the real `:7700` — **GET/HEAD only**, so the run is read-only on live by
construction. Never import `forge-control/src/index.ts`: it starts cron, the Telegram
bridge, the vault sync and the probe loop at import, and a second copy of those acts on
the live system.

Keep the script outside the repo and pipe it in (`tsx -e` gives it a virtual filename in
the CWD, so bare `hono` and relative `./src/routes/chat.ts` both resolve, and nothing
undeclared is ever written into the tree):

```ts
// /tmp/refnav-probe.mts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import chat from "./src/routes/chat.ts";

const UPSTREAM = process.env.PROBE_UPSTREAM ?? "http://127.0.0.1:7700";
const app = new Hono();
app.route("/api/chat", chat);
app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: `probe is read-only upstream: refused ${c.req.method} ${c.req.path}` }, 405);
  }
  const url = new URL(c.req.url);
  const res = await fetch(UPSTREAM + url.pathname + url.search, {
    method: c.req.method,
    headers: c.req.raw.headers,
  });
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");   // SSE and gzip both survive the hop only
  headers.delete("content-length");     // if these two are dropped
  return new Response(res.body, { status: res.status, headers });
});
serve({ fetch: app.fetch, port: Number(process.env.PROBE_PORT ?? 7801), hostname: "127.0.0.1" });
```

```bash
cd forge-control
tmux new-session -d -s refnav-probe \
  "DATABASE_URL='postgresql://postgres:…@127.0.0.1:5432/forge_probe_refnav' PROBE_PORT=7801 \
   ./node_modules/.bin/tsx -e \"\$(cat /tmp/refnav-probe.mts)\""
```

**These port numbers are not yours by right.** This box runs several project worktrees at
once and every one of them stands up probes and `next` servers on adjacent ports; a
sibling task has already watched a `curl` answer **200 with a plausible chat list** from
someone else's stack on a port its own probe had failed to bind. So the checks below are
IDENTITY assertions, not health checks: `count: 0` is your empty scratch database saying
so. The check itself does the same thing again after seeding — it refuses to run unless
`FORGE_API_URL` serves *the run it just inserted*.

Two assertions before going further — they take five seconds and they are the
difference between measuring the branch and measuring nothing:

```bash
curl -s 127.0.0.1:7801/api/chat            # {"count":0,…}  ← the SCRATCH db, not live
curl -s 127.0.0.1:7801/api/files/roots     # includes aios + forge-src, readOnly:true
curl -s -X PUT 127.0.0.1:7801/api/files/write -w ' %{http_code}\n'   # 405
```

## 3. The console, built from THIS worktree against the probe

`FORGE_CONTROL_URL` is read at request time by `app/api/proxy/[...path]/proxy-handler.ts`,
so it does not have to be baked in — but the rest of the auth config does have to be
real, or the session cookie will not validate.

```bash
cd forge-control-web
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
export FORGE_CONTROL_URL=http://127.0.0.1:7801
./node_modules/.bin/next build                       # ~4 min
tmux new-session -d -s refnav-web "… ./node_modules/.bin/next start -p 7803 -H 127.0.0.1"
```

**Use a production build, not `next dev`.** Two reasons, both measured here:

- `next dev` compiles `/desktop` on the first authenticated request and that took
  **110 s** (7546 modules). Playwright's 30 s default navigation timeout turns that into
  `Timeout 30000ms exceeded`, which reads exactly like a dead console. (The check now
  allows 240 s, overridable with `NAV_TIMEOUT_MS`, so dev *works* — it is just slow.)
- `next.config.mjs` sets `reactStrictMode: true`, and **in development that double-mounts
  every component**: effects run, clean up, and run again. `FileExplorerPanel`'s mount
  effects are not idempotent under that, and the second `loadDir(null, "")` wins the
  `seqRef` race against the directory load the open-request had just started — so the
  breadcrumbs are right and the list still shows the roots. See §5.

Do NOT run `next build` inside `/opt/forge-ai-os`: rebuilding under the running server
crashes the live console. A worktree has its own `.next` and is safe.

## 4. Run it

```bash
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a   # AUTH_SECRET
unset FORGE_CONTROL_URL                                          # the check does not proxy
SEED_DATABASE_URL='postgresql://postgres:…@127.0.0.1:5432/forge_probe_refnav' \
BASE_URL=http://127.0.0.1:7803 \
FORGE_API_URL=http://127.0.0.1:7801 \
OUT_DIR=/opt/ai-os/uploads/$FORGE_RUN_ID \
  node scripts/checks/check-chat-reference-navigation.mjs
```

Exit codes: **0** every assertion passed · **1** at least one named assertion FAILed ·
**2** harness fault — the test could not run at all (missing dependency, not signed in,
`FORGE_API_URL` serving a different database than `SEED_DATABASE_URL`). A harness fault
is never reported as a pass.

Inputs, all environment: `BASE_URL`, `FORGE_API_URL`, `SEED_DATABASE_URL` (required),
`AUTH_SECRET` **or** `FORGE_SESSION_COOKIE`, `COOKIE_NAME`, `OUT_DIR`, `ALLOW_LIVE_SEED`,
`KEEP_SEED`, `HEADFUL`, `NAV_TIMEOUT_MS`, `PLAYWRIGHT_MODULE`, `CHROME_PATH`.

In `gates-808.sh` it sits with the other browser gates, behind `--browser`, and is
SKIPPED (loudly, never silently omitted) without it.

### Borrowed dependencies — never add these to the repo

| what | where | why not a dependency |
| --- | --- | --- |
| playwright | `/opt/hermes-workspace/node_modules/playwright/index.mjs` | drags a browser download into every install |
| chrome | scanned out of `/root/.cache/ms-playwright` | the installed revision (**1234**) is not the one playwright asks for (**1223**); `chromium.launch()` with no `executablePath` throws `Please run: npx playwright install` — **do not run it** |
| `@auth/core` | `forge-control-web/node_modules/.pnpm/@auth+core@*/…/jwt.js` | not resolvable by bare specifier under pnpm; must be the console's own copy so encoder and decoder agree |
| `pg` | `forge-control/node_modules/pg` | already there |

### Two auth traps that cost hours

- **The salt must equal the cookie name.** In next-auth v5 the salt passed to `encode()`
  is part of the key derivation. `AUTH_URL` in the live `.env.local` is `https://…`, so
  the cookie is `__Secure-authjs.session-token` and the salt must be that exact string.
  Get it wrong and auth fails *silently*: the middleware 307s to `/signin`, which
  answers **HTTP 200**, and a probe that only counts API traffic congratulates you.
  The check asserts `page.url()` contains `/desktop` after every navigation.
- **`secure: true` even on `http://127.0.0.1`.** Chrome enforces the `__Secure-` prefix
  at the CDP layer and rejects the cookie with `Invalid cookie fields`, naming no field.
  127.0.0.1 counts as a secure context, so the cookie is still sent over plain http.

## 5. The fixture and the assertions

One assistant message, now fourteen references, one per branch of `detectPath`
and the resolver (round 6 added the last seven rows):

| pill | branch | expected |
| --- | --- | --- |
| `/opt/forge-ai-os/docs/plan/03-quality.md` | absolute, `forge-src` root | openable, resolves without a search |
| `/opt/obsidian-vault/Mentor/Profile/Operating Manual.md` | absolute, `vault` root | openable |
| `/opt/nowhere/missing-file.md` | absolute, outside every root | **plain pill, not openable** |
| `Mentor/Profile/Operating Manual.md` | relative | openable, placed by `/files/search` — bug 2's exact shape |
| `definitely-not-a-real-note-xyz.md` | relative, resolvable by nothing | openable, and the miss must **toast** — bug 3 |
| `forge-control-web/app/desktop/chat/MessageMarkdown.tsx:160` | relative, D1 `path:line` | openable, resolves via search, opens with line 160 highlighted and scrolled to |
| `/opt/ai-os/scripts/` | absolute, D5 folder (trailing slash) | openable as a **directory** — panel navigates, previews nothing |
| `/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md` | absolute, D6 fleet-memory root | openable on the client always; server behaviour depends on whether `/api/files/roots` advertises `memory` |
| `[[Operating Manual]]` | D2 wikilink, prose, not a code pill | renders as an `<a href="/document?wikilink=…">`; resolves into the **vault only**, same note as row 2 |
| `.txt` | bare extension (PLAN finding 6) | **plain pill, not openable** |
| `.md .txt .json .csv` | extension list (PLAN finding 6) | **plain pill, not openable** |
| `pnpm install`, `spend.per_run_cap` | not paths | plain pills; no false affordances |

Assertions **7a–7e**, **8a–8f**, **9a–9b**, **10a–10d**, **11a–11b** and **1e/1f**
are the round-6 additions:

- `7a`–`7e` (D1, `path:line`): the pill is openable, the FILE renders (marker
  `ReactMarkdown`, a stable top-of-file import — the exact text at line 160
  itself drifts with every round that edits the live file, so the marker
  proves the right file opened and the highlight assertion proves the right
  *line*), `[data-line="160"]` carries `fp-code-row-hit`, that row's rectangle
  is inside `.fp-code-scroll`'s (not merely in the DOM — same "revealed ≠
  present" distinction as `2h`/`3c`, one component over), and the row is also
  revealed in the *file list* (the D4 assertion, exercised on a large,
  virtualised directory this time instead of a two-file one).
- `8a`–`8f` (D2, wikilink + D3, frontmatter on the same note): the `<a>` has
  `data-openable-kind="wikilink"` and an `href` starting `/document?wikilink=`;
  a plain click opens the same vault note `2`/`4` already prove render
  correctly; its row-reveal is asserted the same way as `3c`; the frontmatter
  block renders as `.fp-meta` with a `type` key, and `.fp-scroll` (the
  rendered body, meta stripped out) does **not** start with `type:` — the
  exact wall-of-prose Konrad complained about.
- `9a`–`9b`: Ctrl-click on the *same* wikilink opens exactly one new tab at
  `/document?wikilink=Operating%20Manual` — the universal "open elsewhere"
  meaning survives being written as `[[…]]` instead of a path.
- `10a`–`10d` (D5, folder): the pill carries `data-openable-kind="dir"`; a
  click navigates the panel (breadcrumb ends `…/scripts`) and leaves nothing
  selected — a directory has no file to preview, the breadcrumb is the whole
  answer.
- `11a`–`11b` (D6, memory root): the pill is openable **unconditionally** —
  `code-path-link.ts`'s prefix table doesn't know or care whether the server
  has restarted, by design (see `resolve-path.ts`'s `resolveRootPath` header
  comment). The check therefore asks the SAME question the app itself asks —
  `GET /api/files/roots` on `FORGE_API_URL` — and asserts whichever branch
  that implies: the file opens (breadcrumbs mention "memory", real body text)
  if the key is present, or a `"Can't open … yet"` toast if it is absent.
  Never a silent skip either way.
- `1e`/`1f`: `.txt` and `.md .txt .json .csv` — PLAN.md finding 6's exact dead
  clicks — must never carry `data-openable-path`.

Every assertion prints a named `PASS`/`FAIL` line:

- `1a`–`1d` — affordance: `data-openable-path` present iff the pill names a placeable file.
- `2a` — **negative control**: the file's own text is *absent* from the page before the
  click. Without it, `2f` could pass on a page that always contained the string.
- `2b` — `localStorage["forge.layout.chat.panelTab"]` goes `"team"` → `"files"`.
- `2c` — the panel **navigated**: `.vfl-breadcrumbs` names the forge-src root (under
  either spelling) plus `docs` and `plan`.
- `2d` — the crumb is **readable**: it says `forge-control source`, not the internal key.
- `2e` — `context.pages().length` is unchanged. A plain click must not open a tab.
- `2f` — a string from `03-quality.md` is on screen (bug 1's symptom, inverted).
- `2g` — the panel header reads `1 selected`: selection *state* is right.
- `2h` — the row for `03-quality.md` carries `vfl-row--selected`: selection is *visible*
  (PLAN D4).
- `3b`/`3c` — the vault note, absolute: content rendered, and the row revealed.
- `4a`/`4b` — the *same* note written relative, resolved through search (bug 2).
- `5a`/`5b` — Ctrl-click opens **exactly one** page, at `/document?root=forge-src&…`.
- `6a` — the unresolvable pill toasts `Couldn't find …` (bug 3). There is no stable
  selector on `ToastHost`, so the instrument is body text — that string appears nowhere
  else in the console, which is what makes it discriminating.
- `6b` — and it does so inside `MISS_BUDGET_MS` (8 s by default).

**Claims that can fail separately are asserted separately.** `2c`/`2d`, `2g`/`2h` and
`6a`/`6b` are each one question split in two, because folding them would report one
defect as two — or, worse, hide a real one behind a green sibling. `2g` passing while
`2h` fails is the entire content of PLAN D4, and no single assertion can say that.

### "Revealed" is not "in the DOM"

`2h` and `3c` do **not** ask whether `.vfl-row--selected` exists. They ask whether that
row's rectangle lies inside its scroll container's rectangle. The first draft of this
check asked only the DOM question, and `3c` went green on this screen:

> breadcrumbs `Home/vault/Mentor/Profile`, preview showing Operating Manual, list showing
> `About Me.md` and `Current Chapter.md` — and **no Operating Manual.md anywhere on it**.

The row existed, carried the class, and sat below the fold of a two-row-tall box. An
assertion that passes on a screen where the file Konrad just opened is invisible is
worse than no assertion, because it will be cited as proof the feature works.

Two failure modes, one requirement: `2h` fails because the row was never rendered
(virtualised, outside the window), `3c` fails because it was rendered and never scrolled
to. Both are D4.

`6a` and `6b` are split for the same reason and in the opposite direction: `6a`'s timeout
(`MISS_TIMEOUT_MS`, 240 s) is the harness's patience, `6b`'s budget (`MISS_BUDGET_MS`,
8 s) is the UX bar. When they were one number at 90 s, the assertion started reporting
"the miss is silent" on a run where the miss simply took 90.4 s — a harness giving up,
dressed as a product defect.

Screenshots land in `OUT_DIR` as `<UTC stamp>-<label>.png`, before **and** after every
click, so a FAIL comes with a picture of the failure.

### Restarting the console between clicks

Each case reloads `/desktop`. `addInitScript` runs before first paint on **every**
navigation, so it re-pins `forge.desktop.surface="chat"`, `forge.chat.selected=<seeded
id>`, `panelTab="team"` and `panelCollapsed=false` — that is how every click is made to
start from the Team tab, which is the only place the latch bug reproduces.

## 6. First results (2026-08-25, branch `project/ecacba29-test`)

**Production build on 7803, three consecutive runs, identical verdicts:
17 of 21 assertions pass, exit 1.** Not flaky — the same four named FAILs every time.

What passes is most of the feature, and it is worth stating plainly: pills are openable
exactly when they name a placeable file and plain otherwise, a click from the Team tab
flips the panel to Files, `03-quality.md` and the vault note both render their real
contents in the preview, the relative path resolves through search to the same file
(0.3–0.6 s), no stray browser tab opens, Ctrl-click lands on
`/document?root=forge-src&path=docs%2Fplan%2F03-quality.md`, and a miss toasts instead of
going quiet. **Bugs 1, 2 and 3 are all fixed, and this test now holds them fixed.**

Four FAILs, three distinct defects, none of them owned by this task:

| assertion | measured | defect |
| --- | --- | --- |
| `2d-breadcrumbs-show-the-human-root-label` | `Home/forge-src/docs/plan` | The crumb shows the **internal root key**. `VaultFileList` renders `rootLabel ?? root`, and `rootLabel` comes from `roots`, which `loadRoots()` sets — but on a programmatic open the mount-time `loadDir(null, "")` is superseded by the open-request's directory load (`seqRef`), so it bails as stale and `roots` is never populated. Cosmetic, one line, real. |
| `2h-opened-row-is-revealed-in-the-list` | `1 selected`, 0 rows selected of 7 rendered | **PLAN D4, half one.** `VaultFileList` is virtualised (`@tanstack/react-virtual`) and `docs/plan` is long, so the selected row was never rendered at all. `2g` passes — the file *is* selected and its preview *is* on screen — so this is purely the reveal. |
| `3c-vault-row-is-revealed-in-the-list` | selected row in the DOM, **0 visible** in the list box | **PLAN D4, half two.** Here the row *was* rendered and simply sits below the fold of a two-row-tall box: the panel shows `About Me.md` and `Current Chapter.md` while the file it just opened is out of sight. Same requirement, different mechanism — which is why the instrument measures rectangles, not classes. |
| `6b-miss-is-reported-fast-enough-to-feel-alive` | **14.8 s / 159.3 s / 73.0 s** against an 8 s budget (and 29.7–90.4 s in five earlier runs) | Resolution walks five roots serially and two of them are large trees. For anywhere from a quarter of a minute to nearly three minutes after the click, the console does nothing at all. This is PLAN's pending-state item, and it is far worse than the plan assumed (`~1 s`). The spread tracks how loaded the box is. |

Ownership: `FileExplorerPanel.tsx` / `VaultFileList.tsx` belong to the **panel**
workstream (task `e462d94a-d6bc-484b-ad20-93e4c6c23b7b`, which already owns D4); the
serial-search latency and its missing pending state belong to the **markdown** workstream
(task `e99810f4-285a-45f4-9e44-6878bda3583c`). This document is the instrument that will
tell them when they are done, not a bug list for the test author to fix.

One inherited RED worth attributing before someone blames this round: `gates-808.sh`
gate 9 (`dollar-sweep.sh`) fails on
`forge-control-web/app/desktop/chat/code-path-link.ts:11`, where the header comment cites
`` `spend.per_run_cap` `` as an example of a pill that must NOT be openable. It arrived
with the R0 port commit `27ab8d5`; nothing in this task's write-set touches
`forge-control-web/app` at all.

**So the gate is RED at this branch point, deliberately.** It sits behind `--browser`, so
the default `gates-808.sh` run is unaffected and stays green; it is skipped there, loudly
and by name. A browser gate that passed today would only mean it was not looking.

## 7. Round 6 results (2026-08-25, `project/ecacba29-test` after merging `project/ecacba29`)

Merging `project/ecacba29` (the integrated detect/preview/panel/markdown
workstreams) into this branch was **clean — no conflicts**. That brought in
line refs, folders, wikilinks, the memory root, the frontmatter strip and the
line-numbered code viewer, none of which existed in this test's write-set
before. Rebuilt the production console (`next build`) against the same
probe/scratch-DB stack §§1–3 describe, ran the extended check **twice in a
row**: **37/42, identical verdicts.** Not flaky — the same five named FAILs
both times.

All 21 assertions from rounds 1–5 that passed still pass. Of the 21 new ones
this round added, **20 pass** — every one of D1 (line refs, including the
scroll-and-highlight), D2 (wikilinks, both click and Ctrl-click), D3
(frontmatter on the wikilink-opened note), D5 (folders) and D6 (the memory
root's dynamic branch, currently "not live" — confirmed live via
`/api/files/roots` reporting 6 keys, `memory` absent) is holding.

**One new FAIL, and it is the same defect as an existing one, not a new
discovery:**

| assertion | measured | defect |
| --- | --- | --- |
| `8d-wikilink-row-is-revealed-in-the-list` | `0 rows rendered` (not "below the fold" — the list region renders **no rows at all** once the wikilink's note is previewed) | Same root cause as the inherited `3c-vault-row-is-revealed-in-the-list` FAIL — both open a file in `Mentor/Profile`, and the screenshot (`…T144714Z-g3-after-click-wikilink.png`) shows the breadcrumb, the "1 selected" count and the preview all correct, with the file-list region above the preview showing zero rows. `2h` and `7e`, which open files in *larger* directories (`docs/plan`, `app/desktop/chat`), reveal correctly — 13 rows rendered, the row visibly among them. This isn't new: it is PLAN D4 half two reproducing through a second affordance (wikilink, not just an absolute path pill), still owned by the **panel** workstream (`FileExplorerPanel.tsx`/`VaultFileList.tsx`), and it is now proven to be a property of the *directory* (or of "list + preview open at once" generally) and not of how the open was triggered. |

`2d`, `3c`, `4b` and `6b` are unchanged from round 5 (see §6 above) — still
inherited, still not this task's write-set.

### Dev-mode footnote

The first run went against `next dev` and scored 12/18, with the panel showing the
**roots listing** while the breadcrumbs read the right directory. That is a different
failure with a dev-only cause: `reactStrictMode` double-mounts `FileExplorerPanel`, the
second pass's `loadDir(null, "")` takes a higher `seqRef` than the directory load the
open-request started in the first pass, and the roots listing wins the race. It does not
reproduce in a production build, which is why §3 says to use one. It is also not
nothing: the same mount effect is what leaves `roots` empty in production, which is
`2d`.

## 8. Round 9 results (2026-08-25, `project/ecacba29`) — **42/42, exit 0**

Fix cycle 1 against round 8's review. Same stack as §§1–3 (scratch DB
`forge_probe_r9refnav`, read-only probe on 7871, production console on 7873),
run three times: **41/42 after the first pass of fixes, then 42/42 twice.**

| assertion | round 8 | round 9 | what changed |
| --- | --- | --- | --- |
| `2h` / `3c` / `4b` / `8d` — the row is revealed in the list | FAIL (0 rows, or below the fold) | **PASS** | The preview wrapper in `FileExplorerPanel.tsx` is bounded against its PARENT (`maxHeight: 58%`), `.fp-meta` is capped at 140px and the three scroll regions became shrinkable flex items. Measured on the exact case the memory note records: the list box goes **792px → 278px** where it used to go **792px → 0px**, 6 rows rendered before and after, `.fp-meta` 140px + `.fp-scroll` 343px. |
| `2d` — the crumb is readable | FAIL (`Home/forge-src/docs/plan`) | **PASS** | `ensureRootLabels()` now runs unconditionally and reads the shared `cachedFileRoots()` promise. |
| `6b` — a miss is reported fast | FAIL (39.0 s / 8 s budget) | **PASS (6.3 s)** | The roots are searched concurrently, read back in priority order, each on a 6 s deadline. |
| `4a` — a relative path resolves | PASS (11.0 s) | **PASS (0.3 s)** | Regression caught mid-round and fixed: see below. |

**A regression this round created and this check caught.** The first
concurrency fix was a plain `Promise.all`, which collects every root before
deciding — so a vault hit that used to land in 0.3–0.6 s waited **11.0 s** for
`aios` to finish saying no. `4a` still passed (it asserts the breadcrumb, not
the clock) but printed the number, which is why it prints the number. The loop
now awaits the already-in-flight promises **in `SEARCH_ROOTS` order** and
returns on the first hit. Per-root latency, measured against the live route with
the check's own miss query: vault 0.04 s, forge-src 0.14 s, uploads 0.23 s,
workspace 11.69 s, aios 13.91 s — the sum was the defect and the max is the
honest cost of a miss, which is what the 6 s deadline then bounds.

`2d` had a second half nobody had measured. After the guard fix, five of six
breadcrumbs read the human label and `4a` still read `Home/vault/…` — the one
case that resolved fast enough to beat its own label fetch. `fetchFileRoots` in
`api.ts` has **no cache of its own**; the module promise the no-new-poll rule
refers to lived in `resolve-path.ts` and held only the key set. It now holds
`FileRoot[]`, so the panel reads labels the resolver already fetched, off a
settled promise, in a microtask. All six breadcrumbs read the label.

### `check-chat-tool-path.mjs` — the orphan, now wired

Committed in round 7 and invoked by nothing: absent from `gates-808.sh` and from
this README, and RED at HEAD on a stale fixture — `UNREACHABLE_FILE` still named
`/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md`, which D6 had made a
real read-only root, so the assertion asserted the opposite of the product's
intent. It now names `/opt/nowhere/not-a-root/notes.md` and runs as **gate 31**
beside gate 30, behind `--browser`, skipped loudly without it. Against this
stack: **21/21, exit 0.**

A check no runner runs is worse than no check, because its silence reads as a
pass.
