#!/usr/bin/env -S node --import tsx
/**
 * vault-split-move.ts — move Konrad's vault into the two roots the split
 * defines (`Konrad/` and `Forge/`), from the manifest a research pass wrote.
 * PLAN.md §3.5.
 *
 *     # what WOULD happen, touching nothing (the default):
 *     npx tsx scripts/vault-split-move.ts
 *     npx tsx scripts/vault-split-move.ts --include-ask
 *
 *     # the real thing, only after Konrad has said the word:
 *     npx tsx scripts/vault-split-move.ts --apply --i-have-konrads-go --include-ask
 *
 * THIS SCRIPT IS THE IRREVERSIBLE HALF OF THE SPLIT, so every default points
 * away from it:
 *
 *  - `--dry-run` is the default. `--apply` is the only way to touch a file, and
 *    `--apply` without `--i-have-konrads-go` exits non-zero having done
 *    nothing. Two flags, because one flag is a tab-completion away from a
 *    reorganised second brain.
 *  - AN 'ask' CONFIDENCE STOPS THE WHOLE RUN, not just its own entry. The
 *    manifest marks a classification the research pass could not settle
 *    (`90_AI_OS/`, 56 files of real business reference an agent wrote). Moving
 *    the settled 90% and leaving that one behind is the worst outcome: Konrad
 *    is asked about a vault that is already half-reorganised. `--include-ask`
 *    is the operator saying he has answered.
 *  - Every moved file is COPIED to /opt/ai-os/vault-snapshots first, and a
 *    reversal manifest is written beside the copies. The undo is
 *    `--reverse <reversal.json>`, and it is written before the first rename so
 *    it exists even if the run dies halfway.
 *  - Dot directories (.obsidian, .stfolder, .trash) are skipped unconditionally,
 *    whatever the manifest says — Obsidian's config and Syncthing's marker are
 *    not notes, and moving `.trash` resurrects deleted notes under a new root.
 *
 * It is GIT-FREE: the vault is not a git repository, and every operation here
 * is fs.rename() inside one filesystem plus fs.copyFile() into the snapshot
 * store. No `git mv`, no `git add`, nothing that assumes an index.
 *
 * WHAT IT DOES NOT DO. It does not flip `VAULT_LAYOUT`, restart anything, or
 * repoint the two hardcoded paths in forge-control/src/routes/map.ts
 * (`90_AI_OS/Konrad Projects Overview.md`, `90_AI_OS/Infrastructure - Master
 * Map.md`) that break the moment `90_AI_OS/` moves. Those are steps 1, 4 and 3
 * of docs/plan/vault-split.md — read that procedure before running this with
 * `--apply`.
 */

import { constants as FS, promises as fs } from "node:fs";
import path from "node:path";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const SNAPSHOT_ROOT = process.env.VAULT_SNAPSHOT_DIR ?? "/opt/ai-os/vault-snapshots";
const MANIFEST_DOC = "docs/plan/vault-split-manifest.md";

/** Never moved, whatever a manifest entry claims. */
const NEVER_MOVE = new Set([".obsidian", ".stfolder", ".trash"]);

interface ManifestEntry {
  from: string;
  to: string | null;
  confidence: string;
}

interface PlannedMove {
  from: string;
  to: string;
  confidence: string;
  /** True when the entry came from §7's root-loose-.md rule rather than from a
   *  literal JSON line — printed, so nobody reads a derived move as a
   *  classified one. */
  derived: boolean;
  files: string[];
  bytes: number;
}

interface ReversalManifest {
  created_at: string;
  vault: string;
  snapshot_dir: string;
  /** Undo pairs: rename `from` back to `to`. Reversed on purpose — this is the
   *  instruction, not a record of the forward move. */
  moves: { from: string; to: string }[];
}

function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Pull the ONE machine-readable block out of the manifest document. The
 *  document is prose with tables — the JSON block is §7 — so this looks for
 *  fenced ```json blocks and insists on exactly one that parses to an array of
 *  entries. Two blocks, or none, is an ambiguity this script refuses rather
 *  than resolving by picking the first. */
export function parseManifest(markdown: string): ManifestEntry[] {
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length === 0) {
    fail(
      `${MANIFEST_DOC} carries no \`\`\`json block — the mover has nothing to read. ` +
        `The block belongs in §7 "Machine-readable manifest".`,
    );
  }
  const parsed: ManifestEntry[][] = [];
  const errors: string[] = [];
  for (const [i, block] of blocks.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch (e) {
      errors.push(`block ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`block ${i + 1}: parsed, but is a ${typeof value}, not an array of entries`);
      continue;
    }
    parsed.push(value.map((raw, j) => validateEntry(raw, i + 1, j)));
  }
  if (parsed.length !== 1) {
    fail(
      `${MANIFEST_DOC} must hold exactly ONE json block that is an array of manifest entries; ` +
        `found ${parsed.length} of ${blocks.length} fenced json blocks.` +
        (errors.length ? ` Rejected: ${errors.join("; ")}` : ""),
    );
  }
  return parsed[0];
}

function validateEntry(raw: unknown, block: number, index: number): ManifestEntry {
  const where = `${MANIFEST_DOC} json block ${block}, entry ${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${where} is ${JSON.stringify(raw)}, not an object`);
  }
  const entry = raw as Record<string, unknown>;
  const { from, to, confidence } = entry;
  if (typeof from !== "string" || from.trim() === "") {
    fail(`${where} has no usable "from": ${JSON.stringify(from)}`);
  }
  if (to !== null && (typeof to !== "string" || to.trim() === "")) {
    fail(`${where} ("${from}") has no usable "to": ${JSON.stringify(to)} — use null for a no-op`);
  }
  if (typeof confidence !== "string" || confidence.trim() === "") {
    fail(
      `${where} ("${from}") has no "confidence". Every entry must carry one — it is what ` +
        `--include-ask gates on.`,
    );
  }
  return { from: normalise(from), to: to === null ? null : normalise(to), confidence };
}

/** Vault-relative, forward slashes, no leading or trailing slash. */
function normalise(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** An entry the research pass could not settle. Matched on the WORD, so
 *  "likely-ask", "ask Konrad" and "sure (ask)" all count — the manifest is
 *  prose-adjacent and its confidence strings are not an enum. */
export function isAskConfidence(confidence: string): boolean {
  return /\bask\b|-ask\b|\bask-/i.test(confidence);
}

function firstSegment(rel: string): string {
  return rel.split("/")[0];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Every file under `rel`, vault-relative, with its size. A file returns
 *  itself. Dot-named entries are skipped at every depth. */
async function walk(vaultDir: string, rel: string): Promise<{ files: string[]; bytes: number }> {
  const abs = path.join(vaultDir, rel);
  const stat = await fs.lstat(abs);
  if (stat.isSymbolicLink()) {
    fail(
      `${rel} is a symlink. This script renames real files only — a symlink move would ` +
        `silently repoint whatever it aims at. Resolve it by hand and re-run.`,
    );
  }
  if (stat.isFile()) return { files: [rel], bytes: stat.size };
  if (!stat.isDirectory()) fail(`${rel} is neither a file nor a directory`);

  const files: string[] = [];
  let bytes = 0;
  for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = await walk(vaultDir, `${rel}/${entry.name}`);
    files.push(...child.files);
    bytes += child.bytes;
  }
  return { files, bytes };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** §7's closing paragraph: the 69 loose root `.md` files are all Konrad's and
 *  were left out of the JSON to keep it readable. They are DERIVED here rather
 *  than enumerated, and every derived move is printed as such — a rule that
 *  moves files nobody listed has to say so out loud. */
async function deriveRootNotes(
  vaultDir: string,
  claimed: Set<string>,
): Promise<ManifestEntry[]> {
  const derived: ManifestEntry[] = [];
  for (const entry of await fs.readdir(vaultDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (claimed.has(entry.name)) continue;
    derived.push({
      from: entry.name,
      to: `Konrad/${entry.name}`,
      confidence: "sure (§7 root-note rule)",
    });
  }
  return derived.sort((a, b) => a.from.localeCompare(b.from));
}

interface Plan {
  moves: PlannedMove[];
  noops: ManifestEntry[];
  missing: ManifestEntry[];
  skipped: ManifestEntry[];
  askEntries: ManifestEntry[];
}

async function buildPlan(
  vaultDir: string,
  entries: ManifestEntry[],
  includeRootRule: boolean,
): Promise<Plan> {
  const claimed = new Set(entries.map((e) => e.from));
  const all = includeRootRule
    ? [...entries, ...(await deriveRootNotes(vaultDir, claimed))]
    : entries;
  const derivedFrom = new Set(all.slice(entries.length).map((e) => e.from));

  const moves: PlannedMove[] = [];
  const noops: ManifestEntry[] = [];
  const missing: ManifestEntry[] = [];
  const skipped: ManifestEntry[] = [];
  const askEntries: ManifestEntry[] = [];

  for (const entry of all) {
    if (NEVER_MOVE.has(firstSegment(entry.from)) || firstSegment(entry.from).startsWith(".")) {
      skipped.push(entry);
      continue;
    }
    if (entry.to === null) {
      noops.push(entry);
      continue;
    }
    if (isAskConfidence(entry.confidence)) askEntries.push(entry);
    if (!(await exists(path.join(vaultDir, entry.from)))) {
      missing.push(entry);
      continue;
    }
    const { files, bytes } = await walk(vaultDir, entry.from);
    moves.push({
      from: entry.from,
      to: entry.to,
      confidence: entry.confidence,
      derived: derivedFrom.has(entry.from),
      files,
      bytes,
    });
  }

  assertPlanIsCoherent(moves);
  return { moves, noops, missing, skipped, askEntries };
}

/** Two entries that nest, or two that share a destination, are a manifest bug
 *  that fs.rename() would resolve by half-executing. Caught before anything
 *  moves, named precisely enough to fix the manifest. */
function assertPlanIsCoherent(moves: PlannedMove[]): void {
  const byDestination = new Map<string, PlannedMove>();
  for (const move of moves) {
    const clash = byDestination.get(move.to);
    if (clash) {
      fail(
        `two entries move to the same destination "${move.to}": "${clash.from}" and ` +
          `"${move.from}". One of them would be renamed on top of the other.`,
      );
    }
    byDestination.set(move.to, move);
  }
  for (const a of moves) {
    for (const b of moves) {
      if (a === b) continue;
      if (b.from.startsWith(`${a.from}/`)) {
        fail(
          `entry "${b.from}" is inside entry "${a.from}" — moving the parent takes the child ` +
            `with it and the child's own move then fails on a path that no longer exists. ` +
            `Split the parent per file, or drop the child entry.`,
        );
      }
      if (b.to === a.from || b.to.startsWith(`${a.from}/`)) {
        fail(`entry "${b.from}" would land inside "${a.from}", which is itself being moved`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printPlan(plan: Plan, mode: "dry-run" | "apply"): void {
  const totalFiles = plan.moves.reduce((n, m) => n + m.files.length, 0);
  const totalBytes = plan.moves.reduce((n, m) => n + m.bytes, 0);
  console.log(
    `vault-split-move — ${mode.toUpperCase()} against ${VAULT_DIR}\n` +
      `manifest: ${MANIFEST_DOC}\n` +
      `${plan.moves.length} moves, ${totalFiles} files, ${human(totalBytes)}\n`,
  );
  const width = Math.min(48, Math.max(...plan.moves.map((m) => m.from.length), 8));
  for (const move of plan.moves) {
    console.log(
      `  ${move.from.padEnd(width)}  →  ${move.to}\n` +
        `    ${move.files.length} file${move.files.length === 1 ? "" : "s"}, ` +
        `${human(move.bytes)} · confidence: ${move.confidence}` +
        (move.derived ? " · DERIVED by the §7 root-note rule, not a listed entry" : ""),
    );
  }
  if (plan.noops.length) {
    console.log(
      `\n  no-ops (manifest says stay put): ` +
        plan.noops.map((e) => `${e.from} [${e.confidence}]`).join(", "),
    );
  }
  if (plan.skipped.length) {
    console.log(
      `  skipped (never moved): ` + plan.skipped.map((e) => e.from).join(", "),
    );
  }
  if (plan.missing.length) {
    console.log(
      `\n  MISSING — listed in the manifest, absent from the vault:\n` +
        plan.missing.map((e) => `    ${e.from} → ${e.to} [${e.confidence}]`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Compact UTC ISO-8601, the stamp convention this fleet uses everywhere. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function snapshotAll(plan: Plan, snapshotDir: string): Promise<void> {
  for (const move of plan.moves) {
    for (const rel of move.files) {
      const source = path.join(VAULT_DIR, rel);
      const target = path.join(snapshotDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // COPYFILE_EXCL: a snapshot never overwrites a snapshot, the same rule
      // lib/vault.ts's snapshot store follows. Losing a snapshot is losing the
      // undo, and this is the only copy of the pre-move tree.
      await fs.copyFile(source, target, FS.COPYFILE_EXCL);
      const [before, after] = await Promise.all([fs.stat(source), fs.stat(target)]);
      if (before.size !== after.size) {
        fail(
          `snapshot of ${rel} holds ${after.size} bytes, the note holds ${before.size} — ` +
            `NOTHING HAS BEEN MOVED. Snapshot dir: ${snapshotDir}`,
        );
      }
    }
  }
}

async function applyMoves(plan: Plan, snapshotDir: string): Promise<void> {
  const reversal: ReversalManifest = {
    created_at: new Date().toISOString(),
    vault: VAULT_DIR,
    snapshot_dir: snapshotDir,
    moves: plan.moves.map((m) => ({ from: m.to, to: m.from })),
  };
  const reversalPath = path.join(snapshotDir, "reversal.json");
  // Written BEFORE the first rename: a run that dies halfway must still leave
  // the operator the instruction that undoes what it managed to do. Entries for
  // moves that never happened fail loudly on the way back (source missing)
  // rather than doing something unexpected.
  await fs.writeFile(reversalPath, JSON.stringify(reversal, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
  console.log(`\nreversal manifest: ${reversalPath}`);

  for (const move of plan.moves) {
    const source = path.join(VAULT_DIR, move.from);
    const target = path.join(VAULT_DIR, move.to);
    if (await exists(target)) {
      fail(
        `${move.to} already exists — refusing to rename ${move.from} onto it. ` +
          `fs.rename() over an existing file replaces it silently. ` +
          `Nothing further has been moved; undo with --reverse ${reversalPath}`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    console.log(`  moved  ${move.from}  →  ${move.to}`);
  }
}

async function reverse(reversalPath: string): Promise<void> {
  const raw: unknown = JSON.parse(await fs.readFile(reversalPath, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as ReversalManifest).moves)
  ) {
    fail(`${reversalPath} is not a reversal manifest (no "moves" array)`);
  }
  const manifest = raw as ReversalManifest;
  console.log(`reversing ${manifest.moves.length} moves recorded ${manifest.created_at}`);
  for (const move of manifest.moves) {
    const source = path.join(manifest.vault, move.from);
    const target = path.join(manifest.vault, move.to);
    if (!(await exists(source))) {
      console.log(`  skip   ${move.from} (already absent — that move never happened)`);
      continue;
    }
    if (await exists(target)) {
      fail(`${move.to} exists again — refusing to rename ${move.from} onto it`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    console.log(`  back   ${move.from}  →  ${move.to}`);
  }
  // The two roots this script created are left behind, empty. Removing a
  // directory is a delete, and this script has no delete verb — `rmdir` them
  // yourself once the vault looks right.
  const leftovers: string[] = [];
  for (const root of ["Konrad", "Forge"]) {
    const abs = path.join(manifest.vault, root);
    if (!(await exists(abs))) continue;
    if ((await fs.readdir(abs)).length === 0) leftovers.push(`${root}/`);
  }
  if (leftovers.length) {
    console.log(`\n${leftovers.join(" and ")} are now empty — rmdir them by hand if you want.`);
  }
  console.log(
    `\nThe snapshot at ${manifest.snapshot_dir} is untouched — delete it by hand once ` +
      `you have checked the vault.`,
  );
}

// ---------------------------------------------------------------------------

const USAGE = `vault-split-move.ts — move the vault into Konrad/ and Forge/ per ${MANIFEST_DOC}

  --dry-run            print the plan and touch nothing (DEFAULT)
  --include-ask        proceed even though the manifest holds 'ask'-confidence
                       entries; means "Konrad has answered them"
  --no-root-rule       do not derive the 69 loose root .md files from §7's rule
  --apply              actually rename. Requires --i-have-konrads-go.
  --i-have-konrads-go  the second key. Both, or nothing moves.
  --reverse <path>     undo a previous --apply from its reversal.json
  --help

Environment: OBSIDIAN_VAULT_DIR (${VAULT_DIR}), VAULT_SNAPSHOT_DIR (${SNAPSHOT_ROOT}).`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const known = new Set([
    "--dry-run",
    "--include-ask",
    "--no-root-rule",
    "--apply",
    "--i-have-konrads-go",
    "--reverse",
  ]);
  for (const [i, arg] of argv.entries()) {
    if (arg.startsWith("-") && !known.has(arg) && argv[i - 1] !== "--reverse") {
      fail(`unknown flag ${arg}\n\n${USAGE}`);
    }
  }

  const reverseIdx = argv.indexOf("--reverse");
  if (reverseIdx !== -1) {
    const target = argv[reverseIdx + 1];
    if (!target || target.startsWith("-")) fail("--reverse needs the path to a reversal.json");
    await reverse(target);
    return 0;
  }

  const apply = argv.includes("--apply");
  if (apply && !argv.includes("--i-have-konrads-go")) {
    fail(
      `--apply moves Konrad's notes and needs his explicit go-ahead: pass ` +
        `--i-have-konrads-go as well. Nothing was touched.`,
    );
  }

  const markdown = await fs.readFile(path.join(process.cwd(), MANIFEST_DOC), "utf8").catch((e) => {
    fail(
      `could not read ${MANIFEST_DOC} from ${process.cwd()} — run this from the repo root ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  });
  const entries = parseManifest(markdown);
  const plan = await buildPlan(VAULT_DIR, entries, !argv.includes("--no-root-rule"));

  if (plan.askEntries.length > 0 && !argv.includes("--include-ask")) {
    fail(
      `the manifest holds ${plan.askEntries.length} entr${plan.askEntries.length === 1 ? "y" : "ies"} ` +
        `whose classification is still a question for Konrad:\n` +
        plan.askEntries.map((e) => `    ${e.from} → ${e.to} [${e.confidence}]`).join("\n") +
        `\n\nNothing was printed or moved. Moving everything ELSE would leave him answering a ` +
        `question about a vault that is already half-reorganised. Answer them, then re-run with ` +
        `--include-ask.`,
    );
  }

  printPlan(plan, apply ? "apply" : "dry-run");

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing was moved. Re-run with --apply --i-have-konrads-go to do it ` +
        `for real, after docs/plan/vault-split.md step 1.`,
    );
    return 0;
  }

  if (plan.missing.length > 0) {
    fail(
      `${plan.missing.length} manifest entries name a path that is not in the vault (listed ` +
        `above). The manifest is stale — re-classify before moving anything.`,
    );
  }

  const snapshotDir = path.join(SNAPSHOT_ROOT, "vault-split-move", stamp(new Date()));
  await fs.mkdir(snapshotDir, { recursive: true });
  console.log(`\nsnapshotting every file to ${snapshotDir} …`);
  await snapshotAll(plan, snapshotDir);
  console.log(`snapshot complete.`);

  await applyMoves(plan, snapshotDir);
  console.log(
    `\nDone. Now: set VAULT_LAYOUT=split, repoint routes/map.ts's two 90_AI_OS constants, ` +
      `safe-restart, and verify — docs/plan/vault-split.md steps 3-5.`,
  );
  return 0;
}

// `import.meta.main` is not in this Node; compare the resolved paths instead so
// a test can import parseManifest() without running the mover.
const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      // Hard error, named, non-zero. Never a partial success reported as one.
      console.error(`\nvault-split-move: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
    });
}
