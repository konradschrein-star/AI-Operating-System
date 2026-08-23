/**
 * Unit tests for hybrid memory search and Excalidraw text indexing.
 *
 * Tests cover:
 *  1. Exact title ranking (case-insensitive, ranks #1 with score 1.0)
 *  2. Substring & word title matching (score 0.92)
 *  3. Tag matching (score 0.88)
 *  4. Empty (0 bytes) and frontmatter-only notes detection (is_empty: true, snippet: "(empty note)")
 *  5. Excalidraw text element extraction, wikilinks, and clean topic resolution
 *  6. Hybrid fusion & deduplication across lexical and vector lanes
 *
 * Run: cd forge-control && npx tsx --test src/lib/memory-search.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractExcalidrawContent,
  fuseHybridHits,
  slugify,
  type SearchHit,
} from "../db/memory.ts";
import {
  serializeExcalidrawMarkdown,
  EMPTY_DRAWING,
  type ExcalidrawDoc,
} from "./excalidraw-md.ts";

describe("Excalidraw text and structure extraction", () => {
  test("extracts text elements, preamble prose, and wikilinks from drawing", () => {
    const drawing = EMPTY_DRAWING();
    drawing.elements = [
      {
        id: "text-1",
        type: "text",
        text: "Stealth Uploader Engine",
        link: "[[System - Audio Face Sidecar]]",
      },
      {
        id: "text-2",
        type: "text",
        text: "Worker Queue Processor",
      },
      {
        id: "rect-1",
        type: "rectangle",
        link: "[[Architecture Specs]]",
      },
    ];

    const doc: ExcalidrawDoc = {
      frontmatter: "---\ntags: [pipeline, system-map]\n---\n",
      preamble:
        "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n" +
        "### Overview\nThis diagram maps the stealth uploader video pipeline [[Pipeline - Production]].\n\n",
      otherSections: "## Technical Notes\nPostgreSQL + Redis BullMQ backend.\n",
      drawing,
      format: "parsed",
    };

    const raw = serializeExcalidrawMarkdown(doc, "parsed");
    const extracted = extractExcalidrawContent(
      raw,
      "Excalidraw/Stealth Uploader - System Map.excalidraw.md",
    );

    assert.equal(extracted.topic, "Stealth Uploader - System Map");
    assert.ok(extracted.tags.includes("pipeline"));
    assert.ok(extracted.tags.includes("system-map"));
    assert.ok(extracted.tags.includes("excalidraw"));

    assert.ok(extracted.hasContent, "drawing with text elements has content");
    assert.ok(extracted.textElements.includes("Stealth Uploader Engine"));
    assert.ok(extracted.textElements.includes("Worker Queue Processor"));

    assert.ok(extracted.body.includes("Stealth Uploader Engine"));
    assert.ok(extracted.body.includes("PostgreSQL + Redis BullMQ backend"));
    assert.ok(extracted.body.includes("This diagram maps the stealth uploader"));
    assert.ok(!extracted.body.includes("==⚠"), "warning banner must be stripped from body");

    assert.ok(extracted.wikilinks.includes("System - Audio Face Sidecar"));
    assert.ok(extracted.wikilinks.includes("Architecture Specs"));
    assert.ok(extracted.wikilinks.includes("Pipeline - Production"));
  });

  test("correctly identifies empty drawing with no text elements", () => {
    const doc: ExcalidrawDoc = {
      frontmatter: "---\ntags: [excalidraw]\n---\n",
      preamble: "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n",
      otherSections: "",
      drawing: EMPTY_DRAWING(),
      format: "compressed",
    };

    const raw = serializeExcalidrawMarkdown(doc, "compressed");
    const extracted = extractExcalidrawContent(raw, "Excalidraw/Empty Canvas.excalidraw.md");

    assert.equal(extracted.topic, "Empty Canvas");
    assert.equal(extracted.hasContent, false);
    assert.equal(extracted.textElements.length, 0);
  });
});

describe("Hybrid search fusion & ranking", () => {
  test("exact title match ranks #1 with score 1.0 and match_type exact_title", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "90_AI_OS/Spec - Manager Chat UI v3",
        vault_path: "90_AI_OS/Spec - Manager Chat UI v3.md",
        title: "Spec - Manager Chat UI v3",
        snippet: "Spec for the manager chat interface in AI OS.",
        score: 1.0,
        chunk_index: 0,
        via: "title",
        match_type: "exact_title",
        match_reason: "Exact title match",
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "AI OS/Operator Decisions",
        vault_path: "AI OS/Operator Decisions.md",
        title: "Operator Decisions",
        snippet: "Decisions regarding agent autonomy and manager chat.",
        score: 0.88,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
        match_reason: "Semantic vector similarity",
      },
      {
        slug: "90_AI_OS/Spec - Manager Chat UI v3",
        vault_path: "90_AI_OS/Spec - Manager Chat UI v3.md",
        title: "Spec - Manager Chat UI v3",
        snippet: "Detailed chunk from manager chat specification.",
        score: 0.82,
        chunk_index: 1,
        via: "vector",
        match_type: "vector",
        match_reason: "Semantic vector similarity",
      },
    ];

    const fused = fuseHybridHits(lexicalHits, vectorHits);

    assert.ok(fused.length >= 2);
    // Rank #1 must be the exact title match
    const top = fused[0];
    assert.equal(top.vault_path, "90_AI_OS/Spec - Manager Chat UI v3.md");
    assert.equal(top.score, 1.0);
    assert.equal(top.via, "title");
    assert.equal(top.match_type, "exact_title");
    assert.equal(top.snippet, "Detailed chunk from manager chat specification.", "should use vector snippet when non-empty");

    // Second rank is the vector hit
    assert.equal(fused[1].vault_path, "AI OS/Operator Decisions.md");
    assert.equal(fused[1].match_type, "vector");
  });

  test("exact title match pins to rank #1 even when vector candidates have high scores", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "Mentor/Profile/Principles & Beliefs",
        vault_path: "Mentor/Profile/Principles & Beliefs.md",
        title: "Principles & Beliefs",
        snippet: "Boring, compounding infrastructure over one-off hacks.",
        score: 1.0,
        chunk_index: 0,
        via: "title",
        match_type: "exact_title",
        match_reason: "Exact title match",
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "90_AI_OS/Spec - Personal AI OS Interface",
        vault_path: "90_AI_OS/Spec - Personal AI OS Interface.md",
        title: "Spec - Personal AI OS Interface",
        snippet: "Concentric layers of the AI OS.",
        score: 0.96,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
    ];

    const fused = fuseHybridHits(lexicalHits, vectorHits);
    assert.equal(fused[0].vault_path, "Mentor/Profile/Principles & Beliefs.md");
    assert.equal(fused[0].score, 1.0);
    assert.equal(fused[1].vault_path, "90_AI_OS/Spec - Personal AI OS Interface.md");
  });

  test("substring title match gets score 0.92 and match_type title_match", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "90_AI_OS/Spec - Manager Chat UI v3",
        vault_path: "90_AI_OS/Spec - Manager Chat UI v3.md",
        title: "Spec - Manager Chat UI v3",
        snippet: "Manager chat UI spec.",
        score: 0.92,
        chunk_index: 0,
        via: "title",
        match_type: "title_match",
        match_reason: "Title substring match",
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "Other/Unrelated Note",
        vault_path: "Other/Unrelated Note.md",
        title: "Unrelated Note",
        snippet: "Some other content.",
        score: 0.70,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
    ];

    const fused = fuseHybridHits(lexicalHits, vectorHits);
    assert.equal(fused[0].vault_path, "90_AI_OS/Spec - Manager Chat UI v3.md");
    assert.equal(fused[0].score, 0.92);
    assert.equal(fused[0].match_type, "title_match");
  });

  test("tag match gets score 0.88 and match_type tag_match", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "Daily/2026-08-22",
        vault_path: "Daily/2026-08-22.md",
        title: "2026 08 22",
        snippet: "Tasks and journal entries.",
        score: 0.88,
        chunk_index: 0,
        via: "tag",
        match_type: "tag_match",
        match_reason: "Matched tag #recurring",
        tags: ["recurring", "daily"],
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "AI OS/Tasks",
        vault_path: "AI OS/Tasks.md",
        title: "Tasks",
        snippet: "Task tracking.",
        score: 0.75,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
    ];

    const fused = fuseHybridHits(lexicalHits, vectorHits);
    assert.equal(fused[0].vault_path, "Daily/2026-08-22.md");
    assert.equal(fused[0].score, 0.88);
    assert.equal(fused[0].match_type, "tag_match");
    assert.equal(fused[0].via, "tag");
  });
});

describe("Empty notes and frontmatter-only notes handling", () => {
  test("empty (0 bytes) note returns is_empty: true and snippet (empty note)", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "Help from Harry",
        vault_path: "Help from Harry.md",
        title: "Help from Harry",
        snippet: "(empty note)",
        score: 1.0,
        chunk_index: 0,
        via: "title",
        match_type: "exact_title",
        match_reason: "Exact title match (empty note)",
        is_empty: true,
      },
    ];

    const fused = fuseHybridHits(lexicalHits, []);
    assert.equal(fused.length, 1);
    const hit = fused[0];
    assert.equal(hit.vault_path, "Help from Harry.md");
    assert.equal(hit.is_empty, true);
    assert.equal(hit.snippet, "(empty note)");
    assert.equal(hit.score, 1.0);
    assert.equal(hit.match_type, "exact_title");
  });

  test("frontmatter-only note returns is_empty: true and snippet (empty note)", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "brand guidelines",
        vault_path: "brand guidelines.md",
        title: "brand guidelines",
        snippet: "(empty note)",
        score: 1.0,
        chunk_index: 0,
        via: "title",
        match_type: "exact_title",
        match_reason: "Exact title match (empty note)",
        is_empty: true,
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "brand guidelines",
        vault_path: "brand guidelines.md",
        title: "brand guidelines",
        snippet: "unrelated noisy hallucinated chunk",
        score: 0.60,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
    ];

    const fused = fuseHybridHits(lexicalHits, vectorHits);
    assert.equal(fused.length, 1);
    const hit = fused[0];
    assert.equal(hit.vault_path, "brand guidelines.md");
    assert.equal(hit.is_empty, true);
    assert.equal(hit.snippet, "(empty note)", "empty note must keep (empty note) snippet");
    assert.equal(hit.score, 1.0);
    assert.equal(hit.match_type, "exact_title");
  });

  test("score floor filtering preserves lexical hits and respects custom floor", () => {
    const lexicalHits: SearchHit[] = [
      {
        slug: "Note A",
        vault_path: "Note A.md",
        title: "Note A",
        snippet: "Exact match note.",
        score: 1.0,
        chunk_index: 0,
        via: "title",
        match_type: "exact_title",
      },
      {
        slug: "Note B",
        vault_path: "Note B.md",
        title: "Note B",
        snippet: "Tag match note.",
        score: 0.88,
        chunk_index: 0,
        via: "tag",
        match_type: "tag_match",
      },
    ];

    const vectorHits: SearchHit[] = [
      {
        slug: "Note C",
        vault_path: "Note C.md",
        title: "Note C",
        snippet: "Vector note.",
        score: 0.60,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
      {
        slug: "Note D",
        vault_path: "Note D.md",
        title: "Note D",
        snippet: "Low score note.",
        score: 0.40,
        chunk_index: 0,
        via: "vector",
        match_type: "vector",
      },
    ];

    // Default floor (0.55): Note D (0.40) is excluded
    const defaultFloorHits = fuseHybridHits(lexicalHits, vectorHits);
    assert.equal(defaultFloorHits.length, 3);
    assert.ok(!defaultFloorHits.some((h) => h.vault_path === "Note D.md"));

    // High floor (0.90): only Note A (1.0) survives
    const highFloorHits = fuseHybridHits(lexicalHits, vectorHits, { floor: 0.90 });
    assert.equal(highFloorHits.length, 1);
    assert.equal(highFloorHits[0].vault_path, "Note A.md");
  });
});
