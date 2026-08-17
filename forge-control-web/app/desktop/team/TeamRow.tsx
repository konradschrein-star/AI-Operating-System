"use client";

/**
 * One row of the team tree, and the two leaf components that own working time.
 *
 * ── Why the row is two lines ──────────────────────────────────────────────
 * The brief lists the row content left to right: status dot, kind badge, role,
 * model, description, tokens, working time. That is the reading order this
 * file implements — but not on one physical line. The Team panel lives in
 * ChatSurface's SidePanel, which is 260px wide (ChatSurface.tsx:305); seven
 * columns in 244px of content box gives every one of them about 34px, which
 * is not a column, it is a stub. So the row wraps after `model`:
 *
 *     ● session  builder  opus-5                        [stop] [✕]
 *       build the team panel              88.1k   4m 12s
 *
 * Read top-to-bottom, left-to-right, the order is exactly the briefed one.
 * The controls take the far right of line 1 in a fixed-width slot. Nothing
 * about this changes if round 503 widens the panel — every column is
 * `flex: none` with a min width and the description flexes.
 *
 * ── Settled rows show a FROZEN number, not a blank (U15 as amended) ───────
 * Two documents disagreed here and round 505 caught the code splitting the
 * difference, which satisfied neither. U15 read "finished rows show tokens +
 * model, NO time"; the project brief's Definition of Done #1 reads "a settled
 * run shows a FROZEN duration (settled_at - started_at) … no exceptions
 * anywhere in the panel". The previous code showed time on a settled MANAGER
 * and "—" on every other settled row — an exception no round had ratified.
 *
 * Resolved in favour of the brief, and ratified in the requirements corpus as
 * U15a (docs/plan/operator-visibility/12-ui-v3-requirements.md): **every settled row shows its
 * working time, frozen, and no settled row ticks.** Konrad's complaint was
 * that finished agents kept COUNTING UP, not that they showed a number — and
 * "how long did the builder take" is exactly the question a finished row is
 * there to answer. Hiding the number is information loss dressed as tidiness.
 * The freeze is structural, one paragraph down.
 *
 * ── Time truth, structurally (U15/U16) ────────────────────────────────────
 * Two leaves, and the difference is not a branch inside one component:
 * `FrozenTime` does not import `useTick` and therefore CANNOT tick, at any
 * clock, for any reason. `LiveTime` is the only subscriber to the 1s store in
 * this panel. The row picks between them on `node.settled`, so "a settled row
 * ticked" is not a bug that can be introduced by editing a condition — it
 * would take swapping the component.
 *
 * ── Hover (U17, NFU2) ─────────────────────────────────────────────────────
 * There is no pointer-enter handler, no pointer-leave handler and no hover
 * state in this file — the reviewer's grep for them comes back empty, which is
 * the point. The controls are mounted in every row, always, and revealed by the
 * `.team-row` rules in app/globals.css. They sit in a fixed-width slot, so the
 * reveal changes opacity and nothing else — no reflow, no re-render.
 *
 * ARMING moves no pixels either, which is a separate claim and was false until
 * round 506: the armed ✕ grew a 1px border, which grew line 1, which pushed
 * every row below it down 2px mid-gesture — and a pointer that had been over
 * the button ended up over the ROW, so the trailing click drilled into a run
 * instead. The idle ✕ now carries the same transparent border, the same
 * padding and a box wide enough for "sure?", so arming is a colour and a label
 * and nothing else (round 505 finding #4).
 */

import { createContext, memo, useContext, type CSSProperties } from "react";
import { tokens, dot } from "../../tokens";
import { RunShotsIndicator } from "../chat/BrowserShots";
import {
  isModelAlias,
  modelDisplay,
  roleLabel,
  roleTokenName,
  type RoleTokenName,
} from "../live/agentsApi";
import {
  SETTLED_STOP_TITLE,
  capabilityTitle,
  isSpuriousActivation,
  stopBlockReason,
} from "./confirm";
import { fmtTokens, fmtWorkingTime, type TeamNode } from "./teamApi";
import { interpolatedWorkingMs, type TeamRow } from "./teamRows";
import { useTick } from "./tickStore";

const EM_DASH = "—";

/* ── Colour ───────────────────────────────────────────────────────────────
 *
 * Every value below is a `tokens.*` reference; no literal colour of any
 * notation appears in this directory (NFU1). `roleTokenName` in agentsApi decides which
 * NAME a role wears — this is the only place the name becomes a colour, the
 * same split AgentActivity.tsx uses.
 */

const ROLE_COLOR: Record<RoleTokenName, string> = {
  decide: tokens.decide,
  info: tokens.info,
  accent: tokens.accent,
  warn: tokens.warn,
  textMuted2: tokens.textMuted2,
  ok: tokens.ok,
  textMuted: tokens.textMuted,
};

/** Status dot colours, exactly as briefed: running → info, planned/queued →
 *  textMuted, done/completed → ok, failed → bleed. The rest of the engine's
 *  status vocabulary gets the nearest honest token rather than being folded
 *  into one of the four — `stuck` in particular must not read as `running`. */
const STATUS_COLOR: Record<string, string> = {
  running: tokens.info,
  planned: tokens.textMuted,
  queued: tokens.textMuted,
  done: tokens.ok,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
  stuck: tokens.stuck,
  paused: tokens.warn,
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? tokens.textFaint;
}

/* ── Kind truth ───────────────────────────────────────────────────────────
 *
 * The question Konrad asked this project to answer on every row: is this a
 * whole Claude Code session, or a Task agent living inside one? Operator
 * chats and project workers are both real `claude` processes with their own
 * run row — they say "session". A sub-agent shares its parent's process and
 * dies with it — it says "sub-agent". The badge is the answer; the colour
 * repeats it so the two are distinguishable without reading.
 */

const KIND_LABEL: Record<string, string> = {
  operator: "session",
  worker: "session",
  subagent: "sub-agent",
  cron: "cron",
  unknown: "unknown",
};

const KIND_COLOR: Record<string, string> = {
  operator: tokens.info,
  worker: tokens.info,
  subagent: tokens.textMuted2,
  cron: tokens.textMuted,
  /** An unclassified run is a fact about the fleet, not a rendering hole. */
  unknown: tokens.warn,
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? tokens.warn;
}

/** Aliases render fainter than resolved ids — the colour IS the statement that
 *  we know less about this row's model (R8, ported from AgentActivity). */
function modelColor(model: string | null): string {
  return isModelAlias(model) ? tokens.textGhost : tokens.textFaint;
}

/** First 8 chars of a uuid — enough to grep the database with, short enough to
 *  read inside a native tooltip. */
function short(id: string | null): string {
  return id ? id.slice(0, 8) : "none";
}

/**
 * The row's native `title` — full description plus lineage.
 *
 * Native, not a mounted tooltip component, and that is the whole point: NFU2
 * forbids anything on the hover path that mounts, measures or re-renders.
 * The browser draws this one for free.
 *
 * It carries the RAW model id rather than `modelDisplay`'s short form: the
 * badge column is where brevity belongs, the tooltip is the diagnostic
 * surface, and `claude-haiku-4-5-20251001` is what you paste into a query.
 */
function lineageTitle(row: TeamRow): string {
  const n = row.node;
  const parts: string[] = [n.description ?? "(no description)"];
  parts.push(
    n.kind === "subagent"
      ? "in-process sub-agent — a Task agent inside its parent's process, dies with it"
      : "full Claude Code session — its own process, survives session cycles",
  );
  parts.push(`status ${n.status}`);
  if (n.role) parts.push(`role ${n.role}`);
  parts.push(`model ${n.model ?? EM_DASH}`);
  parts.push(`id ${short(n.id)}`);
  if (row.parentDescription !== null || n.parent_id !== null) {
    parts.push(
      `child of "${row.parentDescription ?? "(no description)"}" (${short(n.parent_id)})`,
    );
  }
  if (n.task) {
    parts.push(`task round ${n.task.round} · ${n.task.role} · ${n.task.status}`);
  }
  return parts.join(" · ");
}

/** How `working_ms` was measured, as tooltip prose. The `~` prefix on a
 *  rollup value is the visible half (13 §9); this is the explanation. */
function workingSourceNote(node: TeamNode): string | null {
  if (node.working_ms === null) return "not measurable";
  if (node.working_ms_source === "rollup") {
    return (
      "approximate — rolled up from the spawn's wall-clock span, not summed " +
      "from this agent's own thread events"
    );
  }
  return null;
}

/* ── The two time leaves ──────────────────────────────────────────────────── */

interface TimeCellProps {
  /** Rendered verbatim through `fmtWorkingTime`; `null` renders "—". */
  ms: number | null;
  /** `~` for a rollup-sourced value, "" otherwise. */
  prefix: string;
  title: string;
}

/**
 * A settled row's time. Does not import `useTick`, does not subscribe to
 * anything, has no clock — it renders the number it was handed and re-renders
 * only when that number changes, which for a settled node is never (U16).
 */
function FrozenTime({ ms, prefix, title }: TimeCellProps) {
  return (
    <span
      data-working-cell
      data-frozen="true"
      className="mono"
      title={title}
      style={TIME_STYLE}
    >
      {prefix}
      {fmtWorkingTime(ms)}
    </span>
  );
}

/**
 * The server clock at response time (`responseNowMs(res)`), as a context
 * rather than a prop — round 1302, L1.
 *
 * It used to be a prop on every row, and it is a NEW NUMBER on every poll, so
 * it defeated `memo(TeamRowView)` on its own: round 1301 measured `responseNow`
 * differing on 432 of 432 compares, and `bailoutsIfRowWereTheOnlyProp` = 0 —
 * fixing wrapper identity alone would have changed nothing, because every row
 * still had a changed prop.
 *
 * A settled row has no business hearing about it at all: `interpolatedWorkingMs`
 * returns the frozen base and never reads `responseNow` when `node.settled`
 * (U16). So the value goes to the ONE component that actually interpolates.
 * React propagates a context change to consumers even through a memo bail-out,
 * which is exactly the routing wanted: the poll re-renders the live rows' time
 * spans and nothing else.
 *
 * Default `NaN` — the same "cannot interpolate" value the panel passes while
 * there is no response, which `interpolatedWorkingMs` already handles by
 * rendering the frozen base rather than a guess. A `LiveTime` mounted outside
 * a provider therefore shows an honest number, not a NaN.
 */
export const ResponseNowContext = createContext<number>(Number.NaN);

interface LiveTimeProps {
  /** The row, for `interpolatedWorkingMs` — the single place client-side time
   *  policy lives (teamRows.ts). The brief named this component's props
   *  `baseMs`/`responseNowMs`; passing the row instead is the one deviation,
   *  and it exists so that not a line of the clamp/settled/null policy is
   *  re-derived here. A leaf that re-implemented the policy is exactly the
   *  second source of truth round 501 built `interpolatedWorkingMs` to
   *  prevent. */
  row: TeamRow;
  prefix: string;
  title: string;
}

/**
 * A running row's time. The ONLY subscriber to the 1s tick in this panel, and
 * since round 1302 the only reader of `ResponseNowContext`: a tick or a poll
 * re-renders this `<span>`, not the row, not the controls, not the native
 * title (13 §6).
 */
function LiveTime({ row, prefix, title }: LiveTimeProps) {
  const nowMs = useTick();
  const responseNow = useContext(ResponseNowContext);
  return (
    <span
      data-working-cell
      data-frozen="false"
      className="mono"
      title={title}
      style={TIME_STYLE}
    >
      {prefix}
      {fmtWorkingTime(interpolatedWorkingMs(row, responseNow, nowMs))}
    </span>
  );
}

/* ── Layout constants ─────────────────────────────────────────────────────
 *
 * Fixed widths everywhere a value can change length between polls, so the
 * columns never wobble as numbers count up and no hover ever moves a pixel
 * (the layout-shift half of the NFU2 protocol).
 */

/** Depth → indent. Capped at 2: sub-agents do not nest (teamRows.ts). */
const DEPTH_PAD = [0, 12, 24];

const ROW_PAD_X = 8;
const KIND_COL = 52;
const ROLE_COL = 48;
const TOKENS_COL = 42;
const TIME_COL = 50;
/** Fixed at all times, occupied by the always-mounted controls. Reserving it
 *  is what makes the CSS reveal free of reflow. */
const CONTROLS_COL = 52;
/** Wide enough for "sure?", worn by the ✕ in BOTH states. The idle glyph is
 *  ~14px; letting the button size to its content is what made arming a layout
 *  change (round 505 finding #4). */
const X_COL = 32;

const TIME_STYLE: CSSProperties = {
  color: tokens.textSecondary,
  minWidth: TIME_COL,
  textAlign: "right",
  flex: "none",
  fontSize: 10.5,
  fontVariantNumeric: "tabular-nums",
};

const BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "0 3px",
  fontSize: 10,
  lineHeight: 1.6,
  borderRadius: 3,
  fontFamily: "inherit",
};

/** The ✕, idle and armed alike. Every box-affecting property is here and none
 *  of them is conditional: the transparent border reserves the armed border's
 *  1px on all four sides, `X_COL` + `border-box` reserves "sure?"'s width, and
 *  the armed style below may therefore change only `background` and
 *  `borderColor`. Measure this button in either state and you get the same
 *  rectangle — which is the whole of finding #4. */
const X_STYLE: CSSProperties = {
  ...BTN_STYLE,
  border: "1px solid transparent",
  padding: "0 2px",
  minWidth: X_COL,
  boxSizing: "border-box",
  textAlign: "center",
};

/* ── The row ─────────────────────────────────────────────────────────────── */

export interface TeamRowProps {
  row: TeamRow;
  /** Is THIS row's X currently armed? A boolean, so arming re-renders exactly
   *  two rows (the one losing it and the one gaining it) instead of the list. */
  armed: boolean;
  canStop: boolean;
  canTerminate: boolean;
  /** The team response reported `errors[].scope === "working_time"`: the
   *  numbers in the time column are not available, and the cell shows "—"
   *  rather than a zero that would read as measured (NFU6). */
  degradedTime: boolean;
  /** …`scope === "tasks"`: worker descriptions may be missing. */
  degradedTasks: boolean;
  /** Stable identities, hoisted with `useCallback` in the panel. A fresh arrow
   *  here would defeat `memo` and re-render every row on every panel render.
   *
   *  `settled` travels as an argument rather than being looked up by id in the
   *  panel: it keeps the handlers dependency-free (and therefore stable for
   *  the life of the panel) without a node map that would have to be kept in
   *  sync with the poll.
   *
   *  `onOpenNode` takes the whole node for the same reason — a sub-agent's
   *  `id` is a `tool_use_id`, so the frame ChatSurface pushes needs `kind` and
   *  `parent_id` too, and looking those back up by id would need exactly the
   *  node map this design avoids. */
  onOpenNode: (node: TeamNode) => void;
  onStop: (nodeId: string, settled: boolean) => void;
  onX: (nodeId: string, settled: boolean) => void;
}

function TeamRowViewImpl({
  row,
  armed,
  canStop,
  canTerminate,
  degradedTime,
  degradedTasks,
  onOpenNode,
  onStop,
  onX,
}: TeamRowProps) {
  const n = row.node;
  const settled = n.settled;
  /* Workers AND their sub-agents drill in (U20, phase 600). The manager row
   * stays inert: it IS the chat you are looking at, so "opening" it would
   * navigate to where you already are.
   *
   * Until this round only workers were clickable, because a sub-agent's id is
   * a `tool_use_id` and the callback carried a run id — there was nothing to
   * hand it. `onOpenNode` takes the NODE, so the caller reads `kind` and
   * `parent_id` off it and builds the right nav frame; a sub-agent resolves to
   * "its parent's run, sliced". `cron`/`unknown` rows stay inert: a row that
   * looks clickable and does nothing is worse than one that does not look
   * clickable. */
  const clickable = n.kind === "worker" || n.kind === "subagent";

  /* Why the ⏸ is dead, or null when it is not — derived from the SAME predicate
   * the click handler runs, so the two cannot disagree about a row (round 1353
   * review, finding 1: they did, and the result was an enabled button that sent
   * nothing). `stopBlockReason` is `decideStopClick` with the id dropped. */
  const stopBlock = stopBlockReason({ settled, canStop });

  const sourceNote = workingSourceNote(n);

  /* U15a / DoD #1, stated once and with no exception: every row shows its
   * working time. The only thing that suppresses the number is the server
   * telling us it could not measure it — never the row's status, never its
   * depth. What settling changes is which COMPONENT renders it, below. */
  const timeMs = degradedTime ? null : n.working_ms;
  /* The `~` marks an approximate NUMBER (13 §9). A cell with no number to
   * qualify — "—" — never wears it. */
  const prefix = timeMs !== null && n.working_ms_source === "rollup" ? "~" : "";
  const timeTitle = degradedTime
    ? "working time unavailable — the server reported an error for this enrichment step"
    : settled
      ? `frozen at settle: ${fmtWorkingTime(n.working_ms)} — this row finished, so ` +
        `the number is history and will not move again${sourceNote ? ` (${sourceNote})` : ""}`
      : `working time, still running${sourceNote ? ` (${sourceNote})` : ""}`;

  const description = n.description ?? (degradedTasks ? EM_DASH : "(no description)");

  return (
    <div
      className="team-row"
      data-team-row
      data-node-id={n.id}
      data-kind={n.kind}
      data-depth={Math.min(row.depth, DEPTH_PAD.length - 1)}
      data-settled={settled ? "true" : "false"}
      data-status={n.status}
      data-role={n.role ?? "-"}
      title={lineageTitle(row)}
      onClick={clickable ? () => onOpenNode(n) : undefined}
      style={{
        padding: `4px ${ROW_PAD_X}px`,
        paddingLeft: ROW_PAD_X + DEPTH_PAD[Math.min(row.depth, DEPTH_PAD.length - 1)],
        borderBottom: `1px solid ${tokens.borderDivider}`,
        cursor: clickable ? "pointer" : "default",
        fontSize: 11,
      }}
    >
      {/* line 1 — what this is: dot, kind, role, model … controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Filled dot = live, hollow = anything else — the same glyph grammar
            the Live panel uses, so the two surfaces read alike. */}
        <span
          style={{
            ...dot(statusColor(n.status), n.status === "running"),
            ...(settled
              ? { background: "transparent", border: `1px solid ${statusColor(n.status)}` }
              : {}),
          }}
        />
        <span
          className="mono"
          style={{
            color: kindColor(n.kind),
            minWidth: KIND_COL,
            flex: "none",
            whiteSpace: "nowrap",
            fontSize: 9.5,
            letterSpacing: "0.04em",
          }}
        >
          {kindLabel(n.kind)}
        </span>
        <span
          className="mono"
          style={{
            color: ROLE_COLOR[roleTokenName(n.role)],
            minWidth: ROLE_COL,
            flex: "none",
            whiteSpace: "nowrap",
            fontSize: 9.5,
          }}
        >
          {roleLabel(n.role)}
        </span>
        <span
          data-model-cell
          className="mono"
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
          {modelDisplay(n.model)}
        </span>

        {/* Always mounted, revealed by CSS only (.team-row rules in
            globals.css). Fixed width at all times so the reveal cannot move a
            pixel of the row. */}
        <span
          className="team-row-controls"
          style={{
            flex: "none",
            minWidth: CONTROLS_COL,
            display: "flex",
            justifyContent: "flex-end",
            gap: 2,
          }}
        >
          {/* Two independent reasons this button can be dead, and BOTH have to
              reach `disabled` — `canStop` alone is a capability answer, and a
              capability answer says nothing about whether THIS row still has a
              process to stop. While capabilities were all-false the two were
              indistinguishable; round 1353 flipped `stop` to true and the gap
              became a settled row wearing an enabled ⏸ that fired
              `decideStopClick` → `{blocked, "settled"}` → nothing. NFU6 forbids
              a silent no-op, so the settled case is disabled here and named in
              the title. `stopBlock` keeps the three-way choice in one
              place so the title, the colour and the cursor cannot drift apart. */}
          <button
            data-team-stop
            type="button"
            data-stop-blocked={stopBlock ?? "none"}
            disabled={stopBlock !== null}
            title={
              stopBlock === null
                ? "Stop this agent"
                : stopBlock === "settled"
                  ? SETTLED_STOP_TITLE
                  : capabilityTitle("stop")
            }
            onClick={(e) => {
              e.stopPropagation();
              onStop(n.id, settled);
            }}
            className="mono"
            style={{
              ...BTN_STYLE,
              color: stopBlock === null ? tokens.warn : tokens.textGhost,
              cursor: stopBlock === null ? "pointer" : "not-allowed",
            }}
          >
            ⏸
          </button>
          <button
            data-team-x
            data-confirm={armed ? "armed" : "idle"}
            type="button"
            /* Settled X is a local, reversible dismissal — always available.
               Running X is terminate, and terminate is capability-gated. */
            disabled={!settled && !canTerminate}
            title={
              settled
                ? "Hide this row — reversible from “N hidden · show” below"
                : canTerminate
                  ? "Terminate this agent — click again to confirm"
                  : capabilityTitle("terminate")
            }
            onKeyDown={(e) => {
              // A held Enter on a focused button delivers an activation per
              // autorepeat — round 505 got four terminates out of one key
              // press. `preventDefault` on the repeat keydown is what stops
              // the browser synthesising the click at all.
              if (isSpuriousActivation({ detail: 0, repeat: e.repeat })) {
                e.preventDefault();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              // The trailing half of a double-click (detail 2, 3, …) is the
              // browser telling us this was one gesture, not two decisions.
              // Keyboard activation reports detail 0 and passes through.
              if (isSpuriousActivation({ detail: e.detail, repeat: false })) return;
              onX(n.id, settled);
            }}
            className="mono"
            style={{
              ...X_STYLE,
              color: !settled && !canTerminate ? tokens.textGhost : tokens.bleed,
              cursor: !settled && !canTerminate ? "not-allowed" : "pointer",
              /* Colour only — every box property is already in X_STYLE. */
              ...(armed
                ? {
                    background: tokens.dangerActionBg,
                    borderColor: tokens.dangerActionBorder,
                  }
                : {}),
            }}
          >
            {armed ? "sure?" : "✕"}
          </button>
        </span>
      </div>

      {/* line 2 — what it is doing: description … tokens, working time */}
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
          {description}
        </span>
        <span
          data-tokens-cell
          className="mono"
          title={
            `${n.tokens.total.toLocaleString()} tokens total — ` +
            `in ${n.tokens.input.toLocaleString()}, out ${n.tokens.output.toLocaleString()}, ` +
            `cache read ${n.tokens.cache_read.toLocaleString()}, ` +
            `cache write ${n.tokens.cache_creation.toLocaleString()}`
          }
          style={{
            color: tokens.textFaint,
            minWidth: TOKENS_COL,
            textAlign: "right",
            flex: "none",
            fontSize: 10.5,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtTokens(n.tokens.total)}
        </span>
        {/* The structural half of U16: settled rows get a component that has
            no access to the clock at all. A running row whose working time the
            server could not measure takes the same component — a cell with no
            honest value must not be wired to a clock either, and "—" that
            ticks is a contradiction. */}
        {settled || degradedTime ? (
          <FrozenTime ms={timeMs} prefix={prefix} title={timeTitle} />
        ) : (
          <LiveTime row={row} prefix={prefix} title={timeTitle} />
        )}
      </div>

      {/* line 3 — what it LOOKED at, when it looked at anything (round 1350).
          Renders nothing at all for a run with no screenshots, which is most
          of them, so the row keeps its two-line shape.

          Opens on CLICK, never on hover: hover cost is a gate on this project
          (NFU2 / DoD #3) and this file's whole design is that a pointer moving
          across the list changes no state and mounts nothing. A sub-agent gets
          `null` — its node id is a `tool_use_id`, and its screenshots land in
          its parent's run directory because it inherits that process's
          FORGE_RUN_ID. */}
      <RunShotsIndicator runId={n.kind === "subagent" ? null : n.id} paddingLeft={13} />
    </div>
  );
}

/** Memoized on a shallow prop compare. Hover changes no prop — it is CSS — so
 *  a hover sweep across the list commits nothing (NFU2). A poll replaces
 *  `row` for the rows whose data actually moved, and only for those: since
 *  round 1302 `flattenTeam` reuses the previous wrapper when nothing about a
 *  row changed, and the per-poll clock left the props entirely for
 *  `ResponseNowContext`. Both were required — round 1301 measured 0 bail-outs
 *  in 432 compares with either one still in place. */
export const TeamRowView = memo(TeamRowViewImpl);
