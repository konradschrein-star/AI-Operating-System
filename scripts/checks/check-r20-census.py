#!/usr/bin/env python3
"""R20's census of `round` in db/projects.ts — measured, not maintained.

WHY THIS SCRIPT EXISTS. `03-quality.md` §3.2 Phase 2 makes *"grep -n "round"
forge-control/src/db/projects.ts with a justification for every surviving
occurrence"* a reviewer gate, and `evidence/phase2-replay.md` §7 is the artefact
that discharges it. Through rounds 202–205 that artefact was a HAND-WRITTEN
table, and it rotted twice over:

  * round 205 found the headline pair stale — the document said 85 hits / 92
    case-insensitive while the file had grown to 99 / 108, in a table the
    round-204 commit had itself edited;
  * re-measuring round 205's finding turned up a second defect it had not
    looked for: §7's per-symbol distribution was never a measurement at ANY
    commit. At `27d300f` §7.3 credited `sweepDanglingDependencies` with "seven
    hits, all of them comments" when that symbol had ZERO, and four other rows
    were off by between 2 and 4. The rows were reconciled to sum to the correct
    headline rather than counted, which is precisely the failure mode standing
    rule 3 names: the instrument lied before the code did.

Eleven of the nineteen `round`-bearing lines the fix cycle added are the literal
citation "round 204", a string that recurs every fix cycle. A hand-maintained
census is therefore guaranteed to rot again. So the census is generated, and
the document holds a GENERATED REGION this script verifies byte-for-byte.

  $ scripts/checks/check-r20-census.py            # verify; non-zero if stale
  $ scripts/checks/check-r20-census.py --write    # regenerate the region

SELF-VALIDATION (standing rule 3 — what would make this instrument report a
pass wrongly?). Run with `--at <git-sha>` it censuses that commit's copy of the
file instead of the worktree's. At `27d300f` it reproduces the numbers the
round-202 author derived by hand — 85 hits, 92 case-insensitive, 41 code / 44
comment — without being told them. An attribution rule that agreed with a human
on a tree it was not tuned for, and disagrees only where the code changed, is
calibrated rather than merely self-consistent. That check is a test case:
`--self-check` runs it and fails if the four numbers move.

The R20 ASSERTION itself is mechanical here, not left to prose: every
non-comment `round` line inside the three scheduling symbols must appear in
ALLOWED_SCHEDULING_LINES with a justification. A new one fails the check by
name. That is the requirement — a census that merely counted would let a fresh
predicate in as long as somebody added a row for it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from collections import defaultdict

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SOURCE = "forge-control/src/db/projects.ts"
DOC = "docs/plan/engine-task-graph/evidence/phase2-replay.md"

BEGIN = "<!-- BEGIN GENERATED: r20-census -- scripts/checks/check-r20-census.py -->"
END = "<!-- END GENERATED: r20-census -->"

# A top-level declaration. Column 0 only: this file nests nothing at top level,
# and anchoring there is what keeps a `const round = …` inside a function body
# from being mistaken for a symbol of its own.
DECL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?"
    r"(?:function|const|let|interface|type|class|enum)\s+([A-Za-z_$][\w$]*)"
)

# The three symbols R20 is *about*. Everything else in the file may say `round`
# as freely as it likes — R20 constrains the scheduler, not the module.
SCHEDULING_SYMBOLS = ("promoteReadyTasks", "claimReadyTasks", "sweepDanglingDependencies")

# Every non-comment `round` line permitted inside those three symbols, keyed by
# its stripped text, valued by the justification. Anything else is a finding.
ALLOWED_SCHEDULING_LINES = {
    "AND l.round < pt.round": (
        "R69's legacy-row term. Reads `round` only ABOUT legacy rows (the "
        "NOT EXISTS on `l` is guarded by `l.depends_on IS NULL`) and only "
        "while any exist; on a project with no NULL row the sentinel test "
        "short-circuits and `round` is never consulted. TODO(R12-retire)."
    ),
    "AND earlier.round < pt.round": (
        "R12's legacy branch — today's rule, verbatim, for rows that were "
        "never graph-scheduled. Inside the `pt.depends_on IS NULL` arm. "
        "TODO(R12-retire)."
    ),
    "ORDER BY pt.round ASC, pt.created_at ASC": (
        "Not a predicate, an ORDERING (§7.2). R15 keeps the transaction shape "
        "and `02-architecture.md` §3.4 keeps this clause byte-identical. It "
        "cannot gate promotion: every row it sorts is already `ready`."
    ),
    "AND pt.status IN ('pending','ready')     -- decision 2, round 204": (
        "SQL ANNOTATION. The predicate is on `status`; the only `round` on the "
        "line is inside the trailing `--` comment naming the decision."
    ),
    "AND d.project_id = pt.project_id   -- R27, round 204": (
        "SQL ANNOTATION. The predicate is R27's project correlation; the only "
        "`round` on the line is inside the trailing `--` comment."
    ),
    # The key is the line's STRIPPED text, so interior whitespace is part of it.
    # Round 972 re-indented this line from five spaces to three while moving the
    # statement, which silently turned a justified line into an unjustified one —
    # invisible in a diff that reads as a re-indent. Round 974 re-keyed it and
    # left this note rather than normalising whitespace in the matcher: two lines
    # whose only difference is spacing ARE two different lines to a reader, and a
    # matcher that ignored that would let a genuinely edited predicate keep an old
    # justification.
    "AND d.project_id = pt.project_id)   -- R27, round 204": (
        "SQL ANNOTATION, as above, closing the second subquery."
    ),
    # ---- R72's lane cap, round 972; entered here round 974. --------------------
    # THIS SCRIPT HAD BEEN CRASHING SINCE af3cba6 AND NOBODY RAN IT. The cap's two
    # CTEs added `round` inside promoteReadyTasks(), `check_r20()` correctly called
    # them unjustified, and `render()` then died with a KeyError on the same text
    # before the finding could be printed — so the gate `03-quality.md` §4 makes
    # mandatory for phase 2 reported a traceback rather than a verdict for two
    # commits. Both lines are PROJECTIONS FEEDING AN ORDERING, the case §7.2
    # already recognises for `ORDER BY pt.round ASC`, and neither can gate a
    # promotion: `eligible` is computed by the predicate above them and the cap is
    # applied strictly afterwards.
    "SELECT pt.id, pt.project_id, pt.workstream, pt.round, pt.created_at": (
        "R72's `eligible` CTE projection. Not a predicate — it is the column list "
        "the cap's ORDER BY consumes one CTE later. Every row it projects has "
        "ALREADY satisfied the ready rule; dropping `round` from it would change "
        "which row of a lane goes first, never whether any row may go at all."
    ),
    "ORDER BY round ASC, created_at ASC, id ASC) AS rn": (
        "R72's lane-head tie-break, and an ORDERING for the same reason as "
        "`ORDER BY pt.round ASC` above (§7.2). It picks WHICH of a lane's "
        "eligible rows is admitted first — deliberately the same order "
        "claimReadyTasks() would have run them in — and cannot make an "
        "ineligible row eligible."
    ),
}

# What §7's prose says the calibration run produces. Frozen so that a change in
# the attribution rule fails loudly instead of silently re-baselining history.
SELF_CHECK_COMMIT = "27d300f"
SELF_CHECK_EXPECTED = {"hits": 85, "ihits": 92, "code": 41, "comment": 44}

# The per-symbol distribution at the same commit, frozen for a DIFFERENT reason
# and worth keeping the two apart. The four totals above are CALIBRATION: they
# were derived by a human, by hand, at `27d300f`, and this rule reproduces them
# without being shown them. The map below is REGRESSION DETECTION: it is this
# rule's own output, pinned.
#
# It exists because the totals cannot see an attribution change. Moving a
# doc-comment from the declaration below it to the one above it redistributes
# rows between symbols while `hits`, `code` and `comment` all stay put —
# measured, not supposed: that mutation moves 36 rows of the generated table and
# the totals-only self-check called it OK. The danger is not the red run, which
# the stale-region check would catch anyway; it is that `--write` would then
# LAUNDER the altered rule into the document as a fresh measurement. Pinning the
# distribution means the rule must be re-justified deliberately, not regenerated
# accidentally.
# The round-202 hand-written §7 table, exactly as it stood at `27d300f`: the
# eight §7.4 groups, plus §7.1's promote count, §7.2's claim count and §7.3's
# sweep count. Reproduced under rule="trailing" — which is what makes this
# CALIBRATION rather than self-agreement. A human produced these numbers by
# hand, from the same file, before this script existed; a rule that reproduces
# all eleven of them is reading the file the way a careful reader did.
#
# Keep this even after §7 is regenerated. It is the evidence that the round-202
# table was a measurement under a different convention, and the guard against a
# future round concluding — as this one nearly did, in writing — that it was
# invented. (§7.1 is deliberately absent: it counted promote's two PREDICATE
# lines, not that symbol's hits, so it is not a group total. Those two lines are
# asserted directly, and far more strictly, by ALLOWED_SCHEDULING_LINES.)
ROUND202_TABLE = [
    (["(module preamble)"], 2),
    (["ProjectTask", "TASK_COLS", "TASK_COLS_PT", "toGraphTask"], 7),
    (["createProject", "createTask", "insertChainRow", "createFixChain"], 26),
    (["listTasksForProject", "getProject", "getTask"], 3),
    (["setTaskStatus", "markVerdictTaskDone"], 8),
    (["retryTask", "unwedgeProject"], 10),
    (["roundIsComplete", "bumpFixCycle"], 7),
    (["listVerdictRound", "VerdictRoundRow", "listSettledRunningTasks", "ChainRowOutcome"], 10),
    (["sweepDanglingDependencies"], 7),   # §7.3's "seven hits, all of them comments"
    (["claimReadyTasks"], 1),             # §7.2's ORDER BY
]

SELF_CHECK_EXPECTED_SYMBOLS = {
    "(module preamble)": (0, 2),
    "ChainRowOutcome": (0, 2),
    "ProjectTask": (1, 3),
    "TASK_COLS": (1, 0),
    "TASK_COLS_PT": (1, 0),
    "VerdictRoundRow": (0, 3),
    "claimReadyTasks": (1, 2),
    "createFixChain": (4, 8),
    "createProject": (1, 1),
    "createTask": (7, 1),
    "insertChainRow": (6, 2),
    "listTasksForProject": (1, 0),
    "listVerdictRound": (3, 0),
    "markVerdictTaskDone": (0, 6),
    "promoteReadyTasks": (2, 7),
    "roundIsComplete": (4, 3),
    "toGraphTask": (1, 0),
    "unsettledVerdictTasks": (0, 2),
    "unwedgeProject": (8, 2),
}


class CensusError(RuntimeError):
    """A probe that could not run. Raised rather than returning a partial
    census, because a census short of the file is indistinguishable from a
    clean one once it has been formatted into a table."""


def read_source(at: str | None) -> str:
    if at is None:
        with open(os.path.join(REPO, SOURCE), encoding="utf-8") as fh:
            return fh.read()
    proc = subprocess.run(
        ["git", "-C", REPO, "show", f"{at}:{SOURCE}"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise CensusError(f"git show {at}:{SOURCE} failed: {proc.stderr.strip()}")
    return proc.stdout


def census(text: str, rule: str = "tsdoc") -> dict:
    """Attribute every `round`-bearing line to its enclosing top-level symbol.

    THE ATTRIBUTION RULE, stated so a reviewer can dispute the rule instead of
    recounting the rows. A line is `comment` when it opens with `/*`, `*`, or
    `//`; a line carrying code plus a trailing SQL `--` comment counts as CODE,
    and is additionally reported as an sql-annotation when every `round` on it
    falls inside that trailing comment. Anything before the first declaration is
    the module preamble. What is left is where a free-standing comment BLOCK
    goes, and there are two defensible answers — so both are implemented:

      rule="tsdoc"    (default) a comment block belongs to the declaration
                      BELOW it, across intervening blank lines. This is the
                      TSDoc convention: `/** … */` immediately above a symbol
                      documents that symbol.
      rule="trailing" a comment block belongs to the declaration ABOVE it.

    THE TWO RULES ARE NOT COSMETIC and the difference is why this option exists.
    Round 205 reported §7's headline counts stale; re-measuring under "tsdoc"
    made it look as though the round-202 per-symbol table had been invented,
    because `sweepDanglingDependencies` measured ZERO where the table claimed
    seven. It was not invented. Under "trailing" — the convention that author
    was actually applying — every one of the eight §7.4 groups reproduces to the
    row, the sweep included. The table was a measurement under a different
    convention, and this docstring exists so the next reviewer is not told
    otherwise. `--self-check` asserts that reproduction, which is the strongest
    calibration available here: the instrument can reproduce a human's table
    when told to use the human's convention.

    The census ships "tsdoc" because a 70-line `/** … */` sitting directly above
    `sweepDanglingDependencies` documents the sweep, not the `const` before it.
    R20's conclusion is invariant under the choice — no scheduling predicate
    reads `round` under either rule — so this is a change of presentation, made
    explicitly, not a change of finding.
    """
    lines = text.split("\n")
    owner: list[str | None] = [None] * len(lines)
    is_comment = [False] * len(lines)

    current = "(module preamble)"
    in_block = False
    pending: list[int] = []

    for i, ln in enumerate(lines):
        stripped = ln.strip()

        if in_block:
            is_comment[i] = True
            pending.append(i)
            if "*/" in ln:
                in_block = False
            continue
        if stripped.startswith("/*"):
            is_comment[i] = True
            pending.append(i)
            if "*/" not in stripped:
                in_block = True
            continue
        if stripped.startswith("//"):
            is_comment[i] = True
            pending.append(i)
            continue
        if not stripped:
            # A blank line does not break the bond between a doc-comment and
            # the declaration under it.
            owner[i] = current
            continue

        if rule == "trailing":
            # The block belongs to the declaration ABOVE it: flush before the
            # new declaration takes effect.
            for j in pending:
                owner[j] = current
            pending = []
        match = DECL.match(ln)
        if match:
            current = match.group(1)
        for j in pending:
            owner[j] = current
        pending = []
        owner[i] = current

    for j in pending:
        owner[j] = current
    for i, o in enumerate(owner):
        if o is None:
            owner[i] = current

    hits = [i for i, ln in enumerate(lines) if "round" in ln]
    ihits = [i for i, ln in enumerate(lines) if "round" in ln.lower()]

    if not hits:
        raise CensusError(
            "zero `round` hits — the probe missed the file rather than the "
            "file being clean; refusing to certify"
        )

    per: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for i in hits:
        per[owner[i]][1 if is_comment[i] else 0] += 1

    # An sql-annotation: a code line whose every `round` sits after `--`.
    def sql_annotation(ln: str) -> bool:
        if "--" not in ln:
            return False
        head = ln.split("--", 1)[0]
        return "round" not in head

    annotations = [i for i in hits if not is_comment[i] and sql_annotation(lines[i])]

    n_code = sum(1 for i in hits if not is_comment[i])
    n_comment = sum(1 for i in hits if is_comment[i])
    if n_code + n_comment != len(hits):
        raise CensusError("code/comment split does not sum to the hit count")
    if sum(c + k for c, k in per.values()) != len(hits):
        raise CensusError("per-symbol counts do not sum to the hit count")

    return {
        "lines": lines,
        "owner": owner,
        "is_comment": is_comment,
        "hits": hits,
        "ihits": ihits,
        "per": dict(per),
        "code": n_code,
        "comment": n_comment,
        "annotations": annotations,
    }


def check_r20(c: dict) -> list[str]:
    """The requirement itself: no scheduling predicate reads `round` outside the
    labelled legacy surface. Returns a list of violations."""
    violations = []
    for i in c["hits"]:
        if c["is_comment"][i]:
            continue
        if c["owner"][i] not in SCHEDULING_SYMBOLS:
            continue
        text = c["lines"][i].strip()
        if text not in ALLOWED_SCHEDULING_LINES:
            violations.append(
                f"{SOURCE}:{i + 1} in {c['owner'][i]}(): unjustified `round` in a "
                f"scheduling symbol — {text!r}. If this is legitimate, add it to "
                f"ALLOWED_SCHEDULING_LINES with its justification; if it is a new "
                f"predicate, R20 forbids it."
            )
    return violations


def render(c: dict, digest: str) -> str:
    """The generated region. Every number in it is computed above.

    THE REGION NAMES BYTES, NOT A COMMIT — deliberately, and the first draft got
    this wrong. Embedding `git rev-parse HEAD` here makes the region disagree
    with a fresh render the instant it is committed, because HEAD has moved by
    then: the gate would have gone red on the very commit that created it and on
    every commit after, which is an unsatisfiable gate of exactly the kind this
    project's standing rules forbid writing. Observed before shipping, in the
    shadow clone (`evidence/phase2-cycle-2.md` §3, mutation 5).

    `sha256` is the right identity anyway. It names the bytes the census was
    computed from, it is invariant under committing, and "a sha naming the
    worktree rather than the build" is already on this project's record as a
    way an instrument lied. The commit and the dirty flag are still reported —
    on stdout, where they describe *this run* rather than being frozen into a
    document as though they described the measurement.
    """
    out: list[str] = []
    out.append(BEGIN)
    out.append("")
    out.append(
        f"*Generated by `scripts/checks/check-r20-census.py` from "
        f"`{SOURCE}`, sha256 `{digest[:16]}…` — the region names the BYTES it "
        f"was computed from, not a commit, so committing it does not make it "
        f"stale. Do not hand-edit: `--write` regenerates it and the check gate "
        f"fails when it disagrees with the file.*"
    )
    out.append("")
    out.append(
        f"**{len(c['hits'])} lines match `round`; {len(c['ihits'])} match "
        f"case-insensitively.** Of the {len(c['hits'])}, **{c['code']} are code "
        f"and {c['comment']} are comment prose** — and {len(c['annotations'])} of "
        f"the code lines are SQL annotations, code whose only `round` sits after "
        f"a trailing `--`. The {len(c['ihits']) - len(c['hits'])} case-insensitive "
        f"extras are identifier spellings (`listVerdictRound`, `VerdictRoundRow`, "
        f"`legacyRoundReady`) and prose `ROUND`, covered by the same attributions."
    )
    out.append("")
    out.append("| Symbol | Hits | Code | Comment | Attribution |")
    out.append("|---|---:|---:|---:|---|")
    for sym, (code, comment) in sorted(
        c["per"].items(), key=lambda kv: (-(kv[1][0] + kv[1][1]), kv[0])
    ):
        note = ATTRIBUTIONS.get(sym, "**UNATTRIBUTED** — a symbol no reviewer has justified.")
        out.append(f"| `{sym}` | {code + comment} | {code} | {comment} | {note} |")
    out.append("")
    out.append("**Every non-comment `round` line inside the three scheduling symbols**, "
               "which is the set R20 actually constrains:")
    out.append("")
    out.append("| Symbol | Line | Why it is allowed |")
    out.append("|---|---|---|")
    for i in c["hits"]:
        if c["is_comment"][i] or c["owner"][i] not in SCHEDULING_SYMBOLS:
            continue
        text = c["lines"][i].strip()
        out.append(
            # `.get`, not `[]`, and the default is not cosmetic. An unjustified
            # line is already a FAIL from check_r20() by the time render() runs,
            # and a KeyError here replaced that verdict with a traceback for two
            # commits (round 974 — see the R72 entries in
            # ALLOWED_SCHEDULING_LINES). The gate must print its finding.
            f"| `{c['owner'][i]}` | `{text}` | "
            f"{ALLOWED_SCHEDULING_LINES.get(text, '**UNJUSTIFIED — see the R20 FAIL above**')} |"
        )
    out.append("")
    out.append(END)
    return "\n".join(out)


# Per-symbol attributions. Prose, reviewed by a human, keyed by symbol so it
# survives every edit to the file (standing rule 1 — cite by symbol).
ATTRIBUTIONS = {
    "(module preamble)": (
        "**The module header.** Corrected round 204: it now states the "
        "two-branch rule, the NULL sentinel, which branch survives only for "
        "rows the old engine wrote, what `round` is still for, and that a "
        "cardinality mismatch is corruption no route may turn into a run."
    ),
    "promoteReadyTasks": (
        "**The scheduler.** Its two predicate lines are R69's legacy-row term "
        "and R12's legacy branch, both `TODO(R12-retire)`; its other code hits "
        "are R27's project-correlation lines, whose `round` is in the trailing "
        "`--`. The graph branch reads no `round` at all — see the second table."
    ),
    "claimReadyTasks": (
        "**Claim ordering, not a predicate** (§7.2). `ORDER BY pt.round ASC` "
        "sorts rows that are already `ready`."
    ),
    "sweepDanglingDependencies": (
        "**R14's sweep.** One code hit, and it is an annotation: the predicate "
        "is on `status`, the `round` is in the `-- decision 2, round 204` "
        "comment. No sweep predicate reads `round`."
    ),
    "createProject": "**Task creation** — seeds the round-0 architect task.",
    "createTask": (
        "**Task creation and identity.** `(project_id, round, role, title)` is "
        "the identity index (migration 0035) and the `ON CONFLICT` target that "
        "makes creation idempotent. Creation, not scheduling."
    ),
    "insertChainRow": (
        "**Fix-chain creation.** Same identity index; R42 gives phase 4 the job "
        "of writing `depends_on` on chain rows."
    ),
    "createFixChain": (
        "**Fix-chain placement** at `round + 1` / `round + 2`. R42 owns its "
        "move to `depends_on` in phase 4."
    ),
    "unwedgeProject": (
        "**Operator recovery.** Retries the earliest round holding a failed "
        "task — the operator's re-entry point, not the tick's. R46 moves it to "
        "the earliest failed *group* in phase 4."
    ),
    "retryTask": (
        "**Operator recovery**, comment only. Round 204 gave it the "
        "`dependencyCorruption()` refusal, which reads no `round`."
    ),
    "roundIsComplete": (
        "**Consolidation bookkeeping**, called when a task settles. R40/R43 "
        "move the group key to `(project_id, round, workstream)` in phase 4; "
        "the group decision is preserved and only its definition restated."
    ),
    "markVerdictTaskDone": (
        "**Comments only**, describing the verdict race a *round* view creates. "
        "No code line reads `round`."
    ),
    "listVerdictRound": (
        "**The consolidation group.** Reads the verdict-bearing tasks of one "
        "project+round. Not a promotion or claim predicate; phase 4 owns its "
        "redefinition."
    ),
    "listTaskReports": (
        "**Comments only** — the four hits are in the doc-comment describing why "
        "a duplicate fix chain is retired rather than the round marked done "
        "(round 972, fix cycle 1). No code line in this symbol reads `round`: it "
        "reads a project's task reports by explicit id list. Attributed round "
        "974, which is when this gate could be run again at all — the same "
        "commit that broke it also left this symbol unattributed and the "
        "generated region stale."
    ),
    "VerdictRoundRow": "**The consolidation group's row type.**",
    "ChainRowOutcome": "**Fix-chain outcome type**, comment only.",
    "unsettledVerdictTasks": "**Consolidation bookkeeping**, comment only.",
    "ProjectTask": (
        "**The column exists and must be selected.** E1 rules that `round` "
        "stays a stored, engine-computed integer for Kanban grouping (R19/R20)."
    ),
    "TASK_COLS": "**Column list.** Selecting a stored column is not reading it to schedule.",
    "TASK_COLS_PT": "**Column list**, qualified for the join. Updated together with `TASK_COLS`.",
    "listTasksForProject": (
        "**Display ordering.** `ORDER BY round ASC, created_at ASC` on a read "
        "used by the Kanban and the plan endpoint."
    ),
    "toGraphTask": (
        "**Projection into `GraphTask`**, whose `round` field R69's term and "
        "`taskDepth()`'s legacy seed both need."
    ),
    "DanglingSweepRow": "**The sweep's row type**, comment only (round-204 finding 1).",
    "DEPS_MISMATCH_SQL": (
        "**The shared corruption predicate** (R27), comment only. Reads "
        "`depends_on`, never `round`."
    ),
    "dependencyCorruption": (
        "**One row's corruption test**, comment only — the same SQL as the "
        "sweep, so retry and sweep cannot drift."
    ),
    "closeFinishedProjects": (
        "**Project closure (R70)**, comment only, and the `round` is a CITATION "
        "— \"round 224's red team\", naming the review that put R70's residual on "
        "the record. The statement itself reads `workstream` and `depends_on` "
        "and never `round`; closure has never been round-shaped."
    ),
    "describeDepsCorruption": "**English for one corrupt row.** Reads no `round`.",
    # The five below carry no `round` under the tsdoc rule; they are the symbols
    # the round-202 table named because it attributed comment blocks upward.
    # Kept so `--rule trailing` is a clean diagnostic rather than a noisy one,
    # and so a future edit that moves a comment does not fail for want of prose.
    "setTaskStatus": (
        "**Comments only**, describing the verdict race a *round* view creates. "
        "No code line reads `round`."
    ),
    "bumpFixCycle": "**Consolidation bookkeeping** — the fix-cycle counter (cap 3).",
    "listSettledRunningTasks": (
        "**Reconciliation input** — tasks whose run settled but whose row has "
        "not been reconciled. Not a promotion or claim predicate."
    ),
    "getProject": "**Single-row projection.** Selecting a stored column.",
    "getTask": "**Single-row projection.** Selecting a stored column.",
}


def git_head() -> tuple[str, bool]:
    head = subprocess.run(
        ["git", "-C", REPO, "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
    dirty = bool(
        subprocess.run(
            ["git", "-C", REPO, "status", "--porcelain", "--", SOURCE],
            capture_output=True, text=True,
        ).stdout.strip()
    )
    return head or "(unknown)", dirty


def self_check() -> int:
    """Calibration: reproduce, on a tree this rule was not tuned for, the four
    numbers a human derived by hand at that commit."""
    try:
        c = census(read_source(SELF_CHECK_COMMIT))
    except CensusError as exc:
        print(f"SELF-CHECK ERROR: {exc}", file=sys.stderr)
        return 2
    got = {
        "hits": len(c["hits"]),
        "ihits": len(c["ihits"]),
        "code": c["code"],
        "comment": c["comment"],
    }
    rc = 0
    if got != SELF_CHECK_EXPECTED:
        print(
            f"SELF-CHECK FAILED at {SELF_CHECK_COMMIT} (totals): expected "
            f"{SELF_CHECK_EXPECTED}, measured {got}. The attribution rule "
            f"changed; re-derive the calibration before trusting the census.",
            file=sys.stderr,
        )
        rc = 1

    measured = {sym: tuple(counts) for sym, counts in c["per"].items()}
    if measured != SELF_CHECK_EXPECTED_SYMBOLS:
        print(
            f"SELF-CHECK FAILED at {SELF_CHECK_COMMIT} (distribution): the "
            f"attribution rule no longer places rows where it did. The totals "
            f"cannot see this, and `--write` would launder it into the evidence "
            f"document as a fresh measurement. Differences:",
            file=sys.stderr,
        )
        for sym in sorted(set(measured) | set(SELF_CHECK_EXPECTED_SYMBOLS)):
            want = SELF_CHECK_EXPECTED_SYMBOLS.get(sym)
            have = measured.get(sym)
            if want != have:
                print(f"  - {sym}: pinned {want}, measured {have}", file=sys.stderr)
        rc = 1

    # The calibration proper: reproduce the round-202 hand table under the
    # convention its author was applying.
    try:
        t = census(read_source(SELF_CHECK_COMMIT), rule="trailing")
    except CensusError as exc:
        print(f"SELF-CHECK ERROR (trailing rule): {exc}", file=sys.stderr)
        return 2
    tper = t["per"]
    mismatches = []
    for syms, claimed in ROUND202_TABLE:
        total = sum(sum(tper.get(s, (0, 0))) for s in syms)
        if total != claimed:
            mismatches.append(f"  - {', '.join(syms)}: table says {claimed}, measured {total}")
    if mismatches:
        print(
            f"SELF-CHECK FAILED at {SELF_CHECK_COMMIT} (round-202 reproduction): "
            f"the 'trailing' rule no longer reproduces the hand-written §7 table, "
            f"so the claim that that table was a measurement is no longer "
            f"supported by this script:",
            file=sys.stderr,
        )
        print("\n".join(mismatches), file=sys.stderr)
        rc = 1

    if rc:
        return rc
    print(
        f"self-check OK — at {SELF_CHECK_COMMIT} the tsdoc rule reproduces the "
        f"round-202 totals ({got['hits']} hits, {got['ihits']} case-insensitive, "
        f"{got['code']} code / {got['comment']} comment) and its pinned "
        f"{len(SELF_CHECK_EXPECTED_SYMBOLS)}-symbol distribution is unchanged; "
        f"the trailing rule reproduces all {len(ROUND202_TABLE)} rows of the "
        f"round-202 hand table — that table was a measurement under a different "
        f"convention, not an invention"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="regenerate the region in the evidence doc")
    ap.add_argument("--at", metavar="SHA", help="census that commit's copy instead of the worktree's")
    ap.add_argument("--self-check", action="store_true", help="run the calibration check only")
    ap.add_argument(
        "--rule", choices=("tsdoc", "trailing"), default="tsdoc",
        help="comment-block attribution: to the declaration below (tsdoc, default) "
             "or above (trailing, the round-202 convention). Non-default implies "
             "census-only; the evidence region is never written from it.",
    )
    args = ap.parse_args()

    if args.self_check:
        return self_check()

    try:
        text = read_source(args.at)
        c = census(text, rule=args.rule)
    except CensusError as exc:
        print(f"CENSUS ERROR: {exc}", file=sys.stderr)
        return 2

    head, dirty = git_head()
    if args.at:
        head, dirty = args.at, False
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()

    print(f"check-r20-census: SOURCE  {SOURCE}")
    print(f"check-r20-census: HEAD    {head}{'  (WORKTREE DIRTY)' if dirty else ''}")
    print(f"check-r20-census: SHA256  {digest}")
    print(f"check-r20-census: HITS    {len(c['hits'])} ({len(c['ihits'])} case-insensitive), "
          f"{c['code']} code / {c['comment']} comment, {len(c['annotations'])} sql-annotations")
    print(f"check-r20-census: SYMBOLS {len(c['per'])} attributed")

    rc = 0

    unattributed = sorted(s for s in c["per"] if s not in ATTRIBUTIONS)
    if unattributed:
        print(
            "\nFAIL: symbols carrying `round` with no attribution — R20's gate is "
            "'a justification for every surviving occurrence', so an unattributed "
            "symbol is the gate failing, not a formatting nit:",
            file=sys.stderr,
        )
        for s in unattributed:
            print(f"  - {s} ({sum(c['per'][s])} hits)", file=sys.stderr)
        rc = 1

    violations = check_r20(c)
    if violations:
        print("\nFAIL: R20 — a scheduling predicate reads `round` outside the legacy surface:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        rc = 1
    else:
        print("check-r20-census: R20     every scheduling `round` line is justified  PASS")

    if args.at or args.rule != "tsdoc":
        why = "--at" if args.at else f"--rule {args.rule}"
        print(f"\n({why}: census only, the evidence region is not compared or written)")
        return rc

    block = render(c, digest)
    doc_path = os.path.join(REPO, DOC)
    with open(doc_path, encoding="utf-8") as fh:
        doc = fh.read()
    if BEGIN not in doc or END not in doc:
        print(f"\nFAIL: {DOC} has no generated region ({BEGIN})", file=sys.stderr)
        return 2
    before, rest = doc.split(BEGIN, 1)
    _, after = rest.split(END, 1)
    updated = before + block + after

    if args.write:
        if updated != doc:
            with open(doc_path, "w", encoding="utf-8") as fh:
                fh.write(updated)
            print(f"check-r20-census: WROTE   {DOC}")
        else:
            print(f"check-r20-census: REGION  {DOC} already current")
        return rc

    if updated != doc:
        print(
            f"\nFAIL: {DOC}'s R20 census is STALE — the file has changed since it "
            f"was generated. Run `scripts/checks/check-r20-census.py --write`.",
            file=sys.stderr,
        )
        import difflib
        for line in difflib.unified_diff(
            doc.split("\n"), updated.split("\n"),
            fromfile=f"{DOC} (committed)", tofile="(measured now)", lineterm="", n=1,
        ):
            print(line, file=sys.stderr)
        rc = 1
    else:
        print(f"check-r20-census: REGION  {DOC} matches the measurement  PASS")

    return rc


if __name__ == "__main__":
    sys.exit(main())
