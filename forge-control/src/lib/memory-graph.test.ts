/**
 * Tests for the wikilink graph that feeds GET /api/memory/graph
 * (buildWikilinkGraph + normaliseWikilinkTarget, db/memory.ts).
 *
 * Run: pnpm test   (forge-control/package.json:12 is
 * `tsx --test src/lib/*.test.ts` — a test anywhere else is never run by the
 * gate, and a green tick from one means nothing).
 *
 * HERMETIC BY CONSTRUCTION. buildWikilinkGraph() is pure: it takes the
 * knowledge_note rows and returns the response. Nothing here opens a database,
 * reads the vault or looks at a clock — `measuredAt` is passed in so even the
 * timestamp is pinned. Importing db/memory.ts does construct its two pg Pools,
 * but pg connects lazily and no query is issued from this file.
 *
 * THE GOVERNING RULE (03-quality.md §2.1): every assertion is flipped across
 * its boundary in BOTH directions. `empty_reason` is the sharp case — a test
 * that only checked "it is non-null when the graph is empty" would pass just as
 * happily against a function that returned the same sentence forever, so the
 * non-empty direction (`empty_reason === null`) is asserted too. Same for
 * resolution: a resolvable link and a DANGLING one are both asserted, because
 * "resolved is true here" survives a builder that hardcodes true.
 *
 * NO CONSTANT IS IMPORTED FROM THE MODULE UNDER TEST INTO AN ASSERTION. The
 * note cap, the literal "knowledge_note.links" and the link ceiling are all
 * pinned as literals below: an assertion that reads its expected value out of
 * the subject passes at every value the subject could hold.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildWikilinkGraph,
  normaliseWikilinkTarget,
  type WikilinkNoteRow,
  type WikilinkGraph,
  type WikilinkNode,
} from "../db/memory.ts";

const MEASURED_AT = "2026-08-19T09:00:00.000Z";

function build(
  rows: WikilinkNoteRow[],
  maxLinks?: number,
): WikilinkGraph {
  return buildWikilinkGraph(rows, { measuredAt: MEASURED_AT, maxLinks });
}

function note(
  vault_path: string,
  topic: string,
  links: string[] | null = null,
): WikilinkNoteRow {
  return { vault_path, topic, links };
}

function nodeById(g: WikilinkGraph, id: string): WikilinkNode {
  const n = g.nodes.find((x) => x.id === id);
  assert.ok(
    n,
    `expected a node with id ${JSON.stringify(id)}; got ${JSON.stringify(
      g.nodes.map((x) => x.id),
    )}`,
  );
  return n;
}

/**
 * The corpus every resolution test runs against. Three real notes, and the
 * shapes below are lifted from the live vault rather than invented:
 *
 *  - "AI OS/Home.md" links out by TITLE, the ordinary case.
 *  - "90_AI_OS/Spec - Personal AI OS Interface.md" is the near-miss target: a
 *    dangling link differs from it by ONE WORD, not by being nonsense.
 *  - "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent.md" is only ever
 *    linked PATH-QUALIFIED, which is how that folder actually writes it.
 */
function corpus(): WikilinkNoteRow[] {
  return [
    note("AI OS/Home.md", "Home", [
      "Spec - Personal AI OS Interface",
      "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent",
      // ADVERSARIAL: one word off "Spec - Personal AI OS Interface". A
      // substring check, a fuzzy match or a "close enough" resolver would
      // silently swallow this and the graph would under-report a note Konrad
      // has not written yet.
      "Spec - Personal AI OS Interfaces",
    ]),
    note("90_AI_OS/Spec - Personal AI OS Interface.md", "Spec - Personal AI OS Interface", null),
    note(
      "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent.md",
      "System - OpenClaw AI Agent",
      null,
    ),
  ];
}

describe("normaliseWikilinkTarget", () => {
  test("lowercases and trims", () => {
    assert.equal(normaliseWikilinkTarget("  Home  "), "home");
  });

  test("drops a heading anchor, keeping the note before it", () => {
    assert.equal(
      normaliseWikilinkTarget("System - Software Stack#AI Services (LLMs)"),
      "system - software stack",
    );
    // …and the boundary the other way: no anchor means nothing is cut.
    assert.equal(
      normaliseWikilinkTarget("System - Software Stack"),
      "system - software stack",
    );
  });

  test("a bare #anchor normalises to the empty string", () => {
    assert.equal(normaliseWikilinkTarget("#6.4 Knowledge Management System"), "");
  });

  test("strips the trailing backslash a markdown-table alias leaves behind", () => {
    // Live vault, Master Brief - Full Operation Overview.md:200 —
    // `[[System - Remotion Rendering Pipeline\|Remotion]]`, where the escape
    // stops the pipe being read as a table cell separator. WIKILINK_RE keeps
    // the backslash in the captured target.
    assert.equal(
      normaliseWikilinkTarget("System - Remotion Rendering Pipeline\\"),
      "system - remotion rendering pipeline",
    );
    // Flipped: a backslash in the MIDDLE is content, not an escape artefact.
    assert.equal(normaliseWikilinkTarget("a\\b"), "a\\b");
  });
});

describe("buildWikilinkGraph — provenance", () => {
  test('source is exactly "knowledge_note.links"', () => {
    // R33 asserts this literal. Pinned here, never read from the subject.
    assert.equal(build(corpus()).source, "knowledge_note.links");
    // …and it does not change when the graph is empty.
    assert.equal(build([]).source, "knowledge_note.links");
  });

  test("measured_at is echoed, not invented", () => {
    assert.equal(build(corpus()).measured_at, MEASURED_AT);
  });
});

describe("buildWikilinkGraph — resolution (R34)", () => {
  test("a resolvable wikilink yields resolved:true and the real vault_path", () => {
    const g = build(corpus());
    const spec = nodeById(g, "90_ai_os/spec - personal ai os interface");
    assert.equal(spec.resolved, true);
    assert.equal(spec.vault_path, "90_AI_OS/Spec - Personal AI OS Interface.md");
    assert.equal(spec.label, "Spec - Personal AI OS Interface");
  });

  test("a path-qualified wikilink resolves through the full slug", () => {
    const g = build(corpus());
    const openclaw = nodeById(
      g,
      "30_youtube/plan for youtube/system - openclaw ai agent",
    );
    assert.equal(openclaw.resolved, true);
    assert.equal(
      openclaw.vault_path,
      "30_YouTube/Plan for YouTube/System - OpenClaw AI Agent.md",
    );
  });

  test("a DANGLING near-miss is PRESENT as a node, resolved:false, vault_path:null", () => {
    const g = build(corpus());
    // The whole point of R34: it is one character from a note that exists, and
    // it must survive as its own node rather than being folded into that note
    // or dropped.
    const dangling = nodeById(g, "spec - personal ai os interfaces");
    assert.equal(dangling.resolved, false);
    assert.equal(dangling.vault_path, null);
    assert.equal(dangling.label, "Spec - Personal AI OS Interfaces");
    // It did NOT collapse into the real note.
    assert.notEqual(dangling.id, "90_ai_os/spec - personal ai os interface");
    // And an edge really points at it.
    assert.ok(
      g.links.some(
        (l) => l.target === "spec - personal ai os interfaces" && l.source === "ai os/home",
      ),
      `expected an edge into the dangling node; got ${JSON.stringify(g.links)}`,
    );
  });

  test("unresolved_targets counts exactly the resolved:false nodes", () => {
    const g = build(corpus());
    assert.equal(g.counts.unresolved_targets, 1);
    assert.equal(
      g.counts.unresolved_targets,
      g.nodes.filter((n) => !n.resolved).length,
    );

    // Flipped across the boundary: give the dangling target a real note and
    // the count must fall to 0, with the SAME link set.
    const withNote = corpus();
    withNote.push(
      note(
        "90_AI_OS/Spec - Personal AI OS Interfaces.md",
        "Spec - Personal AI OS Interfaces",
        null,
      ),
    );
    const g2 = build(withNote);
    assert.equal(g2.counts.unresolved_targets, 0);
    assert.equal(g2.links.length, g.links.length);
  });

  test("resolution by topic wins over an unrelated file of the same basename", () => {
    // Precedence is slug → topic → basename. A link written as the TITLE must
    // find the note whose title it is.
    const rows = [
      note("Inbox/scratch.md", "Scratch", ["Core Business Thesis"]),
      note("30_YouTube/thesis.md", "Core Business Thesis", null),
    ];
    const g = build(rows);
    const hit = nodeById(g, "30_youtube/thesis");
    assert.equal(hit.resolved, true);
    assert.equal(hit.vault_path, "30_YouTube/thesis.md");
  });
});

describe("buildWikilinkGraph — self-links (R34: dropped links are COUNTED)", () => {
  test("a self-link is counted and does NOT appear in links", () => {
    const rows = [
      note("AI OS/Home.md", "Home", [
        // by its own title
        "Home",
        // by its own path
        "AI OS/Home",
        // a bare anchor into its own body
        "#Projects",
        // one genuine outbound link, so the graph is not empty
        "Vault Guide",
      ]),
    ];
    const g = build(rows);
    assert.equal(g.counts.self_links_dropped, 3);
    assert.equal(
      g.links.filter((l) => l.source === l.target).length,
      0,
      "a self-link must never be rendered",
    );
    assert.equal(g.links.length, 1);
    assert.equal(g.links[0].target, "vault guide");
    assert.equal(g.links[0].kind, "wikilink");

    // Flipped: the identical row without the three self-links reports 0.
    const g2 = build([note("AI OS/Home.md", "Home", ["Vault Guide"])]);
    assert.equal(g2.counts.self_links_dropped, 0);
    assert.equal(g2.links.length, 1);
  });
});

describe("buildWikilinkGraph — counts and degree", () => {
  test("notes_scanned / notes_with_links / links_total describe what is drawn", () => {
    const rows = [
      note("a.md", "A", ["B", "C"]),
      note("b.md", "B", ["C"]),
      note("c.md", "C", null),
      note("d.md", "D", []),
      note("e.md", "E", ["  "]), // whitespace-only entry is not a link
    ];
    const g = build(rows);
    assert.equal(g.counts.notes_scanned, 5);
    assert.equal(g.counts.notes_with_links, 2);
    assert.equal(g.counts.links_total, 3);
    assert.equal(g.counts.links_total, g.links.length);
    assert.equal(g.counts.self_links_dropped, 0);
    assert.equal(g.counts.unresolved_targets, 0);
  });

  test("degree counts incident edges on both endpoints", () => {
    const g = build([
      note("a.md", "A", ["B", "C"]),
      note("b.md", "B", ["C"]),
      note("c.md", "C", null),
    ]);
    assert.equal(nodeById(g, "a").degree, 2); // A→B, A→C
    assert.equal(nodeById(g, "b").degree, 2); // A→B, B→C
    assert.equal(nodeById(g, "c").degree, 2); // A→C, B→C
  });

  test("a duplicate source→target edge is collapsed once", () => {
    // "Home" and "AI OS/Home" name the same note two different ways.
    const g = build([
      note("Inbox/x.md", "X", ["Home", "AI OS/Home"]),
      note("AI OS/Home.md", "Home", null),
    ]);
    assert.equal(g.links.length, 1);
    assert.equal(g.counts.links_total, 1);
    assert.equal(nodeById(g, "ai os/home").degree, 1);
  });

  test("maxLinks caps the rendered edges", () => {
    const rows = [note("a.md", "A", ["B", "C", "D"])];
    // Literal 2, not the module's ceiling — importing that constant here would
    // make the assertion pass at whatever the module happened to hold.
    const g = build(rows, 2);
    assert.equal(g.links.length, 2);
    assert.equal(g.counts.links_total, 2);
    // Flipped: uncapped, the same rows draw all three.
    assert.equal(build(rows, 99).links.length, 3);
  });

  test("notes[] provenance records the linking note's slug", () => {
    const g = build([note("AI OS/Home.md", "Home", ["Vault Guide"])]);
    assert.deepEqual(nodeById(g, "vault guide").notes, ["AI OS/Home"]);
    assert.deepEqual(nodeById(g, "ai os/home").notes, ["AI OS/Home"]);
  });
});

describe("buildWikilinkGraph — empty_reason (R35)", () => {
  test("EMPTY: nodes is [] and empty_reason names the table and the row count", () => {
    const rows = [
      note("a.md", "A", null),
      note("b.md", "B", []),
      note("c.md", "C", null),
    ];
    const g = build(rows);
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.links, []);
    assert.notEqual(g.empty_reason, null);
    const reason = g.empty_reason ?? "";

    // Assert on the SUBSTRINGS the requirement names, not the whole sentence —
    // the prose may be reworded, the table name and the row count may not.
    assert.ok(
      reason.includes("hcp.knowledge_note.links"),
      `empty_reason must name the table it read; got: ${reason}`,
    );
    assert.ok(
      reason.includes("3"),
      `empty_reason must carry the row count it found (3); got: ${reason}`,
    );
    assert.ok(
      reason.includes("syncVaultNotes()"),
      `empty_reason must say what would populate the table; got: ${reason}`,
    );
    // The string R35 exists to kill must not come back.
    assert.ok(
      !/no graph yet/i.test(reason),
      `the generic empty state must not survive; got: ${reason}`,
    );
  });

  test("EMPTY BY SELF-LINK ONLY: still empty, and the reason says so", () => {
    const g = build([note("AI OS/Home.md", "Home", ["Home", "#Projects"])]);
    assert.deepEqual(g.nodes, []);
    assert.equal(g.counts.self_links_dropped, 2);
    assert.ok((g.empty_reason ?? "").includes("hcp.knowledge_note.links"));
    assert.ok(
      (g.empty_reason ?? "").includes("2 self-link"),
      `the reason must account for the dropped links; got: ${g.empty_reason}`,
    );
  });

  test("NON-EMPTY: empty_reason IS null", () => {
    // Without this direction the field is inert — a builder that always
    // returned the sentence would pass the empty case above.
    const g = build(corpus());
    assert.ok(g.nodes.length > 0);
    assert.equal(g.empty_reason, null);
  });

  test("zero rows: empty_reason reports 0 scanned, not a crash", () => {
    const g = build([]);
    assert.deepEqual(g.nodes, []);
    assert.equal(g.counts.notes_scanned, 0);
    assert.ok((g.empty_reason ?? "").includes("0 vault-sync rows scanned"));
  });
});
