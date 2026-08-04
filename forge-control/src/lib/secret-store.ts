/**
 * Secret store — a way to hand the agent a credential without writing it into
 * the chat.
 *
 * The problem: runs.thread is plain JSONB in postgres, it is what the executor
 * replays into the model's context every turn, and it is backed up nightly.
 * A password pasted into a message is therefore in the database, in every
 * subsequent prompt, and in every backup, forever. Konrad was one keystroke
 * from pasting an SSH private key into a thread when he stopped and asked for
 * this instead.
 *
 * The shape: the browser posts the value straight here. Only the NAME goes into
 * the conversation. The agent reads the value from disk when it actually needs
 * it, which is almost never — most of the time it just passes the name to a
 * command.
 *
 * On encryption, honestly: these are stored 0600 under root, not encrypted. The
 * agent runs as root and must be able to read them unattended, so any key would
 * have to sit on the same disk under the same user — which protects against
 * nothing while implying it protects against something. The real boundary here
 * is filesystem permissions plus keeping values out of the database, the
 * prompt, and the backups. That is a genuine improvement; "encrypted at rest"
 * would be theatre.
 */

import { writeFile, readFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const STORE_DIR = process.env.SECRET_STORE_DIR ?? "/opt/ai-os/.secrets/store";

/** Names are used as filenames and echoed into chat, so keep them boring. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
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
}

const NOTE_SUFFIX = ".note";

export async function putSecret(
  name: string,
  value: string,
  note?: string | null,
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
  if (note) await writeFile(`${p}${NOTE_SUFFIX}`, note, { mode: 0o600 });
  const s = await stat(p);
  return {
    name,
    bytes: s.size,
    updatedAt: s.mtime.toISOString(),
    note: note ?? null,
  };
}

/** Read a value. Deliberately NOT exposed over the API — see routes/secrets.ts.
 *  The agent reads secrets from disk, not over HTTP. */
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
      if (f.endsWith(NOTE_SUFFIX)) continue;
      const s = await stat(join(STORE_DIR, f)).catch(() => null);
      if (!s?.isFile()) continue;
      const note = await readFile(join(STORE_DIR, `${f}${NOTE_SUFFIX}`), "utf8").catch(
        () => null,
      );
      out.push({
        name: f,
        bytes: s.size,
        updatedAt: s.mtime.toISOString(),
        note,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function deleteSecret(name: string): Promise<boolean> {
  if (!isValidName(name)) return false;
  try {
    await unlink(pathFor(name));
    await unlink(`${pathFor(name)}${NOTE_SUFFIX}`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
