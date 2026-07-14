import { Hono } from "hono";
import { serve } from "@hono/node-server";
import health from "./routes/health.ts";
import hermes from "./routes/hermes.ts";
import pm2 from "./routes/pm2.ts";
import systemd from "./routes/systemd.ts";
import forge from "./routes/forge.ts";
import system from "./routes/system.ts";
import inbox from "./routes/inbox.ts";
import fleet from "./routes/fleet.ts";
import decisions from "./routes/decisions.ts";
import today from "./routes/today.ts";
import live from "./routes/live.ts";
import control from "./routes/control.ts";
import memory from "./routes/memory.ts";
import search from "./routes/search.ts";
import chat from "./routes/chat.ts";
import skills from "./routes/skills.ts";
import pipeline from "./routes/pipeline.ts";
import autonomy from "./routes/autonomy.ts";
import media from "./routes/media.ts";
import webhooks from "./routes/webhooks.ts";
import webhookIn from "./routes/webhook-in.ts";
import cron from "./routes/cron.ts";
import spend from "./routes/spend.ts";
import vault from "./routes/vault.ts";
import reminders from "./routes/reminders.ts";
import uploads from "./routes/uploads.ts";
import files from "./routes/files.ts";
import projects from "./routes/projects.ts";
import { startCronTick } from "./lib/cron-tick.ts";
import { startTelegramBridge } from "./lib/telegram-bridge.ts";
import { startVaultSyncTick } from "./lib/vault-sync-tick.ts";
import mentor from "./routes/mentor.ts";

const app = new Hono();

app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  console.log(
    `[${new Date().toISOString()}] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms`,
  );
});

// Permissive CORS for the local mobile UI on :7701 and Tailscale traffic.
app.use("/api/*", async (c, next) => {
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "content-type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/", (c) =>
  c.json({
    name: "forge-control",
    version: "0.2.0",
    docs: "See SPEC-AI-OS-INTERFACE.md",
    endpoints: [
      "/api/health",
      // Infra introspection
      "/api/hermes/workers",
      "/api/hermes/heartbeats/:worker_id",
      "/api/hermes/events",
      "/api/hermes/tasks",
      "/api/hermes/tmux-tail/:session",
      "/api/pm2/list",
      "/api/systemd/units",
      "/api/forge/health",
      "/api/forge/jobs?scope=active|all&limit=N",
      "/api/forge/jobs/by-status",
      "/api/forge/jobs/:id",
      "/api/system/stats",
      // AI OS surfaces (forge-control-web mobile)
      "/api/today",
      "/api/inbox",
      "/api/inbox/:id/resolve",
      "/api/live",
      "/api/control",
      "/api/fleet",
      "/api/fleet/freeze",
      "/api/fleet/resume",
      "/api/decisions",
      "/api/memory",
      "/api/memory/search?q=...",
      "/api/memory/:slug",
      "/api/search?q=...",
      "/api/chat",
      "/api/chat/:id",
      "/api/chat/:id/message",
      "/api/chat/:id/status",
      "/api/skills",
      "/api/skills/:id",
      "/api/pipeline",
      "/api/autonomy",
      "/api/autonomy/rules/:id",
      "/api/spend (POST rows from gateways)",
      "/api/spend/today",
      "/api/chat/:id/events (SSE)",
      "/api/vault/append",
      "/api/vault/note",
      "/api/vault/daily",
      "/api/reminders",
      "/api/reminders/:id/dismiss",
      "/api/projects",
      "/api/projects/board",
      "/api/projects/:id",
      "/api/projects/:id/tasks",
      "/api/projects/:id/status",
    ],
  }),
);

app.route("/api/health", health);
app.route("/api/hermes", hermes);
app.route("/api/pm2", pm2);
app.route("/api/systemd", systemd);
app.route("/api/forge", forge);
app.route("/api/system", system);

// AI OS surfaces
app.route("/api/today", today);
app.route("/api/inbox", inbox);
app.route("/api/live", live);
app.route("/api/control", control);
app.route("/api/fleet", fleet);
app.route("/api/decisions", decisions);
app.route("/api/memory", memory);
app.route("/api/search", search);
app.route("/api/chat", chat);
app.route("/api/skills", skills);
app.route("/api/pipeline", pipeline);
app.route("/api/autonomy", autonomy);
app.route("/api/media", media);

// v1.6 Tier-2 phase 4
app.route("/api/webhooks", webhooks);
app.route("/api/cron", cron);

// v1.9: honest cost tracking — gateways POST, Today + autonomy read.
app.route("/api/spend", spend);

// v2.0: Obsidian write path + reminders (quick capture, life OS).
app.route("/api/vault", vault);
app.route("/api/reminders", reminders);

// v2.1: chat attachments (drag & drop / paste).
app.route("/api/uploads", uploads);
app.route("/api/files", files);

// v2.2: mentor accountability metrics (evening mentor POSTs, Today reads).
app.route("/api/mentor", mentor);

// v2.5: coding projects — multi-agent dev work (architect/planner/scout/
// builder/reviewer) on top of the runs engine. Stage advancement runs
// inside forge-executor's manager loop (lib/project-tick.ts), not here.
app.route("/api/projects", projects);
// Inbound webhook receiver: external services hit /webhooks/in/:slug directly.
// NOT under /api so the CORS preflight middleware above doesn't affect it.
app.route("/webhooks", webhookIn);

const port = Number(process.env.PORT ?? 7700);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`forge-control listening on 127.0.0.1:${port}`);

// v1.6 Tier-2 phase 4: cron scheduler tick. Single in-process scheduler is
// fine for personal scale; multi-instance is safe thanks to FOR UPDATE SKIP
// LOCKED in claimDueSchedules().
startCronTick();

// v2.2: Telegram bridge (VPS Cat). Inbound long poll + outbound push drain.
startTelegramBridge();

// Keeps hcp.knowledge_note in sync with the real on-disk Obsidian vault —
// km-indexer.js only ever wrote embeddings, never the note registry.
startVaultSyncTick();
