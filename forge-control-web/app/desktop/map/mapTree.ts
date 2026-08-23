/**
 * mapTree.ts — turns one `/api/map` payload into the Mind Map's node tree.
 *
 * This is the file the round-3 review was about. The MAP used to be a literal:
 * ventures, domains and GitHub links typed out by hand, three of which 404'd
 * and seven of which named domains `/etc/nginx` has never heard of. The brief's
 * rule — *a node that does not correspond to something real must not appear* —
 * is enforced here structurally: `buildMapTree` takes the aggregator payload
 * and NOTHING else, so there is no channel through which a belief can reach the
 * screen. Delete a project from the vault note, stop a pm2 process, remove a
 * vhost, and the node is gone on the next fetch.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not invent status. A vault table saying "Active" is a claim by
 *    Konrad, not a measurement, so a business node's dot comes from what this
 *    box can check — does the deployed path exist, is a pm2 process running out
 *    of it — and `statusLabel` always spells out which of those was true.
 *  - It does not cover VPS2. `/api/map` measures this host; the VPS2 management
 *    key was revoked server-side on 2026-08-06 and the surviving key is pinned
 *    to a forced command, so nothing on 167.233.145.218 can be measured from
 *    here today. An unmeasurable host is left OFF the map rather than drawn
 *    from memory — see evidence/library-map-verification.md.
 *
 * Pure and dependency-free on purpose: `mapTree.test.ts` runs it under
 * `tsx --test` with no DOM.
 */

import type {
  MapPayload,
  MapProcess,
  MapSection,
  MapSectionName,
} from "./mapApi";
import { formatBytes, formatUptime, sectionError } from "./mapApi";
import type { MindMapNode, MindMapStatus } from "./MapInspectorDrawer";

/** A top-level column of the mind map. */
export interface MapBranch {
  key: string;
  title: string;
  icon: string;
  /** Which `/api/map` sections this column is built from. */
  sections: MapSectionName[];
  /** Non-null when a section this column needs failed — render THIS, not nodes. */
  error: string | null;
  nodes: MindMapNode[];
}

export interface MapTree {
  root: MindMapNode | null;
  branches: MapBranch[];
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** `Project - Content Forge` → `Content Forge`; the vault's prefix, not a name. */
function tidyProjectName(name: string): string {
  return name.replace(/^Project\s*-\s*/i, "").trim();
}

function checkedAt<T>(section: MapSection<T> | undefined): string {
  return section?.checked_at ?? new Date(0).toISOString();
}

function sourceOf<T>(section: MapSection<T> | undefined, fallback: string): string {
  return section?.source ?? fallback;
}

/** The `/opt/<name>` root a pm2 cwd sits under — the unit projects group by. */
function projectRoot(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return `/${parts.slice(0, 2).join("/")}`;
}

function processStatus(p: MapProcess): MindMapStatus {
  if (p.status === "online") return "up";
  if (p.status === "stopped" || p.status === "errored") return "down";
  return "neutral";
}

function processNode(p: MapProcess, source: string, at: string): MindMapNode {
  return {
    id: `proc-${slug(p.name)}`,
    label: p.name,
    type: "process",
    status: processStatus(p),
    statusLabel:
      p.status === "online"
        ? `online · up ${formatUptime(p.uptime_ms)}`
        : `pm2 reports "${p.status}"`,
    description: p.script
      ? `pm2 process running ${p.script}${p.cwd ? ` from ${p.cwd}` : ""}.`
      : "pm2 process.",
    source,
    checkedAt: at,
    facts: [
      { label: "PM2 status", value: p.status },
      { label: "PID", value: p.pid === null ? "—" : String(p.pid) },
      { label: "CPU", value: `${p.cpu_pct}%` },
      { label: "Memory", value: formatBytes(p.memory_bytes) },
      { label: "Restarts", value: String(p.restarts) },
      { label: "Uptime", value: formatUptime(p.uptime_ms) },
      { label: "Working dir", value: p.cwd ?? "—" },
      { label: "Script", value: p.script ?? "—" },
    ],
    path: p.cwd ?? undefined,
    navigateTo: "live",
    tags: ["pm2", p.status],
  };
}

/* ── Branch 1 — businesses, from the vault note ──────────────────────────── */

function businessBranch(payload: MapPayload): MapBranch {
  const section = payload.sections.businesses;
  const err = sectionError(section, "businesses");
  const branch: MapBranch = {
    key: "businesses",
    title: "Businesses & Projects",
    icon: "💼",
    sections: ["businesses"],
    error: err,
    nodes: [],
  };
  if (err || !section || !section.ok) return branch;

  const at = checkedAt(section);
  const source = sourceOf(section, "vault");
  const procSection = payload.sections.processes;
  const procs =
    procSection && procSection.ok ? procSection.data.processes : [];
  const procSource = sourceOf(procSection, "pm2 jlist");
  const procAt = checkedAt(procSection);

  branch.nodes = section.data.projects.map((p) => {
    const deployedPath = p.deployed.startsWith("/") ? p.deployed : null;
    const linked = deployedPath
      ? procs.filter((proc) => proc.cwd !== null && proc.cwd.startsWith(deployedPath))
      : [];
    const online = linked.filter((proc) => proc.status === "online").length;

    let status: MindMapStatus = "neutral";
    let statusLabel: string;
    if (linked.length > 0) {
      status = online === linked.length ? "up" : online > 0 ? "partial" : "down";
      statusLabel = `${online}/${linked.length} pm2 process${linked.length === 1 ? "" : "es"} online at ${deployedPath}`;
    } else if (p.path_exists === true) {
      status = "partial";
      statusLabel = `${deployedPath} exists on this box, no pm2 process runs from it`;
    } else if (p.path_exists === false) {
      status = "down";
      statusLabel = `${deployedPath} is named in the vault note but is not on this box`;
    } else {
      statusLabel = `not deployed to this box (vault says "${p.deployed}") — nothing to measure here`;
    }

    return {
      id: `biz-${slug(p.name)}`,
      label: tidyProjectName(p.name),
      type: "business" as const,
      status,
      statusLabel,
      description: p.type,
      source,
      checkedAt: at,
      facts: [
        { label: "Vault status", value: p.status },
        { label: "Kind", value: p.type },
        { label: "Deployed", value: p.deployed },
        {
          label: "Path on this box",
          value:
            p.path_exists === null
              ? "not a local path — not checked"
              : p.path_exists
                ? "exists"
                : "MISSING",
        },
        {
          label: "Linked pm2 processes",
          value: linked.length === 0 ? "none" : `${online}/${linked.length} online`,
        },
      ],
      path: deployedPath ?? undefined,
      navigateTo: "projects",
      tags: ["vault", p.status.toLowerCase()],
      children:
        linked.length > 0
          ? linked.map((proc) => processNode(proc, procSource, procAt))
          : undefined,
    };
  });

  return branch;
}

/* ── Branch 2 — what is actually running ─────────────────────────────────── */

function runtimeBranch(payload: MapPayload): MapBranch {
  const section = payload.sections.processes;
  const err = sectionError(section, "processes");
  const branch: MapBranch = {
    key: "runtime",
    title: "Running Fleet (PM2)",
    icon: "⚡",
    sections: ["processes"],
    error: err,
    nodes: [],
  };
  if (err || !section || !section.ok) return branch;

  const at = checkedAt(section);
  const source = sourceOf(section, "pm2 jlist");

  const groups = new Map<string, MapProcess[]>();
  for (const p of section.data.processes) {
    const root = projectRoot(p.cwd) ?? "(no working directory)";
    const bucket = groups.get(root);
    if (bucket) bucket.push(p);
    else groups.set(root, [p]);
  }

  branch.nodes = Array.from(groups.entries())
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([root, members]) => {
      const online = members.filter((p) => p.status === "online").length;
      const status: MindMapStatus =
        online === members.length ? "up" : online > 0 ? "partial" : "down";
      return {
        id: `grp-${slug(root)}`,
        label: root,
        type: "group" as const,
        status,
        statusLabel: `${online}/${members.length} online`,
        description: `pm2 processes whose working directory is under ${root}.`,
        source,
        checkedAt: at,
        facts: [
          { label: "Processes", value: String(members.length) },
          { label: "Online", value: String(online) },
          {
            label: "Total memory",
            value: formatBytes(
              members.reduce((sum, p) => sum + p.memory_bytes, 0),
            ),
          },
          {
            label: "Restarts (sum)",
            value: String(members.reduce((sum, p) => sum + p.restarts, 0)),
          },
        ],
        path: root.startsWith("/") ? root : undefined,
        navigateTo: "live",
        tags: ["pm2"],
        children: members.map((p) => processNode(p, source, at)),
      };
    });

  return branch;
}

/* ── Branch 3 — the metal, the front doors, the datastores ───────────────── */

function infrastructureBranch(payload: MapPayload): MapBranch {
  const storage = payload.sections.storage;
  const domains = payload.sections.domains;
  const units = payload.sections.units;
  const canvases = payload.sections.canvases;

  const branch: MapBranch = {
    key: "infrastructure",
    title: "Infrastructure & Ingress",
    icon: "🖥️",
    sections: ["storage", "domains", "units", "canvases"],
    // The column is only dark when EVERY section behind it failed; one dead
    // producer must not take the other three off the screen.
    error: null,
    nodes: [],
  };

  const nodes: MindMapNode[] = [];

  /* (a) the host itself */
  if (storage && storage.ok) {
    const at = checkedAt(storage);
    const source = sourceOf(storage, "df / /proc/meminfo / ss");
    const mem = storage.data.memory;
    nodes.push({
      id: "host-primary",
      label: `${payload.host.name} · ${payload.host.ip}`,
      type: "host",
      status: mem.used_pct > 90 ? "partial" : "up",
      statusLabel: `RAM ${mem.used_pct}% of ${formatBytes(mem.total_bytes)}`,
      description:
        "The host this AI OS runs on. Every figure on this map except the vault table is measured here.",
      source,
      checkedAt: at,
      facts: [
        { label: "Memory total", value: formatBytes(mem.total_bytes) },
        { label: "Memory used", value: `${formatBytes(mem.used_bytes)} (${mem.used_pct}%)` },
        { label: "Memory available", value: formatBytes(mem.available_bytes) },
        { label: "Open TCP listeners", value: String(storage.data.listeners.length) },
      ],
      tags: ["host", "vps1"],
      children: storage.data.disks.map((d) => ({
        id: `disk-${slug(d.mount)}`,
        label: `Disk ${d.mount}`,
        type: "disk" as const,
        status: d.used_pct > 90 ? "down" : d.used_pct > 80 ? "partial" : "up",
        statusLabel: `${d.used_pct}% used`,
        description: `Filesystem mounted at ${d.mount}.`,
        source,
        checkedAt: at,
        facts: [
          { label: "Total", value: formatBytes(d.total_bytes) },
          { label: "Used", value: `${formatBytes(d.used_bytes)} (${d.used_pct}%)` },
          { label: "Available", value: formatBytes(d.available_bytes) },
        ],
        path: d.mount,
        tags: ["disk"],
      })),
    });
  }

  /* (b) nginx ingress */
  if (domains && domains.ok) {
    const at = checkedAt(domains);
    const source = sourceOf(domains, "/etc/nginx/sites-enabled");
    const real = domains.data.domains.filter(
      (d) => d.domain !== "_" && d.domain !== "(no server_name)",
    );
    nodes.push({
      id: "ingress-nginx",
      label: `Nginx ingress · ${real.length} server names`,
      type: "group",
      status: domains.data.errors.length > 0 ? "partial" : "up",
      statusLabel:
        domains.data.errors.length > 0
          ? `${domains.data.errors.length} vhost file(s) could not be parsed`
          : `${domains.data.files} vhost files parsed cleanly`,
      description: `Front doors configured in ${domains.data.dir}. Catch-all servers are excluded from the count; they answer for no name.`,
      source,
      checkedAt: at,
      facts: [
        { label: "Vhost files", value: String(domains.data.files) },
        { label: "Server names", value: String(real.length) },
        { label: "With TLS", value: String(real.filter((d) => d.ssl).length) },
        {
          label: "Parse errors",
          value:
            domains.data.errors.length === 0
              ? "none"
              : domains.data.errors.map((e) => e.file).join(", "),
        },
      ],
      tags: ["nginx", "ingress"],
      children: real.map((d) => ({
        id: `dom-${slug(d.domain)}-${d.ports.join("-")}`,
        label: d.domain,
        type: "domain" as const,
        status: d.ssl
          ? d.ssl_days_left !== null && d.ssl_days_left < 14
            ? "partial"
            : "up"
          : "neutral",
        statusLabel: d.ssl
          ? d.ssl_days_left === null
            ? `TLS configured${d.ssl_error ? ` — certificate unreadable: ${d.ssl_error}` : ""}`
            : `TLS · ${d.ssl_days_left} days left`
          : "plain HTTP (usually the ACME/redirect server)",
        description: `Declared in ${d.file}.`,
        source,
        checkedAt: at,
        facts: [
          { label: "Ports", value: d.ports.length ? d.ports.join(", ") : "—" },
          { label: "Upstreams", value: d.upstreams.length ? d.upstreams.join(", ") : "—" },
          { label: "Roots", value: d.roots.length ? d.roots.join(", ") : "—" },
          {
            label: "Certificate",
            value:
              d.ssl_error !== null
                ? d.ssl_error
                : d.ssl_expires_at === null
                  ? "—"
                  : `expires ${d.ssl_expires_at.slice(0, 10)}`,
          },
          { label: "Config file", value: d.file },
        ],
        publicUrl: d.ssl ? `https://${d.domain}` : undefined,
        tags: ["nginx", d.ssl ? "tls" : "http"],
      })),
    });
  }

  /* (c) datastores — `listening` here is ss -ltnpH, not a belief */
  if (storage && storage.ok) {
    const at = checkedAt(storage);
    const source = sourceOf(storage, "ss -ltnpH");
    const ds = storage.data.datastores;
    const up = ds.filter((d) => d.listening).length;
    nodes.push({
      id: "datastores",
      label: `Datastores · ${up}/${ds.length} listening`,
      type: "group",
      status: up === ds.length ? "up" : up > 0 ? "partial" : "down",
      statusLabel: `${up} of ${ds.length} documented data ports answer`,
      description:
        "The data ports this box is documented to run. Whether something listens is measured; which database sits behind a port is not claimed.",
      source,
      checkedAt: at,
      facts: ds.map((d) => ({
        label: d.name,
        value: d.listening ? `listening (${d.process ?? "process unknown"})` : "NOT listening",
      })),
      tags: ["storage", "databases"],
      children: ds.map((d) => ({
        id: `ds-${d.port}`,
        label: d.name,
        type: "datastore" as const,
        status: d.listening ? ("up" as const) : ("down" as const),
        statusLabel: d.listening
          ? `listening on :${d.port} (${d.process ?? "process name unavailable"})`
          : `nothing is listening on :${d.port}`,
        description: `Documented data port :${d.port}.`,
        source,
        checkedAt: at,
        facts: [
          { label: "Port", value: `:${d.port}` },
          { label: "Listening", value: d.listening ? "yes" : "no" },
          { label: "Process", value: d.process ?? "—" },
        ],
        tags: ["datastore"],
      })),
    });
  }

  /* (d) systemd */
  if (units && units.ok) {
    const at = checkedAt(units);
    const source = sourceOf(units, "systemctl list-units");
    nodes.push({
      id: "systemd",
      label: `systemd · ${units.data.count} running services`,
      type: "group",
      status: "up",
      statusLabel: `${units.data.count} units in state running`,
      description: "System services outside pm2 — Docker, Postgres, nginx, sshd and the rest.",
      source,
      checkedAt: at,
      facts: [{ label: "Running units", value: String(units.data.count) }],
      tags: ["systemd"],
      children: units.data.units.map((u) => ({
        id: `unit-${slug(u.name)}`,
        label: u.name,
        type: "unit" as const,
        status: u.active === "active" ? ("up" as const) : ("neutral" as const),
        statusLabel: `${u.active} (${u.sub})`,
        description: u.description || "systemd service unit.",
        source,
        checkedAt: at,
        facts: [
          { label: "Active", value: u.active },
          { label: "Sub-state", value: u.sub },
        ],
        tags: ["systemd"],
      })),
    });
  }

  /* (e) planning canvases in the vault */
  if (canvases && canvases.ok && canvases.data.count > 0) {
    const at = checkedAt(canvases);
    const source = sourceOf(canvases, "vault *.excalidraw.md");
    nodes.push({
      id: "canvases",
      label: `Planning canvases · ${canvases.data.count}`,
      type: "group",
      status: "up",
      statusLabel: `${canvases.data.count} Excalidraw drawings in the vault`,
      description:
        "Hand-drawn planning canvases. Open one on the Planning Canvas tab of this surface.",
      source,
      checkedAt: at,
      facts: [{ label: "Drawings", value: String(canvases.data.count) }],
      tags: ["vault", "excalidraw"],
      children: canvases.data.canvases.slice(0, 25).map((c) => ({
        id: `canvas-${slug(c.path)}`,
        label: c.name,
        type: "canvas" as const,
        status: "neutral" as const,
        statusLabel: `last edited ${c.mtime.slice(0, 10)}`,
        description: c.folder ? `In ${c.folder}.` : "At the vault root.",
        source,
        checkedAt: at,
        facts: [
          { label: "Path", value: c.path },
          { label: "Size", value: formatBytes(c.size) },
          { label: "Modified", value: c.mtime },
        ],
        path: c.path,
        tags: ["excalidraw"],
      })),
    });
  }

  branch.nodes = nodes;
  if (nodes.length === 0) {
    branch.error =
      [
        sectionError(storage, "storage"),
        sectionError(domains, "domains"),
        sectionError(units, "units"),
      ]
        .filter((e): e is string => e !== null)
        .join(" · ") || "no infrastructure sections were returned";
  }
  return branch;
}

/* ── Root ────────────────────────────────────────────────────────────────── */

function rootNode(payload: MapPayload, branches: MapBranch[]): MindMapNode {
  const dead = payload.failed_sections;
  const counted = branches.reduce((sum, b) => sum + b.nodes.length, 0);
  return {
    id: "root",
    label: `${payload.host.name} — AI OS & Business Universe`,
    type: "root",
    status: dead.length === 0 ? "up" : "partial",
    statusLabel:
      dead.length === 0
        ? "all /api/map sections answered"
        : `sections unavailable: ${dead.join(", ")}`,
    description:
      "Everything below is read live from this host: the vault's project table, pm2, systemd, /etc/nginx, df, /proc/meminfo and ss. Nothing on this map is typed in by hand.",
    source: "GET /api/map",
    checkedAt: payload.generated_at,
    facts: [
      { label: "Host", value: `${payload.host.name} (${payload.host.ip})` },
      { label: "Generated at", value: payload.generated_at },
      { label: "Top-level nodes", value: String(counted) },
      {
        label: "Failed sections",
        value: dead.length === 0 ? "none" : dead.join(", "),
      },
    ],
    tags: ["ai-os", "live"],
  };
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export function buildMapTree(payload: MapPayload): MapTree {
  const branches = [
    businessBranch(payload),
    runtimeBranch(payload),
    infrastructureBranch(payload),
  ];
  return { root: rootNode(payload, branches), branches };
}

/** Depth-first walk — used by the search filter and by the tests. */
export function walkNodes(nodes: MindMapNode[]): MindMapNode[] {
  const out: MindMapNode[] = [];
  const visit = (n: MindMapNode): void => {
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** True when the node or any descendant matches the lower-cased query. */
export function nodeMatches(node: MindMapNode, q: string): boolean {
  if (!q) return true;
  const hay = [
    node.label,
    node.description,
    node.statusLabel,
    node.path ?? "",
    ...node.tags,
    ...node.facts.map((f) => `${f.label} ${f.value}`),
  ]
    .join(" ")
    .toLowerCase();
  if (hay.includes(q)) return true;
  return (node.children ?? []).some((c) => nodeMatches(c, q));
}
