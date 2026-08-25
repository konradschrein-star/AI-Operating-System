/**
 * The JOURNAL day's database floor: one pool, one query helper, and the reply.
 *
 * `lib/evidence/*.ts` are the per-source adapters (one module, one source, one
 * async `(day) => T`); each of them reaches Postgres through the `query()`
 * helper below rather than opening a pool of its own. Nine evidence modules
 * with nine pools would be nine idle connections to `content_forge` for a
 * surface that is read once per page view.
 *
 * The pool is module-local on DATABASE_URL, exactly like db/journal.ts and
 * db/daily.ts — `day_tasks`, `runs`, `decisions`, `content_jobs`,
 * `glucose_readings` and `mentor_metrics` all live in that one database
 * (verified live, docs/research/round-1-b8fd2d3c.md header), so no evidence
 * source needs a second connection string.
 *
 * ── The reply ────────────────────────────────────────────────────────────
 * `day_plans` owns the state. `reflect()` in db/daily.ts is already an
 * INSERT … ON CONFLICT (day) DO UPDATE — checked, it UPSERTS a missing row,
 * so nothing here has to create the day first (db/daily.ts belongs to another
 * lane and is not touched).
 *
 * The vault note is a MIRROR, not the store. Under today's `legacy` layout it
 * is `Journal/<day>.md` at the vault root. It is appended through the vault's
 * own compare-and-swap verbs (readVaultFile → writeVaultFile), never through
 * appendToDailyNote(): that verb resolves "now" itself and can only ever write
 * `Daily/<today>.md`, so replying to Tuesday's journal on Wednesday would land
 * the line in the wrong file (routes/journal.ts's upload path documents the
 * same limitation and refuses rather than faking it).
 */

import pg from "pg";
import { getPlan, reflect } from "./daily.ts";
import { createNote, readVaultFile, writeVaultFile } from "../lib/vault.ts";
import { BERLIN_TZ, type Day } from "../lib/day-score.ts";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[journal-day pool]", e.message));

/** The one way an evidence module talks to Postgres. Rows only — a caller that
 *  wants `rowCount` is doing something this surface does not do (it reads). */
export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(sql, params as unknown[]);
  return r.rows;
}

/** Folder holding one note per journal day, under the current `legacy` layout.
 *  §3.5's `split` layout moves this to `Konrad/Journal`; that flag is B4's and
 *  does not exist yet, so the root folder is read from the environment with the
 *  legacy value as the default rather than hardcoded in two places later. */
const JOURNAL_DIR = process.env.VAULT_JOURNAL_DIR ?? "Journal";

/** Vault-relative path of the note a reply is mirrored into. */
export function journalNotePath(day: Day): string {
  return `${JOURNAL_DIR}/${day}.md`;
}

export interface JournalReply {
  subjective: number | null;
  reflection: string | null;
  updated_at: string | null;
  /** The note the reply was mirrored into, or null when no note exists yet. */
  note_path: string | null;
}

/** ENOENT and nothing else. Every other errno on a note that exists (EACCES,
 *  EIO) must surface as a failed source, not as "no journal note that day". */
function isMissingFile(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Berlin wall-clock HH:MM for the reply line's stamp. */
function berlinHhmm(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/**
 * The line appended to the journal note.
 *
 * Shape is pinned by the brief: `- HH:MM reply (felt N/10): <text>`. With no
 * rating the `(felt …)` clause is omitted rather than printed as `(felt /10)`;
 * with no text the line is the rating alone. A reply with neither is refused
 * one layer up (routes/journal.ts) — there is nothing to mirror.
 */
export function replyLine(
  patch: { subjective?: number | null; reflection?: string | null },
  at: Date,
): string {
  const felt =
    patch.subjective === undefined || patch.subjective === null
      ? ""
      : ` (felt ${patch.subjective}/10)`;
  const text = (patch.reflection ?? "").replace(/\s*\n+\s*/g, " ").trim();
  return `- ${berlinHhmm(at)} reply${felt}:${text ? ` ${text}` : ""}`;
}

/**
 * Append one line to `Journal/<day>.md`, creating the note when it is missing.
 *
 * The existing note is read and rewritten under compare-and-swap, so a
 * concurrent editor's bytes conflict loudly (VaultConflictError → 409 at the
 * route) instead of being silently overwritten. Only the READ is allowed to
 * fail with ENOENT; a failure from the write is a failure.
 */
export async function appendReplyToNote(day: Day, line: string): Promise<string> {
  const rel = journalNotePath(day);

  let current: { content: string; sha256: string } | null = null;
  try {
    const file = await readVaultFile(rel);
    current = { content: file.content, sha256: file.sha256 };
  } catch (e) {
    if (!isMissingFile(e)) throw e;
  }

  if (current) {
    const next = `${current.content.replace(/\s+$/, "")}\n${line}\n`;
    const written = await writeVaultFile({
      path: rel,
      content: next,
      baseSha256: current.sha256,
    });
    return written.path;
  }

  // createNote() never overwrites — it appends " 2", " 3" to the name on a
  // collision. That cannot happen here (we just observed ENOENT), but the path
  // it actually wrote is what gets reported, not the one we asked for.
  const created = await createNote({ title: day, folder: JOURNAL_DIR, content: line });
  return created.path;
}

/** The reply as it stands: `day_plans` for the state, the note for the mirror. */
export async function readJournalReply(day: Day): Promise<JournalReply> {
  const plan = await getPlan(day);

  let notePath: string | null = null;
  try {
    notePath = (await readVaultFile(journalNotePath(day))).path;
  } catch (e) {
    if (!isMissingFile(e)) throw e;
  }

  return {
    subjective: plan?.subjective ?? null,
    reflection: plan?.reflection ?? null,
    updated_at: plan?.updated_at ?? null,
    note_path: notePath,
  };
}

/**
 * Write the reply: `day_plans` first (it is the owner), then the note mirror.
 *
 * Order is deliberate. If the vault write fails the rating is already saved and
 * the caller is told the mirror failed — the reverse order could append a line
 * describing a rating that was never stored.
 */
export async function saveJournalReply(
  day: Day,
  patch: { subjective?: number | null; reflection?: string | null },
  now: Date = new Date(),
): Promise<JournalReply> {
  const plan = await reflect(day, patch);
  const notePath = await appendReplyToNote(day, replyLine(patch, now));

  return {
    subjective: plan.subjective ?? null,
    reflection: plan.reflection ?? null,
    updated_at: plan.updated_at ?? null,
    note_path: notePath,
  };
}
