/**
 * Media streaming route. Serves files from the LOCAL_MEDIA_ROOT tree
 * (final_video.mp4 + scene image assets) with HTTP Range support so the
 * inbox preview <video> element can seek without downloading the whole file.
 *
 * Path layout on VPS: ${LOCAL_MEDIA_ROOT}/${channel_id}/${job_id}/<file>.
 * We never accept a path from the URL — `channel_id` is looked up in
 * content_jobs via the requested job UUID, and the filename is sanitised to
 * a whitelist of safe characters before being joined. That prevents path
 * traversal even if the request crafts `..` or `/` in the slug.
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getJobChannelId } from "../db/ai_os.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_SLUG_RE = /^[\w.\-]+\.(?:png|jpg|jpeg|webp|gif|mp4)$/i;
const LOCAL_MEDIA_ROOT =
  process.env.LOCAL_MEDIA_ROOT ?? "/opt/content-forge/media";

function mimeFor(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

/** Stream a file with HTTP Range support. Caller has already validated path. */
function serveFileWithRange(c: Parameters<typeof stream>[0], file: string) {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return c.json({ error: "file not found" }, 404);
  }

  const contentType = mimeFor(file);
  const rangeHeader = c.req.header("range");
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "private, max-age=60");

  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!m) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      end >= size
    ) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    const chunkSize = end - start + 1;
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(chunkSize));
    c.status(206);
    return stream(c, async (s) => {
      const node = createReadStream(file, { start, end });
      await s.pipe(Readable.toWeb(node) as ReadableStream<Uint8Array>);
    });
  }

  c.header("Content-Length", String(size));
  c.status(200);
  return stream(c, async (s) => {
    const node = createReadStream(file);
    await s.pipe(Readable.toWeb(node) as ReadableStream<Uint8Array>);
  });
}

/* GET /api/media/job/:jobId/final.mp4 — the rendered video. */
r.get("/job/:jobId/final.mp4", async (c) => {
  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
  const channelId = await getJobChannelId(jobId);
  if (!channelId) return c.json({ error: "job not found" }, 404);
  const file = join(LOCAL_MEDIA_ROOT, channelId, jobId, "final_video.mp4");
  return serveFileWithRange(c, file);
});

/* HEAD support for the same — browsers send HEAD before video range probes. */
r.on("HEAD", "/job/:jobId/final.mp4", async (c) => {
  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
  const channelId = await getJobChannelId(jobId);
  if (!channelId) return c.json({ error: "job not found" }, 404);
  const file = join(LOCAL_MEDIA_ROOT, channelId, jobId, "final_video.mp4");
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "video/mp4");
  c.header("Content-Length", String(size));
  return c.body(null, 200);
});

/* GET /api/media/job/:jobId/asset/:slug — scene thumbnail or other image asset.
 * Slug is restricted to a safe filename (no path separators, image extension). */
r.get("/job/:jobId/asset/:slug", async (c) => {
  const jobId = c.req.param("jobId");
  const slug = c.req.param("slug");
  if (!UUID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
  if (!ASSET_SLUG_RE.test(slug))
    return c.json({ error: "invalid asset slug" }, 400);
  const channelId = await getJobChannelId(jobId);
  if (!channelId) return c.json({ error: "job not found" }, 404);
  const file = join(LOCAL_MEDIA_ROOT, channelId, jobId, slug);
  return serveFileWithRange(c, file);
});

export default r;
