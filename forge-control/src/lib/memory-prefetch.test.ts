/**
 * Tests for the `[MEMORY]` prefetch composer (audit §4.E of
 * `rework-2026-08-04/03-rag-audit.md`).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Only the pure parts are exercised here — query construction and block
 * composition. `prefetchMemoryForUserTurn()` itself needs the embed sidecar
 * and Postgres, and is verified end-to-end against the live service instead.
 *
 * The load-bearing tests:
 *  - "a control turn produces no query at all" — the audit's "restart X" /
 *    "yes" / "continue" case, which used to prefetch whatever the fragment
 *    happened to embed near.
 *  - "the block never exceeds its budget" — the block is prepended to every
 *    single turn; an overrun is a permanent tax on the context window.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  stripFillers,
  isControlTurn,
  runningTopic,
  buildPrefetchQuery,
  composeMemoryBlock,
  lastUserText,
  type ThreadTurn,
} from "./memory-prefetch.ts";
import type { SearchHitWithLane } from "../db/memory.ts";

function hit(over: Partial<SearchHitWithLane> = {}): SearchHitWithLane {
  return {
    slug: "Mentor/Profile/About Me",
    vault_path: "Mentor/Profile/About Me.md",
    title: "About Me",
    snippet: "x".repeat(400),
    score: 0.72,
    chunk_index: 0,
    note_kind: "profile",
    via: "vector",
    hop: 0,
    ...over,
  };
}

describe("stripFillers", () => {
  test("greetings and request wrappers come off the head only", () => {
    assert.equal(stripFillers("Hey, can you check the reelforge pipeline"), "check the reelforge pipeline");
    assert.equal(stripFillers("ok so what did we decide about Cyprus"), "what did we decide about Cyprus");
    // A filler word inside the sentence is content, not scaffolding.
    assert.equal(
      stripFillers("write the thanks page copy"),
      "write the thanks page copy",
    );
  });

  test("a message that is only filler collapses to empty", () => {
    assert.equal(stripFillers("hey hi thanks"), "");
  });
});

describe("isControlTurn", () => {
  test("acknowledgements and bare commands carry no topical content", () => {
    for (const s of ["yes", "continue", "do it", "go ahead", "retry", "ok", "👍", "restart forge-control", "pm2 restart knowledge-indexer-watch", "deploy"]) {
      assert.equal(isControlTurn(s), true, `expected control turn: "${s}"`);
    }
  });

  test("a generic imperative that carries a topic is NOT a control turn", () => {
    // The ops-verb list is deliberately narrow: these read as instructions but
    // each names something the vault knows about, so they must retrieve.
    for (const s of [
      "check the Cyprus relocation tax numbers",
      "check the reelforge pipeline",
      "run through the Jersey accountants script with me",
      "test the Axtrelis pricing tiers against what Shane proposed",
    ]) {
      assert.equal(isControlTurn(s), false, `expected retrievable turn: "${s}"`);
    }
  });

  test("compound acknowledgements are control turns too", () => {
    for (const s of ["yes, do it", "ok go ahead", "sure — continue", "thanks, next"]) {
      assert.equal(isControlTurn(s), true, `expected control turn: "${s}"`);
    }
  });

  test("an acknowledgement followed by real content is NOT a control turn", () => {
    assert.equal(isControlTurn("yes, and what about the Cyprus relocation plan"), false);
    assert.equal(isControlTurn("great, now compare that with the Jersey script"), false);
  });

  test("a command with a real explanation is NOT a control turn", () => {
    assert.equal(
      isControlTurn(
        "restart the indexer because the sidecar keeps dropping BGE-M3 embeddings mid-pass",
      ),
      false,
    );
    assert.equal(isControlTurn("what did we decide about Cyprus"), false);
  });
});

describe("buildPrefetchQuery", () => {
  const thread: ThreadTurn[] = [
    { role: "user", content: "How should we price the Axtrelis tiers for German SMEs?" },
    { role: "assistant", content: "Three tiers. Starter at 1,900 EUR covers a five-page site. Growth adds SEO." },
  ];

  test("a substantive turn is embedded on its own, stripped of scaffolding", () => {
    const plan = buildPrefetchQuery([
      ...thread,
      { role: "user", content: "Hey, could you compare that with the Jersey accountants script?" },
    ]);
    assert.equal(plan.query, "compare that with the Jersey accountants script?");
    assert.equal(plan.reason, "user turn");
  });

  test("a control turn produces no query at all", () => {
    const plan = buildPrefetchQuery([...thread, { role: "user", content: "yes, do it" }]);
    assert.equal(plan.query, null);
    assert.match(plan.reason, /control turn/);
  });

  test("a thin turn is augmented with the thread's running topic", () => {
    const plan = buildPrefetchQuery([...thread, { role: "user", content: "and the second one?" }]);
    assert.ok(plan.query, "expected a query");
    assert.match(plan.query, /^and the second one\?/);
    assert.match(plan.query, /Axtrelis tiers/, "prior user turn must be carried in");
    assert.match(plan.query, /Starter at 1,900 EUR/, "assistant context must be carried in");
    assert.equal(plan.reason, "thin user turn augmented with thread topic");
  });

  test("a thin turn with no usable history is skipped rather than guessed at", () => {
    const plan = buildPrefetchQuery([{ role: "user", content: "hm?" }]);
    assert.equal(plan.query, null);
  });

  test("an empty thread is skipped", () => {
    assert.equal(buildPrefetchQuery([]).query, null);
  });
});

describe("runningTopic", () => {
  test("the turn being prefetched for is excluded from its own context", () => {
    const topic = runningTopic([
      { role: "user", content: "What is the Twenty CRM plan?" },
      { role: "assistant", content: "Adopt Twenty as a satellite." },
      { role: "user", content: "do it" },
    ]);
    assert.match(topic, /Twenty CRM plan/);
    assert.doesNotMatch(topic, /do it/);
  });

  test("intervening control turns are skipped when looking for the topic", () => {
    const topic = runningTopic([
      { role: "user", content: "Explain the stealth uploader state machine." },
      { role: "assistant", content: "It has five states." },
      { role: "user", content: "ok" },
      { role: "assistant", content: "Anything else?" },
      { role: "user", content: "go on" },
    ]);
    assert.match(topic, /stealth uploader/);
  });
});

describe("composeMemoryBlock", () => {
  test("no hits means no block — never an empty [MEMORY] shell", () => {
    assert.equal(composeMemoryBlock([]), null);
  });

  test("the block never exceeds its budget", () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      hit({
        vault_path: `AI OS/Specs/Note ${i}.md`,
        title: `Note ${i}`,
        chunk_index: i,
      }),
    );
    const c = composeMemoryBlock(hits);
    assert.ok(c);
    assert.ok(c.block.length <= 1400, `block was ${c.block.length} chars`);
  });

  test("every entry carries title, path, note type and a score", () => {
    const c = composeMemoryBlock([hit()]);
    assert.ok(c);
    assert.match(c.block, /About Me — Mentor\/Profile\/About Me\.md · profile · /);
    assert.match(c.block, /\(0\.72\)/);
  });

  test("more hits means shorter snippets, not a truncated tail", () => {
    const one = composeMemoryBlock([hit()]);
    const five = composeMemoryBlock(
      Array.from({ length: 5 }, (_, i) =>
        hit({ vault_path: `AI OS/Specs/Note ${i}.md`, chunk_index: i }),
      ),
    );
    assert.ok(one && five);
    assert.equal(
      (five.block.match(/^- /gm) ?? []).length,
      5,
      "all five hits must appear",
    );
    assert.equal(five.used.length, 5);
    assert.ok(one.block.length <= 1400);
  });

  test("one long header does not evict the hits behind it", () => {
    // The measured regression: a 146-char header on hit #2 made the greedy
    // allocator break out of the loop and render one entry out of five.
    const hits = [
      hit({ vault_path: "Mentor/Profile/About Me.md", title: "About Me" }),
      hit({
        vault_path: "AI OS/Specs/Directory + Business Plan Hub — Business Model.md",
        title: "Directory + Business Plan Hub — Business Model",
        note_kind: "spec",
        chunk_index: 1,
      }),
      hit({ vault_path: "Mentor/PERSONA.md", title: "PERSONA", chunk_index: 2 }),
      hit({
        vault_path: "90_AI_OS/Konrad Projects Overview.md",
        title: "Konrad Projects Overview",
        note_kind: "note",
        chunk_index: 3,
      }),
      hit({
        vault_path: "AI OS/Specs/CRM Integration Plan (Twenty).md",
        title: "CRM Integration Plan (Twenty)",
        note_kind: "spec",
        chunk_index: 4,
      }),
    ];
    const c = composeMemoryBlock(hits);
    assert.ok(c);
    assert.equal(c.used.length, 5, "all five must be seated");
    assert.ok(c.block.length <= 1400);
  });

  test("hits that cannot be seated are reported as unused, not silently dropped", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      hit({ vault_path: `AI OS/Specs/Long Note Title Number ${i}.md`, chunk_index: i }),
    );
    const c = composeMemoryBlock(many);
    assert.ok(c);
    assert.ok(c.used.length < many.length);
    assert.equal((c.block.match(/^- /gm) ?? []).length, c.used.length);
    assert.ok(c.block.length <= 1400);
  });
});

describe("lastUserText", () => {
  test("returns the most recent user turn, ignoring assistant turns", () => {
    assert.equal(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
      "second",
    );
    assert.equal(lastUserText([{ role: "assistant", content: "x" }]), null);
  });
});
