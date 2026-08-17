#!/usr/bin/env python3
"""Consistency checker for the engine-task-graph planning corpus.

01-requirements.md §K and 04-phases.md §9 state the same requirement→phase
mapping from two sides, and every phase header in 04-phases.md states it a
third time. The corpus declares that a disagreement between them is a FINDING.
A declaration nobody can run is a suggestion, so this runs it.

Checks:
  1. R ids are contiguous from R1, NF ids contiguous from NF1, no duplicates.
  2. Every id defined in 01-requirements.md is mapped in its §K table, and
     every id mapped there is defined.
  3. 01 §K, 04 §9 and each 04 phase header agree, phase by phase.

Exits NON-ZERO on any disagreement, and prints what disagreed. It does not
print a smaller, prettier report — see 00-vision.md §7 rule 3.

Provenance is printed FIRST, always: this script's own git SHA and the SHA of
each file it read. A checker that does not say which bytes it checked is not
evidence — and the first version of this check reported twelve phantom "gaps"
because its regex expected `**R1.**` and the corpus writes `**R1. Title.**`.
That miss is why every id-matching regex below anchors on the period and not on
the closing asterisks.

Usage:  python3 docs/plan/engine-task-graph/check-corpus-map.py
"""

import collections
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REQ = HERE / "01-requirements.md"
PHASES = HERE / "04-phases.md"

# Anchored on the period. `**R18. The replica proof.**` and `**R14.** A dangling…`
# are both legal in this corpus and both must match.
DEFN_RE = re.compile(r"^\*\*(R\d+|NF\d+)\.", re.M)
# One id, or an inclusive range written with a hyphen or an en dash.
TOKEN_RE = re.compile(r"(R\d+|NF\d+)(?:\s*[–-]\s*(R\d+|NF\d+))?")


def sha(path: pathlib.Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(HERE), "log", "-1", "--format=%h", "--", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        return (out.stdout.strip() or "uncommitted") if out.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def expand(cell: str) -> set:
    """Every id named in one table cell, ranges expanded."""
    out = set()
    for lo, hi in TOKEN_RE.findall(cell):
        prefix = "NF" if lo.startswith("NF") else "R"
        a = int(lo[len(prefix):])
        if hi:
            if not hi.startswith(prefix):
                raise SystemExit(f"mixed-prefix range in a table cell: {lo}-{hi}")
            out |= {f"{prefix}{i}" for i in range(a, int(hi[len(prefix):]) + 1)}
        else:
            out.add(lo)
    return out


def contiguity(ids, prefix):
    nums = sorted(int(i[len(prefix):]) for i in ids if i.startswith(prefix)
                  and not (prefix == "R" and i.startswith("NF")))
    if not nums:
        return [f"no {prefix} ids defined at all"]
    return [f"{prefix} gap at {prefix}{n}" for n in range(1, max(nums) + 1) if n not in nums]


def main() -> int:
    print("check-corpus-map.py")
    print(f"  self            {sha(pathlib.Path(__file__))}")
    print(f"  01-requirements {sha(REQ)}   {REQ.stat().st_size} bytes")
    print(f"  04-phases       {sha(PHASES)}   {PHASES.stat().st_size} bytes")

    req_text, ph_text = REQ.read_text(), PHASES.read_text()
    problems = []

    # ---- 1. numbering -------------------------------------------------------
    defined = DEFN_RE.findall(req_text)
    r_ids = {d for d in defined if d.startswith("R")}
    nf_ids = {d for d in defined if d.startswith("NF")}
    problems += [f"duplicate definition of {k}"
                 for k, v in collections.Counter(defined).items() if v > 1]
    problems += contiguity(r_ids, "R") + contiguity(nf_ids, "NF")
    print(f"\n  defined: {len(r_ids)} R + {len(nf_ids)} NF")

    # ---- 2/3. the three statements of the map -------------------------------
    k_table, nine_table, headers = {}, {}, {}
    for line in req_text.splitlines():                       # 01 §K:  | 1 — Title | ids |
        m = re.match(r"\|\s*(\d)\s*—[^|]*\|\s*(.+?)\s*\|\s*$", line)
        if m:
            k_table[int(m.group(1))] = expand(m.group(2))
    for line in ph_text.splitlines():                        # 04 §9:  | 1 | ids |
        m = re.match(r"\|\s*(\d)\s*\|\s*((?:R|NF)\d.+?)\s*\|\s*$", line)
        if m:
            nine_table[int(m.group(1))] = expand(m.group(2))
    for m in re.finditer(                                    # 04 phase headers
        r"^## Phase (\d).*?\n(?:.*?\n)*?\*\*Requirements:\s*(.+?)\.?\*\*", ph_text, re.M
    ):
        headers[int(m.group(1))] = expand(m.group(2))

    for name, tbl, want in (("01 §K", k_table, 8), ("04 §9", nine_table, 8),
                            ("04 headers", headers, 8)):
        if len(tbl) != want:
            problems.append(f"{name}: parsed {len(tbl)} phases, expected {want} "
                            f"— the table's shape changed and this checker did not")

    mapped = set().union(*k_table.values()) if k_table else set()
    problems += [f"{i} defined in 01 but not mapped in §K" for i in sorted((r_ids | nf_ids) - mapped)]
    problems += [f"{i} mapped in §K but never defined in 01" for i in sorted(mapped - (r_ids | nf_ids))]

    print("\n  phase   01§K   04§9   header   verdict")
    for p in sorted(set(k_table) | set(nine_table) | set(headers)):
        a, b, c = k_table.get(p, set()), nine_table.get(p, set()), headers.get(p, set())
        bad = []
        if a != b:
            bad.append(f"01§K vs 04§9 differ on {sorted(a ^ b)}")
        if a != c:
            bad.append(f"01§K vs header differ on {sorted(a ^ c)}")
        problems += [f"phase {p}: {x}" for x in bad]
        print(f"    {p}     {len(a):>3}    {len(b):>3}    {len(c):>3}     "
              f"{'; '.join(bad) if bad else 'agree'}")

    if problems:
        print(f"\nFAIL — {len(problems)} disagreement(s):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"\nOK — R1..R{max(int(i[1:]) for i in r_ids)} and "
          f"NF1..NF{max(int(i[2:]) for i in nf_ids)} complete, "
          f"all three statements of the map agree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
