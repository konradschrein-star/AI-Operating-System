import { Hono } from "hono";
import { listSkills, getSkill } from "../db/skills.ts";

const r = new Hono();

r.get("/", async (c) => {
  const { skills, categories } = await listSkills();
  return c.json({ count: skills.length, categories, skills });
});

r.get("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const skill = await getSkill(id);
  if (!skill) return c.json({ error: "skill not found", id }, 404);
  return c.json({ skill });
});

export default r;
