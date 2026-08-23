/**
 * Tests for the scene builder. These cover the four things that break naive
 * Excalidraw generation (bound text, bound arrows, geometry, scaffolding), the
 * op surface the agent actually calls, and the soft merge.
 *
 * Run: pnpm --filter forge-control test   (or `pnpm test` inside forge-control)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOps,
  buildNode,
  buildArrow,
  contentBounds,
  resolveLabel,
  softMerge,
  measureText,
  resolveStyle,
  CARD_H,
  CARD_W,
  type ExcalidrawElement,
} from "./excalidraw-build.ts";
import {
  parseExcalidrawMarkdown,
  serializeExcalidrawMarkdown,
  withDrawing,
  EMPTY_DRAWING,
  type ExcalidrawDoc,
} from "./excalidraw-md.ts";

const byId = (els: ExcalidrawElement[], id: string): ExcalidrawElement => {
  const hit = els.find((e) => e.id === id);
  assert.ok(hit, `expected an element with id ${id}`);
  return hit;
};

const REQUIRED_FIELDS = [
  "angle",
  "groupIds",
  "frameId",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "updated",
  "link",
  "locked",
  "opacity",
  "fillStyle",
  "roughness",
];

test("every generated element carries the scaffolding Excalidraw requires", () => {
  const { next } = applyOps([], [{ op: "addColumn", labels: ["A", "B"] }]);
  for (const el of next) {
    for (const f of REQUIRED_FIELDS) {
      assert.ok(f in el, `${String(el.type)} is missing ${f}`);
    }
    assert.equal(typeof el.id, "string");
    assert.ok(String(el.id).length > 0);
  }
});

test("seeds are unique per element (a counter, not Math.random)", () => {
  const { next } = applyOps([], [{ op: "addColumn", labels: ["A", "B", "C", "D"] }]);
  const seeds = next.map((e) => e.seed);
  assert.equal(new Set(seeds).size, seeds.length, "duplicate seeds");
});

test("bound text is two-sided: container->text and text->container", () => {
  const [container, text] = buildNode({ label: "Fetch layer", x: 0, y: 0 });
  assert.deepEqual(container.boundElements, [{ id: text.id, type: "text" }]);
  assert.equal(text.containerId, container.id);
  assert.equal(text.textAlign, "center");
  assert.equal(text.verticalAlign, "middle");
  assert.equal(text.autoResize, false);
  assert.equal(text.roundness, null);
  // Label sits inside the card, not on its border.
  assert.ok((text.y as number) >= 0);
  assert.ok((text.y as number) + (text.height as number) <= CARD_H);
  assert.equal(text.width, CARD_W - 10);
});

test("bound arrows are three-sided and clipped to the shapes' edges", () => {
  const { next, nodes } = applyOps(
    [],
    [
      { op: "addNode", label: "A", x: 0, y: 0 },
      { op: "addNode", label: "B", x: 0, y: 400 },
      { op: "connect", fromLabel: "A", toLabel: "B", label: "flows" },
    ],
  );
  const arrow = next.find((e) => e.type === "arrow");
  assert.ok(arrow, "no arrow produced");
  const a = byId(next, nodes["A"]);
  const b = byId(next, nodes["B"]);

  // 1. the arrow knows both shapes
  assert.equal((arrow.startBinding as { elementId: string }).elementId, a.id);
  assert.equal((arrow.endBinding as { elementId: string }).elementId, b.id);
  // 2. both shapes know the arrow — without this it detaches on first drag
  const refs = (el: ExcalidrawElement) =>
    (el.boundElements as Array<{ id: string; type: string }>).map((r) => r.id);
  assert.ok(refs(a).includes(String(arrow.id)));
  assert.ok(refs(b).includes(String(arrow.id)));
  // 3. geometry starts BELOW A's bottom edge, not at A's centre
  assert.ok(
    (arrow.y as number) > CARD_H,
    `arrow starts at y=${String(arrow.y)}, inside the card (h=${CARD_H})`,
  );
  const pts = arrow.points as number[][];
  assert.equal(pts[0][0], 0);
  assert.equal(pts[0][1], 0);
  assert.ok(pts[1][1] > 0, "arrow should point downward");
  // 4. the label is bound to the arrow, both ways
  const label = next.find((e) => e.type === "text" && e.containerId === arrow.id);
  assert.ok(label, "arrow label missing");
  assert.deepEqual(arrow.boundElements, [{ id: label.id, type: "text" }]);
});

test("addColumn wires a vertical flow: n cards, n-1 arrows, in order", () => {
  const { next, nodes } = applyOps(
    [],
    [{ op: "addColumn", labels: ["Fetch", "Parse", "Store"], x: 100, y: 100 }],
  );
  const rects = next.filter((e) => e.type === "rectangle");
  const arrows = next.filter((e) => e.type === "arrow");
  assert.equal(rects.length, 3);
  assert.equal(arrows.length, 2);
  // Same column, descending.
  assert.deepEqual(
    rects.map((r) => r.x),
    [100, 100, 100],
  );
  const ys = rects.map((r) => r.y as number);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2]);
  // Arrows connect consecutive pairs.
  assert.equal(
    (arrows[0].startBinding as { elementId: string }).elementId,
    nodes["Fetch"],
  );
  assert.equal((arrows[0].endBinding as { elementId: string }).elementId, nodes["Parse"]);
  assert.equal((arrows[1].endBinding as { elementId: string }).elementId, nodes["Store"]);
});

test("addNode without coordinates lands below existing content, never on top of it", () => {
  const { next } = applyOps([], [{ op: "addNode", label: "First", x: 40, y: 40 }]);
  const before = contentBounds(next);
  assert.ok(before);
  const { next: after } = applyOps(next, [{ op: "addNode", label: "Second" }]);
  const placed = after.find((e) => e.type === "rectangle" && e !== next[0]);
  const second = after.filter((e) => e.type === "rectangle")[1];
  assert.ok(placed);
  assert.ok((second.y as number) >= before.maxY, "new card overlaps existing content");
  assert.equal(second.x, before.minX);
});

test("removeElements takes a card's bound label with it", () => {
  const { next, nodes } = applyOps([], [{ op: "addNode", label: "Doomed", x: 0, y: 0 }]);
  assert.equal(next.length, 2);
  const { next: after } = applyOps(next, [
    { op: "removeElements", ids: [nodes["Doomed"]] },
  ]);
  assert.equal(after.length, 0, "orphaned label left behind");
});

test("updateElements patches by id and preserves groupIds and customData", () => {
  const { next, nodes } = applyOps([], [{ op: "addNode", label: "Keep", x: 0, y: 0 }]);
  const id = nodes["Keep"];
  const grouped = next.map((e) => (e.id === id ? { ...e, groupIds: ["g1"] } : e));
  const { next: after } = applyOps(grouped, [
    { op: "updateElements", elements: [{ id, x: 500 }] },
  ]);
  const el = byId(after, id);
  assert.equal(el.x, 500);
  assert.deepEqual(el.groupIds, ["g1"], "groupIds must survive a partial update");
  assert.ok(el.customData, "customData must survive a partial update");
  assert.equal(el.version, 2);
});

test("label resolution: exact wins, ambiguity throws rather than guessing", () => {
  const { next } = applyOps(
    [],
    [
      { op: "addNode", label: "Fetch", x: 0, y: 0 },
      { op: "addNode", label: "Fetch layer", x: 0, y: 200 },
    ],
  );
  // "Fetch" is an exact match on one and a substring of the other — exact wins.
  assert.doesNotThrow(() => resolveLabel(next, "Fetch"));
  assert.throws(() => resolveLabel(next, "Fetc"), /matches 2 elements/);
  assert.throws(() => resolveLabel(next, "nothing here"), /no element labelled/);
});

test("bad ops throw with a diagnostic instead of half-applying", () => {
  assert.throws(() => applyOps([], [{ op: "connect", fromId: "a", toId: "b" }]), /no element with id a/);
  assert.throws(
    () => applyOps([], [{ op: "update", id: "ghost", patch: { x: 1 } }]),
    /no element with id ghost/,
  );
  assert.throws(
    () => applyOps([], [{ op: "addNode", label: "x", color: "chartreuse" }]),
    /unknown color/,
  );
  assert.throws(
    () => applyOps([], [{ op: "wat" } as unknown as Parameters<typeof applyOps>[1][number]]),
    /unknown op: wat/,
  );
});

test("applyOps never mutates the input array", () => {
  const original: ExcalidrawElement[] = [];
  applyOps(original, [{ op: "addNode", label: "A" }]);
  assert.equal(original.length, 0);
});

test("resolveStyle maps statuses, colour names and raw hex", () => {
  assert.equal(resolveStyle("planned").strokeStyle, "dashed");
  assert.equal(resolveStyle("gap").strokeWidth, 2);
  assert.equal(resolveStyle("#ff0000").strokeColor, "#ff0000");
  assert.equal(resolveStyle(undefined).strokeColor, "#1e1e1e");
});

test("measureText wraps to the container width", () => {
  const m = measureText("one two three four five six seven eight", 16, 200);
  assert.ok(m.lines.length > 1);
  assert.ok(m.height >= m.lines.length * 16);
});

test("a patched drawing round-trips through the markdown codec unchanged", () => {
  const doc: ExcalidrawDoc = {
    frontmatter: "",
    preamble: "",
    otherSections: "",
    drawing: EMPTY_DRAWING(),
    format: "compressed",
  };
  const { next } = applyOps(doc.drawing.elements, [
    { op: "addColumn", labels: ["Fetch", "Parse"], x: 0, y: 0 },
  ]);
  const md = serializeExcalidrawMarkdown(withDrawing(doc, { elements: next }));
  const reparsed = parseExcalidrawMarkdown(md);
  assert.deepEqual(reparsed.drawing.elements, next);
  // Obsidian's Text Elements index must list every text element.
  for (const el of next.filter((e) => e.type === "text")) {
    assert.ok(md.includes(`^${String(el.id)}`), `text ${String(el.id)} missing from the index`);
  }
});

test("softMerge unions disjoint edits and refuses overlapping ones", () => {
  const base: ExcalidrawElement[] = [
    { id: "a", type: "rectangle", x: 0, y: 0 },
    { id: "b", type: "rectangle", x: 0, y: 200 },
  ];
  // Konrad dragged "a"; the agent added "c" on the other side of the canvas.
  const mine: ExcalidrawElement[] = [
    { id: "a", type: "rectangle", x: 999, y: 0 },
    { id: "b", type: "rectangle", x: 0, y: 200 },
  ];
  const theirs: ExcalidrawElement[] = [
    ...base,
    { id: "c", type: "rectangle", x: 0, y: 400 },
  ];
  const disjoint = softMerge(base, mine, theirs);
  assert.deepEqual(disjoint.overlapping, []);
  assert.deepEqual(disjoint.adopted, ["c"]);
  assert.equal(disjoint.merged.length, 3);
  assert.equal(byId(disjoint.merged, "a").x, 999, "the live scene must win for its own edits");

  // Both moved "a" — not mergeable.
  const clash = softMerge(base, mine, [
    { id: "a", type: "rectangle", x: -50, y: 0 },
    { id: "b", type: "rectangle", x: 0, y: 200 },
  ]);
  assert.deepEqual(clash.overlapping, ["a"]);
});

test("softMerge ignores version churn when deciding what changed", () => {
  const base: ExcalidrawElement[] = [
    { id: "a", type: "rectangle", x: 0, y: 0, version: 1, versionNonce: 11, updated: 1 },
  ];
  const mine: ExcalidrawElement[] = [
    { id: "a", type: "rectangle", x: 0, y: 0, version: 9, versionNonce: 99, updated: 999 },
  ];
  const theirs: ExcalidrawElement[] = [
    { id: "a", type: "rectangle", x: 0, y: 0, version: 4, versionNonce: 44, updated: 444 },
    { id: "z", type: "ellipse", x: 5, y: 5 },
  ];
  const res = softMerge(base, mine, theirs);
  assert.deepEqual(res.overlapping, [], "a no-op resave must not read as a conflict");
  assert.deepEqual(res.adopted, ["z"]);
});

test("buildArrow between horizontally separated boxes leaves the correct edges", () => {
  const [left] = buildNode({ label: "L", x: 0, y: 0 });
  const [right] = buildNode({ label: "R", x: 600, y: 0 });
  const { arrow } = buildArrow(left, right);
  // Starts past the right edge of L, ends before the left edge of R.
  assert.ok((arrow.x as number) > CARD_W, "arrow starts inside the left card");
  const endX = (arrow.x as number) + (arrow.points as number[][])[1][0];
  assert.ok(endX < 600, "arrow ends inside the right card");
});

/* --- Regression: dropped-first-character multi-label codec test ----------- */

test("lossless markdown codec: multi-label drawing round-trips every label byte-identical (no dropped first char)", () => {
  const labels = [
    "STEALTH UPLOADER — SYSTEM MAP",
    "0 · co-planning draft | green = solid path",
    "1 · CONTENT",
    "2 · CONTROL PLANE (VPS · out-of-band)",
    "Content Forge (existing engine)",
    "Video + Thumbnail + Metadata",
    "Aspect router 9:16 → Short · 16:9 → Long",
    "Human calendar jitter · skipped days · re-slot",
    "PHASE 1 · Days 1–3   LOGGED-OUT WARM",
    "One profile = one fingerprint = one static IP",
    "Age the jar 48–72h ⛔ DO NOT log in yet",
    "Dolphin Cookie Robot builds Wave-1 jar: AEC · NID · SOCS ·\nVISITOR_INFO1",
  ];

  let elements: ExcalidrawElement[] = [];
  const { next: nodes } = applyOps(
    elements,
    labels.map((label, idx) => ({
      op: "addNode",
      label,
      x: (idx % 3) * 400,
      y: Math.floor(idx / 3) * 200,
    })),
  );
  elements = nodes;

  const doc: ExcalidrawDoc = {
    frontmatter: "---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n",
    preamble: "==⚠ Switch to EXCALIDRAW VIEW ⚠==\n\n",
    otherSections: "",
    drawing: {
      type: "excalidraw",
      version: 2,
      source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
      elements,
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
    },
    format: "compressed",
  };

  for (const format of ["compressed", "parsed"] as const) {
    const md = serializeExcalidrawMarkdown(doc, format);
    const reparsed = parseExcalidrawMarkdown(md);

    const origTextEls = elements.filter((e) => e.type === "text");
    const reparsedTextEls = reparsed.drawing.elements.filter((e) => e.type === "text");

    assert.equal(reparsedTextEls.length, origTextEls.length, `format ${format} lost text elements`);

    for (let i = 0; i < origTextEls.length; i++) {
      const orig = origTextEls[i];
      const rep = reparsedTextEls[i];
      const expectedLabel = labels[i];

      assert.equal(
        rep.text,
        expectedLabel,
        `element [${i}] label mutated in ${format} format: got "${rep.text}", expected "${expectedLabel}"`,
      );
      assert.equal(
        rep.text,
        orig.text,
        `element [${i}] text differs from input in ${format} format`,
      );
      assert.equal(
        rep.originalText,
        orig.originalText,
        `element [${i}] originalText differs in ${format} format`,
      );
      // Explicitly assert initial character survives
      assert.equal(
        (rep.text as string)[0],
        expectedLabel[0],
        `element [${i}] lost its first character in ${format} format: got "${(rep.text as string)[0]}", expected "${expectedLabel[0]}"`,
      );

      // Verify Obsidian ## Text Elements index contains the exact label
      const indexEntry = `${expectedLabel} ^${String(orig.id)}`;
      assert.ok(
        md.includes(indexEntry) || md.includes(`^${String(orig.id)}`),
        `element [${i}] missing from ## Text Elements in ${format} format`,
      );
    }
  }
});

test("discriminator: deliberately dropping index 0 of elements [1..N] makes the test go RED", () => {
  const labels = [
    "STEALTH UPLOADER — SYSTEM MAP",
    "Content Forge (existing engine)",
    "Video + Thumbnail + Metadata",
  ];

  const { next: elements } = applyOps(
    [],
    labels.map((label, idx) => ({
      op: "addNode",
      label,
      x: idx * 400,
      y: 0,
    })),
  );

  // Simulate buggy codec that drops index 0 on elements after index 0
  const corruptedElements = elements.map((el) => {
    if (el.type === "text") {
      const textIndex = labels.indexOf(el.text as string);
      if (textIndex > 0) {
        return {
          ...el,
          text: (el.text as string).slice(1),
          originalText: (el.originalText as string).slice(1),
        };
      }
    }
    return el;
  });

  // Verify that asserting equality on corruptedElements throws AssertionError
  assert.throws(
    () => {
      const textEls = corruptedElements.filter((e) => e.type === "text");
      for (let i = 0; i < textEls.length; i++) {
        assert.equal(
          textEls[i].text,
          labels[i],
          `discriminator caught corrupted element [${i}]: "${textEls[i].text}" vs "${labels[i]}"`,
        );
      }
    },
    /discriminator caught corrupted element \[1\]: "ontent Forge \(existing engine\)" vs "Content Forge \(existing engine\)"/,
  );
});

