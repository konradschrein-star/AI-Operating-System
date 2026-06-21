import { Hono } from "hono";
import { listDecisions } from "../db/ai_os.ts";

const r = new Hono();

r.get("/", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "50")),
  );
  const decisions = await listDecisions(limit);
  return c.json({ count: decisions.length, decisions });
});

export default r;
