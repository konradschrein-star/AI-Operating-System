# Migration numbering hygiene

## The defect

`db/migrations/` has two files sharing the number `0040`:

- `0040_task_graph.sql` (2026-08-18) — adds `depends_on`/`round`/`write_set` to `project_tasks`.
- `0040_usage_hourly.sql` (2026-08-17) — creates the `usage_hourly` rollup table.

Both are **already applied to production**, verified live: `usage_hourly` exists as a table and
`project_tasks` carries the three columns. This is latent debt, not an active outage — nothing is
broken today — but it is exactly the failure mode `scripts/checks/check-migration-numbers.ts`
exists to catch (see that file's header for the four-way `0043` collision that motivated the gate).

## Decision: do not renumber

We are **not** renumbering either file. Reasoning:

1. **Renumbering an applied migration is dangerous for no functional gain.** The number's only job
   is to order a *fresh* install. On a fresh install these two migrations are independent — one
   creates a standalone rollup table, the other adds columns to `project_tasks` — so their relative
   order does not matter and renumbering buys nothing.
2. **There is no free integer to move into.** `0039` and `0041` are both taken, so "renumber the
   later one" would require renumbering every migration from 0041 onward, which multiplies the
   blast radius for zero benefit.
3. **Rewriting migration history is exactly the kind of edit this fleet treats as high-risk**: any
   tracking mechanism that recorded these migrations by filename (a migrations-applied ledger, a
   deploy log, an operator's memory of what ran when) would silently desync from a renamed file.
   Proving that safe would cost more than the debt itself.

If this repo ever needs to prove renumbering is safe — for example if a future tool starts
ordering strictly by number and produces incorrect behavior with two 0040s — that proof must show
**both** of the following before a renumber lands:

- The migration-tracking table (whatever records which migrations have run) still shows both
  migrations as applied, addressed under their **original** filenames, after the rename — i.e. the
  tracker keys on content/checksum or an immutable id, not on a name that is about to change.
- A **fresh database**, migrated from empty through the renumbered sequence, ends in the same
  schema as a fresh database migrated through the current (colliding) sequence.

Absent that proof, the pair stays as recorded debt.

## The guard

`scripts/checks/check-migration-numbers.ts` (gate 8 of `scripts/checks/gates-808.sh`) enforces:

- Every migration filename matches `^(\d+)_.*\.sql$` — no unnumbered files.
- Every number is exactly 4 digits, zero-padded (`0041`, not `41` or `00041`).
- No two files share a number, **except** the exact `0040` pair above, tracked in
  `KNOWN_COLLISIONS` and matched by exact file-set equality — a third file landing on `0040`, or
  either of the two names changing, fails the gate immediately. The allowlist is pinned to the
  debt, not the number: it cannot be widened by adding more names to the same entry without a
  corresponding decision recorded here.

Unit coverage lives in `forge-control/src/lib/migration-numbers.test.ts` (`pnpm test`, part of the
forge-control suite that gate 8 and the wider `gates-808.sh` both depend on) and exercises the pure
validator (`validateMigrationFiles`), the filesystem-backed entry point
(`validateMigrationDir`/`MIGRATIONS_DIR`), the `isKnownDebt` allowlist matcher, and a CLI smoke test
that runs the script via `tsx` and asserts on its stdout.
