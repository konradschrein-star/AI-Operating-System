/**
 * Skills (SKILL.md catalog) data access.
 *
 * Skills live as SKILL.md files under one of several roots. Each has YAML
 * frontmatter with at least name + description; we parse only those + body.
 *
 * Roots scanned (first existing wins per id):
 *  - HERMES_SKILLS_DIR (default /var/lib/docker/volumes/...skills) — Hermes
 *    docker volume that the fleet workers mount, categorized in subdirs.
 *  - USER_SKILLS_DIR (default /root/.claude/skills) — the actual flat
 *    directory Claude Code's CLI scans on every run to build the "available
 *    skills" listing injected into agent system prompts. It contains a mix
 *    of real skill directories AND symlinks (some flattened re-exports of
 *    HERMES_SKILLS_DIR entries, named `hermes--<category>-<name>`, some
 *    pointing at /opt/ai-os/skills-src/*). We follow symlinks when walking
 *    this root but skip any that resolve back into HERMES_SKILLS_DIR, since
 *    those are already catalogued once via the hermes root and would
 *    otherwise double-count.
 *
 * Enablement (governance): whether a skill is injected into agent context is
 * tracked in a small JSON manifest (SKILLS_MANIFEST_PATH) and mirrored onto
 * disk by physically moving the skill's entry in USER_SKILLS_DIR into
 * CLAUDE_SKILLS_DISABLED_DIR — that's the only thing that actually removes it
 * from what Claude Code's CLI scans. The manifest is the source of truth for
 * the `enabled` field callers see; the filesystem move is best-effort and its
 * outcome is reported back explicitly (see setSkillEnabled).
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const HERMES_SKILLS_DIR =
  process.env.HERMES_SKILLS_DIR ??
  "/var/lib/docker/volumes/hermes-workspace_hermes-agent-data/_data/skills";
const USER_SKILLS_DIR =
  process.env.USER_SKILLS_DIR ?? "/root/.claude/skills";
const CLAUDE_SKILLS_DISABLED_DIR =
  process.env.CLAUDE_SKILLS_DISABLED_DIR ?? "/root/.claude/skills-disabled";
const SKILLS_MANIFEST_PATH =
  process.env.SKILLS_MANIFEST_PATH ?? "/opt/ai-os/config/skills-manifest.json";

type Source = "hermes" | "user";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  source: Source;
  path: string;
  risk?: string;
  enabled: boolean;
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

/* ----------------------------------------------------------------------------
 * Enablement manifest — persisted disabled-id list + per-skill overrides.
 * -------------------------------------------------------------------------- */

interface SkillsManifest {
  disabled: string[];
  overrides: Record<string, { notes?: string; disabled_at?: string }>;
}

async function loadManifest(): Promise<SkillsManifest> {
  let raw: string;
  try {
    raw = await readFile(SKILLS_MANIFEST_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { disabled: [], overrides: {} };
    }
    throw new Error(
      `failed to read skills manifest at ${SKILLS_MANIFEST_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `skills manifest at ${SKILLS_MANIFEST_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const p = parsed as Partial<SkillsManifest>;
  return {
    disabled: Array.isArray(p.disabled) ? p.disabled.filter((x) => typeof x === "string") : [],
    overrides: p.overrides && typeof p.overrides === "object" ? p.overrides : {},
  };
}

async function saveManifest(m: SkillsManifest): Promise<void> {
  await mkdir(path.dirname(SKILLS_MANIFEST_PATH), { recursive: true });
  const tmpPath = `${SKILLS_MANIFEST_PATH}.tmp-${process.pid}`;
  await writeFile(
    tmpPath,
    JSON.stringify({ ...m, updated_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  await rename(tmpPath, SKILLS_MANIFEST_PATH);
}

/** Physical entry name for a skill id inside USER_SKILLS_DIR / its disabled
 *  mirror. "hermes:" ids map onto Claude Code's flattened symlink naming
 *  (`hermes--<category>-<name>`); "user:" ids are already relative to
 *  USER_SKILLS_DIR so the id's path segment IS the entry name. */
function entryNameForId(id: string): string {
  const colon = id.indexOf(":");
  const src = id.slice(0, colon);
  const rel = id.slice(colon + 1);
  if (src === "hermes") return `hermes--${rel.replace(/\//g, "-")}`;
  return rel;
}

/** Flip a skill's enabled state: persists to the manifest (authoritative —
 *  this is what listSkills()/getSkill() report) and best-effort mirrors the
 *  change onto disk by moving the skill's entry between USER_SKILLS_DIR and
 *  CLAUDE_SKILLS_DISABLED_DIR. If the entry isn't where expected (already
 *  moved out of band, or a "hermes:" id whose flattened name doesn't exist on
 *  this host), the manifest write still lands and `symlink_moved: false` is
 *  returned so the caller can surface the mismatch instead of claiming a
 *  clean success. */
export async function setSkillEnabled(
  id: string,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean; entry_name: string; symlink_moved: boolean }> {
  const manifest = await loadManifest();
  const disabledSet = new Set(manifest.disabled);
  if (enabled) disabledSet.delete(id);
  else disabledSet.add(id);
  await saveManifest({ ...manifest, disabled: [...disabledSet] });

  const entryName = entryNameForId(id);
  const activePath = path.join(USER_SKILLS_DIR, entryName);
  const disabledPath = path.join(CLAUDE_SKILLS_DISABLED_DIR, entryName);
  const [from, to] = enabled ? [disabledPath, activePath] : [activePath, disabledPath];
  let symlinkMoved = false;
  try {
    await lstat(from); // lstat, not stat: a broken symlink must still count as "present to move"
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    symlinkMoved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { id, enabled, entry_name: entryName, symlink_moved: symlinkMoved };
}

/** Top-level-only YAML frontmatter parser (no nested maps/lists beyond a
 *  single `[a, b]` flow sequence) — enough for `name`/`description`/`risk`,
 *  which is all callers read. Handles block scalars (`key: |` literal,
 *  `key: >` folded, optional `-`/`+` chomp indicator) since several SKILL.md
 *  files wrap long descriptions that way; a naive line-regex previously
 *  captured just the `|`/`>` marker and discarded the indented lines under
 *  it (e.g. macos-computer-use's description rendered as a literal "|"). */
function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: raw };
  const lines = m[1].split("\n");
  const meta: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1].trim();
    const rest = kv[2].trim();
    const blockMatch = rest.match(/^([|>])[+-]?\s*$/);
    if (blockMatch) {
      const style = blockMatch[1];
      const blockLines: string[] = [];
      let blockIndent: number | null = null;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          blockLines.push("");
          i++;
          continue;
        }
        const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
        if (blockIndent === null) {
          if (indent === 0) break; // no indented content follows — empty scalar
          blockIndent = indent;
        }
        if (indent < blockIndent) break;
        blockLines.push(l.slice(blockIndent));
        i++;
      }
      while (blockLines.length && blockLines[blockLines.length - 1] === "") {
        blockLines.pop(); // default ("clip") chomping — drop trailing blanks
      }
      meta[key] = style === ">" ? blockLines.join(" ").trim() : blockLines.join("\n");
      continue;
    }
    let val: unknown = rest.replace(/^["']|["']$/g, "");
    if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    meta[key] = val;
    i++;
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** Walk a roots tree and return every SKILL.md path (relative to root).
 *  Follows symlinks (USER_SKILLS_DIR is almost entirely symlinks — to the
 *  Hermes docker volume, flattened, and to /opt/ai-os/skills-src/*) via
 *  `stat` rather than the dirent's own (unresolved) type. When walking a
 *  root other than HERMES_SKILLS_DIR, a symlink that resolves back inside
 *  HERMES_SKILLS_DIR is skipped — it's the same skill already catalogued via
 *  the hermes root under a different id, and counting it twice would inflate
 *  every total by up to 91. */
async function findSkillFiles(root: string, maxDepth = 5): Promise<string[]> {
  const out: string[] = [];
  const skipHermesDupes = path.resolve(root) !== path.resolve(HERMES_SKILLS_DIR);
  let hermesRoot: string | null = null;
  if (skipHermesDupes) {
    try {
      hermesRoot = await realpath(HERMES_SKILLS_DIR);
    } catch {
      hermesRoot = null; // hermes root doesn't exist here — nothing to dedupe against
    }
  }
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      let isDir: boolean;
      let isFile: boolean;
      if (e.isSymbolicLink()) {
        if (hermesRoot) {
          try {
            const real = await realpath(full);
            if (real === hermesRoot || real.startsWith(hermesRoot + path.sep)) continue;
          } catch {
            continue; // broken symlink
          }
        }
        try {
          const st = await stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken symlink
        }
      } else {
        isDir = e.isDirectory();
        isFile = e.isFile();
      }
      if (isDir) {
        await walk(full, depth + 1);
      } else if (isFile && e.name === "SKILL.md") {
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
  disabledIds: Set<string>,
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
    enabled: !disabledIds.has(id),
    body,
    frontmatter: meta,
    word_count: body.split(/\s+/).filter(Boolean).length,
  };
}

export async function listSkills(): Promise<{
  skills: SkillSummary[];
  categories: { key: string; count: number; enabled_count: number }[];
}> {
  const manifest = await loadManifest();
  const disabledIds = new Set(manifest.disabled);
  const all: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const { src, root } of SOURCES) {
    const files = await findSkillFiles(root);
    for (const f of files) {
      const detail = await loadOne(root, f, src, disabledIds);
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
  const counts = new Map<string, { count: number; enabled: number }>();
  for (const s of all) {
    const c = counts.get(s.category) ?? { count: 0, enabled: 0 };
    c.count++;
    if (s.enabled) c.enabled++;
    counts.set(s.category, c);
  }
  const categories = [...counts.entries()]
    .map(([key, v]) => ({ key, count: v.count, enabled_count: v.enabled }))
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
  const manifest = await loadManifest();
  return loadOne(root, file, src, new Set(manifest.disabled));
}

/* ----------------------------------------------------------------------------
 * Token-cost estimate — what the enabled catalog actually costs per agent
 * turn. Claude Code's own listing (one "- <name>: <one-line description>" row
 * per skill, exactly the "available skills" system-reminder every run gets)
 * is the thing we're approximating; there's no tokenizer dependency in this
 * package, so we use the standard ~4-chars-per-token estimate for English
 * prose, which is what every context-budget conversation about GPT/Claude
 * style BPE tokenizers uses when an exact count isn't available.
 * -------------------------------------------------------------------------- */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function skillListingLine(s: Pick<SkillSummary, "name" | "description">): string {
  return `- ${s.name}: ${s.description || "no description"}`;
}

export function estimateCatalogTokens(skills: SkillSummary[]): number {
  if (skills.length === 0) return 0;
  return estimateTokens(skills.map(skillListingLine).join("\n"));
}
