#!/usr/bin/env node
/**
 * stub-pipeline.mjs — the FLIP TEST's payload server (phase 5, task 4).
 *
 * WHY THIS EXISTS. R64 has two halves and only one of them can be measured
 * against the live database:
 *
 *   half A  the five QC jobs, stuck 11–14 days, render as STALLED;
 *   half B  a FRESH job renders as NOT stalled.
 *
 * Without half B, an assertion that five stuck jobs render stalled also passes
 * on a component that marks EVERYTHING stalled — which is exactly the mutation
 * that broke the server-side tests in pipeline-api-evidence.md § CMD-7. And
 * there is no fresh job to point at: `content_jobs` holds 24 rows, 19
 * MARKED_FOR_DELETION and 5 aged 11–14 days (premises-remeasured.md § P2), and
 * R68 forbids creating one.
 *
 * So this serves a crafted `BusinessPipelineResponse` containing BOTH halves at
 * once, plus one phase in each of the three `state` values, plus both probes
 * failing — the four things live data cannot show simultaneously:
 *
 *   • qc      has_work                 — 1 FRESH job (top) + 5 STALLED, 11–14d
 *   • idea    no_work_idle             — empty because nothing was started
 *   • publish no_work_blocked_upstream — empty because work is stuck upstream
 *   • workers { ok: false, error }     — must render "worker health unavailable: <err>"
 *   • queues  { ok: false, error }     — must render "queue not reachable: <err>"
 *
 * The five stalled jobs are the real ones, ids and titles copied from CMD-9 in
 * pipeline-api-evidence.md, so the stub shot and the live shot are comparable
 * card for card. The FRESH job is visibly synthetic (`STUB_FRESH_…`) — a stub
 * that could be mistaken for production data is worse than no stub.
 *
 * `status_updated_at` for the fresh job is computed PER REQUEST, so it is
 * always minutes old no matter when this file is run. The stalled dates are
 * fixed, which means their `stall_days` grow over time; that is correct — they
 * are real timestamps from a real table.
 *
 *   USAGE
 *     node docs/plan/artifacts/os-usable-for-work/phase5/stub-pipeline.mjs
 *     STUB_PIPELINE_PORT=7843 node …/stub-pipeline.mjs
 *
 *   Then point the web build's proxy at it — the rewrite is BAKED AT BUILD
 *   (next.config.mjs reads FORGE_CONTROL_URL inside rewrites()), so either
 *   rebuild with FORGE_CONTROL_URL=http://127.0.0.1:7843 or patch
 *   .next/routes-manifest.json and restart `next start`. Both modes are
 *   written out in phase5/browser-harness.md § 2 and in phase5/flip-test.md.
 *
 * Everything that is not GET /api/pipeline proxies to :7700 unchanged, because
 * the desktop shell needs its session and its other polls to render at all.
 * The proxy is buffered — no SSE — same limitation as serve-pipeline.ts, and
 * this surface needs no stream.
 *
 * READ-ONLY: this file opens no database and runs no pm2 or redis command.
 */

import { createServer } from "node:http";

const PORT = ((raw) => {
  if (raw === undefined || raw === "") return 7843;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`STUB_PIPELINE_PORT must be an integer in [1024,65535]; got ${JSON.stringify(raw)}`);
  }
  return n;
})(process.env.STUB_PIPELINE_PORT);

const HOST = "127.0.0.1";
const UPSTREAM = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";
const THRESHOLD_HOURS = 48;

/** The five real AWAITING_* rows, verbatim from pipeline-api-evidence.md CMD-9. */
const STALLED = [
  ["c65abcfe-a6cc-465a-bd78-368c5dbfbb0d", "MacBook Air M3 vs Dell XPS 15", "AWAITING_UPLOADER", "TECH_COMPARISON", "Content Forge Main", "Comparison X vs Y — Software", "2026-08-06 21:50:26.252+00"],
  ["75c0cbe8-ed38-48b0-9b26-8e1c591f10c5", "Best budget standing desks under 400", "AWAITING_UPLOADER", "RANKING", "Blink Blueprint", "Ranking Default", "2026-08-05 21:26:34.847+00"],
  ["bd4bfd38-bf92-4b0f-8fda-145e5feb72f5", "Best budget mechanical keyboards under 150", "AWAITING_UPLOADER", "RANKING", "Blink Blueprint", "Ranking Default", "2026-08-05 20:37:24.549+00"],
  ["6a9341e6-ef76-4735-b92b-54f5eb26a34d", "Best Speakers 2026 below 100$", "AWAITING_QC", "RANKING", "Your VirtualFD", "Ranking Default", "2026-08-04 11:53:01.457+00"],
  ["797bc9b0-44e7-43dc-a187-6d1fd5732816", "Best noise cancelling headphones under 300", "AWAITING_UPLOADER", "RANKING", "Blink Blueprint", "Ranking Default", "2026-08-04 01:01:34.885+00"],
];

/** `humanAge()` from forge-control/src/db/pipeline.ts:182, so the stub's `age`
 *  strings are produced by the same rules the server would apply. */
function humanAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function card(id, title, status, format, channel, template, updated, now) {
  const ageMs = now - new Date(updated).getTime();
  return {
    id,
    title,
    status,
    format,
    channel,
    template,
    age: humanAge(ageMs),
    updated_at: updated,
    status_updated_at: updated,
    stalled: ageMs > THRESHOLD_HOURS * 3_600_000,
    stall_days: Math.floor(ageMs / 86_400_000),
  };
}

function phase(key, label, description, statuses, cards, state, state_reason) {
  return {
    key,
    label,
    description,
    statuses,
    count: cards.length,
    stalled_count: cards.filter((c) => c.stalled).length,
    state,
    state_reason,
    cards,
    cards_truncated: false,
  };
}

function payload() {
  const now = Date.now();
  // THE FLIP. Three minutes old, every request. Same shape as its neighbours,
  // opposite verdict — that is the whole experiment.
  const fresh = card(
    "STUB_FRESH_00000000-0000-4000-8000-000000000001",
    "STUB — a job whose status changed three minutes ago",
    "AWAITING_QC",
    "RANKING",
    "Stub Channel",
    "Ranking Default",
    new Date(now - 3 * 60_000).toISOString(),
    now,
  );
  const stalled = STALLED.map((r) => card(r[0], r[1], r[2], r[3], r[4], r[5], r[6], now));
  const qcCards = [fresh, ...stalled];
  const idle = (label) =>
    `Nothing in ${label}, and nothing in any earlier phase — idle, not blocked.`;
  const blocked = (label) =>
    `Nothing in ${label} — 6 jobs held further up, in QC (6). This column is empty because work is stuck, not because there is none.`;

  const phases = [
    phase("idea", "Idea", "Topic + brief, pre-script", [], [], "no_work_idle",
      "Nothing in Idea, and it is the first phase — no work has been created."),
    phase("script", "Script", "Scripting → script ready", [], [], "no_work_idle", idle("Script")),
    phase("voice", "Voice", "TTS generation", [], [], "no_work_idle", idle("Voice")),
    phase("assets", "Assets", "Image / clip / asset collection", [], [], "no_work_idle", idle("Assets")),
    phase("qc", "QC", "QMS validation + manual gates", ["AWAITING_QC", "AWAITING_UPLOADER"],
      qcCards, "has_work", "6 jobs in QC."),
    phase("render", "Render", "Routing + render + stitch", [], [], "no_work_blocked_upstream", blocked("Render")),
    phase("publish", "Publish", "Uploader → published", [], [], "no_work_blocked_upstream", blocked("Publish")),
  ];

  return {
    as_of: new Date(now).toISOString(),
    stall_threshold_hours: THRESHOLD_HOURS,
    stall_cutoff: new Date(now - THRESHOLD_HOURS * 3_600_000).toISOString(),
    phases,
    total: qcCards.length,
    stalled_total: qcCards.filter((c) => c.stalled).length,
    card_limit_per_phase: 20,
    card_query_limit: 500,
    card_rows_scanned: qcCards.length,
    // Both probes DOWN, deliberately. The live shot proves the ok:true render;
    // only a stub can prove that a dead probe renders as dead and not as zero.
    workers: {
      ok: false,
      as_of: new Date(now).toISOString(),
      expected: ["worker-orchestrator", "worker-render", "worker-video-stitch", "claude-pool"],
      error: "[PM2][ERROR] Daemon not running / connection refused",
    },
    queues: {
      ok: false,
      as_of: new Date(now).toISOString(),
      endpoint: "127.0.0.1:6399",
      error: "connect ECONNREFUSED 127.0.0.1:6399",
    },
  };
}

const STRIPPED = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host"]);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/api/pipeline") {
      res.writeHead(200, { "content-type": "application/json", "x-phase5-stub": "flip-test" });
      res.end(JSON.stringify(payload()));
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || STRIPPED.has(k.toLowerCase())) continue;
      for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const upstream = await fetch(`${UPSTREAM}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      upstream.headers.forEach((value, key) => {
        if (!STRIPPED.has(key.toLowerCase())) out[key] = value;
      });
      res.writeHead(upstream.status, out);
      res.end(body);
    } catch (err) {
      // Loud, never an empty 200 — a harness that lies about the API under test
      // is worse than no harness.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[stub] proxy ${req.method} ${req.url} → ${UPSTREAM} failed: ${message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub proxy failed", upstream: UPSTREAM, path: req.url, message }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  const p = payload();
  console.log(`[stub] GET /api/pipeline → crafted flip-test payload on http://${HOST}:${PORT}`);
  console.log(`[stub]   total=${p.total} stalled_total=${p.stalled_total} (1 fresh, ${p.stalled_total} stalled)`);
  console.log(`[stub]   states=${[...new Set(p.phases.map((x) => x.state))].join(", ")}`);
  console.log(`[stub]   workers.ok=${p.workers.ok} queues.ok=${p.queues.ok}`);
  console.log(`[stub] everything else proxies (buffered, no SSE) to ${UPSTREAM}`);
});
