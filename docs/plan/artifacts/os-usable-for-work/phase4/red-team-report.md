# Phase 4 — RED-TEAM REPORT (R4-red)

**Workstream** `connections` · branch `project/7851068b-connections`
**Tip reviewed:** `5b36eba0359d39123e58f3b5f5cb8441bf66cf15` (`git rev-parse HEAD`, re-read immediately
before this report was written; unchanged from the tip I started on).
**Merge-base:** `3f98e67114a8a1fd12fced068e2238b51c766462` (`git merge-base project/7851068b HEAD`).
**Quality document used:** `docs/plan/os-usable-for-work/03-quality.md` (the per-project path). The
legacy `docs/plan/03-quality.md` also exists; I read both and reviewed against the per-project one, as
§2.4 and §3.3 row 4 are written for this phase.

I do not issue the phase verdict. This report is evidence for R4-gate.

---

## 0. Summary of what the three attacks found

| # | Attack | Verdict |
|---|---|---|
| 1 | A status that renders positive without a probe | **HELD** for all four phase-4 connections. **BROKEN** for a fifth row on the same panel (`ultraConnection`) and for one weak-signal path (`agy` exit 0 with no output). |
| 2 | A secret reaching a log, URL, chat message or artefact | **HELD.** No credential material anywhere. One *new* red in `check-secret-scan.ts` from a `***` placeholder — a false positive, but a nonzero exit. |
| 3 | An integration reporting connected when its token is revoked | **HELD.** All four fail closed with the verbatim upstream status and body (R58 confirmed). |

Additional gates: write-set audit found **three undeclared writes**. The most consequential structural
finding is §5 — `AgyCard` and `GitHubCard` are **not mounted on any surface**.

---

## 1. ATTACK 1 — find one path where a status renders positive without a probe

### 1.1 The four phase-4 connections: the invariant holds, in three independent layers

I read every branch of `lib/connection-status.ts`, `routes/integrations.ts`, `routes/accounts.ts`,
`app/api-connections.ts` and the four settings modules. Exactly one function in the codebase emits
`"connected"` — `renderState()` (`forge-control/src/lib/connection-status.ts:298`) — and exactly one
emits `"absent"` (`absentConnectionStatus()`, `:402`), which hardcodes `checked_at: null` and is not a
positive state. In the web layer, `state: "connected"` is produced in exactly one place:

```
$ grep -nE 'state:\s*"connected"' forge-control-web/app/desktop/settings/*.ts* forge-control-web/app/api-connections.ts
forge-control-web/app/desktop/settings/connections.ts:252:      state: "connected",
```

which is inside `summaryFromStatus()`. There are no `defaultProps` in the app
(`grep -rn "defaultProps" forge-control-web/app/` → none) and no default parameter meaning "it works".

Claude accounts carry three independent vetoes, each of which alone forces UNKNOWN:
`effectiveHealth()` (`lib/account-health.ts:171`), `renderSafeAccount()` (`accountRegistry.tsx:167`)
and `claudeConnection()` (`connections.ts:325`).

### 1.2 I tried to break it — five mutations against the pure layer

Method: `git archive HEAD` into `/tmp/redteam-tree` (never the worktree), mutate one rule, re-run
`scripts/checks/check-connection-states.ts`, restore, verify by sha256.

```
$ git archive HEAD | tar -x -C /tmp/redteam-tree     # tip 5b36eba
$ cd /tmp/redteam-tree/forge-control-web && ../forge-control/node_modules/.bin/tsx \
    --tsconfig ../tsconfig.checks.json ../scripts/checks/check-connection-states.ts
ALL PASS — phase 4 connection states (4 integrations × {null, fresh-ok, fresh-fail, stale}, R50/R51/R57/R58)
```

| Mutation | What it simulates | Result |
|---|---|---|
| **M1** `if (false && status.checked_at === null)` | R57 deleted in the web layer | **KILLED** — throws `the google connection's checked_at null is not a parseable timestamp`, exit 1 |
| **M2** `STALE_FACTOR = 3` → `100` | a 45-minute shelf life silently becoming 25 hours | **KILLED** — 17 FAIL lines, exit 1 |
| **M3** `status.identity ?? "configured-not-verified@example.com"` | a configured address substituted for a missing probe identity (R50's exact failure) | **SURVIVED — `ALL PASS`, exit 0** |
| **M4** broken `detail` replaced by "This connection failed. Please try again." | R58 paraphrase | **KILLED** — 6 FAIL lines, exit 1 |
| **M5** the `claudeConnection` veto removed | stored `healthy` with no probe goes green | **KILLED** — 8 FAIL lines, exit 1 |

And three against the server layer (`forge-control/src/lib/connection-status.ts`, run with
`tsx --test src/lib/connection-status.test.ts src/lib/account-health.test.ts`, baseline 84/84):

| Mutation | Result |
|---|---|
| **S1** `renderState`'s null-`checked_at` rule deleted | **KILLED** — 3 failed |
| **S2** `renderState`'s staleness rule deleted | **KILLED** — 4 failed |
| **S3** `writeConnectionRecord` spreads the caller's object instead of projecting four fields | **KILLED** — 1 failed |

S3 matters: the wall that stops a probe result carrying a token to disk is covered by a test that
fails when the wall is removed.

**FINDING 1 (medium) — the twelve assertions are not inert, with one hole.** M3 shows the R50 guard
(`check-connection-states.ts` §5, "a configured-only address appears in NO state's identity") does not
discriminate on the `connected`-with-`identity: null` path, because **no fixture exercises it** — every
`connected` fixture supplies an identity. That path is not hypothetical: it is the *normal* case for
`agy`. `classifyAgyProbe()` returns `ok: true, identity: null` on exit 0
(`lib/connection-status.ts:601-606`) and its own comment says "in practice this is always null" — yet
`check-connection-states.ts:147` gives the agy CONNECTED fixture
`identity: "konrad.schrein@gmail.com (Antigravity CLI session)"`, an identity `agy` can never return.
The fixture is unfaithful to the subject, so the live branch (`connections.ts:256`) is never measured.
*Fix:* add a fourth fixture per integration — `state: "connected", identity: null` — and assert the
rendered identity contains no `@` drawn from configuration.

### 1.3 THE OPERATOR'S ROW — a false statement is on screen at HEAD, and I confirmed the root cause

Measured, at tip `5b36eba`:

```
$ ls -la /root/.local/bin/agy && /root/.local/bin/agy --version
-rwxr-xr-x 1 root root 206737952 Aug 18 21:09 /root/.local/bin/agy
1.1.14

$ PID=$(pgrep -f 'forge-control' | head -1); tr '\0' '\n' < /proc/$PID/environ | grep ^PATH=
PATH=/usr/bin:/usr/local/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin

$ # agyOnPath() semantics replayed against exactly that PATH:
agyOnPath() would return: no
```

`/root/.local/bin` is absent from the live server's `PATH`, so `agyOnPath()`
(`forge-control/src/routes/usage.ts:134`) returns `false`, `cli_installed` is `false`, and
`auth_note` becomes the sentence at `usage.ts:170`. `ultraConnection()`
(`forge-control-web/app/desktop/settings/connections.ts:616-643`) renders that verbatim, and
`ConnectionsPanel.tsx:207` mounts it. Photographed in `phase4/b4c-before-integrations.png`:

> **Google AI Ultra (Antigravity CLI)** — NOT CONNECTED
> IDENTITY: no local agy profile
> HEALTH: "Antigravity CLI (agy) is not installed on this box, so the Ultra subscription has never
> been signed in here."
> TO CONNECT / REPAIR: "On the VPS: install the Antigravity CLI, then run `agy` once to sign in"

Every clause of that is false, and the remedy instructs Konrad to install software that is already
installed. `usage.ts` is **untouched by phase 4**
(`git diff --name-only <base>...HEAD | grep -c usage.ts` → `0`), and `ultraConnection()` was last
written in round 1876 (`4f6cd31`), so this predates the phase — but it is on the panel this phase
rebuilt, and it now sits directly beside phase-4 rows built to the opposite standard.

It is worse than that: **this phase's own evidence contradicts it.** In
`phase4/b4c-after-four-connections.png` the real probe reports
`SIGNED IN · /root/.local/bin/agy models exited 0 and listed 7 models`. One phase, two rows, opposite
claims about the same binary.

**FINDING 2 (high) — a probe that keys off the server's environment instead of the thing itself.**
`usage.ts:134` `agyOnPath()` measures `process.env.PATH` of the forge-control process. pm2 does not
source `.bashrc`, where the entry is set. *Fix, as S-A recommended:* delete `agyOnPath()` and derive
the Ultra row's substrate from the same evidence the phase-4 `agy` row uses — `access(AGY_BIN, X_OK)`
for presence (`routes/integrations.ts:834`) and the persisted probe record for state. Do not key on
`agy-keyring.service`: S-A found `composite_token_storage.go` uses file-based storage whenever
`SSH_CONNECTION` is set, which it is in every logged `agy` run on this box.

### 1.4 The systematic sweep the operator asked for — every row, and what its state is derived from

| Row | Evidence behind its state | Verdict |
|---|---|---|
| Claude `arved` / `claude-worker-legacy` | `claude_accounts.health` column, vetoed by `last_probed_at` + `probe_age_ms` in three layers | probe-backed ✅ |
| Google Workspace | persisted probe record (token refresh + Gmail profile call) | probe-backed ✅ |
| Gemini API key | key presence + a **session-only** verdict held in React state | under-claims (UNTESTED on reload) ⚠️ note only |
| **Google AI Ultra** | **the forge-control process's `PATH`** | **confidently false ❌ FINDING 2** |
| `agy` (phase-4 card) | `access(AGY_BIN, X_OK)` + persisted probe record | probe-backed ✅ (but unmounted — §5) |
| GitHub | secret presence → ABSENT; otherwise persisted `GET /user` record | probe-backed ✅ (but unmounted — §5) |

The Gemini-API-key row is worth one sentence to the gate: its verdict lives in a React state variable
with no persistence, so it reverts to `UNTESTED` on every reload. That is the exact shape R48 deleted
for Google — but it degrades to UNKNOWN, never to green, so it is a consistency note, not a defect.

### 1.5 One more positive state from a weak signal

```
# a stub binary that exits 0 and prints nothing, classified by the real code:
$ tsx /tmp/redteam-attack3b.ts
=== agy: a binary that exits 0 and prints NOTHING ===
state: CONNECTED | chip: SIGNED IN
identity: no signed-in Google account — the probe returned no identity
health  : probed just now. /root/.local/bin/agy models exited 0 — the CLI holds a live Google
          credential. Model list head: (exit 0 but no output)
```

**FINDING 3 (medium) — a bare exit code is treated as authorisation.** `classifyAgyProbe()`
(`lib/connection-status.ts:599`) sets `ok: true` on `code === 0` without requiring any output, so the
chip says **SIGNED IN** while the same line admits *"(exit 0 but no output)"* — a chip contradicting
its own text, which is the defect class `phase4/b4c-before-integrations.png` was filed for. Reachable
if `agy models` is ever wrapped, changes its output stream, or becomes a no-op across a version bump.
*Fix:* require a non-empty stdout for `ok: true`; a silent exit 0 is `ok: false` carrying "exited 0 but
listed no models".

---

## 2. ATTACK 2 — find one place a secret could reach a log, a URL, a chat message or an artefact

### 2.1 Token-shaped sweep of the diff, the artefacts and the research notes

```
$ PAT='ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}
      |AIza[A-Za-z0-9_-]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|"refresh_token"\s*:\s*"[^"<]{20,}
      |"client_secret"\s*:\s*"[^"<]{20,}|Bearer [A-Za-z0-9._-]{20,}'
$ git diff $(git merge-base project/7851068b HEAD)...HEAD | grep -nEo "$PAT" | sort -u     → (empty)
$ grep -rEno "$PAT" docs/plan/artifacts/os-usable-for-work/phase4/                          → (empty)
$ grep -rEno "$PAT" docs/plan/artifacts/os-usable-for-work/phase0/ docs/research/           → (empty)
```

Literal prefixes anywhere in the diff resolve to **fixtures and one UI placeholder only** —
`placeholder="ghp_… (write-only)"`, `probeGithub("ghp_TESTTOKEN", …)`,
`access_token: "ya29.SUPER-SECRET"` (a stub) — and the surrounding assertions are themselves the
guard: `assert.doesNotMatch(lastUrl, /ghp_/)` and
`assert.doesNotMatch(JSON.stringify(r), /ghp_TESTTOKEN/)`.

### 2.2 Run transcripts

```
$ psql -h 127.0.0.1 -p 5434 -U ai_os_app -d ai_os -tAc "SELECT count(*) FROM runs WHERE thread::text ~
   'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|sk-ant-[A-Za-z0-9_-]{20,}'"
0
```

Zero across the whole `runs` table, not just this project's.

### 2.3 The secret store returns metadata only (R55 second half)

```
$ curl -s http://127.0.0.1:7700/api/secrets | …
names: ['github-pat-konrad', 'github-pat-shane', 'twenty-api-key', 'twenty-crm-admin', 'twenty-crm-shane']
fields present: ['bytes', 'name', 'note', 'pending', 'requestedByRunId', 'updatedAt']
VALUE-BEARING FIELDS: NONE — metadata only
```

Note for the gate: **no secret named `github-pat` exists**, so GitHub renders ABSENT / "NO TOKEN
STORED" at HEAD. `resolveGithubToken()` (`connection-status.ts:1043`) deliberately refuses to guess
between `github-pat-konrad` and `github-pat-shane` and names both in the absent detail. That is
correct behaviour, and it means C4 is not finishable without Konrad storing the PAT under the
canonical name through the secure panel.

### 2.4 Do the probes leak on the wire? Forced, not assumed

From §3 below: the GitHub token travels in an `authorization` header, never a query string
(`lastUrl` asserted free of `ghp_`); the Google refresh token and client secret are scrubbed out of
every relayed body by `clean()` (`connection-status.ts:876`); and in every forced failure the fake
token was **absent** from the persisted detail. `writeConnectionRecord()` projects exactly four fields
rather than spreading (`:171`), and mutation **S3** proves a test fails if that is removed.

### 2.5 `scripts/checks/check-secret-scan.ts` — RED, and phase 4 added one entry

```
$ tsx scripts/checks/check-secret-scan.ts
FAIL  docs/plan/artifacts/os-usable-for-work/phase4/executor-auth-determination.md
        DSN password: postgresql://ai_os_app:***@
… 6 further pre-existing files …
7 FILE(S) FAILED — live-looking DB credential committed          EXIT=1

# baseline at the merge-base, same command, in a throwaway checkout:
6 FILE(S) FAILED — live-looking DB credential committed          EXIT=1
```

Baseline 6 → HEAD 7. **One new red, introduced by `3d915c0`.**

I verified it is *not* a live credential, comparing hashes rather than values, and by trying it:

```
doc password sha256: 596f4162a52f315b2ad0fa53  (length 3)
live password sha256: 082cddfb6e0914060fc602d4  (length 48)
$ PGPASSWORD="$DOCPW" psql -h 127.0.0.1 -p 5434 -U ai_os_app -d ai_os -tAc 'select 1'
psql: error: … FATAL:  password authentication failed for user "ai_os_app"
```

The segment is the literal `***` — an author's own redaction that trips `DSN_RE`
(`check-secret-scan.ts:55`), whose `SAFE_MARKERS` does not recognise it.

**FINDING 4 (low) — a new nonzero exit in a security gate.**
`docs/plan/artifacts/os-usable-for-work/phase4/executor-auth-determination.md:55`.
*Fix (either, not both):* reword the line so it is not DSN-shaped
(``the connection string is `postgresql://ai_os_app@127.0.0.1:5434/ai_os`, password held in …``), or
add `***` to `SAFE_MARKERS` — **scoped to that exact token**, never to the file or the directory, so a
real credential elsewhere in the same file still fails.

**ATTACK 2 VERDICT: HELD.** No credential value reaches a log, a URL, a chat message, a status sidecar
or an artefact. What I tried and why it held is above; the only red is a redaction marker.

---

## 3. ATTACK 3 — find one integration that reports connected when its token is revoked

Every upstream below is a local stub on `127.0.0.1`, every token is fake, and no real credential was
revoked or written. Harness: `/tmp/redteam-attack3.ts`, run with the worktree's `tsx`.

| Scenario | What the record/row became | Verbatim upstream present? |
|---|---|---|
| GitHub **401 Bad credentials** | `ok:false` → state **BROKEN**, chip **REJECTED** | `UPSTREAM HTTP 401: {"message":"Bad credentials","documentation_url":…,"status":"401"}` ✅ |
| GitHub **network unreachable** (port 1) | `ok:false`, `Could not reach http://127.0.0.1:1/user: fetch failed` | distinguishable from a 401 ✅ |
| Google **invalid_grant** (400) | `ok:false`, `reason: invalid_grant` | `UPSTREAM HTTP 400: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}` ✅ |
| Google **credential file deleted** | `ok:false`, `reason: no_credential`, names the path | ENOENT text ✅ |
| `agy` **binary missing** | `errno: "ENOENT"` kept separate from `code` | `Could not spawn … (ENOENT)` ✅ |
| `agy` **signed out** (exit 1, under `env -i`) | `ok:false` | `STDERR: Error: Please sign in to view available models. Launch the CLI without arguments to sign in.` ✅ |
| **clock moved a week** (all three) | `ok:true` + `checked_at` 7 days old → **UNKNOWN**, identity stripped to `null` | ✅ |
| **sidecar deleted mid-flight** | `readConnectionRecord` → `null` → **UNKNOWN**, never a retained green | ✅ |
| **sidecar corrupted** | **throws**, naming the path — a corrupt store is not a state | ✅ |

The rendered row a revoked GitHub token produces, end to end through `summaryFromStatus`:

```
state: BROKEN | chip: REJECTED
health: probed just now. GitHub rejected the stored personal access token at GET https://api.github.com/user.

        UPSTREAM HTTP 401: {"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}
```

In all three token-bearing scenarios the fake token was **absent** from the message, and Google's
refresh token and client secret were **absent** from the relayed body.

**R58 CONFIRMED.** The verbatim upstream status code and message reach the surface, not a friendly
string. **ATTACK 3 VERDICT: HELD** — no integration reports connected when its credential is refused.

*One methodological note against myself:* my first harness captured `Date.now()` at module load, before
the probes ran, so every render read `0s in the future`. That is my bug, not the subject's; re-run with
a clock taken after the record, the states are as tabulated. I record it because an instrument that
lies is this project's subject.

---

## 4. The other mandatory checks

### 4.1 N1 — no silent fallback

```
$ git diff <base>...HEAD | grep -nE '^\+.*catch\s*(\([^)]*\))?\s*\{\s*\}'      → only a comment quoting the rule
$ git diff <base>...HEAD -- '*.ts' '*.tsx' | grep -nE '^\+.*(\?\?\s*0\b|\|\|\s*\[\]|\?\?\s*\[\]|\|\|\s*0\b)'
```

Three candidates, each judged by reading the surrounding code:

- `integrations.ts:705` `stat(tokenPath).catch(() => null)` — `connected_at` is decoration, feeds no
  state, and the file was already read successfully three lines above. Acceptable, and documented.
- `ConnectionsPanel.tsx:277` `(registry.data?.accounts ?? [])` — **not** masking a failed call: the
  "No Claude account is registered" empty state only renders when `registry.data` is truthy, and a
  load failure renders `registry.error` verbatim at `ConnectionsPanel.tsx:130-143`.
- `integrationCards.tsx:957` `account?.scopes.length ?? 0` — unreachable when it would lie:
  `hasAccount: account !== null` and `googleConnection()` returns before using `scopeCount` whenever
  `hasAccount` is false (`connections.ts:457`).

No status degrades to `ok` on error anywhere in the diff. `api-connections.ts` throws
`ConnectionApiError` carrying the HTTP status **and** the raw body. N1 **holds**.

### 4.2 Files that must not be touched

```
$ git diff --name-only <base>...HEAD | grep -E 'DesktopApp\.tsx|nav-items\.ts|src/index\.ts'
none — DesktopApp.tsx, nav-items.ts, index.ts all untouched
$ git -C /opt/forge-ai-os status --porcelain
(empty)
```

`forge-control/src/index.ts` untouched ✅ · surfaces-lane files untouched ✅ · nothing written under
`/opt/forge-ai-os` ✅.

### 4.3 AGY_BIN is absolute and used everywhere

```
$ grep -rn "agy" forge-control/src
```

One constant, `AGY_BIN = "/root/.local/bin/agy"` (`lib/connection-status.ts:434`), used at every
invocation and every message. `agyBinIsAbsolute()` is asserted against `isAbsolute()` **and** against
the literal path (`connection-status.test.ts:361-364`), and a control test proves a bare `agy` fails
with ENOENT under `env -i`. R52 **holds** — for the phase-4 code. `usage.ts` is the exception, and
that is FINDING 2.

### 4.4 Write-set audit (`git log --name-only` per task vs the declared `write_set` on the task row)

| Task | Files touched | Undeclared |
|---|---|---|
| **B4a** (`3d915c0`, `f8f12e8`) | 11 | **none** ✅ |
| **B4b** (`343a65e`) | 7 | `scripts/checks/check-integrations.tsx` (+9 lines) |
| **B4c** (`5b36eba`) | 12 | `docs/…/phase4/browser-harness-phase4.cjs` (+317/−5), `docs/…/phase4/b4c-after-settings-surface.png` |

**FINDING 5 (medium) — three undeclared writes, none disclosed.** `check-integrations.tsx` is declared
by B4c and written by both B4b and B4c — exactly the two-builders-one-file collision
`04-phases.md` Phase 4 forbids. `browser-harness-phase4.cjs` is declared by **B4a** and rewritten by
B4c. There is no §10 disclosure section in this project's `04-phases.md`, and none of the three writes
is disclosed anywhere. The content of all three is legitimate and in-lane; the declaration is what
failed.

---

## 5. THE STRUCTURAL FINDING — the agy and GitHub cards are not on any surface

```
$ grep -rn "<AgyCard\|<GitHubCard" forge-control-web/app/
>>> NOTHING MOUNTS THEM <<<
$ grep -rn "<GoogleCard\|<GeminiCard" forge-control-web/app/
forge-control-web/app/desktop/settings/ConnectionsPanel.tsx:188:        <GoogleCard onFacts={setGoogle} />
forge-control-web/app/desktop/settings/ConnectionsPanel.tsx:204:        <GeminiCard onFacts={setGemini} />
```

`AgyCard` (`integrationCards.tsx:1152`) and `GitHubCard` (`:1341`) are exported and dead. The
Connections panel renders Google, the Gemini API key, Google AI Ultra and the Claude accounts — no
`agy` row, no GitHub row. The commit message "four connections, one shape" describes the *code*, not
the *screen*.

To B4c's credit this is **disclosed, not concealed**: `browser-harness-phase4.cjs:540-566` records it
as a counted blocker that fails the run, with the reason —
*"no mount point — ConnectionsPanel.tsx belongs to B4a and B4c may not write it. The card is exported;
it needs one `<Row summary={...}><Card/></Row>` block."* And `phase4/b4c-after-four-connections.png`
is honestly titled **"B4c proof mount — Throwaway page"**, not Settings.

**FINDING 6 (high) — R54 and R56 are not reachable by Konrad at HEAD.** The cards are correct and
prove themselves against the real API on a throwaway page; they simply are not mounted where he looks.
*Fix:* two `<Row summary={agyConnection(...)}><AgyCard/></Row>` /
`<Row summary={githubConnection(...)}><GitHubCard/></Row>` blocks in `ConnectionsPanel.tsx`, plus
threading `recheck_interval_ms` from `GET /api/integrations/connections`. That file is B4a's, so this
belongs to one owner in a fix cycle or to I4 — it is not something two tasks should race on.

---

## 6. Gates executed

**The repo ships a gate suite**, `scripts/checks/gates-808.sh`. Run with `--strict`, `timeout 600000`:

```
 1  0      npx tsc --noEmit — forge-control
 2  0      npx tsc --noEmit — forge-control-web
 3  0      NODE_ENV=production pnpm build — forge-control-web
 4  0      token purity — round 808's own files
 5  0      no-raw-colours.cjs (whole app)
 6  0      forbidden-file diff — three-dot main...HEAD
 7  0      forge-control/ untouched by round 808's own commits
 8  0      dollar-sweep.sh
 9  0      check-composer-v3.ts
 10 0      check-secret-requests.ts
 11 0      contrast-canvas-banners.cjs
 12 0      check-working-sql-agreement.ts — standalone typecheck
 13 0      check-stop-affordance.tsx
 14 0      check-dismiss-peek.tsx
 15 0      check-team-rows.ts
 16 0      check-team-confirm.ts
 17 0      verify-notification-gap-pins.mjs
 18 0      check-usage-fold.ts — against a real Postgres
 19 0      check-usage-fold.ts — standalone typecheck
 20 0      pnpm test — forge-control unit suite
 21 0      psql-argv-leak.cjs
 22 0      nav-walk-sampling.cjs
 23 -      phase700/network-700.cjs (NFU3) (SKIPPED)
 24 -      phase600/nav-walk.cjs — P1/P2/P3 (SKIPPED)
 25 0      reproduce-cleanliness — re-running a protocol leaves the tree untouched

 RED: 0        SUITE EXIT=0
```

**25 gates · 23 EXECUTED · 2 SKIPPED-by-design** (browser harness, not requested; `--browser` runs
them) **· 0 RED.** Gate 17, which `03-quality.md` §3.1 records as a known pre-existing red, is green
here — the pre-existing red is superseded, not suppressed.

Beyond the suite:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --prod=false` × 2 | "Already up to date"; `tsc` 5.9.3 and `tsx` both present — no `- typescript` |
| `npx tsc --noEmit` (forge-control) | EXIT=0 |
| `npx tsc --noEmit` (forge-control-web) | EXIT=0 |
| `pnpm test` (forge-control) | **1354 pass, 0 fail**, 248 suites |
| `node scripts/checks/no-raw-colours.cjs` | PASS — 222 literals, 0 unlisted |
| `check-connection-states.ts` | ALL PASS (and 4 of my 5 mutations killed it) |
| `check-integrations.tsx` | PASS |
| `check-settings-surface.tsx` | PASS |
| `check-quota-row.ts` | ALL PASS |
| **`check-secret-scan.ts`** | **EXIT=1 — 7 files, baseline 6. FINDING 4.** |

---

## 7. Findings, for R4-gate to adjudicate

| # | Sev | Location | The problem |
|---|---|---|---|
| **2** | **high** | `forge-control/src/routes/usage.ts:134,170` → rendered by `connections.ts:616` at `ConnectionsPanel.tsx:207` | `agyOnPath()` reads the *server process's* `PATH`; pm2 does not source `.bashrc`, so a row asserts `agy` "is not installed on this box" while `agy` 1.1.14 is installed and this phase's own probe reports it signed in. |
| **6** | **high** | `forge-control-web/app/desktop/settings/ConnectionsPanel.tsx` | `AgyCard`/`GitHubCard` have no mount point; R54 and R56 are unreachable on the surface Konrad uses. Disclosed by B4c as a blocker. |
| **1** | med | `scripts/checks/check-connection-states.ts:147` | Every `connected` fixture supplies an identity, so the `connected`+`identity:null` path — the normal case for `agy` — is unmeasured; a mutation substituting a configured address there passes green. |
| **3** | med | `forge-control/src/lib/connection-status.ts:599` | `agy` exit 0 with no output renders chip **SIGNED IN** while the same line says "(exit 0 but no output)". |
| **5** | med | B4b `343a65e`, B4c `5b36eba` | Three undeclared writes; `check-integrations.tsx` written by two tasks. |
| **4** | low | `docs/…/phase4/executor-auth-determination.md:55` | A `***` redaction is DSN-shaped and adds a new red to `check-secret-scan.ts` (6 → 7). Not a credential — proven by hash and by a failed login. |

Findings 1, 3, 4 and 5 are two-sentence fixes and should fold into the gate's adjudication or an
existing task rather than seed a fix cycle (N8). Findings 2 and 6 are the ones that change what the
next task must do.

---

## 8. What I did not find

- No path to a green state without a probe among the four phase-4 connections, across five mutations
  in the web layer and three in the server layer.
- No credential value in the diff, the artefacts, the research notes, the status sidecars, the URLs,
  or any run transcript in the database.
- No integration that survives a 401, a dead port, a missing binary, a deleted sidecar or a week of
  clock drift while still claiming to be connected.
- No write outside this worktree; `/opt/forge-ai-os` is clean.

---

## 9. CLOSURE — appended by round 4 (fix cycle 1), 2026-08-19

Appended, never rewritten: §1–§8 above are R4-red's record of what was true at `5b36eba`, and are
left exactly as written. This section says what happened to each finding.

| # | Sev | Status | Where the fix is, and what proves it |
|---|---|---|---|
| **2** | high | **CLOSED** | `agyOnPath()` is deleted. `routes/usage.ts` now derives the row from `agyBinaryPresent()` (`access(AGY_BIN, X_OK)`, shared with `routes/integrations.ts` so there is one substrate check, not two) plus the persisted probe record through `renderState`. Route-level proof: `check-gemini-tally.ts` §1 asserts `cli_installed === true` on this box and that the note does not say "not installed". |
| **6** | high | **CLOSED** | `ConnectionsPanel.tsx` mounts `<Row summary={agyConnection(agy)}><AgyCard/></Row>` and the GitHub equivalent, both threading `recheck_interval_ms` upward through `onFacts`. Proof: `check-settings-surface.tsx` §3 asserts all five `data-connection-row` ids in the panel's own server-rendered markup, with an anti-inert control on an id that is not mounted. |
| **1** | med | **CLOSED** | `check-connection-states.ts` §5b: a fourth fixture per integration — `connected`, fresh, `identity: null` — asserting that no address (configured or probed) reaches the identity slot, with a `discriminates()` control against the named-probe fixture. The mutation named in this report was re-run against the fix and **turned 6 assertions red**. |
| **3** | med | **CLOSED** | `classifyAgyProbe` requires non-empty stdout for `ok: true`. Exit 0 with no model list is a recorded failure carrying what was actually seen. Four new unit tests; reverting the guard turns 2 suites red. |
| **5** | med | **DISCLOSED** | All three writes are named, with commit and owner, in `docs/plan/os-usable-for-work/04-phases.md` under "Undeclared writes, disclosed", together with the `agy-flow.md` / `agy-flow-affordance.md` naming drift. Content unchanged. |
| **4** | low | **CLOSED** | `SAFE_MARKERS` in `check-secret-scan.ts` gained `^\*+$`, anchored and scoped to the exact token — never to a file or a directory. `abc***def` still fails, and a real credential elsewhere in the same file still fails (both proved by a canary file in a throwaway clone). |

### The secret scan, measured on both sides

The figure in §2.5 above (6 → 7) was taken against the **merge-base**. Re-measured at the tip this
fix cycle started from, in a throwaway clone at `07f1c4b`, the checker was failing **8** files, of
which **5** were pre-existing `***` redactions in other projects' evidence documents.

```
merge-base 3f98e67                       6 FILE(S) FAILED
tip        07f1c4b                       8 FILE(S) FAILED
after this fix cycle                     ALL PASS — 914 tracked files
```

Two further reds were closed on the way there, neither of them a credential:

- `red-team-report.md:250` — `PGPASSWORD="$DOCPW"`, a shell script READING a credential at run time.
  `SAFE_MARKERS` already recognised `${VAR}` and `$(cmd)` and flagged the third spelling of the same
  thing; `^\$[A-Za-z_][A-Za-z0-9_]*$` completes that intent, anchored.
- `check-gemini-tally.ts` header — a literal throwaway container password in the documented run line,
  pre-existing at the merge-base. The run line now generates one into a shell variable.

### The Ultra row and the agy row can no longer disagree

The finding this report opens with was two rows on one panel making opposite claims about one binary.
The fix is structural rather than textual: both rows are rendered from the **same**
`ConnectionStatus` through the **same** `summaryFromStatus`, so `ultraConnection()` no longer has an
opinion of its own to be wrong with. `check-quota-row.ts` asserts they agree across three fixtures —
not installed, signed in, and connected-with-no-clock — plus a control that those three are genuinely
three different states, so the agreement is not agreement-on-a-constant. Re-introducing the old
behaviour as a mutation reproduces the reported contradiction verbatim
(`ultra=absent/NOT INSTALLED agy=connected/SIGNED IN`) and turns the check red.
