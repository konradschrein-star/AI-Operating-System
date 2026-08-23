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
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);

const NUMBERED = /^(\d+)_.*\.sql$/;

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
const KNOWN_COLLISIONS = new Map<string, string[]>([
  ["0040", ["0040_task_graph.sql", "0040_usage_hourly.sql"]],
]);

/** A collision is excused only if the file set matches EXACTLY. A new file
 *  joining a known-debt number is a new collision. */
function isKnownDebt(n: string, files: string[]): boolean {
  const known = KNOWN_COLLISIONS.get(n);
  if (!known || known.length !== files.length) return false;
  const a = [...known].sort();
  const b = [...files].sort();
  return a.every((f, i) => f === b[i]);
}

function main(): number {
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  } catch (e) {
    console.error(`check-migration-numbers: cannot read ${MIGRATIONS_DIR}: ${String(e)}`);
    return 1;
  }

  if (files.length === 0) {
    // An empty directory means the path moved, not that the repo has no
    // migrations. Refusing beats reporting a vacuous pass.
    console.error(
      `check-migration-numbers: found 0 .sql files in ${MIGRATIONS_DIR} — ` +
        "that reads as a moved directory, not an empty one. Refusing to pass.",
    );
    return 1;
  }

  const byNumber = new Map<string, string[]>();
  const unnumbered: string[] = [];
  const badWidth: string[] = [];

  for (const f of files) {
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
  const collisions = allCollisions.filter(([n, fs]) => !isKnownDebt(n, fs));
  const excused = allCollisions.filter(([n, fs]) => isKnownDebt(n, fs));
  for (const [n, fs] of excused) {
    console.log(`  known debt  ${n}: ${fs.join("  ↔  ")} — both already applied to production`);
  }

  for (const f of unnumbered) {
    console.error(`  UNNUMBERED  ${f} — cannot be ordered against the others`);
  }
  for (const f of badWidth) {
    console.error(`  BAD WIDTH   ${f} — numbers must be 4 digits, zero-padded`);
  }
  for (const [n, fs] of collisions) {
    console.error(`  COLLISION   ${n}: ${fs.join("  ↔  ")}`);
  }

  const failed = collisions.length + unnumbered.length + badWidth.length;
  if (failed > 0) {
    console.error(
      `\ncheck-migration-numbers: FAIL — ${collisions.length} collision(s), ` +
        `${unnumbered.length} unnumbered, ${badWidth.length} bad width, over ${files.length} file(s).\n` +
        "Renumber to the next free integer. Git will NOT conflict on this for you:\n" +
        "the filenames differ, so colliding migrations merge cleanly and only fail\n" +
        "later, inside a database, where there is no `git checkout` to undo it.",
    );
    return 1;
  }

  const highest = [...byNumber.keys()].sort().pop();
  console.log(
    `check-migration-numbers: PASS — ${files.length} migration(s), every number unique, highest ${highest}.`,
  );
  return 0;
}

process.exit(main());
