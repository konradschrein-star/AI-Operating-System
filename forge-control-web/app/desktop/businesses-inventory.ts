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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PHASE 5 / R59–R63 — THE FUNNEL SPINE, AND WHY EVERY NUMBER CARRIES A DATE
 * ───────────────────────────────────────────────────────────────────────────
 * The `BUSINESSES` list above is an inventory of SERVERS wearing a business
 * label. Not one figure in it is a business number. The block below adds the
 * business numbers, and every one of them is either LIVE-PROBED at render
 * time (YouTube, via `fetchPipelineBusiness`) or SPEC-SOURCED and stamped
 * with the date it was measured (Directory, Axtrelis).
 *
 * There is no third category. A figure with neither a live probe nor an
 * as-of date is the defect R61 exists to kill: a dot that was green in
 * August still reading green in December.
 *
 * Directory is NOT live-probeable from VPS1 and this was measured, not
 * assumed — see phase5/business-spine-ruling.md §4 for the command output.
 * Short version: `/opt/acquisition-console/data/console.db` does not exist on
 * this box, `/root/.ssh/vps2_mgmt` was revoked on 2026-08-06 (the server now
 * answers `Permission denied (publickey)`), and the surviving `vps2_monitor`
 * key authenticates but is pinned to a forced command that replies
 * `denied: this key may only read backup status sentinels`. So the Directory
 * figures are quotations from the spec, dated, with line references, and they
 * say so on screen.
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

/* ===========================================================================
 * THE AS-OF STAMPS (R61)
 * ========================================================================= */

/**
 * The date every `status` in `BUSINESSES` above was last verified.
 *
 * The statuses were curl-/pm2-verified once, on 2026-08-04, and have been
 * frozen since. R61 requires this to be VISIBLE next to every status dot
 * rather than living in a file header nobody opens, so the surface renders it.
 *
 * If you re-verify the inventory, move this date in the same commit that
 * moves the statuses. A stale date is the only thing worse than no date,
 * because it is a claim rather than a silence.
 *
 * DELIBERATELY NOT LIVE-PROBED. Probing 22 URLs and 5 hosts on every paint is
 * scope this project has not bought; the honest cheap alternative is a date.
 */
export const INVENTORY_AS_OF = "2026-08-04";

/** Vault path of the spec every `specLines` reference below points into. */
export const BUSINESS_SPEC_PATH =
  "AI OS/Specs/Directory + Business Plan Hub — Business Model.md";

/** The day the spec's measurements were taken (its own §1.3 header, line 110). */
export const BUSINESS_SPEC_AS_OF = "2026-08-04";

/**
 * The two businesses Konrad actually runs, in the order they render.
 * R62: these are visually primary and come FIRST in DOM order — everything
 * else on this surface is below them. Five equal cards made a dormant agency
 * look like a going concern.
 *
 * `directory` and `creator` are keys into `BUSINESSES`; the surface asserts
 * that at render time rather than trusting the string.
 */
export const PRIMARY_BUSINESS_KEYS = ["directory", "creator"] as const;

/* ===========================================================================
 * THE DIRECTORY SALES FUNNEL — §3.2 as amended by the SECOND §10
 * ========================================================================= */

/**
 * One stage of the Directory sales funnel.
 *
 * `count` is a SPEC-SOURCED figure as of `DIRECTORY_FUNNEL_AS_OF`, never a
 * live number. `provenance` is rendered on screen so a reader can check the
 * claim against the vault without asking anyone.
 */
export interface FunnelStage {
  key: string;
  label: string;
  /** Condensed entry criterion, from the §3.2 table. */
  criterion: string;
  /** Line reference into `BUSINESS_SPEC_PATH`, e.g. "§3.2 L259". */
  specLines: string;
  count: number;
  /** Why the count is what it is. Rendered for every zero — R63. */
  provenance: string;
}

/** The date the Directory figures below were measured (spec §1.3, L110). */
export const DIRECTORY_FUNNEL_AS_OF = "2026-08-04";

/**
 * The canonical stage set.
 *
 * §3.2 (L259–266) defines seven stages plus a terminal Lost/Disqualified.
 * The LATER second §10 (L788–791) adds **Committed** between Proposed and
 * Won, because "without it the signature has nowhere to live at all". Eight
 * stages is therefore the correct spine, and a funnel drawn from §3.2 alone
 * would be one Konrad has already superseded.
 *
 * EVERY STAGE BUT THE FIRST IS ZERO, and that is the point (R63). §0 L32:
 * "Nothing has ever been sold." L34–35: "Zero outreach has ever been sent by
 * any system on either box." A scoreboard that hides the score is decoration.
 */
export const DIRECTORY_FUNNEL: FunnelStage[] = [
  {
    key: "sourced",
    label: "Sourced",
    criterion:
      "A places row matching the ICP filter — territory=jersey, target profession, on_niche=1, phone or verified email, completeness above the floor. Machine-assigned, never manual.",
    specLines: "§3.2 L259",
    count: 891,
    provenance:
      "891 rows cleared the enrichment gate (is_indexable=1) — 0.33% of 271,758 (§1.3 L114–117). NOTE: that is the enrichment gate, not the §3.2 ICP filter, which has never been counted. It is the nearest measured proxy and is labelled as one rather than promoted to a stage count it has not earned.",
  },
  {
    key: "compliance_cleared",
    label: "Compliance-cleared",
    criterion:
      "Corporate subscriber confirmed (ltd/LLP), or phone screened against TPS/CTPS within 28 days. A row may not skip this stage; an unrun check must hard-error, never default to allowed.",
    specLines: "§3.2 L260",
    count: 0,
    provenance:
      "No TPS/CTPS screening has ever run. The gate that must hard-error on an unrun check is itself unbuilt (§10.5 L858).",
  },
  {
    key: "contacted",
    label: "Contacted",
    criterion: "First touch sent or dialled, logged with channel and timestamp.",
    specLines: "§3.2 L261",
    count: 0,
    provenance:
      "“Zero outreach has ever been sent by any system on either box” (§0 L34–35).",
  },
  {
    key: "engaged",
    label: "Engaged",
    criterion:
      "The prospect replied, answered the phone, or clicked the claim/booking link.",
    specLines: "§3.2 L262",
    count: 0,
    provenance:
      "Nothing has been contacted, so nothing can have replied. Every claim and lead in the Jersey pilot is test data Konrad typed himself (§0 L33–34).",
  },
  {
    key: "qualified",
    label: "Qualified",
    criterion:
      "Discovery call completed AND three facts recorded: the named need, who does that work today, and who signs off on spend.",
    specLines: "§3.2 L263",
    count: 0,
    provenance: "No discovery call has been held.",
  },
  {
    key: "proposed",
    label: "Proposed",
    criterion: "A written, priced scope of work has been sent.",
    specLines: "§3.2 L264",
    count: 0,
    provenance: "No scope has been sent. Listing price is settled at £49/month (§10 Q2 L701).",
  },
  {
    key: "committed",
    label: "Committed",
    criterion:
      "A priced scope is SIGNED. Records signed_on and a mandatory expected_first_payment_on. Writes nothing to the ledger — not one row.",
    specLines: "§10 L784, L788–791",
    count: 0,
    provenance:
      "Nothing signed. This stage does not yet exist in any system — the second §10 added it after §3.2 was written, and building it is one of the four defects §10.5 (L858) lists as open.",
  },
  {
    key: "won_client",
    label: "Won — Client",
    criterion:
      "The FIRST PAYMENT HAS CLEARED. Not signature, not verbal agreement. Cash. Fires once, ever.",
    specLines: "§3.2 L265 · §3.4 L306 · §10 L785",
    count: 0,
    provenance: "“Nothing has ever been sold” (§0 L32).",
  },
];

/**
 * Reachable from any stage, and deliberately not drawn in the spine.
 * Requires a reason code — no free text (§3.2 L266).
 */
export const DIRECTORY_TERMINAL: FunnelStage = {
  key: "lost",
  label: "Lost / Disqualified",
  criterion:
    "Reachable from any stage. Reason code mandatory, no free text: no_response, not_qualified, no_budget, has_provider, compliance_block, bad_data — plus signed_never_paid.",
  specLines: "§3.2 L266 · §10.2 L797–800",
  count: 0,
  provenance:
    "Nothing has entered the funnel past Sourced, so nothing can have left it.",
};

/* ===========================================================================
 * THE PRECISION THE PROJECT BRIEF GETS WRONG — signature vs cash
 * ========================================================================= */

/**
 * Two passages of the spec answer "what counts as won?" differently, and the
 * difference is not cosmetic — it decides whether the revenue number lies.
 * Resolved here once, rendered on the Directory card, so nobody re-argues it
 * from whichever passage they happened to open.
 */
export interface WonRule {
  headline: string;
  /** Each entry is one sentence of the resolution, in order. */
  body: string[];
  specLines: string;
}

export const DIRECTORY_WON_RULE: WonRule = {
  headline: "Signature is a CRM event. Cash is a ledger event.",
  body: [
    "§10 Q4 (L703) answers “what counts as won?” with the single word “Signature”, and points the reader at “§11 on where payment belongs”. That pointer is stale: §11 (L887) is “Do we need an ERP?”. The section that actually resolves it is the SECOND section numbered 10 (L764) — the spec has two §10s, which is exactly how a reader ends up quoting the superseded one.",
    "The later §10 supersedes the mechanism, not the instinct. Signature moves the record to COMMITTED with signed_on and a mandatory expected_first_payment_on, and writes NOTHING to the ledger — not one row (L784).",
    "“Won — Client” fires on the FIRST CLEARED PAYMENT, once, ever, alongside ledger row #1 (L785). §3.4's won = first payment cleared decision explicitly “stands” (L788).",
    "A record 14 days past expected_first_payment_on with no cleared payment moves to Lost, reason code signed_never_paid (§10.2 L797–800).",
    "So Q4 is not wrong about what Konrad DOES at signature; it is incomplete about what signature MEANS. Signature closes the conversation. Cash closes the deal.",
  ],
  specLines: "§10 Q4 L703 · §10.1 L775–786 · §10.2 L797–800 · §3.4 L306",
};

/* ===========================================================================
 * THE ONE NEXT ACTION PER PRIMARY ARM
 * ========================================================================= */

/**
 * The funnel spine's second half: counts, and the ONE next action. A stage
 * board with no next action is a report; with one it is an instrument.
 *
 * Directory's is spec-sourced and stamped. YouTube's is DERIVED FROM THE LIVE
 * PROBE at render time and therefore lives in the surface, not here — a
 * hardcoded "next action" for a live arm would be the same lie in a new place.
 */
export interface NextAction {
  text: string;
  specLines: string;
}

export const DIRECTORY_NEXT_ACTION: NextAction = {
  text:
    "Ian makes the first 100 calls (Konrad may take the first ~20 himself to learn the objections). Nothing else in this funnel can move until a first touch exists — every stage below Sourced is gated on an outbound that has never been sent.",
  specLines: "§10 Q3 L702 · §0 L34–35",
};

/* ===========================================================================
 * THE OTHER THREE ARMS — one honest line each
 * ========================================================================= */

/**
 * A secondary arm is one Konrad is NOT trying to grow this quarter. It gets
 * one line and a source, not a card. Rendering it with the same weight as
 * Directory is the defect R62 names.
 */
export interface SecondaryArm {
  /** Key into `BUSINESSES`. */
  key: string;
  /** The single sentence of true state. */
  state: string;
  /** "spec §… L…", or a plain sentence for facts with no spec line. */
  source: string;
  /** Date `state` was measured. Rendered next to it — R61. */
  asOf: string;
}

export const SECONDARY_ARMS: SecondaryArm[] = [
  {
    key: "axtrelis",
    state:
      "Pre-launch. 1 user, 5 seed orders, 0 leads, in a database still named axtrelis_dev. Pricing is locked in code at $197 / $497 / $2,497 one-time — the most rigorously specified revenue model in the operation, with no customers in it.",
    source: "spec §2.2 L211, L207 (live query, VPS2)",
    asOf: BUSINESS_SPEC_AS_OF,
  },
  {
    key: "ai-os",
    state:
      "Not a revenue business. It is the machine the other four are run from, and it has no funnel by design.",
    source: "no revenue model in the spec; this arm is infrastructure",
    asOf: INVENTORY_AS_OF,
  },
  {
    key: "personal",
    state:
      "Dormant. Portfolio site up; the shift tool and Plane are both stopped and answer 502.",
    source: "inventory statuses below",
    asOf: INVENTORY_AS_OF,
  },
];
