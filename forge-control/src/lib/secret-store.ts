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
 * On encryption, honestly: these are stored 0600 under root, not encrypted.
 * The agent runs as root and must be able to read them unattended, so any key
 * would have to sit on the same disk under the same user — which protects
 * against nothing while implying it protects against something. The real
 * boundary here is filesystem permissions plus keeping values out of the
 * database, the prompt, and the backups. That is a genuine improvement;
 * "encrypted at rest" would be theatre.
 */

import { writeFile, readFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const STORE_DIR = process.env.SECRET_STORE_DIR ?? "/opt/ai-os/.secrets/store";

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

export interface SecretMeta {
  name: string;
  bytes: number;
  updatedAt: string;
  note: string | null;
  /** True when the operator flagged this secret "for Konrad to collect" —
   *  the UI surfaces it at the top of the secrets list with a distinct badge
   *  so a freshly-handed-over credential is not missed. Cleared automatically
   *  on the first successful reveal. */
  pending: boolean;
}

const NOTE_SUFFIX = ".note";
/** Sidecar marker file: presence == "pending, Konrad hasn't collected yet".
 *  Kept as a separate zero-byte file rather than encoded into the note so the
 *  agent can flip the flag without touching the human-readable note copy. */
const PENDING_SUFFIX = ".pending";

export async function putSecret(
  name: string,
  value: string,
  opts: {
    note?: string | null;
    /** Optional. `true` marks pending, `false` clears the marker, `undefined`
     *  leaves whatever's already there — so re-POSTing a value without the
     *  flag doesn't silently un-flag it. */
    forKonrad?: boolean;
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
  // mode on writeFile only applies at creation; chmod-on-write via flag 'w'
  // keeps an existing file's mode, so create restrictively from the start.
  await writeFile(p, value, { mode: 0o600 });

  // Note handling: `null` (or empty) explicitly clears the sidecar; `undefined`
  // leaves the existing note alone. Prevents stale notes lingering when the
  // caller re-POSTs the same name with fresh contents.
  const noteArg = opts.note;
  if (noteArg && noteArg.trim()) {
    await writeFile(`${p}${NOTE_SUFFIX}`, noteArg, { mode: 0o600 });
  } else if (noteArg === null || noteArg === "") {
    await unlink(`${p}${NOTE_SUFFIX}`).catch(() => {});
  }

  if (opts.forKonrad === true) {
    await writeFile(`${p}${PENDING_SUFFIX}`, "", { mode: 0o600 });
  } else if (opts.forKonrad === false) {
    await unlink(`${p}${PENDING_SUFFIX}`).catch(() => {});
  }

  const s = await stat(p);
  const noteOnDisk = await readFile(`${p}${NOTE_SUFFIX}`, "utf8").catch(
    () => null,
  );
  const pending = await stat(`${p}${PENDING_SUFFIX}`)
    .then(() => true)
    .catch(() => false);
  return {
    name,
    bytes: s.size,
    updatedAt: s.mtime.toISOString(),
    note: noteOnDisk,
    pending,
  };
}

/** Clear the "pending, Konrad hasn't collected yet" marker. Idempotent —
 *  succeeds even if the marker was never set. Called from the reveal route
 *  once Konrad has actually seen the value. */
export async function markCollected(name: string): Promise<void> {
  if (!isValidName(name)) return;
  await unlink(`${pathFor(name)}${PENDING_SUFFIX}`).catch(() => {});
}

/** Flag an already-stored secret as "for Konrad to collect" without needing to
 *  re-supply its value — used when the agent stored the credential earlier
 *  (or in a different turn) and only now wants to surface it prominently.
 *  Returns false if no secret with that name exists. */
export async function markPending(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  const p = pathFor(name);
  try {
    await stat(p);
  } catch {
    return false;
  }
  await writeFile(`${p}${PENDING_SUFFIX}`, "", { mode: 0o600 });
  return true;
}

/** Read a value. Reachable from the agent process directly and from the reveal
 *  route (POST /api/secrets/:name/reveal) — the latter guarded by the same
 *  NextAuth session that gates every other UI request. Never called from the
 *  list route: listing must not accidentally leak values. */
export async function getSecret(name: string): Promise<string | null> {
  if (!isValidName(name)) return null;
  try {
    return await readFile(pathFor(name), "utf8");
  } catch {
    return null;
  }
}

/** Names and metadata only — never values. This is what the UI and the agent
 *  are allowed to enumerate. */
export async function listSecrets(): Promise<SecretMeta[]> {
  try {
    const files = await readdir(STORE_DIR);
    const out: SecretMeta[] = [];
    for (const f of files) {
      if (f.endsWith(NOTE_SUFFIX) || f.endsWith(PENDING_SUFFIX)) continue;
      const s = await stat(join(STORE_DIR, f)).catch(() => null);
      if (!s?.isFile()) continue;
      const note = await readFile(join(STORE_DIR, `${f}${NOTE_SUFFIX}`), "utf8").catch(
        () => null,
      );
      const pending = await stat(join(STORE_DIR, `${f}${PENDING_SUFFIX}`))
        .then(() => true)
        .catch(() => false);
      out.push({
        name: f,
        bytes: s.size,
        updatedAt: s.mtime.toISOString(),
        note,
        pending,
      });
    }
    // Pending secrets first, then alphabetical — the whole point of the
    // marker is that the credential Konrad still needs to collect is not
    // buried below a scrollable list of API keys.
    return out.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

export async function deleteSecret(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  try {
    await unlink(pathFor(name));
    await unlink(`${pathFor(name)}${NOTE_SUFFIX}`).catch(() => {});
    await unlink(`${pathFor(name)}${PENDING_SUFFIX}`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
