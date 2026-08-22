/**
 * /api/map — the topology aggregator behind the MAP surface.
 *
 * Konrad asked for "the map of the AI operating system and all of my
 * businesses". Three quarters of that was already measured somewhere and
 * nowhere joined: PM2 knows the processes, systemd knows the units, the vault
 * knows the ventures, /etc/nginx knows the front doors, /proc knows the metal.
 * This route is the join, and nothing else — it computes no new truth, it
 * only reads the producers that already exist.
 *
 *   GET /api/map            → every section
 *   GET /api/map?only=a,b   → just those sections (cheap re-fetch after a retry)
 *
 * SECTIONAL ERROR ISOLATION is the contract. Each section is wrapped so a
 * failure becomes `{ ok: false, error }` for THAT section and the rest of the
 * payload still renders. `/api/map` therefore answers 200 with an honest
 * partial body rather than 500 with nothing — a dark ingress column must not
 * take the process list down with it. The only 400 is an unknown `only=`
 * name, which is a caller bug and must not be answered with silence.
 *
 * Every section carries `checked_at` and its `source`, so nothing on the MAP
 * screen can present a figure without saying where it came from and when.
 */

import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.ts";
import { readNginxVhosts, type NginxVhost } from "../lib/nginx-parser.ts";

const r = new Hono();

const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? "/opt/obsidian-vault";

/* ── Section envelope ────────────────────────────────────────────────────── */

export interface MapSectionOk<T> {
  ok: true;
  checked_at: string;
  /** Where the numbers come from — a command, a file, a directory. */
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

async function section<T>(
  source: string,
  fn: () => Promise<T>,
): Promise<MapSection<T>> {
  const checked_at = new Date().toISOString();
  try {
    return { ok: true, checked_at, source, data: await fn() };
  } catch (err) {
    return {
      ok: false,
      checked_at,
      source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ── (a) Businesses — parsed from the vault, never invented ──────────────── */

const OVERVIEW_NOTE = "90_AI_OS/Konrad Projects Overview.md";
const MASTER_MAP_NOTE = "90_AI_OS/Infrastructure - Master Map.md";

export interface BusinessProject {
  name: string;
  status: string;
  type: string;
  /** The "Deployed" column: a path, a host, or "Not deployed". */
  deployed: string;
  /** True when `deployed` names a path that exists on this box. */
  path_exists: boolean | null;
}

export interface BusinessesData {
  note: string;
  note_mtime: string;
  projects: BusinessProject[];
  active: number;
  archived: number;
}

/** `[[Project - Content Forge]]` → `Project - Content Forge`. */
function stripWikilink(cell: string): string {
  const m = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(cell.trim());
  return (m ? m[1] : cell).trim();
}

/**
 * Pull the `## All Projects` table out of the overview note. Exported for
 * the test: this is the one place where a vault edit changes the map, and a
 * silently empty table would read on screen as "Konrad has no businesses".
 * An absent/renamed table is therefore an ERROR, not an empty list.
 */
export function parseProjectsTable(markdown: string): BusinessProject[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+All Projects\s*$/.test(l.trim()));
  if (start === -1) {
    throw new Error(
      `"## All Projects" heading not found in ${OVERVIEW_NOTE} — the note was restructured; the map's business section must be repointed rather than left showing nothing`,
    );
  }
  const rows: BusinessProject[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) break; // next section
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^-{2,}$/.test(cells[0].replace(/[\s:]/g, "-"))) continue; // ---|---
    if (cells[0].toLowerCase() === "project") continue; // header
    rows.push({
      name: stripWikilink(cells[0]),
      status: cells[1],
      type: cells[2],
      deployed: cells[3],
      path_exists: null,
    });
  }
  if (rows.length === 0) {
    throw new Error(
      `"## All Projects" in ${OVERVIEW_NOTE} contains no table rows — refusing to report zero businesses as a healthy answer`,
    );
  }
  return rows;
}

async function businessesSection(): Promise<BusinessesData> {
  const abs = path.join(VAULT_DIR, OVERVIEW_NOTE);
  const st = await fs.stat(abs);
  const text = await fs.readFile(abs, "utf8");
  const projects = parseProjectsTable(text);
  // The "Deployed" cell is often an absolute path. Confirming it exists is
  // the difference between a map and a wish — a project whose directory is
  // gone must not render as deployed.
  for (const p of projects) {
    if (p.deployed.startsWith("/")) {
      p.path_exists = await fs
        .stat(p.deployed)
        .then(() => true)
        .catch(() => false);
    }
  }
  return {
    note: OVERVIEW_NOTE,
    note_mtime: st.mtime.toISOString(),
    projects,
    active: projects.filter((p) => p.status.toLowerCase() === "active").length,
    archived: projects.filter((p) => p.status.toLowerCase() === "archived").length,
  };
}

/* ── (b) PM2 processes ───────────────────────────────────────────────────── */

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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Mirrors routes/pm2.ts's mapping deliberately: exec'ing `pm2 jlist` here is
 * one process spawn, while calling our own HTTP endpoint from inside the same
 * server means guessing our own port and re-entering the request stack. The
 * two mappings must stay in step; the shapes are named identically so a diff
 * shows it.
 */
async function processesSection(): Promise<ProcessesData> {
  const { ok, stdout, stderr } = await run("pm2 jlist", 8000);
  if (!ok) throw new Error(stderr.trim() || "pm2 jlist failed");
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`pm2 jlist returned invalid JSON (${stdout.length} bytes)`);
  }
  if (!Array.isArray(raw)) throw new Error("pm2 jlist did not return an array");
  const processes: MapProcess[] = raw.map((entry) => {
    const p = asRecord(entry);
    const env = asRecord(p.pm2_env);
    const monit = asRecord(p.monit);
    const execPath = str(env.pm_exec_path);
    const uptime = num(env.pm_uptime, 0);
    return {
      name: str(p.name) ?? "(unnamed)",
      pid: typeof p.pid === "number" ? p.pid : null,
      status: str(env.status) ?? "unknown",
      restarts: num(env.restart_time, 0),
      uptime_ms: uptime > 0 ? Date.now() - uptime : 0,
      cpu_pct: num(monit.cpu, 0),
      memory_bytes: num(monit.memory, 0),
      cwd: str(env.pm_cwd),
      script: execPath ? execPath.split("/").pop() ?? null : null,
    };
  });
  return {
    count: processes.length,
    online: processes.filter((p) => p.status === "online").length,
    processes,
  };
}

/* ── (c) systemd units ───────────────────────────────────────────────────── */

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

async function unitsSection(): Promise<UnitsData> {
  const { ok, stdout, stderr } = await run(
    "systemctl list-units --type=service --state=running --no-pager --no-legend",
    8000,
  );
  if (!ok) throw new Error(stderr.trim() || "systemctl list-units failed");
  const units: MapUnit[] = stdout
    .split("\n")
    .map((l) => l.replace(/^[●○*]\s+/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(/\s+/);
      const [name, , active, sub, ...rest] = cols;
      return { name, active, sub, description: rest.join(" ") };
    })
    .filter((u) => Boolean(u.name));
  return { count: units.length, units };
}

/* ── (d) Nginx domains ───────────────────────────────────────────────────── */

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
  /** Files that could not be read or parsed — named, never dropped. */
  errors: { file: string; error: string }[];
}

/** One row per server_name, because that is the unit Konrad navigates by. */
function domainRows(v: NginxVhost): MapDomain[] {
  const ports = Array.from(
    new Set(v.listens.map((l) => l.port).filter((p): p is number => p !== null)),
  ).sort((a, b) => a - b);
  const ssl = v.listens.some((l) => l.ssl);
  const names = v.server_names.length > 0 ? v.server_names : ["(no server_name)"];
  return names.map((domain) => ({
    domain,
    file: v.file,
    ports,
    ssl,
    upstreams: v.upstreams,
    roots: v.roots,
    ssl_expires_at: v.ssl_expires_at,
    ssl_days_left: v.ssl_days_left,
    ssl_error: v.ssl_error,
  }));
}

async function domainsSection(): Promise<DomainsData> {
  const scan = await readNginxVhosts();
  const domains = scan.vhosts.flatMap(domainRows);
  domains.sort((a, b) => a.domain.localeCompare(b.domain));
  return {
    dir: scan.dir,
    files: scan.files.length,
    count: domains.length,
    domains,
    errors: scan.errors,
  };
}

/* ── (e) Storage, memory, databases ──────────────────────────────────────── */

export interface MapDisk {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_pct: number;
}

export interface MapListener {
  port: number;
  /** What we believe listens there, from the ss -ltnp process column. */
  process: string | null;
  address: string;
}

export interface StorageData {
  disks: MapDisk[];
  memory: { total_bytes: number; used_bytes: number; available_bytes: number; used_pct: number };
  /** Known data services and whether something is actually listening. */
  datastores: { name: string; port: number; listening: boolean; process: string | null }[];
  listeners: MapListener[];
}

/**
 * The data ports this box is documented to run. `listening` and `process` are
 * MEASURED (ss -ltnpH); the name says the engine and the port and nothing
 * else. Which database lives behind 5432 versus 5434 is exactly the claim the
 * repo has already been wrong about once, so this endpoint does not make it.
 */
const KNOWN_DATASTORES: { name: string; port: number }[] = [
  { name: "PostgreSQL :5432", port: 5432 },
  { name: "PostgreSQL :5434", port: 5434 },
  { name: "Redis :6379", port: 6379 },
  { name: "Redis :6382", port: 6382 },
  { name: "CouchDB :5984 (Obsidian LiveSync)", port: 5984 },
  { name: "Ollama :11434", port: 11434 },
];

async function readListeners(): Promise<MapListener[]> {
  const { ok, stdout, stderr } = await run("ss -ltnpH", 5000);
  if (!ok) throw new Error(stderr.trim() || "ss -ltnpH failed");
  const listeners: MapListener[] = [];
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const m = /:(\d+)$/.exec(local);
    if (!m) continue;
    const users = /users:\(\("([^"]+)"/.exec(line);
    listeners.push({
      port: Number(m[1]),
      process: users ? users[1] : null,
      address: local,
    });
  }
  return listeners;
}

async function readDisks(): Promise<MapDisk[]> {
  const { ok, stdout, stderr } = await run("df -B1 -P / /opt", 5000);
  if (!ok) throw new Error(stderr.trim() || "df failed");
  const disks: MapDisk[] = [];
  const seen = new Set<string>();
  const lines = stdout.trim().split("\n").slice(1);
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const total = Number(cols[1]);
    const used = Number(cols[2]);
    const avail = Number(cols[3]);
    if (!Number.isFinite(total) || total <= 0) continue;
    // /opt is on the root filesystem here, so df reports the SAME mount twice.
    // Two identical 971 GB bars side by side read as two disks; dedupe on the
    // mount point df actually resolved to.
    const mount = cols[5];
    if (seen.has(mount)) continue;
    seen.add(mount);
    disks.push({
      mount,
      total_bytes: total,
      used_bytes: used,
      available_bytes: avail,
      used_pct: Math.round((used / total) * 1000) / 10,
    });
  }
  if (disks.length === 0) throw new Error(`df returned no parseable rows: ${stdout.trim()}`);
  return disks;
}

async function readMemory(): Promise<StorageData["memory"]> {
  const raw = await fs.readFile("/proc/meminfo", "utf8");
  const get = (key: string): number => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    if (!m) throw new Error(`/proc/meminfo has no ${key} line`);
    return Number(m[1]) * 1024;
  };
  const total = get("MemTotal");
  const available = get("MemAvailable");
  const used = total - available;
  return {
    total_bytes: total,
    used_bytes: used,
    available_bytes: available,
    used_pct: Math.round((used / total) * 1000) / 10,
  };
}

async function storageSection(): Promise<StorageData> {
  const [disks, memory, listeners] = await Promise.all([
    readDisks(),
    readMemory(),
    readListeners(),
  ]);
  const byPort = new Map<number, MapListener>();
  for (const l of listeners) if (!byPort.has(l.port)) byPort.set(l.port, l);
  return {
    disks,
    memory,
    datastores: KNOWN_DATASTORES.map((d) => {
      const hit = byPort.get(d.port);
      return { ...d, listening: hit !== undefined, process: hit?.process ?? null };
    }),
    listeners,
  };
}

/* ── (f) Canvas planning drawings ────────────────────────────────────────── */

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

const CANVAS_EXT = ".excalidraw.md";
const CANVAS_SCAN_CAP = 500;

/** Small walk rather than an import from routes/canvas.ts, whose walker is
 *  private to that router. Capped so a pathological vault cannot turn one map
 *  request into an unbounded filesystem sweep. */
async function walkCanvases(dir: string, out: string[]): Promise<void> {
  if (out.length >= CANVAS_SCAN_CAP) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= CANVAS_SCAN_CAP) return;
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walkCanvases(abs, out);
    else if (e.name.endsWith(CANVAS_EXT)) out.push(abs);
  }
}

async function canvasesSection(): Promise<CanvasesData> {
  await fs.stat(VAULT_DIR); // an unreadable vault is an error, not "no drawings"
  const files: string[] = [];
  await walkCanvases(VAULT_DIR, files);
  const canvases: MapCanvas[] = [];
  for (const abs of files) {
    const st = await fs.stat(abs).catch(() => null);
    if (!st) continue;
    const rel = path.relative(VAULT_DIR, abs);
    canvases.push({
      path: rel,
      name: path.basename(abs, CANVAS_EXT),
      folder: path.dirname(rel) === "." ? "" : path.dirname(rel),
      mtime: st.mtime.toISOString(),
      size: st.size,
    });
  }
  canvases.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { count: canvases.length, canvases };
}

/* ── The route ───────────────────────────────────────────────────────────── */

const SECTION_SOURCES: Record<string, string> = {
  businesses: `${VAULT_DIR}/${OVERVIEW_NOTE} (see also ${MASTER_MAP_NOTE})`,
  processes: "pm2 jlist",
  units: "systemctl list-units --type=service --state=running",
  domains: "/etc/nginx/sites-enabled (lib/nginx-parser.ts)",
  storage: "df -B1 -P, /proc/meminfo, ss -ltnpH",
  canvases: `${VAULT_DIR}/**/*.excalidraw.md`,
};

export const MAP_SECTION_NAMES = Object.keys(SECTION_SOURCES);

r.get("/", async (c) => {
  const onlyParam = c.req.query("only");
  let wanted = MAP_SECTION_NAMES;
  if (onlyParam !== undefined) {
    const asked = onlyParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = asked.filter((s) => !MAP_SECTION_NAMES.includes(s));
    if (unknown.length > 0) {
      return c.json(
        {
          error: `unknown section(s): ${unknown.join(", ")}. Known: ${MAP_SECTION_NAMES.join(", ")}`,
        },
        400,
      );
    }
    if (asked.length > 0) wanted = asked;
  }

  const want = (name: string): boolean => wanted.includes(name);
  const [businesses, processes, units, domains, storage, canvases] = await Promise.all([
    want("businesses")
      ? section(SECTION_SOURCES.businesses, businessesSection)
      : Promise.resolve(null),
    want("processes")
      ? section(SECTION_SOURCES.processes, processesSection)
      : Promise.resolve(null),
    want("units") ? section(SECTION_SOURCES.units, unitsSection) : Promise.resolve(null),
    want("domains")
      ? section(SECTION_SOURCES.domains, domainsSection)
      : Promise.resolve(null),
    want("storage")
      ? section(SECTION_SOURCES.storage, storageSection)
      : Promise.resolve(null),
    want("canvases")
      ? section(SECTION_SOURCES.canvases, canvasesSection)
      : Promise.resolve(null),
  ]);

  const sections: Record<string, MapSection<unknown>> = {};
  if (businesses) sections.businesses = businesses;
  if (processes) sections.processes = processes;
  if (units) sections.units = units;
  if (domains) sections.domains = domains;
  if (storage) sections.storage = storage;
  if (canvases) sections.canvases = canvases;

  const failed = Object.entries(sections)
    .filter(([, s]) => !s.ok)
    .map(([name]) => name);

  c.header("Cache-Control", "private, max-age=5");
  return c.json({
    generated_at: new Date().toISOString(),
    host: { name: "VPS1", ip: "65.108.6.149" },
    /* A partial map is served as 200 with these names filled in. The UI
     * renders a retry per failed section; nothing here is silently empty. */
    failed_sections: failed,
    sections,
  });
});

export default r;
