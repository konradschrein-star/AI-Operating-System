/**
 * Typed client for the vault write path, the labelled counts envelope and the
 * wikilink graph — phase 2's server surface (forge-control/src/routes/vault.ts
 * and routes/memory.ts).
 *
 * WHY THIS FILE EXISTS AND IS NOT `app/api.ts`
 * ────────────────────────────────────────────
 * `app/api.ts` is 1,462 lines and every lane of this project would conflict on
 * it (02-architecture.md §0.3). It also carries three exports this file
 * deliberately does NOT replace — `fetchMemoryCounts` (typed
 * `Record<MemoryCategory | "all", number>`, a shape the server stopped emitting
 * when B1c removed the bare `all` key), `KnowledgeGraphData` with its dead
 * `triples` field, and `fetchMemoryGraph`. They stay exactly as they are; they
 * are noted as debt in
 * docs/plan/artifacts/os-usable-for-work/phase2/font-decision.md for phase 7's
 * integration task to clear.
 *
 * Requests go to /api/proxy/*, which next.config.mjs rewrites to forge-control
 * at $FORGE_CONTROL_URL — baked at BUILD time, not at `next start`.
 *
 * N1 APPLIES THROUGHOUT: there is no `?? []`, no `?? 0` and no catch-and-default
 * anywhere below. A failed fetch throws, carrying the status and the server's
 * own message. A surface that renders a zero because a query failed is the
 * defect this phase exists to remove.
 */

const ROOT = "/api/proxy";

/* ============================================================================
 * The error helper — and why api.ts:29's getJson could not be reused
 * ==========================================================================*/

/**
 * `api.ts:29` throws `${res.status} ${res.statusText}` and DISCARDS the
 * response body. Every error path in routes/vault.ts puts its diagnostic in
 * `{ error: "…" }` in that body — the `.md`-suffix refusal, the empty-body
 * refusal, the base_sha256 refusal, `no such note: …`. Throwing the body away
 * makes R24 ("a failed save shows the HTTP status AND the server message")
 * unsatisfiable in the UI, however carefully the UI is written.
 *
 * `status` is a property so a caller can branch on it without parsing the
 * message (B2d branches 409 vs everything else).
 */
export class VaultApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly path: string;
  /** The server's own text: `.error` from a JSON body, else the raw body. */
  readonly serverMessage: string;

  constructor(args: {
    status: number;
    statusText: string;
    path: string;
    serverMessage: string;
  }) {
    // The message is what a toast-free, persistent error panel renders
    // verbatim. It carries BOTH halves R24 asks for.
    super(
      `${args.status} ${args.statusText} on ${args.path} — ${args.serverMessage}`,
    );
    this.name = "VaultApiError";
    this.status = args.status;
    this.statusText = args.statusText;
    this.path = args.path;
    this.serverMessage = args.serverMessage;
  }
}

/** Longest server message carried into an Error. A 500 that stringifies a
 *  stack trace should not push the status line off the panel. */
const MAX_SERVER_MESSAGE = 2000;

function clip(text: string): string {
  return text.length > MAX_SERVER_MESSAGE
    ? `${text.slice(0, MAX_SERVER_MESSAGE)}… (${text.length} chars total)`
    : text;
}

/**
 * Pull the server's diagnostic out of an already-read body string.
 *
 * The try/catch here is NOT an N1 catch-and-default: it does not substitute a
 * value for a failed request, it degrades the DIAGNOSTIC from structured to
 * raw when the body is not JSON (an nginx 502 page, a proxy timeout). The
 * request has already failed either way; what varies is how legible the
 * failure is.
 */
function serverMessageFrom(body: string, status: number): string {
  const raw = body.trim();
  if (!raw) return `(empty ${status} response body)`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return clip(raw);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const err = (parsed as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return clip(err.trim());
  }
  return clip(raw);
}

/** GET returning JSON, or a VaultApiError carrying status + server message. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new VaultApiError({
      status: res.status,
      statusText: res.statusText,
      path,
      serverMessage: serverMessageFrom(await res.text(), res.status),
    });
  }
  return (await res.json()) as T;
}

/* ============================================================================
 * The vault write path (phase 1's endpoints, routes/vault.ts)
 * ==========================================================================*/

/** GET /api/vault/file?path=… — the exact bytes on disk, plus the hash the
 *  caller MUST hand back as `base_sha256` on the matching PUT. */
export interface VaultFile {
  /** vault-relative path, as the server normalised it. */
  path: string;
  content: string;
  /** sha256 of the bytes in `content`. The compare-and-swap base. */
  sha256: string;
  mtime_ms: number;
  bytes: number;
}

export async function fetchVaultFile(path: string): Promise<VaultFile> {
  return getJson<VaultFile>(`/vault/file?path=${encodeURIComponent(path)}`);
}

/** PUT /api/vault/file, 200. `snapshot` is the pre-edit copy the undo contract
 *  wrote before the new bytes landed (02-architecture.md §1.2). */
export interface VaultSaveOk {
  ok: true;
  path: string;
  /** Hash of the bytes now on disk. ADOPT THIS as the next base_sha256, or the
   *  second edit of a session conflicts with the first. */
  sha256: string;
  bytes: number;
  snapshot: string;
}

/**
 * PUT /api/vault/file, 409 — someone else (an agent, the vault-sync tick, a
 * second tab) wrote the file after it was read here.
 *
 * `current_content_truncated` and `current_bytes` are NOT in the phase-2 plan's
 * §4.3 sketch; routes/vault.ts:217-227 sends them and they are load-bearing.
 * The 409 body is capped at 8 Mi UTF-16 code units, so `current_content` may be
 * a PREFIX of what is on disk. A UI that offers a truncated prefix back as
 * "take theirs" would destroy the tail on the next save — the flag is what lets
 * it refuse instead.
 */
export interface VaultConflict {
  error: string;
  current_sha256: string;
  current_content: string;
  current_content_truncated: boolean;
  current_bytes: number;
}

export type VaultSaveResult =
  | { kind: "ok"; value: VaultSaveOk }
  | { kind: "conflict"; value: VaultConflict };

/**
 * Compare-and-swap save.
 *
 * 200 → `{kind:"ok"}`. 409 → `{kind:"conflict"}` with `current_sha256` and
 * `current_content` carried through INTACT — without both, the UI cannot show
 * Konrad what he would be overwriting. Any other status THROWS a VaultApiError
 * carrying the status and the server's message; a 400 is never smuggled back as
 * a conflict or as a success.
 *
 * THIS FUNCTION NEVER RETRIES, NEVER AUTO-MERGES, AND NEVER RE-READS THE FILE
 * TO BUILD A FRESH `base_sha256`. A silent retry against the new base is a
 * clobber wearing a retry costume, and it is the single behaviour R23 exists to
 * forbid. It has no retry parameter, and adding one is a defect, not a feature:
 * overwriting the other writer's version is Konrad's explicit, labelled click,
 * made after he has seen both versions.
 */
export async function saveVaultFile(input: {
  path: string;
  content: string;
  base_sha256: string;
}): Promise<VaultSaveResult> {
  const path = "/vault/file";
  const res = await fetch(`${ROOT}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (res.status === 409) {
    // Read the body ONCE — a Response body is a single-use stream, so the
    // shape check happens against the parsed value, not a second .json().
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new VaultApiError({
        status: 409,
        statusText: res.statusText,
        path,
        serverMessage: `conflict body was not JSON: ${clip(text)}`,
      });
    }
    const body = parsed as Partial<VaultConflict>;
    // EVERY field is required, and a missing one throws rather than defaults.
    // routes/vault.ts:217-227 sends all five on every 409; a body without them
    // is a server this client does not understand, and the failure modes of
    // guessing are both severe: a conflict panel with an empty half reads as
    // "the other version is blank", and an assumed `truncated: false` invites
    // the UI to hand a prefix back as a whole note.
    const missing = (
      [
        ["error", typeof body.error === "string"],
        ["current_sha256", typeof body.current_sha256 === "string"],
        ["current_content", typeof body.current_content === "string"],
        [
          "current_content_truncated",
          typeof body.current_content_truncated === "boolean",
        ],
        ["current_bytes", typeof body.current_bytes === "number"],
      ] as const
    )
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new VaultApiError({
        status: 409,
        statusText: res.statusText,
        path,
        serverMessage:
          `conflict body is missing ${missing.join(", ")}, so the on-disk ` +
          `version cannot be shown safely: ${clip(text)}`,
      });
    }
    return { kind: "conflict", value: parsed as VaultConflict };
  }

  if (!res.ok) {
    throw new VaultApiError({
      status: res.status,
      statusText: res.statusText,
      path,
      serverMessage: serverMessageFrom(await res.text(), res.status),
    });
  }

  return { kind: "ok", value: (await res.json()) as VaultSaveOk };
}

/* ============================================================================
 * The labelled counts envelope (B1c's, R28/R29)
 * ==========================================================================*/

/**
 * GET /api/memory/counts[?source=vault|agent].
 *
 * Mirrors `MemoryCounts` in forge-control/src/lib/index-health.ts field for
 * field, including the doc comments that carry each figure's UNIT — the surface
 * renders those units, so losing them here loses them on screen.
 *
 * THERE IS NO `all` KEY. B1c removed it (R15: every top-level integer key must
 * match /^(vault|agent|embedded|excluded|stale)_/) and adding one back here
 * would re-create exactly the "0 notes" defect this phase is fixing.
 */
export interface MemoryCountsLabelled {
  /** `.md` files under OBSIDIAN_VAULT_DIR, excluding dot-directories. */
  vault_files_on_disk: number;
  /** hcp.knowledge_note WHERE created_by = 'vault-sync'. */
  vault_notes_indexed: number;
  /** hcp.knowledge_note WHERE created_by <> 'vault-sync' — worker briefs whose
   *  vault_path is a self-declared label, not a path on disk. */
  agent_notes: number;
  /** DISTINCT source_path in content_forge.knowledge_embeddings. */
  embedded_files: number;
  /** Chunk rows in content_forge.knowledge_embeddings. */
  embedded_chunks: number;
  /** Files on disk with no embedding row, by the reason they have none. */
  excluded: { excalidraw: number; empty: number; frontmatter_only: number };
  /** Embedding source_paths whose file is gone from disk. */
  stale_embedding_rows: number;
  measured_at: string;
  /** Which registry rows `folder_counts` was derived from. The totals above are
   *  absolute and do NOT move with it. */
  source: "vault" | "agent" | "all";
  folder_counts: Record<string, number>;
  /** The derivation of `folder_counts`, in words, from the server. Render it:
   *  a rule the operator cannot read is a rule he must trust. */
  folder_rule: string;
}

export async function fetchMemoryCountsLabelled(
  source?: "vault" | "agent",
): Promise<MemoryCountsLabelled> {
  return getJson<MemoryCountsLabelled>(
    `/memory/counts${source ? `?source=${source}` : ""}`,
  );
}

/* ============================================================================
 * The wikilink graph (B2b's, R33-R35)
 * ==========================================================================*/

export interface WikilinkNode {
  /** Normalised key: the note's slug when resolved, else the normalised link
   *  text. */
  id: string;
  /** Display form — the note's topic when resolved, else the first-seen casing
   *  of the link text. */
  label: string;
  /** Incident rendered edges. */
  degree: number;
  /** false ⇒ a wikilink target with no note behind it: a note Konrad meant to
   *  write. Kept as a node ON PURPOSE (R34); dropping it under-reports. */
  resolved: boolean;
  /** The real on-disk path, or null when `resolved` is false. */
  vault_path: string | null;
  /** Slugs of the notes this node appears in, capped server-side. */
  notes: string[];
}

export interface WikilinkLink {
  source: string;
  target: string;
  kind: "wikilink";
}

/** Units, from WikilinkGraphCounts in forge-control/src/db/memory.ts — the
 *  surface labels every figure FROM HERE rather than inventing a wording. */
export interface WikilinkGraphCounts {
  /** knowledge_note rows read (vault-sync only — agent rows carry URLs in
   *  `links`, never wikilinks). */
  notes_scanned: number;
  /** of those, how many carried ≥1 non-empty link entry. */
  notes_with_links: number;
  /** edges in `links` — i.e. what is actually DRAWN: self-links removed,
   *  duplicate source→target collapsed. */
  links_total: number;
  /** nodes with resolved:false. */
  unresolved_targets: number;
  /** link entries pointing at their own note (including bare `[[#Heading]]`
   *  anchors), skipped for rendering but counted rather than discarded. */
  self_links_dropped: number;
}

export interface WikilinkGraph {
  /** The literal table this graph was built from. R33 asserts this string. */
  source: "knowledge_note.links";
  nodes: WikilinkNode[];
  links: WikilinkLink[];
  counts: WikilinkGraphCounts;
  /** Non-null ONLY when `nodes` is empty, and then it names the table read, the
   *  rows found and what would refill them (R35). */
  empty_reason: string | null;
  measured_at: string;
}

export async function fetchWikilinkGraph(): Promise<WikilinkGraph> {
  return getJson<WikilinkGraph>(`/memory/graph`);
}

/* ============================================================================
 * The note detail, with the two Obsidian fields (B2b's, R25/R26)
 * ==========================================================================*/

/** Same six values `MemoryCategory` has carried in app/api.ts since v1.4;
 *  restated rather than imported so this module has no edge into the file every
 *  lane conflicts on. */
export type MemoryNoteCategory =
  | "rule"
  | "pref"
  | "fact"
  | "person"
  | "project"
  | "note";

export type MemoryNoteSource = "vault" | "agent";

/**
 * `MemoryNoteDetail` plus the two fields B2b added server-side.
 *
 * `body` here comes from the INDEX (hcp.knowledge_note), not from disk. It is
 * fine to read; it is NOT a compare-and-swap base. An editor hashes the bytes
 * `fetchVaultFile()` returned, or the swap is theatre.
 */
export interface MemoryNoteDetailV2 {
  id: string;
  slug: string;
  topic: string;
  vault_path: string;
  category: MemoryNoteCategory;
  source: MemoryNoteSource;
  created_by: string;
  tags: string[];
  links: string[];
  created_at: string;
  preview: string;
  body: string;
  word_count: number;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  backlinks: { slug: string; topic: string }[];
  /** The Obsidian vault name the deep link targets. Present for EVERY note,
   *  agent briefs included, because R26 states the precondition on screen
   *  whether or not a link can be offered. */
  vault_name: string;
  /** obsidian://open?vault=…&file=… — built SERVER-SIDE by obsidianUri()
   *  (lib/vault.ts), which encodes each path component separately so a note
   *  whose name contains "&" opens at all. DO NOT rebuild it in the browser: a
   *  second implementation of an encoding rule is a second implementation that
   *  drifts. `null` for an agent brief, whose vault_path is a label rather than
   *  a file — a deep link to one silently fails, which R26 forbids. */
  obsidian_uri: string | null;
}

export async function fetchMemoryNoteV2(
  slug: string,
): Promise<MemoryNoteDetailV2> {
  const r = await getJson<{ note: MemoryNoteDetailV2 }>(
    `/memory/${encodeURIComponent(slug)}`,
  );
  return r.note;
}

/* ============================================================================
 * Search Hit Types (v2.3)
 * ==========================================================================*/

export interface MemorySearchHitV2 {
  slug: string;
  vault_path: string;
  title: string;
  snippet: string;
  score: number;
  chunk_index: number;
  note_kind?: string;
  via?: "title" | "tag" | "vector" | "graph";
  match_type?:
    | "exact_title"
    | "title_match"
    | "tag_match"
    | "vector"
    | "graph"
    | "empty"
    | "drawing"
    | string;
  match_reason?: string;
  is_empty?: boolean;
  is_drawing?: boolean;
  tags?: string[];
  hop?: number;
  explain?: {
    kind?: string;
    raw_score?: number;
    weight?: number;
    age_days?: number;
  };
}

