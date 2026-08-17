#!/usr/bin/env python3
"""Instrument-identity checker for the engine-task-graph planning corpus.

WHY THIS EXISTS. Round 216's re-review, finding 1. Round 215 changed
`renderCensus()` and `printFull()` in `scripts/measure-schedule.ts`, which moved
the script's self-computed `instrument-sha256`. Five places in this corpus went
on naming the OLD value — including a paragraph rewritten by that very commit,
and a `sha256sum` block that `evidence/baseline-8ea0cc08.md` §5(3) presents as an
INDEPENDENT re-derivation of it. Run that command today and it disagreed with the
document. Nothing was wrong with the measurements; the identity attached to them
had rotted, silently, in exactly the way this project has now been bitten four
times (a SHA naming the worktree rather than the build; a region stamped with
`git HEAD` so committing it made the stamp wrong; a transcript attributing
results to bytes in no commit; and this).

Every previous repair was a human promising to remember. This is the check that
does not need anyone to remember.

Checks:
  1. Every `instrument-sha256: <64 hex>` line pasted anywhere in the corpus
     equals the sha256 of `scripts/measure-schedule.ts` as it is on disk NOW.
     A pasted header is a claim about which bytes produced the numbers under it;
     when the bytes move, the claim becomes false and the document must either
     be re-run or explicitly amended.
  2. No HISTORICAL instrument sha — any sha256 the script's bytes have had in
     git history and no longer have — appears in the corpus except on a line
     that carries the literal marker `[historical instrument]`. Both the full
     64-character form and the 8-character prefix form the prose uses
     (`80ef1123…`) are matched. The marker is how round 217 records the drift on
     purpose; anything else naming a dead identity is rot.

POSITIVE CONTROLS, CHECKED BEFORE THE VERDICT. `00-vision.md` §7 rule 2: a sweep
whose probes miss must exit non-zero rather than certify itself. This script
therefore refuses unless it actually reached the corpus and actually found
headers — a glob that matches nothing, or a regex that matches nothing because
the header format changed, is a FAILURE here and not a clean run. The count is
pinned low (MIN_HEADERS) so it stays satisfiable as documents are added, and it
names one file it must reach so a corpus-wide glob failure cannot pass.

Exits NON-ZERO on any disagreement, and prints what disagreed.

Usage:  python3 docs/plan/engine-task-graph/check-instrument-identity.py
"""

import hashlib
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent
INSTRUMENT = REPO / "scripts" / "measure-schedule.ts"
INSTRUMENT_REL = "scripts/measure-schedule.ts"

# The document that carries the pasted baseline. If the sweep does not reach
# this file it has not checked the thing it exists to check.
MUST_REACH = "evidence/baseline-8ea0cc08.md"

# Eight headers are pasted today (seven runs in §1, one refusal in §3). Pinned
# at 8 rather than at the exact count so adding a run does not break the gate:
# a gate that must be edited to stay true is a gate that gets disclosed around.
MIN_HEADERS = 8
MIN_FILES = 5

# A line may name a dead identity ON PURPOSE — that is how the drift is recorded
# rather than hidden. It must say so, in these words, on that line.
#
# EXCEPT INSIDE A PASTED TRANSCRIPT, where an inline marker would falsify the
# paste: a `git show … | sha256sum` block recording WHY the identity moved has to
# print the old value, unannotated, or it is no longer a transcript. Such a block
# is exempted by putting the marker on a prose line within MARKER_LOOKBACK lines
# ABOVE its opening fence — visible to a reader, outside the bytes. Found the
# hard way: round 217's own evidence file failed this check three times, which is
# the right failure, and the fix is a declared escape rather than a weaker rule.
MARKER = "[historical instrument]"
MARKER_LOOKBACK = 3
FENCE = "```"

HEADER_RE = re.compile(r"^instrument-sha256:\s*([0-9a-f]{64})\s*$", re.M)


def sha256_of(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def historical_shas(current: str) -> dict[str, str]:
    """sha256 -> the first commit that carried it, for every version but the current."""
    commits = git("log", "--format=%H", "--", INSTRUMENT_REL).split()
    seen: dict[str, str] = {}
    for commit in commits:
        blob = subprocess.run(
            ["git", "-C", str(REPO), "show", f"{commit}:{INSTRUMENT_REL}"],
            capture_output=True,
            check=True,
        ).stdout
        digest = hashlib.sha256(blob).hexdigest()
        if digest != current:
            seen.setdefault(digest, commit)
    return seen


def main() -> int:
    if not INSTRUMENT.is_file():
        print(f"FAIL: the instrument is not at {INSTRUMENT_REL} — this check cannot run")
        return 1

    current = sha256_of(INSTRUMENT)
    historical = historical_shas(current)
    corpus = sorted(HERE.rglob("*.md"))

    # --- provenance, first, always ------------------------------------------
    print("== check-instrument-identity — provenance ==")
    print(f"this script:       {sha256_of(pathlib.Path(__file__))}")
    print(f"instrument:        {INSTRUMENT_REL}")
    print(f"instrument-sha256: {current}   <- every pasted header must name THIS")
    if historical:
        print(f"historical shas:   {len(historical)} (must not appear unmarked)")
        for digest, commit in sorted(historical.items()):
            print(f"                   {digest}  first seen {commit[:7]}")
    else:
        print("historical shas:   none — the instrument has had one identity; check 2 is vacuous")
    print(f"corpus:            {len(corpus)} markdown file(s) under {HERE.relative_to(REPO)}/")
    print()

    failures: list[str] = []

    # --- check 1: pasted headers name the bytes on disk ---------------------
    headers = 0
    reached: set[str] = set()
    for path in corpus:
        rel = path.relative_to(HERE).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in HEADER_RE.finditer(text):
            headers += 1
            reached.add(rel)
            if match.group(1) != current:
                line = text.count("\n", 0, match.start()) + 1
                failures.append(
                    f"{rel}:{line}: pasted header names {match.group(1)[:8]}… "
                    f"but {INSTRUMENT_REL} on disk is {current[:8]}… "
                    "— re-run the transcript or amend the document"
                )

    # --- check 2: no dead identity quoted without saying so -----------------
    for path in corpus:
        rel = path.relative_to(HERE).as_posix()
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        in_fence = False
        fence_exempt = False
        for lineno, line in enumerate(lines, start=1):
            if line.lstrip().startswith(FENCE):
                if in_fence:
                    in_fence, fence_exempt = False, False
                else:
                    in_fence = True
                    above = lines[max(0, lineno - 1 - MARKER_LOOKBACK) : lineno - 1]
                    fence_exempt = any(MARKER in prior for prior in above)
                continue
            if MARKER in line:
                continue
            if in_fence and fence_exempt:
                continue
            if HEADER_RE.match(line.strip()):
                continue  # check 1 owns those, and owns their message
            for digest in historical:
                if digest in line or digest[:8] in line:
                    where = "inside an UNMARKED transcript" if in_fence else "in prose"
                    failures.append(
                        f"{rel}:{lineno}: names the retired identity {digest[:8]}… "
                        f"{where} without the marker '{MARKER}' — a dead instrument "
                        "identity reads as authoritative and is wrong"
                    )
                    break

    # --- positive controls, BEFORE the verdict ------------------------------
    if len(corpus) < MIN_FILES:
        failures.append(
            f"POSITIVE CONTROL: only {len(corpus)} markdown file(s) found under "
            f"{HERE}, expected at least {MIN_FILES} — the sweep did not reach the corpus"
        )
    if headers < MIN_HEADERS:
        failures.append(
            f"POSITIVE CONTROL: found {headers} pasted instrument header(s), "
            f"expected at least {MIN_HEADERS} — either the header format changed and "
            "this regex no longer matches it, or the transcripts are gone. Either way "
            "this run checked nothing and must not report a pass"
        )
    if MUST_REACH not in reached:
        failures.append(
            f"POSITIVE CONTROL: no pasted header was read from {MUST_REACH}, "
            "which is the document this check exists for"
        )

    if failures:
        print(f"FAILED — {len(failures)} disagreement(s):")
        for failure in failures:
            print(f"  {failure}")
        return 1

    print(f"OK — {headers} pasted header(s) across {len(reached)} file(s) name {current[:8]}…")
    print(f"OK — no retired identity quoted without '{MARKER}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
