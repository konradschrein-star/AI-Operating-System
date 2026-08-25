"use client";

/**
 * LIVE SESSIONS — the block pinned above the team tree.
 *
 * Konrad, 2026-08-25: "Sidebar still looks like shit and doesn't give me any
 * intel on what is being worked on properly as I need it. I need to see the
 * claude/agy/codex sessions doing work." One row per live session answers the
 * four questions in his order:
 *
 *     ● claude   opus-5                                4m 12s
 *       client: live strip, badge, density      Bash · 8s
 *       └ WHO/WHAT ─────────────────────────────┘ └ doing ┘
 *
 * WHO is the row itself (its status dot, its title), ON WHICH ENGINE is the
 * badge, ON WHAT is the task title, and FOR HOW LONG is the elapsed column.
 * The activity carries ITS OWN AGE so a value frozen four minutes ago can never
 * read as "now".
 *
 * ── ZERO NEW REQUESTS ────────────────────────────────────────────────────────
 * It renders the SAME `TeamResponse` the panel already holds, passed down as a
 * prop. No `useQuery`, no fetch, no import of ./teamApi's fetchers — the chat
 * surface has a committed 40 req/min ceiling (../chat/pollBudget.ts) and this
 * block costs nothing against it. The only subscription it takes is the shared
 * 1s tick, and only when there is something live to tick.
 *
 * ── IT IS READ-ONLY, AND THAT IS STRUCTURAL ─────────────────────────────────
 * No ⏸, no ✕, no restore. Every destructive verb stays in ./TeamRow, behind the
 * arming machine and the cascade guard that took several rounds to get right.
 * There is no POST in this file, so a second copy of those controls cannot
 * drift out of step with the first — and the block that always shows the
 * RUNNING rows is the last place a mis-aimed click should be able to land.
 *
 * ── DENSITY ─────────────────────────────────────────────────────────────────
 * Two lines per row, on the same rhythm as ./TeamRow: line 1 is identity
 * (dot · engine · model · elapsed), line 2 is work (title · activity). Every
 * column that can change length between polls is fixed-width, so the block
 * never wobbles as the numbers count and the eye can scan straight down the
 * elapsed column. All colour is `tokens.*`; no literal of any notation appears
 * here (NFU1), so both themes are the same code path.
 */

import { memo, type CSSProperties } from "react";
import { tokens, dot } from "../../tokens";
import { isModelAlias, modelDisplay } from "../live/agentsApi";
import { engineBadge, type EngineTokenName } from "./engineBadge";
import {
  activityText,
  countLiveSessions,
  selectLiveSessions,
  type LiveSessionRow,
} from "./liveSessions";
import { fmtWorkingTime, type TeamNode, type TeamResponse } from "./teamApi";
import { useTick } from "./tickStore";

const EM_DASH = "—";

/* ── Colour ───────────────────────────────────────────────────────────────
 *
 * ./engineBadge and ./liveSessions decide which NAME a value wears; this is
 * the only place a name becomes a colour. Same split ./TeamRow.tsx and
 * ../live/AgentActivity.tsx use, and it is what keeps the two pure modules
 * importable by the check script.
 */

const ENGINE_COLOR: Record<EngineTokenName, string> = {
  accent: tokens.accent,
  decide: tokens.decide,
  textMuted: tokens.textMuted,
  textGhost: tokens.textGhost,
};

/** The same status vocabulary ./TeamRow renders, for the same reason: `stuck`
 *  must never read as `running`. Only the non-settled statuses can appear here
 *  — a settled node is not a live session — but the map stays complete so a
 *  status that stops being terminal does not fall through to a colour that
 *  means "unclassified". */
const STATUS_COLOR: Record<string, string> = {
  running: tokens.info,
  queued: tokens.textMuted,
  planned: tokens.textMuted,
  paused: tokens.warn,
  stuck: tokens.stuck,
  done: tokens.ok,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? tokens.textFaint;
}

/** The model column reads LOUDER here than in the tree. In the tree the model
 *  is a supporting detail beside the role and the description; in this block it
 *  is one of the five facts Konrad asked for, so a resolved id gets
 *  `textSecondary` rather than `textFaint`. An alias still renders fainter than
 *  a resolved id — the colour IS the statement that we know less about this
 *  row's model (the rule ../live/agentsApi's `isModelAlias` exists for). */
function modelColor(model: string | null): string {
  if (model === null) return tokens.textGhost;
  return isModelAlias(model) ? tokens.textFaint : tokens.textSecondary;
}

/* ── Layout constants ─────────────────────────────────────────────────────
 *
 * Fixed everywhere a value can change length between polls, so no column
 * wobbles as a clock counts up. The panel is 260px by default and draggable
 * down to 200px (../ChatSurface.tsx `SidePanel`), so only ONE column flexes per
 * line and everything else is bounded.
 */

const ROW_PAD_X = 8;
/** Fits "claude" at 9px mono with the pill's padding and border. An unknown
 *  engine's raw string may be longer and is capped by `ENGINE_MAX`, ellipsised,
 *  with the full string in the title. */
const ENGINE_COL = 46;
const ENGINE_MAX = 78;
/** The same width the tree's time column uses, so the two zones' right edges
 *  line up when they are stacked. */
const TIME_COL = 50;
/** The activity cell's CEILING. An `assistant_text` activity is prose, and
 *  unbounded it reads as a second title and crowds out the first — the task
 *  title is the answer to "ON WHAT", which Konrad asked for before "what is it
 *  doing". The full text is in the cell's own `title`. */
const ACTIVITY_MAX = 96;
/** Fits "1h 04m" — the widest thing `fmtWorkingTime` produces below a day. */
const AGE_COL = 40;

/** How tall the block may grow before it scrolls instead of pushing the tree
 *  off the panel. Five two-line rows; a sixth is one scroll away. The tree
 *  below keeps its own space and the PLAN splitter is untouched. */
const LIST_MAX_HEIGHT = 172;

const HEADER_LABEL_STYLE: CSSProperties = {
  fontSize: 9,
  color: tokens.textFaint,
  letterSpacing: "0.1em",
};

const CELL_TIME_STYLE: CSSProperties = {
  color: tokens.textSecondary,
  minWidth: TIME_COL,
  textAlign: "right",
  flex: "none",
  fontSize: 10.5,
  fontVariantNumeric: "tabular-nums",
};

/* ── One row ─────────────────────────────────────────────────────────────── */

interface LiveRowProps {
  row: LiveSessionRow;
  onOpenNode: (node: TeamNode) => void;
}

function LiveSessionRowViewImpl({ row, onOpenNode }: LiveRowProps) {
  const n = row.node;
  const badge = engineBadge(row.engine, row.engineGap);
  /* The same rule the tree uses (./TeamRow): a worker or a sub-agent drills in;
   * the manager row IS the chat you are looking at, so opening it would
   * navigate to where you already are. A row that looks clickable and does
   * nothing is worse than one that does not look clickable. */
  const clickable = n.kind === "worker" || n.kind === "subagent";

  /* WHAT IT IS DOING, AND HOW OLD THAT IS — always both.
   *
   * The rollup flushes `current_activity` only when an event arrives and
   * throttles to one write per 2s, so the stored value was stale on 108 of 158
   * comparable poll samples (68.4%); 70 of those 108 stale samples (64.8% of
   * the staleness) were a `tool_call` served while the true state was
   * `tool_result`. Two figures over two different denominators — 158 is the
   * comparable base, 108 is the stale count — never one derived from the
   * other. One instrument, one run of it,
   * provenance and the explicit "not independently reproduced" caveat in
   * `evidence/aios-sidebar-live-sessions/activity-truth.md` §6. The age is what
   * makes that visible instead of silently wrong: a label alone re-reads as
   * "now" forever. `null` age prints
   * the em dash rather than "0s" — an unstamped activity has no age, and
   * claiming zero would be the same class of lie as a ticking settled clock. */
  const activity = row.activity;
  const activityLabel = activity === null ? EM_DASH : activityText(activity);
  const ageLabel =
    row.activityAgeMs === null ? EM_DASH : fmtWorkingTime(row.activityAgeMs);
  const activityTitle =
    activity !== null
      ? `${activity.kind}${activity.tool !== null ? ` · ${activity.tool}` : ""} — ` +
        `last stamped ${row.activityAgeMs === null ? "at an unreadable time" : `${ageLabel} ago`}. ` +
        "The engine writes this value only when an event arrives, so it can lag " +
        "the agent by a few seconds; the age beside it is how you can tell." +
        (activity.text !== null ? `\n\n${activity.text}` : "")
      : row.activityGap === "not-served"
        ? "activity not reported — this console is newer than the API answering " +
          "it, and that response carries no activity field at all."
        : "no activity recorded yet — this run has not emitted an event the " +
          "rollup could stamp. Not idle: unmeasured.";

  return (
    <div
      data-live-row
      data-node-id={n.id}
      data-engine={badge.attr}
      data-status={n.status}
      data-activity-kind={activity?.kind ?? "none"}
      title={
        `${row.title ?? "(no title)"} · ${n.status} · ${n.model ?? "model n/a"}` +
        `\n${badge.title}`
      }
      onClick={clickable ? () => onOpenNode(n) : undefined}
      style={{
        padding: `4px ${ROW_PAD_X}px`,
        borderBottom: `1px solid ${tokens.borderDivider}`,
        cursor: clickable ? "pointer" : "default",
        fontSize: 11,
      }}
    >
      {/* line 1 — WHO and ON WHICH ENGINE … FOR HOW LONG */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Filled and pulsing only for `running`; every other live status is a
            flat dot in its own colour, so "queued" and "stuck" cannot be
            mistaken for work in progress at a glance. */}
        <span style={dot(statusColor(n.status), n.status === "running")} />
        <span
          data-live-engine={badge.attr}
          className="mono"
          title={badge.title}
          style={{
            color: ENGINE_COLOR[badge.tokenName],
            border: `1px solid ${badge.known ? tokens.border : tokens.borderSoft}`,
            borderRadius: 3,
            padding: "0 4px",
            minWidth: ENGINE_COL,
            maxWidth: ENGINE_MAX,
            flex: "none",
            textAlign: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 9,
            letterSpacing: "0.04em",
            boxSizing: "border-box",
          }}
        >
          {badge.label}
        </span>
        <span
          data-live-model={n.model === null ? "none" : n.model}
          className="mono"
          title={n.model ?? "model not recorded for this run"}
          style={{
            color: modelColor(n.model),
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 9.5,
          }}
        >
          {n.model === null ? "model n/a" : modelDisplay(n.model)}
        </span>
        {/* FOR HOW LONG. `null` prints "—", never "0s": null means the server
            could not measure this node's work, and "0s" would claim it
            measured zero. The interpolation is ./teamRows' policy, unchanged —
            this cell re-derives none of it. */}
        <span data-live-elapsed className="mono" style={CELL_TIME_STYLE}>
          {fmtWorkingTime(row.elapsedMs)}
        </span>
      </div>

      {/* line 2 — ON WHAT … and what it is doing right now, with its age */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          marginTop: 2,
          paddingLeft: 13,
        }}
      >
        <span
          data-live-title
          style={{
            color: tokens.textLabel,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
          }}
        >
          {row.title ?? EM_DASH}
        </span>
        {/* THE AGE IS ITS OWN CELL, and this is not cosmetic.
            It started inside the label's span, and the first real render showed
            what that costs: an `assistant_text` activity is prose, the span
            ellipsised, and the ellipsis ate the age — so the two rows whose
            value was most likely to be stale were the two that printed no age
            at all. A fixed-width sibling cannot be clipped by its neighbour's
            overflow, so the age is now unconditional by construction rather
            than by luck of string length. */}
        <span
          data-live-activity
          className="mono"
          title={activityTitle}
          style={{
            color: activity === null ? tokens.textGhost : tokens.textMuted,
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: ACTIVITY_MAX,
            textAlign: "right",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 9.5,
          }}
        >
          {activityLabel}
        </span>
        <span
          data-live-activity-age
          className="mono"
          title={activityTitle}
          style={{
            color: tokens.textFaint,
            flex: "none",
            minWidth: AGE_COL,
            textAlign: "right",
            whiteSpace: "nowrap",
            fontSize: 9.5,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {"· "}
          {ageLabel}
        </span>
      </div>
    </div>
  );
}

/** Memoized on a shallow compare. `row` is a fresh object every tick by
 *  construction (the selector recomputes elapsed and age from `now`), so this
 *  bails out only when the panel re-renders for a reason that did not move the
 *  clock — a project switch, a dismissal, a capabilities answer. That is the
 *  honest limit of memo here, and it is affordable: the block is bounded by the
 *  number of LIVE sessions (typically under ten), never by the tree, which is
 *  where round 1302's 165-row re-render problem actually lived. */
const LiveSessionRowView = memo(LiveSessionRowViewImpl);

/* ── The block ───────────────────────────────────────────────────────────── */

interface LiveSessionsBodyProps {
  data: TeamResponse;
  onOpenNode: (node: TeamNode) => void;
}

/**
 * The rows, and THE ONLY SUBSCRIBER to the 1s tick in this file.
 *
 * It is a separate component from the block below so that a chat whose tree has
 * fully settled mounts no subscriber at all — `countLiveSessions` answers that
 * without a clock, and a settled panel therefore costs zero timers and zero
 * re-renders per second. Same discipline as the team poll, which stops when
 * `isTreeSettled`.
 *
 * The selector runs per tick rather than per poll because elapsed and activity
 * age are both functions of `now`. It walks a tree measured at 165 nodes and
 * allocates one object per LIVE node — microseconds, once a second, against a
 * panel that already re-renders wholesale every 10s poll.
 */
function LiveSessionsBody({ data, onOpenNode }: LiveSessionsBodyProps) {
  const nowMs = useTick();
  const rows = selectLiveSessions(data, nowMs);

  /* A tree that reported live nodes a tick ago and none now is not a bug and
     not a blank: the poll simply landed between the two renders. Say so. */
  if (rows.length === 0) return <EmptyNote />;

  return (
    <div
      data-live-sessions-list
      style={{ maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
    >
      {rows.map((row) => (
        <LiveSessionRowView key={row.node.id} row={row} onOpenNode={onOpenNode} />
      ))}
    </div>
  );
}

/** One muted line, in the panel's own vocabulary for "a fact about this zone
 *  that is not a row" (./ChatTeamPanel's `Note`). Nothing running is a real
 *  answer to Konrad's question and it is stated, not left as an empty box the
 *  reader has to interpret as either "idle" or "broken". */
function EmptyNote() {
  return (
    <div
      data-live-sessions-empty
      className="mono"
      style={{
        padding: "6px 10px",
        fontSize: 10,
        color: tokens.textMuted,
        lineHeight: 1.5,
      }}
    >
      nothing running — every agent in this chat has settled
    </div>
  );
}

export interface LiveSessionsStripProps {
  /** The team response the panel already has. `undefined` while it loads or
   *  after it failed — the block renders NOTHING in either case, because the
   *  panel's own loading and error notes already say which of the two it is,
   *  and a second voice saying "nothing running" over a dead API would be the
   *  silent lie this panel exists to remove. */
  data: TeamResponse | undefined;
  onOpenNode: (node: TeamNode) => void;
}

/**
 * The LIVE SESSIONS block. Header plus rows, pinned above the team tree.
 *
 * `countLiveSessions` is read HERE, before the body mounts: it is the number
 * the header prints AND the test for whether the ticking subtree is mounted at
 * all, so a settled chat costs this block no timer — see `LiveSessionsBody`.
 */
export function LiveSessionsStrip({ data, onOpenNode }: LiveSessionsStripProps) {
  if (data === undefined) return null;
  const live = countLiveSessions(data);

  return (
    <div
      data-live-sessions
      style={{
        flex: "none",
        borderBottom: `1px solid ${tokens.borderSoft}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "6px 10px 4px",
        }}
      >
        <span
          className="mono"
          title={
            "Every agent in this chat that is not settled — running, queued, " +
            "paused or stuck — one row each: which engine, which model, which " +
            "task, what it is doing right now, and for how long. Read from the " +
            "team response the panel already polls; it costs no extra request."
          }
          style={HEADER_LABEL_STYLE}
        >
          LIVE SESSIONS
        </span>
        <span style={{ flex: 1 }} />
        <span
          data-live-count={live}
          className="mono"
          title="agents in this chat that are not settled"
          style={{
            fontSize: 9.5,
            color: live > 0 ? tokens.textMuted : tokens.textGhost,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {live}
        </span>
      </div>
      {live > 0 ? (
        <LiveSessionsBody data={data} onOpenNode={onOpenNode} />
      ) : (
        <EmptyNote />
      )}
    </div>
  );
}

export default LiveSessionsStrip;
