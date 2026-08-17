"use client";

/**
 * Live agent activity — modelled on the Claude Code CLI's own task bar.
 *
 * Two concurrency systems, one dense monospace list:
 *
 *   System B — "workers" (kind: "run"). forge-control spawns a SEPARATE
 *   `claude` process per task, tracked in Postgres. These survive session
 *   cycles and are what the fleet actually is. Rendered as top-level rows.
 *
 *   System A — "threads" (kind: "subagent"). A single `claude` process spawns
 *   Task-tool agents (architect/planner/builder/…) INSIDE itself. They share
 *   the parent's process and die with it. Rendered nested under their parent
 *   with a filled/hollow dot: filled dot = running, hollow = done/queued.
 *
 * That distinction is not cosmetic — it explains why an in-process subagent
 * vanishes on a timeout while a fleet run keeps going.
 *
 * Row shape, deliberately imitating Claude Code's own task bar — two lines:
 * WHAT it is doing on top, WHAT IT IS underneath.
 *
 *   ● operator  Rework Live agent panel              36m 52s · ↓ 204.7k
 *       chat  fable-5  Bash
 *   ● worker    Phase 2b: kind badge + role           4m 12s · ↓ 88.1k
 *       builder  opus-5  Edit
 *     ○ ↳ sub   Recon chat Bash block rendering       1m 47s · ↓ 132.1k
 *         Explore  opus-5  Grep
 *
 *   kind badge in its role's colour · title primary truncated ·
 *   right-aligned live age + downloaded-token count; role/schedule, model,
 *   effort and current tool on the faint second line. One shared 1-second
 *   tick drives every visible row (the previous per-row setInterval scaled
 *   with row count and was flagged by the UI audit §2.2a as a re-render
 *   source). Lineage is a native `title` on each row container — no hover
 *   state anywhere in this directory, by design (R10).
 *
 * ── Dismissal (round 1350) ────────────────────────────────────────────────
 * A SETTLED top-level row carries a ✕ that hides it, server-side and globally
 * (`ui_dismissals`, shared with the chat team panel through
 * ../team/dismissals). A RUNNING row has none: hiding work that is still
 * happening is how a panel stops being a picture of the fleet, and terminate
 * is a different verb that lives behind a capability flag in the team panel.
 *
 * The reveal is CSS ONLY — `.live-row` in app/globals.css, the same rule
 * `.chat-row` and `.team-row` already use. The controls are mounted in every
 * row at all times, in a fixed-width slot, so a pointer crossing the list
 * changes no React state, commits nothing and lays out nothing (NFU2/R10 —
 * hover cost is a gate on this project). Any onMouseEnter in this file would
 * be the regression the round was written to avoid.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens, dot } from "../../tokens";
import { RunShotsIndicator } from "../chat/BrowserShots";
import {
  seededDismissals,
  useDismissals,
  useDismissalsLoaded,
} from "../team/dismissals";
/* The dismissal confirm machine, shared with the chat team panel rather than
 * re-implemented: one gesture, one set of rules, one set of words. See
 * ../team/confirm's header for why the guard is proportional to the blast
 * radius instead of attached to the verb. */
import {
  ARM_WINDOW_MS,
  confirmStripText,
  decideXClick,
  dismissTitle,
  hideToastText,
  isSpuriousActivation,
  needsConfirm,
  type ArmedState,
  type DismissScope,
} from "../team/confirm";
import { toast } from "../_ui/Toasts";
import { shortNodeId } from "../short-id";
import {
  DISMISSAL_SURFACES,
  DISMISSED_GROUP_LABEL,
  PEEK_OPACITY,
  RESTORE_ROW_TITLE,
  dismissedToggleLabel,
  dismissedToggleTitle,
} from "../team/peek";
import {
  agentKindOf,
  fetchAgents,
  isModelAlias,
  modelDisplay,
  roleLabel,
  roleTokenName,
  rowsHiddenBy,
  runElapsedMs,
  subagentElapsedMs,
  type AgentKind,
  type AgentRow,
  type AgentUsage,
  type CurrentActivity,
  type RoleTokenName,
  type SubagentRow,
} from "./agentsApi";

const STATUS_COLOR: Record<string, string> = {
  running: tokens.accent,
  queued: tokens.textMuted,
  paused: tokens.warn,
  stuck: tokens.stuck,
  completed: tokens.ok,
  failed: tokens.bleed,
  cancelled: tokens.textFaint,
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "queued",
  "stuck",
  "paused",
]);

/** 1h 04m / 12m 30s / 45s — Claude Code's own format, no clock glyph.
 *  Length-bounded so the right column never wobbles as it counts. */
function humanDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 204.7k / 1.2M / 987 — same rounding rules as the Claude Code bar. */
function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k < 10 ? k.toFixed(1) : k.toFixed(k < 100 ? 1 : 0)}k`;
  }
  const M = n / 1_000_000;
  return `${M < 10 ? M.toFixed(2) : M.toFixed(1)}M`;
}

/** "Downloaded" tokens = input + cache_read. That's what the CLI's own bar
 *  reports: the total context the model consumed on this turn, which is
 *  where the real magnitude lives (cache reads are ~10% the price of
 *  fresh input but often 90% of the count). */
function downloadedTokens(u: AgentUsage | undefined | null): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Best short label for what the agent is doing right now — tool name for a
 *  call, first slice of assistant text for a message, empty otherwise. */
function activityLabel(act: CurrentActivity | null): string {
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? "";
  if (act.kind === "tool_result") return "";
  if (act.text) return act.text.slice(0, 80);
  return "";
}

/* ── Kind grammar, rendering half ─────────────────────────────────────────
 *
 * agentsApi.ts decides WHAT a row is and which token NAME its role wears
 * (that module stays React-free and token-free so the check script can import
 * it). This is the only place a name becomes a colour.
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

function roleColor(role: string | null | undefined): string {
  return ROLE_COLOR[roleTokenName(role)];
}

/** The badge is the row's one-word answer to "what is this?".
 *  `unknown` wears `warn` deliberately — an unclassified run is a fact about
 *  the fleet, not a rendering hole to be smoothed over. */
function kindColor(kind: AgentKind, role: string | null | undefined): string {
  switch (kind) {
    case "operator":
      return tokens.accent;
    case "worker":
      return roleColor(role);
    case "cron":
      return tokens.textMuted;
    case "unknown":
      return tokens.warn;
  }
}

/** Second-line qualifier: which role, which schedule, or — for an
 *  unclassified row — the worker identity that failed to classify, because
 *  that is the one datum that explains why it says "unknown". */
function kindDetail(a: AgentRow, kind: AgentKind): string {
  switch (kind) {
    case "operator":
      return "chat";
    case "worker":
      return roleLabel(a.role);
    case "cron":
      return a.cron_name ?? "unnamed schedule";
    case "unknown":
      return a.worker ?? "no worker";
  }
}

function kindDetailColor(kind: AgentKind, role: string | null | undefined): string {
  return kind === "worker" ? roleColor(role) : tokens.textFaint;
}

/** Eight characters that identify the node — a uuid's first eight, or a
 *  sub-agent id's first eight AFTER the constant `toolu_01` prefix. Same rule
 *  as the team panel's rows and the chat's comms cards (../short-id). */
function short(id: string | null | undefined): string {
  return shortNodeId(id, "none");
}

/** Lineage, R10 — composed at render time into a NATIVE `title`. No hover
 *  state, no portal, no tooltip component: those are what phase 3 is cleaning
 *  up, and this panel must not add more of them.
 *
 *  Titles carry the RAW model id, not `modelDisplay`. The badge column is
 *  where brevity belongs; the tooltip is the diagnostic surface, and
 *  `claude-haiku-4-5-20251001` is what you paste into a query. */
function lineageTitle(a: AgentRow, kind: AgentKind): string {
  const model = a.model ?? "—";
  const run = short(a.id);
  switch (kind) {
    case "operator":
      return `operator chat (full Claude Code session) · model ${model} · run ${run}`;
    case "worker": {
      const base = `project worker · ${a.role ?? "no role"} · project ${short(
        a.project_id,
      )} · model ${model} · run ${run}`;
      return a.parent_run_id ? `${base} · child of ${short(a.parent_run_id)}` : base;
    }
    case "cron":
      return `cron ${a.cron_name ?? "unnamed"} · model ${model} · run ${run}`;
    case "unknown":
      return `unclassified run · worker ${a.worker ?? "none"} · run ${run}`;
  }
}

/** The line Konrad asked for: is this a whole Claude Code session, or a Task
 *  agent living inside one? Parent title and parent model arrive as primitive
 *  props so this stays a pure string function and the child never reads the
 *  parent row object. */
function subagentLineageTitle(
  s: SubagentRow,
  parentTitle: string,
  parentModel: string,
): string {
  return (
    `in-process sub-agent of "${parentTitle}" (${parentModel}) · ` +
    `role ${s.role} · model ${s.model ?? "—"} · started ${s.started_at}`
  );
}

function subagentActivityLabel(s: SubagentRow): string {
  const act = s.latest_activity;
  if (!act) return "";
  if (act.kind === "tool_call") return act.tool ?? "";
  if (act.kind === "tool_result") return "";
  if (act.text) return act.text.slice(0, 80);
  return "";
}

/** Single 1s tick shared across every visible row. This replaces the
 *  per-row useLiveTick / setInterval pair — with ~10 running rows plus
 *  subagents that was 20+ timers each firing setState every second.
 *
 *  This is the one legitimate `Date.now()` left in this file: it is the
 *  clock, not duration math. Every duration is derived in agentsApi.ts. */
function useSharedClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

interface RowProps {
  a: AgentRow;
  now: number;
  /** The ids hidden right now. Passed down so a sub-agent dismissed from the
   *  chat team panel — its node id is a `tool_use_id`, which never appears at
   *  top level here — does not reappear under its parent in this panel. */
  dismissed: ReadonlySet<string>;
  /** Hide this row. The server cascades; see `useDismissals`. `hidesRows` and
   *  `widerReach` are what the panel needs to decide whether the click has to be
   *  confirmed — they travel with it for the same reason the team panel's do:
   *  the handler upstairs has no per-row lookup and must not grow one. */
  onDismiss: (id: string, hidesRows: number, widerReach: boolean) => void;
  /** Is THIS row's ✕ armed? One boolean per row, off one panel-level id. */
  armed?: boolean;
  /** Un-hide it. Only ever called from the peek list below the fold. */
  onRestore: (id: string) => void;
  /** True when this row is being PEEKED: it IS dismissed, and the operator
   *  asked to see it anyway. Rendered muted, with restore in place of ✕. */
  peeked?: boolean;
}

/** Width of the kind column. Fixed so the titles line up down the list and
 *  nothing wobbles as rows change kind between polls; `minWidth` rather than
 *  `width` so a long cron name can spill rather than be clipped. */
const KIND_COL = 52;

/** The control slot at the end of line 1. Reserved on EVERY row — running
 *  rows included, which carry no button — so revealing the ✕ cannot move a
 *  pixel of the row and the token column stays aligned down the list. */
const CONTROLS_COL = 20;

const CONTROL_STYLE: CSSProperties = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  padding: "0 2px",
  minWidth: CONTROLS_COL,
  boxSizing: "border-box",
  textAlign: "center",
  fontSize: 10,
  lineHeight: 1.4,
  fontFamily: "inherit",
  cursor: "pointer",
};

/** Aliases render fainter than resolved ids — the colour IS the statement
 *  that we know less about this row's model (R8). */
function modelColor(model: string | null | undefined): string {
  return isModelAlias(model) ? tokens.textGhost : tokens.textFaint;
}

function AgentRunLine({
  a,
  now,
  dismissed,
  onDismiss,
  onRestore,
  peeked = false,
  armed = false,
}: RowProps) {
  const live = a.status === "running";
  const elapsed = runElapsedMs(a, now);

  // Live usage during the current turn is more useful than the aggregated
  // total, which resets on session restart and lags by a full assistant
  // message. Fall back to total when we're not mid-turn.
  const usage = live && a.usage_running ? a.usage_running : a.usage_total;
  const tokensIn = downloadedTokens(usage);
  const label = activityLabel(a.current_activity);
  const statusColor = STATUS_COLOR[a.status] ?? tokens.textFaint;
  const kind = agentKindOf(a);
  const lineage = lineageTitle(a, kind);
  const model = modelDisplay(a.model);

  /* ── What this row's ✕ would cost (round 1873, finding 2) ────────────────
   *
   * The gesture is the same server call the team panel makes, and it cascades
   * the same way — one click on an operator row hid 165 of 166 rows there. This
   * panel can count its own sub-agent lines exactly; it CANNOT count the
   * finished workers of a project this chat started, because `/api/agents` says
   * which project a worker belongs to but never which chat began it. So an
   * operator row declares `widerReach` and the words say "and any project this
   * chat started" instead of naming a number this feed cannot know. */
  const hidesRows =
    1 + (a.subagents ?? []).filter((sub) => !dismissed.has(sub.tool_use_id)).length;
  const scope: DismissScope = {
    settled: a.settled,
    hidesRows,
    widerReach: kind === "operator",
  };
  const confirms = needsConfirm(scope);

  return (
    // Lineage lives on the row container (operator-visibility/02-architecture
    // §4.3): every part of
    // the row that does not state something more specific — the dot, the
    // badge, the second line, the padding — answers "what is this and whose
    // child is it?" on hover, with zero JS.
    <div
      className="live-row"
      title={lineage}
      data-agent-kind={kind}
      data-live-peeked={peeked ? "true" : undefined}
      style={peeked ? { opacity: PEEK_OPACITY } : undefined}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "3px 8px",
          fontSize: 11,
        }}
      >
        {/* Filled dot = live/running, hollow = anything else — this is the
            one glyph difference from the Claude Code bar. */}
        <span
          style={{
            ...dot(statusColor, live),
            alignSelf: "center",
            ...(live ? {} : { background: "transparent", border: `1px solid ${statusColor}` }),
          }}
        />
        {/* Kind badge. This slot used to hold the raw model id, which said
            nothing about what the row WAS — the model moved to the second
            line, where it now sits next to the role it ran. */}
        <span
          className="mono"
          style={{
            color: kindColor(kind, a.role),
            flex: "none",
            minWidth: KIND_COL,
            whiteSpace: "nowrap",
            fontSize: 9.5,
            letterSpacing: "0.04em",
          }}
        >
          {kind}
        </span>
        <span
          className="mono"
          style={{
            color: tokens.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={a.title}
        >
          {a.title}
        </span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title={live ? "running for this long" : "total run time"}
        >
          {humanDuration(elapsed)}
        </span>
        <span style={{ color: tokens.textGhost, flex: "none" }}>·</span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title="downloaded tokens (input + cache read)"
        >
          ↓ {humanTokens(tokensIn)}
        </span>
        {/* Always mounted, fixed width, revealed by the `.live-row` rules in
            globals.css — never by React state (see the file header). A peeked
            row's restore control is NOT hover-gated: it is already an
            explicitly-summoned list, and a control you have to find by
            hovering inside it would be a puzzle, not an affordance. */}
        <span
          className={peeked ? undefined : "live-row-controls"}
          style={{
            flex: "none",
            minWidth: CONTROLS_COL,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          {peeked ? (
            <button
              data-live-restore={a.id}
              type="button"
              title={RESTORE_ROW_TITLE}
              onClick={() => onRestore(a.id)}
              className="mono"
              style={{ ...CONTROL_STYLE, color: tokens.textMuted }}
            >
              ↺
            </button>
          ) : (
            /* Settled only. A running row has no ✕ at all — not a disabled
               one: there is no verb behind it here, and a control that exists
               to refuse is noise in a list you read at a glance. */
            a.settled && (
              <button
                data-live-x={a.id}
                data-confirm={armed ? "armed" : "idle"}
                data-x-hides={hidesRows}
                data-x-confirms={confirms}
                type="button"
                title={dismissTitle(scope)}
                onClick={(e) => {
                  // Same two drops the team panel makes before the machine sees
                  // the click: the trailing half of a double-click is one
                  // gesture, not two decisions.
                  if (isSpuriousActivation({ detail: e.detail, repeat: false })) return;
                  onDismiss(a.id, hidesRows, scope.widerReach === true);
                }}
                onKeyDown={(e) => {
                  if (isSpuriousActivation({ detail: 0, repeat: e.repeat })) {
                    e.preventDefault();
                  }
                }}
                className="mono"
                style={{
                  ...CONTROL_STYLE,
                  color: tokens.bleed,
                  ...(armed
                    ? {
                        background: tokens.dangerActionBg,
                        borderColor: tokens.dangerActionBorder,
                      }
                    : {}),
                }}
              >
                {/* Two characters, not "hide?": `CONTROLS_COL` is 20px and the
                    whole point of a reserved slot is that arming moves nothing.
                    The sentence lives in the strip below. */}
                {armed ? "✕?" : "✕"}
              </button>
            )
          )}
        </span>
      </div>

      {/* Second line, now unconditional: role/schedule and model are facts
          about every row, not extras. It used to appear only when there was
          effort or activity to report, which is exactly when a quiet
          row is hardest to identify. */}
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: "0 8px 4px 24px",
        }}
      >
        <span
          style={{
            color: kindDetailColor(kind, a.role),
            flex: "none",
            whiteSpace: "nowrap",
          }}
        >
          {kindDetail(a, kind)}
        </span>
        <span style={{ color: modelColor(a.model), flex: "none", whiteSpace: "nowrap" }}>
          {model}
        </span>
        {a.effort && <span>{a.effort}</span>}
        {label && (
          <span
            style={{
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={label}
          >
            {label}
          </span>
        )}
      </div>

      {/* The armed confirm, and only while armed. Same words the team panel
          uses (./team/confirm), because it is the same gesture with the same
          blast radius — a customer who learns it on one panel has learned it on
          both. */}
      {armed && (
        <div
          data-live-confirm-strip
          className="mono"
          style={{
            padding: "0 8px 4px 24px",
            fontSize: 9.5,
            lineHeight: 1.5,
            color: tokens.bleed,
          }}
        >
          {confirmStripText(scope)}
        </div>
      )}

      {/* What this run LOOKED at (round 1350). Absent — not empty, absent —
          for a run that photographed nothing. Click, never hover: this panel
          is the one whose hover cost is measured (R10 / DoD #3), and the
          indicator subscribes to the one shared `["uploads-index"]` query
          rather than fetching per row. */}
      <RunShotsIndicator runId={a.id} paddingLeft={24} />

      {/* A sub-agent hidden from the team panel stays hidden here: one set,
          one truth, both surfaces. Its own row carries no ✕ — dismissal in
          this panel is a top-level gesture, and a sub-agent goes with the
          run it lives inside. */}
      {a.subagents
        ?.filter((s) => !dismissed.has(s.tool_use_id))
        .map((s) => (
          <SubagentLine
            key={s.tool_use_id}
            s={s}
            now={now}
            parentTitle={a.title}
            parentModel={model}
          />
        ))}
    </div>
  );
}

function SubagentLine({
  s,
  now,
  parentTitle,
  parentModel,
}: {
  s: SubagentRow;
  now: number;
  /** Primitives, not the parent row: the lineage string is built here but the
   *  child must not be able to read — or re-render on — the parent object. */
  parentTitle: string;
  parentModel: string;
}) {
  const live = s.status === "running";
  const elapsed = subagentElapsedMs(s, now);
  const statusColor = live ? tokens.accent : tokens.ok;
  const tokensIn = downloadedTokens(s.usage);
  const label = subagentActivityLabel(s);
  const titleColor = live ? tokens.textHi : tokens.text;
  // What the sub-agent was SENT to do beats what it happens to be touching
  // this second: "Recon chat Bash block rendering" identifies a sub-agent,
  // "Bash" does not. Activity keeps the title attribute and the second line.
  const rowTitle = s.description || label || s.role;

  return (
    <div
      title={subagentLineageTitle(s, parentTitle, parentModel)}
      data-agent-kind="subagent"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "2px 8px 2px 20px",
          fontSize: 11,
        }}
      >
        <span
          style={{
            ...dot(statusColor, live),
            alignSelf: "center",
            ...(live ? {} : { background: "transparent", border: `1px solid ${statusColor}` }),
          }}
        />
        {/* Sits in the same column as the top-level kind badge and says the
            opposite thing: this row is NOT its own Claude Code session, it is
            a Task agent inside the process one line above.

            `textMuted2`, not the `textGhost` the plan suggested: in the light
            palette ghost sits around 2.5:1 against the card, which made the
            one marker that answers Konrad's actual question the faintest
            thing in the row. Muted2 is still visibly subordinate to the
            description beside it — see docs/plan/artifacts/phase2/README.md. */}
        <span
          className="mono"
          style={{
            color: tokens.textMuted2,
            flex: "none",
            minWidth: KIND_COL - 12,
            whiteSpace: "nowrap",
            fontSize: 9.5,
            letterSpacing: "0.04em",
          }}
        >
          ↳ sub
        </span>
        <span
          className="mono"
          style={{
            color: titleColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={label || undefined}
        >
          {rowTitle}
        </span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title={live ? "running for this long" : "total subagent run time"}
        >
          {humanDuration(elapsed)}
        </span>
        <span style={{ color: tokens.textGhost, flex: "none" }}>·</span>
        <span
          className="mono"
          style={{ color: tokens.textFaint, flex: "none" }}
          title="downloaded tokens (input + cache read)"
        >
          ↓ {humanTokens(tokensIn)}
        </span>
      </div>

      <div
        className="mono"
        style={{
          display: "flex",
          gap: 10,
          fontSize: 9.5,
          color: tokens.textFaint,
          padding: "0 8px 3px 36px",
        }}
      >
        <span
          style={{ color: roleColor(s.role), flex: "none", whiteSpace: "nowrap" }}
        >
          {roleLabel(s.role)}
        </span>
        <span style={{ color: modelColor(s.model), flex: "none", whiteSpace: "nowrap" }}>
          {modelDisplay(s.model)}
        </span>
        {label && (
          <span
            style={{
              color: tokens.textMuted2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
            title={label}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentActivity({
  projectId,
  groupName,
}: {
  projectId?: string;
  groupName?: string;
} = {}) {
  const q = useQuery({
    queryKey: ["agents", "activity", projectId ?? null],
    queryFn: () => fetchAgents(projectId),
    refetchInterval: 4_000,
  });

  const agents = useMemo(() => q.data?.agents ?? [], [q.data]);
  const s = q.data?.summary;

  /* Dismissals, shared with the chat team panel (../team/dismissals). The
   * `null` is the hook's vestigial chat id — the set is global. */
  const { dismissed, dismiss, restore, restoreMany } = useDismissals(null);

  /* ── The ✕ is guarded here too (round 1873, finding 2) ───────────────────
   *
   * The tester found it on the team panel; the defect is this panel's as well,
   * because both call one cascading endpoint. The machine is ./team/confirm's,
   * unchanged and unforked: `needsConfirm` decides whether a click arms or
   * fires, `decideXClick` runs the same two-click window, and the row shows the
   * same sentence. What is NOT shared is the state — one armed id per panel,
   * so arming here does not arm a row in a chat's team tree. */
  const [armedId, setArmedId] = useState<string | null>(null);
  const armedRef = useRef<ArmedState | null>(null);

  /* What the dismiss toast counts against: the rows this panel was showing when
   * the ✕ was pressed. Written in an effect below (never during render), and
   * seeded empty so the count is 0 — "nothing left this panel" — rather than a
   * crash, for the impossible click that arrives before the first response. */
  const rowsRef = useRef<{
    agents: readonly AgentRow[];
    hiddenBy: ReadonlySet<string>;
  }>({ agents: [], hiddenBy: new Set<string>() });

  useEffect(() => {
    if (armedId === null) return;
    const t = setTimeout(() => {
      armedRef.current = null;
      setArmedId(null);
    }, ARM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [armedId]);

  /* Changing your mind — round 1874, finding 3, and the team panel's identical
   * effect (../team/ChatTeamPanel.tsx) with this panel's own ✕ selector. Escape,
   * or a pointer landing anywhere that is not a ✕; both listeners exist only
   * while something is armed, so an idle panel adds no document handlers to the
   * surface whose hover cost is this project's DoD 3. */
  useEffect(() => {
    if (armedId === null) return;
    const disarm = () => {
      armedRef.current = null;
      setArmedId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") disarm();
    };
    const onPointer = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-live-x]")) return;
      disarm();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [armedId]);

  const handleDismiss = useCallback(
    (id: string, hidesRows: number, widerReach: boolean) => {
      const nowMs = Date.now();
      const decision = decideXClick({
        nodeId: id,
        // Only settled rows carry a ✕ in this panel at all (see the button), so
        // this is a statement of that fact rather than a branch: the terminate
        // path of `decideXClick` is unreachable from here.
        settled: true,
        hidesRows: widerReach ? Number.MAX_SAFE_INTEGER : hidesRows,
        armed: armedRef.current,
        nowMs,
        canTerminate: false,
      });
      switch (decision.action) {
        case "arm":
        case "rearm":
          armedRef.current = { id: decision.id, at: nowMs };
          setArmedId(decision.id);
          return;
        case "dismiss":
          armedRef.current = null;
          setArmedId(null);
          /* The cascade is fleet-wide; the "N dismissed · show" tray beside
           * this toast counts only what THIS feed withheld. Round 1874's
           * finding 2 was those two numbers side by side with nothing to
           * reconcile them, so the toast now states both — `rowsHiddenBy`
           * counts rows exactly the way `hiddenRowCount` does.
           *
           * Snapshotted at the CLICK, for the reason written out in the team
           * panel: the dismissal is applied optimistically, so a ref read
           * inside the callback describes the panel AFTER the row left. */
          const before = rowsRef.current;
          dismiss(decision.id, (ids) => {
            const here = rowsHiddenBy(before.agents, before.hiddenBy, ids);
            toast(
              hideToastText({ hidden: ids.length, here }),
              "info",
              undefined,
              {
                action: { label: "undo", onClick: () => restoreMany(ids) },
                ttlMs: 12_000,
              },
            );
          });
          return;
        case "blocked":
        case "terminate":
          // Unreachable: `canTerminate` is false and `settled` is true, so the
          // machine cannot return either. Named rather than defaulted, so a
          // future edit to the machine breaks the compile instead of the panel.
          return;
      }
    },
    [dismiss, restoreMany],
  );
  const dismissalsLoaded = useDismissalsLoaded();
  const payloadDismissed = useMemo(
    () =>
      agents.filter((a) => a.dismissed_at != null).map((a) => a.id),
    [agents],
  );
  /* Same rule as the team panel: seed from the payload's own `dismissed_at`
   * until the GET answers, then let the server set be the only authority so a
   * restore is not re-hidden by a response that is up to 4s stale. */
  const hiddenBy = useMemo(
    () => seededDismissals(dismissalsLoaded, dismissed, payloadDismissed),
    [dismissalsLoaded, dismissed, payloadDismissed],
  );

  useEffect(() => {
    rowsRef.current = { agents, hiddenBy };
  }, [agents, hiddenBy]);

  const [peek, setPeek] = useState(false);

  // Memoised partition — the audit flagged these as unmemoised filter+Set()
  // allocations that fired on every one-second useLiveTick tick.
  const { active, recent, hidden, hiddenRowCount } = useMemo(() => {
    const active: AgentRow[] = [];
    const recent: AgentRow[] = [];
    const hidden: AgentRow[] = [];
    /* ROWS withheld, not ids hidden — the same distinction the team panel's
     * `hiddenCount` makes. A dismissed run takes its sub-agent lines with it,
     * and an id belonging to a run outside this feed withholds nothing here
     * and must not be counted. */
    let hiddenRowCount = 0;
    for (const a of agents) {
      if (hiddenBy.has(a.id)) {
        hidden.push(a);
        hiddenRowCount += 1 + (a.subagents?.length ?? 0);
        continue;
      }
      if (ACTIVE_STATUSES.has(a.status)) active.push(a);
      else recent.push(a);
      for (const sub of a.subagents ?? []) {
        if (hiddenBy.has(sub.tool_use_id)) hiddenRowCount += 1;
      }
    }
    return { active, recent, hidden, hiddenRowCount };
  }, [agents, hiddenBy]);

  // Only tick the clock when SOMETHING can be counting up. Kills the timer
  // entirely when the panel is idle (empty state / all recent).
  const anyRunning = useMemo(() => {
    if (active.some((a) => a.status === "running")) return true;
    for (const a of active) {
      if (a.subagents?.some((sa) => sa.status === "running")) return true;
    }
    return false;
  }, [active]);
  const now = useSharedClock(anyRunning);

  return (
    <>
      <div
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          fontSize: 10,
          color: tokens.textFaint,
          flexWrap: "wrap",
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        {groupName && (
          <span
            style={{
              color: tokens.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 120,
            }}
            title={groupName}
          >
            {groupName}
          </span>
        )}
        <span style={{ color: s?.running ? tokens.accent : tokens.textFaint }}>
          {s?.running ?? 0} running
        </span>
        {!!s?.active_subagents && <span>{s.active_subagents} subagents</span>}
        {!!s?.queued && <span>{s.queued} queued</span>}
        {!!s?.stuck && (
          <span style={{ color: tokens.stuck }}>{s.stuck} stuck</span>
        )}
        {/* The way back. Counted in ROWS this panel is actually withholding,
            so it can neither claim rows that are not in this feed nor
            undercount a dismissed run's sub-agent lines. Peeking is local
            state on the PANEL — one toggle, not a per-row flag — so it costs
            one render of the list and nothing on hover. */}
        {hiddenRowCount > 0 && (
          <button
            data-live-dismissed-toggle
            type="button"
            onClick={() => setPeek((v) => !v)}
            /* The OTHER surface: this IS the Live panel, so the sentence that
               tells the operator where else his dismissals apply has to name
               the chat team panel. */
            title={dismissedToggleTitle(DISMISSAL_SURFACES.team)}
            className="mono"
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              fontSize: 10,
              fontFamily: "inherit",
              color: tokens.textMuted,
              cursor: "pointer",
            }}
          >
            {dismissedToggleLabel(hiddenRowCount, peek)}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {!!(s?.tokens_out_last_hour || s?.tokens_in_last_hour) && (
          <span title="tokens generated / read in the last hour">
            ↑ {humanTokens(s.tokens_out_last_hour)} ↓{" "}
            {humanTokens(s.tokens_in_last_hour)} /h
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 8px" }}>
        {q.isLoading && (
          <div
            className="mono"
            style={{ padding: 16, fontSize: 10.5, color: tokens.textFaint }}
          >
            loading agents…
          </div>
        )}
        {q.isError && (
          <div
            className="mono"
            style={{ padding: 16, fontSize: 10.5, color: tokens.bleed }}
          >
            {(q.error as Error).message}
          </div>
        )}
        {!q.isLoading && !q.isError && !agents.length && (
          <div
            className="mono"
            style={{
              padding: "24px 8px",
              fontSize: 10.5,
              color: tokens.textFaint,
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            {projectId
              ? "No active project group"
              : "no agent activity in the last 24h"}
          </div>
        )}

        {active.map((a) => (
          <AgentRunLine
            key={a.id}
            a={a}
            now={now}
            dismissed={hiddenBy}
            onDismiss={handleDismiss}
            onRestore={restore}
            armed={armedId === a.id}
          />
        ))}

        {!!recent.length && (
          <>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textGhost,
                letterSpacing: "0.08em",
                padding: "10px 8px 4px",
              }}
            >
              RECENT
            </div>
            {recent.slice(0, 12).map((a) => (
              <AgentRunLine
                key={a.id}
                a={a}
                now={now}
                dismissed={hiddenBy}
                onDismiss={handleDismiss}
                onRestore={restore}
                armed={armedId === a.id}
              />
            ))}
          </>
        )}

        {/* Peeked rows sit BELOW everything, behind their own heading and
            visibly quieter: they are hidden, and the panel says so rather
            than mixing them back into the live list. Each carries its own
            restore — the way back is per row, because the way out was. */}
        {peek && !!hidden.length && (
          <>
            <div
              className="mono"
              style={{
                fontSize: 9,
                color: tokens.textGhost,
                letterSpacing: "0.08em",
                padding: "10px 8px 4px",
              }}
            >
              {DISMISSED_GROUP_LABEL}
            </div>
            {hidden.map((a) => (
              <AgentRunLine
                key={a.id}
                a={a}
                now={now}
                dismissed={hiddenBy}
                onDismiss={handleDismiss}
                onRestore={restore}
                peeked
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

export default AgentActivity;
