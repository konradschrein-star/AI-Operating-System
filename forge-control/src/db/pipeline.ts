/**
 * Pipeline (content_jobs collapsed into phase buckets).
 *
 * The ~40 job_status enum values map to 7 user-facing phases. Each phase
 * shows a count + most recent cards. Unknown statuses fall into "other".
 */

import pg from "pg";

const { Pool } = pg;

const CONTENT_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:your_postgres_password@127.0.0.1:5432/content_forge";

const pool = new Pool({
  connectionString: CONTENT_URL,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (e) => console.error("[pipeline pool]", e.message));

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

const PHASES: {
  key: string;
  label: string;
  description: string;
  match: RegExp;
}[] = [
  {
    key: "idea",
    label: "Idea",
    description: "Topic + brief, pre-script",
    match: /^(IDEA_GENERATION|TOPIC_SELECTION|BRIEF)/i,
  },
  {
    key: "script",
    label: "Script",
    description: "Scripting → script ready",
    match: /^(SCRIPTING|SCRIPT_READY|SCRIPT_REVIEW)/i,
  },
  {
    key: "voice",
    label: "Voice",
    description: "TTS generation",
    match: /(TTS|VOICE)/i,
  },
  {
    key: "assets",
    label: "Assets",
    description: "Image / clip / asset collection",
    match: /(ASSET|IMAGE|CLIP|FOOTAGE|HEYGEN)/i,
  },
  {
    key: "qc",
    label: "QC",
    description: "QMS validation + manual gates",
    match: /(QMS|QC|AWAITING)/i,
  },
  {
    key: "render",
    label: "Render",
    description: "Routing + render + stitch",
    match: /(ROUTING_RENDER|RENDER|STITCH|FAILED_RENDER)/i,
  },
  {
    key: "publish",
    label: "Publish",
    description: "Uploader → published",
    match: /(UPLOAD|PUBLISH)/i,
  },
];

function phaseFor(status: string): string {
  if (status === "MARKED_FOR_DELETION") return "deleted";
  for (const p of PHASES) if (p.match.test(status)) return p.key;
  return "other";
}

function humanAge(ts: string | null): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export async function getPipeline(): Promise<{
  phases: PipelinePhase[];
  total: number;
}> {
  const r = await pool.query<{
    id: string;
    title: string;
    status: string;
    format: string;
    channel: string;
    template: string;
    status_updated_at: string;
  }>(
    `SELECT j.id::text, j.title, j.status::text AS status, j.format::text AS format,
            COALESCE(c.name, '—') AS channel,
            COALESCE(t.name, '—') AS template,
            j.status_updated_at::text AS status_updated_at
       FROM content_jobs j
       LEFT JOIN channels c ON c.id = j.channel_id
       LEFT JOIN content_templates t ON t.id = j.template_id
       WHERE j.status <> 'MARKED_FOR_DELETION'
       ORDER BY j.status_updated_at DESC
       LIMIT 500`,
  );

  const phaseMap = new Map<string, PipelineCard[]>();
  const phaseStatusSet = new Map<string, Set<string>>();
  for (const p of PHASES) {
    phaseMap.set(p.key, []);
    phaseStatusSet.set(p.key, new Set());
  }
  phaseMap.set("other", []);
  phaseStatusSet.set("other", new Set());

  for (const row of r.rows) {
    const card: PipelineCard = {
      id: row.id,
      title: row.title,
      status: row.status,
      format: row.format,
      channel: row.channel,
      template: row.template,
      age: humanAge(row.status_updated_at),
      updated_at: row.status_updated_at,
    };
    const key = phaseFor(row.status);
    const arr = phaseMap.get(key) ?? phaseMap.get("other")!;
    if (arr.length < 20) arr.push(card);
    phaseStatusSet.get(key)?.add(row.status);
  }

  const phases: PipelinePhase[] = PHASES.map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    statuses: [...(phaseStatusSet.get(p.key) ?? [])],
    count: phaseMap.get(p.key)?.length ?? 0,
    cards: phaseMap.get(p.key) ?? [],
  }));
  const otherCount = phaseMap.get("other")?.length ?? 0;
  if (otherCount > 0) {
    phases.push({
      key: "other",
      label: "Other",
      description: "Unbucketed states",
      statuses: [...(phaseStatusSet.get("other") ?? [])],
      count: otherCount,
      cards: phaseMap.get("other") ?? [],
    });
  }

  return { phases, total: r.rows.length };
}
