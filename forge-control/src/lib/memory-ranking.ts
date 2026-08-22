/**
 * Retrieval ranking for the vault memory store — §4.C of
 * `rework-2026-08-04/03-rag-audit.md`.
 *
 * The audit's finding: raw cosine over `knowledge_embeddings` is well-ordered
 * but pathologically undiverse. One 10k-word rolling log (`AI OS/Operator
 * Log.md`, 44–54 chunks) and one 249-chunk production note occupy every slot
 * of nearly every result set, and a 0.42 near-random hit is returned with the
 * same confidence as a 0.77 exact match. Three corrections, applied in order,
 * on top of the ANN candidate window:
 *
 *   1. per-source dedupe  — at most MAX_CHUNKS_PER_NOTE chunks survive per
 *      `source_path`, so no single note can monopolise a result set;
 *   2. weighting          — a note-type prior (profile/spec up, rolling logs
 *      and stale dailies down, oversized notes mildly down) times a gentle
 *      mtime recency decay;
 *   3. score floor        — anything whose *weighted* score lands under
 *      SCORE_FLOOR is dropped entirely. Returning three results is correct;
 *      padding to five with noise is not.
 *
 * Everything here is pure except `noteAgeDays()`, which stats the vault file
 * behind a TTL cache. Kept out of `db/memory.ts` so it is unit-testable
 * without a database.
 */

import { statSync } from "node:fs";
import path from "node:path";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";

/** Weighted-score cutoff. Hits below this are dropped rather than returned.
 *  0.55 sits above the "matches everything weakly" band measured in the audit
 *  (0.42–0.52) and below the weakest genuine topical hit (~0.56). */
export const SCORE_FLOOR = Number(process.env.MEMORY_SCORE_FLOOR ?? "0.55");

/** Max chunks any one `source_path` may contribute to a result set. */
export const MAX_CHUNKS_PER_NOTE = Number(
  process.env.MEMORY_MAX_CHUNKS_PER_NOTE ?? "2",
);

/** How many ANN candidates to pull per requested result before dedupe +
 *  weighting + floor thin them out. 8× keeps the HNSW scan cheap while
 *  leaving enough material that dropping 4 of 5 Operator Log chunks still
 *  yields a full page. */
export const CANDIDATE_MULTIPLIER = Number(
  process.env.MEMORY_CANDIDATE_MULTIPLIER ?? "8",
);
export const CANDIDATE_CAP = 200;

/** Recency decay: ×0.9 per 180 days of note mtime age, floored at 0.85.
 *  The audit proposed ×0.9/90d floor 0.7; measured against this vault that
 *  buries the 138 evergreen notes bulk-written in February under a 19%
 *  haircut. Halving the rate and raising the floor keeps the decay as a
 *  tie-breaker toward current reality — which is all it should be. */
const RECENCY_HALFLIFE_DAYS = 180;
const RECENCY_FLOOR = 0.85;

/** Total multiplier is clamped so no combination of priors can turn a strong
 *  vector hit into noise or a weak one into a top result. */
const WEIGHT_MIN = 0.75;
const WEIGHT_MAX = 1.25;

/** A note this many chunks long matches almost any query weakly — the
 *  audit's "it tops nearly every query" failure. Dedupe handles monopoly;
 *  this handles the residual bias. */
const BULK_NOTE_CHUNKS = 40;
const BULK_NOTE_WEIGHT = 0.9;

/** Daily notes newer than this are current state (boosted); older ones are
 *  history (penalised, same class as a rolling log). */
const DAILY_FRESH_DAYS = 14;

export type NoteKind =
  | "profile"
  | "spec"
  | "daily-recent"
  | "daily-stale"
  | "rolling-log"
  | "chat"
  | "note";

const NOTE_KIND_WEIGHT: Record<NoteKind, number> = {
  profile: 1.15,
  spec: 1.15,
  "daily-recent": 1.1,
  "daily-stale": 0.85,
  "rolling-log": 0.8,
  /* A conversation is raw material; a note is something Konrad decided was
   * worth keeping. When both match a query the curated one should edge ahead —
   * but only just, because the chats hold the reasoning the notes summarise. */
  chat: 0.95,
  note: 1.0,
};

/* Rolling logs: append-only notes that grow without bound. Matched on the
 * trailing word of the filename, so `Mentor/log.md`, `AI OS/Operator Log.md`
 * and `30_YouTube/TheSkyLab/TheSkyLab Production Log.md` all classify — the
 * naming convention is the only reliable signal, and it holds in this vault. */
const ROLLING_LOG_RE = /(^|\/|[\s_-])(log|worklog|journal|changelog)\.md$/i;
const DAILY_RE = /(^|\/)Daily\/(\d{4})-(\d{2})-(\d{2})\.md$/i;
const PROFILE_RE = /^(Mentor\/Profile\/|Mentor\/|90_AI_OS\/Profile\/)/i;
const SPEC_RE = /(^|\/)Specs?\//i;
const SPEC_NAME_RE = /(^|\/)(spec|specification)[^/]*\.md$/i;

/** Classify a vault-relative path into a retrieval prior.
 *  `ageDays` is only consulted for `Daily/YYYY-MM-DD.md`, whose date comes
 *  from the filename rather than the filesystem (dailies get touched by
 *  tooling long after the day they describe). */
export function classifyNote(sourcePath: string, now = Date.now()): NoteKind {
  /* `chat://<run_id>` — a conversation from `content_forge.runs.thread`,
   * embedded by km-indexer.js. Checked first because it is a pseudo-URI with
   * no file behind it: every path rule below assumes a vault-relative name,
   * and its recency comes from `metadata.ts` rather than a stat (see
   * searchMemory, which passes it as `mtime_ms`). */
  if (sourcePath.startsWith("chat://")) return "chat";

  const daily = sourcePath.match(DAILY_RE);
  if (daily) {
    const stamp = Date.parse(`${daily[2]}-${daily[3]}-${daily[4]}T00:00:00Z`);
    if (Number.isNaN(stamp)) return "daily-stale";
    const ageDays = (now - stamp) / 86_400_000;
    return ageDays <= DAILY_FRESH_DAYS ? "daily-recent" : "daily-stale";
  }
  if (ROLLING_LOG_RE.test(sourcePath)) return "rolling-log";
  if (PROFILE_RE.test(sourcePath)) return "profile";
  if (SPEC_RE.test(sourcePath) || SPEC_NAME_RE.test(sourcePath)) return "spec";
  return "note";
}

/** ×0.9 per RECENCY_HALFLIFE_DAYS, floored. `ageDays < 0` (clock skew, a note
 *  written "in the future") is treated as brand new rather than boosted. */
export function recencyWeight(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.max(RECENCY_FLOOR, Math.pow(0.9, ageDays / RECENCY_HALFLIFE_DAYS));
}

/* ---------------------------------------------------------------------------
 * mtime lookup, TTL-cached.
 *
 * Every search stats up to CANDIDATE_CAP paths. statSync on a warm page cache
 * is sub-millisecond, but a 60 s cache makes repeat queries free and bounds
 * the damage if the vault ever lives on slower storage. A path that cannot be
 * stat'd (agent-authored `hermes://…` pseudo-paths, deleted notes whose rows
 * survive) yields age 0 → neutral weight, never an exception: ranking must
 * degrade, not fail.
 * ------------------------------------------------------------------------- */
const MTIME_TTL_MS = 60_000;
const mtimeCache = new Map<string, { mtimeMs: number | null; at: number }>();

export function noteMtimeMs(sourcePath: string, now = Date.now()): number | null {
  const cached = mtimeCache.get(sourcePath);
  if (cached && now - cached.at < MTIME_TTL_MS) return cached.mtimeMs;

  let mtimeMs: number | null = null;
  const abs = path.resolve(VAULT_DIR, sourcePath);
  if (abs.startsWith(path.resolve(VAULT_DIR) + path.sep)) {
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      mtimeMs = null; // not a real file — see block comment above
    }
  }
  mtimeCache.set(sourcePath, { mtimeMs, at: now });
  return mtimeMs;
}

/** Test seam: drop the mtime cache so a test can control what stat returns. */
export function clearMtimeCache(): void {
  mtimeCache.clear();
}

/* ---------------------------------------------------------------------------
 * Ranking
 * ------------------------------------------------------------------------- */

export interface RankableCandidate {
  source_path: string;
  chunk_index: number;
  /** Raw cosine similarity, 0..1 (already converted from pgvector distance). */
  score: number;
  /** `metadata.chunk_count` from the indexer, when present. */
  chunk_count?: number;
  /** Note mtime in ms. Omit to have it resolved from disk. */
  mtime_ms?: number | null;
}

export interface RankExplain {
  kind: NoteKind;
  raw_score: number;
  weight: number;
  age_days: number | null;
}

export interface RankOptions {
  limit: number;
  maxPerNote?: number;
  floor?: number;
  now?: number;
}

/** Compute the multiplier a candidate's raw cosine is scaled by. */
export function weightFor(
  candidate: RankableCandidate,
  now = Date.now(),
): { weight: number; kind: NoteKind; ageDays: number | null } {
  const kind = classifyNote(candidate.source_path, now);
  const mtimeMs =
    candidate.mtime_ms !== undefined
      ? candidate.mtime_ms
      : noteMtimeMs(candidate.source_path, now);
  const ageDays = mtimeMs === null ? null : (now - mtimeMs) / 86_400_000;

  const bulk =
    (candidate.chunk_count ?? 0) >= BULK_NOTE_CHUNKS ? BULK_NOTE_WEIGHT : 1;
  const raw =
    NOTE_KIND_WEIGHT[kind] * bulk * (ageDays === null ? 1 : recencyWeight(ageDays));

  return {
    weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, raw)),
    kind,
    ageDays,
  };
}

/**
 * Dedupe → weight → floor → truncate.
 *
 * `candidates` must already be ordered best-first by raw score; the per-note
 * cap is applied against that order so each note keeps its *strongest* chunks.
 * Re-sorting happens after weighting, so a boosted profile note can overtake a
 * penalised log chunk that outranked it on raw cosine.
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: T[],
  opts: RankOptions,
): Array<T & { score: number; explain: RankExplain }> {
  const now = opts.now ?? Date.now();
  const maxPerNote = opts.maxPerNote ?? MAX_CHUNKS_PER_NOTE;
  const floor = opts.floor ?? SCORE_FLOOR;

  const perNote = new Map<string, number>();
  const kept: Array<T & { score: number; explain: RankExplain }> = [];

  for (const c of candidates) {
    const used = perNote.get(c.source_path) ?? 0;
    if (used >= maxPerNote) continue;
    perNote.set(c.source_path, used + 1);

    const { weight, kind, ageDays } = weightFor(c, now);
    const score = c.score * weight;
    if (score < floor) continue;
    kept.push({
      ...c,
      score,
      explain: {
        kind,
        raw_score: c.score,
        weight: Number(weight.toFixed(4)),
        age_days: ageDays === null ? null : Number(ageDays.toFixed(1)),
      },
    });
  }

  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, opts.limit);
}
