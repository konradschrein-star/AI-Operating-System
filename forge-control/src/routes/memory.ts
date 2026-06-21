import { Hono } from "hono";
import {
  listMemory,
  getMemory,
  searchMemory,
  pingMemory,
} from "../db/memory.ts";

const r = new Hono();

r.get("/health", async (c) => c.json(await pingMemory()));

r.get("/", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "200")),
  );
  const notes = await listMemory(limit);
  return c.json({ count: notes.length, notes });
});

r.get("/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) return c.json({ q, hits: [], message: "query required" }, 400);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "12")));
  const hits = await searchMemory(q, limit);
  return c.json({ q, count: hits.length, hits });
});

// Slug may contain spaces (vault file names do). Hono decodes path params.
r.get("/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const note = await getMemory(slug);
  if (!note) return c.json({ error: "note not found", slug }, 404);
  return c.json({ note });
});

export default r;
