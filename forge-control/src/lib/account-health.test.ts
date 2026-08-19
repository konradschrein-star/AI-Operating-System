/**
 * Tests for the account health logic.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The two most important tests in this file are:
 *  - "rate-limit strings NEVER classify as auth" — a false auth classification
 *    silently turns health-failover into rate-limit rotation, which is the one
 *    behaviour this system is designed not to have.
 *  - "a freshly-issued credential is healthy" — guards the corrected §5.1.
 *    Claude access tokens expire in ~8h by design; an earlier draft would have
 *    flagged every healthy account as expiring, forever.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCredential,
  effectiveHealth,
  classifyError,
  shouldFailover,
  pickAccount,
  pickFailoverAccount,
  rankAccounts,
  NoHealthyAccountError,
  DEFAULT_UNEXERCISED_MS,
  type CredentialSnapshot,
  type SelectableAccount,
} from "./account-health.ts";

const NOW = Date.parse("2026-08-02T10:30:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function cred(over: Partial<CredentialSnapshot> = {}): CredentialSnapshot {
  return {
    exists: true,
    parseable: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    expiresAt: NOW + 8 * HOUR,
    ...over,
  };
}

function acct(over: Partial<SelectableAccount> = {}): SelectableAccount {
  return {
    slug: "a",
    configDir: "/root/.claude",
    enabled: true,
    health: "healthy",
    priority: 100,
    ...over,
  };
}

/* ========================================================================== *
 * Error classification — safety critical
 * ========================================================================== */

describe("classifyError", () => {
  test("the exact string from the 2026-08-02 outage classifies as auth", () => {
    assert.equal(
      classifyError(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
      "auth",
    );
    assert.equal(
      classifyError(
        "claude-code exit 1: Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
      "auth",
    );
  });

  test("other genuine auth failures classify as auth", () => {
    for (const m of [
      "invalid_grant",
      "invalid-grant returned by token endpoint",
      "401 Unauthorized",
      "Request failed with status 401",
      "authentication failed",
      "Not logged in. Run claude /login",
    ]) {
      assert.equal(classifyError(m), "auth", `expected auth for: ${m}`);
    }
  });

  test("rate-limit strings NEVER classify as auth", () => {
    for (const m of [
      "rate limit exceeded",
      "Rate limit reached for claude-opus",
      "rate_limit_error",
      "429 Too Many Requests",
      "You have hit your usage limit",
      "quota exceeded for this account",
      "Usage limit reached. Resets at 3pm",
    ]) {
      const got = classifyError(m);
      assert.equal(got, "rate_limit", `expected rate_limit for: ${m}`);
      assert.notEqual(got, "auth", `MUST NOT be auth: ${m}`);
      assert.equal(shouldFailover(m), false, `MUST NOT failover on: ${m}`);
    }
  });

  test("ambiguous messages matching BOTH resolve to rate_limit, not auth", () => {
    // A message like this must never trigger an account switch. Rate-limit
    // patterns are checked first precisely so this case is safe.
    const m = "401 Unauthorized: rate limit exceeded for this account";
    assert.equal(classifyError(m), "rate_limit");
    assert.equal(shouldFailover(m), false);
  });

  test("unrecognised errors are 'other' and do not fail over", () => {
    for (const m of [
      "ECONNREFUSED 127.0.0.1:7700",
      "claude-code went idle for 600s",
      "spawn claude ENOENT",
      "",
      null,
      undefined,
    ]) {
      assert.equal(classifyError(m), "other", `expected other for: ${m}`);
      assert.equal(shouldFailover(m), false);
    }
  });
});

/* ========================================================================== *
 * Credential classification
 * ========================================================================== */

describe("classifyCredential", () => {
  test("the 2026-08-02 blanked credential is broken", () => {
    // Literal on-disk shape observed: both tokens 0 bytes, expiresAt 0.
    const v = classifyCredential(
      cred({ hasAccessToken: false, hasRefreshToken: false, expiresAt: 0 }),
      { now: NOW, lastOkAt: NOW - HOUR },
    );
    assert.equal(v.health, "broken");
    assert.match(v.detail, /re-login required/);
  });

  test("a freshly-issued credential expiring in 8 HOURS is healthy", () => {
    // Regression guard for the corrected §5.1. Access tokens are short-lived
    // by design and the refresh token renews them; this must not be flagged.
    const v = classifyCredential(cred({ expiresAt: NOW + 8 * HOUR }), {
      now: NOW,
      lastOkAt: NOW - 60_000,
    });
    assert.equal(v.health, "healthy");
  });

  test("an already-expired access token is still healthy if refresh exists and it is exercised", () => {
    // The CLI refreshes on demand; a past expiresAt is normal between refreshes
    // and says nothing about account health on its own.
    const v = classifyCredential(cred({ expiresAt: NOW - 2 * HOUR }), {
      now: NOW,
      lastOkAt: NOW - 60_000,
    });
    assert.equal(v.health, "healthy");
  });

  test("missing refresh token is broken even when an access token is present", () => {
    const v = classifyCredential(cred({ hasRefreshToken: false }), {
      now: NOW,
      lastOkAt: NOW,
    });
    assert.equal(v.health, "broken");
  });

  test("missing or unparseable files are broken", () => {
    assert.equal(
      classifyCredential(cred({ exists: false }), { now: NOW, lastOkAt: NOW })
        .health,
      "broken",
    );
    assert.equal(
      classifyCredential(cred({ parseable: false }), { now: NOW, lastOkAt: NOW })
        .health,
      "broken",
    );
  });

  test("the June failure: valid-looking credential, unexercised for two months, is UNKNOWN not healthy", () => {
    const v = classifyCredential(cred(), {
      now: NOW,
      lastOkAt: NOW - 60 * DAY,
    });
    assert.equal(v.health, "unknown");
    assert.match(v.detail, /unexercised/);
  });

  test("an account that has never had a successful run is unknown, not healthy", () => {
    const v = classifyCredential(cred(), { now: NOW, lastOkAt: null });
    assert.equal(v.health, "unknown");
    assert.match(v.detail, /never confirmed/);
  });

  test("the unexercised boundary", () => {
    const justInside = classifyCredential(cred(), {
      now: NOW,
      lastOkAt: NOW - (DEFAULT_UNEXERCISED_MS - HOUR),
    });
    assert.equal(justInside.health, "healthy");

    const justOutside = classifyCredential(cred(), {
      now: NOW,
      lastOkAt: NOW - (DEFAULT_UNEXERCISED_MS + HOUR),
    });
    assert.equal(justOutside.health, "unknown");
  });
});

/* ========================================================================== *
 * Probe age — the display invariant (R57)
 *
 * `claude_accounts.health` is a STORED column. `markSuccess()` writes
 * 'healthy' and never touches `last_probed_at`, and rows can be seeded by
 * hand — so the word can precede or outlive any measurement. Reproduced live
 * on 2026-08-18: a row with health='healthy', last_probed_at=NULL rendered
 * CONNECTED in green (docs/plan/artifacts/os-usable-for-work/phase4/
 * b4a-before-connections.png).
 *
 * The whole point is asymmetry — this function DEMOTES and never promotes.
 * Each test below therefore checks the direction, not just the value.
 * ========================================================================== */

describe("effectiveHealth — no positive state without a measurement", () => {
  const stored = (
    over: Partial<Parameters<typeof effectiveHealth>[0]> = {},
  ): Parameters<typeof effectiveHealth>[0] => ({
    health: "healthy",
    detail: "confirmed by a successful run",
    lastProbedAt: NOW - 4 * 60_000,
    ...over,
  });

  test("THE INVARIANT: a stored `healthy` with NO probe renders unknown", () => {
    const e = effectiveHealth(stored({ lastProbedAt: null }), { now: NOW });
    assert.equal(e.health, "unknown");
    assert.equal(e.downgraded, true);
    assert.equal(e.storedHealth, "healthy");
    assert.equal(e.probeAgeMs, null);
    // The detail must SAY why, and must carry the stored word it overrode —
    // a silent demotion is a different lie, not a fix.
    assert.match(e.detail, /never probed/i);
    assert.match(e.detail, /confirmed by a successful run/);
  });

  test("a stored `healthy` probed within the window passes through untouched", () => {
    const e = effectiveHealth(stored({ lastProbedAt: NOW - 4 * 60_000 }), { now: NOW });
    assert.equal(e.health, "healthy");
    assert.equal(e.downgraded, false);
    assert.equal(e.detail, "confirmed by a successful run");
    assert.equal(e.probeAgeMs, 4 * 60_000);
  });

  test("a probe OLDER than the unexercised window demotes to unknown", () => {
    const e = effectiveHealth(
      stored({ lastProbedAt: NOW - (DEFAULT_UNEXERCISED_MS + DAY) }),
      { now: NOW },
    );
    assert.equal(e.health, "unknown");
    assert.equal(e.downgraded, true);
    assert.match(e.detail, /last probed 8 days ago/);
    assert.match(e.detail, /no longer evidence/);
  });

  test("the staleness boundary, both sides of it", () => {
    const justInside = effectiveHealth(
      stored({ lastProbedAt: NOW - (DEFAULT_UNEXERCISED_MS - HOUR) }),
      { now: NOW },
    );
    assert.equal(justInside.health, "healthy");
    assert.equal(justInside.downgraded, false);

    const justOutside = effectiveHealth(
      stored({ lastProbedAt: NOW - (DEFAULT_UNEXERCISED_MS + HOUR) }),
      { now: NOW },
    );
    assert.equal(justOutside.health, "unknown");
    assert.equal(justOutside.downgraded, true);
  });

  test("the window is configurable, and the boundary moves with it", () => {
    const rec = stored({ lastProbedAt: NOW - 2 * HOUR });
    assert.equal(effectiveHealth(rec, { now: NOW, staleAfterMs: 3 * HOUR }).health, "healthy");
    assert.equal(effectiveHealth(rec, { now: NOW, staleAfterMs: HOUR }).health, "unknown");
  });

  test("`broken` is NEVER demoted to unknown, probed or not", () => {
    // `unknown` is the WEAKER statement. Konrad's note — "token expired
    // 2026-06-03; not re-authenticated by choice" — is operator knowledge, and
    // replacing it with "nobody knows" would throw it away. `broken` is also
    // not a positive state, so R57 has nothing to say about it.
    const never = effectiveHealth(
      { health: "broken", detail: "token expired 2026-06-03; unused since.", lastProbedAt: null },
      { now: NOW },
    );
    assert.equal(never.health, "broken");
    assert.equal(never.downgraded, false);
    assert.equal(never.detail, "token expired 2026-06-03; unused since.");

    const ancient = effectiveHealth(
      { health: "broken", detail: "d", lastProbedAt: NOW - 400 * DAY },
      { now: NOW },
    );
    assert.equal(ancient.health, "broken");
    assert.equal(ancient.downgraded, false);
  });

  test("`unknown` stays unknown and is never promoted by a fresh probe", () => {
    const e = effectiveHealth(
      { health: "unknown", detail: "never confirmed working", lastProbedAt: NOW - 1000 },
      { now: NOW },
    );
    assert.equal(e.health, "unknown");
    assert.equal(e.downgraded, false);
  });

  test("it NEVER produces a positive state without a probe age — exhaustive", () => {
    // The property, asserted over the whole input space rather than at the
    // points a hand-written case happens to pick.
    const healths = ["healthy", "broken", "unknown"] as const;
    const ages = [null, 0, HOUR, DEFAULT_UNEXERCISED_MS - 1, DEFAULT_UNEXERCISED_MS + 1, 400 * DAY];
    for (const health of healths) {
      for (const age of ages) {
        const e = effectiveHealth(
          { health, detail: "d", lastProbedAt: age === null ? null : NOW - age },
          { now: NOW },
        );
        if (e.health === "healthy") {
          assert.notEqual(
            e.probeAgeMs,
            null,
            `healthy with no probe age escaped for stored=${health} age=${age}`,
          );
          assert.ok(
            (e.probeAgeMs ?? Infinity) <= DEFAULT_UNEXERCISED_MS,
            `healthy with a stale probe escaped for stored=${health} age=${age}`,
          );
        }
        // And never an upgrade, in any direction.
        assert.ok(
          !(health !== "healthy" && e.health === "healthy"),
          `promoted ${health} to healthy for age=${age}`,
        );
      }
    }
  });

  test("a null detail does not become the string 'null' on screen", () => {
    const e = effectiveHealth({ health: "unknown", detail: null, lastProbedAt: NOW }, { now: NOW });
    assert.equal(e.detail, "");
  });

  test("the demotion message falls back to the health word when detail is null", () => {
    const e = effectiveHealth({ health: "healthy", detail: null, lastProbedAt: null }, { now: NOW });
    assert.match(e.detail, /"healthy"/);
  });
});

/* ========================================================================== *
 * Selection and failover
 * ========================================================================== */

describe("pickAccount", () => {
  test("prefers healthy over unknown regardless of priority", () => {
    const chosen = pickAccount([
      acct({ slug: "unknown-but-top", health: "unknown", priority: 1 }),
      acct({ slug: "healthy-but-low", health: "healthy", priority: 500 }),
    ]);
    assert.equal(chosen.slug, "healthy-but-low");
  });

  test("breaks ties on priority, then slug, deterministically", () => {
    const accounts = [
      acct({ slug: "zulu", priority: 10 }),
      acct({ slug: "alpha", priority: 10 }),
      acct({ slug: "mid", priority: 5 }),
    ];
    assert.equal(pickAccount(accounts).slug, "mid");
    // Same input in a different order must give the same answer.
    assert.equal(pickAccount([...accounts].reverse()).slug, "mid");
    assert.equal(
      rankAccounts(accounts.filter((a) => a.priority === 10))[0]!.slug,
      "alpha",
    );
  });

  test("excludes broken and disabled accounts", () => {
    const chosen = pickAccount([
      acct({ slug: "broken", health: "broken", priority: 1 }),
      acct({ slug: "disabled", enabled: false, priority: 2 }),
      acct({ slug: "ok", priority: 300 }),
    ]);
    assert.equal(chosen.slug, "ok");
  });

  test("selects an unknown account when it is the only option", () => {
    const chosen = pickAccount([acct({ slug: "unproven", health: "unknown" })]);
    assert.equal(chosen.slug, "unproven");
  });

  test("throws a diagnosis naming every account when nothing is usable", () => {
    const accounts = [
      acct({
        slug: "root",
        health: "broken",
        healthDetail: "credentials blanked (no refresh token) — re-login required",
      }),
      acct({ slug: "worker", enabled: false, configDir: "/home/cw/.claude" }),
    ];
    assert.throws(
      () => pickAccount(accounts),
      (err: unknown) => {
        assert.ok(err instanceof NoHealthyAccountError);
        // The message Konrad should have seen on the morning of 2026-08-02,
        // instead of a bare authentication error.
        assert.match(err.diagnosis, /root/);
        assert.match(err.diagnosis, /credentials blanked/);
        assert.match(err.diagnosis, /worker/);
        assert.match(err.diagnosis, /disabled/);
        return true;
      },
    );
  });

  test("throws when there are no accounts at all", () => {
    assert.throws(() => pickAccount([]), NoHealthyAccountError);
  });
});

describe("pickFailoverAccount", () => {
  test("returns the next best account, excluding the one that just failed", () => {
    const next = pickFailoverAccount(
      [
        acct({ slug: "primary", priority: 10 }),
        acct({ slug: "secondary", priority: 20 }),
      ],
      "primary",
    );
    assert.equal(next?.slug, "secondary");
  });

  test("returns null when the failed account was the only one", () => {
    assert.equal(pickFailoverAccount([acct({ slug: "only" })], "only"), null);
  });

  test("returns null when every alternative is broken", () => {
    const next = pickFailoverAccount(
      [
        acct({ slug: "primary" }),
        acct({ slug: "dead", health: "broken" }),
      ],
      "primary",
    );
    assert.equal(next, null);
  });

  test("single-account reality: health-failover has nowhere to go, and that is fine", () => {
    // Konrad chose to run one account. Failover is inert; the monitoring half —
    // which is what would actually have prevented the outage — still works.
    const accounts = [acct({ slug: "arved" })];
    assert.equal(pickAccount(accounts).slug, "arved");
    assert.equal(pickFailoverAccount(accounts, "arved"), null);
  });
});
