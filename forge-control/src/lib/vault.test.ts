/**
 * Tests for lib/vault.ts — the edit path into the second brain, plus a
 * characterisation of the three verbs that existed before it (R11).
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts — a test anywhere else does
 * not run at all)
 *
 * EVERY assertion here is flipped across its boundary in BOTH directions
 * (03-quality.md, governing rule): an assertion over a clause that every
 * branch shares passes at every fixture value and proves nothing.
 *
 * NOTHING in this file touches the real vault. The fixture is built by
 * ./vault-fixture.ts under os.tmpdir(), and OBSIDIAN_VAULT_DIR is pointed at
 * it BEFORE lib/vault.ts is imported, because that module reads the env at
 * module load — deliberately, so the guard everything shares stays a const.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { makeFixtureVault, FIXTURE_NOTES } from "./vault-fixture.ts";

const VAULT = await makeFixtureVault();
const SNAPSHOT_PARENT = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-vault-snapshots-"));
const SNAPSHOTS = path.join(SNAPSHOT_PARENT, "store");

process.env.OBSIDIAN_VAULT_DIR = VAULT;
process.env.VAULT_SNAPSHOT_DIR = SNAPSHOTS;
delete process.env.OBSIDIAN_VAULT_NAME;
delete process.env.VAULT_DAILY_DIR;
delete process.env.VAULT_INBOX_DIR;

const vault = await import("./vault.ts");

const SOURCE = await fsp.readFile(new URL("./vault.ts", import.meta.url), "utf8");

/** Source inspection must measure CODE, not prose: the module header discusses
 *  fs.rename() by name, and a grep that counts its own documentation reports a
 *  second call site that does not exist. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
const CODE = stripComments(SOURCE);

const TZ = process.env.REMINDER_TZ ?? "Europe/Berlin";
const abs = (rel: string): string => path.join(VAULT, rel);
const hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

let scratchSeq = 0;
/** A note this test owns outright, so no test depends on another's writes. */
async function scratchNote(content: string): Promise<{ rel: string; abs: string }> {
  const rel = `Notes/scratch-${++scratchSeq}.md`;
  const target = abs(rel);
  await fsp.writeFile(target, content, { encoding: "utf8", flag: "wx" });
  return { rel, abs: target };
}

const isRefused = (e: unknown): e is InstanceType<typeof vault.VaultRefusedError> =>
  e instanceof vault.VaultRefusedError && e.name === "VaultRefusedError";

// ---------------------------------------------------------------------------

describe("resolveInVault is reused, not reimplemented (R9, R10)", () => {
  // Five rejects AND three accepts. A guard test with only rejects passes
  // when the guard rejects everything.
  const REJECTS = [
    "../etc/passwd",
    "/etc/passwd",
    ".obsidian/app.json",
    "Daily/../../x.md",
    ".trash/x.md",
  ];
  const ACCEPTS = [
    "Daily/2026-08-18.md",
    "Notes/with spaces & sym.md",
    "Notes/unicode — em dash.md",
  ];

  for (const rel of REJECTS) {
    test(`readVaultFile refuses ${rel}`, async () => {
      await assert.rejects(() => vault.readVaultFile(rel), isRefused);
    });
    test(`writeVaultFile refuses ${rel}`, async () => {
      await assert.rejects(
        () => vault.writeVaultFile({ path: rel, content: "x\n", baseSha256: hex("x\n") }),
        isRefused,
      );
    });
  }

  for (const rel of ACCEPTS) {
    test(`readVaultFile accepts ${rel}`, async () => {
      const read = await vault.readVaultFile(rel);
      assert.equal(read.path, rel);
      assert.equal(read.content, FIXTURE_NOTES[rel]);
    });
  }

  test(".trash and .obsidian exist on disk — the guard, not absence, refuses them", async () => {
    await assert.doesNotReject(() => fsp.access(abs(".trash/deleted.md")));
    await assert.doesNotReject(() => fsp.access(abs(".obsidian/app.json")));
  });

  test("non-.md is refused, .md is not (R10)", async () => {
    await assert.rejects(() => vault.readVaultFile("_Attachements/x.png"), isRefused);
    await assert.rejects(
      () =>
        vault.writeVaultFile({
          path: "_Attachements/x.png",
          content: "x\n",
          baseSha256: hex("x\n"),
        }),
      isRefused,
    );
    // Flip: the same non-existent folder with a .md name gets past the
    // extension guard and fails later, on the read — so the refusal above is
    // the extension, not the missing file.
    await assert.rejects(
      () => vault.readVaultFile("_Attachements/x.md"),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    // And a real .md is read.
    assert.equal((await vault.readVaultFile("Empty.md")).bytes, 0);
  });
});

describe("sha256 is over the exact bytes (R1)", () => {
  test("hash equals sha256sum of the file, CRLF and no trailing newline", async () => {
    const rel = "Notes/crlf-no-eol.md";
    const read = await vault.readVaultFile(rel);
    const shell = execFileSync("sha256sum", [abs(rel)], { encoding: "utf8" }).split(/\s+/)[0];
    assert.equal(read.sha256, shell);
    // Read back exactly: no trim, no newline normalisation, no re-encoding.
    assert.equal(read.content, FIXTURE_NOTES[rel]);
    assert.ok(read.content.includes("\r\n"), "fixture must carry CRLF or this proves nothing");
    assert.ok(!read.content.endsWith("\n"), "fixture must lack a trailing newline");
    assert.equal(read.bytes, Buffer.byteLength(FIXTURE_NOTES[rel], "utf8"));
  });

  test("same bytes → same hash; ONE BYTE CHANGED → different hash", async () => {
    const a = await scratchNote("abc\n");
    const copy = await scratchNote("abc\n");
    const b = await scratchNote("abd\n"); // one byte differs
    const [ra, rcopy, rb] = await Promise.all([
      vault.readVaultFile(a.rel),
      vault.readVaultFile(copy.rel),
      vault.readVaultFile(b.rel),
    ]);
    assert.equal(ra.sha256, rcopy.sha256);
    assert.notEqual(ra.sha256, rb.sha256);
    assert.equal(
      ra.sha256,
      execFileSync("sha256sum", [a.abs], { encoding: "utf8" }).split(/\s+/)[0],
    );
  });

  test("mtimeMs comes from the filesystem", async () => {
    const note = await scratchNote("# mtime\n");
    const read = await vault.readVaultFile(note.rel);
    const stat = await fsp.stat(note.abs);
    assert.equal(read.mtimeMs, stat.mtimeMs);
  });
});

describe("writeVaultFile refuses before it touches anything (R2, R7)", () => {
  test("empty and whitespace-only bodies are refused; 'x' is accepted", async () => {
    const note = await scratchNote("# keep me\n\noriginal\n");
    const base = hex("# keep me\n\noriginal\n");
    const bad: unknown[] = ["", "   ", "\n\n", "\t \n ", null, undefined, 42];
    for (const content of bad) {
      await assert.rejects(
        () =>
          vault.writeVaultFile({
            path: note.rel,
            content: content as string,
            baseSha256: base,
          }),
        (e: unknown) => isRefused(e) && /empty content refused/.test(e.reason),
        `expected refusal for ${JSON.stringify(content)}`,
      );
      assert.equal(await fsp.readFile(note.abs, "utf8"), "# keep me\n\noriginal\n");
    }
    // Flip: one non-blank character is accepted.
    const ok = await vault.writeVaultFile({ path: note.rel, content: "x", baseSha256: base });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "x");
    assert.equal(ok.sha256, hex("x"));
    assert.equal(ok.bytes, 1);
  });

  test("a missing or malformed base is refused; a valid 64-hex base is not", async () => {
    const note = await scratchNote("# base\n");
    const good = hex("# base\n");
    const bad: unknown[] = [
      undefined,
      null,
      "",
      "not-a-hash",
      good.slice(0, 63), // 63 hex
      good + "0", // 65 hex
      good.toUpperCase(), // uppercase is not the canonical form
      42,
    ];
    for (const baseSha256 of bad) {
      await assert.rejects(
        () =>
          vault.writeVaultFile({
            path: note.rel,
            content: "changed\n",
            baseSha256: baseSha256 as string,
          }),
        (e: unknown) => isRefused(e) && /base_sha256 required/.test(e.reason),
        `expected refusal for base ${JSON.stringify(baseSha256)}`,
      );
      assert.equal(await fsp.readFile(note.abs, "utf8"), "# base\n");
    }
    // Flip: the correct 64-hex base writes.
    await vault.writeVaultFile({ path: note.rel, content: "changed\n", baseSha256: good });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "changed\n");
  });

  test("a note that does not exist is refused, not created", async () => {
    const rel = "Notes/never-created.md";
    await assert.rejects(
      () => vault.writeVaultFile({ path: rel, content: "x\n", baseSha256: hex("x\n") }),
      (e: unknown) => isRefused(e) && /note does not exist/.test(e.reason),
    );
    await assert.rejects(() => fsp.access(abs(rel)), (e: unknown) =>
      (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    // Flip: the same call against an existing note writes.
    const note = await scratchNote("# exists\n");
    await vault.writeVaultFile({
      path: note.rel,
      content: "x\n",
      baseSha256: hex("# exists\n"),
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "x\n");
  });
});

describe("compare-and-swap on content, never mtime (R2, R3)", () => {
  test("matching base writes; mismatched base throws and writes NOTHING", async () => {
    const note = await scratchNote("# cas\n\nv1\n");
    const read = await vault.readVaultFile(note.rel);

    // Matching base → writes.
    const result = await vault.writeVaultFile({
      path: note.rel,
      content: "# cas\n\nv2\n",
      baseSha256: read.sha256,
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# cas\n\nv2\n");
    assert.equal(result.sha256, hex("# cas\n\nv2\n"));
    assert.equal(result.path, note.rel);

    // Someone else (an agent, LiveSync, Obsidian) writes out of band.
    await fsp.writeFile(note.abs, "# cas\n\nv3 from elsewhere\n", "utf8");

    // The now-stale base → conflict, nothing written, both fields present.
    await assert.rejects(
      () =>
        vault.writeVaultFile({
          path: note.rel,
          content: "# cas\n\nv2 again\n",
          baseSha256: read.sha256,
        }),
      (e: unknown) => {
        assert.ok(e instanceof vault.VaultConflictError);
        assert.equal(e.name, "VaultConflictError");
        assert.equal(e.currentSha256, hex("# cas\n\nv3 from elsewhere\n"));
        assert.equal(e.currentContent, "# cas\n\nv3 from elsewhere\n");
        return true;
      },
    );
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# cas\n\nv3 from elsewhere\n");
  });

  test("a touched mtime with identical content is NOT a conflict", async () => {
    // LiveSync touches mtimes without changing content. Detecting conflicts on
    // mtime would train the operator to click through the real ones.
    const note = await scratchNote("# mtime-only\n");
    const read = await vault.readVaultFile(note.rel);
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(note.abs, future, future);
    const after = await vault.readVaultFile(note.rel);
    assert.notEqual(after.mtimeMs, read.mtimeMs);
    await assert.doesNotReject(() =>
      vault.writeVaultFile({
        path: note.rel,
        content: "# mtime-only\n\nedited\n",
        baseSha256: read.sha256,
      }),
    );
  });
});

describe("the snapshot is load-bearing (R4, R5)", () => {
  test("the pre-write bytes are recoverable, outside the vault", async () => {
    const before1 = "# snapshot\n\nthe year of thinking\n";
    const note = await scratchNote(before1);
    const result = await vault.writeVaultFile({
      path: note.rel,
      content: "# snapshot\n\nreplaced\n",
      baseSha256: hex(before1),
    });
    assert.equal(await fsp.readFile(result.snapshot, "utf8"), before1);
    assert.ok(
      result.snapshot.startsWith(SNAPSHOTS + path.sep),
      `snapshot ${result.snapshot} must live in the store`,
    );
    assert.ok(
      !result.snapshot.startsWith(path.resolve(VAULT) + path.sep),
      "a snapshot inside the vault would pollute the thing it protects",
    );
    assert.match(path.basename(result.snapshot), /^Notes__scratch-\d+\.md\.\d{13}\.md$/);
  });

  test("a snapshot that cannot be written aborts the write (R5)", async () => {
    // We run as ROOT: chmod 000 does not stop root, so a permission-based
    // version of this test would pass vacuously. ENOTDIR does stop root —
    // point the store at a path whose parent is a regular FILE.
    const notADir = path.join(SNAPSHOT_PARENT, "notadir");
    await fsp.writeFile(notADir, "I am a file, not a directory\n", "utf8");

    const original = "# undo\n\nmust survive\n";
    const note = await scratchNote(original);
    const previous = process.env.VAULT_SNAPSHOT_DIR;
    process.env.VAULT_SNAPSHOT_DIR = path.join(notADir, "store");
    try {
      await assert.rejects(
        () =>
          vault.writeVaultFile({
            path: note.rel,
            content: "# undo\n\nclobbered\n",
            baseSha256: hex(original),
          }),
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /vault snapshot failed/);
          assert.match(e.message, /THE NOTE WAS NOT WRITTEN/);
          // Not a refusal and not a conflict: the route layer must map this
          // to a 500, not a 400 or a 409.
          assert.ok(!(e instanceof vault.VaultRefusedError));
          assert.ok(!(e instanceof vault.VaultConflictError));
          return true;
        },
      );
      assert.equal(await fsp.readFile(note.abs, "utf8"), original);
      const leftovers = (await fsp.readdir(path.dirname(note.abs))).filter((f) =>
        f.includes(".tmp-"),
      );
      assert.deepEqual(leftovers, []);
    } finally {
      process.env.VAULT_SNAPSHOT_DIR = previous;
    }

    // Flip: with the store restored, the identical write succeeds.
    const ok = await vault.writeVaultFile({
      path: note.rel,
      content: "# undo\n\nclobbered\n",
      baseSha256: hex(original),
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# undo\n\nclobbered\n");
    assert.equal(await fsp.readFile(ok.snapshot, "utf8"), original);
  });
});

describe("the write is atomic (R6)", () => {
  test("a failed rename leaves the original bytes and no temp file", async () => {
    const original = "# atomic\n\nintact\n";
    const note = await scratchNote(original);

    // Force a mid-write failure at the last step. fs.rename is looked up on
    // the shared node:fs promises object at call time, so replacing it here
    // replaces the one the module calls.
    const realRename = fsp.rename;
    fsp.rename = async (): Promise<void> => {
      const err: NodeJS.ErrnoException = new Error("EXDEV: simulated cross-device rename");
      err.code = "EXDEV";
      throw err;
    };
    try {
      await assert.rejects(
        () =>
          vault.writeVaultFile({
            path: note.rel,
            content: "# atomic\n\nnever lands\n",
            baseSha256: hex(original),
          }),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "EXDEV",
      );
    } finally {
      fsp.rename = realRename;
    }

    assert.equal(await fsp.readFile(note.abs, "utf8"), original);
    const leftovers = (await fsp.readdir(path.dirname(note.abs))).filter((f) =>
      f.includes(".tmp-"),
    );
    assert.deepEqual(leftovers, [], "the temp file must be cleaned up on failure");

    // Flip: with rename restored, the identical write lands.
    await vault.writeVaultFile({
      path: note.rel,
      content: "# atomic\n\nnever lands\n",
      baseSha256: hex(original),
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# atomic\n\nnever lands\n");
  });

  test("by source inspection: the destination is reached only by rename", () => {
    const start = CODE.indexOf("export async function writeVaultFile");
    assert.notEqual(start, -1, "writeVaultFile must be exported from lib/vault.ts");
    const rest = CODE.slice(start + 1);
    const end = rest.indexOf("\nexport ");
    const body = end === -1 ? rest : rest.slice(0, end);

    const DIRECT_WRITE = /(writeFile|appendFile|truncate|createWriteStream|open)\(\s*abs\b/;
    assert.match(body, /await fs\.rename\(tmpAbs, abs\)/);
    assert.doesNotMatch(body, DIRECT_WRITE, "no code path may write the destination directly");
    // Flip the inspection itself: the same regex DOES match a direct write, so
    // the assertion above is not a pattern that could never fire.
    assert.match('await fs.writeFile(abs, next, "utf8")', DIRECT_WRITE);

    // Exactly one rename call in the whole module, and it is that one. Counted
    // over CODE — SOURCE also mentions fs.rename() in the header prose.
    assert.equal(CODE.split("fs.rename(").length - 1, 1);
    assert.ok(SOURCE.split("fs.rename(").length - 1 > 1, "the header documents it too");
    // Flip the stripper: it must remove a commented-out call, not everything.
    assert.equal(stripComments("// fs.rename(a)\nfs.rename(b)\n").trim(), "fs.rename(b)");
  });
});

describe("obsidianUri (R18) and vaultName (R19)", () => {
  // The two worked vectors from the phase-0 scout, S-B-obsidian-uri.md §3.
  const VECTORS = [
    {
      p: "AI OS/Specs/Directory + Business Plan Hub — Business Model.md",
      uri:
        "obsidian://open?vault=obsidian-vault&file=AI%20OS%2FSpecs%2FDirectory%20%2B%20" +
        "Business%20Plan%20Hub%20%E2%80%94%20Business%20Model.md",
    },
    {
      p: "40_Life Knowledge/x & y.md",
      uri: "obsidian://open?vault=obsidian-vault&file=40_Life%20Knowledge%2Fx%20%26%20y.md",
    },
    {
      p: "Notes/q? #hash.md",
      uri: "obsidian://open?vault=obsidian-vault&file=Notes%2Fq%3F%20%23hash.md",
    },
  ];

  for (const v of VECTORS) {
    test(`exact URI, round-trip, and differs from encodeURI: ${v.p}`, () => {
      const got = vault.obsidianUri({ vaultName: "obsidian-vault", vaultRelativePath: v.p });
      assert.equal(got, v.uri);

      // Round-trip through a real URL parser and through decodeURIComponent.
      const parsed = new URL(got);
      assert.equal(parsed.searchParams.get("vault"), "obsidian-vault");
      assert.equal(parsed.searchParams.get("file"), v.p);
      assert.equal(decodeURIComponent(got.split("&file=")[1]), v.p);

      // The naive implementation this must never regress to.
      const naive =
        `obsidian://open?vault=${encodeURI("obsidian-vault")}&file=${encodeURI(v.p)}`;
      assert.notEqual(naive, got);
      assert.notEqual(new URL(naive).searchParams.get("file"), v.p);
    });
  }

  test("the .md extension is kept", () => {
    const got = vault.obsidianUri({
      vaultName: "obsidian-vault",
      vaultRelativePath: "Draw.excalidraw.md",
    });
    assert.equal(got, "obsidian://open?vault=obsidian-vault&file=Draw.excalidraw.md");
    assert.ok(got.endsWith(".md"));
  });

  test("an empty component is refused rather than emitted as a dead link", () => {
    assert.throws(
      () => vault.obsidianUri({ vaultName: "", vaultRelativePath: "Daily/x.md" }),
      isRefused,
    );
    assert.throws(
      () => vault.obsidianUri({ vaultName: "obsidian-vault", vaultRelativePath: "" }),
      isRefused,
    );
    assert.doesNotThrow(() =>
      vault.obsidianUri({ vaultName: "obsidian-vault", vaultRelativePath: "Daily/x.md" }),
    );
  });

  test("vaultName is configuration: basename by default, env wins", () => {
    const previousDir = process.env.OBSIDIAN_VAULT_DIR;
    try {
      // Default: the basename of the configured vault directory.
      delete process.env.OBSIDIAN_VAULT_NAME;
      assert.equal(vault.vaultName(), path.basename(VAULT));

      // Flip the directory: the derived name follows it.
      process.env.OBSIDIAN_VAULT_DIR = "/srv/another-vault-folder";
      assert.equal(vault.vaultName(), "another-vault-folder");

      // Flip the override: OBSIDIAN_VAULT_NAME wins, and the URI changes.
      process.env.OBSIDIAN_VAULT_NAME = "Konrads Zweitgehirn";
      assert.equal(vault.vaultName(), "Konrads Zweitgehirn");
      assert.equal(
        vault.obsidianUri({
          vaultName: vault.vaultName(),
          vaultRelativePath: "Daily/2026-08-18.md",
        }),
        "obsidian://open?vault=Konrads%20Zweitgehirn&file=Daily%2F2026-08-18.md",
      );
    } finally {
      delete process.env.OBSIDIAN_VAULT_NAME;
      process.env.OBSIDIAN_VAULT_DIR = previousDir;
    }
  });
});

describe("no verb removes, renames or moves a note (R8)", () => {
  test("the module exports nothing that could", () => {
    const exported = Object.keys(vault).filter((k) =>
      /delete|remove|unlink|rename|move|trash|truncate|destroy/i.test(k),
    );
    assert.deepEqual(exported, []);
    // Flip: the filter is not a no-op — it catches a name that would qualify.
    assert.deepEqual(
      ["deleteNote", "readVaultFile"].filter((k) => /delete|remove|unlink/i.test(k)),
      ["deleteNote"],
    );
  });
});

// ---------------------------------------------------------------------------
// R11 — the three pre-existing verbs must behave exactly as they did before
// this project. Runs last, and puts the fixture's daily note back afterwards.
// ---------------------------------------------------------------------------

describe("R11 characterisation — appendToDailyNote, createNote, readDailyNote", () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dailyRel = `Daily/${today}.md`;
  const dailyAbs = abs(dailyRel);
  const stash = `${dailyAbs}.characterisation-stash`;
  let stashed = false;

  before(async () => {
    // Today may or may not be the fixture's 2026-08-18. Move any note for
    // today aside so the "absent" branch is reachable on every calendar day;
    // this is a tmpdir fixture, never the vault.
    try {
      await fsp.rename(dailyAbs, stash);
      stashed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  });

  after(async () => {
    if (stashed) await fsp.rename(stash, dailyAbs);
  });

  test("readDailyNote reports content: null when today's note is absent", async () => {
    const read = await vault.readDailyNote();
    assert.deepEqual(read, { path: dailyRel, date: today, content: null });
  });

  test("appendToDailyNote creates today's note from the template, exact bytes", async () => {
    const result = await vault.appendToDailyNote({
      section: "Tasks",
      text: "characterisation line",
    });
    assert.deepEqual(result, { path: dailyRel, created: true });

    const content = await fsp.readFile(dailyAbs, "utf8");
    // The clock is the one byte-range this test cannot fix, so it is read back
    // out of the result and asserted for shape; every other byte is compared
    // against the literal below.
    const stamp = /^- (\d{2}:\d{2}) — characterisation line$/m.exec(content);
    assert.ok(stamp, `no timestamped bullet in:\n${content}`);
    assert.equal(
      content,
      `# ${today}\n\n## Tasks\n- ${stamp[1]} — characterisation line\n\n## Notes\n\n## Journal\n`,
    );
  });

  test("a second append inserts under its own section and creates nothing", async () => {
    const before2 = await fsp.readFile(dailyAbs, "utf8");
    const firstLine = /^- \d{2}:\d{2} — characterisation line$/m.exec(before2);
    assert.ok(firstLine);

    const result = await vault.appendToDailyNote({
      section: "Notes",
      text: "a task, not a bullet",
      prefix: "- [ ] ",
    });
    assert.deepEqual(result, { path: dailyRel, created: false });

    const content = await fsp.readFile(dailyAbs, "utf8");
    const stamp = /^- \[ \] (\d{2}:\d{2}) — a task, not a bullet$/m.exec(content);
    assert.ok(stamp, `no task bullet in:\n${content}`);
    assert.equal(
      content,
      `# ${today}\n\n## Tasks\n${firstLine[0]}\n\n## Notes\n` +
        `- [ ] ${stamp[1]} — a task, not a bullet\n\n## Journal\n`,
    );

    // Flip of the first characterisation test: the note now exists, so
    // readDailyNote returns it rather than null.
    assert.deepEqual(await vault.readDailyNote(), {
      path: dailyRel,
      date: today,
      content,
    });
  });

  test("createNote never overwrites — the second collision gets ' 2'", async () => {
    const first = await vault.createNote({ title: "Fixture Capture", content: "body text" });
    assert.deepEqual(first, { path: "Inbox/Fixture Capture.md", created: true });

    const second = await vault.createNote({ title: "Fixture Capture", content: "body text" });
    assert.deepEqual(second, { path: "Inbox/Fixture Capture 2.md", created: true });

    const content = await fsp.readFile(abs(first.path), "utf8");
    const captured = /^captured: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/m.exec(content);
    assert.ok(captured, `no captured stamp in:\n${content}`);
    assert.equal(
      content,
      `# Fixture Capture\n\nbody text\n\n---\ncaptured: ${captured[1]}\nsource: ai-os\n`,
    );

    // Flip: the first note is untouched by the second call.
    assert.equal(await fsp.readFile(abs(first.path), "utf8"), content);
  });
});
