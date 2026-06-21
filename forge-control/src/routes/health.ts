import { Hono } from "hono";

const r = new Hono();

r.get("/", (c) =>
  c.json({
    ok: true,
    service: "forge-control",
    version: "0.1.0",
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }),
);

export default r;
