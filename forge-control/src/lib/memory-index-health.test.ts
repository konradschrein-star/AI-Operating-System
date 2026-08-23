/**
 * Tests for the vault index reconciliation (lib/index-health.ts) and the two
 * routes that expose it.
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts — a test anywhere else does
 * not run at all).
 *
 * HERMETIC BY CONSTRUCTION. Every classification test feeds `classify()` and
 * `reconcile()` synthetic values; no vault is read and no database is opened.
 * The two route tests DO import the real router — and point both connection
 * strings at a dead port first, so the handler's failure path is exercised
 * deterministically instead of depending on whether Postgres happens to be up
 * on the machine running the suite.
 *
 * THE GOVERNING RULE (03-quality.md §2.1): every assertion is flipped across
 * its boundary in BOTH directions. A classifier that returned today's constants
 * would satisfy "empty_drawing fires on an .excalidraw.md"; it would not
 * survive "…and the neighbouring input does NOT produce that reason", nor
 * "a set where every absence is explained yields unexplained_count 0, and
 * adding ONE ordinary note makes it 1".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classify,
  reconcile,
  countByReason,
  stalePaths,
  folderCounts,
  folderRule,
  offendingCountKeys,
  COUNTS_INTEGER_KEY_RULE,
  ROOT_FOLDER_LABEL,
  IndexHealthInputError,
  type FileFacts,
  type ReconcileInput,
  type DiscrepancyReason,
  type MemoryCounts,
} from "./index-health.ts";

const MEASURED_AT = "2026-08-18T12:00:00.000Z";

/** A fully-indexed, healthy note: on disk, in both indexes, with a body. */
function healthy(overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    path: "90_AI_OS/Spec - Something.md",
    bytes: 4096,
    hasBody: true,
    inDisk: true,
    inRegistry: true,
    inEmbeddings: true,
    ...overrides,
  };
}

/* ========================================================================== *
 * 1. classify() — each reason fires on its own input and NOT on its neighbour
 * ========================================================================== */

describe("classify — the five reasons, each flipped against its neighbour", () => {
  test("no discrepancy: on disk, in both indexes, with a body", () => {
    assert.equal(classify(healthy()), null);
  });

  test("a drawing WITH content is unexplained, not excluded", () => {
    // The 2026-08-23 reversal. A drawing used to be classified
    // `excluded_extension` — "km-indexer.js:29 skips these and is right to".
    // Now that lib/excalidraw-extract.ts renders a drawing as text, an
    // unindexed one is a real gap and has to be counted as one.
    const drawing = healthy({
      path: "20_Coding/Architecture.excalidraw.md",
      bytes: 33107,
      hasBody: true,
      inEmbeddings: false,
    });
    const verdict = classify(drawing);
    assert.equal(verdict?.reason, "unexplained");
    // The detail names the extractor AND the exclusion still in force upstream,
    // so the operator can check both claims.
    assert.match(verdict?.detail ?? "", /excalidraw-extract\.ts/);
    assert.match(verdict?.detail ?? "", /EXCLUDED_EXTENSIONS/);

    // NEIGHBOUR: identical in every respect but the extension. Same reason,
    // different detail — a plain note's absence is not blamed on km-indexer.
    const plain = healthy({
      path: "20_Coding/Architecture.md",
      bytes: 33107,
      hasBody: true,
      inEmbeddings: false,
    });
    assert.equal(classify(plain)?.reason, "unexplained");
    assert.doesNotMatch(classify(plain)?.detail ?? "", /EXCLUDED_EXTENSIONS/);
  });

  test("empty_drawing fires on a blank .excalidraw.md, not on a blank .md", () => {
    const blank = healthy({
      path: "20_Coding/Blank.excalidraw.md",
      bytes: 527,
      hasBody: false,
      inEmbeddings: false,
    });
    assert.equal(classify(blank)?.reason, "empty_drawing");
    assert.match(classify(blank)?.detail ?? "", /527 bytes/);

    // NEIGHBOUR: same emptiness, ordinary extension → the other reason. The two
    // are separate because the remedy is: draw something / write something.
    const note = healthy({
      path: "20_Coding/Blank.md",
      bytes: 527,
      hasBody: false,
      inEmbeddings: false,
    });
    assert.equal(classify(note)?.reason, "frontmatter_only");
  });

  test("the drawing rule is case-insensitive but not a substring match", () => {
    assert.equal(
      classify(
        healthy({ path: "a/B.EXCALIDRAW.MD", hasBody: false, inEmbeddings: false }),
      )?.reason,
      "empty_drawing",
    );
    // NEIGHBOUR: the marker appears, but not as the suffix — so it is an
    // ordinary note and gets the ordinary reason.
    assert.equal(
      classify(
        healthy({
          path: "a/excalidraw.md.backup.md",
          hasBody: false,
          inEmbeddings: false,
        }),
      )?.reason,
      "frontmatter_only",
    );
  });

  test("empty_file fires at 0 bytes, not at 1 byte", () => {
    const zero = healthy({ path: "Untitled.md", bytes: 0, hasBody: false, inEmbeddings: false });
    const verdict = classify(zero);
    assert.equal(verdict?.reason, "empty_file");
    assert.equal(verdict?.detail, "0 bytes");

    // NEIGHBOUR: one byte across the boundary, still no body → the OTHER
    // reason. If empty_file swallowed this, the counts would be wrong in a way
    // no live figure would reveal.
    const oneByte = healthy({ path: "Untitled.md", bytes: 1, hasBody: false, inEmbeddings: false });
    assert.equal(classify(oneByte)?.reason, "frontmatter_only");
  });

  test("frontmatter_only fires when the body is empty, not when it has one", () => {
    const fmOnly = healthy({
      path: "brand guidelines.md",
      bytes: 57,
      hasBody: false,
      inEmbeddings: false,
    });
    const verdict = classify(fmOnly);
    assert.equal(verdict?.reason, "frontmatter_only");
    // The byte count is DERIVED from the input, not a stored constant.
    assert.equal(verdict?.detail, "57 bytes, frontmatter only");
    assert.equal(
      classify(healthy({ path: "x.md", bytes: 9001, hasBody: false, inEmbeddings: false }))
        ?.detail,
      "9001 bytes, frontmatter only",
    );

    // NEIGHBOUR: same file, same size, but with a body → the headline.
    const withBody = healthy({
      path: "brand guidelines.md",
      bytes: 57,
      hasBody: true,
      inEmbeddings: false,
    });
    assert.equal(classify(withBody)?.reason, "unexplained");
  });

  test("stale_row_file_missing fires when the file is gone, not when it is present", () => {
    const stale = healthy({ path: "Coach/log.md", inDisk: false, inRegistry: false });
    const verdict = classify(stale);
    assert.equal(verdict?.reason, "stale_row_file_missing");
    assert.equal(
      verdict?.detail,
      "embedding rows survive; km-indexer.js never prunes",
    );

    // NEIGHBOUR: put the file back on disk and the very same embedding rows
    // stop being a discrepancy at all.
    assert.equal(classify(healthy({ path: "Coach/log.md" })), null);
  });

  test("unexplained fires for a real note with content and no embedding row", () => {
    const gap = healthy({
      path: "30_YouTube/Channel plan.md",
      bytes: 2048,
      hasBody: true,
      inEmbeddings: false,
    });
    const verdict = classify(gap);
    assert.equal(verdict?.reason, "unexplained");
    assert.match(verdict?.detail ?? "", /2048 bytes/);

    // NEIGHBOUR: index it and the headline goes quiet.
    assert.equal(classify(healthy({ path: "30_YouTube/Channel plan.md", bytes: 2048 })), null);
  });

  test("a file the REGISTRY does not know is unexplained even when embedded", () => {
    const registryGap = healthy({ inRegistry: false });
    assert.equal(classify(registryGap)?.reason, "unexplained");
    // NEIGHBOUR: the only field that moved is inRegistry.
    assert.equal(classify(healthy({ inRegistry: true })), null);
  });

  test("a path in neither store is not a discrepancy", () => {
    assert.equal(
      classify(healthy({ inDisk: false, inEmbeddings: false, inRegistry: true })),
      null,
    );
  });

  test("EVERY reason carries a non-empty detail — none is null or 'unknown'", () => {
    const inputs: FileFacts[] = [
      healthy({ path: "a.excalidraw.md", hasBody: false, inEmbeddings: false }),
      healthy({ path: "b.md", bytes: 0, hasBody: false, inEmbeddings: false }),
      healthy({ path: "c.md", bytes: 40, hasBody: false, inEmbeddings: false }),
      healthy({ path: "d.md", inDisk: false }),
      healthy({ path: "e.md", inEmbeddings: false }),
    ];
    const seen = new Set<DiscrepancyReason>();
    for (const f of inputs) {
      const v = classify(f);
      assert.notEqual(v, null, `${f.path} should be a discrepancy`);
      assert.ok(v && v.reason.length > 0, `${f.path} reason must be non-null`);
      assert.notEqual(v?.reason as string, "unknown");
      assert.ok((v?.detail ?? "").trim().length > 0, `${f.path} detail must be non-empty`);
      seen.add(v!.reason);
    }
    // All five reasons are reachable — a rule nothing can reach is dead code
    // pretending to be coverage.
    assert.deepEqual(
      [...seen].sort(),
      [
        "empty_drawing",
        "empty_file",
        "frontmatter_only",
        "stale_row_file_missing",
        "unexplained",
      ],
    );
  });
});

/* ========================================================================== *
 * 2. reconcile() — the headline number, flipped both ways
 * ========================================================================== */

/** Today's shape in miniature: one drawing, one empty file, one
 *  frontmatter-only note, one stale embedding row, and two healthy notes. */
function explainedVault(): ReconcileInput {
  return {
    measured_at: MEASURED_AT,
    disk: {
      files: [
        { path: "90_AI_OS/Spec.md", bytes: 5000, hasBody: null },
        { path: "30_YouTube/Plan.md", bytes: 3000, hasBody: null },
        // A blank drawing: 120 KB of geometry the extractor finds no label in.
        { path: "20_Coding/Arch.excalidraw.md", bytes: 120000, hasBody: false },
        { path: "Untitled.md", bytes: 0, hasBody: null },
        { path: "brand guidelines.md", bytes: 57, hasBody: false },
      ],
      excluded_trash: 42,
    },
    registry: {
      vault_sync_paths: [
        "90_AI_OS/Spec.md",
        "30_YouTube/Plan.md",
        "20_Coding/Arch.excalidraw.md",
        "Untitled.md",
        "brand guidelines.md",
      ],
      agent_rows: 198,
    },
    embeddings: {
      paths: ["90_AI_OS/Spec.md", "30_YouTube/Plan.md", "Coach/log.md"],
      chunks: 2131,
    },
  };
}

describe("reconcile — unexplained_count is the whole product", () => {
  test("every absence explained ⇒ unexplained_count === 0", () => {
    const h = reconcile(explainedVault());
    assert.equal(h.unexplained_count, 0);
    assert.equal(countByReason(h, "empty_drawing"), 1);
    assert.equal(countByReason(h, "empty_file"), 1);
    assert.equal(countByReason(h, "frontmatter_only"), 1);
    assert.equal(countByReason(h, "stale_row_file_missing"), 1);
    assert.equal(h.discrepancies.length, 4);
  });

  test("ONE ordinary unindexed note ⇒ unexplained_count === 1, and it is named", () => {
    // Without this half a classifier that returned a constant zero would pass
    // the test above. This is the flip that makes the suite mean something.
    const input = explainedVault();
    input.disk.files.push({
      path: "AI OS/Operator Log.md",
      bytes: 8123,
      hasBody: true,
    });
    input.registry.vault_sync_paths.push("AI OS/Operator Log.md");

    const h = reconcile(input);
    assert.equal(h.unexplained_count, 1);
    const gap = h.discrepancies.filter((d) => d.reason === "unexplained");
    assert.equal(gap.length, 1);
    assert.equal(gap[0].path, "AI OS/Operator Log.md");
    assert.equal(gap[0].in_disk, true);
    assert.equal(gap[0].in_registry, true);
    assert.equal(gap[0].in_embeddings, false);
    assert.match(gap[0].detail, /8123 bytes/);

    // …and the other four reasons did not move, so the new note did not simply
    // shift a tally around.
    assert.equal(h.discrepancies.length, 5);
  });

  test("counts are DERIVED — a different vault yields different numbers", () => {
    const input = explainedVault();
    input.disk.files.push(
      { path: "a.excalidraw.md", bytes: 10, hasBody: false },
      { path: "b.excalidraw.md", bytes: 10, hasBody: false },
    );
    const h = reconcile(input);
    assert.equal(countByReason(h, "empty_drawing"), 3);
    assert.equal(h.disk.md_files, 7);
    // The 15/10/1/1 of 2026-08-18 appear nowhere in the implementation.
    assert.notEqual(countByReason(h, "empty_drawing"), 15);
  });

  test("every discrepancy carries a non-null reason and a non-empty detail", () => {
    const input = explainedVault();
    input.disk.files.push({ path: "gap.md", bytes: 900, hasBody: true });
    const h = reconcile(input);
    assert.ok(h.discrepancies.length > 0);
    for (const d of h.discrepancies) {
      assert.ok(d.reason, `${d.path} has a falsy reason`);
      assert.notEqual(d.reason as string, "unknown");
      assert.ok(d.detail.trim().length > 0, `${d.path} has an empty detail`);
    }
  });

  test("the envelope reports every store it read", () => {
    const h = reconcile(explainedVault());
    assert.equal(h.measured_at, MEASURED_AT);
    assert.equal(h.disk.md_files, 5);
    assert.equal(h.disk.excluded_trash, 42);
    assert.equal(h.registry.vault_sync_rows, 5);
    assert.equal(h.registry.agent_rows, 198);
    assert.equal(h.embeddings.files, 3);
    assert.equal(h.embeddings.chunks, 2131);
  });

  test(".trash files land in excluded_trash and NOT in md_files", () => {
    // The scan hands reconcile() only the non-dot paths; `.trash` arrives as a
    // count. This asserts the two never merge — the "67-file gap" was exactly
    // this merge, done by hand, in a shell.
    const input = explainedVault();
    assert.equal(input.disk.files.some((f) => f.path.startsWith(".trash/")), false);
    const h = reconcile(input);
    assert.equal(h.disk.md_files, 5);
    assert.equal(h.disk.excluded_trash, 42);
    assert.notEqual(h.disk.md_files, h.disk.md_files + h.disk.excluded_trash);

    // FLIP: a vault with an empty .trash reports 0 there and the SAME md_files.
    const clean = explainedVault();
    clean.disk.excluded_trash = 0;
    const h2 = reconcile(clean);
    assert.equal(h2.disk.excluded_trash, 0);
    assert.equal(h2.disk.md_files, h.disk.md_files);
  });

  test("stalePaths() returns only stale_row_file_missing — nothing else can be pruned", () => {
    const input = explainedVault();
    input.disk.files.push({ path: "gap.md", bytes: 900, hasBody: true });
    const h = reconcile(input);
    assert.deepEqual(stalePaths(h), ["Coach/log.md"]);
    // FLIP: with the file back on disk there is nothing to prune at all.
    const restored = explainedVault();
    restored.disk.files.push({ path: "Coach/log.md", bytes: 400, hasBody: true });
    assert.deepEqual(stalePaths(reconcile(restored)), []);
  });

  test("an unmeasured body THROWS rather than being guessed", () => {
    // A file on disk, absent from the embeddings index, non-empty, not a
    // drawing — the one case where hasBody decides the reason. Defaulting it
    // would fabricate either an exclusion or a gap.
    const input = explainedVault();
    input.disk.files.push({ path: "unmeasured.md", bytes: 700, hasBody: null });
    assert.throws(() => reconcile(input), (err: unknown) => {
      assert.ok(err instanceof IndexHealthInputError);
      assert.match(err.message, /unmeasured\.md/);
      return true;
    });

    // FLIP: measure it and reconcile succeeds.
    const measured = explainedVault();
    measured.disk.files.push({ path: "unmeasured.md", bytes: 700, hasBody: true });
    assert.equal(reconcile(measured).unexplained_count, 1);
  });

  test("hasBody may stay null for files that need no body decision", () => {
    // The 0-byte, the drawing and every embedded file arrive with hasBody null
    // and must NOT trip the guard — otherwise indexHealth() would be forced to
    // slurp all 284 files to answer a question about 26 of them.
    assert.equal(reconcile(explainedVault()).unexplained_count, 0);
  });
});

/* ========================================================================== *
 * 3. The counts envelope — R15's key rule, and folder_counts
 * ========================================================================== */

/**
 * A literal typed as `MemoryCounts`. This is load-bearing beyond the runtime
 * assertions: TypeScript's excess-property and missing-property checks mean
 * that if anybody re-adds a bare `all` (or any other integer) to the interface,
 * `npx tsc --noEmit` fails on THIS object before the suite even runs.
 */
const ENVELOPE: MemoryCounts = {
  vault_files_on_disk: 284,
  vault_notes_indexed: 284,
  agent_notes: 198,
  embedded_files: 259,
  embedded_chunks: 2131,
  excluded: { excalidraw: 15, empty: 10, frontmatter_only: 1 },
  stale_embedding_rows: 1,
  measured_at: MEASURED_AT,
  source: "all",
  folder_counts: { "90_AI_OS": 56, "30_YouTube": 54 },
  folder_rule: folderRule("all hcp.knowledge_note rows"),
};

describe("counts envelope — R15", () => {
  test("every top-level integer key states its unit and source", () => {
    assert.deepEqual(offendingCountKeys({ ...ENVELOPE }), []);
  });

  test("the key rule FAILS when a bare `all` is injected", () => {
    // Without this the assertion above could not fail and would prove nothing.
    const withAll = { ...ENVELOPE, all: 482 } as Record<string, unknown>;
    assert.deepEqual(offendingCountKeys(withAll), ["all"]);
    // …and so does the union R16 explicitly forbids as a replacement.
    assert.deepEqual(
      offendingCountKeys({ ...ENVELOPE, notes_all_sources: 482 } as Record<string, unknown>),
      ["notes_all_sources"],
    );
  });

  test("the rule applies to integers only — labels and nested objects pass", () => {
    assert.equal(COUNTS_INTEGER_KEY_RULE.test("vault_files_on_disk"), true);
    assert.equal(COUNTS_INTEGER_KEY_RULE.test("all"), false);
    // `folder_counts` is an OBJECT, not a top-level integer, so it is not
    // subject to the prefix rule — and the checker agrees.
    assert.deepEqual(offendingCountKeys({ folder_counts: { a: 1 }, note: "x" }), []);
    // FLIP: the same name holding an integer WOULD offend.
    assert.deepEqual(offendingCountKeys({ folder_counts: 3 }), ["folder_counts"]);
  });

  test("the five category chips are absent from the envelope", () => {
    for (const chip of ["rule", "pref", "fact", "person", "project", "note", "all"]) {
      assert.equal(
        Object.hasOwn(ENVELOPE as unknown as Record<string, unknown>, chip),
        false,
        `${chip} must not survive in the counts payload`,
      );
    }
  });
});

describe("folderCounts — the honest replacement for the chips", () => {
  test("counts the first path segment", () => {
    const c = folderCounts([
      "90_AI_OS/Spec.md",
      "90_AI_OS/Other.md",
      "30_YouTube/Plan.md",
      "AI OS/Specs/Directory + Business Plan Hub — Business Model.md",
    ]);
    assert.deepEqual(c, { "90_AI_OS": 2, "30_YouTube": 1, "AI OS": 1 });
  });

  test("a note at the vault ROOT is counted under (root), not dropped", () => {
    const c = folderCounts(["Inbox.md", "90_AI_OS/Spec.md"]);
    assert.equal(c[ROOT_FOLDER_LABEL], 1);
    assert.equal(c["90_AI_OS"], 1);
    // The rail sums to the note total — a folder view that silently loses the
    // root notes is the "it's zero and not eight" defect in a new costume.
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 2);
  });

  test("deeper folders do not create extra buckets", () => {
    const c = folderCounts(["a/b/c/d.md", "a/e.md"]);
    assert.deepEqual(c, { a: 2 });
    // FLIP: a different first segment does.
    assert.deepEqual(folderCounts(["a/b.md", "z/b.md"]), { a: 1, z: 1 });
  });

  test("an empty vault yields an empty rail, not a fabricated zero", () => {
    assert.deepEqual(folderCounts([]), {});
  });

  test("folder_rule states the derivation and its scope verbatim", () => {
    const rule = folderRule("hcp.knowledge_note rows where created_by = 'vault-sync'");
    assert.match(rule, /first "\/"-separated segment of vault_path/);
    assert.match(rule, /\(root\)/);
    assert.match(rule, /created_by = 'vault-sync'/);
  });
});

/* ========================================================================== *
 * 4. Route registration — /index-health must not be swallowed by /:slug{.+}
 * ========================================================================== */

describe("routes/memory.ts — registration order and the hard-error path", () => {
  test("Hono's first-match-wins is real: order decides who answers", async () => {
    // The control for the assertion below. If Hono did NOT shadow, asserting
    // an order would prove nothing at all.
    const { Hono } = await import("hono");

    const correct = new Hono();
    correct.get("/index-health", (c) => c.text("health"));
    correct.get("/:slug{.+}", (c) => c.text("slug"));
    assert.equal(await (await correct.request("/index-health")).text(), "health");

    const shadowed = new Hono();
    shadowed.get("/:slug{.+}", (c) => c.text("slug"));
    shadowed.get("/index-health", (c) => c.text("health"));
    assert.equal(await (await shadowed.request("/index-health")).text(), "slug");
  });

  test("the REAL router registers /index-health before the catch-all", async () => {
    process.env.HCP_DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nope";
    process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nope";
    const router = (await import("../routes/memory.ts")).default;

    const at = (method: string, path: string): number =>
      router.routes.findIndex((rt) => rt.method === method && rt.path === path);

    const health = at("GET", "/index-health");
    const prune = at("POST", "/index-health/prune");
    const catchAll = at("GET", "/:slug{.+}");
    assert.ok(health >= 0, "GET /index-health is not registered");
    assert.ok(prune >= 0, "POST /index-health/prune is not registered");
    assert.ok(catchAll >= 0, "the /:slug{.+} catch-all moved or was renamed");
    assert.ok(health < catchAll, "GET /index-health is registered AFTER the catch-all");
    assert.ok(prune < catchAll, "POST /index-health/prune is registered AFTER the catch-all");
  });

  test("GET /index-health reaches its own handler and 500s WITH the message", async () => {
    // Both pools point at a dead port (set above and below — node:test may run
    // these in any order within the file, so the assignment is idempotent).
    process.env.HCP_DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nope";
    process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nope";
    const router = (await import("../routes/memory.ts")).default;

    const res = await router.request("/index-health");
    assert.equal(res.status, 500);
    const body = (await res.json()) as Record<string, unknown>;
    // The prefix is produced by NO other handler in the file — this is the
    // dispatch proof, stronger than reading the route table.
    assert.match(String(body.error), /^index-health failed: /);
    // R20/N1: it did NOT degrade to a zeroed reconciliation. A payload of
    // zeros is indistinguishable from a total index collapse.
    assert.equal("unexplained_count" in body, false);
    assert.equal("disk" in body, false);
  });

  test("POST /index-health/prune refuses without an explicit confirm", async () => {
    const router = (await import("../routes/memory.ts")).default;

    const noBody = await router.request("/index-health/prune", { method: "POST" });
    assert.equal(noBody.status, 400, "an unparseable body must be a 400, never a silent {}");
    assert.match(String(((await noBody.json()) as { error: string }).error), /JSON/);

    const empty = await router.request("/index-health/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(empty.status, 400);
    assert.match(String(((await empty.json()) as { error: string }).error), /confirm/);

    const wrongType = await router.request("/index-health/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"confirm":"true"}',
    });
    assert.equal(wrongType.status, 400, 'the string "true" is not confirmation');

    // FLIP: with {"confirm": true} the guard is passed and the handler goes on
    // to the database — which is dead here, so it fails as a 500 rather than a
    // 400. That is the proof the 400s above came from the guard and not from
    // the route being unreachable, AND that a prune which cannot reconcile
    // deletes nothing and says so.
    const confirmed = await router.request("/index-health/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"confirm":true}',
    });
    assert.equal(confirmed.status, 500);
    assert.match(
      String(((await confirmed.json()) as { error: string }).error),
      /^index-health prune failed before deleting anything: /,
    );
  });
});

/* ========================================================================== *
 * 5. R14 — prune is never automatic
 * ========================================================================== */

describe("R14 — pruneStaleEmbeddingRows has exactly one caller", () => {
  test("no tick, startup path or read references it", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const src = path.resolve(import.meta.dirname, "..");

    const entries = await readdir(src, { withFileTypes: true, recursive: true });
    const callers: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".ts")) continue;
      const parent =
        (e as unknown as { parentPath?: string; path?: string }).parentPath ??
        (e as unknown as { path?: string }).path ??
        src;
      const abs = path.join(parent, e.name);
      const rel = path.relative(src, abs).split(path.sep).join("/");
      if (rel === "db/memory.ts") continue; // the definition itself
      if (rel.endsWith(".test.ts")) continue; // this file names it in prose
      if ((await readFile(abs, "utf8")).includes("pruneStaleEmbeddingRows")) {
        callers.push(rel);
      }
    }
    assert.deepEqual(
      callers,
      ["routes/memory.ts"],
      "prune must be reachable ONLY from the explicit route — an index that " +
        "deletes its own rows on a schedule is one bad mount away from " +
        "deleting all of them",
    );
  });
});
