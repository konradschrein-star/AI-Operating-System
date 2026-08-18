/**
 * Tests for routes/vault.ts — the two HTTP verbs of the edit path (R1–R3, R7–R10)
 * and the transport rules that only exist at the route layer: the status codes,
 * the snake_case wire names, the 409 body, and the absence of a delete verb.
 *
 * WHY A ROUTE TEST LIVES IN src/lib/. `pnpm test` runs `tsx --test src/lib/*.test.ts`
 * and nothing else — a test file under src/routes/ DOES NOT RUN, it merely looks
 * like coverage. Until the test script grows a second glob, this is where a route
 * test has to sit to be executed at all.
 *
 * EVERY assertion is flipped across its boundary in BOTH directions (03-quality.md,
 * governing rule): a refusal is always paired with the neighbouring acceptance, so
 * that a guard which refuses everything cannot pass this file.
 *
 * NOTHING here touches the real vault. The fixture is built under os.tmpdir() and
 * OBSIDIAN_VAULT_DIR / VAULT_SNAPSHOT_DIR are pointed at temp directories BEFORE
 * routes/vault.ts is imported, because lib/vault.ts underneath it reads the env at
 * module load — hence the dynamic imports and the top-level await.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const { makeFixtureVault } = await import("./vault-fixture.ts");

const VAULT = await makeFixtureVault();
const SNAPSHOTS = path.join(
  await fsp.mkdtemp(path.join(os.tmpdir(), "forge-vault-routes-")),
  "snapshots",
);

process.env.OBSIDIAN_VAULT_DIR = VAULT;
process.env.VAULT_SNAPSHOT_DIR = SNAPSHOTS;
delete process.env.VAULT_DAILY_DIR;
delete process.env.VAULT_INBOX_DIR;

const router = (await import("../routes/vault.ts")).default;
const app = new Hono();
app.route("/api/vault", router);

const ROUTE_SOURCE = await fsp.readFile(
  new URL("../routes/vault.ts", import.meta.url),
  "utf8",
);

const abs = (rel: string): string => path.join(VAULT, rel);
const hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");
const read = (rel: string): Promise<string> => fsp.readFile(abs(rel), "utf8");

async function exists(absPath: string): Promise<boolean> {
  try {
    await fsp.stat(absPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

interface FileBody {
  path?: string;
  content?: string;
  sha256?: string;
  mtime_ms?: number;
  mtimeMs?: number;
  bytes?: number;
  ok?: boolean;
  snapshot?: string;
  error?: string;
  current_sha256?: string;
  current_content?: string;
}

async function body(res: Response): Promise<FileBody> {
  return (await res.json()) as FileBody;
}

/** app.request() is typed `Response | Promise<Response>`; awaiting it once here
 *  keeps every call site a plain `await`. */
async function request(
  url: string,
  init?: { method: string; headers: Record<string, string>; body: string },
): Promise<Response> {
  return await app.request(url, init);
}

const getFile = (rel: string): Promise<Response> =>
  request(`/api/vault/file?path=${encodeURIComponent(rel)}`);

const putFile = (payload: unknown): Promise<Response> =>
  request("/api/vault/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const putRaw = (raw: string): Promise<Response> =>
  request("/api/vault/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw,
  });

let seq = 0;
/** A note this test owns outright, so no case depends on another's writes. */
async function scratch(
  content: string,
  opts: { dir?: string; ext?: string } = {},
): Promise<{ rel: string; abs: string; sha256: string }> {
  const rel = `${opts.dir ?? "Notes"}/routes-scratch-${++seq}${opts.ext ?? ".md"}`;
  await fsp.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fsp.writeFile(abs(rel), content, { encoding: "utf8", flag: "wx" });
  return { rel, abs: abs(rel), sha256: hex(content) };
}

// ---------------------------------------------------------------------------
// GET /api/vault/file
// ---------------------------------------------------------------------------

describe("GET /api/vault/file", () => {
  test("returns the exact bytes on disk and their sha256 (R1)", async () => {
    for (const rel of ["Daily/2026-08-18.md", "Notes/crlf-no-eol.md"]) {
      const onDisk = await read(rel);
      const stat = await fsp.stat(abs(rel));
      const res = await getFile(rel);
      assert.equal(res.status, 200, rel);
      const b = await body(res);
      assert.equal(b.path, rel);
      assert.equal(b.content, onDisk, `${rel} content must be byte-identical`);
      assert.equal(b.sha256, hex(onDisk));
      assert.equal(b.bytes, Buffer.byteLength(onDisk, "utf8"));
      assert.equal(b.mtime_ms, stat.mtimeMs);
    }
  });

  test("the hash is over the exact bytes, not a normalised copy (R1)", async () => {
    // The CRLF fixture has no trailing newline. If anything on the read path
    // trimmed or normalised, the hash would match the tidied form instead —
    // both directions asserted, so a normalising read cannot pass.
    const rel = "Notes/crlf-no-eol.md";
    const onDisk = await read(rel);
    const b = await body(await getFile(rel));
    assert.equal(b.sha256, hex(onDisk));
    assert.notEqual(b.sha256, hex(onDisk.replace(/\r\n/g, "\n")));
    assert.notEqual(b.sha256, hex(onDisk.trimEnd() + "\n"));
    assert.ok(b.content?.includes("\r\n"), "CRLF must survive the wire");
  });

  test("mtime_ms is snake_case on the wire, mtimeMs is not present", async () => {
    const b = await body(await getFile("Daily/2026-08-18.md"));
    assert.equal(typeof b.mtime_ms, "number");
    assert.equal(b.mtimeMs, undefined, "the lib's camelCase name must not leak");
  });

  test("a name with spaces and an ampersand round-trips", async () => {
    const rel = "Notes/with spaces & sym.md";
    const res = await getFile(rel);
    assert.equal(res.status, 200);
    const b = await body(res);
    assert.equal(b.path, rel);
    assert.equal(b.content, await read(rel));
  });

  test("missing note 404, existing note 200", async () => {
    const missing = await getFile("Notes/does-not-exist.md");
    assert.equal(missing.status, 404);
    const mb = await body(missing);
    assert.equal(mb.path, "Notes/does-not-exist.md");
    assert.match(mb.error ?? "", /no such note/);

    const present = await getFile("Daily/2026-08-18.md");
    assert.equal(present.status, 200);
  });

  test("non-.md is 400 even when the file exists; the .md sibling is 200 (R10)", async () => {
    const png = await scratch("not markdown\n", { ext: ".png" });
    const md = await scratch("# markdown\n");
    assert.equal((await getFile(png.rel)).status, 400);
    assert.equal((await getFile("_Attachements/x.png")).status, 400);
    assert.equal((await getFile(md.rel)).status, 200);
  });

  test("traversal is 400, the note inside the vault is 200 (R9)", async () => {
    for (const rel of ["../etc/passwd", "/etc/passwd", "Daily/../../x.md"]) {
      const res = await getFile(rel);
      assert.equal(res.status, 400, rel);
      assert.match((await body(res)).error ?? "", /vault/);
    }
    assert.equal((await getFile("Daily/2026-08-18.md")).status, 200);
  });

  test("dot segments are 400 even though the files exist (R9)", async () => {
    // Both of these are real files in the fixture — a guard proven only against
    // paths that do not exist proves nothing about the guard.
    assert.ok(await exists(abs(".obsidian/app.json")));
    assert.ok(await exists(abs(".trash/deleted.md")));
    assert.equal((await getFile(".obsidian/app.json")).status, 400);
    assert.equal((await getFile(".trash/deleted.md")).status, 400);
    assert.equal((await getFile("Notes/crlf-no-eol.md")).status, 200);
  });

  test("missing or blank ?path is 400, a real one is 200", async () => {
    assert.equal((await app.request("/api/vault/file")).status, 400);
    assert.equal((await app.request("/api/vault/file?path=")).status, 400);
    assert.equal((await app.request("/api/vault/file?path=%20%20")).status, 400);
    assert.equal(
      (await app.request("/api/vault/file?path=Daily%2F2026-08-18.md")).status,
      200,
    );
  });
});

// ---------------------------------------------------------------------------
// PUT /api/vault/file
// ---------------------------------------------------------------------------

describe("PUT /api/vault/file", () => {
  test("happy path: 200, bytes land, snapshot holds the PRE-write content (R2, R4)", async () => {
    const before = "# before\n\noriginal thinking\n";
    const note = await scratch(before);
    const next = "# after\n\nedited through the OS\n";

    const res = await putFile({
      path: note.rel,
      content: next,
      base_sha256: note.sha256,
    });
    assert.equal(res.status, 200);
    const b = await body(res);
    assert.equal(b.ok, true);
    assert.equal(b.path, note.rel);
    assert.equal(b.bytes, Buffer.byteLength(next, "utf8"));

    const onDisk = await read(note.rel);
    assert.equal(onDisk, next, "the sent bytes must be the bytes on disk");
    assert.equal(b.sha256, hex(onDisk));

    assert.ok(b.snapshot, "a 200 must name its snapshot");
    assert.ok(await exists(b.snapshot ?? ""), `snapshot missing: ${b.snapshot}`);
    assert.equal(await fsp.readFile(b.snapshot ?? "", "utf8"), before);
    assert.ok(
      !(b.snapshot ?? "").startsWith(VAULT),
      "snapshots live outside the vault",
    );

    // The flip: the same PUT replayed with the now-stale base is refused.
    const replay = await putFile({
      path: note.rel,
      content: "# third\n",
      base_sha256: note.sha256,
    });
    assert.equal(replay.status, 409);
    assert.equal(await read(note.rel), next);
  });

  test("a stale base is 409 carrying current_sha256 AND current_content (R3)", async () => {
    const note = await scratch("# v1\n\nfirst\n");
    const got = await body(await getFile(note.rel));
    const base = got.sha256 ?? "";

    // Another agent writes to the vault between the GET and the PUT.
    const outOfBand = "# v2\n\nwritten by something else\n";
    await fsp.writeFile(note.abs, outOfBand, "utf8");

    const res = await putFile({
      path: note.rel,
      content: "# v3\n\nmy edit\n",
      base_sha256: base,
    });
    assert.equal(res.status, 409);
    const b = await body(res);
    assert.equal(b.current_sha256, hex(outOfBand));
    assert.equal(
      b.current_content,
      outOfBand,
      "without the current content the UI cannot show a diff",
    );
    assert.equal(await read(note.rel), outOfBand, "NOTHING may be written");

    // The flip: re-read, PUT against the fresh base, and it lands.
    const fresh = await body(await getFile(note.rel));
    const ok = await putFile({
      path: note.rel,
      content: "# v3\n\nmy edit\n",
      base_sha256: fresh.sha256,
    });
    assert.equal(ok.status, 200);
    assert.equal(await read(note.rel), "# v3\n\nmy edit\n");
  });

  test("a base taken from a DIFFERENT file is 409 and writes nothing", async () => {
    const target = await scratch("# target\n\nkeep me\n");
    const other = await scratch("# other\n\nunrelated\n");

    const res = await putFile({
      path: target.rel,
      content: "# clobbered\n",
      base_sha256: other.sha256,
    });
    assert.equal(res.status, 409);
    assert.equal((await body(res)).current_sha256, target.sha256);
    assert.equal(await read(target.rel), "# target\n\nkeep me\n");
    assert.equal(await read(other.rel), "# other\n\nunrelated\n");

    const ok = await putFile({
      path: target.rel,
      content: "# clobbered\n",
      base_sha256: target.sha256,
    });
    assert.equal(ok.status, 200);
  });

  test("empty and whitespace-only bodies are 400; one character is 200 (R7)", async () => {
    const note = await scratch("# a year of thinking\n\nplease survive\n");
    for (const content of ["", "   \n\n", "\t\r\n  "]) {
      const res = await putFile({
        path: note.rel,
        content,
        base_sha256: note.sha256,
      });
      assert.equal(res.status, 400, JSON.stringify(content));
      assert.match((await body(res)).error ?? "", /empty content refused/);
      assert.equal(await read(note.rel), "# a year of thinking\n\nplease survive\n");
    }
    const ok = await putFile({
      path: note.rel,
      content: "x",
      base_sha256: note.sha256,
    });
    assert.equal(ok.status, 200, "one non-blank character is a legitimate edit");
    assert.equal(await read(note.rel), "x");
  });

  test("a missing, empty or malformed base_sha256 is 400; the real one is 200 (R2)", async () => {
    const original = "# base guard\n\nunchanged\n";
    const note = await scratch(original);
    const bad: unknown[] = [
      undefined,
      "",
      "   ",
      "not-a-hash",
      note.sha256.toUpperCase(),
      note.sha256.slice(0, 63),
      note.sha256 + "0",
      42,
      null,
      { sha256: note.sha256 },
    ];
    for (const base_sha256 of bad) {
      const res = await putFile({
        path: note.rel,
        content: "# rewritten\n",
        base_sha256,
      });
      assert.equal(res.status, 400, JSON.stringify(base_sha256));
      assert.match((await body(res)).error ?? "", /base_sha256/);
      assert.equal(await read(note.rel), original);
    }
    const ok = await putFile({
      path: note.rel,
      content: "# rewritten\n",
      base_sha256: note.sha256,
    });
    assert.equal(ok.status, 200);
    assert.equal(await read(note.rel), "# rewritten\n");
  });

  test("PUT to a note that does not exist is 400 and creates nothing", async () => {
    const rel = "Notes/never-created-by-put.md";
    assert.equal(await exists(abs(rel)), false);
    const res = await putFile({
      path: rel,
      content: "# would be new\n",
      base_sha256: hex("# would be new\n"),
    });
    assert.equal(res.status, 400, "creation is POST /note's job");
    assert.match((await body(res)).error ?? "", /does not exist/);
    assert.equal(await exists(abs(rel)), false, "no file may appear");

    // The flip: the identical PUT against a note that DOES exist lands.
    const note = await scratch("# exists\n");
    const ok = await putFile({
      path: note.rel,
      content: "# would be new\n",
      base_sha256: note.sha256,
    });
    assert.equal(ok.status, 200);
  });

  test("traversal, dot segments and non-.md are 400 and write nowhere (R9, R10)", async () => {
    const escapee = `routes-escaped-${Date.now()}.md`;
    const outside = path.join(VAULT, "..", escapee);
    const png = await scratch("binary-ish\n", { ext: ".png" });
    const trashBefore = await read(".trash/deleted.md");

    const refused: string[] = [
      `../${escapee}`,
      "/etc/passwd",
      "Daily/../../escaped.md",
      ".trash/deleted.md",
      ".obsidian/app.json",
      png.rel,
      "_Attachements/x.png",
    ];
    for (const rel of refused) {
      const res = await putFile({
        path: rel,
        content: "# should never land\n",
        base_sha256: hex("# should never land\n"),
      });
      assert.equal(res.status, 400, rel);
    }
    assert.equal(await exists(outside), false, "nothing may escape the vault");
    assert.equal(await read(".trash/deleted.md"), trashBefore);
    assert.equal(await read(png.rel), "binary-ish\n");
    assert.equal(await exists(abs("_Attachements/x.png")), false);

    // The flip: a plain .md inside the vault, same payload, lands.
    const note = await scratch("# reachable\n");
    const ok = await putFile({
      path: note.rel,
      content: "# should never land\n",
      base_sha256: note.sha256,
    });
    assert.equal(ok.status, 200);
  });

  test("a malformed body is 400 'invalid json', never an empty write", async () => {
    const original = "# survives a dropped body\n\nintact\n";
    const note = await scratch(original);

    for (const raw of ["", "{not json", '{"path":', "undefined"]) {
      const res = await putRaw(raw);
      assert.equal(res.status, 400, JSON.stringify(raw));
      assert.match((await body(res)).error ?? "", /invalid json/);
      assert.equal(await read(note.rel), original);
    }
    // Valid JSON that is not an object is equally not a write instruction.
    for (const raw of ['"a string"', "[]", "null", "7"]) {
      const res = await putRaw(raw);
      assert.equal(res.status, 400, raw);
      assert.match((await body(res)).error ?? "", /invalid json/);
      assert.equal(await read(note.rel), original);
    }

    // The flip: the same request with a well-formed object body succeeds.
    const ok = await putRaw(
      JSON.stringify({
        path: note.rel,
        content: "# parsed\n",
        base_sha256: note.sha256,
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal(await read(note.rel), "# parsed\n");
  });
});

// ---------------------------------------------------------------------------
// R8 — no delete verb. Absent, not disabled.
// ---------------------------------------------------------------------------

describe("the vault surface has no delete verb (R8)", () => {
  test("DELETE /api/vault/file is unrouted while GET on the same path works", async () => {
    const note = await scratch("# still here\n");
    const del = await app.request("/api/vault/file", { method: "DELETE" });
    assert.ok(
      del.status === 404 || del.status === 405,
      `DELETE must not be routed, got ${del.status}`,
    );
    assert.equal(await read(note.rel), "# still here\n");
    assert.equal((await getFile(note.rel)).status, 200);
  });

  test("the route source registers nothing that removes, renames or moves a note", async () => {
    // Mirrors the reviewer's grep exactly: /\.delete|unlink|rename\(/.
    const hits = ROUTE_SOURCE.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\.delete|unlink|rename\(/.test(line));
    assert.deepEqual(
      hits,
      [],
      `removal verbs found: ${hits.map((h) => `${h.n}: ${h.line.trim()}`).join(" | ")}`,
    );
    // The flip: the same scan DOES find the two verbs this file registers, so a
    // scan that matches nothing at all cannot pass as proof.
    assert.match(ROUTE_SOURCE, /r\.get\("\/file"/);
    assert.match(ROUTE_SOURCE, /r\.put\("\/file"/);
  });

  test("the three pre-existing verbs are still mounted (R11)", async () => {
    assert.equal((await app.request("/api/vault/daily")).status, 200);
    const bad = await app.request("/api/vault/append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section: "Nope", text: "x" }),
    });
    assert.equal(bad.status, 400, "append still validates its section");
  });
});
