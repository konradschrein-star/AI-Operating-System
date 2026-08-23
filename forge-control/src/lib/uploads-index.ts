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

/**
 * Same gate as routes/uploads.ts — never weaken this beyond the two shapes
 * that actually occur.
 *
 * Two id shapes exist in /opt/ai-os/uploads: the 12-hex `FORGE_RUN_ID` the
 * screenshot convention uses, and the full run UUID (`FORGE_RUN_UUID`) that
 * chat attachments and some workers write under. The index used to see only
 * the first, so every UUID directory was invisible to the OS that created it.
 * Both are still strict character classes — no separators, no traversal.
 *
 * LOWERCASE ONLY, deliberately. The plan writes this regex with an `/i` flag;
 * adding it turns `704B0F5E1A2C` from a 400 into a filesystem lookup, and
 * uploads-serving.test.ts pins that rejection ("a bad run id is 400"). Every
 * directory on disk is lowercase (crypto.randomBytes().toString("hex") and
 * gen_random_uuid() both emit lowercase), so case-insensitivity would only
 * admit a second spelling of an id that never exists — a strictly wider gate
 * for zero directories gained.
 */
export const ID_RE =
  /^[a-f0-9]{12}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Non-image files a run leaves behind that are worth listing: patches,
 * transcripts, structured output, logs. Anything else in a run directory is
 * still counted in `other_count` but not listed, so the library never claims
 * a directory is empty when it is not.
 */
const ARTIFACT_EXT = new Set([
  ".patch",
  ".diff",
  ".txt",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".csv",
  ".html",
  ".pdf",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
]);

export type RunFileKind = "image" | "artifact";

function kindFor(ext: string): RunFileKind | null {
  if (IMAGE_EXT.has(ext)) return "image";
  if (ARTIFACT_EXT.has(ext)) return "artifact";
  return null;
}

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
  /** "image" renders in the camera strip; "artifact" is a file the LIBRARY
   *  lists but the strip must never put in an `<img>`. */
  kind: RunFileKind;
}

export interface ListRunShotsOptions {
  /** "images" (default) preserves the camera-strip contract: every entry it
   *  gets back is safe to render as an image. "all" adds run artefacts
   *  (patches, logs, JSON, transcripts) for the LIBRARY surface. */
  include?: "images" | "all";
}

/**
 * Files in `dir`, newest first (by mtime).
 *
 * The default is images only, and that default is load-bearing:
 * `RunShotsIndicator` (chat/BrowserShots.tsx) renders every returned entry
 * inside an `<img>` and titles the control "N images". Widening the default
 * would put a `.patch` in an `<img>` on a surface that works today.
 */
export async function listRunShots(
  dir: string,
  options: ListRunShotsOptions = {},
): Promise<RunShot[]> {
  const include = options.include ?? "images";
  const id = path.basename(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const shots: RunShot[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const kind = kindFor(ext);
    if (kind === null) continue;
    if (include === "images" && kind !== "image") continue;
    const st = await fs.stat(path.join(dir, entry.name));
    const { ts, label } = parseShotName(entry.name);
    shots.push({
      name: entry.name,
      url: `/api/uploads/${id}/${encodeURIComponent(entry.name)}`,
      label,
      ts,
      size: st.size,
      mtime: st.mtime.toISOString(),
      kind,
    });
  }
  shots.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return shots;
}

export interface RunSummary {
  id: string;
  /**
   * IMAGES only. This is what `RunShotsIndicator` reads to decide whether to
   * draw a camera and what number to put next to it, and the strip it opens
   * shows images — so this field must keep meaning "how many pictures".
   * The library reads `file_count`/`artifact_count` instead.
   */
  count: number;
  /** Same number as `count`, named for readers who are not the camera. */
  image_count: number;
  /** Patches, logs, JSON, transcripts and other listed non-image files. */
  artifact_count: number;
  /** image_count + artifact_count — what the LIBRARY shows as "N files". */
  file_count: number;
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
    // "all", not the image default: a run that only ever wrote a patch or a
    // transcript used to be dropped from the index entirely, which is how a
    // run artefact became unreachable from the OS that produced it.
    const files = await listRunShots(path.join(UPLOAD_DIR, entry.name), {
      include: "all",
    });
    if (files.length === 0) continue;
    const images = files.filter((f) => f.kind === "image");
    runs.push({
      id: entry.name,
      count: images.length,
      image_count: images.length,
      artifact_count: files.length - images.length,
      file_count: files.length,
      latest_ts: files[0].mtime,
    });
  }
  runs.sort((a, b) => (b.latest_ts ?? "").localeCompare(a.latest_ts ?? ""));
  return runs;
}

/**
 * All run directories under UPLOAD_DIR that hold at least one listable file,
 * newest-first. Cached in-process for LIST_CACHE_MS so a polling panel costs
 * one readdir sweep per 10s rather than per request.
 */
export async function listAllRuns(): Promise<RunSummary[]> {
  const now = Date.now();
  if (cache && now - cache.at < LIST_CACHE_MS) return cache.runs;
  const runs = await computeAllRuns();
  cache = { at: now, runs };
  return runs;
}

/**
 * Drop the cached sweep. Called by routes/uploads.ts right after a POST
 * stores files: without it a fresh attachment stays invisible to the index
 * (and so to the library) for up to LIST_CACHE_MS, which reads as "my upload
 * did not arrive".
 */
export function invalidateRunsCache(): void {
  cache = null;
}
