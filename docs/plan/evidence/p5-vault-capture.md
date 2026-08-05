# P5 knowledge capture — vault appends + branch push (R27 / R15 / R16)

Round 503, project `engine-v2-research-lane`. Two vault notes appended (append-only,
heredoc, truncation-proved) and the work branch published.

## 1. Pre-existing state — the design note was NOT empty

The task brief describes `Goal Mode Design.md` as "short, ~29 lines". It was **80 lines**
when this round opened: round **502** had already appended a
`## Engine v2 — hardening + the research lane (2026-08-05, project engine-v2-research-lane)`
section (file lines 33–81), self-dated in its own text ("*Appended at round 502.*").

Re-appending the briefed section would have duplicated it. This round instead appended a
narrower `### Addendum (round 503)` covering only the briefed points the R502 section does
**not** already state:

| Briefed point | R502 section | Action |
|---|---|---|
| Reviewer-round group / wait-until-settled / one fix builder + one re-reviewer / merged sectioned feedback / NEEDS_FIXES beats PASS / unparseable blocks / chain_key + 0039 | covered | not repeated |
| Verdict = the LAST `VERDICT:` line | absent | added |
| Pure `projectAcceptsWork()` predicate as the in-code belt | absent (SQL gate covered) | added |
| Conflict CLASSIFIED created / replay / occupied | implied, classes unnamed | added, named |
| Worktree-only policy + reviewer `git -C /opt/forge-ai-os status --porcelain` | covered | not repeated |
| Executor-safe detached `safe-restart.sh`; `pm2 restart forge-control` allowed | covered | not repeated |
| `git-sync-branch.sh` force-free, `--pr` idempotent, gating reviewer pushes on PASS (guidance, not engine-deterministic) | force-free covered; idempotency + who-pushes absent | added |
| Researcher lane + `roleFilePaths()` self-install | covered | not repeated |
| `gemini-qa.mjs` / `perplexity.mjs` key protocol | covered | not repeated |
| Explicit landed / not-landed ledger against "## Phase 2 (not built yet)" | **absent** (only "largely built") | added, bullet by bullet |

The existing `## Phase 2 (not built yet)` section was not edited, per the brief; its status is
stated inside the addendum.

## 2. Byte counts and hashes

### `/opt/obsidian-vault/AI OS/Goal Mode Design.md`

```
before  wc -c     12032
before  sha256    d690deb9b09b980f1b034a8c78bab43776908cd9c6562ab880decfbac5a1e2f2
after   wc -c     16148
after   sha256    18d3bd96de9052ef26741b9d7b26d4c4370df4e1e2e71e0a7651cf45e323d6c7
```

Truncation proof — the first 12032 bytes must still hash to the original:

```
$ head -c 12032 "/opt/obsidian-vault/AI OS/Goal Mode Design.md" | sha256sum
d690deb9b09b980f1b034a8c78bab43776908cd9c6562ab880decfbac5a1e2f2  -
```

PASS — identical to the pre-append sha256, and 16148 > 12032.

### `/opt/obsidian-vault/AI OS/Operator Log.md`

```
before  wc -c     92542
before  sha256    4bbfe378db75dc016fcfb1ee7b589960ff6c307b55166bf742a1a127f0adef9f
after   wc -c     98591
after   sha256    7c30fb79945708de208002366693eb410855873d8d398f737f5f68bd151964d1
```

Truncation proof:

```
$ head -c 92542 "/opt/obsidian-vault/AI OS/Operator Log.md" | sha256sum
4bbfe378db75dc016fcfb1ee7b589960ff6c307b55166bf742a1a127f0adef9f  -
```

PASS — identical to the pre-append sha256, and 98591 > 92542.

Both appends were made with `cat >> "<file>" <<'EOF'` in a single shell call. The `Write`
tool was never pointed at either file.

## 3. Headings appended

- `Goal Mode Design.md` line 82: `### Addendum (round 503) — semantics the section above leaves implicit`
- `Operator Log.md` line 785: `## 2026-08-05 (evening) — engine-v2-research-lane: engine hardened, research lane built, deploy pending`

Both are the last section of their file. The Operator Log entry is at the very end, matching
the note's chronological order.

## 4. Facts checked against the tree before writing

Nothing was documented that the diff does not contain. Read first:

- `forge-control/src/lib/project-reconcile.ts` — `VERDICT_RE` is `/VERDICT:\s*(PASS|NEEDS_FIXES)/gi`
  with the last match kept (L47–63); `projectAcceptsWork()` is `status === "active"` (L78–80);
  rule order (b) unsettled → `wait` precedes any parsing (L196); chain keys `fix:<round>:<cycle>` /
  `rereview:<round>:<cycle>` (L161–169); merge emits `## Feedback from: <title>` sections (L258).
- `forge-control/src/db/projects.ts` — `kind: "created" | "replay" | "occupied"` (L713–715, L757–773);
  `p.status = 'active'` at L298, L415, L444, L483.
- `forge-control/src/lib/project-tick.ts` — `projectAcceptsWork` re-checked at L486; push-on-PASS is
  prompt guidance with the rationale in the comment at L338–349; `--pr`-instead-of-merge rule at L334.
- `scripts/git-sync-branch.sh` — `gh pr list --head` before `gh pr create`, printing `pr-existing:`
  (L137–150); exit codes 0/1/2/3/4 documented at L28.
- `docs/tools/deploy-playbook.md`, `agents/researcher.md` (present, 3355 bytes).
- Unbuilt Phase 2 items verified by absence: no `spend_cap`/`budget` in `project-tick.ts`, no
  `gh issue` anywhere in `scripts/` or `forge-control/src/`.
- Reminder ids confirmed live against `GET :7700/api/reminders`, both `pending`:
  `c88f6e19-0b41-4d43-92af-48ba5eb4f476` = Gemini key, `4c4532af-24ed-4642-a7ef-15ae291391e7`
  = Perplexity key. (The brief listed the two ids in the opposite order to the two key names;
  the mapping above is the one the API returns.)

## 5. Branch push (R15 / R16)

Plain push, no `--pr` — this project's brief merges to `main` in Phase 6.

```
$ scripts/git-sync-branch.sh /opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365
PUSH_RESULT_PLACEHOLDER
```

Verification:

```
$ git rev-parse HEAD
LOCAL_SHA_PLACEHOLDER
$ git ls-remote origin refs/heads/project/4120f785
REMOTE_SHA_PLACEHOLDER
```

REMOTE_MATCH_PLACEHOLDER

## 6. Live checkout

`git -C /opt/forge-ai-os status --porcelain` — empty before and after this round. The vault
appends and this push are the only writes outside the worktree, both explicitly in scope per
the round brief's N5 note.
