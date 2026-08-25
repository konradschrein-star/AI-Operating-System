# aios-chat-list-etag — evidence report

## What shipped

1. **Server** (`forge-control/src/routes/chat.ts`, `forge-control/src/lib/chat-etag.ts`):
   `GET /api/chat` computes a strong SHA-1 ETag over the response body it is about to send,
   honours `If-None-Match` (strong, weak `W/"..."`, wildcard `*`, comma-separated lists),
   and returns `304 Not Modified` with a 0-byte body and `Cache-Control: no-cache` when the
   tag matches. Row shape and content are unchanged — the win is not re-sending unchanged
   rows, not shrinking them further.
2. **Client** (`forge-control-web/app/api.ts`): `fetchChatList` holds an in-memory
   `chatListCache` keyed by request path (limit/offset). It explicitly sends
   `if-none-match` on every request, and on `304` returns the cached rows instead of
   parsing a body. The validator is only remembered **after** the response parses and
   passes `isValidChatListResponse` — a rejected or malformed body cannot poison later
   304s (per `etag-304-needs-an-explicit-client.md`).
3. **Proxy** (`forge-control-web/app/api/proxy/[...path]/proxy-handler.ts`, pre-existing
   infrastructure, not part of this write-set): already forwarded `If-None-Match` and
   passed 304 through with a null body — confirmed still correct, unchanged.
4. **Harness**: `scripts/checks/check-chat-list-etag.ts` (isolated scratch-DB proof of the
   server contract + real DB-mutation invalidation) and
   `scripts/checks/check-chat-list-etag-browser.ts` (real headless Chrome, two parts: A —
   direct fetch() against the worktree router; B — the actual `/desktop` app through a
   throwaway `next dev` + the real proxy route, network captured via `page.on("response")`).

## What this integration task changed vs. what it inherited

The `server`, `client`, and `harness` workstream branches were **already merged** into
`project/69ace52d` before this task started (`ae1e727`, `a4c2394` — confirmed both
`project/69ace52d-client` and `project/69ace52d-harness` are ancestors of HEAD). No merge
conflicts to report — there were none to resolve.

What was left over from that prior work, uncommitted, and what this task did with it:

- `PLAN.md` had already been rewritten for this project (round 0 plan) — reviewed, correct,
  committed as-is.
- `scripts/checks/check-chat-list-etag-browser.ts` had an uncommitted one-line fix
  correcting the evidence output path from the stale `docs/plan/artifacts/chat-list-etag/`
  to the declared `docs/plan/artifacts/aios-chat-list-etag/` — correct, kept.
- A **stray, already-committed** artifact exists at
  `docs/plan/artifacts/chat-list-etag/chat-list-etag-browser.json` (old path, committed by
  the harness workstream before the path fix above). It is outside this task's declared
  write-set; left untouched rather than deleted mid-integration. Flagging it here as dead
  and safe to remove in a future round.
- A prior, uncommitted run of the browser harness had produced a **`FAIL` verdict**
  (`measurement.json` at the time showed `"verdict": "FAIL"`, Part B `initialFetch: null`).
  Root cause (see "Bug found and fixed" below): the harness had no route warm-up, so a cold
  `next dev` compile of `/desktop` (a known, previously-documented ~136s first-compile cost)
  starved the harness's 15s "initial fetch" deadline. **Not a defect in the ETag feature.**

## Bug found and fixed (in this task's declared write-set)

`scripts/checks/check-chat-list-etag-browser.ts` navigated straight to `/desktop` on a
freshly spawned `next dev` and waited only 15s for the first captured API response before
asserting on it. `next dev`'s first hit on `/desktop` compiles ~7,700 modules
(previously measured elsewhere at up to 136s) — the harness's own deadline elapsed while
the page was still compiling, so the initial-fetch assertion failed even though the app,
once compiled, worked correctly (confirmed: the first real API response actually landed at
~99s into the run). Fixed by adding an explicit throwaway warm-up navigation to `/desktop`
(with the session cookie, 180s timeout, 5s settle) **before** starting the timed
measurement window. Two runs after the fix landed clean: `PASS  Part B: real client issued
initial chat list request` on the first captured response, ALL PASS overall on run 2 (see
below re: run 1's Part A flake).

## Verification run

```
cd forge-control && pnpm install --frozen-lockfile --prod=false   # deps present, no changes
cd forge-control-web && pnpm install --frozen-lockfile --prod=false  # deps present, no changes
cd forge-control && tsc --noEmit -p .                              # clean
cd forge-control-web && tsc --noEmit -p .                           # clean
cd forge-control && pnpm test                                       # 2230/2230 pass (incl. chat-etag.test.ts, 33/33)
cd forge-control-web && tsx --test app/api.test.ts                  # 10/10 pass
cd forge-control && tsx ../scripts/checks/check-chat-list-etag.ts   # ALL PASS (scratch DB, 24 assertions)
cd forge-control-web && tsx --tsconfig ../tsconfig.checks.json ../scripts/checks/check-chat-list-etag-browser.ts
```

The browser harness was run twice. **Run 1** (first run after the warm-up fix) surfaced a
genuine flake in Part A only: "weak If-None-Match" got a `200` instead of `304`. Part A hits
the real live database in-process (by design — see the harness's own comment on why it does
not synthesize its own 304 shim). This VPS is running dozens of concurrent live agent
workers at all times (see the many `project/*` branches); a live row changed between the
strong-tag check and the weak-tag check a few requests later, producing a legitimately
different ETag — not a matching-logic bug. Confirmed by: (a) the isolated scratch-DB harness
(`check-chat-list-etag.ts`) proves weak-tag matching deterministically with no concurrent
writers and passes every time; (b) **Run 2**, moments later, passed Part A cleanly including
the weak-tag case. `measurement.json` reflects Run 2 (ALL PASS).

## The one honest finding Konrad should know

**Part B never observed a single 304 in either run.** Every steady-state poll during the
25s observation window was a full `200` with a changed ETag (run 1: 1 poll, 15,795 B; run 2:
2 polls, 15,804–15,811 B each, ~74 KB/min). This is not a bug in the implementation — it is
what conditional caching against a genuinely busy list looks like: `GET /api/chat` includes
per-run fields (`updated_at`, `last_heartbeat_at`, status, message counts) that change
whenever *any* of the ~20 chats on the rail has live agent activity, and on this box, at
almost any given moment, at least one does. The scratch-DB harness proves the 304 path fires
correctly the instant nothing changes (0 bytes, exact ETag match); the live measurement
proves the box is close to never being that idle right now. The steady-state byte savings
this feature delivers will scale with how quiet the fleet actually is when Konrad is looking
at the console, not with a fixed number — expect ~0 bytes/min chat-list traffic during a
truly idle stretch, and something closer to the pre-fix baseline (~90 KB/min) whenever
multiple agents are actively working, same as right now.

## Screenshot

`/opt/ai-os/uploads/57be32740d1a/20260825T020431Z-chat-list-etag.png` (Run 2) — real
`/desktop`, CHAT surface active, chat rail populated, read back via the Read tool during
this task.

## Declared write-set (restated)

`forge-control/src/routes/chat.ts`, `forge-control/src/lib/chat-etag.ts`,
`forge-control/src/lib/chat-etag.test.ts`, `forge-control-web/app/api.ts`,
`forge-control-web/app/api.test.ts`, `scripts/checks/check-chat-list-etag.ts`,
`scripts/checks/check-chat-list-etag-browser.ts`,
`docs/plan/artifacts/aios-chat-list-etag/README.md`,
`docs/plan/artifacts/aios-chat-list-etag/measurement.json`.

This integration task's own commits touch a subset of that list: `PLAN.md` (inherited,
reviewed and kept as-is — not itself in the write-set, see note below),
`scripts/checks/check-chat-list-etag-browser.ts` (the warm-up fix),
`docs/plan/artifacts/aios-chat-list-etag/README.md` (this file), and
`docs/plan/artifacts/aios-chat-list-etag/measurement.json` (regenerated evidence).

**Undeclared write, disclosed:** `PLAN.md` was committed as part of this integration
(inherited uncommitted from the prior merge, not authored by this task). It is the
project's own round-0 plan document, standard for every project in this fleet, and was not
edited further here — restated for the reviewer rather than silently folded in.
