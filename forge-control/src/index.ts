import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { startProbeLoop } from "./lib/accounts.ts";
import health from "./routes/health.ts";
import hermes from "./routes/hermes.ts";
import pm2 from "./routes/pm2.ts";
import systemd from "./routes/systemd.ts";
import forge from "./routes/forge.ts";
import system from "./routes/system.ts";
import inbox from "./routes/inbox.ts";
import fleet from "./routes/fleet.ts";
import agents from "./routes/agents.ts";
import accounts from "./routes/accounts.ts";
import ledger from "./routes/ledger.ts";
import entities from "./routes/entities.ts";
import secrets from "./routes/secrets.ts";
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
import canvas from "./routes/canvas.ts";
import usage from "./routes/usage.ts";
import reminders from "./routes/reminders.ts";
import uploads from "./routes/uploads.ts";
import files from "./routes/files.ts";
import projects from "./routes/projects.ts";
import capabilities from "./routes/capabilities.ts";
import tasks from "./routes/tasks.ts";
import integrations from "./routes/integrations.ts";
import daily from "./routes/daily.ts";
import terminal from "./routes/terminal.ts";
import map from "./routes/map.ts";
import { startCronTick } from "./lib/cron-tick.ts";
import { startTelegramBridge } from "./lib/telegram-bridge.ts";
import { startVaultSyncTick } from "./lib/vault-sync-tick.ts";
import { startUsageSamplerTick } from "./lib/usage-sampler.ts";
import mentor from "./routes/mentor.ts";
import runControl from "./routes/run-control.ts";

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
  // PUT is here for /api/usage/rate and DELETE for /api/integrations/gemini/key
  // — without them the browser's preflight rejects the write and the setting is
  // only changeable by curl. The web UI reaches the API through a same-origin
  // Next rewrite and so never preflights, but any other origin (the :7701
  // mobile UI, Tailscale) does, and a verb the router exposes must be a verb
  // CORS admits.
  c.res.headers.set(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS",
  );
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
      "/api/agents",
      "/api/agents/:id",
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
      "/api/projects/managers",
      "/api/projects/:id",
      "/api/projects/:id/tasks",
      "/api/projects/:id/status",
      "/api/projects/:id/unwedge",
      "/api/tasks/:id",
      "/api/tasks/:id/retry",
      "/api/usage/quota",
      "/api/usage/series",
      "/api/usage/rate (GET, PUT)",
      "/api/map (?only=businesses,processes,units,domains,storage,canvases)",
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
app.route("/api/agents", agents);
app.route("/api/accounts", accounts);
app.route("/api/ledger", ledger);
app.route("/api/entities", entities);
app.route("/api/secrets", secrets);
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

// v2.6: Excalidraw canvases — visual brainstorming over the same
// .excalidraw.md files Obsidian reads/writes.
app.route("/api/canvas", canvas);

// v2.7: subscription quota (5-hour + 7-day windows) for the status bar.
app.route("/api/usage", usage);

// v2.1: chat attachments (drag & drop / paste).
app.route("/api/uploads", uploads);
app.route("/api/files", files);

// v2.2: mentor accountability metrics (evening mentor POSTs, Today reads).
app.route("/api/mentor", mentor);

// v2.5: coding projects — multi-agent dev work (architect/planner/scout/
// builder/reviewer) on top of the runs engine. Stage advancement runs
// inside forge-executor's manager loop (lib/project-tick.ts), not here.
app.route("/api/projects", projects);
// UI v3 (U8): static feature-detection for control-plane actions the engine
// doesn't support yet. See routes/capabilities.ts for the contract source.
app.route("/api/capabilities", capabilities);
// Project-task recovery (retry a failed task without SQL). Separate router
// because Step 11 of the execution-layer redesign grows /api/tasks into the
// unified dispatch verb.
app.route("/api/tasks", tasks);
// Round 1350: outside services — the Gemini API key (secret store, never the
// DB) and the existing Gmail/Calendar/Drive Google consent.
app.route("/api/integrations", integrations);
// The Daily system (docs/SPEC-DAILY-SURFACE.md): evening plan, tasks, habits,
// day score. Backs the GOALS/TASKS surface that replaced the placeholder.
app.route("/api/daily", daily);
app.route("/api/terminal", terminal);
// The MAP surface's aggregator: businesses (vault), PM2, systemd, nginx
// ingress, storage/datastores and planning canvases in one payload, each
// section independently error-isolated. See routes/map.ts.
app.route("/api/map", map);
// Inbound webhook receiver: external services hit /webhooks/in/:slug directly.
// NOT under /api so the CORS preflight middleware above doesn't affect it.
app.route("/webhooks", webhookIn);
app.route("/api/runs", runControl);

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

// 2026-08-02: Claude account health probing. Cheap tier (credential file +
// last confirmed run) every 10 minutes. This is the half of the account system
// that would actually have prevented the 2026-08-02 outage — an account died in
// June and nothing noticed until August.
startProbeLoop();

// Round 1350: close each past hour into `usage_hourly` so the usage panel
// reads a pre-aggregated table instead of folding `runs` on every poll.
// USAGE_SAMPLER=0 disables it; the endpoints then serve whatever is on record.
startUsageSamplerTick();
