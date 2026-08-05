# U7 on :7798 — `requested_by_run_id` exercised against the WORKTREE (round 308)

Round-307 review, finding 2: *"U7 is unreachable through the phase's own harness.
`serve-v3-7798.ts` omits `/api/secrets` from `MOUNTS`, so `curl :7798/api/secrets`
silently proxies to production, which lacks round 303's code. Following brief item 12
literally tests `main`, not the branch."*

Round 308 mounts the router (`serve-v3-7798.ts`, `MOUNTS`) and moves the
pass-through proof to `/api/health`, which no mount claims. This file is the
transcript the finding asked for.

## How to reproduce it

```bash
set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
export SECRET_STORE_DIR=/tmp/u7-store-308      # ← ISOLATE BEFORE ANY WRITE
mkdir -p /tmp/u7-store-308 && chmod 700 /tmp/u7-store-308
cd forge-control && ./node_modules/.bin/tsx ../scripts/checks/serve-v3-7798.ts
```

`SECRET_STORE_DIR` is read once at import time (`lib/secret-store.ts:38`), so it has
to be exported **before** the harness starts. Without it the local router writes to
`/opt/ai-os/.secrets/store` — Konrad's real credentials — and a `mark-pending` would
raise a real "for Konrad" flag in his UI. Read-only capture (`baseline/capture.sh`)
is safe either way; the writes below are not.

## What it proves

| # | case | result |
|---|---|---|
| 0 | the mount is local, not a proxy | isolated store shows 0 secrets, :7700 shows 5 |
| 1 | create | 201, `requestedByRunId: null` on a fresh secret |
| 2 | `mark-pending`, no body | 200, field stays null — absence, not `""` |
| 3 | `mark-pending`, valid uuid | 200, field appears in the listing |
| 4 | invalid uuid | 400, and the supplied value is **not** echoed back |
| 5 | non-string (`12345`) | 400, not coerced |
| 6 | explicit `null` | 200 — treated as "not supplied" |
| 7 | bare call after a value was set | 200, does **not** clobber it |
| 8 | sidecar file | excluded from the listing; the secret VALUE never appears in it |
| 9 | key set vs main | strict superset — exactly `requestedByRunId` added |
| 10 | reveal, then DELETE | pending cleared; every sidecar unlinked with the secret |
| 11 | production store | untouched — no `u7-probe`, same 5 names as before |

## One observation, not a fix

Step 10 shows `requestedByRunId` surviving a reveal (`markCollected` clears the
`.pending` sidecar only), and step 7 shows a bare `mark-pending` leaving an existing
value in place. Together those mean a credential re-flagged later, by a different run
that does not name itself, still displays the *previous* requester. Nobody asked for
this in the round-307 fix list and `secrets.ts` is round 303's shipped code, so round
308 reports it rather than changing it. It is a display-staleness question, not a leak:
no value crosses the wire, and the field is advisory.

---

## Transcript

```
U7 (round 303) — requested_by_run_id on POST /api/secrets/:name/mark-pending
Captured 2026-08-05T17:36:07+02:00 against the WORKTREE router on :7798 (round 308 mounted it;
before that this path silently proxied to :7700 and tested main — review finding 2).
Harness started with SECRET_STORE_DIR=/tmp/u7-store-308, so nothing here touches
Konrad's real store at /opt/ai-os/.secrets/store.

=== 0. the mount is LOCAL now (the whole point of this transcript) ===
$ curl -s :7798/api/secrets | jq -c '.secrets|length'  → isolated store, not production's
0
$ curl -s :7700/api/secrets | jq -c '.secrets|length'  → production, for contrast
5

=== 1. create a secret in the isolated store ===
$ curl -sS -X POST http://127.0.0.1:7798/api/secrets -d '{"name":"u7-probe","value":"SENTINEL-VALUE-DO-NOT-LEAK-308","note":"round 308 U7 probe"}'
{"secret":{"name":"u7-probe","bytes":30,"updatedAt":"2026-08-05T15:36:07.167Z","note":"round 308 U7 probe","pending":false,"requestedByRunId":null}}
<< HTTP 201

=== 2. mark-pending with NO body → 200, and no requestedByRunId key value ===
$ curl -sS -X POST http://127.0.0.1:7798/api/secrets/u7-probe/mark-pending
{"ok":true}
<< HTTP 200
{"name":"u7-probe","pending":true,"requestedByRunId":null}

=== 3. mark-pending with a VALID uuid → the field appears ===
$ curl -sS -X POST http://127.0.0.1:7798/api/secrets/u7-probe/mark-pending -d '{"requested_by_run_id":"3853c154-e07b-4378-9313-2b34f4a33342"}'
{"ok":true}
<< HTTP 200
{"name":"u7-probe","pending":true,"requestedByRunId":"3853c154-e07b-4378-9313-2b34f4a33342"}

=== 4. INVALID uuid → 400, and the supplied value is NOT echoed ===
$ curl -sS -X POST http://127.0.0.1:7798/api/secrets/u7-probe/mark-pending -d '{"requested_by_run_id":"not-a-uuid-CANARY"}'
{"error":"requested_by_run_id must be a valid uuid"}
<< HTTP 400
=== 5. non-string → 400, not coerced ===
{"error":"requested_by_run_id must be a valid uuid"}
<< HTTP 400
=== 6. null → accepted as 'not supplied', 200 ===
{"ok":true}
<< HTTP 200

=== 7. a BARE mark-pending does not clobber a value already recorded ===
{"ok":true}
<< HTTP 200
{"requestedByRunId":"3853c154-e07b-4378-9313-2b34f4a33342"}

=== 8. the sidecar is a real file, excluded from the listing, and the
       SENTINEL value never appears in any list response ===
$ ls -la /tmp/u7-store-308
    total 220
    drwx------   2 root root   4096 Aug  5 17:36 .
    drwxrwxrwt 574 root root 204800 Aug  5 17:36 ..
    -rw-------   1 root root     30 Aug  5 17:36 u7-probe
    -rw-------   1 root root     18 Aug  5 17:36 u7-probe.note
    -rw-------   1 root root      0 Aug  5 17:36 u7-probe.pending
    -rw-------   1 root root     36 Aug  5 17:36 u7-probe.requested-by
$ curl -s http://127.0.0.1:7798/api/secrets | grep -c SENTINEL-VALUE-DO-NOT-LEAK-308   (must be 0)
0
0
$ curl -s http://127.0.0.1:7798/api/secrets | jq -r '.secrets[].name'   (no .requested-by / .pending / .note entries)
    u7-probe
$ curl -s http://127.0.0.1:7798/api/secrets | jq -c '.secrets[0] | keys'
["bytes","name","note","pending","requestedByRunId","updatedAt"]

=== 9. the key set is a strict SUPERSET of main's ===
worktree :7798 →  "bytes,name,note,pending,requestedByRunId,updatedAt"
main     :7700 →  "bytes,name,note,pending,updatedAt"
difference     →  "requestedByRunId"

=== 10. reveal clears pending; DELETE unlinks the sidecar ===
$ curl -sS -X POST http://127.0.0.1:7798/api/secrets/u7-probe/reveal
{"name":"u7-probe","value":"<the value, redacted in this artifact>"}
<< HTTP 200
{"pending":false,"requestedByRunId":"3853c154-e07b-4378-9313-2b34f4a33342"}
$ curl -sS -X DELETE http://127.0.0.1:7798/api/secrets/u7-probe
{"deleted":true}
<< HTTP 200
$ ls -a /tmp/u7-store-308   (every sidecar gone with it)
    .
    ..
$ curl -s http://127.0.0.1:7798/api/secrets | jq -c '.secrets'
[]

=== 11. production's store is untouched by any of the above ===
$ ls /opt/ai-os/.secrets/store | grep -c u7-probe   (must be 0)
0
0
$ curl -s :7700/api/secrets | jq -r '.secrets[].name' | tr '\n' ' '
github-pat-konrad github-pat-shane twenty-api-key twenty-crm-admin twenty-crm-shane 
```
