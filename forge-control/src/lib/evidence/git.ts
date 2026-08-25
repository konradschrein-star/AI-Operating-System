/**
 * Evidence source: commits landed that Berlin day, per repository.
 *
 * ── The DST trap this module exists to avoid ─────────────────────────────
 * The obvious implementation is `--since='<day> 00:00:00 +0200'`. That literal
 * `+0200` is correct only between the last Sunday in March and the last Sunday
 * in October; on the winter side of the transition it misattributes a whole
 * hour of commits, silently, and nothing ever fails. So the window comes from
 * `dayWindow(day)` in lib/calendar.ts — the same two-pass, zone-resolved
 * instants the calendar source uses — handed to git as UTC ISO strings.
 *
 * `--since`/`--until` filter on the COMMITTER date, so `%cI` is what gets
 * reported: a rebased commit whose author date is last week landed today, and
 * "what happened today" is about landing.
 *
 * execFile with an argument array, never a shell string: a commit subject can
 * contain anything, and so can a repo path from the environment.
 *
 * A repository that cannot be read is an ERROR, never silence. This source
 * rejects — naming every repo that failed and why — so index.ts files it in
 * errors[] and the card shows the message instead of an honest-looking empty
 * list. That is deliberately stricter than "report the repos that worked":
 * "0 commits" and "the repo is gone" must never look the same on the page.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dayWindow } from "../calendar.ts";
import type { Day } from "../day-score.ts";

const execFileAsync = promisify(execFileCb);

/** Overridable so a test can point at a scratch repo; the default is the pair
 *  named in PLAN.md §4.1. Comma-separated, absolute paths. */
export function evidenceRepos(): string[] {
  const raw = process.env.JOURNAL_EVIDENCE_REPOS ?? "/opt/forge-ai-os,/opt/content-forge";
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export interface CommitEvidence {
  repo: string;
  sha: string;
  subject: string;
  at: string;
}

/** Unit separator. A subject may contain `|`, a tab, or a quote; it cannot
 *  contain 0x1f, and `%s` can never contain a newline. */
const FS = "\u001f";

/** The exact `git log` arguments for one repo and one Berlin day — exported so
 *  the DST bound is testable without a repository. */
export function gitLogArgs(repo: string, day: Day): string[] {
  const window = dayWindow(day);
  return [
    "-C",
    repo,
    "log",
    `--since=${window.start}`,
    `--until=${window.end}`,
    `--format=%h${FS}%cI${FS}%s`,
  ];
}

function describe(e: unknown): string {
  const err = e as (Error & { stderr?: string }) | null;
  const stderr = err?.stderr?.trim();
  return stderr || err?.message || String(e);
}

function parseLog(repo: string, stdout: string): CommitEvidence[] {
  const out: CommitEvidence[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, at, ...rest] = line.split(FS);
    if (!sha || !at) {
      throw new Error(`git log line from ${repo} did not parse: ${JSON.stringify(line)}`);
    }
    out.push({ repo, sha, at, subject: rest.join(FS) });
  }
  return out;
}

export async function commitsForDay(day: Day): Promise<CommitEvidence[]> {
  const repos = evidenceRepos();
  if (repos.length === 0) {
    throw new Error("JOURNAL_EVIDENCE_REPOS is set but names no repository");
  }

  const settled = await Promise.allSettled(
    repos.map(async (repo) => {
      const { stdout } = await execFileAsync("git", gitLogArgs(repo, day), {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return parseLog(repo, stdout);
    }),
  );

  const failures: string[] = [];
  const commits: CommitEvidence[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") commits.push(...result.value);
    else failures.push(`${repos[i]}: ${describe(result.reason)}`);
  });

  if (failures.length > 0) {
    throw new Error(`git log failed for ${failures.length} of ${repos.length} repos — ${failures.join("; ")}`);
  }

  commits.sort((a, b) => a.at.localeCompare(b.at));
  return commits;
}
