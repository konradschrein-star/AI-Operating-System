/**
 * Skills (SKILL.md catalog) data access.
 *
 * Skills live as SKILL.md files under one of several roots. Each has YAML
 * frontmatter with at least name + description; we parse only those + body.
 *
 * Roots scanned (first existing wins per id):
 *  - HERMES_SKILLS_DIR (default /var/lib/docker/volumes/...skills) — Hermes
 *    docker volume that the fleet workers mount.
 *  - USER_SKILLS_DIR (default /home/konra/.claude/skills) — Claude Code user
 *    skills on the VPS.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const HERMES_SKILLS_DIR =
  process.env.HERMES_SKILLS_DIR ??
  "/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills";
const USER_SKILLS_DIR =
  process.env.USER_SKILLS_DIR ?? "/home/konra/.claude/skills";

type Source = "hermes" | "user";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  source: Source;
  path: string;
  risk?: string;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  frontmatter: Record<string, unknown>;
  word_count: number;
}

const SOURCES: { src: Source; root: string }[] = [
  { src: "hermes", root: HERMES_SKILLS_DIR },
  { src: "user", root: USER_SKILLS_DIR },
];

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let val: unknown = kv[2].trim().replace(/^["']|["']$/g, "");
    if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** Walk a roots tree and return every SKILL.md path (relative to root). */
async function findSkillFiles(root: string, maxDepth = 5): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name === "SKILL.md") {
        out.push(full);
      }
    }
  }
  try {
    const s = await stat(root);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }
  await walk(root, 0);
  return out;
}

function idFor(root: string, file: string, src: Source): string {
  const rel = path.relative(root, path.dirname(file)).replace(/\\/g, "/");
  return `${src}:${rel || "root"}`;
}

function categoryFor(root: string, file: string): string {
  const rel = path.relative(root, path.dirname(file)).replace(/\\/g, "/");
  // First path segment is the category. If only one segment, use it directly.
  const parts = rel.split("/").filter(Boolean);
  return parts[0] ?? "uncategorized";
}

async function loadOne(
  root: string,
  file: string,
  src: Source,
): Promise<SkillDetail | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const id = idFor(root, file, src);
  const fallbackName = path.basename(path.dirname(file)).replace(/[-_]/g, " ");
  const name = String(meta.name ?? fallbackName);
  const description = String(meta.description ?? "");
  const category = categoryFor(root, file);
  const risk = typeof meta.risk === "string" ? meta.risk : undefined;
  return {
    id,
    name,
    description,
    category,
    source: src,
    path: file,
    risk,
    body,
    frontmatter: meta,
    word_count: body.split(/\s+/).filter(Boolean).length,
  };
}

export async function listSkills(): Promise<{
  skills: SkillSummary[];
  categories: { key: string; count: number }[];
}> {
  const all: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const { src, root } of SOURCES) {
    const files = await findSkillFiles(root);
    for (const f of files) {
      const detail = await loadOne(root, f, src);
      if (!detail) continue;
      if (seen.has(detail.id)) continue;
      seen.add(detail.id);
      // strip body for summary
      const {
        body: _body,
        frontmatter: _fm,
        word_count: _wc,
        ...summary
      } = detail;
      all.push(summary);
    }
  }
  all.sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
  const counts = new Map<string, number>();
  for (const s of all)
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  return { skills: all, categories };
}

export async function getSkill(id: string): Promise<SkillDetail | null> {
  // id format: "<src>:<relative-path>"
  const colon = id.indexOf(":");
  if (colon < 0) return null;
  const src = id.slice(0, colon) as Source;
  const rel = id.slice(colon + 1);
  const root =
    src === "hermes"
      ? HERMES_SKILLS_DIR
      : src === "user"
        ? USER_SKILLS_DIR
        : null;
  if (!root) return null;
  const file = path.resolve(root, rel === "root" ? "" : rel, "SKILL.md");
  const rootAbs = path.resolve(root);
  if (
    !file.startsWith(rootAbs + path.sep) &&
    file !== path.join(rootAbs, "SKILL.md")
  )
    return null;
  return loadOne(root, file, src);
}
