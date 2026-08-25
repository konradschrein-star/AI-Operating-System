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

/** One line of the guardrail audit log: who changed a rule, or who resolved a
 *  trip, and through which surface. Written by `recordRuleChange`. */
export interface GuardrailRuleChange {
  id: string;
  /** null for a trip resolve — that row names a trip, not a rule. */
  rule_id: string | null;
  /** null for a rule update. */
  trip_id: string | null;
  kind: RuleChangeKind;
  patch: Record<string, unknown>;
  source: string;
  created_at: string;
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
  /** The 20 newest guardrail audit rows — every rule patch and every trip
   *  resolve, with the surface that made it. `null` when the log could not be
   *  read (e.g. the console is talking to a database that has not had
   *  migration 0047 applied yet); the UI says so rather than rendering an
   *  empty log, which would read as "nobody has touched anything". */
  rule_changes: GuardrailRuleChange[] | null;
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

  const rules = rulesR.rows.map((r) => {
    if (r.id === "runtime.pause_all") {
      return { ...r, enabled: fleet.status === "paused" };
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
  // Never fail the whole Autonomy payload over the audit log — the fleet's
  // pause switch lives in this response, and the log's own table arrives with
  // migration 0047, which a deploy applies after the code lands.
  const ruleChanges = await listRuleChanges(20).catch((e) => {
    console.error(
      "[autonomy] listRuleChanges failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  });

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
    rule_changes: ruleChanges,
    gemini_daily: geminiDaily,
  };
}

/* ----------------------------------------------------------------------------
 * The guardrail audit log (`guardrail_rule_changes`, migration 0047).
 *
 * Every write to a guardrail — a rule patch or a trip resolve — leaves a row
 * here and pings Konrad. There is no bypass header and the console is not
 * exempt: seeing his own toggle echoed back is the honest version, because the
 * alternative is a "quiet" class of change that an agent can dress up as one.
 * -------------------------------------------------------------------------- */

export type RuleChangeKind = "rule.update" | "trip.resolve";

/** The surfaces allowed to name themselves in `x-forge-source`. Anything else
 *  — absent, misspelt, or invented by a caller — is recorded as `api`, which is
 *  the truthful label for "a process hit the HTTP endpoint". */
export const RULE_CHANGE_SOURCES = ["console", "api", "deploy"] as const;
export type RuleChangeSource = (typeof RULE_CHANGE_SOURCES)[number];

export function normalizeChangeSource(raw: unknown): RuleChangeSource {
  if (typeof raw !== "string") return "api";
  const v = raw.trim().toLowerCase();
  return (RULE_CHANGE_SOURCES as readonly string[]).includes(v)
    ? (v as RuleChangeSource)
    : "api";
}

/**
 * Append one audit row.
 *
 * THROWS on a database error, deliberately. This is the record of who switched
 * a security control off; a swallowed insert would leave the console showing a
 * successful toggle with nothing behind it, which is the exact shape of the
 * finding this log exists to close. Callers queue the Telegram push BEFORE
 * calling this, so a broken audit table costs a 500 and a log line — never
 * Konrad's notification.
 */
export async function recordRuleChange(input: {
  kind: RuleChangeKind;
  rule_id?: string | null;
  trip_id?: string | null;
  patch?: Record<string, unknown>;
  source: RuleChangeSource;
}): Promise<void> {
  await pool.query(
    `INSERT INTO guardrail_rule_changes (rule_id, trip_id, kind, patch, source)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5)`,
    [
      input.rule_id ?? null,
      input.trip_id ?? null,
      input.kind,
      JSON.stringify(input.patch ?? {}),
      input.source,
    ],
  );
}

export async function listRuleChanges(
  limit = 20,
): Promise<GuardrailRuleChange[]> {
  const r = await pool.query<GuardrailRuleChange>(
    `SELECT id::text, rule_id, trip_id::text, kind, patch, source,
            created_at::text
       FROM guardrail_rule_changes
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
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

  if (id === "runtime.pause_all" && patch.enabled !== undefined) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<GuardrailRule>(
        `UPDATE guardrail_rules
            SET ${sets.join(", ")}
          WHERE id = $1
          RETURNING id, label, description, category, enabled, builtin, config, updated_at::text`,
        params,
      );
      const newStatus = patch.enabled ? "paused" : "running";
      await client.query(
        `UPDATE fleet_state
            SET status = $1, updated_at = now(), updated_by = 'guardrail'
          WHERE id = 1`,
        [newStatus],
      );
      await client.query("COMMIT");
      return r.rows[0] ?? null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const r = await pool.query<GuardrailRule>(
    `UPDATE guardrail_rules
        SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING id, label, description, category, enabled, builtin, config, updated_at::text`,
    params,
  );

  // No fleet_state sync here: the `runtime.pause_all` branch above returns
  // before this line, inside a transaction that already writes fleet_state.
  // The second, non-transactional copy that used to live here was unreachable
  // by construction and only made the pause path look like it had two owners.
  return r.rows[0] ?? null;
}

/* ----------------------------------------------------------------------------
 * Enforcement: evaluate whether a proposed agent action would trip a rule.
 *
 * Generic signature so any caller (forge-executor, HCP, or a Hono middleware)
 * can ask the AI OS the same question.
 *
 * ── THE RULE: ENABLED MEANS BLOCKED, WHATEVER THE CONFIG ────────────────────
 * A rule that is enabled and has no rule-specific evaluator BLOCKS. Its config
 * is not consulted at all; the single escape is `payload.bypass_blanket ===
 * true`, which only a trusted in-process caller sets (executor.ts's financial
 * check, and the `guardrail()` middleware's demo route).
 *
 * This used to read `Object.keys(cfg).length === 0 && rule.enabled`, i.e. a
 * blanket block ONLY for an empty config, with the comment "anything else
 * falls through to allow until specific evaluation is added". Round-0 finding
 * P1-1 measured what that buys an agent:
 *
 *     curl -sX POST http://127.0.0.1:7700/api/autonomy/rules/fs.destructive \
 *       -H 'content-type: application/json' -d '{"config":{"note":"x"}}'
 *
 * One patch, no privileges, and `fs.destructive` — along with `comm.outbound`,
 * `deploy.prod` and `secrets.read`, all four of which ride this branch — stops
 * enforcing anything, while the Autonomy console still shows the rule ENABLED.
 * A control that reports itself on while it is off is worse than one that is
 * plainly off. Under-enforcing SILENTLY is not the conservative direction; it
 * is the direction that hides.
 *
 * So the config is now irrelevant on this branch, and a rule with a config the
 * engine does not understand fails towards blocking. The cost is real and
 * accepted: adding a config key to an enabled catch-all rule cannot loosen it,
 * only `enabled=false` can — and that is a decision Konrad sees, because since
 * migration 0047 every rule patch writes a `guardrail_rule_changes` row and
 * pings him.
 *
 * Rules WITH a specific evaluator are untouched by all of the above:
 *
 *   runtime.pause_all   blocks everything when enabled
 *   spend.per_run_cap   DEAD CODE. The rule row was deleted from
 *                       `guardrail_rules` on 2026-08-25 at Konrad's
 *                       instruction (it blocked a real run on 08-18); the case
 *                       is kept so a re-seeded row would evaluate rather than
 *                       blanket-block. Do NOT re-seed the rule.
 *   spend.daily_cap     Claude: payload.daily_spend_eur > config.cap_eur.
 *                       Gemini: TODAY'S CUMULATIVE TOKENS >
 *                       config.gemini_daily_token_cap.
 *   git.force_push      payload.branch is in config.protected_branches
 *   agent.spawn_cap     payload.active_workers >= config.max
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

/** Facts `evaluateRule` cannot gather itself, because it is synchronous. */
export interface GuardrailContext {
  /** Present only when the payload is a Gemini run; null otherwise. */
  geminiDaily: GeminiDailyUsage | null;
}

/**
 * The whole enforcement decision for ONE rule, pure and synchronous.
 *
 * Exported so the blanket-block matrix can be exercised without a database —
 * every input is an argument, including the Gemini usage reading. The
 * `evaluateGuardrails` wrapper below owns the I/O; this owns the policy.
 */
export function evaluateRule(
  rule: GuardrailRule,
  payload: Record<string, unknown>,
  ctx: GuardrailContext,
): { blocked: boolean; reason?: string } {
  if (!rule.enabled) return { blocked: false };
  const cfg = rule.config ?? {};
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const engine = typeof payload.engine === "string" ? payload.engine : undefined;
  const isGemini = isGeminiModel(model) || engine === "gemini" || engine === "gemini-cli";

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
        const geminiTokenCap = Number(
          cfg.gemini_token_cap ?? cfg.tokens_per_run_cap ?? cfg.token_cap ?? 1_000_000,
        );
        if (Number.isFinite(geminiTokenCap) && geminiTokenCap > 0 && tokens > geminiTokenCap) {
          return {
            blocked: true,
            reason: `Gemini run tokens (${tokens.toLocaleString()}) exceed per-run token cap (${geminiTokenCap.toLocaleString()})`,
          };
        }
        return { blocked: false };
      }

      // Claude subscription window budget (default 100k tokens per run)
      const claudeTokenCap = Number(
        cfg.claude_token_cap ?? cfg.tokens_per_run_cap ?? cfg.token_cap ?? 100_000,
      );
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
      // Enabled, and nothing above knows how to evaluate it: BLOCK. `cfg` is
      // deliberately not read here — see the header. `=== true` is the whole
      // check on the escape hatch, so an agent-supplied "true", 1 or {} does
      // not open it.
      if (payload.bypass_blanket === true) return { blocked: false };
      return { blocked: true, reason: `${rule.label} is enabled` };
  }
}

/** What one run row can tell the guardrail engine. Every field optional: an
 *  unresolvable run must degrade, never throw. */
interface RunFacts {
  model?: string;
  engine?: string;
  /** `metadata.role` — "builder", "reviewer", … Set on project-task runs by
   *  `createRunForTask`; absent on chat and telegram runs. */
  role?: string;
  /** The `runs.title` column, so a trip names the work that caused it. */
  title?: string;
}

/** `id::uuid` in the SQL below throws on anything that is not a UUID, and the
 *  run id reaching us can come from a hook's payload. Screen it first rather
 *  than letting a cast failure become a caught-and-logged non-event. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fill in `model`/`engine`/`role`/`title` for a caller that only knows the run
 * id — one query, all four.
 *
 * `executor.ts` is a FORBIDDEN file for this project (gates-808 gate 6 and
 * `project-tick.test.ts`'s R36 both enforce it), so the provider cannot be
 * pushed in from that call site. It is pulled from the run row here instead,
 * which is the right layer anyway: the guardrail engine owns what a rule needs
 * to know. Returns nothing when the row or its metadata is absent — an
 * unresolvable run is treated as non-Gemini, i.e. the EUR path, which is the
 * behaviour this function replaced.
 */
async function resolveRunProvider(runId: string): Promise<RunFacts> {
  const r = await pool.query<{
    model: string | null;
    engine: string | null;
    role: string | null;
    title: string | null;
  }>(
    `SELECT metadata->>'model' AS model, metadata->>'engine' AS engine,
            metadata->>'role'  AS role,  title
       FROM runs WHERE id = $1::uuid`,
    [runId],
  );
  const row = r.rows[0];
  if (!row) return {};
  return {
    ...(row.model ? { model: row.model } : {}),
    ...(row.engine ? { engine: row.engine } : {}),
    ...(row.role ? { role: row.role } : {}),
    ...(row.title ? { title: row.title } : {}),
  };
}

/** varchar(64) — `guardrail_trips.agent`. A longer label would abort the INSERT
 *  and turn an attributed block into no block at all. */
const AGENT_COL_MAX = 64;

/**
 * The `agent` string a trip is filed under.
 *
 * The Bash hook sends the same literal `bash-hook` for every run on the box, so
 * the audit log could not say WHO tried the thing (round-0 finding P3-2:
 * "`agent` is always `bash-hook`"). When we know the role, say it. When we do
 * not — chat runs carry no `metadata.role`, and the lookup is allowed to fail —
 * fall back to the bare label rather than inventing an attribution.
 */
export function hookAgentLabel(agent: string, role: string | undefined): string {
  const suffix = (role ?? "").trim();
  if (agent !== "bash-hook" || !suffix) return agent.slice(0, AGENT_COL_MAX);
  return `${agent}:${suffix}`.slice(0, AGENT_COL_MAX);
}

export async function evaluateGuardrails(
  input: GuardrailCheckInput,
): Promise<GuardrailCheckResult> {
  const payload: Record<string, unknown> = {
    ...(input.payload ?? {}),
  };
  if (input.model !== undefined && payload.model === undefined) {
    payload.model = input.model;
  }
  if (input.engine !== undefined && payload.engine === undefined) {
    payload.engine = input.engine;
  }
  // Ask the runs table when the payload carries a run id and we still need
  // something from that row: the provider (for the Gemini branch) or the role
  // (to attribute a Bash-hook trip to the agent that tried it). One query
  // serves both. A failure here MUST NOT block the run — the guardrail engine
  // sits on the completion path and a dead lookup would wedge every chat turn
  // on the box.
  const runId = typeof payload.run_id === "string" ? payload.run_id : undefined;
  const needsProvider =
    payload.model === undefined && payload.engine === undefined;
  const needsAttribution = input.agent === "bash-hook";
  let facts: RunFacts = {};
  if (runId !== undefined && UUID_RE.test(runId) && (needsProvider || needsAttribution)) {
    facts = await resolveRunProvider(runId).catch((e) => {
      console.error(
        "[guardrails] resolveRunProvider failed:",
        e instanceof Error ? e.message : e,
      );
      return {} as RunFacts;
    });
    if (needsProvider) {
      if (facts.model !== undefined) payload.model = facts.model;
      if (facts.engine !== undefined) payload.engine = facts.engine;
    }
    // The run's own title, recorded on the trip so the audit log names the
    // work rather than only the command. Never overwrites a caller's value.
    if (facts.title !== undefined && payload.run_title === undefined) {
      payload.run_title = facts.title;
    }
  }
  const agent = hookAgentLabel(input.agent, facts.role);

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

  // Check fleet_state paused status
  const fleetR = await pool.query<{ status: string }>(
    `SELECT status FROM fleet_state WHERE id = 1`,
  );
  const isFleetPaused = fleetR.rows[0]?.status === "paused";

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

  if (isFleetPaused) {
    if (!rules.some((r) => r.id === "runtime.pause_all")) {
      const pauseRuleR = await pool.query<GuardrailRule>(
        `SELECT id, label, description, category, enabled, builtin,
                config, updated_at::text
           FROM guardrail_rules
          WHERE id = 'runtime.pause_all'`,
      );
      if (pauseRuleR.rows[0]) {
        rules.unshift({ ...pauseRuleR.rows[0], enabled: true });
      } else {
        rules.unshift({
          id: "runtime.pause_all",
          label: "Emergency pause",
          description: "When tripped, pauses every worker via fleet_state.",
          category: "security",
          enabled: true,
          builtin: true,
          config: {},
          updated_at: new Date().toISOString(),
        });
      }
    }
  } else if (!input.rule_id) {
    // If fleet is running, ensure runtime.pause_all does not block unless explicitly targeted
    const idx = rules.findIndex((r) => r.id === "runtime.pause_all");
    if (idx >= 0) {
      rules.splice(idx, 1);
    }
  }

  for (const rule of rules) {
    const { blocked, reason } = evaluateRule(rule, payload, ctx);
    if (!blocked) continue;
    const trip = await pool.query<{ id: string }>(
      `INSERT INTO guardrail_trips
         (rule_id, agent, attempted_action, payload, resolved)
         VALUES ($1, $2, $3, $4::jsonb, false)
         RETURNING id::text`,
      [
        rule.id,
        agent,
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
