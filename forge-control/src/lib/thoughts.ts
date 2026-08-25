/**
 * THOUGHTS store (PLAN.md §3.2, §4.3) — Konrad's idea pool, quotes and
 * dreams, held as frontmatter files in the vault. "These live in Obsidian" —
 * files ARE the store; Postgres is not a mirror of it.
 *
 * Built on top of lib/vault.ts's exported verbs (readVaultFile,
 * writeVaultFile with CAS). vault.ts deliberately does NOT export a verb
 * this store also needs — create-at-an-exact-path, and move — so both are
 * reimplemented here, narrowly, and disclosed rather than silently added to
 * vault.ts (which is owned by a different workstream this round):
 *
 *  - createNote() picks its own filename (title, sanitised, numbered on
 *    collision) and always prepends `# <name>\n\n` before the body, which
 *    breaks "frontmatter is the first four bytes of the file" — this store's
 *    entire parse contract. So new idea/seed files are written directly with
 *    an exclusive ("wx") open, exactly as createNote() does internally, at
 *    the exact `<created>-<slug>.md` path the spec requires.
 *  - adopt() MOVES a file (Forge/Thoughts/Seeds → Thoughts/Ideas). vault.ts's
 *    module doc is explicit that it has "no delete verb — not disabled,
 *    absent" (R8), by design. A move needs one. It is scoped as narrowly as
 *    the vault.ts pattern it borrows: snapshot the pre-move bytes FIRST
 *    (same directory/naming convention as vault.ts's snapshotBeforeWrite, so
 *    one retention story covers both), THEN write the destination with "wx"
 *    (never overwrites), and only if that succeeds remove the source.
 *
 * Both reuse resolveInVaultLocal() below, which mirrors vault.ts's
 * resolveInVault() lexical guard (dot segments, containment). It does not
 * re-derive the realpath/symlink guard vault.ts's two newest verbs add,
 * because every path this module writes to is built from constants
 * (thoughtsRoots()) plus a slug this module itself sanitises to
 * `[a-z0-9-]` — there is no untrusted path segment to escape through a
 * symlink in the first place, unlike the general-purpose vault routes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { readVaultFile, writeVaultFile, VaultConflictError } from "./vault.ts";
import { berlinDay, isDay, daysBetween, type Day } from "./day-score.ts";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const SNAPSHOT_DIR_DEFAULT = "/opt/ai-os/vault-snapshots";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Validation — thrown as ThoughtsValidationError so routes/thoughts.ts can
// map it to 400 with the field name in the message, per §4.3.
// ---------------------------------------------------------------------------

export class ThoughtsValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ThoughtsValidationError";
    this.field = field;
  }
}

export const AREAS = ["business", "youtube", "life", "health", "relationships"] as const;
export type Area = (typeof AREAS)[number];

export const STATUSES = ["not-started", "started", "executing", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

function assertArea(v: unknown): Area {
  if (typeof v !== "string" || !(AREAS as readonly string[]).includes(v)) {
    throw new ThoughtsValidationError(
      "area",
      `area must be one of ${AREAS.join(", ")}, got ${JSON.stringify(v)}`,
    );
  }
  return v as Area;
}

function assertImportance(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10) {
    throw new ThoughtsValidationError(
      "importance",
      `importance must be an integer 1..10, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

function assertStatus(v: unknown): Status {
  if (typeof v !== "string" || !(STATUSES as readonly string[]).includes(v)) {
    throw new ThoughtsValidationError(
      "status",
      `status must be one of ${STATUSES.join(", ")}, got ${JSON.stringify(v)}`,
    );
  }
  return v as Status;
}

function assertOneLine(field: string, v: unknown, required: boolean): string {
  if (v === undefined && !required) return "";
  if (typeof v !== "string" || v.trim() === "") {
    throw new ThoughtsValidationError(field, `${field} is required and must be a non-empty string`);
  }
  if (v.includes("\n")) {
    throw new ThoughtsValidationError(field, `${field} must be a single line`);
  }
  return v.trim();
}

function assertText(field: string, v: unknown): string {
  if (v === undefined) return "";
  if (typeof v !== "string") {
    throw new ThoughtsValidationError(field, `${field} must be a string, got ${typeof v}`);
  }
  return v.trim();
}

function assertCreated(v: unknown): Day {
  if (typeof v !== "string" || !isDay(v)) {
    throw new ThoughtsValidationError("created", `created must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Layout-aware roots. Legacy today; a later lane (B4) adds lib/vault-layout.ts
// and this function becomes the one place that changes to consume it — every
// other function in this module calls thoughtsRoots(), never a path literal.
// ---------------------------------------------------------------------------

export interface ThoughtsRoots {
  layout: "legacy" | "split";
  ideasDir: string;
  seedsDir: string;
  quotesPath: string;
  dreamsPath: string;
}

export function thoughtsRoots(): ThoughtsRoots {
  return {
    layout: "legacy",
    ideasDir: "Thoughts/Ideas",
    seedsDir: "Forge/Thoughts/Seeds",
    quotesPath: "Thoughts/Quotes.md",
    dreamsPath: "Thoughts/Dreams.md",
  };
}

// ---------------------------------------------------------------------------
// Path safety for the two verbs vault.ts does not provide (create-at-exact-
// path, move). Mirrors vault.ts's resolveInVault() — see module doc for why
// this is not the full resolveOrRefuse() (realpath/symlink) guard.
// ---------------------------------------------------------------------------

function resolveInVaultLocal(rel: string): string {
  const cleaned = rel.replace(/\\/g, "/");
  if (cleaned.split("/").some((seg) => seg.startsWith(".") && seg !== "")) {
    throw new Error(`vault path may not contain dot segments: ${rel}`);
  }
  if (!cleaned.toLowerCase().endsWith(".md")) {
    throw new Error(`only .md files are handled by the thoughts store: ${rel}`);
  }
  const abs = path.resolve(VAULT_DIR, cleaned);
  const root = path.resolve(VAULT_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`vault path escapes the vault: ${rel}`);
  }
  return abs;
}

/** List the `.md` files directly inside a vault-relative directory (non-
 *  recursive). A directory that does not exist yet reads as empty, not an
 *  error — a fresh vault has no Thoughts/Ideas/ until the first idea lands. */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const abs = path.resolve(VAULT_DIR, dir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    if (isEnoent(e)) return [];
    throw new Error(`could not list vault directory ${dir}: ${describe(e)}`, { cause: e });
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

async function createVaultFileExact(rel: string, content: string): Promise<void> {
  const abs = resolveInVaultLocal(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if (isEnoent(e) === false && (e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `a file already exists at ${rel} — this should be unreachable given uniqueFilename()'s collision check`,
      );
    }
    throw e;
  }
}

async function snapshotBeforeMove(rel: string, current: string): Promise<string> {
  const root = process.env.VAULT_SNAPSHOT_DIR ?? SNAPSHOT_DIR_DEFAULT;
  const day = berlinDay();
  const dir = path.join(root, day);
  const abs = path.join(
    dir,
    `${rel.split("/").join("__")}.${Date.now()}-${randomBytes(4).toString("hex")}.md`,
  );
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(abs, current, { encoding: "utf8", flag: "wx" });
    const landed = await fs.readFile(abs, "utf8");
    if (landed !== current) {
      throw new Error(
        `snapshot holds ${Buffer.byteLength(landed, "utf8")} bytes, the note held ${Buffer.byteLength(current, "utf8")}`,
      );
    }
  } catch (e) {
    throw new Error(`adopt snapshot failed for ${rel} — THE MOVE WAS NOT PERFORMED: ${describe(e)}`, {
      cause: e,
    });
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Filenames: <created>-<slug>.md, slug ascii, max 60 chars, collision suffix.
// ---------------------------------------------------------------------------

export function slugify(idea: string): string {
  const ascii = idea
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics stripped by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return ascii || "idea";
}

/** The filename a fresh idea/seed with this created day + idea line would
 *  get, BEFORE collision suffixing — exported so scripts/seed-thoughts.ts
 *  can check "have I already seeded this note" without duplicating the slug
 *  rule. */
export function previewFilename(created: string, idea: string): string {
  return `${created}-${slugify(idea)}.md`;
}

function uniqueFilename(existing: Set<string>, created: string, idea: string): string {
  const slug = slugify(idea);
  let name = `${created}-${slug}.md`;
  let n = 2;
  while (existing.has(name)) {
    name = `${created}-${slug}-${n}.md`;
    n++;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Idea document — frontmatter + two markdown sections.
// ---------------------------------------------------------------------------

export interface Idea {
  path: string;
  idea: string;
  area: Area;
  importance: number;
  status: Status;
  created: string;
  age_days: number;
  author: "konrad" | "forge";
  source: string;
  description: string;
  why_genius: string;
  sha256: string;
}

function renderBody(description: string, whyGenius: string): string {
  return `## Description\n${description.trim()}\n\n## Why it is genius\n${whyGenius.trim()}\n`;
}

function parseBody(body: string): { description: string; why_genius: string } {
  const descMatch = body.match(/^## Description\n([\s\S]*?)(?=\n## |\n?$)/m);
  const whyMatch = body.match(/^## Why it is genius\n([\s\S]*?)(?=\n## |\n?$)/m);
  return {
    description: descMatch ? descMatch[1].trim() : "",
    why_genius: whyMatch ? whyMatch[1].trim() : "",
  };
}

function parseIdeaFile(rel: string, raw: string, sha256: string): Idea {
  const { data, body } = parseFrontmatter(raw, rel);
  if (data.type !== "idea") {
    throw new Error(`frontmatter "type" must be "idea", got ${JSON.stringify(data.type)}: ${rel}`);
  }
  if (typeof data.idea !== "string" || data.idea.trim() === "") {
    throw new Error(`missing or empty "idea" field: ${rel}`);
  }
  const area = assertAreaOrThrowPlain(data.area, rel);
  if (typeof data.importance !== "number") {
    throw new Error(`missing or non-integer "importance" field: ${rel}`);
  }
  const status = assertStatusOrThrowPlain(data.status, rel);
  if (typeof data.created !== "string" || !isDay(data.created)) {
    throw new Error(`missing or invalid "created" field (want YYYY-MM-DD): ${rel}`);
  }
  if (data.author !== "konrad" && data.author !== "forge") {
    throw new Error(`"author" must be "konrad" or "forge", got ${JSON.stringify(data.author)}: ${rel}`);
  }
  if (typeof data.source !== "string" || data.source.trim() === "") {
    throw new Error(`missing or empty "source" field: ${rel}`);
  }
  const { description, why_genius } = parseBody(body);
  return {
    path: rel,
    idea: data.idea,
    area,
    importance: data.importance,
    status,
    created: data.created,
    age_days: daysBetween(data.created, berlinDay()),
    author: data.author,
    source: data.source,
    description,
    why_genius,
    sha256,
  };
}

// Plain (non-ThoughtsValidationError) variants for parsing files off disk —
// a corrupt FILE is not a bad API request, and list() wants a plain Error
// with the path in it to fold into errors[].
function assertAreaOrThrowPlain(v: unknown, rel: string): Area {
  if (typeof v !== "string" || !(AREAS as readonly string[]).includes(v)) {
    throw new Error(`"area" must be one of ${AREAS.join(", ")}, got ${JSON.stringify(v)}: ${rel}`);
  }
  return v as Area;
}
function assertStatusOrThrowPlain(v: unknown, rel: string): Status {
  if (typeof v !== "string" || !(STATUSES as readonly string[]).includes(v)) {
    throw new Error(`"status" must be one of ${STATUSES.join(", ")}, got ${JSON.stringify(v)}: ${rel}`);
  }
  return v as Status;
}

// ---------------------------------------------------------------------------
// Views.
// ---------------------------------------------------------------------------

export type ThoughtsView = "unexecuted" | "area" | "importance" | "executed";

function applyView(ideas: Idea[], view: string, area?: string): Idea[] {
  switch (view) {
    case "unexecuted":
      // His doctrine: "un-executed ideas are of course bullshit" — the
      // default view, oldest not-started idea first.
      return ideas.filter((i) => i.status === "not-started").sort((a, b) => b.age_days - a.age_days);
    case "area": {
      const a = assertArea(area);
      return ideas.filter((i) => i.area === a).sort((x, y) => y.age_days - x.age_days);
    }
    case "importance":
      return [...ideas].sort((a, b) => b.importance - a.importance || b.age_days - a.age_days);
    case "executed":
      return ideas
        .filter((i) => i.status === "started" || i.status === "executing" || i.status === "done")
        .sort((a, b) => b.age_days - a.age_days);
    default:
      throw new ThoughtsValidationError(
        "view",
        `view must be one of unexecuted, area, importance, executed, got ${JSON.stringify(view)}`,
      );
  }
}

export interface ListIdeasResult {
  ideas: Idea[];
  errors: { path: string; message: string }[];
  layout: "legacy" | "split";
}

export async function listIdeas(opts: { view?: string; area?: string } = {}): Promise<ListIdeasResult> {
  const roots = thoughtsRoots();
  const errors: { path: string; message: string }[] = [];
  const ideas: Idea[] = [];

  for (const dir of [roots.ideasDir, roots.seedsDir]) {
    const names = await listMarkdownFiles(dir);
    for (const name of names) {
      const rel = `${dir}/${name}`;
      try {
        const file = await readVaultFile(rel);
        ideas.push(parseIdeaFile(rel, file.content, file.sha256));
      } catch (e) {
        errors.push({ path: rel, message: describe(e) });
      }
    }
  }

  const view = opts.view ?? "unexecuted";
  const filtered = applyView(ideas, view, opts.area);
  return { ideas: filtered, errors, layout: roots.layout };
}

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

export interface CreateIdeaInput {
  idea: unknown;
  area: unknown;
  importance?: unknown;
  description?: unknown;
  why_genius?: unknown;
  status?: unknown;
  author: "konrad" | "forge";
  source: string;
  created?: unknown;
}

/** Shared by POST /api/thoughts/ideas (always author "konrad") and
 *  scripts/seed-thoughts.ts (always author "forge"). Directory follows
 *  author, per §3.2: Konrad's ideas in Thoughts/Ideas/, agent-derived seeds
 *  in Forge/Thoughts/Seeds/. */
export async function createIdeaFile(input: CreateIdeaInput): Promise<Idea> {
  const ideaLine = assertOneLine("idea", input.idea, true);
  const area = assertArea(input.area);
  const importance = input.importance === undefined ? 5 : assertImportance(input.importance);
  const status = input.status === undefined ? "not-started" : assertStatus(input.status);
  const description = assertText("description", input.description);
  const whyGenius = assertText("why_genius", input.why_genius);
  const created = input.created === undefined ? berlinDay() : assertCreated(input.created);

  const roots = thoughtsRoots();
  const dir = input.author === "konrad" ? roots.ideasDir : roots.seedsDir;
  const existing = new Set(await listMarkdownFiles(dir));
  const filename = uniqueFilename(existing, created, ideaLine);
  const rel = `${dir}/${filename}`;

  const data: Record<string, string | number> = {
    type: "idea",
    idea: ideaLine,
    area,
    importance,
    status,
    created,
    author: input.author,
    source: input.source,
  };
  const raw = serializeFrontmatter(data, renderBody(description, whyGenius));
  await createVaultFileExact(rel, raw);
  const file = await readVaultFile(rel);
  return parseIdeaFile(rel, file.content, file.sha256);
}

// ---------------------------------------------------------------------------
// Update (CAS) and adopt (move).
// ---------------------------------------------------------------------------

export interface UpdateIdeaInput {
  path: unknown;
  base_sha256: unknown;
  idea?: unknown;
  area?: unknown;
  importance?: unknown;
  status?: unknown;
  description?: unknown;
  why_genius?: unknown;
}

export async function updateIdea(input: UpdateIdeaInput): Promise<Idea> {
  if (typeof input.path !== "string" || input.path.trim() === "") {
    throw new ThoughtsValidationError("path", "path is required");
  }
  if (typeof input.base_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.base_sha256)) {
    throw new ThoughtsValidationError(
      "base_sha256",
      "base_sha256 required as 64 lowercase hex characters",
    );
  }
  const current = await readVaultFile(input.path);
  const existing = parseIdeaFile(input.path, current.content, current.sha256);
  const { data } = parseFrontmatter(current.content, input.path);

  const next: Record<string, string | number> = { ...data };
  if (input.idea !== undefined) next.idea = assertOneLine("idea", input.idea, true);
  if (input.area !== undefined) next.area = assertArea(input.area);
  if (input.importance !== undefined) next.importance = assertImportance(input.importance);
  if (input.status !== undefined) next.status = assertStatus(input.status);

  const description = input.description !== undefined ? assertText("description", input.description) : existing.description;
  const whyGenius = input.why_genius !== undefined ? assertText("why_genius", input.why_genius) : existing.why_genius;

  const raw = serializeFrontmatter(next, renderBody(description, whyGenius));
  const result = await writeVaultFile({ path: input.path, content: raw, baseSha256: input.base_sha256 });
  return parseIdeaFile(result.path, raw, result.sha256);
}

/** Move a Forge seed to Thoughts/Ideas/ and set author: konrad — "the
 *  correction" (§3.2). See module doc for why this reimplements a scoped
 *  move rather than extending vault.ts. */
export async function adoptIdea(relPath: unknown): Promise<Idea> {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new ThoughtsValidationError("path", "path is required");
  }
  const roots = thoughtsRoots();
  if (!relPath.startsWith(roots.seedsDir + "/")) {
    throw new ThoughtsValidationError(
      "path",
      `adopt only accepts a seed under ${roots.seedsDir}/, got ${relPath}`,
    );
  }

  const current = await readVaultFile(relPath);
  const { data, body } = parseFrontmatter(current.content, relPath);
  const nextData = { ...data, author: "konrad", source: "konrad" };
  const raw = serializeFrontmatter(nextData, body);

  const filename = relPath.slice(roots.seedsDir.length + 1);
  const destRel = `${roots.ideasDir}/${filename}`;
  const destAbs = resolveInVaultLocal(destRel);
  const srcAbs = resolveInVaultLocal(relPath);

  const snapshot = await snapshotBeforeMove(relPath, current.content);

  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    await fs.writeFile(destAbs, raw, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `adopt destination already exists: ${destRel} — source left untouched, snapshot at ${snapshot}`,
      );
    }
    throw e;
  }
  try {
    await fs.rm(srcAbs);
  } catch (e) {
    throw new Error(
      `adopt wrote ${destRel} but could not remove the source seed ${relPath}: ${describe(e)} — ` +
        `both files now exist; remove ${relPath} by hand. Pre-move snapshot at ${snapshot}.`,
      { cause: e },
    );
  }

  const file = await readVaultFile(destRel);
  return parseIdeaFile(destRel, file.content, file.sha256);
}

export { VaultConflictError };

// ---------------------------------------------------------------------------
// Quotes / dreams — append-only lines, `- "text" — source (YYYY-MM-DD)` for
// quotes (source defaults to "konrad" so the field is always populated, per
// the §4.3 response shape); dreams never carry a source segment.
// ---------------------------------------------------------------------------

export interface ListLine {
  text: string;
  date: string;
}
export interface QuoteLine extends ListLine {
  source: string;
}

const LINE_WITH_SOURCE_RE = /^- "((?:[^"\\]|\\.)*)" — (.+) \((\d{4}-\d{2}-\d{2})\)$/;
const LINE_NO_SOURCE_RE = /^- "((?:[^"\\]|\\.)*)" \((\d{4}-\d{2}-\d{2})\)$/;

function escapeLineText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function unescapeLineText(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function renderListLine(text: string, date: string, source?: string): string {
  const escaped = escapeLineText(text);
  return source ? `- "${escaped}" — ${source} (${date})` : `- "${escaped}" (${date})`;
}

function parseListLine(line: string, rel: string, lineNo: number): { text: string; source: string | null; date: string } {
  let m = line.match(LINE_WITH_SOURCE_RE);
  if (m) return { text: unescapeLineText(m[1]), source: m[2], date: m[3] };
  m = line.match(LINE_NO_SOURCE_RE);
  if (m) return { text: unescapeLineText(m[1]), source: null, date: m[2] };
  throw new Error(`malformed list line ${lineNo} in ${rel}: ${JSON.stringify(line)}`);
}

const appendChains = new Map<string, Promise<unknown>>();
function serialiseAppend<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = appendChains.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  appendChains.set(key, tail);
  void tail.then(() => {
    if (appendChains.get(key) === tail) appendChains.delete(key);
  });
  return result;
}

async function appendListFile(relPath: string, line: string): Promise<void> {
  const abs = resolveInVaultLocal(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await serialiseAppend(abs, async () => {
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e) {
      if (!isEnoent(e)) throw e;
      content = "";
    }
    const next = content === "" || content.endsWith("\n") ? content + line + "\n" : content + "\n" + line + "\n";
    const tmp = `${abs}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(tmp, next, { encoding: "utf8", flag: "wx" });
      await fs.rename(tmp, abs);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  });
}

async function listListFile(relPath: string): Promise<{ text: string; source: string | null; date: string }[]> {
  let content: string;
  try {
    const file = await readVaultFile(relPath);
    content = file.content;
  } catch (e) {
    if (isEnoent(e)) return [];
    throw e;
  }
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, i) => parseListLine(line, relPath, i + 1));
}

export async function listQuotes(): Promise<QuoteLine[]> {
  const roots = thoughtsRoots();
  const rows = await listListFile(roots.quotesPath);
  return rows.map((r) => ({ text: r.text, source: r.source ?? "konrad", date: r.date }));
}

export async function addQuote(input: { text: unknown; source?: unknown }): Promise<QuoteLine> {
  const text = assertOneLine("text", input.text, true);
  const source = input.source === undefined ? "konrad" : assertOneLine("source", input.source, true);
  const date = berlinDay();
  const roots = thoughtsRoots();
  await appendListFile(roots.quotesPath, renderListLine(text, date, source));
  return { text, source, date };
}

export async function listDreams(): Promise<ListLine[]> {
  const roots = thoughtsRoots();
  const rows = await listListFile(roots.dreamsPath);
  return rows.map((r) => ({ text: r.text, date: r.date }));
}

export async function addDream(input: { text: unknown }): Promise<ListLine> {
  const text = assertOneLine("text", input.text, true);
  const date = berlinDay();
  const roots = thoughtsRoots();
  await appendListFile(roots.dreamsPath, renderListLine(text, date));
  return { text, date };
}
