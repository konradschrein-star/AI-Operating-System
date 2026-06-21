/**
 * Hono middleware factory that consults guardrail_rules before letting a
 * request through. Used to gate any forge-control endpoint that maps to a
 * fleet action with policy implications.
 *
 * Usage in a route file:
 *   import { guardrail } from "../middleware/guardrail.ts";
 *   r.post("/risky", guardrail({ category: "destructive", action: "risky" }), handler);
 *
 * On block, responds 403 with the trip details and rule label. The trip is
 * already persisted to guardrail_trips and surfaces in the Autonomy UI.
 */
import type { MiddlewareHandler } from "hono";
import { evaluateGuardrails } from "../db/autonomy.ts";

export interface GuardOpts {
  agent?: string;
  action: string;
  category?: string;
  rule_id?: string;
}

export function guardrail(opts: GuardOpts): MiddlewareHandler {
  return async (c, next) => {
    let body: Record<string, unknown> = {};
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      (c.req.header("content-type") ?? "").includes("application/json")
    ) {
      try {
        const raw = await c.req.json();
        if (raw && typeof raw === "object")
          body = raw as Record<string, unknown>;
      } catch {
        // empty body is fine; downstream handler will decide
      }
    }
    const res = await evaluateGuardrails({
      agent: opts.agent ?? "forge-control:http",
      action: opts.action,
      category: opts.category,
      rule_id: opts.rule_id,
      payload: body,
    });
    if (!res.allow) {
      return c.json(
        {
          error: "guardrail_blocked",
          blocked_by: res.blocked_by,
          rule_label: res.rule_label,
          reason: res.reason,
          trip_id: res.trip_id,
        },
        403,
      );
    }
    await next();
  };
}
