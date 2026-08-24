/**
 * Tests for takeover-ticket.ts — the signed credential guarding a live Chrome.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The secret is set INSIDE the test, never taken from the host, so a box that
 * happens to export TAKEOVER_TICKET_SECRET cannot make these pass or fail.
 *
 * Negative cases are hand-signed here rather than minted: mint deliberately
 * refuses to sign a bad port or profile, so the only way to prove verify
 * rejects one is to forge a correctly-signed ticket carrying it.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  mintTakeoverTicket,
  verifyTakeoverTicket,
  isTakeoverTicketError,
} from "./takeover-ticket.ts";

const TEST_SECRET = "test-takeover-secret-0123456789abcdef"; // 37 chars
const OTHER_SECRET = "a-completely-different-secret-0123456789"; // 39 chars

let savedSecret: string | undefined;

before(() => {
  savedSecret = process.env.TAKEOVER_TICKET_SECRET;
});

beforeEach(() => {
  process.env.TAKEOVER_TICKET_SECRET = TEST_SECRET;
});

after(() => {
  if (savedSecret === undefined) delete process.env.TAKEOVER_TICKET_SECRET;
  else process.env.TAKEOVER_TICKET_SECRET = savedSecret;
});

/** Forges a ticket for arbitrary claims, correctly signed with `secret`. */
function forge(claims: Record<string, unknown>, secret = TEST_SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function decodeClaims(ticket: string): Record<string, unknown> {
  const payloadB64 = ticket.split(".")[0];
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** A well-formed claim set: valid profile, port inside 6900-6959, live expiry. */
function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    rid: "69806709-45f0-4973-9e95-ca1e5ee2ded0",
    prof: "perplexity",
    port: 6941,
    exp: Date.now() + 60_000,
    jti: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("mintTakeoverTicket", () => {
  test("produces exactly two dot-separated base64url segments", () => {
    const ticket = mintTakeoverTicket({
      runId: "run-abc",
      profile: "r704-loginwall",
      port: 6941,
    });
    const segments = ticket.split(".");
    assert.equal(segments.length, 2);
    for (const segment of segments) {
      assert.ok(segment.length > 0, "segment must not be empty");
      assert.match(segment, /^[A-Za-z0-9_-]+$/, `segment ${segment} must be base64url`);
    }
  });

  test("signs the claims it was given, with a default expiry two minutes out", () => {
    const before = Date.now();
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    const after = Date.now();
    const claims = decodeClaims(ticket);

    assert.equal(claims.rid, "run-abc");
    assert.equal(claims.prof, "scratch");
    assert.equal(claims.port, 6900);
    assert.equal(claims.v, 1);
    assert.ok(typeof claims.exp === "number");
    assert.ok(
      (claims.exp as number) >= before + 120_000 && (claims.exp as number) <= after + 120_000,
      `default expiry should be ~120s out, got ${(claims.exp as number) - before}ms`,
    );
  });

  test("honours an explicit ttlMs", () => {
    const before = Date.now();
    const ticket = mintTakeoverTicket({
      runId: "run-abc",
      profile: "scratch",
      port: 6900,
      ttlMs: 5_000,
    });
    const exp = decodeClaims(ticket).exp as number;
    assert.ok(exp >= before + 5_000 && exp <= Date.now() + 5_000, `exp ${exp} not ~5s out`);
  });

  test("jti differs between two mints of identical arguments", () => {
    const args = { runId: "run-abc", profile: "scratch", port: 6900 };
    const a = decodeClaims(mintTakeoverTicket(args)).jti as string;
    const b = decodeClaims(mintTakeoverTicket(args)).jti as string;
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{32}$/, "jti is 16 random bytes as hex");
  });

  test("refuses to sign a port outside the loopback range", () => {
    for (const port of [6899, 6960, 7700, 0, -1, 6941.5]) {
      assert.throws(
        () => mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port }),
        /port/i,
        `port ${port} should not be mintable`,
      );
    }
  });

  test("refuses to sign a profile name it would later reject", () => {
    for (const profile of ["../etc", "Perplexity", "has space", "", "-leading-dash"]) {
      assert.throws(
        () => mintTakeoverTicket({ runId: "run-abc", profile, port: 6900 }),
        /profile/i,
        `profile ${JSON.stringify(profile)} should not be mintable`,
      );
    }
  });

  test("refuses a non-positive ttl", () => {
    assert.throws(
      () => mintTakeoverTicket({ runId: "r", profile: "scratch", port: 6900, ttlMs: 0 }),
      /ttlMs/,
    );
    assert.throws(
      () => mintTakeoverTicket({ runId: "r", profile: "scratch", port: 6900, ttlMs: -1000 }),
      /ttlMs/,
    );
  });
});

describe("verifyTakeoverTicket — the happy path", () => {
  test("round-trips run id, profile and port", () => {
    const ticket = mintTakeoverTicket({
      runId: "69806709-45f0-4973-9e95-ca1e5ee2ded0",
      profile: "r704-loginwall",
      port: 6959,
    });
    const result = verifyTakeoverTicket(ticket);

    assert.ok(!isTakeoverTicketError(result), `expected success, got ${JSON.stringify(result)}`);
    assert.equal(result.runId, "69806709-45f0-4973-9e95-ca1e5ee2ded0");
    assert.equal(result.profile, "r704-loginwall");
    assert.equal(result.port, 6959);
    assert.ok(result.exp > Date.now());
  });

  test("accepts both ends of the loopback port range", () => {
    for (const port of [6900, 6959]) {
      const result = verifyTakeoverTicket(
        mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port }),
      );
      assert.ok(!isTakeoverTicketError(result), `port ${port} should verify`);
      assert.equal(result.port, port);
    }
  });
});

describe("verifyTakeoverTicket — forgery and tampering", () => {
  test("rejects a tampered payload (claims edited, old signature kept)", () => {
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    const [, signature] = ticket.split(".");
    const claims = decodeClaims(ticket);
    claims.port = 7700; // aim the socket at forge-control itself
    const forged = `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;

    const result = verifyTakeoverTicket(forged);
    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_bad_signature");
  });

  test("rejects a tampered signature", () => {
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    const [payload, signature] = ticket.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const result = verifyTakeoverTicket(`${payload}.${flipped}`);

    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_bad_signature");
  });

  test("rejects a signature of the wrong length without throwing", () => {
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    const [payload] = ticket.split(".");
    for (const signature of ["a", "abcdef", `${ticket.split(".")[1]}extra`]) {
      const result = verifyTakeoverTicket(`${payload}.${signature}`);
      assert.ok(isTakeoverTicketError(result));
      assert.equal(result.error, "ticket_bad_signature");
    }
  });

  test("rejects a ticket signed with a different secret", () => {
    const forged = forge(validClaims(), OTHER_SECRET);
    const result = verifyTakeoverTicket(forged);

    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_bad_signature");
  });

  test("a validly-signed control ticket verifies — the forge helper is honest", () => {
    const result = verifyTakeoverTicket(forge(validClaims()));
    assert.ok(!isTakeoverTicketError(result), `control ticket must verify: ${JSON.stringify(result)}`);
    assert.equal(result.profile, "perplexity");
  });
});

describe("verifyTakeoverTicket — claim checks", () => {
  test("rejects an expired ticket", () => {
    const result = verifyTakeoverTicket(forge(validClaims({ exp: Date.now() - 1 })));
    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_expired");
  });

  test("rejects a ticket that expired long ago", () => {
    const result = verifyTakeoverTicket(forge(validClaims({ exp: Date.now() - 600_000 })));
    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_expired");
  });

  test("rejects a non-numeric expiry", () => {
    for (const exp of ["9999999999999", null, undefined, {}, Number.NaN, Infinity]) {
      const result = verifyTakeoverTicket(forge(validClaims({ exp })));
      assert.ok(isTakeoverTicketError(result), `exp ${String(exp)} must be rejected`);
      assert.equal(result.error, "ticket_bad_expiry");
    }
  });

  test("rejects a port outside the loopback allowlist", () => {
    for (const port of [6899, 6960, 22, 5432, 7700, 65535, -6941]) {
      const result = verifyTakeoverTicket(forge(validClaims({ port })));
      assert.ok(isTakeoverTicketError(result), `port ${port} must be rejected`);
      assert.equal(result.error, "ticket_port_out_of_range");
    }
  });

  test("rejects a non-integer or non-numeric port", () => {
    for (const port of [6941.5, "6941", null, undefined]) {
      const result = verifyTakeoverTicket(forge(validClaims({ port })));
      assert.ok(isTakeoverTicketError(result), `port ${String(port)} must be rejected`);
      assert.equal(result.error, "ticket_port_out_of_range");
    }
  });

  test("rejects a bad profile name", () => {
    for (const prof of ["../../etc/passwd", "Perplexity", "has space", "", 42, null, "a".repeat(40)]) {
      const result = verifyTakeoverTicket(forge(validClaims({ prof })));
      assert.ok(isTakeoverTicketError(result), `profile ${String(prof)} must be rejected`);
      assert.equal(result.error, "ticket_bad_profile");
    }
  });

  test("rejects an unknown payload version", () => {
    for (const v of [0, 2, "1", undefined]) {
      const result = verifyTakeoverTicket(forge(validClaims({ v })));
      assert.ok(isTakeoverTicketError(result), `version ${String(v)} must be rejected`);
      assert.equal(result.error, "ticket_bad_version");
    }
  });

  test("rejects a missing run id or jti", () => {
    const noRid = verifyTakeoverTicket(forge(validClaims({ rid: "" })));
    assert.ok(isTakeoverTicketError(noRid));
    assert.equal(noRid.error, "ticket_bad_run_id");

    const noJti = verifyTakeoverTicket(forge(validClaims({ jti: undefined })));
    assert.ok(isTakeoverTicketError(noJti));
    assert.equal(noJti.error, "ticket_bad_jti");
  });

  test("expiry is checked before profile and port", () => {
    // An expired ticket that ALSO carries a bad profile reports expiry — proof
    // the ordering in the brief is the ordering in the code.
    const result = verifyTakeoverTicket(
      forge(validClaims({ exp: Date.now() - 1, prof: "NOT A PROFILE", port: 22 })),
    );
    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_expired");
  });
});

describe("verifyTakeoverTicket — hostile input never throws", () => {
  test("garbage, empty and wrong-segment-count strings return an error object", () => {
    const inputs = [
      "",
      ".",
      "..",
      "a",
      "a.",
      ".b",
      "a.b.c",
      "not-a-ticket",
      "%%%.%%%",
      "aGVsbG8.世界",
      "a".repeat(10_000),
      `${"a".repeat(5_000)}.${"b".repeat(5_000)}`,
      "../../etc/passwd",
      "eyJhIjoxfQ",
    ];
    for (const input of inputs) {
      const result = verifyTakeoverTicket(input);
      assert.ok(
        isTakeoverTicketError(result),
        `input ${JSON.stringify(input.slice(0, 40))} must be rejected, not accepted`,
      );
      assert.ok(result.error.length > 0);
    }
  });

  test("non-string input returns an error object", () => {
    for (const input of [undefined, null, 42, {}, [], true]) {
      const result = verifyTakeoverTicket(input);
      assert.ok(isTakeoverTicketError(result), `input ${String(input)} must be rejected`);
      assert.equal(result.error, "ticket_missing");
    }
  });

  test("a valid payload with an unparseable JSON body is rejected, not thrown", () => {
    const payloadB64 = Buffer.from("{not json", "utf8").toString("base64url");
    const sig = createHmac("sha256", TEST_SECRET).update(payloadB64).digest("base64url");
    const result = verifyTakeoverTicket(`${payloadB64}.${sig}`);

    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_unreadable_payload");
  });

  test("a signed JSON array or scalar payload is rejected, not thrown", () => {
    for (const body of ["[1,2,3]", '"a string"', "null", "7"]) {
      const payloadB64 = Buffer.from(body, "utf8").toString("base64url");
      const sig = createHmac("sha256", TEST_SECRET).update(payloadB64).digest("base64url");
      const result = verifyTakeoverTicket(`${payloadB64}.${sig}`);
      assert.ok(isTakeoverTicketError(result), `payload ${body} must be rejected`);
    }
  });
});

describe("the secret is mandatory and read at call time", () => {
  test("mint throws when the secret is unset", () => {
    delete process.env.TAKEOVER_TICKET_SECRET;
    assert.throws(
      () => mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 }),
      /TAKEOVER_TICKET_SECRET/,
    );
  });

  test("verify throws when the secret is unset", () => {
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    delete process.env.TAKEOVER_TICKET_SECRET;
    assert.throws(() => verifyTakeoverTicket(ticket), /TAKEOVER_TICKET_SECRET/);
  });

  test("verify throws on a missing secret even for garbage input — no unsigned path", () => {
    delete process.env.TAKEOVER_TICKET_SECRET;
    assert.throws(() => verifyTakeoverTicket("garbage"), /TAKEOVER_TICKET_SECRET/);
    assert.throws(() => verifyTakeoverTicket(""), /TAKEOVER_TICKET_SECRET/);
  });

  test("mint and verify both throw on a secret shorter than 32 chars", () => {
    process.env.TAKEOVER_TICKET_SECRET = "a".repeat(31);
    assert.throws(
      () => mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 }),
      /too short/,
    );
    assert.throws(() => verifyTakeoverTicket(forge(validClaims())), /too short/);
  });

  test("a 32-char secret is accepted", () => {
    process.env.TAKEOVER_TICKET_SECRET = "b".repeat(32);
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    const result = verifyTakeoverTicket(ticket);
    assert.ok(!isTakeoverTicketError(result));
  });

  test("rotating the secret between mint and verify invalidates the ticket", () => {
    // Proves the secret is read inside the call, not captured at module load:
    // a ticket minted under one secret must fail under the next.
    const ticket = mintTakeoverTicket({ runId: "run-abc", profile: "scratch", port: 6900 });
    process.env.TAKEOVER_TICKET_SECRET = OTHER_SECRET;
    const result = verifyTakeoverTicket(ticket);

    assert.ok(isTakeoverTicketError(result));
    assert.equal(result.error, "ticket_bad_signature");

    // And back again: the same ticket verifies once the original secret returns.
    process.env.TAKEOVER_TICKET_SECRET = TEST_SECRET;
    assert.ok(!isTakeoverTicketError(verifyTakeoverTicket(ticket)));
  });
});
