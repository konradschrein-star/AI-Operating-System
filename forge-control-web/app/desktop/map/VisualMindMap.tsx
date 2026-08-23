"use client";

/**
 * VisualMindMap.tsx — Hierarchical Interactive Mind Map & Architecture Graph.
 *
 * Visualizes the 3 primary branches of Konrad's empire:
 * 1. Commercial Ventures (TheSkyLab / YouTube, Jersey Directory, Axtrelis Hub, Client SaaS)
 * 2. AI OS Core Fleet (Hermes Supervisor, Live Agents, Task Graphs, Obsidian Vault, LLM Gateways)
 * 3. Physical Infrastructure (VPS1 Hetzner, VPS2 Twenty CRM/Scrapers, Windows 11 VM)
 *
 * Supports node inspection, search/filtering, collapsible branches, and drill-in actions.
 */

import { useState, useMemo } from "react";
import { tokens } from "../../tokens";
import { MapInspectorDrawer, type MindMapNode } from "./MapInspectorDrawer";

/* ── Mind Map Node Definition ── */
const ROOT_NODE: MindMapNode = {
  id: "root",
  label: "Konrad AI OS & Enterprise Hub",
  type: "root",
  status: "online",
  description: "Central command architecture coordinating commercial business units, autonomous agent fleets, and multi-server physical infrastructure.",
  host: "VPS1 (65.108.6.149) & VPS2 (167.233.145.218)",
  publicUrl: "https://os.schreinercontentsystems.com",
  adminUrl: "http://127.0.0.1:7701",
  repoPath: "/opt/forge-ai-os",
  githubUrl: "https://github.com/konradschrein-star/AI-Operating-System",
  tags: ["ai-os", "hub", "executive", "core"],
};

/* ── Branch 1: Commercial Ventures ── */
const COMMERCIAL_VENTURES: MindMapNode[] = [
  {
    id: "venture-skylab",
    label: "TheSkyLab / YouTube Studio",
    type: "venture",
    status: "running",
    category: "Commercial Ventures",
    description: "Faceless YouTube video automation pipeline generating high-production media assets, Remotion motion graphics, and audio synthesis.",
    host: "VPS1 (65.108.6.149)",
    port: 3000,
    domain: "hub.schreinercontentsystems.com",
    publicUrl: "https://hub.schreinercontentsystems.com",
    adminUrl: "http://127.0.0.1:3000",
    repoPath: "/opt/content-forge",
    githubUrl: "https://github.com/konradschrein-star/content-forge",
    upstreamTarget: "127.0.0.1:3000",
    tags: ["youtube", "media", "content-forge", "reelforge"],
    children: [
      {
        id: "tool-reelforge",
        label: "ReelForge Video Factory",
        type: "tool",
        status: "running",
        category: "Content Production",
        description: "Autonomous video production factory driven by the rf CLI and topic promotion backlog.",
        host: "VPS1",
        port: 4101,
        domain: "reelforge.schreinercontentsystems.com",
        publicUrl: "https://reelforge.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:4101",
        repoPath: "/opt/reelforge",
        upstreamTarget: "127.0.0.1:4101",
        tags: ["rf", "rendering", "remotion"],
      },
      {
        id: "tool-veoforge",
        label: "VeoForge & Veo Studio",
        type: "tool",
        status: "running",
        category: "AI Video Generation",
        description: "FastAPI Veo video generation microservice with review and production surfaces.",
        host: "VPS1",
        port: 5300,
        domain: "veoforge.schreinercontentsystems.com",
        publicUrl: "https://veoforge.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:5300",
        repoPath: "/opt/content-forge/apps/veoforge",
        tags: ["veo", "video-ai"],
      },
    ],
  },
  {
    id: "venture-directory",
    label: "Jersey / UK Directory Engine",
    type: "venture",
    status: "running",
    category: "Commercial Ventures",
    description: "Jersey → UK business directory. Layer 1 listings at £49/mo, VA-driven outbound off entity registry.",
    host: "VPS2 (167.233.145.218)",
    port: 3000,
    domain: "crm.167-233-145-218.sslip.io",
    publicUrl: "https://crm.167-233-145-218.sslip.io",
    adminUrl: "http://twenty-server:3000 (compose)",
    repoPath: "/opt/twenty (VPS2)",
    githubUrl: "https://github.com/shanemtconnect/directory",
    tags: ["directory", "twenty-crm", "jersey", "uk"],
    children: [
      {
        id: "tool-twenty",
        label: "Twenty CRM",
        type: "service",
        status: "running",
        category: "CRM & Records",
        description: "Self-hosted CRM and system of record for Directory prospects and deals on VPS2.",
        host: "VPS2",
        publicUrl: "https://crm.167-233-145-218.sslip.io",
        repoPath: "/opt/twenty",
        tags: ["crm", "deals"],
      },
      {
        id: "tool-scraper",
        label: "Directory Engine Scraper",
        type: "tool",
        status: "active",
        category: "Data Ingest",
        description: "Scraping and enrichment engine feeding the directory sites.",
        host: "VPS2",
        repoPath: "/opt/directory-engine",
        tags: ["scraper", "enrichment"],
      },
    ],
  },
  {
    id: "venture-axtrelis",
    label: "Axtrelis Business Plan Hub",
    type: "venture",
    status: "running",
    category: "Commercial Ventures",
    description: "EB-5 / E-2 investor-visa business plan SaaS. Post-payment wizard, automated generation, dashboard.",
    host: "VPS2 (167.233.145.218)",
    port: 3000,
    domain: "167-233-145-218.sslip.io",
    publicUrl: "https://167-233-145-218.sslip.io",
    adminUrl: "http://web:3000 (compose)",
    repoPath: "/opt/business-plan-tool (VPS2)",
    tags: ["axtrelis", "saas", "visas", "business-plans"],
    children: [
      {
        id: "tool-bp-funnel",
        label: "Business Plans Funnel v9",
        type: "tool",
        status: "running",
        category: "Sales Funnel",
        description: "Current high-conversion sales funnel served by Caddy on VPS2.",
        host: "VPS2",
        port: 8090,
        adminUrl: "http://167.233.145.218:8090",
        repoPath: "/opt/business-plans-funnel/_funnel",
        tags: ["funnel", "caddy"],
      },
      {
        id: "tool-axtrelis-marketing",
        label: "axtrelis.com Marketing",
        type: "tool",
        status: "running",
        category: "Marketing",
        description: "Public marketing site managed with partner.",
        host: "external",
        publicUrl: "https://axtrelis.com",
        tags: ["marketing", "external"],
      },
    ],
  },
  {
    id: "venture-saas-tools",
    label: "Client SaaS & Utility Suite",
    type: "venture",
    status: "active",
    category: "Commercial Ventures",
    description: "Suite of standalone client tools and utility microservices running across VPS1.",
    host: "VPS1 (65.108.6.149)",
    tags: ["saas", "client-tools"],
    children: [
      {
        id: "tool-shiftsync",
        label: "ShiftSync",
        type: "tool",
        status: "stopped",
        statusNote: "PM2 process stopped, awaiting maintenance.",
        category: "Client Tool",
        description: "Shift communication and scheduling tool.",
        host: "VPS1",
        port: 3069,
        domain: "schichtkommunikationstool.schreinercontentsystems.com",
        publicUrl: "https://schichtkommunikationstool.schreinercontentsystems.com",
        repoPath: "/opt/schichtkommunikationstool",
        tags: ["shifts", "tool"],
      },
      {
        id: "tool-keywordtool",
        label: "Keyword Tool V2",
        type: "tool",
        status: "running",
        category: "SEO Tool",
        description: "SEO keyword clustering and search volume engine.",
        host: "VPS1",
        port: 3071,
        domain: "keywordtool.schreinercontentsystems.com",
        publicUrl: "https://keywordtool.schreinercontentsystems.com",
        repoPath: "/opt/keyword-tool-v2",
        tags: ["seo", "keywords"],
      },
      {
        id: "tool-thumbnails",
        label: "AI Thumbnail Generator",
        type: "tool",
        status: "stopped",
        statusNote: "PM2 process stopped.",
        category: "Media Utility",
        description: "AI automated video thumbnail creator.",
        host: "VPS1",
        port: 3072,
        domain: "thumbnails.schreinercontentsystems.com",
        publicUrl: "https://thumbnails.schreinercontentsystems.com",
        repoPath: "/opt/thumbnail-generator",
        tags: ["thumbnails", "images"],
      },
    ],
  },
];

/* ── Branch 2: AI OS Core Fleet ── */
const FLEET_VENTURES: MindMapNode[] = [
  {
    id: "fleet-supervisor",
    label: "Hermes Supervisor & Control DB",
    type: "fleet",
    status: "running",
    category: "AI OS Core Fleet",
    description: "Primary daemon supervisor managing execution rounds, agent processes, and SQLite control state.",
    host: "VPS1",
    repoPath: "/opt/forge-ai-os",
    adminUrl: "sqlite:///opt/forge-ai-os/control.db",
    tags: ["hermes", "supervisor", "sqlite", "control"],
  },
  {
    id: "fleet-agents",
    label: "Autonomous Agent Fleet (5 Active)",
    type: "fleet",
    status: "online",
    category: "AI OS Core Fleet",
    description: "Role-specialized coding and research agents executing background tasks.",
    host: "VPS1",
    tags: ["agents", "claude", "gemini", "fleet"],
    children: [
      {
        id: "agent-architect",
        label: "cc-architect (Opus)",
        type: "agent",
        status: "online",
        category: "System Architect",
        description: "High-level architecture design and task decomposition.",
        tags: ["opus", "planning"],
      },
      {
        id: "agent-builder",
        label: "cc-writer-01 (Sonnet)",
        type: "agent",
        status: "online",
        category: "Code Implementation",
        description: "Primary TypeScript and Python implementation builder.",
        tags: ["sonnet", "builder"],
      },
      {
        id: "agent-docs",
        label: "cc-docs (Sonnet)",
        type: "agent",
        status: "online",
        category: "Documentation",
        description: "Maintains specs, memory notes, and architectural audits.",
        tags: ["docs", "memory"],
      },
      {
        id: "agent-sysop",
        label: "sysop-01 (Sonnet)",
        type: "agent",
        status: "online",
        category: "DevOps & Metal",
        description: "Server configuration, Nginx vhosts, systemd units, PM2.",
        tags: ["sysop", "devops"],
      },
      {
        id: "agent-tester",
        label: "test-02 (Haiku)",
        type: "agent",
        status: "online",
        category: "Testing & Verification",
        description: "Adversarial verification and test suite execution.",
        tags: ["test", "verification"],
      },
    ],
  },
  {
    id: "fleet-knowledge",
    label: "Obsidian Vault & Memory Graph",
    type: "fleet",
    status: "active",
    category: "AI OS Core Fleet",
    description: "Living knowledge repository containing 284+ markdown notes, architectural specs, and Excalidraw canvases.",
    host: "VPS1",
    port: 5984,
    domain: "obsidian-sync.schreinercontentsystems.com",
    publicUrl: "https://obsidian-sync.schreinercontentsystems.com",
    repoPath: "/opt/obsidian-vault",
    tags: ["vault", "couchdb", "livesync", "excalidraw"],
  },
  {
    id: "fleet-gateways",
    label: "LLM Provider Gateways",
    type: "fleet",
    status: "online",
    category: "AI OS Core Fleet",
    description: "Multi-provider model routing layer connecting Claude OAuth, Gemini 5-Slot Pool, and Local Ollama.",
    host: "VPS1",
    tags: ["llm", "claude", "gemini", "ollama"],
    children: [
      {
        id: "gw-claude",
        label: "Anthropic Claude (OAuth)",
        type: "service",
        status: "online",
        category: "LLM Gateway",
        description: "Direct OAuth connection for Opus and Sonnet models.",
        tags: ["claude", "anthropic"],
      },
      {
        id: "gw-gemini",
        label: "Gemini 5-Slot Pool",
        type: "service",
        status: "online",
        category: "LLM Gateway",
        description: "High-throughput pool for Gemini 3.7 Flash and Pro models via agy CLI.",
        tags: ["gemini", "google"],
      },
      {
        id: "gw-ollama",
        label: "Ollama Local (:11434)",
        type: "database",
        status: "online",
        category: "Local LLM",
        description: "Local inference engine running open-weights models.",
        port: 11434,
        tags: ["ollama", "local"],
      },
    ],
  },
];

/* ── Branch 3: Physical Infrastructure ── */
const INFRA_VENTURES: MindMapNode[] = [
  {
    id: "infra-vps1",
    label: "VPS1 (65.108.6.149) · Hetzner Dedicated",
    type: "infra",
    status: "running",
    category: "Physical Infrastructure",
    description: "Primary 64 GB Hetzner bare-metal server hosting AI OS, PM2 daemon processes, Nginx reverse proxy, and core Postgres.",
    host: "VPS1 (65.108.6.149)",
    metrics: {
      cpu: 55.8,
      ram: "42.1 GB / 64 GB (62.5%)",
      uptime: "31d 6h",
    },
    tags: ["vps1", "hetzner", "primary"],
    children: [
      {
        id: "infra-pm2",
        label: "PM2 Process Manager (22/28 Online)",
        type: "service",
        status: "online",
        category: "Process Manager",
        description: "Supervises 28 microservices and Node/Python daemons.",
        tags: ["pm2", "daemons"],
      },
      {
        id: "infra-nginx",
        label: "Nginx Ingress (19 Vhosts with SSL)",
        type: "service",
        status: "online",
        category: "Reverse Proxy",
        description: "Terminates HTTPS for all public domains with automated Certbot certificates.",
        tags: ["nginx", "ssl", "ingress"],
      },
      {
        id: "infra-pg-primary",
        label: "PostgreSQL Primary (:5432 / :5434)",
        type: "database",
        status: "online",
        category: "Relational Database",
        description: "Port 5432 for Content Forge; Port 5434 for AI OS vector embeddings.",
        port: 5432,
        tags: ["postgres", "pgvector"],
      },
    ],
  },
  {
    id: "infra-vps2",
    label: "VPS2 (167.233.145.218) · Migration Host",
    type: "infra",
    status: "running",
    category: "Physical Infrastructure",
    description: "Secondary 16 GB Hetzner host running Twenty CRM Docker Compose, Directory Engine, and Axtrelis.",
    host: "VPS2 (167.233.145.218)",
    publicUrl: "https://167-233-145-218.sslip.io",
    tags: ["vps2", "twenty", "axtrelis", "scrapers"],
  },
  {
    id: "infra-vm",
    label: "Windows 11 VM (QEMU / noVNC)",
    type: "infra",
    status: "active",
    category: "Virtualization",
    description: "Isolated Windows 11 VM for automated desktop workflows and manual browser tasks via noVNC.",
    host: "VPS1 (Port 6080 / 6082)",
    port: 6080,
    tags: ["windows", "qemu", "vnc"],
  },
];

interface VisualMindMapProps {
  onNavigateSurface?: (surface: string) => void;
  onOpenCanvas?: () => void;
}

export function VisualMindMap({ onNavigateSurface, onOpenCanvas }: VisualMindMapProps) {
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set(["venture-skylab", "venture-directory", "venture-axtrelis", "fleet-agents", "fleet-gateways", "infra-vps1"]),
  );

  const toggleExpand = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const q = searchQuery.toLowerCase().trim();

  // Helper to render a node card
  const renderNodeCard = (node: MindMapNode, isRoot = false) => {
    const isSelected = selectedNode?.id === node.id;
    const isOnline =
      node.status === "online" ||
      node.status === "running" ||
      node.status === "active";
    const isStopped =
      node.status === "stopped" || node.status === "not_deployed";
    const isWarn = node.status === "warning" || node.status === "error";

    const dotClass = isOnline
      ? "green"
      : isStopped
      ? "gray"
      : isWarn
      ? "yellow"
      : "blue";

    const matchesSearch =
      q &&
      (node.label.toLowerCase().includes(q) ||
        node.description.toLowerCase().includes(q) ||
        node.tags?.some((t) => t.toLowerCase().includes(q)));

    return (
      <div
        key={node.id}
        className={`mindmap-node ${isRoot ? "root" : ""} ${isSelected ? "selected" : ""}`}
        style={matchesSearch ? { borderColor: tokens.accent, outline: `2px solid ${tokens.accent}` } : undefined}
        onClick={() => setSelectedNode(node)}
      >
        <div className="mindmap-node-header">
          <div className="mindmap-node-title">
            <span className={`map-dot ${dotClass}`} />
            {node.label}
          </div>
          <span className="mindmap-node-badge">{node.type}</span>
        </div>

        <div className="mindmap-node-desc">{node.description}</div>

        <div className="mindmap-node-footer">
          {node.domain && <span>🌐 {node.domain}</span>}
          {node.port && <span>🔌 :{node.port}</span>}
          {node.host && <span>🖥 {node.host.split(" ")[0]}</span>}
        </div>

        {/* Children Sub-Tree */}
        {node.children && node.children.length > 0 && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${tokens.borderSoft}`, paddingTop: 6 }}>
            <button
              type="button"
              className="mindmap-btn"
              style={{ fontSize: 10, padding: "2px 6px" }}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
            >
              {expandedNodes.has(node.id)
                ? `Hide ${node.children.length} sub-items ▲`
                : `Show ${node.children.length} sub-items ▼`}
            </button>

            {expandedNodes.has(node.id) && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginTop: 8,
                  paddingLeft: 12,
                  borderLeft: `2px solid ${tokens.accent}`,
                }}
              >
                {node.children.map((child) => renderNodeCard(child))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mindmap-container">
      {/* Mind Map Toolbar */}
      <div className="mindmap-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="mindmap-search">
            <span style={{ color: tokens.textMuted }}>🔍</span>
            <input
              type="text"
              placeholder="Search ventures, agents, nodes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{ background: "none", border: "none", color: tokens.textMuted, cursor: "pointer" }}
              >
                ✕
              </button>
            )}
          </div>
          <span style={{ fontSize: 11, color: tokens.textMuted }}>
            Click any node to inspect telemetry & quick actions
          </span>
        </div>

        <div className="mindmap-controls">
          {onOpenCanvas && (
            <button
              type="button"
              className="mindmap-btn"
              onClick={onOpenCanvas}
              title="Open Excalidraw Planning Canvas"
            >
              <span>✏️</span> Open in Excalidraw
            </button>
          )}
          <button
            type="button"
            className="mindmap-btn"
            onClick={() => {
              setExpandedNodes(
                expandedNodes.size > 0
                  ? new Set()
                  : new Set(["venture-skylab", "venture-directory", "venture-axtrelis", "fleet-agents", "fleet-gateways", "infra-vps1"]),
              );
            }}
          >
            {expandedNodes.size > 0 ? "Collapse All" : "Expand All"}
          </button>
        </div>
      </div>

      {/* Mind Map Interactive Canvas */}
      <div className="mindmap-canvas">
        <div className="mindmap-tree">
          {/* Central Root Node */}
          {renderNodeCard(ROOT_NODE, true)}

          {/* 3 Main Branches */}
          <div className="mindmap-branches">
            {/* Branch 1: Commercial Ventures */}
            <div className="mindmap-branch-column">
              <div className="mindmap-branch-header">
                <span>💼</span> Commercial Ventures
              </div>
              <div className="mindmap-children-list">
                {COMMERCIAL_VENTURES.map((v) => renderNodeCard(v))}
              </div>
            </div>

            {/* Branch 2: AI OS Core Fleet */}
            <div className="mindmap-branch-column">
              <div className="mindmap-branch-header">
                <span>🤖</span> AI OS Core & Agent Fleet
              </div>
              <div className="mindmap-children-list">
                {FLEET_VENTURES.map((v) => renderNodeCard(v))}
              </div>
            </div>

            {/* Branch 3: Physical Infrastructure */}
            <div className="mindmap-branch-column">
              <div className="mindmap-branch-header">
                <span>🖥️</span> Physical Infrastructure
              </div>
              <div className="mindmap-children-list">
                {INFRA_VENTURES.map((v) => renderNodeCard(v))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Slide-Over Inspector Drawer */}
      <MapInspectorDrawer
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onNavigateSurface={onNavigateSurface}
      />
    </div>
  );
}
