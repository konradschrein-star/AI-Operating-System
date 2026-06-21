import { Hono } from "hono";
import { getPipeline } from "../db/pipeline.ts";

const r = new Hono();

r.get("/", async (c) => {
  const p = await getPipeline();
  return c.json(p);
});

export default r;
