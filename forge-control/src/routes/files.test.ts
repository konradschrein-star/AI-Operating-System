/**
 * Tests for routes/files.ts — the D6 decision (round-1 brief, PLAN.md §7):
 * the fleet knowledge base (worker notes under `.claude/projects/.../memory/`)
 * becomes a dedicated read-only root, `memory`, instead of a special case
 * bolted onto an existing one.
 *
 * NOTHING here touches the real trees (vault, workspace, uploads, media, the
 * live aios/forge-src checkouts, or the real fleet memory directory). Every
 * ROOTS.*.dir env var is pointed at a temp dir BEFORE routes/files.ts is
 * dynamically imported, because ROOTS reads those env vars at module load —
 * hence the dynamic import and the top-level await (same technique as
 * lib/vault-routes.test.ts).
 *
 * Run alone: ../forge-control/node_modules/.bin/tsx --test src/routes/files.test.ts
 *
 * NOTE FOR WHOEVER WIRES THIS INTO CI: package.json's "test" script is
 * `tsx --test src/lib/*.test.ts` — a glob that does not reach src/routes/.
 * This file is placed at src/routes/files.test.ts per this round's explicit
 * brief (it names that exact path), matching where files.ts itself lives.
 * It will NOT run under `pnpm test` / gates-808 gate 8 until something widens
 * that glob or adds a second one — flagged to the manager, not silently left.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

async function tmp(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `forge-files-routes-${label}-`));
}

const VAULT = await tmp("vault");
const WORKSPACE = await tmp("workspace");
const UPLOADS = await tmp("uploads");
const MEDIA = await tmp("media");
const AIOS = await tmp("aios");
const FORGE_SRC = await tmp("forge-src");
const MEMORY = await tmp("memory");

process.env.OBSIDIAN_VAULT_DIR = VAULT;
process.env.CC_WORKSPACE = WORKSPACE;
process.env.UPLOAD_DIR = UPLOADS;
process.env.FORGE_MEDIA_DIR = MEDIA;
process.env.AIOS_DIR = AIOS;
process.env.FORGE_SRC_DIR = FORGE_SRC;
process.env.FLEET_MEMORY_DIR = MEMORY;

// Fixture content, written before the router is imported so no test depends
// on write ordering.
await fs.writeFile(path.join(VAULT, "note.md"), "# a vault note\n", "utf8");
await fs.writeFile(
  path.join(MEMORY, "some-gotcha.md"),
  "---\nname: some-gotcha\n---\n\nbody\n",
  "utf8",
);
await fs.writeFile(path.join(MEMORY, "MEMORY.md"), "- [a gotcha](some-gotcha.md)\n", "utf8");
await fs.writeFile(path.join(MEMORY, "notes.txt"), "not markdown\n", "utf8");
await fs.mkdir(path.join(MEMORY, "sub"), { recursive: true });
await fs.writeFile(path.join(MEMORY, "sub", "nested.md"), "nested\n", "utf8");

const router = (await import("./files.ts")).default;
const app = new Hono();
app.route("/api/files", router);

interface RootInfo {
  key: string;
  label: string;
  readOnly?: boolean;
}
interface RootsBody {
  roots: RootInfo[];
}
interface ErrorBody {
  error?: string;
}
interface ListBody {
  entries: { name: string; isDir: boolean }[];
}

async function getRoots(): Promise<RootsBody> {
  const res = await app.request("/api/files/roots");
  assert.equal(res.status, 200);
  return (await res.json()) as RootsBody;
}

const readFile = async (root: string, rel: string): Promise<Response> =>
  await app.request(`/api/files/read?root=${root}&path=${encodeURIComponent(rel)}`);

const listDir = async (root: string, rel = ""): Promise<Response> =>
  await app.request(`/api/files/list?root=${root}&path=${encodeURIComponent(rel)}`);

const writeFile = async (root: string, rel: string, content: string): Promise<Response> =>
  await app.request("/api/files/write", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, path: rel, content }),
  });

describe("GET /api/files/roots", () => {
  test("memory, aios and forge-src advertise readOnly; vault does not", async () => {
    const { roots } = await getRoots();
    const byKey = Object.fromEntries(roots.map((r) => [r.key, r]));
    assert.equal(byKey.memory?.readOnly, true, "memory must be read-only");
    assert.equal(byKey.aios?.readOnly, true);
    assert.equal(byKey["forge-src"]?.readOnly, true);
    // The flip: an existing writable root does NOT carry the flag at all
    // (not `readOnly: false` — genuinely absent, per the /roots handler's
    // conditional spread).
    assert.equal(byKey.vault?.readOnly, undefined, "vault must not be read-only");
    assert.ok(
      roots.some((r) => r.key === "memory"),
      "memory root must be advertised",
    );
  });
});

describe("GET /api/files/read on the memory root", () => {
  test("serves an existing worker note verbatim", async () => {
    const res = await readFile("memory", "some-gotcha.md");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, "---\nname: some-gotcha\n---\n\nbody\n");
  });

  test("serves a nested file too", async () => {
    const res = await readFile("memory", "sub/nested.md");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "nested\n");
  });

  test("a missing note is 404", async () => {
    const res = await readFile("memory", "does-not-exist.md");
    assert.equal(res.status, 404);
  });
});

describe("PUT /api/files/write on read-only roots", () => {
  test("memory root: 403, and the file on disk is unchanged", async () => {
    const before = await fs.readFile(path.join(MEMORY, "some-gotcha.md"), "utf8");
    const res = await writeFile("memory", "some-gotcha.md", "clobbered\n");
    assert.equal(res.status, 403);
    const err = (await res.json()) as ErrorBody;
    assert.match(err.error ?? "", /read-only/);
    assert.equal(
      await fs.readFile(path.join(MEMORY, "some-gotcha.md"), "utf8"),
      before,
      "a 403 must not touch the file",
    );
  });

  test("aios and forge-src roots are still 403 too (ported from round 0)", async () => {
    await fs.writeFile(path.join(AIOS, "guard-autonomy.py"), "# unchanged\n", "utf8");
    const res = await writeFile("aios", "guard-autonomy.py", "clobbered\n");
    assert.equal(res.status, 403);
    assert.equal(
      await fs.readFile(path.join(AIOS, "guard-autonomy.py"), "utf8"),
      "# unchanged\n",
    );
  });

  test("the flip: PUT on the vault root (writable) still lands", async () => {
    const res = await writeFile("vault", "note.md", "# edited\n");
    assert.equal(res.status, 200);
    assert.equal(await fs.readFile(path.join(VAULT, "note.md"), "utf8"), "# edited\n");
    // restore for any later test relying on the original fixture content
    await fs.writeFile(path.join(VAULT, "note.md"), "# a vault note\n", "utf8");
  });
});

describe("resolveInRoot guards on the memory root", () => {
  test("a traversal segment is 400", async () => {
    const res = await readFile("memory", "../x");
    assert.equal(res.status, 400);
  });

  test("a dot-segment relative path is 400 even though the root dir itself is dotted", async () => {
    // MEMORY's own absolute path does not contain a dotted segment (mkdtemp
    // gives a plain temp dir), which is exactly the case this test cannot
    // exercise directly — the real root is under /root/.claude/projects/....
    // What IS exercised, and is the actual guarantee resolveInRoot gives: a
    // caller-supplied relative path with a dot segment is refused regardless
    // of what the root directory itself looks like.
    const res = await readFile("memory", ".hidden");
    assert.equal(res.status, 400);
    const err = (await res.json()) as ErrorBody;
    assert.match(err.error ?? "", /dot segments/);
  });

  test("the flip: a plain nested path with no dot segment is 200", async () => {
    const res = await readFile("memory", "sub/nested.md");
    assert.equal(res.status, 200);
  });
});

describe("GET /api/files/list on the memory root", () => {
  test("lists the .md files (and the non-.md sibling, list does not filter by extension)", async () => {
    const res = await listDir("memory");
    assert.equal(res.status, 200);
    const { entries } = (await res.json()) as ListBody;
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["MEMORY.md", "notes.txt", "some-gotcha.md", "sub"]);
    const mdFiles = entries.filter((e) => !e.isDir && e.name.endsWith(".md"));
    assert.deepEqual(
      mdFiles.map((e) => e.name).sort(),
      ["MEMORY.md", "some-gotcha.md"],
    );
    const sub = entries.find((e) => e.name === "sub");
    assert.equal(sub?.isDir, true);
  });

  test("lists a nested directory too", async () => {
    const res = await listDir("memory", "sub");
    assert.equal(res.status, 200);
    const { entries } = (await res.json()) as ListBody;
    assert.deepEqual(entries.map((e) => e.name), ["nested.md"]);
  });
});
