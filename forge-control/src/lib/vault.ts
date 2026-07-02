/**
 * Obsidian vault writer — the OS's first WRITE path into the second brain.
 *
 * Design constraints:
 *  - Append-or-create ONLY. This module can never delete or truncate a
 *    note; worst case it appends a duplicate line. Overwrite is not
 *    exposed at all.
 *  - Every path is resolved inside OBSIDIAN_VAULT_DIR and rejected on
 *    traversal. Dotfiles (.obsidian etc.) are off-limits.
 *  - Daily notes live in VAULT_DAILY_DIR (default "Daily/") named
 *    YYYY-MM-DD.md in VAULT_TZ (Berlin) — matching Obsidian's daily-notes
 *    convention. Quick captures land in VAULT_INBOX_DIR (default "Inbox/").
 *
 * LiveSync (or whatever sync layer is active) propagates writes to
 * Konrad's devices — this module only touches the filesystem.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";
const DAILY_DIR = process.env.VAULT_DAILY_DIR ?? "Daily";
const INBOX_DIR = process.env.VAULT_INBOX_DIR ?? "Inbox";
const TZ = process.env.REMINDER_TZ ?? "Europe/Berlin";

export type DailySection = "Tasks" | "Notes" | "Journal";

const DAILY_TEMPLATE = (date: string) =>
  `# ${date}\n\n## Tasks\n\n## Notes\n\n## Journal\n`;

/** Resolve a vault-relative path, throwing on traversal or dotfiles. */
function resolveInVault(rel: string): string {
  const cleaned = rel.replace(/\\/g, "/");
  if (cleaned.split("/").some((seg) => seg.startsWith(".") && seg !== "")) {
    throw new Error(`vault path may not contain dot segments: ${rel}`);
  }
  const abs = path.resolve(VAULT_DIR, cleaned);
  const root = path.resolve(VAULT_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`vault path escapes the vault: ${rel}`);
  }
  return abs;
}

function nowParts(): { date: string; time: string } {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("de-DE", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return { date, time };
}

/** Sanitize a note title into a filename Obsidian accepts. */
function slugTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "Untitled";
}

/** Insert `line` at the end of `## section` in `content`; if the section
 *  is missing, append it. Never removes existing content. */
function appendUnderSection(
  content: string,
  section: DailySection,
  line: string,
): string {
  const lines = content.split("\n");
  const headerIdx = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase(),
  );
  if (headerIdx === -1) {
    const base = content.endsWith("\n") ? content : content + "\n";
    return `${base}\n## ${section}\n${line}\n`;
  }
  // Find end of this section = next '## ' heading or EOF.
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Insert before trailing blank lines of the section so entries stay tight.
  let insertAt = end;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

export interface VaultWriteResult {
  /** Vault-relative path of the touched note. */
  path: string;
  created: boolean;
}

/** Append a timestamped line to today's daily note under a section.
 *  `prefix` defaults to "- " (bullet); pass "- [ ] " for tasks. */
export async function appendToDailyNote(input: {
  section: DailySection;
  text: string;
  prefix?: string;
}): Promise<VaultWriteResult> {
  const text = input.text.trim();
  if (!text) throw new Error("text required");
  const { date, time } = nowParts();
  const rel = `${DAILY_DIR}/${date}.md`;
  const abs = resolveInVault(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  let content: string;
  let created = false;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    content = DAILY_TEMPLATE(date);
    created = true;
  }
  const prefix = input.prefix ?? "- ";
  const line = `${prefix}${time} — ${text.replace(/\n+/g, " ")}`;
  const next = appendUnderSection(content, input.section, line);
  await fs.writeFile(abs, next, "utf8");
  return { path: rel, created };
}

/** Create a new note (never overwrites — collision appends " 2", " 3"…). */
export async function createNote(input: {
  title: string;
  content?: string;
  folder?: string;
}): Promise<VaultWriteResult> {
  const folder = input.folder?.trim() || INBOX_DIR;
  const base = slugTitle(input.title);
  const { date, time } = nowParts();

  await fs.mkdir(resolveInVault(folder), { recursive: true });

  for (let n = 0; n < 50; n++) {
    const name = n === 0 ? base : `${base} ${n + 1}`;
    const rel = `${folder}/${name}.md`;
    const abs = resolveInVault(rel);
    const body =
      (input.content?.trim() ? input.content.trim() + "\n" : "") +
      `\n---\ncaptured: ${date} ${time}\nsource: ai-os\n`;
    try {
      await fs.writeFile(abs, `# ${name}\n\n${body}`, { flag: "wx" });
      return { path: rel, created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`could not find a free filename for "${base}"`);
}

/** Read today's daily note (for the mobile Capture preview). */
export async function readDailyNote(): Promise<{
  path: string;
  date: string;
  content: string | null;
}> {
  const { date } = nowParts();
  const rel = `${DAILY_DIR}/${date}.md`;
  try {
    const content = await fs.readFile(resolveInVault(rel), "utf8");
    return { path: rel, date, content };
  } catch {
    return { path: rel, date, content: null };
  }
}
