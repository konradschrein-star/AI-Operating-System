/**
 * BUSINESSES INVENTORY — the single editable source of truth.
 *
 * Konrad's request 2026-08-04: group by BUSINESS, not by machine. A directory
 * property runs on VPS2 next to an Axtrelis property, but Konrad's head sorts
 * them by "what venture is this for", so that is what this file does. The
 * `box` field carries the host as a secondary attribute.
 *
 * Authoritative taxonomy: /opt/obsidian-vault/AI OS/Specs/Directory + Business
 * Plan Hub — Business Model.md §8 (Axtrelis = the business plan hub, NOT the
 * old German web-design agency) and §10 (Directory is Jersey → UK, £49/mo).
 *
 * Every url below was curl-verified at file creation (2026-08-04). If a
 * public URL flips to 502/404 downgrade `status` here — do not silently leave
 * a stale card.
 *
 * The surface at app/desktop/BusinessesSurface.tsx renders directly from this
 * list; stale card = stale file.
 */

export type Box = "vps1" | "vps2" | "external";
export type Status = "running" | "stopped" | "not_deployed" | "unknown" | "dormant";

export interface Property {
  /** Short display name. Shown as the row heading. */
  name: string;
  /** One-line description of what this thing is / what it's for. */
  what: string;
  /** Which physical host runs it. `external` = someone else's infra. */
  box: Box;
  /** Runtime state at file-write time. Not live-probed. */
  status: Status;
  /** Optional annotation on status — why stopped, what's missing, etc. */
  statusNote?: string;
  /** Public URL — must resolve. `null` if there is no public surface. */
  publicUrl: string | null;
  /** Internal / admin URL, if distinct from publicUrl. */
  adminUrl?: string;
  /** Local filesystem path of the codebase. */
  localPath?: string;
  /** Git remote. `null` = deliberately not a git repo (e.g. deploy dir). */
  githubUrl: string | null;
  /** Optional notes worth surfacing on the row (auth wall, gated, etc.). */
  note?: string;
}

export interface Business {
  key: string;
  title: string;
  subtitle: string;
  properties: Property[];
}

/**
 * Five businesses. Order = Konrad's own priority: revenue-first
 * (Directory, Axtrelis), then the pipeline that funds them (Creator), then
 * the fleet running everything (AI OS), then the rest.
 */
export const BUSINESSES: Business[] = [
  {
    key: "directory",
    title: "Directory",
    subtitle: "Jersey → UK business directory. Layer 1 listings at £49/mo, VA-driven outbound off the entity registry. Twenty CRM is the system of record; the Directory Engine feeds it.",
    properties: [
      {
        name: "Twenty CRM",
        what: "Self-hosted CRM. System of record for Directory prospects and deals.",
        box: "vps2",
        status: "running",
        publicUrl: "https://crm.167-233-145-218.sslip.io",
        adminUrl: "http://twenty-server:3000 (inside compose)",
        localPath: "/opt/twenty (VPS2)",
        githubUrl: null,
      },
      {
        name: "Directory Engine",
        what: "Scraping + enrichment engine feeding the directory sites.",
        box: "vps2",
        status: "unknown",
        statusNote: "Code + data present, no long-running container observed. Runs as batch jobs.",
        publicUrl: null,
        localPath: "/opt/directory-engine (VPS2)",
        githubUrl: "https://github.com/shanemtconnect/directory",
      },
      {
        name: "Jersey Directory",
        what: "Consumer-facing Jersey business directory (Next.js).",
        box: "vps2",
        status: "not_deployed",
        statusNote: "Code present, no container running. VPS1 sibling pm2 process is also STOPPED.",
        publicUrl: null,
        localPath: "/opt/jersey-directory (VPS2)",
        githubUrl: null,
      },
      {
        name: "Takeout JE",
        what: "Jersey takeaway static site (Astro build output).",
        box: "vps2",
        status: "not_deployed",
        statusNote: "Static dist present, no ingress routed to it.",
        publicUrl: null,
        localPath: "/opt/takeout-je (VPS2)",
        githubUrl: null,
      },
      {
        name: "Acquisition Console",
        what: "Internal console for lead ingest / outbound tracking.",
        box: "vps2",
        status: "not_deployed",
        statusNote: "Code present in /opt/acquisition-console, no container running.",
        publicUrl: null,
        localPath: "/opt/acquisition-console (VPS2)",
        githubUrl: null,
      },
    ],
  },

  {
    key: "axtrelis",
    title: "Business Plan Hub (Axtrelis)",
    subtitle: "EB-5 / E-2 investor-visa business-plan SaaS. Post-payment wizard → generation → dashboard. The old Axtrelis web-design agency is DORMANT and out of scope.",
    properties: [
      {
        name: "Business Plan Hub — Review",
        what: "Axtrelis SaaS product (Next.js). Post-payment wizard, generation, dashboard, admin.",
        box: "vps2",
        status: "running",
        publicUrl: "https://167-233-145-218.sslip.io",
        adminUrl: "http://web:3000 (inside compose)",
        localPath: "/opt/business-plan-tool (VPS2)",
        githubUrl: null,
        note: "Co-founder-review deployment. Direct-to-origin via Caddy, X-Robots-Tag noindex.",
      },
      {
        name: "app.axtrelis.com",
        what: "Intended production hostname for the SaaS app.",
        box: "external",
        status: "not_deployed",
        statusNote: "DNS resolves to Cloudflare (216.198.79.65 / 64.29.17.65). Cloudflare returns 404 — not wired to VPS2 yet.",
        publicUrl: "https://app.axtrelis.com",
        githubUrl: null,
      },
      {
        name: "axtrelis.com (marketing)",
        what: "Marketing / sales / blog. Owned by a partner agent, not this repo.",
        box: "external",
        status: "running",
        publicUrl: "https://axtrelis.com",
        githubUrl: null,
        note: "Redirects to www.axtrelis.com (200). Hosted off-VPS by partner.",
      },
      {
        name: "Business Plans Funnel v9",
        what: "Current sales funnel (orange CTA). Static build served by Caddy.",
        box: "vps2",
        status: "running",
        statusNote: "Runs inside container `bp-funnel-v9` on :8090. No public hostname mapped yet.",
        publicUrl: null,
        adminUrl: "http://167.233.145.218:8090",
        localPath: "/opt/business-plans-funnel/_funnel (VPS2)",
        githubUrl: null,
      },
    ],
  },

  {
    key: "creator",
    title: "YouTube / Creator Tools",
    subtitle: "Faceless-video pipeline (TheSkyLab) and the standalone side-tools that feed it.",
    properties: [
      {
        name: "ReelForge",
        what: "Faceless-video factory (TheSkyLab). Driven via `rf` CLI.",
        box: "vps1",
        status: "running",
        publicUrl: "https://reelforge.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:4101",
        localPath: "/opt/reelforge",
        githubUrl: null,
      },
      {
        name: "Hub Web",
        what: "Content-forge production hub: dashboards, Veo, gemini/claude sub-tools.",
        box: "vps1",
        status: "running",
        publicUrl: "https://hub.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3000",
        localPath: "/opt/content-forge/apps/hub-web",
        githubUrl: "https://github.com/konradschrein-star/content-forge",
      },
      {
        name: "VeoForge",
        what: "Veo generation service (FastAPI on :5300).",
        box: "vps1",
        status: "running",
        publicUrl: "https://veoforge.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:5300",
        localPath: "/opt/content-forge/apps/veoforge",
        githubUrl: "https://github.com/konradschrein-star/content-forge",
      },
      {
        name: "Veo Studio",
        what: "Veo review / production surface.",
        box: "vps1",
        status: "running",
        statusNote: "Behind HTTP basic auth (401 without creds).",
        publicUrl: "https://veo.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:8091",
        githubUrl: null,
      },
      {
        name: "Veo Friend",
        what: "Shared Veo instance for a collaborator.",
        box: "vps1",
        status: "running",
        statusNote: "Behind HTTP basic auth (401 without creds).",
        publicUrl: "https://friend.veo.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:8091",
        githubUrl: null,
      },
      {
        name: "Keyword Tool",
        what: "SEO keyword research + clustering (Python backend + Next frontend).",
        box: "vps1",
        status: "running",
        publicUrl: "https://keywordtool.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3071",
        localPath: "/opt/keyword-tool-v2",
        githubUrl: null,
      },
      {
        name: "Thumbnail Tool",
        what: "AI thumbnail generator.",
        box: "vps1",
        status: "stopped",
        statusNote: "pm2 shows `thumbnail-tool` + `thumbnail-worker` STOPPED. Nginx returns 502.",
        publicUrl: "https://thumbnails.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3072",
        localPath: "/opt/thumbnail-generator",
        githubUrl: "https://github.com/konradschrein-star/thumbnail-tool",
      },
    ],
  },

  {
    key: "ai-os",
    title: "AI OS",
    subtitle: "The console you are looking at, and the services it steers.",
    properties: [
      {
        name: "AI OS Console",
        what: "This app. Next.js UI for the fleet, canvas, memory, inbox.",
        box: "vps1",
        status: "running",
        publicUrl: "https://os.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:7701",
        localPath: "/opt/forge-ai-os/forge-control-web",
        githubUrl: "https://github.com/konradschrein-star/AI-Operating-System",
      },
      {
        name: "forge-api",
        what: "REST/SSE surface the console talks to (accounts, runs, memory).",
        box: "vps1",
        status: "running",
        publicUrl: "https://forge-api.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:8099",
        localPath: "/opt/content-forge/forge-api",
        githubUrl: "https://github.com/konradschrein-star/content-forge",
        note: "Returns 302 at / — health is at /healthz.",
      },
      {
        name: "Obsidian Sync",
        what: "CouchDB endpoint for LiveSync of the vault at /opt/obsidian-vault.",
        box: "vps1",
        status: "running",
        publicUrl: "https://obsidian-sync.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:5984",
        githubUrl: null,
      },
    ],
  },

  {
    key: "personal",
    title: "Personal / Other",
    subtitle: "Konrad's public face, dormant projects, and self-hosted utilities.",
    properties: [
      {
        name: "schreinercontentsystems.com",
        what: "Portfolio + services site (Astro). Root domain, both www and apex.",
        box: "vps1",
        status: "running",
        publicUrl: "https://schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:4321",
        localPath: "/opt/portfolio-wiki",
        githubUrl: null,
      },
      {
        name: "Schichtkommunikationstool",
        what: "Shift-communication tool.",
        box: "vps1",
        status: "stopped",
        statusNote: "Nothing listening on :3069. Nginx returns 502.",
        publicUrl: "https://schichtkommunikationstool.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3069",
        localPath: "/opt/schichtkommunikationstool",
        githubUrl: null,
      },
      {
        name: "Plane",
        what: "Self-hosted project management (Jira-like).",
        box: "vps1",
        status: "stopped",
        statusNote: "Nothing listening on :3010. Nginx returns 502.",
        publicUrl: "https://plane.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3010",
        githubUrl: null,
      },
    ],
  },
];
