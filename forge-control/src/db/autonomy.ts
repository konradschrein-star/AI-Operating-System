/**
 * Autonomy (guardrail_rules + fleet_state + guardrail_trips) data access.
 */

import pg from "pg";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

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
  for (const r of rulesR.rows)
    catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
  const categories = [...catCounts.entries()].map(([key, count]) => ({
    key,
    label: CATEGORY_LABELS[key] ?? key,
    count,
  }));

  return {
    fleet,
    rules: rulesR.rows,
    trips: tripsR.rows,
    categories,
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
 *   spend.per_run_cap   payload.spend_eur > config.cap_eur
 *   spend.daily_cap     payload.daily_spend_eur > config.cap_eur
 *   git.force_push      payload.branch is in config.protected_branches
 *   agent.spawn_cap     payload.active_workers >= config.max
 *
 * Anything else with enabled=true and non-empty config falls through to allow
 * until specific evaluation is added. Better to under-enforce silently than
 * to over-enforce wrongly.
 * -------------------------------------------------------------------------- */
export interface GuardrailCheckInput {
  agent: string;
  action: string;
  category?: string;
  rule_id?: string;
  payload?: Record<string, unknown>;
}
export interface GuardrailCheckResult {
  allow: boolean;
  blocked_by?: string;
  rule_label?: string;
  reason?: string;
  trip_id?: string;
}

function evaluateOne(
  rule: GuardrailRule,
  payload: Record<string, unknown>,
): { blocked: boolean; reason?: string } {
  if (!rule.enabled) return { blocked: false };
  const cfg = rule.config ?? {};
  switch (rule.id) {
    case "runtime.pause_all":
      return { blocked: true, reason: "Emergency pause is enabled." };
    case "spend.per_run_cap": {
      const cap = Number(cfg.cap_eur);
      const spend = Number(payload.spend_eur ?? 0);
      if (Number.isFinite(cap) && spend > cap) {
        return {
          blocked: true,
          reason: `per-run spend EUR ${spend} exceeds cap EUR ${cap}`,
        };
      }
      return { blocked: false };
    }
    case "spend.daily_cap": {
      const cap = Number(cfg.cap_eur);
      const spend = Number(payload.daily_spend_eur ?? 0);
      if (Number.isFinite(cap) && spend > cap) {
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

export async function evaluateGuardrails(
  input: GuardrailCheckInput,
): Promise<GuardrailCheckResult> {
  const payload = input.payload ?? {};
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

  if (!input.rule_id && !rules.some((r) => r.id === "runtime.pause_all")) {
    const kill = await pool.query<GuardrailRule>(
      `SELECT id, label, description, category, enabled, builtin,
              config, updated_at::text
         FROM guardrail_rules
        WHERE id = 'runtime.pause_all' AND enabled = true`,
    );
    rules.unshift(...kill.rows);
  }

  for (const rule of rules) {
    const { blocked, reason } = evaluateOne(rule, payload);
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
