# Round 1350 — browser-activity index over /opt/ai-os/uploads (server half)

New: `forge-control/src/lib/uploads-index.ts` (+ `.test.ts`), two GETs in
`forge-control/src/routes/uploads.ts` registered above `/:id/:name`, and
`uploads` mounted in `scripts/checks/serve-v3-7798.ts` (own port 7800 used —
7798/7799 were already held by other concurrent tasks in this shared
worktree; never killed those processes).

`cd forge-control && npx tsc --noEmit && npm test` — clean, 841/841 pass
(including 15 new `uploads-index` tests, suites 163/164).

Harness boot + curl transcript (`SERVE_V3_PORT=7800`):

```
$ curl -s http://127.0.0.1:7800/api/uploads/index | jq '.runs | length, .[0]'
37
{
  "id": "7a0c6432cde4",
  "count": 2,
  "latest_ts": "2026-08-17T03:24:05.924Z"
}

$ curl -s http://127.0.0.1:7800/api/uploads/08e8d160cda1/shots | jq
{
  "id": "08e8d160cda1",
  "shots": [
    {
      "name": "20260805T185524Z-perplexity-bot-wall-parked.png",
      "url": "/api/uploads/08e8d160cda1/20260805T185524Z-perplexity-bot-wall-parked.png",
      "label": "perplexity-bot-wall-parked",
      "ts": "20260805T185524Z",
      "size": 39030,
      "mtime": "2026-08-05T18:55:24.148Z"
    },
    {
      "name": "20260805T185521Z-perplexity-bot-wall.png",
      "url": "/api/uploads/08e8d160cda1/20260805T185521Z-perplexity-bot-wall.png",
      "label": "perplexity-bot-wall",
      "ts": "20260805T185521Z",
      "size": 42377,
      "mtime": "2026-08-05T18:55:21.557Z"
    }
  ]
}

$ curl -si http://127.0.0.1:7800/api/uploads/NOTHEX/shots | head -1
HTTP/1.1 400 Bad Request

$ curl -si http://127.0.0.1:7800/api/uploads/aaaaaaaaaaaa/shots | head -1
HTTP/1.1 404 Not Found

$ curl -sI http://127.0.0.1:7800/api/uploads/08e8d160cda1/20260805T185521Z-perplexity-bot-wall.png | head -3
HTTP/1.1 200 OK
cache-control: private, max-age=86400
content-type: image/png
```

Old serving route and `uploads-serving.test.ts` (R704 regression) untouched
and still pass. `ID_RE` unweakened.
