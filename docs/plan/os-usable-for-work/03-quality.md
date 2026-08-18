# 03 — Quality: os-usable-for-work

This project is about instruments that lie. Its own instruments must not.

Governing rule for every test in this document:

> **A test that cannot fail is not a test.** Before accepting an assertion, flip the input across the
> boundary in **both** directions and confirm the assertion changes verdict. An assertion over a clause
> shared by every branch passes at every fixture value and proves nothing — this fleet has shipped that
> defect before.

---

## 1. Test strategy

### 1.1 The four levels and what each is for

| Level | Runner | Scope | When |
|---|---|---|---|
| **Unit** | `pnpm test` → `tsx --test src/lib/*.test.ts` | pure functions and I/O boundaries with fixtures — path resolution, hashing, URI encoding, classification, conflict logic | every builder task, before its commit |
| **Integration** | `tsx` script against a **scratch database** or a **fixture vault**, out of the worktree | route → db → store, with a real Postgres and a real filesystem | every backend phase |
| **End-to-end (browser)** | headless Chrome + the phase-1 cookie harness against a throwaway `next start` **from the worktree** | the rendered surface, as Konrad sees it | every UI phase |
| **Live read-only observation** | explicitly-briefed scout tasks only | reproducing a complaint against production data before anyone changes code | phase 0/1 of each lane |

**Never** run integration or e2e against the live API or `/opt/forge-ai-os`. The one exception is the
phase-7 deploy/verify task, which is briefed for it.

### 1.2 The vault fixture — mandatory for lane 1

No lane-1 test touches `/opt/obsidian-vault`. Every test runs against a temp fixture vault created by
the test itself:

```
<tmpdir>/fixture-vault/
  Daily/2026-08-18.md          normal note with ## Tasks / ## Notes / ## Journal
  Notes/with spaces & sym.md   exercises URI encoding and the shell
  Notes/unicode — em dash.md   exercises non-ASCII encoding
  Empty.md                     0 bytes            → empty_file classification
  Frontmatter.md               frontmatter only   → frontmatter_only classification
  Draw.excalidraw.md           excluded extension → excluded_extension
  .trash/deleted.md            must never be reachable
  .obsidian/app.json           must never be reachable
```

Set `OBSIDIAN_VAULT_DIR` to the fixture for the duration. A test that mutates the real vault is a
defect in the test suite, and the reviewer greps for hardcoded `/opt/obsidian-vault` in every lane-1
test file.

### 1.3 The browser harness — built once, asserted every time

Phase 1 builds it (architecture §0.2) and commits it as
`docs/plan/artifacts/os-usable-for-work/phase1/browser-harness.md` plus a runnable script. Every
subsequent browser task uses it and every browser task must begin with:

```js
// FIRST assertion of every browser test, before anything else is believed.
if (/\/signin\b/.test(page.url())) {
  throw new Error(`auth wall: landed on ${page.url()}. FIRST SUSPECT IS THE SALT, not the secret: ` +
    `an https AUTH_URL (production, and :7701) needs salt AND cookie name ` +
    `"__Secure-authjs.session-token" with secure:true; a plain http throwaway harness needs ` +
    `"authjs.session-token" with secure:false. A wrong salt is a 307 that looks exactly like an ` +
    `expired token. Every screenshot after this point would be of the login page.`);
}
```

**Two salts — see `02-architecture.md §0.2`.** The throwaway `next start` from this worktree runs an
http `AUTH_URL` and takes `authjs.session-token`. The live UI runs an https `AUTH_URL` and takes
`__Secure-authjs.session-token`, as both the cookie name and the JWE salt, with `secure: true` (CDP
rejects `secure: false` on a `__Secure-` prefixed name outright). Getting it wrong has already cost
this fleet two rounds. Reviewers check that any test targeting `:7701` or the https host uses the
secure salt.

Without it, an agent screenshots `/signin`, sees no memory notes, and files "memory surface renders
empty" — inventing exactly the class of defect this project exists to remove. **This assertion is
itself checked by the reviewer** in every browser test file.

### 1.4 Screenshot discipline

- Written to `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png`, `<stamp>` compact UTC ISO-8601,
  `<label>` lowercase `[a-z0-9-]`.
- **Read back with the Read tool** so they render inline in the run transcript. A shot only written is
  invisible to Konrad.
- Copied into `docs/plan/artifacts/os-usable-for-work/phase<N>/` and committed — `/opt/ai-os/uploads`
  is not permanent.
- **Before** shots are taken before the first line of code changes. A fix for a defect nobody
  photographed is a guess (project rule; see also the two premises this project's recon overturned).

### 1.5 Reproduce-before-fix, per complaint

| Complaint | Reproduction that must exist before any edit | Phase |
|---|---|---|
| Cannot edit vault notes | `curl` showing `routes/vault.ts` exposes only append/note/daily — a 404/405 on any write attempt | 1 |
| Counts wrong | live `GET /api/memory/counts` output quoted verbatim | 1 |
| 67 files unindexed | the three-way `find`/`psql` reconciliation, in full | 1 |
| Open in Obsidian does nothing | DOM dump of `MemorySurface.tsx:803` showing no handler | 2 |
| Weird font | `document.fonts.check` + `getComputedStyle` + font network status | 2 |
| 3D graph broken | live `GET /api/memory/graph` returning `{"nodes":[],"links":[],"triples":0}` + screenshot | 2 |
| Goals/Journal/Map/Library dead | four screenshots | 3 |
| Claude/Google/agy/GitHub not connectable | screenshot of settings + the live status payloads | 4 |
| Businesses tab weak | screenshot + the hardcoded inventory's as-of date | 5 |
| Pipeline not real | live `GET /api/pipeline` + `pm2 list` side by side | 5 |
| Projects tab lags | React commits + DOM node count + network trace | 6 |
| 124 reminders | the status/source breakdown from live SQL | 6 |

Recon for several of these was completed in round 0 and is recorded in `00-vision.md §2` **with the
commands that produced it** — those may be cited rather than repeated. Everything else is reproduced
by the phase that fixes it.

---

## 2. Per-requirement test map

Only the assertions that need care are expanded. Where `01-requirements.md` already states the test,
it is authoritative.

### 2.1 Phase 1 — vault write path and index truth

**Unit** (`forge-control/src/lib/vault.test.ts`, new; existing tests unchanged):

| Test | Boundary flipped both ways |
|---|---|
| `resolveInVault` table | 5 rejects (`../etc/passwd`, `/etc/passwd`, `.obsidian/app.json`, `Daily/../../x.md`, `.trash/x.md`) **and** 3 accepts. A guard test with only rejects passes when the guard rejects everything. |
| sha256 stability | same bytes → same hash; **one byte changed → different hash** |
| conflict logic | matching base → write; **mismatched base → throw**, and assert the file is unchanged after the throw |
| empty-content refusal | `""`, `"   "`, `"\n\n"` refused; **`"x"` accepted** |
| non-`.md` refusal | `.png` refused; **`.md` accepted** |
| atomic write | after a simulated mid-write failure the original bytes are intact |
| snapshot mandatory | snapshot dir unwritable → PUT throws **and** the note is unchanged |
| `obsidianUri` table | spaces, `&`, `#`, `?`, `+`, em dash, nested folders; assert round-trip through `decodeURIComponent`; **assert the naive `encodeURI` output differs** so the test would fail if someone swapped the implementation |

The last row is the pattern that matters: assert against the *wrong* implementation's output too, so
the test detects a regression to it.

**Integration** (scratch DB + fixture vault):

- `index-health` against the fixture yields exactly `excluded_extension: 1`, `empty_file: 1`,
  `frontmatter_only: 1`, `unexplained: 0` — **and** adding a normal note with no embedding row makes
  `unexplained` become 1. Without that second half, the classifier could return a constant and pass.
- `counts` envelope: every top-level integer key matches `/^(vault|agent|embedded|excluded|stale)_/`;
  `measured_at` within 60 s.
- Prune: a stale row is listed by `index-health`; **no tick, startup path or read calls prune** —
  assert by grep, not by observation.
- Hard-error: kill the DB connection and assert 5xx with a message, **not** a zeroed payload. Flip
  both ways — with the DB up, assert real numbers.

**Reviewer must also run:** `git diff` on `forge-control/src/lib/vault.ts` and confirm the existing
`createNote` body is **byte-identical** to `main`, and that `appendToDailyNote` and `readDailyNote`
differ from `main` **only** in the three ways `04-phases.md` §10.1 and §10.4 rule and enumerate —
the non-ENOENT throw, the `atomicWrite` routing, and `appendToDailyNote`'s `serialiseOnPath` wrapper.
Any other change to those two bodies, and any change at all to `createNote`, is still a finding. The
write path extends this module; it must not refactor it while five other lanes are running.

The exception exists because the frozen behaviour was itself destructive — a bare `catch` that wrote
the empty daily template over an existing note, an `O_TRUNC` destination, and a read-modify-write with
no queue that lost 9 of 10 acknowledged captures. Freezing a data-loss path is not what R11 protects.

### 2.2 Phase 2 — memory surface

**Browser (e2e), each with its `/signin` guard:**

- Open a fixture note, type, save → on-disk bytes match; **and** a save with a deliberately stale
  `base_sha256` shows the conflict UI with text from both versions.
- Failed save → editor stays dirty, HTTP status and server message visible. Flip: successful save →
  editor clean.
- "Open in Obsidian" → target starts with `obsidian://open?vault=`; the caveat text and vault name are
  in the DOM adjacent to it, not in a `title` attribute.
- Counts → no numeric text node without an adjacent unit. **Flip:** inject a bare number into a fixture
  render and confirm the scraper catches it, or the scraper is a no-op.
- Graph → `nodes.length ≥ 100`, `source === "knowledge_note.links"`; screenshot shows nodes. **Flip:**
  point at an empty fixture and assert `empty_reason` names the table and row count.

**Font, measured before changed (R30):** record `document.fonts.check('12px Inter')`,
`document.fonts.check('12px "JetBrains Mono"')`, `getComputedStyle(...).fontFamily` on a sample of
memory-surface nodes, and the network status of both `fonts.googleapis.com` requests. Only then decide.
If the fix is self-hosting, the proving test is `document.fonts.check` returning true **with the
network blocked to `fonts.googleapis.com`** — the pre-fix state must fail that same test, or the fix
fixed nothing.

### 2.3 Phase 3 — placeholders

- The string "not built" (case-insensitive) is in the rendered DOM of all four surfaces **above the
  fold** (assert bounding box within the initial viewport, not merely present).
- Each renders purpose, requirement, and scheduling status.
- The nav marker renders for exactly the four unbuilt entries — **and not for the built ones**. A
  marker on everything is a marker on nothing.
- `git diff` on `DesktopApp.tsx` touches only `PLACEHOLDER_SURFACES`, `PlaceholderSurface`, and the
  placeholder branch of the render switch. This file is 2,867 lines and owned exclusively by this
  workstream; a wandering diff is a merge conflict for someone else.

### 2.4 Phase 4 — connections

- **The invariant test, run against all four integrations:** set `checked_at` to null in a fixture →
  the rendered state is UNKNOWN in amber. Set it to now with `ok: true` → CONNECTED. Set it to now with
  `ok: false` → BROKEN. Three states, three fixtures, per integration. **Twelve assertions minimum.**
- Persistence: run the Google check, `pm2 restart forge-control` **in a scratch instance on a spare
  port** (never the live one), assert the status still reports the prior `checked_at`. The current
  in-memory `lastGoogleCheck` fails this test today, which is the point.
- Staleness: a `checked_at` older than 3× the interval renders UNKNOWN, not CONNECTED.
- Verbatim errors: force a 401 from each upstream and assert the status code and message appear in the
  UI. Flip: a 200 must not show an error.
- `agy`: a unit test asserts the path constant is absolute and starts with `/`. An integration test
  spawns it **with a scrubbed `PATH`** (`env -i`) to prove it works where pm2 runs it. A test that
  passes only in an interactive shell proves nothing about production.
- Secrets: `grep -rn` the diff, the transcripts and the artefacts for the GitHub token's prefix →
  zero hits. Assert `GET /api/secrets` returns metadata only, never values.

### 2.5 Phase 5 — businesses and pipeline

- Stall flagging: against today's live-shaped fixture, all 5 QC jobs render stalled with ages 11–14
  days. **Flip:** a job with `status_updated_at` of now renders **not** stalled. Without the flip the
  assertion passes on a component that marks everything stalled.
- Unreachable-source rule: with pm2 unavailable, the surface renders "worker health unavailable:
  `<err>`". With Redis unavailable, "queue not reachable: `<err>`". **Neither may render 0 or
  "healthy".** Flip both: with the sources up, real values render.
- No writes to Content Forge: `grep` the diff for `INSERT|UPDATE|DELETE` against `content_forge` and
  for `pm2 restart` → zero hits.
- Every Businesses figure carries a probe timestamp or a visible as-of date. Assert by scraping the
  rendered surface, not by reading the source.
- Money: `git diff` shows no functional change beyond the two label corrections; the keep-cost report
  exists.

### 2.6 Phase 6 — performance and reminders

- **`projects-lag-before.md` must exist and be committed before `ProjectsSurface.tsx` appears in any
  diff.** The reviewer checks commit order, not just file existence. This is the requirement most
  likely to be quietly skipped, because the suspects are already known and the fix feels obvious.
- Before and after use the **identical** procedure. A different measurement after is not a comparison.
- Reachability: count reachable task cards before and after → equal. Windowing that also drops
  reachability trades a slow board for a lying one.
- **Reminders row count before and after phase 6 → identical.** The reviewer runs
  `SELECT count(*) FROM reminders` itself; it does not accept a reported number.
- `git diff` shows no change to `executor.ts` or to `claimDueReminders()` in `db/reminders.ts`.
- Live delivery test: create a reminder due in 1 minute, confirm it lands in the inbox, confirm its row
  flips to `delivered`. This is the one live write this project performs outside phase 7, it is
  explicitly briefed, and it creates exactly one row — which is not a deletion and is within policy.
- `reminder-dedup.test.ts` green — the R705 ordering fix must survive.

### 2.7 Phase 7 — integration and deploy

- Each integration task's brief carries the stop-on-conflict clause verbatim; no integration commit
  contains agent-authored conflict resolution.
- Install transcripts show `+ typescript` / `+ tsx`, never `- typescript`.
- Both typechecks clean, recorded verbatim.
- `gates-808.sh --strict` compared against the phase-1 baseline.
- Deploy transcript contains the detached `safe-restart.sh` invocation and **no**
  `pm2 restart forge-executor`.
- Pre- and post-deploy `BUILD_ID`s recorded; served HTML fetched and quoted showing the new one.

---

## 3. QA gates per phase

**Every** phase ends in exactly one gating reviewer that issues `VERDICT: PASS` or
`VERDICT: NEEDS_FIXES`. There is no third verdict and no implicit pass.

### 3.1 The universal gate block — run by every phase's reviewer

```bash
# 1. DEPENDENCIES FIRST. NODE_ENV=production is exported in this runtime and a bare
#    --frozen-lockfile prunes devDependencies, exits 0 saying "Already up to date",
#    and removes typescript. The tell is `- typescript` versus `+ typescript`.
cd forge-control     && pnpm install --frozen-lockfile --prod=false
cd ../forge-control-web && pnpm install --frozen-lockfile --prod=false
#    pnpm, never npm. `pnpm add` under that pruning has removed tsx and bricked the executor.

# 2. TYPECHECK BOTH PACKAGES. One clean package tells you nothing about the other.
cd ../forge-control     && npx tsc --noEmit
cd ../forge-control-web && npx tsc --noEmit

# 3. UNIT TESTS
cd ../forge-control && pnpm test

# 4. THE REPO GATE SUITE — needs `timeout 600000` on the Bash call; a shorter
#    timeout truncates the evidence and the truncation looks like a pass.
cd .. && bash scripts/checks/gates-808.sh --strict
```

**On `gates-808.sh`:** it governs every ai-os project, not the 808 lane. Several of its gates are
scoped to round 808's own commits (`forge-control/ untouched by round 808's own commits` pins
`7b961b5..HEAD`; `forbidden-file diff` pins `main...HEAD` against a round-808 file list) and will read
red or meaningless for this project. **Gate 17 is a known pre-existing red.** This is exactly why
**phase 1 captures a baseline run and commits it** as
`docs/plan/artifacts/os-usable-for-work/phase1/gates-baseline.txt`. The rule for every later phase is
**no NEW red versus that baseline** — a rule that is only decidable because the baseline exists.

Note also the `forbidden-file diff` gate's file list includes `db/projects`. If phase 6's fix requires
touching `forge-control/src/db/projects.ts` (for example to add a `LIMIT` to `listActiveTasks()`), that
gate will go red **by design**, and the reviewer must adjudicate it against the baseline and record the
justification rather than silently accept or silently fail it.

### 3.2 The design-token gate — binds every UI phase

`no-raw-colours.cjs` and the token-purity gate fail on **any** colour literal — `#rrggbb`, `rgba()`,
`hsla()` — in application code. Phases 2, 3, 5 and 6 all touch UI. Every colour comes from the existing
`tokens` object; the NOT BUILT banner (phase 3) uses the existing warning token, not a new orange. A
phase that invents a colour fails a gate that has nothing to do with its requirements, and discovers it
at the end.

### 3.3 What the reviewer must run and check, per phase

| Phase | Reviewer runs | Reviewer checks by reading | Red-team question they must try to answer YES to |
|---|---|---|---|
| **1** | universal block; new unit tests; `index-health` and `counts` against the fixture; the vault-fixture grep | `lib/vault.ts` existing exports byte-identical to `main`; no `DELETE` verb; snapshot failure aborts the write; every catch rethrows | *Can I lose a note?* Try: empty PUT, stale-base PUT, unwritable snapshot dir, traversal path, concurrent PUT. |
| **2** | universal block; browser suite; the font measurement re-run | the `/signin` guard is present in every browser test; `empty_reason` is emitted; no hardcoded `fontFamily` | *Can the surface show a number I cannot trace to a table?* |
| **3** | universal block; the four screenshots; DOM assertions | `DesktopApp.tsx` diff is confined to the placeholder branch | *Would a tired operator at 23:00 read this as broken rather than unbuilt?* |
| **4** | universal block; the 12 state assertions; the `env -i` `agy` spawn; the restart-persistence test | no positive state without `checked_at`; errors verbatim; no secret anywhere in the diff or transcripts | *Can I make something render green that has never been checked?* |
| **5** | universal block; the stall/unreachable flip tests; `grep` for Content Forge writes | every figure has a probe time or an as-of date; funnel stages match the 2026-08-04 ruling | *Does a dead probe render as a healthy zero?* |
| **6** | universal block; before/after measurements; the reminder count query **run by the reviewer**; a live delivery test | commit order — `projects-lag-before.md` precedes any `ProjectsSurface.tsx` change; `executor.ts` untouched | *Did the count change? Did a delivered reminder stop arriving?* |
| **7** | universal block; both installs; both typechecks; strict gates vs baseline; the deploy proof | no `pm2 restart forge-executor`; no force-push; integration stopped on conflict rather than resolving | *Is the thing serving traffic the thing we built?* |

### 3.4 Adversarial (red-team) review — where it is mandatory

Three phases carry risk that ordinary review does not catch. Their planners must add a **second**
reviewer briefed to **attack, not verify** — to find the input that loses data, not to confirm the
happy path.

| Phase | Why adversarial | The attack brief |
|---|---|---|
| **1 — vault write path** | This is the only place in the project that can **destroy Konrad's second brain**. Every other defect is cosmetic by comparison. | "Your job is to lose a note. Empty bodies, whitespace bodies, `null`, missing `base_sha256`, a base from a different file, traversal, symlinks, a note edited by an agent mid-request, a full disk, an unwritable snapshot dir, a 200 MB body, concurrent PUTs to one path. For each: did content become unrecoverable? Recoverable-from-snapshot is a pass; unrecoverable is a blocker." |
| **4 — connections** | Two failure modes: a credential leaking into a transcript, and a status lying about authorisation. Both are silent. | "Find one path where a status renders positive without a probe. Find one place a secret value could reach a log, a URL, a chat message or an artefact. Find one integration that reports connected when its token is revoked." |
| **6 — reminders** | The only working path to Konrad's inbox, and the phase's own goal is to hide rows. | "Find a change that stops a due reminder from being delivered. Find a way a row could be deleted. Find a grouping rule that hides a reminder that has not fired yet." |

Phases 2, 3, 5 and 7 get the standard gating reviewer. Konrad is cost-sensitive; adversarial review is
spent where loss is irreversible, not everywhere.

### 3.5 Fix cycles

A `NEEDS_FIXES` verdict does **not** auto-seed a fix cycle. Its blocker sits at HEAD into the next
phase, so **every planner checks the previous gate's verdict before planning**. Findings worth two
sentences are folded into the current task's brief rather than seeded as a round — Konrad is
cost-sensitive and a fix cycle costs a full agent.

A fix-cycle task inherits its parent's `write_set`, which makes a write-set audit against the fix row
unsatisfiable; audit against the **parent phase row** instead.

---

## 4. What "done" looks like to a reviewer

A phase is PASS when, and only when:

1. Every requirement ID in its scope has a named, run assertion — not a claim that it holds.
2. Every assertion was flipped across its boundary in both directions at least once.
3. The universal gate block ran, with `timeout 600000`, and is recorded **verbatim** — not summarised.
4. No NEW red versus the phase-1 baseline, or each new red is adjudicated in writing.
5. Every number in the phase report is accompanied by the command that produced it.
6. Every browser claim has a screenshot, Read back inline and committed to the artefact directory.
7. The diff stays inside the phase's declared `write_set`.
8. Nothing outside the worktree was written.

And the standing question, asked of every phase in this project specifically:

> **Does anything this phase shipped display a value the operator cannot trace to a source?**
> If yes, it is NEEDS_FIXES regardless of how well it works.
