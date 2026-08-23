/**
 * Autonomy (guardrail_rules + fleet_state + guardrail_trips) data access.
 */

import pg from "pg";
import { isGeminiModel } from "../lib/gemini-runner.ts";

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

pool.on("error", (e) => console.error("[autonomy pool]", e.message));

export interface GuardrailRule {
  id: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
  builtin: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

export interface GuardrailTrip {
  id: string;
  rule_id: string;
  rule_label: string;
  ts: string;
  agent: string;
  attempted_action: string;
  payload: Record<string, unknown>;
  resolved: boolean;
}

export interface AutonomyResponse {
  fleet: {
    status: "running" | "paused";
    updated_at: string;
    updated_by: string;
  };
  rules: GuardrailRule[];
  trips: GuardrailTrip[];
  categories: { key: string; label: string; count: number }[];
  /** Today's real Gemini draw and the cap it is measured against, so the
   *  Autonomy surface can print a MEASURED number beside the lever instead of
   *  echoing the constant back at Konrad. `null` when the counter could not be
   *  read — the UI says so rather than rendering a confident zero. */
  gemini_daily: (GeminiDailyUsage & { cap_tokens: number }) | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Money",
  destructive: "Destructive",
  communication: "Outbound comms",
  security: "Security",
  deployment: "Deploy / prod",
  custom: "Custom",
};

export async function getAutonomy(): Promise<AutonomyResponse> {
  const fleetR = await pool.query<{
    status: "running" | "paused";
    updated_at: string;
    updated_by: string;
  }>(
    `SELECT status, updated_at::text, updated_by FROM fleet_state WHERE id = 1`,
  );
  const fleet = fleetR.rows[0] ?? {
    status: "running",
    updated_at: new Date().toISOString(),
    updated_by: "system",
  };

  const rulesR = await pool.query<GuardrailRule>(
    `SELECT id, label, description, category, enabled, builtin,
            config, updated_at::text
       FROM guardrail_rules
       ORDER BY category, builtin DESC, id`,
  );

  // Synchronize runtime.pause_all enabled flag with fleet_state status
  const rules = rulesR.rows.map((r) => {
    if (r.id === "runtime.pause_all" && fleet.status === "paused") {
      return { ...r, enabled: true };
    }
    return r;
  });

  const tripsR = await pool.query<GuardrailTrip>(
    `SELECT t.id::text, t.rule_id, g.label AS rule_label,
            t.created_at::text AS ts, t.agent,
            t.attempted_action, t.payload, t.resolved
       FROM guardrail_trips t
       JOIN guardrail_rules g ON g.id = t.rule_id
       ORDER BY t.created_at DESC
       LIMIT 30`,
  );

  const catCounts = new Map<string, number>();
  for (const r of rules)
    catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
  const categories = [...catCounts.entries()].map(([key, count]) => ({
    key,
    label: CATEGORY_LABELS[key] ?? key,
    count,
  }));

  // Read the cap off the rule the guard actually consults, not off the
  // constant — if Konrad has edited `gemini_daily_token_cap`, the surface must
  // show the number that will fire, not the default it replaced.
  const dailyRule = rules.find((r) => r.id === "spend.daily_cap");
  const capRaw = Number(
    (dailyRule?.config ?? {}).gemini_daily_token_cap ??
      DEFAULT_GEMINI_DAILY_TOKEN_CAP,
  );
  const geminiDaily = await geminiDailyTokens()
    .then((u) => ({
      ...u,
      cap_tokens: Number.isFinite(capRaw) ? capRaw : 0,
    }))
    .catch((e) => {
      // Never fail the whole Autonomy payload over the usage counter — the
      // fleet's pause switch lives in this response.
      console.error(
        "[autonomy] geminiDailyTokens failed:",
        e instanceof Error ? e.message : e,
      );
      return null;
    });

  return {
    fleet,
    rules,
    trips: tripsR.rows,
    categories,
    gemini_daily: geminiDaily,
  };
}

export async function updateRule(
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
): Promise<GuardrailRule | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    sets.push(`enabled = $${params.length}`);
  }
  if (patch.config !== undefined) {
    params.push(JSON.stringify(patch.config));
    sets.push(`config = $${params.length}::jsonb`);
  }
  if (sets.length === 0) return null;
  sets.push("updated_at = now()");
  const r = await pool.query<GuardrailRule>(
    `UPDATE guardrail_rules
        SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id, label, description, category, enabled, builtin, config, updated_at::text`,
    params,
  );

  // Synchronize fleet_state when runtime.pause_all is toggled
  if (id === "runtime.pause_all" && patch.enabled !== undefined) {
    await pool.query(
      `UPDATE fleet_state SET status = $1, updated_at = now(), updated_by = 'autonomy' WHERE id = 1`,
      [patch.enabled ? "paused" : "running"],
    );
  }

  return r.rows[0] ?? null;
}

/* ----------------------------------------------------------------------------
 * Enforcement: evaluate whether a proposed agent action would trip a rule.
 *
 * Generic signature so any caller (forge-executor, HCP, or a Hono middleware)
 * can ask the AI OS the same question. Rules with empty config and enabled=true
 * are blanket-block unless payload.bypass_blanket === true. Structured-config
 * rules get rule-specific evaluation:
 *
 *   runtime.pause_all   blocks everything when enabled
 *   spend.per_run_cap   Claude: payload.spend_eur > config.cap_eur, or tokens
 *                       > config.claude_token_cap. Gemini: tokens >
 *                       config.gemini_token_cap.
 *   spend.daily_cap     Claude: payload.daily_spend_eur > config.cap_eur.
 *                       Gemini: TODAY'S CUMULATIVE TOKENS >
 *                       config.gemini_daily_token_cap.
 *   git.force_push      payload.branch is in config.protected_branches
 *   agent.spawn_cap     payload.active_workers >= config.max
 *
 * Anything else with enabled=true and non-empty config falls through to allow
 * until specific evaluation is added. Better to under-enforce silently than
 * to over-enforce wrongly.
 *
 * ── WHY GEMINI GETS A SECOND CURRENCY ───────────────────────────────────────
 * Claude runs bill EUR against the subscription's 5h/7d windows; Gemini runs
 * bill nothing in EUR at all — they draw down a token quota. Feeding a Gemini
 * run's 0 EUR into an EUR cap is not a cap, it is an exemption, so the daily
 * side of the lever has to be counted in the unit Gemini actually spends.
 *
 * The counter is `geminiDailyTokens()` below: a live SUM over
 * `runs.metadata.usage_total_running`, the same field `lib/usage-sampler.ts`
 * folds into `usage_hourly`. It is NOT read from `usage_hourly`, because that
 * table has no provider column (`tokens_in`/`tokens_out` are every engine
 * together) and a Gemini cap fed by Claude's tokens would trip on the wrong
 * fleet.
 * -------------------------------------------------------------------------- */
export interface GuardrailCheckInput {
  agent: string;
  action: string;
  category?: string;
  rule_id?: string;
  /** Model id, when the caller knows it. Merged into payload.model. */
  model?: string;
  /** Engine id ("claude-code" | "gemini" | "gemini-cli" | "agy"). */
  engine?: string;
  payload?: Record<string, unknown>;
}
export interface GuardrailCheckResult {
  allow: boolean;
  blocked_by?: string;
  rule_label?: string;
  reason?: string;
  trip_id?: string;
}

/** Every Gemini-ish engine id the fleet actually writes into `runs.metadata`.
 *  Measured 2026-08-23 against the live table: 88 rows carry a `gemini-*` model
 *  with engine NULL, 46 carry one with engine `claude-code` (the chat path
 *  re-tiers the model without rewriting the engine), 3 carry engine `agy`. So
 *  the MODEL is the load-bearing signal and engine is corroboration only —
 *  keying on engine alone would miss 134 of 137 Gemini runs. */
const GEMINI_ENGINES = new Set(["gemini", "gemini-cli", "agy"]);

/** True when this payload describes a run drawing on the Gemini quota. */
export function payloadIsGemini(payload: Record<string, unknown>): boolean {
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const engine = typeof payload.engine === "string" ? payload.engine : undefined;
  return (
    isGeminiModel(model) ||
    (engine !== undefined && GEMINI_ENGINES.has(engine)) ||
    payload.is_gemini === true ||
    payload.provider === "gemini"
  );
}

/**
 * Default ceiling for `spend.daily_cap`'s Gemini branch, in tokens per calendar
 * day. NOT a guess at Google's published quota — a runaway brake, sized from
 * this box's own history: measured 2026-08-23, the two busiest observed days
 * were 6,834,892 (22 Aug, 24 runs) and 3,487,994 (23 Aug, 25 runs) tokens. 25M
 * is ~3.7x the worst real day, so ordinary parallel Gemini work never sees it
 * and a fleet stuck in a spawn loop does. Konrad can move it from the Autonomy
 * surface; `config.gemini_daily_token_cap` overrides this constant.
 */
export const DEFAULT_GEMINI_DAILY_TOKEN_CAP = 25_000_000;

export interface GeminiDailyUsage {
  /** input+output tokens billed to Gemini runs since local midnight. */
  tokens: number;
  /** How many of today's Gemini runs carried a usage rollup at all. */
  runs: number;
  /** Runs matched as Gemini that carry NO rollup — under-count disclosure. */
  runs_without_usage: number;
}

/**
 * Today's cumulative Gemini token draw, straight off `runs`.
 *
 * `cache_read_input_tokens` is deliberately EXCLUDED: it is context replayed
 * from cache, it is not fresh quota, and folding it in would inflate the
 * counter by ~10x on long chats (one live row today: 1,764,908 cached against
 * 183,111 real input tokens).
 *
 * Under-counts in one known direction, and says so through
 * `runs_without_usage`: `lib/run-rollup.ts` writes `usage_total_running`
 * per-executor-process, so a run whose executor restarted mid-flight loses the
 * part before the restart. A guardrail that under-counts fails open, which is
 * the correct direction for a brake that must never wedge the fleet on a
 * bookkeeping gap.
 */
export async function geminiDailyTokens(): Promise<GeminiDailyUsage> {
  const r = await pool.query<{
    tokens: string;
    runs: string;
    runs_without_usage: string;
  }>(
    `SELECT COALESCE(SUM(
              COALESCE((metadata->'usage_total_running'->>'input_tokens')::bigint, 0)
            + COALESCE((metadata->'usage_total_running'->>'output_tokens')::bigint, 0)
            ), 0)::text                                                   AS tokens,
            count(*) FILTER (WHERE metadata->'usage_total_running' IS NOT NULL)::text
                                                                          AS runs,
            count(*) FILTER (WHERE metadata->'usage_total_running' IS NULL)::text
                                                                          AS runs_without_usage
       FROM runs
      WHERE updated_at >= date_trunc('day', now())
        AND (metadata->>'model' LIKE 'gemini-%'
             OR metadata->>'engine' = ANY($1::text[]))`,
    [[...GEMINI_ENGINES]],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      "geminiDailyTokens: aggregate query returned no row — this SELECT always " +
        "produces exactly one; a missing row means the query shape changed",
    );
  }
  return {
    tokens: Number(row.tokens),
    runs: Number(row.runs),
    runs_without_usage: Number(row.runs_without_usage),
  };
}

/**
 * The Gemini half of `spend.daily_cap`, extracted so it can be tested without
 * a database: every input is an argument, including the usage reading.
 *
 * Gemini spends no EUR, so the EUR cap this rule applies to Claude would be a
 * permanent exemption — which is exactly what this branch used to be
 * (`if (isGemini) return { blocked: false }`). It caps the unit Gemini does
 * spend: today's cumulative tokens, plus this run's estimate.
 *
 * @param usage today's measured draw, or `null` when the counter could not be
 *              read. Null FAILS OPEN — a brake that cannot see must not wedge
 *              the fleet — but logs, because a silently unenforced cap is the
 *              defect this function exists to remove.
 */
export function evaluateGeminiDailyCap(
  cfg: Record<string, unknown>,
  payload: Record<string, unknown>,
  usage: GeminiDailyUsage | null,
): { blocked: boolean; reason?: string } {
  const cap = Number(
    cfg.gemini_daily_token_cap ?? DEFAULT_GEMINI_DAILY_TOKEN_CAP,
  );
  if (!Number.isFinite(cap) || cap <= 0) {
    // An explicit 0/negative is Konrad switching the brake off, which is his
    // to do — a configured decision, not the silent default it used to be.
    return { blocked: false };
  }
  if (usage === null) {
    console.warn(
      "[guardrails] spend.daily_cap: Gemini token counter unavailable, " +
        `allowing run (cap ${cap.toLocaleString()} tokens unenforced)`,
    );
    return { blocked: false };
  }
  const used = usage.tokens;
  const rawThisRun = Number(
    payload.tokens ??
      (payload.thread_chars ? Math.ceil(Number(payload.thread_chars) / 4) : 0),
  );
  const thisRun = Number.isFinite(rawThisRun) ? rawThisRun : 0;
  const projected = used + thisRun;
  if (projected > cap) {
    return {
      blocked: true,
      reason:
        `Gemini daily tokens ${projected.toLocaleString()} ` +
        `(${used.toLocaleString()} already drawn today across ` +
        `${usage.runs} runs + ~${thisRun.toLocaleString()} for this run) ` +
        `exceeds daily cap ${cap.toLocaleString()}`,
    };
  }
  return { blocked: false };
}

/** Facts `evaluateOne` cannot gather itself, because it is synchronous. */
interface GuardrailContext {
  /** Present only when the payload is a Gemini run; null otherwise. */
  geminiDaily: GeminiDailyUsage | null;
}

function evaluateOne(
  rule: GuardrailRule,
  payload: Record<string, unknown>,
  ctx: GuardrailContext,
): { blocked: boolean; reason?: string } {
  if (!rule.enabled) return { blocked: false };
  const cfg = rule.config ?? {};
  switch (rule.id) {
    case "runtime.pause_all":
      return { blocked: true, reason: "Emergency pause is enabled." };
    case "spend.per_run_cap": {
      const isGemini = payloadIsGemini(payload);

      const tokens = Number(
        payload.tokens ??
          (payload.thread_chars ? Math.ceil(Number(payload.thread_chars) / 4) : 0),
      );

      if (isGemini) {
        // High-throughput Gemini quota (default 1M tokens per run)
        const geminiTokenCap = Number(cfg.gemini_token_cap ?? 1_000_000);
        if (Number.isFinite(geminiTokenCap) && geminiTokenCap > 0 && tokens > geminiTokenCap) {
          return {
            blocked: true,
            reason: `Gemini run tokens (${tokens.toLocaleString()}) exceed per-run token cap (${geminiTokenCap.toLocaleString()})`,
          };
        }
        return { blocked: false };
      }

      // Claude subscription window budget (default 100k tokens per run)
      const claudeTokenCap = Number(cfg.claude_token_cap ?? 100_000);
      if (Number.isFinite(claudeTokenCap) && claudeTokenCap > 0 && tokens > claudeTokenCap) {
        return {
          blocked: true,
          reason: `Claude run tokens (${tokens.toLocaleString()}) exceed per-run token cap (${claudeTokenCap.toLocaleString()})`,
        };
      }

      // Optional EUR cap check for Claude runs if cap_eur is explicitly configured (>0)
      const capEur = Number(cfg.cap_eur);
      const spendEur = Number(payload.spend_eur ?? 0);
      if (Number.isFinite(capEur) && capEur > 0 && spendEur > capEur) {
        return {
          blocked: true,
          reason: `per-run spend EUR ${spendEur} exceeds cap EUR ${capEur}`,
        };
      }
      return { blocked: false };
    }
    case "spend.daily_cap": {
      if (payloadIsGemini(payload)) {
        return evaluateGeminiDailyCap(cfg, payload, ctx.geminiDaily);
      }
      const cap = Number(cfg.cap_eur);
      const spend = Number(payload.daily_spend_eur ?? 0);
      if (Number.isFinite(cap) && cap > 0 && spend > cap) {
        return {
          blocked: true,
          reason: `daily spend EUR ${spend} exceeds cap EUR ${cap}`,
        };
      }
      return { blocked: false };
    }
    case "git.force_push": {
      const protectedBranches = Array.isArray(cfg.protected_branches)
        ? (cfg.protected_branches as string[])
        : [];
      const branch = String(payload.branch ?? "");
      if (protectedBranches.includes(branch)) {
        return { blocked: true, reason: `force-push to '${branch}' protected` };
      }
      return { blocked: false };
    }
    case "agent.spawn_cap": {
      const max = Number(cfg.max);
      const active = Number(payload.active_workers ?? 0);
      if (Number.isFinite(max) && active >= max) {
        return {
          blocked: true,
          reason: `worker spawn cap ${max} reached (${active} active)`,
        };
      }
      return { blocked: false };
    }
    default:
      if (Object.keys(cfg).length === 0 && rule.enabled) {
        if (payload.bypass_blanket === true) return { blocked: false };
        return { blocked: true, reason: `${rule.label} is enabled` };
      }
      return { blocked: false };
  }
}

/**
 * Fill in `model`/`engine` for a caller that only knows the run id.
 *
 * `executor.ts` is a FORBIDDEN file for this project (gates-808 gate 6 and
 * `project-tick.test.ts`'s R36 both enforce it), so the provider cannot be
 * pushed in from that call site. It is pulled from the run row here instead,
 * which is the right layer anyway: the guardrail engine owns what a rule needs
 * to know. Returns nothing when the row or its metadata is absent — an
 * unresolvable run is treated as non-Gemini, i.e. the EUR path, which is the
 * behaviour this function replaced.
 */
async function resolveRunProvider(
  runId: string,
): Promise<{ model?: string; engine?: string }> {
  const r = await pool.query<{ model: string | null; engine: string | null }>(
    `SELECT metadata->>'model' AS model, metadata->>'engine' AS engine
       FROM runs WHERE id = $1::uuid`,
    [runId],
  );
  const row = r.rows[0];
  if (!row) return {};
  return {
    ...(row.model ? { model: row.model } : {}),
    ...(row.engine ? { engine: row.engine } : {}),
  };
}

export async function evaluateGuardrails(
  input: GuardrailCheckInput,
): Promise<GuardrailCheckResult> {
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (input.model !== undefined && payload.model === undefined) {
    payload.model = input.model;
  }
  if (input.engine !== undefined && payload.engine === undefined) {
    payload.engine = input.engine;
  }
  // Neither field arrived, but a run id did: ask the runs table. A failure
  // here MUST NOT block the run — the guardrail engine sits on the completion
  // path and a dead lookup would wedge every chat turn on the box.
  if (
    payload.model === undefined &&
    payload.engine === undefined &&
    typeof payload.run_id === "string"
  ) {
    const resolved = await resolveRunProvider(payload.run_id).catch((e) => {
      console.error(
        "[guardrails] resolveRunProvider failed:",
        e instanceof Error ? e.message : e,
      );
      return {} as { model?: string; engine?: string };
    });
    if (resolved.model !== undefined) payload.model = resolved.model;
    if (resolved.engine !== undefined) payload.engine = resolved.engine;
  }

  const ctx: GuardrailContext = { geminiDaily: null };
  if (payloadIsGemini(payload)) {
    ctx.geminiDaily = await geminiDailyTokens().catch((e) => {
      console.error(
        "[guardrails] geminiDailyTokens failed:",
        e instanceof Error ? e.message : e,
      );
      return null;
    });
  }

  const params: unknown[] = [];
  const wheres: string[] = ["enabled = true"];
  if (input.rule_id) {
    params.push(input.rule_id);
    wheres.push(`id = $${params.length}`);
  } else if (input.category) {
    params.push(input.category);
    wheres.push(`category = $${params.length}`);
  }
  const sql = `SELECT id, label, description, category, enabled, builtin,
                      config, updated_at::text
                 FROM guardrail_rules
                WHERE ${wheres.join(" AND ")}`;
  const rulesR = await pool.query<GuardrailRule>(sql, params);
  const rules = rulesR.rows;

  // Check fleet_state to ensure fleet freeze is synchronized with emergency pause
  const fleetCheck = await pool.query<{ status: string }>(
    `SELECT status FROM fleet_state WHERE id = 1`,
  );
  const isFleetPaused = fleetCheck.rows[0]?.status === "paused";

  if (isFleetPaused && !rules.some((r) => r.id === "runtime.pause_all")) {
    rules.unshift({
      id: "runtime.pause_all",
      label: "Emergency pause",
      description: "Fleet is paused via fleet_state.",
      category: "security",
      enabled: true,
      builtin: true,
      config: {},
      updated_at: new Date().toISOString(),
    });
  } else if (!input.rule_id && !rules.some((r) => r.id === "runtime.pause_all")) {
    const kill = await pool.query<GuardrailRule>(
      `SELECT id, label, description, category, enabled, builtin,
              config, updated_at::text
         FROM guardrail_rules
        WHERE id = 'runtime.pause_all' AND enabled = true`,
    );
    rules.unshift(...kill.rows);
  }

  for (const rule of rules) {
    const { blocked, reason } = evaluateOne(rule, payload, ctx);
    if (!blocked) continue;
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO guardrail_trips
         (rule_id, agent, attempted_action, payload, resolved)
         VALUES ($1, $2, $3, $4::jsonb, false)
         RETURNING id::text`,
      [
        rule.id,
        input.agent.slice(0, 64),
        input.action.slice(0, 200),
        JSON.stringify({ ...payload, _reason: reason }),
      ],
    );
    return {
      allow: false,
      blocked_by: rule.id,
      rule_label: rule.label,
      reason,
      trip_id: trip.rows[0].id,
    };
  }
  return { allow: true };
}

export async function resolveTrip(id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE guardrail_trips SET resolved = true WHERE id = $1`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
