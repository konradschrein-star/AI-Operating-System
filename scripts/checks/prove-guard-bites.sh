#!/usr/bin/env bash
# prove-guard-bites.sh — the mutation control for scripts/ops/test-guard-autonomy.py.
#
# WHY THIS FILE EXISTS
# --------------------
# Round 4's reviewer reverted this branch's hardening changes one at a time and
# the 140-case suite stayed 140/140 GREEN under two of the three. A suite that
# cannot tell the patched subject from the unpatched one is not evidence that
# the patch does anything — it is a suite that was written to pass
# (memory: prove-it-bites-is-the-mutation-control, assertion-inert-shared-substring).
#
# Each mutation below is a REAL behaviour revert of a named commit or a named
# round-5 fix, applied to a COPY of the hook, never to the repo file. The suite
# is then pointed at the copy via GUARD_AUTONOMY_HOOK — the harness's own,
# documented override — and must go RED. A mutation that leaves it green is
# reported as INERT and this script exits non-zero.
#
# Nothing here touches the live hook at /opt/ai-os/scripts/guard-autonomy.py,
# and Layer A of the suite is in-process, so no guardrail_trips row is written
# (memory: guard-hook-tests-never-hit-live-api).
#
# Usage:  bash scripts/checks/prove-guard-bites.sh
# Exit:   0 — every mutation DISCRIMINATED (unmutated green, each mutant red)
#         1 — at least one mutation is INERT
#         2 — INCONCLUSIVE: setup failed, or the unmutated suite is already red

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO/scripts/ops/guard-autonomy.py"
SUITE="$REPO/scripts/ops/test-guard-autonomy.py"

[ -f "$HOOK" ]  || { echo "INCONCLUSIVE: no $HOOK" >&2; exit 2; }
[ -f "$SUITE" ] || { echo "INCONCLUSIVE: no $SUITE" >&2; exit 2; }

WORK="$(mktemp -d /opt/ai-os/scratch/guard-mutation.XXXXXX)" || {
  echo "INCONCLUSIVE: no scratch dir" >&2; exit 2; }
trap 'rm -rf -- "$WORK"' EXIT
trap 'exit 130' INT TERM HUP

HOOK_MD5_BEFORE="$(md5sum "$HOOK" | cut -d' ' -f1)"

# ---------------------------------------------------------------------------
# Step 1 — the control that stops an ALREADY-RED suite being reported as proof
# of a new assertion. If the unmutated suite does not pass, every "mutant is
# red" below means nothing.
# ---------------------------------------------------------------------------
echo "########## 0. UNMUTATED — must be GREEN ##########"
base_out="$(GUARD_AUTONOMY_HOOK="$HOOK" python3 "$SUITE" 2>&1)"; base_code=$?
echo "$base_out" | tail -2
echo "EXIT=$base_code"
if [ "$base_code" != 0 ]; then
  echo "INCONCLUSIVE: the suite is red BEFORE any mutation; fix that first." >&2
  exit 2
fi
echo

# ---------------------------------------------------------------------------
# Step 2 — the mutations. Each is a python edit anchored on a code STRING, not
# a line number, applied to a fresh copy.
# ---------------------------------------------------------------------------
verdict=0
mutant_n=0

# $1 = label, $2 = python expression body operating on `s` (the hook source)
mutate() {
  local label="$1" edit="$2"
  mutant_n=$((mutant_n + 1))
  local copy="$WORK/mutant-$mutant_n.py"
  cp "$HOOK" "$copy"

  if ! MUT_EDIT="$edit" python3 - "$copy" <<'PYEOF'
import os, sys
path = sys.argv[1]
s = open(path).read()
before = s
ns = {"s": s}
exec(os.environ["MUT_EDIT"], ns)
s = ns["s"]
if s == before:
    sys.stderr.write("MUTATION DID NOT APPLY — the anchor string is gone\n")
    sys.exit(3)
open(path, "w").write(s)
PYEOF
  then
    echo "INCONCLUSIVE: mutation '$label' did not apply" >&2
    verdict=2
    return
  fi

  echo "########## $mutant_n. MUTATION: $label — the suite must go RED ##########"
  local out code
  out="$(GUARD_AUTONOMY_HOOK="$copy" python3 "$SUITE" 2>&1)"; code=$?
  echo "$out" | grep -E '^  RED ' | sed 's/^/   /' | head -12
  echo "$out" | tail -2
  echo "EXIT=$code"
  if [ "$code" = 0 ]; then
    echo "   INERT — this revert changes real behaviour and no case noticed." >&2
    [ "$verdict" = 2 ] || verdict=1
  else
    echo "   DISCRIMINATED — $(echo "$out" | grep -cE '^  RED ') case(s) went red."
  fi
  echo
}

# --- M1: revert e6901a8 in full. `rm -r <dir>` and `rm -rf <dir>` delete the
# same tree; the old condition pattern-matched the idiom instead. This is the
# revert the round-4 review found the suite green under.
mutate "e6901a8 — 'if recursive:' back to 'if recursive and force:'" '
s = s.replace(
    "        if recursive:\n",
    "        force = \"f\" in flags or \"--force\" in longs\n        if recursive and force:\n",
    1)
'

# --- M2: drop the newline from shlex punctuation_chars. Without it a newline is
# whitespace, two lines become ONE segment headed by the first command, and
# every rule after the head is dead. The other revert the suite was green under.
mutate "tokenize() — punctuation_chars loses the newline" '
s = s.replace("punctuation_chars=\"();<>|&\\n\"", "punctuation_chars=\"();<>|&\"", 1)
'

# --- M3: revert the round-5 B4 fix by ignoring quote/arith state, i.e. put back
# the plain re.search over the raw line.
mutate "B4 — heredoc_marker() ignores quoting and arithmetic" '
s = s.replace(
    "    i, n = 0, len(line)\n    quote = None\n    arith = 0\n",
    "    m = HEREDOC_OP_RE.search(line)\n"
    "    return (m.group(1), m.group(3)) if m else None\n"
    "    i, n = 0, len(line)\n    quote = None\n    arith = 0\n",
    1)
'

# --- M4: revert the round-5 B4 fix's SECOND half — drop the remainder again
# when the marker line never arrives.
mutate "B4 — an unterminated heredoc swallows the rest of the command again" '
s = s.replace(
    "        if found >= 0:\n            i = found + 1",
    "        i = found + 1 if found >= 0 else len(lines)",
    1)
'

# --- M5: revert the round-5 B5 fix. One transposed letter defeats the headline
# wrapper CATCH.
mutate "B5 — SHELL_C_RE anchors 'c' to the end of the cluster again" '
s = s.replace("r\"^-[a-zA-Z]*c[a-zA-Z]*$\"", "r\"^-[a-zA-Z]*c$\"", 1)
'

# --- M6: revert the round-5 B6 fix. The false positive comes back: a literal
# /tmp path assigned in the same command is blocked as unresolvable.
mutate "B6 — is_routine_path() stops resolving literal assignments" '
import re as _re
s = s.replace(
    "        if p in (\"$\" + var, \"${\" + var + \"}\"):",
    "        if False:",
    1)
'

# --- M7: the OTHER direction on B6 — make it resolve the env-PREFIX form too,
# which is the evasion the "whole statement" rule exists to refuse.
mutate "B6 — LITERAL_ASSIGN_RE drops the whole-statement requirement" '
s = s.replace("        \\s*(?=$|[;&|\\n)])\n", "        \\s*\n", 1)
'

# ---------------------------------------------------------------------------
# Step 3 — the repo file must be untouched. A control that edits its own
# subject in place is how a mutation transcript quietly becomes a regression.
# ---------------------------------------------------------------------------
HOOK_MD5_AFTER="$(md5sum "$HOOK" | cut -d' ' -f1)"
echo "-- subject md5 before: $HOOK_MD5_BEFORE"
echo "-- subject md5 after:  $HOOK_MD5_AFTER"
if [ "$HOOK_MD5_BEFORE" != "$HOOK_MD5_AFTER" ]; then
  echo "INCONCLUSIVE: the hook itself changed during the run" >&2
  exit 2
fi

echo
case "$verdict" in
  0) echo "BITES — all $mutant_n mutations DISCRIMINATED; unmutated suite green; subject unchanged." ;;
  1) echo "INERT — at least one real behaviour revert left the suite green." ;;
  *) echo "INCONCLUSIVE — a mutation failed to apply." ;;
esac
exit "$verdict"
