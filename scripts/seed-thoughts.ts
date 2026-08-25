#!/usr/bin/env -S node --import tsx
/**
 * scripts/seed-thoughts.ts — derive THOUGHTS seeds from real vault sources
 * so the page is full before Konrad ever opens it (PLAN.md §3.2).
 *
 * --dry-run (default): print every candidate seed and whether it would be
 *   written or skipped. Writes nothing.
 * --apply: write the seeds that survive the dedup check into
 *   Forge/Thoughts/Seeds/ via lib/thoughts.ts's createIdeaFile({author:"forge"}).
 *
 *   cd <worktree> && npx tsx scripts/seed-thoughts.ts             # dry-run
 *   cd <worktree> && npx tsx scripts/seed-thoughts.ts --apply
 *
 * Sources (every seed's frontmatter says which note it came from —
 * `source: derived:<vault path>`):
 *  A. The four root Project notes — one seed each, idea = the note's own
 *     first "# " heading (falls back to the filename).
 *  B. Bullets in Mentor/Profile/Goals & Aspirations.md that have no
 *     similarly-titled row in GET /api/daily/goals (read-only; brief §B3
 *     names this exact comparison — FORGE_CONTROL_URL defaults to
 *     http://127.0.0.1:7700, the live forge-control API already running on
 *     this box). Similarity is a normalised substring/word-overlap
 *     heuristic (see isSimilarToAnyGoal): a false NEGATIVE (missed match,
 *     re-seeded) is safer than a false POSITIVE (a real new idea silently
 *     dropped), and --dry-run exists precisely so a human eyeballs the
 *     result before anything is written.
 *  C. Inbox/*.md — one seed per file.
 *  D. Vault-root notes tagged #idea — one seed per file (root scan only,
 *     matching how Konrad himself describes the vault in this project's
 *     brief: "~70 loose .md files" at the root).
 *
 * Importance — PLAN.md §3.2 names three: Goals & Aspirations bullet → 7,
 * Project note → 6, Inbox → 4. It names no rule for the fourth source
 * (#idea-tagged root notes); this script's own default for that case is 5
 * (the same mid-point createIdeaFile() applies to an unspecified idea), and
 * every such line says so explicitly in its dry-run output.
 *
 * description = the first paragraph; why_genius = the sentence containing
 * "because"/"why" if one exists, else the sentence right after the title.
 *
 * area is not named by the brief for ANY source, but every idea requires
 * one (§3.2 schema has no default). guessArea() below is a disclosed,
 * keyword-based heuristic — Project notes are hardcoded "youtube" (all four
 * are unambiguously about the YouTube content pipeline); everything else
 * runs through the keyword guess. Reviewed in --dry-run before it ever
 * writes.
 *
 * Idempotent by construction, not by a separate "already seeded" ledger:
 * created = the note's own date_created/created frontmatter value, or the
 * file's mtime — a lenient, best-effort read (see extractDateCreated();
 * these are ARBITRARY human notes, not this store's own frontmatter, so a
 * missing/odd block is normal and never throws) — plus the idea's slug
 * predicts the SAME filename every run via lib/thoughts.ts's
 * previewFilename(). A filename already present in Forge/Thoughts/Seeds/ is
 * skipped rather than suffixed into a duplicate.
 */

import path from "node:path";

import {
  createIdeaFile,
  listMarkdownFiles,
  previewFilename,
  thoughtsRoots,
  type Area,
} from "../forge-control/src/lib/thoughts.ts";
import { readVaultFile } from "../forge-control/src/lib/vault.ts";
import { berlinDay } from "../forge-control/src/lib/day-score.ts";

const APPLY = process.argv.includes("--apply");
const FORGE_CONTROL_URL = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

const PROJECT_NOTES = [
  "Project - AI Stories.md",
  "Project - Search-Based Content Engine.md",
  "Project - Tutorials.md",
  "Project - YTA.md",
];
const ASPIRATIONS_NOTE = "Mentor/Profile/Goals & Aspirations.md";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Lenient extraction from ARBITRARY human notes. Deliberately NOT
// lib/frontmatter.ts, which is strict on purpose for this store's own
// documents — these source notes routinely have no frontmatter at all, or a
// different vocabulary entirely (type: profile, section: goals, …).
// ---------------------------------------------------------------------------

function extractDateCreated(raw: string): string | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(?:date_created|created):\s*"?(\d{4}-\d{2}-\d{2})/);
    if (kv) return kv[1];
  }
  return null;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function firstTitle(raw: string): string | null {
  const m = stripFrontmatter(raw).match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function firstParagraph(raw: string): string {
  const body = stripFrontmatter(raw).replace(/^#[^\n]*\n+/, "");
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return para ?? "";
}

/** The sentence mentioning "because"/"why" if one exists, else the sentence
 *  right after the title line — good enough for a proposal a human reviews
 *  in --dry-run before anything is written. */
function whyGenius(raw: string): string {
  const body = stripFrontmatter(raw);
  const sentences = body
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const because = sentences.find((s) => /\bbecause\b/i.test(s) || /\bwhy\b/i.test(s));
  if (because) return because;
  const titleIdx = sentences.findIndex((s) => s.startsWith("#"));
  return sentences[titleIdx + 1] ?? sentences[1] ?? sentences[0] ?? "";
}

function guessArea(text: string): Area {
  if (/\byoutube\b|\bchannel\b|\bvideo\b|\bcontent\b|\btutorial/i.test(text)) return "youtube";
  if (/\bhealth\b|\bglucose\b|\bsleep\b|\bworkout\b|\bfitness\b/i.test(text)) return "health";
  if (/\bfriend|\bpartner|\bfamily|\brelationship/i.test(text)) return "relationships";
  if (/\bbusiness\b|\brevenue\b|\bclient|\bva\b|\bmoney\b|\bcyprus\b|\bllc\b/i.test(text)) return "business";
  return "life";
}

function stripTags(s: string): string {
  return s.replace(/\[EVIDENCE:[^\]]*\]|\[INFERRED[^\]]*\]/gi, "").trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** False negative (missed match → re-seeded) is the safe direction here;
 *  --dry-run is where a human catches the rest. */
function isSimilarToAnyGoal(bulletText: string, goalTitles: string[]): boolean {
  const nb = normalize(bulletText);
  for (const title of goalTitles) {
    const nt = normalize(title);
    if (nt.length < 4) continue;
    if (nb.includes(nt) || nt.includes(nb)) return true;
    const bWords = new Set(nb.split(" "));
    const tWords = new Set(nt.split(" "));
    const overlap = [...tWords].filter((w) => w.length > 3 && bWords.has(w)).length;
    const union = new Set([...bWords, ...tWords]).size;
    if (union > 0 && overlap / union >= 0.5) return true;
  }
  return false;
}

interface Candidate {
  source: string;
  idea: string;
  area: Area;
  importance: number;
  description: string;
  why_genius: string;
  created: string;
  note: string;
}

async function fetchGoalTitles(): Promise<string[]> {
  const url = `${FORGE_CONTROL_URL}/api/daily/goals`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `GET ${url} failed — cannot dedup Goals & Aspirations bullets against life_goals without it: ${describe(e)}`,
      { cause: e },
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { ok?: boolean; goals?: { title: string }[] };
  if (!json.ok || !Array.isArray(json.goals)) {
    throw new Error(`GET ${url} did not return {ok:true, goals:[...]}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.goals.map((g) => g.title);
}

async function projectNoteCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const rel of PROJECT_NOTES) {
    let file;
    try {
      file = await readVaultFile(rel);
    } catch (e) {
      console.error(`[seed-thoughts] could not read "${rel}": ${describe(e)} — skipped`);
      continue;
    }
    const idea = (firstTitle(file.content) ?? rel.replace(/\.md$/, "")).slice(0, 200);
    const created = extractDateCreated(file.content) ?? berlinDay(new Date(file.mtimeMs));
    out.push({
      source: rel,
      idea,
      area: "youtube",
      importance: 6,
      description: firstParagraph(file.content),
      why_genius: whyGenius(file.content),
      created,
      note: "importance 6 (Project note, PLAN.md §3.2); area youtube (hardcoded — all four project notes are about the YouTube content pipeline)",
    });
  }
  return out;
}

const BULLET_RE = /^-\s+(?:\*\*(.+?)\*\*\s*[—-]?\s*)?(.*)$/;

async function aspirationsCandidates(goalTitles: string[]): Promise<Candidate[]> {
  let file;
  try {
    file = await readVaultFile(ASPIRATIONS_NOTE);
  } catch (e) {
    console.error(`[seed-thoughts] could not read "${ASPIRATIONS_NOTE}": ${describe(e)} — skipped`);
    return [];
  }
  const created = extractDateCreated(file.content) ?? berlinDay(new Date(file.mtimeMs));
  const out: Candidate[] = [];
  for (const rawLine of file.content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("- ")) continue;
    const m = trimmed.match(BULLET_RE);
    if (!m) continue;
    const boldTitle = m[1] ? stripTags(m[1]) : "";
    const rest = stripTags(m[2] ?? "");
    const bulletText = boldTitle ? `${boldTitle} — ${rest}`.trim() : rest;
    if (!bulletText) continue;
    // Bold markers survive stripTags() when they sit mid-sentence rather than
    // at the head of the bullet (stripTags only removes [EVIDENCE:]/[INFERRED]
    // tags) — an idea line is a title, not markdown, so clean them here.
    const idea = (boldTitle || bulletText).replace(/\*\*/g, "").slice(0, 200);
    if (isSimilarToAnyGoal(idea, goalTitles)) {
      console.log(`[seed-thoughts] SKIP (already a life_goals row) — "${idea}"`);
      continue;
    }
    out.push({
      source: ASPIRATIONS_NOTE,
      idea,
      area: guessArea(bulletText),
      importance: 7,
      description: bulletText,
      why_genius: /\bbecause\b/i.test(bulletText) ? bulletText : "",
      created,
      note: "importance 7 (Goals & Aspirations bullet, PLAN.md §3.2); no matching life_goals title found",
    });
  }
  return out;
}

async function inboxCandidates(): Promise<Candidate[]> {
  const names = await listMarkdownFiles("Inbox");
  const out: Candidate[] = [];
  for (const name of names) {
    const rel = `Inbox/${name}`;
    let file;
    try {
      file = await readVaultFile(rel);
    } catch (e) {
      console.error(`[seed-thoughts] could not read "${rel}": ${describe(e)} — skipped`);
      continue;
    }
    const idea = (firstTitle(file.content) ?? name.replace(/\.md$/, "")).slice(0, 200);
    const description = firstParagraph(file.content);
    out.push({
      source: rel,
      idea,
      area: guessArea(`${idea} ${description}`),
      importance: 4,
      description,
      why_genius: whyGenius(file.content),
      created: extractDateCreated(file.content) ?? berlinDay(new Date(file.mtimeMs)),
      note: "importance 4 (Inbox capture, PLAN.md §3.2)",
    });
  }
  return out;
}

async function ideaTaggedCandidates(exclude: Set<string>): Promise<Candidate[]> {
  const names = await listMarkdownFiles("");
  const out: Candidate[] = [];
  for (const name of names) {
    if (exclude.has(name)) continue;
    let file;
    try {
      file = await readVaultFile(name);
    } catch (e) {
      console.error(`[seed-thoughts] could not read "${name}": ${describe(e)} — skipped`);
      continue;
    }
    if (!/#idea\b/.test(file.content)) continue;
    const idea = (firstTitle(file.content) ?? name.replace(/\.md$/, "")).slice(0, 200);
    const description = firstParagraph(file.content);
    out.push({
      source: name,
      idea,
      area: guessArea(`${idea} ${description}`),
      importance: 5,
      description,
      why_genius: whyGenius(file.content),
      created: extractDateCreated(file.content) ?? berlinDay(new Date(file.mtimeMs)),
      note: "importance 5 (#idea-tagged root note — PLAN.md names no rule for this source; this script's own default)",
    });
  }
  return out;
}

async function main(): Promise<void> {
  const roots = thoughtsRoots();
  const vaultDir = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
  const existingSeeds = new Set(await listMarkdownFiles(roots.seedsDir));

  const goalTitles = await fetchGoalTitles();

  const candidates: Candidate[] = [
    ...(await projectNoteCandidates()),
    ...(await aspirationsCandidates(goalTitles)),
    ...(await inboxCandidates()),
    ...(await ideaTaggedCandidates(new Set(PROJECT_NOTES))),
  ];

  console.log(
    `[seed-thoughts] mode=${APPLY ? "APPLY" : "DRY-RUN"} vault=${vaultDir} forge-control=${FORGE_CONTROL_URL} ` +
      `life_goals=${goalTitles.length} existing_seeds=${existingSeeds.size} candidates=${candidates.length}`,
  );

  let written = 0;
  let skipped = 0;
  for (const c of candidates) {
    const filename = previewFilename(c.created, c.idea);
    const rel = `${roots.seedsDir}/${filename}`;
    const already = existingSeeds.has(filename);
    const verb = already ? "SKIP (already seeded)" : APPLY ? "WRITE" : "WOULD WRITE";
    console.log(
      `[seed-thoughts] ${verb} ${rel} — idea=${JSON.stringify(c.idea)} area=${c.area} ` +
        `importance=${c.importance} created=${c.created} source=derived:${c.source} (${c.note})`,
    );
    if (already) {
      skipped++;
      continue;
    }
    if (!APPLY) {
      skipped++;
      continue;
    }
    try {
      const idea = await createIdeaFile({
        idea: c.idea,
        area: c.area,
        importance: c.importance,
        description: c.description,
        why_genius: c.why_genius,
        author: "forge",
        source: `derived:${c.source}`,
        created: c.created,
      });
      existingSeeds.add(path.basename(idea.path));
      written++;
    } catch (e) {
      console.error(`[seed-thoughts] FAILED to write seed for "${c.source}": ${describe(e)}`);
    }
  }

  console.log(
    `[seed-thoughts] done — ${written} written, ${skipped} skipped` +
      (APPLY ? "" : " (dry-run — pass --apply to write)"),
  );
}

main().catch((e) => {
  console.error(`[seed-thoughts] fatal: ${describe(e)}`);
  process.exitCode = 1;
});
