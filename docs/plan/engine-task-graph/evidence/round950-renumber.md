# Round 950 — the migration renumber, the baseline harness, and a two-word count

Three items, all post-deploy, all in the worktree. Written the day of, from the
transcripts below; nothing here is reconstructed.

Repo: `ai-os`, branch `project/8c591d6c`, HEAD at start `bd457a2`.

---

## 1. `0040_task_graph.sql` → `0042_task_graph.sql`

### 1.1 Why 0042 and not 0041

`0041_ui_dismissals.sql` already exists (main's). The next free number is 0042.

### 1.2 The move

```
$ git mv db/migrations/0040_task_graph.sql db/migrations/0042_task_graph.sql
$ sha256sum db/migrations/0042_task_graph.sql
5c0ad159911d10b60930c3df3e45296b8b853f91192c9abe1141b07753b1dc3b
```

Identical to the digest read immediately before the move. **The `git mv` changed
no bytes.**

The same commit then edited the file's *comments* — a renumber-provenance
paragraph in the header and the provenance sentence inside
`COMMENT ON COLUMN project_tasks.graph_frozen` — so the committed file hashes
`5a0c9d58cef400c7…`. This is stated wherever the first digest is, because a
reader who runs `sha256sum` gets the second one and would otherwise conclude the
document lies. No DDL and no backfill statement was touched; §1.5 proves that by
execution rather than by assertion.

### 1.3 THE ENUMERATION WAS WRONG — this is the finding

Phase 8A enumerated **six** referencing files and named them:
`check-migration-0040.sh`, `check-r69-straddle.sh`, `task-graph.ts`,
`app/api.ts`, `04-phases.md` step 3, and "several evidence files".

Re-derived at round 950:

```
$ grep -rn "0040_task_graph" --exclude-dir=node_modules --exclude-dir=.git . | wc -l
75
$ grep -rln "0040_task_graph" --exclude-dir=node_modules --exclude-dir=.git . | wc -l
23
```

**23 files, 75 hits.** Two specific defects in the enumeration:

1. **`forge-control/src/lib/migrations.test.ts` was missed, and it is the only
   ENFORCED reference in the repo.** It reads the migration by hard-coded
   filename *and* asserts the filename is in the enumerated corpus:

   ```ts
   assert.ok(FILES.includes("0040_task_graph.sql"), …);
   const sql = readFileSync(`${MIGRATIONS_DIR}/0040_task_graph.sql`, "utf8");
   ```

   A renumber that trusted 8A's list would not have failed quietly — `pnpm test`
   would have gone red with the corpus printed. So the safety net held; the
   *enumeration* is what was wrong. The filename now lives in one constant,
   `TASK_GRAPH_MIGRATION`, with the failure message telling the next renumberer
   where to change it.

2. **`forge-control-web/app/api.ts` was named and does NOT reference the
   migration by filename at all.** It carries four bare `migration 0040`
   mentions in field doc-comments. A phantom entry in an enumeration is the same
   class of defect as a missing one: it is a pin that cannot be resolved.

Also missed by 8A: `forge-control/src/db/projects.ts`, `schedule-metrics.ts`,
`schedule-metrics.test.ts`, `task-graph-replay.test.ts`,
`scripts/deploy/payload-verify.json`, and `01-requirements.md`,
`02-architecture.md`, `03-quality.md`.

### 1.4 What was rewritten, and what deliberately was not

The rule applied, because the brief did not settle it and it is a convention
everything downstream inherits:

**Rename the IDENTIFIER, not the EVENT.**

* `0040_task_graph.sql` is a **path**. It must resolve on disk. Rewritten to
  `0042_task_graph.sql` in every live file — 16 forward-pointer substitutions
  across 10 files, plus the `db/migrations/…` prefixed form in 6 files.
* Bare `0040` in phrases like `pre-0040 schema`, `migration 0040's backfill`,
  `a row inserted after 0040` names a **deployment event that really happened
  under that name** on 2026-08-18. Those are true as written. Rewriting them to
  0042 would make them false: **nothing named 0042 has ever been applied to
  `content_forge`.** 27 such usages, plus two `describe()` strings quoted
  verbatim in `01-requirements.md` (`D7 — a project carrying migration 0040's
  backfilled closure`, `D7 — the pre-0040 read at step 2b refuses on the legacy
  sentinel`), are left standing and documented at R70.
* **Phase-evidence files were not rewritten.** Ten files under `evidence/` and
  `operator-visibility/artifacts/` record what was executed under the old name.
  Rewriting a transcript to match a later rename falsifies the record.

The one exception is `evidence/phase2-replay.md`, whose `<!-- BEGIN GENERATED:
r20-census -->` region pins `sha256(db/projects.ts)`. My one-line comment edit
in `projects.ts` moved that digest, so `check-r20-census.py` went red. The
region declares itself generated and says `--write` regenerates it, so it was
regenerated rather than hand-edited. The diff is **one line, the sha stamp**;
every count in the region (129 hits / 142 case-insensitive / 51 code / 78
comment / 3 sql-annotations / 25 symbols) is unchanged.

### 1.5 The script keeps its name, and says so

`check-migration-0040.sh` was **not** renamed. Measured reason:

```
$ grep -rn "check-migration-0040" --exclude-dir=node_modules --exclude-dir=.git . \
    | grep -v "^./scripts/checks/check-migration-0040.sh" | wc -l
60          # across 20 files
```

24 of those hits are in live files (`03-quality.md`, `01-requirements.md`,
`02-architecture.md`, `04-phases.md`, `task-graph-replay.test.ts`, and six
sibling instruments that copy its scratch-database guard); 36 are in nine
evidence files that must not be rewritten. The brief made the rename explicitly
optional. So the filename is a stable identifier and the subject is `$MIGRATION`,
and a banner at the top of the file says exactly that — the disclosure the brief
required.

**Two functional defects found and fixed while in there:**

* The skip in the apply loop was a suffix glob, `case "$f" in
  *0040_task_graph.sql)`. After a renumber it would have matched **nothing, in
  silence** — the subject would have been applied in the loop as well as twice
  below. It now matches `"$MIGRATION"` exactly, and a new assertion, *the
  subject was globbed and skipped exactly once*, fails if `$MIGRATION` ever
  names a path the glob does not produce. `EXPECTED_ASSERTIONS` moved 43 → 44 in
  the same edit, as the file's own rule requires.
* The loop's label read `applied N migrations below 0040`. **It was already
  false before this round**: the loop is `for f in db/migrations/*.sql` skipping
  only the subject, so it was also applying `0040_usage_hourly.sql` and
  `0041_ui_dismissals.sql`, both of which sort *above* the old name. The label
  now states what the loop does.

### 1.6 The live database — before, and after

Read-only, against `content_forge`, as the brief instructs. **Nothing was
applied.**

BEFORE the `git mv`:

```
depends_on   | ARRAY   | nullable=YES | default=<none>
graph_frozen | boolean | nullable=NO  | default=false
workstream   | text    | nullable=NO  | default='main'::text
write_set    | ARRAY   | nullable=NO  | default='{}'::text[]
project_tasks_depends_on_gin
project_tasks_workstream_idx
total=475 frozen=473 null_depends=2
```

AFTER the whole change:

```
depends_on   | ARRAY   | nullable=YES | default=<none>
graph_frozen | boolean | nullable=NO  | default=false
workstream   | text    | nullable=NO  | default='main'::text
write_set    | ARRAY   | nullable=NO  | default='{}'::text[]
project_tasks_depends_on_gin
project_tasks_workstream_idx
total=475 frozen=473 null_depends=2

SELECT count(*) FROM project_tasks WHERE graph_frozen <> (depends_on IS NOT NULL);
 0
```

Byte-identical, and R71's consistency pair is 0. **The rename changed nothing
about live state**, which is the property the brief asked to be proved rather
than assumed.

`8ea0cc08` (operator-visibility) census at the time of this work: `done|159`,
no `running` and no `pending` row. Nothing was restarted and nothing was
deployed by this task.

### 1.7 A latent trap found in passing — reported, not silently worked around

`migrations.test.ts`'s `stripComments()` truncates every line at the first `--`,
**including inside a SQL string literal**, and `statements()` then splits on
`;`. The migration's own `COMMENT ON COLUMN project_tasks.workstream` warns
about the semicolon half of this. The `--` half is undocumented, and I tripped
it while writing the provenance sentence into the `graph_frozen` comment: a
`--` inside that literal truncates the statement and loses its closing `';`.
Caught before commit and worked around by rewording. **Nothing enforces
either constraint**, which makes it a live trap for the next person who edits a
`COMMENT ON` body. Recommended follow-up: a lint asserting no `--` and no `;`
inside a single-quoted literal in the migration corpus. Not done here — it is
outside this round's write-set and could go red on migrations this round has no
mandate over.

---

## 2. `scripts/checks/measure-prompt-baseline.sh` — ruled round 244, delivered now

Round 900 established that this file **had never existed in repo history**.

Built to reproduce the ad-hoc harness rounds 242/243 ran by hand, keeping both
properties that made it trustworthy, plus the parameter the brief named:

* prints `sha256(project-tick.ts)` for **every** tree it measures;
* **refuses to report a number** unless the `GRAPH_GUIDE` export matches what
  that tree must have;
* takes the project id as a parameter, **defaulting to a real 36-character
  uuid** — the flat +34 that cost three rounds was hidden by a 2-char `"p1"`.

Trees are exported with `git archive`, `node_modules` is symlinked, **no source
is symlinked**.

### 2.1 The GRAPH_GUIDE control, generalised

Rounds 242/243 compared `GRAPH_GUIDE` against a table of known shas, which works
only for refs in the table. This harness derives the expectation from the
exported bytes:

* **static** — does the exported `project-tick.ts` text declare the export?
* **runtime** — does the loaded module object carry the binding?

Read by different mechanisms, so they agree only if the loader loaded the file
that was exported. The driver additionally `realpath`s the module and refuses if
it resolves outside the export directory. The sha table is still cross-checked
whenever the ref is in it.

### 2.2 PROVED BY RE-DERIVING VALUES ALREADY ON RECORD

The round-242 table in `project-tick.test.ts`'s NF7 block, reproduced exactly:

```
$ scripts/checks/measure-prompt-baseline.sh

--- d9858b9 ---   sha256 b10ddc0190bd280e   GRAPH_GUIDE no    MEASURED  9221
--- 05f2842 ---   sha256 00bcdeae5cfbd555   GRAPH_GUIDE yes   MEASURED 11619
--- fe14a7e ---   sha256 c4141f17fde418ef   GRAPH_GUIDE yes   MEASURED 12095
--- HEAD    ---   sha256 cca92ea2df40a744   GRAPH_GUIDE yes   MEASURED 12227
  controls passed : 17     failures : 0
PASS — every tree measured under both controls, and every ledger row reproduced.
```

**The 9221 baseline re-derived**, and all three sha256 digests match the record.
The `"p1"` column too:

```
$ scripts/checks/measure-prompt-baseline.sh --project-id p1 --ref d9858b9 --ref 05f2842 --ref fe14a7e
MEASURED  9187 / 11585 / 12061
```

A flat **−34** at all three shas — 36 − 2, one interpolation site — which is
round 242's finding reproduced from scratch.

### 2.3 WATCHED GOING RED, twice

A control never seen to fail is a claim. Both injectors are documented in the
file, off by default, and announce themselves:

```
$ MPB_INJECT_SHADOW=d9858b9 scripts/checks/measure-prompt-baseline.sh --ref d9858b9
  !! FAULT INJECTED: source replaced by a symlink to the live tree
  FAIL  d9858b9: REFUSED — project-tick.ts resolved to …/forge-control/src/lib/project-tick.ts,
        which is OUTSIDE the export /tmp/measure-prompt-XXXXXX/d9858b9 — this is the shadow
        tree, and the number it would produce is not this ref's
  FAIL: no control ran at all — a sweep whose probes all miss must not certify itself.
exit 1
```

```
$ MPB_INJECT_SWAP=d9858b9 scripts/checks/measure-prompt-baseline.sh --ref d9858b9
  !! FAULT INJECTED: live source copied over the exported source
    exports GRAPH_GUIDE : yes (static and runtime agree — shadow-tree control passed)
    MEASURED length     : 12227
  FAIL  sha256 is cca92ea2df40a744, ledger says b10ddc0190bd280e — NOT the tree the ledger measured
  FAIL  GRAPH_GUIDE is 'yes', ledger says 'no'
  FAIL  length 12227, ledger says 9221 (delta 3006)
exit 1
```

The second is the instructive one. With the bytes swapped, static and runtime
agree **honestly**, so the GRAPH_GUIDE control *cannot* catch it — the sha pin
is what does. That is why both exist, and it is a limit of the control worth
knowing rather than a hole to paper over.

### 2.4 A finding the harness surfaced: NF7 headroom is 44, not 150

`BASELINE 9221 + BUDGET 3050 = 12271`. HEAD measures **12227**. Headroom is
**44 characters**. Round 242/244 recorded "150 live" — correct then, at 12121.
Rounds 900/902/910's screenshot-convention text spent 106 of it. G5 passes and
nothing is wrong, but the next round to add prompt text should measure first.

---

## 3. "six payload shapes" → seven

`DECLARED_CASES = 7` in `scripts/checks/check-screenshot-render-shapes.ts`.
**Verified by RUNNING the instrument, not by reading the brief:**

```
$ tsx scripts/checks/check-screenshot-render-shapes.ts
PASS  A. … PASS  B. … PASS  C. … PASS  D. … PASS  E. … PASS  F. … PASS  G. …
ALL PASS — 16 checks          # 16 = DECLARED_CASES(7) + 2 + 7
exit 0
```

Seven cases, A–G. The brief's number was right; it was still checked.

Two comments corrected. `project-tick.ts`'s `SCREENSHOT_CONVENTION`
doc-comment was wrong **twice over**: it said "six" and then enumerated only
**five** shapes by name. It now says seven and enumerates all seven (A–G),
including the two it had been missing — the unstamped-name `Read` (F, 1 ref with
`ts: null`) and the prose-mention negative control (G, 0 refs).
`project-tick.test.ts` likewise.

**Cost to the prompt: zero.** `sha256(project-tick.ts)` moved
`cca92ea2df40a744` → `d3665eb18b2589e5`, and the maximal planner prompt measured
`12227` both before and after — round 244's standing claim that reasoning lives
in doc-comments because they cost the prompt nothing, measured again rather than
repeated.

---

## 4. Green gate

```
pnpm typecheck                                      clean
pnpm test                                           1293/1293 pass, 0 fail
scripts/checks/check-migration-0040.sh              PASS — 44/44 assertions
scripts/checks/check-r69-straddle.sh                exit 0
docs/plan/…/check-corpus-map.py                     OK — R1..R71, NF1..NF7
docs/plan/…/check-instrument-identity.py            OK — 12 headers, 33 manifest lines
scripts/checks/check-instrument-typecheck.sh        PASSED — 7/7, manifest complete
scripts/checks/check-r20-census.py                  PASS (after --write; see §1.4)
grep -rn "pm2 restart forge-executor" (R66)         4 hits, unchanged
scripts/checks/measure-prompt-baseline.sh           PASS — 17 controls, 0 failures
```

`check-migration-0040.sh` and `check-r69-straddle.sh` were run against the
conventional scratch database `forge_tg_scratch`, created while connected to the
`postgres` maintenance database. **No statement of any kind was issued against
`content_forge` except the read-only `SELECT`s quoted in §1.6.**

## 5. What would have made these instruments report a pass wrongly

1. **The renumber "verified" by a green suite that never read the new path.**
   Excluded: `check-migration-0040.sh` prints `$MIGRATION` and its sha256 in its
   build-identity block, and the new *skipped exactly once* assertion fails if
   `$MIGRATION` names a path the migrations glob does not produce.
2. **The baseline harness measuring HEAD three times and calling it three
   trees.** This is the failure the whole file is built against, and it was
   *demonstrated* rather than argued — §2.3, exit 1 both times.
3. **The seven-shapes fix copying a number out of a brief.** Excluded by running
   the instrument and reading its own census line (16 = 7 + 2 + 7).
4. **The live-database claim asserted from "the file did not change".** Excluded
   by querying `information_schema` before and after and pasting both, plus
   R71's consistency pair.
