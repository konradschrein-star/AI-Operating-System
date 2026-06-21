import { Hono } from "hono";
import {
  listWorkers,
  latestHeartbeatPerWorker,
  heartbeatsFor,
  recentEvents,
  recentTasks,
} from "../db/hermes.ts";
import { run } from "../lib/exec.ts";

const r = new Hono();

r.get("/workers", (c) => {
  const workers = listWorkers();
  const heartbeats = latestHeartbeatPerWorker();
  const hbByWorker = new Map(heartbeats.map((h) => [h.worker_id, h]));
  return c.json({
    workers: workers.map((w) => ({
      ...w,
      latest_heartbeat: hbByWorker.get(w.id) ?? null,
    })),
    counts: {
      running: workers.filter((w) => w.status === "running").length,
      dead: workers.filter((w) => w.status === "dead").length,
      stopped: workers.filter((w) => w.status === "stopped").length,
      suspected: workers.filter((w) => w.status === "suspected").length,
      total: workers.length,
    },
  });
});

r.get("/heartbeats/:worker_id", (c) => {
  const wid = c.req.param("worker_id");
  const limit = Number(c.req.query("limit") ?? "50");
  return c.json({ worker_id: wid, heartbeats: heartbeatsFor(wid, limit) });
});

r.get("/events", (c) =>
  c.json({ events: recentEvents(Number(c.req.query("limit") ?? "100")) }),
);
r.get("/tasks", (c) =>
  c.json({ tasks: recentTasks(Number(c.req.query("limit") ?? "50")) }),
);

r.get("/tmux-tail/:session", async (c) => {
  const session = c.req.param("session");
  if (!/^cc-[a-zA-Z0-9_-]+$/.test(session)) {
    return c.json({ error: "invalid session name" }, 400);
  }
  const lines = Number(c.req.query("lines") ?? "20");
  const { ok, stdout, stderr } = await run(
    `tmux -S /tmp/tmux-0/default capture-pane -t ${session} -p -S -${lines}`,
    3000,
  );
  if (!ok) return c.json({ session, error: stderr || "tmux call failed" }, 502);
  return c.json({ session, lines: stdout.split("\n").slice(-lines) });
});

export default r;
