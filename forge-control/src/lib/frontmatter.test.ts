/**
 * Tests for the flat frontmatter parser/serialiser (lib/frontmatter.ts).
 * Run: cd forge-control && npm test   (tsx --test, no test framework dep)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  test("parses strings, integers and bare date values", () => {
    const raw = [
      "---",
      "type: idea",
      'idea: "build the thing"',
      "area: business",
      "importance: 7",
      "status: not-started",
      "created: 2026-08-25",
      "author: konrad",
      "source: konrad",
      "---",
      "## Description",
      "body text",
      "",
    ].join("\n");
    const { data, body } = parseFrontmatter(raw, "Thoughts/Ideas/x.md");
    assert.deepEqual(data, {
      type: "idea",
      idea: "build the thing",
      area: "business",
      importance: 7,
      status: "not-started",
      created: "2026-08-25",
      author: "konrad",
      source: "konrad",
    });
    assert.equal(typeof data.importance, "number");
    assert.equal(body, "## Description\nbody text\n");
  });

  test("unescapes a quoted value containing a colon and an escaped quote", () => {
    const raw = '---\nidea: "ship v2: say \\"now\\""\n---\nbody\n';
    const { data } = parseFrontmatter(raw, "x.md");
    assert.equal(data.idea, 'ship v2: say "now"');
  });

  test("missing fields: an absent key is simply absent from data, not an error", () => {
    const raw = "---\nidea: only one field\n---\n";
    const { data } = parseFrontmatter(raw, "x.md");
    assert.equal(data.area, undefined);
    assert.deepEqual(data, { idea: "only one field" });
  });

  test("empty frontmatter block with no body", () => {
    const { data, body } = parseFrontmatter("---\n---\n", "x.md");
    assert.deepEqual(data, {});
    assert.equal(body, "");
  });

  test("malformed: missing opening --- throws naming the path", () => {
    assert.throws(
      () => parseFrontmatter("idea: x\n---\n", "Thoughts/Ideas/broken.md"),
      /open with "---".*Thoughts\/Ideas\/broken\.md/,
    );
  });

  test("malformed: unclosed frontmatter block throws naming the path", () => {
    assert.throws(
      () => parseFrontmatter("---\nidea: x\nno closing fence\n", "Thoughts/Ideas/broken.md"),
      /never closes.*Thoughts\/Ideas\/broken\.md/,
    );
  });

  test("malformed: a line that isn't key: value throws naming the line and path", () => {
    assert.throws(
      () => parseFrontmatter("---\nnot a kv line\n---\n", "notes/x.md"),
      /malformed frontmatter line 2.*notes\/x\.md/,
    );
  });

  test("malformed: unterminated quoted value throws", () => {
    assert.throws(() => parseFrontmatter('---\nidea: "unterminated\n---\n', "x.md"), /unterminated quoted/);
  });

  test("malformed: unescaped quote inside a value throws", () => {
    assert.throws(() => parseFrontmatter('---\nidea: "a "b" c"\n---\n', "x.md"), /unescaped quote/);
  });

  test("malformed: duplicate key throws naming the path", () => {
    assert.throws(
      () => parseFrontmatter("---\narea: business\narea: life\n---\n", "x.md"),
      /duplicate frontmatter key "area".*x\.md/,
    );
  });
});

describe("serializeFrontmatter / round-trip", () => {
  test("round-trips a full idea document byte-for-byte through parse", () => {
    const data = {
      type: "idea",
      idea: 'ship the thing: "v2"',
      area: "business",
      importance: 7,
      status: "not-started",
      created: "2026-08-25",
      author: "konrad",
      source: "konrad",
    };
    const body = "## Description\nsome text\n\n## Why it is genius\nbecause reasons\n";
    const raw = serializeFrontmatter(data, body);
    assert.equal(raw.startsWith("---\n"), true);
    const parsed = parseFrontmatter(raw, "roundtrip.md");
    assert.deepEqual(parsed.data, data);
    assert.equal(parsed.body, body);
  });

  test("quotes an all-digit string so it parses back as a string, not a number", () => {
    const raw = serializeFrontmatter({ source: "2026" }, "");
    const parsed = parseFrontmatter(raw, "x.md");
    assert.equal(parsed.data.source, "2026");
    assert.equal(typeof parsed.data.source, "string");
  });

  test("leaves a safe bare string unquoted", () => {
    const raw = serializeFrontmatter({ status: "not-started" }, "");
    assert.equal(raw, "---\nstatus: not-started\n---\n");
  });

  test("quotes an empty string, not omits it", () => {
    const raw = serializeFrontmatter({ source: "" }, "");
    const parsed = parseFrontmatter(raw, "x.md");
    assert.equal(parsed.data.source, "");
  });

  test("integer values are written bare and round-trip as numbers", () => {
    const raw = serializeFrontmatter({ importance: 10 }, "");
    assert.equal(raw, "---\nimportance: 10\n---\n");
    assert.equal(parseFrontmatter(raw, "x.md").data.importance, 10);
  });

  test("rejects a non-integer number", () => {
    assert.throws(() => serializeFrontmatter({ importance: 7.5 }, ""), /not an integer/);
  });

  test("rejects an invalid key", () => {
    assert.throws(() => serializeFrontmatter({ "bad key": "x" }, ""), /invalid frontmatter key/);
  });

  test("rejects a value containing a newline", () => {
    assert.throws(() => serializeFrontmatter({ idea: "line one\nline two" }, ""), /may not contain a newline/);
  });

  test("preserves insertion order in the output", () => {
    const raw = serializeFrontmatter({ b: "2", a: "1" }, "");
    assert.equal(raw, '---\nb: "2"\na: "1"\n---\n');
  });
});
