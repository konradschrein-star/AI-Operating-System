/**
 * Typed client for forge-control. All requests go to /api/proxy/* which
 * next.config.mjs rewrites to forge-control at $FORGE_CONTROL_URL.
 *
 * Shapes mirror the JSON returned by forge-control/src/routes/*.ts and the
 * design at design/Forge Mobile.dc.html.
 */

import type {
  StatusType,
  TabKey,
  NeedsItem,
  FleetWorker,
  InboxItem as InboxItemUi,
  LiveStat,
  ServiceDegradation,
  Provider,
  FeedbackLoop,
  DecisionLogEntry,
  TodayChip,
} from "./data";

const ROOT = "/api/proxy";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/* ----------------------------------------------------------------------------
 * Excalidraw canvases — the visual brainstorming surface. Backed by the same
 * .excalidraw.md files in the Obsidian vault, so a drawing edited here appears
 * in the Obsidian app (via Syncthing) and can be read/written by the agent.
 * -------------------------------------------------------------------------- */

export interface CanvasListItem {
  path: string;
  name: string;
  folder: string;
  mtime: number;
  size: number;
}

export interface CanvasFile {
  path: string;
  name: string;
  mtime: number;
  format: "compressed" | "parsed";
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/** Raised when the file changed on disk since load (Obsidian, another tab, or
 *  the agent wrote it). The vault syncs over Syncthing, which is
 *  last-writer-wins and never merges — so the caller must offer a reload
 *  rather than clobber whoever moved first. */
export class CanvasConflictError extends Error {
  mtime: number;
  constructor(detail: string, mtime: number) {
    super(detail);
    this.name = "CanvasConflictError";
    this.mtime = mtime;
  }
}

export const listCanvases = (q?: string) =>
  getJson<{ items: CanvasListItem[] }>(
    q ? `/canvas/list?q=${encodeURIComponent(q)}` : "/canvas/list",
  );

export const getCanvas = (path: string) =>
  getJson<CanvasFile>(`/canvas/file?path=${encodeURIComponent(path)}`);

export const saveCanvas = async (input: {
  path: string;
  elements: Record<string, unknown>[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  baseMtime?: number;
}) => {
  const res = await fetch(`${ROOT}/canvas/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as {
      detail?: string;
      mtime?: number;
    };
    throw new CanvasConflictError(
      b.detail ?? "This drawing changed on disk since you opened it.",
      b.mtime ?? 0,
    );
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} saving canvas`);
  return (await res.json()) as { ok: true; path: string; mtime: number };
};

export const createCanvas = (input: { name: string; folder?: string }) =>
  postJson<{ ok: true; path: string; name: string; mtime: number }>(
    "/canvas/new",
    input,
  );

/* ----------------------------------------------------------------------------
 * Subscription quota — deliberately NOT here.
 *
 * Anthropic exposes actual utilisation at /api/oauth/usage, and forge-control
 * serves it at /usage/quota. This module used to hold a `fetchQuota` beside a
 * second copy in settings/usageApi.ts, which is how three components ended up
 * polling one endpoint on their own timers and showing Konrad two indicators
 * that disagreed. Round 1876 moved the key, the intervals and the fetcher into
 * `desktop/quota/quotaQuery.ts` and left nothing here to import by accident.
 * -------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------
 * Today
 * -------------------------------------------------------------------------- */
export interface TodayResponse {
  date: string;
  greeting: string;
  chips: TodayChip[];
  needs: NeedsItem[];
  fleet: FleetWorker[];
  spend: { value: string; cap: string };
  shipped: { value: string; pipeline: string };
}

export const fetchToday = () => getJson<TodayResponse>("/today");

/* ----------------------------------------------------------------------------
 * Spend (Money surface) — mirrors routes/spend.ts GET /summary
 * -------------------------------------------------------------------------- */
export interface SpendWindow {
  /** Real spend — every provider except claude-code (flat-rate subscription). */
  total_eur: number;
  calls: number;
  /** claude-code shadow price: what those tokens would've cost on metered
   *  API pricing. Not billed — kept separate from total_eur on purpose. */
  claude_eur: number;
  claude_calls: number;
}

export interface SpendArea {
  provider: string;
  kind: string;
  total_eur: number;
  calls: number;
  units: number;
}

export interface SpendDay {
  day: string; // YYYY-MM-DD (UTC)
  total_eur: number;
  calls: number;
}

export interface SpendSummaryResponse {
  today: SpendWindow;
  d7: SpendWindow;
  d30: SpendWindow;
  by_area: SpendArea[];
  daily: SpendDay[];
}

export const fetchSpendSummary = () =>
  getJson<SpendSummaryResponse>("/spend/summary");

/** Runs that bounced off the Claude subscription's weekly/5-hour usage
 *  wall. Reactive only — the CLI has no proactive "X% of quota used" API,
 *  so this is the closest thing to a usage meter: how often (and when)
 *  you've actually hit the ceiling recently. */
export interface LimitHit {
  run_id: string;
  title: string;
  ts: string;
  message: string;
}
export const fetchLimitHits = async (days = 14): Promise<LimitHit[]> => {
  const r = await getJson<{ days: number; hits: LimitHit[] }>(
    `/spend/limit-hits?days=${days}`,
  );
  return r.hits;
};

/* ----------------------------------------------------------------------------
 * Inbox
 * -------------------------------------------------------------------------- */
interface InboxApiItem {
  id: string;
  type: string;
  status: StatusType;
  title: string;
  ask: string;
  tried: { icon: string; text: string }[];
  actions: {
    label: string;
    variant: "primary" | "ok" | "danger" | "neutral";
    action_id?: string;
  }[];
  age: string;
}

export const fetchInbox = async (): Promise<InboxItemUi[]> => {
  const r = await getJson<{ count: number; items: InboxApiItem[] }>("/inbox");
  return r.items;
};

/* v1.6 phase 3: rich preview joined against content_jobs. */
export interface InboxPreviewJob {
  id: string;
  title: string;
  format: string;
  status: string;
  channel_id: string;
  channel_name: string | null;
  render_engine: string | null;
  production_version: string;
  enqueued_for_qc_at: string | null;
  render_started_at: string | null;
  render_completed_at: string | null;
  total_render_time_seconds: number | null;
}

export interface InboxPreviewVideo {
  url: string;
  poster_url: string | null;
  duration_sec: number;
  size_mb: number;
  aspect_ratio: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate_kbps: number | null;
}

export interface InboxPreviewScene {
  index: number;
  thumb_url: string | null;
  duration_sec: number;
  visual_type: string | null;
  sentence: string | null;
}

export interface InboxPreview {
  inbox_item_id: string;
  job: InboxPreviewJob | null;
  video: InboxPreviewVideo | null;
  scenes: InboxPreviewScene[];
  stats: Array<{ label: string; value: string }>;
  format_extras: Record<string, unknown>;
}

export const fetchInboxPreview = async (id: string): Promise<InboxPreview> => {
  const r = await getJson<{ preview: InboxPreview }>(`/inbox/${id}/preview`);
  return r.preview;
};

export const resolveInboxItem = async (
  id: string,
  payload: {
    resolved_by?: string;
    action_id?: string;
    reason?: string;
    resolution?: Record<string, unknown>;
  } = {},
) => {
  const { action_id, reason, resolution, ...rest } = payload;
  // Reason rides in resolution.reason — resolveInbox() forwards it to HCP
  // as APPROVAL_DECISION.body.reason / ANSWER.body.reason.
  const mergedResolution: Record<string, unknown> = { ...(resolution ?? {}) };
  if (action_id !== undefined) mergedResolution.action_id = action_id;
  if (reason !== undefined && reason !== "") mergedResolution.reason = reason;
  return postJson<{ item: InboxApiItem }>(`/inbox/${id}/resolve`, {
    ...rest,
    resolution: mergedResolution,
  });
};

/** "NEEDS YOU" on Today is a 3-item preview of the whole open-inbox set —
 *  clearing it means dismissing all of it, not just the 3 shown. */
export const clearAllInbox = async (): Promise<{ resolved: number; failed: number }> =>
  postJson("/inbox/resolve-all", {});

/* ----------------------------------------------------------------------------
 * Live
 * -------------------------------------------------------------------------- */
export interface LiveResponse {
  stats: {
    label: string;
    value: string;
    tone: "accent" | "soft" | "neutral" | "stuck";
  }[];
  degradation: ServiceDegradation[];
  providers: Provider[];
}

export const fetchLive = () => getJson<LiveResponse>("/live");

/* ----------------------------------------------------------------------------
 * Control
 * -------------------------------------------------------------------------- */
export interface ControlResponse {
  fleet: {
    status: "running" | "paused";
    updated_at: string;
    updated_by: string;
  };
  loops: {
    id: string;
    name: string;
    cadence: string;
    tone: FeedbackLoop["status"];
    last: string;
  }[];
  invariant: { label: string; sub: string };
  decisionLog: DecisionLogEntry[];
}

export const fetchControl = () => getJson<ControlResponse>("/control");

export const freezeFleet = (actor = "user") =>
  postJson<{ fleet: ControlResponse["fleet"] }>(`/fleet/freeze`, { actor });

export const resumeFleet = (actor = "user") =>
  postJson<{ fleet: ControlResponse["fleet"] }>(`/fleet/resume`, { actor });

/* ----------------------------------------------------------------------------
 * Memory (Obsidian vault)
 * -------------------------------------------------------------------------- */
export type MemoryCategory =
  | "rule"
  | "pref"
  | "fact"
  | "person"
  | "project"
  | "note";

/** "vault" = a real file in the Obsidian vault (indexed by the vault-sync
 *  job). "agent" = a status brief written directly by a Hermes fleet worker
 *  (cc-architect, sysop-01, …) — never a real file, vault_path is just a
 *  self-declared label. */
export type MemorySource = "vault" | "agent";

export interface MemoryNote {
  id: string;
  slug: string;
  topic: string;
  vault_path: string;
  category: MemoryCategory;
  source: MemorySource;
  created_by: string;
  tags: string[];
  links: string[];
  created_at: string;
  preview: string;
}

export interface MemoryNoteDetail extends MemoryNote {
  body: string;
  word_count: number;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  backlinks: { slug: string; topic: string }[];
}

export interface MemorySearchHit {
  slug: string;
  vault_path: string;
  title: string;
  snippet: string;
  score: number;
  chunk_index: number;
}

/* v1.7 phase 1+2 — expanded hit shape from /api/memory/search?expand=1.
 * Each row carries lane (`via`, `hop`) so the UI can colour-code by graph
 * depth, and the response carries the category that was used (if any). */
export type TripleCategory =
  | "decision"
  | "rule"
  | "error"
  | "provider"
  | "job"
  | "format"
  | "person"
  | "other";

export const TRIPLE_CATEGORIES: TripleCategory[] = [
  "decision",
  "rule",
  "error",
  "provider",
  "job",
  "format",
  "person",
  "other",
];

export interface MemorySearchHitWithLane extends MemorySearchHit {
  via: "vector" | "graph";
  hop: number;
}

export interface MemorySearchExpandedResponse {
  q: string;
  count: number;
  hits: MemorySearchHitWithLane[];
  expand: true;
  max_hops?: number;
  category?: TripleCategory;
}

export interface MemoryListPage {
  notes: MemoryNote[];
  hasMore: boolean;
}

/** Paged — the vault only grows, so a single unbounded fetch would slow to
 *  a crawl eventually. Defaults to the newest 30, "load more" fetches the
 *  next page. */
export const fetchMemoryList = async (
  opts: { limit?: number; offset?: number; source?: MemorySource } = {},
): Promise<MemoryListPage> => {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 30));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.source) params.set("source", opts.source);
  const r = await getJson<{ count: number; notes: MemoryNote[]; hasMore: boolean }>(
    `/memory?${params}`,
  );
  return { notes: r.notes, hasMore: r.hasMore };
};

/** Vault-wide per-category totals — independent of the paged note list, so
 *  the category rail stays correct no matter how many pages are loaded. */
export const fetchMemoryCounts = async (
  source?: MemorySource,
): Promise<Record<MemoryCategory | "all", number>> =>
  getJson(`/memory/counts${source ? `?source=${source}` : ""}`);

export const fetchMemoryNote = async (
  slug: string,
): Promise<MemoryNoteDetail> => {
  const r = await getJson<{ note: MemoryNoteDetail }>(
    `/memory/${encodeURIComponent(slug)}`,
  );
  return r.note;
};

export const searchMemory = async (q: string): Promise<MemorySearchHit[]> => {
  const r = await getJson<{ q: string; hits: MemorySearchHit[] }>(
    `/memory/search?q=${encodeURIComponent(q)}`,
  );
  return r.hits;
};

/** v1.7 phase 1+2 — expanded search with multi-hop graph + optional category
 *  filter. Each hit's `via`+`hop` lane lets the UI render lane chips. */
export const searchMemoryExpanded = async (
  q: string,
  opts: { hops?: number; category?: TripleCategory; limit?: number } = {},
): Promise<MemorySearchExpandedResponse> => {
  const params = new URLSearchParams({ q, expand: "1" });
  if (opts.hops !== undefined) params.set("hops", String(opts.hops));
  if (opts.category) params.set("category", opts.category);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return getJson<MemorySearchExpandedResponse>(`/memory/search?${params}`);
};

/* v2.2: entity graph for the 3D memory visualization. */
export interface GraphNode {
  id: string;
  label: string;
  degree: number;
  notes: string[];
}
export interface GraphLink {
  source: string;
  target: string;
  predicate: string;
}
export interface KnowledgeGraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  triples: number;
}
export const fetchMemoryGraph = async (): Promise<KnowledgeGraphData> =>
  getJson<KnowledgeGraphData>(`/memory/graph`);

/* ----------------------------------------------------------------------------
 * Routing hypervisor search
 * -------------------------------------------------------------------------- */
export interface SearchGroup {
  key: string;
  label: string;
  engine: string;
  engine_label: string;
  rows: {
    icon: string;
    title: string;
    meta: string;
    snippet?: string;
    nav: { surface: string; slug?: string; id?: string };
  }[];
}

export interface SearchEngine {
  key: string;
  name: string;
  impl: string;
  hits: number;
}

export const fetchSearch = async (
  q: string,
): Promise<{ groups: SearchGroup[]; engines: SearchEngine[] }> => {
  const r = await getJson<{
    q: string;
    groups: SearchGroup[];
    engines: SearchEngine[];
  }>(`/search?q=${encodeURIComponent(q)}`);
  return { groups: r.groups, engines: r.engines };
};

/* ----------------------------------------------------------------------------
 * Chat (runs as conversation threads)
 * -------------------------------------------------------------------------- */
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "stuck"
  | "completed"
  | "failed"
  | "cancelled";

export interface ThreadEntry {
  role: "user" | "assistant" | "system" | "tool" | "agent";
  content: string;
  ts: string;
  kind?:
    | "text"
    | "tool_call"
    | "tool_result"
    | "heartbeat"
    | "error"
    | "stuck_notice"
    | "continue_marker"
    /** Relayed traffic between runs — a worker reporting up, a manager or
     *  Konrad messaging down, and the sender's echo of it. Written by
     *  `commsEntries` (forge-control/src/lib/run-control-rules.ts) since the
     *  control plane shipped; this union simply had not caught up, so every
     *  client read of `kind === "comms"` was a type error against data that
     *  has been on the wire for weeks. `meta.comms` carries the direction,
     *  the actor and the peer run id — see chat/comms-identity.ts. */
    | "comms";
  meta?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  title: string;
  status: RunStatus;
  worker: string | null;
  budget_usd: string;
  spent_usd: string;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  message_count: number;
  last_message_preview: string;
  last_role: string;
  archived: boolean;
  /* ── phase 400 (U10): rail rollup ────────────────────────────────────────
   * Present ONLY for chats that resolve to a project via
   * `project.metadata.origin_chat_id` (GET /api/chat, rollupChatProjects).
   * Absent — not zero — for every other chat: `0/0` on a chat that never
   * started a project would render as a real, wrong progress badge. Consumers
   * MUST test presence (`typeof run.tasks_total === "number"`), never truth. */
  project_id?: string;
  project_status?: string;
  tasks_done?: number;
  tasks_total?: number;
}

export interface RunDetail extends RunSummary {
  prompt: string;
  thread: ThreadEntry[];
  metadata: Record<string, unknown>;
  parent_run_id: string | null;
  stuck_signal: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export const fetchChatList = async (
  opts: { limit?: number; offset?: number } = {},
) => {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const r = await getJson<{
    count: number;
    runs: RunSummary[];
    counts: Record<RunStatus, number>;
    hasMore: boolean;
  }>(`/chat${qs ? `?${qs}` : ""}`);
  return r;
};

/** Search past chats — title + prompt + every message in the thread.
 *  Includes closed/archived chats so a closed conversation stays findable. */
export const searchChats = async (q: string): Promise<RunSummary[]> => {
  const r = await getJson<{ q: string; runs: RunSummary[] }>(
    `/chat/search?q=${encodeURIComponent(q)}`,
  );
  return r.runs;
};

/** Close (archive) one chat — cancels it first if it's still active. */
export const archiveChat = async (id: string): Promise<RunDetail> => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/archive`, {});
  return r.run;
};

/** Close every open chat at once. Returns how many were touched. */
export const archiveAllChats = async (): Promise<number> => {
  const r = await postJson<{ archived: number }>("/chat/archive-all", {});
  return r.archived;
};

export const fetchChat = async (id: string) => {
  const r = await getJson<{ run: RunDetail }>(`/chat/${id}`);
  return r.run;
};

/** Which project — if any — this chat started. Shape of
 *  `GET /api/chat/:id/linkage` (forge-control routes/chat.ts, phase 300g).
 *  An unlinked chat is a 200 with `project_id: null`, not an error: "no
 *  project" is a fact about the chat. `link_source: "thread_scan"` means the
 *  link was inferred from the transcript rather than read from metadata — the
 *  UI marks that rather than presenting a guess as truth (NFU6). */
export interface ChatLinkage {
  chat_id: string;
  project_id: string | null;
  project_status: string | null;
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
}

/** One request per chat opened — no poll (NFU3: the poll budget does not grow;
 *  linkage does not change while a chat is open). */
export const fetchChatLinkage = (id: string) =>
  getJson<ChatLinkage>(`/chat/${id}/linkage`);

export const createChat = async (input: {
  prompt: string;
  title?: string;
  worker?: string;
  budget_usd?: number;
  metadata?: Record<string, unknown>;
}) => {
  const r = await postJson<{ run: RunDetail }>("/chat", input);
  return r.run;
};

export interface CompactResult {
  compacted: boolean;
  dropped?: number;
  kept?: number;
  was?: number;
  archive?: string;
  reason?: string;
  entries?: number;
}

/** Archive this chat's thread, then keep only the newest `keep` entries.
 *  The server archives BEFORE it rewrites and refuses to compact if the
 *  archive write fails, so this cannot silently lose a transcript. */
export const compactChat = async (id: string, keep?: number) =>
  postJson<CompactResult>(`/chat/${id}/compact`, keep ? { keep } : {});

export const setChatModel = async (id: string, model: string) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/model`, { model });
  return r.run;
};

/** Concrete engine choices for the per-run composer picker (next to Send) —
 *  distinct from MODEL_OPTIONS' new-chat aliases because one entry (the
 *  "cheap" Sonnet) needs an exact model id, not an alias that resolves to
 *  latest. Default is Opus 4.8. */
export const ENGINE_MODEL_CHOICES = [
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-fable-5", label: "Fable 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 (cheap)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  /* A SECOND ENGINE, not a Claude rung: this routes to `agy` on Konrad's Google
   * AI Pro plan, so it does not draw on the Claude usage window at all. Only
   * gemini-3.7-flash-high is offered — Konrad, 2026-08-22: "We'll always use
   * gemini-3.7-flash-high." */
  { value: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (free of Claude limits)" },
] as const;

/** The model a new chat starts on when the picker isn't touched. */
export const DEFAULT_ENGINE_MODEL = "claude-opus-5";

/** Effort choices offered in the web UI. "xhigh" is exposed here (it was
 *  API/Telegram-only); "max" still stays off the UI. */
/** ROUND 1871: `max` joins the list. It was always accepted by the engine —
 *  `EFFORT_LEVELS` in forge-control/src/lib/cc-runner.ts has held all five
 *  since it was written — and it was reachable from the API and from Telegram,
 *  but the UI offered four. The customer test found the gap ("No 'max' offered
 *  in either"), and a setting Konrad can reach from his phone but not from his
 *  own console is an omission, not a policy. */
export const ENGINE_EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"] as const;

export const setChatEffort = async (id: string, effort: string) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/effort`, { effort });
  return r.run;
};

/* ----------------------------------------------------------------------------
 * Uploads (chat attachments — drag & drop / paste)
 * -------------------------------------------------------------------------- */
export interface UploadedFile {
  id: string;
  name: string;
  /** Absolute path on the VPS — embedded in the message for the engine. */
  path: string;
  /** Relative API url for browser preview (prepend /api/proxy). */
  url: string;
  mime: string;
  size: number;
}

export const uploadFiles = async (files: File[]): Promise<UploadedFile[]> => {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(`${ROOT}/uploads`, { method: "POST", body: form });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `${res.status} ${res.statusText} on upload`);
  }
  const j = (await res.json()) as { files: UploadedFile[] };
  return j.files;
};

/* ----------------------------------------------------------------------------
 * VPS file explorer — browse the vault/workspace, attach an existing file
 * to a chat without re-uploading it.
 * -------------------------------------------------------------------------- */
export interface FileRoot {
  key: string;
  label: string;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export const fetchFileRoots = async (): Promise<FileRoot[]> => {
  const r = await getJson<{ roots: FileRoot[] }>("/files/roots");
  return r.roots;
};

export const fetchFileList = async (
  root: string,
  path: string,
): Promise<{ entries: FileEntry[]; truncated: boolean; total: number }> => {
  const r = await getJson<{ entries: FileEntry[]; truncated: boolean; total: number }>(
    `/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
  );
  return r;
};

export interface FileSearchEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime: string;
}

/** Recursive filename search under root+path (path="" searches the whole
 *  root). Capped server-side — `truncated` tells the UI more results exist. */
export const searchFiles = async (
  root: string,
  path: string,
  q: string,
): Promise<{ entries: FileSearchEntry[]; truncated: boolean }> =>
  getJson(
    `/files/search?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`,
  );

/** Full browser-usable URL (already proxy-prefixed) — drop straight into
 *  an <img>/<video>/<audio>/<iframe> src, or fetch() it directly for text. */
export const fileReadUrl = (root: string, path: string): string =>
  `${ROOT}/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

export const attachExistingFile = async (
  root: string,
  path: string,
): Promise<UploadedFile> => {
  const r = await postJson<{ file: UploadedFile }>("/files/attach", { root, path });
  return r.file;
};

/** Message block appended below the user's text so the CC engine knows
 *  exactly where the attachments live on disk. */
export function attachmentsBlock(files: UploadedFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map(
    (f) => `- ${f.path} (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))}KB)`,
  );
  return `\n\n[attached-files]\n${lines.join("\n")}\n[/attached-files]`;
}

export const sendChatMessage = async (
  id: string,
  content: string,
  /** Vault-relative path of the drawing open beside the chat, if any. The
   *  server sends the board to the agent in full the first time and only the
   *  changes thereafter, so passing this on every turn is cheap. */
  canvasPath?: string | null,
) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/message`, {
    content,
    ...(canvasPath ? { canvas_path: canvasPath } : {}),
  });
  return r.run;
};

export const setChatStatus = async (id: string, status: RunStatus) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/status`, {
    status,
  });
  return r.run;
};

export const resumeChat = async (id: string) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/resume`, {});
  return r.run;
};

/* ----------------------------------------------------------------------------
 * Vault (Obsidian write path) + Reminders — v2.0 quick capture
 * -------------------------------------------------------------------------- */
export type VaultSection = "Tasks" | "Notes" | "Journal";

export interface VaultWriteResult {
  ok: boolean;
  path: string;
  created: boolean;
}

export const vaultAppend = (input: {
  section: VaultSection;
  text: string;
  prefix?: string;
}) => postJson<VaultWriteResult>("/vault/append", input);

export const vaultCreateNote = (input: {
  title: string;
  content?: string;
  folder?: string;
}) => postJson<VaultWriteResult>("/vault/note", input);

export const fetchVaultDaily = () =>
  getJson<{ path: string; date: string; content: string | null }>(
    "/vault/daily",
  );

export interface Reminder {
  id: string;
  text: string;
  due_at: string;
  recur: "daily" | "weekly" | null;
  status: "pending" | "delivered" | "dismissed";
  source: string;
  created_at: string;
  delivered_at: string | null;
}

export const createReminder = (input: {
  text?: string;
  when: string;
  source?: string;
}) => postJson<{ ok: boolean; reminder: Reminder }>("/reminders", input);

export const fetchReminders = async () => {
  const r = await getJson<{ count: number; reminders: Reminder[] }>(
    "/reminders",
  );
  return r.reminders;
};

export const dismissReminder = (id: string) =>
  postJson<{ ok: boolean }>(`/reminders/${id}/dismiss`);

/* ----------------------------------------------------------------------------
 * Skills (SKILL.md files across system)
 * -------------------------------------------------------------------------- */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  path: string;
  risk?: string;
  enabled: boolean;
  protected: boolean;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  frontmatter: Record<string, unknown>;
  word_count: number;
}

export interface SkillsTokenEstimate {
  enabled_count: number;
  disabled_count: number;
  current_tokens: number;
  all_enabled_tokens: number;
  savings_tokens: number;
}

export const fetchSkills = async () => {
  const r = await getJson<{
    count: number;
    categories: { key: string; count: number; enabled_count: number }[];
    skills: SkillSummary[];
    token_estimate: SkillsTokenEstimate;
  }>("/skills");
  return r;
};

export const fetchSkill = async (id: string) => {
  const r = await getJson<{ skill: SkillDetail }>(
    `/skills/${encodeURIComponent(id)}`,
  );
  return r.skill;
};

export interface SkillToggleResult {
  id: string;
  enabled: boolean;
  entry_name: string;
  symlink_moved: boolean;
}

export const toggleSkill = (id: string, enabled: boolean) =>
  postJson<SkillToggleResult>(`/skills/${encodeURIComponent(id)}/toggle`, {
    enabled,
  });

export const bulkToggleSkills = (
  target: { ids: string[] } | { category: string },
  enabled: boolean,
) =>
  postJson<{
    enabled: boolean;
    results: ((SkillToggleResult & { skipped: false }) | {
      id: string;
      skipped: true;
      reason: string;
    })[];
  }>("/skills/bulk-toggle", { ...target, enabled });

/* ----------------------------------------------------------------------------
 * Skills curator audit (v1.6 Tier-2 backend, v1.8 UI hook)
 * -------------------------------------------------------------------------- */
export type SkillLifecycle =
  | "active"
  | "stale"
  | "archive_candidate"
  | "protected";

export interface SkillLifecycleEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  path: string;
  pinned: boolean;
  lifecycle: SkillLifecycle;
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
  duration_ms: number;
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

export const runCuratorAudit = () =>
  postJson<CuratorAuditResult>("/skills/curate");

/* ----------------------------------------------------------------------------
 * Pipeline (content_jobs grouped by phase)
 * -------------------------------------------------------------------------- */
export interface PipelineCard {
  id: string;
  title: string;
  status: string;
  format: string;
  channel: string;
  template: string;
  age: string;
  updated_at: string;
}

export interface PipelinePhase {
  key: string;
  label: string;
  description: string;
  statuses: string[];
  count: number;
  cards: PipelineCard[];
}

export const fetchPipeline = async () => {
  const r = await getJson<{
    phases: PipelinePhase[];
    total: number;
  }>("/pipeline");
  return r;
};

/* ----------------------------------------------------------------------------
 * Autonomy (guardrail rules + fleet state + recent trips)
 * -------------------------------------------------------------------------- */
export interface GuardrailRule {
  id: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
  builtin: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

export interface GuardrailTrip {
  id: string;
  rule_id: string;
  rule_label: string;
  ts: string;
  agent: string;
  attempted_action: string;
  payload: Record<string, unknown>;
  resolved: boolean;
}

export interface AutonomyResponse {
  fleet: {
    status: "running" | "paused";
    updated_at: string;
    updated_by: string;
  };
  rules: GuardrailRule[];
  trips: GuardrailTrip[];
  categories: { key: string; label: string; count: number }[];
}

export const fetchAutonomy = () => getJson<AutonomyResponse>("/autonomy");

export const updateRule = async (
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
) => {
  const r = await postJson<{ rule: GuardrailRule }>(
    `/autonomy/rules/${encodeURIComponent(id)}`,
    patch,
  );
  return r.rule;
};

/* ----------------------------------------------------------------------------
 * Local fallback so the UI is never blank during the first frame / offline
 * -------------------------------------------------------------------------- */
export const emptyToday: TodayResponse = {
  date: new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }),
  greeting: "Connecting to forge…",
  chips: [],
  needs: [],
  fleet: [],
  spend: { value: "€0.00", cap: "of €50 cap" },
  shipped: { value: "0", pipeline: "0 in pipeline" },
};

export const emptyLive: LiveResponse = {
  stats: [
    { label: "WORKERS", value: "—", tone: "neutral" },
    { label: "JOBS", value: "—", tone: "accent" },
    { label: "QUEUED", value: "—", tone: "soft" },
    { label: "STUCK", value: "—", tone: "stuck" },
  ],
  degradation: [],
  providers: [],
};

export const emptyControl: ControlResponse = {
  fleet: {
    status: "running",
    updated_at: new Date().toISOString(),
    updated_by: "system",
  },
  loops: [],
  invariant: {
    label: "Invariant engine",
    sub: "5 hard rules · enforced pre-dispatch",
  },
  decisionLog: [],
};

// Re-export TabKey for convenience.
export type { TabKey };

/* ----------------------------------------------------------------------------
 * Webhooks (v1.6 tier-2 phase 4)
 * -------------------------------------------------------------------------- */
export interface Webhook {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  secret_preview: string;
  enabled: boolean;
  prompt_template: string;
  title_template: string | null;
  worker_label: string | null;
  total_calls: number;
  last_called_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const fetchWebhooks = async (): Promise<Webhook[]> => {
  const r = await getJson<{ count: number; webhooks: Webhook[] }>("/webhooks");
  return r.webhooks;
};

export const createWebhook = async (input: {
  slug: string;
  name: string;
  description?: string;
  prompt_template: string;
  title_template?: string;
  worker_label?: string;
}): Promise<Webhook> => {
  const r = await postJson<{ webhook: Webhook }>("/webhooks", input);
  return r.webhook;
};

export const updateWebhook = async (
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    prompt_template: string;
    title_template: string | null;
    worker_label: string | null;
    enabled: boolean;
  }>,
): Promise<Webhook> => {
  const r = await patchJson<{ webhook: Webhook }>(`/webhooks/${id}`, patch);
  return r.webhook;
};

export const rotateWebhookSecret = async (
  id: string,
): Promise<string> => {
  const r = await postJson<{ secret: string }>(`/webhooks/${id}/rotate-secret`);
  return r.secret;
};

export const deleteWebhook = async (id: string): Promise<void> => {
  await deleteJson(`/webhooks/${id}`);
};

/* ----------------------------------------------------------------------------
 * Cron schedules (v1.6 tier-2 phase 4)
 * -------------------------------------------------------------------------- */
export interface CronSchedule {
  id: string;
  name: string;
  description: string | null;
  cron_expr: string;
  enabled: boolean;
  prompt_template: string;
  title_template: string | null;
  worker_label: string | null;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  total_fires: number;
  created_at: string;
  updated_at: string;
}

export const fetchSchedules = async (): Promise<CronSchedule[]> => {
  const r = await getJson<{ count: number; schedules: CronSchedule[] }>(
    "/cron",
  );
  return r.schedules;
};

export const previewCron = async (
  cron_expr: string,
  count = 5,
): Promise<string[]> => {
  const r = await postJson<{ fires: string[] }>("/cron/preview", {
    cron_expr,
    count,
  });
  return r.fires;
};

export const createSchedule = async (input: {
  name: string;
  description?: string;
  cron_expr: string;
  prompt_template: string;
  title_template?: string;
  worker_label?: string;
}): Promise<CronSchedule> => {
  const r = await postJson<{ schedule: CronSchedule }>("/cron", input);
  return r.schedule;
};

export const updateSchedule = async (
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    cron_expr: string;
    enabled: boolean;
    prompt_template: string;
    title_template: string | null;
    worker_label: string | null;
  }>,
): Promise<CronSchedule> => {
  const r = await patchJson<{ schedule: CronSchedule }>(`/cron/${id}`, patch);
  return r.schedule;
};

export const deleteSchedule = async (id: string): Promise<void> => {
  await deleteJson(`/cron/${id}`);
  return;
};

/* ----------------------------------------------------------------------------
 * Coding projects — mirrors routes/projects.ts. A task's run is a normal
 * chat run under the hood (same `runs` table), so task detail reuses
 * fetchChat/useRunEvents unchanged — no separate run-fetching path needed.
 * -------------------------------------------------------------------------- */
export type ProjectRepo = "ai-os" | "content-forge";
export type ProjectStatus = "active" | "paused" | "done" | "blocked" | "cancelled";
export type TaskRole = "architect" | "planner" | "scout" | "builder" | "reviewer";
export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "blocked";
export type TaskTier = "fast" | "standard" | "flagship";

export const PROJECT_REPO_OPTIONS: ProjectRepo[] = ["ai-os", "content-forge"];

export interface Project {
  id: string;
  name: string;
  brief: string;
  repo: ProjectRepo;
  workspace_dir: string | null;
  base_branch: string;
  work_branch: string | null;
  status: ProjectStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * One row of `project_tasks`, as `GET /api/projects/:id` and
 * `GET /api/projects/board` serve it.
 *
 * HAND-MIRRORED from `interface ProjectTask` in forge-control/src/db/projects.ts
 * (there is no shared build across the two repos), so it moves in the same
 * commit the server type does. The three graph fields below arrived with
 * migration 0040 and R56.
 */
export interface ProjectTask {
  id: string;
  project_id: string;
  round: number;
  role: TaskRole;
  title: string;
  brief: string;
  status: TaskStatus;
  run_id: string | null;
  fix_cycle: number;
  tier: TaskTier | null;
  /** The tasks this one waits for — THE ORDERING DEPENDENCY, and only that
   *  (migration 0040, R3). `null` is a SENTINEL, not a missing value and not
   *  an empty list: it means "this row was never graph-scheduled, so the
   *  engine applies the legacy round rule to it". A non-null array, INCLUDING
   *  `[]`, means "graph-scheduled: promote when exactly these ids are done",
   *  so `[]` is an explicit root that promotes immediately.
   *
   *  Typed `| null` for that reason and never widened to `string[]` with a
   *  `?? []` at the read site: the two values a defaulting operator would
   *  merge are precisely the two that select different schedulers. The
   *  canonical statement of both meanings is the doc-comment on
   *  `ProjectTask.depends_on` in forge-control/src/db/projects.ts. */
  depends_on: string[] | null;
  /** Which workstream worktree this task runs in (migration 0040, R4).
   *  `'main'` for every row that predates the column and every row that does
   *  not ask for another. Same workstream = same worktree, serialized against
   *  its siblings; different workstreams are isolated directories that may
   *  write the same path. NOT NULL with a default in the schema, so never
   *  null here. */
  workstream: string;
  /** Repo-relative POSIX paths this task intends to write (migration 0040,
   *  R5) — the input to computed contention, declared by the planner rather
   *  than reconstructed by grepping briefs. An EMPTY array intersects nothing
   *  and is therefore always claimable (R17). NOT NULL with a `'{}'` default
   *  in the schema. */
  write_set: string[];
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project_name: string;
}

export const fetchProjects = async (): Promise<Project[]> => {
  const r = await getJson<{ count: number; projects: Project[] }>("/projects");
  return r.projects;
};

export const fetchProject = async (
  id: string,
): Promise<{ project: Project; tasks: ProjectTask[] }> =>
  getJson<{ project: Project; tasks: ProjectTask[] }>(`/projects/${id}`);

/* `fetchProjectBoard` USED TO LIVE HERE and was deleted at the phase 4-6
 * integration. It returned `ProjectTaskWithProject[]`, whose `brief: string` the
 * board endpoint stopped sending when phase 6 column-projected the query — so the
 * type promised a field the JSON no longer carries, and a future caller would
 * have got `undefined` typed as `string` with the compiler's blessing. It had
 * zero callers at deletion (its only one, ProjectsSurface, moved to
 * `fetchProjectBoardCards` in `api-perf.ts`, which is typed
 * `Omit<ProjectTaskWithProject, "brief">` and matches what the server sends).
 *
 * NOTE `brief` ITSELF STAYS on `ProjectTask` above. The board is not the only
 * endpoint that mirror serves — `GET /api/projects/:id` and `GET /api/tasks/:id`
 * both still send a brief, and `fetchTaskBrief` reads it. Deleting the field
 * rather than the over-promising function would have been a build break. */

export const createProject = async (input: {
  name: string;
  brief: string;
  repo: ProjectRepo;
  base_branch?: string;
  architect_tier?: TaskTier;
}): Promise<{ project: Project; architectTask: ProjectTask; warning?: string }> =>
  postJson("/projects", input);

export const setProjectStatus = async (
  id: string,
  status: ProjectStatus,
): Promise<Project> => {
  const r = await postJson<{ project: Project }>(`/projects/${id}/status`, {
    status,
  });
  return r.project;
};

/* ----------------------------------------------------------------------------
 * Secrets — credentials that must never enter the chat thread
 *
 * runs.thread is plain JSONB, replayed into the model's context every turn and
 * captured in nightly backups. A password pasted into a message lives in all
 * three forever. These helpers post the value straight to the server; only the
 * NAME is ever shown or written into the conversation.
 *
 * The reveal helper is the ONLY call in this file that returns a raw secret
 * value. Every other secrets call — list, store, dismiss — deliberately never
 * touches the value. Keep it that way.
 *
 * Request flow (U30): an agent that needs a credential calls
 * `POST /api/secrets/:name/mark-pending` with its request text as the `note`;
 * the list below then carries `pending: true` and that note, and the chat
 * surface answers it with `storeSecret(name, value, undefined, false)` —
 * `undefined` keeps the agent's note on disk, `false` clears the flag. The
 * request half of that round trip is metadata only; no value ever comes back.
 * -------------------------------------------------------------------------- */
export interface SecretMeta {
  name: string;
  bytes: number;
  updatedAt: string;
  note: string | null;
  /** Operator-set marker: this credential was queued for Konrad to collect
   *  and hasn't been revealed yet. UI floats these to the top of the list
   *  with a distinct badge. Cleared on first reveal (or explicit dismiss). */
  pending: boolean;
  /** The run that asked for this credential, if it named itself at
   *  `mark-pending` time (U7, server-validated as a uuid). Advisory lineage
   *  for the UI — null when the requester didn't identify itself. */
  requestedByRunId: string | null;
}

/**
 * Store a value under `name`.
 *
 * `note` omitted leaves whatever note is on disk alone — that is how the chat
 * surface answers an agent's request without erasing the request text.
 * `forKonrad` is tri-state on purpose: `undefined` leaves the pending flag as
 * it is, `false` explicitly CLEARS it (the `!== undefined` guard below is what
 * makes `false` reach the wire as `"for_konrad": false` rather than vanishing),
 * `true` raises it. Server side: `lib/secret-store.ts` putSecret().
 */
export const storeSecret = async (
  name: string,
  value: string,
  note?: string,
  forKonrad?: boolean,
): Promise<SecretMeta> => {
  const r = await postJson<{ secret: SecretMeta }>("/secrets", {
    name,
    value,
    ...(note ? { note } : {}),
    ...(forKonrad !== undefined ? { for_konrad: forKonrad } : {}),
  });
  return r.secret;
};

export const fetchSecrets = async (): Promise<SecretMeta[]> => {
  const r = await getJson<{ secrets: SecretMeta[] }>("/secrets");
  return r.secrets;
};

/** Reveal a stored secret value. POST (not GET) so the name never ends up in
 *  a URL, an access-log line, or a browser-history entry. Callers should
 *  render the value inside an explicitly-triggered UI element and drop it
 *  from memory as soon as it isn't visible. */
export const revealSecret = async (
  name: string,
): Promise<{ name: string; value: string }> =>
  postJson<{ name: string; value: string }>(
    `/secrets/${encodeURIComponent(name)}/reveal`,
  );

/** Dismiss the "for Konrad" flag on a stored secret without revealing it. */
export const clearSecretPending = async (name: string): Promise<void> => {
  await postJson<{ ok: true }>(
    `/secrets/${encodeURIComponent(name)}/clear-pending`,
  );
};

export const deleteSecret = async (name: string): Promise<void> => {
  await deleteJson<{ deleted: true }>(`/secrets/${encodeURIComponent(name)}`);
};

/* ----------------------------------------------------------------------------
 * GOALS/TASKS — the said-vs-done surface (docs/spec-daily-goals.md)
 *
 * The frozen contract is §4 of that spec: GET /api/daily, the five per-day
 * writes under /api/daily/:day/*, the /api/daily/tasks CRUD, /api/daily/rollover
 * and /api/daily/stats. Shapes below mirror the tables in §2 (day_plans,
 * habits, habit_logs, day_tasks) and the score object in §3.
 *
 * The spine (§1): the evening job drafts tomorrow, Konrad COMMITS in the
 * morning, and from that instant the Big 3 text is frozen — `committed_at`
 * being non-null is what turns three inputs into three immutable lines with an
 * abandon affordance. Nothing here recomputes a score; §3 says one place owns
 * that formula and it is the server.
 *
 * Names are prefixed `Day…` rather than `Daily…` to sit beside the block above
 * without colliding with it. Same word, two different data models — reach for
 * the one whose route you are actually calling.
 * -------------------------------------------------------------------------- */

export type DayGoalStatus = "open" | "done" | "abandoned";

/** One of the Big 3. Stored inside `day_plans.big3` as jsonb, so the id
 *  travels with the entry — assigned by whoever wrote it (the evening job, or
 *  this client when Konrad adds a line himself before commit). */
export interface DayGoal {
  id: string;
  text: string;
  why: string | null;
  status: DayGoalStatus;
  /** Why it was given up on. The UI demands one before it will abandon —
   *  §1's whole point is that quitting is recorded, not edited away. */
  reason: string | null;
  done_at: string | null;
}

export interface DayPlan {
  day: string;
  big3: DayGoal[];
  intent: string | null;
  /** NULL = still an editable draft. Non-null = the day is *said*, and the
   *  Big 3 text may no longer be rewritten (§1). */
  committed_at: string | null;
  generated_by: string | null;
  generated_at: string | null;
  subjective: number | null;
  reflection: string | null;
  created_at: string;
  updated_at: string;
}

export type DayHabitGroup = "morning" | "body" | "work" | "evening";
export type DayHabitPolarity = "do" | "avoid";

export interface DayHabit {
  id: string;
  key: string;
  label: string;
  /** Material Symbols glyph name — rendered with `className="ms"`. */
  icon: string;
  grp: string;
  polarity: DayHabitPolarity;
  weight: number;
  sort: number;
  active: boolean;
  created_at: string;
}

/** The day bundle decorates each habit with its current streak, so the chip
 *  can print a streak badge without the STATS window having been fetched. */
export interface DayHabitWithStreak extends DayHabit {
  streak: number;
}

/** A tick. An ABSENT row means not done — there is no third state. */
export interface DayHabitTick {
  day: string;
  habit_id: string;
  done: boolean;
  ts: string;
}

export type DayTaskStatus = "todo" | "doing" | "done" | "parked";
export type DayTaskView = "today" | "week" | "backlog" | "all";

export interface DayTask {
  id: string;
  title: string;
  area: string | null;
  /** 3 critical / 2 high / 1 normal / 0 low. */
  importance: number;
  status: DayTaskStatus;
  planned_day: string | null;
  due_day: string | null;
  est_min: number | null;
  /** Times this task has been rolled onto a new day. >= 3 is stale (§5). */
  carried: number;
  notes: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  /** Calendar days since creation, computed in Berlin terms server-side.
   *  Surfaced ONLY past 14 days (§6) — never as a permanent shame column. */
  age_days: number;
  /** `carried >= 3`. Drives the "This keeps sliding" strip (§5). */
  stale: boolean;
}

/**
 * The day's score, computed once server-side in `lib/day-score.ts` (§3).
 *
 * A component with no denominator is DROPPED and the remaining weights
 * renormalise — a day with no committed Big 3 is scored on habits and tasks
 * alone; `weights` reports what each component actually carried. A dropped
 * component is `null` here, never `0`, and `score` itself is null when nothing
 * had a denominator at all: rendering "missing" as "zero" is precisely the
 * permanent, meaningless 0% that killed the Notion setup (§0.4).
 */
export interface DayScore {
  score: number | null;
  goal_pct: number | null;
  habit_pct: number | null;
  task_pct: number | null;
  weights: { goal: number; habit: number; task: number };
  counts: {
    goals_done: number;
    goals_abandoned: number;
    goals_total: number;
    habits_done_weight: number;
    habits_total_weight: number;
    tasks_done: number;
    tasks_total: number;
  };
  /** score >= 80 — "Day fulfilled — rest guilt-free." (§3). */
  fulfilled: boolean;
}

export interface DailyDayResponse {
  day: string;
  /** null until something writes a plan for that date. */
  plan: DayPlan | null;
  habits: DayHabitWithStreak[];
  ticks: DayHabitTick[];
  tasks: DayTask[];
  /** `provisional` is true for today: real, but the day is not over, and the
   *  UI must say so rather than let a 10:00 number read as a verdict. */
  score: DayScore & { provisional: boolean };
  stale_at: number;
}

export interface DayStatsDay {
  day: string;
  score: number | null;
  habit_pct: number | null;
  goal_pct: number | null;
  task_pct: number | null;
  subjective: number | null;
}

export interface DayStatsHabit {
  id: string;
  key: string;
  label: string;
  icon: string;
  grp: string;
  /** 0..1 over the last 30 days. */
  rate30: number;
  streak: number;
  best: number;
  /** The days inside that 30-day window that were ticked — the sparkline. */
  ticks30: string[];
}

export interface DayStats {
  window: { days: number; from: string; to: string };
  days: DayStatsDay[];
  habits: DayStatsHabit[];
  /** The headline of the STATS tab (§6). `rate` is 0..1, or null when nothing
   *  was committed in the window — no denominator, no percentage. */
  said_vs_done: {
    committed: number;
    done: number;
    abandoned: number;
    open: number;
    rate: number | null;
  };
  tasks: {
    done_by_day: { day: string; n: number }[];
    open: number;
    stale: number;
  };
  streak: { current: number; best: number };
}

/**
 * §4 pins the routes and their request bodies, not what the writes return.
 * The surface never reads a mutation's result — each one invalidates
 * `["daily"]` and re-reads GET /api/daily, which IS specified — so this is
 * typed as the honest `unknown` rather than a shape invented here that would
 * be quietly wrong the first time the server disagreed.
 */
type DayWriteResult = unknown;

export const fetchDailyDay = (day?: string): Promise<DailyDayResponse> =>
  getJson<DailyDayResponse>(
    day ? `/daily?day=${encodeURIComponent(day)}` : "/daily",
  );

/** Draft edit of the intent line and/or the Big 3. 409 once committed (§1) —
 *  callers surface that as "abandon instead of editing", never as a silent
 *  no-op. */
export const saveDayPlan = (
  day: string,
  input: { intent?: string | null; big3?: DayGoal[] },
): Promise<DayWriteResult> =>
  postJson<DayWriteResult>(`/daily/${encodeURIComponent(day)}/plan`, input);

/** Freeze the Big 3 and stamp `committed_at`. Idempotent. */
export const commitDay = (day: string): Promise<DayWriteResult> =>
  postJson<DayWriteResult>(`/daily/${encodeURIComponent(day)}/commit`);

export const setDayGoalStatus = (
  day: string,
  goalId: string,
  input: { status: DayGoalStatus; reason?: string },
): Promise<DayWriteResult> =>
  postJson<DayWriteResult>(
    `/daily/${encodeURIComponent(day)}/goal/${encodeURIComponent(goalId)}`,
    input,
  );

export const reflectDay = (
  day: string,
  input: { subjective?: number; reflection?: string },
): Promise<DayWriteResult> =>
  postJson<DayWriteResult>(`/daily/${encodeURIComponent(day)}/reflect`, input);

/** Upsert on true, delete the row on false. The chip flips optimistically and
 *  reconciles against the refetch — a tick that waits on a round trip is a
 *  tick that stops happening. */
export const setDayHabit = (
  day: string,
  habitId: string,
  done: boolean,
): Promise<DayWriteResult> =>
  postJson<DayWriteResult>(
    `/daily/${encodeURIComponent(day)}/habit/${encodeURIComponent(habitId)}`,
    { done },
  );

/**
 * §4 gives the query string but not the envelope; `routes/daily.ts` answers
 * `{view, day, count, stale_at, tasks}`, which is the wrapped shape every
 * other list route in forge-control uses. A bare array is read too, and
 * anything else throws with the keys it actually got. The failure mode being
 * avoided is an empty planner that looks like an empty day.
 */
export const fetchDayTasks = async (params?: {
  view?: DayTaskView;
  area?: string;
  status?: DayTaskStatus;
}): Promise<DayTask[]> => {
  const qs = new URLSearchParams();
  if (params?.view) qs.set("view", params.view);
  if (params?.area) qs.set("area", params.area);
  if (params?.status) qs.set("status", params.status);
  const path = qs.toString() ? `/daily/tasks?${qs.toString()}` : "/daily/tasks";
  const r = await getJson<DayTask[] | { tasks?: DayTask[] }>(path);
  if (Array.isArray(r)) return r;
  if (Array.isArray(r.tasks)) return r.tasks;
  throw new Error(
    `GET ${path}: expected {tasks:[…]} or an array, got keys [${Object.keys(
      r as Record<string, unknown>,
    ).join(", ")}]`,
  );
};

export interface DayTaskInput {
  title: string;
  area?: string | null;
  importance?: number | null;
  planned_day?: string | null;
  due_day?: string | null;
  est_min?: number | null;
  notes?: string | null;
}

export const createDayTask = (input: DayTaskInput): Promise<DayWriteResult> =>
  postJson<DayWriteResult>("/daily/tasks", input);

export const updateDayTask = (
  id: string,
  patch: Partial<DayTaskInput> & { status?: DayTaskStatus; carried?: number },
): Promise<DayWriteResult> =>
  patchJson<DayWriteResult>(`/daily/tasks/${encodeURIComponent(id)}`, patch);

export const deleteDayTask = (id: string): Promise<DayWriteResult> =>
  deleteJson<DayWriteResult>(`/daily/tasks/${encodeURIComponent(id)}`);

/** The anti-graveyard sweep (§5): every open task planned before today moves
 *  onto today and `carried` goes up by one. Idempotent per day — the evening
 *  job calls it too, so a manual press can only ever be a no-op. */
export const rolloverDayTasks = (to?: string): Promise<DayWriteResult> =>
  postJson<DayWriteResult>("/daily/rollover", to ? { to } : {});

export const fetchDayStats = (days = 90): Promise<DayStats> =>
  getJson<DayStats>(`/daily/stats?days=${days}`);
