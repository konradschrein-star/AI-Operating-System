/**
 * Render one `.excalidraw.md` drawing as semantic text, on stdout.
 *
 *   tsx src/lib/excalidraw-extract-cli.ts <absolute-file> [vault-relative-path]
 *
 * WHY A CLI. `/opt/knowledge-mcp/km-indexer.js` is the process that fills
 * `content_forge.knowledge_embeddings`. It is plain CommonJS, lives outside
 * this repo, has no build step and does not carry lz-string. The alternative to
 * this eight-line bridge is a second implementation of the extractor in JS,
 * which would drift from the tested one the first time either side changed.
 * One implementation, one test suite, one subprocess per drawing — and there
 * are sixteen drawings in the whole vault.
 *
 * CONTRACT, so the caller never has to guess:
 *   exit 0  — stdout is the rendering. Index it.
 *   exit 3  — the drawing is blank (nothing drawn, or every element deleted).
 *             stdout is empty. Skip it; this is not a failure.
 *   exit 1  — could not read or parse. Diagnostic on stderr, stdout empty.
 *             Do NOT treat as blank: a broken file is not an empty one.
 */

import { readFileSync } from "node:fs";
import { relative, isAbsolute } from "node:path";

import { extractDrawingText, isDrawingPath } from "./excalidraw-extract.ts";

const EXIT_BLANK = 3;

function main(argv: string[]): number {
  const file = argv[2];
  if (!file) {
    process.stderr.write(
      "usage: excalidraw-extract-cli <absolute-file.excalidraw.md> " +
        "[vault-relative-path]\n",
    );
    return 1;
  }

  // The rendering carries the path it was asked about, and that path ends up in
  // the embedding's `source_path`. A caller that knows the vault-relative form
  // passes it; otherwise we derive it and say so rather than printing an
  // absolute path into the index.
  const vaultDir = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
  const rel =
    argv[3] ??
    (isAbsolute(file) ? relative(vaultDir, file).split("\\").join("/") : file);

  if (!isDrawingPath(rel)) {
    process.stderr.write(
      `excalidraw-extract-cli: "${rel}" is not a .excalidraw.md path\n`,
    );
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(
      `excalidraw-extract-cli: cannot read ${file}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  let result: ReturnType<typeof extractDrawingText>;
  try {
    result = extractDrawingText(rel, raw);
  } catch (err) {
    process.stderr.write(
      `excalidraw-extract-cli: cannot extract ${rel}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (result.isEmpty) return EXIT_BLANK;

  // A degraded reading is still worth indexing, but the caller's log should
  // carry the reason — it is the only place a human will see it.
  if (result.graph.degraded) {
    process.stderr.write(`excalidraw-extract-cli: ${rel}: ${result.graph.degraded}\n`);
  }

  process.stdout.write(result.text);
  return 0;
}

process.exitCode = main(process.argv);
