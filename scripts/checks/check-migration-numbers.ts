/**
 * Two migrations must never share a number.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Measured 2026-08-23: FOUR different migrations were all called `0043`, each
 * sitting in a different lane's worktree, each invisible to the others:
 *
 *   0043_gemini_tier.sql          (main)
 *   0043_goals_and_calendar.sql   (aios-goals-day-system)
 *   0043_journal_entries.sql      (aios-journal-and-mentor)
 *   0043_task_graph.sql           (engine-task-graph)
 *
 * Git does not conflict on this — the filenames differ, so all four merge
 * cleanly into one directory and the collision only shows up when a runner
 * orders by number and silently picks one, skips another, or applies them in an
 * order nobody chose. The vault's operator log records this happening three
 * times before today; today was the fourth.
 *
 * The failure is quiet and lands in a database, which is the one place this
 * codebase cannot roll back with `git checkout`. Hence a gate rather than a
 * convention.
 *
 * ── WHAT IT CHECKS ───────────────────────────────────────────────────────────
 * 1. No two files in db/migrations/ share a leading number.
 * 2. Numbers are 4 digits, zero-padded — `43_x.sql` sorts before `0100_y.sql`
 *    in some runners and after it in others.
 *
 * It deliberately does NOT check that migrations were APPLIED. That is a
 * different failure (measured the same day: 0043_journal_entries.sql carried a
 * committed comment claiming it had been applied by hand twice, and the table
 * did not exist in production) and it needs a live database, which a static
 * gate must not require.
 *
 * Exit 0 = every number unique. Exit 1 = collision, naming both files.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);

export const NUMBERED = /^(\d+)_.*\.sql$/;

/* ── KNOWN DEBT: one historical collision, recorded rather than rewritten ─────
 *
 * `0040_usage_hourly.sql` (2026-08-17) and `0040_task_graph.sql` (2026-08-18)
 * both shipped as 0040. **Both are already applied to production** — verified
 * live: `usage_hourly` and `project_tasks` both exist. There is no free integer
 * between 0040 and 0041 to move the later one into, and renumbering an applied
 * migration rewrites history for no functional gain: the number only orders a
 * FRESH install, and on a fresh install these two are independent (one creates
 * a rollup table, the other adds columns to `project_tasks`).
 *
 * So it is listed, not fixed — the same contract as the raw-colour allowlist:
 * pinned to the exact pair, so a THIRD file landing on 0040 still fails. This
 * entry is the only thing standing between this gate and being green, and it
 * must not grow. If you are about to add a line here, renumber instead. */
export const KNOWN_COLLISIONS = new Map<string, string[]>([
  ["0040", ["0040_task_graph.sql", "0040_usage_hourly.sql"]],
]);

/** A collision is excused only if the file set matches EXACTLY. A new file
 *  joining a known-debt number is a new collision. */
export function isKnownDebt(
  n: string,
  files: string[],
  knownMap: Map<string, string[]> = KNOWN_COLLISIONS,
): boolean {
  const known = knownMap.get(n);
  if (!known || known.length !== files.length) return false;
  const a = [...known].sort();
  const b = [...files].sort();
  return a.every((f, i) => f === b[i]);
}

export interface MigrationCheckResult {
  ok: boolean;
  exitCode: number;
  files: string[];
  byNumber: Map<string, string[]>;
  unnumbered: string[];
  badWidth: string[];
  collisions: Array<[string, string[]]>;
  excused: Array<[string, string[]]>;
  highest?: string;
  errors: string[];
  logs: string[];
}

/** Pure validator for a given list of .sql migration filenames. */
export function validateMigrationFiles(
  files: string[],
  knownMap: Map<string, string[]> = KNOWN_COLLISIONS,
): MigrationCheckResult {
  const sortedFiles = [...files].sort();
  const errors: string[] = [];
  const logs: string[] = [];

  if (sortedFiles.length === 0) {
    errors.push("found 0 .sql files — refusing to pass on empty migration set");
    return {
      ok: false,
      exitCode: 1,
      files: sortedFiles,
      byNumber: new Map(),
      unnumbered: [],
      badWidth: [],
      collisions: [],
      excused: [],
      errors,
      logs,
    };
  }

  const byNumber = new Map<string, string[]>();
  const unnumbered: string[] = [];
  const badWidth: string[] = [];

  for (const f of sortedFiles) {
    const m = NUMBERED.exec(f);
    if (!m) {
      unnumbered.push(f);
      continue;
    }
    const n = m[1];
    if (n.length !== 4) badWidth.push(f);
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }

  const allCollisions = [...byNumber.entries()].filter(([, fs]) => fs.length > 1);
  const collisions = allCollisions.filter(([n, fs]) => !isKnownDebt(n, fs, knownMap));
  const excused = allCollisions.filter(([n, fs]) => isKnownDebt(n, fs, knownMap));

  for (const [n, fs] of excused) {
    logs.push(`known debt  ${n}: ${fs.join("  ↔  ")} — both already applied to production`);
  }

  for (const f of unnumbered) {
    errors.push(`UNNUMBERED  ${f} — cannot be ordered against the others`);
  }
  for (const f of badWidth) {
    errors.push(`BAD WIDTH   ${f} — numbers must be 4 digits, zero-padded`);
  }
  for (const [n, fs] of collisions) {
    errors.push(`COLLISION   ${n}: ${fs.join("  ↔  ")}`);
  }

  const failedCount = collisions.length + unnumbered.length + badWidth.length;
  const ok = failedCount === 0;
  const highest = [...byNumber.keys()].sort().pop();

  if (!ok) {
    errors.push(
      `FAIL — ${collisions.length} collision(s), ` +
        `${unnumbered.length} unnumbered, ${badWidth.length} bad width, over ${sortedFiles.length} file(s). ` +
        "Renumber to the next free integer. Git will NOT conflict on this for you.",
    );
  } else {
    logs.push(
      `PASS — ${sortedFiles.length} migration(s), every number unique, highest ${highest}.`,
    );
  }

  return {
    ok,
    exitCode: ok ? 0 : 1,
    files: sortedFiles,
    byNumber,
    unnumbered,
    badWidth,
    collisions,
    excused,
    highest,
    errors,
    logs,
  };
}

/** Validate migration files on disk from directory. */
export function validateMigrationDir(
  dirPath: string = MIGRATIONS_DIR,
  knownMap: Map<string, string[]> = KNOWN_COLLISIONS,
): MigrationCheckResult {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".sql"));
  } catch (e) {
    return {
      ok: false,
      exitCode: 1,
      files: [],
      byNumber: new Map(),
      unnumbered: [],
      badWidth: [],
      collisions: [],
      excused: [],
      errors: [`cannot read ${dirPath}: ${String(e)}`],
      logs: [],
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      files: [],
      byNumber: new Map(),
      unnumbered: [],
      badWidth: [],
      collisions: [],
      excused: [],
      errors: [
        `check-migration-numbers: found 0 .sql files in ${dirPath} — ` +
          "that reads as a moved directory, not an empty one. Refusing to pass.",
      ],
      logs: [],
    };
  }

  return validateMigrationFiles(files, knownMap);
}

export function main(dirPath: string = MIGRATIONS_DIR): number {
  const result = validateMigrationDir(dirPath);

  for (const log of result.logs) {
    if (log.startsWith("known debt")) {
      console.log(`  ${log}`);
    } else {
      console.log(`check-migration-numbers: ${log}`);
    }
  }

  for (const err of result.errors) {
    if (err.startsWith("UNNUMBERED") || err.startsWith("BAD WIDTH") || err.startsWith("COLLISION")) {
      console.error(`  ${err}`);
    } else {
      console.error(`check-migration-numbers: ${err}`);
    }
  }

  return result.exitCode;
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  (fileURLToPath(import.meta.url) === process.argv[1] ||
    resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exit(main());
}
