# Phase 4 — FIX CYCLE 1 (round 4)

**Workstream** `connections` · branch `project/7851068b-connections`
**Started from** `07f1c4b` (R4-gate, NEEDS_FIXES) on top of `c792b3a` (R4-red, NEEDS_FIXES).
**Merge-base** `3f98e67`.

Six items from R4-red, three blockers from R4-gate — the same defects counted twice, plus two
fold-ins the gate named separately. All closed. What follows is what changed, what was run, and what
is left.

---

## 1. WRITE-SET — DECLARED vs ACTUAL, LOUDLY

**Declared write-set for this task: `docs/plan/artifacts/os-usable-for-work/phase4/red-team-report.md`
— that file, and nothing else.**

A fix-cycle row inherits its parent's declaration, and the parent here was the *adversarial reviewer*,
whose only output was a report. Closing blockers 1 and 2 means changing production code, so **every
source file below is an undeclared write by construction.** Enumerated rather than buried:

| File | Why it had to change |
|---|---|
| `forge-control/src/routes/usage.ts` | **R4-red finding 2.** `agyOnPath()` deleted. The named fix. |
| `forge-control/src/lib/connection-status.ts` | **R4-red finding 3** (non-empty stdout) and the home of the shared substrate check + Ultra narrative the fix for finding 2 needs. |
| `forge-control/src/lib/connection-status.test.ts` | 11 new unit tests for both of the above. |
| `forge-control/src/routes/integrations.ts` | Deleted its private copy of `agyBinaryPresent()` and `AGY_SIGNIN_COMMAND` and imported the lib's. Leaving two independent substrate checks would re-create the exact disease the finding is about. Its `absent` action now names the binary. |
| `forge-control-web/app/desktop/settings/ConnectionsPanel.tsx` | **R4-gate blocker 1.** The two missing mount points. |
| `forge-control-web/app/desktop/settings/connections.ts` | `ultraConnection()` rewritten to render from the agy `ConnectionStatus` through `summaryFromStatus`, so the two rows cannot disagree. |
| `forge-control-web/app/desktop/quota/quotaQuery.ts` | The wire mirror of `GeminiTally` — `cli_profile` → `probe_state`/`probe_checked_at`/`session_probed_ok`. |
| `forge-control-web/app/desktop/quota/geminiLine.ts` | One predicate: "a settings file exists" → "a probe vouched". |
| `scripts/checks/check-connection-states.ts` | **R4-red finding 1.** §5b, the fourth fixture. |
| `scripts/checks/check-quota-row.ts` | The Ultra fixtures, and the new anti-contradiction assertions. |
| `scripts/checks/check-gemini-tally.ts` | §1/§6 rewritten off `PATH`/`AGY_SETTINGS_PATH` and onto the sidecar; header run-line no longer commits a literal container password. |
| `scripts/checks/check-settings-surface.tsx` | The assertion that would have caught blocker 1: every row id, in the panel's own markup. |
| `scripts/checks/check-secret-scan.ts` | **R4-red finding 4.** Two anchored `SAFE_MARKERS` entries. |
| `scripts/checks/serve-quota-7799.ts` | Its stub payload had to match the new wire shape. |
| `docs/plan/os-usable-for-work/04-phases.md` | **R4-gate blocker 3.** The undeclared-write disclosure. |
| `docs/plan/artifacts/.../phase4/browser-harness-phase4.cjs` | The R54 assertions read a card that is `display:none` until its row is expanded — correct on the throwaway proof page, wrong on the panel. The harness expands the row first. |
| `docs/plan/artifacts/.../phase4/red-team-report.md` | **The one declared file.** §9 appended (never rewritten). |
| `docs/plan/artifacts/.../phase4/fix-cycle-1-report.md` | This file. |
| `docs/plan/artifacts/.../phase4/r4fix-panel-agy-github-mounted.png`, `r4fix-panel-unknown-amber.png` | Browser proof of blocker 1, copied out of `/opt/ai-os/uploads` (N7). |
| `docs/plan/artifacts/.../phase4/gates-round4.txt` | The `gates-808.sh --strict` transcript at the fix-cycle tip, verbatim. |

**21 files, and this list is checkable:** `git diff --name-only 07f1c4b..HEAD | sort` prints exactly
these paths and nothing else.

Nothing outside this worktree was written. `/opt/forge-ai-os` was never touched; `pm2 restart` was
never run.

---

## 2. THE SIX ITEMS

### Item 1 (high) — `usage.ts:134`, the row that told Konrad to install installed software

`agyOnPath()` walked `process.env.PATH`. pm2 does not source `.bashrc`, where `agy install` writes its
export, so the Google AI Ultra row asserted *"Antigravity CLI (agy) is not installed on this box"*
while `agy` 1.1.14 sat at `/root/.local/bin/agy` answering probes — on the same panel, four inches
below a row reading SIGNED IN.

**Deleted.** `connection-status.ts` now owns one substrate check, `agyBinaryPresent()`
(`access(AGY_BIN, X_OK)`), used by both `routes/usage.ts` and `routes/integrations.ts`; the private
copy in the latter is gone. `readAgySubstrate()` pairs it with the persisted record through
`renderState` — the one function permitted to say "connected" — and `agyUltraNarrative()` composes the
row's two sentences from those two measurements and nothing else. The settings-file check that used to
stand in for "signed in" is gone: a `settings.json` survives a revoked session.

`installed` is `boolean | null`, not `boolean`. An `access()` failure that is not ENOENT/EACCES means
we could not decide, and folding that into `false` would print "not installed" because a disk
hiccuped — the same species of confident wrong answer as the bug being fixed.

Measured against a running route, with the harness API on :7742 reading this worktree's `usage.ts`:

```
$ curl -s http://127.0.0.1:7742/api/usage/quota?fresh=1 | jq .gemini
  "cli_installed":    true
  "probe_state":      "unknown"
  "probe_checked_at": null
  "session_probed_ok": false
  "auth_note":        "/root/.local/bin/agy is installed, but no probe currently vouches for the
                       session: Never checked — no probe has ever run against this connection…"
  "connect_command":  "sign in at a terminal on this box: `/root/.local/bin/agy`, then open the
                       printed Google URL and paste the authorization code back within 60 seconds"
```

`check-gemini-tally.ts` §1 pins it: *"the CLI is seen where it actually is, not where PATH says"* and
*"the row does NOT tell Konrad to install software already installed"*. §6/§6b/§6c/§6d add the sidecar
states — fresh ok, a probe that said no, a stale success, and a corrupt record — the last asserting
that an unreadable `agy` sidecar does not take the Claude quota row down with it.

**A second row that could contradict the first is a structural problem, so the fix is structural.**
`ultraConnection()` no longer has a state of its own: it renders the *same* `ConnectionStatus` the
`agy` row reads, through the *same* `summaryFromStatus`. The tally supplies the count and the
missing-denominator note, and can no longer promote or demote anything.

### Item 2 (high) — the cards were on no screen

`AgyCard` and `GitHubCard` were built, tested and exported for a whole phase with no mount point, so
R54 and R56 were unreachable on the surface Konrad opens, and every proof of them ran against a
throwaway page. `ConnectionsPanel.tsx` now mounts both, reporting facts upward through `onFacts`
exactly as the Gemini and Google cards already did — one fetch per subject, and `recheck_interval_ms`
threaded from `GET /api/integrations/connections` through `AgyFacts`/`GithubFacts`.

A component test cannot catch this: it imports the thing it is testing. So the assertion is over the
**panel's own server-rendered markup**, in `check-settings-surface.tsx` §3 — all five
`data-connection-row` ids, plus `data-agy-card`/`data-github-card` for the bodies, plus an anti-inert
control on an id that is not mounted.

Browser proof, against the real `/settings` surface behind the real auth wall
(anonymous → `307 → /signin`; with the minted cookie → `200`):

```
--- surface /settings ---
rows:  claude:arved, claude:claude-worker-legacy, google, gemini-key, gemini-ultra, agy, github
cards: google, agy, github
b4c-after:   12/12 assertions passed   PASS
b4c-unknown: 10/10 assertions passed   PASS
```

The same harness, same modes, reported `BLOCKED` for agy and GitHub at `5b36eba`. Screenshots:
`r4fix-panel-agy-github-mounted.png` (both rows SIGNED IN / CONNECTED, the Ultra row carrying the
identical probe age as the agy row) and `r4fix-panel-unknown-amber.png` (no sidecar at all: both rows
amber UNKNOWN, chip colour compared against the `--fg-warn` token by computed style, and the Ultra
row's action now reads *"Press Probe to run the CLI and see what it says"* rather than *"install the
Antigravity CLI"*).

### Item 3 (med) — the `connected` + `identity: null` path was rendered by nothing

Every `connected` fixture supplied an identity, so the normal `agy` success path — `classifyAgyProbe`
returns `identity: null` by construction — was unmeasured, and a mutation substituting a configured
address there passed green.

`check-connection-states.ts` §5b adds a fourth fixture per integration: `connected`, fresh,
`identity: null`. It asserts no address (the configured-only fixture *or* any of the four probed ones)
reaches the identity slot, that the slot states the absence in words rather than sitting empty, and —
the control — that the rule FAILS on the named-probe fixture, via `discriminates()`.

The reviewer's own mutation, re-run against the fix in a shadow tree at `/tmp` (never the worktree):

```
MUTATION APPLIED: connected + identity:null now substitutes a configured address
  FAIL google: …and NO address appears in the identity slot, configured or otherwise
  FAIL agy:    …and NO address appears in the identity slot, configured or otherwise
  FAIL github: …and NO address appears in the identity slot, configured or otherwise
  FAIL google: "the identity slot names no address" separates the anonymous probe from the named one
  FAIL agy:    …
  FAIL github: …
6 FAILURE(S)
```

Restored by hash (`41310b59d6cefad4c2366a10b27ee4f12bf92ded02a193e93fa0de9365ecf822`), shadow deleted.

### Item 4 (med) — `agy` exit 0 with no output rendered SIGNED IN

`classifyAgyProbe` returned `ok: true` on the exit code alone and then wrote "(exit 0 but no output)"
into the same line as the green chip. It now requires non-empty stdout: exit 0 with no model list is a
recorded failure carrying what was actually seen. Exit 0 is not the evidence — the list is; a wrapper
script, a `--quiet` flag or a future `agy` printing to stderr all produce a silent exit 0 and none of
them has shown us a credential.

Four new tests, including the boundary in both directions (whitespace-only stdout is no output; one
line of model list is still enough) and one asserting the contradictory placeholder string is
unreachable. Reverting the guard in a shadow tree turns 2 suites red.

### Item 5 (med) — three undeclared writes

Disclosed in `docs/plan/os-usable-for-work/04-phases.md`, in a table naming commit, file, declaring
owner and what actually happened: `check-integrations.tsx` written by both B4b and B4c (the collision
the plan forbids), `browser-harness-phase4.cjs` written by B4c but declared by B4a, and
`b4c-after-settings-surface.png` declared by nobody. Content unchanged. The gate's fold-in about the
`agy-flow.md` → `agy-flow-affordance.md` naming drift is recorded in the same section.

### Item 6 (low) — a `***` redaction reading as a DSN

`SAFE_MARKERS` gained `^\*+$`, **anchored and scoped to the exact token** — never to a file or a
directory, per the instruction. `postgresql://user:***@host` is the universal redaction;
`abc***def` is a password with asterisks in it and must keep failing, which the anchor guarantees.

The gate also named `red-team-report.md:235`. Both are closed by the one marker. Two further reds were
closed on the way to zero, neither of them a credential — `PGPASSWORD="$DOCPW"` (a script *reading* a
credential at run time; `SAFE_MARKERS` already recognised `${VAR}` and `$(cmd)` and flagged the third
spelling of the same thing, so `^\$[A-Za-z_][A-Za-z0-9_]*$` completes that intent) and a literal
throwaway container password in `check-gemini-tally.ts`'s documented run line, pre-existing at the
merge-base and now generated into a shell variable.

**The loosened checker still catches real credentials.** Canary file in a throwaway clone, carrying a
redaction, a shell variable and a real-looking credential *in the same file*:

```
FAIL  docs/canary-secret-scan.md
        DSN password: postgresql://ai_os_app:<a live-looking 14-char password>@   ← still caught
        DSN password: postgresql://u:<abc, three asterisks, def>@                 ← still caught (anchor works)
        PGPASSWORD=<a bare unmarked word>                                         ← still caught
EXIT=1
```

The password literals are shown bracketed **on purpose, and this is the point of blocker 2**: pasting
them verbatim is how this document put itself back into the checker's mouth. So the canary is
recorded as a recipe you can re-run rather than as a paste you must trust — the literals are
assembled in the shell and never enter a tracked file:

```sh
W=$(mktemp -d); git clone -q --shared . "$W/repo"; cd "$W/repo"
S=postgresql            # the scheme is a variable too, so this recipe carries no DSN shape either
U=ai_os_app; P1=S3cr3t; P1="${P1}LiveP4ss"; P2='abc***def'; P3=hunter2correct
printf 'one: %s://%s:%s@db/x\ntwo: %s://u:%s@db/x\nshell: %s=%s\n' \
  "$S" "$U" "$P1" "$S" "$P2" PGPASSWORD "$P3" > docs/canary-secret-scan.md
git add docs/canary-secret-scan.md && tsx scripts/checks/check-secret-scan.ts   # → all three suspects, EXIT=1
```

Re-run at `6a1fa33` on 2026-08-19 by the round-5 pass: all three shapes still caught, in one file,
with the anchored `^\*+$` marker in place. The loosening did not blunt the checker.

Measured on both sides, in a throwaway clone rather than by assertion:

```
merge-base 3f98e67    6 FILE(S) FAILED
tip        07f1c4b    8 FILE(S) FAILED     (the gate reported 6→8; both figures verified here)
after this fix        ALL PASS — 914 tracked files
```

**That last line was true when it was written and false one commit later** — the run predated this
report becoming a tracked file, and the paste it then carried was itself a ninth red. Corrected by
the round-5 pass; see `fix-cycle-1-recheck.md` §2 for the measurement at the real tip.

---

## 3. WHAT WAS RUN

| Instrument | Result |
|---|---|
| `tsc --noEmit` — forge-control | clean |
| `tsc --noEmit` — forge-control-web | clean |
| `pnpm test` — forge-control unit suite | **1365 pass, 0 fail** (1354 before; +11) |
| `check-instrument-typecheck.sh` | **43/43 subjects compiled clean**, 0 waivers, 0 suppressions |
| `check-connection-states.ts` | ALL PASS (now 4 integrations × 5 fixtures) |
| `check-quota-row.ts` | ALL PASS |
| `check-settings-surface.tsx` | PASS |
| `check-integrations.tsx` | PASS |
| `check-gemini-tally.ts` (throwaway Postgres in docker) | ALL PASS |
| `check-secret-scan.ts` | **ALL PASS**, from 8 red at the tip this cycle started on |
| `browser-harness-phase4.cjs b4c-after` @ `/settings` | 12/12 PASS |
| `browser-harness-phase4.cjs b4c-unknown` @ `/settings` | 10/10 PASS |
| `gates-808.sh --strict` @ `dc7bd5a` | **25 gates, 23 executed, 2 skipped by design, RED: 0** — transcript at `phase4/gates-round4.txt` |

Mutation kills, all in `/tmp` shadow trees, never in the worktree, all restored by hash:

| Mutation | Caught by | Result |
|---|---|---|
| `connected` + `identity:null` substitutes a configured address | `check-connection-states.ts` §5b | 6 red |
| the Ultra row re-derives its own state from the tally | `check-quota-row.ts` | 3 red, reproducing the reported contradiction verbatim: `ultra=absent/NOT INSTALLED agy=connected/SIGNED IN` |
| `agy` exit 0 alone is `ok: true` again | `connection-status.test.ts` | 2 suites red |
| `installed: null` folded into "not installed" | `connection-status.test.ts` | 1 further suite red |

---

### One red seen, and why it is not this commit's

The first full-suite run at `dc7bd5a` reported **gate 18 red** (`check-usage-fold.ts`,
`1 FAILURE(S)`). It is a shared-resource collision, not a defect here, and the evidence is in
the transcript itself:

```
NOTICE:  relation "runs" already exists, skipping          ← another process built it first
NOTICE:  relation "spend_log" already exists, skipping
1 FAILURE(S) — usage fold (scratch db: r1354_sampler)
```

`check-usage-fold.ts:106` defaults to the **fixed** name `r1354_sampler` and `TRUNCATE`s
`runs`/`spend_log`/`usage_hourly` between fixtures, so two lanes running the suite at once wipe
each other mid-assertion. That default was fixed to a per-process, self-dropping name in
`f283d5b` — on the **phase-3 lane**, which this workstream branched before:

```
$ git merge-base --is-ancestor f283d5b HEAD ; echo $?
1        # NOT an ancestor — this branch still has the shared name
```

Re-run serially at the same commit, with no sibling suite in flight: **gate 18 ALL PASS, RED: 0**.
The committed transcript is the serial run. The contended one is not committed, because a
transcript of a contaminated run is worse than none — but it is described here rather than
quietly dropped. The integrator will pick up `f283d5b` and the collision disappears.

## 4. WHAT IS LEFT

- **Nothing is deployed.** Every measurement above was taken out of this worktree — a throwaway API on
  :7742 with all three stores redirected to `/tmp` fixtures, and a `next start` on :7743 rebuilt with
  `FORGE_CONTROL_URL=http://127.0.0.1:7742` (verified: `routes-manifest.json` names 7742 and nothing
  else). Both were killed by recorded PID afterwards.
- **The `agy` sidecar does not exist on the live box** (`/opt/ai-os/.secrets/status/` is absent), so
  after deploy every connection reads UNKNOWN until the first re-check tick runs. That is the correct
  first state, and it is the second screenshot above.
- **`installed: null`** — the disk-error branch — is proved only over the pure function. There is no
  way to make `access()` return EIO on demand without a fault-injecting mount, and inventing a seam
  for it would weaken the named-constant rule R52 exists for. Stated rather than skipped quietly.
