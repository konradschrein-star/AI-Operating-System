import { Hono } from "hono";
import {
  getAutonomy,
  updateRule,
  evaluateGuardrails,
  resolveTrip,
} from "../db/autonomy.ts";
import { guardrail } from "../middleware/guardrail.ts";

const r = new Hono();

r.get("/", async (c) => c.json(await getAutonomy()));

r.post("/rules/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    config?: Record<string, unknown>;
  };
  const rule = await updateRule(id, body);
  if (!rule) return c.json({ error: "rule not found or no-op patch" }, 404);
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
    payload?: Record<string, unknown>;
  };
  if (!body.agent || !body.action) {
    return c.json({ error: "agent and action are required" }, 400);
  }
  const result = await evaluateGuardrails({
    agent: body.agent,
    action: body.action,
    category: body.category,
    rule_id: body.rule_id,
    payload: body.payload,
  });
  return c.json(result);
});

r.post("/trips/:id/resolve", async (c) => {
  const ok = await resolveTrip(c.req.param("id"));
  if (!ok) return c.json({ error: "trip not found" }, 404);
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

export default r;
