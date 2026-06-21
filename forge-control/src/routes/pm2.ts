import { Hono } from "hono";
import { run } from "../lib/exec.ts";

const r = new Hono();

r.get("/list", async (c) => {
  const { ok, stdout, stderr } = await run("pm2 jlist", 5000);
  if (!ok) return c.json({ error: stderr || "pm2 jlist failed" }, 502);
  let raw: any[];
  try {
    raw = JSON.parse(stdout);
  } catch {
    return c.json({ error: "invalid pm2 jlist output" }, 502);
  }
  const procs = raw.map((p: any) => ({
    name: p.name,
    pid: p.pid,
    status: p.pm2_env?.status ?? "unknown",
    restarts: p.pm2_env?.restart_time ?? 0,
    uptime_ms: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    cpu_pct: p.monit?.cpu ?? 0,
    memory_bytes: p.monit?.memory ?? 0,
    cwd: p.pm2_env?.pm_cwd ?? null,
    script: p.pm2_env?.pm_exec_path?.split("/").pop() ?? null,
  }));
  return c.json({
    count: procs.length,
    online: procs.filter((p) => p.status === "online").length,
    processes: procs,
  });
});

export default r;
