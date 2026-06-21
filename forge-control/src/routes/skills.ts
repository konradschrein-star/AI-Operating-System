import { Hono } from "hono";
import { listSkills, getSkill } from "../db/skills.ts";
import { runCuratorAudit } from "../services/skills-curator.ts";

const r = new Hono();

r.get("/", async (c) => {
  const { skills, categories } = await listSkills();
  return c.json({ count: skills.length, categories, skills });
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

r.get("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const skill = await getSkill(id);
  if (!skill) return c.json({ error: "skill not found", id }, 404);
  return c.json({ skill });
});

export default r;
