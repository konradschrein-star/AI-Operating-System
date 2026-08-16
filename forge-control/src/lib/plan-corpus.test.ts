/**
 * Tests for the plan-corpus reader (plan-corpus.ts).
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * Two properties are load-bearing here, and round 906 exists because the first
 * one was violated in production:
 *
 *  - ISOLATION. A project with a namespaced corpus (`docs/plan/<slug>/`) must
 *    resolve and list ONLY its own documents. The flat `docs/plan/` of such a
 *    project's worktree holds another project's corpus — it is the copy that
 *    lives on `main` — so a per-file fallback into it serves a stranger's
 *    document under this project's plan panel with a 200. Round 904 caught
 *    exactly that: `00-vision.md` opened from an operator-visibility chat
 *    rendered "# 00 — Vision: engine-v2-research-lane".
 *  - CONTAINMENT. The subdirectory is derived from the PROJECT ROW, never from
 *    the client, and every traversal layer `resolvePlanDoc` had before the
 *    subdirectory existed still holds after it. The `..`, absolute-path,
 *    escaping-symlink and separator cases below are the regression net for
 *    that: if a future round widens the reader again, one of them goes red.
 *
 * These use a real temp directory rather than a mocked fs on purpose. Three of
 * the four guards are symlink/realpath behaviour; against a mock they would
 * assert the mock.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  planDirFor,
  resolvePlanDoc,
  selectPlanCorpus,
  PLAN_DOC_MAX_BYTES,
} from "./plan-corpus.ts";
import { projectSlug } from "./run-control-rules.ts";

/* ------------------------------------------------------------------------- *
 * Fixture: two worktrees that mirror the real machine on 2026-08-17.
 *
 *   nsWorktree/docs/plan/            → the FLAT corpus (another project's; it
 *                                      is what `main` carries)
 *   nsWorktree/docs/plan/ns-project/ → this project's own corpus
 *   flatWorktree/docs/plan/          → a legacy project, flat, no subdirectory
 * ------------------------------------------------------------------------- */

const NS_NAME = "ns-project";
const NS_ID = "8ea0cc08-28d9-4301-9f28-c98e1c5d6838";
const FLAT_NAME = "flat-legacy";
const FLAT_ID = "4120f785-fd86-414c-9a04-f10b2cd0c365";

let root: string;
let nsWorktree: string;
let flatWorktree: string;
let nsFlatDir: string;
let nsOwnDir: string;
let flatDir: string;
/** A file OUTSIDE any plan directory — every escape test aims at this. */
let secretFile: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "plan-corpus-"));
  nsWorktree = path.join(root, "ns-worktree");
  flatWorktree = path.join(root, "flat-worktree");
  nsFlatDir = path.join(nsWorktree, "docs", "plan");
  nsOwnDir = path.join(nsFlatDir, NS_NAME);
  flatDir = path.join(flatWorktree, "docs", "plan");

  await mkdir(nsOwnDir, { recursive: true });
  await mkdir(flatDir, { recursive: true });

  secretFile = path.join(root, "secret.md");
  await writeFile(secretFile, "# outside every corpus\n");

  // The flat level of the NAMESPACED worktree = the other project's corpus.
  await writeFile(path.join(nsFlatDir, "00-vision.md"), "# 00 — Vision: OTHER PROJECT\n");
  await writeFile(path.join(nsFlatDir, "03-quality.md"), "# 03 — Quality: OTHER PROJECT\n");
  // This project's own corpus.
  await writeFile(path.join(nsOwnDir, "00-vision.md"), "# 00 — Vision: ns-project\n");
  await writeFile(path.join(nsOwnDir, "10-ui-v3-spec.md"), "# 10 — UI v3 spec\n");
  await writeFile(path.join(nsOwnDir, "notes.txt"), "not markdown\n");
  // The legacy flat project.
  await writeFile(path.join(flatDir, "00-vision.md"), "# 00 — Vision: flat-legacy\n");
  await writeFile(path.join(flatDir, "04-phases.md"), "# 04 — Phases: flat-legacy\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What `/plan` does with the chosen directory, so the listing assertions test
 *  the same filter the route applies. */
async function listMd(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

function corpusOrFail(choice: Awaited<ReturnType<typeof selectPlanCorpus>>) {
  if ("error" in choice) assert.fail(`expected a corpus, got error: ${choice.error}`);
  return choice;
}

/* ------------------------------------------------------------------------- *
 * 1. planDirFor — unchanged contract, kept under test after the move.
 * ------------------------------------------------------------------------- */

describe("planDirFor", () => {
  test("absolute workspace_dir → <ws>/docs/plan", () => {
    assert.deepEqual(planDirFor("/opt/ws"), { dir: path.join("/opt/ws", "docs", "plan") });
  });

  test("null workspace_dir is a named refusal, not an empty path", () => {
    const r = planDirFor(null);
    assert.ok("error" in r && r.error.includes("no workspace_dir"));
  });

  test("relative workspace_dir is refused — it would resolve against our own cwd", () => {
    const r = planDirFor("workspace/projects/x");
    assert.ok("error" in r && r.error.includes("not an absolute path"));
  });
});

/* ------------------------------------------------------------------------- *
 * 2. selectPlanCorpus — namespaced first, flat as fallback, never both.
 * ------------------------------------------------------------------------- */

describe("selectPlanCorpus", () => {
  test("namespaced project resolves to its own docs/plan/<slug>/", async () => {
    const c = corpusOrFail(await selectPlanCorpus(nsWorktree, NS_NAME, NS_ID));
    assert.equal(c.namespaced, true);
    assert.equal(c.dir, nsOwnDir);
    assert.equal(c.slug, NS_NAME);
  });

  test("legacy flat project still resolves to the flat docs/plan/", async () => {
    const c = corpusOrFail(await selectPlanCorpus(flatWorktree, FLAT_NAME, FLAT_ID));
    assert.equal(c.namespaced, false);
    assert.equal(c.dir, flatDir);
  });

  test("the slug is the engine's, not a second derivation", async () => {
    // project-tick.ts creates `docs/plan/${projectSlug(name, id)}`. If this
    // module ever forked that logic, a display name with spaces or an umlaut
    // would silently land on the flat fallback.
    const pretty = "NS Project";
    assert.equal(projectSlug(pretty, NS_ID), NS_NAME);
    const c = corpusOrFail(await selectPlanCorpus(nsWorktree, pretty, NS_ID));
    assert.equal(c.namespaced, true);
    assert.equal(c.dir, nsOwnDir);
  });

  test("LISTING ISOLATION — a namespaced project lists only its own docs", async () => {
    const c = corpusOrFail(await selectPlanCorpus(nsWorktree, NS_NAME, NS_ID));
    const docs = await listMd(c.dir);
    assert.deepEqual(docs, ["00-vision.md", "10-ui-v3-spec.md"]);
    // The flat level's OTHER-project files must not appear...
    assert.ok(!docs.includes("03-quality.md"));
    // ...and non-markdown is still filtered.
    assert.ok(!docs.includes("notes.txt"));
  });

  test("LISTING ISOLATION — the flat project's listing is unaffected", async () => {
    const c = corpusOrFail(await selectPlanCorpus(flatWorktree, FLAT_NAME, FLAT_ID));
    assert.deepEqual(await listMd(c.dir), ["00-vision.md", "04-phases.md"]);
  });

  test("a regular file named like the slug is not a corpus — falls back to flat", async () => {
    const wt = path.join(root, "file-slug-worktree");
    const plan = path.join(wt, "docs", "plan");
    await mkdir(plan, { recursive: true });
    await writeFile(path.join(plan, "decoy"), "");
    await writeFile(path.join(plan, "00-vision.md"), "# flat\n");
    const c = corpusOrFail(await selectPlanCorpus(wt, "decoy", null));
    assert.equal(c.namespaced, false);
    assert.equal(c.dir, plan);
  });

  test("missing plan directory entirely → flat path, for the caller to report", async () => {
    const wt = path.join(root, "no-docs-worktree");
    await mkdir(wt, { recursive: true });
    const c = corpusOrFail(await selectPlanCorpus(wt, "whatever", null));
    assert.equal(c.namespaced, false);
    assert.equal(c.dir, path.join(wt, "docs", "plan"));
  });

  test("no workspace_dir → error carrying kind 'no-dir' (the 404 branch)", async () => {
    const c = await selectPlanCorpus(null, NS_NAME, NS_ID);
    assert.ok("error" in c);
    assert.equal(c.kind, "no-dir");
  });

  test("ESCAPE — a slug directory that is a symlink out of the worktree is refused", async () => {
    const wt = path.join(root, "symlink-slug-worktree");
    const plan = path.join(wt, "docs", "plan");
    await mkdir(plan, { recursive: true });
    await writeFile(path.join(plan, "00-vision.md"), "# flat\n");
    const escapeTarget = path.join(root, "elsewhere");
    await mkdir(escapeTarget, { recursive: true });
    await writeFile(path.join(escapeTarget, "00-vision.md"), "# stolen\n");
    await symlink(escapeTarget, path.join(plan, "escaped"), "dir");

    const c = await selectPlanCorpus(wt, "escaped", null);
    assert.ok("error" in c, "an escaping corpus symlink must not resolve");
    assert.equal(c.kind, "refused");
    assert.match(c.error, /resolves outside the plan directory/);
    // And it must NOT have silently fallen back to the flat directory: a
    // fallback would answer a suspicious request with someone else's docs.
  });

  test("ESCAPE — a sibling directory sharing the prefix cannot pass as the corpus", async () => {
    // `docs/plan-evil` must not read as living under `docs/plan`. The slug can
    // never contain a separator, so this is reached through a symlink; the
    // assertion is on the containment comparison keeping the separator.
    const wt = path.join(root, "prefix-worktree");
    const plan = path.join(wt, "docs", "plan");
    const evil = path.join(wt, "docs", "plan-evil");
    await mkdir(plan, { recursive: true });
    await mkdir(evil, { recursive: true });
    await symlink(evil, path.join(plan, "evil"), "dir");
    const c = await selectPlanCorpus(wt, "evil", null);
    assert.ok("error" in c);
    assert.equal(c.kind, "refused");
  });

  test("a degenerate project name still yields a safe slug, never a traversal", async () => {
    // projectSlug falls back to `project-<id8>` for names that slug to nothing.
    const c = corpusOrFail(await selectPlanCorpus(nsWorktree, "...", NS_ID));
    assert.equal(c.namespaced, false, "no such directory exists → flat fallback");
    assert.equal(c.slug, "project-8ea0cc08");
    assert.ok(!c.dir.includes(".."));
  });
});

/* ------------------------------------------------------------------------- *
 * 3. resolvePlanDoc — the traversal net. Unchanged by round 906 and asserted
 *    to be unchanged: the subdirectory comes from the project row, so the
 *    client-supplied name is still a BARE FILE NAME.
 * ------------------------------------------------------------------------- */

describe("resolvePlanDoc — serving", () => {
  test("serves a document out of the namespaced corpus", async () => {
    const d = await resolvePlanDoc(nsOwnDir, "10-ui-v3-spec.md");
    assert.ok(d.ok, `expected ok, got ${!d.ok && d.error}`);
    assert.equal(d.file, path.join(nsOwnDir, "10-ui-v3-spec.md"));
  });

  test("ISOLATION — the namespaced corpus's 00-vision.md is THIS project's", async () => {
    const { readFile } = await import("node:fs/promises");
    const d = await resolvePlanDoc(nsOwnDir, "00-vision.md");
    assert.ok(d.ok);
    const body = await readFile(d.file, "utf8");
    assert.match(body, /ns-project/);
    assert.doesNotMatch(body, /OTHER PROJECT/, "round 904's bug: another project's doc served here");
  });

  test("ISOLATION — a doc that exists only at the flat level 404s, it does not fall through", async () => {
    // `03-quality.md` exists in nsFlatDir and NOT in nsOwnDir. The reader is
    // pointed at the namespaced corpus, so the honest answer is 404. If a
    // future round adds a "try the flat directory too" fallback, this goes red.
    const d = await resolvePlanDoc(nsOwnDir, "03-quality.md");
    assert.ok(!d.ok);
    assert.equal(d.status, 404);
  });

  test("serves a legacy flat project's document unchanged", async () => {
    const d = await resolvePlanDoc(flatDir, "04-phases.md");
    assert.ok(d.ok);
    assert.equal(d.file, path.join(flatDir, "04-phases.md"));
  });
});

describe("resolvePlanDoc — traversal and shape refusals", () => {
  const cases: Array<{ name: string; want: 400 | 404; why: string }> = [
    { name: "../00-vision.md", want: 400, why: "parent traversal" },
    { name: "../../../etc/passwd", want: 400, why: "deep traversal" },
    { name: "/etc/passwd", want: 400, why: "absolute path" },
    { name: "..\\..\\secret.md", want: 400, why: "windows separator" },
    { name: "ns-project/00-vision.md", want: 400, why: "the client naming the subdirectory itself" },
    { name: "sub/00-vision.md", want: 400, why: "any subdirectory" },
    { name: "..", want: 400, why: "directory reference" },
    { name: ".", want: 400, why: "directory reference" },
    { name: "", want: 400, why: "empty name" },
    { name: "00-vision", want: 400, why: "not .md" },
    { name: "passwd", want: 400, why: "not .md" },
    { name: "missing.md", want: 404, why: "well-formed, absent" },
  ];

  for (const { name, want, why } of cases) {
    test(`rejects ${JSON.stringify(name)} with ${want} (${why})`, async () => {
      const d = await resolvePlanDoc(nsOwnDir, name);
      assert.ok(!d.ok, `${name} must not be served`);
      assert.equal(d.status, want);
      assert.ok(d.error.length > 0, "every rejection names itself");
    });
  }

  test("rejects a NUL byte in the name", async () => {
    const d = await resolvePlanDoc(nsOwnDir, "00-vision.md\0.png");
    assert.ok(!d.ok);
    assert.equal(d.status, 400);
    assert.match(d.error, /NUL/);
  });

  test("ESCAPE — a symlink INSIDE the corpus pointing outside is refused", async () => {
    // Lexically a perfect child; physically an escape. This is the layer
    // `path.resolve` cannot see.
    const link = path.join(nsOwnDir, "escape.md");
    await symlink(secretFile, link);
    try {
      const d = await resolvePlanDoc(nsOwnDir, "escape.md");
      assert.ok(!d.ok, "a symlink out of the corpus must not be served");
      assert.equal(d.status, 400);
      assert.match(d.error, /resolves outside the plan directory/);
    } finally {
      await rm(link, { force: true });
    }
  });

  test("a dangling symlink is a 404, not a 500", async () => {
    const link = path.join(nsOwnDir, "dangling.md");
    await symlink(path.join(root, "nope", "nothing.md"), link);
    try {
      const d = await resolvePlanDoc(nsOwnDir, "dangling.md");
      assert.ok(!d.ok);
      assert.equal(d.status, 404);
    } finally {
      await rm(link, { force: true });
    }
  });

  test("a DIRECTORY named x.md is not a document", async () => {
    const dir = path.join(nsOwnDir, "trap.md");
    await mkdir(dir, { recursive: true });
    try {
      const d = await resolvePlanDoc(nsOwnDir, "trap.md");
      assert.ok(!d.ok);
      assert.equal(d.status, 400);
      assert.match(d.error, /not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing plan directory is a 404 naming the directory", async () => {
    const d = await resolvePlanDoc(path.join(root, "no-such-dir"), "00-vision.md");
    assert.ok(!d.ok);
    assert.equal(d.status, 404);
    assert.match(d.error, /plan directory unavailable/);
  });

  test("over the size cap is a 413, not a truncated 200", async () => {
    const big = path.join(nsOwnDir, "huge.md");
    await writeFile(big, "x".repeat(PLAN_DOC_MAX_BYTES + 1));
    try {
      const d = await resolvePlanDoc(nsOwnDir, "huge.md");
      assert.ok(!d.ok);
      assert.equal(d.status, 413);
    } finally {
      await rm(big, { force: true });
    }
  });
});

/* ------------------------------------------------------------------------- *
 * 4. The end-to-end property, stated once: choose-then-resolve, for both
 *    project shapes, never crossing.
 * ------------------------------------------------------------------------- */

describe("PROPERTY — choose-then-resolve never crosses project corpora", () => {
  test("both projects ask for 00-vision.md and each gets its own", async () => {
    const { readFile } = await import("node:fs/promises");

    const ns = corpusOrFail(await selectPlanCorpus(nsWorktree, NS_NAME, NS_ID));
    const nsDoc = await resolvePlanDoc(ns.dir, "00-vision.md");
    assert.ok(nsDoc.ok);
    assert.match(await readFile(nsDoc.file, "utf8"), /ns-project/);

    const flat = corpusOrFail(await selectPlanCorpus(flatWorktree, FLAT_NAME, FLAT_ID));
    const flatDoc = await resolvePlanDoc(flat.dir, "00-vision.md");
    assert.ok(flatDoc.ok);
    assert.match(await readFile(flatDoc.file, "utf8"), /flat-legacy/);

    assert.notEqual(nsDoc.file, flatDoc.file);
  });

  test("every listed doc is servable, and every servable doc was listed", async () => {
    // The two endpoints must agree by construction: `/plan` must never offer a
    // name `/plan/doc` refuses, and `/plan/doc` must never serve a name `/plan`
    // did not list.
    for (const worktree of [
      { wt: nsWorktree, name: NS_NAME, id: NS_ID },
      { wt: flatWorktree, name: FLAT_NAME, id: FLAT_ID },
    ]) {
      const c = corpusOrFail(await selectPlanCorpus(worktree.wt, worktree.name, worktree.id));
      const docs = await listMd(c.dir);
      assert.ok(docs.length > 0, `${worktree.name} listed nothing`);
      for (const doc of docs) {
        const d = await resolvePlanDoc(c.dir, doc);
        assert.ok(d.ok, `listed but not servable: ${doc} (${!d.ok && d.error})`);
      }
    }
  });
});
