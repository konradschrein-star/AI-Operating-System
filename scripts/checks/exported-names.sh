#!/usr/bin/env bash
# exported-names.sh — print the SET of names a TypeScript module exports, one
# per line, sorted and deduplicated. Reads a path, or `-` for stdin.
#
# WHY THIS FILE EXISTS. gates-808.sh carries a gate named "project-tick.ts
# exported surface identical to main (a waiver covers content, never API)". It
# is the half that makes a content waiver safe: under a waiver the prompt
# strings inside project-tick.ts may be rewritten, the exported API may not.
# As landed on main at `b3c23ce` it was one grep:
#
#     grep -oE '^export (async function|function|const|type|interface|class) [A-Za-z0-9_]+'
#
# which CLAIMS "exported surface" and MEASURES "declaration lines". Those differ
# in BOTH directions, and both were measured on 2026-08-26:
#
#   FALSE RED  — project/0a0806d3 moved `unintegratedWorkstreams` and
#                `CloseGateTask` into the pure leaf lib/task-graph.ts and left
#                `export { unintegratedWorkstreams, type CloseGateTask };`
#                behind. 34 declaration lines against main's 36, same names,
#                identical runtime surface — and a red gate.
#   FALSE GREEN — the pattern does not match `export {` at all, so appending
#                `export { somethingNew };` leaves the grep's output
#                byte-identical. The surface GROWS and the gate stays green.
#                That is the direction the gate exists for.
#
# So the gate could not enforce the rule it names. The fix is this extractor:
# resolve BOTH forms into names, and compare sorted SETS. Removing an export
# still goes red (the original job); adding one now goes red too. The two-sided
# proof is scripts/checks/prove-surface-gate-bites.sh.
#
# WHAT IS A NAME HERE. The name a CONSUMER imports, which is why an alias
# resolves to its right-hand side:
#
#   export function f            -> f          export const c            -> c
#   export async function g      -> g          export class C            -> C
#   export interface I           -> I          export type T             -> T
#   export enum E                -> E          export namespace N        -> N
#   export declare function d    -> d          export abstract class A   -> A
#   export { a, type B }         -> a, B       export { x as y }         -> y
#   export type { T2 }           -> T2         export { z } from "./m"   -> z
#   export * as ns from "./m"    -> ns         export default …          -> default
#   export * from "./m"          -> *from:./m  (a star cannot be resolved without
#                                              reading ./m; it is reported as a
#                                              pseudo-name so that ADDING or
#                                              REMOVING one still moves the set)
#
# An `export` line in NONE of those forms is a hard error, not a skipped line:
# a surface instrument that silently ignores what it does not recognise is the
# same defect one level in from the one it was written to fix.
#
# KNOWN LIMITS, stated rather than discovered later:
#   * Only `export` at COLUMN 0 is considered — the anchor the old gate used,
#     and the style of every file this runs on. An indented re-export inside a
#     namespace block is invisible to both.
#   * A line at column 0 INSIDE a template literal is read as source. In
#     project-tick.ts, which is mostly prompt text, that would surface as a
#     spurious name or a hard error — loud and conservative, never silent.
#   * `export const a = 1, b = 2;` yields only `a`. Multi-declarator exports do
#     not occur in this repo; splitting them correctly means parsing arrow
#     functions, and a wrong split is worse than a stated limit.
#
# Exit: 0 names printed · 1 unreadable input or an `export` form not understood.

set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: exported-names.sh <file.ts|->" >&2
  exit 1
fi

SRC="$1"
if [ "$SRC" != "-" ] && [ ! -f "$SRC" ]; then
  echo "exported-names.sh: not a file: $SRC" >&2
  exit 1
fi

# One awk program, POSIX features only (no gensub, no length(array)): this runs
# under whatever awk the host has, including mawk.
awk '
function fail(msg, line) {
  printf("exported-names.sh: %s\n  at line %d: %s\n", msg, NR, line) > "/dev/stderr"
  rc = 1
  exit 1
}
function clean(tok) {                       # strip anything that cannot be in an identifier
  sub(/[^A-Za-z0-9_$].*$/, "", tok)
  return tok
}
function valid(name) {
  return name ~ /^[A-Za-z_$][A-Za-z0-9_$]*$/
}
function emit(name, line) {
  if (name == "") fail("could not read an exported name", line)
  if (name != "default" && !valid(name)) fail("not an identifier: [" name "]", line)
  names[name] = 1
}
function emit_list(buf,   inner, n, i, parts, spec, a) {
  # Specs live between the FIRST { and the FIRST } — a spec cannot contain a
  # brace, while a trailing `from "..."` or a comment after the list can.
  inner = substr(buf, index(buf, "{") + 1)
  inner = substr(inner, 1, index(inner, "}") - 1)
  n = split(inner, parts, ",")
  for (i = 1; i <= n; i++) {
    spec = parts[i]
    gsub(/^[ \t]+|[ \t]+$/, "", spec)
    if (spec == "") continue                        # `export {}` and trailing commas
    sub(/^type[ \t]+/, "", spec)                    # `type B` -> B
    if (spec ~ /[ \t]+as[ \t]+/) {                  # `x as y` -> y
      split(spec, a, /[ \t]+as[ \t]+/)
      spec = a[2]
    }
    gsub(/^[ \t]+|[ \t]+$/, "", spec)
    if (spec == "default") { names["default"] = 1; continue }
    emit(clean(spec), buf)
  }
}
function handle_decl(line,   n, parts, i, kw, name, mod) {
  n = split(line, parts, /[ \t]+/)
  if (parts[2] == "default") { names["default"] = 1; return }
  if (line ~ /^export[ \t]*\*/) {                   # star re-export
    if (line ~ /[ \t]+as[ \t]+/) {
      i = index(line, " as ")
      name = substr(line, i + 4)
      gsub(/^[ \t]+/, "", name)
      emit(clean(name), line)
      return
    }
    mod = line
    if (mod ~ /["'"'"']/) {
      sub(/^[^"'"'"']*["'"'"']/, "", mod)
      sub(/["'"'"'].*$/, "", mod)
    } else {
      fail("`export *` with no module specifier", line)
    }
    names["*from:" mod] = 1
    return
  }
  i = 2
  while (parts[i] == "declare" || parts[i] == "abstract" || parts[i] == "async") i++
  kw = parts[i]
  sub(/\*$/, "", kw)                                # `function*` generator
  if (kw != "function" && kw != "const" && kw != "let" && kw != "var" &&
      kw != "class" && kw != "interface" && kw != "type" && kw != "enum" &&
      kw != "namespace")
    fail("unrecognised export form (keyword [" kw "])", line)
  name = parts[i + 1]
  if (name == "") {                                 # `export function*name(` — no space
    name = parts[i]
    sub(/^[a-z]+\*?/, "", name)
  }
  emit(clean(name), line)
}
{
  if (pending != "") {
    pending = pending " " $0
    if (index(pending, "}") > 0) { emit_list(pending); pending = "" }
    next
  }
  if ($0 !~ /^export([ \t]|\*|\{|$)/) next
  if ($0 ~ /^export[ \t]*\{/ || $0 ~ /^export[ \t]+type[ \t]*\{/) {
    pending = $0
    if (index(pending, "}") > 0) { emit_list(pending); pending = "" }
    next
  }
  handle_decl($0)
}
END {
  if (rc) exit 1
  if (pending != "") {
    printf("exported-names.sh: unterminated `export {` block at EOF\n") > "/dev/stderr"
    exit 1
  }
  for (n in names) print n
}
' "$([ "$SRC" = "-" ] && echo /dev/stdin || echo "$SRC")" | LC_ALL=C sort -u
awk_rc=${PIPESTATUS[0]}
[ "$awk_rc" -eq 0 ] || exit 1
