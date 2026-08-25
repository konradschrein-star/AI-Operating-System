/**
 * The mentor's read of the day — the thing the JOURNAL page opens on.
 *
 * Source of truth is `Mentor/log.md` in the vault, whose entries are `##`
 * headings dated `YYYY-MM-DD`, sometimes with a suffix
 * (`## 2026-08-16 (weekly review — Sunday)`). The suffix is kept for display and
 * ignored for matching.
 *
 * Selection: the entry FOR the day if there is one, otherwise the most recent
 * entry BEFORE it, with `stale_days` saying how far back that was. Never blank —
 * an empty log still returns a row carrying `last_cron_fired_at`, because the
 * honest answer to "why is there nothing here" is usually "the evening mentor
 * cron has not fired since <date>".
 *
 * That is not hypothetical: `mentor-evening`, `mentor-morning` and
 * `weekly-review` are all `enabled = false` in `cron_schedules` (R1 §j), which
 * is exactly why the log and `mentor_metrics` both stop at 2026-08-22. This
 * surface reports the last fire; re-enabling the cron is Konrad's call, not
 * something an evidence reader does on his behalf.
 */

import { readVaultFile } from "../vault.ts";
import { query } from "../../db/journal-day.ts";
import { currentStreak } from "../../db/mentor.ts";
import { listSchedules } from "../../db/cron.ts";
import { daysBetween, type Day } from "../day-score.ts";

/** Vault-relative. Overridable for tests; the vault root itself comes from
 *  OBSIDIAN_VAULT_DIR inside lib/vault.ts. */
const MENTOR_LOG = process.env.VAULT_MENTOR_LOG ?? "Mentor/log.md";

/** The cron whose fires write both the log entry and the metrics row. */
const MENTOR_CRON = "mentor-evening";

export interface MentorMetrics {
  committed: number;
  completed: number;
  notes: string | null;
}

export interface MentorRead {
  /** The entry's body, or null when the log holds no entry at or before `day`. */
  verdict: string | null;
  /** The day the entry is dated, which may be earlier than `day`. */
  log_day: Day | null;
  /** Days between `log_day` and `day`; 0 for an exact hit, null for no entry. */
  stale_days: number | null;
  metrics: MentorMetrics | null;
  streak: number;
  last_cron_fired_at: string | null;
}

/** `## 2026-08-22` or `## 2026-08-16 (weekly review — Sunday)`. */
const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})(.*)$/;

export interface MentorEntry {
  day: Day;
  /** The heading's trailing text, e.g. " (weekly review — Sunday)". */
  suffix: string;
  body: string;
}

/**
 * Split the log into entries. Pure, exported, and tested: the picking rule is
 * the part of this module most likely to be wrong, and it needs no vault.
 */
export function parseMentorLog(markdown: string): MentorEntry[] {
  const lines = markdown.split("\n");
  const entries: MentorEntry[] = [];
  let current: { day: Day; suffix: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      if (current) entries.push({ day: current.day, suffix: current.suffix, body: current.body.join("\n").trim() });
      current = { day: m[1], suffix: m[2] ?? "", body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push({ day: current.day, suffix: current.suffix, body: current.body.join("\n").trim() });

  return entries;
}

/** The entry for `day`, else the latest one before it, else null. */
export function pickMentorEntry(entries: readonly MentorEntry[], day: Day): MentorEntry | null {
  let best: MentorEntry | null = null;
  for (const entry of entries) {
    if (entry.day > day) continue;
    if (entry.day === day) return entry;
    if (!best || entry.day > best.day) best = entry;
  }
  return best;
}

function isMissingFile(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

interface MetricsRow {
  committed: number;
  completed: number;
  notes: string | null;
}

export async function mentorRead(day: Day): Promise<MentorRead> {
  let markdown: string | null = null;
  try {
    markdown = (await readVaultFile(MENTOR_LOG)).content;
  } catch (e) {
    // A vault with no mentor log at all is a state to REPORT, not a failure —
    // the card still has the cron's last fire to show. Any other errno (EACCES,
    // EIO) is a real failure and rejects into errors[].
    if (!isMissingFile(e)) throw e;
  }

  const entry = markdown === null ? null : pickMentorEntry(parseMentorLog(markdown), day);

  const [metrics, streak, schedules] = await Promise.all([
    query<MetricsRow>(
      `SELECT committed, completed, notes FROM mentor_metrics WHERE day = $1::date`,
      [day],
    ),
    currentStreak(),
    listSchedules(),
  ]);

  const cron = schedules.find((s) => s.name === MENTOR_CRON) ?? null;

  return {
    verdict: entry ? `${entry.body}` : null,
    log_day: entry?.day ?? null,
    stale_days: entry ? daysBetween(entry.day, day) : null,
    metrics: metrics[0] ?? null,
    streak,
    last_cron_fired_at: cron?.last_run_at ?? null,
  };
}
