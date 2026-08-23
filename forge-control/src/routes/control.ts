import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import os from "node:os";
import {
  getFleetState,
  setFleetState,
  appendDecision,
  listDecisions,
} from "../db/ai_os.ts";
import {
  listWorkers,
  latestHeartbeatPerWorker,
} from "../db/hermes.ts";
import { getAutonomy } from "../db/autonomy.ts";
import { run } from "../lib/exec.ts";

const r = new Hono();

/* ----------------------------------------------------------------------------
 * Helper: Host Telemetry
 * -------------------------------------------------------------------------- */

async function readLoadAvg() {
  try {
    const raw = await readFile("/proc/loadavg", "utf8");
    const parts = raw.trim().split(/\s+/);
    return {
      load_1m: Number(parts[0]) || 0,
      load_5m: Number(parts[1]) || 0,
      load_15m: Number(parts[2]) || 0,
      running_total: parts[3] ?? null,
    };
  } catch {
    const loads = os.loadavg();
    return {
      load_1m: Math.round(loads[0] * 100) / 100,
      load_5m: Math.round(loads[1] * 100) / 100,
      load_15m: Math.round(loads[2] * 100) / 100,
      running_total: null,
    };
  }
}

async function readMemInfo() {
  try {
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
    const used = Math.max(0, total - available);
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
        used_bytes: Math.max(0, swap_total - swap_free),
        used_pct:
          swap_total > 0
            ? Math.round(((swap_total - swap_free) / swap_total) * 1000) / 10
            : 0,
      },
    };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      total_bytes: total,
      used_bytes: used,
      available_bytes: free,
      free_bytes: free,
      buffers_bytes: 0,
      cached_bytes: 0,
      used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      swap: { total_bytes: 0, used_bytes: 0, used_pct: 0 },
    };
  }
}

async function readDisks() {
  const { ok, stdout } = await run("df -B1 -P / /opt", 3000);
  const out: Record<
    string,
    {
      total_bytes: number;
      used_bytes: number;
      available_bytes: number;
      used_pct: number;
    }
  > = {};

  if (ok) {
    const lines = stdout.trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/\s+/);
      if (cols.length >= 6) {
        const mount = cols[5];
        const total = Number(cols[1]) || 0;
        const used = Number(cols[2]) || 0;
        const avail = Number(cols[3]) || 0;
        if (mount === "/" || mount === "/opt") {
          out[mount] = {
            total_bytes: total,
            used_bytes: used,
            available_bytes: avail,
            used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
          };
        }
      }
    }
  }

  if (!out["/"]) {
    out["/"] = { total_bytes: 0, used_bytes: 0, available_bytes: 0, used_pct: 0 };
  }
  if (!out["/opt"]) {
    out["/opt"] = { total_bytes: 0, used_bytes: 0, available_bytes: 0, used_pct: 0 };
  }
  return out;
}

async function readPm2Procs() {
  const { ok, stdout } = await run("pm2 jlist", 4000);
  if (!ok) {
    return { count: 0, online: 0, stopped: 0, processes: [] };
  }
  try {
    const raw = JSON.parse(stdout) as Array<{
      name: string;
      pid?: number;
      pm2_env?: {
        status?: string;
        restart_time?: number;
        pm_uptime?: number;
        pm_cwd?: string;
        pm_exec_path?: string;
      };
      monit?: {
        cpu?: number;
        memory?: number;
      };
    }>;
    const processes = raw.map((p) => ({
      name: p.name,
      pid: p.pid ?? null,
      status: p.pm2_env?.status ?? "unknown",
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime_ms: p.pm2_env?.pm_uptime ? Math.max(0, Date.now() - p.pm2_env.pm_uptime) : 0,
      cpu_pct: p.monit?.cpu ?? 0,
      memory_bytes: p.monit?.memory ?? 0,
    }));
    return {
      count: processes.length,
      online: processes.filter((p) => p.status === "online").length,
      stopped: processes.filter((p) => p.status !== "online").length,
      processes,
    };
  } catch {
    return { count: 0, online: 0, stopped: 0, processes: [] };
  }
}

async function readSystemdSummary() {
  const { ok, stdout } = await run(
    "systemctl list-units --type=service --all --no-pager --no-legend",
    4000,
  );
  if (!ok) {
    return { count: 0, active: 0, flapping: 0, failed: 0 };
  }
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  let active = 0;
  let flapping = 0;
  let failed = 0;
  for (const line of lines) {
    const cleaned = line.replace(/^[●○]\s+/, "");
    const cols = cleaned.split(/\s+/);
    if (cols.length >= 4) {
      const activeState = cols[2];
      const subState = cols[3];
      if (activeState === "active") active++;
      if (activeState === "failed" || subState === "failed") failed++;
      if (activeState === "activating" && subState === "auto-restart") flapping++;
    }
  }
  return {
    count: lines.length,
    active,
    flapping,
    failed,
  };
}

/* ----------------------------------------------------------------------------
 * Helper: Windows 11 VM Detection
 * -------------------------------------------------------------------------- */

async function readWindowsVm() {
  const [psRes, vncRes, rdpRes] = await Promise.all([
    run("ps -eo pid,cmd", 2500),
    run("systemctl is-active win11-vnc.service", 1500),
    run("systemctl is-active rdp-forward.service", 1500),
  ]);

  let pid: number | null = null;
  let status: "running" | "stopped" = "stopped";
  let memoryAllocated = "8 GB";
  let vcpus = 4;

  if (psRes.ok) {
    const lines = psRes.stdout.split("\n");
    const winLine = lines.find(
      (l) => l.includes("guest=win11") || (l.includes("qemu") && l.includes("win11")),
    );
    if (winLine) {
      const matchPid = winLine.trim().split(/\s+/)[0];
      const parsedPid = parseInt(matchPid, 10);
      if (!Number.isNaN(parsedPid)) {
        pid = parsedPid;
        status = "running";
      }
      if (winLine.includes("-m size=8388608k") || winLine.includes("8589934592")) {
        memoryAllocated = "8 GB";
      } else if (winLine.includes("-m size=16777216k") || winLine.includes("17179869184")) {
        memoryAllocated = "16 GB";
      }
      const smpMatch = winLine.match(/-smp\s+(\d+)/);
      if (smpMatch) {
        vcpus = parseInt(smpMatch[1], 10) || 4;
      }
    }
  }

  const novncActive = vncRes.ok && vncRes.stdout.trim() === "active";
  const rdpActive = rdpRes.ok && (rdpRes.stdout.trim() === "active" || rdpRes.stdout.trim() === "inactive");

  return {
    name: "Windows 11 QEMU VM",
    status,
    pid,
    memory_allocated: memoryAllocated,
    vcpus,
    vnc_internal_port: 5910,
    novnc_port: 6080,
    novnc_url: "http://65.108.6.149:6080",
    novnc_active: novncActive,
    rdp_address: "65.108.6.149:33389",
    rdp_active: rdpActive,
  };
}

/* ----------------------------------------------------------------------------
 * Helper: Hermes Workers
 * -------------------------------------------------------------------------- */

function readHermesWorkers() {
  try {
    const workers = listWorkers();
    const heartbeats = latestHeartbeatPerWorker();
    const hbByWorker = new Map(heartbeats.map((h) => [h.worker_id, h]));

    const mapped = workers.map((w) => {
      const hb = hbByWorker.get(w.id) ?? null;
      let ageSec: number | null = null;
      if (hb?.recorded_at) {
        const ts = new Date(hb.recorded_at.includes("T") ? hb.recorded_at : `${hb.recorded_at}Z`).getTime();
        if (!Number.isNaN(ts)) {
          ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        }
      }
      return {
        id: w.id,
        role: w.role,
        worker_type: w.worker_type,
        tmux_session: w.tmux_session,
        status: w.status,
        spawn_count: w.spawn_count,
        last_spawn: w.last_spawn,
        created_at: w.created_at,
        latest_heartbeat: hb
          ? {
              id: hb.id,
              state: hb.state,
              progress: hb.progress,
              failures: hb.failures,
              needs_human: hb.needs_human,
              recorded_at: hb.recorded_at,
              activity_at: hb.activity_at,
            }
          : null,
        heartbeat_age_sec: ageSec,
      };
    });

    return {
      workers: mapped,
      counts: {
        running: mapped.filter((w) => w.status === "running").length,
        dead: mapped.filter((w) => w.status === "dead").length,
        stopped: mapped.filter((w) => w.status === "stopped").length,
        suspected: mapped.filter((w) => w.status === "suspected").length,
        total: mapped.length,
      },
    };
  } catch (err) {
    return {
      workers: [],
      counts: { running: 0, dead: 0, stopped: 0, suspected: 0, total: 0 },
    };
  }
}

/* ----------------------------------------------------------------------------
 * Helper: VEO Browser Farm
 * -------------------------------------------------------------------------- */

async function readVeoFarm() {
  const [resi0Res, resi1Res, orchRes, proxyRes] = await Promise.all([
    run("systemctl is-active veo-resi@0.service", 1500),
    run("systemctl is-active veo-resi@1.service", 1500),
    run("systemctl is-active veo-fleet-orch.service", 1500),
    run("systemctl is-active veo-proxy.service", 1500),
  ]);

  const parseStatus = (res: { ok: boolean; stdout: string }): "active" | "inactive" | "failed" | "dead" => {
    const text = res.stdout.trim();
    if (text === "active") return "active";
    if (text === "failed") return "failed";
    if (text === "inactive") return "inactive";
    return "dead";
  };

  const status0 = parseStatus(resi0Res);
  const status1 = parseStatus(resi1Res);

  return {
    workers: [
      {
        id: "veo-resi@0",
        name: "veo-resi@0",
        unit: "veo-resi@0.service",
        proxy_type: "DataImpulse Residential",
        status: status0,
        active: status0 === "active",
        description: "Residential proxy pinned worker 0 (DataImpulse egress)",
      },
      {
        id: "veo-resi@1",
        name: "veo-resi@1",
        unit: "veo-resi@1.service",
        proxy_type: "eduVPN (wg-htwd)",
        status: status1,
        active: status1 === "active",
        description: "Residential / academic egress pinned worker 1 (eduVPN)",
      },
    ],
    orch_active: orchRes.ok && orchRes.stdout.trim() === "active",
    proxy_active: proxyRes.ok && proxyRes.stdout.trim() === "active",
  };
}

/* ----------------------------------------------------------------------------
 * Helper: VPS2 Migration Target
 * -------------------------------------------------------------------------- */

function readVps2Target() {
  return {
    ip: "167.233.145.218",
    hostname: "ubuntu-16gb-nbg1-3-SK",
    location: "Hetzner NBG1",
    specs: "16 GB RAM · AMD EPYC",
    role: "Migration Target",
    status: "restricted" as const,
    ssh_status: "SSH key /root/.ssh/vps2_mgmt revoked (2026-08-06)",
    access_note:
      "Direct command dispatch disabled. Only vps2_monitor backup pipe operational.",
    honest: true,
  };
}

/* ----------------------------------------------------------------------------
 * Route: GET / (Complete Fleet Telemetry)
 * -------------------------------------------------------------------------- */

r.get("/", async (c) => {
  const [
    fleet,
    load,
    mem,
    disks,
    pm2,
    systemd,
    windowsVm,
    veo,
    autonomyData,
    recentDecisions,
  ] = await Promise.all([
    getFleetState(),
    readLoadAvg(),
    readMemInfo(),
    readDisks(),
    readPm2Procs(),
    readSystemdSummary(),
    readWindowsVm(),
    readVeoFarm(),
    getAutonomy().catch(() => null),
    listDecisions(15).catch(() => []),
  ]);

  const hermes = readHermesWorkers();
  const vps2 = readVps2Target();

  const activeRulesCount = autonomyData?.rules?.filter((r) => r.enabled).length ?? 0;
  const categories = autonomyData?.categories ?? [];
  const recentTrips = (autonomyData?.trips ?? []).slice(0, 10).map((t) => ({
    id: t.id,
    rule_id: t.rule_id,
    rule_label: t.rule_label,
    ts: t.ts,
    agent: t.agent,
    attempted_action: t.attempted_action,
    resolved: t.resolved,
  }));

  const decisionLog = recentDecisions.slice(0, 12).map((d) => ({
    ts: new Date(d.ts).toISOString().substring(11, 16),
    kind: d.kind,
    action: d.action,
  }));

  return c.json({
    fleet,
    host: {
      ip: "65.108.6.149",
      hostname: os.hostname(),
      uptime_seconds: Math.round(os.uptime()),
      cpu: load,
      memory: mem,
      disks,
      pm2,
      systemd,
    },
    windows_vm: windowsVm,
    hermes,
    veo,
    vps2,
    invariant: {
      active_rules_count: activeRulesCount,
      categories,
      recent_trips: recentTrips,
      trips_count: autonomyData?.trips?.length ?? 0,
    },
    decisionLog,
  });
});

/* ----------------------------------------------------------------------------
 * Route: POST /freeze & POST /resume
 * -------------------------------------------------------------------------- */

r.post("/freeze", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { actor?: string };
  const actor = body.actor ?? "user";
  const fleet = await setFleetState("paused", actor);
  await appendDecision("freeze", actor, "paused fleet dispatch");
  return c.json({ ok: true, fleet });
});

r.post("/resume", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { actor?: string };
  const actor = body.actor ?? "user";
  const fleet = await setFleetState("running", actor);
  await appendDecision("resume", actor, "resumed fleet dispatch");
  return c.json({ ok: true, fleet });
});

/* ----------------------------------------------------------------------------
 * Route: GET /tmux-tail/:session
 * -------------------------------------------------------------------------- */

r.get("/tmux-tail/:session", async (c) => {
  const session = c.req.param("session");
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
    return c.json({ error: "invalid session name" }, 400);
  }
  const lines = Math.min(100, Math.max(1, Number(c.req.query("lines") ?? "25")));
  const { ok, stdout, stderr } = await run(
    `tmux -S /tmp/tmux-0/default capture-pane -t ${session} -p -S -${lines}`,
    3000,
  );
  if (!ok) {
    return c.json({
      session,
      error: stderr || `tmux session ${session} is currently not attached`,
      lines: [`[No active tmux pane attached for session: ${session}]`],
    });
  }
  return c.json({ session, lines: stdout.split("\n").slice(-lines) });
});

/* ----------------------------------------------------------------------------
 * Route: POST /hermes/restart/:worker_id
 * -------------------------------------------------------------------------- */

r.post("/hermes/restart/:worker_id", async (c) => {
  const wid = c.req.param("worker_id");
  const validWorkers = ["cc-architect", "cc-docs", "cc-writer-01", "sysop-01", "test-02"];
  if (!validWorkers.includes(wid)) {
    return c.json({ error: `Unknown Hermes worker: ${wid}` }, 400);
  }
  await appendDecision("unstick", "user", `Requested restart of Hermes worker ${wid}`);
  return c.json({
    ok: true,
    worker_id: wid,
    message: `Restart requested for Hermes worker ${wid}`,
  });
});

export default r;
