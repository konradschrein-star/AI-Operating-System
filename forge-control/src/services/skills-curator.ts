/**
 * Skills curator — ported lifecycle + consolidation pattern from
 * NousResearch/hermes-agent agent/curator.py (MIT).
 *
 * Two analyses, both read-only / suggestion-only (the UI confirms before
 * anything moves):
 *
 *  1. LIFECYCLE — classify each SKILL.md as active / stale / archive_candidate
 *     based on file mtime as a proxy for activity (the FS-backed skill bank
 *     doesn't yet have invocation tracking; mtime captures both Konrad's edits
 *     and his fleet workers' patches). Pinned skills + a small protected
 *     built-in list are exempt.
 *
 *  2. CONSOLIDATION — claude-pool review of the full skill catalog (name +
 *     description only, no bodies — keeps the prompt small). Reuses Hermes's
 *     prefix-cluster framing ("what is the umbrella class?") and three
 *     strategies: merge into existing, create new umbrella, demote to support.
 *
 * Neither action mutates the filesystem. The audit returns a structured
 * report; the UI surfaces suggestions and Konrad accepts them manually.
 */

import { stat } from "node:fs/promises";
import { listSkills, getSkill } from "../db/skills.ts";

const POOL_URL = process.env.CLAUDE_POOL_URL ?? "http://127.0.0.1:8092";
const POOL_KEY = process.env.CLAUDE_POOL_API_KEY ?? "";

const STALE_AFTER_DAYS = Number(process.env.CURATOR_STALE_AFTER_DAYS ?? "30");
const ARCHIVE_AFTER_DAYS = Number(
  process.env.CURATOR_ARCHIVE_AFTER_DAYS ?? "90",
);
// Claude needs real time on a 90+ skill catalog. 90s was too tight in
// practice (timed out on first deploy). Pool's hard cap is 600_000.
const CURATOR_TIMEOUT_MS = Number(process.env.CURATOR_TIMEOUT_MS ?? "180000");

// Built-ins that should never be archived/consolidated automatically.
//
// Three layers, all OR'd together:
//   1. DEFAULT_PROTECTED_IDS — hardcoded local-fallback. These are Konrad's
//      personal user:* skills; harmless on the VPS where USER_SKILLS_DIR is
//      empty, but they keep the local catalog safe out-of-the-box.
//   2. CURATOR_PROTECTED_IDS env var — comma-separated list, set per-host.
//      Use this on the VPS to protect specific hermes:* IDs the user
//      considers load-bearing.
//   3. frontmatter `protected: true` on the skill itself — per-skill escape
//      hatch that travels with the SKILL.md file. Same mechanic as `pinned`
//      but explicit about intent (pinned ≈ "show me first", protected ≈
//      "never suggest archiving").
const DEFAULT_PROTECTED_IDS = ["user:graphify", "user:gemini-video-review", "user:plan"];

function parseProtectedEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const PROTECTED_SKILL_IDS = new Set([
  ...DEFAULT_PROTECTED_IDS,
  ...parseProtectedEnv(process.env.CURATOR_PROTECTED_IDS),
]);

export type Lifecycle = "active" | "stale" | "archive_candidate" | "protected";

export interface SkillLifecycleEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  path: string;
  pinned: boolean;
  lifecycle: Lifecycle;
  last_touched_at: string;
  days_since_touch: number;
}

export interface ConsolidationSuggestion {
  from: string;
  into: string;
  strategy: "merge_into_existing" | "create_new_umbrella" | "demote_to_support";
  reason: string;
}

export interface CuratorAuditResult {
  generated_at: string;
  total_skills: number;
  lifecycle_summary: {
    active: number;
    stale: number;
    archive_candidate: number;
    protected: number;
  };
  lifecycle: SkillLifecycleEntry[];
  consolidations: ConsolidationSuggestion[];
  llm_used: boolean;
  llm_error?: string;
}

async function classifyLifecycle(): Promise<SkillLifecycleEntry[]> {
  const { skills } = await listSkills();
  const now = Date.now();
  const out: SkillLifecycleEntry[] = [];
  for (const s of skills) {
    let mtime = now;
    try {
      const st = await stat(s.path);
      mtime = st.mtimeMs;
    } catch {
      // file vanished between listSkills() and stat — skip silently
      continue;
    }
    // Need the full skill to read pinned: + protected: frontmatter
    const detail = await getSkill(s.id);
    const pinned =
      detail && typeof detail.frontmatter.pinned !== "undefined"
        ? String(detail.frontmatter.pinned).toLowerCase() === "true"
        : false;
    const frontmatterProtected =
      detail && typeof detail.frontmatter.protected !== "undefined"
        ? String(detail.frontmatter.protected).toLowerCase() === "true"
        : false;

    const days = Math.floor((now - mtime) / (1000 * 60 * 60 * 24));
    let lifecycle: Lifecycle;
    if (PROTECTED_SKILL_IDS.has(s.id) || pinned || frontmatterProtected) {
      lifecycle = "protected";
    } else if (days >= ARCHIVE_AFTER_DAYS) {
      lifecycle = "archive_candidate";
    } else if (days >= STALE_AFTER_DAYS) {
      lifecycle = "stale";
    } else {
      lifecycle = "active";
    }
    out.push({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      source: s.source,
      path: s.path,
      pinned,
      lifecycle,
      last_touched_at: new Date(mtime).toISOString(),
      days_since_touch: days,
    });
  }
  // Stalest first so the UI surfaces them prominently.
  out.sort((a, b) => b.days_since_touch - a.days_since_touch);
  return out;
}

/** claude-pool's /v1/run caps prompts at 10_000 chars (z.string().max(10_000)
 *  in apps/claude-pool/src/routes/run.ts). Leave a margin so the framing
 *  prose + JSON template doesn't get clipped. */
const PROMPT_CHAR_LIMIT = Number(process.env.CURATOR_PROMPT_CHAR_LIMIT ?? "9500");

function buildCatalog(
  entries: SkillLifecycleEntry[],
  descCap: number | null,
): string {
  // Catalog payload: id + name + (capped) description per skill. Body bytes
  // excluded. descCap=null → no description column at all (smallest form).
  return entries
    .filter((e) => e.lifecycle !== "protected")
    .map((e) => {
      if (descCap === null) {
        return `  - ${e.id} | ${e.name}`;
      }
      const desc =
        e.description.length > descCap
          ? e.description.slice(0, descCap).trimEnd() + "…"
          : e.description;
      return `  - ${e.id} | ${e.name} | ${desc}`;
    })
    .join("\n");
}

function buildConsolidationPrompt(entries: SkillLifecycleEntry[]): string {
  // Adaptive sizer: try richest catalog first, drop description detail
  // progressively until the assembled prompt fits the pool's char cap.
  // Steps: full description → 120-char cap → 60-char cap → name-only.
  // Special sentinel: `descCap === undefined` means "uncapped description";
  // `descCap === null` means "drop description entirely".
  const steps: (number | null | undefined)[] = [undefined, 120, 60, null];
  for (const descCap of steps) {
    const catalog = buildCatalog(
      entries,
      descCap === undefined ? Number.MAX_SAFE_INTEGER : descCap,
    );
    const prompt = renderPromptShell(catalog);
    if (prompt.length <= PROMPT_CHAR_LIMIT) return prompt;
  }
  // Even name-only overflowed — catalog is enormous. Return the name-only
  // form anyway; pool will 400 and the caller surfaces llm_error. The
  // lifecycle pass still works regardless.
  return renderPromptShell(buildCatalog(entries, null));
}

function renderPromptShell(catalog: string): string {
  return `You are a SKILL CATALOG CURATOR. The user maintains a personal library of agent SKILL.md files; many were written ad-hoc over months and the catalog has likely grown overlapping clusters that a thoughtful maintainer would consolidate.

HARD RULES:
- DO NOT touch bundled, pinned, or built-in skills (already filtered out below).
- DO NOT suggest deletion. Archiving is the maximum action you may suggest.
- Judge overlap on CONTENT — do NOT reject consolidation on grounds that "each skill has a distinct trigger". Subsections of an umbrella skill can still have distinct triggers.
- Skills with identical or near-identical descriptions are obvious merge targets.

WORKING METHOD:
Scan for PREFIX CLUSTERS — skills sharing a domain keyword in their id or name (e.g. \`hermes-config-*\`, \`gateway-*\`, \`tts-*\`). For each cluster with 2+ members, ask "what is the UMBRELLA CLASS here?" rather than "are these pairs overlapping?".

THREE CONSOLIDATION STRATEGIES:
1. MERGE INTO EXISTING (\`merge_into_existing\`): when one skill is clearly the umbrella, patch it with the others' content and archive the siblings.
2. CREATE NEW UMBRELLA (\`create_new_umbrella\`): when no single skill is the natural umbrella, propose a new title and treat the cluster as subsections.
3. DEMOTE TO SUPPORT (\`demote_to_support\`): when a skill is narrow and lives logically *under* another, move its content into references/templates/scripts of the umbrella.

CATALOG (only candidate skills shown — protected/pinned omitted):
${catalog}

OUTPUT FORMAT — return ONLY a JSON object, no prose, with this exact shape:

{
  "consolidations": [
    {
      "from": "<skill-id of the one being absorbed>",
      "into": "<skill-id or new title for the umbrella>",
      "strategy": "merge_into_existing" | "create_new_umbrella" | "demote_to_support",
      "reason": "<one sentence — why these belong together>"
    }
  ]
}

If you see no consolidation opportunities, return \`{"consolidations": []}\`.`;
}

async function callPoolForJson(
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs + 5_000);
  try {
    const res = await fetch(`${POOL_URL}/v1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": POOL_KEY,
      },
      body: JSON.stringify({ prompt, timeout_ms: timeoutMs }),
      signal: ac.signal,
    });
    const j = (await res.json().catch(() => ({}))) as {
      text?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(`pool ${res.status}: ${j.error ?? res.statusText}`);
    }
    if (typeof j.text !== "string") throw new Error("pool returned no text");
    return j.text;
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(raw: string): unknown {
  // Models occasionally wrap JSON in ```json fences or add preambles. Find
  // the first {...} block by brace counting and parse that.
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("no json object in model output");
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unterminated json object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

function isConsolidationSuggestion(x: unknown): x is ConsolidationSuggestion {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<ConsolidationSuggestion>;
  return (
    typeof r.from === "string" &&
    typeof r.into === "string" &&
    typeof r.reason === "string" &&
    (r.strategy === "merge_into_existing" ||
      r.strategy === "create_new_umbrella" ||
      r.strategy === "demote_to_support")
  );
}

async function reviewConsolidations(
  entries: SkillLifecycleEntry[],
): Promise<{ consolidations: ConsolidationSuggestion[]; error?: string }> {
  // Skip the LLM call entirely if there aren't enough candidates for clusters
  // to be meaningful. Hermes uses a similar floor.
  const candidates = entries.filter((e) => e.lifecycle !== "protected");
  if (candidates.length < 4) {
    return {
      consolidations: [],
      error: `only ${candidates.length} non-protected skills — skipping consolidation pass (need ≥4)`,
    };
  }

  if (!POOL_KEY) {
    return {
      consolidations: [],
      error: "CLAUDE_POOL_API_KEY not configured — skipping consolidation pass",
    };
  }

  const prompt = buildConsolidationPrompt(entries);
  try {
    const raw = await callPoolForJson(prompt, CURATOR_TIMEOUT_MS);
    const parsed = extractJsonObject(raw) as {
      consolidations?: unknown;
    };
    const list = Array.isArray(parsed.consolidations) ? parsed.consolidations : [];
    const valid = list.filter(isConsolidationSuggestion);
    return { consolidations: valid };
  } catch (e) {
    return {
      consolidations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runCuratorAudit(): Promise<CuratorAuditResult> {
  const lifecycle = await classifyLifecycle();
  const { consolidations, error } = await reviewConsolidations(lifecycle);

  const summary = lifecycle.reduce(
    (acc, e) => {
      acc[e.lifecycle]++;
      return acc;
    },
    { active: 0, stale: 0, archive_candidate: 0, protected: 0 },
  );

  return {
    generated_at: new Date().toISOString(),
    total_skills: lifecycle.length,
    lifecycle_summary: summary,
    lifecycle,
    consolidations,
    llm_used: !error,
    ...(error ? { llm_error: error } : {}),
  };
}
