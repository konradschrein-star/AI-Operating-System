/**
 * Obsidian-Excalidraw markdown codec.
 *
 * An Excalidraw "drawing" in Obsidian is a plain .md file — there is no binary
 * format. Anatomy (as written by obsidian-excalidraw-plugin):
 *
 *   ---
 *   excalidraw-plugin: parsed
 *   tags: [excalidraw]
 *   ---
 *   ==⚠  Switch to EXCALIDRAW VIEW ... ⚠==
 *
 *   <"back of the note" markdown — real prose, tasks, dataview, whatever>
 *
 *   # Excalidraw Data
 *
 *   ## Text Elements
 *   <text of each text element> ^<elementId>
 *
 *   ## Embedded Files
 *   <fileId: vault path>          ← optional, images
 *
 *   %%
 *   ## Drawing
 *   ```compressed-json            ← or ```json when the plugin's compress=off
 *   <LZString.compressToBase64(JSON)>
 *   ```
 *   %%
 *
 * Two payload encodings exist and BOTH must round-trip, because Konrad's
 * plugin has compress=true: files this OS writes as plain json get re-saved
 * as compressed-json the moment he edits them in the app. Verified against
 * the plugin bundle — it uses lz-string's compressToBase64/decompressFromBase64.
 *
 * The contract that matters: everything we don't understand is PRESERVED.
 * Element `link` fields ([[wikilinks]] on shapes), groupIds, frames,
 * embeddables, the back-of-the-note prose and any extra `## Section` all
 * survive a read→write cycle untouched. We only ever swap the drawing payload
 * and regenerate the Text Elements index.
 */

import LZString from "lz-string";

export type ExcalidrawFormat = "compressed" | "parsed";

export interface ExcalidrawDrawing {
  type: string;
  version: number;
  source: string;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ExcalidrawDoc {
  /** Raw frontmatter block including the --- fences (may be ""). */
  frontmatter: string;
  /** Everything between frontmatter and `# Excalidraw Data` — the warning
   *  banner plus the user's "back of the note" markdown. Preserved verbatim. */
  preamble: string;
  /** `## Section` blocks inside the data region other than Text Elements and
   *  Drawing (e.g. `## Embedded Files`). Preserved verbatim. */
  otherSections: string;
  drawing: ExcalidrawDrawing;
  format: ExcalidrawFormat;
}

const DEFAULT_PREAMBLE =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n";

export const EMPTY_DRAWING = (): ExcalidrawDrawing => ({
  type: "excalidraw",
  version: 2,
  source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
  elements: [],
  appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
  files: {},
});

/** Decode the ```json / ```compressed-json payload of a drawing. */
function decodePayload(
  body: string,
): { drawing: ExcalidrawDrawing; format: ExcalidrawFormat } | null {
  const compressed = body.match(/```compressed-json\n([\s\S]*?)\n?```/);
  if (compressed) {
    // The plugin hard-wraps base64 across lines — strip all whitespace first.
    const packed = compressed[1].replace(/\s/g, "");
    const json = LZString.decompressFromBase64(packed);
    if (!json) throw new Error("compressed-json payload failed to decompress");
    return { drawing: JSON.parse(json) as ExcalidrawDrawing, format: "compressed" };
  }
  const plain = body.match(/```json\n([\s\S]*?)\n?```/);
  if (plain) {
    return { drawing: JSON.parse(plain[1]) as ExcalidrawDrawing, format: "parsed" };
  }
  return null;
}

export function parseExcalidrawMarkdown(raw: string): ExcalidrawDoc {
  let rest = raw;
  let frontmatter = "";
  const fm = rest.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) {
    frontmatter = fm[0];
    rest = rest.slice(fm[0].length);
  }

  const dataIdx = rest.indexOf("# Excalidraw Data");
  // A .md file with no data section yet is a valid empty canvas.
  if (dataIdx === -1) {
    return {
      frontmatter,
      preamble: rest.trim() ? rest : DEFAULT_PREAMBLE,
      otherSections: "",
      drawing: EMPTY_DRAWING(),
      format: "compressed",
    };
  }

  const preamble = rest.slice(0, dataIdx);
  const dataRegion = rest.slice(dataIdx);

  const decoded = decodePayload(dataRegion);
  const drawing = decoded?.drawing ?? EMPTY_DRAWING();
  const format = decoded?.format ?? "compressed";

  // Keep any `## Section` that isn't Text Elements or Drawing (e.g. Embedded
  // Files). Split on headings so we never mangle their contents.
  const otherSections = dataRegion
    .split(/\n(?=## )/)
    .filter((s) => {
      const h = s.match(/^## (.+)/);
      if (!h) return false;
      const name = h[1].trim();
      return name !== "Text Elements" && name !== "Drawing";
    })
    .map((s) => s.replace(/\n*%%\s*$/, "").trimEnd())
    .join("\n\n");

  return { frontmatter, preamble, otherSections, drawing, format };
}

/** Rebuild the `## Text Elements` index — Obsidian uses it for search and for
 *  `![[Drawing#^element=<id>]]` block embeds, so it must track the elements. */
function renderTextElements(elements: Record<string, unknown>[]): string {
  const lines = elements
    .filter((e) => e && e.type === "text" && typeof e.text === "string")
    .map((e) => `${String(e.text)} ^${String(e.id ?? "")}`.trim());
  return lines.length ? lines.join("\n\n") + "\n" : "";
}

export function serializeExcalidrawMarkdown(
  doc: ExcalidrawDoc,
  format: ExcalidrawFormat = doc.format,
): string {
  const json = JSON.stringify(doc.drawing, null, format === "parsed" ? "\t" : 0);
  const payload =
    format === "compressed"
      ? "```compressed-json\n" +
        // Wrap to match the plugin's own line width — keeps git/Syncthing
        // diffs sane instead of one multi-megabyte line.
        (LZString.compressToBase64(json).match(/.{1,64}/g) ?? []).join("\n") +
        "\n```"
      : "```json\n" + json + "\n```";

  const frontmatter =
    doc.frontmatter ||
    "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";
  const preamble = doc.preamble || DEFAULT_PREAMBLE;
  const others = doc.otherSections ? `\n${doc.otherSections}\n` : "";

  return (
    frontmatter +
    preamble.replace(/\s*$/, "\n\n") +
    "# Excalidraw Data\n\n" +
    "## Text Elements\n" +
    renderTextElements(doc.drawing.elements) +
    others +
    "\n%%\n## Drawing\n" +
    payload +
    "\n%%"
  );
}

/** Replace a drawing's contents while preserving every wrapper concern. */
export function withDrawing(
  doc: ExcalidrawDoc,
  next: {
    elements: Record<string, unknown>[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  },
): ExcalidrawDoc {
  return {
    ...doc,
    drawing: {
      ...doc.drawing,
      elements: next.elements,
      // Only persist view-level appState; the live editor's transient state
      // (collaborators, cursors, selection) must never reach the file.
      appState: {
        ...(doc.drawing.appState ?? {}),
        ...(next.appState ?? {}),
      },
      files: next.files ?? doc.drawing.files ?? {},
    },
  };
}
