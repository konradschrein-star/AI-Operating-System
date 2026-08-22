/**
 * Tests for lib/secret-store.ts — encrypted-at-rest secrets, sidecar
 * metadata, audit log, rotation and deletion (aios-settings-and-secrets).
 *
 * Run: pnpm test   (tsx --test src/lib/*.test.ts)
 *
 * NOTHING here touches the real store. SECRET_STORE_DIR, SECRET_MASTER_KEY_PATH
 * and SECRET_AUDIT_LOG_PATH are pointed at a fresh os.tmpdir() BEFORE
 * ./secret-store.ts is imported, because that module reads all three env vars
 * at module load (same pattern as vault.test.ts / OBSIDIAN_VAULT_DIR).
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = await mkdtemp(join(tmpdir(), "forge-secret-store-"));
const STORE_DIR = join(ROOT, "store");
const MASTER_KEY_PATH = join(ROOT, ".master.key");
const AUDIT_LOG_PATH = join(ROOT, "audit.log");

process.env.SECRET_STORE_DIR = STORE_DIR;
process.env.SECRET_MASTER_KEY_PATH = MASTER_KEY_PATH;
process.env.SECRET_AUDIT_LOG_PATH = AUDIT_LOG_PATH;

const {
  putSecret,
  rotateSecret,
  getSecret,
  revealSecret,
  listSecrets,
  deleteSecret,
  markPending,
  isValidName,
  normalizeName,
} = await import("./secret-store.ts");

/** Every audit line as a parsed object, oldest first. */
async function readAudit(): Promise<any[]> {
  const raw = await readFile(AUDIT_LOG_PATH, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Fresh store dir + audit log per test, so tests don't see each other's
 *  secrets. The master key is deliberately NOT reset — regenerating it mid
 *  suite would make every ciphertext written before the reset undecryptable,
 *  which is exactly the scenario the "tampered ciphertext" test wants to
 *  provoke on purpose, not by accident between unrelated tests. */
beforeEach(async () => {
  await rm(STORE_DIR, { recursive: true, force: true });
  await rm(AUDIT_LOG_PATH, { force: true });
});

describe("isValidName / normalizeName", () => {
  test("rejects uppercase, accepts normalized lowercase", () => {
    assert.equal(isValidName("GitHub"), false);
    assert.equal(isValidName("github-pat"), true);
    assert.equal(normalizeName("GitHub PAT"), "github-pat");
    assert.equal(normalizeName("  Twenty CRM  "), "twenty-crm");
  });
});

describe("encryption round-trip", () => {
  test("putSecret then getSecret returns the original value", async () => {
    await putSecret("round-trip", "sk-super-secret-value");
    assert.equal(await getSecret("round-trip"), "sk-super-secret-value");
  });

  test("the value on disk is ciphertext, not the plaintext", async () => {
    await putSecret("on-disk", "sk-do-not-leak-this");
    const raw = await readFile(join(STORE_DIR, "on-disk"), "utf8");
    assert.ok(raw.startsWith("enc:v1:"));
    assert.ok(!raw.includes("sk-do-not-leak-this"));
  });

  test("two secrets with the same value encrypt to different ciphertext", async () => {
    await putSecret("dup-a", "identical-value");
    await putSecret("dup-b", "identical-value");
    const a = await readFile(join(STORE_DIR, "dup-a"), "utf8");
    const b = await readFile(join(STORE_DIR, "dup-b"), "utf8");
    // Fresh random IV per write, so ciphertext must differ even for equal
    // plaintext — otherwise the IV isn't actually being randomized.
    assert.notEqual(a, b);
  });
});

describe("transparent legacy plaintext reading", () => {
  test("getSecret reads a pre-existing plaintext file with no enc: prefix", async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(join(STORE_DIR, "legacy-key"), "old-plaintext-value", {
      mode: 0o600,
    });
    assert.equal(await getSecret("legacy-key"), "old-plaintext-value");
  });

  test("putSecret over a legacy plaintext file re-encrypts it", async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(join(STORE_DIR, "legacy-rotate"), "old-plaintext-value", {
      mode: 0o600,
    });
    await putSecret("legacy-rotate", "new-value-goes-in-encrypted");
    const raw = await readFile(join(STORE_DIR, "legacy-rotate"), "utf8");
    assert.ok(raw.startsWith("enc:v1:"));
    assert.equal(await getSecret("legacy-rotate"), "new-value-goes-in-encrypted");
  });

  test("legacy note/pending/requested-by sidecars are read as metadata fallback", async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(join(STORE_DIR, "legacy-meta"), "plain-value", { mode: 0o600 });
    await writeFile(join(STORE_DIR, "legacy-meta.note"), "an old note", { mode: 0o600 });
    await writeFile(join(STORE_DIR, "legacy-meta.pending"), "", { mode: 0o600 });
    await writeFile(join(STORE_DIR, "legacy-meta.requested-by"), "agent-1", {
      mode: 0o600,
    });
    const list = await listSecrets();
    const found = list.find((s) => s.name === "legacy-meta");
    assert.ok(found);
    assert.equal(found!.note, "an old note");
    assert.equal(found!.pending, true);
    assert.equal(found!.requestedByRunId, "agent-1");
    // And the fields this task adds default sanely for a pre-existing secret.
    assert.equal(found!.accessCount, 0);
    assert.equal(found!.lastUsedAt, null);
    assert.equal(found!.serviceTag, null);
  });
});

describe("tampered ciphertext detection", () => {
  test("getSecret throws on a flipped auth tag instead of returning garbage or null", async () => {
    await putSecret("tamper-me", "value-that-must-stay-intact");
    const raw = await readFile(join(STORE_DIR, "tamper-me"), "utf8");
    const parts = raw.split(":"); // enc:v1:iv:tag:ciphertext
    // Flip one hex character in the auth tag.
    const tag = parts[3];
    const flippedChar = tag[0] === "0" ? "1" : "0";
    parts[3] = flippedChar + tag.slice(1);
    await writeFile(join(STORE_DIR, "tamper-me"), parts.join(":"), { mode: 0o600 });
    await assert.rejects(() => getSecret("tamper-me"));
  });

  test("a malformed enc: payload throws rather than decrypting to nonsense", async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(join(STORE_DIR, "malformed"), "enc:v1:not-enough-parts", {
      mode: 0o600,
    });
    await assert.rejects(() => getSecret("malformed"));
  });

  test("revealSecret also throws (after logging a failed audit entry) on tamper", async () => {
    await putSecret("tamper-reveal", "another-value");
    const raw = await readFile(join(STORE_DIR, "tamper-reveal"), "utf8");
    const parts = raw.split(":");
    const ct = parts[4];
    parts[4] = (ct[0] === "0" ? "1" : "0") + ct.slice(1);
    await writeFile(join(STORE_DIR, "tamper-reveal"), parts.join(":"), {
      mode: 0o600,
    });
    await assert.rejects(() => revealSecret("tamper-reveal"));
    const audit = await readAudit();
    const last = audit[audit.length - 1];
    assert.equal(last.action, "reveal");
    assert.equal(last.name, "tamper-reveal");
    assert.equal(last.ok, false);
  });
});

describe("metadata persistence", () => {
  test("listSecrets never includes a value field", async () => {
    await putSecret("no-leak", "value-must-not-appear-in-listing");
    const list = await listSecrets();
    for (const s of list) {
      assert.equal((s as any).value, undefined);
    }
    assert.equal(JSON.stringify(list).includes("value-must-not-appear"), false);
  });

  test("service tag and note persist and round-trip through listSecrets", async () => {
    const meta = await putSecret("tagged", "a-value", {
      note: "for the thing",
      serviceTag: "github",
    });
    assert.equal(meta.serviceTag, "github");
    assert.equal(meta.note, "for the thing");
    const list = await listSecrets();
    const found = list.find((s) => s.name === "tagged");
    assert.equal(found?.serviceTag, "github");
    assert.equal(found?.note, "for the thing");
    assert.equal(found?.accessCount, 0);
    assert.ok(found?.createdAt);
    assert.ok(found?.updatedAt);
  });

  test("createdAt is stable across an update; updatedAt moves", async () => {
    const first = await putSecret("stable-created", "v1");
    await new Promise((r) => setTimeout(r, 5));
    const second = await putSecret("stable-created", "v2", { serviceTag: "x" });
    assert.equal(second.createdAt, first.createdAt);
    assert.notEqual(second.updatedAt, first.updatedAt);
  });

  test("pending flag: markPending, then reveal clears it and bumps accessCount", async () => {
    await putSecret("pending-me", "a-secret-value");
    const marked = await markPending("pending-me", undefined);
    assert.equal(marked, true);
    let list = await listSecrets();
    assert.equal(list.find((s) => s.name === "pending-me")?.pending, true);

    const revealed = await revealSecret("pending-me");
    assert.equal(revealed?.value, "a-secret-value");

    list = await listSecrets();
    const found = list.find((s) => s.name === "pending-me");
    assert.equal(found?.pending, false);
    assert.equal(found?.accessCount, 1);
    assert.ok(found?.lastUsedAt);
  });

  test("getSecret does NOT bump accessCount or lastUsedAt (quiet internal read)", async () => {
    await putSecret("quiet-read", "value");
    await getSecret("quiet-read");
    await getSecret("quiet-read");
    const list = await listSecrets();
    const found = list.find((s) => s.name === "quiet-read");
    assert.equal(found?.accessCount, 0);
    assert.equal(found?.lastUsedAt, null);
  });
});

describe("audit log", () => {
  test("putSecret appends a store entry, never the value", async () => {
    await putSecret("audited", "the-actual-secret-value", { serviceTag: "stripe" });
    const audit = await readAudit();
    const entry = audit.find((e) => e.name === "audited" && e.action === "store");
    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.serviceTag, "stripe");
    assert.equal(JSON.stringify(audit).includes("the-actual-secret-value"), false);
  });

  test("revealSecret appends a reveal entry", async () => {
    await putSecret("audited-reveal", "value");
    await revealSecret("audited-reveal", { runId: "11111111-1111-1111-1111-111111111111" });
    const audit = await readAudit();
    const entry = audit.find((e) => e.action === "reveal" && e.name === "audited-reveal");
    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.runId, "11111111-1111-1111-1111-111111111111");
  });

  test("deleteSecret appends a delete entry", async () => {
    await putSecret("audited-delete", "value");
    await deleteSecret("audited-delete");
    const audit = await readAudit();
    const entry = audit.find((e) => e.action === "delete" && e.name === "audited-delete");
    assert.ok(entry);
    assert.equal(entry.ok, true);
  });

  test("audit log file is mode 0600", async () => {
    await putSecret("perm-check", "value");
    const s = await stat(AUDIT_LOG_PATH);
    assert.equal((s.mode & 0o777).toString(8), "600");
  });
});

describe("rotation", () => {
  test("rotateSecret replaces the value and appends a rotate audit entry", async () => {
    await putSecret("to-rotate", "old-value", { serviceTag: "gemini" });
    const rotated = await rotateSecret("to-rotate", "new-value");
    assert.equal(rotated.serviceTag, "gemini"); // untouched when not supplied
    assert.equal(await getSecret("to-rotate"), "new-value");

    const audit = await readAudit();
    const entry = audit.find((e) => e.action === "rotate" && e.name === "to-rotate");
    assert.ok(entry);
    assert.equal(entry.ok, true);
  });

  test("rotateSecret can update the service tag and note", async () => {
    await putSecret("to-retag", "v1", { serviceTag: "old-tag" });
    const rotated = await rotateSecret("to-retag", "v2", {
      serviceTag: "new-tag",
      note: "rotated for a good reason",
    });
    assert.equal(rotated.serviceTag, "new-tag");
    assert.equal(rotated.note, "rotated for a good reason");
  });

  test("rotateSecret on a name that was never stored throws and logs a failed audit entry", async () => {
    await assert.rejects(() => rotateSecret("never-existed", "value"));
    const audit = await readAudit();
    const entry = audit.find((e) => e.action === "rotate" && e.name === "never-existed");
    assert.ok(entry);
    assert.equal(entry.ok, false);
  });
});

describe("deletion", () => {
  test("deleteSecret removes the value and it is no longer readable", async () => {
    await putSecret("to-delete", "value");
    const ok = await deleteSecret("to-delete");
    assert.equal(ok, true);
    assert.equal(await getSecret("to-delete"), null);
    const list = await listSecrets();
    assert.equal(list.some((s) => s.name === "to-delete"), false);
  });

  test("deleteSecret on a name that never existed returns false, no audit entry", async () => {
    const ok = await deleteSecret("ghost");
    assert.equal(ok, false);
    const audit = await readAudit();
    assert.equal(audit.some((e) => e.name === "ghost"), false);
  });

  test("deleted value file does not linger with recoverable ciphertext on disk", async () => {
    await putSecret("secure-wipe", "sensitive-value-to-shred");
    const before = await readFile(join(STORE_DIR, "secure-wipe"), "utf8");
    assert.ok(before.length > 0);
    await deleteSecret("secure-wipe");
    await assert.rejects(() => readFile(join(STORE_DIR, "secure-wipe"), "utf8"));
  });
});

describe("SecretMeta.name is the source of truth for callers passed as a bare function", () => {
  test("readSecret: getSecret (cron-tick's usage) works as a plain callback", async () => {
    await putSecret("cron-style", "value-for-cron");
    const readSecret: (name: string) => Promise<string | null> = getSecret;
    assert.equal(await readSecret("cron-style"), "value-for-cron");
  });
});
