/**
 * Smoke test: exercises classifyLifecycle() against a fixture skill tree.
 * Bypasses the LLM consolidation pass (CLAUDE_POOL_API_KEY empty).
 *
 * Run: npx tsx scripts/smoke-skills-curator.ts
 */
import { mkdir, writeFile, utimes, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function main() {
  const tmp = path.join(os.tmpdir(), `skill-curator-smoke-${process.pid}`);
  const userRoot = path.join(tmp, "user-skills");
  const hermesRoot = path.join(tmp, "hermes-skills");

  // 4 skills: fresh, stale-aged (40d), archive-aged (120d), and pinned-old.
  const skills: Array<{
    root: string;
    rel: string;
    name: string;
    desc: string;
    ageDays: number;
    pinned?: boolean;
  }> = [
    {
      root: userRoot,
      rel: "fresh-skill",
      name: "fresh-skill",
      desc: "Recently touched skill",
      ageDays: 5,
    },
    {
      root: userRoot,
      rel: "stale-skill",
      name: "stale-skill",
      desc: "Untouched for ~40 days",
      ageDays: 40,
    },
    {
      root: hermesRoot,
      rel: "old-skill",
      name: "old-skill",
      desc: "Ancient skill past archive threshold",
      ageDays: 120,
    },
    {
      root: userRoot,
      rel: "pinned-old-skill",
      name: "pinned-old-skill",
      desc: "Old but pinned — must not be auto-archived",
      ageDays: 150,
      pinned: true,
    },
    {
      root: userRoot,
      rel: "extra-fresh",
      name: "extra-fresh",
      desc: "Pads candidate count above the consolidation floor",
      ageDays: 2,
    },
  ];

  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  for (const s of skills) {
    const dir = path.join(s.root, s.rel);
    await mkdir(dir, { recursive: true });
    const fm = ["---", `name: ${s.name}`, `description: ${s.desc}`];
    if (s.pinned) fm.push("pinned: true");
    fm.push("---", "", "Body");
    const file = path.join(dir, "SKILL.md");
    await writeFile(file, fm.join("\n"));
    const t = new Date(Date.now() - s.ageDays * 86400_000);
    await utimes(file, t, t);
  }

  process.env.USER_SKILLS_DIR = userRoot;
  process.env.HERMES_SKILLS_DIR = hermesRoot;
  process.env.CLAUDE_POOL_API_KEY = ""; // forces LLM skip path

  const { runCuratorAudit } = await import("../src/services/skills-curator.ts");
  const r = await runCuratorAudit();

  console.log(`[smoke] total=${r.total_skills}`, r.lifecycle_summary);
  console.log(
    "[smoke] lifecycle:",
    r.lifecycle.map(
      (e) => `${e.id} → ${e.lifecycle} (${e.days_since_touch}d, pinned=${e.pinned})`,
    ),
  );

  if (r.total_skills !== 5) throw new Error(`expected 5 skills, got ${r.total_skills}`);

  const by = Object.fromEntries(r.lifecycle.map((e) => [e.name, e]));

  if (by["fresh-skill"].lifecycle !== "active") {
    throw new Error("fresh-skill should be active");
  }
  if (by["stale-skill"].lifecycle !== "stale") {
    throw new Error("stale-skill should be stale");
  }
  if (by["old-skill"].lifecycle !== "archive_candidate") {
    throw new Error("old-skill should be archive_candidate");
  }
  if (by["pinned-old-skill"].lifecycle !== "protected") {
    throw new Error("pinned-old-skill should be protected (pinned bypass)");
  }

  // No LLM key → consolidations empty, llm_used false, error mentions key.
  if (r.consolidations.length !== 0) {
    throw new Error("consolidations should be empty without LLM key");
  }
  if (r.llm_used) throw new Error("llm_used should be false without LLM key");
  if (!r.llm_error || !r.llm_error.includes("CLAUDE_POOL_API_KEY")) {
    throw new Error(`llm_error should mention missing key, got: ${r.llm_error}`);
  }

  await rm(tmp, { recursive: true, force: true });
  console.log("[smoke] all invariants passed ✓");
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});
