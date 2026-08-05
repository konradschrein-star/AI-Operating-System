# Phase 300 — post-extraction transcript (round 302)

The same eight endpoints as `../baseline/`, captured from the same harness on
`:7798`, **after** `agents-shared.ts` was extracted from `routes/agents.ts`.
Committed so the reviewer can diff without re-running anything:

```bash
scripts/checks/api-diff.sh --current docs/plan/artifacts/phase300/after-302
```

| | |
|---|---|
| Captured at | 2026-08-05 14:00:57Z |
| Branch | `project/8ea0cc08`, round-302 working tree |
| Source | `http://127.0.0.1:7798` (worktree routers, booted 13:59:14Z — after both edits) |
| Baseline compared against | `../baseline/` (captured 13:05Z, pre-change) |

## Verdict

**The gate passes.** `/api/agents`, `/api/agents?project_id=…` and
`/api/agents/<id>` are key-set identical and normalized-value byte-equal to the
pre-change baseline, on two runs 71 s apart:

```
                          run 1 (13:59:34Z)   run 2 (14:00:45Z)
agents                    ok                  ok
agents-project            ok                  ok
agents-run                ok                  ok
projects / -managers      ok                  ok
secrets                   ok                  ok
chat-list                 FAIL                FAIL   ← not this round's doing, see below
chat-thread               FAIL                FAIL   ← not this round's doing, see below
```

Raw output: `apidiff-run1.txt`, `apidiff-run2.txt`.

## The strongest single piece of evidence

`agents-run.json` is the pinned **settled** architect run `3853c154…`. Zero
normalization applies to it — every field, `elapsed_ms` included, is compared
raw. It is byte-identical before and after the extraction, and again 27 s later:

```
f8711a7de90d6051  ../baseline/agents-run.json      (pre-change, 13:05Z)
f8711a7de90d6051  ./agents-run.json                (post-change, 14:00:57Z)
f8711a7de90d6051  /tmp/freeze-t2/agents-run.json   (post-change, 14:01:24Z)
```

Across the whole feed, the 48 settled rows present in **both** the baseline and
this capture differ in nothing:

```
$ jq '... {id, elapsed_ms, settled_at, status} ...'   → {"common": 48, "differing": []}
```

Row *membership* moved (58 settled rows → 57): runs age past the 24 h window and
new ones start. That is the world, and `api-diff.sh` prints it under REAL-WORLD
DRIFT rather than failing on it.

## Why `chat-list` and `chat-thread` fail, and why it is not round 302

Round 302 touched two files, both under `forge-control/src/routes/`:
`agents.ts` and the new `agents-shared.ts`. `chat.ts` was not opened.

The proof is measured, not asserted. Production `:7700` runs `main` — it has no
`agents-shared.ts` and not even phases 1–2 — and it fails the same two endpoints
the same way:

```bash
$ API_BASE=http://127.0.0.1:7700 ../baseline/capture.sh /tmp/main-ref-302
$ scripts/checks/api-diff.sh --current /tmp/main-ref-302
FAIL  chat-list      FAIL  chat-thread          ← identical failures, code without my change
```

And comparing the two live servers directly — worktree vs main, both captured at
14:00Z — the chat endpoints agree exactly:

```bash
$ scripts/checks/api-diff.sh --baseline /tmp/main-ref-302 --current /tmp/wt-302
ok    chat-list — key set identical, normalized values byte-equal
ok    chat-thread — key set identical, normalized values byte-equal
```

(Full output: `apidiff-mainref.txt`, `apidiff-wt-vs-main.txt`. The `agents-*`
FAILs in those two files are the *expected* worktree-vs-main delta the baseline
README documents: purely additive, `+agent_kind +cron_name +project_id +role
+settled +settled_at`, nothing removed or renamed — which is itself evidence the
extraction dropped nothing.)

### The actual cause — a baseline assumption that did not hold

`chat-thread` pins `bfd1283a…`, the operator chat that is **this very session**.
Round 301 captured it while `status = "completed"` and reasoned, reasonably,
that a settled chat is frozen history needing no normalization. It is not:
Konrad sent another message at 13:56Z, the run resumed and completed again.

Between the two captures that chat gained 40 messages (314 → 354), $5.52 of
spend, and three thread `meta` keys that only newer entries carry
(`blocked_by`, `rule_label`, `trip_id`). `chat-list` fails for the same reason —
the same chat's row carries the new `message_count`, `spent_usd` and preview.

**A completed operator chat is resumable, so "completed" is not "immutable."**

Per the round-302 brief this was NOT fixed by editing the baseline or by
widening normalization — either would have destroyed the gate's meaning. It is
recorded here instead.

### What rounds 303–307 should do about it

Nothing, for `/api/agents`: that half of the transcript is sound and is what
302's gate rested on.

For the chat endpoints, a round that actually changes `chat.ts` (304/305/306)
cannot use `../baseline/chat-*.json` as-is. Two options, in order of preference:

1. **Compare against `:7700` instead of the stale file** — `main`'s `chat.ts` is
   the true reference and it is running:
   `API_BASE=http://127.0.0.1:7700 ../baseline/capture.sh /tmp/main-ref &&
   scripts/checks/api-diff.sh --baseline /tmp/main-ref --current <your capture>`.
   Both captures are then minutes apart instead of hours, and the drift shrinks
   to what normalization already covers.
2. **Re-pin the chat fixture** to a genuinely dead chat (one whose run will never
   be resumed) and re-capture only `chat-list.json` / `chat-thread.json`. If you
   do this, say so in your artifacts — a silently re-captured baseline is
   indistinguishable from a covered-up regression.

The deploy phase must re-capture the whole baseline anyway after `merge main`
(baseline README, consequence #2).

## Note for whoever re-runs this

`:7798` does not hot-reload. A harness left running from an earlier round serves
that round's modules, and `api-diff.sh` will report a green that means nothing.
Round 302 hit exactly this: the round-301 harness (pid 1410195, started 15:11
local) still held the port. Check before trusting a result:

```bash
ss -lptn 'sport = :7798'          # is anything listening?
ps -o lstart= -p <pid>            # started AFTER your last edit?
```
