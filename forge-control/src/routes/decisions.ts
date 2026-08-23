import { Hono } from "hono";
import { listDecisions } from "../db/ai_os.ts";

const r = new Hono();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

r.get("/", async (c) => {
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "50")),
  );

  const day = c.req.query("day");
  if (day !== undefined && !DAY_RE.test(day)) {
    return c.json({ error: `day must be YYYY-MM-DD, got: ${day}` }, 400);
  }

  const from = c.req.query("from");
  if (from !== undefined && Number.isNaN(Date.parse(from))) {
    return c.json({ error: `from is not a valid timestamp: ${from}` }, 400);
  }
  const to = c.req.query("to");
  if (to !== undefined && Number.isNaN(Date.parse(to))) {
    return c.json({ error: `to is not a valid timestamp: ${to}` }, 400);
  }

  const decisions = await listDecisions(limit, { day, from, to });
  return c.json({ count: decisions.length, decisions });
});

export default r;
