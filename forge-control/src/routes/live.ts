import { Hono } from "hono";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listOpenInbox } from "../db/ai_os.ts";
import { getProviderHealth, type ProviderStatus } from "../lib/provider-health.ts";
import { readCredentialSnapshot } from "../lib/accounts.ts";
import {
  AGY_BIN,
  AGY_PROBE_ARGS,
  runCommand,
} from "../lib/connection-status.ts";
import { run } from "../lib/exec.ts";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:content_forge_prod@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e) => console.error("[live pg pool]", e.message));

const r = new Hono();

interface RunsRollup {
  active_agents: number;
  active_subagents: number;
  queued: number;
  stuck: number;
  paused: number;
}

async function getRunsRollup(): Promise<RunsRollup> {
  try {
    const res = await pool.query<{
      active_root: string;
      active_subagents: string;
      active_total: string;
      queued: string;
      stuck: string;
      paused: string;
    }>(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'running' AND parent_run_id IS NULL)::text AS active_root,
          COUNT(*) FILTER (WHERE status = 'running' AND parent_run_id IS NOT NULL)::text AS active_subagents,
          COUNT(*) FILTER (WHERE status = 'running')::text AS active_total,
          COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
          COUNT(*) FILTER (WHERE status = 'stuck')::text AS stuck,
          COUNT(*) FILTER (WHERE status = 'paused')::text AS paused
         FROM runs
        WHERE archived = false`,
    );
    const row = res.rows[0];
    if (!row) {
      return { active_agents: 0, active_subagents: 0, queued: 0, stuck: 0, paused: 0 };
    }
    return {
      active_agents: Number(row.active_root || "0"),
      active_subagents: Number(row.active_subagents || "0"),
      queued: Number(row.queued || "0"),
      stuck: Number(row.stuck || "0"),
      paused: Number(row.paused || "0"),
    };
  } catch (e) {
    console.error("[live] failed to query runs rollup:", e);
    return { active_agents: 0, active_subagents: 0, queued: 0, stuck: 0, paused: 0 };
  }
}

/**
 * Live screen state. Real active and queued runs come from PostgreSQL `runs`;
 * providers + degradation come from the HTTP probe layer (`lib/provider-health.ts`).
 */
r.get("/", async (c) => {
  const [runsRollup, inbox, providerHealth] = await Promise.all([
    getRunsRollup(),
    listOpenInbox(500).catch(() => []),
    getProviderHealth(),
  ]);

  const stuckInbox = inbox.filter(
    (i) => i.status === "STUCK" || i.status === "BLEED",
  ).length;
  const totalStuck = runsRollup.stuck + stuckInbox;

  // Provider table for the bottom of the Live screen
  const providers = providerHealth.map((p: ProviderStatus) => ({
    name: p.name,
    badge: p.badge,
    status: p.status,
  }));

  // Degradation list only includes non-ok services
  const degradation = providerHealth
    .filter((p: ProviderStatus) => p.status !== "ok")
    .map((p: ProviderStatus) => ({
      svc: p.name,
      why: p.why ?? p.badge,
      tier: p.tier,
    }));

  return c.json({
    stats: [
      { label: "ACTIVE AGENTS", value: String(runsRollup.active_agents), tone: "neutral" },
      { label: "SUBAGENTS", value: String(runsRollup.active_subagents), tone: "accent" },
      { label: "QUEUED", value: String(runsRollup.queued), tone: "soft" },
      { label: "STUCK", value: String(totalStuck), tone: totalStuck > 0 ? "stuck" : "neutral" },
    ],
    degradation,
    providers,
  });
});

/* ----------------------------------------------------------------------------
 * Quick Check (⚡ Check Everything — concurrent probe in <2s)
 * -------------------------------------------------------------------------- */

interface SubsystemCheck {
  status: "ok" | "warn" | "error";
  latency_ms: number;
  detail: string;
  [key: string]: unknown;
}

async function checkPostgres(): Promise<SubsystemCheck> {
  const t0 = Date.now();
  try {
    await pool.query("SELECT 1");
    const ms = Date.now() - t0;
    return { status: "ok", latency_ms: ms, detail: `Connected to content_forge (${ms}ms)` };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkClaudeOAuth(): Promise<SubsystemCheck> {
  const t0 = Date.now();
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || "/root/.claude";
    const snap = await readCredentialSnapshot(configDir);
    const ms = Date.now() - t0;
    if (!snap.exists) {
      return { status: "warn", latency_ms: ms, detail: `No credentials file in ${configDir}` };
    }
    if (!snap.parseable) {
      return { status: "error", latency_ms: ms, detail: "Malformed credentials.json" };
    }
    if (snap.hasAccessToken) {
      const isExpired = snap.expiresAt != null && snap.expiresAt < Date.now();
      if (isExpired && !snap.hasRefreshToken) {
        return { status: "error", latency_ms: ms, detail: "Access token expired, no refresh token" };
      }
      return {
        status: "ok",
        latency_ms: ms,
        detail: isExpired ? "Access token expired (refresh token ready)" : "OAuth authenticated",
      };
    }
    if (snap.hasRefreshToken) {
      return { status: "ok", latency_ms: ms, detail: "OAuth authenticated (refresh token present)" };
    }
    return { status: "warn", latency_ms: ms, detail: "No access or refresh token found" };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGeminiCli(): Promise<SubsystemCheck> {
  const t0 = Date.now();
  try {
    const outcome = await runCommand(AGY_BIN, AGY_PROBE_ARGS, { timeoutMs: 1800 });
    const ms = Date.now() - t0;
    if (outcome.errno === "ENOENT") {
      return { status: "warn", latency_ms: ms, detail: `agy binary not found at ${AGY_BIN}` };
    }
    if (outcome.code === 0) {
      const modelCount = outcome.stdout.split("\n").filter((l) => l.trim().length > 0).length;
      return { status: "ok", latency_ms: ms, detail: `agy CLI signed in (${modelCount} models listed)` };
    }
    const errText = (outcome.stderr || outcome.stdout || `Exit code ${outcome.code}`).trim();
    return { status: "warn", latency_ms: ms, detail: errText.slice(0, 100) };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkPm2(): Promise<SubsystemCheck & { online: number; total: number }> {
  const t0 = Date.now();
  try {
    const { ok, stdout, stderr } = await run("pm2 jlist", 1800);
    const ms = Date.now() - t0;
    if (!ok) {
      return { status: "warn", latency_ms: ms, detail: stderr.slice(0, 80) || "pm2 jlist failed", online: 0, total: 0 };
    }
    interface Pm2Item {
      name: string;
      pm2_env?: { status?: string };
    }
    const raw = JSON.parse(stdout) as Pm2Item[];
    const total = raw.length;
    const online = raw.filter((p) => p.pm2_env?.status === "online").length;
    const errored = raw.filter((p) => p.pm2_env?.status === "errored").length;
    const status: "ok" | "warn" | "error" = errored > 0 ? "warn" : "ok";
    return {
      status,
      latency_ms: ms,
      detail: `${online}/${total} processes online${errored > 0 ? ` (${errored} errored)` : ""}`,
      online,
      total,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err), online: 0, total: 0 };
  }
}

async function checkSystemd(): Promise<SubsystemCheck & { flapping: number }> {
  const t0 = Date.now();
  try {
    const { ok, stdout, stderr } = await run("systemctl list-units --type=service --all --no-pager --no-legend", 1800);
    const ms = Date.now() - t0;
    if (!ok) {
      return { status: "warn", latency_ms: ms, detail: stderr.slice(0, 80) || "systemctl failed", flapping: 0 };
    }
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const units = lines.map((line) => {
      const cleaned = line.replace(/^[●○]\s+/, "");
      const [name, load, active, sub] = cleaned.split(/\s+/);
      return { name, load, active, sub };
    });
    const flapping = units.filter((u) => u.active === "activating" && u.sub === "auto-restart").length;
    const failed = units.filter((u) => u.active === "failed").length;
    const status: "ok" | "warn" | "error" = (flapping > 0 || failed > 0) ? "warn" : "ok";
    const detail = flapping > 0
      ? `${flapping} units flapping`
      : failed > 0
      ? `${failed} units in failed state`
      : "0 flapping units (services healthy)";
    return { status, latency_ms: ms, detail, flapping };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err), flapping: 0 };
  }
}

async function checkDisk(): Promise<SubsystemCheck & { used_gb: number; total_gb: number; pct: number }> {
  const t0 = Date.now();
  try {
    const stats = await statfs("/");
    const ms = Date.now() - t0;
    const totalBytes = Number(stats.bsize) * Number(stats.blocks);
    const freeBytes = Number(stats.bsize) * Number(stats.bfree);
    const usedBytes = totalBytes - freeBytes;
    const totalGb = Math.round(totalBytes / (1024 * 1024 * 1024));
    const usedGb = Math.round(usedBytes / (1024 * 1024 * 1024));
    const pct = Math.round((usedBytes / totalBytes) * 100);
    const status: "ok" | "warn" | "error" = pct >= 95 ? "error" : pct >= 85 ? "warn" : "ok";
    return {
      status,
      latency_ms: ms,
      detail: `${usedGb} GB / ${totalGb} GB (${pct}% used)`,
      used_gb: usedGb,
      total_gb: totalGb,
      pct,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: "error", latency_ms: ms, detail: err instanceof Error ? err.message : String(err), used_gb: 0, total_gb: 0, pct: 0 };
  }
}

r.post("/check", async (c) => {
  const t0 = Date.now();
  const [postgres, claude_oauth, gemini_cli, pm2, systemd, disk] = await Promise.all([
    checkPostgres(),
    checkClaudeOAuth(),
    checkGeminiCli(),
    checkPm2(),
    checkSystemd(),
    checkDisk(),
  ]);
  const duration_ms = Date.now() - t0;
  const checks = { postgres, claude_oauth, gemini_cli, pm2, systemd, disk };
  const failedOrWarn = Object.entries(checks).filter(([, v]) => v.status !== "ok");
  const ok = failedOrWarn.length === 0;
  const summary = ok
    ? `All 6 subsystems healthy (${duration_ms}ms)`
    : `${failedOrWarn.length} subsystem${failedOrWarn.length > 1 ? "s" : ""} degraded (${failedOrWarn.map(([k]) => k).join(", ")})`;

  return c.json({
    ok,
    duration_ms,
    checked_at: new Date().toISOString(),
    summary,
    checks,
  });
});

/* ----------------------------------------------------------------------------
 * Deep Check (🔬 Deep Check — async test suite & gates runner)
 * -------------------------------------------------------------------------- */

interface DeepCheckStep {
  name: string;
  status: "pending" | "running" | "passed" | "failed";
  exit_code: number | null;
  duration_ms: number;
  summary: string;
}

export interface DeepCheckState {
  id: string;
  status: "idle" | "running" | "completed" | "failed";
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number;
  current_step: string;
  steps: DeepCheckStep[];
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  suites_total: number;
  logs: string[];
  failure_output: string;
}

let deepCheckState: DeepCheckState = {
  id: "",
  status: "idle",
  started_at: null,
  completed_at: null,
  duration_ms: 0,
  current_step: "",
  steps: [],
  tests_total: 0,
  tests_passed: 0,
  tests_failed: 0,
  suites_total: 0,
  logs: [],
  failure_output: "",
};

function startDeepCheck(): DeepCheckState {
  if (deepCheckState.status === "running") {
    return deepCheckState;
  }

  const runId = randomUUID();
  const startTime = Date.now();
  deepCheckState = {
    id: runId,
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: 0,
    current_step: "Unit Tests (src/lib/*.test.ts)",
    steps: [
      {
        name: "Unit Tests (src/lib/*.test.ts)",
        status: "running",
        exit_code: null,
        duration_ms: 0,
        summary: "Running unit test suite...",
      },
      {
        name: "Universal Repo Gates (gates-808.sh)",
        status: "pending",
        exit_code: null,
        duration_ms: 0,
        summary: "Pending",
      },
    ],
    tests_total: 0,
    tests_passed: 0,
    tests_failed: 0,
    suites_total: 0,
    logs: [`[${new Date().toISOString()}] Starting Deep Check run ${runId.slice(0, 8)}...`],
    failure_output: "",
  };

  // Run in background
  void (async () => {
    const forgeControlDir = fileURLToPath(new URL("../..", import.meta.url));
    const repoRootDir = fileURLToPath(new URL("../../..", import.meta.url));

    // Step 1: Unit tests
    const step1Start = Date.now();
    let step1Failed = false;
    let step1FailLog = "";

    try {
      await new Promise<void>((resolve) => {
        const proc = spawn("npx", ["tsx", "--test", "src/lib/*.test.ts"], {
          cwd: forgeControlDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NODE_ENV: "test" },
        });

        const handleData = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          const lines = text.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            deepCheckState.logs.push(line);
            if (deepCheckState.logs.length > 2000) deepCheckState.logs.shift();

            // Parse test counts. `tsx --test` emits raw Node TAP output, not
            // the `node --test` spec reporter — summary lines are `# tests N`
            // etc (no ℹ prefix), and individual failures are `not ok N - ...`
            // (no ✔/✖ glyphs appear at all). Verified against a real run.
            if (/^not ok \d+/.test(line)) {
              deepCheckState.tests_failed++;
              step1FailLog += `${line}\n`;
            }

            const totalTestMatch = line.match(/^#\s+tests\s+(\d+)/);
            if (totalTestMatch?.[1]) deepCheckState.tests_total = parseInt(totalTestMatch[1], 10);

            const totalSuitesMatch = line.match(/^#\s+suites\s+(\d+)/);
            if (totalSuitesMatch?.[1]) deepCheckState.suites_total = parseInt(totalSuitesMatch[1], 10);

            const finalPassMatch = line.match(/^#\s+pass\s+(\d+)/);
            if (finalPassMatch?.[1]) deepCheckState.tests_passed = parseInt(finalPassMatch[1], 10);

            const finalFailMatch = line.match(/^#\s+fail\s+(\d+)/);
            if (finalFailMatch?.[1]) deepCheckState.tests_failed = parseInt(finalFailMatch[1], 10);
          }
          deepCheckState.duration_ms = Date.now() - startTime;
        };

        proc.stdout.on("data", handleData);
        proc.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          deepCheckState.logs.push(text);
          if (deepCheckState.logs.length > 2000) deepCheckState.logs.shift();
          step1FailLog += `${text}\n`;
        });

        proc.on("close", (code) => {
          const step1Duration = Date.now() - step1Start;
          const passed = code === 0 && deepCheckState.tests_failed === 0;
          step1Failed = !passed;
          deepCheckState.steps[0] = {
            name: "Unit Tests (src/lib/*.test.ts)",
            status: passed ? "passed" : "failed",
            exit_code: code,
            duration_ms: step1Duration,
            summary: passed
              ? `${deepCheckState.tests_passed} tests passed in ${(step1Duration / 1000).toFixed(1)}s`
              : `${deepCheckState.tests_failed} tests failed (exit ${code})`,
          };
          if (!passed) {
            deepCheckState.failure_output += `=== UNIT TESTS FAILURE ===\n${step1FailLog}\n`;
          }
          resolve();
        });

        proc.on("error", (err) => {
          step1Failed = true;
          deepCheckState.steps[0] = {
            name: "Unit Tests (src/lib/*.test.ts)",
            status: "failed",
            exit_code: 1,
            duration_ms: Date.now() - step1Start,
            summary: `Spawn error: ${err.message}`,
          };
          deepCheckState.failure_output += `Unit test spawn error: ${err.message}\n`;
          resolve();
        });
      });
    } catch (e) {
      step1Failed = true;
      deepCheckState.failure_output += `Step 1 error: ${e}\n`;
    }

    // Step 2: Universal gates
    deepCheckState.current_step = "Universal Repo Gates (gates-808.sh)";
    deepCheckState.steps[1] = {
      name: "Universal Repo Gates (gates-808.sh)",
      status: "running",
      exit_code: null,
      duration_ms: 0,
      summary: "Running gates-808.sh...",
    };

    const step2Start = Date.now();
    let step2Failed = false;
    let step2FailLog = "";

    try {
      await new Promise<void>((resolve) => {
        const proc = spawn("bash", ["scripts/checks/gates-808.sh"], {
          cwd: repoRootDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        const handleData = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          const lines = text.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            deepCheckState.logs.push(line);
            if (deepCheckState.logs.length > 2000) deepCheckState.logs.shift();
            if (line.includes("EXIT=") && !line.includes("EXIT=0") && !line.includes("EXIT=-")) {
              step2FailLog += `${line}\n`;
            }
          }
          deepCheckState.duration_ms = Date.now() - startTime;
        };

        proc.stdout.on("data", handleData);
        proc.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          deepCheckState.logs.push(text);
          if (deepCheckState.logs.length > 2000) deepCheckState.logs.shift();
          step2FailLog += `${text}\n`;
        });

        proc.on("close", (code) => {
          const step2Duration = Date.now() - step2Start;
          const passed = code === 0;
          step2Failed = !passed;
          deepCheckState.steps[1] = {
            name: "Universal Repo Gates (gates-808.sh)",
            status: passed ? "passed" : "failed",
            exit_code: code,
            duration_ms: step2Duration,
            summary: passed
              ? `All gates passed in ${(step2Duration / 1000).toFixed(1)}s`
              : `Gates failed with exit code ${code}`,
          };
          if (!passed) {
            deepCheckState.failure_output += `=== GATES FAILURE ===\n${step2FailLog}\n`;
          }
          resolve();
        });

        proc.on("error", (err) => {
          step2Failed = true;
          deepCheckState.steps[1] = {
            name: "Universal Repo Gates (gates-808.sh)",
            status: "failed",
            exit_code: 1,
            duration_ms: Date.now() - step2Start,
            summary: `Spawn error: ${err.message}`,
          };
          deepCheckState.failure_output += `Gates spawn error: ${err.message}\n`;
          resolve();
        });
      });
    } catch (e) {
      step2Failed = true;
      deepCheckState.failure_output += `Step 2 error: ${e}\n`;
    }

    deepCheckState.completed_at = new Date().toISOString();
    deepCheckState.duration_ms = Date.now() - startTime;
    deepCheckState.current_step = "Done";
    deepCheckState.status = step1Failed || step2Failed ? "failed" : "completed";
  })();

  return deepCheckState;
}

r.post("/deep-check", (c) => {
  const state = startDeepCheck();
  return c.json(state);
});

r.get("/deep-check", (c) => {
  return c.json(deepCheckState);
});

export default r;

