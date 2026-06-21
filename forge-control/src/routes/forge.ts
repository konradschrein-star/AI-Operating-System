import { Hono } from "hono";
import {
  listActiveJobs,
  listRecentJobs,
  jobsByStatus,
  getJob,
  pingPostgres,
} from "../db/forge.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

r.get("/health", async (c) => c.json(await pingPostgres()));

r.get("/jobs", async (c) => {
  const scope = c.req.query("scope") ?? "active";
  const limit = Math.min(
    500,
    Math.max(1, Number(c.req.query("limit") ?? "100")),
  );
  const jobs =
    scope === "all" ? await listRecentJobs(limit) : await listActiveJobs(limit);
  return c.json({ scope, count: jobs.length, jobs });
});

r.get("/jobs/by-status", async (c) => {
  const groups = await jobsByStatus();
  return c.json({
    total: groups.reduce((s, g) => s + g.count, 0),
    groups,
  });
});

r.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id))
    return c.json({ error: "invalid job id (expected uuid)" }, 400);
  const job = await getJob(id);
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json({ job });
});

export default r;
