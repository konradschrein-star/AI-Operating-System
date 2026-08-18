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
    // <flat path>.<epoch-ms>-<random>.md — the random suffix is what stops two
    // edits inside one millisecond from colliding on the "wx" write below and
    // refusing the second, valid, edit with a 500.
    assert.match(
      path.basename(result.snapshot),
      /^Notes__scratch-\d+\.md\.\d{13}-[0-9a-f]{8}\.md$/,
    );
  });

  test("two edits inside ONE millisecond both snapshot and both land", async () => {
    // Freezing the clock is the only way to make the collision deterministic:
    // with a real clock two sequential edits are milliseconds apart and the
    // defect (a `<flat>.<ms>.md` name written "wx") hides. Measured on the
    // frozen clock before the random suffix existed: edit 2 was refused with
    // "vault snapshot failed … THE NOTE WAS NOT WRITTEN" and the note kept
    // edit 1's bytes.
    const v1 = "# same-ms\n\nv1\n";
    const v2 = "# same-ms\n\nv2\n";
    const v3 = "# same-ms\n\nv3\n";
    const note = await scratchNote(v1);
    const realNow = Date.now;
    Date.now = () => 1_787_000_000_000;
    let first: Awaited<ReturnType<typeof vault.writeVaultFile>>;
    let second: Awaited<ReturnType<typeof vault.writeVaultFile>>;
    try {
      first = await vault.writeVaultFile({ path: note.rel, content: v2, baseSha256: hex(v1) });
      second = await vault.writeVaultFile({ path: note.rel, content: v3, baseSha256: hex(v2) });
    } finally {
      Date.now = realNow;
    }
    assert.equal(await fsp.readFile(note.abs, "utf8"), v3);
    // Both snapshots exist, both carry the SAME frozen millisecond, and they
    // are different files — that pair is the whole fix.
    assert.notEqual(first.snapshot, second.snapshot);
    assert.equal(await fsp.readFile(first.snapshot, "utf8"), v1);
    assert.equal(await fsp.readFile(second.snapshot, "utf8"), v2);
    assert.match(path.basename(first.snapshot), /\.1787000000000-[0-9a-f]{8}\.md$/);
    assert.match(path.basename(second.snapshot), /\.1787000000000-[0-9a-f]{8}\.md$/);
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

  test("by source inspection: NO verb in the module opens a destination O_TRUNC", () => {
    // THE PREVIOUS VERSION OF THIS TEST WAS SCOPED TO writeVaultFile's OWN BODY
    // and then used the literal `await fs.writeFile(abs, next, "utf8")` as its
    // negative control — a line that was, at the time, line 170 of the module
    // under test, inside appendToDailyNote. The counterexample was the very code
    // the assertion had been scoped away from. R6 is a property of the MODULE,
    // so the subject here is the whole module.
    const DIRECT_WRITE = /(writeFile|appendFile|truncate|createWriteStream|open)\(\s*abs\b[^\n]*/g;
    const hits = CODE.match(DIRECT_WRITE) ?? [];
    // Not vacuous: there ARE direct writes to a path named `abs` in this module
    // (createNote's collision-safe create, and the snapshot store's own write).
    assert.ok(hits.length >= 2, `expected direct-write sites to inspect, found ${hits.length}`);
    for (const hit of hits) {
      assert.match(
        hit,
        /flag: "wx"/,
        `every direct write to a destination must be an exclusive create; this one is not: ${hit}`,
      );
    }
    // Flip the inspection itself: the same regex matches a TRUNCATING write and
    // that write fails the wx assertion, so neither half could never fire.
    assert.match('await fs.writeFile(abs, next, "utf8")', DIRECT_WRITE);
    assert.doesNotMatch('await fs.writeFile(abs, next, "utf8")', /flag: "wx"/);

    // The one non-exclusive write path in the module is atomicWrite, and it
    // reaches the destination only by renaming a temp file onto it.
    assert.match(CODE, /async function atomicWrite\(/);
    assert.match(CODE, /await fs\.rename\(tmpAbs, input\.abs\)/);
    assert.equal(CODE.split("fs.rename(").length - 1, 1);
    assert.ok(SOURCE.split("fs.rename(").length - 1 > 1, "the header documents it too");

    // And the two verbs that used to write in place now call it.
    for (const verb of ["appendToDailyNote", "writeVaultFile"]) {
      const start = CODE.indexOf(`export async function ${verb}`);
      assert.notEqual(start, -1, `${verb} must be exported from lib/vault.ts`);
      const rest = CODE.slice(start + 1);
      const end = rest.indexOf("\nexport ");
      const body = end === -1 ? rest : rest.slice(0, end);
      assert.match(body, /await atomicWrite\(\{/, `${verb} must write through atomicWrite`);
    }

    // Flip the stripper: it must remove a commented-out call, not everything.
    assert.equal(stripComments("// fs.rename(a)\nfs.rename(b)\n").trim(), "fs.rename(b)");
  });

  test("the two surviving wx writes must NOT be routed through atomicWrite (R6 deviation)", async () => {
    // R1-gate's blocker 3 was worded "no writeFile(abs…) anywhere in the
    // module". Two sites survive — createNote's collision-safe create and the
    // snapshot store's own write — and both carry flag: "wx", which cannot
    // truncate: the open fails EEXIST and the existing bytes are untouched.
    // The DEFECT the wording targets is therefore closed.
    //
    // Taking the wording literally would REGRESS the module. atomicWrite
    // reaches its destination by rename, and rename replaces an existing file
    // silently — which is exactly the collision these two sites detect. This
    // test exists so a later "cleanup" that finishes the literal instruction is
    // caught by a red test rather than by Konrad losing a note.
    const hits = CODE.match(/writeFile\(\s*abs\b[^\n]*/g) ?? [];
    assert.equal(hits.length, 2, `expected exactly the two known wx sites, got ${hits.length}`);
    for (const hit of hits) assert.match(hit, /flag: "wx"/);

    // Behavioural, not structural: "wx" refuses rather than truncates.
    const guarded = path.join(SNAPSHOT_PARENT, "wx-guard.md");
    const body = "# guarded\n\n" + "bytes that must survive\n".repeat(200);
    await fsp.writeFile(guarded, body, "utf8");
    await assert.rejects(
      () => fsp.writeFile(guarded, "S", { encoding: "utf8", flag: "wx" }),
      (e: NodeJS.ErrnoException) => e.code === "EEXIST",
    );
    assert.equal(await fsp.readFile(guarded, "utf8"), body, "wx must not truncate");

    // And the property each site protects, end to end: a second snapshot of the
    // same note in the same millisecond becomes a SECOND FILE, never an
    // overwrite of the first. (createNote's twin is covered by the R11
    // characterisation test "createNote never overwrites".)
    const v1 = "# wx-two\n\nv1\n";
    const v2 = "# wx-two\n\nv2\n";
    const v3 = "# wx-two\n\nv3\n";
    const note = await scratchNote(v1);
    const realNow = Date.now;
    Date.now = () => 1_787_111_111_111;
    try {
      const first = await vault.writeVaultFile({ path: note.rel, content: v2, baseSha256: hex(v1) });
      const second = await vault.writeVaultFile({ path: note.rel, content: v3, baseSha256: hex(v2) });
      assert.notEqual(first.snapshot, second.snapshot);
      assert.equal(await fsp.readFile(first.snapshot, "utf8"), v1, "snapshot 1 must survive");
      assert.equal(await fsp.readFile(second.snapshot, "utf8"), v2);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("concurrent writes to ONE note are serialised, not interleaved", () => {
  /** Every snapshot taken of `rel`, newest last, as bodies. */
  async function snapshotsOf(rel: string): Promise<string[]> {
    const flat = rel.split("/").join("__");
    const bodies: string[] = [];
    for (const day of await fsp.readdir(SNAPSHOTS)) {
      const dir = path.join(SNAPSHOTS, day);
      if (!(await fsp.stat(dir)).isDirectory()) continue;
      for (const name of (await fsp.readdir(dir)).sort()) {
        if (name.startsWith(`${flat}.`)) bodies.push(await fsp.readFile(path.join(dir, name), "utf8"));
      }
    }
    return bodies;
  }

  test("two PUTs on the same base: one 200, one 409, and nothing acknowledged is lost", async () => {
    // Before serialisation, 2 of 5 runs returned 200 TWICE: both requests
    // passed compare-and-swap against the same base, both snapshotted the same
    // pre-state, and the second rename destroyed content the caller had already
    // been told was saved. Five runs, because the defect was timing-selected.
    for (let run = 1; run <= 5; run++) {
      const original = `# concurrent ${run}\n\noriginal\n`;
      const note = await scratchNote(original);
      const first = `# concurrent ${run}\n\nKonrad's paragraph\n`;
      const second = `# concurrent ${run}\n\na second save, milliseconds later\n`;

      const settled = await Promise.allSettled([
        vault.writeVaultFile({ path: note.rel, content: first, baseSha256: hex(original) }),
        vault.writeVaultFile({ path: note.rel, content: second, baseSha256: hex(original) }),
      ]);
      const won = settled.filter((s) => s.status === "fulfilled");
      const lost = settled.filter((s) => s.status === "rejected");
      assert.equal(
        won.length,
        1,
        `run ${run}: exactly one write may be acknowledged, got ${won.length}`,
      );
      assert.equal(lost.length, 1);
      const conflict = lost[0].reason;
      assert.ok(
        conflict instanceof vault.VaultConflictError,
        `run ${run}: the loser must be a conflict, got ${conflict}`,
      );

      // The acknowledged bytes ARE the bytes on disk.
      const disk = await fsp.readFile(note.abs, "utf8");
      assert.equal(hex(disk), won[0].value.sha256);
      assert.ok(disk === first || disk === second);
      // The loser read the winner's bytes — proof it ran after, not beside.
      assert.equal(conflict.currentSha256, won[0].value.sha256);
      assert.equal(conflict.currentContent, disk);
      // Exactly ONE snapshot, holding the pre-state. Two snapshots of the same
      // pre-state is the signature of the interleaving this closes.
      assert.deepEqual(await snapshotsOf(note.rel), [original]);
    }
  });

  test("the queue is PER PATH: two different notes are not serialised behind each other", async () => {
    // Flip of the test above. A single global lock would also make it pass, and
    // would quietly serialise every edit in the vault behind the slowest one.
    const aOriginal = "# a\n\nv1\n";
    const bOriginal = "# b\n\nv1\n";
    const a = await scratchNote(aOriginal);
    const b = await scratchNote(bOriginal);
    const settled = await Promise.allSettled([
      vault.writeVaultFile({ path: a.rel, content: "# a\n\nv2\n", baseSha256: hex(aOriginal) }),
      vault.writeVaultFile({ path: b.rel, content: "# b\n\nv2\n", baseSha256: hex(bOriginal) }),
    ]);
    assert.deepEqual(
      settled.map((s) => s.status),
      ["fulfilled", "fulfilled"],
      "concurrent writes to DIFFERENT notes must both succeed",
    );
    assert.equal(await fsp.readFile(a.abs, "utf8"), "# a\n\nv2\n");
    assert.equal(await fsp.readFile(b.abs, "utf8"), "# b\n\nv2\n");
  });

  test("a rejected write does not wedge its path for the rest of the process", async () => {
    // A chain built with .then(work) alone continues only on success, so the
    // first 409 would leave every later edit of that note waiting forever.
    const original = "# wedge\n\nv1\n";
    const note = await scratchNote(original);
    await assert.rejects(
      () =>
        vault.writeVaultFile({
          path: note.rel,
          content: "# wedge\n\nv2\n",
          baseSha256: hex("something else entirely\n"),
        }),
      (e: unknown) => e instanceof vault.VaultConflictError,
    );
    await vault.writeVaultFile({
      path: note.rel,
      content: "# wedge\n\nv2\n",
      baseSha256: hex(original),
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# wedge\n\nv2\n");
  });

  test("the chain map is drained, not grown one entry per note edited", async () => {
    // An in-process queue that never forgets a path is a slow leak: one Map
    // entry per note ever edited, for the life of the process.
    const before = vault.pendingVaultWrites();
    assert.equal(before, 0, "nothing may still be queued when this test starts");
    const notes = await Promise.all([1, 2, 3, 4].map(() => scratchNote("# drain\n\nv1\n")));

    // Hold every write at the rename so all four are provably IN the map at
    // once. Polling for a peak would make the flip below timing-dependent.
    const realRename = fsp.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fsp.rename = (async (from: string, to: string) => {
      await gate;
      return realRename(from, to);
    }) as typeof fsp.rename;

    try {
      const inFlight = notes.map((n) =>
        vault.writeVaultFile({
          path: n.rel,
          content: "# drain\n\nv2\n",
          baseSha256: hex("# drain\n\nv1\n"),
        }),
      );
      const deadline = Date.now() + 5_000;
      while (vault.pendingVaultWrites() < notes.length) {
        assert.ok(
          Date.now() < deadline,
          `only ${vault.pendingVaultWrites()} of ${notes.length} writes reached the queue`,
        );
        await new Promise((r) => setTimeout(r, 5));
      }
      // Flip: the counter DOES move, so the assertion after the drain is
      // measuring drainage rather than a number that is always zero.
      assert.equal(vault.pendingVaultWrites(), notes.length);
      release();
      await Promise.all(inFlight);
    } finally {
      release();
      fsp.rename = realRename;
    }
    assert.equal(vault.pendingVaultWrites(), 0);
  });
});

// ---------------------------------------------------------------------------
// serialiseOnPath() carries two guards the round-6 re-review mutated one at a
// time with the suite staying 65/65 green either way. A guard whose removal
// changes nothing observable is indistinguishable from dead code, and dead code
// gets deleted — so each one gets a control that discriminates it. Measured on
// this worktree against vault.ts blob 867c135:
//
//   M1  `.then(work, work)` -> `.then(work)`                      65/65 green
//   M2  successors wait on the RAW result instead of the
//       rejection-swallowing tail; both guards left intact        65/65 green
//   M3  M2 and M1 together                                        65/65 green
//
// M1 is green because guard 1 is UNREACHABLE at tip: the Map stores `tail`,
// whose rejection handler returns undefined, so `previous` can never reject and
// the second argument of `.then(work, work)` is never called. Guard 1 is the
// second of two layers, and only the PAIR is observable.
//
// M3 stayed green for a different reason: the only wedge test in this file was
// SEQUENTIAL — it awaited the refusal before issuing the next write, by which
// time the finished chain had already cleared its own entry and the next caller
// started from `Promise.resolve()`. The wedge needs a successor queued while
// the failing writer is still in flight, which is what the first test below
// builds.
//
// So guard 1 gets two controls and needs both: a behavioural one that goes red
// under M3 (it pins the pair, since no test can pin the line alone), and a
// source assertion that goes red under M1 alone, because the named risk is a
// cleanup deleting a line nothing defends. Guard 2's control discriminates it
// on its own.
// ---------------------------------------------------------------------------

describe("the two guards inside serialiseOnPath, each with a control", () => {
  /** Park writers at the two points the queue's ordering is observable.
   *
   *  rename   — the LAST step of a write. A writer held here is provably inside
   *             its critical section, and failing its rename rejects the write
   *             without leaving the note in a different state.
   *  realpath — resolveOrRefuse()'s final await. Everything from its resolution
   *             to the Map.set inside serialiseOnPath() is synchronous or a
   *             microtask, and a write to an existing note resolves exactly two
   *             realpaths before it registers (the vault root, then the note).
   *             So "+2, then one macrotask" means REGISTERED. Waiting on a
   *             millisecond clock instead would make every control below
   *             timing-dependent, which is the thing this file refuses to be. */
  function instrument(): {
    renames: () => number;
    realpaths: () => number;
    release: (index: number, outcome?: "proceed" | "fail") => void;
    restore: () => void;
  } {
    const realRename = fsp.rename;
    const realRealpath = fsp.realpath;
    const gates = new Map<number, (fail: boolean) => void>();
    let renames = 0;
    let realpaths = 0;
    let opened = false;

    fsp.rename = (async (from: string, to: string) => {
      const index = renames++;
      if (!opened) {
        const fail = await new Promise<boolean>((resolve) => gates.set(index, resolve));
        if (fail) {
          throw Object.assign(new Error(`rename #${index} failed by the test harness`), {
            code: "EIO",
          });
        }
      }
      return realRename(from, to);
    }) as typeof fsp.rename;

    fsp.realpath = (async (target: string) => {
      const resolved = await (realRealpath as (p: string) => Promise<string>)(target);
      realpaths++;
      return resolved;
    }) as typeof fsp.realpath;

    return {
      renames: () => renames,
      realpaths: () => realpaths,
      release(index: number, outcome: "proceed" | "fail" = "proceed") {
        const gate = gates.get(index);
        assert.ok(gate, `no writer is parked at rename #${index}`);
        gates.delete(index);
        gate(outcome === "fail");
      },
      restore() {
        opened = true;
        for (const gate of gates.values()) gate(false);
        gates.clear();
        fsp.rename = realRename;
        fsp.realpath = realRealpath;
      },
    };
  }

  const macrotask = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 1);
    });

  async function waitUntil(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, `timed out after 5s waiting for ${what}`);
      await macrotask();
    }
    // One more macrotask, so every microtask the condition released has run.
    // The Map.set that follows a resolved realpath is a microtask, not a tick.
    await macrotask();
  }

  test("guard 1: a writer whose rename FAILS must not refuse the writer queued behind it", async () => {
    // The control for `.then(work, work)`. Under M3 the successor inherits the
    // predecessor's rejection, `work` is never called, and the note keeps its
    // original bytes even though the caller asked for a legitimate edit against
    // the correct base. Sequential refusal-then-retry does not reach this: the
    // finished chain has already cleared itself by then.
    const original = "# refusal\n\nv1\n";
    const saved = "# refusal\n\nv2\n";
    const note = await scratchNote(original);
    const h = instrument();
    try {
      const failing = vault.writeVaultFile({
        path: note.rel,
        content: "# refusal\n\nthe write whose rename fails\n",
        baseSha256: hex(original),
      });
      await waitUntil(() => h.renames() >= 1, "the first writer to reach its rename");

      const mark = h.realpaths();
      const behind = vault.writeVaultFile({
        path: note.rel,
        content: saved,
        baseSha256: hex(original),
      });
      // Mark it handled now: under M3 it rejects long before it is awaited, and
      // an unhandled rejection would take the whole process down mid-test.
      void behind.catch(() => undefined);
      await waitUntil(
        () => h.realpaths() >= mark + 2,
        "the second writer to register in the queue",
      );
      assert.equal(
        h.renames(),
        1,
        "the second writer must be QUEUED, not running beside the first",
      );

      h.release(0, "fail");
      await assert.rejects(failing, /rename #0 failed by the test harness/);
      // The failed write left the note exactly as it was — nothing to recover.
      assert.equal(await fsp.readFile(note.abs, "utf8"), original);

      // THE DISCRIMINATOR. A chain that only continues on success never calls
      // this writer's work at all, so it never reaches a rename and this times
      // out with `behind` already rejected carrying the FIRST writer's error.
      await waitUntil(
        () => h.renames() >= 2,
        "the queued writer to run after its predecessor was refused",
      );
      h.release(1);
      const result = await behind;
      assert.equal(await fsp.readFile(note.abs, "utf8"), saved);
      assert.equal(result.sha256, hex(saved));
    } finally {
      h.restore();
    }
  });

  test("guard 1 is pinned in the source, because no test can pin the line alone", () => {
    // Not a behavioural assertion and not pretending to be one. The measured
    // risk is a cleanup deleting a redundant-looking line; this is the tripwire
    // for that, and the test above is the proof that the redundancy is the only
    // reason deleting it is currently free.
    const call = /\.then\(\s*work\s*,\s*work\s*\)/g;
    const inCode = [...CODE.matchAll(call)].length;
    assert.equal(
      inCode,
      1,
      "serialiseOnPath() must continue its chain on rejection: `previous.then(work, work)`. " +
        "With `.then(work)` a refused write in flight refuses every writer queued behind it.",
    );
    // Canary: the module DISCUSSES this call by name in a comment, so the same
    // grep over SOURCE passes with the call itself deleted. If these two ever
    // read the same, the assertion above has stopped measuring code.
    const inSource = [...SOURCE.matchAll(call)].length;
    assert.ok(
      inSource > inCode,
      `the comment occurrence is missing from SOURCE (${inSource}) — this assertion ` +
        "no longer proves it is measuring code rather than prose",
    );
  });

  test("guard 2: a finishing writer must not clear a LATER writer's chain entry", async () => {
    const original = "# tail\n\nv1\n";
    const first = "# tail\n\nfirst\n";
    const note = await scratchNote(original);
    assert.equal(vault.pendingVaultWrites(), 0, "nothing may still be queued when this test starts");
    const h = instrument();
    try {
      const a = vault.writeVaultFile({ path: note.rel, content: first, baseSha256: hex(original) });
      await waitUntil(() => h.renames() >= 1, "writer A to reach its rename");

      const mark = h.realpaths();
      const b = vault.writeVaultFile({
        path: note.rel,
        content: "# tail\n\nsecond\n",
        baseSha256: hex(first),
      });
      void b.catch(() => undefined);
      await waitUntil(() => h.realpaths() >= mark + 2, "writer B to register behind A");
      // Flip: there IS an entry, so the assertion below is measuring a deletion
      // rather than a counter that reads zero whatever happens.
      assert.equal(vault.pendingVaultWrites(), 1);

      h.release(0);
      await a;
      await waitUntil(() => h.renames() >= 2, "writer B to reach its own rename");
      // THE DISCRIMINATOR: A has settled and run its cleanup. Without
      // `writeChains.get(abs) === tail` that cleanup deletes the entry B is
      // queued under, and this reads 0 — a note with a write in flight that the
      // next caller will not be ordered behind.
      assert.equal(
        vault.pendingVaultWrites(),
        1,
        "the finishing writer deleted the chain entry of a writer still in flight",
      );
      h.release(1);
      await b;
    } finally {
      h.restore();
    }
    assert.equal(vault.pendingVaultWrites(), 0, "the chain must still drain once everything settles");
  });

  test("guard 2: without it a new writer races the queued one and an acknowledged edit is lost", async () => {
    // Why the entry above is load-bearing rather than tidy. Once A's cleanup has
    // emptied the Map, the next caller finds no chain, runs BESIDE the writer
    // still in flight, passes compare-and-swap on the same base — and blocker 1
    // is back, with two 200s and one surviving body.
    const original = "# race\n\nv1\n";
    const landed = "# race\n\nlanded\n";
    const fromB = "# race\n\nB\n";
    const note = await scratchNote(original);
    const h = instrument();
    try {
      const a = vault.writeVaultFile({ path: note.rel, content: landed, baseSha256: hex(original) });
      await waitUntil(() => h.renames() >= 1, "writer A to reach its rename");

      let mark = h.realpaths();
      const b = vault.writeVaultFile({ path: note.rel, content: fromB, baseSha256: hex(landed) });
      void b.catch(() => undefined);
      await waitUntil(() => h.realpaths() >= mark + 2, "writer B to register behind A");

      h.release(0);
      await a;
      // B has now read `landed`, compared, snapshotted, and is parked at its
      // rename — so the bytes on disk are still the base D is about to quote.
      await waitUntil(() => h.renames() >= 2, "writer B to reach its rename");
      assert.equal(await fsp.readFile(note.abs, "utf8"), landed);

      mark = h.realpaths();
      const d = vault.writeVaultFile({ path: note.rel, content: "# race\n\nD\n", baseSha256: hex(landed) });
      void d.catch(() => undefined);
      await waitUntil(() => h.realpaths() >= mark + 2, "writer D to register");

      h.restore(); // opens every gate, parked and future
      const settled = await Promise.allSettled([b, d]);
      const acknowledged = settled.filter((s) => s.status === "fulfilled");
      assert.equal(
        acknowledged.length,
        1,
        `two writers quoted base ${hex(landed).slice(0, 12)}…; exactly one may be ` +
          `acknowledged, got ${acknowledged.length}`,
      );
      assert.equal(settled[0].status, "fulfilled", "B was first in the queue and must win");
      const loser = settled[1];
      assert.ok(
        loser.status === "rejected" && loser.reason instanceof vault.VaultConflictError,
        `D must be refused with a conflict, got ${loser.status === "rejected" ? loser.reason : "a 200"}`,
      );
      const disk = await fsp.readFile(note.abs, "utf8");
      assert.equal(disk, fromB);
      assert.equal(
        hex(disk),
        (acknowledged[0] as PromiseFulfilledResult<{ sha256: string }>).value.sha256,
        "the acknowledged bytes are not the bytes on disk",
      );
    } finally {
      h.restore();
    }
  });
});

describe("a symlink inside the vault does not escape it (R9)", () => {
  // path.resolve() is lexical. Before the realpath check, GET through a file
  // symlink returned any file the root process could open, and PUT through a
  // directory symlink overwrote a file outside the vault. Both measured at 200.
  let outsideDir: string;
  let outsideNote: string;
  const OUTSIDE_BODY = "TOP SECRET, outside the vault\n";

  before(async () => {
    outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-vault-outside-"));
    outsideNote = path.join(outsideDir, "secret.md");
    await fsp.writeFile(outsideNote, OUTSIDE_BODY, "utf8");
    await fsp.symlink(outsideNote, abs("Notes/leak.md"));
    await fsp.symlink(outsideDir, abs("escape"));
    await fsp.symlink(abs("Notes/with spaces & sym.md"), abs("Notes/inside-link.md"));
  });

  test("GET through a file symlink pointing outside is refused", async () => {
    await assert.rejects(
      () => vault.readVaultFile("Notes/leak.md"),
      (e: unknown) => isRefused(e) && /escapes the vault through a symlink/.test(e.reason),
    );
  });

  test("PUT through a directory symlink is refused and the outside file is untouched", async () => {
    await assert.rejects(
      () =>
        vault.writeVaultFile({
          path: "escape/secret.md",
          content: "OVERWRITTEN FROM INSIDE THE VAULT\n",
          baseSha256: hex(OUTSIDE_BODY),
        }),
      (e: unknown) => isRefused(e) && /escapes the vault through a symlink/.test(e.reason),
    );
    assert.equal(await fsp.readFile(outsideNote, "utf8"), OUTSIDE_BODY);
  });

  test("PUT to a not-yet-existing path THROUGH a directory symlink is refused too", async () => {
    // The deepest-existing-ancestor walk is what makes this reachable: the file
    // does not exist, so only its parent can be resolved.
    await assert.rejects(
      () =>
        vault.writeVaultFile({
          path: "escape/brand-new.md",
          content: "x\n",
          baseSha256: hex("x\n"),
        }),
      (e: unknown) => isRefused(e) && /escapes the vault through a symlink/.test(e.reason),
    );
    await assert.rejects(
      () => fsp.access(path.join(outsideDir, "brand-new.md")),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
  });

  test("flip: a symlink to another note INSIDE the vault still resolves", async () => {
    // The guard is containment, not "no symlinks" — refusing every symlink
    // would pass the three tests above while breaking legitimate vault layouts.
    const read = await vault.readVaultFile("Notes/inside-link.md");
    assert.equal(read.content, FIXTURE_NOTES["Notes/with spaces & sym.md"]);
  });

  test("flip: a real note that does not exist yet still reports ENOENT, not a refusal", async () => {
    await assert.rejects(
      () => vault.readVaultFile("Notes/no-such-note.md"),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});

describe("an invisible body is refused like the blank note it renders as (R7)", () => {
  const INVISIBLE: Array<[string, string]> = [
    ["U+200B zero-width space", "\u200B"],
    ["U+200C zero-width non-joiner", "\u200C"],
    ["U+200D zero-width joiner", "\u200D"],
    ["U+2060 word joiner", "\u2060"],
    ["U+FEFF byte-order mark", "\uFEFF"],
    ["zero-width mixed with real whitespace", " \u200B\n\t\u2060 "],
  ];

  for (const [name, body] of INVISIBLE) {
    test(`${name} only is refused`, async () => {
      const original = "# invisible\n\nreal content\n";
      const note = await scratchNote(original);
      await assert.rejects(
        () => vault.writeVaultFile({ path: note.rel, content: body, baseSha256: hex(original) }),
        (e: unknown) => isRefused(e) && /empty content refused/.test(e.reason),
      );
      assert.equal(await fsp.readFile(note.abs, "utf8"), original);
    });
  }

  test("flip: a zero-width character INSIDE real prose is content and is written verbatim", async () => {
    // The strip happens on a COPY, for the blank test only. Stripping the body
    // itself would silently rewrite Konrad's bytes and break the sha256 he is
    // handed back.
    const original = "# invisible\n\nv1\n";
    const note = await scratchNote(original);
    const body = "# invisible\n\nZWJ here \u200D and the note is not blank\n";
    const result = await vault.writeVaultFile({
      path: note.rel,
      content: body,
      baseSha256: hex(original),
    });
    assert.equal(await fsp.readFile(note.abs, "utf8"), body);
    assert.equal(result.sha256, hex(body));
    assert.ok(body.includes("\u200D"), "the fixture must carry a zero-width char or this proves nothing");
  });

  test("the refusal names which kind of blank it was", async () => {
    const original = "# kinds\n\nv1\n";
    const note = await scratchNote(original);
    const cases: Array<[string, RegExp]> = [
      ["", /zero-length/],
      ["   \n", /whitespace-only/],
      ["\u200B\u200B", /zero-width-only/],
    ];
    for (const [body, expected] of cases) {
      await assert.rejects(
        () => vault.writeVaultFile({ path: note.rel, content: body, baseSha256: hex(original) }),
        (e: unknown) => isRefused(e) && expected.test(e.reason),
        `expected ${expected} for ${JSON.stringify(body)}`,
      );
    }
  });
});

describe("orphaned temp files are swept, and only those", () => {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

  test("an hour-old orphan goes; a fresh one, a note and a look-alike stay", async () => {
    const original = "# sweep\n\nv1\n";
    const note = await scratchNote(original);
    const dir = path.dirname(note.abs);

    const stale = path.join(dir, "crashed.md.tmp-1328992-2b5ef015ac5f");
    const fresh = path.join(dir, "in-flight.md.tmp-1328993-2b5ef015ac5f");
    const lookalike = path.join(dir, "not-ours.md.tmp-nopid-xyz");
    const realNote = path.join(dir, "sweep-bystander.md");
    for (const p of [stale, fresh, lookalike, realNote]) {
      await fsp.writeFile(p, "60 MB of nothing, morally\n", "utf8");
    }
    await fsp.utimes(stale, TWO_HOURS_AGO, TWO_HOURS_AGO);
    // The bystander note is old too: age alone must not be enough to delete it.
    await fsp.utimes(realNote, TWO_HOURS_AGO, TWO_HOURS_AGO);
    await fsp.utimes(lookalike, TWO_HOURS_AGO, TWO_HOURS_AGO);

    await vault.writeVaultFile({
      path: note.rel,
      content: "# sweep\n\nv2\n",
      baseSha256: hex(original),
    });

    const survives = async (p: string): Promise<boolean> => {
      try {
        await fsp.access(p);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    };
    assert.equal(await survives(stale), false, "an hour-old orphan must be swept");
    assert.equal(await survives(fresh), true, "a temp file another process may still be writing must survive");
    assert.equal(await survives(lookalike), true, "only this module's own name shape may be swept");
    assert.equal(await survives(realNote), true, "A NOTE MUST NEVER BE SWEPT");
    assert.equal(await fsp.readFile(note.abs, "utf8"), "# sweep\n\nv2\n");
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

  // -------------------------------------------------------------------------
  // The two loss paths R1-red demonstrated in this verb. Both are behavioural
  // changes to a verb R11 freezes, ruled on by the operator on 2026-08-19 and
  // recorded in 04-phases.md §10: R11 protects append-or-create SEMANTICS, and
  // replacing a note with an empty template is the opposite of appending.
  // They run last, on the note the characterisation tests above built.
  // -------------------------------------------------------------------------

  test("a read failure that is not ENOENT THROWS; the note is byte-identical", async () => {
    // Measured before this guard: a simulated EIO took the daily note from
    // 4 245 bytes to 76 — the empty template, written over it — and resolved
    // {ok:true, created:true}. No snapshot; unrecoverable.
    const before3 = await fsp.readFile(dailyAbs, "utf8");
    assert.ok(before3.length > 0, "this test needs an existing daily note to destroy");

    const realRead = fsp.readFile;
    for (const code of ["EIO", "EACCES", "ENOMEM", "ERR_FS_FILE_TOO_LARGE"]) {
      // Patch the SHARED node:fs promises object, the same technique the
      // rename test above uses, and scope it to the daily note's own path.
      fsp.readFile = (async (p: unknown, ...rest: unknown[]) => {
        if (String(p) === dailyAbs) {
          const err: NodeJS.ErrnoException = new Error(`${code}: simulated read failure`);
          err.code = code;
          throw err;
        }
        return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fsp.readFile;
      try {
        await assert.rejects(
          () => vault.appendToDailyNote({ section: "Notes", text: "a captured thought" }),
          (e: unknown) => (e as NodeJS.ErrnoException).code === code,
          `a ${code} read failure must reach the caller, not be read as "no note today"`,
        );
      } finally {
        fsp.readFile = realRead;
      }
      assert.equal(await fsp.readFile(dailyAbs, "utf8"), before3);
    }

    // Flip: ENOENT — and ONLY ENOENT — still means "today's note does not
    // exist yet", so the create-from-template branch is still reachable.
    const stashed3 = `${dailyAbs}.enoent-flip`;
    await fsp.rename(dailyAbs, stashed3);
    try {
      const result = await vault.appendToDailyNote({ section: "Tasks", text: "created again" });
      assert.deepEqual(result, { path: dailyRel, created: true });
      assert.match(await fsp.readFile(dailyAbs, "utf8"), /^# \d{4}-\d{2}-\d{2}\n/);
    } finally {
      await fsp.rename(stashed3, dailyAbs);
    }
    assert.equal(await fsp.readFile(dailyAbs, "utf8"), before3);
  });

  test("readDailyNote reports content: null ONLY for ENOENT", async () => {
    const realRead = fsp.readFile;
    fsp.readFile = (async (p: unknown, ...rest: unknown[]) => {
      if (String(p) === dailyAbs) {
        const err: NodeJS.ErrnoException = new Error("EIO: simulated read failure");
        err.code = "EIO";
        throw err;
      }
      return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof fsp.readFile;
    try {
      await assert.rejects(
        () => vault.readDailyNote(),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "EIO",
        'a transient EIO must not render as "no daily note today" in the Capture preview',
      );
    } finally {
      fsp.readFile = realRead;
    }
    // Flip: the real read still returns the note.
    const read = await vault.readDailyNote();
    assert.equal(read.path, dailyRel);
    assert.equal(read.content, await fsp.readFile(dailyAbs, "utf8"));
  });

  test("the append is atomic: a failed rename leaves the note byte-identical", async () => {
    // Before this, the append was `fs.writeFile(abs, next, "utf8")` — O_TRUNC
    // on the destination. Measured: 40 000 048 bytes observed at 0 on disk
    // mid-call, with no snapshot and no temp file to recover from. Forcing the
    // rename to fail is the deterministic form of the same proof: if the write
    // still reached the destination directly, the note would have CHANGED here.
    const before4 = await fsp.readFile(dailyAbs, "utf8");
    const realRename = fsp.rename;
    fsp.rename = async (): Promise<void> => {
      const err: NodeJS.ErrnoException = new Error("EXDEV: simulated cross-device rename");
      err.code = "EXDEV";
      throw err;
    };
    try {
      await assert.rejects(
        () => vault.appendToDailyNote({ section: "Journal", text: "never lands" }),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "EXDEV",
      );
    } finally {
      fsp.rename = realRename;
    }
    assert.equal(await fsp.readFile(dailyAbs, "utf8"), before4);
    const leftovers = (await fsp.readdir(path.dirname(dailyAbs))).filter((f) =>
      f.includes(".tmp-"),
    );
    assert.deepEqual(leftovers, [], "the temp file must be cleaned up on failure");

    // Flip: with rename restored, the identical append lands and the note grows
    // by exactly the one line — the bytes are unchanged by the atomicity fix,
    // which is what keeps R11's characterisation above passing.
    const result = await vault.appendToDailyNote({ section: "Journal", text: "never lands" });
    assert.deepEqual(result, { path: dailyRel, created: false });
    const after4 = await fsp.readFile(dailyAbs, "utf8");
    assert.notEqual(after4, before4);
    assert.equal(
      after4.split("\n").length,
      before4.split("\n").length + 1,
      "an append adds exactly one line",
    );
    assert.ok(after4.includes(before4.replace(/\n## Journal\n$/, "")));
  });
});

// ---------------------------------------------------------------------------
// appendToDailyNote is read-modify-write, so it needs the same per-path queue
// writeVaultFile got. It was left out of the first pass: measured on one daily
// note, 10 concurrent calls returned 10 × {ok:true} and left ONE line on disk,
// with no snapshot — this verb takes none, correctly, because it replaces
// nothing, which is exactly why a lost append is unrecoverable.
// ---------------------------------------------------------------------------

describe("concurrent appendToDailyNote: every acknowledged capture survives", () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dailyRel = `Daily/${today}.md`;
  const dailyAbs = abs(dailyRel);
  const stash = `${dailyAbs}.append-race-stash`;
  let stashed = false;

  before(async () => {
    try {
      await fsp.rename(dailyAbs, stash);
      stashed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  });

  after(async () => {
    await fsp.rm(dailyAbs, { force: true });
    if (stashed) await fsp.rename(stash, dailyAbs);
  });

  test("10 concurrent captures → 10 acknowledgements AND 10 lines on disk", async () => {
    // Seed the note so this test drives the read-existing branch; the create
    // branch has its own test below.
    await vault.appendToDailyNote({ section: "Notes", text: "seed" });
    const before5 = await fsp.readFile(dailyAbs, "utf8");
    const texts = Array.from({ length: 10 }, (_, i) => `concurrent capture ${i}`);

    const settled = await Promise.allSettled(
      texts.map((text) => vault.appendToDailyNote({ section: "Notes", text })),
    );
    const acknowledged = settled.filter((s) => s.status === "fulfilled");
    assert.equal(
      acknowledged.length,
      texts.length,
      `every capture must be acknowledged; rejections: ${settled
        .filter((s) => s.status === "rejected")
        .map((s) => String((s as PromiseRejectedResult).reason))
        .join(" | ")}`,
    );

    // The assertion that fails without the queue. Pre-fix this read 1.
    const after5 = await fsp.readFile(dailyAbs, "utf8");
    for (const text of texts) {
      const hits = after5.split("\n").filter((l) => l.endsWith(`— ${text}`)).length;
      assert.equal(hits, 1, `"${text}" was acknowledged but is on disk ${hits} times`);
    }
    assert.equal(
      after5.split("\n").length,
      before5.split("\n").length + texts.length,
      "the note must grow by exactly one line per acknowledged capture",
    );
    // The note the captures were spliced into is still underneath them.
    assert.ok(after5.includes("— seed"), "the pre-existing content was replaced");
    // Not one of them reported creating the note: they all read what was there.
    assert.deepEqual(
      acknowledged.map((s) => s.value.created),
      texts.map(() => false),
    );
  });

  test("the create branch is entered ONCE, not once per concurrent caller", async () => {
    // Flip of the test above, on the other side of the ENOENT boundary. Without
    // the queue all five callers found no note, all five built the template from
    // scratch, and all five returned created:true — five "first capture of the
    // day" acknowledgements for one surviving line.
    await fsp.rm(dailyAbs, { force: true });
    const texts = Array.from({ length: 5 }, (_, i) => `first of the day ${i}`);
    const results = await Promise.all(
      texts.map((text) => vault.appendToDailyNote({ section: "Tasks", text })),
    );
    assert.equal(
      results.filter((r) => r.created).length,
      1,
      "exactly one concurrent caller may create today's note",
    );
    const content = await fsp.readFile(dailyAbs, "utf8");
    for (const text of texts) {
      assert.equal(
        content.split("\n").filter((l) => l.endsWith(`— ${text}`)).length,
        1,
        `"${text}" is missing from a note five callers were told they had written`,
      );
    }
  });

  test("an append racing an EDIT of the same note shares one queue", async () => {
    // Both verbs key on the same resolved path, so writeVaultFile cannot land
    // between this verb's read and its rename either. Whichever runs first, the
    // append's line is on disk afterwards and nothing unacknowledged is.
    await fsp.rm(dailyAbs, { force: true });
    await vault.appendToDailyNote({ section: "Notes", text: "before the race" });
    const original = await fsp.readFile(dailyAbs, "utf8");
    const edited = `# ${today}\n\n## Notes\nKonrad rewrote the whole note\n`;

    const [editOutcome, appendOutcome] = await Promise.allSettled([
      vault.writeVaultFile({ path: dailyRel, content: edited, baseSha256: hex(original) }),
      vault.appendToDailyNote({ section: "Notes", text: "captured mid-edit" }),
    ]);

    const disk = await fsp.readFile(dailyAbs, "utf8");
    assert.equal(appendOutcome.status, "fulfilled");
    assert.ok(
      disk.split("\n").some((l) => l.endsWith("— captured mid-edit")),
      `the acknowledged capture is not on disk:\n${disk}`,
    );

    if (editOutcome.status === "fulfilled") {
      // The edit ran first; the append then read the edited bytes.
      assert.ok(
        disk.includes("Konrad rewrote the whole note"),
        "the edit was acknowledged but its bytes are gone",
      );
      assert.ok(!disk.includes("— before the race"), "the edit replaced that line");
    } else {
      // The append ran first, so the edit's compare-and-swap found the appended
      // bytes and refused rather than overwriting them.
      assert.ok(
        editOutcome.reason instanceof vault.VaultConflictError,
        `the loser must be a conflict, got ${editOutcome.reason}`,
      );
      assert.ok(!disk.includes("Konrad rewrote the whole note"));
      assert.ok(disk.includes("— before the race"));
    }
  });

  test("the queue drains after a burst of appends", async () => {
    // A per-path Map that is never cleaned is one entry per note for the life
    // of the process; the edit verb has this test, and the append verb now
    // writes into the same Map.
    await Promise.all(
      [1, 2, 3].map((i) => vault.appendToDailyNote({ section: "Journal", text: `drain ${i}` })),
    );
    assert.equal(vault.pendingVaultWrites(), 0);
  });
});
