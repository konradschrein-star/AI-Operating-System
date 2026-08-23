#!/usr/bin/env -S node --import tsx
/**
 * verify-vault-search.ts — round 2 of aios-vault-and-search: Excalidraw
 * indexing backfill + before/after search verification.
 *
 * Runs the SAME 10 queries through searchMemory() — the exact function
 * behind GET /api/memory/search, which MemorySurface.tsx calls via
 * searchMemoryExpanded() — once before and once after syncVaultNotes(), the
 * real backfill (writes hcp.knowledge_note + content_forge.knowledge_embeddings
 * against the live database and the live embed sidecar at :8766). Prints one
 * JSON report to stdout; docs/plan/artifacts/search-before-after.md is
 * written FROM that JSON, not retyped by hand, so the two cannot drift.
 *
 * This talks to the real Postgres instance and the real embed sidecar —
 * shared infra, not the live forge-control process (see
 * forge-control-probe-single-router memory: mounting src/index.ts a second
 * time would start a second cron/telegram/vault-sync tick; this script
 * imports db/memory.ts directly and starts nothing). It does NOT touch
 * /opt/forge-ai-os and does NOT restart pm2.
 *
 *   cd <worktree> && npx tsx scripts/verify-vault-search.ts > /tmp/vault-search-report.json
 *
 * DATABASE_URL / HCP_DATABASE_URL default to the real content_forge/hcp
 * instance inside db/memory.ts — see the forge-control-runs-db memory note
 * before pointing this at anything else.
 */
import {
  syncVaultNotes,
  searchMemory,
  indexHealth,
  noteCounts,
  type SearchHit,
} from "../forge-control/src/db/memory.ts";

interface QueryCase {
  label: string;
  q: string;
  kind:
    | "exact_title"
    | "empty_note"
    | "frontmatter_only"
    | "excalidraw_title"
    | "excalidraw_content"
    | "semantic";
}

// 10 core cases spanning the categories the brief names: exact titles
// (should rank #1 per R-search), empty notes (must be findable + marked
// empty, not silently absent), a frontmatter-only note, Excalidraw notes by
// their filename-derived title AND by text drawn inside them, and free-form
// semantic queries with no exact string match anywhere in the vault.
const QUERIES: QueryCase[] = [
  { label: "exact-title-spec", q: "Spec - Manager Chat UI v3", kind: "exact_title" },
  { label: "exact-title-operator-decisions", q: "Operator Decisions", kind: "exact_title" },
  { label: "empty-note-help-from-harry", q: "Help from Harry", kind: "empty_note" },
  { label: "empty-note-documented-conflicts", q: "Documented Conflicts", kind: "empty_note" },
  { label: "frontmatter-only-brand-guidelines", q: "brand guidelines", kind: "frontmatter_only" },
  { label: "excalidraw-title-stealth-system-map", q: "Stealth Uploader - System Map", kind: "excalidraw_title" },
  { label: "excalidraw-title-planning-canvas", q: "AI OS - Life & Company OS - Planning Canvas", kind: "excalidraw_title" },
  { label: "excalidraw-content-warming-jar", q: "warming the jar fingerprint stable", kind: "excalidraw_content" },
  { label: "semantic-executor-timeout", q: "how does the executor recover from a stuck run", kind: "semantic" },
  { label: "semantic-search-broken", q: "why does vault search return nothing for a title", kind: "semantic" },
];

function summarizeHit(h: SearchHit) {
  return {
    vault_path: h.vault_path,
    title: h.title,
    score: Number(h.score.toFixed(4)),
    match_type: h.match_type ?? null,
    match_reason: h.match_reason ?? null,
    is_empty: h.is_empty ?? false,
  };
}

async function runPass() {
  const out: Record<string, unknown> = {};
  for (const { label, q, kind } of QUERIES) {
    const hits = await searchMemory(q, 5, {});
    out[label] = {
      q,
      kind,
      count: hits.length,
      top: hits.slice(0, 3).map(summarizeHit),
    };
  }
  return out;
}

async function main() {
  const before = await runPass();
  const healthBefore = await indexHealth();
  const countsBefore = await noteCounts();
  console.error(
    `[verify-vault-search] BEFORE: embedded_files=${countsBefore.embedded_files} ` +
      `unexplained=${healthBefore.unexplained_count} excalidraw_excluded=${countsBefore.excluded.excalidraw}`,
  );

  console.error("[verify-vault-search] running syncVaultNotes() backfill against the live DB...");
  const sync = await syncVaultNotes();
  console.error(`[verify-vault-search] sync result: ${JSON.stringify(sync)}`);

  const after = await runPass();
  const healthAfter = await indexHealth();
  const countsAfter = await noteCounts();
  console.error(
    `[verify-vault-search] AFTER: embedded_files=${countsAfter.embedded_files} ` +
      `unexplained=${healthAfter.unexplained_count} excalidraw_excluded=${countsAfter.excluded.excalidraw}`,
  );

  const report = {
    generated_by: "scripts/verify-vault-search.ts",
    sync,
    before: { measured_at: healthBefore.measured_at, counts: countsBefore, health: healthBefore, queries: before },
    after: { measured_at: healthAfter.measured_at, counts: countsAfter, health: healthAfter, queries: after },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[verify-vault-search] FAILED:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
