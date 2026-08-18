#!/usr/bin/env bash
#
# forbidden-file-diff.sh — the decision half of `gates-808.sh` gate 6,
# extracted so it can be DRIVEN WITH FIXTURES instead of only with whatever
# `main...HEAD` happens to hold.
#
# ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
# Gate 6 used to be one line of shell inside `gates-808.sh`:
#
#     git diff --name-only main...HEAD | grep -E '<ban>' && exit 1 || exit 0
#
# and it was UNSATISFIABLE BY CONSTRUCTION for project `engine-task-graph`,
# whose entire mandate is to change `project-tick.ts` and `db/projects.ts`.
# Rounds 819, 820, 821 and 822 each labelled it "structural, pre-existing" and
# walked past it; round 823's reviewer refused to, and blocked — correctly:
# under the reviewer brief's rule *a nonzero exit BLOCKS the PASS*, that branch
# could never reach a PASS at any sha, including its deploy task.
#
# ── THE SHAPE, AND WHOSE RULING IT IS ──────────────────────────────────────
# Operator ruling, 2026-08-18, recorded in the vault at
# `AI OS/Operator Decisions.md` § "A gate that forbids touching a file cannot
# govern a project whose mandate is that file":
#
#   "Bind such a ban to the DECLARED WRITE-SET, never to a project name. An
#    allow list supplied by the caller (GATES_ENGINE_ALLOW=...), defaulting to
#    empty so every other project is unaffected: an engine file may differ only
#    if it was declared. A name-based waiver rots the moment the project ends
#    and nothing removes it; a write-set-bound gate is self-retiring, and the
#    reviewer's job becomes checking the allow list matches the declared
#    write-sets — a real check rather than a rubber stamp."
#
# So there is NO project name anywhere below, and no default allow list. With
# `GATES_ENGINE_ALLOW` unset the verdict is byte-for-byte today's verdict for
# every other branch in this repo — which is a property the control asserts
# (`check-forbidden-file-diff.sh` case 2) rather than a claim made here.
#
# ── INTERFACE ──────────────────────────────────────────────────────────────
#   <a list of repo-relative paths, one per line> | forbidden-file-diff.sh
#
#   GATES_ENGINE_ALLOW  comma- and/or newline-separated repo-relative paths.
#                       Matched EXACTLY — never as a prefix, never as a glob —
#                       because a declared write-set names exact paths, and a
#                       prefix match would let `db/projects.ts` also permit
#                       `db/projects.test.ts` (control case 11).
#
#   exit 0  no banned path differs, or every one that does was declared
#   exit 1  a banned path differs and was not declared — each is named
#
# ── WHAT WOULD MAKE THIS INSTRUMENT REPORT A PASS WRONGLY ──────────────────
# (a) AN ALLOW ENTRY THAT PERMITS NOTHING, READ AS PROTECTION. An entry the
#     ban regex never matches grants no exemption at all; listing it looks like
#     a decision and is a no-op. Such entries are printed as INERT, by name.
#     They are not fatal — a caller may reasonably list every mandate file,
#     only some of which the ban covers — but they are never silent.
# (b) AN EMPTY SWEEP CERTIFYING ITSELF. If the producing command fails, this
#     script reads zero paths and would otherwise print a clean verdict. It
#     cannot fail on zero input without changing today's verdict for a branch
#     that legitimately differs from `main` in no file, and the ruling requires
#     other projects to be unaffected — so the count is printed on its own line
#     instead, and THE CALL SITE carries the real guard: `gates-808.sh`'s
#     `gate_sh` runs its body under `set -o pipefail`, so a failing `git diff`
#     is a nonzero gate regardless of what this script says. Control case 12
#     executes that composed pipeline rather than trusting the sentence.
# (c) A STALE SUBJECT. The control prints this file's sha256 beside the sha it
#     ran at, so a transcript names the exact text a verdict came off.

set -uo pipefail

# The ban. `VaultFileList` and `routes/files` are the Files-pane pair round
# 808's operator waiver kept forbidden; `cc-runner` and the three engine
# fragments are the rest of that round's list. The PATTERN is unchanged from
# the one-liner this replaced — widening it wholesale is exactly what round
# 823's finding forbade. What changed is that a match is now checked against
# the caller's declared write-set before it is called a violation.
BAN_RE='project-tick|cc-runner|executor\.ts|db/projects|VaultFileList|routes/files'

allow=()
if [ -n "${GATES_ENGINE_ALLOW:-}" ]; then
  while IFS= read -r entry || [ -n "$entry" ]; do
    entry="${entry#"${entry%%[![:space:]]*}"}"   # strip leading blanks
    entry="${entry%"${entry##*[![:space:]]}"}"   # strip trailing blanks
    [ -n "$entry" ] && allow+=("$entry")
  done < <(printf '%s\n' "${GATES_ENGINE_ALLOW}" | tr ',' '\n')
fi

# `|| [ -n "$line" ]` is NOT decoration. `read` returns non-zero on a final line
# that has no trailing newline, and the loop body would never run for it — so a
# producer whose last path lacks a newline would have that path SILENTLY DROPPED
# and the gate would report clean on a forbidden file. `git diff --name-only`
# does terminate its last line, which is exactly why this would have gone
# unnoticed; it was found by `check-forbidden-file-diff.sh` failing eight cases
# on its first run, and case 14 now pins it.
changed=()
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] && changed+=("$line")
done

is_allowed() {
  local candidate="$1" a
  for a in ${allow[@]+"${allow[@]}"}; do
    [ "$a" = "$candidate" ] && return 0
  done
  return 1
}

matches_ban() {
  printf '%s\n' "$1" | grep -qE "$BAN_RE"
}

banned=()
for f in ${changed[@]+"${changed[@]}"}; do
  matches_ban "$f" && banned+=("$f")
done

forbidden=()
declared=()
for f in ${banned[@]+"${banned[@]}"}; do
  if is_allowed "$f"; then declared+=("$f"); else forbidden+=("$f"); fi
done

echo "paths read on stdin: ${#changed[@]}"
echo "ban pattern:         $BAN_RE"
echo

echo "ALLOW LIST — GATES_ENGINE_ALLOW, supplied by the caller, default empty (${#allow[@]} entries)"
if [ "${#allow[@]}" -eq 0 ]; then
  echo "  (none — every path matching the ban is forbidden, which is this gate's"
  echo "   behaviour for every branch that does not set the variable)"
else
  for a in "${allow[@]}"; do
    if ! matches_ban "$a"; then
      echo "  INERT   $a  (the ban never matches this path; this entry permits nothing)"
    elif printf '%s\n' ${banned[@]+"${banned[@]}"} | grep -qxF "$a"; then
      echo "  IN USE  $a"
    else
      echo "  UNUSED  $a  (declared, but does not differ from main on this branch)"
    fi
  done
fi
echo

echo "PATHS MATCHING THE BAN (${#banned[@]})"
for f in ${banned[@]+"${banned[@]}"}; do
  if is_allowed "$f"; then echo "  declared   $f"; else echo "  FORBIDDEN  $f"; fi
done
[ "${#banned[@]}" -eq 0 ] && echo "  (none)"
echo

if [ "${#forbidden[@]}" -gt 0 ]; then
  echo ">>> FORBIDDEN FILE DIFFERS — ${#forbidden[@]} path(s) match the ban and are not in"
  echo ">>> GATES_ENGINE_ALLOW. Either the change does not belong on this branch, or the"
  echo ">>> path belongs in a task's declared write_set and in the allow list the reviewer"
  echo ">>> checks against it (03-quality.md §3.1 item 12)."
  for f in "${forbidden[@]}"; do echo ">>>   $f"; done
  exit 1
fi

if [ "${#declared[@]}" -gt 0 ]; then
  echo "clean — ${#declared[@]} banned path(s) differ and every one was declared"
else
  echo "clean — no engine/Files file differs"
fi
exit 0
