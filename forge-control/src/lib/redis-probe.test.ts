/**
 * Tests for the RESP2 codec and the BullMQ depth interpretation.
 *
 * Run: pnpm test   (`tsx --test src/lib/*.test.ts`)
 *
 * The socket is deliberately NOT tested here — `probeQueueDepths()` is the one
 * impure function in `redis-probe.ts` and is proved against the live redis in
 * `docs/plan/artifacts/os-usable-for-work/phase5/pipeline-api-evidence.md`,
 * both reachable and pointed at a dead port. Everything below runs on captured
 * byte strings.
 *
 * The load-bearing assertions are the ones that separate a real zero from a
 * dead probe: S-C §1 measured `waiting=0`/`active=0` on every live queue, so a
 * CORRECT probe returns zeroes today. `depth: 0` (a counted empty list) and
 * `depth: null` (an absent key) must never collapse into each other, and a
 * redis error must never become either.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  encodeCommand,
  parseReply,
  isRespError,
  parseRedisUrl,
  countCommandForType,
  resolveSetDepth,
  bullKey,
  BULL_SETS,
  CONTENT_FORGE_QUEUES,
  DEFAULT_REDIS_URL,
  type RespValue,
} from "./redis-probe.ts";

const b = (s: string): Buffer => Buffer.from(s, "utf8");

/* ========================================================================== *
 * Encoding
 * ========================================================================== */

describe("encodeCommand", () => {
  test("emits a RESP2 array of bulk strings", () => {
    assert.equal(
      encodeCommand(["TYPE", "bull:queue-ingest:wait"]),
      "*2\r\n$4\r\nTYPE\r\n$22\r\nbull:queue-ingest:wait\r\n",
    );
    assert.equal(encodeCommand(["LLEN", "k"]), "*2\r\n$4\r\nLLEN\r\n$1\r\nk\r\n");
  });

  test("lengths are BYTES, not characters", () => {
    // A multi-byte key would desynchronise the stream if we counted chars.
    const out = encodeCommand(["LLEN", "bull:qué:wait"]);
    assert.match(out, /\$14\r\nbull:qué:wait\r\n$/);
    assert.equal(Buffer.byteLength("bull:qué:wait", "utf8"), 14);
  });

  test("an empty command throws", () => {
    assert.throws(() => encodeCommand([]), /at least one argument/);
  });
});

/* ========================================================================== *
 * Parsing — captured byte strings
 * ========================================================================== */

describe("parseReply", () => {
  test("simple string, integer, bulk string, null bulk", () => {
    assert.deepEqual(parseReply(b("+OK\r\n")), { value: "OK", consumed: 5 });
    assert.deepEqual(parseReply(b(":0\r\n")), { value: 0, consumed: 4 });
    assert.deepEqual(parseReply(b(":47\r\n")), { value: 47, consumed: 5 });
    assert.deepEqual(parseReply(b("$4\r\nzset\r\n")), { value: "zset", consumed: 10 });
    assert.deepEqual(parseReply(b("$-1\r\n")), { value: null, consumed: 5 });
    assert.deepEqual(parseReply(b("$0\r\n\r\n")), { value: "", consumed: 6 });
  });

  test("an error reply is BOXED so it cannot pass as a type name", () => {
    const r = parseReply(b("-WRONGTYPE Operation against a key holding the wrong kind of value\r\n"));
    assert.ok(r);
    assert.ok(isRespError(r.value));
    assert.equal(
      (r.value as { error: string }).error,
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
  });

  test("arrays, including nested and empty", () => {
    assert.deepEqual(parseReply(b("*2\r\n$4\r\nlist\r\n:0\r\n"))?.value, ["list", 0]);
    assert.deepEqual(parseReply(b("*0\r\n"))?.value, []);
    assert.deepEqual(parseReply(b("*-1\r\n"))?.value, null);
    assert.deepEqual(parseReply(b("*2\r\n*1\r\n:1\r\n$4\r\nnone\r\n"))?.value, [[1], "none"]);
  });

  test("a reply split across TCP chunks returns null until complete", () => {
    // The failure this guards is intermittent-under-load and invisible in a
    // test that only ever feeds whole replies.
    const whole = "$4\r\nzset\r\n";
    for (let cut = 1; cut < whole.length; cut++) {
      assert.equal(parseReply(b(whole.slice(0, cut))), null, `truncated at ${cut}`);
    }
    assert.deepEqual(parseReply(b(whole))?.value, "zset");
  });

  test("a truncated ARRAY returns null, not a short array", () => {
    assert.equal(parseReply(b("*3\r\n$4\r\nlist\r\n:0\r\n")), null);
  });

  test("consumed lets a pipeline be walked reply by reply", () => {
    const stream = b("$4\r\nlist\r\n$4\r\nzset\r\n$4\r\nnone\r\n:5\r\n");
    const seen: RespValue[] = [];
    let off = 0;
    for (;;) {
      const r = parseReply(stream, off);
      if (r === null) break;
      seen.push(r.value);
      off += r.consumed;
    }
    assert.deepEqual(seen, ["list", "zset", "none", 5]);
    assert.equal(off, stream.length);
  });

  test("garbage on the wire THROWS rather than decoding to something plausible", () => {
    assert.throws(() => parseReply(b("%2\r\n")), /unknown RESP type byte/);
    assert.throws(() => parseReply(b(":abc\r\n")), /integer reply is not a number/);
    assert.throws(() => parseReply(b("$x\r\n")), /bulk length is not an integer/);
  });

  test("an empty buffer is incomplete, not an error", () => {
    assert.equal(parseReply(b("")), null);
  });
});

/* ========================================================================== *
 * Endpoint parsing
 * ========================================================================== */

describe("parseRedisUrl", () => {
  test("the Content Forge default", () => {
    assert.deepEqual(parseRedisUrl(DEFAULT_REDIS_URL), {
      host: "127.0.0.1",
      port: 6379,
      password: null,
      db: null,
    });
  });

  test("host, port, password and db index", () => {
    assert.deepEqual(parseRedisUrl("redis://:s3cr3t@10.0.0.5:6380/3"), {
      host: "10.0.0.5",
      port: 6380,
      password: "s3cr3t",
      db: 3,
    });
    assert.equal(parseRedisUrl("redis://127.0.0.1").port, 6379);
  });

  test("rediss:// throws instead of silently connecting in the clear", () => {
    assert.throws(() => parseRedisUrl("rediss://127.0.0.1:6379"), /does not implement/);
  });

  test("a non-redis URL or bad port throws", () => {
    assert.throws(() => parseRedisUrl("http://127.0.0.1:6379"), /expected a redis:\/\/ URL/);
    assert.throws(() => parseRedisUrl("127.0.0.1:6379"), /not a URL|expected a redis/);
    assert.throws(() => parseRedisUrl("redis://127.0.0.1:0"), /port out of range/);
  });
});

/* ========================================================================== *
 * BullMQ interpretation — a real zero vs an absent key vs an error
 * ========================================================================== */

describe("countCommandForType", () => {
  test("lists count with LLEN, zsets with ZCARD, everything else not at all", () => {
    assert.equal(countCommandForType("list"), "LLEN");
    assert.equal(countCommandForType("zset"), "ZCARD");
    for (const t of ["none", "hash", "set", "string", "stream"]) {
      assert.equal(countCommandForType(t), null, t);
    }
  });
});

describe("resolveSetDepth", () => {
  test("a counted empty list is depth 0 — a REAL zero", () => {
    // Every live queue reads waiting=0/active=0 (S-C §1). This is what a
    // correct probe returns today, and it must be reported as a number.
    const d = resolveSetDepth("wait", "queue-ingest", "list", 0);
    assert.deepEqual(d, {
      set: "wait",
      key: "bull:queue-ingest:wait",
      redis_type: "list",
      depth: 0,
    });
  });

  test("a zset counts with ZCARD", () => {
    assert.equal(resolveSetDepth("failed", "queue-asset-collection", "zset", 5).depth, 5);
  });

  test("an absent key is depth NULL, never 0", () => {
    // This is the whole rule: `none` and an empty list are different facts.
    const d = resolveSetDepth("paused", "queue-video-stitch", "none", undefined);
    assert.equal(d.depth, null);
    assert.equal(d.redis_type, "none");
  });

  test("an uncountable type is absent too, and keeps its type name", () => {
    const d = resolveSetDepth("wait", "queue-ingest", "hash", undefined);
    assert.equal(d.depth, null);
    assert.equal(d.redis_type, "hash");
  });

  test("a WRONGTYPE error THROWS — it is never swallowed as 0", () => {
    assert.throws(
      () =>
        resolveSetDepth("wait", "queue-ingest", "list", {
          error: "WRONGTYPE Operation against a key holding the wrong kind of value",
        }),
      /LLEN bull:queue-ingest:wait failed: WRONGTYPE/,
    );
  });

  test("an error on TYPE itself THROWS", () => {
    assert.throws(
      () => resolveSetDepth("wait", "queue-ingest", { error: "NOAUTH Authentication required." }, undefined),
      /TYPE bull:queue-ingest:wait failed: NOAUTH/,
    );
  });

  test("a missing or non-integer count reply THROWS", () => {
    assert.throws(() => resolveSetDepth("wait", "q", "list", undefined), /has no reply/);
    assert.throws(() => resolveSetDepth("wait", "q", "list", "0"), /is not an integer/);
    assert.throws(() => resolveSetDepth("wait", "q", 7, undefined), /not a type name/);
  });
});

describe("the probed key set", () => {
  test("keys are bull:<queue>:<set>", () => {
    assert.equal(bullKey("queue-render-heavy", "active"), "bull:queue-render-heavy:active");
  });

  test("the six BullMQ sets are probed", () => {
    assert.deepEqual([...BULL_SETS], ["wait", "active", "delayed", "failed", "completed", "paused"]);
  });

  test("the mainline queue list is named, not the 47 under bull:*", () => {
    // Cross-checked against dispatch-next.ts + QUEUE_NAMES; drama/reactor/
    // tutorial/bundestag lanes are other products and are deliberately absent.
    assert.equal(CONTENT_FORGE_QUEUES.length, 8);
    for (const q of ["queue-ingest", "queue-qms-validation", "queue-render-heavy", "queue-auto-label"]) {
      assert.ok(CONTENT_FORGE_QUEUES.includes(q as (typeof CONTENT_FORGE_QUEUES)[number]), q);
    }
    for (const q of CONTENT_FORGE_QUEUES) {
      assert.doesNotMatch(q, /drama|reactor|tutorial|bundestag/);
    }
  });
});
