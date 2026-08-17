/**
 * uploads-index.ts — read-only index over the screenshot convention served by
 * routes/uploads.ts.
 *
 * The convention (owned by scripts/research-browser.mjs:228-312, NOT this
 * file): /opt/ai-os/uploads/<12-hex-run-id>/<compact-ISO8601>-<label>.png.
 * This module answers "what did a run photograph?" without inventing a new
 * pipeline — it only reads the directories the browser-research tool already
 * writes and the existing route already serves.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/opt/ai-os/uploads";

/** Same gate as routes/uploads.ts — never weaken this. */
const ID_RE = /^[a-f0-9]{12}$/;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** `20260805T101530Z-perplexity-login-wall.png` → stamp + label. */
const SHOT_NAME_RE = /^(\d{8}T\d{6}Z)-(.+)\.[A-Za-z0-9]+$/;

export interface ParsedShotName {
  ts: string | null;
  label: string | null;
}

/**
 * Pure — never throws. Anything that does not match the convention comes
 * back as `{ ts: null, label: null }` rather than raising, since a stray
 * non-conforming file must not take down the index.
 */
export function parseShotName(name: string): ParsedShotName {
  const m = SHOT_NAME_RE.exec(name);
  if (!m) return { ts: null, label: null };
  return { ts: m[1], label: m[2] };
}

export interface RunShot {
  name: string;
  url: string;
  label: string | null;
  ts: string | null;
  size: number;
  mtime: string;
}

/** Image files in `dir`, newest first (by mtime). Non-image files are skipped. */
export async function listRunShots(dir: string): Promise<RunShot[]> {
  const id = path.basename(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const shots: RunShot[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const st = await fs.stat(path.join(dir, entry.name));
    const { ts, label } = parseShotName(entry.name);
    shots.push({
      name: entry.name,
      url: `/api/uploads/${id}/${encodeURIComponent(entry.name)}`,
      label,
      ts,
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  shots.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return shots;
}

export interface RunSummary {
  id: string;
  count: number;
  latest_ts: string | null;
}

const LIST_CACHE_MS = 10_000;
let cache: { at: number; runs: RunSummary[] } | null = null;

async function computeAllRuns(): Promise<RunSummary[]> {
  const entries = await fs.readdir(UPLOAD_DIR, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  });
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const shots = await listRunShots(path.join(UPLOAD_DIR, entry.name));
    if (shots.length === 0) continue;
    runs.push({
      id: entry.name,
      count: shots.length,
      latest_ts: shots[0].mtime,
    });
  }
  runs.sort((a, b) => (b.latest_ts ?? "").localeCompare(a.latest_ts ?? ""));
  return runs;
}

/**
 * All run directories under UPLOAD_DIR that contain at least one image,
 * newest-first by latest shot. Cached in-process for LIST_CACHE_MS so a
 * polling panel costs one readdir sweep per 10s rather than per request.
 */
export async function listAllRuns(): Promise<RunSummary[]> {
  const now = Date.now();
  if (cache && now - cache.at < LIST_CACHE_MS) return cache.runs;
  const runs = await computeAllRuns();
  cache = { at: now, runs };
  return runs;
}
