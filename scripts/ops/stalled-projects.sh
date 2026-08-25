#!/usr/bin/env bash
# Find projects that have silently STOPPED.
#
# Why this exists: on 2026-08-18 three projects stopped without announcing it,
# and all three were found by accident.
#   - canvas-ux / live-agent-panel: a fix cycle FAILED and nothing retried it,
#     leaving its paired re-reviewer pending forever.
#   - os-usable-for-work: the operator retired tasks as `blocked`, and
#     promoteReadyTasks() only advances when NO earlier round has a row with
#     status <> 'done' — so they wedged every round above them, by position.
#   - engine-task-graph: consolidateVerdictGroup blocked it on max_cycles.
#
# The common shape: nothing errors, nothing runs, nothing reports. A stopped
# project looks exactly like a finished one unless you go and ask.
#
# CONTROLLED IN BOTH DIRECTIONS, 2026-08-18, and the evidence is recorded here
# because a detector that has only ever said "clear" is indistinguishable from
# one that cannot fire:
#   POSITIVE — first run, before the `cancelled` exclusion: exit 1, three
#              findings (canvas-ux + live-agent-panel holding open work; three
#              failed fix cycles with pending successors). Real rows, not fixtures.
#   NEGATIVE — after excluding `cancelled` (a decision, not a stall): exit 0.
# If you change a query here, re-establish the positive by removing one filter
# and confirming it fires on live data before trusting a clear run again.
#
# Read-only. Exit codes: 0 = clear, 1 = something is stalled (so it can gate or
# alert), 2 = THIS DETECTOR IS BROKEN (a query failed to run). See Q() below for
# why 2 has to exist and be distinct.
set -uo pipefail

# STALLED_PROJECTS_DB_URL is the ONLY way to point this script somewhere else,
# and it exists so the new sections below can be proven against a constructed
# shape (see the bite-proofs recorded in those comment blocks). It is test-only:
# never set it in cron, pm2 or a supervisor unit.
#
# The obvious form `if [ -z "$DATABASE_URL" ]` is WRONG here and was rejected:
# worker shells inherit a live DATABASE_URL, so that form would leave ordinary
# runs pointing at whatever the caller happened to export — silently. This one
# fires only when explicitly asked, and says so on stderr when it does.
#
# `set -a` + source OVERWRITES an exported DATABASE_URL (measured 2026-08-25:
# exporting a scratch URL and sourcing the env file yields the fleet URL), which
# is why the override has to short-circuit the source rather than precede it.
if [ -n "${STALLED_PROJECTS_DB_URL:-}" ]; then
  DATABASE_URL="$STALLED_PROJECTS_DB_URL"
  echo "NOTE: using STALLED_PROJECTS_DB_URL — this is NOT the fleet database." >&2
else
  set -a; . /opt/ai-os/.secrets/forge-control.env 2>/dev/null; set +a
fi

# Q() USED TO BE `psql ... 2>/dev/null` with the exit status never read. Every
# section here is `[ -n "$out" ] && ... || echo "none"`, so a query that does not
# compile produced an empty string, printed `none`, and the script exited 0 with
# `clear — no silently stopped projects.` A BROKEN DETECTOR WAS INDISTINGUISHABLE
# FROM A CLEAN FLEET. Reproduced 2026-08-25 against the then-current line 30:
#   $ out=$(Q "select p.name from projects p where p.nonexistent_column = 1")
#   $ [ -n "$out" ] && echo rows || echo none
#   none                      <-- a broken query reads as CLEAN, exit 0
# This is the `grep ... || true` trap one level in, and every section added to
# this file inherits it. So: capture the status, let stderr through, and abort
# with exit 2 — a THIRD code, so a cron wrapper cannot read a broken detector as
# a healthy one the way it would if this returned 0 or 1.
#
# CALL IT AS A STATEMENT — `Q "select ..."` — then read the global `out`.
# NOT `out=$(Q "select ...")`. Command substitution runs Q in a SUBSHELL, so the
# `exit 2` below would kill only that subshell; the script would sail on with an
# empty `out`, print `none`, and exit 0 — i.e. the exact defect this function
# exists to fix, reintroduced by the call site. That is easy to do by accident,
# so it is checked rather than merely documented: BASH_SUBSHELL is non-zero
# inside `$( )` and the guard makes the misuse loud on stderr instead of silent.
Q() {
  local rc
  if [ "$BASH_SUBSHELL" -ne 0 ]; then
    printf 'FATAL: Q() called inside a subshell (BASH_SUBSHELL=%d) — its exit 2 cannot reach the script.\n' "$BASH_SUBSHELL" >&2
    printf 'FATAL: call it as a statement -- Q "select ..." -- and read the global variable out.\n' >&2
    exit 2
  fi
  out=$(psql "$DATABASE_URL" -At -F'|' -c "$1"); rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'FATAL: query failed (psql rc=%d). This detector does not report CLEAN on a broken query.\n' "$rc" >&2
    printf 'FATAL: the query was:\n%s\n' "$1" >&2
    exit 2
  fi
}
out=""
found=0

section() { printf '\n== %s ==\n' "$1"; }

# `cancelled` is EXCLUDED deliberately: it is a decision, not a stall. A
# detector that flags intended states gets ignored, and then misses a real one.
section "BLOCKED or PAUSED while holding open work"
Q "select p.name, p.status, count(*)
         from projects p join project_tasks t on t.project_id = p.id
         where p.status in ('blocked','paused') and t.status in ('pending','ready','running')
         group by 1,2 order by 3 desc"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "BLOCKED or PAUSED with NO OPEN WORK LEFT — dead, and invisible twice"
# Added 2026-08-25. The section directly above requires `t.status in
# ('pending','ready','running')` — OPEN work. When a project's last live rows are
# the ones that FAILED, open work is exactly zero and the project drops out of
# that section BY CONSTRUCTION. Every other section in this file filters
# `p.status = 'active'`, which a blocked/paused project is not. So a blocked
# project with no open rows is invisible TWICE, and reads exactly like a finished
# one. Cost: aios-sidebar-live-sessions sat dead for nine hours, unreported.
#
# The two `having` terms are the whole design, and each is a REAL exclusion —
# neither is decoration. CONTROLLED BY FILTER INVERSION on live data (the file's
# convention), re-measured 2026-08-25 22:03Z against content_forge:
#   NEGATIVE   — as written: 0 rows. There is no live instance today; the one
#                real case had already been recovered by hand. A green run of
#                this section is therefore evidence of NOTHING on its own, which
#                is why the constructed-shape proof below exists.
#   POSITIVE A — drop `count(*) filter (where t.status='done') > 0`: 1 row,
#                `smoke-test|paused|1|0`. A project that never completed a single
#                task failed to START; that is not a stall, and without this term
#                the section would report it forever.
#   POSITIVE B — drop `count(*) filter (where t.status='failed') > 0`: 1 row,
#                `connect-clis-from-settings|paused|0|4`. Four done, nothing
#                failed, nothing open — a clean pause is a DECISION, not a stall.
#   BITE PROOF — because the negative above is empty for want of an instance,
#                the shape was CONSTRUCTED in a scratch database (see the
#                STALLED_PROJECTS_DB_URL note at the top) and this section was
#                run against it, catching:
#                  scratch-dead-blocked|blocked|1|2
#                A section that has never returned a row is indistinguishable
#                from a typo, so that transcript is the control, not the query.
Q "select p.name, p.status,
                count(*) filter (where t.status='failed') as failed,
                count(*) filter (where t.status='done') as done
         from projects p join project_tasks t on t.project_id = p.id
         where p.status in ('blocked','paused')
         group by p.id, p.name, p.status
         having count(*) filter (where t.status in ('pending','ready','running')) = 0
            and count(*) filter (where t.status='failed') > 0
            and count(*) filter (where t.status='done') > 0
         order by p.name"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "WEDGED BY POSITION — a non-done row below the lowest open round"
# promoteReadyTasks(): NOT EXISTS (earlier.round < pt.round AND earlier.status <> 'done')
Q "select p.name, t.round, t.status, left(t.title,44)
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'active'
           and t.status in ('failed','blocked')
           and exists (select 1 from project_tasks u
                       where u.project_id = t.project_id
                         and u.round > t.round
                         and u.status in ('pending','ready'))
         order by p.name, t.round"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "WEDGED DESPITE SATISFIED DEPENDENCIES — could run, has not"
# Added 2026-08-19 after this detector reported "clear" while the whole `vault`
# workstream sat frozen for hours. Every check above is PROJECT-scoped, so a
# project stayed invisible as long as ANY lane was busy — and one was.
#
# This test is mechanism-independent: a row that is pending, whose every NAMED
# dependency exists and is done, and which has not moved in 20 minutes, is
# wedged. It does not matter whether the cause was the R69 straddle term, a
# legacy `depends_on IS NULL` row below it, or something not yet invented.
# Under a correct scheduler this result set is empty by construction.
#
# The cause that motivated it: promoteReadyTasks() holds back any graph row
# above a non-done row with `depends_on IS NULL` — PROJECT-WIDE, across
# unrelated workstreams. Two barrier rows added BY HAND during a task
# compression were born legacy-null and silently serialised four lanes.
#
# CONTROLLED 2026-08-19 BY FILTER INVERSION, not by a live wedge, because the
# wedge was repaired before this check existed. Saying which kind of control it
# is matters: this one proves the terms are live, not that it catches a real
# stall end-to-end.
#   NEGATIVE   — as written: 0 rows.
#   POSITIVE A — drop `and d.status='done'` from the subquery, so any dep state
#                counts as satisfied: 5 rows. Row selection and the interval
#                arithmetic are live.
#   POSITIVE B — flip `=` to `<>` (deps NOT all done): 11 rows, disjoint from A,
#                every one genuinely waiting. The deps-done term is live.
#
# HELD IS NOT WEDGED — exclusion added 2026-08-25. `graph_frozen` appeared ZERO
# times in this file, so this section could not tell a row the engine is
# deliberately HOLDING from one nothing will ever move. A frozen deploy row whose
# named dependencies are all done matches every term above the moment its
# reviewer goes done, and is then reported as wedged with a staleness figure that
# grows until it ships. Measured 18:00Z 2026-08-25:
#   aios-guardrail-hardening|main|20|deploy: ...|1005m stale
# That row promoted and started TEN SECONDS after its round-10 reviewer wrote
# VERDICT: PASS. It was never wedged; the detector was wrong.
#
# The exclusion is `graph_frozen AND a lower round in ('pending','ready',
# 'running')` — deliberately NOT the engine's own stillOpen() set
# (`not in ('done','cancelled')`). stillOpen() answers the ENGINE's question
# (does the promoter hold this row?); this detector asks a different one (will
# this row ever move on its own?). `failed` and `blocked` are in stillOpen() but
# are not live work: a frozen row behind a failed lower round is held AND
# permanently wedged, and that is precisely the row that must keep being
# reported. Using stillOpen() here would delete that class of real stall
# silently, by the row simply ceasing to appear.
#   KEPT — frozen row whose lower rounds are all terminal: no match, reported.
#   KEPT — frozen row whose only lower non-terminal row is `failed`: `failed` is
#          not in the set, so the exclusion does not fire. Reported.
#   EDGE, stated not glossed — a row with BOTH a failed AND a live lower round IS
#          excluded. Something below it is still draining; when that drains the
#          row reappears here on the next run. Deliberate, and the reason the
#          predicate is an EXISTS over live states rather than a NOT EXISTS over
#          terminal ones.
# `graph_frozen` is `boolean NOT NULL` (verified in information_schema), so there
# is no three-valued-logic hole where a NULL would silently pass the `and not`.
#
# CONTROLLED BY CONSTRUCTED SHAPE, 2026-08-25, because this section ALSO returns
# 0 rows on live data today (re-measured 22:04Z — the guardrail-hardening row has
# shipped), so a green run proves nothing about the new term either. Three rows
# were built in a scratch database and this section run against it:
#   EXCLUDED  — scratch-held|main|20 frozen, round 10 `pending`: absent. ✓
#   REPORTED  — scratch-wedged-failed|main|20 frozen, round 10 `failed`: present. ✓
#   REPORTED  — scratch-wedged-terminal|main|20 frozen, rounds below all
#               done/cancelled: present. ✓
# The middle one is the control that proves the ruling above, not just the term.
Q "select p.name, t.workstream, t.round, left(t.title,44),
                round(extract(epoch from (now()-t.updated_at))/60)||'m stale'
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'active'
           and t.status = 'pending'
           and t.depends_on is not null
           and cardinality(t.depends_on) = (select count(*) from project_tasks d
                 where d.id = any(t.depends_on)
                   and d.project_id = t.project_id
                   and d.status = 'done')
           and t.updated_at < now() - interval '20 minutes'
           and not (t.graph_frozen and exists (select 1 from project_tasks lo
                 where lo.project_id = t.project_id
                   and lo.round < t.round
                   and lo.status in ('pending','ready','running')))
         order by p.name, t.workstream, t.round"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "LEGACY BARRIER — a depends_on IS NULL row holding back the graph"
# The specific cause above, named directly so the next one is found in seconds
# rather than by re-reading promoteReadyTasks(). A legacy row is not wrong in
# itself; a legacy row with OPEN GRAPH ROWS ABOVE IT is a project-wide barrier.
# Hand-seeded rows are the usual source — the engine's own rows always carry
# depends_on, so anything null here was almost certainly inserted by an operator.
Q "select p.name, t.workstream, t.round, t.status, left(t.title,40)
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'active'
           and t.depends_on is null
           and t.status <> 'done'
           and exists (select 1 from project_tasks u
                       where u.project_id = t.project_id
                         and u.round > t.round
                         and u.depends_on is not null
                         and u.status in ('pending','ready'))
         order by p.name, t.round"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "ZOMBIE — task says running, its run is over"
# Added 2026-08-19 after this detector reported "clear" for TWENTY-ONE HOURS
# while both projects were dead. Two tasks sat in `running` whose runs had
# `completed` — their verdicts were even delivered to the operator — because
# reconcile refuses non-active projects (`projectAcceptsWork()`), and the
# operator had PAUSED both to cut token burn. The runs finished during the
# pause, nothing absorbed them, and nothing complained.
#
# A NEEDS_FIXES delivered into a paused project seeds no fix chain AND raises
# no alarm. Un-pausing does not revisit it: reconcile only looks at runs that
# complete while the project is active. The row is orphaned permanently.
#
# EVERY OTHER CHECK HERE IS BLIND TO THIS. "Nothing running" was false (the row
# claims to be running) and "wedged despite satisfied dependencies" was false
# (the blocker is a `running` row, not a pending one). This is the third
# detector blind spot found in one day, and the only one that cost a full day.
#
# CONTROLLED ON LIVE DATA, the strong kind:
#   POSITIVE — 2026-08-19, before the hand-recovery: 2 rows, ages 1063m and
#              1263m, both runs `completed`. Real rows, not fixtures.
#   NEGATIVE — after closing them and re-seeding the chains: 0 rows.
Q "select p.name, t.workstream, t.round, t.role, r.status as run_status,
                round(extract(epoch from (now()-r.updated_at))/60)||'m dead', left(t.title,34)
         from projects p
         join project_tasks t on t.project_id = p.id
         join runs r on r.id = t.run_id
         where t.status = 'running'
           and r.status in ('completed','failed','stuck','cancelled')
         order by r.updated_at"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "TWO LIVE SESSIONS IN ONE WORKTREE — contention inside a lane"
# Workstream worktrees isolate LANES from each other. They do NOT isolate tasks
# WITHIN a lane: promoteReadyTasks() will happily make three rows of the same
# workstream ready at once, and they all get the same checkout.
#
# Observed three times on 2026-08-19, each hand-patched:
#   vault       — two re-reviewers gating the same HEAD, duplicate work
#   connections — a fix BUILDER writing while a REVIEWER gated the tree
#   main        — a PLANNER creating docs/plan files while a REVIEWER read
#                 `git status --porcelain` and would have reported it dirty
# The builder+reviewer case is the dangerous one: a verdict written against a
# tree that moved under it is worthless, and reviewers have escalated exactly
# that several times without knowing the cause was a sibling task.
#
# CONTROLLED ON LIVE DATA, not by inversion — this is the strong kind:
#   POSITIVE — 2026-08-19, before the hand-patch, on real rows:
#                os-usable-for-work | connections | 2 | builder+reviewer
#                os-usable-for-work | main        | 2 | planner+reviewer
#   NEGATIVE — after serialising both: 0 rows.
# Roles are printed because builder+reviewer is worth waking up for and
# reviewer+reviewer is merely wasteful.
Q "select p.name, t.workstream, count(*) as live,
                string_agg(distinct t.role, '+') as roles
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'active' and t.status in ('ready','running')
         group by p.name, t.workstream
         having count(*) > 1
         order by count(*) desc"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "FAILED task with a pending successor — nothing will retry it"
Q "select p.name, t.round, left(t.title,44)
         from projects p join project_tasks t on t.project_id = p.id
         where t.status = 'failed'
           and p.status = 'active'
           and exists (select 1 from project_tasks u
                       where u.project_id = t.project_id and u.status in ('pending','ready'))
         order by p.name, t.round"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "CLOSED PROJECT STILL HOLDING OPEN WORK — the status is a claim, not a fact"
# Added 2026-08-25. Every check above asks about projects that are still open
# ('active', 'blocked', 'paused'). Nothing has ever asked the reverse question:
# a project marked DONE whose task rows are not.
#
# db/projects.ts reconcileProjectStatuses() has the same blind spot by
# construction — its WHERE clause is `p.status IN ('active','blocked','paused')`
# — so no code path in the engine can see this state either. It closes projects
# whose tasks are all finished; it never checks that a closed project's tasks
# are.
#
# Why this is not a tidiness complaint: `done` is what the Kanban, the Today
# chips and every summary read. A project reporting done while five builder
# lanes sit blocked is reporting work that was never carried — and those rows
# are unreachable, because promoteReadyTasks() will not advance a project that
# is not active. They wait forever without ever appearing in a stall report.
#
# `cancelled` is EXCLUDED here for the same reason it is excluded above: a
# cancelled project's leftovers are the residue of a decision. `done` is not a
# decision about the tasks — it is an assertion about them.
#
# CONTROLLED ON LIVE DATA, the strong kind, at the moment it was written:
#   POSITIVE — aios-goals-day-system | blocked | 5 (4 builders + 1 reviewer,
#              blocked since 2026-08-23 01:26; the project was closed anyway).
#   NEGATIVE — inverting the row filter to `t.status in ('done')` returns the
#              finished rows of every closed project, which proves the join and
#              the grouping are live rather than the filter being empty for a
#              structural reason.
Q "select p.name, t.status, count(*),
                round(extract(epoch from (now()-max(t.updated_at)))/3600) || 'h since last change'
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'done'
           and t.status in ('pending','ready','running','blocked','failed')
         group by p.id, p.name, t.status
         order by p.name, t.status"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

section "ACTIVE, work queued, but NOTHING running and nothing started recently"
Q "select p.name,
                count(*) filter (where t.status in ('pending','ready')) as queued,
                round(extract(epoch from (now() - max(t.updated_at)))/60) || 'm since last change' as idle
         from projects p join project_tasks t on t.project_id = p.id
         where p.status = 'active'
         group by p.id, p.name
         having count(*) filter (where t.status = 'running') = 0
            and count(*) filter (where t.status in ('pending','ready')) > 0
            and max(t.updated_at) < now() - interval '30 minutes'"
[ -n "$out" ] && { echo "$out"; found=1; } || echo "none"

printf '\n'
if [ "$found" -eq 1 ]; then
  echo "STALLED — see above. A stopped project does not report; that is the whole point of this check."
  exit 1
fi
echo "clear — no silently stopped projects."
