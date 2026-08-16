# Phase 900 / round 901 — corpus relocation

Namespacing the operator-visibility planning corpus under
`docs/plan/operator-visibility/` and repairing every reference, so that merging
this branch to `main` cannot silently erase the engine-v2-research-lane corpus.

Round 901 is step 1 of the operator's corpus-merge recipe. It ran entirely
inside the worktree. `/opt/forge-ai-os` was not touched; nothing was merged to
`main`.

---

## 1. The hazard, verified

The operator's warning was not merely "there will be a conflict". It is worse:
**there would have been no conflict at all.**

```
$ git merge-base HEAD main
9ef01eb891652964d1b0c3beb25523c02a81e8ba
$ git rev-parse main
9ef01eb891652964d1b0c3beb25523c02a81e8ba
```

`merge-base(HEAD, main) == main`, so `main` is already an ancestor of this
branch and a merge would be a **fast-forward**. Git raises nothing on a
fast-forward — it would simply have replaced main's `docs/plan/00..04` with ours
and deleted 1321 lines of another project's live corpus.

Deletion count against `main` at round 901 start:

| path | added | **deleted** |
|---|---:|---:|
| `docs/plan/00-vision.md` | 82 | **83** |
| `docs/plan/01-requirements.md` | 121 | **251** |
| `docs/plan/02-architecture.md` | 185 | **517** |
| `docs/plan/03-quality.md` | 56 | **323** |
| `docs/plan/04-phases.md` | 104 | **147** |
| | | **1321** |

Those 1321 lines are engine-v2-research-lane's corpus. After round 901 that
number is **zero** (§6).

### Authorship evidence for the collision

Established per file with `git log --diff-filter=A` for the origin and
`git log main/HEAD -- <file>` for the rewrites:

- **Originally authored** by `files-pane-fast-light` at `9443b8d`
  ("docs(plan): files-pane-fast-light planning corpus").
- **Rewritten on `main`** by `engine-v2-research-lane` at `b916520`
  ("docs(plan): engine-v2-research-lane corpus; archive files-pane-fast-light
  plan"), amended since by `1ff492d`, `83ed9ac`, `787759f`, `16b78a0`,
  `0d15337`, `266a0df` (and `660f690`, `69adb60`, `48d381a` touching the same
  paths).
- **Rewritten on this branch** by `operator-visibility` at `9442d75`
  ("docs(plan): operator-visibility waterfall corpus"). Round 802 resolved the
  merge `--ours`, so the working tree held OUR content at those five paths.

Content proof after the restore — the flat path is engine's, ours is namespaced:

```
$ head -1 docs/plan/00-vision.md
# 00 — Vision: engine-v2-research-lane
$ head -1 docs/plan/operator-visibility/00-vision.md
# 00 — Vision: operator-visibility
```

Independent corroboration from the other lane: engine's own
`docs/plan/05-control-plane-boundary.md:254-255` tabulates exactly this
collision, listing both projects as owning `docs/plan/00-vision.md … 04-phases.md`.
(That doc's F11 line, which predicted nine *conflicted* paths, is now stale —
r802's merge of main into this branch is what converted the conflict into a
silent fast-forward. It is engine's file on `main`; left untouched.)

---

## 2. What moved

`git mv` into `docs/plan/operator-visibility/`, filenames verbatim — 12 files
and no others:

```
00-vision.md  01-requirements.md  02-architecture.md  03-quality.md  04-phases.md
10-ui-v3-spec.md  11-ui-v3-vision.md  12-ui-v3-requirements.md
13-ui-v3-architecture.md  14-ui-v3-quality.md  15-ui-v3-phases.md
16-ui-v3-graph-research.md
```

Git recorded the seven v3 docs as pure renames (`R100`); the five flat docs show
as `M` (flat path restored to main's content) + `A` (our copy at the new path),
which is the correct shape — the flat path keeps a file, with a different
project's content.

### Why this directory name

Not arbitrary. Verified by executing the real helper rather than reading it:

```
$ npx tsx -e "import {projectSlug} from './src/lib/run-control-rules.ts'; ..."
"operator-visibility"
idempotent: true
```

`projectSlug('operator-visibility') === 'operator-visibility'`, so this is
precisely the slugged path `project-tick.ts`'s reading branches already offer to
planners and reviewers (`${corpus}/03-quality.md`, `${corpus}/04-phases.md`, …).
Future rounds find the gates here automatically, with no engine change — which
matters, because `project-tick.ts` is on this project's forbidden list.

### The numbering collision this dissolves

`docs/plan/10-policy-agent-autonomy-and-escalation.md` (engine's, live on main)
shared the `10-` prefix with our `10-ui-v3-spec.md`. After the move the prefix
namespace is per-project and the collision cannot recur.

---

## 3. What deliberately did NOT move

### `docs/plan/artifacts/**` STAYS FLAT — planner ruling, not relitigated

The ruling, recorded here as instructed:

- **Nothing to erase.** `artifacts/` exists only on this branch. No other
  project writes `docs/plan/artifacts/phaseNNN/`, so there is no collision to
  defend against — the entire safety benefit of moving it is zero.
- **Moving it would break the evidence corpus.** The path is hard-coded in ~40
  evidence files, in `scripts/checks/gates-808.sh` (lines 25, 94, 103-105, 144,
  146, 149-150, 158-159), and in every recorded reproduce-command in the phase
  300-800 READMEs. Relocating it would make the recorded evidence
  unreproducible — a real, immediate cost to buy zero collision safety.

Verified independently: `git ls-tree -r --name-only main docs/plan/` contains no
`artifacts/` path at all (46 paths, none under `artifacts/`).

### Untouched because they are engine-v2's / on `main`

- `docs/plan/05..09` control-plane docs
- `docs/plan/10-policy-agent-autonomy-and-escalation.md`
- `docs/plan/archive/**`, `docs/plan/evidence/**`
- the five flat `docs/plan/00..04-*.md` (restored to main's bytes)

---

## 4. Reference repair

Authorship was established per file, not taken on faith. The discriminator used
was `git merge-base --is-ancestor <adding-commit> main`: a file whose adding
commit is reachable from `main` belongs to another lane; a branch-only adding
commit is ours. That split 107 candidate files into 39 main-authored and 68
ours, and each of the 68 was then read at the matching line.

### The rule applied

1. A reference naming one of the **flat five** (`00..04`) from a file this
   project authored is **qualified** to `docs/plan/operator-visibility/…`.
   Rationale: after the move, that bare name resolves to *engine-v2's* file —
   a wrong-document hazard that did not exist before.
2. A reference naming a **v3 doc** (`10..16`) is qualified only when it is
   **path-form** (`docs/plan/X.md`), because those docs exist nowhere else in
   the tree; a bare `13-ui-v3-architecture.md` remains globally unique and is
   not path-broken.
3. **Recorded evidence, API captures and fixtures are never edited**, whatever
   they contain — same principle the operator applied to
   `check-tool-summary.ts`.

### Files UPDATED (13 references across 11 files)

| file:line | reference | why ours |
|---|---|---|
| `scripts/checks/check-classify.ts:3` | R7 of `01-requirements`, `02-architecture` §4.1 | added `85eaef1`, branch-only |
| `scripts/checks/check-duration.ts:3` | R4/R5/R6 of `01-requirements` | added `aa083a5`, branch-only |
| `scripts/checks/check-project-metadata.ts:3-4` | `12-ui-v3-requirements`, `13-ui-v3-architecture` §5 | added `851c429`, branch-only |
| `scripts/checks/check-working-time.ts:3` | `12-ui-v3-requirements` U5, `13-ui-v3-architecture` §4 | added `fe2da16`, branch-only |
| `forge-control-web/app/desktop/team/TeamRow.tsx:31` | `12-ui-v3-requirements` U15a | added `275b9d4`, branch-only |
| `forge-control-web/app/desktop/chat/useAutogrow.ts:15` | `14-ui-v3-quality` | added `206323d`, branch-only |
| `forge-control/src/routes/agents-shared.ts:469` | R7, `02-architecture` §4.1 | added `b2ac907`, branch-only |
| `forge-control-web/app/desktop/live/AgentActivity.tsx:280` | `02-architecture` §4.3 | file predates us (`c7e488d`), so add-commit alone was not decisive; `git blame -L 280,280` attributes the comment to `1e867f4`, confirmed branch-only. Flat-five ambiguity applies |
| `docs/plan/artifacts/phase500/README.md:589` | `12-ui-v3-requirements` U15a | phase-500 artifact, ours |
| `docs/plan/artifacts/phase700/linkage-701.md:135` | `03-quality.md` | phase-700 artifact, ours; flat-five ambiguity |
| `docs/plan/artifacts/phase800/canvas-open.cjs:5` | `12-ui-v3-requirements` U31 | phase-800 artifact, ours |
| `docs/plan/artifacts/phase800/composer-autogrow.cjs:3` | `14-ui-v3-quality` U28 | phase-800 artifact, ours |
| `docs/plan/artifacts/phase800/secret-sentinel.cjs:3` | `14-ui-v3-quality` | phase-800 artifact, ours |

All 13 are comment/prose edits. None changes executable behaviour — proven by
the check scripts and the 766-test suite in §5.

### Cross-references INSIDE the 12 moved docs — zero edits needed, by inspection

Every internal cross-reference in the moved docs is a **bare sibling name**
(`02-architecture.md`, `03-quality.md`, `04-phases.md`,
`16-ui-v3-graph-research.md`, `10-ui-v3-spec.md`, …). Siblings moved together,
so each still resolves — and now resolves *unambiguously*, which it did not
before: `14-ui-v3-quality.md:3` "Extends `03-quality.md`" previously sat beside
engine's flat `03-quality.md` and now sits beside ours.

Checked individually: `00-vision.md` (§20, 42, 63, 80, 82), `01-requirements.md`
(§3, 64), `02-architecture.md` (§131), `11-ui-v3-vision.md` (§3, 37, 38),
`12-ui-v3-requirements.md` (§3, 11, 50), `13-ui-v3-architecture.md` (§78),
`14-ui-v3-quality.md` (§3, 38), `15-ui-v3-phases.md` (§3, 10, 18, 58).

Two deliberate non-edits inside them:
- `14-ui-v3-quality.md:38` — `name=10-ui-v3-spec.md` is a **query parameter** to
  the `/plan/doc` endpoint (a doc *name* on the wire), not a filesystem path.
- `15-ui-v3-phases.md:10` — `docs/plan/artifacts/phase<NNN>/` is correct as-is;
  artifacts stays flat.
- `01-requirements.md:64` names `docs/plan/perf/baseline.md`, which is not one
  of the 12 and does not exist in the tree (an unfulfilled phase-3 plan). Out of
  scope for a relocation round; left as written.

### Files deliberately NOT touched — recorded evidence, captures, fixtures

| path | what it is |
|---|---|
| `scripts/checks/check-tool-summary.ts:146,150,410,412,495` | **operator-mandated non-reference.** `/repo/docs/plan/00-vision.md` is a synthetic fixture for the clipper; lines 150/412/495 are the paired expected-output assertions for the same fixture. Changing any of them alters fixture bytes and can move assertion outcomes. Left byte-identical; the script still passes (§5). |
| `docs/plan/artifacts/phase300/after-302/chat-thread.json` (20 hits), `…/agents.json`, `…/baseline/agents.json`, `…/plan-endpoint.json`, `…/traversal.txt` | recorded API responses |
| `docs/plan/artifacts/phase500/gates-506.txt:46` | recorded `git status` output from round 506's gate run |
| `docs/plan/artifacts/phase600/capture-orientation.html:446`, `capture-plandoc.html` | recorded DOM captures |
| `docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json` | pinned thread fixture consumed by gates |
| `docs/plan/artifacts/phase700/*.json` | recorded captures |
| `docs/plan/artifacts/phase300/verification-306.md:101`, `phase700/linkage-701.md:77` | recorded `docs[]` API response listings, quoted verbatim as evidence |

### Files deliberately NOT touched — another lane's, referencing main's flat corpus

These reference `main`'s flat `00..04`, which still exists and still means what
it says. Several are also on this project's forbidden-file list.

`forge-control/src/lib/project-tick.ts`, `project-tick.test.ts`,
`project-reconcile.ts`, `project-reconcile.test.ts`, `cp3-linkage.test.ts`,
`gemini-qa-cli.test.ts`; `forge-control/src/routes/chat.ts`, `projects.ts`;
`scripts/perplexity.mjs`, `scripts/research-browser.mjs`, `scripts/gemini-qa.mjs`;
`docs/tools/deploy-playbook.md`, `gemini-qa.md`, `perplexity.md`,
`research-browser.md`; `docs/research/round-399-41e8757d.md`;
`docs/plan/05-control-plane-boundary.md`, `07-control-plane-architecture.md`;
`docs/plan/evidence/**`, `docs/plan/archive/**`.

Authorship of each was confirmed branch-external before it was set aside.

### `scripts/checks/gates-808.sh` — nothing for round 902 to land

The brief asked for the exact line number if the gate script referenced a moved
doc. **It does not.** Its only `docs/plan` references are `artifacts/` paths
(lines 25, 94, 103-105, 144, 146, 149-150, 158-159), and artifacts stays flat,
so every one of them remains correct. The file was not opened for editing.

---

## 5. The r809 prose-doc carry (note b) — closed

`scripts/checks/gates-808.sh:114-123` (commit `c5bce64`) already carries the
operator waiver: its forbidden-file regex is
`project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files` —
**`FileExplorerPanel` is absent**. Both prose docs still listed it, so the rule
was waived in code but re-enforced by prose. Amended to match the gate exactly:

- `docs/plan/operator-visibility/03-quality.md` §3 item 3
- `docs/plan/operator-visibility/14-ui-v3-quality.md` "Universal gates" item 3

`FileExplorerPanel` removed from both lists; `VaultFileList*`, `routes/files.ts`
and every engine file stay forbidden; each carries the inline note:

> **OPERATOR WAIVER 2026-08-16: FileExplorerPanel.tsx only; files-pane-fast-light
> completed 2026-08-05 so the collision this rule guarded against no longer
> exists.**

The flat `docs/plan/03-quality.md` was **not** edited — that is engine-v2's file
on `main` and its forbidden list is theirs.

---

## 6. Verification — pasted verbatim

### Step 3, the three mandated checks

```
### CHECK 1 — git diff --numstat main -- docs/plan/   (filtered: entries NOT under operator-visibility/ or artifacts/)
(no output above = no flat docs/plan path differs from main)

### CHECK 1b — any entry under docs/plan/ with a NON-ZERO deletion count
(no output above = ZERO deletions anywhere under docs/plan/)

### CHECK 1c — the 12 new corpus paths, addition-only proof
82	0	docs/plan/operator-visibility/00-vision.md
123	0	docs/plan/operator-visibility/01-requirements.md
202	0	docs/plan/operator-visibility/02-architecture.md
77	0	docs/plan/operator-visibility/03-quality.md
114	0	docs/plan/operator-visibility/04-phases.md
70	0	docs/plan/operator-visibility/10-ui-v3-spec.md
49	0	docs/plan/operator-visibility/11-ui-v3-vision.md
75	0	docs/plan/operator-visibility/12-ui-v3-requirements.md
124	0	docs/plan/operator-visibility/13-ui-v3-architecture.md
56	0	docs/plan/operator-visibility/14-ui-v3-quality.md
93	0	docs/plan/operator-visibility/15-ui-v3-phases.md
57	0	docs/plan/operator-visibility/16-ui-v3-graph-research.md

### CHECK 2 — git diff --name-status main -- docs/plan/ | grep -E '^(D|M)' | grep -vE 'operator-visibility/|artifacts/'
(no output above = PASS)

### CHECK 3 — git ls-tree --name-only main docs/plan/ | while read p; do git diff --quiet main -- "$p" || echo "CHANGED: $p"; done
(no output above = PASS)

### CHECK 3b — stronger, recursive form: every file main has under docs/plan/
(no output above = PASS; 46 paths checked)
```

Every deletion count under `docs/plan/` is zero. Every one of main's 46
`docs/plan/` paths is byte-identical. The 1321-line erasure is gone.

The `03-quality.md` / `14-ui-v3-quality.md` line counts above (77, 56) include
the §5 waiver amendment; both are addition-only against `main` because they now
live at paths `main` has never had.

### Immediately after the `git mv` + restore, before any reference repair

```
$ git diff main -- docs/plan/00-vision.md docs/plan/01-requirements.md \
    docs/plan/02-architecture.md docs/plan/03-quality.md docs/plan/04-phases.md
(printed nothing)
```

### Self-verification suite

```
forge-control      $ npx tsc --noEmit    → EXIT=0, no output
forge-control-web  $ npx tsc --noEmit    → EXIT=0, no output

forge-control      $ npm test  (tsx --test src/lib/*.test.ts)
  # tests 766
  # suites 149
  # pass 766
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 4933.681493

$ bash scripts/checks/dollar-sweep.sh
  primary gate: 49 hit(s), all allowlisted.
  dollar-sweep.sh: PASS — every primary-gate hit is on the allowlist.
  EXIT=0

forge-control-web  $ NODE_ENV=production npm run build → BUILD_EXIT=0

$ npx tsx scripts/checks/<name>.ts
  check-classify             exit=0 | ALL PASS — agent-kind classifier + panel kind grammar
  check-duration             exit=0 | ALL PASS — duration helpers
  check-project-metadata     exit=0 | ALL PASS — project metadata builder
  check-working-time         exit=0 | ALL PASS — working-time (U5)
  check-tool-summary         exit=0 | ALL PASS — tool summary table
```

**766 tests, unchanged from `c5bce64`** — the comment-only reference edits moved
the number by zero, as required. `check-tool-summary` passing is the direct
evidence that the synthetic `00-vision.md` fixture was left byte-identical.

---

## 7. What round 902 and later rounds inherit

- The corpus is at `docs/plan/operator-visibility/`, the path
  `projectSlug('operator-visibility')` already produces, so `project-tick.ts`'s
  existing reading branches resolve it with no engine change.
- `docs/plan/artifacts/**` is unchanged and flat; every recorded
  reproduce-command in phases 300-800 still runs verbatim.
- `scripts/checks/gates-808.sh` was **not** touched and needs no doc-path fix —
  round 902 owns that file and has no relocation work waiting in it.
- A merge to `main` is still a fast-forward, but it is now a **safe** one: it
  adds 12 files under a new directory and modifies none of main's.
