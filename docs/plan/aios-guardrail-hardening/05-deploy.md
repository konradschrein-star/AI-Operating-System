# 05 — Deploy procedure for the guardrail hardening branch

Written in round 5 (fix cycle 1) because blocker B7 of the round-4 review is an
**ordering** defect, and an ordering defect has no fix inside the code — it has a
fix inside the deploy sequence. Nothing in this document has been executed: this
is a build task under the worktree-only policy, and every command below belongs
to a deploy/verify task that is briefed to touch `/opt/forge-ai-os`, the live
database and pm2.

Related: [`01-engine.md`](01-engine.md) §4 (the audit table),
[`04-review.md`](04-review.md) B7 and finding 7,
[`03-hygiene.md`](03-hygiene.md) (logrotate, which is also install-time work).

---

## 0. The one thing that must not be got wrong

**Apply `db/migrations/0051_guardrail_rule_changes.sql` BEFORE restarting
forge-control. Not after, not "in the same window".**

`recordRuleChange` writes to `guardrail_rule_changes`. That table does not exist
in `content_forge` until this migration runs. Round 4 measured its absence and
the consequence: restart the code first and **every** guardrail toggle and every
trip resolve takes the audit-failure path until the migration lands.

Round 5 made that path survivable — `POST /rules/:id` and
`POST /trips/:id/resolve` now return **200 with `"audit": "failed"`** and the
Postgres error text in `audit_error`, instead of a 500 over a change that had
already been committed. That is a floor, not a licence: with the code live and
the table missing, every change in the window is unlogged. The notification
still fires, so Konrad is not blind — but `guardrail_rule_changes` will have a
hole in it that no later migration can backfill.

`GET /api/autonomy` is already safe in either order: `rule_changes` is
`GuardrailRuleChange[] | null` and the read is wrapped, so a missing table
degrades that one field and never takes the fleet pause switch down with it.

### The order

```
# 1 — migration first. Route is `docker exec`, never a host-side bare `psql`:
#     that reaches an unrelated cluster on :5434 (memory:
#     content-forge-psql-only-via-docker-exec).
docker exec -i content-forge-postgres psql -U postgres -d content_forge \
  -f - < db/migrations/0051_guardrail_rule_changes.sql

# 2 — confirm the table is really there before the restart, not after
docker exec -i content-forge-postgres psql -U postgres -d content_forge \
  -c '\d guardrail_rule_changes'

# 3 — only now restart. NEVER `pm2 restart forge-executor` — that kills every
#     run in flight. scripts/ops/safe-restart.sh is the procedure that exists
#     for this, and it has its own preconditions (memory:
#     safe-restart-blocks-followup-tasks).
```

The migration is `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, so
step 1 is idempotent and re-running it is a no-op — proved on a scratch database
in [`01-engine.md`](01-engine.md) §4.

---

## 1. The hook layer is installed by a script, not by the merge

`scripts/ops/install-hooks.sh` and `scripts/ops/install-symlinks.sh` are what put
the PreToolUse hooks in front of every agent's Bash calls. **Neither has ever
been run against the live host** — round 4 verified that explicitly. Merging this
branch changes nothing on the box until they are.

```
scripts/ops/install-hooks.sh --check      # exits 1 when registration drifts
scripts/ops/install-symlinks.sh --dry-run # prints what it would link
scripts/ops/install-symlinks.sh
scripts/ops/install-hooks.sh
```

`install-symlinks.sh` also `chmod 750`s `check-vps2-backup.sh`, which git cannot
carry (it stores `100755`). That chmod is the ONLY thing that ever sets the mode,
which is why `scripts/checks/check-ops-scripts.sh` asserts `750` on the installed
checkout and SKIPs loudly anywhere else — see §3.

`install-hooks.sh` preserves `permissions`, `theme` and `cleanupPeriodDays` in
`/root/.claude/settings.json`, `--check` exits 1 on drift, and a second run is a
no-op. All three verified in round 4, against a copy.

---

## 2. Post-deploy verification (belongs to the deploy task, not to a builder)

1. `GET /api/autonomy` returns 200 and `rule_changes` is an **array**, not
   `null`. `null` after step 0 means the migration did not actually apply.
2. Toggle one rule from the console and confirm the response carries
   `"audit": "ok"`. `"audit": "failed"` here is the B7 window still open.
3. Confirm the toggle produced exactly one `guardrail_rule_changes` row and one
   Telegram push. The console is not exempt from either — that is deliberate.
4. Toggle it back. Both directions are audited.
5. `python3 scripts/ops/test-guard-autonomy.py` on the deployed checkout:
   **exit 0, with the `N/N passed` line showing the same number on both sides**
   — at round 7 that is 244/244, and the suite grows every cycle, so the exit
   code and the equality are the assertion, never a number copied from here.
   (Round 6's reviewer found this step still demanding 188/188 against a
   199-case suite: a verifier following the doc literally reads a correct run
   as a mismatch, which is a doc that makes the deploy fail.)
   Critically, **zero new `guardrail_trips` rows** — Layer A is in-process
   and Layer B talks to a stub the file starts itself, never to :7700
   (memory: guard-hook-tests-never-hit-live-api). Count the table before and
   after; equal counts are the assertion.
6. `bash scripts/checks/prove-guard-bites.sh` → prints `BITES`, exits 0, every
   mutation `DISCRIMINATED` (15 at round 7 — again, read the verdict line, not
   a count from this doc), and the hook's md5 unchanged across the run. Allow
   it ~4 minutes: it runs the whole suite once per mutation and exceeds the
   default 2-minute Bash timeout (memory: gate-run-exceeds-bash-default-timeout).

---

## 3. What a fresh checkout will and will not report

`scripts/checks/check-ops-scripts.sh` prints

```
SKIP: check-vps2-backup.sh mode is 755 — not asserting 750: …
```

in every worktree, and that is correct: git stores `100755`, nothing in a
checkout sets `750`, and asserting it unconditionally is what made gate 26 a
permanent `RED: 1` in the shared `gates-808.sh` suite for every project on the
box (memory: inherited-assertion-newly-wired-is-not-inherited-red).

**On the installed checkout the assertion is live and will fail at 755.** If the
deploy task sees that FAIL, the fix is `scripts/ops/install-symlinks.sh`, not an
edit to the check. The transcript proving it still bites is
`bash scripts/checks/prove-ops-mode-bites.sh` → `BITES`.

---

## 4. Not in this deploy

- **The `pipeline.ts` DSN.** `forge-control/src/routes/pipeline.ts:12` carries a
  live-looking `content_forge` password, on `main` since `a5c36b5`. Rotating it
  drops every live connection across forge-control, forge-executor and the
  content-forge workers, so it is Konrad's call and its own window. Fixed order
  (manager ruling, 2026-08-25): redact the output → rotate → remove the literal
  → wire `check-secret-scan.ts` into `gates-808.sh`. Only the first step is on
  this branch (`cd80b57`).
- **Deleting or pruning `guardrail_trips`.** Round 2 made the log READ
  (`fleet-pulse.sh` §3). Nothing prunes it and nothing should, without an
  explicit instruction — it is Konrad's audit log.
