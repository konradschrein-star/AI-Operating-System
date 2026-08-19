"use client";

/**
 * Businesses surface — the two businesses Konrad runs, as funnels, above the
 * register of every web property he owns.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED IN PHASE 5, AND WHY (R59–R63)
 * ───────────────────────────────────────────────────────────────────────────
 * Before: five equal collapsible rows over a hand-written server inventory.
 * Nothing in it was a business number and nothing in it was live. The status
 * words were frozen on 2026-08-04 and read, four months later, as current.
 *
 * The spine is now the FUNNEL — stage counts per arm, and the one next
 * action. That was Konrad's ruling by default: the choice was put to him in
 * the manager chat on 2026-08-18T18:51:39Z stating FUNNEL as the default if
 * unanswered, and no answer followed. The evidence, both timestamps and the
 * query that produced them, is in
 * docs/plan/artifacts/os-usable-for-work/phase5/business-spine-ruling.md.
 *
 * Three rules hold regardless of spine:
 *
 *   R61 — every figure is LIVE-PROBED or carries a VISIBLE as-of date. There
 *         is no third category. YouTube is probed through
 *         `fetchPipelineBusiness`; Directory and the inventory are dated.
 *   R62 — Directory and YouTube are primary and render ABOVE the other three
 *         arms and the inventory, in DOM order. The `data-business-slot`
 *         attributes below exist so that ordering can be asserted
 *         mechanically rather than eyeballed from a screenshot.
 *   R63 — the zeroes are REPORTED with their source, not hidden. Seven of
 *         the eight Directory stages are empty, and each one says why. A
 *         scoreboard that hides the score is decoration.
 *
 * N1 — NO SILENT FALLBACK. If the pipeline probe fails, the YouTube card
 * renders the error. It does not render zeroes. A zero that means "the
 * database was unreachable" is the single most expensive lie this surface
 * could tell, because it is indistinguishable from a quiet Tuesday.
 *
 * Konrad's four standing asks from 2026-08-04 still hold and are preserved
 * below: live inside the shell, group by venture, no scrolling to navigate,
 * and OPEN next to REPO on every property row.
 *
 * Data sources: ./businesses-inventory.ts (dated) and ../api-business.ts
 * (live). This file owns neither — it renders them.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchPipelineBusiness, type BusinessPipelineResponse } from "../api-business";
import {
  BUSINESSES,
  BUSINESS_SPEC_PATH,
  DIRECTORY_FUNNEL,
  DIRECTORY_FUNNEL_AS_OF,
  DIRECTORY_NEXT_ACTION,
  DIRECTORY_TERMINAL,
  DIRECTORY_WON_RULE,
  INVENTORY_AS_OF,
  PRIMARY_BUSINESS_KEYS,
  SECONDARY_ARMS,
  type Box,
  type Business,
  type FunnelStage,
  type Property,
  type Status,
} from "./businesses-inventory";

const STATUS: Record<Status, { fg: string; label: string }> = {
  running: { fg: tokens.ok, label: "running" },
  stopped: { fg: tokens.bleed, label: "stopped" },
  not_deployed: { fg: tokens.warn, label: "not deployed" },
  unknown: { fg: tokens.warn, label: "unknown" },
  dormant: { fg: tokens.textFaint, label: "dormant" },
};

const BOX_LABEL: Record<Box, string> = {
  vps1: "VPS1",
  vps2: "VPS2",
  external: "EXTERNAL",
};

/**
 * Resolve a key into `BUSINESSES`, or throw with the diagnostic that says
 * which file is out of sync. A missing key is a programming error — an
 * arm silently vanishing from the surface is how a business stops being
 * looked at.
 */
function businessByKey(key: string): Business {
  const found = BUSINESSES.find((b) => b.key === key);
  if (!found) {
    throw new Error(
      `BusinessesSurface: no business with key "${key}" in businesses-inventory.ts. ` +
        `Known keys: ${BUSINESSES.map((b) => b.key).join(", ")}. ` +
        `PRIMARY_BUSINESS_KEYS or SECONDARY_ARMS is out of sync with BUSINESSES.`,
    );
  }
  return found;
}

export function BusinessesSurface() {
  const [directoryKey, youtubeKey] = PRIMARY_BUSINESS_KEYS;
  const directory = businessByKey(directoryKey);
  const youtube = businessByKey(youtubeKey);

  // Every business collapsed by default so the whole portfolio fits on one
  // screen. Konrad's core complaint about the previous page was "quite a
  // lot" — the inventory's first paint is five headers, nothing else.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const allOpen = open.size === BUSINESSES.length;
  const expandAll = () => setOpen(new Set(BUSINESSES.map((b) => b.key)));
  const collapseAll = () => setOpen(new Set());

  const totals = useMemo(() => {
    const flat = BUSINESSES.flatMap((b) => b.properties);
    return {
      total: flat.length,
      running: flat.filter((p) => p.status === "running").length,
      stopped: flat.filter((p) => p.status === "stopped").length,
      not_deployed: flat.filter((p) => p.status === "not_deployed").length,
    };
  }, []);

  // R62: inside the inventory too, the two primaries come first. The order
  // is derived from PRIMARY_BUSINESS_KEYS rather than from the literal order
  // of BUSINESSES, so re-sorting that array cannot silently demote an arm.
  const orderedInventory = useMemo(() => {
    const primaries = PRIMARY_BUSINESS_KEYS.map((k) => businessByKey(k));
    const rest = BUSINESSES.filter(
      (b) => !PRIMARY_BUSINESS_KEYS.some((k) => k === b.key),
    );
    return [...primaries, ...rest];
  }, []);

  return (
    <div
      className="slidein"
      style={{ maxWidth: 980, margin: "0 auto", padding: "24px 28px 48px" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Businesses
        </span>
        <span className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          2 running · {BUSINESSES.length - 2} other arms · {totals.total} properties
        </span>
      </div>

      <div
        style={{
          color: tokens.textMuted,
          fontSize: 12.5,
          marginBottom: 18,
          lineHeight: 1.5,
        }}
      >
        The spine is the funnel: stage counts per arm and the one next action.
        Every figure below is either <Live>live</Live> — probed when this page
        loaded — or carries the date it was measured. Nothing here is undated.
      </div>

      {/* ═══ PRIMARY 1 — Directory. First in DOM order, R62. ═══ */}
      <section data-business-slot="primary-directory">
        <DirectoryPrimary business={directory} />
      </section>

      {/* ═══ PRIMARY 2 — YouTube / Creator, live-probed. ═══ */}
      <section data-business-slot="primary-youtube">
        <YouTubePrimary business={youtube} />
      </section>

      {/* ═══ The other three arms — one line each, deliberately not cards. ═══ */}
      <section data-business-slot="secondary-arms">
        <SectionLabel>
          The other three arms — not being grown this quarter
        </SectionLabel>
        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 10,
            overflow: "hidden",
            marginBottom: 22,
          }}
        >
          {SECONDARY_ARMS.map((arm, i) => {
            const b = businessByKey(arm.key);
            return (
              <div
                key={arm.key}
                style={{
                  padding: "10px 14px",
                  borderBottom:
                    i === SECONDARY_ARMS.length - 1
                      ? "none"
                      : `1px solid ${tokens.borderDivider}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 9,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{ fontSize: 12.5, fontWeight: 600, color: tokens.text }}
                  >
                    {b.title}
                  </span>
                  <AsOf date={arm.asOf} />
                  <span
                    className="mono"
                    style={{ fontSize: 9.5, color: tokens.textGhost }}
                  >
                    {b.properties.length} properties
                  </span>
                </div>
                <div
                  style={{
                    color: tokens.textMuted,
                    fontSize: 11.5,
                    marginTop: 3,
                    lineHeight: 1.5,
                  }}
                >
                  {arm.state}
                </div>
                <Source>{arm.source}</Source>
              </div>
            );
          })}
        </div>
      </section>

      {/* ═══ The inventory — last, and every dot dated. ═══ */}
      <section data-business-slot="inventory">
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <SectionLabel inline>
            Properties — the servers behind all five arms
          </SectionLabel>
          <AsOf date={INVENTORY_AS_OF} what="every status below" />
          <span style={{ flex: 1 }} />
          <button
            onClick={allOpen ? collapseAll : expandAll}
            className="mono"
            style={smallBtn}
          >
            {allOpen ? "collapse all" : "expand all"}
          </button>
        </div>

        <div
          style={{
            color: tokens.textMuted,
            fontSize: 11.5,
            marginBottom: 12,
            lineHeight: 1.5,
          }}
        >
          Not live-probed. Every dot is a hand-verified state from{" "}
          {INVENTORY_AS_OF}, which is why the date is repeated on each one. Edit{" "}
          <code className="mono" style={{ fontSize: 11, color: tokens.textBody }}>
            app/desktop/businesses-inventory.ts
          </code>{" "}
          — and move{" "}
          <code className="mono" style={{ fontSize: 11, color: tokens.textBody }}>
            INVENTORY_AS_OF
          </code>{" "}
          in the same commit.
        </div>

        {/* Compact totals strip — small, one line, not a bento-card wall. */}
        <div
          className="mono"
          style={{
            display: "flex",
            gap: 14,
            fontSize: 11,
            color: tokens.textMuted,
            padding: "8px 12px",
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 8,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <span>
            <span style={{ color: tokens.ok }}>●</span> {totals.running} running
          </span>
          <span>
            <span style={{ color: tokens.bleed }}>●</span> {totals.stopped} stopped
          </span>
          <span>
            <span style={{ color: tokens.warn }}>●</span> {totals.not_deployed} not
            deployed
          </span>
          <span style={{ color: tokens.textGhost }}>all as of {INVENTORY_AS_OF}</span>
        </div>

        <div
          style={{
            background: tokens.bgCard,
            border: `1px solid ${tokens.border}`,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {orderedInventory.map((b, i) => {
            const isOpen = open.has(b.key);
            const isLast = i === orderedInventory.length - 1;
            const counts = countByStatus(b.properties);
            return (
              <div
                key={b.key}
                style={{
                  borderBottom: isLast
                    ? "none"
                    : `1px solid ${tokens.borderDivider}`,
                }}
              >
                <BusinessHeader
                  title={b.title}
                  subtitle={b.subtitle}
                  counts={counts}
                  total={b.properties.length}
                  isOpen={isOpen}
                  onToggle={() => toggle(b.key)}
                />
                {isOpen && (
                  <div
                    style={{
                      borderTop: `1px solid ${tokens.borderDivider}`,
                      background: "transparent",
                    }}
                  >
                    {b.properties.map((p, j) => (
                      <PropertyRow
                        key={`${b.key}:${p.name}`}
                        p={p}
                        last={j === b.properties.length - 1}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ===========================================================================
 * PRIMARY ARM 1 — DIRECTORY. Eight stages, seven of them empty, each saying
 * why. Every figure spec-sourced and stamped (R61/R63).
 * ========================================================================= */

function DirectoryPrimary({ business }: { business: Business }) {
  const [showRule, setShowRule] = useState(false);
  const stages = DIRECTORY_FUNNEL;
  const peak = Math.max(...stages.map((s) => s.count), 1);
  const sourced = stages[0];
  const won = stages[stages.length - 1];

  return (
    <PrimaryCard
      title={business.title}
      tagline="Layer 1 listings · £49/month · accountants, Jersey · Twenty CRM"
      provenance={
        <>
          <SpecStamped date={DIRECTORY_FUNNEL_AS_OF} />
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            not live-probeable from VPS1 — see the ruling doc
          </span>
        </>
      }
    >
      {/* The headline, before any chart: what the funnel actually says. */}
      <div
        style={{
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
          padding: "10px 13px",
          background: tokens.bgGutter,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          marginBottom: 14,
        }}
      >
        <Figure label="sourced" value={sourced.count.toLocaleString()} tone={tokens.text} />
        <Figure label="contacted" value="0" tone={tokens.stuck} />
        <Figure label="committed" value="0" tone={tokens.stuck} />
        <Figure label="won — client" value={won.count.toString()} tone={tokens.stuck} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            style={{
              fontSize: 11.5,
              color: tokens.textMuted,
              lineHeight: 1.5,
            }}
          >
            Zero outbound has ever been sent by any system on either box, so
            every stage below <em>Sourced</em> is necessarily empty. The 891 is
            0.33% of 271,758 scraped rows.
          </div>
          <Source>spec §0 L32–35 · §1.3 L114–117</Source>
        </div>
      </div>

      {/* The spine. An empty track is a real reading, not a missing one. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {stages.map((s, i) => (
          <StageRow key={s.key} stage={s} peak={peak} index={i + 1} />
        ))}
        <div style={{ height: 7 }} />
        <StageRow stage={DIRECTORY_TERMINAL} peak={peak} index={null} />
      </div>

      {/* The precision the two §10s disagree about, resolved once. */}
      <div
        style={{
          marginTop: 14,
          padding: "9px 12px",
          background: tokens.invariantBg,
          border: `1px solid ${tokens.invariantBorder}`,
          borderRadius: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{ fontSize: 12, fontWeight: 600, color: tokens.textHi }}
          >
            {DIRECTORY_WON_RULE.headline}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => setShowRule((v) => !v)}
            className="mono"
            style={smallBtn}
          >
            {showRule ? "hide" : "why, and which passage supersedes which"}
          </button>
        </div>
        {showRule && (
          <div style={{ marginTop: 8 }}>
            {DIRECTORY_WON_RULE.body.map((sentence, i) => (
              <p
                key={i}
                style={{
                  margin: "0 0 7px",
                  fontSize: 11.5,
                  color: tokens.textBody,
                  lineHeight: 1.55,
                }}
              >
                {sentence}
              </p>
            ))}
            <Source>{`spec ${DIRECTORY_WON_RULE.specLines}`}</Source>
          </div>
        )}
      </div>

      <NextActionBlock
        text={DIRECTORY_NEXT_ACTION.text}
        source={`spec ${DIRECTORY_NEXT_ACTION.specLines}`}
      />

      <div
        className="mono"
        style={{
          marginTop: 10,
          fontSize: 9.5,
          color: tokens.textGhost,
          lineHeight: 1.5,
          wordBreak: "break-word",
        }}
      >
        every figure above quoted from {BUSINESS_SPEC_PATH}
      </div>
    </PrimaryCard>
  );
}

/** One funnel stage: rank, label, bar, count, and the reason for the count. */
function StageRow({
  stage,
  peak,
  index,
}: {
  stage: FunnelStage;
  peak: number;
  index: number | null;
}) {
  const [showCriterion, setShowCriterion] = useState(false);
  const empty = stage.count === 0;
  const width = empty ? 0 : Math.max(2, Math.round((stage.count / peak) * 100));
  return (
    <div
      style={{
        padding: "7px 12px",
        background: tokens.bgGutter,
        borderLeft: `2px solid ${empty ? tokens.borderSoft : tokens.accent}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          className="mono"
          style={{ fontSize: 9.5, color: tokens.textGhost, width: 12 }}
        >
          {index === null ? "×" : index}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: empty ? tokens.textMuted : tokens.textHi,
            minWidth: 132,
          }}
        >
          {stage.label}
        </span>
        {/* The track. Rendered even at zero — an empty track is the reading. */}
        <span
          style={{
            flex: 1,
            height: 5,
            minWidth: 60,
            borderRadius: 3,
            background: tokens.bgTabBar,
            border: `1px solid ${tokens.borderSoft}`,
            overflow: "hidden",
            display: "block",
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: `${width}%`,
              background: tokens.accent,
            }}
          />
        </span>
        <span
          className="mono"
          style={{
            fontSize: 12.5,
            fontVariantNumeric: "tabular-nums",
            color: empty ? tokens.stuck : tokens.textHi,
            minWidth: 46,
            textAlign: "right",
          }}
        >
          {stage.count.toLocaleString()}
        </span>
        <button
          onClick={() => setShowCriterion((v) => !v)}
          className="mono"
          title={showCriterion ? "hide entry criterion" : "show entry criterion"}
          style={{ ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint), cursor: "pointer" }}
        >
          {showCriterion ? "−" : "…"}
        </button>
      </div>

      {/* R63: the zero is not enough. The reason for the zero is the report. */}
      <div
        style={{
          fontSize: 11,
          color: tokens.textMuted,
          lineHeight: 1.5,
          marginTop: 3,
          marginLeft: 21,
        }}
      >
        {stage.provenance}
      </div>

      {showCriterion && (
        <div
          style={{
            fontSize: 11,
            color: tokens.textBody,
            lineHeight: 1.5,
            marginTop: 5,
            marginLeft: 21,
            paddingLeft: 9,
            borderLeft: `1px solid ${tokens.borderDivider}`,
          }}
        >
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textLabel }}>
            ENTRY CRITERION · {stage.specLines}
          </span>
          <div style={{ marginTop: 2 }}>{stage.criterion}</div>
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
 * PRIMARY ARM 2 — YOUTUBE / CREATOR. Live-probed, and loud when it cannot be.
 * ========================================================================= */

function YouTubePrimary({ business }: { business: Business }) {
  const q = useQuery<BusinessPipelineResponse, Error>({
    queryKey: ["business", "pipeline"],
    queryFn: fetchPipelineBusiness,
    refetchInterval: 60_000,
    retry: 1,
  });

  return (
    <PrimaryCard
      title={business.title}
      tagline="Faceless-video factory (TheSkyLab) · Content Forge · content_jobs"
      provenance={
        q.data ? (
          <>
            <Live>live</Live>
            <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
              probed {new Date(q.data.as_of).toISOString().replace("T", " ").slice(0, 19)}Z
            </span>
          </>
        ) : (
          <Live>live</Live>
        )
      }
    >
      {q.isPending && (
        <div
          className="mono"
          style={{ fontSize: 11.5, color: tokens.textMuted, padding: "8px 2px" }}
        >
          probing content_jobs…
        </div>
      )}

      {/* N1 — the failure renders as a failure. Never as zeroes. */}
      {q.isError && (
        <div
          style={{
            padding: "10px 13px",
            background: tokens.dangerActionBg,
            border: `1px solid ${tokens.dangerActionBorder}`,
            borderRadius: 8,
          }}
        >
          <div
            style={{ fontSize: 12, fontWeight: 600, color: tokens.bleed }}
          >
            No figures — the pipeline probe failed.
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: tokens.textBody,
              marginTop: 5,
              lineHeight: 1.5,
              wordBreak: "break-word",
            }}
          >
            GET /api/proxy/pipeline → {q.error.message}
          </div>
          <div
            style={{
              fontSize: 11,
              color: tokens.textMuted,
              marginTop: 6,
              lineHeight: 1.5,
            }}
          >
            Deliberately blank rather than zero. A zero here would be
            indistinguishable from a quiet day, and this arm is the one Konrad
            develops on — a false quiet is worse than a visible fault.
          </div>
          <button
            onClick={() => void q.refetch()}
            className="mono"
            style={{ ...smallBtn, marginTop: 8 }}
          >
            retry probe
          </button>
        </div>
      )}

      {q.data && <YouTubeFigures data={q.data} />}
    </PrimaryCard>
  );
}

function YouTubeFigures({ data }: { data: BusinessPipelineResponse }) {
  const peak = Math.max(...data.phases.map((p) => p.count), 1);
  const worstStalled = useMemo(() => {
    const withStalls = data.phases.filter((p) => p.stalled_count > 0);
    if (withStalls.length === 0) return null;
    return withStalls.reduce((a, b) => (b.stalled_count > a.stalled_count ? b : a));
  }, [data.phases]);

  // Derived at render from the probe, never hardcoded — a fixed "next action"
  // for a live arm is the same lie the as-of dates exist to prevent.
  const nextAction =
    data.stalled_total > 0
      ? `${data.stalled_total} of ${data.total} jobs have not changed status in over ${data.stall_threshold_hours}h` +
        (worstStalled
          ? ` — worst is ${worstStalled.label} with ${worstStalled.stalled_count}. Clear that phase before queueing more work.`
          : ".")
      : `Nothing stalled beyond ${data.stall_threshold_hours}h across ${data.total} jobs. The queue is the constraint, not the workers.`;

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 18,
          flexWrap: "wrap",
          padding: "10px 13px",
          background: tokens.bgGutter,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 8,
          marginBottom: 14,
        }}
      >
        <Figure label="jobs" value={data.total.toLocaleString()} tone={tokens.text} />
        <Figure
          label={`stalled >${data.stall_threshold_hours}h`}
          value={data.stalled_total.toLocaleString()}
          tone={data.stalled_total > 0 ? tokens.stuck : tokens.ok}
        />
        <Figure
          label="phases"
          value={data.phases.length.toString()}
          tone={tokens.text}
        />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.5 }}>
            Counts are the true totals from <code className="mono">content_jobs</code>,
            not the length of a preview list. Deleted jobs excluded.
          </div>
          <Source>{`live · content_forge · stall cutoff ${data.stall_cutoff}`}</Source>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {data.phases.map((p, i) => {
          const empty = p.count === 0;
          const width = empty ? 0 : Math.max(2, Math.round((p.count / peak) * 100));
          return (
            <div
              key={p.key}
              style={{
                padding: "7px 12px",
                background: tokens.bgGutter,
                borderLeft: `2px solid ${
                  p.stalled_count > 0
                    ? tokens.stuck
                    : empty
                      ? tokens.borderSoft
                      : tokens.accent
                }`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  className="mono"
                  style={{ fontSize: 9.5, color: tokens.textGhost, width: 12 }}
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: empty ? tokens.textMuted : tokens.textHi,
                    minWidth: 132,
                  }}
                >
                  {p.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 5,
                    minWidth: 60,
                    borderRadius: 3,
                    background: tokens.bgTabBar,
                    border: `1px solid ${tokens.borderSoft}`,
                    overflow: "hidden",
                    display: "block",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${width}%`,
                      background:
                        p.stalled_count > 0 ? tokens.stuck : tokens.accent,
                    }}
                  />
                </span>
                {p.stalled_count > 0 && (
                  <span
                    className="mono"
                    style={{ fontSize: 9.5, color: tokens.stuck }}
                  >
                    {p.stalled_count} stalled
                  </span>
                )}
                <span
                  className="mono"
                  style={{
                    fontSize: 12.5,
                    fontVariantNumeric: "tabular-nums",
                    color: empty ? tokens.textMuted : tokens.textHi,
                    minWidth: 46,
                    textAlign: "right",
                  }}
                >
                  {p.count.toLocaleString()}
                </span>
              </div>
              {/* The server says WHY a column is empty; two different empties. */}
              <div
                style={{
                  fontSize: 11,
                  color:
                    p.state === "no_work_blocked_upstream"
                      ? tokens.warn
                      : tokens.textMuted,
                  lineHeight: 1.5,
                  marginTop: 3,
                  marginLeft: 21,
                }}
              >
                {p.state_reason}
              </div>
              {p.cards_truncated && (
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: tokens.textGhost,
                    marginTop: 2,
                    marginLeft: 21,
                  }}
                >
                  preview shows {p.cards.length} of {p.count}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <NextActionBlock text={nextAction} source="derived from the live probe" />
    </>
  );
}

/* ===========================================================================
 * Shared primitives
 * ========================================================================= */

function PrimaryCard({
  title,
  tagline,
  provenance,
  children,
}: {
  title: string;
  tagline: string;
  provenance: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${tokens.borderEmphasis}`,
        borderRadius: 10,
        padding: "14px 16px 16px",
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 3,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: tokens.textHi }}>
          {title}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9,
            letterSpacing: "0.09em",
            color: tokens.accent,
            border: `1px solid ${tokens.accent}`,
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          PRIMARY
        </span>
        <span style={{ flex: 1 }} />
        {provenance}
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: tokens.textMuted,
          marginBottom: 12,
          lineHeight: 1.5,
        }}
      >
        {tagline}
      </div>
      {children}
    </div>
  );
}

function NextActionBlock({ text, source }: { text: string; source: string }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: "9px 12px",
        background: tokens.primaryActionBg,
        border: `1px solid ${tokens.accent}`,
        borderRadius: 8,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: "0.09em",
          color: tokens.accent,
        }}
      >
        NEXT ACTION
      </div>
      <div
        style={{
          fontSize: 12,
          color: tokens.textBody,
          marginTop: 3,
          lineHeight: 1.5,
        }}
      >
        {text}
      </div>
      <Source>{source}</Source>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 18,
          fontVariantNumeric: "tabular-nums",
          color: tone,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: "0.07em",
          color: tokens.textLabel,
          textTransform: "uppercase",
          marginTop: 3,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** The "this number was measured just now" mark. */
function Live({ children }: { children: ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: tokens.ok,
        border: `1px solid ${tokens.okActionBorder}`,
        background: tokens.okActionBg,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}

/** The "this number is a dated quotation" mark — the other half of R61. */
function SpecStamped({ date }: { date: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: tokens.warn,
        border: `1px solid ${tokens.freezeBorderWarn}`,
        background: tokens.freezeBgWarn,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      spec-sourced · as of {date}
    </span>
  );
}

function AsOf({ date, what }: { date: string; what?: string }) {
  return (
    <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
      {what ? `${what} as of ${date}` : `as of ${date}`}
    </span>
  );
}

function Source({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        color: tokens.textGhost,
        marginTop: 4,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({
  children,
  inline,
}: {
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: tokens.textLabel,
        marginBottom: inline ? 0 : 7,
        marginTop: 2,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Business header — click to fold/unfold. Keeps five rows always visible.
 * ------------------------------------------------------------------------- */
function BusinessHeader({
  title,
  subtitle,
  counts,
  total,
  isOpen,
  onToggle,
}: {
  title: string;
  subtitle: string;
  counts: { running: number; stopped: number; not_deployed: number };
  total: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span
        className="mono"
        style={{
          width: 12,
          fontSize: 11,
          color: tokens.textFaint,
          transition: "transform 120ms",
          display: "inline-block",
          transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
        }}
      >
        ▸
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: tokens.textHi }}>
        {title}
      </span>
      <span
        className="mono"
        style={{ fontSize: 10.5, color: tokens.textFaint }}
      >
        {total}
      </span>
      <span
        className="mono"
        style={{
          display: "inline-flex",
          gap: 8,
          fontSize: 10.5,
          color: tokens.textFaint,
        }}
      >
        {counts.running > 0 && (
          <span>
            <span style={{ color: tokens.ok }}>●</span> {counts.running}
          </span>
        )}
        {counts.stopped > 0 && (
          <span>
            <span style={{ color: tokens.bleed }}>●</span> {counts.stopped}
          </span>
        )}
        {counts.not_deployed > 0 && (
          <span>
            <span style={{ color: tokens.warn }}>●</span> {counts.not_deployed}
          </span>
        )}
      </span>
      <span
        className="mono"
        style={{ fontSize: 9.5, color: tokens.textGhost }}
      >
        as of {INVENTORY_AS_OF}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: tokens.textMuted,
          marginLeft: 6,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={subtitle}
      >
        {!isOpen && subtitle}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Property row — dense two-line row with OPEN + REPO always adjacent.
 * ------------------------------------------------------------------------- */
function PropertyRow({ p, last }: { p: Property; last: boolean }) {
  const [showDetail, setShowDetail] = useState(false);
  const st = STATUS[p.status];
  const dead = p.status === "stopped" || p.status === "not_deployed";
  return (
    <div
      style={{
        padding: "10px 14px 10px 34px",
        borderBottom: last ? "none" : `1px solid ${tokens.borderDivider}`,
        opacity: dead ? 0.82 : 1,
      }}
    >
      {/* Action row. Everything on one line: name, status dot, box chip,
          OPEN + REPO side by side. Konrad explicitly liked OPEN adjacent
          to REPO — keep it that way. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          title={`${st.label} — as of ${INVENTORY_AS_OF}, not live-probed`}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: st.fg,
            flex: "none",
          }}
        />
        <span
          style={{ fontSize: 13, fontWeight: 500, color: tokens.text }}
        >
          {p.name}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: st.fg,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {st.label}
        </span>
        {/* R61: the date lives NEXT TO the dot, not in a file header. */}
        <span
          className="mono"
          style={{ fontSize: 9, color: tokens.textGhost }}
        >
          @{INVENTORY_AS_OF}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 4,
            padding: "1px 5px",
          }}
        >
          {BOX_LABEL[p.box]}
        </span>
        <span style={{ flex: 1 }} />
        {/* OPEN and REPO — side by side, always in that order. */}
        {p.publicUrl ? (
          <a
            href={p.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={linkBtn(tokens.primaryActionBg, tokens.accent, tokens.accent)}
          >
            OPEN ↗
          </a>
        ) : (
          <span
            className="mono"
            style={{
              ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
              cursor: "default",
              opacity: 0.5,
            }}
            title="No public URL"
          >
            OPEN
          </span>
        )}
        {p.githubUrl ? (
          <a
            href={p.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={linkBtn(tokens.toolBg, tokens.border, tokens.textBody)}
          >
            REPO ↗
          </a>
        ) : (
          <span
            className="mono"
            style={{
              ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
              cursor: "default",
              opacity: 0.5,
            }}
            title="Not a git repo"
          >
            REPO
          </span>
        )}
        <button
          onClick={() => setShowDetail((v) => !v)}
          className="mono"
          title={showDetail ? "hide paths / admin URL" : "show paths / admin URL"}
          style={{
            ...linkBtn(tokens.toolBg, tokens.borderSoft, tokens.textFaint),
            cursor: "pointer",
          }}
        >
          {showDetail ? "−" : "…"}
        </button>
      </div>

      {/* Line 2: what this thing is. Muted, one line. */}
      <div
        style={{
          color: tokens.textMuted,
          fontSize: 11.5,
          marginTop: 4,
          marginLeft: 17,
          lineHeight: 1.5,
        }}
      >
        {p.what}
      </div>

      {/* Line 3: only when something is actually wrong or worth flagging. */}
      {p.statusNote && (
        <div
          style={{
            color: st.fg,
            fontSize: 11,
            marginTop: 3,
            marginLeft: 17,
            lineHeight: 1.5,
          }}
        >
          {p.statusNote}
        </div>
      )}

      {p.note && !p.statusNote && (
        <div
          style={{
            color: tokens.textFaint,
            fontSize: 11,
            marginTop: 3,
            marginLeft: 17,
            lineHeight: 1.5,
          }}
        >
          {p.note}
        </div>
      )}

      {/* Optional detail: admin URL + local path. Not visible until asked
          for — Konrad's baseline density is name + description, not URL
          tables. */}
      {showDetail && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 8,
            marginTop: 8,
            marginLeft: 17,
            fontSize: 11.5,
          }}
        >
          {p.adminUrl && <Field label="ADMIN" value={p.adminUrl} />}
          {p.localPath && <Field label="PATH" value={p.localPath} />}
          {p.publicUrl && <Field label="PUBLIC" value={p.publicUrl} />}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono"
        style={{ fontSize: 9.5, color: tokens.textLabel, letterSpacing: "0.08em" }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          color: tokens.textBody,
          marginTop: 2,
          fontSize: 11,
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function countByStatus(props: Property[]) {
  return {
    running: props.filter((p) => p.status === "running").length,
    stopped: props.filter((p) => p.status === "stopped").length,
    not_deployed: props.filter((p) => p.status === "not_deployed").length,
  };
}

const smallBtn: CSSProperties = {
  fontSize: 10.5,
  color: tokens.textMuted,
  background: tokens.toolBg,
  border: `1px solid ${tokens.border}`,
  borderRadius: 6,
  padding: "4px 9px",
  cursor: "pointer",
};

function linkBtn(bg: string, border: string, fg: string): CSSProperties {
  return {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 6,
    color: fg,
    cursor: "pointer",
    fontSize: 10.5,
    padding: "4px 8px",
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    lineHeight: 1,
  };
}
