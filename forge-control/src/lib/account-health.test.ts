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
