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

One assistant message, five pills, one per branch of `detectPath` and the resolver:

| pill | branch | expected |
| --- | --- | --- |
| `/opt/forge-ai-os/docs/plan/03-quality.md` | absolute, `forge-src` root | openable, resolves without a search |
| `/opt/obsidian-vault/Mentor/Profile/Operating Manual.md` | absolute, `vault` root | openable |
| `/opt/nowhere/missing-file.md` | absolute, outside every root | **plain pill, not openable** |
| `Mentor/Profile/Operating Manual.md` | relative | openable, placed by `/files/search` — bug 2's exact shape |
| `definitely-not-a-real-note-xyz.md` | relative, resolvable by nothing | openable, and the miss must **toast** — bug 3 |
| `pnpm install`, `spend.per_run_cap` | not paths | plain pills; no false affordances |

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
- `3b`/`3c` — the vault note, absolute.
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

**Known measurement limit.** `3c` and `4b` pass partly because `Mentor/Profile` is a
small directory: the list is virtualised, and a selected row is in the DOM only if it
falls inside the rendered window. Add thirty notes to that folder and those two will
start failing for the same reason `2h` does. That is correct behaviour from the
instrument — it is D4 becoming visible in a second place — but do not read a green `3c`
as evidence that reveal-on-open works.

Screenshots land in `OUT_DIR` as `<UTC stamp>-<label>.png`, before **and** after every
click, so a FAIL comes with a picture of the failure.

### Restarting the console between clicks

Each case reloads `/desktop`. `addInitScript` runs before first paint on **every**
navigation, so it re-pins `forge.desktop.surface="chat"`, `forge.chat.selected=<seeded
id>`, `panelTab="team"` and `panelCollapsed=false` — that is how every click is made to
start from the Team tab, which is the only place the latch bug reproduces.

## 6. First results (2026-08-25, branch `project/ecacba29-test`)

**Production build on 7803, three consecutive runs, byte-identical verdicts:
18 of 21 assertions pass, exit 1.** Not flaky — the same three named FAILs every time,
with the same values.

What passes is most of the feature, and it is worth stating plainly: pills are openable
exactly when they name a placeable file and plain otherwise, a click from the Team tab
flips the panel to Files, `03-quality.md` and the vault note both render their real
contents in the preview, the relative path resolves through search to the same file
(0.3–0.6 s), no stray browser tab opens, Ctrl-click lands on
`/document?root=forge-src&path=docs%2Fplan%2F03-quality.md`, and a miss toasts instead of
going quiet. **Bugs 1, 2 and 3 are all fixed, and this test now holds them fixed.**

Three FAILs, three distinct defects, none of them owned by this task:

| assertion | measured | defect |
| --- | --- | --- |
| `2d-breadcrumbs-show-the-human-root-label` | `Home/forge-src/docs/plan` | The crumb shows the **internal root key**. `VaultFileList` renders `rootLabel ?? root`, and `rootLabel` comes from `roots`, which `loadRoots()` sets — but on a programmatic open the mount-time `loadDir(null, "")` is superseded by the open-request's directory load (`seqRef`), so it bails as stale and `roots` is never populated. Cosmetic, one line, real. |
| `2h-opened-row-is-revealed-in-the-list` | `1 selected`, 0 selected rows of 7 rendered | **PLAN D4, photographed.** `VaultFileList` is virtualised (`@tanstack/react-virtual`): the selected entry's row is not in the DOM because nothing scrolls it into view. `2g` passes — the file *is* selected and its preview *is* on screen — so this is purely the reveal. |
| `6b-miss-is-reported-fast-enough-to-feel-alive` | **29.9 s / 48.8 s / 29.7 s** against an 8 s budget | Resolution walks five roots serially and two of them are large trees. For half a minute after the click the console does nothing at all. This is PLAN's pending-state item, and it is worse than the plan assumed (`~1 s`). |

Ownership: `FileExplorerPanel.tsx` / `VaultFileList.tsx` belong to the **panel**
workstream (task `e462d94a-d6bc-484b-ad20-93e4c6c23b7b`, which already owns D4); the
serial-search latency and its missing pending state belong to the **markdown** workstream
(task `e99810f4-285a-45f4-9e44-6878bda3583c`). This document is the instrument that will
tell them when they are done, not a bug list for the test author to fix.

**So the gate is RED at this branch point, deliberately.** It sits behind `--browser`, so
the default `gates-808.sh` run is unaffected and stays green; it is skipped there, loudly
and by name. A browser gate that passed today would only mean it was not looking.

### Dev-mode footnote

The first run went against `next dev` and scored 12/18, with the panel showing the
**roots listing** while the breadcrumbs read the right directory. That is a different
failure with a dev-only cause: `reactStrictMode` double-mounts `FileExplorerPanel`, the
second pass's `loadDir(null, "")` takes a higher `seqRef` than the directory load the
open-request started in the first pass, and the roots listing wins the race. It does not
reproduce in a production build, which is why §3 says to use one. It is also not
nothing: the same mount effect is what leaves `roots` empty in production, which is
`2d`.
