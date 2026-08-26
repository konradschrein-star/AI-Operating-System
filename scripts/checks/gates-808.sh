#!/usr/bin/env bash
#
# gates-808.sh — the FULL universal gate set, run in one go, recorded verbatim.
#
# WHY THIS FILE EXISTS. Round 807 finding 5: `gates-806.txt` recorded 6 gates
# where `gates-804.txt` recorded 12, and the six it dropped included the one
# known to be RED (`dollar-sweep.sh`) — while the header still said
# "Gates 6/6 green". A gate set assembled by hand each round is a gate set that
# silently shrinks under deadline pressure. So the set is a committed script
# now: running it is one command, it always runs everything, and every gate
# prints its own exit code whether it passed or not.
#
# It is deliberately NOT clever. No parallelism, no early exit, no suppression:
# a red gate must stay visible and must not stop the ones after it.
#
# Usage:
#   bash scripts/checks/gates-808.sh                 # everything except the
#                                                    # browser gates
#   PHASE600_BASE_URL=http://127.0.0.1:7832 \
#   PHASE700_BASE_URL=http://127.0.0.1:7832 \
#   PHASE700_API_URL=http://127.0.0.1:7830 \
#   FORGE_SESSION_COOKIE="$(cat /tmp/p808-cookie.txt)" \
#     bash scripts/checks/gates-808.sh --browser     # + network-700 + nav-walk
#                                                    # + chat-reference-navigation
#
#   bash scripts/checks/gates-808.sh --strict         # same run, but exit
#     nonzero if RED>0 — see the note above the final exit for why this is a
#     separate flag rather than the default. Composes with --browser in
#     either order: `--strict --browser` and `--browser --strict` both work.
#
# The browser gates need the harness from docs/plan/artifacts/phase800/README
# §2 (an API on its own port with an ISOLATED SECRET_STORE_DIR, and a web build
# baked against it). They are skipped, loudly, when it is not up — skipped and
# labelled SKIPPED, never silently omitted.

set -uo pipefail   # NOT -e: a red gate must not abort the run.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

BROWSER=0
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --browser) BROWSER=1 ;;
    --strict) STRICT=1 ;;
  esac
done

n=0
declare -a NAMES=() CODES=()

# Run one gate: header, command, verbatim output, exit code, remembered.
gate() {
  local name="$1"; shift
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "\$ $*"
  echo
  "$@"
  local code=$?
  echo
  echo "EXIT=$code"
  NAMES+=("$name"); CODES+=("$code")
}

# A gate whose body is shell rather than one command.
#
# `set -o pipefail` is not decoration — without it this helper LIED. Round
# 1353's review, finding 2: gate 8 runs `bash scripts/checks/dollar-sweep.sh |
# tail -6`, the sweep exited 1, and the pipeline reported `tail`'s status — so a
# RED gate printed EXIT=0 and the summary line said "RED: 0". Gates 9, 10, 15
# and 16 pipe the same way and were swallowing the same way. Every gate here
# exists to fail loudly; one that cannot fail is worse than one that is absent,
# because it is counted in the total.
gate_sh() {
  local name="$1" script="$2"
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "\$ $script"
  echo
  # Set inside `bash -c`, not on this shell: the gate body is the only thing
  # whose pipelines this may change.
  bash -c "set -o pipefail; $script"
  local code=$?
  echo
  echo "EXIT=$code"
  NAMES+=("$name"); CODES+=("$code")
}

skip() {
  local name="$1" why="$2"
  n=$((n + 1))
  echo
  echo "########## GATE $n — $name ##########"
  echo "SKIPPED — $why"
  NAMES+=("$name (SKIPPED)"); CODES+=("-")
}

echo "================================================================================"
echo " ROUND 808 — UNIVERSAL GATES, verbatim"
echo " repo:   $REPO"
echo " branch: $(git rev-parse --abbrev-ref HEAD)"
echo " HEAD:   $(git rev-parse HEAD)"
echo " date:   $(date -Is)"
echo "================================================================================"
echo
echo "WORKING-COPY STATE AT THE TOP OF THIS RUN (read this before the gates):"
git status --porcelain
echo
echo "NOTE: five sibling tasks of this project write in this same worktree"
echo "concurrently. Round 808's OWN commits are the only thing it claims; the"
echo "browser evidence was captured against an isolated 'git archive' of them"
echo "(see docs/plan/artifacts/phase800/README §8), not against this working copy."

gate_sh "npx tsc --noEmit — forge-control" "cd forge-control && npx tsc --noEmit"
gate_sh "npx tsc --noEmit — forge-control-web" "cd forge-control-web && npx tsc --noEmit"
gate_sh "NODE_ENV=production pnpm build — forge-control-web" \
  "cd forge-control-web && NODE_ENV=production pnpm build 2>&1 | grep -E 'Compiled|Route \(app\)|Failed|Error' | head -5"

gate_sh "token purity — round 808's own files" \
  "grep -rnE '#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(' \
     docs/plan/artifacts/phase800/psql-argv-leak.cjs \
     docs/plan/artifacts/phase800/nav-walk-sampling.cjs \
     docs/plan/artifacts/phase600/nav-walk.cjs \
     scripts/checks/check-working-sql-agreement.ts \
     scripts/checks/gates-808.sh \
     scripts/checks/dollar-allowlist.txt \
     README.md \
   && { echo '>>> UNLISTED COLOUR LITERAL'; exit 1; } || { echo 'CLEAN — zero colour literals'; exit 0; }"

gate "no-raw-colours.cjs (whole app)" node scripts/checks/no-raw-colours.cjs

# OPERATOR WAIVER 2026-08-16 — FileExplorerPanel.tsx removed from this list.
# The Files ban existed only to avoid colliding with project files-pane-fast-light,
# which COMPLETED 2026-08-05. Konrad asked for open-document-in-a-new-tab; FilePreview
# is defined inside FileExplorerPanel.tsx with no injection slot, so the feature is
# impossible without touching it. The operator authorised the exact approach (extract
# FilePreview verbatim + two-line panel edit) BEFORE it was written; landed in fc842d3.
# Scope of the waiver: FileExplorerPanel.tsx ONLY. VaultFileList* and routes/files
# remain forbidden, as do all engine files.
#
# OPERATOR WAIVER 2026-08-23 — the REST of the Files reservation is released.
# The clause above states the ban's entire purpose: avoiding a collision with
# project files-pane-fast-light. Verified in the projects table today — that
# project is `done`, closed 2026-08-05, eighteen days ago. The 2026-08-16 waiver
# released only FileExplorerPanel.tsx because that was all that was needed then,
# not because the rest still had a reason.
#
# aios-library-and-map's brief then explicitly ordered a builder to EXTEND
# forge-control/src/routes/files.ts ("find it, read it, extend it rather than
# starting a second one"), and it did, in ad35016. The gate had therefore become
# unsatisfiable by any correct execution of an authorised brief: it could only be
# passed by disobeying the brief, or by a builder widening the gate — and a
# builder widening a gate is forbidden. That is a toll, not evidence.
#
# OPERATOR WAIVER 2026-08-26 — BRANCH-SCOPED to `operator/agy-fix`.
# Scope: forge-control/src/lib/project-tick.ts (+ its test) and
#        forge-control/src/db/projects.ts. Nothing else, no other branch.
#
# Authorised by Konrad in the run that commissioned the work ("Fix it so we can
# actually use agy properly"), after the Gemini engine was measured failing 16
# of 18 runs — NOT at the work, but against two stacked timeouts: agy's own
# `--print-timeout`, defaulting to 5m0s and never set by this repo, and the
# runner's 10min wall-clock kill, both sitting under a 15.7min median task.
#
# Why these two files specifically:
#   project-tick.ts  — the pin must be read where fix chains are CREATED. Twelve
#                      consecutive rows on five gemini-pinned projects ran on
#                      Claude because the pin was only ever read in the HTTP
#                      route, and fix chains do not go through it.
#   db/projects.ts   — adds `tierPinOf`/`getProjectTierPin` so the route and the
#                      tick share ONE definition instead of two that drift.
#
# Scoped by branch, not released outright, so the ban stays fully armed for
# every other lane and this waiver dies when the branch merges. The remaining
# bans — cc-runner, executor.ts, and these same files on any other branch —
# are untouched and still fail closed.
#
# RELEASED: routes/files, VaultFileList*.
# STILL FORBIDDEN, for a live reason rather than an expired reservation:
# project-tick, cc-runner, executor.ts, db/projects — the scheduler and the run
# engine, where one careless edit breaks every lane at once. Those stay banned,
# and an authorised edit to them is recorded here the same way this one is.
#
# OPERATOR WAIVER 2026-08-25 — recorded here the way the paragraph above says.
# Project aios-gemini-default-tier: Konrad's Claude WEEKLY limit is reached, so
# gemini (agy) becomes the fleet's default engine and that default becomes a
# RUNTIME setting instead of the next deploy. TIER_GUIDE — the block every
# planner reads to pick an engine — is defined in forge-control/src/lib/
# project-tick.ts, and the tick is where a row carrying no tier is resolved
# against the setting. The work cannot be done anywhere else, so this gate had
# become the toll the 2026-08-23 waiver above describes: passable only by
# disobeying an authorised brief, or by a builder widening a gate. Authorised in
# PLAN.md §4 ("Forbidden-File Gate Authorization").
#
# SCOPE: forge-control/src/lib/project-tick.ts and its .test.ts, on branch
# project/860c948e ONLY. The ban is SUSPENDED, not released — its reason is
# still live — so any other lane touching project-tick still goes red, and this
# waiver expires with the branch. cc-runner, executor.ts and db/projects stay
# forbidden for this project as well: none was authorised and none was touched
# (the fix-chain default is passed at the project-tick CALL SITE for exactly
# that reason).
# OPERATOR WAIVER 2026-08-26 — recorded the way the paragraph above requires.
# Project aios-takeover-usable: B4 was assigned the BROWSER_FIRST prompt block
# (PLAN.md:177), and that block is DEFINED in forge-control/src/lib/
# project-tick.ts. The work cannot be done anywhere else, so this gate had again
# become the toll the 2026-08-23 waiver describes: passable only by disobeying an
# authorised brief, or by a builder widening a gate.
#
# WHY IT WAS WORTH WAIVING: the quoted invocation said `open scratch`, and that
# one word is why Konrad's hand-typed logins kept landing in directories nothing
# ever reopened — eight profile dirs on disk, six round-scoped throwaways, each
# created because a run copied the example.
#
# I READ THE DIFF BEFORE WAIVING IT. Confined to the BROWSER_FIRST string and its
# doc comment: 22 lines, no declaration added or removed, no tick logic touched.
#
# SCOPE: project-tick.ts and its .test.ts, on branch project/51ddfb27 ONLY.
# SUSPENDED, not released — any other lane touching project-tick still goes red,
# and this waiver expires with the branch. cc-runner, executor.ts and db/projects
# stay forbidden here: none was authorised, none was touched.
#
# A PATH-SCOPED WAIVER IS NOT ENOUGH BY ITSELF. It would let any LATER commit on
# this branch edit project-tick.ts unseen. The gate directly below closes that
# half: under a waiver the CONTENT may change, the exported API may not.
#
# OPERATOR WAIVER 2026-08-26 — BRANCH-SCOPED to `project/0a0806d3`.
# Scope: forge-control/src/lib/project-tick.ts (+ its .test.ts) and
#        forge-control/src/db/projects.ts. Nothing else, no other branch.
#
# Authorised by the fleet supervisor, on the record in the vault at
# "AI OS/Operator Decisions.md" (2026-08-26, "Gate 6 waiver for
# project/0a0806d3, and the list that lives twice"). Project
# aios-r70-transitive-and-idle-fleet-alarm is CHARTERED to change R70: the fleet
# could not tell a working project from a finished one because
# `closeFinishedProjects()` tested DIRECT `depends_on` membership where the
# architect seeds a chain, so three projects with zero open tasks sat 'active'
# and the stall detector reported nothing. R70 lives in exactly two places —
# the SQL in `db/projects.ts` and its readable mirror `unintegratedWorkstreams()`
# reached through `lib/project-tick.ts` — so a fix that cannot touch either file
# cannot exist. The brief named both files before any code was written.
#
# THIS WAIVER EXTENDS THE 2026-08-25 SCOPE ABOVE RATHER THAN COPYING IT, and the
# extension is deliberate, not drift. That waiver kept `db/projects.ts`
# forbidden for its own project in terms ("cc-runner, executor.ts and db/projects
# stay forbidden for this project as well"), and was right to: a default-tier lane
# had no business in the close predicate. THIS lane's whole subject IS the close
# predicate. Same gate, opposite answer, because the charter differs — narrow it
# back for any lane that is not chartered there.
#
# `cc-runner` and `executor.ts` stay armed on every branch INCLUDING this one.
# `lib/task-graph.ts` and `lib/project-reconcile.ts` are not matched by the
# gate's pattern at all and need no waiver — the waiver is scoped to what the
# gate actually catches, not to everything the lane touched.
#
# CROSS-REFERENCE — THE PAIR MOVES TOGETHER. The forbidden list lives TWICE:
# here, and in `scripts/checks/guard.sh` (FORBIDDEN_RE, with its own branch
# waiver block below it). They have already diverged once — commit `e0c388f`
# waived `operator/agy-fix` HERE and never touched guard.sh. That commit is on
# main but NOT an ancestor of this branch (merge base `48c34d7`), so it will
# REAPPEAR at merge and re-diverge the two lists; reconcile both blocks in the
# same commit at that point, and re-measure rather than trusting any snapshot of
# main. A waiver applied to one instrument and not its twin is how the next lane
# spends an hour rediscovering the divergence.
gate_sh "forbidden-file diff — three-dot main...HEAD" \
  "waived=''; \
   [ \"\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\" = 'project/860c948e' ] \
     && waived='forge-control/src/lib/project-tick(\\.test)?\\.ts\$'; \
   [ \"\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\" = 'operator/agy-fix' ] \
     && waived='forge-control/src/(lib/project-tick(\\.test)?\\.ts|db/projects\\.ts)\$'; \
   [ \"\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\" = 'project/51ddfb27' ] \
     && waived='forge-control/src/lib/project-tick(\\.test)?\\.ts\$'; \
   [ \"\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\" = 'project/0a0806d3' ] \
     && waived='forge-control/src/(lib/project-tick(\\.test)?\\.ts|db/projects\\.ts)\$'; \
   hits=\$(git diff --name-only main...HEAD | grep -E 'project-tick|cc-runner|executor\\.ts|db/projects' || true); \
   [ -n \"\$waived\" ] && [ -n \"\$hits\" ] && hits=\$(printf '%s\\n' \"\$hits\" | grep -vE \"\$waived\" || true); \
   [ -n \"\$hits\" ] && { printf '%s\\n' \"\$hits\"; echo '>>> FORBIDDEN FILE DIFFERS'; exit 1; }; \
   echo 'clean — no unwaived engine/Files file differs'; exit 0"

# Applies to EVERY branch, waived or not. A path waiver above suspends the
# content ban for one branch; it cannot say "and only the part you were
# authorised to change". This supplies that half: a prompt string may be
# rewritten, an exported symbol may not appear or vanish.
#
# STRENGTHENED 2026-08-26 (project/0a0806d3, round 6) — AND IT IS A
# STRENGTHENING, NOT A WIDENING. The form this gate landed with on main at
# `b3c23ce` compared the output of
#
#     grep -oE '^export (async function|function|const|type|interface|class) [A-Za-z0-9_]+'
#
# taken over `git show main:` and over HEAD. It CLAIMED "exported surface
# identical" and MEASURED "declaration lines identical", and those differ in
# both directions — both measured, neither suspected:
#
#   FALSE GREEN, the direction the gate exists for: the pattern does not match
#   `export {` at all. Appending `export { somethingNew };` leaves the grep's
#   output byte-identical. The API GROWS under a content waiver and the gate
#   says nothing.
#   FALSE RED: this lane moved `unintegratedWorkstreams` and `CloseGateTask`
#   into the pure leaf `lib/task-graph.ts` — the whole point of NF3, so that
#   check-close-gate.ts can import the predicate without dragging `db/*` and
#   `node:fs` in — and left `export { unintegratedWorkstreams, type
#   CloseGateTask };` behind. 34 declaration lines against main's 36, the SAME
#   36 names, and a red gate.
#
# The ruling (fleet supervisor, 2026-08-26) was to fix the gate rather than
# waive it — a third waiver, applied to the very API gate that exists to bound
# the content waivers above, would hollow out the only thing standing between a
# waived file and a silent API change — and not to re-declare thin delegates in
# project-tick.ts either, since that re-creates the second surface site this
# project exists to remove.
#
# So both forms are resolved into a set of exported NAMES by
# scripts/checks/exported-names.sh (declaration forms as before, plus
# `export { a, type B, x as y }`, `export type { … }`, `export * as ns`,
# `export default`), and the sorted SETS are compared. Removing an export still
# goes red — the original job, unchanged. Adding one now goes red as well.
# scripts/checks/prove-surface-gate-bites.sh is the two-sided control: it runs
# both mutations against this gate AND against a frozen copy of the b3c23ce
# body, and the contrast (old GREEN / new RED on the added export) is the
# evidence that coverage grew instead of moved.
#
# AT MERGE: main carries the b3c23ce one-liner and this block replaces it. Take
# THIS side whole, keep every waiver block on both sides of it (all additive),
# and re-measure against main as merged rather than against any snapshot —
# `exported-names.sh` must arrive in the same merge or the gate cannot run.
gate_sh "project-tick.ts exported surface identical to main (a waiver covers content, never API)" \
  "a=\$(git show main:forge-control/src/lib/project-tick.ts 2>/dev/null | bash scripts/checks/exported-names.sh -) \
     || { echo '>>> could not read the exported names of main:forge-control/src/lib/project-tick.ts'; exit 1; }; \
   b=\$(bash scripts/checks/exported-names.sh forge-control/src/lib/project-tick.ts) \
     || { echo '>>> could not read the exported names of HEAD forge-control/src/lib/project-tick.ts'; exit 1; }; \
   n=\$(printf '%s\\n' \"\$a\" | wc -l | tr -d ' '); \
   if [ \"\$a\" = \"\$b\" ]; then echo \"exported surface identical — \$n names, every form resolved\"; exit 0; fi; \
   echo 'EXPORTED SURFACE CHANGED vs main (< main only, > HEAD only):'; \
   diff <(printf '%s\\n' \"\$a\") <(printf '%s\\n' \"\$b\") | grep -E '^[<>]'; \
   echo '>>> EXPORTED SURFACE CHANGED'; exit 1"

gate_sh "forge-control/ untouched by round 808's own commits" \
  "changed=\$(git diff --name-only 7b961b5..HEAD -- forge-control/ | wc -l); \
   echo \"forge-control/ files in 7b961b5..HEAD: \$changed\"; \
   git diff --name-only 7b961b5..HEAD -- forge-control/; \
   echo '(round 808 authored none of these; any listed file is a sibling task on the same branch)'; \
   exit 0"

gate_sh "check-migration-numbers.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-migration-numbers.ts | tail -3"
gate_sh "dollar-sweep.sh" "bash scripts/checks/dollar-sweep.sh | tail -6"
gate_sh "check-composer-v3.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-composer-v3.ts | tail -3"
gate_sh "check-secret-requests.ts" "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-secret-requests.ts | tail -3"
gate "contrast-canvas-banners.cjs" node scripts/checks/contrast-canvas-banners.cjs

gate_sh "check-working-sql-agreement.ts — standalone typecheck (the file round 808 changed)" \
  "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
     --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
     ../scripts/checks/check-working-sql-agreement.ts"

# ── Round 1354's two new checks ────────────────────────────────────────────
# Both are here rather than in a runbook because round 1353's review found the
# two defects they cover by driving a browser and by reading live SQL — work no
# reviewer should have to repeat by hand to learn the same thing twice.

gate_sh "check-stop-affordance.tsx — the ⏸ button's disabled state vs what a click does" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-stop-affordance.tsx | tail -3"

# ── Round 1355's checks ────────────────────────────────────────────────────
# A4: a control labelled "N hidden · show" whose onClick was `restoreAll`.
# Both halves of that defect — the missing peek in the markup, and the label
# bound to the wrong verb — are asserted; 25 of these assertions fail against
# round 1354's code (docs/plan/artifacts/phase1355/README.md §2).
gate_sh "check-dismiss-peek.tsx — the way back out of a dismissal, both surfaces" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-dismiss-peek.tsx | tail -3"

gate_sh "check-team-rows.ts — flatten, hiddenRows, frozen time" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-rows.ts | tail -2"

gate_sh "check-code-path-link.ts — detectPath: what's an openable file pill" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-code-path-link.ts | tail -3"

gate_sh "check-remark-wikilink.ts — [[wikilinks]] become links, and injections stay text" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-remark-wikilink.ts | tail -3"

gate_sh "check-frontmatter.ts — a note's YAML block is a meta strip, and the body survives it" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-frontmatter.ts | tail -3"

gate_sh "check-team-confirm.ts — the destructive-control machines (✕, stop, restore-all)" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-team-confirm.ts | tail -2"

# ── aios-sidebar-live-sessions round 2 ─────────────────────────────────────
# The LIVE SESSIONS block's three pure modules. Registered here rather than left
# to be run by hand for the reason the fleet has written down twice: a check
# nobody executes proves that it compiles and nothing else.
gate_sh "check-live-sessions.ts — live predicate, engine badge map, activity/elapsed degrade rules" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-live-sessions.ts | tail -2"

# ── aios-sidebar-live-sessions · the toggle lane's two checks ──────────────
# Both existed and passed for days while being executed by NOTHING: zero hits
# across scripts/**.sh, every package.json and every *.yml. instrument-manifest
# .txt lists them, which is the trap — the manifest COMPILES every file in
# scripts/checks/, and compiling is not running. A check nobody invokes is not
# a control, it is a file that agrees with you.
#
# Both were mutation-proved to go RED *through* their `| tail -2` pipe before
# being wired (gate_sh runs `bash -c "set -o pipefail; $script"`, so the pipe
# does not eat the exit code). Mutation: pollBudget.ts SIDEBAR_AGENTS_POLL_MS
# 8_000 -> 4_000 — A 34 passed/0 failed -> 31/3 EXIT=1, B ALL PASS -> 5
# FAILURE(S) EXIT=1.

gate_sh "check-sidebar-scope.ts — default scope, round-trip, unknown-value fallback" \
  "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-sidebar-scope.ts | tail -2"
gate_sh "check-chat-delta.ts — delta contract + the chat surface's req/min budget" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-delta.ts | tail -2"


# ── aios-autonomy-automation round 5 ───────────────────────────────────────
# Five "View Run in Chat" / "Settings → Connections" affordances shipped as
# `<a>` elements pointing at a query string this one-route console has never
# read. They typechecked, they built, and they navigated nowhere. The check
# asserts the replacement (localStorage + the shell's onNav) AND greps the two
# surfaces so the dead form cannot come back.
gate_sh "check-deep-link.ts — cross-surface navigation actually navigates" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-deep-link.ts | tail -3"

gate_sh "verify-notification-gap-pins.mjs — fenced quotes + prose pins" \
  "node docs/plan/artifacts/phase4/verify-notification-gap-pins.mjs | tail -2"

# ── aios-browser-takeover-live round 5 ─────────────────────────────────────
# This gate guards the ONE route in the repo that answers without a NextAuth
# session: nginx proxies /api/browser-takeover/ws/ straight past the Next
# process to forge-control, because a Route Handler cannot host a WebSocket.
# The thing on the far end is a Chrome holding Konrad's logged-in sessions.
#
# It is here because of round-4 review finding 1. The script existed, had 106
# assertions, and was RUN BY NOTHING: gates-808.sh never invoked it and
# check-instrument-typecheck.sh only COMPILES scripts/checks/*.ts. A log-
# redaction fix landed on main, tripped the script's own allowlist, and sat RED
# at main until a reviewer happened to run it by hand. A guard no gate executes
# is a guard that goes stale unobserved — so it is executed here, every round.
gate_sh "check-browser-takeover-ticket.ts — the unauthenticated-by-design socket" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
     --tsconfig ../tsconfig.checks.json ../scripts/checks/check-browser-takeover-ticket.ts | tail -3"

# ── aios-takeover-usable B1 ────────────────────────────────────────────────
# The pure half of text-to-VM: keysym rules R1 measured on the real stack
# (CRLF → one Return, Latin-1 identity, € via the table, emoji as ONE event),
# the noVNC class-list → state rule (there is no noVNC_disconnected class), and
# the exact header strings the page renders ('reconnecting 2/5 · dropped after
# 118 s', 'session clock unavailable — forge-control predates this build').
# Wired in the same commit that created it; mutation-proved RED through this
# pipe (vm-keys.ts "\r\n" rule → two Returns: 55 PASS → 53 PASS / 2 FAILURE(S),
# EXIT=1; restored by cp with sha256 match, then ALL PASS EXIT=0).
gate_sh "check-vm-keys.ts — keysym rules, viewer state, session clock strings" \
  "cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-vm-keys.ts | tail -2"

# Needs a Postgres SERVER. It creates its own scratch database and issues no
# statement against the one named in DATABASE_URL — but with no DSN at all there
# is nothing to connect to, so it is SKIPPED rather than reported as passing.
#
# DO NOT SET `USAGE_FOLD_DB` HERE, and this is the reason.
#
# `os-usable-for-work` round-4 review, finding F4: the check used to default its
# scratch database to the fixed name `r1354_sampler`. Five lanes run this suite
# concurrently, and two runs sharing one scratch database `TRUNCATE` the same
# three tables mid-assertion — a RED with nothing to say about the code, or
# worse, silently wrong arithmetic. Round 3's first attempt fixed it HERE, by
# exporting `USAGE_FOLD_DB=r1354_sampler_$$`. That protects this caller and
# nobody else: the check's own header tells operators to run it directly with no
# such variable, and an override cannot fix a default.
#
# So the check now names its own database per process (`r1354_sampler_p<pid>_
# <rand>`) and drops it on both exit paths whenever it chose the name itself.
# Passing a name from here would pin that guarantee to this one call site again
# AND stop this gate from ever exercising the default — the very thing that has
# to stay right. Left unset on purpose, so this gate is the default's canary.
if [ -n "${DATABASE_URL:-}" ]; then
  gate_sh "check-usage-fold.ts — hourly token fold, against a real Postgres" \
    "cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/check-usage-fold.ts | tail -3"
else
  skip "check-usage-fold.ts — hourly token fold" \
    "DATABASE_URL is unset; this gate needs a Postgres server to build its scratch db on"
fi

gate_sh "check-usage-fold.ts — standalone typecheck (outside forge-control's tsconfig)" \
  "cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
     --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions --isolatedModules --types node \
     ../scripts/checks/check-usage-fold.ts"

gate_sh "pnpm test — forge-control unit suite" \
  "cd forge-control && pnpm test 2>&1 | grep -E '^# (tests|pass|fail)'"

# The autonomy enforcement layer. These three hooks run BEFORE EVERY Bash,
# Write and Edit call made by every agent on this box, so a regression in them
# is a fleet-wide regression — which is exactly the class of thing this file
# exists to keep visible. All three suites are self-contained: the classifier
# assertions run in-process against the REPO copy of the hook (never
# /opt/ai-os/scripts/..., which is the live file), and the exit-code contract
# runs against a local stub HTTP server on an ephemeral port. Nothing here
# contacts :7700 — a blocked case against the live API inserts a real
# guardrail_trips row, so a gate that ran that way would pollute the audit log
# on every green run.
gate_sh "test-guard-autonomy.py — classifier matrix + exit-code contract" \
  "python3 scripts/ops/test-guard-autonomy.py | tail -3"
gate_sh "test-guard-service-restart.py" \
  "python3 scripts/ops/test-guard-service-restart.py | tail -3"
gate_sh "test-guard-protected-paths.py — the Write/Edit hole the Bash hooks cannot see" \
  "python3 scripts/ops/test-guard-protected-paths.py | tail -3"
# 2>&1 is load-bearing: check-ops-scripts.sh writes its FAIL lines to stderr,
# so a bare `| tail -3` prints three passing section headers over a red exit
# code and hides which check broke (memory: gates-808 `tail -6` hid gate 8's
# FAILs the same way). The window is 8, wide enough for its FAIL lines.
gate_sh "check-ops-scripts.sh — scripts/ops/ inventory, modes, hook registration" \
  "scripts/checks/check-ops-scripts.sh 2>&1 | tail -8"

gate_sh "psql-argv-leak.cjs — round 807 finding 3, before/after + drift guard" \
  "node docs/plan/artifacts/phase800/psql-argv-leak.cjs | tail -4"
gate_sh "nav-walk-sampling.cjs — round 807 finding 4, the arithmetic" \
  "node docs/plan/artifacts/phase800/nav-walk-sampling.cjs | tail -4"

if [ "$BROWSER" = "1" ]; then
  gate_sh "phase700/network-700.cjs (NFU3)" "node docs/plan/artifacts/phase700/network-700.cjs | tail -12"
  gate_sh "phase600/nav-walk.cjs — P1/P2/P3" "node docs/plan/artifacts/phase600/nav-walk.cjs | tail -12"
  # Chat reference navigation: clicks a path pill FROM THE TEAM TAB and asserts
  # the tab flip, the breadcrumbs, the selected row, the rendered content and a
  # tab count that stays at one. Every bug this feature has shipped was wiring
  # between components that each worked alone — invisible to tsc, to
  # check-code-path-link.ts and to a grep of the bundle. It needs its own stack
  # (a probe forge-control on a scratch database + a console built against it):
  # docs/plan/artifacts/chat-ref-nav/README.md.
  gate_sh "check-chat-reference-navigation.mjs — click a path pill, panel opens the file" \
    "node scripts/checks/check-chat-reference-navigation.mjs | tail -30"
  # Same stack, the other half of the affordance: the paths agents name inside
  # TOOL ROWS. Committed in round 7 and invoked by nothing until round 9 — a
  # check no runner runs is worse than no check, because its silence reads as a
  # pass. It shares check-chat-reference-navigation's harness and README.
  gate_sh "check-chat-tool-path.mjs — tool-row paths are openable, prose is not" \
    "node scripts/checks/check-chat-tool-path.mjs | tail -30"
else
  skip "phase700/network-700.cjs (NFU3)" "browser harness not requested (--browser); run separately, results in README §8"
  skip "phase600/nav-walk.cjs — P1/P2/P3" "browser harness not requested (--browser); run separately, results in README §8"
  skip "check-chat-reference-navigation.mjs — click a path pill, panel opens the file" \
    "browser harness not requested (--browser); run separately, recipe in docs/plan/artifacts/chat-ref-nav/README.md"
  skip "check-chat-tool-path.mjs — tool-row paths are openable, prose is not" \
    "browser harness not requested (--browser); run separately, recipe in docs/plan/artifacts/chat-ref-nav/README.md"
fi

gate_sh "reproduce-cleanliness — re-running a protocol leaves the tree untouched" \
  "before=\$(git status --porcelain | md5sum); \
   node docs/plan/artifacts/phase800/psql-argv-leak.cjs >/dev/null 2>&1; \
   node docs/plan/artifacts/phase800/nav-walk-sampling.cjs >/dev/null 2>&1; \
   after=\$(git status --porcelain | md5sum); \
   echo \"before: \$before\"; echo \"after:  \$after\"; \
   [ \"\$before\" = \"\$after\" ] && { echo 'PASS — tree untouched'; exit 0; } || { echo 'FAIL — tree changed'; exit 1; }"

# Needs a THROWAWAY Postgres (never content_forge — the harness itself refuses
# to run against a URL naming it). Same posture as check-usage-fold.ts above:
# SKIPPED, loudly, rather than reported as passing, when no such database has
# been provisioned. docs/plan/evidence/stuck-trapdoor-proof.md names the one
# this project provisioned and left in place.
if [ -n "${DRYRUN_DATABASE_URL:-}" ]; then
  gate_sh "stuck-trapdoor-dryrun.mts — watchdog flip/hold + COMPLETABLE_STATUS_SQL reclaim, against a real Postgres" \
    "cd forge-control && ./node_modules/.bin/tsx ../docs/plan/evidence/stuck-trapdoor-dryrun.mts | tail -25"
else
  skip "stuck-trapdoor-dryrun.mts — watchdog flip/hold + COMPLETABLE_STATUS_SQL reclaim" \
    "DRYRUN_DATABASE_URL is unset; this gate needs a THROWAWAY Postgres database (never content_forge) — see docs/plan/evidence/stuck-trapdoor-proof.md"
fi

echo
echo "================================================================================"
echo " SUMMARY — $n gates"
echo "================================================================================"
red=0
for i in "${!NAMES[@]}"; do
  printf ' %-2s %-6s %s\n' "$((i + 1))" "${CODES[$i]}" "${NAMES[$i]}"
  [ "${CODES[$i]}" != "0" ] && [ "${CODES[$i]}" != "-" ] && red=$((red + 1))
done
echo
echo " RED: $red"

# THIS SCRIPT IS A RECORDER, NOT A GATEKEEPER. It exits 0 even when RED>0, on
# purpose: an exit code that went nonzero on the first red gate is exactly the
# failure mode this file was built to avoid (see the header — a red gate must
# stay visible and must not stop the ones after it, and by the same logic it
# must not cut short whatever invoked this script either). The RED count above
# and each gate's own EXIT= line are the truth; read them.
#
# Anything that GATES A DECISION — CI, a deploy step, a reviewer's pass/fail —
# must invoke this script with --strict, which runs every gate exactly as
# above and then exits nonzero if RED>0. Do not gate on the bare exit code of
# a non-strict run; it is always 0.
if [ "$STRICT" = "1" ]; then
  exit $([ "$red" -eq 0 ] && echo 0 || echo 1)
fi
exit 0
