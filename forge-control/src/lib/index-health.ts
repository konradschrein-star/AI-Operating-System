/**
 * Vault index reconciliation — the pure half.
 *
 * NO `pg`, NO `fs`. Everything here is a function of values that
 * `db/memory.ts` measured, so the classifier can be exercised against
 * synthetic vaults in `memory-index-health.test.ts` with no database and no
 * files on disk. The I/O half lives in `db/memory.ts:indexHealth()`.
 *
 * WHY THIS MODULE EXISTS (02-architecture.md §1.4, 00-vision.md §2.1).
 * There are two indexes of one vault, in two databases, with two owners:
 *
 *   hcp.knowledge_note                    ← syncVaultNotes() here, every 5 min, PRUNES
 *   content_forge.knowledge_embeddings    ← /opt/knowledge-mcp/km-indexer.js,
 *                                           outside this repo, NEVER prunes
 *
 * and until now no surface said which of them a number came from. The famous
 * "67 unindexed files" was not a gap: it was 326 (a `find` that included
 * `.trash`) minus 259 (an embeddings-table figure). Measured honestly the
 * vault holds 284 files, the registry holds 284 of 284, and the embeddings
 * shortfall decomposes with no residue into deliberate exclusions.
 *
 * So the product of this module is one number — `unexplained_count`. Every
 * absence must name the reason it is absent; an absence with no reason is the
 * exact defect this endpoint exists to abolish (R12). The counts are DERIVED,
 * never hardcoded (R13): a classifier that returns today's constants passes
 * every fixture and is worthless.
 */

/* ==========================================================================
 * Discrepancy classification
 * ========================================================================== */

export type DiscrepancyReason =
  | "empty_drawing"
  | "empty_file"
  | "frontmatter_only"
  | "stale_row_file_missing"
  | "unexplained";

/** One file's membership across the three stores, as measured. */
export interface FileFacts {
  /** Vault-relative path, `/`-separated, e.g. `90_AI_OS/Spec - X.md`. */
  path: string;
  /** `fs.stat().size`. Meaningless (and ignored) when `inDisk` is false. */
  bytes: number;
  /** Body non-empty after frontmatter is stripped. Only consulted on the
   *  frontmatter_only branch — see `reconcile()`'s not-measured guard. */
  hasBody: boolean;
  inDisk: boolean;
  inRegistry: boolean;
  inEmbeddings: boolean;
}

export interface Classification {
  reason: DiscrepancyReason;
  /** The evidence for the reason, carried in the payload so the operator
   *  never has to trust the label. */
  detail: string;
}

export interface Discrepancy extends Classification {
  path: string;
  in_disk: boolean;
  in_registry: boolean;
  in_embeddings: boolean;
}

/**
 * Obsidian-Excalidraw drawings.
 *
 * THIS CONSTANT CHANGED MEANING (2026-08-23). It used to be
 * `EXCLUDED_EXTENSION`, and a drawing on disk with no embedding row was
 * classified `excluded_extension` — "km-indexer.js:29 skips these, and it is
 * right to". That judgement was half true. It was right about the FILE: 480 KB
 * of LZString-packed geometry embeds as noise. It was wrong about the DRAWING:
 * "Stealth Uploader - System Map" holds 44 labelled shapes, 12 bound arrows and
 * a legend, and none of it was searchable by anything.
 *
 * `lib/excalidraw-extract.ts` now reads that structure out (33 KB of file → 3.9
 * KB of semantic text), so a drawing is an INDEXABLE NOTE. An unindexed one is
 * a real gap and is reported as `unexplained` like any other. Only a drawing
 * with nothing on it earns an exclusion, under its own reason.
 */
export const DRAWING_EXTENSION = ".excalidraw.md";

/** True for the paths whose body must be measured through the drawing
 *  extractor rather than by stripping frontmatter. */
export function isDrawing(path: string): boolean {
  return path.toLowerCase().endsWith(DRAWING_EXTENSION);
}

/**
 * Explain one file's position across the three stores, or `null` when there
 * is nothing to explain.
 *
 * Ordered exactly as 02-architecture.md §1.4 states the rules. Every branch
 * derives its `detail` from the facts it was handed — no branch returns a
 * constant count, and no branch returns a null/"unknown" reason.
 */
export function classify(f: FileFacts): Classification | null {
  // Neither store knows this path. Nothing to reconcile — `reconcile()` never
  // produces such a candidate (its universe is disk ∪ embeddings), but
  // `classify` is public and must not invent a discrepancy from nothing.
  if (!f.inDisk && !f.inEmbeddings) return null;

  // The file is gone but its chunks survive. This direction only ever happens
  // on the embeddings side: syncVaultNotes() deletes its own orphaned rows
  // (db/memory.ts, `DELETE … WHERE created_by = 'vault-sync' AND NOT
  // (vault_path = ANY(...))`), km-indexer.js has no prune step at all.
  if (!f.inDisk) {
    return {
      reason: "stale_row_file_missing",
      detail: "embedding rows survive; km-indexer.js never prunes",
    };
  }

  if (f.inEmbeddings) {
    // Embedded and on disk. The only remaining way this is a discrepancy is a
    // registry that does not know the file — which cannot be explained by any
    // of the four deliberate exclusions, because none of them apply to a file
    // the OTHER index accepted. `inRegistry` is in the fact set precisely so
    // this case is loud rather than invisible.
    if (!f.inRegistry) {
      return {
        reason: "unexplained",
        detail:
          "on disk and in content_forge.knowledge_embeddings, but absent from " +
          "hcp.knowledge_note — syncVaultNotes() skipped it",
      };
    }
    return null;
  }

  // On disk, not embedded. One of the deliberate exclusions, or the headline.
  if (f.bytes === 0) {
    return { reason: "empty_file", detail: "0 bytes" };
  }

  if (!f.hasBody) {
    // Nothing to embed. Two different operational facts share that outcome and
    // they get two different reasons, because the remedy differs: a
    // frontmatter-only note wants prose written into it, an empty drawing wants
    // something drawn on it.
    if (isDrawing(f.path)) {
      return {
        reason: "empty_drawing",
        detail:
          `${f.bytes} bytes of Excalidraw payload from which ` +
          `lib/excalidraw-extract.ts recovered no label and no prose — the ` +
          `canvas is blank or every element on it is deleted`,
      };
    }
    // Non-zero bytes with nothing left after the frontmatter fence. A file of
    // pure whitespace lands here too — it is the same operational fact (bytes
    // on disk, no content to embed) and the byte count in `detail` keeps the
    // claim checkable with `stat -c%s`.
    return {
      reason: "frontmatter_only",
      detail: `${f.bytes} bytes, frontmatter only`,
    };
  }

  // Real content that no index explains. THE HEADLINE.
  if (isDrawing(f.path)) {
    return {
      reason: "unexplained",
      detail:
        `${f.bytes} bytes of Excalidraw with labels, containment or arrows ` +
        `that lib/excalidraw-extract.ts can render as text, on disk, with no ` +
        `rows in content_forge.knowledge_embeddings — km-indexer.js:29 still ` +
        `lists ${DRAWING_EXTENSION} in EXCLUDED_EXTENSIONS`,
    };
  }
  return {
    reason: "unexplained",
    detail:
      `${f.bytes} bytes with a non-empty body, on disk, ` +
      `no rows in content_forge.knowledge_embeddings and no deliberate exclusion applies`,
  };
}

/* ==========================================================================
 * Reconciliation
 * ========================================================================== */

/** A `.md` file measured on disk. */
export interface DiskFile {
  path: string;
  bytes: number;
  /**
   * `null` = the head was deliberately not read, because this file needs no
   * frontmatter_only decision (see `indexHealth()`'s candidate set). If
   * `reconcile()` ever reaches the frontmatter_only branch with `null` here it
   * THROWS with the path rather than guessing — a guessed body is a fabricated
   * reason, and a fabricated reason is what this endpoint exists to abolish.
   */
  hasBody: boolean | null;
}

export interface ReconcileInput {
  measured_at: string;
  disk: {
    files: DiskFile[];
    /** `.md` files under `.trash`. Reported, never mixed into `md_files`. */
    excluded_trash: number;
  };
  registry: {
    /** `vault_path` of every `created_by = 'vault-sync'` row. */
    vault_sync_paths: string[];
    /** `created_by <> 'vault-sync'` — Hermes worker briefs, whose vault_path
     *  is a self-declared label and not a path on disk (db/memory.ts NoteSource). */
    agent_rows: number;
  };
  embeddings: {
    /** DISTINCT `source_path`, already scoped to real vault notes. */
    paths: string[];
    chunks: number;
  };
}

export interface IndexHealth {
  measured_at: string;
  disk: { md_files: number; excluded_trash: number };
  registry: { vault_sync_rows: number; agent_rows: number };
  embeddings: { files: number; chunks: number };
  discrepancies: Discrepancy[];
  unexplained_count: number;
}

export class IndexHealthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexHealthInputError";
  }
}

/**
 * Fold measured facts into the reconciliation envelope of
 * 02-architecture.md §1.4.
 *
 * The candidate universe is **disk ∪ embeddings**. A registry row with no file
 * and no embedding is out of scope on purpose: syncVaultNotes() prunes its own
 * orphans every 5 minutes, so that state is transient by construction, whereas
 * an embeddings orphan is permanent because km-indexer.js never prunes. Per
 * candidate, `in_registry` still reports registry membership, and a file the
 * registry does not know is classified `unexplained` rather than dropped.
 */
export function reconcile(input: ReconcileInput): IndexHealth {
  const diskByPath = new Map<string, DiskFile>();
  for (const f of input.disk.files) diskByPath.set(f.path, f);

  const registrySet = new Set(input.registry.vault_sync_paths);
  const embeddingSet = new Set(input.embeddings.paths);

  const universe = [...new Set([...diskByPath.keys(), ...embeddingSet])].sort();

  const discrepancies: Discrepancy[] = [];
  for (const p of universe) {
    const onDisk = diskByPath.get(p);
    const facts: FileFacts = {
      path: p,
      bytes: onDisk?.bytes ?? 0,
      // Deliberately pessimistic placeholder: the only branch that reads
      // hasBody is guarded below, so this value is never the basis of a
      // reason. It exists because FileFacts.hasBody is a boolean by contract.
      hasBody: onDisk?.hasBody === true,
      inDisk: onDisk !== undefined,
      inRegistry: registrySet.has(p),
      inEmbeddings: embeddingSet.has(p),
    };

    // frontmatter_only and empty_drawing both need a measured body. Refuse to
    // classify without one instead of defaulting. Drawings USED to be exempt
    // here because they were excluded outright; now they are the case that
    // most needs the measurement, since "has content" is the whole question.
    const needsBody = facts.inDisk && !facts.inEmbeddings && facts.bytes > 0;
    if (needsBody && onDisk?.hasBody === null) {
      throw new IndexHealthInputError(
        `index-health: hasBody was not measured for "${p}", but the file is on ` +
          `disk (${facts.bytes} bytes) and absent from the embeddings index — ` +
          `the ${
            isDrawing(p) ? "empty_drawing" : "frontmatter_only"
          } decision needs it. ` +
          `Widen the candidate set in indexHealth() rather than defaulting it.`,
      );
    }

    const verdict = classify(facts);
    if (!verdict) continue;
    discrepancies.push({
      path: p,
      in_disk: facts.inDisk,
      in_registry: facts.inRegistry,
      in_embeddings: facts.inEmbeddings,
      reason: verdict.reason,
      detail: verdict.detail,
    });
  }

  return {
    measured_at: input.measured_at,
    disk: {
      md_files: diskByPath.size,
      excluded_trash: input.disk.excluded_trash,
    },
    registry: {
      vault_sync_rows: registrySet.size,
      agent_rows: input.registry.agent_rows,
    },
    embeddings: { files: embeddingSet.size, chunks: input.embeddings.chunks },
    discrepancies,
    unexplained_count: discrepancies.filter((d) => d.reason === "unexplained")
      .length,
  };
}

/** Tally of one reason across a reconciliation. Derived, never assumed. */
export function countByReason(
  health: IndexHealth,
  reason: DiscrepancyReason,
): number {
  return health.discrepancies.filter((d) => d.reason === reason).length;
}

/** Every path classified `stale_row_file_missing` — the ONLY input the prune
 *  verb accepts. Nothing else may ever reach a DELETE (R14). */
export function stalePaths(health: IndexHealth): string[] {
  return health.discrepancies
    .filter((d) => d.reason === "stale_row_file_missing")
    .map((d) => d.path);
}

/* ==========================================================================
 * The counts envelope (02-architecture.md §1.5, R15–R17)
 * ========================================================================== */

/** Notes at the vault root have no folder segment; they are counted here so
 *  the folder rail sums to the note total instead of silently losing rows. */
export const ROOT_FOLDER_LABEL = "(root)";

/**
 * First `/`-separated segment of each `vault_path`.
 *
 * This replaces the five category chips. `inferCategory()` matched frontmatter
 * tags named `rule`/`pref`/`person`/`project`/`fact`; the vault's real tags are
 * `recurring`, `wasted-lease`, `inbox_triage`, `gmail`, `mcp`, `oauth-scope`,
 * and only 65 of 284 notes carry a tag at all — so five of six chips were
 * STRUCTURALLY incapable of a non-zero number. Folders are real, derivable,
 * need no frontmatter, and match how Konrad already navigates.
 */
export function folderCounts(vaultPaths: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of vaultPaths) {
    const cut = p.indexOf("/");
    const folder = cut === -1 ? ROOT_FOLDER_LABEL : p.slice(0, cut);
    out[folder] = (out[folder] ?? 0) + 1;
  }
  return out;
}

/** The derivation, stated verbatim in every response that carries
 *  `folder_counts` — a rule the operator cannot read is a rule he must trust. */
export function folderRule(scope: string): string {
  return (
    `first "/"-separated segment of vault_path; a note with no "/" is counted ` +
    `under "${ROOT_FOLDER_LABEL}". Scope: ${scope}.`
  );
}

export interface MemoryCounts {
  /** `.md` files under OBSIDIAN_VAULT_DIR, excluding dot-directories. */
  vault_files_on_disk: number;
  /** hcp.knowledge_note WHERE created_by = 'vault-sync'. */
  vault_notes_indexed: number;
  /** hcp.knowledge_note WHERE created_by <> 'vault-sync' — worker briefs. */
  agent_notes: number;
  /** DISTINCT source_path in content_forge.knowledge_embeddings. */
  embedded_files: number;
  /** Chunk rows in content_forge.knowledge_embeddings. */
  embedded_chunks: number;
  /**
   * Files on disk with no embedding row, by the reason they have none.
   *
   * `excalidraw` counts BLANK drawings only (reason `empty_drawing`). A drawing
   * with something on it is no longer an exclusion — it is an indexable note,
   * and an unindexed one shows up in `unexplained_count` where it belongs. The
   * key keeps its name because `forge-control-web/app/api-vault.ts` and the
   * Memory surface read it; renaming it is theirs to do, not ours.
   */
  excluded: { excalidraw: number; empty: number; frontmatter_only: number };
  /** Embedding source_paths whose file is gone from disk. */
  stale_embedding_rows: number;
  measured_at: string;
  /** Which registry rows `folder_counts` was derived from. */
  source: "vault" | "agent" | "all";
  folder_counts: Record<string, number>;
  folder_rule: string;
}

/**
 * R15: every TOP-LEVEL INTEGER key must state its unit and its source, which
 * is enforced structurally by requiring this prefix. `excluded` and
 * `folder_counts` are objects, `measured_at`/`folder_rule`/`source` are
 * strings — none of them is a top-level integer, so none is subject to the
 * rule. A bare `all` is exactly what it forbids.
 */
export const COUNTS_INTEGER_KEY_RULE = /^(vault|agent|embedded|excluded|stale)_/;

/** Top-level integer keys that violate R15. Empty = compliant. */
export function offendingCountKeys(payload: Record<string, unknown>): string[] {
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "number" && Number.isInteger(v))
    .map(([k]) => k)
    .filter((k) => !COUNTS_INTEGER_KEY_RULE.test(k));
}
