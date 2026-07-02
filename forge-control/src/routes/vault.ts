/**
 * Vault write routes — quick capture into Obsidian.
 *
 *   POST /api/vault/append  { section: 'Tasks'|'Notes'|'Journal', text, prefix? }
 *   POST /api/vault/note    { title, content?, folder? }
 *   GET  /api/vault/daily   → today's daily note (or content: null)
 *
 * Append-or-create only; see src/lib/vault.ts for the safety contract.
 */

import { Hono } from "hono";
import {
  appendToDailyNote,
  createNote,
  readDailyNote,
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

export default r;
