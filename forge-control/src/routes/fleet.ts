import { Hono } from "hono";
import { getFleetState, setFleetState, appendDecision } from "../db/ai_os.ts";

const r = new Hono();

r.get("/", async (c) => {
  return c.json({ fleet: await getFleetState() });
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
