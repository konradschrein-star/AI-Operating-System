# Round 1876 — one quota row, one Connections surface

Konrad, 2026-08-17: *"Why do we have two indicators and why do we have them? We do not need a
weekly and a 5-hour limit twice, especially refreshing at different intervals."* And: *"the settings
are still a bit confusing, especially with connecting accounts, Claude accounts, like wiring them in
and wiring in Google accounts. I want to be able to do that also."*

## What changed

| Before | After |
| --- | --- |
| `QuotaBars` (status bar) **and** `QuotaStrip` (above the composer) each drew 5h + 7d | One `QuotaRow` in the status bar. `QuotaStrip.tsx` is deleted. |
| Three `useQuery` call sites, two client fetchers (`api.ts:fetchQuota`, `usageApi.ts:fetchUsageQuota`), each restating key + intervals | One module owns the endpoint: `desktop/quota/quotaQuery.ts`. Everyone else calls `useQuotaSnapshot()`. |
| No Gemini anywhere in the row | `gem` item: a self-tally in tokens, or "not signed in". Never a percentage — there is no denominator to divide by. |
| Settings had ACCOUNTS and INTEGRATIONS, neither explaining itself | One CONNECTIONS surface: every account is a row answering *what it is · connected? · which identity · health · the exact action*. |

## Evidence in this directory

`quota-row.cjs` — the browser harness. Stack: this branch's build on `:7798` (`next start`,
rewrites baked at `FORGE_CONTROL_URL=http://127.0.0.1:7799`) against
`scripts/checks/serve-quota-7799.ts`, a stub that **counts** every `/api/usage/quota` request.
Nothing live is touched — not `:7700`, not the database, not a run. `quota-row.json` is the raw
record. 18 assertions, all passing.

The decisive measurement, from `quota-row.json`:

```
one quota request for the whole row on first paint      server saw 1, browser sent 1
opening the settings surface adds no quota request      1 → 1
one poll — not two — in a 135s idle window              1 request; gap 120008 ms
server count and browser count agree                    server=3 browser=3
```

Two observers (the status-bar row and the Connections panel's Ultra row) on one cache entry, one
poll every 120 s. Before this round the same screen carried two independent 120 s timers plus the
settings panel's third.

| Shot | What it shows |
| --- | --- |
| `01-row-no-chat-dark.png` | The row with no chat open: `5h 41% · 7d 12% · gem not signed in · ⟳ just now`. No ctx item — absent, not a false 0%. |
| `02-connections-dark.png` | CONNECTIONS: two Claude logins (one `SERVING RUNS`, one `UNKNOWN — NOT PROBED` in amber), Google Workspace `UNVERIFIED`, the failover policy, and each row's exact connect/repair line. |
| `03-connections-light.png` | Same surface, light palette. |
| `04-row-gemini-counted-dark.png` | The Gemini item in its counted state: `gem 12.4k tok/5h`. |
| `05-row-light.png` | The row in the light palette. |
| `06-row-with-chat-dark.png`, `07-row-with-chat-light.png` | The CHAT surface: still exactly one row, and the composer carries no second copy of the bars. |

## What could NOT be photographed offline, and why

The **ctx item with a live transcript**. The gauge is published by the chat surface, and the stub
cannot render a full transcript: the chat panels throw rather than degrade on a synthetic payload
(deliberately — an empty project and a broken server must not look alike). Three shapes were filled
in (`/chat/:id`, `/plan`, `/team`); a fourth `.total` reader inside the plan kanban still trips the
surface's error boundary, which is what `06`/`07` show in the middle column.

What those shots DO prove is the half this round owns: with the chat surface open there is still
exactly **one** row and **one** `5h` bar on screen. The ctx item's own behaviour is covered by
`check-quota-row.ts` (`the row carries the context gauge`) and by round 1350's ContextGauge
evidence. Photographing it against a real chat belongs to the deploy/verify pass.

## Unit and route checks

- `scripts/checks/check-quota-row.ts` — the single-subscriber rule, asserted against source with
  comments stripped (files may TALK about the endpoint; only one may CALL it). Proven load-bearing:
  a temporary second subscriber fired 4 of its assertions.
- `scripts/checks/check-gemini-tally.ts` — `GET /usage/quota`'s Gemini field against a throwaway
  Postgres (docker) and a stubbed Anthropic: zero rows is a real zero, unmetered rows are
  `tokens: null` (never `0`), an unreadable `spend_log` is `error` (never "nothing"), an Anthropic
  429 does not take the tally down, and a local `agy` profile is reported as a profile — never as a
  proven session, because the session lives in the OS keyring
  (antigravity.google/docs/cli/install).
