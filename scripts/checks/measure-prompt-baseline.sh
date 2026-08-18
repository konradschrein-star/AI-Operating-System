#!/usr/bin/env bash
#
# measure-prompt-baseline.sh — re-derive NF7's planner-prompt measurements at an
# arbitrary git ref, with the two controls that made the ad-hoc version of this
# harness trustworthy when rounds 242 and 243 ran it by hand.
#
# RULED AT ROUND 244, DELIVERED AT ROUND 950. The ruling was that the three-tree
# harness be committed so that re-deriving NF7's numbers becomes a command
# rather than a prose paragraph. It reached the builder as a queued message,
# nobody verified delivery, and it was then recorded as done and cited in a later
# brief. Round 900 went looking for this file, found it had never existed in repo
# history, and fell back to NF7's own test harness. That is the failure this file
# closes, and it is worth stating in the file itself: a ruling is delivered when
# an artefact exists, not when a message is sent.
#
# ---------------------------------------------------------------------------
# WHAT IT MEASURES
#
# `buildPrompt()` for a PLANNER on the MAXIMAL path — a repo-backed project
# (WORKTREE_POLICY + GITHUB_PUSH_GUIDE), `mode: goal`, and a manager-chat
# linkage (MANAGER_COMMS); ESCALATION_POLICY is unconditional — and prints
# `.length`. That is the only measurement NF7's budget is meaningful against,
# and it is the same quantity `maximalPlannerPrompt()` builds in
# `project-tick.test.ts`'s NF7 block.
#
# ---------------------------------------------------------------------------
# THE TWO CONTROLS. NEITHER IS DECORATION — EACH EXCLUDES A WAY THIS HARNESS
# HAS ALREADY BEEN SEEN TO LIE, OR COULD BE.
#
#   (1) BUILD IDENTITY. Every tree prints `sha256(project-tick.ts)` of the file
#       it actually measured. Round 244 recorded the honest limit of this pin in
#       the same breath as the pin: the digest moves whenever a COMMENT moves,
#       so it names the module a number came off and is not a claim that the
#       number cannot have changed. Re-derive rather than trust it.
#
#   (2) THE SHADOW-TREE TRAP, which is the control that matters. A pre-change
#       tree that is secretly HEAD reports HEAD's number and calls it a
#       baseline. `tsconfig.json` path mapping, a stray symlink, or a resolver
#       walking up to the real `src/` all produce it, and every one of them is
#       silent. So this harness REFUSES TO REPORT A NUMBER unless the module's
#       `GRAPH_GUIDE` export matches what the exported SOURCE TEXT says it must
#       have:
#         * static:  does the exported project-tick.ts contain the export?
#         * runtime: does the module object actually carry the binding?
#       The two are derived by different mechanisms — one reads bytes off disk,
#       the other asks the loader what it resolved — so they agree only when the
#       loader really loaded the file that was exported. `GRAPH_GUIDE` is the
#       right needle because it is the one export whose presence SPLITS the
#       three trees on record: absent at d9858b9 (pre-5A), present after it.
#       On top of that the driver `realpath`s the module it loaded and refuses
#       if it resolves outside the export directory.
#
#       This is a strict generalisation of what rounds 242/243 did by hand.
#       They compared GRAPH_GUIDE against a table of known shas, which works
#       only for the three refs in the table; deriving the expectation from the
#       exported bytes works at any ref, and STILL cross-checks the table below
#       whenever the ref is in it.
#
#   (3) A THIRD, INHERITED FROM `maximalPlannerPrompt()`: the driver asserts the
#       four policy blocks are present and that the project id is 36 characters
#       before it reports anything. A scratch project measures ~3k under any
#       budget, and a 2-character id understates every number by 34 — that flat
#       +34, hidden by a `"p1"` fixture, is what cost rounds 240-242. The id is
#       a parameter here (`--project-id`) and it DEFAULTS TO A REAL 36-CHARACTER
#       UUID for exactly that reason.
#
# ---------------------------------------------------------------------------
# HOW THE TREES ARE BUILT: `git archive <ref> | tar -x`, then `node_modules`
# SYMLINKED and NO SOURCE SYMLINKED. node_modules is a symlink because it is
# multi-gigabyte, ref-independent, and not the thing under measurement. Source
# is never symlinked because a symlinked source file is precisely the shadow
# tree control (2) exists to catch.
#
# Usage:
#   scripts/checks/measure-prompt-baseline.sh                  # the 3 refs on record + HEAD
#   scripts/checks/measure-prompt-baseline.sh --ref HEAD
#   scripts/checks/measure-prompt-baseline.sh --project-id p1  # the old 2-char frame
#   scripts/checks/measure-prompt-baseline.sh --keep           # leave the export dirs
#
# Exit: 0 = every requested tree measured AND every ledger expectation matched.
#       1 = a control failed, or a measurement disagreed with the ledger. In
#           NEITHER case is a number to be trusted from a non-zero run.
#
set -euo pipefail

trap 'rc=$?; [ $rc -ne 0 ] && echo "measure-prompt-baseline.sh: ABORTED at line $LINENO (exit $rc) — NOT a measurement" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# The default id is a REAL uuid — this project's own — and not the `project()`
# factory's "p1". `taskCurl()` renders the id verbatim exactly once, so a 2-char
# fixture reports every number 34 characters short (36 - 2). Round 242 found that
# flat +34 after it had already been baked into a pin.
PROJECT_ID='8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4'
CHAT_ID='bfd1283a-b71b-4f35-b577-7d09aad803f2'
REFS=()
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --ref)        REFS+=("${2:?--ref needs a value}"); shift 2 ;;
    --keep)       KEEP=1; shift ;;
    -h|--help)    sed -n '2,90p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "measure-prompt-baseline.sh: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# THE LEDGER — the values already on record, so this harness can be checked
# against something rather than only ever producing new numbers.
#
# Transcribed from the ROUND 242 table in `project-tick.test.ts`'s NF7 block
# (the `describe` carrying `const BASELINE`). Read that block, not this comment,
# for what the numbers mean; this is a copy kept honest by being executed.
#
#   ref | sha256(project-tick.ts) first 16 | exports GRAPH_GUIDE | len@uuid | len@"p1"
# ---------------------------------------------------------------------------
LEDGER=(
  'd9858b9|b10ddc0190bd280e|no|9221|9187'
  '05f2842|00bcdeae5cfbd555|yes|11619|11585'
  'fe14a7e|c4141f17fde418ef|yes|12095|12061'
)

if [ ${#REFS[@]} -eq 0 ]; then
  REFS=(d9858b9 05f2842 fe14a7e HEAD)
fi

FAILURES=0
CHECKS=0
note_fail() { printf '  FAIL  %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
note_ok()   { printf '  ok    %s\n' "$1"; CHECKS=$((CHECKS + 1)); }

WORK="$(mktemp -d -t measure-prompt-XXXXXX)"
if [ "$KEEP" -eq 0 ]; then
  trap 'rm -rf "$WORK"' EXIT
fi

NODE_MODULES="$REPO_ROOT/forge-control/node_modules"
TSX="$NODE_MODULES/.bin/tsx"
[ -x "$TSX" ] || { echo "measure-prompt-baseline.sh: $TSX is not executable — run pnpm install in forge-control/" >&2; exit 1; }

echo '=== measure-prompt-baseline.sh — build identity ==============================='
echo "  repo worktree      : $REPO_ROOT"
echo "  git HEAD           : $(git rev-parse --short HEAD)"
echo "  worktree dirty     : $(git status --porcelain | wc -l | tr -d ' ') file(s)"
echo "  self (sha256)      : $(sha256sum "${BASH_SOURCE[0]}" | cut -c1-16)…"
echo "  project id         : $PROJECT_ID (${#PROJECT_ID} chars)"
echo "  manager chat id    : $CHAT_ID"
echo "  tsx                : $("$TSX" --version | tr '\n' ' ')"
echo "  export root        : $WORK"
echo "  refs               : ${REFS[*]}"
echo '==============================================================================='
echo

# ---------------------------------------------------------------------------
# THE DRIVER. Written into each exported tree beside project-tick.ts so that
# `./project-tick.ts` resolves to the EXPORTED module and to nothing else. It is
# written, never symlinked, and it is the only file this harness adds to a tree.
#
# It reproduces `maximalPlannerPrompt()` from project-tick.test.ts: a repo-backed
# goal project with a manager-chat linkage, and a planner task. The row literals
# carry the task-graph columns (`depends_on`, `workstream`, `write_set`,
# `graph_frozen`); on a pre-graph tree those fields are simply unread extra
# properties at runtime, which is what makes ONE driver valid across all three
# trees. tsx strips types without checking them, so no `Project`/`ProjectTask`
# type import is taken — a shared driver that had to typecheck against three
# different shapes of `ProjectTask` could not exist.
# ---------------------------------------------------------------------------
DRIVER_NAME='__measure_prompt_baseline_driver.ts'
write_driver() {   # $1 = dir to write into
  cat > "$1/$DRIVER_NAME" <<'DRIVER'
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as tick from "./project-tick.ts";

const fail = (why: string): never => {
  console.log(JSON.stringify({ ok: false, why }));
  process.exit(3);
};

const PROJECT_ID = process.env.MPB_PROJECT_ID ?? fail("MPB_PROJECT_ID is unset");
const CHAT_ID = process.env.MPB_CHAT_ID ?? fail("MPB_CHAT_ID is unset");
const EXPORT_ROOT = process.env.MPB_EXPORT_ROOT ?? fail("MPB_EXPORT_ROOT is unset");

// CONTROL 2a — the module this driver actually loaded must live INSIDE the
// exported tree. A symlinked source file, or a resolver that walked up into the
// real src/, lands outside it and is refused here rather than measured.
const modulePath = realpathSync(fileURLToPath(new URL("./project-tick.ts", import.meta.url)));
if (!modulePath.startsWith(realpathSync(EXPORT_ROOT) + "/")) {
  fail(`project-tick.ts resolved to ${modulePath}, which is OUTSIDE the export ${EXPORT_ROOT} — ` +
    "this is the shadow tree, and the number it would produce is not this ref's");
}

const src = readFileSync(modulePath, "utf8");

// CONTROL 2b — THE SHADOW-TREE TRAP. Static text and runtime binding are read by
// different mechanisms; they agree only if the loader loaded the exported bytes.
const staticHasGuide = /^export const GRAPH_GUIDE\b/m.test(src);
const runtimeHasGuide = Object.prototype.hasOwnProperty.call(tick, "GRAPH_GUIDE");
if (staticHasGuide !== runtimeHasGuide) {
  fail(
    `GRAPH_GUIDE control FAILED: the exported source ${staticHasGuide ? "DOES" : "does NOT"} ` +
      `declare it but the loaded module ${runtimeHasGuide ? "DOES" : "does NOT"} carry it. ` +
      "The loader did not load the file that was exported — refusing to report a number",
  );
}

// A positive control on the read itself: an empty or wrong read would make the
// static probe above answer "no" vacuously and agree with a genuinely pre-5A
// runtime, so the disagreement check alone is not sufficient.
if (!src.includes("WORKTREE-ONLY POLICY")) {
  fail("POSITIVE CONTROL FAILED: project-tick.ts was read but lacks a string known to be live " +
    "in it at every ref measured — the read is empty or points at the wrong file");
}

if (typeof tick.buildPrompt !== "function") fail("the module exports no buildPrompt()");

const project = {
  id: PROJECT_ID,
  name: "Test Project",
  brief: "Do the thing.",
  repo: "ai-os",
  workspace_dir: null,
  base_branch: "main",
  work_branch: "project/x",
  status: "active",
  // Built, never spelled: `forge-control/src` is grepped for this key by
  // boundary 08 §4.3, which must match only lib/cc-runner.ts and db/projects.ts.
  metadata: { mode: "goal", ["origin_" + "chat_id"]: CHAT_ID },
  created_at: "",
  updated_at: "",
};

const task = {
  id: "t1",
  project_id: PROJECT_ID,
  round: 500,
  role: "planner",
  title: "Do it",
  brief: "Implement the thing.",
  status: "ready",
  run_id: null,
  fix_cycle: 0,
  tier: null,
  attempt: 0,
  chain_key: null,
  depends_on: null,
  workstream: "main",
  write_set: [],
  graph_frozen: false,
  created_at: "",
  updated_at: "",
};

const prompt = tick.buildPrompt(task, project);

// CONTROL 3 — MAXIMALITY. Reported, not asserted away: the shell decides, so a
// tree that legitimately predates one of these blocks is visible as such instead
// of being silently measured on a short path.
const NEEDLES: Array<[string, string]> = [
  ["WORKTREE_POLICY", "WORKTREE-ONLY POLICY"],
  ["ESCALATION_POLICY", "AUTONOMY AND ESCALATION"],
  ["MANAGER_COMMS", "MANAGER COMMS"],
  ["GITHUB_PUSH_GUIDE", "GITHUB PUSH"],
];
const present = NEEDLES.filter(([, n]) => prompt.includes(n)).map(([k]) => k);
const absent = NEEDLES.filter(([, n]) => !prompt.includes(n)).map(([k]) => k);

console.log(JSON.stringify({
  ok: true,
  length: prompt.length,
  idLength: PROJECT_ID.length,
  idOccurrences: prompt.split(PROJECT_ID).length - 1,
  staticHasGuide,
  runtimeHasGuide,
  modulePath,
  present,
  absent,
}));
DRIVER
}

# ---------------------------------------------------------------------------
# One tree.
# ---------------------------------------------------------------------------
measure_ref() {   # $1 = ref
  local ref="$1"
  local resolved short dir fc sha ledger_line exp_sha exp_guide exp_len json
  resolved="$(git rev-parse --verify "$ref^{commit}")" || {
    note_fail "$ref: not a commit in this repository"
    return 0
  }
  short="$(git rev-parse --short "$resolved")"
  dir="$WORK/$ref"
  fc="$dir/forge-control"

  mkdir -p "$dir"
  # NO SOURCE SYMLINKED: git archive writes real bytes for every tracked file.
  git archive "$resolved" | tar -x -C "$dir"
  [ -f "$fc/src/lib/project-tick.ts" ] || { note_fail "$ref: forge-control/src/lib/project-tick.ts absent at this ref"; return 0; }
  # node_modules SYMLINKED — ref-independent, multi-gigabyte, and not under
  # measurement. This is the ONLY symlink in the tree.
  ln -sfn "$NODE_MODULES" "$fc/node_modules"

  # ---- FAULT INJECTION, for watching the controls go RED -------------------
  # A control that has never been seen to fail is a claim, not a control. These
  # two are OFF unless the env var names this ref, they announce themselves in
  # the output, and each reproduces one real way a baseline harness lies.
  #   MPB_INJECT_SHADOW=<ref>  replace the exported source with a SYMLINK to the
  #                            live tree — the classic shadow tree. Expect the
  #                            driver to refuse on the export-root check.
  #   MPB_INJECT_SWAP=<ref>    copy the LIVE source over the exported one, bytes
  #                            and all. Static and runtime then agree honestly,
  #                            so the shadow-tree check CANNOT catch it — the
  #                            sha256 ledger pin is what catches it, which is
  #                            why both exist.
  if [ "${MPB_INJECT_SHADOW:-}" = "$ref" ]; then
    echo "    !! FAULT INJECTED (MPB_INJECT_SHADOW): source replaced by a symlink to the live tree"
    ln -sfn "$REPO_ROOT/forge-control/src/lib/project-tick.ts" "$fc/src/lib/project-tick.ts"
  fi
  if [ "${MPB_INJECT_SWAP:-}" = "$ref" ]; then
    echo "    !! FAULT INJECTED (MPB_INJECT_SWAP): live source copied over the exported source"
    cp "$REPO_ROOT/forge-control/src/lib/project-tick.ts" "$fc/src/lib/project-tick.ts"
  fi
  # --------------------------------------------------------------------------

  sha="$(sha256sum "$fc/src/lib/project-tick.ts" | cut -c1-16)"

  ledger_line=""
  for row in "${LEDGER[@]}"; do
    case "$row" in "$ref|"*) ledger_line="$row" ;; esac
  done

  printf -- '--- %s (%s) %s\n' "$ref" "$short" "$(printf '%.0s-' $(seq 1 $((60 - ${#ref} - ${#short}))))"
  echo "    sha256(project-tick.ts) : $sha"

  write_driver "$fc/src/lib"
  set +e
  json="$(cd "$fc" && MPB_PROJECT_ID="$PROJECT_ID" MPB_CHAT_ID="$CHAT_ID" MPB_EXPORT_ROOT="$dir" \
      "$TSX" "src/lib/$DRIVER_NAME" 2>"$WORK/$ref.stderr")"
  local rc=$?
  set -e
  rm -f "$fc/src/lib/$DRIVER_NAME"

  if [ $rc -ne 0 ] && [ -z "$json" ]; then
    note_fail "$ref: the driver could not run (exit $rc). stderr:"
    sed 's/^/        /' "$WORK/$ref.stderr" >&2
    return 0
  fi

  local ok why length idocc present absent staticg runtimeg
  ok="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')"
  if [ "$ok" != "True" ]; then
    why="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("why",""))')"
    note_fail "$ref: REFUSED — $why"
    return 0
  fi
  eval "$(printf '%s' "$json" | python3 -c '
import json,sys,shlex
d = json.load(sys.stdin)
for k, v in [("length", d["length"]), ("idocc", d["idOccurrences"]),
             ("staticg", d["staticHasGuide"]), ("runtimeg", d["runtimeHasGuide"]),
             ("present", ",".join(d["present"])), ("absent", ",".join(d["absent"]) or "-")]:
    print(f"{k}={shlex.quote(str(v))}")
')"

  local guide='no'; [ "$runtimeg" = "True" ] && guide='yes'
  echo "    exports GRAPH_GUIDE     : $guide (static and runtime agree — shadow-tree control passed)"
  echo "    policy blocks present   : $present"
  echo "    policy blocks ABSENT    : $absent"
  echo "    id occurrences in prompt: $idocc"
  echo "    MEASURED length         : $length"
  note_ok "$ref: shadow-tree control (static == runtime GRAPH_GUIDE)"

  if [ "$absent" != "-" ]; then
    note_fail "$ref: NOT THE MAXIMAL PATH — $absent absent from the prompt. A measurement on a short path understates every real planner prompt and must not be pinned."
  else
    note_ok "$ref: maximal path (all four policy blocks present)"
  fi

  if [ -n "$ledger_line" ]; then
    IFS='|' read -r _ exp_sha exp_guide exp_len _ <<<"$ledger_line"
    [ "$sha" = "$exp_sha" ] \
      && note_ok "$ref: sha256 matches the round-242 ledger ($exp_sha)" \
      || note_fail "$ref: sha256 is $sha, ledger says $exp_sha — this is NOT the tree the ledger measured"
    [ "$guide" = "$exp_guide" ] \
      && note_ok "$ref: GRAPH_GUIDE presence matches the ledger ($exp_guide)" \
      || note_fail "$ref: GRAPH_GUIDE is '$guide', ledger says '$exp_guide'"
    if [ "${#PROJECT_ID}" -eq 36 ]; then
      [ "$length" = "$exp_len" ] \
        && note_ok "$ref: length $length REPRODUCES the ledger's uuid-frame value" \
        || note_fail "$ref: length $length, ledger says $exp_len (delta $((length - exp_len)))"
    else
      echo "    (ledger length check skipped: --project-id is ${#PROJECT_ID} chars, the ledger's"
      echo "     pinned column is the 36-char uuid frame)"
    fi
  else
    echo "    (no ledger row for this ref — reported, not verified)"
  fi
  echo
}

for ref in "${REFS[@]}"; do
  measure_ref "$ref"
done

echo '--- census --------------------------------------------------------------------'
echo "  controls passed : $CHECKS"
echo "  failures        : $FAILURES"
if [ "$CHECKS" -eq 0 ]; then
  echo "  FAIL: no control ran at all — a sweep whose probes all miss must not certify itself." >&2
  exit 1
fi
if [ "$FAILURES" -ne 0 ]; then
  echo "  FAIL: $FAILURES control(s)/expectation(s) failed. No number above is to be trusted." >&2
  exit 1
fi
echo
echo "PASS — every tree measured under both controls, and every ledger row reproduced."
echo "       Run with --project-id p1 to reproduce the pre-round-242 2-char frame;"
echo "       the difference must be a flat +34 at every ref (36 - 2, one interpolation site)."
