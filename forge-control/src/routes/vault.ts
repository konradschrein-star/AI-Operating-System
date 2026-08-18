/**
 * Vault write routes — quick capture into Obsidian, and the edit path.
 *
 *   POST /api/vault/append  { section: 'Tasks'|'Notes'|'Journal', text, prefix? }
 *   POST /api/vault/note    { title, content?, folder? }
 *   GET  /api/vault/daily   → today's daily note (or content: null)
 *   GET  /api/vault/file?path=<vault-relative>
 *                           → { path, content, sha256, mtime_ms, bytes }
 *   PUT  /api/vault/file    { path, content, base_sha256 }
 *                           → 200 { ok, path, sha256, bytes, snapshot }
 *                           → 409 { error, current_sha256, current_content,
 *                                   current_content_truncated, current_bytes }
 *
 * THE UNDO CONTRACT (02-architecture.md §1.2): every edit snapshots the prior
 * bytes before the new ones land, empty and whitespace-only bodies are refused,
 * and there is no delete verb — absent, not disabled (R8).
 *
 * The transport rules that belong to THIS layer: a 409 must carry the current
 * content, or Konrad cannot see the diff and learns to click through conflicts
 * (R3); a body that failed to parse is a 400, never an empty write attempt; and
 * no catch here returns a default — every one carries the upstream message
 * (N1/R20). The guards themselves live in src/lib/vault.ts and are REUSED, not
 * reimplemented, because two guards drift (R9).
 */

import { Hono } from "hono";
import {
  appendToDailyNote,
  createNote,
  readDailyNote,
  readVaultFile,
  writeVaultFile,
  VaultConflictError,
  VaultRefusedError,
  type DailySection,
} from "../lib/vault.ts";

const r = new Hono();

const SECTIONS = new Set<DailySection>(["Tasks", "Notes", "Journal"]);

r.post("/append", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    section?: string;
    text?: string;
    prefix?: string;
  };
  const section = (body.section ?? "Notes") as DailySection;
  if (!SECTIONS.has(section)) {
    return c.json({ error: `invalid section: ${body.section}` }, 400);
  }
  const text = (body.text ?? "").trim();
  if (!text) return c.json({ error: "text required" }, 400);
  try {
    const result = await appendToDailyNote({
      section,
      text,
      prefix: body.prefix,
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[vault/append]", msg);
    return c.json({ error: msg }, 500);
  }
});

r.post("/note", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
    folder?: string;
  };
  const title = (body.title ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  try {
    const result = await createNote({
      title,
      content: body.content,
      folder: body.folder,
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[vault/note]", msg);
    return c.json({ error: msg }, 500);
  }
});

r.get("/daily", async (c) => {
  try {
    return c.json(await readDailyNote());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// The edit path (02-architecture.md §1.2). Additive: the three handlers above
// are byte-identical to what they were before this project (R11).
// ---------------------------------------------------------------------------

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How much of the conflicting note the 409 carries, in UTF-16 code units.
 *
 *  R3 requires the current content to travel with the conflict — a 409 the
 *  operator cannot diff is a dead end he learns to click through. But the whole
 *  note is not free: a 256 MB note measured a 3.2 s stall and +224 MB RSS in
 *  the SINGLE process that also runs the cron tick, the vault sync and Telegram
 *  delivery, and past V8's string limit it fails outright. 8 Mi characters is
 *  larger than every note in the vault by three orders of magnitude, so the cap
 *  is invisible in normal use and only fires on the pathological case.
 *
 *  Cut on code units, never on bytes: a byte slice through a multi-byte
 *  character emits a lone surrogate and the JSON body becomes undecodable. */
const MAX_CONFLICT_CONTENT = 8 * 1024 * 1024;

/** GET /file?path=… — the exact bytes on disk, with the hash the caller must
 *  hand back as base_sha256 on the matching PUT (R1). */
r.get("/file", async (c) => {
  const rel = (c.req.query("path") ?? "").trim();
  if (!rel) return c.json({ error: "path required" }, 400);
  try {
    const file = await readVaultFile(rel);
    // Mapped field by field: the lib returns mtimeMs, the wire carries
    // mtime_ms. A spread would ship the camelCase name and the surface would
    // read undefined.
    return c.json({
      path: file.path,
      content: file.content,
      sha256: file.sha256,
      mtime_ms: file.mtimeMs,
      bytes: file.bytes,
    });
  } catch (e) {
    if (e instanceof VaultRefusedError) {
      console.error("[vault/file:get]", e.message);
      return c.json({ error: e.message }, 400);
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("[vault/file:get]", `no such note: ${rel}`);
      return c.json({ error: `no such note: ${rel}`, path: rel }, 404);
    }
    const msg = describe(e);
    console.error("[vault/file:get]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** PUT /file — compare-and-swap edit of an existing note. Creation stays with
 *  POST /note; a compare-and-swap against a missing file has no base (R2). */
r.put("/file", async (c) => {
  // NOT `.catch(() => ({}))` like the three handlers above. The realistic
  // catastrophe here is a dropped or malformed body, and a body that failed to
  // parse must never become a write attempt against a note.
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch (e) {
    const msg = `invalid json: ${describe(e)}`;
    console.error("[vault/file:put]", msg);
    return c.json({ error: msg }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const msg =
      `invalid json: body must be a JSON object with {path, content, base_sha256}, received ` +
      (parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed);
    console.error("[vault/file:put]", msg);
    return c.json({ error: msg }, 400);
  }
  const body = parsed as {
    path?: unknown;
    content?: unknown;
    base_sha256?: unknown;
  };

  try {
    // The three fields cross the type boundary unchecked ON PURPOSE:
    // writeVaultFile() re-reads each one as `unknown` and refuses a non-string
    // with a diagnostic of its own — its steps 1, 2 and 3, the path/`.md`
    // refusal, the empty-body refusal and the base_sha256 refusal. Named
    // rather than pinned by line: the pins were `lib/vault.ts:353, :359, :372`
    // and were three editing rounds stale by the time anyone read them. A
    // second check here would be a second guard, and two guards drift (R9).
    const result = await writeVaultFile({
      path: body.path as string,
      content: body.content as string,
      baseSha256: body.base_sha256 as string,
    });
    return c.json({
      ok: true,
      path: result.path,
      sha256: result.sha256,
      bytes: result.bytes,
      snapshot: result.snapshot,
    });
  } catch (e) {
    if (e instanceof VaultConflictError) {
      console.error("[vault/file:put]", e.message);
      // The current content travels in the body or the conflict is a dead end
      // the operator learns to click through (R3) — capped, and the cap is
      // ANNOUNCED. A client that receives a silently shortened note and offers
      // it as "the current version" would destroy the tail on the next save.
      const full = e.currentContent;
      let prefix = full.slice(0, MAX_CONFLICT_CONTENT);
      // Never end on a lone high surrogate: the pair's other half is past the
      // cut, and JSON.stringify would emit an unpaired code unit.
      const last = prefix.charCodeAt(prefix.length - 1);
      if (prefix.length < full.length && last >= 0xd800 && last <= 0xdbff) {
        prefix = prefix.slice(0, -1);
      }
      const truncated = prefix.length < full.length;
      return c.json(
        {
          error: e.message,
          current_sha256: e.currentSha256,
          current_content: prefix,
          // The sha256 is over the WHOLE note, so a client that hands
          // current_content back as the new body must know it is a prefix.
          current_content_truncated: truncated,
          current_bytes: Buffer.byteLength(full, "utf8"),
        },
        409,
      );
    }
    if (e instanceof VaultRefusedError) {
      console.error("[vault/file:put]", e.message);
      return c.json({ error: e.message }, 400);
    }
    const msg = describe(e);
    console.error("[vault/file:put]", msg);
    return c.json({ error: msg }, 500);
  }
});

export default r;
