/**
 * Businesses & Ventures Inventory — clean metadata and structural definition
 * for Konrad's 4 core ventures.
 *
 * Rebuilt to eliminate spec litigation and bloated server port accordions,
 * focusing on executive venture cards, key metrics, launchpad actions, and bottlenecks.
 */

export type VentureKey = "directory" | "creator" | "axtrelis" | "personal";
export type VentureStatus = "active" | "pre_launch" | "paused" | "dormant";
export type HostBox = "vps1" | "vps2" | "external";

export interface LaunchpadLink {
  label: string;
  url: string | null;
  kind?: "external" | "internal" | "repo";
  hint?: string;
}

export interface VentureProperty {
  name: string;
  what: string;
  box: HostBox;
  status: "running" | "stopped" | "not_deployed" | "unknown" | "dormant";
  publicUrl: string | null;
  adminUrl?: string;
  githubUrl?: string | null;
  statusNote?: string;
}

export interface Venture {
  key: VentureKey;
  title: string;
  tagline: string;
  category: string;
  status: VentureStatus;
  statusLabel: string;
  pricing: string;
  defaultNextAction: string;
  launchpad: LaunchpadLink[];
  properties: VentureProperty[];
  /**
   * STATED metrics only — business facts transcribed from the vault, never a
   * copy of something an API can answer. Zero to three of them; a venture whose
   * card fills a slot from a live probe simply omits that slot rather than
   * carrying a frozen number the probe would shadow. Round 2 carried
   * `"5 In Flight"` and `"1,053"` here — that hour's live readings, transcribed
   * into the source, still on screen when the probe was down.
   */
  metrics: StatedMetric[];
}

export interface StatedMetric {
  label: string;
  value: string;
}

/** Which live reading, if any, quantifies a bottleneck. The surface renders it
 *  as a badged chip beside the title; the title itself stays true with no
 *  number in it, so a dead probe costs the row its count and nothing else. */
export type BottleneckCountSource = "pipelineStalled" | "directoryCompanies";

export interface BottleneckItem {
  id: string;
  ventureKey: VentureKey;
  ventureTitle: string;
  severity: "critical" | "warning" | "info";
  /** No numbers. Round 2 wrote "5 Video Jobs Stalled" and "1,053 Sourced
   *  Prospects" here — that hour's readings, permanent. */
  title: string;
  status: string;
  impact: string;
  recommendedAction: string;
  countSource?: BottleneckCountSource;
  countLabel?: string;
  actionLabel?: string;
  actionUrl?: string;
}

export const VENTURES: Venture[] = [
  {
    key: "directory",
    title: "The Jersey / UK Directory",
    tagline: "B2B Local Marketplace & Services Introducer (£49/mo tier)",
    category: "B2B Marketplace",
    status: "active",
    statusLabel: "Active Sourcing",
    pricing: "£49/mo (Layer 1 Listings)",
    /* Carries NO prospect count: the card reads that live from
     * ai_os.entities and prefixes this sentence with it. A number here would
     * be the one that survives a failed probe. */
    defaultNextAction:
      "First 100 cold outreach calls not yet initiated.",
    metrics: [
      /* Twenty CRM is not wired into this OS, so "how many were contacted" has
       * no live source. It is 0 because Konrad states outbound has not started
       * — a fact, badged STATED, not a zeroed-out reading. */
      { label: "Contacted", value: "0" },
    ],
    launchpad: [
      {
        label: "Open Site",
        url: "https://crm.167-233-145-218.sslip.io",
        kind: "external",
        hint: "Jersey Directory frontend",
      },
      {
        label: "Twenty CRM",
        url: "https://crm.167-233-145-218.sslip.io",
        kind: "external",
        hint: "Twenty CRM instance on VPS2",
      },
      {
        label: "Repo",
        url: "https://github.com/shanemtconnect/directory",
        kind: "repo",
        hint: "Directory engine repository",
      },
      {
        label: "Projects",
        url: "#projects",
        kind: "internal",
        hint: "View directory tasks in OS Projects",
      },
    ],
    properties: [
      {
        name: "Twenty CRM",
        what: "Self-hosted CRM on VPS2 for prospect pipeline and outreach.",
        box: "vps2",
        status: "running",
        publicUrl: "https://crm.167-233-145-218.sslip.io",
        adminUrl: "http://twenty-server:3000",
        githubUrl: null,
      },
      {
        name: "Directory Engine",
        what: "Enrichment and ingestion worker feeding Jersey companies to DB.",
        box: "vps2",
        status: "running",
        publicUrl: null,
        githubUrl: "https://github.com/shanemtconnect/directory",
      },
      {
        name: "Jersey Directory Web",
        what: "Consumer-facing directory portal (Next.js).",
        box: "vps2",
        status: "not_deployed",
        publicUrl: null,
        githubUrl: null,
      },
    ],
  },
  {
    key: "creator",
    title: "TheSkyLab / YouTube Studio",
    tagline: "Faceless Video Publishing & Content Factory (TheSkyLab, KarmaBiker, AI Senior)",
    category: "Media & Content Automation",
    status: "active",
    statusLabel: "Active Production",
    pricing: "AdSense / Sponsorships",
    /* Same rule as directory: job counts and stall counts come from
     * /api/pipeline, so they are not written down here. What is left is the
     * standing instruction that holds whether or not the probe answers. */
    defaultNextAction:
      "QC is the human-review gate for this pipeline — clear it in Hub Web.",
    metrics: [
      /* TheSkyLab, KarmaBiker, AI Senior — the channel fleet itself, not a
       * count of anything the pipeline reports. */
      { label: "Active Channels", value: "3 Channels" },
    ],
    launchpad: [
      {
        label: "Hub Web",
        url: "https://hub.schreinercontentsystems.com",
        kind: "external",
        hint: "Content Forge production hub",
      },
      {
        label: "ReelForge",
        url: "https://reelforge.schreinercontentsystems.com",
        kind: "external",
        hint: "ReelForge video factory",
      },
      {
        label: "Pipeline",
        url: "#pipeline",
        kind: "internal",
        hint: "Live video pipeline queue",
      },
      {
        label: "Repo",
        url: "https://github.com/konradschrein-star/content-forge",
        kind: "repo",
        hint: "Content Forge monorepo",
      },
    ],
    properties: [
      {
        name: "ReelForge",
        what: "Faceless-video factory engine driven via rf CLI.",
        box: "vps1",
        status: "running",
        publicUrl: "https://reelforge.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:4101",
        githubUrl: null,
      },
      {
        name: "Hub Web",
        what: "Content Forge production dashboard, Veo, and review UI.",
        box: "vps1",
        status: "running",
        publicUrl: "https://hub.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3000",
        githubUrl: "https://github.com/konradschrein-star/content-forge",
      },
      {
        name: "Veo Studio",
        what: "Veo generation and review surface.",
        box: "vps1",
        status: "running",
        publicUrl: "https://veo.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:8091",
        githubUrl: null,
      },
      {
        name: "Keyword Tool",
        what: "SEO keyword clustering and research engine.",
        box: "vps1",
        status: "running",
        publicUrl: "https://keywordtool.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3071",
        githubUrl: null,
      },
    ],
  },
  {
    key: "axtrelis",
    title: "Axtrelis / Business Plan Hub",
    tagline: "Investor Visa Business Plan SaaS ($197 / $497 / $2,497 tiers)",
    category: "Visa SaaS",
    status: "pre_launch",
    statusLabel: "Pre-Launch",
    pricing: "$197 / $497 / $2,497",
    defaultNextAction:
      "Cloudflare DNS for app.axtrelis.com returns 404 — route to VPS2 container.",
    metrics: [
      { label: "Seed Plans", value: "5 Generated" },
      { label: "Live Customers", value: "0 Customers" },
      { label: "Pricing Tiers", value: "$197 / $497 / $2,497" },
    ],
    launchpad: [
      {
        label: "Review App",
        url: "https://167-233-145-218.sslip.io",
        kind: "external",
        hint: "Co-founder review instance on VPS2",
      },
      {
        label: "Funnel v9",
        url: "http://167.233.145.218:8090",
        kind: "external",
        hint: "Sales funnel container on VPS2",
      },
      {
        label: "Repo",
        url: "https://github.com/konradschrein-star/axtrelis",
        kind: "repo",
        hint: "Axtrelis product repo",
      },
    ],
    properties: [
      {
        name: "Business Plan Hub — Review",
        what: "Axtrelis SaaS product (Next.js). Post-payment wizard, generation, dashboard.",
        box: "vps2",
        status: "running",
        publicUrl: "https://167-233-145-218.sslip.io",
        adminUrl: "http://web:3000",
        githubUrl: null,
      },
      {
        name: "app.axtrelis.com",
        what: "Production hostname for the SaaS app (Cloudflare DNS 404).",
        box: "external",
        status: "not_deployed",
        statusNote: "Cloudflare DNS returns 404 — needs routing to VPS2 container.",
        publicUrl: "https://app.axtrelis.com",
        githubUrl: null,
      },
      {
        name: "Business Plans Funnel v9",
        what: "Sales funnel served by Caddy on VPS2 container :8090.",
        box: "vps2",
        status: "running",
        publicUrl: null,
        adminUrl: "http://167.233.145.218:8090",
        githubUrl: null,
      },
    ],
  },
  {
    key: "personal",
    title: "Schreiner Content Systems",
    tagline: "Personal Brand, Consulting & Custom MVPs (ShiftSync)",
    category: "Consulting & Brand",
    status: "paused",
    statusLabel: "Paused / Dormant",
    pricing: "Consulting Retainers",
    defaultNextAction: "Paused — focus on YouTube and Directory.",
    metrics: [
      { label: "Portfolio Web", value: "200 OK" },
      { label: "ShiftSync Tool", value: "502 Stopped" },
      { label: "Active Focus", value: "Dormant" },
    ],
    launchpad: [
      {
        label: "Portfolio Site",
        url: "https://schreinercontentsystems.com",
        kind: "external",
        hint: "Astro portfolio and consulting services",
      },
      {
        label: "Docs",
        url: "https://obsidian-sync.schreinercontentsystems.com",
        kind: "external",
        hint: "Obsidian sync & knowledge vault",
      },
    ],
    properties: [
      {
        name: "schreinercontentsystems.com",
        what: "Portfolio + services site (Astro). Root domain, both www and apex.",
        box: "vps1",
        status: "running",
        publicUrl: "https://schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:4321",
        githubUrl: null,
      },
      {
        name: "Schichtkommunikationstool",
        what: "Shift-communication tool (ShiftSync).",
        box: "vps1",
        status: "stopped",
        statusNote: "Stopped (502). Paused to conserve operational focus.",
        publicUrl: "https://schichtkommunikationstool.schreinercontentsystems.com",
        adminUrl: "http://127.0.0.1:3069",
        githubUrl: null,
      },
    ],
  },
];

export const CROSS_PORTFOLIO_BOTTLENECKS: BottleneckItem[] = [
  {
    id: "yt-qc-stall",
    ventureKey: "creator",
    ventureTitle: "TheSkyLab / YouTube Studio",
    severity: "critical",
    title: "Video Jobs Stalled >48h in QC Review",
    status: "Finished video renders awaiting human QC sign-off in Hub Web.",
    impact: "Publishing pipeline is completely stalled; render & publish stages cannot advance.",
    recommendedAction: "Open Hub Web, review QC queue, and approve or reject stalled jobs.",
    countSource: "pipelineStalled",
    countLabel: "stalled now",
    actionLabel: "Open Hub Web ↗",
    actionUrl: "https://hub.schreinercontentsystems.com",
  },
  {
    id: "dir-outbound-gap",
    ventureKey: "directory",
    ventureTitle: "The Jersey / UK Directory",
    severity: "warning",
    title: "Sourced Prospects with 0 Outreach Initiated",
    status: "Enriched company profiles are loaded in DB, but cold outbound has not started.",
    impact: "£49/mo subscription revenue cannot begin until the first 100 discovery calls take place.",
    recommendedAction: "Initiate initial 100-call test outreach campaign via Twenty CRM.",
    countSource: "directoryCompanies",
    countLabel: "sourced",
    actionLabel: "Open Twenty CRM ↗",
    actionUrl: "https://crm.167-233-145-218.sslip.io",
  },
  {
    id: "axtrelis-dns-404",
    ventureKey: "axtrelis",
    ventureTitle: "Axtrelis / Business Plan Hub",
    severity: "warning",
    title: "app.axtrelis.com Cloudflare DNS Returns 404",
    status: "Public DNS resolves to Cloudflare proxy but backend VPS2 container is unrouted.",
    impact: "Prospective customers and co-founder review hitting production hostname see 404.",
    recommendedAction: "Configure Cloudflare origin rule to route app.axtrelis.com to VPS2 container ingress.",
    actionLabel: "Review App ↗",
    actionUrl: "https://167-233-145-218.sslip.io",
  },
  {
    id: "personal-paused",
    ventureKey: "personal",
    ventureTitle: "Schreiner Content Systems",
    severity: "info",
    title: "Consulting & Secondary Tools Paused for Bandwidth",
    status: "ShiftSync tool offline (502). Deliberately kept dormant.",
    impact: "Zero engineering distraction; 100% execution capacity dedicated to YouTube & Directory.",
    recommendedAction: "Maintain paused state until YouTube publishing cadence and Directory revenue are locked.",
    actionLabel: "View Portfolio ↗",
    actionUrl: "https://schreinercontentsystems.com",
  },
];
