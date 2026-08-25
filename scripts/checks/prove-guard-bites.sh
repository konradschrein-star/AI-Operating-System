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
# a plain regex sweep over the raw line. (Round 8 moved the scan out of
# heredoc_marker into the shared walker input_redirections, which now feeds the
# here-string scan too; the behaviour reverted is identical, the anchor is not.)
mutate "B4 — input_redirections() ignores quoting and arithmetic" '
s = s.replace(
    "    i, n = 0, len(line)\n    quote = None\n    arith = 0\n",
    "    for _m in re.finditer(r\"<<\", line):\n"
    "        _hit = HEREDOC_OP_RE.match(line, _m.start())\n"
    "        if _hit:\n"
    "            yield \"heredoc\", _m.start(), (_hit.group(1), _hit.group(3))\n"
    "        elif line.startswith(\"<<<\", _m.start()):\n"
    "            yield \"herestring\", _m.start(), None\n"
    "    return\n"
    "    i, n = 0, len(line)\n    quote = None\n    arith = 0\n",
    1)
'

# --- M4: revert the round-5 B4 fix'"'"'s SECOND half — drop the remainder again
# when the marker line never arrives. (Round 7 moved this decision out of
# strip_heredocs into the shared walker heredoc_blocks; the behaviour reverted
# is identical, the anchor is not.)
mutate "B4 — an unterminated heredoc swallows the rest of the command again" '
s = s.replace(
    "        if found < 0:\n            continue        # unterminated: the lines stay in the command",
    "        if found < 0:\n            found = len(lines) - 1",
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
# which is the evasion the "whole statement" rule exists to refuse. (The anchor
# is the round-7 lookahead; round 6's was `[;&|\n)]` and no longer exists.)
mutate "B6 — LITERAL_ASSIGN_RE drops the whole-statement requirement" '
s = s.replace("        \\s*(?=$|[;\\n]|&&|\\|\\|)\n", "        \\s*\n", 1)
'

# --- M8: stop resolving the `$$` / $RANDOM scratch idiom. The false positive
# that blocked this round'"'"'s own control script comes straight back.
mutate "B6b — literal_value() stops substituting the pid/RANDOM tokens" '
s = s.replace(
    "    resolved = SHELL_DIGIT_TOKEN_RE.sub(\"0\", raw)",
    "    resolved = raw",
    1)
'

# --- M9: the OTHER direction on the same token — substitute EVERY expansion,
# not only the two that are guaranteed to be digits. `C=$HOME/x` would then
# resolve to `/x` and a real tree could be laundered through a variable.
mutate "B6b — literal_value() substitutes any \$NAME, not just the digit tokens" '
s = s.replace(
    "SHELL_DIGIT_TOKEN_RE = re.compile(r\"\\$\\$|\\$\\{RANDOM\\}|\\$RANDOM\\b\")",
    "SHELL_DIGIT_TOKEN_RE = re.compile(r\"\\$\\$|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?\")",
    1)
'

# --- M10: revert round 6 blocker 1 in full — every heredoc body is prose
# again, so `bash <<EOF` + a recursive delete classifies as nothing.
mutate "R7/B1 — heredoc_consumer() calls every body prose again" '
s = s.replace(
    "    words = command_words(line[:pos], \"last\")",
    "    return \"prose\", []\n    words = command_words(line[:pos], \"last\")",
    1)
'

# --- M11: revert only the DOWNSTREAM half. `psql <<EOF` still blocks, but the
# body handed to an interpreter through a pipe goes back to being invisible.
mutate "R7/B1 — heredoc_consumer() stops looking downstream of a pipe" '
s = s.replace(
    "    piped, seg, after_pipe = [], [], False",
    "    return \"prose\", []\n    piped, seg, after_pipe = [], [], False",
    1)
'

# --- M12: the OTHER direction on the same fix — treat EVERY consumer as an
# interpreter. The catch survives; the fleet'"'"'s prose notes start blocking, which
# is the failure mode that gets a guard switched off.
mutate "R7/B1 — every heredoc consumer counts as an interpreter" '
s = s.replace(
    "    head = os.path.basename(word.strip(STRIP))\n    if head in DB_CLIENT_HEADS:",
    "    head = os.path.basename(word.strip(STRIP))\n    return \"shell\"\n    if head in DB_CLIENT_HEADS:",
    1)
'

# --- M13: revert the round-7 python scanner. `python3 -c` / `python3 <<PY`
# with a literal rmtree target goes back to classifying as nothing.
mutate "R7 — python_program() stops scanning interpreter source" '
s = s.replace(
    "    for _q, target in PY_RMTREE_RE.findall(source):",
    "    return None\n    for _q, target in PY_RMTREE_RE.findall(source):",
    1)
'

# --- M14: the OTHER direction on the python scanner — block every rmtree
# instead of only non-routine literal targets. `shutil.rmtree(\"node_modules\")`
# would then trip, which is ordinary build-script work.
mutate "R7 — python rmtree stops consulting is_routine_path()" '
s = s.replace(
    "        if target and not is_routine_path(target, cwd, ctx):",
    "        if target:",
    1)
'

# --- M15: revert round 6 blocker 2 — the round-5 statement boundary, which
# accepted `(` and a bare `|` and so read a SUBSHELL assignment as if it had
# persisted into the caller.
mutate "R7/B2 — LITERAL_ASSIGN_RE accepts subshell/pipeline assignments again" '
before = s
s = s.replace(
    "r\"\"\"(?:^|(?<=;)|(?<=\\n)|(?<=&)|(?<=\\|\\|))\\s*",
    "r\"\"\"(?:^|(?<=[;&|\\n(]))\\s*",
    1)
s = s.replace(
    "        \\s*(?=$|[;\\n]|&&|\\|\\|)\n",
    "        \\s*(?=$|[;&|\\n)])\n",
    1)
assert s.count("(?<=[;&|") == 1 and "(?=$|[;&|" in s, "R7/B2 revert applied only half"
'

# --- M16: revert round 8 blocker 1 — `command_words` stops stripping
# redirections, so a redirection is a command boundary again, exactly as
# `segments()` treats it. This is ONE mutation for BOTH round-8 blockers,
# because they are one defect seen from its two sides: the catch goes
# (`bash > /tmp/out <<EOF` becomes prose) and the false positive comes back
# (`cat > /tmp/node <<'"'"'EOF'"'"'` reads its output file as the interpreter).
mutate "R8/B1+B2 — command_words() treats a redirection as a command boundary" '
s = s.replace(
    "                if op in REDIRECT_OPS:\n",
    "                if False:\n",
    1)
'

# --- M17: revert only the FALL-THROUGH half. A redirection may precede the
# command word, and `<<EOF bash` left nothing before the operator at all.
mutate "R8/B1b — heredoc_consumer() stops reading past the operator when nothing precedes it" '
s = s.replace(
    "    words = command_words(line[:pos], \"last\")\n"
    "    if not words:\n"
    "        words = command_words(line[pos:], \"first\")\n",
    "    words = command_words(line[:pos], \"last\")\n",
    1)
'

# --- M18: the OTHER direction on the same fall-through — always union the
# words after the operator into the consumer scan. The catch survives; the
# fleet'"'"'s `python3 - <<PY <args>` idiom starts reading its own ARGV as an
# interpreter, which is the false positive that gets a guard switched off.
mutate "R8/B1b — the words AFTER the operator always nominate a consumer" '
s = s.replace(
    "    words = command_words(line[:pos], \"last\")\n"
    "    if not words:\n"
    "        words = command_words(line[pos:], \"first\")\n",
    "    words = command_words(line[:pos], \"last\") + command_words(line[pos:], \"first\")\n",
    1)
'

# --- M19: revert round 8'"'"'s here-string pass. `bash <<< '"'"'rm -rf /opt/x'"'"'` goes
# back to arriving as one opaque shlex word that matches nothing, while
# `bash -c` with the identical program still blocks.
mutate "R8/B1c — classify() stops looking at here-strings" '
s = s.replace(
    "    for kind, consumer, body in herestring_programs(cmd):",
    "    for kind, consumer, body in ():",
    1)
'

# --- M20: the OTHER direction on the here-string pass — every consumer counts,
# so `grep -q x <<< "rm -rf /opt/x"` classifies its own HAYSTACK as a program.
mutate "R8/B1c — every here-string consumer counts as an interpreter" '
s = s.replace(
    "            if kind == \"prose\":\n                continue\n",
    "            if False:\n                continue\n",
    1)
'

# --- M21: revert round 9's scan_context() latency fix — drop the left boundary
# from the mktemp regex and `[A-Za-z0-9_]*` backtracks once per character at
# every start offset again. This is the only mutation whose witness is a CLOCK
# rather than a verdict, which is exactly why it is here: every other case in
# the suite would stay green while the hook stalled the agent in front of it.
mutate "R9 — scan_context() mktemp regex loses its left boundary (quadratic again)" '
s = s.replace(
    "        r\"(?:^|[\\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=[\\\"'\'']?(?:\\$\\(\\s*mktemp|`\\s*mktemp)\", cmd",
    "        r\"([A-Za-z_][A-Za-z0-9_]*)=[\\\"'\'']?(?:\\$\\(\\s*mktemp|`\\s*mktemp)\", cmd",
    1)
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
