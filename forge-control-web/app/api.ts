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

export const resolveInboxItem = async (
  id: string,
  payload: {
    resolved_by?: string;
    action_id?: string;
    resolution?: Record<string, unknown>;
  } = {},
) => {
  const { action_id, resolution, ...rest } = payload;
  const merged =
    action_id !== undefined
      ? { ...rest, resolution: { ...(resolution ?? {}), action_id } }
      : { ...rest, resolution };
  return postJson<{ item: InboxApiItem }>(`/inbox/${id}/resolve`, merged);
};

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

export interface MemoryNote {
  id: string;
  slug: string;
  topic: string;
  vault_path: string;
  category: MemoryCategory;
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

export const fetchMemoryList = async (): Promise<MemoryNote[]> => {
  const r = await getJson<{ count: number; notes: MemoryNote[] }>("/memory");
  return r.notes;
};

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
  kind?: "text" | "tool_call" | "tool_result" | "heartbeat" | "error";
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

export const fetchChatList = async () => {
  const r = await getJson<{
    count: number;
    runs: RunSummary[];
    counts: Record<RunStatus, number>;
  }>("/chat");
  return r;
};

export const fetchChat = async (id: string) => {
  const r = await getJson<{ run: RunDetail }>(`/chat/${id}`);
  return r.run;
};

export const createChat = async (input: {
  prompt: string;
  title?: string;
  worker?: string;
  budget_usd?: number;
}) => {
  const r = await postJson<{ run: RunDetail }>("/chat", input);
  return r.run;
};

export const sendChatMessage = async (id: string, content: string) => {
  const r = await postJson<{ run: RunDetail }>(`/chat/${id}/message`, {
    content,
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
}

export interface SkillDetail extends SkillSummary {
  body: string;
  frontmatter: Record<string, unknown>;
  word_count: number;
}

export const fetchSkills = async () => {
  const r = await getJson<{
    count: number;
    categories: { key: string; count: number }[];
    skills: SkillSummary[];
  }>("/skills");
  return r;
};

export const fetchSkill = async (id: string) => {
  const r = await getJson<{ skill: SkillDetail }>(
    `/skills/${encodeURIComponent(id)}`,
  );
  return r.skill;
};

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
