import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { run } from "../lib/exec.ts";

const r = new Hono();

async function readLoadAvg() {
  const raw = await readFile("/proc/loadavg", "utf8");
  const parts = raw.trim().split(/\s+/);
  return {
    load_1m: Number(parts[0]),
    load_5m: Number(parts[1]),
    load_15m: Number(parts[2]),
    running_total: parts[3] ?? null,
  };
}

async function readMemInfo() {
  const raw = await readFile("/proc/meminfo", "utf8");
  const get = (key: string): number => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = get("MemTotal");
  const available = get("MemAvailable");
  const free = get("MemFree");
  const buffers = get("Buffers");
  const cached = get("Cached");
  const swap_total = get("SwapTotal");
  const swap_free = get("SwapFree");
  const used = total - available;
  return {
    total_bytes: total,
    used_bytes: used,
    available_bytes: available,
    free_bytes: free,
    buffers_bytes: buffers,
    cached_bytes: cached,
    used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    swap: {
      total_bytes: swap_total,
      used_bytes: swap_total - swap_free,
      used_pct:
        swap_total > 0
          ? Math.round(((swap_total - swap_free) / swap_total) * 1000) / 10
          : 0,
    },
  };
}

async function readUptime() {
  const raw = await readFile("/proc/uptime", "utf8");
  return Number(raw.split(/\s+/)[0]);
}

async function readDisks() {
  // Mounts we care about: /, /opt, /tmp
  const { ok, stdout } = await run("df -B1 -P /", 3000);
  const { ok: ok2, stdout: stdout2 } = await run("df -B1 -P /opt", 3000);
  const out: Record<
    string,
    {
      total_bytes: number;
      used_bytes: number;
      available_bytes: number;
      used_pct: number;
    }
  > = {};
  const parse = (text: string, key: string) => {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return;
    const cols = lines[1].split(/\s+/);
    if (cols.length < 6) return;
    const total = Number(cols[1]);
    const used = Number(cols[2]);
    const avail = Number(cols[3]);
    out[key] = {
      total_bytes: total,
      used_bytes: used,
      available_bytes: avail,
      used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  };
  if (ok) parse(stdout, "/");
  if (ok2) parse(stdout2, "/opt");
  return out;
}

r.get("/stats", async (c) => {
  const [load, mem, disks, uptime] = await Promise.all([
    readLoadAvg(),
    readMemInfo(),
    readDisks(),
    readUptime(),
  ]);
  return c.json({
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(uptime),
    cpu: load,
    memory: mem,
    disks,
  });
});

export default r;
