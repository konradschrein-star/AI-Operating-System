/**
 * The lane-1 fixture vault (03-quality.md §1.2) — MANDATORY for every test
 * that touches vault code. No lane-1 test may run against the real vault:
 * the module under test writes files, and the real vault is Konrad's second
 * brain replicated to his devices by LiveSync.
 *
 * makeFixtureVault() builds a fresh temp vault per call under os.tmpdir() and
 * returns its absolute path. Point OBSIDIAN_VAULT_DIR at it BEFORE importing
 * lib/vault.ts — that module reads the env at load time, deliberately, so the
 * import must come after the assignment:
 *
 *     const vault = await makeFixtureVault();
 *     process.env.OBSIDIAN_VAULT_DIR = vault;
 *     const mod = await import("./vault.ts");        // top-level await
 *
 * The tree is fixed by 03-quality.md §1.2 and every file in it earns its
 * place: encoding hazards, hash fidelity, and the three index-health
 * classifications (empty_file, frontmatter_only, excluded_extension) that a
 * sibling task asserts against. Do not remove entries; add if you must.
 *
 * There is deliberately NO cleanup helper. This module ships beside a module
 * whose entire contract is that it removes nothing, and a fixture left in
 * os.tmpdir() costs a few kilobytes and survives long enough to debug a
 * failing run. The OS reaps the directory.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Vault-relative path → exact bytes. Exported so a consuming test asserts
 * against the same literal the fixture was built from rather than re-deriving
 * it. Keys use forward slashes, as vault-relative paths always do.
 */
export const FIXTURE_NOTES: Readonly<Record<string, string>> = Object.freeze({
  // A normal daily note in the shape appendToDailyNote() expects.
  "Daily/2026-08-18.md": "# 2026-08-18\n\n## Tasks\n\n## Notes\n\n## Journal\n",

  // URI encoding (& is the query separator) and shell hostility in one name.
  "Notes/with spaces & sym.md":
    "# with spaces & sym\n\nA name that breaks a naive encodeURI and an unquoted shell word.\n",

  // Non-ASCII: the em dash is U+2014, percent-encoded as %E2%80%94.
  "Notes/unicode — em dash.md": "# unicode — em dash\n\nEm dash — in the body too.\n",

  // Hash fidelity: CRLF line endings AND no trailing newline. Any trim,
  // newline normalisation or re-encoding on the read path changes this hash.
  "Notes/crlf-no-eol.md": "# crlf\r\n\r\nline one\r\nline two, no trailing newline",

  // 0 bytes → empty_file classification.
  "Empty.md": "",

  // Frontmatter and nothing else → frontmatter_only classification.
  "Frontmatter.md": "---\ntitle: Frontmatter only\ntags: [fixture]\n---\n",

  // Compound extension → excluded_extension classification.
  "Draw.excalidraw.md":
    "---\nexcalidraw-plugin: parsed\n---\n\n# Draw\n\n## Drawing\n```json\n{\"type\":\"excalidraw\"}\n```\n",
});

/**
 * Dot-segment paths. resolveInVault() must never reach either of these, so
 * they exist to be asked for and refused — a guard proven only against paths
 * that do not exist proves nothing about the guard.
 */
export const FIXTURE_UNREACHABLE: Readonly<Record<string, string>> = Object.freeze({
  ".trash/deleted.md": "# deleted\n\nObsidian's trash. Unreachable by the API, on purpose.\n",
  ".obsidian/app.json": '{"promptDelete":false}\n',
});

/** Create a fresh fixture vault and return its absolute path. */
export async function makeFixtureVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-vault-fixture-"));
  for (const [rel, content] of Object.entries({
    ...FIXTURE_NOTES,
    ...FIXTURE_UNREACHABLE,
  })) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
  }
  return root;
}
