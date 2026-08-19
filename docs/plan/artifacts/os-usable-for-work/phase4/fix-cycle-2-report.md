# Phase 4 — FIX CYCLE 2 (round 6)

**Workstream** `connections` · branch `project/7851068b-connections`
**Started from** `4b31971` (round-5 tip). The re-review that seeded this round read `6a1fa33`; four
round-5 commits landed after it, and item 1 below is adjudicated against what is at HEAD now rather
than against what the reviewer saw.

Three items, one of them carrying an explicit operator ruling that the obvious fix is the wrong one.
All three closed. What follows is what changed, what was measured, and what is left.

---

## 1. WRITE-SET — DECLARED vs ACTUAL, LOUDLY

**Declared write-set for this task: *empty*.** The brief says so in as many words: "(empty — nothing
was declared)". So **every path below is an undeclared write by construction** — the third
consecutive fix-cycle row with an unsatisfiable declaration, and the round-5 reviewer already
recorded the correct owner of that defect as the engine that seeds these rows, not the builder.
Enumerated rather than buried:

| File | Why it had to change |
|---|---|
| `forge-control-web/app/desktop/settings/connections.ts` | **Item 3.** The read that FAILED had no rendering: `ConnectionReadFailure`, `Read<F>`, `isReadFailure()`, `readFailedSummary()`, and the four row functions taught to use them. |
| `forge-control-web/app/desktop/settings/integrationCards.tsx` | **Item 3.** `GoogleCard`, `AgyCard`, `GitHubCard` and `GeminiCard` now separate the READ's error from the ACTIONS' and report it upward through `onFacts`, plus a banner each. |
| `forge-control-web/app/desktop/settings/ConnectionsPanel.tsx` | **Item 3.** Panel state widened to `Read<…>`; the verbatim-error box narrowed to the arm that can carry one. |
| `scripts/checks/check-connection-states.ts` | **Item 3's assertion.** §5c: the failed read, over all five rows on the panel, with `discriminates()` controls against the still-loading fixture. |
| `docs/plan/artifacts/.../phase4/browser-harness-phase4.cjs` | **Items 2 and 3.** `identity: null` in the `b4c-after` agy fixture + three assertions on what that renders; the new `b4c-read-fail` mode. |
| `docs/plan/artifacts/.../phase4/r6-read-fail-before.png` | **Item 3 reproduced**, before any edit: four rows at READING… against a dead API. |
| `docs/plan/artifacts/.../phase4/r6-read-fail-after.png` | **Item 3 fixed**: five rows at UNKNOWN — READ FAILED, each printing its own rejection. |
| `docs/plan/artifacts/.../phase4/r6-after-four-connections.png` | **Item 2**: the re-taken after-shot, with the identity the real box actually produces. |
| `docs/plan/artifacts/.../phase4/fix-cycle-1-report.md` | **Item 1.** §2 rewritten to the operator ruling; the hand-written ALL PASS deleted. |
| `docs/plan/artifacts/.../phase4/fix-cycle-1-recheck.md` | **Item 1.** §2b: the two claims in round 5's own §2 that item 1 falsifies. |
| `docs/plan/os-usable-for-work/04-phases.md` | §10 — this write-set, in the same commit as the code, which is the half of the rule that is usually missed. |
| `docs/plan/artifacts/.../phase4/fix-cycle-2-report.md` | This file. |
| `docs/plan/artifacts/.../phase4/gates-round6.txt` | The `gates-808.sh --strict` transcript at this tip, verbatim. |

`git diff --name-only 4b31971..HEAD | sort` prints exactly these paths and nothing else.

**`scripts/checks/check-secret-scan.ts` is NOT in that list, and that is the point of item 1.**
`git diff 4b31971..HEAD -- scripts/checks/check-secret-scan.ts` is empty: no `SAFE_MARKERS` entry was
added, widened or exempted to make this round's documents pass. Its last change is still `04c79b1`.

Nothing outside this worktree was written. `/opt/forge-ai-os` was read once (its `.env.local`, for
the harness cookie secret) and never written; `pm2 restart` was never run.

---

## 2. ITEM 1 (blocker) — the report tripped the checker it documents

### What the ruling asked for

The reviewer found `check-secret-scan.ts` exiting 1 at `6a1fa33` on
`phase4/fix-cycle-1-report.md`, which had pasted its own canary transcript verbatim — and then
asserted `ALL PASS — 914 tracked files` two paragraphs further down. The operator ruling rejected the
obvious repair:

> Rewriting the canary to carry a SAFE_MARKER makes the check pass and DESTROYS the evidence: a
> string carrying a safe marker would never have fired the check, so the transcript then
> demonstrates nothing while looking like it demonstrates something.

and set closure at three conditions: **quote the detector's verdict, not its trigger** (with the sha
of the fixture that contained it); **delete the hand-written ALL PASS** and paste a measured exit
code; **add no `SAFE_MARKERS` entry**.

### What is at HEAD now, and what this round changed

Round 5 had already reworded §2 once — from a paste into a **shell recipe that re-assembled the same
literals from fragments**. That is green (no DSN shape forms on any one line) and it is still the
wrong shape: the trigger values were sitting in a tracked file, readable, one `printf` away from
being a paste again. The recipe is gone. In its place:

- the checker's own **`FAIL <path>` line**, with the three suspect lines redacted to their count and
  kind — reproducing them is the defect;
- the **sha whose content fired it, `04c79b1`**, with the four-line recipe to check it out in a
  throwaway clone and re-run. The demonstration is now permanent and needs no credential-shaped
  string at the tip;
- the ladder below, every row measured in a **fresh clone of the committed commit** rather than in a
  working tree — because the corpus is `git ls-files` and the file being written is not in it.

```
3f98e67  merge-base                6 FILE(S) FAILED   EXIT=1
07f1c4b  R4-gate tip               8 FILE(S) FAILED   EXIT=1
04c79b1  the code fix + the paste  1 FILE(S) FAILED   EXIT=1   ← fix-cycle-1-report.md itself
dc7bd5a                            1 FILE(S) FAILED   EXIT=1
e0a721f                            1 FILE(S) FAILED   EXIT=1
6a1fa33  the tip R5-gate reviewed  1 FILE(S) FAILED   EXIT=1
3c5a6c8  §2 reworded               1 FILE(S) FAILED   EXIT=1   ← the RE-CHECK doc had it now
d3fe3d1  the doc reworded too      ALL PASS — 917 tracked files   EXIT=0
5ef6286                            ALL PASS — 918 tracked files   EXIT=0
4b31971  round-5 tip               ALL PASS — 918 tracked files   EXIT=0
```

The reviewer's three figures (6 / 8 / 1) reproduce exactly. The two extra `1 FILE(S) FAILED` rows are
the same trap caught twice more, which is why the improvement was real and the claim of zero was not.

**The hand-written `ALL PASS — 914 tracked files` line is deleted, not corrected**, per the ruling: a
summary a human types about a file whose own content decides the verdict is worth less than nothing.
The §3 table row that repeated it is corrected to the measured result at the commit that wrote it.

### Closure, measured at this tip

Run at the staged tip of this round, in the worktree, and re-run in a fresh clone of the commit —
both figures are in §5. `check-secret-scan.ts` **exits 0**, the report still proves the checker fires
(by verdict + sha), and **no `SAFE_MARKERS` entry was added**.

---

## 3. ITEM 2 (low) — the after-shot photographed an identity this system cannot produce

`browser-harness-phase4.cjs:488` seeded `identity: "the Google account signed in to the Antigravity
CLI"` for `agy`. `classifyAgyProbe()` (`connection-status.ts`) returns `identity: null` on **every**
branch — `agy models` lists models, it never names the account behind them — so the committed shot
depicted a row the real box cannot render, and it did so for precisely the case R4-red item 3 was
about: connected, with no identity.

The fixture now seeds `identity: null`, and three assertions were added so the photograph is not the
only thing holding the line:

```
ok   R50/R4-red-3: the agy row states the probe returned NO identity, in words
ok   R50: …and it borrows no address from any other connection
ok   …while the state itself is still CONNECTED — the probe's answer, not the name's
b4c-after: 15/15 assertions passed          PASS
```

On screen, both agy rows now read **SIGNED IN** beside *"no signed-in Google account — `agy models`
is what would reveal one — the probe returned no identity"* — the state from the probe, the name
absent and said out loud. `r6-after-four-connections.png`.

**The round-4 and round-5 shots are superseded, not deleted.** `b4c-after-four-connections.png`,
`b4c-after-settings-surface.png` and `r5-panel-agy-github-mounted.png` all photograph the fabricated
identity; they remain as the record of what those rounds proved, and this paragraph is the pointer
that stops a later reader taking them for the current surface.

---

## 4. ITEM 3 (low) — "READING…" is a claim too

### Reproduced first, in a browser, before any edit

The reviewer's reading was that a rejected `fetchAgyConnection()` leaves `facts` at `null` forever.
Measured rather than taken on trust: the throwaway stack was stood up at the **round-5 code**
(`next build` bound to :7742, `routes-manifest.json` verified to carry 7742 and nothing else), the
API was left **stopped**, and the new `b4c-read-fail` mode ran against it:

```
precondition ok: /api/proxy/integrations/connections → 500
FAIL a row reports the failed read within 20s rather than sitting at READING…
     chips=["READING…","UNKNOWN","READING…","READING…","READING…"]
b4c-read-fail: 4/17 assertions passed        13 FAILURE(S)
```

`r6-read-fail-before.png` is that surface: four rows saying READING… beside a Claude registry banner
that says, correctly and in red, exactly what went wrong. One panel, two standards.

### The fix

A read has three outcomes and the code had two. `connections.ts` gains `ConnectionReadFailure`
(`{ read_error }`), the union `Read<F>`, and `readFailedSummary()`; each card keeps the READ's error
in its own state slot, separate from whatever an action did, and reports it **upward** through the
same `onFacts` channel the facts travel through. The row then renders

- `state: "unknown"` — amber, never green, never NOT CONNECTED;
- `stateLabel: "UNKNOWN — READ FAILED"`;
- the rejection **verbatim**, with its status code, in the same slot R58 already reserves for an
  upstream's own words;
- and an action that names the route to check.

Facts beat a read error, deliberately: a refresh that fails after a successful load must not erase
the reading it could not replace.

**The fifth row was folded in.** The reviewer named `agy` and the Ultra row that inherits from it;
`GoogleCard` and `GitHubCard` had the identical defect, and the Gemini key row said `Loading…`
forever through a different signature. All five are fixed, because four honest rows and one still
saying "Loading…" teaches a reader that "Loading…" is just how this surface looks.

### Proved, twice, on the code that is at this tip

```
b4c-read-fail: 20/20 assertions passed       PASS     (five rows, API down)
```

`r6-read-fail-after.png`. The mode refuses to run against a live API: it probes
`/api/proxy/integrations/connections` first and throws if the answer is under HTTP 500, because
against a healthy backend it would photograph four working rows and caption them a read failure.

Two mutation kills on `check-connection-states.ts` §5c, both restored by sha256
(`ef0e764914113667f8d0d4e2878ab9d2af65f8484cd7525b655c06e21cd3b377`):

| Mutation | Result |
|---|---|
| `connections.ts` reverted to `4b31971` | the check **cannot even build the fixture** — the old code has no branch for the value, so its own N1 guard throws `summaryFromStatus needs a positive intervalMs for google, got undefined`. EXIT=1. |
| the plausible regression: `readFailedSummary()` collapsed back into the waiting shape | **20 FAILURE(S)**, naming the rows and the two `discriminates()` controls that go inert. EXIT=1. |

The second is the one that matters: it is what a future edit would actually look like, and the check
turns red on it with the reason printed.

---

## 5. WHAT WAS RUN

| Instrument | Result |
|---|---|
| `tsc --noEmit` — forge-control-web | clean |
| `tsc --noEmit` — forge-control | clean |
| `next build` (production, bound to :7742) | clean, twice |
| `check-connection-states.ts` | **ALL PASS**, 154 assertions (was 146 before §5c's five rows) |
| `check-quota-row.ts` | ALL PASS |
| `check-settings-surface.tsx` | PASS |
| `check-integrations.tsx` | PASS |
| `check-secret-scan.ts` | **ALL PASS, EXIT=0** — see §6 for the tip figure |
| `browser-harness-phase4.cjs b4c-after` @ `/settings` | **15/15 PASS** |
| `browser-harness-phase4.cjs b4c-unknown` @ `/settings` | 10/10 PASS |
| `browser-harness-phase4.cjs b4c-read-fail` @ `/settings` | **20/20 PASS** (13 red on the pre-fix build) |
| `pnpm test` — forge-control | see `gates-round6.txt` |
| `gates-808.sh --strict` | see `gates-round6.txt` |

Every browser run was behind the real auth wall — anonymous `/settings` → `307 → /signin`, the minted
`authjs.session-token` → `200` — against a build whose `routes-manifest.json` names `:7742` and
nothing else, so nothing here touched the live backend on :7700.

---

## 6. THE ORDERING NOTE, AGAIN, BECAUSE IT DECIDES ONE NUMBER

`check-secret-scan.ts` takes its corpus from `git ls-files`. A figure measured in the working tree
therefore cannot see the file the round is writing — which is exactly how round 4 came to publish
`ALL PASS — 914 files` about a document that was itself the ninth red. So the closing figure for this
round is measured in a **fresh clone of the committed tip** and is written into the commit message,
not into this file, where it would be a claim about content that cannot yet exist.

What can honestly be written here is the terminating condition: this round adds no DSN-shaped string
and no shell password assignment — the second of the checker's two patterns, named here without its
equals sign for the reason below — to any tracked file, in code, in prose or in a fixture. The three
suspect values it discusses are named by count and kind and quoted nowhere; the only place they
survive is `04c79b1`, in git, where a reader can re-run the checker against them.

**And the trap fired a fourth time, on the draft of that very sentence.** The clause claiming this
round adds no shell password assignment originally spelled the assignment out, equals sign included,
with a formatting backtick immediately after it — which the second pattern reads as a one-character
password carrying no safe marker. Caught by running the checker against the STAGED tree before
committing, which is the only place it can be caught, since the corpus is `git ls-files`:

```
FAIL  docs/plan/artifacts/os-usable-for-work/phase4/fix-cycle-2-report.md
        <1 suspect: the second pattern, matched on a formatting character>
1 FILE(S) FAILED        EXIT=1
```

Four rounds, four instances, none of them a live credential — **and the fourth one is the guard
working, not a false positive.** A draft of this report drew the opposite conclusion and recommended
teaching the scanner a use/mention rule; that recommendation is withdrawn, because it was already
overruled on this branch at `ce742f9` before this round committed. The distinction, restated so it
is not re-derived wrong a third time:

- a checker whose subject is **prose** cannot tell a description of a pattern from the pattern, and
  that is a real defect to close;
- a checker whose subject is **a credential-shaped string in a tracked file has no mention case**.
  A live-looking DSN in a committed document *is* the thing being prevented, whatever its author
  meant by it, because repos get cloned, mirrored and grepped by people who never read the
  paragraph around it.

So the toll is the price of the guarantee, and it is paid by the prose, never by the guard. The
practical rule: **never widen `SAFE_MARKERS` for an evidence document and never scope an exemption
to a file or a directory** — which is what this round did, and why `check-secret-scan.ts` has an
empty diff for it.

---

## 7. WHAT IS LEFT

- **Nothing is open against `check-secret-scan.ts`, and the recommendation to change it is
  WITHDRAWN.** A draft of §6 above proposed teaching it a use/mention rule. The manager overruled
  exactly that recommendation at `ce742f9`, one commit before this round's own — the instrument is
  correct, a credential-shaped string in a tracked file has no mention case, and the only legitimate
  self-exemption is the one already there (`SELF_PATH`, the source that defines the patterns). The
  fix for a document that trips it is the document. Recorded here rather than quietly dropped,
  because the wrong version of this recommendation has now been written twice.
- **The ordering rule is honoured and terminates.** Per the standing rule in `AI OS/Operator
  Decisions.md` (*Gates*), the scan is run as the LAST step, after the evidence lands, in a fresh
  clone of the final commit — and its exit code is reported to the operator rather than written back
  into the corpus, which is what would make this regress forever.
- **The fix-cycle write-set defect is unchanged** and now has three instances. The engine seeds a
  fix-cycle row with its parent's declaration (or, this time, with nothing at all), so the write-set
  audit gate cannot be satisfied by any fix cycle. Owner: the engine.
- **Nothing is deployed.** `/opt/forge-ai-os` is untouched; the throwaway stack on :7742/:7743 is a
  build artefact of this round and holds no state anything else reads.
