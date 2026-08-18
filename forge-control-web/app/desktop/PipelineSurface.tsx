"use client";

/**
 * Pipeline surface — Content Forge's `content_jobs`, read as an operator would
 * read it: what is stuck, for how long, who is waiting on whom.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED IN PHASE 5, AND WHY (R64–R67)
 * ───────────────────────────────────────────────────────────────────────────
 * Before: seven columns, a bare count badge, the word `empty` in an empty
 * column, and a card age like `13d` set in textFaint at 9.5px. On the live
 * data that produced three separate lies on one screen:
 *
 *   R64  Five jobs stuck 11–14 days and five fresh jobs looked identical —
 *        the age was a footnote in the corner of a card, with no stall
 *        treatment at all.
 *   R65  Six of seven columns rendered `0` for two OPPOSITE reasons. `Idea` is
 *        empty because nothing was ever created; `Publish` is empty because
 *        four jobs are jammed at the gate immediately in front of it. The
 *        server now says which, in words (`state_reason`), and this file
 *        renders those words — not just a colour. A colour-only distinction
 *        cannot be read out loud, and Konrad reads this screen on a phone.
 *   R66  There was no worker panel at all — unbuilt, not broken.
 *   R67  There was no queue panel at all — likewise.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO OBEY (R66, R67, N1)
 * ───────────────────────────────────────────────────────────────────────────
 * AN UNREACHABLE SOURCE RENDERS AS UNREACHABLE, NEVER AS ZERO.
 *
 * `workers` and `queues` are discriminated unions on `ok`
 * (`../api-business.ts`), deliberately, so that the failure case cannot be
 * read without acknowledging it. When `ok` is false this file prints the
 * upstream message VERBATIM and no number whatsoever. There is no `?? 0` and
 * no `catch {}` in this file, and neither may be added: a zero from a dead
 * probe is how a stuck pipeline looks calm.
 *
 * `depth: null` under `ok: true` is a different fact and is rendered
 * differently. Every BullMQ `wait`/`active`/`delayed`/`paused` key on this box
 * answers redis `TYPE` with `none` — the key does not exist, because redis
 * deletes a list or zset the moment it becomes empty. So for a SUCCESSFUL
 * probe, absent IS empty, and `0` is the honest render (measured, and argued
 * in phase5/pipeline-api-evidence.md §3e). Under `ok: false` there is no
 * number to show at all.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN IS ACTUALLY FOR (phase0/S-C-content-forge-state.md §4)
 * ───────────────────────────────────────────────────────────────────────────
 * The five stalled jobs are NOT a worker failure. All four Content Forge
 * workers have been online for over a week with zero restarts, and the
 * orchestrator is behaving exactly as written:
 * `dispatch-next.ts:24-25,169-238` explicitly REFUSES to dispatch
 * `AWAITING_QC` / `AWAITING_UPLOADER` — its own comment says "awaits VA
 * action". No worker will ever pick these up. They are waiting for a person
 * to claim them in `hub-web` (pm2 `hub-web`, online, port 3000).
 *
 * So the honest sentence on this screen is "waiting on a human, oldest 14
 * days" — not "queue depth is low". `HUMAN_GATE` below is how that gets said,
 * and it is keyed off `status`, which the payload does carry.
 *
 * WHAT THIS SCREEN CANNOT SAY, and says so instead of guessing:
 * `GET /api/pipeline` does not publish `content_jobs.assigned_production_va_id`
 * or `assigned_uploader_va_id`, so nothing here knows WHETHER a VA is
 * assigned. That was measured once, out of band (S-C §4: all five NULL on
 * 2026-08-18), and it is rendered as a dated note rather than as live text.
 * Inventing per-row assignment from a payload that has no assignment column is
 * exactly the class of confident-and-wrong this project exists to kill.
 *
 * Data source: `../api-business.ts` (this lane's client; `app/api.ts` is the
 * contended file and is not touched — 02-architecture.md §0.3). READ-ONLY
 * against Content Forge: this surface issues one GET and no writes (R68).
 */

import { useMemo } from "react";
import { tokens } from "../tokens";
import { useQuery } from "@tanstack/react-query";
import {
  fetchPipelineBusiness,
  type BusinessPipelineCard,
  type BusinessPipelinePhase,
  type BusinessPipelineResponse,
  type QueueDepth,
  type QueueSetDepth,
  type WorkerHealth,
} from "../api-business";

const PHASE_COLOR: Record<string, string> = {
  idea: tokens.info,
  script: tokens.accent,
  voice: tokens.decide,
  assets: tokens.warn,
  qc: tokens.stuck,
  render: tokens.accent,
  publish: tokens.ok,
  other: tokens.textMuted,
};

/**
 * Statuses no worker will ever dispatch, so the only thing that can move them
 * is a human opening `hub-web`. Verbatim from
 * `/opt/content-forge/apps/worker-orchestrator/src/utils/dispatch-next.ts:24-25`
 * ("awaits VA action") and its `169-238` refusal block.
 *
 * This is a property of the STATUS, not of the row — which is why it is safe
 * to derive client-side from a payload that carries `status` and nothing about
 * assignment. `db/pipeline.ts`'s `qc` bucket matches a bare `AWAITING`, so
 * every human-gate status in the live schema begins with it.
 */
const HUMAN_GATE = /^AWAITING_/;

const isHumanGate = (status: string): boolean => HUMAN_GATE.test(status);

/** The one place the S-C measurement of VA assignment is quoted, with its date
 *  attached — because an undated measurement rots into a claim. */
const ASSIGNMENT_NOTE =
  "This screen cannot tell you who is assigned: GET /api/pipeline does not " +
  "publish content_jobs.assigned_production_va_id / assigned_uploader_va_id. " +
  "Measured once, 2026-08-18: all five were NULL (phase0 S-C §4).";

/**
 * pm2 uptime, in the units a person thinks in. `null` is NOT zero and never
 * renders as a duration: pm2 reports no start time for a process it is not
 * running, and "0s" would read as "just restarted" — the opposite of "not
 * running", and the more alarming of the two in the wrong direction.
 */
function formatUptime(ms: number | null): string {
  if (ms === null) return "no start time reported";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** `2026-08-18T19:59:52.343Z` → `2026-08-18 19:59:52Z`, for a header line. */
const asOf = (iso: string): string =>
  `${iso.replace("T", " ").slice(0, 19)}Z`;

export function PipelineSurface() {
  const q = useQuery<BusinessPipelineResponse, Error>({
    queryKey: ["business", "pipeline"],
    queryFn: fetchPipelineBusiness,
    refetchInterval: 10_000,
    retry: 1,
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "12px 22px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 500, color: tokens.textHi }}>
          Pipeline
        </span>
        <span className="mono" style={{ fontSize: 11, color: tokens.textFaint }}>
          Content Forge · content_jobs · ~40 statuses → 7 phases
        </span>
        {q.data && (
          <span className="mono" style={{ fontSize: 11, color: tokens.textMuted }}>
            {q.data.total} active jobs · {q.data.stalled_total} stalled · stall
            threshold {q.data.stall_threshold_hours}h · probed{" "}
            {asOf(q.data.as_of)}
          </span>
        )}
        {q.isFetching && (
          <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
            refreshing…
          </span>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          minHeight: 0,
        }}
      >
        {q.isPending && (
          <div
            className="mono"
            style={{ fontSize: 11, color: tokens.textFaint, padding: 16 }}
          >
            loading pipeline…
          </div>
        )}

        {/* N1 — the fetch failing renders as a failure, with the message. Not
            as seven calm empty columns, which is what a `?? []` would draw. */}
        {q.isError && (
          <div
            style={{
              padding: "12px 15px",
              background: tokens.dangerActionBg,
              border: `1px solid ${tokens.dangerActionBorder}`,
              borderRadius: 9,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: tokens.bleed }}>
              Pipeline unavailable — nothing on this screen is current.
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
                fontSize: 11.5,
                color: tokens.textMuted,
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              Deliberately blank rather than zero. Seven empty columns would be
              indistinguishable from an idle factory.
            </div>
          </div>
        )}

        {q.data && (
          <>
            <StallSummary data={q.data} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(300px, 1fr) minmax(420px, 1.35fr)",
                gap: 12,
                alignItems: "stretch",
              }}
            >
              <WorkerStrip workers={q.data.workers} />
              <QueuePanel queues={q.data.queues} />
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "stretch",
                minHeight: 340,
              }}
            >
              {q.data.phases.map((p) => (
                <PhaseColumn
                  key={p.key}
                  phase={p}
                  thresholdHours={q.data.stall_threshold_hours}
                />
              ))}
            </div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textGhost, lineHeight: 1.6 }}
            >
              counts are true totals from content_jobs (a GROUP BY over every
              matching row), not the length of the card preview · cards capped
              at {q.data.card_limit_per_phase} per phase · card query scanned{" "}
              {q.data.card_rows_scanned} of {q.data.card_query_limit} rows ·
              stall cutoff {asOf(q.data.stall_cutoff)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ===========================================================================
 * THE HEADLINE. R64's "unmistakable at a glance" is answered here first, and
 * repeated per card — a stall that only appears on the card requires scrolling
 * seven columns to find.
 * ========================================================================= */

function StallSummary({ data }: { data: BusinessPipelineResponse }) {
  const gate = useMemo(() => {
    // STALLED *and* at a human gate. Filtering on the gate alone put "6 of
    // them are waiting on a human" under a headline reading "5 of 6 jobs have
    // not moved" — the stub's fresh job is also AWAITING_QC, so it counted
    // itself into a sentence about the stalled ones. Caught by the flip test
    // (phase5/flip-test.md), which is precisely what it is for: against live
    // data every gate card is stalled, so the two filters are indistinguishable
    // and the bug is invisible.
    const cards = data.phases
      .flatMap((p) => p.cards)
      .filter((c) => c.stalled && isHumanGate(c.status));
    const statuses = [...new Set(cards.map((c) => c.status))].sort();
    const oldest = cards.reduce(
      (max, c) => (c.stall_days > max ? c.stall_days : max),
      0,
    );
    return { cards, statuses, oldest };
  }, [data.phases]);

  const previewTruncated = data.phases.some((p) => p.cards_truncated);

  if (data.stalled_total === 0) {
    return (
      <div
        style={{
          padding: "11px 14px",
          background: tokens.okActionBg,
          border: `1px solid ${tokens.okActionBorder}`,
          borderRadius: 9,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: tokens.ok }}>
          Nothing stalled — every one of {data.total} jobs changed status inside
          the last {data.stall_threshold_hours}h.
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: tokens.textMuted,
            marginTop: 5,
            lineHeight: 1.5,
          }}
        >
          Measured against the server's own cutoff, {asOf(data.stall_cutoff)}.
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "11px 14px",
        background: tokens.freezeBgWarn,
        border: `1px solid ${tokens.freezeBorderWarn}`,
        borderRadius: 9,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: tokens.warn }}>
        {data.stalled_total} of {data.total} jobs have not moved in over{" "}
        {data.stall_threshold_hours}h
        {gate.oldest > 0 ? ` — oldest ${gate.oldest} days` : ""}.
      </div>
      {gate.cards.length > 0 && (
        <div
          style={{
            fontSize: 12,
            color: tokens.textBody,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: tokens.textHi }}>
            {gate.cards.length} of the stalled {gate.cards.length === 1 ? "job is" : "jobs are"}{" "}
            waiting on a human, not on a worker.
          </strong>{" "}
          {gate.statuses.join(" / ")} is never dispatched to any queue —
          dispatch-next.ts refuses it outright ("awaits VA action"), so no
          worker will ever pick these up however long they sit. They move when
          somebody claims them in <span className="mono">hub-web</span> (pm2{" "}
          <span className="mono">hub-web</span>, port 3000).
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: tokens.textMuted,
          marginTop: 6,
          lineHeight: 1.5,
        }}
      >
        {ASSIGNMENT_NOTE}
        {previewTruncated
          ? " Ages are the oldest across the cards this response carries; at least one phase is truncated, so an older job may exist."
          : ""}
      </div>
    </div>
  );
}

/* ===========================================================================
 * R66 — WORKER HEALTH. Four Content Forge processes, or the reason there is no
 * answer. Never both, never neither.
 * ========================================================================= */

function WorkerStrip({ workers }: { workers: BusinessPipelineResponse["workers"] }) {
  if (!workers.ok) {
    return (
      <Panel title="WORKERS" tone="error">
        <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.bleed }}>
          worker health unavailable: {workers.error}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            color: tokens.textMuted,
            marginTop: 6,
            lineHeight: 1.6,
          }}
        >
          nothing is known about: {workers.expected.join(", ")}
        </div>
        <div
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          Not "0 online" and not "healthy" — the probe failed, so this panel has
          no number to report. Probed {asOf(workers.as_of)}.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="WORKERS"
      tone={workers.missing.length > 0 ? "warn" : "plain"}
      meta={`${workers.online}/${workers.expected.length} online · pm2 jlist · ${asOf(workers.as_of)}`}
    >
      {workers.missing.length > 0 && (
        <div
          style={{
            fontSize: 11.5,
            color: tokens.warn,
            marginBottom: 7,
            lineHeight: 1.5,
          }}
        >
          pm2 has never heard of {workers.missing.join(", ")} — absent is not the
          same as stopped.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {workers.workers.map((w) => (
          <WorkerRow key={w.name} worker={w} />
        ))}
      </div>
    </Panel>
  );
}

function WorkerRow({ worker }: { worker: WorkerHealth }) {
  const online = worker.status === "online";
  const tone = online ? tokens.ok : tokens.bleed;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flex: "none",
          background: tone,
        }}
      />
      <span className="mono" style={{ fontSize: 11.5, color: tokens.textLabel }}>
        {worker.name}
      </span>
      <span className="mono" style={{ fontSize: 10.5, color: tone }}>
        {worker.status}
      </span>
      <span style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
        up {formatUptime(worker.uptime_ms)}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          color: worker.restarts > 0 ? tokens.warn : tokens.textGhost,
        }}
      >
        {worker.restarts} restarts
      </span>
    </div>
  );
}

/* ===========================================================================
 * R67 — QUEUE DEPTH. Eight BullMQ queues × six sets, or the reason there is no
 * answer.
 * ========================================================================= */

function QueuePanel({ queues }: { queues: BusinessPipelineResponse["queues"] }) {
  if (!queues.ok) {
    return (
      <Panel title="QUEUES" tone="error">
        <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.bleed }}>
          queue not reachable: {queues.error}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 6 }}
        >
          endpoint {queues.endpoint} · probed {asOf(queues.as_of)}
        </div>
        <div
          style={{
            fontSize: 11,
            color: tokens.textMuted,
            marginTop: 6,
            lineHeight: 1.5,
          }}
        >
          No depths are shown, because none were read. A row of zeroes here
          would be indistinguishable from a queue that is genuinely empty.
        </div>
      </Panel>
    );
  }

  const sets = setOrder(queues.queues);
  // 74px per set column, measured: at 52px the header words COMPLETED and
  // FAILED collided into "FAILEDCOMPLETED" in the first live shot. A header a
  // reader has to disentangle is a mislabelled number.
  const columns = `minmax(130px, 1fr) repeat(${sets.length}, 74px)`;

  return (
    <Panel
      title="QUEUES"
      tone="plain"
      meta={`${queues.probed_queues} queues · redis ${queues.endpoint} · ${asOf(queues.as_of)}`}
    >
      <div style={{ display: "grid", gridTemplateColumns: columns, rowGap: 3 }}>
        <span />
        {sets.map((s) => (
          <span
            key={s}
            className="mono"
            style={{
              fontSize: 9,
              color: tokens.textFaint,
              letterSpacing: "0.06em",
              textAlign: "right",
            }}
          >
            {s.toUpperCase()}
          </span>
        ))}
        {queues.queues.map((qu) => (
          <QueueRow key={qu.queue} queue={qu} sets={sets} />
        ))}
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: tokens.textMuted,
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        A `0` here was read from a live redis: every wait/active/delayed/paused
        key is absent, and redis deletes a list or zset the instant it empties,
        so absent is empty. Hover any cell for the key and its redis TYPE.
      </div>
    </Panel>
  );
}

/** Set names in the order the server sent them, deduplicated across queues —
 *  never a hardcoded list, so a new BullMQ set appears instead of vanishing. */
function setOrder(queues: QueueDepth[]): string[] {
  const seen: string[] = [];
  for (const q of queues) {
    for (const s of q.sets) if (!seen.includes(s.set)) seen.push(s.set);
  }
  return seen;
}

function QueueRow({ queue, sets }: { queue: QueueDepth; sets: string[] }) {
  return (
    <>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          color: tokens.textLabel,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={queue.queue}
      >
        {queue.queue.replace(/^queue-/, "")}
      </span>
      {sets.map((name) => {
        const cell = queue.sets.find((s) => s.set === name);
        if (cell === undefined) {
          return (
            <span
              key={name}
              className="mono"
              style={{ fontSize: 10.5, color: tokens.textGhost, textAlign: "right" }}
              title={`${queue.queue} was probed without a "${name}" set — no reading exists`}
            >
              –
            </span>
          );
        }
        const d = depthCell(cell);
        return (
          <span
            key={name}
            className="mono"
            style={{ fontSize: 10.5, color: d.tone, textAlign: "right" }}
            title={d.title}
          >
            {d.text}
          </span>
        );
      })}
    </>
  );
}

/**
 * The three cases a single depth reading can be in, under a SUCCESSFUL probe.
 * The union in api-business.ts means this function is only ever reached with
 * `ok: true`, which is the whole reason it may render `0` at all.
 */
function depthCell(s: QueueSetDepth): { text: string; tone: string; title: string } {
  if (s.depth !== null) {
    const hot = s.depth > 0 && (s.set === "failed" || s.set === "wait");
    return {
      text: String(s.depth),
      tone: hot ? tokens.warn : s.depth > 0 ? tokens.textHi : tokens.textFaint,
      title: `${s.key} · redis TYPE ${s.redis_type} · depth ${s.depth}`,
    };
  }
  if (s.redis_type === "none") {
    return {
      text: "0",
      tone: tokens.textFaint,
      title:
        `${s.key} does not exist. Redis deletes a list or zset the moment it ` +
        `becomes empty, so for a BullMQ set absent IS empty. Read with TYPE, ` +
        `not with LLEN — LLEN would have returned 0 for an unreachable key too.`,
    };
  }
  return {
    text: `${s.redis_type}?`,
    tone: tokens.warn,
    title:
      `${s.key} holds redis TYPE ${s.redis_type}, which has no countable ` +
      `depth. Not zero — uncountable.`,
  };
}

/* ===========================================================================
 * PANEL CHROME — shared by the two strips so a failed probe and a healthy one
 * occupy the same slot on the screen, at the same size.
 * ========================================================================= */

function Panel({
  title,
  tone,
  meta,
  children,
}: {
  title: string;
  tone: "plain" | "warn" | "error";
  meta?: string;
  children: React.ReactNode;
}) {
  const background =
    tone === "error"
      ? tokens.dangerActionBg
      : tone === "warn"
        ? tokens.freezeBgWarn
        : tokens.bgCard;
  const border =
    tone === "error"
      ? tokens.dangerActionBorder
      : tone === "warn"
        ? tokens.freezeBorderWarn
        : tokens.border;
  return (
    <div
      style={{
        background,
        border: `1px solid ${border}`,
        borderRadius: 9,
        padding: "10px 13px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 9,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: tokens.textFaint,
            letterSpacing: "0.12em",
          }}
        >
          {title}
        </span>
        {meta !== undefined && (
          <span className="mono" style={{ fontSize: 9.5, color: tokens.textGhost }}>
            {meta}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/* ===========================================================================
 * R65 — THE COLUMNS. Two empty columns, two different sentences.
 * ========================================================================= */

/** Per-state treatment. `label` is the word in the empty column; `state_reason`
 *  from the server is the sentence, and it is rendered for EVERY phase — a
 *  colour alone cannot be read aloud or quoted in a message to a VA. */
const STATE: Record<
  BusinessPipelinePhase["state"],
  { label: string; ink: string; bg: string; border: string }
> = {
  has_work: {
    label: "IN FLIGHT",
    ink: tokens.textMuted,
    bg: tokens.bgGutter,
    border: tokens.borderSoft,
  },
  no_work_idle: {
    label: "NO WORK · IDLE",
    ink: tokens.textFaint,
    bg: tokens.bgGutter,
    border: tokens.borderSoft,
  },
  no_work_blocked_upstream: {
    label: "EMPTY · BLOCKED UPSTREAM",
    ink: tokens.warn,
    bg: tokens.freezeBgWarn,
    border: tokens.freezeBorderWarn,
  },
};

function PhaseColumn({
  phase,
  thresholdHours,
}: {
  phase: BusinessPipelinePhase;
  thresholdHours: number;
}) {
  const color = PHASE_COLOR[phase.key] ?? tokens.textMuted;
  const state = STATE[phase.state];
  return (
    <div
      style={{
        // All seven phases must be on screen at once, because R65's whole point
        // is the CONTRAST between two empty columns — and in the first live
        // shot (1600px viewport) Render and Publish, the two
        // `no_work_blocked_upstream` columns, were off the right edge behind a
        // horizontal scrollbar. Shrink to fit rather than scroll; 268px is the
        // ceiling on a wide monitor, 176px the floor before the sentences stop
        // being readable.
        flex: "1 1 0",
        minWidth: 176,
        maxWidth: 268,
        background: tokens.bgCard,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${tokens.borderDivider}`,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{ width: 4, height: 14, background: color, borderRadius: 2 }}
          />
          <span style={{ fontSize: 13, fontWeight: 500, color: tokens.textHi }}>
            {phase.label}
          </span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color,
              border: `1px solid ${tokens.borderEmphasis}`,
              borderRadius: 5,
              padding: "1px 6px",
            }}
            title="true count of matching jobs in content_jobs, not the number of cards below"
          >
            {phase.count} {phase.count === 1 ? "job" : "jobs"}
          </span>
          {phase.stalled_count > 0 && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: tokens.warn,
                background: tokens.freezeBgWarn,
                border: `1px solid ${tokens.freezeBorderWarn}`,
                borderRadius: 5,
                padding: "1px 6px",
              }}
              title={`no status change in over ${thresholdHours}h`}
            >
              {phase.stalled_count} stalled
            </span>
          )}
        </div>
        <div className="mono" style={{ fontSize: 10, color: tokens.textFaint }}>
          {phase.description}
        </div>
        {/* R65 — the sentence, always. This is the half a colour cannot do. */}
        <div
          style={{
            fontSize: 11,
            color: state.ink,
            background: state.bg,
            border: `1px solid ${state.border}`,
            borderRadius: 6,
            padding: "5px 7px",
            lineHeight: 1.45,
          }}
        >
          {phase.state_reason}
        </div>
        {phase.cards_truncated && (
          <div className="mono" style={{ fontSize: 9.5, color: tokens.warn }}>
            showing {phase.cards.length} of {phase.count} — the rest are counted,
            not drawn
          </div>
        )}
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          minHeight: 90,
        }}
      >
        {phase.cards.length === 0 ? (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: state.ink,
              letterSpacing: "0.08em",
              textAlign: "center",
              padding: "18px 6px",
              border: `1px dashed ${state.border}`,
              borderRadius: 7,
            }}
          >
            {state.label}
          </div>
        ) : (
          phase.cards.map((c) => (
            <JobCard
              key={c.id}
              card={c}
              color={color}
              thresholdHours={thresholdHours}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ===========================================================================
 * R64 — THE CARD. A stalled job and a fresh job differ in WORDS, in COLOUR and
 * in WEIGHT. The flip test (phase5/flip-test.md) photographs both in one shot:
 * without the fresh half, an assertion that five stuck jobs render stalled also
 * passes on a component that marks everything stalled.
 * ========================================================================= */

function JobCard({
  card,
  color,
  thresholdHours,
}: {
  card: BusinessPipelineCard;
  color: string;
  thresholdHours: number;
}) {
  const gate = isHumanGate(card.status);
  return (
    <div
      style={{
        background: card.stalled ? tokens.freezeBgWarn : tokens.bgBody,
        border: `1px solid ${card.stalled ? tokens.freezeBorderWarn : tokens.border}`,
        borderLeft: card.stalled
          ? `3px solid ${tokens.warn}`
          : `1px solid ${tokens.border}`,
        borderRadius: 7,
        padding: "9px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          className="mono"
          style={{ fontSize: 9, color, letterSpacing: "0.06em" }}
        >
          {card.status}
        </span>
        <span style={{ flex: 1 }} />
        {card.stalled ? (
          <span
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: tokens.warn,
              background: tokens.freezeBgWarn,
              border: `1px solid ${tokens.freezeBorderWarn}`,
              borderRadius: 5,
              padding: "1px 6px",
              letterSpacing: "0.04em",
            }}
            title={`no status change since ${card.status_updated_at} — longer than the ${thresholdHours}h threshold`}
          >
            STALLED {card.stall_days}d
          </span>
        ) : (
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: tokens.ok,
              border: `1px solid ${tokens.okActionBorder}`,
              background: tokens.okActionBg,
              borderRadius: 5,
              padding: "1px 6px",
            }}
            title={`status changed ${card.status_updated_at}, inside the ${thresholdHours}h threshold`}
          >
            moving · {card.age}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 12,
          color: tokens.textSoft,
          lineHeight: 1.4,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {card.title}
      </div>
      {gate && (
        <div
          style={{
            fontSize: 10.5,
            color: tokens.warn,
            lineHeight: 1.45,
          }}
          title='no worker will take this: dispatch-next.ts:24-25 — "awaits VA action". A human claims it in hub-web on port 3000.'
        >
          waiting on a human · hub-web :3000
        </div>
      )}
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          color: tokens.textMuted,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>{card.format}</span>
        <span style={{ color: tokens.textFaint }}>·</span>
        <span>{card.channel}</span>
      </div>
    </div>
  );
}
