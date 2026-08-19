/**
 * What the Kanban board's query is allowed to select — the pure half of the
 * phase-6 board-payload fix (R73, R74).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT A `LIMIT` ────────────────────────
 *
 * The file name comes from the task brief, which anticipated a row `LIMIT` on
 * `listActiveTasks()`. The measurement (`docs/plan/artifacts/os-usable-for-work/
 * phase6/projects-lag-before.md §3`) ranked that fifth and refuted it:
 *
 *   "142 rows is nothing; 142 rows × every column including a 39,597-byte
 *    `brief` is everything. A LIMIT alone would cap a number that is not the
 *    problem and would silently drop cards off the board."
 *
 * A row cap is also a direct R75 violation — every active/blocked task must stay
 * reachable. So the cap this file implements is a cap on COLUMNS, not on rows:
 * the board query selects every row and drops the one column no card renders.
 * Measured: `brief` is 88.2% of a 1,843,144-byte response that the board renders
 * 34,834 bytes of.
 *
 * ── WHY A PURE FUNCTION AND NOT A HAND-WRITTEN SECOND COLUMN LIST ────────────
 *
 * `TASK_COLS_PT` in db/projects.ts already carries this doc-comment: "a new
 * column can never again be added to TASK_COLS and silently forgotten in a
 * hand-written joined SELECT". A second hand-written list for the board would
 * reintroduce exactly that drift — a column added to `TASK_COLS_PT` would be
 * absent from the board and nothing would say so. So the board list is DERIVED
 * from the canonical one by removing named columns, and every way that
 * derivation can go quietly wrong is a thrown error here:
 *
 *   • an omitted column that is not in the list  → throws. This is the one that
 *     matters: rename `brief` and a silent no-op would restore the whole
 *     1.8 MB payload with nobody noticing until someone re-measured.
 *   • a column the board needs going missing     → throws, naming it.
 *   • an entry that is not a plain column        → throws, rather than being
 *     passed through to Postgres to be interpreted.
 *
 * ── WHAT MAY NOT BE OMITTED ─────────────────────────────────────────────────
 *
 * `depends_on`, `workstream` and `write_set` are 8.1%, ~0% and 0.9% of the
 * payload and are NOT dropped, because engine-task-graph **R56** requires
 * `GET /api/projects/board` to carry all three on every task. They are listed in
 * BOARD_REQUIRED_COLUMNS so that requirement is enforced by a test instead of
 * remembered.
 *
 * Pure: no DB, no clock, no I/O — so `src/lib/projects-board-limit.test.ts`
 * table-drives it directly (N2).
 */

/** Thrown for every projection the board refuses to build. Never swallowed and
 *  never softened into a default column list: a board query built from a
 *  half-understood list is how a surface starts rendering rows with holes in
 *  them (N1). */
export class BoardColumnProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardColumnProjectionError";
  }
}

/**
 * The columns dropped from the board feed.
 *
 * ONLY `brief`. It is the only column that is both large and unread by the
 * board: `TaskCard` (ProjectsSurface.tsx:476) reads status/round/fix_cycle/
 * title/project_name/updated_at plus id/role/run_id, and the single `brief`
 * read in the whole surface is `TaskDetail`'s fallback for a task with no run
 * yet — one string, of one selected task, which is a fetch-on-select
 * (`GET /api/tasks/:id`), not a field on 149 cards.
 */
export const BOARD_OMITTED_COLUMNS = ["brief"] as const;

/**
 * Columns the board feed must still carry after the projection, and why:
 *
 *  - id, project_id, role, status, run_id, round, fix_cycle, title, updated_at
 *    — rendered by `TaskCard`, or used to key/select/filter it;
 *  - created_at — part of the row shape every other consumer of
 *    `ProjectTaskWithProject` types against;
 *  - depends_on, workstream, write_set — **R56**, which names this endpoint;
 *  - tier, attempt, chain_key, graph_frozen — not rendered today, but tiny
 *    (0.1% of the payload combined) and part of the published row shape. They
 *    are listed here so that dropping one is a deliberate edit to this constant
 *    rather than an accident in a SQL string.
 */
export const BOARD_REQUIRED_COLUMNS = [
  "id",
  "project_id",
  "round",
  "role",
  "title",
  "status",
  "run_id",
  "fix_cycle",
  "tier",
  "attempt",
  "chain_key",
  "depends_on",
  "workstream",
  "write_set",
  "graph_frozen",
  "created_at",
  "updated_at",
] as const;

/**
 * Split a SQL select list on its top-level commas.
 *
 * Paren-depth aware, so a `coalesce(a, b)` or a sub-select added to the list
 * later does not get cut in half. Whitespace (including the newlines the
 * constants in db/projects.ts are written with) is collapsed per entry.
 */
export function splitSelectList(columnList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of columnList) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  if (depth !== 0) {
    throw new BoardColumnProjectionError(
      `unbalanced parentheses in select list (depth ${depth} at end): ${columnList.replace(/\s+/g, " ").trim()}`,
    );
  }
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
}

/**
 * The bare column name of one select-list entry: `pt.depends_on::text[]` →
 * `depends_on`, `pt.id::text` → `id`, `round` → `round`.
 *
 * @throws {BoardColumnProjectionError} for anything that is not a (optionally
 *         table-qualified, optionally cast) plain column — a function call, an
 *         `AS` alias, a literal. Those may be perfectly valid SQL, but this
 *         function's callers reason about the result as a set of column names,
 *         and guessing a name for an expression is how that reasoning goes
 *         wrong silently.
 */
export function selectEntryColumnName(entry: string): string {
  const m = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)((?:::[A-Za-z0-9_ ]+(?:\[\])?)*)$/.exec(
    entry.trim(),
  );
  if (!m) {
    throw new BoardColumnProjectionError(
      `select-list entry ${JSON.stringify(entry)} is not a plain (optionally qualified, optionally cast) ` +
        `column. The board projection only knows how to reason about column names; ` +
        `an expression must be added to the query by hand, not routed through this function.`,
    );
  }
  return m[2];
}

/** Every column name in a select list, in order. */
export function selectListColumnNames(columnList: string): string[] {
  return splitSelectList(columnList).map(selectEntryColumnName);
}

/**
 * Remove `omit` from a SQL select list, preserving the order, the qualifiers and
 * the casts of everything that stays.
 *
 * @throws {BoardColumnProjectionError} when a name in `omit` is not present in
 *         the list. A rename upstream must break loudly here rather than turn
 *         this into a no-op that quietly restores the payload it exists to
 *         remove.
 */
export function omitSelectColumns(columnList: string, omit: readonly string[]): string {
  const entries = splitSelectList(columnList);
  const names = entries.map(selectEntryColumnName);
  const missing = omit.filter((o) => !names.includes(o));
  if (missing.length > 0) {
    throw new BoardColumnProjectionError(
      `cannot omit ${missing.map((m) => JSON.stringify(m)).join(", ")} from the select list: ` +
        `not present. Present columns: ${names.join(", ")}. ` +
        `If a column was renamed, rename it in BOARD_OMITTED_COLUMNS too — a silent no-op here ` +
        `restores the full board payload (1.8 MB per poll, phase6/projects-lag-before.md §2.1).`,
    );
  }
  const kept = entries.filter((_, i) => !omit.includes(names[i]));
  if (kept.length === 0) {
    throw new BoardColumnProjectionError("the projection removed every column from the select list");
  }
  return kept.join(", ");
}

/**
 * The board feed's select list, derived from the canonical task column list.
 *
 * @param taskColumnList `TASK_COLS_PT` from db/projects.ts — the joined,
 *        `pt.`-qualified list, which is the only one the board's query can use.
 * @throws {BoardColumnProjectionError} if a column in BOARD_REQUIRED_COLUMNS is
 *         not in the input, or if an omitted column is not in the input.
 */
export function projectBoardColumns(taskColumnList: string): string {
  const present = selectListColumnNames(taskColumnList);
  const missingRequired = BOARD_REQUIRED_COLUMNS.filter((c) => !present.includes(c));
  if (missingRequired.length > 0) {
    throw new BoardColumnProjectionError(
      `the board feed requires ${missingRequired.join(", ")}, which the task column list does not carry. ` +
        `depends_on, workstream and write_set are required by R56 (GET /api/projects/board carries all ` +
        `three on every task); the rest are rendered by TaskCard or part of the published row shape.`,
    );
  }
  return omitSelectColumns(taskColumnList, BOARD_OMITTED_COLUMNS);
}
