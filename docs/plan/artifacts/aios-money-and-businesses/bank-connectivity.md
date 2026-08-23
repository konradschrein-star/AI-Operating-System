# Connecting Konrad's bank accounts — what works, what it costs

Project `aios-money-and-businesses`, round 3 (fix cycle 1). Researched 2026-08-23.
Konrad's stated set: **three Mercury accounts** and **E&G Private Bank**.
Volksbank is explicitly out of scope ("I don't even need that connected").

**Nothing here needs a credential from Konrad in chat.** The integration layer is
built and the UI is honest about being unlinked; the credential step goes through
the OS secrets panel when he chooses to take it.

---

## 1. Mercury (3 accounts) — SOLVED, one secret away

Mercury ships a first-party read-only REST API. No aggregator, no fee, no
screen-scraping.

- **Endpoint:** `GET https://api.mercury.com/api/v1/accounts`
- **Auth:** Bearer token in the `Authorization` header.
- **Read-only tokens exist and are the right choice here** — per Mercury's own
  docs they "can fetch all available data on your Mercury account without
  requiring an IP whitelist", and are recommended when you do not need to
  initiate transactions or manage recipients. That is exactly this use case: the
  OS displays balances and must never be able to move money.
- **Cost:** none. It is part of the Mercury account.

**Status in this repo:** `forge-control/src/lib/mercury.ts` implements the client;
`GET /api/accounts/bank` returns all three accounts with
`status: "unlinked"`, `credential_required: true`,
`secret_name: "MERCURY_API_TOKEN"`. The Money surface renders each as
**"not linked"** with the reason, never as `$0.00`.

**To connect:** put `MERCURY_API_TOKEN` in the secrets panel. Nothing else.
Generate it in Mercury under Settings → API tokens, choosing the **read-only**
scope.

---

## 2. E&G Private Bank (EUR) — no first-party API; three routes, ranked

E&G is a German private bank. There is no public developer API. Under **PSD2**
every EEA bank must expose **AIS** (Account Information Services — read-only
balances and transactions), but only to a licensed AISP. So the practical route
is an aggregator that holds the licence.

### Route A — Enable Banking · RECOMMENDED, free for this exact case

The **free "Restricted Production" tier is limited to accounts you link
yourself** — which is precisely Konrad's situation: one personal account, his
own. Real production data, no cost.

- **Cost:** €0 on Restricted Production. Paid tiers are quote-based; independent
  2026 comparisons put realistic production-tier budgets at **GBP 150–500/month**,
  which this use case does not need.
- **Coverage:** PSD2 AIS across European markets including Germany.
- **Caveat to verify at signup, not from a search result:** that E&G specifically
  appears in their ASPSP list. Private banks are the likeliest gap in any
  aggregator's coverage. Check before building against it.

### Route B — GoCardless Bank Account Data (ex-Nordigen) · NO LONGER AVAILABLE

**This was the obvious answer and it is now closed.** New signups for GoCardless
Bank Account Data are disabled — `bankaccountdata.gocardless.com/new-signups-disabled`
blocks new integrations, and the free 50-connections-per-month tier that made it
the default indie choice is gone for new users. Existing users continue.

> This corrects a stale assumption inside this repo: `mercury.ts` still writes the
> status line *"Open Banking (GoCardless) / Manual entry required"*. GoCardless is
> not an option Konrad can take up today. The string is left as written this round
> because rewording it is a product decision about which provider to name — see
> "Open question" below.

*(The GoCardless signup page itself is behind an Auth0 login wall. It was not
attempted; this rests on two independent secondary sources.)*

### Route C — Manual entry · already implemented, zero dependencies

`getEgBankAccount()` reads `EG_BANK_BALANCE_EUR` from the environment, or an
`eg-bank-balance` secret. Set it and the account flips to `status: "manual"`,
contributes to the treasury total, and is badged as manual rather than live. A
number Konrad types once a month is worth more than a blank tile, and it costs
nothing to run.

---

## 3. Volksbank — out of scope, and that is the right call

Konrad said he does not need it. Were it wanted, it would go through the same
PSD2 aggregator as E&G; the German cooperative banks are well covered by the
major AISPs, so it is a configuration question rather than a build.

---

## Recommendation, in order

1. **Mercury today.** One read-only token in the secrets panel unlocks three of
   the four accounts at zero cost. Highest value per unit of effort by a wide
   margin.
2. **E&G by manual entry this week.** Already built. One number, one secret.
3. **E&G via Enable Banking when it is worth an afternoon.** Free at the tier
   that fits, but it needs an AISP signup, a consent flow, and 90-day consent
   re-authorisation — real work for one account's automation.

## Open question for Konrad

The E&G tile's status string names GoCardless, which no longer accepts signups.
Should it name **Enable Banking** instead, or drop the provider name and simply
say *"manual entry, or connect via an open-banking provider"*? Naming a specific
vendor in the UI is a product decision, so it was left unchanged rather than
guessed at.

## Sources

- [Mercury API — using the access token](https://docs.mercury.com/reference/using-the-access-token)
- [Mercury API — getting started](https://docs.mercury.com/reference/getting-started-with-your-api)
- [Mercury — Full Banking API](https://mercury.com/api)
- [GoCardless Bank Account Data alternatives — signups disabled](https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d)
- [Free & indie open banking APIs, 2026](https://www.openbankingtracker.com/guides/free-open-banking-apis)
- [Best open banking API providers for developers, 2026](https://www.openbankingcompare.com/blog/best-open-banking-api-providers-for-developers-2026)
- [Cheapest open banking APIs for indie builders, 2026](https://dev.to/johnfrandsen/the-cheapest-open-banking-apis-for-small-businesses-and-indie-builders-in-2026-5cab)
- [Enable Banking](https://enablebanking.com/)
- [GoCardless Bank Account Data — coverage overview](https://developer.gocardless.com/bank-account-data/overview)
