# 701 — Linkage ground truth: origin_chat_id write + endpoint proof

Phase 700 prerequisite. Executes the decision phase300 (`docs/plan/artifacts/phase300/linkage-fixture-finding.md` §6) left as a human statement of fact.

## 1. What we found (Step 1)

```sql
SELECT id, name, metadata->>'origin_chat_id' AS origin_chat_id FROM projects
 WHERE id IN ('8ea0cc08-28d9-4301-9f28-c98e1c5d6838','4120f785-fd86-414c-9a04-f10b2cd0c365');
```

Before:

```
                  id                  |          name           | origin_chat_id
--------------------------------------+-------------------------+----------------
 4120f785-fd86-414c-9a04-f10b2cd0c365 | engine-v2-research-lane |
 8ea0cc08-28d9-4301-9f28-c98e1c5d6838 | operator-visibility     |
(2 rows)
```

Both projects had **no** `origin_chat_id`. Per the round's decision table:
- `8ea0cc08` has none → run the write (Step 2).
- `4120f785` does **not** already point at `bfd1283a…` (it's empty too) → the STOP-and-escalate branch does not apply. No ambiguity risk from that clause.

## 2. Decision taken

Link **only** `8ea0cc08-28d9-4301-9f28-c98e1c5d6838` to chat `bfd1283a-b71b-4f35-b577-7d09aad803f2`. `4120f785` (engine-v2-research-lane) is left untouched — this round is not authorised to link it; that project belongs to a parallel lane and its linkage is its own call.

Note this is deliberately **narrower** than phase300 §6's own suggested follow-up SQL, which linked both project ids to the same chat and predicted the resolver would then report `link_ambiguous:true` for that chat (two projects, one chat). Round 701's brief overrides that with a single-project link specifically so the badge stays unambiguous now; linking `4120f785` too is left for that lane to decide, since doing it here would flip the ambiguous-newest-wins tiebreak onto whichever project is newer.

## 3. The one write (Step 2)

```sql
UPDATE projects SET metadata = metadata || jsonb_build_object('origin_chat_id','bfd1283a-b71b-4f35-b577-7d09aad803f2')
 WHERE id = '8ea0cc08-28d9-4301-9f28-c98e1c5d6838' AND NOT (metadata ? 'origin_chat_id');
```

Result: `UPDATE 1` (as expected — exactly the row count of one project missing the key).

Rollback (verbatim, for the record — not run):

```sql
UPDATE projects SET metadata = metadata - 'origin_chat_id' WHERE id = '8ea0cc08-28d9-4301-9f28-c98e1c5d6838';
```

After:

```
                  id                  |          name           |            origin_chat_id
--------------------------------------+-------------------------+---------------------------------------
 8ea0cc08-28d9-4301-9f28-c98e1c5d6838 | operator-visibility     | bfd1283a-b71b-4f35-b577-7d09aad803f2
 4120f785-fd86-414c-9a04-f10b2cd0c365 | engine-v2-research-lane |
(2 rows)
```

Both queries were run via `docker exec content-forge-postgres psql -U postgres -d content_forge` (the pg pool's actual target per `forge-control/src/db/ai_os.ts`'s `DATABASE_URL` default — `content-forge-postgres` docker container, not the host's own `postgres` socket/TCP listener, which is a different, unrelated instance and rejected both peer and password auth).

## 4. Endpoint proof (Step 3) — against worktree API :7798

All captured within the same second window (01:08:31Z–01:08:50Z UTC, 2026-08-06), except (e) which was captured alongside (d) at 01:08:50Z. Note up front: this project's own tasks are actively changing status while this round runs (2 tasks were `running` at capture time — see §5), so a later re-check may show a different, still self-consistent, done/total pair; that's expected, not a discrepancy.

### a) `GET :7798/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/plan`

```json
{
  "chat_id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
  "project": { "id": "8ea0cc08-28d9-4301-9f28-c98e1c5d6838", "status": "active" },
  "link_source": "metadata",
  "link_ambiguous": false,
  ...
}
```

- `link_source: "metadata"` ✓, `link_ambiguous: false` ✓, project `8ea0cc08` ✓ — matches expectation exactly.
- **Phase-block count: 16**, not the briefed "~8". Task total: **66**, done: **51** — the ~60 estimate was close; the phase-block estimate was not. The corpus has grown since that estimate: rounds 1200/1600/1700 are ad-hoc single-task blocks Konrad injected mid-flight ("Phase 6 (injected by Konrad)", "Settings rework... night of 08-05"), and the v3 rework (rounds 300–900) is itself 9 of the 16 blocks. Listing all 16 `round_base` values: 0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1200, 1300, 1400, 1500, 1600, 1700.
- `docs[]` returned **12** entries: `00-vision.md`, `01-requirements.md`, `02-architecture.md`, `03-quality.md`, `04-phases.md`, `10-ui-v3-spec.md`, `11-ui-v3-vision.md`, `12-ui-v3-requirements.md`, `13-ui-v3-architecture.md`, `14-ui-v3-quality.md`, `15-ui-v3-phases.md`, `16-ui-v3-graph-research.md`.
- **`doc_path` is `null` on every single phase block** (checked all 16) — confirms the finding below.

### b) `GET :7798/api/chat/bfd1283a…/plan/doc?name=15-ui-v3-phases.md`

```
HTTP/1.1 200 OK
content-type: text/markdown; charset=utf-8
x-plan-doc: 15-ui-v3-phases.md
```
Body starts: `# 15 — UI v3 Phases (rounds 300–900)` ... — 200, correct content-type, correct doc. ✓

### c) `GET :7798/api/chat/bfd1283a…/plan/doc?name=../../../../etc/passwd`

```
HTTP/1.1 400 Bad Request
{"error":"rejected: name must be a bare file name, got a path: ../../../../etc/passwd","name":"../../../../etc/passwd"}
```
400 with a named rejection reason. ✓

### d) `GET :7798/api/chat?limit=30`

Found the `bfd1283a…` row:

```json
{
  "id": "bfd1283a-b71b-4f35-b577-7d09aad803f2",
  "status": "completed",
  "project_id": "8ea0cc08-28d9-4301-9f28-c98e1c5d6838",
  "project_status": "active",
  "tasks_done": 51,
  "tasks_total": 66
}
```
The row now carries `project_id` / `tasks_done` / `tasks_total` — the U3 rail badge has what it needs. ✓

### e) `GET :7700/api/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838` (live, read-only, allowed)

66 tasks total; status breakdown `{done: 51, pending: 13, running: 2}`.

## 5. Three-way agreement

| source | done | total |
|---|---|---|
| plan endpoint (a), :7798 | 51 | 66 |
| chat rail (d), :7798 | 51 | 66 |
| projects API (e), :7700 live | 51 | 66 |

**Agreement: TRUE.** All three read 51/66 at capture time. 2 tasks were `running` and 13 `pending` per the live projects API — those numbers can move on a re-check; that is expected project churn, not a bug.

## 6. Additional finding — `doc_path` is never populated (design implication)

`matchPhaseDoc` (`routes/chat.ts:797`) links a phase block to a file only when a digit run in the filename equals the block's round number. This corpus is numbered **by document position** (`00-`…`16-`), not by phase round number, so **no phase block anywhere in this project carries `doc_path`** — confirmed above (checked all 16 blocks in the (a) response). This is a corpus-numbering fact, not a bug in a specific phase.

**Design implication for U26 (round 702):** click-through from a phase to its source doc must go through the flat `docs[]` list (12 entries, confirmed above) — a `doc_path`-based direct link will always be `null` for this project and cannot be relied on.

## 7. Operational note — a near-miss with the worktree harness

Before locating it, this round briefly tried to start the worktree API on :7798 via `PORT=7798 npx tsx src/index.ts` — the pattern documented elsewhere in this corpus (03-quality.md) as generically valid for API testing. It is **not** valid on :7798 specifically for this project: `src/index.ts` boots `startCronTick()` / `startTelegramBridge()` / `startVaultSyncTick()` against the live database and the live Telegram bot token (see task `3943ac51…`'s brief, "⚠ THE ONE DANGEROUS MISTAKE IN THIS TASK"). The attempt crashed immediately on `EADDRINUSE` — port 7798 was already held by the correct, safe harness (`scripts/checks/serve-v3-7798.ts`, pid confirmed via `ss -tlnp`, mounting only the relevant routers) left running from an earlier round. No cron/telegram/vault-sync loop from the failed attempt ever bound or ran past the crash (verified: no orphan process, single listener on :7798 throughout). Recorded here as a corpus-wide caution: **on this project, `src/index.ts` must never be started standalone on any port that shares the production database and Telegram token — use the dedicated `serve-*-7798.ts` harness instead.**
