"use client";

/**
 * mapApi.ts — the browser-side contract for `GET /api/map`.
 *
 * WHY THIS FILE EXISTS. Round 3 shipped a MAP whose nodes were hand-authored
 * constants: repos that 404, domains that are not in /etc/nginx, datastores
 * that always read "Listening". The brief's rule is explicit — *a node that
 * does not correspond to something real must not appear* — so every figure on
 * the MAP surface now comes through here, and here reads exactly one producer:
 * forge-control's `/api/map`, which itself only joins pm2 / systemd / nginx /
 * df / ss / the vault.
 *
 * The types below MIRROR `forge-control/src/routes/map.ts`. They are duplicated
 * rather than imported because forge-control-web does not compile against the
 * API package; keep the two in step and a diff of either file shows it.
 *
 * NO SILENT FALLBACKS. A transport failure throws with the URL and the status.
 * A section that failed server-side stays `{ ok: false, error }` and every
 * consumer is expected to render that error — never a plausible number.
 */

/* ── Section envelope (mirrors routes/map.ts) ────────────────────────────── */

export interface MapSectionOk<T> {
  ok: true;
  checked_at: string;
  source: string;
  data: T;
}

export interface MapSectionFailed {
  ok: false;
  checked_at: string;
  source: string;
  error: string;
}

export type MapSection<T> = MapSectionOk<T> | MapSectionFailed;

/* ── Section payloads ────────────────────────────────────────────────────── */

export interface BusinessProject {
  name: string;
  status: string;
  type: string;
  deployed: string;
  path_exists: boolean | null;
}

export interface BusinessesData {
  note: string;
  note_mtime: string;
  projects: BusinessProject[];
  active: number;
  archived: number;
}

export interface MapProcess {
  name: string;
  pid: number | null;
  status: string;
  restarts: number;
  uptime_ms: number;
  cpu_pct: number;
  memory_bytes: number;
  cwd: string | null;
  script: string | null;
}

export interface ProcessesData {
  count: number;
  online: number;
  processes: MapProcess[];
}

export interface MapUnit {
  name: string;
  active: string;
  sub: string;
  description: string;
}

export interface UnitsData {
  count: number;
  units: MapUnit[];
}

export interface MapDomain {
  domain: string;
  file: string;
  ports: number[];
  ssl: boolean;
  upstreams: string[];
  roots: string[];
  ssl_expires_at: string | null;
  ssl_days_left: number | null;
  ssl_error: string | null;
}

export interface DomainsData {
  dir: string;
  files: number;
  count: number;
  domains: MapDomain[];
  errors: { file: string; error: string }[];
}

export interface MapDisk {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_pct: number;
}

export interface MapListener {
  port: number;
  process: string | null;
  address: string;
}

export interface MapDatastore {
  name: string;
  port: number;
  listening: boolean;
  process: string | null;
}

export interface StorageData {
  disks: MapDisk[];
  memory: {
    total_bytes: number;
    used_bytes: number;
    available_bytes: number;
    used_pct: number;
  };
  datastores: MapDatastore[];
  listeners: MapListener[];
}

export interface MapCanvas {
  path: string;
  name: string;
  folder: string;
  mtime: string;
  size: number;
}

export interface CanvasesData {
  count: number;
  canvases: MapCanvas[];
}

export type MapSectionName =
  | "businesses"
  | "processes"
  | "units"
  | "domains"
  | "storage"
  | "canvases";

export interface MapPayload {
  generated_at: string;
  host: { name: string; ip: string };
  failed_sections: string[];
  sections: {
    businesses?: MapSection<BusinessesData>;
    processes?: MapSection<ProcessesData>;
    units?: MapSection<UnitsData>;
    domains?: MapSection<DomainsData>;
    storage?: MapSection<StorageData>;
    canvases?: MapSection<CanvasesData>;
  };
}

/* ── Fetch ───────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `GET /api/map`, optionally narrowed with `?only=`.
 *
 * Throws — with the URL, the status and, for a 400, the server's own list of
 * valid section names — rather than returning a half-built object. Callers
 * catch and show the message; nothing here degrades quietly into defaults.
 */
export async function fetchMap(only?: MapSectionName[]): Promise<MapPayload> {
  const qs = only && only.length > 0 ? `?only=${only.join(",")}` : "";
  const url = `/api/proxy/map${qs}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `${url} — network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${url} → HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`,
    );
  }

  const json: unknown = await res.json();
  if (!isRecord(json) || !isRecord(json.sections)) {
    throw new Error(
      `${url} returned a body with no "sections" object — the aggregator's shape changed`,
    );
  }
  return json as unknown as MapPayload;
}

/* ── Reading a section without inventing one ─────────────────────────────── */

/** `data` when the section succeeded, otherwise `null`. Never a stand-in. */
export function sectionData<T>(section: MapSection<T> | undefined): T | null {
  return section && section.ok ? section.data : null;
}

/**
 * The one-line reason a section is not on screen. `null` means "it is fine".
 * An absent section is its own message: `?only=` did not ask for it, which is
 * a caller bug worth surfacing rather than rendering as empty.
 */
export function sectionError(
  section: MapSection<unknown> | undefined,
  name: MapSectionName,
): string | null {
  if (section === undefined) return `/api/map returned no "${name}" section`;
  if (!section.ok) return section.error;
  return null;
}

/* ── Formatting shared by the map components ─────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** `HH:MM:SS` — when the producer last measured, shown next to every figure. */
export function formatCheckedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}
