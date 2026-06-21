# Inbox Rich Preview Card — Plan

## TL;DR

Today the AWAITING_QC inbox card shows only badge + title + ask + Approve/Deny — Konrad can't see what he's approving. Plan: add a `/api/proxy/inbox/:id/preview` endpoint that joins `inbox_items.related_job_id → content_jobs` and returns video URL, scene thumbs, and stats; rich card embeds an HTML5 video, scene strip, stats grid, and a Deny-with-reason flow. Streams hit a new authenticated `GET /media/job/:jobId/final.mp4` proxy on forge-control (no R2 today — `r2_asset_manifest` paths are local FS on the VPS).

## Current state

- UI: `forge-control-web/app/desktop/DesktopApp.tsx` lines 1186-1440 — `InboxSurface` is a thin 2-column list/detail. Detail = badge, title, ask, `tried[]`, action buttons. No media, no stats, no reason input.
- Mobile counterpart: `forge-control-web/app/MobileApp.tsx` lines 480-... `InboxScreen` — same shape, collapsible. Must update both surfaces.
- Backend: `forge-control/src/routes/inbox.ts` exposes `GET /inbox` + `POST /:id/resolve`; both return only `InboxItem` (no job join). Helpers: `forge-control/src/db/ai_os.ts::listOpenInbox / resolveInbox` — already has `related_job_id` column wired and HCP relay on resolve.
- Job data lives in `content_jobs` (`packages/db/src/schema/content-jobs.ts`): `assembly_manifest jsonb` (`{ scenes:[{scene_index, duration_frames, visual_asset_key, ...}], ticker_items, ...}`), `r2_asset_manifest` (legacy name; entries `{key, type, size_bytes, storage_tier:'local'}`), `final_video_size_bytes`, `final_video_duration_seconds`, `aspect_ratio`, `format`, `template_id`, plus `r2_asset_manifest[type='video/final-render'].key` written by every renderer.
- Final video path convention (per `apps/worker-render/src/workflows/v2-composition.ts:1263` + reactor/political-commentary/clean-layout): `${LOCAL_MEDIA_ROOT}/${channel_id}/${job_id}/final_video.mp4`. **Not on R2 today** — naming is historical.
- Image assets used per scene: `assembly_manifest.scenes[].visual_asset_key` points into `r2_asset_manifest` entries with `type='image'`.

## Proposed API contract

Add `GET /api/proxy/inbox/:id/preview` → `{ preview }` of shape (≤ ~50 KB):

```ts
interface InboxPreview {
  inbox_item_id: string;
  job: {
    id: string;
    format: string;
    template: string;
    channel: string;
    status: string;
    from_status: string | null; // from inbox_items.body or last decision
    enqueued_for_qc_at: string; // inbox_items.created_at
    title: string;
  };
  video: {
    url: string; // /api/proxy/media/job/:jobId/final.mp4  (proxied)
    poster_url: string | null; // first scene thumb
    duration_sec: number;
    size_mb: number;
    width: number;
    height: number;
    fps: number;
    aspect_ratio: string;
    bitrate_kbps: number | null; // size_mb*8192/duration_sec
    render_pipeline:
      | "V2"
      | "V3"
      | "REACTOR"
      | "REMOTION"
      | "FFMPEG_CLEAN"
      | null;
    rendered_in_sec: number | null; // total_render_time_seconds
  } | null; // null if no final-render asset yet
  scenes: Array<{
    index: number;
    thumb_url: string;
    duration_sec: number;
    visual_type: string;
  }>; // cap 60
  stats: Array<{ label: string; value: string }>; // ready-to-render rows for UI
  format_extras: Record<string, unknown>; // SPACE_VIDEO: clip-libraries used, FacelessOS rules; CE: scene_count, asset checksum
}
```

- Add `GET /api/proxy/media/job/:jobId/final.mp4` + `…/thumb/:sceneIndex.jpg`: stream from `LOCAL_MEDIA_ROOT` with Range header (mirror `apps/hub-web/src/app/api/drama/[id]/file/route.ts`). Allowlist names; UUID-guard `jobId`; auth via existing session cookie/NextAuth in forge-control-web's proxy route.
- Extend `POST /inbox/:id/resolve` body: accept `resolution.reason: string` (already passed through to HCP `APPROVAL_DECISION.body.reason`). UI must require it for Deny.

## Proposed component design

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● APPROVE   SPACE_VIDEO · AWAITING_QC                          14m ago   │
│ "Black Holes 101 — final render ready for review"                        │
│ from RENDERING → AWAITING_QC · render took 7m22s                         │
│ ────────────────────────────────────────────────────────────────────────  │
│ ┌──── preview (16:9, 640w) ────┐  ┌──── stats ────────────────────────┐ │
│ │  ▶ [video player, poster=    │  │ duration       6m 42s             │ │
│ │     scenes[0].thumb]         │  │ size           138.4 MB           │ │
│ │   ──────●───── 02:14 / 06:42 │  │ scenes         48                 │ │
│ └──────────────────────────────┘  │ 1920×1080 · 30fps · 16:9          │ │
│                                   │ bitrate        2 740 kbps         │ │
│ ┌── scenes (strip, scroll-x) ──┐  │ pipeline       V3 ffmpeg          │ │
│ │ [01][02][03][04][05][06]…    │  │ format         SPACE_VIDEO        │ │
│ └──────────────────────────────┘  │ channel        spacelab           │ │
│                                   │ render time    7m 22s             │ │
│                                   └───────────────────────────────────┘ │
│ ────────────────────────────────────────────────────────────────────────  │
│  [ Approve ]   [ Deny… ]   open job →   download mp4                     │
└──────────────────────────────────────────────────────────────────────────┘
   Deny… opens inline reason box:  ╭ reason ─────────╮  [ Send deny ]
                                   ╰─────────────────╯
```

- Layout: 1.4fr preview / 1fr stats grid; below 980 px fall back to stacked. Scene strip = horizontally-scrollable row of 96×54 thumbs, click → seek video.
- Format-specific extras row beneath stats: SPACE_VIDEO shows clip-library counts + Whisper word-count; CASUALLY_EXPLAINED shows sentence-image split count; TUTORIAL_STUDIO shows step count. Wire via `format_extras`.
- Tokens: keep `tokens.bgCard`, `tokens.border`, accent for headings, `tokens.textFaint` for stat labels — identical to existing surfaces.
- Reuse pattern from existing two-column right pane (DesktopApp.tsx:1306+) — only the contents of the right pane change.

## File edit list (in order)

1. `forge-control/src/db/ai_os.ts` (+~110 LOC) — add `getInboxItemPreview(itemId)` joining `inbox_items` → `content_jobs` via `related_job_id`; derive `render_pipeline` from `template.render_config.engine` or asset-manifest entry types; build `stats[]`. Bound to 200 KB.
2. `forge-control/src/routes/inbox.ts` (+~25 LOC) — add `r.get("/:id/preview")`; UUID guard; 404 if no `related_job_id`.
3. `forge-control/src/routes/media.ts` (NEW, ~120 LOC) — `GET /job/:jobId/final.mp4` + `/job/:jobId/thumb/:idx.jpg`; Range support; allowlist; same auth middleware as today.
4. `forge-control/src/index.ts` (+2 LOC) — mount `/media` router.
5. `forge-control-web/next.config.mjs` (+rewrite if not present) — proxy `/api/proxy/media/*`.
6. `forge-control-web/app/api.ts` (+~40 LOC) — `fetchInboxPreview(id)`, extend `resolveInboxItem` to accept `reason`.
7. `forge-control-web/app/data.ts` (+~50 LOC) — `InboxPreview` types.
8. `forge-control-web/app/desktop/DesktopApp.tsx` (~200 LOC delta) — extract `InboxDetail` from `InboxSurface`; render preview using `useQuery(["inbox-preview", id])`; Deny opens reason inline.
9. `forge-control-web/app/MobileApp.tsx` (~120 LOC delta) — same component, stacked layout; lazy-load preview only when card is expanded (existing `inboxOpen` map).
10. `packages/db` — **no migration needed** (everything reads from existing columns).

## Risks

- **No R2 in production.** Comment in `content-jobs.ts:161` is explicit: `r2_asset_manifest` is local FS now. Streaming must come off the VPS box that runs forge-control (which it does — same host as worker-render). If forge-control ever runs split, swap to a signed URL provider.
- **No signed URLs today.** `media` route relies on the existing forge-control session cookie. TTL = session TTL. Cheaper than building S3-style presigning for now.
- **Mobile playback.** `<video>` with `playsinline preload="metadata"` + `Range` from server. iOS Safari needs explicit `type="video/mp4"` and a poster, or it shows a grey block — set poster to scenes[0].thumb_url.
- **Card with no asset yet.** `video` field is nullable; UI must render a "render in progress / no asset yet" placeholder so APPROVE_REQUEST items from earlier stages (AWAITING_IMAGE_QC, AWAITING_UPLOADER) don't crash.
- **Payload bound.** Cap scene strip at 60 entries; SPACE_VIDEO can run 400+ scenes — paginate or sample (every Nth).
- **Range thrash.** Browser scrubbing on a 100 MB mp4 → many Range requests. Use `createReadStream(path, {start, end})` not full-file buffering; same pattern as drama route.

## Recommended next step

Build the backend slice first: `forge-control/src/db/ai_os.ts::getInboxItemPreview` + `routes/inbox.ts::GET /:id/preview` + minimal `media` route (mp4 only, no thumbs). Hit it with `curl` against a real AWAITING_QC item on the VPS to confirm shape and Range streaming. Only then touch the UI — that order makes the desktop+mobile edits trivial because the contract is already locked.
