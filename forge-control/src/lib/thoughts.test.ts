/**
 * Tests for lib/thoughts.ts — the THOUGHTS store (idea pool, quotes, dreams)
 * over a scratch vault.
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts)
 *
 * OBSIDIAN_VAULT_DIR is pointed at a scratch tmp directory BEFORE lib/vault.ts
 * and lib/thoughts.ts are imported — both read the env at module load, and
 * `tsx --test` runs each matched file in its own process, so this does not
 * collide with vault.test.ts's own fixture (see that file's header).
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const VAULT = await fs.mkdtemp(path.join(os.tmpdir(), "forge-thoughts-vault-"));
const SNAPSHOTS = await fs.mkdtemp(path.join(os.tmpdir(), "forge-thoughts-snapshots-"));
process.env.OBSIDIAN_VAULT_DIR = VAULT;
process.env.VAULT_SNAPSHOT_DIR = SNAPSHOTS;

const thoughts = await import("./thoughts.ts");
const {
  thoughtsRoots,
  createIdeaFile,
  listIdeas,
  updateIdea,
  adoptIdea,
  addQuote,
  listQuotes,
  addDream,
  listDreams,
  slugify,
  previewFilename,
  ThoughtsValidationError,
  VaultConflictError,
} = thoughts;

const roots = thoughtsRoots();

async function writeRaw(rel: string, content: string): Promise<void> {
  const abs = path.join(VAULT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("slugify / previewFilename", () => {
  test("ascii, lowercase, hyphenated, max 60 chars", () => {
    assert.equal(slugify("Ship the THING: v2!"), "ship-the-thing-v2");
    assert.equal(slugify("a".repeat(200)), "a".repeat(60));
    assert.equal(slugify("···"), "idea");
  });

  test("previewFilename matches what createIdeaFile writes for a fresh slug", async () => {
    const idea = await createIdeaFile({
      idea: "Preview match test",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-01-01",
    });
    assert.equal(idea.path, `${roots.ideasDir}/${previewFilename("2026-01-01", "Preview match test")}`);
  });
});

describe("createIdeaFile", () => {
  test("konrad author writes under Thoughts/Ideas with defaults applied", async () => {
    const idea = await createIdeaFile({
      idea: "Default importance and status",
      area: "business",
      author: "konrad",
      source: "konrad",
    });
    assert.equal(idea.importance, 5);
    assert.equal(idea.status, "not-started");
    assert.equal(idea.author, "konrad");
    assert.ok(idea.path.startsWith(roots.ideasDir + "/"));
    assert.match(idea.sha256, /^[0-9a-f]{64}$/);
  });

  test("forge author writes under Forge/Thoughts/Seeds", async () => {
    const idea = await createIdeaFile({
      idea: "A derived seed",
      area: "youtube",
      importance: 6,
      author: "forge",
      source: "derived:Project - Tutorials.md",
    });
    assert.ok(idea.path.startsWith(roots.seedsDir + "/"));
    assert.equal(idea.source, "derived:Project - Tutorials.md");
  });

  test("a colon in the idea line round-trips through frontmatter quoting", async () => {
    const idea = await createIdeaFile({
      idea: "Ship v2: say it out loud",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-01-02",
    });
    assert.equal(idea.idea, "Ship v2: say it out loud");
    const raw = await fs.readFile(path.join(VAULT, idea.path), "utf8");
    assert.match(raw, /^---\n/);
    assert.match(raw, /idea: "Ship v2: say it out loud"/);
  });

  test("collision on identical created+idea gets a numeric suffix, not overwritten", async () => {
    const first = await createIdeaFile({
      idea: "Collision case",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-02-01",
    });
    const second = await createIdeaFile({
      idea: "Collision case",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-02-01",
    });
    assert.notEqual(first.path, second.path);
    assert.ok(second.path.endsWith("-2.md"));
    const stillFirst = await fs.readFile(path.join(VAULT, first.path), "utf8");
    assert.match(stillFirst, /idea: Collision case/);
  });

  for (const [field, patch, msgRe] of [
    ["area", { area: "space" }, /area must be one of/],
    ["importance", { importance: 11 }, /importance must be an integer 1\.\.10/],
    ["importance", { importance: 3.5 }, /importance must be an integer 1\.\.10/],
    ["status", { status: "maybe" }, /status must be one of/],
    ["idea", { idea: "" }, /idea is required/],
    ["idea", { idea: "two\nlines" }, /idea must be a single line/],
  ] as const) {
    test(`rejects invalid ${field}: ${JSON.stringify(patch)}`, async () => {
      const base = { idea: "base idea", area: "life", author: "konrad", source: "konrad" } as const;
      await assert.rejects(
        () =>
          createIdeaFile({
            ...base,
            ...patch,
          }),
        (e: unknown) => {
          assert.ok(e instanceof ThoughtsValidationError);
          assert.match(e.message, msgRe);
          return true;
        },
      );
    });
  }
});

describe("listIdeas — default view (unexecuted, oldest first)", () => {
  before(async () => {
    await createIdeaFile({
      idea: "Newest not-started",
      area: "health",
      author: "konrad",
      source: "konrad",
      created: "2026-03-10",
    });
    await createIdeaFile({
      idea: "Oldest not-started",
      area: "health",
      author: "konrad",
      source: "konrad",
      created: "2026-01-05",
    });
    await createIdeaFile({
      idea: "Middle not-started",
      area: "health",
      author: "konrad",
      source: "konrad",
      created: "2026-02-15",
    });
    await createIdeaFile({
      idea: "Already started, excluded from default",
      area: "health",
      status: "started",
      author: "konrad",
      source: "konrad",
      created: "2026-01-01",
    });
  });

  test("sorts not-started ideas oldest (largest age_days) first, and excludes started", async () => {
    const { ideas } = await listIdeas();
    const health = ideas.filter((i) => i.area === "health");
    assert.deepEqual(
      health.map((i) => i.idea),
      ["Oldest not-started", "Middle not-started", "Newest not-started"],
    );
    assert.ok(health.every((i) => i.status === "not-started"));
    assert.ok(health[0].age_days > health[1].age_days);
    assert.ok(health[1].age_days > health[2].age_days);
  });

  test("view=importance sorts descending by importance", async () => {
    await createIdeaFile({ idea: "Low imp", area: "youtube", importance: 2, author: "konrad", source: "konrad" });
    await createIdeaFile({ idea: "High imp", area: "youtube", importance: 9, author: "konrad", source: "konrad" });
    const { ideas } = await listIdeas({ view: "importance" });
    const yt = ideas.filter((i) => i.area === "youtube");
    assert.equal(yt[0].idea, "High imp");
    assert.equal(yt[yt.length - 1].importance <= yt[0].importance, true);
  });

  test("view=area requires and filters by area", async () => {
    const { ideas } = await listIdeas({ view: "area", area: "health" });
    assert.ok(ideas.every((i) => i.area === "health"));
    await assert.rejects(() => listIdeas({ view: "area" }), ThoughtsValidationError);
  });

  test("view=executed returns started/executing/done only", async () => {
    const { ideas } = await listIdeas({ view: "executed" });
    assert.ok(ideas.some((i) => i.idea === "Already started, excluded from default"));
    assert.ok(ideas.every((i) => i.status !== "not-started"));
  });

  test("unknown view is a ThoughtsValidationError naming the field", async () => {
    await assert.rejects(
      () => listIdeas({ view: "bogus" }),
      (e: unknown) => {
        assert.ok(e instanceof ThoughtsValidationError);
        assert.equal(e.field, "view");
        return true;
      },
    );
  });

  test("a file that fails to parse lands in errors[] with its path, not dropped", async () => {
    await writeRaw(`${roots.ideasDir}/broken-not-frontmatter.md`, "no frontmatter here\n");
    const { ideas, errors } = await listIdeas();
    assert.ok(!ideas.some((i) => i.path.includes("broken-not-frontmatter")));
    const err = errors.find((e) => e.path === `${roots.ideasDir}/broken-not-frontmatter.md`);
    assert.ok(err, "expected the broken file to appear in errors[]");
    assert.match(err.message, /open with "---"/);
  });
});

describe("updateIdea — compare-and-swap", () => {
  test("a correct base_sha256 updates status and description", async () => {
    const idea = await createIdeaFile({
      idea: "To be updated",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-04-01",
    });
    const updated = await updateIdea({
      path: idea.path,
      base_sha256: idea.sha256,
      status: "started",
      description: "now in progress",
    });
    assert.equal(updated.status, "started");
    assert.equal(updated.description, "now in progress");
    assert.notEqual(updated.sha256, idea.sha256);
  });

  test("a stale base_sha256 throws VaultConflictError (409 at the route layer)", async () => {
    const idea = await createIdeaFile({
      idea: "Conflict target",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-04-02",
    });
    await assert.rejects(
      () => updateIdea({ path: idea.path, base_sha256: "0".repeat(64), status: "started" }),
      VaultConflictError,
    );
  });

  test("a malformed base_sha256 is a ThoughtsValidationError, not a CAS attempt", async () => {
    const idea = await createIdeaFile({
      idea: "Bad base",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-04-03",
    });
    await assert.rejects(
      () => updateIdea({ path: idea.path, base_sha256: "not-hex", status: "started" }),
      ThoughtsValidationError,
    );
  });
});

describe("adoptIdea — moves a Forge seed to Thoughts/Ideas", () => {
  test("moves the file, sets author/source to konrad, source no longer exists", async () => {
    const seed = await createIdeaFile({
      idea: "Adopt me",
      area: "business",
      author: "forge",
      source: "derived:Inbox/x.md",
      created: "2026-05-01",
    });
    const adopted = await adoptIdea(seed.path);
    assert.equal(adopted.author, "konrad");
    assert.equal(adopted.source, "konrad");
    assert.ok(adopted.path.startsWith(roots.ideasDir + "/"));

    await assert.rejects(() => fs.access(path.join(VAULT, seed.path)), /ENOENT/);
    const landed = await fs.readFile(path.join(VAULT, adopted.path), "utf8");
    assert.match(landed, /author: konrad/);

    const snapDir = await fs.readdir(SNAPSHOTS);
    assert.ok(snapDir.length > 0, "expected a pre-move snapshot directory");
  });

  test("refuses a path outside Forge/Thoughts/Seeds", async () => {
    const idea = await createIdeaFile({
      idea: "Already Konrad's",
      area: "life",
      author: "konrad",
      source: "konrad",
      created: "2026-05-02",
    });
    await assert.rejects(() => adoptIdea(idea.path), ThoughtsValidationError);
  });
});

describe("quotes and dreams — append-only", () => {
  test("addQuote defaults source to konrad and round-trips through listQuotes", async () => {
    const added = await addQuote({ text: 'Ship it: "now" not later' });
    assert.equal(added.source, "konrad");
    const rows = await listQuotes();
    const found = rows.find((r) => r.text === added.text);
    assert.ok(found);
    assert.equal(found.source, "konrad");
  });

  test("addQuote with an explicit source preserves it", async () => {
    await addQuote({ text: "Discipline equals freedom", source: "Jocko" });
    const rows = await listQuotes();
    const found = rows.find((r) => r.text === "Discipline equals freedom");
    assert.equal(found?.source, "Jocko");
  });

  test("dreams never carry a source segment", async () => {
    await addDream({ text: "Flying over the Alps" });
    const rows = await listDreams();
    const found = rows.find((r) => r.text === "Flying over the Alps");
    assert.ok(found);
    const raw = await fs.readFile(path.join(VAULT, roots.dreamsPath), "utf8");
    const line = raw.split("\n").find((l) => l.includes("Flying over the Alps"));
    assert.ok(line);
    assert.ok(!line.includes(" — "));
  });

  test("concurrent appends to the same list file do not lose a line", async () => {
    const before = (await listQuotes()).length;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => addQuote({ text: `Concurrent quote ${i}` })),
    );
    const after = await listQuotes();
    assert.equal(after.length, before + 8);
    for (let i = 0; i < 8; i++) {
      assert.ok(after.some((r) => r.text === `Concurrent quote ${i}`));
    }
  });
});
