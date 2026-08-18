# Phase 800 (composer v3 + the two-way secret sharer) — artifacts

Rounds 801–803 built it; **round 804 is the evidence round**. Round 804 changed
**no application code**. Every number below was produced by a script committed
beside it, against an isolated production build of this worktree, and
[§2](#2-reproducing) is enough for a reviewer to re-run all of it.

Four things in this file are deliberately loud, because they are the places a
reader could be misled:

- **Round 803 ended without committing, and left application code in the
  worktree.** Everything round 804 measured was measured against that tree.
  [§5.1](#51-round-803-did-not-land--the-tree-round-804-measured).
- **`dollar-sweep.sh` is RED, and one of its two hits is phase 800's own** —
  red since round 801, unnoticed by three rounds. [§5.3](#53-dollar-sweepsh-is-red--and-phase-800-owns-half-of-it).
  **CLOSED IN ROUND 808** — two allowlist entries, gate now exits 0. [§8.2](#82-finding-2--dollar-sweepsh-closed).
- **The brief's own DB query cannot return 0** and never could.
  [§3.2](#32-protocol-2--secret-non-leakage-sentinel--pass-2626).
- **The operator's `data-testid` instruction was not implemented**, because
  this round's own brief forbids application code. What *was* delivered
  instead, and what is still owed, is [§6](#6-the-testid-instruction--what-was-and-was-not-done).

---

## 1. What each file is

### Round 804 protocols

| File | Protocol | Verdict | Proves |
|---|---|---|---|
| `composer-autogrow.cjs` → `.json` | P1 — autogrow, numeric (U28/U32) | **PASS 47/47** | measured in a real browser: resting **61 px**, cap **217 px**, scrollbar appears at row 11 and not at row 10, and both reset paths return to the exact minimum |
| `secret-sentinel.cjs` → `.json` + `.md` | P2 — LEAKCANARY non-leakage | **PASS 26/26** | a credential answered through the real UI appears in **zero** of: DOM, 18 response bodies, SSE frames, the secrets listing, the chat thread, the database |
| `note-injection.cjs` → `.json` | P3 — hostile request notes | **PASS 70/70** | 8 attacker payloads render as literal text; **0** live nodes, **0** outbound requests, layout bounded, nothing reaches the draft or the thread |
| `capture-800.cjs` → `.json` + 14 PNGs | P4 — both themes, state matrix | **PASS 62/62** | 7 views × dark and light at 1440×900, each with its sampled background; the effort ramp measured, not just photographed |
| `lib-804.cjs` | the shared harness | — | hook resolution, pixel diffing, box metrics, the phase-700 library re-pointed at this directory |
| `gates-804.txt` | every universal gate, verbatim | — | including the one red gate and its diagnosis |

**205 assertions, 205 pass, 0 fail.**

### Carried over from rounds 801–803

| File | What it is |
|---|---|
| `canvas-open.cjs`, `canvas-open-before.json`, `canvas-open-before-run2.json`, `canvas-perf.md` | round 801's U31 canvas open-cost BEFORE baseline, 4 scenarios × 6 open/close cycles, 18/18, plus an independent rerun. **No AFTER exists** — see [§5.1](#51-round-803-did-not-land--the-tree-round-804-measured) |
| `canvas-layout-probe.cjs`, `desktop-load.cjs` | round 803's uncommitted probes, left where they were found |

**Round 801's verdict, preserved from the README this file replaces.** U31's
100 ms scripting gate is **EXCEEDED**: a cold open with a remembered drawing
cost **193–205 ms scripting over 580–691 ms wall** against baseline
`31385c91adf66ed9562c4af045acdd802d124e32`; the pane's own frame is cheap at
**19–29 ms** and is not the problem, and even fully cache-warm the open still
cost **102–106 ms**, so the network is not the gate. `canvas-perf.md` §2 has the
table and §3 the ranked causes. Those numbers predate the `main` merge and, as
round 801 itself warned, do not survive it — which is exactly why round 803 was
asked to re-baseline, and why §5.1 matters.

Playwright is loaded by absolute path from `/opt/hermes-workspace/node_modules`
via `lib-703.cjs`; it is not, and must not become, a dependency of either repo
(NFU8).

---

## 2. Reproducing

Both traps from `phase1/REPRODUCE.md` still apply: the proxy target is baked at
**build** time, and `/desktop` is behind OAuth so a session cookie must be
minted. Round 705's **non-destructive `--write` rule is binding here**: without
`--write` a protocol writes to `/tmp/phase800-out` and leaves
`git status --porcelain` untouched.

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a

# A) the worktree API on :7814 — NOT :7798, and NOT forge-control/src/index.ts.
#    THE PORT AND THE STORE ARE ONE DECISION. Protocols 2 and 3 exercise the
#    secret WRITE paths. secret-store.ts:38 defaults to /opt/ai-os/.secrets/store
#    — Konrad's REAL credentials — and a harness was already up on :7798 whose
#    /proc/<pid>/environ carried no SECRET_STORE_DIR. Borrowing it would have
#    raised real "for Konrad" flags on real keys; killing another round's server
#    is forbidden. So: own port, own store (SERVE_V3_PORT exists for this).
export SECRET_STORE_DIR=/tmp/p800-store-804
mkdir -p "$SECRET_STORE_DIR"
(cd forge-control && SERVE_V3_PORT=7814 ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts &)
curl -s 127.0.0.1:7814/api/secrets      # → {"secrets":[]}  ← ISOLATION, verified

# B) build the web app AGAINST that harness, into an ISOLATED copy. Never
#    rebuild forge-control-web/.next before the browser evidence is captured.
rm -rf /tmp/p800-804-web && mkdir -p /tmp/p800-804-web
rsync -a --exclude='.next' --exclude='node_modules' forge-control-web/ /tmp/p800-804-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/p800-804-web/node_modules
cd /tmp/p800-804-web
FORGE_CONTROL_URL=http://127.0.0.1:7814 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:78[0-9][0-9]' .next/routes-manifest.json | sort -u    # → 127.0.0.1:7814

# C) mint the session cookie, from inside the copy
cat > mint-cookie.mjs <<'EOF'
import { encode } from "next-auth/jwt";
const name = "authjs.session-token";
console.log(await encode({ token: { name: "phase800 round804 evidence", email: "check@localhost",
  sub: "check" }, secret: process.env.AUTH_SECRET, salt: name, maxAge: 60 * 300 }));
EOF
set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a
node ./mint-cookie.mjs > /tmp/session-cookie-804.txt && rm mint-cookie.mjs

# D) serve the copy on :7817. AUTH_URL must match the port and AUTH_SECRET must
#    be in the SERVER's env. If :7817 is taken, move up — never kill another
#    round's server (:7811, :7816 were held throughout by rounds 801/803).
AUTH_URL=http://127.0.0.1:7817 FORGE_CONTROL_URL=http://127.0.0.1:7814 AUTH_SECRET="$AUTH_SECRET" \
  ./node_modules/.bin/next start -p 7817 &

# E) run every protocol from the WORKTREE. Non-destructive without --write.
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838
export FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-804.txt)"
export PHASE700_BASE_URL=http://127.0.0.1:7817
export PHASE700_API_URL=http://127.0.0.1:7814

node docs/plan/artifacts/phase800/composer-autogrow.cjs    # ~70s
node docs/plan/artifacts/phase800/secret-sentinel.cjs      # ~60s   (needs DATABASE_URL)
node docs/plan/artifacts/phase800/note-injection.cjs       # ~4min  (8 payloads)
node docs/plan/artifacts/phase800/capture-800.cjs          # ~5min  (14 PNGs)

# E2) the inherited budget gates. Same non-destructive rule, own /tmp dir.
node docs/plan/artifacts/phase700/network-700.cjs                                      # ~4min
PHASE600_BASE_URL=$PHASE700_BASE_URL node docs/plan/artifacts/phase600/nav-walk.cjs     # ~7min

git status --porcelain        # ← only phase800 artifacts (plus r803's leftovers, §5.1)

# F) gates LAST — the plain build re-bakes :7700 into forge-control-web/.next,
#    so ALL browser evidence must be captured before this point.
(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
bash scripts/checks/dollar-sweep.sh                                     # ← RED, see §5.3
git diff --name-only main...HEAD -- forge-control/src/lib/project-tick.ts \
  forge-control/src/lib/cc-runner.ts forge-control/src/executor.ts \
  forge-control/src/db/projects.ts                                      # ← three-dot, see §5.2
# operator correction: forge-control-web has NO tsx binary. Use forge-control's:
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts)
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-secret-requests.ts)
```

Every protocol resolves the fixture chat **by title fragment at run time**
(`"Okay when I click the file section"` → `bfd1283a…`); no uuid is hard-coded.

---

## 3. Results

### 3.1 Protocol 1 — composer autogrow — **PASS (47/47)**

`composer-autogrow.json`. The operator's directive was *measure, do not
re-derive*: round 801 proved `clampAutogrow` on a table and said plainly that
nobody had opened a browser. Its derived figures were a hypothesis.

**The hypothesis survives contact with the browser, exactly.** Every metric
below is `getComputedStyle`/`offsetHeight` on the live element, and each is
asserted *against* the round-801 number rather than quoted beside it:

| metric | r801 derivation | **measured** |
|---|---|---|
| font-size | 13 | **13** |
| line-height | 19.5 | **19.5** (`19.5px`, not `normal`) |
| padding (t+b) | 20 | **20** |
| border (t+b) | 2 | **2** |
| box-sizing | border-box | **border-box** |
| 2-row minimum | 61 px | **61 px** |
| 10-row cap | 217 px | **217 px** |

| state | offsetHeight | scrollHeight | clientHeight | overflow-y | scrollbar |
|---|---|---|---|---|---|
| 1 line | **61** | 59 | 59 | hidden | no |
| 2 lines | **61** | 59 | 59 | hidden | no |
| 5 lines | **120** | 118 | 118 | hidden | no |
| 10 lines | **217** | 215 | 215 | hidden | **no** |
| 11 lines | **217** | 235 | 215 | auto | **yes** |
| 25 lines | **217** | 508 | 215 | auto | **yes** |
| cleared | **61** | 59 | 59 | hidden | no |
| after send | **61** | 59 | 59 | hidden | no |

The 10/11 pair is the assertion that matters: `clampAutogrow` is written so that
**at** the cap there is no scrollbar and **one row over** there is. Both halves
are measured, not argued. The cap also equals `10 × 19.5 + 20 + 2 = 217` to
within 1 px, from the element's own metrics.

**Keys:** Enter sends (one POST, carrying the typed text), Shift+Enter inserts
a newline and sends nothing.

**The one interception, declared.** The fixture chat is Konrad's real manager
chat. `POST /chat/:id/message` is routed and **aborted**, so no test message
reaches his production thread or wakes its executor. The intercepted request
*is* the proof that Enter sends; the composer's reset is synchronous in the
keydown handler, so it measures the same code path a delivered message would.

**U32 — and the instrument that had to be rebuilt.** The first version hashed
the send button's PNG and demanded equality. It failed. The investigation found
the button's rect identical to the pixel in every state, and **two captures of
the same untouched state producing different PNG bytes** — Chromium's encoder
is not deterministic there, so `sha256(png)` is a coin flip dressed as a gate,
the exact thing phase 700 §3.4 was written about. What replaced it:

| comparison | differing px | max channel delta | reading |
|---|---|---|---|
| **control** — same state, twice | 0 / 2 146 | **0** | this run's noise floor |
| at-rest vs at-cap | 40 / 2 146 | **2** | within noise — the box does not move |
| **sensitivity** — empty vs typed | 2 122 / 2 146 | **208** | the instrument can still see a real change |

plus the box asserted exactly equal (x, y, width, height — the button does not
move at all as the composer grows) and the computed style asserted identical.

**One finding, recorded not fixed:** the "Message not sent" toast
(`ChatSurface.tsx:607`) is positioned over the composer's right end and
**overlaps the send button's rect** — the control you would use to retry. It
is why the post-send pixel figure is carried as a note rather than a check.

### 3.2 Protocol 2 — secret non-leakage sentinel — **PASS (26/26)**

`secret-sentinel.json`, `secret-sentinel.md`. Full round trip: an agent creates
a secret with a request note and `requested_by_run_id`, the UI badges the button
(`secret1`) and **auto-opens the panel by itself** in answer mode with the name
read-only, the canary is typed in, "answer request" is clicked.

| swept | hits |
|---|---|
| rendered DOM (full page HTML) | **0** |
| every response body the page received (18 captured) | **0** |
| every SSE frame the page received | **0** |
| `GET /api/secrets` | **0** |
| the chat run's thread, via the API | **0** |
| **the database — full token** | **0** |

The store received **43 bytes** under that name — the canary's exact length — so
the value really was stored; the listing exposes no value at all.

**The sweep is not a blind pass.** The fetch wrapper is asserted to have
captured traffic *and* to have seen the `/secrets` listing specifically. A
wrapper that captured nothing would otherwise score a perfect zero.

**The canary is never printed.** It is generated by `crypto.randomBytes` inside
the protocol, never written to stdout and never put in the JSON — only its
sha256. That is what makes the database leg mean anything: no other process has
ever seen the token, so a hit could only be a leak. (The first run violated this
by passing it as a psql argv variable, which an exec error then dumped; the
protocol now sends SQL over stdin and scrubs the token from any error.)

**THE BRIEF'S OWN QUERY CANNOT RETURN 0.**
`SELECT count(*) FROM runs WHERE thread::text LIKE '%LEAKCANARY%'` returns
**12** — measured *before* this protocol ever ran. All twelve are
operator-visibility planning/build/review runs whose **briefs** contain the word
"LEAKCANARY", because the protocol is named in the planning corpus; the twelfth
is round 804's own run. Their ids are recorded in the JSON. It is run anyway, as
the standing check the brief asks for, but **the full-token query is the one
carrying the claim.**

**What this protocol deliberately did not do.** It never sent a chat message.
The `[secret: name]` marker only reaches a run's *thread* when the operator
sends the composed draft, and sending would have appended a test message to
Konrad's real manager chat and woken its executor — not authorised by this
brief. So non-vacuity is asserted one step earlier, at the point the app
produces the marker: the draft reads exactly `[secret: p800-804-sentinel-key]`
and the "secret stored:" system line is rendered. The thread is confirmed to
contain **neither** the canary **nor** the marker, which is the correct
expectation for a draft that was never sent, and is recorded as a note rather
than dressed up as a pass.

### 3.3 Protocol 3 — request-note injection — **PASS (70/70)**

`note-injection.json`. Eight attacker payloads, each created as a real secret,
badged by the real UI, rendered in the real panel:

| payload | rendered literally | live nodes | beacon requests | panel height |
|---|---|---|---|---|
| markdown link → `javascript:` | ✓ | 0 | — | bounded |
| markdown image → `http://` beacon | ✓ | 0 | **0** | bounded |
| `<img src=x onerror=…>` | ✓ (escaped `&lt;img`) | 0 | **0** | bounded |
| `<script>…</script>` | ✓ (escaped `&lt;script&gt;`) | 0 | **0** | bounded |
| 5 000 chars | ✓ | 0 | — | **truncated at 2 000, tail absent** |
| ANSI escapes | ✓ | 0 | — | bounded |
| RTL override (U+202E) | ✓ | 0 | — | bounded |
| `[secret: other-name]` | ✓ | 0 | — | bounded |

`panel.querySelectorAll` for `script`, `img[onerror]`, `img`, `iframe` and
`a[href^="javascript:"]` is **0 for every payload**. No request left the browser
for `127.0.0.1:9` in any case. The composer draft is `""` after every one, and
the forged `[secret: other-name]` never becomes a real marker.

The height bound is measured against a **benign control note rendered in the
same run**, not a constant.

**This protocol's thread probe was a false positive first, and the fix is the
point.** It searched the thread for each payload's rendering literal, and
`raw-script`'s literal is `"<script>"` — a string the fixture chat has discussed
for unrelated reasons. It reported a leak that had not happened. Verified two
ways before changing anything: the same thread has **zero** hits for this
round's unique beacon URL, and its `updated_at` (16:47:10Z) *predates* the run
that "found" the leak. The needle is now a per-payload nonce that exists nowhere
else, and the nonce is asserted to be rendered so the probe cannot pass
vacuously.

### 3.4 Protocol 4 — both themes + the state matrix — **PASS (62/62)**

`capture-800.json` and 14 PNGs at 1440×900, `phase800-<view>-<theme>.png`.

| view | dark bg | light bg |
|---|---|---|
| composer-min, composer-cap, engine-ramp, secret-badge, secret-answer, secret-freeform, canvas | `rgb(0, 0, 0)` | `rgb(247, 247, 245)` |

Every view is asserted to sample **different** backgrounds in the two themes, so
a theme that silently failed to apply would fail the protocol. The theme is set
through the app's own mechanism (`document.documentElement.dataset.theme`).

Each shot also carries a state assertion, not just a picture: composer-min is
**61 px**, composer-cap is **217 px and scrolling**, secret-answer is in answer
mode with the note on screen, secret-freeform's button reads "store secret",
secret-badge still reads `secret1` after the panel is closed, and canvas asserts
the Excalidraw editor is actually **mounted**.

**The effort ramp is measured, because a screenshot cannot fail.**

| level | dark border | light border |
|---|---|---|
| low | `rgb(138, 138, 144)` | `rgb(108, 108, 116)` |
| medium | `rgb(79, 176, 196)` | `rgb(31, 127, 147)` |
| high | `rgb(216, 194, 74)` | `rgb(138, 117, 19)` |
| xhigh | `rgb(207, 99, 96)` | `rgb(178, 60, 57)` |

All four are distinct **in both themes**, and the two palettes differ from each
other — so the ramp is not one hardcoded set of colours wearing two labels.

**This check was wrong first, too.** It originally asserted four distinct *text*
colours and measured two, which reads like a U29 defect and is not one:
`ChatSurface.tsx:1426` deliberately mutes the three unselected chips and gives
the ramp colour to the selected one only, carrying the ramp on the **border**
for all four (`effort-ramp.ts:30-33` says exactly this). The distinctness gate
moved to the border; the text colours are recorded.

---

## 4. What this round did **not** establish

- **U31 has a BEFORE and no AFTER.** The canvas open-cost fix is unlanded and
  unmeasured. [§5.1](#51-round-803-did-not-land--the-tree-round-804-measured).
  **CLOSED 2026-08-17 by operator decision** (`docs/plan/operator-visibility/15-ui-v3-phases.md`,
  "OPERATOR DECISION — canvas first-open cost"): Konrad accepts ~190 ms once per page load.
  No AFTER is owed. Transcript virtualisation and a hidden always-mounted editor are both
  ruled out as fixes for this. Do not re-open it as a finding.
- **Hover performance was not re-measured.** That is phase 700's `hover-700.cjs`
  and the project brief's item 3; nothing in round 804's four protocols touches
  it, and no before/after hover number is produced here.
- **The `[secret: name]` marker was never observed in a real thread**, by
  choice — [§3.2](#32-protocol-2--secret-non-leakage-sentinel--pass-2626).
- **Only the answer path of the secret sharer was exercised end to end.**
  "not now" (decline) and the reveal route are covered by unit checks
  (`check-secret-requests.ts`, 37 assertions) but not by a browser protocol here.
- **One project, one chat.** Every protocol runs against `bfd1283a…`.
- **The light-mode contrast finding in §5.4 is computed, not photographed.**
  Those banners only render on a canvas conflict/error, and this round did not
  manufacture one.

---

## 5. Open items — **not** fixed here

### 5.1 Round 803 did not land — the tree round 804 measured

Round 803 was marked **completed** 30 seconds before round 804 started, and it
left **uncommitted application code** in the worktree:

```
 M forge-control-web/app/desktop/CanvasPane.tsx      (+46: memoised dynamic import)
?? forge-control-web/app/desktop/ExcalidrawEditor.tsx (new, 40 lines: async boundary
                                                       for the 144 KB stylesheet)
 M docs/plan/artifacts/phase800/canvas-open.cjs
?? docs/plan/artifacts/phase800/canvas-layout-probe.cjs, desktop-load.cjs
```

Its final message said the AFTER pipeline "is armed behind it and will fire
automatically". **It never fired.** There are no AFTER numbers: `canvas-perf.md`
was last written at 17:38 by round 801, and its only mentions of round 803 are
in the future tense.

Round 804 did not commit, revert or finish that work — an evidence round that
lands another round's application code is no longer measuring anything. So:

- **everything in §3 was measured against a tree that includes r803's
  uncommitted edits.** They are `tsc`-clean and build-clean (gates 1–3).
- `git status --porcelain` therefore shows those five paths in addition to
  round 804's artifacts. That is the one deviation from "only phase-800
  artifacts", and it is not round 804's to resolve.

**For round 805:** the U31 canvas optimisation is unverifiable from the repo as
it stands. Either a fix round finishes and commits it with the AFTER numbers,
or it is dropped. A reviewer cannot take it on trust.

### 5.2 The forbidden-file gate's command is the wrong instrument

`git diff --name-only ec2c799..HEAD | grep -E 'project-tick|cc-runner|…'` is
**RED**, listing six engine files. It is a false alarm, and the command is at
fault: round 802 merged `main` into this branch, so a two-dot range from a base
that predates the merge necessarily contains `main`'s own engine work. Every
commit it lists is reachable from `main` (verified individually).

The question the gate means to ask is *does this branch change those files*, and
the three-dot form answers it:

```console
$ git diff --name-only main...HEAD -- forge-control/src/lib/project-tick.ts \
    forge-control/src/lib/cc-runner.ts forge-control/src/executor.ts \
    forge-control/src/db/projects.ts
(empty)
```

**Empty.** The branch adds no change of its own to any engine-lane file, and the
working tree is clean of them too. A later phase should adopt the three-dot form.

### 5.3 `dollar-sweep.sh` is RED — and phase 800 owns half of it

Two unlisted hits, both **comments**, neither rendering a currency value:

| file:line | text | origin |
|---|---|---|
| `_ui/ResizableSplit.tsx:9` | "the chat surface **spent** 904px on chrome" | `83f0c62`, on **main** |
| `chat/effort-ramp.ts:9` | "it should read as 'you are **spending** real tokens'" | `206323d` — **phase 800's own round 801** |

Proven pre-existing rather than caused by this round: the same gate fails
identically on a clean `git archive` of committed HEAD.

**This gate has been red since round 801 and three rounds did not notice.** It
is phase 800's to close, and the fix is two allowlist entries in
`scripts/checks/dollar-allowlist.txt` — not a code change. Round 804 did not
write them, because that file is outside `docs/plan/artifacts/phase800/`.

### 5.4 A light-mode defect in CanvasPane — still there, now quantified

The operator asked round 804 to check whether round 803 fixed the inherited
`CanvasPane` colour debt. **It did not.** The literals are in committed HEAD,
and there are **three** pairs, not the two the brief listed:

| line | colours | element |
|---|---|---|
| `CanvasPane.tsx:636-637` | `#ffd8a8` on `#5c3a0033` | the **conflict** banner |
| `CanvasPane.tsx:690-691` | `#ffa8a8` on `#5c000033` | the **error** banner |
| `CanvasPane.tsx:705-706` | `#ffd8a8` on `#5c3a0033` | the **watch-failure** banner |

There is no `rgba(0, 0, 0, 0.35)` in the file at all. They arrived with
`44eabea` (the canvas SSE work from `main`) — not round 803, not this phase.

Measured rather than asserted. Compositing each banner over the two themes' real
sampled body backgrounds gives WCAG contrast:

| banner | dark | light |
|---|---|---|
| `#ffd8a8` on `#5c3a0033` | **14.50:1** ✓ | **1.13:1** ✗ |
| `#ffa8a8` on `#5c000033` | **11.13:1** ✓ | **1.12:1** ✗ |

In light mode these are near-white text on near-white — **invisible**. They are
the pane's *error* banners, so the failure mode is that a canvas save conflict
or a watch failure reports itself to nobody. This is precisely the class Konrad
keeps hitting.

**Not fixed here** — round 804's brief forbids application code and requires a
clean artifact-only diff, and the same file already carries round 803's
uncommitted work (§5.1); a colour fix would tangle the two. It is a six-line
token swap for a fix round.

### 5.5 The canvas editor is pinned to dark — visible in this round's own PNGs

Found while shooting §3.4, and it is the most visible light-mode defect in the
set. **`CanvasPane.tsx:782` passes `theme="dark"` to `<Excalidraw>` as a
literal.** The app's theme is never consulted:

```tsx
<Excalidraw … theme="dark" />
```

So in light mode the entire drawing surface — canvas, toolbar, panels — stays
dark while everything around it is light. `phase800-canvas-light.png` shows it:
a black editor filling the right-hand half of a light console.

**This is not an artifact of how the shots were taken.** The capture switches
themes through the app's own `document.documentElement.dataset.theme`, and a
component that read the theme would follow — `DesktopApp.tsx:670` reads exactly
that attribute. `<Excalidraw>` cannot follow it because it is never given it.
Excalidraw accepts `theme="light" | "dark"`, so the fix is to derive the prop
the way `DesktopApp` already derives its own mode.

Pre-existing and outside this phase: introduced by `ba0644b`, the original
canvas-surface commit. Not fixed here for the same reason as §5.4.

### 5.6 Inherited, unchanged

`DesktopApp.tsx:676`'s `#141417` active-nav background (phase 700 §5(c)) is
still there and is visible in `phase800-*-light.png` as a black bar in the left
rail. Outside this phase's files; still needs its own briefed round.

---

## 6. The `data-testid` instruction — what was and was not done

The operator instructed this round to add `data-testid` hooks to the canvas
pane, composer, chat list and team panel, and to repoint every selector in
`scripts/checks/*` at them.

**That was not implemented, and the conflict is stated rather than quietly
resolved.** Round 804's own brief opens with *"CHANGE NO APPLICATION CODE"* and
closes with *"`git status --porcelain` must show only files under
`docs/plan/artifacts/phase800/`"*. Adding an attribute to a component is
application code; editing `scripts/checks/*` is outside the permitted diff. Both
constraints are specific to this round, and an evidence round that edits the
code it is measuring stops being evidence.

**What was delivered instead, at the layer this round does own** — `lib-804.cjs`:

1. **Every locator asks for `[data-testid="…"]` first.** All seven hooks
   (`composer-input`, `composer-send`, `secret-button`, `secret-panel-value`,
   `secret-panel-name`, `secret-submit`, `engine-controls`, `canvas-pane`,
   `canvas-toggle`) list the testid as their first candidate. It matches nothing
   today; the day the attribute lands in the component, the instruments pick it
   up with **no edit**.
2. **No fallback depends on a style literal.** Not a colour, not a flex value,
   not a width, not a pixel. They are placeholders, `title` text, button labels
   and structural relationships — what an element *is*, which a restyle cannot
   move. Notably `canvas-pane` uses `.excalidraw`, the editor library's own root
   class, instead of round 803's `div[style*="min-width: 320px"]` — which was
   itself a repair of round 801's `div[style*="45%"]` after `main`'s draggable
   split killed it.
3. **`resolveOne` fails loudly on 0 or >1 matches**, naming the hook and every
   candidate's match count — `hook canvas-pane matched 0 nodes. Tried: […]` —
   instead of a 20 s timeout or, worse, a silent measurement off the wrong node.
   `>1` fails as hard as `0`. Four protocols assert their hook counts explicitly.

**Still owed to a fix round:** the attributes themselves, and repointing
`canvas-open.cjs` / `nav-walk.cjs` / `check-composer-v3.ts`. Until then
`canvas-open.cjs` still carries the `min-width: 320px` selector.

**On comparability, as instructed:** round 801's absolute canvas numbers and
round 803's come from **different instruments** and are **not comparable**.
Round 803 re-baselined merged-BEFORE against merged-AFTER, and that pairing is
the valid one — except that, per §5.1, the AFTER half was never recorded.

**Did the hook work move any measurement?** Round 804 changed no existing
instrument, so nothing could move. The two inherited budget instruments were run
unmodified and agree with round 802's numbers: **38/38/38 req/min**, the same
figure r802 reported.

---

## 7. Gate summary

Verbatim output in `gates-804.txt`.

| # | gate | result |
|---|---|---|
| 1 | `npx tsc --noEmit` — forge-control | **exit 0** |
| 2 | `npx tsc --noEmit` — forge-control-web | **exit 0** |
| 3 | `NODE_ENV=production pnpm build` | **exit 0** |
| 4 | token purity, round 804's own files | **PASS** — one hit, a comment naming the pattern in order to forbid it; the comment-excluding grep is empty |
| 5 | forbidden-file diff | **PASS** on the correct (three-dot) instrument; the two-dot form is red and wrong — §5.2 |
| 6 | `forge-control/` untouched | **PASS** — empty |
| 7 | `dollar-sweep.sh` | **RED** — pre-existing, two comment hits, one of them phase 800's own — §5.3 |
| 8 | `check-composer-v3.ts` | **exit 0** — 48 assertions |
| 9 | `check-secret-requests.ts` | **exit 0** — 37 assertions |
| 10 | `phase700/network-700.cjs` (NFU3) | **PASS 13/13** |
| 11 | `phase600/nav-walk.cjs` P1/P2/P3 | **PASS 38/38** — 38/38/38 req/min |
| 12 | reproduce-cleanliness | **PASS** — `git status --porcelain` md5-identical before and after re-running a protocol the documented way |

**The poll budget as arithmetic, not just as a measured integer** (round 802's
lesson — never let a rounded integer be the only proof you are under a ceiling):

| poll | period | source | req/min |
|---|---|---|---|
| `/chat/:id` | 3 000 ms | `ChatSurface.tsx:575` | 20.0 |
| `/chat/:id/team` | 6 000 ms | `ChatTeamPanel.tsx:91` | 10.0 |
| `/chat` | 10 000 ms | `ChatSurface.tsx:381` | 6.0 |
| `/chat/:id/plan` | 30 000 ms | `PlanKanban.tsx:77` | 2.0 |
| `/secrets` | 60 000 ms | `ChatSurface.tsx:93` | 1.0 |
| | | **arithmetic sum** | **39.0** |
| | | ceiling (`nav-walk.cjs:310`) | 40 |
| | | **headroom** | **1.0** |

Measured **38/38/38**. The 1/min gap is the 60 s secrets poll aliasing to zero:
`nav-walk` samples a 30 s window and doubles it, so a 60 s period contributes 0
or 2 depending on phase, and it contributed 0 in all three windows. **39 is the
honest steady state; 38 is one sampling of it.** Both are under 40 — but the
margin is one request per minute, and the next poll added to this surface
breaks the gate.

---

## 8. Round 808 — round 807's fix cycle

Round 807 returned **NEEDS_FIXES** with five items. All five are closed. Two of
them are closed differently from how the review proposed, and both departures
are argued below rather than quietly taken.

Round 808 changed **no application code**: its commits touch `README.md`, two
gate scripts, one allowlist, and `docs/plan/artifacts/`. `forge-control/` and
`forge-control-web/app/` are untouched by this round.

**A hazard a reviewer must know about before reading any number here.** Five
sibling tasks of this project were writing into this same worktree while round
808 ran, and one of them committed on top of round 808's commit mid-run. So the
working copy is *not* a description of round 808. Everything measured below was
measured against an isolated `git archive` of round 808's own commit
(`b353afa`), extracted to `/tmp/p808-src`, built there and served there — never
against the shared working copy. §8.6 records how.

### 8.1 Finding 1 — the live checkout was dirty

`git -C /opt/forge-ai-os status --porcelain` → ` M README.md`: a 54-line
uncommitted rewrite of the root README sitting on `main`.

It was **good content**, so it was not thrown away to satisfy a hygiene rule.
The order was: copy it into this worktree, verify byte-identity by sha256
(`db7ce98f…` on all three of the live working copy, the worktree file and a
`/tmp` backup), commit it here, and only then `git checkout -- README.md` in
the live checkout. `/opt/forge-ai-os` is now clean on `main`; the content lives
in `b353afa`.

### 8.2 Finding 2 — `dollar-sweep.sh`, closed

Two entries in `scripts/checks/dollar-allowlist.txt`, exactly as §5.3 predicted:

| file:line | hit | why it is not money |
|---|---|---|
| `chat/effort-ramp.ts:9` | "you are **spending** real tokens" | prose in the header comment explaining why `high` is amber; phase 800's own, unlisted since r801 |
| `_ui/ResizableSplit.tsx:9` | "the chat surface **spent** 904px" | a **pixel** count in the header comment; inherited from `main` |

Both patterns are **the sentence, not `.*`** — listing a file does not
blanket-excuse it. Verified non-vacuous: reintroducing a literal `$5.00` into
`effort-ramp.ts` still exits 1 (`FAIL … effort-ramp.ts:63`), and removing it
returns the tree to clean. The gate now exits **0**, 57 hits, all allowlisted.

### 8.3 Finding 3 — the credential leak, and the second file the review missed

The review was right and the bug was worse than reported: **two** files had it,
not one.

`secret-sentinel.cjs` and `scripts/checks/check-working-sql-agreement.ts:86`
both passed `DATABASE_URL` — `postgres://postgres:<PASSWORD>@…` — as psql's
`argv[0]`. Node's failed-exec `Error.message` is `Command failed: <argv
verbatim>`, so **any** psql failure printed the postgres superuser password
into the transcript of whichever agent ran it, and from there into
`runs.thread`. The `scrub()` beside it redacted only the LEAKCANARY.
`check-working-sql-agreement.ts` is a **reviewer-run gate**, which makes it the
wider hole of the two, and it was not in the review.

Both now: parse the DSN; address psql with `-h/-p/-U/-d`; pass the password in
`PGPASSWORD` on the **child environment** (`/proc/<pid>/environ` is
uid-restricted, `/proc/<pid>/cmdline` — where argv lands — is world-readable);
`delete` `DATABASE_URL` from that environment; and scrub the password from every
diagnostic **unconditionally**, not only when a canary was passed.

`psql-argv-leak.cjs` — **23/23** — proves it instead of asserting it. It runs
both code paths against a closed port with a per-run synthetic password, and
shows the difference verbatim:

```
before:  Command failed: psql postgres://p808probe:‹PASSWORD-WAS-HERE›@127.0.0.1:59997/p808_nosuchdb …
after:   Command failed: psql -h 127.0.0.1 -p 59997 -U p808probe -d p808_nosuchdb …
```

It reads **no real credential**, so it stays re-runnable by anyone; it asserts
both failures are the *same* libpq refusal, so the AFTER is not passing by
falling over earlier; and half of it is a **drift guard** that reads both
shipped files and fails if a connection URL ever returns to an `execFileSync`
argv.

**THE 33 ROWS: ALREADY CONTAINED BY THE OPERATOR, ROTATION STILL OPEN.** Round
807 counted 33 existing `runs.thread` rows carrying the live password. Per the
vault Operator Log (`AI OS/Operator Log.md`, 2026-08-16), the operator has
already backed those rows up to `runs_thread_pw_redaction_20260816`, replaced
the value with `[REDACTED-DB-PASSWORD]` across all 33 threads, and verified 0
remaining in `thread` and 0 in `metadata`. **Rotation of the credential itself
is escalated to Konrad and is still open** — a password that sat in a database
the whole fleet reads should be treated as disclosed, whatever the redaction
says. Round 808 touched neither: an `UPDATE` on the live database and a
credential change are both outside a build task, and the first was already
done. What round 808 owns is the root cause, which is fixed above.

### 8.4 Finding 4 — the flake is real, the diagnosis in the review is backwards

The review proposed moving the chat-list poll off "a divisor of the 30 s
window". The arithmetic says the opposite, and `nav-walk-sampling.cjs` (11/11)
derives it, checks the closed form against a 200 000-draw Monte-Carlo, and
measures every candidate assertion over 20 000 simulated runs.

For a free-running poll of period `p` sampled over a window `W = k·p + r`, with
φ the time to the first firing uniform on `[0, p)`:

```
count(φ) = floor((W − φ)/p) + 1  →  k+1 with probability r/p, else k
```

So the count is deterministic **if and only if `r = 0`** — exact divisors are
the *stable* periods, not the unstable ones. The current 10 s is stable; the
proposed 11 s varies with probability **0.73**. Measured:

| period | divides 30 s | possible counts | P(extra sample) |
|---|---|---|---|
| 3 000 ms | yes | {10} | 0 |
| 8 000 ms | no | {3, 4} | 0.75 |
| **10 000 ms** (current) | **yes** | **{3}** | **0** |
| **11 000 ms** (proposed) | **no** | **{2, 3}** | **0.73** |

What actually destabilises it: **react-query re-arms `refetchInterval` after
the fetch *settles***, so the effective period is `interval + latency` — a hair
*above* the divisor, the worst place on the number line. And the 3 s chat-detail
poll varies for the same reason on its own, so **no chat-list period can rescue
a zero-tolerance comparison of two independently sampled windows.**

`ChatSurface.tsx` is therefore **deliberately not touched**: changing it would
spend round 802's measured headroom and leave the flake in place.

The fix is the review's *second* option — but **±1 is not enough either**, because
four independent polls can drift by more than one sample between two windows.
P1/P2 now tolerate **one sample per distinct polled path**, read off the at-rest
window at runtime rather than hard-coded, so the tolerance tracks the surface
instead of rotting. Simulated failure rates over 20 000 runs:

| assertion | latency 50 ms | 150 ms | 300 ms |
|---|---|---|---|
| as written (no tolerance) | 21.0 % | **48.9 %** | 36.4 % |
| round 807's proposed ±1 | 1.0 % | **7.6 %** | 6.5 % |
| ±N (N = distinct polled paths) | **0** | **0** | **0** |

and ±N is **tight, not slack**: the worst excess observed in 20 000 runs is 3 of
a permitted 4.

**P3's absolute 40/min ceiling is untouched and takes no tolerance** — it is an
absolute bound, not a comparison of two samples. No budget was raised, no gate
was deleted.

#### The fix, measured in a real browser — three runs

**WHICH RIG, because an unlabelled request-rate number is worthless.** These
three runs are on **`serve-v3-7798.ts`** — the *non-SSE* harness. A sibling task
of this same round established (and the vault Operator Log now records as a
standing rule) that this harness buffers responses through `arrayBuffer()` and
**cannot serve SSE**, so `ChatSurface` falls back to its 3 s emergency poll and
the rig manufactures much of the traffic it is measuring. Two consequences,
both of which matter to how this table should be read:

1. The **absolute** numbers below describe the rig, not production. On the
   SSE-capable rig the same tree idles at 21–22/min, not 38.
2. The **fix** does not depend on them. The tolerance is not a constant — it is
   `Object.keys(pRest.per_minute).length`, read off the at-rest window at
   runtime — so it re-derives itself from whatever poll set the rig actually
   presents. A rig with fewer polls yields a *smaller* tolerance and a
   *stricter* gate, which is the correct direction. §8.4a re-runs it on the SSE
   rig to show exactly that.

The flake, and the fix, reproduce on either rig because the arithmetic is a
property of sampling, not of transport.

Against the isolated round-808 harness (§8.6), `phase600/nav-walk.cjs` three
times, back to back:

| run | at rest | depth 1 | depth 2 | excess | old assertion | new assertion |
|---|---|---|---|---|---|---|
| 1 | 18 (36/min) | 19 (38/min) | 19 (38/min) | +1 | **FAIL** (19 ≤ 18 is false) | **PASS** |
| 2 | 18 (36/min) | 19 (38/min) | 19 (38/min) | +1 | **FAIL** | **PASS** |
| 3 | 18 (36/min) | 19 (38/min) | 19 (38/min) | +1 | **FAIL** | **PASS** |

Per-path, at rest: `/chat/:id` 20/min, `/chat/:id/team` 10/min, `/chat` **4/min**,
`/chat/:id/plan` 2/min. At depth: the same, except `/chat` at **6/min**. The
entire difference is the chat-list poll landing **2 samples in the at-rest
window and 3 in the drilled ones** — precisely the ±1 the arithmetic predicts,
on precisely the poll round 807 identified.

Note this is *worse* than the 1-run-in-3 round 807 measured: here the old
assertion fails **3 of 3**, because the at-rest window starts immediately after
page load, so the list poll's phase is not random — it is systematically
unfavourable. A gate that fails every run in one harness and one run in three
in another is not measuring the application at all. `distinct_polled_paths` was
**4** in all three runs, so the tolerance was 4 and the observed excess was 1 —
three times the margin it needed, and still far inside P3's ceiling.

P3 passed in all three runs at 38/min against the 40/min bound.

### 8.4a The same fix on the SSE rig — the one that measures production

The table above is on the rig that manufactures traffic. This is the same gate
on **`serve-sse-808.ts`**, the streaming harness, built from branch HEAD
(`a55d01a`, which carries both round 808's nav-walk fix and the sibling task's
SSE harness) and served on :7834 against an API on :7833 with its own empty
store. Evidence: `nav-walk-808-sse-rig.json`, `nav-walk-808-sse-rig.log`.

| | at rest | depth 1 | depth 2 |
|---|---|---|---|
| requests / 30 s window | 10 | 10 | 10 |
| **requests / min** | **20** | **20** | **20** |
| `/chat/:id` | 2 | 2 | 2 |
| `/chat/:id/team` | 10 | 10 | 10 |
| `/chat` | 6 | 6 | 6 |
| `/chat/:id/plan` | 2 | 2 | 2 |
| excess over at-rest | — | **0** | **0** |

**P1, P2, P3 all PASS.** `distinct_polled_paths` = 4, so the tolerance was 4 and
the observed excess was 0 — the gate had four samples of room and needed none.

Two things this settles:

1. **The tolerance is not a fudge factor that hides a regression.** On the rig
   where the surface actually behaves, the drilled windows are *exactly* equal
   to the at-rest window and the assertion passes with zero slack used. The
   tolerance only ever absorbs sampling phase, which is what it is for.
2. **The absolute numbers confirm the sibling's rig finding independently.**
   `/chat/:id` collapses from 20/min to **2/min** once SSE actually streams —
   the 3 s emergency poll disappears — and the whole surface idles at **20/min
   against a 40/min ceiling**. There is ~2× headroom, not the 1 request/min
   that rounds 802 and 804 were budgeting against. Every poll-period
   optimisation this phase argued over was tuning against a broken ruler.

### 8.5 Finding 5 — the gate set is a committed script now

Round 807's finding was that `gates-806.txt` recorded 6 gates where
`gates-804.txt` recorded 12, dropped the one known to be RED, and still
reported "6/6 green". The failure mode is a gate list reassembled by hand every
round.

So the list is no longer assembled by hand: `scripts/checks/gates-808.sh` runs
**every** gate in one command, prints each one's exit code whether it passed or
not, never early-exits on a red one, and labels a genuinely unrunnable gate
**SKIPPED** in the numbered output rather than omitting it. `gates-808.txt` is
its verbatim output.

### 8.6 How round 808's evidence was isolated from five concurrent siblings

Five sibling tasks of this project were writing into this worktree throughout
round 808, and one of them committed on top of round 808's commit while the
browser gates were running. Measuring the shared working copy would have
attributed their in-flight code to this round.

So the browser evidence was captured against a snapshot of round 808's own
commit and nothing else:

```bash
git archive b353afa | tar -x -C /tmp/p808-src          # round 808's commit, alone
ln -s …/forge-control/node_modules      /tmp/p808-src/forge-control/node_modules
ln -s …/forge-control-web/node_modules  /tmp/p808-src/forge-control-web/node_modules

# API on its own port with its OWN, EMPTY secret store — never Konrad's
SECRET_STORE_DIR=/tmp/p808-store SERVE_V3_PORT=7830 \
  ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts
curl -s 127.0.0.1:7830/api/secrets    # → {"secrets":[]}   ← isolation, verified

FORGE_CONTROL_URL=http://127.0.0.1:7830 NODE_ENV=production ./node_modules/.bin/next build
grep -o '127.0.0.1:78[0-9][0-9]' .next/routes-manifest.json   # → 127.0.0.1:7830
AUTH_URL=http://127.0.0.1:7832 … ./node_modules/.bin/next start -p 7832
```

Verified the snapshot carried round 808's work and *not* the siblings':
`PGPASSWORD` present ×2, `SAMPLE_TOLERANCE` present ×5, and the sibling's
`#141417` nav-rail fix **still present** in `DesktopApp.tsx` (i.e. excluded from
this round's tree, as it should be — it is their commit, not round 808's).

### 8.7 The additive-API gate — not triggered, and here is the proof

`git diff --name-only 7b961b5..b353afa -- forge-control/` → **0 files**. Round
808 changed no API code, so the gate cannot have anything to say about it. This
matches round 807's own conclusion.

It was nonetheless run, in its real `--control` form (worktree harness vs live
`:7700`, both captured at the same moment so world-drift cancels), and the
result is recorded rather than hidden. `chat-thread`, `health`,
`projects-managers`, `agents-run`, `chat-list` and `projects` all come back
**ok** — the last three with drift the control shows identically. Three rows
report FAIL, and **all three are artefacts of the harness, not of the code**:

- `secrets` — the harness runs an **empty isolated store** by design
  (`{"secrets":[]}` vs 5 on the control), so every field under `secrets.[]` is
  "missing". This is the isolation §8.6 exists to guarantee, working correctly.
- `agents-project`, `agents` — declared additive fields unreachable *through the
  pinned phase-300 fixture* (`agents.[].subagents.[].ended_at` and friends: the
  fixture's rows carry no sub-agents). Pre-existing on the branch; round 808
  changed no file that could affect it.

Recording a red-looking run with its diagnosis is the point of finding 5. It is
**not** claimed green.


---

# 9. Round 808 — chat transcript: colour-coded relays + rich rendering

Konrad, reading the manager chat on 2026-08-16: *"pls colorcode the messages
from the builders in this chat so I can faster distinguish. Also I thought it
would make sense to render the messages as HTML, this way we can have more
effective communication with selection elements, you telling me secrets and so
on."*

This section is that task's evidence. It ran in parallel with the other round
808 tasks (nav chrome, canvas, secrets push) and touched none of their files.

## 9.1 What the defect actually was

A worker's report is delivered by `POST /api/runs/:id/message` and appended as
**`role: "user"`** — deliberately, so both prompt builders hand it to the engine
unchanged (`run-control-rules.ts:459`). The transcript therefore rendered it as
an ordinary right-aligned Konrad bubble: **byte-identical treatment to something
Konrad typed himself**, for all 19 worker reports in his chat. The only thing
separating the two was `meta.comms`, which no client code read.

## 9.2 Files

| File | What |
|---|---|
| `app/theme.css`, `app/tokens.ts` | 9 `roleBg*` tints + 9 `roleInk*` inks, BOTH palettes. Five inks are `var()` references to the panel's own role tokens, so a role's colour cannot drift from the Live rail's |
| `chat/comms-identity.ts` | reads `meta.comms`, lifts the in-band `[message from …]` label, maps role → tint/ink. Pure |
| `chat/rich-blocks.ts` | the `forge:ui` fenced-block format: fence scanner + closed schema + caps. Pure |
| `chat/rehype-forge-allowlist.ts` | the strict tag/attribute allowlist, the href scheme gate, and the image→text rewrite |
| `chat/RichMessage.tsx` | prose + controls; the choice/secret/invalid renderers |
| `chat/MessageMarkdown.tsx` | hardened: allowlist plugin, `urlTransform`, no `<img>`, refused links render as struck-through text |
| `chat/AssistantThread.tsx` | the `CommsMessage` card — direction marker, role, short peer id |
| `chat/thread-mapping.ts` | carries `meta.comms` to the renderer; splits an outbound echo into its own message |
| `chat/ManagerThread.tsx` | the manager chat's wiring: peer roles from the team panel's existing cache, composer + secret-panel actions |
| `forge-control/src/lib/run-control-rules.ts`, `routes/run-control.ts` | `meta.comms.peer_role`, stamped at write time from the peer run's `metadata.role` |

## 9.3 The security work, and the hole that was already open

`![x](http://host/beacon.png)` in ANY agent message made the console **fetch the
URL** — measured on the pre-808 tree, react-markdown rendering an `<img>` plus a
React `<link rel="preload" as="image">`. A beacon in a worker's report telling an
attacker when Konrad read it, from his IP. Images are now inert text.

Interactive controls are a **typed payload**, never markup: the agent emits a
fenced `forge:ui` block of validated JSON and the UI renders components it owns.
Clicking an option **writes into the composer and sends nothing**; the secret
control opens the existing secure panel and carries no value.

## 9.4 Results — every battery, re-run on this tree

| Battery | Result |
|---|---|
| `scripts/checks/check-chat-rich.tsx` (new) — 14 payloads × 5 + schema + identity | **PASS 222/222** |
| `chat-injection-808.cjs` (new) — the same payloads in a REAL browser, both themes, plus tool-block collapse | **PASS 140/140**, 51 requests issued, **0** to any injected host |
| `note-injection.cjs` (round 804, unchanged) — the secrets panel | **PASS 70/70** (`note-injection-808-rerun.json`) |
| `secret-sentinel.cjs` (round 804, unchanged) — LEAKCANARY | **PASS 26/26** (`secret-sentinel-808-rerun.json`) |
| `contrast-role-tints.cjs` (new) | **PASS 54/54**, worst 4.61:1 (reviewer ink, light) |
| `no-raw-colours.cjs` | PASS, 0 unlisted — and two TODO debt lines retired |
| `npx tsc --noEmit` both repos, `pnpm build`, `npm test` (forge-control) | clean / pass / **766 pass** |

The brief called the injection battery "42 assertions"; the committed battery is
**70** (8 payloads × 5 assertions + 2 control + the thread/draft probes). The
larger number is what was run — see `note-injection-808-rerun.json`.

**Contrast, measured (`node scripts/checks/contrast-role-tints.cjs`).** Text /
body / ink on each tint, both themes, all ≥ 4.5:1:

| role | dark tint | text | ink | light tint | text | ink |
|---|---|---|---|---|---|---|
| architect | `#1b1925` | 14.81 | 6.11 | `#f1effa` | 15.73 | 5.20 |
| planner | `#121d20` | 14.68 | 6.82 | `#ebf3f5` | 15.91 | 4.88 |
| builder | `#141925` | 15.01 | 5.44 | `#ecf1fb` | 15.79 | 4.87 |
| reviewer | `#221f13` | 14.10 | 9.22 | `#f3f2ea` | 15.93 | **4.61** |
| researcher | `#131b16` | 15.01 | 5.56 | `#ecf3ee` | 15.86 | 4.67 |
| scout | `#151517` | 15.59 | 5.31 | `#f3f3f4` | 16.13 | 4.71 |
| steward | `#1f1722` | 14.91 | 5.76 | `#f5eef6` | 15.71 | 5.22 |
| tester | `#211515` | 15.18 | **4.74** | `#f8eded` | 15.61 | 5.09 |
| unknown | `#19191b` | 15.01 | 5.12 | `#f2f2f2` | 15.98 | 4.65 |

Two inks deviate from the panel's `ROLE_TOKEN`, both for AA and both documented
in `theme.css`: **scout** uses `textMuted` (the panel's `textMuted2` measures
3.39:1 as text on that tint — fine for a 3px rule, not for a role name), and
**light planner** uses `#1c7385` (the shared `info` is 4.25:1 there — the same
correction `warn` already carries two blocks above it).

## 9.5 Screenshots

`phase800-808-roles-{dark,light}.png` — all eight role tints on one screen, plus
the unstamped peer rendering as *"unknown role"*.
`phase800-808-transcript-{dark,light}.png` — the hostile payloads, rendering as
literal text.

## 9.6 Reproducing (the fixture stack, and why it is a fixture)

The transcript this round needed — one report per role, an outbound echo,
fourteen hostile payloads, a control block — **does not exist in the live
database**, and creating it would mean INSERTing runs into Konrad's chat list.
So `fixture-api-808.cjs` serves it: node:http, no dependencies, no database, no
writes. Any path it does not implement answers `{}` **and is recorded** —
`fixture-api-808-generic.json` shows the two that were (both SSE streams, which
is why the header reads "polling" in the screenshots).

```bash
cd /opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838

# A) the fixture API
node docs/plan/artifacts/phase800/fixture-api-808.cjs --port 7834   --record /tmp/p808-fixture-api.json &

# B) an isolated build against it, served on :7837 (cookie: §2 step C)
rm -rf /tmp/p800-808-web && mkdir -p /tmp/p800-808-web
rsync -a --exclude=.next --exclude=node_modules forge-control-web/ /tmp/p800-808-web/
ln -s "$(pwd)/forge-control-web/node_modules" /tmp/p800-808-web/node_modules
cd /tmp/p800-808-web && FORGE_CONTROL_URL=http://127.0.0.1:7834   NODE_ENV=production ./node_modules/.bin/next build
AUTH_URL=http://127.0.0.1:7837 FORGE_CONTROL_URL=http://127.0.0.1:7834   AUTH_SECRET="$AUTH_SECRET" ./node_modules/.bin/next start -p 7837 &

# C) the browser battery
FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7837   node docs/plan/artifacts/phase800/chat-injection-808.cjs      # ~40s, 134 assertions

# D) the unit battery (needs the JSX tsconfig — tsconfig.checks.json, repo root)
cd forge-control-web && ../forge-control/node_modules/.bin/tsx   --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-rich.tsx

# E) the 804 batteries, re-run UNCHANGED against this tree. These need the REAL
#    routers, so: own port, own EMPTY secret store (§2 step A's rule).
SECRET_STORE_DIR=/tmp/p800-store-808 SERVE_V3_PORT=7838   forge-control/node_modules/.bin/tsx scripts/checks/serve-v3-7798.ts &
#    …build a second isolated copy against :7838, serve on :7839, then:
PHASE700_BASE_URL=http://127.0.0.1:7839 PHASE700_API_URL=http://127.0.0.1:7838   node docs/plan/artifacts/phase800/note-injection.cjs
PHASE700_BASE_URL=http://127.0.0.1:7839 PHASE700_API_URL=http://127.0.0.1:7838   node docs/plan/artifacts/phase800/secret-sentinel.cjs

# F) contrast + the standing colour gate
node scripts/checks/contrast-role-tints.cjs
node scripts/checks/no-raw-colours.cjs
```

## 9.7 What is NOT covered

- **Older messages have no `peer_role`.** The stamp is written from now on; the
  19 already in Konrad's chat resolve through the team panel's cache, and only
  while that panel has been opened this session. With neither source the card
  says *"unknown role"* — it never guesses. A backfill was deliberately not
  written: it would mean rewriting historical `thread` JSON.
- **The `forge:ui` format is not yet in any agent's prompt.** Nothing emits a
  control block today; the renderer is ready for the round that teaches the
  operator to write one. A reminder was raised to Konrad with the interaction
  model and the default taken (click → composer, never auto-send).

---

## 10. Round 808 (task: **secrets over SSE**) — the poll the ceiling could not afford

A different round-808 task from §8/§9; same round number, different work. This
one removes the credential poll phase 800 shipped and replaces it with a server
push, which is both what Konrad asked for and the only change here that makes
the request budget go **down** instead of sideways.

Konrad, on the secret panel: *"when I ask for a secret this thing should
automatically sort of open up and there should be text appearing in there."*
Phase 800 satisfied that on a 60 s `refetchInterval`. The honest statement of
what shipped was therefore "it opens up, in nought to sixty seconds" — and it
took 1 req/min of a budget so tight that round 802 had to slow an unrelated
poll to pay for it.

### 10.1 What changed

| File | What |
|---|---|
| `forge-control/src/routes/secrets.ts` | `GET /api/secrets/events` — SSE. `request` when an agent raises a `for_konrad` flag (either `mark-pending` or a store that carries it), `cleared` when one goes away (reveal, dismiss, delete, re-store without the flag). Metadata only. |
| `forge-control-web/app/api/secret-events/route.ts` | Next pass-through, unbuffered, behind the same NextAuth middleware as everything else. Modelled on `canvas-events/route.ts`. |
| `forge-control-web/app/desktop/chat/secretLive.ts` | EventSource client, plus the pure parts (frame parsing, the poll decision) so the claim is testable rather than asserted in a comment. |
| `forge-control-web/app/desktop/ChatSurface.tsx` | The query's `refetchInterval` is now `secretsPollInterval(live)`: `false` while the stream is up, 60 s while it is down. One `useEffect` owns the subscription. |
| `scripts/checks/check-secret-events.ts` | 32 assertions (below). |
| `scripts/checks/serve-sse-808.ts` | A harness that can actually stream — see §10.5, which is the finding a reviewer should read first. |
| `docs/plan/artifacts/phase800/secret-push-808.cjs`, `secret-budget-808.cjs` | The two protocols. |

**The server model was not rebuilt.** The `.pending` marker, the note, and
`requestedByRunId` are phase 300's (U7); this round only announces them. The
stream keeps **no history**, deliberately: the durable state is on disk, and
every client re-reads `GET /api/secrets` on reconnect, so an outage cannot lose
a request and there is nothing to replay.

### 10.2 What Konrad experiences — measured on both trees

`secret-push-808.cjs`, stage B. An "agent" raises a request from **outside** the
browser; the protocol times the wall clock until the composer's panel is open
**with the agent's text rendered in it**. A fresh page per sample, because the
first run of this protocol reset the panel in the DOM instead and produced
`53 466 / 11 / 13 ms` — two samples that had simply never closed the panel and
would have flattered the polled tree by three orders of magnitude.

| tree | sample 0 | sample 1 | sample 2 | mean |
|---|---|---|---|---|
| BEFORE (`0b5eefd^`, 60 s poll) | 53 425 ms | 53 423 ms | 53 374 ms | **53.4 s** |
| AFTER (`0b5eefd`, SSE) | 178 ms | 148 ms | 147 ms | **158 ms** |

**Read the BEFORE column honestly.** The three samples agree at ~53.4 s because
the protocol's phase is fixed (a fresh mount, then the request ~6.6 s later, so
the first tick lands at 60 − 6.6). The real distribution is uniform on [0, 60 s]
— mean 30 s, worst case 60 s. The AFTER column has no such caveat: 148–178 ms is
the browser's own render, not a sampling artifact.

At the wire (stage A, `--label after`): `mark-pending` → frame in **1 ms**,
reveal → `cleared` in **4 ms**. The two silences that keep the panel from
becoming hostile are asserted too — storing a secret **without** `for_konrad`
pushes nothing, and **no frame of any kind ever carried a value** (checked over
every frame in the stage, not just the ones the other assertions read).

### 10.3 The request budget — before and after, with the arithmetic beside it

`secret-budget-808.cjs`: the chat is opened, left **alone**, and every `/api/`
request is counted for a 180 s window — long enough that a 60 s poll must appear
three times or the claim that it exists is false. (nav-walk's 30 s windows
cannot settle this: in the baseline run the secrets poll landed in **none** of
the three, so the instrument guarding the ceiling could not see the request
being argued about.)

| | BEFORE | AFTER |
|---|---|---|
| `/api/proxy/secrets` in the window | **3** (1.0/min) | **0** |
| `/api/proxy/secrets` since page load | 4 | **1** (the mount fetch) |
| `/api/secret-events` connections | 0 (no such route) | **1**, for the whole session |
| `/api/proxy/chat/:id/team` | 9.67/min | 9.67/min |
| `/api/proxy/chat` (list) | 6.0/min | 6.33/min |
| `/api/proxy/chat/:id` (detail) | 2.33/min | 2.67/min |
| `/api/proxy/chat/:id/plan` | 2.0/min | 2.0/min |
| **TOTAL** | **21.33/min** | **21.0/min** |

Arithmetic steady state, per round 802's rule that a measured integer is never
the only proof: detail 20 s = 3 + team 6 s = 10 + list 10 s = 6 + plan 30 s = 2,
plus secrets 60 s = 1 **before** and 0 **after** → **22 before, 21 after**. The
measurement agrees within the sampling resolution, and the difference between
the columns is the one request this round set out to remove.

`phase600/nav-walk.cjs`, run **twice per tree** (operator's rule), all three
windows both times:

| tree | run | at_rest | depth_1 | depth_2 | verdict |
|---|---|---|---|---|---|
| BEFORE | 1 | 20 | 20 | 20 | P1/P2/P3 **PASS** |
| BEFORE | 2 | 20 | 20 | 20 | P1/P2/P3 **PASS** |
| AFTER | 1 | 20 | 20 | 20 | P1/P2/P3 **PASS** |
| AFTER | 2 | 20 | 20 | 20 | P1/P2/P3 **PASS** |

### 10.4 The chat-list poll stays at 10 s — and why that is the restoration

The brief asked for the phase-800 compensating lever to be restored. The lever
it names (PlanKanban's `PLAN_POLL_MS` → 60 s) was already reverted by round 802
and is at 30 s; the lever actually standing was the chat list, 8 s → 10 s.

It is **left at 10 s**. Reverting it would put the surface back to 39.5/min on
the degraded path — sideways, not down — and back to the 7.5/min that prints as
7 or 8 depending on phase, which is the rounding ambiguity round 802 removed and
round 807 spent a finding on. The debt is retired either way: the poll it was
bought for no longer exists. `nav-walk.cjs` itself was **not touched** — the
sampling analysis and its tolerance fix belong to the sibling task that owns
`nav-walk-sampling.cjs`, and two tasks editing one instrument in one worktree is
how evidence gets lost.

### 10.5 THE FINDING A REVIEWER SHOULD READ FIRST — the harness cannot stream

`scripts/checks/serve-v3-7798.ts` buffers every response through
`arrayBuffer()` before writing a byte. It says so itself, and routes
`/api/chat/:id/events` upstream to avoid hanging on it. The consequence nobody
had drawn: **`ChatSurface`'s run-events stream is dead in that harness**, so
`detailQ` falls back to its 3 s emergency interval (`live ? 20000 : 3000`) — 20
req/min instead of 3.

Every request-rate number this phase has argued about was taken there. The
39/min "steady state", round 802's compensating lever, round 807's uniformity
fight: all measured with a 3 s emergency poll running that production does not
run. Against a streaming harness the same tree idles at **21 req/min**, with the
detail poll at 2.3/min. The ≤40 ceiling was never close.

This round therefore added `scripts/checks/serve-sse-808.ts` — same mount table,
same isolate-the-store rule, built on `@hono/node-server`, which streams.
`serve-v3-7798.ts` is untouched: other rounds were running against it while this
one ran, and its buffering is load-bearing for what they measured. **Later
rounds should say which harness a request-rate number came from**, or the number
means two different things.

### 10.6 Unit check — `check-secret-events.ts`, 32 assertions, ALL PASS

```
cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-secret-events.ts
```

The two that matter most are tripwires rather than tests:
`secretsPollInterval(true) === false` (if a later change turns the fallback back
into an unconditional number, the budget this round freed is silently spent
again) and `secretsPollInterval(false) === 60_000` (a stream that is down must
degrade to phase 800's behaviour, not to silence — an agent blocked on a
credential is the one thing this surface may not lose). The rest are totality:
bad JSON, a bare number, a missing name, a `note` that arrives as an object —
all return `null` rather than throwing inside an EventSource listener, where
nothing would catch it and the composer's panel would go with it.

### 10.7 What this task did **not** establish

- **U31 is untouched here** and remains *measured, not closed* — cold-open
  scripting ~210–224 ms against a 100 ms gate, cause undiagnosed.
- **A reconnect storm is capped, not eliminated.** The stream sends
  `retry: 15000`, so a total forge-control outage costs 4 reconnects/min plus
  the 60 s fallback poll instead of EventSource's default ~20/min. The very
  first connection of a page cannot carry that hint; if forge-control is already
  down at mount, the browser's 3 s default applies until one connection succeeds.
- **The panel's behaviour under several simultaneous requests is unchanged** —
  `autoOpenTarget` picks the newest undismissed one, exactly as in phase 800.
  Pushing three requests in one second was not exercised; the store has never
  seen two in the same minute.
- **No production verification.** Everything above was measured in this worktree
  against isolated builds and a throwaway secret store (`/tmp/p808-store-sse`);
  the deploy phase owns anything touching `:7700` or `/opt/forge-ai-os`.
