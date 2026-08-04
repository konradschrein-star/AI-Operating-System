#!/usr/bin/env -S node --import tsx
/**
 * import-scraper-places.ts — one-way sync from the acquisition scraper into
 * the identity registry on ai_os :5434. Phase 3 (import half) of the CRM
 * Integration Plan.
 *
 * WHAT THIS IS NOT: a Twenty importer, a pipeline modeller, or anything that
 * touches deal stages. Spec §9 Q3 (stages / outreach owner / definition of
 * won) is unanswered and modelling it is explicitly out of scope. This script
 * populates entities + entity_links + events ONLY — the seam is what proves
 * dedupe works before the CRM is layered on top.
 *
 * SOURCE: sqlite at /opt/acquisition-console/data/console.db on VPS2
 *   (root@167.233.145.218, keyed by /root/.ssh/vps2_mgmt). Read-only. We reach
 *   it by shelling out to `ssh ... sqlite3 -json ...` in batches keyed on the
 *   sqlite rowid — that avoids OFFSET's O(N) cost as we deepen into a
 *   271k-row table and keeps memory bounded to one batch at a time.
 *
 * TARGET: entities (kind='company', arm='directory') + entity_links
 *   (system='scraper', external_id = places.ref) + events
 *   (system='scraper', verb='business.imported' | 'business.renamed').
 *   Dedupe is enforced by the UNIQUE(system, external_id) constraint from
 *   0003_entities.sql, NOT by name matching. Names change; ref does not.
 *
 * IDEMPOTENCY: running this twice over the same input MUST yield the same
 * row count. The acceptance test in the accompanying .sh script proves that.
 *
 * UPDATE POLICY: if a business is seen again with a changed name, the
 * existing entity is renamed in place. See renameEntity() in db/entities.ts
 * for the reasoning — replacing on rename would orphan every link, ledger
 * row and event that already resolves to the old id, which is the exact
 * fork the registry exists to prevent.
 *
 * USAGE:
 *   AI_OS_DATABASE_URL=... \
 *     node --import tsx scripts/import-scraper-places.ts [--limit N] [--batch N]
 *
 *   --limit N   process only the first N rows by sqlite rowid (default: all)
 *   --batch N   batch size for the ssh+sqlite fetch (default: 1000)
 *   --dry-run   fetch and count but do not write to ai_os
 *
 * The importer is bounded on memory (one batch at a time), bounded on ssh
 * fanout (one child process per batch, waited on), and bounded on DB
 * connections (aiOsPool caps at 4). Safe to run against the full 271,758-row
 * table without a babysitter.
 */

import { spawn } from "node:child_process";
import { aiOsPool } from "../forge-control/src/db/ai-os-pool.ts";
import {
  createEntity,
  getEntityByExternal,
  linkEntity,
  renameEntity,
  appendEvent,
} from "../forge-control/src/db/entities.ts";

// The environment file that pm2 uses. Loaded manually because this script is
// invoked outside of pm2 (as a one-shot, and by the acceptance test). Missing
// AI_OS_DATABASE_URL throws deliberately in aiOsPool(); we do NOT paper over
// it with a content_forge fallback — that would silently write to the wrong
// database (see db/ai-os-pool.ts header).
import { readFileSync } from "node:fs";
try {
  const raw = readFileSync("/opt/ai-os/.secrets/forge-control.env", "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = s.slice(i + 1).trim();
  }
} catch (err) {
  // Not fatal — the caller may have exported AI_OS_DATABASE_URL directly.
  // aiOsPool() will throw with a useful diagnostic if it is still missing.
  console.warn(
    `[import-scraper-places] could not read secrets file: ${
      (err as Error).message
    }`,
  );
}

// ─── args ────────────────────────────────────────────────────────────────────

interface Args {
  limit: number | null;
  batch: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: null, batch: 1000, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit expects a positive integer, got ${argv[i]}`);
      }
      out.limit = n;
    } else if (a === "--batch") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--batch expects a positive integer, got ${argv[i]}`);
      }
      out.batch = n;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: import-scraper-places.ts [--limit N] [--batch N] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

// ─── source (SQLite on VPS2 over ssh) ────────────────────────────────────────

const VPS2_SSH_KEY = "/root/.ssh/vps2_mgmt";
const VPS2_TARGET = "root@167.233.145.218";
const VPS2_DB = "/opt/acquisition-console/data/console.db";

interface PlaceRow {
  id: number;
  ref: string;
  name: string;
}

/** Fetch one batch of rows from VPS2. Keyset pagination on sqlite rowid
 *  (`WHERE id > $afterId ORDER BY id LIMIT N`), which is stable under
 *  concurrent inserts and does not degrade with depth the way OFFSET does. */
async function fetchBatch(afterId: number, size: number): Promise<PlaceRow[]> {
  // Column list is deliberately narrow: we import identity (ref, name), not
  // the whole scraped payload. Everything else — website, address, phone —
  // stays in the scraper's sqlite where it can be re-scraped without a
  // migration on ai_os. If a future phase needs to enrich entities with
  // structured fields, that is a separate join, not a wider import.
  const sql =
    `SELECT id, ref, name FROM places ` +
    `WHERE id > ${afterId} ORDER BY id LIMIT ${size}`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        VPS2_SSH_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        VPS2_TARGET,
        `sqlite3 -json ${VPS2_DB} ${JSON.stringify(sql)}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `ssh+sqlite3 exited ${code}: ${
              Buffer.concat(errChunks).toString().trim()
            }`,
          ),
        );
      }
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw) return resolve([]); // sqlite3 -json emits nothing when 0 rows
      try {
        const parsed = JSON.parse(raw) as PlaceRow[];
        resolve(parsed);
      } catch (err) {
        reject(
          new Error(
            `could not parse sqlite3 -json output (${raw.length} bytes): ${
              (err as Error).message
            }`,
          ),
        );
      }
    });
  });
}

// ─── importer ────────────────────────────────────────────────────────────────

interface Stats {
  scanned: number;
  inserted: number;
  renamed: number;
  unchanged: number;
  skipped: number;
}

/**
 * Import one row. Split into three cases so the counters match what the
 * acceptance test needs to prove:
 *
 *   inserted  — new entity + new link + one event
 *   renamed   — same entity id, display_name updated, one event
 *   unchanged — no writes at all (this is the case that must dominate on
 *               the second run; it is what "idempotent" means here)
 *
 * `skipped` catches rows the scraper produced without a name — the entities
 * schema requires display_name NOT NULL, so we cannot invent one, and we
 * refuse to substitute the ref as a name (that would pollute the display
 * layer with URLs and slugs). Skipped rows are counted, not logged noisily.
 */
async function importOne(row: PlaceRow, dryRun: boolean): Promise<keyof Stats> {
  const ref = row.ref?.trim();
  const name = row.name?.trim();
  if (!ref || !name) return "skipped";

  const existing = await getEntityByExternal("scraper", ref);

  if (existing) {
    if (existing.displayName === name) return "unchanged";
    if (dryRun) return "renamed";
    const updated = await renameEntity(existing.id, name);
    if (!updated) {
      // The FOR UPDATE would tell us this too, but we run without a
      // transaction here for throughput; a null return means the row was
      // deleted between the lookup and the update. That is not a case the
      // current schema can produce (nothing deletes entities), so treat it
      // as a bug worth surfacing.
      throw new Error(
        `renameEntity returned null for id=${existing.id} ref=${ref} — ` +
          `entity vanished mid-import; investigate before rerunning`,
      );
    }
    await appendEvent({
      system: "scraper",
      verb: "business.renamed",
      entityId: existing.id,
      subject: `${existing.displayName} → ${name}`,
      payload: { ref, from: existing.displayName, to: name },
    });
    return "renamed";
  }

  if (dryRun) return "inserted";

  const entity = await createEntity({
    kind: "company",
    displayName: name,
    arm: "directory",
  });
  const linked = await linkEntity({
    entityId: entity.id,
    system: "scraper",
    externalId: ref,
  });
  if (linked.conflict) {
    // The link now points at a DIFFERENT entity than the one we just made.
    // That can only happen if a concurrent importer beat us to it, in which
    // case we have orphaned a fresh entity row. Fail loudly rather than
    // paper over it — the corrective action is a manual DELETE against the
    // orphan and a rerun, not a silent continue.
    throw new Error(
      `link conflict for ref=${ref}: created entity=${entity.id} but link ` +
        `points to entity=${linked.link.entityId}. Concurrent importer? ` +
        `Delete the orphan and rerun.`,
    );
  }
  await appendEvent({
    system: "scraper",
    verb: "business.imported",
    entityId: entity.id,
    subject: name,
    payload: { ref, source: "acquisition-console" },
  });
  return "inserted";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stats: Stats = {
    scanned: 0,
    inserted: 0,
    renamed: 0,
    unchanged: 0,
    skipped: 0,
  };

  const startedAt = Date.now();
  console.log(
    `[import-scraper-places] start limit=${
      args.limit ?? "all"
    } batch=${args.batch} dry-run=${args.dryRun}`,
  );

  let afterId = 0;
  while (true) {
    const remaining =
      args.limit === null ? args.batch : args.limit - stats.scanned;
    if (args.limit !== null && remaining <= 0) break;
    const size = Math.min(args.batch, remaining);

    const batch = await fetchBatch(afterId, size);
    if (batch.length === 0) break;

    for (const row of batch) {
      const outcome = await importOne(row, args.dryRun);
      stats[outcome]++;
      stats.scanned++;
      afterId = Math.max(afterId, row.id);
      if (args.limit !== null && stats.scanned >= args.limit) break;
    }

    // Small heartbeat so a long run is visibly making progress. One line per
    // batch is enough — noisier logging would drown the summary that
    // matters.
    console.log(
      `[import-scraper-places] batch afterId=${afterId} ` +
        `scanned=${stats.scanned} +ins=${stats.inserted} ` +
        `+ren=${stats.renamed} =unch=${stats.unchanged} skip=${stats.skipped}`,
    );

    if (args.limit !== null && stats.scanned >= args.limit) break;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[import-scraper-places] done in ${elapsedMs}ms — ` +
      `scanned=${stats.scanned} inserted=${stats.inserted} ` +
      `renamed=${stats.renamed} unchanged=${stats.unchanged} ` +
      `skipped=${stats.skipped}`,
  );

  // Print machine-readable summary on the last line so the acceptance test
  // can parse it without brittle regex on the human line.
  console.log(`RESULT ${JSON.stringify(stats)}`);

  // The aiOsPool is process-scoped; end it so node exits cleanly.
  await aiOsPool().end();
}

main().catch((err) => {
  console.error("[import-scraper-places] FATAL", err);
  process.exit(1);
});
