/**
 * serve-quota-7799.ts — a counting stand-in for forge-control, round 1876.
 *
 * Konrad's complaint was that two indicators refreshed on different beats. The
 * fix is structural (one query key, one interval, one fetcher — see
 * `desktop/quota/quotaQuery.ts`), and this is how it gets PROVEN rather than
 * asserted: the web app is built against this port, a real browser opens it,
 * and this server counts how many times /api/usage/quota is actually asked.
 * Two observers on one cache entry must produce ONE request per interval.
 *
 * It answers every route the desktop shell touches on first paint, so the app
 * renders instead of erroring — but only /usage/quota is counted, and the
 * counter is readable at /__hits.
 *
 * Nothing here touches live services: it is a throwaway on :7799.
 *
 *   forge-control/node_modules/.bin/tsx scripts/checks/serve-quota-7799.ts
 */

import { createServer } from "node:http";

const PORT = Number(process.env.QUOTA_STUB_PORT ?? 7799);

const hits: Record<string, number> = {};
/** Every quota request with the millisecond it arrived — the gaps between them
 *  are the cadence, and a second component polling on its own timer shows up
 *  as a pair of near-simultaneous entries. */
const quotaAt: number[] = [];
const started = Date.now();

function json(body: unknown): [string, Record<string, string>] {
  return [
    JSON.stringify(body),
    { "content-type": "application/json", "access-control-allow-origin": "*" },
  ];
}

const QUOTA = {
  five_hour: { utilization: 41, resets_at: new Date(Date.now() + 42 * 60_000).toISOString() },
  seven_day: { utilization: 12, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
  seven_day_opus: null,
  fetched_at: new Date().toISOString(),
  cached: false,
  gemini: {
    cli_installed: false,
    cli_profile: false,
    auth_note:
      "Antigravity CLI (agy) is not installed on this box, so the Ultra subscription has never been signed in here.",
    connect_command: "install the Antigravity CLI, then run `agy` once to sign in",
    five_hour: { calls: 0, tokens: null },
    seven_day: { calls: 0, tokens: null },
    no_limit_note:
      "Google publishes no quota endpoint for an AI Ultra subscription — no denominator exists, so this is our own count, not a share of a limit.",
  },
};

/** The Gemini tally in its counted state, for the second screenshot. Selected
 *  with ?gemini=counted on the stub, so both states can be photographed
 *  without inventing a second build. */
const QUOTA_COUNTED = {
  ...QUOTA,
  gemini: {
    ...QUOTA.gemini,
    cli_installed: true,
    cli_profile: true,
    auth_note:
      "agy has a local profile; the session lives in the OS keyring and cannot be read from here, so this is still our own count.",
    connect_command: null,
    five_hour: { calls: 4, tokens: 12_400 },
    seven_day: { calls: 31, tokens: 208_000 },
  },
};

let geminiMode: "unsigned" | "counted" = "unsigned";

const ACCOUNTS = {
  accounts: [
    {
      slug: "konrad-max",
      config_dir: "/root/.claude",
      login_email: "konrad.schrein@gmail.com",
      plan_label: "Max 20x",
      priority: 1,
      enabled: true,
      health: "healthy",
      health_detail: "confirmed by a run 4m ago",
      has_refresh: true,
      access_expires_at: null,
      last_probed_at: new Date(Date.now() - 240_000).toISOString(),
      last_ok_at: new Date(Date.now() - 240_000).toISOString(),
      last_error: null,
      reauth_command: "CLAUDE_CONFIG_DIR=/root/.claude claude /login",
    },
    {
      slug: "konrad-pro",
      config_dir: "/root/.claude-pro",
      login_email: null,
      plan_label: null,
      priority: 2,
      enabled: true,
      health: "unknown",
      health_detail: null,
      has_refresh: null,
      access_expires_at: null,
      last_probed_at: null,
      last_ok_at: null,
      last_error: null,
      reauth_command: "CLAUDE_CONFIG_DIR=/root/.claude-pro claude /login",
    },
  ],
  summary: { total: 2, enabled: 2, healthy: 1, unknown: 1, broken: 0, usable: 2, serving: "konrad-max" },
  policy: {
    mode: "priority",
    description: "Runs go to the healthy account with the lowest priority number; a broken one is skipped until a probe clears it.",
  },
};

/** One chat, so the row can be photographed with a context gauge in it. The
 *  gauge reads `metadata.usage_running` (input + cache_read of the LAST
 *  assistant turn) against the model's window — 126k of a 200k window here,
 *  i.e. the 63% that appears in the screenshot. */
const CHAT_ID = "bfd1283a-b71b-4f35-b577-7d09aad803f2";
const CHAT_RUN = {
  id: CHAT_ID,
  title: "operator",
  status: "completed",
  role: "chat",
  model: "claude-opus-5",
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  updated_at: new Date(Date.now() - 120_000).toISOString(),
  started_at: new Date(Date.now() - 3_600_000).toISOString(),
  completed_at: new Date(Date.now() - 120_000).toISOString(),
  archived: false,
  parent_run_id: null,
  stuck_signal: null,
  prompt: "hello",
  thread: [
    {
      role: "user",
      kind: "text",
      content: "how full is this chat's context?",
      ts: new Date(Date.now() - 300_000).toISOString(),
      meta: {},
    },
    {
      role: "assistant",
      kind: "text",
      content: "Look at the ctx gauge in the status bar.",
      ts: new Date(Date.now() - 120_000).toISOString(),
      meta: {},
    },
  ],
  subagents_v2: [],
  usage_total: { input_tokens: 6_000, output_tokens: 400, cache_read_input_tokens: 120_000 },
  metadata: {
    model_resolved: "claude-opus-5",
    usage_running: { input_tokens: 6_000, cache_read_input_tokens: 120_000 },
  },
};

const ROUTES: Record<string, unknown> = {
  "/api/chat": {
    count: 1,
    runs: [CHAT_RUN],
    counts: { running: 0, completed: 1, failed: 0, cancelled: 0, queued: 0 },
    hasMore: false,
  },
  [`/api/chat/${CHAT_ID}`]: { run: CHAT_RUN },
  [`/api/chat/${CHAT_ID}/linkage`]: { project: null, tasks: [] },
  /* Shapes from team/planApi.ts + team/teamApi.ts. The panels THROW rather
   * than degrade on a thin payload — deliberately, so a broken server and an
   * empty project never look alike — which a hand-waved `{}` here proved by
   * crashing the chat surface with "e.phases is not iterable". */
  [`/api/chat/${CHAT_ID}/plan`]: {
    chat_id: CHAT_ID,
    project: null,
    link_source: null,
    link_ambiguous: false,
    phases: [],
    docs: [],
  },
  [`/api/chat/${CHAT_ID}/team`]: {
    chat_id: CHAT_ID,
    now: new Date().toISOString(),
    project: null,
    link_source: null,
    link_ambiguous: false,
    candidates: [],
    manager: {
      id: CHAT_ID,
      kind: "run",
      role: "chat",
      title: "operator",
      status: "completed",
      model: "claude-opus-5",
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      updated_at: new Date(Date.now() - 120_000).toISOString(),
      settled_at: new Date(Date.now() - 120_000).toISOString(),
      dismissed_at: null,
      subagents: [],
      task: null,
    },
    workers: [],
    complete: true,
    errors: [],
  },
  "/api/capabilities": {
    control_plane: {
      message_into_session: false,
      resume_finished: false,
      stop: false,
      terminate: false,
    },
  },
  "/api/accounts": ACCOUNTS,
  "/api/integrations/gemini": {
    key: { present: false, masked: null, stored_at: null, bytes: null, path: "/root/.forge/secrets/gemini_api_key" },
    default_model: "gemini-3.7-flash",
    pool: { url: "http://127.0.0.1:8090", role: "free default path" },
    api_role: "higher-quality opt-in",
  },
  "/api/integrations/gemini/usage": {
    counted: false,
    lookback_days: 30,
    providers: [],
    totals: { rows_5h: 0, eur_5h: 0, rows_7d: 0, eur_7d: 0 },
    why_empty: "Nothing on this box posts a gemini row to /api/spend yet.",
    basis: "our own spend_log rows where provider ILIKE 'gemini%'.",
  },
  "/api/integrations/google": {
    accounts: [
      {
        id: "google-0",
        email: null,
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/drive",
        ],
        has_refresh_token: true,
        client_id: "904113079984-example.apps.googleusercontent.com",
        connected_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
        access_expires_at: null,
        token_path: "/root/.hermes/google_token.json",
      },
    ],
    last_check: null,
    reauth: {
      command: "python3 /opt/ai-os/google-setup/setup.py",
      interactive: true,
      why: "setup.py blocks on a localhost:8765 redirect, so it needs a human at a browser.",
    },
  },
  "/api/today": { date: "2026-08-17", greeting: "", chips: [], needs: [], fleet: [], spend: { value: "", cap: "" }, shipped: { value: "", pipeline: "" } },
  "/api/inbox": { items: [] },
  /* Shapes copied from `emptyLive` / `emptyControl` in app/api.ts — the shell
   * reads `control.fleet.status` and would crash on a thinner stand-in, which
   * is exactly what a made-up stub payload did on the first run of this. */
  "/api/live": { stats: [], degradation: [], providers: [] },
  "/api/control": {
    fleet: { status: "running", updated_at: new Date().toISOString(), updated_by: "system" },
    loops: [],
    invariant: { label: "Invariant engine", sub: "5 hard rules · enforced pre-dispatch" },
    decisionLog: [],
  },
  "/api/agents": { agents: [], managers: [] },
  "/api/projects/managers": { managers: [] },
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  hits[path] = (hits[path] ?? 0) + 1;

  if (path === "/__hits") {
    const [body, headers] = json({
      uptime_ms: Date.now() - started,
      quota_requests: quotaAt.length,
      quota_at_ms: quotaAt.map((t) => t - started),
      gaps_ms: quotaAt.slice(1).map((t, i) => t - quotaAt[i]),
      all: hits,
    });
    res.writeHead(200, headers).end(body);
    return;
  }
  if (path === "/__gemini") {
    geminiMode = url.searchParams.get("mode") === "counted" ? "counted" : "unsigned";
    const [body, headers] = json({ mode: geminiMode });
    res.writeHead(200, headers).end(body);
    return;
  }

  if (path === "/api/usage/quota") {
    quotaAt.push(Date.now());
    const snap = geminiMode === "counted" ? QUOTA_COUNTED : QUOTA;
    const [body, headers] = json({ ...snap, fetched_at: new Date().toISOString() });
    res.writeHead(200, headers).end(body);
    return;
  }

  /* A SUPERSET default for everything not named above. The shell's panels
   * throw rather than degrade on a missing collection (by design — an empty
   * project and a broken server must not look alike), so a stub that answers
   * `{}` takes the surface down with an error boundary instead of showing the
   * status bar this run exists to photograph. Naming every key the desktop's
   * first paint iterates over is cheaper than discovering them one crash at a
   * time. */
  const known = ROUTES[path];
  const [body, headers] = json(
    known ?? {
      items: [],
      accounts: [],
      agents: [],
      managers: [],
      runs: [],
      rows: [],
      workers: [],
      errors: [],
      phases: [],
      docs: [],
      peers: [],
      events: [],
      total: 0,
      count: 0,
      hasMore: false,
      complete: true,
    },
  );
  res.writeHead(200, headers).end(body);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`quota stub on http://127.0.0.1:${PORT} — counter at /__hits`);
});
