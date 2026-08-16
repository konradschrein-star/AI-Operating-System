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
