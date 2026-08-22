/**
 * Tests for lib/excalidraw-extract.ts.
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts — a test anywhere else does
 * not run at all).
 *
 * TWO KINDS OF TEST, DELIBERATELY.
 *
 * 1. Synthetic drawings, built by `draw()` below. Hermetic, and each one flips
 *    its assertion across the boundary in both directions: a rule that fires on
 *    the input it is meant for and NOT on the neighbouring input is a rule; one
 *    that only ever fires is a constant wearing a rule's clothes.
 *
 * 2. One test against a REAL drawing in Konrad's vault. The synthetic cases
 *    were all derived from that file's measured geometry, so this test is what
 *    stops them drifting into a fiction that only agrees with itself. It reads
 *    and never writes — this module has no write path at all — and it FAILS,
 *    loudly, if the vault or the drawing is missing, rather than skipping and
 *    reporting a pass it did not earn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

import {
  extractDrawing,
  extractDrawingText,
  renderGraphText,
  colourName,
  cleanPreamble,
  drawingTags,
  drawingTitle,
  isDrawingPath,
  textElementsIndex,
  ExcalidrawExtractError,
} from "./excalidraw-extract.ts";
import { serializeExcalidrawMarkdown, EMPTY_DRAWING } from "./excalidraw-md.ts";

/* ========================================================================== *
 * Fixture builder — synthetic .excalidraw.md files with real geometry
 * ========================================================================== */

type El = Record<string, unknown>;

/** A shape. Defaults mirror what Excalidraw actually writes. */
function shape(over: El): El {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    opacity: 100,
    groupIds: [],
    frameId: null,
    isDeleted: false,
    link: null,
    locked: false,
    ...over,
  };
}

function text(over: El): El {
  return shape({
    type: "text",
    width: 80,
    height: 20,
    fontSize: 16,
    containerId: null,
    ...over,
  });
}

function arrow(over: El): El {
  return shape({
    type: "arrow",
    width: 40,
    height: 0,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    points: [
      [0, 0],
      [40, 0],
    ],
    ...over,
  });
}

/** Serialise elements into a real `.excalidraw.md` file, through the same codec
 *  the vault uses — so a fixture cannot pass by being shaped differently from
 *  what the plugin writes. */
function draw(
  elements: El[],
  opts: { frontmatter?: string; preamble?: string } = {},
): string {
  return serializeExcalidrawMarkdown(
    {
      frontmatter:
        opts.frontmatter ?? "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n",
      preamble:
        opts.preamble ??
        "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n",
      otherSections: "",
      drawing: { ...EMPTY_DRAWING(), elements },
      format: "parsed",
    },
    "parsed",
  );
}

const P = "Excalidraw/Fixture.excalidraw.md";

/* ========================================================================== *
 * 1. Colour — named, never interpreted
 * ========================================================================== */

describe("colourName — a name, or the hex, never a meaning", () => {
  test("exact palette hits resolve to the name Konrad would say", () => {
    assert.equal(colourName("#b2f2bb"), "green");
    assert.equal(colourName("#ffd8a8"), "orange");
    assert.equal(colourName("#d0bfff"), "violet");
    // NEIGHBOUR: a different ramp, a different name — not one constant.
    assert.notEqual(colourName("#b2f2bb"), colourName("#ffd8a8"));
  });

  test("transparent and empty are absence, not a colour", () => {
    assert.equal(colourName("transparent"), null);
    assert.equal(colourName(""), null);
  });

  test("a near shade snaps to the palette; a far one keeps its hex", () => {
    // #b4f3bd is two steps off Excalidraw's green — squared distance 9.
    assert.equal(colourName("#b4f3bd"), "green");
    // NEIGHBOUR: 3764 from the nearest entry (#1e1e1e). Calling that "black"
    // would be a claim the file does not support, so the hex survives instead.
    assert.equal(colourName("#123456"), "#123456");
    // The radius is tighter than the gap between two differently-named palette
    // entries (204, blue #e7f5ff vs grey #f1f3f5), so a snap is never a
    // coin-toss between two names.
    assert.equal(colourName("#e7f5ff"), "blue");
    assert.equal(colourName("#f1f3f5"), "grey");
  });

  test("a malformed value is returned verbatim rather than guessed at", () => {
    assert.equal(colourName("rgb(1,2,3)"), "rgb(1,2,3)");
  });
});

/* ========================================================================== *
 * 2. Labels and containment
 * ========================================================================== */

describe("labels", () => {
  test("bound text becomes the shape's label and is not a second node", () => {
    const md = draw([
      shape({ id: "box", x: 0, y: 0, width: 300, height: 90, backgroundColor: "#a5d8ff" }),
      text({ id: "t", containerId: "box", x: 20, y: 30, text: "Content Forge" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes.length, 1);
    assert.equal(g.nodes[0].id, "box");
    assert.equal(g.nodes[0].label, "Content Forge");
    assert.equal(g.nodes[0].fill, "blue");
  });

  test("rawText wins over text, so a wikilink survives its alias", () => {
    const md = draw([
      text({
        id: "t",
        x: 0,
        y: 0,
        text: "the plan",
        rawText: "[[AI OS/Roadmap|the plan]]",
      }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes[0].label, "[[AI OS/Roadmap|the plan]]");
    assert.deepEqual(g.wikilinks, ["AI OS/Roadmap"]);
  });

  test("a shape's link field is carried and mined for wikilinks", () => {
    const md = draw([
      shape({ id: "b", link: "[[90_AI_OS/Spec - Personal AI OS Interface]]" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes[0].link, "[[90_AI_OS/Spec - Personal AI OS Interface]]");
    assert.deepEqual(g.wikilinks, ["90_AI_OS/Spec - Personal AI OS Interface"]);
    // NEIGHBOUR: a plain URL is a link but not a wikilink.
    const g2 = extractDrawing(P, draw([shape({ id: "b", link: "https://example.com" })]));
    assert.equal(g2.nodes[0].link, "https://example.com");
    assert.deepEqual(g2.wikilinks, []);
  });

  test("deleted elements are counted, never read", () => {
    const md = draw([
      shape({ id: "live", x: 0, y: 0 }),
      text({ id: "gone", x: 0, y: 0, text: "SECRET", isDeleted: true }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.stats.liveElements, 1);
    assert.equal(g.stats.deletedElements, 1);
    assert.ok(!renderGraphText(g).includes("SECRET"));
  });
});

describe("containment — the grouping Konrad's maps actually use", () => {
  /** The measured shape of a section on "Stealth Uploader - System Map":
   *  a dashed 350×540 box at (40,100), its title at (54,112), cards from y=150. */
  function section(): El[] {
    return [
      shape({
        id: "sec",
        x: 40,
        y: 100,
        width: 350,
        height: 540,
        strokeStyle: "dashed",
        strokeColor: "#868e96",
      }),
      text({ id: "title", x: 54, y: 112, width: 200, height: 25, text: "1 · CONTENT" }),
      shape({
        id: "card",
        x: 60,
        y: 150,
        width: 310,
        height: 90,
        backgroundColor: "#a5d8ff",
      }),
      text({ id: "cardlabel", containerId: "card", x: 70, y: 185, text: "Content Forge" }),
    ];
  }

  test("a shape drawn inside a box gets that box as its parent", () => {
    const g = extractDrawing(P, draw(section()));
    const card = g.nodes.find((n) => n.id === "card");
    assert.equal(card?.parentId, "sec");
  });

  test("a shape drawn OUTSIDE the box does not", () => {
    const els = section();
    // Same card, moved clear of the section — the only thing that changed.
    els[2] = shape({
      id: "card",
      x: 900,
      y: 150,
      width: 310,
      height: 90,
      backgroundColor: "#a5d8ff",
    });
    const g = extractDrawing(P, draw(els));
    assert.equal(g.nodes.find((n) => n.id === "card")?.parentId, null);
  });

  test("the SMALLEST containing box wins, so nesting is a hierarchy", () => {
    const md = draw([
      shape({ id: "outer", x: 0, y: 0, width: 1000, height: 1000 }),
      shape({ id: "inner", x: 10, y: 10, width: 500, height: 500 }),
      shape({ id: "leaf", x: 20, y: 20, width: 50, height: 50 }),
      text({ id: "l", containerId: "leaf", text: "leaf" }),
      text({ id: "i", containerId: "inner", text: "inner" }),
      text({ id: "o", containerId: "outer", text: "outer" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes.find((n) => n.id === "leaf")?.parentId, "inner");
    assert.equal(g.nodes.find((n) => n.id === "inner")?.parentId, "outer");
    assert.equal(g.nodes.find((n) => n.id === "outer")?.parentId, null);
  });

  test("an unlabelled box takes the free text at its top as its title", () => {
    const g = extractDrawing(P, draw(section()));
    const sec = g.nodes.find((n) => n.id === "sec");
    assert.equal(sec?.label, "1 · CONTENT");
    assert.equal(g.nodes.find((n) => n.id === "title")?.isParentTitle, true);
    // …and the title is not repeated as an item under its own heading.
    const rendered = renderGraphText(g);
    assert.equal(rendered.match(/1 · CONTENT/g)?.length, 1);
  });

  test("a title WIDER than its box is still the title", () => {
    // Measured: two of five section titles on the Stealth map overrun the box
    // they name, so a bounding-box test loses exactly the labels that matter.
    const els = section();
    els[1] = text({
      id: "title",
      x: 54,
      y: 112,
      width: 600, // runs 264px past the section's right edge
      height: 25,
      text: "2 · CONTROL PLANE (VPS · out-of-band)",
    });
    const g = extractDrawing(P, draw(els));
    assert.equal(
      g.nodes.find((n) => n.id === "sec")?.label,
      "2 · CONTROL PLANE (VPS · out-of-band)",
    );
  });

  test("a box holding exactly one text is labelled by it, wherever it sits", () => {
    // Excalidraw only binds a label when you type INTO a shape. Drag a text on
    // top of a box — what a hand-drawn board is made of — and the file keeps
    // them unrelated. Measured: without this rule "Drawing 2026-07-03 18.25.45"
    // rendered twelve headings reading "(unlabelled rectangle)", each with one
    // item beneath it.
    const md = draw([
      shape({ id: "box", x: 0, y: 0, width: 300, height: 200 }),
      // Dead centre — far outside the title band at the top of the box.
      text({ id: "t", x: 100, y: 95, width: 100, height: 20, text: "Architect" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes.find((n) => n.id === "box")?.label, "Architect");
    // …and it renders as one line, not a heading with a single child.
    const rendered = renderGraphText(g);
    assert.match(rendered, /- Architect/);
    assert.doesNotMatch(rendered, /unlabelled rectangle/);
  });

  test("a box holding TWO texts is not labelled by either of them", () => {
    // NEIGHBOUR of the rule above. Two texts in a box is a layout we cannot
    // read as label-plus-content, so we do not pick a winner.
    const md = draw([
      shape({ id: "box", x: 0, y: 0, width: 300, height: 200 }),
      text({ id: "t1", x: 100, y: 95, width: 100, height: 20, text: "Architect" }),
      text({ id: "t2", x: 100, y: 140, width: 100, height: 20, text: "Manager" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.nodes.find((n) => n.id === "box")?.label, "");
    const rendered = renderGraphText(g);
    assert.match(rendered, /Architect/);
    assert.match(rendered, /Manager/);
  });

  test("mute grandchildren are tallied too, not printed one per line", () => {
    const els: El[] = [
      shape({ id: "sec", x: 0, y: 0, width: 2000, height: 2000, strokeStyle: "dashed" }),
      text({ id: "sect", x: 10, y: 10, width: 100, height: 20, text: "SECTION" }),
      shape({ id: "card", x: 100, y: 100, width: 800, height: 800 }),
      text({ id: "cardt", containerId: "card", text: "Usage plan" }),
    ];
    for (let i = 0; i < 8; i++) {
      els.push(shape({ id: `f${i}`, type: "freedraw", x: 200 + i, y: 200, width: 5, height: 5 }));
    }
    const rendered = renderGraphText(extractDrawing(P, draw(els)));
    assert.match(rendered, /8 unlabelled freedraw/);
    assert.equal(rendered.match(/\(unlabelled freedraw\)/g), null);
  });

  test("text floating ABOVE a box is not its title", () => {
    // The regression this guards: on the real map the drawing's legend sits
    // 34px above the first section and was read as that section's name.
    const els = section();
    els.push(
      text({ id: "legend", x: 42, y: 66, width: 800, height: 20, text: "green = solid path" }),
    );
    const g = extractDrawing(P, draw(els));
    assert.equal(g.nodes.find((n) => n.id === "sec")?.label, "1 · CONTENT");
    assert.equal(g.nodes.find((n) => n.id === "legend")?.isParentTitle, false);
  });
});

/* ========================================================================== *
 * 3. Edges — direction, and the refusal to guess
 * ========================================================================== */

describe("edges", () => {
  function twoBoxes(): El[] {
    return [
      shape({ id: "a", x: 0, y: 0, width: 100, height: 50 }),
      text({ id: "at", containerId: "a", text: "Fetch" }),
      shape({ id: "b", x: 300, y: 0, width: 100, height: 50 }),
      text({ id: "bt", containerId: "b", text: "Store" }),
    ];
  }

  test("a bound arrow is a directed edge with both labels resolved", () => {
    const md = draw([
      ...twoBoxes(),
      arrow({
        id: "e",
        x: 100,
        y: 25,
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges.length, 1);
    assert.deepEqual(
      { from: g.edges[0].fromLabel, to: g.edges[0].toLabel, dir: g.edges[0].directed },
      { from: "Fetch", to: "Store", dir: true },
    );
    assert.equal(g.stats.unresolvedEndpoints, 0);
    assert.match(renderGraphText(g), /Fetch -> Store/);
  });

  test("an explicit null arrowhead is undirected — 'A relates to B'", () => {
    const md = draw([
      ...twoBoxes(),
      arrow({
        id: "e",
        endArrowhead: null,
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges[0].directed, false);
    assert.match(renderGraphText(g), /Fetch -- Store/);
  });

  test("arrowheads at both ends read as bidirectional", () => {
    const md = draw([
      ...twoBoxes(),
      arrow({
        id: "e",
        startArrowhead: "arrow",
        endArrowhead: "arrow",
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges[0].bidirectional, true);
    assert.match(renderGraphText(g), /Fetch <-> Store/);
  });

  test("an UNBOUND arrow is reported as ambiguous, never attached to a guess", () => {
    // The arrow is drawn right between the two boxes and points at one of them.
    // A proximity heuristic would happily call it "Fetch -> Store". The file
    // does not say that, so neither do we.
    const md = draw([
      ...twoBoxes(),
      arrow({ id: "e", x: 110, y: 25, width: 180 }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0].fromId, null);
    assert.equal(g.edges[0].toId, null);
    assert.equal(g.stats.unresolvedEndpoints, 1);

    const rendered = renderGraphText(g);
    assert.match(rendered, /## Ambiguous connections/);
    assert.match(rendered, /listed, not guessed/);
    assert.doesNotMatch(rendered, /Fetch -> Store/);
  });

  test("a half-bound arrow counts as ambiguous too", () => {
    const md = draw([
      ...twoBoxes(),
      arrow({ id: "e", startBinding: { elementId: "a" }, endBinding: null }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges[0].fromLabel, "Fetch");
    assert.equal(g.edges[0].toId, null);
    assert.equal(g.stats.unresolvedEndpoints, 1);
  });

  test("text bound to an arrow labels the edge, not a node", () => {
    const md = draw([
      ...twoBoxes(),
      arrow({
        id: "e",
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      }),
      text({ id: "el", containerId: "e", text: "drives" }),
    ]);
    const g = extractDrawing(P, md);
    assert.equal(g.edges[0].label, "drives");
    assert.ok(!g.nodes.some((n) => n.id === "el"));
    assert.match(renderGraphText(g), /Fetch -> Store \(drives\)/);
  });

  test("an unbound decorative LINE is not an edge at all", () => {
    // A line with no bindings is a rule or an underline. An arrow with no
    // bindings is a claim someone forgot to attach — the two are not the same,
    // and only the second one is worth asking about.
    const g = extractDrawing(
      P,
      draw([...twoBoxes(), shape({ id: "l", type: "line", x: 0, y: 200, width: 400 })]),
    );
    assert.equal(g.edges.length, 0);
  });
});

/* ========================================================================== *
 * 4. Legend detection
 * ========================================================================== */

describe("legend — the drawing's own key, quoted verbatim", () => {
  test("a colour key is picked up and reproduced", () => {
    const line =
      "v0 · co-planning draft | green = solid path · orange = highest-risk · dashed arrow = reads/drives";
    const g = extractDrawing(P, draw([text({ id: "t", x: 42, y: 66, text: line })]));
    assert.deepEqual(g.legend, [line]);
    const rendered = renderGraphText(g);
    assert.match(rendered, /## Legend, as written on the canvas/);
    assert.match(rendered, /meaning is whatever this legend says it is/);
  });

  test("prose with an equals sign but no visual channel is NOT a legend", () => {
    const g = extractDrawing(
      P,
      draw([text({ id: "t", text: "throughput = 4 videos per day" })]),
    );
    assert.deepEqual(g.legend, []);
  });

  test("a colour word that is not the SUBJECT of the assignment is not a legend", () => {
    // The false positive this rule was tightened for, verbatim off
    // "Drawing 2026-07-03 18.25.45": an equals sign, and the word "Green" —
    // eleven words later, describing a button.
    const note =
      "Backlink = verified Users need to sign in He'll get visibility " +
      "Green button saying he is verified";
    assert.deepEqual(extractDrawing(P, draw([text({ id: "t", text: note })])).legend, []);
    // NEIGHBOUR: the same sentence with the colour on the left of the `=` IS a
    // key, and is kept.
    assert.deepEqual(
      extractDrawing(P, draw([text({ id: "t", text: "Green = verified" })])).legend,
      ["Green = verified"],
    );
  });

  test("a colour word with no assignment is NOT a legend", () => {
    const g = extractDrawing(P, draw([text({ id: "t", text: "the green path is done" })]));
    assert.deepEqual(g.legend, []);
  });
});

/* ========================================================================== *
 * 5. Empty, mute and unreadable drawings
 * ========================================================================== */

describe("nothing to say — and saying so", () => {
  test("a blank canvas is isEmpty and says it is blank", () => {
    const r = extractDrawingText(P, draw([]));
    assert.equal(r.isEmpty, true);
    assert.match(r.text, /empty/i);
  });

  test("an all-deleted drawing reports the deletions, not a bare zero", () => {
    // Measured: "Drawing 2026-06-13 21.29.57" is 31 KB of 55 deleted elements.
    // "0 elements" would be true and useless; the operator needs to know the
    // file is a husk rather than a new canvas.
    const els = Array.from({ length: 55 }, (_, i) =>
      shape({ id: `d${i}`, isDeleted: true }),
    );
    const r = extractDrawingText(P, draw(els));
    assert.equal(r.isEmpty, true);
    assert.match(r.text, /55/);
    assert.match(r.text, /deleted/);
  });

  test("a page of unlabelled strokes is tallied, not enumerated", () => {
    // "Drawing 2026-08-09" is 382 freedraw strokes. Printed one per line it is
    // 9 KB of "(unlabelled freedraw)" and would out-weigh every real drawing in
    // any embedding of the vault.
    const els = Array.from({ length: 300 }, (_, i) =>
      shape({ id: `s${i}`, type: "freedraw", x: i, y: i, width: 5, height: 5 }),
    );
    const r = extractDrawingText(P, draw(els));
    assert.equal(r.isEmpty, true);
    assert.ok(
      r.text.length < 900,
      `300 mute strokes rendered ${r.text.length} bytes; they must collapse to a tally`,
    );
    assert.match(r.text, /300 unlabelled freedraw/);
  });

  test("one labelled shape among mute ones is NOT swallowed by the tally", () => {
    const els: El[] = Array.from({ length: 300 }, (_, i) =>
      shape({ id: `s${i}`, type: "freedraw", x: i, y: i, width: 5, height: 5 }),
    );
    els.push(shape({ id: "real", x: 5000, y: 5000 }));
    els.push(text({ id: "rt", containerId: "real", text: "THE ONE THING" }));
    const r = extractDrawingText(P, draw(els));
    assert.equal(r.isEmpty, false);
    assert.match(r.text, /THE ONE THING/);
  });

  test("an unreadable payload degrades to the plugin's text index, loudly", () => {
    const broken =
      "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n\n" +
      "# Excalidraw Data\n\n## Text Elements\n" +
      "Scraper pool ^aaa\n\nProxy rotation ^bbb\n\n" +
      "%%\n## Drawing\n```compressed-json\nNOT-VALID-LZSTRING!!\n```\n%%";
    const r = extractDrawingText("Excalidraw/Broken.excalidraw.md", broken);
    assert.notEqual(r.graph.degraded, null);
    assert.match(r.graph.degraded ?? "", /Text Elements/);
    // The labels still made it out — a degraded reading beats no reading.
    assert.match(r.text, /Scraper pool/);
    assert.match(r.text, /Proxy rotation/);
    // …and the reader is told the reading is degraded.
    assert.match(r.text, /^NOTE: /m);
    assert.equal(r.isEmpty, false);
  });

  test("extractDrawing refuses an ordinary note rather than mangling it", () => {
    assert.throws(
      () => extractDrawing("Daily/2026-08-23.md", "# a normal note\n"),
      (err: unknown) =>
        err instanceof ExcalidrawExtractError &&
        /not a .excalidraw.md path/.test(err.message),
    );
  });
});

/* ========================================================================== *
 * 6. Markdown-level helpers
 * ========================================================================== */

describe("markdown helpers", () => {
  test("the plugin's banner is stripped; the user's prose is kept", () => {
    const cleaned = cleanPreamble(
      "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n" +
        "This is the warming timeline. Day 12 is the first upload.\n",
    );
    assert.equal(cleaned, "This is the warming timeline. Day 12 is the first upload.");
    // NEIGHBOUR: with nothing but the banner there is nothing to keep. The
    // banner is byte-identical in all 16 vault drawings, so keeping it would
    // make every drawing look like every other one to a vector search.
    assert.equal(
      cleanPreamble("==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu. ⚠==\n\n"),
      "",
    );
  });

  test("a payload fence in the preamble is scaffolding, not prose", () => {
    // Measured on "Drawing 2026-07-03 18.25.41.excalidraw.md": plugin 2.20.0
    // wrote it with a bare `## Drawing` section and NO `# Excalidraw Data`
    // heading, so the codec finds no data region and returns the whole file as
    // preamble. Left alone, 300 characters of LZString base64 become that
    // drawing's "prose" — the noise vector that got drawings excluded.
    const cleaned = cleanPreamble(
      "==⚠  Switch to EXCALIDRAW VIEW ⚠==\n\n" +
        "## Drawing\n```compressed-json\nN4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3\n```\n%%\n",
    );
    assert.equal(cleaned, "");
    // NEIGHBOUR: a fence the USER wrote on the back of a note is prose and
    // survives — only the two payload languages are scaffolding.
    const withCode = cleanPreamble(
      "==⚠  Switch to EXCALIDRAW VIEW ⚠==\n\nRun it with:\n```bash\npnpm test\n```\n",
    );
    assert.match(withCode, /pnpm test/);
  });

  test("frontmatter tags drop the plugin's own marker and keep the real ones", () => {
    assert.deepEqual(
      drawingTags("---\nexcalidraw-plugin: parsed\ntags: [excalidraw, ai-os, planning]\n---\n"),
      ["ai-os", "planning"],
    );
    assert.deepEqual(drawingTags("---\ntags: [excalidraw]\n---\n"), []);
    assert.deepEqual(drawingTags("---\nexcalidraw-plugin: parsed\n---\n"), []);
  });

  test("the title loses the compound extension, both halves of it", () => {
    assert.equal(
      drawingTitle("Excalidraw/Stealth Uploader - System Map.excalidraw.md"),
      "Stealth Uploader - System Map",
    );
    // The bug this fixes in db/memory.ts: basename(rel, ".md") leaves the
    // ".excalidraw" behind, and the registry showed it to Konrad.
    assert.ok(!drawingTitle("a/b.excalidraw.md").includes("excalidraw"));
  });

  test("isDrawingPath matches the suffix, not the substring", () => {
    assert.equal(isDrawingPath("a/B.EXCALIDRAW.MD"), true);
    assert.equal(isDrawingPath("a/excalidraw.md.backup.md"), false);
  });

  test("the text index drops the block anchors the plugin appends", () => {
    assert.deepEqual(
      textElementsIndex("## Text Elements\nAlpha ^abc123\n\nBeta ^d-e_f\n\n%%\n## Drawing\n"),
      ["Alpha", "Beta"],
    );
  });
});

/* ========================================================================== *
 * 7. The real vault — the test that keeps the fixtures honest
 * ========================================================================== */

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const REAL_DRAWING = "Excalidraw/Stealth Uploader - System Map.excalidraw.md";

describe("against Konrad's real drawing", () => {
  test(`${REAL_DRAWING} renders as structure, not as a blob`, async () => {
    const abs = path.join(VAULT_DIR, REAL_DRAWING);
    // No skip. A missing vault is a fact about this machine that the operator
    // needs told; a silent skip would report a pass for work never done.
    await access(abs).catch(() => {
      throw new Error(
        `the real-drawing test needs ${abs}. Set OBSIDIAN_VAULT_DIR if the ` +
          `vault lives elsewhere; do not delete this test to make the suite green.`,
      );
    });
    const raw = await readFile(abs, "utf8");
    const r = extractDrawingText(REAL_DRAWING, raw);

    // It is readable at all.
    assert.equal(r.graph.degraded, null);
    assert.equal(r.isEmpty, false);

    // Structure, not a bag of strings: sections, contained cards, bound arrows.
    const sections = r.graph.nodes.filter(
      (n) => n.label && r.graph.nodes.some((c) => c.parentId === n.id),
    );
    assert.ok(sections.length >= 5, `expected >=5 titled sections, got ${sections.length}`);
    const bound = r.graph.edges.filter((e) => e.fromId && e.toId);
    assert.ok(bound.length >= 10, `expected >=10 resolved arrows, got ${bound.length}`);
    assert.ok(r.graph.legend.length >= 1, "the drawing states a colour legend");

    // Signal per byte: the rendering is a fraction of the file and still
    // carries the names. 33 KB → ~3.9 KB when this was written.
    assert.ok(
      r.text.length < raw.length / 4,
      `rendered ${r.text.length} B from ${raw.length} B — that is not a reduction`,
    );
    assert.match(r.text, /UPLOAD NODE/);
    assert.match(r.text, /Dolphin profile|olphin profile/);

    // Colour is reported as a colour and nowhere translated into a status.
    assert.match(r.text, /\[green\]/);
    assert.doesNotMatch(r.text, /\bstatus: (done|blocked|at risk)\b/);
  });
});
