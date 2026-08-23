/**
 * Secret store — a way to hand the agent a credential without writing it into
 * the chat, and a way for the agent to hand a credential back to Konrad
 * without writing it into the chat either.
 *
 * The original problem: runs.thread is plain JSONB in postgres, replayed into
 * the model's context every turn and captured in nightly backups. A password
 * pasted into a message therefore lives in all three forever. Konrad was one
 * keystroke from pasting an SSH private key into a thread when he stopped and
 * asked for this instead.
 *
 * The reverse problem (2026-08-04): the operator provisioned an admin password
 * for the Twenty CRM and stored it here under `twenty-crm-admin`, then had no
 * way to give it back to Konrad — chat has the same replay/backup issue, and
 * the API deliberately had no read endpoint. So Konrad couldn't log into his
 * own CRM. The route now exposes a reveal endpoint (POST /:name/reveal) that
 * is distinct from list, so listing can never accidentally leak values, and a
 * `pending` marker so a freshly-handed-over credential surfaces prominently
 * in the UI rather than being buried.
 *
 * The shape: the browser posts the value straight here. Only the NAME goes
 * into the conversation. The agent reads values from disk when it actually
 * needs them; Konrad reads values via the reveal endpoint over the same
 * NextAuth-guarded proxy the rest of the web UI uses.
 *
 * ENCRYPTION (2026-08-23, aios-settings-and-secrets). Values are AES-256-GCM
 * at rest under a master key generated on first use at
 * SECRET_MASTER_KEY_PATH, 0600, root-owned — the same trust boundary as
 * before (the agent runs as root and must read these unattended, so the key
 * necessarily sits on the same disk under the same user), but this now
 * defends against the case the old comment dismissed too quickly: a backup
 * tarball, a misconfigured share, or a second process reading the store
 * directory without also holding the key. GCM is authenticated, so a
 * tampered ciphertext fails closed (throws) instead of silently decrypting
 * to garbage. Legacy plaintext files (written before this change) are read
 * transparently — `decryptValue` only decrypts payloads carrying the
 * `enc:v1:` prefix — and are re-encrypted the moment they are next written
 * through `putSecret` or `rotateSecret`.
 *
 * METADATA now lives in one `<name>.meta` JSON sidecar instead of three
 * (`.note`/`.pending`/`.requested-by`). Reading a secret that predates this
 * change (no `.meta` file yet) falls back to those legacy sidecars so an
 * in-flight pending flag or note is never silently dropped by the upgrade;
 * the fallback is one-shot — the next write persists a `.meta` file and the
 * legacy sidecars go unread from then on (they are left in place, not
 * deleted, since deleting isn't this task's job).
 *
 * AUDIT LOG. Every store/reveal/rotate/delete appends one JSON line to
 * SECRET_AUDIT_LOG_PATH (0600, root) — timestamp, action, name, service tag,
 * the run id that asked (when known), and whether it succeeded. The value is
 * never in that line, by construction: the audit entry type has no field
 * that could hold one. `getSecret` (the quiet, high-frequency internal read
 * used by cron-tick's connection re-check and the Gemini/GitHub integration
 * routes) is deliberately NOT audited and does NOT bump `accessCount` —
 * auditing every backend health-check read would make the log noise instead
 * of signal and inflate "last used" to mean nothing. Only a human-triggered
 * reveal (`POST /:name/reveal`) counts as a read for audit and metadata
 * purposes.
 *
 * On error handling: a corrupted or tampered ciphertext throws rather than
 * returning null, because null already means "no such secret" — collapsing
 * "tampered" into that would hide a security event as an ordinary 404.
 */

import {
  writeFile,
  readFile,
  readdir,
  unlink,
  mkdir,
  stat,
  open,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const STORE_DIR = process.env.SECRET_STORE_DIR ?? "/opt/ai-os/.secrets/store";
const MASTER_KEY_PATH =
  process.env.SECRET_MASTER_KEY_PATH ?? "/opt/ai-os/.secrets/.master.key";
const AUDIT_LOG_PATH =
  process.env.SECRET_AUDIT_LOG_PATH ?? "/opt/ai-os/.secrets/audit.log";

/** Names are used as filenames and echoed into chat, so keep them boring. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Coerce whatever a human typed into a valid name, rather than rejecting it.
 *
 * Why this exists: the secret control is the ONLY safe way to hand a credential
 * to this system — the chat thread is plaintext and backed up. Typing
 * "GitHub PAT" used to return a 400 explaining the character rules, which meant
 * the one path designed to keep secrets out of the transcript failed at exactly
 * the moment someone was trying to use it, and the obvious workaround is to
 * paste the secret into chat instead. A naming convention is not worth that.
 *
 * "GitHub PAT" -> "github-pat".  "  Twenty CRM  " -> "twenty-crm".
 *
 * Traversal is still impossible: the result is re-validated against NAME_RE by
 * the caller and pathFor() re-checks the resolved path regardless.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // spaces, slashes, accents, emoji -> dash
    .replace(/-{2,}/g, "-") // collapse runs
    .replace(/^[^a-z0-9]+/, "") // must start with alnum
    .replace(/[^a-z0-9]+$/, "") // and end with one
    .slice(0, 63);
}

function pathFor(name: string): string {
  // Belt and braces: NAME_RE already forbids slashes and dots-only names, but
  // resolve() + prefix check makes traversal impossible even if that changes.
  const abs = resolve(STORE_DIR, name);
  if (!abs.startsWith(resolve(STORE_DIR) + "/")) {
    throw new Error("invalid secret name");
  }
  return abs;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/* ---------------------------------------------------------------------------
 * Encryption. AES-256-GCM, one master key for the whole store. Wire format:
 * "enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>". Anything not carrying
 * that prefix is legacy plaintext, read as-is.
 * ------------------------------------------------------------------------- */

const ALGO = "aes-256-gcm";
const ENC_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedMasterKey: Buffer | null = null;

/** Generated on first use if absent — "on startup" in practice, since the
 *  first secret operation after boot runs within moments of the process
 *  coming up. Races between concurrent first-callers are resolved by an
 *  exclusive create (`flag: "wx"`): the loser re-reads what the winner wrote
 *  instead of clobbering it with its own random bytes. */
async function loadMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey;
  await mkdir(dirname(MASTER_KEY_PATH), { recursive: true, mode: 0o700 });
  try {
    const buf = await readFile(MASTER_KEY_PATH);
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `master key at ${MASTER_KEY_PATH} is ${buf.length} bytes, expected ${KEY_BYTES}`,
      );
    }
    cachedMasterKey = buf;
    return buf;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  const fresh = randomBytes(KEY_BYTES);
  try {
    await writeFile(MASTER_KEY_PATH, fresh, { mode: 0o600, flag: "wx" });
    cachedMasterKey = fresh;
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const buf = await readFile(MASTER_KEY_PATH);
      cachedMasterKey = buf;
      return buf;
    }
    throw err;
  }
}

async function encryptValue(value: string): Promise<string> {
  const key = await loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Throws (does not return null/garbage) if the payload claims to be
 *  encrypted but its auth tag does not verify — a tampered or corrupted
 *  ciphertext must fail closed. */
async function decryptValue(raw: string): Promise<string> {
  if (!raw.startsWith(ENC_PREFIX)) return raw; // legacy plaintext, read as-is
  const rest = raw.slice(ENC_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    throw new Error("malformed encrypted secret (expected iv:tag:ciphertext)");
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = await loadMasterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(), // throws on auth tag mismatch
  ]);
  return plain.toString("utf8");
}

/* ---------------------------------------------------------------------------
 * Metadata sidecar: "<name>.meta", one JSON file. Legacy stores (pre this
 * change) instead wrote three sidecars — .note, .pending, .requested-by —
 * which readMeta() falls back to when no .meta file exists yet.
 * ------------------------------------------------------------------------- */

const META_SUFFIX = ".meta";
const LEGACY_NOTE_SUFFIX = ".note";
const LEGACY_PENDING_SUFFIX = ".pending";
const LEGACY_REQUESTED_BY_SUFFIX = ".requested-by";
/** Every sidecar suffix in play, legacy or current — listSecrets() must skip
 *  all of them when it enumerates the store directory for real secret names. */
const SIDECAR_SUFFIXES = [
  META_SUFFIX,
  LEGACY_NOTE_SUFFIX,
  LEGACY_PENDING_SUFFIX,
  LEGACY_REQUESTED_BY_SUFFIX,
];

interface MetaFile {
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  accessCount: number;
  serviceTag: string | null;
  note: string | null;
  pending: boolean;
  requestedByRunId: string | null;
}

async function readMeta(p: string): Promise<MetaFile> {
  try {
    const raw = await readFile(`${p}${META_SUFFIX}`, "utf8");
    return JSON.parse(raw) as MetaFile;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  // No .meta yet: fall back to the legacy sidecars, and to the value file's
  // own timestamps for created/updated so a pre-existing secret does not
  // report an invented "just created" date the first time it's read.
  const s = await stat(p).catch(() => null);
  const fallbackTs = s ? s.mtime.toISOString() : new Date(0).toISOString();
  const note = await readFile(`${p}${LEGACY_NOTE_SUFFIX}`, "utf8").catch(
    () => null,
  );
  const pending = await stat(`${p}${LEGACY_PENDING_SUFFIX}`)
    .then(() => true)
    .catch(() => false);
  const requestedByRunId = await readFile(
    `${p}${LEGACY_REQUESTED_BY_SUFFIX}`,
    "utf8",
  ).catch(() => null);
  return {
    createdAt: fallbackTs,
    updatedAt: fallbackTs,
    lastUsedAt: null,
    accessCount: 0,
    serviceTag: null,
    note,
    pending,
    requestedByRunId,
  };
}

async function writeMeta(p: string, meta: MetaFile): Promise<void> {
  await writeFile(`${p}${META_SUFFIX}`, JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });
}

export interface SecretMeta {
  name: string;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  /** Null until the first human reveal. Internal reads via getSecret() do
   *  NOT update this — see module header. */
  lastUsedAt: string | null;
  /** Bumped only by revealSecret(), i.e. a human clicking "reveal" in the
   *  UI — not by every backend health-check read of the same value. */
  accessCount: number;
  /** Free-text tag naming which integration/service this credential is for
   *  (e.g. "github", "gemini"). Null when never set. */
  serviceTag: string | null;
  note: string | null;
  /** True when the operator flagged this secret "for Konrad to collect" —
   *  the UI surfaces it at the top of the secrets list with a distinct badge
   *  so a freshly-handed-over credential is not missed. Cleared automatically
   *  on the first successful reveal. */
  pending: boolean;
  /** The run id of the agent that asked for this secret, as supplied to
   *  POST /:name/mark-pending or POST /api/secrets. `null` when never
   *  supplied. Not cleared by reveal or clear-pending — it stays as an audit
   *  trail of the last request until a later call replaces it. */
  requestedByRunId: string | null;
}

function toSecretMeta(name: string, bytes: number, m: MetaFile): SecretMeta {
  return {
    name,
    bytes,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastUsedAt: m.lastUsedAt,
    accessCount: m.accessCount,
    serviceTag: m.serviceTag,
    note: m.note,
    pending: m.pending,
    requestedByRunId: m.requestedByRunId,
  };
}

/* ---------------------------------------------------------------------------
 * Audit log: append-only JSON Lines. Never carries a value — the type below
 * has no field that could hold one, so there is nothing to accidentally log.
 * ------------------------------------------------------------------------- */

export type AuditAction = "store" | "reveal" | "rotate" | "delete";

interface AuditEntry {
  ts: string;
  action: AuditAction;
  name: string;
  serviceTag: string | null;
  runId: string | null;
  ok: boolean;
}

async function appendAudit(entry: AuditEntry): Promise<void> {
  await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true, mode: 0o700 });
  const fh = await open(AUDIT_LOG_PATH, "a", 0o600);
  try {
    await fh.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
  } finally {
    await fh.close();
  }
}

/* ---------------------------------------------------------------------------
 * Secure delete: overwrite with random bytes of the same length before
 * unlinking, so an undelete off the raw block device can't recover the
 * ciphertext (and, for anything still in legacy plaintext, the value).
 * ------------------------------------------------------------------------- */

async function secureUnlink(p: string): Promise<void> {
  try {
    const s = await stat(p);
    if (s.size > 0) {
      await writeFile(p, randomBytes(s.size), { flag: "r+" });
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await unlink(p).catch(() => {});
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

export async function putSecret(
  name: string,
  value: string,
  opts: {
    note?: string | null;
    /** Optional. `true` marks pending, `false` clears the marker, `undefined`
     *  leaves whatever's already there — so re-POSTing a value without the
     *  flag doesn't silently un-flag it. */
    forKonrad?: boolean;
    /** Which integration/service this credential belongs to. `undefined`
     *  leaves the existing tag alone; `null` clears it. */
    serviceTag?: string | null;
    /** The run id performing this store, for the audit trail. */
    runId?: string;
  } = {},
): Promise<SecretMeta> {
  if (!isValidName(name)) {
    throw new Error(
      "secret name must be lowercase letters, digits, dot, dash or underscore",
    );
  }
  if (!value) throw new Error("empty secret");
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  const p = pathFor(name);

  const existing = await readMeta(p);
  const now = new Date().toISOString();
  const createdAt = await stat(p)
    .then(() => existing.createdAt)
    .catch(() => now); // first write for this name: it is created now

  const encrypted = await encryptValue(value);
  // mode on writeFile only applies at creation; chmod-on-write via flag 'w'
  // keeps an existing file's mode, so create restrictively from the start.
  await writeFile(p, encrypted, { mode: 0o600 });

  const meta: MetaFile = {
    createdAt,
    updatedAt: now,
    lastUsedAt: existing.lastUsedAt,
    accessCount: existing.accessCount,
    serviceTag:
      opts.serviceTag !== undefined ? opts.serviceTag : existing.serviceTag,
    note:
      opts.note !== undefined
        ? (opts.note && opts.note.trim() ? opts.note : null)
        : existing.note,
    pending: opts.forKonrad === true ? true : opts.forKonrad === false ? false : existing.pending,
    requestedByRunId: existing.requestedByRunId,
  };
  await writeMeta(p, meta);

  const s = await stat(p);
  await appendAudit({
    ts: now,
    action: "store",
    name,
    serviceTag: meta.serviceTag,
    runId: opts.runId ?? null,
    ok: true,
  });
  return toSecretMeta(name, s.size, meta);
}

/**
 * Coerce a rotate/store request's optional metadata field into the tri-state
 * `rotateSecret()` actually distinguishes.
 *
 * Three intentions arrive on the wire and only two of them used to survive:
 *   • field ABSENT (`undefined`)              → leave whatever is stored alone
 *   • field EMPTY  (`""`, `"   "`, or `null`) → CLEAR it
 *   • field SET    (a non-blank string)       → replace it, trimmed
 *
 * The middle case is the one this exists for. `SecretsPanel`'s Rotate modal
 * seeds its tag/note inputs from the stored values, so emptying a field there
 * is an explicit "remove this", not an omission — and it was being sent as
 * `undefined` (JSON.stringify drops the key entirely), which reads as "leave
 * alone" and made a tag impossible to remove from the UI at all.
 *
 * `null` is accepted as a clear alongside `""` because that is the obvious
 * thing an API client writes for "unset this", and silently treating it as
 * "leave alone" is the same defect one layer down.
 *
 * Anything that is neither a string, `null` nor `undefined` — a number, an
 * object — is a caller bug, so it throws with the offending type rather than
 * being coerced into one of the three meanings.
 */
export function coerceMetaField(
  raw: unknown,
  field: string,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(
      `${field} must be a string, null or absent — received ${typeof raw}`,
    );
  }
  return raw.trim() || null;
}

/** Replace a secret's value in place — same name, fresh ciphertext, updated
 *  `updatedAt`. Distinct from putSecret() mainly for the audit trail: a
 *  rotation is a different event than an initial store even though the
 *  on-disk mechanics are the same. */
export async function rotateSecret(
  name: string,
  value: string,
  opts: {
    note?: string | null;
    serviceTag?: string | null;
    runId?: string;
  } = {},
): Promise<SecretMeta> {
  if (!isValidName(name)) {
    throw new Error(
      "secret name must be lowercase letters, digits, dot, dash or underscore",
    );
  }
  if (!value) throw new Error("empty secret");
  const p = pathFor(name);

  let existing: MetaFile;
  try {
    await stat(p);
    existing = await readMeta(p);
  } catch (err) {
    if (isEnoent(err)) {
      await appendAudit({
        ts: new Date().toISOString(),
        action: "rotate",
        name,
        serviceTag: opts.serviceTag ?? null,
        runId: opts.runId ?? null,
        ok: false,
      });
      throw new Error(`no secret named "${name}" to rotate`);
    }
    throw err;
  }

  const now = new Date().toISOString();
  const encrypted = await encryptValue(value);
  await writeFile(p, encrypted, { mode: 0o600 });

  const meta: MetaFile = {
    ...existing,
    updatedAt: now,
    serviceTag:
      opts.serviceTag !== undefined ? opts.serviceTag : existing.serviceTag,
    note:
      opts.note !== undefined
        ? (opts.note && opts.note.trim() ? opts.note : null)
        : existing.note,
  };
  await writeMeta(p, meta);

  const s = await stat(p);
  await appendAudit({
    ts: now,
    action: "rotate",
    name,
    serviceTag: meta.serviceTag,
    runId: opts.runId ?? null,
    ok: true,
  });
  return toSecretMeta(name, s.size, meta);
}

/** Clear the "pending, Konrad hasn't collected yet" marker. Idempotent —
 *  succeeds even if the marker was never set. Called from the reveal route
 *  once Konrad has actually seen the value. */
export async function markCollected(name: string): Promise<void> {
  if (!isValidName(name)) return;
  const p = pathFor(name);
  const exists = await stat(p).then(() => true).catch(() => false);
  if (!exists) return;
  const meta = await readMeta(p);
  if (!meta.pending) return;
  await writeMeta(p, { ...meta, pending: false });
}

/** Flag an already-stored secret as "for Konrad to collect" without needing to
 *  re-supply its value — used when the agent stored the credential earlier
 *  (or in a different turn) and only now wants to surface it prominently.
 *  `requestedByRunId`, if supplied, is persisted alongside the pending flag
 *  so the UI can route the request back to the right chat.
 *  Returns false if no secret with that name exists. */
export async function markPending(
  name: string,
  requestedByRunId?: string,
): Promise<boolean> {
  if (!isValidName(name)) return false;
  const p = pathFor(name);
  const exists = await stat(p).then(() => true).catch(() => false);
  if (!exists) return false;
  const meta = await readMeta(p);
  await writeMeta(p, {
    ...meta,
    pending: true,
    requestedByRunId:
      requestedByRunId !== undefined ? requestedByRunId : meta.requestedByRunId,
  });
  return true;
}

/** Read a value, quietly. Reachable from internal callers only (cron-tick's
 *  connection re-check, the Gemini/GitHub integration routes) — does NOT
 *  audit and does NOT bump accessCount/lastUsedAt, because those exist to
 *  answer "when did a HUMAN last look at this", and a health-check probe
 *  running every few minutes is not that. Never called from the list route:
 *  listing must not accidentally leak values.
 *
 *  Returns null for "no such secret". Throws for "found something, but it
 *  doesn't decrypt" — a tampered/corrupted ciphertext is not the same fact
 *  as an absent one and must not be reported as though it were. */
export async function getSecret(name: string): Promise<string | null> {
  if (!isValidName(name)) return null;
  let raw: string;
  try {
    raw = await readFile(pathFor(name), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return decryptValue(raw);
}

/** Human-triggered read — POST /api/secrets/:name/reveal. Decrypts, bumps
 *  `accessCount`, sets `lastUsedAt`, clears `pending`, and appends an audit
 *  entry regardless of outcome (a failed reveal attempt is itself a signal
 *  worth keeping). Returns null for "no such secret"; throws (after logging
 *  the failed audit entry) for a tampered/corrupted ciphertext. */
export async function revealSecret(
  name: string,
  opts: { runId?: string } = {},
): Promise<{ name: string; value: string } | null> {
  if (!isValidName(name)) return null;
  const p = pathFor(name);

  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }

  const meta = await readMeta(p);
  let value: string;
  try {
    value = await decryptValue(raw);
  } catch (err) {
    await appendAudit({
      ts: new Date().toISOString(),
      action: "reveal",
      name,
      serviceTag: meta.serviceTag,
      runId: opts.runId ?? null,
      ok: false,
    });
    throw err;
  }

  const now = new Date().toISOString();
  const updated: MetaFile = {
    ...meta,
    lastUsedAt: now,
    accessCount: meta.accessCount + 1,
    pending: false,
  };
  await writeMeta(p, updated);
  await appendAudit({
    ts: now,
    action: "reveal",
    name,
    serviceTag: updated.serviceTag,
    runId: opts.runId ?? null,
    ok: true,
  });
  return { name, value };
}

/** Names and metadata only — never values. This is what the UI and the agent
 *  are allowed to enumerate. */
export async function listSecrets(): Promise<SecretMeta[]> {
  try {
    const files = await readdir(STORE_DIR);
    const out: SecretMeta[] = [];
    for (const f of files) {
      if (SIDECAR_SUFFIXES.some((suf) => f.endsWith(suf))) continue;
      const p = join(STORE_DIR, f);
      const s = await stat(p).catch(() => null);
      if (!s?.isFile()) continue;
      const meta = await readMeta(p);
      out.push(toSecretMeta(f, s.size, meta));
    }
    // Pending secrets first, then alphabetical — the whole point of the
    // marker is that the credential Konrad still needs to collect is not
    // buried below a scrollable list of API keys.
    return out.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

export async function deleteSecret(
  name: string,
  opts: { runId?: string } = {},
): Promise<boolean> {
  if (!isValidName(name)) return false;
  const p = pathFor(name);
  const meta = await readMeta(p).catch(() => null);
  const existed = await stat(p).then(() => true).catch(() => false);
  if (!existed) return false;

  await secureUnlink(p);
  await secureUnlink(`${p}${META_SUFFIX}`);
  await secureUnlink(`${p}${LEGACY_NOTE_SUFFIX}`);
  await secureUnlink(`${p}${LEGACY_PENDING_SUFFIX}`);
  await secureUnlink(`${p}${LEGACY_REQUESTED_BY_SUFFIX}`);

  await appendAudit({
    ts: new Date().toISOString(),
    action: "delete",
    name,
    serviceTag: meta?.serviceTag ?? null,
    runId: opts.runId ?? null,
    ok: true,
  });
  return true;
}
