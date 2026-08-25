import { Hono } from "hono";
import {
  getFleetState,
  setFleetState,
  appendDecision,
  getFleetDefaultTier,
  setFleetDefaultTier,
  isValidTaskTier,
  VALID_TASK_TIERS,
} from "../db/ai_os.ts";

const r = new Hono();

r.get("/", async (c) => {
  return c.json({ fleet: await getFleetState() });
});

r.get("/default-tier", async (c) => {
  const defaultTier = await getFleetDefaultTier();
  return c.json(defaultTier);
});

r.put("/default-tier", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    tier?: unknown;
    default_tier?: unknown;
    actor?: string;
    updated_by?: string;
  };
  const rawTier = body.tier ?? body.default_tier;
  if (!isValidTaskTier(rawTier)) {
    return c.json(
      { error: `tier must be one of: ${VALID_TASK_TIERS.join(", ")}` },
      400,
    );
  }
  const actor = body.actor ?? body.updated_by ?? "user";
  const result = await setFleetDefaultTier(rawTier, actor);
  await appendDecision("manager", actor, `set fleet default tier to ${rawTier}`);
  return c.json(result);
});

r.post("/default-tier", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    tier?: unknown;
    default_tier?: unknown;
    actor?: string;
    updated_by?: string;
  };
  const rawTier = body.tier ?? body.default_tier;
  if (!isValidTaskTier(rawTier)) {
    return c.json(
      { error: `tier must be one of: ${VALID_TASK_TIERS.join(", ")}` },
      400,
    );
  }
  const actor = body.actor ?? body.updated_by ?? "user";
  const result = await setFleetDefaultTier(rawTier, actor);
  await appendDecision("manager", actor, `set fleet default tier to ${rawTier}`);
  return c.json(result);
});

r.post("/freeze", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { actor?: string };
  const actor = body.actor ?? "user";
  const fleet = await setFleetState("paused", actor);
  await appendDecision("freeze", actor, "paused fleet");
  return c.json({ fleet });
});

r.post("/resume", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { actor?: string };
  const actor = body.actor ?? "user";
  const fleet = await setFleetState("running", actor);
  await appendDecision("resume", actor, "resumed fleet");
  return c.json({ fleet });
});

export default r;
