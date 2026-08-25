import { Hono } from "hono";
import {
  getAutonomy,
  updateRule,
  evaluateGuardrails,
  resolveTrip,
  recordRuleChange,
  normalizeChangeSource,
  type RuleChangeSource,
} from "../db/autonomy.ts";
import { queueNotification } from "../db/notifications.ts";
import { guardrail } from "../middleware/guardrail.ts";

/**
 * The two mutating routes here write to the guardrails themselves, so both of
 * them are LOUD: an audit row in `guardrail_rule_changes` (migration 0047) and
 * a Telegram push, on every single change.
 *
 * There is no bypass header and the console is not exempt. Konrad seeing his
 * own toggle echoed back is the honest version — the moment "the console is
 * trusted" becomes a rule, an agent's curl can claim to be the console, and the
 * quiet path is back. Round-0 finding P1-1 is exactly that shape.
 *
 * ORDER MATTERS: notify first, audit second. `queueNotification` never throws;
 * `recordRuleChange` does. So a broken audit table costs a 500 and a log line,
 * never Konrad's notification about a change that has already landed.
 */

/** Everything these handlers touch outside their own process, injected so the
 *  router can be spun up in a test without a database. */
export interface AutonomyRouterDeps {
  getAutonomy: typeof getAutonomy;
  updateRule: typeof updateRule;
  evaluateGuardrails: typeof evaluateGuardrails;
  resolveTrip: typeof resolveTrip;
  recordRuleChange: typeof recordRuleChange;
  queueNotification: typeof queueNotification;
}

const NOTIFY_SOURCE = "guardrail";

/** `🛡 guardrail fs.destructive: enabled=false (source api)` */
export function ruleChangeNotice(
  ruleId: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
  source: RuleChangeSource,
): string {
  const parts: string[] = [];
  if (patch.enabled !== undefined) parts.push(`enabled=${patch.enabled}`);
  if (patch.config !== undefined) parts.push("config updated");
  // A patch with neither field never reaches here: updateRule returns null and
  // the handler 404s on it before anything is written.
  return `🛡 guardrail ${ruleId}: ${parts.join(", ")} (source ${source})`;
}

/** `🛡 guardrail trip 1a2b3c4d resolved (source console)` */
export function tripResolveNotice(
  tripId: string,
  source: RuleChangeSource,
): string {
  return `🛡 guardrail trip ${tripId.slice(0, 8)} resolved (source ${source})`;
}

export function createAutonomyRouter(deps: AutonomyRouterDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => c.json(await deps.getAutonomy()));

  r.post("/rules/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      config?: Record<string, unknown>;
    };
    const rule = await deps.updateRule(id, body);
    if (!rule) return c.json({ error: "rule not found or no-op patch" }, 404);

    const source = normalizeChangeSource(c.req.header("x-forge-source"));
    await deps.queueNotification(
      ruleChangeNotice(id, body, source),
      NOTIFY_SOURCE,
    );
    await deps.recordRuleChange({
      kind: "rule.update",
      rule_id: id,
      patch: body,
      source,
    });
    return c.json({ rule });
  });

  // Generic check endpoint — any caller (forge-executor, HCP, a Hermes worker
  // via curl) can ask whether a proposed action would trip a rule, without
  // having to know how each rule evaluates.
  r.post("/check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      agent?: string;
      action?: string;
      category?: string;
      rule_id?: string;
      model?: string;
      engine?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.agent || !body.action) {
      return c.json({ error: "agent and action are required" }, 400);
    }
    const result = await deps.evaluateGuardrails({
      agent: body.agent,
      action: body.action,
      category: body.category,
      rule_id: body.rule_id,
      model: body.model,
      engine: body.engine,
      payload: body.payload,
    });
    return c.json(result);
  });

  r.post("/trips/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const ok = await deps.resolveTrip(id);
    if (!ok) return c.json({ error: "trip not found" }, 404);

    const source = normalizeChangeSource(c.req.header("x-forge-source"));
    await deps.queueNotification(tripResolveNotice(id, source), NOTIFY_SOURCE);
    await deps.recordRuleChange({
      kind: "trip.resolve",
      trip_id: id,
      source,
    });
    return c.json({ resolved: true });
  });

  // Demo: a no-op "agent action" endpoint gated by the destructive category.
  // Useful as a probe for the UI: hitting it should fail with 403 when the
  // destructive category is enabled and bypass_blanket is not set.
  r.post(
    "/probe/destructive",
    guardrail({
      agent: "ai-os:probe",
      action: "probe.destructive",
      category: "destructive",
    }),
    (c) => c.json({ result: "probe passed", action: "probe.destructive" }),
  );

  return r;
}

export default createAutonomyRouter({
  getAutonomy,
  updateRule,
  evaluateGuardrails,
  resolveTrip,
  recordRuleChange,
  queueNotification,
});
