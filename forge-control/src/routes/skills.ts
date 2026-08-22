import { Hono } from "hono";
import {
  listSkills,
  getSkill,
  setSkillEnabled,
  estimateCatalogTokens,
} from "../db/skills.ts";
import { runCuratorAudit, isProtectedSkill } from "../services/skills-curator.ts";

const r = new Hono();

r.get("/", async (c) => {
  const { skills, categories } = await listSkills();
  const enabled = skills.filter((s) => s.enabled);
  const disabled = skills.filter((s) => !s.enabled);
  const withProtection = skills.map((s) => ({
    ...s,
    protected: isProtectedSkill(s.id),
  }));
  return c.json({
    count: skills.length,
    categories,
    skills: withProtection,
    token_estimate: {
      enabled_count: enabled.length,
      disabled_count: disabled.length,
      current_tokens: estimateCatalogTokens(enabled),
      all_enabled_tokens: estimateCatalogTokens(skills),
      savings_tokens: estimateCatalogTokens(disabled),
    },
  });
});

/* POST /curate — runs the skills-curator audit (FS-mtime lifecycle classification
 * + claude-pool consolidation review). Mounted BEFORE the slug-scoped GET so
 * Hono routes correctly. Returns a structured report; the UI confirms before
 * any actual archive/merge action. */
r.post("/curate", async (c) => {
  const t0 = Date.now();
  const audit = await runCuratorAudit();
  const ms = Date.now() - t0;
  return c.json({ duration_ms: ms, ...audit });
});

/* POST /bulk-toggle — enable/disable several skills at once, either by
 * explicit id list or by category (used by the UI's "Disable macOS/Apple
 * Skills" quick action). Mounted before the greedy GET/POST :id routes so
 * "bulk-toggle" is never swallowed as a skill id. */
r.post("/bulk-toggle", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return c.json({ error: "body.enabled: boolean is required" }, 400);
  }
  let targetIds: string[];
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    targetIds = body.ids.filter((x: unknown) => typeof x === "string");
  } else if (typeof body.category === "string" && body.category) {
    const { skills } = await listSkills();
    targetIds = skills.filter((s) => s.category === body.category).map((s) => s.id);
  } else {
    return c.json({ error: "provide body.ids[] or body.category" }, 400);
  }
  const results = [];
  for (const id of targetIds) {
    if (isProtectedSkill(id)) {
      results.push({ id, skipped: true, reason: "protected" });
      continue;
    }
    const skill = await getSkill(id);
    if (!skill) {
      results.push({ id, skipped: true, reason: "not found" });
      continue;
    }
    const outcome = await setSkillEnabled(id, body.enabled);
    results.push({ ...outcome, skipped: false });
  }
  return c.json({ enabled: body.enabled, results });
});

r.post("/:id{.+}/toggle", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return c.json({ error: "body.enabled: boolean is required" }, 400);
  }
  const skill = await getSkill(id);
  if (!skill) return c.json({ error: "skill not found", id }, 404);
  if (isProtectedSkill(id)) {
    return c.json(
      { error: "skill is protected and cannot be disabled", id, protected: true },
      403,
    );
  }
  const outcome = await setSkillEnabled(id, body.enabled);
  return c.json(outcome);
});

r.get("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const skill = await getSkill(id);
  if (!skill) return c.json({ error: "skill not found", id }, 404);
  return c.json({ skill: { ...skill, protected: isProtectedSkill(id) } });
});

export default r;
