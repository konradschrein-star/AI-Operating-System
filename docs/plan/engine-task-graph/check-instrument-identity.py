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

ROUND 811 — THE GATE COVERS BOTH HALVES OF THE INSTRUMENT, NOT ONE.

Until round 811 this file hashed `scripts/measure-schedule.ts` alone, and so did
the script's own header. But the instrument is TWO files: the script, and
`forge-control/src/lib/schedule-source.ts`, which holds every line of SQL and
the entire `pg` lifecycle — the half that actually reads the database. The SQL
could be rewritten without this gate noticing a thing.

It did not stay hypothetical for long. Round 810 patched `schedule-source.ts` in
a scratch tree to get a dry run working, and its transcript printed the
IDENTICAL `instrument-sha256` as the shipped instrument; only `git-head`
disclosed that the bytes reading the database were different ones. That is the
round-213 failure — a sha naming the tree rather than the build — one file over,
and it landed exactly where round 811's fix had to go.

So `instrument-sha256` now names a MANIFEST of both files, and this checker
computes it the same way, from the same two paths, in the same order. The
manifest is byte-for-byte what `sha256sum` prints, so the value is re-derivable
without either program:

    sha256sum scripts/measure-schedule.ts forge-control/src/lib/schedule-source.ts | sha256sum

Checks:
  1. Every `instrument-sha256: <64 hex>` line pasted anywhere in the corpus
     equals the composite of BOTH instrument files as they are on disk NOW.
     A pasted header is a claim about which bytes produced the numbers under it;
     when the bytes move, the claim becomes false and the document must either
     be re-run or explicitly amended.
  1b. Every `<64 hex>  <instrument path>` manifest line pasted in the corpus —
     the `instrument-files:` block the header prints under the composite — names
     that file's CURRENT digest. Check 1 alone would say only that "something
     moved"; this says WHICH HALF moved, which is the whole point of splitting
     the digest.
  2. No HISTORICAL instrument sha appears in the corpus except on a line that
     carries the literal marker `[historical instrument]`. The historical set is
     every composite the pair has had in git history AND every per-file digest
     either file has had, minus the current ones. Both the full 64-character
     form and the 8-character prefix form the prose uses (`80ef1123…`) are
     matched. The marker is how round 217 records the drift on purpose;
     anything else naming a dead identity is rot.

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

# BOTH HALVES, in this order. It must match `INSTRUMENT_FILES` in
# `scripts/measure-schedule.ts`; the two programs compute one value and disagree
# loudly if either list is edited alone.
INSTRUMENT_RELS = [
    "scripts/measure-schedule.ts",
    "forge-control/src/lib/schedule-source.ts",
]

# The document that carries the pasted baseline. If the sweep does not reach
# this file it has not checked the thing it exists to check.
MUST_REACH = "evidence/baseline-8ea0cc08.md"

# The live headers are the seven runs plus one refusal in
# `baseline-8ea0cc08.md`, two fixture runs in `phase8-instrument.md`, and round
# 811's frozen-identity block. (Two more are pasted MARKED as historical — a
# patched dry run against a tree that no longer exists, and a transcript of an
# older checker run — and marked headers are deliberately not counted, because
# they say nothing about the disk now.)
#
# BOTH MINIMA BELOW ARE PINNED WELL UNDER THE LIVE COUNT ON PURPOSE. They exist
# to catch a regex that matches NOTHING, not to assert an inventory. A gate
# pinned at the exact count must be edited every time a document is added, and a
# gate that must be edited to stay true is a gate that gets disclosed around —
# which is how this project earned the rule.
MIN_HEADERS = 8
MIN_FILES = 5

# Check 1b's positive control: each live header prints two manifest lines, and a
# few more are pasted in re-derivation transcripts. Eight is four header blocks'
# worth.
MIN_MANIFEST_LINES = 8

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

# A manifest line, wherever it sits in a pasted header block: the digest, two
# spaces, one of the instrument paths. The `instrument-files:` label is on the
# first line only, so the label is not part of the pattern.
MANIFEST_RE = re.compile(
    r"([0-9a-f]{64})\s\s(" + "|".join(re.escape(rel) for rel in INSTRUMENT_RELS) + r")\s*$"
)


def sha256_of(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def composite_of(digests: list[str]) -> str:
    """The manifest digest — byte-for-byte `sha256sum <a> <b> | sha256sum`."""
    manifest = "".join(f"{d}  {rel}\n" for d, rel in zip(digests, INSTRUMENT_RELS))
    return hashlib.sha256(manifest.encode()).hexdigest()


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def blob_at(commit: str, rel: str) -> bytes | None:
    """The file's bytes at `commit`, or None if it did not exist there."""
    done = subprocess.run(
        ["git", "-C", str(REPO), "show", f"{commit}:{rel}"],
        capture_output=True,
    )
    return done.stdout if done.returncode == 0 else None


def historical_shas(current_composite: str, current_files: dict[str, str]) -> dict[str, str]:
    """A retired identity -> the first commit that carried it.

    BOTH KINDS ARE RETIRED IDENTITIES. A composite the pair no longer hashes to,
    and a per-file digest either half no longer has: quoting either one names
    bytes that are not the instrument. The current values are excluded, because
    the header prints them on purpose.
    """
    commits = git("log", "--format=%H", "--", *INSTRUMENT_RELS).split()
    live = {current_composite, *current_files.values()}
    seen: dict[str, str] = {}
    for commit in commits:
        blobs = [blob_at(commit, rel) for rel in INSTRUMENT_RELS]
        digests = [hashlib.sha256(b).hexdigest() if b is not None else None for b in blobs]
        for digest in digests:
            if digest is not None and digest not in live:
                seen.setdefault(digest, commit)
        if all(d is not None for d in digests):
            composite = composite_of([d for d in digests if d is not None])
            if composite not in live:
                seen.setdefault(composite, commit)
    return seen


def main() -> int:
    for rel in INSTRUMENT_RELS:
        if not (REPO / rel).is_file():
            print(f"FAIL: the instrument half {rel} is missing — this check cannot run")
            return 1

    current_files = {rel: sha256_of(REPO / rel) for rel in INSTRUMENT_RELS}
    current = composite_of([current_files[rel] for rel in INSTRUMENT_RELS])
    historical = historical_shas(current, current_files)
    corpus = sorted(HERE.rglob("*.md"))

    # --- provenance, first, always ------------------------------------------
    print("== check-instrument-identity — provenance ==")
    print(f"this script:       {sha256_of(pathlib.Path(__file__))}")
    print(f"instrument-sha256: {current}   <- every pasted header must name THIS")
    for i, rel in enumerate(INSTRUMENT_RELS):
        label = "instrument-files: " if i == 0 else "                  "
        print(f"{label} {current_files[rel]}  {rel}")
    print(f"                   re-derive: sha256sum {' '.join(INSTRUMENT_RELS)} | sha256sum")
    if historical:
        print(f"historical shas:   {len(historical)} (must not appear unmarked)")
        for digest, commit in sorted(historical.items()):
            print(f"                   {digest}  first seen {commit[:7]}")
    else:
        print("historical shas:   none — the instrument has had one identity; check 2 is vacuous")
    print(f"corpus:            {len(corpus)} markdown file(s) under {HERE.relative_to(REPO)}/")
    print()

    failures: list[str] = []

    # --- checks 1, 1b and 2: ONE PASS, ONE EXEMPTION RULE --------------------
    # Round 811 collapsed three loops into this one. The reason is the declared
    # escape above: a marker INSIDE a pasted transcript falsifies the paste, so
    # a marked-fence exemption exists — and a header or a manifest line pasted
    # inside such a transcript needs exactly the same exemption. Separate loops
    # meant separate rules, and check 1's (which had none) was stricter than
    # check 2's by accident, so a transcript of an OLD checker run could not be
    # preserved at all without editing its bytes.
    #
    # An exempt header or manifest line does NOT count toward the positive
    # controls below: a historical one proves nothing about the instrument on
    # disk now. Both counters therefore live inside the exemption (round 813).
    headers = 0
    manifest_lines = 0
    reached: set[str] = set()
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
            exempt = MARKER in line or (in_fence and fence_exempt)

            # check 1: a pasted header names the bytes on disk. A pasted header
            # is a claim about which bytes produced the numbers under it.
            header = HEADER_RE.match(line.strip())
            if header is not None:
                if not exempt:
                    headers += 1
                    reached.add(rel)
                    if header.group(1) != current:
                        failures.append(
                            f"{rel}:{lineno}: pasted header names {header.group(1)[:8]}… "
                            f"but the instrument on disk composites to {current[:8]}… "
                            "— re-run the transcript or amend the document"
                        )
                continue  # check 1 owns this line, and owns its message

            # check 1b: a pasted manifest line names the right HALF. Check 1
            # says "something moved"; this says which file, which is the reason
            # the digest was split in two in the first place.
            #
            # The counter sits INSIDE the exemption, exactly as check 1's does
            # (round 813, round 812's finding 3). Outside it, a historical
            # manifest line — which by definition names bytes that are gone —
            # counted toward MIN_MANIFEST_LINES, so a corpus whose manifest lines
            # were all inside marked-historical fences would report ≥8 and
            # certify a run in which check 1b compared nothing. Latent when
            # found, not active: measured at 26 live lines to 1 exempt on the
            # corpus round 812 reviewed, so the control clears 8 with or without
            # this guard and the gate stays passable. Reproduced on a synthetic
            # corpus — evidence/phase8-uuid-cast.md §9.3.
            manifest = MANIFEST_RE.search(line)
            if manifest is not None:
                if not exempt:
                    manifest_lines += 1
                    if manifest.group(1) != current_files[manifest.group(2)]:
                        failures.append(
                            f"{rel}:{lineno}: pasted manifest names {manifest.group(1)[:8]}… for "
                            f"{manifest.group(2)}, but that file on disk is "
                            f"{current_files[manifest.group(2)][:8]}… — THIS half of the instrument moved"
                        )
                continue  # check 1b owns this line, and owns its message

            # check 2: no dead identity quoted without saying so.
            if exempt:
                continue
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
    if manifest_lines < MIN_MANIFEST_LINES:
        failures.append(
            f"POSITIVE CONTROL: found {manifest_lines} pasted manifest line(s), expected at "
            f"least {MIN_MANIFEST_LINES} — check 1b matched nothing, so the per-half coverage "
            "round 811 added is not actually being exercised. Either the header's "
            "'instrument-files:' block changed shape, or no re-derived header is pasted"
        )

    if failures:
        print(f"FAILED — {len(failures)} disagreement(s):")
        for failure in failures:
            print(f"  {failure}")
        return 1

    print(f"OK — {headers} pasted header(s) across {len(reached)} file(s) name {current[:8]}…")
    print(f"OK — {manifest_lines} pasted manifest line(s) name the current digest of their half")
    print(f"OK — no retired identity quoted without '{MARKER}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
